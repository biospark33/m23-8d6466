# Adversarial Review Findings — Session 7

**Date:** 2026-03-10
**Scope:** Multi-wave adversarial review of Session 6 PRD enhancements (FR130-FR160, ADR-015 through ADR-020, transplant inventory)
**Agents Deployed:** 11 agents across 4 waves (4 structural integrity, 3 economic/incentive, 3 opportunity identification, 1 synthesis)
**Total Findings:** 130+ across all agents

---

## Executive Summary

Session 6 was ambitious and directionally correct. The integration of 4 research repos into QDS v2 adds genuinely valuable capabilities — performance tracking, economic governance, goal-backward verification, workspace hooks, and turn continuation. However, this review identified **systemic issues** that must be addressed before implementation:

1. **The transplant ratio is inflated.** Claimed: 5,302 LOC at 79% transplant ratio. Verified: ~2,869 LOC truly transplantable at ~43% ratio. An additional ~2,800-3,200 LOC in research repos was MISSED by Session 6.
2. **The MVP scope has exploded beyond feasibility.** Adding 31 FRs to an already aggressive 129-FR MVP creates a ~153-FR scope that is a V1.0, not an MVP. Recommended: keep 8 new FRs in MVP, defer 23 to Growth.
3. **The economic model was transplanted from a multi-agent marketplace (PaperclipAI) into a single-principal system (QDS).** Per-agent budgets, credit economies, and marketplace routing don't map to a system where one LLM runs all agents.
4. **The performance system creates closed-loop optimization with no external ground truth.** The system scores its own work, learns from its own scores, and optimizes its own scoring. At least 5 concrete perverse incentives were identified.
5. **The architecture has critical data integrity gaps.** Concurrent writes to `ratings.yaml` with no locking, dual source of truth (YAML + SQLite), and performance system failure cascading into hook enforcement.

**Top 5 changes that would most improve the system** (ranked by impact):

| Rank | Change | Impact |
|------|--------|--------|
| 1 | Adopt bidirectional middleware chain (ARCH10X-001) | Structural unification of context assembly + result processing |
| 2 | Implement continuous lightweight Nyquist verification during dev (10X-002) | 25-35% token savings, 40-50% fix-loop reduction |
| 3 | Defer 23 FRs to Growth, keep 8 in MVP (SCOPE-010) | MVP becomes achievable, vision preserved |
| 4 | Replace per-agent budget/credit marketplace with direct Factory Core control (ECON-001/002) | Eliminates economic model that doesn't fit single-principal architecture |
| 5 | Add random audit mechanism for high-tier agents (PERV-003) | Prevents progressive autonomy death spiral |

**Top 3 10x opportunities:**

| Rank | Opportunity | Expected Impact |
|------|-------------|-----------------|
| 1 | Continuous Nyquist verification during development (10X-002) | Catches structural drift at 5% of fix-loop cost |
| 2 | Codebase intent model from cross-story pattern mining (10X-005) | 30-40% reduction in "forgot to update X" class of fix-loop errors |
| 3 | Fine-tuning signal generation pipeline (10X-010) | Transformative long-term: factory-specific model that eliminates 40-60% of overlay token overhead |

---

## Wave 1: Structural Integrity Findings

### Agent 1 — Consistency Auditor (20 findings: 4 critical, 12 important, 4 minor)

#### Critical Findings

**CONS-001: Three-way cost/credit/budget tracking split**
- FR132 (session composites in `pipeline.db`), FR136 (credit economy in `pipeline.db`), and FR42/ADR-005 (cost attribution in `attribution.db`) create three overlapping cost-tracking mechanisms across two databases with no defined relationship.
- **Fix:** Move `credit_ledger` to `attribution.db`. Define FR132 as reading from `attribution.db`, not duplicating cost data.

**CONS-002: Dual source of truth for action scores**
- ADR-015 specifies BOTH filesystem (`.qds/performance/actions/` YAML files) AND database (`pipeline.db` `action_scores` table) for the same data. No defined relationship between them.
- **Fix:** `pipeline.db` is the source of truth. YAML files are human-readable exports computed from DB.

**CONS-003: Tier 5 "escalation only" hooks eliminate quality gates**
- FR135 reduces hook enforcement to "escalation only" for Tier 5 agents, effectively removing L2 post-edit, L3 post-task, and phase boundary gates. This undermines the non-negotiable quality infrastructure.
- **Fix:** Cap minimum enforcement at L3 phase boundary for ALL tiers. No agent skips phase boundary hooks.

