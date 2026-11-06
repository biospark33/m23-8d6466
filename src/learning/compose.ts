/**
 * M3.2 — deterministic host-side proposal composition (no LLM, no randomness,
 * no side effects: stable ordering, pure functions).
 *
 * Three detectors, one per closed proposal kind:
 * - `router-tuning` — model-tier selection ONLY (AC5): within a shape, a
 *   cheaper ladder tier whose decisions score at least as well as a costlier
 *   tier's (both with enough decisions) proposes the tier drop.
 * - `threshold-suggestion` — a counter-metric regression against a measured
 *   primary KPI (the FR-LEARN-33 pair discipline, src/kpi/schema.ts): a
 *   non-zero counter while its primary is measured. Always advisory + operator
 *   adjudicated + the J2 DD-21-unsatisfied note (AC2's refinement).
 * - `skill-update` — a recurring run-record failure class (≥2 records sharing
 *   a classification) proposes a skill-doc update.
 *
 * Snapshots and run records stay `unknown` here on purpose: closed-schema
 * validation is A5's / the provider store's surface, and compose only probes
 * structurally for the fields it cites. Zero evidence ⇒ zero proposals, green
 * (AC4's absence discipline). No "severity" token is ever emitted — any
 * extracted name matching the token is dropped (AC5's query negative control).
 */
import type { GatheredEvidence, RoutingLogLine } from "./gather.ts";
import { PROPOSAL_RATIONALE_CHAR_CEILING, type ProposalRecord } from "./proposal-schema.ts";

// ─── constants ───────────────────────────────────────────────────────────────

/** Bound on the reflect-query digest — a chat-turn prompt, not a data dump. */
export const REFLECT_QUERY_CHAR_CAP = 1_200;
/** Cost ladder for applied tiers — index IS cost; a tier matching no rung is excluded from comparisons. */
export const TIER_COST_LADDER = ["haiku", "sonnet", "opus"] as const;
/** Minimum decisions per tier before a tier comparison is trusted. */
export const MIN_DECISIONS_FOR_TUNING = 2;
/** Per-firing proposal ceiling (F-011): per-shape/per-snapshot detectors must
 *  not fan out unbounded operator spam in one firing; emission order decides
 *  what survives the cap. */
export const MAX_PROPOSALS_PER_FIRING = 16;
/** Run records sharing a class needed to call the class recurring. */
export const RECURRING_CLASS_THRESHOLD = 2;
/** AC2 verbatim-ish gate note every threshold-suggestion carries. */
export const J2_GATE_NOTE =
  "advisory only; J2 arm-threshold unlock (DD-21: calibration milestones + explicit operator sign-off) is NOT satisfied by this proposal";
/** AC5: no extracted name carrying this token ever reaches a query or rationale. */
const SEVERITY_TOKEN = /sever/i;
/** Severity-safe embedding for hostile extracted names in rationale/summary
 * prose (self-review round 0 #6): the same filter buildReflectQuery applies. */
const embed = (n: string): string => safeName(n) ?? "redacted-name";
/** Ordered probe list for a run record's failure-class field (first string wins).
 *  Structural fields (`shape`, `status`) are deliberately excluded: a routing
 *  shape or run status is not a failure class, and two `shape:"review"` records
 *  must not compose a skill-update (F-005). */
const RUN_CLASS_FIELDS = ["classification", "outcome_class", "fixOutcomeClass"] as const;
/** Classes that are NOT failure classes (self-review round 0 #7): hostile or
 *  miswritten classification VALUES must not compose a skill-update for a
 *  "failure class ok" (the field list above already guards hostile shapes). */
const SUCCESS_CLASS_RE = /^(ok|okay|success|succeeded|pass|passed|complete|completed|done|skipped|cancelled|canceled)$/i;

// ─── unknown-probe helpers (snapshots + run records are `unknown`) ───────────

const asRecord = (u: unknown): Record<string, unknown> | null =>
  typeof u === "object" && u !== null && !Array.isArray(u) ? (u as Record<string, unknown>) : null;

