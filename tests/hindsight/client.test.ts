import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BankIdSchema,
  ConsolidateResponseSchema,
  ERR_BANK_ID_INVALID,
  ERR_HINDSIGHT_UNAVAILABLE,
  ERR_MCP_BRIDGE_NOT_REGISTERED,
  ERR_MULCH_FILE_COUNT,
  ERR_BANK_COLLISION,
  RecallResponseSchema,
  ReflectResponseSchema,
  resolveBankId,
  RetainExtensionSchema,
  RetainResponseSchema,
} from "../../src/hindsight/schemas.ts";
import {
  CONSOLIDATE_TIMEOUT_MS,
  HindsightClient,
  HindsightHttpError,
  MENTAL_MODEL_TIMEOUT_MS,
  RECALL_TIMEOUT_MS,
  REFLECT_TIMEOUT_MS,
  RETAIN_TIMEOUT_MS,
} from "../../src/hindsight/client.ts";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/mcp/stdio-transport.ts";

// ---------------------------------------------------------------------------
// global fetch mock harness — save/restore per test (story mandate).
// ---------------------------------------------------------------------------

type FetchImpl = typeof globalThis.fetch;
const originalFetch: FetchImpl = globalThis.fetch.bind(globalThis) as FetchImpl;
let lastCall:
  | {
      url: string;
      init?: RequestInit;
      signal?: AbortSignal | null;
    }
  | undefined;

interface MockOpts {
  status?: number;
  body?: unknown;
  // delay in ms before responding; if `respectSignal` is set, an aborted
  // signal surfaces as AbortError instead of resolving.
  delayMs?: number;
  respectSignal?: boolean;
  // raw text body — bypasses JSON.stringify, used to inject non-JSON responses.
  rawBody?: string;
}

function installMock(opts: MockOpts): void {
  const status = opts.status ?? 200;
  // any: Bun.fetch has extra props (preconnect) vs DOM fetch; cast through any to satisfy typeof fetch assignment
  const impl: any = (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    lastCall = {
      url: typeof input === "string" ? input : input.toString(),
      init,
      signal: (init?.signal as AbortSignal | null | undefined) ?? null,
    };
    return new Promise<Response>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        if (opts.respectSignal && lastCall?.signal?.aborted) {
          const e = new Error("The operation was aborted");
          e.name = "AbortError";
          rejectPromise(e);
          return;
        }
        const body =
          opts.rawBody !== undefined ? opts.rawBody : JSON.stringify(opts.body ?? {});
        resolvePromise(
          new Response(body, {
            status,
            headers: { "content-type": "application/json" },
          }),
        );
      }, opts.delayMs ?? 0);
      // If the caller aborted before the timer fires, surface AbortError.
      const signal = (init?.signal as AbortSignal | null | undefined) ?? null;
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            const e = new Error("The operation was aborted");
            e.name = "AbortError";
            rejectPromise(e);
          },
          { once: true },
        );
      }
    });
  };
  globalThis.fetch = impl as FetchImpl;
}

