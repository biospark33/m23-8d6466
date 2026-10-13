/**
 * AC-1 (make-or-break): SwarmClaw `/invoke` bridge → fake Hindsight MCP fixture.
 *
 * Drives the REAL P0.7 route handlers (handleRegisterMCPServer /
 * handleTestMCPServer / handleInvokeMCPServer) against a REAL MCPStore + a
 * TransportFactory pointing at tests/swarmclaw/fixtures/fake-hindsight-mcp.ts
 * (a bun subprocess speaking the same MCP stdio JSON-RPC lifecycle as
 * fake-mcp-server.ts). This is the integration proof that the four Hindsight
 * tools round-trip through SwarmClaw's bridge without a live Hindsight binary
 * (which is unreachable on this host per research-brief.md).
 *
 * Also covers AC-3: a valid-but-nonexistent bank_id surfaces as
 * MCPInvokeErrorResponseSchema with HTTP 502 (the fake's recall tool emits a
 * -32000 "bank not found" JSON-RPC error, which P0.7 maps to 502 because it is
 * NOT -32601/-32602).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveBankId } from "../../src/hindsight/index.ts";
import { type LogEntry, setLogSink } from "../../src/lib/log.ts";
import { StdioTransport } from "../../src/swarmclaw/mcp/stdio-transport.ts";
import {
  handleInvokeMCPServer,
  handleRegisterMCPServer,
  handleTestMCPServer,
  type TransportFactory,
} from "../../src/swarmclaw/routes/mcp-servers.ts";
import { MCPStore } from "../../src/swarmclaw/store/mcp-store.ts";

const FAKE_HINDSIGHT = join(import.meta.dir, "..", "swarmclaw", "fixtures", "fake-hindsight-mcp.ts");

// Transport factory mirroring tests/swarmclaw/agent-mcp-registration.test.ts's
// fakeFactory: always spawns the fake-hindsight fixture via bun, ignoring the
// declared command. Registration-time command validation already ran on the
// DECLARED command before this factory is called.
function fakeHindsightFactory(extraEnv: Record<string, string> = {}): TransportFactory {
  return (opts) =>
    new StdioTransport({
      command: "bun",
      args: [FAKE_HINDSIGHT],
      env: { PATH: process.env.PATH ?? "", ...opts.env, ...extraEnv },
      validationEnv: { ...process.env, SWARMCLAW_COMMAND_ALLOWLIST: "bun", SWARMCLAW_ARG_POLICY: "bun" },
    });
}

const stores: MCPStore[] = [];
function newMcpStore(): MCPStore {
  const s = new MCPStore();
  stores.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.shutdownAll().catch(() => {})));
});

// Parse the tools/call result content payload (the fake wraps every successful
// result as { content:[{type:"text", text: JSON.stringify(payload)}] }).
function parseResultContent(body: unknown): unknown {
  const b = body as { result: { content: Array<{ text: string }> } };
  return JSON.parse(b.result.content[0]!.text);
}

describe("AC-1 bridge proof: register hindsight → /test → /invoke round-trip", () => {
  test("register via fakeFactory → /test ok:true with all 4 tools", async () => {
    const mcpStore = newMcpStore();
    const reg = await handleRegisterMCPServer(
      mcpStore,
      { name: "hindsight", transport: "stdio", command: "hindsight-local-mcp" },
      "req-register",
      fakeHindsightFactory(),
    );
    expect(reg.status).toBe(201);
    const regBody = reg.body as { id: string; tools: string[] };
    expect([...regBody.tools].sort()).toEqual(["consolidate", "recall", "reflect", "retain"]);

    const testResp = await handleTestMCPServer(mcpStore, regBody.id, "req-test");
    expect(testResp.status).toBe(200);
    const testBody = testResp.body as { ok: boolean; tools: string[] };
    expect(testBody.ok).toBe(true);
    expect([...testBody.tools].sort()).toEqual(["consolidate", "recall", "reflect", "retain"]);
  }, 30000);

  test("AC-1 (make-or-break): retain → recall → reflect → consolidate through /invoke", async () => {
    const mcpStore = newMcpStore();
    const logs: LogEntry[] = [];
    const restoreSink = setLogSink((e) => logs.push(e));
    try {
      const reg = await handleRegisterMCPServer(
        mcpStore,
        { name: "hindsight-rt", transport: "stdio", command: "hindsight-local-mcp" },
        "req-register-rt",
        fakeHindsightFactory(),
      );
      expect(reg.status).toBe(201);
      const id = (reg.body as { id: string }).id;

      const bankId = resolveBankId("QDS-Factory");
      // Sanity: resolveBankId("QDS-Factory") === "qds-factory" (CC-6).
      expect(bankId).toBe("qds-factory");

      // 1) retain — auto-creates the bank. Story content token: "SPARC methodology".
      const content = "Sprint planning uses SPARC methodology";
      const retainResp = await handleInvokeMCPServer(
        mcpStore,
        id,
        { tool: "retain", arguments: { bank_id: bankId, content } },
        "req-retain",
      );
      expect(retainResp.status).toBe(200);
      const retainBody = retainResp.body as { jsonrpc: string; result: unknown; id: string };
      expect(retainBody.jsonrpc).toBe("2.0");
      expect(retainBody.id).toBe("req-retain");
      const retainPayload = parseResultContent(retainBody) as {
        memoryId: string;
        bankId: string;
        status: string;
        durationMs: number;
      };
      expect(retainPayload.bankId).toBe(bankId);
      expect(retainPayload.status).toBe("created");
      expect(typeof retainPayload.memoryId).toBe("string");
      expect(retainPayload.memoryId.length).toBeGreaterThan(0);
      expect(typeof retainPayload.durationMs).toBe("number");

      // 2) recall — query tokens "planning methodology" must hit the retained content.
      const recallResp = await handleInvokeMCPServer(
        mcpStore,
        id,
        { tool: "recall", arguments: { bank_id: bankId, query: "planning methodology", limit: 5 } },
        "req-recall",
      );
      expect(recallResp.status).toBe(200);
      const recallBody = recallResp.body as { jsonrpc: string; result: unknown; id: string };
      expect(recallBody.jsonrpc).toBe("2.0");
      expect(recallBody.id).toBe("req-recall");
      const recallPayload = parseResultContent(recallBody) as {
        results: Array<{ content: string; score: number; memoryId: string }>;
        durationMs: number;
      };
      expect(recallPayload.results.length).toBeGreaterThan(0);
      const topHit = recallPayload.results[0]!;
      // AC-1: "recall response contains the retained content".
      expect(topHit.content).toContain("SPARC");
      expect(topHit.content).toContain(content);
      expect(topHit.score).toBeGreaterThanOrEqual(0.5);
      expect(topHit.score).toBeLessThanOrEqual(1);

      // 3) reflect — non-empty insight synthesized from bank contents.
      const reflectResp = await handleInvokeMCPServer(
        mcpStore,
        id,
        { tool: "reflect", arguments: { bank_id: bankId } },
        "req-reflect",
      );
      expect(reflectResp.status).toBe(200);
      const reflectBody = reflectResp.body as { jsonrpc: string; result: unknown; id: string };
      expect(reflectBody.jsonrpc).toBe("2.0");
      expect(reflectBody.id).toBe("req-reflect");
      const reflectPayload = parseResultContent(reflectBody) as {
        bankId: string;
        insights: Array<{ summary: string; relatedMemories?: number }>;
        durationMs: number;
      };
      expect(reflectPayload.bankId).toBe(bankId);
      expect(reflectPayload.insights.length).toBeGreaterThan(0);
      // AC-1: "reflect response contains a non-empty insight string".
      const insight = reflectPayload.insights[0]!;
      expect(typeof insight.summary).toBe("string");
      expect(insight.summary.length).toBeGreaterThan(0);
      // The insight references the retained content (proves it read the bank).
      expect(insight.summary).toContain(bankId);

      // 4) consolidate — valid ConsolidateResponseSchema shape.
      const consolidateResp = await handleInvokeMCPServer(
        mcpStore,
        id,
        { tool: "consolidate", arguments: { bank_id: bankId, options: { preserveRecent: 10 } } },
        "req-consolidate",
      );
      expect(consolidateResp.status).toBe(200);
      const consolidateBody = consolidateResp.body as { jsonrpc: string; result: unknown; id: string };
      expect(consolidateBody.jsonrpc).toBe("2.0");
      expect(consolidateBody.id).toBe("req-consolidate");
      const consolidatePayload = parseResultContent(consolidateBody) as {
        consolidatedCount: number;
        preservedCount: number;
        durationMs: number;
      };
      expect(typeof consolidatePayload.consolidatedCount).toBe("number");
      expect(consolidatePayload.consolidatedCount).toBeGreaterThanOrEqual(0);
      expect(typeof consolidatePayload.preservedCount).toBe("number");
      expect(consolidatePayload.preservedCount).toBeGreaterThanOrEqual(1);
      expect(typeof consolidatePayload.durationMs).toBe("number");

      // Phase-1 round-trip check: re-recall the original content after
      // consolidation and confirm a relevant result still surfaces (story
      // AC-1 Phase-1 clause).
      const reRecall = await handleInvokeMCPServer(
        mcpStore,
        id,
        { tool: "recall", arguments: { bank_id: bankId, query: "planning methodology" } },
        "req-rerecall",
      );
      expect(reRecall.status).toBe(200);
      const rePayload = parseResultContent(reRecall.body) as {
        results: Array<{ content: string; score: number }>;
      };
      expect(rePayload.results.length).toBeGreaterThan(0);
      expect(rePayload.results[0]!.content).toContain("SPARC");
    } finally {
      restoreSink();
    }

    // CC-9 observability: each invoke logged an mcp.invoke entry carrying its
    // requestId. Proves the bridge path instrumented every leg of the round-trip.
    const invokeLogs = logs.filter((l) => l.operation === "mcp.invoke");
    const seenIds = new Set(invokeLogs.map((l) => l.requestId));
    for (const rid of ["req-retain", "req-recall", "req-reflect", "req-consolidate", "req-rerecall"]) {
      expect(seenIds.has(rid)).toBe(true);
    }
  }, 30000);

  test("retain to non-existent bank auto-creates it (story contract)", async () => {
    const mcpStore = newMcpStore();
    const reg = await handleRegisterMCPServer(
      mcpStore,
      { name: "hindsight-autocreate", transport: "stdio", command: "hindsight-local-mcp" },
      undefined,
      fakeHindsightFactory(),
    );
    const id = (reg.body as { id: string }).id;

    // Fresh bank that has never been touched — retain must auto-create.
    const freshBank = "never-before-seen-bank";
    const resp = await handleInvokeMCPServer(mcpStore, id, {
      tool: "retain",
      arguments: { bank_id: freshBank, content: "first post" },
    });
    expect(resp.status).toBe(200);
    const payload = parseResultContent(resp.body) as { status: string; bankId: string };
    expect(payload.status).toBe("created");
    expect(payload.bankId).toBe(freshBank);

    // Second retain to the now-existing bank → "updated", not "created".
    const resp2 = await handleInvokeMCPServer(mcpStore, id, {
      tool: "retain",
      arguments: { bank_id: freshBank, content: "second post" },
    });
    expect(resp2.status).toBe(200);
    const payload2 = parseResultContent(resp2.body) as { status: string };
    expect(payload2.status).toBe("updated");
  }, 30000);
});

describe("AC-3: valid-but-nonexistent bank_id → HTTP 502 via the bridge", () => {
  test("recall on a bank that was never created → 502, error code NOT -32601/-32602", async () => {
    const mcpStore = newMcpStore();
    const reg = await handleRegisterMCPServer(
      mcpStore,
      { name: "hindsight-ac3", transport: "stdio", command: "hindsight-local-mcp" },
      undefined,
      fakeHindsightFactory(),
    );
    const id = (reg.body as { id: string }).id;

    const resp = await handleInvokeMCPServer(
      mcpStore,
      id,
      { tool: "recall", arguments: { bank_id: "does-not-exist-bank", query: "anything" } },
      "req-ac3",
    );
    // AC-3: HTTP 502 — the fake emits -32000 (bank not found), which P0.7's
    // bridge maps to 502 because -32000 is NOT in {-32601, -32602}.
    expect(resp.status).toBe(502);
    const body = resp.body as {
      jsonrpc: string;
      error: { code: number; message: string; data: { requestId: string } };
      id: string;
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe("req-ac3");
    // MCPInvokeErrorResponseSchema shape: error.code is a number, message is a
    // non-empty string, data.requestId echoes the request id.
    expect(typeof body.error.code).toBe("number");
    expect(typeof body.error.message).toBe("string");
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(body.error.message).toContain("does-not-exist-bank");
    expect([-32601, -32602]).not.toContain(body.error.code);
    // The fake emits -32000; assert that specifically so a regression to a
    // 400-mapping code is loud.
    expect(body.error.code).toBe(-32000);
    expect(body.error.data.requestId).toBe("req-ac3");
  }, 30000);

  test("retain to a valid-but-nonexistent bank_id → 200 auto-create (NOT 502)", async () => {
    // Negative control for AC-3: retain's auto-create contract means a valid
    // nonexistent bank does NOT 502 — only recall/reflect/consolidate do.
    // This proves the 502 in the test above is a recall-specific path, not a
    // blanket "unknown bank" rejection.
    const mcpStore = newMcpStore();
    const reg = await handleRegisterMCPServer(
      mcpStore,
      { name: "hindsight-retain-ok", transport: "stdio", command: "hindsight-local-mcp" },
      undefined,
      fakeHindsightFactory(),
    );
    const id = (reg.body as { id: string }).id;
    const resp = await handleInvokeMCPServer(mcpStore, id, {
      tool: "retain",
      arguments: { bank_id: "brand-new-valid-bank", content: "x" },
    });
    expect(resp.status).toBe(200);
  }, 30000);
});
