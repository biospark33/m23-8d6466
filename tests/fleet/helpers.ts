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

/**
 * `defaultCapMicroUsd` is named for the field it BECOMES. It was called
 * `ceilingMicroUsd` while every caller passed a cap into it — in the one helper
 * whose job is keeping the ceiling and the cap distinguishable.
 */
function recordingLedger(defaultCapMicroUsd: number, decide: () => AdmissionDecision): RecordingLedger {
  const admitCalls: AdmitCall[] = [];
  const ledger: RecordingLedger = {
    config: { defaultCapMicroUsd, perIssueOverrides: {} },
    admitIssue(input, capMicroUsd, keyCapMicroUsd) {
      admitCalls.push({ input, capMicroUsd, keyCapMicroUsd });
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
): RecordingLedger {
  return recordingLedger(capMicroUsd, () => ({
    admitted: true as const,
    status: "within-budget" as const,
    admittedCeilingMicroUsd: ceilingMicroUsd,
    capMicroUsd,
    spentMicroUsd: 0,
    reservedMicroUsd: 0,
    remainingMicroUsd: ceilingMicroUsd,
    unpricedRows: 0,
  }));
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
