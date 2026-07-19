import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LogEntry, setLogSink, StdioTransport } from "../../src/swarmclaw/mcp/stdio-transport.ts";
import { handleRegisterAgent } from "../../src/swarmclaw/routes/agents.ts";
import {
  handleInvokeMCPServer,
  handleRegisterMCPServer,
  handleTestMCPServer,
  type TransportFactory,
} from "../../src/swarmclaw/routes/mcp-servers.ts";
import { AgentStore, isLoopbackEndpoint, setDnsLookup } from "../../src/swarmclaw/store/agent-store.ts";
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

// H3: pin SWARMCLAW_NPX_PACKAGE_ALLOWLIST unset for the duration of a describe
// so a host-exported value cannot flip the npx 201/400 expectations.
function pinNpxAllowlistUnset(): void {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.SWARMCLAW_NPX_PACKAGE_ALLOWLIST;
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.SWARMCLAW_NPX_PACKAGE_ALLOWLIST;
  });
  afterEach(() => {
    if (saved === undefined) {
      // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
      delete process.env.SWARMCLAW_NPX_PACKAGE_ALLOWLIST;
    } else {
      process.env.SWARMCLAW_NPX_PACKAGE_ALLOWLIST = saved;
    }
  });
}

/** Capture an env var's current value BEFORE a test overwrites it; call the
 * returned restore() in finally to put it back — deleting only when the var was
 * originally absent (preserves host-provided values instead of clobbering them). */
function saveEnv(key: string): () => void {
  const prev = process.env[key];
  return () => {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  };
}

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
    // CC-9: capture structured logs around one registration + one invoke so we
    // can assert the observability contract (requestId propagation, required
    // fields, timing fields) without an extra spawn.
    const logs: LogEntry[] = [];
    const restoreSink = setLogSink((e) => logs.push(e));
    try {
      const reg = await handleRegisterMCPServer(
        mcpStore,
        { name: "hs", transport: "stdio", command: "hindsight-local-mcp" },
        "req-cc9-register",
        fakeFactory({ FAKE_MCP_ECHO_META: "1" }),
      );
      const id = (reg.body as { id: string }).id;

      const retain = await handleInvokeMCPServer(
        mcpStore,
        id,
        { tool: "retain", arguments: { bank_id: "team-alpha", content: "the sky is blue" } },
        "req-cc9-invoke",
      );
      expect(retain.status).toBe(200);
      // CC-9 wire leg: the subprocess itself must have received _meta.requestId
      // on the tools/call params (tool-bridge.ts:268) — the fixture echoes it
      // back as an extra content entry behind FAKE_MCP_ECHO_META.
      const retainResult = (retain.body as { result: { content: Array<{ text: string }> } }).result;
      const metaEcho = JSON.parse(retainResult.content[1]!.text) as { meta_request_id: string };
      expect(metaEcho.meta_request_id).toBe("req-cc9-invoke");

      const recall = await handleInvokeMCPServer(mcpStore, id, {
        tool: "recall",
        arguments: { bank_id: "team-alpha" },
      });
      expect(recall.status).toBe(200);
      const result = (recall.body as { result: { content: Array<{ text: string }> } }).result;
      const payload = JSON.parse(result.content[0]!.text);
      expect(payload.memories).toContain("the sky is blue");
    } finally {
      restoreSink();
    }

    // CC-9 contract: minimum shape + requestId as the join key.
    const assertCc9Shape = (e: LogEntry, requestId: string) => {
      expect(e.requestId).toBe(requestId);
      expect(typeof e.operation).toBe("string");
      expect(e.agentId).toBeNull();
      expect(typeof e.timestamp).toBe("string");
      expect(typeof e.duration).toBe("number");
      expect(typeof e.status).toBe("string");
    };
    const regEntries = logs.filter((l) => l.operation === "mcp.register" && l.requestId === "req-cc9-register");
    expect(regEntries).toHaveLength(1);
    assertCc9Shape(regEntries[0]!, "req-cc9-register");
    const routeInvokes = logs.filter(
      (l) => l.operation === "mcp.invoke" && l.requestId === "req-cc9-invoke" && !("invoke_duration_ms" in l),
    );
    expect(routeInvokes).toHaveLength(1);
    assertCc9Shape(routeInvokes[0]!, "req-cc9-invoke");
    // MCP bridge timing fields.
    const listTools = logs.find((l) => l.operation === "mcp.list_tools" && l.requestId === "req-cc9-register");
    expect(typeof listTools?.tool_enumeration_ms).toBe("number");
    const bridgeInvokes = logs.filter(
      (l) => l.operation === "mcp.invoke" && l.requestId === "req-cc9-invoke" && "invoke_duration_ms" in l,
    );
    expect(bridgeInvokes).toHaveLength(1);
    expect(typeof bridgeInvokes[0]!.invoke_duration_ms).toBe("number");
    expect(typeof bridgeInvokes[0]!.stdio_latency_ms).toBe("number");
  }, 15000);

  // T15: stdio_latency_ms is a real wire measurement, not a hardcoded 0 — a
  // fixture that holds every response back by 50ms must yield a latency > 0.
  test("stdio_latency_ms reflects real wire latency (delayed fixture)", async () => {
    const mcpStore = newMcpStore();
    const logs: LogEntry[] = [];
    const restoreSink = setLogSink((e) => logs.push(e));
    try {
      const reg = await handleRegisterMCPServer(
        mcpStore,
        { name: "latency-srv", transport: "stdio", command: "hindsight-local-mcp" },
        undefined,
        fakeFactory({ FAKE_MCP_RESPONSE_DELAY_MS: "50" }),
      );
      expect(reg.status).toBe(201);
      const id = (reg.body as { id: string }).id;
      const inv = await handleInvokeMCPServer(
        mcpStore,
        id,
        { tool: "retain", arguments: { bank_id: "b", content: "x" } },
        "req-latency",
      );
      expect(inv.status).toBe(200);
    } finally {
      restoreSink();
    }
    const bridgeInvokes = logs.filter(
      (l) => l.operation === "mcp.invoke" && l.requestId === "req-latency" && "invoke_duration_ms" in l,
    );
    expect(bridgeInvokes).toHaveLength(1);
    expect(typeof bridgeInvokes[0]!.stdio_latency_ms).toBe("number");
    expect(bridgeInvokes[0]!.stdio_latency_ms as number).toBeGreaterThan(0);
  }, 15000);
});

