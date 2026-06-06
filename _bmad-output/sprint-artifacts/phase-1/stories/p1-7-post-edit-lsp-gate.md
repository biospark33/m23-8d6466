# P1.7: Post-edit `lsp_diagnostics` gate blocks emit on dirty changed files

**Story Points:** 3

## Spec Reference

- PRD §6.4 (Execution — Pi team / pi-lens); FR-EX-11, FR-EX-12; NFR-SAF-4, NFR-SAF-6, NFR-PERF-6
- PRD §4.5 ("the single strongest lever — the post-edit diagnostics gate"); §4.6 (launcher stdout protocol, mandatory `changed_files`)
- Phase exit gate: PRD §13 Phase-1 item 5 ("the node **blocks emit while `lsp_diagnostics` shows errors on changed files**; post-edit gate, waivers logged")

## User Story

As a **Dev manager** driving the `qds-piv-loop` implement node,
I want **the team lead to run `lsp_diagnostics` over the union of all changed files and refuse to emit node output while any error remains (or log an explicit waiver when the LSP surface is unavailable)**,
so that **"compiles + typechecks" becomes a hard precondition of every handoff (drives loop L1, fewer in-run defects — goal G2 quality yield).**

## Overview

This slice cuts through the Pi-team launcher (`pi-team-launch.sh`) lead-emit path: each worker returns `changed_files: string[]` in its `coms_await` reply; the lead computes the set-union, invokes pi-lens `lsp_diagnostics` (headless, machine-readable JSON confirmed v3.8.47, OQ-2) over that union, and **gates stdout**. Zero errors → emit the merged JSON node output. Errors present → no emit (non-zero exit / re-request). When no language server exists for a changed file, `lsp_diagnostics` is unavailable, or it breaches the NFR-PERF-6 ≤3s p95 budget, the gate degrades to pi-lens `ast_grep_*` + test-pass with a **logged waiver** (FR-EX-12). One atomic unit because the gate is meaningless without both the union-collection protocol and the fallback+waiver path wired together.

## E2E Slice

**Demonstrable behavior:** The implement node runs `pi-team-launch.sh --task … --archetype C --context-path ./ctx` against a worktree where a worker introduced a deliberate type error in a changed file. The launcher lead aggregates workers' `changed_files`, runs `lsp_diagnostics` over the union, sees `errorCount > 0`, and **writes nothing to stdout / exits non-zero** (gate held). On a clean re-run with 0 errors, the lead writes the single merged JSON object (`{ changed_files, result, partial:false, exit_class:"transient", waivers:[] }`) to stdout. With the LSP surface forced unavailable for a changed file's language, the lead emits **with `waivers:[{file, reason:"no_language_server", fallback:"ast_grep+tests"}]`** populated.

**Wiring closed:** On completion of this story, running `pi-team-launch.sh` on a worktree carrying a known type error on a changed file produces **no stdout node output and a non-zero exit (gate held)**, and on the clean run produces the merged JSON with `waivers:[]`, using only code merged by this story (lead union-collection + `lsp_diagnostics` invocation + fallback/waiver emit in `pi-team-launch.sh`). No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P0.6 (pi-lens + LSP servers on PATH, headless `lsp_diagnostics` machine-readable spike — OQ-2 RESOLVED) · P1.6 (the merged-output lead-emit path that this gate guards). Both are dependency edges, not leftover wiring.

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given a worktree where a worker reported a changed file carrying a known type error, When the lead runs `lsp_diagnostics` over the union of all workers' `changed_files` at node emit, Then `errorCount > 0` and the launcher writes **nothing to stdout and exits non-zero** (no node emits over a known type error on a changed file).
2. Given all changed files are clean (0 diagnostics errors), When the lead runs the union gate, Then the launcher writes exactly one merged JSON object to stdout with `waivers: []` and exit code 0.
3. Given a changed file whose language has **no server on PATH** (or `lsp_diagnostics` exceeds the NFR-PERF-6 ≤3s p95 budget), When the gate runs, Then the lead degrades to `ast_grep_*` + test-pass for that file and emits with a populated `waivers[]` entry (`reason`, `fallback:"ast_grep+tests"`) — never a silent skip.
4. Given a worker reply that **omits** `changed_files`, When the lead aggregates the union, Then the lead **fails the node** (logic error, non-zero exit) — this is a node failure, NOT a waivable diagnostics failure (CORRECTNESS-C).

## Technical Notes

