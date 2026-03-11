# Architecture Amendments — Session 8

**Date:** 2026-03-10
**Scope:** Adversarial synthesis of Session 7 findings (19 critical, 52+ important) into revised ADR-015 through ADR-020 and three new ADRs (021-023)
**Resolves:** All 19 critical findings from Session 7 adversarial review
**Supersedes:** ADR-015 through ADR-020 as written in `architecture.md` (Session 6)

---

## Section 1: Amendment Preamble

### 1.1 Architectural Reframing

**Factory Core is the FOUNDATION, not a peer component.** Factory Core owns the pipeline engine, phase boundaries, economic governance, self-learning extraction, and overlay composition. It is the brain that orchestrates all other components.

**Overstory, Pi SDK, and Superpowers are COMPONENTS that Factory Core calls into:**

| Component | Relationship to Factory Core | What Factory Core Uses |
|-----------|------------------------------|----------------------|
| **Overstory** | Agent orchestration library | `ov sling` for spawning, worktree isolation, 4-tier merge, mail.db for inter-agent comms, sessions.db for lifecycle, events.db for event store, metrics.db for telemetry, Seeds for task tracking, watchdog for health |
| **Pi SDK** | Model-agnostic LLM runtime | Model selection, provider routing, tool execution, per-call `Usage { tokens, cost }` reporting, `AgentSession` with save/load/branch/compact |
| **Superpowers** | Read-only skill library | 14 skills, enforcement frontmatter, skill metadata for overlay injection |

**Research repos are DESIGN INSPIRATION, not code transplant sources.** Session 7 demonstrated that the claimed 79% transplant ratio was inflated to ~43% on verified analysis. More importantly, the framing of "transplant" implies lifting code wholesale, which creates integration debt. The correct framing: we study proven patterns from PaperclipAI, GSD, DeerFlow, and Symphony, then write clean TypeScript/Bun code for our stack that embodies those patterns. We cite inspiration sources for traceability, but every line of code is native QDS code written to our conventions.

### 1.2 Autonomous Merge Philosophy

QDS Engineer v2 executes entire epics through a phased quality pipeline. Code merges automatically without human oversight because the pipeline's quality verification is thorough enough to make human review the exception, not the rule:

- **Context isolation** ensures review agents never see development context (no sunk-cost bias)
- **BMAD adversarial review** is spec-compliance verification by fresh agents
- **5-wave QA swarm** covers structural, behavioral, and integration verification
- **Nyquist verification** (ADR-017) confirms the story's purpose was achieved, not just its tasks
- **Continuous lightweight verification** catches structural drift during development
- **Human escalation** is triggered only when automated systems cannot resolve disagreements

When issues escape this pipeline, **24/7 maintenance/QA agents** (cron-triggered) continuously scan the codebase, discover regressions, and dispatch fixes through the same quality pipeline. The next scan cycle verifies fixes landed correctly. This creates the autonomous self-healing loop.

### 1.3 Self-Learning Vision

The primary metric for the self-learning system is **maintenance burden reduction over time**. Not agent "performance scores" or "reward credits" but the observable outcome: does the codebase require less maintenance as the system accumulates experience?

Three learning layers serve this goal:

1. **Codebase Knowledge (Layer 1):** What conventions, patterns, and integration points exist in this specific codebase. Enriches Overstory's mulch with structured learnings from fix-loops and maintenance fixes.
2. **Pattern Knowledge (Layer 2):** Cross-story insights ("modifying payments always requires webhook updates"). Mined from accumulated story data, stored in pipeline.db.
3. **Process Knowledge (Layer 3):** Factory operational tuning (which phase configurations produce best outcomes). Derived from pipeline execution metrics.

The feedback loop: every maintenance fix produces a categorized learning record that feeds back into overlay composition for future stories, reducing the probability of the same class of issue recurring.

---

## Section 2: Revised ADR-015 — Agent Performance & Learning System

**Status:** Proposed (Revised)
**Replaces:** ADR-015 "Agent Performance & Reward System (6-Layer Architecture)" from Session 6
**Resolves:** SCOPE-001, CONS-002, CONS-003, CONS-007, CONS-011, COMP-001, COMP-009, ECON-001, ECON-004, PERV-001, PERV-002, PERV-003, PERV-004, PERV-005, PERV-009, PERV-011, FAIL-001, FAIL-018

### 2.1 Renaming and Scope

**Renamed from** "Performance & Reward System" **to** "Performance & Learning System."

The credit economy is killed entirely (ECON-001). Per-agent budgets are killed (ECON-002). There are no "rewards" in this system. There is data collection, learning extraction, and (in Growth phase) behavioral routing based on demonstrated capability.

### 2.2 MVP vs Growth Scope (SCOPE-001)

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

### 2.3 Storage — Single Source of Truth (CONS-002, ECON-004, CONS-011, FAIL-001)

**All performance data lives in `pipeline.db` (SQLite via bun:sqlite).** No YAML files for mutable performance state. No Drizzle ORM.

| What Changed | Old (Session 6) | New (Session 8) | Finding |
|-------------|-----------------|-----------------|---------|
| Action scores | `.qds/performance/actions/` YAML files | `pipeline.db` `action_scores` table | CONS-002, ECON-004 |
| Session composites | `.qds/performance/sessions/` YAML files | `pipeline.db` `session_composites` table | CONS-002 |
| ELO ratings (Growth) | `ratings.yaml` single file | `pipeline.db` `elo_ratings` table | FAIL-001 |
| Tier assignments (Growth) | `tiers.yaml` single file | `pipeline.db` `tier_assignments` table | CONS-002 |
| Database access | Drizzle ORM (transplanted from PaperclipAI) | `bun:sqlite` direct access | CONS-011 |

**YAML files are read-only exports** computed from SQLite for human inspection. They are generated on-demand (dashboard export button, CLI command), never written to directly, and never read as a source of truth.

**Why bun:sqlite, not Drizzle ORM (CONS-011):** Overstory already uses `bun:sqlite` direct access for sessions.db, mail.db, events.db, and metrics.db. Introducing Drizzle ORM for Factory Core tables creates two SQLite access patterns in the same codebase with different transaction semantics, different migration strategies, and different error handling. One pattern. `bun:sqlite` direct access with Zod schema validation at read boundaries.

**Concurrency safety (FAIL-001):** SQLite WAL mode with `bun:sqlite`'s synchronous API eliminates the concurrent-write lost-update problem that would have affected `ratings.yaml`. SQLite handles locking; our code does not need to.

### 2.4 pipeline.db Schema — Performance Tables

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

