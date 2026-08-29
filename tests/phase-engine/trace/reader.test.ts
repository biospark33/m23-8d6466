/**
 * Trace reader tests (Story DF1.4).
 *
 * A rowid-cursor reader that pages events in insertion order, respects
 * WAL journal mode, opens readonly, and handles schema drift via
 * optionalColumn probing.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "bun:sqlite";

// src/phase-engine/trace/reader.ts does not exist yet — this import WILL fail
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  openTraceReader,
  type TraceReader,
} from "../../../src/phase-engine/trace/reader.ts";
import { applyReaderPragmas } from "../../../src/phase-engine/trace/pragmas.ts";
// DF1.8 correlated reader types — do not exist yet, so this import fails the
// typecheck (RED) until types.ts grows the DF1.8 region.
import type {
  CorrelatedRunPage,
  CorrelatedRunRow,
  TracePhasePage,
  TracePhaseRow,
} from "../../../src/phase-engine/types.ts";

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "df1-4-reader-")));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let seq = 0;
let testDir = "";

beforeEach(() => {
  seq++;
  testDir = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, `seq${seq}-`)));
});

afterEach(() => {
  // Clean up test directory
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

/**
 * Helper: create a WAL fixture with events table and populate rows.
 * Returns the db path and an array of rowids (insertion order).
 */
function createWalFixture(
  dir: string,
  requestIds: string[],
  eventsPerRequest: number,
): { dbPath: string; rowids: Map<string, number[]> } {
  const dbPath = path.join(dir, "trace.db");
  const db = new Database(dbPath);

  // Enable WAL mode (writer perspective)
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  // Create events table per contract schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      phase_id TEXT,
      parent_id TEXT,
      type TEXT,
      name TEXT,
      payload_json TEXT,
      tokens INTEGER,
      started_at TEXT,
      ended_at TEXT
    )
  `);

  const rowids = new Map<string, number[]>();

  // Insert events for each requestId in order
  const insert = db.prepare(
    "INSERT INTO events (event_id, request_id, phase_id, type, name, payload_json, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );

  for (const requestId of requestIds) {
    const ids: number[] = [];
    for (let i = 0; i < eventsPerRequest; i++) {
      const result = insert.run(
        `evt-${requestId}-${i}`,
        requestId,
        `phase-${i}`,
        "test_type",
        `event-${i}`,
        `{"idx":${i}}`,
        `2024-01-01T00:00:${i.toString().padStart(2, "0")}Z`,
      );
      ids.push(result.lastInsertRowid as number);
    }
    rowids.set(requestId, ids);
  }

  db.close();
  return { dbPath, rowids };
}

/**
 * Helper: create a DELETE-mode fixture (non-WAL journal mode).
 */
function createDeleteFixture(dir: string, requestId: string, eventCount: number): string {
  const dbPath = path.join(dir, "trace.db");
  const db = new Database(dbPath);

  // Use DELETE journal mode (default, non-WAL)
  db.exec("PRAGMA journal_mode = DELETE");

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      phase_id TEXT,
      type TEXT,
      payload_json TEXT
    )
  `);

  const insert = db.prepare("INSERT INTO events (event_id, request_id, phase_id, type, payload_json) VALUES (?, ?, ?, ?, ?)");
  for (let i = 0; i < eventCount; i++) {
    insert.run(`evt-${i}`, requestId, `phase-${i}`, "test", "{}");
  }

  db.close();
  return dbPath;
}

/**
 * Helper: create a fixture with sessions table.
 */
