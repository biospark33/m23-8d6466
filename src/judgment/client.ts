/**
 * JudgmentClient — house-idiom TypeSafe (Jev) client (JEV-2, handoff §3.3),
 * and since v6 J1 the JudgmentProvider SEAM: the one place the neutral-layer
 * policy runs, ahead of every transport.
 *
 * No SDK: `httpRequest`/`HttpPolicy` from src/lib/http.ts + strict zod
 * schemas, mirroring src/hindsight/client.ts (schemas + mock mode + tests
 * + HindsightHttpError body-carrying). `src/judgment/` imports ONLY
 * src/lib/http.ts + src/swarmclaw/log.ts repo-internally — the two-import
 * fence asserted by tests/judgment/fence.test.ts (recursively, adapters/
 * included).
 *
 * Transport is the only pluggable step: the constructor resolves the mode's
 * adapter maker from the closed registry (provider.ts) — `live` → `jev`,
 * `mock` → `mock` — and builds it from this client's own options. The live
 * POST (retry posture, POST-replay safety note) lives in adapters/jev.ts;
 * the canned bodies in adapters/mock.ts.
 *
 * INV-J1: `TYPESAFE_API_KEY` is read ONCE here, env-only, and handed only to
 * the jev maker. Never hardcoded, never logged, never in an envelope or
 * side-channel detail; the client performs no env diagnostics at all.
 * INV-J5: mock is the DEFAULT. No real spend without a key AND steve's go.
 *
 * Judge call order: choke point (validate + redact) → ceiling admit →
 * documented-budget warning → request → adapter ask → strict parse (same
 * path for every adapter) → ceiling record → envelope → side-channel emit →
 * house log.
 */

import { log, newRequestId, type LogEntry } from "../swarmclaw/log.ts";
import { DEFAULT_MAX_ATTEMPTS } from "./adapters/jev.ts";
import { CeilingExceededError, type JudgmentCeiling } from "./ceiling.ts";
import { detailFromEnvelope, emitProvenance } from "./emit.ts";
import { egress, EgressRefusedError, type EgressClass } from "./egress.ts";
import { JudgmentHttpError } from "./errors.ts";
import { resolveProvider, type JudgmentProvider, type JudgmentProviderId } from "./provider.ts";
import {
  makeJudgmentResponseSchema,
  TYPESAFE_MODEL,
  type JudgmentRequest,
  type Question,
} from "./schemas.ts";
import type { JudgmentEnvelope } from "./envelope.ts";

export { DEFAULT_MAX_ATTEMPTS, JudgmentHttpError, TYPESAFE_MODEL };

/** Pinned vendor endpoint (handoff §4). `baseUrl` overrides for tests. */
export const TYPESAFE_API_URL = "https://api.typesafe.ai/v1/systemone";
/** Per-attempt budget. A judgment is one round-trip, not a stream. */
export const JUDGE_TIMEOUT_MS = 30_000;
/**
 * Documented, NOT enforced (§4): 64k tokens/request and 32k for state +
 * longest question. Pre-flight state sizing is owned by JEV-3; this warning
 * only marks a state that plausibly exceeds budget.
 */
export const DEFAULT_WARN_STATE_CHARS = 100_000;

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
  /** Which registered transport serves this client — named on every judge log line. */
  readonly providerId: JudgmentProviderId;
  private readonly provider: JudgmentProvider;
  private readonly requestId: string | undefined;
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
    // Transport from the closed registry, built from THIS client's options —
    // the per-instance baseUrl/timeoutMs/retryDelayMs overrides survive the
    // extraction unchanged; the mock maker takes no config (no key path).
    this.provider =
      this.mode === "live"
        ? resolveProvider("jev")({
            apiKey: this.apiKey,
            baseUrl: (opts.baseUrl ?? new URL(TYPESAFE_API_URL).origin).replace(/\/+$/, ""),
            timeoutMs: opts.timeoutMs ?? JUDGE_TIMEOUT_MS,
            retryDelayMs: opts.retryDelayMs,
          })
        : resolveProvider("mock")();
    this.providerId = this.provider.id;
    this.requestId = opts.requestId;
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
      // The adapter is the transport ONLY — mock short-circuits the network,
      // never validation; no adapter's body counts until the seam parses it.
      const body = await this.provider.ask(request, requestId);

      // Same strict path for every adapter's body (AC-4): unknown keys,
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
        provider: this.providerId,
        ...(errMsg ? { error: errMsg } : {}),
      };
      log(entry);
    }
  }
}

