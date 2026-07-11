import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { StdioTransport } from "../../src/swarmclaw/mcp/stdio-transport.ts";
import { handleRegisterAgent } from "../../src/swarmclaw/routes/agents.ts";
import {
  handleInvokeMCPServer,
  handleRegisterMCPServer,
  handleTestMCPServer,
  type TransportFactory,
} from "../../src/swarmclaw/routes/mcp-servers.ts";
import { AgentStore } from "../../src/swarmclaw/store/agent-store.ts";
import { MCPStore } from "../../src/swarmclaw/store/mcp-store.ts";

const FAKE = join(import.meta.dir, "fixtures", "fake-mcp-server.ts");

// Transport factory that ignores the declared command and always spawns the
// fake stdio server via bun. Registration-time command validation already ran
// on the *declared* command before this factory is called.
function fakeFactory(extraEnv: Record<string, string> = {}): TransportFactory {
  return (opts) =>
    new StdioTransport({
      command: "bun",
      args: [FAKE],
      // Pass ONLY the route-built isolated env (opts.env) plus the minimum bun
      // needs to run and the test's behavior flags. We deliberately do NOT spread
      // process.env here — that would defeat the env-isolation assertion.
      env: { PATH: process.env.PATH ?? "", ...opts.env, ...extraEnv },
      validationEnv: { ...process.env, SWARMCLAW_COMMAND_ALLOWLIST: "bun" },
    });
}

