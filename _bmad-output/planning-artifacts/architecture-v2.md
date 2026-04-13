> **v2.0** — Consolidated from base Architecture + Session 8 amendments (2026-03-10). ADR-015-020 revised. ADR-021-023 added. Credit economy, per-agent budgets, Drizzle ORM killed. Factory Core reframed as foundation.

---
status: 'complete'
completedAt: '2026-03-03'
inputDocuments:
  - "_bmad-output/planning-artifacts/prd.md"
  - "_bmad-output/planning-artifacts/prd-handoff-context.md"
  - "_bmad-output/planning-artifacts/prd-handoff-context-session3.md"
  - "_bmad-output/planning-artifacts/ux-design-specification.md"
sourceProjects:
  - "overstory/ — TypeScript/Bun, agent orchestration, mail, Mulch, Seeds"
  - "superpowers/ — skills, hooks, enforcement gates"
  - "zeroclaw/ — Rust + React/TS dashboard, cron, SSE/WS"
  - "pi-mono/ — TypeScript monorepo, model-agnostic runtime"
  - "claude-mem/ — memory system, progressive disclosure, hooks"
  - "QDS-engineer (v1) — Python/FastAPI, original factory prototype"
workflowType: 'architecture'
project_name: 'QDS-Engineer-New'
user_name: 'Steve'
date: '2026-03-03'
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## Architectural Reframing (Session 8)

### Factory Core as Foundation

**Factory Core is the FOUNDATION, not a peer component.** Factory Core owns the pipeline engine, phase boundaries, economic governance, self-learning extraction, and overlay composition. It is the brain that orchestrates all other components.

**Overstory, Pi SDK, and Superpowers are COMPONENTS that Factory Core calls into:**

| Component | Relationship to Factory Core | What Factory Core Uses |
|-----------|------------------------------|----------------------|
| **Overstory** | Agent orchestration library | `ov sling` for spawning, worktree isolation, 4-tier merge, mail.db for inter-agent comms, sessions.db for lifecycle, events.db for event store, metrics.db for telemetry, Seeds for task tracking, watchdog for health *(See Session 13 Note 1: Invariant/Mechanism Reclassification below)* |
| **Pi SDK** | Model-agnostic LLM runtime | Model selection, provider routing, tool execution, per-call `Usage { tokens, cost }` reporting, `AgentSession` with save/load/branch/compact |
| **Superpowers** | Read-only skill library | 14 skills, enforcement frontmatter, skill metadata for overlay injection |

**Session 13 Note 1: Invariant/Mechanism Reclassification**

The mechanisms listed in the Overstory row (worktrees, mail.db, sessions.db, events.db, metrics.db, Seeds, watchdog) are overstory's **implementation choices** for satisfying QDS architectural invariants. The invariants themselves — filesystem isolation per story, async inter-agent coordination, agent lifecycle state, event sourcing, cost telemetry, task tracking, health monitoring — are orthogonal to the specific mechanisms. See ADR-033 in `architecture-v2-session12-amendments.md` for the bias-stripped invariant/mechanism reclassification.

**Research repos are DESIGN INSPIRATION, not code transplant sources.** Session 7 demonstrated that the claimed 79% transplant ratio was inflated to ~43% on verified analysis. More importantly, the framing of "transplant" implies lifting code wholesale, which creates integration debt. The correct framing: we study proven patterns from PaperclipAI, GSD, DeerFlow, and Symphony, then write clean TypeScript/Bun code for our stack that embodies those patterns. We cite inspiration sources for traceability, but every line of code is native QDS code written to our conventions.

### Autonomous Merge Philosophy

QDS Engineer v2 executes entire epics through a phased quality pipeline. Code merges automatically without human oversight because the pipeline's quality verification is thorough enough to make human review the exception, not the rule:

- **Context isolation** ensures review agents never see development context (no sunk-cost bias)
- **BMAD adversarial review** is spec-compliance verification by fresh agents
- **5-wave QA swarm** covers structural, behavioral, and integration verification
- **Nyquist verification** (ADR-017) confirms the story's purpose was achieved, not just its tasks
- **Continuous lightweight verification** catches structural drift during development
- **Human escalation** is triggered only when automated systems cannot resolve disagreements

When issues escape this pipeline, **24/7 maintenance/QA agents** (cron-triggered) continuously scan the codebase, discover regressions, and dispatch fixes through the same quality pipeline. The next scan cycle verifies fixes landed correctly. This creates the autonomous self-healing loop.

### Self-Learning Vision

The primary metric for the self-learning system is **maintenance burden reduction over time**. Not agent "performance scores" or "reward credits" but the observable outcome: does the codebase require less maintenance as the system accumulates experience?

Three learning layers serve this goal:

1. **Codebase Knowledge (Layer 1):** What conventions, patterns, and integration points exist in this specific codebase. Enriches Overstory's mulch with structured learnings from fix-loops and maintenance fixes.
2. **Pattern Knowledge (Layer 2):** Cross-story insights ("modifying payments always requires webhook updates"). Mined from accumulated story data, stored in pipeline.db.
3. **Process Knowledge (Layer 3):** Factory operational tuning (which phase configurations produce best outcomes). Derived from pipeline execution metrics.

The feedback loop: every maintenance fix produces a categorized learning record that feeds back into overlay composition for future stories, reducing the probability of the same class of issue recurring.

---

## Project Context Analysis

### Requirements Overview

**Functional Requirements:**
129 FRs across 15 capability areas defining the complete factory platform:

| Capability Area | FR Range | Count | Architectural Weight | Architectural Support |
|---|---|---|---|---|
| Pipeline Execution | FR1–FR9 | 9 | Core — composable pipeline engine, work type declarations, phase transitions | ADR-002, ADR-003, pipeline subdirectory |
| Quality Enforcement | FR10–FR20 | 11 | Core — mechanical gate enforcement at phase boundaries (ADR-010 original 6-layer model, reframed as dual-plane edge-scripts + in-process engine in ADR-035), BMAD review, QA swarm | ADR-006, ADR-007, ADR-010, ADR-034, ADR-035 |
| Agent Orchestration | FR21–FR27 | 7 | Core — Overstory integration, lifecycle management, mail system | ADR-002 (Overstory integration) |
| Overlay & Context Management | FR28–FR35 | 8 | Core — 6-stage overlay pipeline, context budgets, Phase Boundary Protocol | ADR-004, ADR-013, stage-context |
| Resource & Economic Management | FR36–FR42 | 7 | Core — Pi SDK tier directives, budgets, circuit breakers, attribution chains | ADR-005, economics subdirectory |
| Dashboard & Observability | FR43–FR50 | 8 | Frontend — real-time SSE, xterm.js panels, stall detection, budget visualization | ADR-009, dashboard components/store |
| Git & PR Operations | FR51–FR54, FR90 | 5 | Integration — `gh` CLI, structured PR evidence, PR-to-Seeds feedback loop | Git conventions |
| Factory Learning System | FR55–FR63 | 9 | Novel — 3-loop learning, synthesis, injection, Superpowers gate validation | ADR-003, pipeline subdirectory |
| Memory & Knowledge | FR64–FR68 | 5 | Integration — Mulch extensions, Seeds universal task graph, git-shared state | Mulch/Seeds integration in overlay stages |
| Developer Operations | FR69–FR72 | 4 | Operations — setup script, per-developer config, independent instances | Config, per-developer instances |
| Operational Safety | FR73–FR76 | 4 | Cross-cutting — resource monitoring, graceful degradation, git safety | ADR-008, conventions |
| Meta-Optimization | FR77–FR89 | 13 | Novel — daily observer, weekly optimizer, auto-apply with safety net | Plugin subsystem with clean interface |
| Resilience & Integrity | FR91–FR104 | 14 | Cross-cutting — validation, file contention, credential security, story queuing | ADR-006/007/008, ADR-010 |
| Dashboard Copilot | FR105–FR119 | 15 | Frontend — CopilotKit + AG-UI, 3 interaction modes, programmatic UI control | ADR-011, copilot directories |
| Developer Communication | FR120–FR129 | 10 | Integration — Telegram Bot API, dual-channel notifications, inbound commands, async dialogue | ADR-014, messenger package |

**FR Dependency Tiers:**

*"First Story" FRs (critical path — blocks first end-to-end factory run):*
FR1, FR4–FR6, FR10–FR11, FR14–FR18, FR21–FR23, FR28–FR32, FR36–FR37, FR40, FR43–FR45, FR48, FR51 — approximately 30 FRs that must be implemented before a single story flows through the factory.

