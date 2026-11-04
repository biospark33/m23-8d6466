/**
 * The J2 arm gate (AC1/AC2/AC3) — a PURE milestone evaluator plus the
 * arm-state chain verifier. Parsed arrays in, verdict out: corpus reading,
 * the outcome join's file I/O, and arm-state.jsonl appends live in
 * `scripts/judgment/arm-thresholds.ts` (the fence bars this module from
 * importing scripts/ — evaluateGate's inputs arrive pre-parsed).
 *
 * Thresholds live in code, LOCKED (story AC2 / D-5): no environment,
 * config, or CLI path can lower any of the five — there is no read path
 * from anything mutable to these constants at all.
 */

import { createHash } from "node:crypto";

/**
 * Volume floor: minimum outcome-confirmed jev-arm records. ~2x the largest
 * single-round population to date (jev-live-r1's 108) and an order of
 * magnitude past the ~3-positive Goodhart floor (handoff LOCKED #9) —
 * measured against outcomes, never against lead-agreement (LOCKED #12).
 */
export const MIN_OUTCOME_CONFIRMED_JEV_RECORDS = 200;

/**
 * Minimum independent (pr, round) clusters. Not binding on the CI criterion
 * below 35 confirmed clusters (see MIN_WILSON_LOWER_AGREEMENT): the
 * 200-record corpus gate plus this floor govern until then.
 */
export const MIN_CONFIRMED_CLUSTERS = 20;

/**
 * Minimum Wilson lower bound on the outcome-agreement rate, computed over
 * (pr, round) CLUSTERS — never raw finding records (AC2: findings within one
 * round share code and reviewer dynamics; record-level independence would
 * overstate the effective n). Derivation, checkable: Wilson LB at p̂=1 is
 * LB(n,1) = n/(n+z²), so LB ≥ 0.90 ⇒ n ≥ 35 for perfect agreement; n ≥ 53 is
 * the exact minimum with one dissenting cluster (LB(53, 52/53) ≈ 0.9006);
 * the derivation uses n ≥ 60 as a conservative margin so the gate also holds
 * at minor labeler disagreement.
 */
export const MIN_WILSON_LOWER_AGREEMENT = 0.90;

/** Two-sided 95% Wilson z (the standard normal 0.975 quantile). */
export const WILSON_Z = 1.959964;

/**
 * The armed DISMISS-lane routing threshold (consumed by route-round, AC4):
 * above 0.90 a recorded DISMISS may become an obvious-dismiss-candidate —
 * the ONE re-adjudication of the standing "p>0.5, no gating use" report
 * rule; every other disposition and every sub-threshold probability stay
 * ungated.
 */
export const MIN_ROUTE_CONFIDENCE = 0.90;

// ---------------------------------------------------------------------------
// Gate types (contract-frozen — see .unlazy/j2/PLAN.md Fixed interfaces)
// ---------------------------------------------------------------------------

export interface GateOutcomeEntry {
  pr: number;
  round: number;
  finding_id: string;
  labeler: string;
  outcome_confirmed: boolean;
  outcome_source: string;
  answer_mode: "live" | "mock";
  confirmed_at: string;
}

export interface GateCorpusRecord {
  pr: number;
  round: number;
  finding_id: string;
  labeler: string;
  disposition: string;
}

export interface ArmThresholds {
  MIN_OUTCOME_CONFIRMED_JEV_RECORDS: number;
  MIN_CONFIRMED_CLUSTERS: number;
  MIN_WILSON_LOWER_AGREEMENT: number;
  WILSON_Z: number;
  MIN_ROUTE_CONFIDENCE: number;
}

export interface ArmStateEntry {
  seq: number;
  at: string;
  from: "recording-only" | "armed";
  to: "recording-only" | "armed";
  sign_off: string;
  evidence: {
    confirmed: number;
    agreed: number;
    rate: number | "n/a";
    ci_lower: number | "n/a";
    thresholds: ArmThresholds;
    corpus_digest: string;
  };
  /** sha256 of the canonical serialization of the prior entry; genesis = null. */
  prev_digest: string | null;
}

export interface GateVerdict {
  milestones: {
    confirmed: number;
    confirmed_min: number;
    clusters: number;
    clusters_min: number;
    agreed: number;
    rate: number | "n/a";
    ci_lower: number | "n/a";
    ci_floor: number;
  };
  sources: Record<string, number>;
  modes: { live: number; mock: number };
  verdict: "eligible" | "not-eligible";
  gaps: string[];
}

export function thresholds(): ArmThresholds {
  return {
    MIN_OUTCOME_CONFIRMED_JEV_RECORDS,
    MIN_CONFIRMED_CLUSTERS,
    MIN_WILSON_LOWER_AGREEMENT,
    WILSON_Z,
    MIN_ROUTE_CONFIDENCE,
  };
}

// ---------------------------------------------------------------------------
// Agreement (outcome agreement — LOCKED #12, the anti-Goodhart metric)
// ---------------------------------------------------------------------------

