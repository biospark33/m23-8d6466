/**
 * J3 (AC5, contract I6 FINAL) — the harvest routing-decision retain leg's own
 * suite. Hermetic by construction: tmpdirs for cwd + records, env save/restore,
 * a recording client stub — NO network anywhere. The retained payload's
 * contract is the point: deterministic bytes (idempotent re-harvest via the
 * substrate's document_id upsert), and NEVER a volatile envelope field
 * (INV-J3/INV-JR-3 — answers, confidence, probabilities, latency, usage).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildRoutingRetainPayload,
  deriveRoutingContext,
  makeRoutingHook,
  retainRoutingDecisionsBestEffort,
  runRoutingWithWallCap,
} from "../../scripts/fleet.ts";
import type { RoutingDecisionInput } from "../../src/fleet/dispatch.ts";
import type { Brief } from "../../src/fleet/brief-schema.ts";
import { RoutingLogLineSchema, type JudgmentClient, type RoutingLogLine } from "../../src/judgment/index.ts";
import { ROSTER_MAX_BYTES } from "../../src/phase-engine/roster/schema.ts";
import { RunRecordStore } from "../../src/providers/index.ts";
import { resolveBankId } from "../../src/hindsight/schemas.ts";
import { setLogSink, type LogEntry } from "../../src/lib/log.ts";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Hermetic scaffolding
// ---------------------------------------------------------------------------

const RUN_A = "qds-20260101-aaaaaaaa";
const RUN_B = "qds-20260101-bbbbbbbb";
const REPO_SLUG = "org/repo";
const BANK_BASE = resolveBankId(REPO_SLUG);

const ENV_KEYS = ["HINDSIGHT_BASE_URL", "HINDSIGHT_BEARER_TOKEN", "HINDSIGHT_API_KEY"] as const;
let savedEnv: Record<string, string | undefined> = {};
let savedCwd = "";
let tmpDir = "";

/** One valid routing-log line, schema-parsed so a fixture can never drift. */
function makeLine(runId: string, overrides: Partial<RoutingLogLine> = {}): RoutingLogLine {
  return RoutingLogLineSchema.parse({
    workKey: "42",
    runId,
    shape: "solo-small",
    risk_tier: "low",
    applied_tier: "economy",
    score: {
      brief_path_mentions: 2,
      manifest_phase_count: 1,
      manifest_task_count: 1,
      prior_completion_rate: 0.5,
      prior_spend_micro_usd: 0,
      roster_role_count: 1,
    },
    jev_recommendation: "economy",
    jev_requestId: "jev-1",
    jev_skipped: null,
    created_at: new Date().toISOString(),
    ...overrides,
  });
}

/** Writes the routing log where the leg reads it: store-rooted — the SAME
 * derivation the dispatch hook uses (dirname(store.dir)), so the seeded file
 * IS the file a harvest of this store reads. */
function seedRoutingLog(lines: string[], storeDir = join(tmpDir, "runs")): void {
  mkdirSync(dirname(storeDir), { recursive: true });
  writeFileSync(join(dirname(storeDir), "routing-log.jsonl"), `${lines.join("\n")}\n`);
}

/** The recording client stub — every call captured, nothing leaves the test. */
function makeClient(opts: { banks?: unknown; failRetain?: boolean } = {}) {
  const calls: Array<{
    bankId: string;
    content: string;
    metadata?: Parameters<import("../../src/hindsight/client.ts").HindsightClient["retain"]>[2];
  }> = [];
  return {
    calls,
    listBanks: (): Promise<unknown> => Promise.resolve(opts.banks ?? {}),
    retain: (bankId: string, content: string, metadata?: Parameters<import("../../src/hindsight/client.ts").HindsightClient["retain"]>[2]): Promise<unknown> => {
      calls.push({ bankId, content, metadata });
      if (opts.failRetain) return Promise.reject(new Error("retain exploded"));
      return Promise.resolve({ ok: true });
    },
  };
}

