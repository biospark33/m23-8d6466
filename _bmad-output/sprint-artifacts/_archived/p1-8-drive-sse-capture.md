# P1.8: Dev manager drives the Archon run and captures the dashboard SSE stream

**Story Points:** 3

## Spec Reference

- PRD §6.2 (Manager — Hermes), §6.3 (Orchestration — Archon DAG); FR-MG-4, FR-OR-5, FR-OR-7; NFR-OBS-1, NFR-OBS-3
- PRD §4.1 (Hermes concurrency model — Phase-1 SSE consumed sequentially/blocking); §8.1 (audit chain, Archon-run hop)
- Phase exit gate: PRD §13 Phase-1 item 6 ("the Dev manager starts the run and consumes the dashboard SSE stream, capturing progress + final output correlated to the issue id")

## User Story

As a **Dev manager (Hermes)**,
I want **to launch an Archon `qds-piv-loop` run for an issue, consume its dashboard SSE stream, and persist a run log correlated to the issue id (reconnect-safe)**,
so that **live progress + final output are bound to the originating issue, making the Archon-run hop of the audit chain reconstructable (goal G1 accountability).**

## Overview

This slice cuts through Hermes → Archon (`POST /api/workflows/qds-piv-loop/run` + `GET /api/stream/__dashboard__`) → run-log persistence. The Dev manager registers as a `hermes_local` agent (host-injected `PAPERCLIP_API_KEY` + `PAPERCLIP_RUN_ID`), starts the run, then opens the dashboard SSE stream and consumes it **sequentially/blocking** (Phase-1 Hermes model — no async child-runner). Each SSE event is correlated to the issue id and appended to a persisted, retrievable run log; on a transport drop the consumer **reconnects from the last seen event** (Last-Event-ID), not from scratch. One atomic unit because "drive" without "capture-correlated-to-issue" leaves the audit hop dangling, and capture without reconnect-safety silently loses telemetry.

## E2E Slice

**Demonstrable behavior:** The Dev manager calls `POST /api/workflows/qds-piv-loop/run` (authenticated) for a Paperclip issue, receives the run id, opens `GET /api/stream/__dashboard__`, and consumes the SSE stream to completion. A persisted run log exists, every captured event carries the issue id, and the **final node output is present in the log** — all readable by issue id after the run. Killing the SSE connection mid-stream and reconnecting resumes from the last event with no duplicate/lost events in the persisted log.

**Wiring closed:** On completion of this story, the Dev manager calling `POST /api/workflows/qds-piv-loop/run` then consuming `GET /api/stream/__dashboard__` produces **a persisted run log, retrievable by issue id, containing the run's progress events and final output, every event correlated to that issue id** — using only code merged by this story (auth'd run-start + blocking SSE consumer + reconnect-safe persistence in the Hermes Dev-manager path). No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P1.1 (Dev manager registered as a Paperclip `hermes_local` agent with injected `PAPERCLIP_API_KEY`/`PAPERCLIP_RUN_ID`) · P1.4 (the registered `qds-piv-loop` workflow that this story runs, worktree-isolated per FR-OR-5). Both are dependency edges, not unfinished wiring inside this story.

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given a Paperclip issue and a registered `qds-piv-loop` workflow, When the Dev manager starts the run via `POST /api/workflows/qds-piv-loop/run` and consumes `GET /api/stream/__dashboard__` to completion, Then a persisted run log retrievable **by issue id** exists, contains the final node output, and **every captured event carries that issue id** (live telemetry bound to the issue id — no missing correlation).
2. Given an in-progress SSE stream, When the connection drops and the consumer reconnects, Then consumption resumes from the last seen event (`Last-Event-ID`) and the persisted log contains **no duplicate and no lost events** (reconnect-safe).
3. Given the run reaches terminal state (`failed`/`cancelled`), When the stream ends without a final-output event, Then the persisted log records the terminal status correlated to the issue id and the consumer exits cleanly (never blocks unbounded).

## Technical Notes

