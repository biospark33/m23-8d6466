# QDS Factory v3 — Handoff Prompt for New Session

## Copy this entire prompt and paste it into a new Claude Code session:

---

You are continuing work on **QDS Factory v3** — an autonomous coding factory architecture. A detailed plan exists at:

```text
~/.claude/plans/last-session-shit-the-proud-panda.md
```

**READ THAT PLAN FILE FIRST.** It contains the complete architecture, implementation phases, and all design decisions.

## Context

QDS Factory is a system where:
- **Hermes Agent** (at `~/boardlensai/hermes-agent/`) is the 24/7 master orchestrator running on Orgo VM
- **Archon** (at `~/Archon/`) is the structured PIV loop engine (14-node DAG, fresh CC context per node)
- **Agent sessions** run in three modes: Archon-driven (primary), headless Pi with GLM/Kimi via OpenRouter (cheap), interactive Claude Code subscription on Orgo (Max plan)
- **Hindsight** is the core progressive memory system — the key innovation that makes the factory self-improving
- **Mulch + Seeds + claude-mem + GitNexus** are complementary memory layers
- **Telegram/iMessage** for remote control

## Key Repositories

| Repo | Path | Purpose |
|------|------|---------|
| QDS Factory | `~/QDS-Factory/` | This repo. Architecture docs, planning artifacts |
| Hermes Agent | `~/boardlensai/hermes-agent/` | Master orchestrator. 60+ tools, skills, cron, delegate_task |
| Archon | `~/Archon/` | DAG workflow engine. REST API, SSE monitoring, 14-node PIV loop |
| rfp-agents | `~/rfp-agents/` | Target repo for first QDS deployment |
| boardlensai | `~/boardlensai/` | Target repo (also contains Hermes agent) |

## Architecture v3 Key Innovations (read plan for full detail)

### 1. Hindsight as Core Progressive Memory
- Per-repo Hindsight banks with custom missions for code quality learning
- Retain review feedback → auto-consolidate observations → reflect before each PIV phase
- Mental models (Coding Standards, Common Pitfalls, Review Patterns) auto-refreshed nightly
- Entity labels for issue classification (security/style/bug/performance/testing/architecture + severity)
- Per-repo meta banks for operational learning (model performance, skill tuning, wave metrics)
- Progressive improvement flywheel: Story 1 gets 15 bot comments → Story 30 gets 0-2

### 2. Smart Model Routing with Self-Improving Selection
- Multiple API providers: OpenRouter (for GLM/Kimi/Sonnet), Anthropic API (pay-per-token), Anthropic Subscription (Max plan)
- Model router queries Hindsight meta bank before each task assignment
- A/B testing: 10% of tasks get alternate model, outcomes retained for learning
- Rate limit rotation across providers when one hits limits
- System learns "GLM-5-turbo works great for EXPLORE but poorly for IMPLEMENT" over time

### 3. Self-Improving Skills
- Hermes skills (piv-loop, pr-monitor, wave-executor, model-router) evolve via Hindsight feedback
- After each execution, retain skill performance metrics to Hindsight meta bank
- Weekly `qds-learning` cron reflects on accumulated data, proposes parameter changes
- High-confidence changes auto-apply (3+ supporting observations), low-confidence go to Telegram for approval

### 4. Parallel Wave Execution
- Seeds decomposes epics into stories with dependency graphs
- Wave executor runs unblocked stories in parallel (max 3 concurrent)
- GitNexus `impact()` detects file-level conflicts before parallel execution
- Each story gets its own Archon workflow run + git branch
- Merge coordination: wave N+1 starts only after wave N PRs merge
- Learning: Hindsight tracks optimal parallelism per module ("auth module can't go beyond 2 parallel")

### 5. Cross-Layer Memory Consolidation
- Nightly cron: claude-mem observations → Hindsight retain, mulch expertise → Hindsight retain
- Mental models refreshed after consolidation
- Weekly deep consolidation: Hindsight reflect → propose workflow improvements → tune skills + model routing
- Static wiki (.claude/qds/wiki/) kept for human docs only; dynamic wiki replaced by Hindsight mental models

## Hindsight Documentation

Full Hindsight docs available at `~/.claude/skills/hindsight-docs/`:
- `references/best-practices.md` — Mission design, tag strategies, anti-patterns
- `references/developer/api/retain.md` — Content format, document_id for upsert, observation scopes
- `references/developer/api/recall.md` — 4 retrieval strategies, budget levels, tag filtering, tag_groups
- `references/developer/api/reflect.md` — Agentic reasoning loop, response_schema for structured output
- `references/developer/observations.md` — Auto-consolidation, evidence tracking, freshness trends
- `references/developer/mcp-server.md` — Built-in MCP at /mcp/{bank_id}/, CC integration

## What I Want From This Session

The plan is at ~10 sessions of implementation work. I want you to:

1. **Read the plan file** at `~/.claude/plans/last-session-shit-the-proud-panda.md` — understand it deeply
2. **Review the plan critically** — identify gaps, risks, or improvements that would make this system truly world-class
3. **Sharpen the Hindsight integration** — look for ways to extract more value from the memory system. Are there additional retain/recall/reflect points we're missing? Are the missions optimal? Could entity labels or observation scopes be better configured?
4. **Sharpen the parallelization** — is wave execution robust enough? What about partial merges, rebase conflicts, or stories that get blocked mid-execution?
5. **Sharpen the self-improvement loops** — are the feedback loops tight enough? Will skills actually improve measurably? Are the metrics right?
6. **Propose concrete improvements** — not vague "consider X" but specific changes to the plan with implementation detail

**Focus areas for iteration:**
- How can Hindsight be leveraged even more deeply? (e.g., per-reviewer mental models that track coderabbitai vs gemini-code-assist patterns separately?)
- Is the model routing + A/B testing design robust? What happens when a model gets worse over time (new version)?
- Wave parallelization edge cases: what if two stories touch the same test file? What if a story fails mid-wave?
- Skill evolution: is the feedback loop fast enough or will it take weeks to see improvement?
- Cost optimization: can we push more work to free-tier models without quality loss?

## Previous Session Artifacts

| File | Location |
|------|----------|
| v2 Design Spec (approved) | `_bmad-output/planning-artifacts/qds-on-archon-design-2026-05-10.md` |
| v2 Implementation Plan (18 tasks, not started) | `_bmad-output/planning-artifacts/qds-on-archon-implementation-plan-2026-05-10.md` |
| v3 Plan (current, being iterated) | `~/.claude/plans/last-session-shit-the-proud-panda.md` |
| Hindsight docs | `~/.claude/skills/hindsight-docs/` |

## Important Notes

- This is a PLANNING session. Do not write implementation code. Iterate on the plan.
- Use the `/hindsight-docs` skill for Hindsight API reference when designing integration points.
- The v2 implementation plan has 18 tasks — these are still valid but need updating for v3 architecture (Hindsight, model routing, wave execution additions).
- Hermes has built-in `delegate_task` with `max_concurrent_children=3` and a background review fork for skill evolution — leverage these.
- Archon has REST API for workflow management + SSE for monitoring — Hermes calls these via `terminal` tool (curl).
- GitNexus is already running as MCP server — use for structural code analysis.
- The user wants this system to be truly self-improving at multiple levels: code quality, skill performance, model selection, parallel execution efficiency.