- **Contracts/Schema:** Worker `response_schema` MUST carry `changed_files: string[]` (parse-only per coms — lead validates explicitly, §4.6). Merged stdout object: `{ changed_files: string[] (union), result: object, partial: boolean, exit_class: "transient"|"overflow"|"logic", waivers: Array<{ file: string, reason: "no_language_server"|"headless_unavailable"|"latency_budget_exceeded", fallback: "ast_grep+tests" }> }`. Backward-compat: `waivers` defaults to `[]`; existing single-worker (Solo) nodes still produce the union of one list.
- **Integration points (each wired & exercised in this story):** lead reads each worker's `coms_await` reply → set-union of `changed_files` → pi-lens `lsp_diagnostics` (file/dir/batch, `--mode json`/`--mode rpc`, structured `details` per `tools/lsp-diagnostics.ts:451-470`) over the union → stdout gate. Fallback path → pi-lens `ast_grep_*` + the worktree's test command. Waiver records are counted by NFR-SAF-4 / capped by NFR-SAF-6.
- **Files / functions touched:** `pi-team-launch.sh` (lead-emit block: union compute, diagnostics invocation, gate, fallback, waiver record); the worker reply validator; the merged-output schema definition consumed by the launcher.
- **Guards/limits:** `lsp_diagnostics` invocation bounded by NFR-PERF-6 (≤3s p95) — a breach is a waiver trigger, never an unbounded hang. Waiver-rate ceiling ≤5% of emitted nodes (NFR-SAF-6) — out of scope to enforce per-run here, but each waiver is logged as a first-class record for that aggregate.

## Files to Modify

- `scripts/pi-team-launch.sh`
- `scripts/lib/lead-emit.sh`
- `scripts/lib/lsp-gate.sh`
- `scripts/schemas/merged-output.schema.json`
- `tests/launcher/lsp-gate.bats`

## Security Invariants

> Triggered: input/file (deserialization/parse of worker replies; file paths fed to `lsp_diagnostics`).

- **INV-1 (parse-validate, never trust):** worker `coms_await` replies are `JSON.parse`-only (parse-only schema, §5.2) — the lead MUST schema-validate `changed_files` is a `string[]` before use; a malformed/missing `changed_files` **fails the node** (AC-4), it is never coerced to an empty union (which would silently pass the gate).
- **INV-2 (no path escape):** every entry in the union `changed_files` is resolved and constrained to the run's worktree path (`--worktree`/inherited `cwd`); a path resolving outside the worktree is rejected (the gate never runs `lsp_diagnostics` over arbitrary host files).
- **INV-3 (no silent bypass):** the gate degrades ONLY via a recorded `waivers[]` entry with an enumerated `reason`; there is no code path that emits node output over a non-empty diagnostics error set without either 0 errors or a logged waiver (NFR-SAF-4: 0 un-waived dirty-diagnostics emits).
- **INV-4 (no leak):** raw `lsp_diagnostics` / `ast_grep` tool output (which may echo source lines) goes to **stderr** (Archon warning channel, `dag-executor.ts:1370-1378`), never to the structured stdout node output beyond the bounded `waivers[]` summary.

## Definition of Done

- [ ] **Impl:** lead computes the set-union of all workers' `changed_files` before any emit decision.
- [ ] **Impl:** lead invokes pi-lens `lsp_diagnostics` (`--mode json`/`rpc`) over the union and parses the structured `details` error count.
- [ ] **Impl:** FR-EX-12 fallback path runs pi-lens `ast_grep_*` + the worktree test command when LSP is unavailable / over budget, and writes a `waivers[]` record.
- [ ] **Contract:** merged-output schema (incl. `changed_files` union, `waivers[]` with enumerated `reason`/`fallback`) defined and validated by the launcher before stdout; `waivers` defaults `[]`.
- [ ] **Security:** INV-1 enforced — a missing/malformed `changed_files` fails the node (logic error), proven by a unit test (AC-4).
- [ ] **Security:** INV-3 enforced — no emit path bypasses the gate without 0 errors or a logged waiver.
- [ ] **Observability:** every waiver is logged to stderr as a first-class record (`{file, reason, fallback}`) counted by NFR-SAF-4 / NFR-SAF-6.
- [ ] **Test (unit/integration):** covers (a) dirty-union → no emit / non-zero exit, (b) clean-union → emit with `waivers:[]`, (c) missing-server → fallback + waiver, (d) omitted `changed_files` → node failure.
- [ ] **Test (e2e demo — MANDATORY):** run `pi-team-launch.sh` on a worktree seeded with a known type error on a changed file; assert **no stdout node output + non-zero exit**; then fix the error and assert a single merged JSON object with `waivers:[]` is written (proves wiring closed: no node emits over a known type error; fallback+waiver path demonstrable).

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
