/**
 * HindsightClient — bank-scoped REST client for Hindsight.
 *
 * All paths are BANK-SCOPED per the real Hindsight OpenAPI (research-brief.md
 * "Story endpoint paths are WRONG"): `/v1/default/banks/{bank_id}/...`. The
 * story body's flat paths (`/v1/default/recall`) 404 against a live Hindsight.
 *
 * Security:
 *  - INV-HM1: apiKey is read from arg OR `HINDSIGHT_API_KEY` env ONLY. Never
 *    hardcoded, never logged. Any env diagnostic is masked via P0.7 `maskEnv`.
 *  - INV-HM5: every response body is treated as `unknown`, narrowed via Zod
 *    `safeParse` before field access. Non-JSON bodies are stringified into the
 *    error message (never the raw object). AbortController timers are cleared
 *    in `finally`.
 *
 * Uses P0.7's `log()` (CC-9) + `newRequestId()` from stdio-transport.ts and
 * `maskEnv` from tool-bridge.ts — no bespoke redactor / logger.
 */

import {
  log,
  newRequestId,
  type LogEntry,
} from "../swarmclaw/mcp/stdio-transport.ts";
import { maskEnv } from "../swarmclaw/mcp/tool-bridge.ts";
import type { z } from "zod";
import {
  BankIdSchema,
  ConsolidateResponseSchema,
  RecallResponseSchema,
  ReflectResponseSchema,
  RetainResponseSchema,
  type ConsolidateResponse,
  type RecallResponse,
  type ReflectResponse,
  type RetainResponse,
} from "./schemas.ts";

// ---------------------------------------------------------------------------
// Timeouts (story CC-7). All ≤ P0.7 invoke 120s.
// ---------------------------------------------------------------------------

export const RETAIN_TIMEOUT_MS = 30_000;
export const RECALL_TIMEOUT_MS = 10_000;
export const REFLECT_TIMEOUT_MS = 30_000;
export const CONSOLIDATE_TIMEOUT_MS = 60_000;

const DEFAULT_BASE_URL = "http://127.0.0.1:8888";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class HindsightHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly requestId: string,
  ) {
    super(message);
    this.name = "HindsightHttpError";
  }
}

// ---------------------------------------------------------------------------
// Client options
// ---------------------------------------------------------------------------

export interface HindsightClientOptions {
  baseUrl?: string;
  apiKey?: string;
  requestId?: string;
}

// ---------------------------------------------------------------------------
// HindsightClient
// ---------------------------------------------------------------------------

