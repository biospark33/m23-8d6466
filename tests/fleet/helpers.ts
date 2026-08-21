/** Shared fleet-test fixtures (DF3.1): the DF2.8 decision-shape ledger fakes. */
import { defaultKeyCapMicroUsd } from "../../src/providers/credentials.ts";
import type { LedgerLike } from "../../src/fleet/dispatch.ts";

/** A ledger that admits at `ceiling` µ$ (the DF2.8 admitted decision shape). */
export function goodLedger(ceilingMicroUsd: number = defaultKeyCapMicroUsd): LedgerLike {
  return {
    config: { defaultCapMicroUsd: ceilingMicroUsd, perIssueOverrides: {} },
    admitIssue: () => ({
      admitted: true as const,
      status: "within-budget" as const,
      admittedCeilingMicroUsd: ceilingMicroUsd,
      capMicroUsd: ceilingMicroUsd,
      spentMicroUsd: 0,
      reservedMicroUsd: 0,
      remainingMicroUsd: ceilingMicroUsd,
      unpricedRows: 0,
    }),
    close: () => {},
  };
}
