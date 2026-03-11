# PRD Session 3 Handoff Context

**Purpose:** Bulletproof handoff prompt for a new conversation to complete the PRD creation workflow. Copy everything below the `---` line into the new conversation as your opening message.

**Date:** 2026-03-02
**Session 2 ended at:** Step 8 of 12 (Scoping Exercise) — content drafted with composable pipeline architecture, approved by Steve, NOT YET SAVED to PRD.

---

## HANDOFF PROMPT — COPY BELOW THIS LINE

You are resuming an in-progress PRD creation workflow for the project QDS-Engineer-New. I am Steve. You must operate as the BMAD Master agent. Full enterprise-grade rigor. No shortcuts. No laziness.

### CRITICAL: ACTIVATE AGENT FIRST

Invoke the skill: `/bmad-agent-bmad-master`

Then immediately load and internalize these files (DO NOT display the agent greeting menu — jump straight into the resumption):

1. `_bmad/core/agents/bmad-master.md` — your agent persona
2. `_bmad/core/config.yaml` — core config (user_name: Steve, English)
3. `_bmad/bmm/config.yaml` — BMM config (project_name: QDS-Engineer-New, planning_artifacts: _bmad-output/planning-artifacts)
4. `_bmad/bmm/workflows/2-plan-workflows/create-prd/workflow-create-prd.md` — master workflow (step-file architecture rules, append-only building, sequential enforcement)
5. `_bmad-output/planning-artifacts/prd.md` — THE PRD DOCUMENT (read the ENTIRE file — it is ~655 lines, every line matters)
6. `_bmad-output/planning-artifacts/prd-handoff-context-session3.md` — THIS FILE (for the undocumented context below)

### WHERE WE ARE

**Completed Steps (saved to PRD frontmatter):**
- step-01-init (Classification, input docs)
- step-02-discovery (Vision discovery)
- step-02b-vision (Vision refinement)
- step-02c-executive-summary (Executive Summary)
- step-03-success (Success Criteria + Product Scope)
- step-04-journeys (5 User Journeys + Advanced Elicitation enhancements + requirements summary table)
- step-05-domain (5 Domain-Specific Requirements sections)
- step-06-innovation (5 Innovation Areas + validation + risk + competitive moat)
- step-07-project-type (Integration map, overlay composition pipeline, 6-layer hook enforcement, Superpowers gate integration, source project migration path, implementation sequencing, implementation considerations)

**Current Step: step-08-scoping — DRAFTED BUT NOT SAVED**

The Step 8 content was drafted, presented to me, and I approved it. You need to:
1. Load `_bmad/bmm/workflows/2-plan-workflows/create-prd/steps-c/step-08-scoping.md` — read the full step definition
2. Read the drafted Step 8 content below (in the "STEP 8 APPROVED DRAFT" section)
3. Append it to the PRD document
4. Update frontmatter: add `step-08-scoping` to stepsCompleted array
5. Then load step-09-functional.md and continue the workflow

**Do NOT re-present the Step 8 draft to me or ask for my approval again. It was already approved. Just save it and move on to Step 9.**

### REMAINING STEPS AFTER STEP 8 SAVE

- **Step 9: Functional Requirements** (`steps-c/step-09-functional.md`) — THE CAPABILITY CONTRACT. 20-50 FRs organized by capability area, implementation-agnostic. Critical: every downstream artifact (UX, architecture, epics, stories) only implements what's listed here.
- **Step 10: Non-Functional Requirements** (`steps-c/step-10-nonfunctional.md`) — quality attributes. Selective — only categories that matter for this product.
- **Step 11: Document Polish** (`steps-c/step-11-polish.md`) — optimize for flow, coherence, duplication reduction. Must read `_bmad/bmm/workflows/2-plan-workflows/create-prd/data/prd-purpose.md` first (PRD philosophy: information density, traceability, dual-audience for humans + LLMs).
- **Step 12: Complete** (`steps-c/step-12-complete.md`) — workflow completion, status update, validation options, next steps.