// ---------------------------------------------------------------------------
// AC3 / guard: broken transport → { ok:false, error } 502
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
    const body = resp.body as { ok: boolean; error?: unknown };
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
    expect((body.error as string).length).toBeGreaterThan(0);
  }, 15000);

  test("allowlisted command missing on disk (spawn ENOENT) → 502 ok:false with error", async () => {
    // Deterministic: a unique nonexistent absolute path temporarily added to the
    // command allowlist. No dependency on whether the real binary is installed,
    // and the host allowlist is restored in finally.
    const missingBin = `/tmp/.swarmclaw-enoent-${crypto.randomUUID()}`;
    const restoreAllowlist = saveEnv("SWARMCLAW_COMMAND_ALLOWLIST");
    process.env.SWARMCLAW_COMMAND_ALLOWLIST = missingBin;
    try {
      const mcpStore = newMcpStore();
      // NO factory override: the default factory builds the real StdioTransport,
      // whose Bun.spawn throws ENOENT — the path passes the allowlist but does
      // not exist on disk.
      const resp = await handleRegisterMCPServer(mcpStore, {
        name: "enoent",
        transport: "stdio",
        command: missingBin,
      });
      expect(resp.status).toBe(502);
      const body = resp.body as { ok: boolean; error?: unknown };
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe("string");
      expect((body.error as string).length).toBeGreaterThan(0);
    } finally {
      restoreAllowlist();
    }
  }, 15000);

  // H13: the transport keeps a stderr tail for diagnostics — a subprocess that
  // dies mid-handshake must surface it SERVER-SIDE (log), never in the 502
  // response body (subprocess-controlled text must not reach the API surface).
  test("broken subprocess stderr tail is logged server-side, not leaked in the 502 body", async () => {
    const mcpStore = newMcpStore();
    const logs: LogEntry[] = [];
    const restoreSink = setLogSink((e) => logs.push(e));
    const markerFactory: TransportFactory = (opts) =>
      new StdioTransport({
        command: "bun",
        args: [FAKE],
        env: { ...process.env, ...opts.env, FAKE_MCP_EXIT_CODE: "3", FAKE_MCP_STDERR_MARKER: "marker123" },
        validationEnv: { ...process.env, SWARMCLAW_COMMAND_ALLOWLIST: "bun" },
      });
    try {
      const resp = await handleRegisterMCPServer(
        mcpStore,
        { name: "stderr-broken", transport: "stdio", command: "hindsight-local-mcp" },
        undefined,
        markerFactory,
      );
      expect(resp.status).toBe(502);
      const body = resp.body as { ok: boolean; error?: unknown };
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe("string");
      // Redaction guarantee: subprocess stderr must NEVER appear in the body.
      expect(body.error as string).not.toContain("marker123");
      // The tail is surfaced server-side only, in the transport-close log entry.
      const tailLog = logs.find(
        (l) => typeof l.stderrTail === "string" && (l.stderrTail as string).includes("marker123"),
      );
      expect(tailLog).toBeDefined();
    } finally {
      restoreSink();
    }
  }, 15000);

  test("hanging server → 502 only after the ~10s spawn/handshake timeout", async () => {
    const mcpStore = newMcpStore();
    const start = Date.now();
    const resp = await handleRegisterMCPServer(
      mcpStore,
      { name: "hang", transport: "stdio", command: "hindsight-local-mcp" },
      undefined,
      fakeFactory({ FAKE_MCP_HANG: "1" }),
    );
    const elapsed = Date.now() - start;
    expect(resp.status).toBe(502);
    const body = resp.body as { ok: boolean; error?: unknown };
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
    expect((body.error as string).length).toBeGreaterThan(0);
    // Proves the real 10s withSpawnTimeout path ran, not an instant failure.
    expect(elapsed).toBeGreaterThanOrEqual(9000);
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

    // Wrap the live bridge to prove validation happens pre-dispatch: the
    // subprocess bridge must never be invoked for a rejected payload.
    const rec = mcpStore.get(id)!;
    const orig = rec.bridge.invoke.bind(rec.bridge);
    let calls = 0;
    rec.bridge.invoke = ((...a: Parameters<typeof orig>) => {
      calls++;
      return orig(...a);
    }) as typeof rec.bridge.invoke;

    const resp = await handleInvokeMCPServer(
      mcpStore,
      id,
      {
        tool: "retain",
        arguments: { bank_id: bankId, content: "x" },
      },
      "req-ac4-reject",
    );
    expect(resp.status).toBe(400);
    const body = resp.body as { error: { code: number; data: { field: string } }; id: string };
    expect(body.error.code).toBe(-32602);
    expect(body.error.data.field).toContain("bank_id");
    // R4: the JSON-RPC error body's top-level id echoes the request id (never null).
    expect(body.id).toBe("req-ac4-reject");
    expect(calls).toBe(0);
  }, 15000);

  // H9: the camelCase spelling goes through the same BankIdSchema check.
  test("invalid camelCase bankId → 400 -32602 without touching subprocess", async () => {
    const mcpStore = newMcpStore();
    const reg = await handleRegisterMCPServer(
      mcpStore,
      { name: "srv-camel-bank", transport: "stdio", command: "hindsight-local-mcp" },
      undefined,
      fakeFactory(),
    );
    const id = (reg.body as { id: string }).id;

    const rec = mcpStore.get(id)!;
    const orig = rec.bridge.invoke.bind(rec.bridge);
    let calls = 0;
    rec.bridge.invoke = ((...a: Parameters<typeof orig>) => {
      calls++;
      return orig(...a);
    }) as typeof rec.bridge.invoke;

    const resp = await handleInvokeMCPServer(mcpStore, id, {
      tool: "retain",
      arguments: { bankId: "Bad!", content: "x" },
    });
    expect(resp.status).toBe(400);
    const body = resp.body as { error: { code: number; data: { field: string } } };
    expect(body.error.code).toBe(-32602);
    expect(body.error.data.field).toContain("bankId");
    expect(calls).toBe(0);
  }, 15000);

  // T4: both spellings with DIFFERENT values must be rejected (toSnakeArgs
  // would otherwise let one silently win); same-value duplicates are harmless.
  test("conflicting bank_id + bankId spellings → 400 -32602; same-value pair dispatches", async () => {
    const mcpStore = newMcpStore();
    const reg = await handleRegisterMCPServer(
      mcpStore,
      { name: "srv-both-spellings", transport: "stdio", command: "hindsight-local-mcp" },
      undefined,
      fakeFactory(),
    );
    const id = (reg.body as { id: string }).id;

    const conflict = await handleInvokeMCPServer(mcpStore, id, {
      tool: "retain",
      arguments: { bank_id: "a", bankId: "b", content: "x" },
    });
    expect(conflict.status).toBe(400);
    const conflictBody = conflict.body as { error: { code: number; message: string } };
    expect(conflictBody.error.code).toBe(-32602);
    expect(conflictBody.error.message).toContain("conflicting");

    const same = await handleInvokeMCPServer(mcpStore, id, {
      tool: "retain",
      arguments: { bank_id: "team-x", bankId: "team-x", content: "x" },
    });
    expect(same.status).toBe(200);
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
    // Boundary: the BankIdSchema regex accepts exactly 64 chars…
    const max64 = await handleInvokeMCPServer(mcpStore, id, {
      tool: "retain",
      arguments: { bank_id: "a".repeat(64), content: "ok" },
    });
    expect(max64.status).toBe(200);
    // …and a single char.
    const oneChar = await handleInvokeMCPServer(mcpStore, id, {
      tool: "retain",
      arguments: { bank_id: "b", content: "ok" },
    });
    expect(oneChar.status).toBe(200);
  }, 15000);
});

