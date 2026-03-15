# PRD Amendment Batch: Factory Learning System & Meta-Optimization
**Source document:** `prd-v2.md` (v2.0, 2026-03-10)
**Review basis:** `prd-analysis-acceptance-criteria-review-2026-03-14.md`
**Amendment date:** 2026-03-14
**Scope:** FR55–FR63 (Factory Learning System) and FR77–FR89 (Meta-Optimization)
**Clusters targeted:** Testability score 2/5 on both clusters; all amendments are blocking or high-priority per review.

---

## AMENDMENT: FR59 — SYNTHESIS ALGORITHM SPECIFICATION AND TEST FIXTURE PREREQUISITE
**Type:** MODIFY_FR
**Target:** FR59
**Reason:** Grouping key, deduplication algorithm, and numeric outcome weight values are undefined, making synthesis output correctness unverifiable without a canonical test fixture.

**Original text:**
> - **FR59:** A manual synthesis script can read raw learning records, group by file scope, deduplicate, weight by story outcome, validate against Superpowers gates, and flag conflicts for human resolution

**Replacement text:**
> - **FR59:** A manual synthesis script can read raw learning records, group by file scope, deduplicate, weight by story outcome, validate against Superpowers gates, and flag conflicts for human resolution, according to the following specified algorithms:
>   - **Grouping key:** Records are grouped by the `file_scope` field in the learning record YAML. Records whose `file_scope` matches the same canonical path (normalized to repo-root-relative, trailing slash stripped) are placed in the same group.
>   - **Deduplication algorithm:** Within each group, records are deduplicated using exact-match on `content_hash` (SHA-256 of the learning record's `content` field, after whitespace normalization). When duplicates are detected, the record with the highest outcome weight (see below) is retained; ties are broken by `recorded_at` descending (most recent wins). The rejected duplicate is logged to `.qds/learnings/synthesis-log/YYYY-MM-DD-dedup.log` with both hashes and the retention reason.
>   - **Outcome weights:** `success=1.0`, `failed_qa=0.7`, `failed_bmad=0.5`, `cancelled=0.0`. Records with `cancelled` outcome weight are excluded from synthesis output entirely but are logged as excluded in the synthesis log.
>   - **Conflict detection:** Two records within the same group are in conflict when their `content` fields contain semantically contradictory directives for the same file scope — defined as: both records assert a value for the same `directive_key` field and those values differ, OR one record's `category` is `constraint` and the other record directly negates it (as determined by a keyword-match rule against a configurable conflict-detection vocabulary in `factory.yaml`). Conflicting pairs are written to `.qds/learnings/conflicts/YYYY-MM-DD.yaml` and excluded from synthesis output pending human resolution; neither record is injected until the conflict is resolved.
>   - **Prerequisite artifact:** Before FR59 implementation begins, a test fixture dataset of exactly 20 raw learning records must be authored and committed to `.qds/learnings/_fixtures/synthesis-test/`. The fixture must cover: known-duplicate records (same content hash), known-conflicting records (same directive_key, different values), records from each outcome category (success, failed_bmad, failed_qa, cancelled), records with iron law conflicts, and records with no issues. Expected synthesis output for each fixture case must be documented in `.qds/learnings/_fixtures/synthesis-test/EXPECTED.yaml`. The acceptance criterion for FR59 is: "Synthesis script produces output matching EXPECTED.yaml on the 20-record test fixture with zero discrepancies."

---

## AMENDMENT: FR61 — AUTHORITATIVE RANKING FORMULA AND SCOPE-MATCHING ALGORITHM
**Type:** MODIFY_FR
**Target:** FR61
**Reason:** FR61 and Journey 5 specify two different ranking formulas (tier + recency vs. confidence × recency × relevance), and the scope-matching algorithm has no defined priority order, making injection correctness unverifiable.

**Original text:**
> - **FR61:** Overlay injection can match synthesized learnings to agent file scope and role, rank by tier (critical / recommended / informational) and recency, and inject within hard token ceiling (500 tokens economy, 1000 tokens standard)

**Replacement text:**
> - **FR61:** Overlay injection can match synthesized learnings to agent file scope and role, rank by injection score, and inject within hard token ceiling (500 tokens economy, 1000 tokens standard), according to the following specified algorithms:
>   - **Scope-matching algorithm (authoritative priority order):** A synthesized learning is a candidate for injection if it matches the agent's assigned file scope by any of the following criteria, evaluated in priority order (highest to lowest): (1) **exact file path** — the learning's `file_scope` exactly matches the agent's assigned file path; (2) **directory prefix** — the learning's `file_scope` is a directory path that is a prefix of the agent's assigned file path (e.g., `src/payments/` matches an agent assigned to `src/payments/webhook.ts`); (3) **module match** — the learning's `file_scope` matches the module identifier declared in the agent's overlay `module` field; (4) **no match** — the learning is not a candidate for this agent. Role filtering is applied after scope matching: learnings tagged with a `role` field are only injected into agents whose role matches exactly. Learnings with no `role` field are eligible for any role.
>   - **Injection ranking formula (single authoritative formula, supersedes Journey 5 narrative):** Candidates passing scope and role filtering are ranked by `injection_score = tier_weight × recency_factor`, where `tier_weight` is: `critical=3.0`, `recommended=2.0`, `informational=1.0`; and `recency_factor = 1 / (1 + days_since_recorded)` where `days_since_recorded` is the integer number of days between `recorded_at` and the current pipeline run date. Tie-breaking (equal `injection_score` to two decimal places) is resolved by `recorded_at` descending (most recent wins). `critical`-tier learnings are always injected first and are never truncated by the token ceiling; if critical-tier learnings alone exceed the ceiling, they are truncated at the ceiling boundary with a warning logged to the pipeline run record.
>   - **Behavioral proxy acceptance criterion:** For a test story running in a scope that has 3 or more synthesized `critical`-tier learnings, the first-attempt post-task hook pass rate must be measurably higher than a baseline story run in the same scope with learning injection suppressed via the FR62 `spike`/`exploratory` escape hatch. "Measurably higher" is defined as: pass rate in the injected condition exceeds pass rate in the suppressed condition by ≥10 percentage points across a minimum of 5 story runs in each condition. This acceptance criterion must be verified before FR61 is considered complete.

---

## AMENDMENT: FR57 — STRENGTHEN LEARNING REPORT MAIL ACCEPTANCE CRITERION
**Type:** MODIFY_FR
**Target:** FR57
**Reason:** The current FR verifies only that mail is sent; it does not require that the story lead receives and can act on the mail, leaving the loop unverified.

**Original text:**
> - **FR57:** Agents can send `learning_report` mail to the story lead during execution (Loop 1 — session-level tactical learning)

**Replacement text:**
> - **FR57:** Agents can send `learning_report` mail to the story lead during execution (Loop 1 — session-level tactical learning); the story lead's agent must receive the mail (readable from the Overstory mail table with `type = learning_report` and the correct `recipient` field), and if the learning report contains a `recommended_action` field, the story lead must acknowledge it (log an acknowledgment entry to the story run record) before proceeding to the next phase boundary. Acceptance criterion: inject a `learning_report` mail during an active story run; verify (a) the mail row exists in the Overstory mail table with `type = learning_report`, `sender = <originating_agent_id>`, `recipient = <story_lead_agent_id>`, and `status = delivered`; and (b) if the mail contains `recommended_action`, the story lead's next phase boundary transfer manifest contains an `acknowledged_learnings` array entry referencing the mail's `id`.

---

## AMENDMENT: FR58 — ADD BMAD BEHAVIORAL CHANGE ACCEPTANCE CRITERION
**Type:** MODIFY_FR
**Target:** FR58
**Reason:** Field existence in the manifest is verifiable, but whether cross-phase learnings actually change BMAD agent behavior in flagged scopes is not, leaving the intelligence loop's effectiveness unmeasured.

**Original text:**
> - **FR58:** Phase Boundary Protocol transfer manifests can include a `learnings` section carrying forward development phase struggles and discoveries (Loop 2 — cross-phase intelligence)

**Replacement text:**
> - **FR58:** Phase Boundary Protocol transfer manifests can include a `learnings` section carrying forward development phase struggles and discoveries (Loop 2 — cross-phase intelligence). The `learnings` section must be a structured list where each entry contains: `learning_id` (reference to the source learning record), `scope`, `category`, `summary` (≤ 100 tokens), and `tier`. Acceptance criterion for field correctness: after a development phase completes with at least one agent-generated learning record, inspect the phase boundary manifest and verify the `learnings` array is non-empty and each entry contains all required fields. Acceptance criterion for behavioral impact: for a scope that has at least 2 `critical`-tier cross-phase learnings in the transfer manifest, the BMAD reviewer agent's finding count in that scope must be demonstrably higher (≥1 additional finding on average across 3 comparable story pairs) when the `learnings` section is present in the manifest versus when it is absent (controlled by omitting the `learnings` field via test fixture). This verifies the learnings reach the BMAD agent and alter its scrutiny behavior, not merely that the field is populated.

---

## AMENDMENT: FR63 — ADD CASCADE RETRACTION SYNTHESIS-SKIP TEST
**Type:** MODIFY_FR
**Target:** FR63
**Reason:** The existing FR verifies that source records receive retraction tags, but does not require verifying that re-running synthesis skips those retracted sources, leaving the resurrection-prevention guarantee untested.

**Original text:**
> - **FR63:** Developer can retract a synthesized learning with cascading retraction to all source records (preventing resurrection on next synthesis)

**Replacement text:**
> - **FR63:** Developer can retract a synthesized learning with cascading retraction to all source records (preventing resurrection on next synthesis). Retraction mechanics: the `qds learnings retract <learning_id>` command must (a) set `retracted: true` and `retracted_at: <ISO8601>` on the synthesized learning record in `.qds/learnings/synthesized/`; (b) write a `retraction_tag: true` field to every source raw learning record that contributed to the synthesized learning (identified via the `source_record_ids` array on the synthesized record); and (c) log the full retraction event (synthesized ID, count of source records tagged, timestamp) to `.qds/learnings/synthesis-log/retractions.log`. Cascade retraction test (required acceptance criterion): after retracting a synthesized learning, re-run the synthesis script against the same source dataset; verify that (a) none of the retraction-tagged source records appear in the new synthesis output, and (b) no synthesized record with the retracted `learning_id` is regenerated. Verify by diffing the new `.qds/learnings/synthesized/` output against the pre-retraction snapshot — the retracted learning must be absent.

---

## AMENDMENT: FR84 — NORMALIZATION FORMULA, DEGRADATION THRESHOLD, AND TIME-INJECTION PREREQUISITE
**Type:** MODIFY_FR
**Target:** FR84
**Reason:** "Normalized metrics comparing like-for-like work" is undefined, making the auto-revert trigger condition untestable; and the feature cannot be acceptance-tested without a time-injection utility.

**Original text:**
> - **FR84:** If daily journals following a meta-optimization change detect performance degradation using normalized metrics (tokens per file modified, stalls per complexity estimate, BMAD correction rate by scope) comparing like-for-like work, the next weekly optimizer cycle can auto-revert the change and log the reversion reason

**Replacement text:**
> - **FR84:** If daily journals following a meta-optimization change detect performance degradation using normalized metrics comparing like-for-like work, the next weekly optimizer cycle must auto-revert the change and log the reversion reason. Normalization and degradation are defined as follows:
>   - **Normalization formula (authoritative):** `normalized_tokens_per_file = total_phase_tokens / count(files where line_delta > 10)`. `total_phase_tokens` is the sum of all Pi SDK token charges attributed to the story's development and review phases. `count(files where line_delta > 10)` is the count of files in the story's git diff where the absolute line delta (additions + deletions) exceeds 10 lines. Stories where this denominator is zero are excluded from normalization calculations (patch-only stories are not comparable).
>   - **Like-for-like classification:** A story is comparable to another story for normalization purposes when both stories have the same `work_type` (Story or Task), both have `complexity_estimate` within the same bucket (small: 1–3 files, medium: 4–10 files, large: 11+ files), and neither is tagged `spike` or `exploratory`.
>   - **Degradation threshold:** Degradation is triggered when the `normalized_tokens_per_file` for stories completed after a meta-optimization change is applied exceeds 1.5× the rolling average `normalized_tokens_per_file` of the last 5 comparable stories completed before the change was applied. The 1.5× threshold and the 5-story window are configurable in `factory.yaml` under `meta_optimization.degradation_threshold` and `meta_optimization.baseline_window` respectively.
>   - **Auto-revert trigger:** The weekly optimizer evaluates the degradation condition on each run. If the condition is met and the story count in the post-change window meets the FR87 minimum threshold, it must: (a) execute the revert payload stored in the weekly record (restoring previous configuration state atomically), (b) update the lifecycle record `status` to `reverted` and set `reversion_reason = performance_degradation`, and (c) emit a dashboard alert classified as "Meta-Optimization Auto-Reverted" with the normalized metric delta displayed.
>   - **Prerequisite test tool (blocking — must be built before FR84 implementation begins):** A cron time-injection utility `qds dev advance-cron <days>` must exist before implementation of FR84 begins. This utility replays the daily and weekly cron scheduler at accelerated rate against fixture journal data without requiring real elapsed time or real story completions. The acceptance criterion for FR84 using this tool is: "Given a fixture set of daily journals representing post-change stories with `normalized_tokens_per_file` exceeding 1.5× the pre-change baseline, running `qds dev advance-cron 7` must produce a weekly optimizer run that emits a revert action, updates the lifecycle record to `status: reverted`, and sets `reversion_reason: performance_degradation`."

---

## AMENDMENT: FR88 — MEASURABLE IMPROVEMENT DEFINITION AND FIRST-FAILURE RISK NOTE
**Type:** MODIFY_FR
**Target:** FR88
**Reason:** "Measurable improvement" is undefined (no metric, threshold, or sample size), and the 2-week effectiveness window means a bug in auto-revert cannot be discovered until 14 days after the first change is applied.

**Original text:**
> - **FR88:** Meta-optimization changes carry a configurable effectiveness window (default 2 weeks); if the daily observer does not detect measurable improvement within the window, the change is auto-reverted and the improvement hypothesis is logged as "unvalidated"

**Replacement text:**
> - **FR88:** Meta-optimization changes carry a configurable effectiveness window (default 14 days); if the daily observer does not detect measurable improvement within the window, the change is auto-reverted and the improvement hypothesis is logged as "unvalidated". Measurable improvement is defined as follows:
>   - **Metric and threshold:** The daily observer computes `normalized_tokens_per_file` (as defined in FR84) for each story completed after the meta-optimization change was applied. Measurable improvement is detected when the rolling average `normalized_tokens_per_file` over stories completed within the effectiveness window is ≥5% lower than the pre-change baseline (rolling average of last 5 comparable stories before the change). The 5% improvement threshold and baseline window size are configurable in `factory.yaml` under `meta_optimization.improvement_threshold_pct` and `meta_optimization.baseline_window`.
>   - **Minimum sample size:** The effectiveness window evaluation requires a minimum of 3 comparable story completions within the window period before rendering a verdict. If fewer than 3 comparable stories complete within the window, the window is extended by 7 days (one extension only); if the minimum is still not met, the lifecycle record is set to `status: inconclusive` rather than triggering auto-revert.
>   - **Auto-revert on expiry:** When the effectiveness window expires without measurable improvement (per the above definition and minimum sample size), the weekly optimizer must: (a) execute the revert payload atomically, (b) set `status: reverted` and `reversion_reason: effectiveness_window_expired` on the lifecycle record, (c) set `improvement_hypothesis: unvalidated`, and (d) emit a dashboard alert classified as "Meta-Optimization Auto-Reverted (Effectiveness Window Expired)."
>   - **First-failure discovery risk (implementation note):** The first meta-optimization change may be applied on Day 1 of production operation. The earliest opportunity to verify that the effectiveness window auto-revert mechanism functions correctly is 14 days later. If the auto-revert mechanism has a bug, that bug will not be discovered for up to 14 days. **Mitigation required:** The `qds dev advance-cron <days>` time-injection utility (introduced as a prerequisite in FR84) must be used to acceptance-test FR88 in accelerated time before the first production meta-optimization change is applied. The acceptance criterion is: "Using `qds dev advance-cron 14` with fixture journals that contain no stories showing ≥5% improvement, verify the weekly optimizer produces a revert action with `reversion_reason: effectiveness_window_expired`." This test must pass before FR88 is marked complete.

---

## AMENDMENT: FR79 — DEFINE "RECURRING PATTERN" WITH NUMERIC THRESHOLD
**Type:** MODIFY_FR
**Target:** FR79
**Reason:** "Recurring patterns" and "distinguish signal from noise" are subjective, making the weekly cron's pattern detection output unverifiable.

**Original text:**
> - **FR79:** A weekly cron agent can read the last 7 daily journals, identify recurring patterns (issues flagged on multiple days), distinguish signal from noise, and rank improvement opportunities by estimated impact

**Replacement text:**
> - **FR79:** A weekly cron agent can read the last 7 daily journals, identify recurring patterns, distinguish signal from noise, and rank improvement opportunities by estimated impact. Recurring pattern is defined as: a named analysis dimension (as defined in FR77) that is flagged as anomalous in ≥3 of the 7 daily journals in the analysis window. "Flagged as anomalous" means the dimension's daily journal entry carries an `anomaly: true` field, set by the daily observer when the dimension's measured value exceeds its configured anomaly threshold (stored in `factory.yaml` under `meta_optimization.anomaly_thresholds.<dimension>`). Signal vs. noise: dimensions flagged in exactly 1 or 2 of 7 journals are classified as `noise` and recorded in the weekly report's `noise_observations` array but not eligible for optimizer action. Dimensions flagged in ≥3 of 7 journals are classified as `signal` and eligible for ranking and optimizer action. The weekly report must include a `pattern_detection_summary` field listing each dimension, its flag count (0–7), and its `signal` or `noise` classification.

---

## AMENDMENT: FR80 — DEFINE IMPACT SCORING FORMULA FOR WEEKLY OPTIMIZER
**Type:** MODIFY_FR
**Target:** FR80
**Reason:** "Highest-impact improvement opportunity" is opaque — without a defined scoring formula, the selection cannot be verified as correct or reproduced.

**Original text:**
> - **FR80:** The weekly cron agent can select the single highest-impact improvement opportunity and implement a targeted change — operational parameters (prompt template adjustments, overlay composition rebalancing, context budget reallocation) apply normally; cost-impacting changes (tier policy updates, budget-affecting configurations) are flagged as "cost-impacting change" with elevated dashboard visibility

**Replacement text:**
> - **FR80:** The weekly cron agent can select the single highest-impact improvement opportunity and implement a targeted change — operational parameters (prompt template adjustments, overlay composition rebalancing, context budget reallocation) apply normally; cost-impacting changes (tier policy updates, budget-affecting configurations) are flagged as "cost-impacting change" with elevated dashboard visibility. Impact scoring formula: each `signal`-classified recurring pattern (as defined in FR79) is assigned an `impact_score = recurrence_count × dimension_weight × magnitude_factor`, where:
>   - `recurrence_count` is the number of days (1–7) the dimension was flagged as anomalous in the current analysis window.
>   - `dimension_weight` is a configurable per-dimension weight in `factory.yaml` under `meta_optimization.dimension_weights.<dimension>` (default weights: `token_consumption=3.0`, `stall_rate=3.0`, `bmad_findings_per_story=2.5`, `qa_findings_per_story=2.5`, `hook_enforcement_overhead=2.0`, `overlay_stage_efficiency=1.5`, `context_window_utilization=1.5`, `phase_boundary_manifest_waste=1.0`, `model_tier_performance=1.0`).
>   - `magnitude_factor = measured_value / anomaly_threshold` for the most recent daily journal entry where the dimension was flagged (ratio of actual value to configured threshold; always ≥1.0 for flagged dimensions).
>   - The pattern with the highest `impact_score` is selected as the optimization target. Ties are broken by `dimension_weight` descending; remaining ties are broken by `recurrence_count` descending. The weekly report must include an `impact_scores` object listing the computed score for each signal-classified pattern, enabling human verification of the selection.

---

## AMENDMENT: FR77 — FULLY DEFINE ALL 9 ANALYSIS DIMENSIONS WITH MEASURABLE OUTPUT FORMAT
**Type:** MODIFY_FR
**Target:** FR77
**Reason:** The 9 analysis dimensions are named but not defined — without measurable output specifications, the daily journal cannot be used as a consistent input to the weekly optimizer or verified for completeness.

**Original text:**
> - **FR77:** A daily cron agent can analyze that day's factory operations — token consumption patterns, context window utilization, overlay stage efficiency, prompt effectiveness (stall/retry correlation), model tier performance by agent role, phase boundary manifest waste, hook enforcement overhead, BMAD findings per story, and QA findings per story — and write a structured daily journal to `.qds/meta/daily/YYYY-MM-DD.yaml`

**Replacement text:**
> - **FR77:** A daily cron agent can analyze that day's factory operations and write a structured daily journal to `.qds/meta/daily/YYYY-MM-DD.yaml`. The journal must include a `dimensions` map with all 9 of the following entries. Each dimension entry has a `value` (the measured quantity), `anomaly` (boolean, `true` if `value` exceeds the configured anomaly threshold), and `anomaly_threshold` (the configured threshold value, for auditability). The 9 dimensions and their `value` definitions are:
>   1. **`token_consumption`** — `value`: `normalized_tokens_per_file` rolling average across all stories that completed today (using FR84 normalization formula); unit: tokens/file.
>   2. **`context_window_utilization`** — `value`: mean context window fill percentage at phase boundary across all phase transitions today (computed from `context_budget_consumed` field in phase boundary manifests); unit: percentage (0.0–100.0).
>   3. **`overlay_stage_efficiency`** — `value`: mean ratio of injected overlay tokens to agent-generated output tokens across all agent sessions today; unit: ratio (e.g., 0.12 means overlay was 12% of output). Lower is more efficient; anomaly triggers when ratio exceeds threshold.
>   4. **`prompt_effectiveness`** — `value`: stall-to-completion ratio today — count(agent sessions with ≥1 stall event) / count(agent sessions completed); unit: ratio (0.0–1.0). Lower is better; anomaly triggers when ratio exceeds threshold.
>   5. **`model_tier_performance`** — `value`: per-role object mapping each agent role (`builder`, `reviewer`, `qa`, `scout`) to its mean tokens-per-story-phase for today; anomaly field is set to `true` if any role's mean exceeds its configured per-role threshold (stored in `meta_optimization.anomaly_thresholds.model_tier_performance.<role>`).
>   6. **`phase_boundary_manifest_waste`** — `value`: mean token count of the `context_budget_consumed` field in phase boundary manifests for transitions that were immediately followed by a stall event in the receiving agent within the first 500 tokens of output; unit: tokens. High value indicates manifests are large but not preventing early stalls.
>   7. **`hook_enforcement_overhead`** — `value`: mean wall-clock milliseconds consumed by hook execution at phase boundaries today, computed from hook start/end timestamps in pipeline run logs; unit: milliseconds.
>   8. **`bmad_findings_per_story`** — `value`: mean count of BMAD findings (all severities) per story that completed BMAD review today; unit: findings/story.
>   9. **`qa_findings_per_story`** — `value`: mean count of QA wave failures per story that completed QA today (across all 5 waves); unit: failures/story.
>
>   The daily journal must also include: `date` (YYYY-MM-DD), `stories_completed` (count), `stories_in_progress` (count), `data_sources_read` (list of file paths and database tables read), and `anomaly_count` (count of dimensions with `anomaly: true`). If no stories completed on a given day, all dimension `value` fields are set to `null` and `anomaly` is set to `false`; the journal is still written.

---

*Amendment count: 10 amendments covering FR57, FR58, FR59, FR61, FR63, FR77, FR79, FR80, FR84, FR88.*
*All amendments are additive — no existing FR text is removed without replacement.*
*Prerequisite artifacts introduced: synthesis test fixture (FR59), `qds dev advance-cron` time-injection utility (FR84, FR88).*
*Internal inconsistency resolved: Journey 5 ranking formula (confidence × recency × relevance) superseded by FR61 authoritative formula (tier_weight × recency_factor) across the entire document.*
