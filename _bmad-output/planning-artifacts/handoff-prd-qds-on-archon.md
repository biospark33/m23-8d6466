# Handoff: QDS on Archon PRD (BMAD Create-PRD Workflow)

**Date:** 2026-05-10
**From:** Session with Steve
**To:** Next agent / next conversation
**Status:** PRD in progress — Steps 1–7 of 13 complete. Steps 8–12 remain.
**Goal:** Complete the BMAD `bmad-create-prd` workflow and produce a finalized PRD.

---

## 1. What This Is

QDS Factory on Archon is a **coding factory** that accepts development stories or epics and produces production-ready, adversarially-reviewed, evidence-backed pull requests with minimal human intervention.

**CRITICAL: This is a fork+extend of `coleam00/Archon`.** We modify Archon's source code (`packages/workflows/src/dag-executor.ts`, `dag-node.ts`) to add per-node env injection, then extend its workflow library with `qds-piv-loop.yaml`. This is NOT just composition on top of Archon — it is a maintained fork with upstream rebase strategy.

**Two-tier architecture:**
- **Tier 1:** `/qds` CC skill — handles single stories and epics (DECOMPOSE → wave executor)
- **Tier 2:** `qds-piv-loop.yaml` — 14-node Archon workflow per story (explore → plan → implement → review → QA → fix → finalize)

**Model routing:** Planning nodes (explore, create-plan, refine-plan) hit Anthropic Opus directly. All review/implement nodes route through Z.ai GLM 5.1 via per-node `env:` injection in Archon.

---

## 2. Files You Need

| File | Purpose | Action |
|---|---|---|
| `/Users/steve/QDS-Factory/_bmad-output/planning-artifacts/prd-qds-on-archon.md` | **The PRD being written** | Read fully, append remaining sections |
| `/Users/steve/QDS-Factory/_bmad-output/planning-artifacts/prd.md` | Canonical PRD (same WHY, different HOW) | Reference for requirements that carry over unchanged |
| `/Users/steve/QDS-Factory/_bmad-output/planning-artifacts/qds-on-archon-design-2026-05-10.md` | Design spec | Reference for architecture decisions |
| `/Users/steve/QDS-Factory/_bmad-output/planning-artifacts/qds-on-archon-implementation-plan-2026-05-10.md` | 18-task implementation plan | Reference for scope and sequencing |
| `~/.claude/skills/bmad-create-prd/workflow.md` | BMAD PRD workflow entry point | Read to understand routing |
| `~/.claude/skills/bmad-create-prd/steps-c/step-08-scoping.md` | **NEXT STEP** | Read fully and follow |
| `~/.claude/skills/bmad-create-prd/templates/prd-template.md` | PRD template | Reference for structure |
| `/Users/steve/archon/.archon/workflows/defaults/archon-piv-loop.yaml` | Base workflow we fork from | Reference for node structure and patterns |
| `/Users/steve/archon/packages/workflows/src/dag-executor.ts` | Archon executor (modification target) | Reference for env injection context |
| `/Users/steve/archon/packages/workflows/src/schemas/dag-node.ts` | Archon node schema (modification target) | Reference for schema extension context |

---

## 3. What Has Been Completed

The BMAD `bmad-create-prd` workflow uses step-file architecture. The following steps are **complete** and their content is already in the PRD:

| Step | Status | Content in PRD |
|---|---|---|
| step-01-init | ✅ Done | Frontmatter initialized, input documents loaded |
| step-02-discovery | ✅ Done | Classification (project type, domain, complexity, strategic approach) |
| step-02b-vision | ✅ Done | Vision and differentiator validated |
| step-02c-executive-summary | ✅ Done | Executive Summary + Project Classification sections |
| step-03-success | ✅ Done | Success Criteria (User/Business/Technical/Measurable) + Product Scope (MVP/Growth/Vision) |
| step-04-journeys | ✅ Done | 5 user journeys + requirements summary + elicitation-enhanced gap analysis |
| step-05-domain | ✅ Done | Domain-Specific Requirements (AI constraints, model runtime, workflow integrity, operational safety, data integrity) |
| step-06-innovation | ✅ Done | Innovation & Novel Patterns (5 areas, validation approach, risk mitigation, competitive moat) |
| step-07-project-type | ✅ Done | Project-Type Specific Requirements — **enhanced via Advanced Elicitation** (Failure Mode Analysis + First Principles Analysis). Includes fork boundary strategy, actual Archon code analysis, env syntax discrepancy finding, failure tolerance specifications, minimal patch contract, multi-developer limitations, model quality validation gate |

