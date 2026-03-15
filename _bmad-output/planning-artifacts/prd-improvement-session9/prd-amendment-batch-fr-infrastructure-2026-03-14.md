# PRD Amendment Batch — FR Infrastructure & Decomposition Readiness
## QDS Engineer v2 — prd-v2.md Targeted Amendments
**Date:** 2026-03-14
**Source analyses:**
- `prd-analysis-fr-dependency-graph-2026-03-14.md`
- `prd-analysis-epic-decomposition-readiness-2026-03-14.md`
**Scope:** FR32, FR28, FR77, FR6, FR14, FR4, FR48, FR92, FR98, FR100, FR149, FR145 (new sub-req), Implementation Sequencing section, new FRs for Sprint 0 artifacts, Gateway API, Seeds deduplication/claim-locking

---

## How to Apply These Amendments

Each amendment below targets a specific FR or section in `prd-v2.md`. Apply them in the order listed — amendments later in this batch may reference items introduced earlier. Amendments marked **NEW_FR** add text to the prd-v2.md; placement instructions are included in the Replacement text.

Total amendments: **14**

---

## AMENDMENT 1: FR32 — Phase Boundary Protocol Manifest Schema
**Type:** MODIFY_FR
**Target:** FR32 (under "Overlay & Context Management")
**Reason:** FR32's "required sections" are referenced in the FR body but never enumerated; FR18 (phase boundary hook validation), FR58 (learnings section), and FR131 (confidence calibration) cannot be specified as stories without a canonical manifest schema, giving this a risk score of 25/25 in the decomposition readiness analysis.

**Original text:**
```
- **FR32:** Phase Boundary Protocol can transfer structured manifests between phases containing required sections, context budget consumed, and a learnings section
```

**Replacement text:**
```
- **FR32:** Phase Boundary Protocol can transfer structured manifests between phases using the canonical YAML schema defined below. This schema is a **Sprint 0 prerequisite artifact** — it must be finalized before FR18, FR58, or FR131 enter active development.

  **Phase Boundary Protocol Manifest Schema (canonical — YAML):**
  ```yaml
  # Phase Boundary Protocol Transfer Manifest
  # Required fields are marked [REQUIRED]. All others are optional but recommended.
  story_id: string                  # [REQUIRED] Unique story identifier (matches pipeline.db)
  phase_from: string                # [REQUIRED] Departing phase name (e.g., "develop", "bmad_review")
  phase_to: string                  # [REQUIRED] Receiving phase name
  completed_at: ISO8601 datetime    # [REQUIRED] Timestamp of phase completion
  confidence: float                 # [REQUIRED] Agent confidence in phase outcome (0.0–1.0)
  context_budget_consumed_tokens: int  # [REQUIRED] Total tokens consumed in this phase's overlay
  completed_artifacts:              # [REQUIRED] List of files created or substantively modified
    - path: string
      change_type: "created" | "modified" | "deleted"
  open_questions: []                # [REQUIRED] Unresolved questions requiring next-phase attention (empty list if none)
  learnings:                        # [REQUIRED] Struggles and discoveries for Loop 2 learning transfer
    - scope: string                 # File path or domain this learning applies to
      finding: string               # What was discovered or struggled with
      severity: "critical" | "recommended" | "informational"
  summary: string                   # [REQUIRED] ≤300-word narrative of what was accomplished
  struggles: []                     # Specific blockers encountered (list of strings)
  discoveries: []                   # Unexpected findings that benefit subsequent phases (list of strings)
  architecture_decisions: []        # ADRs or design choices made during this phase (list of strings)
  file_scope_conventions: []        # Established conventions the next phase should respect (list of strings)
  hook_results:                     # Gate enforcement outcomes at phase boundary
    tests_passing: bool
    lint_clean: bool
    type_check_clean: bool
    scope_violations_detected: bool
    tdd_pairs_present: bool
    manifest_validation_passed: bool
  ```

  Manifest serialization format: YAML. Manifests are written by the departing phase agent and validated by FR18's phase boundary hook before the next-phase agent is spawned. Invalid manifests (missing required fields, out-of-range confidence values, malformed hook_results) block phase transition and escalate to the developer.
```
---

## AMENDMENT 2: FR28 — Overlay Composition Pipeline Interface Contract
**Type:** MODIFY_FR
**Target:** FR28 (under "Overlay & Context Management")
**Reason:** FR28 is a complete subsystem masquerading as a single sentence; the absence of an interface contract between stages and a budget manifest schema means any two developers implementing stories against FR28 will produce incompatible truncation interfaces, giving this a risk score of 20/25 in the decomposition readiness analysis.

**Original text:**
```
- **FR28:** Factory Core's overlay composition pipeline can assemble agent overlays from 6 ordered stages (system prompt, Superpowers skills, Mulch expertise, Factory Learnings, Phase Boundary manifest, task instructions) within a hard token ceiling
```

**Replacement text:**
```
- **FR28a (Overlay Assembly Pipeline):** Factory Core's overlay composition pipeline assembles agent overlays from 6 ordered stages within a hard token ceiling, using the interface contract and budget manifest schema defined below. This specification is a **Sprint 0 prerequisite artifact** and must be finalized before any of FR29–FR35, FR61, FR155, or FR167 enter active development.

  **6-Stage Pipeline — Ordered Assembly:**

  | Stage | Content Source | Priority | Hard Token Budget (default) |
  |-------|---------------|----------|-----------------------------|
  | 1 | System prompt (agent role + factory iron laws) | Highest — never truncated | 2,000 tokens |
  | 2 | Superpowers skills (FR33) + enforcement metadata (FR34) | High — truncate least-relevant skills first | 4,000 tokens |
  | 3 | Mulch expertise scoped to agent file path (FR35) | Medium-high — truncate by recency | 3,000 tokens |
  | 4 | Factory Learnings injection (FR61/FR167) — synthesized, enriched | Medium — truncate by tier (informational first) | 2,000 tokens |
  | 5 | Phase Boundary Protocol manifest from prior phase (FR32) | Medium — never truncated if present; absent on first phase | 3,000 tokens |
  | 6 | Task instructions (story spec excerpt + acceptance criteria) | Low — task scope split or tier escalation if truncation needed (FR31) | 4,000 tokens |

  **Stage Interface Contract:**
  Each stage receives: `(available_tokens: int, role: AgentRole, file_scope: string[], story_id: string) → StageOutput`
  Each stage returns: `{ content: string, tokens_consumed: int, items_included: string[], items_truncated: string[], truncation_reason: string | null }`

  The pipeline accumulates stage outputs sequentially. If a stage would exceed its budget, it invokes its own truncation strategy (priority ranking within the stage) before returning. Stage 6 failure triggers FR31 (scope split or tier escalation), not silent truncation.

  **Budget Manifest Output (written per agent launch):**
  ```yaml
  # Overlay Budget Manifest — written to pipeline.db and attached to attribution record
  story_id: string
  agent_id: string
  phase: string
  launched_at: ISO8601 datetime
  model_context_limit_tokens: int
  hard_ceiling_tokens: int
  stages:
    - stage: int                    # 1–6
      content_type: string          # "system_prompt" | "superpowers" | "mulch" | "learnings" | "manifest" | "task"
      tokens_allocated: int
      tokens_consumed: int
      items_included: int           # count
      items_truncated: int          # count
      truncation_reason: string | null
  total_tokens_consumed: int
  budget_utilization_pct: float     # total_tokens_consumed / hard_ceiling_tokens
  ```

- **FR28b (Stage Budget Manifest Schema):** The overlay composition pipeline writes a structured budget manifest (schema defined in FR28a) to `pipeline.db` for every agent launch. This manifest is the primary data source for FR77's "overlay stage efficiency" analysis dimension and for dashboard cost visualization (FR46).
```
---

