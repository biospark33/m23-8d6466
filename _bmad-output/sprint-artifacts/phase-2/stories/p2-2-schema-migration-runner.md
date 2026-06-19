# P2.2: Schema Migration Runner (Append-Only, Versioned Startup Apply)

**Story Points:** 3

## Spec Reference

- QDS-MEM-003 §4.3 (Schema versioning); QDS-MEM-003-IMPL §D.1 (KEEP: migrations runner)
- Schema GAP #3 (reconcile design `schema_meta` vs claude-mem `schema_versions`); §H R3 (P2.1↔P2.2 ownership seam)

## User Story

As a QDS platform operator,
I want the operational-memory store to apply ordered, append-only SQL migrations idempotently and under a single-migrator lock at startup, and record the applied set in an integrity-checked ledger,
so that the events/runs/experiments schema evolves deterministically across Bun and Node with no silent drift, no concurrent double-apply, and no destructive down-migrations (G2 — deterministic store provenance).

## Overview

This story lifts claude-mem's `MigrationRunner` (`migrations.ts` + `migrations/runner.ts`) and adapts it to the operational-memory store. Per §H R3, P2.1 authors the schema **content** as the `.sql` migration files (tables, FK clauses, the 9 events indexes + 3+2+2, `event_vec`, the FTS5 table+triggers, and the `schema_meta` DDL); this story's runner is the **sole runtime creator** — it is the only code that issues those `CREATE` statements at startup. The runner's migration set therefore INCLUDES the P2.1-authored files; nothing else applies that DDL. It reconciles Schema GAP #3 — design specifies a `schema_meta` key/value table while claude-mem uses an integer-versioned `schema_versions` table — by standardizing on `schema_meta` and recording the applied-migration ledger inside it. The runner serializes apply under a SQLite-level lock (INV-MIG4), seeds the four mandatory metadata rows, applies each unapplied migration in its own transaction, and is fully idempotent on repeated startup. Greenfield only — no pre-existing claude-mem `schema_versions` database ever reaches this runner (the store is net-new; the integer table is not vendored). Wiring closes with no stub and no `TODO`.

## E2E Slice

**Demonstrable behavior:** Against a fresh empty SQLite file, invoking `runMigrations(db)` applies all five ordered `.sql` migrations (`0001_schema_meta`, `0002_events_runs_experiments_indexes`, `0003_event_edges_event_vec`, `0004_events_fts5_triggers`, `0005_seed_meta`), creating `schema_meta`, every events/runs/experiments table + the 9+3+2+2 indexes, `event_edges`, the `event_vec` vec0 table, and the FTS5 table+triggers, then seeds the four metadata rows (`schema_version`, `engine=sqlite+sqlite-vec`, `embedding_model=Xenova/all-MiniLM-L6-v2`, `embedding_dim=384`) and records each applied filename in the ledger. Re-invoking `runMigrations(db)` on the same file applies zero additional migrations and leaves `schema_meta` byte-identical (asserted).

**Wiring closed:** On completion, any process opening the operational-memory database brings it to the current schema version using only code merged by this story and predecessor P2.0; P2.1 contributes the `.sql` file contents as a dependency edge. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. P2.1 (schema content) and P2.0 (vendored substrate) are dependency edges, not unfinished wiring inside this story.

**Dependency edges (predecessors):** P2.0, P2.1 (authors the `.sql` content this runner applies).

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given a fresh empty database, When `runMigrations(db)` is called twice in succession, Then after the first call all five ordered `.sql` files are applied (schema objects present) and the four seed rows exist in `schema_meta`, and after the second call the count of newly-applied migrations is exactly 0 and the applied-ledger contents are byte-unchanged.
2. Given a database already at migration N, When a new append-only migration N+1 is added and `runMigrations(db)` runs, Then only migration N+1 is applied, N+1's filename is appended to the ledger, and migrations 1..N are not re-executed.
3. Given a migration whose SQL fails mid-statement, When `runMigrations(db)` runs, Then the failing migration's transaction is fully rolled back, the ledger does NOT record that migration as applied, and the runner throws `MigrationError` and returns no usable database handle to the caller (partial-migration safety).
4. Given an attempt to register a migration whose filename ordinal is ≤ an already-applied migration, or whose ordinals are not contiguous from 1, or whose filename prefix does not equal its declared ordinal, When the runner validates the set at startup, Then it rejects the set with an append-only-violation / consistency error and applies nothing.
5. Given two processes invoking `runMigrations(db)` concurrently against the same fresh file, When both contend, Then the single-migrator lock (INV-MIG4) serializes them so each migration is applied exactly once and no duplicate ledger row is written; after the winner commits, the loser re-reads the ledger WITHIN A NEW transaction (a post-lock-acquire snapshot, not a pre-block snapshot), so it observes the winner's committed ledger rows and finds nothing to apply.
6. Given a database migrated by this runner, When `schema_meta` is read, Then `schema_version` equals the static product schema version recorded by `0005_seed_meta` and the engine/embedding-model/embedding-dim seeds are present and well-formed.
7. Given a fresh empty database with no `schema_meta` table yet, When `runMigrations(db)` reads the ledger on its first pass (BEFORE `0001` has run), Then the read tolerates the missing table — the runner catches the `no such table: schema_meta` error and treats it as an empty ledger (or runs `0001` ahead of the ledger-read) — and does NOT throw; bootstrap then proceeds to apply `0001`..`0005`.