**Key decisions already made:**
- **Fork+extend** of `coleam00/Archon`, not just composition. Modifications: `dag-executor.ts` + `dag-node.ts` (~40 LOC total). Upstreamable design.
- **Per-node env injection** as the model routing primitive. Critical finding: `expandEnvVarsInRecord` uses `$VAR_NAME` syntax, NOT `${VAR_NAME}`. YAML syntax or expansion function must be fixed during implementation.
- **File-based state** (`plan.json`) — crash-safe, resumable. **Limitation:** NOT safe for concurrent writes. Single-writer-per-epic for MVP.
- **Z.ai GLM 5.1** for all review/implement nodes; Anthropic Opus for planning nodes only. Economic viability depends on this routing working.
- **14-node PIV loop** with dual code-review waves and parallel fix agents. Minimum viable would be 8 nodes; 14 is justified by GLM 5.1 cost optimization.
- **Self-learning layer**: pattern library, dep graph calibration, hotspot detection, nightly wiki agent
- **Minimal Patch Contract:** Fork modifies exactly 4 files in `packages/workflows/src/` totaling ≤50 LOC. Any deviation requires ADR justification.
- **Model Quality Validation Gate:** A/B test (GLM 5.1 vs Anthropic) required before MVP sign-off. Threshold: if GLM fix-wave count > 2× Anthropic, route implement back to Anthropic.

---

## 4. What Remains

**Remaining steps (in order):**

1. **step-08-scoping.md** — Scoping & Phased Development. Detailed capability lists, composable pipeline architecture, risk analysis.
2. **step-09-functional.md** — Functional Requirements. Feature requirements, user-facing capabilities, system behaviors.
3. **step-10-nonfunctional.md** — Non-Functional Requirements. Performance, security, reliability, scalability.
4. **step-11-polish.md** — Polish & Refinement. Editorial review, consistency check, cross-reference validation.
5. **step-12-complete.md** — Completion. Final packaging, sign-off, next steps.

**Workflow rules (NON-NEGOTIABLE):**
- Read each step file **completely** before executing
- Never skip steps or optimize the sequence
- Always update `stepsCompleted` in frontmatter before proceeding to next step
- Always halt at menus and wait for user input (Steve selects `C` to continue)
- Append content to the PRD document — never treat displayed text as saved

---

## 5. User Preferences & Context

**User:** Steve
**Communication style:** Direct, efficient, no fluff. Steve says "LFG" when he wants to move fast.
**Key principle:** Same WHY, different HOW. The canonical PRD (`prd.md`) is the source of truth for requirements. This PRD adapts them for the Archon pivot.
**Decision pattern:** Steve accepts well-reasoned defaults. He selected `A` (Advanced Elicitation) for step-07 to stress-test the project-type requirements with Failure Mode + First Principles analysis, then accepted the enhanced output.
**Scope:** MVP = 18 tasks (Tasks 1–18 in the implementation plan). Growth and Vision are post-MVP.
**Technical depth:** Steve is highly technical. He expects actual code references, file paths, and real Archon codebase intelligence in the PRD. He explicitly asked to use gitnexus to understand the Archon codebase.
**Quality bar:** "Full enterprise grade rigor. No shortcuts." Every claim must be backed by evidence or explicitly marked as assumption requiring validation.

---

## 6. How to Pick This Up

### Immediate Next Action

```
1. Read this handoff file fully
2. Read ~/.claude/skills/bmad-create-prd/workflow.md
3. Read ~/.claude/skills/bmad-create-prd/steps-c/step-08-scoping.md fully
4. Read /Users/steve/QDS-Factory/_bmad-output/planning-artifacts/prd-qds-on-archon.md fully
5. Follow step-08-scoping.md instructions exactly
```

### Frontmatter Update Protocol

