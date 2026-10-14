/**
 * J3 router suite — AC1 (one door = the barrel, recording-only, weights in
 * code), AC2 (the ask can never fail a dispatch + single-writer log), AC3
 * (re-derivable from the line alone). Every negative control is NAMED.
 *
 * House idioms (adapter-contract.test.ts): setLogSink capture, forbidFetch,
 * env save/restore, TYPESAFE_MOCK=1, tmp provenance in EVERY client. runRouting
 * builds its own client, so the suite injects both seams it owns: clientFactory
 * (tmp-provenance clients) and logDir (tmp .sandbox root).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  appliedTier,
  DEFAULT_PROVENANCE_DIR,
  EgressRefusedError,
  CeilingExceededError,
  FEATURE_CAPS,
  JudgmentClient,
  JudgmentConfigError,
  type JudgmentEnvelope,
  JudgmentHttpError,
  JudgmentSchemaError,
  pairForRole,
  readRoutingLog,
  riskTier,
  RoutingLogLineSchema,
  runRouting,
  scoreFeatures,
  SHAPE_BANDS,
  SHAPES,
  TIER_TABLE,
  WEIGHTS,
  type JudgmentClientOptions,
  type RoutingFeatures,
  type RoutingInput,
  type Shape,
  type SkipReason,
} from "../../src/judgment/index.ts";
import { FeatureVectorSchema, FEATURE_NAMES, RISK_LIFT_THRESHOLD, ROUTING_LOCK_ID } from "../../src/judgment/router.ts";
import { setLogSink, type LogEntry } from "../../src/lib/log.ts";

const ROUTER_PATH = join(import.meta.dir, "..", "..", "src", "judgment", "router.ts");
const JUDGMENT_DIR = join(import.meta.dir, "..", "..", "src", "judgment");
const SRC_DIR = join(import.meta.dir, "..", "..", "src");
const REPO_ROOT = join(import.meta.dir, "..", "..");
const KEY = "SECRETKEYVALUE123";

// ---------------------------------------------------------------------------
// env + fetch hygiene (adapter-contract.test.ts idiom)
// ---------------------------------------------------------------------------

const SAVED = { mock: process.env.TYPESAFE_MOCK, key: process.env.TYPESAFE_API_KEY };
type FetchImpl = typeof globalThis.fetch;
const originalFetch: FetchImpl = globalThis.fetch;

let dir: string;
let logs: LogEntry[];
let restoreLogs: (() => void) | undefined;

function restoreEnv(name: "TYPESAFE_MOCK" | "TYPESAFE_API_KEY", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  restoreEnv("TYPESAFE_MOCK", undefined);
  restoreEnv("TYPESAFE_API_KEY", undefined);
  process.env.TYPESAFE_MOCK = "1"; // INV-J5 default under test
  dir = mkdtempSync(join(tmpdir(), "j3-router-"));
  logs = [];
  restoreLogs = setLogSink((e) => logs.push(e));
  globalThis.fetch = (async () => {
    throw new Error("this suite MUST NOT reach fetch — mock only");
  }) as unknown as FetchImpl;
});

afterEach(() => {
  restoreEnv("TYPESAFE_MOCK", SAVED.mock);
  restoreEnv("TYPESAFE_API_KEY", SAVED.key);
  globalThis.fetch = originalFetch;
  restoreLogs?.();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function features(over: Partial<RoutingFeatures> = {}): RoutingFeatures {
  return {
    manifest_task_count: 1,
    manifest_phase_count: 1,
    roster_role_count: 1,
    brief_path_mentions: 2,
    prior_completion_rate: 1,
    prior_spend_micro_usd: 1_000_000,
    ...over,
  };
}

function routingInput(over: Partial<RoutingInput> = {}): RoutingInput {
  return { runId: "run-1", requestId: "req-1", repoSlug: "QDS-Factory", issueKey: "J3", features: features(), rosterRoles: ["builder"], ...over };
}

/** Test factory: a real seam client in mock mode, tmp provenance, stable Jev id. */
function mockFactory(requestId = "jev-rid-fixed"): () => JudgmentClient {
  return () => new JudgmentClient({ provenanceDir: dir, requestId } satisfies JudgmentClientOptions);
}