/** First string-valued field among `names` (defensive probe over an unknown record). */
const strField = (rec: Record<string, unknown>, names: readonly string[]): string | null => {
  for (const n of names) {
    const v = rec[n];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
};

/** Ladder cost of an applied tier (substring match), or null when off-ladder. */
const tierCost = (tier: string): number | null => {
  const i = TIER_COST_LADDER.findIndex((t) => tier.includes(t));
  return i === -1 ? null : i;
};

/** Deterministic composite of a named-weight score record: the sum of its parts. */
const compositeScore = (score: Record<string, number>): number =>
  Object.keys(score)
    .sort()
    .reduce((acc, k) => acc + (score[k] ?? 0), 0);

/** Drop any name that would smuggle the locked-out token into a query (AC5). */
const safeName = (name: string | null): string | null => (name === null || SEVERITY_TOKEN.test(name) ? null : name);

// ─── buildReflectQuery ───────────────────────────────────────────────────────

/** Compact human-readable evidence digest for the reflect call: counts + salient
 *  signals only. Never contains "severity" (case-insensitive) and never exceeds
 *  REFLECT_QUERY_CHAR_CAP. */
export function buildReflectQuery(bankId: string, evidence: GatheredEvidence): string {
  const parts: string[] = [];
  parts.push(`Weekly reflect for bank ${SEVERITY_TOKEN.test(bankId) ? "bank" : bankId}.`);

  if (evidence.routingLines.length > 0) {
    const byTier = new Map<string, number>();
    for (const line of evidence.routingLines) byTier.set(line.applied_tier, (byTier.get(line.applied_tier) ?? 0) + 1);
    const dist = [...byTier.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([tier, n]) => `${tier} x${n}`)
      .join(", ");
    parts.push(`${evidence.routingLines.length} routing decisions, applied tiers: ${dist}.`);
  }

  const kpiBits: string[] = [];
  for (const { snapshot } of evidence.kpiSnapshots) {
    const rec = asRecord(snapshot);
    const kpis = rec !== null && Array.isArray(rec.kpis) ? rec.kpis : [];
    for (const k of kpis) {
      const krec = asRecord(k);
      if (krec === null) continue;
      const name = safeName(strField(krec, ["name"]));
      const value = asRecord(krec.value);
      if (name === null || value === null || value.status !== "measured" || typeof value.value !== "number") continue;
      kpiBits.push(`${name} ${value.value} (direction ${String(krec.direction)})`);
    }
  }
  if (kpiBits.length > 0) parts.push(`KPIs: ${kpiBits.join("; ")}.`);

  if (evidence.runRecords.length > 0) {
    const byClass = new Map<string, number>();
    for (const { record } of evidence.runRecords) {
      const rec = asRecord(record);
      const cls = rec === null ? null : safeName(strField(rec, RUN_CLASS_FIELDS));
      if (cls !== null) byClass.set(cls, (byClass.get(cls) ?? 0) + 1);
    }
    const classes = [...byClass.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([cls, n]) => `${cls} x${n}`)
      .join(", ");
    parts.push(`${evidence.runRecords.length} run records, classes: ${classes}.`);
  }

  return parts.join(" ").slice(0, REFLECT_QUERY_CHAR_CAP);
}

// ─── composeProposals ────────────────────────────────────────────────────────

export type ReflectEntry = { bankId: string; text: string };

export type ComposeInput = {
  week: string;
  firedAt: string;
  evidence: GatheredEvidence;
  reflects: ReflectEntry[];
  reflect_ok: Record<string, boolean>;
  /** Pre-approved plan amendment: lane fallback banks — the first `-dev-meta` suffixed bank is the default target. */
  banks: string[];
};

/** Router-tuning detector input: per-shape per-tier mean composite scores. */
type TierGroup = { tier: string; cost: number; mean: number; refs: string[] };

function routerTuningFindings(lines: RoutingLogLine[]): Array<{ shape: string; cheaper: TierGroup; costlier: TierGroup }> {
  const byShape = new Map<string, Map<number, TierGroup>>();
  for (const line of lines) {
    const cost = tierCost(line.applied_tier);
    if (cost === null) continue;
    const shape = byShape.get(line.shape) ?? new Map<number, TierGroup>();
    const g = shape.get(cost) ?? { tier: line.applied_tier, cost, mean: 0, refs: [] };
    // A repeated runId is one decision replayed, not a second datapoint (F-020) —
    // count it once in the mean and once in the citations.
    if (g.refs.includes(line.runId)) continue;
    const n = g.refs.length;
    g.mean = (g.mean * n + compositeScore(line.score)) / (n + 1);
    g.refs.push(line.runId);
    shape.set(cost, g);
    byShape.set(line.shape, shape);
  }
  const findings: Array<{ shape: string; cheaper: TierGroup; costlier: TierGroup }> = [];
  for (const shape of [...byShape.keys()].sort()) {
    const tiers = [...byShape.get(shape)!.values()].filter((g) => g.refs.length >= MIN_DECISIONS_FOR_TUNING);
    tiers.sort((a, b) => a.cost - b.cost);
    for (const costlier of tiers.slice(1)) {
      const cheaper = tiers.find((g) => g.cost < costlier.cost && g.mean >= costlier.mean);
      if (cheaper !== undefined) {
        findings.push({ shape, cheaper, costlier });
        break; // one proposal per shape — the first (cheapest) qualifying pair
      }
    }
  }
  return findings;
}

/** Counter-metric regressions: a measured primary whose counter pair is a positive number. */
function counterRegressions(evidence: GatheredEvidence): Array<{ ref: string; kpi: string; counter: string; value: number }> {
  const out: Array<{ ref: string; kpi: string; counter: string; value: number }> = [];
  for (const { ref, snapshot } of evidence.kpiSnapshots) {
    const rec = asRecord(snapshot);
    const kpis = rec !== null && Array.isArray(rec.kpis) ? rec.kpis : [];
    for (const k of kpis) {
      const krec = asRecord(k);
      if (krec === null) continue;
      const name = strField(krec, ["name"]);
      const value = asRecord(krec.value);
      const counter = asRecord(krec.counter);
      if (name === null || value === null || value.status !== "measured") continue;
      if (counter === null || typeof counter.value !== "number" || counter.value <= 0) continue;
      const counterName = strField(counter, ["name"]);
      if (counterName === null) continue;
      out.push({ ref, kpi: name, counter: counterName, value: counter.value });
    }
  }
  return out;
}

/** Recurring run-record failure classes (≥ RECURRING_CLASS_THRESHOLD records). */
function recurringClasses(evidence: GatheredEvidence): Array<{ cls: string; refs: string[] }> {
  const byClass = new Map<string, string[]>();
  for (const { ref, record } of evidence.runRecords) {
    const rec = asRecord(record);
    const cls = rec === null ? null : strField(rec, RUN_CLASS_FIELDS);
    if (cls === null || SUCCESS_CLASS_RE.test(cls)) continue;
    const refs = byClass.get(cls) ?? [];
    refs.push(ref);
    byClass.set(cls, refs);
  }
  return [...byClass.entries()]
    .filter(([, refs]) => refs.length >= RECURRING_CLASS_THRESHOLD)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([cls, refs]) => ({ cls, refs: refs.sort() }));
}

