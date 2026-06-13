# P1.15: SwarmClaw Protocol → Real PR Produced on Sample Repo

**Story Points:** 4

## Spec Reference

- PRD §6, §7; FR-OR-1, FR-OR-7, FR-EX-6

## User Story

As a QDS platform operator,
I want the SwarmClaw protocol to run end-to-end from task dispatch through PR creation on a real GitHub repository,
so that the full automated development pipeline is demonstrated as a working artifact.

## Overview

This is THE make-or-break story for Phase 1. The full qds-factory protocol runs end-to-end on a sample task against a sample repository. The flow: SwarmClaw receives a dispatch_task call, which triggers CLI-Anything to invoke `warren run` with the appropriate Pi team configuration. Warren runs the Pi agents inside their burrow. Upon completion, Warren opens a pull request on the sample repo via the GitHub API. The GitHub PR webhook fires back to SwarmClaw's `/api/webhooks/[id]` endpoint. SwarmClaw receives the webhook, correlates it to the running protocol, and advances the protocol to the summarize phase. Every hop in this chain is wired and operational — no stubs, no manual steps.

## E2E Slice

**Demonstrable behavior:** A `dispatch_task` JSON-RPC call to SwarmClaw with a sample task (e.g., "Add a hello-world function to utils.py") produces a real, merged-open PR on the sample repository. The GitHub webhook fires back to SwarmClaw, the protocol advances through all phases, and the PR is visible on GitHub with the correct changes.

**Wiring closed:** On completion of this story, `dispatch_task` → CLI-Anything → `warren run` → Pi agents → Warren PR → GitHub webhook → SwarmClaw summarize produces a demonstrable artifact (the PR) using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors (reconciled list below) are dependency edges, not unfinished wiring inside this story.

**Dependency edges (predecessors):** P1.6, P1.8, P1.11.

