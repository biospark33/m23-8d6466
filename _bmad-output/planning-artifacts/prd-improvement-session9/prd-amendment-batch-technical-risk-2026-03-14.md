# PRD Amendment Batch: Technical Risk Resolution
**Source PRD:** prd-v2.md (v2.0, 2026-03-10)
**Amendment Date:** 2026-03-14
**Analyses Applied:**
- prd-analysis-assumption-validation-2026-03-14.md
- prd-analysis-integration-contracts-2026-03-14.md
- prd-analysis-cost-model-validation-2026-03-14.md

**Scope:** FR36, FR42, FR105–FR119, NFR22, Implementation Sequencing, Risk Mitigation sections

**Amendment count:** 9

---

## AMENDMENT 1: NFR22 — COST CEILING PRECISION AND GLM-5 PRICING GOVERNANCE
**Type:** MODIFY_NFR
**Target:** NFR22
**Reason:** The cost model validation analysis found that NFR22's 5% threshold is unverifiable without an explicit GLM-5 pricing assumption, is violated by small stories even at the assumed price, and contains no escape-valve logic for the scenario where Pi SDK economy routing is unavailable and falls back to Opus 4.6 pricing (which inverts the value proposition entirely).

**Original text:**
> **NFR22:** Quality pipeline cost (BMAD review + QA swarm phases combined) must not exceed 5% of total story cost as measured by attribution chain cost aggregation per phase

**Replacement text:**
> **NFR22:** Quality pipeline cost (BMAD review + QA swarm phases combined) must not exceed 5% of total story cost as measured by attribution chain cost aggregation per phase, subject to the following conditions and constraints:
>
> *(a) Minimum story size floor.* NFR22 applies only to stories whose development-phase token consumption exceeds 40,000 tokens (approximately a 4–5 file, medium-complexity story). Stories below this threshold are exempt from the 5% ceiling because the fixed BMAD agent overlay cost (~6,000 input tokens × 3 review agents) is disproportionate relative to a minimal development spend; for such stories a flat-rate quality cost ceiling of $0.10 applies instead.
>
> *(b) GLM-5 pricing assumption and break-even threshold.* The 5% ceiling is predicated on GLM-5 (economy-tier model) being available via Pi SDK at a price of no more than $0.30 per million tokens blended (input + output). This assumption must be confirmed empirically during the economy-tier validation spike before MVP sprint 1. If confirmed GLM-5 pricing via Pi SDK falls between $0.30–$0.60/M tokens, NFR22's ceiling is revised to 8%; if it exceeds $0.60/M tokens, the economy-tier architecture must be re-evaluated before this NFR is considered binding. The spike-confirmed price must be recorded in `factory.yaml` as `economy_tier_price_per_million_tokens` and referenced in the acceptance test for this NFR.
>
> *(c) Minimum verification sample.* NFR22 is not considered validated until quality pipeline cost has been measured across a minimum of 10 completed stories spanning at least two story size categories (small/medium or medium/large). Single-story measurements are insufficient to validate this NFR due to phase cost variance.
>
> *(d) Pi SDK fallback behavior.* If Pi SDK economy-tier routing is unavailable and the factory falls back to a non-economy model for BMAD review or QA swarm execution, NFR22 is considered suspended (not failed) for the duration of the outage. Suspended NFR22 status must be surfaced in the dashboard cost breakdown with an explicit "economy routing unavailable" indicator. The preferred documented fallback for economy-tier routing is OpenRouter Gemini Flash (~$0.075/M tokens blended) — not Opus 4.6. Opus 4.6 fallback for economy-tier roles is explicitly prohibited because it produces a quality pipeline cost of approximately 61% of story total, destroying the value proposition. If the factory cannot route to either GLM-5 via Pi SDK or Gemini Flash via OpenRouter, economy-tier dependent phases (BMAD review scouts, QA swarm scouts) must be halted with developer notification rather than silently escalated to premium tier.

---

