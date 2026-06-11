# QDS-Factory Factory-Tier Memory System — Design & Decision Document

**Document ID**: QDS-MEM-002
**Status**: Approved design
**Created**: 2026-06-11
**Extends**: QDS-MEM-001 (Project-Level Hindsight Memory System)
**Authority**: Architecture decision record for cross-project factory memory and self-optimization

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [The Two-Tier Architecture](#2-the-two-tier-architecture)
3. [Design Principles](#3-design-principles)
4. [Factory Bank Architecture](#4-factory-bank-architecture)
5. [The Promotion Pipeline](#5-the-promotion-pipeline)
6. [Factory Agent Fleet](#6-factory-agent-fleet)
7. [Cross-Project Pattern Amplification](#7-cross-project-pattern-amplification)
8. [A/B Testing Protocol](#8-ab-testing-protocol)
9. [Transfer Learning](#9-transfer-learning)
10. [Portfolio Health & Variance](#10-portfolio-health--variance)
11. [Factory-to-Project Directive Flow](#11-factory-to-project-directive-flow)
12. [The Compounding Loop](#12-the-compounding-loop)
13. [Operational Surface & Cost](#13-operational-surface--cost)
14. [Alternatives Considered & Rejected](#14-alternatives-considered--rejected)
15. [Success Criteria](#15-success-criteria)

---

## 1. Executive Summary

QDS-MEM-001 defines a per-project Hindsight memory system: two banks, four proactive agents, a compounding improvement loop. Each project/repo gets its own instance. Project A's memory is isolated from Project B's — they have different charters, different modules, different antipatterns.

This document defines the **factory tier** — a single, factory-wide memory layer that sits above all project instances and answers one question no project-level agent can:

> **"What patterns span multiple projects that no single project would detect?"**

When CodeRabbit flags the same security antipattern in QDS-Factory, the next project, and the one after that, it's not a project problem — it's a **factory problem**. The factory tier detects this automatically and escalates priority proportional to how many projects exhibit the same pattern.

The factory tier provides three capabilities that per-project memory cannot:

1. **Cross-project pattern amplification** — Patterns seen across N projects get N× priority weight. A single-project antipattern might be a fluke. A three-project antipattern is a systematic factory weakness.
2. **Natural A/B testing** — Multiple projects provide treatment and control groups. Interventions can be tested on one project and measured against an unchanged project using CodeRabbit as the independent measurement instrument.
3. **Transfer learning** — Interventions that work in Project A can be proactively proposed for similar projects, with the factory tracking whether transfers succeed or fail.

The factory tier is **purely additive**. It requires zero changes to QDS-MEM-001. Project-level agents continue operating independently even if the factory tier is down.

---

## 2. The Two-Tier Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                   FACTORY TIER (one instance)                       │
│                                                                     │
│  factory-product bank              factory-meta bank                │
│  ┌───────────────────────┐        ┌───────────────────────┐        │
│  │ skill definitions     │        │ cross-project skill   │        │
│  │ prompt templates      │        │ effectiveness         │        │
│  │ directive library     │        │ A/B experiment logs   │        │
│  │ factory charter       │        │ cross-project CR trends│       │
│  │ cross-project         │        │ factory agent findings │       │
│  │ antipatterns          │        │ portfolio health KPIs │        │
│  └──────────▲────────────┘        └──────────▲────────────┘        │
│             │ retain                        │ retain               │
│        ┌────┴───────────────────────────────┴────┐                  │
│        │       Factory-Level Agents (4)          │                  │
│        │  Cross-Project Synthesizer              │                  │
│        │  Factory Optimizer (A/B runner)         │                  │
│        │  Portfolio Review Harvester             │                  │
│        │  Factory Blind Spot Detector            │                  │
│        └────▲───────────────────────────▲────────┘                  │
│             │ promotion pipeline        │                            │
├─────────────┼───────────────────────────┼───────────────────────────┤
│             │                           │                           │
│    ┌────────┴──────────┐      ┌────────┴──────────┐                │
│    │  Project A        │      │  Project B         │      ...       │
│    │  qds-product-A    │      │  qds-product-B     │                │
│    │  qds-meta-A       │      │  qds-meta-B        │                │
│    │  4 project agents │      │  4 project agents  │                │
│    └───────────────────┘      └────────────────────┘                │
└─────────────────────────────────────────────────────────────────────┘
```

**Key property**: Factory agents read from and write to **factory banks only**. They do not access project banks directly. Project findings reach factory banks through the promotion pipeline (Section 5). This keeps the two tiers decoupled — a project can be added or removed without any factory-level configuration changes beyond bank registration.

---

## 3. Design Principles

| ID | Principle | Rationale |
|----|-----------|-----------|
| F1 | **Additive, not invasive** | Factory tier requires zero changes to project-level agents or banks. The promotion pipeline is a post-hoc addition to each project agent's retention step. |
| F2 | **Factory banks are the integration point** | Factory agents reflect on factory banks, not project banks. This decouples tiers and makes factory agents testable in isolation. |
| F3 | **Signal strength scales with project count** | A pattern seen in 1 of 3 projects is baseline. 2 of 3 is 5× weight. 3 of 3 is 10× weight. The factory tier's value grows with portfolio size. |
| F4 | **CodeRabbit is the measurement instrument** | External reviews are the independent variable for A/B tests and quality tracking. Self-reported outcomes are secondary signals. |
| F5 | **Transfer is proposed, not imposed** | The factory recommends interventions for similar projects. Projects retain autonomy to accept or reject. Transfer failures are as informative as transfer successes. |
| F6 | **Low average AND low variance** | Portfolio health means consistent quality across projects, not just good average quality. A factory where one project has 2 CodeRabbit comments/PR and another has 15 is not healthy. |

---

## 4. Factory Bank Architecture

### 4.1 factory-product Bank

**What it stores**: The factory's own "product" — its skills, prompts, directives, and processes. The factory's output is code quality; therefore, the factory's "product knowledge" is its configuration.

**Bank configuration**:

```json
{
  "bank_id": "factory-product",
  "description": "Factory-wide skills, directives, prompts, and cross-project antipatterns",
  "disposition": {
    "skepticism": 4,
    "retention": "indefinite",
    "consolidation": "aggressive"
  },
  "missions": [
    {
      "type": "retain",
      "description": "Store factory-wide directives, skills, and antipatterns"
    },
    {
      "type": "recall",
      "description": "Retrieve factory-wide configuration for new project bootstrapping"
    },
    {
      "type": "reflect",
      "description": "Analyze cross-project antipatterns and directive effectiveness"
    }
  ],
  "entity_labels": [
    {
      "key": "knowledge_type",
      "type": "multi-values",
      "tag": true,
      "values": [
        {"value": "directive", "description": "Factory-wide rule that flows to all projects"},
        {"value": "skill", "description": "Factory skill definition"},
        {"value": "antipattern", "description": "Cross-project recurring issue caught by external reviewers"},
        {"value": "prompt-template", "description": "Factory-wide prompt template"},
        {"value": "experiment", "description": "A/B test result"},
        {"value": "transfer-record", "description": "Record of intervention transfer between projects"}
      ]
    },
    {
      "key": "project_scope",
      "type": "multi-values",
      "tag": true,
      "values": [
        {"value": "all-projects", "description": "Applies to every project in the factory"},
        {"value": "project-type:web-app", "description": "Applies to web application projects"},
        {"value": "project-type:api", "description": "Applies to API-only projects"},
        {"value": "project-type:library", "description": "Applies to library/package projects"},
        {"value": "project-type:cli", "description": "Applies to CLI tool projects"}
      ]
    },
    {
      "key": "cross_project_frequency",
      "type": "multi-values",
      "tag": true,
      "values": [
        {"value": "single-project", "description": "Seen in 1 project only"},
        {"value": "emerging-cross-project", "description": "Seen in 2 of N projects"},
        {"value": "widespread", "description": "Seen in 3+ of N projects"}
      ]
    },
    {
      "key": "factory_agent",
      "type": "multi-values",
      "tag": true,
      "values": [
        {"value": "cross-project-synthesizer", "description": "Cross-project pattern mining agent"},
        {"value": "factory-optimizer", "description": "A/B testing and optimization agent"},
        {"value": "portfolio-review-harvester", "description": "Multi-project external review mining"},
        {"value": "factory-blind-spot", "description": "Factory-level completeness audit"}
      ]
    },
    {
      "key": "quality_dim",
      "type": "multi-values",
      "tag": true,
      "values": [
        {"value": "correctness", "description": "Functional correctness"},
        {"value": "security", "description": "Security vulnerabilities"},
        {"value": "performance", "description": "Performance and efficiency"},
        {"value": "testability", "description": "Test coverage and testability"},
        {"value": "maintainability", "description": "Code clarity and long-term health"}
      ]
    }
  ]
}
```

### 4.2 factory-meta Bank

**What it stores**: How well the factory itself is performing — aggregated across all projects.

```json
{
  "bank_id": "factory-meta",
  "description": "Cross-project factory performance, A/B experiments, and portfolio health",
  "disposition": {
    "skepticism": 5,
    "retention": "rolling-90d-detail",
    "consolidation": "aggressive"
  },
  "missions": [
    {
      "type": "retain",
      "description": "Store cross-project performance summaries and experiment results"
    },
    {
      "type": "recall",
      "description": "Retrieve portfolio health metrics and experiment history"
    },
    {
      "type": "reflect",
      "description": "Analyze factory-wide trends, A/B results, and transfer learning"
    }
  ],
  "entity_labels": [
    {
      "key": "source_project",
      "type": "multi-values",
      "tag": true,
      "description": "Which project(s) contributed this observation"
    },
    {
      "key": "factory_agent",
      "type": "multi-values",
      "tag": true,
      "values": [
        {"value": "cross-project-synthesizer", "description": "Cross-project pattern mining"},
        {"value": "factory-optimizer", "description": "A/B testing and optimization"},
        {"value": "portfolio-review-harvester", "description": "Multi-project review mining"},
        {"value": "factory-blind-spot", "description": "Factory completeness audit"}
      ]
    },
    {
      "key": "experiment_status",
      "type": "multi-values",
      "tag": true,
      "values": [
        {"value": "hypothesis", "description": "Proposed but not yet tested"},
        {"value": "active", "description": "Currently running A/B test"},
        {"value": "completed-success", "description": "Completed with positive result"},
        {"value": "completed-failure", "description": "Completed with negative result"},
        {"value": "completed-inconclusive", "description": "Completed with unclear result"},
        {"value": "rolled-back", "description": "Reverted due to degradation"}
      ]
    },
    {
      "key": "portfolio_metric",
      "type": "multi-values",
      "tag": true,
      "values": [
        {"value": "comments-per-pr", "description": "CodeRabbit comments per PR (project-level)"},
        {"value": "severity-distribution", "description": "CodeRabbit severity breakdown"},
        {"value": "repeat-pattern-rate", "description": "Patterns persisting across harvests"},
        {"value": "transfer-success-rate", "description": "Intervention transfer success rate"},
        {"value": "portfolio-variance", "description": "Quality variance across projects"}
      ]
    }
  ]
}
```

---

## 5. The Promotion Pipeline

Project findings reach factory banks through a **promotion pipeline** — a lightweight step appended to each project-level agent's execution sequence. This is the only integration point between tiers.

### 5.1 Promotion Rules

Not every project finding deserves factory-level attention. Promotion criteria:

| Finding Type | Promoted When | Target Bank |
|-------------|--------------|-------------|
| Recurring antipattern (from Review Harvester) | Frequency ≥ 2 across any PRs | `factory-product` as `antipattern` |
| Agent insight (from Synthesizer/Meta-Optimizer) | Any cross-project relevance | `factory-meta` as summary |
| Skill outcome | All outcomes promoted | `factory-meta` as `skill-outcome` aggregate |
| Drift signal | `action_required: true` only | `factory-meta` as `drift-alert` |
| Blind spot gap | Any gap | `factory-meta` as `completeness-gap` |

### 5.2 Promotion Implementation

Each project-level agent appends a promotion step to its execution:

```python
from datetime import datetime

# Appended to each project agent's retention step
def promote_to_factory(project_id: str, finding: dict, finding_type: str):
    """Promote a project-level finding to factory banks."""

    # Only promote findings that meet criteria
    if not meets_promotion_criteria(finding, finding_type):
        return

    run_date = datetime.utcnow().date().isoformat()

    # Enrich with project metadata
    promoted = {
        **finding,
        "source_project": project_id,
        "promotion_date": run_date,
        "finding_type": finding_type,
    }

    # Route to appropriate factory bank
    if finding_type in ("antipattern", "directive", "skill"):
        target_bank = "factory-product"
    else:
        target_bank = "factory-meta"

    client.retain(
        bank_id=target_bank,
        items=[{
            "content": json.dumps(promoted),
            "tags": [
                f"source_project:{project_id}",
                f"finding_type:{finding_type}",
                "promoted:true",
            ],
            "document_id": f"promoted-{project_id}-{finding_type}-{run_date}",
            "context": f"Promoted from project {project_id} {finding_type} analysis"
        }]
    )
```

### 5.3 Promotion Frequency

Promotion happens as part of each project agent's existing schedule — no additional cron entries:

| Project Agent | Schedule | Promotes |
|--------------|----------|----------|
| Review Harvester | Every 3 days | Recurring antipatterns, harvest summaries |
| Synthesizer | Weekly | Cross-bank insights with cross-project relevance |
| Meta-Optimizer | Biweekly | Skill outcome aggregates, trajectory summaries |
| Blind Spot Detector | Monthly | Completeness gaps |

**Result**: Factory banks accumulate a steady stream of promoted findings from all active projects. Factory agents then reflect on this aggregated data.

---

## 6. Factory Agent Fleet

The factory tier uses the same 4-agent orthogonal pattern as the project tier, but operating across all projects simultaneously.

### 6.1 Agent 1: Cross-Project Synthesizer

| Field | Value |
|-------|-------|
| **Agent name** | `cross-project-synthesizer` |
| **Schedule** | Weekly Wednesday 03:11 local (`11 3 * * 3`) |
| **Banks touched** | Both factory banks |
| **Budget** | `mid` |
| **Reflect calls per run** | 2 (one per factory bank) |
| **Estimated tokens/run** | 15,000–20,000 |

**Orthogonal question**: "What patterns span multiple projects that no single project would detect?"

**Execution sequence**:

```
Step 1: Reflect on factory-meta (cross-project performance trends)
Step 2: Reflect on factory-product (cross-project antipattern clustering)
Step 3: Cross-reference to find amplification signals
Step 4: Retain cross-project insights
```

**What it finds**:
- Antipatterns that cluster across projects (e.g., security issues appearing in 3 of 4 projects)
- Quality dimensions where some projects consistently outperform others
- Skill effectiveness variations across project types
- Emerging cross-project patterns (new issue appearing in 2+ projects simultaneously)

**Response schema** (`CROSS_PROJECT_SYNTHESIS_SCHEMA`):

```json
{
  "type": "object",
  "properties": {
    "cross_project_patterns": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "pattern": {"type": "string"},
          "category": {"type": "string"},
          "projects_affected": {"type": "array", "items": {"type": "string"}},
          "frequency": {"type": "integer", "description": "Projects exhibiting this pattern"},
          "total_portfolio": {"type": "integer", "description": "Total active projects"},
          "amplification_weight": {"type": "number", "description": "1×/5×/10× signal strength"},
          "is_new_cross_project": {"type": "boolean", "description": "First time seen across multiple projects"},
          "root_cause_hypothesis": {"type": "string"}
        },
        "required": ["pattern", "projects_affected", "frequency", "amplification_weight"]
      },
      "maxItems": 10
    },
    "quality_variance": {
      "type": "object",
      "properties": {
        "metric": {"type": "string", "description": "e.g., 'comments_per_pr'"},
        "by_project": {"type": "object", "description": "Project → value mapping"},
        "variance": {"type": "number", "description": "Standard deviation across projects"},
        "direction": {"type": "string", "enum": ["converging", "stable", "diverging"]},
        "concern_level": {"type": "string", "enum": ["none", "low", "medium", "high"]}
      }
    },
    "skill_effectiveness_comparison": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "skill": {"type": "string"},
          "best_performing_project": {"type": "string"},
          "worst_performing_project": {"type": "string"},
          "effectiveness_spread": {"type": "number", "description": "Max - min effectiveness"}
        }
      }
    },
    "data_sufficiency": {"type": "string", "enum": ["sufficient", "marginal", "insufficient"]}
  },
  "required": ["cross_project_patterns", "data_sufficiency"]
}
```

### 6.2 Agent 2: Factory Optimizer (A/B Runner)

| Field | Value |
|-------|-------|
| **Agent name** | `factory-optimizer` |
| **Schedule** | Biweekly 1st and 16th at 03:23 local (`23 3 1,16 * *`) |
| **Banks touched** | Both factory banks |
| **Budget** | `mid` |
| **Reflect calls per run** | 2 |
| **Estimated tokens/run** | 12,000–18,000 |

**Orthogonal question**: "Is the factory process itself improving across all projects, and which interventions actually work?"

**Execution sequence**:

```
Step 1: Reflect on factory-meta (experiment results + trajectory)
Step 2: Reflect on factory-product (intervention library + transfer records)
Step 3: Evaluate active experiments, propose new ones
Step 4: Retain findings
```

**What it does differently from project-level Meta-Optimizer**:
- Evaluates interventions across the portfolio, not just one project
- Runs and evaluates A/B experiments (Section 8)
- Tracks transfer learning success rates (Section 9)
- Identifies the single highest-leverage factory-wide improvement

**Response schema** (`FACTORY_OPTIMIZER_SCHEMA`):

```json
{
  "type": "object",
  "properties": {
    "portfolio_trajectory": {
      "type": "object",
      "properties": {
        "direction": {"type": "string", "enum": ["improving", "stable", "degrading"]},
        "rate": {"type": "string", "enum": ["accelerating", "linear", "decelerating", "flat"]},
        "evidence": {"type": "string"}
      }
    },
    "active_experiments": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "hypothesis": {"type": "string"},
          "treatment_project": {"type": "string"},
          "control_project": {"type": "string"},
          "status": {"type": "string", "enum": ["running", "evaluation_due", "concluded"]},
          "preliminary_result": {"type": "string", "enum": ["positive", "neutral", "negative", "too_early"]}
        }
      }
    },
    "completed_experiments": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "hypothesis": {"type": "string"},
          "result": {"type": "string", "enum": ["success", "failure", "inconclusive"]},
          "effect_size": {"type": "string", "description": "e.g., '-35% CodeRabbit security comments'"},
          "promoted_to_factory_wide": {"type": "boolean"},
          "transfer_success_rate": {"type": "number", "description": "Success rate when applied to other projects"}
        }
      }
    },
    "next_experiment_recommendation": {
      "type": "object",
      "properties": {
        "hypothesis": {"type": "string"},
        "rationale": {"type": "string"},
        "treatment_project": {"type": "string"},
        "control_project": {"type": "string"},
        "measurement_dimension": {"type": "string"},
        "expected_duration_weeks": {"type": "integer"}
      }
    },
    "data_sufficiency": {"type": "string", "enum": ["sufficient", "marginal", "insufficient"]}
  },
  "required": ["portfolio_trajectory", "data_sufficiency"]
}
```

### 6.3 Agent 3: Portfolio Review Harvester

| Field | Value |
|-------|-------|
| **Agent name** | `portfolio-review-harvester` |
| **Schedule** | Every 3 days at 02:31 local (`31 2 */3 * *`) |
| **Banks touched** | `factory-meta` (primary), `factory-product` (for antipatterns) |
| **Budget** | `mid` |
| **Reflect calls per run** | 1 |
| **External API calls** | `gh` CLI for each project repo |
| **Estimated tokens/run** | 10,000–15,000 |

**Orthogonal question**: "How does the factory's output look to external reviewers, aggregated across all projects?"

**What it does differently from project-level Review Harvester**:
- Pulls CodeRabbit reviews from ALL project repos, not just one
- Computes portfolio-wide metrics (comments-per-PR, severity distribution, variance)
- Identifies cross-project patterns (same issue in multiple repos)
- Serves as the measurement instrument for A/B experiments

**Execution sequence**:

```bash
# Step 1: For each active project, fetch recent merged PRs
for repo in $FACTORY_PROJECTS; do
  gh pr list --repo "$repo" --state merged --limit 10 \
    --json number,title,mergedAt --jq '.[] | select((.mergedAt | fromdate) > (now - 259200)) | .number'
done

# Step 2: For each PR, fetch CodeRabbit/Gemini comments
# (same as project-level Review Harvester, but across all repos)
```

**Response schema** (`PORTFOLIO_REVIEW_SCHEMA`):

```json
{
  "type": "object",
  "properties": {
    "portfolio_summary": {
      "type": "object",
      "properties": {
        "total_prs_analyzed": {"type": "integer"},
        "total_comments": {"type": "integer"},
        "projects_with_reviews": {"type": "integer"},
        "comments_per_pr_by_project": {
          "type": "object",
          "description": "Project → average comments per PR"
        },
        "portfolio_avg_comments_per_pr": {"type": "number"},
        "portfolio_variance": {"type": "number", "description": "Std dev of comments/PR across projects"}
      }
    },
    "cross_project_patterns": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "pattern": {"type": "string"},
          "category": {"type": "string"},
          "severity": {"type": "string"},
          "projects_affected": {"type": "array", "items": {"type": "string"}},
          "is_new_cross_project": {"type": "boolean"},
          "trend": {"type": "string", "enum": ["new", "persistent", "declining", "resolved"]}
        }
      }
    },
    "portfolio_quality_trend": {
      "type": "object",
      "properties": {
        "direction": {"type": "string", "enum": ["improving", "stable", "degrading"]},
        "variance_direction": {"type": "string", "enum": ["converging", "stable", "diverging"]},
        "evidence": {"type": "string"}
      }
    },
    "data_sufficiency": {"type": "string", "enum": ["sufficient", "marginal", "insufficient"]}
  },
  "required": ["portfolio_summary", "data_sufficiency"]
}
```

### 6.4 Agent 4: Factory Blind Spot Detector

| Field | Value |
|-------|-------|
| **Agent name** | `factory-blind-spot` |
| **Schedule** | Monthly 1st at 03:07 local (`7 3 1 * *`) |
| **Banks touched** | Both factory banks |
| **Budget** | `mid` |
| **Reflect calls per run** | 2 |
| **Estimated tokens/run** | 10,000–12,000 |

**Orthogonal question**: "What should the factory know about its portfolio but doesn't?"

**What it does differently from project-level Blind Spot Detector**:
- Detects projects with no recent review data (silenced quality signal)
- Finds quality dimensions never measured in any project
- Identifies skills never exercised across the entire portfolio
- Discovers project types for which the factory has no antipattern coverage

**Response schema** (`FACTORY_BLIND_SPOT_SCHEMA`):

```json
{
  "type": "object",
  "properties": {
    "unmeasured_projects": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "project": {"type": "string"},
          "last_review_data": {"type": "string"},
          "days_silent": {"type": "integer"},
          "concern": {"type": "string", "enum": ["no-recent-prs", "no-review-comments", "no-review-tool-active", "no-agent-runs"]}
        }
      }
    },
    "coverage_gaps": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "gap_type": {"type": "string", "enum": ["quality_dimension", "skill_type", "project_type", "antipattern_category"]},
          "description": {"type": "string"},
          "affected_projects": {"type": "integer"}
        }
      }
    },
    "data_sufficiency": {"type": "string", "enum": ["sufficient", "marginal", "insufficient"]}
  },
  "required": ["coverage_gaps", "data_sufficiency"]
}
```

**Selection-time instrumentation gate**: The Factory Optimizer relies on this detector's findings during project selection for A/B experiments (Section 8.3 Step 2). Projects flagged with `no-review-comments` or `no-review-tool-active` are automatically excluded from treatment/control candidate lists — experiments cannot proceed without an active measurement instrument. The `unmeasured_projects` concern types are checked at selection-time, not just during this monthly run.

---

## 7. Cross-Project Pattern Amplification

### 7.1 Signal Strength Model

The factory tier's core value proposition: patterns that span multiple projects get amplified priority proportional to how many projects exhibit them.

| Pattern seen in... | Signal weight | Interpretation | Action level |
|-------------------|---------------|----------------|--------------|
| 1 of N projects | 1× (baseline) | Project-specific issue | Project-level fix (existing QDS-MEM-001 agents) |
| 2 of N projects | 5× | Emerging cross-project weakness | Investigate at factory level |
| 3+ of N projects | 10× | Factory-level skill gap | Fix the factory skill/prompt/directive |

**Amplification formula**:

```
weight = 1                              if projects_affected == 1
weight = 5 * (projects_affected - 1)    if projects_affected == 2
weight = 10 * (projects_affected - 1)   if projects_affected >= 3
```

### 7.2 Amplification in Practice

```
Timeline:
  Week 1: CodeRabbit flags "missing input validation on API endpoints" in Project A
          → Project-level Review Harvester catches it → 1× weight → project fix

  Week 3: Same pattern appears in Project B
          → Cross-Project Synthesizer detects: 2/4 projects, 5× weight
          → Factory Optimizer proposes investigation
          → Root cause: "bmad-dev-story skill doesn't include input validation checklist"

  Week 4: Factory Optimizer runs A/B experiment:
          → Project C gets updated skill (treatment)
          → Project D continues unchanged (control)
          → Measurement: CodeRabbit input validation comments

  Week 6: Project C shows -40% validation comments vs Project D
          → Experiment result: success
          → Promoted to factory-wide directive
          → All projects now benefit from the fix

  Week 8: Portfolio Review Harvester confirms:
          → Validation pattern now "resolved" across all active projects
