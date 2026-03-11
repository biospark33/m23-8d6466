# Session 9 Handoff — Artifact Consolidation & Epic/Story Decomposition

**Date:** 2026-03-10
**From:** Session 8 (Adversarial synthesis — 3 amendment documents produced, cross-validated)
**To:** New conversation for artifact consolidation and implementation planning
**Goal:** Merge Session 8 amendments into canonical planning artifacts, then decompose the consolidated system into implementable epics and stories

---

## Session 8 Recap: What Was Done

Session 8 transformed 130+ adversarial review findings (19 critical) from Session 7's 11-agent review into three concrete amendment documents. All three deliverables were produced by parallel subagents and cross-validated in a Phase 3 integration review.

### Deliverables Produced

| # | File | Lines | Summary |
|---|------|-------|---------|
| 1 | `prd-amendments-session8.md` | ~450 | Revised FR130-FR160, 11 new FRs (FR161-FR171), MVP/Growth split (145 MVP / 26 Growth), 6 revised NFRs, design inspiration table, retired concepts appendix |
| 2 | `architecture-amendments-session8.md` | ~1,530 | 6 revised ADRs (015-020), 3 new ADRs (021-023), ~2,850 LOC file inventory, single source of truth resolution, epic-level context architecture, 3-layer learning system |
| 3 | `ux-amendments-session8.md` | ~500 | 5 missing UX paths resolved (COMP-020 through COMP-024), 5 new panels, 11 new components, 3 interaction modes, keyboard shortcuts |

### Integration Review Results

| Check | Result |
|-------|--------|
| PRD <-> Architecture alignment | PASS (1 minor: FR132 says `session_scores`, architecture says `session_composites` — architecture is canonical) |
| New ADRs vs existing ADR-001-014 | PASS (no contradictions) |
| System buildability | PASS (~2,850 LOC new-write, no circular deps, single DB access pattern) |
| Every FR has architectural home | PASS |
| Every ADR has exercising FR | PASS |
| UX <-> PRD <-> Architecture alignment | PASS (1 minor: subsystem naming difference in UX vs architecture — assessed as intentional user-facing vs implementation-facing grouping) |

### Critical Decisions Made in Session 8

| Decision | Rationale |
|----------|-----------|
| **Factory Core is the FOUNDATION** — Overstory, Pi SDK, Superpowers, Seeds are COMPONENTS it calls into | Corrected Session 6 framing that treated them as peers |
| **Research repos are DESIGN INSPIRATION** — not transplant sources | "Transplant" framing killed; all code is new-write inspired by patterns |
| **Credit economy KILLED** (ECON-001) | Solves non-existent problem in single-principal system |
| **Per-agent budgets KILLED** (ECON-002) | Creates deadlocks; replaced with per-story + global enforcement |
| **Drizzle ORM KILLED** | `bun:sqlite` only — matches Overstory's existing pattern |
| **YAML as primary store KILLED** (CONS-002) | `pipeline.db` is sole source of truth; YAML = read-only exports |
| **Autonomous merge is the DEFAULT** | Human review is escalation-only, not the norm |
| **Maintenance burden is the PRIMARY metric** | Not agent scores or credits — the observable outcome of code quality improving |
| **MVP = Layers 1-3 (data collection only)** | No behavioral effects (ELO routing, tier-based hook density) until Growth |
| **Bidirectional middleware chain is organizational pattern** | Not a new runtime engine — structures existing overlay + hook logic |

---

## What Session 9 Must Do

### Mission: Consolidate, Then Decompose

Session 8 produced amendment documents that sit alongside the original artifacts. Session 9 has two jobs:

**Job 1: Merge amendments into canonical artifacts.** The PRD, architecture, and UX spec currently have two versions each — the Session 6 originals and the Session 8 amendments. These must be merged into single, coherent documents that represent the current state of the system design. A new conversation will not know which version to trust unless there is one canonical document per artifact.

**Job 2: Decompose the consolidated system into epics and stories.** The PRD has 171 FRs (145 MVP, 26 Growth), the architecture has 23 ADRs, and the UX spec has ~50 components. These must be broken into implementable epics with prioritized, dependency-ordered stories ready for Overstory to execute.

---

## Job 1: Artifact Consolidation

### What Needs to Happen

For each of the three artifact pairs (original + amendments), produce a single consolidated document:

#### 1a. Consolidated PRD
**Input:** `prd.md` (1,225 lines) + `prd-amendments-session8.md` (~450 lines)
**Output:** `prd-v2.md`
**Rules:**
- FR130-FR160: Replace original versions with Session 8 revised versions
- FR161-FR171: Insert as new sections
- NFR35-NFR40: Replace/add per Session 8
- Transplant Inventory appendix: Replace entirely with Design Inspiration Reference table
- MVP Feature Set section: Replace with Session 8's definitive MVP/Growth split (145 MVP / 26 Growth)
- Retired Concepts appendix: Add from Session 8
- Section 1 preamble: Update component relationships per Session 8 reframing
- Fix FR132 reference: Change `session_scores` to `session_composites`
- FR1-FR129: UNCHANGED — do not modify any original FRs that Session 8 did not amend

#### 1b. Consolidated Architecture
**Input:** `architecture.md` (2,114 lines) + `architecture-amendments-session8.md` (~1,530 lines)
**Output:** `architecture-v2.md`
**Rules:**
- ADR-015 through ADR-020: Replace original versions with Session 8 revised versions
- ADR-021, ADR-022, ADR-023: Insert as new ADRs
- Cross-ADR implications table: Replace with Session 8's revised version (Section 11)
- Canonical Reference Locations table: Replace with Session 8's amended version (Appendix C)
- Single Source of Truth section: Add Section 12 content
- Epic-Level Context section: Add Section 13 content
- Preamble: Update component relationships per Session 8 reframing
- ADR-001 through ADR-014: UNCHANGED — do not modify any original ADRs
- Project directory structure: Update to reflect new `factory-core/src/` subdirectories (middleware/, notifications/, health/, learning/, verification/)

#### 1c. Consolidated UX Specification
**Input:** `ux-design-specification.md` (1,939 lines) + `ux-amendments-session8.md` (~500 lines)
**Output:** `ux-design-specification-v2.md`
**Rules:**
- Performance Dashboard Surface: Replace with Session 8 revised version (Section 2)
- New panels: Insert Learning Effectiveness (Section 3), Burn Rate Prediction (Section 4), System Health (Section 5), Epic Progress (Section 6), Channel Status (Section 7)
- Copilot interactions: Merge Session 8 additions (Section 8) into existing Copilot section
- Interaction Patterns: Merge Session 8's three-mode model (Section 9) into existing patterns
- Dashboard Layout: Update viewport composition per Session 8 Section 10
- AmbientHeader: Update to include health badge and maintenance sparkline
- Navigation: Add Epic Progress route
- Component inventory: Add 11 new components from Session 8 Section 10
- Credit Balance Display: REMOVE from Performance Card (ECON-001)
- Per-agent budget bar: REMOVE from Performance Card (ECON-002)
- All other sections: UNCHANGED

### Consolidation Quality Gates

After merging, verify:
- No FR references a killed concept (credit economy, per-agent budgets, transplant inventory, Drizzle ORM)
- No ADR contradicts another ADR
- Every FR in the MVP set has a clear architectural home
- Every new ADR (021-023) has at least one FR that exercises it
- Component cross-references in UX spec match PRD FR numbers
- No duplicate FR numbers, no gaps in FR numbering

---

## Job 2: Epic & Story Decomposition

### The System Being Built

QDS Engineer v2 is a self-learning agentic development harness. It executes entire epics through a phased quality pipeline, with code merging automatically and 24/7 maintenance agents catching residual issues. The system learns from every session so subsequent sessions produce better code with less maintenance burden.

### Component Architecture (from consolidated artifacts)

| Package | Purpose | Key Files |
|---------|---------|-----------|
| **factory-core** | Pipeline engine, phase management, economic governance, learning system, middleware chain, verification, notifications, health monitoring | ~2,850 LOC new-write across 35 files |
| **shared-types** | Zod schemas, TypeScript interfaces shared across packages | performance.ts, must-haves.ts, middleware.ts, health.ts, result.ts, notifications.ts |
| **dashboard** | React + CopilotKit frontend showing pipeline state, performance data, learning effectiveness, system health | Existing surfaces + 5 new panels, 11 new components |
| **gateway** | SSE/WS server bridging Overstory event stores to dashboard | Existing (ADR-009), minor extensions for new event types |
| **messenger** | Telegram bot for notifications and developer dialogue | Existing (ADR-014), wrapped by Factory Core's TelegramChannel adapter |

### Existing Components (NOT being built, already exist)

