import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveBankId } from "../src/hindsight/schemas.ts";
import type { ProvisionOptions } from "../src/hindsight/bank-provisioner.ts";
import {
  buildProvisionEnvelope,
  checkBankPrefix,
  checkHindsightBaseUrl,
  compensateRerunFailure,
  isRerunProvision,
  openProvisionWindow,
  parseArgs,
  realBridgeProbe,
  resolveProbe,
  takeRerunSnapshot,
} from "../scripts/provision-hindsight-banks.ts";

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
    globalThis.fetch = mock(async () => jsonRes({}, 401)) as unknown as typeof fetch; // dp:ok assigns a bun mock() to globalThis.fetch; no narrowing expresses a mock as the whole fetch type
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
    ) as unknown as typeof fetch; // dp:ok assigns a bun mock() to globalThis.fetch; no narrowing expresses a mock as the whole fetch type
    const p = await realBridgeProbe();
    expect(p).toEqual({ registered: true, healthy: false });
  });

  test("/test 200 with ok:false → registered, unhealthy (AC-5 fail closed)", async () => {
    process.env.SWARMCLAW_BASE_URL = "http://sw";
    process.env.SWARMCLAW_MCP_SERVER_ID = "hs-1";
    globalThis.fetch = mock(async () => jsonRes({ ok: false })) as unknown as typeof fetch; // dp:ok assigns a bun mock() to globalThis.fetch; no narrowing expresses a mock as the whole fetch type
    const p = await realBridgeProbe();
    expect(p).toEqual({ registered: true, healthy: false });
  });

  test("/test 200 with an array body → registered, unhealthy (no truthy narrowing)", async () => {
    process.env.SWARMCLAW_BASE_URL = "http://sw";
    process.env.SWARMCLAW_MCP_SERVER_ID = "hs-1";
    globalThis.fetch = mock(async () => jsonRes([{ ok: true }])) as unknown as typeof fetch; // dp:ok assigns a bun mock() to globalThis.fetch; no narrowing expresses a mock as the whole fetch type
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

describe("provision-hindsight-banks CLI — --no-bridge-probe (DD-17 dedicated topology)", () => {
  // R3-016: this describe's resolveProbe(false) delegation test sets
  // SWARMCLAW_* env; without a describe-scoped cleanup both stay set for
  // every later test in the process (the neighboring HINDSIGHT_BASE_URL
  // describes each install their own afterEach delete — house style).
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.SWARMCLAW_BASE_URL;
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.SWARMCLAW_MCP_SERVER_ID;
  });

  // main() is not directly injectable (it reads process.argv and constructs a
  // real HindsightClient), so the flag's behaviors are covered at the
  // exported seams, the same level the rest of this file tests parseArgs and
  // realBridgeProbe: parseArgs owns the flag grammar, resolveProbe owns the
  // probe-bypass decision main() executes, checkBankPrefix owns the guard.

  function recordingUrls(urls: string[]): typeof fetch {
    return mock(async (url: string | URL | Request) => {
      urls.push(String(url));
      return jsonRes({ ok: true });
    }) as unknown as typeof fetch; // dp:ok assigns a bun mock() to globalThis.fetch; no narrowing expresses a mock as the whole fetch type
  }

  test("--no-bridge-probe parses true", () => {
    expect(parseArgs(["--no-bridge-probe"])).toEqual({ noBridgeProbe: true });
  });

  test("--no-bridge-probe combines with --repo-slug", () => {
    expect(
      parseArgs(["--repo-slug", "qds-factory", "--no-bridge-probe"]),
    ).toEqual({ repoSlug: "qds-factory", noBridgeProbe: true });
  });

  test("--no-bridge-probe=<v> eq form throws unknown flag (bools are exact tokens)", () => {
    expect(() => parseArgs(["--no-bridge-probe=true"])).toThrow(/unknown flag/);
  });

  test("unknown flags still throw with the new bool present", () => {
    expect(() => parseArgs(["--no-bridge-probe", "--bogus"])).toThrow(/unknown flag/);
  });

  test("parseArgs does not mutate the caller's argv [F-014]", () => {
    const argv = ["--repo-slug", "qds-factory", "--no-bridge-probe"];
    expect(parseArgs(argv)).toEqual({ repoSlug: "qds-factory", noBridgeProbe: true });
    // The caller's array is intact — filtering happens on a copy.
    expect(argv).toEqual(["--repo-slug", "qds-factory", "--no-bridge-probe"]);
  });

  test("resolveProbe(true) → always-healthy literal, zero network calls", async () => {
    // DD-17: the dedicated instance has no /invoke bridge — no
    // SWARMCLAW_MCP_SERVER_ID is consulted and no POST to
    // /api/mcp-servers/…/test may leave the process. The literal keeps
    // provisionBanks off its -32001 not-registered short-circuit.
    const urls: string[] = [];
    globalThis.fetch = recordingUrls(urls);
    const p = await resolveProbe(true);
    expect(p).toEqual({ registered: true, healthy: true });
    expect(urls).toHaveLength(0);
  });

  test("resolveProbe(false, id) still delegates to realBridgeProbe", async () => {
    // Shared topology unchanged: the probe fires exactly once against the
    // real route (the fail-closed AC-4 contract survives the new flag).
    process.env.SWARMCLAW_BASE_URL = "http://sw";
    process.env.SWARMCLAW_MCP_SERVER_ID = "hs-1";
    const urls: string[] = [];
    globalThis.fetch = recordingUrls(urls);
    const p = await resolveProbe(false);
    expect(p).toEqual({ registered: true, healthy: true });
    expect(urls).toEqual(["http://sw/api/mcp-servers/hs-1/test"]);
  });
});

