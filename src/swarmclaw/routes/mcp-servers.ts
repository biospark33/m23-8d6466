/**
 * MCP server routes:
 *   POST /api/mcp-servers            — register + spawn + handshake + enumerate
 *   POST /api/mcp-servers/{id}/test  — re-validate transport health, list tools
 *   POST /api/mcp-servers/{id}/invoke — proxy a tool call with arg validation
 *   DELETE /api/mcp-servers/{id}    — reclaim: shut the subprocess down, free the slot
 */

import {
  buildSubprocessEnv,
  CommandValidationError,
  JsonRpcError,
  newRequestId,
  StdioTransport,
  validateCommand,
} from "../mcp/stdio-transport.ts";
import {
  assertInvokeResultWithinCap,
  maskEnv,
  MCPInvokeErrorResponseSchema,
  MCPInvokeSchema,
  MCPResultTooLargeError,
  MCPTestResponseSchema,
  resolveInvokeTimeout,
  ToolBridge,
  toSnakeArgs,
  validateArgsAgainstInputSchema,
} from "../mcp/tool-bridge.ts";
import {
  CapacityError,
  DuplicateNameError,
  type MCPStore,
  RegisterMCPServerSchema,
} from "../store/mcp-store.ts";
import { logResponse, type RouteResponse } from "./agents.ts";

// Transport factory is injectable so tests can point at the fake stdio server
// without touching the command allowlist path.
export type TransportFactory = (opts: {
  command: string;
  args: string[];
  env: Record<string, string>;
}) => StdioTransport;

const defaultTransportFactory: TransportFactory = (opts) => new StdioTransport(opts);

// Grace before SIGKILL when tearing down a failed registration. Shorter than
// the 5s runtime default: a transport that never finished its handshake has no
// in-flight work to drain and its child dies promptly, so a long wait only
// delays the error response.
const REGISTRATION_TEARDOWN_GRACE_MS = 2_000;

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
    // The transport enforces the spawn/handshake timeout internally (SPAWN_TIMEOUT_MS).
    await stdio.initialize();
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
    await stdio?.shutdown(REGISTRATION_TEARDOWN_GRACE_MS).catch(() => {});
    // A shutdown that began mid-registration (store closed, or the transport
    // drained before spawn) is service-unavailable, not a handshake failure.
    // Both messages are SwarmClaw's own (not subprocess-controlled), so echoing
    // them in the body is safe and matches the documented 503 contract.
    if (
      err instanceof Error &&
      (err.message === "store is shutting down" || err.message === "transport is shutting down")
    ) {
      return logAndReturn(start, requestId, "mcp.register", {
        status: 503,
        body: { ok: false, error: err.message },
      });

    }
    // JsonRpcError carries a child-controlled message (subprocess JSON-RPC error
    // text); never surface it in the response body — log the detail server-side.
    // Every other error here is SwarmClaw's own message (zero-tools, timeout,
    // frame cap, transport-closed) or a system error (ENOENT), safe to surface.
    const safeMessage = err instanceof JsonRpcError ? "MCP handshake failed" : (err as Error).message;
    return logAndReturn(
      start,
      requestId,
      "mcp.register",
      { status: 502, body: { ok: false, error: safeMessage } },
      (err as Error).message,
    );
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
    return logAndReturn(start, requestId, "mcp.test", {
      status: 404,
      body: { ok: false, error: "MCP server not found" },
    });
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
    // JsonRpcError carries a child-controlled message; surface a stable public
    // message and keep the detail server-side only.
    const safeMessage = err instanceof JsonRpcError ? "transport health check failed" : `transport health check failed: ${(err as Error).message}`;
    return logAndReturn(start, requestId, "mcp.test", {
      status: 502,
      body: { ok: false, error: safeMessage },
    }, (err as Error).message);
  }
}

