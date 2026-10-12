/**
 * M3.2 leaf-1.2.1 — compose.ts suite: kind mapping, AC2 refinement carriage,
 * AC4 ref-citation + zero-evidence green, AC5 no-severity query token,
 * determinism, id-format discipline.
 */
import { describe, expect, test } from "bun:test";

import {
  buildReflectQuery,
  composeProposals,
  MAX_PROPOSALS_PER_FIRING,
  REFLECT_QUERY_CHAR_CAP,
  type ComposeInput,
} from "../../src/learning/compose.ts";
import type { GatheredEvidence, RoutingLogLine } from "../../src/learning/gather.ts";
import { ProposalSchema } from "../../src/learning/proposal-schema.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const line = (over: Partial<RoutingLogLine>): RoutingLogLine => ({
  workKey: "wk-1",
  runId: "qds-20260901-000001",
  shape: "review",
  risk_tier: "high",
  applied_tier: "opus",
  score: { quality: 0.5 },
  jev_recommendation: "opus",
  created_at: "2026-09-30T10:00:00.000Z",
  ...over,
});

const kpiSnapshot = (name: string, counterValue: number | "absent") => ({
  schema: "qds.kpi-snapshot",
  kpis: [
    {
      name,
      direction: name === "first_pass_accept" ? "up" : "down",
      value: { status: "measured", value: 0.2, denominator: 10, sources: ["routing-log"] },
      counter: { name: "unclassified_restart_rate", value: counterValue, source: "runs" },
    },
  ],
});

const evidenceWith = (over: Partial<GatheredEvidence>): GatheredEvidence => ({
  routingLines: [],
  kpiSnapshots: [],
  runRecords: [],
  absentSources: [],
  ...over,
});

const baseInput = (evidence: GatheredEvidence, over: Partial<ComposeInput> = {}): ComposeInput => ({
  week: "2026-W41",
  firedAt: "2026-10-05T06:23:00.000Z",
  evidence,
  reflects: [{ bankId: "qds-factory-dev-meta", insights: [{ summary: "cost per story trending down" }] }],
  reflect_ok: { "qds-factory-dev-meta": true },
  banks: ["qds-factory-dev-meta"],
  ...over,
});

const routerEvidence = evidenceWith({
  routingLines: [
    line({ runId: "qds-20260901-000001", applied_tier: "opus", score: { quality: 0.5 } }),
    line({ runId: "qds-20260901-000002", workKey: "wk-2", applied_tier: "opus", score: { quality: 0.5 } }),
    line({ runId: "qds-20260901-000003", workKey: "wk-3", applied_tier: "sonnet", score: { quality: 0.8 } }),
    line({ runId: "qds-20260901-000004", workKey: "wk-4", applied_tier: "sonnet", score: { quality: 0.8 } }),
  ],
});

const fullEvidence = evidenceWith({
  routingLines: routerEvidence.routingLines,
  kpiSnapshots: [
    { ref: "2026-10-05T00-00-00-000Z.json", snapshot: kpiSnapshot("retry_rate", 3) },
    { ref: "2026-10-05T00-00-01-000Z.json", snapshot: kpiSnapshot("retry_rate", 0) }, // healthy counter — no proposal
  ],
  runRecords: [
    { ref: "qds-20260920-120000.json", record: { status: "error", classification: "retry-loop" } },
    { ref: "qds-20260921-120000.json", record: { status: "error", classification: "retry-loop" } },
    { ref: "qds-20260922-120000.json", record: { status: "error", classification: "timeout-wait" } },
  ],
});

// ─── kind mapping ────────────────────────────────────────────────────────────

