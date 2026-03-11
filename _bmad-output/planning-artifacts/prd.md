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
  strategicApproach: "Approach C - Factory Core as the Brain, Source Projects as Libraries"
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

## Executive Summary

QDS Engineer v2 is a unified coding factory platform that accepts development stories or epics and produces production-ready, adversarially-reviewed, evidence-backed pull requests with minimal human intervention. It synthesizes five proven open-source projects — Overstory (agent orchestration), Superpowers (quality gates), ZeroClaw (scheduling and dashboard), Pi (model-agnostic runtime with native model switching), and claude-mem (persistent memory) — into a single platform governed by a new Factory Core brain that manages resources, economics, context management, and cross-system arbitration. Overstory runs inside Pi, which serves as the model-agnostic runtime — Pi handles model selection natively (Opus 4.6, GLM-5, and others) without requiring a separate API gateway layer. Source projects are consumed as libraries; the Factory Core owns all cross-cutting concerns.

The core development pipeline accepts stories, decomposes them into scoped agent tasks, builds code via TDD-enforced agent swarms, runs mandatory adversarial review with context-isolated fresh agents, executes 5-wave QA, and ships evidence-backed PRs. The platform operates on an Octopus Model architecture: a central nervous system (Factory Core + Dashboard) connects independent tentacles handling development pipelines, scheduled operations, brainstorming and planning, and PR monitoring. The tentacles form a closed loop — scheduled cron agents continuously scan the codebase (OWASP security scans, dependency audits for known CVEs, performance regression tests against Mulch baselines, dead code detection, code quality drift analysis), surface discovered issues to the central tracker (Seeds), and dispatch fixes through the same mandatory quality pipeline. The next cron cycle verifies fixes landed correctly, creating a continuous verification loop.

MVP users are the internal development team (Steve + co-dev Marcus). Target users for Growth and Vision phases span three personas: solo indie developers seeking cost-optimized AI coding with built-in quality assurance and nightly scans that work while they sleep, startup CTOs managing multi-repo development who need rate limit prevention, pipeline throughput, and CI-integrated self-healing, and agency leads running parallel client projects requiring per-client cost attribution, project-level cron isolation, and configurable merge policies (auto-merge for internal, human-required for client-facing).

The platform replaces three separate tool categories — agent orchestration framework, code review toolchain, and QA automation — and adds capabilities no competitor offers: continuous self-healing, scheduled operations, 5-layer context management, and model-agnostic cost optimization. Pi SDK's native model switching enables intelligent tier routing (economy-tier GLM-5 for review and QA, standard-tier Sonnet for building, premium-tier Opus 4.6 for architecture) without requiring a separate API gateway — making the mandatory quality pipeline economically negligible at ~3-5% of development cost. No existing tool scores on more than three of these dimensions; QDS integrates all eight into a closed loop. A conversational AI copilot built on CopilotKit and AG-UI provides natural language access to the entire dashboard — developers can query status, investigate issues across multiple data sources, and execute controls through conversation, making the dashboard's full power accessible without memorizing navigation paths.

### What Makes This Special

**Adversarial quality pipeline as cost prevention.** Every story passes through mandatory BMAD adversarial review and 5-wave QA with context-isolated fresh agents. Context isolation is non-negotiable — development agents never share context with review agents, eliminating the sunk-cost bias that makes self-review worthless. Running on GLM-5 economy tier, the entire quality pipeline costs under $0.02 per story. Review profiles are configurable per project (security-focused, API-contract-focused, performance-focused), and every PR carries evidence artifacts proving what was found, tested, and fixed with trackable ROI.

**Closed-loop self-healing with defense in depth.** Nightly and recurring cron agents act as the factory's immune system — continuously scanning, discovering issues, and dispatching fixes through the standard quality pipeline. Safety comes from layered verification: inline BMAD + QA, independent CI pipelines the AI doesn't control, next-cycle cron re-verification within 24 hours, fix-loop circuit breakers with human escalation after 2 rounds, blast radius limits requiring human review for large changes, and full dashboard observability of all cron-initiated changes. Human-initiated work always preempts cron work, with a daily cron budget ceiling preventing resource exhaustion. Merge policy is configurable per project — the system provides confidence through defense in depth, not certainty through infallibility.

**Factory Core resource brain as scaling prerequisite.** Single-key API architecture is a throughput ceiling that turns a factory into a workshop. The Factory Core manages API key configuration for Pi SDK, token budgets with cost circuit breakers, model tier directives (telling Pi which tier to use per agent role), and cross-tentacle resource arbitration. Pi SDK handles model selection and provider routing natively — Factory Core's responsibility is economic governance (budgets, circuit breakers, tier policy), not API call execution. Model routing enables the quality pipeline's economics — they are symbiotic differentiators. MVP delivers Pi SDK integration with tier-based routing; post-MVP delivers advanced key rotation, health monitoring, and OpenRouter as an optional fallback for models Pi doesn't natively support.

**5-layer context management harness.** Context rot is the silent killer of AI agent productivity. The platform composes the best patterns from each source project: process isolation per agent (Overstory), behavioral gates and iron laws (Superpowers), pre-compaction fact extraction and time decay (ZeroClaw), progressive disclosure with hybrid search and session summaries (claude-mem). Phase Boundary Protocol transfers structured manifests between phases — not raw context. Seeds expands to become the factory-wide universal task graph. Mulch expertise gains timestamps, provenance, content deduplication, and category-based boosting.

**Core insight:** AI agents produce negative value without independent quality verification, fresh context windows, and continuous self-correction. The factory's purpose is not to generate code faster — it is to generate production-quality code faster and to continuously verify and self-correct.

**Conversational control plane.** The dashboard includes an AI copilot chat bar (CopilotKit + AG-UI) that has full programmatic control of the dashboard. Developers can ask questions ("what's wrong with Story 3?"), request investigations (copilot navigates the UI, correlates data from multiple sources, presents synthesized findings), and execute actions ("nudge Builder-03 with the correct module name") — all through natural language. The copilot acts through the UI, not around it: every action is performed by programmatically triggering the same controls the developer would click, ensuring all safety constraints are enforced. Running on economy-tier models, the copilot is an expert power multiplier and an onboarding accelerator.

## Project Classification

- **Project Type:** AI Workforce Management Platform — agent orchestration and coordination layer over external runtimes
- **Domain:** Software Development Automation with Pi SDK as model-agnostic runtime
- **Complexity:** High — across technical (polyglot: Rust, TS/Bun, React, Python; distributed SQLite coordination), operational (resource contention, concurrency ceiling, cross-tentacle arbitration, continuous cron verification), and organizational (virtual workforce with quality control pipeline, institutional memory, configurable merge governance) dimensions
- **Project Context:** Systems integration/synthesis — five OSS projects plus v1 codebase unified into a new platform
- **Strategic Approach:** Approach C — Factory Core as the Brain, source projects as libraries

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
- Quality Pipeline — 6-layer hook enforcement, BMAD adversarial review, QA swarm
- Context Management — Phase Boundary Protocol, overlay composition, Mulch priming, Seeds tracker
- Factory Learning System — 3-loop learning (session, story, cross-session), synthesis, injection
- Meta-Optimization — daily cron observer, weekly optimizer, auto-apply with safety net
- Developer Operations — setup script, per-developer config, independent instances
- PR-to-Seeds — auto-create Seeds issues from human PR comments

### Growth

- Cron self-healing loop (Tentacle 2) — scheduled scans, auto-fix, continuous verification
- Extended work types (Spike, Review-Only, Audit)
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

