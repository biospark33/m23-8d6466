/**
 * MCP server routes:
 *   POST /api/mcp-servers            — register + spawn + handshake + enumerate
 *   POST /api/mcp-servers/{id}/test  — re-validate transport health, list tools
 *   POST /api/mcp-servers/{id}/invoke — proxy a tool call with arg validation
 */

import {
  buildSubprocessEnv,
  CommandValidationError,
  JsonRpcError,
  log,
  newRequestId,
  SPAWN_TIMEOUT_MS,
  StdioTransport,
  validateCommand,
} from "../mcp/stdio-transport.ts";
import {
  maskEnv,
  MCPInvokeErrorResponseSchema,
  MCPInvokeSchema,
  MCPTestResponseSchema,
  resolveInvokeTimeout,
  ToolBridge,
  toSnakeArgs,
} from "../mcp/tool-bridge.ts";
import {
  CapacityError,
  DuplicateNameError,
  type MCPStore,
  RegisterMCPServerSchema,
} from "../store/mcp-store.ts";
import type { RouteResponse } from "./agents.ts";

// Transport factory is injectable so tests can point at the fake stdio server
// without touching the command allowlist path.
export type TransportFactory = (opts: {
  command: string;
  args: string[];
  env: Record<string, string>;
}) => StdioTransport;

const defaultTransportFactory: TransportFactory = (opts) => new StdioTransport(opts);

export async function handleRegisterMCPServer(
  store: MCPStore,
  payload: unknown,
  requestId = newRequestId(),
  transportFactory: TransportFactory = defaultTransportFactory,
): Promise<RouteResponse> {
  const start = Date.now();
  const parsed = RegisterMCPServerSchema.safeParse(payload);
  if (!parsed.success) {
    return logAndReturn(start, requestId, "mcp.register", {
      status: 400,
      body: { error: "invalid MCP server registration", details: parsed.error.issues },
    });
  }
  const input = parsed.data;

  if (input.transport === "stdio" && !input.command) {
    return logAndReturn(start, requestId, "mcp.register", {
      status: 400,
      body: { error: "stdio transport requires a command" },
    });
  }

  // INV-SC2: command + args allowlist validation BEFORE any spawn.
  try {
    validateCommand({ command: input.command!, args: input.args });
  } catch (err) {
    if (err instanceof CommandValidationError) {
      return logAndReturn(start, requestId, "mcp.register", {
        status: 400,
        body: { error: err.message },
      });
    }
    throw err;
  }

  // Atomic reserve (name uniqueness + capacity) — synchronous, pre-spawn.
  let reservationId: string;
  try {
    reservationId = store.reserve(input.name);
  } catch (err) {
    if (err instanceof DuplicateNameError) {
      return logAndReturn(start, requestId, "mcp.register", { status: 409, body: { error: err.message } });
    }
    if (err instanceof CapacityError) {
      return logAndReturn(start, requestId, "mcp.register", { status: 429, body: { error: err.message } });
    }
    throw err;
  }

  // Construction happens INSIDE the try: a throw here must not leak the
  // reservation (name + capacity slot) — the catch below releases it.
  let stdio: StdioTransport | undefined;
  try {
    // INV-SC3: isolated env for the subprocess.
    const subprocessEnv = buildSubprocessEnv(input.env);
    stdio = transportFactory({ command: input.command!, args: input.args, env: subprocessEnv });
    // Make the in-flight registration killable by shutdownAll() immediately.
    store.attachTransport(reservationId, stdio);
    const bridge = new ToolBridge(stdio, null);
    await stdio.spawn();
    await withSpawnTimeout(stdio.initialize());
    const tools = await bridge.enumerateTools(requestId);
    if (tools.length === 0) {
      // Zero tools at handshake is unhealthy — route to the existing 502 path.
      throw new Error("handshake enumerated zero tools");
    }
    const record = store.finalize(reservationId, {
      name: input.name,
      transport: "stdio",
      command: input.command,
      args: input.args,
      env: input.env,
      createdAt: new Date().toISOString(),
      stdio,
      bridge,
      healthy: true,
    });
    return logAndReturn(start, requestId, "mcp.register", {
      status: 201,
      body: {
        id: record.id,
        name: record.name,
        transport: record.transport,
        command: record.command,
        args: record.args,
        env: maskEnv(record.env), // INV-SC5
        tools,
        createdAt: record.createdAt,
      },
    });
  } catch (err) {
    store.release(reservationId);
    // StdioTransport.shutdown is a no-op when the transport never spawned.
    await stdio?.shutdown(2_000).catch(() => {});
    return logAndReturn(start, requestId, "mcp.register", {
      status: 502,
      body: { ok: false, error: `MCP handshake failed: ${(err as Error).message}` },
    });
  }
}

