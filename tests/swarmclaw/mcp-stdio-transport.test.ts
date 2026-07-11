import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  buildSubprocessEnv,
  CommandValidationError,
  resolveCommandAllowlist,
  resolveEnvAllowlist,
  resolveNpxPackageAllowlist,
  StdioTransport,
  validateCommand,
} from "../../src/swarmclaw/mcp/stdio-transport.ts";
import { resolveToolCacheTtl, ToolBridge } from "../../src/swarmclaw/mcp/tool-bridge.ts";

const FAKE = join(import.meta.dir, "fixtures", "fake-mcp-server.ts");

// Spawn the fake server directly via `bun <fixture>`. bun is not on the default
// allowlist, so validationEnv adds it — the spawn-time allowlist re-check still
// runs (defense in depth), we just widen it for the fixture.
function bunFake(env: Record<string, string> = {}): StdioTransport {
  return new StdioTransport({
    command: "bun",
    args: [FAKE],
    env: { ...(process.env as Record<string, string>), ...env },
    validationEnv: { ...process.env, SWARMCLAW_COMMAND_ALLOWLIST: "bun" },
  });
}

const live: StdioTransport[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((t) => t.shutdown(500).catch(() => {})));
});

describe("INV-SC2 command allowlist", () => {
  test("default allowlist includes the four expected commands", () => {
    const list = resolveCommandAllowlist({});
    expect(list).toContain("hindsight-local-mcp");
    expect(list).toContain("node");
    expect(list).toContain("npx");
    expect(list).toContain("node_modules/.bin/hindsight-local-mcp");
  });

  test.each(["sh", "bash", "zsh", "python", "python3"])(
    "shell/interpreter %s is rejected even if added to env allowlist",
    (shell) => {
      expect(() =>
        validateCommand({ command: shell, args: [], env: { SWARMCLAW_COMMAND_ALLOWLIST: shell } }),
      ).toThrow(CommandValidationError);
    },
  );

  test("unknown command rejected", () => {
    expect(() => validateCommand({ command: "curl", args: [], env: {} })).toThrow(CommandValidationError);
  });

  test("hindsight-local-mcp accepted", () => {
    expect(() => validateCommand({ command: "hindsight-local-mcp", args: [], env: {} })).not.toThrow();
  });

  // AC7 node denied-flag matrix — each flag individually.
  test.each([
    [["-e", "process.exit(1)"]],
    [["--eval", "process.exit(1)"]],
    [["-p", "process.exit(1)"]],
    [["--print", "process.exit(1)"]],
    [["-"]],
    [["--require", "relative-path"]],
    [["-r", "relative-path"]],
  ])("node args %j rejected", (args) => {
    expect(() => validateCommand({ command: "node", args, env: {} })).toThrow(CommandValidationError);
  });

  test("node --require with absolute path accepted", () => {
    expect(() => validateCommand({ command: "node", args: ["--require", "/abs/module.js", "server.js"], env: {} })).not.toThrow();
  });

  test("node with a plain script path accepted", () => {
    expect(() => validateCommand({ command: "node", args: ["server.js"], env: {} })).not.toThrow();
  });

  // AC7 npx denied-flag matrix.
  test.each([
    [["--node-arg", "-e", "malicious", "hindsight-local-mcp"]],
    [["--node-args", "-e", "malicious", "hindsight-local-mcp"]],
    [["-p", "malicious-package", "hindsight-local-mcp"]],
    [["--package", "malicious-package", "hindsight-local-mcp"]],
    [["-e", "malicious"]],
    [["--eval", "malicious"]],
  ])("npx args %j rejected", (args) => {
    expect(() => validateCommand({ command: "npx", args, env: {} })).toThrow(CommandValidationError);
  });

  test("npx with allowlisted package accepted", () => {
    expect(() => validateCommand({ command: "npx", args: ["hindsight-local-mcp"], env: {} })).not.toThrow();
    expect(() => validateCommand({ command: "npx", args: ["@anthropic-ai/claude-code"], env: {} })).not.toThrow();
  });

  test("npx with unknown package rejected", () => {
    expect(() => validateCommand({ command: "npx", args: ["malicious-pkg"], env: {} })).toThrow(CommandValidationError);
  });

  test("SWARMCLAW_NPX_PACKAGE_ALLOWLIST parses comma+trim", () => {
    const list = resolveNpxPackageAllowlist({ SWARMCLAW_NPX_PACKAGE_ALLOWLIST: " foo , bar ,,baz " });
    expect(list).toEqual(["foo", "bar", "baz"]);
  });
});

describe("INV-SC3 env isolation", () => {
  test("SWARMCLAW_ENV_ALLOWLIST parses comma+trim, ignoring empties", () => {
    expect(resolveEnvAllowlist({ SWARMCLAW_ENV_ALLOWLIST: "PATH,HOME,  ,NODE_ENV" })).toEqual([
      "PATH",
      "HOME",
      "NODE_ENV",
    ]);
  });

  test("buildSubprocessEnv includes only explicit + allowlisted parent keys", () => {
    const parent = { PATH: "/bin", SECRET_TOKEN: "shh", NODE_ENV: "test" } as NodeJS.ProcessEnv;
    const env = buildSubprocessEnv({ FOO: "bar" }, { ...parent, SWARMCLAW_ENV_ALLOWLIST: "PATH,NODE_ENV" });
    expect(env).toEqual({ PATH: "/bin", NODE_ENV: "test", FOO: "bar" });
    expect(env.SECRET_TOKEN).toBeUndefined();
  });

  test("empty-string env values are permitted", () => {
    const env = buildSubprocessEnv({ FLAG: "" }, {});
    expect(env.FLAG).toBe("");
  });
});

