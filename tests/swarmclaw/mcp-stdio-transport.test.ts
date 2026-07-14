import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  buildSubprocessEnv,
  CommandValidationError,
  JsonRpcError,
  resolveCommandAllowlist,
  resolveEnvAllowlist,
  resolveNpxPackageAllowlist,
  setLogSink,
  StdioTransport,
  validateCommand,
} from "../../src/swarmclaw/mcp/stdio-transport.ts";
import { resolveInvokeTimeout, resolveToolCacheTtl, ToolBridge } from "../../src/swarmclaw/mcp/tool-bridge.ts";

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
    // Bundled single-dash short-flag clusters — Node expands `-pe` to `-p -e`,
    // so exact-token matching would let these through (INV-SC2 RCE bypass).
    [["-pe", "process.exit(1)"]],
    [["-ep", "process.exit(1)"]],
    [["-rp", "process.exit(1)"]],
    [["-er", "process.exit(1)"]],
    [["-re", "process.exit(1)"]],
    // `--flag=value` form of the module-load rule (non-absolute path rejected).
    [["--require=relative-path"]],
  ])("node args %j rejected", (args) => {
    expect(() => validateCommand({ command: "node", args, env: {} })).toThrow(CommandValidationError);
  });

  test("node bundled short-flag cluster with require + absolute path still enforced", () => {
    // `-r` bundled cluster must still require an absolute module path.
    expect(() => validateCommand({ command: "node", args: ["-r", "relative"], env: {} })).toThrow(CommandValidationError);
    expect(() => validateCommand({ command: "node", args: ["-r", "/abs/mod.js", "server.js"], env: {} })).not.toThrow();
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
  test("below min clamps to 1000 and warns with the full structured shape", () => {
    const logs: unknown[] = [];
    const restore = setLogSink((e: unknown) => logs.push(e));
    try {
      expect(resolveToolCacheTtl({ SWARMCLAW_TOOL_CACHE_TTL_MS: "10" })).toBe(1000);
      const entry = logs.find((l: any) => l.message === "SWARMCLAW_TOOL_CACHE_TTL_MS clamped");
      expect(entry).toMatchObject({
        level: "warn",
        message: "SWARMCLAW_TOOL_CACHE_TTL_MS clamped",
        raw: "10", // the raw env STRING per the story contract, not the parsed number
        clamped: 1000,
        min: 1000,
        max: 3600000,
      });
    } finally {
      restore();
    }
  });
  test("above max clamps to 3600000", () => {
    expect(resolveToolCacheTtl({ SWARMCLAW_TOOL_CACHE_TTL_MS: "9999999999" })).toBe(3_600_000);
  });
  test("exact boundaries 1000/3600000 are in-range — accepted without a clamp warning", () => {
    const logs: unknown[] = [];
    const restore = setLogSink((e: unknown) => logs.push(e));
    try {
      expect(resolveToolCacheTtl({ SWARMCLAW_TOOL_CACHE_TTL_MS: "1000" })).toBe(1000);
      expect(resolveToolCacheTtl({ SWARMCLAW_TOOL_CACHE_TTL_MS: "3600000" })).toBe(3600000);
      expect(logs.some((l: any) => l.message === "SWARMCLAW_TOOL_CACHE_TTL_MS clamped")).toBe(false);
    } finally {
      restore();
    }
  });
});

