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

## QA Results

**Review Date:** 2026-07-14
**Reviewed By:** Quinn — Senior Developer QA (BMAD review-story)

### Code Quality Assessment

The verification harness (`scripts/pi-lens-verify.ts`, revised in the companion
fix) is now honest and well-structured: a minimal newline-framed JSON-RPC 2.0
`McpClient` with proper lifecycle (fail-fast on server crash/exit, bounded stderr
tail, idempotent close), deterministic checks, and evidence that distinguishes
*observed* vs *derived* facts instead of blurring them. The earlier report
over-reported (3/3 "pass", a live Python proof, an emit-block described as if
observed); the revised harness + report correct all of that. Real run: 3 pass,
0 fail, 1 optional skip, exit 0, against pi-lens **3.8.69** (spec pins 3.8.47 —
drift, non-fatal).

### Refactoring Performed (companion harness fix — summarized here for the record)

- **Honesty split of AC2** into AC2a (secret *detection*, live via opengrep —
  pass) and AC2b (*emit-block*, empirical `pilens_turn_end` probe — optional
  skip, `emitBlockObserved:false`; the block is passed only if the `🔴 STOP`
  line is actually seen).
- **Observed-vs-derived ID for AC1**: the harness now imports pi-lens's own
  `createActionableWarningId` for native parity, and separately probes
  `actionable-warnings.jsonl` for an id pi-lens actually assigned —
  `idObserved:false` is recorded plainly (aggregator requires a code-action-
  bearing warning; none available on this host).
- **McpClient lifecycle**: fail-fast rejection of pending RPCs on server
  error/exit, EPIPE guard, bounded stderr capture, idempotent close.
- **State containment**: `PILENS_DATA_DIR` + `PI_LENS_CONFIG_PATH` pointed inside
  the temp dir — no more `~/.pi-lens/projects/*` litter, global config untouched.
- **Explicit Node runtime** for the MCP server (`PILENS_NODE`/`node`, bun only as
  last resort) since pi-lens ships a Node package.
- **Strict mode**: `--strict` / `CI` exits non-zero on any *non-optional* skip;
  AC2b is optional (host-dependent), so strict still exits 0 here.
- **Provenance-based secret matching** (tool/rule families, not keyword regex),
  git working-tree staging for opengrep's ruleset, bounded polling past
  opengrep's cold start, and accurate exit semantics (exit 0 iff no FAIL, skips
  allowed; exit 2 fatal).
- **Version-drift reporting**: `piLensVersion` vs `piLensVersionSpec` with a
  non-fatal note (3.8.69 installed vs 3.8.47 pinned).

### Compliance Check

- AC1: **met with caveat** — structured LSP diagnostic live; stable `aw:<hash>`
  id derived with native-function parity (`idObserved:false`; the story's
  `tool_execution_end`→`JSON.stringify` transport is not exercised — the harness
  parses the MCP fenced-JSON payload instead).
- AC2: **partial** — detection proven live; emit-block NOT observed (needs
  gitleaks/trivy or an LLM-backed turn); the `secret_detected` finding-type
  label does not exist in pi-lens 3.8.69 (rule-ID-based detection) — flagged as
  a spec-vs-impl discrepancy, not silently confirmed.
- AC3: **met** — FR-EX-8 numeric read + logged fallback proven; demonstrated
  count is a reconciled 0-value fallback.
- Coding conventions / file scope: respected — review touched only the harness,
  the report, and this QA section.

### Improvements Checklist

- [x] Harness reports observed-vs-derived IDs honestly (`idObserved`, `idProvenance`, native parity)
- [x] AC2 split into live detection (pass) vs emit-block probe (optional skip)
- [x] pi-lens on-disk state contained in the temp dir (`PILENS_DATA_DIR`)
- [x] MCP server spawned under Node, not bun
- [x] `--strict`/`CI` mode and accurate exit-code semantics
- [x] Report reconciled to the revised harness (versions, excerpts labeled, DoD traceability)
- [ ] Live emit-block observation — needs gitleaks/trivy installed (or an LLM-backed turn)
- [ ] AC1 observed-id — needs an LSP that emits a code-action-bearing warning (OSS pyright has no quick-fix for `reportUnusedImport`; TS has no warning-category diagnostics)
- [ ] MANDATORY `--mode json` agent e2e demo — blocked on LLM auth in this environment

### Security Review

- **INV-1:** detection proven **live** (opengrep Semgrep rule fires on the
  synthetic key); the emit-block path is **source-verified only**
  (`runtime-turn.js` promotes gitleaks/trivy `sessionSecrets` to the `🔴 STOP`
  blocker; opengrep-only findings stay advisory). No secret value reaches any
  output — the blocker names `file:line — rule [sources]` only.
- **INV-2:** preserved — LSP servers launched by named commands from
  `LSP_SERVERS`, discovered from `node_modules/.bin` or PATH only; no arbitrary
  binary execution.
- Synthetic secrets are generated at runtime from string fragments (no
  key-shaped literal committed); the temp dir is deleted post-run, and under
  `--keep` the secret fixture is overwritten-then-deleted.

### Performance Considerations

Warm `lspLatencyMs` observed at ~1.2–1.9s (1211ms in the quoted run) — within
the ≤3s p95 target (NFR-PERF-6). **Cold** LSP starts (first boot, especially
pyright, and opengrep's ~8s auxiliary-server cold start) exceed the target; this
is documented in the report (Findings §5.5) and mitigated in the harness by
warming + bounded polling. pi-lens augmentation is advisory (NFR-PERF-5), so
cold-start latency does not block a turn.

### Final Status

**Changes Required / Partially Approved — core headless surfaces proven live (AC1 diagnostics, AC2 detection, AC3 proxy); emit-block, observed-id, and the mandatory `--mode json` agent demo remain open (environment-gated), documented in the report.**
