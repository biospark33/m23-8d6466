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
import { httpRequest } from "../lib/http.ts";
import { maskEnv } from "../swarmclaw/mcp/tool-bridge.ts";
import type { z } from "zod";
import {
  BankIdSchema,
  ConsolidateResponseSchema,
  CreateMentalModelResponseSchema,
  MentalModelListSchema,
  MentalModelSchema,
  OperationsListSchema,
  RecallResponseSchema,
  ReflectResponseSchema,
  RetainExtensionSchema,
  RetainResponseSchema,
  type ConsolidateResponse,
  type CreateMentalModelResponse,
  type MentalModel,
  type MentalModelList,
  type MentalModelTrigger,
  type OperationsList,
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
// Mental-model create/patch kick off a background reflect and answer fast, but
// the reflect itself can be slow server-side — same budget as reflect/retain.
export const MENTAL_MODEL_TIMEOUT_MS = 30_000;

const DEFAULT_BASE_URL = "http://127.0.0.1:8888";

/**
 * Canned WIRE-shape bodies returned in `'mock'` mode — no network. Each shape
 * matches the Zod schema the typed method parses downstream (`requestJSON`),
 * so mock round-trips pass the SAME strict parse as live ones (M1.2 AC5: mock
 * is a network-only short-circuit, never a validation short-circuit). The
 * retain body is the measured 0.10.0 wire (zero-token usage); the legacy
 * camelCase view consumers see (memoryId "" placeholder etc.) is produced by
 * the schema transform, not by this body.
 */
function mockBody(path: string, bankId: string): unknown {
  if (path.endsWith("/memories/recall")) return { results: [], durationMs: 0 };
  if (path.endsWith("/memories")) {
    return {
      success: true,
      items_count: 1,
      async: false,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cached_tokens: 0,
        thoughts_tokens: 0,
      },
    };
  }
  if (path.endsWith("/reflect")) {
    return { bankId, insights: [{ summary: "mock" }], durationMs: 0 };
  }
  if (path.endsWith("/consolidate")) {
    // F-025: the real 0.10.0 wire is `{operation_id (required), deduplicated?}`
    // — the canned body must pass the SAME strict parse a live one does, so it
    // carries the wire shape, not the legacy counts (which now refuse).
    return { operation_id: "mock-consolidate-op", deduplicated: false };
  }
  // createBank = PUT /v1/default/banks/<bankId>; listBanks = GET /v1/default/banks.
  if (/\/banks\/[^/]+$/.test(path)) return { bank_id: bankId };
  if (path.endsWith("/banks")) return {};
  return {};
}

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
  /**
   * `'live'` (default) hits the Hindsight HTTP API. `'mock'` short-circuits
   * every request to a schema-valid canned body without touching the network
   * — used by P1.11/P1.12 AC5 env-fallback when Hindsight is unreachable
   * (OQ-4 BLOCKED-on-env) and by tests. Callers that need to assert a real
   * round-trip must NOT set this.
   */
  mode?: "live" | "mock";
}

/**
 * Result of {@link HindsightClient.deleteBank} — story M1.1 AC3 rollback
 * compensation + AC4 disposable-probe cleanup distinguish "deleted now" from
 * "was already gone" so compensation can record per-bank outcomes without a
 * pre-flight existence check.
 */
export interface DeleteBankResult {
  deleted: boolean;
  alreadyGone: boolean;
  bankId: string;
  /** Wire `deleted_count` — present only when the 2xx body carried a number. */
  deletedCount?: number;
}

// ---------------------------------------------------------------------------
// HindsightClient
// ---------------------------------------------------------------------------

