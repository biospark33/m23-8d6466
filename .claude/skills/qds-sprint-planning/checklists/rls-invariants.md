# RLS (Row-Level Security) Invariants Checklist

> **Triggered by:** `rls`, `row-level security`, `RLS policy` in story or epic text.
> **Loaded by:** Phase 3 wrap-up step (`steps/phase-3-wrap-up.md` §3.0).
> **Used as:** `also_consider` input to `bmad-review-adversarial-general`.

When a story introduces or modifies an RLS policy, every one of the
items below must be addressable from the story spec alone. If the spec
cannot answer "yes, the story covers this," it is a HIGH finding.

## Per-policy invariants

- [ ] **Tenant binding.** Each RLS policy filters on the tenant
      discriminator column (typically `graph_id` per project naming).
      Policies that omit tenant binding leak cross-tenant rows.
- [ ] **Owner check.** Each RLS policy either binds the row to the
      acting principal (owner) or explicitly documents why ownership
      is not required (e.g. shared dictionary table).
- [ ] **Capability gate.** Each RLS policy references the capability
      the actor must hold to read/write the row. A policy without a
      capability gate degrades to "any authenticated user."
- [ ] **TOCTOU guard on UPDATE.** Policies for UPDATE must include a
      `WITH CHECK` clause that re-validates the post-state — not only
      the pre-state — to prevent time-of-check / time-of-use attacks
      where a row is mutated out of the principal's scope mid-statement.
      (Per PostgreSQL docs on `CREATE POLICY`, `WITH CHECK` applies to
      INSERT and UPDATE only.)
- [ ] **DELETE scope via USING.** Policies for DELETE are governed
      exclusively by the `USING` clause (PostgreSQL forbids `WITH
      CHECK` on DELETE policies because there is no post-state row to
      validate). Verify the `USING` predicate correctly restricts
      which rows the principal may delete.
- [ ] **Policy naming.** Policy names follow project convention
      (`idx_{table}_{column}` style adapted for policies, e.g.
      `rls_{table}_{action}_{role}`). Naming consistency is a
      cross-story consistency invariant: if Story 3 uses
      `rls_documents_select_owner` and Story 5 uses
      `documents_select_policy`, that is a HIGH finding.

## Cross-story invariants

- [ ] **Single tenant discriminator.** All stories in the batch use
      the same column for tenant binding. Mixed `graph_id` /
      `tenant_id` / `org_id` across stories is a HIGH finding.
- [ ] **Same enforcement layer.** RLS is enforced at the database
      level in every story that touches tenant-scoped tables. A
      story that relies on application-level filtering instead of
      RLS for a tenant-scoped table is a HIGH finding.
- [ ] **Migration ordering.** If multiple stories add policies to
      the same table, the migration order in the epic preserves
      linearizability (no two stories revising the same policy in
      uncoordinated migrations).

## Test invariants

- [ ] **Negative test per policy.** Each story includes at least one
      test asserting that a principal *without* the required
      capability or *outside* the tenant cannot SELECT/UPDATE/DELETE
      the protected row.
- [ ] **Cross-tenant probe.** At least one integration test in the
      sprint sets `graph_id` to a foreign tenant and asserts zero
      rows returned for every tenant-scoped query path the story
      introduces.

## Documentation invariants

- [ ] **Policy diff section in story.** Each story that touches RLS
      includes a "Policies Added / Modified" subsection listing the
      DDL for each policy (CREATE POLICY / ALTER POLICY / DROP
      POLICY) so reviewers can audit without grepping the migration.
- [ ] **Rollback documented.** If the policy must be rolled back,
      the rollback path (DROP POLICY + restore prior policy) is
      documented in the story's Rollback section or in the Alembic
      `downgrade()` body. "No rollback" is acceptable only with an
      explicit rationale.
