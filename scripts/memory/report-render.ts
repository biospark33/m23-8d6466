#!/usr/bin/env bun
/**
 * M1.3 interim-report renderer — the pure presentation half of the report
 * (AC5): renderReportMd reads ONLY its ReportMetrics parameter, so the md is
 * always re-derivable from the metrics JSON. No I/O, no clock, no store.
 */

export const CORRELATION_NOTE = "primed-vs-unprimed deltas are correlation (observational)";

export interface CostGroup {
  runs: number;
  totalMicroUsd: number;
  meanMicroUsd: number;
}

export interface ReportMetrics {
  generatedAt: string;
  cyclesToDate: number;
  primedCount: number;
  unprimedCount: number;
  receiptCoverage: { withReceipt: number; withoutReceipt: number };
  costTable?: { primed: CostGroup; unprimed: CostGroup };
  /** Omitted entirely at zero observed cycles — absent, not 0 (F-009). */
  outcomeTable?: { primed: { runs: number; meanLatencyMs: number }; unprimed: { runs: number; meanLatencyMs: number } };
  /** F-020: one row per deduped winner — the cycles behind every aggregate.
   * Omitted entirely at zero observed cycles (absent, not 0). */
  cycles?: { runId: string; primed: boolean; receiptPresent: boolean; latencyMs: number }[];
  checkpointEligible: boolean;
  correlationNote: string;
  dataNotes: string[];
  appendedProbes: number;
  /** R2-004: probe-set origin provenance (counts only — the report runs no recalls). Omitted when the probe set is absent/unreadable. */
  byOrigin?: { seed: { probes: number }; cycle: { probes: number } };
  dispatchFailures?: number;
}


export function renderReportMd(m: ReportMetrics): string {
  const lines: string[] = [
    "# M1.3 priming interim report",
    "",
    `generatedAt: ${m.generatedAt}`,
    `cyclesToDate: ${m.cyclesToDate}`,
    `primedCount: ${m.primedCount}`,
    `unprimedCount: ${m.unprimedCount}`,
    "",
    `receiptCoverage: withReceipt=${m.receiptCoverage.withReceipt} withoutReceipt=${m.receiptCoverage.withoutReceipt} (LEFT-JOIN — receipt presence is a data-quality field, never a filter)`,
    "",
  ];
  if (m.costTable !== undefined) {
    lines.push(
      "costTable (exact integer micro-usd, read-only ledger join):",
      `  primed: runs=${m.costTable.primed.runs} totalMicroUsd=${m.costTable.primed.totalMicroUsd} meanMicroUsd=${m.costTable.primed.meanMicroUsd}`,
      `  unprimed: runs=${m.costTable.unprimed.runs} totalMicroUsd=${m.costTable.unprimed.totalMicroUsd} meanMicroUsd=${m.costTable.unprimed.meanMicroUsd}`,
      "",
    );
  } else {
    lines.push("costTable: absent (no ledger data for the observed cycles — an absent source stays absent, never zero-filled)", "");
  }
  if (m.outcomeTable !== undefined) {
    lines.push(
      "outcomeTable (mean recall latencyMs):",
      `  primed: runs=${m.outcomeTable.primed.runs} meanLatencyMs=${m.outcomeTable.primed.meanLatencyMs}`,
      `  unprimed: runs=${m.outcomeTable.unprimed.runs} meanLatencyMs=${m.outcomeTable.unprimed.meanLatencyMs}`,
      "",
    );
  } else {
    lines.push("outcomeTable: absent (no observed cycles — absent, not 0)", "");
  }
  // F-020: one line per deduped cycle when any were observed.
  if (m.cycles !== undefined) {
    lines.push("cycles (deduped winners, one row per cycle):");
    for (const c of m.cycles) {
      lines.push(
        `  runId=${c.runId} primed=${c.primed} receipt=${c.receiptPresent ? "present" : "absent"} latencyMs=${c.latencyMs}`,
      );
    }
    lines.push("");
  }
  // R2-004: the origin split, with the id-anchor caveat whenever cycle probes
  // exist — the blended rate must not hide that cycle-grown queries embed the
  // expected document id.
  if (m.byOrigin !== undefined) {
    lines.push(`byOrigin (probe-set provenance): seed=${m.byOrigin.seed.probes} cycle=${m.byOrigin.cycle.probes}`);
    if (m.byOrigin.cycle.probes > 0) {
      lines.push(
        "  caveat: cycle-grown probes are id-anchored (query embeds the document id) — read the cycle split as id-lookup capability, not semantic recall",
      );
    }
    lines.push("");
  }
  lines.push(
    `checkpointEligible: ${m.checkpointEligible} (cyclesToDate=${m.cyclesToDate}, threshold 30)`,
    "",
    m.correlationNote,
    "",
    "dataNotes:",
    ...m.dataNotes.map((n) => `- ${n}`),
    "",
    `appendedProbes: ${m.appendedProbes}`,
  );
  if (m.dispatchFailures !== undefined) {
    lines.push(`dispatchFailures: ${m.dispatchFailures}`);
  }
  return `${lines.join("\n")}\n`;
}