Five innovation areas identified, ranked by novelty and strategic importance:

| # | Innovation | Novelty Level | Closest Competitor Analog | Gap vs Competitors |
|---|---|---|---|---|
| 1 | Adversarial Quality Pipeline (context-isolated, economy-tier) | High | CodeRabbit (AI review), Cursor (AI generation) | Neither enforces context isolation between generation and review; neither makes quality economically invisible |
| 2 | Closed-Loop Self-Healing | High | Dependabot (single-concern auto-fix), Snyk (security-only) | No tool does full-spectrum scan → fix → verify loop with layered guardrails |
| 3 | Factory Learning System | High | None | Entirely novel category; no competitor has cross-session agent learning with auto-injection |
| 4 | Coordination-Over-External-Runtimes (via Pi SDK) | Moderate | LangChain/CrewAI (agent frameworks) | Those frameworks own execution; QDS coordinates via Pi SDK which handles model-agnostic runtime natively |
| 5 | 5-Layer Context Management Harness | Moderate | Various tools implement 1-2 layers | No tool composes all 5 layers; innovation is in the composition |

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
| Coordination-Over-External-Runtimes | Pi SDK model switching doesn't perform as expected for certain tiers | Pin Pi to a single model (Opus 4.6 for all tiers), treat economy-tier routing as Growth. Lose cost optimization but core pipeline still works. | Medium — loses economic optimization but functionally viable |
| 5-Layer Context Management | Phase Boundary Protocol is too lossy — important context lost | Expand manifest schema. Last resort: allow limited context sharing between phases with explicit opt-in (violating strict isolation — compromises adversarial review guarantee). | High — undermines core principle |

### Competitive Moat Assessment

**Strong moat (hard to replicate):**
- **Factory Learning System** — requires real workloads to accumulate learnings. A competitor can copy the architecture but not the accumulated operational intelligence. Moat deepens with every story. First-mover advantage is real.
- **5-Layer Context Management** — requires deep integration with multiple subsystems. Composition across Overstory, Superpowers, Phase Boundary Protocol, Mulch, and Seeds is the moat.

**Moderate moat (replicable with effort):**
- **Adversarial Quality Pipeline** — concept is simple to describe. Moat is in implementation quality (review profiles, evidence templates, economy-tier routing) and full pipeline integration.
- **Coordination-Over-External-Runtimes (via Pi SDK)** — Pi SDK provides the model-agnostic runtime natively. Moat is in Factory Core's agent-specific governance layer (context budgets, capability matching, attribution chains, tier policy).

**Weak moat (easily replicable):**
- **Closed-Loop Self-Healing** — concept (scan + fix + verify) is straightforward. Moat is in guardrail design (circuit breakers, blast radius, defense in depth) which is hard to get right but not architecturally defensible.

**Strategic implication:** The Factory Learning System and 5-Layer Context Management are the deepest moats and the innovations that compound over time. Architecture and implementation sequencing should prioritize getting these right.

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
- Progressive skill loading — only role-relevant skills injected per agent (FR159, transplanted from DeerFlow)

**Agent Performance System (transplanted from PaperclipAI, GSD, DeerFlow):**
- Action-level process scoring after each post-task hook (FR130)
- Confidence calibration at phase boundaries (FR131)
- Session-level composite performance scores (FR132)
- ELO-style domain-specific ratings per agent (FR133)
- 5-tier progressive autonomy (FR134) with tier-based hook density (FR135)
- Internal credit economy tracking (FR136)
- Performance context injected into agent overlays (FR137)
- ELO-based story-to-agent routing (FR138)
- Dashboard performance cards (FR139)
- Performance data export (FR140) and manual tier override (FR141)

**Economic Governance Enhancements (transplanted from PaperclipAI):**
- Per-agent monthly budget caps with auto-pause (FR142)
- Atomic task checkout preventing double-work (FR145)
- Per-phase-type concurrency limits (FR147, transplanted from Symphony)

**Orchestration Enhancements (transplanted from Symphony, GSD):**
- Workspace lifecycle hooks at 4 points (FR148, transplanted from Symphony)
- Turn-based continuation within phases (FR149, transplanted from Symphony)
- Automatic deviation handling with 4 rules (FR150, transplanted from GSD)
- Wave-based epic decomposition (FR151, transplanted from GSD)

**Quality Verification Enhancements (transplanted from GSD):**
- Goal-backward verification / Nyquist layer (FR152-FR153)
- Context budget 50% rule (FR155)

**Memory & Learning Enhancements (transplanted from DeerFlow, GSD):**
- Confidence-scored fact extraction (FR156-FR157, transplanted from DeerFlow)
- Action-level process scores in learning records (FR160)

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
- Per-agent memory profiles with behavioral patterns (FR158, transplanted from DeerFlow)

**Advanced Agent Performance (extends MVP performance system):**
- Market-based task bidding — agents bid on tasks based on confidence + rating + credit balance (FR136 advanced)
- Rate limit snapshot tracking per session (FR143, transplanted from Symphony)
- Cost-per-initiative rollups linking spend to story → project groupings (FR144, transplanted from PaperclipAI)
- Cost-per-initiative dashboard views (FR146)
- Auto-remediation from goal-backward verification gaps (FR154)
- Shapley value credit assignment for multi-agent stories

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
- Fine-tuning signal generation from accumulated performance data (action scores + session outcomes → training datasets)
- Agent specialization markets — agents develop reputations and are sought for specific task types based on domain ELO
- Federation: performance data portable between factory instances

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

## Functional Requirements

This section defines THE CAPABILITY CONTRACT for the product. Every downstream artifact — UX design, architecture, epic breakdown, story implementation — will ONLY implement what is listed here. If a capability is missing from this list, it will not exist in the final product.

160 functional requirements organized across 19 capability areas. Each FR states WHAT capability exists, not HOW to implement it. FR130-FR160 reference transplanted code from research repos where applicable — see Transplant Inventory appendix for source file mappings.

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
| Agent Performance System | Agent Performance System (FR130-FR141) |
| Economic Governance | Economic Governance Enhancements (FR142-FR146) |
| Orchestration | Orchestration Enhancements (FR147-FR151) |
| Quality Verification | Quality Verification Enhancements (FR152-FR155) |
| Memory & Learning | Memory & Learning Enhancements (FR156-FR160) |

### Pipeline Execution

- **FR1:** Developer can submit one or more stories with story spec files and initiate factory processing without further manual intervention until PR creation
- **FR2:** Factory can decompose a multi-story epic into individual story executions with automatic dependency detection between stories
- **FR3:** Developer can manually override auto-detected story dependencies (confirm, reject, or reclassify)
- **FR4:** Factory can execute multiple stories concurrently with isolated worktrees, scoped file access, and no cross-story contamination
- **FR5:** Factory can assemble the correct pipeline phases for each work type (Story: 5-phase; Task: develop + PR) based on work type declarations
- **FR6:** Factory can transition between pipeline phases by spinning up fresh agents with clean context, transferring only structured manifests
- **FR7:** Factory can execute a fix loop when BMAD review identifies defects, with a circuit breaker that halts after a configurable maximum iteration count and escalates to the developer
- **FR8:** Factory can create a pull request on GitHub with a structured evidence body containing development summary, BMAD findings (severity-tiered), QA results, coverage analysis, cost/model attribution, and factory instance identification
- **FR9:** Factory can execute the Task work type with a minimal pipeline (develop → PR, optional lightweight BMAD) and reduced agent team

### Quality Enforcement