## AMENDMENT 2: FR36 — MODEL IDENTIFIER REPORTING REQUIREMENT
**Type:** MODIFY_FR
**Target:** FR36
**Reason:** The integration contracts analysis identified that tier routing verification is impossible without Pi SDK exposing the actual model identifier used per call; without this, the attribution chain (FR42) cannot confirm which model executed a given agent turn, making NFR22 measurements unauditable and tier policy enforcement blind.

**Original text:**
> **FR36:** Factory Core can assign model tier directives (economy / standard / premium) per agent role, with Pi SDK executing model selection natively

**Replacement text:**
> **FR36:** Factory Core can assign model tier directives (economy / standard / premium) per agent role, with Pi SDK executing model selection natively. Pi SDK must return the resolved model identifier (e.g., `glm-5`, `claude-sonnet-4-5`, `claude-opus-4-6`) in every call response alongside token and cost data; Factory Core must record this identifier in `attribution.db` as the `resolved_model` field on each attribution record. This requirement is necessary for: (a) verifying that tier directives are honored by Pi SDK in practice, not just in configuration; (b) detecting silent tier escalations (Pi routing an economy-tier request to a standard-tier model due to model unavailability); (c) enabling NFR22 cost measurements to be segmented by actual model used rather than intended tier. If Pi SDK does not natively expose the resolved model identifier, Factory Core must implement a verification wrapper that queries Pi SDK's session metadata or logs to reconstruct model identity per call before storing attribution records.
>
> *Implementation dependency:* The Pi SDK integration spike (see Validation Spike section) must confirm that Pi SDK exposes a resolved model identifier per call before FR36 implementation begins. If Pi SDK does not provide this, the spike must document the workaround approach and its reliability limitations.

---

## AMENDMENT 3: RISK MITIGATION — PI SDK PRICING AND ECONOMY-TIER ROUTING
**Type:** MODIFY_SECTION
**Target:** Risk Mitigation (Innovation Experiments section — the risk mitigation table row for "Coordination-Over-External-Runtimes")
**Reason:** The cost model validation analysis established that Pi SDK unavailability is not a minor degradation — it is a value-proposition-inverting event; the current fallback ("Pin Pi to a single model (Opus 4.6 for all tiers)") is economically catastrophic and must be replaced with the correct fallback; and there is no explicit go/no-go threshold for Pi SDK economy pricing, which must exist before MVP scope lock.

**Original text:**
> | Coordination-Over-External-Runtimes | Pi SDK model switching doesn't perform as expected for certain tiers | Pin Pi to a single model (Opus 4.6 for all tiers), treat economy-tier routing as Growth. Lose cost optimization but core pipeline still works. | Medium — loses economic optimization but functionally viable |

**Replacement text:**
> | Coordination-Over-External-Runtimes | **Risk A — Pi SDK model switching not available or unreliable for economy tier.** Pi SDK model switching doesn't perform as expected for certain tiers, or GLM-5 is not natively available through Pi SDK. | **Fallback: Redefine economy tier as OpenRouter Gemini Flash (~$0.075/M tokens blended).** Do NOT fall back to Opus 4.6 for economy-tier roles — this produces a quality pipeline cost of ~61% of story total and destroys the value proposition. Treat Pi-native GLM-5 routing as an optimization over the OpenRouter baseline, not a hard dependency. Factory Core's tier directive layer must support both routing paths with a configuration switch. | Medium — loses Pi-specific economy routing but retains the "quality feels free" claim via OpenRouter |
> | Coordination-Over-External-Runtimes | **Risk B — GLM-5 pricing via Pi SDK exceeds the NFR22 break-even threshold.** GLM-5 priced above $0.60/M tokens blended makes the 5% quality cost ceiling unachievable on medium stories and puts the "quality feels free" narrative at risk. | **Go/no-go gate:** Economy-tier validation spike must confirm actual Pi SDK GLM-5 pricing before MVP sprint 1. If pricing is $0.30–$0.60/M: revise NFR22 ceiling to 8%, update Journey 1 cost figures to reflect actual economics, adjust marketing copy from "feels free" to "radically cheap." If pricing exceeds $0.60/M: redesign quality pipeline — options are (a) reduce BMAD team from 3 agents to 1, (b) reduce QA swarm default wave count from 5 to 2, (c) migrate economy tier to OpenRouter Gemini Flash regardless of Pi SDK availability. | High — affects core differentiation claim and may require pipeline architecture change |

