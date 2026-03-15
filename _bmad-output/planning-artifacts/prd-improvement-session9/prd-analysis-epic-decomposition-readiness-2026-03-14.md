# Epic Decomposition Readiness Review
## QDS Engineer v2 — PRD v2.0 Analysis

**Prepared by:** Claude Sonnet 4.6 (Agent Analysis)
**Date:** 2026-03-14
**PRD Source:** `_bmad-output/planning-artifacts/prd-v2.md`
**Scope:** 145 MVP Functional Requirements (FR1–FR129 original set + FR130–FR132, FR140, FR142, FR145, FR149, FR152, FR155, FR163–FR168, FR170–FR171)

---

## Executive Summary

The PRD is architecturally mature and internally consistent. The 145 MVP FRs are organized across 19 capability areas with a clearly articulated component relationship model. The level of specification varies considerably across these areas: FR130–FR171 (the Session 7 addition block) are the best-specified FRs in the entire document — they carry LOC estimates, integration points, resolved finding references, and design-inspiration callouts. The original FR1–FR129 block ranges from well-specified (the Dashboard Copilot cluster) to critically underspecified (several FRs in Meta-Optimization, Overlay & Context Management, and Resilience & Integrity).

**Key findings:**

- **Three FRs are decomposition-blocking ambiguous** (FR28, FR32, FR77) and must be resolved before architecture can produce unambiguous stories.
- **Eight FRs require splitting** before story writing; each currently contains 2–4 independently deliverable capabilities.
- **Fourteen FRs have underspecified acceptance criteria** that make it impossible to write a testable Done condition.
- **The proposed 9-epic grouping** provides a decomposable structure from which ~105–130 stories can be estimated.
- **Three FRs have deferred feasibility decisions** (`FR92`, `FR98`, `FR100`) explicitly tagged "MVP if feasible, Growth if not" — these are scheduling unknowns that should be resolved in the architecture phase before sprint planning.

---

## 1. Full MVP FR Inventory with Decomposition Readiness

### Legend

| Rating | Meaning |
|--------|---------|
| READY | Specifiable as 1–3 stories without further clarification |
| SPLIT | FR contains multiple independently deliverable capabilities; must be split before story writing |
| CLARIFY | Acceptance criteria are underspecified; architect must resolve before writing stories |
| BLOCKING | So broad or ambiguous that story conflicts are likely; must be resolved before architecture proceeds |
| DEFERRED | Feasibility explicitly deferred to architecture phase (PRD-acknowledged) |

---

### 1.1 Pipeline Execution (FR1–FR9)

| FR | Title | Readiness | Notes |
|----|-------|-----------|-------|
| FR1 | Story submission + intake | READY | One story: intake form + validation pipeline trigger |
| FR2 | Multi-story epic decomposition + dependency detection | SPLIT | Dependency detection and epic decomposition are independently deliverable; FR2 + FR3 should be one story but the detection algorithm needs AC about false-positive rate and detection heuristics |
| FR3 | Manual dependency override | READY | Small story, clear AC: UI control + override logged |
| FR4 | Concurrent stories with isolated worktrees | SPLIT | Two capabilities: (a) worktree isolation mechanics, (b) concurrency scheduler and cross-story contamination prevention. These interact with FR40 and should be co-designed |
| FR5 | Pipeline composition engine (work type declarations) | CLARIFY | "Assembles correct pipeline phases for each work type" — AC missing: what constitutes correct assembly? What fails if wrong work type is selected? How is work type stored? |
| FR6 | Phase transitions with fresh agents + manifest transfer | SPLIT | Three independently testable capabilities: (a) fresh agent spin-up with clean context, (b) manifest construction + transfer, (c) phase transition sequencing. All three appear in different epics in the dependency chain |
| FR7 | Fix loop with circuit breaker | READY | Well-specified: configurable max iteration count, escalation behavior; one story |
| FR8 | PR creation with structured evidence body | SPLIT | PR creation mechanics vs. evidence body template are independently testable. Evidence body depends on FR10/FR11/FR12 outputs. Should be two stories: (a) PR creation + branch, (b) evidence body assembly |
| FR9 | Task work type (minimal pipeline) | READY | Variant of Story work type; single story after pipeline engine exists |

### 1.2 Quality Enforcement (FR10–FR20)

| FR | Title | Readiness | Notes |
|----|-------|-----------|-------|
| FR10 | BMAD adversarial review with context-isolated agents | CLARIFY | "No access to development phase context" — what technical mechanism enforces this? The FR says context-isolated but does not specify whether it is enforced by process boundary, by overlay construction policy, or by manifest-only transfer. Architecture needs to resolve before stories can be written |
| FR11 | BMAD finding categorization (critical/warning/info) | READY | Clear output format; depends on FR10 existing |
| FR12 | Multi-wave QA swarm with configurable wave count + stopping threshold | READY | Well-specified; "N consecutive clean waves" is testable |
| FR13 | QA swarm scouts on economy-tier via Pi SDK routing | READY | Small story; depends on FR36 existing |
| FR14 | 6-layer progressive quality gates | SPLIT | This is an architectural umbrella over FR15–FR20. As written it is not a single story — it describes the complete hook system. Should be decomposed into: (a) hook runner infrastructure, (b) individual gate implementations (FR15–FR18 each), (c) gate result integration |
| FR15 | Post-edit hooks — file scope violation | READY | Binary gate; small story |
| FR16 | Post-edit hooks — TDD file-pair warning | READY | Warning path; small story |
| FR17 | Post-task hooks — test/lint/type check | READY | Three checks bundled; testable as a unit but implementation may warrant splitting into separate gate runner stories |
| FR18 | Phase boundary hooks — gate checklist | CLARIFY | Lists 6 gate items but does not specify the failure remediation path: when a phase boundary hook fails, who owns the fix loop? Is it the same fix loop as FR7, a different one, or purely developer-escalated? |
| FR19 | Hook results inline in agent output stream | READY | Presentation concern; small story after hook runner exists |
| FR20 | Phase boundary gate checklist in dashboard | READY | Dashboard concern; depends on FR18 and FR45 |

### 1.3 Agent Orchestration (FR21–FR27)

| FR | Title | Readiness | Notes |
|----|-------|-----------|-------|
| FR21 | Spawn/monitor/stop/replace agents via Overstory | SPLIT | "Spawn, monitor, stop, and replace" are four independently testable operations. Should be sequenced: (a) spawn + monitor, (b) stop + replace. Both reference Overstory as an existing component; the story boundary is the Factory Core → Overstory integration point |
| FR22 | Auto-recovery from agent crash + Telegram notification | SPLIT | Crash detection, replacement spawning, and Telegram dispatch are independently testable. The Telegram dispatch dependency means this touches two epics (Orchestration + Developer Communication). Story split: (a) crash detection + replacement, (b) Telegram dispatch on recovery events |
| FR23 | Mail system with `learning_report` type | CLARIFY | FR23 adds `learning_report` to Overstory's existing mail system. Acceptance criteria needed: what is the schema for `learning_report`? Who sends it, who receives it, and what does the receiver do with it? This connects to FR57 which has more detail |
| FR24 | Checkpoint/resume long-running stories | CLARIFY | "Without data loss" — what constitutes a checkpoint? At what granularity (per-turn, per-task, per-phase)? What is the recovery protocol when a checkpoint is partially written? |
| FR25 | Developer stops agent from dashboard | READY | Clear control; small story |
| FR26 | Developer nudges agent via mail + content logged | READY | Well-specified including traceability requirement |
| FR27 | Developer inspects agent live output | READY | xterm.js integration; clear capability |

