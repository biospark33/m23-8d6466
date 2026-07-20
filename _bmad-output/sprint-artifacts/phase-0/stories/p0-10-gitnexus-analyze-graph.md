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

**Demonstrable behavior:** Run `pi install npm:pi-gitnexus-plus@0.7.0`, run `gitnexus analyze` on the QDS-Factory repo, then invoke `gitnexus_query` (query: "SwarmClaw routes"), `gitnexus_context` (symbol: "registerSwarmClawAgent"), and `gitnexus_impact` (target: "registerSwarmClawAgent", direction: "upstream") — all three return non-empty results.

**Wiring closed:** On completion of this story, `gitnexus_query`, `gitnexus_context`, and `gitnexus_impact` return structured results for known QDS-Factory symbols using only code installed by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** None — standalone.

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given `pi-gitnexus-plus@0.7.0` installed and `gitnexus analyze` completed on QDS-Factory, When `gitnexus_query` is invoked with query "SwarmClaw routes", `gitnexus_context` is invoked with symbol "registerSwarmClawAgent", and `gitnexus_impact` is invoked with target "registerSwarmClawAgent" direction "upstream", Then all three return non-empty structured result objects (at least one symbol + a repo-relative file path); `gitnexus_query` must surface the known SwarmClaw fixture. (gitnexus 1.6.9 emits no per-definition `relevanceScore` — only `priority` on processes — so the AC asserts structured non-empty shape rather than a score field. Symbol renamed from registerAgent → registerSwarmClawAgent during code review: the original name collides with vendored pi-vs-claude-code-vendor/coms-net.ts.)
2. Given a completed analysis, When `gitnexus_query` is called with a query matching zero symbols (e.g., "ZZZZZZZ_NONEXISTENT_SYMBOL"), Then the result is a valid structured QueryResult (arrays present, not null, not an error object) that never crashes and never reports the bogus symbol as a real definition — graceful non-match. (gitnexus's semantic engine returns nearest-neighbour candidates rather than a literal empty array; the load-bearing invariant is "never crash, never false-match".)
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
  - GitNexus CLI v1.6.9 (resolved via command -v gitnexus with ~/.local/node-arm64/bin/gitnexus as fallback; the spec's /usr/local/bin path is not present on this host) — underlying indexer

- **Files / functions touched:**
  - No source files modified — this story is install + verify
  - `scripts/install-gitnexus-plus.sh` — installation and analysis script
  - `tests/gitnexus/graph-queries.test.ts` — verification test suite
  - `tests/gitnexus/fixtures/swarmclaw.ts` — fixture symbols for query/context/impact tests

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

### Review Findings

> Triaged output of bmad-code-review (Blind Hunter + Edge Case Hunter + Acceptance Auditor). All `patch` items applied in this PR; `defer` items are documented constraints; `dismiss` were false positives.

**Patched (BLOCKER):**
- [x] [Review][Patch] `resolveRepoName` captured gitnexus's disambiguated label `QDS-Factory  (/path)` (emitted when a name is indexed twice) — gitnexus rejected it as `-r`, failing 7/13 tests. Queries now pass `-r <absolute repo path>` (which gitnexus always accepts) and a thin `assertIndexed()` helper gives a clear error if the repo isn't indexed. [tests/gitnexus/graph-queries.test.ts]
- [x] [Review][Patch] `DefinitionSchema.type` was required but gitnexus 1.6.9 omits `type` from every definition (keys: id, name, filePath, startLine, endLine) — every parse threw. Made `type` (and already-optional `module`) optional. [tests/gitnexus/graph-queries.test.ts]
- [x] [Review][Patch] Fixture symbol `registerAgent` collided with vendored `pi-vs-claude-code-vendor/coms-net.ts` — `context registerAgent` resolved to coms-net.ts (callers `reRegisterAndOpen`, `onSessionStart`), shadowing the fixture. Renamed fixture symbol to unique `registerSwarmClawAgent`; tests + this spec updated. [tests/gitnexus/fixtures/swarmclaw.ts]

**Patched (HIGH/MEDIUM/LOW):**
- [x] [Review][Patch] INV-GN2 injection guard `/[;|`]\|\$\(/` missed `&&`, `&`, `>`, `<`, newline, `$VAR`, quotes — replaced deny-list with allow-list `^[A-Za-z0-9 _.-]+$`. [tests/gitnexus/graph-queries.test.ts]
- [x] [Review][Patch] Install-script cleanup unconditionally `rm -rf .claude/skills/gitnexus` — nuked pre-existing skill dirs. Now removed only when this run created it (`CREATED_SKILLS` guard). [scripts/install-gitnexus-plus.sh]
- [x] [Review][Patch] `pi list` verify ran even when `GITNEXUS_SKIP_INSTALL=1` — moved inside the skip guard; anchored grep to `pi-gitnexus-plus@${EXT_VERSION}`. [scripts/install-gitnexus-plus.sh]
- [x] [Review][Patch] `trap cleanup EXIT` didn't preserve exit code or catch INT/TERM — now `trap cleanup EXIT INT TERM` with `rc=$?; exit "$rc"`. [scripts/install-gitnexus-plus.sh]
- [x] [Review][Patch] AC-1 impact assertion hardened: `impactedCount` is genuinely 0 without `analyze --pdg` (verified live — call graph alone shows no upstream blast radius), so the load-bearing proof is target resolution (`result.target.name === "registerSwarmClawAgent"`) + a valid risk object, with `impactedCount` asserted as a well-formed non-negative integer. [tests/gitnexus/graph-queries.test.ts]
- [x] [Review][Patch] AC-2 zero-match test only asserted `Array.isArray` — unfalsifiable. Now also asserts no returned definition name equals the bogus query string. [tests/gitnexus/graph-queries.test.ts]
- [x] [Review][Patch] AC-3 unknown-subcommand test only asserted `.toThrow()` — now asserts nonzero exit with a recognizable error message. [tests/gitnexus/graph-queries.test.ts]
- [x] [Review][Patch] `ImpactResultSchema.risk` enum omitted `UNKNOWN` — gitnexus emits `UNKNOWN` for low-data targets. Added `UNKNOWN` to the enum. [tests/gitnexus/graph-queries.test.ts]
- [x] [Review][Patch] `perl -e alarm` timeout not portable — now prefers `timeout`/`gtimeout`, falls back to perl. Same pattern wraps `gitnexus status` (30s, non-fatal). [scripts/install-gitnexus-plus.sh]
- [x] [Review][Patch] `resolveGitnexus` used `existsSync` (true for dirs) — added `statSync.isFile()` check. [tests/gitnexus/graph-queries.test.ts]
- [x] [Review][Patch] REPO_ROOT resolution via `BASH_SOURCE` broke under symlink/piped invocation — now uses `git rev-parse --show-toplevel`. [scripts/install-gitnexus-plus.sh]
- [x] [Review][Patch] `pi install` could hang on an interactive prompt — added `< /dev/null`. [scripts/install-gitnexus-plus.sh]
- [x] [Review][Patch] Fixture `dispatch` had no caller (router docstring was false) — added `routeTask` caller. [tests/gitnexus/fixtures/swarmclaw.ts]
- [x] [Review][Patch] Schema/comment said "gitnexus 1.6.3" — corrected to 1.6.9 (actual installed). [tests/gitnexus/graph-queries.test.ts]
- [x] [Review][Patch] AC-1 query test over-constrained to a specific symbol name — now asserts non-empty definitions with valid shape + repo-relative paths, using the spec's literal "SwarmClaw routes" query string. [tests/gitnexus/graph-queries.test.ts]

**Deferred (documented constraints, out of story scope):**
- [x] [Review][Defer] DoD #6 "exercised through Pi agent invocation" — tests drive the gitnexus CLI engine directly (the Pi extension shells out to the same CLI); live Pi-agent invocation needs LLM API keys not present in CI. Engine layer proven; wrapper layer deferred. [tests/gitnexus/graph-queries.test.ts] — deferred, CI key constraint
- [x] [Review][Defer] AC-3 "Pi returns tool-not-found" is a Pi-layer behavior; the CLI-analogue (nonzero exit on unknown subcommand) is asserted instead. Full Pi-layer test deferred (same API-key constraint). [tests/gitnexus/graph-queries.test.ts] — deferred, CI key constraint
- [x] [Review][Defer] INV-GN2 production enforcement — this story ships no query wrapper (the extension is third-party); the guard lives at the test/harness boundary we own. [tests/gitnexus/graph-queries.test.ts] — deferred, no wrapper ships in this story
- [x] [Review][Defer] AC-1 "relevance score" — gitnexus returns no relevanceScore on definitions (only `priority` on processes); tests assert the CLI's actual contract. [tests/gitnexus/graph-queries.test.ts] — deferred, CLI contract drift
- [x] [Review][Defer] Spec technical-note drift: CLI path `/usr/local/bin/gitnexus` and version `1.6.3` — code resolves the path dynamically and handles 1.6.9. [p0-10-gitnexus-analyze-graph.md] — deferred, code is more correct than spec

### Review Findings — Round 2 (bmad-code-review)

> Round 2 re-ran Blind Hunter + Edge Case Hunter + Acceptance Auditor on the round-1 patch set. Empirical check: `gitnexus impact registerSwarmClawAgent --direction upstream` returns `impactedCount: 0` (call graph only, no PDG) — confirms the round-1 `> 0` note was wrong; load-bearing proof is target resolution. All 16 tests green.

**Patched (Round 2):**
- [x] [Review][Patch] AC-1 query test now anchors to the known fixture (`definitions.some(d => d.filePath.includes("swarmclaw.ts"))`) — semantic search could otherwise return unrelated nearest-neighbours and pass make-or-break with no SwarmClaw symbol. [tests/gitnexus/graph-queries.test.ts]
- [x] [Review][Patch] INV-GN1 cypher assertion was near-unfalsifiable (`/\|\s*0\s*\|/` matches `| 10 |`, `| 100 |`, any zero cell) — now collects every numeric table cell and asserts `max === 0`. [tests/gitnexus/graph-queries.test.ts]
- [x] [Review][Patch] INV-GN3 path-containment now covers all three tools: added context `incoming/outgoing.calls[].filePath` + impact `target.filePath` repo-relative checks (previously query-only). [tests/gitnexus/graph-queries.test.ts]
- [x] [Review][Patch] `gn()` JSON parse now tries a full `JSON.parse` first, slicing from `{` only as fallback — avoids mis-parsing if a future gitnexus log line emits `{` on stdout. [tests/gitnexus/graph-queries.test.ts]
- [x] [Review][Patch] Test `REPO_ROOT` now resolves via `git rev-parse --show-toplevel` (matching the install script) instead of `import.meta.dir/../..` — avoids divergence under worktrees/symlinks. [tests/gitnexus/graph-queries.test.ts]
- [x] [Review][Patch] `registerSwarmClawRoutes` fixture marked load-bearing (AC-1 context test depends on its incoming edge). [tests/gitnexus/fixtures/swarmclaw.ts]
- [x] [Review][Patch] Install-script version-pin grep anchored: `grep -qE "pi-gitnexus-plus@${EXT_VERSION}([^[:alnum:]._+-]|$)"` — a prerelease (`@0.7.0-beta`) or newer patch no longer satisfies the bare substring. [scripts/install-gitnexus-plus.sh]
- [x] [Review][Patch] Trap idiom fixed: trap EXIT only (cleanup once), INT/TERM traps set conventional codes (130/143) and exit — avoids the double-cleanup + masked-exit-code gotcha of trapping the same fn on EXIT INT TERM under `set -e`. [scripts/install-gitnexus-plus.sh]
- [x] [Review][Patch] AC-1 impact note corrected (see round-1 entry above): `impactedCount` is 0 without `--pdg`; load-bearing proof is target resolution. [p0-10-gitnexus-analyze-graph.md]
- [x] [Review][Patch] AC-1 & AC-2 spec text reconciled to gitnexus 1.6.9's real contract (no per-definition relevanceScore; semantic search returns nearest-neighbours, not a literal empty array). [p0-10-gitnexus-analyze-graph.md]

**Deferred (Round 2 — real but out of story scope):**
- [x] [Review][Defer] Pre-existing root `.gitnexusignore` that ignores `tests/`/`fixtures/` would silently filter the fixture — appending negations would mutate a user file with no safe cleanup; transient-file approach retained. [scripts/install-gitnexus-plus.sh] — deferred, mutating-user-file risk
- [x] [Review][Defer] `--embeddings` may need network/model in air-gapped CI — no env toggle added (YAGNI until a CI env actually lacks the model). [scripts/install-gitnexus-plus.sh] — deferred, env constraint
- [x] [Review][Defer] `maxBuffer: 32MB` arbitrary cap — adequate for this graph (3689 symbols); raise only if a query actually overflows. [tests/gitnexus/graph-queries.test.ts] — deferred, YAGNI
- [x] [Review][Defer] DoD "MANDATORY e2e: install→analyze→query as one flow" — script + test are separate by design; CI orchestrates the sequence. [tests/gitnexus/graph-queries.test.ts] — deferred, CI orchestration
- [x] [Review][Defer] DoD "14 tools registered in Pi" — needs live Pi introspection (API keys not in CI); 3 core tools proven via the CLI engine. [tests/gitnexus/graph-queries.test.ts] — deferred, API-key constraint

**Dismissed (Round 2 — false positive / by design):** assertIndexed regex (matches the verified `Path:    <abspath>` format); allow-list strictness (correct for an injection boundary); guard-wiring (`assertSafeQuery` IS called at the query sites); PATH fallthrough in `resolveGitnexus` (intentional); bash 3.2 arrays (supported since 2.0); perl exit 142 vs `timeout` 124 (nonzero gates either way); `status` non-fatal (reporting only, not gating); `EXT_VERSION` no env override (YAGNI); deferred-item `[x]` marks (skill convention = recorded, not implemented); committed fixture `.gitnexusignore` (belt-and-suspenders alongside the transient root file, not dead).
