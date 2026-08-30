/**
 * SQLite reader over a DF1.4 trace store (`<data_dir>/trace.db`, schema in
 * src/phase-engine/trace/schema.ts). Ported from upstream SSSF db.ts with the
 * port-boundary renames: `adw_id` → `request_id`, no `adw_name`, cost integer
 * micro-dollars end to end, and the upstream filesystem prompts plumbing
 * (sessionsDir) deleted — prompts come from the trace's `prompt` events.
 *
 * The read connection is opened readonly and every query on it is a SELECT —
 * the writers are the tracers of running pipelines, and WAL lets us read
 * straight through their inserts.
 *
 * ONE exception, opened lazily on its own connection: `setArchived`.
 * Archiving is review triage — "I have looked at this run" — which has to
 * outlive a browser, so it lives on the session row rather than in
 * localStorage. It is the only write this process can make, it touches
 * exactly one column, and it never runs unless a human clicks the button.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { VizError } from "./auth.ts";
import type {
  AgentSession,
  AgentStartPayload,
  Envelope,
  Event,
  EventsPage,
  GateResult,
  HealthResponse,
  Phase,
  PromptEvent,
  Session,
  SessionDetail,
  SessionSummary,
  SessionUsage,
} from "../shared/types.ts";

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 500;

/** Plain SQL identifier — the only shape hasColumn will interpolate. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The declared optionalColumn (AC3): sessions.pipeline_name — DF1.4's port of
 * upstream's adw_name probe (src/phase-engine/trace/migrations.ts seeds it
 * from SSSF tracer.py:94-99, and reader.ts probes it in readSession and
 * readRunsByIssue). A trace predating the column reads NULL for it and keeps
 * serving 200; every OTHER column is selected directly, so a trace missing
 * one of those fails the prepare and takes the 500 path through safely().
 *
 * NOTE: pipeline_name is served-but-unrendered — no Vue component reads it.
 * It is kept, and is what makes the DECLARED_OPTIONAL_COLUMN/hasColumn/
 * optionalColumn apparatus load-bearing: it is the one column whose absence
 * must degrade to NULL rather than 500, and routes.test.ts exercises exactly
 * that (ALTER DROP -> 200 with NULL, ALTER ADD -> 200 with the value). Drop
 * it and the probe machinery loses its only subject.
 */
const DECLARED_OPTIONAL_COLUMN = { table: "sessions", column: "pipeline_name" } as const;

/**
 * The sessions columns this server itself reads — the health probe's drift
 * set. Any missing → degraded ({ok:false}), never a crash (AC3). DF1.8's
 * repo_slug/issue_id/issue_url are deliberately absent: this server never
 * reads them, so a pre-DF1.8 trace is not degraded for their sake alone.
 */
const EXPECTED_SESSION_COLUMNS = [
  "request_id",
  "request",
  "status",
  "engineer",
  "started_at",
  "ended_at",
  "duration_ms",
  "total_tokens",
  "total_cost",
  DECLARED_OPTIONAL_COLUMN.column,
  "archived",
] as const;

/**
 * Resolve the db path: --db arg wins, then QDS_VIZ_DB, then DF1.4's own trace
 * location — pipeline-run.ts claims `<QDS_RUN_ROOT>/trace` (markerRoot
 * defaults to /run when unset) and the Tracer opens `trace.db` inside it.
 * An empty QDS_RUN_ROOT reads as unset (D14).
 */
