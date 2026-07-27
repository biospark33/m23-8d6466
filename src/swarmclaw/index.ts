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

import { log, newRequestId } from "./mcp/stdio-transport.ts";
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
      const start = Date.now();
      const url = new URL(req.url);
      // CC-9 join key is a UUID — regenerate non-conforming inbound ids
      // (subsumes empty-string and unbounded-length values).
      const hdr = req.headers.get("x-request-id");
      const requestId =
        hdr && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(hdr)
          ? hdr
          : newRequestId();
      const { method } = req;
      const path = url.pathname;

      const json = (r: { status: number; body: unknown }, extraHeaders?: Record<string, string>) =>
        new Response(JSON.stringify(r.body), {
          status: r.status,
          headers: { "content-type": "application/json", "x-request-id": requestId, ...extraHeaders },
        });

      const logPayloadTooLarge = () =>
        log({
          requestId,
          operation: "http.payload_too_large",
          agentId: null,
          timestamp: new Date().toISOString(),
          duration: Date.now() - start,
          status: "error",
          error: { code: "413", message: "payload too large" },
        });

      // Reject oversized bodies before buffering them (all routes are POST).
      if (method === "POST") {
        const len = Number(req.headers.get("content-length") ?? 0);
        if (len > MAX_BODY_BYTES) {
          // Drain the refused body off the socket before responding. An
          // unread remainder leaves bytes on a keep-alive connection that
          // Bun's pool reuses, mis-parsing the next request as a 400.
          // ponytail: drain capped at MAX_BODY_BYTES — clears the poisoning
          // for bodies near the cap (the actual failure mode). Pathological
          // multi-GB declared lengths fall back to connection: close below;
          // per-request byte accounting with a hard close is the upgrade path.
          await drainBody(req);
          logPayloadTooLarge();
          return json({ status: 413, body: { error: "payload too large" } }, { connection: "close" });
        }
      }

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
        return json({ status: 404, body: { error: "not found" } });
      } catch (err) {
        // Over-limit body read (chunked requests carry no content-length, so
        // the fast-path guard above cannot see them) — same 413 shape.
        if (err === PAYLOAD_TOO_LARGE) {
          logPayloadTooLarge();
          // Same unread-body reasoning as the declared-length fast path above.
          return json({ status: 413, body: { error: "payload too large" } }, { connection: "close" });
        }
        const e = err instanceof Error ? err : new Error(String(err));
        log({
          requestId,
          operation: "http.unhandled",
          agentId: null,
          timestamp: new Date().toISOString(),
          duration: Date.now() - start,
          status: "error",
          error: { code: "500", message: e.message, stack: e.stack },
        });
        return json({ status: 500, body: { error: "internal server error", requestId } });
      }
    },
  });

  const stop = async () => {
    // Stop accepting new requests first (await HTTP shutdown so a failure to
    // drain/closed listener surfaces, not swallowed); then drain subprocesses.
    // Any handler that survived stop(true) fails reserve/finalize on the closed
    // store and cleans up via its own catch path.
    await server.stop(true);
    await mcpStore.shutdownAll();
  };

  return { port: server.port ?? port, agentStore, mcpStore, stop };
}

export const MAX_BODY_BYTES = 1_048_576;

export const PAYLOAD_TOO_LARGE = new Error("payload too large");

// Drain an unread request body off the socket so a keep-alive client cannot
// reuse a connection whose buffer still holds the refused payload (Bun
// mis-parses the next request on that connection as a 400). Bounded at
// MAX_BODY_BYTES; a body larger than that relies on the connection: close
// response header to evict the channel.
async function drainBody(req: Request): Promise<void> {
  if (!req.body) return;
  const reader = req.body.getReader();
  let drained = 0;
  try {
    while (drained < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      drained += value.length;
    }
  } catch {
    // Socket already closed — nothing left to drain.
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// Exported as a test seam: a unit test drives an over-limit chunked stream
// (no content-length) through the bounded read to assert the PAYLOAD_TOO_LARGE
// → 413 path deterministically, independent of the HTTP-layer race.
export async function safeJson(req: Request): Promise<unknown> {
  const body = req.body;
  if (!body) return {};
  try {
    // Bound the read itself, not just the content-length header: a chunked
    // request has no declared length, so count bytes as they arrive.
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > MAX_BODY_BYTES) {
        await reader.cancel();
        throw PAYLOAD_TOO_LARGE;
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder().decode(merged));
  } catch (err) {
    if (err === PAYLOAD_TOO_LARGE) throw err;
    return {};
  }
}

// Standalone entry point: `bun src/swarmclaw/index.ts`. Guarded so importing
// this module in tests does not start a server or install signal handlers.
if (import.meta.main) {
  const port = Number(process.env.SWARMCLAW_PORT ?? 3100);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(
      `{"level":"error","message":"invalid SWARMCLAW_PORT: ${process.env.SWARMCLAW_PORT} (expected integer 0-65535)"}\n`,
    );
    process.exit(1);
  }
  const srv = createServer(port);
  process.stdout.write(`{"level":"info","message":"swarmclaw listening","port":${srv.port}}\n`);

  let shuttingDown = false;
  const onSigterm = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`{"level":"info","message":"SIGTERM received, shutting down"}\n`);
    // Force-exit watchdog: 12s exceeds the worst case (5s SIGTERM grace +
    // SIGKILL reap + margin) — a stuck shutdown must never hang the process.
    setTimeout(() => process.exit(1), 12_000).unref();
    // shutdownAll propagates SIGTERM to subprocesses, waits the grace window,
    // then SIGKILLs stragglers (StdioTransport.shutdown).
    try {
      await srv.stop();
    } catch {
      // Per-transport failures are already logged by shutdownAll.
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigterm);
}