---

## AMENDMENT 4: NEW FR — MINIMUM STORY SIZE FLOOR FOR ECONOMY-TIER QUALITY PIPELINE
**Type:** NEW_FR
**Target:** Resource & Economic Management section (after FR42)
**Reason:** The cost model validation analysis found that small stories (2–3 file scope, development-phase token consumption below ~40,000 tokens) breach the NFR22 5% ceiling even at the assumed GLM-5 pricing due to the fixed per-agent BMAD overlay cost (~6,000 input tokens × 3 review agents); the PRD has no mechanism to route small stories through a lighter quality pipeline or apply the alternative flat-rate ceiling.

**Original text:**
N/A — new item

**Replacement text:**
> **FR42a:** Factory Core can classify a story as "small" (development-phase token consumption below 40,000 tokens, or story scope limited to 1–3 files with no new module creation) and apply a reduced quality pipeline configuration for such stories: single-agent BMAD review (replacing the default 3-agent adversarial team), and a 2-wave QA swarm minimum (replacing the default 5-wave baseline). For small stories, the NFR22 quality cost threshold is replaced by the flat-rate ceiling defined in NFR22(a) ($0.10). Factory Core must log the applied pipeline configuration (standard vs. small-story) in the story manifest so quality cost measurements can be correctly segmented. Small-story classification must be performed during intake phase based on scope analysis, not retroactively. The developer may override small-story classification to force the full pipeline via `factory.yaml` (`quality.enforce_full_pipeline_min_files: N`).
>
> *Rationale:* Without this requirement, NFR22 creates a perverse incentive to avoid running the quality pipeline on small stories — which are often the most bug-prone due to rushed scope assumptions. The flat-rate ceiling preserves quality pipeline coverage on small stories while removing the misleading percentage metric where fixed overhead dominates.

---

## AMENDMENT 5: FR36 + IMPLEMENTATION SEQUENCING — PI SDK ARCHITECTURE RESOLUTION AS EXPLICIT DEPENDENCY
**Type:** MODIFY_SECTION
**Target:** Implementation Sequencing section
**Reason:** The integration contracts analysis identified that Pi SDK's architecture (library vs. sidecar vs. service) is entirely undocumented in the PRD and that this ambiguity has cascading architectural consequences for deployment, startup, failure modes, and the "Overstory runs inside Pi" relationship — all of which must be resolved before implementation can begin on any item in the critical path.

**Original text:**
> ### Implementation Sequencing
>
> The source project dependencies and hook co-dependency define a natural implementation sequence:
>
> ```
> Sequential (dependency chain):
>   1. Pi SDK integration (runtime — everything runs on this)
>   2. Overstory extensions (agent lifecycle — everything uses this)
>   3. Hook infrastructure (enforcement runner — gates need this)
>   4. Phase Boundary Protocol + hook integration (novel piece, co-dependent with hooks)
>   5. Superpowers consumption (overlay injection + extended frontmatter for hooks)
>
> Parallelizable (after item 2):
>   6a. ZeroClaw dashboard fork (UI shell + factory pages) — can develop alongside 3-5
>   6b. claude-mem → Mulch extensions (memory layer) — can develop alongside 6a
>   6c. Factory Learning System (loops 1-3, synthesis script) — can develop alongside 6a-6b
>
> With 2 developers:
>   Developer A: items 1 → 2 → 3 → 4 → 5 (critical path)
>   Developer B: items 6a (dashboard) → 6b (Mulch) → 6c (learning system) — parallel track
>   Integration: merge tracks after item 5, integrate dashboard with hook enforcement and phase boundary visualization
> ```