- **FR10:** Factory can execute BMAD adversarial review with context-isolated fresh agents that have no access to development phase context
- **FR11:** BMAD review agents can categorize findings by severity (critical / warning / info) and produce a structured findings report
- **FR12:** Factory can execute a multi-wave QA swarm with configurable wave count and a configurable stopping threshold (e.g., N consecutive clean waves)
- **FR13:** QA swarm scouts can run on economy-tier models via Pi SDK native routing
- **FR14:** Factory can enforce 6-layer progressive quality gates: runtime filesystem restrictions, post-edit hooks, post-task hooks, phase boundary hooks, BMAD review, QA swarm
- **FR15:** Post-edit hooks can detect file scope violations (writes outside assigned scope) and block the operation immediately
- **FR16:** Post-edit hooks can detect TDD violations (source file edit without corresponding test file edit) and send a warning to the agent via mail
- **FR17:** Post-task hooks can execute test runner, lint check, and type check on modified files and block task completion on failure
- **FR18:** Phase boundary hooks can enforce a gate checklist (full test suite, build, lint, type check, no uncommitted changes, transfer manifest schema valid) before allowing phase transition
- **FR19:** Hook enforcement results can appear inline in the agent's output stream as colored status banners
- **FR20:** Phase boundary gate results can be displayed as a checklist in the dashboard during phase transition

### Agent Orchestration

- **FR21:** Factory can spawn, monitor, stop, and replace agents through the Overstory coordinator
- **FR22:** Coordinator can automatically recover from a single agent crash by spawning a replacement (up to a configurable maximum attempts before human escalation) and dispatches a Telegram notification when messenger is enabled
- **FR23:** Agents can communicate via Overstory mail system (SQLite-backed), including standard message types and `learning_report` type
- **FR24:** Factory can checkpoint and resume long-running stories without data loss
- **FR25:** Developer can stop a specific agent from the dashboard
- **FR26:** Developer can send a nudge message to a specific agent via the dashboard, delivered through the mail system, with content logged for traceability in the story record
- **FR27:** Developer can inspect a specific agent's live output from the dashboard

### Overlay & Context Management

- **FR28:** Factory Core's overlay composition pipeline can assemble agent overlays from 6 ordered stages (system prompt, Superpowers skills, Mulch expertise, Factory Learnings, Phase Boundary manifest, task instructions) within a hard token ceiling
- **FR29:** Each overlay stage can priority-rank its items and truncate when exceeding its per-stage token budget allocation
- **FR30:** Factory Core can validate that total overlay plus estimated task requirement does not exceed the model's effective context limit before launching an agent
- **FR31:** If context budget check fails, Factory Core can split the task scope or escalate the model tier
- **FR32:** Phase Boundary Protocol can transfer structured manifests between phases containing required sections, context budget consumed, and a learnings section
- **FR33:** Superpowers skills can be injected into agent overlays for judgment-based self-policing
- **FR34:** Superpowers skill files with `enforcement` metadata in YAML frontmatter can be consumed by hook scripts for machine-validated gate enforcement
- **FR35:** Mulch expertise can be scoped to the agent's assigned file path and included in the overlay

### Resource & Economic Management

- **FR36:** Factory Core can assign model tier directives (economy / standard / premium) per agent role, with Pi SDK executing model selection natively
- **FR37:** Factory Core can track token spend per story with phase-level allocation visibility
- **FR38:** Factory Core can enforce a per-story cost circuit breaker that halts the story when spend exceeds a configurable threshold and dispatches a Telegram notification when messenger is enabled
- **FR39:** Factory Core can enforce a daily global budget ceiling that pauses all non-critical work when exceeded and dispatches a Telegram notification when messenger is enabled
- **FR40:** Factory Core can manage worktree lifecycle (creation at story start, cleanup at story end — including failed, cancelled, and circuit-broken stories)
- **FR41:** Factory Core can detect and clean up orphaned worktrees on startup
- **FR42:** Every model API call can carry a full attribution chain (developer_id → story_id → phase → agent_id → model → provider → token_count → cost)

### Dashboard & Observability

- **FR43:** Dashboard can display a Factory Overview showing system health, active stories, agent count, pipeline status, API key status, and token budget
- **FR44:** Dashboard can display Agent Windows with tiled panels showing per-agent status, live output via xterm.js, and token ticker
- **FR45:** Dashboard can display story pipeline phase progression with phase transition visualization and manifest validation indicators
- **FR46:** Dashboard can display cost tracking with model tier breakdown per story
- **FR47:** Dashboard can display stall detection indicators with type classification (logic loop / external wait / resource constraint) and diagnostic assistance summary, and dispatches a Telegram notification when messenger is enabled
- **FR48:** Dashboard can stream events from Overstory via SSE and accept commands via WebSocket, and the messenger package independently consumes the same EventStore for Telegram notifications when messenger is enabled
- **FR49:** Dashboard can display budget projection per story showing projected phase cost versus budget across all remaining phases
- **FR50:** Dashboard crash does not halt agent execution — agents continue running under Overstory control, and dashboard reconnects with full state recovery on restart

### Git & PR Operations

- **FR51:** Factory can enforce git safety iron laws: never force-push, never commit to protected branches, factory-namespaced branch naming (`qds/<dev>/<story-id>`), structured commit attribution (`[QDS:<story-id>:<phase>]`)
- **FR52:** Factory can create PRs via `gh` CLI with structured evidence body including Pre-BMAD Mechanical Validation section (hook results), BMAD findings, QA results, and cost attribution
- **FR53:** Factory's PR evidence can include a coverage gap indicator ("Not Tested" section) listing files modified but outside QA wave scope
- **FR54:** Factory can observe CI pipeline results on PRs via `gh pr checks` (observe-only for MVP)
- **FR90:** Factory can automatically create a Seeds issue when a human leaves a comment on a factory-generated PR (filtering out bot, CI, and automation comments), tagged with the originating factory instance and auto-assigned to that developer's factory queue

### Factory Learning System

- **FR55:** Agents can write structured learning records (YAML) to `.qds/learnings/YYYY-MM-DD/` with crash-safe atomic writes (write to temp, rename)
- **FR56:** Learning records can carry story outcome tags (success / failed_bmad / failed_qa / cancelled), updated when the story completes
- **FR57:** Agents can send `learning_report` mail to the story lead during execution (Loop 1 — session-level tactical learning)
- **FR58:** Phase Boundary Protocol transfer manifests can include a `learnings` section carrying forward development phase struggles and discoveries (Loop 2 — cross-phase intelligence)
- **FR59:** A manual synthesis script can read raw learning records, group by file scope, deduplicate, weight by story outcome, validate against Superpowers gates, and flag conflicts for human resolution
- **FR60:** Synthesis script can reject learnings that conflict with active Superpowers iron laws and log the rejection reason
- **FR61:** Overlay injection can match synthesized learnings to agent file scope and role, rank by tier (critical / recommended / informational) and recency, and inject within hard token ceiling (500 tokens economy, 1000 tokens standard)
- **FR62:** Stories tagged `spike` or `exploratory` can suppress learning injection entirely
- **FR63:** Developer can retract a synthesized learning with cascading retraction to all source records (preventing resurrection on next synthesis)

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