**CONS-004: ADR-019 per-turn goal checking invokes full Nyquist verifier**
- The Nyquist verifier (ADR-017) was designed to run once after QA swarm, not per-turn within development. Running it per-turn is prohibitively expensive.
- **Fix:** Per-turn goal checking uses lightweight signals (post-task hook pass/fail, checklist completion), NOT the full Nyquist verifier.

#### Key Important Findings

- **CONS-007:** FR130→FR134→FR135→FR130 creates a circular dependency where scoring inputs depend on enforcement density which depends on tier which depends on scores. The system has a built-in blindspot: the better an agent rates, the less it's monitored.
- **CONS-008:** Transplant inventory target file paths don't exist in the architecture doc's directory tree. Tree and File-to-Decision-Mapping table are inconsistent.
- **CONS-009:** NFR35 (200ms action scoring) + NFR2 (2s hook execution) = 2.2s per task for Tier 1 agents (hooks on every edit). At 50 edits per story = 110 seconds of pure overhead.
- **CONS-010:** FR156 (LLM-powered confidence scoring) contradicts FR59's explicitly rule-based MVP synthesis model.
- **CONS-011:** ADR-020 introduces Drizzle ORM alongside existing `bun:sqlite` direct access — two different SQLite access patterns in the same codebase.
- **CONS-019:** FR159 (progressive skill loading) contradicts MVP Feature Set line 695 ("All skills injected") within the same document.

---

### Agent 2 — Scope Creep Detector (10 findings: 2 critical, 6 important, 2 minor)

#### Critical Findings

**SCOPE-001: Full 6-layer performance system in MVP is not viable**
- The 6-layer system (action scores → confidence → composites → ELO → tiers → credits) requires sustained usage data that doesn't exist at MVP launch. ELO ratings need 5+ stories to stabilize. Tiers need ELO data. Credits need tier data.
- **Fix:** MVP: layers 1-3 (data collection). Growth: layers 4-6 (behavioral effects).

**SCOPE-010: MVP now has ~153 FRs — this is a V1.0, not an MVP**
- At 3 FRs/developer/week (aggressive), 153 FRs = 25 developer-weeks = 3 months with zero interruptions. With typical 2x integration overhead = 6 months.
- **Fix:** Defer 23 of 31 new FRs to Growth. Keep 8 carefully selected FRs that improve pipeline depth and safety.

#### Recommended MVP/Growth Split

| Keep in MVP (8 FRs) | Rationale |
|---------------------|-----------|
| FR130 (action scores) | Lightweight data foundation |
| FR131 (confidence calibration) | Simple field in transfer manifest |
| FR132 (session composites, simplified) | Aggregation of existing hook data |
| FR140 (performance data export) | Cheap, useful for debugging |
| FR142 (per-agent budget caps) | Simple safety rail |
| FR145 (atomic task checkout) | Prevents real concurrency bugs |
| FR149 (turn continuation, simplified) | Pipeline depth improvement |
| FR155 (context budget 50% rule) | Single guard clause |

| Defer to Growth (23 FRs) | Rationale |
|--------------------------|-----------|
| FR133-FR139, FR141 | ELO/tier/credit behavioral effects — need data to be meaningful |
| FR143-FR144, FR146 | Reporting enhancements |
| FR147-FR148, FR150-FR151 | Scaling/orchestration — MVP handles 3-4 concurrent stories |
| FR152-FR154 | Goal verification — human PR review covers this at MVP scale |
| FR156-FR160 | Memory enhancements — all require high-friction Python→TypeScript ports |

#### Transplant Overhead Assessment

- **Realistic effort multiplier:** 1 LOC transplanted ≠ 1 LOC integrated. By source:
  - PaperclipAI (TypeScript→TypeScript): 1.5x (Postgres→SQLite, Drizzle→bun:sqlite)
  - GSD (CJS→ESM TypeScript): 2.0x (module system, runtime differences)
  - DeerFlow (Python→TypeScript): 2.5x (asyncio→async/await, dynamic typing→TypeScript)
  - Symphony (Elixir→TypeScript): 3.0x (OTP patterns, GenServer, supervision trees)
- **Realistic total effort:** 5,302 claimed LOC × blended ~2.5x = ~13,000 LOC-equivalent effort

---

### Agent 3 — Completeness Checker (28 findings: 4 critical, 17 important, 7 minor)

#### Critical Findings

**COMP-001: No tier demotion criteria**
- FR134 defines how agents EARN tiers but never specifies how they LOSE them. Once promoted, an agent stays at its tier regardless of subsequent performance degradation. Combined with reduced hook density at higher tiers, this means the worst agents get the least oversight.
- **Fix:** Add demotion criteria: ELO drops below threshold - 50 for 3 consecutive stories triggers automatic demotion.

