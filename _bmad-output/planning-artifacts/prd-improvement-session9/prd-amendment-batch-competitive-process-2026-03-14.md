# PRD Amendment Batch — Competitive Landscape & Go/No-Go Process
**Batch ID:** AMEND-2026-03-14-CL-GNG
**PRD Target:** `prd-v2.md` v2.0 (consolidated 2026-03-10)
**Amendment Date:** 2026-03-14
**Source Analyses:**
- `prd-analysis-competitive-landscape-2026-03-14.md`
- `prd-analysis-go-no-go-framework-2026-03-14.md`
**Decision Authority:** Steve

---

## Amendment Index

| # | Short Title | Type | Target Section |
|---|-------------|------|----------------|
| 1 | Add Missing High-Velocity Competitors | MODIFY_SECTION | Innovation & Novel Patterns → Competitive Moat Assessment |
| 2 | Correct "No More Than 3" Claim | MODIFY_SECTION | Executive Summary |
| 3 | Correct "All Eight Dimensions" MVP Claim | MODIFY_SECTION | Executive Summary |
| 4 | Elevate Factory Learning System to First Differentiator | MODIFY_SECTION | Innovation & Novel Patterns → Detected Innovation Areas |
| 5 | Demote D7 to Economic Claim | MODIFY_SECTION | Innovation & Novel Patterns → Detected Innovation Areas |
| 6 | Add Quarterly Competitive Monitoring Note | NEW_SECTION | Innovation & Novel Patterns (after Competitive Moat Assessment) |
| 7 | Add Fine-Tuning Signal Generation One-Liner to Vision | MODIFY_SECTION | Project Scoping → Vision Features |
| 8 | Add Burn-Rate Checkpoints to Project Scoping | MODIFY_SECTION | Project Scoping → Risk Mitigation Strategy |
| 9 | Add Appendix C: Go/No-Go Decision Framework | NEW_SECTION | After Appendix B |

---

## AMENDMENT 1: Add Missing High-Velocity Competitors
**Type:** MODIFY_SECTION
**Target:** Innovation & Novel Patterns → Competitive Moat Assessment
**Reason:** GitHub Copilot Workspace, Claude Code, Google Jules, and OpenAI Codex CLI are entirely absent from the competitive analysis despite being the highest-velocity threats as of Q1 2026; Factory.ai (the QDS platform itself, scored against the 8-dimension matrix) now scores 6/16 on a quality-weighted basis and belongs explicitly in the scoring table alongside competitors.

**Original text:**
```
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
```

**Replacement text:**
```
### Competitive Scoring Matrix

The 8-dimension claim in the Executive Summary is supported by the following quality-weighted scoring matrix. Scoring rubric: Full (1.0) = purpose-built production capability; Partial (0.5) = degraded, adjacent, or manually-configured version; None (0) = no capability.

| Competitor | D1 Orchestration | D2 Adversarial Review | D3 QA Automation | D4 Self-Healing | D5 Scheduled Ops | D6 Context Mgmt | D7 Cost Optimization | D8 Learning System | **Score /8** |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Cursor** | 0.5 | 0.5 | 0.5 | 0.5 | 0 | 0.5 | 0.5 | 0.5 | **4.0** |
| **GitHub Copilot / Workspace** | 0.5 | 0.5 | 0.5 | 0.5 | 0 | 0.5 | 0 | 0 | **2.5** |
| **Devin (Cognition AI)** | 1.0 | 0 | 0.5 | 0 | 0 | 0.5 | 0 | 0 | **2.0** |
| **Google Jules** | 0.5 | 0 | 0 | 0.5 | 0.5 | 0 | 0 | 0 | **1.5** |
| **OpenAI Codex CLI** | 0.5 | 0 | 0.5 | 0 | 0 | 0 | 0 | 0 | **1.0** |
| **Claude Code** | 0.5 | 0 | 0 | 0 | 0 | 0.5 | 0 | 0 | **1.0** |
| **CodeRabbit** | 0 | 1.0 | 0 | 0 | 0 | 0 | 0 | 0 | **1.0** |
| **LangChain / CrewAI** | 1.0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **1.0** |
| **Dependabot** | 0 | 0 | 0 | 0.5 | 0.5 | 0 | 0 | 0 | **1.0** |
| **Snyk** | 0 | 0 | 0 | 0.5 | 0 | 0 | 0 | 0 | **0.5** |
| **QDS Engineer v2 (MVP — 6 active dimensions)** | 1.0 | 1.0 | 1.0 | 0* | 0* | 1.0 | 1.0 | 1.0 | **6.0** |
| **QDS Engineer v2 (Growth — all 8 active)** | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | **8.0** |

*D4 (Self-Healing) and D5 (Scheduled Operations) are Growth-phase features. QDS MVP delivers 6 of 8 dimensions; the full closed-loop architecture (all 8) completes at Growth.

**Notes on newly-added competitors:**

- **Cursor (4.0/8):** The closest competitor. Partial coverage across 7 dimensions, concentrated in the most visible ones (D1, D2, D3) — the first dimensions a developer evaluates. Cursor's D2 score is structurally limited: it reviews its own output without context isolation, which is the exact gap QDS's Phase Boundary Protocol addresses. Adding context isolation would require a fundamental product architecture change for Cursor, not a feature addition. Cursor's D8 score is `.cursorrules` — human-authored, manually updated, static. QDS's D8 is agent-generated, outcome-weighted, and auto-injected.
- **GitHub Copilot / Workspace (2.5/8):** 1.8M+ paid users with native IDE integration. Partial coverage of D1+D2+D3 at Copilot's distribution scale is a larger market threat than full coverage from a new entrant.
- **Claude Code (1.0/8):** QDS depends on Claude Code as its underlying execution environment. Claude Code's own multi-agent features and hooks API (which QDS's Superpowers architecture resembles) directly erode D1+D2 differentiation. This is a structural blind spot: the runtime QDS depends on is also a competitor.
- **Google Jules (1.5/8):** Background async coding agent targeting D4+D5, announced Q4 2025. Google's infrastructure advantage also threatens D7 economics.
- **OpenAI Codex CLI (1.0/8):** Terminal-native coding agent targeting the solo-developer and startup CTO personas directly.

### Competitive Moat Assessment

**Strong moat (hard to replicate):**
- **Factory Learning System (D8)** — requires real workloads to accumulate learnings. A competitor can copy the architecture but not the accumulated operational intelligence. Moat deepens with every story. This is a *future* moat — it requires QDS to ship and accumulate data before the moat materializes. First-mover advantage is real and irreversible once the data flywheel is spinning.
- **5-Layer Context Management + Phase Boundary Protocol (D6)** — requires deep integration with multiple subsystems. Composition across Overstory, Superpowers, Phase Boundary Protocol, Mulch, and Seeds is the moat. IDE-native tools (Cursor, Copilot) are built on context continuity for user experience — they structurally resist adopting Phase Boundary Protocol's deliberate context discontinuity.

**Moderate moat (replicable with effort):**
- **Adversarial Quality Pipeline (D2)** — the mechanism (context isolation) is unique today; the output format is more durable. Lead with the evidence output (structured PR bodies with severity-tiered findings, branch coverage gap indicators, cost attribution) rather than the mechanism. Once review processes depend on this format, switching cost is real.
- **Coordination-Over-External-Runtimes via Pi SDK (D7-adjacent)** — Pi SDK provides the model-agnostic runtime natively. Moat is in Factory Core's agent-specific governance layer (context budgets, capability matching, attribution chains, tier policy).
- **Closed-Loop Self-Healing with verification loop (D4/D5)** — competitors will ship auto-fix before they ship auto-verify. The next-cycle re-verification is architecturally unglamorous and durably differentiating. Moat rating deferred until Growth ships the verification loop and it is proven operationally.

**Table-stakes (not a positioning differentiator):**
- **Model-agnostic cost routing (D7 mechanism)** — infrastructure, not product, as of Q1 2026. OpenRouter and LiteLLM commoditize the routing mechanism. The economic *outcome* is differentiating: "mandatory adversarial review and 5-wave QA at ~$0.02 per story." Position the economics, not the routing.

**Compound moat (the organizing claim):**
The integration of all active dimensions into a single closed loop is harder to replicate than any dimension individually. When D7 (cost routing) is commoditized, QDS still uses it to make the quality pipeline economically invisible. When D1 (orchestration) is commoditized by Claude Code, QDS still enforces Phase Boundary Protocol and context isolation across it. This compound architecture is the actual competitive claim — not a dimension count.

**Strategic implication:** The Factory Learning System and 5-Layer Context Management are the deepest moats and the innovations that compound over time. D8 must be the external lead claim. Architecture and implementation sequencing should prioritize getting these right.
```
---