/** The degradation seam: a client whose ask throws exactly what the test plants. */
class ThrowingClient extends JudgmentClient {
  constructor(
    private readonly err: unknown,
    provenanceDir: string,
  ) {
    super({ provenanceDir });
  }
  override async judge(): Promise<JudgmentEnvelope> {
    throw this.err;
  }
}

function logPath(logDir: string): string {
  // logDir is the .sandbox DIR (store-rooted semantics, review round 1): the
  // file sits directly inside it.
  return join(logDir, "routing-log.jsonl");
}

function houseLines(event: string): LogEntry[] {
  return logs.filter((e) => e.event === event);
}

// ---------------------------------------------------------------------------
// Weights + features (AC1: code-owned; AC3: named derivations)
// ---------------------------------------------------------------------------

describe("weights + features are code-owned (AC1 negative control: env/config)", () => {
  test("WEIGHTS and FEATURE_CAPS cover exactly FEATURE_NAMES; weights sum to 1; caps are positive", () => {
    expect(Object.keys(WEIGHTS).sort()).toEqual([...FEATURE_NAMES].sort());
    expect(Object.keys(FEATURE_CAPS).sort()).toEqual([...FEATURE_NAMES].sort());
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    for (const cap of Object.values(FEATURE_CAPS)) expect(cap).toBeGreaterThan(0);
  });

  test("the log line's score block carries the FULL feature vector (AC3: no hidden component)", () => {
    expect(Object.keys(FeatureVectorSchema.shape).sort()).toEqual([...FEATURE_NAMES].sort());
  });

  test("negative control: router.ts reads NO env surface at all — weights from env MUST fail", () => {
    const src = readFileSync(ROUTER_PATH, "utf8");
    expect(src.length).toBeGreaterThan(0);
    expect(src).not.toMatch(/process\.env/);
  });

  test("scoreFeatures is pure + deterministic (same input ⇒ bit-identical), saturates at the cap, clamps negatives", () => {
    const f = features();
    expect(scoreFeatures(f)).toBe(scoreFeatures(f));
    expect(scoreFeatures({ ...f, manifest_task_count: 999 })).toBe(scoreFeatures({ ...f, manifest_task_count: 6 })); // cap saturation
    expect(scoreFeatures({ ...f, brief_path_mentions: -5 })).toBe(scoreFeatures({ ...f, brief_path_mentions: 0 })); // clamp
    expect(scoreFeatures({ ...f, prior_spend_micro_usd: 0 })).toBeLessThan(scoreFeatures(f));
  });
});

