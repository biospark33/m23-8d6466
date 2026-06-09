# P0.10: Install pi-gitnexus-plus + Initial Analyze + Prove Graph Queries

**Story Points:** 3

## Spec Reference

- PRD §10 (Code Intelligence); FR-EX-9
- Phase exit gate: PRD §13 Phase 0 clause 10

## User Story

As a QDS dev agent,
I want pi-gitnexus-plus installed with an analyzed QDS-Factory repo graph,
so that agent sessions can query code structure, context, and impact without full-text grep (G4 — dev velocity through code intelligence).

## Overview

This story installs the `pi-gitnexus-plus` extension (v0.7.0) into the Pi agent environment, runs `gitnexus analyze` on the QDS-Factory repository to build the code knowledge graph, and verifies the three core agent tools (`gitnexus_query`, `gitnexus_context`, `gitnexus_impact`) return non-empty results for known symbols. GitNexus CLI (v1.6.3) is pre-installed. The extension registers 14 agent tools, but this story only validates the three primary query paths. This is a 3-point unit because it is primarily installation + verification with no new code paths — just confirming the existing toolchain works end-to-end.

## E2E Slice

**Demonstrable behavior:** Run `pi install npm:pi-gitnexus-plus@0.7.0`, run `gitnexus analyze` on the QDS-Factory repo, then invoke `gitnexus_query` (query: "SwarmClaw agent registration"), `gitnexus_context` (symbol: "registerAgent"), and `gitnexus_impact` (target: "registerAgent", direction: "upstream") — all three return non-empty results.

**Wiring closed:** On completion of this story, `gitnexus_query`, `gitnexus_context`, and `gitnexus_impact` return structured results for known QDS-Factory symbols using only code installed by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** None — standalone.

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given `pi-gitnexus-plus@0.7.0` installed and `gitnexus analyze` completed on QDS-Factory, When `gitnexus_query` is invoked with query "SwarmClaw routes", `gitnexus_context` is invoked with symbol "registerAgent", and `gitnexus_impact` is invoked with target "registerAgent" direction "upstream", Then all three return non-empty result objects with at least one symbol, file path, and relevance score.
2. Given a completed analysis, When `gitnexus_query` is called with a query matching zero symbols (e.g., "ZZZZZZZ_NONEXISTENT_SYMBOL"), Then the result is an empty array (not null, not error) — graceful empty, never crash.
3. Given `pi-gitnexus-plus` is NOT installed, When an agent attempts to invoke `gitnexus_query`, Then Pi returns a tool-not-found error (not a silent failure or hang) — the agent can detect the missing extension and report it.

## Technical Notes

- **Contracts/Schema:**
  ```typescript
  // gitnexus_query result
  const QueryResultSchema = z.object({
    processes: z.array(z.object({
      id: z.string(),
      label: z.string(),
      relevanceScore: z.number().min(0).max(1),
    })),
    symbols: z.array(z.object({
      name: z.string(),
      kind: z.string(),
      filePath: z.string(),
      relevanceScore: z.number().min(0).max(1),
    })),
  });

  // gitnexus_context result
  const ContextResultSchema = z.object({
    symbol: z.object({
      name: z.string(),
      kind: z.string(),
      filePath: z.string(),
    }),
    incomingRefs: z.array(z.object({
      symbol: z.string(),
      relation: z.string(),
      filePath: z.string(),
    })),
    outgoingRefs: z.array(z.object({
      symbol: z.string(),
      relation: z.string(),
      filePath: z.string(),
    })),
  });

  // gitnexus_impact result
  const ImpactResultSchema = z.object({
    target: z.string(),
    risk: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    affectedSymbols: z.array(z.object({
      name: z.string(),
      depth: z.number(),
      filePath: z.string(),
    })),
  });
  ```

- **Integration points (each wired & exercised in this story):**
  - `pi install npm:pi-gitnexus-plus@0.7.0` — extension installation
  - `gitnexus analyze` — graph build from QDS-Factory source
  - `gitnexus_query` tool — semantic/keyword code search
  - `gitnexus_context` tool — 360-degree symbol view
  - `gitnexus_impact` tool — blast radius analysis
  - GitNexus CLI v1.6.3 (`/usr/local/bin/gitnexus`) — underlying indexer

- **Files / functions touched:**
  - No source files modified — this story is install + verify
  - `scripts/install-gitnexus-plus.sh` — installation and analysis script
  - `tests/gitnexus/graph-queries.test.ts` — verification test suite

- **Guards/limits:**
  - Analysis timeout: 300 seconds (large repo)
  - Query timeout: 10 seconds per query
  - Impact analysis max depth: 3
  - Graph database stored in `.gitnexus/` directory within repo
  - Extension binary size: verified < 50 MB

## Files to Modify

> ≤10 unique paths, one per line.
- `scripts/install-gitnexus-plus.sh`
- `tests/gitnexus/graph-queries.test.ts`

## Security Invariants

> Concrete named invariants only — N/A NOT permitted when triggered.

- **INV-GN1:** `gitnexus analyze` only reads source files within the repository root — no traversal above the repo boundary (verified by checking that all indexed file paths start with the repo root prefix).
- **INV-GN2:** Query input is sanitized against injection patterns — graph query strings containing shell metacharacters (`;`, `|`, `$()`, backticks) are rejected with a validation error before reaching the query engine.
- **INV-GN3:** File paths returned in query/context/impact results are validated as relative paths within the repo — absolute paths or paths containing `..` are normalized or rejected.

## Definition of Done

> 8–12 high-signal, story-specific boxes. NO lint/tests/typecheck filler.

- [ ] **Impl:** `pi install npm:pi-gitnexus-plus@0.7.0` completes successfully; extension listed in `pi extensions` output
- [ ] **Impl:** `gitnexus analyze` completes on QDS-Factory repo; `.gitnexus/` graph database created with >0 nodes
- [ ] **Impl:** `gitnexus_query` returns non-empty results for known QDS-Factory concepts (SwarmClaw, Hindsight, webhook)
- [ ] **Impl:** `gitnexus_context` returns structured symbol data with incoming/outgoing references for known functions
- [ ] **Impl:** `gitnexus_impact` returns risk assessment and affected symbols for known targets
- [ ] **Integration:** Extension registers all 14 agent tools in Pi; three core tools exercised end-to-end through Pi agent invocation
- [ ] **Security:** INV-GN1 through INV-GN3 enforced — repo boundary respected, query input sanitized, paths normalized
- [ ] **Test (unit/integration):** Query returns results for "SwarmClaw"; context returns refs for known symbol; impact returns risk level for known target; empty query returns empty array (not null/error)
- [ ] **Test (guard):** Missing extension → tool-not-found error; zero-match query → empty array; uninstalled state detected before analysis attempt
- [ ] **Test (e2e demo — MANDATORY):** Install extension → run analysis → invoke all three tools in sequence → assert non-empty structured results for each