export async function handleTestMCPServer(
  store: MCPStore,
  id: string,
  requestId = newRequestId(),
): Promise<RouteResponse> {
  const start = Date.now();
  const rec = store.get(id);
  if (!rec) {
    return logAndReturn(start, requestId, "mcp.test", { status: 404, body: { error: "MCP server not found" } });
  }
  if (!rec.stdio.isRunning) {
    rec.healthy = false;
    return logAndReturn(start, requestId, "mcp.test", {
      status: 502,
      body: { ok: false, error: "transport is not running" },
    });
  }
  try {
    const tools = await rec.bridge.enumerateTools(requestId);
    if (tools.length === 0) {
      // ok=true requires a non-empty tool list — zero tools means unhealthy.
      rec.healthy = false;
      return logAndReturn(start, requestId, "mcp.test", {
        status: 502,
        body: { ok: false, error: "transport enumerated zero tools" },
      });
    }
    rec.healthy = true;
    return logAndReturn(start, requestId, "mcp.test", {
      status: 200,
      body: MCPTestResponseSchema.parse({ ok: true, tools }),
    });
  } catch (err) {
    rec.healthy = false;
    return logAndReturn(start, requestId, "mcp.test", {
      status: 502,
      body: { ok: false, error: `transport health check failed: ${(err as Error).message}` },
    });
  }
}

export async function handleInvokeMCPServer(
  store: MCPStore,
  id: string,
  payload: unknown,
  requestId = newRequestId(),
): Promise<RouteResponse> {
  const start = Date.now();
  const rec = store.get(id);
  if (!rec) {
    return logAndReturn(start, requestId, "mcp.invoke", { status: 404, body: { error: "MCP server not found" } });
  }

  // Validate arguments (bank_id etc.) BEFORE dispatch — never touches the subprocess on failure.
  const parsed = MCPInvokeSchema.safeParse(payload);
  if (!parsed.success) {
    const bankIssue = parsed.error.issues.find((iss) => iss.path[iss.path.length - 1] === "bank_id");
    const issue = bankIssue ?? parsed.error.issues[0];
    const fieldPath = issue?.path.join(".");
    return logAndReturn(start, requestId, "mcp.invoke", {
      status: 400,
      body: invokeErrorBody({
        code: -32602,
        message: issue?.message ?? "Invalid params",
        requestId,
        id: null,
        field: fieldPath ? fieldPath : undefined,
        violation: issue?.message,
      }),
    });
  }

  // Validate arguments against the tool's cached inputSchema (required props +
  // top-level primitive types) — no subprocess dispatch on failure. Args are
  // translated camelCase→snake_case first (CC-8), so the check compares
  // like-for-like names against the server's snake_case schema. Unknown
  // tools have no cached schema and fall through to bridge.invoke, which
  // re-enumerates and raises -32601.
  const inputSchema = rec.bridge.getToolInputSchema(parsed.data.tool);
  if (inputSchema) {
    const argViolation = validateAgainstInputSchema(toSnakeArgs(parsed.data.arguments), inputSchema);
    if (argViolation) {
      return logAndReturn(start, requestId, "mcp.invoke", {
        status: 400,
        body: invokeErrorBody({
          code: -32602,
          message: `Invalid params: ${argViolation.violation}`,
          requestId,
          id: null,
          field: argViolation.field,
          violation: argViolation.violation,
        }),
      });
    }
  }

  try {
    const result = await rec.bridge.invoke(
      parsed.data.tool,
      parsed.data.arguments,
      resolveInvokeTimeout(),
      requestId,
    );
    return logAndReturn(start, requestId, "mcp.invoke", {
      status: 200,
      body: { jsonrpc: "2.0", result, id: requestId },
    });
  } catch (err) {
    // Preserve upstream JSON-RPC semantics: client-caused codes are HTTP 400,
    // everything else is a transport/server failure (502).
    if (err instanceof JsonRpcError) {
      const upstream = errorDataStrings(err.data);
      return logAndReturn(start, requestId, "mcp.invoke", {
        status: err.code === -32601 || err.code === -32602 ? 400 : 502,
        body: invokeErrorBody({
          code: err.code,
          message: err.message,
          requestId,
          id: requestId,
          field: upstream.field,
          violation: upstream.violation,
        }),
      });
    }
    return logAndReturn(start, requestId, "mcp.invoke", {
      status: 502,
      body: invokeErrorBody({
        code: -32603,
        message: (err as Error).message,
        requestId,
        id: requestId,
      }),
    });
  }
}