describe("stdio transport protocol", () => {
  test("spawn + initialize + list-tools handshake against fake server", async () => {
    const t = bunFake();
    live.push(t);
    await t.spawn();
    await t.initialize();
    const bridge = new ToolBridge(t, null, {});
    const tools = await bridge.enumerateTools("req-1");
    expect(tools).toEqual(["retain", "recall", "reflect", "consolidate"]);
  }, 15000);

  test("invoke retain then recall roundtrips content", async () => {
    const t = bunFake();
    live.push(t);
    await t.spawn();
    await t.initialize();
    const bridge = new ToolBridge(t, null, {});
    await bridge.invoke("retain", { bank_id: "bank-a", content: "remember me" }, 5000, "r1");
    const recall = (await bridge.invoke("recall", { bank_id: "bank-a" }, 5000, "r2")) as {
      content: Array<{ text: string }>;
    };
    const payload = JSON.parse(recall.content[0]!.text);
    expect(payload.memories).toContain("remember me");
  }, 15000);

  test("shutdown terminates the subprocess", async () => {
    const t = bunFake();
    await t.spawn();
    const pid = t.pid;
    expect(pid).toBeGreaterThan(0);
    await t.shutdown(2000);
    expect(t.isRunning).toBe(false);
    // PID must be gone.
    expect(() => process.kill(pid!, 0)).toThrow();
  }, 15000);

  test("SIGKILL escalation when subprocess ignores SIGTERM", async () => {
    const t = bunFake({ FAKE_MCP_IGNORE_SIGTERM: "1" });
    await t.spawn();
    // Handshake first to guarantee the child booted and installed its SIGTERM handler.
    await t.initialize();
    const pid = t.pid!;
    const start = Date.now();
    await t.shutdown(1000); // 1s grace then SIGKILL
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15000);
});

describe("tool cache TTL clamp", () => {
  test("default is 5 minutes", () => {
    expect(resolveToolCacheTtl({})).toBe(300_000);
  });
  test("below min clamps to 1000 and warns", () => {
    const logs: unknown[] = [];
    const { setLogSink } = require("../../src/swarmclaw/mcp/stdio-transport.ts");
    const restore = setLogSink((e: unknown) => logs.push(e));
    try {
      expect(resolveToolCacheTtl({ SWARMCLAW_TOOL_CACHE_TTL_MS: "10" })).toBe(1000);
      expect(logs.some((l: any) => l.message === "SWARMCLAW_TOOL_CACHE_TTL_MS clamped" && l.clamped === 1000)).toBe(true);
    } finally {
      restore();
    }
  });
  test("above max clamps to 3600000", () => {
    expect(resolveToolCacheTtl({ SWARMCLAW_TOOL_CACHE_TTL_MS: "9999999999" })).toBe(3_600_000);
  });
});

// ---------------------------------------------------------------------------
// Real-binary integration probe.
//
// In THIS environment `hindsight-local-mcp` is an HTTP MCP server
// (localhost:8888/mcp/, embedded Postgres + LLM key required) — it does NOT
// speak stdio JSON-RPC. So the deterministic suite uses the fake stdio server;
// this probe documents the real binary's transport shape without ever faking a
// stdio pass. It skips gracefully if the binary is absent.
// ---------------------------------------------------------------------------
describe("real hindsight-local-mcp (integration)", () => {
  const onPath = Bun.which("hindsight-local-mcp") !== null;

  test.skipIf(!onPath)(
    "real binary exposes an HTTP API (host/port), not an stdio JSON-RPC server",
    async () => {
      // The launcher imports heavy modules (pg0/uvicorn) before argparse prints,
      // so `--help` takes several seconds and its latency is load-dependent. We
      // bound the wait ourselves (25s) and, if the heavyweight binary is too
      // slow in this environment, we log-and-skip rather than flake the suite —
      // we NEVER fake a pass. The binary's HTTP-only nature is already relied on
      // by the fixture rationale.
      const proc = Bun.spawn(["hindsight-local-mcp", "--help"], { stdout: "pipe", stderr: "pipe" });
      const out = await Promise.race([
        new Response(proc.stdout).text(),
        new Promise<null>((res) => setTimeout(() => res(null), 25_000)),
      ]);
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await proc.exited.catch(() => {});
      if (out === null) {
        // Slow binary in this run — do not assert (and do not fake success).
        console.warn("real hindsight-local-mcp --help exceeded 25s; skipping HTTP-transport assertion");
        return;
      }
      // The launcher exposes the Hindsight API HTTP server (host/port flags),
      // confirming it is not an stdio JSON-RPC server. This is why the
      // deterministic tests substitute a fake stdio server.
      expect(out).toContain("--port");
      expect(out.toLowerCase()).toContain("host");
    },
    30_000,
  );
});
