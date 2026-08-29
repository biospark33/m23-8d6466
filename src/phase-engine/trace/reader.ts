/**
 * Trace reader (Story DF1.4).
 *
 * Readonly rowid-cursor reader for the trace store. Opens with readonly=true,
 * asserts WAL journal mode, and handles schema drift via optionalColumn probing.
 *
 * Ported from SSSF reference db.ts lines 77-124, 362-384.
 */
import Database from "bun:sqlite";
import { z } from "zod";
import type {
  CorrelatedRunPage,
  CorrelatedRunRow,
  EventPage,
  TraceEventRow,
  TracePhasePage,
  TracePhaseRow,
  TraceSessionRow,
} from "../types.ts";
import { applyReaderPragmas } from "./pragmas.ts";

export const MAX_LIMIT = 1000;
export const DEFAULT_LIMIT = 500;

/**
 * F055: every read below casts a bun:sqlite row through a generic type
 * parameter — compile-time only, nothing validates the actual shape at
 * runtime. A drifted store (e.g. a pre-migration `phases.status` that
 * predates the `NOT NULL DEFAULT 'fail'` the optionalColumn drift tolerance
 * is built to survive) would otherwise hand out a `null` where the row type
 * promises a non-nullable `string`, silently mistyping every downstream
 * consumer instead of failing where the drift was actually observed.
 *
 * Schemas are deliberately narrow — only the fields whose TS row type is
 * non-nullable are validated as such; every already-nullable column is left
 * loose so drift there (already tolerated) does not newly throw.
 *
 * The rule that decides which is which: a field read through
 * `optionalColumn` is `.nullable()`, because the probe substitutes
 * `NULL AS <column>` on a store that predates the column and pinning it
 * would turn tolerated drift into a throw. A field selected directly, with a
 * hard NOT NULL in SCHEMA_DDL, stays pinned — `phases.status` is the case
 * this schema set exists for. The TS row types in types.ts agree.
 */
const eventRowSchema = z
  .object({
    rowid: z.number(),
    event_id: z.string(),
    request_id: z.string(),
    // both probed via optionalColumn → nullable (see rule above)
    type: z.string().nullable(),
    name: z.string().nullable(),
  })
  .passthrough();

// ponytail: archived isn't pinned to z.number() here, and TraceSessionRow
// types it `number | null` to match — optionalColumn reads a store without
// the column as NULL (see createSessionsFixture tests), and that's
// intentional drift tolerance, not a bug. Upgrade: pin `archived:
// z.number()` and narrow the row type back to `number` together, once no
// supported store predates the F054 migration (Task 9.2 follow-up).
const sessionRowSchema = z
  .object({
    request_id: z.string(),
  })
  .passthrough();

const phaseRowSchema = z
  .object({
    rowid: z.number(),
    phase_id: z.string(),
    request_id: z.string(),
    status: z.string(),
  })
  .passthrough();

function parseRows<T>(schema: z.ZodTypeAny, rows: unknown[]): T[] {
  return rows.map((row) => schema.parse(row) as T);
}

function parseRow<T>(schema: z.ZodTypeAny, row: unknown): T {
  return schema.parse(row) as T;
}

export interface TraceReader {
  readEvents(requestId: string, cursor?: number, limit?: number): EventPage;
  readSession(requestId: string): TraceSessionRow | null;
  /**
   * DF1.8 correlated reads. Deliberately NO entry point takes `issueId`
   * alone (INV-RUN-3): issue numbers are unique only within a repository, so
   * the cross-repo query cannot be written by accident — every read filters
   * on the (repoSlug, issueId) pair as bound parameters.
   */
  readRunsByIssue(
    repoSlug: string,
    issueId: number,
    cursor?: number,
    limit?: number,
  ): CorrelatedRunPage;
  readRunPhases(requestId: string, cursor?: number, limit?: number): TracePhasePage;
  close(): void;
}

/**
 * Column presence cache for optionalColumn probe.
 * Cache key: "table.column". Only ever false → true (latches).
 * Ported from SSSF db.ts lines 64-65, 111-124.
 */
type ColumnCache = Map<string, boolean>;
type TableCache = Map<string, boolean>;

class TraceReaderImpl implements TraceReader {
  private dbPath: string;
  private db: Database | null = null;
  private readonly columnCache: ColumnCache = new Map();
  private readonly tableCache: TableCache = new Map();

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    // Try to open database eagerly for WAL warning timing with tests
    // If file doesn't exist, fall back to lazy opening (test deviation)
    //
    // Crash-case note: a readonly connection CAN replay a leftover -wal as
    // long as it can create the -shm (SQLite ≥3.22) — i.e. whenever the data
    // dir is writable, which the store's own 0700 contract guarantees for the
    // writer. A read-write fallback would add nothing: when the dir is not
    // writable, read-write cannot create the -shm either. See the
    // "WAL crash recovery" tests in reader.test.ts.
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

