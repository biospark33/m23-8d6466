/**
 * J3 model-router decision layer — the deterministic composite score that
 * picks dispatch's applied model tier, plus the ONE recording-only Jev
 * recommendation recorded beside it (story j3-model-router-decision-layer).
 *
 * Order of operations IS the AC1/AC2 contract, so it is stated once here:
 * score → shape → risk_tier → applied_tier → appliedPairs are computed FIRST,
 * purely from host-side features. The Jev ask is then a RECORDING-ONLY
 * recommendation (D-5 LOCKED #5 — the applied path consumes zero Jev
 * numerics) through the seam's one public door, the src/judgment barrel;
 * finally the decision lands as exactly one `.sandbox/routing-log.jsonl`
 * line, appended under a single-writer file lock. No ask failure (AC2) and
 * no log-write failure ever throws past runRouting — dispatch proceeds on
 * the deterministic tier either way.
 *
 * Weights and the tier table are CODE-OWNED constants with stated
 * derivations, deliberately not config: a config file drifts silently, and
 * this story's only weight invariant is determinism + re-derivability (AC3).
 *
 * Fence: src/judgment/ imports only src/lib/{http,log}.ts plus its own
 * siblings (tests/judgment/fence.test.ts). The ONE sanctioned addition is
 * ../lib/file-lock.ts — AC2's single-writer append for the routing log (the
 * corpus-lock idiom, plan C11/C2).
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { acquireFileLock, isPidDead } from "../lib/file-lock.ts";
import { log, newRequestId } from "../lib/log.ts";
import {
  CeilingExceededError,
  EgressRefusedError,
  JudgmentCeiling,
  JudgmentClient,
  JudgmentConfigError,
  JudgmentHttpError,
  JudgmentSchemaError,
  type Question,
} from "./index.ts";

// ---------------------------------------------------------------------------
// Features (AC1 negative control: deterministic and code-owned — never env,
// never config; dispatch DERIVES the values, this module only scores them).
// ---------------------------------------------------------------------------

export const FEATURE_NAMES = [
  "manifest_task_count",
  "manifest_phase_count",
  "roster_role_count",
  "brief_path_mentions",
  "prior_completion_rate",
  "prior_spend_micro_usd",
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];
/** Derived host-side by dispatch before the hook fires; never read from disk here. */
export type RoutingFeatures = Record<FeatureName, number>;

/**
 * Normalization caps — each feature contributes min(value/cap, 1), so the cap
 * is "the value at which this term saturates". Derivations state the observed
 * distribution each cap covers.
 */
export const FEATURE_CAPS: Readonly<Record<FeatureName, number>> = Object.freeze({
  // dispatch_task manifests in this repo carry 1-3 tasks; the cap covers twice
  // that, so a merely busy manifest never saturates the strongest term.
  manifest_task_count: 6,
  // Phases are coarse stage groupings — 1-2 is the norm; 4 is already a
  // multi-stage pipeline and saturates.
  manifest_phase_count: 4,
  // Rosters run 1-4 roles routinely; 8 covers the largest roster in
  // config/rosters/ and saturates beyond it.
  roster_role_count: 8,
  // Briefs naming ~20 file paths imply a whole-directory rewrite; counts past
  // that are prose noise, not proportionally wider blast radius.
  brief_path_mentions: 20,
  // The rate is already a 0..1 fraction — the cap is the identity.
  prior_completion_rate: 1,
  // $50 cumulative lookback spend (micro-USD unit) marks a heavy consumer.
  prior_spend_micro_usd: 50_000_000,
});

/**
 * Named weights, summing to 1. Complexity features (task 0.28 + phase 0.12 +
 * roster 0.20 + paths 0.16 = 0.76) dominate; prior outcomes (completion 0.16
 * + spend 0.08 = 0.24) only moderate — the tier is about the JOB, not the
 * history.
 */
export const WEIGHTS: Readonly<Record<FeatureName, number>> = Object.freeze({
  // Strongest single proxy: box cost and blast radius scale with task count.
  manifest_task_count: 0.28,
  // Phases multiply coordination, but coarsely — most manifests share one.
  manifest_phase_count: 0.12,
  // Each roster role is a concurrently-driving box — second-strongest proxy.
  roster_role_count: 0.2,
  // Path mentions proxy the touched surface; weaker than the structural
  // counts because prose mentions are noisy.
  brief_path_mentions: 0.16,
  // A repo the factory keeps failing is systematically riskier — moderate only.
  prior_completion_rate: 0.16,
  // Spend correlates with accumulated complexity but also with history length,
  // so it gets the weakest term.
  prior_spend_micro_usd: 0.08,
});

