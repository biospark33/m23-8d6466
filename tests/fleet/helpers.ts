/** Shared fleet-test fixtures (DF3.1): the DF2.8 decision-shape ledger fakes. */
import { defaultKeyCapMicroUsd } from "../../src/providers/credentials.ts";
import type { AdmissionDecision, AdmissionInput } from "../../src/providers/cost-ledger.ts";
import type { LedgerLike } from "../../src/fleet/dispatch.ts";

/** One `admitIssue` call, exactly as the budget gate handed it over. */
export interface AdmitCall {
  input: AdmissionInput;
  capMicroUsd: number;
  keyCapMicroUsd: number;
}

/**
 * A ledger fake that RECORDS what it was asked.
 *
 * An `admitIssue` that ignores its arguments hides the whole money path: the
 * dispatcher could book the wrong issue, under the wrong run, against the wrong
 * cap, and every downstream assertion would still hold. `closeCalls` is the
 * other half — the real ledger owns a SQLite handle, so a dispatch that does
 * not close it leaks one per run, on the success path and on every refusal.
 */
export interface RecordingLedger extends LedgerLike {
  readonly admitCalls: AdmitCall[];
  closeCalls: number;
}

/** What {@link recordingLedger}'s `issueBudgetSnapshot` reports. Ceiling defaults
 *  to MAX_SAFE_INTEGER — infinite headroom — because the fan-out pre-flight only
 *  acts when the numbers DON'T fit, and every pre-existing caller means "never
 *  refuse". A test pinning the refusal names a tight ceiling explicitly. */
export interface BudgetSnapshot {
  ceilingMicroUsd: number;
  spentMicroUsd: number;
  reservedMicroUsd: number;
}

/**
 * `defaultCapMicroUsd` is named for the field it BECOMES. It was called
 * `ceilingMicroUsd` while every caller passed a cap into it — in the one helper
 * whose job is keeping the ceiling and the cap distinguishable.
 */
function recordingLedger(defaultCapMicroUsd: number, decide: () => AdmissionDecision): RecordingLedger {
  const admitCalls: AdmitCall[] = [];
  const ledger: RecordingLedger = {
    config: { defaultCapMicroUsd, perIssueOverrides: {} },
    issueBudgetSnapshot: () => ({
      ceilingMicroUsd: Number.MAX_SAFE_INTEGER,
      spentMicroUsd: 0,
      reservedMicroUsd: 0,
    }),
    admitIssue(input, capMicroUsd, keyCapMicroUsd) {
      // SNAPSHOT, not the live reference. `input` belongs to the dispatcher,
      // which is free to mutate or reuse the object after the call — and then
      // every recorded entry describes the FINAL state rather than what the gate
      // was asked, so a dispatcher booking the wrong issue and correcting the
      // object afterwards records as correct. `AdmitCall`'s own docblock says
      // "exactly as the budget gate handed it over"; only a clone makes that
      // true. (`AdmissionInput` is four strings, so this is structured-cloneable
      // by construction.)
      admitCalls.push({ input: structuredClone(input), capMicroUsd, keyCapMicroUsd });
      return decide();
    },
    close() {
      ledger.closeCalls += 1;
    },
    admitCalls,
    closeCalls: 0,
  };
  return ledger;
}

/**
 * A ledger that admits at `ceiling` µ$ (the DF2.8 admitted decision shape).
 *
 * `capMicroUsd` defaults to the ceiling for the callers that do not care, but
 * takes its own value so a test can make the two DIFFER. They are different
 * quantities in production — the ceiling is `min(keyCap, remaining)` — and
 * while they are equal every assertion that reads one passes if the dispatcher
 * propagates the other, which is exactly the AC9b confusion worth catching.
 */
export function goodLedger(
  ceilingMicroUsd: number = defaultKeyCapMicroUsd,
  capMicroUsd: number = ceilingMicroUsd,
  budgetSnapshot?: BudgetSnapshot,
): RecordingLedger {
  const ledger = recordingLedger(capMicroUsd, () => ({
    admitted: true as const,
    status: "within-budget" as const,
    admittedCeilingMicroUsd: ceilingMicroUsd,
    capMicroUsd,
    spentMicroUsd: 0,
    reservedMicroUsd: 0,
    remainingMicroUsd: ceilingMicroUsd,
    unpricedRows: 0,
  }));
  if (budgetSnapshot !== undefined) {
    ledger.issueBudgetSnapshot = () => budgetSnapshot;
  }
  return ledger;
}

/** A ledger whose issue is over cap (the DF2.8 refused decision shape). */
export function overBudgetLedger(): RecordingLedger {
  return recordingLedger(10_000_000, () => ({
    admitted: false as const,
    status: "over-budget" as const,
    reason: "spend-cap-exceeded" as const,
    capMicroUsd: 10_000_000,
    spentMicroUsd: 12_000_000,
    reservedMicroUsd: 0,
    unpricedRows: 0,
  }));
}

