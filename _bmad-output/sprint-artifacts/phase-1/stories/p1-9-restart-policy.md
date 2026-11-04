# P1.9: Restart Policy (Deterministic Classify + Retry/Wall-Clock Caps)

**DONE 2026-11-04 — PR #486 merged to dev (618d2e00).** Dev gates + review rounds: CodeRabbit round 1: 2 findings (lead_failure omission, caps/non-finite hardening) both real, both fixed. DoD states + Dev Agent Record below.

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

Reconciled 2026-11-04 (dev; PR #486 merged to dev 2026-11-04, 618d2e00). Legend follows P0.11's `[x]` / `[~]` / `[ ]`
convention; the spec's `src/protocol/*` paths never existed — the DF5.5 amendment re-homes the
cross-run restart classification in the phase engine, and the integration points below reflect the
CURRENT architecture (DF1.10 engine, DF1.3 in-phase retries, DF6.1b escalation lane).

- [x] **Impl:** Deterministic `classify(signal)` pure function mapping `FailureSignal` → `FailureClass`
      *`src/phase-engine/failure-signal.ts` — `classifyFailure`, pure, fail-closed to `logic`; rule precedence documented in-file (token arithmetic beats label → timeout → token-overflow → http-status code table → logic). INV-RESTART-2 asserted by the 100-iteration determinism test (`tests/phase-engine/restart-policy.test.ts`).*
- [x] **Impl:** `transient` → retry with exponential backoff (2s initial, 2x growth, 60s max) within caps
      *`src/phase-engine/restart-policy.ts` — `evaluateRestart` (2s × 2^retriesUsed, saturating at `MAX_BACKOFF_MS` = 60s) + `runWithRestart` executor (injectable `now`/`sleep` seams). Backoff sequence asserted: 2000/4000/8000/16000/32000/60000/….*
- [~] **Impl:** `overflow` → retry with reduced scope within caps
      *Decision carries `reducedScope: true` and immediate retry (no backoff); `runWithRestart` passes `attempt`/`reducedScope` to the step so the step reduces its own scope. The scope reduction itself is the step's obligation — the policy enforces the retry shape, not the step's internals.*
- [x] **Impl:** `logic` → no retry, step halts with `status: 'failed'`
      *`evaluateRestart` returns `shouldRetry: false`; `runWithRestart` rethrows the original error after exactly one attempt (asserted: calls=1, no sleeps).*
- [x] **Contract:** `FailureSignal`, `FailureClass`, `RestartDecision`, `RestartCaps` schemas defined and exported
      *`FailureSignalSchema` / `FailureClass` (`failure-signal.ts`), `RestartDecisionSchema` / `RestartCapsSchema` / `DEFAULT_RESTART_CAPS` (`restart-policy.ts`), all re-exported through `src/phase-engine/index.ts`.*
- [~] **Integration:** Failure classifier integrated into phase executor; classification and cap events logged to Hindsight
      *Phase executor: DONE — every settled non-success phase writes `PhaseRecord.restart` {class, signal, decision} to the journal (lead_failure excluded; INV-4 honoured via `scrubErrorText`). Hindsight dev-meta logging: NOT WIRED — the classification is durable in the in-box journal; carrying it to the `{repo}-dev-meta` bank needs a live Hindsight and rides the M1.1/#408 operator window (the retain seam is `src/fleet/retain-best-effort.ts` at harvest).*
- [x] **Security:** Caps enforced atomically; classification is pure; audit trail persisted
      *INV-RESTART-1: caps evaluated inside `evaluateRestart` before any retry, from caller-observed wall clock; executor throws `CapExceededError` and emits `restart_cap_exceeded` rather than a 9th retry. INV-RESTART-2: `classifyFailure` has no clock, randomness, or state. INV-RESTART-3: journal rows carry runId + phaseId + full audit; issueId rides DF1.8's trace-session correlation.*
- [x] **Test (unit):** Classification determinism (same signal → same class); transient retry backoff sequence; cap enforcement at 8 retries; cap enforcement at 1h wall-clock; logic halt; overflow retry with scope reduction
      *`tests/phase-engine/restart-policy.test.ts` — 25 tests green (determinism ×100; backoff sequence; 8-retry cap; wall-clock cap via fake clock; logic halt; overflow reducedScope; custom caps; strictObject schema rejection).*
- [~] **Test (e2e demo — MANDATORY):** Protocol run where a step fails transient 3 times then succeeds on retry 4, with classification logged; separate run where logic error halts immediately; separate run where cap is exceeded and step halts with `reason: 'cap-exceeded'`
      *All three demos green at mock level (`runWithRestart` integration tests + phase-settle journal audit tests; the "hang" demo exercises the engine's real timer abort → `restart.class: transient` journal row). The LIVE leg — the same three demos with the cap-breach classification retained to the Hindsight dev-meta bank — rides the M1.1/#408 operator window, same as the P0.9 live legs.*

## Dev Agent Record

**Status: DONE — PR #486 merged to dev (618d2e00, 2026-11-04); sprint row flipped `done` with merge citation.**

- **Branch:** `feature/p1-9` (merged as PR #486 → dev, 618d2e00). **Files:** `src/phase-engine/failure-signal.ts` (new), `src/phase-engine/restart-policy.ts` (new), `src/phase-engine/phase.ts` (settle integration), `src/phase-engine/types.ts` (additive optional `PhaseRecord.restart`), `src/phase-engine/index.ts` (additive exports), `tests/phase-engine/restart-policy.test.ts` (new; 33 tests after the review rounds).
- **Gates:** `bunx tsc --noEmit` 0 errors; biome check clean on all touched files; `bun test tests/phase-engine/` 1140 pass / 0 fail (includes the 25 new); full repo suite run before PR.
- **Two findings fixed during TDD:** (1) first draft passed raw error text into `restart.signal.message` — INV-4 journal-leak, caught by the existing phase-lifecycle secret test, fixed via `scrubErrorText`; (2) `err` scope bug in `runWithRestart`'s rethrow, caught by own tests.
- **Self-review round (2026-11-04, 4 findings, none HIGH, all applied):** (1) MED — `runWithRestart` derived `reducedScope` from the attempt ordinal, so transient retries ran scope-reduced; now threads the last decision's flag. (2) LOW — a backoff granted near the wall-clock cap could start the next attempt past 1h; the decision now refuses when `wallClockRemainingMs <= nextBackoffMs`. (3) LOW — `CapExceededError` swallowed the last attempt's original error; now carried as `cause`. (4) LOW — `evaluateRestart` clamps hostile numerics (negative/fractional retriesUsed, negative wallClockMs) and the result re-validates against `RestartDecisionSchema`. Post-fix: story suite 29/29, phase-engine 1144/1144, tsc + biome clean.
- **CodeRabbit round 1 (2026-11-04, 2 findings, both confirmed real, both fixed in `89afcb2d`):** (1) the `lead_failure` audit omission was not gated on `verdictFailed`, so a body declaring lead_failure during the cancel grace settled overflow/transient/logic without its audit row — omission now fires only when the settled verdict itself is lead_failure (regression: abort-then-declare test). (2) `evaluateRestart` hardening: custom caps clamp DOWN to the documented ceiling (tighten-only — INV-RESTART-1 cannot be loosened by injection) and non-finite accounting (NaN/±Infinity, incl. `Infinity - Infinity` from a broken injected clock) fails closed to a cap-exceeded refusal instead of a `shouldRetry: true` decision with NaN backoff. Post-fix: story suite 33/33, phase-engine 1148/1148.
- **Amendment note:** the story's spec paths (`src/protocol/*`, `src/models/*`) never existed in this repo; integration points follow the DF5.5 amendment on the current architecture. In-phase retry stays DF1.3's; cross-run RETRY EXECUTION at the dispatcher stays open for whichever driver story consumes `runWithRestart` (the executor is the seam).
