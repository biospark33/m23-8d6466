# Session 14 Handoff Prompt — Attractor NLSpec Integration into QDS Factory Planning Docs

**Date:** 2026-04-20
**From:** Session 14 (StrongDM Attractor gap analysis + document amendments)
**To:** New conversation for implementation readiness check or Epic 11 story implementation
**Goal:** Session 14 is complete — all 6 document amendments landed. Next session can either verify implementation readiness or begin coding.
**Primary reference:** `_bmad-output/planning-artifacts/architecture-v2-session14-amendments.md` — read this first

---

## What Session 14 Accomplished

Session 14 analyzed StrongDM's [Attractor](https://github.com/strongdm/attractor) project (3 NLSpecs for building software factories) against QDS Factory's existing architecture. Found ~70% overlap — Pi SDK, Overstory, and the planned Factory Core middleware chain already cover most of what Attractor describes. Integrated the 7 genuinely additive gaps into all planning documents with full traceability.

### Artifacts Created/Modified

| Document | Action | Content |
|----------|--------|---------|
| `_bmad-output/planning-artifacts/architecture-v2-session14-amendments.md` | **CREATED** | 5 new ADRs (036-040) + 2 amendments (ADR-019 §19.9, ADR-021 §21.6) |
| `_bmad-output/planning-artifacts/prd-amendments-session14.md` | **CREATED** | 16 new FRs (FR197-FR212) across 7 capability areas |
| `_bmad-output/implementation-artifacts/epics-and-stories.md` | **EDITED** | 3 stories in existing epics (2.10, 2.11, 4.8) + new Epic 11 with 7 stories (11.1-11.7) |
| `_bmad-output/implementation-artifacts/code-lift-manifest.md` | **EDITED** | Attractor as PATTERN_SOURCE + 10 story entries + 3 critical findings (#15-#17) |
| `_bmad-output/implementation-artifacts/code-lift-gap-analysis.md` | **EDITED** | 7 new risks (RISK-11 through RISK-17), all mitigated at open-time |
| `_bmad-output/planning-artifacts/session14-handoff-prompt.md` | **CREATED** | This file |

### Complete Inventory of New Artifacts

**ADRs (5 new + 2 amendments):**
- ADR-036: Pipeline Graph DSL (Growth)
- ADR-037: Formal Provider Adapter Contract (MVP + Growth)
- ADR-038: Cross-Provider Fallback Chains (Growth)
- ADR-039: Human Gate Nodes (Growth)
- ADR-040: Execution Environment Abstraction (Growth)
- ADR-019 amendment: Section 19.9 — Semantic Loop Detection
- ADR-021 amendment: Section 21.6 — Fidelity Modes

**FRs (16 new, FR197-FR212):**
- Pipeline Extensibility: FR197 (graph representation), FR198 (graph validation)
- Provider Resilience: FR199 (adapter contract, MVP), FR200 (runtime probing), FR201 (fallback config), FR202 (error taxonomy), FR203 (automatic failover)
- Agent Loop: FR204 (semantic loop detection, MVP), FR205 (warning injection)
- Human-in-the-Loop: FR206 (interactive approval gate), FR207 (multi-backend interface)
- Context Fidelity: FR208 (fidelity mode enum), FR209 (per-phase configuration)
- Execution Environment: FR210 (contract), FR211 (local adapter), FR212 (Docker adapter)

**Stories (10 new):**
- Epic 2: 2.10 (Provider Adapter Contract, MVP, 200 LOC), 2.11 (Fidelity Modes, Growth, 120 LOC)
- Epic 4: 4.8 (Semantic Loop Detection, MVP, 180 LOC)
- Epic 11 (new): 11.1 (Graph Parser, 350 LOC), 11.2 (Graph Template, 250 LOC), 11.3 (Fallback Chains, 350 LOC), 11.4 (Error Taxonomy, 80 LOC), 11.5 (Human Gates, 400 LOC), 11.6 (Local Env Adapter, 130 LOC), 11.7 (Docker Env Adapter, 120 LOC)

**Risks (7 new, RISK-11 through RISK-17):** All mitigated at open-time. See gap analysis for details.

### Key Decisions

1. **Attractor is PATTERN_SOURCE, not code source.** No code lifted — all implementations are new-write following QDS conventions.
2. **Only 2 MVP stories added** (2.10 at 200 LOC, 4.8 at 180 LOC). Everything else is Growth.
3. **All 10 hard invariants from ADR-033 verified compliant.** Each new ADR's acceptance criteria includes invariant compliance check.
4. **YAML graph format chosen over DOT syntax** for pipeline graph DSL — aligns with `factory.yaml` convention.
5. **Provider adapter contract wraps Pi SDK** — does not fork or replace Pi SDK types.

---

## What Session 15 Should Read First

1. `_bmad-output/planning-artifacts/architecture-v2-session14-amendments.md` — the 7 ADRs/amendments (primary deliverable)
2. `_bmad-output/planning-artifacts/prd-amendments-session14.md` — the 16 FRs
3. The new Epic 11 section in `_bmad-output/implementation-artifacts/epics-and-stories.md`
4. The session 14 section at the end of `_bmad-output/implementation-artifacts/code-lift-gap-analysis.md`

## What Session 15 Could Do

**Option A: Implementation readiness check.** Run through all 10 new stories verifying: (1) every AC is unambiguous, (2) every file path is valid, (3) every dependency is satisfied, (4) every LOC estimate is reasonable. This is the conservative path — it adds one more session of planning rigor before coding begins.

**Option B: Begin MVP implementation.** Start with Story 2.10 (Provider Adapter Contract) and Story 4.8 (Semantic Loop Detection) — the only 2 MVP stories from session 14. Both are self-contained, have clear ACs, and don't block any existing stories.

**Option C: Continue with existing Epic 1-2 implementation.** Session 14 added Growth stories and only 2 small MVP stories. If the factory's priority is shipping MVP, continue with the existing story backlog (Epic 1 foundation, Epic 2 middleware) and revisit session 14 stories later.

---

## Anti-Patterns to Avoid

- Re-evaluating the Attractor integration from scratch (session 14 already did the gap analysis; the ADRs are authoritative)
- Treating Attractor as a code source (it's NLSpecs — pattern inspiration only)
- Adding Attractor concepts beyond the 7 identified gaps (the remaining ~70% overlap was explicitly validated as "already covered")
- Modifying ADR-006 (fixed pipeline ordering) or ADR-021 (middleware chain) based on Attractor's graph DSL — ADR-036 is a representation layer ON TOP, not a replacement

---

*End of session 14 handoff. The new conversation's first action is: read `architecture-v2-session14-amendments.md` end-to-end.*