**Replacement text:**
> ### Validation Spikes (Prerequisite — Before Any Coding Begins)
>
> The following spikes are mandatory prerequisites. No implementation work on any numbered item below may begin until the corresponding spike is complete and its go/no-go criteria are satisfied. Spikes produce data and proof-of-concept code, not production-shippable features.
>
> **Spike 1 — Pi SDK Architecture and Economy-Tier Confirmation (Week 1, Developer A)**
> Answers: (a) Is Pi SDK a library, sidecar process, or hosted service? (b) Does Pi SDK expose a resolved model identifier per call? (c) Is GLM-5 available via Pi SDK natively, or is OpenRouter required? (d) What is the actual per-token price for GLM-5 via Pi SDK? (e) What does "Overstory runs inside Pi" mean at the code level? (f) Does Pi return per-call cost/token data for all supported models?
> *Output required:* Working proof-of-concept that spawns one agent via Pi, routes it through economy tier and premium tier, returns a response with verifiable cost and model identifier. Confirmed GLM-5 price recorded in `factory.yaml`.
> *Go/no-go:* Spike must complete before Item 1 implementation begins. If Pi SDK architecture cannot be confirmed, Item 1 design must be revised to treat Pi SDK as an adapter pattern with a pluggable backend rather than a direct integration.
>
> **Spike 2 — CopilotKit + AG-UI Feasibility (Week 1, Developer B — parallel with Spike 1)**
> Answers: (a) How is CopilotKit configured to use Pi SDK as its backend instead of CopilotKit cloud? (b) What is AG-UI Protocol exactly — is it a CopilotKit-native feature, a separate package, or a draft standard requiring independent implementation? (c) Does the CopilotKit + xterm.js combination maintain 30fps in a real browser test with 12 panels? (d) Can multi-step investigation (FR107, FR114) be demonstrated with the current SDK versions?
> *Output required:* Working dashboard test with CopilotKit chat bar + 12 xterm.js panels; measured FPS and SSE latency; demonstration of at least Ask mode via Pi SDK backend.
> *Go/no-go:* If AG-UI Protocol is unavailable, immature, or not compatible with the target dashboard architecture, FR107 (Investigate mode), FR113 (bidirectional streaming), FR114 (multi-step investigations), and FR115 (visible step indicators) are deferred to Growth. Dashboard Copilot MVP scope is reduced to Ask mode only (FR106) plus Act mode via simple `useCopilotAction` hooks (FR108–FR112). This deferral must be formally decided before the Dashboard Copilot epic begins, not discovered mid-sprint.
>
> **Spike 3 — Overstory Extension Point Validation (Week 2, Developer A — after Spike 1)**
> Answers: (a) Do Overstory's current extension points support overlay injection, tier directive plumbing, hook runner integration, and new mail type registration without forking? (b) Does Overstory expose an event stream suitable for dashboard SSE, or must this be added? (c) Does Overstory's transaction layer pass a 15-agent concurrent write/mail stress test?
> *Output required:* Documented extension point inventory with fork-required vs. extend-via-API classification for each required modification.
> *Go/no-go:* If any required extension point requires forking Overstory, the implementation estimate for Item 2 must be revised upward and the fork maintenance strategy must be documented before proceeding.
>
> ### Implementation Sequencing
>
> The source project dependencies and hook co-dependency define a natural implementation sequence. All spikes above must be complete before beginning Item 1.
>
> ```
> Pre-implementation (mandatory):
>   Spike 1: Pi SDK architecture + economy-tier confirmation (Week 1, Dev A)
>   Spike 2: CopilotKit + AG-UI feasibility (Week 1, Dev B — parallel)
>   Spike 3: Overstory extension point validation (Week 2, Dev A — after Spike 1)
>
> Sequential (dependency chain):
>   1. Pi SDK integration (runtime — everything runs on this; Pi SDK architecture confirmed by Spike 1)
>   2. Overstory extensions (agent lifecycle — extension points confirmed by Spike 3)
>   3. Hook infrastructure (enforcement runner — gates need this)
>   4. Phase Boundary Protocol + hook integration (novel piece, co-dependent with hooks)
>   5. Superpowers consumption (overlay injection + extended frontmatter for hooks)
>
> Parallelizable (after Item 2):
>   6a. ZeroClaw dashboard fork (UI shell + factory pages) — can develop alongside 3-5;
>       Dashboard Copilot scope (FR106-FR119) finalized based on Spike 2 outcome
>   6b. claude-mem → Mulch extensions (memory layer) — can develop alongside 6a
>   6c. Factory Learning System (loops 1-3, synthesis script) — can develop alongside 6a-6b
>
> With 2 developers:
>   Developer A: Spike 1 → Spike 3 → items 1 → 2 → 3 → 4 → 5 (critical path)
>   Developer B: Spike 2 → items 6a (dashboard) → 6b (Mulch) → 6c (learning system) — parallel track
>   Integration: merge tracks after item 5, integrate dashboard with hook enforcement and phase boundary visualization
> ```

