# P1.3: Seeds-decompose → Paperclip mirror (authority split)

**Story Points:** 4

## Spec Reference

- PRD §6.2 (Manager — Hermes); FR-MG-3, FR-CP-3
- PRD §6.5 (Memory & decomposition); FR-MEM-4 (Seeds dependency edges — predecessor P0.9)
- Phase exit gate: PRD §13 Phase-1 clause 2 (decompose via Seeds; mirror to child Paperclip issues; dependencies only in `.seeds/issues.jsonl`, assignment+cost only in Paperclip; no duplicated authority)
- NFR-ACC-3 (no `issue.cost` field), R2 mitigation (two-task-store authority split)

## User Story

As a Hermes Dev manager,
I want to decompose a parent issue into Seeds stories with dependency edges and mirror those stories one-directionally to child Paperclip issues,
so that work is tracked end-to-end with a single owner per fact (Seeds=deps, Paperclip=assignment+cost) — closing the F1 decomposition hop without duplicated authority (G2 accountability).

## Overview

This slice cuts Seeds (`.seeds/issues.jsonl` via `/usr/local/bin/sd`) → Hermes mirror logic → Paperclip `issues` (live `localhost:3100`, company `1287bc8d-2122-4484-bc0c-900662caf8a0`). The Dev manager runs `sd create` + `sd dep` to persist N stories with `blocks[]`/`blockedBy[]` edges, then — explicitly, after `sd create` succeeds (not event-driven) — POSTs one Paperclip child issue per story under the parent (`parentId`), tagged `originKind='seeds_story'` + `originId=<seeds_story_id>` (`issues.ts:45-46`). A partial unique index on `(companyId, originKind, originId)` (established pattern `issues.ts:93-141`) makes re-mirror an **upsert** of status, never a duplicate. Dependency edges stay ONLY in Seeds; assignment+cost stay ONLY in Paperclip. One atomic 4pt unit: the mirror is not demonstrable until both stores hold their own authoritative facts and re-run is idempotent.

## E2E Slice

**Demonstrable behavior:** Hermes runs `mirrorSeedsToPaperclip(parentIssueId)` against a parent with N=3 decomposed Seeds stories (one carrying a `blockedBy[]` edge). It persists 3 records to `.seeds/issues.jsonl` and creates 3 Paperclip child issues under the parent. Re-running the same mirror creates **zero** new Paperclip issues (upserts status only). A query proves: each child issue carries `originKind='seeds_story'` + a distinct `originId`; **no** Paperclip issue has a dependency edge mirrored into `parentId` beyond the decomposition tree; **no** `cost` column exists on `issues`; the `blockedBy[]` edge exists in `.seeds/issues.jsonl` and is absent from Paperclip.

**Wiring closed:** On completion of this story, running `mirrorSeedsToPaperclip(parentIssueId)` twice produces exactly 3 Paperclip child issues (each with `originKind='seeds_story'` + unique `originId`) and 3 `.seeds/issues.jsonl` records (deps intact), using only code merged by this story (the Hermes mirror module + the partial unique index migration). No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P1.2 (Dev manager creates the parent Paperclip issue, FR-MG-2), P0.9 (Seeds decomposition into `.seeds/issues.jsonl` with dependency edges, FR-MEM-4).

## Acceptance Criteria

1. **(make-or-break)** Given a parent Paperclip issue with 3 decomposed Seeds stories in `.seeds/issues.jsonl` (one with a `blockedBy[]` edge), When `mirrorSeedsToPaperclip(parentIssueId)` runs twice, Then after the second run there are exactly 3 child Paperclip issues under the parent (each `originKind='seeds_story'` with a distinct `originId` matching a Seeds story id), the dependency edge exists in `.seeds/issues.jsonl` and is absent from every Paperclip `parentId`/`issue_relations` row, and a schema check confirms no `cost` column on `issues` — no missing hop and no duplicated authority.
2. Given an already-mirrored Seeds story whose `status` changed in Seeds, When the mirror re-runs, Then the matching Paperclip child issue is upserted (status updated, same row id) and the divergence is logged — never a new row created.
3. Given a mirror attempt where the Paperclip POST fails (non-2xx) for one story, When the failure occurs, Then the mirror records the failure, leaves the Seeds record authoritative, and returns a non-zero result for that story (gate fires; no silent partial-mirror that desyncs the two stores).

## Technical Notes