## AMENDMENT 2: Correct "No More Than 3" Claim
**Type:** MODIFY_SECTION
**Target:** Executive Summary — fourth paragraph
**Reason:** The "no more than 3 of 8 dimensions" claim breaks against Cursor, which scores 4.0/8 on a quality-weighted matrix, and was written against the wrong competitive set (narrow tools, not IDE-native platforms).

**Original text:**
```
No existing tool scores on more than three of these dimensions; QDS integrates all eight into a closed loop.
```

**Replacement text:**
```
No existing tool offers the complete closed-loop architecture — context-isolated adversarial quality pipeline, factory-wide learning system that compounds with every story, and 5-layer context management composed as a unified platform. The closest competitor (Cursor) scores 4.0 of 8 dimensions on a quality-weighted matrix, concentrated in the most visible capabilities (orchestration, generation, QA) while structurally unable to adopt Phase Boundary Protocol's context isolation or a data-flywheel learning system. QDS MVP integrates 6 of 8 dimensions; the full closed loop (all 8, including self-healing and scheduled operations) completes at Growth.
```
---

## AMENDMENT 3: Correct "All Eight" MVP Claim
**Type:** MODIFY_SECTION
**Target:** Executive Summary — fourth paragraph (the sentence immediately following the replacement for Amendment 2)
**Reason:** D4 (Continuous Self-Healing) and D5 (Scheduled Operations) are explicitly Growth-phase features; the "QDS integrates all eight" claim is accurate only at the Growth phase and sets a false expectation if read as describing MVP launch.

**Original text:**
```
A conversational AI copilot built on CopilotKit and AG-UI provides natural language access to the entire dashboard — developers can query status, investigate issues across multiple data sources, and execute controls through conversation, making the dashboard's full power accessible without memorizing navigation paths.
```

*Note: The amendment here is additive — a clarifying sentence is inserted before this existing sentence to address the MVP vs. Growth scope distinction. The CopilotKit sentence is unchanged and retained.*

**Replacement text:**
```
MVP delivers the core closed loop across 6 dimensions (D1 agent orchestration, D2 adversarial quality pipeline, D3 QA automation, D6 5-layer context management, D7 model-agnostic cost optimization, D8 Factory Learning System). The two remaining dimensions — D4 continuous self-healing and D5 scheduled operations — are Growth-phase features; together they complete the full 8-dimension closed loop at Growth. A conversational AI copilot built on CopilotKit and AG-UI provides natural language access to the entire dashboard — developers can query status, investigate issues across multiple data sources, and execute controls through conversation, making the dashboard's full power accessible without memorizing navigation paths.
```
---

## AMENDMENT 4: Elevate Factory Learning System to First Differentiator
**Type:** MODIFY_SECTION
**Target:** Innovation & Novel Patterns → Detected Innovation Areas — the innovation ranking table
**Reason:** D8 (Factory Learning System) is the only genuine data-flywheel moat with 24–36 months to commoditization and no direct competitor analog; leading with it in the innovation table aligns positioning with the most defensible claim.

**Original text:**
```
Five innovation areas identified, ranked by novelty and strategic importance:

| # | Innovation | Novelty Level | Closest Competitor Analog | Gap vs Competitors |
|---|---|---|---|---|
| 1 | Adversarial Quality Pipeline (context-isolated, economy-tier) | High | CodeRabbit (AI review), Cursor (AI generation) | Neither enforces context isolation between generation and review; neither makes quality economically invisible |
| 2 | Closed-Loop Self-Healing | High | Dependabot (single-concern auto-fix), Snyk (security-only) | No tool does full-spectrum scan → fix → verify loop with layered guardrails |
| 3 | Factory Learning System | High | None | Entirely novel category; no competitor has cross-session agent learning with auto-injection |
| 4 | Coordination-Over-External-Runtimes (via Pi SDK) | Moderate | LangChain/CrewAI (agent frameworks) | Those frameworks own execution; QDS coordinates via Pi SDK which handles model-agnostic runtime natively |
| 5 | 5-Layer Context Management Harness | Moderate | Various tools implement 1-2 layers | No tool composes all 5 layers; innovation is in the composition |
```

