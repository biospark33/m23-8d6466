import { afterEach, describe, expect, mock, test } from "bun:test";
import { realBridgeProbe } from "../scripts/provision-hindsight-banks.ts";

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
  process.env.SWARMCLAW_BASE_URL = undefined;
});

describe("realBridgeProbe — review R2 M4/M5", () => {
  test("unset SWARMCLAW_BASE_URL → probes default 127.0.0.1:3000 [R3]", async () => {
    // R3: env-unset no longer short-circuits healthy (that masked AC-4/AC-5
    // from the real CLI). It now falls back to the SwarmClaw default URL so
    // the probe is real — AC-4 (-32001) is reachable when SwarmClaw is down.
    process.env.SWARMCLAW_BASE_URL = undefined;
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

  test("unset SWARMCLAW_BASE_URL + SwarmClaw unreachable → not registered [R3]", async () => {
    process.env.SWARMCLAW_BASE_URL = undefined;
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
