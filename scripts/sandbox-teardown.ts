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
 * $OPENROUTER_PROVISIONING_KEY fails before anything is mutated. Errors print
 * `!! <code>: <message>` plus `next: <remediation>` and exit 1; remediation
 * references env-var NAMES only and key material is never printed.
 */

import {
  RunRecordStore,
  harvestRun,
  openRouterKeyApi,
  resolveDriver,
  teardownSandbox,
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
  // parseValueFlags reports the missing --driver value.
  const { positionals, flagTokens, bools } = tokenizeArgs(argv, { valueFlags: VALUE_FLAGS, boolFlags: BOOL_FLAGS });
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
  return out;
}

function fail(out: (s: string) => void, code: string, message: string, remediation?: string): void {
  out(`!! ${code}: ${message}\n`);
  if (remediation !== undefined) out(`next: ${remediation}\n`);
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
    rec = store.get(parsed.runId);
  } catch (e) {
    fail(
      out,
      "no-record",
      `no run record for ${parsed.runId}: ${(e as Error).message}`,
      "check the run id; records live under $QDS_RUNS_DIR (default .sandbox/runs) — create the run first",
    );
    return 1;
  }

  const deps: TeardownDeps = {
    driver,
    store,
    requestId,
    gitCwd: process.cwd(),
    ...(parsed.dir === undefined ? {} : { runsDir: parsed.dir }),
  };
  try {
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
    const err = e as { code?: string; remediation?: string; message?: string };
    fail(out, err.code ?? "error", err.message ?? String(e), err.remediation);
    return 1;
  }
}

if (import.meta.main) {
  try {
    process.exit(await run(process.argv.slice(2), (s) => process.stdout.write(s)));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  }
}