// ---------------------------------------------------------------------------
// AC5: command allowlist at registration — npx accepted, python rejected
// ---------------------------------------------------------------------------
describe("AC5: registration command allowlist", () => {
  pinNpxAllowlistUnset(); // H3: host env must not flip the npx expectations

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
  pinNpxAllowlistUnset(); // H3: host env must not flip the npx expectations

  test.each([
    [["-e", "process.exit(1)"]],
    [["--eval", "process.exit(1)"]],
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

  // H10: masking is unconditional — keys that do NOT look secret must be
  // masked too (key-name heuristics both under- and over-cover).
  test("non-secret-looking env keys are masked too", async () => {
    const mcpStore = newMcpStore();
    const resp = await handleRegisterMCPServer(
      mcpStore,
      {
        name: "mask-all-srv",
        transport: "stdio",
        command: "hindsight-local-mcp",
        env: { DSN: "postgres://u:p@h/db", PLAIN_LOOKUP: "x" },
      },
      undefined,
      fakeFactory(),
    );
    expect(resp.status).toBe(201);
    const env = (resp.body as { env: Record<string, string> }).env;
    expect(env.DSN).toBe("***");
    expect(env.PLAIN_LOOKUP).toBe("***");
    expect(JSON.stringify(resp.body)).not.toContain("postgres://u:p@h/db");
  }, 15000);
});

// ---------------------------------------------------------------------------
// Env isolation (DoD): subprocess sees only allowed env, not SWARMCLAW_*/HINDSIGHT_*
// ---------------------------------------------------------------------------
describe("Env isolation: subprocess env is scoped", () => {
  test("subprocess sees FOO=bar but not internal SwarmClaw vars", async () => {
    const restoreSecret = saveEnv("SWARMCLAW_INTERNAL_SECRET");
    const restoreHindsight = saveEnv("HINDSIGHT_INTERNAL");
    process.env.SWARMCLAW_INTERNAL_SECRET = "leak-me";
    process.env.HINDSIGHT_INTERNAL = "also-leak";
    try {
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
    } finally {
      // Restore even on assertion failure — leaked vars would poison other tests.
      restoreSecret();
      restoreHindsight();
    }
  }, 15000);

  test("SWARMCLAW_ENV_ALLOWLIST entries flow through", async () => {
    const restoreMyAllowed = saveEnv("MY_ALLOWED");
    const restoreAllowlist = saveEnv("SWARMCLAW_ENV_ALLOWLIST");
    process.env.MY_ALLOWED = "allowed-value";
    process.env.SWARMCLAW_ENV_ALLOWLIST = "MY_ALLOWED";
    try {
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
    } finally {
      restoreMyAllowed();
      restoreAllowlist();
    }
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

  // H8: agents get the same duplicate treatment as MCP server names.
  test("duplicate agentId → 409", async () => {
    const agentStore = new AgentStore();
    const a = await handleRegisterAgent(agentStore, { agentId: "dup-agent", capabilities: ["x"] });
    expect(a.status).toBe(201);
    const b = await handleRegisterAgent(agentStore, { agentId: "dup-agent", capabilities: ["x"] });
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

  // R10: the duplicate check runs BEFORE the capacity check — re-registering
  // an existing agentId on a full store is a conflict, not an overflow.
  test("re-registering an existing agentId on a FULL store → 409 (not 429)", async () => {
    const agentStore = new AgentStore();
    for (let i = 0; i < 64; i++) {
      const r = await handleRegisterAgent(agentStore, { agentId: `agent-${i}`, capabilities: ["x"] });
      expect(r.status).toBe(201);
    }
    const dup = await handleRegisterAgent(agentStore, { agentId: "agent-0", capabilities: ["x"] });
    expect(dup.status).toBe(409);
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
    // TEST-NET-3 (RFC 5737) literal IP: isIP() short-circuits synchronously —
    // no real external DNS lookup, keeping the test hermetic.
    const evil = await handleRegisterAgent(store, { agentId: "evil-agent", capabilities: ["x"], endpointUrl: "http://203.0.113.1/api" });
    expect(evil.status).toBe(422);
    const good = await handleRegisterAgent(store, { agentId: "good-endpoint", capabilities: ["x"], endpointUrl: "http://localhost:3100/a2a" });
    expect(good.status).toBe(201);
  }, 15000);

  // H7: z.string().url() accepts any scheme, so the http(s) restriction is a
  // separate guard with its own message — checked before the loopback rule.
  test("SSRF: ftp:// endpointUrl → 422 with the http(s) scheme message", async () => {
    const store = new AgentStore();
    const resp = await handleRegisterAgent(store, {
      agentId: "ftp-agent",
      capabilities: ["x"],
      endpointUrl: "ftp://localhost/x",
    });
    expect(resp.status).toBe(422);
    const body = resp.body as { error: string };
    expect(body.error).toContain("endpointUrl must use http(s) scheme");
    // Redaction: the request-supplied endpointUrl must NOT be echoed back.
    expect(body.error).not.toContain("ftp://localhost/x");
  }, 15000);

  // SSRF: the DNS-resolution branch (hostname → multiple A/AAAA records) is
  // DNS-rebinding-relevant — a mixed loopback/non-loopback result set must be
  // rejected. The injectable lookup seam drives it without real DNS.
  describe("isLoopbackEndpoint DNS resolution (.every branch)", () => {
    test("all-loopback results → accept", async () => {
      const restore = setDnsLookup(async () => [{ address: "127.0.0.1" }, { address: "::1" }]);
      try {
        expect(await isLoopbackEndpoint("http://rebind.test/api")).toBe(true);
      } finally {
        restore();
      }
    });

    test("mixed loopback + non-loopback results → reject (DNS-rebinding guard)", async () => {
      const restore = setDnsLookup(async () => [{ address: "127.0.0.1" }, { address: "8.8.8.8" }]);
      try {
        expect(await isLoopbackEndpoint("http://rebind.test/api")).toBe(false);
      } finally {
        restore();
      }
    });

    test("all-non-loopback results → reject", async () => {
      const restore = setDnsLookup(async () => [{ address: "203.0.113.7" }]);
      try {
        expect(await isLoopbackEndpoint("http://rebind.test/api")).toBe(false);
      } finally {
        restore();
      }
    });

    test("empty result set → reject", async () => {
      const restore = setDnsLookup(async () => []);
      try {
        expect(await isLoopbackEndpoint("http://rebind.test/api")).toBe(false);
      } finally {
        restore();
      }
    });
  });

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
  test("invoke with tool absent from the STALE cache re-enumerates and succeeds", async () => {
    // True DoD scenario: registration caches [retain,recall] (read from a tools
    // file via the fixture's FAKE_MCP_TOOLS_FILE knob); the file then gains
    // `reflect`, so invoking reflect enters the stale-cache branch and must
    // re-enumerate (exactly one extra tools/list) before dispatching.
    const toolsFile = join(tmpdir(), `fake-mcp-tools-${crypto.randomUUID()}.txt`);
    writeFileSync(toolsFile, "retain,recall");
    const logs: LogEntry[] = [];
    const restoreSink = setLogSink((e) => logs.push(e));
    try {
      const mcpStore = newMcpStore();
      const reg = await handleRegisterMCPServer(
        mcpStore,
        { name: "cache-srv", transport: "stdio", command: "hindsight-local-mcp" },
        undefined,
        fakeFactory({ FAKE_MCP_TOOLS_FILE: toolsFile }),
      );
      expect(reg.status).toBe(201);
      const id = (reg.body as { id: string }).id;
      // Registration cached exactly [retain, recall].
      expect((reg.body as { tools: string[] }).tools).toEqual(["retain", "recall"]);

      // The server now advertises reflect too — the registration cache is stale.
      writeFileSync(toolsFile, "retain,recall,reflect");

      const resp = await handleInvokeMCPServer(mcpStore, id, { tool: "reflect", arguments: { bank_id: "b" } }, "req-cache-renum");
      expect(resp.status).toBe(200);
      // Proof the invoke really re-enumerated: exactly one tools/list carried
      // the invoke's requestId (the registration enumeration used another id).
      const reEnums = logs.filter((l) => l.operation === "mcp.list_tools" && l.requestId === "req-cache-renum");
      expect(reEnums).toHaveLength(1);
    } finally {
      restoreSink();
      rmSync(toolsFile, { force: true });
    }
  }, 15000);
});

// ---------------------------------------------------------------------------
// AC6 partial: /test returns ok:false after the transport is torn down
// ---------------------------------------------------------------------------
describe("AC6: /test reports ok:false for a dead transport", () => {
  // R6: unknown ids get the same { ok:false, error } contract as dead ones.
  test("/test on an unknown id → 404 ok:false with error string", async () => {
    const mcpStore = newMcpStore();
    const resp = await handleTestMCPServer(mcpStore, crypto.randomUUID());
    expect(resp.status).toBe(404);
    const body = resp.body as { ok: boolean; error?: unknown };
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
    expect((body.error as string).length).toBeGreaterThan(0);
  }, 15000);

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
    const body = testResp.body as { ok: boolean; error?: unknown };
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
    expect((body.error as string).length).toBeGreaterThan(0);
  }, 15000);

  test("after shutting down the subprocess, /invoke → 502 fast (no timeout wait)", async () => {
    const mcpStore = newMcpStore();
    const reg = await handleRegisterMCPServer(
      mcpStore,
      { name: "dead-invoke-srv", transport: "stdio", command: "hindsight-local-mcp" },
      undefined,
      fakeFactory(),
    );
    const id = (reg.body as { id: string }).id;
    const rec = mcpStore.get(id)!;
    await rec.stdio.shutdown(1000); // kill the subprocess out from under it
    const startedAt = Date.now();
    const resp = await handleInvokeMCPServer(mcpStore, id, {
      tool: "retain",
      arguments: { bank_id: "b", content: "c" },
    });
    // Must return promptly via the isRunning short-circuit, not wait out the
    // 60s+ invoke timeout on a request the dead transport can never answer.
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(resp.status).toBe(502);
    const body = resp.body as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32603);
    expect(body.error.message).toContain("transport is not running");
  }, 15000);
});

// ---------------------------------------------------------------------------
// Schema negative/boundary paths (agent + MCP registration + invoke)
// ---------------------------------------------------------------------------
describe("Schema boundaries", () => {
  // A factory that must never be invoked: all schema rejections return before
  // any transport construction.
  const noSpawn: TransportFactory = () => {
    throw new Error("transport factory must not be called for schema rejections");
  };

  test.each([
    ["capabilities: []", { agentId: "cap-empty", capabilities: [] }],
    ["metadata > 10KB", { agentId: "meta-big", capabilities: ["x"], metadata: { big: "x".repeat(10241) } }],
    ["agentId 129 chars", { agentId: `a${"b".repeat(127)}c`, capabilities: ["x"] }],
    // H11: count/length caps on the capabilities array.
    ["capabilities: 65 entries", { agentId: "cap-65", capabilities: Array.from({ length: 65 }, (_, i) => `cap-${i}`) }],
    ["capability entry 257 chars", { agentId: "cap-long-entry", capabilities: ["c".repeat(257)] }],
  ])("invalid agent payload (%s) → 400", async (_label, payload) => {
    const resp = await handleRegisterAgent(new AgentStore(), payload);
    expect(resp.status).toBe(400);
  }, 15000);

  // H11 boundary acceptance: the caps rejected above are upper bounds — exactly
  // 64 capabilities and a 256-char entry must still be ACCEPTED.
  test("agent boundary accepted: 64 capabilities + 256-char value → 201", async () => {
    const r1 = await handleRegisterAgent(new AgentStore(), {
      agentId: "cap-64-ok",
      capabilities: Array.from({ length: 64 }, (_, i) => `cap-${i}`),
    });
    expect(r1.status).toBe(201);
    const r2 = await handleRegisterAgent(new AgentStore(), {
      agentId: "cap-256val-ok",
      capabilities: ["c".repeat(256)],
    });
    expect(r2.status).toBe(201);
  }, 15000);

  test("circular metadata → 400 (refine catches the JSON.stringify throw)", async () => {
    const m: Record<string, unknown> = {};
    m.self = m;
    const resp = await handleRegisterAgent(new AgentStore(), { agentId: "meta-circular", capabilities: ["x"], metadata: m });
    expect(resp.status).toBe(400);
  }, 15000);

  test("agentId 128 chars (boundary) → 201", async () => {
    const resp = await handleRegisterAgent(new AgentStore(), { agentId: `a${"b".repeat(126)}c`, capabilities: ["x"] });
    expect(resp.status).toBe(201);
  }, 15000);

  test.each([
    ["name 129 chars", { name: "n".repeat(129), transport: "stdio", command: "hindsight-local-mcp" }],
    ["env empty key", { name: "env-empty-key", transport: "stdio", command: "hindsight-local-mcp", env: { "": "v" } }],
    ["transport sse", { name: "sse-srv", transport: "sse", url: "http://localhost:9999/mcp" }],
    // H11: count caps on args items and env keys.
    [
      "args 257 items",
      { name: "args-257", transport: "stdio", command: "hindsight-local-mcp", args: Array.from({ length: 257 }, (_, i) => `a${i}`) },
    ],
    [
      "env 65 keys",
      {
        name: "env-65",
        transport: "stdio",
        command: "hindsight-local-mcp",
        env: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`K${i}`, "v"])),
      },
    ],
  ])("invalid MCP payload (%s) → 400 pre-spawn", async (_label, payload) => {
    const resp = await handleRegisterMCPServer(newMcpStore(), payload, undefined, noSpawn);
    expect(resp.status).toBe(400);
  }, 15000);

  // H11 boundary acceptance: exactly 256 args items and 64 env keys must still
  // be ACCEPTED (the over-limit cases above are one past these caps). Arg
  // LENGTH 4096/4097 is covered by the dedicated args-length test.
  test("MCP boundary accepted: 256 args + 64 env keys → 201", async () => {
    const mcpStore = newMcpStore();
    const r1 = await handleRegisterMCPServer(
      mcpStore,
      { name: "args-256-ok", transport: "stdio", command: "hindsight-local-mcp", args: Array.from({ length: 256 }, (_, i) => `a${i}`) },
      undefined,
      fakeFactory(),
    );
    expect(r1.status).toBe(201);
    const r2 = await handleRegisterMCPServer(
      mcpStore,
      {
        name: "env-64-ok",
        transport: "stdio",
        command: "hindsight-local-mcp",
        env: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`K${i}`, "v"])),
      },
      undefined,
      fakeFactory(),
    );
    expect(r2.status).toBe(201);
  }, 15000);

  test("name 128 chars (boundary) → 201, and tool 257 chars → 400 -32602", async () => {
    const mcpStore = newMcpStore();
    const reg = await handleRegisterMCPServer(
      mcpStore,
      { name: "n".repeat(128), transport: "stdio", command: "hindsight-local-mcp" },
      undefined,
      fakeFactory(),
    );
    expect(reg.status).toBe(201);
    const id = (reg.body as { id: string }).id;
    // Reuse this one registration for the invoke-schema boundary (max 256).
    const resp = await handleInvokeMCPServer(mcpStore, id, {
      tool: "t".repeat(257),
      arguments: { bank_id: "b" },
    });
    expect(resp.status).toBe(400);
    const body = resp.body as { error: { code: number; data: { field: string } } };
    expect(body.error.code).toBe(-32602);
    expect(body.error.data.field).toBe("tool");
  }, 15000);
});