    const journalMode = applyReaderPragmas(this.db);
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
   *
   * We open readonly and cannot run the tracer's ALTERs ourselves, so
   * selecting the column blindly would throw "no such column" on every read
   * against a db an older tracer wrote. Instead we probe and substitute NULL,
   * which reads downstream as "this db predates the column".
   *
   * The probe re-runs while the column is missing, because the tracer's ALTER
   * can land while we're serving: a startup-only check would keep returning
   * NULL for the rest of the process even after the data arrived. Once seen,
   * a column never goes away, so it latches.
   *
   * Ported from SSSF db.ts lines 111-120 (see visualizer/server/db.ts).
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
   * DF1.8: table-presence probe with the same latch shape as hasColumn — it
   * re-probes while the table is missing (the tracer's CREATE TABLE can land
   * while we're serving) and latches once seen. A sessions-only store
   * (phases/envelopes not yet created) reads as "no phases" — the table-level
   * form of the drift tolerance optionalColumn already gives missing columns,
   * not a hard error.
   */
  private hasTable(table: string): boolean {
    if (!this.tableCache.get(table)) {
      const db = this.ensureDb();
      const row = db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(table);
      this.tableCache.set(table, (row?.n ?? 0) > 0);
    }
    return this.tableCache.get(table) ?? false;
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
    // Truncate first and re-check: a sub-1 fraction (e.g. 0.5) truncates to 0
    // and must fall back to the default too, not bind LIMIT 0 — an empty page
    // with hasMore true spins any cursor-looping caller forever.
    const truncated = Math.trunc(limit);
    const cappedLimit =
      Number.isFinite(limit) && truncated > 0
        ? Math.min(truncated, MAX_LIMIT)
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
    const parsedEvents = parseRows<TraceEventRow>(eventRowSchema, events);

    return {
      rows: parsedEvents,
      cursor:
        parsedEvents.length > 0
          ? parsedEvents[parsedEvents.length - 1]!.rowid
          : Math.max(0, cursor),
      hasMore: parsedEvents.length === cappedLimit,
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
    return row == null ? null : parseRow<TraceSessionRow>(sessionRowSchema, row);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * DF1.8: cursor validation + limit capping with the exact readEvents rule
   * (non-negative-integer cursor else throw; trunc → min MAX_LIMIT,
   * non-positive/non-finite → DEFAULT_LIMIT).
   */
  private pageParams(
    cursor: number,
    limit: number,
  ): { cursor: number; cappedLimit: number } {
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new Error("cursor must be a non-negative integer");
    }
    const truncated = Math.trunc(limit);
    const cappedLimit =
      Number.isFinite(limit) && truncated > 0
        ? Math.min(truncated, MAX_LIMIT)
        : DEFAULT_LIMIT;
    return { cursor: Math.max(0, cursor), cappedLimit };
  }

  /**
   * DF1.8: shared phase-row SELECT + exactly-one envelope join. The scalar
   * subselect resolves to a single rowid — the max-attempt envelope, and
   * within a shared attempt the last-inserted (max rowid) — so
   * `output_payload_json` is the phase's LATEST-attempt persisted output and
   * the join can never duplicate the phase. An equality join on
   * (request_id, phase_id, attempt) would: two envelope rows sharing an
   * attempt (a re-recorded output) fan out to two phase rows. A phase with
   * no envelope joins NULL; nothing synthetic is filled in.
   *
   * `joinEnvelopes` false (a store whose `envelopes` table is absent — the
   * table-level drift hasTable already tolerates for `phases`) skips the
   * join entirely and selects `NULL AS output_payload_json`: the phase rows
   * are still returned, their persisted outputs are simply not there to read.
   */
  private phaseSelect(joinEnvelopes: boolean): string {
    const columns = `SELECT phases.rowid, phases.phase_id, phases.request_id, phases.seq,
                   phases.name, phases.kind, phases.owner, phases.description,
                   phases.status, phases.attempt, phases.retries, phases.error,
                   phases.started_at, phases.ended_at,
                   ${joinEnvelopes ? "en.payload_json" : "NULL"} AS output_payload_json
              FROM phases`;
    if (!joinEnvelopes) return columns;
    return `${columns}
              LEFT JOIN envelopes en
                ON en.rowid = (SELECT e2.rowid FROM envelopes e2
                                 WHERE e2.request_id = phases.request_id
                                   AND e2.phase_id = phases.phase_id
                                 ORDER BY e2.attempt DESC, e2.rowid DESC
                                 LIMIT 1)`;
  }

  /**
   * DF1.8: page the runs of one (repoSlug, issueId) pair, each with its
   * phases (rowid-ordered) attached. One sessions query, then ONE phases
   * query for the whole page — the IN placeholders are generated, the values
   * are bound parameters. An empty result is a page, not an error: cursor
   * unchanged, hasMore false (AC5).
   *
   * Embedded phases are deliberately the run's FULL set, never truncated:
   * a run's phase count is bounded by its manifest (a handful of phase
   * specs), not by user input, so a per-run phase LIMIT would only hide
   * data. `readRunPhases` is the continuation contract — its rowid cursor
   * pages one run's phases independently of this embedding. Table drift is
   * tolerated on both halves: no `phases` table → rows carry `phases: []`;
   * `phases` without `envelopes` → phase rows carry `output_payload_json`
   * null (the join is skipped, not the rows).
   */
  readRunsByIssue(
    repoSlug: string,
    issueId: number,
    cursor = 0,
    limit = DEFAULT_LIMIT,
  ): CorrelatedRunPage {
    const { cursor: safeCursor, cappedLimit } = this.pageParams(cursor, limit);
    const db = this.ensureDb();

    // repo_slug/issue_id/issue_url are referenced directly, not probed: the
    // WHERE below already requires them, so an unmigrated store must fail at
    // prepare (fail-closed) rather than degrade to NULL correlation columns.
    const sessions = db
      .query<Omit<CorrelatedRunRow, "phases">, [string, number, number, number]>(
        `SELECT rowid, request_id, request, status, started_at, ended_at,
                duration_ms, total_tokens,
                ${this.optionalColumn("sessions", "total_cost")},
                ${this.optionalColumn("sessions", "pipeline_name")},
                repo_slug, issue_id, issue_url
           FROM sessions
          WHERE repo_slug = ? AND issue_id = ? AND rowid > ?
          ORDER BY rowid
          LIMIT ?`,
      )
      .all(repoSlug, issueId, safeCursor, cappedLimit);

    const phasesByRequest = new Map<string, TracePhaseRow[]>();
    if (sessions.length > 0 && this.hasTable("phases")) {
      // Dynamic placeholders only — values stay bound, never interpolated.
      // The envelope join is gated independently below: a phases-without-
      // envelopes store still embeds its phase rows, payload-less.
      const joinEnvelopes = this.hasTable("envelopes");
      const placeholders = sessions.map(() => "?").join(", ");
      const phaseRows = db
        .query<TracePhaseRow, string[]>(
          `${this.phaseSelect(joinEnvelopes)}
            WHERE phases.request_id IN (${placeholders})
            ORDER BY phases.rowid`,
        )
        .all(...sessions.map((s) => s.request_id));
      const parsedPhaseRows = parseRows<TracePhaseRow>(phaseRowSchema, phaseRows);
      for (const phase of parsedPhaseRows) {
        const list = phasesByRequest.get(phase.request_id);
        if (list === undefined) {
          phasesByRequest.set(phase.request_id, [phase]);
        } else {
          list.push(phase);
        }
      }
    }

    const rows: CorrelatedRunRow[] = sessions.map((s) => ({
      ...s,
      phases: phasesByRequest.get(s.request_id) ?? [],
    }));

    return {
      rows,
      cursor: rows.length > 0 ? rows[rows.length - 1]!.rowid : safeCursor,
      hasMore: rows.length === cappedLimit,
    };
  }

  /**
   * DF1.8: page one run's phases with each phase's latest persisted envelope
   * payload, on the same rowid-cursor shape as readEvents. An unknown
   * requestId — or one whose phases have not started — is an empty page with
   * the cursor unchanged, not an error (AC5).
   */
  readRunPhases(
    requestId: string,
    cursor = 0,
    limit = DEFAULT_LIMIT,
  ): TracePhasePage {
    const { cursor: safeCursor, cappedLimit } = this.pageParams(cursor, limit);
    const db = this.ensureDb();

    // A sessions-only store has no phases to page — the table-level drift
    // hasTable tolerates reads as "no phases" (an empty page, cursor
    // unchanged), not a prepare-time error on a missing table.
    if (!this.hasTable("phases")) {
      return { rows: [], cursor: safeCursor, hasMore: false };
    }

    const rows = db
      .query<TracePhaseRow, [string, number, number]>(
        `${this.phaseSelect(this.hasTable("envelopes"))}
          WHERE phases.request_id = ? AND phases.rowid > ?
          ORDER BY phases.rowid
          LIMIT ?`,
      )
      .all(requestId, safeCursor, cappedLimit);
    const parsedRows = parseRows<TracePhaseRow>(phaseRowSchema, rows);

    return {
      rows: parsedRows,
      cursor: parsedRows.length > 0 ? parsedRows[parsedRows.length - 1]!.rowid : safeCursor,
      hasMore: parsedRows.length === cappedLimit,
    };
  }
}

export function openTraceReader(dbPath: string): TraceReader {
  return new TraceReaderImpl(dbPath);
}