export class HindsightClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly requestId: string | undefined;

  constructor(opts: HindsightClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.HINDSIGHT_BASE_URL ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    // INV-HM1: env-only fallback. Never logged. Both env names accepted:
    // HINDSIGHT_BEARER_TOKEN (spec INV-HM1, preferred) and
    // HINDSIGHT_API_KEY (research-brief/legacy fallback). Empty-string opt and
    // env values are all coerced to undefined so a misconfigured
    // HINDSIGHT_BEARER_TOKEN="" (or apiKey:"" arg) cannot shadow a valid
    // HINDSIGHT_API_KEY — `??` falls through on null/undefined only, so the
    // coercion at every link is load-bearing.
    const optKey = opts.apiKey && opts.apiKey.length > 0 ? opts.apiKey : undefined;
    this.apiKey = optKey
      ?? (process.env.HINDSIGHT_BEARER_TOKEN || undefined)
      ?? (process.env.HINDSIGHT_API_KEY || undefined);
    this.requestId = opts.requestId;
  }

  // -------------------------------------------------------------------------
  // Public API — all bank-scoped per research-brief.
  // -------------------------------------------------------------------------

  async listBanks(): Promise<unknown> {
    return this.request("GET", "/v1/default/banks", undefined, RECALL_TIMEOUT_MS, "listBanks");
  }

  /**
   * Create or update a bank. Per Hindsight OpenAPI this is PUT-scoped to the
   * bank_id in the path (idempotent upsert), NOT POST /v1/default/banks. The
   * body echoes bank_id; Hindsight ignores extra fields on a path-scoped PUT
   * (caller can extend config later via the config endpoints).
   */
  async createBank(bankId: string): Promise<unknown> {
    const requestId = this.requestId ?? newRequestId();
    assertBankId(bankId, requestId);
    return this.request(
      "PUT",
      `/v1/default/banks/${bankId}`,
      { bank_id: bankId },
      RETAIN_TIMEOUT_MS,
      "createBank",
      bankId,
      requestId,
    );
  }

  async retain(
    bankId: string,
    content: string,
    metadata?: {
      source?: "agent" | "mulch-import" | "manual" | "consolidate";
      kind?: "decision" | "pattern" | "expertise" | "observation";
      tags?: string[];
    },
  ): Promise<RetainResponse> {
    const requestId = this.requestId ?? newRequestId();
    assertBankId(bankId, requestId);
    const body: Record<string, unknown> = {
      items: [metadata ? { content, metadata } : { content }],
    };
    return this.requestJSON(
      "POST",
      `/v1/default/banks/${bankId}/memories`,
      body,
      RETAIN_TIMEOUT_MS,
      "retain",
      bankId,
      RetainResponseSchema,
      requestId,
    );
  }

  async recall(bankId: string, query: string, limit = 5): Promise<RecallResponse> {
    const requestId = this.requestId ?? newRequestId();
    assertBankId(bankId, requestId);
    return this.requestJSON(
      "POST",
      `/v1/default/banks/${bankId}/memories/recall`,
      { query, limit },
      RECALL_TIMEOUT_MS,
      "recall",
      bankId,
      RecallResponseSchema,
      requestId,
    );
  }

  async reflect(bankId: string, query?: string): Promise<ReflectResponse> {
    const requestId = this.requestId ?? newRequestId();
    assertBankId(bankId, requestId);
    const body: Record<string, unknown> = {};
    if (query !== undefined) body.query = query;
    return this.requestJSON(
      "POST",
      `/v1/default/banks/${bankId}/reflect`,
      body,
      REFLECT_TIMEOUT_MS,
      "reflect",
      bankId,
      ReflectResponseSchema,
      requestId,
    );
  }

  async consolidate(
    bankId: string,
    options?: { maxAge?: number; preserveRecent?: number },
  ): Promise<ConsolidateResponse> {
    const requestId = this.requestId ?? newRequestId();
    assertBankId(bankId, requestId);
    const body: Record<string, unknown> = {};
    if (options !== undefined) body.options = options;
    return this.requestJSON(
      "POST",
      `/v1/default/banks/${bankId}/consolidate`,
      body,
      CONSOLIDATE_TIMEOUT_MS,
      "consolidate",
      bankId,
      ConsolidateResponseSchema,
      requestId,
    );
  }

  // -------------------------------------------------------------------------
  // Internal request machinery
  // -------------------------------------------------------------------------

  /**
   * JSON-Typed request: parses the response body against `schema`.
   */
  private async requestJSON<S extends z.ZodTypeAny>(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
    operation: string,
    bankId: string,
    schema: S,
    requestId: string,
  ): Promise<z.infer<S>> {
    const data = await this.request(method, path, body, timeoutMs, operation, bankId, requestId);
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new HindsightHttpError(
        502,
        `Hindsight response failed schema validation: ${parsed.error.message}`,
        requestId,
      );
    }
    return parsed.data;
  }

  /**
   * Raw request. Returns the parsed-JSON body as `unknown` (INV-HM5: caller
   * narrows). Non-2xx → HindsightHttpError with a SAFE message (body content
   * defensively extracted; non-object bodies stringified). AbortError from a
   * timeout → HindsightHttpError status 408. AbortController timer cleared in
   * finally.
   */
  async request(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs: number = RETAIN_TIMEOUT_MS,
    operation = "request",
    bankId = "",
    requestId?: string,
  ): Promise<unknown> {
    const rid = requestId ?? this.requestId ?? newRequestId();
    const start = Date.now();
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Per Hindsight OpenAPI the auth header is `Authorization: Bearer <key>`
    // (tenant ApiKeyTenantExtension). The research brief's `X-API-Key` claim
    // was wrong — confirmed via references/developer/mcp-server.md. Env var
    // name HINDSIGHT_API_KEY is unchanged; only the header name + scheme change.
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-request-id": rid,
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const init: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };
    if (body !== undefined && method !== "GET") {
      init.body = JSON.stringify(body);
    }

    let status: "ok" | "error" = "ok";
    let errMsg: { code: string; message: string } | undefined;
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        const message = await safeErrorMessage(res);
        status = "error";
        errMsg = { code: `http_${res.status}`, message };
        throw new HindsightHttpError(res.status, message, rid);
      }
      // INV-HM5: response body is `unknown` until narrowed by caller.
      const text = await res.text();
      let data: unknown;
      try {
        data = text.length === 0 ? {} : JSON.parse(text);
      } catch {
        // Non-JSON 2xx body — surface stringified, never the raw object.
        throw new HindsightHttpError(
          502,
          `Hindsight returned non-JSON body: ${truncate(text)}`,
          rid,
        );
      }
      return data;
    } catch (e) {
      if (e instanceof HindsightHttpError) throw e;
      if (isAbortError(e)) {
        status = "error";
        errMsg = { code: "timeout", message: `request timed out after ${timeoutMs}ms` };
        throw new HindsightHttpError(
          408,
          `Hindsight ${operation} timed out after ${timeoutMs}ms`,
          rid,
        );
      }
      status = "error";
      errMsg = { code: "fetch_failed", message: (e as Error).message };
      throw new HindsightHttpError(
        502,
        `Hindsight ${operation} fetch failed: ${(e as Error).message}`,
        rid,
      );
    } finally {
      clearTimeout(timer);
      const entry: LogEntry = {
        requestId: rid,
        operation,
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: Date.now() - start,
        status,
        bankId,
        ...(errMsg ? { error: errMsg } : {}),
      };
      log(entry);
      // INV-HM1: opt-in env diagnostic via `HINDSIGHT_DEBUG`. The full env is
      // logged masked via `maskEnv` (the sanctioned INV-HM1 all-values-masked
      // policy); never raw. No env is logged when the flag is unset.
      if (process.env.HINDSIGHT_DEBUG) {
        log({
          ...entry,
          level: "debug",
          message: "hindsight env diagnostic",
          env: maskEnv(process.env as Record<string, string>),
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAbortError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.name === "AbortError";
}

/**
 * Defensively extract a SAFE message from a non-2xx Response body (INV-HM5).
 * Body is treated as `unknown`; non-object bodies are stringified into the
 * message. Bank content is not secret, so the message can carry body text —
 * but the apiKey is never read from the body and is never logged.
 */
async function safeErrorMessage(res: Response): Promise<string> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return `HTTP ${res.status} (no body)`;
  }
  if (text.length === 0) return `HTTP ${res.status}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON body — stringify defensively, truncated.
    return `HTTP ${res.status}: ${truncate(text)}`;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return `HTTP ${res.status}: ${truncate(JSON.stringify(parsed))}`;
  }
  const obj = parsed as { message?: unknown; error?: unknown; detail?: unknown };
  // Narrow each common error field before stringifying.
  for (const key of ["message", "error", "detail"] as const) {
    const v = obj[key];
    if (typeof v === "string") return `HTTP ${res.status}: ${truncate(v)}`;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const inner = (v as { message?: unknown }).message;
      if (typeof inner === "string") return `HTTP ${res.status}: ${truncate(inner)}`;
    }
  }
  return `HTTP ${res.status}: ${truncate(JSON.stringify(parsed))}`;
}

function truncate(s: string, max = 512): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** INV-HM2: validate bank_id at the client boundary before it reaches the URL path.
 *  Logs a structured entry on rejection — this throws BEFORE request(), so the
 *  request() finally-log would never fire and the rejection would be invisible. */
function assertBankId(bankId: string, requestId: string): void {
  if (!BankIdSchema.safeParse(bankId).success) {
    log({
      requestId,
      operation: "assertBankId",
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: 0,
      status: "error",
      bankId,
      error: { code: "invalid_bank_id", message: `invalid bank_id: ${bankId}` },
    });
    throw new HindsightHttpError(422, `invalid bank_id: ${bankId}`, requestId);
  }
}
