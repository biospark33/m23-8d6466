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

import { timingSafeEqual } from "node:crypto";
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
  hostname: string;
  agentStore: AgentStore;
  mcpStore: MCPStore;
  stop: () => Promise<void>;
}

export function createServer(port = 0): SwarmClawServer {
  const agentStore = new AgentStore();
  const mcpStore = new MCPStore();

  // F002: loopback-only by default. The routes spawn subprocesses and proxy
  // arbitrary tool calls into them, so the listener must not be reachable off
  // the host unless an operator explicitly waives it with SWARMCLAW_BIND.
  // `||` not `??`: a set-but-blank value (`docker -e SWARMCLAW_BIND=`, a blank
  // export, the blank-value style .env.example uses) is NOT a waiver. Bun
  // takes "" as "every interface" while still reporting a hostname, so `??`
  // would fail open silently.
  const hostname = process.env.SWARMCLAW_BIND?.trim() || "127.0.0.1";

  // Both of these are silent fail-opens if tolerated: the process comes up
  // looking configured and is not. Refuse at construction, before a listener
  // exists. (A sourced .env or `docker --env-file` is the realistic path to a
  // blank token — which is why .env.example keeps that line commented out.)
  const startupToken = resolveAuthToken();
  if (!LOOPBACK_HOSTS.has(hostname.toLowerCase()) && startupToken === undefined) {
    throw new Error(
      `SWARMCLAW_BIND=${hostname} waives the loopback bind, so SWARMCLAW_AUTH_TOKEN is required`,
    );
  }

  const server = Bun.serve({
    port,
    hostname,
    async fetch(req) {
      const start = Date.now();
      // CC-9 join key is a UUID — regenerate non-conforming inbound ids
      // (subsumes empty-string and unbounded-length values).
      const hdr = req.headers.get("x-request-id");
      const requestId =
        hdr && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(hdr)
          ? hdr
          : newRequestId();
      const { method } = req;

      const json = (r: { status: number; body: unknown }, extraHeaders?: Record<string, string>) =>
        new Response(JSON.stringify(r.body), {
          status: r.status,
          headers: { "content-type": "application/json", "x-request-id": requestId, ...extraHeaders },
        });

      const logRefusal = (operation: string, code: string, message: string) =>
        log({
          requestId,
          operation,
          agentId: null,
          timestamp: new Date().toISOString(),
          duration: Date.now() - start,
          status: "error",
          error: { code, message },
        });

      const logPayloadTooLarge = () => logRefusal("http.payload_too_large", "413", "payload too large");

      // Bun builds req.url from the Host header, so an empty, whitespace-only,
      // absent (HTTP/1.0) or malformed ("Host: a b c") value leaves it an
      // unparseable target. That parse used to sit above the credential gate
      // AND outside the try/catch, so an unauthenticated caller could throw
      // past both into Bun's default error page — 67KB of source excerpt,
      // stack and absolute file paths, and no CC-9 log line. Refuse here,
      // bodyless, before anything else is parsed.
      let path: string;
      try {
        path = new URL(req.url).pathname;
      } catch {
        logRefusal("http.host_rejected", "403", "unparseable request target");
        return new Response(null, { status: 403, headers: { "x-request-id": requestId, connection: "close" } });
      }

      // No legitimate caller of this surface is a browser, and a browser is
      // the one client that attaches Origin. The loopback listener is
      // reachable from any page the user has open, a `mode: "no-cors"` POST is
      // a simple request (no preflight to fail), and safeJson never checks
      // content-type — so the presence of the header at all is the signal.
      if (req.headers.get("origin") !== null) {
        logRefusal("http.origin_rejected", "403", "browser-origin request");
        return new Response(null, { status: 403, headers: { "x-request-id": requestId, connection: "close" } });
      }

      // F002: bearer credential, checked ABOVE the 413 guard so an
      // unauthenticated caller learns nothing about the body limit and cannot
      // spend the drain budget. Opt-in: unset SWARMCLAW_AUTH_TOKEN leaves the
      // surface as it was (loopback-only is the standing control).
      // Read per request, not captured at startup, so a test can flip it.
      // Keyed on `!== undefined`, not truthiness: startup refuses a
      // set-but-blank token, so a blank one here is a live env mutation —
      // nothing matches "", and every request 401s. Fail closed.
      const rawToken = process.env.SWARMCLAW_AUTH_TOKEN;
      const authToken = rawToken?.trim();
      if (rawToken !== undefined && !(authToken && bearerMatches(req.headers.get("authorization"), authToken))) {
        logRefusal("http.unauthorized", "401", "unauthorized");
        // Close rather than keep-alive: the request body is deliberately left
        // unread here, so the connection must not be pooled with those bytes
        // still buffered (same socket-poisoning reasoning as the 413 path).
        return json(
          { status: 401, body: { error: "unauthorized" } },
          { "www-authenticate": "Bearer", connection: "close" },
        );
      }

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

  return { port: server.port ?? port, hostname: server.hostname ?? hostname, agentStore, mcpStore, stop };
}

// Hostnames that keep the listener on the machine. Anything else is an
// explicit waiver of the loopback bind and must carry a credential.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * The configured bearer token, trimmed. Blank is a configuration ERROR, not
 * "run unauthenticated": `SWARMCLAW_AUTH_TOKEN=` would otherwise boot silently
 * open, and a whitespace-only value would be a guessable credential.
 */
function resolveAuthToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.SWARMCLAW_AUTH_TOKEN;
  if (raw === undefined) return undefined;
  const token = raw.trim();
  if (!token) {
    throw new Error("SWARMCLAW_AUTH_TOKEN is set but blank — unset it to run unauthenticated, or give it a value");
  }
  return token;
}

// Constant-time `Authorization: Bearer <token>` comparison. The whole header
// is compared, so the scheme match is byte-exact by design: "bearer x" and
// "Bearer  x" are rejected. RFC 7235 says the scheme is case-insensitive, but
// every caller here is ours and the strictness costs nothing.
// timingSafeEqual
// throws on unequal lengths, so length is checked first — that leaks only the
// header's length, never which bytes of the token matched.
function bearerMatches(header: string | null, token: string): boolean {
  const got = Buffer.from(header ?? "");
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
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