### 1.4 Overlay & Context Management (FR28–FR35)

| FR | Title | Readiness | Notes |
|----|-------|-----------|-------|
| FR28 | Overlay composition pipeline (6 ordered stages, hard token ceiling) | **BLOCKING** | This is the highest-complexity internal module per the PRD itself. As written, FR28 is a complete subsystem description (6 ordered stages, per-stage budgets, priority ranking, truncation logic, budget manifest output). It cannot be implemented as a single story. The PRD architecture section (p.5) provides more detail than the FR body itself. Requires decomposition into at minimum 4 stories before architecture can proceed |
| FR29 | Per-stage priority ranking and truncation | READY | Implementation detail of FR28; should be co-located in the overlay epic but is independently testable |
| FR30 | Context budget validation before agent launch | READY | Guard clause; clearly specified — total overlay + task estimate vs. model effective context limit |
| FR31 | Task scope split or tier escalation on budget failure | CLARIFY | Two branches: split scope vs. escalate tier. What determines which branch is taken? What is the AC for "split the task scope"? How small can a scope be split before it becomes unworkable? |
| FR32 | Phase Boundary Protocol — structured manifests with required sections | **BLOCKING** | "Required sections" are referenced but not enumerated in the FR body. The PRD narrative (Journey 5) reveals sections include: summary, struggles, discoveries, decisions, file-scope conventions, learnings, and confidence declarations. But no canonical schema exists in the FR. Architecture cannot write stories about building manifest validation (FR18) without a canonical manifest schema. This is the highest design-risk greenfield component per the PRD's own risk assessment |
| FR33 | Superpowers skills injected into agent overlays | READY | Reads existing skills from Superpowers; injects as-is |
| FR34 | Superpowers `enforcement` metadata consumed by hook scripts | CLARIFY | "Extended YAML frontmatter" — does the factory write this extension, or does it come with Superpowers? If the factory writes it, which team member owns that work? If it comes with Superpowers, is the source project integration already done? |
| FR35 | Mulch expertise scoped to agent file path | READY | Path-scoping filter on Mulch files; clearly specifiable |

### 1.5 Resource & Economic Management (FR36–FR42)

| FR | Title | Readiness | Notes |
|----|-------|-----------|-------|
| FR36 | Model tier directives via Pi SDK | READY | Policy table: role → tier → Pi SDK directive. Well-specified |
| FR37 | Token spend tracking per story with phase-level visibility | READY | Attribution chain already defines the data model (FR42); this is the aggregation + display layer |
| FR38 | Per-story cost circuit breaker + Telegram notification | READY | Clear threshold enforcement; notification dependency |
| FR39 | Daily global budget ceiling + Telegram notification | READY | Parallel to FR38 at global scope |
| FR40 | Worktree lifecycle (create + cleanup) | READY | Well-specified including failure/cancellation/circuit-break cleanup paths |
| FR41 | Orphaned worktree detection and cleanup on startup | READY | Startup scan; clearly bounded |
| FR42 | Full attribution chain on every model API call | CLARIFY | The attribution chain schema is well-defined (7 fields). The ambiguity is in enforcement: "API calls without a complete attribution chain are blocked" (FR96 repeats this) — but who enforces this? Is it Pi SDK, Factory Core middleware, or both? The stories for FR42 vs FR96 will collide if this is not resolved |

### 1.6 Dashboard & Observability (FR43–FR50)

| FR | Title | Readiness | Notes |
|----|-------|-----------|-------|
| FR43 | Factory Overview panel | READY | Well-described in journey narratives; clear fields |
| FR44 | Agent Windows with xterm.js panels + token ticker | READY | xterm.js integration story; clearly scoped |
| FR45 | Story pipeline phase progression + transition visualization | READY | Phase state machine display; depends on FR6 and FR20 |
| FR46 | Cost tracking with model tier breakdown | READY | Dashboard display; depends on FR37 and FR42 |
| FR47 | Stall detection with type classification + diagnostic + Telegram | SPLIT | Stall detection algorithm, type classification logic (logic loop / external wait / resource constraint), diagnostic summary generation, and Telegram dispatch are independently testable. The classification algorithm needs AC: how are the three stall types distinguished algorithmically? |
| FR48 | Dashboard SSE + WebSocket + Telegram EventStore consumption | SPLIT | SSE event stream, WebSocket command channel, and Telegram EventStore subscription are three independently deliverable integration points. The FR conflates them. Split: (a) SSE from Overstory, (b) WebSocket command channel, (c) Telegram messenger consuming EventStore independently |
| FR49 | Budget projection per story (multi-phase remaining) | READY | Calculation model described in Journey 1; depends on FR37 |
| FR50 | Dashboard crash isolation — agents continue, reconnect with state recovery | CLARIFY | "Full state recovery on restart" — what is the state recovery protocol? Does the dashboard replay SSE events from a cursor? Or does Overstory serve a current-state snapshot? The recovery mechanism must match NFR19 (5-second reconnect, zero state loss), but the mechanism is not specified in the FR |

### 1.7 Git & PR Operations (FR51–FR54, FR90)

| FR | Title | Readiness | Notes |
|----|-------|-----------|-------|
| FR51 | Git safety iron laws enforcement | READY | 6 named rules; well-specified; testable |
| FR52 | PR creation via `gh` CLI + structured evidence body | SPLIT | Should be two stories: (a) PR creation mechanics + branch push, (b) evidence body template assembly. The evidence body depends on BMAD/QA/hook results from multiple other FR areas |
| FR53 | Coverage gap indicator ("Not Tested" section) in PR | CLARIFY | "Files modified but outside QA wave scope" — what determines QA wave scope? Is scope defined in the story spec? Derived from file-scope assignments? This calculation needs specification before the story can be written |
| FR54 | CI pipeline observation via `gh pr checks` | READY | Read-only observe; small story |
| FR90 | PR comment → Seeds issue auto-creation | CLARIFY | "Filtering out bot, CI, and automation comments" — what is the bot/automation detection heuristic? A false positive (creating Seeds issues from CI bot comments) would pollute the task graph. The filter logic needs AC |

### 1.8 Factory Learning System (FR55–FR63)

| FR | Title | Readiness | Notes |
|----|-------|-----------|-------|
| FR55 | Agents write structured learning records with atomic writes | READY | YAML schema, crash-safe write pattern, well-specified |
| FR56 | Story outcome tags on learning records | READY | Dependent on story completion event; clear update mechanism |
| FR57 | `learning_report` mail (Loop 1 — session-level tactical) | CLARIFY | FR57 specifies the purpose but not the schema. What fields does a `learning_report` mail carry? The story for FR57 and the story for FR23 (`learning_report` mail type) will conflict without a canonical schema |
| FR58 | `learnings` section in Phase Boundary Protocol manifests (Loop 2) | CLARIFY | This is co-dependent with FR32. If FR32's manifest schema is not resolved, FR58 cannot be specified. Should be one AC item in the FR32 manifest schema story |
| FR59 | Manual synthesis script | READY | Well-specified: grouping by file scope, deduplication, outcome weighting, Superpowers gate validation, conflict flagging |
| FR60 | Synthesis rejects learnings conflicting with Superpowers iron laws | READY | Single validation step in the synthesis pipeline; testable |
| FR61 | Overlay injection — synthesized learnings with hard token ceiling + tiered injection | READY | Token ceiling (500/1000), tier priority, file-scope + role matching — well-specified |
| FR62 | Spike/exploratory stories suppress learning injection | READY | Simple flag; small story |
| FR63 | Learning retraction with cascading retraction to source records | READY | Retraction mechanism clearly described in Journey 5 |