describe("provision-hindsight-banks CLI — INV-MEM-1 qds- prefix guard", () => {
  test("--repo-slug myrepo → bank_prefix_violation refusal", () => {
    const g = checkBankPrefix("myrepo");
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.code).toBe("bank_prefix_violation");
      // The envelope main() prints must name both the resolved id and the slug.
      expect(g.message).toMatch(/"myrepo"/);
      expect(g.message).toMatch(/INV-MEM-1/);
    }
  });

  test("slug resolving without the hyphen (qdsnothing) is refused too", () => {
    expect(checkBankPrefix("qdsnothing").ok).toBe(false);
  });

  test("default cwd slug passes: QDS-Factory → qds-factory", () => {
    expect(checkBankPrefix("QDS-Factory")).toEqual({
      ok: true,
      bankId: "qds-factory",
    });
  });

  test("an already-prefixed slug passes through unchanged", () => {
    expect(checkBankPrefix("qds-v6")).toEqual({ ok: true, bankId: "qds-v6" });
  });
});

describe("provision-hindsight-banks CLI — HINDSIGHT_BASE_URL fail-closed guard", () => {
  // Both lanes (shared AND --no-bridge-probe) must refuse to run when
  // HINDSIGHT_BASE_URL is unset: HindsightClient's silent default
  // (http://127.0.0.1:8888) is the tenant sidecar's port on a both-stacks
  // box — the wrong-instance write INV-MEM-1 exists to prevent, and the
  // exact path story AC1's negative control fails (runbook §6.4, DD-28.22).
  // Tested at the checkHindsightBaseUrl seam main() executes (main itself is
  // not injectable). The pre-existing suites never call main or construct a
  // client, so this guard cannot affect them — no env setup needed there.
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.HINDSIGHT_BASE_URL;
  });

  test("unset → base_url_required refusal (fires before any client exists)", () => {
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.HINDSIGHT_BASE_URL;
    const g = checkHindsightBaseUrl();
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.code).toBe("base_url_required");
      // The envelope main() prints must name the trap, the runbook section,
      // and the story's negative control.
      expect(g.message).toMatch(/127\.0\.0\.1:8888/);
      expect(g.message).toMatch(/§6\.4/);
      expect(g.message).toMatch(/AC1/);
    }
  });

  test('HINDSIGHT_BASE_URL="" (empty) → refused, not treated as set', () => {
    process.env.HINDSIGHT_BASE_URL = "";
    expect(checkHindsightBaseUrl().ok).toBe(false);
  });

  test("explicit URL passes and is echoed back", () => {
    // DD-28.22: the dedicated instance's host-side origin.
    process.env.HINDSIGHT_BASE_URL = "http://127.0.0.1:18890";
    expect(checkHindsightBaseUrl()).toEqual({
      ok: true,
      baseUrl: "http://127.0.0.1:18890",
    });
  });
});