For each step: follow the step-file architecture rules exactly. Read the full step file. Execute in sequence. Present A/P/C menu. Wait for my input. Only save and advance on C.

### KEY DECISIONS ALREADY MADE (DO NOT RE-LITIGATE)

1. **Approach C confirmed:** Factory Core as the Brain, source projects as libraries
2. **Internal tool first**, potential B2B later — no consumer onboarding concerns for MVP
3. **Two developers (Steve + co-dev Marcus)**, each running independent factory instances, shared state via git
4. **Pi SDK is the primary runtime.** Overstory runs inside Pi. Pi handles model selection natively (Opus 4.6, GLM-5). OpenRouter is optional fallback only, NOT required for MVP. The factory does NOT build a separate API gateway.
5. **ZeroClaw is React 19 + TypeScript + Vite 6 + Tailwind CSS 4.** NOT Vue. This was a critical correction — ZeroClaw fork is lowest-risk scaffolding, not highest-effort rewrite.
6. **MVP scope:** Full pipeline + multi-story parallelism + dashboard. NOT CLI-only. Straight to full MVP — no Phase 0.5.
7. **Composable pipeline architecture:** Factory is NOT a fixed 5-phase assembly line. It's a composable pipeline engine that assembles phases per work type. MVP ships Story + Task work types. Architecture supports all types (Spike, Review-Only, Audit) from day one.
8. **6-layer hook enforcement:** Runtime → Post-edit hooks → Post-task hooks → Phase boundary hooks → BMAD review → QA swarm. Hooks handle objective/binary checks. Overlay injection handles judgment-based process discipline.
9. **Factory Learning System (3 loops):** Loop 1 (session-level via mail), Loop 2 (story-level via Phase Boundary Protocol), Loop 3 (cross-session via .qds/learnings/ with manual synthesis for MVP, nightly cron for Growth).
10. **Dashboard is observation/interaction plane, NOT control plane.** Overstory is the agent lifecycle control plane. Dashboard crash doesn't halt agents.
11. **Economy models (GLM-5 via Pi SDK native routing)** for QA/review — quality pipeline costs ~$0.02/story.
12. **Cron self-healing loop is post-MVP (Growth).**
13. **Kanban, Metrics Dashboard, Brainstorm tentacle are post-MVP/Vision.**

### CRITICAL CORRECTIONS APPLIED IN SESSION 2

These corrections have ALREADY been applied throughout the PRD. Do not revert them:

1. **Pi SDK replaces OpenRouter as primary.** All references to "multi-provider API gateway" or "OpenRouter routing" have been replaced with Pi SDK native runtime. OpenRouter is optional fallback only.
2. **ZeroClaw is React, not Vue.** All Vue references removed. Migration path updated — ZeroClaw is lowest-effort scaffolding.
3. **Composable pipeline architecture added.** The factory handles multiple work types, not just stories.

### ADVANCED ELICITATION & PARTY MODE SESSIONS COMPLETED

The following enhancement rounds were run during Steps 4-7 and their findings are already incorporated into the PRD:

**Step 4 (Journeys) — Advanced Elicitation (5 methods):**
- Failure Mode Analysis: crash-safe learning, outcome-gated learning, confidence validation, scope precision, TTL/archival
- User Persona Focus Group (Priya — new hire): onboarding gaps, diagnostic assistance, stall classification, learning auditability
- Pre-mortem: Confident Liar, Context Bloat Death Spiral, Stale Expertise Trap, Learning Silo, Onboarding Cliff
- What-If Scenarios: contradictory learnings, failed story learnings, synthesis crash, massive epic, file contention, learning vs iron law
- Challenge from Critical Perspective: "Mulch with a cron job", "three loops over-engineered", "auto-injection dangerous", "vanity metrics", "building a second AI"

