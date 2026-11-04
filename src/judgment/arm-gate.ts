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

/** The five threshold names evidence.thresholds must carry, each a number. */
const THRESHOLD_KEYS = ["MIN_OUTCOME_CONFIRMED_JEV_RECORDS", "MIN_CONFIRMED_CLUSTERS", "MIN_WILSON_LOWER_AGREEMENT", "WILSON_Z", "MIN_ROUTE_CONFIDENCE"] as const;

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

/**
 * Two-sided Wilson score-interval lower bound for agreed/n at z. Throws on
 * invalid inputs (n ≤ 0, agreed < 0, agreed > n, z non-finite or ≤ 0):
 * evaluateGate guards its own calls, but a silent NaN would lie to any future
 * caller — and z=0 would sell the point estimate as the lower bound, z<0 a
 * bound above p̂ (R2-J).
 */
export function wilsonLowerBound(agreed: number, n: number, z: number): number {
  if (!(n > 0) || agreed < 0 || agreed > n) {
    throw new Error(`wilsonLowerBound: invalid inputs (agreed=${agreed}, n=${n}) — need n>0 and 0 ≤ agreed ≤ n`);
  }
  if (!(Number.isFinite(z) && z > 0)) {
    throw new Error(`wilsonLowerBound: invalid z=${z} — need a finite z > 0`);
  }
  const p = agreed / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return (center - margin) / denom;
}

// ---------------------------------------------------------------------------
// Population resolution + join (AC5)
// ---------------------------------------------------------------------------

/**
 * The recordKey string form — the SAME grammar as scripts/corpus/schema.ts's
 * `recordKey`, null pr/round rendering "x" included (the x-rN backfill form;
 * the gate's loaders only ever pass positive ints, but the grammars must stay
 * byte-equal). Exported so the suite can pin the equivalence adversarially:
 * confirm-outcome's idempotence key and the gate's join key are one grammar,
 * and any divergence between them becomes a loud test failure (R2-B).
 */
export function keyOf(r: { pr: number | null; round: number | null; finding_id: string; labeler: string }): string {
  return `${r.pr ?? "x"}|${r.round ?? "x"}|${r.finding_id}|${r.labeler}`;
}

/**
 * One resolved entry per distinct recordKey. A key with two IDENTICAL outcome
 * entries resolves (idempotent re-confirm); a key with CONFLICTING entries is
 * unresolved and excluded everywhere — an unresolved disagreement is never
 * counted as agreement (AC5), and `unresolved` counts those keys so the
 * verdict can surface the shrinkage instead of hiding it.
 */
function resolvedByKey(outcomeEntries: GateOutcomeEntry[]): { resolved: Map<string, GateOutcomeEntry>; unresolved: number } {
  const byKey = new Map<string, GateOutcomeEntry[]>();
  for (const e of outcomeEntries) {
    const k = keyOf(e);
    byKey.set(k, [...(byKey.get(k) ?? []), e]);
  }
  const resolved = new Map<string, GateOutcomeEntry>();
  let unresolved = 0;
  for (const [k, entries] of byKey) {
    const first = entries[0]!;
    const identical = entries.every(
      (e) => e.outcome_confirmed === first.outcome_confirmed && e.outcome_source === first.outcome_source && e.answer_mode === first.answer_mode,
    );
    if (identical) resolved.set(k, first);
    else unresolved++;
  }
  return { resolved, unresolved };
}

/**
 * Fixed literal key order for a counted entry — the CORPUS digest is a
 * content identity: it must not depend on the row order or JSON key order the
 * files happened to carry, so it is built from explicitly constructed objects,
 * never raw JSON.parse output. The CHAIN digest (armStateEntryDigest below)
 * deliberately takes the opposite policy — it hashes the entry exactly as
 * parsed, so ANY byte change, cosmetic reordering included, yields a new
 * digest and breaks the chain: content-identity across serializations for the
 * corpus, byte-level tamper evidence for the chain (R2-N).
 */
function canonicalOutcomeEntry(e: GateOutcomeEntry): GateOutcomeEntry {
  return {
    pr: e.pr,
    round: e.round,
    finding_id: e.finding_id,
    labeler: e.labeler,
    outcome_confirmed: e.outcome_confirmed,
    outcome_source: e.outcome_source,
    answer_mode: e.answer_mode,
    confirmed_at: e.confirmed_at,
  };
}