| Component | Status | Relationship |
|-----------|--------|-------------|
| **Overstory** | Production-ready (186 TS files, 4 SQLite DBs) | Factory Core calls into it |
| **Pi SDK** | Production-ready (7 packages, 18+ providers) | Factory Core configures and uses it |
| **Superpowers** | Production-ready (14 skills) | Factory Core reads metadata |
| **Seeds** | Production-ready (inside Overstory) | Factory Core creates tasks, Seeds tracks them |

### Suggested Epic Structure

The following is a starting-point decomposition. Session 9 agents should challenge, refine, and reorder this based on dependency analysis. All epics are MVP unless marked Growth.

#### Epic 1: Foundation — Pipeline DB, Shared Types, Factory Core Skeleton
**Why first:** Everything depends on `pipeline.db` schema, shared types, and the basic Factory Core process that reads `factory.yaml` and initializes SQLite databases.

Key stories:
- Define `shared-types` package with all Zod schemas (performance, must-haves, middleware, health, result, notifications)
- Create `pipeline.db` migration system and initial schema (6 MVP tables: action_scores, confidence_declarations, session_composites, learning_records, turn_state, epics/epic_context)
- Create `attribution.db` schema extension (task_checkouts table)
- Factory Core process skeleton: read `factory.yaml`, init databases, Object.freeze config
- Result<T> utility type and toResult/toResultAsync helpers

#### Epic 2: Middleware Chain — Overlay Composition Restructure
**Why second:** The middleware chain (ADR-021) restructures how overlays are composed. Every subsequent epic that injects content into overlays depends on this structure existing.

Key stories:
- Middleware interface definitions and chain executor
- Budget middleware (before: check ceiling, after: record cost)
- Credential middleware (before: inject keys, after: sanitize output)
- Learning middleware (before: query learnings, after: extract new learnings)
- Enforcement middleware (before: inject rules, after: log gate results)
- Skill middleware (before: inject descriptions, after: no-op)
- Verification middleware (before: inject must_haves, after: run lightweight check)
- Performance middleware stub (Growth behavioral effects disabled, data collection active)

#### Epic 3: Continuous Verification — Lightweight + Full Nyquist
**Why third:** Verification is the quality backbone. Without it, the pipeline has no way to confirm work was done correctly.

Key stories:
- `must_haves` schema parser and validator
- Lightweight continuous verifier (filesystem-only structural checks)
- Integration: lightweight verifier as post-task hook
- Full Nyquist verifier (LLM-powered behavioral + structural)
- Pre-BMAD structural gate
- Oscillation detector for false negative fix-loops
- Nyquist-BMAD disagreement protocol implementation

#### Epic 4: Turn Continuation & Workspace Lifecycle
**Why fourth:** Turn continuation (ADR-019) and workspace hooks (ADR-018) are the execution mechanics that keep agents running and worktrees healthy.

Key stories:
- Turn continuation loop with lightweight per-turn signals
- Progress velocity check (conditional max_turns extension)
- Turn state persistence in pipeline.db
- Continuation prompt template injection
- Workspace lifecycle hooks (after_create, before_run, after_run, before_remove)
- Hook rollback on partial failure (worktree cleanup on after_create failure)
- Stall detection integration (per-turn timeout, not per-phase)

#### Epic 5: Performance Data Collection (MVP Layers 1-3)
**Why fifth:** Now that the pipeline infrastructure exists, add the observation layer.

Key stories:
- Action scorer module (compute scores from hook results)
- Confidence calibration tracker with resolution requirement
- Session composite aggregation on story completion
- Integration: action scorer triggered from performance-middleware afterModel()
- Learning record extractor (from fix-loops and maintenance fixes)
- Overlay effectiveness tracker

#### Epic 6: Economic Governance
**Why sixth:** Cost controls need the pipeline running to enforce.

Key stories:
- Per-story budget enforcement (check before phase spawn)
- Global daily/monthly ceiling enforcement
- Atomic task checkout via attribution.db
- Cost data flow: Pi SDK Usage callback -> attribution.db -> cumulative queries
- Burn rate prediction computation
- Budget breach notification via messenger

#### Epic 7: Learning System & Epic Context
**Why seventh:** The learning system depends on data flowing through the performance layer and verification layer.

Key stories:
- Learning record extraction from fix-loops
- Learning record extraction from maintenance agent fixes
- Pattern knowledge mining (cross-story correlations) — Growth
- Epic context tables in pipeline.db
- Epic context assembly for overlay injection (token-budgeted)
- Epic context extraction on story completion
- Overlay enrichment with learning records

#### Epic 8: Notifications & Health Monitoring
**Why eighth:** Notification abstraction and circuit breaker are operational concerns that improve reliability but don't block core pipeline functionality.

