# Cost Model Validation Analysis: QDS Engineer v2
**Date:** 2026-03-14
**Analyst:** Claude Code (claude-sonnet-4-6)
**Source Document:** `_bmad-output/planning-artifacts/prd-v2.md` (v2.0, 2026-03-10)
**Focus Claim:** NFR22 — quality pipeline cost (BMAD review + QA swarm combined) must not exceed **5% of total story cost**

---

## Executive Summary

The PRD's "quality feels free" value proposition rests on a single load-bearing assumption: that GLM-5 via Pi SDK native routing is cheap enough relative to Claude Sonnet (standard tier) that running a full adversarial review + QA swarm pipeline costs only 3-5% of total story spend. The PRD's Journey 1 narrative illustrates this with concrete figures: $0.04 BMAD+QA on a $1.86-projected story (~2.1%) and $0.07 total quality pipeline across 4 stories averaging ~$1.20 each (~1.5%).

These figures are plausible **only if** GLM-5 is priced at roughly 1/30th to 1/50th of Sonnet per token. That pricing relationship exists today for some providers but has not been verified against Pi SDK's actual billing, and Pi SDK's model routing behavior for economy tier is not documented with precision in the PRD. If the economy-tier assumption is wrong by 5x, NFR22 fails. If Pi SDK is unavailable and falls back to OpenRouter standard-tier routing, quality pipeline cost increases by an estimated 20-40x.

**Risk level: HIGH.** The cost model should be validated empirically before MVP scope lock.

---

## 1. Token Budget Breakdown — Typical Story

### 1.1 Overlay Composition Token Floors

The PRD documents the overlay composition pipeline stages (Technical Architecture, `overlay.ts`):

| Stage | Economy Tier Budget | Standard Tier Budget | Notes |
|---|---|---|---|
| System prompt + agent role | ~500 | ~500 | Fixed, same for all tiers |
| Superpowers skills + iron laws | ~1,500–2,500 | ~1,500–2,500 | Priority-ranked; same pool |
| Mulch expertise priming | ~500–1,500 | ~500–1,500 | Scoped to file path |
| Factory Learnings injection | **500 hard ceiling** | **1,000 hard ceiling** | Tier-differentiated |
| Phase Boundary manifest | ~300–800 | ~300–800 | Only mid-story |
| Task instructions | ~1,000–2,000 | ~1,000–2,000 | Story spec + file scope + AC |
| **Total overlay (est.)** | **~4,300–7,800** | **~4,800–8,300** | Per agent launch |

This is the *input* token cost per agent launch before any work begins. In a 5-phase pipeline the factory spawns multiple agents per phase (coordinator, lead, builder, scouts). Every phase transition includes a fresh agent spin-up.

### 1.2 Agent Count by Phase — Story Work Type

Based on PRD Journey 1 ("12 agents across 3 worktrees") and pipeline composition descriptions:

| Phase | Agents (Estimate) | Tier | Primary Activity |
|---|---|---|---|
| **Intake / Setup** | 1 (coordinator) | Standard | Decomposition, dependency detection, worktree setup |
| **Develop** | 3–5 (coordinator + lead + 2–3 builders) | Standard / Premium | Code generation, TDD, hook compliance |
| **BMAD Review** | 2–3 (spec reviewer + security reviewer + optionally arch reviewer) | Economy (stated) | Context-isolated adversarial review |
| **Fix Loop** (if triggered) | 1–2 (fix-lead + builder) | Standard | Targeted corrections from BMAD findings |
| **QA Swarm** | 4–6 scouts + 1 fixer | Economy | Multi-wave parallel edge-case hunting |
| **Ship / PR** | 1 (coordinator) | Standard | PR creation, evidence assembly |
| **Total agents (est.)** | **12–18** | Mixed | Across full 5-phase pipeline |

### 1.3 Phase Token Consumption Estimates

The following estimates use the overlay floors from §1.1 plus representative task completion token consumption (medium-complexity story, ~5 files modified):

