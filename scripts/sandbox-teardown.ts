#!/usr/bin/env bun
/**
 * CLI: sandbox-teardown — the operator-facing surface of harvest + teardown (DF2.5).
 *
 * Usage:
 *   sandbox-teardown <run-id> [--no-harvest] [--driver <name>] [--dir <path>]
 *   sandbox-teardown harvest <run-id> [--driver <name>] [--dir <path>]
 *
 * The default mode runs the full ordered teardown (spend → artifacts →
 * harvest → revoke → verify → destroy → close); `harvest <run-id>` runs
 * harvestRun only and leaves the record open — closure is teardown's last
 * step. `--driver` defaults to $QDS_PROVIDER_DRIVER or "fake"; `--dir` (or
 * $QDS_RUNS_DIR) selects the records directory; the host git repo is the cwd.
 *
 * The provider key API is built lazily, only in teardown mode and only when
 * the record carries a keyHash (harvest mode is credential-free, D8) —
 * keyless runs work offline, and a keyed run without
 * $OPENROUTER_PROVISIONING_KEY fails before anything is mutated. One
 * invocation per run at a time: `<runsDir>/<runId>.lock` serializes concurrent
 * CLI calls; a stale lock is reported (never stolen) with the holder's pid and
 * the exact `rm` that clears it. Errors print
 * `!! <code>: <message>` plus `next: <remediation>` and exit 1; remediation
 * references env-var NAMES only and key material is never printed.
 */

import { closeSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

import {
  RunRecordStore,
  getRecord,
  harvestRun,
  openRouterKeyApi,
  resolveDriver,
  teardownSandbox,
  type HarvestError,
  type RunRecord,
  type TeardownDeps,
} from "../src/providers/index.ts";
import { newRequestId, setLogSink } from "../src/swarmclaw/log.ts";
import { parseValueFlags, tokenizeArgs } from "./lib/cli-args.ts";

// Structured logs go to stderr so stdout carries only the command's output.
if (import.meta.main) {
  setLogSink((entry) => {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  });
}

const HELP = [
  "Usage: sandbox-teardown [harvest] <run-id> [--no-harvest] [--driver <name>] [--dir <path>]",
  "",
  "  <run-id>                full ordered teardown: spend → artifacts → harvest →",
  "                         revoke → verify → destroy → close",
  "  harvest <run-id>        harvest + artifacts only; the record stays open",
  "",
  "  --no-harvest            waive the harvest gate (AC3) only — logged to the run",
  "                         log, never written to the record",
  "  --driver <name>         provider driver (default $QDS_PROVIDER_DRIVER or fake)",
  "  --dir <path>            records directory (default $QDS_RUNS_DIR)",
  "",
];

const VALUE_FLAGS = ["--driver", "--dir"] as const;
const BOOL_FLAGS = ["--no-harvest"] as const;

export interface ParsedArgs {
  mode: "harvest" | "teardown";
  runId?: string;
  noHarvest: boolean;
  driver?: string;
  dir?: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  // Shared tokenizer: a value flag consumes the next token only when it is not
  // itself a flag, so `--driver --no-harvest` still recognizes --no-harvest and
  // parseValueFlags reports the missing --driver value. Stray single-dash
  // tokens throw here — this CLI is destructive, so a dropped `-n` typo must
  // not become a surprise teardown.
  const { positionals, flagTokens, bools } = tokenizeArgs(argv, {
    valueFlags: VALUE_FLAGS,
    boolFlags: BOOL_FLAGS,
    rejectStraySingleDash: true,
  });
  const isHarvest = positionals[0] === "harvest";
  const out: ParsedArgs = {
    mode: isHarvest ? "harvest" : "teardown",
    runId: isHarvest ? positionals[1] : positionals[0],
    noHarvest: bools.has("--no-harvest"),
  };
  parseValueFlags(flagTokens, {
    flags: VALUE_FLAGS,
    onValue: (flag, value) => {
      if (flag === "--driver") out.driver = value;
      else out.dir = value;
    },
    help: HELP,
  });
  // Extra positionals are a mistyped invocation, not a default: `run-a run-b`
  // tearing down run-a and exiting 0 would report success while run-b still
  // spends. `harvest` itself consumes one positional. Checked AFTER the flag
  // grammar so an unknown flag is reported as itself (an unknown `--` flag's
  // value lands as a positional, which would otherwise mask it).
  const arity = isHarvest ? 2 : 1;
  if (positionals.length > arity) {
    throw new Error(`unexpected argument: ${positionals[positionals.length - 1]}\n${HELP.join("\n")}`);
  }
  return out;
}

function fail(out: (s: string) => void, code: string, message: string, remediation?: string): void {
  out(`!! ${code}: ${message}\n`);
  if (remediation !== undefined) out(`next: ${remediation}\n`);
}

/**
 * `<runId>.lock` is already held by another invocation. Carries the
 * code/remediation shape `run()`'s catch already maps onto `!! <code>` +
 * `next:` — thrown between the record read and any mutation, so a refused
 * invocation touches nothing.
 */
class RunLockedError extends Error {
  readonly code = "run-locked";
  readonly remediation: string;
  constructor(lockPath: string, who: string) {
    super(`another sandbox-teardown holds ${lockPath} (${who})`);
    this.remediation = `wait for that invocation to finish — or, only if ${who} is gone: rm ${lockPath}`;
  }
}

/**
 * Claim `<runsDir>/<runId>.lock` (O_EXCL) for the duration of one invocation,
 * writing `<pid> <createdAt-ISO>` so a refused invocation can name the holder.
 *
 * Two concurrent `sandbox-teardown <run-id>` invocations both pass the closedAt
 * gate inside harvest/teardown (a check-then-act) and then double-revoke,
 * double-destroy and interleave writes to the fixed `<runId>.bundle` /
 * `<runId>-artifacts` paths. Unlike the store's per-write lock, this one never
 * steals: a stale lock means an uncertain teardown state, which is exactly the
 * moment an operator — not a heuristic — should decide.
 *
 * ponytail: library callers bypass the lock — the CLI is the operator surface.
 */
export function acquireRunLock(runsDir: string, runId: string): string {
  const lock = join(runsDir, `${runId}.lock`);
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(lock, "wx", 0o600);
    created = true;
    writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
    closeSync(fd);
    fd = undefined;
    return lock;
  } catch (e) {
    // A failure AFTER our own O_EXCL create (ENOSPC/EIO on the write, a failed
    // close) must not wedge the lock on disk for every later invocation: close
    // the fd and remove exactly the file THIS invocation created, then rethrow
    // the original error. EEXIST never arrives with created=true — the other
    // holder's lock stays untouched.
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // the close itself failed; nothing further to release
      }
    }
    if (created) rmSync(lock, { force: true });
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    let held = "";
    try {
      held = readFileSync(lock, "utf8").trim();
    } catch {
      // present but unreadable — fail closed below with what we do know
    }
    const [pid, iso] = held.split(/\s+/);
    const at = Date.parse(iso ?? "");
    const who =
      /^\d+$/.test(pid ?? "") && !Number.isNaN(at)
        ? `pid ${pid}, held ${Math.max(0, Math.round((Date.now() - at) / 1000))}s`
        : `holder unknown, lock body ${JSON.stringify(held)}`;
    throw new RunLockedError(lock, who);
  }
}

