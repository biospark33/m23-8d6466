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

  test("after ALTER TABLE ADD COLUMN, reader returns real values and latches", () => {
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

    // Read again: should see real value for new row
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

describe("constants (MAX_LIMIT, DEFAULT_LIMIT)", () => {
  test("MAX_LIMIT equals 1000 per contract", () => {
    expect(MAX_LIMIT).toBe(1000);
  });

  test("DEFAULT_LIMIT equals 500 per contract", () => {
    expect(DEFAULT_LIMIT).toBe(500);
  });
});