describe("composeProposals", () => {
  test("all three kinds are producible from hand-built fixtures", () => {
    const kinds = composeProposals(baseInput(fullEvidence)).map((p) => p.kind);
    expect(kinds).toContain("router-tuning");
    expect(kinds).toContain("threshold-suggestion");
    expect(kinds).toContain("skill-update");
  });

  test("every emitted record safeParse-clean against ProposalSchema", () => {
    for (const p of composeProposals(baseInput(fullEvidence))) {
      const r = ProposalSchema.safeParse(p);
      expect(r.success).toBe(true);
    }
  });

  test("threshold-suggestion carries advisory + operator adjudicator + the J2 DD-21 note (AC2)", () => {
    const ts = composeProposals(baseInput(fullEvidence)).filter((p) => p.kind === "threshold-suggestion");
    expect(ts.length).toBe(1); // regressed counter fires; the 0-counter snapshot is the negative control
    expect(ts[0]!.advisory).toBe(true);
    expect(ts[0]!.adjudicator).toBe("operator");
    expect(ts[0]!.j2_gate_note).toContain("DD-21");
    expect(ts[0]!.j2_gate_note).toContain("NOT satisfied");
    expect(ts[0]!.evidence.kpi_snapshot_refs).toEqual(["2026-10-05T00-00-00-000Z.json"]);
  });

  test("router-tuning is advisory:false — advisory is NOT forced outside threshold-suggestions", () => {
    const rt = composeProposals(baseInput(routerEvidence)).filter((p) => p.kind === "router-tuning");
    expect(rt.length).toBe(1);
    expect(rt[0]!.advisory).toBe(false);
    expect(rt[0]!.adjudicator).toBeUndefined();
    expect(rt[0]!.suggested_change.area).toBe("router");
  });

  test("router-tuning cites exactly the routing lines it read — kpi_snapshot_refs empty (AC4 truthfulness, F-028)", () => {
    const rt = composeProposals(baseInput(routerEvidence)).find((p) => p.kind === "router-tuning")!;
    expect(rt.evidence.routing_log_refs).toEqual([
      "qds-20260901-000001",
      "qds-20260901-000002",
      "qds-20260901-000003",
      "qds-20260901-000004",
    ]);
    expect(rt.evidence.kpi_snapshot_refs).toEqual([]);
    expect(rt.insights_cited).toEqual(["cost per story trending down"]);
  });

  test("skill-update fires from >=2 run records sharing a failure class", () => {
    const su = composeProposals(baseInput(fullEvidence)).filter((p) => p.kind === "skill-update");
    expect(su.length).toBe(1); // retry-loop x2 recurs; timeout-wait x1 does not
    expect(su[0]!.suggested_change.area).toBe("skill");
    expect(su[0]!.evidence.run_record_refs).toEqual([
      "qds-20260920-120000.json",
      "qds-20260921-120000.json",
    ]);
  });

  test("zero evidence (all sources absent or empty) => [] with no throw", () => {
    expect(composeProposals(baseInput(evidenceWith({ absentSources: [
      { source: "routing-log", status: "absent" },
      { source: "kpi-snapshots", status: "absent" },
      { source: "run-records", status: "absent" },
    ] })))).toEqual([]);
  });

  test("every proposal cites at least one non-empty evidence ref (AC4)", () => {
    for (const p of composeProposals(baseInput(fullEvidence))) {
      const total =
        p.evidence.routing_log_refs.length + p.evidence.kpi_snapshot_refs.length + p.evidence.run_record_refs.length;
      expect(total).toBeGreaterThanOrEqual(1);
    }
  });

  test("failed-reflect bank falls back to the lane-default bank with empty insights", () => {
    const out = composeProposals(
      baseInput(fullEvidence, {
        reflects: [{ bankId: "other-bank", insights: [{ summary: "noise" }] }],
        reflect_ok: { "other-bank": false },
        banks: ["qds-factory-prod-meta", "qds-factory-dev-meta"],
      }),
    );
    expect(out.length).toBeGreaterThan(0);
    for (const p of out) {
      expect(p.target_bank).toBe("qds-factory-dev-meta");
      expect(p.insights_cited).toEqual([]);
    }
  });

  test("determinism: two identical calls deep-equal", () => {
    expect(composeProposals(baseInput(fullEvidence))).toEqual(composeProposals(baseInput(fullEvidence)));
  });

  test("proposal_id format ^l4-proposal-<week>-<stamp>-<seq3>$ with incrementing seq", () => {
    const ids = composeProposals(baseInput(fullEvidence)).map((p) => p.proposal_id);
    expect(ids.length).toBeGreaterThan(1);
    ids.forEach((id, i) => {
      expect(id).toMatch(/^l4-proposal-\d{4}-W\d{2}-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d{3}$/);
      expect(id.endsWith(String(i + 1).padStart(3, "0"))).toBe(true);
    });
  });

  test("firedAt stamp replaces [: and .] with '-' in ids while fired_at keeps the original ISO", () => {
    const firedAt = "2026-10-05T06:23:00.000Z";
    const out = composeProposals(baseInput(fullEvidence, { firedAt }));
    expect(out[0]!.fired_at).toBe(firedAt);
    expect(out[0]!.created_at).toBe(firedAt);
    for (const p of out) {
      expect(p.proposal_id).toContain("2026-10-05T06-23-00-000Z");
      expect(p.proposal_id).not.toContain(":");
    }
  });
});