### 1.9 Memory & Knowledge (FR64–FR68)

| FR | Title | Readiness | Notes |
|----|-------|-----------|-------|
| FR64 | Mulch timestamps + story provenance + content deduplication | SPLIT | Three independently testable enhancements to Mulch. "Content deduplication for parallel agent writes" is the only one that needs architecture attention — the mechanism needs specification |
| FR65 | Seeds as factory-wide universal task graph | CLARIFY | "All factory work items across developers" — Seeds is described as an existing component (inside Overstory). What is the new functionality? Does this FR describe Seeds integration (Factory Core creates Seeds tasks per FR32 manifests)? Or Seeds UI? The boundary between FR65 and the use of Seeds in FR90 and the developer operations FRs is unclear |
| FR66 | `.mulch/` shared via git with append-only format | READY | Git-sharing constraint; append-only format is defined |
| FR67 | `.qds/learnings/` raw records shared via git with per-agent filenames | READY | Filename collision prevention is the key AC |
| FR68 | Synthesized learnings remain local (`.gitignore`d) | READY | One-line `.gitignore` entry; verified in setup |

### 1.10 Developer Operations & Setup (FR69–FR72)

| FR | Title | Readiness | Notes |
|----|-------|-----------|-------|
| FR69 | Setup script with dependency verification + version alignment + pre-flight | SPLIT | Three independently deliverable checks: (a) dependency verification (Bun, Rust, `gh`), (b) source project version alignment, (c) resource pre-flight (RAM/CPU/disk). Can be developed as one story if scoped tightly |
| FR70 | Per-developer `config/factory.yaml` configuration | READY | Well-specified fields; config schema should be documented |
| FR71 | Independent dashboard instances per developer | READY | Process isolation; depends on dashboard existing |
| FR72 | PR attribution to generating factory instance | READY | Attribution field in PR template; small story |

### 1.11 Operational Safety (FR73–FR76)

| FR | Title | Readiness | Notes |
|----|-------|-----------|-------|
| FR73 | Resource monitoring (disk/memory/token) with thresholds + hard limits + Telegram | SPLIT | Three resource types (disk, memory, token) monitored independently, with warning and hard-limit tiers, plus Telegram dispatch. Disk and memory monitoring are infrastructure concerns. Token monitoring overlaps with FR37–FR39. Should be decomposed: (a) disk/memory monitoring infrastructure, (b) threshold + hard-limit actions, (c) Telegram dispatch integration |
| FR74 | Single-story failure isolation + Telegram | READY | Failure scoping is a property of the orchestration model; testable |
| FR75 | API provider down — graceful stall + auto-resume + Telegram | CLARIFY | "Auto-resume when the provider returns" — what is the mechanism? Does Pi SDK signal provider recovery, or does Factory Core poll? This needs specification because it drives the recovery loop implementation |
| FR76 | Git config immutability (never modify `.gitconfig`, remotes, branches) | READY | Negative constraints; testable by attempting violations |

### 1.12 Meta-Optimization (FR77–FR89)

| FR | Title | Readiness | Notes |
|----|-------|-----------|-------|
| FR77 | Daily cron observer — analyze factory operations + write structured journal | **BLOCKING** | This FR enumerates 9 distinct analysis dimensions (token consumption, context utilization, overlay efficiency, prompt effectiveness, model tier performance, phase manifest waste, hook overhead, BMAD findings, QA findings). The cron observer is described as observe-only, but the analysis across 9 dimensions implies significant LLM work per run. The FR does not specify: (a) what "prompt effectiveness" means algorithmically, (b) what "overlay stage efficiency" means measurably, (c) how "stall/retry correlation" is computed, (d) the journal schema fields. Without the journal schema, FR82 (lifecycle record) and FR84 (performance degradation detection) cannot be written. FR77 must be decomposed into its constituent analysis capabilities, each with measurable AC |
| FR78 | Daily cron observer is observe-only (no changes) | READY | Behavioral constraint; testable as a negative |
| FR79 | Weekly cron agent — reads 7 journals, identifies patterns, ranks improvements | CLARIFY | "Distinguish signal from noise" — this is a subjective judgment. What algorithm? What is the rank criterion for "estimated impact"? This needs AC before an agent can be instructed to implement it |
| FR80 | Weekly cron — implements single highest-impact improvement | CLARIFY | "Operational parameters (prompt template adjustments, overlay composition rebalancing, context budget reallocation)" — which prompt templates? Overlay composition rebalancing is ambiguous: does this mean adjusting token budgets per stage, or adjusting which items are included? The blast radius of this FR is undefined |
| FR81 | Weekly optimizer — one improvement per cycle | READY | Constraint; testable |
| FR82 | Meta-optimization change as lifecycle record in YAML | READY | Schema is well-described in the FR body |
| FR83 | Dashboard flag + one-click revert for meta-optimization changes | READY | Dashboard control; depends on FR82 record format |
| FR84 | Auto-revert on performance degradation (normalized metrics, like-for-like) | CLARIFY | "Normalized metrics (tokens per file modified, stalls per complexity estimate, BMAD correction rate by scope)" — how is complexity estimated? How are "like-for-like" work items identified for comparison? The normalization methodology is underspecified |
| FR85 | Storage paths for daily/weekly journals | READY | Path convention; trivially specified |
| FR86 | Meta-optimization safety boundaries (cannot violate iron laws, git safety, increase budgets, disable hooks) | READY | Constraint list; each constraint is testable |
| FR87 | Minimum story threshold before optimizer proposes changes | READY | Configurable floor; testable |
| FR88 | Effectiveness window with auto-revert on unvalidated change | CLARIFY | "Measurable improvement within the window" — improvement in what metric? The FR does not specify the primary measurement signal. If the daily observer (FR77) does not have a defined output schema, the weekly optimizer (FR84/FR88) cannot identify the improvement metric |
| FR89 | Dashboard meta-optimization history timeline | READY | Display; depends on FR82 and FR83 |

### 1.13 Resilience & Integrity (FR91–FR104)

