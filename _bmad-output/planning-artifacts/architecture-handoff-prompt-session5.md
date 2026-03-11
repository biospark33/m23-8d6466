# Architecture Handoff Prompt — Session 5: Developer Communication Layer Investigation

**Date:** 2026-03-03
**From:** Architecture workflow (Sessions 1-4 complete, editorial review complete)
**To:** New conversation for deep investigation of bidirectional developer communication via messaging integration (Telegram or similar)

---

## Context

You are Winston, the Architect, continuing architecture work on QDS-Engineer-New — a full-stack AI Workforce Management Platform that accepts development stories and produces production-ready, adversarially-reviewed, evidence-backed pull requests with minimal human intervention.

The complete architecture document is at:
`_bmad-output/planning-artifacts/architecture.md` (1,461 lines, 13 ADRs, status: complete)

The PRD is at:
`_bmad-output/planning-artifacts/prd.md`

The UX design specification is at:
`_bmad-output/planning-artifacts/ux-design-specification.md`

**Governing directive from Steve:** "Forget MVP mindset. Build the future of agentic engineering." with "full enterprise grade rigor. no shortcuts."

---

## What Steve Wants to Investigate

Steve wants the factory to become **an extension of the developer** — not a system you visit via a dashboard, but a system that reaches out to you. The core insight:

> "If the system feels like it needs to run something up the ladder to a human, it needs to be able to ping them in a convenient way."

He's thinking about deep integration with a messaging platform like **Telegram** where:

1. **System → Developer (outbound notifications):** The factory can message the developer when something needs attention — human escalation events, questions, approvals needed, story completions, circuit breaker trips, anomalies
2. **Developer → System (inbound commands):** The developer can send messages back to trigger factory actions — kick off stories, send nudges, approve actions, submit PRDs, reorder queues, check status
3. **Bidirectional conversation:** The system can ask a question and wait for an answer, creating an asynchronous dialogue that doesn't require the dashboard to be open

This transforms the dashboard from "the only control surface" to "the deep control surface" while the messaging integration becomes "the ambient control surface" — the developer stays connected to the factory while doing other things (walking, meetings, commuting, sleeping while cron runs).

---

## Existing Architecture Touchpoints

The current architecture has **17 specific human escalation/notification points** that currently dead-end at "dashboard shows X" or "escalates to developer." These are the exact seams where a messaging integration would plug in:

### Human Escalation Events (System Needs Human)

| Event | Current Behavior | FR Reference |
|---|---|---|
| Agent crash recovery exhausted (3 attempts) | Dashboard shows failure, story stalls | FR22 |
| Fix-loop circuit breaker tripped | Story halts, "escalates to developer" | FR7 |
| Per-story budget exceeded | Story halts, developer must decide: increase or cancel | FR38 |
| Daily global budget exhausted | All non-critical work pauses | FR39 |
| API provider fully down | All stories stall, dashboard shows provider status | FR75 |
| All agents in a story crash | Story fails, other stories continue | FR74 |
| Runtime file contention detected | Dashboard alert | FR92 |
| Learning synthesis conflict | Flagged for human resolution | FR59 |
| Meta-optimization drift threshold exceeded | Dashboard flags "significant drift" | FR100 |
| Meta-optimization change applied | Dashboard shows rationale + one-click revert | FR83 |
| Disk/memory critical threshold | Halt new story starts or agent spawns | FR73 |

### Developer Action Points (Human Needs to Act)

| Action | Current Surface | FR Reference |
|---|---|---|
| Stop agent | Dashboard button | FR25 |
| Send nudge to agent | Dashboard + mail system | FR26 |
| Dismiss BMAD finding | Dashboard, logged in PR evidence | FR93 |
| Reorder story queue | Dashboard drag-and-drop | FR104 |
| Override story dependencies | Dashboard | FR3 |
| Tag PR as "caused production issue" | Manual | FR99 |
| Revert meta-optimization | Dashboard one-click or CLI fallback | FR83, FR101 |
| Retract a synthesized learning | Manual | FR63 |

### Existing Communication Channels

| Channel | Protocol | Purpose |
|---|---|---|
| Dashboard SSE | HTTP SSE, 500ms polling | Factory → Dashboard (state updates) |
| Dashboard WS | WebSocket | Dashboard → Factory (commands) |
| CopilotKit | HTTP SSE via Express | Natural language dashboard control |
| Overstory Mail | SQLite-backed | Agent ↔ Agent, Factory Core → Agent |
| GitHub PR Comments | `gh` CLI | Human → PR → Seeds issue (FR90) |