| Phase | Agents | Input Tokens/Agent | Output Tokens/Agent | Subtotal (Input+Output) | Tier |
|---|---|---|---|---|---|
| Intake | 1 | ~6,000 | ~2,000 | ~8,000 | Standard |
| Develop | 4 | ~7,000 | ~8,000 | ~60,000 | Standard |
| BMAD Review | 3 | ~6,500 | ~3,000 | ~28,500 | Economy (GLM-5) |
| Fix Loop (1 cycle) | 2 | ~6,500 | ~5,000 | ~23,000 | Standard |
| QA Swarm (5 waves, 4 scouts) | 20 | ~5,000 | ~2,000 | ~140,000 | Economy (GLM-5) |
| Ship | 1 | ~5,500 | ~2,000 | ~7,500 | Standard |
| **Total** | **31** | | | **~267,000** | Mixed |

**Quality pipeline share (BMAD + QA):** ~168,500 / 267,000 = **~63% of tokens**, but at economy pricing.

> Key insight: the quality phases consume a large *fraction of tokens* but a small fraction of *cost* only because economy-tier pricing is assumed to be dramatically cheaper per token than standard tier.

### 1.4 Phase Cost at Assumed Pricing

The PRD does not state explicit per-token prices. However, the Journey 1 figures ($1.82 develop phase, $0.04 BMAD+QA) imply the following pricing relationships:

**Backing out implied pricing from Journey 1:**
- Develop phase: ~60,000 tokens at standard (Sonnet) pricing → $1.82 → implies **~$0.030/1K tokens blended** (Sonnet input ~$0.003, output ~$0.015 — roughly consistent with Claude Sonnet 4.x pricing)
- BMAD+QA: ~168,500 tokens at economy pricing → $0.04 → implies **~$0.00024/1K tokens blended** for GLM-5

**This 125:1 price ratio is the linchpin of the entire cost model.**

Checking against known pricing (as of early 2026):
- Claude Sonnet: ~$3/M input, ~$15/M output → blended ~$6/M at 50/50
- GLM-5 (Zhipu AI): publicly listed at ~$0.05–0.15/M tokens depending on tier
- Implied ratio: 40:1 to 120:1

The upper end of the range (~120:1) would validate the PRD's figures. The lower end (~40:1) would put quality pipeline cost at ~3x the PRD's assumption.

---

## 2. Pi SDK GLM-5 Pricing Analysis

### 2.1 What the PRD Assumes

The PRD states (multiple locations):
- GLM-5 is available via "Pi SDK native routing" as the economy tier
- BMAD review agents and QA swarm scouts run on economy tier (GLM-5)
- The factory uses "economy-tier models (GLM-5) for QA and review work, keeping per-story cost low enough that running the quality pipeline feels free"
- NFR22 requires quality pipeline cost ≤ 5% of total story cost

The PRD **does not state** explicit per-token prices for GLM-5 through Pi SDK. The pricing is entirely implicit, derived from Journey 1 narrative numbers ($0.04 BMAD+QA on a ~$1.86 story = 2.1%).

### 2.2 Risk Scenarios: GLM-5 Actual Cost vs. Assumed

The following table models the quality pipeline's share of total story cost at different GLM-5 pricing multiples relative to the PRD's implied assumed price:

| Scenario | GLM-5 Price | BMAD+QA Cost | Story Total | Quality % | NFR22 Pass? |
|---|---|---|---|---|---|
| **Baseline (PRD assumption)** | 1x (~$0.00024/1K) | $0.04 | $1.86 | 2.1% | Yes |
| **1.5x scenario** | ~$0.00036/1K | $0.06 | $1.88 | 3.2% | Yes |
| **2x scenario** | ~$0.00048/1K | $0.08 | $1.90 | 4.2% | Yes (barely) |
| **3x scenario** | ~$0.00072/1K | $0.12 | $1.94 | 6.2% | **NO — NFR22 breach** |
| **5x scenario** | ~$0.0012/1K | $0.20 | $2.02 | 9.9% | **NO** |
| **10x scenario** | ~$0.0024/1K | $0.40 | $2.22 | 18.0% | **NO** |
| **Pi uses OpenRouter GLM-5 pricing** | ~$0.003/1K | $0.51 | $2.33 | 21.9% | **NO** |