/** The messages the two failing fakes below throw, for callers that assert on them. */
export const ADMIT_THROW_MESSAGE = "ledger admitIssue failed";
export const CLOSE_THROW_MESSAGE = "ledger close failed";

/**
 * A ledger whose `admitIssue` THROWS — the real one owns a SQLite handle and
 * every statement it runs can fail.
 *
 * The call is still RECORDED before the throw, so a test can tell "the gate was
 * reached and blew up" from "the gate was never reached". This is the path where
 * the handle leak lives: only the dispatcher can close a ledger that threw
 * inside the gate, and nothing else in this file exercises a throw.
 */
export function admitThrowsLedger(): RecordingLedger {
  return recordingLedger(defaultKeyCapMicroUsd, () => {
    throw new Error(ADMIT_THROW_MESSAGE);
  });
}

/**
 * A ledger whose `close()` THROWS. `closeCalls` still counts the attempt, so a
 * dispatch that swallows the failure stays distinguishable from one that never
 * closed at all — and a failing close must not turn a successful run into a
 * crash.
 */
export function closeThrowsLedger(): RecordingLedger {
  const ledger = goodLedger();
  const countClose = ledger.close.bind(ledger);
  ledger.close = () => {
    countClose();
    throw new Error(CLOSE_THROW_MESSAGE);
  };
  return ledger;
}

// `rejection` moved to `tests/helpers.ts`. It is imported by
// `tests/providers/fake-driver.test.ts` as well as this suite, and a shared
// combinator does not belong inside the higher layer's fixtures — see that
// file's header for the load-cost half of the reason.

// ─── process-corpse helpers (shared by the lock-choreography suites) ──────────

import { isAlive } from "../../scripts/lib/run-lock.ts";

/**
 * Spawn a short-lived child and resolve once its pid is provably dead.
 *
 * Shared here rather than re-declared per file: a fix to HOW death is proven
 * (e.g. `Bun.spawn(["true"])` flaking on a loaded host) must land everywhere
 * at once or two suites silently disagree about what "dead" means.
 *
 * After `proc.exited` resolves, poll `isAlive` up to 2 seconds (100×20ms) to
 * ensure the pid is truly no longer alive. This guards against TOCTOU on loaded
 * hosts where `proc.exited` may resolve before the process table entry is fully
 * reaped.
 */
export async function deadPid(): Promise<number> {
  const proc = Bun.spawn(["true"]);
  await proc.exited; /* dp:ok resolves with exit code, never rejects */
  const pid = proc.pid;

  // Ponytail: poll isAlive up to 2s. On a loaded host, the pid may still briefly
  // report alive after exited resolves. 100 iterations of 20ms = 2000ms budget.
  // If the process is truly dead, isAlive returns false within the first few polls.
  // If it never dies within budget, throw - this is a test infrastructure bug.
  for (let i = 0; i < 100; i++) {
    if (!isAlive(pid)) {
      return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`deadPid: pid ${pid} still reports as alive after 2000ms - test infrastructure bug`);
}

/** A live child the test kills on teardown — for identity-match rows. */
export function liveChild(): Bun.Subprocess {
  return Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}

// ─── audit-store containment (DF5.3 C11) ─────────────────────────────────────

import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Point `QDS_AUDIT_DB` at a fresh per-test store for every test in the calling
 * suite, and restore the operator's environment afterwards.
 *
 * MANDATORY in any suite that reaches a composition root which opens the audit
 * store with no argument — `dispatch()` (src/fleet/dispatch.ts), `fleet
 * dispatch` (scripts/fleet.ts), `sandbox-teardown` (scripts/sandbox-teardown.ts).
 * `openAuditStore()` resolves `process.env.QDS_AUDIT_DB ?? ".sandbox/audit.db"`
 * RELATIVE TO CWD, and these suites run with cwd = repo root: without this the
 * fleet suite appends real rows to the operator's live `.sandbox/audit.db`,
 * co-resident with the evidence of real runs. (Measured before this landed:
 * 3,528 rows, 3,502 of them carrying `owner/repo` — this file's fixture slug.)
 *
 * The env var, not a cwd change: `dispatch()` takes no store path, several of
 * these suites assert on `process.cwd()` deliberately, and a spawned
 * `bun scripts/fleet.ts` child inherits `process.env` but not a per-test chdir.
 *
 * The returned `path()` is the store file the run under test will create — the
 * parent temp dir exists, the file does not, so `existsSync(path())` is also the
 * assertion that a dispatch refused BEFORE the open created no store at all.
 */
export function useTempAuditStore(): { path: () => string } {
  let dir: string | undefined;
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.QDS_AUDIT_DB;
    dir = mkdtempSync(join(tmpdir(), "qds-fleet-audit-"));
    process.env.QDS_AUDIT_DB = join(dir, "audit.db");
  });
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: unsetting an env var requires delete
    if (previous === undefined) delete process.env.QDS_AUDIT_DB;
    else process.env.QDS_AUDIT_DB = previous;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  return {
    path: () => {
      if (dir === undefined) throw new Error("useTempAuditStore().path() called outside a test");
      return join(dir, "audit.db");
    },
  };
}
