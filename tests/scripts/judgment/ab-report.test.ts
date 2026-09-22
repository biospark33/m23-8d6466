/**
 * JEV-4 — `scripts/judgment/ab-report.ts` (§3.12 A/B measurement report).
 *
 * Every rendered number is asserted against a HAND-COMPUTED value over
 * fixture corpora written to temp dirs — never the real
 * `_bmad-output/judgment/` paths. The report renders data only: no
 * threshold, no judgment, and the two §3.12 wording rules are pinned
 * (frontier cost labeled estimate, unpopulated outcome fields named
 * "not yet available" rather than an empty table).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, computeReport, latencyStats, loadScope, renderText, main } from "../../../scripts/judgment/ab-report.ts";
import type { TriageRecord } from "../../../scripts/corpus/schema.ts";

const dir: string = mkdtempSync(join(tmpdir(), "jev-abreport-"));

function corpus(name: string, lines: unknown[]): string {
  const file = join(dir, name);
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return file;
}

/** A schema-valid record; only the fields under test are overridden. */
function rec(over: Partial<TriageRecord> & { finding_id: string; arm: "frontier" | "jev" }): TriageRecord {
  return {
    finding_text: `text ${over.finding_id}`,
    diff_context_ref: `src/x.ts:L1 (${over.finding_id})`,
    label: "bug",
    disposition: "PATCH",
    labeler: over.arm === "jev" ? "jev-1.13.0-observer" : "frontier-lead",
    pr: 601,
    round: 1,
    created_at: "2026-09-22T00:00:00Z",
    ...over,
  } as TriageRecord;
}

mkdirSync(dir, { recursive: true });

// ---------------------------------------------------------------------------
// Round 1 — paired round with jev-only and frontier-only findings, null
// latency/cost, and an unparseable-probability rationale. ALL numbers below
// are hand-computed over these records.
// ---------------------------------------------------------------------------

const R1_FRONTIER = [
  rec({ finding_id: "f1", arm: "frontier", disposition: "PATCH" }), // paired, agrees
  rec({ finding_id: "f2", arm: "frontier", disposition: "DISMISS", latency_ms: 4000, cost_estimate_usd: 0.0009 }), // paired, agrees
  rec({ finding_id: "f3", arm: "frontier", disposition: "DISMISS", latency_ms: 6000 }), // paired, DISAGREES (jev says PATCH)
  rec({ finding_id: "f4", arm: "frontier", disposition: "DEFER", latency_ms: 2000, cost_estimate_usd: 0.0005 }), // frontier-only
];
const R1_JEV = [
  rec({
    finding_id: "f1",
    arm: "jev",
    disposition: "PATCH",
    rationale: "jev: is_real_defect=true; disposition=patch p=0.9",
    latency_ms: 1200,
    cost_exact_usd: 0.000084,
  }),
  rec({
    finding_id: "f2",
    arm: "jev",
    disposition: "DISMISS",
    rationale: "jev: is_real_defect=false; disposition=dismiss p=0.82",
    latency_ms: 1100,
    cost_exact_usd: 0.000076,
  }),
  rec({
    finding_id: "f3",
    arm: "jev",
    disposition: "PATCH",
    rationale: "jev: is_real_defect=false; disposition=patch p=0.44",
    latency_ms: 1300,
    cost_exact_usd: 0.000092,
  }),
  rec({
    finding_id: "f5",
    arm: "jev",
    disposition: "DISMISS",
    rationale: "jev: is_real_defect=false; disposition=dismiss p=0.7",
    latency_ms: 1400,
    cost_exact_usd: 0.00008,
  }), // jev-only
  rec({ finding_id: "f6", arm: "jev", disposition: "GATE_ACTION", rationale: "no clause in this one", latency_ms: null, cost_exact_usd: null }), // is_real_defect not recorded
];

corpus("601-r1.jsonl", [...R1_FRONTIER, ...R1_JEV]);

