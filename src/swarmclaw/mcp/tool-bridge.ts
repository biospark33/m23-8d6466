/**
 * Tool bridge: enumerate MCP tools (with TTL cache), invoke tools, mask
 * secrets (INV-SC5), and emit observability logs (CC-9).
 *
 * bank_id argument validation lives in MCPInvokeArgumentsSchema (checking
 * both `bank_id` and `bankId` spellings against the P0.9 BankIdSchema regex)
 * and is applied by the route before dispatch — NOT inside ToolBridge.invoke.
 */

import { z } from "zod";
import {
  JsonRpcError,
  log,
  newRequestId,
  type StdioTransport,
} from "./stdio-transport.ts";

// ---------------------------------------------------------------------------
// Argument schemas (P0.7 Technical Notes — verbatim shapes).
// ---------------------------------------------------------------------------

// P0.9 BankIdSchema regex, referenced for pre-flight validation at the boundary.
const BANK_ID_REGEX = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

export const MCPInvokeArgumentsSchema = z
  .record(z.unknown())
  .superRefine((args, ctx) => {
    // Both spellings reach the subprocess as `bank_id` (toSnakeArgs converts
    // camelCase keys at dispatch), so both must be validated at the boundary.
    // Reject conflicting duplicates — toSnakeArgs would silently let whichever
    // key enumerates last win. Same-value duplicates are harmless.
    const snakeBankId = args.bank_id;
    const camelBankId = args.bankId;
    if (snakeBankId !== undefined && camelBankId !== undefined && snakeBankId !== camelBankId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "both bank_id and bankId spellings present with conflicting values",
        path: ["bankId"],
      });
    }
    for (const key of ["bank_id", "bankId"]) {
      const value = args[key];
      if (value === undefined) continue;
      // A present bank_id must be a string before the BankIdSchema regex can
      // apply — otherwise a number/boolean/null would slip past the typeof guard
      // below and reach the subprocess unvalidated.
      if (typeof value !== "string") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${key} must be a string (P0.9 BankIdSchema)`,
          path: [key],
        });
        continue;
      }
      if (!BANK_ID_REGEX.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${key} "${value}" fails BankIdSchema validation (P0.9)`,
          path: [key],
        });
      }
    }
  });

export const MCPInvokeSchema = z.object({
  tool: z.string().min(1).max(256),
  arguments: MCPInvokeArgumentsSchema,
});

export const MCPTestResponseSchema = z
  .object({
    ok: z.boolean(),
    tools: z.array(z.string()).optional(),
    error: z.string().optional(),
  })
  .refine((v) => !v.ok || (v.tools && v.tools.length > 0), {
    message: "ok=true requires non-empty tools",
  });

/**
 * Cap on a serialized `result` payload, in UTF-8 bytes. The subprocess is
 * untrusted and its frame cap is 16 MB, so without this the success path would
 * relay an arbitrary multi-megabyte blob straight into an HTTP response while
 * every error path is schema-validated (F067). 1 MB is far above any real
 * hindsight recall and far below the frame cap.
 */
export const MCP_INVOKE_RESULT_MAX_BYTES = 1_048_576;

/**
 * The success payload's stated contract. Deliberately permissive about SHAPE —
 * MCP tools return whatever their own schema says and the bridge is a proxy,
 * not an interpreter — but not about SIZE: `assertInvokeResultWithinCap`
 * carries the half that actually bounds what an untrusted subprocess can push
 * through us.
 */
// z.unknown() NAMES the contract; MCP_INVOKE_RESULT_MAX_BYTES is what enforces it.
export const MCPInvokeResultSchema = z.unknown();

/** Thrown when a result exceeds MCP_INVOKE_RESULT_MAX_BYTES. */
export class MCPResultTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`MCP tool result is ${bytes} bytes, over the ${MCP_INVOKE_RESULT_MAX_BYTES}-byte response cap`);
    this.name = "MCPResultTooLargeError";
  }
}

/**
 * Validate a tool result and prove it fits. Serializes ONCE and measures the
 * bytes that would actually be written — `JSON.stringify` also throws on a
 * cyclic or non-serializable payload, which is the same refusal for the same
 * reason: it could never have reached the client intact.
 */
export function assertInvokeResultWithinCap(result: unknown): void {
  MCPInvokeResultSchema.parse(result);
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(result) ?? "undefined", "utf8");
  } catch {
    throw new MCPResultTooLargeError(Number.POSITIVE_INFINITY);
  }
  if (bytes > MCP_INVOKE_RESULT_MAX_BYTES) throw new MCPResultTooLargeError(bytes);
}