// ---------------------------------------------------------------------------
// Registration failure contracts (R3 invalid tool defs, R12 shutdown race,
// R15 zero tools) — all must fail closed with no record left behind.
// ---------------------------------------------------------------------------
describe("Registration failure contracts", () => {
  // R3: malformed advertised tool entries (no usable `name`) are filtered at
  // enumeration — a server advertising ONLY such entries registers zero tools.
  test("tool defs missing `name` → 502 (zero valid tools after filtering)", async () => {
    const defsFile = join(tmpdir(), `fake-mcp-tool-defs-${crypto.randomUUID()}.json`);
    writeFileSync(defsFile, JSON.stringify([{ description: "x" }]));
    try {
      const mcpStore = newMcpStore();
      const resp = await handleRegisterMCPServer(
        mcpStore,
        { name: "bad-defs", transport: "stdio", command: "hindsight-local-mcp" },
        undefined,
        fakeFactory({ FAKE_MCP_TOOL_DEFS_FILE: defsFile }),
      );
      expect(resp.status).toBe(502);
      const body = resp.body as { ok: boolean; error?: unknown };
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe("string");
      expect(body.error as string).toContain("zero tools");
      expect(mcpStore.size).toBe(0);
    } finally {
      rmSync(defsFile, { force: true });
    }
  }, 15000);

  // R15: a healthy handshake that advertises ZERO tools is still a failure.
  test("zero tools advertised → 502 and no record stored", async () => {
    const mcpStore = newMcpStore();
    const resp = await handleRegisterMCPServer(
      mcpStore,
      { name: "no-tools", transport: "stdio", command: "hindsight-local-mcp" },
      undefined,
      fakeFactory({ FAKE_MCP_NO_TOOLS: "1" }),
    );
    expect(resp.status).toBe(502);
    const body = resp.body as { ok: boolean; error?: unknown };
    expect(body.ok).toBe(false);
    expect(body.error as string).toContain("zero tools");
    expect(mcpStore.size).toBe(0);
  }, 15000);

  // R12: a store shutdown landing mid-registration (between reserve and
  // finalize) is a 503 with the store's own message — NOT a 502 handshake
  // failure. Deterministic: the closed flag flips exactly when finalize runs,
  // after a fully successful spawn + handshake.
  test("store shutdown during register → 503 'store is shutting down'", async () => {
    const mcpStore = newMcpStore();
    const origFinalize = mcpStore.finalize.bind(mcpStore);
    mcpStore.finalize = ((...a: Parameters<typeof origFinalize>) => {
      (mcpStore as unknown as { closed: boolean }).closed = true;
      return origFinalize(...a);
    }) as typeof mcpStore.finalize;

    const resp = await handleRegisterMCPServer(
      mcpStore,
      { name: "shutdown-race", transport: "stdio", command: "hindsight-local-mcp" },
      undefined,
      fakeFactory(),
    );
    expect(resp.status).toBe(503);
    const body = resp.body as { ok: boolean; error?: unknown };
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(body.error as string).toContain("shutting down");
    expect(body.error as string).not.toContain("handshake failed");
    expect(mcpStore.size).toBe(0);
  }, 15000);

  // Reservation-lifecycle terminality: shutdownAll() draining a registered-but-
  // unspawned transport must prevent any later spawn — no child may start after
  // a shutdown has begun. StdioTransport.shutdown() marks itself closed FIRST,
  // so a subsequent spawn() refuses.
  test("shutdownAll after attachTransport before spawn → spawn refuses, no child", async () => {
    const mcpStore = newMcpStore();
    const rid = mcpStore.reserve("race-spawn");
    const t = new StdioTransport({
      command: "bun",
      args: [FAKE],
      env: { PATH: process.env.PATH ?? "" },
      validationEnv: { ...process.env, SWARMCLAW_COMMAND_ALLOWLIST: "bun" },
    });
    mcpStore.attachTransport(rid, t);
    // Drain the pending transport BEFORE it ever spawns.
    await mcpStore.shutdownAll();
    // spawn() must refuse (closed) — and no subprocess may have started.
    await expect(t.spawn()).rejects.toThrow(/shutting down/);
    expect(t.pid).toBeUndefined();
    expect(mcpStore.size).toBe(0);
  }, 15000);
});

