# P1.7: Post-Edit lsp_diagnostics Gate Blocks Emit on Changed-File Errors

**Story Points:** 3

## Spec Reference

- PRD §4.2; FR-EX-11, FR-EX-12, NFR-SAF-4
- Phase exit gate: PRD §13 Phase 1 clause 7

## User Story

As a dev manager,
I want every Pi agent emit to be gated on LSP diagnostics for changed files,
so that no code with unresolved errors is emitted to the repository.

## Overview

After a Pi implement agent finishes editing files inside a Warren burrow, pi-lens v3.8.47 runs `lsp_diagnostics` on the union set of changed files. If any diagnostic error is returned, the emit step is blocked and the agent must fix or acknowledge. If diagnostics are clean, emit proceeds with `waiver=0` (no waiver needed). When no LSP server is available for a given language (FR-EX-12), the gate degrades gracefully to an ast-grep + test-pass check and logs a `waiver.reason: 'no-lsp'` entry. All waiver events are persisted for audit.

## E2E Slice

**Demonstrable behavior:** Pi implement agent changes `src/auth.ts` inside a Warren burrow. Post-edit hook invokes pi-lens `lsp_diagnostics` on the changed-file union. If TypeScript LSP reports errors → emit is blocked, agent is notified to fix. If diagnostics are clean → emit proceeds with `waiver: 0`. When LSP server is unavailable for a file type → gate falls back to ast-grep + test-pass, logs `waiver.reason: 'no-lsp'`, and allows emit.

**Wiring closed:** On completion of this story, a dirty-diagnostics emit is blocked and a clean-diagnostics emit proceeds using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P0.6, P1.6

## Acceptance Criteria

1. **(make-or-break)** Given a Pi agent has edited files in a Warren burrow, When pi-lens `lsp_diagnostics` is invoked on the changed-file union set, Then any diagnostic with severity `error` blocks the emit step and returns a structured diagnostics report to the agent.
2. Given `lsp_diagnostics` returns zero errors on the changed-file union, When the emit gate evaluates, Then emit proceeds and the run record includes `waiver: 0` with no waiver reason logged.
3. Given no LSP server is available for a file's language (LSP startup timeout or not on PATH), When the gate evaluates, Then it degrades to ast-grep + test-pass fallback, logs `waiver.reason: 'no-lsp'`, and allows emit only if the fallback checks pass.
4. Given the degraded fallback (ast-grep + test-pass) also fails, When the gate evaluates, Then emit is blocked with `waiver.reason: 'no-lsp'` and `gateResult: 'blocked'`.

## Technical Notes

- **Contracts/Schema:** `DiagnosticsGateResult { passed: boolean, waiver: number, waiverReason?: string, diagnostics: DiagnosticEntry[], gateVersion: string }`. `DiagnosticEntry { file: string, line: number, severity: 'error' | 'warning', message: string, source: 'lsp' | 'ast-grep' }`.
- **Integration points:** pi-lens v3.8.47 `lsp_diagnostics` RPC; LSP servers must be on PATH (provisioned by P0.6); ast-grep binary on PATH as fallback.
- **Files / functions touched:** `src/gates/lsp-diagnostics-gate.ts` (gate implementation), `src/gates/ast-grep-fallback.ts` (degraded path), `src/protocol/phases/emit-phase.ts` (gate invocation), `src/models/diagnostics-result.ts` (schema).
- **Guards/limits:** Maximum LSP diagnostic call timeout: 30s per file. Changed-file union capped at 50 files per run. Waiver events persisted to Hindsight `{repo}-dev-meta` bank with `kind: 'waiver'`.

## Files to Modify

- `src/gates/lsp-diagnostics-gate.ts`
- `src/gates/ast-grep-fallback.ts`
- `src/protocol/phases/emit-phase.ts`
- `src/models/diagnostics-result.ts`

## Security Invariants

- INV-DIAG-1: No emit may proceed when `lsp_diagnostics` reports severity `error` on any changed file unless a valid waiver reason is logged.
- INV-DIAG-2: All waiver events (including `no-lsp` degradation) are persisted to audit log with timestamp, agentId, issueId, and full diagnostics snapshot.
- INV-DIAG-3: Gate result is immutable once computed — cannot be overridden by downstream logic.

## Definition of Done

- [ ] **Impl:** `lsp_diagnostics` gate invoked on changed-file union after Pi agent edit phase
- [ ] **Impl:** Emit blocked on any diagnostic severity `error`; structured report returned to agent
- [ ] **Impl:** Clean diagnostics → emit proceeds with `waiver: 0`
- [ ] **Impl:** Degraded fallback to ast-grep + test-pass when LSP server unavailable; `waiver.reason: 'no-lsp'` logged
- [ ] **Contract:** `DiagnosticsGateResult` schema defined and exported; `DiagnosticEntry` schema defined
- [ ] **Integration:** pi-lens `lsp_diagnostics` RPC called from gate; LSP servers on PATH from P0.6
- [ ] **Security:** Waiver audit entries persisted to Hindsight `{repo}-dev-meta` bank with full context
- [ ] **Test (unit):** Gate blocks on error diagnostics; gate passes on clean; fallback invoked when LSP unavailable; fallback blocked when ast-grep also fails
- [ ] **Test (e2e demo — MANDATORY):** End-to-end run where Pi agent edits a file with a TypeScript error → emit blocked; fix the error → emit proceeds with `waiver: 0`; simulate no LSP → fallback with logged waiver
