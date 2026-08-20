#!/usr/bin/env bun
/**
 * CLI: sandbox-reap — the operator-facing surface of the fleet-wide sweep (DF2.6).
 *
 * Usage:
 *   sandbox-reap [--yes] [--driver <name>]
 *
 * Dry-run by default (reap.just:12-32 posture): identical classification and
 * report file, zero mutating calls. `--yes` applies — teardown per collapsed
 * stale runId, destroy per leaked owned VM, revoke per record-less leaked key.
 * `--driver` defaults to $QDS_PROVIDER_DRIVER or "fake"; records come from
 * $QDS_RUNS_DIR or .sandbox/runs; the host git repo is the cwd (teardown's
 * harvest fetch lands there).
 *
 * The provider `whoami` preflight runs before ANY deletion (reap.just:34
 * posture): a failed preflight reaps nothing. A missing
 * $OPENROUTER_PROVISIONING_KEY fails the same way — the sweep cannot list
 * keys without it. Exit codes: 0 dry-run / clean apply / empty fleet; 1 hard
 * SweepError (malformed record, unenumerable list, config error) or any
 * apply-mode action failure; 2 usage. Errors print `!! <code>: <message>` plus
 * `next: <remediation>`; key material is never printed.
 */

import { writeSync } from "node:fs";

import {
  openRouterKeyApi,
  resolveDriver,
  RunRecordStore,
  sweep,
  type SweepDeps,
  type SweepReport,
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
  "Usage: sandbox-reap [--yes] [--driver <name>]",
  "",
  "  (no flags)              dry run: classify the fleet, write the report, delete nothing",
  "  --yes                   apply: teardown stale runs, destroy leaked VMs, revoke leaked keys",
  "",
  "  --driver <name>         provider driver (default $QDS_PROVIDER_DRIVER or fake)",
  "",
];

const VALUE_FLAGS = ["--driver"] as const;
const BOOL_FLAGS = ["--yes"] as const;

export interface ParsedArgs {
  yes: boolean;
  driver?: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  // Shared tokenizer; this CLI is destructive, so stray single-dash tokens and
  // unknown flags throw rather than being dropped.
  const { positionals, flagTokens, bools } = tokenizeArgs(argv, {
    valueFlags: VALUE_FLAGS,
    boolFlags: BOOL_FLAGS,
    rejectStraySingleDash: true,
  });
  const out: ParsedArgs = { yes: bools.has("--yes") };
  parseValueFlags(flagTokens, {
    flags: VALUE_FLAGS,
    onValue: (flag, value) => {
      if (flag === "--driver") out.driver = value;
    },
    help: HELP,
  });
  // This command takes no positionals — a bare token is a mistyped invocation
  // (e.g. a run id pasted from sandbox-teardown), not a default.
  if (positionals.length > 0) {
    throw new Error(`unexpected argument: ${positionals[positionals.length - 1]}\n${HELP.join("\n")}`);
  }
  return out;
}

function fail(out: (s: string) => void, code: string, message: string, remediation?: string): void {
  out(`!! ${code}: ${message}\n`);
  if (remediation !== undefined) out(`next: ${remediation}\n`);
}

/**
 * Run one sweep invocation. The optional third argument is the test/demo seam:
 * FakeKeyApi state cannot cross a process boundary, so in-process callers
 * inject driver/store/keyApi (and reapDir/limits/now as needed); every field
 * left absent is built exactly as the CLI would build it.
 */
export async function run(
  argv: readonly string[],
  out: (s: string) => void,
  deps: Partial<SweepDeps> = {},
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    // Usage error: the message carries the help text.
    out((e as Error).message);
    return 2;
  }
  const requestId = newRequestId();

  // Preflight: name the account BEFORE any deletion (infra prerequisite — a
  // failed preflight reaps nothing). The injected driver (test seam) is used
  // as-is; otherwise the driver resolves from the registry.
  let driver = deps.driver;
  try {
    driver ??= resolveDriver(parsed.driver ?? process.env.QDS_PROVIDER_DRIVER ?? "fake", { requestId });
    await driver.whoami();
  } catch (e) {
    const err = (e ?? {}) as { code?: string; message?: string; remediation?: string };
    fail(
      out,
      err.code ?? "whoami-failed",
      `provider preflight failed — nothing was reaped: ${err.message ?? String(e)}`,
      err.remediation,
    );
    return 1;
  }

  let report: SweepReport;
  try {
    report = await sweep(
      {
        driver,
        // openRouterKeyApi throws its own provisioning-key-missing remediation
        // before the sweep enumerates anything.
        store: deps.store ?? new RunRecordStore({ requestId }),
        keyApi: deps.keyApi ?? openRouterKeyApi(),
        ...(deps.reapDir !== undefined ? { reapDir: deps.reapDir } : {}),
        ...(deps.limits !== undefined ? { limits: deps.limits } : {}),
        ...(deps.now !== undefined ? { now: deps.now } : {}),
        requestId,
      },
      { yes: parsed.yes },
    );
  } catch (e) {
    const err = (e ?? {}) as { code?: string; message?: string; remediation?: string };
    fail(out, err.code ?? "sweep-failed", err.message ?? String(e), err.remediation);
    return 1;
  }

  out(
    `${report.mode}: teardown ${report.executed.teardown.length}, destroy ${report.executed.destroy.length}, revoke ${report.executed.revoke.length}\n`,
  );
  out(`fleet: ${report.liveVms} VMs, ${report.liveKeys} keys, ${report.records} records (${report.limitsSource} limits)\n`);
  out(`report: ${report.reportFile}\n`);
  if (report.nothingToReap) out("nothing to reap\n");
  for (const f of report.failures) {
    fail(out, f.code, `${f.runId !== undefined ? `run ${f.runId}: ` : ""}${f.message}`, f.remediation);
  }
  if (report.mode === "apply" && report.failures.length > 0) return 1;
  return 0;
}

if (import.meta.main) {
  try {
    // writeSync, not process.stdout.write: piped stdout can still be pending
    // when process.exit tears the process down — same reasoning as
    // sandbox-teardown and scripts/lib/cli-args.ts.
    process.exit(await run(process.argv.slice(2), (s) => writeSync(1, s)));
  } catch (e) {
    // Residual throws run() does not map itself (driver resolution, store
    // construction): stderr + exit 1, never an unhandled rejection.
    writeSync(2, `${(e as Error).message}\n`);
    process.exit(1);
  }
}
