# P1.9: Restart Policy (Deterministic Classify + Retry/Wall-Clock Caps)

**Story Points:** 3

## Spec Reference

- PRD §3.2, §5.1; FR-MG-8, FR-MG-9, NFR-SAF-2, NFR-REL-2

## User Story

As a dev manager,
I want failed protocol steps to be classified deterministically and restarted within enforced caps,
so that transient failures self-heal, overflow is caught early, and logic errors do not loop infinitely.

## Overview

When a Pi agent step or protocol phase fails during a run, SwarmClaw classifies the failure signal into one of three categories: `transient` (network blip, rate limit, temporary resource unavailability), `overflow` (token limit exceeded, context window overflow), or `logic` (assertion failure, wrong output schema, unhandled exception). Each classification maps to a restart policy: `transient` → retry with exponential backoff, `overflow` → retry with reduced scope, `logic` → no retry (halt). All restarts are bounded by caps: maximum 8 retries per step, maximum 1 hour wall-clock per step. Classification is deterministic — the same failure signal always produces the same classification.

## E2E Slice

**Demonstrable behavior:** A Pi agent step fails with a timeout error. SwarmClaw classifies it as `transient`, applies retry with exponential backoff within the 8-retry / 1h wall-clock caps, and logs the classification. If the same step fails with an assertion error, classification is `logic`, no retry, step halts. Classification is identical given the same failure signal on repeated runs.

**Wiring closed:** On completion of this story, failure classification is deterministic given a failure signal, and restart decisions are enforced within caps using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** DF1.6 (was P1.6, per sprint-status), DF1.8 (was P1.8, per this file). <!-- v5 amendment (DF5.5) -->

> **v5 amendment (DF5.5):** P1.9 owns **cross-run** restart classification — its own three-value
> `FailureClass` (`transient | overflow | logic`, `p1-9:36`), which is the *failure subset* of the
> CC-1 five-value `exitStatus` enum (`success | transient | overflow | logic | lead_failure`,
> `p0-3-mixed-model-demo.md:126`); the classification input is a `FailureSignal`, not an
> `exitStatus` literal, and this amendment changes neither. **In-phase** retry — JSON-parse and
> gate-violation retries re-entering the same agent session — is **DF1.3's**, separately bounded.
> In-box process supervision is neither: DF2.10 ships `qds-run@.service` with **`Restart=no`**
> (`df2-10:106,173`) and DF1.10 owns reclaim semantics (`df1-10:91,143`), so a crashed in-box
> engine is **not** restarted by systemd and is not P1.9's cross-run classification either.
> <!-- v5 amendment (DF5.5) -->

## Acceptance Criteria

1. **(make-or-break)** Given a failure signal (timeout, token overflow, or logic error), When SwarmClaw classifies the failure, Then the classification is `transient`, `overflow`, or `logic` and is deterministic — the same failure signal always produces the same classification.
2. Given a `transient` classification, When the restart policy evaluates, Then the step is retried with exponential backoff (initial 2s, max 60s) and the retry count and wall-clock time are tracked against caps (≤8 retries, ≤1h).
3. Given a `logic` classification, When the restart policy evaluates, Then no retry is attempted, the step halts with `status: 'failed'`, and the failure reason is logged.
4. Given the retry cap (8 retries or 1h wall-clock) is reached, When the next retry would exceed the cap, Then the step halts with `status: 'failed'`, `reason: 'cap-exceeded'`, and the cap breach is logged as a structured event.

## Technical Notes

- **Contracts/Schema:** `FailureSignal { type: string, message: string, code?: number, tokensUsed?: number, maxTokens?: number, duration?: number }`. `FailureClass = 'transient' | 'overflow' | 'logic'`. `RestartDecision { class: FailureClass, shouldRetry: boolean, nextBackoffMs?: number, retriesRemaining: number, wallClockRemainingMs: number }`. `RestartCaps { maxRetries: 8, maxWallClockMs: 3600000 }`.
- **Integration points:** SwarmClaw protocol phase executor (receives failure signals); Pi agent step runner (emits failure signals); Hindsight `{repo}-dev-meta` bank (logs classification and cap breaches).
- **Files / functions touched:** `src/protocol/failure-classifier.ts` (deterministic classification), `src/protocol/restart-policy.ts` (restart decision + caps), `src/protocol/phase-executor.ts` (failure handling integration), `src/models/failure-signal.ts` (schemas).
- **Guards/limits:** Classification function is pure — no side effects, no external calls. Backoff: 2s initial, 2x growth, 60s max. Caps enforced atomically before each retry attempt.

## Files to Modify

- `src/protocol/failure-classifier.ts`
- `src/protocol/restart-policy.ts`
- `src/protocol/phase-executor.ts`
- `src/models/failure-signal.ts`

## Security Invariants

- INV-RESTART-1: No step may exceed 8 retries or 1 hour wall-clock — caps are enforced atomically and cannot be bypassed.
- INV-RESTART-2: Classification is deterministic — `classify(signal)` is a pure function with no randomness, no external state, and no time dependency.
- INV-RESTART-3: All classification decisions, retry attempts, and cap breaches are logged to audit trail with `runId`, `stepId`, `issueId`, and full `FailureSignal`.

## Definition of Done

- [ ] **Impl:** Deterministic `classify(signal)` pure function mapping `FailureSignal` → `FailureClass`
- [ ] **Impl:** `transient` → retry with exponential backoff (2s initial, 2x growth, 60s max) within caps
- [ ] **Impl:** `overflow` → retry with reduced scope within caps
- [ ] **Impl:** `logic` → no retry, step halts with `status: 'failed'`
- [ ] **Contract:** `FailureSignal`, `FailureClass`, `RestartDecision`, `RestartCaps` schemas defined and exported
- [ ] **Integration:** Failure classifier integrated into phase executor; classification and cap events logged to Hindsight
- [ ] **Security:** Caps enforced atomically; classification is pure; audit trail persisted
- [ ] **Test (unit):** Classification determinism (same signal → same class); transient retry backoff sequence; cap enforcement at 8 retries; cap enforcement at 1h wall-clock; logic halt; overflow retry with scope reduction
- [ ] **Test (e2e demo — MANDATORY):** Protocol run where a step fails transient 3 times then succeeds on retry 4, with classification logged; separate run where logic error halts immediately; separate run where cap is exceeded and step halts with `reason: 'cap-exceeded'`
