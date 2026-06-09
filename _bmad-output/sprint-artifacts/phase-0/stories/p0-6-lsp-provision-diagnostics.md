# P0.6: Warm per-worktree LSP answering diagnostics + definition semantics

**Story Points:** 3

## Spec Reference

- PRD §6.4 (Execution — live LSP), §4.5 (code-intelligence rule); FR-EX-4, FR-EX-10
- Phase exit gate: PRD §13 Phase-0 clause 4b — "An active LSP is proven for the target language: `lsp_diagnostics` surfaces a seeded type error and `lsp_navigation` resolves a definition (or the TUI-only limitation is recorded under OQ-2 with a fallback)."
- OQ-2 LSP sub-finding: records whether headless `lsp_diagnostics` is machine-readable (R4: CONFIRMED) or TUI-only (then proxy/fallback per FR-EX-12).

## User Story

As a Pi worker agent,
I want an active, warm, per-worktree language server answering `lsp_diagnostics` and `lsp_navigation` semantically,
so that I resolve real signatures and catch real type errors against my uncommitted edits instead of guessing from text (G2 correctness / G3 accountability).

## Overview

Cuts through worktree provisioning → pi-lens LSP surface → semantic answer. pi-lens auto-discovers servers from PATH but cannot diagnose a language whose server is absent, so the slice installs the target-repo servers (`typescript-language-server@5.3.0` + `typescript@5.7.x`; `pyright@1.1.410`) on PATH, warms a per-worktree LSP session once, then proves the server answers *semantics* — a deliberately seeded type error surfaces via `lsp_diagnostics` AND `lsp_navigation` resolves a definition by location, not text match. One atomic 3pt unit: provisioning is worthless until the warm server demonstrably answers both calls.

## E2E Slice

**Demonstrable behavior:** With the language servers on PATH and a per-worktree LSP warmed, `lsp-probe.ts:probeWorktreeLsp(worktree)` seeds a known type error in a target-repo `.ts` file, runs pi-lens `lsp_diagnostics` (headless, machine-readable per R4), and runs `lsp_navigation` to resolve a definition. It returns `{ diagnostics: [{ file, line, code, severity }], navResolved: { symbol, defFile, defLine }, surface: "pi_lens" | "ast_grep_fallback", waiver: { waived: boolean, reason: "tui_only"|"no_server"|"latency_budget"|"headless_unavailable", category: "fallback"|"override"|"suppressed"|"accepted-risk", severity: "info"|"warning"|"error" } }` where the seeded error appears in `diagnostics` and `navResolved.defLine` points at the real declaration.

**Wiring closed:** On completion of this story, running `probeWorktreeLsp()` produces a `diagnostics` array containing the seeded type error AND a `navResolved` object whose `defFile`/`defLine` locate the symbol's declaration, using only code merged by this story (server provisioning, warm-session manager, pi-lens `lsp_diagnostics`/`lsp_navigation` calls). No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P0.5 — the headless pi-lens surface + `--mode rpc`/json probe wiring and the OQ-2/§9.3 fallback machinery this story reuses for the LSP sub-finding.

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given the target servers on PATH and a warm per-worktree LSP, When `probeWorktreeLsp()` runs over a file containing a deliberately seeded type error, Then `diagnostics` contains an entry whose `severity==="error"` and whose `{file,line}` matches the seeded site, AND `navResolved.defLine` equals the line of the symbol's real declaration (both semantic facts true in one return, machine-checkable).
2. Given the LSP is cold on first access, When the worktree session is opened, Then the server is warmed once per worktree (not per call), `lsp_diagnostics` returns within the NFR-PERF-6 ≤3s p95 budget, and the warm handle is reused on the second call.
3. Given headless `lsp_diagnostics` is TUI-only OR no server exists for a changed file's language OR diagnostics exceed the latency budget, When the probe resolves, Then `surface==="ast_grep_fallback"`, `waiver.waived===true`, the waiver record is logged with its reason and category (NFR-SAF-4), and the OQ-2 LSP sub-finding is recorded — never a silent skip.
4. Given the LSP returns >500 diagnostics for a single file, When the probe processes them, Then it caps the returned `diagnostics` array at the first 500 entries by severity (errors first, then warnings, then info) and sets a flag `truncated: true` on the result — never an unbounded memory spike from pathological diagnostics floods.

## Technical Notes

