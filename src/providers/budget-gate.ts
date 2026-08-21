/**
 * Budget gate (DF2.8 AC3) — pre-spawn admission control using the CostLedger.
 *
 * assertWithinBudget resolves the per-issue cap, calls CostLedger.admitIssue,
 * and throws OverBudgetError on the refused variant. The admitted variant
 * returns with admittedCeilingMicroUsd = min(defaultKeyCapMicroUsd, remainingMicroUsd)
 * — the one ceiling handed to DF2.3's mint (AC3).
 *
 * admitIssue already emits the observability log line — do not double-log.
 */

import { defaultKeyCapMicroUsd } from "./credentials.ts";
import type { AdmissionDecision, CostLedger } from "./cost-ledger.ts";
import { capForIssue } from "./cost-ledger.ts";

/**
 * Thrown when assertWithinBudget refuses an over-cap dispatch (AC3).
 * Carries the exact payload keys from the refused AdmissionDecision.
 */
export class OverBudgetError extends Error {
  readonly status = "over-budget" as const;
  readonly reason = "spend-cap-exceeded" as const;
  readonly capMicroUsd: number;
  readonly spentMicroUsd: number;
  readonly reservedMicroUsd: number;
  readonly unpricedRows: number;
  readonly code: "over-budget";
  readonly remediation: string;

  constructor(refused: {
    capMicroUsd: number;
    spentMicroUsd: number;
    reservedMicroUsd: number;
    unpricedRows: number;
  }) {
    super(
      `issue over budget: spent ${refused.spentMicroUsd} / ${refused.capMicroUsd} µ$ (${refused.unpricedRows} unpriced rows) — raise the cap via .sandbox/cost-config.json perIssueOverrides or pick another issue`,
    );
    this.name = "OverBudgetError";
    this.capMicroUsd = refused.capMicroUsd;
    this.spentMicroUsd = refused.spentMicroUsd;
    this.reservedMicroUsd = refused.reservedMicroUsd;
    this.unpricedRows = refused.unpricedRows;
    this.code = "over-budget";
    this.remediation =
      `raise the cap via .sandbox/cost-config.json perIssueOverrides (e.g. {"owner/repo#N": <integer µ$>}), or pick another issue`;
  }
}

export interface BudgetGateInput {
  repoSlug: string;
  issueId: string;
  runId: string;
  requestId: string;
}

/**
 * Assert that an issue is under its spend cap, returning the admitted decision.
 * Resolves the per-issue cap with capForIssue, calls ledger.admitIssue, and
 * throws OverBudgetError on the refused variant (carrying the exact payload).
 *
 * @param ledger - The CostLedger instance to query.
 * @param input - The issue identification and run context.
 * @param keyCapMicroUsd - The DF2.3 default key cap (for ceiling clamping).
 * @returns The admitted decision with admittedCeilingMicroUsd = min(keyCap, remaining).
 * @throws OverBudgetError - When the issue is at or over its cap.
 */
export function assertWithinBudget(
  ledger: CostLedger,
  input: BudgetGateInput,
  keyCapMicroUsd: number = defaultKeyCapMicroUsd,
): Extract<AdmissionDecision, { admitted: true }> {
  const cap = capForIssue(ledger.config, input.repoSlug, input.issueId);
  const decision = ledger.admitIssue(input, cap, keyCapMicroUsd);
  if (!decision.admitted) {
    // Throw with the exact payload keys from the refused variant
    throw new OverBudgetError({
      capMicroUsd: decision.capMicroUsd,
      spentMicroUsd: decision.spentMicroUsd,
      reservedMicroUsd: decision.reservedMicroUsd,
      unpricedRows: decision.unpricedRows,
    });
  }
  return decision;
}

/**
 * Extract the admitted ceiling from a decision — the one number handed to DF2.3's mint.
 * Returns decision.admittedCeilingMicroUsd (the min(defaultKeyCapMicroUsd, remainingMicroUsd)).
 *
 * Enforcement locus (documented, deliberate): this ceiling becomes the minted
 * key's provider-side hard USD limit — mintRunKey passes it as capMicroUsd,
 * keyApi.createKey mints with limitUsd, and the mint REFUSES a provider echo
 * that does not carry the requested limit (credentials.ts). So an in-flight
 * run's token spend is bounded at the provider, not at ingest: the ledger
 * records post-hoc what was spent and never rejects a row for exceeding a
 * ceiling, because by ingest time the provider has already enforced it. What
 * the ledger itself enforces is BETWEEN dispatches — admitIssue's reservation
 * accounting sums outstanding admitted ceilings so concurrent runs cannot
 * each win the same remaining headroom. Box hours are the one term no key
 * bounds; teardown prices them from the record's own timestamps, and their
 * lifetime is bounded by the teardown/DF2.6-reaper hygiene, not by this cap.
 */
export function mintCapMicroUsd(decision: Extract<AdmissionDecision, { admitted: true }>): number {
  return decision.admittedCeilingMicroUsd;
}
