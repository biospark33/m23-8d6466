# P0.4: Hard guard kills a loopy prompt before credits exhaust

**Story Points:** 3

## Spec Reference

- PRD §6.4 (Execution — guards); FR-EX-3 ("launcher can enforce hard guards: budget/turn/wall-clock/`tilldone`/`coms_await` timeout — such that a loopy prompt terminates instead of burning unbounded budget")
- Supporting NFRs: NFR-SAF-1 (no team exceeds turn/wall-clock/budget cap), NFR-SAF-3 (`coms_await` carries timeout; no unbounded blocking wait)
- Phase exit gate: PRD §13 Phase-0 clause 3 ("A deliberately loopy prompt hits a hard cap (budget/turn/`tilldone`/`coms_await` timeout) and exits non-zero — credits are not exhausted")

## User Story

As an Operator running lights-out agent teams against paid LLM credits,
I want a deliberately loopy prompt to be killed by a launcher-owned hard guard with a non-zero exit before it can drain the budget,
so that no run can burn credits unbounded and the kill path is demonstrable on a real loopy prompt (G1 safe autonomy).

## Overview

This slice proves the guard PATH that P0.3 wired. It cuts vertically through: a deliberately loopy task prompt → the launcher-owned hard guards (per-team `--budget-cap-cents`, `--turn-cap`, `--wall-clock-cap-ms`, `tilldone` task-gate, `coms_await` timeout) → process kill (the launcher owns spawn/kill of every `pi` subprocess; guards are never delegated, R3 §D.5/R4 §5) → non-zero exit with a logged `exit_class` and the guard that fired. It also calibrates OQ-16b: the demo records the measured p99 `coms_await` turn duration so the per-archetype await-timeout defaults (Solo/Pair 10 min, TDD-Trio 8 min, Quad 6 min) can be tuned downward against real numbers. One atomic 3-pt unit: the only new behavior is a triggerable, observable kill + the calibration capture; the launch/coms substrate is the P0.3 dependency edge.

## E2E Slice

**Demonstrable behavior:** `pi-team-launch.sh --task "<deliberately-looping prompt>" --context-path ./ctx --budget-cap-cents 5 --turn-cap 3 --wall-clock-cap-ms 60000 …` is run; the launcher kills all `pi` subprocesses when the **first** guard threshold is crossed and the process **exits non-zero**; stderr records which guard fired (`budget`|`turn`|`wall_clock`|`tilldone`|`coms_await_timeout`) and `exit_class`; the post-run `cost_events`/`heartbeat_runs.usageJson` total is **at or below** the `--budget-cap-cents` ceiling (credits not exhausted).

**Wiring closed:** On completion of this story, running `pi-team-launch.sh --task "<loopy>" --budget-cap-cents 5 --turn-cap 3 --wall-clock-cap-ms 60000 …` produces a **non-zero exit code** with a stderr line naming the guard that fired and a recorded spend ≤ the budget cap, using only code merged by this story (the guard-enforcement + kill + exit-class + p99-capture logic in the launcher). No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P0.3 (`pi-team-launch.sh` launch + coms + merged-JSON substrate — this story adds the guard-trip + kill + exit-class + OQ-16b calibration on top of that launcher).

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given a deliberately loopy task prompt and tight caps (`--budget-cap-cents 5 --turn-cap 3 --wall-clock-cap-ms 60000`), When `pi-team-launch.sh` is run, Then the launcher **kills every `pi` subprocess and exits non-zero** (`$? != 0`), AND the **total recorded spend is ≤ `--budget-cap-cents`** (read from the emitted `cost_events` sum or the `heartbeat_runs.usageJson` ESTIMATED fallback), AND stderr names the guard that fired — i.e. credits are demonstrably NOT exhausted.
2. Given the team is blocked on a peer that never replies, When a `coms_await` exceeds its timeout (`PI_COMS_TIMEOUT_MS`, per-archetype start e.g. 8 min TDD-Trio), Then the wait **terminates at the timeout** (no unbounded blocking, NFR-SAF-3) and the run exits non-zero with the `coms_await_timeout` guard recorded — not a silent hang.
3. Given the loopy demo completes, When the measured per-agent turn durations are collected, Then the run **records the measured p99 `coms_await` turn duration to stderr/a calibration artifact** (OQ-16b), so the per-archetype timeout defaults can be tuned downward against real data — never left as an unrecorded assumption.

## Technical Notes