export const MCPInvokeErrorResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  error: z.object({
    code: z.number(),
    message: z.string(),
    data: z
      .object({
        field: z.string().optional(),
        violation: z.string().optional(),
        requestId: z.string(),
      })
      .optional(),
  }),
  id: z.string().or(z.number()).nullable(),
});

// ---------------------------------------------------------------------------
// Secret masking (INV-SC5).
// ---------------------------------------------------------------------------

/**
 * Mask every env value to `***` for diagnostics/responses (INV-SC5). Key names
 * stay visible; heuristic key-matching both under-covers (PASS, DSN) and
 * over-covers (MONKEY), so all values are masked regardless of key name.
 */
export function maskEnv(env: Record<string, string> | undefined): Record<string, string> {
  if (!env) return {};
  const out: Record<string, string> = {};
  for (const k of Object.keys(env)) {
    out[k] = "***";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool enumeration cache with TTL clamp (Technical Notes).
// ---------------------------------------------------------------------------

const TTL_MIN_MS = 1_000;
const TTL_MAX_MS = 3_600_000;

export function resolveToolCacheTtl(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SWARMCLAW_TOOL_CACHE_TTL_MS;
  const DEFAULT = 5 * 60 * 1000;
  if (raw === undefined) return DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT;
  const clamped = Math.min(TTL_MAX_MS, Math.max(TTL_MIN_MS, parsed));
  if (clamped !== parsed) {
    log({
      level: "warn",
      message: "SWARMCLAW_TOOL_CACHE_TTL_MS clamped",
      raw, // the original env string (story contract: raw value, not parsed)
      clamped,
      min: TTL_MIN_MS,
      max: TTL_MAX_MS,
      // CC-9 required fields (best-effort for a config-time warning):
      requestId: newRequestId(),
      operation: "config.tool_cache_ttl",
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: 0,
      status: "ok",
    });
  }
  return clamped;
}

interface ToolCacheEntry {
  tools: string[];
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// camelCase → snake_case boundary translation (CC-8).
// Hindsight tool args are snake_case internally; the SwarmClaw surface is
// camelCase. We translate top-level keys only (args are flat maps).
// ---------------------------------------------------------------------------

function camelToSnake(key: string): string {
  return key.replace(/([A-Z])/g, "_$1").toLowerCase();
}

export function toSnakeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    // Preserve keys that are already snake_case (e.g. bank_id) untouched.
    out[k.includes("_") ? k : camelToSnake(k)] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Minimal inputSchema argument validation (P0.7 invoke flow).
// ---------------------------------------------------------------------------

/**
 * Minimal inputSchema check: required[] properties present, and declared
 * primitive `type` fields matching the actual JSON type. Deliberately NOT a
 * full JSON-Schema engine. Shared by the /invoke route's cached-schema fast
 * path and ToolBridge.invoke's post-enumeration check.
 */
export function validateArgsAgainstInputSchema(
  schema: unknown,
  args: Record<string, unknown>,
): { field: string; violation: string } | null {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return null;
  const s = schema as Record<string, unknown>;
  const required = s.required;
  if (Array.isArray(required)) {
    for (const prop of required) {
      // hasOwnProperty, not `in`: `in` walks the prototype chain and would let
      // e.g. required:["constructor"] pass against an empty args object.
      if (typeof prop === "string" && !Object.prototype.hasOwnProperty.call(args, prop)) {
        return { field: prop, violation: `required property "${prop}" is missing` };
      }
    }
  }
  const properties = s.properties;
  if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [prop, decl] of Object.entries(properties as Record<string, unknown>)) {
      if (!Object.prototype.hasOwnProperty.call(args, prop)) continue;
      const type =
        decl !== null && typeof decl === "object" ? (decl as Record<string, unknown>).type : undefined;
      if (typeof type !== "string") continue;
      if (!jsonTypeMatches(args[prop], type)) {
        return { field: prop, violation: `expected ${type}, got ${jsonTypeOf(args[prop])}` };
      }
    }
  }
  return null;
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function jsonTypeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      // Unknown/non-primitive type declaration — skipped (minimal validator).
      return true;
  }
}

// ---------------------------------------------------------------------------
// ToolBridge — one per registered MCP server.
// ---------------------------------------------------------------------------

export class ToolBridge {
  private cache: ToolCacheEntry | null = null;
  private readonly inputSchemas = new Map<string, Record<string, unknown>>();
  private readonly ttlMs: number;

  constructor(
    private readonly transport: StdioTransport,
    private readonly agentId: string | null = null,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.ttlMs = resolveToolCacheTtl(env);
  }