/**
 * Mirrors ab-report.ts outcomeAgrees (:228-230) exactly: a confirmed-true
 * outcome agrees with every disposition except DISMISS; a confirmed-false
 * outcome agrees with DISMISS. Pinned byte-for-byte by the suite (which may
 * import scripts/ — this module may not).
 */
export function agrees(disposition: string, outcome_confirmed: boolean): boolean {
  return outcome_confirmed ? disposition !== "DISMISS" : disposition === "DISMISS";
}

// ---------------------------------------------------------------------------
// Wilson lower bound
// ---------------------------------------------------------------------------

/** Two-sided Wilson score-interval lower bound for agreed/n at z. */
export function wilsonLowerBound(agreed: number, n: number, z: number): number {
  const p = agreed / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return (center - margin) / denom;
}

// ---------------------------------------------------------------------------
// Population resolution + join (AC5)
// ---------------------------------------------------------------------------

/** The recordKey string form (scripts/corpus/schema.ts grammar, pr/round always positive here). */
function keyOf(r: { pr: number; round: number; finding_id: string; labeler: string }): string {
  return `${r.pr}|${r.round}|${r.finding_id}|${r.labeler}`;
}

/**
 * One resolved entry per distinct recordKey. A key with two IDENTICAL outcome
 * entries resolves (idempotent re-confirm); a key with CONFLICTING entries is
 * unresolved and excluded everywhere — an unresolved disagreement is never
 * counted as agreement (AC5).
 */
function resolvedByKey(outcomeEntries: GateOutcomeEntry[]): Map<string, GateOutcomeEntry> {
  const byKey = new Map<string, GateOutcomeEntry[]>();
  for (const e of outcomeEntries) {
    const k = keyOf(e);
    byKey.set(k, [...(byKey.get(k) ?? []), e]);
  }
  const resolved = new Map<string, GateOutcomeEntry>();
  for (const [k, entries] of byKey) {
    const first = entries[0]!;
    const identical = entries.every(
      (e) => e.outcome_confirmed === first.outcome_confirmed && e.outcome_source === first.outcome_source && e.answer_mode === first.answer_mode,
    );
    if (identical) resolved.set(k, first);
  }
  return resolved;
}

/** The counted population: resolved live-attested entries joined to a corpus record, key-sorted (canonical order). */
function countedEntries(outcomeEntries: GateOutcomeEntry[], corpusRecords: GateCorpusRecord[]): GateOutcomeEntry[] {
  const resolved = resolvedByKey(outcomeEntries);
  const joined = new Set<string>();
  for (const r of corpusRecords) {
    const k = keyOf(r);
    const o = resolved.get(k);
    if (o !== undefined && o.answer_mode === "live") joined.add(k);
  }
  return [...joined].sort().map((k) => resolved.get(k)!);
}

/**
 * The corpus digest a flip records: sha256 over the counted population's
 * canonical serialization at flip time (key-sorted, so the digest is
 * deterministic under file order).
 */
export function countedCorpusDigest(outcomeEntries: GateOutcomeEntry[], corpusRecords: GateCorpusRecord[]): string {
  return createHash("sha256").update(JSON.stringify(countedEntries(outcomeEntries, corpusRecords))).digest("hex");
}

// ---------------------------------------------------------------------------
// Gate evaluation (AC1/AC2/AC5)
// ---------------------------------------------------------------------------

/**
 * Evaluate the arming milestones. The interval's unit is the (pr, round)
 * cluster; a cluster agrees iff EVERY confirmed finding in it agrees. Absent
 * outcomes stay absent: confirmed=0 with rate/ci_lower "n/a" — never a
 * fabricated interval.
 */