// ─── buildReflectQuery ───────────────────────────────────────────────────────

describe("buildReflectQuery", () => {
  test("digest carries counts, tier distribution, KPI direction values, and run classes", () => {
    const q = buildReflectQuery("qds-factory-dev-meta", fullEvidence);
    expect(q).toContain("qds-factory-dev-meta");
    expect(q).toContain("4 routing decisions");
    expect(q).toContain("opus x2");
    expect(q).toContain("sonnet x2");
    expect(q).toContain("retry_rate 0.2 (direction down)");
    expect(q).toContain("retry-loop x2");
  });

  test("never contains the severity token, even when an extracted metric name carries it (AC5)", () => {
    const hostile = evidenceWith({
      kpiSnapshots: [
        { ref: "hostile.json", snapshot: { kpis: [{ name: "severity_bleed", direction: "down", value: { status: "measured", value: 1, denominator: 1, sources: [] } }] } },
      ],
    });
    expect(buildReflectQuery("b", hostile).toLowerCase()).not.toContain("sever");
  });

  test("bounded at REFLECT_QUERY_CHAR_CAP regardless of evidence volume", () => {
    const huge = evidenceWith({
      routingLines: Array.from({ length: 200 }, (_, i) =>
        line({ runId: `qds-20260901-${String(i).padStart(6, "0")}`, workKey: `wk-${i}`, applied_tier: `tier-${i % 7}` }),
      ),
    });
    expect(buildReflectQuery("b", huge).length).toBeLessThanOrEqual(REFLECT_QUERY_CHAR_CAP);
  });
});

// ─── self-review round 0 fixes (#6, #7) ──────────────────────────────────────

describe("self-review round 0 — severity-safe embedding + success-class filter", () => {
  const emptyish = {
    week: "2026-W41",
    firedAt: "2026-10-11T18:00:00.000Z",
    reflects: [],
    reflect_ok: {},
    banks: ["qds-factory-dev-meta"],
  };

  test("status:\"ok\" records never compose a skill-update for a 'failure class ok' (#7)", () => {
    const out = composeProposals({
      ...emptyish,
      evidence: {
        routingLines: [],
        kpiSnapshots: [],
        runRecords: [
          { ref: "a.json", record: { status: "ok" } },
          { ref: "b.json", record: { status: "ok" } },
        ],
        absentSources: [],
      },
    });
    expect(out).toEqual([]);
  });

  test("hostile extracted names are severity-filtered in rationale/summary prose too (#6)", () => {
    const out = composeProposals({
      ...emptyish,
      evidence: {
        routingLines: [],
        kpiSnapshots: [
          {
            ref: "sev-snapshot.json",
            snapshot: {
              kpis: [
                {
                  name: "severity_weight",
                  value: { status: "measured", value: 1 },
                  counter: { name: "severity_counter", value: 2 },
                },
              ],
            },
          },
        ],
        runRecords: [],
        absentSources: [],
      },
    });
    expect(out.length).toBeGreaterThan(0);
    const prose = out.map((p) => `${p.rationale}|${p.suggested_change.summary}`).join("|");
    expect(/sever/i.test(prose)).toBe(false);
    expect(prose).toContain("redacted-name");
    for (const p of out) expect(ProposalSchema.safeParse(p).success).toBe(true);
  });
});

// ─── review round 1 fixes (F-004 compose half / F-005 / F-011 / F-020 / F-028) ─