```

This loop takes ~8 weeks from first detection to factory-wide resolution. Without the factory tier, each project would independently discover and fix the same issue — or more likely, never fix it at all.

---

## 8. A/B Testing Protocol

### 8.1 Why Natural A/B Works

Multiple projects provide natural treatment and control groups. The factory doesn't need a separate testing framework — it uses the portfolio as the experiment population.

**Critical requirement**: CodeRabbit (or equivalent) must be active on ALL projects. CodeRabbit is the measurement instrument — consistent reviewer, same standards, every PR. Without it on all projects, there's no controlled comparison. Projects without active review coverage are automatically excluded during experiment project selection (Section 8.3 Step 2) based on Factory Blind Spot Detector findings.

### 8.2 Experiment Lifecycle

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  HYPOTHESIS  │───▶│   ROLL OUT   │───▶│   MEASURE    │───▶│   DECIDE     │
│  Formation   │    │   Treatment  │    │   Period     │    │   & Retain   │
│  (Optimizer) │    │   to 1 proj  │    │   2-4 weeks  │    │              │
└──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
       │                   │                   │                    │
       │                   │                   │                    │
  Synthesizer        Directive added     Portfolio Review      Promote to
  identifies         to treatment        Harvester measures    factory-wide
  cross-project      project's bank      CodeRabbit delta      or revert
  pattern            only                treatment vs control
```

