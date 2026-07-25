/**
 * PRD §13 Phase-0 clause 6 (Story P0.11).
 *
 * Clause 6 as written: "The Paperclip dashboard is reachable with the Telegram
 * and Hindsight plugins both listed as installed."
 *
 * The clause splits cleanly in two under the v4 architecture:
 *
 *  - Hindsight-plugin half -> LIVE. Paperclip was superseded by SwarmClaw; the
 *    equivalent proof is P0.7's E2E slice (register an agent, register the
 *    Hindsight MCP server, and have its /test report the memory toolset).
 *  - Telegram-plugin half -> VOID. Story P0.8 was killed by the Warren decision
 *    ("Telegram verify deferred"), and OQ-3 is recorded BLOCKED-on-creds with a
 *    Hermes-gateway fallback in effect.
 *
 * MUTATION NOTE: this assertion WRITES. Clause 6's own E2E slice is a
 * REGISTRATION sequence — all four SwarmClaw routes are POST-only and there is
 * no GET listing endpoint, so the bridge cannot be observed without
 * registering. The gate performs the minimum registration the clause requires,
 * writes no credentials, and deletes nothing. The story's original "read-only"
 * invariant was amended to match (INV-1..INV-5).
 *
 * INV-5: point this at a DISPOSABLE SwarmClaw only. One MCP record is created
 * per run and cannot be cleaned up (no listing/delete route), so against a
 * shared long-lived instance repeated runs would consume MAX_MCP_SERVERS=32 and
 * deny capacity to real registrations.
 */
import type { GateAssertion } from "../gate-runner.ts";

const REQUIRED_TOOLS = ["retain", "recall", "reflect", "consolidate"] as const;
const HTTP_TIMEOUT_MS = 10_000;

/** SwarmClaw's own default port is 3100 (src/swarmclaw/index.ts). */
function swarmclawBase(): string {
  return process.env.SWARMCLAW_BASE_URL ?? "http://127.0.0.1:3100";
}

