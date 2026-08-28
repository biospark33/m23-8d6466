import { afterEach, describe, expect, mock, test } from "bun:test";
import { parseArgs, realBridgeProbe } from "../scripts/provision-hindsight-banks.ts";

// realBridgeProbe is a CLI-only network helper. Review R2 hardened two
// fails-open / misdiagnosis paths (M4 missing-id, M5 401/403); F008 then fixed
// the port, method and auth header so the probe reaches SwarmClaw at all.
// These tests stub globalThis.fetch to exercise each branch without a live
// SwarmClaw. The provision script guards setLogSink + main behind
// import.meta.main, so importing the module here has no side effects.

const origFetch = globalThis.fetch;

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  globalThis.fetch = origFetch;
  // delete (not = undefined): Node stringifies `process.env.X = undefined` to
  // the literal "undefined", which (truthy string) defeats the
  // `?? "http://127.0.0.1:3100"` fallback in realBridgeProbe. delete truly
  // unsets the key so the default-URL path is reachable.
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  delete process.env.SWARMCLAW_BASE_URL;
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  delete process.env.SWARMCLAW_MCP_SERVER_ID;
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  delete process.env.SWARMCLAW_AUTH_TOKEN;
});

describe("realBridgeProbe — F008 port/method/auth", () => {
  // F008: the probe used to GET a non-existent `/api/mcp-servers` listing on
  // port 3000. SwarmClaw binds 3100 and exposes only POST routes, so the probe
  // returned {registered:false} unconditionally and every real provision
  // short-circuited to -32001. There is no listing route and ids are random
  // UUIDs minted at registration (mcp-store.ts:75), so the id must be supplied
  // by the operator via --mcp-server-id / SWARMCLAW_MCP_SERVER_ID.

  interface Recorded {
    url: string;
    method: string;
    headers: Headers;
  }

  function recordingFetch(
    recorded: Recorded[],
    respond: (url: string) => Response,
  ): typeof fetch {
    return mock(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      recorded.push({
        url: u,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
      });
      return respond(u);
    }) as unknown as typeof fetch;
  }

  test("probes SwarmClaw's real port (3100), method (POST) and /test path", async () => {
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.SWARMCLAW_BASE_URL;
    process.env.SWARMCLAW_MCP_SERVER_ID = "hs-1";
    const calls: Recorded[] = [];
    globalThis.fetch = recordingFetch(calls, () => jsonRes({ ok: true }));
    const p = await realBridgeProbe();
    expect(p).toEqual({ registered: true, healthy: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:3100/api/mcp-servers/hs-1/test");
    expect(calls[0]!.method).toBe("POST");
  });

  test("sends the SwarmClaw bearer token and never an Origin header", async () => {
    process.env.SWARMCLAW_BASE_URL = "http://sw";
    process.env.SWARMCLAW_MCP_SERVER_ID = "hs-1";
    process.env.SWARMCLAW_AUTH_TOKEN = "s3cret";
    const calls: Recorded[] = [];
    globalThis.fetch = recordingFetch(calls, () => jsonRes({ ok: true }));
    await realBridgeProbe();
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer s3cret");
    // SwarmClaw refuses any request carrying Origin (browser-only header).
    expect(calls[0]!.headers.get("origin")).toBeNull();
  });

  test("no bearer header when SWARMCLAW_AUTH_TOKEN is unset", async () => {
    process.env.SWARMCLAW_BASE_URL = "http://sw";
    process.env.SWARMCLAW_MCP_SERVER_ID = "hs-1";
    const calls: Recorded[] = [];
    globalThis.fetch = recordingFetch(calls, () => jsonRes({ ok: true }));
    await realBridgeProbe();
    expect(calls[0]!.headers.get("authorization")).toBeNull();
  });

  test("the id percent-encodes into the path", async () => {
    process.env.SWARMCLAW_BASE_URL = "http://sw";
    process.env.SWARMCLAW_MCP_SERVER_ID = "a/b c";
    const calls: Recorded[] = [];
    globalThis.fetch = recordingFetch(calls, () => jsonRes({ ok: true }));
    await realBridgeProbe();
    expect(calls[0]!.url).toBe("http://sw/api/mcp-servers/a%2Fb%20c/test");
  });

  test("no id configured → not registered, and no request is made", async () => {
    process.env.SWARMCLAW_BASE_URL = "http://sw";
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.SWARMCLAW_MCP_SERVER_ID;
    const calls: Recorded[] = [];
    globalThis.fetch = recordingFetch(calls, () => jsonRes({ ok: true }));
    const p = await realBridgeProbe();
    // Registration cannot be CONFIRMED without an id, and there is no listing
    // route to discover one — fail closed (AC-4 -32001) rather than assume.
    expect(p).toEqual({ registered: false, healthy: false });
    expect(calls).toHaveLength(0);
  });

  test("explicit id argument wins over the env var", async () => {
    process.env.SWARMCLAW_BASE_URL = "http://sw";
    process.env.SWARMCLAW_MCP_SERVER_ID = "from-env";
    const calls: Recorded[] = [];
    globalThis.fetch = recordingFetch(calls, () => jsonRes({ ok: true }));
    await realBridgeProbe("from-flag");
    expect(calls[0]!.url).toBe("http://sw/api/mcp-servers/from-flag/test");
  });

  test("401 auth-required → bridge registered, health unconfirmed (not -32001) [M5]", async () => {
    process.env.SWARMCLAW_BASE_URL = "http://sw";
    process.env.SWARMCLAW_MCP_SERVER_ID = "hs-1";
    globalThis.fetch = mock(async () => jsonRes({}, 401)) as unknown as typeof fetch;
    const p = await realBridgeProbe();
    // The bridge endpoint responded, so the HTTP server IS up; mapping an auth
    // gap to "not registered" would misdiagnose it.
    expect(p).toEqual({ registered: true, healthy: false });
  });

  test("404 (unknown server id) → not registered [M5]", async () => {
    process.env.SWARMCLAW_BASE_URL = "http://sw";
    process.env.SWARMCLAW_MCP_SERVER_ID = "hs-1";
    globalThis.fetch = mock(async () => jsonRes({}, 404)) as unknown as typeof fetch;
    const p = await realBridgeProbe();
    expect(p).toEqual({ registered: false, healthy: false });
  });

  test("502 (registered but transport dead) → registered, unhealthy not -32001", async () => {
    // handleTestMCPServer returns 502 {ok:false} when the server IS in the
    // store but its transport is down or enumerates zero tools. Reporting that
    // as "not registered" would send an operator hunting a registration bug.
    process.env.SWARMCLAW_BASE_URL = "http://sw";
    process.env.SWARMCLAW_MCP_SERVER_ID = "hs-1";
    globalThis.fetch = mock(async () =>
      jsonRes({ ok: false, error: "transport is not running" }, 502),
    ) as unknown as typeof fetch;
    const p = await realBridgeProbe();
    expect(p).toEqual({ registered: true, healthy: false });
  });

  test("/test 200 with ok:false → registered, unhealthy (AC-5 fail closed)", async () => {
    process.env.SWARMCLAW_BASE_URL = "http://sw";
    process.env.SWARMCLAW_MCP_SERVER_ID = "hs-1";
    globalThis.fetch = mock(async () => jsonRes({ ok: false })) as unknown as typeof fetch;
    const p = await realBridgeProbe();
    expect(p).toEqual({ registered: true, healthy: false });
  });

  test("/test 200 with an array body → registered, unhealthy (no truthy narrowing)", async () => {
    process.env.SWARMCLAW_BASE_URL = "http://sw";
    process.env.SWARMCLAW_MCP_SERVER_ID = "hs-1";
    globalThis.fetch = mock(async () => jsonRes([{ ok: true }])) as unknown as typeof fetch;
    const p = await realBridgeProbe();
    expect(p).toEqual({ registered: true, healthy: false });
  });

  test("fetch throws → not registered (network unreachable)", async () => {
    process.env.SWARMCLAW_BASE_URL = "http://sw";
    process.env.SWARMCLAW_MCP_SERVER_ID = "hs-1";
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const p = await realBridgeProbe();
    expect(p).toEqual({ registered: false, healthy: false });
  });
});

describe("provision-hindsight-banks CLI — parseArgs", () => {
  test("--repo-slug <slug> sets repoSlug", () => {
    expect(parseArgs(["--repo-slug", "foo"])).toEqual({ repoSlug: "foo" });
  });

  test("--repo <slug> alias sets repoSlug", () => {
    expect(parseArgs(["--repo", "foo"])).toEqual({ repoSlug: "foo" });
  });

  test("--repo-slug=<slug> eq form sets repoSlug", () => {
    expect(parseArgs(["--repo-slug=foo"])).toEqual({ repoSlug: "foo" });
  });

  test("no args → repoSlug unset (default applied in main)", () => {
    expect(parseArgs([])).toEqual({});
  });

  test("bare --repo-slug (missing value) throws", () => {
    // Previously silently fell back to the cwd-basename default, masking the
    // typo. Now errors loudly (parity with import-mulch-expertise.ts).
    expect(() => parseArgs(["--repo-slug"])).toThrow(/requires a non-empty value/);
  });

  test('--repo-slug "" (empty value) throws', () => {
    expect(() => parseArgs(["--repo-slug", ""])).toThrow(/requires a non-empty value/);
  });

  test("--repo-slug --foo (value looks like a flag) throws", () => {
    expect(() => parseArgs(["--repo-slug", "--foo"])).toThrow(/requires a non-empty value/);
  });

  test("--mcp-server-id <id> sets mcpServerId (F008)", () => {
    expect(parseArgs(["--mcp-server-id", "hs-1"])).toEqual({ mcpServerId: "hs-1" });
  });

  test("--mcp-server-id=<id> eq form sets mcpServerId", () => {
    expect(parseArgs(["--mcp-server-id=hs-1"])).toEqual({ mcpServerId: "hs-1" });
  });

  test("bare --mcp-server-id (missing value) throws", () => {
    expect(() => parseArgs(["--mcp-server-id"])).toThrow(/requires a non-empty value/);
  });

  test("unknown flag throws", () => {
    // Previously silently ignored — a typo like `--reposlug` would proceed
    // with defaults. Now surfaces loudly.
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown flag/);
  });
});