**Step 7 (Project-Type) — Party Mode (2 rounds):**
- Round 1 (Winston/Amelia/Mary): Superpowers enforcement model, overlay composition pipeline staging, ZeroClaw fork = shell + new pages, Mulch read path in integration map, `gh` CLI hard dependency, Phase Boundary Protocol highest risk
- Round 2 (Quinn/Bob/Sally): Coverage delta (Growth), hook results as PR evidence, `gh auth status` check, hook infrastructure is prerequisite story, Phase Boundary Protocol must include hooks from day one, hook results inline in xterm.js, phase boundary gate checklist in dashboard, hook-learning system reinforcement

### STEP 8 APPROVED DRAFT — APPEND THIS TO PRD

```markdown
## Project Scoping & Phased Development

### MVP Strategy & Philosophy

**MVP Approach:** Platform MVP — full pipeline depth over pipeline breadth. Ship one complete path (Story work type through all 5 phases to merged PR) with enough quality infrastructure that the factory output is trusted by human reviewers. Then expand work types and automation breadth.

**Key Strategic Decision:** Straight to full MVP — no Phase 0.5 CLI-only intermediate. The dashboard is part of MVP because the observation plane is what makes a multi-agent factory manageable (Journey 2: stall detection, nudge, inspect are dashboard-dependent).

**Resource Requirements:** 2 developers (Steve + co-dev), independent factory instances, shared state via git.

### Composable Pipeline Architecture

The factory is not a fixed 5-phase assembly line. It's a composable pipeline engine that assembles the right phases for the right work.

**Work Type Declarations:**

| Work Type | Phases Included | Typical Team Size | MVP? |
|---|---|---|---|
| **Story** | Develop → BMAD Review → Fix Loop → QA Swarm → PR | Full (coordinator + leads + builders + scouts) | Yes |
| **Task** | Develop → PR (optional: lightweight BMAD) | Minimal (lead + builder) | Yes |
| **Spike / Explore** | Develop only (no PR, output = learnings document) | Minimal (lead + scout) | Growth |
| **Review-Only** | BMAD Review + QA Swarm on existing code/PR | Review team only | Growth |
| **Audit** | QA Swarm only (deep pass on specified scope) | Scout swarm only | Growth |

**Pipeline Composition Engine:** Factory Core reads the work type declaration and assembles the pipeline — which phases activate, which agents spawn, what budget applies, what evidence is required. The Overstory coordinator adapts team size and composition based on work type, not a hardcoded agent manifest.

**MVP ships Story + Task.** The architecture supports all work types from day one — adding Spike/Review-Only/Audit is configuration, not re-architecture.

### MVP Feature Set (Phase 1)

**Core User Journeys Supported:** J1 (Story through Factory), J2 (Error Recovery), J3 (Co-Dev Setup), J5 (Factory Learning — raw records + injection)

**Must-Have Capabilities:**

**Factory Core (The Brain):**
- Pipeline composition engine with work type declarations (Story + Task for MVP)
- Overlay composition pipeline: system prompt → Superpowers → Mulch → Learnings → manifest → task (per-stage token budgets)
- Pi SDK integration for model tier directives (Opus 4.6 for builders, GLM-5 for scouts/reviewers)
- Budget tracking per story with phase-level allocation and circuit breakers
- Worktree lifecycle management (creation, isolation, cleanup)
- Git safety enforcement (branch naming, never force-push, commit attribution)

**Agent Orchestration (via Overstory):**
- Multi-story parallel execution with dependency detection
- Agent lifecycle: spawn, monitor, stop, replace
- Mail system for inter-agent communication (including `learning_report` type)
- Checkpoint/resume for long-running stories
- Coordinator auto-recovery on agent stop

**Quality Pipeline:**
- 5-phase pipeline: Develop → BMAD Review → Fix Loop → QA Swarm → PR
- Phase Boundary Protocol with structured transfer manifests, context budget tracking, learnings section
- Fresh agent spin-up at phase boundaries (context isolation guarantee)
- Fix-loop circuit breaker (max iterations before escalation)
- BMAD spec review with finding categorization (critical/warning/info)
- QA swarm with configurable wave count, parallel scouts on economy models

**6-Layer Hook Enforcement:**
- Layer 1: Runtime filesystem restrictions
- Layer 2: Post-edit hooks (file-pair checker, lint, format)
- Layer 3: Post-task hooks (test runner, type checker)
- Layer 4: Phase boundary hooks (manifest validator, scope validator, build check)
- Layer 5: BMAD review (judgment-based spec compliance)
- Layer 6: QA swarm (adversarial edge-case hunting)
- Gate-runner scripts for 5 existing Superpowers enforcement gates

**Dashboard (Observation + Interaction Plane):**
- Factory Overview: system health, active stories, API key status, token budget
- Agent Windows: real-time xterm.js output per agent, status indicators
- Story Pipeline: phase progression visualization, phase boundary gate checklist
- Stop/Nudge/Inspect controls per agent
- Nudge-via-mail mechanism
- Cost tracking with model tier breakdown
- Hook results inline in agent output
- Stall detection with visual indicators (time-on-task, no-output detection)

**Factory Learning System (MVP subset):**
- Loop 1: Session-level learning reports via Overstory mail
- Loop 2: Learnings section in Phase Boundary Protocol transfers
- Loop 3: Raw structured learning records to `.qds/learnings/YYYY-MM-DD/` on agent termination
- Overlay injection from `synthesized/` directory (if exists — manual synthesis initially)
- Crash-safe atomic writes for learning records
- Outcome-gated recording (learnings tagged with story pass/fail status)

**Developer Operations:**
- Setup/install script with dependency verification (Bun, Rust, `gh` CLI auth)
- `config/factory.yaml` for per-developer configuration (API keys, model preferences, budget ceilings)
- Independent dashboard instances per developer
- Mulch shared via git (`.mulch/` committed), raw learnings shared via git, synthesized/ local only
- Structured PR evidence template (Development Summary, BMAD Findings, QA Results, cost/model attribution, factory instance ID)

**Superpowers Integration:**
- All skills injected into agent overlays (agent self-policing for judgment-based rules)
- Extended YAML frontmatter with `enforcement` metadata for hook scripts (machine validation)
- `skills-core.js` extended to extract enforcement fields

### Post-MVP Features (Phase 2: Growth)

**Extended Work Types:**
- Spike/Explore work type (output = learnings doc, no PR)
- Review-Only work type (BMAD + QA on existing code)
- Audit work type (deep QA pass on specified scope)

**Advanced Learning System:**
- Nightly synthesis cron job (reads day's learnings, groups by theme, deduplicates, weighs by frequency/impact)
- Confidence scoring and token-waste tracking
- Learning effectiveness tracking (did injected learnings reduce similar failures?)
- Automatic expiry detection for stale learnings
- claude-mem integration for cross-session human developer context

**Cron Self-Healing Tentacle:**
- Automated monitoring of factory health
- Self-healing loops (detect degradation → diagnose → fix → verify)
- Daily cron budget ceiling
- Blast radius limits on automated fixes
- Regression chain detection

**Enhanced Dashboard:**
- Kanban board for story/task workflow visualization
- Metrics dashboard (throughput, cost trends, quality scores, Factory Intelligence Score)
- Coverage delta tracking (before/after factory run)
- Learning system tab (browse learnings, see injection history, audit trail)
- Stall classification and diagnostic assistance

**Operational Improvements:**
- `gh` API rate limit tracking during large epics
- Configurable merge policies (auto-merge when evidence meets threshold)
- PR Monitor tentacle (watch for human review comments, create follow-up Seeds issues)
- Custom Superpowers gate definitions per project
- Gate effectiveness metrics

### Vision Features (Phase 3: Expansion)

- Brainstorming tentacle (AI-assisted story spec generation)
- Multi-developer coordination (shared factory state beyond git)
- Factory Intelligence Score dashboard with trend analysis
- Plugin architecture for custom work types and pipeline stages
- B2B potential: multi-tenant factory management
- Cross-project learning transfer
- Automatic Mulch expertise updates from factory observations

### Risk Mitigation Strategy

**Technical Risks:**
- *Phase Boundary Protocol is greenfield, highest design risk* → Prototype and validate with a single story end-to-end before building dashboard. Test context isolation guarantee with adversarial scenarios.
- *Overlay composition may exceed token budgets* → Per-stage token budgets with hard caps. Progressive disclosure pattern from claude-mem. Fail-safe: truncate learnings (lowest priority) first, never truncate Superpowers.
- *Hook enforcement may slow agent throughput* → Benchmark hook execution time. Budget 2s max per hook point. Async where possible (post-edit hooks don't block next edit).

**Resource Risks:**
- *2 developers, ambitious scope* → Critical path (Pi → Overstory → Hooks → Phase Boundary → Superpowers) on Developer A. Parallel track (Dashboard → Mulch → Learning) on Developer B. Integration point is well-defined.
- *If behind schedule* → Task work type can ship without full hook enforcement. Dashboard can launch with Factory Overview + Agent Windows only (defer Story Pipeline visualization).

**Data Integrity Risks:**
- *Learning records lost on crash* → Atomic writes (write to temp, rename). Outcome-gated recording prevents garbage learnings.
- *Mulch conflicts between developers* → Standard git merge. `.mulch/` is append-mostly, conflicts are rare. When they occur, both entries are kept (human resolves semantic duplicates).
```