### 8.3 Step-by-Step Protocol

**Step 1 — Hypothesis Formation** (Factory Optimizer):

The Factory Optimizer identifies a candidate intervention from cross-project analysis:

```
hypothesis: "Adding security checklist to bmad-dev-story skill
             reduces CodeRabbit security findings by ≥30%"
source_pattern: "Missing input validation flagged in 3 of 4 projects"
treatment: "Add security:input-validation directive to treatment project's qds-product"
measurement: "CodeRabbit security-category comment count per PR"
```

**Step 2 — Project Selection**:

```python
# Pre-verification: Exclude projects without active review coverage
# (CodeRabbit or equivalent MUST be active — it is the measurement instrument)
eligible = filter_projects(
    require="active_review_coverage",
    # Checked against Factory Blind Spot Detector findings:
    # projects flagged with concern "no-review-comments" or
    # "no-review-tool-active" are excluded
    source="factory-blind-spot-detector-findings"
)

# Select treatment and control from eligible projects only
treatment = select_project(
    pool=eligible,
    criteria=["similar_tech_stack", "active_development", "no_existing_directive"],
    prefer="highest_current_issue_count"  # Maximize signal
)

control = select_project(
    pool=eligible,
    criteria=["similar_tech_stack", "active_development", "no_existing_directive"],
    prefer="closest_match_to_treatment"
)
```