**COMP-002: No negative credit balance policy**
- FR136 describes credit earning and decay but doesn't define what happens when credits go negative. Without an overdraft policy, the credit economy has no real consequences.
- **Fix:** Define credit floor, routing behavior at zero balance, and escalation when all agents are at floor.

**COMP-009: No ELO migration strategy for algorithm changes**
- When the scoring algorithm is tuned (inevitable), all existing ratings become invalid. No migration path, no backward compatibility, no reset mechanism.
- **Fix:** Add versioned rating epochs. Algorithm changes create a new epoch. Old ratings carry forward as initial estimates with inflated uncertainty.

**COMP-011: No Nyquist-vs-BMAD disagreement protocol**
- BMAD (FR19-FR21) and Nyquist (FR152) are independent quality systems. When they disagree (BMAD says pass, Nyquist says fail, or vice versa), the pipeline behavior is undefined.
- **Fix:** Nyquist is the tiebreaker for structural completeness. BMAD is the tiebreaker for spec compliance.

#### Key Missing Elements

- **8 missing FRs** including: initial ELO rating assignment, rating reset mechanism, credit expiry policy, tier demotion criteria, performance data migration, performance data purge policy, negative credit handling, Nyquist-BMAD disagreement resolution
- **6 missing ADR consequences** including: ELO migration when algorithm changes, per-agent budget handling when agents are retired, workspace hook rollback on partial failure, turn state when LLM provider changes mid-turn
- **5 missing NFRs** including: performance data storage growth limits, ELO computation non-blocking requirement, credit audit trail retention period, transplant code maintainability standards
- **5 missing UX paths** including: Performance Dashboard empty state guidance, tier transition visual experience, historical performance trend view, performance data error state, loading state during ELO recalculation

---

### Agent 4 — Transplant Viability Auditor (16 findings: 3 critical, 8 important, 3 minor)

#### Critical Findings

**TRANS-001: PaperclipAI costs.ts is 85% Postgres-specific**
- Only ~80 of 204 LOC are portable. The rest uses Postgres-specific features: `sql.raw()` with `::int` / `::numeric` casts, `DISTINCT ON` (no SQLite equivalent), `SUM()::int` casting, `jsonb ->>` operators.
- **Revised:** 204 claimed → ~80 portable LOC

**TRANS-003: GSD verify.cjs is 87% project health tooling, not goal verification**
- Only `cmdVerifyArtifacts()` and `cmdVerifyKeyLinks()` (~113 LOC combined) implement the must_haves verification pattern the PRD describes. The other 700+ LOC are GSD-specific phase/plan/roadmap/summary validation tools.
- **Revised:** 820 claimed → ~150 transplantable LOC

**TRANS-007: DeerFlow hooks.ts is irrelevant to QDS**
- The transplant inventory claims 488 LOC from DeerFlow's frontend `hooks.ts` for FR139 (performance dashboard cards). The file provides React hooks for chat conversation streaming (useStreamMessage, useScrollAnchor, etc.), not agent performance dashboard components.
- **Revised:** 488 claimed → 0 LOC (remove entirely, reclassify as new-write)

#### Revised Transplant Summary

| Repo | Claimed LOC | Realistic LOC | Delta |
|------|-------------|---------------|-------|
| PaperclipAI | ~1,156 | ~730 | -426 |
| GSD | ~1,689 | ~1,019 | -670 |
| DeerFlow | ~1,628 | ~555 | -1,073 |
| Symphony | ~829 | ~565 | -264 |
| **Total** | **~5,302** | **~2,869** | **-2,433** |

**Revised transplant ratio:** ~43% (down from claimed 79%)

---

## Wave 2: Economic & Incentive Analysis

### Agent 5 — Perverse Incentive Hunter (16 findings: 4 critical, 9 important, 3 minor)

#### Critical Findings

**PERV-001: Confidence calibration rewards cowards**
- An agent that always expresses LOW confidence (30%) and is right 30% of the time gets a PERFECT Brier score. This agent is useless but perfectly "calibrated." The system cannot distinguish between meaningful discrimination and base-rate prediction.
- **Fix:** Add a resolution requirement alongside calibration: confidence declarations must demonstrate spread across the [0.2, 0.9] range with positive rank correlation to outcomes.

**PERV-002: Meta-optimization can modify scoring parameters**
- FR79-FR83 allow the meta-optimization system to modify factory operations. If it modifies scoring weights, overlay composition, or difficulty estimation, it can inadvertently optimize for scores rather than quality.
- **Fix:** Meta-optimization must NOT modify parameters that affect how scores are computed. Scoring weights are immutable without developer approval.

