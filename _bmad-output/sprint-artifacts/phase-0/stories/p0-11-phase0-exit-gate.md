# P0.11: Phase-0 Exit Gate — single binary gate over all §13 Phase-0 assertions

**Story Points:** 3   <!-- Verification/gate story: aggregates predecessor exit-criteria; no new product code. -->

## Spec Reference

- PRD §13 ("Verification / Acceptance (per-phase exit gates)") — **Phase 0** clause list (assertions 1, 2, 3, 4, 4b, 5, 6, 7, 7b, 8).
- FR-OR-4 (orchestration gate); FR-EX-1..10 (execution surface); FR-MEM-1 (memory round-trip); FR-CP-9..11 (control-plane / plugin install + dashboard).
- This story **is** PRD §13 Phase-0 gate: its Acceptance Criteria transcribe the §13 assertions verbatim; passing this gate is the binary precondition that unblocks Phase 1.

## User Story

As the **Operator**,
I want a single binary Phase-0 exit gate that verifies every §13 Phase-0 assertion is green AND that all six open questions OQ-1..OQ-6 are recorded with a decision,
so that Phase 1 starts only on a fully de-risked, fully-wired foundation (G1: de-risk before scale) and a red assertion provably blocks the next phase.

## Overview

This is a **verification/gate** slice, not a feature slice. It cuts through the audit surface only: it runs a gate harness that re-checks each predecessor story P0.1–P0.10 exit-criterion (the §13 Phase-0 assertions) and reads the OQ decision-log, then emits one aggregated pass/fail result. It writes **no** new product behavior — it consumes the capabilities P0.1–P0.10 already merged and asserts they are simultaneously green. The atomic unit is the gate itself: the §13 clause list + OQ-1..6 decisions reduced to one binary outcome. It is 3pts because it adds a harness + decision-log, not new orchestration.

## E2E Slice

**Demonstrable behavior:** Running the Phase-0 gate harness (`npm run gate:phase0`) executes the full §13 Phase-0 assertion list against the live foundation and reads the OQ decision-log, then prints a single structured JSON verdict to stdout: `{ "phase": 0, "pass": true, "assertions": [ {id, pass, satisfiedBy} … ], "openQuestions": [ {id: "OQ-1"…"OQ-6", decision} … ] }` and exits `0` only when **every** §13 assertion is `pass:true` AND all six OQ-1..OQ-6 carry a non-empty decision. If any assertion is red or any OQ decision is missing, the verdict has `pass:false` and the process exits **non-zero** — Phase 0 is not exited.

