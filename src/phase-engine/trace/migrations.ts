/**
 * DF1.4 trace-store additive migrations.
 *
 * Append-only, order-stable migration list. Each entry adds a column to an
 * existing table via ALTER TABLE ADD COLUMN. Every decl is nullable or has
 * DEFAULT so the ADD COLUMN is metadata-only and cannot hold the init write
 * lock past busy_timeout (INV-5 fail-closed).
 *
 * ponytail: the metadata-only claim covers the MIGRATIONS list, not
 * ensureSessionsArchivedNotNull below — that one is a full O(rows) table
 * rebuild, because SQLite cannot ALTER a column's nullability in place. It is
 * a one-time carve-out and acceptable while `sessions` is one row per run.
 * Upgrade path: copy in chunks (or drop the rebuild for a versioned store)
 * if sessions ever grows large enough for the copy to hold the write lock
 * past busy_timeout.
 *
 * Re-apply is a no-op: PRAGMA table_info checks whether the column already
 * exists. Missing columns are added; existing rows are preserved.
 */
import type { Database } from "bun:sqlite";

/** Migration tuple: [table, column, decl]. */
export type Migration = readonly [table: string, column: string, decl: string];

/**
 * Additive migration list seeded from SSSF reference (tracer.py:94-99),
 * ported with adw_name → pipeline_name. Append-only — DF1.8 and later
 * stories append entries, never edit or reorder existing ones. Every decl
 * is nullable or constant-default so ALTER TABLE ADD COLUMN is metadata-only.
 */
export const MIGRATIONS: readonly Migration[] = [
  ["agent_sessions", "color", "TEXT"],
  ["gate_results", "checks_json", "TEXT"],
  ["sessions", "pipeline_name", "TEXT"],
  ["agent_sessions", "context_tokens", "INTEGER"],
  ["agent_sessions", "context_window", "INTEGER"],
  ["sessions", "archived", "INTEGER DEFAULT 0"],
  // DF1.8 — issue correlation on the sessions row. All nullable: a bare DF1.4
  // run carries NULL repo_slug, mints no key, and is returned by no correlated
  // reader (INV-RUN-1/INV-RUN-3).
  ["sessions", "repo_slug", "TEXT"],
  ["sessions", "issue_id", "INTEGER"],
  ["sessions", "issue_url", "TEXT"],
] as const;

// Freeze to prevent runtime mutation — the array AND each tuple, so the
// append-only claim holds against in-place edits, not just push/pop.
Object.freeze(MIGRATIONS);
for (const entry of MIGRATIONS) Object.freeze(entry);

/**
 * Apply additive migrations to a database. For each migration entry:
 * - PRAGMA table_info checks whether the column exists
 * - If missing, ALTER TABLE ADD COLUMN runs
 * - If table missing entirely, the ALTER fails → throw Error (INV-5 fail-closed)
 * - If column already present, skip (idempotent)
 *
 * Existing rows are preserved; new columns get NULL or their DEFAULT value.
 *
 * @throws {Error} If a migration cannot be applied (e.g. table missing).
 */
export function applyMigrations(db: Database): void {
  for (const [table, column, decl] of MIGRATIONS) {
    // Check if column already exists
    const info = db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as { name?: string }[];

    const exists = info.some((row) => row.name === column);

    if (!exists) {
      // Column missing: add it. If table missing, ALTER fails → throw
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        throw new Error(
          `Migration failed: table "${table}", column "${column}", decl "${decl}": ${message}`,
        );
      }
    }
    // If exists, skip (idempotent no-op)
  }

  ensureSessionsArchivedNotNull(db);
}

/**
 * F054: the "sessions"/"archived" entry above (`INTEGER DEFAULT 0`, nullable)
 * predates SCHEMA_DDL backporting `archived INTEGER NOT NULL DEFAULT 0` into
 * the base table. A fresh store gets NOT NULL from SCHEMA_DDL directly and
 * skips this migration entry entirely (column already exists) — a v1 store
 * that added the column through the ADD COLUMN above does not. This step
 * reconciles the two so `PRAGMA table_info(sessions)` agrees for every store
 * regardless of which path created the column: backfill any NULL to 0, then
 * rebuild the table (SQLite cannot ALTER a column's nullability in place) to
 * declare it NOT NULL. Runs inside a transaction so the rebuild is atomic and
 * WAL-safe; a no-op once the column is already NOT NULL (fresh DDL, or a
 * store this has already rebuilt).
 *
 * The rebuild drops and re-creates the sessions indexes: RENAME carries them
 * to the temp table and DROP destroys them, so they are captured from
 * sqlite_master before the rename and re-`exec`d inside the same transaction.
 * That makes the step self-contained; tracer.ts also re-runs
 * SCHEMA_INDEX_DDL afterwards (IF NOT EXISTS), which is then a no-op.
 */
function ensureSessionsArchivedNotNull(db: Database): void {
  type ColumnInfo = {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  };
  const needsRebuild = (): ColumnInfo[] | null => {
    const columns = db.prepare("PRAGMA table_info(sessions)").all() as ColumnInfo[];
    const archived = columns.find((c) => c.name === "archived");
    return !archived || archived.notnull === 1 ? null : columns;
  };
  // Cheap unlocked pre-check so the common case (already NOT NULL) does not
  // take an IMMEDIATE write lock on every store open. The read that the
  // rebuild actually uses is re-taken inside the transaction below —
  // otherwise two concurrent openers both rebuild from the same stale read.
  if (needsRebuild() === null) return;

  const rebuild = db.transaction(() => {
    const columns = needsRebuild();
    if (columns === null) return; // another opener won the race

    // A crash between the RENAME and the DROP leaves the temp table behind,
    // and the next RENAME would fail on the name collision.
    db.exec("DROP TABLE IF EXISTS sessions__archived_notnull_fix");

    // Indexes travel with the RENAME and die with the DROP, so re-create them
    // from their own DDL after the copy.
    const indexes = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions' AND sql IS NOT NULL",
      )
      .all() as { sql: string }[];

    db.exec("UPDATE sessions SET archived = 0 WHERE archived IS NULL");
    const colDefs = columns
      .map((c) => {
        const notNull = c.name === "archived" ? true : c.notnull === 1;
        const dflt = c.name === "archived" ? "0" : c.dflt_value;
        return [
          c.name,
          c.type,
          c.pk ? "PRIMARY KEY" : "",
          notNull ? "NOT NULL" : "",
          // `dflt_value` comes out of PRAGMA table_info already formatted as a
          // SQL literal (quotes included for text defaults), so it is
          // interpolated unquoted on purpose.
          dflt !== null && dflt !== undefined ? `DEFAULT ${dflt}` : "",
        ]
          .filter(Boolean)
          .join(" ");
      })
      .join(",\n  ");
    const colNames = columns.map((c) => c.name).join(", ");
    db.exec("ALTER TABLE sessions RENAME TO sessions__archived_notnull_fix");
    db.exec(`CREATE TABLE sessions (\n  ${colDefs}\n)`);
    db.exec(
      `INSERT INTO sessions (${colNames}) SELECT ${colNames} FROM sessions__archived_notnull_fix`,
    );
    db.exec("DROP TABLE sessions__archived_notnull_fix");
    for (const idx of indexes) db.exec(idx.sql);
  });
  rebuild.immediate();
}