**Replacement text:**
```
Five innovation areas identified, ranked by novelty, strategic importance, and durability of competitive advantage:

| # | Innovation | Novelty Level | Closest Competitor Analog | Gap vs Competitors | Moat Durability |
|---|---|---|---|---|---|
| 1 | **Factory Learning System (D8)** | **High** | Cursor `.cursorrules` (manual, static); no automated analog | Only genuine data-flywheel moat. No competitor has agent-generated, outcome-weighted, auto-injected cross-session learning. The data asset requires real workloads — cannot be replicated by copying architecture. | **24–36 months** |
| 2 | 5-Layer Context Management Harness (D6) | High | Cursor codebase indexing (2 of 5 layers); no Phase Boundary Protocol analog | No tool composes all 5 layers. IDE-native tools structurally resist Phase Boundary Protocol's context discontinuity because their product model is context continuity. | 12–18 months |
| 3 | Adversarial Quality Pipeline (context-isolated, economy-tier) (D2) | High | CodeRabbit (AI review), Cursor (reviews own output) | Neither enforces context isolation between generation and review. Neither produces structured evidence artifacts with severity tiers, branch coverage gaps, and cost attribution at ~$0.02/story. | 6–9 months (mechanism); workflow dependency persists |
| 4 | Closed-Loop Self-Healing with verification loop (D4/D5) | High | Dependabot (single-concern auto-fix), Snyk (security-only), Google Jules (D4/D5 partial) | No tool does full-spectrum scan → fix → next-cycle verify loop with layered guardrails. Competitors will ship auto-fix; few will ship re-verification. | 12–18 months (Growth feature) |
| 5 | Coordination-Over-External-Runtimes via Pi SDK | Moderate | LangChain/CrewAI (agent frameworks that own execution) | Those frameworks own execution; QDS coordinates via Pi SDK which handles model-agnostic runtime natively. Moat is Factory Core's governance layer, not Pi itself. | Moderate; depends on Pi SDK health |
```
---

## AMENDMENT 5: Demote D7 to Economic Claim
**Type:** MODIFY_SECTION
**Target:** Executive Summary — third paragraph of "What Makes This Special" (the "Factory Core resource brain" paragraph)
**Reason:** Model-agnostic cost routing is commoditizing fastest (3–6 months to full commoditization via OpenRouter/LiteLLM); the economic outcome (~$0.02/story quality pipeline) is differentiating, but the routing mechanism is not.

**Original text:**
```
**Factory Core resource brain as scaling prerequisite.** Single-key API architecture is a throughput ceiling that turns a factory into a workshop. The Factory Core manages API key configuration for Pi SDK, token budgets with cost circuit breakers, model tier directives (telling Pi which tier to use per agent role), and cross-tentacle resource arbitration. Pi SDK handles model selection and provider routing natively — Factory Core's responsibility is economic governance (budgets, circuit breakers, tier policy), not API call execution. Model routing enables the quality pipeline's economics — they are symbiotic differentiators. MVP delivers Pi SDK integration with tier-based routing; post-MVP delivers advanced key rotation, health monitoring, and OpenRouter as an optional fallback for models Pi doesn't natively support.
```

**Replacement text:**
```
**Factory Core resource brain as scaling prerequisite.** Single-key API architecture is a throughput ceiling that turns a factory into a workshop. The Factory Core manages API key configuration for Pi SDK, token budgets with cost circuit breakers, model tier directives (telling Pi which tier to use per agent role), and cross-tentacle resource arbitration. Pi SDK handles model selection and provider routing natively — Factory Core's responsibility is economic governance (budgets, circuit breakers, tier policy), not API call execution. The economic outcome of this architecture is the differentiator: mandatory adversarial review and 5-wave QA cost approximately $0.02 per story — making the full quality pipeline economically negligible at ~3–5% of development cost. Model-agnostic routing is the infrastructure that enables this outcome, not a competitive claim in itself. MVP delivers Pi SDK integration with tier-based routing; post-MVP delivers advanced key rotation, health monitoring, and OpenRouter as an optional fallback for models Pi doesn't natively support.
```
---

## AMENDMENT 6: Add Quarterly Competitive Monitoring Note
**Type:** NEW_SECTION
**Target:** Innovation & Novel Patterns — new subsection after "Competitive Moat Assessment"
**Reason:** No contingency plan, refresh triggers, or monitoring signals are defined in the PRD, leaving the competitive claims brittle and undefendable when any major platform ships a relevant feature.

**Original text:** N/A — new item

**Replacement text:**
```
### Quarterly Competitive Monitoring

Competitive claims in this PRD require active maintenance. The following monitoring framework defines what to watch, at what frequency, and which claims require immediate revision on each trigger event.

**Monitoring Cadence: Monthly for high-velocity signals; quarterly for full matrix refresh.**

#### High-Priority Signals (check monthly)

| Competitor | Signal to Watch | Claim at Risk | Immediate Response if Triggered |
|---|---|---|---|
| **Claude Code** | Anthropic releases multi-agent mode with explicit reviewer role isolation (clean context between generator and reviewer) | D2 mechanism uniqueness | Reframe D2: shift from "we have this" to "we have 12+ months of operational data proving this at scale." Lead with D8 data flywheel. |
| **GitHub Copilot / Workspace** | Copilot announces "review agent" with explicit context boundary semantics | D2 mechanism uniqueness | Shift D2 positioning entirely to evidence artifact format (severity-tiered PR bodies, branch coverage gap indicator). The artifact is more durable than the mechanism. |
| **Cursor** | Cursor changelog shows scheduled/cron-equivalent background agents | D5 uniqueness | Accelerate D4/D5 Growth shipping. Lead with the verification loop specifically — next-cycle re-verification is architecturally unglamorous and Cursor will deprioritize it. |
| **Any funded competitor** | Competitor announces "codebase memory," "persistent agent learning," or "agent knowledge base" product | D8 uniqueness claim | Execute data-flywheel argument immediately: QDS has N months of real operational data from real stories; the competitor starts from zero. Ship Factory Intelligence Score dashboard as visible proof. |
| **GLM-5 / economy-tier models** | GLM-5 pricing changes; competing economy-tier models release (Gemini Flash, Haiku) | "$0.02/story" economic claim | Update cost claim with real data from production. If cost rises, re-validate the "economically negligible" threshold or adjust quality pipeline configuration. |

#### Full Matrix Refresh (quarterly)

Re-score the competitive matrix in Amendment 1 of this batch each quarter against the following refresh questions:

1. Has Cursor shipped scheduled background agents? (Changes D5 score from 0 → 0.5)
2. Has Claude Code shipped an explicit review agent with context isolation? (Changes D2 score from 0 → 0.5 or 1.0)
3. Has any competitor shipped agent-generated persistent learning with auto-injection? (Changes D8 score)
4. Has Pi SDK economy-tier routing been replicated by any mainstream IDE plugin or model gateway? (D7 mechanism becomes full table-stakes)
5. Does any competitor now score ≥ 5.0/8 on the quality-weighted matrix? (Triggers reframe of compound moat claim)

**Refresh ownership:** Steve performs the quarterly matrix refresh. Output is a new dated competitive analysis file in `_bmad-output/planning-artifacts/`. The PRD competitive claims section is amended as needed following the refresh.

**Do not refresh in isolation.** Each refresh should check competitor release notes, changelog entries, and community discussion (Cursor forums, GitHub Next blog, Anthropic developer blog, Google Labs announcements, OpenAI developer changelog) — not just product announcements.
```
---