// ---------------------------------------------------------------------------
// R14/L3: route-level error mapping for upstream JSON-RPC failures.
// ---------------------------------------------------------------------------
describe("Invoke error mapping: upstream JSON-RPC codes surface at the route", () => {
  // (a) Client-caused unknown tool → HTTP 400 with -32601.
  test("unknown tool → 400 with -32601", async () => {
    const mcpStore = newMcpStore();
    const reg = await handleRegisterMCPServer(
      mcpStore,
      { name: "err-srv-unknown", transport: "stdio", command: "hindsight-local-mcp" },
      undefined,
      fakeFactory(),
    );
    const id = (reg.body as { id: string }).id;
    const resp = await handleInvokeMCPServer(mcpStore, id, { tool: "nonexistent", arguments: { bank_id: "b" } });
    expect(resp.status).toBe(400);
    const body = resp.body as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32601);
    expect(body.error.message).toContain("nonexistent");
  }, 15000);

  // (b) A server-side failure (-32603) is NOT client-caused → HTTP 502.
  test("upstream -32603 tool error → 502", async () => {
    const mcpStore = newMcpStore();
    const reg = await handleRegisterMCPServer(
      mcpStore,
      { name: "err-srv-32603", transport: "stdio", command: "hindsight-local-mcp" },
      undefined,
      fakeFactory({ FAKE_MCP_ERROR_TOOL: "retain", FAKE_MCP_ERROR_CODE: "-32603" }),
    );
    const id = (reg.body as { id: string }).id;
    const resp = await handleInvokeMCPServer(mcpStore, id, {
      tool: "retain",
      arguments: { bank_id: "b", content: "x" },
    });
    expect(resp.status).toBe(502);
    const body = resp.body as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32603);
    expect(body.error.message).toContain("Simulated error from tool: retain");
  }, 15000);

  // (c) Upstream error data {field, violation} strings carry through the 502.
  test("upstream error data {field, violation} carries through the 502 body", async () => {
    const mcpStore = newMcpStore();
    const reg = await handleRegisterMCPServer(
      mcpStore,
      { name: "err-srv-field", transport: "stdio", command: "hindsight-local-mcp" },
      undefined,
      fakeFactory({
        FAKE_MCP_ERROR_TOOL: "retain",
        FAKE_MCP_ERROR_CODE: "-32603",
        FAKE_MCP_ERROR_INCLUDE_FIELD: "1",
      }),
    );
    const id = (reg.body as { id: string }).id;
    const resp = await handleInvokeMCPServer(mcpStore, id, {
      tool: "retain",
      arguments: { bank_id: "b", content: "x" },
    });
    expect(resp.status).toBe(502);
    const body = resp.body as { error: { code: number; data: { field: string; violation: string } } };
    expect(body.error.code).toBe(-32603);
    expect(body.error.data.field).toBe("bank_id");
    expect(body.error.data.violation).toBe("simulated upstream violation");
  }, 15000);
});

