/**
 * JudgmentClient — house-idiom TypeSafe (Jev) client (JEV-2, handoff §3.3).
 *
 * No SDK: `httpRequest`/`HttpPolicy` from src/lib/http.ts + strict zod
 * schemas, mirroring src/hindsight/client.ts (schemas + mock mode + tests
 * + HindsightHttpError body-carrying). `src/judgment/` imports ONLY
 * src/lib/http.ts + src/swarmclaw/log.ts repo-internally — the two-import
 * fence asserted by tests/judgment/fence.test.ts.
 *
 * INV-J1: `TYPESAFE_API_KEY` is read ONCE here, env-only. Never hardcoded,
 * never logged, never in an envelope or side-channel detail; the client
 * performs no env diagnostics at all.
 * INV-J5: mock is the DEFAULT. No real spend without a key AND steve's go.
 *
 * POST-replay safety (stated at the call site, per the credentials.ts
 * idempotent-verb-only precedent): these POSTs are read-only judgments —
 * replaying the same questions yields the same answers, no server-side
 * state, no charge beyond the input tokens already reported in `usage`.
 * maxAttempts is therefore 2, retryOn 429/529 only; 401/422 are fatal on
 * the first attempt (auth/validation problems do not heal on retry).
 *
 * Judge call order: choke point (validate + redact) → ceiling admit →
 * documented-budget warning → request → strict parse (same path for mock
 * and live) → ceiling record → envelope → side-channel emit → house log.
 */

import { retryAfterMs, httpRequest } from "../lib/http.ts";
import { log, newRequestId, type LogEntry } from "../swarmclaw/log.ts";
import { CeilingExceededError, type JudgmentCeiling } from "./ceiling.ts";
import { detailFromEnvelope, emitProvenance } from "./emit.ts";
import { egress, EgressRefusedError, type EgressClass } from "./egress.ts";
import {
  makeJudgmentResponseSchema,
  TYPESAFE_MODEL,
  type JudgmentRequest,
  type Question,
} from "./schemas.ts";
import type { JudgmentEnvelope } from "./envelope.ts";

export { TYPESAFE_MODEL };

/** Pinned vendor endpoint (handoff §4). `baseUrl` overrides for tests. */
export const TYPESAFE_API_URL = "https://api.typesafe.ai/v1/systemone";
/** Attempts INCLUDING the first — exactly one retry, 429/529 only (§4). */
export const DEFAULT_MAX_ATTEMPTS = 2;
/** Per-attempt budget. A judgment is one round-trip, not a stream. */
export const JUDGE_TIMEOUT_MS = 30_000;
/**
 * Documented, NOT enforced (§4): 64k tokens/request and 32k for state +
 * longest question. Pre-flight state sizing is owned by JEV-3; this warning
 * only marks a state that plausibly exceeds budget.
 */
export const DEFAULT_WARN_STATE_CHARS = 100_000;

export class JudgmentHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly requestId: string,
    /** The (truncated) response body text, for field-level diagnosis. */
    public readonly bodyText: string,
  ) {
    super(message);
    this.name = "JudgmentHttpError";
  }
}

export class JudgmentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgmentConfigError";
  }
}

export interface JudgmentClientOptions {
  /** Default "mock" — INV-J5: every wave runs green with no env key at all. */
  mode?: "live" | "mock";
  /** Base URL override (tests); the path is always /v1/systemone. */
  baseUrl?: string;
  /** Stable requestId override (tests / callers that correlate calls). */
  requestId?: string;
  timeoutMs?: number;
  /** Test-only retry-delay override so backoff tests never sleep wall-clock. */
  retryDelayMs?: number;
  /** Side-channel dir override (tests MUST override — never the real path). */
  provenanceDir?: string;
  /** Log a (non-blocking) budget warning past this many state chars. 0 disables. */
  warnWhenStateCharsOver?: number;
}

export interface JudgeOptions {
  /** The seam's declaration of what it ships (handoff §3.7). Required. */
  egressClass: EgressClass;
  /** One instance per stage, held by the caller (§3.2). */
  ceiling?: JudgmentCeiling;
}

