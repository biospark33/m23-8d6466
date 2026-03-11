# PRD Session Handoff Context

**Purpose:** This file captures all accumulated insights, drafted content, and design decisions from the first PRD creation session that have NOT yet been appended to the PRD document. The new session must incorporate this context when resuming.

**Date:** 2026-03-02
**Session ended at:** Step 4 of 13 (User Journey Mapping) — content drafted but not yet appended

---

## DRAFTED BUT NOT YET SAVED: User Journeys (Step 4)

The following user journey content was drafted, reviewed by Steve, and approved in principle. It needs to be appended to the PRD when Step 4 is completed in the next session.

### Journey 1: Steve Runs an Epic Through the Factory (Primary - Success Path)

Steve has an epic with 4 stories for a new webhook retry system. He's already written the story specs during a brainstorming session. It's Monday morning.

**Opening Scene:** Steve opens the QDS dashboard in his browser. The Factory Overview shows all systems green — Overstory connected, Pi runtime available, 3 OpenRouter API keys healthy, token budget at $0 spent today. He clicks "New Session," selects the epic, confirms the 4 stories, and reviews the auto-detected dependencies (Story 2 depends on Story 1, Stories 3 and 4 are independent). He hits "Start."

**Rising Action:** The dashboard comes alive. Three stories spin up simultaneously (Story 2 waits for Story 1). Agent Windows show 12 agents across 3 worktrees — coordinators, leads, builders, scouts. Steve watches Story 3's builder writing tests first (TDD enforced via Superpowers). The token ticker shows economy-tier models handling scout work while Sonnet drives the builders. He notices Story 1's lead is consuming tokens faster than expected — the Factory Core's budget bar shows 45% of Story 1's develop-phase allocation used at 60% task completion. He makes a mental note but doesn't intervene.

**Climax:** Story 1 completes development. The dashboard shows a phase transition animation — dev agents fade out, fresh BMAD agents spin up with clean context indicators. The BMAD spec reviewer finds that the retry backoff implementation doesn't match the spec's maximum retry count. It flags this as a critical finding. The coordinator spawns a Fix-Lead. Steve watches the fix happen in real-time — the Fix-Lead receives the BMAD finding via mail, corrects the retry count, and BMAD re-reviews. Pass. QA swarm launches — 4 parallel scouts on GLM-5, barely registering on the cost ticker. All 5 waves complete. PR created with full evidence: "BMAD found 1 critical spec violation (retry count), QA found 0 issues across 5 waves."

**Resolution:** By afternoon, all 4 stories have PRs. Total cost: $4.82 across all stories (development phases dominated, quality pipeline was $0.07 total). Steve reviews the PRs — the evidence sections give him confidence. He merges. His co-dev pulls and the webhook retry system works. Steve spent 6 hours doing other work while the factory ran.

**Requirements revealed:** Story submission UI, dependency detection, real-time agent windows, phase transition visualization, budget tracking per story, BMAD evidence in PRs, cost breakdown by phase and model tier.

### Journey 2: Steve Deals with a Factory Problem (Primary - Edge Case / Error Recovery)

It's Wednesday. Steve kicked off a complex story involving a database migration. Something isn't right.

**Opening Scene:** Steve glances at the dashboard 20 minutes after starting the story. The Agent Windows show the builder agent's status as "stalled" — it's been on the same task for 8 minutes with no file changes. The token ticker is climbing but no output is appearing in the xterm.js panel.

**Rising Action:** Steve clicks "Inspect" on the stalled agent. The live output shows the agent is in a loop — it keeps trying to import a module that doesn't exist in the worktree. It's hallucinating a dependency. Steve clicks "Stop" on the agent. The coordinator detects the agent stopped and spawns a replacement builder. But Steve realizes the issue is the story spec — it references a module that was renamed last week. The Mulch expertise is stale on this.

**Climax:** Steve clicks "Nudge" on the story lead with a message: "Module `db-utils` was renamed to `database-helpers` last sprint. Update references." The lead receives the nudge via mail, corrects its understanding, and re-dispatches the builder. This time the builder finds the right module. Development completes. BMAD review passes. QA finds one edge case in the migration rollback logic — Wave 3 fixer handles it. PR ships.

**Resolution:** Steve makes a note to update the Mulch expertise for the database module rename. The factory recovered from a stall with two clicks (stop + nudge) and a one-line message. Total delay: 15 minutes.