describe("review round 1 — ingest filters, class fields, caps, dedup", () => {
  const emptyish = {
    week: "2026-W41",
    firedAt: "2026-10-11T18:00:00.000Z",
    reflects: [],
    reflect_ok: {},
    banks: ["qds-factory-dev-meta"],
  };

  test("shape-only run records compose no skill-update (F-005)", () => {
    const out = composeProposals({
      ...emptyish,
      evidence: {
        routingLines: [],
        kpiSnapshots: [],
        runRecords: [
          { ref: "qds-20260920-120000.json", record: { shape: "review" } },
          { ref: "qds-20260921-120000.json", record: { shape: "review" } },
        ],
        absentSources: [],
      },
    });
    expect(out).toEqual([]);
  });

  test("hostile insight summaries never enter insights_cited; hostile ref names never enter prose — citations stay raw (F-004)", () => {
    const out = composeProposals({
      ...emptyish,
      reflects: [{ bankId: "qds-factory-dev-meta", insights: [{ summary: "severity drift detected in routing" }] }],
      reflect_ok: { "qds-factory-dev-meta": true },
      evidence: {
        routingLines: [],
        kpiSnapshots: [],
        runRecords: [
          { ref: "severity-drift-qds-20260920-120000.json", record: { classification: "retry-loop" } },
          { ref: "qds-20260921-120000.json", record: { classification: "retry-loop" } },
        ],
        absentSources: [],
      },
    });
    expect(out.length).toBeGreaterThan(0);
    // Prose + cited insights are severity-free...
    const proseJson = JSON.stringify(out.map((p) => ({ r: p.rationale, s: p.suggested_change.summary, i: p.insights_cited })));
    expect(/sever/i.test(proseJson)).toBe(false);
    expect(proseJson).toContain("redacted-name");
    // ...while the evidence arrays stay raw — citations must remain accurate.
    for (const p of out) expect(p.insights_cited).toEqual([]);
    const su = out.find((p) => p.kind === "skill-update")!;
    expect(su.evidence.run_record_refs).toContain("severity-drift-qds-20260920-120000.json");
  });

  test("duplicate runId across routing lines is deduped in mean and citations (F-020)", () => {
    const lines = [
      line({ runId: "qds-20260901-000001", applied_tier: "opus", score: { quality: 0.5 } }),
      line({ runId: "qds-20260901-000002", workKey: "wk-2", applied_tier: "opus", score: { quality: 0.5 } }),
      line({ runId: "qds-20260901-000003", workKey: "wk-3", applied_tier: "sonnet", score: { quality: 0.8 } }),
      line({ runId: "qds-20260901-000004", workKey: "wk-4", applied_tier: "sonnet", score: { quality: 0.8 } }),
      // replay of 000003 with a skewing score — must not move the mean or duplicate the citation
      line({ runId: "qds-20260901-000003", workKey: "wk-3", applied_tier: "sonnet", score: { quality: 0.1 } }),
    ];
    const rt = composeProposals(baseInput(evidenceWith({ routingLines: lines }))).find(
      (p) => p.kind === "router-tuning",
    )!;
    expect(rt.evidence.routing_log_refs).toEqual([
      "qds-20260901-000001",
      "qds-20260901-000002",
      "qds-20260901-000003",
      "qds-20260901-000004",
    ]);
    expect(rt.rationale).toContain("0.800"); // sonnet mean stays (0.8+0.8)/2, not (0.8+0.8+0.1)/3 = 0.567
    expect(rt.rationale).not.toContain("0.567");
  });

  test("proposals capped at MAX_PROPOSALS_PER_FIRING in emission order (F-011)", () => {
    const lines = Array.from({ length: 17 }, (_, s) => [
      line({ runId: `qds-20260901-${String(s).padStart(3, "0")}a`, workKey: `wk-${s}`, shape: `shape-${s}`, applied_tier: "opus", score: { quality: 0.5 } }),
      line({ runId: `qds-20260901-${String(s).padStart(3, "0")}b`, workKey: `wk-${s}`, shape: `shape-${s}`, applied_tier: "opus", score: { quality: 0.5 } }),
      line({ runId: `qds-20260901-${String(s).padStart(3, "0")}c`, workKey: `wk-${s}`, shape: `shape-${s}`, applied_tier: "sonnet", score: { quality: 0.8 } }),
      line({ runId: `qds-20260901-${String(s).padStart(3, "0")}d`, workKey: `wk-${s}`, shape: `shape-${s}`, applied_tier: "sonnet", score: { quality: 0.8 } }),
    ]).flat();
    expect(MAX_PROPOSALS_PER_FIRING).toBe(16);
    const out = composeProposals(baseInput(evidenceWith({ routingLines: lines })));
    expect(out).toHaveLength(16);
    expect(out.every((p) => p.kind === "router-tuning")).toBe(true);
    expect(out.map((p) => p.proposal_id.slice(-3))).toEqual(
      Array.from({ length: 16 }, (_, i) => String(i + 1).padStart(3, "0")),
    );
  });
});
