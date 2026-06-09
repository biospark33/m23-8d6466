# P0.5: Install pi-lens + Prove Headless Machine-Readable TDI/Warnings

**Story Points:** 4

## Spec Reference

- PRD §4.5 (code intelligence rule), §5.4 (pi-lens surface); FR-EX-4, FR-EX-5, FR-EX-8
- Phase exit gate: PRD §13 Phase-0 clause 5 (pi-lens headless output confirmed)
- NFR-SEC-3

## User Story

As a Pi swarm integrator,
I want pi-lens installed and its headless machine-readable output proven for TDI and warning-count metrics,
so that post-edit QA gates and turn-end reports work in non-interactive DAG nodes (FR-EX-4, FR-EX-5, FR-EX-8, G1).

## Overview

Installs pi-lens v3.8.47, confirms `--mode json`/`--mode rpc` headless emission, validates `lsp_diagnostics` structured output, proves TDI fallback path (warning-count proxy via on-disk `~/.pi-lens/` artifacts), and confirms secret-scan blocking behavior (NFR-SEC-3). Cuts Pi extension layer only. 4 pts because it spans multiple pi-lens surfaces (diagnostics, navigation, TDI, secret-scan) and requires live LSP server validation.

## E2E Slice

**Demonstrable behavior:** A Pi agent with pi-lens installed runs `--mode json` against a TypeScript file with a deliberate error. The turn-end report contains structured diagnostics with stable finding IDs and a warning count. A second run against a file with a hardcoded secret produces a blocked-emit result (secret-scan fires, NFR-SEC-3).

**Wiring closed:** On completion of this story, running a pi-lens-equipped Pi agent in `--mode json` mode against a test file produces machine-readable JSON containing `lsp_diagnostics` output with stable IDs and warning counts; secret-scan blocks emit on detected secrets. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** None — standalone.

## Acceptance Criteria

1. **(make-or-break)** Given pi-lens v3.8.47 installed and `typescript-language-server@5.3.0` on PATH, When a Pi agent runs in `--mode json` against a TypeScript file with a type error, Then the output contains structured `lsp_diagnostics` JSON with ≥1 finding and stable `aw:<hash>` IDs.
2. Given a file with a hardcoded API key pattern, When pi-lens secret-scan runs, Then the turn-end emit is blocked with a `secret_detected` finding (NFR-SEC-3).
3. Given headless TDI is a TUI slash-command (not a CLI flag), When the proxy metric path is used, Then warning count from on-disk `~/.pi-lens/` artifacts is readable as a numeric value with logged fallback reason (FR-EX-8).

## Technical Notes

- **Contracts/Schema:** pi-lens `lsp_diagnostics` output: structured `details` object serialized via `tool_execution_end` → `JSON.stringify`. Finding IDs: `aw:<hash>` format (stable across turns). Warning-count proxy: read `~/.pi-lens/cache/actionable-warnings.json` for aggregate count. Secret-scan: blocks emit on detect, returns `secret_detected` finding type.
- **Integration points (each wired & exercised in this story):** `pi install npm:pi-lens` → `~/.pi/agent/settings.json` `packages: ["npm:pi-lens"]`; LSP server discovery from PATH; `--mode json` headless emission confirmed; on-disk artifact path `~/.pi-lens/` readable.
- **Files / functions touched:** None in repo — this is an installation + verification story. Test scripts under `scripts/pi-lens-verify.ts`. LSP servers already on PATH (`typescript-language-server@5.3.0`, `pyright@1.1.410`).
- **Guards/limits:** `lsp_diagnostics` latency ≤3s p95 (NFR-PERF-6); pi-lens augmentation is advisory (NFR-PERF-5); TDI fallback logs explicit reason (FR-EX-8).

## Files to Modify

- `scripts/pi-lens-verify.ts` (verification script)
- `_bmad-output/sprint-artifacts/_research/pi-lens-verification-report.md` (findings artifact)

## Security Invariants

- **INV-1:** pi-lens secret-scan blocks turn-end emit on detected secrets (NFR-SEC-3) — no secret reaches coms output, merged JSON, or Hindsight bank.
- **INV-2:** LSP servers discovered from PATH only; no arbitrary binary execution paths.

## Definition of Done

- [ ] **Impl:** pi-lens v3.8.47 installed via `pi install npm:pi-lens`; settings.json contains package entry.
- [ ] **Impl:** Verification script exercises `lsp_diagnostics`, secret-scan, and warning-count proxy paths.
- [ ] **Contract:** pi-lens `lsp_diagnostics` structured output format documented (finding ID format, severity, file:line, message).
- [ ] **Integration:** `--mode json` headless emission confirmed — machine-readable JSON on stdout, no TUI required.
- [ ] **Integration:** LSP server auto-discovery from PATH confirmed for TypeScript and Python.
- [ ] **Security:** Secret-scan blocks emit on hardcoded API key pattern; finding type `secret_detected` confirmed.
- [ ] **Observability:** TDI proxy path documented: on-disk artifact read with logged fallback reason when TUI-only TDI is unavailable (FR-EX-8).
- [ ] **Test (verification):** Structured diagnostics output parseable with stable IDs; warning count numeric; secret-scan blocks.
- [ ] **Test (e2e demo — MANDATORY):** Pi agent with pi-lens runs in `--mode json` against test files; stdout contains structured diagnostics with ≥1 finding and warning count; secret-scan blocks on secret file.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
