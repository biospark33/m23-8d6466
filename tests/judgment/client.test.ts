/**
 * JudgmentClient tests (JEV-2 AC-1, AC-2, AC-4, AC-5, INV-J1, INV-J5).
 *
 * The retry arms use a `globalThis.fetch` stub harness (hindsight suite
 * idiom) — no real fetch, no real spend. The make-or-break path runs with
 * `TYPESAFE_MOCK=1` and NO `TYPESAFE_API_KEY`, proving the core runs keyless.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_RETRY_AFTER_MS } from "../../src/lib/http.ts";
import { CeilingExceededError, JudgmentCeiling } from "../../src/judgment/ceiling.ts";
import {
  JudgmentClient,
  JudgmentConfigError,
  JudgmentHttpError,
  TYPESAFE_API_URL,
  TYPESAFE_MODEL,
} from "../../src/judgment/client.ts";
import { EnvelopeSchema } from "../../src/judgment/envelope.ts";
import { setLogSink, type LogEntry } from "../../src/lib/log.ts";
import type { Question } from "../../src/judgment/schemas.ts";

// ---------------------------------------------------------------------------
// env hygiene — every test starts with neither variable set.
// ---------------------------------------------------------------------------

const SAVED_MOCK = process.env.TYPESAFE_MOCK;
const SAVED_KEY = process.env.TYPESAFE_API_KEY;

let dir: string;

beforeEach(() => {
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  delete process.env.TYPESAFE_MOCK;
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  delete process.env.TYPESAFE_API_KEY;
  dir = mkdtempSync(join(tmpdir(), "jev-client-"));
});

afterEach(() => {
  if (SAVED_MOCK === undefined) {
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.TYPESAFE_MOCK;
  } else {
    process.env.TYPESAFE_MOCK = SAVED_MOCK;
  }
  if (SAVED_KEY === undefined) {
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.TYPESAFE_API_KEY;
  } else {
    process.env.TYPESAFE_API_KEY = SAVED_KEY;
  }
  globalThis.fetch = originalFetch;
  restoreLogs?.();
});

// ---------------------------------------------------------------------------
// global fetch stub harness (hindsight idiom): a scripted queue of responses.
// ---------------------------------------------------------------------------

type FetchImpl = typeof globalThis.fetch;
const originalFetch: FetchImpl = globalThis.fetch.bind(globalThis) as FetchImpl;
const KEY = "SECRETKEYVALUE123";

interface Step {
  status: number;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

let steps: Step[] = [];
let calls: Recorded[] = [];

function install(sequence: Step[]): void {
  steps = sequence;
  calls = [];
  const impl: FetchImpl = (async (
    input: Parameters<FetchImpl>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const step = steps[Math.min(calls.length, steps.length - 1)]!;
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const text = step.rawBody !== undefined ? step.rawBody : JSON.stringify(step.body ?? {});
    return new Response(text, { status: step.status, headers: step.headers });
  }) as FetchImpl;
  globalThis.fetch = impl;
}

let restoreLogs: (() => void) | undefined;
function captureLogs(): LogEntry[] {
  const entries: LogEntry[] = [];
  restoreLogs = setLogSink((e) => entries.push(e));
  return entries;
}

// ---------------------------------------------------------------------------

const QUESTIONS = {
  is_defect: { type: "noul", instructions: "Is this a real defect?" },
} as const;

const USAGE = { input_tokens: 321, output_tokens: 5 };

function liveBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    model: TYPESAFE_MODEL,
    answers: { is_defect: { type: "noul", noul: 0 } },
    usage: USAGE,
    ...overrides,
  };
}

function mockClient(opts: Record<string, unknown> = {}): JudgmentClient {
  return new JudgmentClient({ requestId: "rid-test", provenanceDir: dir, ...opts });
}

function liveClient(opts: Record<string, unknown> = {}): JudgmentClient {
  process.env.TYPESAFE_API_KEY = KEY;
  // No default retryDelayMs here: the retry-after honoring tests patch
  // Bun.sleep instead, so the real delay path is what gets exercised.
  return new JudgmentClient({
    mode: "live",
    baseUrl: "http://judgment.test",
    requestId: "rid-live",
    provenanceDir: dir,
    ...opts,
  });
}

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Mode resolution (INV-J5: mock is the default; live needs a non-empty key).
// ---------------------------------------------------------------------------

describe("mode resolution", () => {
  test("default mode is mock — constructs with no key present", () => {
    expect(mockClient().mode).toBe("mock");
  });

  test("live mode without a non-empty TYPESAFE_API_KEY throws at construction", () => {
    expect(() => new JudgmentClient({ mode: "live" })).toThrow(JudgmentConfigError);
    process.env.TYPESAFE_API_KEY = ""; // empty string is not a key
    expect(() => new JudgmentClient({ mode: "live" })).toThrow(JudgmentConfigError);
  });

  test("TYPESAFE_MOCK=1 forces mock and overrides an explicit mode:live (no key needed)", async () => {
    process.env.TYPESAFE_MOCK = "1";
    globalThis.fetch = (async () => {
      throw new Error("forced mock MUST NOT call fetch");
    }) as unknown as typeof globalThis.fetch;
    const client = new JudgmentClient({ mode: "live", provenanceDir: dir, requestId: "rid-f" });
    const env = await client.judge("state", QUESTIONS, { egressClass: "machine-state" });
    expect(client.mode).toBe("mock");
    expect(env.model).toBe(TYPESAFE_MODEL);
  });

  test("any TYPESAFE_MOCK value other than exactly \"1\" is ignored", () => {
    for (const v of ["0", "true", "yes", "01"]) {
      process.env.TYPESAFE_MOCK = v;
      expect(() => new JudgmentClient({ mode: "live" })).toThrow(JudgmentConfigError);
      expect(new JudgmentClient({}).mode).toBe("mock");
    }
  });

  test("key is read from TYPESAFE_API_KEY env at construction only (INV-J1)", () => {
    process.env.TYPESAFE_API_KEY = "env-key";
    const client = new JudgmentClient({ mode: "live", provenanceDir: dir });
    process.env.TYPESAFE_API_KEY = "changed-after-construction";
    expect(client.apiKey).toBe("env-key");
  });
});

// ---------------------------------------------------------------------------
// Make-or-break: the whole core runs green in mock mode with NO key (AC-1).
// ---------------------------------------------------------------------------

describe("mock-mode end-to-end (zero network, no key)", () => {
  let logs: LogEntry[];

  beforeEach(() => {
    globalThis.fetch = (async () => {
      throw new Error("mock mode MUST NOT call fetch");
    }) as unknown as typeof globalThis.fetch;
    logs = captureLogs();
  });

  test("judge() resolves a strictly-validated envelope, emits provenance, logs one house line", async () => {
    const client = mockClient({ requestId: "rid-mock" });
    const env = await client.judge("gate verdict: FAIL", QUESTIONS, { egressClass: "finding-text" });

    expect(EnvelopeSchema.safeParse(env).success).toBe(true);
    expect(env.requestId).toBe("rid-mock");
    expect(env.model).toBe("jev-1.13.0");
    expect(Object.keys(env.questions)).toEqual(["is_defect"]);
    expect(env.answers.is_defect!.type).toBe("noul");
    expect(env.usage).toEqual({ input_tokens: expect.any(Number), output_tokens: expect.any(Number) });
    expect(typeof env.latency_ms).toBe("number");
    expect(env.latency_ms).toBeGreaterThanOrEqual(0);
    expect(env.egress_class).toBe("finding-text");
    expect(Number.isNaN(Date.parse(env.created_at))).toBe(false);

    // Exactly one provenance file keyed by requestId, under the OVERRIDDEN dir.
    expect(readdirSync(dir)).toEqual(["rid-mock.json"]);

    // House-shaped log line — LogEntry shape, no console.log.
    const judgeLog = logs.filter((e) => e.operation === "judge");
    expect(judgeLog.length).toBe(1);
    expect(judgeLog[0]?.requestId).toBe("rid-mock");
    expect(judgeLog[0]?.status).toBe("ok");
    expect(typeof judgeLog[0]?.duration).toBe("number");
  });

  test("mock answers are deterministic and pass the SAME validation path as live", async () => {
    // Distinct requestIds: the provenance emit is keyed by requestId, and a
    // second call under the SAME id carries a fresh created_at (which would
    // legitimately read as digest divergence — see emit.test.ts).
    const a = await mockClient({ requestId: "rid-a" }).judge("s", QUESTIONS, { egressClass: "machine-state" });
    const b = await mockClient({ requestId: "rid-b" }).judge("s", QUESTIONS, { egressClass: "machine-state" });
    expect(a.answers).toEqual(b.answers);
    expect(a.usage).toEqual(b.usage);
  });

  test("per-type mock answers cover choice and score criteria", async () => {
    const client = mockClient();
    const qs: Record<string, Question> = {
      c: { type: "choice", instructions: "i", criteria: { patch: "p", dismiss: "d" } },
      s: { type: "score", instructions: "i", criteria: ["low", "high"] },
      n: { type: "noul", instructions: "i" },
    };
    const env = await client.judge("s", qs, { egressClass: "machine-state" });
    expect(env.answers.c!.type).toBe("choice");
    expect(env.answers.s!.type).toBe("score");
    expect(env.answers.n!.type).toBe("noul");
  });
});

// ---------------------------------------------------------------------------
// Live path via the fetch stub: retry arms (AC-2), fatal statuses, validation.
// ---------------------------------------------------------------------------

describe("live-mode retry arms (fetch stub)", () => {
  test("429 then 200: exactly one retry honoring retry-after, envelope carries observed usage", async () => {
    install([{ status: 429, headers: { "retry-after": "3" } }, { status: 200, body: liveBody() }]);
    const delays: number[] = [];
    const origSleep = Bun.sleep;
    Bun.sleep = ((ms: number | Promise<number>): Promise<void> => {
      delays.push(Number(ms));
      return Promise.resolve();
    }) as typeof Bun.sleep;
    try {
      const env = await liveClient().judge("s", QUESTIONS, { egressClass: "machine-state" });
      expect(calls.length).toBe(2);
      expect(delays).toEqual([3_000]);
      expect(env.usage).toEqual(USAGE);
      expect(env.requestId).toBe("rid-live");
    } finally {
      Bun.sleep = origSleep;
    }
  });

  test("a retry-after longer than MAX_RETRY_AFTER_MS is capped, not waited out", async () => {
    install([{ status: 429, headers: { "retry-after": "999999" } }, { status: 200, body: liveBody() }]);
    const delays: number[] = [];
    const origSleep = Bun.sleep;
    Bun.sleep = ((ms: number | Promise<number>): Promise<void> => {
      delays.push(Number(ms));
      return Promise.resolve();
    }) as typeof Bun.sleep;
    try {
      await liveClient().judge("s", QUESTIONS, { egressClass: "machine-state" });
      expect(delays).toEqual([MAX_RETRY_AFTER_MS]);
    } finally {
      Bun.sleep = origSleep;
    }
  });

  test("529 is retried like 429 (vendor overload class)", async () => {
    install([{ status: 529 }, { status: 200, body: liveBody() }]);
    await liveClient({ retryDelayMs: 0 }).judge("s", QUESTIONS, { egressClass: "machine-state" });
    expect(calls.length).toBe(2);
  });

  test("401 is fatal on the first attempt — no retry, body text carried in the error", async () => {
    install([{ status: 401, body: { error: "invalid api key" } }]);
    let caught: JudgmentHttpError | undefined;
    try {
      await liveClient().judge("s", QUESTIONS, { egressClass: "machine-state" });
    } catch (e) {
      caught = e as JudgmentHttpError;
    }
    expect(caught).toBeInstanceOf(JudgmentHttpError);
    expect(caught?.status).toBe(401);
    expect(caught?.message).toContain("401");
    expect(caught?.message).toContain("invalid api key");
    expect(calls.length).toBe(1);
  });

  test("422 is fatal on the first attempt and the error body is truncated", async () => {
    const long = "x".repeat(2_000);
    install([{ status: 422, rawBody: long }]);
    let caught: JudgmentHttpError | undefined;
    try {
      await liveClient().judge("s", QUESTIONS, { egressClass: "machine-state" });
    } catch (e) {
      caught = e as JudgmentHttpError;
    }
    expect(caught?.status).toBe(422);
    expect(calls.length).toBe(1);
    expect(caught?.bodyText.length).toBeLessThanOrEqual(513); // 512 + ellipsis
    expect(caught?.bodyText).toContain("…");
  });

  test("wire contract: POST to the pinned endpoint with Bearer auth and a JSON body", async () => {
    install([{ status: 200, body: liveBody() }]);
    await liveClient().judge("state text", QUESTIONS, { egressClass: "machine-state" });
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe("http://judgment.test/v1/systemone");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.get("Authorization")).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.headers.get("x-request-id")).toBe("rid-live");
    expect(calls[0]?.body).toEqual({
      model: TYPESAFE_MODEL,
      state: "state text",
      questions: QUESTIONS,
    });
  });

  test("strict response validation: missing usage, unknown key, or unasked answer all refuse", async () => {
    for (const bad of [
      liveBody({ usage: undefined }),
      liveBody({ extra: true }),
      liveBody({ answers: { never_asked: { type: "noul", noul: 1 } } }),
    ]) {
      install([{ status: 200, body: bad }]);
      let caught: JudgmentHttpError | undefined;
      try {
        await liveClient().judge("s", QUESTIONS, { egressClass: "machine-state" });
      } catch (e) {
        caught = e as JudgmentHttpError;
      }
      expect(caught?.status).toBe(502);
      expect(caught?.message).toContain("schema validation");
      expect(readdirSync(dir)).toEqual([]); // no envelope, no provenance entry
    }
  });

  test("state is redacted by the choke point before the request body is built", async () => {
    install([{ status: 200, body: liveBody() }]);
    await liveClient().judge("token sk-abc123DEF456ghi789 leaked", QUESTIONS, { egressClass: "machine-state" });
    expect(JSON.stringify(calls[0]?.body)).not.toContain("sk-abc123DEF456ghi789");
  });

  test("warnWhenStateCharsOver logs a house-shaped budget warning (documented, not enforced)", async () => {
    install([{ status: 200, body: liveBody() }]);
    const logs = captureLogs();
    const client = liveClient({ warnWhenStateCharsOver: 10 });
    await client.judge("s".repeat(100), QUESTIONS, { egressClass: "machine-state" });
    const warn = logs.find((e) => e.operation === "warnStateSize");
    expect(warn).toBeDefined();
    expect(JSON.stringify(warn)).toContain("64k");
    expect(JSON.stringify(warn)).toContain("not enforced");
  });
});

// ---------------------------------------------------------------------------
// Stage ceiling integration (AC-5): refusal happens before any request.
// ---------------------------------------------------------------------------

describe("stage ceiling integration", () => {
  test("judge refuses with CeilingExceededError once the stage crosses the ceiling", async () => {
    install([{ status: 200, body: liveBody() }]);
    const ceiling = new JudgmentCeiling(USAGE.input_tokens);
    const client = liveClient();
    await client.judge("s", QUESTIONS, { egressClass: "machine-state", ceiling });
    let caught: CeilingExceededError | undefined;
    try {
      await client.judge("s", QUESTIONS, { egressClass: "machine-state", ceiling });
    } catch (e) {
      caught = e as CeilingExceededError;
    }
    expect(caught).toBeInstanceOf(CeilingExceededError);
    expect(caught?.observed).toBe(USAGE.input_tokens);
    expect(calls.length).toBe(1); // the refused call never reached the wire
  });

  test("no ceiling passed — judge runs without admission (infrastructure tier, §3.2)", async () => {
    install([{ status: 200, body: liveBody() }]);
    // Distinct requestIds: provenance is keyed by requestId and a second call
    // under the same id carries a fresh created_at, which legitimately reads
    // as digest divergence (INV-J3) — that behavior is emit.test.ts's job.
    await liveClient({ requestId: "rid-c1" }).judge("s", QUESTIONS, { egressClass: "machine-state" });
    await liveClient({ requestId: "rid-c2" }).judge("s", QUESTIONS, { egressClass: "machine-state" });
    expect(calls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// INV-J1/J5: the key never leaks into an envelope, a provenance file or a log.
// ---------------------------------------------------------------------------

describe("key secrecy (INV-J1)", () => {
  test("key never appears in the envelope, the provenance file, or any log line", async () => {
    install([{ status: 200, body: liveBody() }]);
    const logs = captureLogs();
    const env = await liveClient().judge("s", QUESTIONS, { egressClass: "machine-state" });
    expect(JSON.stringify(env)).not.toContain(KEY);
    expect(readFileSync(join(dir, "rid-live.json"), "utf8")).not.toContain(KEY);
    expect(JSON.stringify(logs)).not.toContain(KEY);
    // The header is the ONLY place the key ever appears.
    expect(calls[0]?.headers.get("Authorization")).toBe(`Bearer ${KEY}`);
  });
});

// ---------------------------------------------------------------------------
// Constants pin (mirror of tests/gitnexus contract pinning).
// ---------------------------------------------------------------------------

describe("client constants", () => {
  test("pinned endpoint and model", () => {
    expect(TYPESAFE_API_URL).toBe("https://api.typesafe.ai/v1/systemone");
    expect(TYPESAFE_MODEL).toBe("jev-1.13.0");
  });
});