// Round 2 — outcome fields populated (hand-computed outcome rates).
const R2 = [
  rec({
    finding_id: "o1",
    arm: "frontier",
    disposition: "DISMISS",
    latency_ms: 5000,
    cost_estimate_usd: 0.0006,
    outcome_confirmed: true,
    outcome_source: "fix-wave",
  }), // confirmed true vs DISMISS -> disagree
  rec({
    finding_id: "o2",
    arm: "frontier",
    disposition: "DISMISS",
    latency_ms: null,
    outcome_confirmed: false,
    outcome_source: "re-review",
  }), // confirmed false vs DISMISS -> agree
  rec({
    finding_id: "o1",
    arm: "jev",
    disposition: "PATCH",
    rationale: "jev: is_real_defect=true; disposition=patch p=0.6",
    latency_ms: 900,
    cost_exact_usd: 0.00005,
    outcome_confirmed: true,
    outcome_source: "fix-wave",
  }), // confirmed true vs PATCH -> agree
  rec({
    finding_id: "o2",
    arm: "jev",
    disposition: "DISMISS",
    rationale: "jev: is_real_defect=false; disposition=dismiss p=0.95",
    latency_ms: 800,
    cost_exact_usd: 0.000045,
    outcome_confirmed: false,
    outcome_source: "human-override",
  }), // confirmed false vs DISMISS -> agree
];

describe("parseArgs", () => {
  test("--pr/--round pair", () => {
    expect(parseArgs(["--pr", "601", "--round", "1"])).toMatchObject({ pr: 601, round: 1 });
  });
  test("--pr without --round is refused by name", () => {
    expect(() => parseArgs(["--pr", "601"])).toThrow(/--round/);
  });
  test("--all with --pr is refused (mutually exclusive scopes)", () => {
    expect(() => parseArgs(["--all", "--pr", "601", "--round", "1"])).toThrow(/--all/);
  });
  test("--all and --json parse as boolean flags (no value consumed)", () => {
    expect(parseArgs(["--all", "--json", "--corpus-dir", "/x"])).toMatchObject({ all: true, json: true, corpusDir: "/x" });
  });
});

describe("latencyStats", () => {
  test("hand-computed over the jev round-1 latencies [1200,1100,1300,1400,null]", () => {
    const jev = loadScope(dir, 601, 1).jev;
    expect(latencyStats(jev)).toEqual({ n: 4, nulls: 1, mean: 1250, median: 1250, min: 1100, max: 1400 });
  });
  test("frontier latencies [null,4000,6000,2000] — nulls counted, never imputed", () => {
    const frontier = loadScope(dir, 601, 1).frontier;
    expect(latencyStats(frontier)).toEqual({ n: 3, nulls: 1, mean: 4000, median: 4000, min: 2000, max: 6000 });
  });
  test("all-null latency reports n=0 and null stats", () => {
    expect(latencyStats([rec({ finding_id: "z", arm: "jev" })])).toEqual({
      n: 0,
      nulls: 1,
      mean: null,
      median: null,
      min: null,
      max: null,
    });
  });
});

describe("computeReport — paired round (601 r1)", () => {
  const { frontier, jev } = loadScope(dir, 601, 1);
  const report = computeReport(frontier, jev);

  test("PERFORMANCE: disposition agreement is 2/3 (f1,f2 agree; f3 DISMISS vs PATCH)", () => {
    expect(report.paired).toEqual({ paired: 3, agreed: 2, rate: 2 / 3 });
  });
  test("PERFORMANCE: is_real_defect x disposition cross-tab from rationale clauses", () => {
    // true: PATCH 1 (f1) · false: DISMISS 2 (f2,f5) + PATCH 1 (f3) · f6 not-recorded GATE_ACTION
    expect(report.crosstab).toEqual([
      { is_real_defect: "true", PATCH: 1, total: 1 },
      { is_real_defect: "false", DISMISS: 2, PATCH: 1, total: 3 },
      { is_real_defect: "not-recorded", GATE_ACTION: 1, total: 1 },
    ]);
  });
  test("COST: jev exact 4/5 records sum 0.000332; frontier estimate 2/4 sum 0.0014 — bases kept distinct", () => {
    expect(report.cost.jev).toEqual({ basis: "exact", n: 4, nulls: 1, totalUsd: 0.000332 });
    expect(report.cost.frontier).toEqual({ basis: "estimate", n: 2, nulls: 2, totalUsd: 0.0014 });
  });
  test("OUTCOME: r1 has no outcome fields — unavailable, no per-arm table", () => {
    expect(report.outcome).toEqual({ available: false, perArm: [] });
  });
  test("render: names the unpopulated outcome fields, never an empty table", () => {
    const text = renderText(report, "pr 601 round 1");
    expect(text).toContain("not yet available — outcome fields unpopulated");
    expect(text).toContain("2/3 (66.7%)");
    expect(text).toContain("basis: exact (from usage)");
    expect(text).toContain("basis: estimate (from session duration model — never metered)");
  });
});

