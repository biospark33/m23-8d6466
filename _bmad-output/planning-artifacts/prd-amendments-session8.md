# PRD Amendment Document -- Session 8

**Date:** 2026-03-10
**Scope:** Resolve all 19 critical Session 7 findings, reframe component relationships, introduce self-learning system, revise FR130-FR160, add FR161-FR171, establish definitive MVP/Growth split, revise NFRs
**Supersedes:** FR130-FR160 as written in the Session 6 PRD, Transplant Inventory appendix, NFR35-NFR38

---

## Section 1: Preamble

### 1.1 Component Reframing

The original PRD described five source projects as libraries consumed by Factory Core. Session 7 revealed that the four research repositories (PaperclipAI, GSD, DeerFlow, Symphony) were treated as transplant sources with inflated LOC claims. This amendment reframes all component relationships definitively.

**Factory Core** is the FOUNDATION. It owns the story/epic-level pipeline engine, phase boundaries, economic governance, the self-learning system, and overlay composition. Everything described in FR130-FR171 lives inside Factory Core.

**Overstory** is a COMPONENT. Factory Core calls into Overstory for agent spawning (ov sling), worktree isolation, 4-tier merge cascade, inter-agent mail, session tracking, and watchdog. Overstory is an existing, proven system that Factory Core orchestrates.

**Pi SDK** is a COMPONENT. Factory Core configures Pi SDK for model-agnostic LLM runtime, tool execution, and per-call cost/token tracking across 18+ providers. Pi handles model selection; Factory Core handles economic governance.

**Superpowers** is a COMPONENT. Factory Core reads skill metadata from Superpowers' read-only configuration for overlay composition and hook enforcement gate definitions.

**Seeds** is a COMPONENT (inside Overstory). Factory Core creates Seeds tasks for each phase's work. Seeds provides task-level tracking.

**ZeroClaw** provides PATTERNS. Its SSE/WS client architecture is carried forward into the Gateway and Dashboard. It is not a runtime dependency.

**Research repositories** (PaperclipAI, GSD, DeerFlow, Symphony) are DESIGN INSPIRATION sources. They are not transplant sources, not dependencies, and not referenced at runtime. We study their patterns, take what fits, and build what is right for our stack. The term "transplant" is retired. All code in QDS v2 is new-write that may be inspired by patterns observed in these repositories.

### 1.2 Self-Learning System Vision

The core innovation of QDS v2 is not the pipeline, not the dashboard, and not the economic governance. The core innovation is a **self-learning system** that makes the factory better at writing code for THIS codebase over time, with the explicit goal of reducing maintenance burden to near-zero.

**Goal 1 (Primary): Code quality improves over time.** Each session produces learnings about the target codebase. The next session's agents write better code, better tests, and cause fewer regressions. The measurable metric is reduction in maintenance burden over time, trending toward zero.

**Goal 2 (Secondary): Harness efficiency improves.** The factory gets cheaper, faster, and lighter in overhead per story. This matters, but it is subordinate to code quality.

**Three learning layers:**

- **Layer 1 -- Codebase Knowledge (per-project):** Facts like "this codebase uses Zod at API boundaries" or "the payments module requires webhook event updates." Enriches Overstory's existing Mulch expertise records with structured learning extracted from fix loops and maintenance patterns. Stored per-project, injected into overlays.

- **Layer 2 -- Pattern Knowledge (cross-story):** Facts like "stories touching the payments module always need webhook updates" or "database migration stories require rollback test coverage." Mined from fix-loop data, review findings, and maintenance agent activity. Stored in `pipeline.db`, injected into overlays for relevant stories.

- **Layer 3 -- Process Knowledge (meta):** Facts like "economy-tier models produce 2x more BMAD findings on database stories" or "overlay token budgets above 4K for scout agents waste tokens without quality gain." Used by Factory Core to tune its own operations. Stored in `pipeline.db`, consumed by meta-optimization and pipeline composition.

### 1.3 Autonomous Merge Philosophy

QDS v2 is designed so that code merges automatically without human oversight. The system is SO good -- adversarial BMAD review with context-isolated fresh agents, 5-wave QA swarm, structural Nyquist verification, fix-loop circuit breakers -- that human review is the exception (escalation), not the rule.

Any residual issues that slip through are caught and fixed by autonomous 24/7 QA and maintenance agents (Growth phase). Every maintenance fix generates a learning record that feeds back into overlay composition, making the next session's overlays richer and the same class of issue less likely to recur.

Human involvement is reserved for: architecture-level decisions (deviation rule R4), circuit breaker escalations, and explicit developer-initiated overrides.

### 1.4 Data Source of Truth

**Resolves: CONS-001, CONS-002**

`pipeline.db` (SQLite) is the single source of truth for all mutable factory state: action scores, session composites, ELO ratings, tier assignments, budget tracking, task checkout locks, learning records, and performance data. YAML files in `.qds/` are read-only exports computed from the database for human inspection and git-based sharing. No component writes to YAML as a primary store.

`attribution.db` (SQLite) is the single source of truth for cost attribution data (FR42). Cost data flows: Pi SDK response -> attribution.db -> pipeline.db aggregates.

---

## Section 2: Revised FR130-FR160

Each FR below states: what it delivers, which component it integrates with, what is genuinely new-write, which Session 7 finding it resolves (if any), MVP or Growth designation, and design inspiration source.

### Agent Performance Data Collection

#### FR130: Action-Level Process Scoring (MVP)

Factory Core computes action-level process scores after each post-task hook execution, storing results in `pipeline.db` table `action_scores`. Each score record contains:

- **Promise** (0.0-1.0): probability estimate of story completion derived from hook pass/fail results, test coverage delta, and lint/type-check status
- **Progress** (-1.0 to 1.0): advancement toward the phase goal measured by files modified, tests added, and checklist items completed

Scores are computed from hook result data already available in the pipeline. No LLM calls. No filesystem YAML writes.

**Component integration:** Reads hook results from Overstory event stream. Writes to `pipeline.db`.
**New-write:** Action score computation module (~150 LOC), `pipeline.db` schema extension (~30 LOC).
**Resolves:** CONS-002 (no YAML files as primary store).
**Design inspiration:** GSD `verify.cjs` artifact validation pattern (structural checking approach).

#### FR131: Confidence Calibration at Phase Boundaries (MVP)

Phase Boundary Protocol transfer manifests include agent confidence declarations (0.0-1.0) that Factory Core validates against historical calibration data on phase completion. Calibration quality is measured by Brier score computed over the agent's last N phase transitions (configurable, default 20).

Confidence declarations must demonstrate resolution: declarations must span the range [0.2, 0.9] with positive rank correlation to actual outcomes. An agent that always declares 0.3 confidence and is right 30% of the time achieves a perfect Brier score but fails the resolution requirement and receives no calibration quality credit.

**Component integration:** Extends Phase Boundary Protocol (FR32). Reads/writes `pipeline.db`.
**New-write:** Calibration computation with resolution check (~120 LOC).
**Resolves:** PERV-001 (confidence calibration no longer rewards base-rate prediction).
**Design inspiration:** DeerFlow `memory/updater.py` confidence scoring approach.

#### FR132: Session-Level Composite Performance Scores (MVP)

Factory Core computes session-level composite scores on story completion, combining:

- Task completion rate (tasks completed / tasks assigned)
- Code quality metrics (lint clean %, test coverage delta, type-check pass rate)
- Token efficiency as bounded step function: no reward for below-median consumption, penalties only for consumption exceeding 3x the rolling median for comparable story complexity
- Fix loop efficiency (BMAD corrections needed / total BMAD findings)
- Hook pass rate (hooks passed first attempt / total hook executions)

Token efficiency uses a bounded step function, not a raw ratio. Scores below the median receive a neutral 0.5. Scores between 1x and 3x median receive 0.5. Scores above 3x median receive a linear penalty from 0.5 down to 0.0. This prevents rewarding terse, unmaintainable code.

Composite scores are stored in `pipeline.db` table `session_scores`. Cost data for the composite is read from `attribution.db` (FR42), not duplicated.

**Component integration:** Reads from `attribution.db` for cost data. Writes to `pipeline.db`.
**New-write:** Composite scoring engine with bounded token efficiency (~200 LOC).
**Resolves:** CONS-001 (no cost data duplication; reads from attribution.db), PERV-004 (bounded step function replaces raw token efficiency).
**Design inspiration:** PaperclipAI `services/costs.ts` cost aggregation pattern.

### Agent Performance Behavioral System

#### FR133: ELO-Style Domain Ratings (Growth)

Factory Core maintains ELO-style ratings per agent role per skill domain (backend-api, frontend-react, database, testing, devops, refactoring). Ratings are adjusted on story completion based on difficulty estimate versus actual outcome, with configurable K-factor (default 32) and recency decay factor.

Difficulty estimation is anchored to objective metrics (file count, test count, dependency count, cyclomatic complexity of touched files), not LLM judgment. This prevents the difficulty estimator from being gamed or hallucinated.

Ratings are stored in `pipeline.db` table `elo_ratings` with epoch versioning (see FR162).

**Component integration:** Reads session composites (FR132) from `pipeline.db`. Writes to `pipeline.db`.
**New-write:** ELO computation module with objective difficulty estimation (~250 LOC).
**Resolves:** PERV-002 (difficulty anchored to objective metrics, not LLM judgment).
**Rationale for Growth:** ELO ratings need 5+ stories per domain to stabilize (SCOPE-001). Collecting data in MVP via FR130-FR132; behavioral effects wait for Growth when data exists.
**Design inspiration:** PaperclipAI agent role taxonomy for domain categorization.

#### FR134: Capability Tier Assignment (Growth)

Factory Core assigns agents to capability tiers (1-5) based on sustained ELO rating, minimum session count, and calibration quality. Tier is stored in `pipeline.db` table `agent_tiers`.

Tier unlock criteria:
- Tier 1: Default (all new agents)
- Tier 2: ELO > 1200, 5 sessions, calibration Brier < 0.2
- Tier 3: ELO > 1350, 15 sessions, calibration Brier < 0.15
- Tier 4: ELO > 1500, 30 sessions, calibration Brier < 0.1
- Tier 5: ELO > 1600, 50 sessions, zero BMAD critical findings in last 10

An agent's own tier level is NOT injected into its working overlay context. The tier controls hook density (FR135) and routing (FR138) but the agent does not know its own tier. This prevents self-fulfilling tier prophecy where high-tier agents become overconfident and low-tier agents waste tokens on excessive caution.