  /** Enumerate tools via MCP list-tools, refreshing the cache. */
  async enumerateTools(requestId: string): Promise<string[]> {
    const start = Date.now();
    try {
      const result = (await this.transport.request("tools/list", {}, 30_000)) as {
        tools?: Array<{ name?: unknown; inputSchema?: Record<string, unknown> }>;
      };
      // Skip malformed entries (missing/empty non-string name) entirely —
      // they must not leak into the names list or the schema map.
      const enumerated = (result.tools ?? []).filter(
        (t): t is { name: string; inputSchema?: Record<string, unknown> } =>
          typeof t.name === "string" && t.name.length > 0,
      );
      const tools = enumerated.map((t) => t.name);
      this.inputSchemas.clear();
      for (const t of enumerated) {
        if (t.inputSchema !== undefined) this.inputSchemas.set(t.name, t.inputSchema);
      }
      this.cache = { tools, expiresAt: Date.now() + this.ttlMs };
      log({
        requestId,
        operation: "mcp.list_tools",
        agentId: this.agentId,
        timestamp: new Date().toISOString(),
        duration: Date.now() - start,
        status: "ok",
        tool_enumeration_ms: Date.now() - start,
      });
      return tools;
    } catch (err) {
      log({
        requestId,
        operation: "mcp.list_tools",
        agentId: this.agentId,
        timestamp: new Date().toISOString(),
        duration: Date.now() - start,
        status: "error",
        error: { code: "list_tools_failed", message: (err as Error).message },
        tool_enumeration_ms: Date.now() - start,
      });
      throw err;
    }
  }

  /**
   * Tool list plus whether it came from the cache — lets callers skip a
   * redundant re-enumeration right after a fresh enumeration.
   */
  private async getToolsCached(requestId: string): Promise<{ tools: string[]; fromCache: boolean }> {
    if (this.cache && this.cache.expiresAt > Date.now()) {
      return { tools: this.cache.tools, fromCache: true };
    }
    return { tools: await this.enumerateTools(requestId), fromCache: false };
  }

  /**
   * Raw `inputSchema` captured at enumeration time for a tool. Returns
   * undefined for an unknown tool, when the server declared no schema, or
   * once the tool-list cache has expired (schemas share its TTL so the
   * /invoke route's pre-validation never uses a snapshot the bridge itself
   * would treat as stale). Used by the /invoke route for minimal
   * pre-dispatch argument validation.
   *
   * Cache-expiry safety: when this returns undefined because the cache expired,
   * the route SKIPS its pre-dispatch check and delegates to invoke(), which
   * calls getToolsCached() (re-enumerating the now-stale cache) and then
   * validates args against the fresh inputSchema BEFORE the tools/call request.
   * So invalid arguments are rejected before subprocess dispatch regardless of
   * cache state — the route check is a fast path for the warm-cache case, not a
   * load-bearing validator.
   */
  getToolInputSchema(tool: string): Record<string, unknown> | undefined {
    if (!this.cache || this.cache.expiresAt <= Date.now()) return undefined;
    return this.inputSchemas.get(tool);
  }

  invalidateCache(): void {
    this.cache = null;
    this.inputSchemas.clear();
  }

  /**
   * Validate snake_case args against the tool's currently-cached inputSchema
   * and throw a JSON-RPC -32602 on violation. No-op when the server declared
   * no schema for the tool. Shared by the main invoke path and the -32601
   * retry path so a schema refresh can never let stale args slip through to
   * the subprocess unchecked.
   */
  private validateArgsOrThrow(tool: string, snakeArgs: Record<string, unknown>): void {
    const inputSchema = this.inputSchemas.get(tool);
    if (!inputSchema) return;
    const argViolation = validateArgsAgainstInputSchema(inputSchema, snakeArgs);
    if (argViolation) {
      throw new JsonRpcError(
        -32602,
        `Invalid params: ${argViolation.field}: ${argViolation.violation}`,
        { field: argViolation.field, violation: argViolation.violation },
      );
    }
  }