*"Full MVP" FRs (complete the platform but don't block first run):*
Remaining ~99 FRs including full dashboard polish (stall detection, copilot, budget visualization), learning system, meta-optimization, developer operations, resilience features, and developer communication layer (FR120-FR129).

*Architecturally isolated subsystem:*
Meta-Optimization (FR77–FR89, 13 FRs) is independently deployable. If it ships after the core pipeline, nothing breaks. The architecture should treat this as a plugin-style subsystem with a clean interface to Factory Core's operational data.

**Non-Functional Requirements:**
34 NFRs across 4 categories with measurable targets:

- **Performance (9):** SSE latency <2s, hook execution <2s, overlay assembly <500ms, 30fps with 12 xterm.js panels, copilot Ask-mode <3s, Telegram notification delivery <5s
- **Security (6):** Credential isolation via Pi SDK mediation, no secrets in any output (including Telegram messages), filesystem scoping, `factory.yaml` gitignored, branch namespace enforcement, Telegram credential sanitization
- **Reliability (9):** Agent crash recovery <30s, crash-safe atomic writes, SQLite concurrent access for 15 agents, exactly-once mail delivery, dashboard reconnection <5s, worktree cleanup all paths, quality pipeline <5% story cost
- **Operability (10):** Setup <5 minutes, macOS + Linux, 16GB RAM baseline with 8GB degradation, structured logs, 30s startup, hot-reload operational config, copilot investigations <15s, messenger NL daily cost ceiling

**Scale & Complexity:**

- Primary domain: Full-stack AI Workforce Management Platform
- Complexity level: High/Enterprise
- Estimated architectural components: 16 named subsystems (see below)
- Concurrent concerns: Real-time streaming, distributed agent coordination, multi-process orchestration, autonomous self-improvement, conversational AI integration

### Technical Constraints & Dependencies

**Runtime dependency chain:**
Factory Core → Pi SDK → Overstory → Agents. This is a layered runtime dependency. Factory Core provides policy (tier directives, budgets, context ceilings). Pi SDK provides model-agnostic execution (model selection, provider communication, cost/token reporting). Overstory provides agent orchestration (lifecycle, mail, checkpoint). Agents are the terminal execution units.

*Architectural implication:* If Pi SDK's API surface doesn't support tier directives as first-class concepts, Factory Core needs an adapter layer translating its policy model into Pi SDK's native configuration model. This must be verified against the actual Pi SDK codebase during architecture decisions.

**SQLite concurrency model:**
*Session 13 note: the architectural invariant here is **single source of truth for agent state with safe concurrent access** from multiple agents (NFR17). SQLite WAL mode is overstory's current mechanism for satisfying this invariant; alternative backends (Postgres, DuckDB) that provide equivalent concurrent-write safety would also satisfy the invariant. The discussion below documents the specific SQLite mechanism that overstory uses today. See ADR-033 for the bias-stripped invariant/mechanism reclassification.*

Overstory uses SQLite for agent state and mail delivery. NFR17 requires concurrent read/write from up to 15 agents without corruption. SQLite's default journal mode (DELETE) will hit `SQLITE_BUSY` under heavy concurrent writes. WAL (Write-Ahead Logging) mode is likely required — but WAL changes durability and recovery characteristics. The Overstory codebase must be inspected for current journal mode configuration. This is an architecture decision, not a configuration change.

**External dependencies:**
- `gh` CLI (authenticated, repo scope) — hard dependency for PR creation, the pipeline's terminal output
- Git (local) — worktree management, branch operations, commit attribution
- CI Pipeline — observe-only for MVP via `gh pr checks`
- CopilotKit + AG-UI — architectural dependency for dashboard copilot (15 FRs)

**Technology stack (locked by source projects):**
- Backend/orchestration: TypeScript/Bun (Overstory, Pi SDK)
- Dashboard: React 19 + TypeScript + Vite 6 + Tailwind CSS 4 (ZeroClaw fork — specifically the frontend directory, not the Rust cron engine)
- Cron/scheduling: Rust (ZeroClaw — post-MVP)
- State management: SQLite (Overstory), Zustand (dashboard)
- Terminal rendering: xterm.js
- Charts: recharts or visx
- Icons: Lucide React
- Fonts: Inter + JetBrains Mono

*Source project fork boundary:* ZeroClaw contains both a Rust backend (`src/`, `crates/`, `Cargo.toml`) and a React frontend shell. The architecture must identify exactly which directory contains the React dashboard shell being forked vs the Rust cron engine consumed later for Growth.

*Superpowers integration boundary:* `skills-core.js` is JavaScript, not TypeScript. The rest of the stack is TypeScript/Bun. The architecture must decide: wrap it, port it to TypeScript, or import as-is with type declarations. This affects type safety on the enforcement metadata schema.

**Developer environment:**
- macOS primary, Linux supported
- 16GB RAM baseline, 8GB degraded mode
- 2 developers (Steve + Marcus), independent factory instances, shared state via git

### Cross-Cutting Concerns Identified

**Ranked by architectural forcing function weight** (structural concerns that force architecture shape listed first, behavioral concerns that constrain interactions listed second):

**Structural (force architectural shape — resolve first):**

1. **Context isolation at phase boundaries** — forces fresh process spin-up, no shared memory, structured manifest transfer only. Shapes every component that touches the pipeline. Non-negotiable foundation of adversarial quality pipeline integrity. *Testing strategy required:* the architecture must define what "proof of isolation" looks like — manifest audit logs, canary token injection into dev context with verification of absence in review context, or hash comparison. This is the core guarantee; if untestable, it's untrustable.

2. **Attribution chain** — mandatory on every API call (`developer_id → story_id → phase → agent_id → model → provider → token_count → cost`). Every component that touches Pi SDK must participate. Calls without complete chains are blocked (FR96). Shapes all interfaces.

3. **Hook enforcement pipeline** — 6 layers with distinct trigger points (per-edit, per-task, per-phase, BMAD, QA). The agent execution model must be designed around hook injection points. Results feed into PR evidence, learning records, and dashboard display. *Layer interaction under failure must be addressed:* if a post-edit hook (Layer 2) times out (FR94), does the post-task hook (Layer 3) still fire? The timeout bypass must not create enforcement gaps.

4. **Credential isolation** — Pi SDK as sole API mediator. No key in any agent context, output, log, learning record, PR body, or committed file. Shapes the entire agent ↔ API boundary.

**Behavioral (constrain interactions — resolve during component design):**

5. **Context budget management** — every agent overlay assembled by Factory Core's `overlay.ts` within hard token ceilings. 6 ordered stages with per-stage budgets. Requires caching strategy with invalidation rules. *Correctness concern, not just performance:* stale Mulch = wrong conventions injected, stale retracted learning = retraction silently ignored. Cache invalidation is a correctness guarantee.

6. **Learning record lifecycle** — crash-safe atomic writes, story-outcome tagging, synthesis with Superpowers gate validation, tiered injection within token ceilings, cascading retraction. Spans agent runtime, phase transitions, and overlay composition.

7. **Error recovery & circuit breakers** — per-agent (3 recovery attempts), per-story (budget circuit breaker), global (daily budget ceiling). Graceful degradation matrix for disk, memory, API provider, and dashboard failures.

8. **Git safety iron laws** — no force-push, no commits to protected branches, factory-namespaced branches, structured commit attribution, hands-off git config. Non-negotiable across all operations.

9. **Resource monitoring** — disk, memory, token spend with configurable warning thresholds and hard limits. Affects story start and agent spawn decisions.

10. **Real-time state propagation** — SSE from Overstory to dashboard with <2s latency. State changes cascade to favicon, ambient strip, card borders, vitals strip, phase dots simultaneously. Dashboard reconnection with full state recovery.

11. **Copilot UI orchestration** — CopilotKit readable/action hooks bridge dashboard state and controls to conversational AI agent. Copilot acts through the UI at 300ms pace, not around it. Separate token budget from story budgets.

12. **Agent performance scoring pipeline** — action scores computed after every post-task hook, session scores on story completion, ELO ratings adjusted per story, tier evaluated against unlock criteria. Performance data feeds into overlay composition (prompt conditioning) and task routing (ELO-based matching). Must not add more than 200ms to post-task hook execution (NFR35).

13. **Goal-backward verification** — Nyquist verifier runs after QA swarm, starts from story goal, checks codebase delivers purpose. Must-haves schema (truths, artifacts, key_links) enforced via verification engine inspired by GSD patterns. Gaps feed into fix loop.

14. **Design inspiration integration** — Patterns studied from 4 research repos (PaperclipAI, GSD, DeerFlow, Symphony) are implemented as clean TypeScript/Bun code conforming to existing patterns (Zod schemas, atomic writes, EventStore events, shared-types conventions). All code is new-write native QDS code subject to all existing quality gates. Research repos provide design inspiration, not transplanted code.

### State Ownership Model

| State Category | Source of Truth | Storage | Sharing Model | Consistency Model |
|---|---|---|---|---|
| Agent lifecycle state | Overstory | SQLite | Per-instance (not shared) | Strong (transactional) |
| Mail / inter-agent comms | Overstory | SQLite | Per-instance | Strong (exactly-once delivery) |
| Economic state (cost attribution, per-story budgets) | Factory Core | Session database | Per-instance | Strong (every API call validated) |
| Pipeline state (phases, gates) | Factory Core | Session database + Overstory | Per-instance | Strong |
| PR evidence | GitHub (via `gh` CLI) | GitHub API | Shared (git repo) | Eventually consistent; copilot needs local access path (cache or API query) |
| Mulch expertise | Filesystem (`.mulch/`) | Markdown files | Shared via git (append-only) | Eventually consistent |
| Seeds task graph | Overstory/Seeds | SQLite or filesystem | Shared via git | Eventually consistent |
| Raw learning records | Filesystem (`.qds/learnings/`) | YAML files | Shared via git (date-partitioned, per-agent filenames) | Eventually consistent |
| Synthesized learnings | Filesystem (`.qds/learnings/synthesized/`) | YAML files | Local only (`.gitignore`d) | Per-developer |
| Meta-optimization journals | Filesystem (`.qds/meta/`) | YAML files | Per-instance | Per-developer |
| Dashboard view state | Dashboard (Zustand) | In-memory | Per-instance | Ephemeral |
| Messenger dialogues | Messenger | SQLite (`.qds/messenger.db`) | Per-instance | Strong (transactional) |
| Developer config | `factory.yaml` | YAML file | Per-developer (`.gitignore`d) | Local only |
| Performance scores & ratings | `pipeline.db` (sole source of truth) | SQLite WAL | Per-instance | Strong (SQLite locking) |
| Task checkouts | `attribution.db` `task_checkouts` table | SQLite | Per-instance | Strong (transactional) |
| Verification results | Filesystem (`.qds/verifications/`) | Markdown files | Shared via git | Eventually consistent |

### Design Co-Dependencies

**Phase Boundary Protocol ↔ Hook Infrastructure:** ~~These must be designed together even though they're implemented sequentially.~~ **RESOLVED in ADR-006 + ADR-010.** Phase Boundary Protocol (ADR-006) defines gate criteria and canary verification. Hook Pipeline (ADR-010) defines the execution model (Factory Core spawns gate scripts via `Bun.spawn()`), failure cascade (between-gate independent, within-gate fail-fast), and interface (`GateContext`/`GateResult` via stdin/stdout). Both interfaces are now fully specified — implementation can proceed on either side independently.

### Subsystem Inventory

17 named subsystems that the architecture will make decisions about:

| # | Subsystem | Scope | Critical Path? | Independently Deployable? |
|---|---|---|---|---|
| 1 | **Factory Core** | Pipeline engine, overlay composition, economic governance | Yes — the brain | No — depends on Pi SDK + Overstory |
| 2 | **Pi SDK Integration Layer** | Tier directives, model routing, cost/token reporting | Yes — runtime foundation | No — Pi SDK is prerequisite |
| 3 | **Overstory Extensions** | Agent lifecycle, mail extensions, checkpoint | Yes — agent coordination | No — depends on Pi SDK |
| 4 | **Hook Infrastructure** | Runner, gate scripts, enforcement pipeline | Yes — quality foundation | Partially — runner testable standalone, gates need Overstory |
| 5 | **Phase Boundary Protocol** | Manifests, context isolation, gate integration | Yes — quality guarantee | No — co-dependent with hooks |
| 6 | **Superpowers Consumption** | Overlay injection, enforcement frontmatter, skills-core | Yes — quality gates | Partially — overlay injection testable, enforcement needs hooks |
| 7 | **Dashboard Shell** | ZeroClaw fork, layout, SSE/WS, Zustand store | Yes — observation plane | Yes — can develop with mock SSE data |
| 8 | **Dashboard Components** | Story cards, agent panels, xterm.js, stall overlay, notifications | Yes — interaction plane | Yes — component-level testing |
| 9 | **Dashboard Copilot** | CopilotKit + AG-UI, readable/action hooks, orchestration layer | No — enhances dashboard | Yes — can ship after core dashboard |
| 10 | **Mulch Extensions** | Timestamps, provenance, dedup, category boosting | No — enhances context quality | Yes — independent of pipeline |
| 11 | **Factory Learning System** | 3 loops, records, synthesis, injection | No — enhances over time | Yes — injection via overlay.ts is the only integration point |
| 12 | **Meta-Optimization** | Daily observer, weekly optimizer, safety net | No — self-improvement layer | Yes — reads operational data, writes journals/config changes |
| 13 | **Git & PR Operations** | Branch management, PR creation, evidence template, PR-to-Seeds | Yes — pipeline terminus | Partially — PR creation testable, evidence needs upstream data |
| 14 | **Developer Operations** | Setup script, config, resource monitoring | Yes — first-run experience | Yes — independent tooling |
| 15 | **Seeds Extensions** | Universal task graph, cross-developer coordination | No — enhances coordination | Yes — extends existing Overstory Seeds |
| 16 | **Developer Communication (Messenger)** | Telegram bot, dual-channel notifications, inbound commands, async dialogue | No — enhances developer reach | Yes — independent EventStore consumer |
| 17 | **Agent Performance & Learning System** | 6-layer performance scoring, ELO ratings (Growth), capability tiers (Growth), three-layer learning architecture, progressive autonomy | No — enhances agent quality over time | Partially — scoring testable standalone, tier enforcement needs hooks |

**Standalone testability requirement:** Each subsystem must be testable without requiring the full factory to be running. The architecture must define testability boundaries — mock interfaces, test harnesses, and stub data — for each subsystem. This is the bootstrapping requirement: Steve and Marcus build the factory manually before the factory builds itself.

### Open Verification Items

Items requiring codebase inspection during architecture decisions:

1. **Pi SDK tier directive API** — verify actual API surface supports Factory Core's policy model for tier directives (economy/standard/premium per agent role)
2. **Overstory SQLite journal mode** — verify WAL mode configuration for NFR17 concurrent access
3. **ZeroClaw React shell location** — identify exact directory within zeroclaw repo containing the React 19 + TS + Vite + Tailwind frontend shell
4. **`skills-core.js` integration** — inspect Superpowers codebase to determine JS→TS migration path or wrapping strategy
5. **Overlay caching invalidation** — determine strategy for mid-session changes to Mulch and learning files (correctness guarantee, not just performance)
6. **Context isolation verification method** — define concrete testing strategy (canary tokens, manifest audit, hash comparison) for proving phase boundary isolation
7. **Hook layer failure interaction** — define behavior when hooks timeout/crash at each layer and impact on subsequent layers
8. **PR evidence access path for copilot** — determine whether copilot reads PR evidence from GitHub API, local cache, or session database

## Starter Template Evaluation

### Primary Technology Domain

**Multi-subsystem platform** — not a single starter template scenario. Two distinct initialization tracks with technology locked by source projects.

### Source Project Codebase Findings

Codebase inspection of all source projects resolved multiple open verification items and revealed critical architectural implications.

**ZeroClaw Frontend Shell** (`zeroclaw/web/`) — carry-forward items resolved in ADR-001. Key implementation context for dev agents:

| Provides | Carry Forward? |
|---|---|
| SSE client (`lib/sse.ts`) — fetch-based parser, auto-reconnect, exponential backoff, auth headers | Yes — transport plumbing (~200 LOC), types replaced |
| WebSocket client (`lib/ws.ts`) — auto-reconnect, session persistence, subprotocol auth | Yes — transport plumbing (~200 LOC), types replaced |
| Strict TypeScript config (`noUnusedLocals`, `noUncheckedIndexedAccess`), Vite proxy, CSP headers, `@/*` path alias | Yes — config files carried |

**Overstory** (`overstory/`) — findings resolved by ADRs omitted (WAL mode → ADR-003, event streaming → ADR-009, agent lifecycle → ADR-002). Implementation context retained:

| Finding | Architectural Impact |
|---|---|
| Overlay (`overlay.ts`) is template-based (`{{PLACEHOLDER}}` substitution), 25+ placeholders, reads from `templates/overlay.md.tmpl` | Factory Core's 6-stage composable pipeline is a **new system** that wraps `generateOverlay()` as one stage |
| Mail system: 12 message types with CHECK constraint, indexed on `(to_agent, read)` and `(thread_id)` | Must extend schema for `learning_report` — Overstory's migration system handles upgrades |
| Mulch client wraps `ml` CLI + programmatic API from `@os-eco/mulch-cli` | Mulch integration is CLI-based, not library-level |
| Seeds adapter implements TrackerClient interface via `sd` CLI | Seeds is CLI-based, same pattern as Mulch |

**Pi SDK** (`pi-mono/`) — findings resolved by ADRs omitted (tier directives, cost model, attribution chain, metadata passthrough → ADR-005). Implementation context retained:

| Finding | Architectural Impact |
|---|---|
| `Agent.transformContext()` hook for context manipulation before LLM call | Overlay injection integration point for Factory Core's composable pipeline |
| Sandbox extension model (`.pi/extensions/`) for filesystem/network restrictions | Hook enforcement can leverage this pattern |
| 7 packages: pi-ai (LLM API), pi-agent-core (runtime), pi-coding-agent (interactive), pi-mom (Slack), pi-tui, pi-web-ui, pi-pods | Core packages for Factory: pi-ai + pi-agent-core |

### Starter Template Decision

**Decision: Selective copy from ZeroClaw, not full fork. Fresh UX spec theme.**

Copy 6 infrastructure files into a new `dashboard/` directory. Write UX spec's `@theme` block fresh. Fresh `package.json` and all application code. Do not carry ZeroClaw's pages, components, auth, i18n, CodeMirror, or theme tokens.

**Rationale (validated by Advanced Elicitation + Party Mode):**

1. **Selective copy beats full fork** — fork carries ~20 files to delete with interconnected imports. Stripping cost exceeds carry-forward value. The 6 infrastructure files are the entire value proposition.

2. **Selective copy beats fresh scaffold** — `bun create vite` requires rebuilding SSE reconnection (~200 LOC), WS reconnection (~200 LOC), TypeScript strict config, Vite proxy config, and CSP headers. These are tested, production-quality transport infrastructure.

3. **Fresh theme beats remapping** — ZeroClaw's `@theme` tokens differ from UX spec in 8 of 12 values (different background shades, different status green hue, different accent blue, different text primary). Remapping risks breaking accessibility contrast ratios. Writing 15 lines of CSS from the UX spec is more reliable.

4. **Transport plumbing is the carry-forward value, not types** — SSE and WS clients provide reconnection, exponential backoff, auth headers, buffer management. The type contracts (`SSEEvent`, `WsMessage`) are replaced entirely with Overstory `StoredEvent` and factory command types from a shared-types package.

### Architecture Decision Records

**ADR-001: Dashboard Initialization — Selective Copy from ZeroClaw**

- **Status:** Accepted
- **Decision:** Copy 6 infrastructure files from `zeroclaw/web/`. Write fresh `@theme` from UX spec. Fresh `package.json` and application code.
- **Rationale:** Carries tested SSE/WS transport plumbing without stripping cost of full fork or rebuild cost of fresh scaffold. Theme written fresh to preserve UX spec contrast ratio guarantees.
- **Files carried:** `index.html`, `vite.config.ts`, `tsconfig.json`, `tsconfig.app.json`, `src/lib/sse.ts`, `src/lib/ws.ts`
- **Consequences:** Must adapt SSE/WS type contracts for Overstory event types. Must write UX spec `@theme` block (15 lines CSS). Must add 8 dependencies, write fresh `App.tsx`.

**ADR-002: Factory Core Package Boundary — Separate Package in Bun Workspace**

- **Status:** Accepted
- **Decision:** Factory Core is a separate TypeScript package in a Bun workspace monorepo. Source projects consumed from `vendor/` directory, not workspace members.
- **Rationale:** Pre-mortem analysis showed in-place extension creates implicit coupling — Factory Core changes break Overstory agent spawning. Separate package enforces explicit API boundary, enables independent testing, allows independent evolution.
- **Consequences:** Overstory must export a public API. Factory Core declares Overstory as dependency. Project is a Bun workspace monorepo with clear `packages/` vs `vendor/` boundary.

### Monorepo Layout

See **Complete Project Directory Structure** in the Project Structure & Boundaries section for the full monorepo layout with every file explicitly placed and annotated with ADR references.

**Component directory structure mirrors UX spec Implementation Roadmap phases:**
- `shared/` — cross-cutting primitives (StatusBorder, StatusDot)
- `core/` — Phase 1 components (AmbientHeader, StoryCard, PipelineProgress, CardMetaRow)
- `story-detail/` — Phase 2 story expansion (StoryDetail, GateChecklist, BudgetProjection)
- `agents/` — Phase 2 agent interaction (AgentPanel, StallOverlay, NudgeInput)
- `copilot/` — Phase 3 conversational (CopilotPanel, CopilotMessage)
- `notifications/` — Phase 4 polish (StallNotification, ReconnectionToast, ContextualTooltip)
- `findings/` — Phase 4 quality (FindingCard)

### Mock Data Layer

The gateway package includes a **mock mode** that emits fake SSE events matching Overstory's `StoredEvent` schema. This is a prerequisite for dashboard development — without it, no frontend component can be built or visually verified.

Mock mode emits: factory vitals, story status changes, agent state transitions, phase progressions, stall events, budget updates, completion events. Dashboard development starts immediately without waiting for Factory Core or Overstory integration.

This also satisfies the **standalone testability requirement** from the subsystem inventory: the dashboard is independently testable with mock SSE data.

## Core Architectural Decisions

### Architectural Compatibility Matrix

Canonical dependency versions live in `package.json` files. This table records compatibility validation performed during architecture decisions — it documents WHY these versions were validated together, not what versions to install.

**Verified 2026-03-03:**

| Technology | Architecture Doc Version | Current Stable | Updated To |
|---|---|---|---|
| Bun | (implied latest) | 1.3.9 (Feb 2026) | `^1.3.9` |
| React | 19 | 19.2.4 (Jan 2026) | `^19.2.4` |
| Vite | 6 | 7.3.1 (Vite 7 stable) | `^7.3.1` |
| Tailwind CSS | 4 | 4.1.x | `^4.1.0` |
| TypeScript | 5.7 | 5.9.3 | `~5.9.3` |
| Zustand | (implied latest) | 5.0.11 | `^5.0.11` |
| xterm.js | (implied latest) | 6.0.0 (scoped: `@xterm/xterm`) | `^6.0.0` |
| CopilotKit | (implied latest) | 1.52.1 | `^1.52.1` |
| recharts | (implied latest) | 3.7.0 | `^3.7.0` |
| bun:sqlite | built-in | Native (3-6x faster than better-sqlite3) | Built-in |

### Category 1: Data Architecture

Three decisions resolved through 10 Advanced Elicitation methods across 2 rounds.

#### ADR-003: Pipeline State Storage — SQLite WAL at `.qds/pipeline.db`

- **Status:** Accepted
- **Decision:** Factory Core stores pipeline state in a dedicated SQLite database at `.qds/pipeline.db` using WAL mode with `busy_timeout = 5000`, consistent with Overstory's 5-database pattern.
- **Rationale:** (1) Query capability for dashboard projections, stall detection, and historical analysis. (2) Federation-ready — WAL-tailing event emitter enables cross-instance replication without schema changes. (3) Compliance-ready — SQL queries for audit trails vs grep-parsing JSON files. (4) Algorithm Olympics confirmed SQLite handles 10K+ runs without degradation. (5) Consistency with Overstory's proven WAL pattern reduces cognitive load.
- **Affects:** Factory Core (`packages/factory-core/src/pipeline/`), Gateway (SSE projection queries), Dashboard (pipeline state display), shared-types (pipeline state interfaces)
- **Provided by Starter:** No — new decision

**Pipeline DB Schema:** 3 tables (`pipeline_runs`, `phase_transitions`, `gate_results`) in SQLite WAL mode at `.qds/pipeline.db`. Key constraints: `pipeline_runs.status` CHECK constraint for valid states, composite indexes on `(run_id, created_at)` for time-ordered queries, foreign keys between transitions and runs. Canonical types: `shared-types/src/pipeline.ts`

**Debug snapshot:** On every phase transition, Factory Core writes a human-readable JSON file to `.qds/debug/{run_id}/{phase}.json` containing the full pipeline state. These files are `.gitignore`d, ephemeral, and exist solely for developer debugging. They are NOT the source of truth.

**WorkflowEnforcer port:** v1's 350 LOC Python state machine (`WorkflowEnforcer`) ports to TypeScript as the `PipelineStateMachine` class, backed by `pipeline_runs` + `phase_transitions` tables instead of `.qds_workflow_state.json`. State transitions are atomic (single SQLite transaction).

#### ADR-004: Overlay Cache Strategy — No Cache, Cache-Ready Interface

- **Status:** Accepted
- **Decision:** No overlay cache at launch. Implement a cache-ready `OverlayStage` interface that can accept caching without pipeline changes when profiling demands it.
- **Rationale:** (1) Content-addressed caching saves only ~1ms per overlay assembly — xxhash64 at >10GB/s over <50KB Mulch directory. (2) Cache invalidation is a correctness concern (stale Mulch = wrong conventions, stale retracted learning = retraction ignored). (3) First Principles analysis: cache complexity (invalidation logic, coherence across stages, testing surface) exceeds the 1ms benefit. (4) Cache-ready interface preserves the option without paying complexity cost now.
- **Affects:** Factory Core (`packages/factory-core/src/overlay/`), shared-types (`OverlayStage` interface)
- **Provided by Starter:** No — new decision

**Cache-ready interface:**

```typescript
interface OverlayStage {
  name: string;
  priority: number;
  estimate(context: StageContext): number;  // token estimate
  render(context: StageContext, budget: number): string;  // rendered content
}
```

When caching is needed (profiling proves >10ms assembly time), add an optional `cacheKey(context: StageContext): string` method to `OverlayStage`. Stages that implement it get cached; stages that don't are always re-rendered. No pipeline changes required.

#### ADR-005: Attribution Chain Storage — Separate `attribution.db` with Call-ID Correlation

- **Status:** Accepted
- **Decision:** Attribution chains stored in a separate SQLite database at `.qds/attribution.db` with a `budgets` table co-located for atomic attribution+budget writes. Correlation uses a pre-generated `call_id` (UUID) pattern, not `StreamOptions.metadata` passthrough.
- **Rationale:** (1) `StreamOptions.metadata` is NOT echoed back by providers — Factory Core cannot rely on metadata round-tripping for correlation. (2) Separate database enables independent backup, migration, and compliance queries without touching pipeline state. (3) Budget table co-located with attribution (not in `pipeline.db`) enables atomic `INSERT attribution + UPDATE budget` in a single transaction. (4) Pre-call `call_id` insertion creates a correlation anchor: Factory Core holds its own context (story_id, phase, agent_id, developer_id), generates `call_id`, inserts partial row, makes API call, merges usage data post-response. (5) Reverse Engineering from 2028 end-state confirmed separate attribution storage for federation and compliance.
- **Affects:** Factory Core (`packages/factory-core/src/economics/`), shared-types (attribution interfaces), Dashboard (budget visualization), Meta-optimization (cost analysis queries)
- **Provided by Starter:** No — new decision

**Attribution DB Schema:** 2 tables (`attribution_chain`, `budgets`) in SQLite WAL mode at `.qds/attribution.db`. Key constraints: every row carries full chain (`developer_id -> story_id -> phase -> agent_id -> model -> provider -> token_count -> cost`), `completed_at IS NULL` older than 5 minutes flagged as orphans. Canonical types: `shared-types/src/budget.ts`

**Attribution Correlation Contract:** Pre-call: insert partial attribution row with `call_id` and full context chain. Post-call: merge usage data and increment budget atomically in a single transaction. Budget exceeded: emit `budget_exceeded` SSE event and halt new agent spawns for the story, but do NOT block the current in-flight API call (accept one-call overshoot). Canonical location: `factory-core/src/economics/attribution.ts`

**Budget enforcement model:**
- **Strict validation** for Factory Core fields (`story_id`, `phase`, `agent_id`, `developer_id`): throws `AttributionError` immediately. These are bugs, not user errors.
- **Advisory enforcement** for budget ceiling: emits `budget_exceeded` event, halts new agent spawns for the story, but does NOT block the current in-flight API call. Accepts one-call overshoot. Rationale: blocking mid-call creates stall vectors; the overshoot is bounded by a single API call cost.

**Unattributed API call categories (by design):**
Three categories of API calls are intentionally unattributed to story budgets:
1. **Headless Pi calls** — model registry queries, health checks. Attributed to `system:infrastructure`.
2. **Error recovery calls** — agent crash recovery, watchdog triage. Attributed to `system:recovery`.
3. **Orchestrator session calls** — Factory Core's own decision-making (e.g., tier selection). Attributed to `system:orchestrator`.

These use a separate `system` budget line in `factory.yaml` with its own daily ceiling.

**Orphan detection:** Rows with `completed_at IS NULL` older than 5 minutes are flagged as orphans. Dashboard displays orphan count. Meta-optimization queries orphan patterns for systemic issues.

### Category 2: Authentication & Security

Resolved via Party Mode Round 4 (Winston/Amelia/Quinn). 10 design items across 3 ADRs, 6 unanimous decisions, 4 splits resolved.

#### ADR-006: Phase Boundary Protocol Implementation

- **Status:** Accepted
- **Decision:** 5-layer defense with specific implementation choices for each layer.
- **Affects:** Factory Core (`packages/factory-core/src/phase-boundary/`), Overstory extensions (mail schema, tmux cleanup), Hook Infrastructure, shared-types (manifest schema)
- **Provided by Starter:** No — new decision

**5a — Transcript Quarantine: (C) Both — move/rename + deniedDirectories**
- Defense in depth. `fs.rename()` moves `~/.claude/projects/{project}` to `.quarantine-{phaseId}-{timestamp}` (same-fs inode op, ~instant). Then update `settings.local.json` to add quarantine path to `deniedDirectories`.
- Sequence after dev phase kill: kill tmux session → move transcript files → set deniedDirectories → verify → launch review agent. Cleanup must be idempotent.
- Implementation trap: `fs.rename` fails cross-device. Assert quarantine dir is on same mount at startup.

**5b — Manifest Learnings Field: (C) JSON Schema with oneOf constraints**
- Deterministic validation via `ajv`. Extensible without code changes (add oneOf variants to schema file).
- Schema is a versioned artifact in `config/schemas/manifest-learnings.schema.json`.
- Manifest parser must reject unknown schema versions (fail closed, not open).
- Initial categories: `pattern`, `anti-pattern`, `perf-hint`, `api-constraint`, `test-gap` — each with type-specific required fields.

**5c — Review Agent Worktree: (A) Fresh `git worktree add` from dev branch HEAD**
- Fresh worktree from the dev branch's HEAD commit. Reviewer sees exactly the committed dev output.
- Clean filesystem: no build artifacts, no `.claude/` dir, no temp files, no node_modules.
- Dev phase must produce a clean commit before phase transition. Manifest references commit SHA.
- 2-5s cost per worktree creation — within budget. Cleanup via `git worktree remove` in phase teardown.
- NOT from main branch — reviewer needs to see dev's changes, not just main.

**5d — Overstory Mail Phase Scoping: (A) Phase column + PhaseScopedMailClient wrapper**
- `ALTER TABLE mail ADD COLUMN phase TEXT NOT NULL DEFAULT 'dev'` + composite index `(phase, to_agent, read)`.
- Factory Core wraps Overstory's mail client with `PhaseScopedMailClient` that hardcodes the phase filter. This wrapper is the ONLY mail interface exposed to agents — no raw mail query access.
- NOT separate mailboxes per phase — separate DBs break Overstory's existing CHECK constraint on 12 message types, double migration surface, and complicate cross-phase audit queries.

```typescript
class PhaseScopedMailClient {
  constructor(private inner: MailStore, private phase: string) {}
  async list(agentId: string): Promise<Mail[]> {
    return this.inner.listByPhase(this.phase, agentId);
  }
  // No raw query method exposed — structural enforcement at application boundary
}
```

**5e — Behavioral Leakage Testing: (C) Hybrid — automated statistical correlation + human audit**
- Automated layer: lexical overlap between dev reasoning and review comments, time-to-first-finding correlation with dev phase duration, review coverage pattern correlation with dev edit frequency per file.
- Automated gates CI. Flagged anomalies + random sample go to human audit.
- Three metrics: lexical overlap (should be near zero), timing correlation (should be uncorrelated), coverage correlation (should be uncorrelated).
- Threshold: >0.7 similarity on any dimension = FLAG for human. <0.3 all dimensions = PASS. Middle = inconclusive, needs larger sample.

#### ADR-007: Context Isolation Testing Strategy

- **Status:** Accepted
- **Decision:** In-band verification on every transition with binary+degraded scoring and adaptive Merkle audit.
- **Affects:** Factory Core (`packages/factory-core/src/phase-boundary/`), Dashboard (isolation confidence display), shared-types (IsolationResult)
- **Provided by Starter:** No — new decision

**6a — Isolation Test Frequency: (A) Every transition, in-band**
- Canary injection + verification costs ~162ms per transition. With 4 transitions per story, ~650ms total. Noise against story durations of minutes to hours.
- Security boundary verified BEFORE review agent starts. No tainted results to discard on failure.
- Canary tokens: 3 per transition (system prompt, tool output, conversation context), format `QDS-CANARY-{LAYER}-{UUID}`.
- Verification scans all 6 leakage vectors. If any canary found → FAIL → halt pipeline.

**6b — Isolation Confidence Scoring: (C) Binary pass/fail + degraded state**
- Three actionable states:
  - **PASS**: All 5 layers verified clean. Proceed.
  - **DEGRADED**: Canary tokens clean but secondary indicators anomalous (unexpected files in worktree, suspicious env vars, partial quarantine). Proceed with warning + investigation trigger.
  - **FAIL**: Canary token detected. Hard stop. Kill review session.
- Three consecutive DEGRADED results within a window → escalate to FAIL.

```typescript
type IsolationResult =
  | { status: 'pass'; checks: CheckResult[] }
  | { status: 'degraded'; checks: CheckResult[]; warnings: string[] }
  | { status: 'fail'; checks: CheckResult[]; violations: string[] };
```

**6c — Merkle Tree Audit Scope: (C) Adaptive**
- Default (every transition): Hash manifest + `settings.local.json` + `.claude/` dir listing. Fast (~3-5 files).
- Escalated (triggered by degraded result, config change, first run, daily schedule): Hash full worktree via `git ls-files` + untracked.
- Escalation trigger is itself testable as a unit assertion.
- Hash and mode stored in `phase_transitions.manifest_hash` column (already exists in ADR-003 schema).

#### ADR-008: Credential Isolation — Programmatic Init, Never Env Vars

- **Status:** Accepted
- **Decision:** Factory Core passes credentials to Pi SDK via programmatic constructor init. No env var propagation. Dual-layer credential presence detection (Pi SDK strips at source + regex scan all outputs).
- **Affects:** Factory Core (`packages/factory-core/src/economics/credential-manager.ts`), Pi SDK integration, Overstory extensions (tmux session env), shared-types (credential scan patterns)
- **Provided by Starter:** No — new decision

**C4a — Credential Propagation: (A) Programmatic init, never env vars**
- Factory Core holds credentials in-memory. Passes to Pi SDK via constructor/init call — NEVER via env vars.
- Agents spawned via tmux do NOT inherit API keys. They call Pi SDK through Overstory, which holds the initialized session.
- Eliminates the #1 credential leak vector: env var inheritance through `child_process.exec` → tmux → shell (3 layers of env inheritance in Overstory).
- Upgradeable to per-call vault later without changing Pi SDK interface.

**C4b — Credential Presence Detection: (C) Both — strip at source + regex scan**
- Layer 1: Pi SDK strips known credential fields from responses before returning to Factory Core.
- Layer 2: Factory Core's output sanitizer scans all text outputs (agent output, logs, PR bodies, learning records, git commit messages) for credential patterns.
- Patterns: Anthropic keys (`sk-ant-*`), GitHub PATs (`ghp_*`), PEM keys, OpenRouter keys, base64-encoded keys, URL-embedded credentials.
- Credential detection → immediate rotation (assume credential has been observed).
- Extends Overstory's existing `sanitizer.ts` (5 regex patterns) with additional provider patterns.

### Category 3: API & Communication

Resolved via Party Mode Round 5 (Winston/Amelia/Barry). Two ADRs covering 9 sub-decisions, backed by 4 parallel research agents (Bun SSE patterns, hook runner architectures, WS command handlers, Overstory codebase analysis).

#### ADR-009: Gateway Architecture — SSE Translation + WS Command Handler

- **Status:** Accepted
- **Decision:** `Bun.serve()` gateway with SSE outbound (EventStore polling → HTTP SSE) and WS inbound (dashboard commands → Factory Core). 5 sub-decisions below.
- **Affects:** Gateway (`packages/gateway/`), Dashboard (SSE/WS clients from ZeroClaw carry-forward), shared-types (event contracts, command contracts), factory.yaml (gateway config)
- **Provided by Starter:** Partially — SSE/WS client transport plumbing carried from ZeroClaw. Server-side is new.

**G1 — SSE Streaming Contract**

- Gateway polls EventStore via cursor-based SQL query (`WHERE id > $cursor ORDER BY id ASC LIMIT 100`) every 500ms
- Yields SSE events in wire format: `id:{event_id}\nevent:{event_type}\ndata:{json_payload}\n\n`
- Sends keepalive comment (`:keepalive\n\n`) every 15s on idle connections
- Cleanup via request abort signal
- Server implementation: Express under Bun (see ADR-011 G1). Canonical location: `gateway/src/sse/poller.ts`, `gateway/src/sse/stream.ts`

**G2 — Polling Interval: Fixed 500ms with cursor-based query**
- Gateway queries `SELECT * FROM events WHERE id > $cursor ORDER BY id ASC` every 500ms.
- Overstory's `feed.ts` uses a 60-second lookback window with client-side `id > lastSeenId` filtering — wasteful. Gateway uses `WHERE id > $cursor` directly, hitting the `idx_events_run_time` index.
- At 15 concurrent agents: ~50 events/second peak. At 500ms polling: ~25 rows scanned per poll. Trivial load.
- Adaptive polling adds complexity for no measured gain. Fixed 500ms is well within the <2s SSE latency NFR.

**G3 — Backpressure & Reconnection: Native Bun backpressure + snapshot fallback**
- **No ring buffer.** Bun v1.2.18 added automatic backpressure for ReadableStream responses — pauses reading when socket is busy. This prevents unbounded buffering.
- Ring buffer drops data — unacceptable for quality pipeline events (a dropped gate result means the dashboard shows stale quality status).
- **Reconnection:** On `Last-Event-ID` header, gateway queries `WHERE id > $lastEventId` with 500-event cap. If gap exceeds 500, send `event: snapshot` with full current pipeline state instead of individual catch-up events.
- Reconnection budget: ~1.4s (well within NFR19's 5s budget).

**G4 — WS Command Dispatch: Discriminated union + handler map + Zod validation**
- `DashboardCommand` is a discriminated union in `shared-types/src/commands.ts` with `type` field.
- All commands carry `commandId` (UUID) for request/response correlation.
- Server always sends `CommandAck` (accepted/rejected). Query commands also send `CommandResult`. Copilot streaming sends `CommandPartial` messages keyed to same `commandId`.
- Handler map with exhaustive type checking: missing handler = compile-time error.
- Zod `z.discriminatedUnion("type", [...])` validates incoming JSON at the WebSocket boundary before dispatch.
- ZeroClaw WS client (146 LOC) carries forward: auto-reconnect, session persistence, exponential backoff. Type contracts replaced with factory command types.

```typescript
type DashboardCommand =
  | { type: "nudge_agent"; commandId: string; agentId: string; message: string }
  | { type: "stop_story"; commandId: string; storyId: string; confirmed: boolean }
  | { type: "adjust_budget"; commandId: string; storyId: string; newCeiling: number }
  | { type: "phase_transition"; commandId: string; storyId: string; targetPhase: string }
  | { type: "copilot_ask"; commandId: string; question: string; context?: unknown }
  | { type: "copilot_investigate"; commandId: string; target: string }
  | { type: "copilot_suggest"; commandId: string; scope: string };

type ServerMessage =
  | { type: "command_ack"; commandId: string; status: "accepted" | "rejected"; reason?: string }
  | { type: "command_result"; commandId: string; result: unknown }
  | { type: "command_partial"; commandId: string; chunk: unknown }
  | { type: "command_error"; commandId: string; error: string; code?: string };
```

**Command semantics:**

| Command | Semantics | Rationale |
|---|---|---|
| `nudge_agent` | Fire-and-forget with ACK | Outcome arrives via SSE (agent state change) |
| `stop_story` | Request-reply | Destructive. Requires `confirmed: true`. |
| `adjust_budget` | Request-reply | New ceiling echoed back for UI update |
| `phase_transition` | Request-reply | Validation response (is transition legal?) |
| `copilot_ask` | Streaming reply | Multiple `CommandPartial` → terminal `CommandResult` |
| `copilot_investigate` | Request-reply | Up to 15s per NFR |
| `copilot_suggest` | Request-reply | Returns suggestions |

**Concurrent command handling:** Commands execute concurrently by default. State-modifying commands on the same story serialize via per-story async queue (optimistic FIFO). All state-modifying commands are idempotent where possible.

**G5 — WS Authentication: Origin check + startup token + localhost binding**
- Bind gateway to `127.0.0.1` only — never `0.0.0.0`.
- Origin header check rejects non-localhost origins (blocks Cross-Site WebSocket Hijacking per CVE-2025-52882 class).
- Startup-generated random token written to `.qds/ws-token` (`.gitignore`d). Regenerated on every gateway restart. Dashboard reads token and passes via subprotocol: `protocols.push(`bearer.${token}`)` — carries forward ZeroClaw pattern exactly.
- Destructive commands (`stop_story`) require `confirmed: true` field — enforcement is UI-side confirmation dialog, server rejects without it.

#### ADR-010: Hook Pipeline Architecture — Gate Scripts + Event-Sourced Results

- **Status:** Accepted
- **Decision:** Factory Core orchestrates a tiered enforcement system: L1-L2 via Claude Code's native hooks (deployed by hooks-deployer), L3 gate scripts spawned by Factory Core at phase transitions, L4-L5 review/QA agents launched via Overstory, L6 data projection function. Results stored as events in Overstory's events.db.
- **Affects:** Factory Core (`packages/factory-core/src/hooks/`, `packages/factory-core/src/pipeline/`), Overstory (EventType extension), shared-types (GateContext, GateResult, Finding), Dashboard (hook result display)
- **Provided by Starter:** Partially — hooks-deployer.ts (L1-L2 deployment) exists in Overstory. Gate script infrastructure (L3) and result storage pattern are new.

**H1 — Execution Model: Factory Core spawns gate scripts, no separate runner**

> **Session 13 reframing (ADR-035, `architecture-v2-session12-amendments.md`):** The 6-layer count and its specific names are **organizational, not architectural**. The architectural invariant is *gated mechanical verification at phase boundaries before context wipe* (see ADR-033 invariant 5). ADR-035 adopts a **dual-plane architecture** that satisfies this invariant via two coordinated runtime layers rather than six ordered scripts:
>
> 1. **Edge plane** — overstory's existing `src/agents/hooks-deployer.ts` (606 LOC POSIX shell script generator) remains unchanged. It writes `.claude/settings.local.json` to each worker's worktree with path-boundary guards, bash-command guards, capability-based file-modification guards, and git-safety guards. This is the L1–L2 equivalent in the 6-layer taxonomy. Runs in `/bin/sh`, zero runtime dependencies.
>
> 2. **In-process plane** — Factory Core's `factory-core/src/hooks/` (a ~400 LOC clean-room TypeScript hook engine introduced by ADR-035 and implemented inside Story 1.7) runs in-process at phase-boundary transitions. It is where ADR-034's lifted `@claude-flow/guidance` gates, `IEvaluator` implementations, `ShardRetriever`, and QDS-specific evaluators register and execute with priority ordering, timeout wrap, and typed result aggregation. This is the L3–L6 equivalent in the 6-layer taxonomy.
>
> The table below retains the 6-layer categorization as the **current mechanism mapping** from the original ADR-010 framing. Future sessions may collapse or expand the layer count (for example, ADR-035's in-process plane handles L3–L6 in one module, which could be described as a 2-layer model — dual-plane edge + in-process) without breaking the invariant. **The invariant is "gates at phase boundaries"; the mechanism is "how many distinct scripts and where they run."** See ADR-035 "Borrowed Concepts" table for the explicit list of patterns lifted conceptually from ruflo's `@claude-flow/hooks` design versus the ones rejected (ReasoningBank / HNSW / ONNX / daemons — none of which are in QDS scope).

Barry's taxonomy clarifies the 6-layer model into three mechanical categories:

| Category | Layers | Mechanism | Managed By |
|---|---|---|---|
| **Hook rules** | L1 (PreToolUse), L2 (PostTask) | Claude Code's native hook system | Overstory's hooks-deployer.ts deploys rules to `.claude/settings.local.json` |
| **Gate scripts** | L3 (Phase boundary) | `Bun.spawn()` child process per gate script | Factory Core's phase transition logic |
| **Agent launches** | L4 (BMAD review), L5 (QA swarm) | `ov sling` agent invocation | Factory Core orchestrates via Overstory |
| **Data projection** | L6 (PR evidence) | Query function over events.db | Factory Core's PR builder |

- Factory Core calls `Bun.spawn()` to execute each gate script at phase transitions. No separate "runner" daemon.
- Gate scripts run as child processes with their own memory space. A crashing gate script does not affect Factory Core.
- Gate script timeout: configurable per gate, default 30s. Timeout → exit code mapped to DEGRADED.
- `SessionStart` hook remains synchronous (`async: false`) per existing Overstory/Superpowers convention.

**H2 — Result Storage: `hook_result` events in Overstory's events.db**

- Extend Overstory's `EventType` union to include `hook_result`.
- Update CHECK constraint: `CHECK(event_type IN ('tool_start','tool_end','session_start','session_end','mail_sent','mail_received','spawn','error','custom','hook_result'))`.
- Hook result data stored as JSON in the `data` column: `{ gateResult: GateResult, gateName: string, layer: number }`.
- Gateway SSE poller already polls events.db — hook results appear in the dashboard SSE stream automatically.
- PR evidence builder (L6) queries: `SELECT * FROM events WHERE event_type = 'hook_result' AND run_id = $runId ORDER BY created_at ASC`.
- **No separate hooks.db.** One database, one polling loop, one SSE channel. Separate DB would double infrastructure for no benefit.

**H3 — Failure Model: Between-gate independent, within-gate fail-fast**

- **Between layers (L1→L6):** Independent. L2 (per-task) failing does NOT skip L3 (phase boundary). Each layer answers a different quality question.
- **Within L3 gate scripts:** Fail-fast ordering. If canary verification (ADR-007) returns FAIL, subsequent gate scripts (manifest validation, behavioral analysis) are skipped. Canary FAIL = hard stop = pipeline halted.
- **DEGRADED escalation:** 3 consecutive DEGRADED results from the same gate script within a configurable window → escalate to FAIL. Prevents degraded-state drift.
- **Crash classification:** Gate script crash (non-zero exit code other than 1 or 2) → classified as DEGRADED (infrastructure issue), not FAIL (quality finding). Rationale: crashes indicate gate script bugs, not code quality problems.

**H4 — Gate Script Interface: stdin JSON → stdout JSON + exit codes**

- Industry-converging pattern: Claude Code hooks, GitHub Actions runner hooks, and Gemini CLI all use stdin/stdout + exit codes.
- Exit code semantics: `0` = pass, `1` = fail, `2` = degraded.
- `GateContext` and `GateResult` defined in `shared-types`:

```typescript
interface GateContext {
  runId: string;
  storyId: string;
  phase: string;         // current phase
  targetPhase: string;   // phase transitioning to
  manifestPath: string;  // path to phase manifest JSON
  worktreePath: string;  // path to agent's worktree
  agentName: string;     // agent that just completed
  timestamp: string;     // ISO 8601
}

interface GateResult {
  status: 'pass' | 'fail' | 'degraded';
  findings: Finding[];
  durationMs: number;
  metadata?: Record<string, unknown>;
}

interface Finding {
  severity: 'error' | 'warning' | 'info';
  category: string;      // e.g., 'isolation', 'manifest', 'credential', 'behavioral'
  message: string;
  file?: string;
  line?: number;
  evidence?: string;     // supporting data for PR evidence template
}
```

- Factory Core spawns gate script: `Bun.spawn(["bun", "run", gatePath], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })`. Writes `GateContext` JSON to stdin. Reads `GateResult` JSON from stdout. Reads exit code from process completion.
- Gate scripts are language-agnostic: any executable that reads stdin JSON and writes stdout JSON with correct exit code.

---

### ADR-011: Dashboard Copilot Architecture (CopilotKit + AG-UI)

**Status:** Accepted
**Decision:** CopilotKit + AG-UI integration architecture for the dashboard copilot (FR105-FR119).
**Party Mode Round:** 6 — Sally (UX Designer), Amelia (Developer), Winston (Architect). All 4 sub-decisions unanimous.

**G1 — CopilotKit Runtime: Express under Bun, single port, single process**

- CopilotKit v1.52.1's `copilotRuntimeNodeHttpEndpoint` requires Node.js `(IncomingMessage, ServerResponse)` signature, incompatible with `Bun.serve()`'s Fetch API. Express under Bun resolves this as a compatibility layer with near-native performance.
- This amends ADR-009 G1: the SSE streaming contract remains unchanged, but the HTTP server is Express, not raw `Bun.serve()`.

**Gateway Server Contract:** Single Express application running under Bun runtime. Mounts: CopilotKit endpoint at `/api/copilotkit` via `copilotRuntimeNodeHttpEndpoint`, SSE endpoint at `/events` (EventStore poller), WS upgrade at `/ws` (dashboard commands). Binds to `127.0.0.1:{GATEWAY_PORT}` (default 3001), never `0.0.0.0`. CORS restricted to localhost origins with credentials. Canonical location: `gateway/src/app.ts`

**G2 — AG-UI: Internal to CopilotKit, no direct dependency**

- AG-UI (Agent-User Interaction Protocol) is CopilotKit's internal transport — 17 event types across 7 categories, SSE-based. CopilotKit abstracts AG-UI behind `useCopilotReadable` and `useCopilotAction`. No reason to consume AG-UI events at the protocol level.
- **Do NOT add `@ag-ui/client` or `@ag-ui/core` as direct dependencies.** CopilotKit manages AG-UI internally. When CopilotKit upgrades, AG-UI comes along.
- Pin `@copilotkit/react-core` and `@copilotkit/runtime` at `^1.52.1`. Pin `@copilotkit/react-ui` at `^1.52.1`.
- Copilot actions route through the Zustand store — same path as UI clicks. This satisfies FR110: "the copilot does not bypass the dashboard's control surface or access factory APIs directly."

**G3 — Token Cost Mitigation: Three-tier context strategy**

FR111 requires `useCopilotReadable` to expose: active stories, agent statuses, pipeline positions, budget/cost, stall indicators, meta-optimization status, factory vitals. Naive serialization could push 2000+ tokens per copilot turn. FR118 specifies economy-tier model with tighter context windows.

**Tier 1 -- Always-on summary (~200 tokens):** Compressed string format with active story count by status (green/amber/red), agent count by activity (coding/reviewing/stalled), cost today with headroom, factory status. Uses `convert` function to minimize token consumption. Always enabled.

**Tier 2 -- Panel-gated detail (~500 tokens when active):** Controlled by `available: "enabled"/"disabled"` toggle tied to Zustand state (e.g., expanded story ID). Max 3 concurrent tier-2 contexts; oldest auto-disables when exceeded. Zero tokens when disabled.

**Tier 3 -- Action-gated deep data (0 tokens until invoked):** Large datasets (agent logs, learning records, attribution chains) exposed as `useCopilotAction` handlers. Copilot calls on demand via WS -> Factory Core -> SSE -> Zustand -> return. Pull, don't push.

**G4 — Copilot ↔ Factory Core: All through dashboard surface, no backend actions**

- **Control actions (FR108, FR109, FR110):** Copilot → `useCopilotAction` handler → Zustand store action → WS command → Factory Core. Same path as a button click. FR110 compliance: "the copilot does not bypass the dashboard's control surface."
- **Read actions (FR106, FR114):** All data the copilot reads must already be available in the SSE event stream (Zustand store). If deep investigation data isn't in the store, the copilot action sends a WS command to Factory Core, which responds via SSE event → store update → copilot reads the store. Round-trip ~1-2 seconds, acceptable for investigation mode.
- **No CopilotKit backend actions** (`CopilotRuntime({ actions: [] })` is empty). All intelligence runs on the frontend dashboard surface.
- **Exception — LLM Service Adapter:** `CopilotRuntime` configures `OpenAIAdapter` (or equivalent) for LLM routing. This is infrastructure plumbing, not a factory bypass. Economy-tier model (FR118) for conversational queries.

**Copilot UX Implementation Patterns (from Party Mode synthesis):**

- **Investigate mode navigation (FR107, FR115):** `useCopilotAction` handlers call Zustand actions: `expandStory(id)`, `focusAgent(id)`, `scrollToPanel(id)`. Action's `render` property shows indicator in chat. Pacing at 300ms per step (custom throttle layer between AG-UI events and Zustand, not a CopilotKit feature).

- **Act mode confirmation (FR109):** Destructive and state-modifying copilot actions use CopilotKit's `renderAndWait` pattern. The action renders a confirmation component; user confirms or cancels; handler resolves based on response. All confirmed actions route through Zustand store -> WS -> Factory Core (same path as UI clicks). Canonical location: `dashboard/src/copilot/components/NudgeConfirmation.tsx`

- **Action indicators (FR115):** All copilot tool calls render real-time status indicators via CopilotKit wildcard render (`name: "*"`). Shows loading state during execution, completion icon on finish. Canonical location: `dashboard/src/copilot/components/ActionIndicator.tsx`

- **Copilot token tracking (FR117):** Middleware wrapper on `OpenAIAdapter` intercepts LLM responses, extracts `usage.total_tokens`, writes to attribution chain as `copilot_usage` line item. MVP: approximate counts from adapter response metadata. Growth: per-request tracking with model-tier breakdowns.

- **CopilotBridge Contract:** Headless component (returns `null`) mounted inside `<CopilotKit>` provider. Registers all `useCopilotReadable` contexts (tier 1-2) and `useCopilotAction` handlers (navigation, control, queries). Separated from render tree -- zero performance impact on dashboard rendering. Canonical location: `dashboard/src/copilot/bridge.tsx`

---

### ADR-012: Testing Strategy & Standalone Testability

**Status:** Accepted
**Decision:** 5-tier test architecture with dual runners (bun test + vitest), per-package coverage thresholds, 3-stage CI pipeline.
**Party Mode Round:** 7 — Quinn (QA Engineer), Amelia (Developer), Winston (Architect). All 8 sub-decisions unanimous.

**T1 — Unit Tests: `bun test`, per-package, colocated with source**

- Tests colocated with source files (Overstory convention, proven with 89 tests):
  ```
  packages/factory-core/src/pipeline.ts
  packages/factory-core/src/pipeline.test.ts
  ```
- Each package has its own `bunfig.toml` with coverage configuration.
- Per-package coverage thresholds based on criticality:

| Package | Line Coverage | Function Coverage | Rationale |
|---|---|---|---|
| `shared-types` | 95% | 95% | Pure types + Zod schemas. Contract correctness is non-negotiable. |
| `factory-core` | 85% | 80% | Pipeline engine, economic governance. High criticality, complex async. |
| `gateway` | 75% | 70% | SSE/WS transport. I/O-heavy — integration tests cover the gaps. |

- **Coverage enforcement caveat:** Bun enforces thresholds per-file, not aggregate (oven-sh/bun#17028). Use `coveragePathIgnorePatterns` to exclude `.d.ts`, fixtures, generated files. Custom aggregate check script for CI.

**Backend test config:** Per-package `bunfig.toml` with test preload, coverage enabled (text + lcov reporters), test file exclusion from coverage, and path ignore patterns for `.d.ts`, fixtures, and mocks. Canonical location: `packages/*/bunfig.toml`

**T2 — Dashboard Component Tests: Vitest + happy-dom**

- Vitest for frontend component tests. Provides test isolation (global state reset between suites), Vite plugin compatibility, React Testing Library integration.
- Run on Bun runtime for speed: `bun vitest run`.
- 70% line coverage target. Focus coverage on Zustand store slices and CopilotBridge component (logic-heavy). UI components tested for behavior, not layout.

**Dashboard test config:** Vitest with React plugin, `happy-dom` environment, global setup file, v8 coverage provider with thresholds (70% lines, 65% functions, 70% statements). Run via `bun vitest run`. Canonical location: `dashboard/vitest.config.ts`

- Dashboard tests use mock Zustand store pre-filled with fixture data. No backend dependency. Gateway mock mode (ADR-009) provides SSE fixtures for store initialization.

**T3 — Integration Tests: `bun test`, per-surface, real implementations**

- Integration tests verify seams between packages. Each test mocks "the other side."
- Located at `tests/integration/` (top-level, cross-package by definition).
- Overstory's "real implementations" philosophy: real SQLite (`:memory:` or temp file), real git repos (temp dirs), real `Bun.spawn()`. Only mock tmux and network calls.

| Surface | What's Real | What's Mocked |
|---|---|---|
| Factory Core → Overstory | Pipeline engine | EventStore (stubbed with test DB) |
| Factory Core → Gateway | SSE poller, event translation | Factory Core (injected events) |
| Gateway → Dashboard | Mock mode SSE, Zustand store | React render (store-only) |
| Hook Runner → Gate Scripts | Hook runner, `Bun.spawn()` | Gate script (test fixture) |

**T4 — Phase Boundary Tests: CI only, canary tokens + manifest validation**

- Quinn's test suite from ADR-007: 33 files, ~198 tests.
- Located at `tests/phase-boundary/`.
- Expensive: spawns real agents (MockProvider LLM responses), creates real worktrees, runs real gate scripts.
- CI only — never in dev watch loop.

```
tests/phase-boundary/
  canary/           # Canary token injection + verification (~30 tests)
  manifest/         # Manifest completeness + schema validation (~35 tests)
  credential/       # Credential leak detection (~30 tests)
  behavioral/       # Behavioral leakage across phases (~15 tests)
  isolation/        # Full isolation round-trip (~40 tests)
  confidence/       # Result aggregation, escalation, audit trail (~18 tests)
  merkle/           # Tree construction, manifest/full hash, adaptive trigger (~20 tests)
  integration/      # Full transition, multi-phase, concurrent stories (~10 tests)
  fixtures/         # learnings/, manifests/, credentials/, canary/ — test data
```

Coverage targets: 100% branch on canary verification and confidence scoring. 95% line on manifest validation and credential handling. 92% weighted average across all layers.

**T5 — E2E Pipeline Tests: CI only, MockProvider, full pipeline**

- Full pipeline round-trip: submit story → dev → review → QA → PR creation.
- MockProvider implements Pi SDK's provider interface, returns deterministic responses from fixture files (Pi-mono pattern: `packages/ai/test/data/`).
- Located at `tests/e2e/`.
- ~4 scenario tests covering critical paths:

```
tests/e2e/
  happy-path.test.ts       # Story through full pipeline
  budget-breach.test.ts    # Budget ceiling → circuit breaker
  stall-recovery.test.ts   # Agent stall → recovery → completion
  multi-story.test.ts      # 3 concurrent stories, resource contention
```

**MockProvider Contract:** Implements Pi SDK `Provider` interface. Constructor loads fixture responses from JSON directory. Responses keyed by `{agentRole}-{phase}` for deterministic replay. Shared across Tier 3-5 tests. Canonical location: `tests/fixtures/mock-provider.ts`

**CI Pipeline Contract:** 3-stage pipeline in `.github/workflows/ci.yml`:
- **Stage 1 (fast):** Biome lint + `tsc --noEmit` + per-package unit tests. Gates all PRs.
- **Stage 2 (medium):** Dashboard component tests + integration tests (parallel matrix). Gates all PRs.
- **Stage 3 (slow):** Phase boundary tests + E2E tests. Gates `main` merge and manual dispatch only.

**Root package.json scripts:** `test` / `test:unit` (per-package bun test), `test:dashboard` (vitest), `test:integration` / `test:boundary` / `test:e2e` (monorepo-level bun test), `test:ci` (unit + dashboard + integration), `test:ci:full` (all tiers), `lint` (biome check), `typecheck` (tsc --noEmit). Canonical location: root `package.json`

---

### ADR-013: Superpowers Integration Strategy

**Status:** Accepted
**Decision:** Import `skills-core.js` as library with `.d.ts` type declarations. Startup enumeration, cached. No content validation.
**Party Mode Round:** 7 — Quinn (QA Engineer), Amelia (Developer), Winston (Architect). All sub-decisions unanimous.

**S1 — Type Declarations: `.d.ts` for all 5 functions + `SkillMetadata` interface**

```typescript
// packages/shared-types/src/superpowers.d.ts
declare module "superpowers/lib/skills-core.js" {
  interface SkillMetadata {
    path: string;
    skillFile: string;
    name: string;
    description: string;
    sourceType: "personal" | "superpowers";
  }

  interface SkillResolution {
    skillFile: string;
    sourceType: "personal" | "superpowers";
    skillPath: string;
  }

  export function extractFrontmatter(filePath: string): { name: string; description: string };
  export function findSkillsInDir(dir: string, sourceType: string, maxDepth?: number): SkillMetadata[];
  export function resolveSkillPath(skillName: string, superpowersDir: string, personalDir: string): SkillResolution | null;
  export function checkForUpdates(repoDir: string): boolean;
  export function stripFrontmatter(content: string): string;
}
```

- `SkillMetadata` is the contract between Superpowers and Factory Core's overlay composition (Stage 2).
- If Superpowers adds frontmatter fields, only the `.d.ts` changes on our side.
- No content validation of skill descriptions — Superpowers owns skill quality. Factory Core consumes frontmatter as-is. Boundary discipline.

**S2 — Skill Resolution: Personal > Superpowers, explicit paths**

- Personal skills: `~/.claude/skills/` (per user home directory)
- Project skills: `vendor/superpowers/skills/` (checked into monorepo)
- `resolveSkillPath()` called with explicit directory paths. No worktree-relative resolution — skills are read-only configuration, not working state.
- `superpowers:` prefix forces project skills over personal overrides (existing `resolveSkillPath()` behavior).

**S3 — Enumeration Timing: Once at startup, cached in memory**

- `findSkillsInDir()` called once when Factory Core initializes. Result cached as `Map<string, SkillMetadata>`.
- ~5ms for 14 skills with 3-level recursion. No filesystem watcher needed.
- Re-enumerate on factory restart. Skills don't change during a session.
- `checkForUpdates()` is user-triggered only (e.g., `qds superpowers check`). Factory Core never phones home automatically.

**S4 — TWO-STAGE Review Enforcement: L4 gate ordering**

- L4 (BMAD review) gate scripts ordered: `gates/l4-spec-compliance.ts` → `gates/l4-code-quality.ts`.
- Within-gate fail-fast per ADR-010 H3: if spec compliance returns FAIL, code quality is skipped.
- Rationale: a story that doesn't meet its spec isn't worth reviewing for code quality.
- Ordering documented in `gates/README.md`, not enforced by infrastructure — the hook pipeline executes gate scripts in filesystem order within a layer. Name scripts with numeric prefixes: `01-spec-compliance.ts`, `02-code-quality.ts`.

**S5 — Integration Point: Factory Core overlay Stage 2**

- Factory Core's overlay composition has 6 ordered stages (from Step 2 architecture).
- Stage 2 injects enforcement context: skill descriptions (triggering conditions), guard rules, enforcement frontmatter.
- Factory Core calls `findSkillsInDir()` at startup → caches `SkillMetadata[]` → Stage 2 reads from cache → injects `description` field as enforcement text into agent overlay.
- CSO rule preserved: skill descriptions contain triggering conditions only. Factory Core trusts this — no validation, no transformation.

### ADR-014: Developer Communication Layer (Telegram Bot)

**Status:** Accepted
**Decision:** New `packages/messenger/` package as a parallel EventStore consumer providing Telegram-based developer notifications and inbound command processing. Not a gateway extension — independent consumer of the same event stream.
**Party Mode Round:** 8b — Amelia (Developer), Quinn (QA Engineer), Winston (Architect). All sub-decisions unanimous.

**M1 — Package Structure: Parallel EventStore Consumer**

`packages/messenger/` is a new workspace member with explicit dependency on `shared-types` and `factory-core` (for config and EventStore access). It is NOT an extension of the gateway — it runs as a separate long-lived process alongside the gateway, consuming EventStore events independently.

Internal module layout:

```
packages/messenger/
├── package.json
├── tsconfig.json
├── bunfig.toml
└── src/
    ├── index.ts                    # barrel — public API surface
    ├── outbound/
    │   ├── formatter.ts            # event → Telegram MarkdownV2 message
    │   ├── throttle.ts             # quiet hours, batch window, DND
    │   └── summary.ts              # morning summary composer
    ├── inbound/
    │   ├── auth.ts                 # Telegram user_id → developer_id mapping
    │   ├── commands.ts             # 12-command MVP taxonomy dispatcher
    │   ├── callbacks.ts            # inline keyboard callback handler
    │   └── nl-router.ts            # economy-tier LLM intent classification
    ├── dialogue/
    │   ├── store.ts                # SQLite-backed pending_dialogues
    │   ├── manager.ts              # timeout tracking, default actions
    │   └── dedup.ts                # question deduplication
    └── sync/
        ├── event-poller.ts         # EventStore polling (parallel to gateway)
        ├── action-bridge.ts        # Telegram action → factory command
        └── idempotency.ts          # escalation_id dedup, atomic resolution
```

Rationale: Keeping messenger as a separate package (not a gateway route) ensures the dashboard and Telegram channels are architecturally independent. A gateway crash does not take down Telegram notifications. The messenger package can be started/stopped independently via `bun run dev:messenger`.

**M2 — Platform Selection: Telegram Bot API via Raw `fetch()`**

```typescript
// packages/shared-types/src/telegram.ts
export interface TelegramApi {
  sendMessage(chatId: string, text: string, options?: SendMessageOptions): Promise<TelegramResult>;
  editMessageText(chatId: string, messageId: number, text: string, options?: EditMessageOptions): Promise<TelegramResult>;
  answerCallbackQuery(callbackQueryId: string, options?: AnswerCallbackOptions): Promise<TelegramResult>;
  setWebhook(url: string, options?: WebhookOptions): Promise<TelegramResult>;
  deleteWebhook(): Promise<TelegramResult>;
}

export interface SendMessageOptions {
  parseMode?: 'MarkdownV2' | 'HTML';
  replyMarkup?: InlineKeyboardMarkup;
  disableNotification?: boolean;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;  // max 64 bytes
}

export interface TelegramResult {
  ok: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
}
```

- Raw `fetch()` to `https://api.telegram.org/bot{token}/` — no third-party Telegram library. The Bot API is a simple REST API; a wrapper adds dependency weight without value.
- **Production:** Webhook mode. Messenger package exposes a single `/webhook/{secret}` endpoint. Telegram pushes updates to this endpoint. Webhook URL configured at factory startup via `setWebhook()`.
- **Local dev:** Long-polling fallback via `getUpdates()`. No public URL needed.
- Rate limits respected: Telegram allows 30 messages/second to the same chat, 20 messages/minute to the same group. Messenger throttle module enforces these limits with a token bucket.
- Rich features used: MarkdownV2 formatting, inline keyboards (action buttons below messages), message editing (reflect dashboard-side actions), file upload (Growth phase — story/PRD submission).

**M3 — Dual-Channel Notification Router**

```typescript
// packages/shared-types/src/notifications.ts
export type NotificationSeverity = 'critical' | 'warning' | 'info';

export interface NotificationRouter {
  dispatch(event: EscalationEvent): Promise<void>;
}

export interface EscalationEvent {
  escalation_id: string;          // UUID, unique per escalation
  event_type: string;             // Overstory event type
  severity: NotificationSeverity;
  story_id?: string;
  agent_id?: string;
  summary: string;                // 1-line human-readable summary
  detail?: string;                // extended detail for expanded view
  actions?: EscalationAction[];   // available response actions
  timestamp: string;              // ISO 8601
}

export interface EscalationAction {
  label: string;                  // button text
  command: string;                // factory command to execute
  confirmRequired: boolean;       // requires confirm/cancel step
}
```

Both channels (dashboard + Telegram) read from EventStore independently. The `NotificationRouter` is the abstraction that dispatches to both surfaces:

1. Dashboard receives escalation events via existing SSE channel → `notificationsSlice` in Zustand store.
2. Messenger receives the same events via its own EventStore poller → formats and sends via Telegram Bot API.

**Escalation-to-severity mapping (all 17 escalation events):**

| Escalation Event | Severity | Inline Keyboard Actions |
|---|---|---|
| Agent crash (recovery exhausted) — FR22 | Critical | \[View Story\] \[Stop Story\] |
| All agents in story crash — FR74 | Critical | \[View Story\] \[Retry\] \[Stop Story\] |
| API provider fully down — FR75 | Critical | \[View Status\] |
| Daily global budget exhausted — FR39 | Critical | \[View Costs\] \[Adjust Budget\] |
| Per-story budget exceeded — FR38 | Warning | \[View Story\] \[Adjust Budget\] \[Stop Story\] |
| Stall detected (logic loop) — FR47 | Warning | \[View Agent\] \[Nudge\] \[Stop\] |
| Stall detected (external wait) — FR47 | Warning | \[View Agent\] \[Nudge\] |
| Stall detected (resource constraint) — FR47 | Warning | \[View Agent\] \[View Status\] |
| BMAD review found critical finding | Warning | \[View Findings\] \[Dismiss\] |
| Story spec validation failed — FR91 | Warning | \[View Details\] |
| File contention detected — FR92 | Warning | \[View Stories\] |
| Hook timeout/crash — FR94 | Info | \[View Details\] |
| Story completed successfully | Info | \[View PR\] |
| Phase transition completed | Info | (no keyboard — info only) |
| Meta-optimization applied — FR83 | Info | \[View Change\] \[Revert\] |
| Disk/memory threshold warning — FR73 | Warning | \[View Status\] |
| Slow disk I/O detected — NFR29 | Info | \[View Status\] |

Each dispatch writes a `notification_dispatched` audit event back to EventStore with: `escalation_id`, `channel` (`'dashboard' | 'telegram'`), `dispatched_at`, `delivery_status`.

**M4 — Dual-Channel Idempotency**

Every escalation event carries a unique `escalation_id` (UUID). When a developer acts on an escalation from either channel:

```typescript
// packages/shared-types/src/commands.ts (addition)
export interface DeveloperAction {
  commandId: string;              // UUID per action attempt
  escalation_id: string;          // links to originating escalation
  command: string;                // e.g., 'stop_story', 'nudge_agent'
  source: 'dashboard' | 'telegram';
  developer_id: string;
  payload?: Record<string, unknown>;
  timestamp: string;
}
```

- `developer_action` event written to EventStore with `commandId` + `escalation_id` + `source`.
- Atomic resolution: `UPDATE escalations SET resolved_at = ?, resolved_by = ?, resolved_via = ? WHERE escalation_id = ? AND resolved_at IS NULL`. If the UPDATE affects 0 rows, the escalation was already resolved — the second channel's action is a no-op.
- **Dashboard → Telegram sync:** When an escalation is resolved via dashboard, the messenger's EventStore poller picks up the `developer_action` event and edits the original Telegram message to append "✓ Resolved via dashboard" with inline keyboard buttons removed.
- **Telegram → Dashboard sync:** When an escalation is resolved via Telegram, the dashboard's SSE poller picks up the `developer_action` event and the `notificationsSlice` marks the notification as resolved with `resolvedVia: 'telegram'`.
- **Race condition:** If both channels fire within the same polling interval, the atomic SQL UPDATE ensures exactly one succeeds. The losing channel receives a "already resolved" response.

**M5 — Inbound Commands**

Authentication: Telegram `user_id` → `developer_id` mapping stored in `.qds/messenger.db`. One-time registration:

1. Developer runs `qds telegram register` from CLI → factory generates a 6-character alphanumeric code, displays it, stores `{code, developer_id, expires_at}` in messenger.db.
2. Developer sends `/register {code}` to the Telegram bot.
3. Bot validates code, maps `user_id → developer_id`, deletes the registration code.
4. Subsequent messages authenticated by `user_id` lookup.

**12-command MVP taxonomy:**

| Command | Description | Maps To |
|---|---|---|
| `/status` | Factory overview (active stories, costs, health) | Read-only query |
| `/stories` | List active stories with phase and status | Read-only query |
| `/story {id}` | Detail view of specific story | Read-only query |
| `/stop {story_id}` | Stop a story (confirmation required) | `stop_story` command |
| `/nudge {agent_id} {message}` | Send nudge to agent | `nudge_agent` command |
| `/budget` | Show daily spend, per-story budgets | Read-only query |
| `/approve {escalation_id}` | Approve a pending decision | `developer_action` event |
| `/reject {escalation_id} {reason}` | Reject with rationale | `developer_action` event |
| `/pending` | List all pending decisions with timeouts | Read-only query |
| `/costs` | Detailed cost breakdown by story and model tier | Read-only query |
| `/dnd {duration}` | Enable Do Not Disturb (e.g., `/dnd 2h`) | Notification preference |
| `/help` | List available commands | Local response |

**Natural language fallback:** Messages not matching a command pattern are classified by an economy-tier LLM call (~$0.0001/classification) into one of the command intents above, or `unknown`. Unknown intents receive: "I didn't understand that. Type /help for available commands." Classification prompt is a system message with the 12-command taxonomy — no fine-tuning, no RAG.

**M6 — Async Dialogue**

SQLite-backed `pending_dialogues` table in `.qds/messenger.db`:

```sql
CREATE TABLE pending_dialogues (
  dialogue_id TEXT PRIMARY KEY,
  escalation_id TEXT NOT NULL,
  developer_id TEXT NOT NULL,
  question TEXT NOT NULL,
  question_type TEXT NOT NULL,       -- 'approval' | 'choice' | 'input'
  options TEXT,                       -- JSON array for 'choice' type
  default_action TEXT NOT NULL,       -- action taken on timeout
  timeout_at TEXT NOT NULL,           -- ISO 8601
  responded_at TEXT,
  response TEXT,
  response_source TEXT,               -- 'telegram' | 'dashboard' | 'timeout'
  telegram_message_id INTEGER,        -- for editing on resolution
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_pending_developer ON pending_dialogues(developer_id, responded_at);
```

- Configurable per-escalation-type timeouts (default 4 hours).
- Conservative default actions on timeout: budget exceeded → pause story (not stop), stall → continue waiting (not stop), BMAD critical finding → block phase transition (not dismiss).
- Post-timeout override: developer can still act after timeout. If the default action was conservative (pause), the override replaces it. If the default was destructive (rare), the override is logged but the action has already been taken.
- `/pending` command returns all dialogues where `responded_at IS NULL`, sorted by `timeout_at ASC`.
- Question deduplication: if the same `escalation_id` generates a new dialogue while one is already pending, the existing dialogue is updated (timeout extended) rather than creating a duplicate.

**M7 — Outbound Throttling**

- **Quiet hours:** Configurable in `factory.yaml` (`telegram.quiet_hours: { start: "22:00", end: "08:00", timezone: "America/New_York" }`). Non-critical notifications queued during quiet hours, delivered as a batch when quiet hours end.
- **DND mode:** `/dnd {duration}` suppresses all notifications except `critical` severity. DND state stored in `messenger.db`. Critical bypass is configurable (`telegram.dnd_bypass_critical: true`, default true).
- **Batch window:** Non-critical (`info`) notifications within a 30-second window are batched into a single message. Reduces notification noise during active factory runs.
- **Morning summary:** Configurable time (`telegram.morning_summary_time: "08:00"`). Summary includes: stories completed overnight, stories currently active, costs since last summary, any pending decisions with time remaining, current factory health status.

**M8 — Security**

- **Credential sanitization:** All outbound Telegram messages pass through the existing `sanitizer.ts` (ADR-008) before formatting. The sanitizer strips API keys, file paths, system-level details, and any pattern matching credential regexes. This extends the ADR-008 dual-layer detection to a new output path.
- **Webhook secret:** Telegram webhook URL includes a secret token path segment (`/webhook/{secret}`). Secret generated at startup, stored in `.qds/messenger.db`. Requests without valid secret are rejected with 403.
- **Registration-based auth:** No open registration. Only developers who run the CLI registration flow can interact with the bot. Unregistered Telegram users receive: "This bot requires registration. Please run `qds telegram register` from your factory CLI."
- **Destructive command confirmation:** `/stop` and `/reject` require inline keyboard confirmation (Confirm / Cancel buttons). The command is not executed until the developer taps Confirm.

**M9 — Attribution**

- `system:messenger` attribution line for all NL processing costs (intent classification). This is a new attribution source alongside `developer:copilot`.
- `nl_budget_daily` ceiling (default $1.00) — NL classification calls are blocked when the daily ceiling is reached. Commands still work (no LLM needed for structured commands). Ceiling configurable in `factory.yaml`.
- Telegram-initiated actions carry full attribution chain: `source: "telegram"`, `developer_id` (from registration mapping), `escalation_id` (from the originating event), `command` (the action taken). These flow into the standard `developer_action` event in EventStore.

**M10 — Configuration**

```typescript
// packages/shared-types/src/config.ts (addition to FactoryConfigSchema)
export const TelegramConfigSchema = z.object({
  enabled: z.boolean().default(false),
  bot_token: z.string().min(1),
  webhook_url: z.string().url().optional(),        // omit for long-polling mode
  developer_chat_ids: z.record(z.string(), z.string()).optional(),  // developer_id → chat_id overrides
  quiet_hours: z.object({
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
    timezone: z.string().default('UTC'),
  }).optional(),
  morning_summary_time: z.string().regex(/^\d{2}:\d{2}$/).default('08:00'),
  dnd_bypass_critical: z.boolean().default(true),
  batch_window_seconds: z.number().int().min(0).max(120).default(30),
  nl_budget_daily: z.number().min(0).default(1.00),
  severity_routing: z.object({
    critical: z.enum(['always', 'quiet_hours_only', 'never']).default('always'),
    warning: z.enum(['always', 'quiet_hours_only', 'never']).default('always'),
    info: z.enum(['always', 'quiet_hours_only', 'never']).default('quiet_hours_only'),
  }).optional(),
});
```

`factory.yaml` example section:

```yaml
telegram:
  enabled: true
  bot_token: "YOUR_BOT_TOKEN"
  webhook_url: "https://your-domain.com/webhook/secret123"
  quiet_hours:
    start: "22:00"
    end: "08:00"
    timezone: "America/New_York"
  morning_summary_time: "08:00"
  dnd_bypass_critical: true
  batch_window_seconds: 30
  nl_budget_daily: 1.00
  severity_routing:
    critical: always
    warning: always
    info: quiet_hours_only
```

**M11 — Copilot Relationship**

Telegram and the dashboard copilot serve different interaction modalities:

- **Telegram:** Breadth — quick status checks, notification acknowledgment, simple commands. Mobile-friendly. Interrupt-driven. The developer is away from the dashboard.
- **Copilot:** Depth — multi-step investigations, correlated data analysis, complex debugging. Desktop. Attention-rich. The developer is at the dashboard.

When a Telegram query requires complex investigation (e.g., "why is Story 3 stalling?"), the messenger returns a summary (stall type, duration, agent involved) plus a dashboard deep-link: "Full investigation available in dashboard → [link]". The messenger does NOT attempt multi-step copilot-style investigations — it surfaces the answer if simple, or routes to the right tool if complex.

**M12 — Testing Strategy**

Unit test files per module (85% coverage target):

```
packages/messenger/src/outbound/formatter.test.ts
packages/messenger/src/outbound/throttle.test.ts
packages/messenger/src/outbound/summary.test.ts
packages/messenger/src/inbound/auth.test.ts
packages/messenger/src/inbound/commands.test.ts
packages/messenger/src/inbound/callbacks.test.ts
packages/messenger/src/inbound/nl-router.test.ts
packages/messenger/src/dialogue/store.test.ts
packages/messenger/src/dialogue/manager.test.ts
packages/messenger/src/dialogue/dedup.test.ts
packages/messenger/src/sync/event-poller.test.ts
packages/messenger/src/sync/action-bridge.test.ts
packages/messenger/src/sync/idempotency.test.ts
```

**`TelegramApiMock`:** All test tiers use a mock implementation of the `TelegramApi` interface that records sent messages, edited messages, and callback responses without hitting the real Telegram API. Located in `tests/fixtures/telegram-api-mock.ts`.

Integration tests for dual-channel sync:

```
tests/integration/messenger-to-dashboard.test.ts   # Telegram action → dashboard state update
tests/integration/dashboard-to-messenger.test.ts   # Dashboard action → Telegram message edit
tests/integration/dual-channel-race.test.ts         # Concurrent resolution from both channels
```

---

**Sequence Diagram — Escalation Notification Flow:**

```
EventStore          Messenger              Telegram API         Developer
    │                   │                       │                    │
    │ escalation_event  │                       │                    │
    ├──────────────────>│                       │                    │
    │                   │ format + sanitize     │                    │
    │                   │──────────────────────>│                    │
    │                   │   sendMessage(MD+KB)  │                    │
    │                   │                       │───────────────────>│
    │                   │                       │   push notification│
    │                   │                       │                    │
    │                   │                       │<───────────────────│
    │                   │                       │  callback_query    │
    │                   │<──────────────────────│  (button tap)      │
    │                   │                       │                    │
    │ developer_action  │                       │                    │
    │<──────────────────│ write event           │                    │
    │                   │──────────────────────>│                    │
    │                   │ editMessage (✓ done)  │                    │
```

**Sequence Diagram — Dashboard ↔ Telegram Sync:**

```
Dashboard           EventStore          Messenger           Telegram
    │                   │                   │                   │
    │ resolve via UI    │                   │                   │
    │──────────────────>│                   │                   │
    │  developer_action │                   │                   │
    │                   │ poll picks up     │                   │
    │                   ├──────────────────>│                   │
    │                   │                   │ editMessage       │
    │                   │                   │─────────────────>│
    │                   │                   │ "✓ Resolved       │
    │                   │                   │  via dashboard"   │
```

### ADR-015: Agent Performance & Learning System (Revised — Session 8)

**Status:** Proposed (Revised)
**Replaces:** ADR-015 "Agent Performance & Reward System (6-Layer Architecture)" from Session 6
**Resolves:** SCOPE-001, CONS-002, CONS-003, CONS-007, CONS-011, COMP-001, COMP-009, ECON-001, ECON-004, PERV-001, PERV-002, PERV-003, PERV-004, PERV-005, PERV-009, PERV-011, FAIL-001, FAIL-018

#### 15.1 Renaming and Scope

**Renamed from** "Performance & Reward System" **to** "Performance & Learning System."

The credit economy is killed entirely (ECON-001). Per-agent budgets are killed (ECON-002). There are no "rewards" in this system. There is data collection, learning extraction, and (in Growth phase) behavioral routing based on demonstrated capability.

#### 15.2 MVP vs Growth Scope (SCOPE-001)

**MVP implements Layers 1-3 (data collection only).** No behavioral effects at MVP. The system observes, records, and learns. It does not route, promote, demote, or gate based on performance data.

| Layer | Name | MVP | Growth | What It Does |
|-------|------|-----|--------|-------------|
| 1 | Action Scoring | Yes | Yes | Compute process quality scores after each post-task hook |
| 2 | Confidence Calibration | Yes | Yes | Track confidence declarations vs outcomes in transfer manifests |
| 3 | Session Composites | Yes | Yes | Aggregate action scores + hook results into per-story session scores |
| 4 | ELO Domain Ratings | No | Yes | Compute ELO-style ratings per agent per domain from session scores |
| 5 | Capability Tiers | No | Yes | Assign agents to tiers based on ELO thresholds with hysteresis |
| 6 | Performance-Based Routing | No | Yes | Route tasks to agents using weighted composite scoring |

**Rationale:** ELO ratings need 20+ observations per domain to achieve medium confidence (ECON-003). At 10-15 stories/month across 6 domains, that is 3-6 months of operation before tier assignments are meaningful. Building behavioral effects on top of unreliable data creates more problems than it solves.

#### 15.3 Storage — Single Source of Truth (CONS-002, ECON-004, CONS-011, FAIL-001)

**All performance data lives in `pipeline.db` (SQLite via bun:sqlite).** No YAML files for mutable performance state. No Drizzle ORM.

| What Changed | Old (Session 6) | New (Session 8) | Finding |
|-------------|-----------------|-----------------|---------|
| Action scores | `.qds/performance/actions/` YAML files | `pipeline.db` `action_scores` table | CONS-002, ECON-004 |
| Session composites | `.qds/performance/sessions/` YAML files | `pipeline.db` `session_composites` table | CONS-002 |
| ELO ratings (Growth) | `ratings.yaml` single file | `pipeline.db` `elo_ratings` table | FAIL-001 |
| Tier assignments (Growth) | `tiers.yaml` single file | `pipeline.db` `tier_assignments` table | CONS-002 |
| Database access | Drizzle ORM (from PaperclipAI) | `bun:sqlite` direct access | CONS-011 |

**YAML files are read-only exports** computed from SQLite for human inspection. They are generated on-demand (dashboard export button, CLI command), never written to directly, and never read as a source of truth.

**Why bun:sqlite, not Drizzle ORM (CONS-011):** Overstory already uses `bun:sqlite` direct access for sessions.db, mail.db, events.db, and metrics.db. Introducing Drizzle ORM for Factory Core tables creates two SQLite access patterns in the same codebase with different transaction semantics, different migration strategies, and different error handling. One pattern. `bun:sqlite` direct access with Zod schema validation at read boundaries.

**Concurrency safety (FAIL-001):** SQLite WAL mode with `bun:sqlite`'s synchronous API eliminates the concurrent-write lost-update problem that would have affected `ratings.yaml`. SQLite handles locking; our code does not need to.

#### 15.4 pipeline.db Schema — Performance Tables

```sql
-- Layer 1: Action-level process scores
CREATE TABLE action_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL DEFAULT 1,
  hook_level TEXT NOT NULL,  -- 'L2_per_edit', 'L3_per_task', 'L3_phase_boundary'
  score_promise REAL NOT NULL CHECK (score_promise BETWEEN 0.0 AND 1.0),
  score_progress REAL NOT NULL CHECK (score_progress BETWEEN 0.0 AND 1.0),
  score_process REAL NOT NULL CHECK (score_process BETWEEN 0.0 AND 1.0),
  files_modified INTEGER NOT NULL DEFAULT 0,
  tokens_consumed INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_action_scores_story ON action_scores(story_id, phase);
CREATE INDEX idx_action_scores_agent ON action_scores(agent_id, created_at);

-- Layer 2: Confidence calibration tracking
CREATE TABLE confidence_declarations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  declared_confidence REAL NOT NULL CHECK (declared_confidence BETWEEN 0.0 AND 1.0),
  actual_outcome REAL,  -- NULL until story completes; 0.0-1.0 based on review findings
  brier_score REAL,     -- computed on story completion
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_confidence_story ON confidence_declarations(story_id);

-- Layer 3: Session composite scores (one per agent per story)
CREATE TABLE session_composites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_role TEXT NOT NULL,
  action_score_mean REAL NOT NULL,
  action_score_count INTEGER NOT NULL,
  hook_pass_rate REAL NOT NULL,
  confidence_brier REAL,  -- NULL if no confidence declarations
  fix_loop_contributions INTEGER NOT NULL DEFAULT 0,
  composite_score REAL NOT NULL CHECK (composite_score BETWEEN 0.0 AND 1.0),
  story_difficulty REAL NOT NULL CHECK (story_difficulty BETWEEN 0.0 AND 1.0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(story_id, agent_id)
);
CREATE INDEX idx_composites_agent ON session_composites(agent_id, created_at);

-- Layer 4 (Growth): ELO domain ratings
CREATE TABLE elo_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  rating REAL NOT NULL DEFAULT 1200.0,
  rating_deviation REAL NOT NULL DEFAULT 350.0,  -- uncertainty measure
  games_played INTEGER NOT NULL DEFAULT 0,
  epoch INTEGER NOT NULL DEFAULT 1,  -- versioned rating epoch (COMP-009)
  last_updated TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(agent_id, domain, epoch)
);

-- Layer 5 (Growth): Tier assignments with history
CREATE TABLE tier_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  tier INTEGER NOT NULL DEFAULT 1 CHECK (tier BETWEEN 1 AND 5),
  promoted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  stories_at_tier INTEGER NOT NULL DEFAULT 0,  -- dwell counter for hysteresis (PERV-009)
  previous_tier INTEGER,
  reason TEXT NOT NULL  -- 'initial', 'promotion', 'demotion', 'manual_override', 'audit_result'
);
CREATE INDEX idx_tier_agent ON tier_assignments(agent_id, promoted_at DESC);

-- Rating epoch tracking (COMP-009)
CREATE TABLE rating_epochs (
  epoch INTEGER PRIMARY KEY,
  algorithm_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  migration_notes TEXT
);
```

#### 15.5 Three-Layer Learning Architecture

This is the core innovation. The performance system exists to serve learning, not the other way around.

**Layer 1: Codebase Knowledge** enriches Overstory's mulch with structured fix-loop and maintenance learnings.

- Every fix-loop iteration that resolves a gap produces a learning record
- Every maintenance agent fix produces a learning record
- Records are categorized: `preventable` (overlay should have caught it), `unforeseeable` (genuinely novel), `systemic` (architecture/tooling gap)
- `preventable` records include: affected files, fix applied, what the original overlay should have included
- These records feed into overlay Stage 4 (learning injection) for future stories touching similar files/domains

**Layer 2: Pattern Knowledge** mines cross-story correlations stored in `pipeline.db`.

- "87% of stories modifying `src/payments/` also need `src/webhooks/` updates" (10X-005 Codebase Intent Model for Growth)
- "Stories with >3 file dependencies always need integration test verification in must_haves"
- Patterns are mined from `session_composites` + `learning_records` + `action_scores` data
- Pattern confidence tracked (observations count, last_confirmed, last_contradicted)

**Layer 3: Process Knowledge** tunes factory operational parameters.

- Which `max_turns` values produce optimal completion rates per phase type
- Which model tier assignments produce best cost/quality ratios per agent role
- Which hook density levels catch the most issues per token spent
- Data sourced from pipeline execution metrics already stored in `pipeline.db`

#### 15.6 pipeline.db Schema — Learning Tables

```sql
-- Learning records from fix-loops and maintenance fixes
CREATE TABLE learning_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id TEXT,  -- NULL for maintenance-originated learnings
  source TEXT NOT NULL,  -- 'fix_loop', 'maintenance', 'qa_finding', 'bmad_finding'
  category TEXT NOT NULL CHECK (category IN ('preventable', 'unforeseeable', 'systemic')),
  domain TEXT NOT NULL,  -- file path prefix or semantic domain
  files_affected TEXT NOT NULL,  -- JSON array of file paths
  description TEXT NOT NULL,
  fix_applied TEXT NOT NULL,
  overlay_recommendation TEXT,  -- what future overlays should include
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0.0 AND 1.0),
  applied_count INTEGER NOT NULL DEFAULT 0,  -- how many times this learning was injected
  last_applied TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_learning_domain ON learning_records(domain);
CREATE INDEX idx_learning_category ON learning_records(category);

-- Cross-story pattern knowledge (Growth)
CREATE TABLE pattern_knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_type TEXT NOT NULL,  -- 'file_correlation', 'test_requirement', 'integration_point'
  description TEXT NOT NULL,
  evidence_stories TEXT NOT NULL,  -- JSON array of story_ids that support this pattern
  observation_count INTEGER NOT NULL DEFAULT 1,
  confidence REAL NOT NULL DEFAULT 0.3 CHECK (confidence BETWEEN 0.0 AND 1.0),
  last_confirmed TEXT,
  last_contradicted TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Overlay effectiveness tracking
CREATE TABLE overlay_effectiveness (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id TEXT NOT NULL,
  learning_ids_injected TEXT NOT NULL,  -- JSON array of learning_record IDs injected
  pattern_ids_injected TEXT NOT NULL,   -- JSON array of pattern_knowledge IDs injected
  fix_loop_count INTEGER NOT NULL DEFAULT 0,
  fix_loop_categories TEXT,  -- JSON array of categories hit
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

#### 15.7 Maintenance Agent Feedback Loop

Every maintenance fix flows through this cycle:

1. **Maintenance agent discovers issue** (cron-triggered scan: OWASP, dependency audit, performance regression, dead code, quality drift)
2. **Fix dispatched through standard quality pipeline** (BMAD review + QA, same as developer-initiated stories)
3. **On fix completion, Factory Core creates a learning record:**
   - `source: 'maintenance'`
   - `category`: determined by analysis (was this preventable by a better overlay? was it genuinely unforeseeable? is it a systemic tooling gap?)
   - `overlay_recommendation`: what the original story's overlay should have included to prevent this issue
4. **Learning record stored in `pipeline.db` `learning_records` table**
5. **Next story touching the same domain** gets this learning injected via overlay Stage 4
6. **`overlay_effectiveness` table tracks** whether injected learnings actually reduced fix-loop rates

**Success metric:** The rate of `preventable` maintenance fixes should decrease over time. If it does not, the learning extraction or injection is failing.

#### 15.8 Tier Demotion Criteria (COMP-001) — Growth Phase Only

Agents can be demoted, not just promoted. Demotion prevents the "promote and forget" failure mode where a high-tier agent with reduced oversight degrades without detection.

**Demotion trigger:** ELO rating drops below `tier_threshold - 50` for 3 consecutive story completions.

**Example:** Tier 3 requires ELO >= 1350. If an agent's ELO drops below 1300 (1350 - 50) and stays below 1300 for 3 consecutive stories in that domain, the agent is demoted to Tier 2.

**Hysteresis (PERV-009):** Tier transitions use a 50-point buffer and 3-story dwell requirement to prevent thrashing:

- **Promotion threshold:** `tier_threshold` (e.g., 1350 for Tier 3)
- **Demotion threshold:** `tier_threshold - 50` (e.g., 1300 for Tier 3)
- **Dwell requirement:** Agent must have completed 3 stories at current tier before promotion eligibility
- **Effect:** An agent oscillating between 1300 and 1350 stays at its current tier. Only sustained performance above 1350 (3+ stories) triggers promotion. Only sustained performance below 1300 (3+ consecutive stories) triggers demotion.

#### 15.9 Confidence Resolution Requirement (PERV-001)

A perfect Brier score from an agent that always declares 30% confidence and is right 30% of the time is useless. Confidence declarations must demonstrate discriminative ability.

**Resolution requirement (Growth):** Alongside Brier score calibration, agents must demonstrate confidence spread across the [0.2, 0.9] range with positive rank correlation to outcomes.

- Minimum 3 distinct confidence buckets used across 10+ declarations
- Spearman rank correlation between declared confidence and actual outcome must be > 0.3
- Agents that only use 1-2 confidence levels get a calibration score of 0.0 regardless of Brier score

#### 15.10 Token Efficiency Scoring (PERV-004)

Raw token efficiency (`tokens / files_modified`) rewards terse, unmaintainable code. Replaced with a bounded step function.

**Scoring rule:**
- Tokens consumed <= 2x domain median: score = 1.0 (no reward for being cheap)
- Tokens consumed > 2x and <= 3x median: score = 0.7 (mild concern)
- Tokens consumed > 3x median: score = 0.3 (penalty for excessive consumption)
- Tokens consumed > 5x median: score = 0.0 (hard penalty)

**Domain median** computed from `action_scores` table over the last 30 stories in the same domain. Until 10+ observations exist, median defaults to a configured per-role baseline.

#### 15.11 Random Audit Mechanism (PERV-003) — Growth Phase Only

High-tier agents get fewer hooks, creating a monitoring blind spot. Random audits compensate.

- **Frequency:** 1 in 3 stories (configurable, `factory.yaml` `performance.audit_frequency`)
- **Eligibility:** All agents at Tier 3 or above
- **Effect:** Audited story runs with full Tier 1 hook density (every edit, every task, every phase boundary)
- **Scoring:** Audit story scores are weighted 1.5x in ELO calculation (elevated signal value)
- **Selection:** Random, not performance-based (prevents gaming by behaving well when likely audited)

#### 15.12 Anti-Gaming Protections

| Protection | Finding | Rule |
|-----------|---------|------|
| No self-tier injection | PERV-011 | Agent's own tier level is NOT injected into its overlay. Prevents self-reinforcing confidence/caution loops. |
| Immutable scoring weights | PERV-002 | Meta-optimization (FR79-FR83) MUST NOT modify parameters that affect score computation. Scoring weights require developer approval to change. Enforced by `factory.yaml` config freeze on `performance.scoring_weights`. |
| Exploration factor in routing | PERV-005 | 15% of task routing decisions (Growth) use random agent selection instead of ELO-based routing. Prevents domain specialization collapse where agents only get work they are already good at. |
| Anchored difficulty estimation | N/A | Story difficulty estimated from objective metrics (files_modified, test_count, dependency_depth, lines_changed), NOT from LLM judgment. LLM difficulty estimates create a feedback loop with the scoring system. |

#### 15.13 Fallback Behavior (FAIL-018)

When performance data is unavailable (system startup, pipeline.db corruption, performance subsystem crash):

- **MVP:** No behavioral effect -- performance is observation-only
- **Growth:** Default to Tier 2 enforcement (hooks every 3 tasks). Log the fallback. Do not fail the pipeline because the performance system is down. Performance is a "soft critical path" dependency -- it improves the pipeline but must not block it.

#### 15.14 ELO Migration Strategy (COMP-009) — Growth Phase Only

When the scoring algorithm changes (inevitable), existing ratings must be handled gracefully.

- Algorithm changes create a new `rating_epochs` entry with incremented epoch number
- Old ratings carry forward as initial estimates with inflated `rating_deviation` (uncertainty reset to 200, not full 350)
- New epoch ELO calculations start from carried-forward ratings, not from scratch
- Old epoch data preserved in `elo_ratings` table (filtered by epoch) for historical analysis
- Migration is automatic on Factory Core startup when it detects algorithm version mismatch

#### 15.15 Integration Points

| Integration | Direction | What Flows |
|------------|-----------|-----------|
| Post-task hooks (ADR-010) -> Performance | In | Hook results feed action score computation |
| Phase Boundary Protocol (ADR-006) -> Performance | In | Confidence declarations in transfer manifests |
| Story completion -> Performance | In | Triggers session composite computation, ELO update (Growth) |
| Performance -> Overlay composition Stage 4 | Out | Relevant learnings injected into agent context (~500 tokens) |
| Performance -> Hook Pipeline (Growth) | Out | Agent tier determines enforcement density |
| Performance -> Task routing (Growth) | Out | ELO-weighted routing with 15% exploration |
| Pi SDK Usage -> Performance | In | Per-call token/cost data for efficiency scoring (already exists in Pi SDK) |
| Overstory mulch -> Learning Layer 1 | Both | Mulch provides domain expertise foundation; learnings enrich mulch |
| Maintenance fixes -> Learning records | In | Every maintenance fix produces a categorized learning record |

### ADR-016: Economic Governance (Revised — Session 8)

**Status:** Proposed (Revised)
**Replaces:** ADR-016 "Economic Governance Layer (Extends ADR-005)" from Session 6
**Resolves:** ECON-001, ECON-002, CONS-001

#### 16.1 Core Change: Kill Credit Economy and Per-Agent Budgets

**Killed: Credit marketplace (ECON-001).** PaperclipAI's credit economy manages persistent autonomous agents competing for work as independent economic actors. QDS has one LLM provider running transient agent instances under single-principal control. A credit economy in this context reduces to a sorting function with unnecessary complexity. Replaced with weighted composite scoring for routing decisions in Growth phase.

**Killed: Per-agent monthly budgets (ECON-002).** Per-agent budgets (e.g., "Builder: $40/month") create deadlocks: a story needs $5 for its builder phase, but the builder role only has $2 remaining even though the global budget has $50 available. The story stalls mid-execution with no productive resolution. Replaced with two enforcement layers:

1. **Per-story budget** (FR38): Factory Core checks cumulative cost before spawning each phase's agents. If projected remaining cost exceeds story budget ceiling, the story is paused with developer notification.
2. **Global daily/monthly ceiling** (FR39): Factory Core enforces across all active stories. If the global ceiling would be exceeded, new story starts are blocked (active stories continue to completion).

**Per-role cost tracking** remains for attribution reporting visibility (dashboard shows cost-per-role breakdown) but is NOT an enforcement boundary.

#### 16.2 Killed: credit_ledger (CONS-001)

The `credit_ledger` table from Session 6 is eliminated entirely. There are no credits. Cost attribution data lives in `attribution.db` as it did in ADR-005. The three-way cost/credit/budget tracking split (CONS-001) is resolved by having exactly two cost-related stores:

| Store | Purpose | Tables |
|-------|---------|--------|
| `attribution.db` | Cost attribution per API call | `cost_events` (existing from ADR-005), `task_checkouts` (new) |
| `pipeline.db` | Pipeline state including action scores | `action_scores`, `session_composites` (new from ADR-015 revised) |

No `agent_budgets` table -- budgets are per-story (existing FR38 in `pipeline.db`) and global (existing FR39 in `factory.yaml` config).

#### 16.3 Atomic Task Checkout

Atomic task checkout prevents double-work when multiple stories are active concurrently. Integrates with Overstory's Seeds task tracker.

**Flow:**
1. Factory Core identifies next task from Seeds (using `sd` CLI or direct JSONL access)
2. Factory Core writes `task_checkouts` row in `attribution.db` with `claimed_at` timestamp
3. SQLite UNIQUE constraint on `(story_id, task_id)` prevents double-claim
4. On task completion, `completed_at` is set
5. On task failure/timeout, `released_at` is set (task available for re-claim)

```sql
-- In attribution.db
CREATE TABLE task_checkouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  released_at TEXT,
  UNIQUE(story_id, task_id)
);
CREATE INDEX idx_checkout_story ON task_checkouts(story_id);
CREATE INDEX idx_checkout_agent ON task_checkouts(agent_id);
```

**Design inspiration:** PaperclipAI's `agent_wakeup_requests.ts` `claimedAt` atomic checkout pattern. Our implementation is ~30 LOC new-write using `bun:sqlite` directly (not Drizzle), with Zod validation at boundaries.

#### 16.4 Cost Data Flow

```
Pi SDK Usage { tokens, cost }
  -> Factory Core receives per-call usage via Pi SDK callback
  -> Factory Core writes cost_events row in attribution.db
      (developer_id, story_id, phase, agent_id, model, provider, tokens, cost)
  -> Factory Core checks cumulative story cost against per-story budget
      (SELECT SUM(cost) FROM cost_events WHERE story_id = ?)
  -> Factory Core checks cumulative daily cost against global ceiling
      (SELECT SUM(cost) FROM cost_events WHERE date(created_at) = date('now'))
  -> If either limit exceeded: pause/block with notification
```

#### 16.5 Burn Rate Prediction

Projected cost calculation for dashboard display and notification triggers:

```
projected_total_cost = (cost_so_far / phases_completed) * total_phases
```

Where:
- `cost_so_far` = SUM of cost_events for the story
- `phases_completed` = count of completed phases (dev, bmad, qa, etc.)
- `total_phases` = total configured phases for the story's work type

If `projected_total_cost > story_budget * 0.8`, dashboard displays a warning. If `projected_total_cost > story_budget`, Telegram notification dispatched to developer.

#### 16.6 Integration Points

| Integration | Direction | What Flows |
|------------|-----------|-----------|
| Pi SDK Usage callback -> attribution.db | In | Per-call cost_events |
| attribution.db -> Factory Core budget check | Out | Cumulative cost queries before agent spawn |
| Factory Core -> Seeds (Overstory) | Both | Task identification and atomic checkout |
| attribution.db -> Dashboard | Out | Cost breakdown, burn rate, projections |
| attribution.db -> Telegram (ADR-014) | Out | Budget warning/exceeded notifications |

### ADR-017: Continuous Verification — Nyquist Layer (Revised — Session 8)

**Status:** Proposed (Revised)
**Replaces:** ADR-017 "Goal-Backward Verification -- Nyquist Layer" from Session 6
**Resolves:** CONS-004, COMP-011, FAIL-006, ARCH10X-007, 10X-002

#### 17.1 Renaming and Two-Mode Architecture

Renamed from "Goal-Backward Verification" to "Continuous Verification" to reflect the expanded scope. The Nyquist layer now operates in two modes:

| Mode | When | Cost | What It Checks |
|------|------|------|---------------|
| **Lightweight continuous** | Post-task hook during development | Near-zero (filesystem only, no LLM) | Artifact existence, key_link pattern matching, structural integrity |
| **Full Nyquist** | After QA swarm completion (QA boundary) | ~$0.005 (economy-tier model, ~30s) | Complete must_haves verification including behavioral checks (truths) |

#### 17.2 Lightweight Continuous Verification (10X-002)

**Runs as a post-task hook during the development phase.** After every task completion (not every edit), a filesystem-only check verifies structural integrity:

1. **Artifact existence:** Do the files declared in `must_haves.artifacts` exist? Do they meet `min_lines` threshold?
2. **Key link pattern matching:** Do `must_haves.key_links` source files contain the required import/reference patterns (regex match against file content)?
3. **No LLM calls.** Pure filesystem operations: `existsSync()`, `readFileSync()`, regex match.
4. **Duration target:** <500ms per check (filesystem I/O only).
5. **Output:** Pass/fail per check. Fails are injected into the agent's next turn as "structural drift detected" context.

**What it does NOT check:** Behavioral truths (e.g., "JWT tokens expire after 15 minutes") require test execution or LLM judgment. Those remain in full Nyquist at the QA boundary.

**Expected impact (10X-002):** 40-50% fix-loop reduction by catching structural drift (missing files, broken imports, incomplete wiring) during development instead of after BMAD review. 25-35% token savings on stories that would have entered fix loops.

**Design inspiration:** GSD `verify.cjs` `cmdVerifyArtifacts()` and `cmdVerifyKeyLinks()` functions (~113 LOC). Our implementation is ~150 LOC new-write in TypeScript, operating on the same `must_haves` schema but using `bun:sqlite` for result storage and Bun filesystem APIs.

#### 17.3 Full Nyquist at QA Boundary

Unchanged from Session 6 in purpose, refined in execution:

1. Story spec declares `must_haves` section (truths, artifacts, key_links)
2. After QA swarm completes, Nyquist verifier agent runs
3. Verifier starts from story GOAL, not task checklist
4. **Truths:** Observable behaviors verified by test assertions or runtime checks
5. **Artifacts:** Files/functions with `min_lines`, `contains`, `exports` constraints (superset of lightweight checks)
6. **Key links:** Integration wiring with regex pattern matching (superset of lightweight checks)
7. Produces VERIFICATION.md with pass/fail per check, gaps identified
8. Gaps feed into fix loop (FR7)

#### 17.4 Pre-BMAD Structural Gate (ARCH10X-007)

Before BMAD review begins, a lightweight structural check runs:

- Do all files claimed in the transfer manifest actually exist?
- Do claimed commits exist in the branch history?
- Do file sizes match claimed line counts (within 20% tolerance)?

**Purpose:** Catches "phantom completions" (agent claimed to create files that do not exist) before spending BMAD review tokens. Cost: near-zero (filesystem checks). Savings: ~$0.02-0.05 per phantom completion caught.

**Implementation:** Runs as a `before_run` workspace hook (ADR-018) for the BMAD phase.

#### 17.5 Oscillation Detection for False Negatives (FAIL-006)

When the Nyquist verifier incorrectly reports gaps, the fix loop burns budget on non-issues. Detection mechanism:

1. Fix loop iteration N produces gap list G_N
2. Fix loop runs, modifies code
3. Fix loop iteration N+1 re-runs Nyquist, produces gap list G_{N+1}
4. **If G_{N+1} == G_N AND the fix loop did not modify any files referenced in the gaps:** flag as potential false negative
5. **Action:** Escalate to developer (Telegram notification) instead of iterating. Include the gap list and evidence that the code was not modified.
6. **Hard cap:** After 2 consecutive identical gap lists with no relevant code changes, force-exit the fix loop with `verification_inconclusive` status.

#### 17.6 Nyquist-BMAD Disagreement Protocol (COMP-011)

BMAD (FR19-FR21) and Nyquist (this ADR) are independent quality systems. When they disagree:

| Scenario | Tiebreaker | Rationale |
|----------|-----------|-----------|
| BMAD pass, Nyquist fail on **structural completeness** (missing artifacts, broken key_links) | **Nyquist wins** | Structural checks are objective and deterministic. BMAD may have hallucinated file existence. |
| BMAD fail, Nyquist pass on **spec compliance** (behavioral requirements, design decisions) | **BMAD wins** | BMAD has full spec context; Nyquist checks structure, not intent. |
| Both fail on **different** issues | **Both gaps addressed** in fix loop | No conflict -- additive gap lists. |
| Both fail on **same** issue with different assessments | **Escalate** to developer | Genuine ambiguity requires human judgment. |

#### 17.7 must_haves Schema

```yaml
must_haves:
  truths:
    - "JWT tokens expire after 15 minutes"
    - "Failed login attempts are rate-limited"
  artifacts:
    - path: src/lib/auth.ts
      min_lines: 50
      contains: "export function authenticate"
      exports: [authenticate, verifyToken]
  key_links:
    - from: src/app/api/route.ts
      to: src/lib/auth.ts
      pattern: "import.*auth"
```

Zod schema in `shared-types/src/must-haves.ts`:

```typescript
export const MustHavesSchema = z.object({
  truths: z.array(z.string()).default([]),
  artifacts: z.array(z.object({
    path: z.string(),
    min_lines: z.number().optional(),
    contains: z.string().optional(),
    exports: z.array(z.string()).optional(),
  })).default([]),
  key_links: z.array(z.object({
    from: z.string(),
    to: z.string(),
    pattern: z.string(),
  })).default([]),
});
```

#### 17.8 Integration Points

| Integration | Direction | What Flows |
|------------|-----------|-----------|
| Story spec -> Nyquist | In | `must_haves` section |
| Post-task hook -> Lightweight verifier | Trigger | Runs after each task in dev phase |
| Lightweight verifier -> Agent context | Out | Structural drift warnings injected into next turn |
| QA swarm completion -> Full Nyquist | Trigger | Runs after Wave 5 completes |
| Full Nyquist -> Fix loop (FR7) | Out | Gap list feeds remediation |
| Full Nyquist -> VERIFICATION.md | Out | Per-check results stored in `.qds/verifications/` |
| Full Nyquist <-> BMAD disagreement | Protocol | Tiebreaker rules per Section 17.6 |
| Pre-BMAD gate -> BMAD phase | Gate | Phantom completion check before review |

### ADR-018: Workspace Lifecycle Hooks (Revised — Session 8)

**Status:** Proposed (Revised)
**Replaces:** ADR-018 "Workspace Lifecycle Hooks (Extends ADR-002)" from Session 6
**Resolves:** CONS-003, COMP-026, FAIL-020

#### 18.1 Hook Points (Unchanged)

Four hook points remain as defined in Session 6:

| Hook | Trigger | Default Action | Configurable |
|------|---------|---------------|-------------|
| `after_create` | Worktree created via `git worktree add` | Install dependencies, copy `.env` template | Yes, `factory.yaml` `workspace.hooks.after_create` |
| `before_run` | Before first agent spawns in worktree | Verify dependencies, check disk space, pre-BMAD structural gate | Yes, `factory.yaml` `workspace.hooks.before_run` |
| `after_run` | After story completion (success or failure) | Collect metrics, extract learning records | Yes, `factory.yaml` `workspace.hooks.after_run` |
| `before_remove` | Before worktree cleanup | Verify no uncommitted changes, archive logs | Yes, `factory.yaml` `workspace.hooks.before_remove` |

#### 18.2 L3 Minimum Enforcement Cap for All Tiers (CONS-003)

**No agent, regardless of tier, skips phase boundary hooks.** The original ADR-015 allowed Tier 5 agents to reduce hook enforcement to "escalation only," effectively removing L2 and L3 hooks. This undermines the non-negotiable quality infrastructure.

**New rule:** L3 phase boundary hooks are the enforcement floor for ALL tiers. No configuration, no override, no exception.

| Tier | L1 (per-edit) | L2 (per-task) | L3 (per-phase boundary) |
|------|--------------|--------------|------------------------|
| 1 | Every edit | Every task | Every boundary |
| 2 | Every 3rd edit | Every task | Every boundary |
| 3 | Every 5th edit | Every 3rd task | Every boundary |
| 4 | Disabled | Every 5th task | Every boundary |
| 5 | Disabled | Every 10th task | **Every boundary** |

Phase boundary hooks are the moments where context isolation is verified, transfer manifests are validated, and canary tokens are checked. Skipping them is equivalent to removing the lock from a safe because you trust the employees.

#### 18.3 Hook Rollback on Partial Failure (COMP-026)

Hooks that fail during workspace creation must clean up after themselves:

| Hook | Failure Behavior |
|------|-----------------|
| `after_create` fails | **Rollback:** Remove the created worktree (`git worktree remove --force`), set story status to `failed_setup`, log diagnostic, notify developer. Do NOT leave an unusable worktree. |
| `before_run` fails | **Block:** Story fails with diagnostic. Worktree preserved for inspection. Developer can retry after fixing the issue. |
| `after_run` fails | **Warn:** Log warning, story completion status unaffected. Learning extraction from this story may be incomplete. |
| `before_remove` fails | **Warn:** Log warning, cleanup proceeds. If uncommitted changes detected, archive them to `.qds/orphaned-changes/` before removal. |

#### 18.4 Timeout Handling During I/O Degradation (FAIL-020)

Hook timeouts auto-adjust when the system health circuit breaker (ADR-023) detects I/O stress:

- **Normal mode:** Hook timeout per `factory.yaml` configuration (default 30s)
- **Degraded mode (circuit breaker active):** Hook timeout doubled automatically (60s)
- **Mechanism:** Hooks read timeout from Factory Core config, which is dynamically adjusted by the circuit breaker. No hook code changes needed.

#### 18.5 Execution Model

Hooks run in Factory Core process via `Bun.spawn()` (not agent process). This is a security boundary: hook scripts execute with Factory Core's permissions, not agent permissions. Agents cannot modify, skip, or observe hook execution.

**Integration with Overstory's worktree manager:** Factory Core adds hooks AROUND Overstory's worktree lifecycle, not inside it. Overstory manages `git worktree add/remove`. Factory Core's hooks fire before/after those operations.

```
Factory Core: after_create hook
  -> Overstory: git worktree add
  -> Factory Core: after_create hook scripts (Bun.spawn)
  -> [agent work happens]
  -> Factory Core: after_run hook scripts (Bun.spawn)
  -> Factory Core: before_remove hook scripts (Bun.spawn)
  -> Overstory: git worktree remove
```

**Design inspiration:** Symphony `workspace_lifecycle.ex` hook point pattern (4 lifecycle events around workspace operations). Our implementation is ~200 LOC new-write wrapping Overstory's worktree commands with `Bun.spawn()` hook execution.

*Session 13 note (ADR-033): `git worktree` is overstory's mechanism for satisfying invariant 2 (filesystem isolation per story). The 4-point workspace lifecycle hooks here operate **around** that mechanism; alternative isolation mechanisms (overlay filesystems, containers, read-only clones) would require re-mapping the lifecycle events but do not invalidate the hook-point pattern itself. The invariant is "filesystem isolation per story with lifecycle hook points around creation and teardown"; the mechanism is "git worktree commands." See ADR-033 invariant/mechanism reclassification for the full list of mechanisms previously written into ADRs as if architectural.*

#### 18.6 Integration Points

| Integration | Direction | What Flows |
|------------|-----------|-----------|
| Factory Core -> Overstory worktree manager | Wraps | Hooks fire around `git worktree add/remove` |
| `before_run` -> Nyquist lightweight check (ADR-017) | Contains | Pre-BMAD structural gate is a `before_run` hook for BMAD phase |
| Hook failure -> Story state (pipeline.db) | Out | `after_create` failure sets story to `failed_setup` |
| Circuit breaker (ADR-023) -> Hook timeouts | Modifies | Doubles timeouts during degraded mode |
| `after_run` -> Learning extraction (ADR-015) | Triggers | Learning records extracted from story results |

### ADR-019: Turn Continuation (Revised — Session 8)

**Status:** Proposed (Revised)
**Replaces:** ADR-019 "Turn-Based Agent Continuation (Extends ADR-002)" from Session 6
**Resolves:** CONS-004, FAIL-012, FAIL-015

#### 19.1 Lightweight Per-Turn Signals, Not Full Nyquist (CONS-004)

The original ADR-019 used "goal-backward check from ADR-017" to determine if the phase goal was achieved after each turn. ADR-017's full Nyquist verifier was designed to run once after QA, not per-turn during development. Running it per-turn is prohibitively expensive.

**New per-turn goal check uses lightweight signals only:**

1. **Post-task hook pass/fail result** (already computed, zero marginal cost)
2. **Lightweight Nyquist structural check** (filesystem-only, <500ms, from ADR-017 Section 17.2)
3. **Checklist completion** -- percentage of declared subtasks marked complete in the agent's working context

**Decision logic:**
- All signals green AND checklist >= 90% complete: phase goal considered achieved, trigger transition
- Any signal red OR checklist < 90%: continue to next turn (if turns remain)
- Full Nyquist runs only at QA boundary, never during turn continuation

#### 19.2 Turn Loop

1. Agent receives task within phase
2. Agent executes turn (single model invocation with tool calls via Pi SDK)
3. Post-task hook fires, computes action score, runs lightweight structural check
4. Factory Core evaluates: goal achieved? (per Section 19.1 decision logic)
5. If goal NOT achieved AND `turn_number < max_turns`: inject continuation prompt, execute next turn
6. If goal achieved OR `max_turns` reached: trigger phase transition

#### 19.3 Progress Velocity Check (FAIL-012)

When `max_turns` is reached but the goal is not yet complete, a blanket phase transition wastes the 89% of work already done. The fresh BMAD agent must re-understand nearly-complete code from scratch.

**New rule:** If ALL of the following conditions are met, Factory Core extends `max_turns` by 1:

- Agent made measurable progress in the last turn (at least 1 new file modified or 1 new test passing)
- Goal completion is >75% (based on checklist completion + structural checks)
- Current `turn_number < max_turns * 1.5` (hard cap prevents infinite extension)

**Example:** `max_turns = 5`, agent reaches turn 5 at 85% completion with progress in the last turn. Extension grants turn 6. If turn 6 reaches 92% with progress, extension grants turn 7. Hard cap is `5 * 1.5 = 7.5 -> 7`, so turn 7 is the absolute maximum.

#### 19.4 Defensive Error Normalization (FAIL-015)

Elixir uses exhaustive pattern matching on `{:ok, value} / {:error, reason}` tuples. TypeScript uses `try/catch`. Unexpected error types (plain strings, numbers thrown by dependencies) fall through catch blocks silently.

**Rule:** All errors at async boundaries within the turn continuation loop are normalized to typed `Result` objects:

```typescript
// shared-types/src/result.ts
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E; message: string };

export function toResult<T>(fn: () => T): Result<T> {
  try {
    const value = fn();
    return { ok: true, value };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function toResultAsync<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
```

Every Pi SDK call, every hook execution, every filesystem operation within the turn loop is wrapped in `toResultAsync()`. No raw `try/catch` blocks in the turn continuation module.

#### 19.5 Turn State Persistence (FAIL-015)

Turn state is persisted to `pipeline.db` between turns, not held in process memory. If the Factory Core process crashes mid-story, the story can resume from the last completed turn.

```sql
-- In pipeline.db
CREATE TABLE turn_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'extended')),
  checklist_completion REAL NOT NULL DEFAULT 0.0,
  files_modified TEXT,  -- JSON array
  action_score_id INTEGER REFERENCES action_scores(id),
  structural_check_passed INTEGER NOT NULL DEFAULT 0,  -- boolean
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  UNIQUE(story_id, phase, turn_number)
);
CREATE INDEX idx_turn_state_story ON turn_state(story_id, phase);
```

#### 19.6 Continuation Prompt Template

Adapted from Symphony `agent_runner.ex` (lines 106-114):

```
The previous turn completed normally, but the phase goal is not yet fully achieved.
This is continuation turn {turn_number} of {max_turns} for the {phase} phase.

Resume from the current workspace state instead of restarting from scratch.

Structural check results:
{lightweight_nyquist_results}

Remaining work:
{remaining_checklist_items}

Focus on completing the remaining items. Do not redo work that is already complete.
```

#### 19.7 Configuration

```yaml
# factory.yaml
phases:
  develop:
    max_turns: 5
  bmad:
    max_turns: 2
  qa:
    max_turns: 3
```

#### 19.8 Integration Points

| Integration | Direction | What Flows |
|------------|-----------|-----------|
| Pi SDK AgentSession -> Turn loop | Bidirectional | Pi handles model calls; Factory Core manages turn loop logic |
| Post-task hooks (ADR-010) -> Turn decision | In | Hook pass/fail feeds goal-check decision logic |
| Lightweight Nyquist (ADR-017) -> Turn decision | In | Structural check results feed goal-check decision |
| Turn state -> pipeline.db | Persist | Survives crashes, enables resume |
| Turn loop -> Stall detection (FR47) | Integration | Stall timeout is per-turn, not per-phase |
| Continuation prompt -> Agent context | Out | Injected via Factory Core before next Pi SDK call |

### ADR-020: Design Inspiration Strategy (Revised — Session 8)

**Status:** Proposed (Revised)
**Replaces:** ADR-020 "Code Transplant Strategy" from Session 6
**Resolves:** TRANS-001, TRANS-003, TRANS-007, CONS-011, SCOPE-003

#### 20.1 Complete Rewrite: Inspiration, Not Transplant

**Research repos are DESIGN INSPIRATION, not transplant sources.** Session 7 demonstrated:

- Claimed 79% transplant ratio was inflated to ~43% on verified analysis (TRANS-001, TRANS-003, TRANS-007)
- DeerFlow `hooks.ts` was 488 LOC of irrelevant React chat hooks, not performance dashboard code (TRANS-007: 488 -> 0 LOC)
- GSD `verify.cjs` was 87% project health tooling unrelated to goal verification (TRANS-003: 820 -> ~150 LOC)
- PaperclipAI `costs.ts` was 85% Postgres-specific (TRANS-001: 204 -> ~80 LOC)
- Effort multipliers range from 1.5x (TypeScript->TypeScript) to 3.0x (Elixir->TypeScript) (SCOPE-003)

**New framing:** We do not count LOC transplanted. We document what patterns we learned from each repo and write clean TypeScript/Bun code that embodies those patterns, conforming to QDS conventions (bun:sqlite, Zod schemas, atomic writes, EventStore events, shared-types package).

#### 20.2 Pattern Inspiration Table

| Capability | Source Pattern | What We Learned | QDS Implementation |
|-----------|---------------|----------------|-------------------|
| Action scoring | PaperclipAI `activity-log.ts` audit trail | Event-sourced activity logging with cost attribution | `factory-core/src/performance/action-scorer.ts` -- ~120 LOC new-write, bun:sqlite |
| Confidence scoring | DeerFlow `memory/updater.py` | Brier score calibration with decay weighting | `factory-core/src/performance/confidence.ts` -- ~80 LOC new-write |
| Atomic task checkout | PaperclipAI `agent_wakeup_requests.ts` `claimedAt` | SQLite UNIQUE constraint as distributed lock | `factory-core/src/pipeline/task-checkout.ts` -- ~30 LOC new-write |
| Cost aggregation | PaperclipAI `costs.ts` (portable 80 LOC) | SUM/GROUP BY with time-window filtering | `factory-core/src/economics/cost-queries.ts` -- ~60 LOC new-write |
| Must-haves verification | GSD `verify.cjs` `cmdVerifyArtifacts()` + `cmdVerifyKeyLinks()` (~113 LOC) | Artifact existence + key_link regex pattern matching | `factory-core/src/verification/nyquist.ts` -- ~150 LOC new-write |
| Workspace hooks | Symphony `workspace.ex` (275 LOC) | 4-point lifecycle hook pattern with failure-mode-per-hook | `factory-core/src/worktree/lifecycle-hooks.ts` -- ~200 LOC new-write |
| Turn continuation | Symphony `agent_runner.ex` (154 LOC) | Turn loop with continuation prompt template | `factory-core/src/pipeline/turn-continuation.ts` -- ~180 LOC new-write |
| Bidirectional middleware | DeerFlow `agents/middleware/` | before_model/after_model pattern for pipeline composition | `factory-core/src/middleware/` -- ~300 LOC new-write (ADR-021) |
| Multi-channel notification | DeerFlow `modules/channel/` | MessageBus + Channel base class pattern | `factory-core/src/notifications/` -- ~250 LOC new-write (ADR-022) |
| Model profiles | GSD `core.cjs` MODEL_PROFILES | Agent-type to model-tier mapping table | `factory-core/src/config.ts` extension -- ~50 LOC |
| Agent lifecycle | PaperclipAI `agents.ts` | Config revision tracking, soft delete | Design reference for FR22/FR25 implementation |
| Dashboard algorithms | Symphony `status_dashboard.ex` (600 LOC useful) | Sparkline computation, throughput tracking, event humanization | Dashboard utility functions -- Growth phase |

#### 20.3 Database Access: bun:sqlite Only (CONS-011 Resolved)

**Decision:** All SQLite access in the QDS codebase uses `bun:sqlite` direct API. No Drizzle ORM.

**Rationale:**
- Overstory already uses `bun:sqlite` for 4 databases (sessions.db, mail.db, events.db, metrics.db)
- Factory Core adds 2 databases (pipeline.db, attribution.db)
- One access pattern means one transaction model, one migration strategy, one error handling approach
- Zod schema validation at read boundaries provides the type safety that Drizzle ORM would have provided at the schema level
- `bun:sqlite` is synchronous, which matches the Bun event loop model (no async overhead for DB operations)

**Migration strategy:** SQL migration files in `factory-core/src/migrations/` applied at startup. Each migration file is a SQL script with a version number. Factory Core tracks applied migrations in a `schema_migrations` table.

#### 20.4 All Code Follows QDS Conventions

Regardless of inspiration source, all code must:

- Use `bun:sqlite` for database access (not Drizzle, not `better-sqlite3`)
- Define types in `shared-types` package with Zod schemas as source of truth
- Use `kebab-case.ts` file naming, `PascalCase` types, `camelCase` functions
- Use atomic write patterns (temp file + rename) for any filesystem state
- Emit events to EventStore for observability
- Pass existing lint rules (Biome) and type-check
- Stay under 500 LOC per file

---

### ADR-021: Bidirectional Middleware Chain (New — Session 8)

**Status:** Proposed
**Finding:** ARCH10X-001
**Decision:** Introduce an organizational pattern where each cross-cutting concern has `beforeModel()` and `afterModel()` phases, replacing the unidirectional overlay pipeline with a bidirectional middleware chain.

#### 21.1 Clarification: Organizational Pattern, Not Runtime Framework

This is NOT a new runtime execution engine. It is an organizational pattern that gives structure to two things that already happen:

1. **Overlay assembly** (already happens once per agent session via `overlay.ts`)
2. **Post-action processing** (already happens via hooks after each task/phase)

The middleware pattern unifies these into a coherent structure where each cross-cutting concern (budget, credentials, learning, enforcement, skills, performance, verification) owns both its "before" and "after" logic in one place, rather than scattering related logic across overlay stages and hook handlers.

#### 21.2 Middleware Interface

```typescript
// shared-types/src/middleware.ts
export interface MiddlewareContext {
  storyId: string;
  phase: string;
  agentId: string;
  agentRole: string;
  [namespace: string]: unknown;  // per-middleware namespaced data
}

export interface MiddlewareResult {
  contextAdditions: Record<string, string>;  // key-value pairs to inject into overlay
  errors: Array<{ middleware: string; error: string }>;
  metadata: Record<string, unknown>;
}

export interface Middleware {
  name: string;
  order: number;  // execution order (lower = earlier)
  beforeModel(ctx: MiddlewareContext): Result<MiddlewareResult>;
  afterModel(ctx: MiddlewareContext, actionResult: unknown): Result<MiddlewareResult>;
}
```

#### 21.3 Middleware Execution Model

**`beforeModel()` runs at overlay assembly time** (once per agent session, when Factory Core composes the overlay for a new agent). Each middleware's `beforeModel()` can:

- Add content to the overlay context (e.g., budget middleware injects remaining budget)
- Block agent spawn (e.g., budget middleware rejects if ceiling exceeded)
- Read from its data source (pipeline.db, attribution.db, Superpowers metadata)

**`afterModel()` runs at task/turn completion time** (via the existing post-task hook pipeline). Each middleware's `afterModel()` can:

- Record data (e.g., performance middleware writes action score)
- Update state (e.g., learning middleware extracts new learnings)
- Trigger side effects (e.g., verification middleware runs lightweight structural check)

#### 21.4 Middleware Components

| # | Middleware | Order | `beforeModel()` | `afterModel()` |
|---|----------|-------|-----------------|----------------|
| 1 | `budget-middleware` | 10 | Check per-story + global budget ceiling. Block if exceeded. | Record cost from Pi SDK Usage callback. Update cumulative totals. |
| 2 | `credential-middleware` | 20 | Inject API keys via Pi SDK configuration (no keys in overlay text). | Sanitize any output that might contain leaked credentials. |
| 3 | `learning-middleware` | 30 | Query `learning_records` and `pattern_knowledge` for relevant domain learnings. Inject into overlay (~500 tokens). | Extract learning records from fix-loop/maintenance results. Write to pipeline.db. |
| 4 | `enforcement-middleware` | 40 | Inject iron laws, conventions, and gate rules from Superpowers frontmatter. | Log gate pass/fail results. Update enforcement statistics. |
| 5 | `skill-middleware` | 50 | Inject skill descriptions from Superpowers metadata (read-only). | No-op. Skills are read-only context. |
| 6 | `performance-middleware` | 60 | (Growth only) Inject performance context. Do NOT inject agent's own tier (PERV-011). | Compute action score from hook results. Write to `action_scores` table. |
| 7 | `verification-middleware` | 70 | Inject `must_haves` from story spec into agent context. | Run lightweight structural check (ADR-017 Section 17.2). Report drift. |

#### 21.5 Error Isolation

Each middleware executes independently with error isolation:

- Middleware failure in `beforeModel()`: logged, does not block other middleware (except `budget-middleware` and `credential-middleware` which are fatal)
- Middleware failure in `afterModel()`: logged, does not block story completion
- No backward dependencies between middleware (middleware N does not read output of middleware N-1)
- Each middleware uses a namespaced key in `MiddlewareContext` to avoid collisions

#### 21.6 Strict Ordering, No Backward Dependencies

Middleware execute in `order` sequence. A middleware at order 30 MUST NOT read data written by a middleware at order 40. Forward-only data flow prevents circular dependencies.

The ordering ensures:
- Budget check happens first (no point assembling context for an over-budget agent)
- Credentials are injected before any content that might reference them
- Learning context is available before enforcement rules (learnings may reference conventions)
- Verification runs last (needs all context to know what to verify)

#### 21.7 Relationship to Existing Overlay Pipeline

The existing 6-stage overlay pipeline (Factory Core's `overlay.ts`) is not replaced. It is reorganized:

| Old Stage | New Middleware | Change |
|-----------|--------------|--------|
| Stage 1: System prompt | Not middleware (static, per-agent-type) | Unchanged |
| Stage 2: Mulch domain expertise | `learning-middleware` Layer 1 source | Mulch remains Overstory's domain; middleware reads it |
| Stage 3: Superpowers skills | `skill-middleware` + `enforcement-middleware` | Split: skills (read-only context) vs enforcement (rules) |
| Stage 4: Learning injection | `learning-middleware` | Unified with Layer 1/2/3 learning system |
| Stage 5: Task context | Not middleware (specific to current task) | Unchanged |
| Stage 6: Economic context | `budget-middleware` | Budget check + context injection |

**Net new:** `performance-middleware` (Growth), `verification-middleware`, `credential-middleware`. These were previously scattered across hook handlers and ad-hoc overlay assembly logic.

#### 21.8 Implementation Scope

~300 LOC new-write total:
- `factory-core/src/middleware/types.ts` -- Middleware interface, MiddlewareContext, MiddlewareResult (~40 LOC)
- `factory-core/src/middleware/chain.ts` -- MiddlewareChain executor that runs before/after phases (~60 LOC)
- `factory-core/src/middleware/budget.ts` -- Budget middleware (~40 LOC)
- `factory-core/src/middleware/credential.ts` -- Credential middleware (~30 LOC)
- `factory-core/src/middleware/learning.ts` -- Learning middleware (~50 LOC)
- `factory-core/src/middleware/enforcement.ts` -- Enforcement middleware (~30 LOC)
- `factory-core/src/middleware/skill.ts` -- Skill middleware (~20 LOC)
- `factory-core/src/middleware/verification.ts` -- Verification middleware (~30 LOC)

**Design inspiration:** DeerFlow `backend/src/agents/middleware/` -- bidirectional before/after pattern applied to agent processing pipelines. Our implementation uses a simpler interface (no async middleware, no middleware nesting) designed for the hook/overlay execution model.

---

### ADR-022: Multi-Channel Notification Abstraction (New — Session 8)

**Status:** Proposed
**Finding:** ARCH10X-002
**Decision:** Replace the Telegram-only messenger (ADR-014) with a channel-agnostic notification system. Telegram remains the first (and MVP-only) channel. The abstraction enables zero-architecture-cost addition of Slack, Discord, email, or webhook channels in Growth/Vision phases.

#### 22.1 Architecture

```
                          +-----------------+
                          |   Factory Core  |
                          | (event source)  |
                          +--------+--------+
                                   |
                                   v
                          +-----------------+
                          |   MessageBus    |
                          | (pub/sub router)|
                          +--------+--------+
                                   |
                    +--------------+--------------+
                    |              |              |
              +-----v-----+ +-----v-----+ +-----v-----+
              | Telegram  | |  Slack    | |  Webhook  |
              | Channel   | | Channel   | | Channel   |
              +-----------+ +-----------+ +-----------+
               (MVP)         (Growth)      (Growth)
```

#### 22.2 Channel Base Class

```typescript
// factory-core/src/notifications/channel.ts
export interface ChannelMessage {
  id: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  category: string;  // 'budget', 'escalation', 'stall', 'completion', 'health'
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
}

export interface Channel {
  name: string;
  enabled: boolean;
  send(message: ChannelMessage): Promise<Result<string>>;  // returns message ID
  edit(messageId: string, message: ChannelMessage): Promise<Result<void>>;
  delete(messageId: string): Promise<Result<void>>;
  healthCheck(): Promise<Result<boolean>>;
}
```

#### 22.3 MessageBus

Replaces duplicate EventStore polling. Instead of each notification consumer polling the EventStore independently, the MessageBus subscribes once and distributes events to registered channels.

```typescript
// factory-core/src/notifications/message-bus.ts
export interface Subscription {
  categories: string[];  // which message categories this channel wants
  severityMinimum: 'info' | 'warning' | 'error' | 'critical';
}

export interface MessageBus {
  registerChannel(channel: Channel, subscription: Subscription): void;
  unregisterChannel(channelName: string): void;
  publish(message: ChannelMessage): Promise<void>;  // dispatches to all matching channels
  getChannelHealth(): Map<string, boolean>;
}
```

#### 22.4 TelegramChannel as First Implementation

ADR-014's existing Telegram messenger becomes an implementation of the `Channel` interface. All existing functionality (dual-channel notifications, inbound commands, async dialogue, quiet hours, severity routing) is preserved. The `TelegramChannel` wraps the existing messenger package.

**What changes for ADR-014:**
- `messenger/` package internals are unchanged
- `factory-core` creates a `TelegramChannel` adapter that implements `Channel` and delegates to the messenger package
- All Factory Core notification calls go through `MessageBus.publish()` instead of directly calling messenger functions
- Existing Telegram-specific features (inline keyboards, chat commands, webhook endpoint) remain in the messenger package

#### 22.5 Adding a New Channel (Growth Example: Slack)

```typescript
// factory-core/src/notifications/channels/slack-channel.ts
export class SlackChannel implements Channel {
  name = 'slack';
  enabled = true;

  constructor(private webhookUrl: string) {}

  async send(message: ChannelMessage): Promise<Result<string>> {
    // POST to Slack webhook with formatted message
    // Map severity to Slack color codes
    // Return Slack message timestamp as ID
  }
  // ... edit, delete, healthCheck implementations
}
```

Zero architecture changes. Add the class, register it with the MessageBus, configure in `factory.yaml`.

#### 22.6 Configuration

```yaml
# factory.yaml
notifications:
  channels:
    telegram:
      enabled: true
      # existing telegram config from ADR-014
    slack:
      enabled: false
      webhook_url: ""
    webhook:
      enabled: false
      url: ""
  routing:
    critical: [telegram, slack]    # critical goes to all enabled channels
    error: [telegram]              # errors go to primary channel
    warning: [telegram]            # warnings go to primary channel
    info: []                       # info not pushed (dashboard only)
```

#### 22.7 Implementation Scope

~250 LOC new-write total:
- `factory-core/src/notifications/channel.ts` -- Channel interface, ChannelMessage type (~30 LOC)
- `factory-core/src/notifications/message-bus.ts` -- MessageBus with pub/sub routing (~80 LOC)
- `factory-core/src/notifications/channels/telegram-channel.ts` -- Adapter wrapping existing messenger package (~60 LOC)
- `factory-core/src/notifications/channels/webhook-channel.ts` -- Generic webhook channel for extensibility (~40 LOC)
- `shared-types/src/notifications.ts` -- Notification type extensions (~40 LOC)

**Design inspiration:** DeerFlow `modules/channel/` -- MessageBus, Channel base class concept. Our implementation is simpler (no ChannelManager/ChannelService/ChannelStore layers) because QDS has a single Factory Core instance, not a distributed system.

---

### ADR-023: System Health Circuit Breaker (New — Session 8)

**Status:** Proposed
**Finding:** FAIL-020
**Decision:** Implement correlated failure detection with automatic mitigation. When multiple subsystems report errors within a configurable window, the system pauses new story starts and adjusts timeouts to prevent cascade failures.

#### 23.1 Problem

Disk I/O spikes cause Nyquist verification, performance data writes, workspace hooks, and mail delivery to all timeout simultaneously. Each subsystem handles its failure independently with no awareness of the common root cause. Result: multiple stories fail simultaneously, each generating independent error logs, Telegram notifications, and retry attempts that compound the I/O load.

#### 23.2 Circuit Breaker Mechanism

**Trigger:** 3+ subsystems report errors within a configurable window (default 60 seconds).

**Monitored subsystems:**

| Subsystem | Error Signal |
|-----------|-------------|
| Overstory sessions | Session create/destroy failure, `sessions.db` write timeout |
| Overstory mail | Mail send/receive failure, `mail.db` write timeout |
| pipeline.db | Any write failure, WAL checkpoint failure |
| attribution.db | Cost event write failure |
| Gate scripts | Gate script timeout or non-zero exit |
| Pi SDK calls | Provider API timeout, rate limit hit |
| Filesystem | Worktree creation failure, file write failure |

**State machine:**

```
CLOSED (healthy)
  -> 3+ subsystem errors in 60s window
  -> OPEN (degraded)

OPEN (degraded)
  -> Pause new story starts
  -> Double hook/verification timeouts
  -> Active stories continue (do not kill in-progress work)
  -> Log system health event to events.db
  -> Telegram notification to developer

OPEN -> HALF_OPEN
  -> After check_interval (default 30s), probe subsystem health
  -> If error rate below threshold for 2 consecutive intervals: -> CLOSED
  -> If errors persist: stay OPEN

HALF_OPEN -> CLOSED
  -> Resume normal operation
  -> Restore original timeouts
  -> Allow new story starts
  -> Log recovery event
```

#### 23.3 Automatic Mitigations

| Condition | Mitigation |
|-----------|-----------|
| Circuit breaker OPEN | Pause new story starts (queue them) |
| I/O degradation detected | Double hook timeouts (30s -> 60s) |
| I/O degradation detected | Double verification timeouts |
| Pi SDK rate limit hit | Increase inter-call delay by 2x |
| Recovery (CLOSED) | Restore all original values |
| Recovery (CLOSED) | Drain queued stories (start next in queue) |

#### 23.4 Dashboard Health Indicator

Dashboard displays system health status:

| State | Indicator | Detail |
|-------|----------|--------|
| CLOSED | Green dot in vitals strip | "All systems healthy" |
| OPEN | Red pulsing dot in vitals strip | "System degraded: {affected_subsystems}. New stories paused." |
| HALF_OPEN | Yellow dot in vitals strip | "System recovering. Monitoring..." |

#### 23.5 Configuration

```yaml
# factory.yaml
health:
  circuit_breaker:
    error_window_seconds: 60
    error_threshold: 3        # subsystems reporting errors to trigger OPEN
    check_interval_seconds: 30
    recovery_intervals: 2     # consecutive healthy intervals to return to CLOSED
    timeout_multiplier: 2.0   # multiplier for timeouts during OPEN state
```

#### 23.6 Implementation Scope

~200 LOC new-write total:
- `factory-core/src/health/circuit-breaker.ts` -- State machine, error tracking, mitigation application (~120 LOC)
- `factory-core/src/health/subsystem-monitor.ts` -- Error signal collection from each subsystem (~60 LOC)
- `shared-types/src/health.ts` -- Health state types, circuit breaker config schema (~20 LOC)

#### 23.7 Integration Points

| Integration | Direction | What Flows |
|------------|-----------|-----------|
| All subsystems -> Circuit breaker | Error signals | Error reports with subsystem identifier |
| Circuit breaker -> Hook timeouts (ADR-018) | Modifies | Doubled timeouts during OPEN state |
| Circuit breaker -> Story queue (Factory Core) | Controls | Pauses/resumes new story starts |
| Circuit breaker -> Dashboard | Status | Health state displayed in vitals strip |
| Circuit breaker -> Telegram (ADR-022) | Notification | Developer notified of degraded state |
| Circuit breaker -> events.db | Logs | Health state transitions logged as events |

### Cross-ADR Implications (Revised — Session 8)

All implications from ADR-015 through ADR-020 (original) are updated below. New implications from ADR-021 through ADR-023 are added. Items that were killed (credit_ledger, per-agent budgets, Drizzle ORM) are removed. Items from ADR-001 through ADR-014 retained unchanged.

| ADR Source | Affected Package | Implication | Status |
|---|---|---|---|
| ADR-005 | factory-core, meta | Meta-optimization daily observer queries `attribution.db` for cost patterns, model performance, and budget utilization via read-only SQL views | Pending -- interface TBD during meta-optimization design |
| ADR-005 | config | `factory.yaml` must include `system` budget section for unattributed calls (infrastructure, recovery, orchestrator) alongside per-story budget configuration | Pending |
| ADR-006 | vendor/overstory | Mail schema migration: `ALTER TABLE mail ADD COLUMN phase TEXT NOT NULL DEFAULT 'dev'` + composite index `(phase, to_agent, read)`. Must be compatible with Overstory's existing migration system | Pending |
| ADR-006 | vendor/overstory | `killSession()` extension: post-kill cleanup sequence (move transcripts, set deniedDirectories, verify). Must be idempotent | Pending |
| ADR-008 | config | `factory.yaml` must include credential storage configuration (which provider keys, rotation policy) | Pending |
| ADR-010 | vendor/overstory | Extend `EventType` union to include `hook_result` and update CHECK constraint in events.db schema. Must be compatible with existing Overstory migration system | Pending |
| ADR-009 | config | `factory.yaml` gateway config section: `port` (default 3001), `ssePollingIntervalMs` (default 500), `maxReconnectionEvents` (default 500), `keepaliveIntervalMs` (default 15000) | Pending |
| ADR-011 | gateway | Package dependency additions: `express`, `cors`, `@copilotkit/runtime`, `@copilotkit/react-core`, `@copilotkit/react-ui` (pinned `^1.52.1`), `express-ws` or equivalent. No `@ag-ui/client` or `@ag-ui/core` | Pending |
| ADR-011 | dashboard | Vite dev proxy: three channels -- `/api/copilotkit` (SSE, timeout workaround), `/events` (SSE, same), `/ws` (WebSocket, `ws: true`). HTTP/2 in production eliminates browser connection limit concerns | Pending |
| ADR-014 M2 | messenger | Webhook endpoint `/webhook/{secret}` exposed by messenger package. Requires publicly reachable URL for production Telegram webhook delivery. Long-polling fallback for local dev | Pending |
| ADR-014 M3 | shared-types, factory-core | New event types: `notification_dispatched`, `developer_action` added to EventStore event type union. `EscalationEvent` and `DeveloperAction` interfaces in shared-types | Pending |
| ADR-014 M4 | shared-types, factory-core | `escalation_id` field added to all escalation events. `escalations` tracking table in `.qds/pipeline.db` with `resolved_at`, `resolved_by`, `resolved_via` columns | Pending |
| ADR-014 M6 | messenger | `.qds/messenger.db` SQLite WAL database for `pending_dialogues`, `registrations`, and `notification_log`. New runtime database alongside `pipeline.db` and `attribution.db` | Pending |
| ADR-014 M9 | factory-core, shared-types | `system:messenger` attribution source for NL classification costs. `nl_budget_daily` ceiling tracked in `attribution.db` | Pending |
| ADR-014 M10 | config, shared-types | `factory.yaml` `telegram` section with `TelegramConfigSchema` Zod validation. Per-developer notification preferences, quiet hours, severity routing | Pending |
| ADR-015 (revised) | factory-core, shared-types | New types: `ActionScore`, `SessionComposite`, `ConfidenceDeclaration`, `LearningRecord`, `PatternKnowledge`. Remove: `CreditEvent`, `CapabilityTier` (Growth only). New `performance/` and `learning/` modules in factory-core | Pending |
| ADR-015 (revised) | factory-core | Learning context injection via `learning-middleware` adds ~500 tokens to overlay. Replaces direct `overlay.ts` injection | Pending |
| ADR-015 (revised) | factory-core, hooks | Hook Pipeline reads agent tier from `pipeline.db` `tier_assignments` table (Growth). MVP: all agents at Tier 2 enforcement | Pending |
| ADR-015 (revised) | factory-core | 6 new tables in `pipeline.db`: `action_scores`, `confidence_declarations`, `session_composites`, `learning_records`, `pattern_knowledge`, `overlay_effectiveness`. Growth adds: `elo_ratings`, `tier_assignments`, `rating_epochs` | Pending |
| ADR-015 (revised) | dashboard | Performance Overview panel redesigned for MVP data-collection view (no tiers/credits). Growth adds tier badges, ELO charts | Pending |
| ADR-016 (revised) | factory-core | 1 new table in `attribution.db`: `task_checkouts`. Removed: `agent_budgets`, `rate_limit_snapshots` (rate limit tracking moved to Pi SDK internal concern) | Pending |
| ADR-016 (revised) | shared-types | `TaskCheckout` type. Remove: `AgentBudget`, `CreditEvent`, `UpdateBudgetSchema`. Add: `BurnRateProjection` | Pending |
| ADR-017 (revised) | factory-core | `verification/` module with Nyquist verifier AND lightweight continuous verifier. Two execution paths from same must_haves schema | Pending |
| ADR-017 (revised) | factory-core, hooks | Lightweight structural check runs as post-task hook during dev phase. New hook at L3 level (post-task) | Pending |
| ADR-017 (revised) | shared-types | `MustHaves`, `VerificationResult`, `ArtifactCheck`, `KeyLinkCheck`, `LightweightCheckResult` types | Pending |
| ADR-018 (revised) | factory-core | Hook rollback logic for `after_create` failure. Cleanup worktree on failure, set story `failed_setup` | Pending |
| ADR-018 (revised) | factory-core | Hook timeouts dynamically adjusted by circuit breaker (ADR-023). Config reads from runtime-mutable timeout value | Pending |
| ADR-019 (revised) | factory-core | `turn_state` table in `pipeline.db` for crash-safe turn persistence. 1 new table | Pending |
| ADR-019 (revised) | shared-types | `Result<T, E>`, `toResult()`, `toResultAsync()` utility types in shared-types. Used across all async boundaries in turn loop | Pending |
| ADR-019 (revised) | factory-core | Progress velocity extension logic: conditional max_turns extension up to 1.5x hard cap | Pending |
| ADR-020 (revised) | all packages | NO Drizzle ORM. All SQLite access via `bun:sqlite` direct API. Migration files in `factory-core/src/migrations/` | Pending |
| ADR-021 (new) | factory-core | New `middleware/` module with 7 middleware components. Replaces scattered overlay/hook logic with unified before/after pattern | Pending |
| ADR-021 (new) | shared-types | `Middleware`, `MiddlewareContext`, `MiddlewareResult` interfaces | Pending |
| ADR-021 (new) | factory-core | `overlay.ts` refactored: stages 2-6 extracted into middleware components. Stage 1 (system prompt) and Stage 5 (task context) remain direct | Pending |
| ADR-022 (new) | factory-core | New `notifications/` module with MessageBus, Channel interface, TelegramChannel adapter | Pending |
| ADR-022 (new) | messenger | Messenger package unchanged internally. Factory Core wraps it with TelegramChannel adapter | Pending |
| ADR-022 (new) | config | `factory.yaml` gains `notifications.channels` and `notifications.routing` sections | Pending |
| ADR-023 (new) | factory-core | New `health/` module with circuit breaker state machine and subsystem monitor | Pending |
| ADR-023 (new) | shared-types | `HealthState`, `CircuitBreakerConfig`, `SubsystemStatus` types | Pending |
| ADR-023 (new) | dashboard | Vitals strip gains health indicator dot (green/yellow/red) | Pending |
| ADR-023 (new) | factory-core, hooks | All hook timeouts read from runtime-mutable config adjusted by circuit breaker | Pending |

---

## Single Source of Truth Resolution

Session 7 identified multiple sources of truth for the same data (CONS-001, CONS-002, FAIL-001). This section establishes definitive ownership.

### State Ownership Matrix

| Data | Source of Truth | Storage | Owner | Readers |
|------|----------------|---------|-------|---------|
| Story state, phase state | `pipeline.db` | SQLite WAL | Factory Core | Dashboard, hooks |
| Action scores | `pipeline.db` `action_scores` | SQLite WAL | Factory Core (performance module) | Dashboard, learning middleware |
| Session composites | `pipeline.db` `session_composites` | SQLite WAL | Factory Core | Dashboard |
| Learning records | `pipeline.db` `learning_records` | SQLite WAL | Factory Core (learning module) | Overlay composition (learning middleware) |
| Pattern knowledge | `pipeline.db` `pattern_knowledge` | SQLite WAL | Factory Core | Overlay composition (learning middleware) |
| Turn state | `pipeline.db` `turn_state` | SQLite WAL | Factory Core (turn continuation) | Dashboard |
| ELO ratings (Growth) | `pipeline.db` `elo_ratings` | SQLite WAL | Factory Core | Dashboard, routing |
| Tier assignments (Growth) | `pipeline.db` `tier_assignments` | SQLite WAL | Factory Core | Hook pipeline, dashboard |
| Cost attribution | `attribution.db` `cost_events` | SQLite WAL | Factory Core (economics) | Dashboard, budget middleware |
| Task checkouts | `attribution.db` `task_checkouts` | SQLite WAL | Factory Core | Dashboard |
| Agent sessions | `sessions.db` | SQLite WAL | Overstory | Factory Core (reads), dashboard |
| Inter-agent mail | `mail.db` | SQLite WAL | Overstory | Factory Core (reads) |
| Event store | `events.db` | SQLite WAL | Overstory | Gateway (SSE polling), dashboard |
| Agent metrics | `metrics.db` | SQLite WAL | Overstory | Factory Core (reads), dashboard |
| Messenger dialogues | `messenger.db` | SQLite WAL | Messenger package | Factory Core (reads) |
| Mulch domain expertise | `.mulch/` filesystem | Markdown | Overstory | Overlay composition (learning middleware) |
| Factory config | `factory.yaml` | YAML | Developer | Factory Core (read-once-at-startup, frozen) |

### YAML Files Are Read-Only Exports

The following files are generated on-demand from SQLite and NEVER written to directly:

| File | Generated From | Trigger |
|------|---------------|---------|
| `.qds/performance/export/action-scores.yaml` | `pipeline.db` `action_scores` | Dashboard export button, CLI command |
| `.qds/performance/export/session-composites.yaml` | `pipeline.db` `session_composites` | Dashboard export button, CLI command |
| `.qds/performance/export/elo-ratings.yaml` (Growth) | `pipeline.db` `elo_ratings` | Dashboard export button, CLI command |
| `.qds/performance/export/tiers.yaml` (Growth) | `pipeline.db` `tier_assignments` | Dashboard export button, CLI command |

These exports exist for human inspection and debugging. They are `.gitignore`d. They are never read by any Factory Core component.

### factory.yaml Is Read-Once-at-Startup Frozen Config

`factory.yaml` is read once at Factory Core startup, validated with Zod, and frozen via `Object.freeze()`. No component modifies it at runtime. Changes to `factory.yaml` require Factory Core restart.

**Exception:** The circuit breaker (ADR-023) modifies runtime timeout values. These are NOT stored in `factory.yaml`. They are runtime-only overrides that reset to `factory.yaml` values when the circuit breaker returns to CLOSED state. The override mechanism is a separate in-memory config layer, not a `factory.yaml` mutation.

---

## Epic-Level Context Architecture

### Problem

When Factory Core manages an epic (multiple related stories), each story benefits from knowledge accumulated during previous stories in the same epic. Without explicit epic context management, Story 5 of an epic starts from scratch without knowing what architectural decisions, integration points, and patterns were established in Stories 1-4.

### Decision

Factory Core maintains epic-level context in `pipeline.db` and assembles it into the overlay for each story within an epic.

### pipeline.db Schema -- Epic Tables

```sql
CREATE TABLE epics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  story_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array, ordered
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'paused')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT
);

