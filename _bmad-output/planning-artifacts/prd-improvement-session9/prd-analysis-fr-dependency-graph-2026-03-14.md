# FR Dependency Graph & Critical Path Analysis
## QDS Engineer v2 — PRD v2.0
**Date:** 2026-03-14
**Source:** prd-v2.md (consolidated from base PRD + Session 8 amendments)
**Analyst:** Claude Sonnet 4.6 via QDS Factory Agent

---

## 1. Methodology

This analysis treats every Functional Requirement as a node in a directed acyclic graph (DAG). An edge A → B means "FR-A must exist (or be in progress) before FR-B can function correctly." Dependency types recognized:

- **Hard runtime dependency** — FR-B cannot execute at all without FR-A
- **Data dependency** — FR-B reads data produced/stored by FR-A
- **Extension dependency** — FR-B is explicitly described as extending FR-A
- **Gate dependency** — FR-B's quality/enforcement logic relies on FR-A having fired first
- **Schema dependency** — FR-B writes to or reads from a table first created by FR-A

Sources of truth used: explicit "Component integration" notes in FR130–FR171, the Implementation Sequencing section, and cross-references embedded in the FR text.

---

## 2. Dependency Map — FR Blocks FR

Each row represents an FR whose absence would prevent or degrade another FR. The "Blocks" column lists FRs that cannot function without the row FR.

### 2.1 Foundation Layer (Infrastructure Primitives)

| FR | Title | Blocks (FRs that require this FR) | Dependency Type |
|----|-------|-----------------------------------|-----------------|
| **FR36** | Pi SDK model tier directives | FR13, FR37, FR38, FR39, FR118 | Hard runtime — all agents run on Pi |
| **FR21** | Agent spawn/monitor/stop/replace (Overstory) | FR1, FR4, FR5, FR6, FR7, FR10, FR12, FR22, FR23, FR24, FR26, FR57 | Hard runtime — everything orchestrated through Overstory |
| **FR23** | Mail system (Overstory SQLite) | FR16, FR22, FR26, FR57, FR58 | Hard runtime — cross-agent communication substrate |
| **FR42** | Attribution chain (full) | FR37, FR96, FR117, FR132, FR142, FR144, FR146 | Data — attribution.db must exist for cost tracking |
| **FR40** | Worktree lifecycle management | FR1, FR4, FR15, FR51, FR69, FR148 | Hard runtime — story execution requires worktrees |
| **FR69** | Setup/install script + dependency verification | FR70, FR71, FR72 | Hard runtime — system won't start without valid setup |
| **FR70** | per-developer factory.yaml config | FR36, FR37, FR38, FR39, FR71, FR125, FR149 | Runtime config — model preferences, budgets, quiet hours |

### 2.2 Overlay & Context Pipeline

| FR | Title | Blocks (FRs that require this FR) | Dependency Type |
|----|-------|-----------------------------------|-----------------|
| **FR28** | Overlay composition pipeline (6-stage) | FR29, FR30, FR31, FR32, FR33, FR34, FR35, FR61, FR137, FR155, FR166, FR167 | Hard runtime — every agent launch requires an assembled overlay |
| **FR29** | Per-stage token budget + truncation | FR30, FR155 | Extension — budget validation builds on this |
| **FR30** | Context budget pre-launch validation | FR31, FR155 | Extension — FR155 refines the guard clause in FR30 |
| **FR33** | Superpowers skill injection into overlays | FR34, FR159 | Extension — hooks consume same skill files |
| **FR34** | Superpowers enforcement metadata (YAML frontmatter) | FR14, FR15, FR16, FR17, FR18 | Gate dependency — hook scripts read enforcement metadata |
| **FR35** | Mulch scoped to agent file path | FR64, FR66, FR95 | Extension — Mulch integrity checks extend this |
| **FR32** | Phase Boundary Protocol transfer manifests | FR6, FR18, FR58, FR131 | Hard runtime — phase transitions require structured manifests |

### 2.3 Quality Enforcement Chain

| FR | Title | Blocks (FRs that require this FR) | Dependency Type |
|----|-------|-----------------------------------|-----------------|
| **FR14** | 6-layer progressive quality gates (gate runner infrastructure) | FR15, FR16, FR17, FR18, FR19, FR20, FR135 | Hard runtime — hook runner must exist before any gate fires |
| **FR15** | Post-edit: file scope violation blocking | FR103 (enforces no-leak at write time) | Gate dependency |
| **FR17** | Post-task hooks (test/lint/type-check) | FR130 (reads hook results), FR152 (structural verifier runs as post-task hook) | Gate + Data dependency |
| **FR18** | Phase boundary hooks (6-check gate) | FR20, FR131 (confidence at phase boundary) | Gate dependency |
| **FR10** | BMAD adversarial review | FR11, FR93, FR102, FR163 | Hard runtime — BMAD must run before fix loop or disagreement protocol |
| **FR11** | BMAD finding categorization | FR7, FR52, FR93, FR163 | Data — fix loop and PR body consume structured findings |
| **FR7** | Fix loop with circuit breaker | FR163, FR154 | Hard runtime — disagreement protocol and auto-remediation extend the fix loop |
| **FR12** | QA swarm (multi-wave) | FR13, FR53 | Hard runtime — coverage gap analysis requires QA to have run |
| **FR152** | Lightweight continuous structural verification | FR163 | Gate dependency — disagreement protocol mediates FR152 vs BMAD |

### 2.4 Pipeline Execution

| FR | Title | Blocks (FRs that require this FR) | Dependency Type |
|----|-------|-----------------------------------|-----------------|
| **FR1** | Story intake + pipeline initiation (no-intervention) | FR2, FR3, FR91, FR104 | Hard runtime — nothing starts without story intake |
| **FR5** | Pipeline phase assembly per work type | FR6, FR9 | Hard runtime — defines which phases activate |
| **FR6** | Phase transition (fresh agent, structured manifest) | FR10, FR12, FR32, FR131 | Hard runtime — phase transitions are the delivery mechanism for BMAD and QA |
| **FR91** | Story spec schema validation at intake | FR1 (gates it), FR166 | Gate dependency — bad specs must not enter the pipeline |
| **FR145** | Atomic task checkout (pipeline.db lock) | FR4 (prevents double-assignment in parallel) | Hard runtime — required before multi-story parallelism is safe |

### 2.5 Dashboard & Observability

| FR | Title | Blocks (FRs that require this FR) | Dependency Type |
|----|-------|-----------------------------------|-----------------|
| **FR48** | SSE/WS event streaming (Overstory ↔ Dashboard) | FR43, FR44, FR45, FR46, FR47, FR49, FR50, FR97, FR113, FR171 | Hard runtime — dashboard is read-only without the event stream |
| **FR43** | Factory Overview | FR50 (crash recovery visual) | Extension |
| **FR44** | Agent Windows (xterm.js) | FR27, FR47 | Hard runtime — "Inspect" requires a panel to render into |
| **FR97** | SSE auto-reconnect with state catch-up | FR50 | Extension — crash recovery requires reconnect |
| **FR111** | CopilotKit readable state hooks | FR105, FR106, FR107, FR108 | Hard runtime — Copilot cannot ask anything without readable state |
| **FR112** | CopilotKit action hooks | FR108, FR109, FR110 | Hard runtime — Act mode requires action hooks |
| **FR113** | AG-UI bidirectional streaming | FR114, FR115 | Hard runtime — multi-step investigations require streaming |

### 2.6 Git & PR Operations