**PERV-003: Progressive autonomy death spiral**
- High-tier agents get fewer hooks → fewer data points for scoring → lower confidence in ratings → unable to detect quality degradation → high tier maintained despite declining quality.
- **Fix:** Random audit mechanism: 1 in N stories (configurable, default 3) for any agent above Tier 2 gets full Tier 1 hook density. Audit stories scored with elevated weight.

**PERV-004: Token efficiency scoring rewards unmaintainable code**
- FR132 includes "token efficiency (tokens consumed / files modified)" as a scoring dimension. Terse code (no comments, single-letter variables, no error handling) scores higher than robust, well-documented code.
- **Fix:** Replace raw token efficiency with a bounded step function: penalties only for >3x median, no rewards for below median. Add code maintainability metrics (comment density, naming convention adherence).

#### Other Key Incentive Issues

- **PERV-005:** Domain specialization collapse — ELO-based routing creates feedback loops where agents only get routed work they're already good at, creating capability deserts in underexercised domains. **Fix:** 15% exploration factor in routing.
- **PERV-007:** Performance-learning feedback loop — action scores in learning records create institutional knowledge that calcifies around scoring-optimized patterns rather than engineering-optimized patterns. **Fix:** Learning diversity requirement; decouple learning weights from action scores.
- **PERV-009:** Tier boundary thrashing — agents oscillating around ELO thresholds cause constant tier promotion/demotion and hook density changes. **Fix:** Hysteresis bands (promotion threshold + demotion threshold 50 points lower, with 3-story dwell requirement).
- **PERV-011:** Self-fulfilling tier prophecy — injecting an agent's own tier into its overlay causes high-tier agents to behave more confidently (less careful) and low-tier agents to waste tokens on excessive caution. **Fix:** Don't inject the agent's own tier level into its working context.

---

### Agent 6 — Economic Model Stress-Tester (10 findings: 2 critical, 4 important, 4 minor)

#### Critical Findings

**ECON-001: Credit economy solves a problem that doesn't exist at QDS scale**
- PaperclipAI manages persistent autonomous agents as independent economic actors competing for work. QDS has one LLM provider running transient agent instances. A "credit economy" for a single-principal system reduces to a sorting function.
- **Fix:** Replace credit marketplace with weighted composite scoring for routing (ELO domain match × historical success rate × cost projection). No credits, no decay, no marketplace abstraction.

**ECON-002: Per-agent monthly budgets create artificial fragmentation**
- Setting per-agent budgets (e.g., Builder: $40/month) creates deadlocks when a story needs $5 but the builder only has $2 remaining, even though the global budget has $50 available. The story stalls mid-execution with conflicting signals.
- **Fix:** Use per-story budget (FR38) + global daily/monthly budget (FR39) as two enforcement layers. Track per-role costs for visibility in attribution reporting, not as enforcement boundaries.

#### Key Quantitative Findings

- **ELO stability:** With 10-15 stories/month across 6 domains, domain-specific ELO has ~2-3 stories per domain per month. ELO needs 20+ observations per domain to achieve "medium" confidence. Tier unlock criteria (Tier 3: ELO > 1350, 20 sessions) are unreachable for 3-6 months.
- **Storage growth:** At 150 actions/story (100 file edits + test runs + hook executions), after 6 months of daily operation (~1,000 stories): 150,000 individual YAML files in `.qds/performance/actions/`. This degrades filesystem performance on most systems. **Fix:** Consolidate action scores into `pipeline.db`.
- **Context budget:** The 50% rule (FR155) is model-independent when it should use absolute token minimums. A 100K context model at 50% leaves 50K, of which overlay consumes ~8.8K, leaving 41.2K for task. A 32K model at 50% leaves 16K, of which overlay consumes ~8.8K, leaving 7.2K — barely enough for meaningful work.

---

### Agent 7 — Failure Mode Analyst (21 findings: 6 critical, 10 important, 5 minor)

#### Critical Findings

**FAIL-001: Concurrent ELO updates to ratings.yaml cause lost writes**
- Two stories completing simultaneously both write to `ratings.yaml`. Atomic writes (temp file + rename) prevent corruption but not lost updates. Process A writes temp file, Process B writes temp file, A renames, B renames — A's update is silently overwritten.
- **Fix:** Use `pipeline.db` with SQLite's built-in locking for all performance state. Filesystem YAML files are read-only exports.

**FAIL-006: Nyquist false negatives trigger wasteful fix loops**
- When the Nyquist verifier incorrectly reports "goal not met" (file read timeout, must_haves too strict, parser bug), the story enters the fix loop burning budget on non-issues. No escape hatch for "verification system error" vs "genuine quality gap."
- **Fix:** Add oscillation detection: if a fix-loop iteration re-runs Nyquist and produces the SAME gap list on code that the fix loop didn't modify, flag as potential false negative and escalate rather than iterating.