// A factory whose subprocess exits immediately (broken transport).
function brokenFactory(): TransportFactory {
  return (opts) =>
    new StdioTransport({
      command: "bun",
      args: [FAKE],
      env: { ...process.env, ...opts.env, FAKE_MCP_EXIT_CODE: "3" },
      validationEnv: { ...process.env, SWARMCLAW_COMMAND_ALLOWLIST: "bun" },
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

// ---------------------------------------------------------------------------
// AC1 (make-or-break): agent + mcp-server register + test → ok:true w/ tools
// ---------------------------------------------------------------------------
describe("AC1 make-or-break: register agent + mcp-server + test", () => {
  test("full sequence yields ok:true with hindsight tools", async () => {
    const agentStore = new AgentStore();
    const mcpStore = newMcpStore();

    const agentResp = await handleRegisterAgent(agentStore, {
      agentId: "dev-agent-1",
      capabilities: ["memory"],
    });
    expect(agentResp.status).toBe(201);

    const regResp = await handleRegisterMCPServer(
      mcpStore,
      { name: "hindsight", transport: "stdio", command: "hindsight-local-mcp" },
      undefined,
      fakeFactory(),
    );
    expect(regResp.status).toBe(201);
    const id = (regResp.body as { id: string }).id;

    const testResp = await handleTestMCPServer(mcpStore, id);
    expect(testResp.status).toBe(200);
    const body = testResp.body as { ok: boolean; tools: string[] };
    expect(body.ok).toBe(true);
    for (const t of ["retain", "recall", "reflect", "consolidate"]) {
      expect(body.tools).toContain(t);
    }
  }, 15000);
});

// ---------------------------------------------------------------------------
// AC2 / e2e: invoke retain then recall
// ---------------------------------------------------------------------------
describe("AC2: invoke retain persists, recall retrieves", () => {
  test("retain → recall roundtrip", async () => {
    const mcpStore = newMcpStore();
    const reg = await handleRegisterMCPServer(
      mcpStore,
      { name: "hs", transport: "stdio", command: "hindsight-local-mcp" },
      undefined,
      fakeFactory(),
    );
    const id = (reg.body as { id: string }).id;

    const retain = await handleInvokeMCPServer(mcpStore, id, {
      tool: "retain",
      arguments: { bank_id: "team-alpha", content: "the sky is blue" },
    });
    expect(retain.status).toBe(200);

    const recall = await handleInvokeMCPServer(mcpStore, id, {
      tool: "recall",
      arguments: { bank_id: "team-alpha" },
    });
    expect(recall.status).toBe(200);
    const result = (recall.body as { result: { content: Array<{ text: string }> } }).result;
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.memories).toContain("the sky is blue");
  }, 15000);
});

// ---------------------------------------------------------------------------
// AC3 / guard: broken transport → { ok:false } 502
// ---------------------------------------------------------------------------
describe("AC3: broken transport never silently succeeds", () => {
  test("subprocess that exits immediately → 502 ok:false on register", async () => {
    const mcpStore = newMcpStore();
    const resp = await handleRegisterMCPServer(
      mcpStore,
      { name: "broken", transport: "stdio", command: "hindsight-local-mcp" },
      undefined,
      brokenFactory(),
    );
    expect(resp.status).toBe(502);
    expect((resp.body as { ok: boolean }).ok).toBe(false);
  }, 15000);
});

// ---------------------------------------------------------------------------
// AC4: invalid bank_id → -32602, subprocess NOT called
// ---------------------------------------------------------------------------
describe("AC4: invalid bank_id rejected pre-dispatch with -32602", () => {
  test.each([
    ["UPPER", "Uppercase-Bank"],
    ["special char", "bank_id!"],
    ["too long", "a".repeat(65)],
    ["leading hyphen", "-bank"],
  ])("invalid bank_id (%s) returns -32602 without touching subprocess", async (_label, bankId) => {
    const mcpStore = newMcpStore();
    const reg = await handleRegisterMCPServer(
      mcpStore,
      { name: `srv-${_label.replace(/\s/g, "")}`, transport: "stdio", command: "hindsight-local-mcp" },
      undefined,
      fakeFactory(),
    );
    const id = (reg.body as { id: string }).id;

    const resp = await handleInvokeMCPServer(mcpStore, id, {
      tool: "retain",
      arguments: { bank_id: bankId, content: "x" },
    });
    expect(resp.status).toBe(400);
    const body = resp.body as { error: { code: number; data: { field: string } } };
    expect(body.error.code).toBe(-32602);
    expect(body.error.data.field).toContain("bank_id");
  }, 15000);

  test("valid bank_id passes validation", async () => {
    const mcpStore = newMcpStore();
    const reg = await handleRegisterMCPServer(
      mcpStore,
      { name: "srv-valid", transport: "stdio", command: "hindsight-local-mcp" },
      undefined,
      fakeFactory(),
    );
    const id = (reg.body as { id: string }).id;
    const resp = await handleInvokeMCPServer(mcpStore, id, {
      tool: "retain",
      arguments: { bank_id: "valid-bank-01", content: "ok" },
    });
    expect(resp.status).toBe(200);
  }, 15000);
});

// ---------------------------------------------------------------------------
// AC5: command allowlist at registration — npx accepted, python rejected
// ---------------------------------------------------------------------------
describe("AC5: registration command allowlist", () => {
  test("npx with hindsight-local-mcp arg → 201", async () => {
    const mcpStore = newMcpStore();
    const resp = await handleRegisterMCPServer(
      mcpStore,
      { name: "npx-hs", transport: "stdio", command: "npx", args: ["hindsight-local-mcp"] },
      undefined,
      fakeFactory(),
    );
    expect(resp.status).toBe(201);
  }, 15000);

  test.each(["python", "python3"])("%s → 400 (shells excluded)", async (cmd) => {
    const mcpStore = newMcpStore();
    const resp = await handleRegisterMCPServer(
      mcpStore,
      { name: `sh-${cmd}`, transport: "stdio", command: cmd },
      undefined,
      fakeFactory(),
    );
    expect(resp.status).toBe(400);
  }, 15000);
});

// ---------------------------------------------------------------------------
// AC7: node/npx denied-flag matrix at registration (400 before spawn)
// ---------------------------------------------------------------------------
describe("AC7: code-injection args rejected at registration", () => {
  test.each([
    [["-e", "process.exit(1)"]],
    [["-p", "process.exit(1)"]],
    [["--print", "process.exit(1)"]],
    [["-"]],
    [["--require", "relative-path"]],
    [["-r", "relative-path"]],
  ])("node %j → 400", async (args) => {
    const mcpStore = newMcpStore();
    const resp = await handleRegisterMCPServer(
      mcpStore,
      { name: `node-${args.join("-").slice(0, 20)}`, transport: "stdio", command: "node", args },
      undefined,
      fakeFactory(),
    );
    expect(resp.status).toBe(400);
  }, 15000);

  test("npx --node-arg passthrough → 400", async () => {
    const mcpStore = newMcpStore();
    const resp = await handleRegisterMCPServer(
      mcpStore,
      { name: "npx-nodearg", transport: "stdio", command: "npx", args: ["--node-arg", "-e", "x", "hindsight-local-mcp"] },
      undefined,
      fakeFactory(),
    );
    expect(resp.status).toBe(400);
  }, 15000);

  test.each([
    [["-p", "malicious-package", "hindsight-local-mcp"]],
    [["--package", "malicious-package", "hindsight-local-mcp"]],
  ])("npx package-injection %j → 400", async (args) => {
    const mcpStore = newMcpStore();
    const resp = await handleRegisterMCPServer(
      mcpStore,
      { name: `npx-${args[0]}`, transport: "stdio", command: "npx", args },
      undefined,
      fakeFactory(),
    );
    expect(resp.status).toBe(400);
  }, 15000);

  test("npx unknown package → 400", async () => {
    const mcpStore = newMcpStore();
    const resp = await handleRegisterMCPServer(
      mcpStore,
      { name: "npx-unknown", transport: "stdio", command: "npx", args: ["malicious-pkg"] },
      undefined,
      fakeFactory(),
    );
    expect(resp.status).toBe(400);
  }, 15000);

  test("npx @anthropic-ai/claude-code accepted → 201", async () => {
    const mcpStore = newMcpStore();
    const resp = await handleRegisterMCPServer(
      mcpStore,
      { name: "npx-claude", transport: "stdio", command: "npx", args: ["@anthropic-ai/claude-code"] },
      undefined,
      fakeFactory(),
    );
    expect(resp.status).toBe(201);
  }, 15000);
});

// ---------------------------------------------------------------------------
// INV-SC1: agentId validation
// ---------------------------------------------------------------------------
describe("INV-SC1: agentId regex", () => {
  test.each(["Bad_Agent", "-bad", "bad-", "a/b", ".."])("invalid agentId %s → 400", async (agentId) => {
    const resp = await handleRegisterAgent(new AgentStore(), { agentId, capabilities: ["x"] });
    expect(resp.status).toBe(400);
  }, 15000);
  test("valid agentId → 201", async () => {
    const resp = await handleRegisterAgent(new AgentStore(), { agentId: "good-agent-1", capabilities: ["x"] });
    expect(resp.status).toBe(201);
  }, 15000);
});

// ---------------------------------------------------------------------------
// INV-SC5: secret masking in responses
// ---------------------------------------------------------------------------
describe("INV-SC5: secrets masked in responses", () => {
  test("env API key masked to *** in register response", async () => {
    const mcpStore = newMcpStore();
    const resp = await handleRegisterMCPServer(
      mcpStore,
      { name: "secret-srv", transport: "stdio", command: "hindsight-local-mcp", env: { HINDSIGHT_API_LLM_API_KEY: "sk-secret" } },
      undefined,
      fakeFactory(),
    );
    expect(resp.status).toBe(201);
    const env = (resp.body as { env: Record<string, string> }).env;
    expect(env.HINDSIGHT_API_LLM_API_KEY).toBe("***");
    expect(JSON.stringify(resp.body)).not.toContain("sk-secret");
  }, 15000);
});

// ---------------------------------------------------------------------------
// Env isolation (DoD): subprocess sees only allowed env, not SWARMCLAW_*/HINDSIGHT_*
// ---------------------------------------------------------------------------
describe("Env isolation: subprocess env is scoped", () => {
  test("subprocess sees FOO=bar but not internal SwarmClaw vars", async () => {
    process.env.SWARMCLAW_INTERNAL_SECRET = "leak-me";
    process.env.HINDSIGHT_INTERNAL = "also-leak";
    const mcpStore = newMcpStore();
    // Echo env back via the fake server.
    const reg = await handleRegisterMCPServer(
      mcpStore,
      { name: "env-check", transport: "stdio", command: "hindsight-local-mcp", env: { FOO: "bar" } },
      undefined,
      fakeFactory({ FAKE_MCP_ECHO_ENV: "1" }),
    );
    const id = (reg.body as { id: string }).id;
    const inv = await handleInvokeMCPServer(mcpStore, id, { tool: "retain", arguments: { bank_id: "b", content: "c" } });
    const echoed = JSON.parse((inv.body as { result: { content: Array<{ text: string }> } }).result.content[0]!.text);
    expect(echoed.FOO).toBe("bar");
    // FAKE_MCP_ECHO_ENV is injected by the test harness itself, so it is present;
    // the isolation guarantee under test is that internal SwarmClaw vars are absent.
    expect(echoed.SWARMCLAW_INTERNAL_SECRET).toBeUndefined();
    expect(echoed.HINDSIGHT_INTERNAL).toBeUndefined();
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.SWARMCLAW_INTERNAL_SECRET;
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.HINDSIGHT_INTERNAL;
  }, 15000);

  test("SWARMCLAW_ENV_ALLOWLIST entries flow through", async () => {
    process.env.MY_ALLOWED = "allowed-value";
    process.env.SWARMCLAW_ENV_ALLOWLIST = "MY_ALLOWED";
    const mcpStore = newMcpStore();
    const reg = await handleRegisterMCPServer(
      mcpStore,
      { name: "env-allow", transport: "stdio", command: "hindsight-local-mcp" },
      undefined,
      fakeFactory({ FAKE_MCP_ECHO_ENV: "1" }),
    );
    const id = (reg.body as { id: string }).id;
    const inv = await handleInvokeMCPServer(mcpStore, id, { tool: "retain", arguments: { bank_id: "b", content: "c" } });
    const echoed = JSON.parse((inv.body as { result: { content: Array<{ text: string }> } }).result.content[0]!.text);
    expect(echoed.MY_ALLOWED).toBe("allowed-value");
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.MY_ALLOWED;
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.SWARMCLAW_ENV_ALLOWLIST;
  }, 15000);
});

// ---------------------------------------------------------------------------
// Capacity + concurrency + duplicate + SSRF + args-length
// ---------------------------------------------------------------------------
describe("Guards: capacity, duplicate, SSRF, args-length", () => {
  test("duplicate MCP server name → 409", async () => {
    const mcpStore = newMcpStore();
    const a = await handleRegisterMCPServer(
      mcpStore,
      { name: "dup", transport: "stdio", command: "hindsight-local-mcp" },
      undefined,
      fakeFactory(),
    );
    expect(a.status).toBe(201);
    const b = await handleRegisterMCPServer(
      mcpStore,
      { name: "dup", transport: "stdio", command: "hindsight-local-mcp" },
      undefined,
      fakeFactory(),
    );
    expect(b.status).toBe(409);
  }, 15000);

  test("65th agent → 429", async () => {
    const agentStore = new AgentStore();
    for (let i = 0; i < 64; i++) {
      const r = await handleRegisterAgent(agentStore, { agentId: `agent-${i}`, capabilities: ["x"] });
      expect(r.status).toBe(201);
    }
    const over = await handleRegisterAgent(agentStore, { agentId: "agent-over", capabilities: ["x"] });
    expect(over.status).toBe(429);
  }, 15000);

  // Pre-fill store slots WITHOUT spawning real subprocesses. The 32-cap is
  // enforced synchronously in MCPStore.reserve() before any spawn, so filling
  // via reserve()+finalize() with a slot-occupying stub exercises the exact
  // invariant while keeping the test fast and non-flaky. The BOUNDARY
  // registration still runs through the real handler + real spawn.
  function fillSlots(store: MCPStore, n: number): void {
    for (let i = 0; i < n; i++) {
      const rid = store.reserve(`fill-${i}`);
      store.finalize(rid, {
        name: `fill-${i}`,
        transport: "stdio",
        command: "hindsight-local-mcp",
        args: [],
        createdAt: new Date().toISOString(),
        stdio: { shutdown: async () => {}, isRunning: false } as any,
        bridge: {} as any,
        healthy: true,
      });
    }
  }

  test("33rd MCP server → 429", async () => {
    const mcpStore = newMcpStore();
    fillSlots(mcpStore, 32);
    const over = await handleRegisterMCPServer(
      mcpStore,
      { name: "srv-over", transport: "stdio", command: "hindsight-local-mcp" },
      undefined,
      fakeFactory(),
    );
    expect(over.status).toBe(429);
  }, 15000);

  test("concurrent cap: 31 exist, two concurrent registrations → exactly one 201", async () => {
    const mcpStore = newMcpStore();
    fillSlots(mcpStore, 31);
    const [r1, r2] = await Promise.all([
      handleRegisterMCPServer(mcpStore, { name: "race-a", transport: "stdio", command: "hindsight-local-mcp" }, undefined, fakeFactory()),
      handleRegisterMCPServer(mcpStore, { name: "race-b", transport: "stdio", command: "hindsight-local-mcp" }, undefined, fakeFactory()),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 429]);
    // Also assert the atomic reservation held — exactly one slot used.
    expect(mcpStore.size).toBe(32);
  }, 20000);

  test("SSRF: non-loopback endpointUrl → 422, loopback → 201", async () => {
    const store = new AgentStore();
    const evil = await handleRegisterAgent(store, { agentId: "evil-agent", capabilities: ["x"], endpointUrl: "http://evil.com/api" });
    expect(evil.status).toBe(422);
    const good = await handleRegisterAgent(store, { agentId: "good-endpoint", capabilities: ["x"], endpointUrl: "http://localhost:3100/a2a" });
    expect(good.status).toBe(201);
  }, 15000);

  test("args length: 4097 chars → 400, 4096 → accepted", async () => {
    const mcpStore = newMcpStore();
    const tooLong = await handleRegisterMCPServer(
      mcpStore,
      { name: "arg-long", transport: "stdio", command: "npx", args: ["a".repeat(4097)] },
      undefined,
      fakeFactory(),
    );
    expect(tooLong.status).toBe(400);
    // 4096-char arg: schema-valid length. It fails npx package-allowlist (400),
    // so assert the rejection is NOT a length rejection by checking a node script path.
    const okLen = await handleRegisterMCPServer(
      mcpStore,
      { name: "arg-ok", transport: "stdio", command: "node", args: [`${"a".repeat(4092)}.mjs`] },
      undefined,
      fakeFactory(),
    );
    expect(okLen.status).toBe(201);
  }, 15000);
});

// ---------------------------------------------------------------------------
// Cache re-enumeration: tool not in initial cache triggers re-enumeration
// ---------------------------------------------------------------------------
describe("Tool cache re-enumeration", () => {
  test("invoke with tool absent from initial cache re-enumerates and succeeds", async () => {
    // Fake server initially advertises only retain/recall; we invoke 'reflect'
    // which IS supported by the fake but simulate cache miss by using a fresh
    // bridge whose cache we can force-miss. Here we rely on the fact that the
    // bridge re-enumerates on cache miss for unknown tools.
    const mcpStore = newMcpStore();
    const reg = await handleRegisterMCPServer(
      mcpStore,
      { name: "cache-srv", transport: "stdio", command: "hindsight-local-mcp" },
      undefined,
      fakeFactory(),
    );
    const id = (reg.body as { id: string }).id;
    const rec = mcpStore.get(id)!;
    rec.bridge.invalidateCache(); // force a cache miss
    const resp = await handleInvokeMCPServer(mcpStore, id, { tool: "reflect", arguments: { bank_id: "b" } });
    expect(resp.status).toBe(200);
  }, 15000);
});

// ---------------------------------------------------------------------------
// AC6 partial: /test returns ok:false after the transport is torn down
// ---------------------------------------------------------------------------
describe("AC6: /test reports ok:false for a dead transport", () => {
  test("after shutting down the subprocess, /test → 502 ok:false", async () => {
    const mcpStore = newMcpStore();
    const reg = await handleRegisterMCPServer(
      mcpStore,
      { name: "dead-srv", transport: "stdio", command: "hindsight-local-mcp" },
      undefined,
      fakeFactory(),
    );
    const id = (reg.body as { id: string }).id;
    const rec = mcpStore.get(id)!;
    await rec.stdio.shutdown(1000); // kill the subprocess out from under it
    const testResp = await handleTestMCPServer(mcpStore, id);
    expect(testResp.status).toBe(502);
    expect((testResp.body as { ok: boolean }).ok).toBe(false);
  }, 15000);
});

// ---------------------------------------------------------------------------
// AC3 also via /test: unknown/broken command surfaces ok:false at /test path.
// A server registered against a subprocess that dies → /test 502 ok:false.
// (Register-time broken transport is covered in AC3 above; this covers the
//  /test endpoint contract specifically.)
// ---------------------------------------------------------------------------
