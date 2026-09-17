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
 * SweepError (malformed record, unenumerable list, config error), any
 * apply-mode action failure, or an apply-mode success-path close failure of
 * EITHER handle — the cost ledger or the audit-link store. A store that did not
 * close cleanly may not have flushed, so an audit-store close failure is exit 1
 * even when every link the sweep emitted was already committed and every unit
 * succeeded: the cron/CI consumer keying on the exit code must not read a
 * possibly-unflushed evidence write as success. Exit 2 is usage. Errors print
 * `!! <code>: <message>` plus
 * `next: <remediation>`; key material is never printed.
 */

import { writeSync } from "node:fs";

import {
  openRouterKeyApi,
  resolveCleanupDriver,
  RunRecordStore,
  sweep,
  type SweepDeps,
  type SweepReport,
} from "../src/providers/index.ts";
import { CostLedger } from "../src/providers/cost-ledger.ts";
import { getRecord } from "../src/providers/harvest.ts";
// DF5.3: opened for an APPLY only — a dry run performs zero calls and emits
// nothing, so it must not materialise audit.db either (the same file-set
// discipline F044 set for the ledger).
import { openAuditStore, type AuditStoreWriter } from "../src/audit/link-store.ts";
import { costLedgerOpts } from "./lib/cost-ledger-opts.ts";
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
  "Env: QDS_QUOTA_LIMITS_FILE (limits file; default .sandbox/quota-limits.json under cwd)",
  "",
  "Note: the reap directory keeps the newest 200 reports (REAP_HISTORY_MAX_REPORTS);",
  "      older ones are deleted after each sweep — archive elsewhere for a longer audit trail.",
  "",
];

const VALUE_FLAGS = ["--driver"] as const;
const BOOL_FLAGS = ["--yes"] as const;