/** Pure and deterministic: Σ WEIGHTS[f] · min(features[f]/FEATURE_CAPS[f], 1). */
export function scoreFeatures(features: RoutingFeatures): number {
  return FEATURE_NAMES.reduce((sum, f) => {
    // A negative count is data corruption, not a discount — clamp to 0.
    const v = Math.max(features[f], 0);
    return sum + WEIGHTS[f] * Math.min(v / FEATURE_CAPS[f], 1);
  }, 0);
}

// ---------------------------------------------------------------------------
// Shape + risk projections (named bands — the cut points ARE the contract).
// ---------------------------------------------------------------------------

export const SHAPES = ["solo-small", "solo-large", "swarm"] as const;
export type Shape = (typeof SHAPES)[number];
export const RISK_TIERS = ["low", "medium", "high"] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

/**
 * Ascending score cut points; the first band with cut ≥ score wins.
 * Derivation: ≤0.25 is at most one moderately-loaded term over a quiet base —
 * a small solo job; ≤0.55 is roughly one saturated term plus moderate others —
 * a large solo job; past that, multiple terms saturate at once and the
 * dispatch is a swarm.
 */
export const SHAPE_BANDS: readonly (readonly [number, Shape])[] = [
  [0.25, "solo-small"],
  [0.55, "solo-large"],
  [Number.POSITIVE_INFINITY, "swarm"],
];

/** Same cuts for risk: the score band IS the base risk. */
const RISK_BANDS: readonly (readonly [number, RiskTier])[] = [
  [0.25, "low"],
  [0.55, "medium"],
  [Number.POSITIVE_INFINITY, "high"],
];

function bandLookup<T extends string>(bands: readonly (readonly [number, T])[], score: number): T {
  const hit = bands.find(([cut]) => score <= cut);
  // The last band is +∞, so the fallback is unreachable; it satisfies the type.
  return hit ? hit[1] : bands[bands.length - 1]![1];
}

const RISK_LIFT: Readonly<Record<RiskTier, RiskTier>> = Object.freeze({ low: "medium", medium: "high", high: "high" });

/**
 * Derivation: sub-coin-flip history lifts ONE band (< is strict, so exactly
 * 0.5 lifts nothing) — history says the runs go sideways more often than not,
 * so the same structural score earns a more conservative tier.
 *
 * Cross-reference: scripts/fleet.ts's ROUTING_PRIOR_COMPLETION_RATE_DEFAULT is
 * also 0.5 but a DIFFERENT policy that merely coincides — that one is the
 * host-side no-history DATA default, this one is the router's risk threshold;
 * the fence keeps either from importing the other.
 */
export const RISK_LIFT_THRESHOLD = 0.5;

export function riskTier(score: number, features: RoutingFeatures): RiskTier {
  if (features.prior_completion_rate < RISK_LIFT_THRESHOLD) return RISK_LIFT[bandLookup(RISK_BANDS, score)];
  return bandLookup(RISK_BANDS, score);
}

// ---------------------------------------------------------------------------
// Tier table (code-owned, frozen — the pairs proven live on openrouter).
// ---------------------------------------------------------------------------

export const APPLIED_TIERS = ["economy", "standard", "premium"] as const;
export type AppliedTier = (typeof APPLIED_TIERS)[number];
export interface ModelPair {
  provider: string;
  model: string;
}

/** Changed only with a live probe (plan I7): deepseek-v3.2 / haiku-4.5 / sonnet-4.6. */
export const TIER_TABLE: Readonly<Record<AppliedTier, ModelPair>> = Object.freeze({
  economy: Object.freeze({ provider: "openrouter", model: "deepseek/deepseek-v3.2" }),
  standard: Object.freeze({ provider: "openrouter", model: "anthropic/claude-haiku-4.5" }),
  premium: Object.freeze({ provider: "openrouter", model: "anthropic/claude-sonnet-4.6" }),
});

const SHAPE_TIER: Readonly<Record<Shape, AppliedTier>> = Object.freeze({
  "solo-small": "economy",
  "solo-large": "standard",
  swarm: "premium",
});

/** Derivation: the tier tracks blast radius, not grade — a swarm box drives N roles at once, so it rides the strongest pair regardless of how moderate its score is. */
export function appliedTier(shape: Shape): AppliedTier {
  return SHAPE_TIER[shape];
}