- **Contracts/Schema:** Zod `lspProbeSchema` = `{ diagnostics: z.array(z.object({ file: z.string(), line: z.number().int(), code: z.string(), severity: z.enum(["info","warning","error"]) })), navResolved: z.object({ symbol: z.string(), defFile: z.string(), defLine: z.number().int() }).nullable(), surface: z.enum(["pi_lens","ast_grep_fallback"]), waiver: z.object({ waived: z.boolean(), reason: z.enum(["tui_only","no_server","latency_budget","headless_unavailable"]), category: z.enum(["fallback","override","suppressed","accepted-risk"]), severity: z.enum(["info","warning","error"]) }) }`. The `waiver` field is always present (not optional); when no waiver applies, `waived===false` and `reason`/`category`/`severity` carry their default values. The `reason` enum provides the granular trigger; `category` is the parent classification. P1.7 extends this taxonomy at the gate layer (adding pi-lens-specific reasons like `"no_language_server"` and `"latency_budget_exceeded"`); P0.6 provides the base taxonomy that P1.7 builds on. `headless_unavailable` maps to category `"fallback"`.
- **Integration points (each wired & exercised in this story):** `npm i -g typescript-language-server@5.3.0 typescript@5.7.x pyright@1.1.410` provisioning on PATH; per-worktree warm-session manager keyed on worktree path; pi-lens `lsp_diagnostics` call (machine-readable `details` per R4) over the seeded file; pi-lens `lsp_navigation` definition resolve; FR-EX-12 degrade to pi-lens ast-grep + test-pass with a logged waiver when the surface is unavailable. Both `typescript-language-server` and `typescript` packages must be version-locked in `lsp-provision.sh` — the server delegates type-checking to the TypeScript SDK, and a version mismatch causes inaccurate diagnostics. `lsp-provision.sh` verifies both packages are on PATH and the versions are compatible before starting the session.
- **Files / functions touched:** `lsp-probe.ts:probeWorktreeLsp`/`warmWorktreeLsp`, `lsp-provision.sh`.
- **Guards/limits:** The LSP client timeout (default 3000ms) is configurable via `QDS_LSP_TIMEOUT_MS` env var. `lsp_diagnostics` latency cap = NFR-PERF-6 ≤3s p95; exceeding it sets `waiver.waived=true, surface="ast_grep_fallback"` (FR-EX-12), never an unbounded hang. When the LSP latency cap is exceeded and the probe degrades to ast-grep, the run's exit_class is `"logic"` (the run still completes, just without LSP semantics). If the LSP server crashes twice and degrades to ast-grep, exit_class remains `"logic"`. The exit_class is never `"transient"` for LSP issues — the fallback is deterministic, not retryable.
- **Diagnostics navigation probe scope (H2):** The `lsp_navigation` surface exercised by this story covers three LSP methods: `textDocument/definition`, `textDocument/references`, and `textDocument/implementation`. Out of scope for P0.6: `textDocument/hover`, `textDocument/completion`, `textDocument/rename` — these may be added in later phases if needed. `textDocument/documentSymbol` is out of scope — navigation resolves via definition/references/implementation directly, not via a symbol-outline intermediate step.
- **Warm-session lifecycle (H4):** The LSP server process stays alive for the duration of the Pi-team run (started by P1.6, reused across sequential edit steps, killed on run completion). Maximum idle timeout: 30s between requests (configurable via env var `QDS_LSP_IDLE_TIMEOUT_MS`). If the server crashes, it is restarted once; a second crash produces a waiver with reason `no_server` and category `fallback`, and the probe degrades to ast-grep. Crash recovery test: unit test kills the LSP server process mid-session, verifies the probe detects the crash, restarts the server once, and re-runs diagnostics. A second crash within the same session produces a waiver with reason `no_server` and degrades to ast-grep — no infinite restart loop.
- **Pi-team workspace root dependency (H5):** The LSP client resolves file URIs relative to the Pi-team run's workspace root (`--workdir` parameter from P1.6). The LSP `rootUri` sent on `initialize` is set to this workspace root. All file paths in diagnostics and navigation results are relative to this root.
- **Waiver taxonomy extension (H6):** The `headless_unavailable` reason (added to the base enum) covers the case where the pi-lens headless surface is unreachable despite the language server being present. It maps to category `"fallback"`. P1.7 adds pi-lens-specific reasons at the gate layer (e.g., `"no_language_server"`, `"latency_budget_exceeded"`); P0.6 provides the base taxonomy that P1.7 extends.
- **Navigation result shape (H7):** `lsp_navigation` returns `Location[]` (not `LocationLink[]`). The LSP `textDocument/definition` handler normalizes `LocationLink` responses to `Location` format by extracting `uri` and `range.start` from the target. The Zod schema for `navResolved` validates `defFile` (string URI) and `defLine` (integer, 1-based). Multi-location responses (definitions in multiple files) return only the first location — additional locations are discarded with a debug log.
- **Waiver persistence (H8):** When a waiver is logged (`waived===true`), the waiver record (reason, category, severity) is written to the Pi-team run's structured output under `lsp_probes[].waiver`. On subsequent calls in the same run, if the LSP is still unavailable, the same waiver is emitted again (idempotent). Waivers do NOT persist across runs — each run starts fresh. No database or file-backed waiver store; waivers are runtime-only.

