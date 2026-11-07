import { describe, expect, test } from "bun:test";

import { handleMemgateRequest } from "../../src/memgate/server.ts";
import type { MemgateDeps } from "../../src/memgate/schemas.ts";
import type { MemgateIssuanceRow, MemgateIssuanceInput } from "../../src/memgate/ledger.ts";
import { mintRunMemoryKey } from "../../src/memgate/gateway.ts";

function makeDeps(clientOverride?: { recall?: () => Promise<unknown> }): MemgateDeps {
  const signingKey = "test-signing-key";
  const client = {
    recall: clientOverride?.recall ?? (async () => ({ results: [{ documentId: "d1", content: "answer" }] })),
    reflect: async () => ({}),
    consolidate: async () => ({}),
    retain: async () => ({}),
  };
  const issuance = new Map<string, MemgateIssuanceRow>();
  const ledger = {
    getIssuance: (tokenId: string) => issuance.get(tokenId),
    isRevoked: () => false,
    recordIssuance: (row: never) => { const r = row as MemgateIssuanceInput; issuance.set(r.tokenId, { token_id: r.tokenId, kind: r.kind, digest: r.digest, claims_json: r.claimsJson, run_id: r.runId, created_at_ms: r.createdAtMs, expires_at_ms: r.expiresAtMs }); },
    listIssued: () => [],
  };
  return {
    ledger, client, signingKey, adminKey: "test-admin", env: undefined,
    now: () => 1_700_000_000_000, log: () => undefined, embeddedAdmin: true,
  } as unknown as MemgateDeps;
}

function mintedAuthHeader(deps: MemgateDeps, banks: string[]): string {
  const minted = mintRunMemoryKey(deps, { runId: "qds-20261106-aa12bb", banks, ttlMs: 60_000, requestId: "test-mint" });
  return `Bearer ${minted.keyMaterial}`;
}

describe("gateway server - wire contract", () => {
  test("unmapped route -> 403 scope-verb (pre-auth, in-set)", async () => {
    const deps = makeDeps();
    const out = await handleMemgateRequest(deps, { method: "POST", path: "/v1/default/banks/qds-x/NOPE", authHeader: "Bearer whatever", bodyText: "{}" });
    expect(out.status).toBe(403);
    expect((JSON.parse(out.body) as { error: { code: string } }).error.code).toBe("scope-verb");
  });

  test("missing auth -> 401 no-auth", async () => {
    const deps = makeDeps();
    const out = await handleMemgateRequest(deps, { method: "POST", path: "/v1/default/banks/qds-x/memories/recall", authHeader: "", bodyText: "{}" });
    expect(out.status).toBe(401);
    expect((JSON.parse(out.body) as { error: { code: string } }).error.code).toBe("no-auth");
  });

  test("bad JSON body -> 400-family scope-verb refusal", async () => {
    const deps = makeDeps();
    const auth = await mintedAuthHeader(deps, ["qds-x"]);
    const out = await handleMemgateRequest(deps, { method: "POST", path: "/v1/default/banks/qds-x/memories/recall", authHeader: auth, bodyText: "{not json" });
    expect((JSON.parse(out.body) as { error: { code: string } }).error.code).toBe("scope-verb");
  });

  test("valid key + recall -> 200 with the client answer verbatim", async () => {
    const deps = makeDeps();
    const auth = await mintedAuthHeader(deps, ["qds-x"]);
    const out = await handleMemgateRequest(deps, { method: "POST", path: "/v1/default/banks/qds-x/memories/recall", authHeader: auth, bodyText: JSON.stringify({ query: "q", limit: 3 }) });
    expect(out.status).toBe(200);
    expect((JSON.parse(out.body) as { results: unknown[] }).results.length).toBe(1);
  });

  test("bank outside allowlist -> 403 scope-bank", async () => {
    const deps = makeDeps();
    const auth = await mintedAuthHeader(deps, ["qds-allowed"]);
    const out = await handleMemgateRequest(deps, { method: "POST", path: "/v1/default/banks/qds-other/memories/recall", authHeader: auth, bodyText: JSON.stringify({ query: "q", limit: 3 }) });
    expect(out.status).toBe(403);
    expect((JSON.parse(out.body) as { error: { code: string } }).error.code).toBe("scope-bank");
  });

  test("client fault -> 500 internal (out-of-set)", async () => {
    const deps = makeDeps({ recall: async () => { throw new Error("boom"); } });
    const auth = await mintedAuthHeader(deps, ["qds-x"]);
    const out = await handleMemgateRequest(deps, { method: "POST", path: "/v1/default/banks/qds-x/memories/recall", authHeader: auth, bodyText: JSON.stringify({ query: "q", limit: 3 }) });
    expect(out.status).toBe(500);
    expect((JSON.parse(out.body) as { error: { code: string } }).error.code).toBe("internal");
  });

  test("refusal bodies carry the CODE alone — no echo of request material (INV-MG-5/6)", async () => {
    const deps = makeDeps();
    const auth = await mintedAuthHeader(deps, ["qds-x"]);
    // A limit string embedding credential-like material: parseForwardBody's
    // refusal message interpolates the raw value — the wire face must not.
    const secret = `Bearer ${"x".repeat(48)}`;
    const out = await handleMemgateRequest(deps, { method: "POST", path: "/v1/default/banks/qds-x/memories/recall", authHeader: auth, bodyText: JSON.stringify({ query: "q", limit: secret }) });
    expect(out.status).toBe(500);
    expect((JSON.parse(out.body) as { error: { code: string } }).error.code).toBe("forward-body-invalid");
    expect(out.body).not.toContain(secret);
    expect(out.body).not.toContain("x".repeat(48));
    // The scope refusal's message interpolates method+path — also held back.
    const out2 = await handleMemgateRequest(deps, { method: "POST", path: "/v1/default/banks/qds-x/NOPE", authHeader: auth, bodyText: "{}" });
    expect(out2.status).toBe(403);
    expect((JSON.parse(out2.body) as { error: { code: string } }).error.code).toBe("scope-verb");
    expect(out2.body).not.toContain("NOPE");
  });

  test("invalid JSON WITHOUT auth -> no-auth (credentials before the body)", async () => {
    const deps = makeDeps();
    const out = await handleMemgateRequest(deps, { method: "POST", path: "/v1/default/banks/qds-x/memories/recall", authHeader: "", bodyText: "{not json" });
    expect(out.status).toBe(401);
    expect((JSON.parse(out.body) as { error: { code: string } }).error.code).toBe("no-auth");
  });
});