## AMENDMENT 3: FR77 — Daily Cron Observer Analysis Dimensions
**Type:** MODIFY_FR
**Target:** FR77 (under "Meta-Optimization (Factory Self-Improvement)")
**Reason:** Three of FR77's nine analysis dimensions are algorithmically undefined ("prompt effectiveness," "overlay stage efficiency," "model tier performance"), and the daily journal schema is absent; FR79, FR82, FR84, and FR88 — which form a complete dependency chain downstream of FR77 — cannot be specified without it, giving this a risk score of 20/25 in the decomposition readiness analysis.

**Original text:**
```
- **FR77:** A daily cron agent can analyze that day's factory operations — token consumption patterns, context window utilization, overlay stage efficiency, prompt effectiveness (stall/retry correlation), model tier performance by agent role, phase boundary manifest waste, hook enforcement overhead, BMAD findings per story, and QA findings per story — and write a structured daily journal to `.qds/meta/daily/YYYY-MM-DD.yaml`
```

**Replacement text:**
```
- **FR77:** A daily cron agent analyzes that day's factory operations across the 9 dimensions below and writes a structured daily journal to `.qds/meta/daily/YYYY-MM-DD.yaml`. The journal schema is a **Sprint 0 prerequisite artifact** — it must be finalized before FR79, FR82, FR84, or FR88 enter active development.

  **9 Analysis Dimensions with Measurable Outputs:**

  | Dimension | Data Sources | Computation | Output Field(s) in Journal |
  |-----------|-------------|-------------|---------------------------|
  | 1. Token consumption patterns | `attribution.db` (all calls for the day) | Tokens per story, per phase, per agent role; rolling 7-day median delta | `token_consumption: { per_story: [], per_phase_avg: {}, rolling_median_delta_pct: float }` |
  | 2. Context window utilization | Overlay budget manifests (FR28b) in `pipeline.db` | Mean and p95 `budget_utilization_pct` per stage per agent role | `context_utilization: { mean_pct: float, p95_pct: float, stage_breakdown: {} }` |
  | 3. Overlay stage efficiency | Overlay budget manifests (FR28b) in `pipeline.db` | Ratio of `items_truncated` to `items_included` per stage; stages where truncation_reason is non-null | `overlay_efficiency: { truncation_rate_by_stage: {}, wasted_budget_stages: [] }` |
  | 4. Prompt effectiveness (stall/retry correlation) | Stall events from Overstory EventStore; retry counts from pipeline.db fix loop records | Stall count per story normalized by phase count; retry rate (fix loop iterations / stories) | `prompt_effectiveness: { stall_rate_per_phase: float, retry_rate: float, stall_to_retry_correlation: float }` |
  | 5. Model tier performance by agent role | `attribution.db` (model, role, token_count); hook results in `pipeline.db` | Hook pass rate per model tier per agent role; cost per successful phase by tier | `tier_performance: { by_role_and_tier: { [role]: { [tier]: { hook_pass_rate: float, cost_per_phase: float } } } }` |
  | 6. Phase boundary manifest waste | Phase Boundary Protocol manifests (FR32) | Ratio of `context_budget_consumed_tokens` to work produced (completed_artifacts count); manifests with empty open_questions vs. non-empty | `manifest_efficiency: { avg_tokens_per_artifact: float, open_question_rate: float }` |
  | 7. Hook enforcement overhead | Hook result timestamps in Overstory EventStore | Mean and p95 hook execution time per hook type; timeout bypass rate (FR94) | `hook_overhead: { mean_ms_by_hook: {}, p95_ms_by_hook: {}, timeout_bypass_rate: float }` |
  | 8. BMAD findings per story | BMAD finding records from `pipeline.db` | Finding count by severity (critical/warning/info) per story; dismissal rate | `bmad_findings: { critical_per_story: float, warning_per_story: float, dismissal_rate: float }` |
  | 9. QA findings per story | QA wave results from `pipeline.db` | Coverage gap count per story; clean-wave ratio (waves with zero findings / total waves) | `qa_findings: { coverage_gaps_per_story: float, clean_wave_ratio: float }` |

  **Daily Journal Schema (canonical — YAML):**
  ```yaml
  date: YYYY-MM-DD                  # [REQUIRED]
  stories_completed: int            # [REQUIRED]
  stories_active: int               # [REQUIRED]
  token_consumption:                # Dimension 1
    per_story: []
    per_phase_avg: {}
    rolling_median_delta_pct: float
  context_utilization:              # Dimension 2
    mean_pct: float
    p95_pct: float
    stage_breakdown: {}
  overlay_efficiency:               # Dimension 3
    truncation_rate_by_stage: {}
    wasted_budget_stages: []
  prompt_effectiveness:             # Dimension 4
    stall_rate_per_phase: float
    retry_rate: float
    stall_to_retry_correlation: float
  tier_performance:                 # Dimension 5
    by_role_and_tier: {}
  manifest_efficiency:              # Dimension 6
    avg_tokens_per_artifact: float
    open_question_rate: float
  hook_overhead:                    # Dimension 7
    mean_ms_by_hook: {}
    p95_ms_by_hook: {}
    timeout_bypass_rate: float
  bmad_findings:                    # Dimension 8
    critical_per_story: float
    warning_per_story: float
    dismissal_rate: float
  qa_findings:                      # Dimension 9
    coverage_gaps_per_story: float
    clean_wave_ratio: float
  observer_notes: string            # Free-text summary (LLM-authored, ≤500 words)
  ```
```
---