export function resolveDbPath(argv: string[] = Bun.argv): string {
  const flagIndex = argv.indexOf("--db");
  const inline = argv.find((a) => a.startsWith("--db="));
  const runRoot = process.env.QDS_RUN_ROOT?.trim() || "/run";
  const raw =
    (flagIndex !== -1 ? argv[flagIndex + 1] : undefined) ??
    inline?.slice("--db=".length) ??
    process.env.QDS_VIZ_DB ??
    join(runRoot, "trace", "trace.db");

  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

export class TraceDb {
  readonly path: string;
  readonly journalMode: string;
  private readonly db: Database;
  /** Opened on first archive and kept; null until then. */
  private writer: Database | null = null;
  /** Cache for optionalColumn(), keyed "table.column". Only ever false → true. */
  private readonly columnCache = new Map<string, boolean>();

  constructor(path: string) {
    if (!existsSync(path)) {
      throw new VizError(
        "VIZ_TRACE_DB_OPEN",
        `trace db not found at ${path}\nPoint the visualizer at a run: --db <path> or QDS_VIZ_DB=<path>, or run it where QDS_RUN_ROOT holds a run's trace/trace.db`,
        "Start a DF1.4 pipeline first, or pass --db pointing at an existing trace.db.",
      );
    }
    this.path = path;

    // INV-5 / AC5: the reader must be able to actually open AND read — a db
    // locked past busy_timeout, unreadable, or corrupt is a fatal startup
    // failure with a NAMED cause, not a degraded-but-running state and not a
    // raw SQLiteError escaping to the caller.
    //
    // DF4.2: the guard opens at `new Database` rather than at the table_info
    // probe. sqlite is lazy — it does not touch the file's header until the
    // first statement, so a corrupt db survives the constructor and throws at
    // the FIRST pragma ("file is not a database", measured on bun 1.3.13).
    // With the guard starting below that pragma, every such failure escaped
    // unnamed and the catch below was unreachable for any sqlite-level fault.
    let db: Database | undefined;
    try {
      db = new Database(path, { readonly: true });

      // WAL is set by the tracer when it creates the db; a readonly connection
      // cannot change it, so we assert rather than set, and always take the
      // busy_timeout so a concurrent writer never turns into a failed request.
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA synchronous = NORMAL");
      const mode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
      this.journalMode = mode?.journal_mode ?? "unknown";
      db.query<{ name: string }, []>("PRAGMA table_info(sessions)").all();
    } catch (error) {
      db?.close();
      throw new VizError(
        "VIZ_TRACE_DB_OPEN",
        `cannot read trace db at ${path}: ${(error as Error).message}`,
        "Free the lock on the trace db (or let the running pipeline finish) and restart.",
      );
    }
    this.db = db;

    if (this.journalMode.toLowerCase() !== "wal") {
      console.warn(
        `[viz] journal_mode is "${this.journalMode}", expected "wal" — live reads during pipeline writes may block`,
      );
    }
  }

  /**
   * A SELECT fragment for the declared optionalColumn.
   *
   * We open readonly and cannot run the tracer's ALTERs ourselves, so
   * selecting the column blindly would throw "no such column" on every
   * request against a db an older tracer wrote. Instead we probe and
   * substitute NULL, which reads downstream as "this db predates the column".
   *
   * The probe re-runs while the column is missing, because the tracer's ALTER
   * can land while we're serving: a startup-only check would keep returning
   * NULL for the rest of the process even after the data arrived. Once seen,
   * a column never goes away, so it latches. Only the one declared column
   * gets this treatment (AC3); every other missing column is a 500.
   */
  private hasColumn(table: string, column: string): boolean {
    // These two are the only identifiers in this file that are concatenated
    // rather than bound, so the charset is enforced here rather than trusted
    // to every future caller.
    if (!IDENTIFIER.test(table) || !IDENTIFIER.test(column)) {
      throw new Error(`invalid identifier in column probe: ${table}.${column}`);
    }
    const key = `${table}.${column}`;
    if (!this.columnCache.get(key)) {
      const cols = this.db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all();
      this.columnCache.set(key, cols.some((c) => c.name === column));
    }
    return this.columnCache.get(key) ?? false;
  }

  private optionalColumn(table: string, column: string): string {
    return this.hasColumn(table, column) ? column : `NULL AS ${column}`;
  }

  private declaredOptional(): string {
    return this.optionalColumn(
      DECLARED_OPTIONAL_COLUMN.table,
      DECLARED_OPTIONAL_COLUMN.column,
    );
  }

  /** True when the sessions table is missing any column this server reads. */
  private schemaDrift(): boolean {
    try {
      const cols = this.db
        .query<{ name: string }, []>("PRAGMA table_info(sessions)")
        .all();
      const names = new Set(cols.map((c) => c.name));
      return EXPECTED_SESSION_COLUMNS.some((c) => !names.has(c));
    } catch {
      return true;
    }
  }

  close(): void {
    this.writer?.close();
    this.db.close();
  }

  /**
   * Archive or restore a session — the only write in this process.
   *
   * busy_timeout matters: a run may be mid-insert on the same WAL db, and a
   * click should wait its turn rather than fail. Returns false when the id
   * does not exist, so the route can 404 instead of silently succeeding.
   */
  setArchived(requestId: string, archived: boolean): boolean {
    if (!this.hasColumn("sessions", "archived")) {
      throw new Error("this db predates the archived column — run any pipeline once to migrate it");
    }
    if (!this.writer) {
      this.writer = new Database(this.path, { create: false, readwrite: true });
      this.writer.exec("PRAGMA busy_timeout=5000;");
    }
    this.writer
      .query("UPDATE sessions SET archived = ? WHERE request_id = ?")
      .run(archived ? 1 : 0, requestId);
    return this.session(requestId) !== null;
  }

  /**
   * Sessions, most recent first, each with its phase statuses for the progress
   * dots. `archived` picks WHICH side of the flag: the live list by default,
   * the archived one when asked. The archived side is not a nicety — it is the
   * only place the UI can reach a row to un-archive it.
   */
  sessions(limit = 200, archived = false): SessionSummary[] {
    const rows = this.db
      .query<Session, [number, number]>(
        `SELECT request_id, request, status, engineer, started_at, ended_at,
                duration_ms, total_tokens, total_cost,
                ${this.declaredOptional()}, archived
           FROM sessions
          WHERE COALESCE(archived, 0) = ?
          ORDER BY started_at DESC, rowid DESC
          LIMIT ?`,
      )
      .all(archived ? 1 : 0, clamp(limit, 1, MAX_LIMIT));

    if (rows.length === 0) return [];

    // Embed each session's phases so the L1 progress dots cost no extra request.
    const ids = rows.map((row) => row.request_id);
    const placeholders = ids.map(() => "?").join(", ");
    const phaseRows = this.db
      .query<Phase, string[]>(
        `SELECT phase_id, request_id, seq, name, kind, owner, description, status,
                attempt, retries, error, started_at, ended_at
           FROM phases WHERE request_id IN (${placeholders}) ORDER BY seq, rowid`,
      )
      .all(...ids);

    const byRequest = new Map<string, Phase[]>();
    for (const phase of phaseRows) {
      const list = byRequest.get(phase.request_id);
      if (list) list.push(phase);
      else byRequest.set(phase.request_id, [phase]);
    }

    // Agents come along too: an L1 card draws a per-agent dot timeline, and its
    // dots are colored per agent — without this it would be one request per card.
    const agentsByRequest = this.agentsFor(ids);

    const summaries: SessionSummary[] = [];
    for (const session of rows) {
      const phases = byRequest.get(session.request_id) ?? [];
      summaries.push(
        Object.assign(session, {
          phases,
          agents: agentsByRequest.get(session.request_id) ?? [],
        }),
      );
    }
    return summaries;
  }

  session(requestId: string): Session | null {
    return (
      this.db
        .query<Session, [string]>(
          `SELECT request_id, request, status, engineer, started_at, ended_at,
                  duration_ms, total_tokens, total_cost,
                  ${this.declaredOptional()}, archived
             FROM sessions WHERE request_id = ?`,
        )
        .get(requestId) ?? null
    );
  }

  phases(requestId: string): Phase[] {
    return this.db
      .query<Phase, [string]>(
        `SELECT phase_id, request_id, seq, name, kind, owner, description, status,
                attempt, retries, error, started_at, ended_at
           FROM phases WHERE request_id = ? ORDER BY seq, rowid`,
      )
      .all(requestId);
  }

  agentSessions(requestId: string): AgentSession[] {
    return this.agentsFor([requestId]).get(requestId) ?? [];
  }

  /**
   * Agents per session, for a set of ids at once: the agent_sessions rows plus
   * anything that has started but not finished.
   *
   * DF1.4 writes the agent_sessions row only after the run finishes an agent,
   * so a running agent has no row there — precisely the case the live view
   * exists for. Its model, color and session_id are already on the
   * agent_start event, so a lane is labelled and colored from the moment the
   * agent spawns.
   */
  private agentsFor(requestIds: string[]): Map<string, AgentSession[]> {
    const byRequest = new Map<string, AgentSession[]>();
    if (requestIds.length === 0) return byRequest;
    const placeholders = requestIds.map(() => "?").join(", ");

    const append = (requestId: string, agent: AgentSession) => {
      const list = byRequest.get(requestId);
      if (list) list.push(agent);
      else byRequest.set(requestId, [agent]);
    };

    const completed = this.db
      .query<AgentSession, string[]>(
        `SELECT request_id, agent, coding_agent, model, session_id, color,
                context_tokens, context_window
           FROM agent_sessions WHERE request_id IN (${placeholders})
          ORDER BY rowid`,
      )
      .all(...requestIds);
    for (const row of completed) append(row.request_id, row);

    const started = this.db
      .query<
        {
          request_id: string;
          agent: string | null;
          payload_json: string | null;
          started_at: string | null;
        },
        string[]
      >(
        `SELECT e.request_id, p.owner AS agent, e.payload_json, e.started_at
           FROM events e JOIN phases p ON p.phase_id = e.phase_id
          WHERE e.request_id IN (${placeholders}) AND e.type = 'agent_start'
          ORDER BY e.rowid`,
      )
      .all(...requestIds);

    for (const row of started) {
      if (!row.agent) continue;
      // A finished row is authoritative; only fill genuine gaps.
      if (byRequest.get(row.request_id)?.some((a) => a.agent === row.agent)) continue;
      let payload: AgentStartPayload = {};
      try {
        payload = JSON.parse(row.payload_json ?? "{}") as AgentStartPayload;
      } catch {
        // A malformed payload just means no label — never a failed request.
      }
      append(row.request_id, {
        request_id: row.request_id,
        agent: row.agent,
        coding_agent: null,
        model: payload.model ?? null,
        session_id: payload.session_id ?? null,
        color: payload.color ?? null,
        // Occupancy is only known once the agent's turn closes.
        context_tokens: null,
        context_window: null,
      });
    }
    return byRequest;
  }

  /** Session + usage + phases + agents in one shot — L2 needs all three to draw lanes. */
  sessionDetail(requestId: string): SessionDetail | null {
    const session = this.session(requestId);
    if (!session) return null;

    return {
      session,
      usage: this.usage(requestId),
      phases: this.phases(requestId),
      agents: this.agentSessions(requestId),
    };
  }

  /**
   * Raw tokens read and written, beside the billed headline.
   *
   * Derived from the `agent_end` payloads rather than stored, so every run
   * already in the db gets the split without a migration or a re-run.
   * Payload keys are read camelCase-first — DF1.4's AgentEndEvent carries
   * UsageBreakdown (inputTokens/cacheWriteTokens/outputTokens,
   * src/phase-engine/types.ts) — with the vendored SSSF snake_case spelling
   * (input_tokens/...) as a fallback for heritage payloads.
   *
   * `total_tokens` is a SPEND number: every turn re-sends the whole
   * conversation. These two say what actually moved — material read for the
   * first time, and material generated. The gap between them and the headline
   * is cached re-reads, which is usually most of it.
   */
  usage(requestId: string): SessionUsage {
    const rows = this.db
      .query<{ payload_json: string | null }, [string]>(
        "SELECT payload_json FROM events WHERE request_id = ? AND type = 'agent_end'",
      )
      .all(requestId);

    let read = 0;
    let written = 0;
    for (const row of rows) {
      if (!row.payload_json) continue;
      try {
        const u = (JSON.parse(row.payload_json) as { usage?: Record<string, number> }).usage;
        if (!u) continue;
        // RAW reads only: material entering the context for the first time,
        // billed either as uncached input or as a cache write. Cache reads are
        // the same tokens served again on later turns — counting them here
        // would rebuild the very inflation this split exists to expose.
        read +=
          pick(u, "inputTokens", "input_tokens") +
          pick(u, "cacheWriteTokens", "cache_write_tokens");
        written += pick(u, "outputTokens", "output_tokens");
      } catch {
        /* a payload written by an older tracer simply contributes nothing */
      }
    }
    return { read, written };
  }

  /**
   * The polling query. Rowid cursor, insertion order, bounded page — the same
   * mechanism serves the live tail and lazy-paged history. An unknown or
   * event-less requestId is an empty page with the cursor unchanged, never an
   * error (AC4).
   */
  events(requestId: string, after = 0, limit = DEFAULT_LIMIT): EventsPage {
    const cappedLimit = clamp(limit, 1, MAX_LIMIT);
    const rows = this.db
      .query<Event, [string, number, number]>(
        `SELECT rowid, event_id, request_id, phase_id, parent_id, type, name,
                payload_json, tokens, started_at, ended_at
           FROM events
          WHERE request_id = ? AND rowid > ?
          ORDER BY rowid
          LIMIT ?`,
      )
      .all(requestId, Math.max(0, after), cappedLimit);

    return {
      rows,
      cursor: rows.length > 0 ? rows[rows.length - 1]!.rowid : Math.max(0, after),
      hasMore: rows.length === cappedLimit,
    };
  }

  envelopes(requestId: string): Envelope[] {
    return this.db
      .query<Envelope, [string]>(
        `SELECT envelope_id, request_id, phase_id, agent, output_type, payload_json,
                valid, attempt
           FROM envelopes WHERE request_id = ? ORDER BY rowid`,
      )
      .all(requestId);
  }

  gates(requestId: string): GateResult[] {
    return this.db
      .query<GateResult, [string]>(
        `SELECT id, request_id, phase_id, attempt, gate, passed, violations_json,
                checks_json
           FROM gate_results WHERE request_id = ? ORDER BY id`,
      )
      .all(requestId);
  }

  /**
   * The compiled prompts a run was sent, from `events` rows of type `prompt`
   * (written pre-execution, DF1.4 schema). A phaseId filters to that phase;
   * omitting it returns every prompt for the run. Upstream's filesystem read
   * is deleted — the trace is the record.
   */
  prompts(requestId: string, phaseId?: string, limit = DEFAULT_LIMIT): PromptEvent[] {
    // Prompt payloads are the largest blobs in a trace, so this read is
    // bounded exactly like events() — unbounded, a long run would load every
    // compiled prompt into memory to serialize it.
    const cappedLimit = clamp(limit, 1, MAX_LIMIT);
    const filter = phaseId === undefined ? "" : "AND phase_id = ?";
    const sql = `SELECT event_id, phase_id, name, payload_json, tokens, started_at
                   FROM events
                  WHERE request_id = ? AND type = 'prompt' ${filter}
                  ORDER BY rowid
                  LIMIT ?`;
    return phaseId === undefined
      ? this.db.query<PromptEvent, [string, number]>(sql).all(requestId, cappedLimit)
      : this.db
          .query<PromptEvent, [string, string, number]>(sql)
          .all(requestId, phaseId, cappedLimit);
  }

  sessionCount(): number {
    const row = this.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions")
      .get();
    return row?.n ?? 0;
  }

  /**
   * GET /api/health. Degraded — the trace removed or locked after a
   * successful start, or schema drift on any column this server reads —
   * reports {ok:false, db, journal_mode} and keeps the process up (AC3).
   * journal_mode is the value latched at open: a db that can no longer be
   * probed still reports what it was.
   */
  health(): HealthResponse {
    if (!existsSync(this.path)) {
      return { ok: false, db: this.path, journal_mode: this.journalMode };
    }
    try {
      if (this.schemaDrift()) {
        return { ok: false, db: this.path, journal_mode: this.journalMode };
      }
      return {
        ok: true,
        db: this.path,
        journal_mode: this.journalMode,
        sessions: this.sessionCount(),
      };
    } catch {
      return { ok: false, db: this.path, journal_mode: this.journalMode };
    }
  }
}

/** First numeric key present in an `agent_end` usage payload, else 0 — camelCase spelling wins. */
function pick(u: Record<string, number>, ...keys: string[]): number {
  for (const key of keys) {
    const value = u[key];
    if (typeof value === "number") return value;
  }
  return 0;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
