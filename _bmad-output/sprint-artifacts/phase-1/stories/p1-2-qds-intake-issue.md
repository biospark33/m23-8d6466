# P1.2: `/qds` intake creates exactly one Dev-manager-owned Paperclip issue

**Story Points:** 3

## Spec Reference

- PRD §6.2 (Manager — Hermes), §6.6 (Comms); FR-MG-2, FR-CM-1; NFR-SEC-2, NFR-OBS-3
- Phase exit gate: PRD §13 / §6.8 Phase-1 item 2 ("`/qds` intake → issue" — exit: a `/qds <request>` creates exactly one parent Paperclip issue with the Dev manager as assignee).

## User Story

As an external stakeholder,
I want a `/qds <request>` to create exactly one parent Paperclip issue assigned to the Dev manager,
so that intake becomes a single owned, tracked work unit with no duplicates — the F1 make-or-break flow's first hop (G1 accountability; intake → issue).

## Overview

This slice cuts Comms front-door → Hermes Dev manager → Paperclip control plane. A `/qds <request>` (Telegram slash command, with the Hermes-gateway fallback in effect — OQ-3 BLOCKED-on-creds, so the request may arrive via the Hermes intake gateway rather than a native Telegram plugin) reaches the Dev manager, which creates one parent Paperclip `issues` row with `assigneeAgentId`=the Dev manager's agent id (from P1.1). Intake must be idempotent: a retried/duplicate delivery of the same request must NOT create a second issue. The atomic unit is "intake yields exactly one owned issue" — the create, the assignment, and the dedup key are inseparable; a create without the dedup guard breaks the "exactly one" exit-criterion.

## E2E Slice

**Demonstrable behavior:** Submitting `/qds <request>` (via Telegram or the Hermes-gateway fallback) causes the Dev manager to POST one parent Paperclip `issues` row: `parentId`=null (top of the decomposition tree), `assigneeAgentId`=Dev-manager agent id, `status`=todo. Re-delivering the identical request (same intake idempotency key) returns/points to the SAME issue id — a `SELECT count(*)` for that intake key equals exactly 1.

**Wiring closed:** On completion of this story, `/qds <request>` (or its Hermes-gateway-fallback equivalent) produces exactly one parent `issues` row with `assigneeAgentId`=the Dev manager and `parentId`=null, and a retry produces no second row — using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P1.1 (Dev manager registered as a budgeted `hermes_local` agent with an `agents.id` to assign and authenticated REST access).

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given the Dev manager is registered (P1.1) and Paperclip is live at `localhost:3100`, When a `/qds <request>` is submitted once, Then exactly one parent Paperclip `issues` row exists for that intake (`parentId`=null) with `assigneeAgentId`=the Dev manager's `agents.id` — `count(issues WHERE intake-key matches)` = 1, no more, no fewer.
2. Given an identical `/qds <request>` is delivered twice (network retry or duplicate tap), When the second delivery is processed, Then no second issue is created — the idempotent intake upserts/returns the existing issue id (still exactly one row); the POST returns HTTP 200 with the existing issue's `id` in the response body (or the same 201 with the existing id), and `SELECT count(*) FROM issues WHERE company_id = ? AND origin_kind = 'qds_intake' AND origin_id = ?` equals 1.
3. Given the Telegram plugin is unavailable (OQ-3 BLOCKED-on-creds), When `/qds <request>` arrives via the Hermes-gateway fallback path, Then the issue is still created exactly once with the Dev manager as assignee, and the fallback path is logged via stderr (NFR-OBS-3) including: the issue id, `source='hermes-gateway-fallback'`, and an ISO8601 timestamp.

## Technical Notes