**FAIL-012: Asymptotic approach — max_turns reached with incomplete goal**
- Turn continuation reaches max_turns at 89% completion. Phase transitions even though the goal isn't met. BMAD catches the incomplete work, fix loop starts with a fresh agent that must re-understand 89%-complete code.
- **Fix:** Progress velocity check: if agent made measurable progress in last turn and goal is >75% complete, allow Factory Core to extend max_turns by 1 (up to hard cap of max_turns × 1.5).

**FAIL-015: Elixir error handling semantics lost in TypeScript port**
- Elixir uses exhaustive pattern matching on `{:ok, value} / {:error, reason}` tuples. TypeScript uses try/catch. Unexpected error types (plain strings, numbers thrown by dependencies) silently fall through catch blocks, crashing the turn continuation loop.
- **Fix:** Defensive error normalization utility for all transplanted code. Require turn state persistence to `pipeline.db` between turns (not in-process memory).

**FAIL-018: Performance system failure changes hook enforcement for all agents**
- Performance system is marked "non-critical path" but its tier data controls hook enforcement density (critical path). If the performance system crashes, the hook pipeline has no defined fallback for tier lookup.
- **Fix:** Explicit fallback: when tier data is unavailable, default to Tier 2 enforcement (hooks every 3 tasks). Document this as a "soft critical path" dependency.

**FAIL-020: Multi-system failure from shared resource (disk I/O)**
- Disk I/O spikes cause Nyquist verification, performance data writes, and workspace hooks to all timeout simultaneously. Each system handles its failure independently with no common root cause detection.
- **Fix:** System-level health circuit breaker: if 3+ subsystems report errors within 60 seconds, pause new story starts. Auto-increase hook/verification timeouts by 2x during detected I/O degradation.

#### Key Failure Themes

1. **Single-file shared state without locking** — YAML files for data with concurrent writers should be in SQLite
2. **Non-critical subsystems feeding critical-path decisions** — performance system tier data controls hook enforcement
3. **Transplanted code as hidden risk** — 5,302 LOC with zero test coverage in the target language/framework
4. **No systemic degraded mode** — individual subsystem failures handled, but correlated failures (common root cause) are not

---

## Wave 3: 10x Opportunities

### Agent 8 — 10x Capability Finder (11 opportunities)

#### Top 3 MVP-Ready Opportunities

**10X-002: Continuous Lightweight Nyquist Verification During Development**
- Run filesystem-only verification (artifact existence, key_link pattern checks) as a post-task hook during development, not just after QA
- Cost: near zero (filesystem operations, not LLM calls). Duration: under 500ms
- Catches structural drift at 5% of the cost of a post-BMAD fix loop
- **Expected impact:** 40-50% fix-loop reduction, 25-35% token savings on stories that would have hit fix loops
- **Complexity:** Medium (verification engine already exists in transplanted GSD code)

**10X-009: Confidence-Calibrated Adaptive Hook Density**
- Dynamic hook enforcement based on real-time confidence and calibration, not just static tier
- A Tier 4 agent showing miscalibrated confidence on an unfamiliar scope gets automatic hook escalation
- **Expected impact:** 15-20% improvement in Tier 4 agent reliability without sacrificing speed on well-calibrated stories
- **Complexity:** Low (confidence/action data already computed; hook density lookup needs conditional override)

**10X-008: Predictive Fix-Loop Avoidance (basic version)**
- Real-time burn rate tracking with cost projection: "Story at 40% completion, projected to exceed budget by phase 4"
- Basic version: burn rate × remaining phases = projected cost. Dashboard + Telegram notification.
- **Expected impact:** 30% reduction in budget circuit breaker events
- **Complexity:** Low (budget tracking already exists in FR37)

#### Top Growth-Phase Opportunities

**10X-005: Codebase Intent Model** — Cross-story pattern mining to build a "why, not just what" knowledge graph. "87% of stories modifying payments needed webhook updates." 30-40% reduction in scope-awareness fix loops.

**10X-003: Self-Improving Story Specifications** — Auto-generate must_haves from historical fix-loop patterns. "Stories touching auth always need these 5 verification checks." 50-60% reduction in underspecified story failures.

**10X-010: Fine-Tuning Signal Generation Pipeline** — Accumulated performance data as Process Reward Model training dataset. Transformative long-term: factory-specific model that eliminates 40-60% of overlay token overhead.

---

### Agent 9 — Architecture 10x Finder (8 opportunities)

#### Adopt Immediately (5)