| FR | Title | Readiness | Notes |
|----|-------|-----------|-------|
| FR91 | Story spec schema validation at intake | READY | Guard clause; schema needs to be documented as a deliverable |
| FR92 | Runtime file contention detection between concurrent stories | DEFERRED | Explicitly tagged "MVP if feasible, Growth if not — decision deferred to architecture phase." Cannot be decomposed until feasibility is resolved |
| FR93 | Developer dismisses BMAD finding with dismissal logged | READY | Dashboard control + PR evidence field |
| FR94 | Hook execution timeout + bypass on timeout | READY | Well-specified; testable |
| FR95 | Mulch content integrity checks before injection | READY | Schema validation + encoding check; small story |
| FR96 | Block API calls without complete attribution chain | CLARIFY | Overlaps with FR42. Who enforces this, Pi SDK or Factory Core? The enforcement mechanism must be specified once, not twice. FR42 and FR96 should be merged or one should clearly reference the other as the mechanism owner |
| FR97 | Dashboard SSE auto-reconnect with state catch-up | CLARIFY | "Replay missed events from Overstory since disconnect" — what is the event replay mechanism? Does Overstory maintain an event log with cursors, or does the dashboard request a full state dump? This is NFR19 territory and the two must align |
| FR98 | Learning record retention window + archive | DEFERRED | Explicitly tagged "MVP if feasible, Growth if not — decision deferred to architecture phase" |
| FR99 | Developer manually tags PR as "caused production issue" | CLARIFY | "Feeds as a high-weight negative signal into the learning system and meta-optimization daily observer" — what is the schema for this signal? How does the learning system consume it? How does the meta-optimization observer consume it? Two consumption paths need specification |
| FR100 | Meta-optimization cumulative drift tracking + dashboard flag | DEFERRED | Explicitly tagged "MVP if feasible, Growth if not — decision deferred to architecture phase" |
| FR101 | CLI revert for meta-optimization change | READY | CLI fallback; depends on FR82 revert payload |
| FR102 | BMAD review profiles configurable per project | CLARIFY | "Security-focused, API-contract-focused, performance-focused, or custom" — what is the review profile schema? How does a profile change BMAD agent behavior? Without the profile schema, this FR cannot be implemented |
| FR103 | No API keys/secrets in any factory output | READY | Security constraint; tested via automated credential scanning |
| FR104 | Story queue with FIFO default and reorder via dashboard | READY | Queue control; small story |

### 1.14 Dashboard Copilot (FR105–FR119)

| FR | Title | Readiness | Notes |
|----|-------|-----------|-------|
| FR105 | Collapsible chat bar docked to right edge | READY | Layout component; clearly specified |
| FR106 | Copilot Ask mode | READY | Query current state; read-only |
| FR107 | Copilot Investigate mode — programmatic dashboard navigation + multi-source correlation | SPLIT | Navigation and multi-source data correlation are independently testable capabilities. Navigation (programmatic UI control) is the more complex part and should be a separate story |
| FR108 | Copilot Act mode — execute dashboard controls | READY | Well-specified including which controls are accessible |
| FR109 | Act mode requires explicit confirmation | READY | UX constraint; testable |
| FR110 | Copilot actions through UI controls only (no direct API access) | READY | Architectural constraint; testable |
| FR111 | CopilotKit `useCopilotReadable` hooks | READY | Integration pattern; specific fields listed |
| FR112 | CopilotKit `useCopilotAction` hooks | READY | Integration pattern; specific controls listed |
| FR113 | AG-UI bidirectional streaming | READY | Protocol integration; well-specified |
| FR114 | Multi-step investigations — chaining across stories/agents/sources | READY | Depends on FR107 existing |
| FR115 | Investigation step visibility in chat (action indicators) | READY | Display concern; clearly specified |
| FR116 | Conversation context within session (referent tracking) | CLARIFY | "Conversation history and accumulated investigation state" — what is the retention model? Is conversation context stored in SQLite, in-memory only, or in an overlay? If the dashboard crashes, is conversation history lost? |
| FR117 | Copilot token usage tracked as "copilot usage" attribution line | READY | Attribution chain extension; small story |
| FR118 | Economy-tier for queries, standard for complex investigations | READY | Tier directive; consistent with FR36 model |
| FR119 | Copilot cannot modify factory configuration or agent overlays | READY | Negative constraint; testable |

### 1.15 Developer Communication Layer (FR120–FR129)

| FR | Title | Readiness | Notes |
|----|-------|-----------|-------|
| FR120 | Telegram Bot API escalation notifications with inline keyboard action buttons | READY | Well-specified; MarkdownV2 formatting, action buttons |
| FR121 | Telegram structured commands (query + control) | READY | Command list is enumerated; authentication via user ID |
| FR122 | Story submission via Telegram | Growth — excluded from MVP scope |
| FR123 | Async dialogue state for pending decisions with timeouts | READY | SQLite-backed; conservative defaults documented |
| FR124 | Dual-channel action synchronization (idempotent) | READY | Atomic SQL resolution described |
| FR125 | Quiet hours, DND mode, per-severity routing | READY | Configuration options; well-specified |
| FR126 | Daily morning summary via Telegram | READY | Cron-triggered; content fields listed |
| FR127 | Telegram user registration via one-time code flow | READY | Registration flow described step-by-step |
| FR128 | NL classification of unstructured Telegram messages via LLM | CLARIFY | "Classified by an economy-tier LLM into command intents" — which intents? What happens when classification confidence is low? What is the fallback for ambiguous classifications? |
| FR129 | PRD submission via Telegram file upload | Growth — excluded from MVP scope |

### 1.16 Agent Performance Data Collection (FR130–FR132, FR140)

| FR | Title | Readiness | Notes |
|----|-------|-----------|-------|
| FR130 | Action-level process scoring (Promise + Progress) | READY | Best-specified FR in the document; schema, LOC estimate, integration points all present |
| FR131 | Confidence calibration at phase boundaries (Brier score + resolution) | READY | Well-specified including resolution requirement and anti-gaming constraint |
| FR132 | Session-level composite performance scores | READY | Bounded step function, component breakdown, integration points all specified |
| FR140 | Performance data export | READY | CLI + dashboard trigger; output format specified |

### 1.17 Economic Governance (FR142, FR145)

| FR | Title | Readiness | Notes |
|----|-------|-----------|-------|
| FR142 | Per-story budget enforcement (revised) + per-role visibility | READY | Revised FR is well-specified; two enforcement levels (story, global) plus per-role tracking |
| FR145 | Atomic task checkout (SQLite row lock with timeout) | READY | Lock mechanism, timeout, release condition all specified |

### 1.18 Orchestration (FR149)

| FR | Title | Readiness | Notes |
|----|-------|-----------|-------|
| FR149 | Turn-based continuation within phases with progress velocity check | READY | Well-specified: lightweight signals, configurable max turns, velocity extension rule (75% threshold + 1.5x hard cap) |

### 1.19 Quality Verification (FR152, FR155, FR163)

| FR | Title | Readiness | Notes |
|----|-------|-----------|-------|
| FR152 | Lightweight continuous structural verification | READY | Well-specified: artifact existence, content patterns, key integration links, oscillation detection; LOC estimate present |
| FR155 | Context budget 50% rule with minimum floor | READY | 50% ratio, 8K token floor, adjustment formula for models under 32K — well-specified |
| FR163 | Nyquist-BMAD disagreement protocol | READY | Three conflict scenarios each with resolution rule; well-specified |

### 1.20 Self-Learning System (FR164–FR168, FR170–FR171)

| FR | Title | Readiness | Notes |
|----|-------|-----------|-------|
| FR164 | Maintenance learning extraction + CLI seeding | READY | Schema fields, categories, CLI command — well-specified |
| FR165 | Codebase pattern knowledge accumulation | READY | Pattern schema, evidence/confidence thresholds, decay behavior — well-specified |
| FR166 | Epic-level context management | READY | Assembly sources, storage table, token budget, injection stage — well-specified |
| FR167 | Overlay learning enrichment with priority ordering | READY | 4-level priority order, truncation rule, integration stage — well-specified |
| FR168 | Maintenance burden tracking | READY | Categorization fields, table name, success metric definition — well-specified |
| FR170 | System health circuit breaker | READY | Trigger condition (3 subsystems in 60s), actions, reset conditions — well-specified |
| FR171 | Multi-channel notification abstraction (Telegram as first channel) | READY | Interface definition, MessageBus pattern, TelegramChannel adapter — well-specified |