/** Per-role resolver at dispatch: every role in the roster rides the tier's pair. */
export function pairForRole(tier: AppliedTier): ModelPair {
  return TIER_TABLE[tier];
}

// ---------------------------------------------------------------------------
// Skip taxonomy (AC2 enumerated — never free-text).
// ---------------------------------------------------------------------------

export const SKIP_REASONS = ["timeout", "vendor-error", "ceiling-exceeded", "egress-refused", "provider-unavailable"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/**
 * Timeout-ish = 408 (the jev adapter's own per-attempt budget,
 * adapters/jev.ts onTransportError) or 504 (an upstream gateway cut the ask
 * off) — both mean "ran out of time", distinct from a vendor that answered
 * badly. Schema refusal is the vendor's body → vendor-error; config refusal
 * (live mode without a key) and anything unexpected → provider-unavailable.
 */
function skipReasonFor(e: unknown): SkipReason {
  if (e instanceof JudgmentSchemaError) return "vendor-error";
  if (e instanceof JudgmentHttpError) return e.status === 408 || e.status === 504 ? "timeout" : "vendor-error";
  if (e instanceof CeilingExceededError) return "ceiling-exceeded";
  if (e instanceof EgressRefusedError) return "egress-refused";
  if (e instanceof JudgmentConfigError) return "provider-unavailable"; // live mode without a key
  return "provider-unavailable"; // anything unexpected
}

// ---------------------------------------------------------------------------
// The routing log (`.sandbox/routing-log.jsonl`) — this story's owned contract.
// ---------------------------------------------------------------------------

/** Repo-root spelling of the routing-log path, kept for operators and readers (docs, grep, human debugging). The WRITER roots at the .sandbox dir itself (RoutingOptions.logDir, `join(logDir, "routing-log.jsonl")`), so production paths live under the store's sandbox, not the repo root. */
export const ROUTING_LOG_PATH = ".sandbox/routing-log.jsonl";
export const ROUTING_LOCK_ID = "routing-log-writer";
/** Blocking budget per acquire attempt (AC2 single-writer posture). */
const ROUTING_LOCK_TIMEOUT_MS = 5_000;
/** One retry, then the line is lost LOUDLY (see writeRoutingLogLine). */
const ROUTING_LOCK_ATTEMPTS = 2;
/** A lock older than this is stale — the ask itself is bounded ~30s, so no live holder is legitimately older. */
const ROUTING_LOCK_STALE_MS = 30_000;

/** The full feature vector (AC3) — every component present, no extras, so the tier never rests on inputs a log cannot show. */
export const FeatureVectorSchema = z
  .object({
    manifest_task_count: z.number(),
    manifest_phase_count: z.number(),
    roster_role_count: z.number(),
    brief_path_mentions: z.number(),
    prior_completion_rate: z.number(),
    prior_spend_micro_usd: z.number(),
  })
  .strict();

export const RoutingLogLineSchema = z
  .object({
    workKey: z.string().min(1),
    runId: z.string().min(1),
    shape: z.enum(SHAPES),
    risk_tier: z.enum(RISK_TIERS),
    applied_tier: z.enum(APPLIED_TIERS),
    score: FeatureVectorSchema,
    jev_recommendation: z.string().nullable(),
    jev_requestId: z.string().nullable(),
    jev_skipped: z.object({ reason: z.enum(SKIP_REASONS) }).strict().nullable(),
    created_at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
      message: "created_at must be an ISO-8601 timestamp",
    }),
    // OPTIONAL so lines written before this field stay readable; the writer
    // ALWAYS writes 1. This log is append-only across runs — strict-without-
    // version made every future field a mass-corrupt-line upgrade, and the
    // version lets M3.2's reader branch instead of refusing old lines.
    schema_version: z.number().int().min(1).max(15).optional(),
  })
  .strict()
  // Exactly-one-of: the ask either produced a provenance-carrying envelope
  // (requestId on the line) or it did not complete (skip) — never both,
  // never neither.
  .refine((l) => (l.jev_requestId !== null) !== (l.jev_skipped !== null), {
    message: "jev_requestId and jev_skipped are mutually exclusive and jointly required",
  });
export type RoutingLogLine = z.infer<typeof RoutingLogLineSchema>;