async function postJson(
  url: string,
  body: unknown,
): Promise<{ status: number; json?: any; text?: string; error?: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const text = await res.text();
    try {
      return { status: res.status, json: JSON.parse(text), text };
    } catch {
      return { status: res.status, text };
    }
  } catch (err) {
    return { status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export function mcpBridgeAssertions(): GateAssertion[] {
  return [
    {
      id: "P0.7-swarmclaw-hindsight-mcp-bridge",
      story: "P0.7",
      prd_clause: "§13 P0 clause 6 (Hindsight half)",
      description:
        "A live SwarmClaw registers an agent + the Hindsight MCP server, and /test reports the memory toolset",
      group: "main",
      // Three sequential HTTP calls at HTTP_TIMEOUT_MS each exactly equals the
      // runner's 30 s default, so any latency would turn a real verdict into a
      // bare timeout. Declared so the advertised guard stays true here too.
      timeout_ms: HTTP_TIMEOUT_MS * 3 + 10_000,
      check: async () => {
        const base = swarmclawBase();

        // STABLE id (no pid): agent registration tolerates 409, so a fixed id
        // means repeated gate runs reuse one record instead of accumulating
        // toward MAX_AGENTS. The MCP-server name below cannot do the same —
        // see the note there.
        const agentId = "qds-phase0-gate-probe";
        const agent = await postJson(`${base}/api/agents`, {
          agentId,
          capabilities: ["memory"],
        });
        if (agent.status === 0) {
          return {
            pass: false,
            detail: `SwarmClaw unreachable at ${base}: ${agent.error}. Nothing starts it — there is no start script; run \`bun src/swarmclaw/index.ts\`.`,
          };
        }
        // 409 means a prior probe already registered this id — acceptable.
        if (agent.status !== 201 && agent.status !== 409) {
          return {
            pass: false,
            detail: `POST /api/agents -> ${agent.status}: ${(agent.text ?? "").slice(0, 300)}`,
          };
        }

        // UNIQUE name, deliberately. A stable name would 409 on the second run,
        // and SwarmClaw exposes no `GET /api/mcp-servers` listing and no DELETE
        // (only four POST routes), so the gate could neither recover the prior
        // id to run /test against nor clean the old record up. Uniqueness keeps
        // the assertion actually verifiable on every run; the cost is one
        // probe record per run against MAX_MCP_SERVERS=32, which is why INV-5
        // requires a disposable target. Closing this needs a listing or delete
        // endpoint upstream.
        const server = await postJson(`${base}/api/mcp-servers`, {
          name: `qds-phase0-gate-probe-hindsight-${process.pid}-${Date.now()}`,
          transport: "stdio",
          command: "hindsight-local-mcp",
        });
        if (server.status === 429) {
          // Capacity exhaustion is operationally distinct from a bad request:
          // it means this gate has been re-run against a LONG-LIVED SwarmClaw
          // and is now competing with real registrations for the 32 slots.
          // Say so explicitly rather than reporting a generic registration
          // failure, because the remedy is procedural, not a code fix.
          return {
            pass: false,
            detail:
              `POST /api/mcp-servers -> 429 (MCP server capacity exhausted). ` +
              `The clause-6 probe registers one record per run and SwarmClaw exposes no ` +
              `listing or delete route, so it must only be pointed at a DISPOSABLE ` +
              `SwarmClaw (in-memory stores; restart clears them). Restart the target ` +
              `instance, or add upstream lifecycle endpoints before running the gate ` +
              `against a shared, long-lived server. Body: ${(server.text ?? "").slice(0, 200)}`,
          };
        }
        if (server.status !== 201) {
          return {
            pass: false,
            detail:
              `POST /api/mcp-servers -> ${server.status}: ${(server.text ?? "").slice(0, 300)}. NOTE: the real hindsight-local-mcp in this environment is an HTTP server on :8888/mcp/, not a stdio JSON-RPC binary, so clause 6's literal stdio registration may be unachievable as specified.`,
          };
        }

        const id = server.json?.id;
        if (typeof id !== "string" || id.length === 0) {
          return { pass: false, detail: "registration returned no server id" };
        }

        // encodeURIComponent: `id` comes from the response body, so encoding keeps
        // the probe URL well-formed even if it ever contains path-unsafe characters.
        const tested = await postJson(`${base}/api/mcp-servers/${encodeURIComponent(id)}/test`, {});
        if (tested.status !== 200 || tested.json?.ok !== true) {
          return {
            pass: false,
            detail: `POST /api/mcp-servers/${encodeURIComponent(id)}/test -> ${tested.status}: ${(tested.text ?? "").slice(0, 300)}`,
          };
        }

        const tools: string[] = Array.isArray(tested.json?.tools)
          ? tested.json.tools.map((t: any) => (typeof t === "string" ? t : t?.name)).filter(Boolean)
          : [];
        const missing = REQUIRED_TOOLS.filter((t) => !tools.includes(t));
        return missing.length > 0
          ? { pass: false, detail: `bridge healthy but missing tools: ${missing.join(", ")} (saw: ${tools.join(", ") || "none"})` }
          : { pass: true, detail: `bridge healthy; tools: ${tools.join(", ")}` };
      },
    },
    {
      id: "P0.8-telegram-plugin-installed",
      story: "P0.8 (killed)",
      prd_clause: "§13 P0 clause 6 (Telegram half)",
      description: "Telegram plugin listed as installed on the dashboard",
      group: "main",
      void_reason:
        "P0.8 killed by Warren decision (Telegram verify deferred). OQ-3 is recorded " +
        "BLOCKED-on-creds with the Hermes-driven Telegram gateway as the fallback in effect, " +
        "which clause 8 permits. Telegram approve/resume is re-tested by P1.10, not Phase-0.",
      check: async () => ({ pass: false, detail: "void" }),
    },
  ];
}