function createSessionsFixture(dir: string): {
  dbPath: string;
  requestId: string;
} {
  const dbPath = path.join(dir, "trace.db");
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      request_id TEXT PRIMARY KEY,
      request TEXT,
      status TEXT,
      engineer TEXT,
      started_at TEXT,
      ended_at TEXT,
      duration_ms INTEGER,
      total_tokens INTEGER,
      total_cost INTEGER,
      pipeline_name TEXT
    )
  `);

  const requestId = "req-session-1";
  db.prepare(
    "INSERT INTO sessions (request_id, request, status, engineer, started_at, pipeline_name) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(requestId, "test request", "running", "tester", "2024-01-01T00:00:00Z", "test-pipeline");

  db.close();
  return { dbPath, requestId };
}

describe("readEvents paging (AC4)", () => {
  test("default limit returns page with cursor, hasMore indicates more rows", () => {
    const { dbPath, rowids } = createWalFixture(testDir, ["req-1"], 3);
    const reader = openTraceReader(dbPath);
    const page = reader.readEvents("req-1");

    expect(page.rows).toHaveLength(3);
    expect(page.hasMore).toBe(false);
    // cursor should be the last row's rowid
    expect(page.cursor).toBe(rowids.get("req-1")![2]!);
    reader.close();
  });

  test("explicit limit 2 with 3 events: first page has 2 rows, hasMore true, cursor set", () => {
    const { dbPath, rowids } = createWalFixture(testDir, ["req-paged"], 3);
    const reader = openTraceReader(dbPath);
    const page = reader.readEvents("req-paged", undefined, 2);

    expect(page.rows).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.cursor).toBe(rowids.get("req-paged")![1]!); // second row's rowid
    reader.close();
  });

  test("second page with cursor returns remaining row, hasMore false", () => {
    const { dbPath, rowids } = createWalFixture(testDir, ["req-paged-2"], 3);
    const reader = openTraceReader(dbPath);
    const firstPage = reader.readEvents("req-paged-2", undefined, 2);

    expect(firstPage.rows).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);

    const secondPage = reader.readEvents("req-paged-2", firstPage.cursor, 2);

    expect(secondPage.rows).toHaveLength(1);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.cursor).toBe(rowids.get("req-paged-2")![2]!);
    reader.close();
  });

  test("rows ordered by rowid ascending (insertion order)", () => {
    const { dbPath } = createWalFixture(testDir, ["req-ordered"], 5);
    const reader = openTraceReader(dbPath);
    const page = reader.readEvents("req-ordered");

    // Verify payload_json indicates insertion order
    for (let i = 0; i < page.rows.length; i++) {
      const payload = JSON.parse(page.rows[i]!.payload_json!);
      expect(payload.idx).toBe(i);
    }
    reader.close();
  });
});

describe("limit clamping (AC4, MAX_LIMIT=1000, DEFAULT_LIMIT=500)", () => {
  test("limit above MAX_LIMIT clamped to 1000", () => {
    // Insert 1001 events to test clamping
    const dbPath = path.join(testDir, "trace.db");
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL");

    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        type TEXT
      )
    `);

    const insert = db.prepare("INSERT INTO events (event_id, request_id, type) VALUES (?, ?, ?)");
    for (let i = 0; i < 1001; i++) {
      insert.run(`evt-${i}`, "req-clamp", "test");
    }
    db.close();

    const reader = openTraceReader(dbPath);
    const page = reader.readEvents("req-clamp", undefined, 2000); // ask for 2000

    expect(page.rows.length).toBe(1000); // clamped to MAX_LIMIT
    expect(page.hasMore).toBe(true); // 1001st row exists
    reader.close();
  });

  test("limit = 0 clamped to DEFAULT_LIMIT 500", () => {
    const { dbPath } = createWalFixture(testDir, ["req-zero"], 600);
    const reader = openTraceReader(dbPath);
    const page = reader.readEvents("req-zero", undefined, 0);

    expect(page.rows.length).toBe(500); // default when 0
    expect(page.hasMore).toBe(true); // 100 more rows exist
    reader.close();
  });

  test("negative limit clamped to DEFAULT_LIMIT 500", () => {
    const { dbPath } = createWalFixture(testDir, ["req-neg"], 600);
    const reader = openTraceReader(dbPath);
    const page = reader.readEvents("req-neg", undefined, -10);

    expect(page.rows.length).toBe(500);
    expect(page.hasMore).toBe(true);
    reader.close();
  });

  test("no limit arg uses DEFAULT_LIMIT 500", () => {
    const { dbPath } = createWalFixture(testDir, ["req-default"], 600);
    const reader = openTraceReader(dbPath);
    const page = reader.readEvents("req-default"); // no limit

    expect(page.rows.length).toBe(500);
    expect(page.hasMore).toBe(true);
    reader.close();
  });

  test("fractional limit below 1 falls back to DEFAULT_LIMIT, never LIMIT 0", () => {
    // 0.5 passes a raw >0 check but truncates to 0 — it must mean "default",
    // not bind LIMIT 0 (an empty page with hasMore true spins cursor loops).
    const { dbPath } = createWalFixture(testDir, ["req-frac"], 3);
    const reader = openTraceReader(dbPath);
    const page = reader.readEvents("req-frac", undefined, 0.5);

    expect(page.rows).toHaveLength(3); // full default page (500 > 3)
    expect(page.hasMore).toBe(false);
    reader.close();
  });
});

describe("unknown requestId (AC4)", () => {
  test("unknown requestId returns empty page, cursor unchanged, hasMore false", () => {
    const { dbPath } = createWalFixture(testDir, ["req-known"], 3);
    const reader = openTraceReader(dbPath);
    const page = reader.readEvents("nope", 42, 10);

    expect(page.rows).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBe(42); // unchanged
    reader.close();
  });

  test("event-less but existing requestId returns empty page", () => {
    const dbPath = path.join(testDir, "trace.db");
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, request_id TEXT NOT NULL)");
    db.close();

    const reader = openTraceReader(dbPath);
    const page = reader.readEvents("empty-req", 99, 10);

    expect(page.rows).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBe(99);
    reader.close();
  });
});

describe("cursor validation (INV-4)", () => {
  test("negative cursor throws", () => {
    const { dbPath } = createWalFixture(testDir, ["req-cursor"], 3);
    const reader = openTraceReader(dbPath);

    expect(() => reader.readEvents("req-cursor", -1)).toThrow("cursor");
    reader.close();
  });

  test("float cursor throws (non-integer rejected)", () => {
    const { dbPath } = createWalFixture(testDir, ["req-cursor"], 3);
    const reader = openTraceReader(dbPath);

    expect(() => reader.readEvents("req-cursor", 1.5)).toThrow("cursor");
    reader.close();
  });

  test("cursor 0 is valid (start from beginning)", () => {
    const { dbPath } = createWalFixture(testDir, ["req-cursor0"], 3);
    const reader = openTraceReader(dbPath);

    // Should not throw
    const page = reader.readEvents("req-cursor0", 0);
    expect(page.rows.length).toBeGreaterThan(0);
    reader.close();
  });

  test("string cursor coerced? No, throws (non-integer)", () => {
    const { dbPath } = createWalFixture(testDir, ["req-cursor-str"], 3);
    const reader = openTraceReader(dbPath);

    expect(() => reader.readEvents("req-cursor-str", "abc" as unknown as number)).toThrow("cursor");
    reader.close();
  });
});