describe("score → shape → risk → applied tier (named projections)", () => {
  test("a quiet solo job (history-only): 0.16 → solo-small / low / economy", () => {
    // prior_completion_rate alone contributes WEIGHTS.prior_completion_rate × 1.
    const f = features({ manifest_task_count: 0, manifest_phase_count: 0, roster_role_count: 0, brief_path_mentions: 0, prior_spend_micro_usd: 0 });
    const s = scoreFeatures(f);
    expect(s).toBeCloseTo(0.16, 9);
    expect(band(s)).toBe("solo-small");
    expect(riskTier(s, f)).toBe("low");
    expect(appliedTier("solo-small")).toBe("economy");
  });

  test("the default fixture (one of everything): 0.2793 → solo-large / medium / standard", () => {
    const s = scoreFeatures(features());
    expect(s).toBeCloseTo(0.2793, 3);
    expect(band(s)).toBe("solo-large");
    expect(riskTier(s, features())).toBe("medium");
    expect(appliedTier("solo-large")).toBe("standard");
  });

  test("fully saturated complexity is a swarm: high / premium", () => {
    const f = features({ manifest_task_count: 6, manifest_phase_count: 4, roster_role_count: 8, brief_path_mentions: 20 });
    const s = scoreFeatures(f);
    expect(band(s)).toBe("swarm");
    expect(riskTier(s, f)).toBe("high");
    expect(appliedTier("swarm")).toBe("premium");
  });

  test("risk lift: sub-coin-flip completion raises ONE band at a fixed score, capped at high", () => {
    expect(riskTier(0.3, features({ prior_completion_rate: 0.9 }))).toBe("medium");
    expect(riskTier(0.3, features({ prior_completion_rate: 0.3 }))).toBe("high"); // low → medium → the lift
    expect(riskTier(0.7, features({ prior_completion_rate: 0.3 }))).toBe("high"); // already high
  });

  test("the lift threshold is a named constant, strict at exactly 0.5 (no-history default lifts nothing)", () => {
    expect(RISK_LIFT_THRESHOLD).toBe(0.5);
    expect(riskTier(0.16, features({ prior_completion_rate: 0.5 }))).toBe("low"); // exactly at — no lift
    expect(riskTier(0.16, features({ prior_completion_rate: 0.499 }))).toBe("medium"); // just under — lift
  });

  test("SHAPES is the closed shape set; every shape maps to a tier with the proven-live pair", () => {
    expect([...SHAPES].sort()).toEqual(["solo-large", "solo-small", "swarm"]);
    expect(TIER_TABLE.economy).toEqual({ provider: "openrouter", model: "deepseek/deepseek-v3.2" });
    expect(TIER_TABLE.standard).toEqual({ provider: "openrouter", model: "anthropic/claude-haiku-4.5" });
    expect(TIER_TABLE.premium).toEqual({ provider: "openrouter", model: "anthropic/claude-sonnet-4.6" });
    expect(pairForRole("standard")).toBe(TIER_TABLE.standard); // per-role resolver = the tier's pair
  });
});

function band(score: number): Shape {
  return (SHAPE_BANDS.find(([cut]) => score <= cut) ?? SHAPE_BANDS[SHAPE_BANDS.length - 1]!)[1];
}

// ---------------------------------------------------------------------------
// runRouting — the happy path (success ⇒ envelope + requestId, AC1(d))
// ---------------------------------------------------------------------------

describe("runRouting success path (mock default, one ask, one line)", () => {
  test("deterministic tier, recorded recommendation, requestId on the line + provenance envelope on disk", async () => {
    const result = await runRouting(routingInput(), { clientFactory: mockFactory(), logDir: dir });

    expect(result.applied_tier).toBe("standard");
    expect(result.appliedPairs).toEqual({ builder: TIER_TABLE.standard });
    // mock answers the FIRST criteria key ("economy") — recorded beside a
    // standard pick, never applied
    expect(result.recommendation).toBe("economy");
    expect(result.jev_requestId).toBe("jev-rid-fixed");
    expect(result.jev_skipped).toBeNull();

    const lines = readRoutingLog(logPath(dir));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({ runId: "run-1", workKey: "J3", applied_tier: "standard", jev_requestId: "jev-rid-fixed", jev_skipped: null });
    // The writer ALWAYS stamps the line schema version (forward-compat for M3.2's reader).
    expect(lines[0]?.schema_version).toBe(1);

    // AC1(d): a successful ask owes its provenance envelope under the logged id
    expect(existsSync(join(dir, "jev-rid-fixed.json"))).toBe(true);

    const decision = houseLines("routing-decision");
    expect(decision.length).toBe(1);
    expect(decision[0]).toMatchObject({ requestId: "jev-rid-fixed", operation: "judge", status: "ok", runId: "run-1", applied_tier: "standard" });
    expect(typeof decision[0]?.jev_ask_ms).toBe("number"); // present on a decision — and a number, not 0-by-convention
  });

  test("determinism: the same input twice ⇒ identical shape/risk/tier/score", async () => {
    const a = await runRouting(routingInput(), { clientFactory: mockFactory(), logDir: dir });
    const b = await runRouting(routingInput(), { clientFactory: mockFactory(), logDir: dir });
    expect(JSON.stringify({ s: a.score, shape: a.shape, r: a.risk_tier, t: a.applied_tier })).toBe(
      JSON.stringify({ s: b.score, shape: b.shape, r: b.risk_tier, t: b.applied_tier }),
    );
  });
});