| FR | Title | Blocks (FRs that require this FR) | Dependency Type |
|----|-------|-----------------------------------|-----------------|
| **FR51** | Git safety iron laws | FR52, FR76 | Gate dependency — safety rules must be active before any git operation |
| **FR52** | PR creation via gh CLI | FR8, FR53, FR54, FR90 | Hard runtime — PR evidence and CI observation require a PR to exist |
| **FR8** | Structured PR evidence body | FR52 (content for the body), FR90 (seeds issues from comments on this PR) | Data dependency |

### 2.7 Factory Learning System

| FR | Title | Blocks (FRs that require this FR) | Dependency Type |
|----|-------|-----------------------------------|-----------------|
| **FR55** | Structured learning record writes (atomic) | FR56, FR57, FR58, FR59, FR60, FR61, FR62, FR63, FR98, FR99, FR160, FR164, FR165 | Hard runtime — all learning pipeline stages depend on records existing |
| **FR56** | Story outcome tags on learning records | FR59 (synthesis weights), FR60 (conflict detection) | Data dependency |
| **FR59** | Manual synthesis script | FR60, FR61, FR63 | Hard runtime — synthesized/ must be populated before injection can happen |
| **FR61** | Overlay learning injection (synthesized/) | FR62, FR157, FR167 | Extension — enriched injection extends base injection |
| **FR164** | Maintenance learning extraction + CLI | FR165 (primary input), FR167 (priority item), FR168 | Data dependency — pattern miner mines maintenance learnings |
| **FR165** | Pattern knowledge accumulation (pipeline.db) | FR167 (priority-2 injection), FR168 | Data dependency — burden tracking mines pattern knowledge |

### 2.8 Agent Performance Data Collection (MVP)

| FR | Title | Blocks (FRs that require this FR) | Dependency Type |
|----|-------|-----------------------------------|-----------------|
| **FR130** | Action-level process scoring (pipeline.db) | FR132, FR140, FR160 | Data dependency — composite scores aggregate action scores |
| **FR131** | Confidence calibration at phase boundaries | FR132 (calibration quality factor in composite) | Data dependency |
| **FR132** | Session composite scores (pipeline.db) | FR133 (Growth — ELO reads composites), FR140 | Data dependency |

### 2.9 Agent Performance Behavioral System (Growth Only)

| FR | Title | Blocks (FRs that require this FR) | Dependency Type |
|----|-------|-----------------------------------|-----------------|
| **FR133** | ELO domain ratings | FR134, FR136-R, FR138, FR160, FR161, FR162 | Data dependency — all behavioral routing/tier logic reads ELO |
| **FR134** | Capability tier assignment | FR135, FR137, FR141, FR161, FR169 | Data dependency — hooks, context, overrides, audit all read tier |
| **FR135** | Tier-based hook density | FR169 | Extension — audit mechanism overrides hook density |
| **FR136-R** | Weighted composite routing scorer | FR138 | Hard runtime — ELO routing requires the scorer |

### 2.10 Economic Governance

| FR | Title | Blocks (FRs that require this FR) | Dependency Type |
|----|-------|-----------------------------------|-----------------|
| **FR38** | Per-story cost circuit breaker | FR142 (revised version extends this) | Extension |
| **FR39** | Daily global budget ceiling | FR142, FR171 (notification on trip) | Extension |
| **FR37** | Token spend tracking per story | FR38, FR39, FR46, FR49 | Data dependency — circuit breakers read spend data |
| **FR142** | Per-story budget enforcement (revised) | FR146 | Extension — cost attribution dashboard reads attribution.db |

### 2.11 Orchestration

| FR | Title | Blocks (FRs that require this FR) | Dependency Type |
|----|-------|-----------------------------------|-----------------|
| **FR149** | Turn-based continuation within phases | FR150 (Growth — deviation handling extends) | Extension |
| **FR166** | Epic-level context management (pipeline.db table) | FR167 (priority-4 injection source) | Data dependency — overlay enrichment sources epic context |

### 2.12 Resilience & Safety

| FR | Title | Blocks (FRs that require this FR) | Dependency Type |
|----|-------|-----------------------------------|-----------------|
| **FR73** | Resource monitoring (disk/memory/token) | FR170 (circuit breaker extends this) | Extension |
| **FR170** | System health circuit breaker | FR73 (monitoring feeds it), FR171 (notification on trip) | Extension |
| **FR171** | Multi-channel notification abstraction | FR120–FR129 (Telegram wrapped inside it) | Extension |
| **FR120** | Telegram escalation notifications | FR121, FR122, FR123, FR124, FR125, FR126, FR127, FR128, FR129 | Hard runtime — all Telegram features require the bot connection |
| **FR127** | Telegram user registration flow | FR121, FR122, FR123 | Gate dependency — commands require authenticated user |

### 2.13 Meta-Optimization

| FR | Title | Blocks (FRs that require this FR) | Dependency Type |
|----|-------|-----------------------------------|-----------------|
| **FR77** | Daily cron observer (reads attribution + learning data) | FR78, FR79, FR84, FR85, FR89 | Data dependency — weekly optimizer reads daily journals |
| **FR79** | Weekly cron optimizer (reads 7 journals) | FR80, FR81, FR82, FR83, FR84, FR86, FR87, FR88, FR89 | Hard runtime — all weekly optimizer actions depend on FR79 executing |
| **FR80** | Weekly optimizer implements improvement | FR82, FR83, FR84 | Data — lifecycle record and dashboard flag require the change to have happened |
| **FR99** | Manual PR "caused production issue" tagging | FR77 (feeds daily observer), learning system (negative signal) | Data dependency |

---

## 3. Critical Path Through the FR Dependency Graph

The critical path is the longest chain of hard-blocking dependencies that must be resolved sequentially before the MVP can be called operational. Parallelizable tracks are shown as branches off this path.

### 3.1 Critical Path (Developer A — Sequential Chain)

```
[RUNTIME SUBSTRATE]
Pi SDK Integration (FR36)
    ↓
Overstory: agent spawn/monitor/stop (FR21)
    ↓
Overstory: mail system (FR23)
    ↓
Attribution chain setup (FR42)
    ↓
Worktree lifecycle management (FR40)

[QUALITY GATE INFRASTRUCTURE]
    ↓
Hook runner infrastructure / 6-layer gate registry (FR14)
    ↓
Post-edit hooks — scope + TDD detection (FR15, FR16)
    ↓
Post-task hooks — test/lint/type-check (FR17)
    ↓
Phase boundary hooks — full gate checklist (FR18)

[OVERLAY & CONTEXT PIPELINE]
    ↓ (concurrent with hook infra — see parallel track B)
Overlay composition pipeline (FR28)
    ↓
Superpowers skill injection (FR33)
    ↓
Superpowers enforcement metadata extraction (FR34)
    ↓
Mulch file-path scoping (FR35)

[PHASE BOUNDARY PROTOCOL — highest design risk]
    ↓
Phase Boundary Protocol transfer manifests (FR32)
    ↓
Phase transition: fresh agent spin-up (FR6)

[PIPELINE EXECUTION]
    ↓
Story spec validation at intake (FR91)
    ↓
Story intake + initiation (FR1)
    ↓
Pipeline phase assembly per work type (FR5)
    ↓
Atomic task checkout (FR145)
    ↓
Multi-story parallel execution with worktree isolation (FR4)

[QUALITY ENFORCEMENT]
    ↓
BMAD adversarial review (FR10)
    ↓
BMAD finding categorization + structured report (FR11)
    ↓
Fix loop with circuit breaker (FR7)
    ↓
Nyquist-BMAD disagreement protocol (FR163)
    ↓
Lightweight continuous structural verification (FR152)

[QA]
    ↓
Multi-wave QA swarm (FR12)
    ↓
Economy-tier QA scouts via Pi SDK (FR13)

[PR DELIVERY]
    ↓
Git safety iron laws (FR51)
    ↓
PR creation via gh CLI (FR52)
    ↓
Structured PR evidence body (FR8)

[STORY PIPELINE COMPLETE — MVP CRITICAL PATH END]
```