/** Parsed-line ceiling: the log grows unbounded across runs and the retain leg needs only its run's lines, so the cap bounds a pathological or adversarial file (the head past the cap is dropped, not an error). */
const ROUTING_LOG_PARSE_CAP = 10_000;
/** Byte ceiling checked BEFORE the whole-file read: ~10× the parse cap's worth of lines. A file this large is pathological — refuse it (house error, []) rather than load it. */
const ROUTING_LOG_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Module-local scrub for the corrupt-line echo. The fence keeps
 * redactSecrets (src/providers) out of src/judgment, so this is the
 * derivation-light cousin: drop printable runs that look like key material
 * (\b anchors it, so "monkey: x" survives), then JSON-encode to escape any
 * remaining control chars before the text lands in a house log line. A
 * conservative over-match is fine — this text only ever goes to the error log.
 */
function scrubLogText(text: string): string {
  return JSON.stringify(text.replace(/\b(key|token|secret|bearer)[=: ]+\S+/gi, "$1=[redacted]"));
}

/**
 * Strict-parsing reader for the retain leg (leaf-1.3.1) and the M3.2/A5
 * read-side. One zod parse per line; a corrupt line skips LOUDLY (house error)
 * and never throws — an old or damaged line must not fail a harvest. A missing
 * file is a legitimate state (no dispatches yet) and reads as [].
 *
 * The optional filter is byte-level BEFORE the parse: runId substring-matches
 * the raw line (cheap — whole files skip zod), maxLines keeps the LAST
 * maxLines parsed lines (the log is append-only, so the tail is the newest —
 * the head is dropped, not an error). The whole-file read is accepted and
 * bounded above by ROUTING_LOG_MAX_BYTES. Optional, so callers that want the
 * whole log keep the one-arg spelling.
 */
export function readRoutingLog(path: string, filter?: { runId?: string; maxLines?: number }): RoutingLogLine[] {
  try {
    if (statSync(path).size > ROUTING_LOG_MAX_BYTES) {
      houseError("", "routing-log-oversize", `routing log ${path} exceeds ROUTING_LOG_MAX_BYTES (${ROUTING_LOG_MAX_BYTES} bytes) — refusing to read`);
      return [];
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; // raced away between stat and read
    throw e;
  }
  const needle = filter?.runId === undefined ? null : `"runId":"${filter.runId}"`;
  const cap = filter?.maxLines ?? ROUTING_LOG_PARSE_CAP;
  const out: RoutingLogLine[] = [];
  for (const lineText of raw.split("\n")) {
    if (lineText.trim() === "") continue;
    if (needle !== null && !lineText.includes(needle)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lineText);
    } catch {
      parsed = undefined;
    }
    const result = RoutingLogLineSchema.safeParse(parsed);
    if (!result.success) {
      houseError("", "routing-log-corrupt-line", `skipping unparsable routing-log line: ${scrubLogText(lineText.slice(0, 120))}`);
      continue;
    }
    out.push(result.data);
  }
  // The cap keeps the TAIL: with an append-only log the last lines are the
  // newest, so the oldest are what gets dropped.
  return cap >= out.length ? out : out.slice(out.length - cap);
}

// ---------------------------------------------------------------------------
// The ask (AC1: one door — the barrel — and recording-only).
// ---------------------------------------------------------------------------

/**
 * The ONE question per dispatch, framed for weekly review — never applied
 * (D-5 LOCKED #5). The per-option prose is derived from TIER_TABLE so a table
 * change updates the vendor-facing question; the option KEYS keep economy
 * first — the mock adapter returns the first key, and the recording-only
 * e2e (and this suite) depend on "economy" being it.
 */
const TIER_QUESTION: Question = {
  type: "choice",
  instructions:
    "Recommend a model tier for this dispatch. This is a RECORDING-ONLY recommendation for weekly operator review: the applied tier was already computed deterministically from host-side features and will NOT change based on your answer.",
  criteria: {
    economy: `cheapest pair (${TIER_TABLE.economy.model}) — fits a small, well-scoped solo job`,
    standard: `mid pair (${TIER_TABLE.standard.model}) — fits a larger solo job with moderate blast radius`,
    premium: `strongest pair (${TIER_TABLE.premium.model}) — fits a multi-role swarm`,
  },
};

/** House log line, guarded — a log() must never crash its caller. The requestId is NEVER the Jev envelope id: this line is the ROUTER's. */
function houseError(runId: string, code: string, message: string): void {
  try {
    log({
      requestId: newRequestId(),
      operation: "judge",
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: 0,
      status: "error",
      runId,
      error: { code, message: message.slice(0, 512) },
    });
  } catch {
    // house rule
  }
}