### 2.5 Three-Layer Learning Architecture

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

### 2.6 pipeline.db Schema — Learning Tables

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

### 2.7 Maintenance Agent Feedback Loop

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

### 2.8 Tier Demotion Criteria (COMP-001) — Growth Phase Only

Agents can be demoted, not just promoted. Demotion prevents the "promote and forget" failure mode where a high-tier agent with reduced oversight degrades without detection.

**Demotion trigger:** ELO rating drops below `tier_threshold - 50` for 3 consecutive story completions.

**Example:** Tier 3 requires ELO >= 1350. If an agent's ELO drops below 1300 (1350 - 50) and stays below 1300 for 3 consecutive stories in that domain, the agent is demoted to Tier 2.

**Hysteresis (PERV-009):** Tier transitions use a 50-point buffer and 3-story dwell requirement to prevent thrashing:

- **Promotion threshold:** `tier_threshold` (e.g., 1350 for Tier 3)
- **Demotion threshold:** `tier_threshold - 50` (e.g., 1300 for Tier 3)
- **Dwell requirement:** Agent must have completed 3 stories at current tier before promotion eligibility
- **Effect:** An agent oscillating between 1300 and 1350 stays at its current tier. Only sustained performance above 1350 (3+ stories) triggers promotion. Only sustained performance below 1300 (3+ consecutive stories) triggers demotion.

### 2.9 Confidence Resolution Requirement (PERV-001)

A perfect Brier score from an agent that always declares 30% confidence and is right 30% of the time is useless. Confidence declarations must demonstrate discriminative ability.

**Resolution requirement (Growth):** Alongside Brier score calibration, agents must demonstrate confidence spread across the [0.2, 0.9] range with positive rank correlation to outcomes.

- Minimum 3 distinct confidence buckets used across 10+ declarations
- Spearman rank correlation between declared confidence and actual outcome must be > 0.3
- Agents that only use 1-2 confidence levels get a calibration score of 0.0 regardless of Brier score

### 2.10 Token Efficiency Scoring (PERV-004)

Raw token efficiency (`tokens / files_modified`) rewards terse, unmaintainable code. Replaced with a bounded step function.

**Scoring rule:**
- Tokens consumed <= 2x domain median: score = 1.0 (no reward for being cheap)
- Tokens consumed > 2x and <= 3x median: score = 0.7 (mild concern)
- Tokens consumed > 3x median: score = 0.3 (penalty for excessive consumption)
- Tokens consumed > 5x median: score = 0.0 (hard penalty)

**Domain median** computed from `action_scores` table over the last 30 stories in the same domain. Until 10+ observations exist, median defaults to a configured per-role baseline.

### 2.11 Random Audit Mechanism (PERV-003) — Growth Phase Only

High-tier agents get fewer hooks, creating a monitoring blind spot. Random audits compensate.

- **Frequency:** 1 in 3 stories (configurable, `factory.yaml` `performance.audit_frequency`)
- **Eligibility:** All agents at Tier 3 or above
- **Effect:** Audited story runs with full Tier 1 hook density (every edit, every task, every phase boundary)
- **Scoring:** Audit story scores are weighted 1.5x in ELO calculation (elevated signal value)
- **Selection:** Random, not performance-based (prevents gaming by behaving well when likely audited)

### 2.12 Anti-Gaming Protections

| Protection | Finding | Rule |
|-----------|---------|------|
| No self-tier injection | PERV-011 | Agent's own tier level is NOT injected into its overlay. Prevents self-reinforcing confidence/caution loops. |
| Immutable scoring weights | PERV-002 | Meta-optimization (FR79-FR83) MUST NOT modify parameters that affect score computation. Scoring weights require developer approval to change. Enforced by `factory.yaml` config freeze on `performance.scoring_weights`. |
| Exploration factor in routing | PERV-005 | 15% of task routing decisions (Growth) use random agent selection instead of ELO-based routing. Prevents domain specialization collapse where agents only get work they are already good at. |
| Anchored difficulty estimation | N/A | Story difficulty estimated from objective metrics (files_modified, test_count, dependency_depth, lines_changed), NOT from LLM judgment. LLM difficulty estimates create a feedback loop with the scoring system. |

### 2.13 Fallback Behavior (FAIL-018)

When performance data is unavailable (system startup, pipeline.db corruption, performance subsystem crash):

- **MVP:** No behavioral effect — performance is observation-only
- **Growth:** Default to Tier 2 enforcement (hooks every 3 tasks). Log the fallback. Do not fail the pipeline because the performance system is down. Performance is a "soft critical path" dependency — it improves the pipeline but must not block it.

### 2.14 ELO Migration Strategy (COMP-009) — Growth Phase Only

When the scoring algorithm changes (inevitable), existing ratings must be handled gracefully.

- Algorithm changes create a new `rating_epochs` entry with incremented epoch number
- Old ratings carry forward as initial estimates with inflated `rating_deviation` (uncertainty reset to 200, not full 350)
- New epoch ELO calculations start from carried-forward ratings, not from scratch
- Old epoch data preserved in `elo_ratings` table (filtered by epoch) for historical analysis
- Migration is automatic on Factory Core startup when it detects algorithm version mismatch

### 2.15 Integration Points

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

---

## Section 3: Revised ADR-016 — Economic Governance

**Status:** Proposed (Revised)
**Replaces:** ADR-016 "Economic Governance Layer (Extends ADR-005)" from Session 6
**Resolves:** ECON-001, ECON-002, CONS-001

### 3.1 Core Change: Kill Credit Economy and Per-Agent Budgets

**Killed: Credit marketplace (ECON-001).** PaperclipAI's credit economy manages persistent autonomous agents competing for work as independent economic actors. QDS has one LLM provider running transient agent instances under single-principal control. A credit economy in this context reduces to a sorting function with unnecessary complexity. Replaced with weighted composite scoring for routing decisions in Growth phase.

**Killed: Per-agent monthly budgets (ECON-002).** Per-agent budgets (e.g., "Builder: $40/month") create deadlocks: a story needs $5 for its builder phase, but the builder role only has $2 remaining even though the global budget has $50 available. The story stalls mid-execution with no productive resolution. Replaced with two enforcement layers:

1. **Per-story budget** (FR38): Factory Core checks cumulative cost before spawning each phase's agents. If projected remaining cost exceeds story budget ceiling, the story is paused with developer notification.
2. **Global daily/monthly ceiling** (FR39): Factory Core enforces across all active stories. If the global ceiling would be exceeded, new story starts are blocked (active stories continue to completion).