describe("optionalColumn probe (AC3, INV-5)", () => {
  test("reader substitutes NULL for missing tokens column", () => {
    const dbPath = path.join(testDir, "trace.db");
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL");

    // Create events table WITHOUT tokens column
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        type TEXT,
        payload_json TEXT
      )
    `);

    const requestId = "req-no-tokens";
    db.prepare("INSERT INTO events (event_id, request_id, type, payload_json) VALUES (?, ?, ?, ?)").run(
      "evt-1",
      requestId,
      "test",
      "{}",
    );
    db.close();

    const reader = openTraceReader(dbPath);
    const page = reader.readEvents(requestId);

    expect(page.rows).toHaveLength(1);
    // Reader should return row with tokens = null (substituted)
    expect(page.rows[0]!.tokens).toBeNull();
    reader.close();
  });

  test("a missing column is re-probed until the ALTER lands, then latches", () => {
    // The probe re-runs while the column is missing, because the tracer's
    // ALTER can land while we're serving: a startup-only check would keep
    // returning NULL for the rest of the process even after the data
    // arrived. Once seen, a column never goes away, so it latches.
    const dbPath = path.join(testDir, "trace.db");
    const requestId = "req-tokens-added";
    const reader = openTraceReader(dbPath);

    // First, create table without tokens, insert row
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        type TEXT
      )
    `);
    db.prepare("INSERT INTO events (event_id, request_id, type) VALUES (?, ?, ?)").run(
      "evt-old",
      requestId,
      "old",
    );
    db.close();

    // Read: tokens should be null
    let page = reader.readEvents(requestId);
    expect(page.rows[0]!.tokens).toBeNull();

    // Now add the column mid-process
    const db2 = new Database(dbPath);
    db2.exec("ALTER TABLE events ADD COLUMN tokens INTEGER");
    db2.prepare("INSERT INTO events (event_id, request_id, type, tokens) VALUES (?, ?, ?, ?)").run(
      "evt-new",
      requestId,
      "new",
      123,
    );
    db2.close();

    // Same reader instance: the missing column was re-probed, so the ALTER
    // that landed after the first read is picked up.
    page = reader.readEvents(requestId);
    expect(page.rows).toHaveLength(2);
    const newRow = page.rows.find((r: { event_id: string }) => r.event_id === "evt-new");
    expect(newRow?.tokens).toBe(123);

    // Subsequent reads should also see the column (latched)
    page = reader.readEvents(requestId);
    const foundRow = page.rows.find((r: { event_id: string }) => r.event_id === "evt-new");
    expect(foundRow?.tokens).toBe(123);

    reader.close();
  });
});

describe("reader pragmas and WAL assertion (AC2)", () => {
  test("reader opens readonly, sets busy_timeout and synchronous", () => {
    const { dbPath } = createWalFixture(testDir, ["req-readonly"], 2);

    // Get file stats before opening reader
    const beforeStat = fs.statSync(dbPath);

    const reader = openTraceReader(dbPath);

    // Read should work
    const page = reader.readEvents("req-readonly");
    expect(page.rows.length).toBeGreaterThan(0);

    // File mtime should not change (readonly, no writes)
    const afterStat = fs.statSync(dbPath);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);

    reader.close();
  });

  test("reader asserts journal_mode is WAL, warns when not WAL", () => {
    const dbPath = createDeleteFixture(testDir, "req-delete", 3);

    const consoleWarn = spyOn(console, "warn");

    const reader = openTraceReader(dbPath);

    // Should have warned about non-WAL journal mode
    expect(consoleWarn).toHaveBeenCalled();
    const warnCall = consoleWarn.mock.calls[0] as unknown[];
    const warnMsg = String(warnCall[0]);
    expect(warnMsg.toLowerCase()).toContain("wal");

    // Read should still work
    const page = reader.readEvents("req-delete");
    expect(page.rows.length).toBe(3);

    reader.close();
  });

  test("reader does NOT change journal_mode (INV-3)", () => {
    const dbPath = createDeleteFixture(testDir, "req-no-change", 2);

    const reader = openTraceReader(dbPath);
    reader.readEvents("req-no-change");

    // Verify journal_mode is still DELETE (reader didn't change it)
    const checkDb = new Database(dbPath, { readonly: true });
    const journalMode = checkDb.query("PRAGMA journal_mode").get() as { journal_mode: string };
    checkDb.close();

    expect(journalMode.journal_mode).toBe("delete");

    reader.close();
  });

  test("applyReaderPragmas never throws — a broken connection reports 'unknown'", () => {
    const db = new Database(":memory:");
    db.close();
    expect(applyReaderPragmas(db)).toBe("unknown");
  });
});

describe("readonly genuine (INV-3)", () => {
  test("reads succeed when directory is chmod 0555 (no write permission)", () => {
    const { dbPath } = createWalFixture(testDir, ["req-readonly-perm"], 2);

    // Make directory readonly (chmod 0555)
    fs.chmodSync(testDir, 0o555);

    const reader = openTraceReader(dbPath);
    const page = reader.readEvents("req-readonly-perm");

    // Should succeed without needing write access
    expect(page.rows.length).toBe(2);

    reader.close();

    // Restore permissions for cleanup
    fs.chmodSync(testDir, 0o755);
  });

  test("file mtime unchanged after read operations", () => {
    const { dbPath } = createWalFixture(testDir, ["req-mtime"], 2);

    const beforeMtime = fs.statSync(dbPath).mtimeMs;

    const reader = openTraceReader(dbPath);
    reader.readEvents("req-mtime");
    reader.readEvents("req-mtime", undefined, 1); // multiple reads
    reader.close();

    const afterMtime = fs.statSync(dbPath).mtimeMs;

    expect(afterMtime).toBe(beforeMtime);
  });
});