---

## 2. FRs That Must Be Split Before Story Writing

The following FRs each contain 2–4 independently deliverable capabilities. Story writers will produce conflicts or overly large stories if these are not split.

| FR | Contains These Independent Capabilities | Recommended Split |
|----|----------------------------------------|-------------------|
| FR4 | (a) Worktree isolation mechanics, (b) concurrency scheduler + cross-story contamination prevention | Split into FR4a (isolation) and FR4b (scheduler). FR4a is a prerequisite for FR4b |
| FR6 | (a) Fresh agent spin-up with clean context, (b) manifest construction + transfer, (c) phase transition sequencing | Three stories; sequenced as (c) → (a) → (b) for dependency order |
| FR8 | (a) PR creation + branch push mechanics, (b) evidence body template assembly | FR8a first (unblocks testing); FR8b after BMAD/QA evidence sources exist |
| FR14 | (a) Hook runner infrastructure, (b) Layer 2 post-edit gates (FR15+FR16), (c) Layer 3 post-task gates (FR17), (d) Layer 4 phase boundary gates (FR18) | FR14a is an infrastructure story that blocks (b), (c), (d). Each gate layer is a separate story |
| FR21 | (a) Agent spawn + monitor, (b) agent stop + replace | Two stories; (a) is a prerequisite for (b) |
| FR22 | (a) Crash detection + replacement spawning, (b) Telegram dispatch on recovery events | Two stories; (a) first, (b) depends on FR120 existing |
| FR47 | (a) Stall detection algorithm + time-on-task tracking, (b) stall type classification (3 types), (c) diagnostic summary generation, (d) Telegram notification dispatch | Four stories; (a) and (b) are core, (c) and (d) are enhancement stories |
| FR48 | (a) SSE event stream from Overstory, (b) WebSocket command channel, (c) Telegram EventStore subscription | Three independently testable integration points |
| FR52 | (a) PR creation mechanics + branch push, (b) evidence body template assembly | Mirror of FR8 split |
| FR64 | (a) Timestamps + story provenance, (b) content deduplication for parallel writes | Two stories; (b) requires more design (deduplication mechanism) |
| FR69 | (a) Dependency verification (Bun/Rust/`gh`), (b) source project version alignment, (c) resource pre-flight (RAM/CPU/disk) | Three checks; can be one story if execution is sequential but verification AC is separate for each |
| FR73 | (a) Disk + memory monitoring infrastructure, (b) threshold + hard-limit actions, (c) Telegram dispatch | Three stories; (a) is infrastructure, (b) is behavior, (c) is integration |
| FR107 | (a) Programmatic dashboard navigation, (b) multi-source data correlation | Two stories; (a) is harder and should prototype first |

---

## 3. FRs with Underspecified Acceptance Criteria

Fourteen FRs lack sufficient detail for an architect or story writer to produce a Done condition that is unambiguous to a developer.

| FR | Missing Acceptance Criteria | Impact If Not Resolved |
|----|----------------------------|------------------------|
| FR5 | Work type declaration schema undefined; no failure mode specified for wrong work type | Pipeline composition cannot be tested |
| FR10 | Context isolation enforcement mechanism not specified (process boundary vs. overlay policy vs. manifest-only) | BMAD adversarial guarantee cannot be verified |
| FR18 | Phase boundary gate failure remediation owner not specified | Fix loop (FR7) and phase boundary gate failure create an undefined responsibility boundary |
| FR23 | `learning_report` mail schema not specified | FR57 and FR23 will produce conflicting implementations |
| FR24 | Checkpoint granularity (per-turn/per-task/per-phase) and partial-write recovery protocol not specified | "Without data loss" is not testable |
| FR31 | Scope-split decision criteria not specified; minimum viable scope not defined | When to split vs. escalate is ambiguous |
| FR50 | SSE event replay vs. state snapshot recovery mechanism not specified | NFR19 (5s reconnect) cannot be validated |
| FR75 | Provider-recovery signal mechanism not specified (Pi SDK event vs. Factory Core poll) | Auto-resume implementation is undefined |
| FR79 | "Signal vs. noise" algorithm and "estimated impact" ranking criterion undefined | Weekly optimizer is implementing undefined logic |
| FR84 | Normalization methodology for like-for-like comparison undefined | Auto-revert trigger condition cannot be implemented |
| FR90 | Bot/automation comment filter heuristic undefined | False positives will pollute Seeds task graph |
| FR96 | Attribution chain enforcement owner (Pi SDK vs. Factory Core) not specified; conflicts with FR42 | Duplicate enforcement or no enforcement |
| FR99 | "Production issue" signal schema and consumption protocol for learning system + meta-optimization undefined | Two consumers, no data contract |
| FR102 | BMAD review profile schema undefined | Review profiles cannot be configured or validated |
| FR116 | Conversation context retention model (storage, scope, crash behavior) undefined | Conversation UX is non-deterministic across crashes |
| FR128 | NL classification intents, confidence threshold, and ambiguity fallback undefined | Classification failures are unhandled |

---

## 4. FRs That Are Too Broad to Decompose Without Conflict (Blocking)

### FR28 — Overlay Composition Pipeline

**Problem:** FR28 is a complete subsystem description masquerading as a single functional requirement. The PRD's own architecture section devotes 15 paragraphs and a code block to specifying the 6-stage pipeline. The FR body is a one-sentence summary. Any architect reading FR28 in isolation will produce a different decomposition than an architect reading the architecture section.

**What conflicts are likely:**
- Story A implements the token budget enforcement mechanism; Story B implements the priority ranking. They overlap on the truncation interface.
- Story A delivers the budget manifest output; Story C for the Learning Audit view (post-MVP) expects it in a specific format. Format is undefined.
- The context budget check (FR30) is a guard clause on the overlay composition (FR28), but their integration point is not specified.

**Resolution required before architecture:** Define the 6-stage overlay composition pipeline as an architecture decision record (ADR) or mini-spec with: (a) the interface contract between stages, (b) the budget manifest schema, (c) the error contract when a stage fails, (d) the stage priority order when multiple stages exceed budget simultaneously.

---

### FR32 — Phase Boundary Protocol

**Problem:** The canonical manifest schema does not exist. The FR mentions "required sections" without enumerating them. The PRD narrative (Journey 5, architecture section) reveals that manifests contain: summary, struggles/discoveries, file-scope conventions, architecture decisions, learnings, confidence declarations, and context budget consumed. But this list is assembled from narrative prose, not a specification.

**What conflicts are likely:**
- FR18 (phase boundary hooks) validates the manifest schema. Without a canonical schema, the validation spec cannot be written.
- FR32 and FR58 (learnings section) are co-dependent. FR58 cannot be specified as a story without FR32's schema existing.
- FR131 (confidence calibration) requires confidence declarations in the manifest. The declaration schema must be part of FR32's canonical manifest.
- The Phase Boundary Protocol is the factory's highest design-risk greenfield component per the PRD's own risk assessment. Conflicting stories here corrupt the adversarial review guarantee.

**Resolution required before architecture:** Produce a Phase Boundary Protocol mini-spec as the first architecture deliverable. It should define: (a) the canonical manifest schema (all required and optional sections), (b) schema validation rules, (c) the manifest serialization format (YAML or JSON), (d) the handoff protocol (who creates it, who validates it, who consumes it).