Projects must have:
- **Active review coverage** (CodeRabbit or equivalent — gating requirement; projects without it are excluded from candidate lists with a reasoned rejection logged in factory-meta)
- Similar tech stacks (fair comparison)
- Active development (enough PRs to measure)
- No pre-existing directive for the intervention (clean experiment)

**Step 3 — Implementation**:

Add the directive to the treatment project's `qds-product` bank:

```python
client.retain(
    bank_id="qds-product-TREATMENT",
    items=[{
        "content": json.dumps({
            "directive": "Always validate external input at API boundaries...",
            "source": "factory-experiment",
            "experiment_id": f"exp-{slug}"
        }),
        "tags": ["knowledge_type:directive", "quality_dim:security", "experiment:active"],
        "document_id": f"exp-{slug}-directive"
    }]
)
```

Control project's bank is not modified.

**Step 4 — Measurement** (Portfolio Review Harvester):

Over the next 2–4 weeks, the Portfolio Review Harvester's tri-daily runs accumulate CodeRabbit data for both projects. The Factory Optimizer's biweekly run evaluates:

```python
treatment_security_comments = get_coderabbit_comments(
    project=treatment,
    category="security",
    since=experiment_start
)
control_security_comments = get_coderabbit_comments(
    project=control,
    category="security",
    since=experiment_start
)

effect_size = (treatment_security_comments.per_pr - control_security_comments.per_pr) / control_security_comments.per_pr if control_security_comments.per_pr > 0 else 0.0
```