## AMENDMENT 4: SPLIT FR6 — Phase Transitions
**Type:** SPLIT_FR
**Target:** FR6 (under "Pipeline Execution" in the FR inventory table and the narrative FR list)
**Reason:** FR6 contains three independently testable capabilities — fresh agent spin-up, manifest construction/transfer, and phase transition sequencing — that belong in different epics and have independent dependency chains; shipping them as one story creates a story too large for a single sprint and obscures the sequencing dependency where (a) manifest schema must exist before (b) manifest construction, which must exist before (c) fresh agent launch.

**Original text:**
*(The FR6 narrative entry does not appear as a standalone bullet in the consolidated FR list section; it appears implicitly through the pipeline section description. However, in the FR master table it reads:)*
No standalone bullet in the consolidated FR list for FR6 (it is covered by the pipeline composition narrative). The split targets the implementation sequencing reference and any story written against it.

For the FR master table (around line 820 in the dependency graph analysis, the PRD table entry is implied). The SPLIT produces the following three sub-requirements to be inserted into the Implementation Sequencing section and the FR master table:

**Replacement text:**

*Insert the following three sub-requirements in place of any single-story treatment of FR6:*

- **FR6a (Phase Transition Sequencing):** Factory Core can determine the correct phase transition sequence for each work type — which phase completes, which phase activates next, and what pre-conditions must hold before the next phase spawns. Phase transition sequencing reads the pipeline composition record (FR5) and the current story state from `pipeline.db`. *Prerequisite: FR5 (pipeline phase assembly).*

- **FR6b (Phase Boundary Manifest Construction and Transfer):** Factory Core can instruct the departing phase agent to construct a Phase Boundary Protocol manifest conforming to the FR32 canonical schema, validate it against FR18's 6-check gate, and make it available to the receiving phase agent's overlay (Stage 5 of FR28a). *Prerequisite: FR32 manifest schema artifact (Sprint 0), FR28a, FR18.*

- **FR6c (Fresh Agent Spin-Up with Clean Context):** Factory Core can spawn a fresh agent for the receiving phase with no access to the departing phase's development context — the receiving agent's overlay is assembled from the budget manifest (FR28a) using only the transfer manifest (FR6b) and role-appropriate learnings; no development phase artifacts, tool outputs, or conversation history are carried forward. *Prerequisite: FR6b, FR21 (agent spawn), FR28a.*
---

## AMENDMENT 5: SPLIT FR14 — Hook Runner Infrastructure
**Type:** SPLIT_FR
**Target:** FR14 (under "Quality Enforcement" in the consolidated FR list)
**Reason:** FR14 as written is an architectural umbrella covering the hook runner infrastructure plus four distinct gate layers (post-edit, post-task, phase boundary, and gate result integration); treating it as a single deliverable makes the hook runner — which is a prerequisite for every other quality gate — impossible to deliver independently, and its absence blocks all of FR15–FR20.

**Original text:**
*(FR14 appears in the Resilience & Integrity narrative but the consolidated FR list does not have a standalone bullet — it is the "6-layer progressive quality gates" referenced throughout. The split targets the story boundary.)*

**Replacement text:**

*Replace any single-story treatment of FR14 with the following four sub-requirements:*

- **FR14a (Hook Runner Infrastructure):** Factory Core includes a hook runner that maintains a registry of gate scripts, executes them at defined hook points (post-edit, post-task, phase boundary), captures stdout/stderr and exit codes, and returns a structured `HookResult` to the pipeline. Hook execution is isolated (no shared state between hooks). Hook registry is populated from Superpowers enforcement metadata (FR34). *This is the infrastructure story that blocks FR14b, FR14c, FR14d, FR15, FR16, FR17, FR18, FR19, FR94, and FR152.*

- **FR14b (Layer 2 Post-Edit Gates):** Hook runner executes post-edit gate scripts on file write events: file scope violation detection (FR15) and TDD file-pair warning (FR16). These gates fire inline during agent execution, not only at task completion. *Prerequisite: FR14a.*

- **FR14c (Layer 3 Post-Task Gates):** Hook runner executes post-task gate scripts on task completion events: test runner (pass/fail + coverage delta), lint check (zero-warning standard), and type-check (zero-error standard) (FR17). Results are passed to FR130's action-level process scoring. *Prerequisite: FR14a.*

- **FR14d (Layer 4 Phase Boundary Gates):** Hook runner executes the 6-check phase boundary gate checklist (FR18) as an atomic pass/fail: tests passing, lint clean, type-check clean, scope violations absent, TDD pairs present, manifest schema valid. All 6 checks must pass; any failure blocks phase transition and escalates to the fix loop (FR7) or developer. *Prerequisite: FR14a, FR32 manifest schema artifact (Sprint 0).*
---

## AMENDMENT 6: SPLIT FR4 — Concurrent Story Execution
**Type:** SPLIT_FR
**Target:** FR4 (under "Pipeline Execution" in the consolidated FR list)
**Reason:** FR4 bundles worktree isolation mechanics (a filesystem and git concern) with the concurrency scheduler and cross-story contamination prevention (an orchestration concern); these have different dependencies, different risk profiles, and different teams are likely to own them — FR4a is a prerequisite for FR4b.

**Original text:**
*(FR4 does not appear as a standalone bullet in the consolidated narrative FR list but is referenced in the FR master table and implementation sequencing. The split targets story boundaries.)*

**Replacement text:**

*Replace any single-story treatment of FR4 with the following two sub-requirements:*

- **FR4a (Worktree Isolation Mechanics):** Each story executes within its own git worktree, created by FR40, with no shared filesystem state between concurrently running stories. Agents in one story's worktree cannot read, write, or list files in another story's worktree directory. Isolation is verified at story start by asserting that the worktree path is unique and not a subdirectory of any active worktree. *Prerequisite: FR40 (worktree lifecycle).*

- **FR4b (Concurrency Scheduler and Cross-Story Contamination Prevention):** Factory Core maintains a concurrency scheduler that tracks all active stories against the configured maximum concurrent story count (`factory.yaml: max_concurrent_stories`). When capacity is reached, new stories enter the queue (FR104). The scheduler prevents cross-story git contamination by asserting that no two active stories share a target branch. Assignment uses atomic task checkout (FR145) to prevent race conditions between co-developer factory instances. *Prerequisite: FR4a, FR145 (atomic checkout).*
---