**Per-role cost tracking** remains for attribution reporting visibility (dashboard shows cost-per-role breakdown) but is NOT an enforcement boundary.

### 3.2 Killed: credit_ledger (CONS-001)

The `credit_ledger` table from Session 6 is eliminated entirely. There are no credits. Cost attribution data lives in `attribution.db` as it did in ADR-005. The three-way cost/credit/budget tracking split (CONS-001) is resolved by having exactly two cost-related stores:

| Store | Purpose | Tables |
|-------|---------|--------|
| `attribution.db` | Cost attribution per API call | `cost_events` (existing from ADR-005), `task_checkouts` (new) |
| `pipeline.db` | Pipeline state including action scores | `action_scores`, `session_composites` (new from ADR-015 revised) |

No `agent_budgets` table — budgets are per-story (existing FR38 in `pipeline.db`) and global (existing FR39 in `factory.yaml` config).

### 3.3 Atomic Task Checkout

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

### 3.4 Cost Data Flow

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

### 3.5 Burn Rate Prediction

Projected cost calculation for dashboard display and notification triggers:

```
projected_total_cost = (cost_so_far / phases_completed) * total_phases
```

Where:
- `cost_so_far` = SUM of cost_events for the story
- `phases_completed` = count of completed phases (dev, bmad, qa, etc.)
- `total_phases` = total configured phases for the story's work type

If `projected_total_cost > story_budget * 0.8`, dashboard displays a warning. If `projected_total_cost > story_budget`, Telegram notification dispatched to developer.

### 3.6 Integration Points

| Integration | Direction | What Flows |
|------------|-----------|-----------|
| Pi SDK Usage callback -> attribution.db | In | Per-call cost_events |
| attribution.db -> Factory Core budget check | Out | Cumulative cost queries before agent spawn |
| Factory Core -> Seeds (Overstory) | Both | Task identification and atomic checkout |
| attribution.db -> Dashboard | Out | Cost breakdown, burn rate, projections |
| attribution.db -> Telegram (ADR-014) | Out | Budget warning/exceeded notifications |

---

## Section 4: Revised ADR-017 — Continuous Verification (Nyquist Layer)

**Status:** Proposed (Revised)
**Replaces:** ADR-017 "Goal-Backward Verification — Nyquist Layer" from Session 6
**Resolves:** CONS-004, COMP-011, FAIL-006, ARCH10X-007, 10X-002

### 4.1 Renaming and Two-Mode Architecture

Renamed from "Goal-Backward Verification" to "Continuous Verification" to reflect the expanded scope. The Nyquist layer now operates in two modes:

| Mode | When | Cost | What It Checks |
|------|------|------|---------------|
| **Lightweight continuous** | Post-task hook during development | Near-zero (filesystem only, no LLM) | Artifact existence, key_link pattern matching, structural integrity |
| **Full Nyquist** | After QA swarm completion (QA boundary) | ~$0.005 (economy-tier model, ~30s) | Complete must_haves verification including behavioral checks (truths) |

### 4.2 Lightweight Continuous Verification (10X-002)

**Runs as a post-task hook during the development phase.** After every task completion (not every edit), a filesystem-only check verifies structural integrity:

1. **Artifact existence:** Do the files declared in `must_haves.artifacts` exist? Do they meet `min_lines` threshold?
2. **Key link pattern matching:** Do `must_haves.key_links` source files contain the required import/reference patterns (regex match against file content)?
3. **No LLM calls.** Pure filesystem operations: `existsSync()`, `readFileSync()`, regex match.
4. **Duration target:** <500ms per check (filesystem I/O only).
5. **Output:** Pass/fail per check. Fails are injected into the agent's next turn as "structural drift detected" context.

**What it does NOT check:** Behavioral truths (e.g., "JWT tokens expire after 15 minutes") require test execution or LLM judgment. Those remain in full Nyquist at the QA boundary.

**Expected impact (10X-002):** 40-50% fix-loop reduction by catching structural drift (missing files, broken imports, incomplete wiring) during development instead of after BMAD review. 25-35% token savings on stories that would have entered fix loops.

**Design inspiration:** GSD `verify.cjs` `cmdVerifyArtifacts()` and `cmdVerifyKeyLinks()` functions (~113 LOC). Our implementation is ~150 LOC new-write in TypeScript, operating on the same `must_haves` schema but using `bun:sqlite` for result storage and Bun filesystem APIs.

### 4.3 Full Nyquist at QA Boundary

Unchanged from Session 6 in purpose, refined in execution:

1. Story spec declares `must_haves` section (truths, artifacts, key_links)
2. After QA swarm completes, Nyquist verifier agent runs
3. Verifier starts from story GOAL, not task checklist
4. **Truths:** Observable behaviors verified by test assertions or runtime checks
5. **Artifacts:** Files/functions with `min_lines`, `contains`, `exports` constraints (superset of lightweight checks)
6. **Key links:** Integration wiring with regex pattern matching (superset of lightweight checks)
7. Produces VERIFICATION.md with pass/fail per check, gaps identified
8. Gaps feed into fix loop (FR7)

### 4.4 Pre-BMAD Structural Gate (ARCH10X-007)

Before BMAD review begins, a lightweight structural check runs:

- Do all files claimed in the transfer manifest actually exist?
- Do claimed commits exist in the branch history?
- Do file sizes match claimed line counts (within 20% tolerance)?

**Purpose:** Catches "phantom completions" (agent claimed to create files that do not exist) before spending BMAD review tokens. Cost: near-zero (filesystem checks). Savings: ~$0.02-0.05 per phantom completion caught.

**Implementation:** Runs as a `before_run` workspace hook (ADR-018) for the BMAD phase.

### 4.5 Oscillation Detection for False Negatives (FAIL-006)

When the Nyquist verifier incorrectly reports gaps, the fix loop burns budget on non-issues. Detection mechanism:

1. Fix loop iteration N produces gap list G_N
2. Fix loop runs, modifies code
3. Fix loop iteration N+1 re-runs Nyquist, produces gap list G_{N+1}
4. **If G_{N+1} == G_N AND the fix loop did not modify any files referenced in the gaps:** flag as potential false negative
5. **Action:** Escalate to developer (Telegram notification) instead of iterating. Include the gap list and evidence that the code was not modified.
6. **Hard cap:** After 2 consecutive identical gap lists with no relevant code changes, force-exit the fix loop with `verification_inconclusive` status.

### 4.6 Nyquist-BMAD Disagreement Protocol (COMP-011)

BMAD (FR19-FR21) and Nyquist (this ADR) are independent quality systems. When they disagree:

| Scenario | Tiebreaker | Rationale |
|----------|-----------|-----------|
| BMAD pass, Nyquist fail on **structural completeness** (missing artifacts, broken key_links) | **Nyquist wins** | Structural checks are objective and deterministic. BMAD may have hallucinated file existence. |
| BMAD fail, Nyquist pass on **spec compliance** (behavioral requirements, design decisions) | **BMAD wins** | BMAD has full spec context; Nyquist checks structure, not intent. |
| Both fail on **different** issues | **Both gaps addressed** in fix loop | No conflict — additive gap lists. |
| Both fail on **same** issue with different assessments | **Escalate** to developer | Genuine ambiguity requires human judgment. |

### 4.7 must_haves Schema

Unchanged from Session 6:

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

### 4.8 Integration Points

| Integration | Direction | What Flows |
|------------|-----------|-----------|
| Story spec -> Nyquist | In | `must_haves` section |
| Post-task hook -> Lightweight verifier | Trigger | Runs after each task in dev phase |
| Lightweight verifier -> Agent context | Out | Structural drift warnings injected into next turn |
| QA swarm completion -> Full Nyquist | Trigger | Runs after Wave 5 completes |
| Full Nyquist -> Fix loop (FR7) | Out | Gap list feeds remediation |
| Full Nyquist -> VERIFICATION.md | Out | Per-check results stored in `.qds/verifications/` |
| Full Nyquist <-> BMAD disagreement | Protocol | Tiebreaker rules per Section 4.6 |
| Pre-BMAD gate -> BMAD phase | Gate | Phantom completion check before review |

---

## Section 5: Revised ADR-018 — Workspace Lifecycle Hooks

**Status:** Proposed (Revised)
**Replaces:** ADR-018 "Workspace Lifecycle Hooks (Extends ADR-002)" from Session 6
**Resolves:** CONS-003, COMP-026, FAIL-020

### 5.1 Hook Points (Unchanged)

Four hook points remain as defined in Session 6:

| Hook | Trigger | Default Action | Configurable |
|------|---------|---------------|-------------|
| `after_create` | Worktree created via `git worktree add` | Install dependencies, copy `.env` template | Yes, `factory.yaml` `workspace.hooks.after_create` |
| `before_run` | Before first agent spawns in worktree | Verify dependencies, check disk space, pre-BMAD structural gate | Yes, `factory.yaml` `workspace.hooks.before_run` |
| `after_run` | After story completion (success or failure) | Collect metrics, extract learning records | Yes, `factory.yaml` `workspace.hooks.after_run` |
| `before_remove` | Before worktree cleanup | Verify no uncommitted changes, archive logs | Yes, `factory.yaml` `workspace.hooks.before_remove` |

### 5.2 L3 Minimum Enforcement Cap for All Tiers (CONS-003)

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

### 5.3 Hook Rollback on Partial Failure (COMP-026)

Hooks that fail during workspace creation must clean up after themselves:

| Hook | Failure Behavior |
|------|-----------------|
| `after_create` fails | **Rollback:** Remove the created worktree (`git worktree remove --force`), set story status to `failed_setup`, log diagnostic, notify developer. Do NOT leave an unusable worktree. |
| `before_run` fails | **Block:** Story fails with diagnostic. Worktree preserved for inspection. Developer can retry after fixing the issue. |
| `after_run` fails | **Warn:** Log warning, story completion status unaffected. Learning extraction from this story may be incomplete. |
| `before_remove` fails | **Warn:** Log warning, cleanup proceeds. If uncommitted changes detected, archive them to `.qds/orphaned-changes/` before removal. |

### 5.4 Timeout Handling During I/O Degradation (FAIL-020)

Hook timeouts auto-adjust when the system health circuit breaker (ADR-023) detects I/O stress:

- **Normal mode:** Hook timeout per `factory.yaml` configuration (default 30s)
- **Degraded mode (circuit breaker active):** Hook timeout doubled automatically (60s)
- **Mechanism:** Hooks read timeout from Factory Core config, which is dynamically adjusted by the circuit breaker. No hook code changes needed.

### 5.5 Execution Model

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

### 5.6 Integration Points

| Integration | Direction | What Flows |
|------------|-----------|-----------|
| Factory Core -> Overstory worktree manager | Wraps | Hooks fire around `git worktree add/remove` |
| `before_run` -> Nyquist lightweight check (ADR-017) | Contains | Pre-BMAD structural gate is a `before_run` hook for BMAD phase |
| Hook failure -> Story state (pipeline.db) | Out | `after_create` failure sets story to `failed_setup` |
| Circuit breaker (ADR-023) -> Hook timeouts | Modifies | Doubles timeouts during degraded mode |
| `after_run` -> Learning extraction (ADR-015) | Triggers | Learning records extracted from story results |

---

## Section 6: Revised ADR-019 — Turn Continuation

**Status:** Proposed (Revised)
**Replaces:** ADR-019 "Turn-Based Agent Continuation (Extends ADR-002)" from Session 6
**Resolves:** CONS-004, FAIL-012, FAIL-015

### 6.1 Lightweight Per-Turn Signals, Not Full Nyquist (CONS-004)

The original ADR-019 used "goal-backward check from ADR-017" to determine if the phase goal was achieved after each turn. ADR-017's full Nyquist verifier was designed to run once after QA, not per-turn during development. Running it per-turn is prohibitively expensive.

**New per-turn goal check uses lightweight signals only:**

1. **Post-task hook pass/fail result** (already computed, zero marginal cost)
2. **Lightweight Nyquist structural check** (filesystem-only, <500ms, from ADR-017 Section 4.2)
3. **Checklist completion** — percentage of declared subtasks marked complete in the agent's working context

**Decision logic:**
- All signals green AND checklist >= 90% complete: phase goal considered achieved, trigger transition
- Any signal red OR checklist < 90%: continue to next turn (if turns remain)
- Full Nyquist runs only at QA boundary, never during turn continuation

### 6.2 Turn Loop

1. Agent receives task within phase
2. Agent executes turn (single model invocation with tool calls via Pi SDK)
3. Post-task hook fires, computes action score, runs lightweight structural check
4. Factory Core evaluates: goal achieved? (per Section 6.1 decision logic)
5. If goal NOT achieved AND `turn_number < max_turns`: inject continuation prompt, execute next turn
6. If goal achieved OR `max_turns` reached: trigger phase transition

### 6.3 Progress Velocity Check (FAIL-012)

When `max_turns` is reached but the goal is not yet complete, a blanket phase transition wastes the 89% of work already done. The fresh BMAD agent must re-understand nearly-complete code from scratch.

