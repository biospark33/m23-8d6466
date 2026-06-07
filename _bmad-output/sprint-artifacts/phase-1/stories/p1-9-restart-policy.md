# P1.9: Restart policy classifies a failed run and bounds retries by cap

**Story Points:** 3

## Spec Reference

- PRD §6.2 (Manager — Hermes); FR-MG-8 (restart policy: transient→resume / overflow→re-scope / logic→replan, bounded by retry + wall-clock caps), FR-MG-9 (classify failure signal into restart category + log so retry-count is attributable by cause)
- Supporting NFRs: NFR-SAF-2 (story bound ≤8 retries AND ≤1h wall-clock, else logged human gate), NFR-REL-2 (restart classification deterministic given the failure signal)
- Phase exit gate: PRD §13 Phase-1 — bounded-restart safety (no unbounded restart loop; every restart classified + capped + logged)

## User Story

As the Dev manager (Hermes),
I want each failed Archon run classified deterministically into a restart category and the per-story retry budget bounded by hard retry + wall-clock caps,
so that a failing story re-runs only within safe bounds and escalates to a logged human gate at the cap instead of looping unbounded (G1 safe autonomy).

## Overview

A vertical slice through the Hermes manager seam that consumes an Archon run's terminal signal and decides the next action. It cuts: terminal run signal (Archon exposes only `failed`/`cancelled` at the run layer — `workflow-run.ts:10-32`, `RESUMABLE={failed,paused}` `:29-32`; no `TIMEOUT`/`LOGIC_ERROR` enum on disk) → deterministic classifier reconstructing the finer class from the node error string, the `err.killed` timeout flag, the `cost_events` token sum, or a launcher-emitted `exit_class` (§4.6) → restart action (transient→resume from checkpoint, overflow→re-scope Seeds story, logic→escalate to human gate via FR-CP-5) → bounded retry accounting persisted to the run trace. NFR-SAF-2's dual cap (≤8 retries AND ≤1h wall-clock) is the backstop: at either ceiling the policy stops auto-retrying and writes a logged human gate. One atomic 3-pt unit — a single classify-and-bound decision exercised on an induced failure, with the WarrenClient run substrate (P1.6) providing the cost-events signals and run duration data.

## E2E Slice

**Demonstrable behavior:** `applyRestartPolicy(run)` is invoked on a terminal Archon run whose failure signal is induced (transient = `err.killed` wall-clock kill; overflow = `cost_events` token sum over threshold; logic = launcher `exit_class:"logic"`). For each case the policy returns the **deterministic** restart category and the bounded next action, and writes a `restart_decisions` record `{runId, retryClass, retryCount, action, reason}` + bumps the per-story retry counter on `heartbeat_runs`. When the induced failure pushes retryCount past 8 OR cumulative wall-clock past 1h, the policy returns `action:"human_gate"`, writes the gate to `approvals`/`issue_execution_decisions`, and does **not** auto-retry.

**Wiring closed:** On completion of this story, invoking `applyRestartPolicy(run)` on an induced transient/overflow/logic failure produces a deterministic `retryClass` + a bounded next action persisted to `restart_decisions` and the retry counter — and at the retryCount ≥ 8 / ≥1h wall-clock cap produces `action:"human_gate"` (no further auto-retry) — using only code merged by this story (the classifier, the cap accounting, and the decision-record writer). No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P1.6 (WarrenClient emits the `exit_class` / cost-events signals and the per-run `durationMs` this classifier reads; this story consumes those signals — it does not produce them).

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given a story already at retryCount 8 (or cumulative wall-clock ≥ 1h) and a fresh failed run, When `applyRestartPolicy(run)` is invoked, Then it returns `action:"human_gate"` (never an auto-retry), writes one `restart_decisions` row with `retryClass` set and `reason` naming the breached cap (`retry_cap`|`wall_clock_cap`), AND persists the gate to `approvals`/`issue_execution_decisions` — i.e. the retry loop is provably bounded with **no further launch**. Boundary semantics: `retryCount` counts completed retries. When `applyRestartPolicy` observes `retryCount >= 8` (8 completed retries), it returns `action:"human_gate"` — blocking the 9th attempt. The code-level cap condition is `retryCount >= 8`. This means exactly 8 auto-retries are permitted (retryCount 0–7); the 9th triggers the gate.
2. Given three induced terminal signals — `err.killed` timeout, `cost_events` token sum over threshold, launcher `exit_class:"logic"` — When `applyRestartPolicy` classifies each, Then it returns `transient`, `overflow`, `logic` respectively and the **same input always yields the same class** (deterministic, NFR-REL-2), each logged to `restart_decisions` so retry-count is attributable by cause. Additionally, given an overflow classification below both caps, When the policy acts, Then it returns `action:"rescope"` and increments the retry counter — proving the overflow→rescope path is exercised.
3. Given a `transient` classification below both caps, When the policy acts, Then it returns `action:"resume"` and increments the per-story retry counter by exactly 1 on `heartbeat_runs` — never a silent re-run that escapes the retry accounting.
4. Given a `cancelled` run (operator-initiated, `workflow-run.ts`), When `applyRestartPolicy` runs, Then it returns `action:"none"` and does NOT auto-restart — a cancel is never reclassified as a retryable failure.
5. Given an existing `restart_decisions` row with `retryClass:"logic"` for the same issue, When a second logic failure occurs, Then `action:"human_gate"` is returned regardless of retryCount — the second-hit escalation prevents unbounded replanning.

