# Session 12 Findings — Ruflo Evaluation & Orchestrator Re-Confirmation

**Date:** 2026-04-11
**From:** Session 12 (bias-stripped re-evaluation of overstory vs ruflo as QDS Factory's agent orchestration base, prompted by discovery of ruvnet/ruflo)
**To:** Session 13 (ADR-034 + ADR-035 authoring, doc amendments, code-lift manifest updates) *(originally ADR-025 + ADR-026; renumbered — see note at Step 1)*
**Goal:** Capture the structural evidence and decision rationale so session 13 can execute without re-running the evaluation
**Durable artifacts this session produced:**
- This findings document
- `<repo-root>/memory/qds_orchestrator.md` (long-horizon memory, user-local Claude memory)
- `<repo-root>/memory/gitnexus_cypher.md` (CLI pattern memory, user-local Claude memory)
- Fresh gitnexus indexes on disk for overstory and ruflo

---

## Context — Why This Session Happened

Session 11 merged the twelve-factor alignment work. The morning of 2026-04-11 the user discovered https://github.com/ruvnet/ruflo and asked whether it could replace or absorb QDS Factory's planned orchestration layer. Ruflo turned out to be claude-flow v3.5 rebranded — the same project already referenced in the root `CLAUDE.md` for SPARC commands and MCP tools.

**First-pass analysis** (with overstory-biased ADRs as ground truth) recommended keeping overstory and lifting `@claude-flow/guidance` into Factory Core. The user pushed back correctly: *"all the ADRs and everything were tightly written around overstory being included. they're biased to ov."*

**Second-pass analysis** (this session) stripped the bias by:
1. Re-deriving QDS invariants from PRD-v2 only, classifying each as product-level / architectural / implementation-choice
2. Running 20+ Cypher queries via `npx gitnexus cypher` against KuzuDB indexes for both repos
3. Triangulating findings with direct grep + file listing + context tool
4. Adding "build from scratch" as a legitimate third option

The decision held — keep overstory, lift guidance — but the *magnitude* and *justification* changed significantly. Several of session-1's claims were wrong and are corrected below.

---

## Part A — QDS Invariants, Neutrally Re-Derived

A subagent did a clean pass through 7,416 lines of planning docs (`prd-v2.md`, `architecture-v2.md`, `architecture-v2-session10-amendments.md`, `epics-and-stories.md`) classifying every candidate requirement.

### The 10 Hard Constraints (non-negotiable, orchestrator-agnostic)

| # | Invariant | Classification | Source |
|---|---|---|---|
| 1 | Context isolation between dev and review agents (fresh context; no sunk-cost bias) | Architectural | FR10; ADR-013, ADR-002 |
| 2 | Atomic story concurrency — no cross-contamination of filesystem/state | Architectural | FR4, FR145; ADR-001, ADR-016 |
| 3 | Evidence-backed PRs (mechanical + judgment + edge-case proof) | Product | FR8, FR52, FR53; ADR-012 |
| 4 | Cost attribution chain: developer → story → phase → agent → model → provider → tokens → cost | Product | FR42; ADR-016 |
| 5 | Mechanical quality gates at phase boundaries before context wipe | Architectural | FR14, FR18; ADR-010, ADR-013 |
| 6 | Fixed story pipeline ordering (Develop → BMAD → Fix Loop → QA → PR) | Product | FR10-FR13; ADR-006 |
| 7 | Learning extraction from corrections + injection into future overlays | Product | FR164, FR165, FR167; ADR-014, ADR-015 |
| 8 | Runaway-cost circuit breakers at story and global levels | Product | FR38, FR39; ADR-016 |
| 9 | Never expose credentials in agent context, logs, PRs | Product | FR103; ADR-008 |
| 10 | Git safety (no force-push, no commits to protected branches) | Architectural | FR51; ADR-011 |

### What is NOT invariant (reclassified as implementation choice)

These were written as if architectural in several ADRs but are mechanisms — any orchestrator satisfying the 10 invariants can swap them:

- Tmux-based session management (ADR-002) — requirement is process isolation, tmux is overstory's mechanism
- Git worktrees specifically — requirement is filesystem isolation; overlay fs, containers, read-only clones would also satisfy
- 6-layer hook taxonomy (ADR-010) — the count and names are organizational, the *gated verification* is architectural
- SQLite databases (ADR-020) — requirement is single source of truth; Postgres/DuckDB acceptable
- Mail-based inter-agent coordination — requirement is async coordination; REST/queues acceptable
- TDD file-pair enforcement — requirement is development discipline; alternative gates acceptable
- 6-database ownership split (pipeline.db / attribution.db / sessions.db / mail.db / events.db / metrics.db) — organizational, not load-bearing
- Action scoring via hook heuristics (vs LLM) — driven by cost constraints, not invariant
- Daily observer + weekly optimizer pattern — one learning cadence among several viable
- Context budget 50% rule with 8K floor — conservative heuristic, could be dynamic
- ELO ratings for agent performance — one scoring system among several

**This reclassification is the single most important output of session 12.** Future architecture/ADR amendments should distinguish "the factory must" (invariant) from "overstory provides this by" (mechanism).

---

## Part B — Structural Evidence (Cypher Queries Against KuzuDB Indexes)

Full query details and one-offs are reproducible via `npx gitnexus cypher --repo <name> "<cypher>"`. Indexes live in each repo's `.gitnexus/` directory; all 7 component repos (+ ruflo) were indexed during sessions 9b and 12.

### Overstory — measured subsystem inventory

| Subsystem | src LOC | test LOC | Key functions (from graph) |
|---|---|---|---|
| commands (CLI) | 14,702 | 19,588 | `slingCommand`, `mergeCommand`, others — 46% of src |
| doctor | 2,695 | 3,709 | `checkMergeQueue`, `consistencyCheck`, ... |
| agents | 2,132 | 5,094 | `generateOverlay`, `buildCapabilityIndex`, `resolveGates`, `formatFileScope`, `formatQualityGates*`, `formatCanSpawn`, `formatMulchDomains` |
| runtimes | 1,533 | 3,145 | `getRuntime`, `PiRuntime`, `ClaudeRuntime`, `CodexRuntime`, `CopilotRuntime`, `buildEnv`, `buildPrintCommand` |
| watchdog | 1,124 | 2,576 | Tier 0/1/2/3 escalation, `evaluateHealth`, `transitionState`, `nudgeAgent` |
| merge | 954 | 1,962 | `createMergeQueue`, `tryCleanMerge`, `tryAutoResolve`, `tryAiResolve`, `tryReimagine`, `recordConflictPattern`, `queryConflictHistory`, `looksLikeProse` |
| metrics | 895 | 1,644 | `estimateCost`, `getPricingForModel`, MODEL_PRICING table, `parseTranscriptUsage`, `createMetricsStore` |
| worktree | **858** | **1,675** | `createWorktree`, `listWorktrees`, `removeWorktree`, `parseWorktreeOutput`, `preserveSeedsChanges`, `createSession`, `killSession`, `killProcessTree`, `getDescendantPids` |
| logging | 925 | 1,625 | |
| mail | 702 | 1,684 | mail.store, mail.client, mail.broadcast |
| mulch | 660 | 752 | `prime`, `appendOutcome`, `search`, `query` |
| sessions | 643 | 1,223 | session registry, `openSessionStore` |
| events | 495 | 990 | event store |
| beads | 400 | 555 | |
| tracker | 354 | 995 | |
| insights | 203 | 466 | `inferDomain`, session analysis |
| **Total src** | **~28,300** | **~46,000** | 1.6x test:src ratio — unusually high |

Graph stats (fresh index 2026-04-11): **2,019 nodes, 6,481 edges, 165 execution flows, 229 communities, 734 functions, 206 methods, 166 interfaces**.

### Ruflo — measured structural shape

- **74,020 nodes, 156,389 edges** (~30x overstory by node count)
- **3,705 files, 697 MB repo**, 3 version lineages (v2/ 146M, v3/ 34M, ruflo/ 9.7M)
- **20+ npm packages** under `v3/@claude-flow/*`: swarm, hooks, guidance, memory, neural, providers, security, aidefence, claims, browser, codex, embeddings, cli, plugins, federation, testing, performance, integration, deployment, others
- **16,318 methods, 8,743 functions, 4,691 interfaces, 1,779 classes, 2,269 communities, 300 processes**
- Contains Rust/WASM modules (ruvector/neural kernels, hyperbolic embeddings), 257 MCP Tool nodes, 131 HTTP Route nodes, 33 Module nodes (Rust)
- Top communities (by symbol count): Commands (176), Simple-commands (176), Infrastructure (72), Examples (67), Cluster_708 (53), Ruvector (51), Algorithms (38), Sdk (31), Registry (29), Config (27), Mcp (26)
- **Worktree code: 0 files, 0 functions** (verified 3 ways: gitnexus cypher on File nodes with 'worktree' path, cypher on File nodes with 'tmux' path, direct grep `git worktree` across entire repo)
- **Tmux code: 0 files**
- `PhaseId` type in `v3/@claude-flow/swarm/src/shared/types.ts` = `'phase-1-foundation' | 'phase-2-core' | 'phase-3-integration' | 'phase-4-release'` — these are ruflo's own *product roadmap phases*, not story-pipeline phases. They do not map to QDS's Develop/BMAD/Fix/QA/PR phases.

### The `@claude-flow/guidance` package — lift candidate #1

- **22,349 LOC source, 32 files** in `v3/@claude-flow/guidance/src/`
- **~19,438 LOC tests** (README claims 1,328 tests; structurally consistent)
- Key files and line counts: `compiler.ts` (532), `gates.ts` (339), `proof.ts` (369), `ledger.ts` (461), `trust.ts` (634), `retriever.ts` (482), `evolution.ts` (799), `adversarial.ts` (801), `uncertainty.ts` (855), `temporal.ts`, `meta-governance.ts`, `ruvbot-integration.ts` (1045), `wasm-kernel.ts` (205), `conformance-kit.ts`, `headless.ts` (525), plus `hooks.ts` (465 — the only external adapter)
- **External incoming edges** (via cypher `MATCH (caller)-[r:CodeRelation]->(callee) WHERE callee.filePath STARTS WITH 'v3/@claude-flow/guidance' AND NOT caller.filePath STARTS WITH 'v3/@claude-flow/guidance'`): **14 references from `v3/@claude-flow/cli/src/commands/guidance.ts`**, plus 7 in README, plus scattered test/doc references. Essentially one external consumer.
- **Outgoing edges to other ruflo packages** (reverse of above): **4 references total** — browser/2, plugins/1, hooks/1.
- **Actual npm imports** across all files: `./types.js`, internal siblings, `node:crypto`, `node:fs`, `node:fs/promises`, `node:path`, and **`@claude-flow/hooks`**. The hooks dep is **confined to `src/hooks.ts`** (465 LOC), the adapter file.

**Implication:** Guidance is architected as a near-standalone library. The extraction plan is: lift the 31 logic files (~22k LOC), write a QDS-specific adapter to replace `src/hooks.ts` that wires into whatever hook engine QDS picks. No dependency on AgentDB, ReasoningBank, HNSW, or the ruvector stack. This is the single cleanest lift candidate in ruflo.

### The `@claude-flow/hooks` package — lift candidate #2 (lower priority)

- External incoming: small (a few debug tests, guidance test)
- **Outgoing into ruflo's memory/neural stack**: `memory/hnsw-index.ts` (4 refs), `embeddings/rvf-embedding-service.ts` (3 refs), `memory/agentdb-adapter.ts` (1), `neural/reasoning-bank.ts` (1), `plugins/hooks/index.ts` (2)
- **Implication:** Lifting hooks drags the ReasoningBank stack (HNSW vector store + ONNX MiniLM-L6 embeddings + AgentDB) along with it. Much bigger bite than guidance. Probably take concepts only, build a Bun-native hook registry using overstory's `hooks-deployer.ts` as the starting point.

### Overstory primitives that map directly to QDS invariants

Confirmed by reading code and graph queries:

- **Invariant 1 (context isolation):** `src/worktree/manager.ts` + `src/worktree/tmux.ts` (858 LOC). Plus `src/runtimes/pi-guards.ts` with `NON_IMPLEMENTATION_CAPABILITIES = {scout, reviewer, lead, coordinator, supervisor, monitor}` — these agent roles are blocked from modifying project files at the Pi SDK runtime layer. Invariant 1 is operationalized today.
- **Invariant 2 (atomic concurrency):** `src/commands/sling.ts` contains `checkTaskLock`, `checkDuplicateLead`, `checkRunSessionLimit`, `checkParentAgentLimit`, `validateHierarchy`, `parentHasScouts`. Plus the merge queue with SQLite FIFO.
- **Invariant 4 (cost attribution — partial):** `src/metrics/pricing.ts` has `getPricingForModel`, `estimateCost`, MODEL_PRICING table with opus/sonnet/haiku/codex tiers. `src/metrics/store.ts` has per-session per-run token storage with migrations for `beadIdToTaskId`, `runIdColumn`, `tokenColumns`. Factory Core extends this to add the full `dev→story→phase→agent→model→provider→tokens→cost` chain — not a rewrite.
- **Invariant 5 (phase-boundary gates):** `src/agents/hooks-deployer.ts` + `src/agents/overlay.ts` format file scope, quality gates (inline/steps/bash/capabilities), constraints, canSpawn, mulch domains into the agent overlay. Overstory *generates* the hook scripts that enforce gates at edit/task boundaries.
- **Invariant 7 (learning loop):** `src/insights/analyzer.ts` extracts `ToolProfile`, `FileProfile`, `ToolStats`, errors from event store → mulch client records via `appendOutcome` → next session primes via `mulch prime --domains`. `inferDomain()` maps file paths to codebase-specific domains (`src/mail/` → messaging, `src/commands/` → cli, etc.) — domain-aware, not just pattern-matching.
- **Invariant 9 (credential isolation — partial):** Runtime registry at `src/runtimes/registry.ts` with `getRuntime(name, config)` abstraction. Pi-guards enforce per-role file-modification rules. ADR-008's `getApiKey` callback pattern is not yet wired here — that's still work, but the runtime abstraction exists.
- **Invariant 10 (git safety):** Merge queue is additive (SQLite FIFO enqueue/dequeue). `src/commands/merge.ts` wraps `git merge` via shell with dry-run support. No force-push paths found in grep.

### The sling command — load-bearing evidence

`ov sling` internal functions (from graph): `makeSession`, `makeAgentSession`, `makeBeaconOpts`, `makeTaskSession`, `makeLeadSession`, `makeConfig`, `makeManifest`, `makeAutoDispatchOpts`, `calculateStaggerDelay`, `inferDomainsFromFiles`, `buildAutoDispatch`, `buildBeacon`, `parentHasScouts`, `shouldShowScoutWarning`, `checkTaskLock`, `checkDuplicateLead`, `checkRunSessionLimit`, `checkParentAgentLimit`, `validateHierarchy`, `extractMulchRecordIds`, `slingCommand`.

Top outgoing call targets: `agents/manifest.ts` (12), `runtimes/claude.ts` (9), `types.ts` (7), `runtimes/types.ts` (6), `worktree/tmux.ts` (6), `runtimes/codex.ts` (5), `runtimes/pi.ts` (5), `errors.ts` (5), `tracker/factory.ts` (4), `agents/overlay.ts` (4), `config.ts` (4), `runtimes/registry.ts` (4), `runtimes/copilot.ts` (4), `sessions/store.ts` (3), `agents/identity.ts` (3), `mulch/client.ts` (3), `mail/store.ts` (3), `mail/client.ts` (3).

This is the factory's front door already wired. A QDS Factory Core pipeline can invoke `ov sling --name <agent> --capability <role> --task <story-phase>` as the per-phase spawn call and get most of the invariants for free.

---

## Part C — Rubric Scores (135 points total)

Weights derived from invariant criticality. Non-negotiable invariants (1, 2, 9, 10) weighted heavily.

| Dimension | Weight | Overstory | Ruflo | Build Fresh |
|---|---|---|---|---|
| Inv 1 — Context isolation | 15 | 13 | 3 | 0 |
| Inv 2 — Atomic concurrency | 12 | 11 | 6 | 0 |
| Inv 3 — Evidence-backed PRs | 10 | 5 | 2 | 0 |
| Inv 4 — Cost attribution | 10 | 6 | 4 | 0 |
| Inv 5 — Phase-boundary gates | 10 | 6 | 8 | 0 |
| Inv 6 — Fixed pipeline | 10 | 4 | 3 | 0 |
| Inv 7 — Learning loop | 8 | 7 | 6 | 0 |
| Inv 8 — Cost circuit breakers | 8 | 4 | 3 | 0 |
| Inv 9 — Credential isolation | 8 | 7 | 3 | 0 |
| Inv 10 — Git safety | 8 | 7 | 5 | 0 |
| Enforcement layer (bonus) | 6 | 2 | 6 | 0 |
| Code scale to maintain | 5 | 5 | 1 | 3 |
| Upstream drift risk | 5 | 3 | 2 | 5 |
| Team cognitive load | 5 | 5 | 1 | 2 |
| Time-to-first-PR | 5 | 5 | 1 | 0 |
| **Total / 135** | | **90 (67%)** | **54 (40%)** | **10 (7%)** |

Overstory wins on 9 of 10 invariants. Ruflo wins decisively on enforcement-layer maturity. Fresh build is disqualified on time-to-first-PR and scale-of-rewrite.

---

## Part D — Decision

**Keep overstory as QDS Factory's agent orchestration base.**

**Lift `@claude-flow/guidance` (~22k LOC + ~19k test LOC, 32 files) into Factory Core as the enforcement layer.** Replace the single `src/hooks.ts` adapter (465 LOC) with a QDS-specific adapter that wires into overstory's `hooks-deployer.ts`.

**Do not adopt ruflo as base.** Structural reasons: no worktree primitive, no tmux code, `PhaseId` is project roadmap phases not pipeline phases, 697M code scale is 25x the QDS planning target (~6,470 LOC for 64 stories), 20-package monorepo conflicts with QDS ADRs at multiple points.

**Do not adopt `@claude-flow/hooks` wholesale.** It drags the ReasoningBank/HNSW/AgentDB/ONNX stack. Cherry-pick concepts only; build the QDS hook registry on overstory's `hooks-deployer.ts` foundation.

---

## Part E — Corrections to Prior Analysis

First-pass (same-session) analysis made three errors corrected here:

1. **Claimed overstory has no cost tracking.** Wrong. `src/metrics/pricing.ts` (135 LOC) and `src/metrics/store.ts` (466 LOC) implement runtime-agnostic pricing with per-session per-run token storage. Factory Core extends this to add full attribution chain; it does not build from scratch.

2. **Overstated ruflo's self-learning advantage.** Ruflo's ReasoningBank (HNSW + ONNX embeddings) is more sophisticated per se, but it learns *general patterns*. Overstory's insights → mulch → prime loop is *domain-aware for the target codebase* via `inferDomain()`. For a factory that learns about *this specific repo*, overstory's approach is closer to the requirement.

3. **Suggested ruflo's `PhaseId` might map to QDS phases.** Wrong direction. Ruflo phases are its own development milestones (`phase-1-foundation`, `phase-2-core`...), not story-pipeline phases. Orthogonal concepts sharing a word.

---

## Part F — Five Concrete Next Steps (for Session 13)

All five are gated on the decision above. Execute in order unless blocking issues arise.

> **Historical numbering note:** Steps 1–3 below were originally written during session 12 using ADR-024/025/026. These were renumbered in session 13 to avoid collision with PR #5 (session 12 gap-analysis amendments): **ADR-024 → ADR-033**, **ADR-025 → ADR-034**, **ADR-026 → ADR-035**. The headings and body below now use the final ADR-033/034/035 identifiers as primary labels, with old IDs retained parenthetically for traceability. See `architecture-v2-session12-amendments.md` "Note on ADR Numbering" for the full renumbering history.

### Step 1 — Close the orchestrator question with ADR-033 (formerly ADR-024)

**Deliverable:** New ADR entry in `_bmad-output/planning-artifacts/architecture-v2-session10-amendments.md` (or new session12-amendments file) recording:
- Decision: overstory retained as orchestration base
- Method: bias-stripped re-evaluation via structural graph queries
- Evidence: reference this findings document
- Rationale: 9-of-10 invariants, 90/135 rubric vs ruflo's 54/135
- Scope closure: future "should we swap orchestrator?" questions reference this ADR and this session's findings doc

**Acceptance:** `architecture-v2.md` index section lists the new ADR, and `prd-v2.md` / `architecture-v2.md` have no unresolved ambiguity about orchestrator identity.

### Step 2 — Author ADR-034: Lift `@claude-flow/guidance` into Factory Core (formerly ADR-025)

**Deliverable:** Full ADR in the session12-amendments file covering:
- Context: enforcement stack design (Superpowers = skill content; guidance = mechanical enforcement)
- Decision: lift ~22k LOC of compiler/gates/proof/ledger/trust/retriever/evolution/adversarial from `v3/@claude-flow/guidance/src/`
- Scope decisions to make:
  - (a) Full lift vs concept-only lift (recommendation: full lift of 8 files: compiler, gates, proof, ledger, trust, retriever, continue-gate, memory-gate; spike first on 3-4 files)
  - (b) Keep or drop `wasm-kernel.ts` (205 LOC, WASM hot path — probably drop for MVP)
  - (c) Keep or drop `evolution.ts` + `optimizer.ts` (rule A/B benchmarking with Pearson/Spearman — premature for MVP; defer)
  - (d) Keep or drop `adversarial.ts` (801 LOC, prompt-injection defense — probably yes, it's small and self-contained)
  - (e) Keep or drop `trust.ts` (634 LOC, per-agent trust tiers — valuable but adds state complexity; decide after spike)
  - (f) Keep or drop `temporal.ts` + `uncertainty.ts` (long-horizon modeling — defer unless MVP demonstrates need)
- Adapter replacement: `src/hooks.ts` (465 LOC) gets replaced with a QDS-specific file that wires into overstory's `hooks-deployer.ts` and Factory Core's pipeline engine
- Dependency tree: confirmed zero runtime deps on `@claude-flow/hooks` (registry types), `@claude-flow/memory`, `@claude-flow/neural`, `@claude-flow/embeddings`, `@claude-flow/aidefence`. Only node: built-ins + internal siblings.
- Test strategy: lift test files alongside source; adapt suite to vitest or bun test (overstory uses bun test; guidance uses vitest per ruflo package.json)
- License check: ruflo is MIT; confirm and vendor LICENSE text alongside lifted files
- Fork hygiene: tag `// QDS:` on any edits; prefer additive changes; maintain an upstream-tracking checklist

**Acceptance:** ADR-034 merged into amendments file with a spike story added to `epics-and-stories.md` (new Story 1.9 or similar: "Spike: evaluate guidance compiler+gates+proof extraction"). *(Originally referenced as ADR-025.)*

### Step 3 — Author ADR-035: Hook Engine Strategy (formerly ADR-026)

**Deliverable:** ADR covering:
- Context: invariant 5 (phase-boundary gates) needs a hook registry + executor beyond what overstory's `hooks-deployer.ts` provides (which generates Claude Code / Pi guard scripts but doesn't itself enforce runtime rules)
- Decision: extend overstory's `hooks-deployer.ts` pattern rather than lifting `@claude-flow/hooks` wholesale
- Rationale: `@claude-flow/hooks` drags ReasoningBank/HNSW/AgentDB/ONNX stack (verified via cypher); concepts can be borrowed without the stack
- Concepts worth borrowing (from ruflo's hooks README + source): hook registry with priority-based registration, hook executor with timeout+error recovery, pre/post-edit and pre/post-task and session-boundary events, hook result aggregation, statusline integration (if dashboard wants it)
- Build target: `factory-core/src/hooks/` with typed events, priority-based registration, and a bridge into overstory's `hooks-deployer.ts` for Claude Code / Pi runtime gate generation

**Acceptance:** ADR-035 merged. No new story yet — this ADR sets direction; implementation lives inside the existing Factory Core hook enforcement stories. *(Originally referenced as ADR-026.)*

### Step 4 — Update `code-lift-manifest.md` and `code-lift-gap-analysis.md`

**Deliverable:** Additions to both files:

In `_bmad-output/implementation-artifacts/code-lift-manifest.md`:
- Add a new section "Ruflo — `@claude-flow/guidance` Extraction"
  - Source path: `_research-repos/ruflo/v3/@claude-flow/guidance/src/`
  - Target path: `factory-core/src/guidance/` (or similar)
  - LOC to lift: ~22,349 src + ~19,438 tests
  - Files to lift (tier 1): `compiler.ts`, `gates.ts`, `proof.ts`, `ledger.ts`, `retriever.ts`, `trust.ts`, `continue-gate.ts`, `memory-gate.ts`, `types.ts`, `crypto-utils.ts`, `authority.ts`, `capabilities.ts`, `coherence.ts`, `conformance-kit.ts`, `manifest-validator.ts`, `generators.ts`, `persistence.ts`, `artifacts.ts`, `analyzer.ts`, `truth-anchors.ts`, `gateway.ts`, `headless.ts`, `index.ts`
  - Files to evaluate in spike (tier 2): `trust.ts` (keep decision pending), `adversarial.ts` (likely keep), `evolution.ts` + `optimizer.ts` (likely defer), `temporal.ts` + `uncertainty.ts` (likely defer), `meta-governance.ts`, `hooks.ts` (replace)
  - Files to drop: `wasm-kernel.ts` (WASM hot path; defer until proven bottleneck), `ruvbot-integration.ts` (ruflo-specific bot wiring)
  - Adapter work: ~500 LOC to replace `hooks.ts`
  - Dependency risk: LOW — only `@claude-flow/hooks` import, confined to one file, replaceable

In `_bmad-output/implementation-artifacts/code-lift-gap-analysis.md`:
- Add risk entry: "Guidance lift — license compliance (MIT, compatible) / upstream drift (ruflo active @ 6,000+ commits, monitor @claude-flow/guidance changelog quarterly)"
- Add risk entry: "Ruflo evaluation re-litigation — mitigated by session12 findings doc + ADR-033" *(formerly ADR-024)*

**Acceptance:** Both files updated; diff reviewed; no story count changes in `epics-and-stories.md` (spike adds Story 1.9 only).

### Step 5 — Correct invariant/mechanism conflation in architecture-v2

**Deliverable:** Pass through `_bmad-output/planning-artifacts/architecture-v2.md` (3,463 lines) flagging every place that presents a mechanism (tmux, git worktree, 6-layer hooks, mail.db, SQLite specifically, 6-db split) as an architectural invariant. For each flagged instance, either:
- **Annotate in place:** "Mechanism (not invariant): see session12 findings Part A for the bias-stripped invariant." + keep the text
- **Rewrite to separate invariant from mechanism:** e.g., *"The factory must isolate agent filesystems (architectural invariant 2). Overstory implements this via `git worktree add` per story; Factory Core assumes this primitive is available from the orchestration layer."*

**Scope limit:** Only touch places where the conflation creates decision ambiguity. Don't rewrite the whole document — this is a targeted correction pass.

**Acceptance:** The next person who re-opens "should we swap orchestrator?" can distinguish invariant from mechanism from the doc alone without needing to re-read session 12.

---

## Part G — Artifacts to Reference (Cold-Start Reading List)

In order:

1. **This document** (`session12-ruflo-evaluation-findings.md`) — the analytical core
2. **`<repo-root>/memory/qds_orchestrator.md`** — persisted long-horizon memory, for future sessions that might re-open this (user-local Claude memory)
3. **`<repo-root>/memory/gitnexus_cypher.md`** — CLI pattern for querying KuzuDB indexes directly when MCP server isn't attached (user-local Claude memory)
4. `_bmad-output/planning-artifacts/prd-v2.md` — the actual product requirements (invariant source)
5. `_bmad-output/planning-artifacts/architecture-v2.md` — the architecture (biased; read critically)
6. `_bmad-output/planning-artifacts/architecture-v2-session10-amendments.md` — recent ADR amendments (session 10's scope)
7. `_bmad-output/implementation-artifacts/code-lift-manifest.md` — per-repo extraction plans (session 9b work)
8. `_bmad-output/implementation-artifacts/code-lift-gap-analysis.md` — risk register (session 9b work)
9. `_research-repos/ruflo/v3/@claude-flow/guidance/src/` — the lift target source code
10. `overstory/src/` — the orchestration base source code

---

## Part H — Operational Environment Facts

For session 13 to execute without friction:

- **Gitnexus MCP server is NOT attached** to the user's Claude Code config (checked `~/.claude/mcp-config.json` — only `archon` is registered). Use the CLI instead: `npx gitnexus cypher --repo <name> "<query>"`. See the memory file for gotchas (avoid MERGE/CREATE/DELETE keywords even in string literals).
- **Indexes on disk:** all 7 component repos + ruflo. Ruflo indexed 2026-04-11 07:44 (74,020 nodes). Overstory re-indexed 2026-04-11 (2,019 nodes).
- **Repo paths:**
  - Overstory: `<repo-root>/overstory/` (fork of jayminwest/overstory)
  - Ruflo: `<repo-root>/_research-repos/ruflo/` (clone of ruvnet/ruflo)
  - Guidance source: `<repo-root>/_research-repos/ruflo/v3/@claude-flow/guidance/src/`
- **Git branch conventions:** main is protected; session work branches follow `session<N>/<description>` pattern
- **Commit style:** `Fix PR review round N: <summary>\n\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`
- **No destructive git ops without explicit user approval.**

---

## Part I — Open Questions for Session 13 Start

Not blockers — but worth naming so they don't get skipped:

1. **ADR numbering:** Session 10 went to ADR-023 or ADR-024 (check the amendments file). Session 12's new ADRs should be ADR-024 (orchestrator re-confirmation), ADR-025 (guidance lift), ADR-026 (hook engine strategy). Verify numbering collision before writing. *(Resolved in session 13: renumbered to ADR-033/034/035 after discovering PR #5 collision. See `architecture-v2-session12-amendments.md` "Note on ADR Numbering".)*
2. **Story 1.9 shape:** Session 12 proposes a new spike story for the guidance lift evaluation. Should it be a spike (investigation-only, no code) or a spike + implementation combined (learn by doing)? Session 13 should decide before writing.
3. **License vendoring:** Ruflo is MIT. Confirm vendoring policy in `factory-core/` — does QDS vendor LICENSE text inline, or maintain a `THIRD_PARTY_LICENSES.md` manifest?
4. **Test framework adaptation:** guidance uses vitest, overstory uses `bun test`. Factory Core should pick one; session 13 decides.
5. **Fork hygiene for lifted code:** how is `// QDS:` tagging enforced? Session 13 should check existing overstory fork pattern and apply consistently.

---

**End of session 12 findings. Session 13 starts fresh from Part F and executes steps 1-5 in order.**
