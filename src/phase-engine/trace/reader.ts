/**
 * Trace reader (Story DF1.4).
 *
 * Readonly rowid-cursor reader for the trace store. Opens with readonly=true,
 * asserts WAL journal mode, and handles schema drift via optionalColumn probing.
 *
 * Ported from SSSF reference db.ts lines 77-124, 362-384.
 */
import Database from "bun:sqlite";
import type {
  EventPage,
  TraceEventRow,
  TraceSessionRow,
} from "../types.ts";

export const MAX_LIMIT = 1000;
export const DEFAULT_LIMIT = 500;

export interface TraceReader {
  readEvents(requestId: string, cursor?: number, limit?: number): EventPage;
  readSession(requestId: string): TraceSessionRow | null;
  close(): void;
}

/**
 * Column presence cache for optionalColumn probe.
 * Cache key: "table.column". Only ever false → true (latches).
 * Ported from SSSF db.ts lines 64-65, 111-124.
 */
type ColumnCache = Map<string, boolean>;

class TraceReaderImpl implements TraceReader {
  private dbPath: string;
  private db: Database | null = null;
  private readonly columnCache: ColumnCache = new Map();

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    // Try to open database eagerly for WAL warning timing with tests
    // If file doesn't exist, fall back to lazy opening (test deviation)
    try {
      this.db = new Database(dbPath, { readonly: true });
      this.configureDb();
    } catch {
      // File doesn't exist yet; will open lazily on first read
    }
  }

  /**
   * Configure database pragmas and assert journal_mode.
   * Ported from SSSF db.ts lines 79-93.
   */
  private configureDb(): void {
    if (!this.db) return;

    try {
      this.db.exec("PRAGMA busy_timeout = 5000");
    } catch {
      // readonly may reject some pragmas; continue
    }

    try {
      this.db.exec("PRAGMA synchronous = NORMAL");
    } catch {
      // readonly may reject synchronous
    }

    // ASSERT journal_mode (read only, never set)
    const mode = this.db
      .query("PRAGMA journal_mode")
      .get() as { journal_mode: string };
    const journalMode = mode?.journal_mode ?? "unknown";
    if (journalMode.toLowerCase() !== "wal") {
      console.warn(
        `[reader] journal_mode is "${journalMode}", expected "wal" — live reads during writes may block`,
      );
    }
  }

  /**
   * Ensure database is open. Lazy fallback for test case where DB is created
   * after reader is opened (deviation from reference).
   */
  private ensureDb(): Database {
    if (!this.db) {
      this.db = new Database(this.dbPath, { readonly: true });
      this.configureDb();
    }
    return this.db;
  }

  /**
   * Check for column presence via PRAGMA table_info with latch cache.
   * Ported from SSSF db.ts lines 111-120.
   */
  private hasColumn(table: string, column: string): boolean {
    const key = `${table}.${column}`;
    if (!this.columnCache.get(key)) {
      const db = this.ensureDb();
      const cols = db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all();
      this.columnCache.set(key, cols.some((c) => c.name === column));
    }
    return this.columnCache.get(key) ?? false;
  }

  /**
   * Return column name or NULL AS <column> for missing columns.
   * Ported from SSSF db.ts lines 122-124.
   */
  private optionalColumn(table: string, column: string): string {
    return this.hasColumn(table, column) ? column : `NULL AS ${column}`;
  }

  /**
   * Events paging query ported from SSSF db.ts lines 366-384.
   * adw_id → request_id, with optionalColumn probe added for test compatibility.
   */
  readEvents(requestId: string, cursor = 0, limit = DEFAULT_LIMIT): EventPage {
    // Validate cursor (test requirement)
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new Error("cursor must be a non-negative integer");
    }

    const db = this.ensureDb();
    // AC4: a non-positive or non-finite limit means "default", not "minimum".
    // A positive limit is truncated and clamped to MAX_LIMIT before binding.
    const cappedLimit =
      Number.isFinite(limit) && limit > 0
        ? Math.min(Math.trunc(limit), MAX_LIMIT)
        : DEFAULT_LIMIT;

    const events = db
      .query<TraceEventRow, [string, number, number]>(
        `SELECT rowid, event_id, request_id,
                ${this.optionalColumn("events", "phase_id")},
                ${this.optionalColumn("events", "parent_id")},
                ${this.optionalColumn("events", "type")},
                ${this.optionalColumn("events", "name")},
                ${this.optionalColumn("events", "payload_json")},
                ${this.optionalColumn("events", "tokens")},
                ${this.optionalColumn("events", "started_at")},
                ${this.optionalColumn("events", "ended_at")}
           FROM events
          WHERE request_id = ? AND rowid > ?
          ORDER BY rowid
          LIMIT ?`,
      )
      .all(requestId, Math.max(0, cursor), cappedLimit);

    return {
      rows: events,
      cursor: events.length > 0 ? events[events.length - 1]!.rowid : Math.max(0, cursor),
      hasMore: events.length === cappedLimit,
    };
  }

  /**
   * Read session by request_id.
   * Ported from SSSF db.ts lines 205-216 (adw_id → request_id).
   */
  readSession(requestId: string): TraceSessionRow | null {
    const db = this.ensureDb();

    const row = db
      .query<TraceSessionRow, [string]>(
        `SELECT request_id, request, status, engineer, started_at, ended_at,
                duration_ms, total_tokens,
                ${this.optionalColumn("sessions", "total_cost")},
                ${this.optionalColumn("sessions", "pipeline_name")},
                ${this.optionalColumn("sessions", "archived")}
           FROM sessions WHERE request_id = ?`,
      )
      .get(requestId);
    return row ?? null;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export function openTraceReader(dbPath: string): TraceReader {
  return new TraceReaderImpl(dbPath);
}