export class JudgmentClient {
  readonly mode: "live" | "mock";
  readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly requestId: string | undefined;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number | undefined;
  private readonly provenanceDir: string;
  private readonly warnWhenStateCharsOver: number;

  constructor(opts: JudgmentClientOptions = {}) {
    // Mode resolution order: TYPESAFE_MOCK === "1" forces mock (any other
    // value, including "0", is ignored) → constructor mode → default mock.
    const forcedMock = process.env.TYPESAFE_MOCK === "1";
    this.mode = forcedMock ? "mock" : (opts.mode ?? "mock");
    // INV-J1: env-only, read once, never echoed anywhere.
    this.apiKey = process.env.TYPESAFE_API_KEY;
    if (this.mode === "live" && !(this.apiKey && this.apiKey.length > 0)) {
      throw new JudgmentConfigError(
        "live mode requires a non-empty TYPESAFE_API_KEY in the environment (read once at construction, never logged)",
      );
    }
    this.baseUrl = (opts.baseUrl ?? "https://api.typesafe.ai").replace(/\/+$/, "");
    this.requestId = opts.requestId;
    this.timeoutMs = opts.timeoutMs ?? JUDGE_TIMEOUT_MS;
    this.retryDelayMs = opts.retryDelayMs;
    this.provenanceDir = opts.provenanceDir ?? "_bmad-output/judgment/provenance";
    this.warnWhenStateCharsOver = opts.warnWhenStateCharsOver ?? DEFAULT_WARN_STATE_CHARS;
  }

