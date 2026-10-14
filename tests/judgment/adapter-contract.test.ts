/**
 * Per-adapter contract suite (v6 J1 AC1, AC3, AC4) — ONE suite, parameterized
 * over the closed registry, so every registered transport runs the same
 * contract and the same seam path.
 *
 * Membership is the extension ritual: a new adapter in JUDGMENT_PROVIDERS
 * fails "every registered adapter has a suite harness" until it is given one
 * here, so no transport reaches the seam without this suite having run it.
 *
 * Injection discipline (story Technical Notes): there is no test-only
 * registry hook. A rogue LIVE body reaches the seam's strict parse only
 * through the registered `jev` transport against a stubbed `baseUrl` (the
 * client.test.ts fetch-stub idiom); MOCK divergence is caught by holding its
 * real canned bodies to the same contract live bodies must satisfy.
 *
 * Keyless and offline: the jev arms run against a `globalThis.fetch` stub,
 * the mock arms forbid fetch outright.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JudgmentCeiling, CeilingExceededError } from "../../src/judgment/ceiling.ts";
import { JudgmentClient, JudgmentHttpError, TYPESAFE_MODEL } from "../../src/judgment/client.ts";
import { EgressRefusedError } from "../../src/judgment/egress.ts";
import { EnvelopeSchema } from "../../src/judgment/envelope.ts";
import {
  JUDGMENT_PROVIDER_IDS,
  resolveProvider,
  type JudgmentProvider,
} from "../../src/judgment/provider.ts";
import { makeJudgmentResponseSchema, type JudgmentRequest, type Question } from "../../src/judgment/schemas.ts";
import { setLogSink, type LogEntry } from "../../src/lib/log.ts";
import contract from "./typesafe-api-contract.json";

const JUDGMENT_SRC = join(import.meta.dir, "..", "..", "src", "judgment");
const ADAPTERS_DIR = join(JUDGMENT_SRC, "adapters");
const KEY = "SECRETKEYVALUE123";
const BASE = "http://judgment.test";

// ---------------------------------------------------------------------------
// env + fetch hygiene (client.test.ts idiom)
// ---------------------------------------------------------------------------

const SAVED = { mock: process.env.TYPESAFE_MOCK, key: process.env.TYPESAFE_API_KEY };
type FetchImpl = typeof globalThis.fetch;
const originalFetch: FetchImpl = globalThis.fetch; // the original object, restored as-is

interface Recorded {
  url: string;
  headers: Headers;
  body: unknown;
}

let dir: string;
let calls: Recorded[] = [];
let logs: LogEntry[] = [];
let restoreLogs: (() => void) | undefined;

function restoreEnv(name: "TYPESAFE_MOCK" | "TYPESAFE_API_KEY", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

beforeEach(() => {
  restoreEnv("TYPESAFE_MOCK", undefined);
  restoreEnv("TYPESAFE_API_KEY", undefined);
  dir = mkdtempSync(join(tmpdir(), "jev-adapter-"));
  calls = [];
  logs = [];
  restoreLogs = setLogSink((e) => logs.push(e));
  forbidFetch();
});

afterEach(() => {
  restoreEnv("TYPESAFE_MOCK", SAVED.mock);
  restoreEnv("TYPESAFE_API_KEY", SAVED.key);
  globalThis.fetch = originalFetch;
  restoreLogs?.();
  rmSync(dir, { recursive: true, force: true });
});

function forbidFetch(): void {
  globalThis.fetch = (async () => {
    throw new Error("this arm MUST NOT reach fetch");
  }) as unknown as FetchImpl;
}

/** The fetch stub: every call answers `body` with HTTP 200 and is recorded. */
function serve(body: unknown): void {
  globalThis.fetch = (async (input: Parameters<FetchImpl>[0], init?: RequestInit): Promise<Response> => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as FetchImpl;
}

// ---------------------------------------------------------------------------
// The contract, as data: what EVERY adapter's raw body must satisfy.
// ---------------------------------------------------------------------------

const QUESTIONS: Record<string, Question> = {
  n: { type: "noul", instructions: "Is this a real defect?" },
  c: { type: "choice", instructions: "Disposition?", criteria: { patch: "fix it", dismiss: "not real" } },
  s: { type: "score", instructions: "Severity?", criteria: ["low", "mid", "high"] },
};

const REQUEST: JudgmentRequest = { model: TYPESAFE_MODEL, state: "gate verdict: FAIL", questions: QUESTIONS };

/** A contract-shaped live body for `questions`, built from the contract json — not from the mock. */
function contractBody(questions: Record<string, Question>): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "noul") answers[id] = { type: "noul", noul: 0.25 };
    else if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      answers[id] = { type: "choice", choice: keys[1], probabilities: { [keys[1]!]: 0.7 }, confidence: 0.6 };
    } else {
      answers[id] = { type: "score", score: q.criteria[1], legend: q.criteria, probabilities: { [q.criteria[1]!]: 0.5 }, confidence: 0.4 };
    }
  }
  return {
    model: contract.model,
    answers,
    usage: Object.fromEntries(contract.response.usageKeys.map((k, i) => [k, 100 + i])),
  };
}

