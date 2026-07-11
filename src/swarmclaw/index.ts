/**
 * SwarmClaw HTTP surface — minimal hand-rolled router over Bun.serve.
 *
 * Routes:
 *   POST /api/agents
 *   POST /api/mcp-servers
 *   POST /api/mcp-servers/{id}/test
 *   POST /api/mcp-servers/{id}/invoke
 *
 * Lifecycle (AC6): on SIGTERM, propagate SIGTERM to all MCP subprocesses,
 * grace 5s, then SIGKILL, then exit.
 */

import { newRequestId } from "./mcp/stdio-transport.ts";
import { handleRegisterAgent } from "./routes/agents.ts";
import {
  handleInvokeMCPServer,
  handleRegisterMCPServer,
  handleTestMCPServer,
} from "./routes/mcp-servers.ts";
import { AgentStore } from "./store/agent-store.ts";
import { MCPStore } from "./store/mcp-store.ts";

export interface SwarmClawServer {
  port: number;
  agentStore: AgentStore;
  mcpStore: MCPStore;
  stop: () => Promise<void>;
}

export function createServer(port = 0): SwarmClawServer {
  const agentStore = new AgentStore();
  const mcpStore = new MCPStore();

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const requestId = req.headers.get("x-request-id") ?? newRequestId();
      const { method } = req;
      const path = url.pathname;

      const json = (r: { status: number; body: unknown }) =>
        new Response(JSON.stringify(r.body), {
          status: r.status,
          headers: { "content-type": "application/json", "x-request-id": requestId },
        });

      try {
        if (method === "POST" && path === "/api/agents") {
          return json(await handleRegisterAgent(agentStore, await safeJson(req), requestId));
        }
        if (method === "POST" && path === "/api/mcp-servers") {
          return json(await handleRegisterMCPServer(mcpStore, await safeJson(req), requestId));
        }
        const testMatch = path.match(/^\/api\/mcp-servers\/([^/]+)\/test$/);
        if (method === "POST" && testMatch) {
          return json(await handleTestMCPServer(mcpStore, testMatch[1]!, requestId));
        }
        const invokeMatch = path.match(/^\/api\/mcp-servers\/([^/]+)\/invoke$/);
        if (method === "POST" && invokeMatch) {
          return json(await handleInvokeMCPServer(mcpStore, invokeMatch[1]!, await safeJson(req), requestId));
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    },
  });

  const stop = async () => {
    await mcpStore.shutdownAll();
    server.stop(true);
  };

  return { port: server.port ?? port, agentStore, mcpStore, stop };
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

// Standalone entry point: `bun src/swarmclaw/index.ts`. Guarded so importing
// this module in tests does not start a server or install signal handlers.
if (import.meta.main) {
  const port = Number(process.env.SWARMCLAW_PORT ?? 3100);
  const srv = createServer(port);
  process.stdout.write(`{"level":"info","message":"swarmclaw listening","port":${srv.port}}\n`);

  let shuttingDown = false;
  const onSigterm = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`{"level":"info","message":"SIGTERM received, shutting down"}\n`);
    // shutdownAll propagates SIGTERM to subprocesses, waits the grace window,
    // then SIGKILLs stragglers (StdioTransport.shutdown).
    await srv.stop();
    process.exit(0);
  };
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigterm);
}