- **Contracts/Schema:** Paperclip child issue created via the live REST API as a registered `hermes_local` agent; body sets `parentId` (`issues.ts:29`), `assigneeAgentId` (`:35`), `status` (`:32`), `originKind='seeds_story'` + `originId` (`:45-46`). New migration: partial unique index on `(companyId, originKind, originId) WHERE originKind='seeds_story'` (pattern at `issues.ts:93-141`). Seeds record shape (read-only here): `{id,title,status,type,priority,labels,blocks[],blockedBy[],closeReason}`. **Backward-compat:** existing issues with `originKind` NULL are unaffected by the partial index. **No `cost` field written** (NFR-ACC-3 — per-issue cost is `SUM(cost_events.costCents)`).
- **Integration points (each wired & exercised in this story):** (1) `sd`/`.seeds/issues.jsonl` read via `/usr/local/bin/sd` (private CLI 0.2.5 — never `npm install`); (2) Paperclip REST create/upsert keyed on the unique index; (3) idempotent re-mirror proving no duplicate authority. Mirror is **one-directional (Seeds→Paperclip), called explicitly by Hermes after `sd create` succeeds** (not event-driven).
- **Authority on divergence:** Paperclip wins on assignment+cost, Seeds wins on dependency edges + status; divergences logged. Seeds `blocks[]`/`blockedBy[]` are NOT copied to `parentId` (`parentId` = decomposition tree only; dependency relations, if ever needed, belong in `issue_relations`, never `parentId`).
- **Files / functions touched:** Hermes mirror module `mirrorSeedsToPaperclip`; Paperclip create-issue path consuming `originKind`/`originId`; migration adding the partial unique index.
- **Guards/limits:** all Paperclip calls authenticated per NFR-SEC-2 (`PAPERCLIP_API_KEY` + `PAPERCLIP_RUN_ID`, injected by `hermes_local` adapter `registry.ts:468-469`). Agent only mutates issues within its company scope.

## Files to Modify

- `~/.hermes/hermes-agent/integrations/seeds_mirror.py`
- `~/.hermes/hermes-agent/integrations/paperclip_client.py`
- `/Users/steve/boardlensai/paperclip/packages/db/src/schema/issues.ts`
- `/Users/steve/boardlensai/paperclip/packages/db/migrations/0040_seeds_origin_unique_index.sql`
- `/Users/steve/boardlensai/paperclip/server/src/routes/issues.ts`
- `tests/phase-1/p1-3-seeds-mirror.e2e.test.ts`

## Security Invariants

- **INV-1 (tenant isolation):** every mirrored child issue is created with the mirror caller's `companyId` (QDS `1287bc8d-2122-4484-bc0c-900662caf8a0`); the partial unique index is scoped `(companyId, originKind, originId)` so an `originId` collision across tenants cannot cross-link, and the mirror never reads/writes an issue outside its `PAPERCLIP_RUN_ID`-scoped company.
- **INV-2 (migration safety / non-regression):** the new index is a **partial** unique index `WHERE originKind='seeds_story'`; it must not constrain or rewrite existing rows where `originKind IS NULL` (no backfill, no lock on the full table beyond index build), preserving every pre-existing issue.
- **INV-3 (no authority duplication):** the mirror never writes a `cost` value or a dependency edge to Paperclip (no `cost` column exists; `parentId` carries only the decomposition tree). A divergence between stores is **logged**, never silently reconciled by overwriting the authoritative store.
- **INV-4 (auth):** all REST calls send bearer `PAPERCLIP_API_KEY` + `PAPERCLIP_RUN_ID` (NFR-SEC-2); no key is hardcoded or written to logs/stdout.

## Definition of Done

- [ ] **Impl:** `mirrorSeedsToPaperclip(parentIssueId)` reads `.seeds/issues.jsonl` via `sd`, creates one Paperclip child issue per Seeds story under `parentId`, tagged `originKind='seeds_story'`+`originId`.
- [ ] **Impl:** Re-mirror upserts an existing child's `status` (matched on `(companyId,originKind,originId)`) instead of creating a duplicate.
- [ ] **Contract/Schema:** Migration `0040` adds the partial unique index on `(companyId, originKind, originId) WHERE originKind='seeds_story'`; applied and table queryable; backward-compat for NULL-`originKind` rows verified.
- [ ] **Integration:** Seeds→Paperclip mirror wired one-directionally, called explicitly post-`sd create` (not event-driven), and exercised against live `localhost:3100`.
- [ ] **Observability/Audit:** each child issue's `originId` resolves back to a Seeds story id (audit-chain hop 7, §8.4); store divergences are logged with the issue id correlation (NFR-OBS-3).
- [ ] **Security:** tenant-scoped create + partial-index migration safety + no-cost/no-dep-duplication invariants enforced (INV-1..3); bearer auth on every call (INV-4).
- [ ] **Test (unit/integration):** covers create-new, re-mirror-upsert, status-divergence-logged, and the POST-failure guard path (AC-3).
- [ ] **Test (e2e demo — MANDATORY):** runs `mirrorSeedsToPaperclip` twice on a 3-story parent (one `blockedBy[]` edge); asserts exactly 3 child issues with distinct `originId`, the dep edge present in Seeds and absent from Paperclip, and no `cost` column — proving wiring closed and no duplicated authority (§13 Phase-1 clause 2).

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