/**
 * Append ONE line under the single-writer lock. Two attempts; a lock that
 * cannot be taken loses the line LOUDLY (house error) but never the dispatch —
 * appending WITHOUT the lock is forbidden, because a torn/interleaved line is
 * exactly the dropped-line bug class the lock exists for. Returns null on
 * success, else the house-error code + message.
 */
async function writeRoutingLogLine(
  line: RoutingLogLine,
  logDir: string,
  lockTimeoutMs: number,
): Promise<{ code: string; message: string } | null> {
  const path = join(logDir, "routing-log.jsonl");
  let release: (() => void) | null = null;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (e) {
    return { code: "routing-log-write-failed", message: `mkdir for routing log failed: ${(e as Error).message}` };
  }
  const lockPath = join(dirname(path), `${ROUTING_LOCK_ID}.lock`);
  for (let attempt = 0; attempt < ROUTING_LOCK_ATTEMPTS && release === null; attempt++) {
    try {
      release = await acquireFileLock(lockPath, {
        label: "routing log",
        isStale: (c) => (c.pid !== undefined && isPidDead(c.pid)) || c.ageMs > ROUTING_LOCK_STALE_MS,
        block: { timeoutMs: lockTimeoutMs, pollMs: 25 },
      });
    } catch {
      // retried below; after the last attempt the line is lost (loudly, caller-side)
    }
  }
  if (release === null) {
    return {
      code: "routing-log-lock-timeout",
      message: `routing log line for run ${line.runId} lost: single-writer lock ${lockPath} could not be taken in ${lockTimeoutMs}ms ×${ROUTING_LOCK_ATTEMPTS}`,
    };
  }
  try {
    appendFileSync(path, `${JSON.stringify(line)}\n`);
    return null;
  } catch (e) {
    return { code: "routing-log-write-failed", message: `routing log append failed: ${(e as Error).message}` };
  } finally {
    try {
      release();
    } catch {
      // a stolen/expired lock is the next holder's problem — never crash the dispatch
    }
  }
}

// ---------------------------------------------------------------------------
// runRouting — the one entry the host-side dispatch hook calls.
// ---------------------------------------------------------------------------

export interface RoutingInput {
  runId: string;
  /** Dispatch's correlation id; seeds the Jev envelope id so provenance joins are stable. */
  requestId: string;
  repoSlug: string;
  issueKey: string;
  features: RoutingFeatures;
  rosterRoles: string[];
}

export interface RoutingOptions {
  /** Test-only: build the seam client (tests inject tmp-provenance mock clients). */
  clientFactory?: () => JudgmentClient;
  /** Test-only/ops: the .sandbox DIR the log file lives in — an explicit override of the sandbox dir. Default (production hook): derived from the store, `dirname(store.dir)`; the runRouting fallback is `<cwd>/.sandbox`. */
  logDir?: string;
  /** Test-only: single-writer lock budget so the lock-timeout path tests in ms, not 2×5s. */
  lockTimeoutMs?: number;
  /** Test-only: root the provenance side channel here instead of the cwd-relative default — an e2e running the REAL default client must not write the repo's own `_bmad-output/judgment/provenance/` (INV-J1 evidence area). */
  provenanceDir?: string;
}

export interface RoutingResult {
  shape: Shape;
  risk_tier: RiskTier;
  applied_tier: AppliedTier;
  appliedPairs: Record<string, ModelPair>;
  recommendation: string | null;
  jev_requestId: string | null;
  jev_skipped: { reason: SkipReason } | null;
  /** The full feature vector the tier rests on — echoes the log line (AC3). */
  score: RoutingFeatures;
}

/**
 * One dispatch's routing decision. NEVER throws past the ask/log folds
 * (AC2): an ask failure folds to jev_skipped, a log-write failure loses the
 * line loudly (house error) — the decision itself always returns.
 */