---

### FR77 — Daily Cron Observer

**Problem:** FR77 enumerates 9 distinct analysis dimensions for the daily cron observer. Three of these are algorithmically undefined: "prompt effectiveness (stall/retry correlation)," "overlay stage efficiency," and "model tier performance by agent role." The remaining six are computable but lack schema definitions.

**What conflicts are likely:**
- FR82 (lifecycle record) references the daily journal output. Its schema cannot be designed without FR77's output schema.
- FR84 (auto-revert on degradation) and FR88 (effectiveness window) both consume daily journal data. The auto-revert trigger condition cannot be coded without FR77's journal schema.
- FR79 (weekly optimizer reads 7 journals) is entirely dependent on FR77's output format.
- The meta-optimization cascade (FR77 → FR79 → FR80 → FR82 → FR84 → FR88 → FR89) is a single dependency chain where FR77 is the undefined source.

**Resolution required before architecture:** Define the daily journal schema as an ADR. For each of the 9 analysis dimensions, specify: (a) what data it reads from (which tables, which event streams), (b) what it computes, (c) the output field name and type in the journal schema. The three algorithmically undefined dimensions (prompt effectiveness, overlay efficiency, model tier performance) need AC or should be deferred to Growth with the meta-optimization system scoped to the 6 computable dimensions for MVP.

---

## 5. Proposed Epic Groupings for 145 MVP FRs

The following 9-epic structure groups FRs by delivery sequence and dependency cluster. Epics are ordered by the critical path identified in the PRD's implementation sequencing section.

### Epic 1 — Infrastructure Foundation
**Theme:** Everything that must exist before agents can run at all.
**FRs:** FR36, FR40, FR41, FR42, FR51, FR69, FR70, FR71, FR76, FR91, FR103, FR145

**Rationale:** Pi SDK integration (FR36), worktree lifecycle (FR40/FR41), attribution chain (FR42), git safety (FR51), setup script (FR69/FR70/FR71), and atomic task checkout (FR145) are the lowest-level prerequisites. No story can flow through the factory until these exist.

**Notable:** FR42 and FR96 conflict should be resolved here; attribution chain enforcement should be a single story with a clear owner.

---

### Epic 2 — Hook Enforcement Engine
**Theme:** The mechanical quality gate layer that validates every agent action.
**FRs:** FR14 (hook runner infrastructure), FR15, FR16, FR17, FR18, FR19, FR94, FR155

**Rationale:** The hook runner (FR14a infrastructure story) is a prerequisite for Phase Boundary Protocol (Epic 3). All subsequent quality enforcement depends on hooks existing. FR94 (timeout + bypass) and FR155 (context budget 50% rule) belong here as they govern hook and context behavior.

**Dependencies:** Requires Epic 1 (worktree lifecycle, Pi SDK) to exist.

---

### Epic 3 — Phase Boundary Protocol + Overlay Composition
**Theme:** The context management spine of the factory.
**FRs:** FR28, FR29, FR30, FR31, FR32, FR33, FR34, FR35, FR58, FR131, FR155 (shared with Epic 2), FR163

**Rationale:** FR28 (overlay composition) and FR32 (Phase Boundary Protocol) are the two blocking FRs that must produce ADRs before this epic can be story-written. FR29–FR35 are the overlay stage implementations. FR58 (learnings section in manifests) is a Phase Boundary concern. FR131 (confidence calibration) extends the manifest. FR163 (Nyquist-BMAD disagreement) mediates between Phase Boundary output and BMAD review.

**Dependencies:** Requires Epic 2 (hook runner) for phase boundary hooks.
**Delivery risk:** HIGHEST. Greenfield, novel, and the PRD explicitly flags this as the highest design risk.

---

### Epic 4 — Agent Orchestration + Factory Pipeline Engine
**Theme:** The agent lifecycle and pipeline execution engine that drives stories through phases.
**FRs:** FR1, FR2, FR3, FR4, FR5, FR6, FR7, FR9, FR21, FR22, FR23, FR24, FR37, FR38, FR39, FR47 (detection + classification), FR49, FR50, FR73, FR74, FR75, FR104, FR149, FR152, FR165 (pattern mining infrastructure), FR170

**Rationale:** This is the Factory Core runtime: story intake, pipeline composition, phase transitions, agent lifecycle, concurrency, resource monitoring, and turn continuation. FR149 (turn continuation) and FR152 (structural verification) are natural companions to the pipeline execution loop. FR170 (circuit breaker) monitors Factory Core subsystems.

**Dependencies:** Requires Epics 1–3.

---

### Epic 5 — Quality Pipeline (BMAD + QA Swarm)
**Theme:** The adversarial review layer and QA execution.
**FRs:** FR10, FR11, FR12, FR13, FR93, FR102, FR53 (coverage gap indicator)

**Rationale:** BMAD (FR10/FR11) and QA swarm (FR12/FR13) are the judgment-quality layers above mechanical hooks. FR93 (BMAD finding dismissal) is a developer control on BMAD output. FR102 (review profiles) configures BMAD behavior. FR53 (coverage gap) is computed from QA wave scope, which is defined here.

**Dependencies:** Requires Epics 2–4 for context isolation and phase transitions.

---

### Epic 6 — Factory Learning System
**Theme:** The three-loop learning infrastructure and overlay injection.
**FRs:** FR55, FR56, FR57, FR59, FR60, FR61, FR62, FR63, FR64, FR66, FR67, FR68, FR130, FR132, FR140, FR142 (per-role tracking), FR164, FR165, FR166, FR167, FR168

**Rationale:** All three learning loops (FR55–FR58), the synthesis pipeline (FR59–FR63), the Mulch extensions (FR64, FR66), and the self-learning system (FR164–FR168) form a coherent data-flow system. Performance data collection (FR130, FR132, FR140) feeds the learning system's confidence weighting. FR142's per-role cost tracking is a prerequisite for understanding story cost distribution.

**Dependencies:** Requires Epics 3–4 for phase manifests and story completion events.

---

### Epic 7 — Git & PR Operations + Developer Communication (Telegram)
**Theme:** Factory output layer and developer notification infrastructure.
**FRs:** FR8, FR51, FR52, FR54, FR72, FR90, FR120, FR121, FR123, FR124, FR125, FR126, FR127, FR128, FR171

**Rationale:** PR creation and Telegram notifications are independently deliverable from the core pipeline but depend on story completion events. FR90 (PR comment → Seeds) requires GitHub API access that is set up alongside PR creation (FR52). FR171 (notification abstraction) should be the first story in this epic, since all Telegram FRs build on it.

**Dependencies:** Requires Epic 4 (story completion events, Seeds integration).

---

### Epic 8 — Dashboard + Dashboard Copilot
**Theme:** The observation and interaction plane.
**FRs:** FR20, FR25, FR26, FR27, FR43, FR44, FR45, FR46, FR48, FR50, FR65, FR71, FR83, FR89, FR97, FR104, FR105–FR119

**Rationale:** The dashboard is architecturally independent from the pipeline (agents continue if dashboard crashes, FR50). It can be developed in parallel with Epics 2–6 on the secondary developer track. The Dashboard Copilot (FR105–FR119) is a major feature cluster within the dashboard and should be a sub-epic or late sprint within Epic 8.