async function withSpawnTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`spawn/handshake timed out after ${SPAWN_TIMEOUT_MS}ms`)),
      SPAWN_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    // Clear the handle so a settled race never leaves a dangling live timer.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Build a JSON-RPC error body and validate it against the DoD response contract. */
function invokeErrorBody(opts: {
  code: number;
  message: string;
  requestId: string;
  id: string | null;
  field?: string;
  violation?: string;
}): unknown {
  return MCPInvokeErrorResponseSchema.parse({
    jsonrpc: "2.0",
    error: {
      code: opts.code,
      message: opts.message,
      data: { field: opts.field, violation: opts.violation, requestId: opts.requestId },
    },
    id: opts.id,
  });
}

/** Keep only string `field`/`violation` from upstream JsonRpcError data, so the
 * merged error body always satisfies MCPInvokeErrorResponseSchema. */
function errorDataStrings(data: unknown): { field?: string; violation?: string } {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return {};
  const d = data as Record<string, unknown>;
  return {
    ...(typeof d.field === "string" ? { field: d.field } : {}),
    ...(typeof d.violation === "string" ? { violation: d.violation } : {}),
  };
}

/**
 * Minimal inputSchema check: required[] properties present, and declared
 * primitive `type` fields matching the actual JSON type. Deliberately NOT a
 * full JSON-Schema engine.
 */
function validateAgainstInputSchema(
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): { field: string; violation: string } | null {
  const required = schema.required;
  if (Array.isArray(required)) {
    for (const prop of required) {
      // hasOwnProperty, not `in`: `in` walks the prototype chain and would let
      // e.g. required:["constructor"] pass against an empty args object.
      if (typeof prop === "string" && !Object.prototype.hasOwnProperty.call(args, prop)) {
        return { field: prop, violation: `required property "${prop}" is missing` };
      }
    }
  }
  const properties = schema.properties;
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

function logAndReturn(
  start: number,
  requestId: string,
  operation: string,
  resp: RouteResponse,
): RouteResponse {
  log({
    requestId,
    operation,
    agentId: null,
    timestamp: new Date().toISOString(),
    duration: Date.now() - start,
    status: resp.status < 400 ? "ok" : "error",
    ...(resp.status >= 400
      ? { error: { code: String(resp.status), message: deriveErrorMessage(resp.body, `${operation} failed`) } }
      : {}),
  });
  return resp;
}

/** CC-9: surface the real error message from the response body when present. */
function deriveErrorMessage(body: unknown, fallback: string): string {
  if (body !== null && typeof body === "object") {
    const err = (body as Record<string, unknown>).error;
    if (typeof err === "string") return err;
    if (err !== null && typeof err === "object") {
      const msg = (err as Record<string, unknown>).message;
      if (typeof msg === "string") return msg;
    }
  }
  return fallback;
}