- **Contracts/Schema:** No new persisted schema; reuses P0.3's merged-output `exit_class` field (`transient|overflow|logic`) and adds a stderr **kill record** `{ guard: "budget"|"turn"|"wall_clock"|"tilldone"|"coms_await_timeout", firedAtMs, recordedSpendCents, p99AwaitMs }`. Spend read from `cost_events` (`SUM(costCents)`) or `heartbeat_runs.usageJson` (ESTIMATED-flagged fallback, OQ-8 / R3 §D.2).
- **Integration points (each wired & exercised in this story):** (1) launcher-owned `SIGKILL`/`SIGTERM` of all role subprocesses on first guard trip (launcher owns spawn/kill — never delegated, R4 §5); (2) `tilldone` task-gate loop guard (`tilldone.ts` `agent_end` nudge `:365-383`, task-gate `:335-361`) wired as one of the five guards; (3) `coms_await` timeout enforcement (`PI_COMS_TIMEOUT_MS`, `coms.ts:32`); (4) budget accounting tap reading the same per-role cost path the launcher emits, so the cap is checked against real spend mid-run; (5) OQ-16b p99 capture from per-agent turn timing.
- **Files / functions touched:** `scripts/pi-team-launch.sh` (guard loop + kill + exit-class + p99 capture); new `src/launcher/guards.ts` (cap evaluators + kill orchestration); `tests/launcher/guard-loopkill.test.ts`.
- **Guards/limits:** five hard guards — `--budget-cap-cents`, `--turn-cap`, `--wall-clock-cap-ms` (≤ bash node `timeout`, `dag-node.ts:181`), `tilldone` task-gate, `coms_await` timeout. The FIRST to trip wins; the launcher exits non-zero immediately. `--wall-clock-cap-ms` is the backstop guaranteeing termination even if budget/turn accounting lags.

## Files to Modify

- `scripts/pi-team-launch.sh`
- `src/launcher/guards.ts`
- `tests/launcher/guard-loopkill.test.ts`

## Security Invariants

> Trigger: cost/budget. Concrete named invariants only.

- **INV-1 (cost/budget):** No run can exceed its `--budget-cap-cents`; the launcher evaluates accumulated spend mid-run and kills on breach, so a loopy prompt terminates via the guard rather than by exhausting credits (NFR-SAF-1). Recorded spend at exit is ≤ cap.
- **INV-2 (cost/budget — non-delegation):** Guard enforcement and the kill live in the launcher process that owns subprocess spawn; an agent cannot raise, disable, or out-wait its own caps (the cap ceiling is not passed as a mutable in-agent setting).
- **INV-3 (no unbounded wait):** Every `coms_await` carries a finite timeout (NFR-SAF-3); there is no code path where the team blocks indefinitely on a non-replying peer — the `--wall-clock-cap-ms` backstop guarantees termination even if all finer guards are mis-tuned.
- **INV-4 (fail-closed exit):** A tripped guard always yields a **non-zero** exit (never a silent zero-exit continue), so an upstream Archon bash node sees the failure and the restart-classifier can act on it.

## Definition of Done

- [ ] **Impl:** Launcher guard loop evaluates all five caps (budget/turn/wall-clock/`tilldone`/`coms_await` timeout); the first to trip kills every role subprocess.
- [ ] **Impl:** On any guard trip the launcher exits **non-zero** and writes a stderr kill record naming the guard, the firing time, and `exit_class`.
- [ ] **Impl:** Mid-run budget accounting reads accumulated per-role spend and kills on cap breach before the next turn can spend further.
- [ ] **Contract:** stderr kill record `{ guard, firedAtMs, recordedSpendCents, p99AwaitMs }` emitted with all fields populated; spend sourced from `cost_events` SUM or `heartbeat_runs.usageJson` (ESTIMATED-flagged fallback).
- [ ] **Integration:** `tilldone` task-gate and `coms_await` timeout are each wired as live guards (not just budget/turn), exercised by a targeted prompt for each.
- [ ] **Observability:** Measured p99 `coms_await` turn duration recorded to a calibration artifact/stderr for OQ-16b tuning of per-archetype timeout defaults.
- [ ] **Security:** Verified an agent cannot lift its own cap (cap held in launcher process; kill path non-delegated) and a tripped guard never exits zero.
- [ ] **Test (unit/integration):** Each of the five guards independently triggers a kill in isolation (parametrized), and a `coms_await` on a non-replying peer terminates at its timeout rather than hanging.
- [ ] **Test (e2e demo — MANDATORY):** Runs `pi-team-launch.sh` on a real deliberately-loopy prompt with tight caps; asserts non-zero exit, recorded spend ≤ `--budget-cap-cents`, and a named guard in stderr (proves §13 Phase-0 clause 3 — credits not exhausted; wiring closed).

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