---

## AMENDMENT 6: FR105–FR119 — AG-UI FALLBACK AND MVP SCOPE FLOOR
**Type:** MODIFY_FR
**Target:** FR107, FR113, FR114, FR115 (Dashboard Copilot section)
**Reason:** The integration contracts analysis found that AG-UI Protocol is the highest-uncertainty integration in the platform — the PRD references it by name without documenting its contract, transport, message schema, or implementation maturity; a defined fallback scope is essential so the Dashboard Copilot epic cannot be blocked indefinitely by AG-UI uncertainty.

**Original text:**
> - **FR107:** Copilot can operate in Investigate mode — programmatically navigating the dashboard UI (expanding story cards, focusing agent panels, highlighting elements, switching views) while presenting correlated findings from multiple data sources (Overstory state, learning records, meta-optimization journals, attribution logs, Mulch expertise)
> - **FR113:** AG-UI protocol provides bidirectional streaming between the copilot agent and the dashboard — copilot sends UI action sequences, dashboard streams state updates back
> - **FR114:** Copilot can execute multi-step investigations — chaining navigation, data retrieval, and correlation across multiple stories, agents, and data sources in a single conversational turn
> - **FR115:** Copilot investigation steps are visible in the chat as action indicators ("📍 Navigating to Story 3...", "🔍 Checking learning records...", "✅ Nudge sent") that the developer can follow in real-time

**Replacement text:**
> - **FR107:** Copilot can operate in Investigate mode — programmatically navigating the dashboard UI (expanding story cards, focusing agent panels, highlighting elements, switching views) while presenting correlated findings from multiple data sources (Overstory state, learning records, meta-optimization journals, attribution logs, Mulch expertise). *Conditional on AG-UI feasibility spike (Spike 2):* If the CopilotKit + AG-UI spike demonstrates that bidirectional UI action streaming is available and performant in the target environment, FR107 ships in MVP. If the spike reveals AG-UI is unavailable, immature (draft spec, no stable SDK), or materially degrades dashboard performance, FR107 is deferred to Growth and the Copilot launches in Ask mode + Act mode only (FR106, FR108–FR112 remain in MVP scope unchanged).
> - **FR113:** AG-UI protocol provides bidirectional streaming between the copilot agent and the dashboard — copilot sends UI action sequences, dashboard streams state updates back. *Implementation dependency:* The AG-UI protocol's actual message schema, transport layer (WebSocket vs. SSE vs. HTTP streaming), and SDK package must be identified and documented during Spike 2 before any FR113 implementation begins. If AG-UI Protocol is confirmed to be a CopilotKit-native feature (bundled in the CopilotKit SDK), no separate integration is required. If it is a separate package or draft standard requiring independent implementation, FR113 scope must be re-estimated before the Dashboard Copilot epic is sized. FR113 has no MVP fallback — if AG-UI is unavailable, FR113 does not ship; the copilot operates without bidirectional streaming and FR107/FR114/FR115 are deferred accordingly.
> - **FR114:** Copilot can execute multi-step investigations — chaining navigation, data retrieval, and correlation across multiple stories, agents, and data sources in a single conversational turn. *Conditional:* Same AG-UI feasibility gate as FR107. Deferred to Growth if Spike 2 go/no-go fails.
> - **FR115:** Copilot investigation steps are visible in the chat as action indicators that the developer can follow in real-time. *Conditional:* Same AG-UI feasibility gate as FR107. Deferred to Growth if Spike 2 go/no-go fails. Ask-mode responses (FR106) may include a simplified inline step summary as a non-streaming alternative, but this is not a substitute for the full FR115 requirement.