export async function run(argv: readonly string[], out: (s: string) => void): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.runId === undefined) {
    throw new Error(`missing <run-id>\n${HELP.join("\n")}`);
  }
  if (parsed.mode === "harvest" && parsed.noHarvest) {
    throw new Error(`harvest mode has no harvest gate to waive: --no-harvest is a teardown flag\n${HELP.join("\n")}`);
  }
  const requestId = newRequestId();
  const driver = resolveDriver(parsed.driver ?? process.env.QDS_PROVIDER_DRIVER ?? "fake", {
    requestId,
    runId: parsed.runId,
  });
  const store = new RunRecordStore({ ...(parsed.dir === undefined ? {} : { dir: parsed.dir }), requestId });

  let rec: RunRecord;
  try {
    // Shared classifier (harvest.ts getRecord — the same one harvestRun and
    // teardownSteps use): genuine ENOENT absence → no-record + create-the-run
    // guidance; every other read failure → record-read-failed + inspect-first
    // guidance, because a corrupt record can still have a live box and a live
    // key behind it.
    rec = getRecord({ store }, parsed.runId);
  } catch (e) {
    const err = e as HarvestError;
    fail(out, err.code ?? "record-read-failed", err.message ?? String(e), err.remediation);
    return 1;
  }

  const deps: TeardownDeps = {
    driver,
    store,
    requestId,
    gitCwd: process.cwd(),
    ...(parsed.dir === undefined ? {} : { runsDir: parsed.dir }),
  };
  let lock: string | undefined;
  try {
    lock = acquireRunLock(store.dir, parsed.runId);
    if (parsed.mode === "harvest") {
      // D8: harvest is credential-free — no keyApi is built, so a missing
      // $OPENROUTER_PROVISIONING_KEY cannot block it.
      const res = await harvestRun(deps, parsed.runId);
      out(res.outcome === "harvested" ? `harvested: ${res.count}\n` : "harvested: none\n");
      return 0;
    }
    // Keyed records need the key API (spend/revoke/verify); keyless runs work
    // offline. openRouterKeyApi throws its own provisioning-key-missing
    // remediation before anything is mutated.
    if (rec.keyHash !== undefined) deps.keyApi = openRouterKeyApi();
    // The waiver goes to the run log + stdout, never the record (INV-5).
    if (parsed.noHarvest) out(`teardown.harvest_waived ${parsed.runId}\n`);
    await teardownSandbox(deps, parsed.runId, { noHarvest: parsed.noHarvest });
    out(`torn down: ${parsed.runId}\n`);
    return 0;
  } catch (e) {
    // Non-Error rejections normalize to {} so the printer cannot itself throw
    // while reporting one.
    const err = (e ?? {}) as { code?: string; remediation?: string; message?: string };
    fail(out, err.code ?? "error", err.message ?? String(e), err.remediation);
    return 1;
  } finally {
    // Release only OUR lock: a refused invocation (EEXIST) must never unlink
    // the holder's lock file.
    if (lock !== undefined) rmSync(lock, { force: true });
  }
}

if (import.meta.main) {
  try {
    // writeSync, not process.stdout.write: piped stdout can still be pending
    // when process.exit tears the process down and the diagnostics are lost —
    // the same reasoning as exitWithFailure in scripts/lib/cli-args.ts.
    process.exit(await run(process.argv.slice(2), (s) => writeSync(1, s)));
  } catch (e) {
    writeSync(2, `${(e as Error).message}\n`);
    process.exit(1);
  }
}
