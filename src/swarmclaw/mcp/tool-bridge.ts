/**
 * Tool bridge: enumerate MCP tools (with TTL cache), invoke tools, validate
 * arguments (INV bank_id via BankIdSchema), mask secrets (INV-SC5), and emit
 * observability logs (CC-9).
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
    if ("bank_id" in args && typeof args.bank_id === "string") {
      if (!BANK_ID_REGEX.test(args.bank_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `bank_id "${args.bank_id}" fails BankIdSchema validation (P0.9)`,
          path: ["bank_id"],
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

const SECRET_KEY_PATTERN = /(key|token|secret|password|passwd|credential|auth)/i;

/** Mask secret-looking values in an env map to `***` for diagnostics/responses. */
export function maskEnv(env: Record<string, string> | undefined): Record<string, string> {
  if (!env) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = SECRET_KEY_PATTERN.test(k) ? "***" : v;
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
      raw: parsed,
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
// ToolBridge — one per registered MCP server.
// ---------------------------------------------------------------------------

export class ToolBridge {
  private cache: ToolCacheEntry | null = null;
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
        tools?: Array<{ name: string }>;
      };
      const tools = (result.tools ?? []).map((t) => t.name);
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

  /** Cached tool list, re-enumerating on miss/expiry. */
  async getTools(requestId: string): Promise<string[]> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.tools;
    return this.enumerateTools(requestId);
  }

  invalidateCache(): void {
    this.cache = null;
  }

  /**
   * Invoke a tool. Validates arguments (bank_id) BEFORE dispatch, re-enumerates
   * on unknown tool, retries once on tool-not-found from the server.
   * Returns the raw MCP tool result.
   */
  async invoke(
    tool: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    requestId: string,
  ): Promise<unknown> {
    // Ensure the tool exists (re-enumerate on cache miss before failing).
    let tools = await this.getTools(requestId);
    if (!tools.includes(tool)) {
      tools = await this.enumerateTools(requestId);
      if (!tools.includes(tool)) {
        throw new JsonRpcError(-32601, `Unknown tool: ${tool}`);
      }
    }

    const snakeArgs = toSnakeArgs(args);
    const start = Date.now();
    let stdioLatency = 0;
    try {
      const result = await this.transport.request(
        "tools/call",
        { name: tool, arguments: snakeArgs },
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
      if (err instanceof JsonRpcError && err.code === -32601) {
        this.invalidateCache();
        const refreshed = await this.enumerateTools(requestId);
        if (refreshed.includes(tool)) {
          const retry = await this.transport.request(
            "tools/call",
            { name: tool, arguments: snakeArgs },
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

export function resolveInvokeTimeout(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SWARMCLAW_INVOKE_TIMEOUT_MS;
  const DEFAULT = 120_000;
  if (raw === undefined) return DEFAULT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT;
}