Before loading each new step file, update the PRD frontmatter:
- Add the just-completed step name to `stepsCompleted`
- Example: after completing step-08-scoping, add `- step-08-scoping` to the list

### Content Generation Strategy

For efficiency (Steve prefers speed):
- Leverage the canonical PRD (`prd.md`) as the primary requirements source
- Adapt content for Archon context rather than reinventing
- Present drafts for review, but keep them tight and actionable
- When presenting the A/P/C menu, default to recommending `C` (Continue) unless there's a genuine open question

### Special Considerations

- **Fork+extend is the framing**, not just "using Archon." Every section should acknowledge the fork boundary and upstream maintenance strategy.
- **Per-node env injection** is the key technical differentiator — reference it in relevant sections
- **Cost optimization** is a core theme (~$0.02/story quality pipeline) — reinforce in NFRs and scoping
- **Self-learning/compounding quality** is a competitive moat — emphasize in scoping and functional requirements
- **Crash-safe state** (plan.json, worktrees, file-based) is a reliability pillar — emphasize in NFRs
- **The `${VAR}` vs `$VAR` syntax discrepancy** is a known issue that must be tracked — mention in implementation considerations
- **The minimal patch contract (≤50 LOC)** is a constraint — any architectural suggestion that requires more Archon modification must flag this

---

## 7. Quick Reference: PRD Structure So Far

```
prd-qds-on-archon.md (697 lines, ~40KB)
├── Frontmatter (stepsCompleted, inputDocuments, classification, elicitationInsights)
├── Executive Summary
│   ├── What Makes This Special
├── Project Classification
├── Success Criteria
│   ├── User Success
│   ├── Business Success
│   ├── Technical Success
│   └── Measurable Outcomes
├── Product Scope
│   ├── MVP
│   ├── Growth Features
│   └── Vision
├── User Journeys
│   ├── Journey 1: Epic success path
│   ├── Journey 2: Failure recovery
│   ├── Journey 3: Setup
│   ├── Journey 4: Learning system
│   ├── Journey 5: Emergency stop
│   ├── Journey Requirements Summary
│   └── Elicitation-Enhanced Gap Analysis
├── Domain-Specific Requirements
│   ├── AI Agent Execution Constraints
│   ├── Model Runtime & API Management
│   ├── Development Workflow Integrity
│   ├── Operational Safety
│   └── Data Integrity in Distributed Coordination
├── Innovation & Novel Patterns
│   ├── Detected Innovation Areas
│   ├── Market Context & Competitive Landscape
│   ├── Validation Approach
│   ├── Risk Mitigation
│   └── Competitive Moat Assessment
└── Project-Type Specific Requirements
    ├── Project-Type Overview
    ├── Integration Map
    ├── Technical Architecture Considerations
    │   ├── Fork Boundary & Upstream Strategy
    │   ├── Per-Node Env Injection — Actual Code Analysis
    │   ├── Workflow YAML Composition
    │   └── Git Worktree Isolation Model
    ├── Failure Mode Analysis
    │   ├── Component 1: Per-Node Env Injection
    │   ├── Component 2: 14-Node YAML Workflow
    │   ├── Component 3: Wave Executor
    │   ├── Component 4: Fork Maintenance
    │   └── Component 5: /qds Skill + Nightly Wiki
    ├── First Principles Analysis
    │   ├── Assumption 1: Fork necessity
    │   ├── Assumption 2: 14-node granularity
    │   ├── Assumption 3: File-based state sufficiency
    │   ├── Assumption 4: GLM 5.1 quality sufficiency
    │   └── Assumption 5: Hybrid architecture optimality
    ├── Source Component Migration Path
    ├── Implementation Sequencing
    └── Implementation Considerations
```

**Remaining sections to append:**
- Scoping & Phased Development
- Functional Requirements
- Non-Functional Requirements
- (Polish and completion steps handle final packaging)

---

## 8. One-Line Mission

> Complete the BMAD `bmad-create-prd` workflow for QDS on Archon by executing steps 8–12, leveraging the canonical PRD as the requirements source, adapting for the Archon-native fork+extend pivot, and producing a finalized, comprehensive PRD document with enterprise-grade rigor and zero shortcuts.

**Go time. LFG.**