**Critical threshold: GLM-5 must cost no more than ~2.4x the PRD's assumed price for NFR22 to hold.**

The margin is thin. A 3x pricing surprise breaks the NFR. A 5x surprise changes the "quality feels free" message from marketing copy to marketing liability.

### 2.3 The "Quality Feels Free" Value Proposition at Risk

The PRD identifies the economy-tier adversarial quality pipeline as Innovation #1 and the primary competitive differentiation over CodeRabbit and Cursor. The competitive table states: "Neither enforces context isolation between generation and review; neither makes quality economically invisible."

**If economy-tier pricing is wrong by 5x:**
- Quality pipeline cost rises to ~10% of story cost
- At 5 stories/day, quality overhead = $1.00/day vs $0.35/day
- Annual delta: ~$235 (immaterial for an internal tool)
- But the *marketing narrative* breaks — "quality feels free" cannot be claimed honestly if quality costs 10% of story cost
- The differentiation claim against CodeRabbit (flat-fee pricing model) weakens

**If economy-tier pricing is wrong by 10x:**
- Quality pipeline becomes 18% of story cost
- The decision calculus shifts: economy tier may no longer be appropriate for BMAD review; standard tier becomes necessary for review quality, not just development quality
- Per-story cost increases ~$0.36, but reliability improves
- NFR22 must be revised or the cost model restructured

---

## 3. Alternative Cost Scenarios

### 3.1 Scenario A: Pi SDK Unavailable — Fallback to OpenRouter

The PRD documents Pi SDK as the primary runtime with no cost-equivalent fallback. The risk mitigation table states the fallback is: "Pin Pi to a single model (Opus 4.6 for all tiers), treat economy-tier routing as Growth. Lose cost optimization but core pipeline still works."

**Cost impact of Opus 4.6 for all tiers:**

Opus 4.6 pricing (estimated ~$15/M input, $75/M output → blended ~$45/M):

| Phase | Tokens | At GLM-5 (assumed) | At Opus 4.6 (fallback) | Delta |
|---|---|---|---|---|
| Develop (standard → Opus) | ~60,000 | $0.18 (Sonnet) | $2.70 | +$2.52 |
| BMAD Review | ~28,500 | $0.007 | $1.28 | +$1.27 |
| QA Swarm (5 waves) | ~140,000 | $0.034 | $6.30 | +$6.27 |
| Ship | ~7,500 | $0.045 (Sonnet) | $0.34 | +$0.29 |
| **Total story** | ~267,000 | **~$1.86** | **~$12.36** | **+$10.50** |

**Quality pipeline % at Opus-only fallback:** $7.58 / $12.36 = **61%** — quality pipeline is no longer negligible; it dominates total cost.

This fallback scenario is operationally viable but economically untenable for the stated value proposition. Any extended Pi SDK outage destroys the "quality feels free" claim.

**Alternative fallback: OpenRouter economy models (Gemini Flash or similar):**

| Phase | At Gemini Flash (~$0.075/M blended) | Quality % |
|---|---|---|
| BMAD Review (~28,500 tokens) | $0.002 | ~0.2% |
| QA Swarm (~140,000 tokens) | $0.011 | ~0.6% |
| **Quality total** | **~$0.013** | **~0.7%** |

An OpenRouter Gemini Flash fallback would actually undercut the PRD's assumed GLM-5 cost. **Recommendation: define OpenRouter Gemini Flash as the documented economy-tier fallback rather than Opus 4.6.**

### 3.2 Scenario B: Economy Tier Doesn't Perform — Standard Tier Required for Review

BMAD review quality is the core trust mechanism. If GLM-5 produces shallow, low-signal reviews (false positives drowning out real findings, or consistent false negatives), the factory is forced to upgrade BMAD to standard tier (Sonnet).

**Cost impact: BMAD review at standard tier (Sonnet):**

| Phase | Tokens | At GLM-5 economy | At Sonnet standard | Delta |
|---|---|---|---|---|
| BMAD Review (3 agents) | ~28,500 | $0.007 | $0.171 | +$0.164 |
| QA Swarm scouts (kept at economy) | ~140,000 | $0.034 | $0.034 | $0 |
| **Quality total** | | **$0.041** | **$0.205** | **+$0.164** |
| **Quality % of $1.86 story** | | **2.2%** | **11.0%** | |