### WHAT "ACROSS THE FINISH LINE" MEANS

1. Save Step 8 (above) → PRD
2. Execute Step 9 (Functional Requirements) — full rigor, 20-50 FRs organized by capability area, implementation-agnostic, covering EVERYTHING in the PRD
3. Execute Step 10 (Non-Functional Requirements) — selective, measurable, specific to this product
4. Execute Step 11 (Document Polish) — read `prd-purpose.md` first, optimize for information density, flow, coherence, duplication, dual-audience
5. Execute Step 12 (Complete) — workflow completion, status update, validation options, next steps

Each step: follow the step file exactly. Present A/P/C menu. Wait for my input. Full enterprise-grade rigor. No shortcuts. Don't get lazy. Let's finish this.

### ELICITATION METHODS USED ACROSS SESSIONS (for context if A or P is selected)

**Session 1 (15 methods across 3 rounds):**
Round 1 (Classification): Pre-mortem, ADR, What-If Scenarios, First Principles, Red Team vs Blue Team
Round 2 (Differentiators 1+2): User Persona Focus Group, Shark Tank, Reverse Engineering, 5 Whys, Challenge from Critical Perspective
Round 3 (Executive Summary): Pre-mortem, Stakeholder Round Table, Comparative Analysis Matrix, Occam's Razor, Challenge from Critical Perspective