/**
 * Deterministic host-side composition. Zero evidence ⇒ [] (AC4). Stable
 * ordering: kind blocks (router → threshold → skill), then detector order
 * (shapes/regressions/classes sorted); seq ids in emission order.
 */
export function composeProposals(input: ComposeInput): ProposalRecord[] {
  const { week, firedAt, evidence, reflects, reflect_ok, banks } = input;
  const hasEvidence =
    evidence.routingLines.length > 0 || evidence.kpiSnapshots.length > 0 || evidence.runRecords.length > 0;
  if (!hasEvidence) return [];

  // target_bank: the first bank whose reflect SUCCEEDED, else the lane default
  // (first -dev-meta-suffixed bank), else the first bank given. No bank at all
  // ⇒ no composable valid proposal ([]).
  const reflectOk = reflects.filter((r) => reflect_ok[r.bankId] === true).map((r) => r.bankId);
  const targetBank = reflectOk[0] ?? banks.find((b) => b.endsWith("-dev-meta")) ?? banks[0];
  if (targetBank === undefined || targetBank === "") return [];
  // insights_cited at ingest (F-004): bank-authored text is untrusted — the
  // same severity filter as every extracted name, dropped not kept. On the
  // 0.10.0 wire the reflect response is ONE markdown report (no discrete
  // insights[]), so the citation is that report, verbatim, bounded to the
  // same discipline as rationale() (payload ceilings — see
  // RETAIN_PAYLOAD_MAX_BYTES). Empty report ⇒ nothing to cite ([]).
  const reflectReport = reflects.find((r) => r.bankId === targetBank)?.text ?? "";
  const cited = safeName(reflectReport.slice(0, 200));
  const insights = cited === null || cited.length === 0 ? [] : [cited];

  const stamp = firedAt.replace(/[:.]/g, "-"); // kpi-snapshot-write.ts:52 idiom
  let seq = 0;
  const nextId = (): string => `l4-proposal-${week}-${stamp}-${String(++seq).padStart(3, "0")}`;
  const rationale = (text: string): string => text.slice(0, PROPOSAL_RATIONALE_CHAR_CEILING);

  const proposals: ProposalRecord[] = [];

  for (const { shape, cheaper, costlier } of routerTuningFindings(evidence.routingLines)) {
    proposals.push({
      schema: "qds.l4-proposal",
      proposal_id: nextId(),
      kind: "router-tuning",
      week,
      fired_at: firedAt,
      target_bank: targetBank,
      advisory: false,
      rationale: rationale(
        `${cheaper.refs.length} ${embed(shape)} decisions on the cheaper tier ${embed(cheaper.tier)} score ${cheaper.mean.toFixed(3)} on average, at or above the ${costlier.refs.length} decisions on ${embed(costlier.tier)} (${costlier.mean.toFixed(3)}). Routing lines cited verbatim; propose moving ${embed(shape)} from ${embed(costlier.tier)} to ${embed(cheaper.tier)} in the operator's own change.`,
      ),
      suggested_change: {
        area: "router",
        summary: `move shape "${embed(shape)}" from ${embed(costlier.tier)} to ${embed(cheaper.tier)} (equal mean composite score, lower cost)`,
      },
      evidence: {
        routing_log_refs: [...cheaper.refs, ...costlier.refs].sort(),
        // The router detector reads routing lines only — kpi_snapshot_refs stays
        // empty so citations name exactly what was used (F-028, AC4 truthfulness).
        kpi_snapshot_refs: [],
        run_record_refs: [],
      },
      insights_cited: insights,
      created_at: firedAt,
    });
  }

  for (const { ref, kpi, counter, value } of counterRegressions(evidence)) {
    proposals.push({
      schema: "qds.l4-proposal",
      proposal_id: nextId(),
      kind: "threshold-suggestion",
      week,
      fired_at: firedAt,
      target_bank: targetBank,
      advisory: true,
      adjudicator: "operator",
      j2_gate_note: J2_GATE_NOTE,
      rationale: rationale(
        `Snapshot ${embed(ref)}: KPI ${embed(kpi)} is measured while its counter-metric ${embed(counter)} reads ${value} — the counter pair is regressing against the primary. Suggest the operator review the associated arm threshold themselves; this proposal does not satisfy J2's DD-21 milestone gate.`,
      ),
      suggested_change: {
        area: "threshold",
        summary: `operator review of the ${embed(kpi)} arm threshold: counter ${embed(counter)} regressed to ${value}`,
      },
      evidence: { routing_log_refs: [], kpi_snapshot_refs: [ref], run_record_refs: [] },
      insights_cited: insights,
      created_at: firedAt,
    });
  }

  for (const { cls, refs } of recurringClasses(evidence)) {
    proposals.push({
      schema: "qds.l4-proposal",
      proposal_id: nextId(),
      kind: "skill-update",
      week,
      fired_at: firedAt,
      target_bank: targetBank,
      advisory: false,
      rationale: rationale(
        `${refs.length} run records this week share the failure class "${embed(cls)}" (${refs.map(embed).join(", ")}). A recurring class is a skill-doc gap: suggest the operator update the relevant skill documentation for that class.`,
      ),
      suggested_change: {
        area: "skill",
        summary: `update skill documentation for recurring failure class "${embed(cls)}" (${refs.length} records)`,
      },
      evidence: { routing_log_refs: [], kpi_snapshot_refs: [], run_record_refs: refs },
      insights_cited: insights,
      created_at: firedAt,
    });
  }

  // F-011: the ceiling binds emission, not detection — the first 16 in emission
  // order stand, the rest are never emitted.
  return proposals.slice(0, MAX_PROPOSALS_PER_FIRING);
}
