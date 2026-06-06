# P0.10: Cold-start GitNexus graph — analyze target repo and prove real graph queries

**Story Points:** 3

## Spec Reference

- PRD §6.4 (Execution — graph-aware traversal); FR-EX-9; NFR-PERF-5
- Phase exit gate: PRD §13 Phase-0 clause 7b (initial `gitnexus analyze` completes to a non-error state AND `gitnexus_context`/`gitnexus_impact` return real graph data — **required before any Phase-1 story executes**)
- PRD §12.1 item 6 (install `pi-gitnexus-plus`, run initial `gitnexus analyze`); R4 §8; R3 §A code-intelligence rule.

## User Story

As a Pi worker agent (Architect/Reviewer/Implementer),
I want a cold-start knowledge graph built on the target repo and the `gitnexus_context` / `gitnexus_impact` tools returning real data on a sample symbol,
so that codebase traversal is graph-aware (call chains, blast radius) instead of blind grep (G1 throughput, G2 correctness), satisfying the §13 Phase-0 cold-start sequencing hard gate before any Phase-1 story runs.

## Overview

This slice cuts the Pi-team code-intelligence layer: install the `pi-gitnexus-plus` extension (v0.7.0, NOT installed; GitNexus CLI 1.6.3 already present) and run the **initial `gitnexus analyze`** on the target repo to materialize the cold-start graph. FR-EX-9's cold-start clause: on an un-analyzed repo the graph tools return empty/error and agents fall back to grep with a logged warning — so the analyze MUST complete to a non-error state and the tools MUST return real data before Phase-1. This is a §13 assertion-7b **hard gate** that sequences ahead of all Phase-1 stories. One atomic 3pt unit: graph isn't demonstrable until the extension loads, analyze completes, and a real query returns data — all together.

## E2E Slice

**Demonstrable behavior:** `node scripts/graph/cold-start.ts --repo <target> --symbol <SampleSymbol>` installs `pi-gitnexus-plus` (`pi install npm:pi-gitnexus-plus`), runs `gitnexus analyze` on the target repo to a non-error exit, then calls `gitnexus_context` and `gitnexus_impact` on `<SampleSymbol>`. Stdout is a single JSON object `{ extInstalled: true, analyze: { exitCode: 0, indexedHeadSha: "<sha>", durationMs: <n> }, context: { symbol: "<SampleSymbol>", nodes: <n>, callChain: [...] }, impact: { symbol: "<SampleSymbol>", blastRadius: <n>, affected: [...] } }` where `context.nodes>0` and `impact.affected.length>0` (REAL graph data, not empty cold-start).

**Wiring closed:** On completion of this story, running `cold-start.ts --repo <target> --symbol <SampleSymbol>` produces the JSON object above with `analyze.exitCode===0`, `context.nodes>0`, and a non-empty `impact.affected`, using only code merged by this story (extension install step, analyze invocation, graph-query wrapper, sample-symbol assertion). No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** None — standalone. GitNexus CLI 1.6.3 is already present at `/usr/local/bin`; this story installs only the `pi-gitnexus-plus` extension and runs the initial analyze. This story is a **hard predecessor of every Phase-1 story** (§13 assertion 7b cold-start sequencing constraint), not a successor.

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given `pi-gitnexus-plus` is installed and `gitnexus analyze` has run on the target repo to a non-error exit, When `gitnexus_context` and `gitnexus_impact` are queried on `<SampleSymbol>`, Then the emitted JSON has `analyze.exitCode===0`, `context.nodes>0`, and `impact.affected.length>0` — i.e. the tools return REAL graph data, not the empty/error cold-start state (§13 Phase-0 clause 7b satisfied).
2. Given the analyze completes, When the script emits, Then `analyze.indexedHeadSha` equals the repo's current HEAD SHA and `analyze.durationMs` is recorded (so graph staleness is computable per NFR-OBS-5 downstream).
3. Given `gitnexus analyze` exits non-zero OR `gitnexus_context` returns empty/error on the sample symbol, When the script runs, Then it exits non-zero with a logged warning naming the cold-start fallback (grep, NFR-PERF-5) and does NOT report the gate as passed — never a silent green.

## Technical Notes

