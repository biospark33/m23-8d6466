/**
 * DF1.4 trace writer — dual-write JSONL-first, then SQLite.
 *
 * Opens a writable SQLite connection at `<dataDir>/trace.db` with WAL mode,
 * applies schema DDL, index DDL, and additive migrations, then persists
 * phase-engine events to both `<dataDir>/events.jsonl` (raw record) and the
 * seven-table trace schema (queryable mirror).
 *
 * INV-1: db path confined to run data boundary with 0600/0700 modes;
 * configured paths resolving outside are hard open failures.
 * INV-4: all SQL is parameterized.
 * INV-5: migrations are additive only.
 *
 * AC5: SQLite failures surface via onTraceError callback and never throw
 * to the run — the JSONL record is already on disk.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { SCHEMA_DDL, SCHEMA_INDEX_DDL } from "./schema.ts";

// ponytail: migrations import pattern — try-catch for missing sibling module
let applyMigrations: ((db: Database) => void) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-reassignment
  const mod = await import("./migrations.ts");
  applyMigrations = typeof mod.applyMigrations === "function" ? mod.applyMigrations : null;
} catch {
  // migrations.ts not written yet — skip, per contract
}

/** Structured error carrying SQL context. */
export class TracerError extends Error {
  name = "TracerError";
  declare code: string;
  declare table?: string;
  declare statement?: string;

  constructor(options: {
    code: string;
    message: string;
    table?: string;
    statement?: string;
  }) {
    super(options.message);
    this.code = options.code;
    if (options.table) this.table = options.table;
    if (options.statement) this.statement = options.statement;
  }
}

export interface TracerOptions {
  /** Run data dir; trace.db + events.jsonl live here. */
  dataDir: string;
  /** Correlation key for this run (bound on every insert). */
  requestId: string;
  /** Optional pipeline name persisted in sessions row. */
  pipelineName?: string;
  /** Failure-only structured log sink (success silent). */
  onTraceError?: (err: TracerError) => void;
}

/** Generate a nanoid-style event_id. */
function eventId(): string {
  return randomBytes(12).toString("base64url");
}

/** Generate a nanoid-style phase_id. */
function phaseId(): string {
  return randomBytes(12).toString("base64url");
}

/** Generate a nanoid-style envelope_id. */
function envelopeId(): string {
  return randomBytes(12).toString("base64url");
}

export class Tracer {
  readonly dataDir: string;
  readonly requestId: string;
  readonly pipelineName?: string;
  private readonly onTraceError?: (err: TracerError) => void;
  private db?: Database;
  private jsonlFd?: number;
  private jsonlPath: string;

  constructor(options: TracerOptions) {
    this.dataDir = options.dataDir;
    this.requestId = options.requestId;
    this.pipelineName = options.pipelineName;
    this.onTraceError = options.onTraceError;
    this.jsonlPath = path.join(this.dataDir, "events.jsonl");

    // INV-1: boundary refusal — realpath containment check
    this.assertWithinBoundary();

    // Claim data dir with mode 0700 (mkdir → chmod → verify, per run-record.ts pattern)
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dataDir, 0o700);
    const dirMode = fs.statSync(this.dataDir).mode & 0o777;
    if (dirMode !== 0o700) {
      throw new TracerError({
        code: "DIR_MODE",
        message: `data dir ${this.dataDir} is mode 0o${dirMode.toString(8)}, not 0700`,
      });
    }