## Technical Notes

- **Contracts/Schema:** New `restart_decisions` record (Zod + persisted) `{ runId: string (uuid), issueId: string, retryClass: z.enum(["transient","overflow","logic"]).nullable(), retryCount: z.number().int().nonnegative(), action: "resume"|"rescope"|"replan"|"human_gate"|"none", reason: string, decidedAt: string (datetime) }`. `retryClass` is `null` when `workflowRun.status === "cancelled"` — bypasses classification, always returns `action:"none"`. When null, `action` is always `"none"` and `reason` is `"run_cancelled"`. Classifier input contract reconstructs class from: node error string, `err.killed` timeout flag, `cost_events` token sum (`SUM(inputTokens+outputTokens)` over the run's `heartbeatRunId`), launcher `exit_class` (`transient|overflow|logic`, §4.6 merged-output field). Retry lineage reuses existing `heartbeat_runs.retryOfRunId` (self-FK) + `processLossRetryCount` (existing integer column tracking cumulative restart attempts for the same issue) — backward-compatible (no column drop). **Migration note:** if `processLossRetryCount` does not exist on `heartbeat_runs` at dev time, migration `<next_number>_restart_decisions.sql` adds it as `INTEGER NOT NULL DEFAULT 0`. Human gate consumes existing `approvals` (`approvals.ts:5-28`) + `issue_execution_decisions` + `issues.executionPolicy` (`issues.ts:52`).
- **Integration points (each wired & exercised in this story):** (1) read Archon terminal signal (`workflow-run.ts:10-32`, `RESUMABLE={failed,paused}`); (2) read `cost_events` token sum for the overflow threshold (`cost_events.ts` `inputTokens`/`outputTokens`, by `heartbeatRunId`). Aggregation scope: by `heartbeatRunId`, summing `inputTokens + outputTokens` across ALL `cost_events` rows for that run instance; (3) write `restart_decisions` + bump the retry counter on `heartbeat_runs`. Column `retryOfRunId` verified at dev time; if absent, migration `<next_number>_restart_decisions.sql` adds it as nullable UUID self-FK; (4) on cap breach, write the human gate to `approvals`/`issue_execution_decisions` (no Archon re-launch). The classification feeds the §9.2 retry KPI (FR-ACT-2) and NFR-REL-2. Signals originate from P1.6 WarrenClient's run capture, not from a launcher guard.
- **Files / functions touched:** `src/hermes/restart-policy.ts:applyRestartPolicy` (classifier + cap accounting + action), `src/hermes/restart-classifier.ts:classifyFailure` (deterministic signal→class map), `src/db/schema/restart_decisions.ts` (record). References `workflow-run.ts:10-32`, `heartbeat_runs.ts`, `cost_events.ts`, `approvals.ts:5-28`.
- **Guards/limits:** dual NFR-SAF-2 cap — **≤8 retries AND ≤1h cumulative wall-clock**, whichever trips first → `human_gate`. The wall-clock cap is the backstop that bounds the loop even if retry-count accounting is undercounted; both are evaluated before any resume/rescope/replan launch. Both caps evaluated atomically before any restart action. If EITHER trips → `human_gate`. No ordering dependency between retry-count and wall-clock checks. Cumulative wall-clock = sum of each run's `durationMs` (`heartbeat_runs.endedAt` − `heartbeat_runs.startedAt`), excluding human-gate wait time. The timer counts only active run time. Unknown failure catch-all: when the failure signal doesn't match any known pattern, classifier returns `retryClass:"transient"` with a logged warning containing the raw signal. Unknown→transient retries count toward the standard ≤8 cap, not a separate budget. They are visible in `restart_decisions.reason` for observability. `replan` action exercise: first `logic` classification → `action:"replan"` (see H3). If a second `logic` failure occurs for the same issue → `action:"human_gate"`. Test coverage for both paths added to DoD.
- **Logic escalation path:** first `logic` classification → `action:"replan"` (one auto-replan attempt). Second `logic` failure for the same issue → `action:"human_gate"` (escalation). This gives a controlled auto-recovery path while preventing unbounded replanning.
- **Overflow token threshold:** `QDS_OVERFLOW_TOKEN_THRESHOLD` env var (default: 500000 combined input+output tokens). When `SUM(inputTokens + outputTokens)` over `heartbeatRunId` exceeds this threshold → `retryClass:"overflow"`. Configurable to align with P1.13 budget.
- **Citation caveat:** File:line references (e.g., `workflow-run.ts:10-32`, `approvals.ts:5-28`, `issues.ts:52`) are best-current-knowledge at spec time; the dev agent verifies exact locations at implementation. Migration number assigned at dev time based on existing migrations.
- **Unit clarity:** The overflow threshold (this story) is token-denominated — a secondary safety net. P1.13's cost ledger is cents-denominated and is the authoritative budget. These are complementary guards, not duplicates.
- **File separation rationale:** `restart-classifier.ts` is kept separate from `restart-policy.ts` because the classifier is a pure function (signal→class) with no side effects, while the policy handles cap accounting, DB writes, and action dispatch. Separation enables unit-testing classification in isolation.
- **Approvals ownership edge:** This story WRITES the human-gate row to `approvals`/`issue_execution_decisions`. P1.10 handles the approval resolution flow (read + act). Clean ownership edge.

## Files to Modify

> ≤10 unique paths.

- `src/hermes/restart-policy.ts`
- `src/hermes/restart-classifier.ts`
- `src/db/schema/restart_decisions.ts`
- `src/db/migrations/<next_number>_restart_decisions.sql` (dev agent determines next number)
- `tests/hermes/restart-classifier.test.ts`
- `tests/hermes/restart-policy.e2e.test.ts`

## Security Invariants

> Trigger: cost/budget (token-sum overflow read + bounded retry budget). Concrete named invariants only.

- **INV-1 (cost/budget — bounded retry spend):** the retry loop is hard-bounded by ≤8 retries AND ≤1h cumulative wall-clock (NFR-SAF-2); at either ceiling the policy emits `human_gate` and performs **no further auto-launch**, so a persistently failing story cannot burn unbounded credits via restart churn.
- **INV-2 (deterministic, non-evadable classification):** `classifyFailure` is a pure deterministic function of the failure signal (NFR-REL-2) — the same signal always yields the same class; an agent cannot influence its own classification to dodge the overflow→re-scope path or the cap.
- **INV-3 (overflow threshold reads the ledger, not a self-report):** the overflow decision reads the `cost_events` token sum keyed on `heartbeatRunId`, never a value supplied by the failing run itself, so a run cannot under-report tokens to avoid being re-scoped.
- **INV-4 (cap breach fails to a human gate, never a silent continue):** breaching either cap writes an `approvals`/`issue_execution_decisions` gate record and stops; it never silently swallows the failure or continues without escalation.

## Definition of Done

> 8–12 high-signal, story-specific boxes.

- [ ] **Impl:** `classifyFailure` deterministically maps each induced signal (timeout `err.killed`→transient, token-sum-over-threshold→overflow, `exit_class:"logic"`→logic, other `failed`→transient default, `cancelled`→none) to a class.
- [ ] **Impl:** `applyRestartPolicy` returns the bounded next action (`resume`/`rescope`/`replan`/`human_gate`/`none`) and increments the per-story retry counter on `heartbeat_runs` for every auto-retry.
- [ ] **Impl:** at retryCount ≥ 8 (9th attempt gated) OR cumulative wall-clock ≥ 1h, the policy emits `human_gate` and performs no further auto-launch.
- [ ] **Contract:** `restart_decisions` Zod schema + DDL added (`runId`/`issueId`/`retryClass`/`retryCount`/`action`/`reason`/`decidedAt`); `retryClass` and `action` enums field-validated; retry lineage reuses existing `heartbeat_runs.retryOfRunId` (backward-compatible).
- [ ] **Integration:** the overflow threshold reads the `cost_events` token sum by `heartbeatRunId`, and the human gate writes `approvals`+`issue_execution_decisions` (gate exercised end-to-end, not stubbed).
- [ ] **Observability:** every restart writes one `restart_decisions` row `{runId, retryClass, retryCount, action, reason}` so retry-count is attributable by cause and feeds the §9.2 retry KPI (FR-ACT-2).
- [ ] **Security:** classification is deterministic (NFR-REL-2) and the retry budget is hard-bounded (NFR-SAF-2) — both asserted by test, including that a cap breach never silently continues.
- [ ] **Test (unit/integration):** the three induced signals each classify to their expected class (and a repeat run yields the identical class — determinism), and the `cancelled`→`none` path is covered.
- [ ] **Test (e2e demo — MANDATORY):** drive a story to retryCount 8 (or ≥1h wall-clock) and invoke `applyRestartPolicy` on a fresh failed run; assert it returns `human_gate`, writes the `restart_decisions` row + the `approvals`/`issue_execution_decisions` gate, and launches **nothing further** (proves the bounded-restart gate; wiring closed).

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