**Estimated minimum sequential dependency depth:** 22 hops from Pi SDK to first shippable PR.

### 3.2 Parallel Track B — Dashboard (can begin after FR21 is stable)

```
SSE/WS event streaming (FR48)
    ↓
Factory Overview (FR43)
    ↓
Agent Windows / xterm.js (FR44)
    ↓
Story pipeline visualization (FR45)
    ↓
Stop/Nudge/Inspect controls (FR25, FR26, FR27)
    ↓
Stall detection + type classification (FR47)
    ↓
Cost tracking with model tier breakdown (FR46)
    ↓
SSE auto-reconnect (FR97)
    ↓
Dashboard crash resilience / agent continuity (FR50)
```

### 3.3 Parallel Track C — Memory & Learning (can begin after FR28 is stable)

```
Structured learning record writes, atomic (FR55)
    ↓
Story outcome tags on records (FR56)
    ↓
learning_report mail type (FR57)    ←→ Phase Boundary learnings section (FR58)
    ↓
Manual synthesis script (FR59)
    ↓
Synthesis conflict detection + Superpowers validation (FR60)
    ↓
Overlay learning injection with token ceiling (FR61)
    ↓
Maintenance learning extraction + CLI seeder (FR164)
    ↓
Pattern knowledge accumulation (FR165)
    ↓
Epic-level context management table (FR166)
    ↓
Overlay learning enrichment with priority ordering (FR167)
    ↓
Maintenance burden tracking (FR168)
```

### 3.4 Parallel Track D — Performance Data Collection (can begin after FR17 + FR32 are stable)

```
Action-level process scoring, post-task hook (FR130)
    ↓
Confidence calibration at phase boundaries (FR131)
    ↓
Session composite scores (FR132)
    ↓
Performance data export (FR140)
```

### 3.5 Parallel Track E — Notifications (can begin after FR48 is stable)

```
Multi-channel notification abstraction + MessageBus (FR171)
    ↓
Telegram bot connection (FR120)
    ↓
Telegram user registration (FR127)
    ↓
Command handling (FR121)
    ↓
Async dialogue state (FR123)
    ↓
Dual-channel sync (FR124)
    ↓
Quiet hours + DND + routing (FR125)
    ↓
Daily morning summary (FR126)
    ↓
NL intent classification (FR128)
```

### 3.6 Parallel Track F — Meta-Optimization (can begin after MVP stories are flowing)

```
Daily cron observer (FR77) — observe-only, reads attribution + learning data
    ↓
Weekly optimizer (FR79)
    ↓
Single-improvement application (FR80, FR81)
    ↓
Lifecycle record + revert payload (FR82)
    ↓
Dashboard flag + one-click revert (FR83)
    ↓
Auto-revert on degradation detection (FR84)
    ↓
Minimum story threshold guard (FR87)
    ↓
Effectiveness window + auto-revert (FR88)
    ↓
Meta-optimization history timeline (FR89)
```

---

## 4. FRs with the Most Dependents (Highest Cascade Risk)

If any of these FRs is delayed, broken, or significantly redesigned, it causes a cascading failure across its entire dependent subtree.

| Rank | FR | Title | Direct Dependents | Total Cascade Depth | Risk Level |
|------|----|-------|-------------------|---------------------|------------|
| 1 | **FR21** | Agent spawn/monitor/stop/replace (Overstory) | 17 | Full system | CRITICAL |
| 2 | **FR28** | Overlay composition pipeline | 14 | All agent context | CRITICAL |
| 3 | **FR14** | 6-layer hook runner infrastructure | 9 | All quality enforcement | CRITICAL |
| 4 | **FR36** | Pi SDK model tier directives | 8 | All model execution | CRITICAL |
| 5 | **FR32** | Phase Boundary Protocol manifests | 7 | Phase transitions + BMAD isolation + learnings | HIGH |
| 6 | **FR55** | Structured learning record writes | 14 | Entire learning system | HIGH |
| 7 | **FR48** | SSE/WS event streaming | 12 | Entire dashboard + Copilot + notifications | HIGH |
| 8 | **FR42** | Attribution chain | 7 | All cost tracking + governance | HIGH |
| 9 | **FR1** | Story intake + initiation | 4 | Pipeline entry point | HIGH |
| 10 | **FR40** | Worktree lifecycle management | 6 | Story isolation + git safety | HIGH |
| 11 | **FR10** | BMAD adversarial review | 5 | Findings → fix loop → PR evidence | MEDIUM-HIGH |
| 12 | **FR59** | Manual synthesis script | 4 | Injection + conflict detection + retraction | MEDIUM-HIGH |
| 13 | **FR130** | Action-level process scoring | 3 | Composite scores → ELO (Growth) | MEDIUM |
| 14 | **FR77** | Daily cron observer | 5 | Entire meta-optimization subsystem | MEDIUM |
| 15 | **FR120** | Telegram bot connection | 8 | All Telegram features | MEDIUM |

### 4.1 "Hidden Titan" Dependencies

These FRs have low visibility in the PRD's narrative but disproportionate cascade impact:

- **FR42 (Attribution chain):** Every cost-related FR (FR37, FR38, FR39, FR46, FR49, FR96, FR117, FR132, FR142, FR144, FR146) assumes attribution.db is populated correctly. If attribution chain data is missing or malformed, cost circuit breakers fail silently. The PRD's FR96 ("API calls without a full attribution chain are blocked") is a direct acknowledgment of this risk — but FR96 itself depends on FR42 being enforced consistently.

- **FR34 (Superpowers enforcement metadata):** The hook runner (FR14) reads enforcement metadata from skill frontmatter to know which hooks to execute and at which severity. If FR34 schema is changed (e.g., adding new hook types), all 5 existing enforcement gate-runner scripts require simultaneous updates. The coupling between Superpowers file format and hook execution is tight and bidirectional.

- **FR149 (Turn-based continuation):** Turn state persists to pipeline.db between turns. If FR149 is incomplete, agents cannot do multi-turn work within a phase — every story becomes a single-turn story, massively limiting the factory's capability without any visible error.

---

## 5. Hidden Blockers Not Identified in the PRD's Sequencing Section

The PRD's Implementation Sequencing section (lines 609–627) identifies the correct macro-level ordering but misses several micro-level dependencies that could stall implementation mid-sprint.

### Hidden Blocker 1: pipeline.db Schema Must Be Designed Before FR130, FR131, FR132, FR145, FR149, FR165, FR166

**What the PRD says:** These FRs are independently described as "writes to pipeline.db." The PRD treats pipeline.db as pre-existing infrastructure.

**The gap:** pipeline.db schema is never explicitly defined as its own FR. The tables `action_scores`, `session_composites`, `elo_ratings`, `agent_tiers`, `epic_context`, `pattern_knowledge`, `maintenance_learnings`, `maintenance_burden`, `task_checkout_locks`, `turn_state`, and `elo_epochs` are described in individual FRs but no single FR owns the schema creation, migration system, or index design. If FR130 is implemented before the schema is stabilized, every subsequent FR that touches pipeline.db will require schema migrations — a classic "we didn't define the database first" problem.