- **FR77:** A daily cron agent can analyze that day's factory operations — token consumption patterns, context window utilization, overlay stage efficiency, prompt effectiveness (stall/retry correlation), model tier performance by agent role, phase boundary manifest waste, hook enforcement overhead, BMAD findings per story, and QA findings per story — and write a structured daily journal to `.qds/meta/daily/YYYY-MM-DD.yaml`
- **FR78:** The daily cron agent operates as observe-only — it reads operational data (attribution chain logs, overlay budget manifests, learning records, stall/recovery events, phase boundary transfer logs, BMAD/QA outcome data) and writes a journal, but makes no changes to factory configuration or behavior
- **FR79:** A weekly cron agent can read the last 7 daily journals, identify recurring patterns (issues flagged on multiple days), distinguish signal from noise, and rank improvement opportunities by estimated impact
- **FR80:** The weekly cron agent can select the single highest-impact improvement opportunity and implement a targeted change — operational parameters (prompt template adjustments, overlay composition rebalancing, context budget reallocation) apply normally; cost-impacting changes (tier policy updates, budget-affecting configurations) are flagged as "cost-impacting change" with elevated dashboard visibility
- **FR81:** The weekly optimizer focuses on one improvement per cycle — it does not attempt multiple changes simultaneously
- **FR82:** Each meta-optimization change is logged as a single lifecycle record in `.qds/meta/weekly/YYYY-WNN.yaml` containing: what was changed, why (evidence from daily journals), the revert payload (previous configuration state), expected impact, actual impact (updated by subsequent daily observers), and eventual status (active / reverted / confirmed)
- **FR83:** Meta-optimization changes are flagged in the dashboard as "Meta-Optimization Applied" with the rationale summary and a one-click revert control
- **FR84:** If daily journals following a meta-optimization change detect performance degradation using normalized metrics (tokens per file modified, stalls per complexity estimate, BMAD correction rate by scope) comparing like-for-like work, the next weekly optimizer cycle can auto-revert the change and log the reversion reason
- **FR85:** Daily journals and weekly optimization reports are stored in `.qds/meta/` with daily journals in `daily/YYYY-MM-DD.yaml` and weekly reports in `weekly/YYYY-WNN.yaml`
- **FR86:** The meta-optimization system operates within the factory's existing safety boundaries — changes cannot violate Superpowers iron laws, cannot modify git safety rules, cannot increase budget ceilings, cannot disable, remove, or bypass any hook enforcement layer; the optimizer can adjust hook execution parameters (timeouts, sensitivity thresholds) within defined ranges
- **FR87:** Weekly optimizer requires a configurable minimum story completion threshold across the 7-day window before proposing changes; below threshold, it writes an analysis report but makes no changes
- **FR88:** Meta-optimization changes carry a configurable effectiveness window (default 2 weeks); if the daily observer does not detect measurable improvement within the window, the change is auto-reverted and the improvement hypothesis is logged as "unvalidated"
- **FR89:** Dashboard can display a meta-optimization history timeline showing all changes applied, their rationale, measured impact, and current status (active / reverted / confirmed)

### Resilience & Integrity

- **FR91:** Factory can validate story spec files against a required schema at intake, rejecting malformed specs before pipeline launch with specific validation errors
- **FR92:** Factory can detect runtime file contention between concurrent stories (two stories modifying files with shared implicit state) and alert the developer via dashboard *(MVP if feasible, Growth if not — decision deferred to architecture phase; architect evaluates feasibility during system design)*
- **FR93:** Developer can dismiss a specific BMAD finding via dashboard, with the dismissal and rationale logged in the PR evidence body
- **FR94:** Hook execution has a configurable timeout; if a hook crashes or exceeds timeout, the system logs a warning and bypasses that hook invocation rather than permanently blocking agent progress
- **FR95:** Overlay assembly performs Mulch content integrity checks (schema validation, encoding verification) before injection; corrupted entries are excluded with a warning
- **FR96:** API calls without a complete attribution chain are blocked, not silently executed
- **FR97:** Dashboard SSE connection automatically reconnects on drop with state catch-up (replay missed events from Overstory since disconnect)
- **FR98:** Learning records have a configurable retention window; records older than the window are archived to `.qds/learnings/archive/` to prevent unbounded disk growth *(MVP if feasible, Growth if not — decision deferred to architecture phase; architect evaluates feasibility during system design)*
- **FR99:** Developer can manually tag a factory-generated PR as "caused production issue," which feeds as a high-weight negative signal into the learning system and meta-optimization daily observer
- **FR100:** Meta-optimization system tracks cumulative configuration divergence from baseline; when total drift exceeds a configurable threshold, the dashboard flags "significant drift" with a full diff from original configuration and option to reset to baseline *(MVP if feasible, Growth if not — decision deferred to architecture phase; architect evaluates feasibility during system design)*
- **FR101:** Developer can revert a meta-optimization change via CLI command as a fallback when the dashboard is unavailable
- **FR102:** BMAD review profiles are configurable per project (security-focused, API-contract-focused, performance-focused, or custom)
- **FR103:** Factory must never expose API keys, secrets, or credentials in any output: agent output, logs, learning records, PR evidence, dashboard displays, or committed files
- **FR104:** Factory can queue stories when concurrent count exceeds configured capacity, with FIFO default ordering and developer ability to reorder priority via dashboard

### Dashboard Copilot

- **FR105:** Dashboard includes a collapsible chat bar docked to the right edge that provides natural language access to all dashboard state, navigation, and controls via an AI copilot agent
- **FR106:** Copilot can operate in Ask mode — querying current dashboard state (story statuses, agent statuses, costs, pipeline positions, stall classifications) and presenting answers in the chat without modifying any state
- **FR107:** Copilot can operate in Investigate mode — programmatically navigating the dashboard UI (expanding story cards, focusing agent panels, highlighting elements, switching views) while presenting correlated findings from multiple data sources (Overstory state, learning records, meta-optimization journals, attribution logs, Mulch expertise)
- **FR108:** Copilot can operate in Act mode — executing dashboard controls (send nudge, stop agent, dismiss BMAD finding with rationale, reorder story queue) on behalf of the developer, with each action performed visibly through the UI so the developer sees exactly what happens
- **FR109:** Act mode requires explicit developer confirmation for all actions; the copilot states the proposed action and waits for "yes" / "y" / confirm button click before executing
- **FR110:** Copilot actions are performed through the same UI controls the developer uses — the copilot does not bypass the dashboard's control surface or access factory APIs directly
- **FR111:** CopilotKit `useCopilotReadable` hooks expose current dashboard state to the copilot: active stories, agent statuses, pipeline positions, budget/cost data, stall indicators, meta-optimization status, factory vitals
- **FR112:** CopilotKit `useCopilotAction` hooks expose dashboard controls to the copilot: expand/collapse story, navigate to agent, send nudge, stop agent, dismiss finding, show cost breakdown, show meta-optimization timeline, reorder story queue
- **FR113:** AG-UI protocol provides bidirectional streaming between the copilot agent and the dashboard — copilot sends UI action sequences, dashboard streams state updates back
- **FR114:** Copilot can execute multi-step investigations — chaining navigation, data retrieval, and correlation across multiple stories, agents, and data sources in a single conversational turn
- **FR115:** Copilot investigation steps are visible in the chat as action indicators ("📍 Navigating to Story 3...", "🔍 Checking learning records...", "✅ Nudge sent") that the developer can follow in real-time
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
- **FR127:** Telegram user authentication uses a one-time registration code flow — developer runs `qds telegram register` from CLI, receives a 6-character code, sends `/register {code}` to the bot, and the bot maps the Telegram user ID to the factory developer ID
- **FR128:** Messages sent to the Telegram bot that do not match a structured command pattern can be classified by an economy-tier LLM into command intents, with classification cost tracked under a `system:messenger` attribution line and a configurable daily NL budget ceiling (default $1.00)
- **FR129:** Developer can submit PRD documents via Telegram file upload for factory intake processing *(Growth)*

