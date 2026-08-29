/**
 * F054: SCHEMA_DDL and MIGRATIONS must agree — a fresh store (built straight
 * from SCHEMA_DDL) and a migrated store (a v1 store run through every
 * MIGRATIONS entry) must end up with the identical `PRAGMA table_info` +
 * index list for every table. Regression test for the `sessions.archived`
 * nullability drift: SCHEMA_DDL declared it `NOT NULL DEFAULT 0` while the
 * MIGRATIONS entry that adds it to a v1 store left it nullable.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  SCHEMA_DDL,
  SCHEMA_INDEX_DDL,
  applyMigrations,
} from "../../../src/phase-engine/trace/schema.ts";

/**
 * v1 snapshot: the trace schema before any MIGRATIONS entry ran — i.e.
 * SCHEMA_DDL's tables with every migration-added column removed (agent_sessions
 * .color/.context_tokens/.context_window, gate_results.checks_json,
 * sessions.pipeline_name/.archived/.repo_slug/.issue_id/.issue_url).
 * Reconstructed from migrations.ts's MIGRATIONS list, not read from any
 * shipped file — this repo never stored the schema pre-migration.
 */
const V1_SCHEMA_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS sessions (
  request_id TEXT PRIMARY KEY,
  request TEXT,
  status TEXT,
  engineer TEXT,
  started_at TEXT,
  ended_at TEXT,
  duration_ms INTEGER,
  total_tokens INTEGER,
  total_cost INTEGER
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
  violations_json TEXT
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
  session_id TEXT,
  PRIMARY KEY (request_id, agent)
)`,
];

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/** Normalized schema shape: per-table column info (sorted by name) + index list. */
function schemaOf(db: Database): unknown {
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((t) => t.name);

  const tableShapes = Object.fromEntries(
    tables.map((table) => {
      const columns = (
        db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[]
      )
        .map((c) => ({
          name: c.name,
          type: c.type,
          notnull: c.notnull,
          dflt_value: c.dflt_value,
          pk: c.pk,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return [table, columns];
    }),
  );

  const indexes = (
    db
      .prepare(
        "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string; tbl_name: string }[]
  ).map((i) => ({
    name: i.name,
    tbl_name: i.tbl_name,
    columns: (db.prepare(`PRAGMA index_info(${i.name})`).all() as { name: string }[]).map(
      (c) => c.name,
    ),
  }));

  return { tables: tableShapes, indexes };
}

/** A store built straight from SCHEMA_DDL (+ migrations, which no-op, + index DDL). */
function freshFromDDL(): Database {
  const db = new Database(":memory:");
  for (const ddl of SCHEMA_DDL) db.exec(ddl);
  applyMigrations(db);
  for (const ddl of SCHEMA_INDEX_DDL) db.exec(ddl);
  return db;
}

/** A v1 store run through every MIGRATIONS entry, then index DDL — mirrors Tracer.openWriter's order. */
function migratedFromV1(): Database {
  const db = new Database(":memory:");
  for (const ddl of V1_SCHEMA_DDL) db.exec(ddl);
  applyMigrations(db);
  for (const ddl of SCHEMA_INDEX_DDL) db.exec(ddl);
  return db;
}

describe("F054: SCHEMA_DDL / MIGRATIONS reconciliation", () => {
  test("a fresh DDL store and a fully migrated store have identical schemas", () => {
    expect(schemaOf(freshFromDDL())).toEqual(schemaOf(migratedFromV1()));
  });

  test("sessions.archived is NOT NULL DEFAULT 0 on both paths", () => {
    for (const db of [freshFromDDL(), migratedFromV1()]) {
      const archived = (
        db.prepare("PRAGMA table_info(sessions)").all() as ColumnInfo[]
      ).find((c) => c.name === "archived");
      expect(archived?.notnull).toBe(1);
      expect(archived?.dflt_value).toBe("0");
    }
  });
});
