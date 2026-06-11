# QDS-Factory Hindsight Memory System — Master Design & Decision Document

**Document ID**: QDS-MEM-001
**Status**: Approved design, implementation-ready
**Created**: 2026-06-10
**Supersedes**: `hindsight-memory-architecture-handoff.md` (same date)
**Authority**: Architecture decision record for all Hindsight memory integration in QDS-Factory

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Design Principles & Decision Record](#2-design-principles--decision-record)
3. [Bank Architecture](#3-bank-architecture)
4. [Proactive Agent Fleet](#4-proactive-agent-fleet)
5. [The Compounding Loop](#5-the-compounding-loop)
6. [Implementation Reference](#6-implementation-reference)
7. [Operational Surface & Cost](#7-operational-surface--cost)
8. [Alternatives Considered & Rejected](#8-alternatives-considered--rejected)
9. [Implementation Sequence](#9-implementation-sequence)
10. [Success Criteria](#10-success-criteria)

---

## 1. Executive Summary

QDS-Factory operates a two-bank Hindsight memory system that makes the factory self-improving — both the code it produces and the factory process itself.

**Bank 1 (`qds-product`)**: Architectural decisions, bug patterns, charter principles, and proven approaches for the product. Entity labels partition knowledge by module, type, and severity via hard SQL filtering.

**Bank 2 (`qds-meta`)**: Skill execution outcomes, prompt effectiveness, review catch rates, and factory workflow patterns. Entity labels partition by skill, outcome, and quality dimension.

**Four proactive agents** elevate the system from reactive (recall/reflect on demand) to proactive (the system discovers insights without being asked):

| Agent | Function | Schedule | Orthogonal Question |
|-------|----------|----------|---------------------|
| **Synthesizer** | Cross-bank pattern mining + drift surveillance | Weekly | "What correlations exist across banks that no human would think to query for?" |
| **Meta-Optimizer** | Self-improvement feedback loop | Biweekly | "Is our improvement process itself improving?" |
| **Blind Spot Detector** | Completeness audit via absence detection | Monthly | "What should we know but don't?" |
| **Review Harvester** | External review mining (CodeRabbit, Gemini Code Assist) | Every 3 days | "What do external reviewers consistently catch that our coding agents consistently miss?" |

These four questions are orthogonal — no agent can answer another's question. The first three analyze data already inside the system; the Review Harvester is the only agent that ingests external ground truth, providing the independent calibration that makes the Meta-Optimizer's trajectory analysis trustworthy. Each agent retains its findings back into the banks, creating a compounding improvement loop where the system's own outputs become inputs for future runs.

The system's built-in mechanisms handle everything else: directives enforce charter compliance during reflect, observation consolidation tracks drift passively via freshness trends, and mental models provide zero-cost instant retrieval for repeated queries.

---

## 2. Design Principles & Decision Record

### 2.1 Guiding Principles

| # | Principle | Implication |
|---|-----------|-------------|
| P1 | **No ego, only evidence** | Every finding requires source references. `data_sufficiency` fields force honesty about sparse data. No speculation without evidence. |
| P2 | **Maximum power per agent** | Each agent must address a function that no other agent can fulfill. Overlap is waste. |
| P3 | **Compounding, not accumulating** | Data that sits unused is noise. Every agent output must be retained as future input for another run. |
| P4 | **Minimal operational surface** | 4 CronCreate entries, 4 schedules, ~27 reflect calls/month total. No monitoring infrastructure. The Review Harvester adds gh CLI calls but no additional state management. |
| P5 | **Self-optimizing** | The Meta-Optimizer evaluates its own past recommendations. The system improves its own improvement process. |
| P6 | **Proactive, not reactive** | Agents discover insights that no human would think to query for. Reactive reflect/recall handles everything else. |

### 2.2 Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Number of banks | 2 (not 1, not 3+) | Product knowledge and process knowledge have fundamentally different retention policies, disposition profiles, and query patterns. Two is the minimum that preserves this separation. A single bank would force compromise on disposition tuning (skepticism=4 for product vs skepticism=5 for meta). |
| Number of proactive agents | 4 (not 3, not 10) | Four orthogonal questions exhaust the proactive intelligence surface: cross-domain discovery, self-referential feedback, absence detection, and external review mining. The Review Harvester is unique in ingesting external ground truth — the other three agents analyze internal data only. Without it, the Meta-Optimizer relies on self-reported outcomes with no independent calibration. A 10-agent fleet was rejected as over-engineered. 3 agents leave external calibration uncovered. |
| Drift detection | Passive (built-in) + Synthesizer surveillance | Observation freshness trends (stable → weakening) are the passive drift signal. No dedicated drift agent — the Synthesizer absorbs drift surveillance into its weekly cross-bank run. |
| Charter compliance | Directives (enforced at reflect layer) | Directives are the right tool for non-negotiable rules. They're enforced during every reflect call, not via cron. No charter-scanning agent. |
| Agent output destination | Retained back into banks | Agent findings are retained with appropriate tags, making them available to future reflect/recall calls. This is the compounding mechanism. |
| Cross-bank queries | Client-side orchestration | Hindsight does not support multi-bank queries in a single call. The Synthesizer runs separate reflect calls on each bank, then a synthesis step correlates results. |
| Observation scopes | `per_tag` on both banks | Each tag combination gets its own observation stream. This produces module-scoped observations in qds-product and skill-scoped observations in qds-meta. |

---

## 3. Bank Architecture

### 3.1 Bank 1: `qds-product` — The Code We're Building

**Purpose**: Every architectural decision, bug pattern, charter principle, proven approach, and current state for the product.

#### Configuration

```yaml
bank_id: qds-product
disposition_skepticism: 4        # No rationalizing violations
disposition_literalism: 4        # Strict reading of specs
disposition_empathy: 1           # Clinical, neutral tone
retain_extraction_mode: verbose  # Rich fact extraction
observation_scopes: per_tag      # Separate observations per module/type
```

#### Missions

```yaml
retain_mission: >
  Extract technical decisions, API design choices, architectural trade-offs,
  bug patterns, antipatterns discovered during review, charter principles,
  module boundaries, and security invariants. Ignore greetings, scheduling
  logistics, and implementation details that don't represent decisions.

observations_mission: >
  Identify durable architectural patterns, recurring bug classes per module,
  evolving design decisions, and contradictions with charter principles.
  Focus on cross-module patterns and severity-weighted risk accumulation.
  Flag when recent implementations contradict established patterns.

reflect_mission: >
  You are a senior architect with full context of the product's design history.
  Reference past decisions, known antipatterns, and charter constraints.
  Be direct. Flag violations. Prioritize severity-based reasoning.
```

#### Entity Labels (Tag Schema)

| Label | Type | Tag | Values | Purpose |
|-------|------|-----|--------|---------|
| `knowledge_type` | `value` | `true` | `charter`, `decision`, `pattern`, `antipattern`, `state` | Hard SQL filtering at recall |
| `module` | `value` | `true` | `harness`, `coms`, `auth`, `memory`, `cli`, `infra`, `factory` | Module-scoped queries |
| `severity` | `value` | `true` | `critical`, `high`, `medium`, `low` | Priority-aware retrieval |

#### Directives

Directives encode non-negotiable PRD rules. Enforced during every reflect call on this bank. Examples (to be populated from sprint specs during implementation):

```
- "No process may use NODE_TLS_REJECT_UNAUTHORIZED=0 globally; use per-request https.Agent for localhost-only bypass."
- "All file reads in the harness must use O_NOFOLLOW to prevent TOCTOU symlink races."
- "Content size limits must use Buffer.byteLength, not v.length, for UTF-8 accuracy."
```

Directives are populated from security invariants and architectural constraints extracted from `_bmad-output/` sprint artifacts during initial bank seeding.

#### Mental Models

One per module, auto-refreshing on consolidation:

| Model Name | Source Query | Tags |
|------------|--------------|------|
| `harness-architecture` | "Summarize the harness module's design, constraints, and known issues" | `module:harness` |
| `coms-architecture` | "Summarize the coms module's design, constraints, and known issues" | `module:coms` |
| `auth-architecture` | "Summarize the auth module's design, constraints, and known issues" | `module:auth` |
| `memory-architecture` | "Summarize the memory module's design, constraints, and known issues" | `module:memory` |
| `cli-architecture` | "Summarize the CLI module's design, constraints, and known issues" | `module:cli` |
| `infra-architecture` | "Summarize the infra module's design, constraints, and known issues" | `module:infra` |

Configuration: `trigger={"refresh_after_consolidation": True}` on each model.

#### Operational Surface

| Hook | Action |
|------|--------|
| Pre-session | `recall(tags=["knowledge_type:charter"], tags_match="all_strict")` + `recall(tags=["knowledge_type:antipattern"], tags_match="all_strict")` |
| Post-session | `retain(session_summary, tags=[module:X, knowledge_type:Y, severity:Z])` |
| Drift check | Absorbed into weekly Synthesizer run |

---

### 3.2 Bank 2: `qds-meta` — The Factory Improving Itself

**Purpose**: Skill execution outcomes, prompt effectiveness, review catch rates, workflow patterns, and intervention effectiveness data.

#### Configuration

```yaml
bank_id: qds-meta
disposition_skepticism: 5        # Question everything in meta-analysis
disposition_literalism: 3        # Balanced interpretation for pattern detection
disposition_empathy: 1           # Clinical, evidence-only
retain_extraction_mode: verbose
observation_scopes: per_tag      # Separate observations per skill/outcome
```

#### Missions

```yaml
retain_mission: >
  Extract skill execution outcomes, prompt effectiveness metrics, review
  catch rates (true positives, false positives, misses), time-to-completion,
  quality dimension scores, and intervention results. Ignore conversational
  pleasantries and scheduling logistics.

observations_mission: >
  Identify skill effectiveness trends, persistent failure modes across
  intervention attempts, prompt patterns that produce better outcomes,
  and quality dimensions that consistently score lowest. Flag when
  interventions fail to produce measurable improvement after repeated attempts.

reflect_mission: >
  You are a process engineer with full visibility into factory outcomes.
  Evaluate skill effectiveness ruthlessly. Track intervention effectiveness
  over time. Never assume an intervention worked without outcome evidence.
  Be direct about what isn't improving.
```

#### Entity Labels (Tag Schema)

| Label | Type | Tag | Values | Purpose |
|-------|------|-----|--------|---------|
| `skill` | `value` | `true` | `bmad-dev-story`, `bmad-review-adversarial`, `qds-story-review`, `synthesizer`, `meta-optimizer`, `blind-spot-detector`, etc. | Per-skill analysis |
| `outcome` | `value` | `true` | `success`, `partial`, `failure`, `false_positive`, `missed`, `insight`, `gap` | Outcome-filtered retrieval |
| `quality_dim` | `multi-values` | `true` | `correctness`, `security`, `performance`, `testability`, `maintainability` | Multi-value quality scoring |

#### Directives

```
- "Never claim an intervention improved outcomes without citing specific before/after evidence from this bank."
- "If data is insufficient to support a trend claim, the data_sufficiency field must reflect that honestly."
- "No agent may recommend changes to the factory process without evidence from at least 3 distinct observations."
```

#### Mental Models

| Model Name | Source Query | Tags |
|------------|--------------|------|
| `skill-effectiveness` | "Which skills are most and least effective, and what distinguishes their outcomes?" | *(none — global)* |
| `quality-dimensions` | "Which quality dimensions are strongest and weakest across all skills?" | *(none — global)* |

Configuration: `trigger={"refresh_after_consolidation": True}` on each model.

#### Operational Surface

| Hook | Action |
|------|--------|
| Post-skill-execution | `retain(skill_result, tags=[skill:X, outcome:Y, quality_dim:Z])` |
| Pre-skill-execution | `reflect("What should I know about this skill's strengths and pitfalls?", tags=[skill:X], response_schema=SKILL_PREP_SCHEMA)` |
| Post-proactive-agent | `retain(agent_findings, tags=[skill:synthesizer|meta-optimizer|blind-spot-detector, outcome:insight|gap])` |

**Pre-skill preparation schema** (`SKILL_PREP_SCHEMA`):

```json
{
  "type": "object",
  "properties": {
    "skill_strengths": {
      "type": "array",
      "items": {"type": "string"},
      "description": "What this skill does well based on past observations"
    },
    "known_pitfalls": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "pitfall": {"type": "string"},
          "mitigation": {"type": "string"}
        },
        "required": ["pitfall", "mitigation"]
      },
      "description": "Recurring issues and how to avoid them"
    },
    "quality_dimension_focus": {
      "type": "array",
      "items": {"type": "string"},
      "description": "Quality dimensions to watch during this skill execution"
    },
    "recommended_prep_actions": {
      "type": "array",
      "items": {"type": "string"},
      "description": "Specific actions to take before running the skill"
    },
    "confidence": {
      "type": "number",
      "minimum": 0,
      "maximum": 1,
      "description": "How confident the reflect is in this preparation advice, based on available data"
    }
  },
  "required": ["skill_strengths", "known_pitfalls", "confidence"]
}
```

---

## 4. Proactive Agent Fleet

### 4.1 Agent Design Philosophy

Each agent is a **scheduled CronCreate entry** that executes a sequence of API calls (Hindsight API + external data sources where specified), produces structured output via `response_schema`, and retains findings back into the banks. The agents are stateless — all state lives in Hindsight's observation layer. This means:

- No external state management
- No databases to maintain
- No coordination protocols between agents
- Failure recovery is automatic (next scheduled run picks up from observation state)
- Observability is built in (every finding has `include_facts=True` audit trails)

### 4.2 Agent 1: The Synthesizer — Cross-Bank Pattern Mining + Drift Surveillance

#### Identity

| Field | Value |
|-------|-------|
| **Agent name** | `synthesizer` |
| **Schedule** | Weekly — Monday 07:23 local (`23 7 * * 1`) |
| **Banks touched** | Both (`qds-product`, `qds-meta`) |
| **Budget** | `high` |
| **Reflect calls per run** | 3 (product + meta + synthesis) |
| **Estimated tokens/run** | 15,000–20,000 |

#### Value Hypothesis

A high-budget reflect across both banks discovers **cross-domain correlations** that are invisible to single-bank queries and that no human would construct as an explicit question. The canonical insight pattern is: "Skill X consistently misses bug class Y in module Z" — a correlation that requires simultaneously reasoning about factory process (qds-meta) and product structure (qds-product).

The same run absorbs **drift surveillance** by analyzing observation freshness trends. Observations with `freshness_trend: weakening` or `stale` on critical/high severity knowledge are surfaced as drift signals. This eliminates the need for a separate drift-detection agent.

Without this agent, cross-bank insights exist only in the heads of people who happen to think about both domains simultaneously. With it, the system discovers them automatically.

#### Execution Sequence

```
Step 1: reflect on qds-product → structured product analysis
Step 2: reflect on qds-meta → structured meta analysis
Step 3: client-side synthesis → cross-bank correlation + drift signals
Step 4: retain findings into both banks
```

#### Step 1: Product Analysis

```python
response_product = client.reflect(
    bank_id="qds-product",
    query="""Analyze the product knowledge base for actionable intelligence.

CLUSTER ANALYSIS: Which modules have disproportionate concentrations of
antipatterns vs patterns? Which severity levels cluster around which modules?

DRIFT ANALYSIS: Which observations tagged severity:critical or severity:high
show freshness_trend weakening or stale? What charter principles or decisions
are at risk of becoming outdated?

CONTRADICTION ANALYSIS: Where do recent decisions conflict with charter
principles or previously established patterns?

Return only evidence-grounded findings with specific module and knowledge_type
references. If data is insufficient for any analysis, state so explicitly.""",
    budget="high",
    tags=["knowledge_type:antipattern", "knowledge_type:decision",
          "knowledge_type:charter", "knowledge_type:state"],
    tags_match="any",
    response_schema=SYNTHESIZER_PRODUCT_SCHEMA,
    include_facts=True,
)
```

**Product schema** (`SYNTHESIZER_PRODUCT_SCHEMA`):

```json
{
  "type": "object",
  "properties": {
    "cluster_analysis": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "module": {"type": "string"},
          "antipattern_count_observations": {"type": "integer"},
          "pattern_count_observations": {"type": "integer"},
          "dominant_severity": {"type": "string"},
          "key_concern": {"type": "string"}
        },
        "required": ["module", "antipattern_count_observations", "pattern_count_observations", "key_concern"]
      },
      "maxItems": 6
    },
    "drift_signals": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "observation_summary": {"type": "string"},
          "freshness_trend": {"type": "string", "enum": ["weakening", "stale"]},
          "knowledge_type": {"type": "string"},
          "severity": {"type": "string"},
          "module": {"type": "string"},
          "last_reinforced_approx": {"type": "string"},
          "risk_if_unaddressed": {"type": "string"}
        },
        "required": ["observation_summary", "freshness_trend", "severity", "module", "knowledge_type", "risk_if_unaddressed"]
      },
      "maxItems": 5
    },
    "contradictions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "charter_principle": {"type": "string"},
          "conflicting_decision": {"type": "string"},
          "evidence": {"type": "string"},
          "resolution_needed": {"type": "boolean"}
        },
        "required": ["charter_principle", "conflicting_decision", "evidence"]
      },
      "maxItems": 3
    },
    "data_sufficiency": {"type": "string", "enum": ["sufficient", "marginal", "insufficient"]}
  },
  "required": ["cluster_analysis", "drift_signals", "contradictions", "data_sufficiency"]
}
```

#### Step 2: Meta Analysis

```python
response_meta = client.reflect(
    bank_id="qds-meta",
    query="""Analyze the factory process knowledge for actionable intelligence.

SKILL BLIND SPOTS: Which skills have the highest failure, missed, or
false_positive rates? Which quality dimensions do they fail on most?

OUTCOME TRENDS: Are any skills showing declining success rates in recent
observations compared to earlier observations?

PROCESS GAPS: Which skills have insufficient outcome data for meaningful
analysis (fewer than 3 observations)?

Return only evidence-grounded findings. Cite specific observation counts.""",
    budget="high",
    tags=["outcome:failure", "outcome:missed", "outcome:partial",
          "outcome:false_positive", "outcome:success"],
    tags_match="any",
    response_schema=SYNTHESIZER_META_SCHEMA,
    include_facts=True,
)
```

**Meta schema** (`SYNTHESIZER_META_SCHEMA`):

```json
{
  "type": "object",
  "properties": {
    "skill_analysis": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "skill": {"type": "string"},
          "success_rate_estimate": {"type": "number", "minimum": 0, "maximum": 1},
          "weak_quality_dims": {"type": "array", "items": {"type": "string"}},
          "trend": {"type": "string", "enum": ["improving", "stable", "declining", "insufficient_data"]},
          "observation_count": {"type": "integer"}
        },
        "required": ["skill", "success_rate_estimate", "observation_count", "trend"]
      }
    },
    "process_gaps": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "skill": {"type": "string"},
          "available_observations": {"type": "integer"},
          "minimum_for_analysis": {"type": "integer", "const": 3},
          "status": {"type": "string", "enum": ["insufficient", "marginal", "adequate"]}
        },
        "required": ["skill", "available_observations", "status"]
      }
    },
    "data_sufficiency": {"type": "string", "enum": ["sufficient", "marginal", "insufficient"]}
  },
  "required": ["skill_analysis", "process_gaps", "data_sufficiency"]
}
```

#### Step 3: Cross-Bank Synthesis

The structured outputs from Steps 1 and 2 are correlated client-side. This synthesis step identifies cross-bank correlations using a final reflect call on `qds-meta` (where synthesis outputs are retained):

```python
synthesis = client.reflect(
    bank_id="qds-meta",
    query=f"""SYNTHESIS TASK: Correlate these two analyses to find cross-bank insights.

PRODUCT ANALYSIS SUMMARY:
{json.dumps(response_product.structured_output, indent=2)}

META ANALYSIS SUMMARY:
{json.dumps(response_meta.structured_output, indent=2)}

Find connections between:
- Modules with high antipattern counts AND skills that frequently miss findings
- Drift signals in product knowledge AND skills with declining success rates
- Process gaps AND modules with sparse coverage

Each insight must cite specific evidence from BOTH analyses.
If no meaningful cross-bank correlations exist, say so — do not fabricate connections.""",
    budget="high",
    response_schema=SYNTHESIS_SCHEMA,
    include_facts=True,
)
```

**Synthesis schema** (`SYNTHESIS_SCHEMA`):

```json
{
  "type": "object",
  "properties": {
    "cross_bank_insights": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "insight": {
            "type": "string",
            "description": "The cross-bank correlation discovered"
          },
          "product_evidence": {
            "type": "string",
            "description": "Specific finding from qds-product that supports this"
          },
          "meta_evidence": {
            "type": "string",
            "description": "Specific finding from qds-meta that supports this"
          },
          "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
          "actionable_recommendation": {
            "type": "string",
            "description": "What should change as a result of this insight"
          }
        },
        "required": ["insight", "product_evidence", "meta_evidence",
                     "confidence", "actionable_recommendation"]
      },
      "maxItems": 5
    },
    "elevated_drift_signals": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "drift_description": {"type": "string"},
          "severity": {"type": "string"},
          "weeks_flagged": {"type": "integer",
            "description": "How many consecutive Synthesizer runs have flagged this"
          },
          "action_required": {"type": "boolean"}
        },
        "required": ["drift_description", "severity", "weeks_flagged", "action_required"]
      },
      "maxItems": 3
    },
    "no_meaningful_correlations": {
      "type": "boolean",
      "description": "True when analysis ran but no cross-bank insights emerged"
    },
    "synthesis_confidence": {"type": "number", "minimum": 0, "maximum": 1},
    "data_sufficiency": {"type": "string", "enum": ["sufficient", "marginal", "insufficient"]}
  },
  "required": ["cross_bank_insights", "elevated_drift_signals",
               "synthesis_confidence", "data_sufficiency"]
}
```

#### Step 4: Feedback Retention

```python
# Retain synthesis output into both banks
client.retain(
    bank_id="qds-meta",
    items=[{
        "content": json.dumps(synthesis.structured_output),
        "tags": ["skill:synthesizer", "outcome:insight"],
        "document_id": f"synthesizer-{run_date}",
        "context": "Weekly cross-bank synthesis from the Synthesizer proactive agent"
    }]
)

client.retain(
    bank_id="qds-product",
    items=[{
        "content": json.dumps({
            "drift_signals": synthesis.structured_output.get("elevated_drift_signals", []),
            "cross_bank_insights": [
                i["insight"] for i in synthesis.structured_output.get("cross_bank_insights", [])
            ]
        }),
        "tags": ["knowledge_type:state", "module:factory"],
        "document_id": f"synthesizer-drift-{run_date}",
        "context": "Weekly drift surveillance output from the Synthesizer proactive agent"
    }]
)
```

This retention ensures next week's Synthesizer run can observe:
- Prior drift signals that remain unaddressed (escalating `weeks_flagged`)
- Whether cross-bank insights led to interventions (visible in qds-meta outcomes)
- The trendline of synthesis confidence over time

---

### 4.3 Agent 2: The Meta-Optimizer — Self-Improvement Feedback Loop

#### Identity

| Field | Value |
|-------|-------|
| **Agent name** | `meta-optimizer` |
| **Schedule** | Biweekly — 1st and 15th at 07:25 local (`25 7 1,15 * *`) |
| **Banks touched** | `qds-meta` only |
| **Budget** | `high` |
| **Reflect calls per run** | 1 |
| **Estimated tokens/run** | 10,000–15,000 |

#### Value Hypothesis

Without this agent, qds-meta is a **museum** of outcomes — data that accumulates but never feeds back into process improvement. With it, qds-meta becomes a **feedback mechanism** that evaluates whether improvement efforts are producing measurable results.

The Meta-Optimizer is the only agent that closes the self-improvement loop. It evaluates its own past recommendations, tracks intervention effectiveness, and identifies persistent failure modes that resist repeated interventions. Over time, it builds a "what works for this factory" knowledge base that is unique to QDS-Factory's specific skills, team, and process.

The self-referential nature is key: the Meta-Optimizer's own findings are retained in qds-meta, so future runs can evaluate whether the optimizer's recommendations were accurate. This creates genuine meta-learning — the system doesn't just improve, it improves its ability to improve.

#### Execution Sequence

```
Step 1: reflect on qds-meta → structured improvement trajectory
Step 2: retain findings into qds-meta
```

#### Step 1: Improvement Trajectory Analysis

```python
response = client.reflect(
    bank_id="qds-meta",
    query="""Evaluate the factory's improvement trajectory using ALL available
outcome data and past proactive agent insights in this bank.

TRAJECTORY: Compare skill outcomes from the most recent quarter vs the quarter
before. Are success rates improving, stable, or degrading per skill? Is the
rate of improvement accelerating, linear, or decelerating?

PERSISTENT FAILURES: Which failure modes have recurred across multiple
intervention attempts? List each failure mode with: how many times it has
recurred, what interventions were attempted, and which (if any) were effective.

INTERVENTION EFFECTIVENESS: Look at past synthesizer and meta-optimizer
insights retained in this bank. Which recommendations were acted on? Of those,
which produced measurable improvement in subsequent skill outcomes? Which
produced no detectable change?

OPTIMIZATION: What is the single highest-leverage change to the factory
process right now? Rank by expected impact × confidence / effort.

RULES:
- Be ruthlessly evidence-based. If data is insufficient to support a claim,
  say so. Do not confabulate trends from sparse data.
- Cite specific observation counts for every claim.
- If fewer than 10 total observations exist in this bank, state that the
  system is in early calibration and defer all trend claims.
- For any persistent_failure_modes entry that includes interventions_attempted,
  you must also include interventions_effective (at minimum an empty array).
  Listing what was tried without what worked produces unusable data.
- For any intervention_effectiveness entry where implemented is true, the
  evidence field must be present and non-empty. Without evidence, improvement
  claims are unverifiable.""",
    budget="high",
    tags=["skill:synthesizer", "skill:meta-optimizer",
          "outcome:success", "outcome:failure", "outcome:missed",
          "outcome:insight", "outcome:gap"],
    tags_match="any",
    response_schema=META_OPTIMIZER_SCHEMA,
    include_facts=True,
)
```

**Response schema** (`META_OPTIMIZER_SCHEMA`):

```json
{
  "type": "object",
  "properties": {
    "system_maturity": {
      "type": "string",
      "enum": ["early_calibration", "emerging_patterns", "sufficient_data"],
      "description": "Whether enough data exists for meaningful trajectory analysis"
    },
    "improvement_trajectory": {
      "type": "object",
      "properties": {
        "direction": {
          "type": "string",
          "enum": ["improving", "stable", "degrading", "indeterminate"]
        },
        "rate": {
          "type": "string",
          "enum": ["accelerating", "linear", "decelerating", "flat"]
        },
        "evidence_summary": {"type": "string"},
        "skills_improving": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "skill": {"type": "string"},
              "evidence": {"type": "string"}
            }
          }
        },
        "skills_degrading": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "skill": {"type": "string"},
              "evidence": {"type": "string"}
            }
          }
        }
      },
      "required": ["direction", "rate", "evidence_summary"]
    },
    "persistent_failure_modes": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "failure_mode": {"type": "string"},
          "recurrence_count": {"type": "integer"},
          "first_seen_approx": {"type": "string"},
          "last_seen_approx": {"type": "string"},
          "interventions_attempted": {
            "type": "array",
            "items": {"type": "string"}
          },
          "interventions_effective": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Required when interventions_attempted is non-empty. List which interventions produced measurable improvement. Empty array if none were effective."
          },
          "root_cause_hypothesis": {"type": "string"},
          "recommended_next_intervention": {"type": "string"}
        },
        "required": ["failure_mode", "recurrence_count",
                     "interventions_attempted", "interventions_effective"]
      },
      "maxItems": 5
    },
    "intervention_effectiveness": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "intervention": {"type": "string"},
          "source": {"type": "string",
            "description": "Which agent recommended this, and when"
          },
          "implemented": {"type": "boolean"},
          "measurable_improvement": {"type": "boolean"},
          "evidence": {"type": "string",
            "description": "Required when implemented is true. Cite specific before/after observations demonstrating whether the intervention worked."}
        },
        "required": ["intervention", "implemented", "measurable_improvement"]
      },
      "maxItems": 5
    },
    "top_recommendation": {
      "type": "object",
      "properties": {
        "recommendation": {"type": "string"},
        "evidence_basis": {"type": "string"},
        "expected_impact": {"type": "string", "enum": ["high", "medium", "low"]},
        "effort": {"type": "string", "enum": ["high", "medium", "low"]},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1}
      },
      "required": ["recommendation", "evidence_basis",
                   "expected_impact", "effort", "confidence"]
    },
    "meta_confidence": {
      "type": "number",
      "minimum": 0,
      "maximum": 1,
      "description": "Confidence in this entire analysis (low when data is sparse)"
    },
    "data_sufficiency_note": {"type": "string"}
  },
  "required": ["system_maturity", "improvement_trajectory",
               "persistent_failure_modes", "top_recommendation",
               "meta_confidence"]
}
```

#### Step 2: Feedback Retention

```python
client.retain(
    bank_id="qds-meta",
    items=[{
        "content": json.dumps(response.structured_output),
        "tags": ["skill:meta-optimizer", "outcome:insight"],
        "document_id": f"meta-optimizer-{run_date}",
        "context": "Biweekly self-improvement trajectory analysis from the Meta-Optimizer proactive agent"
    }]
)
```

**Self-referential compounding**: The next Meta-Optimizer run can see this run's `top_recommendation` in `intervention_effectiveness`. If the recommendation was implemented, the next run evaluates whether it worked. If it wasn't, the next run may re-recommend or escalate. This is the feedback loop that makes the system self-optimizing.

---

### 4.4 Agent 3: The Blind Spot Detector — Completeness Audit via Absence Detection

#### Identity

| Field | Value |
|-------|-------|
| **Agent name** | `blind-spot-detector` |
| **Schedule** | Monthly — 1st at 07:27 local (`27 7 1 * *`) |
| **Banks touched** | Both (`qds-product`, `qds-meta`) |
| **Budget** | `mid` (analytical, not deep retrieval) |
| **Reflect calls per run** | 2 (product + meta) |
| **Estimated tokens/run** | 8,000–10,000 |

#### Value Hypothesis

Recall and reflect can only find what EXISTS in the banks. This agent finds what DOESN'T exist but should. This is the only agent that performs **absence detection**, which is a fundamentally different operation from retrieval.

Real-world examples of absence signals:
- A module with zero antipatterns isn't well-designed — it's **unaudited**
- A skill with 100% success rate isn't flawless — it's **under-observed**
- A quality dimension with no data for a skill means that dimension **wasn't measured**
- A module with decisions but no patterns means decisions were made but **never validated**

These signals are invisible to every retrieval mechanism because you cannot recall what was never retained. The Blind Spot Detector is the only countermeasure.

#### Execution Sequence

```
Step 1: reflect on qds-product → coverage gap analysis
Step 2: reflect on qds-meta → skill coverage gap analysis
Step 3: retain findings into qds-meta
```

#### Step 1: Product Coverage Analysis

```python
response_product = client.reflect(
    bank_id="qds-product",
    query="""Analyze the COMPLETENESS of this product knowledge base by detecting
what SHOULD exist but doesn't.

EXPECTED COVERAGE:
- 6 modules: harness, coms, auth, memory, cli, infra
- 5 knowledge types per module: charter, decision, pattern, antipattern, state
- 4 severity levels: critical, high, medium, low

DETECTION TASKS:
1. Which modules have NO antipatterns? (Suspicious — likely unaudited)
2. Which modules have NO patterns? (No proven approaches documented)
3. Which modules have NO decisions? (No architectural record)
4. Which modules have NO charter principles? (No constraints defined)
5. Are any severity levels missing for modules that have other observations?
6. Which modules have the fewest total observations? (Least knowledge)

For each gap, assess whether it represents a genuine knowledge deficit or
a legitimate absence (e.g., a simple module may not need critical-severity
antipatterns). Be conservative — only flag gaps that are suspicious
given the module's complexity and scope.""",
    budget="mid",
    types=["observation"],
    response_schema=BLIND_SPOT_PRODUCT_SCHEMA,
    include_facts=True,
)
```

**Product schema** (`BLIND_SPOT_PRODUCT_SCHEMA`):

```json
{
  "type": "object",
  "properties": {
    "coverage_gaps": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "gap_description": {"type": "string"},
          "module": {"type": "string"},
          "missing_knowledge_type": {"type": "string"},
          "expected": {"type": "string",
            "description": "Why we'd expect this knowledge to exist"
          },
          "actual": {"type": "string",
            "description": "What was found instead (usually 'no observations')"
          },
          "risk": {"type": "string", "enum": ["high", "medium", "low"]},
          "recommended_action": {"type": "string"}
        },
        "required": ["gap_description", "module", "missing_knowledge_type",
                     "expected", "actual", "risk", "recommended_action"]
      },
      "maxItems": 10
    },
    "suspicious_absences": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "module": {"type": "string"},
          "reason_for_suspicion": {"type": "string"},
          "inference": {"type": "string",
            "description": "What the absence suggests about the module's review coverage"
          }
        },
        "required": ["module", "reason_for_suspicion", "inference"]
      },
      "maxItems": 5
    },
    "completeness_score": {
      "type": "number",
      "minimum": 0,
      "maximum": 1,
      "description": "Fraction of expected module×knowledge_type cells that have observations"
    },
    "data_sufficiency": {"type": "string", "enum": ["sufficient", "marginal", "insufficient"]}
  },
  "required": ["coverage_gaps", "suspicious_absences",
               "completeness_score", "data_sufficiency"]
}
```

#### Step 2: Meta Coverage Analysis

```python
response_meta = client.reflect(
    bank_id="qds-meta",
    query="""Analyze the COMPLETENESS of factory process knowledge by detecting
what SHOULD exist but doesn't.

EXPECTED COVERAGE:
- All known skills used in QDS-Factory (bmad-dev-story, bmad-review-adversarial,
  qds-story-review, synthesizer, meta-optimizer, blind-spot-detector, etc.)
- All outcome types: success, failure, partial, missed, false_positive
- All quality dimensions: correctness, security, performance, testability, maintainability

DETECTION TASKS:
1. Which skills have NO failure/missed outcomes? (Either perfect or under-observed)
2. Which quality dimensions have no data for specific skills?
3. Which skills have the fewest total observations? (Least calibrated)
4. Are there outcome types that never appear for any skill? (Unmeasured dimensions)

Be conservative. A skill with 2 successful outcomes and 0 failures might be
reliable, or might just be insufficiently exercised. Flag it as 'under-observed'
rather than 'reliable'.""",
    budget="mid",
    types=["observation"],
    response_schema=BLIND_SPOT_META_SCHEMA,
    include_facts=True,
)
```

**Meta schema** (`BLIND_SPOT_META_SCHEMA`):

```json
{
  "type": "object",
  "properties": {
    "coverage_gaps": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "gap_description": {"type": "string"},
          "skill": {"type": "string"},
          "missing_outcome_or_quality_dim": {"type": "string",
            "description": "The outcome type or quality dimension that is absent"
          },
          "expected": {"type": "string",
            "description": "Why we'd expect this data to exist"
          },
          "actual": {"type": "string",
            "description": "What was found instead (usually 'no observations')"
          },
          "risk": {"type": "string", "enum": ["high", "medium", "low"]},
          "recommended_action": {"type": "string"}
        },
        "required": ["gap_description", "skill", "missing_outcome_or_quality_dim",
                     "expected", "actual", "risk", "recommended_action"]
      },
      "maxItems": 10
    },
    "suspicious_absences": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "skill": {"type": "string"},
          "reason_for_suspicion": {"type": "string"},
          "inference": {"type": "string",
            "description": "What the absence suggests about the skill's observation coverage"
          }
        },
        "required": ["skill", "reason_for_suspicion", "inference"]
      },
      "maxItems": 5
    },
    "completeness_score": {
      "type": "number",
      "minimum": 0,
      "maximum": 1,
      "description": "Fraction of expected skill×outcome×quality_dim cells that have observations"
    },
    "data_sufficiency": {"type": "string", "enum": ["sufficient", "marginal", "insufficient"]}
  },
  "required": ["coverage_gaps", "suspicious_absences",
               "completeness_score", "data_sufficiency"]
}
```

#### Step 3: Feedback Retention

```python
# Retain gaps into qds-meta as actionable items
client.retain(
    bank_id="qds-meta",
    items=[{
        "content": json.dumps({
            "product_gaps": response_product.structured_output.get("coverage_gaps", []),
            "meta_gaps": response_meta.structured_output.get("coverage_gaps", []),
            "completeness_score": {
                "product": response_product.structured_output.get("completeness_score", 0),
                "meta": response_meta.structured_output.get("completeness_score", 0)
            }
        }),
        "tags": ["skill:blind-spot-detector", "outcome:gap"],
        "document_id": f"blind-spot-{run_date}",
        "context": "Monthly completeness audit from the Blind Spot Detector proactive agent"
    }]
)
```

Gaps retained as `outcome:gap` observations serve as action items for future sessions. When a session works on a module flagged as having no antipatterns, the pre-session recall will surface this gap, prompting the session to actively retain antipatterns it discovers.

---

### 4.5 Agent 4: The Review Harvester — External Review Mining

#### Identity

| Field | Value |
|-------|-------|
| **Agent name** | `review-harvester` |
| **Schedule** | Every 3 days at 02:17 local (`17 2 */3 * *`) |
| **Banks touched** | Both (`qds-product`, `qds-meta`) |
| **Data source** | GitHub PR review comments via `gh` CLI (CodeRabbit, Gemini Code Assist) |
| **Budget** | `mid` |
| **Reflect calls per run** | 1 (meta pattern correlation) |
| **External API calls** | `gh pr list`, `gh api pulls/{N}/comments`, `gh api pulls/{N}/reviews` |
| **Estimated tokens/run** | 8,000–12,000 |

#### Value Hypothesis

The other three proactive agents analyze data already inside the Hindsight system. The Review Harvester is the **only agent that ingests external ground truth** — what independent code reviewers (CodeRabbit, Gemini Code Assist) consistently catch that QDS-Factory coding agents consistently miss.

CodeRabbit reviews are the highest-signal data source available for factory quality:
- **Consistent**: Same reviewer, same standards, every PR — no inter-reviewer variance
- **Unbiased**: External assessment, not self-evaluation by the coding agents
- **Structured**: Severity levels, file locations, specific recommendations
- **Already happening**: No new process needed — just mining existing output

Without this agent, the Meta-Optimizer relies entirely on self-reported skill outcomes — "I ran skill X and it succeeded" — which is inherently biased. The Review Harvester provides the **external calibration** that makes the Meta-Optimizer's trajectory analysis trustworthy.

The primary success metric is brutally simple: **fewer CodeRabbit comments per PR, trending toward lower severity, with declining repeat-pattern rates**. If the factory is improving, CodeRabbit should have less to say over time.

#### Execution Sequence

```
Step 1: Fetch recent PR reviews from GitHub (gh CLI)
Step 2: Classify and structure review comments
Step 3: Reflect on qds-meta for pattern correlation + trend analysis
Step 4: Retain findings into both banks
```

#### Step 1: GitHub Review Fetching

```bash
# Fetch recently merged PRs (last 3 days)
gh pr list --state merged --limit 15 --json number,title,mergedAt \
  --jq '.[] | select(.mergedAt != null and (.mergedAt | fromdate) > (now - 259200)) | .number'

# For each PR, fetch CodeRabbit review comments (inline)
gh api repos/biospark33/QDS-Factory/pulls/{PR_NUMBER}/comments \
  --jq '.[] | select(.user.login | test("coderabbitai|gemini-code-assist")) \
  | {path, line, body, created_at, user: .user.login}'

# For each PR, fetch review-level summaries
gh api repos/biospark33/QDS-Factory/pulls/{PR_NUMBER}/reviews \
  --jq '.[] | select(.user.login | test("coderabbitai|gemini-code-assist")) \
  | {body, state, user: .user.login}'
```

#### Step 2: Classification

Raw review comments are classified into structured categories. This step runs client-side (no Hindsight API call) and produces:

```python
review_data = {
    "harvest_date": run_date,
    "prs_analyzed": [...],
    "total_comments": N,
    "by_reviewer": {
        "coderabbitai": N,
        "gemini-code-assist": N
    },
    "by_severity": {
        "critical": N,
        "high": N,
        "medium": N,
        "low": N,
        "nit": N
    },
    "by_category": {
        "security": [...comments...],
        "correctness": [...comments...],
        "performance": [...comments...],
        "maintainability": [...comments...],
        "style": [...comments...],
        "testing": [...comments...]
    },
    "recurring_patterns": [
        {
            "pattern": "Description of recurring issue",
            "occurrences": N,
            "prs": [...],
            "files": [...],
            "category": "security|correctness|...",
            "severity": "high|medium|..."
        }
    ],
    "new_issues": [...],       # Issues not seen in previous harvests
    "resolved_issues": [...]   # Issues from previous harvests not recurring
}
```

#### Step 3: Meta Pattern Correlation

```python
response = client.reflect(
    bank_id="qds-meta",
    query=f"""Analyze these external code review findings from the last 3 days
of QDS-Factory PRs in the context of ALL prior review harvest data in this bank.

REVIEW DATA:
{json.dumps(review_data, indent=2)}

TASKS:
1. RECURRING PATTERN ANALYSIS: Which issues appear across multiple PRs?
   These represent systematic coding agent weaknesses, not one-off mistakes.
   Cross-reference with prior harvests to distinguish new vs persistent patterns.

2. TREND ANALYSIS: Compare total comment count, severity distribution, and
   repeat-pattern rate against prior harvests. Is the factory improving?
   Compute comments-per-PR trend over the last 30 days.

3. ROOT CAUSE HYPOTHESIS: For each recurring pattern, hypothesize WHY coding
   agents miss it. Is it a skill gap? A missing directive in qds-product?
   An antipattern that isn't documented? A quality dimension we don't measure?

4. INTERVENTION PRIORITY: Rank recurring patterns by (frequency × severity)
   and suggest the single highest-leverage fix for each top pattern.

RULES:
- Be ruthlessly specific. "CodeRabbit flagged X in files A, B, C across PRs
  1, 2, 3" is useful. "Code quality needs improvement" is not.
- Distinguish between NEW patterns (first appearance) and PERSISTENT patterns
  (seen in multiple harvests). Persistent patterns are higher priority.
- If a pattern was previously flagged and is now absent, mark it as RESOLVED.
- Cite specific observation counts for every claim.""",
    budget="mid",
    tags=["skill:review-harvester", "outcome:insight", "outcome:missed"],
    tags_match="any",
    response_schema=REVIEW_HARVEST_SCHEMA,
    include_facts=True,
)
```

**Response schema** (`REVIEW_HARVEST_SCHEMA`):

```json
{
  "type": "object",
  "properties": {
    "harvest_summary": {
      "type": "object",
      "properties": {
        "prs_analyzed": {"type": "integer"},
        "total_comments": {"type": "integer"},
        "severity_distribution": {
          "type": "object",
          "properties": {
            "critical": {"type": "integer"},
            "high": {"type": "integer"},
            "medium": {"type": "integer"},
            "low": {"type": "integer"},
            "nit": {"type": "integer"}
          }
        },
        "comments_per_pr_avg": {"type": "number"}
      },
      "required": ["prs_analyzed", "total_comments", "severity_distribution"]
    },
    "recurring_patterns": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "pattern": {"type": "string"},
          "category": {
            "type": "string",
            "enum": ["security", "correctness", "performance",
                     "maintainability", "style", "testing"]
          },
          "severity": {
            "type": "string",
            "enum": ["critical", "high", "medium", "low"]
          },
          "frequency": {
            "type": "integer",
            "description": "Times seen across PRs in this harvest window"
          },
          "total_lifetime_occurrences": {
            "type": "integer",
            "description": "Times seen across ALL harvests in qds-meta"
          },
          "prs": {"type": "array", "items": {"type": "integer"}},
          "root_cause_hypothesis": {"type": "string"},
          "recommended_intervention": {"type": "string"},
          "trend": {
            "type": "string",
            "enum": ["new", "persistent", "declining", "resolved"]
          }
        },
        "required": ["pattern", "category", "severity", "frequency", "total_lifetime_occurrences", "trend"]
      },
      "maxItems": 10
    },
    "quality_trend": {
      "type": "object",
      "properties": {
        "direction": {
          "type": "string",
          "enum": ["improving", "stable", "degrading"]
        },
        "evidence": {"type": "string"},
        "comments_per_pr_trend": {
          "type": "string",
          "enum": ["decreasing", "stable", "increasing"]
        },
        "severity_shift": {
          "type": "string",
          "description": "e.g., 'shifting from critical/high toward medium/low'"
        }
      },
      "required": ["direction", "evidence"]
    },
    "top_intervention": {
      "type": "object",
      "properties": {
        "description": {"type": "string"},
        "target": {
          "type": "string",
          "description": "What skill, directive, or pattern should change"
        },
        "expected_impact": {
          "type": "string",
          "enum": ["high", "medium", "low"]
        },
        "confidence": {"type": "number", "minimum": 0, "maximum": 1}
      },
      "required": ["description", "target", "expected_impact", "confidence"]
    },
    "data_sufficiency": {
      "type": "string",
      "enum": ["sufficient", "marginal", "insufficient"]
    }
  },
  "required": ["harvest_summary", "recurring_patterns",
               "quality_trend", "data_sufficiency"]
}
```

#### Step 4: Feedback Retention

```python
import hashlib

# Retain review patterns into qds-meta (factory performance data)
client.retain(
    bank_id="qds-meta",
    items=[{
        "content": json.dumps(response.structured_output),
        "tags": ["skill:review-harvester", "outcome:insight"],
        "document_id": f"review-harvest-{run_date}",
        "context": "Tri-daily external review mining from CodeRabbit/Gemini Code Assist PR reviews"
    }]
)

# Retain specific recurring antipatterns into qds-product
# (what coding agents miss → documented as antipatterns for future sessions)
for pattern in response.structured_output.get("recurring_patterns", []):
    if pattern["frequency"] >= 2:  # Only retain patterns seen across multiple PRs
        client.retain(
            bank_id="qds-product",
            items=[{
                "content": json.dumps({
                    "pattern": pattern["pattern"],
                    "category": pattern["category"],
                    "severity": pattern["severity"],
                    "source": "coderabbit-review",
                    "occurrences": pattern["total_lifetime_occurrences"],
                    "root_cause": pattern.get("root_cause_hypothesis", "unknown"),
                    "trend": pattern["trend"]
                }),
                "tags": ["knowledge_type:antipattern",
                         f"severity:{pattern['severity']}"],
                "document_id": f"review-antipattern-{hashlib.md5(pattern['pattern'].encode('utf-8')).hexdigest()}",
                "context": (f"Recurring issue caught by external reviewer across "
                            f"{pattern['frequency']} PRs in this harvest window. "
                            f"Lifetime occurrences: {pattern['total_lifetime_occurrences']}.")
            }]
        )
```

**Cross-agent compounding**: The Meta-Optimizer's biweekly run can now see Review Harvester findings in qds-meta. When the Meta-Optimizer evaluates "are interventions working?", it can compare self-reported skill outcomes against CodeRabbit's independent assessment. If we claim "adversarial reviews improved" but CodeRabbit is still flagging the same bug classes, the Meta-Optimizer detects the discrepancy. This is the external calibration loop.

The Review Harvester also feeds the Synthesizer's cross-bank analysis: recurring CodeRabbit patterns retained in qds-product (as antipatterns) can be correlated with skill blind spots in qds-meta, producing higher-confidence cross-bank insights than either data source alone.

---

## 5. The Compounding Loop

### 5.1 Data Flow

```
                    ┌─────────────────────────────────────────────┐
                    │           QDS-Factory Sessions              │
                    │  (development, review, sprint work)         │
                    └──────────────┬──────────────────────────────┘
                                   │ retain (post-session)
                    ┌──────────────▼──────────────────────────────┐
                    │          qds-product bank                   │
                    │  charter · decisions · patterns             │
                    │  antipatterns · state · module knowledge    │
                    └──────┬─────────────────────────┬───────────┘
                           │                         │
              reflect (pre-session)         reflect (Synthesizer Step 1)
                           │                         │
                    ┌──────▼──────┐          ┌───────▼────────┐
                    │  Next       │          │  Synthesizer   │
                    │  Session    │          │  Agent         │
                    └─────────────┘          └───────┬────────┘
                                                     │
                    ┌────────────────────────────────▼────────────┐
                    │          qds-meta bank                      │
                    │  skill outcomes · prompt effectiveness      │
                    │  review catch rates · agent findings        │
                    └──────┬──────────────────┬───────────────────┘
                           │                  │
              reflect (pre-skill)    ┌────────┴─────────┐
                           │        │                   │
                    ┌──────▼───┐  ┌─▼──────────┐  ┌────▼─────────────┐
                    │  Skill   │  │  Synth.    │  │  Meta-Optimizer  │
                    │  Exec    │  │  Step 2-3  │  │  Agent           │
                    └──────────┘  └─────┬──────┘  └────┬─────────────┘
                                        │              │
                                 retain findings  retain findings
                                        │              │
                                        ▼              ▼
                                   ┌─────────────────────────┐
                                   │   Compounding Loop      │
                                   │   (findings become      │
                                   │    inputs for next run) │
                                   └─────────────────────────┘

                Monthly: Blind Spot Detector audits BOTH banks
                         → gaps retained as outcome:gap
                         → future sessions fill gaps
```

### 5.2 Compounding Sequence (Example Timeline)

```
Week 1:    Synthesizer discovers "adversarial review skill misses security
           findings in coms module" → retained in both banks

Week 2:    Synthesizer sees the insight still flagged, no intervention
           → elevates to action_required: true

Week 2:    Meta-Optimizer evaluates "are adversarial reviews improving?"
           → sees no intervention → recommends adding security-focused
           checklist step → retained

Week 3:    Synthesizer runs → sees Meta-Optimizer recommendation
           → cross-references: "recommendation exists but not yet implemented"
           → persists in elevated_drift_signals

Week 4:    Session implements security checklist for coms module
           → retains outcome in qds-meta: skill:bmad-review-adversarial,
             outcome:success, quality_dim:security

Week 4:    Meta-Optimizer runs → sees new success observation
           → intervention_effectiveness: "checklist implemented, measurable
           improvement: security findings now caught"
           → trajectory: improving

Month 2:   Blind Spot Detector → "compliance module: 0 antipatterns, 0
           decisions" → retained as outcome:gap

Month 2:   Synthesizer → cross-references gap with meta: "no skill has
           been run against compliance module" → cross_bank_insight:
           "compliance module is completely unaudited"
           → recommendation: schedule dedicated review

Month 3:   Blind Spot Detector → compliance module now has 3 antipatterns,
           2 decisions, 1 pattern → completeness_score improved
           → gap resolved
```

### 5.3 Self-Optimization Mechanism

The Meta-Optimizer's `intervention_effectiveness` field creates a **selection pressure** on the system:

1. Agent recommends intervention X
2. Intervention X is (or isn't) implemented
3. Next run measures whether X produced measurable improvement
4. Effective interventions are reinforced (retained as `outcome:success`)
5. Ineffective interventions are abandoned (retained as `outcome:failure`)
6. The system learns which intervention patterns work for THIS factory

Over time, the `persistent_failure_modes` list shrinks as effective interventions are found, and the `improvement_trajectory.direction` trends toward `improving` at an `accelerating` rate. This is genuine meta-learning.

### 5.4 External Calibration via Review Harvester

The Review Harvester creates a critical feedback loop that no internal data source can provide:

1. CodeRabbit flags issue X on PRs 1, 2, 3 → Review Harvester detects recurrence → retained as antipattern in qds-product and pattern in qds-meta
2. Meta-Optimizer sees the pattern, recommends intervention (e.g., "add directive about X")
3. Intervention is implemented (directive added to qds-product)
4. Subsequent sessions see the directive during pre-session recall → coding agents avoid issue X
5. Review Harvester runs again → CodeRabbit no longer flags issue X → pattern marked as `resolved`
6. Meta-Optimizer confirms: `intervention_effectiveness.measurable_improvement: true`

This loop is only possible because the Review Harvester provides **independent, external validation**. Without it, step 5 would rely on self-assessment ("did we stop making that mistake?") rather than ground truth ("did CodeRabbit stop flagging it?").

---

## 6. Implementation Reference

### 6.1 CronCreate Specifications

Three CronCreate entries, staggered to avoid operational clustering:

```yaml
# Agent 1: Synthesizer — Weekly Monday 07:23 local
cron: "23 7 * * 1"
recurring: true
durable: true
prompt: |
  Run the Synthesizer proactive agent:
  1. Reflect on qds-product bank (cluster analysis + drift + contradictions)
  2. Reflect on qds-meta bank (skill blind spots + outcome trends + process gaps)
  3. Synthesize cross-bank correlations
  4. Retain findings in both banks
  See: docs/planning/hindsight-memory-master-design.md Section 4.2

# Agent 2: Meta-Optimizer — Biweekly 1st and 15th at 07:25 local
cron: "25 7 1,15 * *"
recurring: true
durable: true
prompt: |
  Run the Meta-Optimizer proactive agent:
  1. Reflect on qds-meta bank (improvement trajectory + persistent failures
     + intervention effectiveness + top recommendation)
  2. Retain findings in qds-meta bank
  See: docs/planning/hindsight-memory-master-design.md Section 4.3

# Agent 3: Blind Spot Detector — Monthly 1st at 07:27 local
cron: "27 7 1 * *"
recurring: true
durable: true
prompt: |
  Run the Blind Spot Detector proactive agent:
  1. Reflect on qds-product bank (coverage gaps + suspicious absences)
  2. Reflect on qds-meta bank (skill coverage gaps + under-observed skills)
  3. Retain gaps in qds-meta bank
  See: docs/planning/hindsight-memory-master-design.md Section 4.4

# Agent 4: Review Harvester — Every 3 days at 02:17 local
cron: "17 2 */3 * *"
recurring: true
durable: true
prompt: |
  Run the Review Harvester proactive agent:
  1. Fetch recent merged PRs from GitHub (last 3 days): gh pr list --state merged --limit 15 --json number,title,mergedAt
  2. For each PR, fetch CodeRabbit/Gemini Code Assist review comments:
     gh api repos/biospark33/QDS-Factory/pulls/{N}/comments
     gh api repos/biospark33/QDS-Factory/pulls/{N}/reviews
  3. Classify comments by severity, category, and recurrence
  4. Reflect on qds-meta for pattern correlation against prior harvests
  5. Retain recurring patterns as antipatterns in qds-product
  6. Retain harvest analysis in qds-meta
  See: docs/planning/hindsight-memory-master-design.md Section 4.5
```

Note: Agents 1–3 run at staggered minutes (07:23, 07:25, 07:27) to avoid API contention even when schedules coincide (e.g., the 1st falling on a Monday triggers both Synthesizer and Blind Spot Detector). The Review Harvester runs at 02:17 local — a different time window because it calls external APIs (GitHub) in addition to Hindsight, and nighttime execution minimizes interference with active development.

### 6.2 Integration with Existing Systems

#### Swarmclaw (claude-mem) Bridge

Swarmclaw captures **what happened** (operational/session memory). Hindsight captures **what it means** (strategic/structural memory). The bridge is a post-session retain pipeline:

```
Session ends
  → Swarmclaw records session observation
  → Bridge extracts relevant content from Swarmclaw observation
  → Bridge retains into appropriate Hindsight bank:
     - Product decisions → qds-product (tags: module:X, knowledge_type:decision)
     - Skill outcomes → qds-meta (tags: skill:X, outcome:Y, quality_dim:Z)
```

**Bridge classification rules**:

The bridge must determine: (1) which content is relevant vs conversational noise, (2) which bank receives the content, and (3) which tags to apply. Classification is performed by the LLM using the bank missions as guidance — the rules below define the expected routing behavior.

**Classification routing table**:

| Content signal | Target bank | Tags | Classification cues |
|---------------|-------------|------|-------------------|
| Architectural choice or trade-off | `qds-product` | `knowledge_type:decision` + `module:X` | "decided", "chose", "trade-off", "instead of"; references to modules, APIs, schemas |
| Bug pattern or recurring error | `qds-product` | `knowledge_type:antipattern` + `module:X` + `severity:Y` | "bug", "broken", "doesn't work"; failed tests, review findings |
| Proven approach or successful pattern | `qds-product` | `knowledge_type:pattern` + `module:X` | "works well", "resolved", "passed all tests"; repeatable method |
| Charter principle referenced | `qds-product` | `knowledge_type:charter` + `module:X` | References to PRD rules, security invariants, non-negotiable constraints |
| Current module/feature state | `qds-product` | `knowledge_type:state` + `module:X` | "now supports", "currently implements", status updates |
| Skill execution result | `qds-meta` | `skill:X` + `outcome:Y` + `quality_dim:Z` | Skill name in session context; success/partial/failure outcome |

**Precedence**: When content matches multiple categories, `charter` > `antipattern` > `decision` > `pattern` > `state`. Charter principles and antipatterns are higher-priority knowledge that should never be misclassified.

**Module tagging heuristics** (when module is not explicitly named):

1. Map file paths to modules via project directory structure
2. If multiple modules are referenced, split into separate retain calls
3. If no module is identifiable but content is factory-related, use `module:factory`
4. If module assignment confidence is low, omit the module tag rather than mis-tag

**Multi-topic sessions**: Split into multiple retain calls, each containing a single coherent topic with consistent tags. Do not bundle unrelated topics into a single retain.

**Bridge call input/output schema**:

```json
{
  "input": {
    "session_observation": "string — Swarmclaw session content",
    "files_touched": ["string — file paths modified during session"],
    "skills_used": ["string — skills invoked during session"]
  },
  "outputs": [
    {
      "bank_id": "qds-product | qds-meta",
      "content": "string — extracted relevant content",
      "tags": ["module:X", "knowledge_type:Y | skill:X", "outcome:Y", "quality_dim:Z"],
      "session_id": "string — source session identifier"
    }
  ]
}
```

Implementation: Claude Code post-session hook that calls the bridge.

#### Sprint Artifact Ingestion

QDS-Factory sprint artifacts at `_bmad-output/` are the initial charter content for `qds-product`:

```
_bmad-output/phase-0/stories/*.md → retain with tags [knowledge_type:charter, module:X]
_bmad-output/phase-1/stories/*.md → retain with tags [knowledge_type:decision, module:X]
_bmad-output/sprint-artifacts/*    → retain with tags [knowledge_type:state, module:factory]
```

Implementation: One-time seeding script during initial bank setup.

#### Claude Code Hooks

| Hook | Action | Target |
|------|--------|--------|
| Pre-session | `recall(qds-product, tags=["knowledge_type:charter"], tags_match="all_strict")` | Session context |
| Pre-session | `recall(qds-product, tags=["knowledge_type:antipattern"], tags_match="all_strict")` | Session context |
| Pre-skill | `reflect(qds-meta, "What should I know about this skill?", tags=[skill:X], response_schema=...)` | Skill preparation |
| Post-session | `retain(qds-product, session_summary, tags=[module:X, knowledge_type:Y])` | Bank ingestion |
| Post-skill | `retain(qds-meta, skill_result, tags=[skill:X, outcome:Y, quality_dim:Z])` | Bank ingestion |

### 6.3 Hindsight API Prerequisites

Before agent implementation, the Hindsight server must be configured with:

1. **Two banks** created with the configurations specified in Section 3
2. **Entity labels** defined on both banks per the tag schemas
3. **Missions** set for all three mission types on both banks
4. **Disposition traits** set per bank configuration
5. **Directives** populated from sprint artifact security invariants
6. **Mental models** created per the model tables in Section 3
7. **Observation scopes** set to `per_tag` on both banks

---

## 7. Operational Surface & Cost

### 7.1 Monthly Operational Summary

| Agent | Runs/Month | Reflect Calls/Run | Est. Tokens/Run | Monthly Tokens |
|-------|-----------|-------------------|-----------------|----------------|
| Synthesizer | 4–5 | 3 | 15–20k | 60–100k |
| Meta-Optimizer | 2 | 1 | 10–15k | 20–30k |
| Blind Spot Detector | 1 | 2 | 8–10k | 8–10k |
| Review Harvester | 10 | 1 + gh CLI | 8–12k | 80–120k |
| **Total** | **17–18** | **—** | **—** | **168–260k** |

> **Note**: The token estimates above are **lower bounds** reflecting only reflect-call costs. Actual monthly token usage will be higher due to three additional sources not included in this table:
> 1. **Retain operations** — verbose-mode extraction of facts/entities/relationships during post-session and post-agent retention
> 2. **Observation consolidation** — automatic background runs that merge and refine observations after each retain
> 3. **Review Harvester context** — GitHub PR comment ingestion adds input tokens proportional to review volume

### 7.2 Operational Guarantees

| Guarantee | Mechanism |
|-----------|-----------|
| **No noise** | `data_sufficiency` fields in every response schema force agents to self-assess output quality. Agents must state when data is insufficient rather than fabricating insights. |
| **No duplicate work** | `document_id` on retain calls uses agent name + date, ensuring upsert behavior and preventing duplicate runs. |
| **Failure recovery** | Agents are stateless. All state lives in Hindsight observations. If a run fails, the next scheduled run picks up from observation state. No external state to corrupt. |
| **Audit trail** | `include_facts=True` on every reflect call. Every finding is traceable to specific memories and observations. |
| **Self-throttling** | `system_maturity` field in Meta-Optimizer output causes early-calibration deferral when insufficient data exists. The system doesn't pretend to be insightful when it's still learning. |
| **No operational clustering** | Schedules staggered across weekly/biweekly/monthly at distinct off-minutes (07:23, 07:25, 07:27) to prevent overlap when schedules coincide (e.g., the 1st falling on a Monday triggers both Synthesizer and Blind Spot Detector). |

### 7.3 Monitoring

No dedicated monitoring infrastructure. Observability comes from:

1. **CronCreate job status** — standard Claude Code cron status
2. **Retention logs** — every agent retain creates a document_id that can be queried
3. **Meta-Optimizer output** — the `improvement_trajectory` and `system_maturity` fields are the system's own health check
4. **Swarmclaw observations** — agent runs are recorded as session observations

If the Meta-Optimizer reports `system_maturity: early_calibration` for more than 3 months, it indicates insufficient data flow into qds-meta — a process problem, not a monitoring problem.

---

## 8. Alternatives Considered & Rejected

### 8.1 Rejected Agent Designs

| Rejected Agent | What It Would Do | Why Rejected |
|----------------|-----------------|--------------|
| **Drift Sentinel** | Dedicated agent scanning observation freshness trends | Absorbed into Synthesizer's `drift_signals` output. A separate agent for this is redundant — the Synthesizer already runs weekly and checks freshness as part of its product analysis. |
| **Charter Guardian** | Dedicated agent scanning for charter contradictions | Covered by directives (enforced at reflect layer) + Synthesizer's `contradictions` output. Directives are the right tool for non-negotiable rules; they're enforced on every reflect call, not just weekly. |
| **Daily Pulse** | Lightweight daily check for anomalies | Insufficient data velocity to justify daily runs. QDS-Factory session frequency doesn't produce enough daily observations for meaningful daily analysis. Weekly is the right cadence. |
| **Knowledge Curator** | Automatically restructures and re-tags bank content | Premature optimization. Entity labels with `tag: true` provide hard SQL filtering; mental models provide instant retrieval. Manual curation is not a bottleneck. Revisit if/when retrieval quality degrades. |
| **Intervention Executor** | Automatically implements Meta-Optimizer recommendations | Too dangerous. Recommendations should be human-reviewed before implementation. The system advises; humans decide. |

### 8.2 Rejected Architecture Variants

| Variant | Description | Why Rejected |
|---------|-------------|--------------|
| **Single bank** | Merge qds-product and qds-meta into one bank | Forces compromise on disposition tuning (skepticism=4 for product vs 5 for meta), missions (retain missions are fundamentally different), and observation scopes. Two banks preserve the right configuration per domain. |
| **Per-module banks** | One bank per module (6 banks) | Over-partitioning. Cross-module queries become expensive client-side orchestration. Tag-based filtering within a single bank achieves the same isolation with simpler operations. |
| **10-agent fleet** | Separate agents for drift, charter, gaps, trends, per-skill analysis, etc. | Over-engineered. Four orthogonal questions exhaust the proactive intelligence surface: three analyzing internal data + one ingesting external ground truth. More agents means more operational surface, more failure modes, and more coordination complexity for no additional insight coverage. |

---

## 9. Implementation Sequence

### Phase 1: Bank Foundation (Day 1)

1. Deploy/configure Hindsight server
2. Create `qds-product` bank with full configuration (missions, dispositions, entity labels, observation scopes)
3. Create `qds-meta` bank with full configuration
4. Populate directives on both banks from sprint artifact security invariants
5. Create mental models on both banks
6. Verify bank configuration via test retain/recall/reflect

### Phase 2: Initial Seeding (Day 1–2)

1. Extract charter content from `_bmad-output/phase-0/stories/` → retain into qds-product with `knowledge_type:charter` tags
2. Extract decisions from `_bmad-output/phase-1/stories/` → retain into qds-product with `knowledge_type:decision` tags
3. Extract patterns/antipatterns from sprint review artifacts → retain into qds-product with appropriate tags
4. Verify seeding quality via targeted recall queries

### Phase 3: Hook Integration (Day 2–3)

1. Implement Swarmclaw → Hindsight bridge (post-session retain pipeline)
2. Configure Claude Code pre-session hooks (recall from both banks)
3. Configure Claude Code post-session hooks (retain into both banks)
4. Configure post-skill execution hooks (retain into qds-meta)
5. Verify hook integration with a test session

### Phase 4: Proactive Agent Deployment (Day 3)

1. Create CronCreate entries for all three agents
2. Run each agent manually once to verify output quality
3. Verify retention of findings back into banks
4. Enable recurring schedules

### Phase 5: Calibration Period (Weeks 1–4)

1. Monitor agent outputs for noise vs signal
2. Verify Meta-Optimizer reports `system_maturity: early_calibration`
3. Adjust missions/dispositions if extraction quality is poor
4. Wait for sufficient data accumulation before expecting `emerging_patterns`

### Phase 6: Steady State (Month 2+)

1. System self-optimizes via compounding loop
2. Human review of Meta-Optimizer recommendations
3. Gap-filling sessions triggered by Blind Spot Detector findings
4. Periodic review of directives for relevance

---

## 10. Success Criteria

### 10.1 Quantitative

| Metric | Target | Measurement |
|--------|--------|-------------|
| Cross-bank insights per Synthesizer run | ≥1 actionable insight | `cross_bank_insights` array length in synthesis output |
| Meta-Optimizer trajectory accuracy | Recommendations with `confidence ≥ 0.7` correlate with measurable improvement | Compare `top_recommendation` against subsequent `intervention_effectiveness` |
| Completeness score trend | Monthly improvement until ≥0.8 on both banks | `completeness_score` from Blind Spot Detector |
| Drift signal resolution | ≥80% of `action_required: true` drift signals resolved within 4 weeks | Track `weeks_flagged` across Synthesizer runs |
| False positive rate | <20% of agent insights are refuted by subsequent data | Cross-reference `intervention_effectiveness.measurable_improvement` |
| **CodeRabbit comments per PR** | **Declining trend month-over-month** | `comments_per_pr_avg` from Review Harvester `quality_trend` |
| **CodeRabbit severity distribution** | **Shift from critical/high toward medium/low** | `severity_distribution` tracked across harvests |
| **Repeat-pattern rate** | **<20% of patterns persist for >4 harvests** | `recurring_patterns[].trend == "persistent"` count across harvests |
| **External calibration agreement** | **Self-reported outcomes agree with CodeRabbit findings ≥80%** | Compare Meta-Optimizer trajectory against Review Harvester `quality_trend` |

### 10.2 Qualitative

| Criterion | Evidence |
|-----------|----------|
| Factory produces fewer recurring bugs | Synthesizer shows declining antipattern recurrence in specific modules |
| Review skills catch more bugs per run | Meta-Optimizer shows `improving` trajectory for review skills |
| No module is unaudited for >2 months | Blind Spot Detector gaps are resolved within 2 months of detection |
| The system surprises us | Synthesizer discovers at least one cross-bank insight per month that no team member anticipated |
| Interventions compound | Meta-Optimizer shows `accelerating` improvement rate by month 6 |
| CodeRabbit has less to say over time | Review Harvester shows declining comments-per-PR and shifting severity distribution |
| External and internal assessments converge | Self-reported skill outcomes and CodeRabbit findings tell the same story |

### 10.3 Anti-Success Signals

| Signal | Meaning |
|--------|---------|
| Synthesizer consistently returns `no_meaningful_correlations: true` | Either data flow is insufficient or the two banks aren't producing intersecting patterns. Investigate data pipeline. |
| Meta-Optimizer reports `system_maturity: early_calibration` for >3 months | Insufficient skill outcome data flowing into qds-meta. Post-skill hooks may not be firing. |
| Blind Spot Detector `completeness_score` doesn't improve over 3 months | Gap findings aren't being acted on. Sessions aren't filling identified gaps. |
| `data_sufficiency: insufficient` in >50% of agent outputs | Banks need more initial seeding or hook integration isn't retaining enough data. |

---

## Appendix A: Response Schema Registry

All response schemas referenced in this document, consolidated for implementation:

| Schema Name | Used By | Location |
|-------------|---------|----------|
| `SYNTHESIZER_PRODUCT_SCHEMA` | Synthesizer Step 1 | Section 4.2, Step 1 |
| `SYNTHESIZER_META_SCHEMA` | Synthesizer Step 2 | Section 4.2, Step 2 |
| `SYNTHESIS_SCHEMA` | Synthesizer Step 3 | Section 4.2, Step 3 |
| `META_OPTIMIZER_SCHEMA` | Meta-Optimizer Step 1 | Section 4.3, Step 1 |
| `BLIND_SPOT_PRODUCT_SCHEMA` | Blind Spot Detector Step 1 | Section 4.4, Step 1 |
| `BLIND_SPOT_META_SCHEMA` | Blind Spot Detector Step 2 | Section 4.4, Step 2 |
| `SKILL_PREP_SCHEMA` | Pre-skill hook | Section 3.2 (Pre-skill preparation schema) |
| `REVIEW_HARVEST_SCHEMA` | Review Harvester Step 3 | Section 4.5, Step 3 |

## Appendix B: Entity Label Complete Definitions

### qds-product Entity Labels

```json
{
  "entity_labels": [
    {
      "key": "knowledge_type",
      "type": "value",
      "tag": true,
      "description": "The category of knowledge: charter principles, architectural decisions, proven patterns, antipatterns to avoid, or current state",
      "values": [
        {"value": "charter", "description": "Non-negotiable principles and constraints from PRD/architecture"},
        {"value": "decision", "description": "Architectural or design decisions with rationale"},
        {"value": "pattern", "description": "Proven approaches that work well in this codebase"},
        {"value": "antipattern", "description": "Approaches or patterns that caused problems and should be avoided"},
        {"value": "state", "description": "Current state of modules, features, or components"}
      ]
    },
    {
      "key": "module",
      "type": "value",
      "tag": true,
      "description": "The product module this knowledge relates to",
      "values": [
        {"value": "harness", "description": "Test harness and execution framework"},
        {"value": "coms", "description": "Communication and messaging layer"},
        {"value": "auth", "description": "Authentication and authorization"},
        {"value": "memory", "description": "Memory management and persistence"},
        {"value": "cli", "description": "Command-line interface"},
        {"value": "infra", "description": "Infrastructure, deployment, CI/CD"},
        {"value": "factory", "description": "Factory-level processes, agent findings, and cross-cutting concerns"}
      ]
    },
    {
      "key": "severity",
      "type": "value",
      "tag": true,
      "description": "The severity or priority level of this knowledge",
      "values": [
        {"value": "critical", "description": "Must not be violated; production-impacting"},
        {"value": "high", "description": "Important; should not be violated without explicit decision"},
        {"value": "medium", "description": "Notable; worth knowing but not blocking"},
        {"value": "low", "description": "Informational; nice to know"}
      ]
    }
  ]
}
```

### qds-meta Entity Labels

```json
{
  "entity_labels": [
    {
      "key": "skill",
      "type": "value",
      "tag": true,
      "description": "The factory skill or agent that produced this outcome",
      "values": [
        {"value": "bmad-dev-story", "description": "BMAD story development skill"},
        {"value": "bmad-review-adversarial", "description": "BMAD adversarial review skill"},
        {"value": "qds-story-review", "description": "QDS story review skill"},
        {"value": "synthesizer", "description": "Cross-bank pattern mining proactive agent"},
        {"value": "meta-optimizer", "description": "Self-improvement feedback proactive agent"},
        {"value": "blind-spot-detector", "description": "Completeness audit proactive agent"},
        {"value": "sprint-planning", "description": "Sprint planning and estimation"},
        {"value": "code-review", "description": "Code review process"},
        {"value": "review-harvester", "description": "External review mining agent (CodeRabbit, Gemini Code Assist)"}
      ]
    },
    {
      "key": "outcome",
      "type": "value",
      "tag": true,
      "description": "The outcome classification for this skill execution",
      "values": [
        {"value": "success", "description": "Skill completed successfully with expected results"},
        {"value": "partial", "description": "Skill completed but with notable gaps or issues"},
        {"value": "failure", "description": "Skill failed to complete or produced incorrect results"},
        {"value": "false_positive", "description": "Skill flagged an issue that wasn't real"},
        {"value": "missed", "description": "Skill missed an issue that was later caught"},
        {"value": "insight", "description": "Proactive agent discovered a non-obvious insight"},
        {"value": "gap", "description": "Proactive agent identified missing knowledge"}
      ]
    },
    {
      "key": "quality_dim",
      "type": "multi-values",
      "tag": true,
      "description": "Quality dimensions relevant to this skill execution",
      "values": [
        {"value": "correctness", "description": "Functional correctness and bug freedom"},
        {"value": "security", "description": "Security vulnerabilities and attack surface"},
        {"value": "performance", "description": "Performance and efficiency"},
        {"value": "testability", "description": "Ease of testing and test coverage"},
        {"value": "maintainability", "description": "Code clarity, modularity, and long-term health"}
      ]
    }
  ]
}
```

## Appendix C: Hindsight Documentation Reference

Full Hindsight documentation is available at `/Users/steve/.claude/skills/hindsight-docs/references/`:

| Document | Purpose |
|----------|---------|
| `best-practices.md` | Integration patterns, missions, tags, anti-patterns |
| `developer/api/retain.md` | Retain API reference |
| `developer/api/recall.md` | Recall API with tag filtering |
| `developer/api/reflect.md` | Reflect with `response_schema` |
| `developer/api/memory-banks.md` | Bank config, entity labels, directives |
| `developer/observations.md` | Consolidation mechanics |
| `developer/retrieval.md` | TEMPR retrieval architecture |
| `developer/retain.md` | Retain architecture (fact extraction) |
| `developer/configuration.md` | Full environment variable reference |

Invoke via skill: `/hindsight-docs`

---

---

**Upstream extension**: This document defines the **project-level** memory tier. The factory tier — cross-project learning, A/B testing, and self-optimization across the entire QDS portfolio — is defined in [QDS-MEM-002](hindsight-factory-tier-design.md). The factory tier is purely additive and requires no changes to this document's architecture.

---

*End of document. This is the canonical reference for QDS-Factory project-level Hindsight memory system implementation. All sessions implementing, modifying, or extending this system should read this document first. For factory-tier cross-project architecture, see QDS-MEM-002.*
