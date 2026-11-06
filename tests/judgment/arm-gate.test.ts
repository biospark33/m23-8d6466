/**
 * J2 leaf-1.1.1 — `src/judgment/arm-gate.ts` plus the operator CLIs
 * `scripts/judgment/arm-thresholds.ts` (dry-run verdict / `--arm` / `--unarm`)
 * and `scripts/judgment/confirm-outcome.ts` (AC1/AC2/AC3/AC5).
 *
 * Every AC1/AC2/AC3/AC5 negative control from the story is a named failing
 * case below; the positive controls pin the Wilson derivation arithmetic
 * (LB(n,1)=n/(n+z²) ⇒ n≥35; LB(53,52/53)≈0.9006), the eligible-fixture
 * arithmetic (60 agreeing clusters × 4 findings = 240 confirmed records), the
 * hash-chain walk, and the outcome join / idempotence / conflict semantics.
 *
 * The fence binds src/judgment/, not tests/: this suite imports ab-report's
 * `outcomeAgrees` directly to pin arm-gate's local `agrees()` byte-for-byte
 * (the src/ module itself may not import scripts/).
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { outcomeAgrees } from "../../scripts/judgment/ab-report.ts";
import { main as armThresholdsMain, loadJevCorpusRecords } from "../../scripts/judgment/arm-thresholds.ts";
import { DISPOSITIONS, OutcomeRecordSchema, recordKey } from "../../scripts/corpus/schema.ts";
import {
  MIN_CONFIRMED_CLUSTERS,
  MIN_OUTCOME_CONFIRMED_JEV_RECORDS,
  MIN_ROUTE_CONFIDENCE,
  MIN_WILSON_LOWER_AGREEMENT,
  WILSON_Z,
  agrees,
  armStateEntryDigest,
  countedCorpusDigest,
  evaluateGate,
  keyOf,
  verifyArmStateLog,
  wilsonLowerBound,
  type ArmStateEntry,
  type GateCorpusRecord,
  type GateOutcomeEntry,
} from "../../src/judgment/arm-gate.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LABELER = "jev-1";
const REPO_ROOT = join(import.meta.dir, "..", "..");
const ARM_GATE_SRC = join(REPO_ROOT, "src", "judgment", "arm-gate.ts");

function outEntry(
  pr: number,
  round: number,
  finding_id: string,
  outcome_confirmed: boolean,
  opts: { mode?: "live" | "mock"; source?: string } = {},
): GateOutcomeEntry {
  return {
    pr,
    round,
    finding_id,
    labeler: LABELER,
    outcome_confirmed,
    outcome_source: opts.source ?? "operator-merge-evidence",
    answer_mode: opts.mode ?? "live",
    confirmed_at: "2026-11-04T00:00:00Z",
  };
}

function recEntry(pr: number, round: number, finding_id: string, disposition: string): GateCorpusRecord {
  return { pr, round, finding_id, labeler: LABELER, disposition };
}

/** 60 distinct (pr, round) clusters — pr 900..905 × rounds 1..10. */
function eligibleClusters(): { pr: number; round: number }[] {
  const out: { pr: number; round: number }[] = [];
  for (let i = 0; i < 60; i++) out.push({ pr: 900 + Math.floor(i / 10), round: (i % 10) + 1 });
  return out;
}

/** The eligible fixture: 60 agreeing clusters × 4 findings = 240 confirmed records. */
function eligibleFixture(): { outcomes: GateOutcomeEntry[]; corpus: GateCorpusRecord[] } {
  const outcomes: GateOutcomeEntry[] = [];
  const corpus: GateCorpusRecord[] = [];
  for (const c of eligibleClusters()) {
    for (const [fid, oc, disp] of [
      ["F1", true, "PATCH"],
      ["F2", true, "PATCH"],
      ["F3", false, "DISMISS"],
      ["F4", false, "DISMISS"],
    ] as const) {
      outcomes.push(outEntry(c.pr, c.round, fid, oc));
      corpus.push(recEntry(c.pr, c.round, fid, disp));
    }
  }
  return { outcomes, corpus };
}

/**
 * The cluster-unit fixture: 20 clusters × 10 findings = 200 confirmed records
 * with ONE dissenting finding (cluster 0's F1: confirmed-true but DISMISSed),
 * so exactly one cluster disagrees → 19/20 agreeing clusters, ci_lower ≈ 0.764.
 */
function clusterUnitFixture(): { outcomes: GateOutcomeEntry[]; corpus: GateCorpusRecord[] } {
  const outcomes: GateOutcomeEntry[] = [];
  const corpus: GateCorpusRecord[] = [];
  for (let i = 0; i < 20; i++) {
    const pr = 910 + Math.floor(i / 10);
    const round = (i % 10) + 1;
    for (let f = 1; f <= 10; f++) {
      const confirmedTrue = f <= 5;
      outcomes.push(outEntry(pr, round, `F${f}`, confirmedTrue));
      const disposition = i === 0 && f === 1 ? "DISMISS" : confirmedTrue ? "PATCH" : "DISMISS";
      corpus.push(recEntry(pr, round, `F${f}`, disposition));
    }
  }
  return { outcomes, corpus };
}

/** A full arm="jev" TriageRecord line for the corpus dir (schema-valid, joined by recordKey). */
function triageLine(r: GateCorpusRecord): string {
  return JSON.stringify({
    finding_id: r.finding_id,
    finding_text: `fixture finding ${r.finding_id}`,
    diff_context_ref: `src/fixture.ts@${r.finding_id}`,
    label: "LOW",
    disposition: r.disposition,
    rationale: `jev: is_real_defect=0.90; disposition=${r.disposition.toLowerCase()} p=0.95`,
    labeler: r.labeler,
    pr: r.pr,
    round: r.round,
    created_at: "2026-11-04T00:00:00Z",
    arm: "jev",
    latency_ms: 100,
    cost_exact_usd: 0.001,
    cost_estimate_usd: null,
    outcome_confirmed: null,
    outcome_source: null,
  });
}

/** Materialize the eligible fixture as a real corpus dir ({pr}-r{round}.jsonl + outcomes.jsonl). */
function writeEligibleCorpusDir(dir: string): void {
  const { outcomes, corpus } = eligibleFixture();
  const byCluster = new Map<string, GateCorpusRecord[]>();
  for (const r of corpus) byCluster.set(`${r.pr}-r${r.round}`, [...(byCluster.get(`${r.pr}-r${r.round}`) ?? []), r]);
  for (const [name, records] of byCluster) writeFileSync(join(dir, `${name}.jsonl`), `${records.map(triageLine).join("\n")}\n`);
  writeFileSync(join(dir, "outcomes.jsonl"), `${outcomes.map((o) => JSON.stringify(o)).join("\n")}\n`);
}

function tmpDir(prefix: string): string {
  return mkdtempSync(join("/tmp", prefix));
}

// ---------------------------------------------------------------------------
// Chain helpers (an independent digest re-derivation — the verifier is checked
// against a second implementation of the chain discipline, not against itself)
// ---------------------------------------------------------------------------

const THRESHOLDS_EVIDENCE = {
  MIN_OUTCOME_CONFIRMED_JEV_RECORDS: 200,
  MIN_CONFIRMED_CLUSTERS: 20,
  MIN_WILSON_LOWER_AGREEMENT: 0.9,
  WILSON_Z: 1.959964,
  MIN_ROUTE_CONFIDENCE: 0.9,
};

function sha(e: object): string {
  return createHash("sha256").update(JSON.stringify(e)).digest("hex");
}

function mkEntry(
  seq: number,
  prev_digest: string | null,
  from: "recording-only" | "armed",
  to: "recording-only" | "armed",
): ArmStateEntry {
  return {
    seq,
    at: `2026-11-04T00:00:${String(seq).padStart(2, "0")}Z`,
    from,
    to,
    sign_off: `steve 2026-11-04 #${seq}`,
    evidence: {
      confirmed: 240,
      agreed: 60,
      rate: 1,
      ci_lower: 0.9399,
      thresholds: THRESHOLDS_EVIDENCE,
      corpus_digest: "ab".repeat(32),
    },
    prev_digest,
  };
}