describe("provision-hindsight-banks CLI — trap-origin + whitespace guard (F-003/F-013)", () => {
  // F-003: checking only unset/empty let an EXPLICIT
  // HINDSIGHT_BASE_URL=http://127.0.0.1:8888 pass and provision qds- banks
  // into the tenant sidecar — the same wrong-instance write the unset case
  // guards. The trap table is leg-lib forbiddenOrigin (single source with
  // the six leg drivers); the refusal carries its own base_url_trap code so
  // "did not set it" and "set it to the wrong instance" are distinguishable.
  // F-013: whitespace-only is as good as unset, and the checked value is the
  // normalized one main threads into the client.
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.HINDSIGHT_BASE_URL;
  });

  test('whitespace-only "   " → base_url_required (F-013)', () => {
    process.env.HINDSIGHT_BASE_URL = "   ";
    const g = checkHindsightBaseUrl();
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("base_url_required");
  });

  test("http://127.0.0.1:8888 → base_url_trap (the client's silent tenant default)", () => {
    process.env.HINDSIGHT_BASE_URL = "http://127.0.0.1:8888";
    const g = checkHindsightBaseUrl();
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.code).toBe("base_url_trap");
      // The message must name the trap port and the dedicated origin to set.
      expect(g.message).toMatch(/8888/);
      expect(g.message).toMatch(/18890/);
    }
  });

  test('trap survives padding + trailing slash: "  http://127.0.0.1:8888/  " → base_url_trap', () => {
    // forbiddenOrigin normalizes (trim + slash strip) before matching, so
    // routine env spellings cannot slip the suffix check (F-001 discipline,
    // now shared by the CLI through the same function).
    process.env.HINDSIGHT_BASE_URL = "  http://127.0.0.1:8888/  ";
    const g = checkHindsightBaseUrl();
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("base_url_trap");
  });

  test("http://127.0.0.1:18889 → base_url_trap (tenant stack's host map; dedicated is 18890)", () => {
    process.env.HINDSIGHT_BASE_URL = "http://127.0.0.1:18889";
    const g = checkHindsightBaseUrl();
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe("base_url_trap");
  });

  test("valid origin with padding + trailing slash → ok, normalized echo (F-013)", () => {
    process.env.HINDSIGHT_BASE_URL = "  http://127.0.0.1:18890/  ";
    expect(checkHindsightBaseUrl()).toEqual({
      ok: true,
      baseUrl: "http://127.0.0.1:18890",
    });
  });
});

describe("provision-hindsight-banks CLI — rerun-aware provisioning (F-025-CLI)", () => {
  // main() is not injectable (reads process.argv, constructs a real client),
  // so the lane fork is pinned at its exported seam — the same level this
  // file pins parseArgs / checkBankPrefix / checkHindsightBaseUrl. The roster
  // discipline itself (fresh → provisionBanks; base present → canonical
  // PUT-upserts, no junk -2 bank) is leg-lib rerunAwareProvision, the single
  // source both CLI lanes now route through; its own suite lives in
  // tests/p0-9/.
  test("base bank present in the pre-provision snapshot → rerun lane", () => {
    expect(isRerunProvision(["qds-factory", "qds-collective"], "QDS-Factory")).toBe(true);
  });

  test("empty snapshot → fresh lane (provisionBanks verbatim)", () => {
    expect(isRerunProvision([], "QDS-Factory")).toBe(false);
  });

  test("a suffixed junk id (qds-factory-2) is NOT the base → fresh lane", () => {
    expect(isRerunProvision(["qds-factory-2"], "QDS-Factory")).toBe(false);
  });

  test("the base derivation follows the resolver: QDS-Factory → qds-factory", () => {
    // The fork must compare against exactly the id provisionBanks' resolver
    // would land on (leg-lib safeRepoBase), not the raw slug.
    expect(isRerunProvision(["qds-factory"], "qds-factory")).toBe(true);
    expect(isRerunProvision(["QDS-Factory"], "QDS-Factory")).toBe(false);
  });
});