describe("gateway server - real listener (serveMemgate)", () => {
  // Issue-#503-family coverage lift: serveMemgate's Bun.serve wiring was the
  // coverage gate's red (55.14% lines on dev, red across #508/#509/#510 CI).
  // These arms drive the REAL listener on an ephemeral port and assert wire
  // parity with the direct handleMemgateRequest refusals.
  test("pre-body refusals match the direct handler; authenticated recall forwards through the mock client", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { HindsightClient } = await import("../../src/hindsight/client.ts");
    const { MEMGATE_ADMIN_KEY, QDS_MEMGATE_SIGNING_KEY, memgateDeps, mintRunMemoryKey } = await import("../../src/memgate/index.ts");
    const { serveMemgate } = await import("../../src/memgate/server.ts");

    const dir = mkdtempSync(join(tmpdir(), "memgate-listener-"));
    const depsOpts = {
      env: { [MEMGATE_ADMIN_KEY]: "listener-admin", [QDS_MEMGATE_SIGNING_KEY]: "listener-signing" },
      ledgerPath: join(dir, "memgate-ledger.db"),
      now: () => 1_700_000_000_000,
    };
    // A mint-side connection to the SAME ledger file: the listener's own
    // memgateDeps opens the file again, so the minted row must be on disk.
    const mintDeps = memgateDeps({ ...depsOpts, client: new HindsightClient({ mode: "mock" }) });
    const minted = mintRunMemoryKey(mintDeps, { runId: "qds-20261107-cc33dd", banks: ["qds-x"], ttlMs: 60_000, requestId: "listener-mint" });
    mintDeps.ledger.close();

    const srv = serveMemgate({ port: 0, depsOpts: { ...depsOpts, client: new HindsightClient({ mode: "mock" }) } });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const recallPath = "/v1/default/banks/qds-x/memories/recall";
      // no-auth on the wire == the direct handler's refusal (status + code)
      const noAuth = await fetch(`${base}${recallPath}`, { method: "POST", body: "{}" });
      expect(noAuth.status).toBe(401);
      const noAuthBody = (JSON.parse(await noAuth.text()) as { error: { code: string } }).error.code;
      expect(noAuthBody).toBe("no-auth");
      // unmapped route pre-auth == scope-verb, path never reflected
      const trash = await fetch(`${base}/v1/default/banks/qds-x/NOPE`, { method: "POST", headers: { authorization: "Bearer garbage" }, body: "{}" });
      const trashBody = await trash.text();
      expect(trash.status).toBe(403);
      expect(((JSON.parse(trashBody) as { error: { code: string } }).error.code)).toBe("scope-verb");
      expect(trashBody).not.toContain("NOPE");
      // authenticated recall rides the mock client to a 200 with results
      const ok = await fetch(`${base}${recallPath}`, { method: "POST", headers: { authorization: `Bearer ${minted.keyMaterial}` }, body: JSON.stringify({ query: "q", limit: 3 }) });
      expect(ok.status).toBe(200);
      const okBody = (JSON.parse(await ok.text()) as { results?: unknown[] }).results;
      expect(Array.isArray(okBody)).toBe(true);
    } finally {
      srv.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