BMAD at standard tier pushes quality cost to ~11% of story total — above NFR22's 5% ceiling. However, the QA swarm is the token-heavy component; keeping scouts on economy tier and upgrading only BMAD reviews to standard is a defensible tradeoff. The NFR22 ceiling would need revision to ~12% in this scenario.

**Decision threshold:** If BMAD review agents (GLM-5) achieve a defect catch rate below the validated minimum bar (1 real defect per 5 stories that would have survived human review — PRD §Innovation Experiments), tier escalation for BMAD becomes justified regardless of cost impact.

### 3.3 Scenario C: QA Swarm Requires More Waves Than Expected

The PRD Journey 1 narrative shows 5 waves with the stopping threshold at "3 consecutive clean waves." The default `max_turns` for QA phase is 5 (configurable via `factory.yaml`). The NFR22 cost calculation implicitly assumes the 5-wave baseline.

**Cost sensitivity to wave count:**

| Wave Count | QA Scout Tokens (4 scouts/wave) | QA Cost (GLM-5) | Quality % of $1.86 story |
|---|---|---|---|
| 3 waves (min stopping threshold) | ~60,000 | $0.014 | 1.5% |
| 5 waves (Journey 1 baseline) | ~100,000 | $0.024 | 1.8% |
| 8 waves (complex story, dirty code) | ~160,000 | $0.038 | 2.2% |
| 12 waves (extreme case) | ~240,000 | $0.058 | 2.5% |
| 20 waves (pathological) | ~400,000 | $0.096 | 3.9% |

**Finding:** QA wave count variation has minimal impact on total cost at economy pricing. Even 20 waves adds only ~$0.07 to total story cost. The QA swarm's economic insensitivity to wave count is a genuine strength of the economy-tier architecture.

**However:** If a fixer agent is spawned per wave (when defects are found), fixer agents run at standard tier. At 5 fixer invocations of ~15,000 tokens each: +$0.045 in standard-tier cost — still modest.

**Wave-count risk is LOW** at assumed economy pricing. Wave count only becomes a concern if GLM-5 pricing is 10x+ the assumption.

### 3.4 Scenario D: Fix Loop Triggers Multiple BMAD Cycles

The PRD's fix loop circuit breaker is configurable (default unstated but implies ~3 iterations). Each BMAD re-review cycle after a fix adds:

| BMAD Re-review Cycle | Additional Tokens | Additional Cost (GLM-5) | Additional Cost (Sonnet, if escalated) |
|---|---|---|---|
| 1st fix → re-review | ~28,500 | $0.007 | $0.171 |
| 2nd fix → re-review | ~28,500 | $0.007 | $0.171 |
| 3rd fix → re-review (circuit breaker) | ~28,500 | $0.007 | $0.171 |
| **Total (3 cycles)** | ~85,500 | **$0.021** | **$0.513** |

Fix loops also invoke standard-tier agents for the fix phase itself. A 3-cycle fix loop adds roughly:
- GLM-5 economy for reviews: +$0.021
- Standard tier for fix agents: +$0.138 (3 × fix-lead + builder × ~15,000 tokens)

**Total fix loop overhead (3 cycles at assumed pricing):** ~$0.16 added to story cost.

At 3-cycle fix loops, the story total becomes ~$2.02 and quality pipeline becomes ~$0.06, still within NFR22.

---

## 4. Sensitivity Analysis

### 4.1 Cost Driver Ranking

Which assumptions most impact the "quality feels free" claim? Ranked by sensitivity:

