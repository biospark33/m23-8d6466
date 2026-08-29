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
 * REGISTRATION sequence — there is no GET listing endpoint, so the bridge
 * cannot be observed without registering. The gate performs the minimum
 * registration the clause requires, writes no credentials, and REVERSES what it
 * created. The story's original "read-only" invariant was amended to match
 * (INV-1..INV-5).
 *
 * INV-5: the probe reclaims its own MCP record. `DELETE /api/mcp-servers/{id}`
 * (F069) now exists, and the probe issues it in a `finally` — so a failed
 * /test, a thrown assertion or a missing toolset all still hand the slot back.
 * Without that, one record was leaked per run against MAX_MCP_SERVERS=32, each
 * holding a live subprocess until restart, and the only mitigation on offer was
 * a comment asking the operator to remember to use a disposable instance. The
 * agent record is still reused rather than deleted (a stable id 409s, which the
 * probe accepts), so nothing accumulates on that side either.
 */
import { z } from "zod";

import { httpRequest } from "../../lib/http.ts";
import type { GateAssertion } from "../gate-runner.ts";

const REQUIRED_TOOLS = ["retain", "recall", "reflect", "consolidate"] as const;
const HTTP_TIMEOUT_MS = 10_000;

/**
 * Operator-facing remedy for a 429. Capacity exhaustion is operationally
 * distinct from a bad request: it means this gate has been re-run against a
 * LONG-LIVED SwarmClaw and is now competing with real registrations for the 32
 * slots. Say so explicitly rather than reporting a generic registration
 * failure, because the remedy is procedural, not a code fix.
 *
 * Held as a const so the message is one template literal at the call site
 * (biome `useTemplate`, issue #F025) without reflowing the prose.
 */
const CAPACITY_EXHAUSTED =
  "POST /api/mcp-servers -> 429 (MCP server capacity exhausted). " +
  "The clause-6 probe registers one record per run and DELETEs it in a finally, " +
  "so it is not the source of the exhaustion unless a prior run was killed " +
  "mid-probe: the 32 slots are held by other registrations. Restart the target " +
  "instance to clear its in-memory stores, or free slots with " +
  "DELETE /api/mcp-servers/{id}, before re-running the gate.";

/**
 * SwarmClaw response shapes, validated rather than trusted (#F028).
 *
 * The bodies are `unknown` on the way in: `any` would let an upstream shape
 * change surface as a silent `undefined` on the pass/fail path instead of a
 * failure. `passthrough` keeps the schemas tolerant of fields the gate does not
 * read — the point is to narrow what IS read, not to pin the whole contract.
 */
const RegistrationSchema = z.object({ id: z.string().min(1) }).passthrough();
const ToolsEnvelopeSchema = z.object({ tools: z.array(z.unknown()) }).passthrough();
const ToolEntrySchema = z.union([
  z.string().min(1),
  z.object({ name: z.string().min(1) }).passthrough(),
]);

/** The registered server's id, or undefined if the body did not carry one. */
export function extractServerId(json: unknown): string | undefined {
  const parsed = RegistrationSchema.safeParse(json);
  return parsed.success ? parsed.data.id : undefined;
}

/** /test reported a healthy bridge. Anything other than a literal `true` is not health. */
export function bridgeTestOk(json: unknown): boolean {
  return z.object({ ok: z.literal(true) }).passthrough().safeParse(json).success;
}

/**
 * Tool names from a /test body. Entries the schema does not recognise are
 * dropped, never coerced — an unreadable entry must not stand in for a tool.
 */
export function extractToolNames(json: unknown): string[] {
  const envelope = ToolsEnvelopeSchema.safeParse(json);
  if (!envelope.success) return [];
  return envelope.data.tools.flatMap((t) => {
    const entry = ToolEntrySchema.safeParse(t);
    if (!entry.success) return [];
    return [typeof entry.data === "string" ? entry.data : entry.data.name];
  });
}

/**
 * The clause-6 predicate. A body with no tools, an empty `tools: []`, or a
 * missing `tools` key all report the full required set as missing — "could not
 * see the toolset" is never a vacuous pass.
 */
export function missingRequiredTools(json: unknown): string[] {
  const tools = extractToolNames(json);
  return REQUIRED_TOOLS.filter((t) => !tools.includes(t));
}

/** SwarmClaw's own default port is 3100 (src/swarmclaw/index.ts). */
function swarmclawBase(): string {
  return process.env.SWARMCLAW_BASE_URL ?? "http://127.0.0.1:3100";
}

/**
 * A request that never throws: a status of 0 means the listener could not be
 * reached at all, which the assertions below report as a distinct verdict from
 * any answer the listener actually gave. `method` defaults to POST — every
 * route the probe drives is one, except the F069 reclaim.
 */