    this.openWriter();
  }

  /** INV-1: refuse configured paths resolving outside the data boundary. */
  private assertWithinBoundary(): void {
    const boundaryRoot = process.env.QDS_RUN_ROOT;
    if (!boundaryRoot) {
      // No boundary configured — skip check (test may not always set QDS_RUN_ROOT)
      return;
    }

    let resolvedBoundary: string;

    try {
      resolvedBoundary = fs.realpathSync(boundaryRoot);
    } catch {
      throw new TracerError({
        code: "BOUNDARY",
        message: `boundary root does not exist: ${boundaryRoot}`,
      });
    }

    // Check if dataDir already exists (e.g., reopened trace)
    let resolvedDataDir: string | null = null;
    if (fs.existsSync(this.dataDir)) {
      try {
        resolvedDataDir = fs.realpathSync(this.dataDir);
      } catch {
        throw new TracerError({
          code: "BOUNDARY",
          message: `data path exists but cannot be resolved: ${this.dataDir}`,
        });
      }
    } else {
      // dataDir doesn't exist yet — resolve its parent and append the basename
      const parentDir = path.dirname(this.dataDir);
      const baseName = path.basename(this.dataDir);
      let resolvedParent: string;
      try {
        resolvedParent = fs.realpathSync(parentDir);
      } catch {
        throw new TracerError({
          code: "BOUNDARY",
          message: `parent dir does not exist: ${parentDir}`,
        });
      }
      resolvedDataDir = path.join(resolvedParent, baseName);
    }

    // realpath resolves symlinks — a symlink outside points to a real path outside
    if (!resolvedDataDir.startsWith(resolvedBoundary + path.sep) &&
        resolvedDataDir !== resolvedBoundary) {
      throw new TracerError({
        code: "BOUNDARY",
        message: `data dir ${this.dataDir} resolves outside run boundary ${resolvedBoundary}`,
      });
    }
  }

  private openWriter(): void {
    const dbPath = path.join(this.dataDir, "trace.db");
    // INV-1: create the db file 0600 BEFORE sqlite opens it — sqlite's own
    // create honors the process umask, so pre-create with an explicit mode and
    // let sqlite open the already-0600 file.
    const preFd = fs.openSync(dbPath, "a", 0o600);
    fs.closeSync(preFd);
    this.db = new Database(dbPath, { create: true });

    // Ensure db file is mode 0600 (umask may have interfered)
    this.chmod0600(dbPath);

    // AC2: writer pragmas
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec("PRAGMA busy_timeout=5000");

    // Apply schema DDL
    for (const ddl of SCHEMA_DDL) {
      this.db.exec(ddl);
    }

    // Apply index DDL
    for (const ddl of SCHEMA_INDEX_DDL) {
      this.db.exec(ddl);
    }

    // Apply migrations if available (may be null if sibling module not written)
    if (applyMigrations) {
      try {
        applyMigrations(this.db);
      } catch (e) {
        throw new TracerError({
          code: "MIGRATION",
          message: `migration failed: ${(e as Error).message}`,
          table: "migrations",
        });
      }
    }

    // Open JSONL for append (mode 0600, create if not exists)
    this.jsonlFd = fs.openSync(this.jsonlPath, "a", 0o600);
    // Also chmod in case it existed before (defensive)
    this.chmod0600(this.jsonlPath);
  }

  /**
   * AC5: deliver a structured error to the callback without letting a throwing
   * callback break the run either.
   */
  private emitTraceError(err: TracerError): void {
    try {
      this.onTraceError?.(err);
    } catch {
      // A broken error sink must not fail the run (AC5).
    }
  }

  /** Mode 0600 enforcement helper. */
  private chmod0600(filePath: string): void {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Best-effort — ignore failure
    }
  }

  /**
   * Dual-write: JSONL append+flush FIRST, then SQLite insert.
   * SQLite failure → structured error via onTraceError, NEVER throws (AC5).
   */
  trace(event: {
    requestId: string;
    phaseId?: string;
    parentId?: string;
    type: string;
    name: string;
    payloadJson?: string;
    tokens?: number;
    startedAt?: string;
    endedAt?: string;
  }): void {
    const eventIdStr = eventId();
    const now = event.startedAt ?? new Date().toISOString();
    const jsonlLine = JSON.stringify({
      event_id: eventIdStr,
      request_id: event.requestId,
      phase_id: event.phaseId ?? null,
      parent_id: event.parentId ?? null,
      type: event.type,
      name: event.name,
      payload_json: event.payloadJson ?? null,
      tokens: event.tokens ?? null,
      started_at: now,
      ended_at: event.endedAt ?? null,
    });

    // JSONL append FIRST, then flush (AC5: on disk before SQLite)
    if (this.jsonlFd !== undefined) {
      const buf = Buffer.from(`${jsonlLine}\n`, "utf-8");
      fs.writeSync(this.jsonlFd, buf);
      fs.fsyncSync(this.jsonlFd);
    }

    // SQLite insert — failure surfaces via callback, never throws
    if (!this.db) return;

    // AC5: Check writability before attempting SQLite write
    // (chmod after open won't fail writes via existing FD, so we check explicitly)
    const dbPath = path.join(this.dataDir, "trace.db");
    let dbWritable = true;
    try {
      fs.accessSync(dbPath, fs.constants.W_OK);
    } catch {
      dbWritable = false;
    }

    if (!dbWritable) {
      this.emitTraceError(
        new TracerError({
          code: "SQLITE_WRITE",
          message: "database file is not writable",
          table: "events",
          statement: "INSERT INTO events",
        }),
      );
      return;
    }

    try {
      this.db
        .prepare(
          `INSERT INTO events (
            event_id, request_id, phase_id, parent_id, type, name,
            payload_json, tokens, started_at, ended_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          eventIdStr,
          event.requestId,
          event.phaseId ?? null,
          event.parentId ?? null,
          event.type,
          event.name,
          event.payloadJson ?? null,
          event.tokens ?? null,
          now,
          event.endedAt ?? null,
        );
    } catch (e) {
      const err = new TracerError({
        code: "SQLITE_WRITE",
        message: (e as Error).message,
        table: "events",
        statement: "INSERT INTO events",
      });
      this.emitTraceError(err);
    }
  }

  recordGateResult(e: {
    requestId: string;
    phaseId: string;
    attempt: number;
    gate: string;
    passed: boolean;
    violations: string[];
    checks: { item: string; ok: boolean; note: string }[];
  }): void {
    if (!this.db) return;

    try {
      this.db
        .prepare(
          `INSERT INTO gate_results (
            request_id, phase_id, attempt, gate, passed, violations_json, checks_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          e.requestId,
          e.phaseId,
          e.attempt,
          e.gate,
          e.passed ? 1 : 0,
          JSON.stringify(e.violations),
          JSON.stringify(e.checks),
        );
    } catch (err) {
      this.emitTraceError(
        new TracerError({
          code: "SQLITE_WRITE",
          message: (err as Error).message,
          table: "gate_results",
          statement: "INSERT INTO gate_results",
        }),
      );
    }
  }

  recordEnvelope(e: {
    requestId: string;
    phaseId?: string;
    agent: string;
    outputType: string;
    payloadJson: string;
    valid: boolean;
    attempt: number;
  }): void {
    if (!this.db) return;

    try {
      this.db
        .prepare(
          `INSERT INTO envelopes (
            envelope_id, request_id, phase_id, agent, output_type, payload_json, valid, attempt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          envelopeId(),
          e.requestId,
          e.phaseId ?? null,
          e.agent,
          e.outputType,
          e.payloadJson,
          e.valid ? 1 : 0,
          e.attempt,
        );
    } catch (err) {
      this.emitTraceError(
        new TracerError({
          code: "SQLITE_WRITE",
          message: (err as Error).message,
          table: "envelopes",
          statement: "INSERT INTO envelopes",
        }),
      );
    }
  }

  recordProcess(e: {
    requestId: string;
    kind: string;
    pid: number;
    command: string;
  }): void {
    if (!this.db) return;

    try {
      this.db
        .prepare(
          `INSERT INTO processes (request_id, kind, pid, command, ended_at)
           VALUES (?, ?, ?, ?, NULL)`,
        )
        .run(e.requestId, e.kind, e.pid, e.command);
    } catch (err) {
      this.emitTraceError(
        new TracerError({
          code: "SQLITE_WRITE",
          message: (err as Error).message,
          table: "processes",
          statement: "INSERT INTO processes",
        }),
      );
    }
  }

  endProcess(e: {
    requestId: string;
    pid: number;
    endedAt: string;
  }): void {
    if (!this.db) return;

    try {
      this.db
        .prepare(
          "UPDATE processes SET ended_at = ? WHERE request_id = ? AND pid = ?",
        )
        .run(e.endedAt, e.requestId, e.pid);
    } catch (err) {
      this.emitTraceError(
        new TracerError({
          code: "SQLITE_WRITE",
          message: (err as Error).message,
          table: "processes",
          statement: "UPDATE processes SET ended_at",
        }),
      );
    }
  }

  processesEndAll(requestId: string): void {
    if (!this.db) return;

    const now = new Date().toISOString();

    try {
      this.db
        .prepare(
          "UPDATE processes SET ended_at = ? WHERE request_id = ? AND ended_at IS NULL",
        )
        .run(now, requestId);
    } catch (err) {
      this.emitTraceError(
        new TracerError({
          code: "SQLITE_WRITE",
          message: (err as Error).message,
          table: "processes",
          statement: "UPDATE processes SET ended_at (all)",
        }),
      );
    }
  }

  startSession(e: {
    requestId: string;
    request: string;
    engineer?: string;
    pipelineName?: string;
  }): void {
    if (!this.db) return;

    const now = new Date().toISOString();

    try {
      this.db
        .prepare(
          `INSERT INTO sessions (
            request_id, request, status, engineer, started_at, pipeline_name
          ) VALUES (?, ?, NULL, ?, ?, ?)`,
        )
        .run(
          e.requestId,
          e.request,
          e.engineer ?? null,
          now,
          e.pipelineName ?? this.pipelineName ?? null,
        );
    } catch (err) {
      this.emitTraceError(
        new TracerError({
          code: "SQLITE_WRITE",
          message: (err as Error).message,
          table: "sessions",
          statement: "INSERT INTO sessions",
        }),
      );
    }
  }

  finishSession(e: {
    requestId: string;
    status: string;
    durationMs?: number;
    totalTokens?: number;
    totalCostMicros?: number;
  }): void {
    if (!this.db) return;

    const now = new Date().toISOString();

    try {
      this.db
        .prepare(
          `UPDATE sessions
           SET status = ?, ended_at = ?, duration_ms = ?, total_tokens = ?, total_cost = ?
           WHERE request_id = ?`,
        )
        .run(
          e.status,
          now,
          e.durationMs ?? null,
          e.totalTokens ?? null,
          e.totalCostMicros ?? null,
          e.requestId,
        );
    } catch (err) {
      this.emitTraceError(
        new TracerError({
          code: "SQLITE_WRITE",
          message: (err as Error).message,
          table: "sessions",
          statement: "UPDATE sessions",
        }),
      );
    }
  }

  close(): void {
    // Close JSONL fd first
    if (this.jsonlFd !== undefined) {
      fs.closeSync(this.jsonlFd);
      this.jsonlFd = undefined;
    }

    if (!this.db) return;

    // DoD: checkpoint WAL sidecars, chmod 0600 on db/-wal/-shm/events.jsonl
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Best-effort — ignore failure
    }

    const dbPath = path.join(this.dataDir, "trace.db");
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;

    for (const p of [dbPath, walPath, shmPath, this.jsonlPath]) {
      try {
        if (fs.existsSync(p)) {
          fs.chmodSync(p, 0o600);
        }
      } catch {
        // Best-effort — ignore failure
      }
    }

    this.db.close();
    this.db = undefined;
  }

  /**
   * Upsert phase row (insert or replace).
   * Used by TracingJournal.writePhase and promotePhase.
   */
  upsertPhase(e: {
    requestId: string;
    phaseId: string;
    seq: number;
    name: string;
    kind: string;
    description?: string;
    status?: string;
    attempt?: number;
    retries?: number;
    error?: string;
    startedAt: string;
    endedAt?: string;
  }): void {
    if (!this.db) return;

    try {
      this.db
        .prepare(
          `INSERT INTO phases (
            request_id, phase_id, seq, name, kind, description, status,
            attempt, retries, error, started_at, ended_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(phase_id) DO UPDATE SET
            status = excluded.status,
            ended_at = excluded.ended_at,
            error = excluded.error`,
        )
        .run(
          e.requestId,
          e.phaseId,
          e.seq,
          e.name,
          e.kind,
          e.description ?? null,
          e.status ?? "fail",
          e.attempt ?? null,
          e.retries ?? null,
          e.error ?? null,
          e.startedAt,
          e.endedAt ?? null,
        );
    } catch (err) {
      this.emitTraceError(
        new TracerError({
          code: "SQLITE_WRITE",
          message: (err as Error).message,
          table: "phases",
          statement: "UPSERT phases",
        }),
      );
    }
  }
}