## AMENDMENT 7: SPLIT FR48 — Event Streaming Architecture
**Type:** SPLIT_FR
**Target:** FR48 (under "Dashboard & Observability" in the consolidated FR list)
**Reason:** FR48 conflates three independently deliverable integration points — the SSE event stream from Overstory, the WebSocket command channel, and the Telegram EventStore subscription — which have separate team ownership, separate failure modes, and should be implemented in dependency order (SSE first, since WebSocket and EventStore consume the same stream).

**Original text:**
```
- **FR48:** Dashboard can stream events from Overstory via SSE and accept commands via WebSocket, and the messenger package independently consumes the same EventStore for Telegram notifications when messenger is enabled
```

**Replacement text:**
```
- **FR48a (Overstory SSE Event Stream):** Dashboard establishes a Server-Sent Events connection to Overstory and receives all factory lifecycle events (agent spawned/stopped, phase transitions, hook results, stall events, cost updates, mail dispatched). The SSE connection carries a cursor; on reconnect, missed events since the last cursor are replayed (enabling FR50 and FR97). *This is the prerequisite for FR48b, FR48c, FR43, FR44, FR45, FR46, FR47, FR49, FR50, and FR97.*

- **FR48b (WebSocket Command Channel):** Dashboard establishes a persistent WebSocket connection to Factory Core for bidirectional command dispatch (stop agent, send nudge, reorder queue, approve/reject decisions). Commands sent via WebSocket are idempotent — duplicate commands (e.g., double-tap stop) are deduplicated by story/agent ID before execution. *Prerequisite: FR48a (Factory Core must be connected and serving before accepting commands).*

- **FR48c (Telegram EventStore Subscription):** The messenger package independently subscribes to the same Overstory EventStore that the SSE stream draws from, filtering for escalation-severity events and dispatching them via Telegram (FR120–FR128). This subscription is independent of the dashboard — Telegram notifications continue when the dashboard is offline. *Prerequisite: FR48a EventStore exists; can be developed in parallel with FR48b.*
```
---

