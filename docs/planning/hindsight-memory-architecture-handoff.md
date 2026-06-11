# QDS-Factory Hindsight Memory Architecture — Handoff Document

**Date**: 2026-06-10
**Status**: Architecture designed, implementation-ready
**Next conversation goal**: Refine proactive agent strategy and begin implementation

---

## Executive Summary

A two-bank Hindsight memory system that makes QDS-Factory self-improving — both the code it produces and the factory process itself. Entity labels with `tag: true` provide structural partitioning within a single bank. Observation consolidation is the learning algorithm. Directives enforce charter compliance at the reflect layer.

---

## Architecture: Two Banks

### Bank 1: `qds-product` — The code we're building

**Purpose**: Every architectural decision, bug pattern, charter principle, and proven approach for the product.

**Tag-based partitioning** (entity labels with `tag: true`):

| Label | Values | Purpose |
|-------|--------|---------|
| `knowledge_type` | `charter`, `decision`, `pattern`, `antipattern`, `state` | Hard SQL filtering at recall |
| `module` | `harness`, `coms`, `auth`, `memory`, `cli`, `infra`, `factory` | Module-scoped queries |
| `severity` | `critical`, `high`, `medium`, `low` | Priority-aware retrieval |

**Key configuration**:
- `disposition_skepticism=4`, `literalism=4`, `empathy=1` — no rationalizing violations
- `retain_extraction_mode="verbose"` — rich fact extraction
- `observation_scopes="per_tag"` — separate observations per module, per knowledge type
- Directives encode non-negotiable PRD rules (enforced during reflect, not cron)
- Mental models: one per module, auto-refresh on consolidation

**Operational surface**:
- After session: `retain(session_summary, tags=[module:X, story:Y])`
- Before session: `recall(tags=["knowledge_type:charter"], tags_match="all")` + `recall(tags=["knowledge_type:antipattern"], tags_match="all")`
- Drift check: `reflect("What contradicts our charter?")` with `include_facts=True`

### Bank 2: `qds-meta` — The factory improving itself

**Purpose**: Skill execution outcomes, prompt effectiveness, review catch rates, workflow patterns.

**Entity labels**:
| Label | Values | Purpose |
|-------|--------|---------|
| `skill` | `bmad-dev-story`, `bmad-review-adversarial`, `qds-story-review`, etc. | Per-skill analysis |
| `outcome` | `success`, `partial`, `failure`, `false_positive`, `missed` | Outcome-filtered retrieval |
| `quality_dim` | `correctness`, `security`, `performance`, `testability`, `maintainability` | Multi-value quality scoring |

**Key configuration**:
- `disposition_skepticism=5` — question everything in meta-analysis
- `literalism=3` — balanced interpretation for pattern detection

**Operational surface**:
- After every skill execution: `retain(skill_result, tags=[skill:X, outcome:Y, quality_dim:Z])`
- Before skill execution: `reflect("What should I know about this skill's strengths and pitfalls?")` with `response_schema` for structured recommendations

---

## How Drift Detection Works (Without Cron Agents)