### Agent Performance System

6-layer agent performance and progressive autonomy system synthesized from PaperclipAI economics, GSD verification patterns, and academic research on Process Reward Models. Core insight: LLM agents at inference time have frozen weights — what improves performance is prompt conditioning on performance history, skill-aware task routing, and progressive autonomy unlocking.

- **FR130:** Factory Core can compute action-level process scores (promise + progress) after each post-task hook execution, storing scores in `.qds/performance/actions/` with crash-safe atomic writes. Promise (0.0-1.0) estimates probability of story completion from hook results; Progress (-1.0-1.0) measures advancement toward the goal. *(Transplant: scoring logic adapted from GSD `verify.cjs` artifact validation patterns, 820 LOC; atomic write pattern from existing learning records FR55)*
- **FR131:** Phase Boundary Protocol transfer manifests can include agent confidence declarations (0.0-1.0) that Factory Core validates against historical calibration curves on phase completion, computing Brier score penalty for miscalibration. *(Transplant: confidence-scored fact structure adapted from DeerFlow `memory/updater.py` confidence scoring, 384 LOC → ~250 LOC TypeScript port)*
- **FR132:** Factory Core can compute session-level composite performance scores on story completion, combining task completion rate, code quality metrics (lint clean %, test coverage %, type-check pass), token efficiency (tokens consumed / files modified), fix loop efficiency (BMAD corrections needed / total findings), and hook pass rate (hooks passed first try / total hook executions). *(Transplant: cost aggregation patterns from PaperclipAI `services/costs.ts` 204 LOC; composite scoring is new-write)*
- **FR133:** Factory Core can maintain ELO-style ratings per agent per skill domain (backend-api, frontend-react, database, testing, devops, refactoring), adjusted on story completion based on difficulty estimate vs. actual outcome, with configurable decay factor for recency weighting. *(New-write: ~200 LOC ELO computation module; domain categorization adapted from PaperclipAI agent role taxonomy)*
- **FR134:** Factory Core can assign agents to capability tiers (1-5) based on sustained ELO rating, minimum session count, and calibration quality — with tier stored in agent metadata and included in overlay system prompt. Tier unlock criteria: Tier 1 (default), Tier 2 (ELO > 1200, 5 sessions, calibration < 0.2), Tier 3 (ELO > 1350, 15 sessions, calibration < 0.15), Tier 4 (ELO > 1500, 30 sessions, calibration < 0.1), Tier 5 (ELO > 1600, 50 sessions, zero BMAD critical findings in last 10). *(Transplant: tier/status state machine adapted from PaperclipAI `agents.ts` service status transitions, 633 LOC)*
- **FR135:** Hook Pipeline enforcement density can vary by agent capability tier — Tier 1 agents trigger hooks on every edit, Tier 2-3 on every 3 tasks, Tier 4 per phase, Tier 5 on escalation only. *(Transplant: hook frequency gating adapted from GSD `config.cjs` workflow toggles, 169 LOC)*
- **FR136:** Factory Core can maintain internal credit balances per agent, computed from story difficulty, outcome quality, and token efficiency — with credit balance influencing task queue priority. Credit decay prevents hoarding; net balance is a single scalar for agent value. *(Transplant: budget tracking columns and cost aggregation from PaperclipAI `db/schema/agents.ts` budgetMonthlyCents/spentMonthlyCents pattern + `services/costs.ts` summary functions)*
- **FR137:** Overlay injection (Stage 4) can include agent performance context: current tier, domain ratings with trend indicator, recent calibration data, and credit balance — within existing token ceiling (~500 additional tokens). *(Transplant: injection pattern adapted from DeerFlow memory injection with max facts + token ceiling, `memory/updater.py` → `memory/queue.py` injection logic)*
- **FR138:** Factory Core can route stories to agents based on domain-specific ELO ratings, matching story file-scope to agent domain strengths. *(Transplant: task assignment/routing patterns from PaperclipAI `services/heartbeat.ts` workspace routing logic, 2517 LOC — extract ~200 LOC matching logic)*
- **FR139:** Dashboard can display per-agent performance cards showing: current tier with badge, domain ratings with sparkline trend indicators, calibration curve visualization, credit balance bar, and session history timeline. *(Transplant: dashboard component patterns from DeerFlow frontend `core/threads/hooks.ts` 488 LOC for real-time state hooks; card layout is new-write)*
- **FR140:** Performance data (action scores, session scores, ratings, tiers) can be exported as structured YAML for external analysis. *(Transplant: export schema adapted from GSD `state.cjs` cmdStateSnapshot/cmdStateJson patterns, 721 LOC)*
- **FR141:** Developer can manually override agent tier assignments via dashboard or CLI, with override logged in activity log. *(Transplant: activity logging from PaperclipAI `services/activity-log.ts` 46 LOC — direct copy with SQLite adapter swap)*

### Economic Governance Enhancements

Extends FR36-FR42 with per-agent budgets, rate limit tracking, credit economy, and atomic task checkout — transplanting patterns from PaperclipAI and Symphony.

- **FR142:** Factory Core can enforce per-agent monthly budget caps with auto-pause on exhaustion, extending FR39's global ceiling to per-agent granularity. When an agent's monthly spend reaches its budget cap, the agent's status changes to paused and a Telegram notification is dispatched when messenger is enabled. *(Transplant: per-agent budget enforcement from PaperclipAI `db/schema/agents.ts` budgetMonthlyCents field + `services/costs.ts` threshold check — direct port to SQLite Drizzle schema)*
- **FR143:** Factory Core can track rate limit snapshots per session, recording rate limit headers from Pi SDK responses (remaining calls, reset timestamp, token bucket state) for capacity planning. *(Transplant: token accounting pattern from Symphony `orchestrator.ex` token tracking via Codex AppServer events — port ~100 LOC tracking logic from Elixir to TypeScript)*
- **FR144:** Attribution chain (FR42) can include cost-per-initiative rollups linking token spend to story → project groupings, enabling cost reporting at the initiative level. *(Transplant: cost-per-project attribution from PaperclipAI `services/costs.ts` byProject() function + `db/schema/cost_events.ts` project/goal foreign keys — direct port)*
- **FR145:** Factory Core can implement atomic task checkout — when a story is assigned to an agent team, a checkout lock prevents duplicate assignment until the team releases or times out. *(Transplant: atomic checkout from PaperclipAI `db/schema/agent_wakeup_requests.ts` claimedAt pattern + `services/heartbeat.ts` start lock mechanism — direct port to SQLite)*
- **FR146:** Dashboard can display cost-per-initiative breakdowns and per-agent budget utilization with monthly spend vs. budget progress bars. *(New-write: dashboard component; data source from transplanted FR142/FR144 services)*

### Orchestration Enhancements

Extends pipeline execution with per-phase concurrency, workspace lifecycle hooks, turn-based continuation, deviation handling, and wave decomposition — transplanting patterns from Symphony, GSD, and PaperclipAI.

