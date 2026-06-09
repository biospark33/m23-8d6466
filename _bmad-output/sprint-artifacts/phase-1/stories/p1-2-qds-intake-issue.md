# P1.2: /qds Intake -> SwarmClaw Session + GitHub Issue Created

**Story Points:** 3

## Spec Reference

- PRD §5, §6; FR-MG-2, FR-CM-1
- Phase exit gate: PRD §13 Phase 1 clause 2

## User Story

As a QDS factory operator,
I want a /qds intake command to create a SwarmClaw session and a corresponding GitHub issue,
so that every factory request has a tracked, traceable work item from inception.

## Overview

When the Dev Manager agent receives an intake request via A2A (simulating a /qds command), it creates a new SwarmClaw session and opens a GitHub issue via `gh issue create`. The issue title follows the convention `[QDS-{short-id}] {brief}` where `{short-id}` is the first 8 hex characters of the UUIDv4 sessionId, and labels include `qds-intake` and any domain labels extracted from the request. The full session ID is embedded in the issue body for traceability. This story closes the loop from intake to an owned, labeled GitHub issue.

## E2E Slice

**Demonstrable behavior:** A POST to /api/a2a with method "qds.intake" carrying `{ "brief": "Add auth middleware", "domain": "backend" }` results in: (1) a SwarmClaw session created, (2) a GitHub issue with title `[QDS-{short-id}] Add auth middleware` labeled `qds-intake, backend`, (3) the A2A response contains `{ sessionId, issueUrl, issueNumber }`.

**Wiring closed:** On completion of this story, an intake A2A call produces exactly one owned GitHub issue and one SwarmClaw session, linked by session ID, using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P1.1 (Dev Manager registered as A2A agent).

## Acceptance Criteria

1. **(make-or-break)** Given the Dev Manager is registered, When POST /api/a2a with method "qds.intake" and body `{ "brief": "Add auth middleware", "domain": "backend" }`, Then a GitHub issue is created via `gh issue create` with title matching `^\[QDS-[a-f0-9]{8}\] Add auth middleware$` (first 8 hex chars of the UUIDv4 sessionId) and labels `qds-intake, backend`.
2. Given the intake call succeeds, When the response is returned, Then it contains `{ sessionId: string, issueUrl: string, issueNumber: number }` where issueUrl is a valid GitHub URL.
3. Given `gh issue create` fails (e.g., repo not found, auth expired), When the intake handler catches the error, Then the A2A response contains a structured JSON-RPC error with code -32603 and a message containing "GitHub issue creation failed", and no orphan session is left in an active state.

## Technical Notes

- **Contracts/Schema:** Intake request: `{ brief: string (1-280 chars), domain?: string (one of: backend, frontend, infra, docs, test), priority?: "low"|"normal"|"high" }`. Intake response: `{ sessionId: string (UUID), issueUrl: string (https URL), issueNumber: number (positive int) }`.
- **Integration points:** SwarmClaw /api/a2a (receives intake call), SwarmClaw session manager (creates session), `gh issue create` CLI (creates GitHub issue), GitHub API (issue persistence).
- **Files / functions touched:** Intake handler in Dev Manager agent, SwarmClaw session creation module, GitHub issue creation wrapper, intake validation schema.
- **Guards/limits:** brief must be 1-280 characters. domain must be one of the allowed enum values or omitted. Maximum 10 intake calls per minute per requesterAgentId (rate limit). Session ID is UUIDv4.

## Files to Modify

- `src/dev-manager/handlers/intake.ts`
- `src/swarmclaw/sessions/manager.ts`
- `src/integrations/github/issue-creator.ts`
- `src/schemas/intake-request.ts`
- `tests/e2e/qds-intake.test.ts`

## Security Invariants

- INV-1: brief field is sanitized before insertion into GitHub issue title (no injection via backticks, quotes, or newlines).
- INV-2: `gh` CLI invocation uses `--repo` flag explicitly; no implicit repo from environment.
- INV-3: Rate limit enforced: max 10 intake requests per minute per requesterAgentId; excess requests return 429.

## Definition of Done

- [ ] **Impl:** Intake handler receives A2A method "qds.intake" and validates request schema.
- [ ] **Impl:** SwarmClaw session created with UUIDv4 sessionId and initial state "intake".
- [ ] **Impl:** `gh issue create` invoked with `[QDS-{short-id}] {brief}` title (where short-id = first 8 hex chars of sessionId), `qds-intake` label, and domain label.
- [ ] **Impl:** Response returns `{ sessionId, issueUrl, issueNumber }` on success.
- [ ] **Contract:** Intake request schema enforced: brief 1-280 chars, domain enum-validated.
- [ ] **Integration:** Session ID stored in GitHub issue body for traceability.
- [ ] **Integration:** Failure in `gh issue create` rolls back session to "intake-failed" state (no orphan active sessions).
- [ ] **Security:** Brief field sanitized (strip backticks, quotes, newlines) before GitHub API call.
- [ ] **Security:** Rate limit enforced on intake endpoint per requesterAgentId.
- [ ] **Test (unit):** Intake validation rejects empty brief, oversize brief, and invalid domain values.
- [ ] **Test (e2e demo — MANDATORY):** Send intake A2A call → verify GitHub issue exists with correct title/labels → verify response contains valid sessionId and issueUrl.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
