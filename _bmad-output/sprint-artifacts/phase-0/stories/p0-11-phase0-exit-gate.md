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

This is a **verification/gate** slice, not a feature slice. It cuts through the audit surface only: it runs a gate harness that re-checks each living predecessor story P0.3, P0.5, P0.6, P0.7, P0.9, P0.10 exit-criterion (the §13 Phase-0 assertions) and reads the OQ decision-log, then emits one aggregated pass/fail result. It writes **no** new product behavior — it consumes the capabilities P0.3, P0.5, P0.6, P0.7, P0.9, P0.10 already merged and asserts they are simultaneously green. (P0.1, P0.4, P0.8 killed per Warren decision; their §13 clauses are either absorbed by living stories or removed below.) The atomic unit is the gate itself: the §13 clause list + OQ-1..6 decisions reduced to one binary outcome. It is 3pts because it adds a harness + decision-log, not new orchestration.

## E2E Slice

**Demonstrable behavior:** Running the Phase-0 gate harness (`npm run gate:phase0`) executes the full §13 Phase-0 assertion list against the live foundation and reads the OQ decision-log, then prints a single structured JSON verdict to stdout: `{ "phase": 0, "pass": true, "assertions": [ {id, pass, satisfiedBy} … ], "openQuestions": [ {id: "OQ-1"…"OQ-6", decision} … ] }` and exits `0` only when **every** §13 assertion is `pass:true` AND all six OQ-1..OQ-6 carry a non-empty decision. If any assertion is red or any OQ decision is missing, the verdict has `pass:false` and the process exits **non-zero** — Phase 0 is not exited.