/** A real store in a tmp dir, carrying the dispatch stamp + budget slug. */
function makeStore(dir: string, init: { requestId?: string; repoSlug?: string } = {}): RunRecordStore {
  const store = new RunRecordStore({ dir });
  store.create(RUN_A);
  store.set(RUN_A, {
    ...(init.requestId === undefined ? {} : { requestId: init.requestId }),
    ...(init.repoSlug === undefined ? {} : { extensions: { budget: { repoSlug: init.repoSlug } } }),
  });
  return store;
}

beforeEach(() => {
  savedCwd = process.cwd();
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmpDir = mkdtempSync(join(tmpdir(), "j3-retain-"));
  process.chdir(tmpDir);
  process.env.HINDSIGHT_BASE_URL = "http://127.0.0.1:1";
  process.env.HINDSIGHT_BEARER_TOKEN = "test-token";
  // biome-ignore lint/performance/noDelete: env deletion, not object property perf
  delete process.env.HINDSIGHT_API_KEY;
});

afterEach(() => {
  process.chdir(savedCwd);
  rmSync(tmpDir, { force: true, recursive: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Capture the house log around one await. */
async function withLogSink(body: () => Promise<void>): Promise<LogEntry[]> {
  const seen: LogEntry[] = [];
  const restore = setLogSink((entry) => seen.push(entry));
  try {
    await body();
  } finally {
    restore();
  }
  return seen;
}

// ---------------------------------------------------------------------------
// The payload: determinism + the volatile-field battery
// ---------------------------------------------------------------------------

describe("buildRoutingRetainPayload", () => {
  const decisions = [makeLine(RUN_A), makeLine(RUN_A, { jev_requestId: null, jev_recommendation: null, jev_skipped: { reason: "timeout" } })];
  const base = {
    runId: RUN_A,
    repoSlug: REPO_SLUG,
    requestId: "req-1",
    decisions,
    harvestedCount: 3,
  };

  test("same inputs replay byte-identically (idempotent re-harvest)", () => {
    const first = buildRoutingRetainPayload(base);
    const second = buildRoutingRetainPayload({
      ...base,
      decisions: [makeLine(RUN_A), makeLine(RUN_A, { jev_requestId: null, jev_recommendation: null, jev_skipped: { reason: "timeout" } })],
    });
    expect(second).toBe(first);
  });

  test("no volatile envelope field anywhere in the payload (INV-JR-3)", () => {
    const json = buildRoutingRetainPayload(base);
    for (const poison of ["confidence", "probabilities", "latency", "usage", "answers"]) {
      expect(json).not.toContain(poison);
    }
  });

  test("oversize is refused before any network call, never truncated", () => {
    const wide = makeLine(RUN_A);
    expect(() =>
      buildRoutingRetainPayload({ ...base, decisions: Array.from({ length: 400 }, () => wide) }),
    ).toThrow(/refused before any network call/);
  });
});

// ---------------------------------------------------------------------------
// The leg: filters, folds, idempotency, best-effort
// ---------------------------------------------------------------------------

describe("retainRoutingDecisionsBestEffort", () => {
  test("retains ONE -dev-meta document per run: only this run's lines, corrupt line skipped loudly-but-silently", async () => {
    seedRoutingLog([
      JSON.stringify(makeLine(RUN_A)),
      "not json {{{",
      JSON.stringify({ bogus: true }), // valid JSON, schema-refused: skipped
      JSON.stringify(makeLine(RUN_A, { jev_requestId: null, jev_recommendation: null, jev_skipped: { reason: "timeout" } })),
      JSON.stringify(makeLine(RUN_B)),
    ]);
    const store = makeStore(join(process.cwd(), "runs"), { requestId: "req-rec", repoSlug: REPO_SLUG });
    const client = makeClient({ banks: { banks: [{ bank_id: BANK_BASE }, { bank_id: `${BANK_BASE}-dev-meta` }] } });
    const receipts: unknown[] = [];
    const lines = await withLogSink(() =>
      retainRoutingDecisionsBestEffort({
        runId: RUN_A,
        requestId: "req-invocation",
        store,
        harvestedCount: 3,
        auditRecord: (link) => receipts.push(link),
        clientFactory: () => client,
      }),
    );
    expect(client.calls.length).toBe(1);
    const call = client.calls[0]!;
    expect(call.bankId).toBe(`${BANK_BASE}-dev-meta`);
    expect(call.metadata).toEqual({
      documentId: `routing-${RUN_A}-dev-meta`,
      updateMode: "replace",
      tags: ["factory-run", "routing-decision"],
      kind: "observation",
      source: "agent",
    });
    const payload = JSON.parse(call.content) as { decisions: unknown[]; outcomeLinkage: { harvested: number }; repoSlug: string; requestId: string; runId: string };
    expect(payload.decisions.length).toBe(2);
    expect(payload.outcomeLinkage).toEqual({ harvested: 3 });
    expect(payload.runId).toBe(RUN_A);
    expect(payload.requestId).toBe("req-rec"); // record-stamp-wins join key
    expect(payload.repoSlug).toBe(REPO_SLUG);
    expect(call.content).not.toContain(RUN_B);
    // The ok memory-retain line rode the landed retain.
    expect(lines.some((l) => l.operation === "memory-retain" && l.status === "ok" && l.documentId === `routing-${RUN_A}-dev-meta`)).toBe(true);
    // One receipt, digest-stable identity.
    expect(receipts.length).toBe(1);
  });

  test("unconfigured env: zero client calls, zero lines", async () => {
    // A genuine deletion, not `= undefined`: Bun stores the STRING "undefined"
    // (truthy), so the assignment read as CONFIGURED and the zero-call verdict
    // came from the empty-log silent return, never the env gate. The seeded
    // line + non-zero harvest make the gate itself the only thing standing
    // between this run and a retain.
    // biome-ignore lint/performance/noDelete: env deletion, not object property perf
    delete process.env.HINDSIGHT_BASE_URL;
    seedRoutingLog([JSON.stringify(makeLine(RUN_A))]);
    const store = makeStore(join(process.cwd(), "runs"), { requestId: "req-rec", repoSlug: REPO_SLUG });
    const client = makeClient();
    const lines = await withLogSink(() =>
      retainRoutingDecisionsBestEffort({
        runId: RUN_A,
        requestId: "req-invocation",
        store,
        harvestedCount: 3,
        auditRecord: () => {},
        clientFactory: () => client,
      }),
    );
    expect(client.calls.length).toBe(0);
    expect(lines.length).toBe(0);
  });

  test("banks not provisioned: ONE structured skip line, zero retains", async () => {
    seedRoutingLog([JSON.stringify(makeLine(RUN_A))]);
    const store = makeStore(join(process.cwd(), "runs"), { requestId: "req-rec", repoSlug: REPO_SLUG });
    const client = makeClient({ banks: { banks: [{ bank_id: "someone-else" }] } });
    const lines = await withLogSink(() =>
      retainRoutingDecisionsBestEffort({
        runId: RUN_A,
        requestId: "req-invocation",
        store,
        harvestedCount: 0,
        auditRecord: () => {},
        clientFactory: () => client,
      }),
    );
    expect(client.calls.length).toBe(0);
    const skips = lines.filter((l) => l.status === "error" && (l.error as { code: string } | undefined)?.code === "routing-retain-skipped");
    expect(skips.length).toBe(1);
  });

  test("retain throws: the function RESOLVES, one structured error line, harvest exit untouched by construction", async () => {
    seedRoutingLog([JSON.stringify(makeLine(RUN_A))]);
    const store = makeStore(join(process.cwd(), "runs"), { requestId: "req-rec", repoSlug: REPO_SLUG });
    const client = makeClient({ banks: { banks: [{ bank_id: BANK_BASE }, { bank_id: `${BANK_BASE}-dev-meta` }] }, failRetain: true });
    const lines = await withLogSink(() =>
      retainRoutingDecisionsBestEffort({
        runId: RUN_A,
        requestId: "req-invocation",
        store,
        harvestedCount: 0,
        auditRecord: () => {},
        clientFactory: () => client,
      }),
    );
    const failures = lines.filter((l) => (l.error as { code: string } | undefined)?.code === "routing-retain-failed");
    expect(failures.length).toBe(1);
  });

  test("no lines for this run (other runs only): silent return, zero client calls", async () => {
    seedRoutingLog([JSON.stringify(makeLine(RUN_B))]);
    const store = makeStore(join(process.cwd(), "runs"), { requestId: "req-rec", repoSlug: REPO_SLUG });
    const client = makeClient();
    const lines = await withLogSink(() =>
      retainRoutingDecisionsBestEffort({
        runId: RUN_A,
        requestId: "req-invocation",
        store,
        harvestedCount: 0,
        auditRecord: () => {},
        clientFactory: () => client,
      }),
    );
    expect(client.calls.length).toBe(0);
    expect(lines.length).toBe(0);
  });

  test("missing log file (no dispatches yet): silent return", async () => {
    const store = makeStore(join(process.cwd(), "runs"), { requestId: "req-rec", repoSlug: REPO_SLUG });
    const client = makeClient();
    const lines = await withLogSink(() =>
      retainRoutingDecisionsBestEffort({
        runId: RUN_A,
        requestId: "req-invocation",
        store,
        harvestedCount: 0,
        auditRecord: () => {},
        clientFactory: () => client,
      }),
    );
    expect(client.calls.length).toBe(0);
    expect(lines.length).toBe(0);
  });

  test("logDir roots the read beside the dispatch that wrote it (cwd split)", async () => {
    // The leg runs with logDir=tmp/log-root (the SANDBOX dir itself) while cwd holds NO log — only the
    // rooted copy carries this run's lines, so a landed retain proves the read
    // followed the option, not the cwd.
    mkdirSync(join("log-root", ".sandbox"), { recursive: true });
    writeFileSync(join("log-root", ".sandbox", "routing-log.jsonl"), `${JSON.stringify(makeLine(RUN_A))}\n`);
    const store = makeStore(join(process.cwd(), "runs"), { requestId: "req-rec", repoSlug: REPO_SLUG });
    const client = makeClient({ banks: { banks: [{ bank_id: BANK_BASE }, { bank_id: `${BANK_BASE}-dev-meta` }] } });
    await withLogSink(() =>
      retainRoutingDecisionsBestEffort({
        runId: RUN_A,
        requestId: "req-invocation",
        store,
        harvestedCount: 0,
        auditRecord: () => {},
        logDir: join(process.cwd(), "log-root", ".sandbox"),
        clientFactory: () => client,
      }),
    );
    expect(client.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// deriveRoutingContext: the contract-bearing feature vector's folds
// ---------------------------------------------------------------------------

/** A minimal roster the parse accepts — one role, prefixed model, writes []. */
const ROSTER_YAML = [
  "defaults:",
  "  provider: openrouter",
  "  writes: []",
  "roles:",
  "  - name: lead",
  "    model: anthropic/claude-haiku-4.5",
].join("\n");

function writeRoster(): string {
  const path = join(process.cwd(), "roster.yaml");
  writeFileSync(path, ROSTER_YAML);
  return path;
}

function noteSpy(): { notes: string[]; note: (s: string) => void } {
  const notes: string[] = [];
  return { notes, note: (s: string) => notes.push(s) };
}

/** Seeds real store records with host-controlled createdAt/closedAt/spend. */
function seedRecords(recs: Array<{ runId: string; createdAt: Date; closed?: boolean; repoSlug?: string; spendMicroUsd?: number }>): RunRecordStore {
  const store = new RunRecordStore({ dir: join(process.cwd(), "runs") });
  for (const r of recs) {
    store.create(r.runId, r.createdAt);
    store.set(r.runId, {
      extensions: { budget: { repoSlug: r.repoSlug ?? REPO_SLUG } },
      ...(r.spendMicroUsd === undefined ? {} : { spendMicroUsd: r.spendMicroUsd }),
    });
    if (r.closed) store.close(r.runId, r.createdAt);
  }
  return store;
}

/** Distinct valid run ids (the store's RUN_ID_RE enforces the shape). */
function recId(i: number): string {
  return `qds-20260101-r${String(i).padStart(7, "0")}`;
}

const BASE = new Date("2026-01-01T00:00:00Z").getTime();

describe("deriveRoutingContext", () => {
  test("roster re-parse failure: rosterRoles [], roster_role_count 0, ONE house line", () => {
    const { notes, note } = noteSpy();
    const store = new RunRecordStore({ dir: join(process.cwd(), "runs") });
    const ctx = deriveRoutingContext({
      manifest: { phases: [] },
      brief: {} as Brief,
      rosterPath: join(process.cwd(), "no-such-roster.yaml"),
      store,
      repoSlug: REPO_SLUG,
      note,
    });
    expect(ctx.rosterRoles).toEqual([]);
    expect(ctx.features.roster_role_count).toBe(0);
    expect(notes.some((n) => n.includes("routing-features-unavailable") && n.includes("roster re-parse failed"))).toBe(true);
  });

  test("prior filter: records of OTHER repoSlug never enter the rate", () => {
    const store = seedRecords([
      { runId: recId(1), createdAt: new Date(BASE + 1000), closed: true },
      { runId: recId(2), createdAt: new Date(BASE + 2000), closed: false },
      { runId: recId(3), createdAt: new Date(BASE + 3000), closed: true, repoSlug: "other/repo" },
      { runId: recId(4), createdAt: new Date(BASE + 4000), closed: true, repoSlug: "other/repo" },
    ]);
    const ctx = deriveRoutingContext({
      manifest: { phases: [] },
      brief: {} as Brief,
      rosterPath: writeRoster(),
      store,
      repoSlug: REPO_SLUG,
      note: () => {},
    });
    // Mine: 1 closed / 2 — the other repo's two closed records would read 3/4.
    expect(ctx.features.prior_completion_rate).toBe(0.5);
  });

  test("lookback cap: only the newest 20 records are priors (20 closed + 5 open reads 1.0)", () => {
    // The 5 OPEN records are the OLDEST — a working cap keeps only the 20
    // closed ones (rate 1.0); an unbounded sweep would read 20/25 = 0.8.
    const recs = [
      ...Array.from({ length: 5 }, (_, i) => ({ runId: recId(i + 1), createdAt: new Date(BASE + (i + 1) * 1000), closed: false })),
      ...Array.from({ length: 20 }, (_, i) => ({ runId: recId(i + 6), createdAt: new Date(BASE + (i + 6) * 1000), closed: true })),
    ];
    const store = seedRecords(recs);
    const ctx = deriveRoutingContext({
      manifest: { phases: [] },
      brief: {} as Brief,
      rosterPath: writeRoster(),
      store,
      repoSlug: REPO_SLUG,
      note: () => {},
    });
    expect(ctx.features.prior_completion_rate).toBe(1.0);
  });

  test("zero priors: the neutral 0.5 default", () => {
    const store = new RunRecordStore({ dir: join(process.cwd(), "runs") });
    const ctx = deriveRoutingContext({
      manifest: { phases: [] },
      brief: {} as Brief,
      rosterPath: writeRoster(),
      store,
      repoSlug: REPO_SLUG,
      note: () => {},
    });
    expect(ctx.features.prior_completion_rate).toBe(0.5);
  });

  test("over-ceiling roster: stat-refused UNREAD, roles [], ONE house line", () => {
    const { notes, note } = noteSpy();
    const path = join(process.cwd(), "big-roster.yaml");
    writeFileSync(path, "x".repeat(ROSTER_MAX_BYTES + 1));
    const ctx = deriveRoutingContext({
      manifest: { phases: [] },
      brief: {} as Brief,
      rosterPath: path,
      store: new RunRecordStore({ dir: join(process.cwd(), "runs") }),
      repoSlug: REPO_SLUG,
      note,
    });
    expect(ctx.rosterRoles).toEqual([]);
    expect(ctx.features.roster_role_count).toBe(0);
    expect(notes.some((n) => n.includes("routing-features-unavailable") && n.includes("refused unread"))).toBe(true);
  });

  test("brief_path_mentions: raw count over the WHOLE brief JSON (no char slice)", () => {
    const ctx = deriveRoutingContext({
      manifest: { phases: [] },
      brief: ["a/b", "c/d"] as unknown as Brief,
      rosterPath: writeRoster(),
      store: new RunRecordStore({ dir: join(process.cwd(), "runs") }),
      repoSlug: REPO_SLUG,
      note: () => {},
    });
    expect(ctx.features.brief_path_mentions).toBe(2);
  });

  test("prior_spend_micro_usd: two priors' spend sums (100 + 250 = 350)", () => {
    const store = seedRecords([
      { runId: recId(1), createdAt: new Date(BASE + 1000), spendMicroUsd: 100 },
      { runId: recId(2), createdAt: new Date(BASE + 2000), spendMicroUsd: 250 },
    ]);
    const ctx = deriveRoutingContext({
      manifest: { phases: [] },
      brief: {} as Brief,
      rosterPath: writeRoster(),
      store,
      repoSlug: REPO_SLUG,
      note: () => {},
    });
    expect(ctx.features.prior_spend_micro_usd).toBe(350);
  });

  test("non-finite spend: the prior counts as 0, the sum stays finite (no NaN poisoning)", () => {
    // The real store schema-rejects non-integers, so the NaN record shape can
    // only arrive from a drifted/foreign store — stubbed here for exactly that.
    const store = {
      dir: join(process.cwd(), "runs"),
      list: () => [
        {
          createdAt: new Date(BASE + 1000).toISOString(),
          extensions: { budget: { repoSlug: REPO_SLUG } },
          spendMicroUsd: Number.NaN,
        },
      ],
    } as unknown as RunRecordStore;
    const ctx = deriveRoutingContext({
      manifest: { phases: [] },
      brief: {} as Brief,
      rosterPath: writeRoster(),
      store,
      repoSlug: REPO_SLUG,
      note: () => {},
    });
    expect(ctx.features.prior_spend_micro_usd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// makeRoutingHook: the headless workKey fold + the catastrophic fold
// ---------------------------------------------------------------------------

function makeHookInput(rosterPath: string, overrides: Partial<RoutingDecisionInput> = {}): RoutingDecisionInput {
  return {
    requestId: "req-hook",
    runId: RUN_A,
    repoSlug: REPO_SLUG,
    issueId: null,
    brief: {} as Brief,
    manifest: { phases: [] },
    rosterPath,
    manifestBudgetMs: 600_000,
    now: () => Date.now(),
    ...overrides,
  };
}

/** Mock-mode judgment is forced for the ask; restored after. */
async function withMockJudgment(body: () => Promise<void>): Promise<void> {
  const saved = process.env.TYPESAFE_MOCK;
  process.env.TYPESAFE_MOCK = "1";
  try {
    await body();
  } finally {
    // biome-ignore lint/performance/noDelete: env deletion, not object property perf
    if (saved === undefined) delete process.env.TYPESAFE_MOCK;
    else process.env.TYPESAFE_MOCK = saved;
  }
}

function readLogLines(storeDir: string): unknown[] {
  return readFileSync(join(dirname(storeDir), "routing-log.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

describe("makeRoutingHook", () => {
  test("headless dispatch (issueId null): workKey is the minted runId, and the line survives its own schema", async () => {
    await withMockJudgment(async () => {
      await withLogSink(async () => {
        const hook = makeRoutingHook({
          store: new RunRecordStore({ dir: join(process.cwd(), "runs") }),
          note: () => {},
          routingOptions: { provenanceDir: join(process.cwd(), "provenance") },
        });
        const result = await hook(makeHookInput(writeRoster()));
        expect(result).toBeDefined();
        const raw = readLogLines(join(process.cwd(), "runs"));
        expect(raw.length).toBe(1);
        // The pre-fix fold wrote workKey "" — refused by workKey min(1), so
        // every headless line was one the reader (and the retain) silently
        // skipped. The runId is the honest unique identity for a headless run.
        expect((raw[0] as { workKey: string }).workKey).toBe(RUN_A);
        expect(RoutingLogLineSchema.safeParse(raw[0]).success).toBe(true);
      });
    });
  });

  test("catastrophic derivation fold (store.list() throws): the decision still lands on the zero vector", async () => {
    await withMockJudgment(async () => {
      const { notes, note } = noteSpy();
      const brokenStore = {
        dir: join(process.cwd(), "runs"), // the log root derives from it
        list: () => {
          throw new Error("store exploded");
        },
      } as unknown as RunRecordStore;
      await withLogSink(async () => {
        const hook = makeRoutingHook({
          store: brokenStore,
          note,
          routingOptions: { provenanceDir: join(process.cwd(), "provenance") },
        });
        const result = await hook(makeHookInput(writeRoster()));
        expect(Object.values(result.score)).toEqual([0, 0, 0, 0, 0, 0]);
      });
      expect(notes.some((n) => n.includes("routing feature derivation failed"))).toBe(true);
    });
  });

  test("routingOptions.logDir is honored, not clobbered by the store-derived root", async () => {
    await withMockJudgment(async () => {
      await withLogSink(async () => {
        const logRoot = join(process.cwd(), "alt-root", ".sandbox");
        mkdirSync(logRoot, { recursive: true });
        const hook = makeRoutingHook({
          store: new RunRecordStore({ dir: join(process.cwd(), "runs") }),
          note: () => {},
          routingOptions: { logDir: logRoot, provenanceDir: join(process.cwd(), "provenance") },
        });
        await hook(makeHookInput(writeRoster()));
        // The line landed under the override (logRoot IS the .sandbox dir)...
        expect(readFileSync(join(logRoot, "routing-log.jsonl"), "utf8").trim().split("\n").length).toBe(1);
        // ...and never under the store-derived default.
        expect(existsSync(join(process.cwd(), "routing-log.jsonl"))).toBe(false);
      });
    });
  });

  test("wall cap through the real hook: a hung seam ask loses the race, ONE skip note", async () => {
    const { notes, note } = noteSpy();
    const hungClient = { judge: (): Promise<never> => new Promise(() => {}) } as unknown as JudgmentClient;
    const hook = makeRoutingHook({
      store: new RunRecordStore({ dir: join(process.cwd(), "runs") }),
      note,
      routingOptions: {
        provenanceDir: join(process.cwd(), "provenance"),
        hookWallMs: 25,
        clientFactory: () => hungClient,
      },
    });
    await expect(hook(makeHookInput(writeRoster()))).rejects.toThrow("routing hook wall cap exceeded");
    expect(notes.length).toBe(1);
    const line = JSON.parse(notes[0]!) as { event?: string; reason?: string };
    expect(line.event).toBe("routing-skip");
    expect(line.reason).toBe("timeout");
  });
});

// ---------------------------------------------------------------------------
// runRoutingWithWallCap: the race itself (production composes it with runRouting
// inside makeRoutingHook; the suite pins it with a never-resolving ask)
// ---------------------------------------------------------------------------

describe("runRoutingWithWallCap", () => {
  test("a hung ask loses the race: throws past the fold, ONE guarded house line", async () => {
    const { notes, note } = noteSpy();
    await expect(
      runRoutingWithWallCap(
        () => new Promise<never>(() => {}),
        25,
        note,
      ),
    ).rejects.toThrow("routing hook wall cap exceeded");
    expect(notes.length).toBe(1);
    const line = JSON.parse(notes[0]!) as { event?: string; reason?: string; code?: string };
    expect(line.event).toBe("routing-skip");
    expect(line.reason).toBe("timeout");
    expect(line.code).toBe("routing-hook-timeout");
  });

  test("a fast ask is returned untouched", async () => {
    const out = await runRoutingWithWallCap(() => Promise.resolve({ ok: true as const }), 1000, () => {});
    expect(out).toEqual({ ok: true });
  });

  test("a SYNC-throwing ask lands the same guarded note before propagating", async () => {
    const { notes, note } = noteSpy();
    await expect(
      runRoutingWithWallCap(
        () => {
          throw new Error("sync boom");
        },
        1000,
        note,
      ),
    ).rejects.toThrow("sync boom");
    expect(notes.length).toBe(1);
    const line = JSON.parse(notes[0]!) as { event?: string; reason?: string; code?: string };
    expect(line.event).toBe("routing-skip");
    expect(line.reason).toBe("timeout");
    expect(line.code).toBe("routing-hook-timeout");
  });
});
