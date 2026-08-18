/**
 * Issue-correlation tests (Story DF1.8) — TDD RED phase.
 *
 * Acceptance tests for the locked DF1.8 contract:
 * resolveRunCorrelation validation table (INVALID_REPO_SLUG /
 * INVALID_ISSUE_ID / INVALID_REQUEST_ID), purity (no fs/db I/O),
 * MIGRATIONS/schema drift onto pre-DF1.8 stores (incl. hand-built
 * legacy fixture), initiateSession idempotency + RequestIdRepoMismatch
 * refusal + fill-once UPDATE on bare DF1.4 rows (INV-RUN-1/2),
 * cross-repo issue isolation via readRunsByIssue, chain-integrity over
 * all seven tables (with a negative control that MUST fail a plausible
 * wrong impl), appendDispatchFailure log hygiene (0600/0700, no prompt
 * content), and the offline dispatch_task correlation integration
 * through the _injectRunner seam.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// RED: issue-correlation.ts does not exist yet — this import is the first failure.
import {
  REPO_SLUG_PATTERN,
  UUID_V4_PATTERN,
  MAX_ISSUE_ID,
  CorrelationError,
  RequestIdRepoMismatchError,
  resolveRunCorrelation,
  appendDispatchFailure,
} from "../../src/phase-engine/issue-correlation.ts";
import {
  SCHEMA_DDL,
  applyMigrations,
} from "../../src/phase-engine/trace/schema.ts";
import { Tracer } from "../../src/phase-engine/trace/tracer.ts";
import { openTraceReader } from "../../src/phase-engine/trace/reader.ts";
import {
  dispatchTask,
  _injectRunner,
} from "../../src/phase-engine/phases/dispatch-task.ts";
import { runTeamManifest, type TeamRunOptions } from "../../cli-anything/src/runner.ts";
import { parseTeamEventLine } from "../../cli-anything/src/team-events.ts";
import type { MergedOutput } from "../../cli-anything/src/types.ts";
import type { PhaseSpec } from "../../src/phase-engine/types.ts";
import type { PhaseBodyContext } from "../../src/phase-engine/phase.ts";
import type { ValidateDeps } from "../../src/phase-engine/roster/validate.ts";

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "df1-8-correlation-")));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const FIXTURE_ROSTER = path.join(import.meta.dir, "fixtures", "dispatch-roster.yaml");

// Fixed strict-v4 UUIDs (deterministic — never minted in assertions).
const REQ_ID_A = "5e5a3c8e-1f2b-4c3d-9a8e-70c1f2d3e4f5";
const REQ_ID_B = "6f6b4d9f-2a3c-4d4e-8b9f-81d2e3f4a5b6";
const REQ_ID_UPPER = "5E5A3C8E-1F2B-4C3D-9A8E-70C1F2D3E4F5";

// ---------------------------------------------------------------------------
// Helpers (factored per file conventions)
// ---------------------------------------------------------------------------

/** Correlation fixture: valid pair, optional requestId/issueUrl overrides. */
function corr(over: {
  requestId?: string;
  repoSlug?: string;
  issueId?: number;
  issueUrl?: string;
} = {}) {
  return resolveRunCorrelation({
    repoSlug: over.repoSlug ?? "qds/demo",
    issueId: over.issueId ?? 42,
    ...(over.issueUrl !== undefined ? { issueUrl: over.issueUrl } : {}),
    ...(over.requestId !== undefined ? { requestId: over.requestId } : {}),
  });
}

/** Assert fn() throws a CorrelationError with exactly the expected code. */
function expectCorrelationError(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(CorrelationError);
  const err = caught as CorrelationError;
  expect(err.code).toBe(code);
}

/** Fresh marker root per test + its run-data dir, with QDS_RUN_ROOT set. */
function mkRun(): { markerRoot: string; dataDir: string; dbPath: string } {
  const markerRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(tmpRoot, "marker-")),
  );
  const dataDir = path.join(markerRoot, "run-data");
  process.env.QDS_RUN_ROOT = markerRoot;
  return { markerRoot, dataDir, dbPath: path.join(dataDir, "trace.db") };
}

/** Readonly connection for post-hoc SQL assertions. */
function openRo(dbPath: string): Database {
  return new Database(dbPath, { readonly: true });
}

/** Column names of a table (typed row generics — no `as any`). */
function columnsOf(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
}

