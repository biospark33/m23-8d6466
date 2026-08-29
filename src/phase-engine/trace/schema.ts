/**
 * DF1.4 trace-store schema. Seven tables ported from SSSF's tracer (R4 §2.1,
 * reference-only per D10 — test-first TypeScript re-implementation, no vendored
 * Python) with `request_id` replacing SSSF's `adw_id` throughout (§5.2
 * observability contract: requestId is the end-to-end correlation key; there
 * is no second correlation identifier).
 *
 * Column authority: story DF1.4 Technical Notes. Every table carries
 * `request_id`. `phases.status` defaults to 'fail' so a phase that is never
 * updated — e.g. killed mid-flight — reads as failed, never as implicitly
 * successful. `sessions.total_cost` is integer micro-dollars (DD-9).
 * `sessions.archived` is review-triage state DF4.1 owns; a run never writes it.
 *
 * `CREATE TABLE IF NOT EXISTS` never revisits an existing table — forward
 * column additions go through the additive migration list in migrations.ts
 * (INV-5), and index DDL lives in SCHEMA_INDEX_DDL for the same reason: a
 * uniqueness constraint does not fit the [table, column, decl] migration tuple.
 */

export const SCHEMA_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS sessions (
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
  archived INTEGER NOT NULL DEFAULT 0
)`,
  `CREATE TABLE IF NOT EXISTS phases (
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
)`,
  `CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  phase_id TEXT,
  parent_id TEXT,
  type TEXT NOT NULL,
  name TEXT,
  payload_json TEXT,
  tokens INTEGER,
  started_at TEXT,
  ended_at TEXT
)`,
  `CREATE TABLE IF NOT EXISTS envelopes (
  envelope_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  phase_id TEXT,
  agent TEXT,
  output_type TEXT,
  payload_json TEXT,
  valid INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER
)`,
  `CREATE TABLE IF NOT EXISTS gate_results (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL,
  phase_id TEXT,
  attempt INTEGER,
  gate TEXT,
  passed INTEGER,
  violations_json TEXT,
  checks_json TEXT
)`,
  `CREATE TABLE IF NOT EXISTS processes (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL,
  kind TEXT,
  pid INTEGER,
  command TEXT,
  ended_at TEXT
)`,
  `CREATE TABLE IF NOT EXISTS agent_sessions (
  request_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  coding_agent TEXT,
  model TEXT,
  color TEXT,
  session_id TEXT,
  context_tokens INTEGER,
  context_window INTEGER,
  PRIMARY KEY (request_id, agent)
)`,
];

/**
 * Additive index DDL applied during schema init, after SCHEMA_DDL and
 * MIGRATIONS run (see tracer.ts: migrations add the columns DF1.8's indexes
 * cover, and SQLite rejects an index on a column that does not exist yet).
 * Append-only and order-stable like MIGRATIONS — DF1.8 appends its two
 * sessions indexes here (the pk-pair consistency assertion and the AC2
 * covering path); existing entries are never edited or reordered. Re-apply
 * is a no-op (`IF NOT EXISTS`).
 */
export const SCHEMA_INDEX_DDL: readonly string[] = [
  // (request_id, event_id) is unique by construction — event_id is the table's
  // PK — so the UNIQUE form exercises the additive-index mechanism DF1.8
  // extends with no collision risk. processes deliberately carries NO unique
  // index: processesEndAll stamps every live row of a request with one
  // timestamp, and a unique (request_id, pid, ended_at) would reject that bulk
  // UPDATE when the same pid was recorded twice.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_events_request_event
  ON events (request_id, event_id)`,
  // DF1.8 — NOT the idempotency mechanism and NOT a covering index for the
  // AC2 query: request_id is already unique alone as the sessions pk, so this
  // composite can never reject a row the pk would have accepted (INV-RUN-1),
  // and readRunsByIssue never filters on request_id. It serves only the
  // repo_slug PREFIX of that query and exercises the additive-index
  // mechanism; the index below carries the actual AC2 covering path.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_repo_request
  ON sessions (repo_slug, request_id)`,
  // DF1.8 — the covering path for the AC2 query: readRunsByIssue predicates
  // on (repo_slug, issue_id) with a rowid cursor, and every SQLite index
  // implicitly ends in rowid, so this seeks both equality predicates and
  // feeds ORDER BY rowid with no sort. Non-unique: one (repo, issue) pair
  // legitimately has many runs (every replay/re-attempt is a new requestId).
  `CREATE INDEX IF NOT EXISTS idx_sessions_repo_issue
  ON sessions (repo_slug, issue_id)`,
];

// Re-exports from migrations.ts for test convenience
export {
  type Migration,
  MIGRATIONS,
  applyMigrations,
} from "./migrations";