export async function runRouting(input: RoutingInput, opts: RoutingOptions = {}): Promise<RoutingResult> {
  const started = Date.now();
  // The log is rooted at the .sandbox DIR (not the repo root): the store dir
  // it describes lives there, so the writer, the retain leg and every reader
  // derive ONE root from the same store — and a test store under a tmpdir
  // roots its own log with no chdir and no repo pollution (review round 1).
  // The default reproduces ROUTING_LOG_PATH's repo-root spelling exactly.
  const logDir = opts.logDir ?? join(process.cwd(), ".sandbox");

  // 1. The applied pick FIRST — purely deterministic, before any ask exists.
  const score = scoreFeatures(input.features);
  const shape = bandLookup(SHAPE_BANDS, score);
  const risk_tier = riskTier(score, input.features);
  const applied_tier = appliedTier(shape);
  const pair = pairForRole(applied_tier);
  const appliedPairs: Record<string, ModelPair> = Object.fromEntries(input.rosterRoles.map((r) => [r, pair]));

  // 2. ONE seam-mediated, recording-only ask. The client is built per dispatch
  // (mock is the default — INV-J5; TYPESAFE_MOCK=1 forces it) with the
  // router's OWN stage ceiling (1M default, handoff §3.2). provenanceDir stays
  // the seam's production default (plan I5) — tests override it via
  // clientFactory, never here.
  let recommendation: string | null = null;
  let jev_requestId: string | null = null;
  let jev_skipped: { reason: SkipReason } | null = null;
  const askStarted = Date.now();
  try {
    const client =
      opts.clientFactory?.() ??
      new JudgmentClient({
        requestId: input.requestId,
        // Conditional spread: absent ⇒ byte-identical to the pre-option spelling (the M1.2 kgContext precedent).
        ...(opts.provenanceDir === undefined ? {} : { provenanceDir: opts.provenanceDir }),
      });
    const envelope = await client.judge(
      JSON.stringify({
        repoSlug: input.repoSlug,
        issueKey: input.issueKey,
        shape,
        risk_tier,
        applied_tier,
        score,
        features: input.features,
      }),
      { tier_recommendation: TIER_QUESTION },
      { egressClass: "ac-prose", ceiling: new JudgmentCeiling() },
    );
    // READING-ONLY of the answer: the recommendation STRING and the envelope
    // id — nothing else. No Jev numeric reaches the applied tier (it was fixed
    // in step 1) and none reaches the log line either.
    const answer = envelope.answers.tier_recommendation;
    if (answer?.type === "choice") recommendation = answer.choice;
    jev_requestId = envelope.requestId;
  } catch (e) {
    jev_skipped = { reason: skipReasonFor(e) };
  }
  const jev_ask_ms = jev_skipped === null ? Date.now() - askStarted : undefined;

  // 3. Exactly ONE routing-log line, appended under the single-writer lock.
  const line: RoutingLogLine = {
    workKey: input.issueKey,
    runId: input.runId,
    shape,
    risk_tier,
    applied_tier,
    score: { ...input.features },
    jev_recommendation: recommendation,
    jev_requestId,
    jev_skipped,
    created_at: new Date().toISOString(),
    schema_version: 1,
  };
  // Reader-contract guard: never append a line the retain leg's strict reader
  // would refuse. Reachable today only via an empty issueKey/runId (workKey and
  // runId are min(1)) — guarded here so a future RoutingInput field can never
  // silently regress the reader contract.
  const check = RoutingLogLineSchema.safeParse(line);
  if (!check.success) {
    const issue = check.error.issues[0];
    houseError(input.runId, "routing-line-schema-refused", `routing log line refused before append: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "unknown issue"}`);
  } else {
    const writeFailure = await writeRoutingLogLine(line, logDir, opts.lockTimeoutMs ?? ROUTING_LOCK_TIMEOUT_MS);
    if (writeFailure !== null) houseError(input.runId, writeFailure.code, writeFailure.message);
  }

  // 4. House log (I4): on a decision the requestId IS the Jev envelope id; on
  // a skip it is a fresh id and jev_ask_ms is ABSENT (not 0 — 0 reads as an
  // instantaneous ask).
  const routerMs = Date.now() - started;
  try {
    if (jev_skipped === null && jev_requestId !== null) {
      log({
        requestId: jev_requestId,
        operation: "judge",
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: routerMs,
        status: "ok",
        runId: input.runId,
        event: "routing-decision",
        router_ms: routerMs,
        shape,
        risk_tier,
        applied_tier,
        jev_ask_ms,
      });
    } else {
      log({
        requestId: newRequestId(),
        operation: "judge",
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: routerMs,
        status: "ok",
        runId: input.runId,
        event: "routing-skip",
        router_ms: routerMs,
        reason: jev_skipped?.reason ?? "provider-unavailable",
        shape,
        risk_tier,
        applied_tier,
      });
    }
  } catch {
    // house rule: log() must never crash its caller
  }

  return {
    shape,
    risk_tier,
    applied_tier,
    appliedPairs,
    recommendation,
    jev_requestId,
    jev_skipped,
    score: { ...input.features },
  };
}