export interface ParsedArgs {
  yes: boolean;
  driver?: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  // Shared tokenizer; this CLI is destructive, so stray single-dash tokens
  // (except the -h help alias, which the shared grammar routes to HELP +
  // exit 0) and unknown flags throw rather than being dropped.
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
  // Frames must stay one-line to stay greppable — scrub embedded newlines.
  const cleanMessage = message.replace(/[\r\n]+/g, "; ");
  out(`!! ${code}: ${cleanMessage}\n`);
  if (remediation !== undefined) {
    const cleanRemediation = remediation.replace(/[\r\n]+/g, "; ");
    out(`next: ${cleanRemediation}\n`);
  }
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
    // R5: the reaper only ever destroys. A create-time config refusal here
    // would strand exactly the orphans it exists to collect.
    driver ??= resolveCleanupDriver(parsed.driver ?? process.env.QDS_PROVIDER_DRIVER ?? "fake", { requestId });
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
  // F044: built only for an APPLY. The constructor mkdirs, chmods and OPENS
  // (creating) cost-ledger.db plus its -wal/-shm sidecars, so building it in
  // the sweep(...) argument list meant the default dry run — "classify the
  // fleet, write the report, delete nothing" — left three new files behind on
  // every invocation. A dry run settles nothing, so it needs no ledger.
  let ledger: CostLedger | undefined;
  // DF5.3: opened below for an APPLY only; the closure no-ops while it is
  // undefined (a dry run reaches no emit site, so nothing is silently dropped).
  let auditStore: AuditStoreWriter | undefined;
  // D6 (round 3): set by the finally when the ledger handle failed to release.
  let ledgerCloseFailed = false;
  // C10: the audit store's close obeys the SAME policy as the ledger's — one
  // fault class must not produce two exit codes across the four CLIs.
  let auditCloseFailed = false;
  try {
    const store = deps.store ?? new RunRecordStore({ requestId });
    if (parsed.yes) {
      // DF5.3: apply mode is this CLI's composition root for the sweep's links
      // (the orphan-path `reap` and each teardown unit's `teardown`).
      auditStore = openAuditStore();
      // DF2.8 (see SweepDeps.costLedger): the sweep's teardown units must
      // settle box hours into the SAME ledger dispatch reserved against —
      // costLedgerOpts(store.dir), exactly the sandbox-teardown wiring.
      // Without it a reaped run closes with zero cost_events rows and its
      // reservation counts against the issue cap forever (MEASURED live
      // 2026-08-26, T3.4b).
      ledger = new CostLedger({
        ...costLedgerOpts(store.dir),
        runsDir: store.dir,
        readRunRecord: (id) => {
          try {
            const r = getRecord({ store }, id);
            return { createdAt: r.createdAt, closedAt: r.closedAt, keyHash: r.keyHash, limitMicroUsd: r.limitMicroUsd };
          } catch (e) {
            // Same classifier semantics as sandbox-teardown: only genuine
            // absence maps to undefined; a corrupt record propagates — a
            // live box and key may sit behind it.
            if ((e as { code?: string }).code === "no-record") return undefined;
            throw e;
          }
        },
      });
    }
    report = await sweep(
      {
        driver,
        store,
        // openRouterKeyApi throws its own provisioning-key-missing remediation
        // before the sweep enumerates anything.
        keyApi: deps.keyApi ?? openRouterKeyApi(),
        ...(ledger !== undefined ? { costLedger: ledger } : {}),
        ...(deps.reapDir !== undefined ? { reapDir: deps.reapDir } : {}),
        ...(deps.limits !== undefined ? { limits: deps.limits } : {}),
        ...(deps.now !== undefined ? { now: deps.now } : {}),
        requestId,
        recordAuditLink: (link) => {
          // NOT `auditStore?.record(link)`. The story sanctions exactly ONE
          // silent no-op link sink (the reaper's run-less revokeAndVerify,
          // W14B-3/INV-AUDIT-4) and this is not it: a dry run reaches no emit
          // site at all, so an emit arriving before the apply-mode open is a
          // MIS-ORDERED emit — a programming error to be loud about, not a
          // condition to swallow. The window is unreachable today; the throw is
          // what keeps it unreachable when an emit site moves one line earlier.
          const store = auditStore;
          if (store === undefined) {
            throw new Error(
              `audit link ${link.hop}/${link.event} was emitted before the audit store was opened — this is a sweep ordering bug`,
            );
          }
          store.record(link);
        },
      },
      { yes: parsed.yes },
    );
  } catch (e) {
    const err = (e ?? {}) as { code?: string; message?: string; remediation?: string };
    fail(out, err.code ?? "sweep-failed", err.message ?? String(e), err.remediation);
    return 1;
  } finally {
    // Every exit path releases the handle — sandbox-teardown.ts:~324 and
    // qds-cost.ts:~350 close theirs; this one never did. The shared
    // cleanup-failure policy (stated in full at sandbox-teardown's finally):
    // on an otherwise-successful path a cleanup failure IS the error — a
    // box-hour settle that may never have been durably committed is not a
    // clean exit 0 from a `--yes` apply — while a close failure after an
    // already-failed sweep stays a warning (the sweep's failure takes
    // precedence and already drives exit 1). ledgerCloseFailed feeds the exit
    // decision below; a dry run builds no ledger and is unaffected.
    try {
      auditStore?.close();
    } catch (e) {
      // C10: the same flag discipline as the ledger below — a store that did
      // not close cleanly may not have flushed, so it feeds the exit decision
      // instead of being a stderr-only note. The coercion is guarded: a thrown
      // null/undefined would raise a SECOND error from inside this catch, which
      // escapes the `finally` and masks the real outcome.
      auditCloseFailed = true;
      const x = (e ?? {}) as { message?: string };
      fail(
        out,
        "audit-store-close-failed",
        `could not close the audit-link store: ${x.message ?? String(e)}`,
        "the handle dies with the process; re-run to confirm it still reads",
      );
    }
    try {
      ledger?.close();
    } catch (e) {
      ledgerCloseFailed = true;
      const x = (e ?? {}) as { message?: string };
      fail(
        out,
        "ledger-close-failed",
        `could not close the cost ledger: ${x.message ?? String(e)}`,
        "the ledger is WAL-mode and the handle dies with the process; re-run to confirm it still reads",
      );
    }
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
  // D1 (round 2), observability only — the exit code below is unchanged. A
  // `run-locked` row is a refusal, not a failed unit (the teardown never
  // started and the sweep continued, INV-LOCK-3), yet it still lands in
  // `failures` and drives the exit 1. This line lets a cron/CI consumer tell
  // refusal-noise (another invocation holds the lock; re-run later) from real
  // failure (a unit that was attempted and broke) without re-parsing the
  // per-unit lines.
  const runLockedCount = report.failures.filter((f) => f.code === "run-locked").length;
  if (runLockedCount > 0) {
    const executedUnits =
      report.executed.teardown.length + report.executed.destroy.length + report.executed.revoke.length;
    out(
      `${runLockedCount} unit(s) refused run-locked — refusals are not failures; the sweep executed ${executedUnits} unit(s)\n`,
    );
  }
  // D6 (round 3): a success-path close failure on an APPLY is exit 1, not a
  // diagnostic-then-0 — the box-hour settles the close was releasing may not
  // be durably committed, and the cron consumer keying on the exit code must
  // not read success. (Dry run: no ledger, unchanged exit taxonomy.)
  if (report.mode === "apply" && (report.failures.length > 0 || ledgerCloseFailed || auditCloseFailed)) return 1;
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
