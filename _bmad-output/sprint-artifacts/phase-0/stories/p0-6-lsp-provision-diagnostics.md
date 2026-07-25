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

1. **(make-or-break)** Given a warm typescript-language-server for the QDS-Factory worktree, When `lsp_diagnostics` runs on a file with an uncommitted type error, Then the diagnostic output reflects the error (not stale pre-edit state) within ≤3 s p95 over WARM diagnostics (NFR-PERF-6), where WARM = after the server has returned its first non-empty diagnostic response; p95 is computed from ≥20 warm `durationMs` samples sourced from `~/.pi-lens/latency.log` (or the harness's equivalent timing record) across a representative run. Cold starts are amortized once per worktree session (not per turn) and logged as advisory; cold starts (pyright, opengrep ~8 s auxiliary) exceed the target and are logged as a cold-start advisory, not a failure (augmentation is advisory, NFR-PERF-5). The `baselineN → postEditN` count-delta is the stale-index negative control (separate from the latency p95): the harness captures a baseline diagnostic count BEFORE the edit; after the edit it asserts the new error ID/rule appears AND the count changed — proving the diagnostic reflects the uncommitted edit, not a stale index (Reference P0.5 QA Performance §).
2. Given a TypeScript symbol with a known definition location, When `lsp_navigation` runs `go-to-definition`, Then the result resolves to the correct file:line:character.
   - **2b.** Given a symbol whose definition resolves to a URI outside the worktree root (e.g. node_modules, lib.dom.d.ts), When `lsp_navigation` runs go-to-definition, Then the result is the resolved native LSP `Location[]` (each entry: `uri` + `range`, with `range.start.line`/`range.start.character` 0-indexed); ts-language-server returns actual `Location[]` whose `uri` may be an external path (`file://.../node_modules/...`, `…/lib.dom.d.ts`) — it does NOT return null/empty for external defs. The harness flags any result whose URI is outside the worktree root as `external:true` via a URI-prefix check against the worktree root (this flag is a pi-lens/harness-layer convention, NOT native LSP), and records the observed behavior. Never silently coerces to an empty array.
3. Given a file in a language with no LSP server on PATH, When `lsp_diagnostics` runs, Then the result degrades gracefully with a logged warning (no crash, no hang — FR-EX-12 preamble). The graceful-degradation warning is emitted in the `lsp_diagnostics` response payload AND appended to `~/.pi-lens/projects/<slug>/` artifacts (note: pi-lens uses a per-project dir, not the flat `~/.pi-lens/cache/`); the harness asserts both.
   - **3a.** Given a server on PATH that accepts the connection but sends no `initialize` response within `LSP_INIT_TIMEOUT_S` (default 15 s — ts-language-server warm `initialize` latency is not measured in P0.5; pyright/opengrep cold auxiliary starts exceed this and are logged as advisory, not failure), When `lsp_diagnostics` runs, Then the harness times out (bounded), logs `lsp_init_timeout`, and returns a graceful-degradation payload (no hang). **Harness invariant:** every RPC has a deadline.
4. Given `batch: ["fileA.ts","fileB.ts"]`, When `lsp_diagnostics` runs, Then findings are returned per-file (keyed by file) via SEQUENTIAL per-file `textDocument/diagnostic` RPCs, each with its own deadline; a per-file failure yields PARTIAL results (that file's entry reports the failure, other files still return findings) — NOT atomic all-or-nothing. (LSP `textDocument/diagnostic` is one-document-per-request; ts-language-server exposes no batch/transaction primitive.)

## Technical Notes

> **⚠️ SUPERSEDED BY IMPLEMENTATION (2026-07-24, P0.6 verification).** The
> contract paragraph below was written pre-implementation and specifies request
> shapes pi-lens does not accept. **Downstream stories (P0.11, P1.7) must use
> the IMPLEMENTED contract, not the text below.** No adapter exists — the
> legacy shapes are simply invalid.
>
> | Spec below says | pi-lens 3.8.71 actually accepts |
> |---|---|
> | `lsp_navigation { action, file, line, character }` | `lsp_navigation { operation, path, line, character, symbol? }` — **1-based** line/character |
> | `lsp_diagnostics { file, dir?, batch? }` | `lsp_diagnostics { path?, paths?, severity?, concurrency?, waitMs?, serverScope? }` |
> | batch = SEQUENTIAL per-file RPCs | `paths` with bounded concurrency across DISTINCT server groups; files sharing one server are serialized against it |
> | nav output = native 0-indexed `Location[]` | envelope carrying BOTH: `result` = native 0-indexed `Location[]`, `locations` = 1-indexed presentation layer |
> | batch output = structured per-file findings | human-readable TEXT with no JSON envelope; per-file keying must be parsed |
>
> Agent-facing tool names are `lsp_diagnostics` / `lsp_navigation`; the MCP
> server exposes the same engine as `pilens_lsp_diagnostics` / `pilens_lsp_navigation`.

- **Contracts/Schema (ORIGINAL PRE-IMPLEMENTATION SPEC — see the superseding table above):** `lsp_diagnostics` input: `{ file: string, dir?: string, batch?: string[] }`. Output shape is TBD per the P0.5 caveat: the structured `details` object observed in P0.5 came from `pilens_analyze`, while `pilens_lsp_diagnostics` returns a human-readable line. The harness records WHICH surface actually yields the structured findings array (file, line, severity, message, stable ID WHERE ASSIGNED per the pi-lens aggregator gate; error-severity diagnostics may carry no ID — recorded as `idObserved:false`, never faked), and the verification artifact documents it. Do not pre-commit the schema to a surface P0.5 did not observe. When `batch` is set, findings are gathered via SEQUENTIAL per-file RPCs with partial-results-allowed on per-file failure (AC4). `lsp_navigation` input: `{ action: "definition"|"references"|"hover"|"symbols", file: string, line: number, character: number }`. Output: native LSP `Location[]` wire shape (`uri` + `range.start.line`/`range.start.character`, 0-indexed) or hover text; "file:line:character" is the PRESENTATION layer, not the wire shape. External definitions are flagged `external:true` via a URI-prefix check against the worktree root — a pi-lens/harness-layer convention layered on top of the native `Location[]`, NOT a native LSP field (AC2b).
- **Version pinning:** pi-lens ≥ 3.8.69 floor (installed; P0.5 pinned 3.8.47, drifted — do NOT hard-pin to the drifted 3.8.47). `typescript-language-server@5.3.0` pinned (consistent with P0.5).
- **Integration points (each wired & exercised in this story):** typescript-language-server cold-start amortized once per worktree session; pi-lens discovers server from PATH; `lsp_diagnostics` reflects uncommitted edits (not stale index — `baselineN → postEditN` negative control); `lsp_navigation` resolves cross-file references; external definitions surface explicitly (AC2b).
- **Files / functions touched:** None in repo — this is a provisioning + verification story. Test script under `scripts/lsp-verify.ts`.
- **Guards/limits:** Cold-start once per worktree session (not per turn — NFR-PERF-6); cold starts (pyright, opengrep ~8 s auxiliary) logged as advisory, not failure (NFR-PERF-5); `lsp_diagnostics` ≤3 s p95 over WARM calls (WARM = after first non-empty diagnostic response; ≥20 warm `durationMs` samples from `~/.pi-lens/latency.log` or equivalent; the `baselineN → postEditN` count-delta is the stale-index negative control, separate from the latency p95); graceful degradation when no server available (logged warning in payload AND `~/.pi-lens/projects/<slug>/` artifacts, not error); **harness invariant: every RPC has a deadline** (`LSP_INIT_TIMEOUT_S` default 15 s, AC3a); batch is SEQUENTIAL per-file RPCs with partial-results-allowed on per-file failure (AC4) — NOT atomic.

### Wave 1 Reuse Mandate

This story consumes P0.5's pi-lens `lsp_diagnostics` / `lsp_navigation` surfaces. The verification harness (`scripts/lsp-verify.ts`) MUST mirror P0.5's `scripts/pi-lens-verify.ts` discipline: strict-gated, fail-fast on server crash/exit, bounded per-RPC deadlines, observed-vs-derived honesty, `PILENS_DATA_DIR` state containment, exit 0 iff no FAIL (optional-skip allowed), CI env implies strict.

### P0.5 Surface Inheritance

P0.5's QA surfaced three empirical caveats this story inherits and must not paper over:

1. **Structured `details` payload source:** the structured `details` payload observed in P0.5 came from `pilens_analyze`, NOT `pilens_lsp_diagnostics` (which returns a human-readable line). Confirm which surface P0.6 actually consumes before asserting a schema on the `lsp_diagnostics` output; record the observed surface in the verification artifact.
2. **Stable `aw:<hash>` IDs are gated:** stable IDs are emitted by pi-lens's aggregator only when a code action is produced — `idObserved:false` is a real state, not faked. The harness records the observed state; it never synthesizes an ID.
3. **Secret-scan is rule-ID-based:** in pi-lens 3.8.69 detection is rule-ID-based; the `secret_detected` label does not exist. Do not gate or filter on that label.

## Files to Modify

- `scripts/lsp-verify.ts` (verification script)
- `_bmad-output/sprint-artifacts/_research/lsp-verification-report.md` (findings artifact)

## Security Invariants

- **INV-1:** LSP server runs with user-level permissions only; no elevated access to repo files beyond worktree scope.
- **INV-2:** Diagnostic payloads contain file paths + messages only — no secret values. This relies on P0.5's pi-lens secret-scan as the UPSTREAM guard; per P0.5 QA, detection is proven live (rule-ID-based in pi-lens 3.8.69) but emit-block is environment-gated (needs gitleaks/trivy in `sessionSecrets`) and the `secret_detected` label does not exist. P0.6 records this empirical status, it does not assume emit-block is solid.

## Definition of Done

- [x] **Impl:** Warm typescript-language-server provisioned for QDS-Factory repo worktree; cold-start measured and amortized. — cold start 1682 ms, amortized once per worktree session, advisory-only (NFR-PERF-5).
- [x] **Impl:** Verification script exercises `lsp_diagnostics` with uncommitted edit and `lsp_navigation` with known symbols. — `scripts/lsp-verify.ts`, 7 checks, exit 0.
- [x] **Contract (C1):** `lsp_diagnostics` output schema documented (file, line, severity, message, stable ID format WHERE ASSIGNED per the pi-lens aggregator gate; error-severity diagnostics may carry no ID — recorded as `idObserved:false`, never faked) — and the verification artifact records WHICH pi-lens surface (`pilens_lsp_diagnostics` vs `pilens_analyze`) actually yielded the structured findings array (P0.5 caveat: structured `details` came from `pilens_analyze`, not `pilens_lsp_diagnostics`).
- [x] **Contract (C2):** `lsp_navigation` output schema documented — native LSP `Location[]` wire shape (`uri` + `range.start.line`/`range.start.character`, 0-indexed); "file:line:character" is the presentation layer; external defs flagged `external:true` via URI-prefix check against the worktree root (harness-layer convention, not native LSP) (AC2b).
- [x] **Version:** Verification artifact records the installed pi-lens version (P0.5 observed 3.8.69; P0.6 inherits the installed version, does NOT re-pin the drifted 3.8.47).
- [x] **Integration:** Diagnostics reflect uncommitted edits (live semantic analysis, not stale index); navigation resolves cross-file references. Harness captures `baselineN → postEditN` and asserts the new error ID/rule appears AND the count changed (stale-index negative control).
- [~] **Integration (PARTIAL — artifact half not asserted):** Graceful degradation confirmed for unsupported language files (logged warning in `lsp_diagnostics` payload AND `~/.pi-lens/projects/<slug>/` artifacts; no crash).
- [~] **Test (verification — PARTIAL: see AC1/AC3a story-level partials below):** `lsp_diagnostics` on type error returns finding within ≤3 s p95 over WARM diagnostics (cold-start amortized once per worktree session; cold starts logged as advisory, not failure — NFR-PERF-5); `lsp_navigation` resolves definition to correct location; **harness invariant: every RPC has a deadline.**
- [x] **Test (verify-script strict-gating):** `scripts/lsp-verify.ts` exits 0 iff no FAIL; optional-skip allowed and distinguished; CI env implies `--strict`; the mandatory `--mode json` agent e2e demo is LLM-auth-gated and explicitly recorded as deferred-or-met (mirrors P0.5 §7).
- [x] **Test (e2e demo — MANDATORY):** Pi agent runs `lsp_diagnostics` against uncommitted type error → error reflected; `lsp_navigation` on symbol → correct definition resolved; latency ≤3 s p95 over WARM diagnostics (cold-start amortized once per worktree session, advisory-only when exceeded — NFR-PERF-5).

### Story-level acceptance status (probe pass ≠ AC met)

The verification harness reports 7/7 probe passes. Story-level acceptance is
stricter, and the two are tracked separately so a phase-gate reader is not
misled by the probe count:

| AC | Probe | Story-level | Gap |
|----|-------|-------------|-----|
| AC1 | pass | **partial** | time-to-fresh-result ≤3 s p95 proven; a SINGLE post-edit query is not reliably fresh (9/20 returned the prior revision) |
| AC2 | pass | met | — |
| AC2b | pass | met | — |
| AC3 | pass | **partial** | payload warning asserted; the `~/.pi-lens/projects/<slug>/` artifact half is NOT asserted — pi-lens wrote no degradation signal |
| AC3a | pass | **partial** | harness RPC-deadline invariant proven; pi-lens's INTERNAL LSP init timeout not exercised |
| AC4 | pass | **partial** | per-file keying + PARTIAL-on-failure proven; the literal "SEQUENTIAL per-file RPCs" wording is not the tool's contract |

Full evidence and reconciliation: `_bmad-output/sprint-artifacts/_research/lsp-verification-report.md`.

## Dev Agent Record

**Status:** DONE — PR #42 squash-merged to `main` 2026-07-25 as `cfca40d`.
**Completed:** 2026-07-24 · Branch `feature/p0-6-lsp-provision-diagnostics` (deleted local + remote)

**Review:** 5 rounds, 24 findings, all addressed. CodeRabbit final: "No further
findings from static review of 690a420." Sift final: "Sifted through the code and
found no issues." Gemini Code Assist did not participate — its consumer version
was sunset mid-review and all its review activity has permanently ceased.

**Deliverables**
- `scripts/lsp-verify.ts` — headless verification harness (MCP stdio + real agent turn)
- `tests/lsp-verify.test.ts` — 36 unit tests (pi-lens not required) + 1 skippable live integration test (37 total)
- `_bmad-output/sprint-artifacts/_research/lsp-verification-report.md` — findings artifact
- `package.json` → `verify:lsp`

**Result:** 7 checks, 7 pass, 0 fail, 0 skip, exit 0. pi-lens 3.8.71 (floor 3.8.69).
Warm p95 **427 ms** vs a 3 000 ms budget; cold start 1 682 ms (advisory).
Stale-index control `baselineN 2 → postEditN 3` with `editUncommitted: true`.

**MANDATORY e2e demo: MET.** Unlike P0.5 (whose host lacked LLM auth), a real
`pi -p --mode json` agent turn invoked `lsp_diagnostics` and `lsp_navigation`,
reflecting the uncommitted TS2322 and resolving the cross-file definition —
which also exercises the `tool_execution_end` → structured `details` contract
path P0.5 left open.

**Story-level partials (recorded, not redefined as satisfied)**
- AC3 artifact half: pi-lens wrote no degradation signal to the project artifacts; only the payload half is asserted.
- AC3a: proves the harness's RPC-deadline invariant, not pi-lens's internal LSP init timeout.
- AC4: pi-lens uses bounded concurrency across server groups, not literal sequential per-file RPCs; the AC's intent is met.

**Notable findings**
- pi-lens is NOT globally installed on this host (P0.5's evidence came from a different machine); resolution extended to `PI_LENS_ROOT` → repo-local → global.
- 9/20 warm samples returned a STALE diagnostic on the first query after a rapid edit; the harness measures time-to-fresh-result and documents the behavior.
- Navigation returns BOTH shapes: native 0-indexed `Location[]` under `result`, and a 1-indexed presentation layer under `locations`.
- 8 spec-vs-impl discrepancies catalogued in the report (§8).

**Local review:** 3 independent adversarial rounds (correctness / security+invariants / AC-DoD conformance) before PR. 3 blockers, 3 highs, and several medium/low findings applied — including 5 real harness bugs: unfenced-JSON parsing, wrong AC2 navigation origin, text-only batch surface, a macOS `/var`→`/private/var` symlink mislabel, and a warm-latency measurement that could not distinguish a cached replay from a live re-query.
