# QDS Factory -- Unified Code-Lift Manifest

**Version:** 2.0
**Date:** 2026-03-14
**Source:** Deep-dive analyses of 6 source repositories + Session 10 code-lift resolution
**Purpose:** Definitive reference for implementation agents -- maps every story to reusable artifacts from source repos

---

## Section 1: EPIC-BY-STORY MAPPING

### Epic 1: Foundation -- Pipeline DB, Shared Types, Factory Core Skeleton
**Epic estimated LOC:** ~630

#### Story 1.1: shared-types Package with All Zod Schemas (210 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/types.ts` | ~620 | ADAPT | AgentSession, MailMessage, OverlayConfig, SessionMetrics, EventStore type patterns. Overstory uses plain TS interfaces; adapt to Zod schemas with runtime validation. Lift score ranges, enum values, field shapes as Zod constraints. |
| pi-mono | `packages/ai/src/types.ts` | ~100 | INTERFACE_CARRY | Usage type, Model type, StreamOptions, KnownProvider. Carry provider/model enums into shared-types for tier mapping foundations. |
| pi-mono | `packages/agent/src/types.ts` | ~60 | INTERFACE_CARRY | AgentTool, AgentEvent, AgentState, AgentLoopConfig. Carry event types for performance middleware context typing. |
| overstory | `src/errors.ts` | ~30 | ADAPT | Error code enum pattern and error hierarchy structure. Adapt to QDS-specific error codes. |

**Estimated LOC savings:** ~200 (interface shapes, enum values, validation constraint patterns)
**Net new LOC:** ~10
**Design patterns from research repos:**
- GSD: Model profile resolution pattern informs how KnownProvider maps to tier definitions
- paperclip: Adapter registry uniform interface pattern informs how provider types are structured

---

#### Story 1.2: pipeline.db Migration System and Initial MVP Schema (200 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/sessions/store.ts` | ~440 | ADAPT | SQLite WAL pattern, prepared statement caching, migration execution pattern. Adapt the `open()` method (PRAGMA journal_mode=WAL, busy_timeout), prepared statement lifecycle, and sequential migration runner. |
| claude-mem | MigrationRunner pattern | ~40 | PATTERN_COPY | `table_info` check before ALTER TABLE for idempotent migrations. The `_migrations` tracking table pattern. |
| claude-mem | ClaudeMemDatabase init | ~20 | PATTERN_COPY | WAL mode setup sequence, busy_timeout configuration. |

**Estimated LOC savings:** ~120 (WAL setup, migration runner skeleton, prepared statements)
**Net new LOC:** ~80 (schema-specific SQL DDL for 8 tables, indexes, CHECK constraints)
**Design patterns from research repos:**
- symphony: Hot-reload with last-known-good fallback -- informs migration failure recovery
- Cross-cutting: Atomic file I/O (temp+rename) for migration state safety

---

#### Story 1.3: attribution.db Schema Extension -- task_checkouts Table (20 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/sessions/store.ts` | ~10 | PATTERN_COPY | UNIQUE constraint pattern, index creation pattern from existing store. |

**Estimated LOC savings:** ~10
**Net new LOC:** ~10
**Design patterns from research repos:** None specific.

---

#### Story 1.4: Factory Core Process Skeleton (170 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/config.ts` | ~838 | ADAPT | parseYaml, deepMerge, validateConfig, loadConfig functions, error hierarchy for config validation. The entire config loading pipeline (read YAML, parse, validate, freeze) is directly reusable. Adapt Overstory's config schema to factory.yaml schema. ~120 LOC of the loading pipeline is directly applicable. |
| overstory | `src/errors.ts` | ~218 | ADAPT | Structured error hierarchy (ConfigError, DatabaseError, etc.) for startup diagnostics. ~40 LOC of error class patterns. |

**Estimated LOC savings:** ~100 (config loading pipeline, YAML parsing, deep merge, Object.freeze pattern, error hierarchy)
**Net new LOC:** ~70 (factory.yaml-specific Zod schema, QDS-specific startup sequence)
**Design patterns from research repos:**
- symphony: Hot-reload with last-known-good fallback -- informs config reload strategy
- Cross-cutting: YAML frontmatter as metadata pattern

---

#### Story 1.5: Result<T> Utility Type (30 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/types.ts` | ~15 | PATTERN_COPY | Result-like patterns in error handling. Overstory uses try/catch with structured errors; the normalization pattern (wrapping non-Error thrown values) is informed by Overstory's error.ts. |

**Estimated LOC savings:** ~5 (pattern only, implementation is small)
**Net new LOC:** ~25
**Design patterns from research repos:**
- paperclip: Structured execution context -- informs Result<T> usage at async boundaries

---

#### Story 1.6: Overstory Schema Extensions (40 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/sessions/store.ts` | ~20 | PATTERN_COPY | `PRAGMA table_info` probe-then-alter pattern. The SessionStore's migration approach (check column existence before ALTER TABLE) is the exact pattern needed for idempotent schema extensions. ~15 LOC of probe logic. |
| overstory | `src/mail/store.ts` | ~10 | ADAPT | CHECK constraint modification pattern. The mail store's existing message type CHECK constraint syntax informs how to extend it. |
| overstory | `src/events/store.ts` | ~10 | ADAPT | EventType CHECK constraint modification pattern. Same approach as mail.db extensions. |

**Estimated LOC savings:** ~20 (probe-then-alter pattern, CHECK constraint syntax)
**Net new LOC:** ~20
**Design patterns from research repos:** None specific. Uses Overstory's native migration pattern exclusively.

---

### Epic 1 Subtotals

| Metric | Value |
|--------|-------|
| Story LOC total | 670 |
| Reusable LOC | ~455 |
| Net new LOC | ~215 |
| Reuse % | 68% |

---

### Epic 2: Middleware Chain -- Overlay Composition Restructure
**Epic estimated LOC:** ~340

#### Story 2.1: Middleware Interface and MiddlewareChain Executor (100 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/agents/overlay.ts` | ~60 | ADAPT | Template engine and gate formatter patterns. The overlay composition flow (collect context, format, inject) maps to middleware beforeModel() chain. Adapt the ordered processing and error isolation patterns. |

**Estimated LOC savings:** ~30 (ordered processing pattern, error isolation pattern)
**Net new LOC:** ~70
**Design patterns from research repos:**
- deer-flow: Strict-order middleware chain -- DIRECT PATTERN. deer-flow's middleware processes context in strict order with error isolation per step. This is the primary design reference.
- symphony: GenServer poll-reconcile-dispatch -- informs the chain executor's lifecycle model

---

#### Story 2.2: Budget Middleware (40 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/metrics/pricing.ts` | ~135 | DIRECT_COPY | Multi-provider pricing table and cost computation. Directly reusable for cost calculation within the budget middleware's afterModel() phase. |

**Estimated LOC savings:** ~20 (pricing patterns reused in cost recording; full module reused in Epic 5)
**Net new LOC:** ~20
**Design patterns from research repos:**
- GSD: Context monitoring hooks -- informs budget check integration points

---

#### Story 2.3: Credential Middleware (30 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| pi-mono | `getApiKey` callback | ~20 | API_CONSUME | Pi SDK's getApiKey callback is the credential injection mechanism. Factory Core implements the callback; Pi SDK invokes it. No overlay text injection needed. |

**Estimated LOC savings:** ~10 (callback wiring pattern)
**Net new LOC:** ~20
**Design patterns from research repos:** None specific. CRITICAL FINDING: Credentials are injected via Pi SDK callback, NOT overlay text.

---

#### Story 2.4: Learning Middleware (50 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/agents/overlay.ts` | ~30 | ADAPT | Template formatting for context injection. The overlay template engine's formatting of structured sections maps to learning context formatting. |

**Estimated LOC savings:** ~15 (template formatting pattern)
**Net new LOC:** ~35
**Design patterns from research repos:**
- deer-flow: LLM-based memory with debounced queue -- informs learning record query and injection pattern

---

#### Story 2.5: Enforcement Middleware (30 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/agents/manifest.ts` | ~290 | ADAPT | Manifest loader and capability index. The manifest loading pattern (read YAML files, index by capability, validate structure) applies to loading enforcement rules from Superpowers skill files. ~30 LOC of loader pattern applicable. |
| superpowers | `skills-core.js` | ~208 | IMPORT_AS_IS | findSkillsInDir() and extractFrontmatter() -- only 2 of 5 functions needed at runtime. Import the module directly with .d.ts type declarations. |

