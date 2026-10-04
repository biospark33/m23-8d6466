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
  RetainResponseSchema,
} from "../../src/hindsight/schemas.ts";
import {
  CONSOLIDATE_TIMEOUT_MS,
  HindsightClient,
  HindsightHttpError,
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
    installMock({
      body: {
        memoryId: "mem-1",
        bankId: "qds-factory",
        status: "created",
        durationMs: 42,
      },
    });
    const client = new HindsightClient({
      baseUrl: "http://hindsight.test",
      requestId: "req-retain",
    });
    const r = await client.retain("qds-factory", "Sprint planning uses SPARC methodology");
    expect(RetainResponseSchema.safeParse(r).success).toBe(true);
    expect(r.memoryId).toBe("mem-1");
    expect(r.bankId).toBe("qds-factory");
    expect(r.status).toBe("created");
    expect(lastCall?.url).toBe(
      "http://hindsight.test/v1/default/banks/qds-factory/memories",
    );
  });

  test("recall success parses RecallResponseSchema", async () => {
    installMock({
      body: {
        results: [
          {
            content: "Sprint planning uses SPARC methodology",
            score: 0.92,
            memoryId: "mem-1",
          },
        ],
        durationMs: 120,
      },
    });
    const client = new HindsightClient({ baseUrl: "http://hindsight.test" });
    const r = await client.recall("qds-factory", "planning methodology");
    expect(RecallResponseSchema.safeParse(r).success).toBe(true);
    expect(r.results[0]?.content).toBe("Sprint planning uses SPARC methodology");
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
    expect(RecallResponseSchema.safeParse(res).success).toBe(true);
    expect(res.results).toEqual([]);
  });

  test("mock retain returns schema-valid response with deterministic memoryId", async () => {
    const c = new HindsightClient({ mode: "mock" });
    const res = await c.retain("qds-factory", "data");
    expect(RetainResponseSchema.safeParse(res).success).toBe(true);
    expect(res.memoryId).toBe("mock-qds-factory");
    expect(res.bankId).toBe("qds-factory");
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
    }) as unknown as typeof globalThis.fetch;
    const c = new HindsightClient({ mode: "mock" });
    const r = await c.deleteBank("qds-factory");
    expect(r).toEqual({ deleted: true, alreadyGone: false, bankId: "qds-factory" });
  });
});

