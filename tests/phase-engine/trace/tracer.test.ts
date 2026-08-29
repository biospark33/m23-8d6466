/**
 * Tracer tests (Story DF1.4).
 *
 * AC1: seven tables with correct schema, DEFAULT 'fail', both JSON columns.
 * AC2: writer pragmas (WAL, synchronous=NORMAL, busy_timeout=5000).
 * DoD unit: gate_results round-trip, invalid envelope retained.
 * DoD prompt: prompt event round-trip byte-identical.
 * AC5: degraded write continues run, INV-1 boundary refusal.
 * DoD: WAL/SHM sidecar modes 0600.
 * Processes: record/end/endAll.
 * Dual-write order: JSONL then SQLite.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ponytail: src/ does not exist yet — this import fails red as expected
import {
  Tracer,
  TracerError,
  serializeTraceError,
} from "../../../src/phase-engine/trace/tracer.ts";
import {
  applyWriterPragmas,
  TRACE_PRAGMAS,
} from "../../../src/phase-engine/trace/pragmas.ts";

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "df1-4-tracer-")));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let markerRoot = "";
let dataDir = "";
const requestId = "test-req-1";
const pipelineName = "test-pipeline";

beforeEach(() => {
  markerRoot = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, "marker-")));
  dataDir = path.join(markerRoot, "run-data");
  process.env.QDS_RUN_ROOT = markerRoot;
});

afterEach(() => {
  // ponytail: restore mode if degraded-write test chmod'd
  if (fs.existsSync(dataDir)) {
    const db = path.join(dataDir, "trace.db");
    try {
      if (fs.existsSync(db)) fs.chmodSync(db, 0o600);
      const wal = `${db}-wal`;
      if (fs.existsSync(wal)) fs.chmodSync(wal, 0o600);
      const shm = `${db}-shm`;
      if (fs.existsSync(shm)) fs.chmodSync(shm, 0o600);
      const jsonl = path.join(dataDir, "events.jsonl");
      if (fs.existsSync(jsonl)) fs.chmodSync(jsonl, 0o600);
    } catch {}
  }
  // biome-ignore lint/performance/noDelete: delete is the only correct way to restore "not set"
  delete process.env.QDS_RUN_ROOT;
});

describe("AC1: schema initialization", () => {
  test("seven tables exist with contract columns", () => {
    const tracer = new Tracer({ dataDir, requestId, pipelineName });
    const db = new Database(path.join(dataDir, "trace.db"), { readonly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual([
      "agent_sessions",
      "envelopes",
      "events",
      "gate_results",
      "phases",
      "processes",
      "sessions",
    ]);

    const requestIds = new Set<string>();
    for (const { name: table } of tables) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
        type: string;
        dflt_value: string | null;
      }[];
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain("request_id");
      requestIds.add(table);

      if (table === "phases") {
        expect(colNames).toContain("status");
        const statusCol = cols.find((c) => c.name === "status");
        expect(statusCol?.dflt_value).toBe("'fail'");
      }

      if (table === "gate_results") {
        expect(colNames).toContain("violations_json");
        expect(colNames).toContain("checks_json");
      }
    }
    expect(requestIds.size).toBe(7);
    db.close();
    tracer.close();
  });
});

describe("AC2: writer pragmas", () => {
  test("journal_mode is WAL", () => {
    const tracer = new Tracer({ dataDir, requestId, pipelineName });
    const db = new Database(path.join(dataDir, "trace.db"), { readonly: true });
    const row = db
      .prepare("PRAGMA journal_mode")
      .get() as { journal_mode: string };
    expect(row.journal_mode).toBe("wal");
    db.close();
    tracer.close();
  });

  // synchronous/busy_timeout are per-connection, not persisted in the file, so
  // they cannot be asserted from a second connection — the AC2 contract is
  // asserted on a live writer connection using the same shared applier the
  // Tracer runs (pragmas.ts is the single source for both).
  test("shared writer pragmas set WAL, synchronous=NORMAL, busy_timeout=5000 on the connection", () => {
    fs.mkdirSync(dataDir, { recursive: true });
    const db = new Database(path.join(dataDir, "pragma-check.db"));
    applyWriterPragmas(db);

    expect(
      (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode.toLowerCase(),
    ).toBe("wal");
    expect(
      (db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous,
    ).toBe(1); // NORMAL
    expect(
      (db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout, // SQLite names the result column "timeout"
    ).toBe(5000);
    db.close();

    // The writer's strictness and the reader's tolerance come from one source.
    expect(TRACE_PRAGMAS.journalMode).toBe("WAL");
    expect(TRACE_PRAGMAS.synchronous).toBe("NORMAL");
    expect(TRACE_PRAGMAS.busyTimeoutMs).toBe(5000);
  });

  test("applyWriterPragmas throws when WAL is refused, never silently degrades", () => {
    // :memory: reports "memory" — WAL is impossible there, a faithful
    // stand-in for any connection where the SET does not take effect.
    const db = new Database(":memory:");
    expect(() => applyWriterPragmas(db)).toThrow(/journal_mode=WAL refused/);
    db.close();
  });
});

describe("event timestamp coherence", () => {
  test("end-only event stamps started_at from ended_at — never a later clock read", () => {
    const tracer = new Tracer({ dataDir, requestId, pipelineName });
    const endedAt = new Date().toISOString();
    tracer.trace({
      requestId,
      phaseId: "p-1",
      type: "phase_end",
      name: "build",
      endedAt,
    });
    tracer.close();

    const db = new Database(path.join(dataDir, "trace.db"), { readonly: true });
    const row = db
      .prepare("SELECT started_at, ended_at FROM events WHERE type = 'phase_end'")
      .get() as { started_at: string; ended_at: string };
    expect(row.ended_at).toBe(endedAt);
    // started_at === ended_at: the event timestamp is the end, not a second
    // clock read taken after it (which once produced started > ended).
    expect(row.started_at).toBe(endedAt);
    db.close();
  });
});

describe("DoD unit: gate_results round-trip", () => {
  test("violations_json and checks_json persist and read back", () => {
    const tracer = new Tracer({ dataDir, requestId, pipelineName });
    tracer.recordGateResult({
      requestId,
      phaseId: "phase-1",
      attempt: 1,
      gate: "output_exists",
      passed: false,
      violations: ["missing artifact: output.txt"],
      checks: [
        { item: "output.txt", ok: false, note: "file does not exist" },
        { item: "README.md", ok: true, note: "exists, 2.3KB" },
      ],
    });

    const db = new Database(path.join(dataDir, "trace.db"), { readonly: true });
    const row = db
      .prepare("SELECT violations_json, checks_json FROM gate_results WHERE request_id=?")
      .get(requestId) as { violations_json: string; checks_json: string } | undefined;
    expect(row).toBeDefined();
    expect(JSON.parse(row!.violations_json)).toEqual([
      "missing artifact: output.txt",
    ]);
    expect(JSON.parse(row!.checks_json)).toEqual([
      { item: "output.txt", ok: false, note: "file does not exist" },
      { item: "README.md", ok: true, note: "exists, 2.3KB" },
    ]);
    db.close();
    tracer.close();
  });
});

describe("DoD unit: invalid envelope retained", () => {
  test("envelope with valid=false is retained with valid=0", () => {
    const tracer = new Tracer({ dataDir, requestId, pipelineName });
    tracer.recordEnvelope({
      requestId,
      phaseId: "phase-1",
      agent: "planner",
      outputType: "plan",
      payloadJson: '{"bad": "json"',
      valid: false,
      attempt: 1,
    });

    const db = new Database(path.join(dataDir, "trace.db"), { readonly: true });
    const row = db
      .prepare("SELECT valid, payload_json FROM envelopes WHERE request_id=?")
      .get(requestId) as { valid: number; payload_json: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.valid).toBe(0);
    expect(row!.payload_json).toBe('{"bad": "json"');
    db.close();
    tracer.close();
  });
});

describe("DoD prompt round-trip", () => {
  test("prompt events for system and user round-trip byte-identical", () => {
    const tracer = new Tracer({ dataDir, requestId, pipelineName });

    const systemPayload = JSON.stringify({
      role: "system" as const,
      agent: "architect",
      phase_id: "phase-1",
      text: "You are a system architect. Design the solution.",
    });
    tracer.trace({
      requestId,
      phaseId: "phase-1",
      type: "prompt",
      name: "system-prompt-1",
      payloadJson: systemPayload,
    });

    const userPayload = JSON.stringify({
      role: "user" as const,
      agent: "coder",
      phase_id: "phase-2",
      text: "Implement the feature.",
    });
    tracer.trace({
      requestId,
      phaseId: "phase-2",
      type: "prompt",
      name: "user-prompt-1",
      payloadJson: userPayload,
    });

    const db = new Database(path.join(dataDir, "trace.db"), { readonly: true });
    const rows = db
      .prepare(
        "SELECT type, payload_json FROM events WHERE request_id=? ORDER BY rowid",
      )
      .all(requestId) as { type: string; payload_json: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.type).toBe("prompt");
    expect(rows[0]!.payload_json).toBe(systemPayload);
    expect(rows[1]!.type).toBe("prompt");
    expect(rows[1]!.payload_json).toBe(userPayload);
    db.close();
    tracer.close();
  });
});

describe("AC5: degraded write continues run", () => {
  test("SQLite failure: JSONL already on disk, error callback, no throw, run continues", () => {
    let receivedError: TracerError | null = null;
    const tracer = new Tracer({
      dataDir,
      requestId,
      pipelineName,
      onTraceError: (err: TracerError) => {
        receivedError = err;
      },
    });

    const dbPath = path.join(dataDir, "trace.db");
    fs.chmodSync(dbPath, 0o444);

    const eventPayload = JSON.stringify({ test: "data" });
    expect(() =>
      tracer.trace({
        requestId,
        type: "log",
        name: "test-event",
        payloadJson: eventPayload,
      }),
    ).not.toThrow();

    const jsonlPath = path.join(dataDir, "events.jsonl");
    const jsonlContent = fs.readFileSync(jsonlPath, "utf-8");
    const lines = jsonlContent.trim().split("\n");
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toBeDefined();
    const parsed = JSON.parse(lastLine!);
    expect(parsed.payload_json).toBe(eventPayload);

    expect(receivedError).toBeDefined();
    expect(receivedError!.code).toBeDefined();
    expect(receivedError!.message).toBeDefined();

    fs.chmodSync(dbPath, 0o600);

    tracer.trace({
      requestId,
      type: "log",
      name: "post-recovery-event",
      payloadJson: JSON.stringify({ recovered: true }),
    });

    const jsonlAfter = fs.readFileSync(jsonlPath, "utf-8");
    const linesAfter = jsonlAfter.trim().split("\n");
    expect(linesAfter.length).toBeGreaterThanOrEqual(2);

    tracer.close();
  });
});

describe("INV-1: boundary refusal and file modes", () => {
  test("symlink outside data boundary throws, no db created", () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    const symlinkDir = path.join(markerRoot, "symlink-to-outside");
    fs.symlinkSync(outsideDir, symlinkDir);

    expect(
      () =>
        new Tracer({
          dataDir: symlinkDir,
          requestId,
          pipelineName,
        }),
    ).toThrow(TracerError);

    expect(fs.existsSync(path.join(outsideDir, "trace.db"))).toBe(false);

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  test("symlinked final data-dir component is rejected even when it resolves inside the boundary", () => {
    // An alias resolving INSIDE the boundary passes the realpath containment
    // check — the no-follow pin must still refuse it: a final component that
    // is a symlink today can be re-pointed outside tomorrow, and every later
    // open must go through the verified, non-symlinked directory.
    const realRun = path.join(markerRoot, "real-run");
    fs.mkdirSync(realRun, { recursive: true });
    const alias = path.join(markerRoot, "alias");
    fs.symlinkSync(realRun, alias);

    expect(
      () =>
        new Tracer({
          dataDir: alias,
          requestId,
          pipelineName,
        }),
    ).toThrow(TracerError);
  });

  test("pre-existing trace.db symlink is rejected before sqlite opens it", () => {
    fs.mkdirSync(dataDir, { recursive: true });
    const outsideDb = path.join(os.tmpdir(), `outside-db-${Date.now()}`);
    fs.writeFileSync(outsideDb, "not a real db");
    fs.symlinkSync(outsideDb, path.join(dataDir, "trace.db"));

    expect(
      () =>
        new Tracer({
          dataDir,
          requestId,
          pipelineName,
        }),
    ).toThrow(TracerError);

    expect(fs.existsSync(path.join(dataDir, "trace.db"))).toBe(true); // symlink untouched
    fs.rmSync(outsideDb, { force: true });
  });

  test("data dir created with mode 0700, db and jsonl mode 0600", () => {
    const tracer = new Tracer({ dataDir, requestId, pipelineName });

    const stat = fs.statSync(dataDir);
    expect(stat.mode & 0o777).toBe(0o700);

    const dbStat = fs.statSync(path.join(dataDir, "trace.db"));
    expect(dbStat.mode & 0o777).toBe(0o600);

    const jsonlStat = fs.statSync(path.join(dataDir, "events.jsonl"));
    expect(jsonlStat.mode & 0o777).toBe(0o600);

    tracer.close();
  });
});

describe("DoD: WAL/SHM sidecar modes", () => {
  test("db, wal, shm, jsonl all mode 0600 when sidecars exist", () => {
    const tracer = new Tracer({ dataDir, requestId, pipelineName });

    for (let i = 0; i < 10; i++) {
      tracer.trace({
        requestId,
        type: "log",
        name: `fill-event-${i}`,
        payloadJson: JSON.stringify({ i }),
      });
    }

    const dbPath = path.join(dataDir, "trace.db");
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    const jsonlPath = path.join(dataDir, "events.jsonl");

    if (fs.existsSync(walPath)) {
      expect(fs.statSync(walPath).mode & 0o777).toBe(0o600);
    }
    if (fs.existsSync(shmPath)) {
      expect(fs.statSync(shmPath).mode & 0o777).toBe(0o600);
    }
    expect(fs.statSync(dbPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(jsonlPath).mode & 0o777).toBe(0o600);

    tracer.close();
  });
});

describe("Processes: record, end, endAll", () => {
  test("recordProcess inserts with ended_at NULL", () => {
    const tracer = new Tracer({ dataDir, requestId, pipelineName });
    tracer.recordProcess({
      requestId,
      kind: "agent",
      pid: 12345,
      command: "claude-opus-5",
    });

    const db = new Database(path.join(dataDir, "trace.db"), { readonly: true });
    const row = db
      .prepare("SELECT ended_at FROM processes WHERE request_id=? AND pid=?")
      .get(requestId, 12345) as { ended_at: string | null };
    expect(row.ended_at).toBeNull();
    db.close();
    tracer.close();
  });

  test("endProcess sets ended_at", () => {
    const tracer = new Tracer({ dataDir, requestId, pipelineName });
    tracer.recordProcess({
      requestId,
      kind: "agent",
      pid: 12345,
      command: "claude-opus-5",
    });

    tracer.endProcess({
      requestId,
      pid: 12345,
      endedAt: "2026-08-15T12:34:56.789Z",
    });

    const db = new Database(path.join(dataDir, "trace.db"), { readonly: true });
    const row = db
      .prepare("SELECT ended_at FROM processes WHERE request_id=? AND pid=?")
      .get(requestId, 12345) as { ended_at: string };
    expect(row.ended_at).toBe("2026-08-15T12:34:56.789Z");
    db.close();
    tracer.close();
  });

  test("processesEndAll sets ended_at for all NULL rows of that requestId", () => {
    const tracer = new Tracer({ dataDir, requestId, pipelineName });
    tracer.recordProcess({
      requestId,
      kind: "agent",
      pid: 12345,
      command: "claude-opus-5",
    });
    tracer.recordProcess({
      requestId,
      kind: "agent",
      pid: 12346,
      command: "claude-sonnet-5",
    });

    const otherReqId = "other-req-1";
    tracer.recordProcess({
      requestId: otherReqId,
      kind: "agent",
      pid: 12347,
      command: "claude-haiku-4",
    });

    tracer.processesEndAll(requestId);

    const db = new Database(path.join(dataDir, "trace.db"), { readonly: true });
    const rows = db
      .prepare("SELECT pid, ended_at FROM processes ORDER BY pid")
      .all() as Array<{ pid: number; ended_at: string | null }>;
    expect(rows).toHaveLength(3);
    expect(rows[0]?.pid).toBe(12345);
    expect(rows[0]?.ended_at).not.toBeNull();
    expect(rows[1]?.pid).toBe(12346);
    expect(rows[1]?.ended_at).not.toBeNull();
    expect(rows[2]?.pid).toBe(12347);
    expect(rows[2]?.ended_at).toBeNull();
    db.close();
    tracer.close();
  });
});

describe("Dual-write order: JSONL then SQLite", () => {
  test("after trace(), events.jsonl last line matches inserted event row", () => {
    const tracer = new Tracer({ dataDir, requestId, pipelineName });

    const payloadJson = JSON.stringify({ test: "dual-write-order" });
    tracer.trace({
      requestId,
      phaseId: "phase-1",
      type: "log",
      name: "order-test",
      payloadJson,
    });

    const jsonlPath = path.join(dataDir, "events.jsonl");
    const jsonlContent = fs.readFileSync(jsonlPath, "utf-8");
    const lines = jsonlContent.trim().split("\n");
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toBeDefined();
    const lastEvent = JSON.parse(lastLine!);

    const db = new Database(path.join(dataDir, "trace.db"), { readonly: true });
    const row = db
      .prepare("SELECT payload_json FROM events WHERE request_id=? ORDER BY rowid DESC LIMIT 1")
      .get(requestId) as { payload_json: string };
    expect(row.payload_json).toBe(payloadJson);
    expect(lastEvent.payload_json).toBe(payloadJson);
    db.close();
    tracer.close();
  });
});

describe("F1: upsertPhase error preservation", () => {
  test("writePhase with error followed by promotePhase without error preserves error and ended_at", () => {
    const tracer = new Tracer({ dataDir, requestId, pipelineName });
    const phaseId = "phase-error-test";

    // Simulate writePhase (settle with error)
    tracer.upsertPhase({
      requestId,
      phaseId,
      seq: 1,
      name: "build",
      kind: "build",
      description: "build phase",
      status: "fail",
      attempt: 1,
      retries: 0,
      error: "compilation failed",
      startedAt: "2026-08-15T10:00:00.000Z",
      endedAt: "2026-08-15T10:05:00.000Z",
    });

    // Simulate promotePhase (without error, with new endedAt)
    tracer.upsertPhase({
      requestId,
      phaseId,
      seq: 1,
      name: "build",
      kind: "build",
      status: "fail",
      attempt: 1,
      retries: 0,
      // No error passed - should NOT clobber the settled error
      startedAt: "2026-08-15T10:00:00.000Z",
      endedAt: "2026-08-15T10:06:00.000Z", // New endedAt
    });

    const db = new Database(path.join(dataDir, "trace.db"), { readonly: true });
    const row = db
      .prepare("SELECT error, ended_at FROM phases WHERE phase_id=?")
      .get(phaseId) as { error: string | null; ended_at: string | null };

    expect(row).toBeDefined();
    // Error from settle should be preserved (not clobbered to NULL)
    expect(row.error).toBe("compilation failed");
    // ended_at from promote should be set (new endedAt preserved)
    expect(row.ended_at).toBe("2026-08-15T10:06:00.000Z");

    db.close();
    tracer.close();
  });

  test("upsertPhase preserves ended_at when later call omits it", () => {
    const tracer = new Tracer({ dataDir, requestId, pipelineName });
    const phaseId = "phase-ended-at-test";

    // First call with endedAt
    tracer.upsertPhase({
      requestId,
      phaseId,
      seq: 1,
      name: "test",
      kind: "test",
      status: "success",
      startedAt: "2026-08-15T11:00:00.000Z",
      endedAt: "2026-08-15T11:10:00.000Z",
    });

    // Second call without endedAt (should preserve)
    tracer.upsertPhase({
      requestId,
      phaseId,
      seq: 1,
      name: "test",
      kind: "test",
      status: "success",
      startedAt: "2026-08-15T11:00:00.000Z",
      // No endedAt
    });

    const db = new Database(path.join(dataDir, "trace.db"), { readonly: true });
    const row = db
      .prepare("SELECT ended_at FROM phases WHERE phase_id=?")
      .get(phaseId) as { ended_at: string };

    expect(row.ended_at).toBe("2026-08-15T11:10:00.000Z");

    db.close();
    tracer.close();
  });
});

describe("F2: observability contract", () => {
  test("SQLite failure emits error with timestamp, durationMs, jsonlWriteMs, sqliteInsertMs, and phase", () => {
    let receivedError: TracerError | null = null;
    const tracer = new Tracer({
      dataDir,
      requestId,
      pipelineName,
      onTraceError: (err: TracerError) => {
        receivedError = err;
      },
    });

    const dbPath = path.join(dataDir, "trace.db");
    fs.chmodSync(dbPath, 0o444);

    tracer.trace({
      requestId,
      phaseId: "phase-obs-test",
      type: "log",
      name: "obs-test",
      payloadJson: JSON.stringify({ test: "observability" }),
    });

    fs.chmodSync(dbPath, 0o600);

    expect(receivedError).toBeDefined();
    expect(receivedError!.code).toBe("SQLITE_WRITE");
    expect(receivedError!.table).toBe("events");

    // F2: timestamp should be ISO string
    expect(receivedError!.timestamp).toBeDefined();
    const timestamp = new Date(receivedError!.timestamp!);
    expect(Number.isNaN(timestamp.getTime())).toBe(false);

    // F2: durationMs, jsonlWriteMs, sqliteInsertMs all >= 0
    expect(receivedError!.durationMs).toBeGreaterThanOrEqual(0);
    expect(receivedError!.jsonlWriteMs).toBeGreaterThanOrEqual(0);
    expect(receivedError!.sqliteInsertMs).toBeGreaterThanOrEqual(0);

    // F2: phase should equal the event's phaseId
    expect(receivedError!.phase).toBe("phase-obs-test");

    tracer.close();
  });
});

describe("F5: pid guard", () => {
  test("recordProcess rejects pid 0, pid -1, and pid 1.5 with INVALID_INPUT", () => {
    let receivedError: TracerError | null = null;
    const tracer = new Tracer({
      dataDir,
      requestId,
      pipelineName,
      onTraceError: (err: TracerError) => {
        receivedError = err;
      },
    });

    // Test pid 0
    receivedError = null;
    tracer.recordProcess({
      requestId,
      kind: "agent",
      pid: 0,
      command: "test-zero",
    });
    expect(receivedError).toBeDefined();
    expect(receivedError!.code).toBe("INVALID_INPUT");
    expect(receivedError!.message).toContain("0");

    // Test pid -1
    receivedError = null;
    tracer.recordProcess({
      requestId,
      kind: "agent",
      pid: -1,
      command: "test-negative",
    });
    expect(receivedError).toBeDefined();
    expect(receivedError!.code).toBe("INVALID_INPUT");
    expect(receivedError!.message).toContain("-1");

    // Test pid 1.5 (non-integer)
    receivedError = null;
    tracer.recordProcess({
      requestId,
      kind: "agent",
      pid: 1.5,
      command: "test-float",
    });
    expect(receivedError).toBeDefined();
    expect(receivedError!.code).toBe("INVALID_INPUT");
    expect(receivedError!.message).toContain("1.5");

    // Verify no rows inserted for invalid pids
    const db = new Database(path.join(dataDir, "trace.db"), { readonly: true });
    const rows = db
      .prepare("SELECT COUNT(*) as count FROM processes WHERE request_id=?")
      .get(requestId) as { count: number };
    expect(rows.count).toBe(0);
    db.close();

    tracer.close();
  });

  test("recordProcess accepts valid pid 1", () => {
    let receivedError: TracerError | null = null;
    const tracer = new Tracer({
      dataDir,
      requestId,
      pipelineName,
      onTraceError: (err: TracerError) => {
        receivedError = err;
      },
    });

    tracer.recordProcess({
      requestId,
      kind: "agent",
      pid: 1,
      command: "test-valid",
    });

    // No error should be emitted
    expect(receivedError).toBeNull();

    // Verify row inserted
    const db = new Database(path.join(dataDir, "trace.db"), { readonly: true });
    const row = db
      .prepare("SELECT pid, command FROM processes WHERE request_id=?")
      .get(requestId) as { pid: number; command: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.pid).toBe(1);
    expect(row!.command).toBe("test-valid");
    db.close();

    tracer.close();
  });
});

describe("serializeTraceError (shared sink contract)", () => {
  test("maps full TracerError to snake_case log fields verbatim", () => {
    const full = new TracerError({
      code: "SQLITE_WRITE",
      message: "database is closed",
      table: "phases",
      statement: "INSERT INTO phases (...) VALUES (...)",
      phase: "plan",
      agentId: "agent-1",
      timestamp: "2024-01-01T00:00:00.000Z",
      durationMs: 42,
      jsonlWriteMs: 1,
      sqliteInsertMs: 2,
    });
    expect(serializeTraceError(full)).toEqual({
      phase: "plan",
      agentId: "agent-1",
      table: "phases",
      statement: "INSERT INTO phases (...) VALUES (...)",
      timestamp: "2024-01-01T00:00:00.000Z",
      durationMs: 42,
      jsonl_write_ms: 1,
      sqlite_insert_ms: 2,
    });
  });

  test("fills defaults for absent optional fields (null / 0 / clock timestamp)", () => {
    const bare = new TracerError({ code: "SQLITE_WRITE", message: "boom" });
    const out = serializeTraceError(bare);
    expect(out.phase).toBeNull();
    expect(out.agentId).toBeNull();
    expect(out.table).toBeNull();
    expect(out.statement).toBeNull();
    expect(out.durationMs).toBe(0);
    expect(out.jsonl_write_ms).toBe(0);
    expect(out.sqlite_insert_ms).toBe(0);
    // Filled from wall clock when absent — ISO-8601 shape
    expect(out.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("F030: containment boundary fires without QDS_RUN_ROOT", () => {
  test("a data dir outside the derived boundary is refused even with QDS_RUN_ROOT unset", () => {
    // biome-ignore lint/performance/noDelete: delete is the only correct way to restore "not set"
    delete process.env.QDS_RUN_ROOT;
    // Boundary falls back to /run (journal.ts runMarkerRoot), so a tmpdir path
    // is outside it — on hosts without /run the refusal is "root does not exist".
    expect(() => new Tracer({ dataDir, requestId, pipelineName })).toThrow(/boundary/);
    expect(fs.existsSync(path.join(dataDir, "trace.db"))).toBe(false);
  });

  test("an explicit boundaryRoot overrides the env-derived one", () => {
    // biome-ignore lint/performance/noDelete: delete is the only correct way to restore "not set"
    delete process.env.QDS_RUN_ROOT;
    const tracer = new Tracer({ dataDir, requestId, pipelineName, boundaryRoot: markerRoot });
    expect(fs.existsSync(path.join(dataDir, "trace.db"))).toBe(true);
    tracer.close();
  });

  test("an explicit boundaryRoot still refuses a path outside it", () => {
    process.env.QDS_RUN_ROOT = markerRoot; // permissive env must not rescue it
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, "outside-")));
    expect(
      () => new Tracer({ dataDir, requestId, pipelineName, boundaryRoot: outside }),
    ).toThrow(/boundary/);
  });
});

describe("F031: prepared statements are memoized and finalized", () => {
  /**
   * Counts `prepare` calls and `finalize` calls on every statement handed out
   * after installation. Construction-time prepares (migrations' PRAGMA
   * table_info) are excluded by installing the spy after the Tracer is open.
   */
  function spyOnPrepare(): { prepared: () => number; finalized: () => number; restore: () => void } {
    const original = Database.prototype.prepare;
    let prepared = 0;
    let finalized = 0;
    Database.prototype.prepare = function patched(this: Database, ...args: unknown[]) {
      prepared++;
      const stmt = (original as any).apply(this, args);
      const origFinalize = stmt.finalize.bind(stmt);
      stmt.finalize = () => {
        finalized++;
        return origFinalize();
      };
      return stmt;
    } as any;
    return {
      prepared: () => prepared,
      finalized: () => finalized,
      restore: () => {
        Database.prototype.prepare = original;
      },
    };
  }

  test("close() finalizes every statement prepared after open", () => {
    const tracer = new Tracer({ dataDir, requestId, pipelineName });
    const spy = spyOnPrepare();
    try {
      const evt = { requestId, phaseId: "p1", type: "log", name: "e" };
      tracer.trace(evt);
      tracer.trace(evt);
      tracer.recordGateResult({
        requestId,
        phaseId: "p1",
        attempt: 1,
        gate: "g",
        passed: true,
        violations: [],
        checks: [],
      });
      tracer.close();
      expect(spy.prepared()).toBeGreaterThan(0);
      expect(spy.finalized()).toBe(spy.prepared());
    } finally {
      spy.restore();
    }
  });

  test("1000 traced events compile the INSERT exactly once", () => {
    const tracer = new Tracer({ dataDir, requestId, pipelineName });
    const spy = spyOnPrepare();
    try {
      for (let i = 0; i < 1000; i++) {
        tracer.trace({ requestId, phaseId: "p1", type: "log", name: `e${i}` });
      }
      expect(spy.prepared()).toBe(1);
    } finally {
      spy.restore();
      tracer.close();
    }
  });
});