**ARCH10X-001: Bidirectional Middleware Chain**
- Replace unidirectional overlay pipeline with DeerFlow's bidirectional middleware pattern (before_model + after_model hooks)
- Unifies context assembly AND result processing (learning extraction, action scoring, attribution merge, memory update)
- DeerFlow's 11 production-tested middleware components prove the pattern works at scale

**ARCH10X-002: Generalized Channel Abstraction**
- Replace Telegram-only messenger with DeerFlow's multi-channel architecture (MessageBus, Channel base class, ChannelManager, ChannelService, ChannelStore)
- Telegram stays first-class; Slack, Discord, email become zero-architecture-cost additions
- The pub/sub MessageBus eliminates duplicate EventStore polling

**ARCH10X-003b: Intra-Phase Quality Checkpoints**
- Within the Dev phase, inject lightweight quality checkpoint turns at configurable intervals (every 3 turns)
- Preserves the hard Dev-to-BMAD boundary while getting earlier feedback
- 20-40% token waste reduction on stories with early structural errors

**ARCH10X-006: Symphony-Style Throughput Visualization**
- Transplant sparkline algorithms, throughput tracking, and event humanizers from Symphony's 1,952 LOC status dashboard
- Pure additive dashboard enhancement with zero architectural risk

**ARCH10X-007: GSD Structural Verification as Pre-BMAD Gate**
- Run filesystem existence checks (do claimed files exist? do referenced commits exist?) before BMAD review
- Catches phantom completions at near-zero cost, saving BMAD review tokens
- GSD's verify.cjs code is essentially ready to transplant

#### Investigate (2)

**ARCH10X-004: Wave Decomposition for Intra-Story Parallelism** — 2-3x speedup potential but high implementation complexity (multi-worktree per story, task decomposition intelligence)

**ARCH10X-005: ObservabilityPubSub for Real-Time Event Distribution** — Reduces SSE latency from 500ms to near-zero but requires cross-process pub/sub mechanism

#### Defer (1)

**ARCH10X-003: Merge Dev+BMAD Phases** — Directly contradicts QDS's core value proposition of adversarial review through context isolation. The weaker version (ARCH10X-003b) captures the value without sacrificing integrity.

---

### Agent 10 — Transplant 10x Finder (18 additional transplant candidates)

#### Highest-Value Missed Transplants

**TXPLANT-013 (CRITICAL): GSD core.cjs MODEL_PROFILES table**
- 12 agent types × 3 cost tiers (quality/balanced/budget) with specific model names
- Maps directly to FR36 (model tier directives) and FR134 (capability tiers)
- Port complexity: LOW (CJS→ESM TypeScript with type annotations)

**TXPLANT-002 (CRITICAL): PaperclipAI heartbeat.ts (remaining 2,117 LOC)**
- Session 6 only extracted ~200 LOC. The remaining code contains workspace resolution, execution pipeline, orphan reaping, and task checkout patterns mapping to 5+ ADRs.
- Port complexity: MEDIUM (Postgres→SQLite, multi-tenant→single-tenant)

**TXPLANT-001 (HIGH): PaperclipAI agents.ts**
- 634 LOC with config revision tracking, rollback on bad config, soft delete pattern
- Maps to FR22 (agent lifecycle), FR25 (stop agent), FR83 (meta-optimization revert)
- Port complexity: LOW (TypeScript→TypeScript)

**TXPLANT-008 (HIGH): DeerFlow clarification_middleware.py**
- 174 LOC implementing human escalation/interrupt with question type taxonomy (yes/no, choice, text, confirmation)
- Maps directly to ADR-014 M6 (async dialogue) and FR22 (human escalation)
- Port complexity: MEDIUM (Python→TypeScript)

**TXPLANT-017 (HIGH): Symphony status_dashboard.ex algorithms**
- 1,952 LOC (largest untapped file). Sparkline algorithms, throughput tracking, rate limit parsing, 40+ event humanizers
- Port algorithms only (~600 LOC useful), skip ANSI rendering

#### Revised Transplant Inventory (Original + Newly Identified)

| Category | Session 6 Realistic | Newly Identified | Total Available |
|----------|-------------------|-----------------|-----------------|
| PaperclipAI | ~730 LOC | ~1,500 LOC | ~2,230 LOC |
| GSD | ~1,019 LOC | ~450 LOC | ~1,469 LOC |
| DeerFlow | ~555 LOC | ~500 LOC | ~1,055 LOC |
| Symphony | ~565 LOC | ~600 LOC | ~1,165 LOC |
| **Total** | **~2,869 LOC** | **~3,050 LOC** | **~5,919 LOC** |

---

## Cross-Wave Synthesis: Contradicting Findings and Resolutions