**Component integration:** Reads ELO ratings and calibration data from `pipeline.db`. Writes to `pipeline.db`.
**New-write:** Tier evaluation engine (~100 LOC).
**Resolves:** PERV-011 (agent's own tier not injected into overlay).
**Rationale for Growth:** Depends on FR133 (ELO data); both are Growth.
**Design inspiration:** PaperclipAI `agents.ts` service status transitions, GSD `core.cjs` MODEL_PROFILES tier structure.

#### FR135: Tier-Based Hook Enforcement Density (Growth)

Hook Pipeline enforcement density varies by agent capability tier:
- Tier 1: hooks on every edit
- Tier 2: hooks every 3 tasks
- Tier 3: hooks every 5 tasks
- Tier 4: hooks per phase
- Tier 5: hooks every 3 tasks (same as Tier 2)

**L3 phase boundary hooks are mandatory for ALL tiers.** No agent, regardless of tier, skips phase boundary hooks (test suite, build, lint, type check, manifest validation). This is a non-negotiable quality floor.

When tier data is unavailable (performance system down, new agent with no history), the fallback is Tier 2 enforcement (hooks every 3 tasks). This prevents a performance system failure from silently removing quality gates.

**Component integration:** Reads tier from `pipeline.db`. Configures Overstory hook runner.
**New-write:** Hook density configuration layer (~80 LOC).
**Resolves:** CONS-003 (L3 minimum enforcement for all tiers), FAIL-018 (explicit Tier 2 fallback when tier data unavailable).
**Rationale for Growth:** Depends on FR134 (tier assignments); both are Growth.
**Design inspiration:** GSD `config.cjs` workflow toggle pattern.

#### FR136: KILLED -- Credit Economy

**Status: KILLED.** The credit economy (per-agent credit balances, credit decay, marketplace routing) is eliminated entirely.

**Rationale:** PaperclipAI manages persistent autonomous agents as independent economic actors competing for work. QDS has one LLM provider running transient agent instances. A credit economy for a single-principal system reduces to a sorting function with significant complexity overhead and multiple perverse incentives (ECON-001). Per-agent credit balances with no negative balance policy create undefined behavior (COMP-002).

**Replacement:** FR136 is replaced by a new FR (see FR136-R below) for weighted composite scoring, deferred to Growth.

**Resolves:** ECON-001, COMP-002.

#### FR136-R: Weighted Composite Scoring for Agent Routing (Growth)

When ELO data is available (Growth phase), Factory Core routes stories to agent configurations using a weighted composite score: `(0.5 * domain_ELO_match) + (0.3 * historical_success_rate) + (0.2 * cost_projection)`. Weights are immutable without developer approval in `factory.yaml`.

A 15% exploration factor ensures that agents are occasionally routed work outside their strongest domains, preventing domain specialization collapse where agents only receive work they are already good at.

**Component integration:** Reads ELO ratings and session history from `pipeline.db`. Feeds into Factory Core story assignment.
**New-write:** Routing scorer with exploration factor (~150 LOC).
**Resolves:** ECON-001 (replaces credit economy), PERV-005 (exploration factor prevents specialization collapse).
**Rationale for Growth:** Depends on FR133 (ELO data).
**Design inspiration:** PaperclipAI `services/heartbeat.ts` workspace routing logic (matching pattern, not credit marketplace).

#### FR137: Performance Context in Overlays (Growth)

Overlay injection (Stage 4) includes agent performance context within existing token ceiling (~500 additional tokens):
- Domain ratings with trend indicator (improving/stable/declining)
- Recent calibration accuracy
- Relevant pattern knowledge from Layer 2 learning (FR165)

Performance context does NOT include: the agent's own tier level (PERV-011), credit balance (KILLED), or raw ELO numbers. It includes directional indicators that help the agent understand its relative strengths without enabling gaming.

Scoring weights used by the performance system are immutable -- meta-optimization (FR79-FR83) cannot modify parameters that affect how scores are computed without explicit developer approval in `factory.yaml`.

**Component integration:** Reads from `pipeline.db`. Extends overlay composition (FR28).
**New-write:** Performance context formatter (~80 LOC).
**Resolves:** PERV-002 (scoring weights immutable), PERV-011 (no self-tier injection).
**Rationale for Growth:** Meaningful only when performance data exists from FR130-FR132 collection.
**Design inspiration:** DeerFlow memory injection with max facts + token ceiling.

#### FR138: ELO-Based Story-to-Agent Routing (Growth)

Factory Core routes stories to agent configurations based on domain-specific ELO ratings, matching story file-scope to agent domain strengths via the weighted composite scorer (FR136-R).

**Component integration:** Uses FR136-R scorer. Reads `pipeline.db`.
**New-write:** Story-to-domain classifier (~100 LOC).
**Rationale for Growth:** Depends on FR133 (ELO data) and FR136-R (composite scorer).
**Design inspiration:** PaperclipAI `services/heartbeat.ts` workspace routing logic.

#### FR139: Performance Dashboard Cards (Growth)

Dashboard displays per-agent performance cards showing:
- Domain ratings with sparkline trend indicators
- Calibration curve visualization
- Session history timeline with outcome markers
- Current tier badge (when tier system active)

Empty state guidance: when insufficient data exists, cards show "N stories needed for meaningful metrics" with a progress indicator toward the data threshold.

**Component integration:** Reads from `pipeline.db` via Gateway API. Renders in Dashboard.
**New-write:** Dashboard components (~400 LOC).
**Rationale for Growth:** Needs performance data to display; meaningless at MVP launch.
**Design inspiration:** Symphony `status_dashboard.ex` sparkline algorithms for trend visualization.

### Performance Data Operations

#### FR140: Performance Data Export (MVP)

Performance data (action scores, session composites) can be exported as structured JSON from `pipeline.db` for external analysis and debugging. Export includes: raw action scores with timestamps, session composites with component breakdowns, and story-level summaries.

Export is triggered via CLI command (`qds perf export`) or Dashboard button. Output is written to `.qds/exports/` (gitignored).

**Component integration:** Reads from `pipeline.db`.
**New-write:** Export serializer (~80 LOC).
**Design inspiration:** GSD `state.cjs` cmdStateSnapshot/cmdStateJson pattern.

#### FR141: Manual Tier Override (Growth)

Developer can manually override agent tier assignments via dashboard or CLI. Override is logged in `pipeline.db` activity log with timestamp, previous tier, new tier, and developer rationale. Overrides persist until the next automatic tier evaluation or until manually cleared.

**Component integration:** Writes to `pipeline.db`.
**New-write:** Override handler with audit logging (~60 LOC).
**Rationale for Growth:** Depends on FR134 (tier system).
**Design inspiration:** PaperclipAI `services/activity-log.ts` logging pattern.

### Economic Governance

#### FR142: Per-Story Budget Enforcement (MVP) -- REVISED

**REVISED from "Per-Agent Monthly Budget Caps."**

Factory Core enforces budgets at two levels:
1. **Per-story budget** (FR38, unchanged): halts the story when spend exceeds threshold
2. **Global daily/monthly budget** (FR39, unchanged): pauses all non-critical work when exceeded

Per-role costs (builder, reviewer, scout, coordinator) are tracked in `attribution.db` for visibility and reporting. They are NOT enforcement boundaries. A builder agent is never paused because "the builder budget is exhausted" when the story budget and global budget have headroom.

Per-role cost visibility enables post-hoc analysis ("builders consume 70% of story cost") without creating the deadlock scenarios where a story stalls because one role's budget is exhausted even though overall budget is available.

**Component integration:** Extends FR38/FR39. Reads/writes `attribution.db` and `pipeline.db`.
**New-write:** Per-role cost tracking columns in attribution schema (~40 LOC).
**Resolves:** ECON-002 (eliminates per-agent budget deadlocks).
**Design inspiration:** PaperclipAI `services/costs.ts` budget ceiling checking pattern (enforcement logic, not per-agent fragmentation).

#### FR143: Rate Limit Snapshot Tracking (Growth)

Factory Core tracks rate limit snapshots per session, recording rate limit headers from Pi SDK responses (remaining calls, reset timestamp, token bucket state) for capacity planning and proactive throttling.

**Component integration:** Reads Pi SDK response headers. Writes to `pipeline.db`.
**New-write:** Rate limit tracker (~100 LOC).
**Rationale for Growth:** Capacity planning is a scaling concern, not MVP.
**Design inspiration:** Symphony `orchestrator.ex` token tracking via Codex AppServer events.

#### FR144: Cost-Per-Initiative Rollups (Growth)

Attribution chain (FR42) includes cost-per-initiative rollups linking token spend to story-to-project groupings, enabling cost reporting at the initiative level.

**Component integration:** Reads/writes `attribution.db`.
**New-write:** Initiative rollup aggregator (~80 LOC).
**Rationale for Growth:** Reporting enhancement; MVP cost tracking at story level is sufficient.
**Design inspiration:** PaperclipAI `services/costs.ts` byProject() function.

#### FR145: Atomic Task Checkout (MVP)

Factory Core implements atomic task checkout in `pipeline.db`. When a story is assigned to an agent team, a checkout lock (SQLite row with `claimed_at` timestamp and `claimed_by` agent ID) prevents duplicate assignment. The lock is released when the team completes or when a configurable timeout expires (default: 2x estimated story duration).

Checkout uses SQLite's built-in locking, not filesystem locks. This prevents the concurrent write issues identified in FAIL-001.

**Component integration:** Integrates with Seeds task tracking. Writes to `pipeline.db`.
**New-write:** Checkout lock manager with timeout (~120 LOC).
**Design inspiration:** PaperclipAI `db/schema/agent_wakeup_requests.ts` claimedAt pattern.

#### FR146: Cost Attribution Dashboard (Growth)

Dashboard displays cost-per-initiative breakdowns and per-role cost distribution with spend-over-time visualizations.

**Component integration:** Reads from `attribution.db` via Gateway API.
**New-write:** Dashboard components (~300 LOC).
**Rationale for Growth:** Needs cost history to display meaningfully.

### Orchestration

#### FR147: Per-Phase Concurrency Limits (Growth)

Factory Core enforces per-phase-type concurrency limits (e.g., max 2 concurrent BMAD reviews, max 5 concurrent dev phases) independently of global story concurrency.

**Component integration:** Extends Overstory coordinator. Configured via `factory.yaml`.
**New-write:** Concurrency limiter with per-phase counters (~150 LOC).
**Rationale for Growth:** MVP handles 3-4 concurrent stories; fine-grained concurrency control is a scaling concern.
**Design inspiration:** Symphony `orchestrator.ex` max_concurrent_agents_for_state() pattern.

#### FR148: Workspace Lifecycle Hooks (Growth)

Worktree lifecycle executes structured hooks at 4 points:
1. `after_create`: git clone + environment setup
2. `before_run`: dependency install + verification
3. `after_run`: metric collection + test results capture
4. `before_remove`: cleanup verification + orphan check

Hook scripts are configurable in `factory.yaml`. Hook failure at `before_run` prevents story launch. Hook failure at `before_remove` logs a warning but does not block cleanup (preventing orphaned worktrees from accumulating).

**Component integration:** Extends worktree management (FR40). Hooks execute via Bun.spawn().
**New-write:** Hook runner with 4-point lifecycle (~200 LOC).
**Rationale for Growth:** MVP worktree management (FR40) handles create/cleanup; structured hooks add operational polish.
**Design inspiration:** Symphony `workspace_lifecycle.ex` 4-hook-point pattern.

#### FR149: Turn-Based Continuation Within Phases (MVP) -- SIMPLIFIED

Agents can execute multiple turns within a single phase before triggering phase transition. After each turn, Factory Core evaluates whether the phase goal is achieved using lightweight signals:

- Post-task hook pass/fail results
- Checklist item completion count
- File modification count versus expected scope

These are lightweight, already-available signals -- NOT the full Nyquist verifier (which is prohibitively expensive per-turn). Max turns per phase type is configurable in `factory.yaml` (default: dev=10, bmad=3, qa=5).

Progress velocity check: if the agent made measurable progress in the last turn (files modified, tests added, hooks passing that previously failed) and goal completion is estimated at >75%, Factory Core extends max_turns by 1 (up to a hard cap of max_turns x 1.5). This prevents asymptotic approach failures where a story reaches 89% at max_turns and must restart with a fresh agent.

Turn state is persisted to `pipeline.db` between turns, not held in process memory. A crash mid-turn loses at most one turn of work.

**Component integration:** Extends pipeline execution. Writes turn state to `pipeline.db`.
**New-write:** Turn continuation loop with progress velocity check (~200 LOC).
**Resolves:** CONS-004 (lightweight signals, not full Nyquist per-turn), FAIL-012 (progress velocity extension prevents asymptotic approach).
**Design inspiration:** Symphony `agent_runner.ex` do_run_codex_turns() loop pattern, continuation prompt template.

#### FR150: Automatic Deviation Handling (Growth)

Factory Core implements automatic deviation handling with 4 rules:
- R1: Auto-fix bugs discovered during execution
- R2: Auto-add missing critical functionality
- R3: Auto-fix blocking issues
- R4: Ask developer about architecture changes

All deviations are logged in learning records and tracked in story summary.

**Component integration:** Extends pipeline execution. Writes to `pipeline.db` and learning records.
**New-write:** Deviation handler with 4-rule classifier (~180 LOC).
**Rationale for Growth:** MVP fix loop (FR7) handles BMAD-identified issues; deviation handling extends to self-discovered issues.
**Design inspiration:** GSD SUMMARY.md deviation template, `verify.cjs` cmdVerifySummary().

#### FR151: Wave-Based Epic Decomposition (Growth)

Factory Core decomposes epics into dependency-aware waves. Within-wave stories execute in parallel; between-wave stories execute sequentially. Stories declare wave assignment and dependencies; Factory Core builds a wave index.

**Component integration:** Extends story intake (FR1-FR3). Reads story specs.
**New-write:** Wave index builder with dependency resolver (~250 LOC).
**Rationale for Growth:** MVP handles manual story ordering and basic dependency detection (FR2-FR3).
**Design inspiration:** GSD `phase.cjs` cmdPhasePlanIndex() wave grouping logic.

### Quality Verification

#### FR152: Lightweight Continuous Structural Verification (MVP) -- REVISED

**REVISED from "Goal-Backward Verification (Nyquist Layer)."**

Factory Core runs lightweight structural verification as a post-task hook during development, not only after QA. This verification checks:

- **Artifact existence:** Do files claimed as created/modified actually exist?
- **Content patterns:** Do created files contain expected exports, function signatures, or structural markers defined in the story spec's must_haves?
- **Key integration links:** Do source-to-target references (imports, function calls, route registrations) exist between files that the story spec declares as linked?

This is filesystem-only verification. No LLM calls. Estimated execution time: under 500ms per check. Cost: near zero.

When verification detects structural drift (artifact missing, expected pattern absent), it adds a finding to the agent's current context via mail, allowing course correction within the current turn rather than discovering the gap after BMAD review.

Oscillation detection: if a fix-loop iteration re-runs verification and produces the SAME gap list on code that the fix loop did not modify, the system flags it as a potential false negative and escalates to the developer rather than iterating.

**Component integration:** Runs as post-task hook via Overstory. Reads story spec must_haves. Writes findings via Overstory mail.
**New-write:** Structural verifier with oscillation detection (~300 LOC).
**Resolves:** CONS-004 (filesystem-only, not full Nyquist), FAIL-006 (oscillation detection for false negatives).
**Design inspiration:** GSD `verify.cjs` cmdVerifyArtifacts() + cmdVerifyKeyLinks() structural checking approach.

#### FR153: Structured Verification Report (Growth)

Goal-backward verification produces a structured VERIFICATION.md per story with truths checked (pass/fail), artifacts confirmed, links validated, and gaps identified. This is the full Nyquist verification pass that runs after QA swarm, not during development.

**Component integration:** Runs as post-QA verification step. Writes to story artifacts.
**New-write:** Verification report generator (~150 LOC).
**Rationale for Growth:** Full verification report is a polish feature; FR152 provides the critical structural checking in MVP.
**Design inspiration:** GSD `templates/VALIDATION.md` template structure.

#### FR154: Auto-Remediation from Verification Gaps (Growth)

When full goal-backward verification (FR153) identifies gaps, Factory Core auto-generates remediation plans and feeds them into the fix loop (FR7).

**Component integration:** Extends fix loop (FR7). Reads FR153 verification report.
**New-write:** Gap-to-plan generator (~120 LOC).
**Rationale for Growth:** Depends on FR153 (full verification).
**Design inspiration:** GSD verification-patterns reference doc.

#### FR155: Context Budget 50% Rule (MVP)

Context budget validation (FR30) proactively scopes agent tasks to consume less than 50% of the model's effective context window, leaving room for tool responses, iteration, and hook execution.

The 50% rule uses an absolute token minimum floor: regardless of model context size, the task working space must be at least 8,000 tokens. On models with less than 32K context, the ratio adjusts upward (e.g., 25% for overlay on a 32K model) to guarantee the minimum working space.

**Component integration:** Extends overlay composition (FR28-FR30).
**New-write:** Context budget validator with minimum floor (~60 LOC).
**Design inspiration:** GSD planning references for the 50% heuristic.

### Memory and Learning Enhancements

#### FR156: Confidence-Scored Fact Extraction (Growth)

Learning record synthesis (FR59) extracts structured facts with confidence scores (0.0-1.0) and categories (pattern / pitfall / convention / preference / constraint), using LLM-powered extraction on story completion.

**Component integration:** Extends learning synthesis (FR59). Writes to `pipeline.db`.
**New-write:** Fact extraction with confidence scoring (~250 LOC).
**Rationale for Growth:** LLM-powered extraction is an enhancement over MVP's rule-based synthesis (FR59).
**Design inspiration:** DeerFlow `agents/memory/updater.py` update_memory() approach.

#### FR157: Confidence-Ranked Learning Injection (Growth)

Overlay injection (FR61) ranks synthesized learnings by confidence score (descending) when selecting which learnings fit within the token ceiling. Learnings below configurable confidence threshold (default 0.7) are excluded.

**Component integration:** Extends overlay injection (FR61).
**New-write:** Confidence-ranked selector (~60 LOC).
**Rationale for Growth:** Depends on FR156 (confidence-scored facts).
**Design inspiration:** DeerFlow memory config confidence_threshold + max_injection_tokens.

#### FR158: Per-Agent Memory Profiles (Growth)

Factory Learning System maintains per-agent memory profiles storing work context, behavioral patterns, and known strengths/weaknesses, updated on story completion with debounced writes.

**Component integration:** Writes to `pipeline.db`.
**New-write:** Memory profile manager with debounced writes (~150 LOC).
**Rationale for Growth:** Meaningful only after multiple stories provide behavioral data.
**Design inspiration:** DeerFlow `agents/memory/queue.py` MemoryQueue with per-thread deduplication.

#### FR159: Progressive Skill Loading (Growth)

Skill injection into agent overlays (FR33) loads only skills relevant to the agent's current task scope and role, not the full skill set. Skill matching uses file-scope and role metadata.

**Component integration:** Extends Superpowers skill injection (FR33-FR34). Reads Superpowers skill metadata.
**New-write:** Skill matcher with scope/role filtering (~120 LOC).
**Rationale for Growth:** MVP injects all skills (current behavior); progressive loading is an optimization.
**Design inspiration:** DeerFlow `skills/loader.py` skill discovery + enabled-state filtering.

#### FR160: Action Scores in Learning Records (Growth)

Learning records carry action-level process scores (from FR130) alongside story-outcome tags, enabling fine-grained analysis during synthesis.

**Component integration:** Extends learning records (FR55-FR56). Reads action scores from `pipeline.db`.
**New-write:** Learning record schema extension (~40 LOC).
**Rationale for Growth:** Meaningful analysis requires accumulated data across multiple stories.
**Design inspiration:** GSD `state.cjs` performance metrics tracking.

---

## Section 3: New FRs (FR161-FR171)

### FR161: Tier Demotion Criteria (Growth)

**Resolves: COMP-001**

When an agent's ELO rating drops below (tier_threshold - 50) for 3 consecutive stories, the agent is automatically demoted one tier. Demotion is logged in `pipeline.db` activity log with: previous tier, new tier, ELO trajectory, and triggering stories.

Hysteresis bands prevent tier boundary thrashing: promotion threshold and demotion threshold are separated by 50 ELO points, with a 3-story dwell requirement at the current tier before any transition. An agent promoted to Tier 3 (threshold 1350) would need to drop below 1300 for 3 consecutive stories to be demoted.

**Component integration:** Extends FR134 (tier assignment). Reads/writes `pipeline.db`.
**New-write:** Demotion evaluator with hysteresis (~100 LOC).
**Rationale for Growth:** Depends on FR133 (ELO) and FR134 (tiers).

### FR162: ELO Migration Strategy (Growth)

**Resolves: COMP-009**

ELO ratings use versioned epochs. When the scoring algorithm changes (K-factor adjustment, new scoring dimensions, weight changes), a new epoch is created. Old ratings carry forward into the new epoch as initial estimates with inflated uncertainty (K-factor doubled for the first 5 stories in the new epoch).

Epoch metadata is stored in `pipeline.db` table `elo_epochs` with: epoch_id, algorithm_version, created_at, migration_notes. All rating records reference their epoch.

**Component integration:** Extends FR133 (ELO computation). Reads/writes `pipeline.db`.
**New-write:** Epoch migration manager (~120 LOC).
**Rationale for Growth:** Depends on FR133 (ELO system).

### FR163: Nyquist-BMAD Disagreement Protocol (MVP)

**Resolves: COMP-011**

When structural verification (FR152) and BMAD review (FR10-FR11) produce conflicting assessments:

- **Nyquist pass, BMAD fail:** BMAD finding stands. Nyquist checks structural completeness (files exist, patterns present); BMAD checks spec compliance (correct behavior, proper implementation). A file can exist with the wrong implementation.
- **Nyquist fail, BMAD pass:** Nyquist finding stands for structural gaps (missing files, missing exports, broken integration links). BMAD may have reviewed existing code without noticing that a required artifact was never created.
- **Both fail on same item:** Findings are merged. The fix loop receives both the structural gap (from Nyquist) and the spec compliance issue (from BMAD) as a single remediation item.

The protocol is: **Nyquist is the tiebreaker for structural completeness. BMAD is the tiebreaker for spec compliance.** Neither overrides the other; they address orthogonal quality dimensions.

**Component integration:** Mediates between FR152 (verification) and FR10-FR11 (BMAD). Extends fix loop (FR7).
**New-write:** Disagreement resolver with finding merger (~100 LOC).

### FR164: Maintenance Agent Learning Extraction (MVP)

Every maintenance fix performed by a 24/7 QA or maintenance agent (Growth: cron self-healing loop) generates a categorized learning record in `pipeline.db` table `maintenance_learnings` containing:

- **Category:** preventable (original overlay should have caught this), unforeseeable (novel issue), systemic (architectural gap)
- **Files affected:** list of files modified in the fix
- **Fix applied:** structured description of what changed and why
- **Original overlay gap:** for preventable issues, what the original story overlay should have included to prevent this issue (e.g., "overlay should have included: webhook event handlers must be updated when payment flow changes")
- **Story origin:** which story's code introduced the issue

Preventable maintenance fixes are the primary input to Layer 2 pattern knowledge (FR165). The goal: if a maintenance agent fixes issue X, the next story's overlay should prevent issue X from recurring.

In MVP (before maintenance agents exist in Growth), this FR provides the schema and extraction pipeline. Manual maintenance fixes by developers can be logged via CLI (`qds maintenance log`) to seed the learning system.

**Component integration:** Writes to `pipeline.db`. Feeds FR165 (pattern knowledge) and FR167 (overlay enrichment).
**New-write:** Maintenance learning schema + CLI logger (~200 LOC).

### FR165: Codebase Pattern Knowledge Accumulation (MVP)

Factory Core accumulates cross-story pattern knowledge by mining fix-loop data, BMAD findings, maintenance learning records (FR164), and session composites (FR132). Patterns are stored in `pipeline.db` table `pattern_knowledge` with:

- **Pattern:** structured assertion (e.g., "stories modifying `src/payments/` require updates to `src/webhooks/event-handlers.ts`")
- **Evidence count:** number of stories that confirmed this pattern
- **Confidence:** computed from evidence count and recency
- **Source:** which learning layer produced this pattern (fix-loop, BMAD, maintenance, manual)
- **Applicable scope:** file paths, modules, or domains where this pattern applies

Patterns with evidence_count >= 3 and confidence >= 0.7 are eligible for injection into overlays (FR167). Patterns are never auto-deleted; they decay in confidence over time if not reinforced.

In MVP, pattern mining is performed by the existing manual synthesis script (FR59) extended with cross-story correlation. In Growth, an automated pattern miner runs as part of the daily meta-optimization observer (FR77).

**Component integration:** Reads from `pipeline.db` (fix-loop data, BMAD findings, maintenance learnings). Writes to `pipeline.db`.
**New-write:** Pattern miner with confidence scoring (~250 LOC).

### FR166: Epic-Level Context Management (MVP)

When executing a multi-story epic, Factory Core maintains epic context across stories. Story N's overlay includes relevant learnings, decisions, and patterns from Stories 1 through N-1 within the same epic.

Epic context is assembled from:
- Phase Boundary Protocol manifests from completed stories in the epic
- Fix-loop findings from earlier stories (what went wrong and was corrected)
- File-level conventions established by earlier stories (naming patterns, architecture decisions)

Epic context is stored in `pipeline.db` table `epic_context` and injected as an additional overlay stage between Factory Learnings (Stage 4) and Phase Boundary manifest (Stage 5). Epic context has its own token budget (configurable, default 1000 tokens).

**Component integration:** Extends overlay composition (FR28). Reads from `pipeline.db`.
**New-write:** Epic context assembler with token-budgeted injection (~200 LOC).

### FR167: Overlay Learning Enrichment (MVP)

Overlay composition pulls relevant learning records (Layer 1 codebase knowledge) and pattern knowledge (Layer 2, from FR165) when assembling agent overlays. Each session's overlay is richer than the last because it incorporates learnings from prior sessions working on the same codebase.

Learning enrichment follows this priority order within the Learning stage (Stage 4) token budget:
1. Preventable maintenance findings (FR164) matching the story's file scope
2. Pattern knowledge (FR165) matching the story's file scope with confidence >= 0.7
3. General codebase learnings matching the story's module/domain
4. Cross-story learnings from the current epic (FR166)

If the Learning stage token budget is exhausted, lower-priority items are truncated. The result is that the most actionable, highest-confidence learnings are always injected first.

**Component integration:** Extends overlay composition (FR28, Stage 4). Reads from `pipeline.db`.
**New-write:** Learning enrichment ranker with priority ordering (~150 LOC).

### FR168: Maintenance Burden Tracking (MVP)

Factory Core tracks and categorizes all maintenance agent fixes (or manual maintenance logged via FR164) by:
- Story area (module/directory that introduced the issue)
- Issue category (preventable / unforeseeable / systemic)
- Time since story completion (how long until the issue surfaced)
- Fix cost (tokens consumed by the maintenance fix)

`pipeline.db` table `maintenance_burden` stores per-story-area maintenance records. Dashboard (Growth: FR139 extended) shows maintenance burden per story area trending over time. The success metric for the self-learning system is: maintenance burden per story area decreases over time as overlays incorporate learnings from prior maintenance fixes.

In MVP, maintenance burden is tracked via CLI-logged entries (FR164). In Growth, maintenance agents automatically populate this data.

**Component integration:** Reads from FR164 maintenance learnings. Writes to `pipeline.db`.
**New-write:** Burden aggregator with trending computation (~120 LOC).

### FR169: Random Audit Mechanism (Growth)

**Resolves: PERV-003**

For agents at Tier 3 or above, 1 in N stories (configurable via `factory.yaml`, default N=3) receives full Tier 1 hook density regardless of the agent's tier. Audit stories are selected randomly using a deterministic seed (story_id hash) so audits are reproducible but unpredictable.

Audit story results are scored with elevated weight (configurable, default 1.5x) in the ELO computation (FR133). If an audit story reveals quality issues that the agent's normal tier density would have missed, this feeds into demotion evaluation (FR161).

This prevents the progressive autonomy death spiral where high-tier agents get fewer hooks, producing fewer data points, leading to lower confidence in ratings, and inability to detect quality degradation.

**Component integration:** Extends FR135 (hook density). Feeds FR133 (ELO) and FR161 (demotion).
**New-write:** Audit selector with deterministic randomization (~80 LOC).
**Rationale for Growth:** Depends on FR134 (tier system) and FR135 (hook density).

### FR170: System Health Circuit Breaker (MVP)

**Resolves: FAIL-020**

Factory Core monitors subsystem health (overlay composition, hook execution, verification, budget tracking, Overstory communication, Pi SDK responses). When 3 or more subsystems report errors within a 60-second window, the circuit breaker activates:

1. New story starts are paused
2. In-progress stories continue but with extended timeouts (hook/verification timeouts doubled)
3. Dashboard shows system health degradation indicator
4. Telegram notification dispatched (when messenger enabled)

The circuit breaker auto-resets when all subsystems report healthy for 120 consecutive seconds. Manual reset is available via dashboard or CLI.

Subsystem health is tracked via lightweight heartbeat checks (SQLite write latency, file I/O latency, Pi SDK response time) sampled every 30 seconds. These checks add negligible overhead.

**Component integration:** Monitors all Factory Core subsystems. Extends FR73 (resource monitoring).
**New-write:** Circuit breaker with subsystem health tracking (~180 LOC).

### FR171: Multi-Channel Notification Abstraction (MVP: Telegram, Growth: additional channels)

Factory Core's notification system uses a channel abstraction layer:

- **Channel base class:** defines `send(message)`, `receive()`, `formatMessage(event)`, and `getStatus()` interface
- **MessageBus:** pub/sub event distribution that routes factory events to subscribed channels
- **TelegramChannel:** first implementation, wrapping existing FR120-FR129 functionality

The MessageBus replaces direct EventStore polling by each notification consumer. Factory events (escalations, completions, budget warnings, health alerts) are published once to the MessageBus; subscribed channels receive and format them independently.

MVP ships TelegramChannel only. Growth adds SlackChannel, DiscordChannel, or EmailChannel as zero-architecture-cost additions -- implementing the Channel interface and registering with the MessageBus.

**Component integration:** Wraps FR120-FR129 (Telegram). Extends FR48 (event streaming).
**New-write:** Channel interface + MessageBus (~150 LOC), TelegramChannel adapter (~100 LOC).
**Design inspiration:** DeerFlow `modules/channel/` MessageBus, Channel base class architecture.

---

## Section 4: MVP/Growth Split Table

### Original FRs (FR1-FR129): Unchanged

All 129 original FRs retain their existing MVP/Growth designation as specified in the Session 3 PRD. No changes.

### Revised and New FRs (FR130-FR171)

| FR | Title | Phase | Resolves | Rationale |
|----|-------|-------|----------|-----------|
| FR130 | Action-Level Process Scoring | **MVP** | CONS-002 | Lightweight data collection; foundation for all learning |
| FR131 | Confidence Calibration | **MVP** | PERV-001 | Simple field in transfer manifest; resolution requirement |
| FR132 | Session Composite Scores | **MVP** | CONS-001, PERV-004 | Aggregation of existing hook data; bounded token efficiency |
| FR133 | ELO Domain Ratings | Growth | | Needs 5+ stories/domain to stabilize (SCOPE-001) |
| FR134 | Capability Tier Assignment | Growth | PERV-011 | Depends on FR133; no self-tier injection |
| FR135 | Tier-Based Hook Density | Growth | CONS-003, FAIL-018 | Depends on FR134; L3 floor + fallback defined |
| FR136 | ~~Credit Economy~~ | **KILLED** | ECON-001, COMP-002 | Single-principal system; credit economy is overhead |
| FR136-R | Weighted Composite Routing | Growth | ECON-001, PERV-005 | Replaces FR136; depends on FR133 |
| FR137 | Performance Context in Overlays | Growth | PERV-002, PERV-011 | Needs performance data; scoring weights immutable |
| FR138 | ELO-Based Routing | Growth | | Depends on FR133 and FR136-R |
| FR139 | Performance Dashboard Cards | Growth | | Needs performance data to display |
| FR140 | Performance Data Export | **MVP** | | Cheap debugging tool |
| FR141 | Manual Tier Override | Growth | | Depends on FR134 |
| FR142 | Per-Story Budget Enforcement | **MVP** | ECON-002 | Revised: per-role tracking for visibility only |
| FR143 | Rate Limit Tracking | Growth | | Scaling concern |
| FR144 | Cost-Per-Initiative Rollups | Growth | | Reporting enhancement |
| FR145 | Atomic Task Checkout | **MVP** | FAIL-001 | Prevents real concurrency bugs |
| FR146 | Cost Attribution Dashboard | Growth | | Needs cost history |
| FR147 | Per-Phase Concurrency Limits | Growth | | Scaling concern |
| FR148 | Workspace Lifecycle Hooks | Growth | | Operational polish |
| FR149 | Turn Continuation (Simplified) | **MVP** | CONS-004, FAIL-012 | Lightweight signals; progress velocity check |
| FR150 | Deviation Handling | Growth | | MVP fix loop sufficient |
| FR151 | Wave-Based Epic Decomposition | Growth | | MVP handles basic dependency detection |
| FR152 | Lightweight Continuous Verification | **MVP** | CONS-004, FAIL-006 | Filesystem-only; near-zero cost; catches drift early |
| FR153 | Structured Verification Report | Growth | | Full Nyquist is Growth polish |
| FR154 | Auto-Remediation from Gaps | Growth | | Depends on FR153 |
| FR155 | Context Budget 50% Rule | **MVP** | | Single guard clause with minimum floor |
| FR156 | Confidence-Scored Fact Extraction | Growth | | LLM-powered enhancement over rule-based MVP |
| FR157 | Confidence-Ranked Injection | Growth | | Depends on FR156 |
| FR158 | Per-Agent Memory Profiles | Growth | | Needs behavioral data |
| FR159 | Progressive Skill Loading | Growth | | Optimization; MVP injects all skills |
| FR160 | Action Scores in Learning Records | Growth | | Needs accumulated data |
| FR161 | Tier Demotion Criteria | Growth | COMP-001 | Depends on FR133/FR134 |
| FR162 | ELO Migration Strategy | Growth | COMP-009 | Depends on FR133 |
| FR163 | Nyquist-BMAD Disagreement | **MVP** | COMP-011 | Critical quality protocol |
| FR164 | Maintenance Learning Extraction | **MVP** | | Core self-learning input; CLI seeding in MVP |
| FR165 | Pattern Knowledge Accumulation | **MVP** | | Cross-story learning; the core innovation |
| FR166 | Epic-Level Context Management | **MVP** | | Essential for multi-story epic execution |
| FR167 | Overlay Learning Enrichment | **MVP** | | Makes each session's overlay richer |
| FR168 | Maintenance Burden Tracking | **MVP** | | Success metric for self-learning system |
| FR169 | Random Audit Mechanism | Growth | PERV-003 | Depends on FR134/FR135 |
| FR170 | System Health Circuit Breaker | **MVP** | FAIL-020 | Prevents cascading multi-system failures |
| FR171 | Multi-Channel Notification | **MVP** (Telegram) | | Channel abstraction + first implementation |

### MVP Addition Summary

**16 new MVP FRs** added on top of the original 129:

| Category | FRs | Total |
|----------|-----|-------|
| Performance Data Collection | FR130, FR131, FR132 | 3 |
| Data Operations | FR140 | 1 |
| Economic Governance | FR142 (revised), FR145 | 2 |
| Orchestration | FR149 (simplified) | 1 |
| Quality Verification | FR152 (revised), FR155 | 2 |
| Quality Protocol | FR163 | 1 |
| Self-Learning System | FR164, FR165, FR166, FR167, FR168 | 5 |
| System Health | FR170 | 1 |
| Notification | FR171 (Telegram scope) | 1 |

**Total MVP FRs: 145** (129 original + 16 new)
**Total Growth FRs: 26** (FR133-FR135, FR136-R, FR137-FR139, FR141, FR143-FR144, FR146-FR148, FR150-FR151, FR153-FR154, FR156-FR162, FR169)

### Session 7 Finding Resolution Summary

| Finding | Resolution | FR(s) |
|---------|-----------|-------|
| CONS-001 | Cost data read from attribution.db, not duplicated | FR132 |
| CONS-002 | pipeline.db is source of truth; no YAML primary store | FR130, Preamble 1.4 |
| CONS-003 | L3 phase boundary hooks mandatory for ALL tiers | FR135 |
| CONS-004 | Per-turn uses lightweight signals, not full Nyquist | FR149, FR152 |
| SCOPE-001 | MVP: data collection (layers 1-3); Growth: behavioral (4-6) | FR133-FR135 deferred |
| SCOPE-010 | 16 new MVP FRs (not 31); 26 deferred to Growth | Section 4 table |
| COMP-001 | Demotion: ELO below threshold-50 for 3 stories | FR161 |
| COMP-002 | Credit economy KILLED | FR136 (killed) |
| COMP-009 | Versioned rating epochs | FR162 |
| COMP-011 | Nyquist=structural, BMAD=spec compliance | FR163 |
| TRANS-001 | Research repos are inspiration, not transplant | Preamble 1.1 |
| TRANS-003 | Research repos are inspiration, not transplant | Preamble 1.1 |
| TRANS-007 | Research repos are inspiration, not transplant | Preamble 1.1 |
| PERV-001 | Resolution requirement alongside calibration | FR131 |
| PERV-002 | Scoring weights immutable without dev approval | FR137 |
| PERV-003 | Random audit: 1 in N stories for Tier 3+ | FR169 |
| PERV-004 | Bounded step function; penalties >3x median only | FR132 |
| ECON-001 | Credit economy KILLED; weighted composite scoring | FR136-R |
| ECON-002 | Per-story + global budget; per-role visibility only | FR142 |

All 19 critical findings resolved.

---

## Section 5: Revised NFRs

### Unchanged NFRs

NFR1-NFR34 remain unchanged from the Session 3 PRD.

### Revised NFRs

#### NFR35: Action Scoring Latency (unchanged target, revised storage)

Action-level process score computation (FR130) must complete within 200ms of post-task hook completion, as measured by timestamp delta between hook result availability and `pipeline.db` action_scores row insert. Performance scoring must not become a pipeline bottleneck.

*Change from original:* Storage target changed from `.qds/performance/actions/` YAML file write to `pipeline.db` row insert, per CONS-002 resolution.

#### NFR36: Performance Data Storage Growth

Performance data in `pipeline.db` must not exceed 100MB per 1,000 stories processed, as measured by `pipeline.db` file size delta after processing 1,000 stories in a test harness. Action scores older than the configurable retention window (default 90 days) are archived to a separate `pipeline_archive.db`.

*Change from original:* Replaced the vague "must not exceed 500 tokens" overlay size NFR with a concrete storage growth limit. The overlay token limit is already covered by NFR4 and FR29.

#### NFR37: Learning Record Query Latency

Learning record queries against `pipeline.db` (pattern knowledge lookup, maintenance learning retrieval, overlay enrichment assembly) must complete within 50ms as measured by SQLite query timing instrumentation. This ensures overlay composition (which now pulls learning data) stays within the existing NFR4 500ms budget.

*New NFR.* Overlay enrichment (FR167) adds database queries to the overlay composition pipeline; these queries must not blow the existing latency budget.

#### NFR38: Code Convention Compliance (revised)

**REVISED from "Performance data storage must use atomic write pattern."**

All QDS v2 code follows QDS conventions regardless of which research repository pattern inspired its design. There is no "transplanted code" category with different quality standards. All code must: use ESM module syntax, include TypeScript types for all public interfaces, use `bun:sqlite` for database access (not Drizzle ORM), follow the project's error handling patterns, and pass the project's lint and type-check configuration.

*Change from original:* The original NFR38 specified atomic writes for `.qds/performance/` YAML files. Since performance data now lives in `pipeline.db` (CONS-002), atomic writes are handled by SQLite transactions. This NFR is repurposed to address CONS-011 (single database access pattern) and the general principle that inspiration-sourced code must meet QDS standards.

### New NFRs

#### NFR39: Epic Context Assembly Latency

Epic context assembly (FR166) must complete within 500ms for epics containing up to 20 stories, as measured by the time from epic context query initiation to assembled context availability. Epic context is pre-computed after each story completion and cached in `pipeline.db`, not computed on-demand during overlay assembly.

#### NFR40: Maintenance Learning Non-Blocking

Maintenance learning extraction (FR164) must not block the story completion pipeline. Learning record creation runs asynchronously after story completion confirmation. If learning extraction fails (LLM error, timeout, schema validation failure), the story completion is unaffected and the extraction failure is logged for retry.

---

## Section 6: Design Inspiration Reference

Research repositories are design inspiration sources. The following table maps QDS v2 capabilities to the research repo patterns that informed their design. No code is directly copied; all implementations are new-write following QDS conventions.

| Capability | QDS FR(s) | Inspired By | Pattern Reference | What We Take |
|-----------|-----------|------------|-------------------|-------------|
| Structural verification | FR152, FR153 | GSD | `bin/lib/verify.cjs` cmdVerifyArtifacts(), cmdVerifyKeyLinks() | must_haves schema, artifact existence checking, key_link pattern matching approach |
| Budget enforcement | FR142, FR38, FR39 | PaperclipAI | `services/costs.ts` threshold check pattern | Budget ceiling checking logic, cost aggregation approach |
| Turn continuation | FR149 | Symphony | `agent_runner.ex` do_run_codex_turns() loop | Continuation loop structure, progress checking approach, continuation prompt pattern |
| Workspace hooks | FR148 | Symphony | `workspace_lifecycle.ex` create_for_issue() | 4-hook-point lifecycle pattern (after_create, before_run, after_run, before_remove) |
| Confidence scoring | FR131, FR156 | DeerFlow | `agents/memory/updater.py` update_memory() | Confidence calibration approach, Brier score computation |
| Channel abstraction | FR171 | DeerFlow | `modules/channel/` MessageBus, Channel base class | Pub/sub event distribution, channel interface pattern |
| Agent lifecycle | FR134 (Growth) | PaperclipAI | `agents.ts` service status transitions | Status state machine approach, config revision tracking |
| Throughput visualization | FR139 (Growth) | Symphony | `status_dashboard.ex` sparkline algorithms | Sparkline computation algorithms, throughput tracking formulas |
| Model tier profiles | FR36 | GSD | `core.cjs` MODEL_PROFILES table | Agent-type-to-model-tier mapping structure |
| Atomic checkout | FR145 | PaperclipAI | `db/schema/agent_wakeup_requests.ts` claimedAt pattern | Claimed-at timestamp lock pattern for preventing duplicate assignment |
| Wave decomposition | FR151 (Growth) | GSD | `phase.cjs` cmdPhasePlanIndex() | Wave grouping logic, dependency-aware parallel execution approach |
| Deviation handling | FR150 (Growth) | GSD | SUMMARY.md deviation template, `verify.cjs` cmdVerifySummary() | 4-rule deviation classification, deviation logging format |
| Concurrency limits | FR147 (Growth) | Symphony | `orchestrator.ex` max_concurrent_agents_for_state() | Per-state concurrency limiting pattern, stall detection with exponential backoff |
| Progressive skill loading | FR159 (Growth) | DeerFlow | `skills/loader.py` skill discovery + enabled-state filtering | Scope-based skill filtering approach |
| Memory profiles | FR158 (Growth) | DeerFlow | `agents/memory/queue.py` MemoryQueue | Debounced write pattern, per-agent deduplication approach |
| Fact extraction | FR156 (Growth) | DeerFlow | `agents/memory/updater.py`, `agents/memory/prompt.py` | LLM-powered fact extraction with confidence scoring approach |
| Cost attribution | FR144 (Growth) | PaperclipAI | `services/costs.ts` byProject() | Project-level cost rollup aggregation approach |
| Rate limit tracking | FR143 (Growth) | Symphony | `orchestrator.ex` token tracking | Rate limit header capture and capacity planning approach |

---

## Appendix A: Retired Concepts

The following concepts from the Session 6 PRD are retired by this amendment:

| Concept | Original FR(s) | Status | Replacement |
|---------|---------------|--------|-------------|
| Credit economy | FR136 | KILLED | FR136-R (weighted composite scoring, Growth) |
| Per-agent monthly budget caps | FR142 (original) | REVISED | FR142 (per-story + global budget; per-role visibility only) |
| Transplant inventory | PRD Appendix | RETIRED | Section 6 Design Inspiration Reference |
| Transplant ratio metric | PRD summary | RETIRED | All code is new-write; inspiration acknowledged |
| `.qds/performance/actions/` YAML store | FR130 (original) | REPLACED | `pipeline.db` table `action_scores` |
| `ratings.yaml` | Implied by FR133 | REPLACED | `pipeline.db` table `elo_ratings` |
| Drizzle ORM usage | ADR-020 (original) | REPLACED | `bun:sqlite` direct access (single pattern) |
| Tier 5 "escalation only" hooks | FR135 (original) | REVISED | L3 minimum for all tiers; Tier 5 = Tier 2 density |
| Full Nyquist per-turn | ADR-019 (original) | REPLACED | Lightweight signals per-turn (FR149) |
| DeerFlow hooks.ts as transplant source | Transplant inventory | REMOVED | File was chat streaming hooks, not performance dashboard (TRANS-007) |

## Appendix B: Estimated New-Write LOC for New MVP FRs

| FR | Component | Estimated LOC |
|----|-----------|--------------|
| FR130 | Action score computation + schema | ~180 |
| FR131 | Calibration with resolution check | ~120 |
| FR132 | Composite scoring with bounded efficiency | ~200 |
| FR140 | Export serializer | ~80 |
| FR142 | Per-role cost tracking columns | ~40 |
| FR145 | Checkout lock manager | ~120 |
| FR149 | Turn continuation with velocity check | ~200 |
| FR152 | Structural verifier with oscillation detection | ~300 |
| FR155 | Context budget validator with floor | ~60 |
| FR163 | Disagreement resolver | ~100 |
| FR164 | Maintenance learning schema + CLI | ~200 |
| FR165 | Pattern miner with confidence | ~250 |
| FR166 | Epic context assembler | ~200 |
| FR167 | Learning enrichment ranker | ~150 |
| FR168 | Burden aggregator with trending | ~120 |
| FR170 | Circuit breaker with health tracking | ~180 |
| FR171 | Channel interface + MessageBus + Telegram adapter | ~250 |
| **Total** | | **~2,750 LOC** |

This is 100% new-write. No transplant ratio is claimed. Design inspiration from research repositories reduces design risk and implementation time, but every line of code is written to QDS conventions using QDS patterns.

---

*End of PRD Amendment Document -- Session 8*
*Generated: 2026-03-10*
*Resolves: All 19 critical Session 7 findings*
*Net result: 145 MVP FRs (129 original + 16 new), 26 Growth FRs, 40 NFRs*
