/**
 * M3.2 leaf-1.1.1 — closed proposal + receipt schema tests.
 *
 * The G3 negative controls, by named test: severity field refused, severity
 * tag refused (evidence key + suggested_change area), unknown kind refused,
 * threshold-suggestion without advisory / without adjudicator / without
 * j2_gate_note refused, receipt with an uncovered proposal id refused
 * (AC3 — bank-only retention), duplicate posted entry refused, rationale
 * over the 4 000 ceiling refused, status field (proposal-status machine)
 * refused, unknown extra field refused, malformed week refused — plus the
 * two positive parses and the isoWeekOf year-boundary cases.
 */
import { describe, expect, test } from "bun:test";

import {
  ISO_WEEK_RE,
  PROPOSAL_RATIONALE_CHAR_CEILING,
  PROPOSAL_SCHEMA_LITERAL,
  ProposalSchema,
  RECEIPT_SCHEMA_LITERAL,
  WeeklyReceiptSchema,
  isoWeekOf,
  isoWeekStartUtc,
  type ProposalRecord,
  type WeeklyReceipt,
} from "../../src/learning/proposal-schema.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const validProposal: ProposalRecord = {
  schema: PROPOSAL_SCHEMA_LITERAL,
  proposal_id: "l4-proposal-2026-W41-2026-10-11T06-23-00Z-1",
  kind: "router-tuning",
  week: "2026-W41",
  fired_at: "2026-10-11T06:23:00.000Z",
  target_bank: "qds-factory-router-meta",
  advisory: true,
  rationale:
    "haiku won 62% of routed decisions this week at 0.4x the tier-2 cost with flat quality deltas — propose raising the haiku cutoff for shape=read-summary.",
  suggested_change: { area: "router", summary: "raise haiku tier cutoff for read-summary shapes" },
  evidence: {
    routing_log_refs: [".sandbox/routing-log.jsonl#run-abc"],
    kpi_snapshot_refs: [".sandbox/kpi-snapshots/2026-W41.json"],
    run_record_refs: [".sandbox/runs/run-abc.json"],
  },
  insights_cited: ["qds-factory-router-meta#insight-9"],
  created_at: "2026-10-11T06:23:05.000Z",
};

const validReceipt: WeeklyReceipt = {
  schema: RECEIPT_SCHEMA_LITERAL,
  week: "2026-W41",
  fired_at: "2026-10-11T06:23:00.000Z",
  leg: "crontab",
  proposals: [validProposal.proposal_id],
  superseded: ["l4-proposal-2026-W41-2026-10-04T06-23-00Z-1"],
  absent_sources: [{ source: "routing-log", status: "absent" }],
  banks_ok: ["qds-factory-router-meta"],
  banks_failed: [],
  posted: [{ proposal_id: validProposal.proposal_id, carrier: "stdout" }],
  total_ms: 41_000,
};

/** Loosely-typed mutation for the negative controls — the whole point is that
 *  these patches are NOT valid members of the record types, so they bypass the
 *  compile-time shape and exercise what only the schema can refuse. */
const mutate = (base: object, patch: Record<string, unknown>): Record<string, unknown> => ({
  ...(base as Record<string, unknown>),
  ...patch,
});

const THRESHOLD_CHANGE = { area: "threshold", summary: "raise unattributed-signal gate" };

// ─── positive parses ─────────────────────────────────────────────────────────