**Estimated LOC savings:** ~25 (skill file loading via Superpowers import; manifest pattern from Overstory)
**Net new LOC:** ~5
**CRITICAL FINDING:** Superpowers frontmatter has only `name` and `description` fields -- NO dedicated `enforcement` field. The `description` field IS the enforcement metadata. Middleware reads description content to determine enforcement rules.
**Design patterns from research repos:** None specific.

---

#### Story 2.6: Skill Middleware (20 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| superpowers | `skills-core.js` | ~208 | IMPORT_AS_IS | Same import as Story 2.5 -- findSkillsInDir() and extractFrontmatter(). Skill middleware reads descriptions for overlay injection. |
| overstory | `src/agents/overlay.ts` | ~239 | ADAPT | Gate formatter pattern for formatting skill descriptions into overlay sections. |

**Estimated LOC savings:** ~15 (skill loading already imported; formatting pattern from overlay.ts)
**Net new LOC:** ~5
**Design patterns from research repos:** None specific.

---

#### Story 2.7: Verification Middleware (30 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| (none from source repos) | -- | -- | -- | This story creates a stub that will be replaced in Epic 3. |

**Estimated LOC savings:** 0
**Net new LOC:** ~30
**Design patterns from research repos:**
- GSD: Goal-backward verification (Nyquist) -- DIRECT PATTERN for the verification philosophy, but implementation is in Epic 3

---

#### Story 2.8: Performance Middleware Stub (40 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| (none from source repos) | -- | -- | -- | Stub implementation; real scorer in Epic 5. |

**Estimated LOC savings:** 0
**Net new LOC:** ~40
**Design patterns from research repos:** None for the stub.

---

#### Story 2.9: Pi SDK Tier-to-Model Mapping -- TierResolver (50 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| pi-mono | `ModelRegistry.find()` | ~15 | API_CONSUME | Pi SDK's ModelRegistry lookup for validating configured models exist. Factory Core calls this at startup. |
| overstory | `src/config.ts` | ~10 | PATTERN_COPY | Config validation pattern for tier mapping section. Zod schema validation of factory.yaml tiers section. |

**Estimated LOC savings:** ~10 (config validation pattern, API wiring)
**Net new LOC:** ~40
**CRITICAL FINDING:** Pi SDK has NO native tier concept. This TierResolver is Factory Core's bridge between tier directives and Pi SDK's model catalog. Without it, tier-based model selection has no implementation path.
**Design patterns from research repos:**
- GSD: Model profile resolution -- informs how tier names map to concrete model objects

---

### Epic 2 Subtotals

| Metric | Value |
|--------|-------|
| Story LOC total | 390 |
| Reusable LOC | ~125 |
| Net new LOC | ~265 |
| Reuse % | 32% |

---

### Epic 3: Continuous Verification -- Lightweight + Full Nyquist
**Epic estimated LOC:** ~660

#### Story 3.1: must_haves Schema Parser and Validator (60 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/config.ts` | ~30 | ADAPT | YAML parsing and validation pipeline pattern. parseYaml + schema validation flow. |
| superpowers | extractFrontmatter() | ~10 | API_CONSUME | YAML frontmatter extraction pattern for parsing must_haves from story spec YAML. |

**Estimated LOC savings:** ~15
**Net new LOC:** ~45
**Design patterns from research repos:**
- Cross-cutting: YAML frontmatter as metadata -- directly applicable to must_haves format

---

#### Story 3.2: Lightweight Continuous Verifier (100 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/watchdog/health.ts` | ~181 | PATTERN_COPY | ZFC health state machine pattern -- check/pass/fail structure. The health check pattern (run checks, collect results, aggregate) maps to verification check pattern. ~30 LOC of check-result-aggregate pattern. |

**Estimated LOC savings:** ~20
**Net new LOC:** ~80
**Design patterns from research repos:**
- GSD: Goal-backward verification (Nyquist) -- PRIMARY DESIGN REFERENCE. Start from story goal, check structural outputs, aggregate results.

---

#### Story 3.3: Integration -- Lightweight Verifier as Post-Task Hook (60 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/mail/store.ts` | ~120 | ADAPT | Message store pattern for sending drift warnings via Overstory mail. The mail system's write/read pattern for agent-to-agent messages applies to drift notification injection. ~20 LOC of message writing pattern. |

**Estimated LOC savings:** ~15
**Net new LOC:** ~45
**Design patterns from research repos:**
- GSD: Context monitoring hooks -- informs post-task hook integration

---

#### Story 3.4: Full Nyquist Verifier -- LLM-Powered (150 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/watchdog/triage.ts` | ~100 | ADAPT | AI triage pattern -- LLM-based analysis of structured data with categorized output. The triage module's pattern of sending structured context to an LLM and parsing categorized results maps to truth verification. ~40 LOC of LLM interaction pattern. |
| pi-mono | Agent.prompt() API | ~20 | API_CONSUME | Pi SDK's Agent.prompt() for economy-tier LLM call. Factory Core calls Pi to verify behavioral truths. |

**Estimated LOC savings:** ~35
**Net new LOC:** ~115
**Design patterns from research repos:**
- GSD: Goal-backward verification (Nyquist) -- PRIMARY DESIGN REFERENCE
- GSD: Wave-based parallel execution -- informs how structural + behavioral checks could parallelize

---

#### Story 3.5: Pre-BMAD Structural Gate (80 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/merge/resolver.ts` | ~383 | ADAPT | Conflict parser and prose detection. The resolver's file-existence and content-verification patterns apply to manifest validation. ~20 LOC of file verification pattern. |

**Estimated LOC savings:** ~15
**Net new LOC:** ~65
**Design patterns from research repos:**
- GSD: Goal-backward verification -- Pre-BMAD gate is a structural pre-check before the expensive review

---

#### Story 3.6: Oscillation Detector (60 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| (none from source repos) | -- | -- | -- | Novel pattern; no direct source repo precedent. |

**Estimated LOC savings:** 0
**Net new LOC:** ~60
**Design patterns from research repos:**
- symphony: Exponential backoff with continuation retries -- informs the "when to give up" logic pattern

---

#### Story 3.7: Nyquist-BMAD Disagreement Protocol (150 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/merge/resolver.ts` | ~383 | ADAPT | Tiered resolution pattern and conflict parser. The resolver's approach (classify conflict type, apply tier-specific resolution, escalate ambiguous cases) DIRECTLY maps to disagreement resolution. ~50 LOC of tiered resolution logic. |

**Estimated LOC savings:** ~40
**Net new LOC:** ~110
**Design patterns from research repos:**
- GSD: Goal-backward verification -- disagreement resolution is a meta-verification concern

---

### Epic 3 Subtotals

| Metric | Value |
|--------|-------|
| Story LOC total | 660 |
| Reusable LOC | ~140 |
| Net new LOC | ~520 |
| Reuse % | 21% |

---

### Epic 4: Turn Continuation & Workspace Lifecycle
**Epic estimated LOC:** ~650

#### Story 4.0: Factory Core Orchestration Loop (120 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/watchdog/daemon.ts` | ~390 | ADAPT | Polling daemon loop structure. The daemon's poll-evaluate-act loop maps directly to poll-reconcile-dispatch. ~40 LOC of polling loop skeleton, interval management, and error recovery. |
| overstory | `src/sessions/store.ts` | ~20 | ADAPT | Session state query pattern for reconciling in-memory state against persisted state. |
| pi-mono | Agent class API | ~10 | API_CONSUME | `ov sling` dispatch integration point (via Overstory, not direct Pi SDK). |

**Estimated LOC savings:** ~40 (polling loop structure, state reconciliation query pattern)
**Net new LOC:** ~80
**Design patterns from research repos:**
- symphony: GenServer poll-reconcile-dispatch -- PRIMARY PATTERN. Symphony's GenServer loop (poll for pending work, reconcile state against database, dispatch agents) is the exact architectural reference for this story.
- deer-flow: Dual thread pool subagent execution -- informs concurrent story limit enforcement within the dispatch phase.

---

#### Story 4.1: Turn Continuation Loop with Per-Turn Signals (120 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/watchdog/daemon.ts` | ~390 | ADAPT | Polling daemon with progressive escalation. The daemon's poll-evaluate-act loop maps to turn-evaluate-continue/transition. ~60 LOC of polling loop structure, evaluation dispatch, and escalation logic. |
| pi-mono | Agent class API | ~200 | API_CONSUME | Agent.prompt(), .continue(), .steer(), .followUp(), .abort(), .subscribe(), .setModel(). The turn continuation loop orchestrates Pi SDK Agent calls. |
| pi-mono | Extension event system | ~30 | API_CONSUME | agent_start/end, turn_start/end events for signal collection. |