**Session 2 (5 methods + 2 party mode rounds):**
Round 4 (Step 4 Journeys): Failure Mode Analysis, User Persona Focus Group, Pre-mortem, What-If Scenarios, Challenge from Critical Perspective
Party Mode Round 1 (Step 7): Winston (Architect), Amelia (Developer), Mary (Analyst)
Party Mode Round 2 (Step 7): Quinn (QA), Bob (Scrum Master), Sally (UX Designer)

2 Party Mode sessions completed. Advanced Elicitation available for Steps 9-10 if desired.

### SOURCE PROJECT CODEBASE EXPLORATIONS COMPLETED

Deep exploration subagents have already confirmed:
- **Overstory:** Agent orchestration, mail system (SQLite), Mulch, Seeds, overlay.ts, checkpoint
- **Superpowers:** 15 skills total, 5 with enforcement (4 iron laws + 1 hard gate), all natural language markdown, `skills-core.js` handles frontmatter extraction
- **ZeroClaw:** React 19 + TypeScript + Vite 6 + Tailwind CSS 4. Pages: Dashboard.tsx, Cron.tsx, Config.tsx, Tools.tsx, Devices.tsx, Logs.tsx. Components: layout/Sidebar.tsx, layout/Header.tsx. SSE/WebSocket patterns present. NO Vue files anywhere.
- **Pi:** Model-agnostic runtime with native model switching
- **claude-mem:** Progressive disclosure, token economics, session summaries, hybrid search, hooks, content deduplication

Do NOT re-explore these unless something specific is needed for Step 9-12 work.