| Rank | Assumption | Impact Direction | Impact Magnitude | Confidence |
|---|---|---|---|---|
| 1 | **GLM-5 actual price via Pi SDK** | NFR22 breach at >2.4x assumed | HIGH — linear relationship | LOW — unverified |
| 2 | **Pi SDK availability and economy routing** | Fallback to Opus 4.6 = 6x total story cost | HIGH — eliminates value proposition entirely | MEDIUM — Pi is unproven in production |
| 3 | **BMAD review quality at GLM-5** | Tier escalation to Sonnet if too shallow | MEDIUM — 11% quality cost vs 2.2% | MEDIUM — no empirical data |
| 4 | **Develop phase token consumption** | Story total determines what 5% means | MEDIUM — higher dev cost makes 5% more achievable | HIGH — well-understood from Sonnet pricing |
| 5 | **QA wave count** | Minimal at economy pricing | LOW — 20 waves still <4% | HIGH — model is insensitive |
| 6 | **Fix loop iteration count** | Modest at economy pricing | LOW — 3 cycles adds ~$0.16 | HIGH — circuit breaker limits exposure |
| 7 | **Overlay token consumption** | Larger overlays = more input tokens | LOW-MEDIUM — dominated by task tokens | HIGH — hard ceilings are documented |

### 4.2 Sensitivity to Development Phase Cost

The develop phase cost (standard/premium tier) is the denominator in the NFR22 calculation. A larger develop-phase spend makes NFR22 *easier* to satisfy:

| Story Complexity | Est. Develop Phase Cost | Quality Pipeline at 1x GLM-5 | Quality % |
|---|---|---|---|
| Small (2–3 files, ~20K tokens) | ~$0.60 | $0.041 | 6.8% — **NFR22 breach** |
| Medium (5 files, Journey 1 baseline) | $1.82 | $0.041 | 2.2% |
| Large (10+ files, ~120K tokens) | $3.60 | $0.041 | 1.1% |
| Complex with fix loops (150K+ tokens) | $4.50 | $0.062 | 1.4% |

**Finding: Small stories are the highest cost-model risk.** For 2–3 file stories with minimal development token consumption, the fixed overhead of BMAD review (3 agents × full overlay) can push quality cost above 5% even at assumed GLM-5 pricing. The PRD does not address minimum story size thresholds for the 5% NFR.

**Recommendation:** NFR22 should be qualified with a minimum story size floor, or a flat-rate quality cost ceiling should replace the percentage-based threshold for small stories.

### 4.3 Interaction Effects

The worst-case scenario is a combination of adverse factors:
- GLM-5 pricing 3x assumed (NFR22 already at risk)
- Small story (2–3 files) triggering full BMAD review
- 2-cycle fix loop (standard-tier fix agents)
- Pi SDK temporarily unavailable for economy routing (fallback to OpenRouter standard)

Under this compound scenario, quality pipeline cost could reach **25–35%** of story total. The PRD's circuit breakers (per-story budget, global daily ceiling) would prevent runaway spend, but the "quality feels free" claim would be demonstrably false.

---

## 5. Go/No-Go Cost Thresholds

### 5.1 Thresholds for the "Quality Feels Free" Claim

| Threshold | Value | Interpretation | Action |
|---|---|---|---|
| **Green: Claim holds** | Quality < 5% of story cost | NFR22 satisfied; narrative accurate | Ship as designed |
| **Yellow: Claim weakened** | Quality 5–10% of story cost | "Quality is cheap" still true; "feels free" is a stretch | Revise copy; NFR22 relaxed to 10% |
| **Orange: Claim broken** | Quality 10–20% of story cost | Quality is a material cost line item | Reconsider pipeline architecture; smaller BMAD team or fewer waves |
| **Red: Claim reversed** | Quality > 20% of story cost | Quality pipeline costs more than any individual tier benefit justifies | Economy tier broken; fall back to standard-for-all or drop BMAD phase |

### 5.2 GLM-5 Price per Million Tokens — Go/No-Go

| GLM-5 Price (per M tokens) | Quality Cost (medium story) | Quality % | Decision |
|---|---|---|---|
| < $0.10/M | ~$0.017 | ~0.9% | Strong green |
| $0.10–0.30/M | ~$0.017–0.051 | 0.9–2.7% | Green |
| $0.30–0.60/M | ~$0.051–0.101 | 2.7–5.4% | Yellow (NFR22 at risk) |
| $0.60–1.50/M | ~$0.101–0.253 | 5.4–13.6% | Orange |
| > $1.50/M | > $0.253 | > 13.6% | Red |