export function evaluateGate(outcomeEntries: GateOutcomeEntry[], corpusRecords: GateCorpusRecord[]): GateVerdict {
  const resolved = resolvedByKey(outcomeEntries);

  // answer_mode split over ALL resolved entries (mock entries are visible,
  // never counted — the §7.8 counter-metric).
  const modes = { live: 0, mock: 0 };
  for (const e of resolved.values()) modes[e.answer_mode]++;

  const liveByKey = new Map<string, GateOutcomeEntry>();
  for (const [k, e] of resolved) if (e.answer_mode === "live") liveByKey.set(k, e);

  // Join onto the corpus; the cluster is the interval's unit of independence.
  const countedKeys = new Set<string>();
  const clusterTotal = new Map<string, number>();
  const clusterAgreed = new Map<string, number>();
  const sources: Record<string, number> = {};
  for (const r of corpusRecords) {
    const o = liveByKey.get(keyOf(r));
    if (o === undefined) continue;
    countedKeys.add(keyOf(r));
    const ck = `${r.pr}|${r.round}`;
    clusterTotal.set(ck, (clusterTotal.get(ck) ?? 0) + 1);
    if (agrees(r.disposition, o.outcome_confirmed)) clusterAgreed.set(ck, (clusterAgreed.get(ck) ?? 0) + 1);
    sources[o.outcome_source] = (sources[o.outcome_source] ?? 0) + 1;
  }

  const confirmed = countedKeys.size;
  const clusters = clusterTotal.size;
  let agreed = 0;
  for (const [ck, total] of clusterTotal) if ((clusterAgreed.get(ck) ?? 0) === total) agreed++;
  const rate: number | "n/a" = clusters === 0 ? "n/a" : agreed / clusters;
  const ci_lower: number | "n/a" = clusters === 0 ? "n/a" : wilsonLowerBound(agreed, clusters, WILSON_Z);

  const gaps: string[] = [];
  if (confirmed < MIN_OUTCOME_CONFIRMED_JEV_RECORDS) gaps.push(`outcome_confirmed=${confirmed}/${MIN_OUTCOME_CONFIRMED_JEV_RECORDS}`);
  if (clusters < MIN_CONFIRMED_CLUSTERS) gaps.push(`confirmed_clusters=${clusters}/${MIN_CONFIRMED_CLUSTERS}`);
  if (ci_lower === "n/a") gaps.push("ci_lower=n/a");
  else if (ci_lower < MIN_WILSON_LOWER_AGREEMENT) gaps.push(`ci_lower=${ci_lower.toFixed(4)}/${MIN_WILSON_LOWER_AGREEMENT}`);

  return {
    milestones: {
      confirmed,
      confirmed_min: MIN_OUTCOME_CONFIRMED_JEV_RECORDS,
      clusters,
      clusters_min: MIN_CONFIRMED_CLUSTERS,
      agreed,
      rate,
      ci_lower,
      ci_floor: MIN_WILSON_LOWER_AGREEMENT,
    },
    sources,
    modes,
    verdict: gaps.length === 0 ? "eligible" : "not-eligible",
    gaps,
  };
}

// ---------------------------------------------------------------------------
// The arm-state chain (AC3)
// ---------------------------------------------------------------------------

/**
 * sha256 over JSON.stringify(entry) with the fixed literal key order above —
 * the provenanceDigest idiom (src/judgment/emit.ts:60-62) at its smallest.
 */
export function armStateEntryDigest(entry: ArmStateEntry): string {
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

const ARM_STATES = new Set(["recording-only", "armed"]);

/** Structural + chain check of one parsed entry at its expected position. */
function entryProblem(raw: unknown, expectedSeq: number, prevDigest: string | null, prevTo: string | null): string | null {
  const e = raw as Partial<ArmStateEntry>;
  if (typeof e !== "object" || e === null) return `entry ${expectedSeq} is not an object`;
  if (e.seq !== expectedSeq) return `entry ${expectedSeq} has seq ${String(e.seq)} — the walk starts at seq 1 and must be gapless and in order`;
  if (e.prev_digest !== prevDigest) {
    return `entry ${expectedSeq} prev_digest does not equal the computed digest of entry ${expectedSeq - 1} (chain broken — hand-edited, spliced, or reordered log)`;
  }
  if (e.from === undefined || e.to === undefined || !ARM_STATES.has(e.from) || !ARM_STATES.has(e.to)) {
    return `entry ${expectedSeq} from/to must be "recording-only" | "armed"`;
  }
  if (prevTo !== null && e.from !== prevTo) return `entry ${expectedSeq} from "${e.from}" does not continue entry ${expectedSeq - 1} to "${prevTo}"`;
  if (typeof e.sign_off !== "string" || e.sign_off.length === 0) return `entry ${expectedSeq} sign_off must be a non-empty string`;
  return null;
}

/**
 * Walk the append-only arm-state log from genesis. seq starts at 1 and is
 * gapless; each prev_digest must equal the computed digest of the prior
 * entry; from continues the prior to. ANY violation refuses (fail-closed).
 * An empty log is not a chain — an absent or empty file means
 * recording-only, never armed.
 */
export function verifyArmStateLog(
  lines: string[],
): { ok: true; entries: ArmStateEntry[]; head: ArmStateEntry; headDigest: string } | { ok: false; reason: string } {
  const entries: ArmStateEntry[] = [];
  let prevDigest: string | null = null;
  let prevTo: "recording-only" | "armed" | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") return { ok: false, reason: `arm-state line ${i + 1} is blank — the log is append-only JSONL, one entry per line` };
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (e) {
      return { ok: false, reason: `arm-state line ${i + 1} is not valid JSON (truncated or hand-edited write): ${(e as Error).message}` };
    }
    const problem = entryProblem(raw, i + 1, prevDigest, prevTo);
    if (problem !== null) return { ok: false, reason: problem };
    const entry = raw as ArmStateEntry;
    entries.push(entry);
    prevDigest = armStateEntryDigest(entry);
    prevTo = entry.to;
  }
  if (entries.length === 0) return { ok: false, reason: "arm-state log is empty — absent or empty file means recording-only, never armed (fail-closed)" };
  return { ok: true, entries, head: entries[entries.length - 1]!, headDigest: prevDigest! };
}