// ---------------------------------------------------------------------------
// AC3 — re-derivation from the line alone
// ---------------------------------------------------------------------------

describe("AC3: the pick is re-derivable from the logged line", () => {
  const FIXTURES: [string, RoutingFeatures][] = [
    ["floor", features({ manifest_task_count: 0, manifest_phase_count: 0, roster_role_count: 0, brief_path_mentions: 0, prior_spend_micro_usd: 0 })],
    ["small", features()],
    ["mid", features({ manifest_task_count: 4, roster_role_count: 3, brief_path_mentions: 10, prior_completion_rate: 0.4 })],
    ["heavy", features({ manifest_task_count: 6, manifest_phase_count: 4, roster_role_count: 8, brief_path_mentions: 20, prior_completion_rate: 0.3, prior_spend_micro_usd: 60_000_000 })],
  ];

  for (const [name, f] of FIXTURES) {
    test(`fixture "${name}": logged components + in-code weights reproduce shape, risk_tier, applied_tier`, async () => {
      const result = await runRouting(routingInput({ features: f, runId: `run-${name}` }), { clientFactory: mockFactory(), logDir: dir });
      const [line] = readRoutingLog(logPath(dir));
      expect(line?.runId).toBe(`run-${name}`);

      // Re-derive ONLY from the line's score components + the in-code projections.
      const s = scoreFeatures(line!.score);
      const shape = band(s);
      expect(line!.shape).toBe(shape);
      expect(line!.risk_tier).toBe(riskTier(s, line!.score));
      expect(line!.applied_tier).toBe(appliedTier(shape));
      expect(result.applied_tier).toBe(line!.applied_tier);
    });
  }

  test("sanity: the fixtures actually straddle the bands (solo-small AND swarm both appear)", () => {
    expect(band(scoreFeatures(FIXTURES[0]![1]))).toBe("solo-small");
    expect(band(scoreFeatures(FIXTURES[3]![1]))).toBe("swarm");
    expect(appliedTier("swarm")).toBe("premium");
  });
});

// ---------------------------------------------------------------------------
// AC1 — recording-only (LOCKED #5): the applied path consumes no Jev numeric
// ---------------------------------------------------------------------------

describe("recording-only (AC1): a different recommendation never moves the applied tier", () => {
  test("mock answers 'economy' while the computed tier is standard — the pick stays standard", async () => {
    // solo-large ⇒ standard; the mock's canned choice is the FIRST key, "economy".
    const f = features({ manifest_task_count: 3, manifest_phase_count: 2, roster_role_count: 2, brief_path_mentions: 6 });
    const result = await runRouting(routingInput({ features: f }), { clientFactory: mockFactory(), logDir: dir });
    expect(band(scoreFeatures(f))).toBe("solo-large");
    expect(result.applied_tier).toBe("standard");
    expect(result.appliedPairs).toEqual({ builder: TIER_TABLE.standard });
    expect(result.recommendation).toBe("economy"); // recorded beside it, never applied
    expect(result.jev_requestId).toBe("jev-rid-fixed");
  });

  test("negative control: the applied-tier code region reads NO answer field, and the module touches no Jev numeric", () => {
    const src = readFileSync(ROUTER_PATH, "utf8");
    // The applied projections are pure arithmetic — no envelope, no answer tokens.
    const region = (start: string) => src.slice(src.indexOf(start), src.indexOf("\n}", src.indexOf(start)));
    for (const fn of ["export function scoreFeatures", "export function riskTier", "export function appliedTier"]) {
      const body = region(fn);
      expect(body.length).toBeGreaterThan(0); // not vacuous
      expect(body).not.toMatch(/envelope|answers|\.choice/);
    }
    // The ONLY answer read in the whole module is the recommendation string + the id.
    expect(src.match(/answers\.[A-Za-z_]+/g) ?? []).toEqual(["answers.tier_recommendation"]);
    expect(src.match(/\.choice\b/g) ?? []).toHaveLength(1);
    // No Jev numeric reaches this module, in code or in comments.
    expect(src).not.toMatch(/confidence|probabilities/);
  });
});

