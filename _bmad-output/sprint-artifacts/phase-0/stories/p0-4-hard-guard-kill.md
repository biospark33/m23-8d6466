# P0.4: Hard-Guard Loopy-Prompt Kill + coms_await Timeout Calibration

**Story Points:** 3

## Spec Reference

- PRD §4.6 (hard guards), §9.3 (fallback pattern); FR-EX-3
- Phase exit gate: PRD §13 Phase-0 clause 4 (loopy prompt terminates via guard)
- NFR-SAF-1, NFR-SAF-3

## User Story

As a SwarmClaw protocol operator,
I want the CLI-Anything harness to enforce hard guards (budget, turn, wall-clock, coms_await timeout) that terminate loopy prompts before credits exhaust,
so that no Pi team exceeds configured caps (FR-EX-3, NFR-SAF-1, G1).

## Overview

Adds guard enforcement to the CLI-Anything harness from P0.1/P0.3. The harness process owns spawn/kill of all Pi subprocesses; budget/turn/wall-clock caps live here, never delegated to agents. Calibrates `coms_await` timeouts per archetype (Solo/Pair 10 min, TDD-Trio 8 min, Quad 6 min — OQ-16b defaults). Cuts CLI-Anything runner layer only. 3 pts because it is a single concern (guard enforcement) with well-defined integration seams.

## E2E Slice

**Demonstrable behavior:** A CLI-Anything harness invocation with `budget_cap_cents: 10`, `turn_cap: 2`, and `wall_clock_cap_ms: 30000` runs an agent that loops (never completes). The harness kills the subprocess before any cap is exceeded and produces a non-zero exit with `exit_class: "overflow"` or `"transient"` and a logged termination reason.

**Wiring closed:** On completion of this story, running the guard-test manifest (loopy agent, tight caps) produces a non-zero exit code, `exit_class` in {`transient`, `overflow`}, and a termination reason — using only code merged by this story plus P0.1 harness skeleton. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P0.3 (3-agent merged-JSON demo — guards attach to the same runner).

## Acceptance Criteria

1. **(make-or-break)** Given a loopy-agent manifest with `turn_cap: 2` and `wall_clock_cap_ms: 30000`, When `cli-anything run --manifest loopy.yaml` executes, Then the harness exits with non-zero code within 35 seconds and `exit_class` ∈ {`transient`, `overflow`} (guard fires, not credit exhaustion).
2. Given a manifest with `budget_cap_cents: 10`, When the team's cumulative token cost exceeds 10 cents, Then the harness kills all subprocesses and logs `termination_reason: "budget_cap"`.
3. Given the coms_await timeout defaults (Solo/Pair 10m, Trio 8m, Quad 6m), When a `coms_await` call exceeds its timeout, Then the harness terminates the await and logs the timeout event (NFR-SAF-3 — no unbounded wait).

## Technical Notes

- **Contracts/Schema:** Manifest guard fields: `budget_cap_cents` (optional int, default 100), `turn_cap` (optional int, default 10), `wall_clock_cap_ms` (optional int, default 600000), `coms_await_timeout_ms` (optional int, defaults per archetype). `exit_class` enum: `success | transient | overflow | logic`. Termination reason logged in merged output.
- **Integration points (each wired & exercised in this story):** Harness spawn loop tracks per-agent turn count + cumulative cost estimate; wall-clock timer starts at harness invocation; `coms_await` timeout passed to coms layer; kill signal (`SIGTERM` then `SIGKILL` after 5s grace) sent to all subprocesses on guard breach.
- **Files / functions touched:** `cli-anything/src/guards.ts` (new — guard enforcement), `cli-anything/src/runner.ts` (guard integration), `cli-anything/src/types.ts` (guard config types).
- **Guards/limits:** `wall_clock_cap_ms` must be ≤ SwarmClaw protocol step timeout (caller's responsibility to align). Budget cap checked via token-count estimate (not real-time billing — OQ-8 cost attribution uses post-hoc reconciliation; harness uses conservative per-model token cost table).

## Files to Modify

- `cli-anything/src/guards.ts`
- `cli-anything/src/runner.ts`
- `cli-anything/src/types.ts`
- `cli-anything/test/guards.test.ts`
- `cli-anything/test/fixtures/loopy.yaml`
- `cli-anything/manifests/guard-test.yaml`

## Security Invariants

- **INV-1:** Loopy-prompt path terminates via budget/turn/wall-clock guard with non-zero exit; credits are not exhausted. Guard enforcement lives in the harness process (owns spawn/kill), never delegated to agents.
- **INV-2:** Budget cap uses conservative token-cost estimates (overestimates) to ensure actual spend never exceeds the cap — underestimate would violate NFR-SAF-1.
- **INV-3:** Kill sequence: SIGTERM first, then SIGKILL after 5s grace period. No zombie processes left.

## Definition of Done

- [ ] **Impl:** Guard enforcement module tracks turn count, wall-clock, and budget estimate; triggers kill on any cap breach.
- [ ] **Impl:** `coms_await` timeout calibrated per archetype (Solo/Pair 10m, Trio 8m, Quad 6m) — configurable via manifest.
- [ ] **Contract:** Manifest guard config types (budget_cap_cents, turn_cap, wall_clock_cap_ms, coms_await_timeout_ms) with sensible defaults.
- [ ] **Integration:** Kill signal chain (SIGTERM → 5s grace → SIGKILL) wired to all spawned Pi subprocesses on guard breach.
- [ ] **Observability:** Termination reason (budget_cap / turn_cap / wall_clock / coms_timeout) logged in merged output `termination_reason` field.
- [ ] **Security:** Guard fires on loopy prompt within cap bounds; non-zero exit code; no credit exhaustion.
- [ ] **Test (unit):** Guard module fires correctly for each cap type (budget, turn, wall-clock, coms_timeout); kill sequence completes.
- [ ] **Test (e2e demo — MANDATORY):** Loopy-agent manifest with tight caps produces non-zero exit, correct `exit_class`, and termination reason within expected time bounds.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