- **Contracts/Schema:** Run-start request body per Archon `POST /api/workflows/{name}/run` (handler `api.ts:1784`). Persisted run-log record: `{ issueId: uuid, runId: string, events: Array<{ id: string, type: string, ts: string, data: object }>, finalOutput: object|null, terminalStatus: string }` — keyed/indexed on `issueId` for FR-OR-7 retrieval. Correlation key = the Paperclip issue id (issue carries `executionRunId`/`checkoutRunId`, `issues.ts:37-38`).
- **Integration points (each wired & exercised in this story):** `POST /api/workflows/qds-piv-loop/run` (run-start, bearer-auth'd) → `GET /api/stream/__dashboard__` (`api.ts:1384`, SSE) consumed **sequentially/blocking** (§4.1) → run-log persistence with issue-id correlation → retrieval-by-issue-id. Reconnect uses SSE `Last-Event-ID`.
- **Files / functions touched:** Hermes Dev-manager run-driver (start + SSE consume loop); the run-log persistence + retrieval-by-issue helper; the SSE client with reconnect/Last-Event-ID handling.
- **Guards/limits:** Phase-1 consumption is blocking per the §4.1 join-barrier model (no async child-runner — Phase 3). SSE consume loop has a wall-clock bound so a stalled stream surfaces as a terminal log entry, never an unbounded blocking wait.

## Files to Modify

- `src/hermes/run-driver.ts`
- `src/hermes/sse-consumer.ts`
- `src/hermes/run-log-store.ts`
- `src/hermes/paperclip-client.ts`
- `tests/hermes/drive-sse-capture.test.ts`

## Security Invariants

> Triggered: auth (Paperclip REST bearer auth + run-scoped header on every call).

- **INV-1 (bearer + run-scoped header):** every call to `POST /api/workflows/.../run` and `GET /api/stream/__dashboard__` sends `Authorization: Bearer <PAPERCLIP_API_KEY>` + the `PAPERCLIP_RUN_ID` run-scoped header (NFR-SEC-2); the key is read from the host-injected env (`hermes_local` adapter `registry.ts:468-469`), never hardcoded.
- **INV-2 (no secret in the log):** `PAPERCLIP_API_KEY` / bearer token is never written to the persisted run log, stdout, or any captured SSE event payload (NFR-SEC-1 — credentials referenced, never materialized into the audit artifact).
- **INV-3 (correlation integrity):** the issue-id correlation on each persisted event is set from the manager's own authenticated run context, not from untrusted SSE event data — a stream event cannot rebind the log to a different issue id (prevents cross-issue telemetry mixing).
- **INV-4 (no unauth retrieval surface):** the retrieve-by-issue-id helper reads only the local persisted store; it does not expose an unauthenticated network endpoint for the run log in this story.

## Definition of Done

- [ ] **Impl:** Dev manager starts the run via `POST /api/workflows/qds-piv-loop/run` and receives the run id.
- [ ] **Impl:** SSE consumer reads `GET /api/stream/__dashboard__` sequentially/blocking to stream completion (§4.1).
- [ ] **Impl:** every captured SSE event is persisted to a run log correlated to the issue id; final node output is captured.
- [ ] **Contract:** run-log record schema (`issueId`, `runId`, `events[]`, `finalOutput`, `terminalStatus`) defined and indexed on `issueId` for FR-OR-7 retrieval.
- [ ] **Integration:** reconnect path uses `Last-Event-ID`; resume produces no duplicate and no lost events in the persisted log.
- [ ] **Security:** INV-1 enforced — bearer + `PAPERCLIP_RUN_ID` header on both Archon calls, key from injected env; covered by a test asserting headers present.
- [ ] **Security:** INV-2 enforced — no token value appears in the persisted run log (asserted by a log-scan test).
- [ ] **Observability:** every cross-component handoff event is logged with issue-id correlation (NFR-OBS-3); the run log is retrievable post-hoc by issue id (NFR-OBS-1).
- [ ] **Test (unit/integration):** covers start→consume→persist, the `failed`/`cancelled` terminal path, and the reconnect (no-dup/no-loss) path.
- [ ] **Test (e2e demo — MANDATORY):** Dev manager drives a real `qds-piv-loop` run, consumes `__dashboard__` SSE, then a kill-mid-stream + reconnect; assert the run log retrieved **by issue id** contains the final output and every event carries the issue id with no duplicate/lost events (proves wiring closed: live telemetry bound to the issue id, reconnect-safe).

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