describe("invoke timeout resolution (SWARMCLAW_INVOKE_TIMEOUT_MS)", () => {
  test("unset → default 120000", () => {
    expect(resolveInvokeTimeout({})).toBe(120_000);
  });
  test("non-numeric → default 120000", () => {
    expect(resolveInvokeTimeout({ SWARMCLAW_INVOKE_TIMEOUT_MS: "abc" })).toBe(120_000);
  });
  test("zero → default 120000", () => {
    expect(resolveInvokeTimeout({ SWARMCLAW_INVOKE_TIMEOUT_MS: "0" })).toBe(120_000);
  });
  test("above the 60s floor is used as-is", () => {
    expect(resolveInvokeTimeout({ SWARMCLAW_INVOKE_TIMEOUT_MS: "90000" })).toBe(90_000);
  });
  test("below the 60s floor clamps to 60000 and warns", () => {
    const logs: unknown[] = [];
    const restore = setLogSink((e: unknown) => logs.push(e));
    try {
      expect(resolveInvokeTimeout({ SWARMCLAW_INVOKE_TIMEOUT_MS: "5000" })).toBe(60_000);
      expect(
        logs.some((l: any) => l.message === "SWARMCLAW_INVOKE_TIMEOUT_MS clamped" && l.clamped === 60000),
      ).toBe(true);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Duck-typed ToolBridge retry path (no subprocess): a server-reported
// unknown tool (-32601) must invalidate the cache, re-enumerate, and retry once.
// ---------------------------------------------------------------------------
describe("tool bridge -32601 retry path", () => {
  test("server-reported unknown tool → invalidate, re-enumerate, retry once (exactly two tools/list)", async () => {
    // The cached list still contains `reflect`, but the "server" has dropped
    // it: the first tools/call fails -32601, so the bridge must re-enumerate
    // (a second tools/list) and retry the call exactly once.
    const requests: Array<{ method: string; params?: unknown }> = [];
    let callAttempts = 0;
    const stub = {
      request: (method: string, _params: unknown) => {
        requests.push({ method, params: _params });
        if (method === "tools/list") {
          return Promise.resolve({
            tools: [
              { name: "retain", inputSchema: { type: "object" } },
              { name: "recall", inputSchema: { type: "object" } },
              { name: "reflect", inputSchema: { type: "object" } },
            ],
          });
        }
        if (method === "tools/call") {
          callAttempts++;
          if (callAttempts === 1) {
            return Promise.reject(new JsonRpcError(-32601, "Unknown tool: reflect"));
          }
          return Promise.resolve({ content: [{ type: "text", text: JSON.stringify({ reflected: true }) }] });
        }
        return Promise.reject(new Error(`unexpected method ${method}`));
      },
    } as unknown as StdioTransport;
    const bridge = new ToolBridge(stub, null, {});
    await bridge.enumerateTools("req-seed"); // first tools/list — seeds the cache
    const result = (await bridge.invoke("reflect", { bank_id: "b" }, 5000, "req-retry")) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(result.content[0]!.text).reflected).toBe(true);
    expect(callAttempts).toBe(2); // one rejected attempt + one retry
    expect(requests.filter((r) => r.method === "tools/list")).toHaveLength(2); // seed + post-failure re-enumeration
    // CC-9 wire leg: _meta.requestId rides the tools/call params on BOTH the
    // first attempt and the -32601 retry (tool-bridge.ts:268,295).
    const callMetas = requests
      .filter((r) => r.method === "tools/call")
      .map((r) => (r.params as { _meta?: { requestId?: string } })?._meta?.requestId);
    expect(callMetas).toEqual(["req-retry", "req-retry"]);
  });
});

// ---------------------------------------------------------------------------
// Transport concurrency + malformed-wire robustness.
// ---------------------------------------------------------------------------
describe("stdio transport robustness", () => {
  test("10 parallel invokes each resolve with their own id-matched result", async () => {
    const t = bunFake();
    live.push(t);
    await t.spawn();
    await t.initialize();
    const bridge = new ToolBridge(t, null, {});
    await bridge.enumerateTools("req-par-seed"); // warm the cache so all 10 are tools/call
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        bridge.invoke("retain", { bank_id: `bank-${i}`, content: `content-${i}` }, 10000, `req-par-${i}`),
      ),
    );
    for (let i = 0; i < 10; i++) {
      const payload = JSON.parse((results[i] as { content: Array<{ text: string }> }).content[0]!.text);
      // A mismatched pending-entry pairing would cross the bank_ids.
      expect(payload.bank_id).toBe(`bank-${i}`);
      expect(payload.retained).toBe(true);
    }
  }, 20000);

  test("malformed non-JSON lines on the wire are skipped, replies still resolve", async () => {
    const t = bunFake({ FAKE_MCP_GARBAGE_LINE: "1" });
    live.push(t);
    await t.spawn();
    await t.initialize(); // the initialize reply itself is preceded by a garbage line
    const bridge = new ToolBridge(t, null, {});
    const tools = await bridge.enumerateTools("req-garbage-1");
    expect(tools).toEqual(["retain", "recall", "reflect", "consolidate"]);
    const res = (await bridge.invoke("reflect", { bank_id: "b" }, 5000, "req-garbage-2")) as {
      content: Array<{ text: string }>;
    };
    expect(res.content[0]!.text).toContain("reflected");
  }, 15000);

  // INV-SC4 DoD: the subprocess communicates only via stdio. The protocol
  // flowing over the pipes + stdin-EOF termination together prove no other
  // channel keeps the server alive.
  test("INV-SC4: fake server speaks JSON-RPC over stdio only — stdin EOF alone terminates it", async () => {
    const proc = Bun.spawn(["bun", FAKE], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      proc.stdin.write(
        new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`),
      );
      proc.stdin.flush();
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const deadline = Date.now() + 5000;
      while (!buf.includes("\n")) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("fake server produced no stdout reply within 5s");
        // Race the read against the remaining deadline so a live-but-silent
        // child cannot pend reader.read() forever; clear the timer once the
        // race settles (mirrors withSpawnTimeout, mcp-servers.ts:283-297).
        let readTimer: ReturnType<typeof setTimeout> | undefined;
        const readTimeout = new Promise<never>((_, reject) => {
          readTimer = setTimeout(() => reject(new Error("fake server produced no stdout reply within 5s")), remaining);
        });
        try {
          const { done, value } = await Promise.race([reader.read(), readTimeout]);
          if (done) break;
          buf += decoder.decode(value, { stream: true });
        } finally {
          if (readTimer !== undefined) clearTimeout(readTimer);
        }
      }
      const reply = JSON.parse(buf.slice(0, buf.indexOf("\n"))) as {
        id: number;
        result: { serverInfo: { name: string } };
      };
      expect(reply.id).toBe(1);
      expect(reply.result.serverInfo.name).toBe("fake-hindsight-mcp");
      // stdin EOF must end the server within ~2s.
      await proc.stdin.end();
      let eofTimer: ReturnType<typeof setTimeout> | undefined;
      const eofTimeout = new Promise<never>((_, reject) => {
        eofTimer = setTimeout(() => reject(new Error("fake server did not exit within 2s of stdin EOF")), 2000);
      });
      let code: number;
      try {
        code = await Promise.race([proc.exited, eofTimeout]);
      } finally {
        // Clear the handle so a settled race never leaves a dangling live timer.
        if (eofTimer !== undefined) clearTimeout(eofTimer);
      }
      expect(code).toBe(0);
    } finally {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already exited */
      }
      await proc.exited.catch(() => {});
    }
  }, 15000);
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
      // bound the wait ourselves (25s) and FAIL EXPLICITLY on a timeout — a
      // green run with zero assertions would be a faked pass.
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
        throw new Error(
          "hindsight-local-mcp --help exceeded 25s in an environment where the binary is present",
        );
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