**Recommendation:** Define a `pipeline.db` schema artifact (FR-SCHEMA-01, or an implementation task) as a prerequisite story before any of the above FRs enter development.

### Hidden Blocker 2: Credential Sanitizer Must Exist Before Any Output Path Is Implemented

**What the PRD says:** NFR10 states that no API key/secret may appear in any factory output. NFR33 extends this to Telegram messages.

**The gap:** The credential sanitizer is referenced as a component in NFR10/NFR33 but never defined as a functional requirement with its own FR number. The sanitizer must be applied to: agent stdout/stderr (FR44 xterm.js), Overstory logs (FR26), learning records (FR55), PR evidence body (FR52, FR8), dashboard rendered content, meta-optimization journals (FR77, FR85), and Telegram messages (FR120–FR128). If any of these output paths is implemented before the sanitizer exists, it ships without the guardrail.

**Recommendation:** Create an explicit FR or implementation task for the credential sanitizer as a prerequisite before FR44, FR52, FR55, or FR120 is marked complete.

### Hidden Blocker 3: `gh` CLI Auth Verification Must Block PR Operations (Not Just Setup)

**What the PRD says:** FR69 (setup script) verifies `gh auth status`. The PRD notes "gh CLI is a hard dependency" in the Technical Architecture section.

**The gap:** FR69 is in the "Developer Operations" track (Parallel Track B in the PRD). If FR52 (PR creation) is completed and tested in isolation (e.g., in a local dev environment where gh is authenticated), but Factory Core never re-validates gh auth at runtime before attempting PR creation, the factory will fail silently in production when auth expires. There is no FR that specifies a runtime gh auth check before each PR attempt — only the one-time setup check.

**Recommendation:** FR52 should include a runtime gh auth check as part of its pre-condition logic, not delegated entirely to the setup script.

### Hidden Blocker 4: Phase Boundary Protocol Must Be Validated Before Dashboard Visualization Can Be Built

**What the PRD says:** FR20 (dashboard phase gate checklist) and FR45 (story pipeline visualization) depend on FR32 (Phase Boundary Protocol).

**The gap:** The PRD places Dashboard development on Parallel Track B and Phase Boundary Protocol on the critical path. However, FR45 and FR20 require the specific shape of the transfer manifest (schema, sections, gate results structure) to render meaningfully. If the dashboard visualization is built against a provisional manifest schema that later changes when FR32 is refined, the dashboard components must be rewritten. The PRD does not flag this as a sequencing dependency — it treats them as safely parallel.

**Recommendation:** FR32 manifest schema should be finalized (even if not fully implemented) before FR45 and FR20 enter active development. A manifest schema specification document is a hidden prerequisite deliverable.

### Hidden Blocker 5: Overstory Mail Type `learning_report` Must Be Added Before Loop 1 Can Work

**What the PRD says:** FR23 covers the Overstory mail system. FR57 states that agents can send `learning_report` mail.

**The gap:** FR23 covers the existing mail system. FR57 adds a new mail type (`learning_report`). The Overstory mail system has typed message envelopes backed by SQLite. Adding a new type requires a schema extension in Overstory's database (a new message type enum value or new table column) and a new handler registration. This is not a trivial configuration change — it requires coordinated changes to the Overstory layer and the Factory Core mail consumer. The PRD sequences FR57 on Parallel Track C (Memory/Learning) without calling out that it requires a schema change to the Overstory layer (which is on the critical path Track A).

**Recommendation:** The Overstory mail schema extension for `learning_report` should be explicitly sequenced after FR21/FR23 are stable, not treated as a pure Track C concern.

### Hidden Blocker 6: Mulch File Integrity Check Depends on a Schema That Must Be Defined

**What the PRD says:** FR95 states that overlay assembly performs Mulch content integrity checks before injection. FR64 adds timestamps and provenance to Mulch files.

**The gap:** FR95 (integrity check) assumes a Mulch file schema exists that can be validated. FR64 defines what fields Mulch files carry. But neither FR explicitly owns the Mulch file schema definition. If FR35 (Mulch scoping) is implemented before FR64 defines the schema, agents receive un-typed Mulch files that FR95 then cannot validate. The ordering FR64 → FR95 → FR35 is implicit but unspecified.

**Recommendation:** FR64 (Mulch file schema with timestamps/provenance) must be sequenced before FR95 and before FR35 is considered complete.

### Hidden Blocker 7: Turn Continuation State in pipeline.db Required Before Multi-Phase Stories Can Succeed

**What the PRD says:** FR149 (turn-based continuation) persists turn state to pipeline.db. The PRD marks this as MVP.

**The gap:** Without FR149, every phase in every story is a single-turn operation. An agent gets one shot to complete a development phase before the phase boundary triggers. Most real stories require multiple agent turns (plan → implement → test → iterate). If FR149 is deprioritized or deferred, the factory technically "works" but is critically limited — stories will hit the default max_turns=1 and fail at phase boundaries constantly. This dependency is implicit: FR4 (concurrent story execution) and FR1 (no-intervention execution) both assume multi-turn phases work, but neither lists FR149 as a prerequisite.

**Recommendation:** FR149 should be elevated in priority to near-critical path status. It is currently listed as MVP but not called out in the critical path sequencing.

### Hidden Blocker 8: Factory Core Gateway API Must Exist Before Dashboard Data Queries Can Work

**What the PRD says:** Several FR descriptions reference "reads from pipeline.db via Gateway API" (FR139, FR146). The dashboard is architecturally described as connecting via SSE (FR48) for real-time events.

**The gap:** The Gateway API — the component that translates dashboard data queries into pipeline.db reads — is never explicitly defined as a functional requirement. The SSE event stream (FR48) handles real-time updates, but the dashboard also needs request-response queries for historical data (cost breakdowns, performance cards, meta-optimization history). The Gateway API is an architectural assumption embedded in individual FRs without being explicitly instantiated.

**Recommendation:** Define a Gateway API implementation task as a prerequisite before FR139, FR146, and FR89 (meta-optimization history timeline) enter development.

### Hidden Blocker 9: System Health Circuit Breaker (FR170) Cannot Function Without All Subsystems Providing Health Signals

**What the PRD says:** FR170 monitors overlay composition, hook execution, verification, budget tracking, Overstory communication, and Pi SDK responses.

**The gap:** FR170's circuit breaker activates "when 3 or more subsystems report errors within 60 seconds." This assumes each subsystem exposes a health signal. But no other FR explicitly defines the health reporting interface — subsystems are built to their own FR without awareness that FR170 will poll them. If FR170 is implemented before the health reporting interfaces are standardized, the circuit breaker either cannot monitor some subsystems (reduced safety) or must be retrofitted into already-complete FRs (rework).

**Recommendation:** Health reporting interface must be defined as a cross-cutting concern before any subsystem FR (FR14, FR28, FR36, FR37, FR73) is marked complete. This is an architectural contract, not an afterthought.

---

## 6. Recommended Implementation Sequencing

Based on the dependency graph, cascade risk analysis, and hidden blockers, the following sequencing supplements the PRD's existing two-track model with more granular sprint-level ordering.

### Sprint 0 (Pre-Development Architecture Artifacts)

These are not code stories — they are design/schema artifacts that must exist before any dependent FR can be correctly implemented:

| Artifact | Unblocks FRs | Rationale |
|----------|-------------|-----------|
| `pipeline.db` full schema (all tables, indexes, migration system) | FR130, FR131, FR132, FR145, FR149, FR165, FR166, FR167, FR168 | Hidden Blocker 1 |
| Manifest schema specification for Phase Boundary Protocol | FR32, FR45, FR20, FR131 | Hidden Blocker 4 |
| Mulch file schema (fields, validation rules) | FR64, FR95, FR35 | Hidden Blocker 6 |
| Health reporting interface contract | FR170, FR73, and all subsystem FRs | Hidden Blocker 9 |
| Credential sanitizer utility | FR44, FR52, FR55, FR77, FR120 | Hidden Blocker 2 |

### Sprint 1 (Critical Path Foundation)

Developer A — sequential, no shortcuts:

1. **FR36** — Pi SDK integration (runtime substrate)
2. **FR21** — Overstory agent lifecycle (spawn/monitor/stop/replace)
3. **FR23** — Overstory mail system (mail types + SQLite backing)
4. **FR42** — Attribution chain (attribution.db schema + population)
5. **FR40** — Worktree lifecycle management

Developer B — parallel, can start immediately:

1. **FR48** — SSE/WS event streaming skeleton (wire up Overstory events)
2. **FR43** — Factory Overview (static layout, connects to SSE)
3. **FR69** — Setup/install script (dependency verification, factory.yaml creation)
4. **FR70** — factory.yaml config schema

### Sprint 2 (Hook Infrastructure + Overlay Pipeline)

Developer A:

1. **FR14** — Hook runner infrastructure (6-layer gate registry, gate-runner scripts framework)
2. **FR34** — Superpowers enforcement metadata extraction from YAML frontmatter
3. **FR15**, **FR16** — Post-edit hooks (scope violation, TDD warning)
4. **FR17** — Post-task hooks (test/lint/type-check)
5. **FR18** — Phase boundary hooks (6-check gate)

Developer B:

1. **FR28** — Overlay composition pipeline (6-stage, token budgets)
2. **FR29** — Per-stage token budget truncation logic
3. **FR33** — Superpowers skill injection into overlays
4. **FR35** — Mulch file-path scoping + integrity check (FR64 schema prerequisite must be done)
5. **FR30**, **FR31**, **FR155** — Context budget validation + 50% rule

**Integration point:** After Sprint 2, Developer A's hooks and Developer B's overlays merge. FR34 connects the overlay's skill files to the hook runner.

### Sprint 3 (Phase Boundary Protocol — Highest Risk Story)

Both developers pair on this sprint's core deliverable:

1. **FR32** — Phase Boundary Protocol: manifest schema, transfer mechanism, fresh agent spin-up
2. **FR6** — Phase transition execution (integrates FR32 + FR21 + FR28)
3. **FR19** — Hook results inline in agent output (visual feedback)
4. **FR20** — Dashboard phase gate checklist (requires FR32 manifest schema to be finalized first)
5. **FR131** — Confidence calibration at phase boundaries (extends FR32 manifest)

### Sprint 4 (Pipeline Execution + Quality Chain)

Developer A:

1. **FR91** — Story spec schema validation at intake
2. **FR1** — Story intake + pipeline initiation
3. **FR5** — Pipeline phase assembly per work type (Story + Task)
4. **FR145** — Atomic task checkout (pipeline.db lock manager)
5. **FR4** — Multi-story parallel execution with worktree isolation
6. **FR2**, **FR3** — Epic decomposition + manual dependency override

Developer B:

1. **FR44** — Agent Windows (xterm.js panels, requires credential sanitizer)
2. **FR45** — Story pipeline phase progression visualization
3. **FR25**, **FR26**, **FR27** — Stop/Nudge/Inspect controls
4. **FR47** — Stall detection with type classification
5. **FR97** — SSE auto-reconnect
6. **FR50** — Dashboard crash resilience

### Sprint 5 (Quality Enforcement — BMAD + Fix Loop + QA)

1. **FR10** — BMAD adversarial review (fresh agents, context isolation)
2. **FR11** — BMAD finding categorization (structured report)
3. **FR7** — Fix loop with circuit breaker
4. **FR152** — Lightweight continuous structural verification
5. **FR163** — Nyquist-BMAD disagreement protocol (requires FR10 + FR152)
6. **FR12** — QA swarm (multi-wave)
7. **FR13** — Economy-tier QA scouts via Pi SDK

### Sprint 6 (PR Delivery + Learning Foundation)

1. **FR51** — Git safety iron laws
2. **FR52** — PR creation via gh CLI (with runtime gh auth check — Hidden Blocker 3)
3. **FR8** — Structured PR evidence body
4. **FR53** — Coverage gap indicator ("Not Tested" section)
5. **FR55** — Learning record writes (atomic, crash-safe) — Note: mail type schema extension for Overstory must be done here (Hidden Blocker 5)
6. **FR56** — Story outcome tags
7. **FR57** — learning_report mail type (Overstory extension)
8. **FR58** — Learnings section in Phase Boundary Protocol manifests

**MVP verification checkpoint:** After Sprint 6, a single story should be able to flow end-to-end through all 5 phases and create a PR. This is the prototype validation milestone the PRD recommends for Phase Boundary Protocol.

### Sprint 7 (Learning System Completion + Performance Data)

1. **FR59** — Manual synthesis script
2. **FR60** — Synthesis conflict detection + Superpowers gate validation
3. **FR61** — Overlay learning injection (synthesized/, tiered, token ceiling)
4. **FR62** — Spike/exploratory escape hatch
5. **FR63** — Cascading retraction
6. **FR130** — Action-level process scoring (reads post-task hook results)
7. **FR132** — Session composite scores
8. **FR140** — Performance data export (CLI + dashboard button)

### Sprint 8 (Self-Learning System + Economic Governance)

1. **FR164** — Maintenance learning extraction + CLI seeder
2. **FR165** — Pattern knowledge accumulation
3. **FR166** — Epic-level context management (pipeline.db table)
4. **FR167** — Overlay learning enrichment with priority ordering
5. **FR168** — Maintenance burden tracking
6. **FR149** — Turn-based continuation within phases (pipeline.db turn state)
7. **FR37** — Token spend tracking per story
8. **FR38** — Per-story cost circuit breaker
9. **FR39** — Daily global budget ceiling
10. **FR142** — Per-story budget enforcement revised (per-role visibility)

### Sprint 9 (System Health + Notifications)

1. **FR170** — System health circuit breaker (requires health interfaces from Sprint 0)
2. **FR171** — Multi-channel notification abstraction + MessageBus
3. **FR120** — Telegram bot connection
4. **FR127** — Telegram user registration flow
5. **FR121** — Telegram command handling
6. **FR123**, **FR124**, **FR125** — Async dialogue, dual-channel sync, quiet hours
7. **FR126** — Daily morning summary
8. **FR128** — NL intent classification

### Sprint 10 (Meta-Optimization + Resilience Polish)

1. **FR77** — Daily cron observer
2. **FR78** — Observe-only enforcement (no side effects)
3. **FR79** — Weekly cron optimizer
4. **FR80**, **FR81**, **FR82**, **FR83** — Single improvement, lifecycle record, dashboard flag
5. **FR84**, **FR86**, **FR87**, **FR88** — Auto-revert, safety boundaries, threshold, effectiveness window
6. **FR89** — Meta-optimization history timeline
7. **FR73** — Resource monitoring thresholds
8. **FR74**, **FR75**, **FR76** — Story crash isolation, provider down graceful stall, git safety absolute rules

### Sprint 11 (Remaining MVP FRs + Copilot)