---

## AMENDMENT 7: OVERSTORY EXTENSIONS — EXPLICIT CONTRACT PREREQUISITES
**Type:** NEW_FR
**Target:** Agent Orchestration section (after FR23 or as a sub-requirement block before FR21)
**Reason:** The integration contracts analysis found that three specific Overstory extension points — the `learning_report` mail type, the overlay injection point, and the hook runner integration — are all new code written on top of Overstory, but the PRD treats them as assumed-available rather than documenting them as prerequisites with explicit contract requirements; if any extension point requires forking Overstory, the critical path estimate changes materially.

**Original text:**
N/A — new item

**Replacement text:**
> **FR20a (Overstory Extension Prerequisites):** Before any Factory Core component that depends on Overstory extensions may be implemented, the following three extension contracts must be validated as achievable without forking Overstory (i.e., implementable via Overstory's public API or its documented extension mechanism):
>
> *(a) `learning_report` mail type registration.* Overstory's mail system must support registration of a new structured mail type (`learning_report`) without modifying Overstory's core mail type registry source. The `learning_report` type carries: `{from: agent_id, to: story_lead_id, type: "learning_report", payload: {finding_category, finding_text, affected_files, confidence_level, story_id, phase}}`. If Overstory does not support extensible mail types via a registration API, this type must be added to a maintained fork of Overstory, and the fork maintenance strategy (upstream sync policy, diff surface area) must be documented.
>
> *(b) Overlay injection point.* Overstory must accept a pre-composed overlay object from Factory Core's `overlay.ts` at agent spawn time and inject it into the agent's context without requiring Factory Core to understand Overstory's internal context assembly. The injection interface must accept: `{system_prompt: string, superpowers_skills: string[], mulch_priming: string, factory_learnings: string, phase_boundary_manifest: object, tier_directive: "economy" | "standard" | "premium"}`. If no such injection point exists in Overstory's current API, an extension PR must be scoped before the Pi SDK + Overstory integration story begins.
>
> *(c) Hook runner integration point.* Overstory's agent execution loop must expose hook invocation points at: `post-edit` (after each file modification), `post-task` (after each completed task), and `phase-boundary` (at each phase gate). Factory Core must be able to register hook scripts at these points via Overstory's configuration API (not by modifying Overstory's execution loop source). Each hook invocation must receive: `{hook_type, agent_id, story_id, phase, changed_files: string[], task_description: string}`. The hook must be able to return a `block` signal that halts the agent pending developer review.
>
> *Validation:* Spike 3 (see Validation Spikes section) must confirm all three extension contracts before FR21–FR27 implementation begins. If any contract requires a fork, the fork must be created and the diff surface area documented before the sprint begins — not discovered mid-sprint.

---

## AMENDMENT 8: RISK MITIGATION STRATEGY — TOP 5 UNVALIDATED ASSUMPTION RISK ENTRIES
**Type:** MODIFY_SECTION
**Target:** Risk Mitigation Strategy section (Technical Risks subsection)
**Reason:** The assumption validation analysis identified 5 high-risk assumptions that, if wrong, require architectural redesign before MVP development can proceed; the current Risk Mitigation Strategy section addresses Phase Boundary Protocol and overlay token budgets but does not enumerate these critical-path assumption failures or their mitigation paths.

**Original text:**
> **Technical Risks:**
> - *Phase Boundary Protocol is greenfield, highest design risk* → Prototype and validate with a single story end-to-end before building dashboard. Test context isolation guarantee with adversarial scenarios.
> - *Overlay composition may exceed token budgets* → Per-stage token budgets with hard caps. Progressive disclosure pattern from claude-mem. Fail-safe: truncate learnings (lowest priority) first, never truncate Superpowers.
> - *Hook enforcement may slow agent throughput* → Benchmark hook execution time. Budget 2s max per hook point. Async where possible (post-edit hooks don't block next edit).

**Replacement text:**
> **Technical Risks:**
>
> - *Phase Boundary Protocol is greenfield, highest design risk* → Prototype and validate with a single story end-to-end before building dashboard. Test context isolation guarantee with adversarial scenarios.
> - *Overlay composition may exceed token budgets* → Per-stage token budgets with hard caps. Progressive disclosure pattern from claude-mem. Fail-safe: truncate learnings (lowest priority) first, never truncate Superpowers.
> - *Hook enforcement may slow agent throughput* → Benchmark hook execution time. Budget 2s max per hook point. Async where possible (post-edit hooks don't block next edit).
>
> **Critical-Path Assumption Risks (must be resolved before architecture sprint begins):**
>
> - *[ASSUMPTION-1] Pi SDK does not support 3-tier model switching or GLM-5 is unavailable natively.* Entire cost model collapses; economy-tier routing is the load-bearing assumption for NFR22, NFR6, NFR7, and the "quality feels free" differentiation claim. **Mitigation:** Pi SDK architecture spike (Spike 1) is mandatory in Week 1. Success criterion: written confirmation from Pi SDK with production API showing 3+ tier support and confirmed GLM-5 price. **Fallback if assumption fails:** Redefine economy tier as OpenRouter Gemini Flash; decouple economy-tier claim from Pi SDK GLM-5 specifically. Budget 1 week for fallback re-estimation if spike fails. **Gate:** Architecture sprint does not begin until Pi SDK 3-tier support is confirmed in writing or the Gemini Flash fallback is formally adopted.
>
> - *[ASSUMPTION-2] Overstory SQLite cannot handle 15 concurrent agents without data loss or duplicate mail delivery.* All coordination architecture depends on Overstory as single source of truth for agent state, mail, and checkpoints. Silent write failures cascade. **Mitigation:** 15-agent concurrent stress test (Spike 3) before MVP development. Success criterion: zero data loss, exactly-once mail delivery confirmed across 5 runs with process kills. **Fallback if assumption fails:** Reduce concurrent agent ceiling to 8 (2x slower stories) or introduce an explicit locking layer above SQLite. Neither fallback requires architectural redesign of Factory Core; both require updated concurrency limits in `factory.yaml` and revised NFR17. **Gate:** No story may run through the factory until this test passes.
>
> - *[ASSUMPTION-3] CopilotKit + AG-UI integrates into Bun/React dashboard without blocking SSE event streaming at 30fps with 12 active agent panels.* Dashboard is the control plane for Journey 2 (stall detection, nudge, inspect). If CopilotKit degrades dashboard performance, human-in-loop control is lost. **Mitigation:** CopilotKit + AG-UI feasibility spike (Spike 2) in Week 1. Success criterion: FPS > 28, SSE latency < 2.5s on 16GB machine during active chat streaming. **Fallback if assumption fails:** Move chat to separate browser tab (separate page/route, full state available but not co-located); or implement chat via WebWorker to isolate rendering pressure. Dashboard Copilot still ships in MVP in degraded UX mode. **Gate:** Dashboard Copilot epic does not begin without Spike 2 results; AG-UI-dependent FRs (FR107, FR113-FR115) have explicit deferral path documented in Amendment 6.
>
> - *[ASSUMPTION-4] Phase Boundary Protocol manifest schema is insufficient to capture all real-world story metadata — agents create ad-hoc extensions mid-sprint.* Learning system cannot correlate patterns across stories; verification breaks; overlay enrichment delivers low-signal data. **Mitigation:** PBP manifest schema workshop in Week 1-2; 5-story pilot before MVP development begins. Success criterion: 5 pilot stories complete with schema capturing all required metadata without ad-hoc extensions. **Fallback if assumption fails:** 1-week schema iteration before MVP sprint 1, consuming buffer time. Last resort: living schema (agents define new fields), accepted with explicit acknowledgment that this breaks structural consistency and learning correlation. **Gate:** PBP v1 manifest schema validated on 5 pilot stories before Phase Boundary Protocol implementation begins.
>
> - *[ASSUMPTION-5] BMAD review cycle exceeds 10 minutes for typical 1000-line story artifacts, stalling phase progression.* Phase progression gates on BMAD review completion (FR10, FR11). QA phase starts before BMAD findings are available; QA agents duplicate BMAD work; cost overrun; developer loses real-time feedback. **Mitigation:** BMAD latency baseline measurement in Week 2-3; 10 representative PRs timed end-to-end. Success criterion: median < 8 minutes, 90th percentile < 10 minutes, cost < 3% of story cost. **Fallback if assumption fails:** Accept slower phase progression with increased timeout; or run BMAD in parallel during development phase (async feedback, no phase-gate guarantee). Deferring mandatory BMAD to Growth is the nuclear option — loses quality safety net for MVP. **Gate:** BMAD latency distribution must be established before committing to the 10-minute phase-gate assumption in any SLA-bearing acceptance test.

---

## AMENDMENT 9: IMPLEMENTATION SEQUENCING — VALIDATION SPIKE SECTION (RISK MITIGATION STRATEGY)
**Type:** MODIFY_SECTION
**Target:** Risk Mitigation Strategy section — Resource Risks subsection
**Reason:** The assumption validation analysis established a formal 3-phase validation sequence (Phase 0 Week 1, Phase 1 Week 2-3, Phase 2 Week 4) that must gate architecture work; this sequencing is not currently represented in the Risk Mitigation Strategy section, which only references "2 developers, ambitious scope" without acknowledging the pre-coding validation obligations.

**Original text:**
> **Resource Risks:**
> - *2 developers, ambitious scope* → Critical path (Pi → Overstory → Hooks → Phase Boundary → Superpowers) on Developer A. Parallel track (Dashboard → Mulch → Learning) on Developer B. Integration point is well-defined.
> - *If behind schedule* → Task work type can ship without full hook enforcement. Dashboard can launch with Factory Overview + Agent Windows only (defer Story Pipeline visualization).

**Replacement text:**
> **Resource Risks:**
>
> - *2 developers, ambitious scope* → Critical path (Pi → Overstory → Hooks → Phase Boundary → Superpowers) on Developer A. Parallel track (Dashboard → Mulch → Learning) on Developer B. Integration point is well-defined.
> - *If behind schedule* → Task work type can ship without full hook enforcement. Dashboard can launch with Factory Overview + Agent Windows only (defer Story Pipeline visualization). If AG-UI spike (Spike 2) fails, Dashboard Copilot ships as Ask mode only — deferred FRs (FR107, FR113-FR115) do not create schedule risk for the rest of MVP.
>
> **Validation Gate Schedule (weeks are relative to project start):**
>
> | Week | Developer | Activity | Gate Output | Blocks |
> |------|-----------|----------|-------------|--------|
> | 1 | Developer A | Spike 1: Pi SDK architecture + GLM-5 pricing | Pi SDK API contract confirmed; economy-tier price recorded | Item 1 (Pi SDK integration) |
> | 1 | Developer B | Spike 2: CopilotKit + AG-UI feasibility | Dashboard performance baseline; AG-UI go/no-go decision | FR107, FR113-FR115 scope decision |
> | 2 | Developer A | Spike 3: Overstory extension point validation | Extension contract inventory; fork-required list | Item 2 (Overstory extensions) |
> | 2–3 | Both | PBP manifest schema workshop + 5-story pilot | PBP v1 schema validated | Phase Boundary Protocol implementation |
> | 2–3 | Developer A | Overstory 15-agent SQLite stress test | NFR17 pass/fail; concurrency ceiling confirmed | Story execution go-live |
> | 3–4 | Both | BMAD latency baseline: 10 representative PRs | 90th percentile latency established | Phase-gate timeout configuration |
>
> *The architecture sprint (FR design and component interfaces) may proceed in parallel with Weeks 1-2 spikes. No production code is written until Spike 1 completes. The cost model documented in NFR22 and the economy-tier architecture are not considered validated until Spike 1 pricing data is recorded.*

---

*End of amendment batch. Total amendments: 9. All original text quoted directly from prd-v2.md (v2.0, 2026-03-10).*
