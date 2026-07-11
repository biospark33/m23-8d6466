/**
 * MCP server routes:
 *   POST /api/mcp-servers            — register + spawn + handshake + enumerate
 *   POST /api/mcp-servers/{id}/test  — re-validate transport health, list tools
 *   POST /api/mcp-servers/{id}/invoke — proxy a tool call with arg validation
 */

import {
  buildSubprocessEnv,
  CommandValidationError,
  log,
  newRequestId,
  SPAWN_TIMEOUT_MS,
  StdioTransport,
  validateCommand,
} from "../mcp/stdio-transport.ts";
import {
  maskEnv,
  MCPInvokeSchema,
  resolveInvokeTimeout,
  ToolBridge,
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

  // INV-SC3: isolated env for the subprocess.
  const subprocessEnv = buildSubprocessEnv(input.env);
  const stdio = transportFactory({ command: input.command!, args: input.args, env: subprocessEnv });
  const bridge = new ToolBridge(stdio, null);

  try {
    await stdio.spawn();
    await withSpawnTimeout(stdio.initialize());
    const tools = await bridge.enumerateTools(requestId);
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
    await stdio.shutdown(2_000).catch(() => {});
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
    rec.healthy = true;
    return logAndReturn(start, requestId, "mcp.test", { status: 200, body: { ok: true, tools } });
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
    return logAndReturn(start, requestId, "mcp.invoke", {
      status: 400,
      body: {
        jsonrpc: "2.0",
        error: {
          code: -32602,
          message: issue?.message ?? "Invalid params",
          data: {
            field: issue ? String(issue.path.join(".")) : undefined,
            violation: issue?.message,
            requestId,
          },
        },
        id: null,
      },
    });
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
    return logAndReturn(start, requestId, "mcp.invoke", {
      status: 502,
      body: {
        jsonrpc: "2.0",
        error: { code: -32603, message: (err as Error).message, data: { requestId } },
        id: requestId,
      },
    });
  }
}

async function withSpawnTimeout<T>(p: Promise<T>): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`spawn/handshake timed out after ${SPAWN_TIMEOUT_MS}ms`)), SPAWN_TIMEOUT_MS),
  );
  return Promise.race([p, timeout]);
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
    ...(resp.status >= 400 ? { error: { code: String(resp.status), message: `${operation} failed` } } : {}),
  });
  return resp;
}
