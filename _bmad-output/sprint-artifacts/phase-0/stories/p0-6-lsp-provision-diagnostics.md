# P0.6: Provision Target-Repo LSP + Prove Active Diagnostics/Navigation

**Story Points:** 3

## Spec Reference

- PRD §4.5 (code intelligence rule); FR-EX-4, FR-EX-10
- Phase exit gate: PRD §13 Phase-0 clause 5 (LSP diagnostics + navigation proven)
- NFR-PERF-6

## User Story

As a Pi worker agent,
I want a warm per-worktree LSP server providing live diagnostics and semantic navigation for the target repo,
so that I can resolve definitions, references, and type information reflecting uncommitted edits (FR-EX-10, G1).

## Overview

Provisions and validates a warm LSP server (typescript-language-server) for the QDS-Factory repo. Proves `lsp_diagnostics` returns errors reflecting uncommitted edits (not stale index), `lsp_navigation` resolves go-to-definition and find-references correctly, and the latency budget holds (≤3s p95, NFR-PERF-6). Cuts Pi extension + LSP infrastructure layer. 3 pts because it is a single concern (LSP viability) scoped to one language (TypeScript).

## E2E Slice

**Demonstrable behavior:** A Pi agent with pi-lens opens a TypeScript file in a worktree, introduces a type error (uncommitted edit), runs `lsp_diagnostics`, and receives an error diagnostic reflecting the uncommitted change. Then runs `lsp_navigation` for go-to-definition on a symbol and receives the correct definition location.

**Wiring closed:** On completion of this story, running `lsp_diagnostics` against an uncommitted type error in a worktree returns the error, and `lsp_navigation` for a known symbol resolves to its definition — using only infrastructure provisioned by this story plus pi-lens from P0.5. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P0.5 (pi-lens installed — provides `lsp_diagnostics` and `lsp_navigation` tool surfaces).

## Acceptance Criteria

1. **(make-or-break)** Given a warm typescript-language-server for the QDS-Factory worktree, When `lsp_diagnostics` runs on a file with an uncommitted type error, Then the diagnostic output reflects the error (not stale pre-edit state) within ≤3s (NFR-PERF-6).
2. Given a TypeScript symbol with a known definition location, When `lsp_navigation` runs `go-to-definition`, Then the result resolves to the correct file:line:character.
3. Given a file in a language with no LSP server on PATH, When `lsp_diagnostics` runs, Then the result degrades gracefully with a logged warning (no crash, no hang — FR-EX-12 preamble).

## Technical Notes

- **Contracts/Schema:** `lsp_diagnostics` input: `{ file: string, dir?: string, batch?: string[] }`. Output: structured `details` object with findings array (file, line, severity, message, stable ID). `lsp_navigation` input: `{ action: "definition"|"references"|"hover"|"symbols", file: string, line: number, character: number }`. Output: location array (file, line, character) or hover text.
- **Integration points (each wired & exercised in this story):** typescript-language-server cold-start amortized once per worktree session; pi-lens discovers server from PATH; `lsp_diagnostics` reflects uncommitted edits (not stale index); `lsp_navigation` resolves cross-file references.
- **Files / functions touched:** None in repo — this is a provisioning + verification story. Test script under `scripts/lsp-verify.ts`.
- **Guards/limits:** Cold-start once per worktree session (not per turn — NFR-PERF-6); `lsp_diagnostics` ≤3s p95; graceful degradation when no server available (logged warning, not error).

## Files to Modify

- `scripts/lsp-verify.ts` (verification script)
- `_bmad-output/sprint-artifacts/_research/lsp-verification-report.md` (findings artifact)

## Security Invariants

- **INV-1:** LSP server runs with user-level permissions only; no elevated access to repo files beyond worktree scope.
- **INV-2:** Diagnostic output contains file paths and error messages only — no secret values from file contents included in diagnostic payloads.

## Definition of Done

- [ ] **Impl:** Warm typescript-language-server provisioned for QDS-Factory repo worktree; cold-start measured and amortized.
- [ ] **Impl:** Verification script exercises `lsp_diagnostics` with uncommitted edit and `lsp_navigation` with known symbols.
- [ ] **Contract:** `lsp_diagnostics` output schema documented (file, line, severity, message, stable ID format).
- [ ] **Contract:** `lsp_navigation` output schema documented (location array with file:line:character).
- [ ] **Integration:** Diagnostics reflect uncommitted edits (live semantic analysis, not stale index); navigation resolves cross-file references.
- [ ] **Integration:** Graceful degradation confirmed for unsupported language files (logged warning, no crash).
- [ ] **Test (verification):** `lsp_diagnostics` on type error returns finding within ≤3s; `lsp_navigation` resolves definition to correct location.
- [ ] **Test (e2e demo — MANDATORY):** Pi agent runs `lsp_diagnostics` against uncommitted type error → error reflected; `lsp_navigation` on symbol → correct definition resolved; latency ≤3s p95.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