describe("provision-hindsight-banks CLI — fail-closed snapshot (R2-004)", () => {
  // The legacy pre-provision snapshot swallowed a listBanks failure into an
  // empty snapshot → fresh lane → a transient failure on a rerun minted
  // `qds-factory-2` junk. main() now re-asks through takeRerunSnapshot
  // whenever the legacy snapshot reads empty: a THROW is the snapshot_failed
  // refusal (exit 1); an answering roster — even an EMPTY one — stays
  // fresh-lane (emptiness is a classification, not a failure).
  test("listBanks THROWS → {ok:false} carrying the error (the refusal source)", async () => {
    const failing = {
      listBanks: () => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:18890")),
    };
    const g = await takeRerunSnapshot(failing);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.error).toMatch(/ECONNREFUSED/);
  });

  test("a successful call returning an EMPTY roster stays fresh-lane ({ok:true}, [])", async () => {
    const empty = { listBanks: () => Promise.resolve({ banks: [] }) };
    expect(await takeRerunSnapshot(empty)).toEqual({ ok: true, bankIds: [] });
  });

  test("provisioner-tolerant roster shapes flow through extractBankIds", async () => {
    const client = {
      listBanks: () => Promise.resolve({ banks: [{ bank_id: "qds-factory" }, "qds-collective"] }),
    };
    expect(await takeRerunSnapshot(client)).toEqual({
      ok: true,
      bankIds: ["qds-factory", "qds-collective"],
    });
  });
});

describe("provision-hindsight-banks CLI — provision envelope (R2-007/R3-007/R3-008)", () => {
  // The print sites used to emit a different shape per lane (rerun strings vs
  // provisionBanks' ProvisionedBank objects, key sets differing). The ONE
  // builder now normalizes every path: banks are bankId STRINGS from the
  // ACTUAL result, [] on failure, mode always present on provision results.
  test("rerun success: banks = confirmed roster, createdInAttempt verbatim, no error", () => {
    const env = buildProvisionEnvelope("QDS-Factory", "req-1", {
      ok: true,
      mode: "reupsert-existing",
      createdInAttempt: ["qds-factory-dev-meta"],
      raw: { roster: ["qds-factory", "qds-factory-dev-meta", "qds-collective"] },
    });
    expect(env.ok).toBe(true);
    expect(env.banks).toEqual(["qds-factory", "qds-factory-dev-meta", "qds-collective"]);
    expect(env.requestId).toBe("req-1");
    expect(env.mode).toBe("reupsert-existing");
    // R2-011: honest — the recreated -dev-meta counts as this attempt's creation.
    expect(env.createdInAttempt).toEqual(["qds-factory-dev-meta"]);
    expect("error" in env).toBe(false);
  });

  test("rerun failure: banks [], error{code,message}, and the compensation record attached (R3-004)", () => {
    const env = buildProvisionEnvelope(
      "QDS-Factory",
      "req-2",
      {
        ok: false,
        mode: "reupsert-existing",
        createdInAttempt: [],
        raw: { roster: ["qds-factory"], error: "PUT /banks/qds-factory-dev-meta → 500" },
      },
      { deleteOutcomes: { "qds-factory-dev-meta": "deleted" }, residue: {} },
    );
    expect(env.ok).toBe(false);
    // R3-008: the canonical roster is a claim, not a fact, once anything failed.
    expect(env.banks).toEqual([]);
    expect(env.error?.code).toBe("provision_failed");
    expect(env.error?.message).toMatch(/500/);
    expect(env.deleteOutcomes).toEqual({ "qds-factory-dev-meta": "deleted" });
    expect(env.residue).toEqual({});
  });

  test("fresh success: banks are bankId STRINGS from the actual result — a collision -2 id reported honestly (R3-007)", () => {
    const env = buildProvisionEnvelope("QDS-Factory", "req-4", {
      ok: true,
      mode: "resolved-fresh",
      // R3-009 (helper): createdInAttempt carries only status:"created" members.
      createdInAttempt: ["qds-factory-2", "qds-factory-2-dev-meta"],
      raw: {
        ok: true,
        requestId: "req-4",
        banks: [
          { bankId: "qds-factory-2", status: "created" },
          { bankId: "qds-factory-2-dev-meta", status: "created" },
          { bankId: "qds-collective", status: "exists" },
        ],
      },
    });
    expect(env.banks).toEqual(["qds-factory-2", "qds-factory-2-dev-meta", "qds-collective"]);
    expect(env.mode).toBe("resolved-fresh");
    expect(env.createdInAttempt).toEqual(["qds-factory-2", "qds-factory-2-dev-meta"]);
    expect("error" in env).toBe(false);
  });

  test("fresh failure (provisionBanks error object): banks [], numeric code folded into the message", () => {
    const env = buildProvisionEnvelope("QDS-Factory", "req-5", {
      ok: false,
      mode: "resolved-fresh",
      createdInAttempt: [],
      raw: { ok: false, requestId: "req-5", error: { code: -32005, message: "bank provisioning failed: 502" } },
    });
    expect(env.ok).toBe(false);
    expect(env.banks).toEqual([]);
    expect(env.error?.code).toBe("provision_failed");
    expect(env.error?.message).toBe("-32005: bank provisioning failed: 502");
  });

  test("a thrown fresh-path failure shape (raw.thrown) also maps to error.message", () => {
    const env = buildProvisionEnvelope("QDS-Factory", "req-6", {
      ok: false,
      mode: "resolved-fresh",
      createdInAttempt: [],
      raw: { thrown: "socket hang up" },
    });
    expect(env.error?.message).toBe("socket hang up");
  });
});