**Estimated LOC savings:** ~50 (polling loop structure, event subscription wiring)
**Net new LOC:** ~70
**Design patterns from research repos:**
- symphony: GenServer poll-reconcile-dispatch -- PRIMARY PATTERN for the turn loop
- deer-flow: Dual thread pool subagent execution -- informs how turns are managed within a phase
- symphony: Exponential backoff with continuation retries -- informs retry strategy on turn failures

---

#### Story 4.2: Progress Velocity Check (40 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/watchdog/daemon.ts` | ~20 | PATTERN_COPY | Progressive escalation pattern. The watchdog's escalation thresholds (warn, then act, then force) map to velocity check thresholds (extend, extend again, hard cap). |

**Estimated LOC savings:** ~10
**Net new LOC:** ~30
**Design patterns from research repos:**
- GSD: Wave-based parallel execution -- informs how velocity is measured across turns

---

#### Story 4.3: Turn State Persistence (60 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/sessions/store.ts` | ~40 | ADAPT | Prepared statement insert/query pattern for session state. The store's write-then-read-for-resume pattern maps to turn state persistence. |
| pi-mono | Session persistence | ~80 | PATTERN_COPY | JSONL tree structure with compaction. Pi's session persistence pattern informs how turn state snapshots are structured. |
| claude-mem | SessionManager lifecycle | ~30 | PATTERN_COPY | create/restore/end session pattern. Maps to turn start/resume/complete lifecycle. |

**Estimated LOC savings:** ~30
**Net new LOC:** ~30
**Design patterns from research repos:**
- Cross-cutting: Atomic file I/O (temp+rename) -- for crash-safe state writes

---

#### Story 4.4: Continuation Prompt Template Injection (40 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/agents/overlay.ts` | ~239 | ADAPT | Template engine for overlay injection. The template substitution and section formatting pattern maps to continuation prompt assembly. ~15 LOC of template pattern. |
| pi-mono | `transformContext` callback | ~10 | API_CONSUME | Factory Core's continuation prompt is injected via Pi SDK's transformContext callback. |

**Estimated LOC savings:** ~15
**Net new LOC:** ~25
**Design patterns from research repos:** None specific.

---

#### Story 4.5: Workspace Lifecycle Hooks -- 4 Points (150 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/worktree/manager.ts` | ~130 | ADAPT | Worktree lifecycle (create, validate, remove). The manager's lifecycle methods provide the hook points. ~40 LOC of lifecycle dispatch pattern. |
| overstory | `src/worktree/tmux.ts` | ~200 | ADAPT | Process management (killProcessTree, getDescendantPids). Bun.spawn() lifecycle for hook scripts parallels tmux process management. ~30 LOC of process spawning/timeout pattern. |
| pi-mono | Extension event system | ~20 | API_CONSUME | agent_start/end events as hook triggers. |

**Estimated LOC savings:** ~50
**Net new LOC:** ~100
**Design patterns from research repos:**
- symphony: Isolated per-issue workspace with lifecycle hooks -- DIRECT PATTERN. Symphony's workspace isolation with before/after hooks is the primary design reference.
- Cross-cutting: Silent-failure hooks classification -- informs which hook failures are warnings vs fatal

---

#### Story 4.6: Hook Rollback on Partial Failure (70 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/worktree/manager.ts` | ~30 | ADAPT | Worktree removal and cleanup patterns. `git worktree remove --force` invocation pattern. |

**Estimated LOC savings:** ~15
**Net new LOC:** ~55
**Design patterns from research repos:**
- symphony: Isolated per-issue workspace with lifecycle hooks -- rollback is part of the lifecycle pattern

---

#### Story 4.7: Stall Detection Integration (50 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/watchdog/daemon.ts` | ~40 | ADAPT | Stall detection and progressive escalation from the watchdog daemon. The timeout detection and escalation path (warn, then kill) maps to per-turn stall detection. |
| overstory | `src/watchdog/health.ts` | ~20 | PATTERN_COPY | Health state machine for circuit breaker integration. HALF_OPEN timeout doubling pattern. |

**Estimated LOC savings:** ~25
**Net new LOC:** ~25
**Design patterns from research repos:**
- symphony: Exponential backoff with continuation retries -- informs timeout escalation strategy

---

### Epic 4 Subtotals

| Metric | Value |
|--------|-------|
| Story LOC total | 650 |
| Reusable LOC | ~235 |
| Net new LOC | ~415 |
| Reuse % | 36% |

---

### Epic 5: Performance Data Collection (MVP Layers 1-3)
**Epic estimated LOC:** ~510 (from stories: 120+80+100+30+100+80 = 510)

#### Story 5.1: Action Scorer Module (120 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/metrics/store.ts` | ~270 | ADAPT | Dual-table metrics store pattern. The store's insert/query pattern for metrics data maps to action_scores table operations. ~40 LOC of insert + indexed query pattern. |
| overstory | `src/metrics/summary.ts` | ~178 | ADAPT | Metrics aggregation patterns. Summary computation (mean, trend, distribution) maps to score computation. ~30 LOC of aggregation arithmetic. |
| pi-mono | `Usage.cost.total` | ~10 | API_CONSUME | Per-call cost already computed by Pi SDK. Action scorer reads this directly. |

**Estimated LOC savings:** ~40
**Net new LOC:** ~80
**Design patterns from research repos:**
- GSD: Model profile resolution -- informs how hook results map to score dimensions

---

#### Story 5.2: Confidence Calibration Tracker (80 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/metrics/store.ts` | ~20 | ADAPT | Metrics table insert/query pattern for confidence_declarations table. |

**Estimated LOC savings:** ~10
**Net new LOC:** ~70
**Design patterns from research repos:** None specific. Brier score and Spearman correlation are standard statistical computations.

---

#### Story 5.3: Session Composite Aggregation (100 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/metrics/summary.ts` | ~178 | ADAPT | Metrics aggregation and weighted combination patterns. ~30 LOC of weighted scoring logic. |

**Estimated LOC savings:** ~20
**Net new LOC:** ~80
**Design patterns from research repos:**
- GSD: Wave-based parallel execution -- session composites aggregate across parallel phase results

---

#### Story 5.4: Integration -- Action Scorer into Performance Middleware (30 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| (none -- wiring code) | -- | -- | -- | Integration glue replacing the stub from 2.8. |

**Estimated LOC savings:** 0
**Net new LOC:** ~30
**Design patterns from research repos:** None specific.

---

#### Story 5.5: Learning Record Extractor (100 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/insights/analyzer.ts` | ~203 | DIRECT_COPY | Session insight extraction. This module extracts structured insights from session data -- DIRECTLY applicable to extracting learning records from fix-loop data. ~80 LOC directly reusable. |

**Estimated LOC savings:** ~60
**Net new LOC:** ~40
**Design patterns from research repos:**
- deer-flow: LLM-based memory with debounced queue -- informs how learning records are batched for extraction

---

#### Story 5.6: Overlay Effectiveness Tracker (80 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/metrics/store.ts` | ~20 | ADAPT | Metrics insert pattern for overlay_effectiveness table. |

**Estimated LOC savings:** ~10
**Net new LOC:** ~70
**Design patterns from research repos:** None specific.

---

### Epic 5 Subtotals

| Metric | Value |
|--------|-------|
| Story LOC total | 510 |
| Reusable LOC | ~140 |
| Net new LOC | ~370 |
| Reuse % | 27% |

---

### Epic 6: Economic Governance
**Epic estimated LOC:** ~450 (corrected from stories: 90+80+90+80+60+50 = 450)

#### Story 6.1: Per-Story Budget Enforcement (90 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/metrics/pricing.ts` | ~135 | DIRECT_COPY | Multi-provider pricing table. Cost lookup by provider+model for budget comparison. |
| overstory | `src/sessions/store.ts` | ~20 | ADAPT | SUM query pattern with prepared statements for cumulative cost queries. |

**Estimated LOC savings:** ~30
**Net new LOC:** ~60
**Design patterns from research repos:** None specific.

---

#### Story 6.2: Global Daily/Monthly Ceiling Enforcement (80 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/sessions/store.ts` | ~15 | ADAPT | Date-filtered SUM query pattern. |

**Estimated LOC savings:** ~10
**Net new LOC:** ~70
**Design patterns from research repos:** None specific.

---