1. Decisions retained with `knowledge_type:decision` tag
2. Contradictory implementations retained later
3. Observation consolidation **refines** the observation (doesn't overwrite) — tracks the contradiction
4. Observation freshness trends: `stable → weakening` IS the drift signal
5. Single `reflect` call surfaces contradictions on demand

---

## What Was Identified But NOT Yet Designed

The user asked for **2-3 proactive agents** that elevate the system beyond reactive recall/reflect. The previous conversation identified the need but stopped before designing the optimal agent strategy. Key requirements:

1. **Ruthlessly data-driven** — no ego, no assumptions, only evidence
2. **Self-optimizing** — the system should improve its own improvement process
3. **Pattern discovery** — agents that find insights humans wouldn't think to query for
4. **Enterprise-grade** — reliable, not over-engineered, minimal operational surface

### Design constraints for the next conversation:
- Must leverage Hindsight's existing capabilities (reflect, recall with structured output, observation consolidation, mental models)
- Must NOT over-engineer (the previous attempt proposed 10 agents; user rejected that)
- Must justify each agent with a concrete value hypothesis
- Agents should produce actionable output, not noise
- Consider: what can a scheduled `reflect` + structured `response_schema` accomplish that a human query cannot?

---

## Hindsight Capabilities Reference (Key APIs)

### Retain
- Ingests raw content, extracts facts/entities/relationships automatically
- `tags` for scoping, `document_id` for upsert, `context` shapes extraction
- Entity labels with `tag: true` write classification as SQL-filterable tags
- Observation consolidation runs automatically in background after retain

### Recall
- 4 parallel strategies: semantic, BM25, graph traversal, temporal
- RRF fusion + cross-encoder reranking
- `tags` / `tags_match` for hard SQL filtering (any, all, any_strict, all_strict)
- `budget` (low/mid/high) controls search depth
- `max_tokens` controls response size
- `types` filter: world, experience, observation

### Reflect
- Agentic reasoning loop: searches memory autonomously, synthesizes answer
- Disposition traits shape reasoning style
- `response_schema` for structured programmatic output
- `include_facts=True` for audit trails
- Directives enforced during reflect (hard rules)
- Mental models returned instantly when relevant

### Observations
- Auto-consolidated from multiple facts
- Evidence-grounded with source references
- Freshness trends: stable, strengthening, weakening, new, stale
- Refined (not overwritten) when contradicted
- Per-tag scopes create isolated observation streams

### Mental Models
- Pre-computed reflect responses for common queries
- Return instantly, zero token cost at query time
- Auto-refresh when observations consolidate (`trigger={"refresh_after_consolidation": True}`)

### Directives
- Hard rules enforced during reflect
- Agent MUST comply — responses rejected if violated
- Can be enabled/disabled without deletion

---

## Hindsight Documentation Location

Full docs at: `/Users/steve/.claude/skills/hindsight-docs/references/`
- `best-practices.md` — START HERE for integration patterns
- `developer/api/retain.md` — Retain API reference
- `developer/api/recall.md` — Recall API with tag filtering details
- `developer/api/reflect.md` — Reflect with response_schema
- `developer/api/memory-banks.md` — Bank config, entity labels, directives
- `developer/observations.md` — How consolidation works
- `developer/retrieval.md` — TEMPR retrieval architecture
- `developer/retain.md` — Retain architecture (fact extraction)
- `developer/configuration.md` — Full env var reference

Invoke via skill: `/hindsight-docs`

---

## Integration with Existing Systems

### Swarmclaw (claude-mem) Native Memory
- Swarmclaw captures session observations (what happened, when, context)
- Hindsight ingests those observations via retain, extracting structured knowledge
- Swarmclaw = operational/session memory (what happened)
- Hindsight = strategic/structural memory (what it means, how it connects)
- Bridge: post-session retain pipeline, pre-session recall injection

### QDS-Factory Sprint Artifacts
- Sprint stories at `_bmad-output/phase-0/stories/` and `_bmad-output/phase-1/stories/`
- Sprint handoffs at `_bmad-output/sprint-artifacts/`
- These documents ARE the charter content for `qds-product` bank

### Claude Code Hooks
- Post-session: trigger retain into both banks
- Pre-session: trigger recall from both banks, inject as context
- CronCreate: weekly drift detection reflect

---

## Files to Read in Next Conversation

1. This handoff document
2. `/Users/steve/.claude/skills/hindsight-docs/references/best-practices.md` — for grounding
3. `/Users/steve/.claude/skills/hindsight-docs/references/developer/api/reflect.md` — for `response_schema` patterns
4. `/Users/steve/.claude/skills/hindsight-docs/references/developer/observations.md` — for consolidation mechanics
5. Current QDS-Factory story specs (to understand what "charter" content looks like)

---

## User's Design Philosophy (Capture for Continuity)

- "No ego" — the system should have no opinions, only evidence
- "Ruthlessly self-optimizing" — every component must justify its existence with data
- "Power and effectiveness" — maximize insight per token spent
- Suspicious of over-engineering — rejected 6-layer / 10-agent proposal as over-built
- Values elegance and minimalism in architecture
- Wants proactive intelligence, not just reactive recall
- The factory must improve itself, not just the code it produces