describe("provision-hindsight-banks CLI — rerun-failure compensation (R3-004)", () => {
  // The helper's failure contract: createdInAttempt is [] under failure and
  // the caller's post∖pre diff is the authority. Claim rule: roster member,
  // absent from pre, present in post (post-presence — not step reports — is
  // the creation evidence; a PUT that lands then 5xxs still created the bank).
  test("claimed member deleted; window-created non-roster bank → residue 'unclaimed-created'; pre-window banks untouched", async () => {
    const deletes: string[] = [];
    const client = {
      // The single post-snapshot: the dev-meta PUT landed then threw, and an
      // unlocked concurrent writer minted a probe bank mid-window. The
      // pre-window edge arrives as the preBankIds argument.
      listBanks: () =>
        Promise.resolve({
          banks: ["qds-factory", "qds-factory-dev-meta", "qds-probe-shape-9"],
        }),
      deleteBank: (id: string) => {
        deletes.push(id);
        return Promise.resolve({ deleted: true, alreadyGone: false, bankId: id });
      },
    };
    const comp = await compensateRerunFailure(client, "QDS-Factory", ["qds-factory"]);
    expect(deletes).toEqual(["qds-factory-dev-meta"]); // base is pre-window — NEVER deleted
    expect(comp.deleteOutcomes).toEqual({ "qds-factory-dev-meta": "deleted" });
    expect(comp.residue).toEqual({ "qds-probe-shape-9": "unclaimed-created" });
  });

  test("a failed member PUT that never landed claims nothing — empty outcomes/residue, no delete (base PUT = upsert of an EXISTING bank, not a creation)", async () => {
    const deletes: string[] = [];
    const client = {
      listBanks: () => Promise.resolve({ banks: ["qds-factory"] }), // -dev-meta never appears
      deleteBank: (id: string) => {
        deletes.push(id);
        return Promise.resolve({ deleted: true, alreadyGone: false, bankId: id });
      },
    };
    const comp = await compensateRerunFailure(client, "QDS-Factory", ["qds-factory"]);
    expect(deletes).toEqual([]);
    expect(comp).toEqual({ deleteOutcomes: {}, residue: {} });
  });

  test("a delete that throws records outcome 'failed' + residue 'delete-failed'", async () => {
    const client = {
      listBanks: () => Promise.resolve({ banks: ["qds-factory", "qds-factory-dev-meta"] }),
      deleteBank: () => Promise.reject(new Error("ECONNREFUSED")),
    };
    const comp = await compensateRerunFailure(client, "QDS-Factory", ["qds-factory"]);
    expect(comp.deleteOutcomes).toEqual({ "qds-factory-dev-meta": "failed" });
    expect(comp.residue).toEqual({ "qds-factory-dev-meta": "delete-failed" });
  });

  test("post-snapshot failure abandons compensation (no authority → no claims, driver discipline)", async () => {
    const client = {
      listBanks: () => Promise.reject(new Error("listBanks 500")),
      deleteBank: () => Promise.resolve({ deleted: true, alreadyGone: false }),
    };
    expect(await compensateRerunFailure(client, "QDS-Factory", ["qds-factory"])).toEqual({
      deleteOutcomes: {},
      residue: {},
    });
  });
});