  /**
   * Ask TypeSafe to judge `state` against `questions`. Returns the
   * provenance envelope; emits the digest-stable side-channel entry; logs
   * one house-shaped line.
   */
  async judge(
    state: string | object | readonly unknown[],
    questions: Record<string, Question>,
    opts: JudgeOptions,
  ): Promise<JudgmentEnvelope> {
    const requestId = this.requestId ?? newRequestId();
    const start = Date.now();
    let status: "ok" | "error" = "ok";
    let errMsg: { code: string; message: string } | undefined;
    try {
      // 1. Choke point FIRST (§3.7/§3.8): validate the declared class and
      // redact before any request exists. The redaction pass needs text, so
      // non-string states are serialized here — the wire always carries the
      // scrubbed string.
      const stateText = egress(typeof state === "string" ? state : JSON.stringify(state), opts.egressClass);
      // 2. Stage ceiling (§3.2): refuse in-stage before anything is sent.
      opts.ceiling?.admit();
      // 3. Documented budget warning — NOT enforcement (JEV-3 owns pre-flight sizing).
      if (this.warnWhenStateCharsOver > 0 && stateText.length > this.warnWhenStateCharsOver) {
        log({
          requestId,
          operation: "warnStateSize",
          agentId: null,
          timestamp: new Date().toISOString(),
          duration: 0,
          status: "ok",
          message: `state is ${stateText.length} chars (warnWhenStateCharsOver ${this.warnWhenStateCharsOver}) — the vendor budget is 64k tokens/request and 32k for state + longest question; documented, not enforced`,
        });
      }

      const request: JudgmentRequest = { model: TYPESAFE_MODEL, state: stateText, questions };
      // Mock short-circuits the NETWORK only — never validation.
      const body =
        this.mode === "mock" ? mockResponse(request) : await this.post(request, requestId);

      // Same strict path for canned and live bodies (AC-4): unknown keys,
      // missing fields, or answers to unasked ids refuse with no envelope.
      const schema = makeJudgmentResponseSchema(Object.keys(questions));
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        throw new JudgmentHttpError(
          502,
          `TypeSafe response failed schema validation: ${parsed.error.message}`,
          requestId,
          JSON.stringify(body).slice(0, 512),
        );
      }

      opts.ceiling?.record(parsed.data.usage.input_tokens);

      const envelope: JudgmentEnvelope = {
        requestId,
        model: parsed.data.model,
        questions: request.questions,
        answers: parsed.data.answers,
        usage: parsed.data.usage,
        latency_ms: Date.now() - start,
        egress_class: opts.egressClass,
        created_at: new Date().toISOString(),
      };
      emitProvenance(detailFromEnvelope(envelope), this.provenanceDir);
      return envelope;
    } catch (e) {
      status = "error";
      errMsg = {
        code:
          e instanceof JudgmentHttpError
            ? `http_${e.status}`
            : e instanceof EgressRefusedError
              ? "egress_refused"
              : e instanceof CeilingExceededError
                ? "ceiling_exceeded"
                : "judge_failed",
        message: (e as Error).message,
      };
      throw e;
    } finally {
      const entry: LogEntry = {
        requestId,
        operation: "judge",
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: Date.now() - start,
        status,
        model: TYPESAFE_MODEL,
        egressClass: opts.egressClass,
        ...(errMsg ? { error: errMsg } : {}),
      };
      log(entry);
    }
  }

  /**
   * Live POST. Retry posture is stated here ON PURPOSE (not inherited): see
   * the header note on POST-replay safety — maxAttempts 2, 429/529 only,
   * delay from `retry-after` capped at MAX_RETRY_AFTER_MS; 401/422 fatal on
   * attempt one with the (truncated) body carried in the thrown error.
   */
  private async post(request: JudgmentRequest, requestId: string): Promise<unknown> {
    const { text } = await httpRequest(
      `${this.baseUrl}/v1/systemone`,
      { method: "POST", body: request },
      {
        timeoutMs: this.timeoutMs,
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          "x-request-id": requestId,
        },
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        retryOn: (res) => res.status === 429 || res.status === 529,
        retryDelayMs: (res) => this.retryDelayMs ?? retryAfterMs(res),
        onHttpError: (res, raw) =>
          new JudgmentHttpError(
            res.status,
            `TypeSafe API returned HTTP ${res.status}: ${safeMessage(raw)}`,
            requestId,
            truncate(raw),
          ),
        onTransportError: (e, timedOut) =>
          timedOut
            ? new JudgmentHttpError(
                408,
                `TypeSafe judge timed out after ${this.timeoutMs}ms`,
                requestId,
                "",
              )
            : new JudgmentHttpError(
                502,
                `TypeSafe judge fetch failed: ${(e as Error).message}`,
                requestId,
                "",
              ),
      },
    );
    try {
      return text.length === 0 ? {} : JSON.parse(text);
    } catch {
      throw new JudgmentHttpError(
        502,
        `TypeSafe returned a non-JSON body: ${truncate(text)}`,
        requestId,
        truncate(text),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Mock mode — deterministic canned answers through the SAME validation path
// as live bodies (AC-1). Private precedent copied from hindsight, not imported.
// ---------------------------------------------------------------------------

function mockResponse(request: JudgmentRequest): unknown {
  const answers: Record<string, unknown> = {};
  for (const [qid, q] of Object.entries(request.questions)) {
    if (q.type === "noul") {
      answers[qid] = { type: "noul", noul: true };
    } else if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      answers[qid] = {
        type: "choice",
        choice: keys[0] ?? "",
        probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 1 : 0])),
        confidence: 1,
      };
    } else {
      const legend = q.criteria;
      answers[qid] = {
        type: "score",
        score: legend[0] ?? "",
        legend,
        probabilities: Object.fromEntries(legend.map((k, i) => [k, i === 0 ? 1 : 0])),
        confidence: 1,
      };
    }
  }
  return {
    model: TYPESAFE_MODEL,
    answers,
    usage: { input_tokens: 10, output_tokens: 1 },
  };
}

// ---------------------------------------------------------------------------
// Helpers (hindsight idiom)
// ---------------------------------------------------------------------------

function truncate(s: string, max = 512): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Defensively extract a SAFE message from a non-2xx body (INV-HM5 idiom). */
function safeMessage(text: string): string {
  if (text.length === 0) return "(empty body)";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return truncate(text);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return truncate(JSON.stringify(parsed));
  }
  const obj = parsed as { message?: unknown; error?: unknown; detail?: unknown };
  for (const key of ["message", "error", "detail"] as const) {
    const v = obj[key];
    if (typeof v === "string") return truncate(v);
  }
  return truncate(JSON.stringify(parsed));
}