Key stories:
- Channel interface and MessageBus implementation
- TelegramChannel adapter wrapping existing messenger package
- Webhook channel (generic extensibility)
- Notification routing configuration in factory.yaml
- Circuit breaker state machine (CLOSED/OPEN/HALF_OPEN)
- Subsystem health monitor (7 monitored subsystems)
- Automatic mitigations (pause story starts, double timeouts)
- Health state events in events.db

#### Epic 9: Dashboard Extensions
**Why ninth:** Dashboard surfaces depend on all backend data being available.

Key stories:
- Revised Performance Dashboard (empty states, tier transitions, trends tab, error states, loading states)
- Learning Effectiveness Panel (maintenance burden trend, learning records feed, overlay enrichment depth, pattern knowledge map)
- Burn Rate Prediction Panel (per-story burn cards, projected breach alerts, historical trend)
- System Health Indicator (header badge, expandable subsystem list)
- Epic Progress View (epic list, Gantt-style story timeline, epic economics, epic learning metrics)
- Revised Copilot interactions (7 new copilot capabilities)
- AmbientHeader updates (health badge, maintenance sparkline)

#### Epic 10: Growth Phase — Behavioral Effects (Growth)
**Why last:** ELO routing, tier-based hook density, and performance-based routing all require 20+ stories of data to be meaningful.

Key stories:
- ELO domain rating computation
- Tier evaluation with 50-point hysteresis and 3-story dwell
- Tier demotion logic
- Performance-based task routing with 15% exploration factor
- Random audit mechanism (1 in 3 stories for Tier 3+)
- Anti-gaming protections (no self-tier injection, immutable scoring weights)
- ELO migration strategy (versioned rating epochs)
- Channel Status panel (Slack/Discord/webhook channels)
- Pattern knowledge mining (cross-story correlations)

### Dependency Chain

```
Epic 1 (Foundation)
  -> Epic 2 (Middleware Chain)
    -> Epic 3 (Verification)
    -> Epic 4 (Turn Continuation & Hooks)
    -> Epic 5 (Performance Data Collection)
      -> Epic 6 (Economic Governance)
      -> Epic 7 (Learning System)
        -> Epic 8 (Notifications & Health)
          -> Epic 9 (Dashboard Extensions)
            -> Epic 10 (Growth Behavioral Effects)
```

Epics 3, 4, and 5 can potentially run in parallel after Epic 2 completes (they depend on the middleware chain but not on each other).

---

## Files to Read (in order of priority)

### Amendment Documents (Session 8 outputs — read these first)

| # | File | Lines | What It Contains |
|---|------|-------|-----------------|
| 1 | `prd-amendments-session8.md` | ~450 | Revised FR130-FR160, FR161-FR171, MVP/Growth split, NFRs, design inspiration table |
| 2 | `architecture-amendments-session8.md` | ~1,530 | Revised ADR-015-020, new ADR-021-023, learning system, epic context, source of truth resolution, ~2,850 LOC file inventory |
| 3 | `ux-amendments-session8.md` | ~500 | 5 resolved UX paths, 5 new panels, 11 new components, 3 interaction modes |

### Original Artifacts (to be merged with amendments)

| # | File | Lines | What It Contains |
|---|------|-------|-----------------|
| 4 | `prd.md` | 1,225 | Full PRD with FR1-FR160 (FR130-FR160 to be replaced), 38 NFRs |
| 5 | `architecture.md` | 2,114 | 20 ADRs (ADR-001-020), cross-ADR implications, canonical references |
| 6 | `ux-design-specification.md` | 1,939 | Full UX spec with all dashboard surfaces, component inventory, design system |

### Session History (for context only — do not read unless needed)

| # | File | Purpose |
|---|------|---------|
| 7 | `adversarial-review-findings-session7.md` | All 130+ findings from Session 7 (already resolved in amendments) |
| 8 | `super-system-synthesis-handoff-session8.md` | Session 8 mission document |
| 9 | `architecture-handoff-prompt-session5.md` | Session 5/6 context |

### Existing Codebase (for implementation reference)

| # | Path | What's There |
|---|------|-------------|
| 10 | `overstory/` | Production Overstory (186 TS files, 4 SQLite DBs, ov sling, seeds, watchdog, merge) |
| 11 | `pi-mono/` | Production Pi SDK (7 packages, 18+ providers, Usage tracking) |
| 12 | `superpowers/` | Production skills library (14 skills, YAML frontmatter, skill discovery) |

