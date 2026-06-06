# Migration (Alembic / DDL / Schema-Change) Invariants Checklist

> **Triggered by:** `migration`, `migrations`, `alembic`, `DDL`,
> `schema change` in story or epic text.
> **Loaded by:** Phase 3 wrap-up step (`steps/phase-3-wrap-up.md` §3.0).
> **Used as:** `also_consider` input to `bmad-review-adversarial-general`.

When a story introduces or modifies a database migration, every one of
the items below must be addressable from the story spec alone. If the
spec cannot answer "yes, the story covers this," it is a HIGH finding.

## Idempotency invariants

- [ ] **Idempotent up().** The `upgrade()` body is safe to re-apply
      partial state — uses `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN
      IF NOT EXISTS` (or guarded `op.execute(...)` for PG variants),
      and does not assume any previous step succeeded.
- [ ] **Idempotent down().** The `downgrade()` body is safe to
      re-apply partial state — uses `DROP ... IF EXISTS` and does
      not raise on a table/column that was never created.

## Rollback invariants

- [ ] **Rollback exists.** Every migration has a non-trivial
      `downgrade()` body that reverses the schema change. `pass`
      or `raise NotImplementedError` is acceptable **only** when
      the migration is explicitly marked irreversible (data loss
      risk) AND the story spec calls out the irreversibility.
- [ ] **Rollback is tested.** The story DOD includes a test that
      runs `alembic upgrade head && alembic downgrade -1 && alembic
      upgrade head` against a real Postgres (Docker), not SQLite.
- [ ] **Rollback preserves data.** If the migration moves or
      reshapes data, the downgrade restores the prior shape or
      explicitly documents what is lost.

## Destructive-DDL invariants

- [ ] **No DROP without backup gate.** `DROP TABLE`, `DROP COLUMN`,
      and `ALTER COLUMN ... DROP NOT NULL` on a populated table
      require an explicit backup-gate step in the story (snapshot,
      logical export, or "destructive — requires manual operator
      approval before apply" tag). Silent destructive DDL is a HIGH
      finding.
- [ ] **No TRUNCATE in migrations.** TRUNCATE in a migration is
      always destructive across environments. If the intent is to
      reset seed data, use a separate seed script — not a migration.
- [ ] **Column rename uses temporary dual-write.** If the migration
      renames a column referenced by live application code, the
      story sequences the change as ADD-new → backfill → dual-write
      → cutover → DROP-old across multiple migrations. A single-shot
      rename on a live column is a HIGH finding.

## Chain-linearizability invariants

- [ ] **Single down_revision.** Each migration in the story has
      exactly one `down_revision`. No branching unless explicitly
      planned and documented.
- [ ] **Migration heads after the batch == 1.** After all migrations
      in the story (and the epic) apply, `alembic heads` returns a
      single head. Multiple heads ⇒ a merge migration is required
      and must be listed in the story.
- [ ] **No cross-story collision on the same down_revision.** If
      two stories in the batch both declare the same parent
      revision, exactly one of them is the parent of the other —
      verified explicitly in the cross-story consistency review.

## Performance invariants

- [ ] **Lock-acquisition risk noted.** Migrations that take a
      long-held lock on a large table (`ALTER TABLE ... ADD COLUMN`
      with a non-null default on Postgres < 11; `CREATE INDEX`
      without CONCURRENTLY; `ALTER COLUMN ... TYPE`) are flagged in
      the story with the row-count threshold above which the
      migration requires a maintenance window.
- [ ] **CONCURRENTLY for index creation.** Index creation on a
      populated table uses `CREATE INDEX CONCURRENTLY` (and the
      Alembic migration uses `with op.get_context().autocommit_block():`).

## Documentation invariants

- [ ] **Migration ID is real.** Story references a concrete
      Alembic revision ID format, not a placeholder.
- [ ] **Data-migration code is reviewable.** Data backfill (UPDATE
      ... or insert-from-select) is included in the migration body
      or in a clearly linked script — not "operator runs ad-hoc
      script after apply."
