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

import { writeSync } from "node:fs";

import {
  RunRecordStore,
  assertValidRunId,
  getRecord,
  harvestRun,
  openRouterKeyApi,
  resolveDriver,
  teardownSandbox,
  type HarvestError,
  type RunRecord,
  type TeardownDeps,
} from "../src/providers/index.ts";
import { CostLedger } from "../src/providers/cost-ledger.ts";
import { newRequestId, setLogSink } from "../src/swarmclaw/log.ts";
import { parseValueFlags, tokenizeArgs } from "./lib/cli-args.ts";
import { costLedgerOpts } from "./lib/cost-ledger-opts.ts";
import {
  acquireRunLock,
  clearRunLockDestructive,
  markRunLockDestructive,
  releaseRunLock,
} from "./lib/run-lock.ts";

// The lock moved to scripts/lib/run-lock.ts (shared with scripts/fleet.ts);
// re-exported here because this CLI has always exported both symbols.
export { acquireRunLock, RunLockedError } from "./lib/run-lock.ts";

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
  // Path-injection guard: runId is joined into filesystem paths, so reject
  // characters that escape the runs directory. Run IDs are minted by newId()
  // as `<slug>-<YYYYMMDD>-<6 hex>`. The store's own validator, not a copy of
  // its pattern: a restated regex printed a grammar the store no longer
  // enforced (it now rejects a trailing hyphen — the id becomes a box name and
  // then an RFC 1123 hostname label). Rethrown only to append this CLI's help.
  if (out.runId !== undefined) {
    try {
      assertValidRunId(out.runId);
    } catch (e) {
      throw new Error(`${(e as Error).message}\n${HELP.join("\n")}`);
    }
  }
  return out;
}

function fail(out: (s: string) => void, code: string, message: string, remediation?: string): void {
  out(`!! ${code}: ${message}\n`);
  if (remediation !== undefined) out(`next: ${remediation}\n`);
}

