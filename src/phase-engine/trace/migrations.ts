/**
 * DF1.4 trace-store additive migrations.
 *
 * Append-only, order-stable migration list. Each entry adds a column to an
 * existing table via ALTER TABLE ADD COLUMN. Every decl is nullable or has
 * DEFAULT so the ADD COLUMN is metadata-only and cannot hold the init write
 * lock past busy_timeout (INV-5 fail-closed).
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
}
