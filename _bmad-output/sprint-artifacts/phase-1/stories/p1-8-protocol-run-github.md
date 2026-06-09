# P1.8: Drive Protocol Run + Capture Correlated to GitHub Issue

**Story Points:** 3

## Spec Reference

- PRD §3.1, §3.3; FR-MG-4, FR-OR-5, FR-OR-7

## User Story

As a dev manager,
I want to start a protocol run for a GitHub issue and see live execution state correlated to that issue,
so that I can track parallel/compare/decide/summarize phases and their outputs bound to the issue.

## Overview

The dev manager selects a GitHub issue and initiates a SwarmClaw protocol run. SwarmClaw executes its phases — dispatch_task, a2a_delegate, parallel, compare, decide, summarize — streaming execution state at each phase transition. All telemetry (phase, status, agent assignments, outputs) is correlated to the originating GitHub issue number. The dev manager can observe live progress and final output without needing a separate dashboard — the correlation is intrinsic to the run record.

## E2E Slice

**Demonstrable behavior:** Dev manager invokes SwarmClaw run with `issueId: 42`. SwarmClaw creates a protocol run, streams phase transitions (dispatch_task → parallel → compare → decide → summarize) with agent assignments and outputs. All run state is queryable by `issueId: 42`. Final summarize output includes the issue-correlated result.

**Wiring closed:** On completion of this story, a live protocol run produces execution telemetry (phases, agents, outputs) correlated to its GitHub issue number using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P1.1, P1.4

## Acceptance Criteria

1. **(make-or-break)** Given a GitHub issue exists and the dev manager initiates a protocol run with its issue number, When SwarmClaw processes the run, Then each phase transition (dispatch_task, a2a_delegate, parallel, compare, decide, summarize) emits a state event containing `runId`, `issueId`, `phase`, `status`, and `timestamp`.
2. Given a protocol run is in progress, When the dev manager queries run state by `issueId`, Then the response includes current phase, assigned agents, phase outputs so far, and elapsed time — all correlated to that issue.
3. Given a protocol run completes the summarize phase, When the run finishes, Then the final output is persisted with the `issueId` correlation and is retrievable by issue number alone.
4. Given the SwarmClaw service is unreachable, When a run is attempted, Then the dev manager receives a clear error with `runId: null` and no partial run state is persisted.

## Technical Notes

- **Contracts/Schema:** `ProtocolRun { runId: string, issueId: number, phases: PhaseRecord[], status: 'running' | 'completed' | 'failed', createdAt: ISO8601, completedAt?: ISO8601 }`. `PhaseRecord { phase: ProtocolPhase, status: PhaseStatus, agents: string[], output?: PhaseOutput, startedAt: ISO8601, completedAt?: ISO8601 }`. `ProtocolPhase = 'dispatch_task' | 'a2a_delegate' | 'parallel' | 'compare' | 'decide' | 'summarize'`.
- **Integration points:** SwarmClaw `/api/a2a` JSON-RPC 2.0 endpoint for run initiation and state queries; GitHub issue metadata for correlation; Hindsight `{repo}` bank for run persistence.
- **Files / functions touched:** `src/protocol/run-manager.ts` (run lifecycle), `src/protocol/phase-executor.ts` (phase transitions and streaming), `src/protocol/issue-correlator.ts` (issue binding), `src/models/protocol-run.ts` (schema), `src/api/routes/run-routes.ts` (API surface).
- **Guards/limits:** Maximum concurrent runs per issue: 1. Run state events buffered and flushed every 5s to Hindsight. Phase timeout: 10 minutes per phase.

## Files to Modify

- `src/protocol/run-manager.ts`
- `src/protocol/phase-executor.ts`
- `src/protocol/issue-correlator.ts`
- `src/models/protocol-run.ts`
- `src/api/routes/run-routes.ts`

## Security Invariants

- INV-RUN-1: A protocol run cannot be initiated for an issue that already has a run in `running` status — enforced by unique constraint on `(issueId, status='running')`.
- INV-RUN-2: Run state events are append-only — no mutation of historical phase records after they are persisted.
- INV-RUN-3: Run telemetry is scoped to the originating issue — cross-issue data leakage is prohibited.

## Definition of Done

- [ ] **Impl:** Dev manager initiates SwarmClaw protocol run with GitHub issue number
- [ ] **Impl:** Phase transitions stream state events with `runId`, `issueId`, `phase`, `status`, `timestamp`
- [ ] **Impl:** Run state queryable by `issueId` — returns current phase, agents, outputs, elapsed time
- [ ] **Impl:** Final summarize output persisted with issue correlation and retrievable by issue number
- [ ] **Contract:** `ProtocolRun`, `PhaseRecord`, `ProtocolPhase` schemas defined and exported
- [ ] **Integration:** SwarmClaw JSON-RPC 2.0 endpoint at `/api/a2a` for run lifecycle; Hindsight `{repo}` bank for persistence
- [ ] **Security:** Duplicate-run guard per issue; append-only phase records; issue-scoped telemetry
- [ ] **Test (unit):** Run creation with issue binding; phase transition event emission; state query by issueId; duplicate-run rejection
- [ ] **Test (e2e demo — MANDATORY):** End-to-end run for issue #42 through all 6 phases with live state streaming and final output correlated to issue #42