1. **FR90** — PR-to-Seeds auto-issue creation
2. **FR93** — Developer dismiss BMAD finding via dashboard
3. **FR94** — Hook timeout bypass (configurable)
4. **FR95** — Mulch content integrity check
5. **FR96** — Block API calls without attribution chain
6. **FR98** — Learning record retention window
7. **FR99** — Manual "caused production issue" tagging
8. **FR100** — Cumulative configuration drift monitoring
9. **FR101** — CLI meta-optimization revert fallback
10. **FR102** — Configurable BMAD review profiles
11. **FR103** — Credential exposure enforcement (all output paths)
12. **FR104** — Story queue with developer reorder
13. **FR105**–**FR119** — Dashboard Copilot (CopilotKit + AG-UI, all three modes)

---

## 7. Phase Clusters — Which FRs Must Be in Which Phase

### Phase Cluster 1: MVP Phase 1A — Runtime Substrate (Must Ship Together)

These FRs cannot be partially present. The factory either has a working runtime or it does not.

| FR | Title |
|----|-------|
| FR21 | Agent spawn/monitor/stop/replace |
| FR23 | Mail system |
| FR36 | Pi SDK model tier directives |
| FR40 | Worktree lifecycle management |
| FR42 | Attribution chain |
| FR51 | Git safety iron laws |
| FR69 | Setup/install script |
| FR70 | factory.yaml config |

### Phase Cluster 2: MVP Phase 1B — Quality Gate Infrastructure (Must Ship Together)

Hook infrastructure and overlay pipeline are mutually coupled via FR34. Both must be present for any story to run with enforcement.

| FR | Title |
|----|-------|
| FR14 | 6-layer hook runner |
| FR15 | Post-edit: scope violation |
| FR16 | Post-edit: TDD warning |
| FR17 | Post-task: test/lint/type-check |
| FR18 | Phase boundary hooks |
| FR28 | Overlay composition pipeline |
| FR29 | Per-stage token budget truncation |
| FR30 | Context budget pre-launch validation |
| FR33 | Superpowers skill injection |
| FR34 | Superpowers enforcement metadata |
| FR35 | Mulch file-path scoping |
| FR155 | Context budget 50% rule |

### Phase Cluster 3: MVP Phase 1C — Phase Boundary Protocol (Must Ship as Atomic Unit)

The Phase Boundary Protocol is co-dependent with hook enforcement (FR18), overlay composition (FR28), and manifest transfer (FR32). All must work together on Day 1 of the protocol.

| FR | Title |
|----|-------|
| FR32 | Phase Boundary Protocol manifests |
| FR6 | Phase transition (fresh agent, structured manifest) |
| FR58 | Learnings section in manifests |
| FR131 | Confidence calibration at phase boundaries |
| FR163 | Nyquist-BMAD disagreement protocol |

### Phase Cluster 4: MVP Phase 1D — Pipeline Execution (First End-to-End Story)

| FR | Title |
|----|-------|
| FR1 | Story intake + initiation |
| FR2, FR3 | Epic decomposition + manual override |
| FR4 | Multi-story parallel execution |
| FR5 | Pipeline phase assembly |
| FR7 | Fix loop with circuit breaker |
| FR91 | Story spec validation |
| FR145 | Atomic task checkout |
| FR149 | Turn-based continuation |

### Phase Cluster 5: MVP Phase 1E — Quality Enforcement (Stories Cannot Ship Without This)

| FR | Title |
|----|-------|
| FR10 | BMAD adversarial review |
| FR11 | BMAD finding categorization |
| FR12 | QA swarm |
| FR13 | Economy-tier QA scouts |
| FR52 | PR creation via gh CLI |
| FR8 | Structured PR evidence body |
| FR53 | Coverage gap indicator |
| FR54 | CI pipeline observation |
| FR152 | Lightweight structural verification |

### Phase Cluster 6: MVP Phase 2A — Learning System (Can Come 2–3 Sprints After Phase 1)

| FR | Title |
|----|-------|
| FR55 | Learning record writes (atomic) |
| FR56 | Story outcome tags |
| FR57 | learning_report mail type |
| FR59 | Manual synthesis script |
| FR60 | Synthesis conflict detection |
| FR61 | Overlay learning injection |
| FR62 | Spike escape hatch |
| FR63 | Cascading retraction |
| FR64 | Mulch timestamps + provenance |
| FR65 | Seeds task graph |
| FR66, FR67, FR68 | Git-shared Mulch + learnings directories |
| FR95 | Mulch integrity check |
| FR98 | Learning record retention window |

### Phase Cluster 7: MVP Phase 2B — Self-Learning System

| FR | Title |
|----|-------|
| FR164 | Maintenance learning extraction + CLI |
| FR165 | Pattern knowledge accumulation |
| FR166 | Epic-level context management |
| FR167 | Overlay learning enrichment |
| FR168 | Maintenance burden tracking |

### Phase Cluster 8: MVP Phase 2C — Performance Data Collection

| FR | Title |
|----|-------|
| FR130 | Action-level process scoring |
| FR131 | Confidence calibration (already in Cluster 3 — extend here) |
| FR132 | Session composite scores |
| FR140 | Performance data export |
| FR142 | Per-story budget enforcement (revised) |
| FR145 | Atomic task checkout (already in Cluster 4) |

### Phase Cluster 9: MVP Phase 2D — Dashboard Completion

| FR | Title |
|----|-------|
| FR43–FR50 | All Dashboard & Observability FRs |
| FR90 | PR-to-Seeds auto-issue |
| FR93 | BMAD finding dismissal |
| FR97 | SSE auto-reconnect |
| FR104 | Story queue management |
| FR111–FR119 | Dashboard Copilot |

### Phase Cluster 10: MVP Phase 2E — System Health + Notifications

| FR | Title |
|----|-------|
| FR73 | Resource monitoring |
| FR74, FR75, FR76 | Crash isolation, provider stall, git safety absolute |
| FR120–FR129 | Telegram Developer Communication Layer |
| FR170 | System health circuit breaker |
| FR171 | Multi-channel notification abstraction |

### Phase Cluster 11: MVP Phase 2F — Meta-Optimization

| FR | Title |
|----|-------|
| FR77–FR89 | All Meta-Optimization FRs |
| FR99 | Production issue tagging |
| FR100 | Configuration drift monitoring |
| FR101 | CLI revert fallback |

### Phase Cluster 12: Growth Phase — Agent Performance Behavioral System

*Cannot start until MVP has accumulated 5+ stories per domain.*

| FR | Title |
|----|-------|
| FR133 | ELO domain ratings |
| FR134 | Capability tier assignment |
| FR135 | Tier-based hook density |
| FR136-R | Weighted composite routing |
| FR137 | Performance context in overlays |
| FR138 | ELO-based story routing |
| FR139 | Performance dashboard cards |
| FR141 | Manual tier override |
| FR143 | Rate limit tracking |
| FR144 | Cost-per-initiative rollups |
| FR146 | Cost attribution dashboard |
| FR147 | Per-phase concurrency limits |
| FR148 | Workspace lifecycle hooks |
| FR150 | Automatic deviation handling |
| FR151 | Wave-based epic decomposition |
| FR153 | Structured verification report |
| FR154 | Auto-remediation from gaps |
| FR156 | Confidence-scored fact extraction |
| FR157 | Confidence-ranked injection |
| FR158 | Per-agent memory profiles |
| FR159 | Progressive skill loading |
| FR160 | Action scores in learning records |
| FR161 | Tier demotion criteria |
| FR162 | ELO migration strategy |
| FR169 | Random audit mechanism |

---

## 8. Dependency Graph Summary Table (All MVP FRs)

The table below maps every MVP FR to its immediate prerequisites. Empty prerequisites column = foundation-layer FR with no FR-level blockers (only implementation-task prerequisites).

