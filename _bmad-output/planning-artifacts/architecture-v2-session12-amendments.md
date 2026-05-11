# Architecture v2.0 — Session 12 Amendments

**Date:** 2026-04-11
**Scope:** ADR-033 (orchestrator re-confirmation), ADR-034 (guidance lift), ADR-035 (hook engine strategy)
**Applies to:** `_bmad-output/planning-artifacts/architecture-v2.md` v2.0, `_bmad-output/planning-artifacts/architecture-v2-session10-amendments.md`, `_bmad-output/planning-artifacts/architecture-v2-session11-twelve-factor.md`, `_bmad-output/implementation-artifacts/epics-and-stories.md`
**Methodology:** Bias-stripped structural re-evaluation via KuzuDB graph queries (`npx gitnexus cypher`) against fresh indexes of overstory and ruflo, triangulated with direct file reads and grep validation.
**Evidence base:** `_bmad-output/planning-artifacts/session12-ruflo-evaluation-findings.md` (the analytical core document from session 12), this amendments file (session 13 formalization).

---

## Note on ADR Numbering

The session 12 findings document (`session12-ruflo-evaluation-findings.md`, Part F) proposed ADR numbers **024, 025, 026** for the three decisions in this file. Those proposed numbers were **stale at the time of authoring** — session 11's twelve-factor work had already claimed ADR-024 (ten-section ADR landed in `architecture-v2-session11-twelve-factor.md`, scope ACCEPTED on 2026-03-15, approximately four weeks prior to session 12).

Session 13 renumbered the three new ADRs twice:

**First renumbering (session 13, pre-rebase):** Shifted from findings-doc proposals to avoid collision with session 11's ADR-024:

| Findings doc proposal | First renumber | Topic |
|---|---|---|
| ADR-024 | ADR-025 | Orchestrator re-confirmation (keep overstory) |
| ADR-025 | ADR-026 | `@claude-flow/guidance` lift into Factory Core |
| ADR-026 | ADR-027 | Hook engine strategy (extend `hooks-deployer.ts`, do not lift `@claude-flow/hooks`) |

**Second renumbering (session 13, rebase onto origin/main):** PR #5 (`session12/architecture-gap-analysis-amendments` by Michael Crandall, merged 2026-03-15) claimed ADR-025 through ADR-032 in `architecture-v2-session12-gap-analysis-amendments.md`. Shifted again to avoid collision:

| First renumber | Final number | Topic |
|---|---|---|
| ADR-025 | **ADR-033** | Orchestrator re-confirmation (keep overstory) |
| ADR-026 | **ADR-034** | `@claude-flow/guidance` lift into Factory Core |
| ADR-027 | **ADR-035** | Hook engine strategy (dual-plane: overstory edge + Factory Core in-process; do not lift `@claude-flow/hooks`) |

All cross-references in this file, downstream amendments, and artifact updates use the **final numbers** (ADR-033/034/035). The findings document retains its original proposed numbers (024/025/026) as a historical artifact; it is not retroactively edited. The gap-analysis amendments file retains ADR-025 through ADR-032 as Michael's session 12 work; there is no numbering conflict between the two session-12-era amendment files.

---

## ADR-033: Orchestrator Re-Confirmation — Overstory Retained as QDS Factory's Agent Orchestration Base

**Status:** ACCEPTED — scope-closed (see "Re-Opening Criteria" below)

**Date:** 2026-04-11 (decision), 2026-04-11 (formalization)

**Deciders:** Steve (user), session 12 analysis, session 13 authorship

**Context:**