---

## Key Constraints and Guardrails

### What Is Settled (Do Not Reopen)

These decisions were made in Sessions 7-8 with full adversarial review. Do not revisit:

- Factory Core is the foundation; Overstory/Pi/Superpowers are components
- Credit economy is dead — weighted composite routing in Growth instead
- Per-agent budgets are dead — per-story + global enforcement instead
- Drizzle ORM is dead — `bun:sqlite` only, matching Overstory
- YAML is never a primary store — read-only exports from SQLite
- Research repos are inspiration, not transplant sources
- Autonomous merge is the default; human review is escalation-only
- L3 phase boundary hooks are mandatory for ALL tiers
- Maintenance burden is the primary learning system metric
- MVP = Layers 1-3 (data collection); Growth = Layers 4-6 (behavioral effects)

### What Remains Open for Session 9

- Story sizing and ordering within epics
- Whether some epics should be split further or combined
- Integration test strategy across epics
- Whether Epic 9 (Dashboard) should be interleaved with backend epics for incremental visibility
- Exact story acceptance criteria
- Whether to create a "vertical slice" epic that proves the full pipeline end-to-end before building out all capabilities

---

## Success Criteria for Session 9

1. Three consolidated artifacts exist (`prd-v2.md`, `architecture-v2.md`, `ux-design-specification-v2.md`) with all Session 8 amendments merged
2. Consolidation quality gates pass (no killed concepts referenced, no ADR contradictions, FR-to-ADR traceability complete)
3. Epic decomposition exists with dependency-ordered stories
4. Each story has: title, acceptance criteria, FR references, ADR references, estimated LOC, dependencies
5. Stories are sized for single-agent execution (target: 1-3 files modified per story, <500 LOC per story)
6. The first 3 epics have stories detailed enough to begin implementation in Session 10

---

## How to Run Session 9

### Recommended Approach

1. **Start with Job 1 (consolidation)** — this is mechanical merge work best done with subagents in parallel (one per artifact pair)
2. **Verify consolidation** — run quality gates against the three consolidated documents
3. **Then Job 2 (decomposition)** — use the consolidated artifacts as input; decompose into epics and stories using BMAD Scrum Master (Bob) and Architect (Winston) personas
4. **Consider a vertical slice epic** — an "Epic 0" that proves the full pipeline from `factory.yaml` read through agent spawn, hook execution, action scoring, and learning record extraction for a single simple story. This validates the architecture before building out full breadth.

### Agent Assignments

- **Consolidation agents** (parallel): One per artifact, merge mechanically following the rules above
- **Decomposition agents**: Architect (dependency analysis, integration points), Scrum Master (story sizing, acceptance criteria), Dev Lead (LOC estimates, implementation sequence)
- **Validation agent**: Cross-references all consolidated artifacts against each other and against the epic/story decomposition

---

## Pipeline Summary (What the System Looks Like When Built)

```
Developer submits story spec with must_haves
  -> Factory Core reads factory.yaml config (frozen)
  -> Factory Core checks epic context (pipeline.db)
  -> Middleware chain beforeModel():
     [budget] -> [credential] -> [learning] -> [enforcement] -> [skill] -> [verification]
  -> Factory Core assembles overlay from middleware outputs
  -> Factory Core creates Seeds task, calls ov sling
  -> Overstory spawns agent in isolated worktree
  -> Agent executes turns (Pi SDK model calls)
     -> Per-turn: post-task hook -> action score -> lightweight structural check
     -> Turn continuation if goal not achieved and turns remain
     -> Progress velocity extension if >75% complete at max_turns
  -> Phase boundary: transfer manifest, confidence declaration, context isolation
  -> BMAD review by fresh agents (no dev context)
  -> QA swarm (5 waves)
  -> Full Nyquist verification at QA boundary
  -> Fix loop if gaps found (oscillation detection, max 2 identical gap lists)
  -> Middleware chain afterModel():
     [budget] -> [credential] -> [learning] -> [enforcement] -> [skill] -> [verification]
  -> Learning record extraction, epic context update
  -> Autonomous merge (no human gate)
  -> 24/7 maintenance agents scan for regressions
  -> Maintenance fixes -> categorized learning records -> overlay enrichment
  -> Next story gets richer overlay -> less maintenance -> trend toward zero
```

---

*Generated as Session 9 handoff from Session 8 adversarial synthesis. All 19 critical findings from Session 7 are resolved. System design is internally consistent across PRD, architecture, and UX artifacts.*
