> **v3.0** — Session 9 amendments applied 2026-03-14. Built on v2.0 (consolidated 2026-03-10).
>
> **Session 9 Amendment Domains Applied:**
> 1. Security — STRIDE Threat Model Response (5 modified NFRs, 10 new security NFRs, 2 modified FRs)
> 2. Technical Risk Resolution — Pi SDK, economy-tier, integration contracts, cost model (9 amendments)
> 3. Factory Learning System & Meta-Optimization — acceptance criteria and algorithm specifications (10 amendments)
> 4. NFR Cluster — conflict & feasibility analysis, acceptance criteria (11 amendments)
> 5. FR Infrastructure & Decomposition Readiness — dependency graph, sprint 0 prerequisites (14 amendments)
> 6. Competitive Landscape & Go/No-Go Process — competitive matrix, appendix C (9 amendments)

---
stepsCompleted:
  - step-01-init
  - step-02-discovery
  - step-02b-vision
  - step-02c-executive-summary
  - step-03-success
  - step-04-journeys
  - step-05-domain
  - step-06-innovation
  - step-07-project-type
  - step-08-scoping
  - step-09-functional
  - step-10-nonfunctional
  - step-11-polish
inputDocuments:
  - "user-provided-inline: QDS Engineer v2 comprehensive vision document (Octopus Model architecture, 4 tentacles, memory layer, skills layer, dashboard specs, runtime design, file structure, configuration, implementation sequencing, verification plan)"
workflowType: 'prd'
documentCounts:
  briefs: 0
  research: 0
  brainstorming: 0
  projectDocs: 1
classification:
  projectType: "AI Workforce Management Platform (Agent Orchestration + Coordination Layer over External Runtimes)"
  domain: "Software Development Automation with Pi SDK as Model-Agnostic Runtime"
  complexity: "high"
  complexityVectors:
    technical: "Polyglot integration (Rust, TS/Bun, React, Python), distributed SQLite coordination, real-time streaming"
    operational: "Resource contention management (API keys, sessions, worktrees, model slots), concurrency ceiling, cross-tentacle arbitration"
    organizational: "Virtual workforce with division of labor, quality control pipeline, institutional memory"
    economic: "Token budget enforcement, Pi SDK native model tier optimization, financial circuit breakers"
    security: "Credential pooling and rotation, process isolation, zero-trust agent boundaries"
    dataIntegrity: "Shared memory consistency, expertise versioning, conflict resolution"
  projectContext: "Systems Integration/Synthesis (5 OSS projects + v1 → unified platform)"
  architecturalCharacteristics:
    - "Coordination-over-external-runtimes (doesn't own execution)"
    - "Pi SDK as model-agnostic runtime with native model switching"
    - "Dashboard as mission-critical operational control plane"
    - "Phase boundaries as context isolation (non-negotiable)"
    - "Resource pool management as a cross-cutting concern"
  strategicApproach: "Approach C - Factory Core as FOUNDATION, Source Projects as Components"
  elicitationInsights:
    - "Pre-mortem: Rate limit cascade, context pollution, dashboard degradation identified as key failure modes"
    - "ADR: Coordination-over-external-runtimes as distinct architectural pattern"
    - "What-If: System needs cross-tentacle resource arbitration, Pi SDK native model routing"
    - "First Principles: AI Workforce Management Platform with organizational, economic, and operational complexity"
    - "Red Team: Security surface (credential management), economic risk (circuit breakers), data integrity (memory consistency) as underclassified concerns"
---

# Product Requirements Document - QDS-Engineer-New

**Author:** Steve
**Date:** 2026-03-02
**Version:** v3.0 (2026-03-14)

## Executive Summary

QDS Engineer v2 is a unified coding factory platform that accepts development stories or epics and produces production-ready, adversarially-reviewed, evidence-backed pull requests with minimal human intervention. It synthesizes five proven open-source projects — Overstory (agent orchestration), Superpowers (quality gates), ZeroClaw (scheduling and dashboard), Pi (model-agnostic runtime with native model switching), and claude-mem (persistent memory) — into a single platform governed by a new Factory Core brain that manages resources, economics, context management, and cross-system arbitration. Overstory runs inside Pi, which serves as the model-agnostic runtime — Pi handles model selection natively (Opus 4.6, GLM-5, and others) without requiring a separate API gateway layer. Source projects are consumed as components; the Factory Core owns all cross-cutting concerns as the foundation layer.

The core development pipeline accepts stories, decomposes them into scoped agent tasks, builds code via TDD-enforced agent swarms, runs mandatory adversarial review with context-isolated fresh agents, executes 5-wave QA, and ships evidence-backed PRs. The platform operates on an Octopus Model architecture: a central nervous system (Factory Core + Dashboard) connects independent tentacles handling development pipelines, scheduled operations, brainstorming and planning, and PR monitoring. The tentacles form a closed loop — scheduled cron agents continuously scan the codebase (OWASP security scans, dependency audits for known CVEs, performance regression tests against Mulch baselines, dead code detection, code quality drift analysis), surface discovered issues to the central tracker (Seeds), and dispatch fixes through the same mandatory quality pipeline. The next cron cycle verifies fixes landed correctly, creating a continuous verification loop.

MVP users are the internal development team (Steve + co-dev Marcus). Target users for Growth and Vision phases span three personas: solo indie developers seeking cost-optimized AI coding with built-in quality assurance and nightly scans that work while they sleep, startup CTOs managing multi-repo development who need rate limit prevention, pipeline throughput, and CI-integrated self-healing, and agency leads running parallel client projects requiring per-client cost attribution, project-level cron isolation, and configurable merge policies (auto-merge for internal, human-required for client-facing).

The platform replaces three separate tool categories — agent orchestration framework, code review toolchain, and QA automation — and adds capabilities no competitor offers: continuous self-healing, scheduled operations, 5-layer context management, and model-agnostic cost optimization. Pi SDK's native model switching enables intelligent tier routing (economy-tier GLM-5 for review and QA, standard-tier Sonnet for building, premium-tier Opus 4.6 for architecture) without requiring a separate API gateway — making the mandatory quality pipeline economically negligible at ~3-5% of development cost. No existing tool offers the complete closed-loop architecture — context-isolated adversarial quality pipeline, factory-wide learning system that compounds with every story, and 5-layer context management composed as a unified platform. The closest competitor (Cursor) scores 4.0 of 8 dimensions on a quality-weighted matrix, concentrated in the most visible capabilities (orchestration, generation, QA) while structurally unable to adopt Phase Boundary Protocol's context isolation or a data-flywheel learning system. QDS MVP integrates 6 of 8 dimensions; the full closed loop (all 8, including self-healing and scheduled operations) completes at Growth. MVP delivers the core closed loop across 6 dimensions (D1 agent orchestration, D2 adversarial quality pipeline, D3 QA automation, D6 5-layer context management, D7 model-agnostic cost optimization, D8 Factory Learning System). The two remaining dimensions — D4 continuous self-healing and D5 scheduled operations — are Growth-phase features; together they complete the full 8-dimension closed loop at Growth. A conversational AI copilot built on CopilotKit and AG-UI provides natural language access to the entire dashboard — developers can query status, investigate issues across multiple data sources, and execute controls through conversation, making the dashboard's full power accessible without memorizing navigation paths.

### What Makes This Special

**Adversarial quality pipeline as cost prevention.** Every story passes through mandatory BMAD adversarial review and 5-wave QA with context-isolated fresh agents. Context isolation is non-negotiable — development agents never share context with review agents, eliminating the sunk-cost bias that makes self-review worthless. Running on GLM-5 economy tier, the entire quality pipeline costs under $0.02 per story. Review profiles are configurable per project (security-focused, API-contract-focused, performance-focused), and every PR carries evidence artifacts proving what was found, tested, and fixed with trackable ROI.

**Closed-loop self-healing with defense in depth.** Nightly and recurring cron agents act as the factory's immune system — continuously scanning, discovering issues, and dispatching fixes through the standard quality pipeline. Safety comes from layered verification: inline BMAD + QA, independent CI pipelines the AI doesn't control, next-cycle cron re-verification within 24 hours, fix-loop circuit breakers with human escalation after 2 rounds, blast radius limits requiring human review for large changes, and full dashboard observability of all cron-initiated changes. Human-initiated work always preempts cron work, with a daily cron budget ceiling preventing resource exhaustion. Merge policy is configurable per project — the system provides confidence through defense in depth, not certainty through infallibility.

**Factory Core resource brain as scaling prerequisite.** Single-key API architecture is a throughput ceiling that turns a factory into a workshop. The Factory Core manages API key configuration for Pi SDK, token budgets with cost circuit breakers, model tier directives (telling Pi which tier to use per agent role), and cross-tentacle resource arbitration. Pi SDK handles model selection and provider routing natively — Factory Core's responsibility is economic governance (budgets, circuit breakers, tier policy), not API call execution. The economic outcome of this architecture is the differentiator: mandatory adversarial review and 5-wave QA cost approximately $0.02 per story — making the full quality pipeline economically negligible at ~3–5% of development cost. Model-agnostic routing is the infrastructure that enables this outcome, not a competitive claim in itself. MVP delivers Pi SDK integration with tier-based routing; post-MVP delivers advanced key rotation, health monitoring, and OpenRouter as an optional fallback for models Pi doesn't natively support.

**5-layer context management harness.** Context rot is the silent killer of AI agent productivity. The platform composes the best patterns from each source project: process isolation per agent (Overstory), behavioral gates and iron laws (Superpowers), pre-compaction fact extraction and time decay (ZeroClaw), progressive disclosure with hybrid search and session summaries (claude-mem). Phase Boundary Protocol transfers structured manifests between phases — not raw context. Seeds expands to become the factory-wide universal task graph. Mulch expertise gains timestamps, provenance, content deduplication, and category-based boosting.

**Core insight:** AI agents produce negative value without independent quality verification, fresh context windows, and continuous self-correction. The factory's purpose is not to generate code faster — it is to generate production-quality code faster and to continuously verify and self-correct.

**Conversational control plane.** The dashboard includes an AI copilot chat bar (CopilotKit + AG-UI) that has full programmatic control of the dashboard. Developers can ask questions ("what's wrong with Story 3?"), request investigations (copilot navigates the UI, correlates data from multiple sources, presents synthesized findings), and execute actions ("nudge Builder-03 with the correct module name") — all through natural language. The copilot acts through the UI, not around it: every action is performed by programmatically triggering the same controls the developer would click, ensuring all safety constraints are enforced. Running on economy-tier models, the copilot is an expert power multiplier and an onboarding accelerator.

## Project Classification

- **Project Type:** AI Workforce Management Platform — agent orchestration and coordination layer over external runtimes
- **Domain:** Software Development Automation with Pi SDK as model-agnostic runtime
- **Complexity:** High — across technical (polyglot: Rust, TS/Bun, React, Python; distributed SQLite coordination), operational (resource contention, concurrency ceiling, cross-tentacle arbitration, continuous cron verification), and organizational (virtual workforce with quality control pipeline, institutional memory, configurable merge governance) dimensions
- **Project Context:** Systems integration/synthesis — five OSS projects plus v1 codebase unified into a new platform
- **Strategic Approach:** Approach C — Factory Core as FOUNDATION, source projects as components

### Component Relationship Model (Session 8 Reframing)

**Factory Core** is the FOUNDATION. It owns the story/epic-level pipeline engine, phase boundaries, economic governance, the self-learning system, and overlay composition. Everything described in FR130-FR171 lives inside Factory Core.

**Overstory** is a COMPONENT. Factory Core calls into Overstory for agent spawning, worktree isolation, 4-tier merge cascade, inter-agent mail, session tracking, and watchdog. Overstory is an existing, proven system that Factory Core orchestrates.

**Pi SDK** is a COMPONENT. Factory Core configures Pi SDK for model-agnostic LLM runtime, tool execution, and per-call cost/token tracking across 18+ providers. Pi handles model selection; Factory Core handles economic governance.

**Superpowers** is a COMPONENT. Factory Core reads skill metadata from Superpowers' read-only configuration for overlay composition and hook enforcement gate definitions.

**Seeds** is a COMPONENT (inside Overstory). Factory Core creates Seeds tasks for each phase's work. Seeds provides task-level tracking.

**ZeroClaw** provides PATTERNS. Its SSE/WS client architecture is carried forward into the Gateway and Dashboard. It is not a runtime dependency.

**Research repositories** (PaperclipAI, GSD, DeerFlow, Symphony) are DESIGN INSPIRATION sources. They are not transplant sources, not dependencies, and not referenced at runtime. We study their patterns, take what fits, and build what is right for our stack. The term "transplant" is retired. All code in QDS v2 is new-write that may be inspired by patterns observed in these repositories.

### Self-Learning System Vision

The core innovation of QDS v2 is a **self-learning system** that makes the factory better at writing code for THIS codebase over time, with the explicit goal of reducing maintenance burden to near-zero.

**Goal 1 (Primary): Code quality improves over time.** Each session produces learnings about the target codebase. The next session's agents write better code, better tests, and cause fewer regressions.

**Goal 2 (Secondary): Harness efficiency improves.** The factory gets cheaper, faster, and lighter in overhead per story.

### Data Source of Truth

`pipeline.db` (SQLite) is the single source of truth for all mutable factory state: action scores, session composites, ELO ratings, tier assignments, budget tracking, task checkout locks, learning records, and performance data. YAML files in `.qds/` are read-only exports computed from the database for human inspection and git-based sharing. No component writes to YAML as a primary store.

`attribution.db` (SQLite) is the single source of truth for cost attribution data (FR42). Cost data flows: Pi SDK response -> attribution.db -> pipeline.db aggregates.

## Success Criteria

### User Success

- A developer (starting with Steve/internal team) can submit one or more stories and walk away. The factory develops, reviews, QA's, and PRs the work without manual intervention.
- The dashboard provides real-time visibility into all active agents, pipeline phases, and story progress — the user never wonders "what's happening?"
- Multiple stories from an epic run in parallel with proper isolation (separate worktrees, scoped file access, no cross-contamination).
- BMAD adversarial review catches real defects the development agents missed. The user sees evidence in the PR body proving what was found and fixed.
- The system uses economy-tier models (GLM-5 via Pi SDK native routing) for QA and review work, keeping per-story cost low enough that running the quality pipeline feels free.

### Business Success

- **3-month:** The internal team uses QDS v2 as the primary development workflow. Stories flow through the factory daily. Manual code review is replaced by BMAD. The system pays for itself in developer time saved.
- **12-month:** If the tool proves exceptional, evaluate B2B licensing to other engineering teams. Success indicator: another engineering team can set up the factory, configure it for their repos, and run stories without needing to understand the internals.
- **Key metric:** Stories shipped end-to-end without manual intervention. The number goes up, the defect rate in production goes down, and cost-per-story stays economical.

### Technical Success

- Single story flows through all 5 phases (Intake → Develop → BMAD Review → QA Swarm → Ship) without manual intervention.
- Multi-story parallelism works — 3+ stories running concurrently with proper resource arbitration from Factory Core.
- Factory Core resource brain manages model tier directives via Pi SDK, token budgets, and cost circuit breakers across all active stories.
- Dashboard displays real-time agent status, pipeline progress, and session metrics via SSE/WebSocket.
- Context isolation enforced at phase boundaries — fresh agents, structured transfer manifests, no context leakage.
- Model routing actively uses economy-tier models (GLM-5) for QA/review and standard/premium for development/architecture, with measurable cost savings.

### Measurable Outcomes

- End-to-end story completion without human intervention (pass/fail per story)
- BMAD defect catch rate (issues found per story that would have shipped without review)
- Cost-per-story broken down by phase and model tier
- Multi-story throughput (concurrent stories completing per day)
- Dashboard uptime and data freshness (SSE latency < 2s)

## Product Scope

Summary of what's in and out. See *Project Scoping & Phased Development* for detailed capability lists, composable pipeline architecture, and risk analysis.

### MVP

- Development Factory — full 5-phase pipeline (Story + Task work types) with multi-story parallelism
- Factory Core — Pi SDK integration, model tier directives, budget tracking, cost circuit breakers
- Dashboard — Factory Overview, Agent Windows (xterm.js), story pipeline visualization, nudge/stop/inspect
- Quality Pipeline — 6-layer hook enforcement, BMAD adversarial review, QA swarm, lightweight structural verification, Nyquist-BMAD disagreement protocol
- Context Management — Phase Boundary Protocol, overlay composition, Mulch priming, Seeds tracker, context budget 50% rule
- Factory Learning System — 3-loop learning (session, story, cross-session), synthesis, injection
- Self-Learning System — maintenance learning extraction, pattern knowledge accumulation, epic context management, overlay enrichment, maintenance burden tracking
- Agent Performance Data Collection — action scoring, confidence calibration, session composites, data export
- System Health — circuit breaker with subsystem monitoring, multi-channel notification (Telegram)
- Meta-Optimization — daily cron observer, weekly optimizer, auto-apply with safety net
- Developer Operations — setup script, per-developer config, independent instances
- PR-to-Seeds — auto-create Seeds issues from human PR comments

### Growth

- Cron self-healing loop (Tentacle 2) — scheduled scans, auto-fix, continuous verification
- Extended work types (Spike, Review-Only, Audit)
- Agent Performance Behavioral System — ELO ratings, capability tiers, tier-based hook density, weighted composite routing, performance dashboard cards
- Kanban board, metrics dashboard, learning audit view
- Advanced key rotation, configurable merge policies, dynamic tier escalation

### Vision

- Brainstorming & Planning tentacle, PR Monitor tentacle
- B2B packaging, multi-tenant configuration
- Factory Intelligence Score, cross-project learning transfer
- Mobile-responsive dashboard, keyboard shortcuts

## User Journeys

### Journey 1: Steve Runs an Epic Through the Factory (Primary - Success Path)

Steve has an epic with 4 stories for a new webhook retry system. He's already written the story specs during a brainstorming session using the factory's story spec template (a Superpowers convention that defines acceptance criteria, file scope, dependencies, and test expectations). It's Monday morning.

**Opening Scene:** Steve opens the QDS dashboard in his browser. The Factory Overview shows all systems green — Overstory connected, Pi runtime available, API keys healthy, token budget at $0 spent today. He clicks "New Session," selects the epic, confirms the 4 stories, and reviews the auto-detected dependencies (Story 2 depends on Story 1, Stories 3 and 4 are independent). The dependency detection flags a potential implicit dependency between Story 3 and Story 1 (shared config file) — Steve reviews it, determines it's a false positive, and clicks "Override: Independent." He hits "Start."

**Rising Action:** The dashboard comes alive. Three stories spin up simultaneously (Story 2 waits for Story 1). Agent Windows show 12 agents across 3 worktrees — coordinators, leads, builders, scouts. Steve watches Story 3's builder writing tests first (TDD enforced via Superpowers). The token ticker shows economy-tier models handling scout work while Sonnet drives the builders. He notices Story 1's lead is consuming tokens faster than expected — the Factory Core's budget bar shows 45% of Story 1's develop-phase allocation used at 60% task completion. The budget projection widget shows: "Projected phase cost: $1.82 (budget: $2.00). BMAD + QA phases projected: $0.04. Total story projected: $1.86 of $2.50 budget." Steve sees the projection accounts for all remaining phases — no surprise overruns.

**Climax:** Story 1 completes development. The dashboard shows a phase transition animation — dev agents fade out, fresh BMAD agents spin up with clean context indicators. The phase transition includes a manifest validation check — a green checkmark confirms the transfer manifest parsed correctly and all required sections are present. The BMAD spec reviewer finds that the retry backoff implementation doesn't match the spec's maximum retry count. It flags this as a critical finding. The coordinator spawns a Fix-Lead. Steve watches the fix happen in real-time — the Fix-Lead receives the BMAD finding via mail, corrects the retry count, and BMAD re-reviews. Pass. QA swarm launches — 4 parallel scouts on GLM-5, barely registering on the cost ticker. The QA stopping threshold is configured at "3 consecutive clean waves" — all 5 waves complete with waves 3-5 clean. PR created with full evidence: "BMAD found 1 critical spec violation (retry count), QA found 0 issues across 5 waves." The evidence body includes severity tiers — critical findings in the summary section, with an expandable detail section showing all BMAD observations.

**Resolution:** By afternoon, all 4 stories have PRs. Total cost: $4.82 across all stories (development phases dominated, quality pipeline was $0.07 total). Steve reviews the PRs — the evidence sections give him confidence. He merges. His co-dev pulls and the webhook retry system works. Steve spent 6 hours doing other work while the factory ran. The same workflow would scale to larger epics — Factory Core's batch scheduling (Growth feature) would handle 20+ stories via wave-based execution with resource-aware parallelism.

**Requirements revealed:** Story submission UI with story spec template guidance, dependency detection with manual override, real-time agent windows, phase transition visualization with manifest validation, budget tracking per story with phase-aware projection and proactive warnings, BMAD evidence in PRs with severity tiers, cost breakdown by phase and model tier, QA stopping threshold configuration.

### Journey 2: Steve Deals with a Factory Problem (Primary - Edge Case / Error Recovery)

It's Wednesday. Steve kicked off a complex story involving a database migration. Something isn't right.

**Opening Scene:** Steve glances at the dashboard 20 minutes after starting the story. The Agent Windows show the builder agent's status indicator classified as "Logic Loop" — the stall detection system has distinguished this from an "External Wait" (rate limit/API timeout) or "Resource Constraint" (memory/disk). The agent has been on the same task for 8 minutes with no file changes but high token consumption. The diagnostic summary reads: "Agent is repeatedly attempting to import `db-utils` (module not found). 4 import attempts, 0 file writes. Probable cause: hallucinated dependency."

**Rising Action:** Steve clicks "Inspect" on the stalled agent. The live xterm.js output confirms the diagnostic — the agent is looping on a nonexistent import. Steve clicks "Stop" on the agent. The coordinator detects the agent stopped and spawns a replacement builder — the dashboard shows "Recovery Attempt 1 of 3" with the escalation path visible (3 auto-recoveries before human escalation). But Steve realizes the issue is the story spec — it references a module that was renamed last week. The Mulch expertise is stale on this.

**Climax:** Steve clicks "Nudge" on the story lead with a message: "Module `db-utils` was renamed to `database-helpers` last sprint. Update references." The nudge is logged in the story record with timestamp and content for traceability. The lead receives the nudge via mail, corrects its understanding, and re-dispatches the builder. This time the builder finds the right module. Development completes. BMAD review passes. QA finds one edge case in the migration rollback logic — Wave 3 fixer handles it. PR ships.

**Resolution:** Steve makes a note to update the Mulch expertise for the database module rename. The factory recovered from a stall with two clicks (stop + nudge) and a one-line message. Total delay: 15 minutes. The stall type classification and diagnostic summary meant Steve didn't have to parse raw xterm output to understand what went wrong — the dashboard told him.

**Requirements revealed:** Agent stall detection with type classification (logic loop / external wait / resource constraint), diagnostic assistance summary ("Why stalled?" with probable cause), stop/nudge/inspect controls per agent, recovery attempt counter with visible escalation path (N of 3 before human escalation), nudge-via-mail mechanism with content logging and traceability in story record, live xterm.js output for debugging, Mulch expertise update workflow, coordinator auto-recovery on agent stop.

### Journey 3: Co-Dev Configures and Runs Their Own Instance (Operations / Setup)

Steve's co-dev Marcus is setting up QDS v2 on their machine for the first time.

**Opening Scene:** Marcus clones the QDS-Engineer-New repo and runs the setup script. It detects the source projects (Overstory, Superpowers, ZeroClaw, Pi, claude-mem), verifies dependencies (Bun, Rust toolchain for ZeroClaw cron), and performs version alignment verification — confirming Marcus's source project versions match Steve's to prevent subtle behavioral divergence. The script runs a resource pre-flight check: available RAM, CPU cores, and disk space vs estimated requirements for concurrent agent execution. Everything passes. It creates a default `config/factory.yaml`. Marcus opens the config and fills in their own API key for Pi SDK, preferred default model tier, and sets `learning_injection_level: all` (the default for experienced developers).

**Rising Action:** Marcus starts the dashboard (`bun run dev`). The Factory Overview shows their system — their API keys, their model routing config, zero active stories. They pick a story from the team's backlog (tracked in Seeds), review the story spec, and hit Start. Their machine, their agents, their dashboard. Steve's factory instance knows nothing about this — they're fully independent.