### Contradiction 1: Scope vs. Ambition
- **Scope Creep Detector** says: defer 23 FRs to Growth, MVP is too large
- **10x Capability Finder** says: add even MORE capabilities (continuous Nyquist, adaptive hooks, predictive intervention)
- **Resolution:** The Scope Creep Detector is right about the CURRENT 31 FRs. But the 10x opportunities are DIFFERENT from the current FRs — they are cross-system emergent capabilities that arise from combining existing data flows. The fix: defer the 23 FRs that add standalone subsystems (tiers, credits, wave decomposition), and instead invest in the 3 MVP-ready 10x capabilities (continuous Nyquist, adaptive hooks, predictive burn rate) that improve the EXISTING pipeline without new subsystems.

### Contradiction 2: Transplant Code vs. Write Fresh
- **Transplant Viability Auditor** says: only ~2,869 LOC is truly transplantable (down from 5,302 claimed)
- **Transplant 10x Finder** says: there's ~3,050 LOC in the research repos that was MISSED
- **Resolution:** Both are correct. Session 6 overcounted some transplants (DeerFlow hooks.ts, GSD verify.cjs non-verification code) while undercounting others (PaperclipAI middleware chain, GSD MODEL_PROFILES, Symphony dashboard algorithms). The net available is actually ~5,919 LOC — slightly more than claimed, but from DIFFERENT files than originally identified. The transplant inventory needs a complete refresh.

### Contradiction 3: Credit Economy vs. Simple Scoring
- **Perverse Incentive Hunter** says: credit economy creates gaming incentives
- **Economic Stress-Tester** says: credit economy doesn't map to single-principal architecture
- **Resolution:** Both reach the same conclusion from different directions. Replace the credit marketplace abstraction with direct Factory Core control: weighted composite scoring for routing decisions, global budgets for cost control. Credits and per-agent budgets can return in Vision phase when the system supports persistent multi-agent operation.

---

## Ranked Master Finding List

### CRITICAL (19 findings)

| # | ID | Finding | Category |
|---|----|---------| ---------|
| 1 | CONS-001 | Three-way cost/credit/budget tracking split | Consistency |
| 2 | CONS-002 | Dual source of truth for action scores | Consistency |
| 3 | CONS-003 | Tier 5 eliminates quality gates | Consistency |
| 4 | CONS-004 | Per-turn Nyquist verification is prohibitively expensive | Consistency |
| 5 | SCOPE-001 | Full 6-layer performance system in MVP not viable | Scope |
| 6 | SCOPE-010 | 153-FR MVP is V1.0 masquerading as MVP | Scope |
| 7 | COMP-001 | No tier demotion criteria | Completeness |
| 8 | COMP-002 | No negative credit balance policy | Completeness |
| 9 | COMP-009 | No ELO migration strategy | Completeness |
| 10 | COMP-011 | No Nyquist-vs-BMAD disagreement protocol | Completeness |
| 11 | TRANS-001 | costs.ts is 85% Postgres-specific | Transplant |
| 12 | TRANS-003 | verify.cjs is 87% non-verification code | Transplant |
| 13 | TRANS-007 | DeerFlow hooks.ts is irrelevant (488 LOC → 0) | Transplant |
| 14 | PERV-001 | Confidence calibration rewards base-rate prediction | Incentive |
| 15 | PERV-002 | Meta-optimization can modify scoring parameters | Incentive |
| 16 | PERV-003 | Progressive autonomy death spiral | Incentive |
| 17 | PERV-004 | Token efficiency rewards unmaintainable code | Incentive |
| 18 | ECON-001 | Credit economy solves non-existent problem at QDS scale | Economic |
| 19 | ECON-002 | Per-agent budgets create deadlocks | Economic |

### IMPORTANT (52 findings — top 20 shown)