describe("readSession", () => {
  test("readSession returns TraceSessionRow for existing requestId", () => {
    const { dbPath, requestId } = createSessionsFixture(testDir);

    const reader = openTraceReader(dbPath);
    const session = reader.readSession(requestId);

    expect(session).not.toBeNull();
    expect(session!.request_id).toBe(requestId);
    expect(session!.request).toBe("test request");
    expect(session!.status).toBe("running");
    expect(session!.engineer).toBe("tester");
    expect(session!.pipeline_name).toBe("test-pipeline");

    reader.close();
  });

  test("readSession returns null for unknown requestId", () => {
    const { dbPath } = createSessionsFixture(testDir);

    const reader = openTraceReader(dbPath);
    const session = reader.readSession("unknown-req");

    expect(session).toBeNull();

    reader.close();
  });

  test("readSession returns all expected columns", () => {
    const { dbPath, requestId } = createSessionsFixture(testDir);

    // Add a row with more columns populated
    const db = new Database(dbPath);
    db.prepare(
      "INSERT INTO sessions (request_id, request, status, engineer, started_at, ended_at, duration_ms, total_tokens, total_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("req-full", "full request", "completed", "tester", "2024-01-01T00:00:00Z", "2024-01-01T01:00:00Z", 3600000, 5000, 250);
    db.close();

    const reader = openTraceReader(dbPath);
    const session = reader.readSession("req-full");

    expect(session!.ended_at).toBe("2024-01-01T01:00:00Z");
    expect(session!.duration_ms).toBe(3600000);
    expect(session!.total_tokens).toBe(5000);
    expect(session!.total_cost).toBe(250);

    reader.close();
  });
});

describe("WAL crash recovery (killed writer)", () => {
  test("reader reads committed frames from a leftover -wal with no -shm", () => {
    // Simulate a killed run: copy db + -wal while the writer is still open,
    // then close the writer — its close checkpoints the ORIGINALS, leaving the
    // copies frozen pre-checkpoint: committed frames in -wal, no -shm, no live
    // connection. The readonly reader must still surface those rows —
    // SQLite ≥3.22 lets a readonly connection replay the WAL by creating the
    // -shm itself, which works wherever the data dir is writable (the store's
    // own 0700 contract).
    const liveDir = path.join(testDir, "live");
    fs.mkdirSync(liveDir);
    const liveDbPath = path.join(liveDir, "trace.db");
    const liveDb = new Database(liveDbPath);
    liveDb.exec("PRAGMA journal_mode = WAL");
    liveDb.exec(`
      CREATE TABLE events (
        event_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        type TEXT
      )
    `);
    liveDb
      .prepare("INSERT INTO events (event_id, request_id, type) VALUES ('evt-crash-1', 'req-crash', 'log')")
      .run();

    const crashedDir = path.join(testDir, "crashed");
    fs.mkdirSync(crashedDir);
    const crashedDbPath = path.join(crashedDir, "trace.db");
    fs.copyFileSync(liveDbPath, crashedDbPath);
    fs.copyFileSync(`${liveDbPath}-wal`, `${crashedDbPath}-wal`);
    liveDb.close(); // checkpoints + removes the originals' sidecars

    // Exactly the state a killed run leaves behind.
    expect(fs.existsSync(`${crashedDbPath}-wal`)).toBe(true);
    expect(fs.existsSync(`${crashedDbPath}-shm`)).toBe(false);

    const reader = openTraceReader(crashedDbPath);
    const page = reader.readEvents("req-crash");
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.event_id).toBe("evt-crash-1");
    reader.close();
  });
});