export class HindsightClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly requestId: string | undefined;
  private readonly mode: "live" | "mock";

  constructor(opts: HindsightClientOptions = {}) {
    this.mode = opts.mode ?? "live";
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

  /**
   * Delete a bank. DELETE /v1/default/banks/{bank_id} — path build mirrors
   * createBank. Endpoint confirmed against the 0.10.0 generated client
   * (`ghcr.io/vectorize-io/hindsight:0.10.0` → hindsight-clients/go/
   * api_banks.go, DeleteBank; DeleteResponse = {success, message?,
   * deleted_count?}).
   *
   * Story M1.1 ownership: AC3 rollback compensation + AC4 disposable-probe
   * cleanup. A 404 HindsightHttpError resolves as already-gone — idempotent
   * like createBank's PUT upsert (story AC3). Track A source correction
   * (0.10.0 delete_bank handler): no existence check, so a missing bank is
   * 200 with deleted_count:0, mapped to already-gone; the 404 catch is
   * future-drift armor. Any other error is rethrown unchanged.
   *
   * Round-1 review F-015 (defensive): a 2xx body carrying success:false is a
   * server-side refusal, not a deletion — the 0.10.0 wire never does this
   * (Track A: DeleteResponse.success is true on 200), but the narrowing
   * below already concedes the body's shape is unknown, and reporting a
   * refused delete as {deleted:true} would poison AC3's compensation
   * accounting. Surfaced as HindsightHttpError 502 (the body contradicts
   * the status); the catch below rethrows it (502 ≠ 404). deleted_count
   * semantics are unchanged: numeric 0 → already-gone; non-numeric
   * (including the string "0") → field absent.
   */
  async deleteBank(bankId: string): Promise<DeleteBankResult> {
    const requestId = this.requestId ?? newRequestId();
    assertBankId(bankId, requestId);
    try {
      const raw = await this.request(
        "DELETE",
        `/v1/default/banks/${bankId}`,
        undefined,
        RETAIN_TIMEOUT_MS,
        "deleteBank",
        bankId,
        requestId,
      );
      // F-015: 2xx + body success:false → the server refused the delete.
      // Missing `success` key (undefined !== false) and non-object bodies
      // fall through — only an explicit false refuses.
      const refused =
        raw !== null && typeof raw === "object" && (raw as { success?: unknown }).success === false;
      if (refused) {
        throw new HindsightHttpError(502, "delete refused by server", requestId);
      }
      // INV-HM5: body is `unknown` — narrow before field access.
      const count =
        raw !== null && typeof raw === "object" && "deleted_count" in raw
          ? (raw as { deleted_count: unknown }).deleted_count
          : undefined;
      if (count === 0) {
        return { deleted: false, alreadyGone: true, bankId, deletedCount: 0 };
      }
      return {
        deleted: true,
        alreadyGone: false,
        bankId,
        ...(typeof count === "number" ? { deletedCount: count } : {}),
      };
    } catch (e) {
      if (e instanceof HindsightHttpError && e.status === 404) {
        return { deleted: false, alreadyGone: true, bankId };
      }
      throw e;
    }
  }

  /**
   * M1.2 AC5 (P2.8 fold): the retain extension is OWNED, not assumed —
   * `documentId`/`updateMode` are schema-validated at this boundary
   * (RetainExtensionSchema), `tags` move TOP-LEVEL on the wire item (never
   * `metadata.tags` — 0.10.0 422s on that), and `updateMode:"replace"` is
   * API-level semantics for the `document_id` upsert: no wire field exists
   * for it and none is sent.
   */
  async retain(
    bankId: string,
    content: string,
    metadata?: {
      source?: "agent" | "mulch-import" | "manual" | "consolidate";
      kind?: "decision" | "pattern" | "expertise" | "observation";
      tags?: string[];
      documentId?: string;
      updateMode?: "replace";
    },
  ): Promise<RetainResponse> {
    const requestId = this.requestId ?? newRequestId();
    assertBankId(bankId, requestId);
    const extension = RetainExtensionSchema.safeParse(metadata ?? {});
    if (!extension.success) {
      // Thrown BEFORE request(), so request()'s finally-log never fires — log
      // the refusal here, mirroring assertBankId, or it is invisible.
      try {
        log({
          requestId,
          operation: "retain",
          agentId: null,
          timestamp: new Date().toISOString(),
          duration: 0,
          status: "error",
          bankId,
          error: { code: "invalid_retain_extension", message: extension.error.message },
        });
      } catch {
        // A throwing log sink must not replace the typed 422 below.
      }
      throw new HindsightHttpError(
        422,
        `invalid retain extension: ${extension.error.message}`,
        requestId,
      );
    }
    // `replace` IS the document_id upsert — with no identity it can only
    // fabricate a new document, which would fake idempotency. Refused
    // pre-fetch like the extension parse above (and logged the same way, for
    // the same before-request visibility reason).
    if (extension.data.updateMode !== undefined && extension.data.documentId === undefined) {
      try {
        log({
          requestId,
          operation: "retain",
          agentId: null,
          timestamp: new Date().toISOString(),
          duration: 0,
          status: "error",
          bankId,
          error: {
            code: "update_mode_requires_document_id",
            message: "updateMode requires documentId",
          },
        });
      } catch {
        // A throwing log sink must not replace the typed 422 below.
      }
      throw new HindsightHttpError(422, "updateMode requires documentId", requestId);
    }
    const item: Record<string, unknown> = { content };
    if (metadata?.tags !== undefined) item.tags = metadata.tags;
    if (metadata?.documentId !== undefined) item.document_id = metadata.documentId;
    if (metadata?.source !== undefined || metadata?.kind !== undefined) {
      item.metadata = {
        ...(metadata.source !== undefined ? { source: metadata.source } : {}),
        ...(metadata.kind !== undefined ? { kind: metadata.kind } : {}),
      };
    }
    const body: Record<string, unknown> = { items: [item] };
    // F6: 0.10.0 answers a refused retain with 2xx + success:false, and the
    // legacy view the schema transform emits carries no `success` — so the wire
    // check happens HERE on the raw body, before the strict parse (same shape
    // as deleteBank's F-015 arm). Only an explicit false refuses; missing key /
    // non-object bodies fall through to the normal parse (which still 502s on
    // malformed shapes).
    const raw = await this.request(
      "POST",
      `/v1/default/banks/${bankId}/memories`,
      body,
      RETAIN_TIMEOUT_MS,
      "retain",
      bankId,
      requestId,
    );
    if (raw !== null && typeof raw === "object" && (raw as { success?: unknown }).success === false) {
      throw new HindsightHttpError(502, "retain refused by server (success:false)", requestId);
    }
    // G8: the mirror arm — a 2xx claiming success but storing nothing is not a
    // landed retain either, and must never produce a receipt-backed success.
    // Skipped when the wire body carries async:true — that is a queued accept
    // (the response schema models `async`, and items_count:0 is the natural
    // shape of a not-yet-processed queue), not a synchronous zero-item store.
    if (
      raw !== null && typeof raw === "object"
      && (raw as { success?: unknown }).success === true
      && (raw as { items_count?: unknown }).items_count === 0
      && (raw as { async?: unknown }).async !== true
    ) {
      throw new HindsightHttpError(502, "retain stored zero items", requestId);
    }
    // Same parse as requestJSON — inlined only because the raw body must be
    // inspected above before it is narrowed by the schema transform.
    const parsed = RetainResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HindsightHttpError(
        502,
        `Hindsight response failed schema validation: ${parsed.error.message}`,
        requestId,
      );
    }
    return parsed.data;
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
  // Mental models + operations (M3.1 leaf 1.1.2) — trigger-only per DD-28.16:
  // there is deliberately NO refresh method; a refresh happens when a model's
  // trigger fires (refresh_after_consolidation / refresh_cron) or via the
  // dedicated trigger path, never as an ad-hoc client call.
  // -------------------------------------------------------------------------

  /**
   * Create a mental model — POST /v1/default/banks/{bank_id}/mental-models
   * (openapi.json:1981-2048). Runs reflect with `sourceQuery` in the
   * background; the returned operation_id tracks it via listOperations.
   * CamelCase args map onto the snake_case wire body
   * (CreateMentalModelRequest :10926-10991 — name + source_query required;
   * id/tags/max_tokens/trigger optional; only provided keys ride the wire).
   * Response: CreateMentalModelResponse :10993-11018 — mental_model_id is
   * null until the background reflect has generated content.
   */
  async createMentalModel(
    bankId: string,
    input: {
      id?: string;
      name: string;
      sourceQuery: string;
      trigger?: MentalModelTrigger;
      maxTokens?: number;
    },
  ): Promise<CreateMentalModelResponse> {
    const requestId = this.requestId ?? newRequestId();
    assertBankId(bankId, requestId);
    const body: Record<string, unknown> = {
      name: input.name,
      source_query: input.sourceQuery,
    };
    if (input.id !== undefined) body.id = input.id;
    if (input.trigger !== undefined) body.trigger = input.trigger;
    if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;
    return this.requestJSON(
      "POST",
      `/v1/default/banks/${bankId}/mental-models`,
      body,
      MENTAL_MODEL_TIMEOUT_MS,
      "createMentalModel",
      bankId,
      CreateMentalModelResponseSchema,
      requestId,
    );
  }

  /**
   * Update a mental model's name and/or trigger — PATCH
   * /v1/default/banks/{bank_id}/mental-models/{mental_model_id}
   * (openapi.json:2133-2208). UpdateMentalModelRequest (:19212-19281) is
   * all-optional; only provided keys ride the wire. Returns the updated
   * MentalModelResponse (:15355-15501).
   */
  async patchMentalModel(
    bankId: string,
    mentalModelId: string,
    patch: { name?: string; trigger?: MentalModelTrigger },
  ): Promise<MentalModel> {
    const requestId = this.requestId ?? newRequestId();
    assertBankId(bankId, requestId);
    // F-026: the id interpolates into the URL path — validate it against the
    // same BankIdSchema charset the bank segment uses, BEFORE any fetch.
    assertMentalModelId(mentalModelId, requestId);
    const body: Record<string, unknown> = {};
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.trigger !== undefined) body.trigger = patch.trigger;
    return this.requestJSON(
      "PATCH",
      `/v1/default/banks/${bankId}/mental-models/${mentalModelId}`,
      body,
      MENTAL_MODEL_TIMEOUT_MS,
      "patchMentalModel",
      bankId,
      MentalModelSchema,
      requestId,
    );
  }

  /**
   * List mental models — GET /v1/default/banks/{bank_id}/mental-models
   * (openapi.json:1843-1980). `detail`: metadata (wire default) | content |
   * full (:1898-1914 — content is opt-in server-side). Envelope is the
   * MentalModelListResponse `items` wrapper (:15057-15090).
   */
  async listMentalModels(
    bankId: string,
    detail?: "metadata" | "content" | "full",
  ): Promise<MentalModelList> {
    const requestId = this.requestId ?? newRequestId();
    assertBankId(bankId, requestId);
    const path =
      detail !== undefined
        ? `/v1/default/banks/${bankId}/mental-models?detail=${detail}`
        : `/v1/default/banks/${bankId}/mental-models`;
    return this.requestJSON(
      "GET",
      path,
      undefined,
      RECALL_TIMEOUT_MS,
      "listMentalModels",
      bankId,
      MentalModelListSchema,
      requestId,
    );
  }

  /**
   * List async operations — GET /v1/default/banks/{bank_id}/operations
   * (openapi.json:4378-4512). status (:4396) / type (:4414) are free strings
   * server-side (pending..cancelled / retain..webhook_delivery); limit is
   * 1..100 (:4432-4442); offset pages past the first window (edge-case round-1:
   * >50 refresh ops on a bank must stay reachable). Query params
   * URLSearchParams-encoded.
   */
  async listOperations(
    bankId: string,
    opts?: { type?: string; status?: string; limit?: number; offset?: number },
  ): Promise<OperationsList> {
    const requestId = this.requestId ?? newRequestId();
    assertBankId(bankId, requestId);
    let path = `/v1/default/banks/${bankId}/operations`;
    if (opts !== undefined) {
      const params = new URLSearchParams();
      if (opts.type !== undefined) params.set("type", opts.type);
      if (opts.status !== undefined) params.set("status", opts.status);
      if (opts.limit !== undefined) params.set("limit", String(opts.limit));
      if (opts.offset !== undefined) params.set("offset", String(opts.offset));
      const query = params.toString();
      if (query.length > 0) path = `${path}?${query}`;
    }
    return this.requestJSON(
      "GET",
      path,
      undefined,
      RECALL_TIMEOUT_MS,
      "listOperations",
      bankId,
      OperationsListSchema,
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

    // Per Hindsight OpenAPI the auth header is `Authorization: Bearer <key>`
    // (tenant ApiKeyTenantExtension). The research brief's `X-API-Key` claim
    // was wrong — confirmed via references/developer/mcp-server.md. Env var
    // name HINDSIGHT_API_KEY is unchanged; only the header name + scheme change.
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-request-id": rid,
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    let status: "ok" | "error" = "ok";
    let errMsg: { code: string; message: string } | undefined;
    try {
      // Mock mode bypasses the NETWORK only — not the telemetry. Returning
      // from inside the try keeps the `finally` below, so a mock call still
      // emits the same operation/duration/status/requestId log entry a live
      // one does. Audit and waiver diagnostics (P1.11/P1.12 AC5 run entirely
      // in mock mode) would otherwise have no trace at all.
      if (this.mode === "mock") return mockBody(path, bankId);
      // No retry: every caller's timeout is its own per-operation budget and a
      // replayed retain is not idempotent. The error mapping below is this
      // client's policy — `src/lib/http.ts` owns only the mechanism.
      const { text } = await httpRequest(
        url,
        { method, ...(body !== undefined && method !== "GET" ? { body } : {}) },
        {
          timeoutMs,
          headers,
          onHttpError: (res, raw) => {
            const message = safeErrorMessage(res.status, raw);
            status = "error";
            errMsg = { code: `http_${res.status}`, message };
            return new HindsightHttpError(res.status, message, rid);
          },
          onTransportError: (e, timedOut) => {
            if (timedOut || isAbortError(e)) {
              status = "error";
              errMsg = { code: "timeout", message: `request timed out after ${timeoutMs}ms` };
              return new HindsightHttpError(
                408,
                `Hindsight ${operation} timed out after ${timeoutMs}ms`,
                rid,
              );
            }
            status = "error";
            errMsg = { code: "fetch_failed", message: (e as Error).message };
            return new HindsightHttpError(
              502,
              `Hindsight ${operation} fetch failed: ${(e as Error).message}`,
              rid,
            );
          },
        },
      );
      // INV-HM5: response body is `unknown` until narrowed by caller.
      let data: unknown;
      try {
        data = text.length === 0 ? {} : JSON.parse(text);
      } catch {
        // Non-JSON 2xx body — surface stringified, never the raw object. Mirror
        // the non-2xx / abort / fetch_failed paths: set error state BEFORE the
        // throw so the finally-log reports status:"error" (not "ok") with the
        // truncated body in errMsg. Without this the throw escapes to the outer
        // catch's `instanceof HindsightHttpError` re-throw and the finally runs
        // with the default status:"ok" — a 502 logged as success.
        const message = `Hindsight returned non-JSON body: ${truncate(text)}`;
        status = "error";
        errMsg = { code: "non_json_body", message };
        throw new HindsightHttpError(502, message, rid);
      }
      return data;
    } catch (e) {
      if (e instanceof HindsightHttpError) throw e;
      // The policy above maps every fetch failure, so nothing else should reach
      // here — but an escape must still be logged as an error rather than
      // silently finishing the finally-block with status:"ok".
      status = "error";
      errMsg = { code: "fetch_failed", message: (e as Error).message };
      throw new HindsightHttpError(
        502,
        `Hindsight ${operation} fetch failed: ${(e as Error).message}`,
        rid,
      );
    } finally {
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
function safeErrorMessage(status: number, text: string): string {
  // The http layer has already read the body — and a body it could NOT read is
  // a transport failure there, never a message to compose here.
  if (text.length === 0) return `HTTP ${status}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON body — stringify defensively, truncated.
    return `HTTP ${status}: ${truncate(text)}`;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return `HTTP ${status}: ${truncate(JSON.stringify(parsed))}`;
  }
  const obj = parsed as { message?: unknown; error?: unknown; detail?: unknown };
  // Narrow each common error field before stringifying.
  for (const key of ["message", "error", "detail"] as const) {
    const v = obj[key];
    if (typeof v === "string") return `HTTP ${status}: ${truncate(v)}`;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const inner = (v as { message?: unknown }).message;
      if (typeof inner === "string") return `HTTP ${status}: ${truncate(inner)}`;
    }
  }
  return `HTTP ${status}: ${truncate(JSON.stringify(parsed))}`;
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

/** F-026: validate a mental-model id at the client boundary before it reaches
 *  the URL path — same BankIdSchema charset (lowercase alnum + hyphens, ≤64
 *  chars, no leading/trailing hyphen), so path traversal / query injection
 *  refuse before any fetch. assertBankId's shape, own labels (the log must
 *  name the id kind that actually failed). */
function assertMentalModelId(mentalModelId: string, requestId: string): void {
  if (!BankIdSchema.safeParse(mentalModelId).success) {
    log({
      requestId,
      operation: "assertMentalModelId",
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: 0,
      status: "error",
      bankId: "",
      error: {
        code: "invalid_mental_model_id",
        message: `invalid mental_model_id: ${mentalModelId}`,
      },
    });
    throw new HindsightHttpError(
      422,
      `invalid mental_model_id: ${mentalModelId}`,
      requestId,
    );
  }
}