## AMENDMENT 8: Resolve FR92 — Runtime File Contention Detection
**Type:** MODIFY_FR
**Target:** FR92 (under "Resilience & Integrity")
**Reason:** FR92 is tagged "MVP if feasible, Growth if not" — an unresolved scheduling ambiguity that prevents Epic 9 sprint planning; the decomposition analysis shows the feasibility decision is answerable (real-time file-level conflict detection is infeasible without per-file lock tables, but a declaration-based approach at story-start is feasible within FR4b's concurrency scheduler), and the ambiguity must be resolved before architecture commits story points.

**Original text:**
```
- **FR92:** Factory can detect runtime file contention between concurrent stories (two stories modifying files with shared implicit state) and alert the developer via dashboard *(MVP if feasible, Growth if not — decision deferred to architecture phase; architect evaluates feasibility during system design)*
```

**Replacement text:**
```
- **FR92:** Factory can detect declared file contention between concurrent stories at story-start time and alert the developer via dashboard. *(MVP — feasibility confirmed; implementation approach: declaration-based, not runtime filesystem monitoring.)*

  **Implementation approach:** Stories declare their expected file scope in the story spec (file paths or glob patterns). At checkout time (FR145), Factory Core checks the declared scope of all active stories against the incoming story's declared scope. If overlap is detected, the developer receives a dashboard alert with the conflicting story IDs and file paths, and is offered three resolution options: (a) proceed anyway with a confirmed acknowledgment, (b) queue until the conflicting story completes, (c) cancel and revise story scope. Runtime filesystem monitoring (inotify/fsevents polling of actual file writes across worktrees) is deferred to Growth — the declaration-based approach catches the majority of real contention scenarios without per-file lock overhead.

  **Acceptance criteria:** (1) Two stories with overlapping declared file scope trigger a contention alert before either story starts execution. (2) The developer's resolution choice is logged in the story record. (3) Stories with no declared file scope overlap are not delayed by the contention check (check must complete in <100ms).
```
---

## AMENDMENT 9: Resolve FR98 — Learning Record Retention Window
**Type:** MODIFY_FR
**Target:** FR98 (under "Resilience & Integrity")
**Reason:** FR98 is tagged "MVP if feasible, Growth if not" — the decomposition analysis shows disk risk at 90 days of operation is approximately 2MB, making Growth deferral unnecessary and the ambiguous tag a sprint-planning obstacle.

**Original text:**
```
- **FR98:** Learning records have a configurable retention window; records older than the window are archived to `.qds/learnings/archive/` to prevent unbounded disk growth *(MVP if feasible, Growth if not — decision deferred to architecture phase; architect evaluates feasibility during system design)*
```

**Replacement text:**
```
- **FR98:** Learning records have a configurable retention window (default: 90 days); records older than the window are archived to `.qds/learnings/archive/YYYY-MM/` to prevent unbounded disk growth. *(MVP — feasibility confirmed; implementation is a small story estimated at ~80 LOC.)*

  **Feasibility rationale:** At the expected generation rate of approximately 20–30 learning records per day at ~1KB each, 90 days of raw records accumulates to approximately 2–3MB. Disk risk is near-zero for the first year of operation. The archive script is a simple date-filter-and-move operation with no dependency on external services.

  **Acceptance criteria:** (1) Records older than the configured window are moved to archive on a daily cron schedule (runs alongside FR77). (2) The synthesis script (FR59) ignores archived records by default but accepts a `--include-archive` flag for historical analysis. (3) Archive operation is logged with record count moved.
```
---

## AMENDMENT 10: Resolve FR100 — Meta-Optimization Cumulative Drift Tracking
**Type:** MODIFY_FR
**Target:** FR100 (under "Resilience & Integrity")
**Reason:** FR100 is tagged "MVP if feasible, Growth if not" — the decomposition analysis shows feasibility is high (~120 LOC) once FR77's journal schema is established, but the missing numeric drift threshold makes the "significant drift" trigger condition untestable; both issues must be resolved before Epic 9 sprint planning.

**Original text:**
```
- **FR100:** Meta-optimization system tracks cumulative configuration divergence from baseline; when total drift exceeds a configurable threshold, the dashboard flags "significant drift" with a full diff from original configuration and option to reset to baseline *(MVP if feasible, Growth if not — decision deferred to architecture phase; architect evaluates feasibility during system design)*
```

**Replacement text:**
```
- **FR100:** Meta-optimization system tracks cumulative configuration divergence from the factory's baseline configuration (the state at factory first-run or last explicit baseline reset). When total drift exceeds a configurable threshold, the dashboard flags "Significant Configuration Drift" with a full diff from original configuration and an option to reset to baseline. *(MVP — feasibility confirmed; implementation is estimated at ~120 LOC once FR82 lifecycle records exist.)*

  **Numeric drift threshold:** Drift is measured as the count of distinct configuration parameters that differ from baseline across all active meta-optimization changes (FR82 records with status "active"). The default threshold is **5 distinct parameter changes**. Each FR82 lifecycle record contributes its diff — if a parameter is changed and then reverted, it no longer counts toward drift. The threshold is configurable in `factory.yaml` (`meta_optimization.drift_threshold`, default: 5, minimum: 2).

  **Acceptance criteria:** (1) After 5 or more distinct configuration parameters have been modified by active meta-optimization changes (net of reverts), the dashboard displays a "Significant Configuration Drift" banner. (2) The banner includes a YAML diff showing all currently active changes vs. baseline. (3) "Reset to baseline" triggers FR101 (CLI revert) for all active changes in reverse chronological order. (4) A drift count of 4 or fewer produces no banner. (5) Reverted changes do not count toward the drift total.

  **Prerequisite:** FR82 (lifecycle records) must be implemented and populating `pipeline.db` before FR100 can compute drift.
```
---

## AMENDMENT 11: Strengthen FR149 — Turn-Based Continuation
**Type:** MODIFY_FR
**Target:** FR149 (under "Orchestration" in the session 7 FR cluster)
**Reason:** FR149 is critically underweighted in the PRD's sequencing — the dependency graph analysis identifies it as a hidden blocker whereby its absence makes every story a single-turn execution, causing constant phase boundary failures for all non-trivial stories, yet it currently has no special priority callout and sits in Sprint 8 of the recommended sequence; it must be elevated to Phase Cluster 4 (MVP Phase 1D — Pipeline Execution).

**Original text:**
```
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
```

**Replacement text:**
```
#### FR149: Turn-Based Continuation Within Phases (MVP) -- CRITICAL PATH

**SEQUENCING NOTICE:** FR149 is a **Phase 1D (Pipeline Execution) deliverable**, not a polish feature. Without FR149, every agent phase is a single-turn execution. Real stories require multiple turns to plan, implement, test, and iterate within a phase. Deferring FR149 past Sprint 4 means the factory cannot complete non-trivial stories — agents will hit max_turns=1 and trigger constant phase boundary failures. FR149 must be implemented before end-to-end story testing begins.

Agents can execute multiple turns within a single phase before triggering phase transition. After each turn, Factory Core evaluates whether the phase goal is achieved using lightweight signals:

- Post-task hook pass/fail results (from FR14c / FR17)
- Checklist item completion count (from story spec must_haves)
- File modification count versus expected scope (from FR35 Mulch file-path scoping)

These are lightweight, already-available signals — NOT the full Nyquist verifier (which is prohibitively expensive per-turn). Max turns per phase type is configurable in `factory.yaml`:

```yaml
turn_limits:
  develop: 10        # default
  bmad_review: 3     # default
  fix_loop: 5        # default (per fix iteration)
  qa_swarm: 5        # default (per QA wave)
  pr_delivery: 2     # default
```

**Progress velocity check:** If the agent made measurable progress in the last turn (at least one of: files modified, tests added, hooks passing that previously failed, checklist items completed) AND goal completion is estimated at >75% based on hook pass rates and checklist completion ratio, Factory Core extends max_turns by 1, up to a hard cap of `max_turns × 1.5` (rounded up). This prevents asymptotic approach failures where a story reaches 89% completion at max_turns and must restart with a fresh agent from turn 1.

**Turn state persistence:** Turn state is persisted to `pipeline.db` (`turn_state` table) between turns, not held in process memory. A crash mid-turn loses at most one turn of work; the next turn resumes from the last persisted state.

**Turn state schema (pipeline.db `turn_state` table):**
```sql
CREATE TABLE turn_state (
  story_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  max_turns INTEGER NOT NULL,
  max_turns_hard_cap INTEGER NOT NULL,
  hook_results_json TEXT,           -- serialized HookResult from FR14c
  checklist_items_completed INTEGER,
  checklist_items_total INTEGER,
  files_modified_count INTEGER,
  velocity_extension_applied BOOLEAN DEFAULT FALSE,
  phase_goal_estimated_pct REAL,
  turn_completed_at TEXT,           -- ISO8601
  PRIMARY KEY (story_id, phase, turn_number)
);
```

**Component integration:** Extends pipeline execution (FR1, FR5). Reads hook results from FR14c. Writes turn state to `pipeline.db`. Reads turn state on crash recovery (FR24).
**New-write:** Turn continuation loop with progress velocity check (~200 LOC), `turn_state` table schema (~30 LOC).
**Resolves:** CONS-004 (lightweight signals, not full Nyquist per-turn), FAIL-012 (progress velocity extension prevents asymptotic approach).
**Design inspiration:** Symphony `agent_runner.ex` do_run_codex_turns() loop pattern, continuation prompt template.
**Sequencing dependency:** Requires `pipeline.db` schema artifact (Sprint 0) before story can be written.
```
---

## AMENDMENT 12: New FR — Sprint 0 Pre-Code Architecture Artifacts
**Type:** NEW_FR
**Target:** Insert as a new subsection "Sprint 0 Architecture Prerequisites" immediately before the "Implementation Sequencing" section (after the "Greenfield components" paragraph, before the `### Implementation Sequencing` heading)
**Reason:** The dependency graph analysis identifies 5 cross-cutting design artifacts (pipeline.db schema, credential sanitizer spec, Phase Boundary Protocol manifest schema, Gateway API interface contract, system health reporting interfaces) that must exist before dependent FRs can be correctly implemented; none of these is captured as an FR, yet each unblocks between 4 and 11 downstream FRs.

**Original text:**
```
### Implementation Sequencing

The source project dependencies and hook co-dependency define a natural implementation sequence:
```

**Replacement text:**
```
### Sprint 0 Architecture Prerequisites

Before any code story is written against the FRs below, five design artifacts must be produced and approved as Architecture Decision Records (ADRs). These are not code stories — they are specification documents. They do not require implementation, only authorship and team sign-off. Their absence will cause mid-sprint conflicts, schema rework, and broken integration points.

| Artifact | ADR Name | Unblocks FRs | Responsible |
|----------|----------|-------------|-------------|
| **`pipeline.db` full schema** — all tables (`action_scores`, `session_composites`, `task_checkout_locks`, `turn_state`, `epic_context`, `pattern_knowledge`, `maintenance_learnings`, `maintenance_burden`, `elo_ratings`, `elo_epochs`), indexes, migration system, and foreign key constraints | ADR-01: pipeline.db Schema | FR130, FR131, FR132, FR145, FR149, FR165, FR166, FR167, FR168 | Developer A |
| **Credential sanitizer specification** — the sanitizer utility that strips API keys, tokens, and secrets from all factory output paths (agent stdout/stderr, Overstory logs, learning records, PR evidence body, dashboard renders, meta-optimization journals, Telegram messages); specification defines: regex patterns, replacement tokens, output path coverage contract | ADR-02: Credential Sanitizer Spec | FR44, FR52, FR55, FR77, FR103, FR120 (none of these output-path FRs may be marked Done without sanitizer integration) | Developer B |
| **Phase Boundary Protocol manifest schema** — canonical YAML schema with all required/optional fields, validation rules, serialization format, handoff protocol (defined in FR32 Amendment 1 above) | ADR-03: Phase Boundary Protocol Manifest Schema (= FR32 amendment) | FR32, FR18, FR45, FR20, FR131, FR58 | Developer A |
| **Gateway API interface contract** — the request-response query interface that translates dashboard and external data queries into `pipeline.db` reads; must define: endpoint naming conventions, response envelope schema, pagination protocol, authentication (developer ID header), error contract | ADR-04: Gateway API Interface Contract | FR139, FR146, FR89 (meta-optimization history timeline), FR43–FR46 (historical data queries) | Developer B |
| **System health reporting interfaces** — the cross-cutting contract that every subsystem must implement to expose health signals to FR170's circuit breaker; must define: `HealthSignal { subsystem: string, status: "healthy" \| "degraded" \| "failed", error_count_60s: int, last_checked_at: ISO8601 }` and the registration protocol for new subsystems | ADR-05: System Health Reporting Interfaces | FR170 (circuit breaker), FR73 (resource monitoring), FR14 (hook runner), FR28 (overlay pipeline), FR36 (Pi SDK), FR37 (token tracking) | Developer A |

**Completion criterion for Sprint 0:** All 5 ADRs are written, reviewed by both developers, and committed to `_bmad-output/architecture/` before any Sprint 1 story is marked In Progress.

### Implementation Sequencing

The source project dependencies and hook co-dependency define a natural implementation sequence:
```
---

## AMENDMENT 13: Update Implementation Sequencing — 22-Hop Critical Path and 9 Hidden Blockers
**Type:** MODIFY_SECTION
**Target:** The `### Implementation Sequencing` code block and the three paragraphs immediately following it (the "Implementation Considerations" subsection)
**Reason:** The current sequencing section identifies the correct macro-level ordering (5 sequential items + 3 parallel tracks) but misses the 22-hop critical path depth, omits all 9 hidden blockers, and does not reflect the sprint-level sequencing needed for a 2-developer team to avoid mid-sprint integration stalls.

**Original text:**
```
### Implementation Sequencing

The source project dependencies and hook co-dependency define a natural implementation sequence:

```
Sequential (dependency chain):
  1. Pi SDK integration (runtime — everything runs on this)
  2. Overstory extensions (agent lifecycle — everything uses this)
  3. Hook infrastructure (enforcement runner — gates need this)
  4. Phase Boundary Protocol + hook integration (novel piece, co-dependent with hooks)
  5. Superpowers consumption (overlay injection + extended frontmatter for hooks)

Parallelizable (after item 2):
  6a. ZeroClaw dashboard fork (UI shell + factory pages) — can develop alongside 3-5
  6b. claude-mem → Mulch extensions (memory layer) — can develop alongside 6a
  6c. Factory Learning System (loops 1-3, synthesis script) — can develop alongside 6a-6b

With 2 developers:
  Developer A: items 1 → 2 → 3 → 4 → 5 (critical path)
  Developer B: items 6a (dashboard) → 6b (Mulch) → 6c (learning system) — parallel track
  Integration: merge tracks after item 5, integrate dashboard with hook enforcement and phase boundary visualization
```

### Implementation Considerations

**Hook infrastructure is a prerequisite story.** It blocks Phase Boundary Protocol, Superpowers hook enforcement, and all mechanical validation. It must be implemented before the first story runs through the factory. Without hooks, the first factory-generated PR ships with no mechanical validation — only agent self-policing and BMAD review.

**Phase Boundary Protocol is the highest design risk.** It's greenfield, novel, and the densest enforcement checkpoint (tests, build, lint, type check, manifest validation all fire here). It also carries context isolation (the core guarantee of adversarial review) and learning transfer (Loop 2). Getting this wrong undermines the adversarial quality pipeline and the learning system. Prototype and validate early.

**ZeroClaw fork is lowest-risk scaffolding, moderate-effort feature work.** The React 19 + TS + Vite + Tailwind shell transfers directly. Existing pages (Dashboard, Cron, Config, Logs) inform factory page design. New pages (Agent Windows, Story Pipeline, Factory Overview, phase gate checklist, Learning tab) are additive but substantial — each is a real feature, not a trivial adaptation.

**`gh` CLI is a hard dependency.** The setup script must verify `gh` is installed, authenticated (`gh auth status`), and has repo scope. Without `gh`, the factory can develop and review but cannot ship PRs — the endpoint of the entire pipeline. Growth: `gh` API usage tracking for rate limit awareness during large epics.
```

**Replacement text:**
```
### Implementation Sequencing

The critical path from runtime substrate to first shippable PR is **22 sequential dependency hops**. This is not a 5-item list — it is a chain of 22 prerequisite FRs that cannot be parallelized on Developer A's track. Any slip in this chain delays the MVP end-to-end story milestone by at least the time it takes to repair the slipped item plus re-test all downstream integrations.

**Critical Path (22-hop sequential chain — Developer A):**
```
[Sprint 0]  ADR-01: pipeline.db schema
            ADR-03: Phase Boundary Protocol manifest schema (= FR32 amended)
            ADR-05: System health reporting interfaces

[Sprint 1]  FR36 (Pi SDK) → FR21 (Overstory agent lifecycle) → FR23 (mail system)
            → FR42 (attribution chain) → FR40 (worktree lifecycle)

[Sprint 2]  FR14a (hook runner infrastructure) → FR34 (Superpowers enforcement metadata)
            → FR15/FR16 (post-edit hooks) → FR17 (post-task hooks) → FR18 (phase boundary hooks)

[Sprint 2B] FR28a (overlay composition pipeline) → FR33 (Superpowers injection)
            → FR35 (Mulch scoping) → FR30/FR155 (context budget validation)

[Sprint 3]  FR32 (Phase Boundary Protocol manifests) → FR6b (manifest construction/transfer)
            → FR6c (fresh agent spin-up with clean context)

[Sprint 4]  FR91 (story spec validation) → FR1 (story intake) → FR5 (pipeline phase assembly)
            → FR145 (atomic task checkout) → FR4a/FR4b (parallel execution)
            → FR149 (turn-based continuation) ← CRITICAL: must ship in Sprint 4, not Sprint 8

[Sprint 5]  FR10 (BMAD adversarial review) → FR11 (finding categorization)
            → FR7 (fix loop) → FR152 (structural verification) → FR163 (disagreement protocol)
            → FR12 (QA swarm) → FR13 (economy-tier scouts)

[Sprint 6]  FR51 (git safety) → FR52 (PR creation with runtime gh auth check)
            → FR8 (PR evidence body)

[MVP CHECKPOINT: end-to-end story flow complete]
```

**Parallelizable Tracks (Developer B starts Sprint 1 simultaneously):**

- **Track B — Dashboard:** FR48a (SSE event stream skeleton) → FR43 (Factory Overview) → FR69/FR70 (setup + config) → FR44 (Agent Windows, after credential sanitizer) → FR45 (story pipeline visualization, after FR32 schema finalized) → FR48b (WebSocket commands) → FR25/FR26/FR27 (stop/nudge/inspect) → FR47 (stall detection) → FR97/FR50 (reconnect + crash resilience)

- **Track C — Memory & Learning:** FR55 (learning record writes) → FR56 (outcome tags) → FR57 (learning_report mail, requires FR23 schema extension) → FR58 (manifest learnings section) → FR59 (synthesis script) → FR60/FR61 (conflict detection + injection) → FR164/FR165/FR166/FR167/FR168 (self-learning system)

- **Track D — Performance Data:** FR130 (action scoring) → FR131 (confidence calibration) → FR132 (composite scores) → FR140 (export). *Starts after FR17 + FR32 are stable.*

- **Track E — Notifications:** FR171 (notification abstraction) → FR120 (Telegram bot) → FR127/FR121/FR123/FR124/FR125/FR126/FR128. *Starts after FR48a is stable.*

- **Track F — Meta-Optimization:** FR77 → FR78 → FR79 → FR80–FR89. *Starts after MVP stories are flowing (Sprint 7+). FR77 ADR must be complete before Sprint 10.*

**9 Hidden Blockers Not in the Original Sequencing:**

These micro-level dependencies will stall implementation mid-sprint if not addressed at sprint planning:

1. **`pipeline.db` schema must be a Sprint 0 artifact** — 9 MVP FRs write to pipeline.db tables; without a consolidated schema spec, each FR will produce conflicting table designs requiring mid-sprint migrations. (Unblocks: FR130, FR131, FR132, FR145, FR149, FR165, FR166, FR167, FR168.)

2. **Credential sanitizer must exist before any output-path FR is marked Done** — sanitizer is referenced in NFR10/NFR33 but has no FR number; it must be implemented and integrated before FR44, FR52, FR55, FR77, FR103, FR120 are complete. (ADR-02; Sprint 0 spec, Sprint 2 implementation.)

3. **`gh` CLI auth must be re-validated at runtime, not only at setup** — FR52 (PR creation) must include a pre-condition `gh auth status` check before each PR attempt; the setup script check (FR69) will expire in production and fail silently.

4. **FR32 manifest schema must be finalized before FR45 and FR20 enter development** — the dashboard's phase gate checklist (FR20) and story pipeline visualization (FR45) render manifest data; building them against a provisional schema that changes when FR32 is refined requires full component rewrites.

5. **Overstory mail schema must be extended for `learning_report` before Loop 1 works** — FR57 adds a new typed mail message to Overstory's SQLite-backed mail system; this is a coordinated schema change to the Overstory layer, not a pure Track C concern. Sequence: FR23 stable → mail schema extension → FR57.

6. **Mulch file schema (FR64) must precede FR95 and FR35** — FR95 (Mulch content integrity check) and FR35 (Mulch file-path scoping) both assume a typed Mulch file schema exists; if FR35 ships before FR64 defines the schema, integrity checks cannot be written. Ordering: FR64 → FR95 → FR35.

7. **FR149 (turn continuation) is Phase 1D, not Sprint 8** — without turn continuation, every agent phase is single-turn; the factory cannot complete non-trivial stories. It must ship in Sprint 4 alongside story intake and pipeline assembly.

8. **Gateway API is an architectural assumption without an FR** — multiple FRs reference "reads from pipeline.db via Gateway API" (FR139, FR146, FR89) but the Gateway API component has no FR number. ADR-04 (Sprint 0) defines the interface; implementation story must be added to Epic 1 (Infrastructure Foundation) before FR139, FR146, or FR89 can be implemented.

9. **System health reporting interfaces must be defined before any subsystem FR is marked complete** — FR170's circuit breaker activates when 3+ subsystems report errors in 60 seconds; if subsystems are built without the health reporting interface contract, FR170 must be retrofitted into all completed FRs. ADR-05 (Sprint 0) defines the contract; every subsystem FR (FR14, FR28, FR36, FR37, FR73) must implement it before marking Done.

### Implementation Considerations

**Hook runner infrastructure (FR14a) is a prerequisite story for all quality enforcement.** It blocks Phase Boundary Protocol, Superpowers hook enforcement, and all mechanical validation. It must be implemented before the first story runs through the factory. Without hooks, the first factory-generated PR ships with no mechanical validation — only agent self-policing and BMAD review.

**Phase Boundary Protocol is the highest design risk.** It is greenfield, novel, and the densest enforcement checkpoint (tests, build, lint, type check, manifest validation all fire here). It also carries context isolation (the core guarantee of adversarial review) and learning transfer (Loop 2). Getting this wrong undermines the adversarial quality pipeline and the learning system. Prototype and validate early — the FR32 manifest schema ADR (Sprint 0) and a single end-to-end story prototype (Sprint 3) are the two validation gates.

**ZeroClaw fork is lowest-risk scaffolding, moderate-effort feature work.** The React 19 + TS + Vite + Tailwind shell transfers directly. Existing pages (Dashboard, Cron, Config, Logs) inform factory page design. New pages (Agent Windows, Story Pipeline, Factory Overview, phase gate checklist, Learning tab) are additive but substantial — each is a real feature, not a trivial adaptation. **Note:** FR45 (Story Pipeline Visualization) and FR20 (Phase Gate Checklist) must not begin rendering manifest fields until FR32's schema ADR is approved — building against the pre-ADR narrative description will produce rework.

**`gh` CLI is a hard dependency with a runtime enforcement gap.** The setup script (FR69) verifies `gh auth status` at install time, but auth tokens expire in production. FR52 must include a runtime `gh auth status` pre-condition check before each PR attempt — not delegated entirely to the setup script. Without this, the factory fails silently on PR creation when auth has expired.
```
---

## AMENDMENT 14: New FR — Seeds Deduplication and Claim-Locking
**Type:** NEW_FR
**Target:** Insert as **FR145b** immediately after FR145 in the "Economic Governance" section (FR145 is in the Agent Performance Data Collection area of the session 7 FR cluster). Also add a bullet to the consolidated FR list under "Git & PR Operations" or a new sub-item under FR145.
**Reason:** The dependency graph analysis (Journey 3, Hidden Blocker analysis) identifies a near-certain MVP scenario where two developers running concurrent factory instances submit overlapping stories — both instances will attempt to claim the same Seeds task, producing duplicate work and corrupted story records; this requirement is revealed by the co-developer workflow but absent from all FRs.

**Original text (FR145 block ending):**
```
**Component integration:** Reads from and writes to `pipeline.db`. Integrates with story intake (FR1).
**New-write:** Checkout lock manager with timeout and release logic (~100 LOC), `pipeline.db` schema extension (~20 LOC).
**Resolves:** FAIL-001 (atomic checkout prevents the double-work race condition identified in the concurrency analysis).
**Design inspiration:** PostgreSQL advisory lock pattern adapted for SQLite.
```

**Replacement text:**
```
**Component integration:** Reads from and writes to `pipeline.db`. Integrates with story intake (FR1).
**New-write:** Checkout lock manager with timeout and release logic (~100 LOC), `pipeline.db` schema extension (~20 LOC).
**Resolves:** FAIL-001 (atomic checkout prevents the double-work race condition identified in the concurrency analysis).
**Design inspiration:** PostgreSQL advisory lock pattern adapted for SQLite.

#### FR145b: Seeds Task Deduplication and Cross-Developer Claim-Locking (MVP)

When two developers run concurrent factory instances, both instances may attempt to claim the same Seeds task for story execution — a near-certain scenario during co-developer setup (Journey 3) and any multi-developer sprint. FR145 (atomic checkout) prevents within-instance double-assignment via `pipeline.db`. FR145b prevents cross-instance double-assignment via Seeds.

**Claim-locking protocol:** When a factory instance claims a Seeds task for story execution, it:
1. Writes a claim record to the Seeds task with: `claimed_by: <developer_id>`, `claimed_at: <ISO8601>`, `factory_instance_id: <uuid from factory.yaml>`.
2. Reads back the claim record and verifies that `claimed_by` matches its own developer_id (optimistic lock check).
3. If another developer's claim is found (race condition), the story is placed in the queue (FR104) and the developer receives a dashboard notification: "Seeds task [task_id] already claimed by [developer_id] — queued for next available unclaimed task."

**Deduplication on story completion:** When a factory instance completes a story and creates a PR (FR52), it marks the originating Seeds task as `completed_by: <developer_id>` and `pr_url: <url>`. If the other developer's instance later attempts to claim the same task (e.g., due to a sync delay), the intake validation (FR91) detects the `completed_by` field and rejects the story with a clear error: "Seeds task [task_id] already completed by [developer_id] — PR: [url]."

**Claim-lock expiry:** Claims that are not followed by a story completion or explicit release within a configurable window (default: `factory.yaml: seeds_claim_timeout: 4h`) are automatically released and the task becomes available for re-claim. This prevents a crashed factory instance from permanently locking a task.

**Component integration:** Extends story intake (FR1) and atomic task checkout (FR145). Reads/writes Seeds task records via Seeds API (Overstory component). Integrates with dashboard notification (FR48b) for claim conflict alerts.
**New-write:** Seeds claim-lock manager with optimistic lock check and expiry (~150 LOC).
**Sequencing:** FR145b must be implemented before end-to-end co-developer testing begins (Sprint 4 at latest). The single-developer path works without it; the two-developer path (Journey 3) does not.
```
---

## Amendment Application Checklist

Apply amendments in this order to avoid forward references:

- [ ] **Amendment 12** (Sprint 0 Prerequisites section) — insert before Implementation Sequencing
- [ ] **Amendment 13** (Implementation Sequencing section) — replace existing section
- [ ] **Amendment 1** (FR32 manifest schema) — replace FR32 bullet
- [ ] **Amendment 2** (FR28 interface contract) — replace FR28 bullet
- [ ] **Amendment 3** (FR77 analysis dimensions + journal schema) — replace FR77 bullet
- [ ] **Amendment 4** (FR6 → FR6a/FR6b/FR6c split) — replace FR6 references in sequencing and table
- [ ] **Amendment 5** (FR14 → FR14a/FR14b/FR14c/FR14d split) — replace FR14 references
- [ ] **Amendment 6** (FR4 → FR4a/FR4b split) — replace FR4 references
- [ ] **Amendment 7** (FR48 → FR48a/FR48b/FR48c split) — replace FR48 bullet
- [ ] **Amendment 8** (FR92 feasibility resolved) — replace FR92 bullet
- [ ] **Amendment 9** (FR98 feasibility resolved) — replace FR98 bullet
- [ ] **Amendment 10** (FR100 feasibility resolved + numeric threshold) — replace FR100 bullet
- [ ] **Amendment 11** (FR149 strengthened + critical path elevation) — replace FR149 block
- [ ] **Amendment 14** (FR145b Seeds claim-locking) — insert after FR145 block

---

*End of PRD Amendment Batch — FR Infrastructure & Decomposition Readiness*
*Produced: 2026-03-14 | Source: prd-analysis-fr-dependency-graph-2026-03-14.md + prd-analysis-epic-decomposition-readiness-2026-03-14.md*