---

## Investigation Scope

Steve wants this explored with **full enterprise grade rigor**. Investigate deeply:

### 1. Platform Selection
- Telegram Bot API vs alternatives (Slack, Discord, Signal, WhatsApp Business API, custom push notifications)
- Selection criteria: developer UX (mobile + desktop), API maturity, bot capabilities (inline keyboards, file uploads for PRDs, threading), rate limits, security model, self-hosted option
- Steve mentioned Telegram specifically — validate whether it's the right choice or if alternatives are better

### 2. Architectural Integration Pattern
- Where does the messaging integration plug into the existing architecture?
- Is it a new package (`packages/messenger/`)? A Gateway extension? A standalone service?
- How does it relate to the existing SSE/WS channels? Does it subscribe to the same EventStore?
- Should it go through the Gateway or connect directly to Factory Core?
- How does it interact with the Copilot (FR105-FR119)? Is the messaging bot a different surface for the same copilot agent, or a separate simpler interface?

### 3. Inbound Message Processing
- How does a developer kick off a story via Telegram? (Send a message? Send a file? Both?)
- How does authentication work? (Telegram user ID → factory developer ID mapping)
- How do you handle PRD submission? (Telegram file upload → factory intake pipeline)
- Command taxonomy: what's the minimal set of commands that makes the messaging surface useful?
- Natural language vs structured commands vs hybrid