## AMENDMENT 7: Add Fine-Tuning Signal Generation One-Liner to Vision
**Type:** MODIFY_SECTION
**Target:** Project Scoping & Phased Development → Vision Features (Phase 3: Expansion)
**Reason:** The MVP data infrastructure (action scores, session composites, learning records, attribution chains) is the direct precursor to factory-specific model fine-tuning in Vision; making this explicit completes the D8 data-flywheel narrative and positions the MVP data collection investment as multi-phase value.

**Original text:**
```
- Fine-tuning signal generation from accumulated performance data (action scores + session outcomes → training datasets)
```

**Replacement text:**
```
- Fine-tuning signal generation: the data infrastructure built in MVP (action scores, session composites, learning records, attribution chains) is the foundation for factory-specific model fine-tuning in Vision — eliminating 40–60% of overlay token overhead by encoding factory conventions into the model weights rather than injecting them at inference time
```
---

## AMENDMENT 8: Add Burn-Rate Checkpoints to Project Scoping
**Type:** MODIFY_SECTION
**Target:** Project Scoping & Phased Development → Risk Mitigation Strategy — Resource Risks subsection
**Reason:** The current Risk Mitigation Strategy mentions being "behind schedule" with only informal guidance; explicit burn-rate checkpoints with deferral criteria at 25%/50%/75% completion make scope decisions structured and non-discretionary.

**Original text:**
```
**Resource Risks:**
- *2 developers, ambitious scope* → Critical path (Pi → Overstory → Hooks → Phase Boundary → Superpowers) on Developer A. Parallel track (Dashboard → Mulch → Learning) on Developer B. Integration point is well-defined.
- *If behind schedule* → Task work type can ship without full hook enforcement. Dashboard can launch with Factory Overview + Agent Windows only (defer Story Pipeline visualization).
```

**Replacement text:**
```
**Resource Risks:**
- *2 developers, ambitious scope* → Critical path (Pi → Overstory → Hooks → Phase Boundary → Superpowers) on Developer A. Parallel track (Dashboard → Mulch → Learning) on Developer B. Integration point is well-defined.
- *If behind schedule* → Task work type can ship without full hook enforcement. Dashboard can launch with Factory Overview + Agent Windows only (defer Story Pipeline visualization).

**Burn-Rate Checkpoints (mandatory at 25%, 50%, 75% MVP story completion):**

At each checkpoint, evaluate actual developer-hours against plan and apply the deferral priority order if thresholds are breached. Checkpoint evaluation takes no more than 2 hours; output is a written record in `_bmad-output/planning-artifacts/checkpoint-[CP]-[YYYY-MM-DD].md`.

| Checkpoint | Burn-Rate Threshold Triggering Deferral Conversation | Deferral Priority Order (defer in order, stop when plan recovers) |
|---|---|---|
| **CP-25** (25% stories accepted) | Actual hours > 135% of projected hours at 25%, OR any single story > 3× its estimate | 1. FR105–FR119 (Dashboard Copilot) → 2. FR77–FR89 (Meta-Optimization) → 3. FR120–FR129 (Telegram) → 4. FR164–FR168 (Self-Learning extensions — last resort only; if reached, evaluate Pivot Trigger PT-3 first) |
| **CP-50** (50% stories accepted) | Cumulative hours > 150% of projected, OR projected completion extrapolation > 160% of original estimate | Apply CP-25 deferral table first (items not yet deferred). Then: 5. FR91–FR104 subset (resilience polish: FR92, FR98, FR100, FR102) → 6. FR130–FR132 (Agent Performance Data Collection — last resort; every week without delays Growth readiness equivalently) |
| **CP-75** (75% stories accepted) | Hours remaining for final 25% > 140% of projected remaining, OR any unresolved P0 bugs | Final SHIP/DEFER decisions — nothing enters the last sprint in ambiguous status. FR105–FR119 and FR77–FR89 receive explicit decisions. |

**Deferral rules:**
- All items deferred to Growth remain in the Growth feature set — deferral is a resource management decision, not a product cancellation.
- FR130–FR132 (Agent Performance Data Collection) deferral is a last resort: every week without these ~500 LOC of data collection delays Growth behavioral system (ELO, capability tiers) readiness by an equivalent amount.
- If items 1–3 are all deferred at CP-25 AND critical path is still RED, do not defer FR164–FR168 — escalate to Pivot Trigger PT-3 evaluation instead (see Appendix C).
- Any decision to defer a feature is logged in the checkpoint record with: rationale, affected FRs, Growth sprint that absorbs it, and sign-off from Steve.

See **Appendix C** for the full Go/No-Go Decision Framework including Gate 0 pre-start criteria, mid-development checkpoint protocols, MVP Launch Gate minimum viable FR set, pivot triggers (PT-1 through PT-5), and decision accountability matrix.
```
---

## AMENDMENT 9: Add Appendix C — Go/No-Go Decision Framework
**Type:** NEW_SECTION
**Target:** After Appendix B (Estimated New-Write LOC for New MVP FRs)
**Reason:** No formal pre-start validation gates, mid-development checkpoints, or pivot triggers exist in the PRD; their absence means high-risk architectural assumptions (Pi SDK GLM-5 cost model, Phase Boundary Protocol context isolation) go unvalidated before implementation begins.

**Original text:** N/A — new item