**Step 5 — Decision**:

| Result | Effect Size | Action |
|--------|-------------|--------|
| Success | ≥30% improvement | Promote directive to factory-wide → all projects |
| Neutral | -5% to +30% | Extend measurement period or declare inconclusive |
| Negative | >5% degradation | Revert immediately, document as failed experiment |

**Step 6 — Retention**:

```python
client.retain(
    bank_id="factory-meta",
    items=[{
        "content": json.dumps({
            "experiment_id": f"exp-{slug}",
            "hypothesis": hypothesis,
            "treatment_project": treatment,
            "control_project": control,
            "result": "success",
            "effect_size": effect_size,
            "promoted_to_factory_wide": True,
            "measurement_period_weeks": 4,
            "coderabbit_delta": treatment_security_comments.per_pr - control_security_comments.per_pr
        }),
        "tags": ["experiment_status:completed-success", f"quality_dim:security"],
        "document_id": f"exp-{slug}-result"
    }]
)
```

### 8.4 Experiment Constraints

| Constraint | Value | Rationale |
|-----------|-------|-----------|
| Max concurrent experiments | 2 | Avoid confounding variables |
| Min measurement period | 2 weeks | Need enough PRs for statistical relevance |
| Max measurement period | 6 weeks | Stale experiments waste opportunity |
| Min PRs per project during experiment | 3 | Minimum sample size |
| Rollback trigger | Any degradation >10% | Safety first |