describe("provision-hindsight-banks CLI — lock-first provision window (R3-003/R3-006)", () => {
  // openProvisionWindow owns the whole discipline main() executes: hardened
  // family lock FIRST, classification snapshot INSIDE the window, then the
  // dispatch. The lock path is per-test tmpdir (its parent dir never exists —
  // every test also pins the mkdir-inside-the-try, R3-006 divergence #2).

  function tmpLockPath(): string {
    return join(mkdtempSync(join(tmpdir(), "qds-prov-cli-")), "hindsight", "provision.lock");
  }

  function fakeInstance(opts: {
    banks?: string[];
    listBanksCalls?: Array<string[]>;
    createBankRejectsAt?: string;
    createBankLandsBeforeReject?: boolean;
  }): {
    client: { listBanks(): Promise<unknown>; createBank(id: string): Promise<unknown>; deleteBank(id: string): Promise<unknown> };
    puts: string[];
    deletes: string[];
  } {
    const puts: string[] = [];
    const deletes: string[] = [];
    let call = 0;
    const banks = opts.banks ?? [];
    return {
      puts,
      deletes,
      client: {
        listBanks: () => {
          call += 1;
          const roster = opts.listBanksCalls?.[call - 1];
          return Promise.resolve({ banks: roster ?? [...banks] });
        },
        createBank: (id: string) => {
          puts.push(id);
          if (id === opts.createBankRejectsAt) {
            if (opts.createBankLandsBeforeReject) banks.push(id);
            return Promise.reject(new Error(`PUT /banks/${id} → 500`));
          }
          banks.push(id);
          return Promise.resolve({ bankId: id });
        },
        deleteBank: (id: string) => {
          deletes.push(id);
          const i = banks.indexOf(id);
          if (i >= 0) banks.splice(i, 1);
          return Promise.resolve({ deleted: true, alreadyGone: false, bankId: id });
        },
      },
    };
  }

  test("classification snapshots INSIDE the window — the family lock is held before listBanks fires, released on settle (R3-003)", async () => {
    const lockPath = tmpLockPath();
    let lockHeldAtSnapshot = false;
    const instance = fakeInstance({ banks: ["qds-factory"] });
    const client = {
      ...instance.client,
      listBanks: () => {
        lockHeldAtSnapshot = existsSync(lockPath);
        return instance.client.listBanks();
      },
    };
    expect(existsSync(lockPath)).toBe(false); // nothing held before the window
    const opened = await openProvisionWindow(client, "QDS-Factory", { lockPath });
    expect(opened.kind).toBe("settled");
    expect(lockHeldAtSnapshot).toBe(true); // snapshot under the lock
    expect(existsSync(lockPath)).toBe(false); // released on the settled path
  });

  test("rerun lane: PUT-upserts the canonical roster, ONE envelope with confirmed roster + honest createdInAttempt, exit 0", async () => {
    const lockPath = tmpLockPath();
    const instance = fakeInstance({ banks: ["qds-factory"] });
    const opened = await openProvisionWindow(instance.client, "QDS-Factory", { lockPath });
    expect(opened.kind).toBe("settled");
    // R3-002: one lane — the roster PUT-upserts in canonical order, no -2 junk.
    expect(instance.puts).toEqual(["qds-factory", "qds-factory-dev-meta", "qds-collective"]);
    if (opened.kind === "settled") {
      expect(opened.code).toBe(0);
      expect(opened.envelope.ok).toBe(true);
      expect(opened.envelope.mode).toBe("reupsert-existing");
      expect(opened.envelope.banks).toEqual([
        "qds-factory",
        "qds-factory-dev-meta",
        "qds-collective",
      ]);
      // base existed pre-window → only dev-meta + collective are creations.
      expect(opened.envelope.createdInAttempt).toEqual([
        "qds-factory-dev-meta",
        "qds-collective",
      ]);
      expect("error" in opened.envelope).toBe(false);
    }
  });

  test("rerun failure compensates: landed-then-threw member claimed+deleted, concurrent stray → residue, exit 1 (R3-004)", async () => {
    const lockPath = tmpLockPath();
    const instance = fakeInstance({
      // snapshot 1: base present (rerun lane). post-snapshot (call 2): the
      // dev-meta PUT landed server-side then threw, plus an unlocked
      // concurrent writer's probe bank.
      listBanksCalls: [
        ["qds-factory"],
        ["qds-factory", "qds-factory-dev-meta", "qds-probe-shape-9"],
      ],
      createBankRejectsAt: "qds-factory-dev-meta",
      createBankLandsBeforeReject: true,
    });
    const opened = await openProvisionWindow(instance.client, "QDS-Factory", { lockPath });
    expect(opened.kind).toBe("settled");
    // roster PUTs stopped at the throwing member (collective never attempted).
    expect(instance.puts).toEqual(["qds-factory", "qds-factory-dev-meta"]);
    // exactly the claimed member is deleted — base (pre-window) and the stray
    // (unclaimed) are left standing.
    expect(instance.deletes).toEqual(["qds-factory-dev-meta"]);
    if (opened.kind === "settled") {
      expect(opened.code).toBe(1);
      expect(opened.envelope.ok).toBe(false);
      expect(opened.envelope.banks).toEqual([]); // R3-008
      expect(opened.envelope.error?.code).toBe("provision_failed");
      expect(opened.envelope.error?.message).toMatch(/qds-factory-dev-meta/);
      expect(opened.envelope.deleteOutcomes).toEqual({ "qds-factory-dev-meta": "deleted" });
      expect(opened.envelope.residue).toEqual({ "qds-probe-shape-9": "unclaimed-created" });
    }
  });

  test("rerun failure with nothing landed: no claim, no delete, empty compensation record", async () => {
    const lockPath = tmpLockPath();
    const instance = fakeInstance({
      listBanksCalls: [["qds-factory"], ["qds-factory"]],
      createBankRejectsAt: "qds-factory-dev-meta",
    });
    const opened = await openProvisionWindow(instance.client, "QDS-Factory", { lockPath });
    expect(opened.kind).toBe("settled");
    expect(instance.deletes).toEqual([]);
    if (opened.kind === "settled") {
      expect(opened.code).toBe(1);
      expect(opened.envelope.deleteOutcomes).toEqual({});
      expect(opened.envelope.residue).toEqual({});
    }
  });

  test("dedicated fresh lane (--no-bridge-probe): DD-17 literal probe + noLock:true under the held family lock (R3-003)", async () => {
    const lockPath = tmpLockPath();
    const instance = fakeInstance({ banks: [] }); // fresh classification
    const seen: ProvisionOptions[] = [];
    const opened = await openProvisionWindow(instance.client, "QDS-Factory", {
      lockPath,
      noBridgeProbe: true,
      provisionImpl: async (o) => {
        seen.push(o);
        return {
          ok: true,
          banks: [
            { bankId: "qds-factory", status: "created" },
            { bankId: "qds-factory-dev-meta", status: "created" },
            { bankId: "qds-collective", status: "exists" },
          ],
          requestId: o.requestId ?? "r",
        };
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.noLock).toBe(true); // R3-003: inner single-flight suppressed
    expect(seen[0]?.bridgeProbe).toEqual({ registered: true, healthy: true }); // DD-17 literal
    expect(seen[0]?.requestId).toEqual(expect.any(String));
    expect(opened.kind).toBe("settled");
    if (opened.kind === "settled") {
      expect(opened.code).toBe(0);
      expect(opened.envelope.mode).toBe("resolved-fresh");
      expect(opened.envelope.banks).toEqual([
        "qds-factory",
        "qds-factory-dev-meta",
        "qds-collective",
      ]);
      // R3-009 via the helper: the "exists" collective is not a creation.
      expect(opened.envelope.createdInAttempt).toEqual(["qds-factory", "qds-factory-dev-meta"]);
    }
  });

  test("shared-fresh handoff: lock STILL HELD at handoff and across ctx.provision (noLock:true), released by handoff release()", async () => {
    const lockPath = tmpLockPath();
    const instance = fakeInstance({ banks: [] });
    const seen: ProvisionOptions[] = [];
    const opened = await openProvisionWindow(instance.client, "QDS-Factory", {
      lockPath,
      provisionImpl: async (o) => {
        seen.push(o);
        return {
          ok: true,
          banks: [{ bankId: "qds-factory", status: "created" }],
          requestId: o.requestId ?? "r",
        };
      },
    });
    expect(opened.kind).toBe("shared-fresh");
    if (opened.kind !== "shared-fresh") return;
    expect(existsSync(lockPath)).toBe(true); // held at the handoff
    expect(opened.ctx.existingBankIds).toEqual([]);
    const envelope = await opened.ctx.provision({
      client: instance.client,
      repoSlug: "QDS-Factory",
      bridgeProbe: { registered: true, healthy: true },
    });
    expect(seen[0]?.noLock).toBe(true); // the same held-lock discipline as main's tail
    expect(existsSync(lockPath)).toBe(true); // held across the provision call
    expect(envelope.ok).toBe(true);
    expect(envelope.mode).toBe("resolved-fresh");
    expect(envelope.banks).toEqual(["qds-factory"]);
    opened.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a live holder refuses busy BEFORE any instance touch (hardened refusal)", async () => {
    const lockPath = tmpLockPath();
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${process.pid}:nonce-busy`); // fresh mtime + live pid
    const instance = fakeInstance({ banks: [] });
    let listBanksCalls = 0;
    const client = {
      ...instance.client,
      listBanks: () => {
        listBanksCalls += 1;
        return instance.client.listBanks();
      },
    };
    const opened = await openProvisionWindow(client, "QDS-Factory", { lockPath });
    expect(opened.kind).toBe("settled");
    expect(listBanksCalls).toBe(0);
    if (opened.kind === "settled") {
      expect(opened.code).toBe(1);
      expect(opened.envelope.error?.code).toBe("provision_lock_busy");
      expect(opened.envelope.banks).toEqual([]);
      expect("mode" in opened.envelope && opened.envelope.mode !== undefined).toBe(false);
    }
    expect(existsSync(lockPath)).toBe(true); // the live holder's lock is untouched
  });

  test("an unparsable-holder lock is STOLEN at once (pid-aware holder, not age-only — R3-006)", async () => {
    const lockPath = tmpLockPath();
    mkdirSync(dirname(lockPath), { recursive: true });
    // No <pid>:<nonce> shape → lockHolderPid → undefined → stale per the
    // holder predicate; age-only would block the full LEG_LOCK_STALE_MS.
    writeFileSync(lockPath, "corrupt-body-no-pid");
    const instance = fakeInstance({ banks: ["qds-factory"] });
    const opened = await openProvisionWindow(instance.client, "QDS-Factory", { lockPath });
    expect(opened.kind).toBe("settled");
    if (opened.kind === "settled") {
      expect(opened.envelope.ok).toBe(true); // the steal let the window proceed
      expect(opened.code).toBe(0);
    }
  });

  test("snapshot failure inside the window → snapshot_failed refusal, lock released (R2-004 seam, window-level)", async () => {
    const lockPath = tmpLockPath();
    const client = {
      listBanks: () => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:18890")),
      createBank: () => Promise.resolve({}),
      deleteBank: () => Promise.resolve({ deleted: true }),
    };
    const opened = await openProvisionWindow(client, "QDS-Factory", { lockPath });
    expect(opened.kind).toBe("settled");
    if (opened.kind === "settled") {
      expect(opened.code).toBe(1);
      expect(opened.envelope.error?.code).toBe("snapshot_failed");
      expect(opened.envelope.error?.message).toMatch(/ECONNREFUSED/);
      expect(opened.envelope.banks).toEqual([]);
    }
    expect(existsSync(lockPath)).toBe(false); // released despite the refusal
  });
});

describe("provision-hindsight-banks CLI — collective-slug + minted-id guard (R2-021/R2-012)", () => {
  test("qds-collective as a repo slug → refused (permanent rerun lane + dev-meta junk)", () => {
    const g = checkBankPrefix("qds-collective");
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.code).toBe("bank_prefix_violation");
      // The envelope main() prints must name the junk the slug would mint.
      expect(g.message).toMatch(/qds-collective-dev-meta/);
      expect(g.message).toMatch(/repo slug/);
    }
  });

  test("a long slug returns the TRUNCATED id provisioning will actually mint (R2-012)", () => {
    // Guard value must equal minted value: resolveBankId is 85 chars here but
    // safeRepoBase truncates to ≤52 (MAX_BASE_LEN) with no trailing dash.
    const long = `qds-${"x".repeat(80)}`;
    const g = checkBankPrefix(long);
    expect(g.ok).toBe(true);
    if (g.ok) {
      expect(g.bankId.length).toBeLessThanOrEqual(52);
      expect(g.bankId).not.toMatch(/-$/);
      // the untruncated resolution — what the guard USED to return
      expect(g.bankId).not.toBe(resolveBankId(long));
    }
  });
});