**Replacement text:**
```
## Appendix C: Go/No-Go Decision Framework

**Framework Purpose:** This appendix defines the objective criteria that govern whether development proceeds, pivots, descopes, or stops at each key decision point during QDS v2 development. It answers three questions at every gate: (1) What must be true before we proceed? (2) Who decides, and what evidence do they need? (3) What do we do if the criteria are not met?

**Decision Authority:** Steve (Product Owner / Lead Developer) + Co-Dev Marcus (as specified per gate).

---

### Gate 0: Pre-MVP-Start Gates

**Rule:** ALL three sub-gates must achieve PASS or CONDITIONAL PASS before implementation begins on any MVP epic. A single FAIL blocks the start and triggers the specified response. A CONDITIONAL PASS proceeds with the stated constraint logged as a tracked risk.

#### Gate 0-A: Pi SDK GLM-5 Availability and Cost Validation

**Purpose:** The entire economic model — adversarial quality pipeline at ~3–5% of development cost — depends on Pi SDK natively routing to GLM-5 at economy-tier prices. If false, the "$0.02/story quality pipeline" competitive differentiator is invalidated before the first line of code is written.

**Validation spike:** 2–4 hours. Send 10 representative prompts matching QA scout and BMAD reviewer role profiles. Record: model served, latency, token cost, routing errors. Compute projected per-story quality pipeline cost via: `(avg_cost_per_call × avg_calls_per_wave × 5_waves × 2) + (avg_cost_per_call × 3_bmad_agents × 2_passes)`.

| Criterion | PASS | CONDITIONAL PASS | FAIL |
|-----------|------|-----------------|------|
| GLM-5 accessible via Pi SDK economy tier | Confirmed, responses received | Accessible via fallback path (not native tier abstraction) | GLM-5 unavailable; Pi routes to higher-cost model |
| Per-story quality pipeline cost | ≤ $0.05/story | $0.05–$0.10/story | > $0.10/story |
| Latency per GLM-5 call | ≤ 8 seconds | 8–15 seconds | > 15 seconds |
| Pi SDK tool call support on GLM-5 | Tool calls work correctly | Work with prompt reformatting workaround | Tool calls not supported; Pi does not abstract this |
| Pi SDK native model switching (tier directive → model) | Pi selects GLM-5 when economy tier declared | Pi selects GLM-5 but requires explicit model name | Pi ignores tier directive; must hardcode model names |

**FAIL responses:**
- GLM-5 unavailable via Pi: investigate Pi SDK docs; test alternative economy model (Haiku, GPT-4o-mini) as stand-in. If no economy tier available, activate PT-1.
- Cost > $0.10/story: evaluate reduced wave count (3 vs. 5); evaluate OpenRouter. If cost cannot reach ≤ $0.10, activate PT-1.
- Latency > 15s/call: evaluate async parallel wave execution. If P95 wall-clock for full QA swarm > 120 seconds, activate PT-1.
- Tool calls unsupported: redesign BMAD reviewer and QA scout prompts for structured output without tool calls; validate quality minimum bar.
- Tier directive ignored: hardcode model names per agent role in `factory.yaml` as workaround. Not a blocker — log as technical debt.

**Decision authority:** Steve. **Time budget:** 1 developer-day maximum.

---

#### Gate 0-B: Phase Boundary Protocol Prototype Spike

**Purpose:** PBP is the single highest-design-risk component — greenfield, novel, co-dependent with hook infrastructure, and the foundation of the adversarial quality guarantee. Getting PBP wrong undermines both the quality pipeline and the learning system.

**Validation spike:** 3–5 days. Implement a minimal story end-to-end: (1) development phase produces a real phase transfer manifest; (2) all 6 phase boundary hook checks fire against it; (3) a fresh BMAD agent spins up with ONLY manifest contents; (4) verify the review agent can accurately identify spec compliance status from manifest-only context.

| Criterion | PASS | CONDITIONAL PASS | FAIL |
|-----------|------|-----------------|------|
| Manifest schema sufficient for BMAD | Review agent correctly identifies pass/fail using manifest-only context | Identifies pass/fail but misses nuance; manifest schema needs expansion | Cannot determine spec compliance from manifest alone; requires raw code context |
| Context isolation verified | Zero references to development-phase-only artifacts in BMAD output | BMAD references one artifact that was correctly surfaced in manifest | BMAD exhibits knowledge of development context not present in manifest (leakage) |
| Phase boundary hooks complete | All 6 gate checks fire correctly and block/pass appropriately | 5 of 6 work; one requires minor post-spike fix | < 5 checks work OR any check silently passes when it should block |
| Hook execution time | ≤ 60 seconds (NFR3) | 60–90 seconds | > 90 seconds |
| Manifest token overhead | ≤ 800 tokens | 800–1,200 tokens | > 1,200 tokens (approach must be redesigned) |
| Manifest completeness on failure | Manifest correctly captures failure state for learning system | Captures failure partially; supplement needed | Empty or misleading on failure |

**FAIL responses:**
- Context isolation FAIL or manifest sufficiency FAIL: HARD BLOCK. These are the core adversarial guarantees. Do not proceed until resolved and re-spiked.
- Hook timing FAIL only: proceed but prioritize async/parallel hook execution as the first hook infrastructure story. Resolve before the first real story is attempted.
- Manifest token FAIL only: redesign for progressive disclosure (summary by default, detail on request). Retest before proceeding.

**Decision authority:** Steve + Marcus joint (both developers must have confidence in the core technical architecture). **Time budget:** 3–5 developer-days.

---

#### Gate 0-C: CopilotKit + AG-UI Integration Feasibility

**Purpose:** The Dashboard Copilot (FR105–FR119) requires CopilotKit and AG-UI to integrate with the ZeroClaw-derived React dashboard. Validate feasibility before building the full dashboard.

**Validation test:** 1–2 days. Install CopilotKit into the ZeroClaw dashboard fork; implement one `useCopilotReadable` hook and one `useCopilotAction` hook; connect an AG-UI streaming endpoint; verify end-to-end query and action execution.

| Criterion | PASS | CONDITIONAL PASS | FAIL |
|-----------|------|-----------------|------|
| CopilotKit installs without conflicts | No dependency conflicts with React 19 + Vite + Tailwind | Conflicts resolved with peer dependency overrides | Irreconcilable conflicts requiring React version downgrade |
| `useCopilotReadable` works | Dashboard state surfaces in copilot context correctly | Works with manual serialization workaround | Data does not surface |
| `useCopilotAction` works | Action fires correctly; UI updates visibly | Fires with additional event bridging | Does not execute |
| Economy-tier model routing for copilot | GLM-5 serves copilot queries at ≤ $0.002/query | GLM-5 serves at $0.002–$0.005/query | Only standard/premium model works for copilot |
| AG-UI streaming latency | First token within 3 seconds (NFR8) | First token 3–5 seconds | First token > 5 seconds |
| Dashboard performance (12 xterm panels + chat bar) | Maintains NFR5 (30fps) | Drops to 25–28fps (marginal) | Drops below 20fps (unacceptable) |

**FAIL responses:**
- Any FAIL on copilot readable/action/streaming: defer Dashboard Copilot to Growth. Remove FR105–FR119 from MVP scope. Dashboard ships without conversational control plane.
- Performance FAIL: evaluate lazy-loading the copilot component in a separate React subtree. If performance cannot be maintained, defer to Growth.
- Integration takes > 2 days: treat as CONDITIONAL FAIL — complexity itself is a signal.

**Decision authority:** Marcus (primary) with Steve sign-off. **Time budget:** 1–2 developer-days.

---

#### Gate 0 Summary

| Gate | Scope | Decision Authority | Must Complete Before |
|------|-------|-------------------|----------------------|
| 0-A: Pi SDK GLM-5 Cost | Economy-tier availability and cost validation | Steve | Any MVP implementation begins |
| 0-B: Phase Boundary Protocol | Context isolation and manifest spike | Steve + Marcus joint | Any MVP implementation begins |
| 0-C: CopilotKit + AG-UI | Dashboard Copilot integration feasibility | Marcus + Steve | Dashboard implementation begins |

**Overall Gate 0 Result:** All three sub-gates must be PASS or CONDITIONAL PASS (with constraints documented) for MVP implementation to begin.

---

### Mid-Development Checkpoints

Development completion percentage is measured against total MVP story points accepted (definition of done met, merged to main). Each checkpoint evaluation takes no more than 2 hours. Output: written checkpoint record at `_bmad-output/planning-artifacts/checkpoint-[CP-id]-[YYYY-MM-DD].md`.

See **Amendment 8** (Project Scoping → Risk Mitigation → Burn-Rate Checkpoints) for the burn-rate gate thresholds and deferral priority tables at each checkpoint. The following sections add velocity and quality gates.

#### CP-25: 25% MVP Completion

| Metric | GREEN | YELLOW | RED |
|--------|-------|--------|-----|
| Stories accepted vs. planned | ≥ 90% of planned | 75–90% | < 75% |
| Stories blocked > 5 days without progress | 0 | 1 | ≥ 2 |
| Phase Boundary Protocol (critical path item 4) started | Yes, with Gate 0-B findings applied | Started, findings not yet applied | Not started |
| Critical path items 1–5 on schedule | All on schedule or ahead | 1 item behind ≤ 1 week | Any item > 1 week behind, or 2+ behind |
| Actual hours vs. projected at 25% | ≤ 115% | 115–135% | > 135% |

**CP-25 action rules:**
- All GREEN: proceed, no scope changes.
- Any YELLOW, no RED: document and monitor closely. No scope changes yet.
- Velocity RED OR burn rate RED: apply deferral table (see Amendment 8), starting from priority 1.
- Critical path RED: assess whether Phase Boundary Protocol or Hook Infrastructure is the blocker; if so, escalate to PT-2 evaluation.
- Multiple RED: convene within 24 hours. Apply deferral table. If deferral does not bring plan to YELLOW within 1 sprint, activate PT-3.

**Decision authority:** Steve.

---

#### CP-50: 50% MVP Completion

**Factory Smoke Test (required before metrics review):** Run one complete story through the factory end-to-end at 50% completion. This is the most honest integration health signal — metrics alone will not reveal integration gaps.

| Smoke Test Result | Weight |
|------------------|--------|
| Story completes all 5 phases, PR created | GREEN — proceed to metrics with confidence |
| Story completes develop + BMAD but fails QA or PR | YELLOW — proceed; flag integration gaps |
| Story completes develop phase only | RED — integration is the primary problem; metrics are secondary |
| Story cannot complete develop phase | CRITICAL — stop metrics review; convene root cause session |

| Metric | GREEN | YELLOW | RED |
|--------|-------|--------|-----|
| Stories accepted vs. planned | ≥ 90% | 75–90% | < 75% |
| Critical path items 1–5 complete | All 5 | 4 of 5 | < 4 |
| BMAD context isolation verified in smoke test | Zero context leakage | Leakage in 1 non-critical area | Any structural leakage |
| Phase boundary hook execution time | ≤ 60 seconds (NFR3) | 60–90 seconds | > 90 seconds |
| Cumulative hours vs. projected | ≤ 120% | 120–150% | > 150% |
| Per-story quality pipeline cost (from smoke test) | ≤ $0.05/story | $0.05–$0.10/story | > $0.10/story |

**CP-50 action rules:**
- Smoke test CRITICAL: stop. Do not proceed to metrics. The architecture has a fundamental integration problem.
- Quality gate RED on context isolation: do not defer. This is the core adversarial guarantee. Resolve before proceeding.
- Burn rate > 150%: apply deferral table from Amendment 8 (CP-50 column). Compute revised completion date. If revised date places MVP launch > 6 weeks from CP-50, evaluate PT-3.

**Decision authority:** Steve + Marcus joint.

---

#### CP-75: 75% MVP Completion

**Launch readiness assessment:** CP-75's primary purpose is answering "Can we set a firm MVP launch date?"

| Factor | GREEN (set date) | YELLOW (provisional date) | RED (no date yet) |
|--------|-----------------|---------------------------|-------------------|
| End-to-end stories run reliably | ≥ 3 of 3 without manual intervention | 2 of 3; 1 required intervention | < 2 complete reliably |
| SSE dashboard latency | < 2 seconds (NFR1) | 2–5 seconds | > 5 seconds or unreliable |
| 3 concurrent stories without contamination | Yes | 2 work; 3rd requires restart | Parallelism not functional |
| Setup script works for Marcus (clean machine) | Yes, completed successfully | Runs with 1–2 documented workarounds | Does not complete |
| Per-story cost within model | ≤ $2.50 average for medium story | $2.50–$4.00 | > $4.00 or unknown |
| Hours remaining for final 25% vs. estimate | ≤ 110% | 110–140% | > 140% or any P0 bug |

**Final deferral decisions:** Any FR not yet explicitly deferred must receive a SHIP or DEFER decision at CP-75. Nothing enters the final sprint in ambiguous status.

**Decision authority:** Steve. Marcus must confirm independent instance works.

---

### MVP Launch Gate: Minimum Viable FR Set

The following 22 FR groups are non-negotiable for a real MVP. If any is absent or non-functional, the system is a prototype — the launch is a NO-GO.

**Pipeline completeness:**

| FR | Capability | Why Non-Negotiable |
|----|------------|-------------------|
| FR1–FR8 | 5-phase pipeline (Intake → Develop → BMAD → QA → PR) for Story work type | Without end-to-end story execution, there is no factory |
| FR9 | Task work type with minimal pipeline | MVP is defined as Story + Task; Task is required |
| FR10–FR13 | BMAD adversarial review with context-isolated fresh agents | Context isolation is the core adversarial guarantee; without it, BMAD is not adversarial |
| FR14–FR20 | 6-layer hook enforcement (all 6 layers functional) | Without hooks, the factory ships unvalidated code; quality guarantee is void |
| FR21–FR24 | Agent orchestration (spawn, monitor, recover, checkpoint) | Without recovery and checkpoint, long-running stories are unreliable |
| FR28–FR35 | Overlay composition pipeline (all 6 stages functional) | Context management is the enabling infrastructure for everything else |
| FR36–FR42 | Resource and economic management (tier directives, budget tracking, circuit breakers, attribution) | Without circuit breakers, the factory can exhaust API budgets undetected |
| FR51–FR53 | Git safety iron laws and PR creation | Without git safety, the factory is a liability; without PR creation, there is no deliverable |

**Dashboard minimum:**

| FR | Capability | Why Non-Negotiable |
|----|------------|-------------------|
| FR43 | Factory Overview (system health, active stories, API key status, token budget) | Developer needs situational awareness at a glance |
| FR44 | Agent Windows with live xterm.js output | Stall recovery (Journey 2) is impossible without inspecting agent output |
| FR45 | Story pipeline phase progression | Developer needs to know where each story is in the pipeline |
| FR47 | Stall detection with type classification | Without classification, every stall requires full manual inspection |
| FR25–FR27 | Stop, Nudge, Inspect controls | These are the developer's recovery tools; without them, stalled stories are only resolvable by killing the factory |
| FR50 | Dashboard crash does not halt agents | Non-negotiable reliability guarantee |

**Factory Learning System minimum:**

| FR | Capability | Why Non-Negotiable |
|----|------------|-------------------|
| FR55–FR58 | Learning record writes, outcome tags, loop 1 (mail), loop 2 (manifest) | Without all three loops, the factory does not learn; the core self-improvement promise is undelivered |
| FR61 | Overlay injection from synthesized learnings | Without injection, accumulated learnings have no effect on agent behavior |

**Developer operations minimum:**

| FR | Capability | Why Non-Negotiable |
|----|------------|-------------------|
| FR69 | Setup script with dependency verification | Without this, Marcus cannot configure an independent instance |
| FR70 | Per-developer config (`factory.yaml`) | Without per-developer API keys and budgets, the two-developer model is impossible |
| FR71 | Independent dashboard instances | Without independent instances, two developers cannot work concurrently |

**Launch gate decision table:**

| Non-Negotiable FRs Present | Hard NFR Minimums Met | Learning System Quality Bars Met | Launch Decision |
|----------------------------|-----------------------|----------------------------------|----------------|
| YES | YES | YES | GO — launch MVP |
| YES | YES | NO | CONDITIONAL GO — launch with learning system defect tracked as P1; fix within 1 sprint post-launch |
| YES | NO (one NFR fails) | ANY | NO-GO — fix the failing NFR; re-evaluate |
| NO (any non-negotiable FR missing) | ANY | ANY | NO-GO — incomplete MVP; do not use as primary workflow |

**Hard NFR minimums for launch:** NFR1 (SSE latency < 2s), NFR3 (phase gate ≤ 60s), NFR9 (zero API key agent visibility), NFR10 (zero API key in factory output), NFR11 (agent filesystem access hard-restricted to worktree), NFR12 (factory.yaml excluded from version control), NFR14 (agent crash detection < 10s; replacement < 30s), NFR15 (story checkpoint/resume, zero data loss), NFR16 (learning record atomic writes), NFR17 (SQLite concurrent access, 15 agents, zero silent failures), NFR22 (quality pipeline cost ≤ 5% of story cost), NFR23 (setup script < 5 minutes on clean machine), NFR24 (macOS + Linux both pass).

**Decision authority:** Steve (final decision). Marcus must confirm independent instance works from co-dev perspective.

---

### Scope Deferral Priority Order

Under any scope pressure, features are deferred in this order. Stop deferring when the plan recovers to YELLOW or better.

| Priority | FR(s) | Feature | Deferral Impact | Trigger Threshold |
|----------|-------|---------|----------------|-------------------|
| 1 | FR105–FR119 | Dashboard Copilot (CopilotKit + AG-UI) | UX reduction; dashboard operates without conversational control plane | Any RED at CP-25, OR burn rate YELLOW + velocity YELLOW simultaneously |
| 2 | FR77–FR89 | Meta-Optimization (daily + weekly cron observers) | Factory self-improvement deferred; manual analysis only | Velocity RED, OR 2 meta-optimization stories blocked > 5 days |
| 3 | FR120–FR129 | Telegram Developer Communication Layer | Notification via dashboard only; no mobile alerts | Burn rate RED, OR meta-optimization already deferred |
| 4 | FR164–FR168 | Self-Learning System extensions (maintenance extraction, pattern accumulation, epic context, overlay enrichment, burden tracking) | Factory learning exists (FR55–FR63) but does not accumulate cross-story patterns beyond basic synthesis | Only if ALL of 1–3 already deferred AND critical path still RED — evaluate PT-3 first |
| 5 | FR91–FR104 subset | Resilience polish (FR92 file contention, FR98 learning retention, FR100 drift monitoring, FR102 BMAD profiles) | Resilience reduced; MVP operates without these guardrails | Burn rate > 150% AND velocity RED at CP-50 |
| 6 | FR130–FR132 | Agent Performance Data Collection (action scoring, calibration, session composites) | Growth behavioral system (ELO, tiers) loses its data foundation; every week without this delays Growth readiness equivalently | ONLY if items 1–5 already deferred AND still RED; this is the last resort |

**Rule:** If items 1–3 are all deferred and the critical path is still RED, escalate to PT-3 evaluation rather than deferring item 4. FR164–FR168 is a core innovation, not a polish feature.

---

### Pivot Triggers (PT-1 through PT-5)

Pivot triggers are pre-defined scenarios requiring a fundamental response rather than incremental adjustment. Declaring a pivot trigger suspends normal development and initiates a structured evaluation session within the defined timebox.

#### PT-1: Pi SDK Economy-Tier Cost Unviable

**Trigger:** Pi SDK GLM-5 quality pipeline cost > $0.10/story (BMAD + QA combined), OR Pi SDK does not natively support economy-tier routing transparently.

**Why fundamental:** The competitive differentiator "quality pipeline is economically negligible" collapses. The adversarial quality guarantee becomes optional under developer pressure.

**Response options (2-day timebox; Steve decides):**

| Option | Description | Go Criteria |
|--------|-------------|-------------|
| A: OpenRouter fallback | Route economy-tier calls through OpenRouter; use cheapest model supporting tool calls | Cost ≤ $0.05/story AND quality equivalent |
| B: Reduced wave count | 3 waves vs. 5; maintain full BMAD | Projected cost ≤ $0.05/story; BMAD catch rate unaffected |
| C: Defer economy routing to Growth | Pin all agents to standard tier (Sonnet) for MVP | Per-story cost including standard-tier QA ≤ $0.50; team accepts cost model change |
| D: Remove QA swarm from MVP | Ship with BMAD only; defer 5-wave QA to Growth | BMAD catch rate sufficient without QA; team accepts reduced quality guarantee |

**Default if undecided by 2-day deadline:** Option C (defer economy routing).

---

#### PT-2: Phase Boundary Protocol Design Failure

**Trigger:** Gate 0-B FAILS on context isolation OR manifest sufficiency, AND failure cannot be resolved within a 2-week redesign sprint.

**Why fundamental:** Without genuine context isolation, BMAD review agents are not adversarial. The core guarantee is violated. The PRD is explicit: "Context isolation is non-negotiable."

**Response options (3-day timebox; Steve + Marcus joint):**

| Option | Description | Go Criteria |
|--------|-------------|-------------|
| A: Heavier manifest schema | Expand manifest contents; accept higher token overhead | Context isolation verified with expanded manifest; total manifest ≤ 2,000 tokens |
| B: Filesystem-based handoff | BMAD agents receive read-only worktree snapshot at phase boundary | Zero context leakage verified; snapshot read-only enforced at process level |
| C: Defer adversarial review to Growth | MVP ships with intra-agent review (not adversarial); "adversarial" removed from MVP messaging | Team explicitly acknowledges quality guarantee is weakened |
| D: Full architecture review | Suspend development 1 week; re-examine Overstory + Pi SDK context isolation fundamentals | Only if A and B both fail |

**Default if undecided:** Option B (filesystem snapshot handoff).

---

#### PT-3: Development Velocity Collapse

**Trigger:** At any checkpoint, projected MVP completion exceeds 16 weeks from start AND delay is due to scope complexity (not external blockers).

**Why fundamental:** 4-month MVP for a 2-developer internal tool means opportunity cost may exceed full-scope value. This trigger forces a scope conversation, not a schedule slip.

**Response (1-day timebox; Steve decides):** Apply scope reduction in order until projected completion is within 12 weeks:

| Level | Scope Removed | FRs Affected |
|-------|--------------|-------------|
| 1 | Dashboard Copilot | FR105–FR119 |
| 2 | Meta-Optimization | FR77–FR89 |
| 3 | Telegram Communication | FR120–FR129 |
| 4 | Self-Learning System extensions | FR164–FR168 |
| 5 | Dashboard reduced to core only | FR45, FR49, FR47 deferred |
| 6 (last resort) | Task work type deferred | FR9 |

Levels 1–3 together save ~20–25% of MVP scope. If they are insufficient to bring the date within 12 weeks, the architecture itself needs re-examination — this table cannot solve that.

---

#### PT-4: `gh` CLI Dependency Failure

**Trigger:** `gh` CLI is not viable as the GitHub integration mechanism (auth issues, rate limits, or API changes that break PR creation before MVP launch).

**Why pivot:** PR creation is the delivery mechanism of the entire factory. Without it, every story completes but delivers nothing.

**Response (3–5 days to implement; Marcus + Steve):**
- **Direct GitHub REST API:** Replace `gh` CLI with direct `fetch()` to GitHub REST API (PAT in `factory.yaml`). 2–3 developer-days.
- **Octokit SDK:** Replace `gh` CLI with the official GitHub SDK. 3–5 developer-days.

Neither option is a strategic re-scoping. This is a 3–5 day implementation task.

---

#### PT-5: Factory Learning System Quality Failure

**Trigger:** After 30 days of MVP operation, the Factory Learning System is net negative — stories where relevant scope has active synthesized learnings fail at BMAD or QA at a HIGHER rate than stories in unlearned scopes.

**Why fundamental:** The learning system is the deepest competitive moat. If it is injecting wrong guidance, it is actively harmful.

**Response:**
1. **Immediate:** Set `learning_injection_level: none` in `factory.yaml`. Factory continues operating without learnings.
2. **Investigation (3 days):** Audit all active synthesized learnings; identify the class producing wrong guidance.
3. **Fix or defer:** If synthesis bugs (fixable) → fix synthesis script; re-enable injection for critical tier only. If fundamental over-generalization → defer learning injection to Growth; ship MVP with learning records collected but not injected; resolve architecture in Growth.

**Measurement:** BMAD correction rate in scopes with active learnings vs. scopes without (15% reduction minimum bar from Innovation validation section).

**Decision authority:** Steve.

---

#### Pivot Trigger Summary

| Trigger | Condition | Timebox | Decision Authority | Default if Undecided |
|---------|-----------|---------|-------------------|---------------------|
| PT-1: Economy-tier cost | Quality pipeline > $0.10/story | 2 days | Steve | Option C (defer economy routing) |
| PT-2: PBP design failure | Context isolation cannot be verified | 3 days | Steve + Marcus | Option B (filesystem snapshot) |
| PT-3: Velocity collapse | Projected completion > 16 weeks | 1 day | Steve | Apply scope reduction levels 1–3 |
| PT-4: `gh` CLI failure | PR creation not viable | 3–5 days to implement | Marcus + Steve | Direct GitHub REST API |
| PT-5: Learning system net negative | Injection increases failure rate after 30 days | Immediate disable; 3-day investigation | Steve | Disable injection; investigate |

---

### Decision Accountability Matrix

| Decision Type | Primary Decision Maker | Input Required From | Notes |
|---------------|----------------------|--------------------|----|
| Gate 0-A pass/fail (Pi SDK cost) | Steve | Spike output data | |
| Gate 0-B pass/fail (PBP spike) | Steve + Marcus joint | Spike output + both developers' written assessment | Neither can override the other |
| Gate 0-C pass/fail (CopilotKit) | Marcus | Performance metrics + dependency tree | Steve can override to PASS if strategic priority warrants |
| CP-25 scope deferral | Steve | Sprint velocity, burn rate data | |
| CP-50 smoke test failure response | Steve + Marcus joint | Smoke test output | Steve can override Marcus on non-architectural decisions |
| CP-50 scope deferral | Steve | Marcus input on implementation dependency chain | |
| CP-75 launch date setting | Steve | Marcus confirmation that co-dev instance works | |
| MVP launch go/no-go | Steve | Marcus sign-off on independent instance | Steve has final call |
| Pivot trigger activation | Steve (PT-1, PT-3, PT-4, PT-5) or Steve + Marcus (PT-2) | Per individual trigger | |
| FR deferral from MVP to Growth | Steve | Marcus input on implementation dependency chain | |

**Escalation rules:**
1. Any decision that changes the core product promise (adversarial review guarantee, context isolation, economy-tier routing as differentiator) requires Steve + Marcus joint decision regardless of category.
2. Any decision made under time pressure (< 24 hours) defaults to the conservative option documented in the relevant pivot trigger table. "When in doubt, defer" applies to features. "When in doubt, do not compromise" applies to quality guarantees.
3. Disputed decisions (Steve and Marcus disagree) default to the more conservative option (smaller scope, higher quality bar, longer timeline). Disputes must be resolved by finding a position both parties can commit to — there is no tiebreaker.
4. No unilateral scope additions to MVP. New scope is always Growth-first; pulling it to MVP requires a joint decision.

**Documentation standard:** Every gate decision produces a written checkpoint record at `_bmad-output/planning-artifacts/checkpoint-[gate-id]-[YYYY-MM-DD].md`. Every pivot trigger decision uses `pivot-[PT-id]-[YYYY-MM-DD].md`. Minimum content: gate ID and date, each criterion with status (PASS/CONDITIONAL/FAIL), evidence reviewed, decision made, constraints logged, and names of decision makers present.
```
---

*Amendment batch complete. 9 amendments covering all items from the competitive landscape analysis and go/no-go framework analysis. Apply in order; amendments 1–3 affect the same section (Innovation & Novel Patterns + Executive Summary) and should be reviewed together before editing to ensure paragraph flow.*
```