On the morning of 2026-04-11, the user discovered [`ruvnet/ruflo`](https://github.com/ruvnet/ruflo) and asked whether it could replace or absorb QDS Factory's planned agent orchestration layer. Ruflo was quickly confirmed to be [`ruvnet/claude-flow`](https://github.com/ruvnet/claude-flow) v3.5 rebranded — the same project already referenced in the root `CLAUDE.md` for SPARC commands and MCP tools.

A first-pass same-session analysis recommended keeping overstory and lifting `@claude-flow/guidance` into Factory Core. The user correctly pushed back: *"all the ADRs and everything were tightly written around overstory being included. they're biased to ov."*

This observation revealed a deeper problem. Many prior ADRs (ADR-001 through ADR-023) had conflated two different categories of requirement:

1. **Product-level invariants** — things the factory *must* do (context isolation, cost attribution, credential safety)
2. **Architectural invariants** — abstract shapes the factory *must* have (filesystem isolation per story, mechanical gates at phase boundaries)
3. **Implementation-choice mechanisms** — how overstory *happens to* satisfy those invariants (tmux, git worktrees, SQLite, mail.db, 6-layer hook taxonomy, 6-database split)

Category 3 items were written into ADRs as if they were category 1 or 2. This made the decision to use overstory look architecturally load-bearing when it was actually a mechanism choice among several viable alternatives.

**Session 12 conducted a bias-stripped re-evaluation** to answer the orchestrator question neutrally:

1. Re-derive QDS invariants from PRD-v2 alone (not from ADRs), classifying each as product-level / architectural / implementation-choice
2. Run 20+ Cypher queries via `npx gitnexus cypher` against fresh KuzuDB indexes of overstory and ruflo
3. Triangulate structural findings with direct grep and file reads
4. Include "build orchestration from scratch" as a legitimate third option
5. Score each candidate against a 135-point rubric weighted by invariant criticality

The evaluation is captured in full in `session12-ruflo-evaluation-findings.md`. This ADR formalizes the decision, the method, and the scope-closure rule so future sessions do not re-litigate the question without new evidence.

**Decision:**

**Keep overstory as QDS Factory's agent orchestration base.** Do not adopt ruflo. Do not build agent orchestration from scratch. Lift the `@claude-flow/guidance` package from ruflo into Factory Core as the enforcement layer (see ADR-034). Do not lift the `@claude-flow/hooks` package wholesale (see ADR-035).

### Evidence — Invariants, Neutrally Re-Derived

A clean pass through 7,416 lines of planning documentation (`prd-v2.md`, `architecture-v2.md`, `architecture-v2-session10-amendments.md`, `epics-and-stories.md`) yielded the following classification.

#### The 10 Hard Constraints (non-negotiable, orchestrator-agnostic)

| # | Invariant | Category | Source |
|---|---|---|---|
| 1 | Context isolation between dev and review agents (fresh context; no sunk-cost bias) | Architectural | FR10; ADR-013, ADR-002 |
| 2 | Atomic story concurrency — no cross-contamination of filesystem or state | Architectural | FR4, FR145; ADR-001, ADR-016 |
| 3 | Evidence-backed PRs (mechanical + judgment + edge-case proof) | Product | FR8, FR52, FR53; ADR-012 |
| 4 | Cost attribution chain: `developer → story → phase → agent → model → provider → tokens → cost` | Product | FR42; ADR-016 |
| 5 | Mechanical quality gates at phase boundaries before context wipe | Architectural | FR14, FR18; ADR-010, ADR-013 |
| 6 | Fixed story pipeline ordering (Develop → BMAD → Fix Loop → QA → PR) | Product | FR10–FR13; ADR-006 |
| 7 | Learning extraction from corrections and injection into future overlays | Product | FR164, FR165, FR167; ADR-014, ADR-015 |
| 8 | Runaway-cost circuit breakers at story and global levels | Product | FR38, FR39; ADR-016 |
| 9 | Never expose credentials in agent context, logs, PRs, or committed files | Product | FR103; ADR-008 |
| 10 | Git safety (no force-push, no commits to protected branches) | Architectural | FR51; ADR-011 |

#### What is NOT invariant (reclassified as implementation choice)

These were written as if architectural in several ADRs but are **mechanisms**. Any orchestrator that satisfies the 10 invariants above can swap them for alternatives without breaking the factory's contract with the developer:

| Mechanism | Written as invariant in | Actual invariant (orthogonal) |
|---|---|---|
| Tmux-based session management | ADR-002 | Process isolation per agent |
| Git worktrees specifically | ADR-001, ADR-006 | Filesystem isolation per story (overlay FS, containers, read-only clones also work) |
| 6-layer hook taxonomy with specific names | ADR-010 | Gated mechanical verification at phase boundaries (the count is organizational) |
| SQLite databases specifically | ADR-020, ADR-003, ADR-005 | Single source of truth for state (Postgres, DuckDB acceptable) |
| Mail-based inter-agent coordination | Component relationship model | Async coordination channel (REST, queues, event bus acceptable) |
| TDD file-pair enforcement | ADR-010 | Development discipline enforcement (alternative gates acceptable) |
| 6-database ownership split (`pipeline.db` / `attribution.db` / `sessions.db` / `mail.db` / `events.db` / `metrics.db`) | ADR-020, session-10 amendments | Organizational partitioning of state (collapses or expands based on operational load) |
| Action scoring via hook heuristics | ADR-015 | Cost-bounded action quality signal (heuristic vs LLM is a cost optimization) |
| Daily observer + weekly optimizer learning cadence | ADR-015 | Learning loop existence and injection point (cadence is tunable) |
| Context budget 50% rule with 8K floor | ADR-017 | Conservative context budget with some floor (specific numbers are a heuristic) |
| ELO ratings for agent performance | ADR-015 | Comparative agent quality signal (one scoring system among several) |

**This reclassification is the single most re-usable output of session 12.** Future architecture and ADR amendments should distinguish "the factory must" (invariant) from "overstory provides this by" (mechanism). Step 5 of session 13 performs a targeted correction pass on `architecture-v2.md` to tag in-place every location where the conflation creates decision ambiguity.

### Evidence — Structural Graph Queries

All queries reproducible via `npx gitnexus cypher --repo <name> "<query>"` against indexes on disk (overstory indexed 2026-04-11 commit `7872d54`, ruflo indexed 2026-04-11 commit `b395d12`).

#### Overstory subsystem inventory (measured)

Fresh index stats: **2,019 symbols, 6,481 edges, 208 files, 165 execution flows, 229 communities, 734 functions, 206 methods, 166 interfaces.**

| Subsystem | src LOC | test LOC | Maps to invariant |
|---|---|---|---|
| commands (CLI, incl. `slingCommand`, `mergeCommand`) | 14,702 | 19,588 | Front door for all invariants |
| doctor | 2,695 | 3,709 | Operational health |
| agents (overlay, hooks-deployer, identity, manifest) | 2,132 | 5,094 | Invariant 5 (phase-boundary gates) — generates overlay with file scope, quality gates, capabilities, constraints |
| runtimes (`PiRuntime`, `ClaudeRuntime`, `CodexRuntime`, `CopilotRuntime`) | 1,533 | 3,145 | Invariant 9 (credential isolation foundation — runtime abstraction exists, `getApiKey` callback wiring is Story 2.3 work) |
| watchdog (Tier 0–3 escalation) | 1,124 | 2,576 | Invariant 8 foundation (health monitoring) |
| merge (4-tier conflict resolution, AI-assisted) | 954 | 1,962 | Invariant 10 (git safety via additive SQLite FIFO merge queue) |
| metrics (`estimateCost`, `getPricingForModel`, MODEL_PRICING, transcript parser) | 895 | 1,644 | Invariant 4 (cost attribution — runtime-agnostic pricing foundation) |
| worktree (`createWorktree`, `listWorktrees`, `createSession`, process-tree kill) | 858 | 1,675 | Invariant 1 + 2 (context + filesystem isolation) |
| logging | 925 | 1,625 | — |
| mail | 702 | 1,684 | Async coordination mechanism (not invariant) |
| mulch | 660 | 752 | Invariant 7 (domain-aware expertise records, `inferDomain()`) |
| sessions | 643 | 1,223 | Agent lifecycle state |
| events | 495 | 990 | Tool event store |
| beads | 400 | 555 | Task tracker |
| tracker | 354 | 995 | Pluggable tracker backend |
| insights | 203 | 466 | Invariant 7 (insight extraction → mulch record loop) |
| **Total src / test** | **~28,300** | **~46,000** | **1.6× test:src ratio (unusually high for a TypeScript project)** |

#### Overstory primitives that map directly to QDS invariants (verified by code read + graph queries)

| Invariant | Overstory primitive | Evidence |
|---|---|---|
| 1: context isolation | `src/worktree/manager.ts` + `src/worktree/tmux.ts` (858 LOC) + `src/runtimes/pi-guards.ts` `NON_IMPLEMENTATION_CAPABILITIES = {scout, reviewer, lead, coordinator, supervisor, monitor}` blocking file modification at Pi SDK runtime | `overstory/src/agents/hooks-deployer.ts:19–26` explicitly lists non-implementation capabilities; Pi-guards enforce at runtime |
| 2: atomic concurrency | `src/commands/sling.ts` — `checkTaskLock`, `checkDuplicateLead`, `checkRunSessionLimit`, `checkParentAgentLimit`, `validateHierarchy`, `parentHasScouts` + SQLite FIFO merge queue | Cypher: `slingCommand` outbound calls show `sling.ts × 11`, `tmux.ts × 5`, `tracker/factory.ts × 3`, `agents/identity.ts × 2`, `agents/manifest.ts × 2` — all concurrency and hierarchy validation wired through sling |
| 4: cost attribution (foundation) | `src/metrics/pricing.ts` `MODEL_PRICING` table + `estimateCost` / `getPricingForModel`, `src/metrics/store.ts` per-session per-run token storage with migrations for `beadIdToTaskId` / `runIdColumn` / `tokenColumns` | 895 LOC src + 1,644 LOC test. Factory Core *extends* this to add the full `dev→story→phase→agent→model→provider→tokens→cost` chain; it does not rewrite. |
| 5: phase-boundary gates | `src/agents/hooks-deployer.ts` (606 LOC) + `src/agents/overlay.ts` — formats file scope, quality gates (inline/steps/bash/capabilities), constraints, canSpawn, mulch domains into agent overlay; generates Claude Code hook scripts and Pi guard extensions | `hooks-deployer.ts` uses `DANGEROUS_BASH_PATTERNS`, `INTERACTIVE_TOOLS`, `NATIVE_TEAM_TOOLS`, `SAFE_BASH_PREFIXES`, `WRITE_TOOLS` from `guard-rules.ts`; `extractQualityGatePrefixes(gates)` makes safe-prefix list configurable so reviewers can still run quality-gate commands without modifying files |
| 7: learning loop | `src/insights/analyzer.ts` extracts `ToolProfile`, `FileProfile`, `ToolStats`, errors from event store → `src/mulch/client.ts` records via `appendOutcome` → next session primes via `mulch prime --domains`; `inferDomain()` maps file paths to codebase-specific domains | Domain-aware, not generic pattern matching — e.g., `src/mail/` → messaging, `src/commands/` → cli |
| 9: credential isolation (foundation) | Runtime registry at `src/runtimes/registry.ts` with `getRuntime(name, config)` abstraction + `src/runtimes/pi-guards.ts` per-capability file-modification rules | ADR-008's `getApiKey` callback wiring lands in Story 2.3 — the runtime abstraction is already in place |
| 10: git safety | `src/merge/queue.ts` SQLite FIFO enqueue/dequeue (additive only), `src/commands/merge.ts` wraps `git merge` via `Bun.spawn` with dry-run support | No force-push paths found via grep across the codebase |

**The `ov sling` command is already the factory's front door.** From graph queries, `slingCommand` internal helpers include: `makeSession`, `makeAgentSession`, `makeBeaconOpts`, `makeTaskSession`, `makeLeadSession`, `makeConfig`, `makeManifest`, `makeAutoDispatchOpts`, `calculateStaggerDelay`, `inferDomainsFromFiles`, `buildAutoDispatch`, `buildBeacon`, `parentHasScouts`, `shouldShowScoutWarning`, `checkTaskLock`, `checkDuplicateLead`, `checkRunSessionLimit`, `checkParentAgentLimit`, `validateHierarchy`, `extractMulchRecordIds`. A Factory Core pipeline can invoke `ov sling --name <agent> --capability <role> --task <story-phase>` as its per-phase spawn call and inherit most of the invariants for free.

#### Ruflo structural shape (measured)

Fresh index stats: **74,020 symbols, 156,389 edges, 3,705 files, 697 MB repo**, three version lineages (`v2/` 146M, `v3/` 34M, `ruflo/` 9.7M). **~30× overstory by symbol count.**

- **20+ npm packages** under `v3/@claude-flow/*`: swarm, hooks, guidance, memory, neural, providers, security, aidefence, claims, browser, codex, embeddings, cli, plugins, federation, testing, performance, integration, deployment, others
- **16,318 methods, 8,743 functions, 4,691 interfaces, 1,779 classes, 2,269 communities, 300 processes**
- Rust and WASM modules (ruvector neural kernels, hyperbolic embeddings), 257 MCP Tool nodes, 131 HTTP Route nodes, 33 Rust Module nodes
- Top communities by symbol count: Commands (176), Simple-commands (176), Infrastructure (72), Examples (67), Cluster_708 (53), Ruvector (51), Algorithms (38), Sdk (31), Registry (29), Config (27), Mcp (26)

**Critical structural gaps (verified via three independent methods):**

| Missing primitive | Evidence |
|---|---|
| **Worktree code** | 0 files contain `git worktree`; cypher query on File nodes with `worktree` in path returns 0 results; cypher query on File nodes with `tmux` in path returns 0 results; direct `grep -r "git worktree"` across entire 697M repo returns 0 matches |
| **Tmux integration** | 0 files. Ruflo is not a local-process-orchestration tool — it is a swarm / memory / neural system that assumes some *other* layer handles process isolation |
| **`PhaseId` mapping to QDS phases** | `v3/@claude-flow/swarm/src/shared/types.ts` defines `PhaseId = 'phase-1-foundation' \| 'phase-2-core' \| 'phase-3-integration' \| 'phase-4-release'`. These are ruflo's own *product roadmap phases*, not story-pipeline phases. They do not map to QDS's `Develop → BMAD → Fix Loop → QA → PR`. Orthogonal concepts sharing a word. |

Ruflo's strengths live in its guidance / memory / neural / swarm coordination layers. Its structural shape assumes the orchestration *substrate* (process isolation, filesystem isolation, per-story concurrency) exists elsewhere. For QDS, overstory **is** that substrate. Swapping overstory for ruflo would require building the substrate from scratch, then grafting ruflo's upper layers onto it — which is equivalent to "build from scratch" plus adopting a 697 MB upstream with its own opinions.

### Rubric Scores

Weights derived from invariant criticality. Non-negotiable product and architectural invariants (1, 2, 9, 10) are weighted heaviest. Scores are 0–N per dimension where N is the weight.

| Dimension | Weight | Overstory | Ruflo | Build Fresh |
|---|---:|---:|---:|---:|
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

**Overstory wins on 9 of 10 invariants.** Ruflo wins decisively on enforcement-layer maturity (invariant 5 subscore 8 vs 6) — but this is exactly what ADR-034 addresses by lifting `@claude-flow/guidance` without adopting ruflo wholesale. Fresh build is disqualified on time-to-first-PR and scale-of-rewrite.

### Alternatives Considered

| Option | Pros | Cons | Score |
|---|---|---|---:|
| **A. Keep overstory (decided)** | 9-of-10 invariants operationalized today; 28k LOC at 1.6× test ratio; front-door CLI (`ov sling`) already wired; runtime abstraction supports Pi SDK credential injection path; merge queue with 4-tier resolution; insight→mulch learning loop already domain-aware | Enforcement layer (invariant 5) less mature than ruflo's guidance package → addressed in ADR-034 | 90/135 |
| **B. Adopt ruflo as base** | Guidance package is genuinely sophisticated (compiler, gates, proof, ledger, trust, retriever); ReasoningBank for self-learning; HNSW vector store; claims has statusline bar | 0 worktree code; 0 tmux code; `PhaseId` doesn't map to QDS phases; 697M repo to absorb; 20-package monorepo conflicts with QDS ADRs at multiple points; ruflo is claude-flow v3.5 rebranded, 6,000+ commit active project with aggressive upstream drift; no clean substrate-above-substrate split | 54/135 |
| **C. Adopt `jayminwest/overstory` upstream directly without QDS fork** | Zero fork-drift risk | Cannot add QDS-specific integration points (Story 1.6 schema extensions, overlay extensions, Factory Core attribution); upstream moves faster than QDS could keep pace | Not scored — eliminated at scope level |
| **D. Build orchestration from scratch in factory-core/** | No external dependency; fully QDS-controlled; smallest long-term maintenance surface | 6,470 LOC planning budget becomes 6,470 + 28,300 = 34,770 LOC; delivers first PR in approximately 2–3× time; re-implements 9-of-10 invariants overstory already satisfies | 10/135 |

### Consequences

**Positive:**

- The front door for agent spawning (`ov sling`) is live code today. Factory Core's pipeline engine calls into it rather than re-implementing it.
- The worktree, merge queue, tmux, runtime registry, metrics, mulch, and insights subsystems remain the responsibility of overstory upstream. QDS does not pay the maintenance cost for these directly.
- Story 1.6 (Overstory Schema Extensions) is the integration boundary. Factory Core extends overstory's databases via documented probe-then-alter and table-rebuild patterns (per ADR-024 Section 2 and session-10 amendment 3), not by reinventing them.
- The Pi SDK credential callback pattern (ADR-008 amended) wires into overstory's existing runtime abstraction at `src/runtimes/registry.ts` with minimal surgery.
- ADR-034 (guidance lift) and ADR-035 (hook engine strategy) address the one dimension where overstory scored lower than ruflo without forcing adoption of the full ruflo stack.

**Negative:**

- QDS remains a fork of `jayminwest/overstory` with active upstream development (~6,000 commits, per fork-hygiene guidance in `overstory/CLAUDE.md`). Sync cadence and conflict resolution are recurring operational costs.
- QDS-specific edits to upstream files must be tagged with `// QDS:` comments per existing fork hygiene convention. This is additive but requires discipline across all contributors.
- Overstory's TypeScript / Bun / Biome / tab-indentation conventions (100-char line width, `noUncheckedIndexedAccess`, no `any`, tests colocated) must be honored in all Factory Core code that touches overstory surfaces. This is already the case per session-11 twelve-factor work.
- The findings document's mechanism-vs-invariant reclassification (Part A) implies a pass through `architecture-v2.md` to disambiguate. This is Step 5 of session 13 (surgical correction pass, not rewrite).

**Neutral:**

- Overstory's fork of `@os-eco/mulch-cli` and its `canopy` prompt management integration are not currently on QDS's critical path but remain available surface area for future learning-loop work. No integration planned for MVP.
- Ruflo's `@claude-flow/guidance` package dependencies, release cadence, and license terms (MIT confirmed) are now under monitoring per the fork-hygiene checklist that ADR-034 establishes.

### Re-Opening Criteria

Future sessions may re-open the "should we swap orchestrator?" question only if at least one of the following occurs:

1. **A new product invariant emerges** that overstory structurally cannot satisfy. "Structurally cannot" means: the invariant cannot be achieved by additive changes to the overstory surface area, only by replacing its foundation. Contrast with "could be cheaper / faster / cleaner in a different system" — that is not grounds for re-opening.

2. **A measured structural regression in overstory** appears in the re-run rubric (e.g., `ov sling` no longer satisfies atomic concurrency, worktree isolation is broken, runtime abstraction is removed). This requires fresh cypher queries against a re-indexed overstory repository, not argument from memory.

3. **An alternative's rubric score exceeds overstory's by ≥ 20 points** on the same 135-point scale used here, with the same evidence methodology (structural graph queries + direct code reads + invariant classification). Re-running the rubric with new weights is not sufficient — the weights are derived from invariant criticality and are themselves invariant.

4. **A material change in ruflo's structural shape** — for example, if ruflo were to grow worktree primitives, tmux integration, or a clean substrate layer that inverts the 0-file finding above. This requires a fresh ruflo index and re-running the cypher queries from session 12.

Re-opening under any other conditions (personal preference, argument from authority, "a new paper came out", framework fashion cycles) is explicitly out of scope and should be closed by reference to this ADR.

### Acceptance Criteria

- [x] `architecture-v2-session12-amendments.md` created with ADR-033 as its first section
- [x] ADR-033 references `session12-ruflo-evaluation-findings.md` as its primary evidence base
- [x] Rubric table reproduced verbatim from findings Part C with criticality-weighted scoring
- [x] Invariant/mechanism reclassification captured in ADR text (not only in the findings doc) so future readers do not need to cross-read two documents
- [x] Re-opening criteria explicit, measurable, and reference-able from future sessions
- [x] ADR numbering shift (024 → 025) documented in the "Note on ADR Numbering" preamble
- [ ] `architecture-v2.md` index section updated with ADR-033 reference *(Step 5, session 13)*
- [ ] `prd-v2.md` has no unresolved orchestrator-identity ambiguity *(verified in Step 5 cross-check)*

### References

- `_bmad-output/planning-artifacts/session12-ruflo-evaluation-findings.md` — full evidence and decision rationale
- `_bmad-output/planning-artifacts/architecture-v2.md` — ADRs 001–023 (base architecture)
- `_bmad-output/planning-artifacts/architecture-v2-session10-amendments.md` — ADR-008 credential injection amendment, ADR-013 enforcement metadata clarification, database migration ownership
- `_bmad-output/planning-artifacts/architecture-v2-session11-twelve-factor.md` — ADR-024 (twelve-factor conventions)
- `_bmad-output/implementation-artifacts/epics-and-stories.md` — Story 1.6 (overstory schema extensions), Story 2.3 (credential middleware)
- `<repo-root>/memory/qds_orchestrator.md` — persisted long-horizon memory for future sessions (user-local Claude memory)
- `<repo-root>/memory/gitnexus_cypher.md` — CLI pattern reference for re-running structural queries (user-local Claude memory)
- `overstory/CLAUDE.md` — overstory fork conventions and integration-point registry
- `overstory/src/agents/hooks-deployer.ts` (606 LOC) — Claude Code hook generation foundation, referenced by ADR-035
- `overstory/src/runtimes/registry.ts` — Runtime abstraction referenced by ADR-008
- `overstory/src/runtimes/pi-guards.ts` — `NON_IMPLEMENTATION_CAPABILITIES` enforcement point
- `overstory/src/worktree/manager.ts` and `overstory/src/worktree/tmux.ts` — 858 LOC implementing invariants 1 and 2
- `overstory/src/merge/queue.ts` — SQLite FIFO merge queue (invariant 10)
- `https://github.com/ruvnet/ruflo` — evaluated alternative (ruflo = claude-flow v3.5 rebranded)
- `https://github.com/ruvnet/claude-flow` — upstream for ruflo lineage

---

## ADR-034: `@claude-flow/guidance` Extraction into Factory Core

**Status:** ACCEPTED

**Date:** 2026-04-11

**Deciders:** Steve (user), session 13 authorship, evidence from session 12 structural analysis + session-13 source-code reading

**Depends on:** ADR-033 (orchestrator re-confirmation establishes that the enforcement layer lands inside Factory Core, not by swapping orchestrators)

**Context:**

Session 12's rubric scored overstory at 90/135 across the 10 product/architectural invariants — strong on 9 of 10, weaker on **invariant 5 (phase-boundary gates)** where ruflo scored higher (8/10 vs overstory 6/10). The gap is not because overstory lacks hook infrastructure — `src/agents/hooks-deployer.ts` (606 LOC) generates Claude Code hook scripts and Pi-runtime guard extensions — but because overstory provides a **hook generation toolkit**, not a **mechanical enforcement engine** with compiler, gates, proof, ledger, and evaluators.

Ruflo's `@claude-flow/guidance` package (`v3/@claude-flow/guidance/src/`) is exactly that missing piece: a self-described "governance control plane" that compiles CLAUDE.md into a constitution + shards + manifest, retrieves task-relevant shards at runtime via intent classification, enforces non-negotiables through hook gates, logs every run to a ledger with evaluators, and optionally evolves the rule set through an optimizer loop. It was architected as a near-standalone library with only a single external coupling (`src/hooks.ts` adapter → `@claude-flow/hooks`). This makes it the single cleanest lift candidate in the entire ruflo repository.

Session 12 Part B and session-13 verification queries confirmed the extraction feasibility:

| Question | Answer | Evidence |
|---|---|---|
| Is the guidance package self-contained? | **Yes.** Zero runtime imports from `@claude-flow/memory`, `@claude-flow/neural`, `@claude-flow/embeddings`, `@claude-flow/aidefence`, or `@claude-flow/security`. | `grep -r "from '@claude-flow" v3/@claude-flow/guidance/src/` returns exactly one match: `hooks.ts` importing from `@claude-flow/hooks` |
| How many external consumers? | **One.** `v3/@claude-flow/cli/src/commands/guidance.ts` has 14 call edges into the guidance package; everything else is README / test / example references. | Fresh cypher query (session 13): `MATCH (a)-[r:CodeRelation]->(b) WHERE b.filePath STARTS WITH 'v3/@claude-flow/guidance' AND NOT a.filePath STARTS WITH 'v3/@claude-flow/guidance' RETURN a.filePath, count(*)` |
| How many outbound references to other ruflo packages? | **4 total.** `browser/infrastructure/agent-browser-adapter.ts × 2`, `hooks/registry/index.ts × 1`, `plugins/hooks/index.ts × 1`. The hooks and plugins references live inside the `hooks.ts` adapter file. | Fresh cypher query (session 13) |
| Is the package MIT-licensed? | **Yes.** `_research-repos/ruflo/LICENSE` lines 1–21, Copyright `(c) 2024-2026 ruvnet`. Vendoring is compatible with QDS Factory's licensing needs. | Direct file read (session 13) |
| Does `src/retriever.ts` require HNSW / ONNX? | **No.** `HashEmbeddingProvider` (lines 1–60) provides a non-semantic fallback using regex-based intent classification across 12 intent categories. The retriever can run without any vector store. | Direct file read (session 13) |
| Is `src/hooks.ts` a thin adapter or a deep coupling? | **Thin adapter.** Imports `HookContext`, `HookResult`, `HookRegistrationOptions`, `HookEvent`, `HookPriority`, `HookRegistry` from `@claude-flow/hooks`. 6 symbols total, all importable as TYPES except `HookEvent` + `HookPriority` (value enums). Replacing this adapter means defining QDS equivalents for 6 symbols, not re-implementing a hook engine. | Direct file read `hooks.ts:18-29` |

**Decision:**

**Lift `@claude-flow/guidance` into Factory Core as `factory-core/src/guidance/`**, using a tiered extraction strategy that resolves ambiguous files through a timeboxed spike (Story 1.7) before committing full scope. Replace `src/hooks.ts` (465 LOC) with a QDS-specific adapter that bridges guidance gates and ledger evaluators into Factory Core's own hook engine (see ADR-035). Vendor the MIT license via a `factory-core/THIRD_PARTY_LICENSES.md` manifest.

### File-Level Scope Decisions

Source line counts verified by `wc -l` against `_research-repos/ruflo/v3/@claude-flow/guidance/src/*.ts` on 2026-04-11 (total 22,349 LOC).

#### Tier 1 — Full Lift (mechanical enforcement core)

These files implement the mechanical enforcement engine that QDS is missing. Lift them whole, adapt import paths, run through `biome check` and `bun test`, integrate behind the QDS hook adapter.

| File | LOC | Why it lifts | Maps to invariant |
|---|---:|---|---|
| `compiler.ts` | 532 | Parses CLAUDE.md → `Constitution + RuleShard[] + RuleManifest`. Regex patterns define rule syntax (`R001:`, `@security`, `[edit]`, `#bug-fix`, `scope:src/**`, `verify:tests-pass`, `priority:N`). **QDS must adopt this rule syntax OR adapt the compiler to overstory's overlay format — see Integration Decision 1 below.** | Inv 5 (phase-boundary gates — rule compilation) |
| `gates.ts` | 339 | `EnforcementGates` class with 4 built-in gates: destructive ops, tool allowlist, diff size, secrets. Hard-coded 8 secret regexes (API keys, private keys, `sk-*`, `ghp_*`, `npm_*`, AWS) and 12 destructive patterns (`rm -rf`, `DROP TABLE`, `git push --force`, `git reset --hard`, etc.). Config merge via `{...DEFAULT_GATE_CONFIG, ...overrides}`. **Directly operationalizes QDS invariants 9 (credential isolation) and 10 (git safety).** | Inv 9, Inv 10 |
| `proof.ts` | 369 | Mechanical proof-of-compliance generation. | Inv 3 (evidence-backed PRs) |
| `ledger.ts` | 461 | `RunLedger` + `IEvaluator` interface + 5 built-in evaluators: `TestsPassEvaluator`, `ForbiddenCommandEvaluator`, `ForbiddenDependencyEvaluator`, `ViolationRateEvaluator`, `DiffQualityEvaluator`. **The single highest-value piece of lift material — this is the mechanical gate taxonomy QDS Factory needs at phase boundaries.** The evaluator interface is 6 lines: `name`, `type: 'objective'\|'subjective'`, `evaluate(event): Promise<EvaluatorResult>`. Dead simple to extend with QDS-specific evaluators. | Inv 3, Inv 5 |
| `retriever.ts` | 482 | `ShardRetriever` + `HashEmbeddingProvider` (non-semantic fallback). Intent classification across 12 categories via regex pattern weighting. Retrieval contract: always include constitution, retrieve up to 5 shards by similarity, hard filter by risk class + repo scope, contradiction check via priority. **Runs without HNSW/ONNX.** | Inv 5 (task-aware gate selection) |
| `continue-gate.ts` | 533 | Gate that determines whether a run should continue. | Inv 5 |
| `memory-gate.ts` | 584 | Gate that manages memory/context handoffs. | Inv 5, Inv 7 (learning loop) |
| `types.ts` | 435 | Shared type definitions: `RiskClass`, `ToolClass`, `TaskIntent`, `GuidanceRule`, `RuleShard`, `Constitution`, `RuleManifest`, `PolicyBundle`, `GateDecision`, `GateResult`, `GateConfig`, `RunEvent`, `Violation`, `EvaluatorResult`. **Foundational — every other file imports from this.** | All |
| `crypto-utils.ts` | 26 | Small hash/signing helper for rule IDs. Tiny. | — |
| `authority.ts` | 768 | Authority chain resolution for rule precedence. | Inv 5 |
| `capabilities.ts` | 639 | Capability classification (tool → risk class mapping). | Inv 5 |
| `index.ts` | 754 | Public API surface + factory functions (`createCompiler`, `createGates`, `createLedger`, `createRetriever`). **Will need significant editing** to remove exports for deferred/dropped files and to add QDS-specific re-exports. | — |
| **Tier 1 subtotal** | **~5,922 LOC** | | |

Tier 1 lifts approximately **31% of the guidance package** and delivers the mechanical enforcement core. This is the MVP scope for the lift.

#### Tier 2 — Spike-Then-Decide (ambiguous value / state complexity)

These files have real value but introduce either state complexity, runtime cost, or dependency risk that the spike (Story 1.7) should measure before full adoption.

| File | LOC | Why ambiguous | Spike question |
|---|---:|---|---|
| `adversarial.ts` | 801 | Prompt-injection defense. Small, self-contained, directly addresses a real threat class. Likely keep. | Does it work out-of-the-box against QDS's agent overlay format, or does it assume ruflo's prompt structure? |
| `trust.ts` | 634 | Per-agent trust tiers with promotion/demotion logic. Valuable but adds persistent state (trust scores per agent over time). Overstory already has `src/insights/analyzer.ts` recording agent outcomes — potential redundancy. | Does trust.ts's state model conflict with overstory's insights/mulch loop, or compose cleanly with it? |
| `analyzer.ts` | 3,194 | The single largest file in the package. Performs deep analysis of rule violations, patterns, and outcomes. **Likely too large and too entangled for MVP scope.** | Can a 20% subset of analyzer.ts deliver 80% of the value, or is it all-or-nothing? |
| `conformance-kit.ts` | 1,000 | Generates conformance test suites for rules. Useful but builds on evolution + ledger. | Is it required to run tier-1 evaluators, or is it a separate offering? |
| `manifest-validator.ts` | 1,139 | Validates compiled rule manifests against a schema. Likely a corollary to `compiler.ts`. | Does the compiler require this at runtime, or only at compile-time development? |
| `generators.ts` | 894 | Rule template generators. Development-time convenience. | Needed for MVP or only for rule authors? |
| `coherence.ts` | 534 | Rule coherence checking (detects rule conflicts). | Does it depend on evolution.ts or stand alone? |
| `persistence.ts` | 564 | `PersistentLedger` + `EventStore` — file-backed persistence for the run ledger. | Does QDS prefer this or the pipeline.db store from Factory Core? |
| `gateway.ts` | 630 | `DeterministicToolGateway` — coerces tool calls through a mechanical filter. | Overlaps with overstory's `hooks-deployer.ts` + pi-guards. Which one wins? |
| **Tier 2 subtotal** | **~9,390 LOC** | | |

Tier 2 files are **not in the MVP scope**. Story 1.7 evaluates 2–3 tier-2 files during the spike; the rest are deferred to a post-MVP backlog story.

#### Tier 3 — Defer (premature for MVP)

These files serve valid purposes but are out of scope for the enforcement layer that session 12 identified as missing. Defer to post-MVP.

| File | LOC | Why defer |
|---|---:|---|
| `evolution.ts` | 799 | A/B rule benchmarking with Pearson/Spearman correlation analysis. Premature optimization — the factory needs working gates before it needs an A/B benchmark for them. |
| `optimizer.ts` | 435 | Optimizer loop that consumes `evolution.ts` output. Blocked on evolution. |
| `temporal.ts` | 902 | Long-horizon temporal modeling for rule effects. Academic — the factory's primary learning signal is per-story outcome, not long-horizon rule drift. |
| `uncertainty.ts` | 855 | Uncertainty quantification for rule decisions. Valuable for production, not for MVP. |
| `meta-governance.ts` | 573 | Meta-level governance (governance of the governance layer). Two steps removed from what the factory needs. |
| `artifacts.ts` | 556 | Artifact capture helpers. Likely subsumed by Factory Core's attribution.db. |
| `truth-anchors.ts` | 677 | "Truth anchors" concept for factual grounding. Unclear MVP mapping. |
| `headless.ts` | 525 | `HeadlessRunner` that runs `claude -p --output-format json` — ruflo-specific Claude CLI adapter. **Overstory already provides runtime abstraction** via `src/runtimes/registry.ts` with `PiRuntime`, `ClaudeRuntime`, `CodexRuntime`, `CopilotRuntime`. This file is duplicative. |
| **Tier 3 subtotal** | **~5,322 LOC** | |

#### Tier 4 — Drop (not applicable to QDS)

| File | LOC | Why drop |
|---|---:|---|
| `wasm-kernel.ts` | 205 | WASM hot-path optimization. Defer until we prove the JavaScript kernel is a bottleneck. |
| `ruvbot-integration.ts` | 1,045 | Ruflo-specific bot wiring. Not applicable to QDS. |
| **Tier 4 subtotal** | **~1,250 LOC** | |

#### Tier 5 — Replace (adapter file)

| File | LOC | Why replace |
|---|---:|---|
| `hooks.ts` | 465 | The single external coupling point. Imports 6 symbols from `@claude-flow/hooks` (`HookContext`, `HookResult`, `HookRegistrationOptions`, `HookEvent`, `HookPriority`, `HookRegistry`) and registers guidance gates + ledger evaluators as hooks in the `@claude-flow/hooks` registry. **Replace with a QDS-specific adapter** (`factory-core/src/guidance/hooks-adapter.ts`) that registers gates and evaluators against Factory Core's own hook engine (ADR-035). Estimated replacement LOC: ~500. |
| **Tier 5 subtotal** | **~500 LOC (new write, not lift)** | |

### Scope Summary

| Tier | Action | Files | LOC |
|---|---|---:|---:|
| 1 | Full lift | 12 | ~5,922 |
| 2 | Spike-then-decide (2–3 files evaluated in Story 1.7) | 9 | ~9,390 (spike scope: ~2,000) |
| 3 | Defer to post-MVP | 8 | ~5,322 (not lifted) |
| 4 | Drop | 2 | ~1,250 (not lifted) |
| 5 | Replace (QDS adapter) | 1 | ~500 (new write) |
| **MVP lift total** | **Tier 1 + adapter rewrite** | **13 files** | **~6,422 LOC lifted + written** |
| **Spike additional scope** | **Tier 2 subset (decided inside Story 1.7)** | **2–3 files** | **~1,500–3,000 LOC** |

MVP scope is **~6,422 LOC** (tier 1 + adapter), bounded above by **~9,400 LOC** if the spike validates all three prioritized tier-2 files. This is dramatically smaller than the raw 22,349 LOC of the guidance package and falls inside Factory Core's 6,470 LOC planning budget only partially — the code-lift manifest will need an update to reflect the increased budget (see Step 4 of session 13).

### Integration Decisions

#### Integration Decision 1 — Rule syntax alignment

The guidance compiler parses CLAUDE.md files using regex patterns that define a specific rule syntax (`R001:` / `RULE-001:` rule IDs, `(critical)` risk annotations, `@security` domain tags, `[edit]` tool class tags, `#bug-fix` intent tags, `scope:src/**` repo scopes, `verify:tests-pass` verifier references, `priority:N` priority overrides). These patterns are hard-coded in `compiler.ts` lines 28–50.

Overstory has its own overlay format generated by `src/agents/overlay.ts` — the dynamic `CLAUDE.md` written per-worker at spawn time that contains task ID, file scope, spec path, branch name, quality gates, and capabilities. **The two rule syntaxes do not align.**

Two options:

| Option | Pros | Cons |
|---|---|---|
| **A. Adopt guidance's rule syntax for QDS overlays** | Minimal compiler edits; full guidance feature surface available | Every QDS agent overlay must adopt a new tagging convention; divergence from upstream overstory overlay format |
| **B. Adapt the compiler to parse overstory overlay format** | QDS overlay format stays compatible with overstory upstream | ~200–400 LOC of compiler rework; regex patterns become QDS-specific, harder to track upstream guidance drift |

**Decision:** **Option B** — adapt the compiler to parse overstory's overlay format. Rationale: overstory's overlay format is a fork-hygiene concern (per `overstory/CLAUDE.md` fork rules), and diverging from it would break upstream sync. The compiler is ~500 LOC; reworking 200–400 LOC of regex-driven parsing against a well-defined QDS overlay schema is a bounded cost.

**Fork hygiene note:** The resulting `compiler.ts` is no longer a clean lift — it is an adaptation. Tag all QDS-specific changes with `// QDS:` comment prefix per existing fork-hygiene convention. Maintain a delta file `factory-core/src/guidance/UPSTREAM_DELTA.md` documenting every non-trivial edit for upstream-drift monitoring.

#### Integration Decision 2 — Hook adapter target

The replacement `hooks-adapter.ts` (tier 5) wires guidance gates and ledger evaluators into Factory Core's hook engine. That hook engine is specified in ADR-035. **Work order:** ADR-035 lands first (specifying the target interface), then the tier-5 adapter implementation lands as part of Story 1.7.

#### Integration Decision 3 — Test framework

Guidance uses `vitest` (per its `package.json` test scripts and common ruflo convention); Factory Core and overstory use `bun test`. Running two test frameworks in Factory Core adds CI complexity and cognitive overhead.

**Decision:** **Adapt lifted tests to `bun test`.** The two frameworks are mostly API-compatible; `vitest`'s `describe`/`it`/`expect` map directly to `bun test`'s equivalents. Estimated adaptation cost: ~1–2 hours per lifted test file. Tier 1 + adapter work includes test adaptation as part of the lift.

#### Integration Decision 4 — License vendoring

Ruflo is MIT-licensed (`_research-repos/ruflo/LICENSE`, Copyright 2024–2026 ruvnet, lines 1–21 verified). MIT permits modification, sublicensing, and redistribution with the notice preserved.

**Decision:** **Vendor the MIT notice via a centralized `factory-core/THIRD_PARTY_LICENSES.md` manifest** rather than inline per-file headers. The manifest lists: (1) source project name and URL, (2) license type, (3) copyright holder, (4) commit SHA or version lifted from, (5) list of files lifted, (6) full license text. This pattern scales as additional lifts land (ZeroClaw patterns, claude-mem patterns).

**Implementation:** Create `factory-core/THIRD_PARTY_LICENSES.md` as part of Story 1.7 spike deliverables. First entry is `@claude-flow/guidance` lifted from `_research-repos/ruflo @ commit b395d12` (the indexed commit as of 2026-04-11).

### Alternatives Considered

| Option | Pros | Cons | Outcome |
|---|---|---|---|
| **A. Lift all 32 files (22,349 LOC)** | Maximum feature surface; no second lift cycle | 22k LOC exceeds the 6,470 LOC Factory Core planning budget by 3.5×; adopts evolution/optimizer/temporal/uncertainty (premature); adopts ruvbot (not applicable); adopts WASM kernel (optimization before measurement) | **Rejected** — budget + scope discipline |
| **B. Tier 1 only (no spike, skip tier 2 entirely)** | Smallest MVP scope; lowest risk | Leaves `adversarial.ts` (prompt-injection defense) and `trust.ts` (per-agent trust) off the table without evaluation; may require a second lift cycle within MVP | **Rejected** — session 12 findings explicitly flagged 3 tier-2 files as "likely keep after spike"; skipping evaluation is false parsimony |
| **C. Tier 1 + timeboxed spike on tier 2 subset (chosen)** | Balances scope discipline with informed tier-2 decisions; Story 1.7 produces measurable output that informs a follow-on story | Introduces a dependency (Story 1.7 → tier-2 implementation) that sequences some MVP work | **Accepted** |
| **D. Build QDS enforcement from scratch** | Zero external coupling; fully QDS-controlled | Re-invents ~7,000 LOC of compiler + gates + ledger + evaluators that are already written, tested, and MIT-licensed; delivers enforcement later; no upstream learning | **Rejected** — the lift already exists and the license permits it |
| **E. Fork `@claude-flow/guidance` as a separate package, depend via npm** | Cleanest upstream tracking | Adds a runtime dependency on an external package that drags `@claude-flow/hooks` via its own dependencies; ruflo's 6,000+ commit velocity creates chronic drift | **Rejected** — the adapter rewrite is cheaper than dependency management |

### Consequences

**Positive:**

- Invariant 5 (phase-boundary gates) moves from "partial" to "operationalized" without forcing ruflo adoption.
- `EnforcementGates` secret regexes + destructive patterns directly operationalize invariants 9 and 10 on day one.
- `IEvaluator` interface gives QDS a typed, extensible surface for adding factory-specific evaluators (e.g., `PiSdkCostBudgetEvaluator` for invariant 8) without touching guidance internals.
- The non-semantic `HashEmbeddingProvider` means the retriever runs without any vector store — zero HNSW/ONNX dependency.
- MIT licensing via `THIRD_PARTY_LICENSES.md` establishes a reusable pattern for future lifts.

**Negative:**

- Factory Core LOC budget increases by ~6,422 LOC (tier 1 + adapter). The original 6,470 LOC planning budget is superseded by this ADR; `code-lift-manifest.md` and `code-lift-gap-analysis.md` updates in Step 4 of session 13 will reconcile the numbers.
- Integration Decision 1 (adapt compiler to overstory overlay format) introduces upstream-drift risk. Monitor `@claude-flow/guidance` changelog quarterly; flag material compiler changes in session handoffs.
- `// QDS:` comment discipline across ~7,000 LOC of lifted code is a recurring fork-hygiene cost.
- Test framework adaptation (vitest → bun test) is one-time but estimated at 8–16 hours across the lifted test suite (~19k test LOC at a few-hours-per-file rate for the tier-1 subset).

**Neutral:**

- Tier 3 and tier 4 files (13 files, ~6,572 LOC) remain in the ruflo source tree and can be lifted in a future session if the MVP exposes a genuine need. They are not deleted, just not lifted yet.
- Tier 2 spike outcome (Story 1.7) may reveal additional tier-1 promotions or tier-3 demotions. The scope decisions in this ADR are **draft tiers**, not final — Story 1.7's spike deliverable is "update this ADR's tier table with measured findings."

### New Story — Story 1.7: `@claude-flow/guidance` Lift Spike + Integration

See "Story 1.7" section added to `_bmad-output/implementation-artifacts/epics-and-stories.md` in Epic 1 immediately after Story 1.6. The story covers a 3-day timeboxed spike against 3 tier-1 files + 3 prioritized tier-2 files, followed by constrained tier-1 implementation and adapter writing.

### Acceptance Criteria

- [x] ADR-034 present in `architecture-v2-session12-amendments.md`
- [x] Tier classification table for all 32 files with LOC counts and justification per file
- [x] Integration decisions 1–4 documented with rationale
- [x] MIT license vendoring policy specified (`THIRD_PARTY_LICENSES.md` at `factory-core/` root)
- [x] Fork hygiene rules (`// QDS:` comment discipline, `UPSTREAM_DELTA.md` maintenance) specified
- [x] Alternatives A–E considered and rejected with rationale
- [ ] Story 1.7 added to `epics-and-stories.md` Epic 1 *(Step 2 of session 13, same commit)*
- [ ] `code-lift-manifest.md` updated with guidance lift entry *(Step 4 of session 13)*
- [ ] `code-lift-gap-analysis.md` updated with upstream-drift and license-compliance risk entries *(Step 4 of session 13)*
- [ ] `architecture-v2.md` cross-reference from ADR-010 (hook pipeline) to ADR-034 *(Step 5 of session 13)*

### References

- `_research-repos/ruflo/v3/@claude-flow/guidance/src/` — lift source, 32 files, 22,349 LOC
- `_research-repos/ruflo/v3/@claude-flow/guidance/package.json` — subpath exports confirming multi-entry-point architecture
- `_research-repos/ruflo/LICENSE` lines 1–21 — MIT Copyright 2024–2026 ruvnet
- `_research-repos/ruflo/v3/@claude-flow/guidance/src/hooks.ts` lines 18–29 — single external coupling point, 6 symbols imported from `@claude-flow/hooks`
- `_research-repos/ruflo/v3/@claude-flow/guidance/src/gates.ts` lines 27–58 — secret regexes and destructive patterns (operationalizing invariants 9 + 10)
- `_research-repos/ruflo/v3/@claude-flow/guidance/src/ledger.ts` lines 35–42 — `IEvaluator` interface (6 lines, dead simple extension point)
- `_research-repos/ruflo/v3/@claude-flow/guidance/src/retriever.ts` lines 32–60 — intent classification patterns + `HashEmbeddingProvider` non-semantic fallback
- `_research-repos/ruflo/v3/@claude-flow/guidance/src/compiler.ts` lines 28–50 — rule syntax regex patterns (Integration Decision 1 touchpoint)
- `overstory/src/agents/overlay.ts` — QDS-side overlay format that the compiler will be adapted to parse
- `overstory/src/agents/hooks-deployer.ts` (606 LOC) — existing hook generation foundation (ADR-035 target)
- ADR-033 (this file) — scope-closed orchestrator decision that this ADR is predicated on
- ADR-035 (this file, below) — hook engine strategy the lifted guidance code will bind against

---

## ADR-035: Hook Engine Strategy — Dual-Plane Architecture (Overstory Scripts + Factory Core Engine)

**Status:** ACCEPTED

**Date:** 2026-04-11

**Deciders:** Steve (user), session 13 authorship, evidence from direct source reading of both `hooks-deployer.ts` and `@claude-flow/hooks/index.ts`

**Depends on:** ADR-033 (orchestrator retained), ADR-034 (guidance lift sets the consumer contract for this hook engine)

**Context:**

ADR-034 lifts `@claude-flow/guidance` into Factory Core as the mechanical enforcement core. Guidance's `EnforcementGates`, `IEvaluator` implementations, and `ShardRetriever` are all **TypeScript classes with async methods**. They cannot run as bash scripts — they need an **in-process invocation mechanism** with priority ordering, timeouts, and typed results.

Session 12 findings Part F Step 3 flagged the hook engine question and explicitly warned against wholesale lift of `@claude-flow/hooks`: the cypher analysis showed outbound edges into `@claude-flow/memory/src/hnsw-index.ts` (4 refs), `@claude-flow/embeddings/src/rvf-embedding-service.ts` (3 refs), `@claude-flow/memory/src/agentdb-adapter.ts` (1 ref), and `@claude-flow/neural/src/reasoning-bank.ts` (1 ref). Lifting the package drags the ReasoningBank stack (HNSW + ONNX MiniLM-L6 embeddings + AgentDB). That's a 10,925 LOC package plus its transitive dependencies.

Session-13 direct source reading revealed a deeper structural truth that reframes the decision entirely:

**Overstory's `hooks-deployer.ts` (606 LOC) and ruflo's `@claude-flow/hooks` (10,925 LOC) are not two implementations of the same thing — they are fundamentally different architectures operating at different runtime layers.**

| Aspect | `overstory/src/agents/hooks-deployer.ts` | `@claude-flow/hooks` |
|---|---|---|
| **Execution layer** | Edge — bash scripts generated ahead of time, executed by Claude Code in `/bin/sh` with minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) | In-process — TypeScript async `HookHandler` functions registered at runtime |
| **Invocation model** | Claude Code reads `.claude/settings.local.json`, spawns `/bin/sh -c "<script>"` per tool-use event | Factory Core's own process calls `HookRegistry.execute(event, context)` at boundary transitions |
| **Registration** | Compile-time in TypeScript generator functions (`buildPathBoundaryGuardScript`, `buildBashGuardScript`, `buildBashFileGuardScript`) that return POSIX shell strings | Runtime via `registerHook(event, handler, priority, options)` |
| **Typed contract** | JSON-over-stdin + JSON-to-stdout with `decision: "block" \| "allow"` | `HookContext` parameter + `HookResult` return type + `HookHandler` signature |
| **Priorities** | None — scripts execute in definition order | `HookPriority` enum with priority-based ordering |
| **Extension point** | Edit the TypeScript generator and redeploy hooks via `ov hooks install` | Call `addHook(event, handler, { priority })` from any module |
| **Runtime dependencies** | Zero — `/bin/sh` + `sed` + `grep` only (deliberately PATH-minimal) | ReasoningBank + HNSW + ONNX + AgentDB + statusline + daemons + workers + MCP tools (transitively, via the full package) |
| **What it protects** | Edge boundary: file paths, bash commands, tool names against Claude Code tool use | Semantic boundary: gate decisions, evaluator outcomes, retrieval policies, proof generation |
| **LOC** | 606 in one file | 10,925 across 47 files |
| **Tests** | Co-located `src/agents/hooks-deployer.test.ts` | Large suite with daemon, worker, bridge, MCP tool tests |

Both layers are necessary. Neither replaces the other. **This is the decisive structural finding that session 12 partially identified but session 13's direct source reading confirms.**

**Decision:**

**Adopt a dual-plane hook architecture:**

1. **Edge Plane (unchanged, reused as-is):** Overstory's `src/agents/hooks-deployer.ts` continues to generate bash scripts that Claude Code runs at tool-use boundaries. Factory Core invokes `ov hooks install` during story setup (via `ov sling`) and does not modify the deployer's script-generation logic. All worktree-path-boundary guards, bash-command blocks, file-modification-by-capability rules, and git-safety enforcements remain exactly where they are today — at the edge, in `/bin/sh`, PATH-minimal, dependency-free.

2. **In-Process Plane (new, lives in `factory-core/src/hooks/`):** A TypeScript hook engine that Factory Core's pipeline calls at phase-boundary transitions (story start, phase completion, BMAD review, fix loop, QA swarm, PR). The in-process engine is where ADR-034's lifted `EnforcementGates`, `IEvaluator` instances, `ShardRetriever`, and QDS-specific evaluators register and execute. Built from scratch in Factory Core — not lifted from `@claude-flow/hooks` — with concepts borrowed from the ruflo design but an implementation bound only to Bun, the TypeScript standard library, and Factory Core's own types.

**Do not lift `@claude-flow/hooks` wholesale.** Verified coupling to ReasoningBank / HNSW / AgentDB / ONNX makes the wholesale lift a 10,925 LOC import that drags a vector store, an ONNX runtime, and a daemon system. None of these are in QDS Factory's MVP scope.

**Do borrow design concepts.** Specifically: priority-based registration, timeout-wrapped execution, pre/post event pairs at edit/task/command boundaries, aggregated hook results with severity propagation, optional statusline integration. These are design patterns, not code; they take ~400 LOC of clean-room implementation against Factory Core's types.

### Architecture Diagram

```text
Developer submits story
         │
         ▼
┌─────────────────────────────┐
│ Factory Core Pipeline       │
│ ─────────────────────────── │
│   Phase: Develop            │
│   ┌───────────────────┐     │
│   │ In-Process Plane  │     │ ◀── ADR-035 scope
│   │ FactoryHookRegistry│    │
│   │                   │     │
│   │ gates (ADR-034)   │     │
│   │ evaluators        │     │
│   │ retriever         │     │
│   └─────────┬─────────┘     │
│             │               │
│   ┌─────────▼────────────┐  │
│   │  ov sling agent      │──┼──▶ spawns worker in tmux/worktree
│   │  (overstory)         │  │
│   └─────────┬────────────┘  │
└─────────────┼───────────────┘
              │
              ▼
        ┌────────────────────────┐
        │  Worker's Claude Code  │
        │  session (in worktree) │
        │                        │
        │  ┌──────────────────┐  │
        │  │   Edge Plane     │  │ ◀── overstory hooks-deployer.ts
        │  │ .claude/         │  │     (unchanged, invoked per tool use)
        │  │  settings.local  │  │
        │  │  .json           │  │
        │  │                  │  │
        │  │ /bin/sh guards:  │  │
        │  │ - path boundary  │  │
        │  │ - bash patterns  │  │
        │  │ - tool blocks    │  │
        │  │ - git safety     │  │
        │  └──────────────────┘  │
        └────────────────────────┘

Phase boundary (Develop → BMAD Review):
         │
         ▼
┌─────────────────────────────┐
│ FactoryHookRegistry         │
│   .execute('phase-end',     │ ◀── gates run here (in-process)
│     {phase, agent, files})  │
│                             │
│   → runs ADR-034 evaluators │
│   → aggregates results      │
│   → blocks or proceeds      │
└─────────────────────────────┘
```

The two planes do not communicate directly. They are coordinated by Factory Core's pipeline engine, which:
- Deploys edge-plane scripts via `ov hooks install` when spawning an agent
- Invokes the in-process plane at phase transitions via `registry.execute(event, context)`
- Reads edge-plane results via overstory's `events.db` event store (edge hook output is recorded there)
- Treats a failure at either plane as a gate failure that stops the pipeline

### Factory Core Hook Engine Contract

The in-process hook engine lives in `factory-core/src/hooks/` with the following module structure:

```text
factory-core/src/hooks/
  types.ts                  // FactoryHookEvent, FactoryHookPriority, FactoryHookContext,
                            //   FactoryHookResult, FactoryHookHandler, FactoryHookRegistration
  registry.ts               // FactoryHookRegistry class — register, unregister, list
  executor.ts               // FactoryHookExecutor class — execute by event, priority ordering,
                            //   timeout wrap, error recovery, result aggregation
  events.ts                 // FactoryHookEvent enum + event name constants
  aggregation.ts            // severity ordering (block > require-confirmation > warn > allow)
                            //   mirrors ADR-034 gates.ts DECISION_SEVERITY
  index.ts                  // Public API: createHookRegistry, createHookExecutor,
                            //   FactoryHooks namespace
  README.md                 // Module-level architecture doc (permitted)
```

**Core types (exact names, to be implemented in `types.ts`):**

```ts
// Event taxonomy — drives the priority taxonomy that evaluators and gates subscribe to
export enum FactoryHookEvent {
  PhaseStart = "phase-start",
  PhaseEnd = "phase-end",
  PreToolUse = "pre-tool-use",        // in-process mirror of Claude Code's pre-tool-use
  PostToolUse = "post-tool-use",
  PreEdit = "pre-edit",
  PostEdit = "post-edit",
  PreCommand = "pre-command",
  PostCommand = "post-command",
  PreTask = "pre-task",
  PostTask = "post-task",
  SessionStart = "session-start",
  SessionEnd = "session-end",
  AgentSpawn = "agent-spawn",
  AgentComplete = "agent-complete",
  ReviewStart = "review-start",
  ReviewEnd = "review-end",
}

// Priority ordering — lower number = higher priority (runs first)
export enum FactoryHookPriority {
  Critical = 0,   // Credential / secrets / irreversible actions
  High = 10,      // Destructive ops, git safety
  Normal = 50,    // Standard gates and evaluators
  Low = 100,      // Telemetry, statusline
  Background = 1000, // Async side effects
}

export interface FactoryHookContext {
  readonly event: FactoryHookEvent;
  readonly storyId: string;
  readonly phase: string;
  readonly agent?: { name: string; capability: string };
  readonly worktreePath?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly startedAt: Date;
}

export type FactoryHookDecision = "block" | "require-confirmation" | "warn" | "allow";

export interface FactoryHookResult {
  readonly decision: FactoryHookDecision;
  readonly reason?: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly durationMs: number;
}

export type FactoryHookHandler = (
  ctx: FactoryHookContext,
) => Promise<FactoryHookResult>;

export interface FactoryHookRegistration {
  readonly id: string;
  readonly event: FactoryHookEvent;
  readonly priority: FactoryHookPriority;
  readonly handler: FactoryHookHandler;
  readonly name: string;
  readonly timeoutMs: number; // per-registration timeout
}
```

**Registry contract (`registry.ts`):**

```ts
export class FactoryHookRegistry {
  register(
    event: FactoryHookEvent,
    handler: FactoryHookHandler,
    options: {
      priority?: FactoryHookPriority;
      name: string;
      timeoutMs?: number;
    },
  ): string; // returns registration id

  unregister(id: string): boolean;
  list(event?: FactoryHookEvent): readonly FactoryHookRegistration[];
  clear(): void;
}
```

**Executor contract (`executor.ts`):**

```ts
export interface FactoryHookExecutionResult {
  readonly event: FactoryHookEvent;
  readonly decision: FactoryHookDecision; // aggregated, most severe wins
  readonly results: readonly FactoryHookResult[];
  readonly durationMs: number;
  readonly succeeded: boolean; // false if any handler threw or timed out
}

export class FactoryHookExecutor {
  constructor(registry: FactoryHookRegistry);

  execute(
    event: FactoryHookEvent,
    contextInit: Omit<FactoryHookContext, "event" | "startedAt">,
  ): Promise<FactoryHookExecutionResult>;
}
```

**Execution semantics:**

1. Handlers for a given event run in **priority order** (Critical first, Background last). Ties broken by registration order.
2. Each handler is **wrapped in a timeout** (default 5,000 ms, per-registration override). Timeout produces a `FactoryHookResult` with `decision: "block"` and `reason: "hook timeout"` — timeouts are treated as failures, not as allow-by-default.
3. Handler exceptions are **caught and converted** to `FactoryHookResult` with `decision: "block"` and `reason` containing the error message. Unhandled exceptions must never crash Factory Core's pipeline.
4. After all handlers run, **aggregate using severity ordering**: `block > require-confirmation > warn > allow`. Reuses the exact same severity-ordering constant from ADR-034's `gates.ts` so the two layers speak the same language.
5. Execution is **synchronous from the pipeline's perspective** — the pipeline awaits `execute()` and acts on the aggregated result. No fire-and-forget.
6. **Every execution emits an event record** to `pipeline.db` (or a new `hooks.db` if schema pressure justifies splitting — decision deferred to Story 1.2 migration review). The event record includes: story ID, phase, event, duration, decision, per-handler results, any errors.

### Borrowed Concepts from `@claude-flow/hooks` (design patterns, not code)

| Ruflo concept | How it appears in Factory Core hook engine | Why |
|---|---|---|
| Priority-based registration | `FactoryHookPriority` enum + sorted execution | Critical gates (credentials, git safety) must run before telemetry |
| Hook registry + executor split | `FactoryHookRegistry` (storage) + `FactoryHookExecutor` (execution semantics) | Separation of concerns — registry is a pure data structure, executor owns timeout + error handling |
| Pre/post event pairs | `PreEdit`/`PostEdit`, `PreCommand`/`PostCommand`, `PreTask`/`PostTask` | Before-action blocking + after-action recording |
| Session boundary events | `SessionStart`/`SessionEnd` | Context loading + cleanup hooks |
| Agent lifecycle events | `AgentSpawn`/`AgentComplete` | Overlay injection + result capture per worker |
| Typed result aggregation | `FactoryHookExecutionResult` with most-severe-wins aggregation | Multiple gates for one event need a single pipeline verdict |
| Timeout-wrapped execution | Per-registration `timeoutMs` with default 5,000 ms | Hooks must not hang the pipeline |
| Statusline integration | **Deferred to Growth phase, not MVP** | Nice-to-have — adds dashboard polish without serving an invariant |
| ReasoningBank / HNSW / ONNX learning | **Rejected, not borrowed** | Out of scope for MVP per session 12 findings and ADR-034 |
| Background daemons | **Rejected, not borrowed** | Factory Core runs on demand, not as a daemon system |
| MCP tool definitions | **Rejected, not borrowed** | MCP tools are a ruflo-specific delivery mechanism |
| Swarm communication / workers | **Rejected, not borrowed** | Factory Core uses Bun subprocesses directly |
| V2 compatibility layer | **Rejected, not borrowed** | No legacy to maintain |
| Official hooks bridge | **Not borrowed — overstory already owns this surface** | Edge plane is overstory's domain |

### Edge Plane Integration (overstory side, unchanged)

Factory Core does **not modify** `overstory/src/agents/hooks-deployer.ts`. The edge plane is owned by overstory upstream and remains a fork-hygiene concern. Factory Core's integration with the edge plane is:

1. **Spawn-time deployment.** When the pipeline invokes `ov sling` to spawn a worker, overstory's existing `hooks-deployer.ts` writes `.claude/settings.local.json` to the worktree with path-boundary guards, bash-pattern guards, capability-based file-modification guards, and git-safety guards. This is the existing code path and requires zero change from Factory Core.

2. **Edge hook result reading.** Edge-plane hook executions are recorded by overstory in `events.db` (`EventType: hook_result`, added via Story 1.6 table-rebuild per ADR-024 Section 2). Factory Core's pipeline polls `events.db` for phase-relevant hook results when evaluating phase-completion. This is a one-way data flow: edge plane writes, Factory Core reads.

3. **Edge hook extension.** When a QDS-specific edge rule is needed (e.g., a new `factory.yaml` policy that should block a specific bash command pattern), the correct path is: (a) add the rule to overstory upstream via PR, OR (b) add a tagged `// QDS:` change to `hooks-deployer.ts` following the fork-hygiene rules in `overstory/CLAUDE.md`. Do **not** duplicate edge-plane logic in Factory Core's in-process plane.

4. **Dual-plane gate at phase boundaries.** Phase transitions invoke both planes:
   - Factory Core calls `registry.execute(FactoryHookEvent.PhaseEnd, {...})` (in-process plane)
   - Factory Core reads `events.db` for any unresolved `hook_result` events from the phase's worker (edge plane)
   - Both must clear for the phase to advance

This is the "6-layer enforcement" from the existing architecture-v2.md (ADR-010) restated in mechanism-vs-invariant terms: the invariant is "gated mechanical verification at phase boundaries"; the mechanism is "edge-plane scripts + in-process engine, coordinated by the pipeline."

### Alternatives Considered

| Option | Pros | Cons | Outcome |
|---|---|---|---|
| **A. Dual-plane (chosen)** | Reuses overstory's battle-tested edge plane without modification; in-process plane is minimal, typed, dependency-free; guidance lift binds against in-process plane cleanly; each plane does what it's good at | Two layers mean two places to think about; pipeline must coordinate reads from `events.db` and in-process results | **Accepted** |
| **B. Lift `@claude-flow/hooks` wholesale into Factory Core** | Matches ruflo's architecture end-to-end; statusline + daemons come for free | 10,925 LOC import; drags ReasoningBank / HNSW / ONNX / AgentDB per verified cypher evidence; duplicates overstory's edge-plane work; incompatible with Bun's zero-runtime-deps approach; multiplies fork-hygiene cost | **Rejected** — session 12 explicitly called this out as a trap |
| **C. Replace overstory's edge plane with a Factory Core in-process equivalent** | Single plane; fewer integration seams | Re-implements 606 LOC of hardened shell-script generation inside TypeScript, then has to reinvent the POSIX shell execution path that Claude Code already wires to `settings.local.json`; abandons overstory upstream surface | **Rejected** — moves work from a solved problem to an unsolved one |
| **D. Move everything to the edge plane (extend `hooks-deployer.ts`)** | Single architecture; no in-process engine | ADR-034's `EnforcementGates` and `IEvaluator` implementations are TypeScript classes; serializing them to bash would destroy type safety and defeat the lift's purpose; bash gate scripts cannot run async I/O at the scale guidance needs | **Rejected** — wrong runtime layer for the lifted code |
| **E. Adopt overstory's edge plane AND build the in-process plane as a thin wrapper around a third-party Node hook library** | Off-the-shelf code for priority/timeout/registration | No Node hook library has Factory Core's typed context shape; adapters would cost more than building from scratch; introduces a dependency QDS has no control over | **Rejected** — ~400 LOC clean-room implementation is cheaper and typed |

### Consequences

**Positive:**

- ADR-034's lifted guidance code has a typed, dependency-free home (`factory-core/src/hooks/` + `factory-core/src/guidance/`). The hooks-adapter file (Tier 5 in ADR-034) binds against `FactoryHookRegistry` with a known contract.
- Overstory's edge plane stays untouched, which preserves the fork-hygiene property that upstream sync remains cheap.
- Invariant 5 (mechanical gates at phase boundaries) is operationalized at two layers, with each layer using the runtime that suits its workload — shell scripts for edge checks, TypeScript classes for semantic gates and evaluators.
- The in-process engine is small (~400 LOC clean-room + ~100 LOC tests) and avoids the 10,925 LOC trap.
- The execution semantics (priority ordering, timeout-wrap, exception-to-result conversion, most-severe-wins aggregation) are borrowed from ruflo's design and proven elsewhere, so the risk of design mistakes is lower than a pure greenfield.

**Negative:**

- Pipeline code now coordinates two planes (`events.db` poll + `registry.execute()` await). This is a single place in `factory-core/src/pipeline/` — bounded complexity — but it is complexity that did not exist before.
- Edge-plane extensions still require fork edits to `hooks-deployer.ts`, which remains a fork-hygiene cost (this was already true pre-ADR-035; it is explicit now).
- The in-process hook engine is new code. Writing it to a PhD-level bar means test coverage, property tests for the aggregation function, and integration tests against the lifted guidance code. Estimate: ~16–24 hours of careful implementation + review.

**Neutral:**

- Statusline integration is possible later if the dashboard wants it (the `FactoryHookRegistry` can register a low-priority background handler that updates a dashboard stream). Deferred to Growth.
- ReasoningBank is **not** part of QDS Factory. Future learning-loop work can be added as evaluators that implement `IEvaluator` against `attribution.db` + `pipeline.db` + overstory's `events.db` / `metrics.db` — a far smaller bet than adopting ruflo's vector stack.

### Implementation Notes

- **Module location:** `factory-core/src/hooks/` — a new subsystem, peer to `factory-core/src/guidance/` (created by Story 1.7). The two communicate via the tier-5 adapter in ADR-034.
- **Single story carries this ADR.** ADR-035 does **not** add a new story. The in-process hook engine is implemented inside Story 1.7's adapter phase: the adapter file (`hooks-adapter.ts`) needs a hook engine to bind against, so Story 1.7 builds the minimal engine as a prerequisite for the adapter. If Story 1.7's scope grows beyond its 3-day spike + adapter budget, create a follow-up Story 1.8 for the hook engine as a standalone deliverable (but do not pre-emptively split — wait for measured evidence from the spike).
- **Tests before gates.** Property-test the aggregation function against random `FactoryHookResult` arrays. Integration-test a synthetic pipeline that registers 3 gates (one critical, one normal, one background) and verifies priority ordering + timeout behavior. Target: ≥ 95% line coverage on `executor.ts` because it is the dangerous file.
- **No global singletons.** Unlike ruflo's `defaultRegistry` / `defaultExecutor` / `initializeHooks()` singleton pattern, Factory Core's hook engine is **instance-based**. The pipeline owns one registry per story (or one per phase, if that turns out to be cleaner) and disposes it at phase end. This prevents state leakage across stories — which is itself a manifestation of invariant 1 (context isolation).
- **No daemons.** Factory Core is a pipeline system, not a long-running daemon. Hooks run synchronously during pipeline transitions and terminate when the pipeline does.

### Acceptance Criteria

- [x] ADR-035 present in `architecture-v2-session12-amendments.md`
- [x] Dual-plane architecture documented with diagram and responsibility split
- [x] Edge plane explicitly marked as unchanged / owned by overstory
- [x] In-process plane contract (types, registry, executor, semantics) specified with exact type signatures
- [x] Borrowed concepts from ruflo explicitly listed as patterns, not code
- [x] Rejected concepts from ruflo explicitly listed with reason
- [x] Alternatives A–E considered and rejected with rationale
- [x] Implementation responsibility assigned to Story 1.7 (ADR-034's story); no new story created
- [ ] `architecture-v2.md` ADR-010 (6-layer hook pipeline) cross-reference updated to mention ADR-035 *(Step 5 of session 13)*
- [ ] `code-lift-manifest.md` includes the "no wholesale lift of `@claude-flow/hooks`" entry *(Step 4 of session 13)*

### References

- `overstory/src/agents/hooks-deployer.ts` (606 LOC, session-13 direct read lines 60–284) — the edge plane, unchanged
- `overstory/src/agents/guard-rules.ts` — shared constants (`DANGEROUS_BASH_PATTERNS`, `SAFE_BASH_PREFIXES`, `WRITE_TOOLS`, `INTERACTIVE_TOOLS`) referenced by both planes
- `overstory/src/runtimes/pi-guards.ts` — `NON_IMPLEMENTATION_CAPABILITIES` constant, part of the edge-plane enforcement
- `_research-repos/ruflo/v3/@claude-flow/hooks/src/index.ts` (session-13 direct read) — the design source for borrowed concepts; NOT a lift target
- `_research-repos/ruflo/v3/@claude-flow/hooks/` (10,925 LOC total) — verified outbound coupling to ReasoningBank/HNSW/ONNX/AgentDB via session-12 cypher queries
- `factory-core/src/hooks/` (to be created in Story 1.7) — the in-process plane home
- `factory-core/src/guidance/hooks-adapter.ts` (to be created in Story 1.7 per ADR-034 Tier 5) — the binding between ADR-034's lifted guidance code and ADR-035's hook engine
- `events.db` (overstory-owned, extended by Story 1.6) — `hook_result` EventType is the edge-plane → Factory Core data channel
- ADR-010 (architecture-v2.md) — the existing 6-layer hook pipeline specification, reframed here as "invariant = gated mechanical verification; mechanism = dual-plane"
- ADR-013 (architecture-v2.md) — Superpowers enforcement metadata in skill `description` field; ADR-035 hook engine consumes this via skill middleware (Story 2.6), not via direct import
- ADR-033 (this file) — orchestrator foundation this hook engine lives on top of
- ADR-034 (this file) — the consumer of this hook engine

---

*End of session 12 amendments. ADR-033, ADR-034, ADR-035 are authoritative and supersede any contradictory text in `architecture-v2.md`, prior session amendments, or the original session 12 findings document regarding orchestrator identity, enforcement layer source, and hook engine architecture. Downstream artifact updates (code-lift manifest, gap analysis, architecture-v2.md corrections) are tracked as Steps 4 and 5 of session 13.*