#### Story 6.3: Atomic Task Checkout via attribution.db (90 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| claude-mem | PendingMessageStore claim-confirm | ~100 | PATTERN_COPY | Claim-confirm pattern with UNIQUE constraint and timeout-based release. The PendingMessageStore's atomic claim (INSERT with UNIQUE), confirm (UPDATE completed_at), and stale release (WHERE claimed_at < timeout) pattern maps DIRECTLY to task checkout. ~50 LOC of claim/release logic. |

**Estimated LOC savings:** ~40
**Net new LOC:** ~50
**Design patterns from research repos:** None specific.

---

#### Story 6.4: Cost Data Flow -- Pi SDK Usage to Budget Queries (80 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/metrics/pricing.ts` | ~135 | DIRECT_COPY | Multi-provider pricing and cost computation. |
| pi-mono | `Usage.cost.total` | ~10 | API_CONSUME | Pi SDK's per-call Usage callback provides token and cost data. |
| overstory | `src/metrics/transcript.ts` | ~116 | DIRECT_COPY | JSONL transcript parser for extracting cost events from session transcripts. |

**Estimated LOC savings:** ~30
**Net new LOC:** ~50
**Design patterns from research repos:**
- paperclip: Adapter registry with uniform interface -- informs how Pi SDK callback is registered

---

#### Story 6.5: Burn Rate Prediction Computation (60 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/metrics/summary.ts` | ~15 | ADAPT | Trend computation / projection pattern from summary module. |

**Estimated LOC savings:** ~10
**Net new LOC:** ~50
**Design patterns from research repos:** None specific.

---

#### Story 6.6: Budget Breach Notification via Messenger (50 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/events/store.ts` | ~20 | ADAPT | Event dispatch pattern for notification triggering. |

**Estimated LOC savings:** ~10
**Net new LOC:** ~40
**Design patterns from research repos:** None specific.

---

### Epic 6 Subtotals

| Metric | Value |
|--------|-------|
| Story LOC total | 450 |
| Reusable LOC | ~130 |
| Net new LOC | ~320 |
| Reuse % | 29% |

---

### Epic 7: Learning System & Epic Context
**Epic estimated LOC:** ~640

#### Story 7.1: Learning Record Extraction from Fix-Loops (100 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/insights/analyzer.ts` | ~203 | DIRECT_COPY | Session insight extraction. The analyzer's pattern of extracting structured findings from session data maps to fix-loop learning extraction. Shared with Story 5.5. ~40 LOC applicable here. |

**Estimated LOC savings:** ~30
**Net new LOC:** ~70
**Design patterns from research repos:**
- deer-flow: LLM-based memory with debounced queue -- informs learning record batching

---

#### Story 7.2: Learning Record Extraction from Maintenance Agent Fixes (90 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/mulch/client.ts` | ~412 | ADAPT | MulchClient interface + CLI wrapper. The CLI command pattern (parse args, validate, execute, report) maps to `qds maintenance log` CLI. ~30 LOC of CLI scaffolding pattern. |

**Estimated LOC savings:** ~20
**Net new LOC:** ~70
**Design patterns from research repos:** None specific.

---

#### Story 7.3: Pattern Knowledge Mining -- Cross-Story Correlations (120 LOC) [Growth]

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/insights/analyzer.ts` | ~203 | ADAPT | Insight correlation pattern. The analyzer's cross-session correlation logic informs cross-story pattern discovery. ~30 LOC of correlation pattern. |

**Estimated LOC savings:** ~20
**Net new LOC:** ~100
**Design patterns from research repos:**
- deer-flow: LLM-based memory with debounced queue -- informs pattern mining batch strategy

---

#### Story 7.4: Epic Context Tables in pipeline.db (80 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/sessions/store.ts` | ~30 | ADAPT | Table creation, CRUD operations, index patterns from session store. |

**Estimated LOC savings:** ~15
**Net new LOC:** ~65
**Design patterns from research repos:** None specific.

---

#### Story 7.5: Epic Context Assembly for Overlay Injection (100 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/agents/overlay.ts` | ~239 | ADAPT | Template engine for context assembly and token budgeting. The overlay module's section formatting and size budgeting maps to epic context assembly. ~30 LOC of templating/budgeting pattern. |
| claude-mem | ContextBuilder progressive disclosure | ~60 | PATTERN_COPY | Progressive disclosure pattern -- prioritize most relevant context within token budget. The ContextBuilder's approach of ranking items by relevance and truncating at budget maps directly to epic context assembly. |

**Estimated LOC savings:** ~40
**Net new LOC:** ~60
**Design patterns from research repos:**
- deer-flow: LLM-based memory with debounced queue -- informs context assembly query strategy

---

#### Story 7.6: Epic Context Extraction on Story Completion (80 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/insights/analyzer.ts` | ~203 | ADAPT | Insight extraction pattern. Extracting structured context from completed sessions maps to extracting epic context from completed stories. ~25 LOC of extraction pattern. |

**Estimated LOC savings:** ~15
**Net new LOC:** ~65
**Design patterns from research repos:** None specific.

---

#### Story 7.7: Overlay Enrichment with Learning Records (70 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/agents/overlay.ts` | ~239 | ADAPT | Overlay context injection pattern with priority ordering. ~20 LOC of prioritized injection logic. |
| claude-mem | ContextBuilder progressive disclosure | ~20 | PATTERN_COPY | Budget-aware context truncation pattern. |

**Estimated LOC savings:** ~20
**Net new LOC:** ~50
**Design patterns from research repos:** None specific.

---

### Epic 7 Subtotals

| Metric | Value |
|--------|-------|
| Story LOC total | 640 |
| Reusable LOC | ~160 |
| Net new LOC | ~480 (includes 120 Growth LOC from Story 7.3) |
| Reuse % | 25% |

---

### Epic 8: Notifications & Health Monitoring
**Epic estimated LOC:** ~550 (from stories: 110+60+40+40+120+80+60+40 = 550)

#### Story 8.1: Channel Interface and MessageBus Implementation (110 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/events/store.ts` | ~180 | ADAPT | Event store pub/sub pattern. The EventStore's subscribe/dispatch pattern maps to MessageBus pub/sub. ~30 LOC of event dispatch with category filtering. |
| overstory | `src/mail/store.ts` | ~120 | ADAPT | Message routing pattern. The mail store's per-agent routing maps to per-channel routing. ~20 LOC of routing logic. |

**Estimated LOC savings:** ~30
**Net new LOC:** ~80
**Design patterns from research repos:**
- symphony: GenServer poll-reconcile-dispatch -- informs MessageBus dispatch pattern

---

#### Story 8.2: TelegramChannel Adapter (60 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/mulch/client.ts` | ~412 | ADAPT | MulchClient interface wrapping pattern. The thin wrapper around an external CLI/API maps to wrapping the messenger package. ~20 LOC of wrapper scaffolding. |
| claude-mem | Hook adapter pattern | ~15 | PATTERN_COPY | Claude Code hook adapter for integration. Thin delegation pattern. |

**Estimated LOC savings:** ~20
**Net new LOC:** ~40
**Design patterns from research repos:** None specific.

---

#### Story 8.3: Webhook Channel for Generic Extensibility (40 LOC) [Growth]

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| (none from source repos) | -- | -- | -- | Standard HTTP POST implementation. |

**Estimated LOC savings:** 0
**Net new LOC:** ~40
**Design patterns from research repos:**
- symphony: Exponential backoff with continuation retries -- informs retry logic for webhook delivery

---

#### Story 8.4: Notification Routing Configuration in factory.yaml (40 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/config.ts` | ~20 | ADAPT | Config section validation pattern. |

**Estimated LOC savings:** ~10
**Net new LOC:** ~30
**Design patterns from research repos:** None specific.

---

#### Story 8.5: Circuit Breaker State Machine (120 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/watchdog/health.ts` | ~181 | ADAPT | ZFC health state machine. The 3-state health model (healthy/degraded/critical) maps to CLOSED/OPEN/HALF_OPEN. State transition logic, error counting, and recovery probing are all directly applicable. ~60 LOC of state machine structure. |

**Estimated LOC savings:** ~50
**Net new LOC:** ~70
**Design patterns from research repos:**
- symphony: Exponential backoff with continuation retries -- informs HALF_OPEN probe intervals

---