**New rule:** If ALL of the following conditions are met, Factory Core extends `max_turns` by 1:

- Agent made measurable progress in the last turn (at least 1 new file modified or 1 new test passing)
- Goal completion is >75% (based on checklist completion + structural checks)
- Current `turn_number < max_turns * 1.5` (hard cap prevents infinite extension)

**Example:** `max_turns = 5`, agent reaches turn 5 at 85% completion with progress in the last turn. Extension grants turn 6. If turn 6 reaches 92% with progress, extension grants turn 7. Hard cap is `5 * 1.5 = 7.5 -> 7`, so turn 7 is the absolute maximum.

### 6.4 Defensive Error Normalization (FAIL-015)

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

### 6.5 Turn State Persistence (FAIL-015)

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

### 6.6 Continuation Prompt Template

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

### 6.7 Configuration

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

### 6.8 Integration Points

| Integration | Direction | What Flows |
|------------|-----------|-----------|
| Pi SDK AgentSession -> Turn loop | Bidirectional | Pi handles model calls; Factory Core manages turn loop logic |
| Post-task hooks (ADR-010) -> Turn decision | In | Hook pass/fail feeds goal-check decision logic |
| Lightweight Nyquist (ADR-017) -> Turn decision | In | Structural check results feed goal-check decision |
| Turn state -> pipeline.db | Persist | Survives crashes, enables resume |
| Turn loop -> Stall detection (FR47) | Integration | Stall timeout is per-turn, not per-phase |
| Continuation prompt -> Agent context | Out | Injected via Factory Core before next Pi SDK call |

---

## Section 7: Revised ADR-020 — Design Inspiration Strategy

**Status:** Proposed (Revised)
**Replaces:** ADR-020 "Code Transplant Strategy" from Session 6
**Resolves:** TRANS-001, TRANS-003, TRANS-007, CONS-011, SCOPE-003

### 7.1 Complete Rewrite: Inspiration, Not Transplant

**Research repos are DESIGN INSPIRATION, not transplant sources.** Session 7 demonstrated:

- Claimed 79% transplant ratio was inflated to ~43% on verified analysis (TRANS-001, TRANS-003, TRANS-007)
- DeerFlow `hooks.ts` was 488 LOC of irrelevant React chat hooks, not performance dashboard code (TRANS-007: 488 -> 0 LOC)
- GSD `verify.cjs` was 87% project health tooling unrelated to goal verification (TRANS-003: 820 -> ~150 LOC)
- PaperclipAI `costs.ts` was 85% Postgres-specific (TRANS-001: 204 -> ~80 LOC)
- Effort multipliers range from 1.5x (TypeScript->TypeScript) to 3.0x (Elixir->TypeScript) (SCOPE-003)

**New framing:** We do not count LOC transplanted. We document what patterns we learned from each repo and write clean TypeScript/Bun code that embodies those patterns, conforming to QDS conventions (bun:sqlite, Zod schemas, atomic writes, EventStore events, shared-types package).

### 7.2 Pattern Inspiration Table

| Capability | Source Pattern | What We Learned | QDS Implementation |
|-----------|---------------|----------------|-------------------|
| Action scoring | PaperclipAI `activity-log.ts` audit trail | Event-sourced activity logging with cost attribution | `factory-core/src/performance/action-scorer.ts` — ~120 LOC new-write, bun:sqlite |
| Confidence scoring | DeerFlow `memory/updater.py` | Brier score calibration with decay weighting | `factory-core/src/performance/confidence.ts` — ~80 LOC new-write |
| Atomic task checkout | PaperclipAI `agent_wakeup_requests.ts` `claimedAt` | SQLite UNIQUE constraint as distributed lock | `factory-core/src/pipeline/task-checkout.ts` — ~30 LOC new-write |
| Cost aggregation | PaperclipAI `costs.ts` (portable 80 LOC) | SUM/GROUP BY with time-window filtering | `factory-core/src/economics/cost-queries.ts` — ~60 LOC new-write |
| Must-haves verification | GSD `verify.cjs` `cmdVerifyArtifacts()` + `cmdVerifyKeyLinks()` (~113 LOC) | Artifact existence + key_link regex pattern matching | `factory-core/src/verification/nyquist.ts` — ~150 LOC new-write |
| Workspace hooks | Symphony `workspace.ex` (275 LOC) | 4-point lifecycle hook pattern with failure-mode-per-hook | `factory-core/src/worktree/lifecycle-hooks.ts` — ~200 LOC new-write |
| Turn continuation | Symphony `agent_runner.ex` (154 LOC) | Turn loop with continuation prompt template | `factory-core/src/pipeline/turn-continuation.ts` — ~180 LOC new-write |
| Bidirectional middleware | DeerFlow `agents/middleware/` | before_model/after_model pattern for pipeline composition | `factory-core/src/middleware/` — ~300 LOC new-write (ADR-021) |
| Multi-channel notification | DeerFlow `modules/channel/` | MessageBus + Channel base class pattern | `factory-core/src/notifications/` — ~250 LOC new-write (ADR-022) |
| Model profiles | GSD `core.cjs` MODEL_PROFILES | Agent-type to model-tier mapping table | `factory-core/src/config.ts` extension — ~50 LOC |
| Agent lifecycle | PaperclipAI `agents.ts` | Config revision tracking, soft delete | Design reference for FR22/FR25 implementation |
| Dashboard algorithms | Symphony `status_dashboard.ex` (600 LOC useful) | Sparkline computation, throughput tracking, event humanization | Dashboard utility functions — Growth phase |

### 7.3 Database Access: bun:sqlite Only (CONS-011 Resolved)

**Decision:** All SQLite access in the QDS codebase uses `bun:sqlite` direct API. No Drizzle ORM.

**Rationale:**
- Overstory already uses `bun:sqlite` for 4 databases (sessions.db, mail.db, events.db, metrics.db)
- Factory Core adds 2 databases (pipeline.db, attribution.db)
- One access pattern means one transaction model, one migration strategy, one error handling approach
- Zod schema validation at read boundaries provides the type safety that Drizzle ORM would have provided at the schema level
- `bun:sqlite` is synchronous, which matches the Bun event loop model (no async overhead for DB operations)

**Migration strategy:** SQL migration files in `factory-core/src/migrations/` applied at startup. Each migration file is a SQL script with a version number. Factory Core tracks applied migrations in a `schema_migrations` table.

### 7.4 All Code Follows QDS Conventions

Regardless of inspiration source, all code must:

- Use `bun:sqlite` for database access (not Drizzle, not `better-sqlite3`)
- Define types in `shared-types` package with Zod schemas as source of truth
- Use `kebab-case.ts` file naming, `PascalCase` types, `camelCase` functions
- Use atomic write patterns (temp file + rename) for any filesystem state
- Emit events to EventStore for observability
- Pass existing lint rules (Biome) and type-check
- Stay under 500 LOC per file

---

## Section 8: NEW ADR-021 — Bidirectional Middleware Chain

**Status:** Proposed
**Finding:** ARCH10X-001
**Decision:** Introduce an organizational pattern where each cross-cutting concern has `beforeModel()` and `afterModel()` phases, replacing the unidirectional overlay pipeline with a bidirectional middleware chain.

### 8.1 Clarification: Organizational Pattern, Not Runtime Framework

This is NOT a new runtime execution engine. It is an organizational pattern that gives structure to two things that already happen:

1. **Overlay assembly** (already happens once per agent session via `overlay.ts`)
2. **Post-action processing** (already happens via hooks after each task/phase)

The middleware pattern unifies these into a coherent structure where each cross-cutting concern (budget, credentials, learning, enforcement, skills, performance, verification) owns both its "before" and "after" logic in one place, rather than scattering related logic across overlay stages and hook handlers.

### 8.2 Middleware Interface

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

### 8.3 Middleware Execution Model

**`beforeModel()` runs at overlay assembly time** (once per agent session, when Factory Core composes the overlay for a new agent). Each middleware's `beforeModel()` can:

- Add content to the overlay context (e.g., budget middleware injects remaining budget)
- Block agent spawn (e.g., budget middleware rejects if ceiling exceeded)
- Read from its data source (pipeline.db, attribution.db, Superpowers metadata)

**`afterModel()` runs at task/turn completion time** (via the existing post-task hook pipeline). Each middleware's `afterModel()` can:

- Record data (e.g., performance middleware writes action score)
- Update state (e.g., learning middleware extracts new learnings)
- Trigger side effects (e.g., verification middleware runs lightweight structural check)

### 8.4 Middleware Components

| # | Middleware | Order | `beforeModel()` | `afterModel()` |
|---|----------|-------|-----------------|----------------|
| 1 | `budget-middleware` | 10 | Check per-story + global budget ceiling. Block if exceeded. | Record cost from Pi SDK Usage callback. Update cumulative totals. |
| 2 | `credential-middleware` | 20 | Inject API keys via Pi SDK configuration (no keys in overlay text). | Sanitize any output that might contain leaked credentials. |
| 3 | `learning-middleware` | 30 | Query `learning_records` and `pattern_knowledge` for relevant domain learnings. Inject into overlay (~500 tokens). | Extract learning records from fix-loop/maintenance results. Write to pipeline.db. |
| 4 | `enforcement-middleware` | 40 | Inject iron laws, conventions, and gate rules from Superpowers frontmatter. | Log gate pass/fail results. Update enforcement statistics. |
| 5 | `skill-middleware` | 50 | Inject skill descriptions from Superpowers metadata (read-only). | No-op. Skills are read-only context. |
| 6 | `performance-middleware` | 60 | (Growth only) Inject performance context. Do NOT inject agent's own tier (PERV-011). | Compute action score from hook results. Write to `action_scores` table. |
| 7 | `verification-middleware` | 70 | Inject `must_haves` from story spec into agent context. | Run lightweight structural check (ADR-017 Section 4.2). Report drift. |

### 8.5 Error Isolation

Each middleware executes independently with error isolation:

- Middleware failure in `beforeModel()`: logged, does not block other middleware (except `budget-middleware` and `credential-middleware` which are fatal)
- Middleware failure in `afterModel()`: logged, does not block story completion
- No backward dependencies between middleware (middleware N does not read output of middleware N-1)
- Each middleware uses a namespaced key in `MiddlewareContext` to avoid collisions

### 8.6 Strict Ordering, No Backward Dependencies

Middleware execute in `order` sequence. A middleware at order 30 MUST NOT read data written by a middleware at order 40. Forward-only data flow prevents circular dependencies.

The ordering ensures:
- Budget check happens first (no point assembling context for an over-budget agent)
- Credentials are injected before any content that might reference them
- Learning context is available before enforcement rules (learnings may reference conventions)
- Verification runs last (needs all context to know what to verify)

### 8.7 Relationship to Existing Overlay Pipeline

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

### 8.8 Implementation Scope

~300 LOC new-write total:
- `factory-core/src/middleware/types.ts` — Middleware interface, MiddlewareContext, MiddlewareResult (~40 LOC)
- `factory-core/src/middleware/chain.ts` — MiddlewareChain executor that runs before/after phases (~60 LOC)
- `factory-core/src/middleware/budget.ts` — Budget middleware (~40 LOC)
- `factory-core/src/middleware/credential.ts` — Credential middleware (~30 LOC)
- `factory-core/src/middleware/learning.ts` — Learning middleware (~50 LOC)
- `factory-core/src/middleware/enforcement.ts` — Enforcement middleware (~30 LOC)
- `factory-core/src/middleware/skill.ts` — Skill middleware (~20 LOC)
- `factory-core/src/middleware/verification.ts` — Verification middleware (~30 LOC)

**Design inspiration:** DeerFlow `backend/src/agents/middleware/` — bidirectional before/after pattern applied to agent processing pipelines. Our implementation uses a simpler interface (no async middleware, no middleware nesting) designed for the hook/overlay execution model.

---

## Section 9: NEW ADR-022 — Multi-Channel Notification Abstraction

**Status:** Proposed
**Finding:** ARCH10X-002
**Decision:** Replace the Telegram-only messenger (ADR-014) with a channel-agnostic notification system. Telegram remains the first (and MVP-only) channel. The abstraction enables zero-architecture-cost addition of Slack, Discord, email, or webhook channels in Growth/Vision phases.

### 9.1 Architecture

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

### 9.2 Channel Base Class

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

### 9.3 MessageBus

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

### 9.4 TelegramChannel as First Implementation

ADR-014's existing Telegram messenger becomes an implementation of the `Channel` interface. All existing functionality (dual-channel notifications, inbound commands, async dialogue, quiet hours, severity routing) is preserved. The `TelegramChannel` wraps the existing messenger package.

**What changes for ADR-014:**
- `messenger/` package internals are unchanged
- `factory-core` creates a `TelegramChannel` adapter that implements `Channel` and delegates to the messenger package
- All Factory Core notification calls go through `MessageBus.publish()` instead of directly calling messenger functions
- Existing Telegram-specific features (inline keyboards, chat commands, webhook endpoint) remain in the messenger package