/** Rows in `table` whose request_id is NULL or differs from `requestId`. */
function brokenChainCount(db: Database, table: string, requestId: string): number {
  return db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE request_id IS NULL OR request_id <> ?`,
    )
    .get(requestId)!.n;
}

/** Offline dual-gate probes + rate tables (zero pi spawns) — DF1.6 pattern. */
const offlineGate: ValidateDeps = {
  probeCatalog: async () => ({
    ok: true,
    pairs: new Set(["anthropic/claude-haiku-4-5"]),
    durationMs: 0,
  }),
  probeProvider: async () => ({
    ok: true,
    ids: new Set(["claude-haiku-4-5"]),
    durationMs: 0,
  }),
  rateSources: {
    bundled: {
      unit: "usd-per-mtok",
      entries: new Map([["anthropic/claude-haiku-4-5", { input: 1, output: 5 }]]),
    },
    custom: { unit: "usd-per-mtok", entries: new Map() },
  },
};

/** Minimal dispatch_task PhaseSpec (fixture roster, DF1.6 pattern). */
function dispatchSpec(): PhaseSpec {
  return {
    name: "dispatch",
    kind: "dispatch_task",
    description: "test dispatch phase",
    maxDurationMs: 60000,
    retries: 0,
    roster: FIXTURE_ROSTER,
    task: "fix the seeded failing test",
  };
}

function dispatchCtx(): PhaseBodyContext {
  return {
    signal: new AbortController().signal,
    phaseId: "phase-1",
    params: dispatchSpec(),
    ctx: { runId: "run-test", pipelineId: "pipeline-test", requestId: "req-test" },
  };
}

function successResult(over: Partial<MergedOutput> = {}): MergedOutput {
  return {
    exitStatus: "success",
    partial: false,
    result: { summary: "done" },
    agentOutputs: {},
    changedFiles: [],
    comsLog: [],
    durationMs: 100,
    waivers: [],
    error: null,
    summary: "done",
    mulchPrimed: false,
    mulchPrimeError: null,
    artifacts: [],
    ...over,
  } as MergedOutput;
}

/** Snapshot/restore env exactly (undefined → delete, per DF1.6 conventions). */
let savedRunRoot: string | undefined;
let savedTeamRunner: string | undefined;
let savedAnthropicKey: string | undefined;
let savedOpenrouterKey: string | undefined;

beforeEach(() => {
  savedRunRoot = process.env.QDS_RUN_ROOT;
  savedTeamRunner = process.env.QDS_TEAM_RUNNER;
  savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
  savedOpenrouterKey = process.env.OPENROUTER_API_KEY;
});

afterEach(() => {
  // CRITICAL: a leaked injected runner makes later tests spawn the REAL
  // team-lead-driver. Always restore.
  _injectRunner(runTeamManifest);
  // biome-ignore lint/performance/noDelete: delete is the only way to unset an env var
  if (savedRunRoot === undefined) delete process.env.QDS_RUN_ROOT;
  else process.env.QDS_RUN_ROOT = savedRunRoot;
  // biome-ignore lint/performance/noDelete: delete is the only way to unset an env var
  if (savedTeamRunner === undefined) delete process.env.QDS_TEAM_RUNNER;
  else process.env.QDS_TEAM_RUNNER = savedTeamRunner;
  // biome-ignore lint/performance/noDelete: delete is the only way to unset an env var
  if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
  // biome-ignore lint/performance/noDelete: delete is the only way to unset an env var
  if (savedOpenrouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedOpenrouterKey;
});

// ---------------------------------------------------------------------------
// 1. resolveRunCorrelation validation table
// ---------------------------------------------------------------------------

describe("resolveRunCorrelation validation", () => {
  test("valid slug + issue + url passes through, boundary issueId accepted", () => {
    const url = "https://github.com/qds/demo/issues/42";
    const r = corr({ issueUrl: url, requestId: REQ_ID_A });
    expect(r).toEqual({
      requestId: REQ_ID_A,
      repoSlug: "qds/demo",
      issueId: 42,
      issueUrl: url,
    });
    // Upper bound is inclusive (<= MAX_ISSUE_ID).
    expect(corr({ issueId: MAX_ISSUE_ID, requestId: REQ_ID_B }).issueId).toBe(
      2 ** 31 - 1,
    );
  });

  test("absent issueUrl resolves to null; absent requestId is generated as v4", () => {
    const r = corr();
    expect(r.issueUrl).toBeNull();
    expect(r.repoSlug).toBe("qds/demo");
    expect(r.issueId).toBe(42);
    expect(r.requestId).not.toBe("");
    expect(UUID_V4_PATTERN.test(r.requestId)).toBe(true);
    // Generated ids are distinct across calls (not a constant).
    expect(corr().requestId).not.toBe(r.requestId);
  });

  test("requestId honoured when strict UUID v4, lowercase and uppercase", () => {
    expect(corr({ requestId: REQ_ID_A }).requestId).toBe(REQ_ID_A);
    expect(corr({ requestId: REQ_ID_UPPER }).requestId).toBe(REQ_ID_UPPER);
  });

  test("rejects invalid repoSlug with INVALID_REPO_SLUG", () => {
    const invalid = [
      "",                                    // empty
      "   ",                                 // whitespace-only
      "qdsdemo",                             // no slash
      "a/b/c",                               // 3 segments
      `${"a".repeat(101)}/demo`,             // >100-char segment
      "qds/de mo",                           // bad char (space)
      "qds/demo!",                           // bad char (punctuation)
    ];
    for (const repoSlug of invalid) {
      expectCorrelationError(() => corr({ repoSlug }), "INVALID_REPO_SLUG");
    }
    // Sanity: the pattern itself agrees with the table's canonical cases.
    expect(REPO_SLUG_PATTERN.test("qds/demo")).toBe(true);
    expect(REPO_SLUG_PATTERN.test("a/b/c")).toBe(false);
  });

  test("rejects invalid issueId with INVALID_ISSUE_ID", () => {
    for (const issueId of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      expectCorrelationError(() => corr({ issueId }), "INVALID_ISSUE_ID");
    }
  });

  test("rejects non-v4 requestId with INVALID_REQUEST_ID", () => {
    const invalid = [
      "5e5a3c8e-1f2b-1c3d-9a8e-70c1f2d3e4f5", // v1-style (version nibble 1)
      "5e5a3c8e-1f2b-4c3d-9a8e-70c1f2d3e4zz", // non-hex characters
      "5e5a3c8e-1f2b-4c3d-7a8e-70c1f2d3e4f5", // wrong variant nibble (7)
      "",                                     // empty string
    ];
    for (const requestId of invalid) {
      expectCorrelationError(() => corr({ requestId }), "INVALID_REQUEST_ID");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Purity — no fs/db I/O
// ---------------------------------------------------------------------------

describe("resolveRunCorrelation purity", () => {
  test("valid and invalid calls alike create no files (cheap smoke)", () => {
    const cwd = fs.realpathSync(
      fs.mkdtempSync(path.join(tmpRoot, "pure-cwd-")),
    );
    const prevCwd = process.cwd();
    process.chdir(cwd);
    try {
      const r = corr({ requestId: REQ_ID_A });
      expect(r.requestId).toBe(REQ_ID_A);
      expectCorrelationError(() => corr({ repoSlug: "" }), "INVALID_REPO_SLUG");
      expectCorrelationError(() => corr({ issueId: 0 }), "INVALID_ISSUE_ID");
      expectCorrelationError(
        () => corr({ requestId: "nope" }),
        "INVALID_REQUEST_ID",
      );
    } finally {
      process.chdir(prevCwd);
    }
    expect(fs.readdirSync(cwd)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. MIGRATIONS fixtures
// ---------------------------------------------------------------------------

describe("DF1.8 migrations and schema", () => {
  test("Tracer-applied store carries the new sessions columns and unique index; re-open is a no-op", () => {
    const { dbPath } = mkRun();
    const first = new Tracer({ dataDir: path.dirname(dbPath), requestId: "legacy-req-1", pipelineName: "p" });
    first.startSession({ requestId: "legacy-req-1", request: "pre-DF1.8 row" });
    first.close();

    // Re-open on the same dir — re-apply must be an idempotent no-op.
    const second = new Tracer({ dataDir: path.dirname(dbPath), requestId: "legacy-req-1", pipelineName: "p" });
    second.close();

    const db = openRo(dbPath);
    const cols = columnsOf(db, "sessions");
    for (const col of ["repo_slug", "issue_id", "issue_url"]) {
      expect(cols).toContain(col);
    }
    // Existing row preserved by the re-apply.
    const row = db
      .query<{ request: string }, [string]>(
        "SELECT request FROM sessions WHERE request_id = ?",
      )
      .get("legacy-req-1");
    expect(row?.request).toBe("pre-DF1.8 row");
    // The AC2 backing index exists.
    const idx = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
      )
      .get("idx_sessions_repo_request");
    expect(idx?.name).toBe("idx_sessions_repo_request");
    db.close();
  });

  test("hand-built legacy fixture (no new columns): applyMigrations adds columns, row intact", () => {
    const dbPath = path.join(
      fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, "legacy-"))),
      "legacy.db",
    );
    const db = new Database(dbPath);
    for (const ddl of SCHEMA_DDL) db.exec(ddl);
    db.prepare(
      "INSERT INTO sessions (request_id, request, status, started_at) VALUES (?, ?, ?, ?)",
    ).run("legacy-req-2", "legacy row", "running", "2026-08-18T00:00:00.000Z");

    // Pre-DF1.8 store: none of the correlation columns exist yet.
    const before = columnsOf(db, "sessions");
    for (const col of ["repo_slug", "issue_id", "issue_url"]) {
      expect(before).not.toContain(col);
    }

    expect(() => applyMigrations(db)).not.toThrow();

    const after = columnsOf(db, "sessions");
    for (const col of ["repo_slug", "issue_id", "issue_url"]) {
      expect(after).toContain(col);
    }
    const row = db
      .query<{ request: string }, [string]>(
        "SELECT request FROM sessions WHERE request_id = ?",
      )
      .get("legacy-req-2");
    expect(row?.request).toBe("legacy row");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 4. initiateSession
// ---------------------------------------------------------------------------

describe("initiateSession", () => {
  test("fresh insert: replayed false, runId === requestId, columns persisted", () => {
    const { dbPath } = mkRun();
    const tracer = new Tracer({ dataDir: path.dirname(dbPath), requestId: REQ_ID_A, pipelineName: "p" });
    const r = tracer.initiateSession({
      correlation: corr({ requestId: REQ_ID_A }),
      request: "fix the bug",
    });
    expect(r).toEqual({ requestId: REQ_ID_A, runId: REQ_ID_A, replayed: false });
    tracer.close();

    const db = openRo(dbPath);
    const row = db
      .query<{ repo_slug: string; issue_id: number; issue_url: string | null }, [string]>(
        "SELECT repo_slug, issue_id, issue_url FROM sessions WHERE request_id = ?",
      )
      .get(REQ_ID_A);
    expect(row?.repo_slug).toBe("qds/demo");
    expect(row?.issue_id).toBe(42);
    expect(row?.issue_url).toBeNull();
    db.close();
  });

  test("replay of same (repoSlug, requestId): replayed true, exactly one row", () => {
    const { dbPath } = mkRun();
    const tracer = new Tracer({ dataDir: path.dirname(dbPath), requestId: REQ_ID_A, pipelineName: "p" });
    tracer.initiateSession({ correlation: corr({ requestId: REQ_ID_A }), request: "r1" });
    const replay = tracer.initiateSession({
      correlation: corr({ requestId: REQ_ID_A }),
      request: "r1-again",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.runId).toBe(REQ_ID_A);
    tracer.close();

    const db = openRo(dbPath);
    const { n } = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sessions WHERE request_id = ?")
      .get(REQ_ID_A)!;
    expect(n).toBe(1);
    db.close();
  });

  test("replay AFTER finishSession (completed run): one row, replayed true (INV-RUN-1 outlives completion)", () => {
    const { dbPath } = mkRun();
    const tracer = new Tracer({ dataDir: path.dirname(dbPath), requestId: REQ_ID_A, pipelineName: "p" });
    tracer.initiateSession({ correlation: corr({ requestId: REQ_ID_A }), request: "r1" });
    tracer.finishSession({ requestId: REQ_ID_A, status: "success", durationMs: 100 });
    const replay = tracer.initiateSession({
      correlation: corr({ requestId: REQ_ID_A }),
      request: "r1-after-completion",
    });
    expect(replay.replayed).toBe(true);
    tracer.close();

    const db = openRo(dbPath);
    const row = db
      .query<{ n: number; status: string }, [string]>(
        "SELECT COUNT(*) AS n, MAX(status) AS status FROM sessions WHERE request_id = ?",
      )
      .get(REQ_ID_A);
    expect(row?.n).toBe(1);
    expect(row?.status).toBe("success");
    db.close();
  });

  test("same requestId + different repoSlug: RequestIdRepoMismatchError, no second row, repo_slug unchanged", () => {
    const { dbPath } = mkRun();
    const tracer = new Tracer({ dataDir: path.dirname(dbPath), requestId: REQ_ID_A, pipelineName: "p" });
    tracer.initiateSession({ correlation: corr({ requestId: REQ_ID_A }), request: "r1" });

    let caught: unknown;
    try {
      tracer.initiateSession({
        correlation: corr({ requestId: REQ_ID_A, repoSlug: "qds/other" }),
        request: "r2",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RequestIdRepoMismatchError);
    const err = caught as RequestIdRepoMismatchError;
    expect(err.code).toBe("REQUEST_ID_REPO_MISMATCH");
    // Message names BOTH slugs.
    expect(err.message).toContain("qds/demo");
    expect(err.message).toContain("qds/other");
    expect(err.existingRepoSlug).toBe("qds/demo");
    expect(err.attemptedRepoSlug).toBe("qds/other");
    tracer.close();

    const db = openRo(dbPath);
    const row = db
      .query<{ n: number; repo_slug: string }, [string]>(
        "SELECT COUNT(*) AS n, MIN(repo_slug) AS repo_slug FROM sessions WHERE request_id = ?",
      )
      .get(REQ_ID_A);
    expect(row?.n).toBe(1);
    expect(row?.repo_slug).toBe("qds/demo");
    db.close();
  });

  test("same requestId + same repoSlug + DIFFERENT issueId: RequestIdRepoMismatchError (full-pair compare), no re-point", () => {
    const { dbPath } = mkRun();
    const tracer = new Tracer({ dataDir: path.dirname(dbPath), requestId: REQ_ID_A, pipelineName: "p" });
    tracer.initiateSession({ correlation: corr({ requestId: REQ_ID_A }), request: "r1" });

    let caught: unknown;
    try {
      tracer.initiateSession({
        correlation: corr({ requestId: REQ_ID_A, issueId: 43 }),
        request: "r2",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RequestIdRepoMismatchError);
    const err = caught as RequestIdRepoMismatchError;
    expect(err.code).toBe("REQUEST_ID_REPO_MISMATCH");
    // Message names BOTH slugs AND BOTH issue ids.
    expect(err.message).toContain("qds/demo");
    expect(err.message).toContain("42");
    expect(err.message).toContain("43");
    expect(err.existingRepoSlug).toBe("qds/demo");
    expect(err.attemptedRepoSlug).toBe("qds/demo");
    expect(err.existingIssueId).toBe(42);
    expect(err.attemptedIssueId).toBe(43);
    tracer.close();

    const db = openRo(dbPath);
    const row = db
      .query<{ n: number; issue_id: number }, [string]>(
        "SELECT COUNT(*) AS n, MIN(issue_id) AS issue_id FROM sessions WHERE request_id = ?",
      )
      .get(REQ_ID_A);
    expect(row?.n).toBe(1);
    expect(row?.issue_id).toBe(42);
    db.close();
  });

  test("bare DF1.4 row (startSession, no correlation): fill-once UPDATE, replayed true, reader-visible", () => {
    const { dbPath } = mkRun();
    const tracer = new Tracer({ dataDir: path.dirname(dbPath), requestId: REQ_ID_B, pipelineName: "p" });
    tracer.startSession({ requestId: REQ_ID_B, request: "bare DF1.4 run" });

    const r = tracer.initiateSession({
      correlation: corr({ requestId: REQ_ID_B, issueUrl: "https://github.com/qds/demo/issues/42" }),
      request: "bare DF1.4 run",
    });
    expect(r.replayed).toBe(true);
    expect(r.runId).toBe(REQ_ID_B);
    tracer.close();

    const db = openRo(dbPath);
    const row = db
      .query<{ repo_slug: string; issue_id: number; issue_url: string }, [string]>(
        "SELECT repo_slug, issue_id, issue_url FROM sessions WHERE request_id = ?",
      )
      .get(REQ_ID_B);
    expect(row?.repo_slug).toBe("qds/demo");
    expect(row?.issue_id).toBe(42);
    expect(row?.issue_url).toBe("https://github.com/qds/demo/issues/42");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 5. Cross-repo issue isolation
// ---------------------------------------------------------------------------

describe("readRunsByIssue cross-repo isolation", () => {
  test("issue #42 in two repos: only the matching repo's run is returned", () => {
    const { dbPath } = mkRun();
    const tracer = new Tracer({ dataDir: path.dirname(dbPath), requestId: REQ_ID_A, pipelineName: "p" });
    tracer.initiateSession({ correlation: corr({ requestId: REQ_ID_A }), request: "demo run" });
    tracer.initiateSession({
      correlation: corr({ requestId: REQ_ID_B, repoSlug: "qds/other" }),
      request: "other run",
    });
    tracer.close();

    const reader = openTraceReader(dbPath);
    const page = reader.readRunsByIssue("qds/demo", 42);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.request_id).toBe(REQ_ID_A);
    expect(page.rows[0]?.repo_slug).toBe("qds/demo");
    expect(page.rows[0]?.issue_id).toBe(42);
    reader.close();
  });
});

// ---------------------------------------------------------------------------
// 6. Chain integrity across all seven tables
// ---------------------------------------------------------------------------

describe("chain integrity: one requestId across all seven tables", () => {
  const SEVEN_TABLES = [
    "sessions",
    "phases",
    "events",
    "envelopes",
    "gate_results",
    "processes",
    "agent_sessions",
  ] as const;

  test("correlated run: zero rows with NULL or foreign request_id in every table", () => {
    const { dbPath } = mkRun();
    const dataDir = path.dirname(dbPath);
    const tracer = new Tracer({ dataDir, requestId: REQ_ID_A, pipelineName: "p" });
    tracer.initiateSession({ correlation: corr({ requestId: REQ_ID_A }), request: "chain run" });
    tracer.upsertPhase({
      requestId: REQ_ID_A, phaseId: "phase-1", seq: 1, name: "dispatch",
      kind: "dispatch_task", status: "running", attempt: 1, retries: 0,
      startedAt: "2026-08-18T00:00:00.000Z",
    });
    tracer.upsertPhase({
      requestId: REQ_ID_A, phaseId: "phase-2", seq: 2, name: "verify",
      kind: "dispatch_task", status: "success", attempt: 1, retries: 0,
      startedAt: "2026-08-18T00:00:01.000Z", endedAt: "2026-08-18T00:00:02.000Z",
    });
    tracer.trace({ requestId: REQ_ID_A, phaseId: "phase-1", type: "log", name: "e1", payloadJson: "{}" });
    tracer.trace({ requestId: REQ_ID_A, phaseId: "phase-2", type: "log", name: "e2", payloadJson: "{}" });
    tracer.recordEnvelope({
      requestId: REQ_ID_A, phaseId: "phase-1", agent: "lead",
      outputType: "merged", payloadJson: "{}", valid: true, attempt: 1,
    });
    tracer.recordEnvelope({
      requestId: REQ_ID_A, phaseId: "phase-2", agent: "worker",
      outputType: "merged", payloadJson: "{}", valid: true, attempt: 1,
    });
    tracer.recordGateResult({
      requestId: REQ_ID_A, phaseId: "phase-1", attempt: 1, gate: "output_exists",
      passed: true, violations: [], checks: [],
    });
    tracer.recordProcess({ requestId: REQ_ID_A, kind: "agent", pid: 4242, command: "pi" });
    tracer.close();

    // agent_sessions has no Tracer method yet — write it bound, same request.
    const rw = new Database(dbPath);
    rw.prepare("INSERT INTO agent_sessions (request_id, agent) VALUES (?, ?)").run(
      REQ_ID_A,
      "lead",
    );
    rw.close();

    const ro = openRo(dbPath);
    for (const table of SEVEN_TABLES) {
      expect(brokenChainCount(ro, table, REQ_ID_A)).toBe(0);
    }

    // NEGATIVE CONTROL: mint a fresh id in ONE phase write — the same check
    // must catch it (a plausible wrong impl passes the loop above vacuously).
    const rw2 = new Database(dbPath);
    const foreign = randomUUID();
    rw2.prepare(
      `INSERT INTO phases (phase_id, request_id, seq, name, kind, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(`phase-foreign-${foreign}`, foreign, 3, "foreign", "dispatch_task", "2026-08-18T00:00:03.000Z");
    rw2.close();
    expect(brokenChainCount(ro, "phases", REQ_ID_A)).toBeGreaterThan(0);
    ro.close();
  });
});