CREATE TABLE epic_context (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  epic_id TEXT NOT NULL REFERENCES epics(id),
  story_id TEXT NOT NULL,  -- which story produced this context
  context_type TEXT NOT NULL CHECK (context_type IN (
    'architectural_decision',
    'integration_point',
    'pattern_established',
    'convention_adopted',
    'learning_extracted',
    'dependency_introduced'
  )),
  summary TEXT NOT NULL,  -- one-line summary for overlay injection
  detail TEXT,            -- full detail for drill-down
  files_affected TEXT,    -- JSON array of file paths
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_epic_context_epic ON epic_context(epic_id, story_id);
```

### Epic Context Assembly

When spawning agents for Story N of an epic, Factory Core's overlay composition includes accumulated epic context from Stories 1 through N-1:

1. **Query:** `SELECT * FROM epic_context WHERE epic_id = ? AND story_id IN (stories 1..N-1) ORDER BY created_at`
2. **Assemble:** Group by `context_type`, format as structured sections
3. **Token budget:** Epic context allocated from the 50% rule (FR155). If the epic has accumulated more context than fits in the token budget, prioritize by recency and relevance (context touching files that the current story will modify gets priority).
4. **Inject:** Via `learning-middleware` (ADR-021) `beforeModel()` phase

### Epic Context Extraction

After each story completes, Factory Core extracts epic context:

1. **From transfer manifest:** Architectural decisions, integration points established
2. **From learning records:** Patterns and conventions that emerged
3. **From VERIFICATION.md:** Must-haves patterns that proved effective
4. **Storage:** Written to `epic_context` table with the completing story's ID

### Performance Requirements

- **Epic context assembly latency:** <=500ms (SQLite queries + formatting)
- **Epic context token budget:** Dynamically allocated from the 50% rule. With a 100K context model at 50% utilization (50K available), epic context gets up to 5K tokens (10% of available). With accumulated context exceeding 5K tokens, summarization is applied (LLM call, amortized across stories).

### Integration Points

| Integration | Direction | What Flows |
|------------|-----------|-----------|
| Story completion -> epic_context | In | Extracted decisions, patterns, integration points |
| epic_context -> learning-middleware | Out | Accumulated context injected into overlay for next story |
| pipeline.db epics table -> Dashboard | Out | Epic progress visualization |
| Epic context -> must_haves (ADR-017) | Influences | Earlier story patterns inform later story verification |

---

## Implementation Patterns & Consistency Rules

**Party Mode Round:** 8 — Amelia (Developer), Bob (Scrum Master), Barry (Quick Flow Solo Dev). All patterns unanimous.

**Enforcement philosophy:** Patterns are not enforced by convention or documentation. They are enforced by **hooks, gate scripts, skills, linting rules, and overlay injection** — the same mechanisms Superpowers, Overstory, and the hook pipeline use. An unenforced pattern is an unpattern.

### Enforcement Mechanism Mapping

| Pattern Category | Enforcement Mechanism |
|---|---|
| Naming conventions (files, DB, code) | Biome lint rules + L2 per-task gate script (naming checker) |
| Import/export patterns | TypeScript `isolatedModules` + Biome `noDefaultExport` rule + barrel validation gate |
| Zod/type co-location | L2 gate script: any `shared-types` file with `interface` but no corresponding `z.object` → warning |
| Async discipline | Biome `noFloatingPromises` + L2 gate: `async` functions without `await` → warning |
| Component prop patterns | Biome custom rule or L2 gate: inline object literals in JSX → warning |
| Config access | TypeScript compiler: `factory.yaml` import paths outside `config.ts` → type error (no yaml parser exported elsewhere) |
| Git conventions | Factory Core git module: branch naming and commit format enforced at creation, not at review |
| File size (<500 LOC) | L2 gate script: file exceeds 500 lines → warning, 750 → fail |

### Naming Conventions

**Database (SQLite):**
- Tables: `snake_case`, plural — `events`, `sessions`, `pipeline_runs`, `attribution_entries`
- Columns: `snake_case` — `run_id`, `agent_name`, `created_at`
- Indexes: `idx_{table}_{column}` — `idx_events_run_id`
- Matches Overstory's existing schema conventions across all 5 databases.

**TypeScript code:**
- Files: `kebab-case.ts` — `pipeline-engine.ts`, `gate-runner.ts`
- Classes/interfaces/types: `PascalCase` — `PipelineEngine`, `GateResult`
- Functions/variables: `camelCase` — `getStoryState()`, `ssePollingInterval`
- Constants: `SCREAMING_SNAKE_CASE` — `MAX_RETRY_COUNT`, `DEFAULT_POLLING_MS`
- React components: `PascalCase.tsx` — `StoryCard.tsx`, `AgentPanel.tsx`
- Test files: `{source-file}.test.ts`, colocated

**Events (Overstory EventStore):**
- `snake_case` — `tool_start`, `session_end`, `hook_result`, `phase_transition`, `stall_detected`

**JSON field naming:**
- TypeScript-side: `camelCase` — `storyId`, `agentName`
- SQLite columns: `snake_case` — `story_id`, `agent_name`
- Translation at query boundary via thin mapping function, not ORM

**Timestamps:** ISO 8601 everywhere — `2026-03-03T14:30:00.000Z`. Storage, JSON, display source. No Unix timestamps, no locale-dependent formats.

### Import & Export Patterns

**Imports:**
- Workspace packages: by name — `import { GateResult } from "shared-types"`
- Intra-package: relative — `import { validate } from "./validation"`
- Vendor: by path — `import { findSkillsInDir } from "../../vendor/superpowers/lib/skills-core.js"`
- Type-only: `import type { ... }` for all type-only imports — enforced by `isolatedModules`
- No `@qds/` scope prefix

**Exports:**
- Named exports only. No default exports. Enforced by Biome `noDefaultExport` rule.
- One `index.ts` barrel file per package — this is the public API surface.
- `export type` for pure type re-exports in barrel files.
- Non-barrel exports are package-internal. If it's not in `index.ts`, consumers can't import it.

### Zod Schema Pattern

Zod schemas are the **source of truth** for all shared contracts. TypeScript types derived via `z.infer<>`. Schema and inferred type co-located in the same file in `shared-types`.

```typescript
// packages/shared-types/src/commands.ts
import { z } from "zod";

export const NudgeCommandSchema = z.object({
  type: z.literal("nudge_agent"),
  commandId: z.string().uuid(),
  agentId: z.string(),
  message: z.string().min(1).max(2000),
});
export type NudgeCommand = z.infer<typeof NudgeCommandSchema>;

export const DashboardCommandSchema = z.discriminatedUnion("type", [
  NudgeCommandSchema, StopStorySchema, AdjustBudgetSchema,
  PhaseTransitionSchema, CopilotAskSchema, CopilotInvestigateSchema,
  CopilotSuggestSchema,
]);
export type DashboardCommand = z.infer<typeof DashboardCommandSchema>;
```

Consumers import the **type** for compile-time checking and the **schema** only at validation boundaries (WS message handler, gate script stdout parser).

Cross-package function return types must exist in `shared-types` before use. No ad-hoc result types at package boundaries.

### Async Discipline

| Context | Sync/Async | Rationale |
|---|---|---|
| SQLite operations (`bun:sqlite`) | **Sync** | Native sync API, optimized for Bun's event loop |
| Subprocess (`Bun.spawn()`) | **Async** | Process lifecycle is inherently async |
| SSE/WS route handlers | **Async** | I/O-bound, Express async handlers |
| Zustand store `set()` calls | **Sync** | State mutations are synchronous. Async logic lives outside `set()`. |
| React event handlers calling store | **Async wrapper, sync set** | `async onClick → await wsClient.send() → store.getState().update()` |

No `async` on functions that don't `await` anything. Enforced by lint rule.

### Configuration Access

`factory.yaml` read once at startup, Zod-validated, frozen singleton:

```typescript
// packages/factory-core/src/config.ts
const raw = parse(readFileSync("factory.yaml", "utf8"));
export const config: FactoryConfig = Object.freeze(FactoryConfigSchema.parse(raw));
```

- Single file reads `factory.yaml`. No other module touches the filesystem for config.
- Tests mock the config module via `mock.module()`.
- Malformed config → crash at startup with Zod error. Fail fast.

### Dashboard Component Patterns

- Props interface: `{Component}Props` — `StoryCardProps`, `AgentPanelProps`
- No prop drilling beyond 2 levels. Use `useStore(selector)` for deeper data.
- Event handler props: `on` prefix — `onExpand`, `onNudge`, `onDismiss`
- No inline object/array literals in JSX props — causes unnecessary re-renders on SSE-driven dashboards. Use `useMemo` for computed values.
- Children prop only for layout components. Feature components receive data via props.

### Git Conventions (Factory-Managed)

- Branch: `qds/{storyId}/{phase}` — `qds/story-14/dev`, `qds/story-14/review`
- Commit: `[{storyId}][{phase}] {message}` — `[story-14][dev] implement user auth endpoint`
- Attribution: `Co-Authored-By: {agentName} <agent@qds.local>` trailer
- Enforced by Factory Core's git operations module at branch/commit creation time. Not by convention.

### SSE/WS Communication Formats

**SSE (outbound):**
```
id:{event_id}\nevent:{event_type}\ndata:{json_payload}\n\n
```
JSON payload uses `camelCase` keys.

**WS commands (inbound):**
```json
{ "type": "snake_case_command", "commandId": "uuid", ...params }
```

**WS responses (outbound):**
```json
{ "type": "command_ack|command_result|command_partial|command_error", "commandId": "uuid", ...data }
```

### Error Handling

- Backend: errors as typed results, not thrown exceptions. `GateResult.status: 'fail'` is a valid outcome. Exceptions reserved for infrastructure failures (disk full, DB locked).
- Frontend: React error boundaries at StoryDetail and CopilotPanel level. Dashboard shell never crashes.
- Copilot: graceful error responses per UX spec — "I don't have enough data" / "Failed to send nudge" / "I'm having trouble connecting."
- Logging: structured JSON via Overstory logger pattern. Credential sanitization via `sanitizer.ts`. Never log raw API responses.

### State Management (Zustand)

- Slice pattern: `storiesSlice`, `agentsSlice`, `factoryVitalsSlice`, `copilotSlice`, `notificationsSlice`
- Immutable updates via spread (Zustand default). Never mutate state directly.
- SSE → Zustand bridge: single `EventSourceManager` dispatches to slices via discriminated union switch on `event_type`.
- Loading flags: per-slice (`storiesSlice.loading: boolean`). No global loading state.
- Selectors: components subscribe via `useStore(selector)`. Selector extracts the minimum data the component needs.

### Retry & Recovery

- SSE: auto-reconnect with exponential backoff (ZeroClaw carry-forward). Max 500 events on reconnect, then snapshot fallback.
- WS: auto-reconnect with session persistence (ZeroClaw carry-forward).
- Gate scripts: configurable timeout per-layer. SIGTERM → 5s → SIGKILL. Result: DEGRADED.
- LLM API: no retry at gateway level. Factory Core circuit breaker handles failures.
- File size: 500 lines warning, 750 lines fail (L2 gate).

---

## Project Structure & Boundaries

**Party Mode Round:** 9 — Amelia (Developer), Barry (Quick Flow Solo Dev), Winston (Architect). 9 structural findings, all unanimous.

### Complete Project Directory Structure

```
qds-engineer/                              # monorepo root (ADR-001)
├── package.json                           # workspaces: ["packages/*"]
├── bun.lock                               # Bun lockfile
├── bunfig.toml                            # root Bun config
├── tsconfig.json                          # base TS config + paths aliases
├── biome.json                             # Biome lint/format config
├── .gitignore                             # .qds/, coverage/, node_modules/, etc.
├── .github/
│   └── workflows/
│       └── ci.yml                         # 3-stage CI (ADR-012)
├── config/
│   ├── factory.yaml                       # runtime configuration (Step 5)
│   └── schemas/
│       └── manifest-learnings.schema.json # JSON Schema (ADR-006 5b)
├── scripts/
│   └── aggregate-coverage.ts              # coverage aggregation (ADR-012 T1)
├── vendor/
│   └── superpowers/                       # read-only, NOT a workspace member (ADR-013)
│       ├── lib/
│       │   └── skills-core.js             # 5 functions consumed by Factory Core
│       └── skills/                        # 14 skill files
├── .qds/                                  # runtime, .gitignored
│   ├── pipeline.db                        # SQLite WAL (ADR-003)
│   ├── attribution.db                     # SQLite WAL (ADR-005)
│   ├── messenger.db                       # SQLite WAL (ADR-014 M6)
│   └── ws-token                           # startup-generated (ADR-009 G5)
│
├── packages/
│   ├── shared-types/                      # pure types + Zod schemas (ADR-001)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── bunfig.toml
│   │   └── src/
│   │       ├── index.ts                   # barrel — public API surface
│   │       ├── pipeline.ts                # PipelineRun, PhaseTransition, StageContext
│   │       ├── events.ts                  # SSE event contracts, OverlayStage
│   │       ├── commands.ts                # DashboardCommand, ServerMessage unions
│   │       ├── gates.ts                   # GateContext, GateResult, Finding
│   │       ├── isolation.ts               # IsolationResult, PhaseManifest, CredentialScanResult
│   │       ├── budget.ts                  # Budget, AttributionChain
│   │       ├── superpowers.d.ts           # SkillMetadata, SkillResolution (ADR-013)
│   │       ├── performance.ts             # ActionScore, SessionComposite, LearningRecord (ADR-015)
│   │       ├── must-haves.ts              # MustHaves, VerificationResult (ADR-017)
│   │       ├── result.ts                  # Result<T>, toResult(), toResultAsync() (ADR-019)
│   │       ├── middleware.ts              # Middleware, MiddlewareContext (ADR-021)
│   │       └── health.ts                  # HealthState, CircuitBreakerConfig (ADR-023)
│   │
│   ├── factory-core/                      # pipeline engine (ADR-002)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── bunfig.toml
│   │   ├── gates/                         # L3 gate scripts (ADR-010 H1)
│   │   │   ├── 01-canary-verification.ts
│   │   │   ├── 02-manifest-validation.ts
│   │   │   ├── 03-behavioral-analysis.ts
│   │   │   └── README.md                  # execution order documentation
│   │   └── src/
│   │       ├── index.ts                   # barrel
│   │       ├── config.ts                  # frozen config singleton (Step 5)
│   │       ├── pipeline/
│   │       │   ├── engine.ts              # pipeline state machine
│   │       │   ├── phase-transition.ts    # phase boundary orchestration
│   │       │   ├── stage-context.ts       # overlay composition stages
│   │       │   ├── task-checkout.ts       # atomic task checkout (ADR-016)
│   │       │   └── turn-continuation.ts   # turn loop with velocity check (ADR-019)
│   │       ├── economics/
│   │       │   ├── budget-tracker.ts      # budget enforcement (ADR-005)
│   │       │   ├── attribution.ts         # attribution chain (ADR-005)
│   │       │   ├── credential-manager.ts  # programmatic init (ADR-008)
│   │       │   └── cost-queries.ts        # cost aggregation, burn rate (ADR-016)
│   │       ├── hooks/
│   │       │   ├── gate-runner.ts         # Bun.spawn() gate execution (ADR-010)
│   │       │   └── hooks-deployer.ts      # L1-L2 deployment (carry-forward)
│   │       ├── phase-boundary/
│   │       │   ├── canary.ts              # canary token gen/verify (ADR-007)
│   │       │   ├── manifest.ts            # phase manifest builder (ADR-006)
│   │       │   ├── isolation-checker.ts   # 5-layer verification (ADR-007)
│   │       │   ├── merkle.ts              # adaptive Merkle audit (ADR-007)
│   │       │   └── scoped-mail-client.ts  # PhaseScopedMailClient (ADR-006)
│   │       ├── middleware/                    # bidirectional middleware chain (ADR-021)
│   │       │   ├── types.ts               # Middleware interface definitions
│   │       │   ├── chain.ts               # MiddlewareChain executor
│   │       │   ├── budget.ts              # Budget check + cost recording
│   │       │   ├── credential.ts          # Credential injection + sanitization
│   │       │   ├── learning.ts            # Learning query + extraction
│   │       │   ├── enforcement.ts         # Rule injection + gate logging
│   │       │   ├── skill.ts               # Skill description injection
│   │       │   └── verification.ts        # Must-haves injection + structural check
│   │       ├── notifications/                 # multi-channel notifications (ADR-022)
│   │       │   ├── channel.ts             # Channel interface + message types
│   │       │   ├── message-bus.ts         # Pub/sub message routing
│   │       │   └── channels/
│   │       │       ├── telegram-channel.ts # TelegramChannel adapter
│   │       │       └── webhook-channel.ts  # Generic webhook channel
│   │       ├── health/                        # system health (ADR-023)
│   │       │   ├── circuit-breaker.ts     # Circuit breaker state machine
│   │       │   └── subsystem-monitor.ts   # Error signal collection
│   │       ├── performance/                   # performance scoring (ADR-015)
│   │       │   ├── action-scorer.ts       # Action score computation
│   │       │   ├── confidence.ts          # Confidence calibration tracking
│   │       │   ├── session-composite.ts   # Session composite aggregation
│   │       │   ├── elo.ts                 # ELO rating computation (Growth)
│   │       │   └── tiers.ts              # Tier evaluation with hysteresis (Growth)
│   │       ├── learning/                      # learning system (ADR-015)
│   │       │   ├── record-extractor.ts    # Learning record creation
│   │       │   ├── pattern-miner.ts       # Cross-story pattern mining (Growth)
│   │       │   └── overlay-injector.ts    # Learning injection into overlay
│   │       ├── verification/                  # continuous verification (ADR-017)
│   │       │   ├── nyquist.ts             # Full Nyquist verifier
│   │       │   ├── lightweight-check.ts   # Filesystem-only structural checker
│   │       │   ├── oscillation-detector.ts # Fix-loop false negative detection
│   │       │   └── templates/
│   │       │       └── VERIFICATION.md    # verification report template
│   │       ├── worktree/                      # workspace lifecycle (ADR-018)
│   │       │   └── lifecycle-hooks.ts     # 4-point workspace lifecycle hooks
│   │       ├── migrations/                    # SQL migration scripts (ADR-020)
│   │       └── sanitizer.ts               # credential sanitization (ADR-008)
│   │
│   ├── gateway/                           # SSE + WS + CopilotKit (ADR-009, ADR-011)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── bunfig.toml
│   │   └── src/
│   │       ├── index.ts                   # barrel
│   │       ├── app.ts                     # Express app factory (ADR-011 G1)
│   │       ├── gateway.ts                 # entry point: import app, listen
│   │       ├── sse/
│   │       │   ├── poller.ts              # EventStore polling (ADR-009 G2)
│   │       │   └── stream.ts             # SSE response stream (ADR-009 G1)
│   │       ├── ws/
│   │       │   ├── handler.ts             # command dispatch (ADR-009 G4)
│   │       │   ├── auth.ts                # origin + token auth (ADR-009 G5)
│   │       │   └── commands.ts            # per-command handlers
│   │       ├── copilot/
│   │       │   └── runtime.ts             # CopilotRuntime + OpenAIAdapter (ADR-011 G1)
│   │       └── mock/
│   │           ├── fake-events.ts         # mock SSE for dev (ADR-009)
│   │           └── fake-handler.ts        # mock WS responses
│   │
│   ├── messenger/                         # Telegram bot (ADR-014)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── bunfig.toml
│   │   └── src/
│   │       ├── index.ts                   # barrel
│   │       ├── outbound/
│   │       │   ├── formatter.ts           # event → MarkdownV2 (ADR-014 M3)
│   │       │   ├── throttle.ts            # quiet hours, DND, batch (ADR-014 M7)
│   │       │   └── summary.ts             # morning summary (ADR-014 M7)
│   │       ├── inbound/
│   │       │   ├── auth.ts                # registration + user_id mapping (ADR-014 M5)
│   │       │   ├── commands.ts            # 12-command dispatcher (ADR-014 M5)
│   │       │   ├── callbacks.ts           # inline keyboard handler (ADR-014 M5)
│   │       │   └── nl-router.ts           # NL intent classification (ADR-014 M5)
│   │       ├── dialogue/
│   │       │   ├── store.ts               # pending_dialogues SQLite (ADR-014 M6)
│   │       │   ├── manager.ts             # timeout + default actions (ADR-014 M6)
│   │       │   └── dedup.ts              # question deduplication (ADR-014 M6)
│   │       └── sync/
│   │           ├── event-poller.ts        # EventStore consumer (ADR-014 M1)
│   │           ├── action-bridge.ts       # Telegram → factory command (ADR-014 M4)
│   │           └── idempotency.ts         # escalation_id dedup (ADR-014 M4)
│   │
│   └── dashboard/                         # React + Vite (ADR-001)
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts                 # build + dev proxy
│       ├── vitest.config.ts               # test config (ADR-012 T2)
│       ├── tailwind.config.ts             # theme tokens (UX spec)
│       ├── postcss.config.js              # Tailwind PostCSS
│       ├── index.html                     # Vite entry
│       ├── tests/
│       │   └── setup.ts                   # happy-dom + RTL global setup
│       └── src/
│           ├── main.tsx                   # React root + CopilotKit provider
│           ├── App.tsx                    # layout shell + error boundaries
│           ├── store/
│           │   ├── index.ts               # combined Zustand store
│           │   ├── stories.ts             # storiesSlice
│           │   ├── agents.ts              # agentsSlice
│           │   ├── factory-vitals.ts      # factoryVitalsSlice
│           │   ├── copilot.ts             # copilotSlice
│           │   └── notifications.ts       # notificationsSlice
│           ├── copilot/
│           │   ├── bridge.tsx             # CopilotBridge — headless (ADR-011)
│           │   ├── actions/               # copilot action definitions
│           │   │   ├── navigate.ts        # expandStory, focusAgent
│           │   │   ├── control.ts         # nudgeAgent, stopStory
│           │   │   └── query.ts           # queryStoryDetails
│           │   └── components/
│           │       ├── NudgeConfirmation.tsx  # renderAndWait UI (ADR-011)
│           │       └── ActionIndicator.tsx    # wildcard render (ADR-011)
│           ├── components/
│           │   ├── layout/                # shell, panels, grid
│           │   ├── stories/               # StoryCard, StoryDetail
│           │   ├── agents/                # AgentPanel, AgentStatus
│           │   ├── pipeline/              # PipelineView, PhaseIndicator
│           │   ├── economics/             # BudgetWidget, CostBreakdown
│           │   └── copilot/               # CopilotSidebar wrapper
│           ├── hooks/                     # custom React hooks
│           │   ├── use-sse.ts             # EventSource manager
│           │   └── use-ws.ts              # WebSocket client (ZeroClaw carry-forward)
│           ├── lib/
│           │   └── ws-client.ts           # WS client class (146 LOC carry-forward)
│           └── styles/
│               └── globals.css            # Tailwind base + custom tokens
│
├── tests/                                 # monorepo-level tests (ADR-012)
│   ├── integration/                       # cross-package seam tests (T3)
│   │   ├── factory-to-overstory.test.ts
│   │   ├── factory-to-gateway.test.ts
│   │   ├── gateway-to-dashboard.test.ts
│   │   ├── hook-runner-to-gates.test.ts
│   │   ├── messenger-to-dashboard.test.ts     # ADR-014 dual-channel sync
│   │   ├── dashboard-to-messenger.test.ts     # ADR-014 dual-channel sync
│   │   └── dual-channel-race.test.ts          # ADR-014 concurrent resolution
│   ├── phase-boundary/                    # Quinn's 33-file suite (T4)
│   │   ├── canary/
│   │   ├── manifest/
│   │   ├── credential/
│   │   ├── behavioral/
│   │   └── isolation/
│   ├── e2e/                               # full pipeline (T5)
│   │   ├── happy-path.test.ts
│   │   ├── budget-breach.test.ts
│   │   ├── stall-recovery.test.ts
│   │   └── multi-story.test.ts
│   └── fixtures/                          # shared test data
│       ├── mock-provider.ts               # MockProvider class
│       ├── llm-responses/                 # {agentRole}-{phase}.json
│       ├── manifests/                     # phase manifest samples
│       ├── credentials/                   # fake credential patterns
│       ├── canary/                        # canary token test data
│       ├── events/                        # SSE event streams
│       ├── gate-results/                  # pre-canned GateResult JSON
│       └── telegram-api-mock.ts           # TelegramApiMock (ADR-014 M12)
```

### Architectural Boundaries

**Dependency Direction (compile-time):**

```
shared-types ← factory-core ← gateway
shared-types ← factory-core ← messenger
shared-types ← dashboard
```

- `shared-types` has zero internal dependencies. Pure types + Zod schemas.
- `factory-core` depends on `shared-types`. Depends on `vendor/superpowers` via import (NOT workspace dependency).
- `gateway` depends on `shared-types` and `factory-core`.
- `messenger` depends on `shared-types` and `factory-core` (for config and EventStore access). Parallel to gateway — not dependent on it.
- `dashboard` depends on `shared-types` only. Zero compile-time dependency on `factory-core`, `gateway`, or `messenger`.

**Runtime Communication:**

```
dashboard ↔ gateway (SSE outbound, WS inbound — network boundary, not workspace dependency)
gateway → factory-core (direct import — same process)
messenger → factory-core (direct import — separate process from gateway)
messenger ↔ Telegram API (HTTPS — external network boundary)
factory-core → Overstory (library import — agent orchestration)
factory-core → Pi SDK (library import — model-agnostic runtime)
factory-core → .qds/*.db (SQLite — filesystem boundary)
```

**Package API Surface:**

- Each package exports through a single `index.ts` barrel file. Non-barrel exports are package-internal.
- No package may import from another package's non-barrel exports.
- `vendor/superpowers/` is consumed via `tsconfig.json` path alias: `"superpowers/*": ["./vendor/superpowers/*"]`

**Data Boundaries:**

| Data Store | Owner | Readers | Location |
|---|---|---|---|
| `pipeline.db` | Factory Core | Gateway (SSE poller) | `.qds/pipeline.db` |
| `attribution.db` | Factory Core | Gateway (dashboard queries) | `.qds/attribution.db` |
| `events.db` | Overstory | Gateway (SSE poller), Factory Core (hook results) | Overstory-managed |
| `ws-token` | Gateway | Dashboard (startup read) | `.qds/ws-token` |
| `messenger.db` | Messenger | Messenger only | `.qds/messenger.db` |
| `factory.yaml` | Config (frozen at startup) | Factory Core, Messenger (telegram section) | `config/factory.yaml` |

**Communication Boundaries:**

| Channel | Protocol | Direction | Boundary |
|---|---|---|---|
| SSE `/events` | HTTP SSE | Gateway → Dashboard | Network (localhost) |
| WS `/ws` | WebSocket | Dashboard ↔ Gateway | Network (localhost) |
| CopilotKit `/api/copilotkit` | HTTP SSE | Dashboard ↔ Gateway | Network (localhost) |
| Gate scripts | stdin/stdout JSON + exit codes | Factory Core → child process | Process boundary |
| Overstory agents | `ov sling` | Factory Core → tmux sessions | Process boundary |
| Telegram webhook | HTTPS POST | Telegram API → Messenger | Network (external) |
| Telegram Bot API | HTTPS | Messenger → Telegram API | Network (external) |

### Requirements to Structure Mapping

| FR Range | Primary Location | Secondary |
|---|---|---|
| FR001-FR004 (Story intake) | `factory-core/src/pipeline/` | `shared-types/src/pipeline.ts` |
| FR005-FR009 (Task decomposition) | `factory-core/src/pipeline/` | — |
| FR010-FR019 (Dev pipeline) | `factory-core/src/pipeline/` | `factory-core/gates/` |
| FR020-FR029 (Phase boundaries) | `factory-core/src/phase-boundary/` | `shared-types/src/isolation.ts` |
| FR030-FR039 (Review pipeline) | `factory-core/src/hooks/` | `factory-core/gates/` |
| FR040-FR049 (QA pipeline) | `factory-core/src/hooks/` | — |
| FR050-FR059 (PR generation) | `factory-core/src/pipeline/` | — |
| FR060-FR069 (Economics) | `factory-core/src/economics/` | `shared-types/src/budget.ts` |
| FR070-FR079 (Dashboard views) | `dashboard/src/components/` | `dashboard/src/store/` |
| FR080-FR089 (Dashboard controls) | `dashboard/src/components/` | `gateway/src/ws/` |
| FR090-FR099 (Real-time updates) | `gateway/src/sse/` | `dashboard/src/hooks/` |
| FR100-FR104 (Gateway) | `gateway/src/` | `shared-types/src/commands.ts` |
| FR105-FR119 (Copilot) | `dashboard/src/copilot/` | `gateway/src/copilot/` |
| FR120-FR129 (Developer Comms) | `messenger/src/` | `shared-types/src/telegram.ts`, `shared-types/src/notifications.ts` |
| NFR001-NFR019 (Non-functional) | Cross-cutting | `tests/`, `.github/workflows/ci.yml` |

### File Organization Patterns

**Configuration files** reside at their conventional locations: `biome.json`, `tsconfig.json`, `bunfig.toml` at root. Per-package overrides in each `packages/*/` directory. Runtime config in `config/factory.yaml`.

**Source code** follows package-per-concern: `shared-types` (contracts), `factory-core` (engine), `gateway` (transport), `dashboard` (UI). Each package has `src/` with feature subdirectories. No flat file dumps — subdirectories when >3 related files.

**Test organization** follows the 5-tier strategy (ADR-012): unit tests colocated with source (`*.test.ts`), dashboard component tests in `packages/dashboard/tests/`, integration/boundary/E2E tests at `tests/` monorepo level. Fixtures shared across tiers in `tests/fixtures/`.

**L1-L2 hooks** are NOT in the project tree — they are deployed to `.claude/settings.local.json` at runtime by `hooks-deployer.ts`. L3 gate scripts live in `packages/factory-core/gates/` with numeric prefix ordering.

### Development Workflow Integration

**Dev server:** `bun run dev` starts gateway (Express on port 3001) + Vite dev server (port 5173) with proxy config routing `/api/copilotkit`, `/events`, `/ws` to gateway. Mock mode: `MOCK=true bun run dev:gateway` serves fake events without Factory Core.

**Build:** `bun run build` type-checks all packages (shared-types → factory-core → gateway → dashboard) then builds dashboard via Vite. No separate build step for backend packages — Bun runs TypeScript directly.

**Deployment:** Single-machine deployment. Gateway serves built dashboard static files in production. One process, one port. `.qds/` directory created on first run.

---

## Architecture Validation Results

**Party Mode Round:** 10 — Bob (Scrum Master), Quinn (QA Engineer), Winston (Architect). 6 findings, all unanimous.

### Document Authority Principle

This document specifies **architectural constraints and behavioral contracts**. Implementation details live in code. When this document and code disagree, investigate — one of them is wrong.

Inline code examples in this document are **illustrative of patterns**, not canonical implementations. The canonical source of truth for all interfaces, schemas, and configurations is the codebase itself — specifically the files listed in the Canonical Reference Locations table below. As dependencies mature and implementations evolve, the behavioral contracts in this document remain stable while code adapts.

**Implication for story writing:** Acceptance criteria reference ADR behavioral contracts and constraint parameters, not code snippets from this document. The chain is: Architecture (constraints) → Story AC (behaviors) → Implementation (code) → Tests (verification).

### Coherence Validation

**23 Architecture Decision Records (ADR-001 through ADR-023) across 6 categories:**

**ADR-001 through ADR-014 (original, validated):**

| ADR | Decision | Category | Party Mode Round |
|---|---|---|---|
| ADR-001 | Monorepo Structure — Bun workspace, 4 packages + vendor | Starter Template | Round 1-3 |
| ADR-002 | Factory Core Package Boundary — separate package, explicit dependency | Starter Template | Round 1-3 |
| ADR-003 | Pipeline State Storage — SQLite WAL at `.qds/pipeline.db` | Data Architecture | Elicitation R1-R2 |
| ADR-004 | Overlay Cache Strategy — no cache, cache-ready interface | Data Architecture | Elicitation R1-R2 |
| ADR-005 | Attribution Chain Storage — SQLite WAL at `.qds/attribution.db` | Data Architecture | Elicitation R1-R2 |
| ADR-006 | Phase Boundary Protocol — 5-layer defense | Auth & Security | Round 4 |
| ADR-007 | Context Isolation Testing — in-band canary verification | Auth & Security | Round 4 |
| ADR-008 | Credential Isolation — programmatic init, dual-layer detection | Auth & Security | Round 4 |
| ADR-009 | Gateway Architecture — SSE outbound, WS inbound | API & Communication | Round 5 |
| ADR-010 | Hook Pipeline Architecture — 6-layer, gate scripts via Bun.spawn | API & Communication | Round 5 |
| ADR-011 | Dashboard Copilot — CopilotKit + AG-UI, Express under Bun | Copilot | Round 6 |
| ADR-012 | Testing Strategy — 5-tier, dual runner, 3-stage CI | Testing & Integration | Round 7 |
| ADR-013 | Superpowers Integration — .d.ts declarations, startup cache | Testing & Integration | Round 7 |
| ADR-014 | Developer Communication Layer — Telegram Bot, dual-channel notifications | Developer Communication | Round 8b |

**ADR-024 through ADR-035 (added after session 8 in later amendment files):**

| ADR | Decision | Category | Source Document | Session |
|---|---|---|---|---|
| ADR-024 | Twelve-Factor Operational Conventions — 10 sections covering config, backing services, build/release/run, processes, port binding, concurrency, disposability, dev/prod parity, logs, admin processes | Operations & Deployment | `architecture-v2-session11-twelve-factor.md` | Session 11 |
| ADR-025 | Disambiguation Phase Architecture | Quality Enforcement | `architecture-v2-session12-gap-analysis-amendments.md` | Session 12 (Crandall) |
| ADR-026 | Production-Readiness Gate Extensions (Dependency Hygiene + SAST) | Quality Enforcement | `architecture-v2-session12-gap-analysis-amendments.md` | Session 12 (Crandall) |
| ADR-027 | PR-Level Confidence Score and Self-Assessment Accuracy | Quality Enforcement | `architecture-v2-session12-gap-analysis-amendments.md` | Session 12 (Crandall) |
| ADR-028 | Blast Radius Scorer Architecture | Quality Enforcement | `architecture-v2-session12-gap-analysis-amendments.md` | Session 12 (Crandall) |
| ADR-029 | Confidence-Gated Merge Policy and Domain Trust Governance | Quality Enforcement | `architecture-v2-session12-gap-analysis-amendments.md` | Session 12 (Crandall) |
| ADR-030 | Learning Loop Extensions (Rework Cause Taxonomy + PR Defect Classification) | Learning System | `architecture-v2-session12-gap-analysis-amendments.md` | Session 12 (Crandall) |
| ADR-031 | Mulch Domain and Style Profile Extensions | Learning System | `architecture-v2-session12-gap-analysis-amendments.md` | Session 12 (Crandall) |
| ADR-032 | Observer Dimension Extensions and Operational Metrics | Observability | `architecture-v2-session12-gap-analysis-amendments.md` | Session 12 (Crandall) |
| ADR-033 | Orchestrator Re-Confirmation — overstory retained as agent orchestration base, scope-closed per bias-stripped 135-point rubric (overstory 90, ruflo 54, build-fresh 10). 10 hard invariants re-derived from PRD v2; 11 items reclassified from architectural to implementation-choice mechanism | Orchestration / Foundation | `architecture-v2-session12-amendments.md` | Session 13 |
| ADR-034 | `@claude-flow/guidance` Lift into Factory Core — tiered extraction (tier 1 full lift ~6,922 LOC, tier 2 spike-then-decide, tier 3 defer, tier 4 drop, tier 5 adapter rewrite). MIT-licensed, vendored via `factory-core/THIRD_PARTY_LICENSES.md`. Implemented by Story 1.7. | Enforcement Layer | `architecture-v2-session12-amendments.md` | Session 13 |
| ADR-035 | Hook Engine Dual-Plane Strategy — overstory's `hooks-deployer.ts` edge plane (unchanged) + Factory Core's `factory-core/src/hooks/` in-process plane (~400 LOC clean-room, concepts borrowed from ruflo `@claude-flow/hooks` design, zero code lifted). Reframes ADR-010's 6-layer model as a mechanism under the gated-verification invariant. Implemented inside Story 1.7 as the adapter binding target. | Hook Infrastructure | `architecture-v2-session12-amendments.md` | Session 13 |

**Decision Compatibility:** All 35 ADRs validated for mutual consistency. One amendment (ADR-009 G1 -> ADR-011 G1, `Bun.serve()` -> Express under Bun) is explicitly documented with cascading implications resolved. Session 8 amendments resolve 27 critical/important findings. Session 10 amendments in `architecture-v2-session10-amendments.md` amend ADR-008 and ADR-013 in place. Session 11 added ADR-024 (twelve-factor operational conventions) in `architecture-v2-session11-twelve-factor.md`. Session 13 added ADR-033 (orchestrator re-confirmation, scope-closed), ADR-034 (`@claude-flow/guidance` lift into Factory Core), and ADR-035 (hook engine dual-plane strategy) in `architecture-v2-session12-amendments.md`, and reframed ADR-010's 6-layer model as a dual-plane mechanism under the gated-verification invariant — see the session 13 reframing block inside ADR-010's H1 section above. All 4 additions have been validated against existing ADRs; no contradictory decisions remain. Technology versions are compatible: Bun 1.2.x/1.3.x runtime, CopilotKit `^1.52.1`, Express, SQLite WAL mode (bun:sqlite only, no Drizzle ORM), React 19 + Vite ^7.3.1 + Tailwind 4.

**Pattern Consistency:** Naming conventions, export patterns, Zod-as-source-of-truth, error handling, and state management patterns apply uniformly across all ADRs. Every pattern is mapped to a machine-enforced mechanism (Biome rules, L2 gate scripts, TypeScript compiler, Factory Core git module). No convention-only patterns exist.

**Structure Alignment:** Project tree maps 1:1 to ADR decisions. Package boundaries match the acyclic dependency direction. Gate scripts co-located with Factory Core. Test directories match the 5-tier architecture. Every ADR-referenced file has an explicit location.

### Requirements Coverage Validation

All 160 FRs and 38 NFRs have architectural support. Original 129 FRs and 34 NFRs covered by ADR-001 through ADR-014. New FR130-FR160 and NFR35-NFR38 covered by ADR-015 through ADR-023. See the Requirements Overview table in the Project Context Analysis section for FR-to-ADR mapping.

### Gap Analysis

**Critical gaps: 0**

**Important gaps (2) -- non-blocking, documented for implementation planning:**

1. **Meta-optimization subsystem architecture deferred.** FR77-FR89 (13 FRs) acknowledged as independently deployable plugin subsystem. Interface between Factory Core and meta-optimization is undefined. Storage in `.qds/meta/` noted but schema not specified. ZeroClaw Rust cron engine integration path deferred to Growth. No blocking impact -- core pipeline operates without meta-optimization.

2. **xterm.js agent panel integration unspecified.** FR27/FR44 reference live agent output panels. Dashboard component tree includes `components/agents/` but no ADR covers the agent stdout/stderr → xterm.js terminal multiplexing pattern. The SSE channel carries events; the specific agent-output-to-terminal mapping is an implementation detail, not an architectural decision.

**Nice-to-have gaps (3):**

1. Setup/install script behavior (FR69) — defined by FRs, no architecture decision needed.
2. Chart library (recharts vs visx) — low architectural impact, defer to implementation.
3. PR evidence template format — content defined by FR8/FR52, template structure is implementation detail.

### Failure Mode Analysis Summary

Key failure modes identified through systematic analysis:

| Component | Failure Mode | Severity | Mitigation |
|---|---|---|---|
| ZeroClaw SSE/WS carry-forward | Event type mismatch with Overstory StoredEvent | High | Types come from shared-types package, not inline. Transport plumbing adapted, type layer replaced. |
| Overstory overlay integration | Factory Core's 6-stage pipeline vs template-based generateOverlay() | Critical | Factory Core wraps generateOverlay() as one stage, doesn't replace it. Overstory function preserved. |
| Pi SDK tier mapping | No discrete tiers, models selected by name | High | Tier-to-model mapping references Pi SDK model registry, not hardcoded. Startup validation verifies mapped models exist. |
| Pi SDK attribution chain | Missing developer_id, story_id, phase, agent_id | Critical | Injected via StreamOptions.metadata passthrough, merged post-response. Confirmed viable. |
| Overstory event streaming | Polling-based, not HTTP SSE | High | Gateway provides SSE translation layer. MVP: poll EventStore at 500ms (within 2s NFR). Growth: pub/sub optimization. |
| Factory Core ↔ Overstory coupling | In-place extension creates implicit coupling | Critical | ADR-002: Factory Core is separate package with explicit dependency boundary. |
| Session state collision | Factory Core pipeline state vs Overstory SessionStore | High | Factory Core maintains own pipeline state (separate storage). Overstory SessionStore tracks agent lifecycle only. |
| Budget circuit breaker timing | Pi SDK cost is post-hoc, can't pre-check per call | Medium | Circuit breaker checks cumulative total before agent spawn. Some overshoot on final call is accepted. |

### Code-vs-Contract Finding (Round 10)

**Finding:** The architecture document currently contains inline code examples that will become stale as the codebase matures. Dependencies evolve, APIs change, implementation details shift — embedded code creates a dual source of truth.

**Resolution principle:** Architectural decisions specify behavioral contracts, constraint parameters, and interface references — not implementation code. Code examples are illustrative of patterns only. The codebase is the single source of truth for all implementations.

**Required editorial action:** Replace inline code blocks with behavioral contract specifications. Retain one illustrative example per unique pattern (e.g., one Zod-as-source-of-truth example to show the pattern, not every specific schema). This is a follow-up task after architecture completion, not a blocking concern.

### Canonical Reference Locations

When this document references an interface, schema, or configuration, the canonical implementation lives at:

| Contract | Canonical Location | Architecture Reference |
|---|---|---|
| Pipeline types | `shared-types/src/pipeline.ts` | ADR-003 |
| SSE event contracts | `shared-types/src/events.ts` | ADR-009 G1 |
| Dashboard commands | `shared-types/src/commands.ts` | ADR-009 G4 |
| Gate script interface | `shared-types/src/gates.ts` | ADR-010 H4 |
| Isolation types | `shared-types/src/isolation.ts` | ADR-007 |
| Budget/attribution types | `shared-types/src/budget.ts` | ADR-005 |
| Superpowers declarations | `shared-types/src/superpowers.d.ts` | ADR-013 |
| Gateway server | `gateway/src/app.ts` | ADR-011 G1 |
| CopilotKit runtime setup | `gateway/src/copilot/runtime.ts` | ADR-011 G1 |
| SSE poller | `gateway/src/sse/poller.ts` | ADR-009 G2 |
| WS command handler | `gateway/src/ws/handler.ts` | ADR-009 G4 |
| Gate runner | `factory-core/src/hooks/gate-runner.ts` | ADR-010 H1 |
| Phase boundary | `factory-core/src/phase-boundary/` | ADR-006/007 |
| Credential manager | `factory-core/src/economics/credential-manager.ts` | ADR-008 |
| Config singleton | `factory-core/src/config.ts` | Step 5 |
| Zustand store | `dashboard/src/store/index.ts` | Step 5 |
| CopilotBridge | `dashboard/src/copilot/bridge.tsx` | ADR-011 |
| L3 gate scripts | `factory-core/gates/` | ADR-010 H1 |
| CI pipeline | `.github/workflows/ci.yml` | ADR-012 |
| Backend test config | `packages/*/bunfig.toml` | ADR-012 T1 |
| Dashboard test config | `dashboard/vitest.config.ts` | ADR-012 T2 |
| Mock provider | `tests/fixtures/mock-provider.ts` | ADR-012 T5 |
| Telegram API types | `shared-types/src/telegram.ts` | ADR-014 M2 |
| Notification types | `shared-types/src/notifications.ts` | ADR-014 M3 |
| Telegram config schema | `shared-types/src/config.ts` (TelegramConfigSchema) | ADR-014 M10 |
| Messenger event poller | `messenger/src/sync/event-poller.ts` | ADR-014 M1 |
| Telegram API mock | `tests/fixtures/telegram-api-mock.ts` | ADR-014 M12 |
| Guidance module (lifted) | `factory-core/src/guidance/` | ADR-034 |
| Guidance hook adapter (tier-5 rewrite) | `factory-core/src/guidance/hooks-adapter.ts` | ADR-034 / ADR-035 |
| Factory Core in-process hook engine | `factory-core/src/hooks/` | ADR-035 |
| Third-party license manifest | `factory-core/THIRD_PARTY_LICENSES.md` | ADR-034 |
| Upstream delta tracker | `factory-core/src/guidance/UPSTREAM_DELTA.md` | ADR-034 |
| Performance types | `shared-types/src/performance.ts` | ADR-015 (revised) |
| Action scorer | `factory-core/src/performance/action-scorer.ts` | ADR-015 |
| Confidence tracker | `factory-core/src/performance/confidence.ts` | ADR-015 |
| ELO computation (Growth) | `factory-core/src/performance/elo.ts` | ADR-015 |
| Tier evaluation (Growth) | `factory-core/src/performance/tiers.ts` | ADR-015 |
| Learning record extractor | `factory-core/src/learning/record-extractor.ts` | ADR-015 |
| Pattern miner (Growth) | `factory-core/src/learning/pattern-miner.ts` | ADR-015 |
| Cost queries | `factory-core/src/economics/cost-queries.ts` | ADR-016 |
| Task checkout | `factory-core/src/pipeline/task-checkout.ts` | ADR-016 |
| Nyquist verifier | `factory-core/src/verification/nyquist.ts` | ADR-017 |
| Lightweight checker | `factory-core/src/verification/lightweight-check.ts` | ADR-017 |
| Must-haves schema | `shared-types/src/must-haves.ts` | ADR-017 |
| VERIFICATION.md template | `factory-core/src/verification/templates/VERIFICATION.md` | ADR-017 |
| Workspace lifecycle hooks | `factory-core/src/worktree/lifecycle-hooks.ts` | ADR-018 |
| Turn continuation | `factory-core/src/pipeline/turn-continuation.ts` | ADR-019 |
| Result utility | `shared-types/src/result.ts` | ADR-019 |
| Middleware types | `shared-types/src/middleware.ts` | ADR-021 |
| Middleware chain | `factory-core/src/middleware/chain.ts` | ADR-021 |
| Channel interface | `factory-core/src/notifications/channel.ts` | ADR-022 |
| MessageBus | `factory-core/src/notifications/message-bus.ts` | ADR-022 |
| Circuit breaker | `factory-core/src/health/circuit-breaker.ts` | ADR-023 |
| Health types | `shared-types/src/health.ts` | ADR-023 |
| SQL migrations | `factory-core/src/migrations/` | ADR-020 |
| Performance dashboard | `dashboard/src/views/PerformanceOverview.tsx` | ADR-015 |

### Architecture Completeness Checklist

**Requirements Analysis**
- [x] 160 FRs analyzed and categorized into 19 capability areas (original 129 + 31 new FR130-FR160)
- [x] 38 NFRs analyzed across 4 categories with measurable targets (original 34 + 4 new NFR35-NFR38)
- [x] FR dependency tiers identified (30 "First Story" FRs, ~89 "Full MVP" FRs, 31 new FRs integrated into existing subsystems)
- [x] Scale and complexity assessed (High/Enterprise, 17 named subsystems)
- [x] 7 cross-cutting concerns ranked by architectural forcing weight + 3 new concerns (performance scoring, goal-backward verification, design inspiration integration)
- [x] Technical constraints and source project integration boundaries documented
- [x] Design inspiration mapping from 4 research repos to QDS implementation targets (~2,850 LOC new-write)

**Architectural Decisions**
- [x] 23 ADRs covering all 6 decision categories (original 14 + 6 revised ADR-015 through ADR-020 + 3 new ADR-021 through ADR-023)
- [x] Technology versions pinned where applicable
- [x] Cascading implications documented per category
- [x] Design co-dependencies identified and resolved
- [x] All decisions validated through Party Mode (10 rounds) and Advanced Elicitation (2 rounds) — ADRs 015-020 revised and ADRs 021-023 added in Session 8, pending validation

**Implementation Patterns**
- [x] 10 pattern categories with machine-enforced mechanisms
- [x] Enforcement Mechanism Mapping table (no convention-only patterns)
- [x] Wire formats for SSE and WS specified
- [x] Error handling, retry/recovery, and state management patterns documented

**Project Structure**
- [x] Complete directory tree with 100+ explicitly named files
- [x] 5 workspace packages with internal subdirectory structure (+ performance module in factory-core)
- [x] Package dependency direction (acyclic, compile-time and runtime)
- [x] 6 data stores mapped to owners and readers (performance data in `pipeline.db`, extended `attribution.db`)
- [x] 7 communication channels mapped to protocols and boundaries
- [x] FR → Structure mapping covering all 19 FR categories
- [x] Development workflow (dev, build, deploy) documented

**Validation**
- [x] Decision coherence verified (0 contradictions among ADR-001 through ADR-014; ADR-015 through ADR-023 revised/added in Session 8, pending coherence review)
- [x] Requirements coverage verified (160 FRs, 38 NFRs -- new FRs integrated into existing subsystems + new subsystem #17)
- [x] Gap analysis complete (0 critical, 2 important non-blocking, 3 nice-to-have -- original gaps unchanged; Session 8 ADRs add no new gaps)
- [x] Document authority principle established (behavioral contracts, not code)
- [x] Canonical reference locations table provided

### Architecture Readiness Assessment

**Overall Status:** READY FOR IMPLEMENTATION

**Confidence Level:** High -- 23 ADRs across 6 categories (14 validated + 6 revised + 3 new), 10 multi-agent review rounds + Round 8b + Session 8 adversarial synthesis, 2 advanced elicitation rounds, 0 critical gaps, all enforcement mechanisms machine-enforced. ADRs 015-023 pending Party Mode validation.

**Key Strengths:**
- Every architectural decision validated through multi-perspective debate (Party Mode) with unanimous consensus
- All patterns enforced by hooks, gate scripts, lint rules, or compiler — zero convention-only patterns
- Clean acyclic dependency graph: `shared-types ← factory-core ← gateway`, `shared-types ← factory-core ← messenger`, `shared-types ← dashboard`
- 5-tier test architecture with explicit runners, locations, coverage targets, and CI staging
- Document authority principle prevents spec-code divergence

**Areas for Future Enhancement (non-blocking):**
- Meta-optimization subsystem architecture (plugin interface, cron engine) — independently deployable
- xterm.js terminal multiplexing — implementation detail
- Chart library selection — low architectural impact
- Editorial pass to replace inline code with behavioral contracts per Round 10 finding
- Party Mode validation of ADR-015 through ADR-023 (proposed, pending multi-agent review)
- Design-inspired code integration testing (verify new-write code passes QDS test suite)
- Performance system gaming analysis (verify tier unlock criteria prevent metric manipulation)

---

## Appendix A: Session 7 Finding Resolution Matrix

Every critical finding from Session 7 mapped to its resolution in this document.

| Finding ID | Finding | Resolution | ADR Section |
|-----------|---------|-----------|-------------|
| CONS-001 | Three-way cost/credit/budget tracking split | Killed credit_ledger. Two stores: attribution.db (cost) + pipeline.db (performance) | ADR-016 Section 16.2 |
| CONS-002 | Dual source of truth (YAML + SQLite) | pipeline.db is sole source of truth. YAML = read-only exports | ADR-015 Section 15.3, Single Source of Truth Resolution |
| CONS-003 | Tier 5 eliminates quality gates | L3 phase boundary hooks mandatory for ALL tiers | ADR-018 Section 18.2 |
| CONS-004 | Per-turn Nyquist prohibitively expensive | Per-turn uses lightweight signals only (hook results + filesystem checks) | ADR-019 Section 19.1, ADR-017 Section 17.2 |
| SCOPE-001 | Full 6-layer perf system in MVP not viable | MVP: Layers 1-3 (data collection). Growth: Layers 4-6 (behavioral) | ADR-015 Section 15.2 |
| COMP-001 | No tier demotion criteria | ELO below threshold-50 for 3 consecutive stories triggers demotion | ADR-015 Section 15.8 |
| COMP-009 | No ELO migration strategy | Versioned rating epochs with carried-forward ratings | ADR-015 Section 15.14 |
| COMP-011 | No Nyquist-BMAD disagreement protocol | Nyquist = structural tiebreaker, BMAD = spec tiebreaker | ADR-017 Section 17.6 |
| TRANS-001 | costs.ts 85% Postgres-specific | New-write ~60 LOC in bun:sqlite. Pattern inspiration only | ADR-020 Section 20.2 |
| TRANS-003 | verify.cjs 87% non-verification code | New-write ~150 LOC. Only artifact/key_link verification pattern used | ADR-020 Section 20.2 |
| TRANS-007 | DeerFlow hooks.ts irrelevant (488->0 LOC) | Removed from inventory entirely. Dashboard is new-write | ADR-020 Section 20.1 |
| PERV-001 | Confidence calibration rewards cowards | Resolution requirement: spread across [0.2, 0.9] with rank correlation | ADR-015 Section 15.9 |
| PERV-002 | Meta-optimization can modify scoring | Scoring weights immutable without developer approval | ADR-015 Section 15.12 |
| PERV-003 | Progressive autonomy death spiral | Random audit: 1 in 3 stories for Tier 3+ get full Tier 1 density | ADR-015 Section 15.11 |
| PERV-004 | Token efficiency rewards bad code | Bounded step function: penalties only for >3x median | ADR-015 Section 15.10 |
| PERV-005 | Domain specialization collapse | 15% exploration factor in routing decisions (Growth) | ADR-015 Section 15.12 |
| PERV-009 | Tier boundary thrashing | 50-point hysteresis buffer + 3-story dwell requirement | ADR-015 Section 15.8 |
| PERV-011 | Self-fulfilling tier prophecy | Agent's own tier NOT injected into its overlay | ADR-015 Section 15.12 |
| ECON-001 | Credit economy solves non-existent problem | Credit economy killed. Weighted composite routing in Growth | ADR-016 Section 16.1 |
| ECON-002 | Per-agent budgets create deadlocks | Per-agent budgets killed. Per-story + global budget enforcement | ADR-016 Section 16.1 |
| FAIL-001 | Concurrent ELO writes cause lost updates | All data in SQLite (WAL mode handles locking) | ADR-015 Section 15.3 |
| FAIL-006 | Nyquist false negatives burn fix-loop budget | Oscillation detection: identical gaps on unmodified code = escalate | ADR-017 Section 17.5 |
| FAIL-012 | Asymptotic approach at max_turns | Progress velocity check: extend by 1 if >75% and making progress | ADR-019 Section 19.3 |
| FAIL-015 | Elixir error handling lost in TypeScript port | Defensive error normalization: Result<T> at all async boundaries | ADR-019 Section 19.4 |
| FAIL-018 | Performance crash changes hook enforcement | Fallback to Tier 2 enforcement when performance data unavailable | ADR-015 Section 15.13 |
| FAIL-020 | Multi-system failure from shared resource | System health circuit breaker pauses new stories, doubles timeouts | ADR-023 |
| CONS-011 | Two SQLite access patterns (Drizzle + bun:sqlite) | bun:sqlite only. Drizzle ORM removed | ADR-020 Section 20.3 |

---

## Appendix B: New File Inventory

Files added or modified by Session 8 amendments:

| File | ADR | Purpose | Estimated LOC |
|------|-----|---------|--------------|
| `factory-core/src/performance/action-scorer.ts` | 015 | Action score computation | ~120 |
| `factory-core/src/performance/confidence.ts` | 015 | Confidence calibration tracking | ~80 |
| `factory-core/src/performance/session-composite.ts` | 015 | Session composite aggregation | ~100 |
| `factory-core/src/performance/elo.ts` | 015 | ELO rating computation (Growth) | ~150 |
| `factory-core/src/performance/tiers.ts` | 015 | Tier evaluation with hysteresis (Growth) | ~120 |
| `factory-core/src/learning/record-extractor.ts` | 015 | Learning record creation from fix-loops/maintenance | ~100 |
| `factory-core/src/learning/pattern-miner.ts` | 015 | Cross-story pattern mining (Growth) | ~150 |
| `factory-core/src/learning/overlay-injector.ts` | 015 | Learning injection into overlay context | ~80 |
| `factory-core/src/economics/cost-queries.ts` | 016 | Cost aggregation and burn rate prediction | ~60 |
| `factory-core/src/pipeline/task-checkout.ts` | 016 | Atomic task checkout via attribution.db | ~30 |
| `factory-core/src/verification/nyquist.ts` | 017 | Full Nyquist verifier | ~150 |
| `factory-core/src/verification/lightweight-check.ts` | 017 | Filesystem-only structural checker | ~100 |
| `factory-core/src/verification/oscillation-detector.ts` | 017 | Fix-loop false negative detection | ~60 |
| `factory-core/src/worktree/lifecycle-hooks.ts` | 018 | 4-point workspace lifecycle hooks | ~200 |
| `factory-core/src/pipeline/turn-continuation.ts` | 019 | Turn loop with velocity check | ~180 |
| `factory-core/src/middleware/types.ts` | 021 | Middleware interface definitions | ~40 |
| `factory-core/src/middleware/chain.ts` | 021 | Middleware chain executor | ~60 |
| `factory-core/src/middleware/budget.ts` | 021 | Budget check + cost recording | ~40 |
| `factory-core/src/middleware/credential.ts` | 021 | Credential injection + output sanitization | ~30 |
| `factory-core/src/middleware/learning.ts` | 021 | Learning query + extraction | ~50 |
| `factory-core/src/middleware/enforcement.ts` | 021 | Rule injection + gate logging | ~30 |
| `factory-core/src/middleware/skill.ts` | 021 | Skill description injection | ~20 |
| `factory-core/src/middleware/verification.ts` | 021 | Must-haves injection + lightweight check trigger | ~30 |
| `factory-core/src/notifications/channel.ts` | 022 | Channel interface + message types | ~30 |
| `factory-core/src/notifications/message-bus.ts` | 022 | Pub/sub message routing | ~80 |
| `factory-core/src/notifications/channels/telegram-channel.ts` | 022 | TelegramChannel adapter | ~60 |
| `factory-core/src/notifications/channels/webhook-channel.ts` | 022 | Generic webhook channel | ~40 |
| `factory-core/src/health/circuit-breaker.ts` | 023 | Circuit breaker state machine | ~120 |
| `factory-core/src/health/subsystem-monitor.ts` | 023 | Error signal collection | ~60 |
| `factory-core/src/migrations/` | 020 | SQL migration scripts | ~200 |
| `shared-types/src/performance.ts` | 015 | Performance type definitions | ~80 |
| `shared-types/src/must-haves.ts` | 017 | Must-haves schema + types | ~40 |
| `shared-types/src/middleware.ts` | 021 | Middleware interface types | ~30 |
| `shared-types/src/health.ts` | 023 | Health/circuit breaker types | ~20 |
| `shared-types/src/result.ts` | 019 | Result<T> utility type | ~30 |
| **Total** | | | **~2,850** |

All files are new-write TypeScript following QDS conventions. No transplanted code. Design inspiration sources cited in ADR-020 Section 20.2.

---

## Appendix C: Amended Canonical Reference Locations

Additions to the Canonical Reference Locations table:

| Contract | Canonical Location | Architecture Reference |
|---|---|---|
| Performance types | `shared-types/src/performance.ts` | ADR-015 (revised) |
| Action scorer | `factory-core/src/performance/action-scorer.ts` | ADR-015 |
| Confidence tracker | `factory-core/src/performance/confidence.ts` | ADR-015 |
| ELO computation (Growth) | `factory-core/src/performance/elo.ts` | ADR-015 |
| Tier evaluation (Growth) | `factory-core/src/performance/tiers.ts` | ADR-015 |
| Learning record extractor | `factory-core/src/learning/record-extractor.ts` | ADR-015 |
| Pattern miner (Growth) | `factory-core/src/learning/pattern-miner.ts` | ADR-015 |
| Cost queries | `factory-core/src/economics/cost-queries.ts` | ADR-016 |
| Task checkout | `factory-core/src/pipeline/task-checkout.ts` | ADR-016 |
| Nyquist verifier | `factory-core/src/verification/nyquist.ts` | ADR-017 |
| Lightweight checker | `factory-core/src/verification/lightweight-check.ts` | ADR-017 |
| Must-haves schema | `shared-types/src/must-haves.ts` | ADR-017 |
| Workspace lifecycle hooks | `factory-core/src/worktree/lifecycle-hooks.ts` | ADR-018 |
| Turn continuation | `factory-core/src/pipeline/turn-continuation.ts` | ADR-019 |
| Result utility | `shared-types/src/result.ts` | ADR-019 |
| Middleware types | `shared-types/src/middleware.ts` | ADR-021 |
| Middleware chain | `factory-core/src/middleware/chain.ts` | ADR-021 |
| Channel interface | `factory-core/src/notifications/channel.ts` | ADR-022 |
| MessageBus | `factory-core/src/notifications/message-bus.ts` | ADR-022 |
| Circuit breaker | `factory-core/src/health/circuit-breaker.ts` | ADR-023 |
| Health types | `shared-types/src/health.ts` | ADR-023 |
| SQL migrations | `factory-core/src/migrations/` | ADR-020 |

**Removed from original table:**

| Contract | Reason |
|---|---|
| Credit ledger (`factory-core/src/economics/credit-ledger.ts`) | Credit economy killed (ECON-001) |
| Agent budget schemas (`factory-core/src/economics/agent-budgets.schema.ts`) | Per-agent budgets killed (ECON-002) |