- **FR147:** Factory Core can enforce per-phase-type concurrency limits (e.g., max 2 concurrent BMAD reviews, max 5 concurrent dev phases) independently of global story concurrency. *(Transplant: per-state concurrency limits from Symphony `orchestrator.ex` max_concurrent_agents_for_state() pattern + Config.max_concurrent_agents logic, lines 254-277 — port ~150 LOC from Elixir to TypeScript)*
- **FR148:** Worktree lifecycle can execute structured hooks at 4 points: after_create (git clone + env setup), before_run (dependency install + verification), after_run (metric collection + test results capture), before_remove (cleanup verification + orphan check). Hook scripts are configurable in `factory.yaml`. *(Transplant: workspace lifecycle hooks from Symphony `workspace.ex` create_for_issue() + hook mechanism, 275 LOC — port to TypeScript with Bun.spawn() for hook execution)*
- **FR149:** Agents can execute multiple turns within a single phase before triggering phase transition, with continuation logic checking whether the phase goal is achieved after each turn. Max turns per phase type is configurable. *(Transplant: turn-based continuation loop from Symphony `agent_runner.ex` do_run_codex_turns() pattern, 154 LOC — port to TypeScript; continuation prompt template from lines 106-114)*
- **FR150:** Factory Core can implement automatic deviation handling with 4 rules: R1 auto-fix bugs discovered during execution, R2 auto-add missing critical functionality, R3 auto-fix blocking issues, R4 ask about architecture changes — with all deviations logged in learning records and tracked in story summary. *(Transplant: deviation tracking format and 4-rule system from GSD SUMMARY.md deviation template + verification in `verify.cjs` cmdVerifySummary(), ~200 LOC of the 820 total)*
- **FR151:** Factory Core can decompose epics into dependency-aware waves where within-wave stories execute in parallel and between-wave stories execute sequentially. Stories declare wave assignment and dependencies; Factory Core builds a wave index and executes accordingly. *(Transplant: wave-based parallelization from GSD `phase.cjs` cmdPhasePlanIndex() wave grouping logic + frontmatter wave/depends_on schema from `frontmatter.cjs`, ~300 LOC combined — port CJS→ESM TypeScript)*

### Quality Verification Enhancements

Extends QA swarm with goal-backward verification (Nyquist layer) — transplanting GSD's verification engine that catches "tasks completed but purpose not achieved."

- **FR152:** QA swarm can include a goal-backward verification pass that starts from the story goal, derives must-haves (observable truths, required artifacts with min_lines/contains/exports checks, key integration links with pattern matching), and checks the codebase actually delivers them — independent of task completion status. *(Transplant: goal-backward verification engine from GSD `verify.cjs` cmdVerifyArtifacts() + cmdVerifyKeyLinks() + must_haves schema from `frontmatter.cjs` parseMustHavesBlock(), ~400 LOC combined — port CJS→ESM TypeScript)*
- **FR153:** Goal-backward verification produces a structured VERIFICATION.md per story with truths checked (pass/fail), artifacts confirmed (path exists, line count met, content patterns matched, exports present), links validated (source→target references found with pattern), and gaps identified. *(Transplant: VERIFICATION.md template from GSD `templates/VALIDATION.md` — adapt format to QDS story structure)*
- **FR154:** When goal-backward verification identifies gaps, Factory Core can auto-generate remediation plans and feed them into the fix loop (FR7) without developer intervention. *(Transplant: gap-to-plan generation pattern from GSD verification-patterns reference doc; fix loop integration is new-write extending existing FR7)*
- **FR155:** Context budget validation (FR30) can proactively scope agent tasks to consume less than 50% of the model's effective context window, leaving room for tool responses, iteration, and hook execution. *(Transplant: context budget 50% rule from GSD planning references; enforcement integrated into existing overlay.ts composition pipeline)*

### Memory & Learning Enhancements

Extends Factory Learning System with confidence-scored facts, progressive skill loading, and action-level learning records — transplanting patterns from DeerFlow's LLM-powered memory and GSD's state persistence.

- **FR156:** Learning record synthesis (FR59) can extract structured facts with confidence scores (0.0-1.0) and categories (pattern / pitfall / convention / preference / constraint), using LLM-powered extraction on story completion. *(Transplant: fact extraction with confidence scoring from DeerFlow `agents/memory/updater.py` update_memory() + `agents/memory/prompt.py` extraction prompts, 384+273 LOC — port Python→TypeScript, adapt prompts for factory learning context)*
- **FR157:** Overlay injection (FR61) can rank synthesized learnings by confidence score (descending) when selecting which learnings fit within the token ceiling. Learnings below a configurable confidence threshold (default 0.7) are excluded. *(Transplant: confidence-based ranking and max_injection_tokens pattern from DeerFlow memory config `memory.fact_confidence_threshold` + `memory.max_injection_tokens` settings)*
- **FR158:** Factory Learning System can maintain per-agent memory profiles storing work context, behavioral patterns, and known strengths/weaknesses — updated on story completion with debounced writes. *(Transplant: debounced memory queue from DeerFlow `agents/memory/queue.py` MemoryQueue with per-thread deduplication, 195 LOC — port Python→TypeScript; memory profile schema adapted from DeerFlow `updater.py` user context structure)*
- **FR159:** Skill injection into agent overlays (FR33) can be progressive — loading only skills relevant to the agent's current task scope and role, not the full skill set. Skill matching uses file-scope and role metadata to select applicable skills. *(Transplant: progressive skill loading from DeerFlow `skills/loader.py` skill discovery + enabled-state filtering pattern, ~150 LOC — port Python→TypeScript; skill metadata schema from DeerFlow `skills/types.py`)*
- **FR160:** Learning records can carry action-level process scores (from FR130) alongside story-outcome tags, enabling fine-grained "which specific patterns led to which outcomes" analysis during synthesis. *(Transplant: learning record schema extension adapted from GSD `state.cjs` performance metrics tracking cmdStateRecordMetric(), ~100 LOC — port CJS→ESM TypeScript)*

## Non-Functional Requirements

Quality attributes that specify HOW WELL the system must perform. Only categories relevant to QDS Engineer v2 are included — scalability, accessibility, internationalization, and compliance are intentionally excluded (internal tool for 2 developers, not regulated industry, not public-facing).

38 NFRs across 4 categories. Each NFR is specific, measurable, and testable.

### Performance

- **NFR1:** Dashboard SSE event latency from Overstory state change to dashboard render must be under 2 seconds as measured by timestamp delta between Overstory SQLite write and dashboard DOM update
- **NFR2:** Hook execution (post-edit, post-task) must complete within 2 seconds per hook invocation as measured by hook runner timing logs; hooks exceeding this threshold trigger the timeout bypass per FR94
- **NFR3:** Phase boundary gate checklist (all 6 checks: tests, build, lint, type check, uncommitted changes, manifest validation) must complete within 60 seconds total as measured by gate runner aggregate timing
- **NFR4:** Overlay composition pipeline must assemble a complete agent overlay (all 6 stages) within 500ms, with overlay source files cached in memory after first read, as measured by `overlay.ts` timing instrumentation
- **NFR5:** Dashboard must maintain 30fps minimum render rate with up to 12 active xterm.js agent panels on a machine with 16GB RAM, as measured by browser Performance Monitor
- **NFR6:** Daily meta-optimization cron agent must complete its analysis and write the daily journal within 10 minutes of execution, consuming no more than $0.50 in model API costs per run (assumes economy-tier model)
- **NFR7:** Weekly meta-optimization cron agent must complete its analysis, selection, and change implementation within 30 minutes, consuming no more than $2.00 in model API costs per run (assumes economy-tier model)
- **NFR8:** Copilot response latency for Ask-mode queries must be under 3 seconds from message send to first response token as measured by chat component timing instrumentation

### Security