// ---------------------------------------------------------------------------
// AC1 — the seam fence (grep-level, with TEETH)
// ---------------------------------------------------------------------------

describe("seam fence (AC1): the barrel is the only judgment door", () => {
  function allSpecs(src: string): string[] {
    return [
      ...src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^"'`]*?\bfrom\s*["']([^"'`]+)["']/g),
      ...src.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g),
      ...src.matchAll(/\bimport\s*\(\s*["'`]([^"'`]+)["'`]/g),
      ...src.matchAll(/\brequire\s*\(\s*["'`]([^"'`]+)["'`]/g),
    ].map((m) => m[1] ?? "");
  }
  // Every specifier edge that resolves INSIDE src/judgment.
  const judgmentSpecs = (src: string): string[] =>
    allSpecs(src).filter((s) => s.startsWith(".") && resolve(dirname(ROUTER_PATH), s).startsWith(`${JUDGMENT_DIR}/`));
  // Every edge that reaches src/ OUTSIDE src/judgment (the repo-internal fence).
  const repoEdgeSpecs = (src: string): string[] =>
    allSpecs(src).filter((s) => {
      if (!s.startsWith(".")) return false;
      const target = resolve(dirname(ROUTER_PATH), s);
      return !target.startsWith(`${JUDGMENT_DIR}/`) && target.startsWith(`${SRC_DIR}/`);
    });

  test("the fence is not vacuous: the real module was read and its barrel import found", () => {
    const src = readFileSync(ROUTER_PATH, "utf8");
    expect(src.length).toBeGreaterThan(0);
    expect(allSpecs(src).length).toBeGreaterThanOrEqual(5);
    expect(judgmentSpecs(src)).toContain("./index.ts");
  });

  test("the ONE judgment import is the barrel — never client.ts, never an adapter, never the provider registry", () => {
    const src = readFileSync(ROUTER_PATH, "utf8");
    expect(judgmentSpecs(src)).toEqual(["./index.ts"]);
    expect(repoEdgeSpecs(src)).toEqual(["../lib/file-lock.ts", "../lib/log.ts"]);
  });

  test("the fence has TEETH: every banned judgment specifier violates in all four edge forms", () => {
    const banned = ["./client.ts", "./adapters/jev.ts", "./adapters/mock.ts", "./provider.ts", "./schemas.ts", "./emit.ts"];
    for (const spec of banned) {
      expect(judgmentSpecs(`import { JudgmentClient } from "${spec}";\n`)).toContain(spec);
      expect(judgmentSpecs(`export { JudgmentClient } from "${spec}";\n`)).toContain(spec);
      expect(judgmentSpecs(`const c = await import("${spec}");\n`)).toContain(spec);
      expect(judgmentSpecs(`const c = require("${spec}");\n`)).toContain(spec);
    }
    // Repo reach beyond the sanctioned lib pair violates too.
    for (const spec of ["../providers/run-record.ts", "../hindsight/client.ts", "../audit/link-store.ts"]) {
      expect(repoEdgeSpecs(`import { x } from "${spec}";\n`)).toContain(spec);
    }
  });

  test("no direct .ask( call outside the seam client (AC1 negative control)", () => {
    const src = readFileSync(ROUTER_PATH, "utf8");
    expect(src.includes(".ask(")).toBe(false);
  });

  test("the seam door is USED: the module invokes the barrel client's .judge( method (AC1 letter)", () => {
    const src = readFileSync(ROUTER_PATH, "utf8");
    expect((src.match(/\.judge\(/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// AC2 — degradation battery: the ask can never fail a dispatch
// ---------------------------------------------------------------------------

describe("degradation battery (AC2): every ask failure folds to the deterministic tier", () => {
  const CASES: readonly [string, unknown, SkipReason][] = [
    ["408 — the jev adapter's own budget", new JudgmentHttpError(408, "timed out", "rid", ""), "timeout"],
    ["504 — upstream gateway timeout", new JudgmentHttpError(504, "gateway", "rid", ""), "timeout"],
    ["503 — vendor down", new JudgmentHttpError(503, "down", "rid", ""), "vendor-error"],
    ["schema refusal — contract drift", new JudgmentSchemaError("bad body", "rid", ""), "vendor-error"],
    ["stage ceiling exceeded", new CeilingExceededError(1, 1), "ceiling-exceeded"],
    ["egress refused", new EgressRefusedError("refused", "ac-prose"), "egress-refused"],
    ["config refusal (live mode, no key)", new JudgmentConfigError("live mode requires a key"), "provider-unavailable"],
    ["anything unexpected", new Error("boom"), "provider-unavailable"],
  ];

  for (const [name, err, reason] of CASES) {
    test(`${name} ⇒ jev_skipped ${reason}, deterministic tier, exactly one strict line`, async () => {
      const result = await runRouting(routingInput(), {
        clientFactory: () => new ThrowingClient(err, dir),
        logDir: dir,
      });

      // The dispatch-grade half: the deterministic pick survives untouched.
      expect(result.applied_tier).toBe("standard");
      expect(result.appliedPairs).toEqual({ builder: TIER_TABLE.standard });
      expect(result.jev_skipped).toEqual({ reason });
      expect(result.recommendation).toBeNull();
      expect(result.jev_requestId).toBeNull();

      // The log never lies: exactly one line, strict-parseable.
      const lines = readRoutingLog(logPath(dir));
      expect(lines.length).toBe(1);
      expect(lines[0]).toMatchObject({ applied_tier: "standard", jev_recommendation: null, jev_requestId: null, jev_skipped: { reason } });

      // House skip line: ok-status, fresh requestId (never a Jev id), jev_ask_ms ABSENT — not 0.
      const skips = houseLines("routing-skip");
      expect(skips.length).toBe(1);
      expect(skips[0]).toMatchObject({ status: "ok", operation: "judge", runId: "run-1", reason });
      expect(skips[0]?.requestId).not.toBe("jev-rid-fixed");
      expect("jev_ask_ms" in skips[0]!).toBe(false);
      expect(houseLines("routing-decision")).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// AC2 — the log never interleaves or drops a line
// ---------------------------------------------------------------------------

describe("log integrity (AC2): single-writer posture", () => {
  test("two parallel runRoutings ⇒ exactly two strict-parseable lines, no interleave", async () => {
    await Promise.all([
      runRouting(routingInput({ runId: "run-a" }), { clientFactory: mockFactory(), logDir: dir }),
      runRouting(routingInput({ runId: "run-b" }), { clientFactory: mockFactory(), logDir: dir }),
    ]);
    const lines = readRoutingLog(logPath(dir));
    expect(lines.length).toBe(2);
    expect(lines.map((l) => l.runId).sort()).toEqual(["run-a", "run-b"]);
    for (const line of lines) expect(RoutingLogLineSchema.safeParse(line).success).toBe(true);
  });

  test("negative control: a held lock loses the line LOUDLY and never appends without it", async () => {
    // logDir is the .sandbox dir itself now (store-rooted semantics): the
    // lock file sits directly inside it.
    const lockPath = join(dir, `${ROUTING_LOCK_ID}.lock`);
    mkdirLock(lockPath); // held by THIS live process, fresh mtime — never stale
    try {
      const result = await runRouting(routingInput(), { clientFactory: mockFactory(), logDir: dir, lockTimeoutMs: 80 });
      // The decision rode the roster regardless.
      expect(result.applied_tier).toBe("standard");
      // The line was NOT written — and no unlocked append ever happened.
      expect(existsSync(logPath(dir))).toBe(false);
      const loss = logs.filter((e) => e.error?.code === "routing-log-lock-timeout");
      expect(loss.length).toBe(1);
    } finally {
      rmSync(lockPath, { force: true });
    }
  });

  test("write-side guard: a line the reader would refuse is NEVER appended (checked before the lock)", async () => {
    // Empty issueKey ⇒ workKey "" ⇒ workKey.min(1) refuses — the only public
    // input combination that reaches the guard today.
    const result = await runRouting(routingInput({ issueKey: "" }), { clientFactory: mockFactory(), logDir: dir });

    // Nothing on disk — the guard ran BEFORE the append, not after a bad write.
    expect(existsSync(logPath(dir))).toBe(false);
    const refusals = logs.filter((e) => e.error?.code === "routing-line-schema-refused");
    expect(refusals.length).toBe(1);
    expect(refusals[0]?.error?.message).toContain("workKey");
    // The decision itself still returned (AC2: the guard folds, never throws).
    expect(result.applied_tier).toBe("standard");
  });
});

/** A live-pid lock file that no staleness check may steal. */
function mkdirLock(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${process.pid}:held-by-test`);
}

// ---------------------------------------------------------------------------
// INV-JR-5 — mock default, no key material anywhere
// ---------------------------------------------------------------------------

describe("key discipline (INV-JR-5): mock is the default, the key never leaks", () => {
  test("runRouting succeeds with NO clientFactory and a junk key in env; no key material in any line or log", async () => {
    process.env.TYPESAFE_API_KEY = KEY; // present but UNUSED by mock mode (INV-J1)
    const reqId = `req-nokey-${Math.random().toString(36).slice(2)}`;
    const result = await runRouting(routingInput({ requestId: reqId }), { logDir: dir }); // default factory — the production path

    expect(result.jev_requestId).toBe(reqId);
    expect(result.jev_skipped).toBeNull();
    expect(result.recommendation).toBe("economy");
    // Provenance went to the seam's production default (repo-relative), then we clean it up.
    const provFile = join(REPO_ROOT, DEFAULT_PROVENANCE_DIR, `${reqId}.json`);
    expect(existsSync(provFile)).toBe(true);
    rmSync(provFile, { force: true });

    const blob = JSON.stringify(readRoutingLog(logPath(dir))) + JSON.stringify(logs);
    expect(blob).not.toContain(KEY);
    expect(blob).not.toMatch(/TYPESAFE_API_KEY/);
  });
});

// ---------------------------------------------------------------------------
// The log schema (zod strict + the exactly-one-of invariant)
// ---------------------------------------------------------------------------

describe("RoutingLogLineSchema (strict, exactly-one-of)", () => {
  const VALID = {
    workKey: "J3",
    runId: "run-x",
    shape: "solo-small",
    risk_tier: "low",
    applied_tier: "economy",
    score: {
      manifest_task_count: 1,
      manifest_phase_count: 1,
      roster_role_count: 1,
      brief_path_mentions: 1,
      prior_completion_rate: 1,
      prior_spend_micro_usd: 1,
    },
    jev_recommendation: "economy",
    jev_requestId: "jev-1",
    jev_skipped: null,
    created_at: new Date().toISOString(),
  };

  test("a well-formed line parses; unknown keys refuse (strict)", () => {
    expect(RoutingLogLineSchema.safeParse(VALID).success).toBe(true);
    expect(RoutingLogLineSchema.safeParse({ ...VALID, extra: 1 }).success).toBe(false);
    expect(RoutingLogLineSchema.safeParse({ ...VALID, score: { ...VALID.score, nope: 1 } }).success).toBe(false);
  });

  test("negative controls: BOTH jev_requestId and jev_skipped refuse; NEITHER refuses", () => {
    expect(RoutingLogLineSchema.safeParse({ ...VALID, jev_skipped: { reason: "timeout" } }).success).toBe(false);
    expect(RoutingLogLineSchema.safeParse({ ...VALID, jev_requestId: null }).success).toBe(false);
  });

  test("schema_version is OPTIONAL (backward arm: pre-version lines still parse) but bounded when present", () => {
    // VALID carries no schema_version — the append-only log's older lines must stay readable.
    expect(RoutingLogLineSchema.safeParse(VALID).success).toBe(true);
    expect(RoutingLogLineSchema.safeParse({ ...VALID, schema_version: 1 }).success).toBe(true);
    expect(RoutingLogLineSchema.safeParse({ ...VALID, schema_version: 0 }).success).toBe(false);
    expect(RoutingLogLineSchema.safeParse({ ...VALID, schema_version: 16 }).success).toBe(false);
    expect(RoutingLogLineSchema.safeParse({ ...VALID, schema_version: 1.5 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readRoutingLog — strict reader, loud skips, never throws
// ---------------------------------------------------------------------------

describe("readRoutingLog", () => {
  const line = (runId: string) =>
    JSON.stringify({
      workKey: "J3",
      runId,
      shape: "solo-small",
      risk_tier: "low",
      applied_tier: "economy",
      score: { manifest_task_count: 1, manifest_phase_count: 1, roster_role_count: 1, brief_path_mentions: 1, prior_completion_rate: 1, prior_spend_micro_usd: 1 },
      jev_recommendation: null,
      jev_requestId: "jev-1",
      jev_skipped: null,
      created_at: new Date().toISOString(),
    });

  test("a missing file reads as [] (M3.2/A5 must tolerate the log's absence)", () => {
    expect(readRoutingLog(join(dir, "nowhere.jsonl"))).toEqual([]);
  });

  test("one corrupt line among good ones: good lines returned, error logged, no throw", () => {
    const path = join(dir, "mixed.jsonl");
    appendFileSync(path, `${[line("a"), "{not json", line("b"), JSON.stringify({ totally: "wrong shape" })].join("\n")}\n`);

    const out = readRoutingLog(path);
    expect(out.map((l) => l.runId)).toEqual(["a", "b"]);
    const corrupt = logs.filter((e) => e.error?.code === "routing-log-corrupt-line");
    expect(corrupt.length).toBe(2); // the unparseable line AND the wrong-shape line
  });

  test("the corrupt-line echo is SCRUBBED: key material is redacted and control chars are JSON-escaped", () => {
    const path = join(dir, "leaky.jsonl");
    appendFileSync(path, `{broken "authorization: Bearer sk-123"}\n`);

    const out = readRoutingLog(path);
    expect(out).toEqual([]);
    const corrupt = logs.filter((e) => e.error?.code === "routing-log-corrupt-line");
    expect(corrupt.length).toBe(1);
    const message = corrupt[0]?.error?.message ?? "";
    expect(message).not.toContain("sk-123");
    expect(message).toContain("Bearer=[redacted]");
  });

  test("runId filter is byte-level BEFORE the parse: other runs' lines never reach zod (their corruption stays silent)", () => {
    const path = join(dir, "filtered.jsonl");
    // A corrupt line that would trip the strict reader if parsed — filtered
    // out on raw bytes instead, so it emits no house error.
    appendFileSync(path, `${[line("a"), `{broken "runId":"b"}`, line("a")].join("\n")}\n`);

    const out = readRoutingLog(path, { runId: "a" });
    expect(out.map((l) => l.runId)).toEqual(["a", "a"]);
    expect(logs.filter((e) => e.error?.code === "routing-log-corrupt-line")).toEqual([]);
  });

  test("maxLines keeps the LAST parsed lines (append-only log: the tail is the newest; the head is dropped)", () => {
    const path = join(dir, "capped.jsonl");
    appendFileSync(path, `${[line("1"), line("2"), line("3")].join("\n")}\n`);

    expect(readRoutingLog(path, { maxLines: 2 }).map((l) => l.runId)).toEqual(["2", "3"]);
    expect(readRoutingLog(path, { maxLines: 0 })).toEqual([]);
    // The unfiltered spelling is unchanged (optional param, existing callers compile).
    expect(readRoutingLog(path).map((l) => l.runId)).toEqual(["1", "2", "3"]);
  });

  test("a file over the 8 MiB byte ceiling reads as [] with a loud house error (never loaded)", () => {
    const path = join(dir, "huge.jsonl");
    writeFileSync(path, "x".repeat(8 * 1024 * 1024 + 1));

    expect(readRoutingLog(path)).toEqual([]);
    const oversize = logs.filter((e) => e.error?.code === "routing-log-oversize");
    expect(oversize.length).toBe(1);
    expect(oversize[0]?.error?.message).toContain("ROUTING_LOG_MAX_BYTES");
  });
});