| # | ID | Finding | Category |
|---|----|---------| ---------|
| 1 | FAIL-001 | Concurrent ELO writes cause lost updates | Failure |
| 2 | FAIL-006 | Nyquist false negatives burn fix-loop budget | Failure |
| 3 | FAIL-012 | Asymptotic approach exhausts max_turns at 89% | Failure |
| 4 | FAIL-015 | Elixir error handling lost in TypeScript port | Failure |
| 5 | FAIL-018 | Performance crash changes hook enforcement | Failure |
| 6 | FAIL-020 | Multi-system failure from shared resource | Failure |
| 7 | CONS-007 | Circular dependency: scoring→tier→hooks→scoring | Consistency |
| 8 | CONS-011 | Two SQLite access patterns (Drizzle + bun:sqlite) | Consistency |
| 9 | PERV-005 | Domain specialization collapse | Incentive |
| 10 | PERV-007 | Learning system amplifies scoring-optimized patterns | Incentive |
| 11 | PERV-009 | Tier boundary thrashing | Incentive |
| 12 | PERV-011 | Self-fulfilling tier prophecy via overlay injection | Incentive |
| 13 | ECON-003 | ELO needs 3-6 months to stabilize | Economic |
| 14 | ECON-004 | 75K+ YAML files degrade filesystem performance | Economic |
| 15 | SCOPE-003 | Transplant effort multiplier 1.5-3.0x not 1:1 | Scope |
| 16 | SCOPE-004 | Deep dependency chains extend critical path | Scope |
| 17 | COMP-020 | Performance Dashboard empty state insufficient | Completeness |
| 18 | COMP-025 | No error path for confidence calibration corruption | Completeness |
| 19 | COMP-026 | Workspace hooks create orphaned resources | Completeness |
| 20 | COMP-027 | Credit deadlock when all agents negative | Completeness |

---

## Concrete Recommendations Summary

### Immediate Actions (Before Implementation Begins)

1. **Refresh the transplant inventory** — recalculate LOC from verified analysis, add the 18 newly identified transplant candidates, remove TRANS-007 (DeerFlow hooks.ts)
2. **Split MVP/Growth for new FRs** — apply the SCOPE-010 table: keep 8 FRs in MVP, defer 23 to Growth
3. **Resolve the dual source of truth** — pick `pipeline.db` (SQLite) as the single source for action scores, ELO ratings, and credit balances. YAML files are read-only exports.
4. **Kill per-agent budgets and credit marketplace** — replace with per-story + global budget enforcement + weighted composite routing
5. **Cap minimum hook enforcement at L3** — no agent, regardless of tier, skips phase boundary hooks
6. **Port Drizzle schemas to bun:sqlite** — one database access pattern, not two

### Architecture Amendments

7. **Adopt bidirectional middleware chain** (ARCH10X-001) — replace `OverlayStage` interface with `Middleware` interface supporting `before_model()` and `after_model()`
8. **Adopt generalized channel abstraction** (ARCH10X-002) — replace Telegram-only messenger with DeerFlow's multi-channel architecture
9. **Add pre-BMAD structural verification gate** (ARCH10X-007) — transplant GSD's artifact/key_link existence checks
10. **Add system-level health circuit breaker** (FAIL-020) — pause new story starts when 3+ subsystems report errors

### Performance System Fixes

11. **Add tier demotion criteria** (COMP-001) — ELO below threshold - 50 for 3 consecutive stories
12. **Add hysteresis to tier transitions** (PERV-009) — 50-point buffer zone, 3-story dwell requirement
13. **Add random audit mechanism** (PERV-003) — 1 in 3 stories for Tier 3+ agents get full Tier 1 hook density
14. **Replace raw token efficiency scoring** (PERV-004) — bounded step function, penalties only for >3x median
15. **Add confidence resolution requirement** (PERV-001) — spread requirement across [0.2, 0.9] range
16. **Don't inject agent's own tier into its overlay** (PERV-011) — breaks self-reinforcing loop
17. **Add 15% exploration factor to routing** (PERV-005) — prevents domain specialization collapse
18. **Anchor difficulty estimation to objective metrics** (PERV-012) — not LLM judgment

### 10x Capability Investments

19. **Implement continuous lightweight Nyquist** (10X-002) — filesystem-only must_haves checks as post-task hook during development
20. **Implement adaptive hook density** (10X-009) — dynamic escalation when confidence is miscalibrated
21. **Implement basic burn rate prediction** (10X-008) — projected cost display on dashboard + Telegram notification

---

## Success Criteria Verification

| Criterion | Status |
|-----------|--------|
| Every new FR (130-160) challenged by at least one agent | **MET** — Consistency, Scope, Completeness, and Incentive agents covered all 31 FRs |
| Every new ADR (015-020) stress-tested | **MET** — All 6 ADRs challenged for internal consistency and cross-ADR conflicts |
| ELO/tier/credit economy tested for perverse incentives | **MET** — 16 specific gaming scenarios identified with concrete mitigations |
| Transplant inventory verified against source code | **MET** — 16 source files read and verified; revised from 5,302 to ~2,869 LOC |
| At least 5 concrete 10x opportunities identified | **MET** — 11 capability opportunities + 8 architectural opportunities + 18 transplant opportunities |
| Ranked findings report produced | **MET** — This document |

---

*Generated by 11-agent adversarial swarm. Waves: 4 structural integrity agents → 3 economic/incentive agents → 3 opportunity identification agents → 1 synthesis agent.*