**Wiring closed:** On completion of this story, `npm run gate:phase0` produces the aggregated JSON verdict with `pass:true` and exit code `0` (or `pass:false` + non-zero on any red clause / missing OQ decision) using only code merged by this story (gate harness, the eleven assertion checks (AC-2…AC-11, with AC-7 split into AC-7 + AC-7b) that invoke the predecessor stories' exercised surfaces, and the OQ decision-log reader). No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P0.3, P0.5, P0.6, P0.7, P0.9, P0.10. Each predecessor must be done because the gate re-exercises its exit-criterion; the gate adds no behavior of its own. P0.1, P0.4, P0.8 killed per Warren decision; their §13 clauses are either absorbed by living stories or removed below.

## Acceptance Criteria

> The Acceptance Criteria below ARE the PRD §13 Phase-0 assertions, transcribed verbatim, each cross-referenced to the predecessor story that satisfies it. The gate passes only if ALL are green.

1. **(make-or-break)** Given living predecessors (P0.2, P0.3, P0.5, P0.6, P0.7, P0.9, P0.10) are merged, When `npm run gate:phase0` runs all §13 Phase-0 assertions (AC-2…AC-11 below, with AC-7 split into AC-7 + AC-7b for §13.5's two conjuncts) and reads the OQ-1..6 decision-log, Then the JSON verdict has `pass:true` and the process exits `0` **iff every §13 Phase-0 assertion passes AND every OQ-1..6 carries a decision**; if any single assertion is red, the verdict is `pass:false`, exit is non-zero, **and Phase 0 is not exited**. (binary: exit code `0` vs non-zero.)

2. **[§13.1 — sat. P0.3]** Given the launcher, When `pi-team-launch.sh "refactor X" ./ctx` runs, Then it returns a single aggregated JSON object on stdout (single-binary-output property of the launcher authored in P0.3; §13.2 separately tests multi-agent communication).

3. **[§13.2 — sat. P0.3]** Given a launched team run, When the run logs are inspected, Then they show ≥2 named agents exchanging ≥2 coms (or subprocess-RPC) messages.

4. **[§13.3 — sat. P0.3]** Given a deliberately loopy prompt, When it is launched under `pi-team-launch.sh` with budget/turn/wall-clock caps, Then it hits a hard cap and exits non-zero — credits are not exhausted.

5. **[§13.4 — sat. P0.5]** Given pi-lens running headless, When a turn ends, Then it EITHER emits a turn-end report with TDI + stable finding IDs, OR the logged warning-count proxy fallback is recorded with the §9.3 fallback flag set. The gate records which branch fired in the `detail` field of the assertion result. Both branches score `pass:true`. If the fallback fires, `detail` notes the §9.3 fallback flag and the gate cross-references AC-6, which records the TUI-only limitation under OQ-2 (owned by P0.6).

6. **[§13.4b — sat. P0.6]** Given the target language, When `lsp_diagnostics` runs on a seeded type error and `lsp_navigation` resolves a definition, Then an active LSP is proven (or the TUI-only limitation is recorded under OQ-2 with a fallback).

7. **[§13.5 — sat. P0.3]** Given the launcher running a multi-role team, When per-role flags (model, budget) are passed as CLI args, Then the subprocess receives per-role environment variables (CORRECTNESS-A). (Dedicated Archon env-patch story P0.1 killed per Warren decision; env passthrough is self-contained in P0.3's launcher.)

7b. **[§13.5 (non-regression) — sat. P0.3]** Given a separate node with no per-role flags, When it is launched, Then it still inherits parent environment variables (merge, not assignment — CORRECTNESS-A).

8. **[§13.6 — sat. P0.7]** Given the Paperclip dashboard, When it is reached, Then it is reachable with the Telegram and Hindsight plugins both listed as installed.

9. **[§13.7 — sat. P0.9]** Given the chosen Hindsight bank (cloud or self-host), When a retain→recall→reflect sequence runs, Then it round-trips on that bank.

10. **[§13.7b — sat. P0.10]** Given the target repo, When the initial `gitnexus analyze` runs, Then it completes to a **non-error state** and `gitnexus_context`/`gitnexus_impact` return real graph data (required before any Phase-1 story executes — cold-start sequencing, FR-EX-9/FR-MEM-6).

11. **[§13.8 — sat. this gate]** Given the OQ decision-log, When the gate reads it, Then **all six open questions OQ-1..OQ-6 are answered with a decision recorded** (including any fallback taken); a missing/empty decision for any OQ makes the gate `pass:false`. This gate self-assembles the log from the decisions recorded by P0.2, P0.9, and other living stories.

## Technical Notes

- **PRD §13 clause-to-AC mapping (verified 1:1, 10 clauses → 11 sub-ACs (§13.5 split into AC-7 + AC-7b) + make-or-break wrapper):**

  | PRD §13 clause | AC  | satisfiedBy story | Gate assertion id | Summary |
  |----------------|-----|-------------------|-------------------|---------|
  | §13.1          | AC-2 | P0.3              | `"§13.1"`        | Launcher stdout returns single aggregated JSON |
  | §13.2          | AC-3 | P0.3              | `"§13.2"`        | ≥2 agents exchanging ≥2 coms messages |
  | §13.3          | AC-4 | P0.3              | `"§13.3"`        | Loopy-kill caps wired, hard cap exits non-zero |
  | §13.4          | AC-5 | P0.5              | `"§13.4"`        | pi-lens TDI + stable finding IDs (or fallback) |
  | §13.4b         | AC-6 | P0.6              | `"§13.4b"`       | LSP diagnostics + navigation proven |
  | §13.5          | AC-7  | P0.3              | `"§13.5a"`       | Per-role env vars received by subprocess |
  | §13.5 (non-regression)  | AC-7b | P0.3              | `"§13.5b"`       | No-env node inherits parent env (merge, not assignment) |
  | §13.6          | AC-8 | P0.7              | `"§13.6"`        | Paperclip dashboard reachable, plugins installed |
  | §13.7          | AC-9 | P0.9              | `"§13.7"`        | Hindsight retain→recall→reflect round-trip |
  | §13.7b         | AC-10 | P0.10             | `"§13.7b"`       | gitnexus cold-start completes to non-error state |
  | §13.8          | AC-11 | this gate (P0.11) | `"§13.8"`       | OQ-1..6 all answered with non-empty decision |

  AC-1 is the make-or-break wrapper: it aggregates AC-2..AC-11 (with AC-7 split into AC-7 + AC-7b for §13.5's two conjuncts) into one binary pass/fail verdict. No extra ACs exist; no §13 clauses are missing.

- **Contracts/Schema:** `phase0GateVerdictSchema` (Zod) — `{ phase: 0, pass: boolean, assertions: Array<{ id: string /* "§13.1"… */, pass: boolean, satisfiedBy: string /* "P0.2" */, detail?: string /* max 500 chars */ }>, openQuestions: Array<{ id: "OQ-1"|"OQ-2"|"OQ-3"|"OQ-4"|"OQ-5"|"OQ-6", decision: string /* non-empty */, fallback?: string }> }`. The `detail` field is capped at 500 characters to prevent unbounded log output in the verdict JSON. The OQ decision-log is a checked-in JSON/MD artifact (`_bmad-output/sprint-artifacts/phase-0/oq-decision-log.json`) stored as an array of exactly six entries, one per OQ id (OQ-1 through OQ-6); the reader validates each entry has a non-empty `decision` field. Backward-compat: additive only — no predecessor schema is mutated.
- **Integration points (each exercised in this story):** each assertion check **invokes the predecessor's already-wired surface** — `pi-team-launch.sh` (P0.3), coms/RPC log scan (P0.3), budget/turn caps wired in P0.3, pi-lens headless artifact / §9.3 fallback flag (P0.5), `lsp_diagnostics`/`lsp_navigation` (P0.6), env-passthrough via launcher (P0.3), Paperclip plugin-install/dashboard `GET` (P0.7), Hindsight retain/recall/reflect (P0.9), `gitnexus analyze`/`gitnexus_context`/`gitnexus_impact` (P0.10), OQ decision-log read (self-assembled by this gate). The gate **aggregates**; it does not re-implement any check.
- **Files / functions touched:** `gate:phase0` harness `runPhase0Gate()`, per-assertion check functions, `readOqDecisionLog()` (self-assembles OQ log from decisions recorded by P0.2, P0.9, and other living stories), verdict serializer.
- **Guards/limits:** the gate is **fail-closed** — any check that errors, times out, or returns ambiguous output is scored `pass:false` (never silently skipped). A missing OQ decision is a hard fail. Exit code is `0` only on full green. **Per-assertion timeout: 30s (60s for gitnexus analyze). Overall gate wall-clock budget: 5 minutes.** Any check exceeding its timeout is scored `pass:false` with `detail` noting the timeout. **Partial-pass reporting:** when one or more assertions fail, the verdict still contains results for *all* assertions — green ones report `pass:true` with their `satisfiedBy` reference, red ones report `pass:false` with a `detail` explaining the failure. The operator can see exactly which subset passed and which failed without re-running the gate. The top-level `pass` remains `false` until every assertion is green.
- **OQ decision-log validation:** The gate harness validates `oq-decision-log.json` structure before passing AC-11. **File ownership:** `oq-decision-log.json` is created and populated by this story (P0.11). Individual OQ decisions are *authored* by their owning stories during development (e.g., P0.2 owns OQ-1/OQ-5, P0.9 owns OQ-4/OQ-6, P0.6 owns OQ-2, **P0.11 owns OQ-3** — originally P0.8's responsibility but P0.8 was killed per Warren decision; P0.11 records OQ-3 as a deferral decision: "Telegram verify deferred per Warren decision; no standalone verify story, Telegram integration validated inline by P1.10/P1.15 when implemented"), but P0.11 is solely responsible for assembling them into the canonical log file and validating completeness. No other story writes to `oq-decision-log.json`. Validation rules: (1) file exists and parses as JSON; (2) the file is an array of exactly 6 entries, one per OQ id (OQ-1 through OQ-6), with no duplicate ids; (3) each entry has a non-empty `decision` string field (whitespace-only fails); (4) optional `fallback` field, if present, must be non-empty string. A validation failure logs the specific missing/malformed key and scores AC-11 as `pass:false`.
	- **OQ decision-log entry schema:** Each entry in `oq-decision-log.json` conforms to this structure (Zod-style): `{ id: "OQ-1" | "OQ-2" | "OQ-3" | "OQ-4" | "OQ-5" | "OQ-6", decision: string (non-empty), fallback?: string }`. The file is an array of exactly 6 such entries, one per OQ id. The gate's `readOqDecisionLog()` function validates against this schema before evaluating AC-11.
	- **AC-6 / AC-11 cross-link:** If AC-6 fires the fallback branch (TUI-only limitation), the gate validates that OQ-2's recorded decision is consistent with the TUI-only state. This ensures the OQ decision-log reflects the actual runtime condition observed by the gate.

## Files to Modify

- `scripts/gate-phase0.ts`
- `src/gates/phase0/assertions.ts`
- `src/gates/phase0/oq-decision-log.ts`
- `src/gates/phase0/verdict.schema.ts`
- `_bmad-output/sprint-artifacts/phase-0/oq-decision-log.json`
- `package.json`
- `tests/gates/phase0-gate.test.ts`

## Definition of Done

- [ ] **Impl:** `runPhase0Gate()` executes all eleven §13 Phase-0 assertion checks (AC-2…AC-11, with AC-7 split into AC-7 + AC-7b for §13.5's two conjuncts), each cross-referenced to its satisfying living predecessor (P0.3, P0.5, P0.6, P0.7, P0.9, P0.10) via the `satisfiedBy` field.
- [ ] **Impl:** Gate is **fail-closed** — any errored/timed-out/ambiguous check scores `pass:false`; exit code is `0` only when every assertion is green AND all OQ-1..6 decisions are present.
- [ ] **Impl:** `readOqDecisionLog()` loads `oq-decision-log.json` and validates OQ-1..OQ-6 each carry a non-empty `decision` (fallback noted where taken).
- [ ] **Impl:** Gate harness validates `oq-decision-log.json` structure (6 OQ ids present, non-empty decision each) before AC-11 evaluation.
- [ ] **Contract:** `phase0GateVerdictSchema` (Zod) added with field-level validation for `assertions[]` and `openQuestions[]`; verdict output validated before emit.
- [ ] **Integration:** Each assertion check invokes its predecessor's already-wired surface (launcher, coms logs, budget/turn caps, pi-lens, LSP, env-passthrough via launcher, Paperclip plugins, Hindsight round-trip, gitnexus, OQ decision-log self-assembled by this gate) and asserts the §13 observable — proving wiring across living predecessors (P0.3, P0.5, P0.6, P0.7, P0.9, P0.10) is closed and simultaneous.
- [ ] **Observability:** The aggregated JSON verdict (per-assertion `{id, pass, satisfiedBy, detail}` + per-OQ `{id, decision}`) is emitted to stdout so a red clause names exactly which §13 assertion / OQ blocks Phase 0.
- [ ] **Audit:** OQ-1..OQ-6 decisions are recorded in the checked-in decision-log with any fallback taken (satisfies §13.8).
- [ ] **Test (unit):** Each assertion-check returns `pass:false` on a simulated red predecessor surface (one negative case per check) and `pass:true` on the green surface.
- [ ] **Test (guard):** A single red assertion OR one missing OQ decision yields `pass:false` and non-zero exit (gate cannot pass on partial green).
- [ ] **Test (e2e demo — MANDATORY):** `npm run gate:phase0` against the live foundation (P0.2, P0.3, P0.5, P0.6, P0.7, P0.9, P0.10) prints `pass:true` with all eleven assertions green and OQ-1..6 decided, exits `0`; flipping any one assertion red flips the verdict to `pass:false` + non-zero exit ("all §13 Phase-0 assertions pass; if any is red, Phase 0 is not exited").

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
