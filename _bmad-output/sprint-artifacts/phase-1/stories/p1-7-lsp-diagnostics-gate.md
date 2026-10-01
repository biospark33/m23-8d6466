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

After a Pi implement agent finishes editing files inside a Warren burrow, pi-lens (≥ 3.8.69) runs `lsp_diagnostics` on the union set of changed files. If any diagnostic error is returned, the emit step is blocked and the agent must fix or acknowledge. If diagnostics are clean, emit proceeds with `waiver=0` (no waiver needed). When no LSP server is available for a given language (FR-EX-12), the gate degrades gracefully to an ast-grep + test-pass check and logs a `waiverReason: 'no-lsp'` entry. All waiver events are persisted for audit.

## E2E Slice

**Demonstrable behavior:** Pi implement agent changes `src/auth.ts` inside a Warren burrow. Post-edit hook invokes pi-lens `lsp_diagnostics` on the changed-file union. If TypeScript LSP reports errors → emit is blocked, agent is notified to fix. If diagnostics are clean → emit proceeds with `waiver: 0`. When LSP server is unavailable for a file type → gate falls back to ast-grep + test-pass, logs `waiverReason: 'no-lsp'`, and allows emit.

**Wiring closed:** On completion of this story, a dirty-diagnostics emit is blocked and a clean-diagnostics emit proceeds using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P0.6, DF1.6 (was P1.6) — **P0.6 is DONE** (PR #42, merged 2026-07-25). <!-- v5 amendment (DF5.5) -->

> ## ⚠️ P0.6 findings this story MUST absorb before implementation
>
> P0.6 verified these surfaces live against pi-lens **3.8.71**. Three of its
> findings change this story's design, and one of them is a correctness bug if
> ignored. Full evidence: `_bmad-output/sprint-artifacts/_research/lsp-verification-report.md`.
>
> **1. A single post-edit `lsp_diagnostics` call is NOT reliably fresh — this
> gate cannot be built on one query.** P0.6 measured a **stale-first-response
> rate of 9 of 20** (≈ 45%) — a warm-sample property of the re-query loop
> (i.e. 9 of 20 first responses returned the PREVIOUS revision's diagnostics
> when issued immediately after an edit). A gate that edits, queries once,
> sees "clean", and permits emit will therefore let genuinely broken code
> through roughly half the time — the exact failure INV-DIAG-1 exists to
> prevent. What P0.6 proved is **time-to-fresh-result** (warm p95 **427 ms**
> per P0.6 `lsp-verification-report.md`, the source-of-truth — the
> phase0-gate-report observed 453 ms on a separate run; both well inside the
> ≤ 3 s budget inherited from P0.6 NFR-PERF-6), using a re-query loop until
> the response reflects the edit. **This gate MUST implement the same bounded
> re-query.** Do not treat "diagnostics reflect uncommitted edits" as "the first
> call reflects them".
>
> **Freshness contract (testable — AC6).** "Accept and log stale reads" is NOT
> an option for a gate whose whole purpose is INV-DIAG-1; the contract is:
>
> | Element | Value |
> |---|---|
> | **Freshness signal** | The response's per-file diagnostic set is *fresh* when it reflects the post-edit revision. Observable proxy: pi-lens's `stableId` for the changed file changes from the pre-edit value, or (when no pre-edit diagnostic existed) a first non-stale response is observed. `parseBatchDiagnosticsText` (`scripts/lsp-verify.ts`) supplies the per-file keying. |
> | **Re-query policy** | Bounded retry until fresh: initial query, then re-query every 250 ms. |
> | **Deadline** | **10 s** ceiling for the changed-file union (P0.6's ceiling, reused deliberately). Warm p95 is 427 ms, so the ceiling is a backstop, not the expectation. |
> | **Outcome if freshness is NOT reached by the deadline** | **Fail closed.** Emit is BLOCKED with `gateResult: 'blocked'` and `waiverReason: 'stale-diagnostics'`. The gate MUST NOT pass on a stale read. |
> | **Override** | Only an explicit human waiver may release a `stale-diagnostics` block. It is never the default path and is persisted per INV-DIAG-2. |
>
> **1a. AC3a/AC4 carry P0.6 partialness forward — this gate must close both.**
> P0.6 left AC3a (pi-lens-internal LSP init timeout) unexercised and corrected
> AC4 in Wave 5: it is **not** literal sequential per-file RPCs. **AC4
> contract is `paths` with bounded per-server concurrency (NOT sequential
> per-file RPCs); this gate MUST use `paths`, not a hand-rolled sequential
> loop.** AC3a's init-timeout path must be exercised by an explicit test
> (simulate LSP startup exceeding `LSP_INIT_TIMEOUT_S = 15 s` from P0.6), not
> silently inherited as "unexercised".
>
> **2. The tool contract in the notes below is wrong.** pi-lens does not accept
> the shapes originally specified:
>
> | Originally specified | Actual (pi-lens 3.8.71) |
> |---|---|
> | `lsp_diagnostics { file, dir?, batch? }` | `{ path?, paths?, severity?, concurrency?, waitMs?, serverScope? }` |
> | `batch` = sequential per-file RPCs | `paths` = bounded concurrency across DISTINCT server groups; files sharing a server are serialized against it |
> | structured per-file batch output | human-readable TEXT, no JSON envelope — per-file keying must be PARSED (see `parseBatchDiagnosticsText` in `scripts/lsp-verify.ts`) |
> | `lsp_navigation { action, file, ... }` | `{ operation, path, line, character, symbol? }`, **1-based** |
>
> The structured diagnostics array comes from `pilens_analyze`;
> `pilens_lsp_diagnostics` returns a human-readable line. Agent-facing tool
> names are `lsp_diagnostics` / `lsp_navigation`; the MCP server prefixes them
> `pilens_`.
>
> **3. Version pin is stale.** The notes below say pi-lens **v3.8.47**; P0.5
> observed 3.8.69 and P0.6 ran against **3.8.71**. Do not re-pin to 3.8.47.
>
> **Reuse rather than re-implement:** `scripts/lib/mcp-stdio-client.ts`
> (MCP stdio transport) and `scripts/lib/pi-lens-harness.ts` (install
> resolution, version floor, latency stats) are shared modules built for exactly
> this. P0.6's own review flagged copy-adaptation as a defect multiplier.

## Acceptance Criteria

1. **(make-or-break)** Given a Pi agent has edited files in a Warren burrow, When pi-lens `lsp_diagnostics` is invoked on the changed-file union set, Then any diagnostic with severity `error` blocks the emit step and returns a structured diagnostics report to the agent.
2. Given `lsp_diagnostics` returns zero errors on the changed-file union, When the emit gate evaluates, Then emit proceeds and the run record includes `waiver: 0` with no waiver reason logged.
3. Given no LSP server is available for a file's language, When the gate evaluates, Then it degrades to ast-grep + test-pass fallback, logs `waiverReason: 'no-lsp'`, and allows emit only if the fallback checks pass.

   > **Availability is a pi-lens resolution/startup result, NOT a PATH check (AC3 definition).** P0.6 observed pi-lens **auto-installing** `typescript-language-server` rather than requiring it on PATH, so "not on `PATH`" would wrongly downgrade a perfectly usable LSP to the waiver path. An LSP counts as *unavailable* for a file's language only when pi-lens itself reports it: (a) pi-lens resolves no server for that language, or (b) the resolved server fails to start / exceeds `LSP_INIT_TIMEOUT_S = 15 s` (AC3a). The gate MUST ask pi-lens and branch on its result; it MUST NOT probe `PATH` for a server executable to decide availability. (`PATH` remains the availability test for the **ast-grep** fallback binary — that one is not pi-lens-managed.)
4. Given the degraded fallback (ast-grep + test-pass) also fails, When the gate evaluates, Then emit is blocked with `waiverReason: 'no-lsp'` and `gateResult: 'blocked'`.
5. Given ALL diagnostic paths are unavailable (no LSP server for the file's language, AND ast-grep binary not on PATH, AND no test suite present), When the gate evaluates, Then emit is blocked with `waiverReason: 'no-evaluator'` and `gateResult: 'blocked'` — the gate MUST fail-closed rather than silently pass when it has no evaluator to run.

6. **(freshness, fail-closed)** Given the first `lsp_diagnostics` response for a changed file is stale (reflects the pre-edit revision — P0.6 measured this in 9 of 20 warm samples), When the gate evaluates, Then it re-queries every 250 ms until the response reflects the edit and evaluates that fresh result; and if freshness is not achieved within the 10 s deadline, Then emit is blocked with `gateResult: 'blocked'` and `waiverReason: 'stale-diagnostics'` — the gate MUST NOT pass on a stale read. See the Freshness contract above.

> **P1.7-V1 (middle-case declaration):** Given LSP unavailable + ast-grep present + no test suite, the test-pass fallback evaluates as **vacuous-pass** (aligns with P0.6 coverage-optionality — a repo with no test suite is not penalized); emit proceeds with `waiverReason: 'no-lsp'`. This is the declared middle case between AC3 (both fallbacks present and pass) and AC5 (no evaluator at all → fail-closed).

## Technical Notes

- **Contracts/Schema:** `DiagnosticsGateResult { passed: boolean, gateResult: 'passed' | 'blocked', waiver: number, waiverReason?: 'no-lsp' | 'no-evaluator' | 'stale-diagnostics' | 'lsp-timeout', diagnostics: DiagnosticEntry[], gateVersion: string }`. `DiagnosticEntry { file: string, line: number, severity: 'error' | 'warning', message: string, source: 'lsp' | 'ast-grep' }`.
  - **One representation — flat `waiver` + `waiverReason` (P1.7-R5-1).** Earlier drafts of the acceptance criteria wrote the reason as a nested `waiver.reason: 'no-lsp'`, i.e. `waiver` as an *object*, while this schema declares `waiver` as a **number** (the waiver count, `0` when none) with the reason in a **sibling** `waiverReason` field. Both spellings cannot be true of one type: coding AC3–AC6 to `waiver.reason` against the declared type dereferences a number, so those ACs were unsatisfiable as written. The nested spelling is **retracted**; every AC, DoD item, log line, test assertion, and persisted audit record uses the flat pair. Concretely: a clean pass is `{ passed: true, gateResult: 'passed', waiver: 0 }` with `waiverReason` **absent**; any blocked or degraded outcome sets `waiver >= 1` and `waiverReason` to one of the four enum values, and `waiverReason` is present **iff** `waiver > 0`. `gateResult` is authoritative for allow/block and MUST agree with `passed` (`'passed'` ⇔ `passed: true`); the fail-closed no-evaluator case (AC5) is `{ passed: false, gateResult: 'blocked', waiver: 1, waiverReason: 'no-evaluator' }`.
- **Integration points:** pi-lens `lsp_diagnostics` RPC (version ≥ 3.8.69 — NOT the stale v3.8.47 pin; P0.6 ran 3.8.71); LSP servers resolved per-worktree by pi-lens, which AUTO-INSTALLS `typescript-language-server` rather than requiring it on PATH (P0.6 observation) — hence AC3's availability test is pi-lens's resolve/start result, never a PATH probe; ast-grep binary on PATH as fallback (PATH *is* the right test for this one — it is not pi-lens-managed).
- **Files / functions touched:** `src/gates/lsp-diagnostics-gate.ts` (gate implementation), `src/gates/ast-grep-fallback.ts` (degraded path), `src/protocol/phases/emit-phase.ts` (gate invocation), `src/models/diagnostics-result.ts` (schema).
- **Guards/limits:** Warm p95 budget **3 s** (NFR-PERF-6, inherited from P0.6 — typical cold-cache re-query is sub-second; the gate should treat 3 s as the alerting threshold, not the steady-state expectation). Per-file hard ceiling **30 s** (defensive backstop only — NOT typical; it composes P0.6's `LSP_INIT_TIMEOUT_S = 15 s` init window with one 60–120 s per-RPC deadline truncated to fit a single-file worst case, see `scripts/lsp-verify.ts:866, 998, 1066`). Changed-file union capped at 50 files per run. Waiver events persisted to Hindsight `{repo}-dev-meta` bank with `kind: 'waiver'`.
  - **Timeout outcomes — the gate never silently passes on a timeout.** Every deadline below has one declared, auditable result:

    | Timeout | Outcome | `waiverReason` |
    |---|---|---|
    | LSP **initialization** exceeds `LSP_INIT_TIMEOUT_S = 15 s` | Treat the LSP as unavailable → AC3 ast-grep + test-pass fallback; emit allowed only if the fallback passes (AC4 blocks if it does not) | `'no-lsp'` |
    | Diagnostic **RPC** exceeds the 30 s per-file ceiling *after a successful startup* | **BLOCK** (`gateResult: 'blocked'`). A started server that will not answer is not the FR-EX-12 no-LSP case, so it does NOT earn the fallback path | `'lsp-timeout'` |
    | **Freshness** not achieved within the 10 s re-query deadline | **BLOCK** (`gateResult: 'blocked'`) per the Freshness contract above | `'stale-diagnostics'` |

    All three outcomes are persisted to the Hindsight `{repo}-dev-meta` bank with `kind: 'waiver'` and the full diagnostics snapshot (INV-DIAG-2), so an exhausted evaluator is always visible in the audit trail rather than indistinguishable from a clean pass.

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
- [ ] **Impl:** Degraded fallback to ast-grep + test-pass when LSP server unavailable; `waiverReason: 'no-lsp'` logged
- [ ] **Contract:** `DiagnosticsGateResult` schema defined and exported; `DiagnosticEntry` schema defined; the **flat** `waiver: number` + `waiverReason?` pair is the only waiver representation (P1.7-R5-1) — a grep of this story's modules and tests for the nested `waiver.reason` spelling MUST come back empty
- [ ] **Test (waiver shape, P1.7-R5-1):** Clean pass → `{ gateResult: 'passed', passed: true, waiver: 0 }` with `waiverReason` absent. Each of the four blocked/degraded reasons → `waiver >= 1` with the matching `waiverReason` and `gateResult` agreeing with `passed`. Assert `waiverReason` is present iff `waiver > 0`.
- [ ] **Integration:** pi-lens `lsp_diagnostics` RPC called from gate; **LSP availability is decided by pi-lens's own resolve/start result, never by a `PATH` lookup** (P1.7-R2-7 — the previous "LSP servers on PATH from P0.6" wording contradicted AC3 and the AC3 test below, and is retracted: a server pi-lens can resolve and start is available even when it is absent from `PATH`, and the gate MUST NOT probe `PATH` to decide). The `no-lsp` fallback is entered only when pi-lens reports it could not resolve or start a server for the file's language.
- [ ] **Security:** Waiver audit entries persisted to Hindsight `{repo}-dev-meta` bank with full context
- [ ] **Test (unit):** Gate blocks on error diagnostics; gate passes on clean; fallback invoked when LSP unavailable; fallback blocked when ast-grep also fails
- [ ] **Test (e2e demo — MANDATORY):** End-to-end run where Pi agent edits a file with a TypeScript error → emit blocked; fix the error → emit proceeds with `waiver: 0`; simulate no LSP → fallback with logged waiver
- [ ] **Test (AC3a):** LSP init-timeout path — simulate LSP startup exceeding `LSP_INIT_TIMEOUT_S = 15 s` (P0.6) → gate routes to ast-grep + test-pass fallback with `waiverReason: 'no-lsp'` (not silently inherited as "unexercised")
- [ ] **Test (AC4):** `paths` contract — gate invokes `lsp_diagnostics` with `paths: [<changed files>]` (bounded per-server concurrency); assert NO hand-rolled sequential per-file RPC loop
- [ ] **Test (P1.7-L4 positive):** For >1 changed file, the gate makes **exactly one externally visible `lsp_diagnostics` tool invocation** carrying `paths:[f1,f2,…]` = the complete changed-file union (assert on the gate's call to the tool, NOT on underlying server RPCs — `paths` is defined as bounded concurrency across distinct server groups, so a conforming pi-lens implementation may fan out internally and an "exactly one RPC" assertion would reject correct behavior). Assert separately that (a) files in DISTINCT server groups are dispatched concurrently up to the `concurrency` bound, and (b) files sharing one server are serialized against it.
- [ ] **Test (freshness, AC6 fail-closed):** Simulate a stale-first diagnostic response (first query returns the PRE-edit revision) → verify the gate re-queries on the 250 ms interval and passes once a fresh response arrives. Then hold the response stale past the 10 s deadline → verify emit is **blocked** with `gateResult: 'blocked'` and `waiverReason: 'stale-diagnostics'`, and that the waiver is persisted to `{repo}-dev-meta`. Assert the gate never passes on a stale read.
- [ ] **Test (RPC timeout after successful startup):** LSP starts within 15 s but the diagnostics RPC exceeds the 30 s per-file ceiling → verify emit is **blocked** with `waiverReason: 'lsp-timeout'` (NOT downgraded to the `'no-lsp'` ast-grep fallback) and the waiver is persisted.
- [ ] **Test (AC3 availability is not a PATH probe):** With `typescript-language-server` absent from `PATH` but resolvable/startable by pi-lens, verify the gate runs the **LSP** path (no `no-lsp` waiver) — i.e. availability is decided by pi-lens's resolve/start result, not by a PATH lookup.
- [ ] **Test (AC5 fail-closed):** No LSP + no ast-grep + no test suite → emit blocked with `waiverReason: 'no-evaluator'` and `gateResult: 'blocked'`
