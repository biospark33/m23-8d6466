/**
 * Round-trip verifier for the Hindsight memory lifecycle (P0.9 AC-1).
 *
 * Drives `HindsightClient` (direct REST) through retain → recall → reflect →
 * consolidate → post-consolidation recall. The "through the SwarmClaw /invoke
 * bridge" proof is a SEPARATE integration test (see research-brief.md "File
 * plan": tests/swarmclaw/bridge-round-trip.test.ts); this module owns only the
 * client.ts-driven lifecycle.
 *
 * Phase-1 semantic match (story AC-1 Phase-1 clause): a recalled result is
 * considered "relevant" if its content contains the key tokens from the
 * retained content (token-overlap heuristic). Quantitative score ≥0.8 is
 * Phase-2 — explicitly out of scope here.
 *
 * Timeouts (CC-7): per-op timeouts live in client.ts (recall 10s etc.). This
 * module only RECORDS durations; it does not enforce its own deadlines.
 *
 * Observability (CC-9): each op logs via P0.7 `log()` with the canonical
 * `{requestId, operation, bankId, timestamp, duration, status, error?}` shape.
 * Metrics emitted as log fields: `recall_ms`, `consolidate_ms`, `round_trip_ms`.
 * `slow_query:true` advisory when recall exceeds the 5s semantic target (AC-7).
 *
 * Error surface (CC-W3 surface (b)): on `HindsightHttpError` from any op,
 * returns `{ok:false, error:{code,message}, requestId, step}` — NOT shaped as
 * `MCPInvokeErrorResponseSchema` (that is the bridge path, surface (a)).
 */

import type { HindsightClient } from "./client.ts";
import { HindsightHttpError } from "./client.ts";
import { log, newRequestId } from "../swarmclaw/mcp/stdio-transport.ts";

// ---------------------------------------------------------------------------
// Defaults — deterministic test memory (AC-1 example content).
// ---------------------------------------------------------------------------

const DEFAULT_CONTENT = "Sprint planning uses SPARC methodology";
const DEFAULT_QUERY = "planning methodology";

/**
 * Recall limit for the verifier's recall calls. Default is 5, but on a bank
 * that already holds ≥5 unrelated memories, the just-retained test memory may
 * rank below the fold → false recall_content_mismatch. 50 (schema max) keeps
 * the verifier robust on non-pristine banks. Ponytail: could be tunable; YAGNI.
 */
const VERIFIER_RECALL_LIMIT = 50;

/** Tokens with ≥3 chars, lowercased — crude but sufficient for Phase-1. */
const STOPWORD_MIN_LEN = 3;

function keyTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length >= STOPWORD_MIN_LEN);
}

/** Escape regex special chars in a token for safe embedding. Ponytail: minimal. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Phase-1 relevance: true if any recalled result's content contains ALL of the
 * retained content's key tokens (order-independent, token-boundary match).
 * Ponytail: O(n*m) scan, fine for the test-memory scale; upgrade to a real
 * similarity score in Phase-2.
 */
function resultsContainRetainedTokens(
  results: readonly { content: string }[],
  retainedContent: string,
): boolean {
  const tokens = keyTokens(retainedContent);
  if (tokens.length === 0) {
    // No key tokens (all <3 chars / non-Latin) — fall back to whole-content
    // substring match so short content still validates the round-trip.
    const needle = retainedContent.toLowerCase();
    return results.some((r) => r.content.toLowerCase().includes(needle));
  }
  // Token-boundary match per token: avoids false positives like "spa" matching
  // inside "spark". (?:^|[^a-z0-9]) + token + (?:[^a-z0-9]|$), case-insensitive.
  const tokenRes = tokens.map(
    (t) => new RegExp(`(?:^|[^a-z0-9])${escapeRegex(t)}(?:[^a-z0-9]|$)`, "i"),
  );
  return results.some((r) => tokenRes.every((re) => re.test(r.content)));
}

/**
 * Derive a recall query from retained content: first 1-2 significant tokens
 * (≥3 chars). Ponytail: crude but sufficient for Phase-1; the verifier only
 * needs recall to surface the just-retained memory.
 */