describe("constants (MAX_LIMIT, DEFAULT_LIMIT)", () => {
  test("MAX_LIMIT equals 1000 per contract", () => {
    expect(MAX_LIMIT).toBe(1000);
  });

  test("DEFAULT_LIMIT equals 500 per contract", () => {
    expect(DEFAULT_LIMIT).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// DF1.8 — issue-correlated reader additions (readRunsByIssue / readRunPhases).
// Tests target the locked DF1.8 contract; implementation does not exist yet,
// so every block below is RED until reader.ts grows the two methods.
// ---------------------------------------------------------------------------

/** Post-DF1.8-migration sessions shape: repo_slug/issue_id/issue_url present. */
const CORRELATED_SESSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS sessions (
    request_id TEXT PRIMARY KEY,
    request TEXT,
    status TEXT,
    engineer TEXT,
    started_at TEXT,
    ended_at TEXT,
    duration_ms INTEGER,
    total_tokens INTEGER,
    total_cost INTEGER,
    pipeline_name TEXT,
    archived INTEGER DEFAULT 0,
    repo_slug TEXT,
    issue_id INTEGER,
    issue_url TEXT
  )
`;

const CORRELATED_PHASES_DDL = `
  CREATE TABLE IF NOT EXISTS phases (
    phase_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    seq INTEGER,
    name TEXT,
    kind TEXT,
    owner TEXT,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'fail',
    attempt INTEGER,
    retries INTEGER,
    error TEXT,
    started_at TEXT,
    ended_at TEXT
  )
`;

const CORRELATED_ENVELOPES_DDL = `
  CREATE TABLE IF NOT EXISTS envelopes (
    envelope_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    phase_id TEXT,
    agent TEXT,
    output_type TEXT,
    payload_json TEXT,
    valid INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER
  )
`;

/**
 * Helper: correlated fixture. Same issue_id (42) in two repos:
 *   qds/demo#42  → req-demo-a (3 phases) + req-demo-b (no phases)
 *   qds/other#42 → req-other (1 phase — must never leak into demo pages)
 * Phase envelope coverage on req-demo-a:
 *   phase-a1 — envelopes attempt 2 AND attempt 1 (a2 inserted FIRST)
 *   phase-a2 — no envelope
 *   phase-a3 — single envelope attempt 1
 */
function createCorrelatedFixture(dir: string): {
  dbPath: string;
  sessionRowids: { demoA: number; demoB: number; other: number };
  phaseRowids: { a1: number; a2: number; a3: number; o1: number };
} {
  const dbPath = path.join(dir, "trace.db");
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(CORRELATED_SESSIONS_DDL);
  db.exec(CORRELATED_PHASES_DDL);
  db.exec(CORRELATED_ENVELOPES_DDL);

  const insSession = db.prepare(
    "INSERT INTO sessions (request_id, request, status, started_at, pipeline_name, repo_slug, issue_id, issue_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const demoA = Number(
    insSession.run("req-demo-a", "demo request A", "completed", "2026-01-01T00:00:00Z", "test-pipeline", "qds/demo", 42, "https://git.example.com/qds/demo/issues/42").lastInsertRowid,
  );
  const demoB = Number(
    insSession.run("req-demo-b", "demo request B", "running", "2026-01-02T00:00:00Z", "test-pipeline", "qds/demo", 42, null).lastInsertRowid,
  );
  const other = Number(
    insSession.run("req-other", "other repo run", "completed", "2026-01-03T00:00:00Z", null, "qds/other", 42, null).lastInsertRowid,
  );

  const insPhase = db.prepare(
    "INSERT INTO phases (phase_id, request_id, seq, name, kind, owner, status, attempt, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const a1 = Number(insPhase.run("phase-a1", "req-demo-a", 0, "plan", "plan", "engine", "ok", 1, "2026-01-01T00:00:01Z").lastInsertRowid);
  const a2 = Number(insPhase.run("phase-a2", "req-demo-a", 1, "build", "work", "worker", "ok", 1, "2026-01-01T00:00:02Z").lastInsertRowid);
  const a3 = Number(insPhase.run("phase-a3", "req-demo-a", 2, "check", "work", "worker", "fail", 2, "2026-01-01T00:00:03Z").lastInsertRowid);
  const o1 = Number(insPhase.run("phase-o1", "req-other", 0, "plan", "plan", "engine", "ok", 1, "2026-01-03T00:00:01Z").lastInsertRowid);

  // Attempt-2 envelope inserted FIRST on purpose: an impl that takes the
  // last-inserted envelope instead of MAX(attempt) returns the attempt-1
  // payload and fails the latest-attempt assertions below.
  const insEnvelope = db.prepare(
    "INSERT INTO envelopes (envelope_id, request_id, phase_id, agent, output_type, payload_json, valid, attempt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insEnvelope.run("env-a1-at2", "req-demo-a", "phase-a1", "worker", "text", '{"phase":"a1","attempt":2}', 1, 2);
  insEnvelope.run("env-a1-at1", "req-demo-a", "phase-a1", "worker", "text", '{"phase":"a1","attempt":1}', 1, 1);
  insEnvelope.run("env-a3-at1", "req-demo-a", "phase-a3", "checker", "text", '{"phase":"a3","attempt":1}', 1, 1);

  db.close();
  return {
    dbPath,
    sessionRowids: { demoA, demoB, other },
    phaseRowids: { a1, a2, a3, o1 },
  };
}

/**
 * Helper: N bare session rows for one (repoSlug, issueId) — limit/cap tests.
 */
function createRunsFixture(dir: string, repoSlug: string, issueId: number, count: number): { dbPath: string; rowids: number[] } {
  const dbPath = path.join(dir, "trace.db");
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(CORRELATED_SESSIONS_DDL);

  const insert = db.prepare(
    "INSERT INTO sessions (request_id, request, status, repo_slug, issue_id) VALUES (?, ?, ?, ?, ?)",
  );
  const rowids: number[] = [];
  for (let i = 0; i < count; i++) {
    rowids.push(Number(insert.run(`req-bulk-${i}`, `bulk ${i}`, "completed", repoSlug, issueId).lastInsertRowid));
  }
  db.close();
  return { dbPath, rowids };
}

describe("readRunsByIssue correlation (DF1.8, INV-RUN-3)", () => {
  test("returns only the named repo's runs — same issue_id in another repo excluded", () => {
    const { dbPath, sessionRowids } = createCorrelatedFixture(testDir);
    const reader = openTraceReader(dbPath);

    const page = reader.readRunsByIssue("qds/demo", 42);

    expect(page.rows.map((r: CorrelatedRunRow) => r.request_id)).toEqual(["req-demo-a", "req-demo-b"]);
    expect(
      page.rows.every((row: CorrelatedRunRow) => row.repo_slug === "qds/demo" && row.issue_id === 42),
    ).toBe(true);
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBe(sessionRowids.demoB);
    reader.close();
  });

  test("limit=1: first page hasMore true with cursor=first rowid; walk exhausts", () => {
    const { dbPath, sessionRowids } = createCorrelatedFixture(testDir);
    const reader = openTraceReader(dbPath);

    const page1 = reader.readRunsByIssue("qds/demo", 42, 0, 1);
    expect(page1.rows).toHaveLength(1);
    expect(page1.rows[0]!.request_id).toBe("req-demo-a");
    expect(page1.cursor).toBe(sessionRowids.demoA);
    expect(page1.hasMore).toBe(true);

    // Page-full heuristic per contract (`hasMore = rows.length === cappedLimit`,
    // identical to readEvents): a full single-row page reports hasMore true
    // even when it was the last row — the next page is the authoritative check.
    const page2 = reader.readRunsByIssue("qds/demo", 42, page1.cursor, 1);
    expect(page2.rows).toHaveLength(1);
    expect(page2.rows[0]!.request_id).toBe("req-demo-b");
    expect(page2.hasMore).toBe(true);

    const page3 = reader.readRunsByIssue("qds/demo", 42, page2.cursor, 1);
    expect(page3.rows).toEqual([]);
    expect(page3.cursor).toBe(page2.cursor);
    expect(page3.hasMore).toBe(false);
    reader.close();
  });

  test("limit=2 over 3 runs: second page under-full, hasMore false, cursor=last rowid", () => {
    const { dbPath, rowids } = createRunsFixture(testDir, "qds/page", 42, 3);
    const reader = openTraceReader(dbPath);

    const page1 = reader.readRunsByIssue("qds/page", 42, 0, 2);
    expect(page1.rows.map((r: CorrelatedRunRow) => r.request_id)).toEqual(["req-bulk-0", "req-bulk-1"]);
    expect(page1.hasMore).toBe(true);
    expect(page1.cursor).toBe(rowids[1]!);

    const page2 = reader.readRunsByIssue("qds/page", 42, page1.cursor, 2);
    expect(page2.rows.map((r: CorrelatedRunRow) => r.request_id)).toEqual(["req-bulk-2"]);
    expect(page2.hasMore).toBe(false);
    expect(page2.cursor).toBe(rowids[2]!);
    reader.close();
  });

  test("unknown (repoSlug, issueId): empty page, cursor unchanged, hasMore false — not an error", () => {
    const { dbPath } = createCorrelatedFixture(testDir);
    const reader = openTraceReader(dbPath);

    const page = reader.readRunsByIssue("qds/ghost", 42, 42, 10);
    expect(page.rows).toEqual([]);
    expect(page.cursor).toBe(42);
    expect(page.hasMore).toBe(false);
    reader.close();
  });

  test("rows carry phases ordered by rowid with latest-attempt output_payload_json", () => {
    const { dbPath, phaseRowids } = createCorrelatedFixture(testDir);
    const reader = openTraceReader(dbPath);

    const page = reader.readRunsByIssue("qds/demo", 42);
    const runA = page.rows.find((r) => r.request_id === "req-demo-a")!;

    expect(runA.phases.map((p: TracePhaseRow) => p.phase_id)).toEqual(["phase-a1", "phase-a2", "phase-a3"]);
    expect(runA.phases[0]!.rowid).toBe(phaseRowids.a1);
    expect(runA.phases[0]!.status).toBe("ok");
    // Latest attempt wins (attempt 2), not the last-inserted envelope.
    expect(runA.phases[0]!.output_payload_json).toBe('{"phase":"a1","attempt":2}');
    // Phase with no envelope → null, never a synthetic payload.
    expect(runA.phases[1]!.output_payload_json).toBeNull();
    expect(runA.phases[2]!.output_payload_json).toBe('{"phase":"a3","attempt":1}');

    // Run without phases still has the array (empty), not undefined.
    const runB = page.rows.find((r) => r.request_id === "req-demo-b")!;
    expect(runB.phases).toEqual([]);
    reader.close();
  });

  test("schema drift: sessions-only store — readRunPhases is an empty page, phases embed as []", () => {
    const { dbPath } = createRunsFixture(testDir, "qds/drift", 42, 2);
    const reader = openTraceReader(dbPath);

    // No phases table at all: an empty page with the cursor unchanged, not a
    // prepare-time error on a missing table (the hasTable drift contract).
    const page = reader.readRunPhases("req-bulk-0");
    expect(page.rows).toEqual([]);
    expect(page.cursor).toBe(0);
    expect(page.hasMore).toBe(false);

    // And the correlated page embeds phases: [] rather than failing.
    const runPage = reader.readRunsByIssue("qds/drift", 42);
    expect(runPage.rows).toHaveLength(2);
    expect(runPage.rows.every((r: CorrelatedRunRow) => r.phases.length === 0)).toBe(true);
    reader.close();
  });

  test("schema drift: phases without envelopes — phase rows still embed, output_payload_json null", () => {
    const dbPath = path.join(testDir, "trace.db");
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(CORRELATED_SESSIONS_DDL);
    db.exec(CORRELATED_PHASES_DDL);
    db.prepare(
      "INSERT INTO sessions (request_id, request, status, repo_slug, issue_id) VALUES (?, ?, ?, ?, ?)",
    ).run("req-noenv", "no envelopes", "completed", "qds/noenv", 42);
    db.prepare(
      "INSERT INTO phases (phase_id, request_id, seq, name, kind, owner, status, attempt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("phase-ne1", "req-noenv", 0, "plan", "plan", "engine", "ok", 1);
    db.close();

    const reader = openTraceReader(dbPath);
    const page = reader.readRunsByIssue("qds/noenv", 42);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.phases).toHaveLength(1);
    expect(page.rows[0]!.phases[0]!.phase_id).toBe("phase-ne1");
    // The envelope join is skipped for a missing envelopes table — the phase
    // row is still returned, its persisted output simply reads null.
    expect(page.rows[0]!.phases[0]!.output_payload_json).toBeNull();

    // Same tolerance on the direct phases reader.
    const phasePage = reader.readRunPhases("req-noenv");
    expect(phasePage.rows).toHaveLength(1);
    expect(phasePage.rows[0]!.output_payload_json).toBeNull();
    reader.close();
  });

  test("same repo, different issue_id: both predicates filter, not just repo_slug", () => {
    const { dbPath } = createRunsFixture(testDir, "qds/same", 42, 2);
    const db = new Database(dbPath);
    db.prepare(
      "INSERT INTO sessions (request_id, request, status, repo_slug, issue_id) VALUES (?, ?, ?, ?, ?)",
    ).run("req-issue-43", "neighbor issue", "completed", "qds/same", 43);
    db.close();

    const reader = openTraceReader(dbPath);
    const page42 = reader.readRunsByIssue("qds/same", 42);
    expect(page42.rows.map((r: CorrelatedRunRow) => r.request_id)).toEqual(["req-bulk-0", "req-bulk-1"]);

    const page43 = reader.readRunsByIssue("qds/same", 43);
    expect(page43.rows.map((r: CorrelatedRunRow) => r.request_id)).toEqual(["req-issue-43"]);
    reader.close();
  });
});

describe("readRunsByIssue limit handling (DF1.8 — identical to readEvents)", () => {
  test("limit=0 with 3 rows falls back to DEFAULT_LIMIT: all rows, hasMore false", () => {
    const { dbPath } = createRunsFixture(testDir, "qds/zero", 42, 3);
    const reader = openTraceReader(dbPath);

    const page = reader.readRunsByIssue("qds/zero", 42, 0, 0);
    expect(page.rows).toHaveLength(3);
    expect(page.hasMore).toBe(false);
    reader.close();
  });

  test("non-finite limits (NaN, Infinity) fall back to DEFAULT_LIMIT", () => {
    const { dbPath } = createRunsFixture(testDir, "qds/nan", 42, 3);
    const reader = openTraceReader(dbPath);

    const nanPage = reader.readRunsByIssue("qds/nan", 42, 0, Number.NaN);
    expect(nanPage.rows).toHaveLength(3);
    expect(nanPage.hasMore).toBe(false);

    const infPage = reader.readRunsByIssue("qds/nan", 42, 0, Number.POSITIVE_INFINITY);
    expect(infPage.rows).toHaveLength(3);
    expect(infPage.hasMore).toBe(false);
    reader.close();
  });

  test("limit above MAX_LIMIT capped at 1000 with 1001 matching runs", () => {
    const { dbPath, rowids } = createRunsFixture(testDir, "qds/cap", 42, 1001);
    const reader = openTraceReader(dbPath);

    const page = reader.readRunsByIssue("qds/cap", 42, 0, 2000);
    expect(page.rows).toHaveLength(1000);
    expect(page.hasMore).toBe(true);
    expect(page.cursor).toBe(rowids[999]!);

    const rest = reader.readRunsByIssue("qds/cap", 42, page.cursor, 2000);
    expect(rest.rows).toHaveLength(1);
    expect(rest.hasMore).toBe(false);
    reader.close();
  });
});

describe("readRunsByIssue cursor validation (DF1.8 — same rule as readEvents)", () => {
  test("negative cursor throws", () => {
    const { dbPath } = createCorrelatedFixture(testDir);
    const reader = openTraceReader(dbPath);
    expect(() => reader.readRunsByIssue("qds/demo", 42, -1)).toThrow("cursor");
    reader.close();
  });

  test("non-integer cursor (1.5) throws", () => {
    const { dbPath } = createCorrelatedFixture(testDir);
    const reader = openTraceReader(dbPath);
    expect(() => reader.readRunsByIssue("qds/demo", 42, 1.5)).toThrow("cursor");
    reader.close();
  });
});

describe("readRunPhases (DF1.8)", () => {
  test("returns only the named request's phases — other run's phases excluded", () => {
    const { dbPath, phaseRowids } = createCorrelatedFixture(testDir);
    const reader = openTraceReader(dbPath);

    const page = reader.readRunPhases("req-demo-a");
    expect(page.rows.map((p: TracePhaseRow) => p.phase_id)).toEqual(["phase-a1", "phase-a2", "phase-a3"]);
    expect(
      page.rows.every((phase: TracePhaseRow) => phase.request_id === "req-demo-a" && phase.rowid !== phaseRowids.o1),
    ).toBe(true);
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBe(phaseRowids.a3);
    reader.close();
  });

  test("output_payload_json join: latest-attempt envelope payload; no envelope → null", () => {
    const { dbPath } = createCorrelatedFixture(testDir);
    const reader = openTraceReader(dbPath);

    const page = reader.readRunPhases("req-demo-a");
    expect(page.rows[0]!.output_payload_json).toBe('{"phase":"a1","attempt":2}');
    expect(page.rows[1]!.output_payload_json).toBeNull();
    expect(page.rows[2]!.output_payload_json).toBe('{"phase":"a3","attempt":1}');
    reader.close();
  });

  test("two envelopes sharing one attempt: phase returned exactly ONCE, payload = last-inserted (max rowid)", () => {
    const dbPath = path.join(testDir, "trace.db");
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(CORRELATED_SESSIONS_DDL);
    db.exec(CORRELATED_PHASES_DDL);
    db.exec(CORRELATED_ENVELOPES_DDL);
    db.prepare(
      "INSERT INTO sessions (request_id, request, status, started_at, repo_slug, issue_id) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("req-dup", "duplicate-envelope run", "completed", "2026-01-04T00:00:00Z", "qds/demo", 42);
    db.prepare(
      "INSERT INTO phases (phase_id, request_id, seq, name, kind, owner, status, attempt, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("phase-d1", "req-dup", 0, "plan", "plan", "engine", "ok", 1, "2026-01-04T00:00:01Z");
    const insEnvelope = db.prepare(
      "INSERT INTO envelopes (envelope_id, request_id, phase_id, agent, output_type, payload_json, valid, attempt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    // Same attempt, distinct payloads, second inserted later (higher rowid):
    // an equality join on attempt would fan out to TWO phase-d1 rows; the
    // rowid tiebreak must collapse them to the LAST-inserted payload.
    insEnvelope.run("env-d1-first", "req-dup", "phase-d1", "worker", "text", '{"phase":"d1","copy":"first"}', 1, 1);
    insEnvelope.run("env-d1-second", "req-dup", "phase-d1", "worker", "text", '{"phase":"d1","copy":"second"}', 1, 1);
    db.close();

    const reader = openTraceReader(dbPath);
    const page = reader.readRunPhases("req-dup");
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.phase_id).toBe("phase-d1");
    expect(page.rows[0]!.output_payload_json).toBe('{"phase":"d1","copy":"second"}');

    const runPage = reader.readRunsByIssue("qds/demo", 42);
    expect(runPage.rows).toHaveLength(1);
    expect(runPage.rows[0]!.phases).toHaveLength(1);
    expect(runPage.rows[0]!.phases[0]!.output_payload_json).toBe('{"phase":"d1","copy":"second"}');
    reader.close();
  });

  test("rowid-cursor paging: limit=2 first page full hasMore true; second page rest", () => {
    const { dbPath, phaseRowids } = createCorrelatedFixture(testDir);
    const reader = openTraceReader(dbPath);

    const page1 = reader.readRunPhases("req-demo-a", 0, 2);
    expect(page1.rows.map((p: TracePhaseRow) => p.phase_id)).toEqual(["phase-a1", "phase-a2"]);
    expect(page1.hasMore).toBe(true);
    expect(page1.cursor).toBe(phaseRowids.a2);

    const page2 = reader.readRunPhases("req-demo-a", page1.cursor, 2);
    expect(page2.rows.map((p: TracePhaseRow) => p.phase_id)).toEqual(["phase-a3"]);
    expect(page2.hasMore).toBe(false);
    expect(page2.cursor).toBe(phaseRowids.a3);
    reader.close();
  });

  test("requestId with no phases: empty page, cursor unchanged, hasMore false", () => {
    const { dbPath } = createCorrelatedFixture(testDir);
    const reader = openTraceReader(dbPath);

    const page = reader.readRunPhases("req-demo-b", 7, 10);
    expect(page.rows).toEqual([]);
    expect(page.cursor).toBe(7);
    expect(page.hasMore).toBe(false);
    reader.close();
  });

  test("negative cursor throws (same rule as readEvents)", () => {
    const { dbPath } = createCorrelatedFixture(testDir);
    const reader = openTraceReader(dbPath);
    expect(() => reader.readRunPhases("req-demo-a", -1)).toThrow("cursor");
    reader.close();
  });

  test("non-integer cursor (1.5) throws (same rule as readEvents)", () => {
    const { dbPath } = createCorrelatedFixture(testDir);
    const reader = openTraceReader(dbPath);
    expect(() => reader.readRunPhases("req-demo-a", 1.5)).toThrow("cursor");
    reader.close();
  });
});

describe("DF1.8 reader type surface (typecheck-level RED)", () => {
  // INV-RUN-3 negative control: TraceReader exposes NO issueId-only entry
  // point. The only correlation lookup takes (repoSlug, issueId) together
  // (readRunsByIssue) and the only phase lookup takes a requestId
  // (readRunPhases) — every call in the blocks above compiles against exactly
  // those signatures, which is the compile-time proof. Review grep:
  //   grep -n "readRunsByIssue\|readRunPhases" src/phase-engine/trace/reader.ts
  // must show no single-issueId-argument form. No runtime gymnastics needed.
  test("correlated reader types exist with the contract shape", () => {
    const _runCursor: CorrelatedRunPage["cursor"] = 0;
    const _phaseCursor: TracePhasePage["cursor"] = 0;
    const _runPhases: CorrelatedRunRow["phases"] = [];
    const _payload: TracePhaseRow["output_payload_json"] = null;
    expect(_runCursor).toBe(0);
    expect(_phaseCursor).toBe(0);
    expect(_runPhases).toEqual([]);
    expect(_payload).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F055: rows are parsed at the reader boundary. A drifted store (e.g. one
// created before the `phases.status NOT NULL DEFAULT 'fail'` constraint
// existed) must be reported, not silently mistyped as a non-nullable string.
// ---------------------------------------------------------------------------

const DRIFTED_PHASES_DDL = `
  CREATE TABLE IF NOT EXISTS phases (
    phase_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    seq INTEGER,
    name TEXT,
    kind TEXT,
    owner TEXT,
    description TEXT,
    status TEXT,
    attempt INTEGER,
    retries INTEGER,
    error TEXT,
    started_at TEXT,
    ended_at TEXT
  )
`;

function createDriftedPhaseFixture(dir: string): { dbPath: string } {
  const dbPath = path.join(dir, "trace.db");
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(DRIFTED_PHASES_DDL);
  db.prepare(
    "INSERT INTO phases (phase_id, request_id, seq, name, kind, owner, status, attempt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("phase-drift-1", "req-drift", 0, "plan", "plan", "engine", null, 1);
  db.close();
  return { dbPath };
}

describe("F055: reader boundary validation", () => {
  test("a drifted store with a NULL phase status is reported, not silently typed non-null", () => {
    const { dbPath } = createDriftedPhaseFixture(testDir);
    const reader = openTraceReader(dbPath);
    expect(() => reader.readRunPhases("req-drift")).toThrow(/status/);
    reader.close();
  });

  test("a well-formed store still reads phases normally", () => {
    const { dbPath } = createCorrelatedFixture(testDir);
    const reader = openTraceReader(dbPath);
    const page = reader.readRunPhases("req-demo-a");
    expect(page.rows.map((p: TracePhaseRow) => p.phase_id)).toEqual([
      "phase-a1",
      "phase-a2",
      "phase-a3",
    ]);
    reader.close();
  });

  test("a store lacking events.type still reads — probed columns are nullable, not pinned", () => {
    // `events.type` is NOT NULL in SCHEMA_DDL but is read through
    // optionalColumn, so a store that predates the column reads it as NULL.
    // Pinning it in eventRowSchema would turn tolerated drift into a throw.
    const dbPath = path.join(testDir, "trace.db");
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        payload_json TEXT
      )
    `);
    db.prepare("INSERT INTO events (event_id, request_id, payload_json) VALUES (?, ?, ?)").run(
      "evt-no-type",
      "req-no-type",
      "{}",
    );
    db.close();

    const reader = openTraceReader(dbPath);
    const page = reader.readEvents("req-no-type");
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.type).toBeNull();
    expect(page.rows[0]!.name).toBeNull();
    reader.close();
  });

  test("a missing column is re-probed on every read and stops being probed once present", () => {
    // events table deliberately missing "payload_json" (one of the columns
    // readEvents probes via optionalColumn). While it is missing the probe
    // must re-run on each read so a tracer ALTER that lands mid-process is
    // picked up; once every probed column is present the cache latches and
    // PRAGMA table_info stops running.
    const dbPath = path.join(testDir, "trace.db");
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        phase_id TEXT,
        parent_id TEXT,
        type TEXT,
        name TEXT,
        tokens INTEGER,
        started_at TEXT,
        ended_at TEXT
      )
    `);
    db.prepare("INSERT INTO events (event_id, request_id, type) VALUES (?, ?, ?)").run(
      "evt-cache-1",
      "req-cache",
      "test",
    );
    db.close();

    const reader = openTraceReader(dbPath);
    let pragmaCount = 0;
    const originalQuery = Database.prototype.query;
    Database.prototype.query = function (this: Database, sql: string, ...rest: unknown[]) {
      if (typeof sql === "string" && sql.includes("PRAGMA table_info")) pragmaCount++;
      return (originalQuery as (...a: unknown[]) => unknown).apply(this, [sql, ...rest]);
    } as typeof Database.prototype.query;

    try {
      reader.readEvents("req-cache");
      const afterFirst = pragmaCount;
      expect(afterFirst).toBeGreaterThan(0);

      // Still missing → re-probed.
      reader.readEvents("req-cache");
      expect(pragmaCount).toBeGreaterThan(afterFirst);

      const writer = new Database(dbPath);
      writer.exec("ALTER TABLE events ADD COLUMN payload_json TEXT");
      writer.close();

      // The read that observes the ALTER latches the last missing column.
      reader.readEvents("req-cache");
      const afterAlter = pragmaCount;

      // Everything probed is now present → no further PRAGMA table_info.
      reader.readEvents("req-cache");
      expect(pragmaCount).toBe(afterAlter);
    } finally {
      Database.prototype.query = originalQuery;
    }
    reader.close();
  });
});
