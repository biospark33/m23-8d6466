/**
 * DF4.2 unit tests for src/lib/api.ts (AC1).
 *
 * No real network — global fetch is swapped for a fake per test and restored
 * afterward, since `token` and the fetch binding are module-level state
 * shared across every test in this file.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  setToken,
  fetchSessions,
  fetchSession,
  fetchEvents,
  archiveSession,
  fetchHealth,
  fetchPrompts,
  fetchEnvelopes,
  fetchGates,
} from "../../src/lib/api.ts";

const realFetch = globalThis.fetch;

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** Installs a fake fetch that records calls and returns `body` as JSON. */
function mockFetch(status: number, body: unknown): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

/** Installs a fake fetch that returns a body that is not valid JSON. */
function mockFetchInvalidJson(): void {
  globalThis.fetch = (async () =>
    new Response("not json", { status: 200 })) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  setToken("");
});

describe("setToken / authedFetch header", () => {
  test("a token set via setToken is attached as a Bearer header on every request", async () => {
    setToken("secret-token");
    const calls = mockFetch(200, []);
    await fetchSessions();
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer secret-token");
  });

  test("with no token set, no authorization header is attached", async () => {
    const calls = mockFetch(200, []);
    await fetchSessions();
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.has("authorization")).toBe(false);
  });
});

describe("fetchSessions", () => {
  test("GETs /api/sessions and returns the parsed array", async () => {
    const rows = [{ request_id: "r1" }];
    const calls = mockFetch(200, rows);
    const out = await fetchSessions();
    expect(out).toEqual(rows as never);
    expect(calls[0]?.url).toContain("/api/sessions");
  });
});

describe("fetchSession", () => {
  test("fills in default usage/phases/agents when the server omits them", async () => {
    mockFetch(200, { session: { request_id: "r1" } });
    const out = await fetchSession("r1");
    expect(out.usage).toEqual({ read: 0, written: 0 });
    expect(out.phases).toEqual([]);
    expect(out.agents).toEqual([]);
  });

  test("passes through server-supplied fields, and URL-encodes the request id", async () => {
    const calls = mockFetch(200, {
      session: { request_id: "r/1" },
      usage: { read: 5, written: 6 },
      phases: [{ phase_id: "p1" }],
      agents: [{ agent: "a1" }],
    });
    const out = await fetchSession("r/1");
    expect(out.usage).toEqual({ read: 5, written: 6 });
    expect(out.phases).toEqual([{ phase_id: "p1" } as never]);
    expect(calls[0]?.url).toContain(encodeURIComponent("r/1"));
  });
});

describe("fetchEvents", () => {
  test("defaults limit to 500 and passes after through", async () => {
    const calls = mockFetch(200, { rows: [], cursor: 10, hasMore: false });
    await fetchEvents("r1", 10);
    expect(calls[0]?.url).toContain("after=10");
    expect(calls[0]?.url).toContain("limit=500");
  });

  test("a non-finite `after` clamps to 0, a non-finite `limit` clamps to 500", async () => {
    const calls = mockFetch(200, { rows: [], cursor: 0, hasMore: false });
    await fetchEvents("r1", Number.NaN, Number.NaN);
    expect(calls[0]?.url).toContain("after=0");
    expect(calls[0]?.url).toContain("limit=500");
  });

  test("negative/fractional inputs clamp to a sane positive integer", async () => {
    const calls = mockFetch(200, { rows: [], cursor: 0, hasMore: false });
    await fetchEvents("r1", -5, 0.5);
    expect(calls[0]?.url).toContain("after=0");
    expect(calls[0]?.url).toContain("limit=1");
  });

  test("fills defaults when the server response omits them", async () => {
    mockFetch(200, {});
    const out = await fetchEvents("r1", 3);
    expect(out).toEqual({ rows: [], cursor: 3, hasMore: false });
  });
});

describe("archiveSession", () => {
  test("POSTs archived=true by default", async () => {
    const calls = mockFetch(200, {});
    await archiveSession("r1");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/archive");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ archived: true });
  });

  test("can restore a session with archived=false", async () => {
    const calls = mockFetch(200, {});
    await archiveSession("r1", false);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ archived: false });
  });

  test("a non-ok response throws with the status code", async () => {
    mockFetch(500, {});
    await expect(archiveSession("r1")).rejects.toThrow("500");
  });
});

describe("fetchHealth", () => {
  test("GETs /api/health and returns the parsed body", async () => {
    mockFetch(200, { ok: true, db: "trace.db", journal_mode: "wal" });
    const out = await fetchHealth();
    expect(out.ok).toBe(true);
  });
});

describe("fetchPrompts", () => {
  test("a 404 (not recorded / not deployed) renders as an empty array, not an error", async () => {
    mockFetch(404, {});
    const out = await fetchPrompts("r1", "p1");
    expect(out).toEqual([]);
  });

  test("a non-ok, non-404 response throws", async () => {
    mockFetch(500, {});
    await expect(fetchPrompts("r1", "p1")).rejects.toThrow("500");
  });

  test("a successful response returns the parsed prompt rows", async () => {
    const rows = [{ event_id: "e1" }];
    const calls = mockFetch(200, rows);
    const out = await fetchPrompts("r1", "p1");
    expect(out).toEqual(rows as never);
    expect(calls[0]?.url).toContain("phaseId=p1");
  });

  test("an invalid JSON body throws without leaking the raw body text", async () => {
    mockFetchInvalidJson();
    await expect(fetchPrompts("r1", "p1")).rejects.toThrow("invalid JSON response");
  });
});

describe("fetchEnvelopes / fetchGates", () => {
  test("fetchEnvelopes GETs the envelopes route", async () => {
    const rows = [{ envelope_id: "e1" }];
    const calls = mockFetch(200, rows);
    const out = await fetchEnvelopes("r1");
    expect(out).toEqual(rows as never);
    expect(calls[0]?.url).toContain("/envelopes");
  });

  test("fetchGates GETs the gates route", async () => {
    const rows = [{ id: 1 }];
    const calls = mockFetch(200, rows);
    const out = await fetchGates("r1");
    expect(out).toEqual(rows as never);
    expect(calls[0]?.url).toContain("/gates");
  });
});

describe("getJson error path", () => {
  test("a non-ok response on a plain GET throws with url and status", async () => {
    mockFetch(503, {});
    await expect(fetchSessions()).rejects.toThrow("503");
  });
});