### 9.5 Adding a New Channel (Growth Example: Slack)

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

### 9.6 Configuration

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

### 9.7 Implementation Scope

~250 LOC new-write total:
- `factory-core/src/notifications/channel.ts` — Channel interface, ChannelMessage type (~30 LOC)
- `factory-core/src/notifications/message-bus.ts` — MessageBus with pub/sub routing (~80 LOC)
- `factory-core/src/notifications/channels/telegram-channel.ts` — Adapter wrapping existing messenger package (~60 LOC)
- `factory-core/src/notifications/channels/webhook-channel.ts` — Generic webhook channel for extensibility (~40 LOC)
- `shared-types/src/notifications.ts` — Notification type extensions (~40 LOC)

**Design inspiration:** DeerFlow `modules/channel/` — MessageBus, Channel base class concept. Our implementation is simpler (no ChannelManager/ChannelService/ChannelStore layers) because QDS has a single Factory Core instance, not a distributed system.

---

## Section 10: NEW ADR-023 — System Health Circuit Breaker

**Status:** Proposed
**Finding:** FAIL-020
**Decision:** Implement correlated failure detection with automatic mitigation. When multiple subsystems report errors within a configurable window, the system pauses new story starts and adjusts timeouts to prevent cascade failures.

### 10.1 Problem

Disk I/O spikes cause Nyquist verification, performance data writes, workspace hooks, and mail delivery to all timeout simultaneously. Each subsystem handles its failure independently with no awareness of the common root cause. Result: multiple stories fail simultaneously, each generating independent error logs, Telegram notifications, and retry attempts that compound the I/O load.

### 10.2 Circuit Breaker Mechanism

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

### 10.3 Automatic Mitigations

| Condition | Mitigation |
|-----------|-----------|
| Circuit breaker OPEN | Pause new story starts (queue them) |
| I/O degradation detected | Double hook timeouts (30s -> 60s) |
| I/O degradation detected | Double verification timeouts |
| Pi SDK rate limit hit | Increase inter-call delay by 2x |
| Recovery (CLOSED) | Restore all original values |
| Recovery (CLOSED) | Drain queued stories (start next in queue) |

### 10.4 Dashboard Health Indicator

Dashboard displays system health status:

| State | Indicator | Detail |
|-------|----------|--------|
| CLOSED | Green dot in vitals strip | "All systems healthy" |
| OPEN | Red pulsing dot in vitals strip | "System degraded: {affected_subsystems}. New stories paused." |
| HALF_OPEN | Yellow dot in vitals strip | "System recovering. Monitoring..." |

### 10.5 Configuration

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

### 10.6 Implementation Scope

~200 LOC new-write total:
- `factory-core/src/health/circuit-breaker.ts` — State machine, error tracking, mitigation application (~120 LOC)
- `factory-core/src/health/subsystem-monitor.ts` — Error signal collection from each subsystem (~60 LOC)
- `shared-types/src/health.ts` — Health state types, circuit breaker config schema (~20 LOC)

### 10.7 Integration Points

| Integration | Direction | What Flows |
|------------|-----------|-----------|
| All subsystems -> Circuit breaker | Error signals | Error reports with subsystem identifier |
| Circuit breaker -> Hook timeouts (ADR-018) | Modifies | Doubled timeouts during OPEN state |
| Circuit breaker -> Story queue (Factory Core) | Controls | Pauses/resumes new story starts |
| Circuit breaker -> Dashboard | Status | Health state displayed in vitals strip |
| Circuit breaker -> Telegram (ADR-022) | Notification | Developer notified of degraded state |
| Circuit breaker -> events.db | Logs | Health state transitions logged as events |

---

## Section 11: Revised Cross-ADR Implications Table

All implications from ADR-015 through ADR-020 (original) are updated below. New implications from ADR-021 through ADR-023 are added. Items that were killed (credit_ledger, per-agent budgets, Drizzle ORM) are removed.

| ADR Source | Affected Package | Implication | Status |
|---|---|---|---|
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

## Section 12: Single Source of Truth Resolution

Session 7 identified multiple sources of truth for the same data (CONS-001, CONS-002, FAIL-001). This section establishes definitive ownership.

### 12.1 State Ownership Matrix

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

### 12.2 YAML Files Are Read-Only Exports

The following files are generated on-demand from SQLite and NEVER written to directly:

| File | Generated From | Trigger |
|------|---------------|---------|
| `.qds/performance/export/action-scores.yaml` | `pipeline.db` `action_scores` | Dashboard export button, CLI command |
| `.qds/performance/export/session-composites.yaml` | `pipeline.db` `session_composites` | Dashboard export button, CLI command |
| `.qds/performance/export/elo-ratings.yaml` (Growth) | `pipeline.db` `elo_ratings` | Dashboard export button, CLI command |
| `.qds/performance/export/tiers.yaml` (Growth) | `pipeline.db` `tier_assignments` | Dashboard export button, CLI command |

These exports exist for human inspection and debugging. They are `.gitignore`d. They are never read by any Factory Core component.

### 12.3 factory.yaml Is Read-Once-at-Startup Frozen Config

`factory.yaml` is read once at Factory Core startup, validated with Zod, and frozen via `Object.freeze()`. No component modifies it at runtime. Changes to `factory.yaml` require Factory Core restart.

**Exception:** The circuit breaker (ADR-023) modifies runtime timeout values. These are NOT stored in `factory.yaml`. They are runtime-only overrides that reset to `factory.yaml` values when the circuit breaker returns to CLOSED state. The override mechanism is a separate in-memory config layer, not a `factory.yaml` mutation.

---

## Section 13: Epic-Level Context Architecture

### 13.1 Problem

When Factory Core manages an epic (multiple related stories), each story benefits from knowledge accumulated during previous stories in the same epic. Without explicit epic context management, Story 5 of an epic starts from scratch without knowing what architectural decisions, integration points, and patterns were established in Stories 1-4.

### 13.2 Decision

Factory Core maintains epic-level context in `pipeline.db` and assembles it into the overlay for each story within an epic.

### 13.3 pipeline.db Schema — Epic Tables

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

### 13.4 Epic Context Assembly

When spawning agents for Story N of an epic, Factory Core's overlay composition includes accumulated epic context from Stories 1 through N-1:

1. **Query:** `SELECT * FROM epic_context WHERE epic_id = ? AND story_id IN (stories 1..N-1) ORDER BY created_at`
2. **Assemble:** Group by `context_type`, format as structured sections
3. **Token budget:** Epic context allocated from the 50% rule (FR155). If the epic has accumulated more context than fits in the token budget, prioritize by recency and relevance (context touching files that the current story will modify gets priority).
4. **Inject:** Via `learning-middleware` (ADR-021) `beforeModel()` phase

### 13.5 Epic Context Extraction

After each story completes, Factory Core extracts epic context:

1. **From transfer manifest:** Architectural decisions, integration points established
2. **From learning records:** Patterns and conventions that emerged
3. **From VERIFICATION.md:** Must-haves patterns that proved effective
4. **Storage:** Written to `epic_context` table with the completing story's ID

### 13.6 Performance Requirements

- **Epic context assembly latency:** <=500ms (SQLite queries + formatting)
- **Epic context token budget:** Dynamically allocated from the 50% rule. With a 100K context model at 50% utilization (50K available), epic context gets up to 5K tokens (10% of available). With accumulated context exceeding 5K tokens, summarization is applied (LLM call, amortized across stories).

### 13.7 Integration Points

| Integration | Direction | What Flows |
|------------|-----------|-----------|
| Story completion -> epic_context | In | Extracted decisions, patterns, integration points |
| epic_context -> learning-middleware | Out | Accumulated context injected into overlay for next story |
| pipeline.db epics table -> Dashboard | Out | Epic progress visualization |
| Epic context -> must_haves (ADR-017) | Influences | Earlier story patterns inform later story verification |

---

## Appendix A: Session 7 Finding Resolution Matrix

Every critical finding from Session 7 mapped to its resolution in this document.

| Finding ID | Finding | Resolution | ADR Section |
|-----------|---------|-----------|-------------|
| CONS-001 | Three-way cost/credit/budget tracking split | Killed credit_ledger. Two stores: attribution.db (cost) + pipeline.db (performance) | ADR-016 Section 3.2 |
| CONS-002 | Dual source of truth (YAML + SQLite) | pipeline.db is sole source of truth. YAML = read-only exports | ADR-015 Section 2.3, Section 12 |
| CONS-003 | Tier 5 eliminates quality gates | L3 phase boundary hooks mandatory for ALL tiers | ADR-018 Section 5.2 |
| CONS-004 | Per-turn Nyquist prohibitively expensive | Per-turn uses lightweight signals only (hook results + filesystem checks) | ADR-019 Section 6.1, ADR-017 Section 4.2 |
| SCOPE-001 | Full 6-layer perf system in MVP not viable | MVP: Layers 1-3 (data collection). Growth: Layers 4-6 (behavioral) | ADR-015 Section 2.2 |
| COMP-001 | No tier demotion criteria | ELO below threshold-50 for 3 consecutive stories triggers demotion | ADR-015 Section 2.8 |
| COMP-009 | No ELO migration strategy | Versioned rating epochs with carried-forward ratings | ADR-015 Section 2.14 |
| COMP-011 | No Nyquist-BMAD disagreement protocol | Nyquist = structural tiebreaker, BMAD = spec tiebreaker | ADR-017 Section 4.6 |
| TRANS-001 | costs.ts 85% Postgres-specific | New-write ~60 LOC in bun:sqlite. Pattern inspiration only | ADR-020 Section 7.2 |
| TRANS-003 | verify.cjs 87% non-verification code | New-write ~150 LOC. Only artifact/key_link verification pattern used | ADR-020 Section 7.2 |
| TRANS-007 | DeerFlow hooks.ts irrelevant (488->0 LOC) | Removed from inventory entirely. Dashboard is new-write | ADR-020 Section 7.1 |
| PERV-001 | Confidence calibration rewards cowards | Resolution requirement: spread across [0.2, 0.9] with rank correlation | ADR-015 Section 2.9 |
| PERV-002 | Meta-optimization can modify scoring | Scoring weights immutable without developer approval | ADR-015 Section 2.12 |
| PERV-003 | Progressive autonomy death spiral | Random audit: 1 in 3 stories for Tier 3+ get full Tier 1 density | ADR-015 Section 2.11 |
| PERV-004 | Token efficiency rewards bad code | Bounded step function: penalties only for >3x median | ADR-015 Section 2.10 |
| PERV-005 | Domain specialization collapse | 15% exploration factor in routing decisions (Growth) | ADR-015 Section 2.12 |
| PERV-009 | Tier boundary thrashing | 50-point hysteresis buffer + 3-story dwell requirement | ADR-015 Section 2.8 |
| PERV-011 | Self-fulfilling tier prophecy | Agent's own tier NOT injected into its overlay | ADR-015 Section 2.12 |
| ECON-001 | Credit economy solves non-existent problem | Credit economy killed. Weighted composite routing in Growth | ADR-016 Section 3.1 |
| ECON-002 | Per-agent budgets create deadlocks | Per-agent budgets killed. Per-story + global budget enforcement | ADR-016 Section 3.1 |
| FAIL-001 | Concurrent ELO writes cause lost updates | All data in SQLite (WAL mode handles locking) | ADR-015 Section 2.3 |
| FAIL-006 | Nyquist false negatives burn fix-loop budget | Oscillation detection: identical gaps on unmodified code = escalate | ADR-017 Section 4.5 |
| FAIL-012 | Asymptotic approach at max_turns | Progress velocity check: extend by 1 if >75% and making progress | ADR-019 Section 6.3 |
| FAIL-015 | Elixir error handling lost in TypeScript port | Defensive error normalization: Result<T> at all async boundaries | ADR-019 Section 6.4 |
| FAIL-018 | Performance crash changes hook enforcement | Fallback to Tier 2 enforcement when performance data unavailable | ADR-015 Section 2.13 |
| FAIL-020 | Multi-system failure from shared resource | System health circuit breaker pauses new stories, doubles timeouts | ADR-023 |
| CONS-011 | Two SQLite access patterns (Drizzle + bun:sqlite) | bun:sqlite only. Drizzle ORM removed | ADR-020 Section 7.3 |

---

## Appendix B: New File Inventory

Files added or modified by these amendments:

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

All files are new-write TypeScript following QDS conventions. No transplanted code. Design inspiration sources cited in ADR-020 Section 7.2.

---

## Appendix C: Amended Canonical Reference Locations

Additions to the Canonical Reference Locations table from the architecture document:

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

---

*Generated as Deliverable 2 of Session 8 adversarial synthesis. Resolves all 19 critical findings and 8 important findings from Session 7's 11-agent adversarial review. Introduces 3 new ADRs (021-023) and revises 6 existing ADRs (015-020).*