beforeEach(() => {
  lastCall = undefined;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// schemas + resolveBankId
// ---------------------------------------------------------------------------

describe("BankIdSchema + resolveBankId", () => {
  test("resolveBankId: lowercases, replaces non-alnum with hyphens, strips ends", () => {
    expect(resolveBankId("QDS-Factory")).toBe("qds-factory");
    expect(resolveBankId("My.COOL_repo!")).toBe("my-cool-repo");
    expect(resolveBankId("a")).toBe("a");
    expect(resolveBankId("!!!!")).toBe("");
    expect(resolveBankId("----")).toBe("");
  });

  test("resolveBankId does NOT enforce BankIdSchema — caller must safeParse", () => {
    // Empty string is a valid return but fails BankIdSchema.
    expect(BankIdSchema.safeParse("").success).toBe(false);
    expect(BankIdSchema.safeParse(resolveBankId("!!!!")).success).toBe(false);
  });

  test("BankIdSchema accepts canonical IDs and rejects path-traversal", () => {
    expect(BankIdSchema.safeParse("qds-factory").success).toBe(true);
    expect(BankIdSchema.safeParse("qds-factory-dev-meta").success).toBe(true);
    expect(BankIdSchema.safeParse("qds-collective").success).toBe(true);
    expect(BankIdSchema.safeParse("../../etc/passwd").success).toBe(false);
    expect(BankIdSchema.safeParse("UPPER").success).toBe(false);
    expect(BankIdSchema.safeParse("-leading").success).toBe(false);
    expect(BankIdSchema.safeParse("trailing-").success).toBe(false);
  });

  test("error code consts are stable values", () => {
    expect(ERR_MCP_BRIDGE_NOT_REGISTERED).toBe(-32001);
    expect(ERR_HINDSIGHT_UNAVAILABLE).toBe(-32002);
    expect(ERR_BANK_ID_INVALID).toBe(-32003);
    expect(ERR_MULCH_FILE_COUNT).toBe(-32004);
    expect(ERR_BANK_COLLISION).toBe(-32005);
  });
});

// ---------------------------------------------------------------------------
// HindsightClient: success paths
// ---------------------------------------------------------------------------

describe("HindsightClient success paths", () => {
  test("retain success parses RetainResponseSchema and returns typed obj", async () => {
    // Wire body (0.10.0): {success, bank_id?, items_count, async}. A malformed
    // body would throw 502 inside retain, so a typed return IS the parse proof.
    installMock({
      body: {
        success: true,
        bank_id: "qds-factory",
        items_count: 1,
        async: false,
      },
    });
    const client = new HindsightClient({
      baseUrl: "http://hindsight.test",
      requestId: "req-retain",
    });
    const r = await client.retain("qds-factory", "Sprint planning uses SPARC methodology");
    // Legacy view via the schema transform: memoryId "" is the issue-#408
    // placeholder (0.10.0 wire has no memoryId source; identity is document_id).
    expect(r.memoryId).toBe("");
    expect(r.bankId).toBe("qds-factory");
    expect(r.status).toBe("created");
    expect(r.durationMs).toBe(0);
    expect(lastCall?.url).toBe(
      "http://hindsight.test/v1/default/banks/qds-factory/memories",
    );
  });

  test("recall success parses RecallResponseSchema", async () => {
    // Wire result items (0.10.0): {id, text, document_id} — distinct fact id
    // and document identity; content/score are produced by the transform.
    installMock({
      body: {
        results: [
          {
            id: "fact-1",
            text: "Sprint planning uses SPARC methodology",
            document_id: "doc-1",
          },
        ],
        durationMs: 120,
      },
    });
    const client = new HindsightClient({ baseUrl: "http://hindsight.test" });
    const r = await client.recall("qds-factory", "planning methodology");
    expect(r.results[0]?.content).toBe("Sprint planning uses SPARC methodology");
    expect(r.results[0]?.memoryId).toBe("fact-1");
    expect(lastCall?.url).toBe(
      "http://hindsight.test/v1/default/banks/qds-factory/memories/recall",
    );
  });

  test("reflect success parses ReflectResponseSchema", async () => {
    installMock({
      body: {
        bankId: "qds-factory",
        insights: [{ summary: "team leans SPARC", relatedMemories: 3 }],
        durationMs: 500,
      },
    });
    const client = new HindsightClient({ baseUrl: "http://hindsight.test" });
    const r = await client.reflect("qds-factory");
    expect(ReflectResponseSchema.safeParse(r).success).toBe(true);
    expect(r.insights[0]?.summary).toBe("team leans SPARC");
    expect(lastCall?.url).toBe(
      "http://hindsight.test/v1/default/banks/qds-factory/reflect",
    );
  });

  test("consolidate success parses ConsolidateResponseSchema", async () => {
    installMock({
      body: { consolidatedCount: 5, preservedCount: 10, durationMs: 1000 },
    });
    const client = new HindsightClient({ baseUrl: "http://hindsight.test" });
    const r = await client.consolidate("qds-factory");
    expect(ConsolidateResponseSchema.safeParse(r).success).toBe(true);
    expect(r.consolidatedCount).toBe(5);
    expect(r.preservedCount).toBe(10);
    expect(lastCall?.url).toBe(
      "http://hindsight.test/v1/default/banks/qds-factory/consolidate",
    );
  });

  test("createBank PUTs to /v1/default/banks/{bank_id} (idempotent upsert)", async () => {
    installMock({ body: { bankId: "qds-factory", created: true } });
    const client = new HindsightClient({ baseUrl: "http://hindsight.test" });
    await client.createBank("qds-factory");
    expect(lastCall?.url).toBe("http://hindsight.test/v1/default/banks/qds-factory");
    expect(lastCall?.init?.method).toBe("PUT");
  });

  test("listBanks GETs /v1/default/banks", async () => {
    installMock({
      body: { banks: [{ bankId: "qds-factory" }] },
    });
    const client = new HindsightClient({ baseUrl: "http://hindsight.test" });
    const r = await client.listBanks();
    expect(lastCall?.url).toBe("http://hindsight.test/v1/default/banks");
    expect(lastCall?.init?.method).toBe("GET");
    expect(r).toEqual({ banks: [{ bankId: "qds-factory" }] });
  });
});

// ---------------------------------------------------------------------------
// HindsightClient: error paths
// ---------------------------------------------------------------------------

describe("HindsightClient error paths", () => {
  test("non-2xx → HindsightHttpError with status + safe message", async () => {
    installMock({
      status: 502,
      body: { error: "upstream unavailable" },
    });
    const client = new HindsightClient({ requestId: "req-err" });
    let caught: HindsightHttpError | undefined;
    try {
      await client.recall("qds-factory", "q");
    } catch (e) {
      if (e instanceof HindsightHttpError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught?.status).toBe(502);
    expect(caught?.requestId).toBe("req-err");
    // Message should reflect the body content without leaking raw shape.
    expect(caught?.message).toContain("upstream unavailable");
  });

  test("non-JSON body → error message stringified, no throw of raw", async () => {
    installMock({
      status: 500,
      rawBody: "<html>server died</html>",
    });
    const client = new HindsightClient({ requestId: "req-nonjson" });
    let caught: HindsightHttpError | undefined;
    try {
      await client.recall("qds-factory", "q");
    } catch (e) {
      if (e instanceof HindsightHttpError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught?.status).toBe(500);
    expect(caught?.message).toContain("server died");
  });

  test("timeout → AbortError surfaced as HindsightHttpError; signal aborted + timer cleared", async () => {
    // fetch mock that honors the abort signal but never resolves on its own.
    installMock({ delayMs: 10_000, respectSignal: true });
    // Use a custom client with a very short timeout by calling request() directly.
    const client = new HindsightClient({ requestId: "req-timeout" });
    let caught: HindsightHttpError | undefined;
    try {
      // Direct internal request with 50ms timeout.
      await (client as unknown as {
        request: (m: string, p: string, b?: unknown, t?: number) => Promise<unknown>;
      }).request("POST", "/v1/default/banks/qds-factory/memories/recall", { query: "q" }, 50);
    } catch (e) {
      if (e instanceof HindsightHttpError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught?.status).toBe(408);
    // The fetch mock's signal must have been aborted.
    expect(lastCall?.signal?.aborted).toBe(true);
  });

  test("apiKey present → Authorization: Bearer header sent; absent → no header", async () => {
    // Present
    installMock({ body: {} });
    const withKey = new HindsightClient({ apiKey: "secret-token" });
    await withKey.listBanks();
    const headersPresent = new Headers(lastCall?.init?.headers);
    expect(headersPresent.get("Authorization")).toBe("Bearer secret-token");

    // Absent
    installMock({ body: {} });
    const noKey = new HindsightClient({});
    await noKey.listBanks();
    const headersAbsent = new Headers(lastCall?.init?.headers);
    expect(headersAbsent.get("Authorization")).toBeNull();
  });

  test("requestId propagated to x-request-id header", async () => {
    installMock({ body: {} });
    const client = new HindsightClient({ requestId: "req-trace" });
    await client.listBanks();
    const headers = new Headers(lastCall?.init?.headers);
    expect(headers.get("x-request-id")).toBe("req-trace");
  });

  test("invalid bankId → HindsightHttpError 422 before any fetch (INV-HM2)", async () => {
    installMock({ body: {} });
    const client = new HindsightClient({ baseUrl: "http://hindsight.test" });
    for (const bad of ["../../etc", "UPPER CASE", "-leading", "trailing-"]) {
      lastCall = undefined;
      let caught: HindsightHttpError | undefined;
      try {
        await client.retain(bad, "should never be sent");
      } catch (e) {
        if (e instanceof HindsightHttpError) caught = e;
      }
      expect(caught).toBeDefined();
      expect(caught?.status).toBe(422);
      expect(caught?.message).toContain(bad);
      // Guard runs before request: no fetch should have been issued.
      expect(lastCall).toBeUndefined();
    }
  });

  test("HINDSIGHT_BEARER_TOKEN preferred over HINDSIGHT_API_KEY (INV-HM1)", async () => {
    // Both set → bearer token wins.
    process.env.HINDSIGHT_BEARER_TOKEN = "bearer-val";
    process.env.HINDSIGHT_API_KEY = "legacy-val";
    try {
      installMock({ body: {} });
      const clientBoth = new HindsightClient({});
      await clientBoth.listBanks();
      let headers = new Headers(lastCall?.init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer bearer-val");

      // Only legacy key set → still works (fallback). delete (not = undefined):
      // Node stringifies `process.env.X = undefined` to the literal "undefined",
      // which (being a truthy string) would survive the client constructor's
      // `|| undefined` coercion and shadow HINDSIGHT_API_KEY. delete truly unsets
      // so the legacy fallback path is actually exercised.
      // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
      delete process.env.HINDSIGHT_BEARER_TOKEN;
      installMock({ body: {} });
      const clientLegacy = new HindsightClient({});
      await clientLegacy.listBanks();
      headers = new Headers(lastCall?.init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer legacy-val");
    } finally {
      // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
      delete process.env.HINDSIGHT_BEARER_TOKEN;
      // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
      delete process.env.HINDSIGHT_API_KEY;
    }
  });

  test("default timeout consts are the spec values", () => {
    expect(RETAIN_TIMEOUT_MS).toBe(30_000);
    expect(RECALL_TIMEOUT_MS).toBe(10_000);
    expect(REFLECT_TIMEOUT_MS).toBe(30_000);
    expect(CONSOLIDATE_TIMEOUT_MS).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// mock mode — P1.11/P1.12 AC5 env-fallback (OQ-4 BLOCKED-on-env). No network.
// ---------------------------------------------------------------------------

describe("HindsightClient mock mode", () => {
  beforeEach(() => {
    // Sentinel: if mock mode ever calls fetch, the global mock records it and
    // these tests fail. We never install a returning fetch — any call is a bug.
    lastCall = undefined;
    globalThis.fetch = (async () => {
      throw new Error("mock mode MUST NOT call fetch");
    }) as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("default mode is live — reaches fetch (no mock short-circuit)", async () => {
    const c = new HindsightClient({ baseUrl: "http://x" });
    // Live mode with a throwing fetch proves the request path was NOT
    // short-circuited by mock logic.
    await expect(c.recall("qds-factory", "x")).rejects.toThrow(
      "mock mode MUST NOT call fetch",
    );
  });

  test("mock recall returns schema-valid empty results without network", async () => {
    const c = new HindsightClient({ mode: "mock" });
    const res = await c.recall("qds-factory", "anything");
    // A malformed canned body would throw 502 inside recall — a typed return
    // proves the mock body passed the SAME strict parse a live one does.
    expect(res.results).toEqual([]);
    expect(res.durationMs).toBe(0);
  });

  test("mock retain returns the measured 0.10.0 wire body through the strict parse", async () => {
    const c = new HindsightClient({ mode: "mock" });
    const res = await c.retain("qds-factory", "data");
    // Legacy view via the transform. memoryId "" is the issue-#408 placeholder
    // (the canned wire body has no id source); no bank_id on the wire → "".
    expect(res.memoryId).toBe("");
    expect(res.bankId).toBe("");
    expect(res.status).toBe("created");
    expect(res.durationMs).toBe(0);
  });

  test("mock reflect + consolidate + banks return schema-valid/echo shapes", async () => {
    const c = new HindsightClient({ mode: "mock" });
    const reflected = await c.reflect("qds-factory");
    expect(ReflectResponseSchema.safeParse(reflected).success).toBe(true);
    const consolidated = await c.consolidate("qds-factory");
    expect(ConsolidateResponseSchema.safeParse(consolidated).success).toBe(true);
    const created = await c.createBank("qds-factory");
    expect(created).toEqual({ bank_id: "qds-factory" });
    const listed = await c.listBanks();
    expect(listed).toEqual({});
  });

  // Mock mode bypasses the network, NOT the telemetry: audit + waiver
  // diagnostics must still see operation/duration/status/requestId even when
  // P1.11/P1.12 AC5 runs entirely against canned bodies.
  test("mock mode still emits the CC-9 telemetry log entry (no network)", async () => {
    const entries: LogEntry[] = [];
    const restore = setLogSink((e) => entries.push(e));
    try {
      const c = new HindsightClient({ mode: "mock", requestId: "fixed-rid" });
      await c.retain("qds-factory", "data");
    } finally {
      restore();
    }

    const retainLog = entries.find((e) => e.operation === "retain");
    expect(retainLog).toBeDefined();
    expect(retainLog?.requestId).toBe("fixed-rid");
    expect(retainLog?.bankId).toBe("qds-factory");
    expect(retainLog?.status).toBe("ok");
    expect(typeof retainLog?.duration).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// HindsightClient.deleteBank — M1.1 AC3 rollback / AC4 probe cleanup.
// 404 resolves as already-gone (idempotent, like createBank's PUT upsert).
// ---------------------------------------------------------------------------

describe("HindsightClient.deleteBank", () => {
  test("success → {deleted:true, alreadyGone:false}; DELETE + Bearer header", async () => {
    process.env.HINDSIGHT_BEARER_TOKEN = "del-token";
    try {
      installMock({ body: { success: true, deleted_count: 2 } });
      const client = new HindsightClient({ baseUrl: "http://hindsight.test" });
      const r = await client.deleteBank("qds-factory");
      expect(r).toEqual({
        deleted: true,
        alreadyGone: false,
        bankId: "qds-factory",
        deletedCount: 2,
      });
      expect(lastCall?.url).toBe("http://hindsight.test/v1/default/banks/qds-factory");
      expect(lastCall?.init?.method).toBe("DELETE");
      const headers = new Headers(lastCall?.init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer del-token");
    } finally {
      // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
      delete process.env.HINDSIGHT_BEARER_TOKEN;
    }
  });

  test("200 with deleted_count:0 → already-gone (Track A: no existence check)", async () => {
    installMock({ body: { success: true, deleted_count: 0 } });
    const client = new HindsightClient({ baseUrl: "http://hindsight.test" });
    const r = await client.deleteBank("qds-factory");
    expect(r).toEqual({
      deleted: false,
      alreadyGone: true,
      bankId: "qds-factory",
      deletedCount: 0,
    });
  });

  test("2xx body success:false → HindsightHttpError 502 'delete refused by server' [F-015]", async () => {
    // Defensive arm: the 0.10.0 wire never answers 200 + success:false, but a
    // refused delete reported as {deleted:true} would poison AC3's
    // compensation accounting — refuse loudly instead.
    installMock({ body: { success: false, message: "refused" } });
    const client = new HindsightClient({
      baseUrl: "http://hindsight.test",
      requestId: "req-del-refused",
    });
    let caught: HindsightHttpError | undefined;
    try {
      await client.deleteBank("qds-factory");
    } catch (e) {
      if (e instanceof HindsightHttpError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught?.status).toBe(502);
    expect(caught?.message).toBe("delete refused by server");
    expect(caught?.requestId).toBe("req-del-refused");
  });

  test('2xx deleted_count:"0" (string) → non-numeric → field absent, deleted:true [F-015 pin]', async () => {
    // Pin the kept semantics: only a NUMERIC 0 means already-gone; a string
    // "0" is a shape variance and lands in the absent branch.
    installMock({ body: { success: true, deleted_count: "0" } });
    const client = new HindsightClient({ baseUrl: "http://hindsight.test" });
    const r = await client.deleteBank("qds-factory");
    expect(r).toEqual({ deleted: true, alreadyGone: false, bankId: "qds-factory" });
  });

  test("404 → {deleted:false, alreadyGone:true} — no throw (AC3 idempotent)", async () => {
    installMock({ status: 404, body: { error: "bank not found" } });
    const client = new HindsightClient({ baseUrl: "http://hindsight.test" });
    const r = await client.deleteBank("qds-factory");
    expect(r).toEqual({ deleted: false, alreadyGone: true, bankId: "qds-factory" });
  });

  test("other non-2xx (500) → HindsightHttpError rethrown unchanged", async () => {
    installMock({ status: 500, body: { error: "boom" } });
    const client = new HindsightClient({ baseUrl: "http://hindsight.test" });
    let caught: HindsightHttpError | undefined;
    try {
      await client.deleteBank("qds-factory");
    } catch (e) {
      if (e instanceof HindsightHttpError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught?.status).toBe(500);
  });

  test("invalid bankId → 422 before any fetch (INV-HM2)", async () => {
    installMock({ body: {} });
    const client = new HindsightClient({ baseUrl: "http://hindsight.test" });
    let caught: HindsightHttpError | undefined;
    try {
      await client.deleteBank("../../etc");
    } catch (e) {
      if (e instanceof HindsightHttpError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught?.status).toBe(422);
    // Guard runs before request: no fetch should have been issued.
    expect(lastCall).toBeUndefined();
  });

  test("mock mode → {deleted:true, alreadyGone:false} with no fetch", async () => {
    // Sentinel: any fetch call here fails the test.
    globalThis.fetch = (async () => {
      throw new Error("mock mode MUST NOT call fetch");
    }) as unknown as typeof globalThis.fetch; // dp:ok sentinel stub assigned to globalThis.fetch (mock mode must never fetch); no narrowing expresses a stub as the whole fetch type
    const c = new HindsightClient({ mode: "mock" });
    const r = await c.deleteBank("qds-factory");
    expect(r).toEqual({ deleted: true, alreadyGone: false, bankId: "qds-factory" });
  });
});

// ---------------------------------------------------------------------------
// M1.2 retain surface — AC5 (P2.8 fold): owned schema'd retain extension +
// wire→legacy-view response conformance. Wire shapes are the MEASURED 0.10.0
// bodies (_bmad-output/evidence/p0-9-closure/
// 2026-10-04T20-19-46Z-p0-9-document-id-retain-twice.json), not invented.
// ---------------------------------------------------------------------------

describe("M1.2 retain surface", () => {
  test("retain forwards documentId/updateMode/tags as wire document_id + top-level tags", async () => {
    installMock({ body: { success: true, items_count: 1, async: false } });
    const client = new HindsightClient({
      baseUrl: "http://hindsight.test",
      requestId: "req-m12-retain",
    });
    await client.retain("qds-factory", "outcome body", {
      source: "agent",
      kind: "observation",
      documentId: "qds-20261006-abc",
      updateMode: "replace",
      tags: ["memory-retain"],
    });
    // One whole-body assertion pins the mapping: document_id + tags are
    // TOP-LEVEL on the item (metadata.tags 422s on 0.10.0) and updateMode
    // leaks NOTHING to the wire — it IS the document_id upsert.
    expect(JSON.parse(String(lastCall?.init?.body))).toEqual({ // dp:ok parses this test's own recorded stub body; a parse failure IS the test failing
      items: [
        {
          content: "outcome body",
          document_id: "qds-20261006-abc",
          tags: ["memory-retain"],
          metadata: { source: "agent", kind: "observation" },
        },
      ],
    });
  });

  test("2xx body success:false → HindsightHttpError 502 'retain refused by server' — no silent success [F6]", async () => {
    // The legacy view the schema transform emits carries no `success`, so a
    // refused retain would otherwise parse clean and resolve as success.
    installMock({ body: { success: false, items_count: 0, async: false } });
    const client = new HindsightClient({
      baseUrl: "http://hindsight.test",
      requestId: "req-retain-refused",
    });
    let caught: HindsightHttpError | undefined;
    try {
      await client.retain("qds-factory", "outcome body");
    } catch (e) {
      if (e instanceof HindsightHttpError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught?.status).toBe(502);
    expect(caught?.message).toBe("retain refused by server (success:false)");
    expect(caught?.requestId).toBe("req-retain-refused");
  });

  test("2xx success:true with items_count:0 → HindsightHttpError 502 'retain stored zero items' [G8]", async () => {
    // The mirror arm of F6: a 2xx that stored nothing must not resolve as a
    // landed retain (a receipt would then be issued over zero stored items).
    installMock({ body: { success: true, items_count: 0, async: false } });
    const client = new HindsightClient({
      baseUrl: "http://hindsight.test",
      requestId: "req-retain-zero",
    });
    let caught: HindsightHttpError | undefined;
    try {
      await client.retain("qds-factory", "outcome body");
    } catch (e) {
      if (e instanceof HindsightHttpError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught?.status).toBe(502);
    expect(caught?.message).toBe("retain stored zero items");
    expect(caught?.requestId).toBe("req-retain-zero");
  });

  test("2xx success:true with items_count:0 + async:true → queued accept, resolves (no zero-items refusal)", async () => {
    // async:true is a queued accept (the response schema models `async`), so
    // the G8 refusal only fires for the synchronous zero-item shape.
    installMock({ body: { success: true, items_count: 0, async: true } });
    const client = new HindsightClient({ baseUrl: "http://hindsight.test" });
    const r = await client.retain("qds-factory", "outcome body");
    expect(r.status).toBe("created");
  });

  test("updateMode without documentId → HindsightHttpError 422 pre-fetch [L-replace]", async () => {
    // `replace` IS the document_id upsert — without an identity it can only
    // fabricate a new document, which would fake idempotency.
    installMock({ body: { success: true, items_count: 1, async: false } });
    const client = new HindsightClient({ baseUrl: "http://hindsight.test" });
    let caught: HindsightHttpError | undefined;
    try {
      await client.retain("qds-factory", "outcome body", { updateMode: "replace" });
    } catch (e) {
      if (e instanceof HindsightHttpError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught?.status).toBe(422);
    expect(caught?.message).toBe("updateMode requires documentId");
    // Refusal happens at the client boundary, before request(): no fetch.
    expect(lastCall).toBeUndefined();
  });

  test("empty documentId is refused by the RetainExtensionSchema [L-emptydocid]", async () => {
    // documentId is the upsert identity — an empty string must never ride the
    // wire as one.
    expect(RetainExtensionSchema.safeParse({ documentId: "" }).success).toBe(false);
    expect(RetainExtensionSchema.safeParse({ documentId: "qds-20261006-abc" }).success).toBe(true);
  });

  test("tags ride the RetainExtensionSchema parse; a non-array tags refuses before any fetch [F20]", async () => {
    // Owned: the extension validates tags so a malformed one is refused at the
    // client boundary, not drifted onto the wire.
    expect(RetainExtensionSchema.safeParse({ tags: ["a", "b"] }).success).toBe(true);
    expect(RetainExtensionSchema.safeParse({}).success).toBe(true);
    expect(RetainExtensionSchema.safeParse({ tags: "run-outcome" }).success).toBe(false);
    // And through the client: the same 422 pre-fetch refusal as updateMode.
    installMock({ body: { success: true, items_count: 1, async: false } });
    const client = new HindsightClient({ baseUrl: "http://hindsight.test" });
    let caught: HindsightHttpError | undefined;
    try {
      await client.retain("qds-factory", "x", {
        source: "agent",
        tags: "run-outcome" as unknown as string[], // dp:ok deliberately type-erases an INVALID tags value to prove the schema refuses it at runtime [F20]
      });
    } catch (e) {
      if (e instanceof HindsightHttpError) caught = e;
    }
    expect(caught?.status).toBe(422);
    expect(caught?.message).toContain("invalid retain extension");
    // Refusal happens at the client boundary, before request(): no fetch.
    expect(lastCall).toBeUndefined();
  });

  test("mock retain round-trips through the strict schema with no network", async () => {
    globalThis.fetch = (async () => {
      throw new Error("mock mode MUST NOT call fetch");
    }) as unknown as typeof globalThis.fetch; // dp:ok sentinel stub assigned to globalThis.fetch (mock mode must never fetch); no narrowing expresses a stub as the whole fetch type
    // The exact canned retain body mockBody returns must parse and transform —
    // a wire-drifted mock fails the SAME strict parse a live body does (AC5:
    // network-only short-circuit, never validation short-circuit).
    const parsed = RetainResponseSchema.safeParse({
      success: true,
      items_count: 1,
      async: false,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cached_tokens: 0,
        thoughts_tokens: 0,
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ memoryId: "", bankId: "", status: "created", durationMs: 0 });
    }
    const c = new HindsightClient({ mode: "mock" });
    const res = await c.retain("qds-factory", "data");
    expect(res).toEqual({ memoryId: "", bankId: "", status: "created", durationMs: 0 });
  });

  test("recall wire result {id, text, document_id} → legacy view fields + documentId echo", () => {
    const parsed = RecallResponseSchema.safeParse({
      results: [
        { id: "fact-1", text: "kg observation", document_id: "qds-20261006-abc" },
      ],
      durationMs: 120,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.results[0]).toEqual({
        memoryId: "fact-1",
        content: "kg observation",
        score: 0,
        documentId: "qds-20261006-abc",
      });
      expect(parsed.data.durationMs).toBe(120);
    }
  });

  test("recall result without document_id → documentId null (null-tolerant additive)", () => {
    const parsed = RecallResponseSchema.safeParse({
      results: [{ id: "fact-2", text: "no doc" }],
      durationMs: 5,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.results[0]?.documentId).toBeNull();
      expect(parsed.data.results[0]?.memoryId).toBe("fact-2");
      expect(parsed.data.results[0]?.content).toBe("no doc");
    }
  });

  test("updateMode other than 'replace' is refused by schema before any fetch", async () => {
    expect(RetainExtensionSchema.safeParse({ updateMode: "append" }).success).toBe(false);
    installMock({ body: { success: true, items_count: 1, async: false } });
    const client = new HindsightClient({ baseUrl: "http://hindsight.test" });
    let caught: HindsightHttpError | undefined;
    try {
      await client.retain("qds-factory", "x", {
        source: "agent",
        updateMode: "append",
      } as unknown as { source: "agent"; updateMode: "replace" }); // dp:ok deliberately type-erases an INVALID updateMode to prove the schema refuses it at runtime
    } catch (e) {
      if (e instanceof HindsightHttpError) caught = e;
    }
    expect(caught?.status).toBe(422);
    expect(caught?.message).toContain("invalid retain extension");
    // Refusal happens at the client boundary, before request(): no fetch.
    expect(lastCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// M3.1 mental models + operations surfaces (leaf 1.1.2). Request/response
// shapes are the vendored 0.10.0 OpenAPI
// (~/.claude/skills/hindsight-docs/references/openapi.json):
// CreateMentalModelRequest :10926, CreateMentalModelResponse :10993,
// PATCH body UpdateMentalModelRequest :19212, response MentalModelResponse
// :15355, list envelope MentalModelListResponse :15057 (envelope key `items`,
// NOT `mental_models`), OperationsListResponse :16666, OperationResponse
// :16282, ConsolidationResponse :10350. Trigger-only per DD-28.16 — no
// refresh method exists (pinned below).
// ---------------------------------------------------------------------------

describe("mental models + operations (M3.1 leaf 1.1.2)", () => {
  test("createMentalModel POSTs the snake_case wire body and parses CreateMentalModelResponse", async () => {
    // Real wire: mental_model_id null until background reflect finishes
    // (openapi.json:10995 anyOf string|null); operation_id always present.
    installMock({ body: { mental_model_id: null, operation_id: "op-create-1" } });
    const client = new HindsightClient({
      baseUrl: "http://hindsight.test",
      requestId: "req-mm-create",
    });
    const r = await client.createMentalModel("qds-factory", {
      id: "team-communication",
      name: "Team Communication Preferences",
      sourceQuery: "How does the team prefer to communicate?",
      trigger: { refresh_after_consolidation: true },
      maxTokens: 2048,
    });
    expect(lastCall?.url).toBe(
      "http://hindsight.test/v1/default/banks/qds-factory/mental-models",
    );
    expect(lastCall?.init?.method).toBe("POST");
    // camelCase args → snake_case wire keys (CreateMentalModelRequest :10926).
    expect(JSON.parse(String(lastCall?.init?.body))).toEqual({ // dp:ok parses this test's own recorded stub body; a parse failure IS the test failing
      id: "team-communication",
      name: "Team Communication Preferences",
      source_query: "How does the team prefer to communicate?",
      trigger: { refresh_after_consolidation: true },
      max_tokens: 2048,
    });
    expect(r.operation_id).toBe("op-create-1");
    expect(r.mental_model_id).toBeNull();
  });

  test("patchMentalModel PATCHes the trigger and parses the MentalModelResponse shape", async () => {
    installMock({
      body: {
        id: "mm-1",
        bank_id: "qds-factory",
        name: "Team Communication Preferences",
        trigger: { refresh_after_consolidation: true },
      },
    });
    const client = new HindsightClient({
      baseUrl: "http://hindsight.test",
      requestId: "req-mm-patch",
    });
    const r = await client.patchMentalModel("qds-factory", "mm-1", {
      trigger: { refresh_after_consolidation: true },
    });
    expect(lastCall?.url).toBe(
      "http://hindsight.test/v1/default/banks/qds-factory/mental-models/mm-1",
    );
    expect(lastCall?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(lastCall?.init?.body))).toEqual({ // dp:ok parses this test's own recorded stub body; parse failure = the test failing
      trigger: { refresh_after_consolidation: true },
    });
    expect(r.id).toBe("mm-1");
    expect(r.trigger?.refresh_after_consolidation).toBe(true);
  });

  test("listMentalModels forwards ?detail= and parses the `items` envelope (:15057)", async () => {
    installMock({
      body: {
        items: [
          {
            id: "mm-1",
            bank_id: "qds-factory",
            name: "Team Communication Preferences",
            trigger: { refresh_cron: "0 3 * * *" },
          },
        ],
        total: 1,
        limit: 100,
        offset: 0,
      },
    });
    const client = new HindsightClient({ baseUrl: "http://hindsight.test" });
    const r = await client.listMentalModels("qds-factory", "content");
    expect(lastCall?.url).toBe(
      "http://hindsight.test/v1/default/banks/qds-factory/mental-models?detail=content",
    );
    expect(lastCall?.init?.method).toBe("GET");
    expect(r.total).toBe(1);
    expect(r.items[0]?.id).toBe("mm-1");
    // Unseen trigger fields survive read-backs — MentalModelTriggerSchema is
    // .passthrough() (openapi.json:15856+ carries min_refresh_interval_seconds,
    // budget, fact_types, ... that the narrowed schema does not enumerate).
    expect(r.items[0]?.trigger?.refresh_cron).toBe("0 3 * * *");
  });

  test("listOperations forwards type/status/limit and parses OperationsListResponse (:16666)", async () => {
    installMock({
      body: {
        bank_id: "qds-factory",
        total: 1,
        limit: 20,
        offset: 0,
        operations: [
          {
            id: "550e8400-e29b-41d4-a716-446655440000",
            task_type: "refresh_mental_model",
            operation_id: "550e8400-e29b-41d4-a716-446655440000",
            operation_type: "refresh_mental_model",
            items_count: 0,
            mental_model_id: "mm-1",
            created_at: "2026-10-09T00:00:00Z",
            updated_at: "2026-10-09T00:01:00Z",
            status: "completed",
            error_message: null,
          },
        ],
      },
    });
    const client = new HindsightClient({ baseUrl: "http://hindsight.test" });
    const r = await client.listOperations("qds-factory", {
      type: "refresh_mental_model",
      status: "completed",
      limit: 20,
    });
    expect(lastCall?.url).toBe(
      "http://hindsight.test/v1/default/banks/qds-factory/operations?type=refresh_mental_model&status=completed&limit=20",
    );
    expect(lastCall?.init?.method).toBe("GET");
    expect(r.bank_id).toBe("qds-factory");
    // A refresh op row names the model it acted on (OperationResponse :16343).
    expect(r.operations[0]?.mental_model_id).toBe("mm-1");
    expect(r.operations[0]?.task_type).toBe("refresh_mental_model");
  });

  test("consolidate parses BOTH the legacy mock body and the real 0.10.0 wire body", async () => {
    const client = new HindsightClient({ baseUrl: "http://hindsight.test" });
    // Legacy view (the pre-widening required-counts shape) — must keep parsing.
    installMock({ body: { consolidatedCount: 1, preservedCount: 0, durationMs: 5 } });
    const legacy = await client.consolidate("qds-factory");
    expect(legacy.consolidatedCount).toBe(1);
    expect(legacy.preservedCount).toBe(0);
    expect(legacy.durationMs).toBe(5);
    // Real 0.10.0 wire (ConsolidationResponse, openapi.json:10350) — the shape
    // that 502'd through requestJSON safeParse before the widening.
    installMock({ body: { operation_id: "op-1", deduplicated: true } });
    const wire = await client.consolidate("qds-factory");
    expect(wire.operation_id).toBe("op-1");
    expect(wire.deduplicated).toBe(true);
  });

  test("createMentalModel invalid bankId → 422 before any fetch (INV-HM2)", async () => {
    installMock({ body: {} });
    const client = new HindsightClient({ baseUrl: "http://hindsight.test" });
    let caught: HindsightHttpError | undefined;
    try {
      await client.createMentalModel("../../etc", {
        name: "should never be sent",
        sourceQuery: "q",
      });
    } catch (e) {
      if (e instanceof HindsightHttpError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught?.status).toBe(422);
    // Guard runs before request: no fetch should have been issued.
    expect(lastCall).toBeUndefined();
  });

  test("no refresh method exists on HindsightClient (trigger-only, DD-28.16)", () => {
    const client = new HindsightClient({ baseUrl: "http://hindsight.test" });
    expect("refreshMentalModel" in client).toBe(false);
    // Grep-style guarantee: no method whose name matches /refresh/ at all —
    // pins the absence, not just one spelling of it.
    const names = Object.getOwnPropertyNames(HindsightClient.prototype);
    expect(names.some((n) => /refresh/i.test(n))).toBe(false);
  });

  test("MENTAL_MODEL_TIMEOUT_MS is 30s", () => {
    expect(MENTAL_MODEL_TIMEOUT_MS).toBe(30_000);
  });
});

