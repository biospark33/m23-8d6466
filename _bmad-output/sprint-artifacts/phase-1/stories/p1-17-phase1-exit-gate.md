# P1.17: Phase-1 E2E Make-or-Break Gate

**Story Points:** 3

## Spec Reference

- PRD §13; FR-MG-1..9, FR-OR-1..7

## User Story

As a QDS platform stakeholder,
I want a binary gate that validates all Phase 1 capabilities are operational end-to-end,
so that the team can confidently proceed to Phase 2 knowing the foundation is solid.

## Overview

This story implements the Phase 1 exit gate as defined in PRD §13. It runs all Phase 1 assertions end-to-end: (1) one real PR produced (P1.15), (2) reconstructable audit chain (P1.16), (3) within-budget spend (P1.13), (4) working approve/resume policy (P1.10), (5) retained findings in Hindsight (P1.11), (6) outcome record per run (P1.14). The gate produces a binary pass/fail result with a detailed assertion report. All green = gate passes. Any red = gate fails with specific failure reasons. This is the checkpoint that determines Phase 2 readiness.

## E2E Slice

**Demonstrable behavior:** Running the Phase 1 gate script executes all 6 assertion groups against the live system. Each assertion returns green (pass) or red (fail with reason). The final output is a binary gate result: PASS or FAIL with a per-assertion breakdown.

**Wiring closed:** On completion of this story, the gate script validates all Phase 1 capabilities and produces a binary pass/fail using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors (P1.10, P1.14, P1.16) are dependency edges, not unfinished wiring inside this story.

**Dependency edges (predecessors):** P1.10, P1.14, P1.16

## Acceptance Criteria

1. **(make-or-break)** Given all P1.10, P1.13, P1.14, P1.15, P1.16 predecessors are complete, When the gate script runs, Then all 6 assertion groups pass and the gate returns PASS.
2. Given any predecessor assertion fails (e.g., audit chain has a broken hop), When the gate script runs, Then the gate returns FAIL with the specific assertion ID, expected result, actual result, and diagnostic message.
3. Given the gate script is run multiple times, When the system state has not changed, Then the gate produces identical results (deterministic, no flakiness).

## Technical Notes

- **Contracts/Schema:** Gate assertion groups: (G1) Real PR exists: PR URL resolvable, branch contains changes, PR is open/mergeable. (G2) Audit chain reconstructable: invoke P1.16 walker, all 8 hops resolve. (G3) Within-budget spend: query cost ledger, total <= budget cap for Phase 1. (G4) Approve/resume evidence: verify recorded pause/approve/resume events exist in Hindsight or `{repo}-dev-meta` from prior runs (non-mutating read-only check — the gate never simulates policy actions against live state). (G5) Retained findings: query Hindsight `{repo}` bank, confirm ≥1 finding document exists from P1.11 (aligned with P1.11 DoD which retains learnings to `{repo}` bank). (G6) Outcome record: query Hindsight `{repo}-dev-meta` for runId, confirm FR-LEARN-28 fields populated.
- **Integration points:** Gate script invokes: SwarmClaw API (dispatch, status), GitHub API (PR verification), Hindsight API (bank queries), cost ledger (spend query), audit walker (P1.16).
- **Files / functions touched:** `scripts/phase1-gate.ts` (gate runner), `src/gate/assertions.ts` (individual assertion implementations), `src/gate/report.ts` (result formatting).
- **Guards/limits:** Gate must complete in under 5 minutes total. Each assertion has a 60-second timeout. Gate result is deterministic — same state produces same result. No mutation of system state during gate run (read-only assertions).

## Files to Modify

- `scripts/phase1-gate.ts`
- `src/gate/assertions.ts`
- `src/gate/report.ts`

## Security Invariants

- INV-1: Gate script runs with read-only access — it inspects state but never mutates protocol state, creates PRs, or writes to banks.
- INV-2: Gate report does not expose secrets, tokens, or PII in assertion diagnostics.
- INV-3: Cost assertion reports total spend against budget — never individual token costs that could leak pricing details.

## Definition of Done

- [ ] **Impl:** Gate runner script that executes all 6 assertion groups in sequence.
- [ ] **Impl:** Individual assertion implementations for G1 (real PR), G2 (audit chain), G3 (budget), G4 (approve/resume — read-only verification against recorded events), G5 (retained findings), G6 (outcome record).
- [ ] **Impl:** Binary pass/fail report with per-assertion breakdown (ID, status, expected, actual, diagnostic).
- [ ] **Impl:** Deterministic execution — same state produces identical results on repeated runs.
- [ ] **Contract:** Gate assertion schema: `{ id: string, group: string, status: "PASS"|"FAIL", expected: string, actual: string, diagnostic?: string }`.
- [ ] **Integration:** Gate queries SwarmClaw API, GitHub API, Hindsight API, cost ledger, audit walker.
- [ ] **Security:** Gate is read-only — no mutations during execution.
- [ ] **Test (unit):** Each assertion returns correct pass/fail given known mock state.
- [ ] **Test (e2e demo — MANDATORY):** Run gate against live system with all predecessors complete; gate returns PASS with all 6 groups green.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