- **Contracts/Schema:** Real Paperclip `issues` columns (`issues.ts`): `assigneeAgentId` (`:35`), `status` (`:32`), `parentId` (`:29`, null = top of decomposition tree). **No `cost` column** (per-issue cost is `cost_events` only — NFR-ACC-3; out of scope here). Idempotency reuses the established origin-key pattern: set `originKind` + `originId` (`issues.ts:45-46`) from a stable intake key (e.g. hash of `/qds` request + source), backed by the partial unique index on `(companyId, originKind, originId)` (the pattern at `issues.ts:93-141`) so re-delivery upserts rather than duplicates.
**Idempotency key composition:** `originKind='qds_intake'`, `originId=SHA256(JSON.stringify({t: normalized_request_text, c: source_channel}))` where normalization strips trailing whitespace and collapses internal runs of multiple spaces to one. Two deliveries from the same source channel with the same normalized text produce the same originId.
- **Integration points (each wired & exercised in this story):** `/qds` slash-command intake → Dev manager handler → authenticated `POST` issue-create to `localhost:3100` (bearer `PAPERCLIP_API_KEY` + `x-paperclip-run-id` header from P1.1, NFR-SEC-2); Telegram-OR-Hermes-gateway front-door (fallback in effect); handoff logged with issue-id correlation (NFR-OBS-3).
- **Issue-create API path:** `POST /companies/:companyId/issues` (`server/src/routes/issues.ts:3636`). `companyId` sourced from `PAPERCLIP_COMPANY_ID` env var (QDS company `1287bc8d-2122-4484-bc0c-900662caf8a0`; same as P1.1/P1.3). Request body sets `title`, `assigneeAgentId`, `parentId`=null, `status`=todo (or omitted for server default when `assigneeAgentId` is set), `originKind`, `originId`. Auth via P1.1 client (bearer + `x-paperclip-run-id`).
- **Title extraction:** The `/qds <request>` body (after `/qds` prefix stripped, trimmed) becomes the `title` field. Max 500 chars. Empty body rejected per INV-2.
- **Files / functions touched:** `/qds` command parser/router; Dev-manager intake handler; Paperclip issue-create call using the P1.1 authenticated client. **Note:** `qds-command.ts` and `gateway-fallback.ts` are NEW files created from scratch in this story (not modifications of existing modules); the command routing layer does not exist prior to this story.
- **CC-1 RESOLVED:** The intake handler uses application-level find-before-insert as the primary idempotency mechanism: `SELECT id FROM issues WHERE company_id = ? AND origin_kind = 'qds_intake' AND origin_id = ?` before insert; if row exists, return existing issue id. This works regardless of whether `createIssueSchema` accepts `originKind`/`originId` on the REST path. The handler still sends `originKind='qds_intake'` and `originId` in the create payload for future index use, but dedup does not depend on a DB constraint.
- **Guards/limits:** Intake idempotency key is the sole dedup guard; an unparsable/empty `/qds` body is rejected with an error reply, not turned into an empty issue.
- **Paperclip `issues.status` valid values** (from `issues.ts:32`): `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, `cancelled`. The value `todo` is valid. When `assigneeAgentId` is set and `status` is omitted, the server defaults to `todo`.
- **originKind NOT NULL DEFAULT:** The `originKind` column is `NOT NULL DEFAULT 'manual'` (issues.ts). The intake handler MUST always send `originKind='qds_intake'` explicitly. If the payload omits this field, the row defaults to `'manual'` and the dedup query will not match.
- **Migration ownership and coordination:** P1.2 creates migration `0094` for `qds_intake` partial index; P1.3 creates `0095` for `seeds_story`. **Conflict-resolution steps:** (a) If P1.2 (0094) is already merged, P1.3 creates 0095 independently. (b) If both are developed simultaneously, assign and record migration IDs upfront (0094 for `qds_intake`, 0095 for `seeds_story`) to avoid collisions — coordinate via the sprint tracker. (c) If a collision is discovered after both stories have written migration files, combine into a single migration with two `CREATE INDEX` statements (only after agreeing on the shared migration ID via sprint tracker coordination).

## Files to Modify

- `hermes/src/comms/qds-command.ts`
- `hermes/src/managers/dev-manager.intake.ts` (includes application-level find-before-insert dedup query: `SELECT id FROM issues WHERE company_id = ? AND origin_kind = 'qds_intake' AND origin_id = ?`)
- `hermes/src/paperclip/issues.ts`
- `hermes/src/comms/gateway-fallback.ts`
- `paperclip/packages/db/src/migrations/0094_qds_intake_origin_unique_index.sql` (new — partial unique index on `(companyId, originKind, originId) WHERE originKind='qds_intake'`)
- `hermes/test/intake/qds-intake.e2e.test.ts`

## Security Invariants

> Triggered by: auth (intake authenticates issue-create — NFR-SEC-2), input/file (untrusted `/qds` request body parsed into an issue).

- **INV-1 (authenticated create only):** The issue-create POST authenticates as the Dev manager (bearer `PAPERCLIP_API_KEY` + `x-paperclip-run-id` header, reusing P1.1's client). No anonymous or unauthenticated issue-create path exists; a key-misconfig fails closed (no issue created).
- **INV-2 (untrusted input sanitized + bounded):** The `/qds <request>` body is untrusted input — it is length-bounded to 500 characters max (see Technical Notes) and stored as data in `issues` fields (never interpolated into a query, shell, or control field); an empty/oversized/unparsable body is rejected with an error reply, not silently coerced into an issue.
- **INV-3 (exactly-once / no duplicate authority):** The intake idempotency key (`originKind`+`originId`, partial-unique `(companyId, originKind, originId)`) guarantees a retry cannot create a second authoritative issue for the same intake — preventing duplicated work-unit authority (R2 mitigation).
- **Mode note (`local_trusted`):** Under `local_trusted`, the Paperclip server does not enforce auth; the client-side auth guard from P1.1 (INV-1) ensures only authenticated creates are issued. Server-enforced auth requires non-`local_trusted` configuration.

## Definition of Done

- [ ] **Impl:** `/qds <request>` reaches the Dev manager and creates one parent `issues` row (`parentId`=null, `status`=todo, `assigneeAgentId`=Dev manager).
- [ ] **Impl:** Intake is idempotent — duplicate delivery of the same request creates no second issue (upsert/return existing).
- [ ] **Impl:** Hermes-gateway fallback path creates the issue when the Telegram plugin is unavailable (OQ-3), and logs that the fallback was used.
- [ ] **Contract:** Issue-create uses real `issues` columns (`assigneeAgentId`, `status`, `parentId`, `originKind`/`originId`) with field validation; idempotency backed by the partial-unique `(companyId, originKind, originId)` index pattern.
- [ ] **Migration:** Migration `0094` adds the partial unique index on `(companyId, originKind, originId) WHERE originKind='qds_intake'`; applied and table queryable.
- [ ] **Integration:** Create POST authenticates via the P1.1 client (bearer + `x-paperclip-run-id` header) against live `localhost:3100`.
- [ ] **Observability/Audit:** The intake → issue handoff is logged with issue-id correlation (NFR-OBS-3); the created issue is the queryable top of the §8.4 decomposition hop.
- [ ] **Security:** Untrusted `/qds` body is length-bounded and rejected on empty/oversized/unparsable input (INV-2); create is authenticated-only (INV-1).
- [ ] **Test (unit/integration):** Covers single-create assignment, idempotent retry (no duplicate), and the empty/oversized-body rejection guard path.
- [ ] **Test (e2e demo — MANDATORY):** Against live `localhost:3100`, submit `/qds <request>`, assert exactly one parent issue with `assigneeAgentId`=Dev manager; re-submit the identical request and assert `count`=1 unchanged — proves wiring closed and "exactly one".

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
