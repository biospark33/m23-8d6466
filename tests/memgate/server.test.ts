import { describe, expect, test } from "bun:test";

import { handleMemgateRequest } from "../../src/memgate/server.ts";
import type { MemgateDeps } from "../../src/memgate/schemas.ts";
import { mintRunMemoryKey } from "../../src/memgate/gateway.ts";

function makeDeps(clientOverride?: { recall?: () => Promise<unknown> }): MemgateDeps {
  const signingKey = "test-signing-key";
  const client = {
    recall: clientOverride?.recall ?? (async () => ({ results: [{ documentId: "d1", content: "answer" }] })),
    reflect: async () => ({}),
    consolidate: async () => ({}),
    retain: async () => ({}),
  };
  const issuance = new Map<string, { kind: string; claims_json: string; expires_at_ms: number | null }>();
  const ledger = {
    getIssuance: (tokenId: string) => issuance.get(tokenId),
    isRevoked: () => false,
    recordIssuance: (row: never) => { const r = row as { tokenId: string; kind: string; digest: string; claimsJson: string; runId: string | null; createdAtMs: number; expiresAtMs: number | null }; issuance.set(r.tokenId, { kind: r.kind, digest: r.digest, claims_json: r.claimsJson, run_id: r.runId, created_at_ms: r.createdAtMs, expires_at_ms: r.expiresAtMs }); },
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
});