/**
 * The corpus digest a flip records: sha256 over the counted population at
 * flip time — key-sorted, each side serialized in fixed literal key order, so
 * the digest is deterministic under file order AND cosmetic key reordering.
 * Both sides of the join are witnessed (R2-E): the canonical outcome entries
 * AND, per counted key, the joined corpus row's {recordKey, disposition} —
 * the dispositions are what decide agreement, so two corpora differing only
 * in dispositions must NOT share one digest. Corpus rows dedupe by recordKey,
 * first occurrence wins (evaluateGate's hand-merged-shard precedent).
 */
export function countedCorpusDigest(outcomeEntries: GateOutcomeEntry[], corpusRecords: GateCorpusRecord[]): string {
  const { resolved } = resolvedByKey(outcomeEntries);
  const corpusByKey = new Map<string, GateCorpusRecord>();
  const joined = new Set<string>();
  for (const r of corpusRecords) {
    const k = keyOf(r);
    if (!corpusByKey.has(k)) corpusByKey.set(k, r);
    const o = resolved.get(k);
    if (o !== undefined && o.answer_mode === "live") joined.add(k);
  }
  const keys = [...joined].sort();
  return createHash("sha256")
    .update(
      JSON.stringify({
        outcomes: keys.map((k) => canonicalOutcomeEntry(resolved.get(k)!)),
        corpus: keys.map((k) => ({ recordKey: k, disposition: corpusByKey.get(k)!.disposition })),
      }),
    )
    .digest("hex");
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
  const { resolved, unresolved } = resolvedByKey(outcomeEntries);

  // answer_mode split over ALL resolved entries (mock entries are visible,
  // never counted — the §7.8 counter-metric).
  const modes = { live: 0, mock: 0 };
  for (const e of resolved.values()) modes[e.answer_mode]++;

  const liveByKey = new Map<string, GateOutcomeEntry>();
  for (const [k, e] of resolved) if (e.answer_mode === "live") liveByKey.set(k, e);

  // Join onto the corpus; the cluster is the interval's unit of independence.
  // Corpus rows dedupe by recordKey (first occurrence wins): a duplicate row
  // from a hand-merged shard must not inflate cluster totals or source counts
  // behind the same confirmed number the deduped run reports.
  const countedKeys = new Set<string>();
  const clusterTotal = new Map<string, number>();
  const clusterAgreed = new Map<string, number>();
  const sources: Record<string, number> = {};
  const seenCorpusKeys = new Set<string>();
  for (const r of corpusRecords) {
    const k = keyOf(r);
    if (seenCorpusKeys.has(k)) continue;
    seenCorpusKeys.add(k);
    const o = liveByKey.get(k);
    if (o === undefined) continue;
    countedKeys.add(k);
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
  // A conflicting (hand-edited) outcome key silently shrinks the counted
  // population — surface the shrinkage instead of hiding it behind a lower count.
  if (unresolved > 0) gaps.push(`unresolved_outcome_keys=${unresolved}`);

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

/**
 * A strict ISO-8601 INSTANT — a flip moment, so date-only is not enough and
 * the zone is required (writers use `new Date().toISOString()`, always Z).
 * The corpus ISO_8601_RE idea inlined: arm-gate sits inside the fence and may
 * not import scripts/, and `Date.parse` alone normalizes overflow dates like
 * 2026-02-30, so the calendar day round-trips through UTC.
 */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

function isIsoInstant(s: string): boolean {
  if (!ISO_INSTANT_RE.test(s) || Number.isNaN(Date.parse(s))) return false;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)!;
  const [y, mo, d] = [Number(m[1]!), Number(m[2]!), Number(m[3]!)];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

const EVIDENCE_KEYS = ["confirmed", "agreed", "rate", "ci_lower", "thresholds", "corpus_digest"] as const;

/** The flip's evidence snapshot must carry exactly its contract shape (AC3) — anything else names the field it broke on. */
function evidenceProblem(raw: unknown, seq: number): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return `entry ${seq} evidence must be an object`;
  const e = raw as Record<string, unknown>;
  for (const f of EVIDENCE_KEYS) if (!(f in e)) return `entry ${seq} evidence.${f} is missing`;
  for (const k of Object.keys(e)) if (!(EVIDENCE_KEYS as readonly string[]).includes(k)) return `entry ${seq} evidence has unexpected field "${k}"`;
  if (typeof e.confirmed !== "number" || !Number.isFinite(e.confirmed) || !Number.isInteger(e.confirmed) || e.confirmed < 0) {
    return `entry ${seq} evidence.confirmed must be a non-negative integer`;
  }
  if (typeof e.agreed !== "number" || !Number.isFinite(e.agreed) || !Number.isInteger(e.agreed) || e.agreed < 0 || e.agreed > e.confirmed) {
    return `entry ${seq} evidence.agreed must be a non-negative integer ≤ confirmed`;
  }
  for (const f of ["rate", "ci_lower"] as const) {
    const v = e[f];
    if (v !== "n/a" && (typeof v !== "number" || !Number.isFinite(v))) return `entry ${seq} evidence.${f} must be a number or "n/a"`;
    if (v !== "n/a" && (v < 0 || v > 1)) return `entry ${seq} evidence.${f} must be within [0,1] or "n/a"`;
  }
  const th = e.thresholds;
  if (typeof th !== "object" || th === null || Array.isArray(th)) return `entry ${seq} evidence.thresholds must be an object`;
  for (const k of THRESHOLD_KEYS) {
    const v = (th as Record<string, unknown>)[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return `entry ${seq} evidence.thresholds.${k} must be a finite number > 0`;
  }
  for (const k of Object.keys(th)) if (!(THRESHOLD_KEYS as readonly string[]).includes(k)) return `entry ${seq} evidence.thresholds has unexpected field "${k}"`;
  if (typeof e.corpus_digest !== "string" || !/^[0-9a-f]{64}$/.test(e.corpus_digest)) return `entry ${seq} evidence.corpus_digest must be 64 hex chars`;
  return null;
}

/** The exact top-level key set an ArmStateEntry may carry (R2-K — extras refuse). */
const ENTRY_KEYS = ["seq", "at", "from", "to", "sign_off", "evidence", "prev_digest"] as const;

/** Structural + chain check of one parsed entry at its expected position. */
function entryProblem(raw: unknown, expectedSeq: number, prevDigest: string | null, prevTo: string | null): string | null {
  const e = raw as Partial<ArmStateEntry>;
  if (typeof e !== "object" || e === null) return `entry ${expectedSeq} is not an object`;
  // Exact key set: a future writer's added field must refuse here, not ship
  // green and get chain-frozen into the log's canonical shape (R2-K).
  for (const k of Object.keys(e)) if (!(ENTRY_KEYS as readonly string[]).includes(k)) return `entry ${expectedSeq} has unexpected field "${k}"`;
  if (e.seq !== expectedSeq) return `entry ${expectedSeq} has seq ${String(e.seq)} — the walk starts at seq 1 and must be gapless and in order`;
  if (e.prev_digest !== prevDigest) {
    return `entry ${expectedSeq} prev_digest does not equal the computed digest of entry ${expectedSeq - 1} (chain broken — hand-edited, spliced, or reordered log)`;
  }
  if (e.from === undefined || e.to === undefined || !ARM_STATES.has(e.from) || !ARM_STATES.has(e.to)) {
    return `entry ${expectedSeq} from/to must be "recording-only" | "armed"`;
  }
  if (e.from === e.to) return `entry ${expectedSeq} from===to ("${e.from}") — no-op flips are invalid`;
  if (expectedSeq === 1 && e.from !== "recording-only") {
    return `entry 1 is genesis — from must be "recording-only", got "${e.from}"`;
  }
  if (prevTo !== null && e.from !== prevTo) return `entry ${expectedSeq} from "${e.from}" does not continue entry ${expectedSeq - 1} to "${prevTo}"`;
  // trim-gated, matching the CLI's own --sign-off gate: a whitespace-only
  // sign-off must not chain-verify either (R3-6).
  if (typeof e.sign_off !== "string" || e.sign_off.trim().length === 0) return `entry ${expectedSeq} sign_off must be a non-empty string, not whitespace-only`;
  if (typeof e.at !== "string" || !isIsoInstant(e.at)) {
    return `entry ${expectedSeq} at must be an ISO-8601 instant (e.g. "2026-11-04T00:00:00Z")`;
  }
  const ev = evidenceProblem(e.evidence, expectedSeq);
  if (ev !== null) return ev;
  return null;
}

/**
 * Walk the append-only arm-state log from genesis. seq starts at 1 and is
 * gapless; each prev_digest must equal the computed digest of the prior
 * entry; from continues the prior to (genesis from is "recording-only";
 * from===to is never legal — no no-op flips). ANY violation refuses
 * (fail-closed).
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
