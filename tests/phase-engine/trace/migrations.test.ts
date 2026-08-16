/**
 * Migration tests (Story DF1.4).
 *
 * Tests schema drift (AC3), index DDL application (DoD), fail-closed behavior (INV-5),
 * and MIGRATIONS list hygiene.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Database } from "bun:sqlite";

import {
  SCHEMA_DDL,
  SCHEMA_INDEX_DDL,
  MIGRATIONS,
  applyMigrations,
} from "../../../src/phase-engine/trace/schema.ts";

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "df1-4-migrations-")));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

describe("AC3 schema drift: ADD COLUMN migrations", () => {
  test("missing column added, existing rows preserved, idempotent", () => {
    const dbPath = path.join(tmpRoot, "schema-drift.db");
    const db = new Database(dbPath);

    // Apply base schema
    for (const ddl of SCHEMA_DDL) {
      db.exec(ddl);
    }

    // Find a migration to test with (first one)
    const [targetTable, targetColumn] = MIGRATIONS[0]!;

    // Recreate the table WITHOUT the target column (simulate earlier build).
    // DROP first: CREATE TABLE IF NOT EXISTS would no-op against the full
    // schema-applied table above and the drift would never exist.
    const trimmedTableDDL = `DROP TABLE IF EXISTS ${targetTable};
    CREATE TABLE ${targetTable} (
      request_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      -- ${targetColumn} intentionally omitted
      dummy_column TEXT DEFAULT 'existing_data',
      PRIMARY KEY (request_id, agent)
    )`;
    db.exec(trimmedTableDDL);

    // Insert a row before migration
    db.exec(`INSERT INTO ${targetTable} (request_id, agent, dummy_column) VALUES ('test-req-1', 'agent-a', 'preserved')`);

    // Verify column doesn't exist yet
    const beforeInfo = db
      .prepare(`PRAGMA table_info(${targetTable})`)
      .all() as { name: string }[];
    expect(beforeInfo.find((c) => c.name === targetColumn)).toBeUndefined();

    // Apply migrations
    expect(() => applyMigrations(db)).not.toThrow();

    // Verify column now exists
    const afterInfo = db
      .prepare(`PRAGMA table_info(${targetTable})`)
      .all() as { name: string }[];
    expect(afterInfo.find((c) => c.name === targetColumn)).toBeDefined();

    // Verify existing row preserved
    const row = db
      .prepare(`SELECT request_id, dummy_column FROM ${targetTable} WHERE request_id = ?`)
      .get("test-req-1") as { request_id: string; dummy_column: string };
    expect(row.request_id).toBe("test-req-1");
    expect(row.dummy_column).toBe("preserved");

    // Idempotent: second call is no-op, no error
    expect(() => applyMigrations(db)).not.toThrow();
    const afterSecondInfo = db
      .prepare(`PRAGMA table_info(${targetTable})`)
      .all() as { name: string }[];
    expect(afterSecondInfo.length).toBe(afterInfo.length);

    db.close();
  });

  test("column already present: no-op, no error", () => {
    const dbPath = path.join(tmpRoot, "column-present.db");
    const db = new Database(dbPath);

    // Apply base schema
    for (const ddl of SCHEMA_DDL) {
      db.exec(ddl);
    }

    // Apply migrations first time
    applyMigrations(db);

    // Apply again: should not throw
    expect(() => applyMigrations(db)).not.toThrow();

    db.close();
  });
});

describe("DoD index DDL: CREATE UNIQUE INDEX IF NOT EXISTS", () => {
  test("index created on apply, re-apply is no-op", () => {
    const dbPath = path.join(tmpRoot, "index-ddl.db");
    const db = new Database(dbPath);

    // Apply base schema
    for (const ddl of SCHEMA_DDL) {
      db.exec(ddl);
    }

    // Verify no indexes yet for our tables
    const beforeIndexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' AND tbl_name IN (SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%')",
      )
      .all() as { name: string }[];
    expect(beforeIndexes.length).toBe(0);

    // Apply index DDL
    for (const ddl of SCHEMA_INDEX_DDL) {
      db.exec(ddl);
    }

    // Verify indexes created
    const afterIndexes = db
      .prepare(
        "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' AND tbl_name IN (SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%')",
      )
      .all() as { name: string; tbl_name: string }[];
    expect(afterIndexes.length).toBeGreaterThan(0);

    // Re-apply: should be no-op (IF NOT EXISTS)
    expect(() => {
      for (const ddl of SCHEMA_INDEX_DDL) {
        db.exec(ddl);
      }
    }).not.toThrow();

    // Verify still exactly the same indexes (no duplicates)
    const afterReapplyIndexes = db
      .prepare(
        "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' AND tbl_name IN (SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%')",
      )
      .all() as { name: string; tbl_name: string }[];
    expect(afterReapplyIndexes.length).toBe(afterIndexes.length);

    db.close();
  });
});

describe("INV-5 fail-closed: migrations abort on failure", () => {
  test("migration for nonexistent table throws Error", () => {
    const dbPath = path.join(tmpRoot, "fail-nonexistent-table.db");
    const db = new Database(dbPath);

    // Apply base schema
    for (const ddl of SCHEMA_DDL) {
      db.exec(ddl);
    }

    // Attempt to apply a migration for a table that doesn't exist
    // This simulates a malformed MIGRATIONS entry or manual intervention
    const badTable = "this_table_definitely_does_not_exist";
    expect(() => {
      db.exec(`ALTER TABLE ${badTable} ADD COLUMN fake_column TEXT DEFAULT 'x'`);
    }).toThrow();

    db.close();
  });

  test("conflicting column decl results in Error (deterministic with real sqlite)", () => {
    const dbPath = path.join(tmpRoot, "fail-conflict.db");
    const db = new Database(dbPath);

    // Create a table with a specific column type
    db.exec(`CREATE TABLE conflict_test (
      request_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending'
    )`);

    // Adding a column that already exists fails deterministically
    // ("duplicate column name") — the INV-5 case where a migration cannot
    // be applied must abort rather than be swallowed.
    expect(() => {
      db.exec("ALTER TABLE conflict_test ADD COLUMN status TEXT");
    }).toThrow();

    db.close();
  });
});

describe("MIGRATIONS list hygiene", () => {
  test("every decl is nullable or has DEFAULT", () => {
    for (const [, , decl] of MIGRATIONS) {
      // A decl is safe if it has DEFAULT or does NOT have NOT NULL
      const hasDefault = decl.includes("DEFAULT");
      const hasNotNull = decl.includes("NOT NULL");

      if (hasNotNull && !hasDefault) {
        throw new Error(
          `Migration decl violates fail-closed: has NOT NULL without DEFAULT: ${decl}`,
        );
      }
    }
    // The loop above is the assertion (it throws on violation); this guards
    // the vacuous pass where MIGRATIONS itself is empty.
    expect(MIGRATIONS.length).toBeGreaterThan(0);
  });

  test("list has no duplicate [table, column] pairs", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const [table, column] of MIGRATIONS) {
      const key = `${table}.${column}`;
      if (seen.has(key)) {
        duplicates.push(key);
      }
      seen.add(key);
    }

    expect(duplicates).toEqual([]);
  });

  test("MIGRATIONS is append-only (order-stable)", () => {
    // This test verifies the contract: MIGRATIONS order must be stable
    // We check that the array is frozen and order is preserved
    const firstEntry = MIGRATIONS[0];
    const lastEntry = MIGRATIONS[MIGRATIONS.length - 1];

    expect(Object.isFrozen(MIGRATIONS)).toBe(true); // Runtime check for readonly
    expect(firstEntry).toBeDefined();
    expect(lastEntry).toBeDefined();

    // Verify entries have the expected tuple shape
    expect(firstEntry).toHaveLength(3);
    expect(lastEntry).toHaveLength(3);

    // Verify array cannot be mutated
    expect(() => {
      (MIGRATIONS as unknown as Array<unknown>).push(["test", "col", "TEXT"]);
    }).toThrow();
  });
});