The PRD's implied price is ~$0.24/1K = $240/M tokens — far above these thresholds. **This suggests the PRD's implied pricing is in error, or the token consumption estimates are significantly understated.** A more likely GLM-5 pricing via Pi SDK is $0.05–0.15/M tokens, which would produce quality pipeline costs of $0.001–$0.003 on the medium story (well under 1% of story cost). This would be even better than the PRD's $0.04 figure.

> Re-examination of Journey 1 arithmetic: $0.04 BMAD+QA on ~168,500 quality tokens = $0.000237/1K = $0.237/M. This is implausible for GLM-5 (too cheap by a factor of ~5x vs. public pricing). Alternatively, if GLM-5 is priced at $0.05/M and quality tokens are actually only ~8,000–10,000 (not 168,500), the $0.04 figure works out. **The PRD's Journey 1 cost figures appear to be narrative illustrations, not arithmetically grounded estimates.**

### 5.3 The Central Unanswered Question

The PRD's economy-tier cost model contains a fundamental gap: **what does Pi SDK actually charge for GLM-5 routed calls, and what does GLM-5's context window and output quality look like on BMAD-style review prompts?** Without this, NFR22 cannot be validated analytically.

---

## 6. Recommended Validation Spike Before MVP Scope Lock

### 6.1 Spike Definition

**Name:** Economy-Tier Cost & Quality Validation Spike
**Objective:** Empirically establish GLM-5 pricing through Pi SDK and validate minimum acceptable review quality before committing to the economy-tier architecture
**Duration:** 3–5 days
**Scope:** Not a production story; spike output is data, not shipping code

### 6.2 Spike Tasks

| # | Task | Output | Success Criterion |
|---|---|---|---|
| S1 | Stand up Pi SDK with GLM-5 routing; run 5 test prompts through economy tier; record actual cost per call | Cost-per-call data | Actual GLM-5 price via Pi SDK confirmed to within ±20% |
| S2 | Run a BMAD-style review prompt (~6,000 input tokens, ~2,000 expected output) on GLM-5 vs Sonnet against 3 known-defect code samples | Side-by-side findings comparison | GLM-5 catches ≥80% of defects Sonnet catches, or upgrade path is costed |
| S3 | Run a QA swarm wave simulation: 4 scouts on GLM-5 against a ~3,000-line test scope; record tokens, cost, and findings quality | Wave cost + findings quality | Economy scouts demonstrate viable edge-case detection or minimum wave count is increased |
| S4 | Simulate Pi SDK fallback: route economy-tier calls to Gemini Flash via OpenRouter; record cost differential | Fallback cost baseline | Verified fallback at acceptable cost, OR Pi-dependence risk is formally acknowledged |
| S5 | Build a minimal attribution chain mock (FR42): record per-call attribution for 10 simulated agents; verify NFR22 measurement is feasible | Measurement infrastructure proof | NFR22 can be measured in practice, not just stated |

### 6.3 Spike Go/No-Go Criteria

After the spike, decide:

| Finding | Decision |
|---|---|
| GLM-5 via Pi SDK confirmed at < $0.30/M tokens AND BMAD quality acceptable | **Proceed with economy-tier architecture as designed.** NFR22 is achievable. |
| GLM-5 via Pi SDK costs $0.30–0.60/M tokens | **Proceed with NFR22 revised to 8–10%.** Update Journey 1 narrative figures to match actual economics. |
| GLM-5 via Pi SDK costs > $0.60/M tokens OR quality unacceptable | **Reconsider economy-tier architecture.** Options: (a) use Gemini Flash via OpenRouter as economy tier instead; (b) reduce BMAD team size from 3 to 1 agent; (c) make QA swarm 2-wave default instead of 5 |
| Pi SDK GLM-5 routing unavailable or unreliable | **Redefine economy tier as OpenRouter Gemini Flash.** Decouple economy-tier claim from Pi SDK GLM-5 specifically. |

### 6.4 What the Spike Does NOT Need to Solve