// ---------------------------------------------------------------------------
// L4: inputSchema argument validation holds on BOTH sides of the tool-cache
// TTL — the route's cached-schema fast path (within TTL) and the bridge's
// post-re-enumeration check (after expiry) — and never dispatches a tools/call.
// ---------------------------------------------------------------------------
describe("Input-schema validation across the tool-cache TTL", () => {
  const TOOL_DEFS = [
    {
      name: "retain",
      description: "fake hindsight tool retain",
      inputSchema: {
        type: "object",
        required: ["bank_id"],
        properties: { bank_id: { type: "string" }, content: { type: "string" } },
      },
    },
  ];

  test("missing required bank_id → 400 -32602 within and after the TTL, zero tools/call dispatched", async () => {
    const savedTtl = process.env.SWARMCLAW_TOOL_CACHE_TTL_MS;
    process.env.SWARMCLAW_TOOL_CACHE_TTL_MS = "1000";
    const defsFile = join(tmpdir(), `fake-mcp-tool-defs-${crypto.randomUUID()}.json`);
    writeFileSync(defsFile, JSON.stringify(TOOL_DEFS));
    try {
      const mcpStore = newMcpStore();
      const reg = await handleRegisterMCPServer(
        mcpStore,
        { name: "schema-ttl", transport: "stdio", command: "hindsight-local-mcp" },
        undefined,
        fakeFactory({ FAKE_MCP_TOOL_DEFS_FILE: defsFile }),
      );
      expect(reg.status).toBe(201);
      const id = (reg.body as { id: string }).id;
      const rec = mcpStore.get(id)!;

      // Count wire-level dispatches: validation must reject before ANY
      // tools/call reaches the subprocess, in both cache windows. (The bridge
      // IS consulted post-expiry, so bridge-level spying cannot work there —
      // the subprocess boundary is the correct "did dispatch happen" probe.)
      const origRequest = rec.stdio.request.bind(rec.stdio);
      let toolCalls = 0;
      rec.stdio.request = ((
        method: string,
        params: unknown,
        timeoutMs: number,
        onFirstByte?: (latencyMs: number) => void,
      ) => {
        if (method === "tools/call") toolCalls++;
        return origRequest(method, params, timeoutMs, onFirstByte);
      }) as typeof rec.stdio.request;

      // Cached window (well within the 1s TTL): the route's cached-schema
      // fast path rejects.
      const within = await handleInvokeMCPServer(mcpStore, id, {
        tool: "retain",
        arguments: { content: "x" },
      });
      expect(within.status).toBe(400);
      expect((within.body as { error: { code: number } }).error.code).toBe(-32602);
      expect((within.body as { error: { data: { field: string } } }).error.data.field).toBe("bank_id");

      // Let the cache expire (TTL = 1000ms).
      await new Promise((r) => setTimeout(r, 1200));

      // Post-expiry: the route can no longer see the schema, so the bridge
      // re-enumerates and validates against the fresh schema — still before
      // any tools/call dispatch.
      const after = await handleInvokeMCPServer(mcpStore, id, {
        tool: "retain",
        arguments: { content: "x" },
      });
      expect(after.status).toBe(400);
      expect((after.body as { error: { code: number } }).error.code).toBe(-32602);
      expect((after.body as { error: { data: { field: string } } }).error.data.field).toBe("bank_id");
      expect(toolCalls).toBe(0);
    } finally {
      if (savedTtl === undefined) {
        // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
        delete process.env.SWARMCLAW_TOOL_CACHE_TTL_MS;
      } else {
        process.env.SWARMCLAW_TOOL_CACHE_TTL_MS = savedTtl;
      }
      rmSync(defsFile, { force: true });
    }
  }, 15000);
});