**Dependencies:** Requires Overstory SSE event stream (Epic 4) for real-time data. Can start dashboard shell (ZeroClaw fork) without it.

---

### Epic 9 — Meta-Optimization + Developer Operations Polish
**Theme:** Factory self-improvement loop and operational hardening.
**FRs:** FR77, FR78, FR79, FR80, FR81, FR82, FR84, FR85, FR86, FR87, FR88, FR89, FR95, FR96, FR97, FR98 (if feasibility confirmed), FR99, FR100 (if feasibility confirmed), FR101, FR103 (shared concern), FR143 (see note)

**Note:** FR92, FR98, FR100 are deferred-feasibility FRs. Architecture must confirm or deny feasibility before Epic 9 sprint planning. FR77 is a BLOCKING FR that must produce a journal schema ADR before any other meta-optimization stories can be written. This epic should not be sprint-planned until FR77 is resolved.

**Dependencies:** Requires Epics 4–6 (operational data that the observer analyzes).

---

### Developer Operations & Setup (Cross-Epic)

FR69 (setup script), FR70 (factory.yaml), FR71 (independent instances), FR76 (git safety) belong to Epic 1 but should have acceptance testing stories in the final sprint of every epic that affects the setup experience.

---

## 6. Story Count Estimates per Epic

Story counts use a 3-point estimate (Low / Mid / High) reflecting the uncertainty introduced by the blocking FRs, deferred-feasibility FRs, and underspecified AC items.

| Epic | FR Count (MVP) | Story Count Low | Story Count Mid | Story Count High | Key Uncertainty |
|------|---------------|-----------------|-----------------|------------------|-----------------|
| 1 — Infrastructure Foundation | 12 | 10 | 13 | 16 | FR42/FR96 conflict resolution; Pi SDK integration complexity |
| 2 — Hook Enforcement Engine | 8 | 7 | 10 | 13 | Hook runner architecture; test runner integration per project type |
| 3 — Phase Boundary Protocol + Overlay | 12 | 11 | 16 | 22 | FR28 and FR32 are blocking; ADR production is time variable |
| 4 — Agent Orchestration + Pipeline Engine | 22 | 18 | 25 | 33 | Largest epic; FR47 split adds stories; FR5/FR24 AC gaps |
| 5 — Quality Pipeline (BMAD + QA) | 7 | 6 | 9 | 12 | FR10 context isolation mechanism; FR102 profile schema |
| 6 — Factory Learning System | 21 | 15 | 21 | 28 | FR57/FR23 schema conflict; learning record data model maturity |
| 7 — Git, PR + Telegram | 15 | 12 | 17 | 22 | FR90 filter heuristic; FR128 NL classification scope |
| 8 — Dashboard + Copilot | 25 | 18 | 24 | 32 | FR50 reconnect mechanism; AG-UI integration; Copilot streaming |
| 9 — Meta-Optimization + Hardening | 20 | 8 | 14 | 22 | FR77 is blocking; 3 deferred-feasibility FRs; FR84 normalization method |
| **Total** | **142*** | **105** | **149** | **200** | |

*Three FRs (FR92, FR98, FR100) counted in Epic 9 pending feasibility confirmation; FR122 and FR129 are Growth and excluded.

**Key takeaway:** The Mid estimate of ~149 stories is the most likely outcome assuming blocking FRs are resolved and deferred-feasibility FRs are confirmed as MVP. If FR77 is scoped back (Meta-Optimization deferred or reduced) and the three deferred-feasibility FRs slide to Growth, the total drops to approximately 105–120 stories.

---

## 7. FRs That Need Clarification Before Architecture Translates Them to Stories

The following table is the authoritative list for the architecture review session. These FRs should be on the agenda before the architecture phase begins story writing.

### Priority 1 — Blocking (Must Resolve First)

| FR | Clarification Required | Suggested Output |
|----|----------------------|-----------------|
| FR28 | 6-stage overlay pipeline interface contract, budget manifest schema, inter-stage error contract | ADR: Overlay Composition Pipeline |
| FR32 | Canonical Phase Boundary Protocol manifest schema (all sections, types, validation rules) | ADR: Phase Boundary Protocol Manifest Schema |
| FR77 | Daily cron journal schema; algorithmic definition of "prompt effectiveness," "overlay stage efficiency," "model tier performance" | ADR: Meta-Optimization Journal Schema + Analysis Scope |

### Priority 2 — Decomposition-Blocking (Must Resolve Before Story Writing)

| FR | Clarification Required | Suggested Output |
|----|----------------------|-----------------|
| FR10 | Context isolation enforcement mechanism specification | Story AC: BMAD context isolation invariant |
| FR18 | Phase boundary gate failure remediation ownership | Story AC update: fix loop responsibility boundary |
| FR23 / FR57 | `learning_report` mail schema (fields, sender, receiver, consumer behavior) | Single schema definition (canonical in FR57, referenced in FR23) |
| FR42 / FR96 | Attribution chain enforcement: who blocks missing attribution, Pi SDK or Factory Core? | Merge into single FR or create explicit division of responsibility |
| FR50 | SSE state recovery mechanism: event replay from cursor vs. full state snapshot | Must match NFR19; define mechanism in one place |
| FR79 | Weekly optimizer: signal-vs-noise algorithm and estimated-impact ranking criterion | Story AC: observable and testable decision rule |
| FR80 | Weekly optimizer change scope: exactly which operational parameters can change, and their allowed ranges | Story AC: change blast radius definition |
| FR84 | Auto-revert normalization methodology: complexity metric and like-for-like comparison protocol | Story AC: auto-revert trigger condition |
| FR90 | PR comment bot-filter heuristic: what signals identify bot/CI/automation comments | Story AC: filter specification with false-positive rate target |
| FR102 | BMAD review profile schema: what fields does a profile contain, and how does it change BMAD agent behavior | Profile schema (YAML) as a prerequisite artifact |

### Priority 3 — Story-Accuracy Risk (Resolve Before Sprint Planning)

| FR | Clarification Required | Risk If Not Resolved |
|----|----------------------|---------------------|
| FR5 | Work type declaration schema | Pipeline composition stories may ship incompatible work type specs |
| FR24 | Checkpoint granularity and partial-write recovery protocol | Checkpoint stories may not satisfy NFR15 |
| FR31 | Scope-split decision algorithm and minimum viable scope | Context budget stories may produce unworkable splits |
| FR34 | Who writes `enforcement` metadata: factory team or Superpowers integration? | Unclear story ownership |
| FR53 | QA wave scope definition method (story spec derived vs. file-scope assigned) | Coverage gap calculation may be wrong |
| FR65 | New vs. existing Seeds functionality boundary | Wasted work if Seeds already supports required behavior |
| FR75 | Provider-recovery signal mechanism | Auto-resume may be unimplementable without Pi SDK signal |
| FR88 | Effectiveness window primary measurement signal | Auto-revert may trigger on wrong metric |
| FR99 | "Production issue" signal schema and dual-consumer protocol | Learning system + meta-optimization will disagree on input format |
| FR116 | Conversation context retention model and crash behavior | Copilot UX is non-deterministic |
| FR128 | NL classification intents and ambiguity fallback | Telegram NL loop may produce undefined behavior |

---

## 8. Ambiguity Risk Scoring for Problematic FRs