- **NFR9:** API credentials stored in `factory.yaml` must never be readable by any agent process — Pi SDK mediates all model API access, agents interact with Pi, never with providers directly
- **NFR10:** No API key, secret, or credential may appear in any factory output: agent stdout/stderr, Overstory logs, learning records, PR evidence body, dashboard rendered content, committed files, or `.qds/meta/` journals — as verifiable by automated credential scanning on all output paths
- **NFR11:** Agent filesystem access must be restricted to the assigned worktree and explicit scope at the process level — an agent attempting to read or write outside its scope receives an access denied error, not a warning
- **NFR12:** `factory.yaml` must be excluded from version control via `.gitignore` — the setup script must verify this on every startup and halt with an error if `factory.yaml` is tracked by git
- **NFR13:** Factory branch operations must be restricted to the `qds/` namespace — any factory attempt to create, modify, or delete a branch outside `qds/<dev>/` must be blocked at the Factory Core level before the git command executes

### Reliability

*Crash recovery:*
- **NFR14:** Coordinator must detect agent crash within 10 seconds and spawn a replacement within 30 seconds of detection, as measured by timestamp delta between agent process exit and replacement agent first output
- **NFR15:** After factory process restart, all in-progress stories must resume from last checkpoint with zero data loss — no completed phases re-executed, no learning records lost, no duplicate commits — as verified by crash-and-resume integration testing

*Data integrity:*
- **NFR16:** Learning record writes must be atomic (write to temp file, rename to final path) — a factory process crash at any point during a learning write must not produce a corrupted or partial learning file, as verifiable by crash injection testing
- **NFR17:** Overstory SQLite must handle concurrent read/write from up to 15 agents without data loss, silent write failures, or corruption — as verifiable by concurrent stress testing with write contention scenarios
- **NFR18:** Overstory mail delivery must guarantee exactly-once delivery — a message sent via the mail API must be readable by the recipient within 1 second, with zero lost messages and zero duplicate deliveries, as verified by concurrent mail send/receive stress testing

*State recovery:*
- **NFR19:** Dashboard reconnection after SSE drop or dashboard restart must restore complete state within 5 seconds, including all active story statuses, agent statuses, and phase positions — with zero state loss as verified by comparing pre-disconnect and post-reconnect state snapshots
- **NFR20:** Meta-optimization revert (FR83, FR101) must restore the exact previous configuration state — no partial reverts, no orphaned configuration fragments — as verifiable by diffing pre-change and post-revert configuration snapshots

*Cleanup:*
- **NFR21:** Worktree cleanup (FR40, FR41) must complete for all story termination paths (success, failure, cancellation, circuit breaker) — no orphaned worktrees after 24 hours of factory operation as verified by startup orphan detection scan

*Economics:*
- **NFR22:** Quality pipeline cost (BMAD review + QA swarm phases combined) must not exceed 5% of total story cost as measured by attribution chain cost aggregation per phase

### Operability

- **NFR23:** Factory setup script must complete on a clean machine (with prerequisites installed) in under 5 minutes, with clear progress indicators and specific error messages for each failed prerequisite check
- **NFR24:** Factory must operate on macOS (primary) and Linux — no Windows-only dependencies, no platform-specific path assumptions
- **NFR25:** Factory must be runnable on a developer machine with 16GB RAM, 4 CPU cores, and 20GB free disk — with graceful degradation (reduced concurrency) on machines with 8GB RAM
- **NFR26:** All factory logs must be structured (JSON or YAML) with consistent fields: timestamp, source (agent_id / component), severity (debug / info / warn / error), and message — enabling grep-based debugging without specialized tooling
- **NFR27:** Factory startup must complete (Overstory connected, Pi runtime available, dashboard serving) within 30 seconds on standard hardware
- **NFR28:** Operational configuration (API keys, budget ceilings, model preferences, learning injection level, meta-optimization parameters) takes effect on next story start without requiring factory restart. Structural configuration (ports, paths, database locations) requires factory restart.
- **NFR29:** Factory must detect slow disk I/O (write latency exceeding 100ms average over 60 seconds) and warn the developer via dashboard
- **NFR30:** Copilot Investigate-mode multi-step investigations must complete within 15 seconds for investigations spanning up to 3 data sources, as measured by time from user message to final synthesized response
- **NFR31:** Copilot chat bar must not impact dashboard render performance — dashboard must maintain NFR5's 30fps requirement with the chat bar open and actively streaming responses

*Messenger:*
- **NFR32:** Telegram notification delivery latency must be under 5 seconds from EventStore escalation event write to Telegram push receipt confirmation, as measured by timestamp delta between EventStore `created_at` and Telegram API `sendMessage` response
- **NFR33:** No credentials, API keys, file paths, or system-level details may appear in any Telegram message — all outbound messages must pass through the credential sanitizer (extending NFR9-NFR10 to the Telegram output channel), as verifiable by automated scanning of all formatted messages in test suite
- **NFR34:** Messenger NL processing daily cost ceiling must be configurable (default $1.00) — when the ceiling is reached, NL classification is disabled and unrecognized messages receive a fallback response directing the user to structured commands, as verifiable by cost tracking in attribution.db

*Agent Performance System:*
- **NFR35:** Action-level process score computation (FR130) must complete within 200ms of post-task hook completion, as measured by timestamp delta between hook result write and action score file write — ensuring performance scoring does not become a pipeline bottleneck
- **NFR36:** Performance context injection into agent overlays (FR137) must not exceed 500 tokens and must complete within the existing NFR4 overlay composition 500ms budget — performance data is pre-computed and cached, not computed at injection time
- **NFR37:** ELO rating computation (FR133) and tier evaluation (FR134) must complete within 1 second of story completion, as measured by Factory Core post-story processing timing — these are lightweight arithmetic operations on cached session data
- **NFR38:** Performance data storage (`.qds/performance/`) must use the same atomic write pattern as learning records (NFR16) — write to temp file, rename to final path — ensuring crash safety for all action scores, session scores, and rating updates

## Transplant Inventory

Code transplanted from 4 research repositories (`_research-repos/`). All repos remain as reference material, not project dependencies. The repos are in `.gitignore`.

**Transplant strategy:** Copy and adapt code where the source is TypeScript or easily portable JavaScript. Port algorithms and data structures where the source is Python or Elixir. Write new code only where no source exists.

### PaperclipAI (TypeScript — highest transplant value)

| Source File | LOC | Target Location | Adaptation | FRs Served |
|---|---|---|---|---|
| `packages/db/src/schema/agents.ts` | 40 | `packages/shared-types/src/schemas/agent-performance.ts` | Drizzle Postgres → Drizzle SQLite; extract budget fields | FR134, FR136, FR142 |
| `packages/db/src/schema/cost_events.ts` | 34 | `packages/factory-core/src/economics/cost-events.schema.ts` | Drizzle Postgres → SQLite; add initiative rollup fields | FR144 |
| `packages/db/src/schema/activity_log.ts` | 26 | `packages/factory-core/src/economics/activity-log.schema.ts` | Direct port to SQLite | FR141 |
| `packages/db/src/schema/approvals.ts` | 28 | `packages/factory-core/src/pipeline/approvals.schema.ts` | Direct port; approval types extended for factory context | FR109 (enhanced) |
| `packages/db/src/schema/agent_wakeup_requests.ts` | 40 | `packages/factory-core/src/pipeline/task-checkout.schema.ts` | Direct port; `claimedAt` atomic checkout pattern | FR145 |
| `packages/db/src/schema/agent_task_sessions.ts` | 39 | `packages/factory-core/src/pipeline/agent-sessions.schema.ts` | Direct port to SQLite | FR149 |
| `packages/db/src/schema/agent_runtime_state.ts` | 28 | `packages/factory-core/src/performance/runtime-state.schema.ts` | Direct port; add ELO and tier fields | FR133, FR134 |
| `server/src/services/costs.ts` | 204 | `packages/factory-core/src/economics/costs.service.ts` | Replace Drizzle Postgres queries with SQLite; adapt company→developer scope | FR132, FR136, FR142, FR144 |
| `server/src/services/activity-log.ts` | 46 | `packages/factory-core/src/economics/activity-log.service.ts` | Replace WS publish with EventStore write; swap DB adapter | FR141 |
| `server/src/services/approvals.ts` | 240 | `packages/factory-core/src/pipeline/approvals.service.ts` | Adapt state machine for factory approval types | FR109 (enhanced) |
| `server/src/services/heartbeat.ts` (extract) | ~200 of 2517 | `packages/factory-core/src/pipeline/task-checkout.service.ts` | Extract start-lock and atomic checkout patterns only | FR145, FR138 |
| `packages/shared/src/validators/agent.ts` | 101 | `packages/shared-types/src/validators/agent-performance.ts` | Adapt Zod schemas for factory agent context | FR130-FR141 |
| `packages/shared/src/validators/cost.ts` | 23 | `packages/shared-types/src/validators/cost-event.ts` | Direct copy | FR142-FR144 |
| `packages/shared/src/validators/approval.ts` | 37 | `packages/shared-types/src/validators/approval.ts` | Direct copy | FR109 |
| `packages/shared/src/constants.ts` (extract) | ~50 | `packages/shared-types/src/constants/agent-performance.ts` | Extract agent status, roles enums | FR134 |
| **Total transplanted** | **~1,156 LOC** | | | |