**Climax:** Marcus's factory runs the story through all 5 phases. They're watching their own Agent Windows, their own cost tracker. BMAD catches a naming convention violation (the co-dev used camelCase where the project uses snake_case — Mulch had recorded this convention from Steve's earlier sessions, shared via git in the `.mulch/` directory using append-only format to prevent merge conflicts). The fix-lead corrects it. PR created.

**Resolution:** Marcus pushes the PR. Steve reviews it — the BMAD evidence shows the convention violation was caught and fixed. Steve merges. Both developers are running independent factory instances against the same repo, each seeing their own work, each with their own API keys and budgets. The shared state is the git repo (code + `.mulch/` expertise + `.qds/learnings/` raw records + Seeds issue tracker). Runtime state is per-developer (agents, dashboard, API keys, budgets, synthesized learnings). Known limitation: if both developers submit stories touching the same files simultaneously, git merge conflicts are handled at PR merge time — for MVP, developers coordinate overlapping work via Seeds and standups rather than automated file-level locking.

**Requirements revealed:** Setup/install script with source project version alignment verification, resource pre-flight check (RAM, CPU, disk), factory.yaml configuration, per-developer API key config, per-developer learning injection level config, independent dashboard instances, Seeds as shared issue tracker across developers, `.mulch/` shared via git with append-only format to prevent merge conflicts, `.qds/learnings/` raw records shared via git, PR attribution (which developer's factory generated this), Seeds deduplication or claim-locking for cross-developer scenarios, documented file contention mitigation path.

### Journey 4: Steve Reviews a Factory-Generated PR (Reviewer)

Steve's co-dev Marcus's factory generated a PR overnight. Steve opens it in the morning.

**Opening Scene:** Steve opens the PR on GitHub. The body is structured with a summary section showing only critical/high-severity findings, followed by expandable sections for Development Summary, BMAD Review Findings (with severity tiers), QA Swarm Results, Coverage Analysis, and Files Changed — including model routing info, cost, duration, and factory instance attribution (generated by Marcus's factory).

**Rising Action:** Steve reads the code. The BMAD evidence tells him exactly what was caught and fixed — he doesn't need to hunt for issues the review might have missed. The QA section shows edge cases were found and verified. He checks the coverage analysis — 94% branch coverage (not just line coverage), with a "Not Tested" section listing files that were modified but fell outside QA wave scope, and edge cases explicitly marked as outside the QA boundary. This negative-space indicator tells Steve what the factory *didn't* verify — he focuses his human review there.

**Climax:** Steve spots something the factory missed — the rate limit config should use environment variables, not hardcoded values. He leaves a comment. The PR-to-Seeds integration creates a new Seeds issue automatically, tagged with the originating factory instance (Marcus's) and auto-assigned to Marcus's factory queue. Marcus's next factory session will pick this up as a follow-up story.

**Resolution:** Steve merges with confidence. The evidence section gave him 90% of the review context he needed. His comment became a tracked Seeds issue without manual overhead — the feedback loop from PR review to factory work queue is closed. Total review time: 5 minutes instead of the usual 30.

**Requirements revealed:** Structured PR body template with severity-tiered BMAD/QA evidence, summary section (critical findings only) with expandable detail, branch coverage reporting with coverage gap indicator ("Not Tested" section), cost and model attribution, factory instance identification (which developer generated it), clear findings-and-fixes narrative, PR comment → Seeds issue auto-creation mechanism, auto-assignment of PR-originated Seeds issues to originating factory instance, integration with existing PR review workflow.

### Journey 5: Steve's Factory Gets Smarter Over Time (Learning System - Cross-Session Intelligence)

Steve has been running the factory for two weeks. He notices something different about this Monday compared to the first Monday. This journey demonstrates the MVP learning system — manual synthesis, basic injection, and hard token ceilings. The full vision (automated nightly synthesis, Factory Intelligence Score, progressive onboarding) is described in the Future State epilogue.

**Opening Scene:** Steve kicks off a story involving the payment webhook module — the same module area that caused a stall two weeks ago (Journey 2). Back then, the builder hallucinated a dependency and Steve had to manually nudge the lead. This time, he watches the Agent Windows as the builder spins up. In its overlay, under "Relevant Factory Learnings," he sees two critical-tier learnings (always injected): *"Payment module: `db-utils` was renamed to `database-helpers` in sprint 12. Always use `database-helpers` for database access patterns. (Source: manual correction, confirmed by BMAD, last observed 3 days ago)"* and *"Payment/webhook modules require explicit Redis mock in `beforeAll`. Convention: use `test-helpers/redis-mock.ts`. (Source: 4 agent observations across 2 stories, all successful)."* One recommended-tier learning appears within the token budget: *"Payment API client uses retry-with-backoff wrapper from `src/utils/http-retry.ts`. (Source: 2 agents, 1 week ago)."* A note: "2 additional informational learnings available via query." The builder never hesitates on the Redis mock setup. The hard token ceiling kept injection to 380 tokens — well within the 500-token budget for economy-tier agents.

**Rising Action — Loop 1 (Session-Level):** During the build phase, the lead agent receives a `learning_report` mail from its builder: "Discovered that the webhook retry tests require a mock Redis instance — test framework doesn't auto-provision one. Resolved by adding `beforeAll` Redis mock setup. Tokens wasted before resolution: ~1,200." This is Loop 1 in action — real-time tactical learning within the same story. The lead uses this to advise the next builder in the same phase, which sets up the Redis mock immediately without wasting tokens on discovery. Meanwhile, the builder writes a structured learning record to `.qds/learnings/2026-03-16/agent-builder-03-payment.yaml` with fields: struggle (category, description, resolution, tokens_wasted), discovery, story_outcome (pending — updated to `success` or `failed_*` when the story completes), and provenance.

**Rising Action — Loop 2 (Story-Level):** The story progresses to BMAD review. The Phase Boundary Protocol transfer manifest includes a new `learnings` section carrying forward what the development phase struggled with: the Redis mock issue, a brief hesitation on the retry backoff configuration. The BMAD reviewer receives this in its context — it focuses extra scrutiny on the retry logic because it knows dev agents had uncertainty there. This is Loop 2: cross-phase intelligence within the same story. BMAD passes the retry logic (correctly implemented despite the initial hesitation) but catches an edge case in error message formatting that the dev agents' uncertainty didn't flag. The quality pipeline's value compounds — learnings from earlier phases sharpen later phases.

**Climax — Loop 3 (Cross-Session):** That evening, Steve runs the synthesis script manually: `bun run synthesize-learnings`. The script reads today's `.qds/learnings/2026-03-16/` directory — 23 learning records from 8 agents across 2 stories. It performs rule-based grouping by file scope, deduplicates records with identical struggle descriptions, and checks story outcomes — records from stories tagged `success` get full weight, records from stories tagged `failed_bmad` get reduced weight. It validates each candidate learning against active Superpowers gates — one learning suggesting a test shortcut is rejected because it conflicts with the iron law requiring balance assertion in payment tests. The rejection is logged: *"Learning rejected: conflicts with iron law 'payment-balance-assertion'."* The script detects one conflict: two records for `src/api/routes.ts` give contradictory guidance about error handling style. It flags this as unresolved and injects neither — Steve sees "1 Learning Conflict" in the output and resolves it by confirming the newer pattern. The script writes synthesized entries to `.qds/learnings/synthesized/` (which is in `.gitignore` — only raw records are committed and shared via git, preventing merge divergence between developers). Each synthesized learning carries a tier (critical/recommended/informational) and a provenance summary.

**Resolution — MVP State:** Tuesday morning. Steve starts a new story touching the payment system. The Factory Core's `overlay.ts` reads from `.qds/learnings/synthesized/`, matches learnings to the agent's file scope and role, ranks by tier and recency, and injects within the hard token ceiling. The builder starts with the Redis mock pattern, the correct module names, and the retry wrapper convention already in context. Zero tokens wasted re-discovering what the factory already learned last week.

**Future State Epilogue (Growth/Post-MVP):** In the full vision, the manual synthesis script is replaced by a nightly synthesis cron job with idempotent execution and checkpointing (`.qds/learnings/.synthesis-checkpoint` tracks progress, atomic writes via `.tmp` rename prevent corruption from crashes). The dashboard gains a Learning tab showing the Factory Intelligence Score — composed of measurable proxies: token waste per story trend (down 18% this week), first-attempt success rate (84%, up from 71% at launch), BMAD correction rate in scopes with active learnings vs without (23% fewer corrections). No counterfactual "tokens saved" claims — only directly measurable metrics. A Learning Audit view lets developers see all active learnings, their provenance, confidence, and tier — with controls to retract (cascading to source records), promote to Mulch (when a learning is confirmed as a permanent convention), or flag for review. BMAD contradiction detection automatically flags learnings when BMAD repeatedly corrects agents on a matching pattern. Progressive onboarding tiers let new developers start with `critical`-only injection and gradually increase as they build familiarity. The learning system operates strictly within the Superpowers safety boundary — iron laws always override learnings, with rejections logged and visible.

**Guardrails embedded in the learning system:**
- Crash-safe learning: records written incrementally during agent execution, not only on clean exit — crashes don't lose learning data
- Story-outcome tagging: every learning record carries the final story outcome; synthesis weights by outcome (success > failed_qa > failed_bmad > cancelled)
- Superpowers gate validation: learning injection pipeline validates against iron laws and hard gates before injection; conflicts are rejected and logged
- Hard token ceiling: 500 tokens for economy-tier agents, 1,000 for standard-tier; ranked by confidence × recency × relevance, truncated at ceiling
- Tiered injection: critical (always), recommended (if budget allows), informational (query-only, never auto-injected)
- Exploratory escape hatch: stories tagged `spike` or `exploratory` suppress learning injection — exploration should be unconstrained
- Synthesis conflict detection: contradictory learnings flagged for human resolution, neither injected until resolved
- Cascading retraction: retracting a synthesized learning propagates retraction tags to all source records, preventing resurrection on next synthesis
- Raw records shared via git, synthesized/ local only: prevents merge divergence between developers

**Hard boundary — Mulch vs Factory Learnings:**
- **Mulch:** Human-curated conventions and domain expertise ("what are the rules"). Written by developers, read by agents via `ml prime`.
- **Factory Learnings:** Agent-generated operational knowledge ("what are the gotchas"). Written automatically by agents on every exit, synthesized into actionable guidance, auto-injected into overlays.
- **Decision rule:** If a human would write it as a project convention → Mulch. If an agent discovered it through struggle → Factory Learning. If a Factory Learning is confirmed by humans as a permanent convention → promote to Mulch, retire the learning.
- **Promotion pathway (Post-MVP):** Learnings active for N days with high confidence and zero retractions surface as "Promotion Candidates" in the dashboard. Human confirms → becomes Mulch entry, learning retired. Prevents redundant overlap between the two systems.

**Requirements revealed:**

*MVP:*
- Structured learning record format (YAML on agent exit, crash-safe incremental writes, story-outcome tagging)
- `learning_report` mail type in Overstory (Loop 1 — real-time tactical learning)
- `learnings` section in Phase Boundary Protocol transfer manifests (Loop 2 — cross-phase intelligence)
- `.qds/learnings/` directory structure with date partitioning
- Manual synthesis script (rule-based grouping by file scope, deduplication, outcome weighting, Superpowers gate validation, conflict flagging)
- `.qds/learnings/synthesized/` in `.gitignore` — raw records shared via git, synthesized local only
- `overlay.ts` learning injection with hard token ceiling (500/1000 tokens), tiered injection (critical/recommended/informational), file-scope + role matching
- Superpowers gate validation in injection pipeline (iron laws always win)
- Synthesis conflict detection with flag-for-human-resolution
- Cascading retraction mechanism (manual trigger)
- Exploratory/spike escape hatch (suppress injection)
- Per-developer `learning_injection_level` config

*Post-MVP (Growth):*
- Nightly synthesis cron job with idempotent execution, checkpointing, atomic writes
- Outcome-coupled confidence scoring (QA pass rate, BMAD correction rate)
- BMAD contradiction auto-detection (flag learnings when BMAD repeatedly corrects matching patterns)
- Factory Intelligence Score dashboard (token waste trend, first-attempt success rate, BMAD correction rate — no counterfactual claims)
- Learning Audit view (active learnings, provenance, tier, retract/promote/flag controls)
- Synthesis health monitoring in dashboard (last run, records processed, pending)
- Progressive onboarding tiers (critical-only → recommended → all)
- Learning-to-Mulch promotion workflow
- Conditional learnings for branch-specific or context-dependent patterns
- Epic pre-flight resource analysis and batch scheduling for 20+ story epics

### Journey-to-FR Traceability

- **J1 (Story through Factory):** FR1-FR9, FR36-FR38, FR42-FR49, FR51-FR53
- **J2 (Error Recovery):** FR22, FR25-FR27, FR47, FR93-FR94
- **J3 (Co-Dev Setup):** FR64-FR72
- **J4 (PR Review):** FR8, FR52-FR53, FR72, FR90
- **J5 (Factory Learning):** FR55-FR63

**Key architectural insight:** Two-developer model means shared state = git repo (code + `.mulch/` + `.qds/learnings/` raw records + Seeds), runtime state = per-developer-instance (agents, dashboard, API keys, budgets, synthesized learnings). Foundation for eventual multi-developer coordination.

**Potential additional journey identified:** "New Developer Onboards to a Mature Factory" — covering cognitive onboarding to an established factory with accumulated learnings, Mulch expertise, and Seeds history. Distinct from Journey 3 (infrastructure setup) and Journey 5 (experienced user). Deferred to later step or future PRD revision.

## Domain-Specific Requirements

The QDS Engineer v2 domain — AI Workforce Management with Pi SDK as model-agnostic runtime — does not map to a regulated industry (no HIPAA, PCI-DSS, FedRAMP). However, the domain imposes hard constraints that shape the platform in ways generic software requirements do not capture. These constraints arise from the factory being an autonomous actor that operates on codebases, consumes paid external model APIs via Pi SDK, and coordinates multiple concurrent processes against shared state.

### AI Agent Execution Constraints

**Terminology note:** "Phase Boundary Protocol" refers to the structured manifest transfer mechanism between pipeline phases (what data crosses the boundary). "Phase boundary hooks" refers to the mechanical gate checks (tests, build, lint, type check, manifest validation) that fire at the boundary before transition is allowed. These are complementary but distinct systems.

**Context Budget Model.** Every agent operates within a finite context window. The factory's overlay system (Superpowers skills, Mulch priming, Factory Learnings injection, Phase Boundary Protocol manifests, task instructions) consumes context before the agent begins reasoning. Factory Core's `overlay.ts` is the single point of context budget enforcement — it assembles the complete overlay, calculates total token count, and validates that remaining context is sufficient for the assigned file scope. If projected overhead plus estimated task tokens exceed the model's effective context limit, the task is split into smaller scopes or the agent is promoted to a higher-tier model with a larger effective window. No agent launches without a passing context budget check.

**Model Tier Directives via Pi SDK.** Agents request a capability tier (economy/standard/premium), not a specific model. Factory Core translates tier + agent role into a model directive that Pi SDK executes. Pi SDK handles model selection natively — it supports Opus 4.6, GLM-5, and other models without requiring a separate routing layer. Factory Core's responsibility is policy ("QA agents use economy tier, builders use standard tier, architects use premium tier"), not execution. Pi SDK handles all provider-specific concerns: prompt formatting, output parsing, rate limit behavior. If no economy model supports an agent's required capabilities (e.g., tool use), Factory Core escalates the tier directive to standard. Agents are model-agnostic — they never know or care which model they're talking to.

**Rate Limit Handling.** Pi SDK handles rate limit responses natively (backoff, retry). Factory Core's role is higher-level: if Pi reports sustained throttling, Factory Core delays new agent spawns and adjusts concurrency limits to reduce pressure. No cross-story prioritization for MVP — with 2-3 concurrent stories and Pi's native key management, key pool exhaustion is unlikely. Growth: Factory Core adds priority-based arbitration when story count exceeds capacity, with configurable policies (FIFO, economic priority, or equal degradation). OpenRouter available as optional fallback provider for models Pi doesn't natively support.

**Agent Isolation Model.** Process-level isolation with filesystem scoping. Each agent operates as a separate process in an assigned worktree with read/write restricted to its file scope. Inter-agent communication exclusively via Overstory mail (SQLite) — no shared memory, no direct inter-process communication. Agents run inside Pi SDK — Pi mediates all model API access. Agents never hold API keys directly. This isolation level prevents accidental cross-contamination (context leakage, file conflicts, credential exposure) without the operational overhead of containerization. Post-MVP: evaluate container-based isolation if the threat model changes (e.g., B2B deployment where agents process untrusted code).

### Model Runtime & API Management

**Pi SDK as Primary Runtime.** Overstory runs inside Pi SDK. Pi is the model-agnostic runtime that handles model selection, provider communication, and native switching between models (Opus 4.6, GLM-5, and others). The factory does not build a separate API gateway layer — Pi IS the gateway. Factory Core's relationship to Pi is policy-driven: Factory Core configures Pi with API keys and tier directives, Pi executes model calls. This eliminates an entire layer of complexity (unified error model, provider abstraction, failover logic) that the factory would otherwise need to build — Pi handles it natively.

**Credential Security.** API credentials are stored in `factory.yaml` (per-developer, local, `.gitignore`d) and provided to Pi SDK at startup. No agent, learning record, log entry, PR evidence section, dashboard output, or committed file may contain API keys. Pi SDK mediates all model API access — agents interact with Pi, never with providers directly. This is a non-negotiable security boundary.

**OpenRouter as Optional Fallback.** OpenRouter is not required for MVP. Pi SDK natively supports the models the factory needs (Opus 4.6 for premium, GLM-5 for economy). OpenRouter becomes relevant only if: (a) a future model is needed that Pi doesn't natively support, or (b) Anthropic's Agent SDK is used directly for specific capabilities and GLM-5 access is still needed alongside it. Growth: Factory Core can configure OpenRouter as a secondary provider in Pi's routing config for expanded model access.

**Cost Attribution Chain.** Every model API call — whether routed through Pi's native models or optional OpenRouter fallback — carries a full attribution chain: `developer_id → story_id → phase → agent_id → model → provider → token_count → cost`. Pi SDK provides token usage and cost data per call. Factory Core logs every attribution record to the session database. This chain is the foundation for: per-story cost tracking in the dashboard, per-phase cost breakdown in PR evidence, budget enforcement and circuit breaker triggers, model tier effectiveness analysis, and cross-developer cost visibility. No API call may be made without a complete attribution chain.

### Development Workflow Integrity

**Git Safety Iron Laws.** The factory is a git actor operating at higher volume and lower visibility than a human developer. Git safety rules are non-negotiable iron laws enforced at the Factory Core level:

1. **Never force-push** to any branch. No exceptions. No flags to override.
2. **Never commit directly** to main, master, or any protected branch. All factory work happens on dedicated branches.
3. **Factory branch naming convention:** `qds/<developer-id>/<story-id>` (e.g., `qds/steve/WH-042`). Factory-created branches are always identifiable and never collide with human-created branches.
4. **Worktree lifecycle management:** Worktree created at story start, cleaned up at story end — including failed, cancelled, and circuit-broken stories. Orphaned worktrees are detected and cleaned up on factory startup.
5. **Commit attribution:** All factory commits carry a structured prefix: `[QDS:<story-id>:<phase>] <message>`. Every commit is traceable to a story and phase.
6. **Hands off git config:** Factory never modifies `.gitconfig`, never changes remotes, never deletes branches it didn't create, never modifies `.gitignore` (except adding factory-specific entries during setup).

**CI Pipeline Integration.** MVP: observe-only. The factory creates PRs; CI pipelines run independently; the developer observes CI results during human review. The factory does not assume its QA pipeline replaces CI — they are independent verification layers. Factory QA validates code logic and quality; CI validates environment, dependencies, and integration. Growth: the cron self-healing loop monitors CI results on factory PRs and can dispatch fixes for CI-specific failures (environment issues, flaky tests, dependency conflicts) through the standard quality pipeline.

### Operational Safety

**Runtime Resource Monitoring.** The factory runs on the developer's machine and can exhaust local resources. Factory Core monitors runtime resource consumption via lightweight periodic polling (not continuous monitoring — avoiding overhead):

- **Disk:** Worktree sizes + `.qds/learnings/` + Overstory SQLite + logs. Warning at 80% of available disk. Hard limit: halt new story starts when disk is critical.
- **Memory:** Active agent count × estimated per-agent footprint. Warning when projected memory exceeds 80% of available RAM. Hard limit: halt new agent spawns (never kill running agents — that loses work).
- **Token spend:** Per-story budget tracking (existing circuit breaker) plus daily global budget ceiling. Per-story exhaustion halts that story; global exhaustion pauses all non-critical work.

**Graceful Degradation Matrix.** The factory's failure response is proportional to the failure scope:

| Failure | Response | Rationale |
|---|---|---|
| Single agent crash | Coordinator spawns replacement (max 3 attempts, then human escalation) | Isolated failure, no systemic risk |
| All agents in one story crash | Story fails, other stories continue unaffected | Story-scoped failure, no cross-contamination |
| API provider fully down | All stories stall, dashboard shows provider status, auto-resume when provider returns | External dependency, nothing to fix locally |
| Disk full | Halt new story starts, running stories continue until they need to write, then stall | Preserve in-flight work, prevent corruption |
| Per-story token budget exhausted | Story halts at current phase, developer decides: increase budget or cancel | Economic guardrail, human decision required |
| Daily global budget exhausted | All non-critical work pauses, developer notified | Economic guardrail, prevents runaway spend |
| Dashboard process crashes | Agents continue running — developer restarts dashboard to reconnect | Dashboard is observation plane, not execution dependency |

**Dashboard as Observation and Interaction Plane.** The dashboard is mission-critical for human visibility and intervention (nudge, stop, inspect). However, agents do not depend on the dashboard for execution. Overstory is the agent lifecycle control plane — it owns agent state, process management, and coordination via SQLite. The dashboard reads Overstory state via SSE and sends commands via WebSocket, but those commands are executed by Overstory, not by the dashboard. If the dashboard crashes: agents continue running, Overstory maintains state, developer restarts the dashboard and reconnects with full state recovery. No work is lost. This separation ensures the factory is robust to dashboard failures without requiring dashboard high-availability infrastructure.

### Data Integrity in Distributed Coordination

**Concurrent Agent State Access.** Agent coordination state (Overstory SQLite) must support concurrent read/write access from multiple agents without corruption or data loss. Write contention is managed by Overstory's transaction layer — agents interact with Overstory via its API, never accessing SQLite directly. The architecture must guarantee: no silent write failures, no data overwrites from concurrent agents, and consistent read-after-write semantics for mail delivery (an agent that sends a mail must know the recipient can read it immediately).

**Cross-Developer State Consistency.** Cross-developer state sharing (Mulch, Seeds, raw learning records) is eventually consistent via git. Each developer's factory operates on its local state, which synchronizes at git push/pull boundaries. During concurrent development, developers may have divergent views of Seeds entries, Mulch expertise, and learning records. This is acceptable for the 2-developer model — developers coordinate overlapping work via Seeds entries and standups. The architecture supports this by ensuring all shared state files use append-only or merge-friendly formats (no binary blobs, no formats that produce merge conflicts on concurrent edits). `.mulch/` uses append-only format. `.qds/learnings/` uses date-partitioned directories with per-agent filenames (no two agents write to the same file). Seeds entries are individually-keyed. Real-time cross-developer state sync is a post-MVP concern that becomes relevant at 3+ developers.

## Innovation & Novel Patterns

### Detected Innovation Areas

Five innovation areas identified, ranked by novelty, strategic importance, and durability of competitive advantage:

| # | Innovation | Novelty Level | Closest Competitor Analog | Gap vs Competitors | Moat Durability |
|---|---|---|---|---|---|
| 1 | **Factory Learning System (D8)** | **High** | Cursor `.cursorrules` (manual, static); no automated analog | Only genuine data-flywheel moat. No competitor has agent-generated, outcome-weighted, auto-injected cross-session learning. The data asset requires real workloads — cannot be replicated by copying architecture. | **24–36 months** |
| 2 | 5-Layer Context Management Harness (D6) | High | Cursor codebase indexing (2 of 5 layers); no Phase Boundary Protocol analog | No tool composes all 5 layers. IDE-native tools structurally resist Phase Boundary Protocol's context discontinuity because their product model is context continuity. | 12–18 months |
| 3 | Adversarial Quality Pipeline (context-isolated, economy-tier) (D2) | High | CodeRabbit (AI review), Cursor (reviews own output) | Neither enforces context isolation between generation and review. Neither produces structured evidence artifacts with severity tiers, branch coverage gaps, and cost attribution at ~$0.02/story. | 6–9 months (mechanism); workflow dependency persists |
| 4 | Closed-Loop Self-Healing with verification loop (D4/D5) | High | Dependabot (single-concern auto-fix), Snyk (security-only), Google Jules (D4/D5 partial) | No tool does full-spectrum scan → fix → next-cycle verify loop with layered guardrails. Competitors will ship auto-fix; few will ship re-verification. | 12–18 months (Growth feature) |
| 5 | Coordination-Over-External-Runtimes via Pi SDK | Moderate | LangChain/CrewAI (agent frameworks that own execution) | Those frameworks own execution; QDS coordinates via Pi SDK which handles model-agnostic runtime natively. Moat is Factory Core's governance layer, not Pi itself. | Moderate; depends on Pi SDK health |

### Validation Approach

**1. Adversarial Quality Pipeline**
- **Metric:** BMAD defect catch rate — real issues found per story that would have shipped without review
- **Method:** Run 20 stories through the pipeline. For each, record BMAD findings. Have Steve manually review the same code blind (without BMAD results). Compare. If BMAD consistently catches issues human review missed, the pipeline is validated.
- **Minimum bar:** BMAD catches at least 1 real defect per 5 stories that would have survived human review
- **Timeline:** Achievable within first 2 weeks of MVP operation

**2. Closed-Loop Self-Healing**
- **Metric:** Issues discovered by cron that were not found by the development pipeline, successfully fixed without human intervention
- **Method:** Run the cron scanning loop for 30 days against an active repo. Track: issues discovered, fixes attempted, fixes that passed QA, fixes that were correct in production
- **Minimum bar:** At least 5 legitimate issues discovered and auto-fixed per month with zero regressions introduced
- **Timeline:** Post-MVP (Growth) — validation design should be ready so it runs from day one of Growth

**3. Factory Learning System**
- **Metric:** Token waste reduction — do agents in scopes with accumulated learnings waste fewer tokens than agents in unlearned scopes?
- **Method:** A/B comparison across module areas with active synthesized learnings vs module areas with none. Compare: tokens spent on retries/stalls, first-attempt success rate, BMAD correction rate.
- **Minimum bar:** 15% reduction in token waste for learned scopes vs unlearned scopes within 30 days
- **Timeline:** Measurable within first month of MVP operation

**4. Coordination-Over-External-Runtimes (via Pi SDK)**
- **Metric:** Runtime resilience — can the factory continue operating when a model provider degrades?
- **Method:** Deliberately throttle one API key during a multi-story session. Verify: Pi SDK handles backoff natively, affected agents queue gracefully, unaffected agents continue, no story corruption, recovery is automatic when throttle lifts
- **Minimum bar:** Zero story failures from single-provider degradation events
- **Timeline:** Testable immediately on MVP launch

**5. 5-Layer Context Management**
- **Metric:** Context isolation integrity — do BMAD review agents ever exhibit knowledge from development phase context?
- **Method:** Instrument Phase Boundary Protocol to log exactly what transfers between phases. Audit BMAD outputs for references to development-phase-only artifacts (debugging notes, intermediate drafts, abandoned approaches). Any leakage is a failure.
- **Minimum bar:** Zero context leakage across 50 phase transitions
- **Timeline:** Testable from first story in MVP

### Risk Mitigation

| Innovation | Primary Risk | Fallback | Cost of Fallback |
|---|---|---|---|
| Adversarial Quality Pipeline | BMAD consistently finds nothing — code is perfect or BMAD is too shallow | Tune review profiles (security, logic, API-contract focused). If still nothing: BMAD becomes rubber-stamp, pipeline is just QA waves. Cost stays negligible — weak BMAD isn't expensive, just less valuable. | Low |
| Closed-Loop Self-Healing | Cron fixes introduce more bugs than they fix | Tighten blast radius limits. Worst case: disable auto-fix, keep cron as scan-only (issues surfaced to Seeds for human triage). Scanning value persists without auto-fix. | Medium — loses "closed loop" but retains "continuous scanning" |
| Factory Learning System | Learnings are wrong more often than right | Tiered injection limits exposure (critical-tier has highest confidence bar). Fallback: disable auto-injection entirely, fall back to manual Mulch curation. Learning records still capture data for manual review. Re-enable after improving synthesis quality. | Medium — loses "factory gets smarter" but infrastructure retains manual review value |
| Coordination-Over-External-Runtimes | **Risk A — Pi SDK model switching not available or unreliable for economy tier.** Pi SDK model switching doesn't perform as expected for certain tiers, or GLM-5 is not natively available through Pi SDK. | **Fallback: Redefine economy tier as OpenRouter Gemini Flash (~$0.075/M tokens blended).** Do NOT fall back to Opus 4.6 for economy-tier roles — this produces a quality pipeline cost of ~61% of story total and destroys the value proposition. Treat Pi-native GLM-5 routing as an optimization over the OpenRouter baseline, not a hard dependency. Factory Core's tier directive layer must support both routing paths with a configuration switch. | Medium — loses Pi-specific economy routing but retains the "quality feels free" claim via OpenRouter |
| Coordination-Over-External-Runtimes | **Risk B — GLM-5 pricing via Pi SDK exceeds the NFR22 break-even threshold.** GLM-5 priced above $0.60/M tokens blended makes the 5% quality cost ceiling unachievable on medium stories and puts the "quality feels free" narrative at risk. | **Go/no-go gate:** Economy-tier validation spike must confirm actual Pi SDK GLM-5 pricing before MVP sprint 1. If pricing is $0.30–$0.60/M: revise NFR22 ceiling to 8%, update Journey 1 cost figures to reflect actual economics, adjust marketing copy from "feels free" to "radically cheap." If pricing exceeds $0.60/M: redesign quality pipeline — options are (a) reduce BMAD team from 3 agents to 1, (b) reduce QA swarm default wave count from 5 to 2, (c) migrate economy tier to OpenRouter Gemini Flash regardless of Pi SDK availability. | High — affects core differentiation claim and may require pipeline architecture change |
| 5-Layer Context Management | Phase Boundary Protocol is too lossy — important context lost | Expand manifest schema. Last resort: allow limited context sharing between phases with explicit opt-in (violating strict isolation — compromises adversarial review guarantee). | High — undermines core principle |

### Competitive Scoring Matrix

The 8-dimension claim in the Executive Summary is supported by the following quality-weighted scoring matrix. Scoring rubric: Full (1.0) = purpose-built production capability; Partial (0.5) = degraded, adjacent, or manually-configured version; None (0) = no capability.

| Competitor | D1 Orchestration | D2 Adversarial Review | D3 QA Automation | D4 Self-Healing | D5 Scheduled Ops | D6 Context Mgmt | D7 Cost Optimization | D8 Learning System | **Score /8** |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Cursor** | 0.5 | 0.5 | 0.5 | 0.5 | 0 | 0.5 | 0.5 | 0.5 | **4.0** |
| **GitHub Copilot / Workspace** | 0.5 | 0.5 | 0.5 | 0.5 | 0 | 0.5 | 0 | 0 | **2.5** |
| **Devin (Cognition AI)** | 1.0 | 0 | 0.5 | 0 | 0 | 0.5 | 0 | 0 | **2.0** |
| **Google Jules** | 0.5 | 0 | 0 | 0.5 | 0.5 | 0 | 0 | 0 | **1.5** |
| **OpenAI Codex CLI** | 0.5 | 0 | 0.5 | 0 | 0 | 0 | 0 | 0 | **1.0** |
| **Claude Code** | 0.5 | 0 | 0 | 0 | 0 | 0.5 | 0 | 0 | **1.0** |
| **CodeRabbit** | 0 | 1.0 | 0 | 0 | 0 | 0 | 0 | 0 | **1.0** |
| **LangChain / CrewAI** | 1.0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **1.0** |
| **Dependabot** | 0 | 0 | 0 | 0.5 | 0.5 | 0 | 0 | 0 | **1.0** |
| **Snyk** | 0 | 0 | 0 | 0.5 | 0 | 0 | 0 | 0 | **0.5** |
| **QDS Engineer v2 (MVP — 6 active dimensions)** | 1.0 | 1.0 | 1.0 | 0* | 0* | 1.0 | 1.0 | 1.0 | **6.0** |
| **QDS Engineer v2 (Growth — all 8 active)** | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | **8.0** |

*D4 (Self-Healing) and D5 (Scheduled Operations) are Growth-phase features. QDS MVP delivers 6 of 8 dimensions; the full closed-loop architecture (all 8) completes at Growth.

**Notes on newly-added competitors:**

- **Cursor (4.0/8):** The closest competitor. Partial coverage across 7 dimensions, concentrated in the most visible ones (D1, D2, D3) — the first dimensions a developer evaluates. Cursor's D2 score is structurally limited: it reviews its own output without context isolation, which is the exact gap QDS's Phase Boundary Protocol addresses. Adding context isolation would require a fundamental product architecture change for Cursor, not a feature addition. Cursor's D8 score is `.cursorrules` — human-authored, manually updated, static. QDS's D8 is agent-generated, outcome-weighted, and auto-injected.
- **GitHub Copilot / Workspace (2.5/8):** 1.8M+ paid users with native IDE integration. Partial coverage of D1+D2+D3 at Copilot's distribution scale is a larger market threat than full coverage from a new entrant.
- **Claude Code (1.0/8):** QDS depends on Claude Code as its underlying execution environment. Claude Code's own multi-agent features and hooks API (which QDS's Superpowers architecture resembles) directly erode D1+D2 differentiation. This is a structural blind spot: the runtime QDS depends on is also a competitor.
- **Google Jules (1.5/8):** Background async coding agent targeting D4+D5, announced Q4 2025. Google's infrastructure advantage also threatens D7 economics.
- **OpenAI Codex CLI (1.0/8):** Terminal-native coding agent targeting the solo-developer and startup CTO personas directly.

### Competitive Moat Assessment

**Strong moat (hard to replicate):**
- **Factory Learning System (D8)** — requires real workloads to accumulate learnings. A competitor can copy the architecture but not the accumulated operational intelligence. Moat deepens with every story. This is a *future* moat — it requires QDS to ship and accumulate data before the moat materializes. First-mover advantage is real and irreversible once the data flywheel is spinning.
- **5-Layer Context Management + Phase Boundary Protocol (D6)** — requires deep integration with multiple subsystems. Composition across Overstory, Superpowers, Phase Boundary Protocol, Mulch, and Seeds is the moat. IDE-native tools (Cursor, Copilot) are built on context continuity for user experience — they structurally resist adopting Phase Boundary Protocol's deliberate context discontinuity.

**Moderate moat (replicable with effort):**
- **Adversarial Quality Pipeline (D2)** — the mechanism (context isolation) is unique today; the output format is more durable. Lead with the evidence output (structured PR bodies with severity-tiered findings, branch coverage gap indicators, cost attribution) rather than the mechanism. Once review processes depend on this format, switching cost is real.
- **Coordination-Over-External-Runtimes via Pi SDK (D7-adjacent)** — Pi SDK provides the model-agnostic runtime natively. Moat is in Factory Core's agent-specific governance layer (context budgets, capability matching, attribution chains, tier policy).
- **Closed-Loop Self-Healing with verification loop (D4/D5)** — competitors will ship auto-fix before they ship auto-verify. The next-cycle re-verification is architecturally unglamorous and durably differentiating. Moat rating deferred until Growth ships the verification loop and it is proven operationally.

**Table-stakes (not a positioning differentiator):**
- **Model-agnostic cost routing (D7 mechanism)** — infrastructure, not product, as of Q1 2026. OpenRouter and LiteLLM commoditize the routing mechanism. The economic *outcome* is differentiating: "mandatory adversarial review and 5-wave QA at ~$0.02 per story." Position the economics, not the routing.

**Compound moat (the organizing claim):**
The integration of all active dimensions into a single closed loop is harder to replicate than any dimension individually. When D7 (cost routing) is commoditized, QDS still uses it to make the quality pipeline economically invisible. When D1 (orchestration) is commoditized by Claude Code, QDS still enforces Phase Boundary Protocol and context isolation across it. This compound architecture is the actual competitive claim — not a dimension count.

**Strategic implication:** The Factory Learning System and 5-Layer Context Management are the deepest moats and the innovations that compound over time. D8 must be the external lead claim. Architecture and implementation sequencing should prioritize getting these right.

### Quarterly Competitive Monitoring

Competitive claims in this PRD require active maintenance. The following monitoring framework defines what to watch, at what frequency, and which claims require immediate revision on each trigger event.

**Monitoring Cadence: Monthly for high-velocity signals; quarterly for full matrix refresh.**

#### High-Priority Signals (check monthly)

| Competitor | Signal to Watch | Claim at Risk | Immediate Response if Triggered |
|---|---|---|---|
| **Claude Code** | Anthropic releases multi-agent mode with explicit reviewer role isolation (clean context between generator and reviewer) | D2 mechanism uniqueness | Reframe D2: shift from "we have this" to "we have 12+ months of operational data proving this at scale." Lead with D8 data flywheel. |
| **GitHub Copilot / Workspace** | Copilot announces "review agent" with explicit context boundary semantics | D2 mechanism uniqueness | Shift D2 positioning entirely to evidence artifact format (severity-tiered PR bodies, branch coverage gap indicator). The artifact is more durable than the mechanism. |
| **Cursor** | Cursor changelog shows scheduled/cron-equivalent background agents | D5 uniqueness | Accelerate D4/D5 Growth shipping. Lead with the verification loop specifically — next-cycle re-verification is architecturally unglamorous and Cursor will deprioritize it. |
| **Any funded competitor** | Competitor announces "codebase memory," "persistent agent learning," or "agent knowledge base" product | D8 uniqueness claim | Execute data-flywheel argument immediately: QDS has N months of real operational data from real stories; the competitor starts from zero. Ship Factory Intelligence Score dashboard as visible proof. |
| **GLM-5 / economy-tier models** | GLM-5 pricing changes; competing economy-tier models release (Gemini Flash, Haiku) | "$0.02/story" economic claim | Update cost claim with real data from production. If cost rises, re-validate the "economically negligible" threshold or adjust quality pipeline configuration. |

#### Full Matrix Refresh (quarterly)

Re-score the competitive matrix above each quarter against the following refresh questions:

1. Has Cursor shipped scheduled background agents? (Changes D5 score from 0 → 0.5)
2. Has Claude Code shipped an explicit review agent with context isolation? (Changes D2 score from 0 → 0.5 or 1.0)
3. Has any competitor shipped agent-generated persistent learning with auto-injection? (Changes D8 score)
4. Has Pi SDK economy-tier routing been replicated by any mainstream IDE plugin or model gateway? (D7 mechanism becomes full table-stakes)
5. Does any competitor now score ≥ 5.0/8 on the quality-weighted matrix? (Triggers reframe of compound moat claim)

**Refresh ownership:** Steve performs the quarterly matrix refresh. Output is a new dated competitive analysis file in `_bmad-output/planning-artifacts/`. The PRD competitive claims section is amended as needed following the refresh.

**Do not refresh in isolation.** Each refresh should check competitor release notes, changelog entries, and community discussion (Cursor forums, GitHub Next blog, Anthropic developer blog, Google Labs announcements, OpenAI developer changelog) — not just product announcements.

## Project-Type Specific Requirements

### Project-Type Overview

QDS Engineer v2 is a hybrid developer tool / internal platform that maps to two project-type categories: **developer_tool** (SDK/library consumption, CLI/dashboard interface, documentation) and **saas_b2b** (multi-user instances, integrations, potential B2B licensing). For MVP, the developer tool aspects dominate — the factory is an internal tool for 2 developers. B2B concerns are Growth/Vision.

### Integration Map

The factory interacts with external systems at defined touchpoints. Each integration has a data flow direction, failure mode, and documented recovery path.

| External System | Direction | Data Flow | Failure Mode | Recovery |
|---|---|---|---|---|
| **Pi SDK** (primary runtime) | Bidirectional | Model tier directives out; model responses, token/cost data back | Pi crash → all agents halt. Model unavailable → agents queue via Pi's native backoff. | Dashboard shows Pi status. Auto-resume when Pi recovers. Agents preserve state via Overstory checkpoint. |
| **GitHub** (via `gh` CLI) | Bidirectional | Branch create, PR create, PR comment read, status check read | API rate limit (5,000 req/hr authenticated), auth failure, network timeout | Rate limit: queue and retry with backoff. Auth failure: alert developer, halt PR operations. Network: retry with exponential backoff. |
| **Git** (local) | Bidirectional | Clone, branch, commit, push, worktree management | Merge conflict, disk full, auth failure | Merge conflict: story fails, developer resolves. Disk full: halt new story starts. Auth: alert developer. |
| **CI Pipeline** | Observe only (MVP) | PR triggers CI; factory reads status via `gh pr checks` | CI failure → human review (MVP) | Growth: cron loop dispatches CI-specific fixes |
| **Filesystem** | Local | Worktrees, .mulch/, .qds/, Overstory SQLite, logs | Disk full, permission errors | Resource monitoring with warning thresholds (domain requirements) |
| **Dashboard ↔ Overstory** | Internal (SSE/WS) | Agent state, events, phase transitions, commands (nudge/stop/inspect) | Dashboard crash → agents continue (Overstory is control plane) | Developer restarts dashboard, reconnects with full state recovery |
| **Mulch** (via filesystem) | Read at overlay assembly | overlay.ts reads .mulch/ files, scopes to agent file path, includes in overlay | File read failure → agent starts without Mulch priming (degraded, not fatal) | Warning logged. Agent operates without expertise priming. |
| **Superpowers** (via filesystem) | Read at overlay assembly + hook enforcement | Skills injected into overlay; gate definitions read by hook scripts | File read failure → agent starts without skills (degraded) | Warning logged. Hook enforcement skipped for missing gates — BMAD review becomes sole enforcement. |

**GitHub Integration Scope (MVP via `gh` CLI):**

1. **Branch creation:** `git checkout -b qds/<dev>/<story-id>` + `git push -u` — factory-namespaced branches
2. **PR creation:** `gh pr create` — structured body with BMAD/QA evidence, cost attribution, factory instance ID, Pre-BMAD Mechanical Validation section
3. **PR comment reading:** `gh api repos/{owner}/{repo}/pulls/{number}/comments` — for Seeds feedback loop (human comments on factory PRs become Seeds issues)
4. **PR status checks:** `gh pr checks` — observe CI results (MVP is observe-only)
5. **Seeds ↔ GitHub Issues:** Factory-internal for MVP. Growth: one-way export from Seeds to GitHub Issues for teams wanting GitHub-native tracking.

**Setup prerequisite:** `gh` CLI must be installed and authenticated (`gh auth status` verification in setup script). Must have repo scope for branch/PR operations.

### Technical Architecture Considerations

#### Overlay Composition Pipeline

The overlay assembly in Factory Core's `overlay.ts` is the highest-complexity internal module. It reads from multiple sources and composes them into a single agent overlay within a hard token ceiling. The pipeline operates as ordered stages with per-stage token budget allocation:

```
Stage 1: System prompt + agent role definition         (~500 tokens, fixed)
Stage 2: Superpowers skills + iron laws                (~1,500-2,500 tokens, priority-ranked)
Stage 3: Mulch expertise priming                       (~500-1,500 tokens, scoped to file path)
Stage 4: Factory Learnings injection                   (hard ceiling: 500 economy / 1,000 standard)
Stage 5: Phase Boundary Protocol manifest (if mid-story) (~300-800 tokens)
Stage 6: Task instructions (story spec, file scope, AC) (~1,000-2,000 tokens)
```

Each stage implements a consistent interface: `(agentContext, remainingBudget) → { content, tokensUsed, itemsIncluded, itemsTruncated }`. If a stage exceeds its allocation, it priority-ranks items and truncates. The pipeline outputs: the assembled overlay AND a budget manifest documenting what each stage consumed, what was included, and what was truncated. The budget manifest is logged for debugging and feeds into the Learning Audit view (post-MVP).

No agent launches without a passing context budget check. If total overlay exceeds the model's effective context limit minus estimated task requirement, Factory Core either splits the task scope or escalates the model tier.

#### Hook Enforcement Architecture

The factory enforces quality gates through a 6-layer progressive enforcement pipeline. Each layer catches what previous layers missed, and each does what it's best at:

**Layer 1 — Runtime (Overstory/Pi filesystem restrictions):**
Infrastructure gates the agent can't violate. Filesystem access restricted to assigned worktree and scope. Protected files (`.env`, `factory.yaml`, `.gitconfig`) inaccessible. API keys never exposed to agent context.

**Layer 2 — Post-Edit Hooks (fires after every file write):**
Immediate feedback on objective, file-level violations.

| Check | Type | Severity | Enforcement |
|---|---|---|---|
| File scope violation (write outside assigned scope) | Infrastructure | Block | Hard stop, agent receives error |
| Protected file modification | Infrastructure | Block | Hard stop, agent receives error |
| TDD file-pair (source file edit without corresponding test file edit) | Convention | Warning | Mail sent to agent with warning banner |

**Layer 3 — Post-Task Hooks (fires when agent completes a task):**
Task-level mechanical validation. Fix happens within the same phase.

| Check | Type | Severity | Enforcement |
|---|---|---|---|
| Test runner (all tests pass for modified files) | Quality | Block | Task rejected, coordinator sends fix instruction via mail |
| Lint check (project linter clean on modified files) | Quality | Block | Task rejected with specific lint errors |
| Type check (`tsc --noEmit` on modified files) | Quality | Block | Task rejected with type errors |

**Layer 4 — Phase Boundary Hooks (fires at phase transition):**
Hard gate before context wipe and fresh agent spin-up. The dashboard displays a gate checklist during the transition animation.

| Check | Type | Severity | Enforcement |
|---|---|---|---|
| Full test suite pass | Quality | Block | Phase cannot transition |
| Build succeeds | Quality | Block | Phase cannot transition |
| Full lint clean | Quality | Block | Phase cannot transition |
| Type check passes | Quality | Block | Phase cannot transition |
| No uncommitted changes in worktree | Integrity | Block | Phase cannot transition |
| Transfer manifest schema valid | Protocol | Block | Phase cannot transition |

Phase boundary gate results are displayed as a checklist in the dashboard: `✅ Tests pass ✅ Build succeeds ✅ Lint clean ✅ Type check ✅ No uncommitted changes ✅ Manifest valid → Transition approved`. Failures show the specific gate and remediation status.

**Layer 5 — BMAD Review (fresh agents with Superpowers overlay):**
Judgment-level verification by context-isolated agents. Catches what hooks can't: spec compliance, architecture quality, edge case reasoning, security implications. BMAD's context window isn't wasted on mechanical violations (already caught by hooks) — it focuses entirely on judgment calls.

**Layer 6 — QA Swarm (edge cases and regression testing):**
Final safety net. Multi-wave testing with intelligent stopping.

**Hook output visibility:** Hook enforcement results appear inline in the agent's xterm.js output stream as colored banners: `[HOOK] ⚠️ TDD: source file modified without test file change` / `[HOOK] ✅ Post-task: all tests pass (47/47)` / `[HOOK] 🛑 BLOCKED: lint errors in webhook.ts (3 errors)`. No separate dashboard or log — enforcement is part of the agent's visible narrative.

**Hook results as PR evidence:** Structured hook enforcement results are included in the PR body as a "Pre-BMAD Mechanical Validation" section: tests passed count, lint status, type check status, TDD warnings issued and resolved, scope violations blocked and corrected. This tells the PR reviewer that mechanical validation occurred before BMAD review.

**Hook-Learning System reinforcement:** Phase boundary gate failures and their resolutions are captured in agent learning records. A fix pattern — "tests failed at phase boundary, agent identified missing mock, added mock, tests passed" — becomes a Factory Learning that future agents in the same scope receive. The hook system and learning system compound each other.

#### Superpowers Gate Integration

Superpowers skills are currently defined as natural language markdown with minimal YAML frontmatter (`name`, `description`). The factory consumes Superpowers at two levels:

**Overlay injection (agent self-policing):** Skill markdown is injected into the agent's overlay as-is. The agent reads iron laws, process flows, and guidelines as instructions. This handles subjective, judgment-based gates: TDD red-green-refactor cycle discipline, root cause investigation before fixing, design-before-implementation workflow, verification evidence quality. These gates cannot be mechanically validated — the agent follows the recipe, and BMAD verifies the outcome.

**Hook enforcement (machine validation):** For the subset of gates that are objective and binary, Superpowers skill files are extended with structured `enforcement` metadata in YAML frontmatter:

```yaml
---
name: test-driven-development
description: Use when implementing features...
enforcement:
  hook_checks:
    - hook: post-edit
      type: file-pair
      rule: "source file edit requires corresponding test file edit"
      severity: warning
    - hook: post-task
      type: test-runner
      command: "bun test --filter {modified_files}"
      severity: block
    - hook: phase-boundary
      type: test-runner
      command: "bun test"
      severity: block
---
```

The existing `skills-core.js` library (which already handles frontmatter extraction and skill discovery) is extended to extract `enforcement` fields. Hook scripts read these definitions at agent startup and execute applicable checks at each hook point.

**MVP scope:** Extended frontmatter for the 5 existing enforcement gates (4 iron laws + 1 hard gate). Gate-runner scripts for: file-pair checker, test runner, lint runner, type checker, manifest validator, scope validator. Growth: custom gate definitions per project, gate effectiveness metrics, post-task coverage delta checks.

### Source Project Migration Path

| Source Project | Consumption Model | What Gets Imported | What Gets Extended | What Gets Built New |
|---|---|---|---|---|
| **Pi SDK** | Runtime — Overstory runs inside it | Model-agnostic execution, native model switching (Opus 4.6, GLM-5), cost/token reporting | Configuration for factory-specific tier policies | Nothing — Pi is the runtime, factory configures it |
| **Overstory** | Library — core orchestration | Agent lifecycle, mail system, SQLite state, checkpoint | Overlay injection (extended for Factory Learnings, tier directives), mail types (add `learning_report`) | Nothing wholesale — extensions only |
| **Superpowers** | Library — quality gates + hook enforcement | Skills for overlay injection, `skills-core.js` for discovery/extraction | YAML frontmatter extended with `enforcement` metadata for hook scripts | Gate-runner script library (file-pair, test runner, lint, type check, scope, manifest) |
| **ZeroClaw** | Library — dashboard scaffolding | React 19 + TS + Vite + Tailwind shell (layout, routing, sidebar, header, build config, SSE/WebSocket patterns) | Existing Dashboard/Cron/Config pages adapted for factory context | Factory-specific pages: Agent Windows, Story Pipeline, Factory Overview, Learning tab, phase boundary gate checklist |
| **claude-mem** | Library — selective patterns | Progressive disclosure pattern, session summary format, content deduplication logic, hybrid search concepts | Patterns adapted for Mulch extensions (timestamps, provenance, category boosting) | Memory system rebuilt using claude-mem patterns but factory-specific implementation |

**Greenfield components (no source project to fork):**
- **Phase Boundary Protocol** — novel, highest design risk. Structured transfer manifests, context budget consumed field, learnings section, fresh agent spin-up logic, hook integration at phase gate. No existing code in any source project. Must include hook enforcement from day one (co-dependent).
- **Factory Core overlay composition pipeline** — orchestration logic assembling overlays from multiple sources (Superpowers, Mulch, Learnings, manifests) within token budgets. Individual sources exist; the composition pipeline is new.
- **Hook infrastructure** — the runner that executes gate scripts at defined hook points (post-edit, post-task, phase boundary). Prerequisite for Phase Boundary Protocol and all enforcement.
- **Factory Learning System** — all three loops, learning records, synthesis script. The learning infrastructure is entirely new (no source project equivalent).

### Validation Spikes (Prerequisite — Before Any Coding Begins)

The following spikes are mandatory prerequisites. No implementation work on any numbered item below may begin until the corresponding spike is complete and its go/no-go criteria are satisfied. Spikes produce data and proof-of-concept code, not production-shippable features.

**Spike 1 — Pi SDK Architecture and Economy-Tier Confirmation (Week 1, Developer A)**
Answers: (a) Is Pi SDK a library, sidecar process, or hosted service? (b) Does Pi SDK expose a resolved model identifier per call? (c) Is GLM-5 available via Pi SDK natively, or is OpenRouter required? (d) What is the actual per-token price for GLM-5 via Pi SDK? (e) What does "Overstory runs inside Pi" mean at the code level? (f) Does Pi return per-call cost/token data for all supported models?
*Output required:* Working proof-of-concept that spawns one agent via Pi, routes it through economy tier and premium tier, returns a response with verifiable cost and model identifier. Confirmed GLM-5 price recorded in `factory.yaml`.
*Go/no-go:* Spike must complete before Item 1 implementation begins. If Pi SDK architecture cannot be confirmed, Item 1 design must be revised to treat Pi SDK as an adapter pattern with a pluggable backend rather than a direct integration.

**Spike 2 — CopilotKit + AG-UI Feasibility (Week 1, Developer B — parallel with Spike 1)**
Answers: (a) How is CopilotKit configured to use Pi SDK as its backend instead of CopilotKit cloud? (b) What is AG-UI Protocol exactly — is it a CopilotKit-native feature, a separate package, or a draft standard requiring independent implementation? (c) Does the CopilotKit + xterm.js combination maintain 30fps in a real browser test with 12 panels? (d) Can multi-step investigation (FR107, FR114) be demonstrated with the current SDK versions?
*Output required:* Working dashboard test with CopilotKit chat bar + 12 xterm.js panels; measured FPS and SSE latency; demonstration of at least Ask mode via Pi SDK backend.
*Go/no-go:* If AG-UI Protocol is unavailable, immature, or not compatible with the target dashboard architecture, FR107 (Investigate mode), FR113 (bidirectional streaming), FR114 (multi-step investigations), and FR115 (visible step indicators) are deferred to Growth. Dashboard Copilot MVP scope is reduced to Ask mode only (FR106) plus Act mode via simple `useCopilotAction` hooks (FR108–FR112). This deferral must be formally decided before the Dashboard Copilot epic begins, not discovered mid-sprint.

**Spike 3 — Overstory Extension Point Validation (Week 2, Developer A — after Spike 1)**
Answers: (a) Do Overstory's current extension points support overlay injection, tier directive plumbing, hook runner integration, and new mail type registration without forking? (b) Does Overstory expose an event stream suitable for dashboard SSE, or must this be added? (c) Does Overstory's transaction layer pass a 15-agent concurrent write/mail stress test?
*Output required:* Documented extension point inventory with fork-required vs. extend-via-API classification for each required modification.
*Go/no-go:* If any required extension point requires forking Overstory, the implementation estimate for Item 2 must be revised upward and the fork maintenance strategy must be documented before proceeding.

### Sprint 0 Architecture Prerequisites

Before any code story is written against the FRs below, five design artifacts must be produced and approved as Architecture Decision Records (ADRs). These are not code stories — they are specification documents. They do not require implementation, only authorship and team sign-off. Their absence will cause mid-sprint conflicts, schema rework, and broken integration points.

| Artifact | ADR Name | Unblocks FRs | Responsible |
|----------|----------|-------------|-------------|
| **`pipeline.db` full schema** — all tables (`action_scores`, `session_composites`, `task_checkout_locks`, `turn_state`, `epic_context`, `pattern_knowledge`, `maintenance_learnings`, `maintenance_burden`, `elo_ratings`, `elo_epochs`), indexes, migration system, and foreign key constraints | ADR-01: pipeline.db Schema | FR130, FR131, FR132, FR145, FR149, FR165, FR166, FR167, FR168 | Developer A |
| **Credential sanitizer specification** — the sanitizer utility that strips API keys, tokens, and secrets from all factory output paths (agent stdout/stderr, Overstory logs, learning records, PR evidence body, dashboard renders, meta-optimization journals, Telegram messages); specification defines: regex patterns, replacement tokens, output path coverage contract | ADR-02: Credential Sanitizer Spec | FR44, FR52, FR55, FR77, FR103, FR120 (none of these output-path FRs may be marked Done without sanitizer integration) | Developer B |
| **Phase Boundary Protocol manifest schema** — canonical YAML schema with all required/optional fields, validation rules, serialization format, handoff protocol (defined in FR32 amendment) | ADR-03: Phase Boundary Protocol Manifest Schema (= FR32 amendment) | FR32, FR18, FR45, FR20, FR131, FR58 | Developer A |
| **Gateway API interface contract** — the request-response query interface that translates dashboard and external data queries into `pipeline.db` reads; must define: endpoint naming conventions, response envelope schema, pagination protocol, authentication (developer ID header), error contract | ADR-04: Gateway API Interface Contract | FR139, FR146, FR89 (meta-optimization history timeline), FR43–FR46 (historical data queries) | Developer B |
| **System health reporting interfaces** — the cross-cutting contract that every subsystem must implement to expose health signals to FR170's circuit breaker; must define: `HealthSignal { subsystem: string, status: "healthy" \| "degraded" \| "failed", error_count_60s: int, last_checked_at: ISO8601 }` and the registration protocol for new subsystems | ADR-05: System Health Reporting Interfaces | FR170 (circuit breaker), FR73 (resource monitoring), FR14 (hook runner), FR28 (overlay pipeline), FR36 (Pi SDK), FR37 (token tracking) | Developer A |

**Completion criterion for Sprint 0:** All 5 ADRs are written, reviewed by both developers, and committed to `_bmad-output/architecture/` before any Sprint 1 story is marked In Progress.

### Implementation Sequencing

The critical path from runtime substrate to first shippable PR is **22 sequential dependency hops**. This is not a 5-item list — it is a chain of 22 prerequisite FRs that cannot be parallelized on Developer A's track. Any slip in this chain delays the MVP end-to-end story milestone by at least the time it takes to repair the slipped item plus re-test all downstream integrations. All spikes above must be complete before beginning Item 1.

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
- Progressive skill loading -- only role-relevant skills injected per agent (FR159, Growth)

**Agent Performance Data Collection (MVP):**
- Action-level process scoring after each post-task hook (FR130)
- Confidence calibration at phase boundaries (FR131)
- Session-level composite performance scores (FR132)
- Performance data export (FR140)

**Agent Performance Behavioral System (Growth):**
- ELO-style domain-specific ratings per agent (FR133)
- Capability tier assignment (FR134) with tier-based hook density (FR135)
- Weighted composite scoring for agent routing (FR136-R, replaces killed credit economy)
- Performance context injected into agent overlays (FR137)
- ELO-based story-to-agent routing (FR138)
- Dashboard performance cards (FR139)
- Manual tier override (FR141)

**Economic Governance:**
- Per-story budget enforcement revised -- per-role visibility only, no per-agent budget caps (FR142, MVP)
- Atomic task checkout preventing double-work (FR145, MVP)
- Rate limit snapshot tracking (FR143, Growth)
- Cost-per-initiative rollups (FR144, Growth)
- Cost attribution dashboard (FR146, Growth)

**Orchestration:**
- Turn-based continuation within phases, simplified with lightweight signals (FR149, MVP)
- Per-phase-type concurrency limits (FR147, Growth)
- Workspace lifecycle hooks at 4 points (FR148, Growth)
- Automatic deviation handling with 4 rules (FR150, Growth)
- Wave-based epic decomposition (FR151, Growth)

**Quality Verification:**
- Lightweight continuous structural verification (FR152, MVP)
- Context budget 50% rule with minimum floor (FR155, MVP)
- Nyquist-BMAD disagreement protocol (FR163, MVP)
- Structured verification report (FR153, Growth)
- Auto-remediation from verification gaps (FR154, Growth)

**Self-Learning System (MVP):**
- Maintenance agent learning extraction with CLI seeding (FR164)
- Codebase pattern knowledge accumulation (FR165)
- Epic-level context management (FR166)
- Overlay learning enrichment with priority ordering (FR167)
- Maintenance burden tracking (FR168)

**System Health and Notification (MVP):**
- System health circuit breaker (FR170)
- Multi-channel notification abstraction with Telegram (FR171)

**Memory & Learning Enhancements (Growth):**
- Confidence-scored fact extraction (FR156-FR157)
- Per-agent memory profiles (FR158)
- Progressive skill loading (FR159)
- Action-level process scores in learning records (FR160)
- Tier demotion criteria (FR161)
- ELO migration strategy (FR162)
- Random audit mechanism (FR169)

**Meta-Optimization (Factory Self-Improvement):**
- Daily cron observer agent analyzes factory operations (token patterns, overlay efficiency, stall correlation, BMAD/QA outcomes) — writes structured journal, no changes
- Weekly cron optimizer reads 7 daily journals, identifies recurring patterns, implements single highest-impact improvement
- Auto-apply with safety net: changes flagged in dashboard with one-click revert, CLI revert fallback
- Effectiveness window (default 2 weeks) — unvalidated changes auto-revert
- Cumulative drift monitoring with baseline comparison
- Economy-tier models for all cron agents

**Dashboard Copilot (Conversational Control Plane):**
- CopilotKit + AG-UI chat bar with text input, docked to right edge
- Three interaction modes: Ask (query state), Investigate (navigate + correlate), Act (execute controls with confirmation)
- Copilot actions performed visibly through dashboard UI controls
- Economy-tier model for queries, standard tier for complex investigations
- Copilot token budget tracked separately from story budgets

### Post-MVP Features (Phase 2: Growth)

**Extended Work Types:**
- Spike/Explore work type (output = learnings doc, no PR)
- Review-Only work type (BMAD + QA on existing code)
- Audit work type (deep QA pass on specified scope)

**Advanced Learning System:**
- Nightly synthesis cron job (reads day's learnings, groups by theme, deduplicates, weighs by frequency/impact)
- Learning effectiveness tracking (did injected learnings reduce similar failures?)
- Automatic expiry detection for stale learnings
- claude-mem integration for cross-session human developer context
- Per-agent memory profiles with behavioral patterns (FR158)

**Advanced Agent Performance (extends MVP performance system):**
- ELO-style domain ratings with objective difficulty estimation (FR133)
- Capability tier assignment with progressive autonomy (FR134)
- Tier-based hook enforcement density (FR135)
- Weighted composite scoring for agent routing (FR136-R)
- Performance context in overlays (FR137)
- ELO-based story-to-agent routing (FR138)
- Performance dashboard cards (FR139)
- Manual tier override (FR141)
- Tier demotion criteria with hysteresis (FR161)
- ELO migration strategy with versioned epochs (FR162)
- Random audit mechanism for high-tier agents (FR169)
- Auto-remediation from goal-backward verification gaps (FR154)

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
- Copilot voice input (Web Speech API for speech-to-text)
- Copilot proactive suggestions with configurable notification level
- Copilot trust levels (reduced confirmation for non-destructive actions at high trust)
- Copilot access to learning records and meta-optimization journals for deep cross-source correlation

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
- Cross-project learning transfer via ELO portability
- Automatic Mulch expertise updates from factory observations
- Fine-tuning signal generation: the data infrastructure built in MVP (action scores, session composites, learning records, attribution chains) is the foundation for factory-specific model fine-tuning in Vision — eliminating 40–60% of overlay token overhead by encoding factory conventions into the model weights rather than injecting them at inference time
- Agent specialization routing — agents develop reputations and are routed specific task types based on domain ELO
- Federation: performance data portable between factory instances

### Risk Mitigation Strategy

**Technical Risks:**
- *Phase Boundary Protocol is greenfield, highest design risk* → Prototype and validate with a single story end-to-end before building dashboard. Test context isolation guarantee with adversarial scenarios.
- *Overlay composition may exceed token budgets* → Per-stage token budgets with hard caps. Progressive disclosure pattern from claude-mem. Fail-safe: truncate learnings (lowest priority) first, never truncate Superpowers.
- *Hook enforcement may slow agent throughput* → Benchmark hook execution time. Budget 2s max per hook point. Async where possible (post-edit hooks don't block next edit).

**Critical-Path Assumption Risks (must be resolved before architecture sprint begins):**

- *[ASSUMPTION-1] Pi SDK does not support 3-tier model switching or GLM-5 is unavailable natively.* Entire cost model collapses; economy-tier routing is the load-bearing assumption for NFR22, NFR6, NFR7, and the "quality feels free" differentiation claim. **Mitigation:** Pi SDK architecture spike (Spike 1) is mandatory in Week 1. Success criterion: written confirmation from Pi SDK with production API showing 3+ tier support and confirmed GLM-5 price. **Fallback if assumption fails:** Redefine economy tier as OpenRouter Gemini Flash; decouple economy-tier claim from Pi SDK GLM-5 specifically. Budget 1 week for fallback re-estimation if spike fails. **Gate:** Architecture sprint does not begin until Pi SDK 3-tier support is confirmed in writing or the Gemini Flash fallback is formally adopted.

- *[ASSUMPTION-2] Overstory SQLite cannot handle 15 concurrent agents without data loss or duplicate mail delivery.* All coordination architecture depends on Overstory as single source of truth for agent state, mail, and checkpoints. Silent write failures cascade. **Mitigation:** 15-agent concurrent stress test (Spike 3) before MVP development. Success criterion: zero data loss, exactly-once mail delivery confirmed across 5 runs with process kills. **Fallback if assumption fails:** Reduce concurrent agent ceiling to 8 (2x slower stories) or introduce an explicit locking layer above SQLite. Neither fallback requires architectural redesign of Factory Core; both require updated concurrency limits in `factory.yaml` and revised NFR17. **Gate:** No story may run through the factory until this test passes.

- *[ASSUMPTION-3] CopilotKit + AG-UI integrates into Bun/React dashboard without blocking SSE event streaming at 30fps with 12 active agent panels.* Dashboard is the control plane for Journey 2 (stall detection, nudge, inspect). If CopilotKit degrades dashboard performance, human-in-loop control is lost. **Mitigation:** CopilotKit + AG-UI feasibility spike (Spike 2) in Week 1. Success criterion: FPS > 28, SSE latency < 2.5s on 16GB machine during active chat streaming. **Fallback if assumption fails:** Move chat to separate browser tab (separate page/route, full state available but not co-located); or implement chat via WebWorker to isolate rendering pressure. Dashboard Copilot still ships in MVP in degraded UX mode. **Gate:** Dashboard Copilot epic does not begin without Spike 2 results; AG-UI-dependent FRs (FR107, FR113-FR115) have explicit deferral path documented in the FR section.

- *[ASSUMPTION-4] Phase Boundary Protocol manifest schema is insufficient to capture all real-world story metadata — agents create ad-hoc extensions mid-sprint.* Learning system cannot correlate patterns across stories; verification breaks; overlay enrichment delivers low-signal data. **Mitigation:** PBP manifest schema workshop in Week 1-2; 5-story pilot before MVP development begins. Success criterion: 5 pilot stories complete with schema capturing all required metadata without ad-hoc extensions. **Fallback if assumption fails:** 1-week schema iteration before MVP sprint 1, consuming buffer time. Last resort: living schema (agents define new fields), accepted with explicit acknowledgment that this breaks structural consistency and learning correlation. **Gate:** PBP v1 manifest schema validated on 5 pilot stories before Phase Boundary Protocol implementation begins.

- *[ASSUMPTION-5] BMAD review cycle exceeds 10 minutes for typical 1000-line story artifacts, stalling phase progression.* Phase progression gates on BMAD review completion (FR10, FR11). QA phase starts before BMAD findings are available; QA agents duplicate BMAD work; cost overrun; developer loses real-time feedback. **Mitigation:** BMAD latency baseline measurement in Week 2-3; 10 representative PRs timed end-to-end. Success criterion: median < 8 minutes, 90th percentile < 10 minutes, cost < 3% of story cost. **Fallback if assumption fails:** Accept slower phase progression with increased timeout; or run BMAD in parallel during development phase (async feedback, no phase-gate guarantee). Deferring mandatory BMAD to Growth is the nuclear option — loses quality safety net for MVP. **Gate:** BMAD latency distribution must be established before committing to the 10-minute phase-gate assumption in any SLA-bearing acceptance test.

**Resource Risks:**
- *2 developers, ambitious scope* → Critical path (Pi → Overstory → Hooks → Phase Boundary → Superpowers) on Developer A. Parallel track (Dashboard → Mulch → Learning) on Developer B. Integration point is well-defined.
- *If behind schedule* → Task work type can ship without full hook enforcement. Dashboard can launch with Factory Overview + Agent Windows only (defer Story Pipeline visualization). If AG-UI spike (Spike 2) fails, Dashboard Copilot ships as Ask mode only — deferred FRs (FR107, FR113-FR115) do not create schedule risk for the rest of MVP.

**Validation Gate Schedule (weeks are relative to project start):**

| Week | Developer | Activity | Gate Output | Blocks |
|------|-----------|----------|-------------|--------|
| 1 | Developer A | Spike 1: Pi SDK architecture + GLM-5 pricing | Pi SDK API contract confirmed; economy-tier price recorded | Item 1 (Pi SDK integration) |
| 1 | Developer B | Spike 2: CopilotKit + AG-UI feasibility | Dashboard performance baseline; AG-UI go/no-go decision | FR107, FR113-FR115 scope decision |
| 2 | Developer A | Spike 3: Overstory extension point validation | Extension contract inventory; fork-required list | Item 2 (Overstory extensions) |
| 2–3 | Both | PBP manifest schema workshop + 5-story pilot | PBP v1 schema validated | Phase Boundary Protocol implementation |
| 2–3 | Developer A | Overstory 15-agent SQLite stress test | NFR17 pass/fail; concurrency ceiling confirmed | Story execution go-live |
| 3–4 | Both | BMAD latency baseline: 10 representative PRs | 90th percentile latency established | Phase-gate timeout configuration |

*The architecture sprint (FR design and component interfaces) may proceed in parallel with Weeks 1-2 spikes. No production code is written until Spike 1 completes. The cost model documented in NFR22 and the economy-tier architecture are not considered validated until Spike 1 pricing data is recorded.*

**Burn-Rate Checkpoints (mandatory at 25%, 50%, 75% MVP story completion):**

At each checkpoint, evaluate actual developer-hours against plan and apply the deferral priority order if thresholds are breached. Checkpoint evaluation takes no more than 2 hours; output is a written record in `_bmad-output/planning-artifacts/checkpoint-[CP]-[YYYY-MM-DD].md`.

| Checkpoint | Burn-Rate Threshold Triggering Deferral Conversation | Deferral Priority Order (defer in order, stop when plan recovers) |
|---|---|---|
| **CP-25** (25% stories accepted) | Actual hours > 135% of projected hours at 25%, OR any single story > 3× its estimate | 1. FR105–FR119 (Dashboard Copilot) → 2. FR77–FR89 (Meta-Optimization) → 3. FR120–FR129 (Telegram) → 4. FR164–FR168 (Self-Learning extensions — last resort only; if reached, evaluate Pivot Trigger PT-3 first) |
| **CP-50** (50% stories accepted) | Cumulative hours > 150% of projected, OR projected completion extrapolation > 160% of original estimate | Apply CP-25 deferral table first (items not yet deferred). Then: 5. FR91–FR104 subset (resilience polish: FR92, FR98, FR100, FR102) → 6. FR130–FR132 (Agent Performance Data Collection — last resort; every week without delays Growth readiness equivalently) |
| **CP-75** (75% stories accepted) | Hours remaining for final 25% > 140% of projected remaining, OR any unresolved P0 bugs | Final SHIP/DEFER decisions — nothing enters the last sprint in ambiguous status. FR105–FR119 and FR77–FR89 receive explicit decisions. |

**Deferral rules:**
- All items deferred to Growth remain in the Growth feature set — deferral is a resource management decision, not a product cancellation.
- FR130–FR132 (Agent Performance Data Collection) deferral is a last resort: every week without these ~500 LOC of data collection delays Growth behavioral system (ELO, capability tiers) readiness by an equivalent amount.
- If items 1–3 are all deferred at CP-25 AND critical path is still RED, do not defer FR164–FR168 — escalate to Pivot Trigger PT-3 evaluation instead (see Appendix C).
- Any decision to defer a feature is logged in the checkpoint record with: rationale, affected FRs, Growth sprint that absorbs it, and sign-off from Steve.

See **Appendix C** for the full Go/No-Go Decision Framework including Gate 0 pre-start criteria, mid-development checkpoint protocols, MVP Launch Gate minimum viable FR set, pivot triggers (PT-1 through PT-5), and decision accountability matrix.

**Data Integrity Risks:**
- *Learning records lost on crash* → Atomic writes (write to temp, rename). Outcome-gated recording prevents garbage learnings.
- *Mulch conflicts between developers* → Standard git merge. `.mulch/` is append-mostly, conflicts are rare. When they occur, both entries are kept (human resolves semantic duplicates).

### Definitive MVP/Growth Split (FR130-FR171)

All 129 original FRs (FR1-FR129) retain their existing MVP/Growth designation. The revised and new FRs (FR130-FR171) are split as follows:

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

**Total MVP FRs: 145** (129 original + 16 new)
**Total Growth FRs: 26** (FR133-FR135, FR136-R, FR137-FR139, FR141, FR143-FR144, FR146-FR148, FR150-FR151, FR153-FR154, FR156-FR162, FR169)

### Session 7 Finding Resolution Summary

| Finding | Resolution | FR(s) |
|---------|-----------|-------|
| CONS-001 | Cost data read from attribution.db, not duplicated | FR132 |
| CONS-002 | pipeline.db is source of truth; no YAML primary store | FR130, Data Source of Truth |
| CONS-003 | L3 phase boundary hooks mandatory for ALL tiers | FR135 |
| CONS-004 | Per-turn uses lightweight signals, not full Nyquist | FR149, FR152 |
| SCOPE-001 | MVP: data collection (layers 1-3); Growth: behavioral (4-6) | FR133-FR135 deferred |
| SCOPE-010 | 16 new MVP FRs (not 31); 26 deferred to Growth | Definitive split table |
| COMP-001 | Demotion: ELO below threshold-50 for 3 stories | FR161 |
| COMP-002 | Credit economy KILLED | FR136 (killed) |
| COMP-009 | Versioned rating epochs | FR162 |
| COMP-011 | Nyquist=structural, BMAD=spec compliance | FR163 |
| TRANS-001 | Research repos are inspiration, not transplant | Component Relationship Model |
| TRANS-003 | Research repos are inspiration, not transplant | Component Relationship Model |
| TRANS-007 | Research repos are inspiration, not transplant | Component Relationship Model |
| PERV-001 | Resolution requirement alongside calibration | FR131 |
| PERV-002 | Scoring weights immutable without dev approval | FR137 |
| PERV-003 | Random audit: 1 in N stories for Tier 3+ | FR169 |
| PERV-004 | Bounded step function; penalties >3x median only | FR132 |
| ECON-001 | Credit economy KILLED; weighted composite scoring | FR136-R |
| ECON-002 | Per-story + global budget; per-role visibility only | FR142 |

All 19 critical findings resolved.

## Functional Requirements

This section defines THE CAPABILITY CONTRACT for the product. Every downstream artifact — UX design, architecture, epic breakdown, story implementation — will ONLY implement what is listed here. If a capability is missing from this list, it will not exist in the final product.

171 functional requirements organized across 19 capability areas. Each FR states WHAT capability exists, not HOW to implement it. FR130-FR171 state component integration, new-write LOC estimates, resolved findings, and design inspiration sources where applicable -- see Design Inspiration Reference appendix for pattern mappings.

**Scoping-to-FR Mapping** (for epic breakdown):

| Scoping Category | FR Capability Areas |
|---|---|
| Factory Core (The Brain) | Pipeline Execution, Overlay & Context Management, Resource & Economic Management |
| Agent Orchestration (via Overstory) | Agent Orchestration |
| Quality Pipeline | Quality Enforcement |
| 6-Layer Hook Enforcement | Quality Enforcement (FR14-FR20) |
| Dashboard | Dashboard & Observability |
| Factory Learning System | Factory Learning System |
| Developer Operations | Developer Operations & Setup |
| Superpowers Integration | Overlay & Context Management (FR33-FR34), Quality Enforcement (FR14) |
| Meta-Optimization | Meta-Optimization |
| Dashboard Copilot | Dashboard Copilot |
| Memory Layer | Memory & Knowledge |
| Git & PR | Git & PR Operations |
| Cross-Cutting Safety | Operational Safety, Resilience & Integrity |
| Developer Communication | Developer Communication Layer |
| Agent Performance System | Agent Performance Data Collection (FR130-FR132), Agent Performance Behavioral System (FR133-FR141) |
| Economic Governance | Economic Governance (FR142-FR146) |
| Orchestration | Orchestration (FR147-FR151) |
| Quality Verification | Quality Verification (FR152-FR155, FR163) |
| Memory & Learning | Memory and Learning Enhancements (FR156-FR160) |
| Self-Learning System | Self-Learning System (FR161-FR171) |

### Pipeline Execution

- **FR1:** Developer can submit one or more stories with story spec files and initiate factory processing without further manual intervention until PR creation
- **FR2:** Factory can decompose a multi-story epic into individual story executions with automatic dependency detection between stories
- **FR3:** Developer can manually override auto-detected story dependencies (confirm, reject, or reclassify)
- **FR4a (Worktree Isolation Mechanics):** Each story executes within its own git worktree, created by FR40, with no shared filesystem state between concurrently running stories. Agents in one story's worktree cannot read, write, or list files in another story's worktree directory. Isolation is verified at story start by asserting that the worktree path is unique and not a subdirectory of any active worktree. *Prerequisite: FR40 (worktree lifecycle).*

- **FR4b (Concurrency Scheduler and Cross-Story Contamination Prevention):** Factory Core maintains a concurrency scheduler that tracks all active stories against the configured maximum concurrent story count (`factory.yaml: max_concurrent_stories`). When capacity is reached, new stories enter the queue (FR104). The scheduler prevents cross-story git contamination by asserting that no two active stories share a target branch. Assignment uses atomic task checkout (FR145) to prevent race conditions between co-developer factory instances. *Prerequisite: FR4a, FR145 (atomic checkout).*
- **FR5:** Factory can assemble the correct pipeline phases for each work type (Story: 5-phase; Task: develop + PR) based on work type declarations
- **FR6a (Phase Transition Sequencing):** Factory Core can determine the correct phase transition sequence for each work type — which phase completes, which phase activates next, and what pre-conditions must hold before the next phase spawns. Phase transition sequencing reads the pipeline composition record (FR5) and the current story state from `pipeline.db`. *Prerequisite: FR5 (pipeline phase assembly).*

- **FR6b (Phase Boundary Manifest Construction and Transfer):** Factory Core can instruct the departing phase agent to construct a Phase Boundary Protocol manifest conforming to the FR32 canonical schema, validate it against FR18's 6-check gate, and make it available to the receiving phase agent's overlay (Stage 5 of FR28a). *Prerequisite: FR32 manifest schema artifact (Sprint 0), FR28a, FR18.*

- **FR6c (Fresh Agent Spin-Up with Clean Context):** Factory Core can spawn a fresh agent for the receiving phase with no access to the departing phase's development context — the receiving agent's overlay is assembled from the budget manifest (FR28a) using only the transfer manifest (FR6b) and role-appropriate learnings; no development phase artifacts, tool outputs, or conversation history are carried forward. *Prerequisite: FR6b, FR21 (agent spawn), FR28a.*
- **FR7:** Factory can execute a fix loop when BMAD review identifies defects, with a circuit breaker that halts after a configurable maximum iteration count and escalates to the developer
- **FR8:** Factory can create a pull request on GitHub with a structured evidence body containing development summary, BMAD findings (severity-tiered), QA results, coverage analysis, cost/model attribution, and factory instance identification
- **FR9:** Factory can execute the Task work type with a minimal pipeline (develop → PR, optional lightweight BMAD) and reduced agent team

### Quality Enforcement

- **FR10:** Factory can execute BMAD adversarial review with context-isolated fresh agents that have no access to development phase context
- **FR11:** BMAD review agents can categorize findings by severity (critical / warning / info) and produce a structured findings report
- **FR12:** Factory can execute a multi-wave QA swarm with configurable wave count and a configurable stopping threshold (e.g., N consecutive clean waves)
- **FR13:** QA swarm scouts can run on economy-tier models via Pi SDK native routing
- **FR14a (Hook Runner Infrastructure):** Factory Core includes a hook runner that maintains a registry of gate scripts, executes them at defined hook points (post-edit, post-task, phase boundary), captures stdout/stderr and exit codes, and returns a structured `HookResult` to the pipeline. Hook execution is isolated (no shared state between hooks). Hook registry is populated from Superpowers enforcement metadata (FR34). *This is the infrastructure story that blocks FR14b, FR14c, FR14d, FR15, FR16, FR17, FR18, FR19, FR94, and FR152.*

- **FR14b (Layer 2 Post-Edit Gates):** Hook runner executes post-edit gate scripts on file write events: file scope violation detection (FR15) and TDD file-pair warning (FR16). These gates fire inline during agent execution, not only at task completion. *Prerequisite: FR14a.*

- **FR14c (Layer 3 Post-Task Gates):** Hook runner executes post-task gate scripts on task completion events: test runner (pass/fail + coverage delta), lint check (zero-warning standard), and type-check (zero-error standard) (FR17). Results are passed to FR130's action-level process scoring. *Prerequisite: FR14a.*

- **FR14d (Layer 4 Phase Boundary Gates):** Hook runner executes the 6-check phase boundary gate checklist (FR18) as an atomic pass/fail: tests passing, lint clean, type-check clean, scope violations absent, TDD pairs present, manifest schema valid. All 6 checks must pass; any failure blocks phase transition and escalates to the fix loop (FR7) or developer. *Prerequisite: FR14a, FR32 manifest schema artifact (Sprint 0).*
- **FR15:** Post-edit hooks can detect file scope violations (writes outside assigned scope) and block the operation immediately
- **FR16:** Post-edit hooks can detect TDD violations (source file edit without corresponding test file edit) and send a warning to the agent via mail
- **FR17:** Post-task hooks can execute test runner, lint check, and type check on modified files and block task completion on failure
- **FR18:** Phase boundary hooks can enforce a gate checklist (full test suite, build, lint, type check, no uncommitted changes, transfer manifest schema valid) before allowing phase transition
- **FR19:** Hook enforcement results can appear inline in the agent's output stream as colored status banners
- **FR20:** Phase boundary gate results can be displayed as a checklist in the dashboard during phase transition

- **FR20a (Overstory Extension Prerequisites):** Before any Factory Core component that depends on Overstory extensions may be implemented, the following three extension contracts must be validated as achievable without forking Overstory (i.e., implementable via Overstory's public API or its documented extension mechanism):

  *(a) `learning_report` mail type registration.* Overstory's mail system must support registration of a new structured mail type (`learning_report`) without modifying Overstory's core mail type registry source. The `learning_report` type carries: `{from: agent_id, to: story_lead_id, type: "learning_report", payload: {finding_category, finding_text, affected_files, confidence_level, story_id, phase}}`. If Overstory does not support extensible mail types via a registration API, this type must be added to a maintained fork of Overstory, and the fork maintenance strategy (upstream sync policy, diff surface area) must be documented.

  *(b) Overlay injection point.* Overstory must accept a pre-composed overlay object from Factory Core's `overlay.ts` at agent spawn time and inject it into the agent's context without requiring Factory Core to understand Overstory's internal context assembly. The injection interface must accept: `{system_prompt: string, superpowers_skills: string[], mulch_priming: string, factory_learnings: string, phase_boundary_manifest: object, tier_directive: "economy" | "standard" | "premium"}`. If no such injection point exists in Overstory's current API, an extension PR must be scoped before the Pi SDK + Overstory integration story begins.

  *(c) Hook runner integration point.* Overstory's agent execution loop must expose hook invocation points at: `post-edit` (after each file modification), `post-task` (after each completed task), and `phase-boundary` (at each phase gate). Factory Core must be able to register hook scripts at these points via Overstory's configuration API (not by modifying Overstory's execution loop source). Each hook invocation must receive: `{hook_type, agent_id, story_id, phase, changed_files: string[], task_description: string}`. The hook must be able to return a `block` signal that halts the agent pending developer review.

  *Validation:* Spike 3 (see Validation Spikes section) must confirm all three extension contracts before FR21–FR27 implementation begins. If any contract requires a fork, the fork must be created and the diff surface area documented before the sprint begins — not discovered mid-sprint.

### Agent Orchestration

- **FR21:** Factory can spawn, monitor, stop, and replace agents through the Overstory coordinator
- **FR22:** Coordinator can automatically recover from a single agent crash by spawning a replacement (up to a configurable maximum attempts before human escalation) and dispatches a Telegram notification when messenger is enabled
- **FR23:** Agents can communicate via Overstory mail system (SQLite-backed), including standard message types and `learning_report` type
- **FR24:** Factory can checkpoint and resume long-running stories without data loss
- **FR25:** Developer can stop a specific agent from the dashboard
- **FR26:** Developer can send a nudge message to a specific agent via the dashboard, delivered through the mail system, with content logged for traceability in the story record
- **FR27:** Developer can inspect a specific agent's live output from the dashboard

### Overlay & Context Management

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
- **FR29:** Each overlay stage can priority-rank its items and truncate when exceeding its per-stage token budget allocation
- **FR30:** Factory Core can validate that total overlay plus estimated task requirement does not exceed the model's effective context limit before launching an agent
- **FR31:** If context budget check fails, Factory Core can split the task scope or escalate the model tier
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
- **FR33:** Superpowers skills can be injected into agent overlays for judgment-based self-policing
- **FR34:** Superpowers skill files with `enforcement` metadata in YAML frontmatter can be consumed by hook scripts for machine-validated gate enforcement
- **FR35:** Mulch expertise can be scoped to the agent's assigned file path and included in the overlay

### Resource & Economic Management

- **FR36:** Factory Core can assign model tier directives (economy / standard / premium) per agent role, with Pi SDK executing model selection natively. Pi SDK must return the resolved model identifier (e.g., `glm-5`, `claude-sonnet-4-5`, `claude-opus-4-6`) in every call response alongside token and cost data; Factory Core must record this identifier in `attribution.db` as the `resolved_model` field on each attribution record. This requirement is necessary for: (a) verifying that tier directives are honored by Pi SDK in practice, not just in configuration; (b) detecting silent tier escalations (Pi routing an economy-tier request to a standard-tier model due to model unavailability); (c) enabling NFR22 cost measurements to be segmented by actual model used rather than intended tier. If Pi SDK does not natively expose the resolved model identifier, Factory Core must implement a verification wrapper that queries Pi SDK's session metadata or logs to reconstruct model identity per call before storing attribution records.

  *Implementation dependency:* The Pi SDK integration spike (see Validation Spikes section) must confirm that Pi SDK exposes a resolved model identifier per call before FR36 implementation begins. If Pi SDK does not provide this, the spike must document the workaround approach and its reliability limitations.
- **FR37:** Factory Core can track token spend per story with phase-level allocation visibility
- **FR38:** Factory Core can enforce a per-story cost circuit breaker that halts the story when spend exceeds a configurable threshold and dispatches a Telegram notification when messenger is enabled
- **FR39:** Factory Core can enforce a daily global budget ceiling that pauses all non-critical work when exceeded and dispatches a Telegram notification when messenger is enabled
- **FR40:** Factory Core can manage worktree lifecycle (creation at story start, cleanup at story end — including failed, cancelled, and circuit-broken stories)
- **FR41:** Factory Core can detect and clean up orphaned worktrees on startup
- **FR42:** Every model API call can carry a full attribution chain (developer_id → story_id → phase → agent_id → model → provider → token_count → cost)

- **FR42a:** Factory Core can classify a story as "small" (development-phase token consumption below 40,000 tokens, or story scope limited to 1–3 files with no new module creation) and apply a reduced quality pipeline configuration for such stories: single-agent BMAD review (replacing the default 3-agent adversarial team), and a 2-wave QA swarm minimum (replacing the default 5-wave baseline). For small stories, the NFR22 quality cost threshold is replaced by the flat-rate ceiling defined in NFR22(a) ($0.10). Factory Core must log the applied pipeline configuration (standard vs. small-story) in the story manifest so quality cost measurements can be correctly segmented. Small-story classification must be performed during intake phase based on scope analysis, not retroactively. The developer may override small-story classification to force the full pipeline via `factory.yaml` (`quality.enforce_full_pipeline_min_files: N`).

  *Rationale:* Without this requirement, NFR22 creates a perverse incentive to avoid running the quality pipeline on small stories — which are often the most bug-prone due to rushed scope assumptions. The flat-rate ceiling preserves quality pipeline coverage on small stories while removing the misleading percentage metric where fixed overhead dominates.

### Dashboard & Observability

- **FR43:** Dashboard can display a Factory Overview showing system health, active stories, agent count, pipeline status, API key status, and token budget
- **FR44:** Dashboard can display Agent Windows with tiled panels showing per-agent status, live output via xterm.js, and token ticker
- **FR45:** Dashboard can display story pipeline phase progression with phase transition visualization and manifest validation indicators
- **FR46:** Dashboard can display cost tracking with model tier breakdown per story
- **FR47:** Dashboard can display stall detection indicators with type classification (logic loop / external wait / resource constraint) and diagnostic assistance summary, and dispatches a Telegram notification when messenger is enabled
- **FR48a (Overstory SSE Event Stream):** Dashboard establishes a Server-Sent Events connection to Overstory and receives all factory lifecycle events (agent spawned/stopped, phase transitions, hook results, stall events, cost updates, mail dispatched). The SSE connection carries a cursor; on reconnect, missed events since the last cursor are replayed (enabling FR50 and FR97). *This is the prerequisite for FR48b, FR48c, FR43, FR44, FR45, FR46, FR47, FR49, FR50, and FR97.*

- **FR48b (WebSocket Command Channel):** Dashboard establishes a persistent WebSocket connection to Factory Core for bidirectional command dispatch (stop agent, send nudge, reorder queue, approve/reject decisions). Commands sent via WebSocket are idempotent — duplicate commands (e.g., double-tap stop) are deduplicated by story/agent ID before execution. *Prerequisite: FR48a (Factory Core must be connected and serving before accepting commands).*

- **FR48c (Telegram EventStore Subscription):** The messenger package independently subscribes to the same Overstory EventStore that the SSE stream draws from, filtering for escalation-severity events and dispatching them via Telegram (FR120–FR128). This subscription is independent of the dashboard — Telegram notifications continue when the dashboard is offline. *Prerequisite: FR48a EventStore exists; can be developed in parallel with FR48b.*
- **FR49:** Dashboard can display budget projection per story showing projected phase cost versus budget across all remaining phases
- **FR50:** Dashboard crash does not halt agent execution — agents continue running under Overstory control, and dashboard reconnects with full state recovery on restart

### Git & PR Operations

- **FR51:** Factory can enforce git safety iron laws: never force-push, never commit to protected branches, factory-namespaced branch naming (`qds/<dev>/<story-id>`), structured commit attribution (`[QDS:<story-id>:<phase>]`). Additionally, the `/nudge` Telegram command — which injects instructions directly into a running agent's context — must require a two-step confirmation before execution: the developer sends `/nudge {story_id} {message}`, the bot responds with a preview of the nudge content and the target agent, and the developer must send a confirmation reply (`/nudge {story_id} confirm`) within 60 seconds for the nudge to execute. Nudge requests that expire without confirmation are silently discarded and logged. The `/approve` command for BMAD dismissals and circuit breaker overrides must use the same two-step confirmation pattern (`/approve {id}` → preview → `/approve {id} confirm`). This two-step requirement applies to both Telegram commands and to Act-mode copilot nudge/approve actions (FR108, FR109) which already require explicit confirmation via FR109.
- **FR52:** Factory can create PRs via `gh` CLI with structured evidence body including Pre-BMAD Mechanical Validation section (hook results), BMAD findings, QA results, and cost attribution
- **FR53:** Factory's PR evidence can include a coverage gap indicator ("Not Tested" section) listing files modified but outside QA wave scope
- **FR54:** Factory can observe CI pipeline results on PRs via `gh pr checks` (observe-only for MVP)
- **FR90:** Factory can automatically create a Seeds issue when a human leaves a comment on a factory-generated PR (filtering out bot, CI, and automation comments), tagged with the originating factory instance and auto-assigned to that developer's factory queue

### Factory Learning System

- **FR55:** Agents can write structured learning records (YAML) to `.qds/learnings/YYYY-MM-DD/` with crash-safe atomic writes (write to temp, rename)
- **FR56:** Learning records can carry story outcome tags (success / failed_bmad / failed_qa / cancelled), updated when the story completes
- **FR57:** Agents can send `learning_report` mail to the story lead during execution (Loop 1 — session-level tactical learning); the story lead's agent must receive the mail (readable from the Overstory mail table with `type = learning_report` and the correct `recipient` field), and if the learning report contains a `recommended_action` field, the story lead must acknowledge it (log an acknowledgment entry to the story run record) before proceeding to the next phase boundary. Acceptance criterion: inject a `learning_report` mail during an active story run; verify (a) the mail row exists in the Overstory mail table with `type = learning_report`, `sender = <originating_agent_id>`, `recipient = <story_lead_agent_id>`, and `status = delivered`; and (b) if the mail contains `recommended_action`, the story lead's next phase boundary transfer manifest contains an `acknowledged_learnings` array entry referencing the mail's `id`.
- **FR58:** Phase Boundary Protocol transfer manifests can include a `learnings` section carrying forward development phase struggles and discoveries (Loop 2 — cross-phase intelligence). The `learnings` section must be a structured list where each entry contains: `learning_id` (reference to the source learning record), `scope`, `category`, `summary` (≤ 100 tokens), and `tier`. Acceptance criterion for field correctness: after a development phase completes with at least one agent-generated learning record, inspect the phase boundary manifest and verify the `learnings` array is non-empty and each entry contains all required fields. Acceptance criterion for behavioral impact: for a scope that has at least 2 `critical`-tier cross-phase learnings in the transfer manifest, the BMAD reviewer agent's finding count in that scope must be demonstrably higher (≥1 additional finding on average across 3 comparable story pairs) when the `learnings` section is present in the manifest versus when it is absent (controlled by omitting the `learnings` field via test fixture). This verifies the learnings reach the BMAD agent and alter its scrutiny behavior, not merely that the field is populated.
- **FR59:** A manual synthesis script can read raw learning records, group by file scope, deduplicate, weight by story outcome, validate against Superpowers gates, and flag conflicts for human resolution, according to the following specified algorithms:
  - **Grouping key:** Records are grouped by the `file_scope` field in the learning record YAML. Records whose `file_scope` matches the same canonical path (normalized to repo-root-relative, trailing slash stripped) are placed in the same group.
  - **Deduplication algorithm:** Within each group, records are deduplicated using exact-match on `content_hash` (SHA-256 of the learning record's `content` field, after whitespace normalization). When duplicates are detected, the record with the highest outcome weight (see below) is retained; ties are broken by `recorded_at` descending (most recent wins). The rejected duplicate is logged to `.qds/learnings/synthesis-log/YYYY-MM-DD-dedup.log` with both hashes and the retention reason.
  - **Outcome weights:** `success=1.0`, `failed_qa=0.7`, `failed_bmad=0.5`, `cancelled=0.0`. Records with `cancelled` outcome weight are excluded from synthesis output entirely but are logged as excluded in the synthesis log.
  - **Conflict detection:** Two records within the same group are in conflict when their `content` fields contain semantically contradictory directives for the same file scope — defined as: both records assert a value for the same `directive_key` field and those values differ, OR one record's `category` is `constraint` and the other record directly negates it (as determined by a keyword-match rule against a configurable conflict-detection vocabulary in `factory.yaml`). Conflicting pairs are written to `.qds/learnings/conflicts/YYYY-MM-DD.yaml` and excluded from synthesis output pending human resolution; neither record is injected until the conflict is resolved.
  - **Prerequisite artifact:** Before FR59 implementation begins, a test fixture dataset of exactly 20 raw learning records must be authored and committed to `.qds/learnings/_fixtures/synthesis-test/`. The fixture must cover: known-duplicate records (same content hash), known-conflicting records (same directive_key, different values), records from each outcome category (success, failed_bmad, failed_qa, cancelled), records with iron law conflicts, and records with no issues. Expected synthesis output for each fixture case must be documented in `.qds/learnings/_fixtures/synthesis-test/EXPECTED.yaml`. The acceptance criterion for FR59 is: "Synthesis script produces output matching EXPECTED.yaml on the 20-record test fixture with zero discrepancies."
- **FR60:** Synthesis script can reject learnings that conflict with active Superpowers iron laws and log the rejection reason
- **FR61:** Overlay injection can match synthesized learnings to agent file scope and role, rank by injection score, and inject within hard token ceiling (500 tokens economy, 1000 tokens standard), according to the following specified algorithms:
  - **Scope-matching algorithm (authoritative priority order):** A synthesized learning is a candidate for injection if it matches the agent's assigned file scope by any of the following criteria, evaluated in priority order (highest to lowest): (1) **exact file path** — the learning's `file_scope` exactly matches the agent's assigned file path; (2) **directory prefix** — the learning's `file_scope` is a directory path that is a prefix of the agent's assigned file path (e.g., `src/payments/` matches an agent assigned to `src/payments/webhook.ts`); (3) **module match** — the learning's `file_scope` matches the module identifier declared in the agent's overlay `module` field; (4) **no match** — the learning is not a candidate for this agent. Role filtering is applied after scope matching: learnings tagged with a `role` field are only injected into agents whose role matches exactly. Learnings with no `role` field are eligible for any role.
  - **Injection ranking formula (single authoritative formula, supersedes Journey 5 narrative):** Candidates passing scope and role filtering are ranked by `injection_score = tier_weight × recency_factor`, where `tier_weight` is: `critical=3.0`, `recommended=2.0`, `informational=1.0`; and `recency_factor = 1 / (1 + days_since_recorded)` where `days_since_recorded` is the integer number of days between `recorded_at` and the current pipeline run date. Tie-breaking (equal `injection_score` to two decimal places) is resolved by `recorded_at` descending (most recent wins). `critical`-tier learnings are always injected first and are never truncated by the token ceiling; if critical-tier learnings alone exceed the ceiling, they are truncated at the ceiling boundary with a warning logged to the pipeline run record.
  - **Behavioral proxy acceptance criterion:** For a test story running in a scope that has 3 or more synthesized `critical`-tier learnings, the first-attempt post-task hook pass rate must be measurably higher than a baseline story run in the same scope with learning injection suppressed via the FR62 `spike`/`exploratory` escape hatch. "Measurably higher" is defined as: pass rate in the injected condition exceeds pass rate in the suppressed condition by ≥10 percentage points across a minimum of 5 story runs in each condition. This acceptance criterion must be verified before FR61 is considered complete.
- **FR62:** Stories tagged `spike` or `exploratory` can suppress learning injection entirely
- **FR63:** Developer can retract a synthesized learning with cascading retraction to all source records (preventing resurrection on next synthesis). Retraction mechanics: the `qds learnings retract <learning_id>` command must (a) set `retracted: true` and `retracted_at: <ISO8601>` on the synthesized learning record in `.qds/learnings/synthesized/`; (b) write a `retraction_tag: true` field to every source raw learning record that contributed to the synthesized learning (identified via the `source_record_ids` array on the synthesized record); and (c) log the full retraction event (synthesized ID, count of source records tagged, timestamp) to `.qds/learnings/synthesis-log/retractions.log`. Cascade retraction test (required acceptance criterion): after retracting a synthesized learning, re-run the synthesis script against the same source dataset; verify that (a) none of the retraction-tagged source records appear in the new synthesis output, and (b) no synthesized record with the retracted `learning_id` is regenerated. Verify by diffing the new `.qds/learnings/synthesized/` output against the pre-retraction snapshot — the retracted learning must be absent.

### Memory & Knowledge

- **FR64:** Mulch expertise files can carry timestamps, story provenance, and support content deduplication for parallel agent writes
- **FR65:** Seeds can serve as the factory-wide universal task graph, tracking all factory work items across developers
- **FR66:** `.mulch/` directory can be shared between developers via git using append-only format
- **FR67:** `.qds/learnings/` raw records can be shared via git with date-partitioned directories and per-agent filenames (no filename collisions between agents)
- **FR68:** Synthesized learnings (`.qds/learnings/synthesized/`) remain local to each developer (`.gitignore`d)

### Developer Operations & Setup

- **FR69:** A setup/install script can verify all dependencies (Bun, Rust toolchain, `gh` CLI with auth and repo scope), perform source project version alignment verification, and run resource pre-flight checks (RAM, CPU, disk)
- **FR70:** Each developer can configure their own API keys, model preferences, budget ceilings, learning injection level, and Telegram notification preferences (bot token, quiet hours, severity routing, DND bypass) via `config/factory.yaml`
- **FR71:** Each developer can run an independent dashboard instance viewing only their own active work
- **FR72:** Factory can attribute each PR to the generating developer's factory instance

### Operational Safety

- **FR73:** Factory Core can monitor disk usage, memory consumption, and token spend with configurable warning thresholds and hard limits (halt new story starts on disk critical, halt new agent spawns on memory critical, pause non-critical work on global budget exhaustion) and dispatches a Telegram notification when messenger is enabled
- **FR74:** When a single story's agents all crash, that story fails while other stories continue unaffected, and dispatches a Telegram notification when messenger is enabled
- **FR75:** When an API provider is fully down, all stories stall gracefully, the dashboard shows provider status, stories auto-resume when the provider returns, and dispatches a Telegram notification when messenger is enabled
- **FR76:** Factory never modifies `.gitconfig`, never changes remotes, never deletes branches it didn't create, never modifies `.gitignore` (except factory-specific entries during setup)

### Meta-Optimization (Factory Self-Improvement)

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
- **FR78:** The daily cron agent operates as observe-only — it reads operational data (attribution chain logs, overlay budget manifests, learning records, stall/recovery events, phase boundary transfer logs, BMAD/QA outcome data) and writes a journal, but makes no changes to factory configuration or behavior
- **FR79:** A weekly cron agent can read the last 7 daily journals, identify recurring patterns, distinguish signal from noise, and rank improvement opportunities by estimated impact. Recurring pattern is defined as: a named analysis dimension (as defined in FR77) that is flagged as anomalous in ≥3 of the 7 daily journals in the analysis window. "Flagged as anomalous" means the dimension's daily journal entry carries an `anomaly: true` field, set by the daily observer when the dimension's measured value exceeds its configured anomaly threshold (stored in `factory.yaml` under `meta_optimization.anomaly_thresholds.<dimension>`). Signal vs. noise: dimensions flagged in exactly 1 or 2 of 7 journals are classified as `noise` and recorded in the weekly report's `noise_observations` array but not eligible for optimizer action. Dimensions flagged in ≥3 of 7 journals are classified as `signal` and eligible for ranking and optimizer action. The weekly report must include a `pattern_detection_summary` field listing each dimension, its flag count (0–7), and its `signal` or `noise` classification.
- **FR80:** The weekly cron agent can select the single highest-impact improvement opportunity and implement a targeted change — operational parameters (prompt template adjustments, overlay composition rebalancing, context budget reallocation) apply normally; cost-impacting changes (tier policy updates, budget-affecting configurations) are flagged as "cost-impacting change" with elevated dashboard visibility. Impact scoring formula: each `signal`-classified recurring pattern (as defined in FR79) is assigned an `impact_score = recurrence_count × dimension_weight × magnitude_factor`, where:
  - `recurrence_count` is the number of days (1–7) the dimension was flagged as anomalous in the current analysis window.
  - `dimension_weight` is a configurable per-dimension weight in `factory.yaml` under `meta_optimization.dimension_weights.<dimension>` (default weights: `token_consumption=3.0`, `stall_rate=3.0`, `bmad_findings_per_story=2.5`, `qa_findings_per_story=2.5`, `hook_enforcement_overhead=2.0`, `overlay_stage_efficiency=1.5`, `context_window_utilization=1.5`, `phase_boundary_manifest_waste=1.0`, `model_tier_performance=1.0`).
  - `magnitude_factor = measured_value / anomaly_threshold` for the most recent daily journal entry where the dimension was flagged (ratio of actual value to configured threshold; always ≥1.0 for flagged dimensions).
  - The pattern with the highest `impact_score` is selected as the optimization target. Ties are broken by `dimension_weight` descending; remaining ties are broken by `recurrence_count` descending. The weekly report must include an `impact_scores` object listing the computed score for each signal-classified pattern, enabling human verification of the selection.
- **FR81:** The weekly optimizer focuses on one improvement per cycle — it does not attempt multiple changes simultaneously
- **FR82:** Each meta-optimization change is logged as a single lifecycle record in `.qds/meta/weekly/YYYY-WNN.yaml` containing: what was changed, why (evidence from daily journals), the revert payload (previous configuration state), expected impact, actual impact (updated by subsequent daily observers), and eventual status (active / reverted / confirmed)
- **FR83:** Meta-optimization changes are flagged in the dashboard as "Meta-Optimization Applied" with the rationale summary and a one-click revert control
- **FR84:** If daily journals following a meta-optimization change detect performance degradation using normalized metrics comparing like-for-like work, the next weekly optimizer cycle must auto-revert the change and log the reversion reason. Normalization and degradation are defined as follows:
  - **Normalization formula (authoritative):** `normalized_tokens_per_file = total_phase_tokens / count(files where line_delta > 10)`. `total_phase_tokens` is the sum of all Pi SDK token charges attributed to the story's development and review phases. `count(files where line_delta > 10)` is the count of files in the story's git diff where the absolute line delta (additions + deletions) exceeds 10 lines. Stories where this denominator is zero are excluded from normalization calculations (patch-only stories are not comparable).
  - **Like-for-like classification:** A story is comparable to another story for normalization purposes when both stories have the same `work_type` (Story or Task), both have `complexity_estimate` within the same bucket (small: 1–3 files, medium: 4–10 files, large: 11+ files), and neither is tagged `spike` or `exploratory`.
  - **Degradation threshold:** Degradation is triggered when the `normalized_tokens_per_file` for stories completed after a meta-optimization change is applied exceeds 1.5× the rolling average `normalized_tokens_per_file` of the last 5 comparable stories completed before the change was applied. The 1.5× threshold and the 5-story window are configurable in `factory.yaml` under `meta_optimization.degradation_threshold` and `meta_optimization.baseline_window` respectively.
  - **Auto-revert trigger:** The weekly optimizer evaluates the degradation condition on each run. If the condition is met and the story count in the post-change window meets the FR87 minimum threshold, it must: (a) execute the revert payload stored in the weekly record (restoring previous configuration state atomically), (b) update the lifecycle record `status` to `reverted` and set `reversion_reason = performance_degradation`, and (c) emit a dashboard alert classified as "Meta-Optimization Auto-Reverted" with the normalized metric delta displayed.
  - **Prerequisite test tool (blocking — must be built before FR84 implementation begins):** A cron time-injection utility `qds dev advance-cron <days>` must exist before implementation of FR84 begins. This utility replays the daily and weekly cron scheduler at accelerated rate against fixture journal data without requiring real elapsed time or real story completions. The acceptance criterion for FR84 using this tool is: "Given a fixture set of daily journals representing post-change stories with `normalized_tokens_per_file` exceeding 1.5× the pre-change baseline, running `qds dev advance-cron 7` must produce a weekly optimizer run that emits a revert action, updates the lifecycle record to `status: reverted`, and sets `reversion_reason: performance_degradation`."
- **FR85:** Daily journals and weekly optimization reports are stored in `.qds/meta/` with daily journals in `daily/YYYY-MM-DD.yaml` and weekly reports in `weekly/YYYY-WNN.yaml`
- **FR86:** The meta-optimization system operates within the factory's existing safety boundaries — changes cannot violate Superpowers iron laws, cannot modify git safety rules, cannot increase budget ceilings, cannot disable, remove, or bypass any hook enforcement layer; the optimizer can adjust hook execution parameters (timeouts, sensitivity thresholds) within defined ranges
- **FR87:** Weekly optimizer requires a configurable minimum story completion threshold across the 7-day window before proposing changes; below threshold, it writes an analysis report but makes no changes
- **FR88:** Meta-optimization changes carry a configurable effectiveness window (default 14 days); if the daily observer does not detect measurable improvement within the window, the change is auto-reverted and the improvement hypothesis is logged as "unvalidated". Measurable improvement is defined as follows:
  - **Metric and threshold:** The daily observer computes `normalized_tokens_per_file` (as defined in FR84) for each story completed after the meta-optimization change was applied. Measurable improvement is detected when the rolling average `normalized_tokens_per_file` over stories completed within the effectiveness window is ≥5% lower than the pre-change baseline (rolling average of last 5 comparable stories before the change). The 5% improvement threshold and baseline window size are configurable in `factory.yaml` under `meta_optimization.improvement_threshold_pct` and `meta_optimization.baseline_window`.
  - **Minimum sample size:** The effectiveness window evaluation requires a minimum of 3 comparable story completions within the window period before rendering a verdict. If fewer than 3 comparable stories complete within the window, the window is extended by 7 days (one extension only); if the minimum is still not met, the lifecycle record is set to `status: inconclusive` rather than triggering auto-revert.
  - **Auto-revert on expiry:** When the effectiveness window expires without measurable improvement (per the above definition and minimum sample size), the weekly optimizer must: (a) execute the revert payload atomically, (b) set `status: reverted` and `reversion_reason: effectiveness_window_expired` on the lifecycle record, (c) set `improvement_hypothesis: unvalidated`, and (d) emit a dashboard alert classified as "Meta-Optimization Auto-Reverted (Effectiveness Window Expired)."
  - **First-failure discovery risk (implementation note):** The first meta-optimization change may be applied on Day 1 of production operation. The earliest opportunity to verify that the effectiveness window auto-revert mechanism functions correctly is 14 days later. If the auto-revert mechanism has a bug, that bug will not be discovered for up to 14 days. **Mitigation required:** The `qds dev advance-cron <days>` time-injection utility (introduced as a prerequisite in FR84) must be used to acceptance-test FR88 in accelerated time before the first production meta-optimization change is applied. The acceptance criterion is: "Using `qds dev advance-cron 14` with fixture journals that contain no stories showing ≥5% improvement, verify the weekly optimizer produces a revert action with `reversion_reason: effectiveness_window_expired`." This test must pass before FR88 is marked complete.
- **FR89:** Dashboard can display a meta-optimization history timeline showing all changes applied, their rationale, measured impact, and current status (active / reverted / confirmed)

### Resilience & Integrity

- **FR91:** Factory can validate story spec files against a required schema at intake, rejecting malformed specs before pipeline launch with specific validation errors
- **FR92:** Factory can detect declared file contention between concurrent stories at story-start time and alert the developer via dashboard. *(MVP — feasibility confirmed; implementation approach: declaration-based, not runtime filesystem monitoring.)*

  **Implementation approach:** Stories declare their expected file scope in the story spec (file paths or glob patterns). At checkout time (FR145), Factory Core checks the declared scope of all active stories against the incoming story's declared scope. If overlap is detected, the developer receives a dashboard alert with the conflicting story IDs and file paths, and is offered three resolution options: (a) proceed anyway with a confirmed acknowledgment, (b) queue until the conflicting story completes, (c) cancel and revise story scope. Runtime filesystem monitoring (inotify/fsevents polling of actual file writes across worktrees) is deferred to Growth — the declaration-based approach catches the majority of real contention scenarios without per-file lock overhead.

  **Acceptance criteria:** (1) Two stories with overlapping declared file scope trigger a contention alert before either story starts execution. (2) The developer's resolution choice is logged in the story record. (3) Stories with no declared file scope overlap are not delayed by the contention check (check must complete in <100ms).
- **FR93:** Developer can dismiss a specific BMAD finding via dashboard, with the dismissal and rationale logged in the PR evidence body
- **FR94:** Hook execution has a configurable timeout; if a hook crashes or exceeds timeout, the system logs a warning and bypasses that hook invocation rather than permanently blocking agent progress
- **FR95:** Overlay assembly performs Mulch content integrity checks (schema validation, encoding verification) before injection; corrupted entries are excluded with a warning
- **FR96:** API calls without a complete attribution chain are blocked, not silently executed
- **FR97:** Dashboard SSE connection automatically reconnects on drop with state catch-up (replay missed events from Overstory since disconnect)
- **FR98:** Learning records have a configurable retention window (default: 90 days); records older than the window are archived to `.qds/learnings/archive/YYYY-MM/` to prevent unbounded disk growth. *(MVP — feasibility confirmed; implementation is a small story estimated at ~80 LOC.)*

  **Feasibility rationale:** At the expected generation rate of approximately 20–30 learning records per day at ~1KB each, 90 days of raw records accumulates to approximately 2–3MB. Disk risk is near-zero for the first year of operation. The archive script is a simple date-filter-and-move operation with no dependency on external services.

  **Acceptance criteria:** (1) Records older than the configured window are moved to archive on a daily cron schedule (runs alongside FR77). (2) The synthesis script (FR59) ignores archived records by default but accepts a `--include-archive` flag for historical analysis. (3) Archive operation is logged with record count moved.
- **FR99:** Developer can manually tag a factory-generated PR as "caused production issue," which feeds as a high-weight negative signal into the learning system and meta-optimization daily observer
- **FR100:** Meta-optimization system tracks cumulative configuration divergence from the factory's baseline configuration (the state at factory first-run or last explicit baseline reset). When total drift exceeds a configurable threshold, the dashboard flags "Significant Configuration Drift" with a full diff from original configuration and an option to reset to baseline. *(MVP — feasibility confirmed; implementation is estimated at ~120 LOC once FR82 lifecycle records exist.)*

  **Numeric drift threshold:** Drift is measured as the count of distinct configuration parameters that differ from baseline across all active meta-optimization changes (FR82 records with status "active"). The default threshold is **5 distinct parameter changes**. Each FR82 lifecycle record contributes its diff — if a parameter is changed and then reverted, it no longer counts toward drift. The threshold is configurable in `factory.yaml` (`meta_optimization.drift_threshold`, default: 5, minimum: 2).

  **Acceptance criteria:** (1) After 5 or more distinct configuration parameters have been modified by active meta-optimization changes (net of reverts), the dashboard displays a "Significant Configuration Drift" banner. (2) The banner includes a YAML diff showing all currently active changes vs. baseline. (3) "Reset to baseline" triggers FR101 (CLI revert) for all active changes in reverse chronological order. (4) A drift count of 4 or fewer produces no banner. (5) Reverted changes do not count toward the drift total.

  **Prerequisite:** FR82 (lifecycle records) must be implemented and populating `pipeline.db` before FR100 can compute drift.
- **FR101:** Developer can revert a meta-optimization change via CLI command as a fallback when the dashboard is unavailable
- **FR102:** BMAD review profiles are configurable per project (security-focused, API-contract-focused, performance-focused, or custom)
- **FR103:** Factory must never expose API keys, secrets, or credentials in any output: agent output, logs, learning records, PR evidence, dashboard displays, or committed files
- **FR104:** Factory can queue stories when concurrent count exceeds configured capacity, with FIFO default ordering and developer ability to reorder priority via dashboard

### Dashboard Copilot

- **FR105:** Dashboard includes a collapsible chat bar docked to the right edge that provides natural language access to all dashboard state, navigation, and controls via an AI copilot agent
- **FR106:** Copilot can operate in Ask mode — querying current dashboard state (story statuses, agent statuses, costs, pipeline positions, stall classifications) and presenting answers in the chat without modifying any state
- **FR107:** Copilot can operate in Investigate mode — programmatically navigating the dashboard UI (expanding story cards, focusing agent panels, highlighting elements, switching views) while presenting correlated findings from multiple data sources (Overstory state, learning records, meta-optimization journals, attribution logs, Mulch expertise). *Conditional on AG-UI feasibility spike (Spike 2):* If the CopilotKit + AG-UI spike demonstrates that bidirectional UI action streaming is available and performant in the target environment, FR107 ships in MVP. If the spike reveals AG-UI is unavailable, immature (draft spec, no stable SDK), or materially degrades dashboard performance, FR107 is deferred to Growth and the Copilot launches in Ask mode + Act mode only (FR106, FR108–FR112 remain in MVP scope unchanged).
- **FR108:** Copilot can operate in Act mode — executing dashboard controls (send nudge, stop agent, dismiss BMAD finding with rationale, reorder story queue) on behalf of the developer, with each action performed visibly through the UI so the developer sees exactly what happens
- **FR109:** Act mode requires explicit developer confirmation for all actions; the copilot states the proposed action and waits for "yes" / "y" / confirm button click before executing
- **FR110:** Copilot actions are performed through the same UI controls the developer uses — the copilot does not bypass the dashboard's control surface or access factory APIs directly
- **FR111:** CopilotKit `useCopilotReadable` hooks expose current dashboard state to the copilot: active stories, agent statuses, pipeline positions, budget/cost data, stall indicators, meta-optimization status, factory vitals
- **FR112:** CopilotKit `useCopilotAction` hooks expose dashboard controls to the copilot: expand/collapse story, navigate to agent, send nudge, stop agent, dismiss finding, show cost breakdown, show meta-optimization timeline, reorder story queue
- **FR113:** AG-UI protocol provides bidirectional streaming between the copilot agent and the dashboard — copilot sends UI action sequences, dashboard streams state updates back. *Implementation dependency:* The AG-UI protocol's actual message schema, transport layer (WebSocket vs. SSE vs. HTTP streaming), and SDK package must be identified and documented during Spike 2 before any FR113 implementation begins. If AG-UI Protocol is confirmed to be a CopilotKit-native feature (bundled in the CopilotKit SDK), no separate integration is required. If it is a separate package or draft standard requiring independent implementation, FR113 scope must be re-estimated before the Dashboard Copilot epic is sized. FR113 has no MVP fallback — if AG-UI is unavailable, FR113 does not ship; the copilot operates without bidirectional streaming and FR107/FR114/FR115 are deferred accordingly.
- **FR114:** Copilot can execute multi-step investigations — chaining navigation, data retrieval, and correlation across multiple stories, agents, and data sources in a single conversational turn. *Conditional:* Same AG-UI feasibility gate as FR107. Deferred to Growth if Spike 2 go/no-go fails.
- **FR115:** Copilot investigation steps are visible in the chat as action indicators that the developer can follow in real-time. *Conditional:* Same AG-UI feasibility gate as FR107. Deferred to Growth if Spike 2 go/no-go fails. Ask-mode responses (FR106) may include a simplified inline step summary as a non-streaming alternative, but this is not a substitute for the full FR115 requirement.
- **FR116:** Copilot maintains conversation context within a session — referent tracking ("What about Story 2?" after discussing Story 3), conversation history, and accumulated investigation state
- **FR117:** Copilot token usage is tracked separately from story budgets as a "copilot usage" line item in the attribution chain and cost tracking
- **FR118:** Copilot runs on economy-tier model (GLM-5) for conversational queries, with escalation to standard tier for complex multi-step investigations
- **FR119:** Copilot does not have access to modify factory configuration, agent overlays, meta-optimization parameters, or any factory internals — it operates the dashboard's existing control surface only

### Developer Communication Layer

- **FR120:** Factory can send escalation notifications via Telegram Bot API when Critical or Warning events occur, with MarkdownV2 formatting and inline keyboard action buttons corresponding to the available response actions for each escalation type
- **FR121:** Developer can send structured commands via Telegram to query factory state (/status, /stories, /story, /budget, /costs, /pending) and control story execution (/stop, /nudge, /approve, /reject, /dnd, /help) — with authentication via registered Telegram user ID
- **FR122:** Developer can submit stories via Telegram text message or file upload for factory intake *(Growth)*
- **FR123:** Factory can maintain async dialogue state for pending decisions in SQLite-backed storage with configurable per-escalation-type timeouts (default 4 hours) and conservative default actions on timeout (pause rather than stop, block rather than dismiss)
- **FR124:** Dual-channel action synchronization ensures idempotent execution — when a developer resolves an escalation from either dashboard or Telegram, the other channel reflects the resolution (Telegram message edited to show "Resolved via dashboard", dashboard notification marked with `resolvedVia: 'telegram'`) and duplicate actions are prevented via atomic SQL resolution
- **FR125:** Telegram notifications can respect quiet hours (configurable start/end time and timezone), DND mode (developer-activated via /dnd command), and per-severity routing preferences per developer — with critical severity bypassing DND by default
- **FR126:** Factory can send a daily morning summary via Telegram at a configurable time including overnight story completions, currently active stories, costs since last summary, pending decisions with time remaining, and current factory health status
- **FR127:** Telegram user authentication uses a one-time registration code flow — developer runs `qds telegram register` from CLI, receives a cryptographically random 8-character alphanumeric code (minimum 47 bits of entropy, generated via OS CSPRNG), sends `/register {code}` to the bot, and the bot maps the Telegram user ID to the factory developer ID. The registration code must: (a) expire after 10 minutes from generation, after which the developer must re-run `qds telegram register` to obtain a fresh code; (b) be displayed only in CLI terminal output and must never be written to log files, `pipeline.db`, or any file that could be committed or transmitted; (c) be consumed and invalidated immediately upon first successful use. The bot must apply silent drop (no response of any kind) to all `/register` attempts from a sender that has exhausted the per-sender rate limit (5 failed attempts per user ID per hour, per NFR33c); for non-rate-limited invalid or expired codes, the bot responds with a generic "registration failed" message that does not distinguish between wrong code, expired code, or unrecognized sender. All unregistered senders receive no response to commands other than `/register`, preventing bot discovery confirmation.
- **FR128:** Messages sent to the Telegram bot that do not match a structured command pattern can be classified by an economy-tier LLM into command intents, with classification cost tracked under a `system:messenger` attribution line and a configurable daily NL budget ceiling (default $1.00)
- **FR129:** Developer can submit PRD documents via Telegram file upload for factory intake processing *(Growth)*

### Agent Performance Data Collection

Each FR below states: what it delivers, which component it integrates with, what is genuinely new-write, which Session 7 finding it resolves (if any), MVP or Growth designation, and design inspiration source.

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

Composite scores are stored in `pipeline.db` table `session_composites`. Cost data for the composite is read from `attribution.db` (FR42), not duplicated.

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
**Resolves:** FAIL-001 (atomic checkout prevents the double-work race condition identified in the concurrency analysis).
**Design inspiration:** PaperclipAI `db/schema/agent_wakeup_requests.ts` claimedAt pattern.

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

### Self-Learning System (FR161-FR171)

#### FR161: Tier Demotion Criteria (Growth)

**Resolves: COMP-001**

When an agent's ELO rating drops below (tier_threshold - 50) for 3 consecutive stories, the agent is automatically demoted one tier. Demotion is logged in `pipeline.db` activity log with: previous tier, new tier, ELO trajectory, and triggering stories.

Hysteresis bands prevent tier boundary thrashing: promotion threshold and demotion threshold are separated by 50 ELO points, with a 3-story dwell requirement at the current tier before any transition. An agent promoted to Tier 3 (threshold 1350) would need to drop below 1300 for 3 consecutive stories to be demoted.

**Component integration:** Extends FR134 (tier assignment). Reads/writes `pipeline.db`.
**New-write:** Demotion evaluator with hysteresis (~100 LOC).
**Rationale for Growth:** Depends on FR133 (ELO) and FR134 (tiers).

#### FR162: ELO Migration Strategy (Growth)

**Resolves: COMP-009**

ELO ratings use versioned epochs. When the scoring algorithm changes (K-factor adjustment, new scoring dimensions, weight changes), a new epoch is created. Old ratings carry forward into the new epoch as initial estimates with inflated uncertainty (K-factor doubled for the first 5 stories in the new epoch).

Epoch metadata is stored in `pipeline.db` table `elo_epochs` with: epoch_id, algorithm_version, created_at, migration_notes. All rating records reference their epoch.

**Component integration:** Extends FR133 (ELO computation). Reads/writes `pipeline.db`.
**New-write:** Epoch migration manager (~120 LOC).
**Rationale for Growth:** Depends on FR133 (ELO system).

#### FR163: Nyquist-BMAD Disagreement Protocol (MVP)

**Resolves: COMP-011**

When structural verification (FR152) and BMAD review (FR10-FR11) produce conflicting assessments:

- **Nyquist pass, BMAD fail:** BMAD finding stands. Nyquist checks structural completeness (files exist, patterns present); BMAD checks spec compliance (correct behavior, proper implementation). A file can exist with the wrong implementation.
- **Nyquist fail, BMAD pass:** Nyquist finding stands for structural gaps (missing files, missing exports, broken integration links). BMAD may have reviewed existing code without noticing that a required artifact was never created.
- **Both fail on same item:** Findings are merged. The fix loop receives both the structural gap (from Nyquist) and the spec compliance issue (from BMAD) as a single remediation item.

The protocol is: **Nyquist is the tiebreaker for structural completeness. BMAD is the tiebreaker for spec compliance.** Neither overrides the other; they address orthogonal quality dimensions.

**Component integration:** Mediates between FR152 (verification) and FR10-FR11 (BMAD). Extends fix loop (FR7).
**New-write:** Disagreement resolver with finding merger (~100 LOC).

#### FR164: Maintenance Agent Learning Extraction (MVP)

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

#### FR165: Codebase Pattern Knowledge Accumulation (MVP)

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

#### FR166: Epic-Level Context Management (MVP)

When executing a multi-story epic, Factory Core maintains epic context across stories. Story N's overlay includes relevant learnings, decisions, and patterns from Stories 1 through N-1 within the same epic.

Epic context is assembled from:
- Phase Boundary Protocol manifests from completed stories in the epic
- Fix-loop findings from earlier stories (what went wrong and was corrected)
- File-level conventions established by earlier stories (naming patterns, architecture decisions)

Epic context is stored in `pipeline.db` table `epic_context` and injected as an additional overlay stage between Factory Learnings (Stage 4) and Phase Boundary manifest (Stage 5). Epic context has its own token budget (configurable, default 1000 tokens).

**Component integration:** Extends overlay composition (FR28). Reads from `pipeline.db`.
**New-write:** Epic context assembler with token-budgeted injection (~200 LOC).

#### FR167: Overlay Learning Enrichment (MVP)

Overlay composition pulls relevant learning records (Layer 1 codebase knowledge) and pattern knowledge (Layer 2, from FR165) when assembling agent overlays. Each session's overlay is richer than the last because it incorporates learnings from prior sessions working on the same codebase.

Learning enrichment follows this priority order within the Learning stage (Stage 4) token budget:
1. Preventable maintenance findings (FR164) matching the story's file scope
2. Pattern knowledge (FR165) matching the story's file scope with confidence >= 0.7
3. General codebase learnings matching the story's module/domain
4. Cross-story learnings from the current epic (FR166)

If the Learning stage token budget is exhausted, lower-priority items are truncated. The result is that the most actionable, highest-confidence learnings are always injected first.

**Component integration:** Extends overlay composition (FR28, Stage 4). Reads from `pipeline.db`.
**New-write:** Learning enrichment ranker with priority ordering (~150 LOC).

#### FR168: Maintenance Burden Tracking (MVP)

Factory Core tracks and categorizes all maintenance agent fixes (or manual maintenance logged via FR164) by:
- Story area (module/directory that introduced the issue)
- Issue category (preventable / unforeseeable / systemic)
- Time since story completion (how long until the issue surfaced)
- Fix cost (tokens consumed by the maintenance fix)

`pipeline.db` table `maintenance_burden` stores per-story-area maintenance records. Dashboard (Growth: FR139 extended) shows maintenance burden per story area trending over time. The success metric for the self-learning system is: maintenance burden per story area decreases over time as overlays incorporate learnings from prior maintenance fixes.

In MVP, maintenance burden is tracked via CLI-logged entries (FR164). In Growth, maintenance agents automatically populate this data.

**Component integration:** Reads from FR164 maintenance learnings. Writes to `pipeline.db`.
**New-write:** Burden aggregator with trending computation (~120 LOC).

#### FR169: Random Audit Mechanism (Growth)

**Resolves: PERV-003**

For agents at Tier 3 or above, 1 in N stories (configurable via `factory.yaml`, default N=3) receives full Tier 1 hook density regardless of the agent's tier. Audit stories are selected randomly using a deterministic seed (story_id hash) so audits are reproducible but unpredictable.

Audit story results are scored with elevated weight (configurable, default 1.5x) in the ELO computation (FR133). If an audit story reveals quality issues that the agent's normal tier density would have missed, this feeds into demotion evaluation (FR161).

This prevents the progressive autonomy death spiral where high-tier agents get fewer hooks, producing fewer data points, leading to lower confidence in ratings, and inability to detect quality degradation.

**Component integration:** Extends FR135 (hook density). Feeds FR133 (ELO) and FR161 (demotion).
**New-write:** Audit selector with deterministic randomization (~80 LOC).
**Rationale for Growth:** Depends on FR134 (tier system) and FR135 (hook density).

#### FR170: System Health Circuit Breaker (MVP)

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

#### FR171: Multi-Channel Notification Abstraction (MVP: Telegram, Growth: additional channels)

Factory Core's notification system uses a channel abstraction layer:

- **Channel base class:** defines `send(message)`, `receive()`, `formatMessage(event)`, and `getStatus()` interface
- **MessageBus:** pub/sub event distribution that routes factory events to subscribed channels
- **TelegramChannel:** first implementation, wrapping existing FR120-FR129 functionality

The MessageBus replaces direct EventStore polling by each notification consumer. Factory events (escalations, completions, budget warnings, health alerts) are published once to the MessageBus; subscribed channels receive and format them independently.

MVP ships TelegramChannel only. Growth adds SlackChannel, DiscordChannel, or EmailChannel as zero-architecture-cost additions -- implementing the Channel interface and registering with the MessageBus.

**Component integration:** Wraps FR120-FR129 (Telegram). Extends FR48 (event streaming).
**New-write:** Channel interface + MessageBus (~150 LOC), TelegramChannel adapter (~100 LOC).
**Design inspiration:** DeerFlow `modules/channel/` MessageBus, Channel base class architecture.

## Non-Functional Requirements

Quality attributes that specify HOW WELL the system must perform. Only categories relevant to QDS Engineer v2 are included — scalability, accessibility, internationalization, and compliance are intentionally excluded (internal tool for 2 developers, not regulated industry, not public-facing).

40 NFRs across 4 categories. Each NFR is specific, measurable, and testable.

### Performance

- **NFR1:** Dashboard SSE event latency from Overstory state change to dashboard render must be under 2 seconds as measured by timestamp delta between Overstory SQLite write and dashboard DOM update
- **NFR2:** Hook execution (post-edit, post-task) must complete within 2 seconds per hook invocation as measured by hook runner timing logs; hooks exceeding this threshold trigger the timeout bypass per FR94
- **NFR3:** Phase boundary gate checklist (all 6 checks: tests, build, lint, type check, uncommitted changes, manifest validation) must complete within 60 seconds total as measured by gate runner aggregate timing. This ceiling applies to the common case: a project with a test suite completing in under 30 seconds on uncontested hardware. For projects with longer test suites, the ceiling scales to `(project_test_suite_duration + 30s)`.

  **Implementation requirement:** The gate runner must execute independent checks in parallel. Tests and lint are independent; type check and build are independent of lint; uncommitted-changes and manifest-validation checks are I/O-only and must run concurrently with all other checks. Parallelizing independent checks is mandatory — a sequential gate runner cannot satisfy the 60-second ceiling on 4 cores under concurrent story load.

  **CPU over-subscription note:** Phase boundary storms (multiple stories reaching gates simultaneously) cause CPU over-subscription on the 4-core hardware target. Individual check durations can multiply 3–5x under contention. The gate runner must enforce per-check timeouts to prevent stalls: test suite ≤45s, build ≤20s, lint ≤10s, type check ≤15s, uncommitted-changes ≤5s, manifest-validation ≤5s. If a check exceeds its individual timeout, the gate fails immediately with a "check timeout" status rather than waiting for the 60-second aggregate ceiling. If hardware cannot support parallelized gate execution, NFR25's hardware recommendation must be updated (see NFR25 amendment).
- **NFR4:** Overlay composition pipeline must assemble a complete agent overlay (all 6 stages) within 500ms, with overlay source files cached in memory after first read, as measured by `overlay.ts` timing instrumentation
- **NFR5:** Dashboard must maintain 30fps minimum render rate with up to 15 active xterm.js agent panels on a machine with 16GB RAM, as measured by browser Performance Monitor capturing frame timing across a 30-second window. The 30fps guarantee applies to all panel counts up to 15 (matching the maximum concurrency defined by NFR17). For panel counts 13–15, the implementation must use xterm.js viewport virtualization and throttled DOM flush (≤30 DOM updates per second per terminal) to stay within the browser render-thread budget; this rendering strategy is the accepted mitigation for C2 (SQLite WAL pressure vs. dashboard render). Verification must use a synthetic agent stub (`qds dev synthetic-agent`) that drives xterm.js output at a realistic rate (200–500 bytes/second per terminal) — real concurrent agents are not required to pass this test. The synthetic stub requirement exists because real 15-agent factory runs are not reproducibly achievable in a unit/integration CI environment.
- **NFR6:** Daily meta-optimization cron agent must complete its analysis and write the daily journal within 10 minutes of execution, consuming no more than $0.50 in model API costs per run (assumes economy-tier model)
- **NFR7:** Weekly meta-optimization cron agent must complete its analysis, selection, and change implementation within 30 minutes, consuming no more than $2.00 in model API costs per run (assumes economy-tier model)
- **NFR8:** Copilot response latency for Ask-mode queries must be under 3 seconds from message send to first response token as measured by chat component timing instrumentation, under normal network conditions.

  **Scope clarification:** The 3-second target is an end-to-end wall-clock measurement and includes model provider network round-trip time. Because model provider latency is outside factory control, this NFR is a user-experience target, not an implementation correctness guarantee. The factory's obligation is: (a) add no more than 200ms of local processing overhead between user message send and Pi SDK request dispatch, and (b) begin streaming the first token to the chat bar UI within 100ms of receiving the first token from Pi SDK.

  **Verification method:** The 3-second end-to-end target is verified by acceptance testing against the configured provider under normal load — not by unit or CI tests, which must use mock Pi SDK responses. The local overhead targets (200ms dispatch, 100ms first-render) are the CI-verifiable acceptance criteria for this NFR.

  **Render thread protection:** Copilot Ask-mode streaming must use a dedicated `requestAnimationFrame` queue for SSE token delivery to the chat bar, preventing LLM stream chunks from preempting xterm.js terminal renders in the browser event loop. This is the accepted mitigation for conflict C10.

### Security

- **NFR9:** API credentials stored in `factory.yaml` must never be readable by any agent process via any access path — including direct filesystem reads, Pi SDK tool calls, environment variable inspection, or process memory access. Pi SDK mediates all model API access; agents interact with Pi, never with providers directly. Factory Core must provide credentials to Pi SDK via in-process configuration struct at startup, never via environment variable or command-line argument, so that credentials are not present in the subprocess environment inherited by agents and hook scripts. This requirement is the first line of a defense-in-depth chain: NFR11 (filesystem scope) and NFR-SEC-05 (environment sanitization) provide additional enforcement layers.
- **NFR10:** No API key, secret, or credential may appear in any factory output: agent stdout/stderr, Overstory logs, learning records, PR evidence body, dashboard rendered content, committed files, `.qds/meta/` journals, or Telegram outbound messages — as verifiable by automated credential scanning on all output paths. Credential scanning must cover: (a) known API key patterns by provider (Anthropic `sk-ant-*`, Telegram bot token format `\d+:[A-Za-z0-9_-]{35}`, GitHub token formats `ghp_*` / `gho_*` / `github_pat_*`); (b) generic high-entropy string detection (Shannon entropy > 4.5 bits/character for strings longer than 20 characters); and (c) fragments of known credentials (prefix or suffix matches). Scanning must run as part of the factory's startup health check and as a pre-commit hook on all factory-initiated commits, not only in CI.
- **NFR11:** Agent filesystem access must be restricted to the assigned worktree and explicit scope, enforced at the OS level — not solely at the application level. For MVP on macOS, enforcement must use `sandbox-exec` (macOS Sandbox) profiles or Bun's `--allow-read`/`--allow-write` permission flags with explicit scope allowlists; on Linux, `seccomp` profiles or equivalent OS-level restrictions apply. Whichever mechanism is used must be specified in the architecture document and verified by an integration test that attempts path traversal (`../../`) from a sandboxed agent process and confirms the attempt is blocked with an access denied error. Application-level path canonicalization (resolving symlinks before scope check) must be applied in addition to, not instead of, the OS-level enforcement. Post-MVP for B2B deployment: evaluate full container isolation (Docker/Podman) per agent.
- **NFR12:** `factory.yaml` must be excluded from version control via `.gitignore` and must have file permissions `600` (owner read/write only, no group or world access). The setup script must: (a) create `factory.yaml` with `600` permissions, (b) verify `.gitignore` exclusion and halt with an error if `factory.yaml` is tracked by git, and (c) verify file permissions on every startup and emit a warning (non-halting) if permissions are broader than `600`. The setup documentation must warn developers that backup software (Time Machine, iCloud Drive, Dropbox) may copy `factory.yaml` to cloud storage and recommend excluding the factory config directory from backup sync.
- **NFR13:** Factory branch operations must be restricted to the `qds/` namespace — any factory attempt to create, modify, or delete a branch outside `qds/<dev>/` must be blocked at the Factory Core level before the git command executes. Additionally: (a) the setup script must verify that the authenticated GitHub token has only the minimum required scopes (`contents:write` and `pull_requests:write` on the target repository); where possible, a fine-grained Personal Access Token (PAT) scoped to the specific target repository is strongly preferred over a classic OAuth token with broad `repo` scope; (b) the setup documentation must require that the target repository have GitHub branch protection rules configured — no force push to any branch, require pull requests for merges to the default branch, and require status checks — as an independent enforcement layer the factory cannot bypass; and (c) the setup script must check for branch protection rules via `gh api` and warn the developer if they are not configured.

*Defense-in-depth security extensions (STRIDE Threat Model Response):*

- **NFR-SEC-01:** Agent subprocess filesystem access must be enforced at the OS level using platform-appropriate sandboxing — macOS `sandbox-exec` profiles or Bun `--allow-read`/`--allow-write` permission flags with canonicalized path allowlists on macOS; Linux `seccomp` or equivalent on Linux. The sandboxing mechanism must be: (a) specified by name in the architecture document, (b) applied uniformly to all agent subprocesses and hook scripts spawned by Factory Core, and (c) verified by an automated integration test that spawns a sandboxed subprocess, attempts to read a file outside the permitted scope using both absolute paths and relative path traversal (`../../`), and asserts that both attempts are blocked at the OS level with an access denied error. Application-level path canonicalization is required in addition to OS-level enforcement to defend against symlink traversal. Post-MVP for B2B deployment: evaluate container-based isolation (Docker/Podman) per agent process as the enforcement mechanism.

- **NFR-SEC-02:** `factory.yaml` must have file permissions `600` (owner read/write only) at all times. The setup script must create the file with `600` permissions. Factory startup must verify permissions before reading credentials and must: halt with an error message if `factory.yaml` is world-readable (`o+r`) or group-readable (`g+r`) — a broadly readable credentials file is a hard stop condition, not a warning. The startup verification check must be present even if the `chmod` was applied correctly at setup time, to guard against external tools that may reset permissions. This requirement is in addition to the `.gitignore` exclusion requirement in NFR12.

- **NFR-SEC-03:** Dashboard SSE and WebSocket endpoints must require a session authentication token for all connections. Factory Core must generate a cryptographically random UUID v4 session token at startup, display it once in CLI output, and require it as either a query parameter (`?token=...`) or an `Authorization: Bearer` header on all dashboard SSE and WebSocket connection requests. Connections without a valid token must be rejected with HTTP 401. The token is rotated on factory restart; previous tokens are immediately invalidated. The dashboard server must bind exclusively to `127.0.0.1` (localhost) — binding to `0.0.0.0` or any externally routable interface is prohibited unless an explicit `--remote-dashboard` flag is passed at startup, which must emit a prominently visible security warning. WebSocket connection count from a single source address must be limited to 5 concurrent connections to prevent connection-flood degradation. Verifiable by integration tests confirming rejected unauthenticated connections and localhost-only binding.

- **NFR-SEC-04:** All external content incorporated into agent context — codebase files read for context, Mulch expertise loaded from `.mulch/`, learning records loaded from `pipeline.db`, and phase boundary transfer manifests — must be explicitly framed as untrusted data using structural delimiter tags in the overlay assembly. The overlay system prompt must instruct agents that content within `<codebase_file>`, `<mulch_content>`, and `<learning_record>` tags is external data to be treated as code or documentation, not as instructions, regardless of what that content contains. Learning records must additionally pass an instruction-syntax sanitization pass before synthesis that detects and rejects records containing text resembling model instruction syntax (e.g., patterns matching `<instruction>`, `SYSTEM:`, `Human:`, `Assistant:`, `\[INST\]`). Records flagged by sanitization must be quarantined in `pipeline.db` with a `sanitization_hold` status and generate a dashboard alert for developer review before injection. The Superpowers gate validation (FR60) must be extended to enforce this sanitization check as a required synthesis gate. Verifiable by unit tests that confirm sanitization detection of known injection patterns and integration tests that verify delimiter framing in assembled overlays.

- **NFR-SEC-05:** All agent subprocess and hook script environments must be sanitized before spawn to remove all credential-bearing variables. Factory Core must construct an explicit environment allowlist for each subprocess — containing only `PATH`, runtime binary paths (node, bun), and explicitly non-sensitive project configuration — and pass this allowlist as the complete environment for the spawned process. No Pi SDK keys, GitHub tokens, Telegram tokens, or other credential values present in the Factory Core process environment may be inherited by agent subprocesses, hook scripts, or any spawned child process. API credentials must be provided to Pi SDK via in-process configuration struct at Factory Core startup, never via environment variable or command-line argument, so credentials are not present in the process environment to begin with. Pi SDK's startup behavior regarding credential persistence to disk must be documented in the architecture document; if Pi SDK writes credentials to a local config file for session persistence, that file must be governed by NFR-SEC-02's `600` permission requirement and added to the NFR12 `.gitignore` exclusion list. Verifiable by integration tests that spawn a hook subprocess and assert that credential environment variables are absent from the subprocess's environment.

- **NFR-SEC-06:** Raw learning records must have SHA-256 checksums recorded in `pipeline.db` at write time. The synthesis pipeline (FR59, FR60) must verify each source record's checksum before processing. Any checksum mismatch must quarantine the affected record with a `checksum_fail` status in `pipeline.db`, exclude it from the current synthesis run, and generate a dashboard alert for developer review — the synthesis run must continue with the remaining valid records rather than halting. Mulch expertise files loaded from `.mulch/` must be verified against a checksum registry in `pipeline.db` (populated at factory startup file scan) before inclusion in any agent overlay; files not present in the registry are loaded with a warning, not silently, to detect newly added files that have not been reviewed. Note: checksums prevent undetected accidental corruption and significantly raise the bar for deliberate file-level tampering; they do not protect against an attacker who can also modify `pipeline.db`, which requires OS-level process isolation (NFR-SEC-01) as the primary defense against co-resident malicious processes.

- **NFR-SEC-07:** Weekly optimizer proposed changes must pass independent schema validation before application. The validation pass must: (a) be implemented as a separate Factory Core component with no shared code path with the optimizer agent itself, (b) validate the proposed change against a static, hardcoded allowlist of modifiable parameters (overlay efficiency settings, injection level thresholds, phase timeout multipliers), and (c) reject any change that references a parameter not on the allowlist — including any change to iron laws, git safety rules, budget ceilings, hook layer definitions, or agent scope restrictions — with an immediate halt and dashboard alert. Optimizer outputs must use a schema-validated structured format (not freeform YAML) parseable by the validator before the optimizer's output is even read by Factory Core for application. Weekly optimization journal files (`YYYY-WNN.yaml`) must be written once in append-only mode; reverts generate a new journal entry documenting the revert and the revert reason — the original entry is never overwritten or deleted. Verifiable by unit tests that present a change targeting a prohibited parameter to the validator and assert rejection, and by an append-only write test that confirms journal file monotonic growth.

- **NFR-SEC-08:** Phase boundary transfer manifests written to the filesystem between pipeline phases must include an HMAC (HMAC-SHA256) computed using a factory-instance-local key generated at startup and held only in Factory Core process memory. The receiving agent must verify the HMAC before parsing any manifest content; a verification failure must cause the receiving agent to reject the manifest, halt the phase transition, and escalate to the developer via dashboard alert rather than proceeding with potentially tampered transfer data. Manifests must be deleted from the filesystem immediately after the receiving agent has successfully verified and parsed them — no manifest file may be retained after the phase transition it served. Manifest deletion is a required step in the phase transition handshake, not an optional cleanup. Verifiable by integration tests confirming HMAC verification failure on a tampered manifest and file deletion confirmation after successful parse.

- **NFR-SEC-09:** Factory setup script must verify GitHub token scope and target repository protection state before first use: (a) verify that the authenticated token is scoped to the minimum required permissions — if the token has broad `repo` scope (all repositories), the setup script must emit a warning recommending creation of a fine-grained PAT scoped to the specific target repository only; (b) verify via `gh api /repos/{owner}/{repo}/branches/{branch}/protection` that the target repository's default branch has branch protection rules enabled — specifically: no force push to any branch, require pull request reviews before merging to default branch, and require status checks; (c) if branch protection rules are absent, the setup script must emit a prominent warning (not a hard stop, as the developer may not have admin rights on all repos) explaining the security implication and providing the GitHub UI path to configure protection. These checks must also run as part of factory startup health verification. Verifiable by setup script tests that simulate both compliant and non-compliant token scopes and protection configurations and assert the correct warning or pass behavior.

- **NFR-SEC-10:** Every Telegram message received by the factory bot — authenticated or not — must be logged to an append-only table in `pipeline.db` (`telegram_command_log`) containing: Telegram message ID, sender Telegram user ID, UTC timestamp, raw message text, parsed command intent (or `UNRECOGNIZED`), authentication result (`AUTHORIZED` / `UNAUTHORIZED` / `RATE_LIMITED`), and execution result. Log entries must never be deleted or updated — subsequent state changes are recorded as additional entries. This log is the authoritative record for command repudiation investigations. Verifiable by integration tests confirming log entry creation for all inbound message paths including rejected, rate-limited, and unauthenticated messages.

### Reliability

*Crash recovery:*
- **NFR14:** Coordinator must detect agent crash within 10 seconds and spawn a replacement within 30 seconds of detection, as measured by timestamp delta between agent process exit and replacement agent first output
- **NFR15:** After factory process restart, all in-progress stories must resume from last checkpoint with zero data loss — no completed phases re-executed, no learning records lost, no duplicate commits — as verified by crash-and-resume integration testing.

  **Machine-checkable invariant:** The crash-and-resume integration test must assert all of the following post-resume conditions:
  1. A full SQLite dump of all `completed_phases` rows in Overstory's database after resume must be byte-for-byte identical to the pre-crash dump of the same rows. No rows may be added, removed, or modified for phases that were complete at the time of the crash.
  2. All learning record files present in `.qds/learning/` before the crash must still be present after resume, with identical content (verified by SHA-256 hash comparison). No learning records written before the crash may be absent or modified after resume.
  3. All learning record files present after resume must pass the learning record schema validation (same validator used in NFR40's extraction pipeline). No partially-written records may survive a crash.
  4. The git commit log must contain no duplicate commits for any story that was in progress at the time of the crash.

  These four assertions must be automated and must run as part of the factory's integration test suite via the `qds dev crash-agent` utility.

*Data integrity:*
- **NFR16:** Learning record writes must be atomic (write to temp file, rename to final path) — a factory process crash at any point during a learning write must not produce a corrupted or partial learning file, as verifiable by crash injection testing
- **NFR17:** Overstory SQLite must handle concurrent read/write from up to 15 agents without data loss, silent write failures, or corruption — as verifiable by concurrent stress testing with write contention scenarios.

  **Concurrency definition:** "15 concurrent agents" means 15 simultaneously active agent state machines in the Overstory process, each with a live logical SQLite connection context. This does not mean 15 independent OS processes each holding an open SQLite file descriptor; the Overstory Rust process is the single SQLite writer, with agents communicating via the Overstory API. The 15-agent ceiling is a logical concurrency limit on the Overstory state machine, not a process-count limit.

  **WAL configuration requirement:** Overstory's SQLite instance must be configured with `PRAGMA wal_autocheckpoint = 2000` (checkpoint after 2,000 WAL pages, ~8MB) to reduce checkpoint frequency and shift checkpoint work to lower-activity periods. The default SQLite WAL autocheckpoint threshold of 1,000 pages can trigger 100–500ms write stalls under 15-agent write load, threatening NFR18's 1-second mail delivery guarantee and NFR1's 2-second SSE latency.

  **Relationship to NFR5:** At 15 concurrent agents, the dashboard will display up to 15 xterm.js panels. NFR5 now defines the 30fps guarantee for up to 15 panels (amended above). The two NFRs are explicitly reconciled: the concurrency ceiling (NFR17: 15 agents) and the render guarantee (NFR5: 30fps at up to 15 panels) are consistent.
- **NFR18:** Overstory mail delivery must guarantee exactly-once delivery — a message sent via the mail API must be readable by the recipient within 1 second, with zero lost messages and zero duplicate deliveries, as verified by concurrent mail send/receive stress testing

*State recovery:*
- **NFR19:** Dashboard reconnection after SSE drop or dashboard restart must restore complete state within 5 seconds, including all active story statuses, agent statuses, and phase positions — with zero state loss as verified by comparing pre-disconnect and post-reconnect state snapshots
- **NFR20:** Meta-optimization revert (FR83, FR101) must restore the exact previous configuration state — no partial reverts, no orphaned configuration fragments — as verifiable by diffing pre-change and post-revert configuration snapshots

*Cleanup:*
- **NFR21:** Worktree cleanup (FR40, FR41) must complete for all story termination paths (success, failure, cancellation, circuit breaker) — no orphaned worktrees after 24 hours of factory operation as verified by startup orphan detection scan

*Economics:*
- **NFR22:** Quality pipeline cost (BMAD review + QA swarm phases combined) must not exceed 5% of development-phase cost per story, OR $0.05 per story, whichever is greater — as measured by attribution chain cost aggregation per phase in `attribution.db`.

  **Minimum floor rationale:** For Task work types with short development phases (estimated cost < $1.00), the 5% ceiling would require BMAD + QA to cost under $0.05, which is below the minimum cost of a single economy-tier LLM call. The `max(5% of dev cost, $0.05)` formula prevents the NFR from being violated by design on small stories.

  **Verification sample requirement:** This NFR is considered verified when the 5%-or-floor ceiling holds across ≥10 MVP stories using a standard agent team configuration, covering at least one story of each work type (Task, Feature, Bug) in the sample.

  **Pricing assumption:** The 5% ceiling is calibrated against GLM-5 economy-tier pricing as of 2026-03-14. If the economy-tier model pricing changes by more than 3× (in either direction), this NFR must be recalibrated. The break-even point at which BMAD + QA phases exceed 5% of dev cost is highly sensitive to pricing: a 3× pricing increase on the economy tier would breach this NFR for all but the most expensive Feature stories without implementation changes.

  **Fallback behavior:** When economy-tier models are unavailable and Pi SDK falls back to standard-tier, the cost ceiling is automatically suspended for that story and a warning is logged. Standard-tier fallback cost is tracked separately in `attribution.db` under `fallback_tier_cost` for capacity planning.

### Operability

- **NFR23:** Factory setup script must complete on a clean machine (with prerequisites installed) in under 5 minutes, with clear progress indicators and specific error messages for each failed prerequisite check
- **NFR24:** Factory must operate on macOS (primary) and Linux — no Windows-only dependencies, no platform-specific path assumptions
- **NFR25:** Factory must be runnable on a developer machine with 16GB RAM, 4 CPU cores, and 20GB free disk — with graceful degradation (reduced concurrency) on machines with 8GB RAM.

  **CPU is the primary constraint.** At the maximum concurrency defined by NFR17 (15 agents), phase boundary gates can produce simultaneous CPU-bound child processes (test runners, TypeScript compilation, ESLint). On 4 cores, this represents severe over-subscription: effective per-agent CPU share falls to ~0.27 cores during gate storms. The 4-core minimum is therefore a harder constraint than RAM for sustained operation; developers on 2-core machines should be warned at startup that phase gate timing guarantees (NFR3) are not achievable.

  **8GB RAM degradation profile (explicit contract):**
  - Maximum concurrent active stories: 2 (reduced from default)
  - Dashboard xterm.js panels: limited to 8 active panels; additional agents shown as status-only (no live terminal output)
  - Learning synthesis (FR59) deferred to after-session batch rather than after-story
  - Epic context pre-computation (NFR39) disabled; cold-start computation used instead
  - Developer is informed of degraded mode via a persistent dashboard banner on startup: "Running in 8GB degraded mode: max 2 concurrent stories, terminal panels limited to 8"
  - Degraded mode is triggered automatically when free RAM at factory startup is below 10GB; threshold is configurable in `factory.yaml`
- **NFR26:** All factory logs must be structured (JSON or YAML) with consistent fields: timestamp, source (agent_id / component), severity (debug / info / warn / error), and message — enabling grep-based debugging without specialized tooling.

  **CI enforcement requirement:** Automated log schema validation must be included in the CI pipeline as a structural regression test. The validator must:
  1. Capture log output from a factory smoke-test run (factory startup, one story completion, factory shutdown).
  2. Assert that every emitted log line parses as valid JSON (or YAML, per component configuration) and contains all four required fields (`timestamp`, `source`, `severity`, `message`) with correct types.
  3. Assert that `severity` values are restricted to the four defined levels: `debug`, `info`, `warn`, `error`.
  4. Assert that `timestamp` values are valid ISO-8601 strings.
  5. Fail the CI build if any log line fails schema validation.

  This test must run on every commit that touches any component that emits logs. Its purpose is to catch log format drift immediately, before it reaches integration testing.
- **NFR27:** Factory startup must complete (Overstory connected, Pi runtime available, dashboard serving) within 30 seconds on standard hardware
- **NFR28:** Operational configuration (API keys, budget ceilings, model preferences, learning injection level, meta-optimization parameters) takes effect on next story start without requiring factory restart. Structural configuration (ports, paths, database locations) requires factory restart.
- **NFR29:** Factory must detect slow disk I/O (write latency exceeding 100ms average over 60 seconds) and warn the developer via dashboard
- **NFR30:** Copilot Investigate-mode multi-step investigations must complete within 15 seconds for investigations spanning up to 3 data sources, as measured by time from user message to final synthesized response
- **NFR31:** Copilot chat bar must not impact dashboard render performance — dashboard must maintain NFR5's 30fps requirement with the chat bar open and actively streaming responses.

  **Independent test specification:** NFR31 is satisfied when: (a) with chat bar closed, dashboard renders at ≥30fps (NFR5 baseline); and (b) with chat bar open and actively streaming an LLM response at typical token rate (20–50 tokens/second), dashboard render rate does not drop by more than 2fps from the NFR5 baseline measured in the same session. This delta specification (`baseline − 2fps`) makes NFR31 testable independently of absolute frame rate, and decouples it from NFR5 for cases where the baseline is above 30fps (e.g., 40fps baseline → 38fps with Copilot streaming is passing; 30fps baseline → 28fps is failing).

  **Implementation requirement:** Copilot streaming token delivery to the chat bar must be handled via a dedicated `requestAnimationFrame` queue and must not trigger synchronous React state updates during terminal renders. This is the shared mitigation for conflicts C1 and C10.

*Messenger:*
- **NFR32:** Telegram notification delivery latency must be under 5 seconds from EventStore escalation event write to Telegram push receipt confirmation, as measured by timestamp delta between EventStore `created_at` and Telegram API `sendMessage` response
- **NFR33:** Telegram integration must satisfy three security requirements:

  **(a) Outbound content security policy.** No credentials, API keys, file paths, raw stack traces, code snippets from the target codebase, learning record content, agent internal state dumps, or detailed architectural descriptions from stall diagnostics may appear in any Telegram message. All outbound messages must pass through the credential sanitizer (extending NFR9-NFR10 to the Telegram output channel). Permitted outbound content is limited to: story IDs, pipeline phase summaries, aggregate cost totals, completion counts, and generic escalation descriptions (e.g., "Agent stalled — probable cause: missing dependency"). Verifiable by automated scanning of all formatted messages in the test suite.

  **(b) Registration code security.** Telegram registration codes (FR127) must use at least 48 bits of cryptographic randomness (minimum 8 alphanumeric characters from a mixed-case charset). Codes must expire after 10 minutes from generation. The code must be displayed only in the CLI terminal output and must never be written to any log file, database record, or file that could be committed or transmitted. The bot must apply silent drop (no response) to unregistered senders attempting to register with invalid or expired codes, rather than returning an error response, to prevent confirmation of bot activity. Verifiable by unit tests covering entropy measurement, expiry enforcement, and response-suppression behavior.

  **(c) Per-sender rate limiting.** The Telegram bot must rate-limit inbound messages per Telegram user ID: a maximum of 5 failed authentication attempts per user ID per hour (with silent drop thereafter), and a maximum of 30 messages per registered sender per minute (with a 5-minute backoff on violation). Rate limiting applies independently of the NL daily budget ceiling (NFR34). Verifiable by integration tests simulating rapid message sequences from a single sender.
- **NFR34:** Messenger NL processing daily cost ceiling must be configurable (default $1.00) — when the ceiling is reached, NL classification is disabled and unrecognized messages receive a fallback response directing the user to structured commands, as verifiable by cost tracking in attribution.db

*Agent Performance System:*
- **NFR35:** Action-level process score computation (FR130) must complete within 200ms of post-task hook completion, as measured by timestamp delta between hook result availability and `pipeline.db` action_scores row insert. Performance scoring must not become a pipeline bottleneck. *Change from original:* Storage target changed from `.qds/performance/actions/` YAML file write to `pipeline.db` row insert, per CONS-002 resolution.

  **Start timestamp definition (machine-checkable):** The 200ms window starts at the timestamp of hook result availability in the Overstory event stream — specifically, the `created_at` timestamp of the `hook_result` event emitted by Overstory when the post-task hook process exits and its result is written to the Overstory SQLite `events` table. This timestamp is the authoritative start point for measuring action score computation latency. The measurement is: `action_scores.created_at` − `overstory_events.created_at` where `overstory_events.event_type = 'hook_result'` and `overstory_events.hook_type = 'post_task'` for the same agent and task. All timing instrumentation must use this definition.
- **NFR36:** Performance data in `pipeline.db` must not exceed 100MB per 1,000 stories processed, as measured by `pipeline.db` file size delta after processing 1,000 stories in a test harness. Action scores older than the configurable retention window (default 90 days) are archived to a separate `pipeline_archive.db`. *Change from original:* Replaced the vague "must not exceed 500 tokens" overlay size NFR with a concrete storage growth limit. The overlay token limit is already covered by NFR4 and FR29.
- **NFR37:** Learning record queries against `pipeline.db` (pattern knowledge lookup, maintenance learning retrieval, overlay enrichment assembly) must complete within 50ms at p95 as measured by SQLite query timing instrumentation. This ensures overlay composition (which now pulls learning data) stays within the existing NFR4 500ms budget. *New NFR.* Overlay enrichment (FR167) adds database queries to the overlay composition pipeline; these queries must not blow the existing latency budget.

  **Percentile target:** The 50ms ceiling is a p95 target. SQLite WAL-mode reads will occasionally spike above 50ms during WAL checkpoint operations (p99 can reach 100–500ms under 15-agent write load). p99 spikes are accepted provided they do not occur more than once per 100 queries. If a learning query exceeds 200ms at any percentile, it is classified as a latency anomaly and logged at `warn` severity.

  **Cache fallback behavior:** If a learning query exceeds 50ms (p95 budget), the overlay composition pipeline must fall back to the most recently cached overlay enrichment result (stale-while-revalidate pattern) rather than blocking the NFR4 500ms overlay composition deadline. The stale result must be no older than the previous story's completion timestamp. A stale-result fallback event must be logged at `info` severity with the query latency that triggered the fallback.
- **NFR38:** All QDS v2 code follows QDS conventions regardless of which research repository pattern inspired its design. There is no "transplanted code" category with different quality standards. All code must: use ESM module syntax, include TypeScript types for all public interfaces, use `bun:sqlite` for database access (not Drizzle ORM), follow the project's error handling patterns, and pass the project's lint and type-check configuration. *Change from original:* The original NFR38 specified atomic writes for `.qds/performance/` YAML files. Since performance data now lives in `pipeline.db` (CONS-002), atomic writes are handled by SQLite transactions. This NFR is repurposed to address CONS-011 (single database access pattern) and the general principle that design-inspiration-sourced code must meet QDS standards.
- **NFR39:** Epic context assembly (FR166) must complete within 500ms for epics containing up to 20 stories when the pre-computed epic context cache is warm (populated by at least one prior story completion in the same epic), as measured by the time from epic context query initiation to assembled context availability. Epic context is pre-computed after each story completion and cached in `pipeline.db`, not computed on-demand during overlay assembly.

  **Cold-start exception:** On cold start (first story of an epic, or after a factory crash that clears the cache), epic context assembly may take up to 3 seconds. This is expected and acceptable; the 3-second cold-start allowance must be communicated to the developer via a dashboard status update ("Assembling epic context — first story, allow up to 3s"). Cold-start assembly must still complete within 3 seconds even on the 8GB degraded hardware profile.

  **Cache warming requirement:** After each story completion, the factory must asynchronously pre-compute and cache the updated epic context for the next story in the same epic. This pre-computation must complete within 10 seconds of story completion confirmation and must not block the story completion pipeline.
- **NFR40:** Maintenance learning extraction (FR164) must not block the story completion pipeline. Learning record creation runs asynchronously after story completion confirmation. If learning extraction fails (LLM error, timeout, schema validation failure), the story completion is unaffected and the extraction failure is logged for retry.

## Design Inspiration Reference

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

## Appendix A: Retired Concepts

The following concepts from the Session 6 PRD are retired by this amendment:

| Concept | Original FR(s) | Status | Replacement |
|---------|---------------|--------|-------------|
| Credit economy | FR136 | KILLED | FR136-R (weighted composite scoring, Growth) |
| Per-agent monthly budget caps | FR142 (original) | REVISED | FR142 (per-story + global budget; per-role visibility only) |
| Transplant inventory | PRD Appendix | RETIRED | Design Inspiration Reference |
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

## Appendix C: Go/No-Go Decision Framework

**Framework Purpose:** This appendix defines the objective criteria that govern whether development proceeds, pivots, descopes, or stops at each key decision point during QDS v2 development. It answers three questions at every gate: (1) What must be true before we proceed? (2) Who decides, and what evidence do they need? (3) What do we do if the criteria are not met?

**Decision Authority:** Steve (Product Owner / Lead Developer) + Co-Dev Marcus (as specified per gate).

---

### Gate 0: Pre-MVP-Start Gates

**Rule:** ALL three sub-gates must achieve PASS or CONDITIONAL PASS before implementation begins on any MVP epic. A single FAIL blocks the start and triggers the specified response. A CONDITIONAL PASS proceeds with the stated constraint logged as a tracked risk.

#### Gate 0-A: Pi SDK GLM-5 Availability and Cost Validation

**Purpose:** The entire economic model — adversarial quality pipeline at ~3–5% of development cost — depends on Pi SDK natively routing to GLM-5 at economy-tier prices. If false, the "$0.02/story quality pipeline" competitive differentiator is invalidated before the first line of code is written.

**Validation spike:** 2–4 hours. Send 10 representative prompts matching QA scout and BMAD reviewer role profiles. Record: model served, latency, token cost, routing errors. Compute projected per-story quality pipeline cost via: `(avg_cost_per_call × avg_calls_per_wave × 5_waves × 2) + (avg_cost_per_call × 3_bmad_agents × 2_passes)`.

| Criterion | PASS | CONDITIONAL PASS | FAIL |
|-----------|------|-----------------|------|
| GLM-5 accessible via Pi SDK economy tier | Confirmed, responses received | Accessible via fallback path (not native tier abstraction) | GLM-5 unavailable; Pi routes to higher-cost model |
| Per-story quality pipeline cost | ≤ $0.05/story | $0.05–$0.10/story | > $0.10/story |
| Latency per GLM-5 call | ≤ 8 seconds | 8–15 seconds | > 15 seconds |
| Pi SDK tool call support on GLM-5 | Tool calls work correctly | Work with prompt reformatting workaround | Tool calls not supported; Pi does not abstract this |
| Pi SDK native model switching (tier directive → model) | Pi selects GLM-5 when economy tier declared | Pi selects GLM-5 but requires explicit model name | Pi ignores tier directive; must hardcode model names |

**FAIL responses:**
- GLM-5 unavailable via Pi: investigate Pi SDK docs; test alternative economy model (Haiku, GPT-4o-mini) as stand-in. If no economy tier available, activate PT-1.
- Cost > $0.10/story: evaluate reduced wave count (3 vs. 5); evaluate OpenRouter. If cost cannot reach ≤ $0.10, activate PT-1.
- Latency > 15s/call: evaluate async parallel wave execution. If P95 wall-clock for full QA swarm > 120 seconds, activate PT-1.
- Tool calls unsupported: redesign BMAD reviewer and QA scout prompts for structured output without tool calls; validate quality minimum bar.
- Tier directive ignored: hardcode model names per agent role in `factory.yaml` as workaround. Not a blocker — log as technical debt.

**Decision authority:** Steve. **Time budget:** 1 developer-day maximum.

---

#### Gate 0-B: Phase Boundary Protocol Prototype Spike

**Purpose:** PBP is the single highest-design-risk component — greenfield, novel, co-dependent with hook infrastructure, and the foundation of the adversarial quality guarantee. Getting PBP wrong undermines both the quality pipeline and the learning system.

**Validation spike:** 3–5 days. Implement a minimal story end-to-end: (1) development phase produces a real phase transfer manifest; (2) all 6 phase boundary hook checks fire against it; (3) a fresh BMAD agent spins up with ONLY manifest contents; (4) verify the review agent can accurately identify spec compliance status from manifest-only context.

| Criterion | PASS | CONDITIONAL PASS | FAIL |
|-----------|------|-----------------|------|
| Manifest schema sufficient for BMAD | Review agent correctly identifies pass/fail using manifest-only context | Identifies pass/fail but misses nuance; manifest schema needs expansion | Cannot determine spec compliance from manifest alone; requires raw code context |
| Context isolation verified | Zero references to development-phase-only artifacts in BMAD output | BMAD references one artifact that was correctly surfaced in manifest | BMAD exhibits knowledge of development context not present in manifest (leakage) |
| Phase boundary hooks complete | All 6 gate checks fire correctly and block/pass appropriately | 5 of 6 work; one requires minor post-spike fix | < 5 checks work OR any check silently passes when it should block |
| Hook execution time | ≤ 60 seconds (NFR3) | 60–90 seconds | > 90 seconds |
| Manifest token overhead | ≤ 800 tokens | 800–1,200 tokens | > 1,200 tokens (approach must be redesigned) |
| Manifest completeness on failure | Manifest correctly captures failure state for learning system | Captures failure partially; supplement needed | Empty or misleading on failure |

**FAIL responses:**
- Context isolation FAIL or manifest sufficiency FAIL: HARD BLOCK. These are the core adversarial guarantees. Do not proceed until resolved and re-spiked.
- Hook timing FAIL only: proceed but prioritize async/parallel hook execution as the first hook infrastructure story. Resolve before the first real story is attempted.
- Manifest token FAIL only: redesign for progressive disclosure (summary by default, detail on request). Retest before proceeding.

**Decision authority:** Steve + Marcus joint (both developers must have confidence in the core technical architecture). **Time budget:** 3–5 developer-days.

---

#### Gate 0-C: CopilotKit + AG-UI Integration Feasibility

**Purpose:** The Dashboard Copilot (FR105–FR119) requires CopilotKit and AG-UI to integrate with the ZeroClaw-derived React dashboard. Validate feasibility before building the full dashboard.

**Validation test:** 1–2 days. Install CopilotKit into the ZeroClaw dashboard fork; implement one `useCopilotReadable` hook and one `useCopilotAction` hook; connect an AG-UI streaming endpoint; verify end-to-end query and action execution.

| Criterion | PASS | CONDITIONAL PASS | FAIL |
|-----------|------|-----------------|------|
| CopilotKit installs without conflicts | No dependency conflicts with React 19 + Vite + Tailwind | Conflicts resolved with peer dependency overrides | Irreconcilable conflicts requiring React version downgrade |
| `useCopilotReadable` works | Dashboard state surfaces in copilot context correctly | Works with manual serialization workaround | Data does not surface |
| `useCopilotAction` works | Action fires correctly; UI updates visibly | Fires with additional event bridging | Does not execute |
| Economy-tier model routing for copilot | GLM-5 serves copilot queries at ≤ $0.002/query | GLM-5 serves at $0.002–$0.005/query | Only standard/premium model works for copilot |
| AG-UI streaming latency | First token within 3 seconds (NFR8) | First token 3–5 seconds | First token > 5 seconds |
| Dashboard performance (15 xterm panels + chat bar) | Maintains NFR5 (30fps) | Drops to 25–28fps (marginal) | Drops below 20fps (unacceptable) |

**FAIL responses:**
- Any FAIL on copilot readable/action/streaming: defer Dashboard Copilot to Growth. Remove FR105–FR119 from MVP scope. Dashboard ships without conversational control plane.
- Performance FAIL: evaluate lazy-loading the copilot component in a separate React subtree. If performance cannot be maintained, defer to Growth.
- Integration takes > 2 days: treat as CONDITIONAL FAIL — complexity itself is a signal.

**Decision authority:** Marcus (primary) with Steve sign-off. **Time budget:** 1–2 developer-days.

---

#### Gate 0 Summary

| Gate | Scope | Decision Authority | Must Complete Before |
|------|-------|-------------------|----------------------|
| 0-A: Pi SDK GLM-5 Cost | Economy-tier availability and cost validation | Steve | Any MVP implementation begins |
| 0-B: Phase Boundary Protocol | Context isolation and manifest spike | Steve + Marcus joint | Any MVP implementation begins |
| 0-C: CopilotKit + AG-UI | Dashboard Copilot integration feasibility | Marcus + Steve | Dashboard implementation begins |

**Overall Gate 0 Result:** All three sub-gates must be PASS or CONDITIONAL PASS (with constraints documented) for MVP implementation to begin.

---

### Mid-Development Checkpoints

Development completion percentage is measured against total MVP story points accepted (definition of done met, merged to main). Each checkpoint evaluation takes no more than 2 hours. Output: written checkpoint record at `_bmad-output/planning-artifacts/checkpoint-[CP-id]-[YYYY-MM-DD].md`.

See the Risk Mitigation → Burn-Rate Checkpoints section for the burn-rate gate thresholds and deferral priority tables at each checkpoint. The following sections add velocity and quality gates.

#### CP-25: 25% MVP Completion

| Metric | GREEN | YELLOW | RED |
|--------|-------|--------|-----|
| Stories accepted vs. planned | ≥ 90% of planned | 75–90% | < 75% |
| Stories blocked > 5 days without progress | 0 | 1 | ≥ 2 |
| Phase Boundary Protocol (critical path item 4) started | Yes, with Gate 0-B findings applied | Started, findings not yet applied | Not started |
| Critical path items 1–5 on schedule | All on schedule or ahead | 1 item behind ≤ 1 week | Any item > 1 week behind, or 2+ behind |
| Actual hours vs. projected at 25% | ≤ 115% | 115–135% | > 135% |

**CP-25 action rules:**
- All GREEN: proceed, no scope changes.
- Any YELLOW, no RED: document and monitor closely. No scope changes yet.
- Velocity RED OR burn rate RED: apply deferral table (see Risk Mitigation → Burn-Rate Checkpoints), starting from priority 1.
- Critical path RED: assess whether Phase Boundary Protocol or Hook Infrastructure is the blocker; if so, escalate to PT-2 evaluation.
- Multiple RED: convene within 24 hours. Apply deferral table. If deferral does not bring plan to YELLOW within 1 sprint, activate PT-3.

**Decision authority:** Steve.

---

#### CP-50: 50% MVP Completion

**Factory Smoke Test (required before metrics review):** Run one complete story through the factory end-to-end at 50% completion. This is the most honest integration health signal — metrics alone will not reveal integration gaps.

| Smoke Test Result | Weight |
|------------------|--------|
| Story completes all 5 phases, PR created | GREEN — proceed to metrics with confidence |
| Story completes develop + BMAD but fails QA or PR | YELLOW — proceed; flag integration gaps |
| Story completes develop phase only | RED — integration is the primary problem; metrics are secondary |
| Story cannot complete develop phase | CRITICAL — stop metrics review; convene root cause session |

| Metric | GREEN | YELLOW | RED |
|--------|-------|--------|-----|
| Stories accepted vs. planned | ≥ 90% | 75–90% | < 75% |
| Critical path items 1–5 complete | All 5 | 4 of 5 | < 4 |
| BMAD context isolation verified in smoke test | Zero context leakage | Leakage in 1 non-critical area | Any structural leakage |
| Phase boundary hook execution time | ≤ 60 seconds (NFR3) | 60–90 seconds | > 90 seconds |
| Cumulative hours vs. projected | ≤ 120% | 120–150% | > 150% |
| Per-story quality pipeline cost (from smoke test) | ≤ $0.05/story | $0.05–$0.10/story | > $0.10/story |

**CP-50 action rules:**
- Smoke test CRITICAL: stop. Do not proceed to metrics. The architecture has a fundamental integration problem.
- Quality gate RED on context isolation: do not defer. This is the core adversarial guarantee. Resolve before proceeding.
- Burn rate > 150%: apply deferral table from Risk Mitigation → Burn-Rate Checkpoints (CP-50 column). Compute revised completion date. If revised date places MVP launch > 6 weeks from CP-50, evaluate PT-3.

**Decision authority:** Steve + Marcus joint.

---

#### CP-75: 75% MVP Completion

**Launch readiness assessment:** CP-75's primary purpose is answering "Can we set a firm MVP launch date?"

| Factor | GREEN (set date) | YELLOW (provisional date) | RED (no date yet) |
|--------|-----------------|---------------------------|-------------------|
| End-to-end stories run reliably | ≥ 3 of 3 without manual intervention | 2 of 3; 1 required intervention | < 2 complete reliably |
| SSE dashboard latency | < 2 seconds (NFR1) | 2–5 seconds | > 5 seconds or unreliable |
| 3 concurrent stories without contamination | Yes | 2 work; 3rd requires restart | Parallelism not functional |
| Setup script works for Marcus (clean machine) | Yes, completed successfully | Runs with 1–2 documented workarounds | Does not complete |
| Per-story cost within model | ≤ $2.50 average for medium story | $2.50–$4.00 | > $4.00 or unknown |
| Hours remaining for final 25% vs. estimate | ≤ 110% | 110–140% | > 140% or any P0 bug |

**Final deferral decisions:** Any FR not yet explicitly deferred must receive a SHIP or DEFER decision at CP-75. Nothing enters the final sprint in ambiguous status.

**Decision authority:** Steve. Marcus must confirm independent instance works.

---

### MVP Launch Gate: Minimum Viable FR Set

The following 22 FR groups are non-negotiable for a real MVP. If any is absent or non-functional, the system is a prototype — the launch is a NO-GO.

**Pipeline completeness:**

| FR | Capability | Why Non-Negotiable |
|----|------------|-------------------|
| FR1–FR8 | 5-phase pipeline (Intake → Develop → BMAD → QA → PR) for Story work type | Without end-to-end story execution, there is no factory |
| FR9 | Task work type with minimal pipeline | MVP is defined as Story + Task; Task is required |
| FR10–FR13 | BMAD adversarial review with context-isolated fresh agents | Context isolation is the core adversarial guarantee; without it, BMAD is not adversarial |
| FR14–FR20 | 6-layer hook enforcement (all 6 layers functional) | Without hooks, the factory ships unvalidated code; quality guarantee is void |
| FR21–FR24 | Agent orchestration (spawn, monitor, recover, checkpoint) | Without recovery and checkpoint, long-running stories are unreliable |
| FR28–FR35 | Overlay composition pipeline (all 6 stages functional) | Context management is the enabling infrastructure for everything else |
| FR36–FR42 | Resource and economic management (tier directives, budget tracking, circuit breakers, attribution) | Without circuit breakers, the factory can exhaust API budgets undetected |
| FR51–FR53 | Git safety iron laws and PR creation | Without git safety, the factory is a liability; without PR creation, there is no deliverable |

**Dashboard minimum:**

| FR | Capability | Why Non-Negotiable |
|----|------------|-------------------|
| FR43 | Factory Overview (system health, active stories, API key status, token budget) | Developer needs situational awareness at a glance |
| FR44 | Agent Windows with live xterm.js output | Stall recovery (Journey 2) is impossible without inspecting agent output |
| FR45 | Story pipeline phase progression | Developer needs to know where each story is in the pipeline |
| FR47 | Stall detection with type classification | Without classification, every stall requires full manual inspection |
| FR25–FR27 | Stop, Nudge, Inspect controls | These are the developer's recovery tools; without them, stalled stories are only resolvable by killing the factory |
| FR50 | Dashboard crash does not halt agents | Non-negotiable reliability guarantee |

**Factory Learning System minimum:**

| FR | Capability | Why Non-Negotiable |
|----|------------|-------------------|
| FR55–FR58 | Learning record writes, outcome tags, loop 1 (mail), loop 2 (manifest) | Without all three loops, the factory does not learn; the core self-improvement promise is undelivered |
| FR61 | Overlay injection from synthesized learnings | Without injection, accumulated learnings have no effect on agent behavior |

**Developer operations minimum:**

| FR | Capability | Why Non-Negotiable |
|----|------------|-------------------|
| FR69 | Setup script with dependency verification | Without this, Marcus cannot configure an independent instance |
| FR70 | Per-developer config (`factory.yaml`) | Without per-developer API keys and budgets, the two-developer model is impossible |
| FR71 | Independent dashboard instances | Without independent instances, two developers cannot work concurrently |

**Launch gate decision table:**

| Non-Negotiable FRs Present | Hard NFR Minimums Met | Learning System Quality Bars Met | Launch Decision |
|----------------------------|-----------------------|----------------------------------|----------------|
| YES | YES | YES | GO — launch MVP |
| YES | YES | NO | CONDITIONAL GO — launch with learning system defect tracked as P1; fix within 1 sprint post-launch |
| YES | NO (one NFR fails) | ANY | NO-GO — fix the failing NFR; re-evaluate |
| NO (any non-negotiable FR missing) | ANY | ANY | NO-GO — incomplete MVP; do not use as primary workflow |

**Hard NFR minimums for launch:** NFR1 (SSE latency < 2s), NFR3 (phase gate ≤ 60s), NFR9 (zero API key agent visibility), NFR10 (zero API key in factory output), NFR11 (agent filesystem access hard-restricted to worktree), NFR12 (factory.yaml excluded from version control), NFR14 (agent crash detection < 10s; replacement < 30s), NFR15 (story checkpoint/resume, zero data loss), NFR16 (learning record atomic writes), NFR17 (SQLite concurrent access, 15 agents, zero silent failures), NFR22 (quality pipeline cost ≤ 5% of story cost), NFR23 (setup script < 5 minutes on clean machine), NFR24 (macOS + Linux both pass).

**Decision authority:** Steve (final decision). Marcus must confirm independent instance works from co-dev perspective.

---

### Scope Deferral Priority Order

Under any scope pressure, features are deferred in this order. Stop deferring when the plan recovers to YELLOW or better.

| Priority | FR(s) | Feature | Deferral Impact | Trigger Threshold |
|----------|-------|---------|----------------|-------------------|
| 1 | FR105–FR119 | Dashboard Copilot (CopilotKit + AG-UI) | UX reduction; dashboard operates without conversational control plane | Any RED at CP-25, OR burn rate YELLOW + velocity YELLOW simultaneously |
| 2 | FR77–FR89 | Meta-Optimization (daily + weekly cron observers) | Factory self-improvement deferred; manual analysis only | Velocity RED, OR 2 meta-optimization stories blocked > 5 days |
| 3 | FR120–FR129 | Telegram Developer Communication Layer | Notification via dashboard only; no mobile alerts | Burn rate RED, OR meta-optimization already deferred |
| 4 | FR164–FR168 | Self-Learning System extensions (maintenance extraction, pattern accumulation, epic context, overlay enrichment, burden tracking) | Factory learning exists (FR55–FR63) but does not accumulate cross-story patterns beyond basic synthesis | Only if ALL of 1–3 already deferred AND critical path still RED — evaluate PT-3 first |
| 5 | FR91–FR104 subset | Resilience polish (FR92 file contention, FR98 learning retention, FR100 drift monitoring, FR102 BMAD profiles) | Resilience reduced; MVP operates without these guardrails | Burn rate > 150% AND velocity RED at CP-50 |
| 6 | FR130–FR132 | Agent Performance Data Collection (action scoring, calibration, session composites) | Growth behavioral system (ELO, tiers) loses its data foundation; every week without this delays Growth readiness equivalently | ONLY if items 1–5 already deferred AND still RED; this is the last resort |

**Rule:** If items 1–3 are all deferred and the critical path is still RED, escalate to PT-3 evaluation rather than deferring item 4. FR164–FR168 is a core innovation, not a polish feature.

---

### Pivot Triggers (PT-1 through PT-5)

Pivot triggers are pre-defined scenarios requiring a fundamental response rather than incremental adjustment. Declaring a pivot trigger suspends normal development and initiates a structured evaluation session within the defined timebox.

#### PT-1: Pi SDK Economy-Tier Cost Unviable

**Trigger:** Pi SDK GLM-5 quality pipeline cost > $0.10/story (BMAD + QA combined), OR Pi SDK does not natively support economy-tier routing transparently.

**Why fundamental:** The competitive differentiator "quality pipeline is economically negligible" collapses. The adversarial quality guarantee becomes optional under developer pressure.

**Response options (2-day timebox; Steve decides):**

| Option | Description | Go Criteria |
|--------|-------------|-------------|
| A: OpenRouter fallback | Route economy-tier calls through OpenRouter; use cheapest model supporting tool calls | Cost ≤ $0.05/story AND quality equivalent |
| B: Reduced wave count | 3 waves vs. 5; maintain full BMAD | Projected cost ≤ $0.05/story; BMAD catch rate unaffected |
| C: Defer economy routing to Growth | Pin all agents to standard tier (Sonnet) for MVP | Per-story cost including standard-tier QA ≤ $0.50; team accepts cost model change |
| D: Remove QA swarm from MVP | Ship with BMAD only; defer 5-wave QA to Growth | BMAD catch rate sufficient without QA; team accepts reduced quality guarantee |

**Default if undecided by 2-day deadline:** Option C (defer economy routing).

---

#### PT-2: Phase Boundary Protocol Design Failure

**Trigger:** Gate 0-B FAILS on context isolation OR manifest sufficiency, AND failure cannot be resolved within a 2-week redesign sprint.

**Why fundamental:** Without genuine context isolation, BMAD review agents are not adversarial. The core guarantee is violated. The PRD is explicit: "Context isolation is non-negotiable."

**Response options (3-day timebox; Steve + Marcus joint):**

| Option | Description | Go Criteria |
|--------|-------------|-------------|
| A: Heavier manifest schema | Expand manifest contents; accept higher token overhead | Context isolation verified with expanded manifest; total manifest ≤ 2,000 tokens |
| B: Filesystem-based handoff | BMAD agents receive read-only worktree snapshot at phase boundary | Zero context leakage verified; snapshot read-only enforced at process level |
| C: Defer adversarial review to Growth | MVP ships with intra-agent review (not adversarial); "adversarial" removed from MVP messaging | Team explicitly acknowledges quality guarantee is weakened |
| D: Full architecture review | Suspend development 1 week; re-examine Overstory + Pi SDK context isolation fundamentals | Only if A and B both fail |

**Default if undecided:** Option B (filesystem snapshot handoff).

---

#### PT-3: Development Velocity Collapse

**Trigger:** At any checkpoint, projected MVP completion exceeds 16 weeks from start AND delay is due to scope complexity (not external blockers).

**Why fundamental:** 4-month MVP for a 2-developer internal tool means opportunity cost may exceed full-scope value. This trigger forces a scope conversation, not a schedule slip.

**Response (1-day timebox; Steve decides):** Apply scope reduction in order until projected completion is within 12 weeks:

| Level | Scope Removed | FRs Affected |
|-------|--------------|-------------|
| 1 | Dashboard Copilot | FR105–FR119 |
| 2 | Meta-Optimization | FR77–FR89 |
| 3 | Telegram Communication | FR120–FR129 |
| 4 | Self-Learning System extensions | FR164–FR168 |
| 5 | Dashboard reduced to core only | FR45, FR49, FR47 deferred |
| 6 (last resort) | Task work type deferred | FR9 |

Levels 1–3 together save ~20–25% of MVP scope. If they are insufficient to bring the date within 12 weeks, the architecture itself needs re-examination — this table cannot solve that.

---

#### PT-4: `gh` CLI Dependency Failure

**Trigger:** `gh` CLI is not viable as the GitHub integration mechanism (auth issues, rate limits, or API changes that break PR creation before MVP launch).

**Why pivot:** PR creation is the delivery mechanism of the entire factory. Without it, every story completes but delivers nothing.

**Response (3–5 days to implement; Marcus + Steve):**
- **Direct GitHub REST API:** Replace `gh` CLI with direct `fetch()` to GitHub REST API (PAT in `factory.yaml`). 2–3 developer-days.
- **Octokit SDK:** Replace `gh` CLI with the official GitHub SDK. 3–5 developer-days.

Neither option is a strategic re-scoping. This is a 3–5 day implementation task.

---

#### PT-5: Factory Learning System Quality Failure

**Trigger:** After 30 days of MVP operation, the Factory Learning System is net negative — stories where relevant scope has active synthesized learnings fail at BMAD or QA at a HIGHER rate than stories in unlearned scopes.

**Why fundamental:** The learning system is the deepest competitive moat. If it is injecting wrong guidance, it is actively harmful.

**Response:**
1. **Immediate:** Set `learning_injection_level: none` in `factory.yaml`. Factory continues operating without learnings.
2. **Investigation (3 days):** Audit all active synthesized learnings; identify the class producing wrong guidance.
3. **Fix or defer:** If synthesis bugs (fixable) → fix synthesis script; re-enable injection for critical tier only. If fundamental over-generalization → defer learning injection to Growth; ship MVP with learning records collected but not injected; resolve architecture in Growth.

**Measurement:** BMAD correction rate in scopes with active learnings vs. scopes without (15% reduction minimum bar from Innovation validation section).

**Decision authority:** Steve.

---

#### Pivot Trigger Summary

| Trigger | Condition | Timebox | Decision Authority | Default if Undecided |
|---------|-----------|---------|-------------------|---------------------|
| PT-1: Economy-tier cost | Quality pipeline > $0.10/story | 2 days | Steve | Option C (defer economy routing) |
| PT-2: PBP design failure | Context isolation cannot be verified | 3 days | Steve + Marcus | Option B (filesystem snapshot) |
| PT-3: Velocity collapse | Projected completion > 16 weeks | 1 day | Steve | Apply scope reduction levels 1–3 |
| PT-4: `gh` CLI failure | PR creation not viable | 3–5 days to implement | Marcus + Steve | Direct GitHub REST API |
| PT-5: Learning system net negative | Injection increases failure rate after 30 days | Immediate disable; 3-day investigation | Steve | Disable injection; investigate |

---

### Decision Accountability Matrix

| Decision Type | Primary Decision Maker | Input Required From | Notes |
|---------------|----------------------|--------------------|----|
| Gate 0-A pass/fail (Pi SDK cost) | Steve | Spike output data | |
| Gate 0-B pass/fail (PBP spike) | Steve + Marcus joint | Spike output + both developers' written assessment | Neither can override the other |
| Gate 0-C pass/fail (CopilotKit) | Marcus | Performance metrics + dependency tree | Steve can override to PASS if strategic priority warrants |
| CP-25 scope deferral | Steve | Sprint velocity, burn rate data | |
| CP-50 smoke test failure response | Steve + Marcus joint | Smoke test output | Steve can override Marcus on non-architectural decisions |
| CP-50 scope deferral | Steve | Marcus input on implementation dependency chain | |
| CP-75 launch date setting | Steve | Marcus confirmation that co-dev instance works | |
| MVP launch go/no-go | Steve | Marcus sign-off on independent instance | Steve has final call |
| Pivot trigger activation | Steve (PT-1, PT-3, PT-4, PT-5) or Steve + Marcus (PT-2) | Per individual trigger | |
| FR deferral from MVP to Growth | Steve | Marcus input on implementation dependency chain | |

**Escalation rules:**
1. Any decision that changes the core product promise (adversarial review guarantee, context isolation, economy-tier routing as differentiator) requires Steve + Marcus joint decision regardless of category.
2. Any decision made under time pressure (< 24 hours) defaults to the conservative option documented in the relevant pivot trigger table. "When in doubt, defer" applies to features. "When in doubt, do not compromise" applies to quality guarantees.
3. Disputed decisions (Steve and Marcus disagree) default to the more conservative option (smaller scope, higher quality bar, longer timeline). Disputes must be resolved by finding a position both parties can commit to — there is no tiebreaker.
4. No unilateral scope additions to MVP. New scope is always Growth-first; pulling it to MVP requires a joint decision.

**Documentation standard:** Every gate decision produces a written checkpoint record at `_bmad-output/planning-artifacts/checkpoint-[gate-id]-[YYYY-MM-DD].md`. Every pivot trigger decision uses `pivot-[PT-id]-[YYYY-MM-DD].md`. Minimum content: gate ID and date, each criterion with status (PASS/CONDITIONAL/FAIL), evidence reviewed, decision made, constraints logged, and names of decision makers present.