async function sendJson(
  url: string,
  body: unknown,
  method = "POST",
): Promise<{ status: number; json?: unknown; text?: string; error?: string }> {
  // SwarmClaw checks this bearer above its 413 guard when SWARMCLAW_AUTH_TOKEN
  // is configured, and 401s without it; unset means the listener runs open and
  // an Authorization header is simply ignored. No Origin header is ever sent —
  // SwarmClaw refuses any request carrying one (a browser-only signal).
  const token = process.env.SWARMCLAW_AUTH_TOKEN;
  try {
    const { res, text } = await httpRequest(
      url,
      { method, body },
      { timeoutMs: HTTP_TIMEOUT_MS, headers: token ? { authorization: `Bearer ${token}` } : {} },
    );
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
      // Four sequential HTTP calls at HTTP_TIMEOUT_MS each — agents, mcp-servers,
      // /test, and the DELETE in the finally — already exceed the runner's 30 s
      // default, so any latency would turn a real verdict into a bare timeout.
      // The reclaim is INSIDE this budget on purpose: a timeout that fires
      // during the finally re-leaks the slot the finally exists to hand back.
      timeout_ms: HTTP_TIMEOUT_MS * 4 + 10_000,
      check: async () => {
        const base = swarmclawBase();

        // STABLE id (no pid): agent registration tolerates 409, so a fixed id
        // means repeated gate runs reuse one record instead of accumulating
        // toward MAX_AGENTS. The MCP-server name below cannot do the same —
        // see the note there.
        const agentId = "qds-phase0-gate-probe";
        const agent = await sendJson(`${base}/api/agents`, {
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

        // UNIQUE name, deliberately. SwarmClaw exposes no `GET /api/mcp-servers`
        // listing, so a stable name that 409'd on the second run would leave the
        // gate unable to recover the prior id to run /test against. Uniqueness
        // keeps the assertion verifiable on every run, and the record it creates
        // is reclaimed by the DELETE in the finally below (F069) — so the names
        // do not accumulate against MAX_MCP_SERVERS=32 either.
        const server = await sendJson(`${base}/api/mcp-servers`, {
          name: `qds-phase0-gate-probe-hindsight-${process.pid}-${Date.now()}`,
          transport: "stdio",
          command: "hindsight-local-mcp",
        });
        if (server.status === 429) {
          return {
            pass: false,
            detail: `${CAPACITY_EXHAUSTED} Body: ${(server.text ?? "").slice(0, 200)}`,
          };
        }
        if (server.status !== 201) {
          return {
            pass: false,
            detail:
              `POST /api/mcp-servers -> ${server.status}: ${(server.text ?? "").slice(0, 300)}. NOTE: the real hindsight-local-mcp in this environment is an HTTP server on :8888/mcp/, not a stdio JSON-RPC binary, so clause 6's literal stdio registration may be unachievable as specified.`,
          };
        }

        const id = extractServerId(server.json);
        if (id === undefined) {
          return { pass: false, detail: "registration returned no server id" };
        }

        // Everything past the registration runs under the reclaim. A verdict —
        // any verdict — must not cost a slot (F069).
        try {
          // encodeURIComponent: `id` comes from the response body, so encoding keeps
          // the probe URL well-formed even if it ever contains path-unsafe characters.
          const tested = await sendJson(`${base}/api/mcp-servers/${encodeURIComponent(id)}/test`, {});
          if (tested.status !== 200 || !bridgeTestOk(tested.json)) {
            return {
              pass: false,
              detail: `POST /api/mcp-servers/${encodeURIComponent(id)}/test -> ${tested.status}: ${(tested.text ?? "").slice(0, 300)}`,
            };
          }

          const tools = extractToolNames(tested.json);
          const missing = missingRequiredTools(tested.json);
          return missing.length > 0
            ? { pass: false, detail: `bridge healthy but missing tools: ${missing.join(", ")} (saw: ${tools.join(", ") || "none"})` }
            : { pass: true, detail: `bridge healthy; tools: ${tools.join(", ")}` };
        } finally {
          // The reclaim never changes the verdict: the clause is about the
          // bridge's health, not about the cleanup. But a reclaim that did NOT
          // land recreates the exact leak this closes, invisibly, so say so on
          // stderr — the operator needs to know a slot is still held.
          const released = await sendJson(
            `${base}/api/mcp-servers/${encodeURIComponent(id)}`,
            undefined,
            "DELETE",
          );
          if (released.status !== 200) {
            console.warn(
              `[p0-7] could not reclaim probe MCP server ${id}: DELETE -> ${released.status}${released.error ? ` (${released.error})` : ""} — that slot stays held until the target SwarmClaw restarts`,
            );
          }
        }
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
