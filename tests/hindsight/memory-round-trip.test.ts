/**
 * Unit tests for the Hindsight round-trip verifier (P0.9 AC-1).
 *
 * Mock boundary: HindsightClient. Each test stubs retain/recall/reflect/
 * consolidate to return response-schema-shaped objects, then asserts the
 * verifier's RoundTripResult. Logs are captured via setLogSink (CC-9).
 *
 * Per research-brief.md "Hindsight is NOT reachable end-to-end on this host":
 * NO test depends on a live Hindsight. All transport is mocked at client.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/mcp/stdio-transport.ts";
import { HindsightHttpError } from "../../src/hindsight/client.ts";
import {
  verifyRoundTrip,
  type RoundTripResult,
} from "../../src/hindsight/round-trip-verifier.ts";

// ---------------------------------------------------------------------------
// Client stub — minimal HindsightClient-shaped object. `any` per Biome config
// (noExplicitAny: off); the contract under test is the verifier's behaviour,
// not the client's type surface.
// ---------------------------------------------------------------------------

interface StubConfig {
  retain?: (bankId: string, content: string) => Promise<unknown>;
  recall?: (bankId: string, query: string) => Promise<unknown>;
  reflect?: (bankId: string, query?: string) => Promise<unknown>;
  consolidate?: (bankId: string) => Promise<unknown>;
}

function makeClient(cfg: StubConfig): any {
  return {
    retain: cfg.retain ?? (async () => ({
      memoryId: "mem-1",
      bankId: "qds-factory",
      status: "created",
      durationMs: 10,
    })),
    recall:
      cfg.recall ??
      (async () => ({
        results: [{ content: "Sprint planning uses SPARC methodology", score: 0.95, memoryId: "mem-1" }],
        durationMs: 50,
      })),
    reflect:
      cfg.reflect ??
      (async () => ({
        bankId: "qds-factory",
        insights: [{ summary: "SPARC is the chosen methodology", relatedMemories: 1 }],
        durationMs: 100,
      })),
    consolidate:
      cfg.consolidate ??
      (async () => ({
        consolidatedCount: 2,
        preservedCount: 5,
        durationMs: 200,
      })),
  };
}

const DEFAULTS = {
  bankId: "qds-factory",
  content: "Sprint planning uses SPARC methodology",
  query: "planning methodology",
};

// ---------------------------------------------------------------------------
// log sink capture
// ---------------------------------------------------------------------------

let logEntries: LogEntry[] = [];
let restoreLogSink: (() => void) | undefined;

beforeEach(() => {
  logEntries = [];
  restoreLogSink = setLogSink((e) => {
    logEntries.push(e);
  });
});

afterEach(() => {
  if (restoreLogSink) restoreLogSink();
});

function entriesFor(operation: string): LogEntry[] {
  return logEntries.filter((e) => e.operation === operation);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verifyRoundTrip — happy path", () => {
  test("full round-trip returns ok:true with expected fields", async () => {
    const result = await verifyRoundTrip({
      client: makeClient({}),
      bankId: DEFAULTS.bankId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ok = result as Extract<RoundTripResult, { ok: true }>;
    expect(ok.memoryId).toBe("mem-1");
    expect(ok.recallMatches).toBe(true);
    expect(ok.insightCount).toBe(1);
    expect(ok.consolidatedCount).toBe(2);
    expect(ok.preservedCount).toBe(5);
    expect(ok.slowQuery).toBe(false);
    expect(ok.durations.retain).toBe(10);
    expect(ok.durations.recall).toBe(50);
    expect(ok.durations.reflect).toBe(100);
    expect(ok.durations.consolidate).toBe(200);
    expect(ok.durations.total).toBeGreaterThan(0);
    expect(typeof ok.requestId).toBe("string");
    expect(ok.requestId.length).toBeGreaterThan(0);
  });

  test("defaults to a deterministic content/query when omitted", async () => {
    // Same as above but explicitly assert the defaults are used: the stub's
    // recall returns DEFAULT_CONTENT, so recallMatches must be true.
    const result = await verifyRoundTrip({
      client: makeClient({}),
      bankId: DEFAULTS.bankId,
    });
    expect(result.ok).toBe(true);
  });

  test("post-consolidate recall still matches retained content", async () => {
    const result = await verifyRoundTrip({
      client: makeClient({}),
      bankId: DEFAULTS.bankId,
    });
    expect(result.ok).toBe(true);
  });

  test("emits round_trip, recall, consolidate log entries with metrics", async () => {
    await verifyRoundTrip({ client: makeClient({}), bankId: DEFAULTS.bankId });

    const roundTrips = entriesFor("round_trip");
    expect(roundTrips.length).toBe(1);
    expect(roundTrips[0]?.round_trip_ms).toBeGreaterThan(0);
    expect(roundTrips[0]?.recall_ms).toBe(50);
    expect(roundTrips[0]?.consolidate_ms).toBe(200);

    const recalls = entriesFor("recall");
    // 2 recall ops: initial + post-consolidation.
    expect(recalls.length).toBe(2);
    expect(recalls.every((e) => e.recall_ms !== undefined)).toBe(true);

    const consolidates = entriesFor("consolidate");
    expect(consolidates.length).toBe(1);
    expect(consolidates[0]?.consolidate_ms).toBe(200);

    // one retain, one reflect
    expect(entriesFor("retain").length).toBe(1);
    expect(entriesFor("reflect").length).toBe(1);
  });
});

describe("verifyRoundTrip — recall failures", () => {
  test("empty recall → ok:false at recall step", async () => {
    const result = await verifyRoundTrip({
      client: makeClient({
        recall: async () => ({ results: [], durationMs: 5 }),
      }),
      bankId: DEFAULTS.bankId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = result as Extract<RoundTripResult, { ok: false }>;
    expect(err.step).toBe("recall");
    expect(err.error.code).toBe("empty_recall");
    expect(err.requestId.length).toBeGreaterThan(0);
  });

  test("recall returns results but none match content tokens → ok:false", async () => {
    const result = await verifyRoundTrip({
      client: makeClient({
        recall: async () => ({
          results: [{ content: "completely unrelated weather report", score: 0.1, memoryId: "x" }],
          durationMs: 5,
        }),
      }),
      bankId: DEFAULTS.bankId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = result as Extract<RoundTripResult, { ok: false }>;
    expect(err.step).toBe("recall");
    expect(err.error.code).toBe("recall_content_mismatch");
  });

  test("recall throws HindsightHttpError → ok:false with mapped code", async () => {
    const result = await verifyRoundTrip({
      client: makeClient({
        recall: async () => {
          throw new HindsightHttpError(500, "internal", "req-xyz");
        },
      }),
      bankId: DEFAULTS.bankId,
      requestId: "req-xyz",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = result as Extract<RoundTripResult, { ok: false }>;
    expect(err.step).toBe("recall");
    expect(err.error.code).toBe("bad_gateway");
    expect(err.error.message).toBe("internal");
    expect(err.requestId).toBe("req-xyz");
  });

  test("recall timeout (408) → ok:false with timeout code", async () => {
    const result = await verifyRoundTrip({
      client: makeClient({
        recall: async () => {
          throw new HindsightHttpError(408, "timed out after 10000ms", "req-t");
        },
      }),
      bankId: DEFAULTS.bankId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = result as Extract<RoundTripResult, { ok: false }>;
    expect(err.step).toBe("recall");
    expect(err.error.code).toBe("timeout");
  });

  test("slow recall (>5s) → result.slowQuery true + slow_query log flag", async () => {
    const result = await verifyRoundTrip({
      client: makeClient({
        recall: async () => ({
          results: [{ content: "Sprint planning uses SPARC methodology", score: 0.9, memoryId: "m" }],
          durationMs: 6_500,
        }),
      }),
      bankId: DEFAULTS.bankId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ok = result as Extract<RoundTripResult, { ok: true }>;
    expect(ok.slowQuery).toBe(true);
    expect(ok.durations.recall).toBe(6_500);

    const recalls = entriesFor("recall");
    const initialRecall = recalls[0];
    expect(initialRecall?.slow_query).toBe(true);

    const roundTrip = entriesFor("round_trip")[0];
    expect(roundTrip?.slow_query).toBe(true);
  });
});

describe("verifyRoundTrip — reflect failures", () => {
  test("empty insights → ok:false at reflect step", async () => {
    const result = await verifyRoundTrip({
      client: makeClient({
        reflect: async () => ({ bankId: "qds-factory", insights: [], durationMs: 5 }),
      }),
      bankId: DEFAULTS.bankId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = result as Extract<RoundTripResult, { ok: false }>;
    expect(err.step).toBe("reflect");
    expect(err.error.code).toBe("empty_insights");
  });

  test("insight with empty summary → ok:false", async () => {
    const result = await verifyRoundTrip({
      client: makeClient({
        reflect: async () => ({
          bankId: "qds-factory",
          insights: [{ summary: "" }],
          durationMs: 5,
        }),
      }),
      bankId: DEFAULTS.bankId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = result as Extract<RoundTripResult, { ok: false }>;
    expect(err.step).toBe("reflect");
    expect(err.error.code).toBe("invalid_insights");
  });

  test("reflect throws HindsightHttpError → ok:false at reflect step", async () => {
    const result = await verifyRoundTrip({
      client: makeClient({
        reflect: async () => {
          throw new HindsightHttpError(503, "reflect unavailable", "r1");
        },
      }),
      bankId: DEFAULTS.bankId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = result as Extract<RoundTripResult, { ok: false }>;
    expect(err.step).toBe("reflect");
    expect(err.error.code).toBe("bad_gateway");
  });
});

describe("verifyRoundTrip — consolidate failures", () => {
  test("consolidate throws HindsightHttpError → ok:false at consolidate step", async () => {
    const result = await verifyRoundTrip({
      client: makeClient({
        consolidate: async () => {
          throw new HindsightHttpError(500, "consolidate failed", "r2");
        },
      }),
      bankId: DEFAULTS.bankId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = result as Extract<RoundTripResult, { ok: false }>;
    expect(err.step).toBe("consolidate");
    expect(err.error.code).toBe("bad_gateway");
    expect(err.error.message).toBe("consolidate failed");
  });

  test("consolidate returns invalid count → ok:false", async () => {
    const result = await verifyRoundTrip({
      client: makeClient({
        consolidate: async () => ({
          consolidatedCount: -1,
          preservedCount: 5,
          durationMs: 10,
        }),
      }),
      bankId: DEFAULTS.bankId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = result as Extract<RoundTripResult, { ok: false }>;
    expect(err.step).toBe("consolidate");
    expect(err.error.code).toBe("unknown");
  });
});

describe("verifyRoundTrip — retain failure", () => {
  test("retain throws HindsightHttpError → ok:false at retain step", async () => {
    const result = await verifyRoundTrip({
      client: makeClient({
        retain: async () => {
          throw new HindsightHttpError(400, "bad content", "r3");
        },
      }),
      bankId: DEFAULTS.bankId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = result as Extract<RoundTripResult, { ok: false }>;
    expect(err.step).toBe("retain");
    expect(err.error.code).toBe("http_400");
  });
});

describe("verifyRoundTrip — post-consolidation recall", () => {
  test("post-consolidate recall mismatch → ok:false at post_consolidate_recall step", async () => {
    let call = 0;
    const result = await verifyRoundTrip({
      client: makeClient({
        recall: async () => {
          call += 1;
          if (call === 1) {
            return {
              results: [{ content: "Sprint planning uses SPARC methodology", score: 0.9, memoryId: "m" }],
              durationMs: 10,
            };
          }
          // Second call (post-consolidate): content gone.
          return {
            results: [{ content: "totally different content now", score: 0.1, memoryId: "z" }],
            durationMs: 10,
          };
        },
      }),
      bankId: DEFAULTS.bankId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = result as Extract<RoundTripResult, { ok: false }>;
    expect(err.step).toBe("post_consolidate_recall");
    expect(err.error.code).toBe("post_consolidate_mismatch");
  });

  test("post-consolidate recall empty → ok:false at post_consolidate_recall step", async () => {
    let call = 0;
    const result = await verifyRoundTrip({
      client: makeClient({
        recall: async () => {
          call += 1;
          if (call === 1) {
            return {
              results: [{ content: "Sprint planning uses SPARC methodology", score: 0.9, memoryId: "m" }],
              durationMs: 10,
            };
          }
          return { results: [], durationMs: 5 };
        },
      }),
      bankId: DEFAULTS.bankId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = result as Extract<RoundTripResult, { ok: false }>;
    expect(err.step).toBe("post_consolidate_recall");
  });
});

describe("verifyRoundTrip — custom content/query", () => {
  test("custom content + query are passed through and matched", async () => {
    let seenQuery = "";
    const result = await verifyRoundTrip({
      client: makeClient({
        recall: async (_b, q) => {
          seenQuery = q;
          return {
            results: [{ content: "custom memory about deno deploy", score: 0.9, memoryId: "cm" }],
            durationMs: 30,
          };
        },
      }),
      bankId: DEFAULTS.bankId,
      content: "custom memory about deno deploy",
      query: "deno deployment",
    });

    expect(seenQuery).toBe("deno deployment");
    expect(result.ok).toBe(true);
  });
});