**Requirements revealed:** Agent stall detection with visual indicators, stop/nudge/inspect controls per agent, nudge-via-mail mechanism, live xterm.js output for debugging, Mulch expertise update workflow, coordinator auto-recovery on agent stop.

### Journey 3: Co-Dev Configures and Runs Their Own Instance (Operations / Setup)

Steve's co-dev is setting up QDS v2 on their machine for the first time.

**Opening Scene:** Co-dev clones the QDS-Engineer-New repo and runs the setup script. It detects the source projects (Overstory, Superpowers, ZeroClaw, Pi, claude-mem), verifies dependencies (Bun, Rust toolchain for ZeroClaw cron), and creates a default `config/factory.yaml`. Co-dev opens the config and fills in their own OpenRouter API key and preferred default model.

**Rising Action:** Co-dev starts the dashboard (`bun run dev`). The Factory Overview shows their system — their API keys, their model routing config, zero active stories. They pick a story from the team's backlog (tracked in Seeds), review the story spec, and hit Start. Their machine, their agents, their dashboard. Steve's factory instance knows nothing about this — they're fully independent.

**Climax:** The co-dev's factory runs the story through all 5 phases. They're watching their own Agent Windows, their own cost tracker. BMAD catches a naming convention violation (the co-dev used camelCase where the project uses snake_case — Mulch had recorded this convention from Steve's earlier sessions). The fix-lead corrects it. PR created.

**Resolution:** Co-dev pushes the PR. Steve reviews it — the BMAD evidence shows the convention violation was caught and fixed. Steve merges. Both developers are running independent factory instances against the same repo, each seeing their own work, each with their own API keys and budgets. The shared state is the git repo and Seeds issue tracker.

**Requirements revealed:** Setup/install script, factory.yaml configuration, per-developer API key config, independent dashboard instances, Seeds as shared issue tracker across developers, Mulch expertise shared via git (`.mulch/` committed to repo), PR attribution (which developer's factory generated this).

### Journey 4: Steve Reviews a Factory-Generated PR (Reviewer)

Steve's co-dev's factory generated a PR overnight. Steve opens it in the morning.

**Opening Scene:** Steve opens the PR on GitHub. The body is structured with Development Summary, BMAD Review Findings, QA Swarm Results, and Files Changed sections including model routing info, cost, and duration.

**Rising Action:** Steve reads the code. The BMAD evidence tells him exactly what was caught and fixed — he doesn't need to hunt for issues the review might have missed. The QA section shows edge cases were found and verified. He checks the test coverage — 94%.

**Climax:** Steve spots something the factory missed — the rate limit config should use environment variables, not hardcoded values. He leaves a comment. The co-dev's next factory session can pick this up as a follow-up story.

**Resolution:** Steve merges with confidence. The evidence section gave him 90% of the review context he needed. His comment becomes a new Seeds issue for the co-dev's factory to handle. Total review time: 5 minutes instead of the usual 30.

**Requirements revealed:** Structured PR body template with BMAD/QA evidence, cost and model attribution, factory instance identification (which developer generated it), clear findings-and-fixes narrative, test coverage reporting, integration with existing PR review workflow (human comments become Seeds issues).

### Journey Requirements Summary

| Capability | J1 | J2 | J3 | J4 |
|-----------|----|----|----|----|
| Story submission + dependency detection | X | | | |
| Real-time agent windows with xterm.js | X | X | X | |
| Phase transition visualization | X | | X | |
| Budget/cost tracking per story | X | | X | |
| Agent stall detection + visual indicators | | X | | |
| Stop/nudge/inspect controls | | X | | |
| Nudge-via-mail mechanism | | X | | |
| Setup/install script | | | X | |
| Per-developer config (API keys, models) | | | X | |
| Independent dashboard instances | | | X | |
| Seeds as shared cross-developer tracker | | | X | X |
| Mulch shared via git | | | X | |
| Structured PR evidence template | X | | | X |
| Factory instance attribution on PRs | | | | X |
| BMAD/QA findings narrative in PR body | X | | | X |
| Model routing visibility | X | | X | X |

**Key architectural insight:** Two-developer model means shared state = git repo (code + Mulch + Seeds), runtime state = per-developer-instance (agents, dashboard, API keys, budgets). Foundation for eventual multi-developer coordination.

---

## CRITICAL UNDOCUMENTED INSIGHT: Factory Learning System (5th Differentiator)

Steve identified a 5th differentiator during the Step 4 discussion that is NOT yet in the PRD: **The factory should continuously learn from itself and get smarter over time.**

### Three Learning Loops Designed:

**Loop 1: Session-Level (Agent → Orchestrator, same run)**
- Post-task hook extracts: files modified, struggles (error count, retries, stalls), patterns discovered, tools used
- Transmitted via Overstory mail (new `learning_report` mail type) to story lead
- Lead gets real-time learning about what's working for its builders

**Loop 2: Story-Level (Phase → Phase, same story)**
- Phase Boundary Protocol extended with `learnings` section
- Includes: struggles with resolution, discoveries, conventions confirmed
- BMAD agents know what dev agents struggled with → focus review there
- QA agents receive cumulative learnings from dev + BMAD

**Loop 3: Cross-Session (Day → Night → Next Day)**
- Every agent writes structured learning records to `.qds/learnings/YYYY-MM-DD/` on termination
- Records: struggles (category, description, resolution, tokens wasted), discoveries, patterns used, recommendations
- Nightly synthesis cron job (post-MVP): reads day's learnings, groups by theme, deduplicates, weighs by frequency/impact
- Produces synthesized project learnings in `.qds/learnings/synthesized/`
- **KEY: Next morning's agents get relevant learnings AUTO-INJECTED into overlay** (not opt-in lookup)
- Factory Core overlay.ts matches synthesized learnings to agent's file scope and role
- Agent starts with "Relevant Factory Learnings" section already in context

### Relationship to Existing Memory Systems:

| System | Purpose | Consumer |
|--------|---------|----------|
| Mulch | Conventions and domain expertise ("what are the rules") | Agents (via ml prime) |
| claude-mem | Human session continuity ("what happened last time") | Human developer |
| Factory Learning Log (NEW) | Operational knowledge ("what are the gotchas") | Agents (auto-injected into overlay) |
| Seeds | Task state tracking | Factory Core, Dashboard, Developers |

### MVP vs Post-MVP Split:
- **MVP:** Raw learning records (YAML on agent exit), learning_report mail type, learnings in Phase Boundary Protocol, overlay injection from synthesized/ if exists
- **Post-MVP:** Nightly synthesis cron job, confidence scoring, token-waste tracking, automatic expiry detection, claude-mem integration, learning effectiveness tracking

---

## KEY DECISIONS FROM SESSION (for reference)

1. **Approach C confirmed:** Factory Core as the Brain, source projects as libraries
2. **Internal tool first**, potential B2B later — no consumer onboarding concerns for MVP
3. **Two developers (Steve + co-dev)**, each running independent factory instances, shared state via git
4. **MVP scope:** Full pipeline + multi-story parallelism + dashboard (Milestones 1-3). NOT CLI-only.
5. **Economy models (GLM-5)** for QA/review — quality pipeline costs ~$0.02/story
6. **Cron self-healing loop is post-MVP** (Growth)
7. **Kanban, Metrics Dashboard, Brainstorm tentacle are post-MVP/Vision**
8. **Self-healing guardrails designed:** fix-loop circuit breaker, blast radius limits, regression chain detection, priority arbitration, daily cron budget ceiling, configurable merge policies
9. **5-layer context management:** Session (Overstory), Behavioral (Superpowers), Phase (new Phase Boundary Protocol), Institutional (extended Mulch), Cross-Tentacle (isolation-only)
10. **Context patterns stolen from:** ZeroClaw (pre-compaction fact extraction, time decay, category boosting, heartbeat staleness), claude-mem (progressive disclosure, token economics, session summary format, hybrid search, content dedup)

## ELICITATION METHODS USED (15 total across 3 rounds)

Round 1 (Classification): Pre-mortem, ADR, What-If Scenarios, First Principles, Red Team vs Blue Team
Round 2 (Differentiators 1+2): User Persona Focus Group, Shark Tank, Reverse Engineering, 5 Whys, Challenge from Critical Perspective
Round 3 (Executive Summary): Pre-mortem, Stakeholder Round Table, Comparative Analysis Matrix, Occam's Razor, Challenge from Critical Perspective

Party Mode sessions: 2 (context management deep-dive with codebase exploration, executive summary structural review)

## SOURCE PROJECT EXPLORATION COMPLETED

Deep exploration agents ran against:
- Overstory: Agent orchestration, mail system, Mulch, Seeds, overlay, checkpoint
- Superpowers: Skills, hard gates, iron laws, TDD, code review, context management
- ZeroClaw: Cron scheduling, session management, memory, dashboard, SSE/WS, security
- claude-mem: Progressive disclosure, token economics, session summaries, hybrid search, hooks
- OpenClaw: Empty repo (ZeroClaw is the successor)