> **Predecessor reconciliation (PR #21, QDS-EXEC-001):** Three prior predecessors — P1.3 (GitHub seeds mirror), P1.7 (post-edit LSP gate), P1.12 (mulch prime/record) — remain **deferred** per the 4-week execution plan §4.2 and are NOT hard dependencies for the lights-on artifact. Their load-bearing capabilities are carried by seams / KEEP stories: intake via **P1.2** (`/qds` intake → session + GitHub issue, KEEP), not the deferred P1.3 mirror; quality signal via **P0.5** (pi-lens diagnostics, KEEP) with the P1.7 gate-hook point left open in the emit phase; mulch via the **SPIKE-7**-validated binary (empty Hindsight bank is a non-error condition per P1.6 AC4). **P1.8** (protocol run + issue correlation) was restored as a hard predecessor after the P1.17-exit-gate cascade decision un-deferred it (see execution plan §4.1). Hard technical predecessors retained: **P1.6** (Pi-team dispatch), **P1.8** (protocol run + issue correlation), **P1.11** (Hindsight prime/retain).
>
> **Plan-soundness note:** P1.15 still runs on seams for the three remaining deferred items (P1.3/P1.7/P1.12) — the execution plan's explicit design (§4.1 lists P1.15 as the lights-on KEEP story). If seam-only viability is later challenged in practice, the remedy is to re-add those deferred stories before P1.15 — not new architecture.

## Acceptance Criteria

1. **(make-or-break)** Given a `dispatch_task` JSON-RPC call to SwarmClaw `/api/a2a` with a valid sample task, When the protocol completes, Then a real PR exists on the sample GitHub repository containing the requested changes.
2. Given the protocol is running, When Warren completes the Pi agent run, Then Warren opens a PR via GitHub API with correct branch naming (e.g., `qds/{runId}`), title, and body referencing the runId.
3. Given Warren has opened the PR, When the GitHub webhook fires, Then SwarmClaw's `/api/webhooks/[id]` endpoint receives the `pull_request.opened` event and correlates it to the active protocol run via the branch name or metadata.
4. Given SwarmClaw receives the webhook, When correlation succeeds, Then the protocol advances to the summarize phase and the run reaches a terminal state.
5. Given any step in the chain fails (e.g., `warren run` exits non-zero), When the error propagates, Then SwarmClaw records the failure in the protocol state and does not hang or retry indefinitely.

## Technical Notes

- **Contracts/Schema:** dispatch_task request: `{ jsonrpc: "2.0", method: "dispatch_task", params: { task_description: string, repo_url: string, archetype: string, protocol: "parallel" | "a2a_delegate" }, id: string }`. SwarmClaw response includes `runId`. Webhook payload: standard GitHub `pull_request` webhook event. Correlation key: branch name pattern `qds/{runId}` or PR body metadata tag.
- **Integration points:** SwarmClaw `/api/a2a` → CLI-Anything internal dispatch → `warren run` CLI invocation → Pi agents inside Warren burrow → Warren GitHub API client → GitHub PR → GitHub webhook → SwarmClaw `/api/webhooks/[id]` → protocol state machine advance.
- **Files / functions touched:** `src/swarmclaw/routes/a2a.ts` (dispatch_task handler), `src/swarmclaw/phases/dispatch.ts` (task dispatch logic), `src/cli-anything/runner.ts` (warren run invocation), `src/swarmclaw/routes/webhooks.ts` (GitHub webhook receiver), `src/swarmclaw/protocol.ts` (state machine, phase transitions), `src/swarmclaw/correlation.ts` (webhook-to-run correlation).
- **Guards/limits:** Protocol must have a timeout (default 30 min) to prevent hanging. Warren run must capture stdout/stderr for diagnostics. Webhook correlation must fail closed (reject uncorrelated webhooks, log warning). Sample repo must be a disposable test repository.

## Files to Modify

- `src/swarmclaw/routes/a2a.ts`
- `src/swarmclaw/phases/dispatch.ts`
- `src/cli-anything/runner.ts`
- `src/swarmclaw/routes/webhooks.ts`
- `src/swarmclaw/protocol.ts`
- `src/swarmclaw/correlation.ts`

## Security Invariants

- INV-1: Webhook endpoint validates GitHub webhook signature (HMAC-SHA256) before processing — rejects unauthenticated payloads.
- INV-2: SwarmClaw only acts on repos explicitly registered in its configuration — no open-redirect to arbitrary repositories.
- INV-3: Warren run executes in an isolated burrow — no host filesystem access beyond the cloned repo workspace.
- INV-4: GitHub tokens are stored in environment variables, never logged or written to outcome records.

## Definition of Done

- [ ] **Impl:** SwarmClaw `dispatch_task` JSON-RPC handler on `/api/a2a` validates request and returns `runId`.
- [ ] **Impl:** CLI-Anything invokes `warren run` with correct arguments (task, archetype, repo URL, runId).
- [ ] **Impl:** Warren Pi team execution completes and opens PR on sample repo via GitHub API.
- [ ] **Impl:** SwarmClaw `/api/webhooks/[id]` receives GitHub PR webhook and validates HMAC-SHA256 signature.
- [ ] **Impl:** Webhook-to-run correlation via branch name pattern `qds/{runId}` or PR body metadata.
- [ ] **Contract:** JSON-RPC 2.0 request/response schema for dispatch_task validated.
- [ ] **Integration:** Full chain: dispatch → CLI-Anything → warren run → Pi agents → PR → webhook → summarize confirmed.
- [ ] **Integration:** Protocol timeout guard prevents indefinite hangs (default 30 min).
- [ ] **Security:** Webhook signature validation enforced; invalid signatures rejected with 403.
- [ ] **Test (unit):** Correlation logic: given webhook payload with known branch name, returns correct runId.
- [ ] **Test (e2e demo — MANDATORY):** dispatch_task on sample repo produces a real, inspectable PR on GitHub; webhook fires back; protocol reaches summarize state.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