- **Contracts/Schema:** Graph-query wrapper TS types: `GitnexusContextResult { symbol: string; nodes: number; callChain: string[] }` and `GitnexusImpactResult { symbol: string; blastRadius: number; affected: string[] }`, mapping the `gitnexus_context` / `gitnexus_impact` agent-tool responses (R4 §8 — the two most load-bearing of the 14 registered tools). Cold-start contract: empty `nodes`/`affected` ⇒ gate NOT passed.
- **Integration points (each wired & exercised in this story):** `pi install npm:pi-gitnexus-plus` (v0.7.0) loads the extension into the Pi agent; `gitnexus analyze` (CLI 1.6.3) builds the graph; `gitnexus_context` + `gitnexus_impact` queried on the sample symbol and asserted non-empty. The MCP GitNexus server is confirmed live (R4 §8) and is the query transport (stdio local CLI or HTTP).
- **Files / functions touched:** `scripts/graph/cold-start.ts` (install + analyze + query + JSON emit), `src/graph/gitnexus-client.ts` (`context`/`impact` wrappers + empty-result detection).
- **Guards/limits:** graph augmentation is advisory + non-blocking (NFR-PERF-5, ≤1.5s p95) — but for THIS cold-start proof an empty/error result fails the make-or-break (the analyze must have produced a real graph). Re-running `cold-start.ts` is idempotent (analyze rebuilds/overwrites the index).

## Files to Modify

> ≤10 unique paths. Absolute or repo-relative, one per line.

- `scripts/graph/cold-start.ts`
- `src/graph/gitnexus-client.ts`
- `config/tooling-pins.json`
- `tests/graph/cold-start.test.ts`

## Security Invariants

> Concrete named invariants — `N/A` is FORBIDDEN (input/file trigger applies: analyze reads the repo file tree + accepts a symbol arg).

- **INV-1 (input/file):** The `--symbol` argument is treated as untrusted input and is passed only as a structured query parameter to `gitnexus_context`/`gitnexus_impact` — never interpolated into a shell command or a Cypher string (no `gitnexus_cypher` injection surface from the sample-symbol path).
- **INV-2 (input/file):** `gitnexus analyze` operates within the target repo path only; the `--repo` path is validated to resolve inside an allowed workspace root before analyze runs, so the file-traversal cannot escape the intended repo tree.
- **INV-3 (input/file):** The graph index materialized by analyze is treated as advisory data (NFR-PERF-5); a malformed/empty graph result triggers the logged grep fallback and a non-zero exit (AC-3), never an unhandled crash or a silent pass.

## Definition of Done

> 8–12 high-signal, story-specific boxes. NO lint/tests/typecheck filler.

- [ ] **Impl:** `cold-start.ts` installs `pi-gitnexus-plus` v0.7.0 and runs the initial `gitnexus analyze` on the target repo to a non-error exit.
- [ ] **Impl:** `gitnexus-client.ts` wraps `gitnexus_context` + `gitnexus_impact` and detects the empty/error cold-start state.
- [ ] **Impl:** Single JSON status object emitted to stdout with `extInstalled`, `analyze`, `context`, `impact` sections.
- [ ] **Contract:** `GitnexusContextResult` / `GitnexusImpactResult` TS types added; empty-result ⇒ gate-not-passed semantics encoded.
- [ ] **Integration:** Extension load + analyze + both graph queries exercised end-to-end on a real sample symbol returning real data.
- [ ] **Observability:** `analyze.indexedHeadSha` + `analyze.durationMs` recorded (basis for the NFR-OBS-5 ≤8h staleness computation downstream).
- [ ] **Security:** `--symbol` passed as a structured query param, never shell/Cypher-interpolated; `--repo` path validated inside the workspace root (INV-1/INV-2).
- [ ] **Test (unit/integration):** Covers the non-empty happy path AND the cold-start/empty-result guard path (logged grep fallback + non-zero exit, no silent green).
- [ ] **Test (e2e demo — MANDATORY):** Runs `cold-start.ts --repo <target> --symbol <SampleSymbol>`; asserts `analyze.exitCode===0`, `context.nodes>0`, and non-empty `impact.affected` (proves §13 Phase-0 clause 7b + wiring closed, gating all Phase-1 stories).

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