describe("ProposalSchema", () => {
  test("parses a full valid ProposalRecord", () => {
    expect(ProposalSchema.safeParse(validProposal).success).toBe(true);
  });

  test("accepts rationale at exactly the 4 000-char ceiling", () => {
    const at = mutate(validProposal, { rationale: "x".repeat(PROPOSAL_RATIONALE_CHAR_CEILING) });
    expect(ProposalSchema.safeParse(at).success).toBe(true);
  });

  test("unknown extra field refused (strict)", () => {
    expect(ProposalSchema.safeParse(mutate(validProposal, { priority: "high" })).success).toBe(false);
  });

  test("unknown kind refused (closed union)", () => {
    expect(ProposalSchema.safeParse(mutate(validProposal, { kind: "severity-recalibration" })).success).toBe(false);
  });

  test("severity field injected refused (Jev LOCKED #9)", () => {
    expect(ProposalSchema.safeParse(mutate(validProposal, { severity: "P1" })).success).toBe(false);
  });

  test("severity tag refused — extra evidence key (AC5)", () => {
    const p = mutate(validProposal, {
      evidence: { ...validProposal.evidence, severity_weights: { critical: 4 } },
    });
    expect(ProposalSchema.safeParse(p).success).toBe(false);
  });

  test("severity proposal kind refused — suggested_change area closed (AC5)", () => {
    const p = mutate(validProposal, {
      suggested_change: { area: "severity", summary: "recalibrate severity" },
    });
    expect(ProposalSchema.safeParse(p).success).toBe(false);
  });

  test("malformed week refused", () => {
    expect(ProposalSchema.safeParse(mutate(validProposal, { week: "2026W41" })).success).toBe(false);
  });

  test("non-existent ISO weeks refused — W00, W54, W99, year 0000 (F-014)", () => {
    for (const week of ["2026-W00", "2026-W54", "2026-W99", "0000-W01"]) {
      expect(ProposalSchema.safeParse(mutate(validProposal, { week })).success).toBe(false);
    }
  });

  test("week at both range boundaries (W01, W53) parses", () => {
    expect(ProposalSchema.safeParse(mutate(validProposal, { week: "2026-W01" })).success).toBe(true);
    expect(ProposalSchema.safeParse(mutate(validProposal, { week: "2026-W53" })).success).toBe(true);
  });

  test("ISO_WEEK_RE is the strict week shape (consumed by weekly-reflect + memory-weekly)", () => {
    expect(ISO_WEEK_RE.test("2026-W41")).toBe(true);
    expect(ISO_WEEK_RE.test("2026-W09")).toBe(true);
    expect(ISO_WEEK_RE.test("1000-W01")).toBe(true); // lowest year a [1-9] lead accepts
    expect(ISO_WEEK_RE.test("0999-W01")).toBe(false);
    expect(ISO_WEEK_RE.test("0000-W01")).toBe(false);
    expect(ISO_WEEK_RE.test("2026-W00")).toBe(false);
    expect(ISO_WEEK_RE.test("2026-W99")).toBe(false);
    expect(ISO_WEEK_RE.test("2026-W1")).toBe(false);
    expect(ISO_WEEK_RE.test("2026-W401")).toBe(false);
  });

  test("status field injected refused (no proposal-status machine)", () => {
    expect(ProposalSchema.safeParse(mutate(validProposal, { status: "PROPOSED" })).success).toBe(false);
  });

  test("rationale over the 4 000-char ceiling refused", () => {
    const over = mutate(validProposal, { rationale: "x".repeat(PROPOSAL_RATIONALE_CHAR_CEILING + 1) });
    expect(ProposalSchema.safeParse(over).success).toBe(false);
  });

  // AC2 — a threshold-suggestion indistinguishable from a directive refuses.
  test("threshold-suggestion with advisory:false refused", () => {
    const p = mutate(validProposal, { kind: "threshold-suggestion", advisory: false });
    expect(ProposalSchema.safeParse(p).success).toBe(false);
  });

  test("threshold-suggestion without adjudicator refused", () => {
    const p = mutate(validProposal, { kind: "threshold-suggestion", advisory: true });
    expect("adjudicator" in p).toBe(false);
    expect(ProposalSchema.safeParse(p).success).toBe(false);
  });

  test("threshold-suggestion with empty j2_gate_note refused", () => {
    const p = mutate(validProposal, {
      kind: "threshold-suggestion",
      advisory: true,
      adjudicator: "operator",
      j2_gate_note: "",
      suggested_change: THRESHOLD_CHANGE,
    });
    expect(ProposalSchema.safeParse(p).success).toBe(false);
  });

  test("valid threshold-suggestion (advisory + operator + j2_gate_note) parses", () => {
    const p = mutate(validProposal, {
      kind: "threshold-suggestion",
      advisory: true,
      adjudicator: "operator",
      j2_gate_note:
        "J2's DD-21 arm-threshold milestone gate is unsatisfied by this proposal — operator adjudication required.",
      suggested_change: THRESHOLD_CHANGE,
    });
    expect(ProposalSchema.safeParse(p).success).toBe(true);
  });
});