// ---------------------------------------------------------------------------
// 7. appendDispatchFailure
// ---------------------------------------------------------------------------

describe("appendDispatchFailure", () => {
  test("JSON line with timestamp + pair + code + message; 0600 file, 0700 parent, no prompt content", () => {
    const logPath = path.join(tmpRoot, "nested", "dirs", "dispatch-failures.log");
    expect(fs.existsSync(path.dirname(logPath))).toBe(false);

    appendDispatchFailure(logPath, {
      repoSlug: "qds/demo",
      issueId: 42,
      requestId: REQ_ID_A,
      code: "INVALID_ISSUE_ID",
      message: "issueId must be a positive integer",
    });
    appendDispatchFailure(logPath, {
      repoSlug: "qds/demo",
      issueId: 42,
      requestId: null,
      code: "REQUEST_ID_REPO_MISMATCH",
      message: "requestId already claimed by qds/demo",
    });

    // Parent dir auto-created with mode 0700.
    expect(fs.statSync(path.dirname(logPath)).mode & 0o777).toBe(0o700);
    // File mode 0600.
    expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);

    const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first.repoSlug).toBe("qds/demo");
    expect(first.issueId).toBe(42);
    expect(first.requestId).toBe(REQ_ID_A);
    expect(first.code).toBe("INVALID_ISSUE_ID");
    expect(first.message).toBe("issueId must be a positive integer");
    // timestamp is a parseable ISO string.
    expect(Number.isNaN(new Date(first.timestamp).getTime())).toBe(false);
    // Never prompt content — the entry carries no prompt/task field.
    expect(Object.keys(first)).not.toContain("prompt");
    expect(Object.keys(first)).not.toContain("task");
    const second = JSON.parse(lines[1]!);
    expect(second.requestId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. dispatch_task integration (offline, _injectRunner seam)
// ---------------------------------------------------------------------------

describe("dispatch_task correlation integration (offline)", () => {
  test("phase events carry the resolved requestId; exitStatus success; ExitStatus import discipline holds", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    const { markerRoot, dbPath } = mkRun();
    const resolved = corr({ requestId: REQ_ID_A });

    const tracer = new Tracer({
      dataDir: path.dirname(dbPath),
      requestId: resolved.requestId,
      pipelineName: "test-pipeline",
    });
    tracer.initiateSession({ correlation: resolved, request: "fix the seeded failing test" });

    // Fake runner: minimal valid NDJSON team stream (merged + clean run facts).
    _injectRunner(((manifestPath: string, opts?: TeamRunOptions) => {
      const line = '{"type":"merged","result":{"summary":"clean run"}}';
      opts?.onTeamEvent?.(parseTeamEventLine(line), { droppedOversize: false });
      opts?.onRunFacts?.({ exitCode: 0, termSignal: null, killOrigin: null, comsInitError: null });
      return Promise.resolve(successResult());
    }) satisfies typeof runTeamManifest);

    try {
      const value = await dispatchTask(dispatchSpec(), {
        tracer,
        requestId: resolved.requestId,
        rootDir: markerRoot,
        rosterValidateDeps: offlineGate,
      })(dispatchCtx());
      expect(value.exitStatus).toBe("success");
    } finally {
      tracer.close();
    }

    // Every event the phase wrote (prompts pre-spawn + adapted team events)
    // carries the resolved requestId.
    const db = openRo(dbPath);
    const rows = db
      .query<{ request_id: string }, [string]>(
        "SELECT DISTINCT request_id FROM events WHERE phase_id = ?",
      )
      .all("phase-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.request_id).toBe(resolved.requestId);
    db.close();

    // ExitStatus import discipline: the source under test imports the type
    // (re-exported from cli-anything/src/types.ts), and no DF1.8 file spells
    // the literal union.
    const dispatchSrc = await Bun.file(
      path.join(import.meta.dir, "../../src/phase-engine/phases/dispatch-task.ts"),
    ).text();
    expect(dispatchSrc).toMatch(/import type \{[^}]*ExitStatus[^}]*\} from "[^"]*types\.ts"/);
    for (const rel of [
      "../../src/phase-engine/issue-correlation.ts",
      "../../scripts/pipeline-run.ts",
    ]) {
      const src = await Bun.file(path.join(import.meta.dir, rel)).text();
      expect(src).not.toContain("'success' | 'transient'");
      expect(src).not.toContain('"success" | "transient"');
    }
  });
});