  /**
   * Invoke a tool. Re-enumerates on unknown tool, retries once on
   * tool-not-found from the server. Returns the raw MCP tool result.
   *
   * bank_id argument validation does NOT live here — it is applied by the
   * route via MCPInvokeArgumentsSchema (both `bank_id` and `bankId`
   * spellings) before dispatch, so invoke only ever sees pre-validated args.
   * Every exceptional exit logs exactly one status:"error" mcp.invoke entry.
   */
  async invoke(
    tool: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    requestId: string,
  ): Promise<unknown> {
    const start = Date.now();
    let stdioLatency = 0;
    try {
      // Ensure the tool exists. Re-enumerate only when the miss came from a
      // cached list — a fresh enumeration is already authoritative.
      const lookup = await this.getToolsCached(requestId);
      let tools = lookup.tools;
      if (!tools.includes(tool) && lookup.fromCache) {
        tools = await this.enumerateTools(requestId);
      }
      if (!tools.includes(tool)) {
        throw new JsonRpcError(-32601, `Unknown tool: ${tool}`);
      }

      const snakeArgs = toSnakeArgs(args);

      // Validate against the tool's declared inputSchema now that the tool
      // list (and thus inputSchemas) is current — this also covers the
      // post-TTL-expiry path the route's cached-schema check cannot see.
      // Compares snake_case args against the server's snake_case schema (CC-8).
      this.validateArgsOrThrow(tool, snakeArgs);

      try {
        const result = await this.transport.request(
          "tools/call",
          { name: tool, arguments: snakeArgs, _meta: { requestId } },
          timeoutMs,
          (latency) => {
            stdioLatency = latency;
          },
        );
        log({
          requestId,
          operation: "mcp.invoke",
          agentId: this.agentId,
          timestamp: new Date().toISOString(),
          duration: Date.now() - start,
          status: "ok",
          invoke_duration_ms: Date.now() - start,
          stdio_latency_ms: stdioLatency,
        });
        return result;
      } catch (err) {
        // If the server reports the tool missing, invalidate + retry once.
        // Failures of the re-enumeration or the retry itself propagate to the
        // outer catch, which logs the single error entry.
        if (err instanceof JsonRpcError && err.code === -32601) {
          this.invalidateCache();
          const refreshed = await this.enumerateTools(requestId);
          if (refreshed.includes(tool)) {
            // The refresh may have changed the tool's schema (required fields,
            // types). Revalidate the caller's args against the refreshed schema
            // before re-dispatching — otherwise stale args that no longer match
            // would reach the subprocess unchecked. Throws -32602 on violation,
            // which the outer catch logs and rethrows (retry is abandoned).
            this.validateArgsOrThrow(tool, snakeArgs);
            const retry = await this.transport.request(
              "tools/call",
              { name: tool, arguments: snakeArgs, _meta: { requestId } },
              timeoutMs,
              (latency) => {
                stdioLatency = latency;
              },
            );
            log({
              requestId,
              operation: "mcp.invoke",
              agentId: this.agentId,
              timestamp: new Date().toISOString(),
              duration: Date.now() - start,
              status: "ok",
              invoke_duration_ms: Date.now() - start,
              stdio_latency_ms: stdioLatency,
            });
            return retry;
          }
        }
        throw err;
      }
    } catch (err) {
      log({
        requestId,
        operation: "mcp.invoke",
        agentId: this.agentId,
        timestamp: new Date().toISOString(),
        duration: Date.now() - start,
        status: "error",
        error: { code: "invoke_failed", message: (err as Error).message },
        invoke_duration_ms: Date.now() - start,
        stdio_latency_ms: stdioLatency,
      });
      throw err;
    }
  }
}

// Story Guards/limits: invoke timeout must be ≥ P0.9 consolidate timeout
// (60s default) so long-running consolidate/reflect calls are not cut short.
const INVOKE_TIMEOUT_MIN_MS = 60_000;
// 1h, mirroring the TTL clamp's max — delays above 2^31-1 overflow setTimeout
// into ~1ms, so an unbounded env value would silently disable the timeout.
const INVOKE_TIMEOUT_MAX_MS = 3_600_000;

export function resolveInvokeTimeout(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SWARMCLAW_INVOKE_TIMEOUT_MS;
  const DEFAULT = 120_000;
  if (raw === undefined) return DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT;
  const clamped = Math.min(INVOKE_TIMEOUT_MAX_MS, Math.max(INVOKE_TIMEOUT_MIN_MS, parsed));
  if (clamped !== parsed) {
    log({
      level: "warn",
      message: "SWARMCLAW_INVOKE_TIMEOUT_MS clamped",
      raw, // the original env string (matches the TTL-clamp warn shape)
      clamped,
      min: INVOKE_TIMEOUT_MIN_MS,
      max: INVOKE_TIMEOUT_MAX_MS,
      // CC-9 required fields (best-effort for a config-time warning):
      requestId: newRequestId(),
      operation: "config.invoke_timeout",
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: 0,
      status: "ok",
    });
  }
  return clamped;
}