/** A well-formed alternating chain: recording-only → armed → recording-only → … */
function chainedEntries(n: number): ArmStateEntry[] {
  const entries: ArmStateEntry[] = [];
  let prev: string | null = null;
  for (let s = 1; s <= n; s++) {
    const from = entries.length === 0 ? "recording-only" : entries[entries.length - 1]!.to;
    const to = from === "recording-only" ? "armed" : "recording-only";
    const e = mkEntry(s, prev, from, to);
    entries.push(e);
    prev = sha(e);
  }
  return entries;
}

function logLines(entries: ArmStateEntry[]): string[] {
  return entries.map((e) => JSON.stringify(e));
}

// ---------------------------------------------------------------------------
// AC2 — thresholds are code literals; Wilson over clusters
// ---------------------------------------------------------------------------

describe("AC2 threshold constants", () => {
  test("the five pinned values land as named module constants", () => {
    expect(MIN_OUTCOME_CONFIRMED_JEV_RECORDS).toBe(200);
    expect(MIN_CONFIRMED_CLUSTERS).toBe(20);
    expect(MIN_WILSON_LOWER_AGREEMENT).toBe(0.9);
    expect(WILSON_Z).toBe(1.959964);
    expect(MIN_ROUTE_CONFIDENCE).toBe(0.9);
  });

  test("thresholds are code literals: no env or config read can lower any of the five (AC2 negative control)", () => {
    // Structurally impossible, not merely untried: the module never reads the
    // environment or any config, and the constants are literal exports.
    const src = readFileSync(ARM_GATE_SRC, "utf8");
    expect(src).not.toMatch(/process\.env/);
    expect(src).toMatch(/export const MIN_OUTCOME_CONFIRMED_JEV_RECORDS = 200;/);
    expect(src).toMatch(/export const MIN_CONFIRMED_CLUSTERS = 20;/);
    expect(src).toMatch(/export const MIN_WILSON_LOWER_AGREEMENT = 0\.90;/);
    expect(src).toMatch(/export const WILSON_Z = 1\.959964;/);
    expect(src).toMatch(/export const MIN_ROUTE_CONFIDENCE = 0\.90;/);
    // And the proof by attempt: poisoning plausible env names changes nothing.
    // The cluster-unit fixture (19/20 agreeing clusters) is the decisive case —
    // ONLY the Wilson floor blocks eligibility there.
    const { outcomes, corpus } = clusterUnitFixture();
    const poisoned: Record<string, string> = {
      MIN_OUTCOME_CONFIRMED_JEV_RECORDS: "1",
      MIN_CONFIRMED_CLUSTERS: "0",
      MIN_WILSON_LOWER_AGREEMENT: "0.1",
      WILSON_Z: "0.1",
      MIN_ROUTE_CONFIDENCE: "0.1",
      QDS_MIN_WILSON_LOWER_AGREEMENT: "0.1",
      QDS_JUDGMENT_MIN_CONFIRMED_CLUSTERS: "0",
    };
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(poisoned)) {
      saved[k] = process.env[k];
      process.env[k] = poisoned[k]!;
    }
    try {
      // 19/20 agreeing clusters: cluster-level ci_lower ≈ 0.764 — eligible only
      // if a threshold gave way. It must stay not-eligible.
      expect(evaluateGate(outcomes, corpus).verdict).toBe("not-eligible");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("wilsonLowerBound derivations: n≥35 perfect, n≥53 with one dissent (AC2 checkable arithmetic)", () => {
    // LB(n, n) = n/(n+z²): 35 is the first n with LB ≥ 0.90 at perfect agreement.
    expect(wilsonLowerBound(35, 35, WILSON_Z)).toBeGreaterThanOrEqual(0.9);
    expect(wilsonLowerBound(34, 34, WILSON_Z)).toBeLessThan(0.9);
    expect(wilsonLowerBound(35, 35, WILSON_Z)).toBeCloseTo(35 / (35 + WILSON_Z ** 2), 10);
    // 53 is the exact minimum with one dissenting cluster: LB(53, 52/53) ≈ 0.9006.
    expect(wilsonLowerBound(52, 53, WILSON_Z)).toBeCloseTo(0.9006, 3);
    expect(wilsonLowerBound(52, 53, WILSON_Z)).toBeGreaterThanOrEqual(0.9);
    expect(wilsonLowerBound(51, 52, WILSON_Z)).toBeLessThan(0.9);
  });

  test("wilsonLowerBound throws on invalid inputs — never a silent NaN (F17)", () => {
    expect(() => wilsonLowerBound(1, 0, WILSON_Z)).toThrow(); // n=0
    expect(() => wilsonLowerBound(3, 2, WILSON_Z)).toThrow(); // agreed>n
    expect(() => wilsonLowerBound(-1, 10, WILSON_Z)).toThrow(); // agreed<0
    // z must be finite and > 0 (R2-J): z=0 sells the point estimate as the
    // lower bound; z<0 bounds above p̂; NaN lies silently.
    expect(() => wilsonLowerBound(1, 10, 0)).toThrow();
    expect(() => wilsonLowerBound(1, 10, -1)).toThrow();
    expect(() => wilsonLowerBound(1, 10, Number.NaN)).toThrow();
  });

  test("agrees() matches ab-report outcomeAgrees across all 6 dispositions x both booleans", () => {
    for (const d of DISPOSITIONS) {
      for (const oc of [true, false]) {
        expect(agrees(d, oc)).toBe(outcomeAgrees(d, oc));
      }
    }
  });
});

describe("AC2 cluster-unit interval", () => {
  test("Wilson interval is over (pr, round) clusters, never raw finding records (AC2 negative control)", () => {
    // 20 clusters × 10 findings = 200 confirmed records; ONE dissenting
    // finding poisons its whole cluster → 19/20 agreeing clusters. At record
    // level this would be 199/200 (LB ≈ 0.970, comfortably eligible on the
    // CI criterion) — correlated findings must never be fed as independent
    // Bernoulli trials.
    const { outcomes, corpus } = clusterUnitFixture();
    const v = evaluateGate(outcomes, corpus);
    expect(v.milestones.confirmed).toBe(200);
    expect(v.milestones.clusters).toBe(20);
    expect(v.milestones.agreed).toBe(19);
    expect(v.milestones.rate).toBeCloseTo(19 / 20, 10);
    expect(v.milestones.ci_lower).toBeCloseTo(wilsonLowerBound(19, 20, WILSON_Z), 10);
    expect(v.milestones.ci_lower as number).toBeLessThan(0.9);
    // What the forbidden record-level computation would have yielded.
    expect(wilsonLowerBound(199, 200, WILSON_Z)).toBeGreaterThan(0.9);
    expect(v.verdict).toBe("not-eligible");
    expect(v.gaps.some((g) => g.startsWith("ci_lower="))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC1 / AC5 — gate evaluation semantics
// ---------------------------------------------------------------------------

describe("evaluateGate", () => {
  test("absent outcomes: confirmed=0, rate/ci_lower 'n/a', never fabricated (AC1)", () => {
    const v = evaluateGate([], [recEntry(1, 1, "F1", "PATCH")]);
    expect(v.milestones.confirmed).toBe(0);
    expect(v.milestones.rate).toBe("n/a");
    expect(v.milestones.ci_lower).toBe("n/a");
    expect(v.milestones.ci_floor).toBe(0.9);
    expect(v.verdict).toBe("not-eligible");
    expect(v.gaps).toContain("outcome_confirmed=0/200");
    expect(v.gaps).toContain("ci_lower=n/a");
    expect(v.sources).toEqual({});
    expect(v.modes).toEqual({ live: 0, mock: 0 });
  });

  test("eligible fixture: 240 confirmed over 60 agreeing clusters passes all three milestones", () => {
    const { outcomes, corpus } = eligibleFixture();
    const v = evaluateGate(outcomes, corpus);
    expect(v.milestones.confirmed).toBe(240);
    expect(v.milestones.clusters).toBe(60);
    expect(v.milestones.agreed).toBe(60);
    expect(v.milestones.rate).toBe(1);
    expect(v.milestones.ci_lower).toBeCloseTo(wilsonLowerBound(60, 60, WILSON_Z), 10);
    expect(v.milestones.ci_lower as number).toBeGreaterThanOrEqual(0.9);
    expect(v.verdict).toBe("eligible");
    expect(v.gaps).toEqual([]);
    expect(v.sources).toEqual({ "operator-merge-evidence": 240 });
    expect(v.modes).toEqual({ live: 240, mock: 0 });
  });

  test("below the record floor names outcome_confirmed=<n>/200 (AC1 negative control, volume)", () => {
    const { outcomes, corpus } = eligibleFixture();
    // Drop 41 outcome entries → 199 confirmed; clusters still 60, all agreeing.
    const v = evaluateGate(outcomes.slice(41), corpus);
    expect(v.milestones.confirmed).toBe(199);
    expect(v.verdict).toBe("not-eligible");
    expect(v.gaps).toContain("outcome_confirmed=199/200");
  });

  test("mock-attested outcomes never enter the counted population (AC5 negative control)", () => {
    const { outcomes, corpus } = eligibleFixture();
    const mocked = outcomes.map((o) => ({ ...o, answer_mode: "mock" as const }));
    const v = evaluateGate(mocked, corpus);
    expect(v.milestones.confirmed).toBe(0);
    expect(v.milestones.rate).toBe("n/a");
    expect(v.modes).toEqual({ live: 0, mock: 240 });
    expect(v.verdict).toBe("not-eligible");
  });

  test("unjoined outcomes count nothing — the corpus join is enforced (AC5)", () => {
    const { outcomes } = eligibleFixture();
    const v = evaluateGate(outcomes, []);
    expect(v.milestones.confirmed).toBe(0);
    expect(v.verdict).toBe("not-eligible");
  });

  test("duplicate identical outcome entries resolve to one counted record per recordKey (AC5)", () => {
    const { outcomes, corpus } = eligibleFixture();
    const v = evaluateGate([...outcomes, ...outcomes], corpus);
    expect(v.milestones.confirmed).toBe(240);
    expect(v.modes).toEqual({ live: 240, mock: 0 });
  });

  test("conflicting duplicate entries are unresolved — never counted as agreement (AC5)", () => {
    const { outcomes, corpus } = eligibleFixture();
    const first = outcomes[0]!;
    const v = evaluateGate([...outcomes, { ...first, outcome_confirmed: !first.outcome_confirmed }], corpus);
    expect(v.milestones.confirmed).toBe(239);
    expect(v.modes).toEqual({ live: 239, mock: 0 });
  });

  test("sources distribution prints on every verdict; modes split over ALL resolved entries (AC5)", () => {
    const { outcomes, corpus } = eligibleFixture();
    const mixed = outcomes.map((o, i) => (i < 100 ? { ...o, outcome_source: "operator-review" } : o));
    // Plus mock-attested entries on DISTINCT keys: visible in modes, never counted.
    const mockExtras = eligibleClusters().slice(0, 5).map((c) => outEntry(c.pr, c.round, "F9", true, { mode: "mock" }));
    const v = evaluateGate([...mixed, ...mockExtras], corpus);
    expect(v.sources).toEqual({ "operator-merge-evidence": 140, "operator-review": 100 });
    expect(v.modes).toEqual({ live: 240, mock: 5 });
  });

  test("duplicate corpus rows (hand-merged shards) dedupe by recordKey — verdict and sources identical to the deduped run (F7)", () => {
    const { outcomes, corpus } = eligibleFixture();
    const base = evaluateGate(outcomes, corpus);
    // Every corpus row duplicated: confirmed dedupes, so cluster totals and
    // source counts must not inflate behind the same confirmed number.
    const dup = evaluateGate(outcomes, [...corpus, ...corpus]);
    expect(dup.milestones.confirmed).toBe(base.milestones.confirmed);
    expect(dup.milestones.clusters).toBe(base.milestones.clusters);
    expect(dup.milestones.rate).toBe(base.milestones.rate);
    expect(dup.sources).toEqual(base.sources);
  });

  test("conflicting outcome entries surface unresolved_outcome_keys=N — the counted population never silently shrinks (F11)", () => {
    const { outcomes, corpus } = eligibleFixture();
    const first = outcomes[0]!;
    const v = evaluateGate([...outcomes, { ...first, outcome_confirmed: !first.outcome_confirmed }], corpus);
    expect(v.milestones.confirmed).toBe(239); // the conflicting key drops out — and that is now VISIBLE
    expect(v.gaps).toContain("unresolved_outcome_keys=1");
    expect(v.verdict).toBe("not-eligible");
  });
});

// ---------------------------------------------------------------------------
// countedCorpusDigest determinism (F9/F16)
// ---------------------------------------------------------------------------

describe("countedCorpusDigest determinism", () => {
  test("shuffled outcomes + reversed corpus records give the same digest (F9)", () => {
    const { outcomes, corpus } = eligibleFixture();
    expect(countedCorpusDigest([...outcomes].reverse(), [...corpus].reverse())).toBe(countedCorpusDigest(outcomes, corpus));
  });

  test("the same entries JSON-parsed with reordered keys give the same digest (F16)", () => {
    const { outcomes, corpus } = eligibleFixture();
    const reordered: GateOutcomeEntry[] = outcomes.map((o) => {
      const obj: Record<string, unknown> = {};
      for (const k of Object.keys(o).reverse()) obj[k] = (o as unknown as Record<string, unknown>)[k];
      return obj as unknown as GateOutcomeEntry;
    });
    expect(countedCorpusDigest(reordered, corpus)).toBe(countedCorpusDigest(outcomes, corpus));
  });

  test("corpus side is witnessed: disposition changes flip the digest; reordered corpus keys do not (R2-E)", () => {
    const { outcomes, corpus } = eligibleFixture();
    const base = countedCorpusDigest(outcomes, corpus);
    // Same keys, same join — only one disposition differs: the digest must
    // move, or two corpora disagreeing on every judgment would share it.
    const flipped = corpus.map((r, i) => (i === 0 ? { ...r, disposition: r.disposition === "PATCH" ? "DISMISS" : "PATCH" } : r));
    expect(countedCorpusDigest(outcomes, flipped)).not.toBe(base);
    // Cosmetic key reorder on the corpus rows: identical digest (the corpus
    // side is serialized in its own fixed literal key order).
    const reorderedCorpus = corpus.map((r) => {
      const obj: Record<string, unknown> = {};
      for (const k of Object.keys(r).reverse()) obj[k] = (r as unknown as Record<string, unknown>)[k];
      return obj as unknown as GateCorpusRecord;
    });
    expect(countedCorpusDigest(outcomes, reorderedCorpus)).toBe(base);
  });
});

// ---------------------------------------------------------------------------
// AC3 — the chain
// ---------------------------------------------------------------------------

describe("verifyArmStateLog", () => {
  test("a well-formed chain verifies; head is the current state; headDigest recomputes", () => {
    const entries = chainedEntries(3);
    const r = verifyArmStateLog(logLines(entries));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.entries).toHaveLength(3);
    expect(r.head.to).toBe("armed");
    expect(r.head.seq).toBe(3);
    expect(r.headDigest).toBe(sha(entries[2]!));
    expect(r.headDigest).toBe(armStateEntryDigest(entries[2]!));
  });

  test("empty/absent log is recording-only, not a chain (fail-closed)", () => {
    const r = verifyArmStateLog([]);
    expect(r.ok).toBe(false);
  });

  test("genesis prev_digest must be null", () => {
    const entries = chainedEntries(2);
    const forged = JSON.parse(JSON.stringify(entries[0]!)) as ArmStateEntry;
    forged.prev_digest = "00".repeat(32);
    const r = verifyArmStateLog([JSON.stringify(forged), logLines(entries).slice(1)[0]!]);
    expect(r.ok).toBe(false);
  });

  test("tamper: truncated (torn) log refuses (AC3 negative control)", () => {
    const lines = logLines(chainedEntries(3));
    lines[2] = lines[2]!.slice(0, 40); // torn write — half a JSON line
    expect(verifyArmStateLog(lines).ok).toBe(false);
  });

  test("tamper: deleted middle entry refuses — seq walk breaks (AC3 negative control)", () => {
    const lines = logLines(chainedEntries(3));
    lines.splice(1, 1);
    const r = verifyArmStateLog(lines);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toMatch(/seq/);
  });

  test("tamper: spliced/edited entry refuses — next prev_digest mismatches (AC3 negative control)", () => {
    const entries = chainedEntries(3);
    const edited = JSON.parse(JSON.stringify(entries[1]!)) as ArmStateEntry;
    edited.sign_off = "attacker 2026-11-04";
    const lines = [JSON.stringify(entries[0]!), JSON.stringify(edited), JSON.stringify(entries[2]!)];
    const r = verifyArmStateLog(lines);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toMatch(/prev_digest|digest/);
  });

  test("tamper: out-of-order seq refuses (AC3 negative control)", () => {
    const lines = logLines(chainedEntries(3));
    const swapped = [lines[1]!, lines[0]!, lines[2]!];
    expect(verifyArmStateLog(swapped).ok).toBe(false);
  });

  test("from/to continuity is checked — a spliced entry with the wrong from-state refuses", () => {
    // Genesis is the only legal first flip (recording-only→armed — from must
    // differ from to and start recording-only), so entry 2 must continue
    // "armed"; this splice carries a correct prev_digest and still refuses.
    const genesis = mkEntry(1, null, "recording-only", "armed");
    const spliced = mkEntry(2, sha(genesis), "recording-only", "armed");
    const r = verifyArmStateLog([JSON.stringify(genesis), JSON.stringify(spliced)]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toMatch(/continue/);
  });

  test("genesis from must be recording-only — an armed genesis refuses (F1)", () => {
    const forged = mkEntry(1, null, "armed", "recording-only");
    const r = verifyArmStateLog([JSON.stringify(forged)]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toMatch(/genesis/);
  });

  test("no-op flips (from===to) refuse (F1)", () => {
    const e1 = mkEntry(1, null, "recording-only", "armed");
    const noop = mkEntry(2, sha(e1), "armed", "armed");
    const r = verifyArmStateLog([JSON.stringify(e1), JSON.stringify(noop)]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toMatch(/no-op/);
  });

  test("missing or non-ISO at refuses naming at (F1)", () => {
    for (const bad of [undefined, "yesterday", "2026-11-04", "2026-02-30T00:00:00Z"] as const) {
      const base: Record<string, unknown> = { ...mkEntry(1, null, "recording-only", "armed") };
      const { at, ...rest } = base;
      const entry: Record<string, unknown> = bad === undefined ? { ...rest } : { ...rest, at: bad };
      const r = verifyArmStateLog([JSON.stringify(entry)]);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error(`at=${String(bad)} verified — must refuse`);
      expect(r.reason).toMatch(/\bat\b/);
    }
  });

  test("garbled evidence refuses naming the problem (F1)", () => {
    const good = mkEntry(1, null, "recording-only", "armed");
    const thNoZ: Record<string, unknown> = { ...THRESHOLDS_EVIDENCE };
    const { WILSON_Z: _omittedZ, ...thWithoutZ } = thNoZ;
    const cases: [string, unknown][] = [
      ["evidence absent", undefined],
      ["evidence a string", "eligible!"],
      ["thresholds missing WILSON_Z", { ...good.evidence, thresholds: thWithoutZ }],
      ["non-number threshold", { ...good.evidence, thresholds: { ...THRESHOLDS_EVIDENCE, WILSON_Z: "1.96" } }],
      ["short corpus_digest", { ...good.evidence, corpus_digest: "ab" }],
    ];
    for (const [label, evidence] of cases) {
      const entry: Record<string, unknown> = { ...good, evidence };
      const r = verifyArmStateLog([JSON.stringify(entry)]);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error(`case "${label}" verified — must refuse`);
      expect(r.reason).toContain("evidence");
    }
  });

  test("out-of-range evidence refuses naming the field — shape alone is not enough (R2-I)", () => {
    const good = mkEntry(1, null, "recording-only", "armed");
    const cases: [string, unknown][] = [
      ["confirmed non-integer", { ...good.evidence, confirmed: 2.5 }],
      ["confirmed negative", { ...good.evidence, confirmed: -3 }],
      ["agreed non-integer", { ...good.evidence, agreed: 60.5 }],
      ["agreed above confirmed", { ...good.evidence, confirmed: 10, agreed: 11 }],
      ["rate above 1", { ...good.evidence, rate: 5 }],
      ["rate below 0", { ...good.evidence, rate: -0.1 }],
      ["ci_lower above 1", { ...good.evidence, ci_lower: 17 }],
      ["ci_lower below 0", { ...good.evidence, ci_lower: -1 }],
      ["threshold zero", { ...good.evidence, thresholds: { ...THRESHOLDS_EVIDENCE, WILSON_Z: 0 } }],
      ["threshold negative", { ...good.evidence, thresholds: { ...THRESHOLDS_EVIDENCE, MIN_ROUTE_CONFIDENCE: -0.9 } }],
    ];
    for (const [label, evidence] of cases) {
      const entry: Record<string, unknown> = { ...good, evidence };
      const r = verifyArmStateLog([JSON.stringify(entry)]);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error(`case "${label}" verified — must refuse`);
    }
  });

  test("whitespace-only sign_off refuses naming sign_off — as weak as the CLI's own trim gate is forbidden (R3-6)", () => {
    for (const bad of ["", " ", "  \t "]) {
      const entry: Record<string, unknown> = { ...mkEntry(1, null, "recording-only", "armed"), sign_off: bad };
      const r = verifyArmStateLog([JSON.stringify(entry)]);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error(`sign_off ${JSON.stringify(bad)} verified — must refuse`);
      expect(r.reason).toMatch(/sign_off/);
    }
  });

  test("an entry with an extra top-level field refuses — the key set is exact (R2-K)", () => {
    const good = mkEntry(1, null, "recording-only", "armed");
    const entry: Record<string, unknown> = { ...good, note: "a future writer added me" };
    const r = verifyArmStateLog([JSON.stringify(entry)]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("extra field verified — must refuse");
    expect(r.reason).toContain("note");
  });
});

// ---------------------------------------------------------------------------
// CLI — arm-thresholds (subprocess: exit codes and stderr are the contract)
// ---------------------------------------------------------------------------

function runArm(args: string[], env: Record<string, string | undefined> = {}) {
  const { QDS_JUDGMENT_ARM_CONFIRMED: _dropped, ...base } = process.env;
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...base, ...env })) if (v !== undefined) merged[k] = v;
  return Bun.spawnSync({
    cmd: ["bun", join("scripts", "judgment", "arm-thresholds.ts"), ...args],
    cwd: REPO_ROOT,
    env: merged,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function readArmState(judgmentDir: string): string[] {
  const file = join(judgmentDir, "arm-state.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
}

describe("arm-thresholds CLI", () => {
  test("dry-run on an eligible fixture prints the verdict JSON, exit 0", () => {
    const corpusDir = tmpDir("arm-gate-cli-");
    const judgmentDir = tmpDir("arm-gate-jdg-");
    try {
      writeEligibleCorpusDir(corpusDir);
      const p = runArm(["--corpus-dir", corpusDir, "--judgment-dir", judgmentDir]);
      expect(p.exitCode).toBe(0);
      const verdict = JSON.parse(p.stdout.toString());
      expect(verdict.verdict).toBe("eligible");
      expect(verdict.milestones.confirmed).toBe(240);
      expect(verdict.modes).toEqual({ live: 240, mock: 0 });
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });

  test("dry-run on an empty corpus dir: not-eligible naming both gaps (AC1)", () => {
    const corpusDir = tmpDir("arm-gate-empty-");
    const judgmentDir = tmpDir("arm-gate-jdg-");
    try {
      mkdirSync(corpusDir, { recursive: true });
      const p = runArm(["--corpus-dir", corpusDir, "--judgment-dir", judgmentDir]);
      expect(p.exitCode).toBe(0);
      const verdict = JSON.parse(p.stdout.toString());
      expect(verdict.verdict).toBe("not-eligible");
      expect(verdict.gaps).toContain("outcome_confirmed=0/200");
      expect(verdict.gaps).toContain("ci_lower=n/a");
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });

  test("arm without --sign-off text refuses exit 2 having written nothing (AC1 negative control)", () => {
    const corpusDir = tmpDir("arm-gate-cli-");
    const judgmentDir = tmpDir("arm-gate-jdg-");
    try {
      writeEligibleCorpusDir(corpusDir);
      const p = runArm(["--arm", "--corpus-dir", corpusDir, "--judgment-dir", judgmentDir], {
        QDS_JUDGMENT_ARM_CONFIRMED: "1",
      });
      expect(p.exitCode).toBe(2);
      expect(p.stderr.toString()).toMatch(/sign-off/i);
      expect(readArmState(judgmentDir)).toEqual([]);
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });

  test("arm without QDS_JUDGMENT_ARM_CONFIRMED=1 refuses exit 2 having written nothing (AC1 negative control)", () => {
    const corpusDir = tmpDir("arm-gate-cli-");
    const judgmentDir = tmpDir("arm-gate-jdg-");
    try {
      writeEligibleCorpusDir(corpusDir);
      const p = runArm(["--arm", "--sign-off", "steve 2026-11-04", "--corpus-dir", corpusDir, "--judgment-dir", judgmentDir], {
        QDS_JUDGMENT_ARM_CONFIRMED: undefined,
      });
      expect(p.exitCode).toBe(2);
      expect(p.stderr.toString()).toMatch(/QDS_JUDGMENT_ARM_CONFIRMED/);
      expect(readArmState(judgmentDir)).toEqual([]);
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });

  test("arm below both milestones refuses exit 2 naming the gaps, writing nothing (AC1 negative control)", () => {
    const corpusDir = tmpDir("arm-gate-empty-");
    const judgmentDir = tmpDir("arm-gate-jdg-");
    try {
      mkdirSync(corpusDir, { recursive: true });
      const p = runArm(["--arm", "--sign-off", "steve 2026-11-04", "--corpus-dir", corpusDir, "--judgment-dir", judgmentDir], {
        QDS_JUDGMENT_ARM_CONFIRMED: "1",
      });
      expect(p.exitCode).toBe(2);
      const err = p.stderr.toString();
      expect(err).toContain("outcome_confirmed=0/200");
      expect(err).toContain("ci_lower=n/a");
      expect(readArmState(judgmentDir)).toEqual([]);
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });

  test("the DD-21 pair on an eligible corpus appends one chained genesis flip (AC3)", () => {
    const corpusDir = tmpDir("arm-gate-cli-");
    const judgmentDir = tmpDir("arm-gate-jdg-");
    try {
      writeEligibleCorpusDir(corpusDir);
      // Padded on purpose (R3-6): the writer must TRIM before the append — an
      // untrimmed " steve 2026-11-04 " must never be frozen into the chain.
      const p = runArm(["--arm", "--sign-off", " steve 2026-11-04 ", "--corpus-dir", corpusDir, "--judgment-dir", judgmentDir], {
        QDS_JUDGMENT_ARM_CONFIRMED: "1",
      });
      expect(p.exitCode).toBe(0);
      const printed = JSON.parse(p.stdout.toString());
      expect(printed.from).toBe("recording-only");
      expect(printed.to).toBe("armed");
      const lines = readArmState(judgmentDir);
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]!) as ArmStateEntry;
      expect(entry.seq).toBe(1);
      expect(entry.prev_digest).toBeNull();
      expect(entry.sign_off).toBe("steve 2026-11-04"); // the trimmed value
      expect(entry.evidence.confirmed).toBe(240);
      expect(entry.evidence.agreed).toBe(60);
      expect(entry.evidence.thresholds).toEqual(THRESHOLDS_EVIDENCE);
      expect(entry.evidence.corpus_digest).toMatch(/^[0-9a-f]{64}$/);
      const r = verifyArmStateLog(lines);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("unreachable");
      expect(r.head.to).toBe("armed");
      // The printed entry IS the appended entry.
      expect(printed).toEqual(entry);
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });

  test("re-arming while armed refuses; --unarm with the pair appends the chained flip back", () => {
    const corpusDir = tmpDir("arm-gate-cli-");
    const judgmentDir = tmpDir("arm-gate-jdg-");
    try {
      writeEligibleCorpusDir(corpusDir);
      const pair = { QDS_JUDGMENT_ARM_CONFIRMED: "1" };
      const armArgs = ["--arm", "--sign-off", "steve 2026-11-04", "--corpus-dir", corpusDir, "--judgment-dir", judgmentDir];
      expect(runArm(armArgs, pair).exitCode).toBe(0);
      const again = runArm(armArgs, pair);
      expect(again.exitCode).toBe(2);
      expect(again.stderr.toString()).toMatch(/already armed/);
      expect(readArmState(judgmentDir)).toHaveLength(1);

      const unarm = runArm(["--unarm", "--sign-off", "steve 2026-11-05", "--corpus-dir", corpusDir, "--judgment-dir", judgmentDir], pair);
      expect(unarm.exitCode).toBe(0);
      const lines = readArmState(judgmentDir);
      expect(lines).toHaveLength(2);
      const r = verifyArmStateLog(lines);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("unreachable");
      expect(r.head.to).toBe("recording-only");
      expect(r.head.seq).toBe(2);
      expect(r.head.prev_digest).toBe(sha(r.entries[0]!));
      // Unarming also requires the pair.
      const unarmBare = runArm(["--unarm", "--corpus-dir", corpusDir, "--judgment-dir", judgmentDir], pair);
      expect(unarmBare.exitCode).toBe(2);
      expect(readArmState(judgmentDir)).toHaveLength(2);
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });

  test("--unarm with the full DD-21 pair on an EMPTY judgment dir refuses exit 2 'nothing to unarm', nothing appended (R3-9)", () => {
    const corpusDir = tmpDir("arm-gate-empty-");
    const judgmentDir = tmpDir("arm-gate-jdg-");
    try {
      mkdirSync(corpusDir, { recursive: true });
      const p = runArm(["--unarm", "--sign-off", "steve 2026-11-05", "--corpus-dir", corpusDir, "--judgment-dir", judgmentDir], {
        QDS_JUDGMENT_ARM_CONFIRMED: "1",
      });
      expect(p.exitCode).toBe(2);
      expect(p.stderr.toString()).toMatch(/nothing to unarm/);
      expect(readArmState(judgmentDir)).toEqual([]);
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });

  test("--unarm with the pair on a RECORDING-ONLY head refuses exit 2 'nothing to unarm', log unchanged (R3-9)", () => {
    const corpusDir = tmpDir("arm-gate-cli-");
    const judgmentDir = tmpDir("arm-gate-jdg-");
    try {
      writeEligibleCorpusDir(corpusDir);
      const pair = { QDS_JUDGMENT_ARM_CONFIRMED: "1" };
      expect(runArm(["--arm", "--sign-off", "steve 2026-11-04", "--corpus-dir", corpusDir, "--judgment-dir", judgmentDir], pair).exitCode).toBe(0);
      expect(runArm(["--unarm", "--sign-off", "steve 2026-11-05", "--corpus-dir", corpusDir, "--judgment-dir", judgmentDir], pair).exitCode).toBe(0);
      const before = readArmState(judgmentDir);
      expect(before).toHaveLength(2);
      // A regression here appends a no-op flip: exit 0 now, then a PERMANENT
      // exit 2 (from===to refuses) — the log is bricked. Pinned: refuse, unchanged.
      const p = runArm(["--unarm", "--sign-off", "steve 2026-11-06", "--corpus-dir", corpusDir, "--judgment-dir", judgmentDir], pair);
      expect(p.exitCode).toBe(2);
      expect(p.stderr.toString()).toMatch(/nothing to unarm/);
      expect(readArmState(judgmentDir)).toEqual(before);
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });

  test("unarm over an EMPTIED corpus: exit 0, appended entry carries rate/ci_lower 'n/a', chain verifies (R3-10)", () => {
    const corpusDir = tmpDir("arm-gate-cli-");
    const judgmentDir = tmpDir("arm-gate-jdg-");
    try {
      writeEligibleCorpusDir(corpusDir);
      const pair = { QDS_JUDGMENT_ARM_CONFIRMED: "1" };
      expect(runArm(["--arm", "--sign-off", "steve 2026-11-04", "--corpus-dir", corpusDir, "--judgment-dir", judgmentDir], pair).exitCode).toBe(0);
      // Data incident: the corpus is emptied AFTER arming — the disarm flip's
      // evidence must honestly record confirmed=0 / rate "n/a" (never a
      // fabricated interval), and that "n/a" entry must chain-verify.
      rmSync(corpusDir, { recursive: true, force: true });
      mkdirSync(corpusDir, { recursive: true });
      const p = runArm(["--unarm", "--sign-off", "steve 2026-11-05", "--corpus-dir", corpusDir, "--judgment-dir", judgmentDir], pair);
      expect(p.exitCode).toBe(0);
      const lines = readArmState(judgmentDir);
      expect(lines).toHaveLength(2);
      const entry = JSON.parse(lines[1]!) as ArmStateEntry;
      expect(entry.from).toBe("armed");
      expect(entry.to).toBe("recording-only");
      expect(entry.evidence.confirmed).toBe(0);
      expect(entry.evidence.rate).toBe("n/a");
      expect(entry.evidence.ci_lower).toBe("n/a");
      const r = verifyArmStateLog(lines);
      expect(r.ok).toBe(true); // pins the verifier's "n/a" arm
      if (!r.ok) throw new Error("unreachable");
      expect(r.head.to).toBe("recording-only");
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });

  test("consumer never honors an armed head whose chain fails verification (AC3 negative control)", () => {
    const corpusDir = tmpDir("arm-gate-cli-");
    const judgmentDir = tmpDir("arm-gate-jdg-");
    try {
      writeEligibleCorpusDir(corpusDir);
      // A 3-entry log with the middle entry hand-edited: chain broken.
      const entries = chainedEntries(3);
      const edited = JSON.parse(JSON.stringify(entries[1]!)) as ArmStateEntry;
      edited.sign_off = "attacker 2026-11-04";
      mkdirSync(judgmentDir, { recursive: true });
      writeFileSync(
        join(judgmentDir, "arm-state.jsonl"),
        `${[entries[0]!, edited, entries[2]!].map((e) => JSON.stringify(e)).join("\n")}\n`,
      );
      const p = runArm(["--unarm", "--sign-off", "steve 2026-11-05", "--corpus-dir", corpusDir, "--judgment-dir", judgmentDir], {
        QDS_JUDGMENT_ARM_CONFIRMED: "1",
      });
      expect(p.exitCode).toBe(2);
      expect(p.stderr.toString()).toMatch(/chain|prev_digest|digest/i);
      expect(readArmState(judgmentDir)).toHaveLength(3); // nothing appended
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });

  test("poisoned env cannot lower thresholds through the CLI (AC2 negative control)", () => {
    const corpusDir = tmpDir("arm-gate-empty-");
    const judgmentDir = tmpDir("arm-gate-jdg-");
    try {
      mkdirSync(corpusDir, { recursive: true });
      const p = runArm(["--corpus-dir", corpusDir, "--judgment-dir", judgmentDir], {
        MIN_OUTCOME_CONFIRMED_JEV_RECORDS: "1",
        MIN_CONFIRMED_CLUSTERS: "0",
        MIN_WILSON_LOWER_AGREEMENT: "0.1",
        QDS_MIN_WILSON_LOWER_AGREEMENT: "0.1",
        QDS_JUDGMENT_MIN_CLUSTERS: "0",
      });
      expect(p.exitCode).toBe(0);
      const verdict = JSON.parse(p.stdout.toString());
      expect(verdict.verdict).toBe("not-eligible");
      expect(verdict.gaps).toContain("outcome_confirmed=0/200");
      // And the arm attempt with the pair still refuses on the real thresholds.
      const armP = runArm(["--arm", "--sign-off", "steve", "--corpus-dir", corpusDir, "--judgment-dir", judgmentDir], {
        QDS_JUDGMENT_ARM_CONFIRMED: "1",
        MIN_OUTCOME_CONFIRMED_JEV_RECORDS: "1",
      });
      expect(armP.exitCode).toBe(2);
      expect(readArmState(judgmentDir)).toEqual([]);
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });

  test("--arm and --unarm together refuse (mutually exclusive)", () => {
    const judgmentDir = tmpDir("arm-gate-jdg-");
    try {
      const p = runArm(["--arm", "--unarm", "--sign-off", "steve", "--judgment-dir", judgmentDir]);
      expect(p.exitCode).toBe(2);
    } finally {
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });

  test("absent --corpus-dir refuses exit 2 naming the path — a typo is not a data gap (R2-H)", () => {
    const missing = join("/tmp", `arm-gate-missing-${process.pid}-${Date.now()}`);
    const judgmentDir = tmpDir("arm-gate-jdg-");
    try {
      const p = runArm(["--corpus-dir", missing, "--judgment-dir", judgmentDir]);
      expect(p.exitCode).toBe(2);
      expect(p.stderr.toString()).toContain(missing);
    } finally {
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });

  test("--corpus-dir pointing at a regular FILE refuses exit 2 naming the path — the isDirectory half of R2-H (R3-8)", () => {
    const fileAsDir = join("/tmp", `arm-gate-fileasdir-${process.pid}-${Date.now()}`);
    const judgmentDir = tmpDir("arm-gate-jdg-");
    try {
      writeFileSync(fileAsDir, "not a dir");
      const p = runArm(["--corpus-dir", fileAsDir, "--judgment-dir", judgmentDir]);
      expect(p.exitCode).toBe(2);
      expect(p.stderr.toString()).toContain(fileAsDir);
      expect(p.stderr.toString()).toContain("not a directory");
    } finally {
      rmSync(fileAsDir, { force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });

  test("loadJevCorpusRecords rethrows non-ENOENT readdir errors — a file path is a path error, not an empty corpus (R3-2)", () => {
    const fileAsDir = join("/tmp", `arm-gate-fileasdir-${process.pid}-${Date.now()}`);
    writeFileSync(fileAsDir, "x");
    try {
      expect(() => loadJevCorpusRecords(fileAsDir)).toThrow(/ENOTDIR/);
    } finally {
      rmSync(fileAsDir, { force: true });
    }
  });

  test("interior blank line in arm-state.jsonl refuses naming the line — torn double-append (R2-D)", () => {
    const corpusDir = tmpDir("arm-gate-cli-");
    const judgmentDir = tmpDir("arm-gate-jdg-");
    try {
      writeEligibleCorpusDir(corpusDir);
      const entries = chainedEntries(2);
      mkdirSync(judgmentDir, { recursive: true });
      writeFileSync(join(judgmentDir, "arm-state.jsonl"), `${JSON.stringify(entries[0])}\n\n${JSON.stringify(entries[1])}\n`);
      const p = runArm(["--corpus-dir", corpusDir, "--judgment-dir", judgmentDir]);
      expect(p.exitCode).toBe(2);
      expect(p.stderr.toString()).toContain("line 2 is blank");
      // R3-3: a whitespace-only LAST line is not a trailing-newline artifact —
      // the tail-drop is exact-"" only (route-round parity), so it must reach
      // the verifier and refuse under the SAME message shape.
      writeFileSync(join(judgmentDir, "arm-state.jsonl"), `${JSON.stringify(entries[0])}\n${JSON.stringify(entries[1])}\n  `);
      const tail = runArm(["--corpus-dir", corpusDir, "--judgment-dir", judgmentDir]);
      expect(tail.exitCode).toBe(2);
      expect(tail.stderr.toString()).toContain("line 3 is blank");
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });

  test("outcomes.jsonl readers name the PHYSICAL line: leading blank + malformed line 2 (R2-M)", () => {
    const corpusDir = tmpDir("arm-gate-lines-");
    const judgmentDir = tmpDir("arm-gate-jdg-");
    try {
      mkdirSync(corpusDir, { recursive: true });
      writeFileSync(join(corpusDir, "outcomes.jsonl"), `\n{"pr": 901, "rou`);
      const a = runArm(["--corpus-dir", corpusDir, "--judgment-dir", judgmentDir]);
      expect(a.exitCode).toBe(2);
      expect(a.stderr.toString()).toContain("outcomes.jsonl line 2");
      const c = runConfirm([...CONFIRM_ARGS, "--corpus-dir", corpusDir]);
      expect(c.exitCode).toBe(2);
      expect(c.stderr.toString()).toContain("outcomes.jsonl line 2");
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });

  test("dry-run against the REAL repo corpus (default dirs) is not-eligible naming the volume-floor gaps (F3)", () => {
    // DATA-DEPENDENT BY DESIGN: the day the real corpus meets the milestones
    // this test FAILS — that failure is the alarm telling the operator to run
    // the DD-21 milestone review, not a bug to fix in the test. Outcomes
    // accumulating BELOW the floor are the expected normal state, so the gap
    // assertions only require the floor to still be named, not the exact
    // zero count (CodeRabbit round 4: exact 0/200 would trip on the first
    // confirmed outcome).
    const p = runArm([]);
    expect(p.exitCode).toBe(0);
    const verdict = JSON.parse(p.stdout.toString());
    expect(verdict.verdict).toBe("not-eligible");
    expect(
      verdict.gaps.some(
        (g: string) =>
          g.startsWith("outcome_confirmed=") ||
          g.startsWith("ci_lower=") ||
          g.startsWith("confirmed_clusters="),
      ),
    ).toBe(true);
  });

  test("malformed corpus shard line: dry-run exits 2 with a clean message, no stack (F5)", () => {
    const corpusDir = tmpDir("arm-gate-malformed-");
    const judgmentDir = tmpDir("arm-gate-jdg-");
    try {
      mkdirSync(corpusDir, { recursive: true });
      writeFileSync(join(corpusDir, "901-r1.jsonl"), '{"finding_id":"F1","broken\n');
      const p = runArm(["--corpus-dir", corpusDir, "--judgment-dir", judgmentDir]);
      expect(p.exitCode).toBe(2); // never exit 1 — the 0/2 exit contract
      expect(p.stderr.toString()).not.toMatch(/\n\s*at\s/); // no stack frame
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });

  test("flip whose append fails (judgment dir occupied by a file) exits 2 clean, no stack (F5)", () => {
    const corpusDir = tmpDir("arm-gate-cli-");
    const judgmentDirAsFile = join("/tmp", `arm-gate-notadir-${process.pid}-${Date.now()}`);
    try {
      writeEligibleCorpusDir(corpusDir);
      writeFileSync(judgmentDirAsFile, "not a dir"); // mkdirSync(judgmentDir) will throw
      const p = runArm(["--arm", "--sign-off", "steve 2026-11-04", "--corpus-dir", corpusDir, "--judgment-dir", judgmentDirAsFile], {
        QDS_JUDGMENT_ARM_CONFIRMED: "1",
      });
      expect(p.exitCode).toBe(2);
      expect(p.stderr.toString()).not.toMatch(/\n\s*at\s/); // no stack frame
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDirAsFile, { force: true });
    }
  });

  test("shard membership is strict: a foreign notes-round.jsonl is ignored; the x-rN backfill form still loads (F13)", () => {
    const corpusDir = tmpDir("arm-gate-shards-");
    const judgmentDir = tmpDir("arm-gate-jdg-");
    try {
      mkdirSync(corpusDir, { recursive: true });
      // F-A lives in a real pr-rN shard; F-B in a foreign name the old /-r./
      // substring admitted; F-C in the x-rN (null-pr backfill) form. Record
      // content, not file name, carries pr/round — so all three WOULD count if loaded.
      writeFileSync(join(corpusDir, "901-r1.jsonl"), `${triageLine(recEntry(901, 1, "F-A", "PATCH"))}\n`);
      writeFileSync(join(corpusDir, "notes-round.jsonl"), `${triageLine(recEntry(901, 1, "F-B", "PATCH"))}\n`);
      writeFileSync(join(corpusDir, "x-r7.jsonl"), `${triageLine(recEntry(902, 2, "F-C", "PATCH"))}\n`);
      const outcomes = [outEntry(901, 1, "F-A", true), outEntry(901, 1, "F-B", true), outEntry(902, 2, "F-C", true)];
      writeFileSync(join(corpusDir, "outcomes.jsonl"), `${outcomes.map((o) => JSON.stringify(o)).join("\n")}\n`);
      const p = runArm(["--corpus-dir", corpusDir, "--judgment-dir", judgmentDir]);
      expect(p.exitCode).toBe(0);
      const verdict = JSON.parse(p.stdout.toString());
      // 3 = everything loaded (the bug); 1 = the x-form wrongly excluded; 2 = correct.
      expect(verdict.milestones.confirmed).toBe(2);
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// CLI — confirm-outcome
// ---------------------------------------------------------------------------

function runConfirm(args: string[]) {
  return Bun.spawnSync({
    cmd: ["bun", join("scripts", "judgment", "confirm-outcome.ts"), ...args],
    cwd: REPO_ROOT,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

const CONFIRM_ARGS = [
  "--pr", "901",
  "--round", "1",
  "--finding-id", "F-1",
  "--labeler", LABELER,
  "--outcome-confirmed", "true",
  "--outcome-source", "operator-merge-evidence",
  "--answer-mode", "live",
];

describe("confirm-outcome CLI", () => {
  /** A corpus dir holding the shard matching CONFIRM_ARGS's recordKey (R2-G precheck needs a joinable record). */
  function writeConfirmCorpusDir(dir: string): void {
    writeFileSync(join(dir, "901-r1.jsonl"), `${triageLine(recEntry(901, 1, "F-1", "PATCH"))}\n`);
  }

  test("appends a schema-valid OutcomeRecord line and prints it", () => {
    const corpusDir = tmpDir("confirm-out-");
    try {
      writeConfirmCorpusDir(corpusDir);
      const p = runConfirm([...CONFIRM_ARGS, "--corpus-dir", corpusDir]);
      expect(p.exitCode).toBe(0);
      const file = join(corpusDir, "outcomes.jsonl");
      const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
      expect(lines).toHaveLength(1);
      const parsed = OutcomeRecordSchema.safeParse(JSON.parse(lines[0]!));
      expect(parsed.success).toBe(true);
      expect(JSON.parse(p.stdout.toString()).status).toBe("written");
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
    }
  });

  test("identical re-confirm is an idempotent no-op: no duplicate row (AC5 negative control)", () => {
    const corpusDir = tmpDir("confirm-out-");
    try {
      writeConfirmCorpusDir(corpusDir);
      expect(runConfirm([...CONFIRM_ARGS, "--corpus-dir", corpusDir]).exitCode).toBe(0);
      const again = runConfirm([...CONFIRM_ARGS, "--corpus-dir", corpusDir]);
      expect(again.exitCode).toBe(0);
      expect(again.stdout.toString()).toContain("duplicate");
      const file = join(corpusDir, "outcomes.jsonl");
      const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
      expect(lines).toHaveLength(1);
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
    }
  });

  test("conflicting recordKey refuses the append naming the recordKey, both outcomes, and the resolution procedure (AC5 negative control)", () => {
    const corpusDir = tmpDir("confirm-out-");
    try {
      writeConfirmCorpusDir(corpusDir);
      expect(runConfirm([...CONFIRM_ARGS, "--corpus-dir", corpusDir]).exitCode).toBe(0);
      const before = readFileSync(join(corpusDir, "outcomes.jsonl"), "utf8");
      const conflictArgs = [
        "--pr", "901",
        "--round", "1",
        "--finding-id", "F-1",
        "--labeler", LABELER,
        "--outcome-confirmed", "false",
        "--outcome-source", "operator-merge-evidence",
        "--answer-mode", "live",
        "--corpus-dir", corpusDir,
      ];
      const conflict = runConfirm(conflictArgs);
      expect(conflict.exitCode).not.toBe(0);
      const err = conflict.stderr.toString();
      expect(err).toContain(`901|1|F-1|${LABELER}`);
      expect(err).toContain("true");
      expect(err).toContain("false");
      // R2-F: the refusal names the exact resolution procedure, not just "resolve explicitly".
      expect(err).toContain("hand-edit");
      expect(err).toContain(join(corpusDir, "outcomes.jsonl"));
      expect(err).toContain("re-run confirm-outcome");
      expect(readFileSync(join(corpusDir, "outcomes.jsonl"), "utf8")).toBe(before);
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
    }
  });

  test("invalid values refuse: outcome-confirmed must be true|false; answer-mode live|mock", () => {
    const corpusDir = tmpDir("confirm-out-");
    try {
      const bad = runConfirm([...CONFIRM_ARGS.slice(0, 12), "--outcome-confirmed", "maybe", "--corpus-dir", corpusDir]);
      expect(bad.exitCode).toBe(2);
      const badMode = runConfirm([...CONFIRM_ARGS.slice(0, 14), "--answer-mode", "telepath", "--corpus-dir", corpusDir]);
      expect(badMode.exitCode).toBe(2);
      expect(existsSync(join(corpusDir, "outcomes.jsonl"))).toBe(false);
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
    }
  });

  test("recordKey join authority: keyOf === schema recordKey across adversarial tuples (R2-B)", () => {
    // The gate's join key (arm-gate.keyOf) and confirm-outcome's idempotence
    // key (schema recordKey) must be ONE grammar — a divergence would let an
    // entry confirm idempotently yet never join the gate (or vice versa).
    // Adversarial tuples: x-form nulls, pipe/dot/unicode ids, empty-ish strings.
    const prs: (number | null)[] = [1, 42, 901, null];
    const rounds: (number | null)[] = [1, 7, null];
    const ids = ["F1", "F-1", "a|b", "x.y", "héllo|θ", "", " "];
    const labelers = ["jev-1", "op|x", ""];
    let checked = 0;
    for (const pr of prs) {
      for (const round of rounds) {
        for (const finding_id of ids) {
          for (const labeler of labelers) {
            const t = { pr, round, finding_id, labeler };
            expect(keyOf(t)).toBe(recordKey(t));
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(200); // the pin is generated, not a literal
  });

  test("no joining corpus record refuses the append naming the key and dir; a matching key appends (R2-G)", () => {
    const corpusDir = tmpDir("confirm-join-");
    try {
      writeConfirmCorpusDir(corpusDir);
      // Typo'd finding-id: no corpus record joins 901|1|F-typo|jev-1.
      const typo = runConfirm([...CONFIRM_ARGS.slice(0, 4), "--finding-id", "F-typo", ...CONFIRM_ARGS.slice(6), "--corpus-dir", corpusDir]);
      expect(typo.exitCode).toBe(2);
      expect(typo.stderr.toString()).toContain("901|1|F-typo|jev-1");
      expect(typo.stderr.toString()).toContain(corpusDir);
      expect(existsSync(join(corpusDir, "outcomes.jsonl"))).toBe(false); // nothing appended
      // Matching key: appends.
      const ok = runConfirm([...CONFIRM_ARGS, "--corpus-dir", corpusDir]);
      expect(ok.exitCode).toBe(0);
      expect(existsSync(join(corpusDir, "outcomes.jsonl"))).toBe(true);
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
    }
  });

  test("surrounding-whitespace flag values refuse exit 2 naming the field, nothing written (R2-Q)", () => {
    const corpusDir = tmpDir("confirm-ws-");
    try {
      const ws: [string, string][] = [
        ["--finding-id", "finding_id"],
        ["--labeler", "labeler"],
        ["--outcome-source", "outcome_source"],
      ];
      for (const [flag, field] of ws) {
        const args = [...CONFIRM_ARGS, "--corpus-dir", corpusDir];
        args[args.indexOf(flag) + 1] = " ";
        const p = runConfirm(args);
        expect(p.exitCode).toBe(2);
        expect(p.stderr.toString()).toContain(field);
      }
      expect(existsSync(join(corpusDir, "outcomes.jsonl"))).toBe(false);
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
    }
  });

  test("schema refines refuse surrounding whitespace: ' F1' and ' ' never pass (R2-Q)", () => {
    const base = {
      pr: 901,
      round: 1,
      finding_id: "F-1",
      labeler: LABELER,
      outcome_confirmed: true,
      outcome_source: "operator-merge-evidence",
      answer_mode: "live" as const,
      confirmed_at: "2026-11-04T00:00:00Z",
    };
    for (const f of ["finding_id", "labeler", "outcome_source"] as const) {
      for (const bad of [" F1", " "]) {
        expect(OutcomeRecordSchema.safeParse({ ...base, [f]: bad }).success).toBe(false);
      }
    }
  });

  // R3-5: pr/round beyond Number.MAX_SAFE_INTEGER are integers by
  // Number.isInteger (1e21 parses) yet their recordKey "1e+21|…" can never
  // join a shard — the schema's isSafeInteger refine (driver-landed in
  // scripts/corpus/schema.ts) must refuse them.
  test("schema refuses non-safe-integer pr/round — 1e21 must not parse (R3-5)", () => {
    const base = {
      pr: 901,
      round: 1,
      finding_id: "F-1",
      labeler: LABELER,
      outcome_confirmed: true,
      outcome_source: "operator-merge-evidence",
      answer_mode: "live" as const,
      confirmed_at: "2026-11-04T00:00:00Z",
    };
    for (const f of ["pr", "round"] as const) {
      expect(OutcomeRecordSchema.safeParse({ ...base, [f]: 1e21 }).success).toBe(false);
    }
  });

  test("confirm-outcome with an absent --corpus-dir refuses exit 2 naming it as a path error, never 'no joining record' (R3-2)", () => {
    const missing = join("/tmp", `confirm-missing-${process.pid}-${Date.now()}`);
    const p = runConfirm([...CONFIRM_ARGS, "--corpus-dir", missing]);
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toContain(missing);
    expect(p.stderr.toString()).toContain("path error");
    expect(p.stderr.toString()).not.toContain("no jev-arm corpus record");
  });

  test("torn outcomes.jsonl line: confirm-outcome exits 2 leaving the file byte-unchanged; arm-thresholds dry-run also exits 2 (F10)", () => {
    const corpusDir = tmpDir("confirm-torn-");
    const judgmentDir = tmpDir("arm-gate-jdg-");
    try {
      mkdirSync(corpusDir, { recursive: true });
      const file = join(corpusDir, "outcomes.jsonl");
      writeFileSync(file, `${JSON.stringify(outEntry(901, 1, "F-1", true))}\n{"pr": 901, "rou`);
      const before = readFileSync(file, "utf8");
      const c = runConfirm([...CONFIRM_ARGS, "--corpus-dir", corpusDir]);
      expect(c.exitCode).toBe(2);
      expect(readFileSync(file, "utf8")).toBe(before); // byte-unchanged — no append past a torn line
      const arm = runArm(["--corpus-dir", corpusDir, "--judgment-dir", judgmentDir]);
      expect(arm.exitCode).toBe(2);
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });

  test("--pr/--round accept strict decimal digits only: 0x10/1e2/' 5'/-1/0 each exit 2 (F14)", () => {
    const corpusDir = tmpDir("confirm-strict-");
    try {
      for (const bad of ["0x10", "1e2", " 5", "-1", "0"]) {
        const prBad = runConfirm(["--pr", bad, ...CONFIRM_ARGS.slice(2), "--corpus-dir", corpusDir]);
        expect(prBad.exitCode).toBe(2);
        const roundBad = runConfirm([...CONFIRM_ARGS.slice(0, 2), "--round", bad, ...CONFIRM_ARGS.slice(4), "--corpus-dir", corpusDir]);
        expect(roundBad.exitCode).toBe(2);
      }
      expect(existsSync(join(corpusDir, "outcomes.jsonl"))).toBe(false); // " 5" must never have written
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// In-process main drive (issue #503): runArm above is a Bun.spawnSync child,
// and coverage cannot score children (bunfig.coverage.toml docblock) — the
// file read 16.67% funcs with main fully unexercised in-process. The dry-run
// success path drives here under the same fixtures; flip and refusal arms
// keep their spawn shape (exitWithFailure calls process.exit, which must stay
// in a child). Same precedent as live-probe.ts's exported-main drive.
// ---------------------------------------------------------------------------

describe("arm-thresholds main, in-process (coverage scorer — dry-run success path)", () => {
  test("dry run over the eligible corpus: loads outcomes + jev records, reads the chain, prints the verdict JSON, exit 0", async () => {
    const corpusDir = tmpDir("arm-ip-c-");
    const judgmentDir = tmpDir("arm-ip-j-");
    try {
      writeEligibleCorpusDir(corpusDir);
      mkdirSync(judgmentDir, { recursive: true });
      writeFileSync(join(judgmentDir, "arm-state.jsonl"), `${logLines(chainedEntries(1)).join("\n")}\n`);
      const chunks: string[] = [];
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((s: string) => {
        chunks.push(s);
        return true;
      }) as typeof process.stdout.write;
      let code: number;
      try {
        code = await armThresholdsMain([
          "--corpus-dir", corpusDir,
          "--judgment-dir", judgmentDir,
        ]);
      } finally {
        process.stdout.write = origWrite;
      }
      expect(code).toBe(0);
      const verdict = JSON.parse(chunks.join("")) as { verdict: string; milestones: { confirmed: number; agreed: number } };
      expect(verdict.verdict).toBe("eligible");
      expect(verdict.milestones.confirmed).toBeGreaterThan(0);
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });
});