#### Story 8.6: Subsystem Health Monitor -- 7 Subsystems (80 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/watchdog/health.ts` | ~181 | ADAPT | Health check aggregation across subsystems. The watchdog's multi-subsystem monitoring (session health, mail health, store health) maps to Factory Core's 7 subsystem monitoring. ~30 LOC of check aggregation pattern. |
| overstory | `src/watchdog/daemon.ts` | ~30 | ADAPT | Polling interval and window-based error counting pattern. |

**Estimated LOC savings:** ~30
**Net new LOC:** ~50
**Design patterns from research repos:**
- GSD: Context monitoring hooks -- informs subsystem probe design

---

#### Story 8.7: Automatic Mitigations (60 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/watchdog/daemon.ts` | ~390 | ADAPT | Progressive escalation pattern with automatic mitigations. The daemon's escalation (warn -> throttle -> kill) maps to mitigation application (pause -> double timeouts -> increase delays). ~20 LOC of mitigation dispatch pattern. |

**Estimated LOC savings:** ~15
**Net new LOC:** ~45
**Design patterns from research repos:**
- symphony: Exponential backoff with continuation retries -- informs mitigation escalation timing

---

#### Story 8.8: Health State Events in events.db (40 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/events/store.ts` | ~180 | ADAPT | Event logging pattern. The EventStore's structured event writing with timestamp, type, and metadata maps to health state event logging. ~15 LOC of event write pattern. |

**Estimated LOC savings:** ~10
**Net new LOC:** ~30
**Design patterns from research repos:** None specific.

---

### Epic 8 Subtotals

| Metric | Value |
|--------|-------|
| Story LOC total | 550 |
| Reusable LOC | ~165 |
| Net new LOC | ~385 |
| Reuse % | 30% |

---

### Epic 9: Dashboard Extensions
**Epic estimated LOC:** ~1,220

#### Story 9.0: ZeroClaw Carry-Forward Adaptation (20 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| zeroclaw | `web/src/lib/sse.ts` | ~186 | DIRECT_COPY + ADAPT | Copy SSE client, change base path from `/_app/` to `/events`, replace ZeroClaw type imports with shared-types event contracts. |
| zeroclaw | `web/src/lib/ws.ts` | ~146 | DIRECT_COPY + ADAPT | Copy WS client, rename subprotocol from `zeroclaw.v1` to `qds.v1`, change auth token path to `.qds/ws-token`, replace type imports. |
| zeroclaw | `web/index.html` | ~30 | DIRECT_COPY | Copy as-is. |
| zeroclaw | `web/vite.config.ts` | ~20 | DIRECT_COPY | Copy as-is. |
| zeroclaw | `web/tsconfig.json` | ~15 | DIRECT_COPY | Copy as-is. |
| zeroclaw | `web/tsconfig.app.json` | ~10 | DIRECT_COPY | Copy as-is. |

**Estimated LOC savings:** ~332 (6 files copied, 4 adapted with ~20 LOC of changes)
**Net new LOC:** ~20 (adaptation changes only)
**CRITICAL FINDING:** This story MUST precede all other Epic 9 stories. The deep-dive's 4-item adaptation checklist (type contracts, auth path, subprotocol, base path) ensures ZeroClaw plumbing works in the QDS context before any dashboard features are built on top.
**Design patterns from research repos:** None specific.

---

#### Story 9.1: Revised Performance Dashboard (200 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| zeroclaw | `web/src/lib/sse.ts` | ~186 | ADAPT_PATTERN | Fetch-based SSE client with auto-reconnect and backoff. Dashboard receives performance data via SSE from gateway. Adapt ZeroClaw's SSE implementation to QDS event types. ~80 LOC of SSE client infrastructure. |
| zeroclaw | React hooks `useSSE.ts` | ~50 | ADAPT_PATTERN | React hook for SSE subscription management. ~30 LOC of hook pattern. |

**Estimated LOC savings:** ~60
**Net new LOC:** ~140
**Design patterns from research repos:** None specific for dashboard rendering.

---

#### Story 9.2: Learning Effectiveness Panel (180 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| (none from source repos) | -- | -- | -- | Novel dashboard component. Chart rendering and filter logic are new. |

**Estimated LOC savings:** 0
**Net new LOC:** ~180
**Design patterns from research repos:** None specific.

---

#### Story 9.3: Burn Rate Prediction Panel (150 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| (none from source repos) | -- | -- | -- | Novel dashboard component. Burn rate cards and charts are new. |

**Estimated LOC savings:** 0
**Net new LOC:** ~150
**Design patterns from research repos:** None specific.

---

#### Story 9.4: System Health Indicator (180 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| zeroclaw | `web/src/lib/ws.ts` | ~146 | ADAPT_PATTERN | WebSocket client with session persistence and subprotocol auth. Health status updates could use WS for real-time push. ~40 LOC of WS client pattern. Subprotocol renamed from `zeroclaw.v1` to `qds.v1`. |
| zeroclaw | React hooks `useWebSocket.ts` | ~50 | ADAPT_PATTERN | React hook for WS subscription. ~25 LOC of hook pattern. |

**Estimated LOC savings:** ~40
**Net new LOC:** ~140
**Design patterns from research repos:** None specific.

---

#### Story 9.5: Epic Progress View (200 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| (none from source repos) | -- | -- | -- | Novel Gantt-style view. No direct source repo precedent. |

**Estimated LOC savings:** 0
**Net new LOC:** ~200
**Design patterns from research repos:** None specific.

---

#### Story 9.6: Revised Copilot Interactions -- 7 New Capabilities (130 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| (none from source repos) | -- | -- | -- | Novel copilot actions. Follows existing copilot orchestration pattern already in the dashboard. |

**Estimated LOC savings:** 0
**Net new LOC:** ~130
**Design patterns from research repos:** None specific.

---

#### Story 9.7: AmbientHeader Updates (60 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| (none from source repos) | -- | -- | -- | Modification to existing component. |

**Estimated LOC savings:** 0
**Net new LOC:** ~60
**Design patterns from research repos:** None specific.

---

#### Story 9.8: Bottom Drawer with Tab Switching (100 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| (none from source repos) | -- | -- | -- | Novel UI component. Standard React drawer pattern. |

**Estimated LOC savings:** 0
**Net new LOC:** ~100
**Design patterns from research repos:** None specific.

---

### Epic 9 Subtotals

| Metric | Value |
|--------|-------|
| Story LOC total | 1,220 |
| Reusable LOC | ~432 |
| Net new LOC | ~788 |
| Reuse % | 35% |

**Note:** Story 9.0 dramatically increases Epic 9's reuse percentage from 8% to 35% by accounting for the 332 LOC of carry-forward files. The remaining dashboard UI stories (9.1-9.8) are still predominantly novel implementations.

---

### Epic 10: Growth Phase -- Behavioral Effects
**Epic estimated LOC:** ~730

#### Story 10.1: ELO Domain Rating Computation (100 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/metrics/store.ts` | ~20 | ADAPT | Metrics table insert/query pattern for elo_ratings table. |

**Estimated LOC savings:** ~10
**Net new LOC:** ~90
**Design patterns from research repos:**
- GSD: Model profile resolution -- informs domain-based rating scoping

---

#### Story 10.2: Tier Evaluation with Hysteresis and Dwell (90 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| (none from source repos) | -- | -- | -- | Novel tier evaluation logic. No direct precedent in source repos. |

**Estimated LOC savings:** 0
**Net new LOC:** ~90
**CRITICAL FINDING:** Pi SDK has NO native tier concept. Factory Core must own the entire tier-to-model mapping. Pi's ModelRegistry.find() provides model catalog lookup, but the tier assignment, hysteresis, and dwell logic are entirely Factory Core's responsibility.
**Design patterns from research repos:**
- GSD: Model profile resolution -- the closest pattern, but GSD's profiles are static; QDS tiers are dynamic

---

#### Story 10.3: Tier Demotion Logic (70 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| (none from source repos) | -- | -- | -- | Extension of 10.2 tier logic. Novel. |

**Estimated LOC savings:** 0
**Net new LOC:** ~70
**Design patterns from research repos:** None specific.

---

#### Story 10.4: Performance-Based Task Routing with 15% Exploration (80 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| pi-mono | `ModelRegistry.find()` | ~15 | API_CONSUME | Model catalog lookup for resolving tier to available models. |

**Estimated LOC savings:** ~5
**Net new LOC:** ~75
**Design patterns from research repos:**
- GSD: Model profile resolution -- informs model selection within a tier

---

#### Story 10.5: Random Audit Mechanism (60 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| (none from source repos) | -- | -- | -- | Novel audit mechanism. |

**Estimated LOC savings:** 0
**Net new LOC:** ~60
**Design patterns from research repos:** None specific.

