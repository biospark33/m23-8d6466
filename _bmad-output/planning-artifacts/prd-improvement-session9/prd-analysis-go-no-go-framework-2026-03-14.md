# QDS Engineer v2 — Go/No-Go Decision Framework

**Document Type:** Pre-Implementation Risk Gate & Decision Framework
**Product:** QDS Engineer v2 (AI Coding Factory Platform)
**PRD Reference:** `prd-v2.md` v2.0 (consolidated 2026-03-10)
**Framework Date:** 2026-03-14
**Authors:** Generated from PRD analysis
**Decision Authority:** Steve (Product Owner / Lead Developer) + Co-Dev Marcus

---

## Framework Purpose

This document defines the objective criteria that govern whether development proceeds, pivots, descopes, or stops at each key decision point during QDS v2 development. It answers three questions at every gate:

1. **What must be true before we proceed?**
2. **Who decides, and what evidence do they need?**
3. **What do we do if the criteria are not met?**

The framework is organized around five decision layers:
- [Gate 0: Pre-MVP-Start Gates](#gate-0-pre-mvp-start-gates) — must pass before a single story of MVP is written
- [Mid-Development Checkpoints](#mid-development-checkpoints) — 25%, 50%, 75% MVP completion
- [MVP Launch Gate](#mvp-launch-gate) — go/no-go for first production use
- [Pivot Triggers](#pivot-triggers) — conditions that force a fundamental change
- [Decision Accountability Matrix](#decision-accountability-matrix) — who decides what

---

## Gate 0: Pre-MVP-Start Gates

**Rule:** ALL three sub-gates must achieve PASS status before implementation begins on any MVP epic. A single FAIL blocks the start and triggers the specified response. A CONDITIONAL PASS proceeds with the stated constraint logged as a tracked risk.

### Gate 0-A: Pi SDK GLM-5 Availability and Cost Validation

**Purpose:** The entire economic model of QDS v2 — adversarial quality pipeline at ~3-5% of development cost — depends on Pi SDK natively routing to GLM-5 at economy-tier prices. If this assumption is false, the cost model collapses and the competitive differentiator ("quality pipeline is economically negligible") is invalidated before the first line of code is written.

**Validation Method:** Implement a standalone spike (2-4 hours) that:
1. Configures Pi SDK with factory API key
2. Sends 10 representative prompts matching QA scout and BMAD reviewer role profiles (tool calls, structured output requests, medium-length context)
3. Records: actual model served, latency per call, token cost per call, any routing errors
4. Computes projected per-story quality pipeline cost using the formula: `(avg_cost_per_call × avg_calls_per_wave × 5_waves × 2) + (avg_cost_per_call × 3_bmad_agents × 2_passes)`

| Criterion | PASS | CONDITIONAL PASS | FAIL |
|-----------|------|-----------------|------|
| GLM-5 accessible via Pi SDK economy tier | Confirmed, responses received | GLM-5 accessible but via fallback path (not native) | GLM-5 unavailable; Pi routes to a higher-cost model |
| Per-story quality pipeline cost | ≤ $0.05 per story (≤ 5% of $1.00 avg story cost) | $0.05–$0.10 per story (5–10%) | > $0.10 per story (> 10%) |
| Latency per GLM-5 call | ≤ 8 seconds per call (acceptable for background QA) | 8–15 seconds per call | > 15 seconds per call (QA swarm becomes a blocking bottleneck) |
| Pi SDK tool call support on GLM-5 | Tool calls work correctly on GLM-5 responses | Tool calls work with workaround / prompt reformatting | Tool calls not supported on GLM-5; Pi does not abstract this |
| Pi SDK native model switching verified | Pi selects GLM-5 when economy tier is declared | Pi selects GLM-5 but requires explicit model name (not tier abstraction) | Pi ignores tier directive; developer must hardcode model names |

**Gate 0-A Result Protocol:**
- **All criteria PASS:** Proceed. Log confirmed cost model baseline.
- **Any CONDITIONAL PASS, no FAILs:** Proceed with constraint. Log the conditional item as a tracked risk in the architecture doc. Architect must provide mitigation before the first story involving model tier routing.
- **Any single FAIL:** Gate 0-A FAILS. Execute the appropriate response from the table below before retesting.

| FAIL Criterion | Response Before Retesting |
|----------------|--------------------------|
| GLM-5 unavailable via Pi | Investigate Pi SDK docs for correct configuration. Test alternative economy model (Haiku, GPT-4o-mini) as a temporary stand-in. If no economy tier is available via Pi, activate Pivot Trigger PT-1 (see Section 4). |
| Cost exceeds $0.10/story | Evaluate whether reduced wave count (3 waves vs. 5) brings cost within range. Evaluate OpenRouter as fallback for cheaper GLM-5 access. If cost cannot reach ≤ $0.10, activate PT-1. |
| Latency > 15s/call | Evaluate async parallel wave execution (all 5 QA scouts fire simultaneously). If P95 wall-clock time for full QA swarm remains > 120 seconds, activate PT-1. |
| Tool calls unsupported | Redesign BMAD reviewer and QA scout prompts to work without tool calls (structured output via prompt only). Validate the redesigned prompts pass quality minimum bar. |
| Tier directive ignored | Hardcode model names per agent role in `factory.yaml` as a workaround. This is not a blocker — it removes the abstraction layer benefit but preserves functionality. Log as technical debt. |

**Decision Authority:** Steve.
**Evidence Required:** Spike output file with raw API responses, cost calculations, and latency measurements.
**Time Budget for Spike:** 1 developer-day maximum. If spike exceeds 1 day, the complexity itself is a signal.

---

### Gate 0-B: Phase Boundary Protocol Prototype Spike

**Purpose:** The Phase Boundary Protocol (PBP) is the single highest-design-risk component in the entire system. It is greenfield, novel, co-dependent with hook infrastructure, and the foundation of the adversarial quality guarantee (context isolation between development and review agents). Getting PBP wrong undermines both the adversarial quality pipeline and the learning system. The PRD explicitly calls this out: "Prototype and validate early."

**Validation Method:** Implement a minimal end-to-end spike (3-5 days) that:
1. Creates a minimal story spec (single function implementation with clear acceptance criteria)
2. Runs a simulated development phase with a real agent (Pi SDK + Overstory) that writes code and produces a phase transfer manifest
3. Fires all 6 phase boundary hook checks against the manifest and the produced code
4. Spins up a fresh BMAD review agent with ONLY the manifest contents (zero access to development agent's context)
5. Verifies the review agent can accurately identify the spec compliance status using only the manifest
6. Measures: manifest size (tokens), hook execution time, context isolation integrity

| Criterion | PASS | CONDITIONAL PASS | FAIL |
|-----------|------|-----------------|------|
| Manifest schema sufficient for BMAD | Review agent correctly identifies pass/fail spec compliance with manifest-only context | Review agent identifies pass/fail but misses nuance; requires expanding manifest schema | Review agent cannot determine spec compliance from manifest alone; requires raw code context |
| Context isolation verified | Zero references to development-phase-only artifacts (debug notes, intermediate drafts, abandoned approaches) in BMAD output | BMAD references one development-phase artifact that was correctly surfaced in manifest | BMAD exhibits knowledge of development context not in manifest (context leakage) |
| Phase boundary hooks complete | All 6 gate checks (tests, build, lint, type check, uncommitted changes, manifest valid) fire correctly and block/pass appropriately | 5 of 6 checks work; one requires minor fix post-spike | < 5 checks work OR any check silently passes when it should block |
| Hook execution time | Gate checklist completes within 60 seconds (NFR3) | 60–90 seconds | > 90 seconds (unacceptable for developer flow; transition becomes blocking) |
| Manifest token overhead | Transfer manifest consumes ≤ 800 tokens (acceptable overhead for fresh agent context) | 800–1,200 tokens (approaching limit of what's practical) | > 1,200 tokens (manifest is too heavy; approach must be redesigned) |
| Manifest completeness on failure | When phase fails (e.g., test fails), manifest correctly captures failure state for learning system | Manifest captures failure partially; supplement needed | Manifest on failure is empty or misleading |

**Gate 0-B Result Protocol:**
- **All criteria PASS:** Proceed. Phase Boundary Protocol is validated. Begin hook infrastructure implementation as Epic 1.
- **Any CONDITIONAL PASS, no FAILs:** Proceed with documented schema adjustments logged as spike findings. Architect incorporates findings before the first full story runs.
- **Any FAIL on context isolation or manifest sufficiency:** This is a HARD BLOCK. These are the core guarantees. Do not proceed until resolved. The fix must be re-spiked and re-validated.
- **Hook timing FAIL only:** Proceed but prioritize async/parallel hook execution as the first hook infrastructure story. The timing FAIL must be resolved before the first real story is attempted, not deferred.
- **Manifest token FAIL only:** Redesign manifest schema for progressive disclosure (summary by default, detail on request). Retest before proceeding.

**Decision Authority:** Steve + Marcus joint decision (this is the core technical architecture; both developers must have confidence).
**Evidence Required:** Spike output showing: the manifest file (for inspection), BMAD output annotated to show which manifest fields informed each finding, hook execution log with timing, and a written assessment of context isolation from the developer who ran the review agent.
**Time Budget for Spike:** 3–5 developer-days. This is load-bearing investment, not overhead.

---

### Gate 0-C: CopilotKit + AG-UI Integration Feasibility

**Purpose:** The Dashboard Copilot (FR105–FR119) is a significant MVP feature requiring two external libraries (CopilotKit and AG-UI) to integrate with the ZeroClaw-derived React dashboard. This is not a prototype spike — it is a feasibility confirmation. The goal is to know, before building the full dashboard, whether the integration path is straightforward or requires significant adaptation.

**Validation Method:** Implement a minimal integration test (1–2 days) that:
1. Installs CopilotKit into the ZeroClaw dashboard fork
2. Implements one `useCopilotReadable` hook exposing a single data item (e.g., active story count)
3. Implements one `useCopilotAction` hook for a single control (e.g., display a toast notification)
4. Connects an AG-UI streaming endpoint returning a simple response
5. Sends a natural language query and verifies: the readable hook data surfaces in the response, the action executes when invoked

| Criterion | PASS | CONDITIONAL PASS | FAIL |
|-----------|------|-----------------|------|
| CopilotKit installs without conflicts | No dependency conflicts with React 19 + Vite + Tailwind stack | Conflicts resolved with peer dependency overrides; no functional impact | Irreconcilable conflicts; requires React version downgrade or library fork |
| `useCopilotReadable` hook works | Dashboard state surfaces in copilot context correctly | Works but requires manual serialization workaround | Data does not surface; copilot has no access to dashboard state |
| `useCopilotAction` hook works | Action fires correctly; UI updates visibly | Action fires but requires additional event bridging | Action does not execute; AG-UI protocol not wiring correctly |
| Economy-tier model routing for copilot | GLM-5 serves copilot queries at ≤ $0.002 per query | GLM-5 serves queries but cost is $0.002–$0.005 per query | Only standard/premium model works for copilot; economy routing fails |
| AG-UI streaming latency | First response token arrives within 3 seconds (NFR8) | First token arrives 3–5 seconds | First token arrives > 5 seconds with economy model |
| Dashboard performance impact | Dashboard maintains NFR5 (30fps with 12 xterm panels) with copilot chat bar open | Dashboard drops to 25–28fps (marginal degradation) | Dashboard drops below 20fps with chat bar open (unacceptable) |

**Gate 0-C Result Protocol:**
- **All criteria PASS:** Proceed. Dashboard Copilot is MVP-viable.
- **Dependency conflicts CONDITIONAL PASS:** Proceed with override documented. Flag as fragile dependency; plan upgrade path.
- **Any FAIL on copilot feature (readable, action, streaming):** Defer Dashboard Copilot to Growth. Remove FR105–FR119 from MVP scope. Dashboard ships without conversational control plane. This is a significant UX reduction but does not affect core pipeline functionality.
- **Dashboard performance FAIL:** Investigate lazy-loading the copilot component and rendering the chat bar in a separate React subtree. If performance cannot be maintained, defer Copilot to Growth.

**Decision Authority:** Marcus (dashboard developer) with Steve sign-off.
**Evidence Required:** Screen recording demonstrating the integration working end-to-end, plus dependency tree showing no forced resolutions.
**Time Budget:** 1–2 developer-days. If integration takes longer than 2 days, the complexity is itself a signal — treat as a CONDITIONAL FAIL.

---

### Gate 0 Summary Checklist

Before committing to MVP development, record the result of each sub-gate:

| Gate | Result | Date | Decided By | Notes / Constraints Logged |
|------|--------|------|-----------|---------------------------|
| 0-A: Pi SDK GLM-5 Cost | [ ] PASS / [ ] CONDITIONAL / [ ] FAIL | | Steve | |
| 0-B: Phase Boundary Protocol | [ ] PASS / [ ] CONDITIONAL / [ ] FAIL | | Steve + Marcus | |
| 0-C: CopilotKit + AG-UI | [ ] PASS / [ ] CONDITIONAL / [ ] FAIL | | Marcus + Steve | |

**Overall Gate 0 Result:** All three sub-gates must be PASS or CONDITIONAL PASS (with constraints documented) for MVP implementation to begin.

---

## Mid-Development Checkpoints

### Checkpoint Definitions

Development completion percentage is measured against the total MVP story point estimate established at sprint 0. The three checkpoints are:

- **CP-25:** 25% of MVP stories accepted (definition of done met, merged to main)
- **CP-50:** 50% of MVP stories accepted
- **CP-75:** 75% of MVP stories accepted

At each checkpoint, the team evaluates four dimensions: velocity vs. plan, critical path health, scope integrity, and burn rate. Evaluation takes no more than 2 hours. The output is a written checkpoint record (markdown file in `_bmad-output/`) with results and any decisions taken.

---

### CP-25: 25% MVP Completion Checkpoint

**Context:** At 25%, the critical path (Pi SDK integration → Overstory extensions → Hook infrastructure → Phase Boundary Protocol → Superpowers consumption) should be underway. The parallel track (Dashboard shell → Mulch extensions → Learning system) should be starting. The Phase Boundary Protocol spike findings are integrated.

**Velocity Gate:**

| Metric | GREEN | YELLOW | RED |
|--------|-------|--------|-----|
| Stories accepted vs. planned at 25% | ≥ 90% of planned stories | 75–90% of planned stories | < 75% of planned stories |
| Stories blocked > 5 days without progress | 0 | 1 | ≥ 2 |
| Phase Boundary Protocol (Item 4 on critical path) started | Yes, with spike findings applied | Started but spike findings not yet applied | Not started |
| Critical path (items 1–5) on schedule | All 5 items on schedule or ahead | 1 item behind ≤ 1 week | Any item behind > 1 week, or 2+ items behind |

**Burn Rate Gate (CP-25):**

| Metric | GREEN | YELLOW | RED |
|--------|-------|--------|-----|
| Actual developer-hours at 25% vs. estimate | ≤ 115% of projected hours | 115–135% of projected hours | > 135% of projected hours |
| Any single story that took > 3x its estimate | 0 | 1 (with root cause documented) | ≥ 2 |
| Unplanned scope added since Gate 0 | 0 story points added | ≤ 5% added (minor clarifications) | > 5% added (scope creep) |

**Scope Deferral Candidates at CP-25:**

If velocity or burn rate is YELLOW or RED, the following FRs are the first candidates for deferral to Growth. They are ordered by deferral priority (defer item 1 first, item 4 last):

| Priority | FR(s) | Feature | Deferral Impact | Trigger Threshold |
|----------|-------|---------|----------------|-------------------|
| 1 | FR105–FR119 | Dashboard Copilot (CopilotKit + AG-UI) | UX reduction; dashboard operates without conversational layer | Any RED at CP-25, OR burn rate YELLOW + velocity YELLOW |
| 2 | FR77–FR89 | Meta-Optimization (daily + weekly cron observers) | Factory self-improvement deferred; manual analysis only | Velocity RED, OR 2 stories on meta-optimization blocked > 5 days |
| 3 | FR120–FR129 | Telegram Developer Communication Layer | Notification via dashboard only; no mobile alerts | Burn rate RED, OR meta-optimization already deferred |
| 4 | FR164–FR168 | Self-Learning System (maintenance extraction, pattern knowledge, epic context, overlay enrichment, burden tracking) | Factory learning exists (FR55–FR63) but does not accumulate cross-story patterns beyond basic synthesis | Only if ALL of 1–3 deferred AND critical path still RED |

**Rule:** If items 1–3 are all deferred at CP-25 AND the critical path is still RED, escalate immediately to the Pivot Trigger evaluation rather than deferring item 4. The Self-Learning System (FR164–FR168) is a core innovation, not a polish feature.

**CP-25 Decision Protocol:**

| Checkpoint Status | Action |
|------------------|--------|
| All GREEN | Proceed. No scope changes. |
| Any YELLOW, no RED | Document the yellow item. Monitor closely. No scope changes yet. |
| Velocity RED OR burn rate RED | Convene deferral conversation. Execute deferral table above starting from priority 1. Document in checkpoint record. |
| Critical path RED | Immediately re-assess architecture. If Phase Boundary Protocol or Hook Infrastructure is the blocker, this is a design risk realization — escalate to Pivot Trigger PT-2 evaluation. |
| Multiple RED | Convene within 24 hours. Apply deferral table. If deferral does not bring the plan to YELLOW or better within 1 sprint, activate Pivot Trigger PT-3. |

**Decision Authority:** Steve.
**Evidence Required:** Sprint velocity chart, story acceptance log, hours log, written root cause for any RED items.

---

### CP-50: 50% MVP Completion Checkpoint

**Context:** At 50%, the critical path should be fully complete or nearly complete (Phase Boundary Protocol + Superpowers consumption done). The dashboard shell should be functional. The Factory Learning System basics (FR55–FR63) should be underway. The first end-to-end story should be runnable through the factory, even if the dashboard is minimal.

**The CP-50 "Factory Smoke Test":** Before formal metrics review, run one complete story through the factory end-to-end. This is the most honest signal of development health. If a story cannot complete even one pipeline pass at 50% completion, the system has integration issues that metrics alone will not reveal.

| Smoke Test Result | Weight in CP-50 Decision |
|------------------|--------------------------|
| Story completes all 5 phases, PR created | GREEN — proceed to metrics review with confidence |
| Story completes develop + BMAD but fails QA or PR | YELLOW — proceed to metrics review; flag integration gaps |
| Story completes develop phase only | RED — metrics review secondary; integration is the primary problem |
| Story cannot complete develop phase | CRITICAL — stop metrics review; convene root cause session |

**Velocity Gate:**

| Metric | GREEN | YELLOW | RED |
|--------|-------|--------|-----|
| Stories accepted vs. planned at 50% | ≥ 90% of planned stories | 75–90% | < 75% |
| Critical path items (1–5) complete | All 5 complete | 4 of 5 complete | < 4 complete |
| Phase Boundary Protocol working end-to-end | Yes (smoke test passed phases 1–3) | Partially (phases 1–2 work, phase 3 partial) | Not working |
| Dashboard shell serving (Factory Overview + Agent Windows) | Yes | Shell serves but Agent Windows not yet functional | Dashboard not serving |

**Burn Rate Gate (CP-50):**

| Metric | GREEN | YELLOW | RED |
|--------|-------|--------|-----|
| Cumulative hours at 50% vs. estimate | ≤ 120% of projected hours | 120–150% | > 150% |
| Projected hours to completion (extrapolated) | ≤ 120% of original estimate | 120–160% | > 160% |
| Per-story quality pipeline cost (from actual story runs) | ≤ $0.05/story | $0.05–$0.10/story | > $0.10/story |
| Any individual FR that has been re-estimated upward > 3x | 0 | 1 (with revised estimate documented) | ≥ 2 |

**Quality Gate (new at CP-50 — requires actual data):**

Once the smoke test story has run, evaluate actual pipeline behavior:

| Metric | GREEN | YELLOW | RED |
|--------|-------|--------|-----|
| BMAD context isolation verified (zero context leakage in smoke test) | Yes | Leakage in 1 non-critical area | Any structural leakage detected |
| Phase boundary hook execution time (from smoke test) | ≤ 60 seconds (NFR3) | 60–90 seconds | > 90 seconds |
| Overlay composition time (from smoke test) | ≤ 500ms (NFR4) | 500ms–1s | > 1 second |

**Scope Deferral Candidates at CP-50:**

If burn rate exceeds 150% or multiple RED metrics exist, apply the deferral table from CP-25 first. If items were already deferred at CP-25, evaluate the following additional candidates:

| Priority | FR(s) | Feature | Deferral Impact | Trigger Threshold |
|----------|-------|---------|----------------|-------------------|
| 5 | FR91–FR104 (subset) | Resilience & Integrity polish: FR92 (file contention detection), FR98 (learning retention), FR100 (drift monitoring), FR102 (BMAD profiles) | Resilience reduced; MVP operates without these guardrails | Burn rate > 150% AND velocity RED |
| 6 | FR130–FR132 | Agent Performance Data Collection (action scoring, calibration, session composites) | Growth behavioral system (ELO, tiers) loses its data foundation; Growth delay increases | ONLY if items 1–5 deferred AND still RED |

**Rule:** FR130–FR132 deferral is a last resort. These are ~500 LOC of data collection infrastructure. Their deferral cost is high because every week without them delays Growth readiness by an equivalent amount.

**CP-50 Decision Protocol:**

| Checkpoint Status | Action |
|------------------|--------|
| Smoke test CRITICAL | Stop. Convene root cause session. Do not proceed to metrics. The architecture has a fundamental integration problem. |
| Smoke test passes + all GREEN | Proceed with confidence. |
| Smoke test YELLOW + any metrics RED | Apply deferral table (items 1–4 first). Smoke test YELLOW is acceptable at 50% if the integration path is clear. |
| Burn rate > 150% | Full deferral review. Apply deferral table from CP-25 first. Compute revised completion date. If revised date makes MVP launch > 6 weeks from CP-50, evaluate PT-3. |
| Quality gate RED on context isolation | Do not defer. This is a core guarantee. Resolve before proceeding. |

**Decision Authority:** Steve + Marcus joint decision.
**Evidence Required:** Smoke test output (story run log with cost and timing data), sprint velocity chart, cumulative hours log, revised completion estimate.

---

### CP-75: 75% MVP Completion Checkpoint

**Context:** At 75%, the end-to-end pipeline is working. The dashboard is functional. The Factory Learning System basics are in place. The final 25% is polish, edge cases, error recovery, and the developer operations story (setup script, per-developer config). This checkpoint's primary purpose is launch readiness assessment rather than scope management.

**Launch Readiness Assessment:**

The CP-75 checkpoint answers the question: "Can we set a firm MVP launch date?" The answer is based on:

| Factor | GREEN (set date) | YELLOW (set provisional date) | RED (do not set date yet) |
|--------|-----------------|-------------------------------|--------------------------|
| End-to-end story runs reliably | ≥ 3 of 3 test stories complete without manual intervention | 2 of 3 complete; 1 required intervention | < 2 complete reliably |
| Dashboard shows real-time agent state | Yes, SSE latency < 2s (NFR1) | Yes, latency 2–5s | Not reliable or latency > 5s |
| Multi-story parallelism works | 3 concurrent stories complete without contamination | 2 concurrent work; 3rd requires restart | Parallelism not yet functional |
| Setup script works for Marcus (co-dev) | Yes, Marcus ran it successfully on clean machine | Runs with 1–2 documented workarounds | Does not complete for Marcus |
| Per-story cost within model | ≤ $2.50 average for medium-complexity story | $2.50–$4.00 | > $4.00 (or unknown — no cost data) |

**Final Deferral Decisions at CP-75:**

Any remaining items not yet deferred must receive a SHIP or DEFER decision. Nothing enters the final 25% in ambiguous status.

| FR(s) | Feature | SHIP criteria | DEFER to Growth criteria |
|-------|---------|--------------|--------------------------|
| FR105–FR119 | Dashboard Copilot | All criteria GREEN at CP-75 and not previously deferred | Previously deferred OR any YELLOW in performance metrics |
| FR77–FR89 | Meta-Optimization | All criteria GREEN and not previously deferred | Previously deferred OR final 25% is fully allocated to pipeline polish |
| FR120–FR129 | Telegram Notifications | Implementation complete and basic end-to-end Telegram message verified | Not yet started at CP-75 |
| FR97 | SSE reconnect with state catch-up | Implemented (NFR19 requires it for launch) | Cannot defer — required for MVP launch |
| FR91 | Story spec validation at intake | Implemented | Cannot defer — prevents garbage-in pipeline launches |

**Burn Rate Gate (CP-75):**

| Metric | GREEN | YELLOW | RED |
|--------|-------|--------|-----|
| Hours remaining vs. estimate for final 25% | ≤ 110% of projected remaining | 110–140% | > 140% |
| Any unresolved P0 bugs (blocks end-to-end completion) | 0 | 0 (any P0 must be resolved before CP-75) | Any P0 present = automatic RED |

**CP-75 Decision Protocol:**

| Checkpoint Status | Action |
|------------------|--------|
| All GREEN | Set firm MVP launch date. Finalize remaining stories. |
| Any YELLOW | Set provisional launch date with explicit buffer (1–2 weeks). Identify which YELLOW items are on the critical path to launch. |
| Any RED | Do not set launch date. Address RED items. Re-evaluate at 85% completion. |
| Remaining deferred items still in scope | Make explicit SHIP/DEFER decisions. No ambiguity into final sprint. |

**Decision Authority:** Steve.
**Evidence Required:** Three complete story run logs, dashboard screen recording demonstrating real-time state, setup verification log from Marcus's machine, current burn rate with revised completion projection.

---

## MVP Launch Gate

**Purpose:** The MVP Launch Gate is the final go/no-go before Steve and Marcus use QDS v2 as their primary development workflow. The question is not "is this perfect?" — it is "is this safe to trust with real development work?"

### Minimum Viable FR Set

The following FRs constitute the non-negotiable minimum for a real MVP. If any of these is absent or not functioning, the system is not an MVP — it is a prototype, and the launch is a NO-GO.

**Pipeline Completeness (must all be present):**

| FR | Capability | Why Non-Negotiable |
|----|------------|-------------------|
| FR1–FR8 | 5-phase pipeline (Intake → Develop → BMAD → QA → PR) for Story work type | Without end-to-end story execution, there is no factory |
| FR9 | Task work type with minimal pipeline | The PRD defines MVP as shipping Story + Task; Task is required |
| FR10–FR13 | BMAD adversarial review with context-isolated fresh agents | Context isolation is the core adversarial guarantee; BMAD without isolation is not BMAD |
| FR14–FR20 | 6-layer hook enforcement (all 6 layers functional) | Without hooks, the factory ships unvalidated code; the quality guarantee is void |
| FR21–FR24 | Agent orchestration (spawn, monitor, recover, checkpoint) | Without recovery and checkpoint, long-running stories are unreliable |
| FR28–FR35 | Overlay composition pipeline (all 6 stages functional) | Context management is the enabling infrastructure for everything else |
| FR36–FR42 | Resource and economic management (tier directives, budget tracking, circuit breakers, attribution) | Without budget tracking and circuit breakers, the factory can exhaust API budgets undetected |
| FR51–FR53 | Git safety and PR creation | Without git safety iron laws, the factory is a liability; without PR creation, there is no deliverable |

**Dashboard Minimum (must all be present):**

| FR | Capability | Why Non-Negotiable |
|----|------------|-------------------|
| FR43 | Factory Overview (system health, active stories, API key status, token budget) | Developer needs situational awareness from first glance |
| FR44 | Agent Windows with live xterm.js output | Journey 2 (stall recovery) is impossible without inspecting agent output |
| FR45 | Story pipeline phase progression | Developer needs to know where each story is in the pipeline |
| FR47 | Stall detection with type classification | Without classification (logic loop vs. external wait), every stall requires full manual inspection |
| FR25–FR27 | Stop, Nudge, Inspect controls | These are the developer's recovery tools; without them, stalled stories are only resolvable by killing the factory |
| FR50 | Dashboard crash does not halt agents | Non-negotiable reliability guarantee |

**Factory Learning System Minimum (must all be present):**

| FR | Capability | Why Non-Negotiable |
|----|------------|-------------------|
| FR55–FR58 | Learning record writes, outcome tags, loop 1 (mail), loop 2 (manifest) | Without these three loops, the factory does not learn; the core self-improvement promise is undelivered |
| FR61 | Overlay injection from synthesized learnings | Without injection, accumulated learnings have no effect on agent behavior |

**Developer Operations Minimum (must all be present):**

| FR | Capability | Why Non-Negotiable |
|----|------------|-------------------|
| FR69 | Setup script with dependency verification | Without this, Marcus cannot configure an independent instance |
| FR70 | Per-developer config (`factory.yaml`) | Without per-developer API keys and budgets, the two-developer model is impossible |
| FR71 | Independent dashboard instances | Without independent instances, two developers cannot work concurrently |

### NFR Minimums Required for Launch

All NFRs apply at launch. However, the following are the hard minimums — failure on any of these is a launch NO-GO:

| NFR | Requirement | Measurement Method | Hard Minimum |
|-----|-------------|-------------------|--------------|
| NFR1 | SSE event latency | Timestamp delta: Overstory SQLite write → dashboard DOM update | < 2 seconds |
| NFR3 | Phase boundary gate checklist time | Gate runner aggregate timing from 3 real stories | ≤ 60 seconds |
| NFR9 | API credentials never readable by agents | Code review: confirm Pi SDK mediates all access; no key in any agent context | Zero violations |
| NFR10 | No API key in any factory output | Automated credential scan on all output paths | Zero violations |
| NFR11 | Agent filesystem access restricted to worktree | Process-level restriction confirmed via attempt to access outside scope | Access denied (hard block, not warning) |
| NFR12 | factory.yaml excluded from version control | Setup script verifies on startup; test confirms halt if tracked | Factory halts if factory.yaml is in git |
| NFR14 | Agent crash detection and replacement | Timed crash injection test | Detection < 10s; replacement < 30s |
| NFR15 | Story checkpoint and resume after restart | Crash-and-resume integration test | Zero data loss; no phases re-executed |
| NFR16 | Learning record atomic writes | Crash injection at mid-write | No corrupted or partial files |
| NFR17 | SQLite concurrent access (15 agents) | Concurrent stress test | Zero data loss, zero silent failures |
| NFR22 | Quality pipeline cost ≤ 5% of story cost | Attribution chain cost aggregation from 5 real stories | ≤ 5% consistently |
| NFR23 | Setup script completes in < 5 minutes | Timed on clean machine (Marcus's) | < 5 minutes |
| NFR24 | macOS + Linux support | Setup and smoke test on both platforms | Both platforms pass |

### Quality Bar for the Factory Learning System

The Factory Learning System is a core MVP feature, not an add-on. The launch gate requires demonstrated function, not just implementation:

| Quality Bar | Pass Criteria | Fail Criteria |
|-------------|--------------|--------------|
| Learning records written correctly | After 3 smoke-test stories, `.qds/learnings/` contains well-formed YAML records with story outcome tags | Missing records, malformed YAML, or missing outcome tags |
| Loop 1 functioning | Agents send `learning_report` mail and lead agent receives it within the same story | No `learning_report` mails observed in any smoke-test story |
| Loop 2 functioning | Phase Boundary Protocol manifests include a non-empty `learnings` section | Missing or empty `learnings` sections in manifests |
| Manual synthesis script runs | `bun run synthesize-learnings` completes without errors on the 3 smoke-test stories' records | Script errors or exits non-zero |
| Injection works | Synthesized learnings from story 1 are present in the overlay assembled for story 3 (same file scope) | No evidence of cross-story injection |
| Conflict detection works | Introduce one intentional conflicting learning pair; verify synthesis script flags it and does not inject either | Conflict undetected or both injected without flag |

### Launch Gate Decision

| All non-negotiable FRs present and functional | All hard NFR minimums met | Learning system quality bars met | Launch Decision |
|----------------------------------------------|--------------------------|--------------------------------|----------------|
| YES | YES | YES | GO — launch MVP |
| YES | YES | NO | CONDITIONAL GO — launch with learning system defect tracked as P1; fix within 1 sprint post-launch |
| YES | NO (one NFR fails) | ANY | NO-GO — fix the failing NFR; re-evaluate |
| NO (any non-negotiable FR missing) | ANY | ANY | NO-GO — incomplete MVP; do not use as primary workflow |

**Decision Authority:** Steve (final decision). Marcus must confirm independent instance works from co-dev perspective.
**Evidence Required:** Launch readiness checklist (all items above marked PASS/FAIL), smoke test results from 5 stories, setup verification from Marcus, NFR test results, learning system demonstration (synthesis run + injection evidence).

---

## Pivot Triggers

Pivot triggers are pre-defined scenarios that, if they materialize, require a fundamental response rather than incremental adjustment. Declaring a pivot trigger suspends normal development and initiates a structured evaluation session.

### PT-1: Pi SDK Economy-Tier Cost Unviable

**Trigger Condition:** Pi SDK GLM-5 cost exceeds $0.10 per story for the quality pipeline (BMAD + QA combined), OR Pi SDK does not natively support economy-tier routing in a way that is transparent to the factory.

**Why This is a Fundamental Issue:** The PRD's competitive differentiator is "quality pipeline is economically negligible." At > $0.10/story, the quality pipeline is no longer negligible — it is comparable to a full additional development agent and will face developer pressure to be disabled. The adversarial quality guarantee becomes an optional feature.

**Evaluation Protocol (2-day timebox):**

| Response Option | Description | Go Criteria |
|----------------|-------------|-------------|
| Option A: OpenRouter fallback | Configure Pi SDK to route economy-tier calls through OpenRouter; use cheapest available model that supports tool calls | OpenRouter cost ≤ $0.05/story AND tool call quality equivalent |
| Option B: Reduced QA wave count | Reduce from 5 waves to 3; maintain full BMAD | Projected cost ≤ $0.05/story with 3 waves; quality validation (BMAD catch rate unaffected) |
| Option C: Defer economy-tier routing to Growth | Pin all agents to standard tier (Sonnet) for MVP; defer GLM-5 routing to Growth; accept higher per-story cost | Per-story cost including standard-tier QA ≤ $0.50 (acceptable if quality pipeline is viewed as 15–20% of story cost, not 3–5%); team accepts cost model change |
| Option D: Remove QA swarm from MVP | Ship with BMAD adversarial review only; defer 5-wave QA to Growth | BMAD catch rate is sufficient without QA (validate via 10-story test); team accepts reduced quality guarantee |

**Decision:** Steve selects one option within the 2-day evaluation window. If no option achieves cost viability, escalate to full project re-scoping session.
**Decision Authority:** Steve.

---

### PT-2: Phase Boundary Protocol Design Failure

**Trigger Condition:** Phase Boundary Protocol spike (Gate 0-B) FAILs on context isolation OR manifest sufficiency, AND the failure cannot be resolved within a 2-week redesign sprint.

**Why This is a Fundamental Issue:** PBP is the foundation of adversarial review. Without genuine context isolation, the factory's BMAD review agents are not adversarial — they are collaborative. The core guarantee ("review agents never share context with development agents") is violated. The PRD is explicit: "Context isolation is non-negotiable — development agents never share context with review agents, eliminating the sunk-cost bias that makes self-review worthless."

**Evaluation Protocol (3-day timebox):**

| Response Option | Description | Go Criteria |
|----------------|-------------|-------------|
| Option A: Heavier manifest schema | Expand what the manifest carries; accept higher token overhead | Context isolation verified with expanded manifest; total manifest ≤ 2,000 tokens |
| Option B: Filesystem-based handoff | BMAD agents receive a read-only snapshot of the worktree at phase boundary rather than a manifest | Zero context leakage verified; snapshot read-only enforced at process level |
| Option C: Defer adversarial review to Growth | Ship MVP with automated BMAD review using the development agent's own context (intra-agent review, not adversarial) | Team explicitly acknowledges the quality guarantee is weakened; "adversarial" is removed from MVP marketing |
| Option D: Full architecture review | Suspend development for 1 week; re-examine whether the Overstory + Pi SDK combination can support true process-level context isolation | Only if options A and B both fail |

**Decision:** Steve + Marcus joint decision within 3-day window.
**Decision Authority:** Steve + Marcus (this decision affects the core product promise).

---

### PT-3: Development Velocity Collapse

**Trigger Condition:** At any checkpoint, projected completion date for MVP exceeds 16 weeks from start AND the delay is due to scope complexity (not external blockers).

**Why This is a Fundamental Issue:** A 16-week MVP for a 2-developer internal tool means 4 months before Steve and Marcus can use QDS v2 for real work. The opportunity cost (using QDS v1 or no factory at all during that time) may exceed the value of delivering the full MVP scope. This trigger forces a scope conversation, not a schedule slip.

**Evaluation Protocol (1-day timebox):**

Apply the following scope reduction hierarchy in order until the projected completion date is within 12 weeks:

| Scope Reduction | FRs Affected | Recovery: What Can Be Added Back at Growth Start |
|----------------|-------------|--------------------------------------------------|
| Level 1: Remove Dashboard Copilot | FR105–FR119 | Entire CopilotKit + AG-UI feature |
| Level 2: Remove Meta-Optimization | FR77–FR89 | Daily/weekly cron observers and self-improvement |
| Level 3: Remove Telegram Communication | FR120–FR129 | Full Telegram developer channel |
| Level 4: Remove Self-Learning System extensions | FR164–FR168 | Maintenance extraction, pattern accumulation, epic context |
| Level 5: Reduce Dashboard to core only | Defer FR45 (pipeline viz), FR49 (budget projection), FR47 (stall classification diagnostic) | Full dashboard feature set |
| Level 6 (last resort): Defer Task work type | FR9 | Task pipeline in first Growth sprint |

**Rule:** Levels 1–3 together save approximately 20–25% of MVP scope. If Levels 1–3 are insufficient to bring the date within 12 weeks, something has gone wrong architecturally (not just in scope), and the team should evaluate whether the architecture design needs a restart (which this framework cannot solve with a table).

**Decision Authority:** Steve.

---

### PT-4: `gh` CLI Dependency Failure

**Trigger Condition:** `gh` CLI is not viable as the GitHub integration mechanism (authentication issues, rate limits in testing, or `gh` API changes that break PR creation before MVP launch).

**Why This is a Pivot (not just a bug):** The PRD designates `gh` CLI as a "hard dependency." PR creation is the delivery mechanism of the entire factory — without it, the factory cannot ship any code. Every story completes but delivers nothing.

**Response:**

| Response | Description | Timeline |
|----------|-------------|----------|
| Direct GitHub REST API | Replace `gh` CLI calls with direct `fetch()` to GitHub REST API (authenticated with PAT stored in `factory.yaml`) | 2–3 developer-days |
| octokit SDK | Replace `gh` CLI with the official GitHub SDK (Octokit) | 3–5 developer-days |

Neither option is a fundamental architecture change. This pivot is a 3–5 day implementation task, not a strategic re-scoping. The trigger is included because `gh` CLI authentication flows and scoping requirements have historically been brittle across environments.

**Decision Authority:** Marcus (dashboard/integration developer) with Steve approval.

---

### PT-5: Factory Learning System Quality Failure

**Trigger Condition:** After 30 days of MVP operation (using the factory daily), the Factory Learning System is net negative — injected learnings are causing MORE agent failures, not fewer. Specifically: stories where the relevant scope has active synthesized learnings fail at BMAD or QA at a HIGHER rate than stories in unlearned scopes.

**Why This is a Fundamental Issue:** The PRD states this as a core innovation and competitive moat. If the learning system is injecting wrong guidance, it is actively harmful. The tier system (critical/recommended/informational) and Superpowers gate validation are the guardrails designed to prevent this. If they fail at scale, the architecture of the learning system needs rethinking.

**Response:**

| Response | Description |
|----------|-------------|
| Immediate: Disable injection | Set `learning_injection_level: none` in `factory.yaml` to stop all injections immediately; factory continues operating without learnings |
| Investigation (3 days): Audit injected learnings | Manually review all active synthesized learnings; identify the class of learnings that are producing wrong guidance |
| Fix or defer | If learnings are wrong due to synthesis bugs (fixable) → fix synthesis script; re-enable injection for critical tier only. If learnings are wrong due to fundamental over-generalization → defer learning injection to Growth; ship MVP with learning records collected but not injected; resolve architecture in Growth. |

**Decision Authority:** Steve.
**Measurement Method:** Comparison of BMAD correction rate in scopes with active learnings vs. scopes without (see PRD innovation validation method, 15% reduction minimum bar).

---

### Pivot Trigger Summary Table

| Trigger | Condition | Time to Decision | Decision Authority | Default Response if Undecided |
|---------|-----------|-----------------|-------------------|------------------------------|
| PT-1: Economy-tier cost unviable | Quality pipeline > $0.10/story | 2 days | Steve | Option C (defer economy routing) |
| PT-2: PBP design failure | Context isolation cannot be verified | 3 days | Steve + Marcus | Option B (filesystem snapshot handoff) |
| PT-3: Velocity collapse | Projected completion > 16 weeks | 1 day | Steve | Apply scope reduction levels 1–3 |
| PT-4: `gh` CLI failure | PR creation not viable via `gh` | 3–5 days to implement alternative | Marcus + Steve | Direct GitHub REST API |
| PT-5: Learning system net negative | Injection increases failure rate after 30 days | Immediate disable; 3 days investigation | Steve | Disable injection; investigate |

---

## Decision Accountability Matrix

### Who Decides What

| Decision Type | Primary Decision Maker | Input Required From | Override Authority | Documentation |
|---------------|----------------------|--------------------|--------------------|---------------|
| Gate 0-A pass/fail (Pi SDK cost) | Steve | Spike output data | None | Checkpoint record |
| Gate 0-B pass/fail (PBP spike) | Steve + Marcus joint | Spike output + both developers' assessment | Neither can override the other (joint required) | Checkpoint record |
| Gate 0-C pass/fail (CopilotKit) | Marcus | Performance metrics + dependency tree | Steve (can override to PASS if strategic priority warrants) | Checkpoint record |
| CP-25 scope deferral decisions | Steve | Sprint velocity, burn rate data | None | CP-25 checkpoint record |
| CP-50 smoke test failure response | Steve + Marcus joint | Smoke test output | Steve (can override Marcus on non-architectural decisions) | CP-50 checkpoint record |
| CP-50 scope deferral decisions | Steve | Marcus input on implementation complexity | None | CP-50 checkpoint record |
| CP-75 launch date setting | Steve | Marcus confirmation that co-dev instance works | None | CP-75 checkpoint record |
| MVP launch go/no-go | Steve | Marcus sign-off on independent instance | None (Steve has final call) | Launch readiness checklist |
| Pivot trigger activation | Steve (PT-1, PT-3, PT-4, PT-5) or Steve + Marcus (PT-2) | See individual pivot trigger | As specified per trigger | Pivot decision record |
| FR deferral from MVP to Growth | Steve | Marcus input on implementation dependency chain | None | Deferral decision record |
| Post-launch production issue | Steve | Any data available | None | Incident record + learning system input |

### Decision Escalation Rules

1. **Any decision that changes the core product promise** (adversarial review guarantee, context isolation, economy-tier routing as competitive differentiator) requires Steve + Marcus joint decision, regardless of which category it falls into above.

2. **Any decision made under time pressure** (< 24 hours to decide) defaults to the conservative option documented in the relevant pivot trigger table. "When in doubt, defer" applies to features; "when in doubt, do not compromise" applies to quality guarantees.

3. **Disputed decisions** (Steve and Marcus disagree) default to the more conservative option (smaller scope, higher quality bar, longer timeline). There is no tiebreaker — disputes must be resolved by finding a position both parties can commit to.

4. **No unilateral scope additions** to MVP. New scope is always Growth-first; it requires a joint decision to pull something forward from Growth to MVP during development.

### Decision Documentation Standard

Every gate decision (Gate 0, CP-25, CP-50, CP-75, launch) produces a written checkpoint record as a markdown file in `_bmad-output/planning-artifacts/`. The file name format is:
`checkpoint-[gate-id]-[YYYY-MM-DD].md`

Minimum required content:
- Gate ID and date
- Each criterion assessed: status (PASS/CONDITIONAL PASS/FAIL)
- Evidence reviewed
- Decision made
- Any constraints or tracked risks added to the project
- Names of decision makers present

Pivot trigger decisions use the format:
`pivot-[PT-id]-[YYYY-MM-DD].md`

---

## Appendix: Framework Application Notes

### On Using This Framework

This framework is a tool for structured decision-making, not a bureaucratic process. The checkpoints are designed to surface information that is easy to ignore under delivery pressure. The most common failure mode on complex projects is not making a bad decision at a gate — it is never stopping to evaluate the gate at all.

**Checkpoint timing is non-negotiable.** When 25%, 50%, and 75% of stories are accepted, the checkpoint happens. Not "after the next sprint" and not "when things calm down." Delivery pressure is always maximum at checkpoint time — that is exactly why the checkpoints exist.

**Deferred scope is not failed scope.** Every feature in the deferral tables above appears in the Growth phase scope. Deferral to Growth is not a failure — it is a resource management decision. The self-healing cron loop, the ELO behavioral system, the Brainstorming tentacle — these are Growth features because the PRD prioritized depth over breadth for MVP. Deferring Dashboard Copilot from MVP to Growth is not a setback; it is the framework working correctly.

**Pivot triggers are not alarms — they are options.** When a pivot trigger fires, the team evaluates options within the defined timebox and chooses the best path forward. The trigger is a signal to slow down and evaluate, not a signal that the project is in crisis.

### On the GLM-5 Assumption

The PRD is built on a specific assumption: GLM-5 via Pi SDK native routing at economy-tier cost. This assumption underlies the economics of the adversarial quality pipeline and the Dashboard Copilot. Gate 0-A validates this assumption before any implementation begins. If this assumption is false, Option C in PT-1 (defer economy-tier routing to Growth) is a viable path — the factory works with standard-tier models throughout; it is just more expensive per story. The architecture does not change. Only the cost model changes.

### On the Learning System

The Factory Learning System is described in the PRD as the deepest competitive moat. PT-5 (learning system net negative) is included not because the design is suspected to fail, but because "make the factory smarter" is an empirical claim that must be validated against real usage. The validation criteria are stated explicitly in the PRD's innovation validation section (15% reduction in token waste for learned scopes within 30 days). This framework incorporates that validation bar and specifies what to do if it is not met.

### Revision Policy

This framework should be updated if:
- The PRD changes significantly (new FRs added to MVP, scope changes)
- Gate 0 results produce new information that changes the risk profile
- Any pivot trigger fires and the response changes the project context

Framework revisions follow the same naming convention as the original:
`prd-analysis-go-no-go-framework-[YYYY-MM-DD].md` (new date = new revision)

---

*Framework generated from PRD analysis on 2026-03-14. PRD source: `prd-v2.md` v2.0 (consolidated 2026-03-10).*