### Get-Shit-Done (Node.js CJS — port to ESM TypeScript)

| Source File | LOC | Target Location | Adaptation | FRs Served |
|---|---|---|---|---|
| `get-shit-done/bin/lib/verify.cjs` | 820 | `packages/factory-core/src/verification/nyquist.ts` | CJS→ESM; Node fs→Bun file APIs; execSync→Bun shell; add TypeScript types | FR152, FR153, FR154 |
| `get-shit-done/bin/lib/frontmatter.cjs` (must_haves) | ~150 of 299 | `packages/factory-core/src/verification/must-haves.ts` | CJS→ESM; add Zod schema for must_haves; type YAML parsing | FR152 |
| `get-shit-done/bin/lib/phase.cjs` (waves) | ~300 of 901 | `packages/factory-core/src/pipeline/wave-decomposition.ts` | CJS→ESM; extract cmdPhasePlanIndex wave grouping; add TypeScript types | FR151 |
| `get-shit-done/bin/lib/state.cjs` (metrics) | ~200 of 721 | `packages/factory-core/src/performance/session-metrics.ts` | CJS→ESM; extract cmdStateRecordMetric + cmdStateSnapshot; adapt to `.qds/` paths | FR132, FR140, FR160 |
| `get-shit-done/bin/lib/config.cjs` | 169 | `packages/factory-core/src/performance/tier-config.ts` | CJS→ESM; adapt config schema for tier unlock criteria and hook density toggles | FR134, FR135 |
| `get-shit-done/templates/VALIDATION.md` | ~50 | `packages/factory-core/src/verification/templates/VERIFICATION.md` | Adapt template for QDS story structure; rename fields | FR153 |
| `get-shit-done/references/checkpoints.md` | 777 | Reference only — informs FR150 deviation rules | No code transplant; architectural reference for deviation handling design | FR150 |
| **Total transplanted** | **~1,689 LOC** | | | |

### DeerFlow (Python → TypeScript port)

| Source File | LOC | Target Location | Adaptation | FRs Served |
|---|---|---|---|---|
| `backend/src/agents/memory/updater.py` | 384 | `packages/factory-core/src/learning/confidence-scorer.ts` | Python→TypeScript; LangGraph→Pi SDK for LLM calls; Pydantic→Zod for schemas | FR131, FR156, FR157 |
| `backend/src/agents/memory/queue.py` | 195 | `packages/factory-core/src/learning/memory-queue.ts` | Python→TypeScript; asyncio→Bun async; per-thread→per-agent dedup | FR158 |
| `backend/src/agents/memory/prompt.py` | 273 | `packages/factory-core/src/learning/extraction-prompts.ts` | Python f-strings→TypeScript template literals; adapt prompts for factory learning context | FR156 |
| `backend/src/skills/loader.py` | ~100 of total | `packages/factory-core/src/overlay/progressive-skills.ts` | Python→TypeScript; adapt recursive SKILL.md scan to Superpowers skill structure | FR159 |
| `backend/src/skills/types.py` | ~30 | `packages/shared-types/src/types/skill.ts` | Python dataclass→TypeScript interface + Zod schema | FR159 |
| `backend/src/channels/base.py` | 108 | Reference — validates existing ADR-014 channel abstraction design | No code transplant; confirms QDS messenger architecture | FR120-FR129 |
| `frontend/src/core/threads/hooks.ts` | 488 | `packages/dashboard/src/hooks/use-performance-stream.ts` | Direct TypeScript; adapt LangGraph SDK streaming→SSE streaming; reuse React Query patterns | FR139 |
| `frontend/src/core/memory/types.ts` | ~50 | `packages/shared-types/src/types/agent-memory.ts` | Direct TypeScript; adapt memory schema for factory context | FR158 |
| **Total transplanted** | **~1,628 LOC** | | | |

### Symphony (Elixir → TypeScript port)

| Source File | LOC | Target Location | Adaptation | FRs Served |
|---|---|---|---|---|
| `elixir/lib/symphony_elixir/workspace.ex` | 275 | `packages/factory-core/src/worktree/lifecycle-hooks.ts` | Elixir→TypeScript; GenServer→EventEmitter; adapt hook mechanism for Bun.spawn() | FR148 |
| `elixir/lib/symphony_elixir/agent_runner.ex` | 154 | `packages/factory-core/src/pipeline/turn-continuation.ts` | Elixir→TypeScript; extract do_run_codex_turns loop; adapt continuation prompt template | FR149 |
| `elixir/lib/symphony_elixir/orchestrator.ex` (extract) | ~300 of 1523 | `packages/factory-core/src/pipeline/concurrency-limiter.ts` | Extract max_concurrent_agents_for_state, stall detection, exponential backoff math | FR147, FR22 (enhanced) |
| `elixir/lib/symphony_elixir/config/schema.ex` (extract) | ~100 of 517 | `packages/shared-types/src/schemas/concurrency-config.ts` | Ecto→Zod schema; extract workspace, agent, polling config validation | FR147, FR148 |
| `SPEC.md` + `WORKFLOW.md` | Reference | Reference — informs factory.yaml workspace section design | No code transplant; architectural reference for config schema | FR148 |
| **Total transplanted** | **~829 LOC** | | | |

### Transplant Summary

| Source Repo | Language | Total LOC Transplanted | Adaptation Complexity | New-Write LOC Estimated |
|---|---|---|---|---|
| PaperclipAI | TypeScript | ~1,156 | Low (same language, Postgres→SQLite) | ~400 |
| Get-Shit-Done | Node.js CJS | ~1,689 | Medium (CJS→ESM, add types) | ~300 |
| DeerFlow | Python + TypeScript | ~1,628 | Medium-High (Python→TS port, framework swap) | ~500 |
| Symphony | Elixir | ~829 | High (different paradigm, extract algorithms) | ~200 |
| **Total** | | **~5,302 LOC transplanted** | | **~1,400 LOC new-write** |

**Transplant ratio:** ~79% transplanted/adapted, ~21% new-write for the FR130-FR160 capability set. Research repos remain at `_research-repos/` as reference material during implementation.