---

#### Story 10.6: Anti-Gaming Protections (80 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| (none from source repos) | -- | -- | -- | Novel protection logic. Policy enforcement, not infrastructure. |

**Estimated LOC savings:** 0
**Net new LOC:** ~80
**Design patterns from research repos:** None specific.

---

#### Story 10.7: ELO Migration Strategy -- Versioned Rating Epochs (80 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/sessions/store.ts` | ~20 | ADAPT | Migration pattern for schema evolution. |
| claude-mem | MigrationRunner pattern | ~10 | PATTERN_COPY | Version-checking migration runner pattern for epoch transitions. |

**Estimated LOC savings:** ~10
**Net new LOC:** ~70
**Design patterns from research repos:** None specific.

---

#### Story 10.8: Channel Status Panel (80 LOC) [Growth]

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| zeroclaw | React hooks | ~15 | ADAPT_PATTERN | SSE/WS subscription hooks for real-time channel status updates. |

**Estimated LOC savings:** ~10
**Net new LOC:** ~70
**Design patterns from research repos:** None specific.

---

#### Story 10.9: Automated Pattern Knowledge Mining (90 LOC) [Growth]

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/insights/analyzer.ts` | ~203 | ADAPT | Cross-session correlation pattern for automated pattern discovery. ~20 LOC of correlation logic. |

**Estimated LOC savings:** ~15
**Net new LOC:** ~75
**Design patterns from research repos:**
- deer-flow: LLM-based memory with debounced queue -- informs daily batch mining trigger

---

### Epic 10 Subtotals

| Metric | Value |
|--------|-------|
| Story LOC total | 730 |
| Reusable LOC | ~50 |
| Net new LOC | ~680 |
| Reuse % | 7% |

**Note:** Epic 10 has the lowest reuse percentage (730 LOC, 7% reuse). Growth-phase behavioral effects (ELO, tiers, routing, audit, anti-gaming) are novel QDS-specific logic with no direct precedent in source repos. Pi SDK provides model catalog lookup (API_CONSUME) but no tier management.

---

## Section 2: REUSE SUMMARY TABLE

### Overall Project Totals

| Metric | Value |
|--------|-------|
| **Total estimated LOC (all stories)** | **6,470** |
| **Total reusable LOC from source repos** | **2,032** |
| **Net new LOC required** | **4,438** |
| **Overall reuse percentage** | **31.4%** |

### Breakdown by Epic

| Epic | Scope | Estimated LOC | Reusable LOC | Net New LOC | Reuse % |
|------|-------|---------------|-------------|-------------|---------|
| 1 | Foundation | 670 | 455 | 215 | 68% |
| 2 | Middleware Chain | 390 | 125 | 265 | 32% |
| 3 | Verification | 660 | 140 | 520 | 21% |
| 4 | Turn Continuation | 650 | 235 | 415 | 36% |
| 5 | Performance Data | 510 | 140 | 370 | 27% |
| 6 | Economic Governance | 450 | 130 | 320 | 29% |
| 7 | Learning System | 640 | 160 | 480 | 25% |
| 8 | Notifications/Health | 550 | 165 | 385 | 30% |
| 9 | Dashboard Extensions | 1,220 | 432 | 788 | 35% |
| 10 | Growth Behavioral | 730 | 50 | 680 | 7% |
| **TOTAL** | | **6,470** | **2,032** (note 1) | **4,438** | **31.4%** |

*Note 1: Reusable LOC increased from 1,630 to 2,032 due to Story 9.0 carry-forward accounting (332 LOC), new stories 1.6, 2.9, 4.0 contributing additional code-lift references, and corrected Epic 7/10 story sums.*

### Breakdown by Reuse Type

| Reuse Type | Description | LOC Savings | % of Total Reuse |
|------------|-------------|-------------|------------------|
| DIRECT_COPY | Import/copy with minimal changes | ~650 | 32.0% |
| ADAPT | Modify structure/types for QDS context | ~910 | 44.8% |
| PATTERN_COPY | Replicate design pattern, new implementation | ~250 | 12.3% |
| INTERFACE_CARRY | Carry type definitions across packages | ~160 | 7.9% |
| API_CONSUME | Call external API, write integration glue | ~60 | 3.0% |
| STUDY / ADAPT_PATTERN | Design reference only (ZeroClaw Rust, research) | Patterns only | N/A |
| **TOTAL** | | **2,032** | **100%** |

### Breakdown by Source Repository

| Source Repo | Total Reusable LOC | Primary Target Epics | Key Modules |
|-------------|-------------------|---------------------|-------------|
| **Overstory** | ~1,190 | 1, 2, 3, 4, 5, 6, 7, 8 | types.ts, sessions/store.ts, config.ts, watchdog/*, metrics/*, insights/analyzer.ts, agents/overlay.ts, merge/resolver.ts |
| **Pi-Mono** | ~170 | 1, 2, 4, 5, 6, 10 | ai/types.ts, agent/types.ts, Agent class API, Usage callback, transformContext, ModelRegistry |
| **Superpowers** | ~210 (import) | 2 | skills-core.js (IMPORT_AS_IS with .d.ts) |
| **ZeroClaw** | ~432 | 9, 10 | web/src/lib/sse.ts, web/src/lib/ws.ts, React hooks, carry-forward files (Story 9.0) |
| **Claude-Mem** | ~120 | 1, 4, 6, 7 | MigrationRunner, SessionManager, PendingMessageStore, ContextBuilder |
| **Research Repos** | Patterns only | All | deer-flow middleware, GSD Nyquist, symphony GenServer, paperclip adapter |

---

## Section 3: CRITICAL ARCHITECTURAL DECISIONS VALIDATED

### 1. Pi SDK Has NO Tier Concept -- Factory Core Owns Tier Mapping (CONFIRMED)

**Source:** pi-mono deep-dive analysis
**Impact:** Stories 10.1, 10.2, 10.3, 10.4
**Detail:** Pi SDK provides `ModelRegistry.find()` for model catalog lookup and `Agent.setModel()` for model switching, but has zero concept of performance tiers, ELO ratings, or tier-based routing. Factory Core must implement the ENTIRE tier system: ELO computation, tier thresholds with hysteresis, dwell requirements, demotion logic, and tier-to-model mapping. Pi SDK is a pure execution engine that does what Factory Core tells it to do.

### 2. Superpowers Frontmatter Has NO Enforcement Field -- Description IS the Metadata (CONFIRMED)

**Source:** Superpowers deep-dive analysis
**Impact:** Stories 2.5, 2.6
**Detail:** Superpowers skill files have exactly 2 frontmatter fields: `name` and `description`. There is no dedicated `enforcement` field, `rules` array, or structured enforcement metadata. The enforcement middleware must parse the `description` text content to determine enforcement semantics. The 3 critical enforcement skills are: TDD, verification-before-completion, and systematic-debugging. Their descriptions contain the enforcement instructions.

### 3. Overstory SessionStore Pattern Is the Template for ALL Factory SQLite Stores (CONFIRMED)

**Source:** Overstory deep-dive analysis
**Impact:** Stories 1.2, 1.3, 4.3, 5.1, 5.2, 5.3, 5.6, 6.1, 6.3, 6.4, 7.4, 8.8, 10.1
**Detail:** `sessions/store.ts` (~440 LOC) establishes the canonical pattern: WAL mode on open, prepared statement caching, sequential migration execution with tracking table, UNIQUE constraints for idempotency, indexed queries for performance. Every pipeline.db and attribution.db table follows this pattern.

### 4. Pi's transformContext Callback Is the Middleware Injection Point (CONFIRMED)

**Source:** pi-mono deep-dive analysis
**Impact:** Stories 2.1 through 2.8, 4.4
**Detail:** Pi SDK's `transformContext` callback is how Factory Core's middleware chain inserts context into agent prompts. The middleware chain's `runBefore()` phase collects `contextAdditions` from all middleware, which are then passed to the agent via `transformContext`. This is a single injection point -- all middleware context is assembled BEFORE the Pi SDK call, not injected piecemeal.

### 5. Pi's getApiKey Callback Is the Credential Injection Mechanism, NOT Overlay Text (CONFIRMED)

**Source:** pi-mono deep-dive analysis
**Impact:** Story 2.3
**Detail:** Credentials are injected via Pi SDK's `getApiKey` callback function, NOT by embedding API keys in overlay text. This is a security-critical distinction. The credential middleware configures the callback; Pi SDK invokes it when needed. No credential material should ever appear in `contextAdditions` or overlay content.

### 6. ZeroClaw's Subprotocol Auth Pattern Carries Forward (CONFIRMED)

**Source:** ZeroClaw deep-dive analysis
**Impact:** Stories 9.1, 9.4
**Detail:** ZeroClaw's WebSocket client uses subprotocol-based authentication (`ws.ts`, ~146 LOC). The QDS dashboard will rename the subprotocol from `zeroclaw` to `qds.v1` but preserve the authentication mechanism. The SSE client (`sse.ts`, ~186 LOC) with fetch-based reconnection and exponential backoff also carries forward for non-WebSocket event streams.

### 7. Pi SDK's Usage.cost.total Provides Pre-Computed Per-Call Cost (CONFIRMED)

**Source:** pi-mono deep-dive analysis
**Impact:** Stories 5.1, 5.4, 6.4
**Detail:** Pi SDK's `Usage` object includes `cost.total` already computed from the provider's pricing. Factory Core does NOT need to implement cost computation from token counts -- it receives the final cost from Pi. However, Overstory's `metrics/pricing.ts` (DIRECT_COPY) is still needed for budget projection and historical cost analysis where Pi's real-time cost is unavailable.

### 8. Overstory's Merge Resolver Provides Tiered Resolution for Disagreement Protocol (CONFIRMED)

**Source:** Overstory deep-dive analysis
**Impact:** Story 3.7
**Detail:** `merge/resolver.ts` (~383 LOC) implements tiered resolution with conflict parsing and prose detection. The tier classification (structural vs semantic vs ambiguous) and escalation logic maps directly to the Nyquist-BMAD disagreement protocol's four scenarios.

### 9. Only 2 of 5 Superpowers Functions Needed at Runtime (CONFIRMED)

**Source:** Superpowers deep-dive analysis
**Impact:** Stories 2.5, 2.6
**Detail:** Of the 5 exported functions in `skills-core.js`, Factory Core only uses `findSkillsInDir()` and `extractFrontmatter()` at runtime. The other 3 (init, install, uninstall) are for Claude Code plugin bootstrap, not Factory Core integration. This means the runtime dependency is minimal.

### 10. Claude-Mem's Claim-Confirm Pattern Maps to Task Checkout (NEW FINDING)

**Source:** Claude-mem deep-dive analysis
**Impact:** Story 6.3
**Detail:** PendingMessageStore's atomic claim-confirm pattern (~100 LOC savings) uses the exact same UNIQUE constraint + timeout-based release mechanism that task_checkouts needs. This is a closer match than Overstory's session store pattern for this specific use case.

---

## Section 4: GAP ANALYSIS -- Stories with ZERO Code-Lift References

The following stories have **no reusable code** from any source repository and require **100% new implementation**. These are risk areas needing extra attention during implementation.

### High-Risk (Complex Novel Logic, No Precedent)

| Story | LOC | Risk Factor |
|-------|-----|-------------|
| **3.6: Oscillation Detector** | 60 | Novel algorithm detecting false-negative fix-loops. No source repo precedent. Requires careful state tracking across fix-loop iterations. |
| **10.2: Tier Evaluation with Hysteresis** | 90 | Novel tier management with hysteresis bands and dwell requirements. Pi SDK provides no tier support. Must be designed from scratch. |
| **10.3: Tier Demotion Logic** | 70 | Extension of 10.2. Consecutive failure tracking with counter resets. |
| **10.5: Random Audit Mechanism** | 60 | Novel audit selection with deterministic randomization and elevated scoring weights. |
| **10.6: Anti-Gaming Protections** | 80 | Policy enforcement across multiple system boundaries (overlay exclusion, weight immutability, bounded scoring). |

### Medium-Risk (Novel UI, Standard Patterns Available)

| Story | LOC | Risk Factor |
|-------|-----|-------------|
| **9.2: Learning Effectiveness Panel** | 180 | Novel dashboard charts (stacked area, records feed). Standard charting library usage but QDS-specific data shapes. |
| **9.3: Burn Rate Prediction Panel** | 150 | Novel burn rate cards with overflow progress bars. QDS-specific visualization. |
| **9.5: Epic Progress View** | 200 | Gantt-style timeline with dependency lines. Most complex novel UI component. |
| **9.6: Revised Copilot Interactions** | 130 | 7 new copilot action categories. Follows existing copilot pattern but entirely new actions. |
| **9.7: AmbientHeader Updates** | 60 | Modification to existing component. Low risk but no code-lift. |
| **9.8: Bottom Drawer with Tab Switching** | 100 | Standard React drawer pattern but custom interaction model (scroll independence, height persistence). |

### Low-Risk (Small, Well-Defined, Standard Patterns)

| Story | LOC | Risk Factor |
|-------|-----|-------------|
| **2.7: Verification Middleware** | 30 | Stub implementation -- simple pass-through. |
| **2.8: Performance Middleware Stub** | 40 | Stub implementation -- placeholder scores. |
| **5.4: Integration Wiring** | 30 | Replaces stub with real call. Straightforward wiring. |
| **8.3: Webhook Channel** | 40 | Standard HTTP POST with retry. [Growth] |

**Total 100% New LOC in Gap Stories:** ~1,320 LOC (21% of total project)

---

## Section 5: IMPLEMENTATION PRIORITY ORDER

Based on the dependency chain, reuse scaffolding opportunities, and risk mitigation, the recommended implementation order is:

### Phase 1: Foundation Scaffolding (Stories that unlock everything else)

**Priority:** HIGHEST -- These establish all shared infrastructure.

| Order | Story | LOC | Rationale |
|-------|-------|-----|-----------|
| 1 | **1.5** Result<T> Utility Type | 30 | Zero dependencies. Used by every async boundary in all subsequent stories. Smallest story, immediate value. |
| 2 | **1.1** shared-types Package | 210 | Zero dependencies. Defines all Zod schemas consumed by every other epic. 69% reuse from Overstory types. |
| 3 | **1.2** pipeline.db Migration System | 200 | Zero dependencies. Every data-writing story depends on this. High reuse from Overstory session store. |
| 4 | **1.3** attribution.db Schema Extension | 20 | Depends on 1.2. Tiny story, unlocks budget enforcement (Epic 6). |
| 5 | **1.4** Factory Core Process Skeleton | 170 | Depends on 1.1, 1.2, 1.3. Proves the startup sequence. High reuse from Overstory config.ts. |
| 6 | **1.6** Overstory Schema Extensions | 40 | Depends on 1.4. Unlocks Stories 3.3, 8.8. Uses Overstory's native probe-then-alter pattern. |

**Phase 1 total:** 670 LOC, ~455 LOC reused (68% reuse)

### Phase 2: Middleware Chain (Unlocks Epics 3, 4, 5 in parallel)

**Priority:** HIGH -- The middleware chain is the central nervous system.

| Order | Story | LOC | Rationale |
|-------|-------|-----|-----------|
| 7 | **2.1** MiddlewareChain Executor | 100 | Depends on 1.1, 1.4. Core chain infrastructure. deer-flow middleware pattern as design reference. |
| 8 | **2.9** TierResolver | 50 | Depends on 1.1, 1.4. Required by budget and credential middlewares. Pi SDK ModelRegistry validation. |
| 9 | **2.2** Budget Middleware | 40 | Depends on 2.1. Fatal middleware -- must work early. Reuses Overstory pricing. |
| 10 | **2.3** Credential Middleware | 30 | Depends on 2.1. Fatal middleware. Pi SDK getApiKey callback. |
| 11 | **2.5** Enforcement Middleware | 30 | Depends on 2.1. Superpowers import (IMPORT_AS_IS). |
| 12 | **2.6** Skill Middleware | 20 | Depends on 2.1. Shares Superpowers import with 2.5. |
| 13 | **2.4** Learning Middleware | 50 | Depends on 2.1. Stub until Epic 7 populates learning records. |
| 14 | **2.7** Verification Middleware | 30 | Depends on 2.1. Stub until Epic 3 implements real verifier. |
| 15 | **2.8** Performance Middleware Stub | 40 | Depends on 2.1. Stub until Epic 5 implements real scorer. |

**Phase 2 total:** 390 LOC, ~125 LOC reused (32% reuse)

### Phase 3: Three Parallel Workstreams (Epics 3, 4, 5 can execute concurrently)

**Priority:** HIGH -- Maximum parallelism opportunity.

**Workstream A: Verification (Epic 3)**

| Order | Story | LOC | Rationale |
|-------|-------|-----|-----------|
| 16a | **3.1** must_haves Parser | 60 | Foundation for all verification. |
| 17a | **3.2** Lightweight Verifier | 100 | Core verification logic. GSD Nyquist pattern. |
| 18a | **3.3** Post-Task Hook Integration | 60 | Wires verifier into middleware. |
| 19a | **3.4** Full Nyquist Verifier | 150 | LLM-powered verification. |
| 20a | **3.5** Pre-BMAD Gate | 80 | Catches phantom completions. |
| 21a | **3.6** Oscillation Detector | 60 | GAP STORY -- needs extra design attention. |
| 22a | **3.7** Disagreement Protocol | 150 | Complex resolver. Reuses Overstory merge resolver. |

**Workstream B: Turn Continuation (Epic 4)**

| Order | Story | LOC | Rationale |
|-------|-------|-----|-----------|
| 16b-pre | **4.0** Orchestration Loop | 120 | Connects startup skeleton to turn engine. Symphony GenServer pattern. MUST precede 4.1. |
| 16b | **4.1** Turn Continuation Loop | 120 | Core loop. Reuses Overstory watchdog daemon. |
| 17b | **4.5** Workspace Lifecycle Hooks | 150 | Independent of turn loop. Symphony pattern. |
| 18b | **4.2** Progress Velocity Check | 40 | Extends turn loop. |
| 19b | **4.3** Turn State Persistence | 60 | Crash recovery. Reuses claude-mem patterns. |
| 20b | **4.4** Continuation Prompt Template | 40 | Pi SDK transformContext injection. |
| 21b | **4.6** Hook Rollback | 70 | Extends lifecycle hooks. |
| 22b | **4.7** Stall Detection | 50 | Integrates with turn loop and circuit breaker. |

**Workstream C: Performance Data (Epic 5)**

| Order | Story | LOC | Rationale |
|-------|-------|-----|-----------|
| 16c | **5.1** Action Scorer | 120 | Core scoring. Reuses Overstory metrics patterns. |
| 17c | **5.5** Learning Record Extractor | 100 | DIRECT_COPY from Overstory insights/analyzer. |
| 18c | **5.2** Confidence Tracker | 80 | Statistical computation. |
| 19c | **5.3** Session Composite | 100 | Aggregation layer. |
| 20c | **5.4** Performance Middleware Integration | 30 | Replaces stub from 2.8. |
| 21c | **5.6** Overlay Effectiveness Tracker | 80 | Measures learning system impact. |

**Phase 3 total:** 1,820 LOC across 3 workstreams, ~515 LOC reused (28% reuse)

### Phase 4: Economic Governance (Epic 6)

**Priority:** MEDIUM -- Depends on Epics 2 and 5.

| Order | Story | LOC | Rationale |
|-------|-------|-----|-----------|
| 23 | **6.4** Cost Data Flow | 80 | Pi SDK Usage callback wiring. Foundation for budget queries. |
| 24 | **6.1** Per-Story Budget Enforcement | 90 | Core enforcement. |
| 25 | **6.2** Global Ceiling Enforcement | 80 | Extends per-story pattern. |
| 26 | **6.3** Atomic Task Checkout | 90 | Claude-mem claim-confirm pattern. |
| 27 | **6.5** Burn Rate Prediction | 60 | Feeds dashboard and notifications. |
| 28 | **6.6** Budget Breach Notification | 50 | Soft dependency on MessageBus (Epic 8). |

**Phase 4 total:** 450 LOC, ~130 LOC reused (29% reuse)

### Phase 5: Learning System (Epic 7) + Notifications/Health (Epic 8) -- Can Partially Overlap

**Priority:** MEDIUM

**Epic 7:**

| Order | Story | LOC |
|-------|-------|-----|
| 29 | **7.4** Epic Context Tables | 80 |
| 30 | **7.1** Fix-Loop Learning Extraction | 100 |
| 31 | **7.2** Maintenance Learning Extraction | 90 |
| 32 | **7.5** Epic Context Assembly | 100 |
| 33 | **7.6** Epic Context Extraction | 80 |
| 34 | **7.7** Overlay Enrichment | 70 |

**Epic 8 (can start once Epic 1 is complete; 8.1-8.4 are independent of Epics 5-7):**

| Order | Story | LOC |
|-------|-------|-----|
| 29' | **8.1** MessageBus | 110 |
| 30' | **8.2** TelegramChannel | 60 |
| 31' | **8.4** Routing Config | 40 |
| 32' | **8.5** Circuit Breaker | 120 |
| 33' | **8.6** Subsystem Monitor | 80 |
| 34' | **8.7** Mitigations | 60 |
| 35' | **8.8** Health Events | 40 |

**Phase 5 total:** 1,030 LOC, ~305 LOC reused (30% reuse)

### Phase 6: Dashboard Extensions (Epic 9)

**Priority:** MEDIUM-LOW -- Depends on data from Epics 5, 6, 7, 8.

| Order | Story | LOC | Notes |
|-------|-------|-----|-------|
| 36-pre | **9.0** ZeroClaw Carry-Forward | 20 | 6 files copied and adapted. MUST precede all other Epic 9 stories. |
| 36 | **9.8** Bottom Drawer | 100 | Shell component, no data dependency. Can start early. |
| 37 | **9.1** Performance Dashboard | 200 | ZeroClaw SSE/WS infrastructure reuse. |
| 38 | **9.4** System Health Indicator | 180 | ZeroClaw WS pattern. |
| 39 | **9.7** AmbientHeader Updates | 60 | Depends on 9.4. |
| 40 | **9.2** Learning Effectiveness Panel | 180 | GAP STORY -- 100% new. |
| 41 | **9.3** Burn Rate Prediction Panel | 150 | GAP STORY -- 100% new. |
| 42 | **9.5** Epic Progress View | 200 | GAP STORY -- most complex novel UI. |
| 43 | **9.6** Copilot Interactions | 130 | Depends on all other Epic 9 views. |

**Phase 6 total:** 1,220 LOC, ~432 LOC reused (35% reuse)

### Phase 7: Growth Behavioral Effects (Epic 10)

**Priority:** LOW (Growth phase) -- All stories are Growth.

| Order | Story | LOC | Notes |
|-------|-------|-----|-------|
| 44 | **10.1** ELO Rating | 100 | Foundation for all Growth behavioral effects. |
| 45 | **10.2** Tier Evaluation | 90 | GAP STORY -- novel, extra design needed. |
| 46 | **10.3** Tier Demotion | 70 | GAP STORY. |
| 47 | **10.6** Anti-Gaming | 80 | GAP STORY -- policy enforcement. |
| 48 | **10.4** Task Routing | 80 | Uses ELO + tiers. |
| 49 | **10.5** Random Audit | 60 | GAP STORY. |
| 50 | **10.7** ELO Migration | 80 | Versioned epochs. |
| 51 | **7.3** Pattern Knowledge Mining | 120 | Growth automation of Layer 2. |
| 52 | **10.9** Automated Pattern Mining | 90 | Extends 7.3 to daily automation. |
| 53 | **10.8** Channel Status Panel | 80 | Dashboard Growth component. |
| 54 | **8.3** Webhook Channel | 40 | Growth extensibility. |

**Phase 7 total:** 890 LOC (all Growth), ~65 LOC reused (7% reuse)

---

### Priority Summary

| Phase | Epics | LOC | Reuse % | Parallelism |
|-------|-------|-----|---------|-------------|
| 1. Foundation | 1 | 670 | 68% | Sequential |
| 2. Middleware | 2 | 390 | 32% | Sequential |
| 3. Three Workstreams | 3, 4, 5 | 1,820 | 28% | **3-way parallel** |
| 4. Economics | 6 | 450 | 29% | Sequential |
| 5. Learning + Health | 7, 8 | 1,030 | 30% | **2-way parallel** |
| 6. Dashboard | 9 | 1,220 | 35% | Partially parallel |
| 7. Growth | 10 + Growth stories | 890 | 7% | Partially parallel |
| **TOTAL** | | **6,470** | **31%** | |

**Key insight:** Phases 1-2 (1,060 LOC, 55% reuse) establish the scaffolding that maximizes reuse for all subsequent phases. Investing in careful code-lifting during these phases pays dividends throughout the project. Phase 3's three-way parallelism is the largest acceleration opportunity.

---

*End of Code-Lift Manifest v2.0 — Session 10 update. 4 new stories added (1.6, 2.9, 4.0, 9.0), totals revised with corrected story sums, priority order updated.*