/**
 * F069 — the reclaim route. Registration was one-way: nothing but a restart
 * (`shutdownAll`) freed a slot, so every caller that registers per invocation
 * leaked a record AND a live subprocess against the 32-server cap. Deleting is
 * idempotent from the caller's side in the only sense that matters — a second
 * delete is a 404, never a 500 — and the store frees the name and the slot
 * synchronously, before the transport shutdown it awaits.
 */
export async function handleDeleteMCPServer(
  store: MCPStore,
  id: string,
  requestId = newRequestId(),
): Promise<RouteResponse> { // dp:ok route handler — the server's fetch handler (index.ts) wraps every route in try/catch and answers 500
  const start = Date.now();
  if (!(await store.remove(id))) {
    return logAndReturn(start, requestId, "mcp.delete", {
      status: 404,
      body: { ok: false, error: "MCP server not found" },
    });
  }
  return logAndReturn(start, requestId, "mcp.delete", { status: 200, body: { ok: true, id } });
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

  // Short-circuit a dead transport before validation/dispatch (mirrors
  // handleTestMCPServer): invoking a shut-down transport would otherwise wait
  // out the full invoke timeout on a request that can never be answered.
  if (!rec.stdio.isRunning) {
    rec.healthy = false;
    return logAndReturn(start, requestId, "mcp.invoke", {
      status: 502,
      body: invokeErrorBody({ code: -32603, message: "transport is not running", requestId, id: requestId }),
    });
  }

  // Validate arguments (bank_id etc.) BEFORE dispatch — never touches the subprocess on failure.
  const parsed = MCPInvokeSchema.safeParse(payload);
  if (!parsed.success) {
    const bankIssue = parsed.error.issues.find(
      (iss) => iss.path[iss.path.length - 1] === "bank_id" || iss.path[iss.path.length - 1] === "bankId",
    );
    const issue = bankIssue ?? parsed.error.issues[0];
    const fieldPath = issue?.path.join(".");
    return logAndReturn(start, requestId, "mcp.invoke", {
      status: 400,
      body: invokeErrorBody({
        code: -32602,
        message: issue?.message ?? "Invalid params",
        requestId,
        id: requestId,
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
    const argViolation = validateArgsAgainstInputSchema(inputSchema, toSnakeArgs(parsed.data.arguments));
    if (argViolation) {
      return logAndReturn(start, requestId, "mcp.invoke", {
        status: 400,
        body: invokeErrorBody({
          code: -32602,
          message: `Invalid params: ${argViolation.violation}`,
          requestId,
          id: requestId,
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
    // The success payload comes from an untrusted subprocess and was echoed
    // verbatim, unshaped and bounded only by the transport's 16 MB frame cap
    // — while every error path here is schema-validated (F067). State the
    // contract: permissive about shape, hard-capped on serialized size.
    assertInvokeResultWithinCap(result);
    return logAndReturn(start, requestId, "mcp.invoke", {
      status: 200,
      body: { jsonrpc: "2.0", result, id: requestId },
    });
  } catch (err) {
    if (err instanceof MCPResultTooLargeError) {
      return logAndReturn(start, requestId, "mcp.invoke", {
        status: 502,
        body: invokeErrorBody({ code: -32603, message: err.message, requestId, id: requestId }),
      });
    }
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

/** Build a JSON-RPC error body and validate it against the DoD response contract. */
function invokeErrorBody(opts: {
  code: number;
  message: string;
  requestId: string;
  id: string;
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

function logAndReturn(
  start: number,
  requestId: string,
  operation: string,
  resp: RouteResponse,
  /** Optional server-side-only diagnostic detail for the log's error.message.
   * When omitted, the message is derived from the response body (which is
   * already sanitized for the client). Used to preserve subprocess-sourced
   * detail in logs WITHOUT leaking it into the response body. */
  detail?: string,
): RouteResponse {
  // MCP routes carry no agentId in the CC-9 entry. `detail` (when present) is
  // server-side-only log diagnostic — preserved in the log entry's error.message
  // WITHOUT leaking into resp.body (which is already sanitized for the client).
  return logResponse(start, requestId, operation, null, resp, detail);

}