### 4. Outbound Notification Design
- Notification severity levels and routing (what warrants a ping vs what can wait)
- Batching/throttling (don't spam the developer with 50 messages when 5 stories are running)
- Quiet hours / do-not-disturb with queue-and-deliver-later
- Rich message formatting (Telegram supports Markdown, inline keyboards for quick actions like "Approve / Reject / Snooze")
- Actionable notifications (developer taps "Approve" on Telegram → factory receives approval → story continues)

### 5. Asynchronous Dialogue Pattern
- System asks question → developer answers hours later → system continues with answer
- How to maintain conversation state across time gaps
- Timeout handling (if developer doesn't respond in X hours, what happens?)
- Multiple pending questions — how to manage a queue of questions waiting for human input

### 6. Security & Trust
- End-to-end encryption considerations (Telegram supports it for secret chats, not for bot messages)
- No credentials or secrets in messages (extends NFR9-NFR10 to the messaging channel)
- Authentication: how does the factory verify the Telegram message is from the authorized developer?
- Authorization: which commands require additional confirmation?

### 7. Economic Considerations
- Token cost of messaging bot (if using LLM for natural language processing of inbound messages)
- Telegram Bot API is free with generous rate limits — but self-hosted alternatives?
- Attribution: messaging-initiated actions should carry attribution chain like dashboard actions

### 8. Relationship to Existing FRs
- Does this require new FRs added to the PRD?
- Does it modify any existing FRs? (e.g., FR22 "human escalation" gets a concrete channel)
- Does it affect the UX design spec? (messaging as a new "surface" alongside the dashboard)

### 9. The "Extension of the Developer" Vision
- Think beyond notifications. What does it look like when the factory is truly ambient?
- Developer wakes up, checks Telegram: "3 stories completed overnight. 1 PR awaiting your review. Cron found a medium-severity dependency CVE in `lodash` — fix dispatched, awaiting QA. Daily cost: $1.23."
- Developer at lunch, gets ping: "Story WH-042 budget at 80%. Projected to exceed by phase 4. Options: [Increase to $5] [Cancel] [Let it run]"
- Developer sends voice note transcription: "Start story WH-045, it's the auth refactor from the latest epic, standard priority" → factory parses, confirms, executes
- Developer sends a photo of a whiteboard sketch → factory extracts requirements, creates draft PRD for review

### 10. Cron Agent Integration
- Nightly cron agents run while developer sleeps (security scans, dependency audits, dead code detection)
- Morning summary delivered via messaging: what ran, what was found, what was auto-fixed, what needs human attention
- Cron-discovered issues that need human decision: messaging bot queues them with context and action buttons

---

## How to Use This Handoff

1. Load the BMAD architect agent: `/bmad-agent-bmm-architect`
2. Read the complete architecture document: `_bmad-output/planning-artifacts/architecture.md`
3. Read relevant PRD sections (FR22, FR25-FR26, FR38-FR39, FR73-FR75, FR83, FR90, FR92-FR93, FR99, FR101, FR104, FR105-FR119)
4. Use Advanced Elicitation and Party Mode to investigate the messaging integration deeply
5. Produce either:
   - A new ADR (ADR-014) if the investigation yields clear architectural decisions
   - A research findings document if the investigation needs more input from Steve
   - PRD amendments if new FRs are identified

**Steve's bar:** "Full enterprise grade rigor. No shortcuts." This isn't a notification add-on — it's a fundamental shift in the human-factory interaction model. Treat it with the same depth as the CopilotKit investigation (ADR-011, which required 4 sub-decisions and 3 research agents).

---

## Key Files

| File | Purpose |
|---|---|
| `_bmad-output/planning-artifacts/architecture.md` | Complete architecture (20 ADRs — 14 validated + 6 proposed, 17 subsystems) |
| `_bmad-output/planning-artifacts/prd.md` | Product requirements (160 FRs, 38 NFRs — includes transplant inventory) |
| `_bmad-output/planning-artifacts/ux-design-specification.md` | UX design spec (includes Agent Performance Dashboard Surface) |
| `_bmad-output/planning-artifacts/architecture-editorial-review.md` | Editorial review findings (for reference) |
| `_bmad/bmm/agents/architect.md` | Winston's agent file |
| `_bmad/bmm/workflows/3-solutioning/create-architecture/workflow.md` | Architecture workflow |

## Session 6 Context: Research Repo Integration & Agent Performance System

**Date:** 2026-03-10
**What changed:** 4 research repositories explored and patterns + code transplanted into QDS v2 PRD and architecture. PRD expanded from 129→160 FRs. Architecture expanded from 14→20 ADRs. New subsystem #17 (Agent Performance System) added.

### Research Repos (at `_research-repos/`, gitignored)

| Repo | Language | LOC Transplanted | Key Contributions |
|---|---|---|---|
| `_research-repos/symphony/` | Elixir | ~829 | Workspace lifecycle hooks, turn-based continuation, per-state concurrency limits, stall detection with exponential backoff |
| `_research-repos/deer-flow/` | Python + TypeScript | ~1,628 | LLM-powered memory with confidence scoring, progressive skill loading, channel abstraction (validates ADR-014), middleware chain composition |
| `_research-repos/get-shit-done/` | Node.js CJS | ~1,689 | Goal-backward verification (Nyquist layer), wave-based parallelization, deviation handling rules, STATE.md persistence patterns, must_haves schema |
| `_research-repos/paperclip/` | TypeScript | ~1,156 | Per-agent budgets, cost attribution, atomic task checkout, activity logging, approval gates, agent API key scoping — Drizzle ORM schemas (Postgres→SQLite port) |

### New Capability Areas (FR130-FR160)

1. **Agent Performance System (FR130-FR141)** — 6-layer scoring: action scores → confidence calibration → session composites → ELO domain ratings → capability tiers → credit economy. ADR-015.
2. **Economic Governance Enhancements (FR142-FR146)** — Per-agent budgets, rate limit tracking, cost-per-initiative rollups, atomic task checkout. ADR-016.
3. **Orchestration Enhancements (FR147-FR151)** — Per-phase concurrency, workspace hooks, turn continuation, deviation handling, wave decomposition. ADR-018, ADR-019.
4. **Quality Verification Enhancements (FR152-FR155)** — Goal-backward verification (Nyquist), auto-remediation from gaps, context budget 50% rule. ADR-017.
5. **Memory & Learning Enhancements (FR156-FR160)** — Confidence-scored facts, progressive skill loading, per-agent memory profiles, action scores in learning records.

### Transplant Strategy (ADR-020)

~5,302 LOC transplanted/adapted, ~1,400 LOC new-write. 79% transplant ratio. All transplanted code adapted to QDS TypeScript/Bun runtime, SQLite storage, and existing architectural patterns. See PRD Transplant Inventory appendix for file-by-file mapping.

### ADRs 015-020 Status

All 6 new ADRs are **Proposed** — they have not yet been validated through Party Mode multi-agent review. The next architecture session should validate these through the same rigor as ADR-001 through ADR-014.

---

## Steve's Exact Words

> "I also want to think about how the system becomes an extension of the developer. Meaning that if the system feels like it needs to run something up the ladder to a human, it needs to be able to ping them in a convenient way. I'm thinking the system should have intimate integration with something like Telegram where the developer can just send in a message and kick off prompts or even send in a PRD to kick off things or the system can message back if there's a question or something needs to be looked at or something like that."
