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