## Technical Notes

- **Contracts/Schema:** `schema_meta` DDL is authored in P2.1's `0001_schema_meta.sql` and applied here:
  ```sql
  CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  -- seeded keys (0005_seed_meta): schema_version (static product version, e.g. 1.0.0),
  --   engine=sqlite+sqlite-vec, embedding_model=Xenova/all-MiniLM-L6-v2, embedding_dim=384
  -- applied-ledger keys: migration:0001 -> "<filename>|<applied_at_epoch_ms>|<sha256>"
  ```
  Migration record shape (in-memory): `{ ordinal: number, version: string, filename: string, sql: string, sha256: string }`.
- **Source of truth — schema_version:** STATIC product version. `0005_seed_meta` writes the literal version string; the runner does NOT derive it from the highest applied ordinal. (AC6 asserts the seeded static value; no "equals highest migration" assertion.)
- **Migration set (P2.1-authored content, P2.2-applied):** `0001_schema_meta`, `0002_events_runs_experiments_indexes` (tables + FK clauses + the 9 events / 3 runs / 2 experiments indexes), `0003_event_edges_event_vec` (`event_edges` + its 2 indexes + the `event_vec` vec0 table), `0004_events_fts5_triggers` (the FTS5 content table + AFTER INSERT/DELETE/UPDATE sync triggers, GAP #1), `0005_seed_meta` (the four seed rows).
- **Bootstrap ordering:** `0001` creates `schema_meta` with `CREATE TABLE IF NOT EXISTS` as the first statement INSIDE its own transaction, then writes its own `migration:0001` ledger row within that same transaction — so `0001`'s create + its ledger record commit atomically. A crash mid-`0001` rolls back both (no half-created `schema_meta`, no orphan ledger row); re-run reapplies `0001` cleanly. On a fresh DB the ledger-read happens BEFORE `0001` has created `schema_meta`, so the read MUST tolerate a missing table: the runner catches `no such table: schema_meta` and treats it as an empty ledger (equivalently, it may run `0001` ahead of the first ledger-read). Either way the first-run read never throws.
- **Concurrency (INV-MIG4):** the read-ledger → apply → write-ledger sequence runs as one serialized critical section, opened with `BEGIN IMMEDIATE` (reserved write lock) so a second concurrent migrator blocks until the first commits, then re-reads the ledger and finds nothing to apply. (`busy_timeout` set so the loser waits rather than erroring.)
- **Integration points (each wired & exercised in this story):** the five ordered `.sql` files in `src/operational-memory/store/migrations/` loaded at startup; `runMigrations(db)` invoked by the store-open path (the same path P2.1's store factory calls); `schema_meta` read/write via the dual-runtime sync `db` handle (`bun:sqlite` / `better-sqlite3`).
- **Files / functions touched:** `migrations.ts` (lifted `MigrationRunner` → `runMigrations`, ledger reconcile to `schema_meta`, `MigrationError`, INV-MIG4 lock), `migrations/runner.ts` (ordered loader + ordinal/filename consistency guard + per-file transaction wrapper).
- **Virtual-table DDL rollback (INV-MIG3 scope):** the `event_vec` vec0 `CREATE VIRTUAL TABLE` (0003) and the FTS5 table+triggers (0004) are verified transaction-safe / rollback-able under both `bun:sqlite` and `better-sqlite3` (tie to SPIKE-11 evidence). If SPIKE-11 finds a virtual-table DDL that cannot roll back atomically on a given runtime, INV-MIG3's rollback guarantee is scoped to DML/seed migrations and the offending DDL migration is made re-runnable via `CREATE ... IF NOT EXISTS` instead.
- **Guards/limits:** each non-bootstrap migration runs in its own `db.transaction(fn)` (atomic per file); append-only (ordinal strictly increasing, never re-run); ordinals contiguous from 1 and filename prefix == ordinal (guard rejects gaps and mismatches); applied-ledger row stores sha256 of the file content; idempotent (re-applies nothing already in ledger); single-migrator lock serializes concurrent invocations.

## Files to Modify

> ≤10 unique paths, one per line.

- `src/operational-memory/store/migrations.ts`
- `src/operational-memory/store/migrations/runner.ts`
- `src/operational-memory/store/migrations/0001_schema_meta.sql`
- `src/operational-memory/store/migrations/0002_events_runs_experiments_indexes.sql`
- `src/operational-memory/store/migrations/0003_event_edges_event_vec.sql`
- `src/operational-memory/store/migrations/0004_events_fts5_triggers.sql`
- `src/operational-memory/store/migrations/0005_seed_meta.sql`
- `tests/operational-memory/store/migrations.test.ts`
- `tests/operational-memory/store/migration-idempotency.test.ts`
- `tests/operational-memory/store/migration-concurrency.test.ts`

## Security Invariants

> Concrete named invariants only — N/A NOT permitted when triggered.

- **INV-MIG1 (append-only, no down-migrations):** the runner only ever applies migrations with an ordinal strictly greater than the highest applied ordinal; any registered migration with ordinal ≤ max-applied, any ordinal gap, or any filename-prefix ≠ ordinal is rejected before any SQL executes — no destructive/down path exists in the tree.
- **INV-MIG2 (integrity-checked applied ledger):** each applied migration is recorded in `schema_meta` with the sha256 of the file content; at startup the runner re-hashes already-applied files and fatally errors (`MigrationError`) on a mismatch. Scope: this detects accidental edits to applied `.sql` files (a consistency check), not a defense against a privileged attacker who can also rewrite the stored hash — the ledger is not a hash-chain and carries no anti-tamper threat model beyond detecting unintended drift.
- **INV-MIG3 (partial-migration safety):** every migration executes inside a single transaction (including `0001`'s bootstrap create + its own ledger row); on any failure the migration rolls back atomically and its ledger row is NOT written, so the database is never left in a half-applied state.
- **INV-MIG4 (single-migrator serialization):** read-ledger → apply → write-ledger is one serialized critical section guarded by a SQLite write lock (`BEGIN IMMEDIATE`); two concurrent `runMigrations` invocations apply each migration exactly once with no duplicate ledger rows; the loser blocks (within `busy_timeout`) and, once it acquires the lock after the winner commits, re-reads the ledger inside that NEW transaction (a post-lock-acquire snapshot, not a stale pre-block snapshot) so it sees the winner's committed rows and observes the work already done.

## Definition of Done

> 8–12 high-signal, story-specific boxes. NO project-wide CI filler.

- [ ] **Impl:** `MigrationRunner` lifted from claude-mem `migrations.ts` + `migrations/runner.ts` and adapted to the operational-memory store (per-file license header retained per P2.0).
- [ ] **Impl:** the five P2.1-authored `.sql` files (`0001`–`0005`) loaded by ordinal; this runner is the SOLE runtime creator of all schema objects (P2.1 authors content, never CREATEs at runtime).
- [ ] **Impl:** GAP #3 reconciled — applied-ledger and version recorded in design `schema_meta` (key/value), not claude-mem integer `schema_versions`; the integer table is not vendored; greenfield assumption stated (no legacy DB reaches the runner).
- [ ] **Impl:** `0005_seed_meta` writes the four seed rows; `schema_version` is the STATIC product version (not derived from highest ordinal).
- [ ] **Impl:** bootstrap circularity resolved — `0001` creates `schema_meta` (CREATE IF NOT EXISTS) and writes its own `migration:0001` ledger row inside one transaction; crash mid-`0001` leaves the ledger consistent (rollback asserted).
- [ ] **Contract:** ordinal/filename/version consistency guard — filename prefix == ordinal, ordinals contiguous from 1, ledger key format validated on write.
- [ ] **Security:** INV-MIG1 enforced — ordinal ≤ max-applied / gap / prefix-mismatch rejected with append-only-violation, no SQL executed.
- [ ] **Security:** INV-MIG2 enforced — sha256 recorded per applied migration; startup re-hash mismatch throws `MigrationError`; scoped to accidental-edit detection (not anti-tamper).
- [ ] **Security:** INV-MIG3 enforced — per-migration transaction; failure rolls back and ledger row absent.
- [ ] **Security:** INV-MIG4 enforced — single-migrator lock serializes concurrent `runMigrations`; exactly-once apply, no duplicate ledger rows.
- [ ] **Test (unit):** idempotency — `runMigrations` run twice applies N then 0; `schema_meta` byte-identical after the second run; mid-statement failure leaves ledger and DB consistent (rollback asserted, `MigrationError` thrown, no usable handle returned).
- [ ] **Test (e2e demo — MANDATORY):** against a fresh file, run `runMigrations`, assert all five files applied (schema objects + four seed rows + full ledger present, `schema_version` = static value); add migration `0006`, re-run, assert only `0006` applied and ledger appended; spawn two concurrent `runMigrations` on a fresh file and assert exactly-once apply with no duplicate ledger rows; re-run once more, assert 0 applied and `schema_meta` unchanged.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
