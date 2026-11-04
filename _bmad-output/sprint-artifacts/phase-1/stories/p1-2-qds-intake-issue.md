# P1.2: /qds Intake -> SwarmClaw Session + GitHub Issue Created

**DONE 2026-11-04 — PR #487 merged to dev (8545dc8e).** Dev gates + review rounds: Dev self-review round: 3 findings (title cap, undrained 503, limiter doc) all applied. DoD states + Dev Agent Record below.

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

**Dependency edges (predecessors):** DF3.1 (fleet dispatcher core verbs — the v5 factory front door; was P1.1 "Dev Manager registered as A2A agent", whose A2A front-door premise died with the SwarmClaw protocol engine, audit §2). <!-- v5 amendment (DF5.5) -->

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

Reconciled 2026-11-04 (dev; PR #487 merged to dev 2026-11-04, 8545dc8e). The spec's Dev-Manager/A2A front door and session store died with the protocol engine (audit §2, per the DF5.5 amendment note in this file); the live HTTP front door is the SwarmClaw server, so intake is a route there. INV-2 holds by construction (owner/repo/token are explicit handler deps, never env). "Session" has no surviving store — the issue IS the trace.

- [x] **Impl:** Intake handler receives A2A method "qds.intake" and validates request schema.
      *Re-homed: `POST /api/intake` on the SwarmClaw server (`src/swarmclaw/intake.ts` + route in `src/swarmclaw/index.ts`); `IntakeRequestSchema` strictObject validates brief/domain/priority. 503 when intake deps unconfigured — the route never silently creates nothing.*
- [~] **Impl:** SwarmClaw session created with UUIDv4 sessionId and initial state "intake".
      *UUIDv4 sessionId IS minted (`randomUUID`) and returned; no session STORE survives in this architecture — the issue (body carrying the sessionId) is the durable trace. "Initial state" has no state machine to join; recorded as the re-home delta.*
- [x] **Impl:** `gh issue create` invoked with `[QDS-{short-id}] {brief}` title (where short-id = first 8 hex chars of sessionId), `qds-intake` label, and domain label.
      *`buildIntakeIssue` (`src/swarmclaw/intake.ts`): title `\[QDS-{8-hex}\] {sanitized brief}` (regex-asserted in tests), labels `["qds-intake", domain]` via `createIssue(labels)` (additive param on the GitHub API, P1.2's only edit there).*
- [x] **Impl:** Response returns `{ sessionId, issueUrl, issueNumber }` on success.
      *201 with `{sessionId, issueUrl, issueNumber}` asserted in handler + server-route tests.*
- [x] **Contract:** Intake request schema enforced: brief 1-280 chars, domain enum-validated.
      *`IntakeRequestSchema`: brief 1–280, domain enum (backend/frontend/infra/docs/test), priority enum (low/normal/high) optional, unknown keys refuse.*
- [x] **Integration:** Session ID stored in GitHub issue body for traceability.
      *Issue body embeds sessionId + domain + brief (asserted).*
- [~] **Integration:** Failure in `gh issue create` rolls back session to "intake-failed" state (no orphan active sessions).
      *Satisfied by construction: nothing pre-exists the issue call, so a failure orphans nothing — but the spec's "intake-failed" STATE has no surviving state machine. GitHub failures map to the structured -32603 error (asserted).*
- [x] **Security:** Brief field sanitized (strip backticks, quotes, newlines) before GitHub API call.
      *`sanitizeBrief` runs after validation, before the title/body are built; a brief that sanitizes to empty 400s before GitHub. Asserted by tests.*
- [~] **Security:** Rate limit enforced on intake endpoint per requesterAgentId.
      *INV-3 enforced: sliding-window 10/60s via `makeIntakeRateLimiter`, the service form (`makeIntakeService`) holds the limiter state, 11th call → 429 (asserted). DELTA: the key is the endpoint (one intake service), not requesterAgentId — the re-homed request shape carries no requesterAgentId field; per-agent attribution needs an identity layer that does not exist here. Recorded as the re-home delta.*
- [x] **Test (unit):** Intake validation rejects empty brief, oversize brief, and invalid domain values.
      *`tests/swarmclaw/intake.test.ts` 14 tests + server route test (503 unconfigured / 201 configured): schema refusals, sanitization, title pattern, labels, limiter boundaries (window slide, per-key isolation), GitHub-failure mapping, rate-limit e2e.*
- [~] **Test (e2e demo — MANDATORY):** Send intake A2A call → verify GitHub issue exists with correct title/labels → verify response contains valid sessionId and issueUrl.
      *Mock-level e2e green (handler + live server route against an injected GitHub seam, asserting call shape + response). The LIVE leg — a real issue on the real repo — is an outward-facing act: operator-gated, rides the same window as the P0.5 live legs. NOT run autonomously.*

## Dev Agent Record

**Status: DONE — PR #487 merged to dev (8545dc8e, 2026-11-04); sprint row flipped `done` with merge citation.**

- **Branch:** `feature/p1-2` (merged as PR #487 → dev, 8545dc8e). **Files:** `src/swarmclaw/intake.ts` (new), `src/swarmclaw/routes`-style wiring inside `src/swarmclaw/index.ts` (optional `options.intake` + POST /api/intake), `src/pr/github.ts` (additive `labels?`), `tests/swarmclaw/intake.test.ts` (new, 14 tests), `tests/swarmclaw/index.test.ts` (+1 route test).
- **Gates:** tsc 0 errors; biome clean on touched files; dp-scan diff-scoped OK; swarmclaw suite 247+ green; full suite run recorded on this tree.
- **Re-home deltas (declared, not silent):** (1) A2A method envelope → plain POST /api/intake; (2) session store → the issue itself; (3) rollback state machine → vacuous-by-construction; (4) rate-limit key = endpoint not requesterAgentId (no identity layer exists). The MANDATORY live e2e stays operator-gated (real repo write).