## Files to Modify

> ≤10 unique paths.

- `qds-factory/src/lsp/lsp-probe.ts`
- `qds-factory/src/lsp/warm-session.ts`
- `qds-factory/src/lsp/schemas/lsp-probe.schema.ts`
- `qds-factory/scripts/lsp-provision.sh`
- `qds-factory/test/fixtures/seeded-type-error.ts`
- `qds-factory/test/lsp/lsp-probe.test.ts`
- `qds-factory/test/lsp/lsp-probe.e2e.test.ts`

## Security Invariants

> input/file triggers: language servers parse/index target-repo files; LSP operates inside worktree-isolated workspaces.

- **INV-1 (worktree isolation):** the warm LSP session is scoped to a single worktree path; a session opened for worktree A never indexes, diagnoses, or resolves definitions against another worktree's files — cross-worktree leakage is impossible by the session key.
- **INV-2 (no source/secret leak):** the probe surfaces only diagnostic metadata (`file`/`line`/`code`/`severity`) and definition locations (`defFile`/`defLine`) — never source-line content, file bodies, or any scanned secret value into the return object, logs, or the waiver record.
- **INV-3 (bounded, non-silent degrade):** an absent server, a TUI-only headless surface, or a latency-budget breach degrades to ast-grep + test-pass with an explicit logged waiver (FR-EX-12 / NFR-SAF-4) — the gate never hangs unbounded and never silently skips diagnostics.

## Definition of Done

> 8–12 high-signal, story-specific boxes.

- [ ] **Impl:** `lsp-provision.sh` installs `typescript-language-server@5.3.0` + `typescript@5.7.x` + `pyright@1.1.410` on PATH, verifies discovery, and confirms both packages are version-locked and compatible before starting the session.
- [ ] **Impl:** `warmWorktreeLsp` warms one LSP session per worktree (amortized once per session, not per turn) and exposes a reusable handle.
- [ ] **Impl:** `probeWorktreeLsp` runs pi-lens `lsp_diagnostics` over the seeded file and `lsp_navigation` to resolve a definition.
- [ ] **Contract:** `lspProbeSchema` (Zod) added with field-level validation; probe output validated before return.
- [ ] **Integration:** pi-lens `lsp_diagnostics` + `lsp_navigation` calls wired against the warm per-worktree session and exercised end-to-end (semantic, not text).
- [ ] **Observability:** OQ-2 LSP sub-finding recorded (headless diagnostics machine-readable vs TUI-only), reusing the P0.5 verdict log.
- [ ] **Security:** INV-1 enforced — a probe for worktree A never resolves against worktree B's files (asserted).
- [ ] **Security:** INV-3 enforced — missing-server / latency-breach degrades to ast-grep + logged waiver record with reason/category/severity (FR-EX-12, NFR-SAF-4), never an unbounded hang.
- [ ] **Test (unit/integration):** covers warm-reuse (second call reuses handle), the ≤3s budget, the waiver/fallback branch, and crash recovery (kills LSP mid-session, verifies restart-once + second-crash degrades to ast-grep — no infinite restart loop).
- [ ] **Test (e2e demo — MANDATORY):** seeds a real type error in the target repo, runs `probeWorktreeLsp()`, asserts the error appears in `diagnostics` AND `navResolved.defLine` locates the declaration — proves wiring closed. The e2e test also asserts `navResolved` is non-null and `defLine > 0` — navigation must produce a real result, not just 'no crash'.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