- The spike does not need to build the full attribution chain (FR42 — that is MVP scope)
- The spike does not need to validate BMAD at scale (20 stories is the PRD's validation bar; spike needs 3 for directional signal)
- The spike does not need to instrument the dashboard cost display (FR46)
- The spike only needs to establish a pricing floor and a minimum quality bar

### 6.5 Spike Timing

The spike should run **before the first sprint of Factory Core implementation**. Specifically, before coding begins on:
- FR36 (model tier directives to Pi SDK)
- FR13 (economy-tier QA swarm scouts)
- FR37 (per-story token spend tracking)
- NFR22 acceptance test implementation

The cost model underpins all of these. Getting it wrong in sprint 1 means rework in sprint 3.

---

## 7. Summary of Findings

| Finding | Severity | Action Required |
|---|---|---|
| NFR22's 5% threshold is arithmetically achievable only if GLM-5 is priced < $0.30/M tokens via Pi SDK | HIGH | Run spike S1 before MVP sprint 1 |
| Pi SDK GLM-5 pricing is entirely unverified in the PRD | HIGH | Run spike S1; make pricing explicit in PRD with source |
| Journey 1 cost figures ($0.04 BMAD+QA, $4.82/4 stories) appear to be illustrative, not calculated | MEDIUM | Recalculate with spike data; update or caveat in PRD |
| Small stories (<3 files) may breach NFR22 even at assumed pricing due to fixed BMAD overhead | MEDIUM | Add minimum story size floor to NFR22, or reframe as flat-rate ceiling for small stories |
| Pi SDK fallback to Opus 4.6 destroys cost model; no viable economy fallback is documented | HIGH | Document Gemini Flash / OpenRouter as economy-tier fallback; run spike S4 |
| BMAD review quality on GLM-5 is unvalidated — upgrade to Sonnet standard tier costs 11% quality overhead | MEDIUM | Run spike S2 before committing to GLM-5 for BMAD |
| QA wave count sensitivity is LOW at economy pricing — this risk is well-managed | LOW | No action needed; existing design is robust here |
| Fix loop cost at economy pricing is LOW and well-managed by circuit breaker | LOW | No action needed |
| The "quality feels free" value proposition survives at 2x–2.5x GLM-5 pricing variance but breaks at 3x+ | HIGH | Spike S1 must confirm pricing within this band |

---

## Appendix A: PRD Cost-Relevant Requirements Reference

| Requirement | Location | Cost Relevance |
|---|---|---|
| NFR22: quality pipeline ≤ 5% of story cost | Non-Functional Requirements, Economics | **Primary validation target** |
| NFR6: daily cron ≤ $0.50/run (economy tier) | Non-Functional Requirements | Secondary; same economy-tier dependency |
| NFR7: weekly cron ≤ $2.00/run (economy tier) | Non-Functional Requirements | Secondary; same economy-tier dependency |
| FR13: QA scouts on economy-tier models | Quality Enforcement | Defines economy-tier scope for QA |
| FR36: model tier directives (economy/standard/premium) | Resource & Economic Management | Architecture mechanism for tier routing |
| FR37: token spend per story, phase-level | Resource & Economic Management | Measurement infrastructure for NFR22 |
| FR38: per-story cost circuit breaker | Resource & Economic Management | Safety net, not cost model |
| FR42: full attribution chain | Resource & Economic Management | NFR22 cannot be measured without this |
| FR46: cost tracking with tier breakdown | Dashboard | NFR22 visibility |
| Journey 1 figures: $4.82/4 stories, $0.07 quality | User Journeys | **Illustrative benchmark — unvalidated** |
| Budget projection: "$0.04 BMAD+QA phases projected" | Journey 1 Rising Action | **Key illustrative figure — unvalidated** |
| Innovation #1 "quality feels free" claim | Competitive Differentiation | Core value proposition at risk |
| Fallback: "Pin Pi to single model (Opus 4.6)" | Risk Mitigation | Viable operationally, catastrophic economically |

---

*Analysis performed against prd-v2.md (v2.0, 2026-03-10). Token consumption estimates are derived from PRD overlay stage documentation and Journey 1 narrative. Pricing figures are estimates based on publicly available model pricing as of early 2026 and implied back-calculations from PRD Journey 1 figures. Actual Pi SDK billing rates must be confirmed empirically.*
