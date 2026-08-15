/**
 * Shared SQLite connection pragmas for the DF1.4 trace store (AC2).
 *
 * One definition for both connections so the writer's and the reader's pragma
 * sets cannot drift — the reader's journal-mode assertion is an implicit
 * contract on the writer's configuration, and that contract lives here.
 */
import type { Database } from "bun:sqlite";

/** AC2: the trace store's connection contract. */
export const TRACE_PRAGMAS = {
  journalMode: "WAL",
  synchronous: "NORMAL",
  busyTimeoutMs: 5000,
} as const;

/**
 * Writer connection: set every pragma; any refusal is a hard open failure.
 */
export function applyWriterPragmas(db: Database): void {
  db.exec(`PRAGMA journal_mode=${TRACE_PRAGMAS.journalMode}`);
  db.exec(`PRAGMA synchronous=${TRACE_PRAGMAS.synchronous}`);
  db.exec(`PRAGMA busy_timeout=${TRACE_PRAGMAS.busyTimeoutMs}`);
}

/**
 * Reader connection: best-effort per pragma (a readonly connection may refuse
 * some of them), then report the effective journal mode so the caller can warn
 * on non-WAL. Returns the journal mode string, e.g. "wal" or "delete".
 */
export function applyReaderPragmas(db: Database): string {
  for (const pragma of [
    `PRAGMA busy_timeout=${TRACE_PRAGMAS.busyTimeoutMs}`,
    `PRAGMA synchronous=${TRACE_PRAGMAS.synchronous}`,
  ]) {
    try {
      db.exec(pragma);
    } catch {
      // readonly may reject some pragmas; continue
    }
  }

  // ASSERT journal_mode (read only, never set)
  const mode = db.query("PRAGMA journal_mode").get() as { journal_mode?: string };
  return mode?.journal_mode ?? "unknown";
}
