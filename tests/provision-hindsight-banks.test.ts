import { afterEach, describe, expect, mock, test } from "bun:test";
import { parseArgs, realBridgeProbe } from "../scripts/provision-hindsight-banks.ts";

// realBridgeProbe is a CLI-only network helper that was previously uncovered.
// Review R2 hardened two fails-open / misdiagnosis paths (M4 missing-id, M5
// 401/403). These tests stub globalThis.fetch to exercise each branch without a
// live SwarmClaw. The provision script guards setLogSink + main behind
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
  // `?? "http://127.0.0.1:3000"` fallback in realBridgeProbe. delete truly
  // unsets the key so the default-URL path is reachable.
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  delete process.env.SWARMCLAW_BASE_URL;
});

describe("realBridgeProbe — review R2 M4/M5", () => {
  test("unset SWARMCLAW_BASE_URL → probes default 127.0.0.1:3000 [R3]", async () => {
    // R3: env-unset no longer short-circuits healthy (that masked AC-4/AC-5
    // from the real CLI). It now falls back to the SwarmClaw default URL so
    // the probe is real — AC-4 (-32001) is reachable when SwarmClaw is down.
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.SWARMCLAW_BASE_URL;
    const requested: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const u = String(url);
      requested.push(u);
      if (u.endsWith("/api/mcp-servers")) {
        return jsonRes({ servers: [{ id: "hs-1", name: "hindsight" }] });
      }
      if (u.includes("/test")) return jsonRes({ ok: true });
      return jsonRes({}, 404);
    }) as unknown as typeof fetch;
    const p = await realBridgeProbe();
    expect(p).toEqual({ registered: true, healthy: true });
    // Prove the `??` fallback fired and the default URL was actually requested
    // (guards against a stale env value sneaking through the probe).
    expect(requested.some((u) => u.startsWith("http://127.0.0.1:3000/"))).toBe(
      true,
    );
  });

  test("unset SWARMCLAW_BASE_URL + SwarmClaw unreachable → not registered [R3]", async () => {
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.SWARMCLAW_BASE_URL;
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const p = await realBridgeProbe();
    expect(p).toEqual({ registered: false, healthy: false });
  });

  test("401 auth-required → bridge registered, health unconfirmed (not -32001) [M5]", async () => {
    process.env.SWARMCLAW_BASE_URL = "http://sw";
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/api/mcp-servers")) return jsonRes({}, 401);
      return jsonRes({}, 404);
    }) as unknown as typeof fetch;
    const p = await realBridgeProbe();
    // Pre-fix: {registered:false, healthy:false} → CLI would emit -32001
    // (bridge not registered), misdiagnosing an auth gap. Post-fix: the bridge
    // endpoint responded, so it IS registered; health can't be verified.
    expect(p).toEqual({ registered: true, healthy: false });
  });

  test("404 → not registered [M5]", async () => {
    process.env.SWARMCLAW_BASE_URL = "http://sw";
    globalThis.fetch = mock(async () => jsonRes({}, 404)) as unknown as typeof fetch;
    const p = await realBridgeProbe();
    expect(p).toEqual({ registered: false, healthy: false });
  });

  test("hindsight server with no usable id → registered, health unconfirmed (fail closed) [M4]", async () => {
    process.env.SWARMCLAW_BASE_URL = "http://sw";
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/api/mcp-servers")) {
        return jsonRes({ servers: [{ name: "hindsight-mcp" /* no id field */ }] });
      }
      return jsonRes({}, 404);
    }) as unknown as typeof fetch;
    const p = await realBridgeProbe();
    // Pre-fix: {registered:true, healthy:true} (fail open — assumes healthy
    // without calling /test). Post-fix: can't probe /test without an id, so
    // health is unconfirmed (AC-5 fail-closed).
    expect(p).toEqual({ registered: true, healthy: false });
  });

  test("hindsight server with id + /test ok:true → fully healthy (unchanged path)", async () => {
    process.env.SWARMCLAW_BASE_URL = "http://sw";
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/api/mcp-servers")) {
        return jsonRes({ servers: [{ id: "hs-1", name: "hindsight" }] });
      }
      if (u.includes("/test")) return jsonRes({ ok: true });
      return jsonRes({}, 404);
    }) as unknown as typeof fetch;
    const p = await realBridgeProbe();
    expect(p).toEqual({ registered: true, healthy: true });
  });

  test("fetch throws → not registered (network unreachable)", async () => {
    process.env.SWARMCLAW_BASE_URL = "http://sw";
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

  test("unknown flag throws", () => {
    // Previously silently ignored — a typo like `--reposlug` would proceed
    // with defaults. Now surfaces loudly.
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown flag/);
  });
});