**Wiring closed:** On completion of this story, `npm run gate:phase0` produces the aggregated JSON verdict with `pass:true` and exit code `0` (or `pass:false` + non-zero on any red clause / missing OQ decision) using only code merged by this story (gate harness, the ten assertion checks that invoke the predecessor stories' exercised surfaces, and the OQ decision-log reader). No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P0.1, P0.2, P0.3, P0.4, P0.5, P0.6, P0.7, P0.8, P0.9, P0.10. Each predecessor must be done because the gate re-exercises its exit-criterion; the gate adds no behavior of its own.

## Acceptance Criteria

> The Acceptance Criteria below ARE the PRD §13 Phase-0 assertions, transcribed verbatim, each cross-referenced to the predecessor story that satisfies it. The gate passes only if ALL are green.

1. **(make-or-break)** Given P0.1–P0.10 are merged, When `npm run gate:phase0` runs all §13 Phase-0 assertions (AC-2…AC-11 below) and reads the OQ-1..6 decision-log, Then the JSON verdict has `pass:true` and the process exits `0` **iff every §13 Phase-0 assertion passes AND every OQ-1..6 carries a decision**; if any single assertion is red, the verdict is `pass:false`, exit is non-zero, **and Phase 0 is not exited**. (binary: exit code `0` vs non-zero.)

2. **[§13.1 — sat. P0.2]** Given the launcher, When `pi-team-launch.sh "refactor X" ./ctx` runs, Then it returns a single merged JSON object on stdout.

3. **[§13.2 — sat. P0.3]** Given a launched team run, When the run logs are inspected, Then they show ≥2 named agents exchanging ≥2 coms (or subprocess-RPC) messages.

4. **[§13.3 — sat. P0.4]** Given a deliberately loopy prompt, When it is launched, Then it hits a hard cap (budget/turn/tilldone/`coms_await` timeout) and exits non-zero — credits are not exhausted.

5. **[§13.4 — sat. P0.5]** Given pi-lens running headless, When a turn ends, Then it EITHER emits a turn-end report with TDI + stable finding IDs, OR the logged warning-count proxy fallback is recorded with the §9.3 fallback flag set.

6. **[§13.4b — sat. P0.6]** Given the target language, When `lsp_diagnostics` runs on a seeded type error and `lsp_navigation` resolves a definition, Then an active LSP is proven (or the TUI-only limitation is recorded under OQ-2 with a fallback).

7. **[§13.5 — sat. P0.1]** Given a trivial Archon bash node with a per-node `env` var, When it runs, Then the subprocess echoes that env value into node output (env patch proven, not schema-only) **AND a bash node with no `env` field still echoes an inherited parent-env value (merge, not assignment — no regression; CORRECTNESS-A)**.

8. **[§13.6 — sat. P0.7]** Given the Paperclip dashboard, When it is reached, Then it is reachable with the Telegram and Hindsight plugins both listed as installed.

9. **[§13.7 — sat. P0.9]** Given the chosen Hindsight bank (cloud or self-host), When a retain→recall→reflect sequence runs, Then it round-trips on that bank.

10. **[§13.7b — sat. P0.10]** Given the target repo, When the initial `gitnexus analyze` runs, Then it completes to a **non-error state** and `gitnexus_context`/`gitnexus_impact` return real graph data (required before any Phase-1 story executes — cold-start sequencing, FR-EX-9/FR-MEM-6).

11. **[§13.8 — sat. P0.8 + this gate]** Given the OQ decision-log, When the gate reads it, Then **all six open questions OQ-1..OQ-6 are answered with a decision recorded** (including any fallback taken); a missing/empty decision for any OQ makes the gate `pass:false`.

## Technical Notes

- **Contracts/Schema:** `phase0GateVerdictSchema` (Zod) — `{ phase: 0, pass: boolean, assertions: Array<{ id: string /* "§13.1"… */, pass: boolean, satisfiedBy: string /* "P0.2" */, detail?: string }>, openQuestions: Array<{ id: "OQ-1"|"OQ-2"|"OQ-3"|"OQ-4"|"OQ-5"|"OQ-6", decision: string /* non-empty */, fallback?: string }> }`. The OQ decision-log is a checked-in JSON/MD artifact (`phase-0/oq-decision-log.json`) keyed by OQ id; the reader validates each id present with a non-empty `decision`. Backward-compat: additive only — no predecessor schema is mutated.
- **Integration points (each exercised in this story):** each assertion check **invokes the predecessor's already-wired surface** — `pi-team-launch.sh` (P0.2), coms/RPC log scan (P0.3), loopy-prompt cap (P0.4), pi-lens headless artifact / §9.3 fallback flag (P0.5), `lsp_diagnostics`/`lsp_navigation` (P0.6), Archon env-probe workflow (P0.1), Paperclip plugin-install/dashboard `GET` (P0.7), Hindsight retain/recall/reflect (P0.9), `gitnexus analyze`/`gitnexus_context`/`gitnexus_impact` (P0.10), OQ decision-log read (P0.8 + this gate). The gate **aggregates**; it does not re-implement any check.
- **Files / functions touched:** `gate:phase0` harness `runPhase0Gate()`, per-assertion check functions, `readOqDecisionLog()`, verdict serializer.
- **Guards/limits:** the gate is **fail-closed** — any check that errors, times out, or returns ambiguous output is scored `pass:false` (never silently skipped). A missing OQ decision is a hard fail. Exit code is `0` only on full green.

## Files to Modify

- `scripts/gate-phase0.ts`
- `src/gates/phase0/assertions.ts`
- `src/gates/phase0/oq-decision-log.ts`
- `src/gates/phase0/verdict.schema.ts`
- `_bmad-output/sprint-artifacts/phase-0/oq-decision-log.json`
- `package.json`
- `tests/gates/phase0-gate.test.ts`

## Definition of Done

- [ ] **Impl:** `runPhase0Gate()` executes all ten §13 Phase-0 assertion checks (AC-2…AC-11), each cross-referenced to its satisfying predecessor (P0.1–P0.10) via the `satisfiedBy` field.
- [ ] **Impl:** Gate is **fail-closed** — any errored/timed-out/ambiguous check scores `pass:false`; exit code is `0` only when every assertion is green AND all OQ-1..6 decisions are present.
- [ ] **Impl:** `readOqDecisionLog()` loads `oq-decision-log.json` and validates OQ-1..OQ-6 each carry a non-empty `decision` (fallback noted where taken).
- [ ] **Contract:** `phase0GateVerdictSchema` (Zod) added with field-level validation for `assertions[]` and `openQuestions[]`; verdict output validated before emit.
- [ ] **Integration:** Each assertion check invokes its predecessor's already-wired surface (launcher, coms logs, loopy cap, pi-lens, LSP, Archon env-probe, Paperclip plugins, Hindsight round-trip, gitnexus) and asserts the §13 observable — proving wiring across P0.1–P0.10 is closed and simultaneous.
- [ ] **Observability:** The aggregated JSON verdict (per-assertion `{id, pass, satisfiedBy, detail}` + per-OQ `{id, decision}`) is emitted to stdout so a red clause names exactly which §13 assertion / OQ blocks Phase 0.
- [ ] **Audit:** OQ-1..OQ-6 decisions are recorded in the checked-in decision-log with any fallback taken (satisfies §13.8).
- [ ] **Test (unit):** Each assertion-check returns `pass:false` on a simulated red predecessor surface (one negative case per check) and `pass:true` on the green surface.
- [ ] **Test (guard):** A single red assertion OR one missing OQ decision yields `pass:false` and non-zero exit (gate cannot pass on partial green).
- [ ] **Test (e2e demo — MANDATORY):** `npm run gate:phase0` against the live P0.1–P0.10 foundation prints `pass:true` with all ten assertions green and OQ-1..6 decided, exits `0`; flipping any one assertion red flips the verdict to `pass:false` + non-zero exit ("all §13 Phase-0 assertions pass; if any is red, Phase 0 is not exited").

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