| FR | Title | Phase | Immediate Prerequisites (FR level) |
|----|-------|-------|-------------------------------------|
| FR1 | Story intake | MVP | FR91, FR21, FR40, FR5 |
| FR2 | Epic decomposition | MVP | FR1 |
| FR3 | Manual dependency override | MVP | FR2 |
| FR4 | Multi-story parallel execution | MVP | FR1, FR40, FR145 |
| FR5 | Pipeline phase assembly | MVP | FR21 |
| FR6 | Phase transition (fresh agent) | MVP | FR32, FR21, FR28 |
| FR7 | Fix loop with circuit breaker | MVP | FR10, FR11 |
| FR8 | Structured PR evidence body | MVP | FR52, FR11, FR12 |
| FR9 | Task work type | MVP | FR5, FR1 |
| FR10 | BMAD adversarial review | MVP | FR6, FR28, FR33 |
| FR11 | BMAD finding categorization | MVP | FR10 |
| FR12 | QA swarm | MVP | FR6, FR21 |
| FR13 | Economy-tier QA scouts | MVP | FR12, FR36 |
| FR14 | 6-layer hook runner | MVP | FR34 (schema), implementation task |
| FR15 | Post-edit: scope violation | MVP | FR14 |
| FR16 | Post-edit: TDD warning | MVP | FR14, FR23 |
| FR17 | Post-task: test/lint/type-check | MVP | FR14 |
| FR18 | Phase boundary hooks | MVP | FR14, FR32 |
| FR19 | Hook results inline output | MVP | FR14 |
| FR20 | Dashboard phase gate checklist | MVP | FR18, FR45, FR32 |
| FR21 | Agent spawn/monitor/stop | MVP | Pi SDK, Overstory runtime |
| FR22 | Coordinator auto-recovery | MVP | FR21, FR171 |
| FR23 | Mail system | MVP | FR21 |
| FR24 | Checkpoint/resume | MVP | FR21 |
| FR25 | Stop agent from dashboard | MVP | FR44, FR21 |
| FR26 | Nudge agent from dashboard | MVP | FR44, FR23 |
| FR27 | Inspect agent live output | MVP | FR44 |
| FR28 | Overlay composition pipeline | MVP | FR33, FR35, FR61 (later stage) |
| FR29 | Per-stage token budget truncation | MVP | FR28 |
| FR30 | Context budget validation | MVP | FR28, FR29 |
| FR31 | Task scope split on budget fail | MVP | FR30 |
| FR32 | Phase Boundary Protocol manifests | MVP | FR28, FR23 |
| FR33 | Superpowers skill injection | MVP | FR28, FR34 |
| FR34 | Superpowers enforcement metadata | MVP | Superpowers skill files with enforcement YAML |
| FR35 | Mulch file-path scoping | MVP | FR64, FR28 |
| FR36 | Pi SDK model tier directives | MVP | Pi SDK installed |
| FR37 | Token spend tracking | MVP | FR42 |
| FR38 | Per-story cost circuit breaker | MVP | FR37, FR171 |
| FR39 | Daily global budget ceiling | MVP | FR37, FR171 |
| FR40 | Worktree lifecycle management | MVP | Git, filesystem |
| FR41 | Orphaned worktree cleanup on startup | MVP | FR40 |
| FR42 | Attribution chain | MVP | attribution.db schema |
| FR43 | Factory Overview | MVP | FR48 |
| FR44 | Agent Windows / xterm.js | MVP | FR48, credential sanitizer |
| FR45 | Story pipeline phase progression | MVP | FR48, FR32 (manifest schema) |
| FR46 | Cost tracking with tier breakdown | MVP | FR48, FR37, FR42 |
| FR47 | Stall detection + classification | MVP | FR48, FR44, FR171 |
| FR48 | SSE/WS event streaming | MVP | FR21 (Overstory events) |
| FR49 | Budget projection per story | MVP | FR48, FR37 |
| FR50 | Dashboard crash resilience | MVP | FR48, FR97 |
| FR51 | Git safety iron laws | MVP | Git tooling |
| FR52 | PR creation via gh CLI | MVP | FR51, FR8, gh CLI auth runtime check |
| FR53 | Coverage gap indicator | MVP | FR12, FR52 |
| FR54 | CI pipeline observation | MVP | FR52 |
| FR55 | Learning record writes (atomic) | MVP | File system, directory structure |
| FR56 | Story outcome tags | MVP | FR55 |
| FR57 | learning_report mail type | MVP | FR23 (Overstory mail extension), FR55 |
| FR58 | Learnings section in manifests | MVP | FR32, FR55 |
| FR59 | Manual synthesis script | MVP | FR55, FR56 |
| FR60 | Synthesis conflict detection | MVP | FR59, FR34 (iron law validation) |
| FR61 | Overlay learning injection | MVP | FR59, FR28 |
| FR62 | Spike/exploratory escape hatch | MVP | FR61 |
| FR63 | Cascading retraction | MVP | FR59, FR55 |
| FR64 | Mulch timestamps + provenance | MVP | Mulch file schema |
| FR65 | Seeds universal task graph | MVP | Seeds/Overstory component |
| FR66 | .mulch/ shared via git | MVP | FR64 |
| FR67 | .qds/learnings/ shared via git | MVP | FR55 |
| FR68 | synthesized/ local only (.gitignore) | MVP | FR59 |
| FR69 | Setup/install script | MVP | — |
| FR70 | factory.yaml config schema | MVP | FR69 |
| FR71 | Independent dashboard per developer | MVP | FR70, FR48 |
| FR72 | PR attribution to developer instance | MVP | FR52, FR42 |
| FR73 | Resource monitoring | MVP | — |
| FR74 | Story crash isolation | MVP | FR21 |
| FR75 | Provider-down graceful stall | MVP | FR21, FR36, FR171 |
| FR76 | Git absolute safety rules | MVP | FR51 |
| FR77 | Daily cron observer | MVP | FR55, FR42, FR85 |
| FR78 | Observe-only enforcement | MVP | FR77 |
| FR79 | Weekly cron optimizer | MVP | FR77 |
| FR80 | Weekly optimizer implements improvement | MVP | FR79, FR86, FR87 |
| FR81 | Single improvement per cycle | MVP | FR79 |
| FR82 | Lifecycle record per optimization | MVP | FR80 |
| FR83 | Dashboard flag + one-click revert | MVP | FR82, FR48 |
| FR84 | Auto-revert on degradation detection | MVP | FR79, FR82 |
| FR85 | Meta journal storage structure | MVP | — |
| FR86 | Safety boundaries on optimizer | MVP | FR79 |
| FR87 | Minimum story threshold guard | MVP | FR79 |
| FR88 | Effectiveness window auto-revert | MVP | FR82 |
| FR89 | Meta-optimization history timeline | MVP | FR82, FR48 |
| FR90 | PR-to-Seeds auto-issue creation | MVP | FR52, FR65 |
| FR91 | Story spec validation at intake | MVP | Story spec schema |
| FR92 | Runtime file contention detection | MVP/Growth | FR4 |
| FR93 | BMAD finding dismissal | MVP | FR11, FR44 |
| FR94 | Hook timeout bypass | MVP | FR14 |
| FR95 | Mulch content integrity check | MVP | FR35, FR64 |
| FR96 | Block API calls without attribution | MVP | FR42 |
| FR97 | SSE auto-reconnect | MVP | FR48 |
| FR98 | Learning record retention window | MVP | FR55 |
| FR99 | Manual production issue tagging | MVP | FR52, FR55 |
| FR100 | Configuration drift monitoring | MVP/Growth | FR82 |
| FR101 | CLI meta-optimization revert fallback | MVP | FR82 |
| FR102 | Configurable BMAD review profiles | MVP | FR10 |
| FR103 | No credential exposure enforcement | MVP | credential sanitizer (impl task) |
| FR104 | Story queue + developer reorder | MVP | FR1, FR48 |
| FR105 | Copilot chat bar | MVP | FR48, FR111 |
| FR106 | Copilot Ask mode | MVP | FR105, FR111 |
| FR107 | Copilot Investigate mode | MVP | FR105, FR111, FR113 |
| FR108 | Copilot Act mode | MVP | FR105, FR112 |
| FR109 | Act mode confirmation requirement | MVP | FR108 |
| FR110 | Copilot uses dashboard control surface only | MVP | FR108, FR112 |
| FR111 | CopilotKit readable state hooks | MVP | FR48, FR43, FR44, FR45 |
| FR112 | CopilotKit action hooks | MVP | FR25, FR26, FR93, FR104 |
| FR113 | AG-UI bidirectional streaming | MVP | FR48 |
| FR114 | Multi-step copilot investigations | MVP | FR113, FR107 |
| FR115 | Copilot action indicators visible | MVP | FR105, FR113 |
| FR116 | Copilot conversation context | MVP | FR105 |
| FR117 | Copilot token usage tracking | MVP | FR42 |
| FR118 | Copilot economy-tier routing | MVP | FR36, FR105 |
| FR119 | Copilot no factory internals access | MVP | FR108 |
| FR120 | Telegram escalation notifications | MVP | FR171, FR127 |
| FR121 | Telegram command handling | MVP | FR120, FR127 |
| FR122 | Telegram story submission | Growth | FR121 |
| FR123 | Async dialogue state (SQLite) | MVP | FR120 |
| FR124 | Dual-channel action sync | MVP | FR120, FR48 |
| FR125 | Telegram quiet hours + DND | MVP | FR120 |
| FR126 | Daily morning summary | MVP | FR120 |
| FR127 | Telegram user registration | MVP | FR120 |
| FR128 | NL intent classification | MVP | FR120, FR127 |
| FR129 | Telegram PRD submission | Growth | FR121 |
| FR130 | Action-level process scoring | MVP | FR17 (reads hook results), pipeline.db schema |
| FR131 | Confidence calibration | MVP | FR32, pipeline.db schema |
| FR132 | Session composite scores | MVP | FR130, FR131, FR42 |
| FR140 | Performance data export | MVP | FR130, FR132 |
| FR142 | Per-story budget enforcement (revised) | MVP | FR38, FR39, FR42 |
| FR145 | Atomic task checkout | MVP | pipeline.db schema |
| FR149 | Turn-based continuation | MVP | FR21, pipeline.db schema |
| FR152 | Lightweight structural verification | MVP | FR17 (runs as post-task hook), FR91 (reads story spec) |
| FR155 | Context budget 50% rule | MVP | FR30 |
| FR163 | Nyquist-BMAD disagreement protocol | MVP | FR152, FR10, FR11, FR7 |
| FR164 | Maintenance learning extraction | MVP | pipeline.db schema, FR55 |
| FR165 | Pattern knowledge accumulation | MVP | FR164, FR59, FR11 |
| FR166 | Epic-level context management | MVP | FR28, pipeline.db schema |
| FR167 | Overlay learning enrichment | MVP | FR61, FR164, FR165, FR166 |
| FR168 | Maintenance burden tracking | MVP | FR164, pipeline.db schema |
| FR170 | System health circuit breaker | MVP | FR73, health reporting interfaces, FR171 |
| FR171 | Multi-channel notification abstraction | MVP | FR48 |