Risk scoring on two dimensions:
- **Conflict Probability (CP):** How likely is it that two stories written against this FR will conflict or overlap, requiring rework? (1 = unlikely, 5 = near-certain)
- **Cascade Impact (CI):** How many other FRs become unspecifiable or conflicted if this FR is not resolved? (1 = isolated, 5 = cascade-blocking)

**Risk Score = CP × CI** (max 25)

| FR | Description | CP | CI | Risk Score | Status | Primary Blocker |
|----|-------------|----|----|-----------|--------|----------------|
| FR32 | Phase Boundary Protocol manifest schema | 5 | 5 | **25** | BLOCKING | FR18, FR58, FR131, FR163 all require canonical schema |
| FR28 | Overlay composition pipeline | 5 | 4 | **20** | BLOCKING | FR29–FR31, FR61, FR155, FR167 all depend on pipeline contract |
| FR77 | Daily cron journal schema + analysis scope | 5 | 4 | **20** | BLOCKING | FR79, FR80, FR82, FR84, FR88, FR89 are all downstream |
| FR42/FR96 | Attribution chain enforcement (duplicate/conflict) | 4 | 4 | **16** | CLARIFY | Attribution stories will collide at enforcement layer |
| FR10 | BMAD context isolation mechanism | 4 | 3 | **12** | CLARIFY | The adversarial guarantee is the system's primary differentiator |
| FR50 | Dashboard SSE state recovery mechanism | 4 | 3 | **12** | CLARIFY | NFR19 alignment; affects all dashboard reconnect stories |
| FR23/FR57 | `learning_report` mail schema conflict | 4 | 3 | **12** | CLARIFY | Loop 1 learning is built on this schema |
| FR84 | Auto-revert normalization methodology | 3 | 4 | **12** | CLARIFY | Meta-optimization cascade is entirely dependent |
| FR79 | Weekly optimizer signal/noise algorithm | 4 | 3 | **12** | CLARIFY | Weekly cron implementation cannot proceed |
| FR80 | Weekly optimizer change blast radius | 4 | 3 | **12** | CLARIFY | Safety boundary for self-modification is undefined |
| FR18 | Phase boundary gate failure remediation owner | 3 | 3 | **9** | CLARIFY | Fix loop and phase boundary gate stories may conflict |
| FR102 | BMAD review profile schema | 3 | 3 | **9** | CLARIFY | FR10/FR11 quality pipeline cannot be configured without this |
| FR53 | QA wave scope definition | 3 | 2 | **6** | CLARIFY | Coverage gap indicator may be incorrectly computed |
| FR99 | Production issue signal schema | 2 | 3 | **6** | CLARIFY | Dual-consumer contract missing |
| FR90 | PR comment bot filter heuristic | 3 | 2 | **6** | CLARIFY | Seeds pollution risk without false-positive control |
| FR31 | Scope-split decision algorithm | 2 | 3 | **6** | CLARIFY | Context budget split stories are unworkable without criteria |
| FR116 | Copilot conversation context retention | 2 | 2 | **4** | CLARIFY | UX inconsistency on crash; not pipeline-critical |
| FR128 | Telegram NL classification intents | 2 | 1 | **2** | CLARIFY | Bounded scope; Telegram is a non-critical communication path |

**Risk Priority Summary:**

- **Score 20–25 (Must resolve before architecture phase begins):** FR32, FR28, FR77
- **Score 12–16 (Must resolve before sprint planning):** FR42/FR96, FR10, FR50, FR23/FR57, FR84, FR79, FR80
- **Score 6–9 (Resolve before story writing for affected epic):** FR18, FR102, FR53, FR99, FR90, FR31
- **Score 1–4 (Best-effort clarification; stories can proceed with noted risk):** FR116, FR128

---

## 9. Deferred-Feasibility FRs — Architecture Decision Required

Three FRs were explicitly tagged in the PRD as "MVP if feasible, Growth if not — decision deferred to architecture phase." These must be resolved before Epic 9 sprint planning.

| FR | Description | PRD Tag | Architecture Decision Required | Risk if Deferred to Growth |
|----|-------------|---------|-------------------------------|--------------------------|
| FR92 | Runtime file contention detection between concurrent stories | "MVP if feasible, Growth if not" | Is real-time file-level conflict detection achievable at story-start without per-file lock tables? What is the detection algorithm? What is the latency impact on story startup? | Medium — workaround is developer coordination via Seeds; not pipeline-critical |
| FR98 | Learning record retention window + archive | "MVP if feasible, Growth if not" | Is unbounded disk growth a real risk within 3 months of MVP operation? Estimate: 23 records/day × 90 days = 2,070 records at ~1KB each = ~2MB. Disk risk appears low; feasibility likely confirmed trivially | Low — disk risk is empirically small; Growth is acceptable |
| FR100 | Meta-optimization cumulative drift tracking + dashboard flag | "MVP if feasible, Growth if not" | Depends on FR77's journal schema existing. If FR77 is resolved, FR100 is ~120 LOC (compare config snapshots). Feasibility is high if FR77 is resolved; if FR77 remains blocking, FR100 cannot be assessed | Medium — drift visibility is a safety feature for the self-modification system |

**Recommendation:** FR98 can be confirmed as feasible (Growth risk is near-zero, small story). FR92 should be evaluated for feasibility early in Epic 4 architecture design. FR100 is blocked by FR77 resolution — confirm feasibility only after FR77's journal schema is established.

---

## 10. Summary Recommendations for Architecture Phase

### Immediate Actions (Before Any Story Writing)

1. **Produce three ADRs as the first architecture deliverables:**
   - ADR-A: Phase Boundary Protocol Manifest Schema (resolves FR32, unblocks FR18, FR58, FR131, FR163)
   - ADR-B: Overlay Composition Pipeline Interface Contract (resolves FR28, unblocks FR29–FR31, FR61, FR155, FR167)
   - ADR-C: Meta-Optimization Daily Journal Schema and Analysis Scope (resolves FR77, unblocks entire FR79–FR89 chain)

2. **Resolve the FR42/FR96 duplication:** Decide whether Pi SDK enforces attribution chain completeness or Factory Core does. Merge into a single authoritative statement. If both layers have a role, specify what each checks.

3. **Produce canonical schemas for:** `learning_report` mail type (FR23/FR57), BMAD review profiles (FR102), work type declarations (FR5). These are 1–2 page mini-specs that unblock story writing in Epics 3–5.

### Before Sprint Planning (Epic by Epic)

- **Epic 3:** FR28 and FR32 ADRs must be complete. No stories can be written without them.
- **Epic 4:** FR24 (checkpoint granularity) and FR75 (provider recovery signal) must be resolved. FR47 stall classification algorithm needs AC.
- **Epic 5:** FR10 context isolation mechanism and FR102 review profile schema must be resolved.
- **Epic 9:** FR77 ADR must be complete. Deferred-feasibility FRs (FR92, FR98, FR100) must have confirmed MVP/Growth status.

### FR Splits to Perform Before Story Writing

Execute all 13 splits listed in Section 2. The highest-priority splits (those on the critical path) are:
1. FR6 (phase transitions) — blocks Epic 3
2. FR14 (hook runner infrastructure) — blocks Epic 2
3. FR4 (worktree isolation vs. concurrency scheduler) — affects Epic 1/4 boundary
4. FR48 (SSE vs. WebSocket vs. Telegram EventStore) — affects Epic 7/8 boundary

---

*End of Epic Decomposition Readiness Review — 2026-03-14*