describe("WeeklyReceiptSchema", () => {
  test("parses a full valid WeeklyReceipt", () => {
    expect(WeeklyReceiptSchema.safeParse(validReceipt).success).toBe(true);
  });

  test("proposal id missing from posted refused (AC3 — bank-only retention)", () => {
    expect(WeeklyReceiptSchema.safeParse(mutate(validReceipt, { posted: [] })).success).toBe(false);
  });

  test("duplicate posted entry refused", () => {
    const r = mutate(validReceipt, {
      posted: [
        { proposal_id: validProposal.proposal_id, carrier: "stdout" },
        { proposal_id: validProposal.proposal_id, carrier: "chat" },
      ],
    });
    expect(WeeklyReceiptSchema.safeParse(r).success).toBe(false);
  });

  test("posted row naming an id absent from proposals refused (AC3 mirror — posting without landing)", () => {
    const r = mutate(validReceipt, {
      proposals: [],
      posted: [{ proposal_id: "l4-proposal-2026-W41-ghost", carrier: "chat" }],
    });
    expect(WeeklyReceiptSchema.safeParse(r).success).toBe(false);
  });

  test("duplicate ids within proposals refused", () => {
    const r = mutate(validReceipt, {
      proposals: [validProposal.proposal_id, validProposal.proposal_id],
      posted: [{ proposal_id: validProposal.proposal_id, carrier: "stdout" }],
    });
    expect(WeeklyReceiptSchema.safeParse(r).success).toBe(false);
  });

  test("issue paths point at the offending entries (F-026)", () => {
    const uncovered = WeeklyReceiptSchema.safeParse(mutate(validReceipt, { posted: [] }));
    if (uncovered.success) throw new Error("expected refusal");
    expect(uncovered.error.issues.some((iss) => iss.path.join(".") === "proposals.0")).toBe(true);

    const ghost = WeeklyReceiptSchema.safeParse(
      mutate(validReceipt, {
        proposals: [validProposal.proposal_id],
        posted: [
          { proposal_id: validProposal.proposal_id, carrier: "stdout" },
          { proposal_id: "l4-proposal-2026-W41-ghost", carrier: "chat" },
        ],
      }),
    );
    if (ghost.success) throw new Error("expected refusal");
    expect(ghost.error.issues.some((iss) => iss.path.join(".") === "posted.1")).toBe(true);
  });

  test("unknown extra field refused (strict)", () => {
    const extra = mutate(validReceipt, { next_run: "2026-10-18T06:23:00.000Z" });
    expect(WeeklyReceiptSchema.safeParse(extra).success).toBe(false);
  });

  test("absent_sources carries only the typed-absent status", () => {
    const r = mutate(validReceipt, {
      absent_sources: [{ source: "kpi-snapshots", status: "missing" }],
    });
    expect(WeeklyReceiptSchema.safeParse(r).success).toBe(false);
  });
});

describe("isoWeekOf", () => {
  test("mid-year date", () => {
    expect(isoWeekOf(new Date("2026-07-15T00:00:00Z"))).toBe("2026-W29");
  });

  test("year boundary — 2027-01-01 lands in 2026-W53", () => {
    expect(isoWeekOf(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
  });

  test("year boundary — 2021-01-01 lands in 2020-W53", () => {
    expect(isoWeekOf(new Date("2021-01-01T00:00:00Z"))).toBe("2020-W53");
  });

  test("Jan 1 on a Thursday opens its own W01, not the prior year's W53", () => {
    expect(isoWeekOf(new Date("2026-01-01T00:00:00Z"))).toBe("2026-W01");
  });

  test("known date — 2026-10-11 is 2026-W41", () => {
    expect(isoWeekOf(new Date("2026-10-11T06:23:00Z"))).toBe("2026-W41");
  });
});

describe("isoWeekStartUtc", () => {
  test("known week — 2026-W41 starts Monday 2026-10-05T00:00:00.000Z", () => {
    expect(isoWeekStartUtc("2026-W41")).toBe(Date.parse("2026-10-05T00:00:00.000Z"));
  });

  test("W01 — 2026-W01 starts Monday 2025-12-29 (Jan 1 Thursday opens its own week)", () => {
    expect(isoWeekStartUtc("2026-W01")).toBe(Date.parse("2025-12-29T00:00:00.000Z"));
  });

  test("round-trip with isoWeekOf — every day of a sampled week labels back to it", () => {
    for (const week of ["2026-W01", "2026-W41", "2026-W53", "2020-W53", "2027-W01"]) {
      const start = isoWeekStartUtc(week);
      for (let day = 0; day < 7; day++) {
        const d = new Date(start + day * 86_400_000);
        expect(isoWeekOf(d)).toBe(week);
      }
    }
  });

  test("window is exclusive at the next Monday — Oct 4 is W40, Oct 5 is W41", () => {
    expect(isoWeekOf(new Date(isoWeekStartUtc("2026-W41") - 1))).toBe("2026-W40");
    expect(isoWeekOf(new Date(isoWeekStartUtc("2026-W41")))).toBe("2026-W41");
  });

  test("malformed label throws — caller config fault, never a silent NaN window", () => {
    expect(() => isoWeekStartUtc("2026-13")).toThrow(/ISO week label/);
    expect(() => isoWeekStartUtc("")).toThrow(/ISO week label/);
  });

  test("nonexistent W53 in a 52-week year throws — its Monday labels back to the next year's W01", () => {
    expect(() => isoWeekStartUtc("2027-W53")).toThrow(/does not exist/); // 2027-W53 → 2028-01-03 = 2028-W01
    expect(() => isoWeekStartUtc("2021-W53")).toThrow(/does not exist/); // 2021-W53 → 2022-01-03 = 2022-W01
  });

  test("existing W53 rounds through — 2026 and 2020 have 53 ISO weeks", () => {
    expect(isoWeekOf(new Date(isoWeekStartUtc("2026-W53")))).toBe("2026-W53");
    expect(isoWeekOf(new Date(isoWeekStartUtc("2020-W53")))).toBe("2020-W53");
  });
});