/**
 * Every rule the contract json states about a response body. Returns the
 * violations (empty = conforms) so a failing case names what drifted.
 */
function contractViolations(body: unknown, questions: Record<string, Question>): string[] {
  const out: string[] = [];
  const parsed = makeJudgmentResponseSchema(Object.keys(questions)).safeParse(body);
  if (!parsed.success) out.push(`schema: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  if (body === null || typeof body !== "object") return [...out, "body is not an object"];
  const b = body as { model?: unknown; answers?: Record<string, { type?: string }>; usage?: Record<string, unknown> };
  const topKeys = Object.keys(b).sort();
  if (topKeys.join() !== [...contract.response.topLevelKeys].sort().join()) out.push(`top-level keys ${topKeys}`);
  if (b.model !== contract.model) out.push(`model ${JSON.stringify(b.model)} is not the contract's ${contract.model}`);
  const asked = new Set(Object.keys(questions));
  for (const id of Object.keys(b.answers ?? {})) if (!asked.has(id)) out.push(`answer to unasked id "${id}"`);
  const usageKeys = Object.keys(b.usage ?? {}).sort();
  if (usageKeys.join() !== [...contract.response.usageKeys].sort().join()) out.push(`usage keys ${usageKeys}`);
  for (const [id, a] of Object.entries(b.answers ?? {})) {
    const shape = contract.response.answerShapes[a?.type as keyof typeof contract.response.answerShapes];
    if (!shape) out.push(`answer "${id}" has unknown type ${JSON.stringify(a?.type)}`);
    else if (Object.keys(a).sort().join() !== [...shape.keys].sort().join()) out.push(`answer "${id}" keys ${Object.keys(a)}`);
  }
  if (b.answers?.n && typeof (b.answers.n as { noul?: unknown }).noul !== "number") out.push("noul answer is not a number");
  return out;
}

/** The drift cases the suite must catch for EVERY adapter (AC4 negative controls). */
const DIVERGENCES: Record<string, (body: Record<string, unknown>) => Record<string, unknown>> = {
  // The 2026-09-22 live-probe drift catch (commit c82ede44): noul as boolean.
  "boolean noul": (b) => ({ ...b, answers: { ...(b.answers as object), n: { type: "noul", noul: true } } }),
  "answer to an unasked id": (b) => ({ ...b, answers: { ...(b.answers as object), unasked: { type: "noul", noul: 1 } } }),
  "missing usage key": (b) => ({ ...b, usage: { input_tokens: 1 } }),
  "second model literal": (b) => ({ ...b, model: "jev-2.0.0" }),
};

// ---------------------------------------------------------------------------
// Per-adapter harness — the membership table.
// ---------------------------------------------------------------------------

interface Harness {
  /** The client mode whose seam resolves this adapter (INV-J5 order unchanged). */
  mode: "live" | "mock";
  /** Make the adapter exactly as the client does, from the registry. */
  make(): JudgmentProvider;
  /** Arrange the transport to answer contract-shaped; returns nothing. */
  arrange(questions: Record<string, Question>): void;
  /** Whether a rogue body can reach the seam through this adapter's legal path. */
  rogueInjectable: boolean;
}

const HARNESS: Record<string, Harness> = {
  jev: {
    mode: "live",
    make: () => resolveProvider("jev")({ apiKey: KEY, baseUrl: BASE, timeoutMs: 1_000, retryDelayMs: 0 }),
    arrange: (qs) => serve(contractBody(qs)),
    rogueInjectable: true,
  },
  mock: {
    mode: "mock",
    make: () => resolveProvider("mock")(),
    arrange: () => forbidFetch(),
    rogueInjectable: false,
  },
};

function clientFor(id: string, requestId: string): JudgmentClient {
  if (HARNESS[id]!.mode === "live") process.env.TYPESAFE_API_KEY = KEY;
  return new JudgmentClient({ mode: HARNESS[id]!.mode, baseUrl: BASE, retryDelayMs: 0, requestId, provenanceDir: dir });
}

test("every registered adapter has a suite harness (membership — a new adapter fails here until added)", () => {
  expect(Object.keys(HARNESS).sort()).toEqual([...JUDGMENT_PROVIDER_IDS].sort());
});

test("the contract checker itself catches every divergence (positive control on a known-good body)", () => {
  const good = contractBody(QUESTIONS);
  expect(contractViolations(good, QUESTIONS)).toEqual([]);
  for (const [name, diverge] of Object.entries(DIVERGENCES)) {
    expect({ name, violations: contractViolations(diverge(good), QUESTIONS).length > 0 }).toEqual({ name, violations: true });
  }
});

for (const id of JUDGMENT_PROVIDER_IDS) {
  describe(`adapter "${id}" — contract + seam path`, () => {
    // jev: proves the transport hands back the wire body unaltered (the body
    // is the stub's contract fixture); mock: proves its canned bodies conform.
    test("the raw body it hands the seam satisfies the contract json for every question type", async () => {
      const h = HARNESS[id]!;
      h.arrange(QUESTIONS);
      const body = await h.make().ask(REQUEST, "rid-raw");
      expect(contractViolations(body, QUESTIONS)).toEqual([]);
    });

    test("the request model is built through TYPESAFE_MODEL (the single pin)", async () => {
      const h = HARNESS[id]!;
      h.arrange(QUESTIONS);
      const body = (await h.make().ask(REQUEST, "rid-model")) as { model: string };
      expect(body.model).toBe(TYPESAFE_MODEL);
      // The live adapter puts the seam's request on the wire verbatim.
      if (id === "jev") {
        expect(calls.length).toBe(1);
        expect(calls[0]!.url).toBe(`${BASE}/v1/systemone`);
        expect(calls[0]!.body).toEqual(REQUEST);
        expect(calls[0]!.headers.get("x-request-id")).toBe("rid-model");
      }
    });

    test("judge() through the seam: envelope, one provenance file, one house log line naming the provider", async () => {
      HARNESS[id]!.arrange(QUESTIONS);
      const client = clientFor(id, `rid-seam-${id}`);
      expect(client.providerId).toBe(id);
      const env = await client.judge("gate verdict: FAIL", QUESTIONS, { egressClass: "finding-text" });
      expect(EnvelopeSchema.safeParse(env).success).toBe(true);
      expect(env.model).toBe(TYPESAFE_MODEL);
      expect(Object.keys(env.answers).sort()).toEqual(["c", "n", "s"]);
      expect(readdirSync(dir)).toEqual([`rid-seam-${id}.json`]);
      const judged = logs.filter((e) => e.operation === "judge");
      expect(judged.length).toBe(1);
      expect(judged[0]).toMatchObject({ status: "ok", provider: id, model: TYPESAFE_MODEL, egressClass: "finding-text" });
    });

    for (const [name, diverge] of Object.entries(DIVERGENCES)) {
      test(`divergence "${name}" fails the contract — and the seam refuses it with no envelope`, async () => {
        const h = HARNESS[id]!;
        h.arrange(QUESTIONS);
        // This adapter's REAL body, diverged — mock is held to the live contract.
        const real = (await h.make().ask(REQUEST, "rid-real")) as Record<string, unknown>;
        const rogue = diverge(real);
        expect(contractViolations(rogue, QUESTIONS).length).toBeGreaterThan(0);
        expect(makeJudgmentResponseSchema(Object.keys(QUESTIONS)).safeParse(rogue).success).toBe(false);

        if (!h.rogueInjectable) return;
        serve(rogue);
        let caught: unknown;
        let env: unknown;
        try {
          env = await clientFor(id, `rid-rogue-${id}`).judge("s", QUESTIONS, { egressClass: "machine-state" });
        } catch (e) {
          caught = e;
        }
        expect(env).toBeUndefined();
        expect(caught).toBeInstanceOf(JudgmentHttpError);
        expect((caught as JudgmentHttpError).status).toBe(502);
        expect(readdirSync(dir)).toEqual([]); // no side-channel file
        const judged = logs.filter((e) => e.operation === "judge");
        expect(judged[0]).toMatchObject({ status: "error", provider: id, error: { code: "http_502" } });
      });
    }

    // Ordering ahead of ask() is proven structurally for every adapter (the
    // "policy lives at the seam" block below); behaviourally, only jev's ask
    // is observable (a wire call), so the zero-calls assertion binds jev and
    // the shared assertions are the typed refusal, the log code, no envelope.
    test("the egress choke refuses typed with no envelope (jev: and with zero wire calls)", async () => {
      serve(contractBody(QUESTIONS)); // recording stub for BOTH arms: mock must not fetch either
      const client = clientFor(id, `rid-egress-${id}`);
      await expect(client.judge("s", QUESTIONS, { egressClass: "diff-hunk" })).rejects.toBeInstanceOf(EgressRefusedError);
      expect(calls.length).toBe(0);
      expect(readdirSync(dir)).toEqual([]);
      expect(logs.find((e) => e.operation === "judge")).toMatchObject({ status: "error", provider: id, error: { code: "egress_refused" } });
    });

    test("the stage ceiling refuses typed with no envelope (jev: and with zero wire calls)", async () => {
      serve(contractBody(QUESTIONS));
      const ceiling = new JudgmentCeiling(5);
      ceiling.record(5);
      const client = clientFor(id, `rid-ceiling-${id}`);
      await expect(client.judge("s", QUESTIONS, { egressClass: "machine-state", ceiling })).rejects.toBeInstanceOf(CeilingExceededError);
      expect(calls.length).toBe(0);
      expect(readdirSync(dir)).toEqual([]);
      expect(logs.find((e) => e.operation === "judge")).toMatchObject({ status: "error", provider: id, error: { code: "ceiling_exceeded" } });
    });
  });
}

// ---------------------------------------------------------------------------
// AC1 structural half — the policy lives at the seam, not per-adapter.
// ---------------------------------------------------------------------------

function importBindings(source: string): { spec: string; names: string }[] {
  return [...source.matchAll(/(?:^|\n)\s*(?:import|export)\b([^"';]*?)\bfrom\s*["']([^"']+)["']/g)].map((m) => ({
    names: m[1] ?? "",
    spec: m[2] ?? "",
  }));
}

describe("policy lives at the seam (AC1, structural)", () => {
  test("JudgmentProvider exposes exactly { id, ask } — no egress, ceiling, redaction or validation member", () => {
    const src = readFileSync(join(JUDGMENT_SRC, "provider.ts"), "utf8");
    const body = src.match(/export interface JudgmentProvider\s*\{([\s\S]*?)\n\}/)?.[1];
    expect(body).toBeDefined();
    const members = (body ?? "")
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")
      .split(/[;\n]/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.match(/^(?:readonly\s+)?([A-Za-z_$][\w$]*)/)?.[1] ?? l);
    expect(members).toEqual(["id", "ask"]);
  });

  test("adapters import no policy module and no validation symbol (negative control: own redaction/validation fails)", () => {
    const banned = /(^|\/)(egress|ceiling|emit|envelope|client)\.ts$/;
    const bannedNames = /\b(egress|redactForEgress|redactSecrets|makeJudgmentResponseSchema|\w+Schema|JudgmentCeiling|emitProvenance)\b/;
    const violations: string[] = [];
    const files = readdirSync(ADAPTERS_DIR).filter((f) => f.endsWith(".ts"));
    expect(files.sort()).toEqual(["jev.ts", "mock.ts"]);
    for (const file of files) {
      const src = readFileSync(join(ADAPTERS_DIR, file), "utf8");
      for (const { spec, names } of importBindings(src)) {
        if (banned.test(spec)) violations.push(`${file}: imports ${spec}`);
        const hit = names.match(bannedNames);
        if (hit) violations.push(`${file}: imports ${hit[1]} from ${spec}`);
      }
      if (/\.(safeParse|parse)\(/.test(src.replace(/JSON\.parse\(/g, ""))) violations.push(`${file}: runs its own schema parse`);
    }
    expect(violations).toEqual([]);
  });

  test("client.ts runs choke → ceiling admit → ask → strict parse → ceiling record → emit, ask exactly once", () => {
    const src = readFileSync(join(JUDGMENT_SRC, "client.ts"), "utf8");
    const judge = src.slice(src.indexOf("async judge("), src.indexOf("\n  }\n", src.indexOf("async judge(")));
    const order = ["egress(", "ceiling?.admit()", ".ask(", ".safeParse(", "ceiling?.record(", "emitProvenance("];
    const at = order.map((s) => judge.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(judge.split(".ask(").length - 1).toBe(1);
    // and the transport bodies left client.ts entirely
    expect(src).not.toMatch(/function mockResponse|private async post\(|httpRequest\(/);
  });
});

// ---------------------------------------------------------------------------
// jev transport retry posture — only 429/529 retry (contract json http block).
// ---------------------------------------------------------------------------

describe("jev adapter retry posture", () => {
  function sequence(statuses: number[]): void {
    let i = 0;
    globalThis.fetch = (async (input: Parameters<FetchImpl>[0], init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), headers: new Headers(init?.headers), body: undefined });
      const status = statuses[Math.min(i++, statuses.length - 1)]!;
      return new Response(JSON.stringify(status === 200 ? contractBody(QUESTIONS) : { message: "x" }), { status });
    }) as FetchImpl;
  }
  const jev = () => resolveProvider("jev")({ apiKey: KEY, baseUrl: BASE, timeoutMs: 1_000, retryDelayMs: 0 });

  for (const status of [400, 401, 403, 404, 422, 500, 502, 503]) {
    test(`HTTP ${status} is not retried — exactly one wire call`, async () => {
      sequence([status, 200]);
      await expect(jev().ask(REQUEST, "rid-noretry")).rejects.toMatchObject({ status });
      expect(calls.length).toBe(1);
    });
  }

  for (const status of contract.http.retryOnStatuses) {
    test(`HTTP ${status} retries once, then succeeds`, async () => {
      sequence([status, 200]);
      expect(contractViolations(await jev().ask(REQUEST, "rid-retry"), QUESTIONS)).toEqual([]);
      expect(calls.length).toBe(contract.http.maxAttempts);
    });
  }
});