export async function run(argv: readonly string[], out: (s: string) => void): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    // parseArgs throws with help text; print it and exit 1
    out((e as Error).message);
    return 1;
  }
  if (parsed.runId === undefined) {
    fail(out, "error", `missing <run-id>\n${HELP.join("\n")}`);
    return 1;
  }
  if (parsed.mode === "harvest" && parsed.noHarvest) {
    fail(out, "error", `harvest mode has no harvest gate to waive: --no-harvest is a teardown flag\n${HELP.join("\n")}`);
    return 1;
  }
  const requestId = newRequestId();
  const driver = resolveDriver(parsed.driver ?? process.env.QDS_PROVIDER_DRIVER ?? "fake", {
    requestId,
    runId: parsed.runId,
  });
  const store = new RunRecordStore({ ...(parsed.dir === undefined ? {} : { dir: parsed.dir }), requestId });

  const deps: TeardownDeps = {
    driver,
    store,
    requestId,
    gitCwd: process.cwd(),
    // The store's own resolution, not a second copy of the same `?? env ??
    // default` chain: the lock guards `<store.dir>/<runId>.lock`, so the
    // bundle/artifact paths must be under exactly that directory.
    runsDir: store.dir,
  };
  let lock: string | undefined;
  let ledger: CostLedger | undefined;
  // Mirrors the run lock's destructive mark, so the `finally` below can tell a
  // release that FAILED from one this module deliberately refused — the two
  // need opposite remediations, and only the second means "the run's state is
  // unknown, do not let anything else touch it".
  let destructivePhase = false;
  // Assigned on every path, then possibly downgraded by the finally: a release
  // failure leaves the run wedged, and `return 0` inside the try would have
  // committed the exit code before the cleanup could say so. Seeded to failure
  // because the finally READS it (same as scripts/qds-cost.ts): only a completed
  // teardown/harvest sets 0, so a throw the catch cannot itself survive never
  // reads as success — `outcome === 0` on `undefined` is false, which silently
  // downgraded the cleanup diagnostic to a no-op.
  let outcome = 1;
  try {
    // A run that does not exist must refuse having touched NOTHING, so probe
    // for the record first: the lock is a real file — created, fsynced, and
    // (on a crash before the finally) left behind for a phantom run, while a
    // concurrent invocation then sees that phantom as busy. `sandbox-teardown
    // typo-run-id` used to create `<runsDir>/typo-run-id.lock` before finding
    // out there was no such run. Same order as scripts/fleet.ts.
    getRecord({ store }, parsed.runId);
    // Then the lock, and only THEN the read the teardown actually uses: the
    // probe above is deliberately not trusted across the lock boundary, because
    // reading first is a check-then-act — a concurrent teardown closes the run
    // and revokes its key while this invocation still holds a record that names
    // the keyHash, and the revoke runs twice.
    lock = acquireRunLock(store.dir, parsed.runId, "sandbox-teardown");
    // Shared classifier (harvest.ts getRecord — the same one harvestRun and
    // teardownSteps use): genuine ENOENT absence → no-record + create-the-run
    // guidance; every other read failure → record-read-failed + inspect-first
    // guidance, because a corrupt record can still have a live box and a live
    // key behind it. Both codes reach the catch below unchanged.
    const rec: RunRecord = getRecord({ store }, parsed.runId);
    if (parsed.mode === "harvest") {
      // D8: harvest is credential-free — no keyApi is built, so a missing
      // $OPENROUTER_PROVISIONING_KEY cannot block it.
      const res = await harvestRun(deps, parsed.runId);
      out(res.outcome === "harvested" ? `harvested: ${res.count}\n` : "harvested: none\n");
      outcome = 0;
    } else {
      // Keyed records need the key API (spend/revoke/verify); keyless runs work
      // offline. openRouterKeyApi throws its own provisioning-key-missing
      // remediation before anything is mutated.
      if (rec.keyHash !== undefined) deps.keyApi = openRouterKeyApi();
      // DF2.8: wire the cost ledger by default — it prices box hours at close.
      // The ledger file and the cost config are resolved from the RECORDS
      // directory (scripts/lib/cost-ledger-opts.ts), the same helper
      // scripts/fleet.ts reserves budget through. Constructed with neither, as
      // it was, this CLI fell back to CostLedger's own cwd-relative
      // `.sandbox/cost-ledger.db`: `fleet dispatch --dir /srv/runs` reserved in
      // /srv/cost-ledger.db and `sandbox-teardown --dir /srv/runs <id>` settled
      // the box hours into ./.sandbox/cost-ledger.db, leaving the reservation
      // open forever against the budget cap — and priced them off
      // DEFAULT_COST_CONFIG rather than the operator's cost-config.json.
      ledger = new CostLedger({
        ...costLedgerOpts(store.dir),
        readRunRecord: (id) => {
          try {
            const r = getRecord({ store }, id);
            return { createdAt: r.createdAt, closedAt: r.closedAt, keyHash: r.keyHash, limitMicroUsd: r.limitMicroUsd };
          } catch (e) {
            // Only a genuine missing record maps to undefined — the shared
            // getRecord classifier distinguishes it by typed code; the ledger
            // surfaces its own structured record-missing error for that. A
            // corrupt or unreadable record (record-read-failed) propagates: a
            // live box and key may sit behind it, and swallowing the failure
            // would let the ledger treat the run as never-existing.
            if ((e as HarvestError).code === "no-record") return undefined;
            throw e;
          }
        },
      });
      deps.costLedger = ledger;
      // Past this point the lock must NOT be dropped automatically, on ANY exit
      // path: `teardownSandbox` destroys the box, revokes the key and closes
      // the record, and a Ctrl-C or a throw partway through leaves a state only
      // an operator can judge. Releasing it would hand that state straight to
      // the next teardown, which re-runs against a half-torn-down run. This CLI
      // never marked at all — `scripts/fleet.ts` did (line ~1034), so the same
      // destructive verb was protected through one entry point and not the
      // other, which is precisely what sharing ONE lock implementation is for.
      markRunLockDestructive(lock);
      destructivePhase = true;
      await teardownSandbox(deps, parsed.runId, { noHarvest: parsed.noHarvest });
      // Returned, not threw: the box is gone, the key revoked and the record
      // closed, so the state is known again and the `finally` below may release
      // normally. Only the success path clears it — see releaseRunLock.
      clearRunLockDestructive(lock);
      destructivePhase = false;
      // The waiver goes to the run log + stdout, never the record (INV-5), and
      // AFTER the teardown ran: printed first, it claims a waiver for a
      // teardown that may never have happened. Same order as scripts/fleet.ts.
      if (parsed.noHarvest) out(`teardown.harvest_waived ${parsed.runId}\n`);
      out(`torn down: ${parsed.runId}\n`);
      outcome = 0;
    }
  } catch (e) {
    // Non-Error rejections normalize to {} so the printer cannot itself throw
    // while reporting one.
    const err = (e ?? {}) as { code?: string; remediation?: string; message?: string };
    fail(out, err.code ?? "error", err.message ?? String(e), err.remediation);
    outcome = 1;
  } finally {
    /**
     * ONE cleanup-failure policy, shared with `scripts/fleet.ts` and
     * `scripts/qds-cost.ts` (see the fuller statement at fleet.ts's finally):
     * on an otherwise-successful path a cleanup failure IS the error — a
     * box-hour spend that may never have been durably committed, or a run left
     * locked against every later teardown, is not a clean `torn down:` and an
     * exit 0. It never overwrites a failure the teardown already reported.
     *
     * This CLI's table is 0/1 only, so a wedged cleanup is 1 here where
     * `fleet` can afford its own code (6) for it.
     */
    const cleanupFailed = (): void => {
      if (outcome === 0) outcome = 1;
    };
    // Close the ledger handle here so every exit path (success, teardown
    // failure, harvest return) releases it.
    if (ledger !== undefined) {
      try {
        ledger.close();
      } catch (e) {
        fail(out, "ledger-close-failed", `could not close the cost ledger: ${(e as Error).message}`, "the ledger is WAL-mode and the handle dies with the process; re-run to confirm it still reads");
        cleanupFailed();
      }
    }
    // Release only OUR lock: releaseRunLock re-reads the body and unlinks it
    // only while it is still this invocation's claim, so a refused invocation
    // (EEXIST) — or one whose lock was cleared and re-taken — never unlinks a
    // live holder's file. A release failure keeps the run locked for every
    // later teardown, so it must show up in the exit code, not only in the
    // diagnostic.
    if (lock !== undefined) {
      try {
        releaseRunLock(lock);
      } catch (e) {
        // Two different failures, two different remediations. `destructivePhase`
        // means the lock was HELD ON PURPOSE: the box may be gone, the key may
        // be revoked and the record may still be open, and "rm it once no other
        // invocation holds it" would invite exactly the retry against a
        // half-torn-down run the mark exists to prevent.
        fail(
          out,
          destructivePhase ? "lock-held" : "lock-release-failed",
          destructivePhase
            ? `${lock} was NOT released: this invocation failed after it began destroying the run`
            : `could not release ${lock}: ${(e as Error).message}`,
          destructivePhase
            ? `check the run's box, key and record before anything else touches it; rm ${lock} only once you know the teardown state`
            : `rm ${lock} by hand once no other invocation holds it — until then every later teardown of this run refuses`,
        );
        cleanupFailed();
      }
    }
  }
  return outcome;
}

if (import.meta.main) {
  try {
    // writeSync, not process.stdout.write: piped stdout can still be pending
    // when process.exit tears the process down and the diagnostics are lost —
    // the same reasoning as exitWithFailure in scripts/lib/cli-args.ts.
    process.exit(await run(process.argv.slice(2), (s) => writeSync(1, s)));
  } catch (e) {
    // Residual throws run() does not map itself (driver resolution, store
    // construction): stderr + exit 1, never an unhandled rejection.
    writeSync(2, `${(e as Error).message}\n`);
    process.exit(1);
  }
}