---

## 9. Dependency Risk Heatmap

A qualitative heatmap of implementation risk based on: (a) number of dependents, (b) presence as a hidden blocker, (c) novelty/greenfield status, and (d) explicit "highest design risk" labels in the PRD.

```
EXTREME RISK — Any slip here delays all downstream work by ≥1 sprint
  FR21  Overstory agent lifecycle
  FR28  Overlay composition pipeline
  FR32  Phase Boundary Protocol manifests  ← PRD explicitly calls this "highest design risk"
  FR14  6-layer hook runner infrastructure

HIGH RISK — Slip delays a significant functional cluster
  FR36  Pi SDK model tier directives
  FR48  SSE/WS event streaming
  FR42  Attribution chain
  FR55  Learning record writes
  FR40  Worktree lifecycle management
  FR1   Story intake + initiation

ELEVATED RISK — Slip degrades quality or monitoring without breaking core pipeline
  FR34  Superpowers enforcement metadata
  FR10  BMAD adversarial review
  FR149 Turn-based continuation (hidden blocker)
  FR145 Atomic task checkout
  FR170 System health circuit breaker
  FR77  Daily cron observer (meta-optimization entry point)

MODERATE RISK — Slip defers a feature but does not break others
  FR57  learning_report mail type
  FR59  Manual synthesis script
  FR130 Action-level process scoring
  FR163 Nyquist-BMAD disagreement protocol
  FR152 Lightweight structural verification
  FR120 Telegram bot connection
  FR171 Multi-channel notification abstraction

LOW RISK — Well-scoped extensions with clear predecessors
  FR62  Spike escape hatch
  FR63  Cascading retraction
  FR140 Performance data export
  FR102 Configurable BMAD review profiles
  FR94  Hook timeout bypass
  FR101 CLI meta-optimization revert fallback
```

---

## 10. Key Findings Summary

1. **FR21 (Overstory agent lifecycle) is the single highest cascade-risk FR** in the system. Everything runs through it. Any instability in Overstory agent spawn/stop/mail has system-wide blast radius.

2. **FR32 (Phase Boundary Protocol) is the highest design-risk FR** and the one most likely to require iteration. The PRD correctly identifies it as greenfield. The manifest schema must be finalized before dashboard visualization (FR45, FR20) can be correctly implemented — these are falsely marked as safely parallel in the PRD.

3. **pipeline.db schema is an unspecified blocking deliverable.** Nine MVP FRs write to pipeline.db tables that are described in the FRs themselves but never consolidated into a schema specification. This must be treated as Sprint 0 work.

4. **The credential sanitizer is an unspecified cross-cutting deliverable.** Referenced in NFR10/NFR33 but has no FR number. Must be implemented before any output-path FR is marked complete.

5. **FR149 (turn-based continuation) is critically underweighted.** The PRD lists it as MVP with no special priority. Without it, every story is a single-turn execution — the factory cannot realistically complete non-trivial stories.

6. **The learning system's critical path is longer than it appears.** FR167 (overlay learning enrichment) — a key differentiator and the PRD's "core innovation" — is at the end of a 7-FR dependency chain: FR55 → FR56 → FR59 → FR164 → FR165 → FR166 → FR167. All of these must function before the self-learning feedback loop delivers value.

7. **The Gateway API is an architectural assumption without a corresponding FR.** Several FRs reference "reads from pipeline.db via Gateway API" but this component is never explicitly defined. It needs an implementation task equivalent.

8. **The Growth phase behavioral system (FR133–FR169) is correctly gated.** The PRD's decision to defer all ELO/tier behavioral FRs to Growth — collecting data first (FR130–FR132) before acting on it — is architecturally sound and avoids the chicken-and-egg problem of behavioral routing before data exists.

---

*End of FR Dependency Graph & Critical Path Analysis*
*Generated: 2026-03-14 | Source PRD: prd-v2.md v2.0*