describe("computeReport — outcome-populated round (601 r2)", () => {
  corpus("601-r2.jsonl", R2);
  const { frontier, jev } = loadScope(dir, 601, 2);
  const report = computeReport(frontier, jev);

  test("OUTCOME: frontier 1/2 agree (o1 true vs DISMISS disagrees; o2 false vs DISMISS agrees)", () => {
    const f = report.outcome.perArm.find((a) => a.arm === "frontier");
    expect(f).toEqual({
      arm: "frontier",
      confirmed: 2,
      confirmedTrue: 1,
      confirmedFalse: 1,
      agreed: 1,
      rate: 0.5,
      sources: { "fix-wave": 1, "re-review": 1 },
    });
  });
  test("OUTCOME: jev 2/2 agree", () => {
    const j = report.outcome.perArm.find((a) => a.arm === "jev");
    expect(j).toEqual({
      arm: "jev",
      confirmed: 2,
      confirmedTrue: 1,
      confirmedFalse: 1,
      agreed: 2,
      rate: 1,
      sources: { "fix-wave": 1, "human-override": 1 },
    });
  });
  test("render: per-arm rates and sources appear", () => {
    const text = renderText(report, "pr 601 round 2");
    expect(text).toContain("1/2 (50.0%)");
    expect(text).toContain("2/2 (100.0%)");
    expect(text).toContain("fix-wave=1");
  });
});

describe("unpaired arms", () => {
  test("jev-only and frontier-only findings are excluded from pairing but kept in arm stats", () => {
    const { frontier, jev } = loadScope(dir, 601, 1);
    const report = computeReport(frontier, jev);
    expect(report.paired.paired).toBe(3); // f4 frontier-only, f5/f6 jev-only are not pairs
    expect(report.speed.jev.n).toBe(4); // f5 kept
    expect(report.speed.frontier.n).toBe(3); // f4 kept
    expect(report.cost.jev.totalUsd).toBeCloseTo(0.000332, 10);
    expect(report.cost.frontier.totalUsd).toBeCloseTo(0.0014, 10);
  });
});

describe("malformed corpus", () => {
  test("a bad line exits 2 naming file and line", async () => {
    // Own temp dir — --all must never see a malformed file.
    const bad = mkdtempSync(join(tmpdir(), "jev-abreport-bad-"));
    writeFileSync(
      join(bad, "602-r1.jsonl"),
      `${[JSON.stringify(rec({ finding_id: "g1", arm: "frontier" })), JSON.stringify({ finding_id: "g2" })].join("\n")}\n`,
    );
    let code: number | undefined;
    const err: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s: unknown) => {
      err.push(String(s));
      return true;
    };
    try {
      code = await main(["--pr", "602", "--round", "1", "--corpus-dir", bad]);
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
    expect(code).toBe(2);
    expect(err.join("")).toContain("602-r1.jsonl");
    expect(err.join("")).toContain("line 2");
  });
});

describe("--all mode", () => {
  test("iterates every corpus file, joining on (pr, round, finding_id)", () => {
    corpus("601-r1.jsonl", [...R1_FRONTIER, ...R1_JEV]);
    const scope = loadScope(dir, undefined, undefined);
    expect(scope.files.sort()).toEqual(["601-r1.jsonl", "601-r2.jsonl"]); // the malformed round lives in its own dir
    const report = computeReport(scope.frontier, scope.jev);
    // r1 pairs f1,f2,f3 + r2 pairs o1,o2 = 5 paired across files; joined on the
    // composite key so the same finding_id in different rounds does not collide.
    expect(report.paired.paired).toBe(5);
    expect(report.outcome.available).toBe(true); // r2's outcome fields are in scope
  });
});

describe("--json", () => {
  test("renders machine-readable JSON of the same report", () => {
    const { frontier, jev } = loadScope(dir, 601, 2);
    const json = JSON.parse(JSON.stringify(computeReport(frontier, jev)));
    expect(json.cost.jev.basis).toBe("exact");
    expect(json.outcome.available).toBe(true);
    expect(json.outcome.perArm).toHaveLength(2);
  });
});