function deriveQuery(content: string): string {
  const tokens = content
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= STOPWORD_MIN_LEN)
    .slice(0, 2);
  return tokens.length > 0 ? tokens.join(" ") : DEFAULT_QUERY;
}

// ---------------------------------------------------------------------------
// Map HindsightHttpError.status → readable {code,message} (CC-W3 surface (b)).
// ---------------------------------------------------------------------------

function mapHttpError(err: HindsightHttpError): { code: string; message: string } {
  if (err.status === 408) {
    return { code: "timeout", message: err.message };
  }
  if (err.status >= 500) {
    return { code: "bad_gateway", message: err.message };
  }
  return { code: `http_${err.status}`, message: err.message };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VerifyRoundTripOptions {
  client: HindsightClient;
  bankId: string;
  /** Defaults to a deterministic test memory. */
  content?: string;
  /** Defaults to a query derived from the content. */
  query?: string;
  requestId?: string;
}

export interface RoundTripDurations {
  retain: number;
  recall: number;
  reflect: number;
  consolidate: number;
  /** retain+recall+reflect+consolidate+post-consolidation recall wall clock. */
  total: number;
}

export interface RoundTripOk {
  ok: true;
  memoryId: string;
  recallMatches: boolean;
  insightCount: number;
  consolidatedCount: number;
  preservedCount: number;
  durations: RoundTripDurations;
  /** True when the initial recall exceeded the 5s semantic target (AC-7). */
  slowQuery: boolean;
  requestId: string;
}

export interface RoundTripErr {
  ok: false;
  /** Which lifecycle step failed. */
  step: "retain" | "recall" | "reflect" | "consolidate" | "post_consolidate_recall";
  error: { code: string; message: string };
  requestId: string;
}

export type RoundTripResult = RoundTripOk | RoundTripErr;

// ---------------------------------------------------------------------------
// verifyRoundTrip
// ---------------------------------------------------------------------------

const SLOW_QUERY_THRESHOLD_MS = 5_000; // AC-7 semantic target

/**
 * Run the make-or-break Hindsight round-trip on `bankId`:
 *   retain → recall → reflect → consolidate → post-consolidation recall.
 *
 * Returns a discriminated union; check `.ok` first. On `HindsightHttpError`
 * from any op, returns `{ok:false, step, error:{code,message}, requestId}`.
 */
export async function verifyRoundTrip(
  opts: VerifyRoundTripOptions,
): Promise<RoundTripResult> {
  const { client, bankId } = opts;
  const content = opts.content ?? DEFAULT_CONTENT;
  // Derive query from content when caller supplied content but no query, so a
  // custom-content caller without an explicit query still recalls sensibly.
  const query = opts.query ?? (opts.content ? deriveQuery(opts.content) : DEFAULT_QUERY);
  const requestId = opts.requestId ?? newRequestId();

  const wallStart = Date.now();
  const durations: RoundTripDurations = {
    retain: 0,
    recall: 0,
    reflect: 0,
    consolidate: 0,
    total: 0,
  };

  // --- Step 1: retain -----------------------------------------------------
  let memoryId: string;
  {
    const start = Date.now();
    let status: "ok" | "error" = "ok";
    let errMsg: { code: string; message: string } | undefined;
    try {
      const res = await client.retain(bankId, content);
      memoryId = res.memoryId;
      durations.retain = res.durationMs;
    } catch (e) {
      status = "error";
      if (e instanceof HindsightHttpError) {
        errMsg = mapHttpError(e);
        log({
          requestId,
          operation: "retain",
          bankId,
          agentId: null,
          timestamp: new Date().toISOString(),
          duration: Date.now() - start,
          status,
          error: errMsg,
        });
        return { ok: false, step: "retain", error: errMsg, requestId };
      }
      errMsg = { code: "unknown", message: (e as Error).message };
      log({
        requestId,
        operation: "retain",
        bankId,
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: Date.now() - start,
        status,
        error: errMsg,
      });
      return { ok: false, step: "retain", error: errMsg, requestId };
    }
    log({
      requestId,
      operation: "retain",
      bankId,
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: durations.retain,
      status,
      ...(errMsg ? { error: errMsg } : {}),
    });
  }

  // --- Step 2: recall -----------------------------------------------------
  let recallMatches = false;
  let slowQuery = false;
  {
    const start = Date.now();
    let status: "ok" | "error" = "ok";
    let errMsg: { code: string; message: string } | undefined;
    let recallMs = 0;
    let results: readonly { content: string }[] = [];
    try {
      const res = await client.recall(bankId, query, VERIFIER_RECALL_LIMIT);
      recallMs = res.durationMs;
      durations.recall = recallMs;
      results = res.results;
    } catch (e) {
      status = "error";
      if (e instanceof HindsightHttpError) {
        errMsg = mapHttpError(e);
      } else {
        errMsg = { code: "unknown", message: (e as Error).message };
      }
      log({
        requestId,
        operation: "recall",
        bankId,
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: Date.now() - start,
        status,
        recall_ms: recallMs,
        error: errMsg,
      });
      return { ok: false, step: "recall", error: errMsg, requestId };
    }
    // AC-1: recall must be non-empty AND contain a result matching the content.
    if (results.length === 0) {
      errMsg = {
        code: "empty_recall",
        message: "recall returned no results",
      };
      status = "error";
      log({
        requestId,
        operation: "recall",
        bankId,
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: Date.now() - start,
        status,
        recall_ms: recallMs,
        error: errMsg,
      });
      return { ok: false, step: "recall", error: errMsg, requestId };
    }
    recallMatches = resultsContainRetainedTokens(results, content);
    if (!recallMatches) {
      errMsg = {
        code: "recall_content_mismatch",
        message: "recall returned results but none matched the retained content tokens",
      };
      status = "error";
      log({
        requestId,
        operation: "recall",
        bankId,
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: Date.now() - start,
        status,
        recall_ms: recallMs,
        error: errMsg,
      });
      return { ok: false, step: "recall", error: errMsg, requestId };
    }
    slowQuery = recallMs > SLOW_QUERY_THRESHOLD_MS;
    log({
      requestId,
      operation: "recall",
      bankId,
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: Date.now() - start,
      status,
      recall_ms: recallMs,
      ...(slowQuery ? { slow_query: true } : {}),
    });
  }

  // --- Step 3: reflect ----------------------------------------------------
  let insightCount = 0;
  {
    const start = Date.now();
    let status: "ok" | "error" = "ok";
    let errMsg: { code: string; message: string } | undefined;
    let reflectMs = 0;
    let insights: readonly { summary: string }[] = [];
    try {
      const res = await client.reflect(bankId, query);
      reflectMs = res.durationMs;
      durations.reflect = reflectMs;
      insights = res.insights;
    } catch (e) {
      status = "error";
      if (e instanceof HindsightHttpError) {
        errMsg = mapHttpError(e);
      } else {
        errMsg = { code: "unknown", message: (e as Error).message };
      }
      log({
        requestId,
        operation: "reflect",
        bankId,
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: Date.now() - start,
        status,
        error: errMsg,
      });
      return { ok: false, step: "reflect", error: errMsg, requestId };
    }
    if (insights.length === 0) {
      errMsg = { code: "empty_insights", message: "reflect returned no insights" };
      status = "error";
      log({
        requestId,
        operation: "reflect",
        bankId,
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: Date.now() - start,
        status,
        error: errMsg,
      });
      return { ok: false, step: "reflect", error: errMsg, requestId };
    }
    if (!insights.every((i) => typeof i.summary === "string" && i.summary.length > 0)) {
      errMsg = { code: "invalid_insights", message: "reflect returned an insight with empty summary" };
      status = "error";
      log({
        requestId,
        operation: "reflect",
        bankId,
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: Date.now() - start,
        status,
        error: errMsg,
      });
      return { ok: false, step: "reflect", error: errMsg, requestId };
    }
    insightCount = insights.length;
    log({
      requestId,
      operation: "reflect",
      bankId,
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: durations.reflect,
      status,
    });
  }

  // --- Step 4: consolidate ------------------------------------------------
  let consolidatedCount = 0;
  let preservedCount = 0;
  {
    const start = Date.now();
    let status: "ok" | "error" = "ok";
    let errMsg: { code: string; message: string } | undefined;
    let consolidateMs = 0;
    try {
      const res = await client.consolidate(bankId);
      consolidateMs = res.durationMs;
      durations.consolidate = consolidateMs;
      consolidatedCount = res.consolidatedCount;
      preservedCount = res.preservedCount;
      if (!Number.isFinite(consolidatedCount) || consolidatedCount < 0) {
        throw new Error(`invalid consolidatedCount: ${consolidatedCount}`);
      }
      if (!Number.isFinite(preservedCount) || preservedCount < 0) {
        throw new Error(`invalid preservedCount: ${preservedCount}`);
      }
    } catch (e) {
      status = "error";
      if (e instanceof HindsightHttpError) {
        errMsg = mapHttpError(e);
      } else {
        errMsg = { code: "unknown", message: (e as Error).message };
      }
      log({
        requestId,
        operation: "consolidate",
        bankId,
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: Date.now() - start,
        status,
        consolidate_ms: consolidateMs,
        error: errMsg,
      });
      return { ok: false, step: "consolidate", error: errMsg, requestId };
    }
    log({
      requestId,
      operation: "consolidate",
      bankId,
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: durations.consolidate,
      status,
      consolidate_ms: consolidateMs,
    });
  }

  // --- Step 5: post-consolidation recall (AC-1: content preserved) --------
  {
    const start = Date.now();
    let status: "ok" | "error" = "ok";
    let errMsg: { code: string; message: string } | undefined;
    let results: readonly { content: string }[] = [];
    let postRecallMs = 0;
    try {
      const res = await client.recall(bankId, query, VERIFIER_RECALL_LIMIT);
      postRecallMs = res.durationMs;
      results = res.results;
      // AC-7 advisory covers BOTH recalls — flag slow on the post-consolidation
      // recall too, not just the initial one.
      if (postRecallMs > SLOW_QUERY_THRESHOLD_MS) slowQuery = true;
    } catch (e) {
      status = "error";
      if (e instanceof HindsightHttpError) {
        errMsg = mapHttpError(e);
      } else {
        errMsg = { code: "unknown", message: (e as Error).message };
      }
      log({
        requestId,
        operation: "recall",
        bankId,
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: Date.now() - start,
        status,
        recall_ms: postRecallMs,
        error: errMsg,
      });
      return { ok: false, step: "post_consolidate_recall", error: errMsg, requestId };
    }
    const preserved = resultsContainRetainedTokens(results, content);
    if (!preserved) {
      errMsg = {
        code: "post_consolidate_mismatch",
        message: "post-consolidation recall did not return the retained content",
      };
      status = "error";
      log({
        requestId,
        operation: "recall",
        bankId,
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: Date.now() - start,
        status,
        recall_ms: postRecallMs,
        error: errMsg,
      });
      return {
        ok: false,
        step: "post_consolidate_recall",
        error: errMsg,
        requestId,
      };
    }
    log({
      requestId,
      operation: "recall",
      bankId,
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: Date.now() - start,
      status,
      recall_ms: postRecallMs,
    });
  }

  // total = sum of the four Hindsight op durations (the meaningful "time in
  // Hindsight" metric). Wall clock (Date.now - wallStart) would also include
  // inter-op gaps; we keep `wallStart` around for future profiling but report
  // the op-time sum as round_trip_ms since that is what CC-9 calls the
  // "retain→recall→reflect→consolidate cycle duration".
  durations.total =
    durations.retain + durations.recall + durations.reflect + durations.consolidate;
  void wallStart; // retained for future wall-clock profiling

  // CC-9: round_trip_ms emitted once at the end. Capture into a local so the
  // logged value can never desync from the returned value.
  const roundTripMs = durations.total;
  log({
    requestId,
    operation: "round_trip",
    bankId,
    agentId: null,
    timestamp: new Date().toISOString(),
    duration: roundTripMs,
    status: "ok",
    round_trip_ms: roundTripMs,
    recall_ms: durations.recall,
    consolidate_ms: durations.consolidate,
    ...(slowQuery ? { slow_query: true } : {}),
  });

  return {
    ok: true,
    memoryId,
    recallMatches,
    insightCount,
    consolidatedCount,
    preservedCount,
    durations,
    slowQuery,
    requestId,
  };
}