---

## 9. Transfer Learning

### 9.1 Mechanism

When an intervention succeeds in one project, the factory evaluates whether to **proactively propose** it for similar projects — without waiting for a formal A/B experiment.

```
┌─────────────────┐    ┌───────────────┐    ┌─────────────────┐
│  INTERVENTION   │───▶│  SIMILARITY   │───▶│  PROPOSAL       │
│  succeeds in    │    │  scoring      │    │  to similar     │
│  Project A      │    │  against all  │    │  projects       │
│                 │    │  other projs  │    │  (not imposed)  │
└─────────────────┘    └───────────────┘    └─────────────────┘
```

### 9.2 Project Similarity Dimensions

| Dimension | Weight | Example |
|-----------|--------|---------|
| Tech stack overlap | 40% | Both use React + TypeScript + PostgreSQL |
| Module structure similarity | 25% | Both have API layer + data layer + UI layer |
| Charter overlap | 20% | Both prioritize security and correctness |
| Quality profile similarity | 15% | Both have similar CodeRabbit severity distributions |

**Similarity score**: `Σ(dimension_score × weight)`, where each dimension score is 0–1.

### 9.3 Transfer Protocol

1. **Trigger**: Factory Optimizer records a successful intervention (experiment result: `completed-success`)
2. **Similarity scoring**: Score all other active projects against the source project
3. **Threshold**: Propose transfer for projects with similarity ≥ 0.7
4. **Proposal**: Add a `transfer-proposal` observation to the target project's `qds-meta` bank:

```python
client.retain(
    bank_id=f"qds-meta-{target_project}",
    items=[{
        "content": json.dumps({
            "type": "factory_transfer_proposal",
            "source_project": source_project,
            "intervention": intervention_description,
            "evidence": f"Experiment showed {effect_size} improvement in {source_project}",
            "similarity_score": similarity,
            "status": "proposed",
            "auto_applied": False  # Projects must explicitly accept
        }),
        "tags": ["knowledge_type:transfer-proposal", "outcome:pending"],
        "document_id": f"transfer-{source_project}-{target_project}-{slug}"
    }]
)
```

5. **Tracking**: The Factory Optimizer's next run checks whether transfer proposals were accepted, and whether the intervention improved the target project's CodeRabbit metrics.

### 9.4 Transfer Success Metrics

| Metric | Target |
|--------|--------|
| Transfer proposal acceptance rate | ≥60% |
| Transfer effectiveness rate (accepted proposals that improve metrics) | ≥50% |
| Time from proposal to acceptance | ≤2 weeks |
| False positive rate (proposals that degrade quality) | <10% |

Over time, the factory learns which intervention types transfer well:
- Security directives tend to transfer well across similar tech stacks
- Performance patterns are often project-specific (different workloads)
- Testing patterns transfer well within project types (web-app → web-app)

---

## 10. Portfolio Health & Variance

### 10.1 The Variance Principle

A healthy factory produces **consistent** quality. The target is not just low average CodeRabbit comments per PR — it's low average AND low variance.

```
UNHEALTHY FACTORY:
  Project A: 2 comments/PR  ██████
  Project B: 3 comments/PR  █████████
  Project C: 15 comments/PR ████████████████████████████████████████████████
  Average: 6.7 comments/PR
  Variance: HIGH ← Some projects benefit from factory learnings, others don't

HEALTHY FACTORY:
  Project A: 2 comments/PR  ██████
  Project B: 3 comments/PR  █████████
  Project C: 2 comments/PR  ██████
  Average: 2.3 comments/PR
  Variance: LOW ← Learnings are spreading effectively
```

### 10.2 Portfolio Health KPIs

| KPI | Target | Measurement |
|-----|--------|-------------|
| Portfolio average comments/PR | Declining month-over-month | `portfolio_avg_comments_per_pr` from Portfolio Review Harvester |
| Portfolio variance (std dev) | Declining or stable-low | `portfolio_variance` from Portfolio Review Harvester |
| Coefficient of variation | <0.5 (std dev / mean < 50%) | Computed from above |
| Worst-project gap | Worst project ≤ 2× portfolio average | Per-project metrics from Review Harvester |
| Zero-signal projects | 0 projects without CodeRabbit data in last 14 days | Factory Blind Spot Detector |

### 10.3 Variance Response Protocol

When the Cross-Project Synthesizer detects `variance_direction: "diverging"`:

1. Identify the outlier project(s) driving variance
2. Check: does the outlier project have active agent runs? (If not, that's the root cause.)
3. Check: does the outlier project have recent transfer proposals that were rejected? (Learnings aren't reaching it.)
4. Factory Optimizer proposes targeted intervention for the outlier
5. If the outlier is a new project → expected, adjust baseline rather than intervene

---

## 11. Factory-to-Project Directive Flow

### 11.1 Downward Propagation

When a directive is promoted to factory-wide (A/B experiment success), it needs to reach all project banks:

```
Factory Optimizer declares: "Directive X is factory-wide"
    ↓
For each active project:
    ↓
    client.retain(
        bank_id=f"qds-product-{project}",
        items=[{
            "content": directive_content,
            "tags": ["knowledge_type:directive", "source:factory-wide", "priority:high"],
            "document_id": f"factory-directive-{directive_id}"
        }]
    )
```

This is a **one-time push** at the moment of promotion. After that, the directive lives in the project's bank and is available to all future sessions via pre-session recall.

### 11.2 Override Mechanism

Projects retain autonomy. A project can override a factory-wide directive:

```python
# Project-level override
client.retain(
    bank_id="qds-product-MY_PROJECT",
    items=[{
        "content": json.dumps({
            "overrides": f"factory-directive-{directive_id}",
            "reason": "Project uses different auth framework where this directive doesn't apply",
            "alternative": "Local validation rule for this framework instead"
        }),
        "tags": ["knowledge_type:directive-override", "source:project-local"],
        "document_id": f"override-factory-directive-{directive_id}"
    }]
)
```

Overrides are visible to the Factory Optimizer and tracked as part of transfer learning. If many projects override the same directive, it signals the directive needs rethinking, not broader enforcement.

### 11.3 New Project Bootstrapping

When a new project enters the factory:

```python
# Bootstrap: pull all factory-wide directives into new project's bank
factory_directives = client.recall(
    bank_id="factory-product",
    query="factory-wide directives",
    tags=["knowledge_type:directive", "project_scope:all-projects"],
    limit=50
)

for directive in factory_directives.observations:
    client.retain(
        bank_id=f"qds-product-{new_project}",
        items=[{
            "content": directive.content,
            "tags": directive.tags + ["source:factory-bootstrap"],
            "document_id": directive.document_id
        }]
    )
```

New projects start with the factory's accumulated learnings from day one. This is the factory tier's most direct value: **every new project begins at a higher baseline than the first project did**.

---

## 12. The Compounding Loop

### 12.1 Full Loop Diagram

```
     Project A Agents ──→ Promotion Pipeline ──→ Factory Banks
     Project B Agents ──→ Promotion Pipeline ──→ Factory Banks
     Project C Agents ──→ Promotion Pipeline ──→ Factory Banks
                                                      │
                                              Factory Agents
                                              (Synthesizer, Optimizer,
                                               Review Harvester, Blind Spot)
                                                      │
                                              ┌───────┴───────┐
                                              │               │
                                        Cross-project    A/B experiment
                                        patterns found   results evaluated
                                              │               │
                                              └───────┬───────┘
                                                      │
                                              Factory-wide directives
                                              + Transfer proposals
                                                      │
                                              ┌───────┴───────┐
                                              │               │
                                        Directive flow     Transfer
                                        to all project    proposals to
                                        qds-product       similar projects
                                        banks
                                              │               │
                                              └───────┬───────┘
                                                      │
                                              Projects implement
                                              → CodeRabbit reviews
                                              → Portfolio Review Harvester
                                                measures results
                                              → Loop repeats
```

### 12.2 Compounding Over Time

| Month | What compounds |
|-------|---------------|
| 1–2 | Factory banks accumulate promoted findings from all projects. Cross-Project Synthesizer begins detecting 2-project patterns. |
| 3–4 | First A/B experiments complete. Successful interventions promoted to factory-wide. Transfer learning begins. |
| 5–6 | Portfolio variance starts declining. New projects bootstrap with 4 months of accumulated directives. FactoryOptimizer shows `accelerating` trajectory. |
| 7–12 | Cross-project patterns are rare (most have been fixed at factory level). FactoryOptimizer focuses on marginal improvements and novel patterns. Portfolio health is consistently good. |
| 12+ | The factory is self-optimizing at a higher level: not just "are coding agents improving?" but "is our process for improving coding agents improving?" Meta-learning. |

---

## 13. Operational Surface & Cost

### 13.1 Factory Agent Schedule

| Agent | Schedule | Cron | Reflect calls/run | Runs/month |
|-------|----------|------|--------------------|------------|
| Cross-Project Synthesizer | Weekly Wed 03:11 | `11 3 * * 3` | 2 | 4–5 |
| Factory Optimizer | Biweekly 1st/16th 03:23 | `23 3 1,16 * *` | 2 | 2 |
| Portfolio Review Harvester | Every 3 days 02:31 | `31 2 */3 * *` | 1 | 10 |
| Factory Blind Spot Detector | Monthly 1st 03:07 | `7 3 1 * *` | 2 | 1 |
| **Total** | | | **~7** | **~18** |

### 13.2 Total System Cost (Project + Factory)

| Component | Reflect calls/month | Token estimate/month |
|-----------|--------------------|--------------------|
| Per-project agents (4 agents × 1 project) | 17–18 | 168–260k |
| Factory agents (4 agents) | 17–18 | 130–200k |
| **Total** | **~35** | **~300–460k** |

Scaling: Each additional project adds ~17 reflect calls/month. Factory agents stay constant regardless of project count (they read from factory banks, not project banks).

### 13.3 CronCreate Entries

```yaml
# Factory Agent 1: Cross-Project Synthesizer — Weekly Wednesday 03:11
cron: "11 3 * * 3"
recurring: true
durable: true
prompt: |
  Run the Cross-Project Synthesizer factory agent:
  1. Reflect on factory-meta bank (cross-project performance trends)
  2. Reflect on factory-product bank (cross-project antipattern clustering)
  3. Identify patterns spanning multiple projects with amplification weights
  4. Retain cross-project insights in factory banks
  See: docs/planning/hindsight-factory-tier-design.md Section 6.1

# Factory Agent 2: Factory Optimizer — Biweekly 1st/16th 03:23
cron: "23 3 1,16 * *"
recurring: true
durable: true
prompt: |
  Run the Factory Optimizer agent:
  1. Reflect on factory-meta (experiment results + trajectory)
  2. Reflect on factory-product (intervention library + transfer records)
  3. Evaluate active A/B experiments, conclude or extend
  4. Propose next experiment if capacity available
  5. Retain findings in factory banks
  See: docs/planning/hindsight-factory-tier-design.md Section 6.2

# Factory Agent 3: Portfolio Review Harvester — Every 3 days 02:31
cron: "31 2 */3 * *"
recurring: true
durable: true
prompt: |
  Run the Portfolio Review Harvester factory agent:
  1. For each active project repo, fetch recent merged PRs (last 3 days)
  2. For each PR, fetch CodeRabbit/Gemini Code Assist review comments
  3. Classify comments by severity, category, and cross-project recurrence
  4. Reflect on factory-meta for pattern correlation against prior harvests
  5. Retain cross-project patterns in factory-product
  6. Retain portfolio analysis in factory-meta
  See: docs/planning/hindsight-factory-tier-design.md Section 6.3

# Factory Agent 4: Factory Blind Spot Detector — Monthly 1st 03:07
cron: "7 3 1 * *"
recurring: true
durable: true
prompt: |
  Run the Factory Blind Spot Detector agent:
  1. Reflect on factory-meta (identify projects with no recent data)
  2. Reflect on factory-product (identify coverage gaps across portfolio)
  3. Retain gaps in factory-meta
  See: docs/planning/hindsight-factory-tier-design.md Section 6.4
```

Note: Factory agents run between 02:31–03:23 local, a window that doesn't overlap with project-level agent schedules (02:17 and 07:23). This avoids API contention between tiers.

---

## 14. Alternatives Considered & Rejected

| Alternative | Description | Why rejected |
|------------|-------------|-------------|
| **Single global bank** | One bank for all projects and factory data | Different entity labels, retention policies, and disposition profiles per domain. Also makes project-level isolation impossible. |
| **Factory agents read project banks directly** | Skip the promotion pipeline, have factory agents reflect on project banks | Couples tiers — factory agents need to know all project bank IDs. Breaks if a project bank is offline. Factory banks as the integration point is more robust. |
| **Centralized experiment framework** | Dedicated A/B testing service | Over-engineered. The Portfolio Review Harvester + CodeRabbit provides the measurement. The Factory Optimizer provides the decision-making. No additional infrastructure needed. |
| **Automatic directive imposition** | Factory-wide directives auto-applied without project consent | Violates F5 (transfer is proposed, not imposed). Project context matters — a security directive for REST APIs doesn't apply to a GraphQL project. Overrides must be possible. |
| **Per-project factory agent instances** | Each project gets its own copy of the 4 factory agents | Defeats the purpose. Factory agents exist to operate ACROSS projects. Per-project instances would produce the same results as project-level agents. |
| **Real-time cross-project alerts** | Immediate notification when a pattern appears in a second project | Over-engineered. The Portfolio Review Harvester runs every 3 days — that's fast enough for cross-project detection. Real-time alerts would require event infrastructure the factory doesn't need. |

---

## 15. Success Criteria

### 15.1 Quantitative

| Metric | Target | Measurement Source |
|--------|--------|--------------------|
| Portfolio CodeRabbit comments/PR | Declining trend month-over-month | Portfolio Review Harvester |
| Portfolio variance (std dev) | Declining or <0.5 coefficient of variation | Cross-Project Synthesizer |
| Cross-project pattern resolution rate | ≥80% of 3+ project patterns resolved within 12 weeks | Factory Optimizer experiment logs |
| A/B experiment success rate | ≥40% of experiments show measurable improvement | Factory Optimizer experiment results |
| Transfer proposal acceptance rate | ≥60% | Transfer records in factory-meta |
| Transfer effectiveness rate | ≥50% of accepted transfers improve metrics | Factory Optimizer tracking |
| New project bootstrap time | <1 day from creation to all factory directives loaded | Bootstrap execution logs |

### 15.2 Qualitative

| Signal | How to verify |
|--------|--------------|
| Cross-project patterns are rare | Synthesizer finds <3 new cross-project patterns per month by month 6 |
| New projects start strong | First PR's CodeRabbit review is comparable to mature projects |
| Portfolio quality is consistent | No project has >2× the portfolio average CodeRabbit comments |
| Experiments compound | Each successful intervention builds on prior ones |
| Transfer learning is calibrated | False positive rate (transfers that degrade quality) <10% |

### 15.3 Anti-Success Signals

| Signal | What it means |
|--------|--------------|
| Portfolio variance increasing | Learnings aren't spreading — some projects are left behind |
| A/B experiments consistently inconclusive | Measurement period too short, or CodeRabbit isn't granular enough |
| Transfer rejection rate >60% | Factory doesn't understand project differences well enough |
| Override rate >30% for factory-wide directives | Directives are too generic — need project-type scoping |
| Zero-signal projects growing | New projects aren't being onboarded into the memory system |

---

## Appendix A: Relationship to QDS-MEM-001

| Aspect | QDS-MEM-001 (Project Tier) | QDS-MEM-002 (Factory Tier) |
|--------|---------------------------|---------------------------|
| Scope | Single project/repo | All projects in factory |
| Banks per instance | 2 (qds-product, qds-meta) | 2 (factory-product, factory-meta) |
| Proactive agents | 4 per project | 4 factory-wide |
| Total CronCreate entries | 4 per project + 4 factory = 8 for 1 project | Constant at 4, regardless of project count |
| CodeRabbit scope | Single repo | All repos |
| A/B testing | Not possible (1 project) | Natural via multi-project portfolio |
| Transfer learning | N/A | Cross-project intervention proposals |
| Downstream impact | Improves one codebase | Improves factory process, elevates all projects |

## Appendix B: Scaling Model

| Projects | Project Agents | Factory Agents | Total CronCreate | Monthly Reflect Calls | Est. Monthly Tokens |
|----------|---------------|----------------|------------------|----------------------|-------------------|
| 1 | 4 | 4 | 8 | ~35 | ~300–460k |
| 3 | 12 | 4 | 16 | ~70 | ~630–960k |
| 5 | 20 | 4 | 24 | ~105 | ~960–1.5M |
| 10 | 40 | 4 | 44 | ~180 | ~1.8–2.8M |

Factory agents stay constant at 4. Per-project overhead scales linearly. The compounding benefit scales superlinearly — more projects means more signal for cross-project pattern detection.

---

*End of document. This is the canonical reference for QDS-Factory factory-tier memory system implementation. Read QDS-MEM-001 first for project-level design.*
