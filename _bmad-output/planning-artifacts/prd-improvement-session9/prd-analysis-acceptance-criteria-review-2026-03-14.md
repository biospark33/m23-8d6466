# User Acceptance Criteria Review: QDS Engineer v2 PRD
**Date:** 2026-03-14
**Document Reviewed:** `prd-v2.md` (v2.0, consolidated from base PRD + Session 8 amendments, 2026-03-10)
**Scope:** MVP Functional Requirements (FR1–FR132, FR140, FR142, FR145, FR149, FR152, FR155, FR163–FR168, FR170–FR171) plus Non-Functional Requirements (NFR1–NFR40)
**Reviewers (intended):** 2-developer team (Steve + co-dev)

---

## Executive Summary

The PRD is architecturally thorough and internally consistent. The FR text is specific and well-structured, the NFRs are measurably defined, and the innovation section is honest about risks and fallbacks. However, the document is a capability contract, not an acceptance test suite — and the gap between "what the system must do" and "how you verify it did it" is significant for the most complex capabilities.

**Verdict by cluster:**

| FR Cluster | Testability Score | Primary Bottleneck |
|---|---|---|
| Pipeline Execution (FR1–FR9) | 4/5 | FR2 dependency detection undefined |
| Quality Enforcement / Hook Pipeline (FR10–FR20) | 4/5 | FR10 context isolation unverifiable without a canary harness |
| Agent Orchestration (FR21–FR27) | 4/5 | FR22/FR24 require reliable crash injection |
| Overlay & Context Management (FR28–FR35) | 3/5 | FR32 manifest "required sections" lack a published schema |
| Resource & Economic Management (FR36–FR42) | 4/5 | FR36 tier routing requires Pi SDK model-identifier introspection |
| Dashboard & Observability (FR43–FR50) | 4/5 | FR47 stall classification accuracy is subjective |
| Git & PR Operations (FR51–FR54, FR90) | 5/5 | None; all verifiable with `gh` CLI |
| Factory Learning System (FR55–FR63) | 2/5 | Injection correctness and synthesis fidelity lack objective ACs |
| Memory & Knowledge (FR64–FR68) | 4/5 | Well-bounded |
| Developer Operations (FR69–FR72) | 5/5 | Script output is deterministic |
| Operational Safety (FR73–FR76) | 3/5 | FR75 provider-down auto-resume requires deliberate injection |
| Meta-Optimization (FR77–FR89) | 2/5 | Auto-revert and effectiveness windows are untestable without time acceleration |
| Resilience & Integrity (FR91–FR104) | 3/5 | Three "MVP if feasible" deferrals unresolved; FR100 threshold undefined |
| Dashboard Copilot (FR105–FR119) | 3/5 | FR107/FR116 mode quality is model-dependent and subjective |
| Developer Communication (FR120–FR129) | 4/5 | FR128 NL classification accuracy has no minimum-bar AC |
| Agent Performance Data (FR130–FR132, FR140) | 4/5 | Brier score resolution requirement is specific and verifiable |
| Economic Governance (FR142, FR145) | 5/5 | Atomic checkout and budget enforcement are mechanically testable |
| Orchestration (FR149) | 4/5 | Velocity extension boundary conditions need explicit test cases |
| Quality Verification (FR152, FR155, FR163) | 4/5 | FR152 oscillation detection logic is under-specified |
| Self-Learning System (FR164–FR168, FR170–FR171) | 3/5 | Pattern confidence and maintenance burden trending need baselines |

**Overall PRD testability: 3.5/5.** Infrastructure and safety FRs are well-defined and testable. The learning system, meta-optimization, and context management FRs require significant test harness design before implementation begins.

---

## Scoring Rubric

| Score | Meaning |
|---|---|
| 5 | All ACs are specific, measurable, and passable by 2 developers with standard tooling (SQLite inspection, log parsing, `gh` CLI, filesystem checks) |
| 4 | Most ACs are testable; 1–2 require deliberate test setup (crash injection, API throttle simulation) but no specialized infrastructure |
| 3 | Several ACs are vague or require external dependency introspection (Pi SDK internals, model behavior verification) not within the team's direct control |
| 2 | Core ACs require either a purpose-built test harness, time acceleration (for effectiveness windows), or comparative baseline data that does not yet exist |
| 1 | ACs are aspirational descriptions with no objectively passable criteria |

---

## Detailed Cluster Analysis

---

### Cluster 1: Pipeline Execution (FR1–FR9)
**Testability Score: 4/5**

| FR | AC as Stated in PRD | Specific & Measurable? | Testable by 2 Devs? | External Dependency? | Verdict |
|---|---|---|---|---|---|
| FR1 | Submit stories, factory runs to PR without further intervention | Yes | Yes — run end-to-end, verify PR created | No | Pass/fail clear |
| FR2 | Decompose epic with automatic dependency detection | Partial — "dependency detection" is undefined | Partial — need sample epic with known deps | No | **Vague: no definition of correctness** |
| FR3 | Developer can override auto-detected dependencies | Yes | Yes — UI control + verify pipeline change | No | Clear |
| FR4 | Multiple stories in isolated worktrees, no cross-contamination | Yes — worktree isolation is verifiable | Yes — inspect filesystem, verify no cross-writes | No | Needs concurrent story test fixture |
| FR5 | Assemble correct phases for work type (Story: 5-phase, Task: develop+PR) | Yes | Yes — observe phase progression in dashboard/logs | No | Clear |
| FR6 | Transition phases with fresh agents and structured manifests | Yes | Yes — verify new agent process IDs, verify manifest file exists | No | Clear |
| FR7 | Fix loop with configurable circuit breaker | Yes | Yes — inject failing BMAD output, count iterations | No | Circuit breaker count verifiable in logs |
| FR8 | PR with structured evidence body | Yes | Yes — inspect PR body against template schema | No | Template schema must be formally defined |
| FR9 | Task work type with minimal pipeline | Yes | Yes — verify fewer phases activated | No | Clear |

#### Issues and Recommendations

**FR2 — Dependency detection has no definition of correctness.** The PRD says the factory "can decompose a multi-story epic into individual story executions with automatic dependency detection between stories." No detection algorithm is defined, no example dependency types are given, and no minimum detection rate is specified. Without these, the AC cannot be failed objectively.

> **Recommendation:** Add an explicit AC: "Given a test epic of N stories with K known declared dependencies (expressed as overlapping file paths in story specs or explicit `depends_on` fields), the factory correctly detects at least K dependencies." Define the dependency signal before implementation begins. FR3 (manual override) is the safety net for misses, but the detection mechanism itself must be testable.

**FR8 — PR evidence body schema is not formalized.** The PR body is described narratively in Journey 4 and partially in FR52, but the required schema (field names, required vs optional, format) is not a standalone document.

> **Recommendation:** Define a PR evidence schema (Markdown template or JSON Schema) as a prerequisite artifact. The AC for FR8 becomes: "PR body validates against the published schema with no missing required fields."

---

### Cluster 2: Quality Enforcement / Hook Pipeline (FR10–FR20)
**Testability Score: 4/5**

| FR | Key AC | Specific & Measurable? | Testable by 2 Devs? | External Dependency? | Verdict |
|---|---|---|---|---|---|
| FR10 | BMAD agents have no access to development phase context | Yes — stated as zero-leakage guarantee | Partial — "no access" is structural, not behavioral | Yes — requires canary harness | **Critical gap: see deep dive** |
| FR11 | BMAD findings categorized critical/warning/info | Yes | Yes — inspect structured findings report | No | Clear |
| FR12 | Multi-wave QA with configurable stopping threshold | Yes | Yes — configure N waves, inject findings | No | Clear |
| FR13 | QA scouts on economy-tier models via Pi SDK | Yes | Partial — requires Pi SDK model-identifier inspection | Yes — Pi SDK | See Cluster 5 |
| FR14 | 6-layer progressive enforcement | Partial — "can enforce" is a capability claim, not a test | Yes for individual layers | No | Must be tested layer-by-layer |
| FR15 | Post-edit hook blocks scope violations | Yes | Yes — attempt out-of-scope write, verify block | No | Clear; needs test fixture agent |
| FR16 | TDD hook sends warning via mail | Yes | Yes — inspect Overstory mail table | No | Clear |
| FR17 | Post-task hooks block on test/lint/type failure | Yes | Yes — inject failing test, verify task rejection | No | Clear |
| FR18 | Phase boundary gate checklist enforced | Yes | Yes — leave uncommitted changes, verify block | No | Clear |
| FR19 | Hook results visible in agent output stream | Yes | Yes — inspect xterm.js output | No | Clear |
| FR20 | Phase gate checklist in dashboard | Yes | Yes — observe dashboard during transition | No | Clear |

#### Deep Dive: FR10 — Context Isolation Guarantee

This is the most critical and most difficult AC in the entire PRD. The adversarial review guarantee depends entirely on BMAD agents having zero access to development-phase context. The PRD's innovation validation plan states: "Audit BMAD outputs for references to development-phase-only artifacts. Any leakage is a failure."

**The problem with the audit approach:** This tests for *observed leakage*, not *structural impossibility of leakage*. A BMAD agent could produce output that never mentions development-phase artifacts — not because isolation worked, but because the agent happened not to reference them. Conversely, the agent might reference similar code constructs for entirely legitimate reasons. The audit approach is necessary but not sufficient.

**What would actually verify isolation:**

1. **Structural canary test (recommended):** Inject a deliberate "canary" artifact into the development phase that has no legitimate use in the review phase — for example, a function named `__canary_dev_only_xyz__` that is never committed to the worktree. Verify the BMAD agent's overlay and output never contain this string. This is repeatable, falsifiable, and automatable.

2. **Process read-trace test:** Log all file reads by the BMAD agent's process (via strace/dtrace or a filesystem audit hook). Verify no reads occur outside the worktree's reviewed code paths and the manifest file.

3. **Manifest-only channel test:** Verify that the Phase Boundary Protocol transfer manifest is the *only* channel between development and BMAD phases by confirming no shared memory, no named pipes, and no additional filesystem paths are accessible to both agent processes.

> **Recommendation:** Before implementation begins, define the canary injection test as the canonical AC for FR10: "A canary string injected only into the development phase context (not into any committed artifact, worktree file, or shared path) must be absent from the BMAD agent's overlay content, output stream, and Phase Boundary Protocol manifest." This test must run for every story processed through the factory from day one of MVP operation. The validation plan's "50 phase transitions with zero leakage" is the right ambition — but the measurement mechanism must be the canary, not a subjective audit.

---

### Cluster 3: Agent Orchestration (FR21–FR27)
**Testability Score: 4/5**

| FR | Key AC | Specific & Measurable? | Testable by 2 Devs? | External Dependency? | Verdict |
|---|---|---|---|---|---|
| FR21 | Spawn, monitor, stop, replace agents | Yes | Yes — via dashboard and process inspection | No | Clear |
| FR22 | Auto-recovery: detect within 10s, spawn within 30s (NFR14) | Yes — NFR14 gives timing bounds | Yes — requires crash injection | No | Timing measured by timestamp delta; needs kill utility |
| FR23 | Mail system including `learning_report` type | Yes | Yes — SQLite inspection of mail table | No | Clear; verify message type field exists |
| FR24 | Checkpoint and resume without data loss | Yes — NFR15 defines scope of "no data loss" | Yes — kill process mid-run, verify resume | No | Needs reliable process kill at a deterministic point |
| FR25 | Stop agent from dashboard | Yes | Yes — stop, verify process exits | No | Clear |
| FR26 | Nudge via dashboard with content logged | Yes | Yes — SQLite inspection of story record | No | Clear |
| FR27 | Inspect live output | Yes | Yes — UI observation | No | Clear |

#### Issues and Recommendations

**FR22 / NFR14 — Recovery timing AC depends on reliable crash injection.** NFR14 specifies "detect within 10 seconds, spawn replacement within 30 seconds." This is measurable (timestamp delta), but requires a test utility that can kill an agent process at a deterministic point in execution and record the timeline.

> **Recommendation:** Add `qds dev crash-agent <agent_id>` to the implementation plan — a test utility that forcefully terminates an agent and records the crash timestamp. Without this, recovery timing can only be observed opportunistically during real failures, which is not a repeatable acceptance test.

**FR24 — "Zero data loss" definition is incomplete.** NFR15 states "no completed phases re-executed, no learning records lost, no duplicate commits." What about in-flight mail messages? What about partially-written learning records at the moment of crash?

> **Recommendation:** Add explicit recovery invariants: (a) After crash-and-resume, `pipeline.db` state for all completed phases must be identical to pre-crash state (verifiable by SQLite dump comparison). (b) Any mail message with `created_at` before the crash must be readable by its recipient after resume. (c) No learning record file in `.qds/learnings/` may exist in a partial or schema-invalid state after resume (verifiable by running the learning schema validator over all files).

---

### Cluster 4: Overlay & Context Management (FR28–FR35)
**Testability Score: 3/5**

| FR | Key AC | Specific & Measurable? | Testable by 2 Devs? | External Dependency? | Verdict |
|---|---|---|---|---|---|
| FR28 | 6-stage overlay assembly within token ceiling (500ms per NFR4) | Yes — NFR4 gives timing bound | Yes — timing instrumentation | No | Clear; verify stage output token sizes |
| FR29 | Per-stage priority truncation | Yes | Yes — exhaust a stage budget, verify truncation log | No | Clear; needs budget-exhaust test fixture |
| FR30 | Context budget check before agent launch | Yes | Yes — construct oversized overlay, verify launch blocked | No | Clear |
| FR31 | Split task scope or escalate tier on budget failure | Yes | Partial — tier escalation verification requires Pi SDK response | Yes — Pi SDK | See FR36 |
| FR32 | Transfer manifest with required sections + learnings section | Partial — "required sections" not defined | Partial — can check named fields exist; not content fidelity | No | **Schema gap: see deep dive** |
| FR33 | Superpowers skills injected into overlay | Yes | Yes — inspect assembled overlay content | No | Clear |
| FR34 | Enforcement metadata consumed by hooks | Yes | Yes — verify hook runner reads `enforcement` YAML field | No | Clear |
| FR35 | Mulch scoped to agent file path | Yes | Yes — verify injected Mulch content matches file path scope | No | Clear |

#### Deep Dive: FR32 — Transfer Manifest Completeness

The Phase Boundary Protocol is identified as the "highest design risk" in the PRD. Yet FR32 states only that manifests contain "required sections, context budget consumed, and a learnings section" — without defining what those required sections are.

Three missing definitions make this AC unverifiable:

1. The manifest schema (field names, types, required vs optional) is not published.
2. What constitutes a "valid" manifest is undefined (FR18 says the phase boundary hook validates manifest schema, but no schema exists to validate against).
3. What makes a manifest "too lossy" — i.e., when does context transfer fail to provide sufficient information to the next phase — has no detection mechanism.

The PRD explicitly acknowledges the lossiness risk: "Phase Boundary Protocol is too lossy — important context lost → Expand manifest schema." But there is no AC that detects when the manifest is too lossy before it causes a quality failure.

> **Recommendation (blocking):** Define the Phase Boundary Protocol manifest as a typed YAML schema with at minimum these required fields: `story_id`, `phase_from`, `completed_artifacts[]`, `open_questions[]`, `learnings[]`, `context_budget_consumed_tokens`, `confidence` (FR131). This schema document is a prerequisite story that must be completed before the Phase Boundary Protocol implementation begins. The AC for FR32 becomes: "Manifest validates against the published JSON Schema with all required fields present and no unknown top-level fields."

> **Recommendation (functional fidelity):** Add a manifest fidelity acceptance test: "A BMAD agent initialized from only the transfer manifest (no additional context) must correctly enumerate the top 3 implementation decisions made in the development phase, as seeded by injecting a test manifest describing 3 known decisions." This test is constructible and falsifiable, and it verifies that the manifest actually carries useful information rather than just satisfying schema validation.

---

### Cluster 5: Resource & Economic Management (FR36–FR42)
**Testability Score: 4/5**

| FR | Key AC | Specific & Measurable? | Testable by 2 Devs? | External Dependency? | Verdict |
|---|---|---|---|---|---|
| FR36 | Model tier directives executed by Pi SDK | Partial — "Pi SDK executing natively" is a black box | Partial — requires Pi SDK to report model used | **Yes — Pi SDK** | See deep dive |
| FR37 | Token spend tracked per story with phase visibility | Yes | Yes — query `attribution.db` | No | Clear |
| FR38 | Per-story cost circuit breaker | Yes | Yes — set low threshold, verify story halts | No | Clear |
| FR39 | Daily global budget ceiling | Yes | Yes — set low ceiling, verify pause | No | Clear |
| FR40 | Worktree lifecycle management | Yes | Yes — filesystem inspection | No | Clear |
| FR41 | Orphaned worktree cleanup on startup | Yes | Yes — manually create orphaned worktree, restart, verify cleanup | No | Clear |
| FR42 | Full attribution chain on every API call | Yes — NFR10 defines verification via scanning | Yes — automated attribution field scan | No | Clear; add to CI pipeline |

#### Deep Dive: FR36 — Economy-Tier Routing Verification

**The core question:** How do you verify the correct model tier is actually being used?

The PRD says Factory Core "assigns model tier directives (economy/standard/premium) per agent role, with Pi SDK executing model selection natively." Economy tier is used for QA scouts (FR13), Copilot queries (FR118), cron agents (meta-optimization), and Telegram NL classification (FR128). This is both a cost guarantee (NFR22: quality pipeline cost ≤5% of total story cost) and a correctness guarantee.

**What cannot be verified without Pi SDK internals:**
- Whether the economy model actually used matches the requested tier (the factory sends a tier directive; Pi SDK decides which model satisfies it).
- Whether tier escalation fired correctly when an economy model lacked required capabilities.
- Whether the model identifier in Pi's response actually corresponds to a cheaper model than the standard tier.

**What can be verified with available tools:**
- That the factory *sends* the correct tier directive — verifiable by inspecting the Pi SDK API call payload.
- That Pi SDK *returns* a model identifier — verifiable if Pi SDK logs or returns model metadata per call.
- That the attribution chain (FR42) records the model identifier for every call.

> **Recommendation:** Extend the attribution chain (FR42) to include the model identifier returned by Pi SDK alongside the tier directive sent. This gives the team: (a) an AC for FR36 — "In attribution.db, every QA swarm scout call has a model_identifier that differs from builder-tier calls," (b) a verifiable proxy for economy-tier routing without requiring Pi SDK internals, and (c) a foundation for the NFR22 cost verification ("quality pipeline cost ≤5%").

> **Recommendation:** If Pi SDK does not expose model identifiers per call, add this requirement to the Pi SDK integration contract before implementation begins. The factory cannot verify tier routing without it.

---

### Cluster 6: Factory Learning System (FR55–FR63)
**Testability Score: 2/5**

This is the most difficult cluster to test. All three loops involve emergent behavior that is only verifiable over multiple story runs with accumulated data.

| FR | Key AC | Specific & Measurable? | Testable by 2 Devs? | External Dependency? | Verdict |
|---|---|---|---|---|---|
| FR55 | Atomic writes for learning records | Yes — write to temp, rename | Yes — crash injection during write, verify no corruption | No | Clear mechanism; needs crash test utility |
| FR56 | Records carry outcome tags updated on story completion | Yes | Yes — inspect YAML file after story completion | No | Clear |
| FR57 | Agents send `learning_report` mail (Loop 1) | Yes | Yes — inspect Overstory mail table for type field | No | Clear |
| FR58 | Transfer manifest includes learnings section (Loop 2) | Yes | Yes — inspect manifest file for field existence | No | Field existence clear; content correctness is not |
| FR59 | Manual synthesis groups, deduplicates, weights by outcome | Partial — grouping/dedup/weighting algorithms undefined | Partial — can verify output files exist; not content correctness | No | **Vague: see deep dive** |
| FR60 | Synthesis rejects iron law conflicts | Yes | Yes — inject conflicting learning, run synthesis, verify rejection log | No | Clear; needs injection test fixture |
| FR61 | Injection matches scope/role, ranks by tier/recency, respects token ceiling | Partial — scope-matching algorithm undefined | Partial — inspect overlay for injected content | No | **Vague: algorithm undefined** |
| FR62 | Spike/exploratory stories suppress injection | Yes | Yes — tag story, verify no learnings in overlay | No | Clear |
| FR63 | Retraction cascades to source records | Yes | Yes — retract synthesized learning, inspect source records | No | Clear |

#### Deep Dive: Learning Injection Correctness (FR61)

**The core question:** How do you verify that learning records are being correctly applied?

"Correctly applied" has three components for which the PRD provides no ACs:

**1. Scope-matching correctness.** FR61 says injection "matches synthesized learnings to agent file scope and role." The matching algorithm is described narratively (file scope + role matching) but not as a specification. If agent A is assigned to `src/payments/webhook.ts` and there are learnings tagged for `src/payments/`, do those learnings inject? What about learnings tagged for `src/`? There is no defined algorithm and therefore no passing criterion.

> **Recommendation:** Define scope matching as a documented lookup algorithm with explicit priority order (example: exact file path match → directory prefix match → module match → no match). The AC becomes: "Given a synthesized learning tagged `src/payments/webhook.ts` and an agent assigned to `src/payments/webhook.ts`, the learning appears in the Stage 4 overlay. Given a learning tagged `src/auth/`, the same agent's overlay does not contain it." Unit-testable once the algorithm is specified.

**2. Tier ranking and truncation correctness.** FR61 states learnings are "ranked by tier and recency." Journey 5 states they are "ranked by confidence × recency × relevance." These are two different ranking formulas. The PRD contains an internal inconsistency on this point, and neither formula has a defined tie-breaker.

> **Recommendation:** Define a single authoritative ranking formula in the FR (not only in the journey narrative). The AC must be: "When the token ceiling forces truncation, the removed item is always from a lower tier or lower recency than any retained item — verifiable by constructing a test overlay with 10 learnings of known tiers and recencies and confirming the truncation boundary is at the correct position."

**3. Behavioral effectiveness.** The PRD's validation plan targets a "15% reduction in token waste for learned scopes vs unlearned scopes within 30 days." This is a post-launch metric, not an AC for any individual FR. There is no AC that verifies injected learnings *influence agent behavior*, only that they are *present in the overlay*.

> **Recommendation:** Add a behavioral proxy AC: "For a test story in a scope with 3+ synthesized critical-tier learnings, the first-attempt post-task hook pass rate must be measurably higher than a baseline story in the same scope with injection suppressed (FR62 escape hatch used as the control condition)." This is testable with two story runs and a controlled comparison.

#### Deep Dive: Synthesis Script Correctness (FR59)

The synthesis script performs "rule-based grouping by file scope, deduplication, outcome weighting, conflict detection." None of these operations have defined correctness criteria:

- What is the deduplication algorithm? (Exact content match? Semantic similarity? What hash function?)
- What are the outcome weights? (Success = 1.0, failed_bmad = 0.5, failed_qa = 0.3, cancelled = 0.0? The weights are never stated.)
- What is the conflict detection algorithm? (Same file scope + contradictory guidance? How is "contradictory" determined by a rule-based script?)

> **Recommendation (blocking):** Before implementing FR59, create a test fixture dataset of 20 raw learning records covering: known-duplicate records, known-conflicting records, records from failed vs successful stories, records with iron law conflicts, and records with no issues. Define the expected synthesis output for each fixture case. The AC for FR59 is: "Synthesis script produces expected output on the 20-record test fixture." This is the only way to know the script is correct before 30 days of production data accumulates. The fixture dataset is itself a prerequisite artifact.

---

### Cluster 7: Meta-Optimization (FR77–FR89)
**Testability Score: 2/5**

This is the second-most problematic cluster. The meta-optimization system operates over 7-day and 2-week time windows, making real-time acceptance testing structurally impossible without a time-acceleration harness.

| FR | Key AC | Specific & Measurable? | Testable by 2 Devs? | External Dependency? | Verdict |
|---|---|---|---|---|---|
| FR77 | Daily cron writes structured daily journal to defined path | Yes | Yes — run cron, inspect YAML file | No | Clear |
| FR78 | Daily cron is observe-only, makes no config changes | Yes | Yes — verify no config files modified after daily cron run | No | Clear |
| FR79 | Weekly cron reads 7 journals and ranks improvement opportunities | Partial — "recurring patterns" is subjective | Partial — can verify output format; not content quality | No | **Vague** |
| FR80 | Weekly cron selects single highest-impact change and implements it | Partial — "highest-impact" is opaque | Partial — can verify exactly one change; not that it is highest-impact | No | **Vague** |
| FR81 | One change per cycle only | Yes | Yes — inspect weekly report file | No | Clear |
| FR82 | Change logged as lifecycle record with complete revert payload | Yes | Yes — inspect `.qds/meta/weekly/` file | No | Clear; verify revert payload contains all changed fields |
| FR83 | Dashboard flag with one-click revert control | Yes | Yes — apply change, verify flag appears in dashboard | No | Clear |
| FR84 | Auto-revert on detected performance degradation using normalized metrics | Partial — "normalized metrics comparing like-for-like" is undefined | **No — requires time acceleration** | **Yes — time window** | **Critical gap: see deep dive** |
| FR85 | Storage in `.qds/meta/daily/` and `.qds/meta/weekly/` | Yes | Yes — filesystem inspection | No | Clear |
| FR86 | Changes cannot violate iron laws or increase budget ceilings | Yes | Yes — construct optimization that would violate a rule, verify rejection | No | Clear; needs adversarial test fixture |
| FR87 | Minimum story threshold before proposing changes | Yes | Yes — set low threshold, run with insufficient stories | No | Clear |
| FR88 | Effectiveness window auto-revert | Partial — 2-week window is real time | **No — requires time acceleration or time-mocking** | **Yes — time window** | **Critical gap: see deep dive** |
| FR89 | Meta-optimization history timeline in dashboard | Yes | Yes — UI observation | No | Clear |

#### Deep Dive: Auto-Revert Testing (FR84 and FR88)

**The core question:** How do you test that auto-revert works correctly?

**FR84** requires auto-revert when "daily journals following a meta-optimization change detect performance degradation using normalized metrics (tokens per file modified, stalls per complexity estimate, BMAD correction rate by scope) comparing like-for-like work."

**FR88** requires auto-revert when "the daily observer does not detect measurable improvement within the effectiveness window (default 2 weeks)."

Both are untestable in real time without either:
1. A time-acceleration mechanism (mock the cron scheduler to run "tomorrow" immediately).
2. A deterministic degradation injection fixture (force the daily observer to detect specific degradation on demand).

Neither is described in the PRD. Neither is trivial to build.

**Additional problem with FR84 — "like-for-like" is undefined.** How does the system determine that Story A is comparable to Story B for normalization purposes? The PRD lists story complexity as estimated from file count and test count, but the normalization formula (how tokens_per_file_modified is computed, what counts as "files with significant changes") is not specified. Without a normalization definition, the auto-revert trigger condition has no testable boundary.

**Additional problem with FR88 — first failure is invisible for 14 days.** The first meta-optimization change could be applied on Day 1 of MVP operation. The first opportunity to verify that auto-revert works is 2 weeks later. If the auto-revert mechanism has a bug, the team discovers it 14 days after the first change is applied. This is a critical quality gap.

> **Recommendation for FR84 (normalization):** Define the normalization formula explicitly: for example, "normalized_tokens_per_file = total_phase_tokens / count(files where line_delta > 10), degradation_threshold = 1.5x pre-change rolling average over last 5 comparable stories." The AC becomes a unit test: "Given a daily journal with normalized_tokens_per_file exceeding 1.5x the pre-change average, and story_count_in_window >= FR87 threshold, the next weekly optimizer produces a revert action."

> **Recommendation for FR84/FR88 (harness — blocking):** Design and build a cron time-injection utility (`qds dev advance-cron <days>`) before the meta-optimization feature is implemented. This utility replays the scheduler at accelerated rate against fixture journal data. The AC for FR88 then becomes: "Using the time-injection utility, advance cron 14 days without any story completions that show measurable improvement; verify that the weekly optimizer run on day 14 produces a revert action and updates the lifecycle record status to `reverted` with `reversion_reason = effectiveness_window_expired`." This harness must be designed before implementation begins — it cannot be retrofitted.

> **Recommendation for FR86 (adversarial fixture):** Create a test fixture weekly journal that would produce a change violating iron laws (e.g., "disable TDD hook for economy-tier agents"). Verify the weekly optimizer rejects it with a specific rejection reason. This is the only way to verify the safety boundary holds.

---

### Cluster 8: Dashboard Copilot (FR105–FR119)
**Testability Score: 3/5**

| FR | Key AC | Specific & Measurable? | Testable by 2 Devs? | External Dependency? | Verdict |
|---|---|---|---|---|---|
| FR105 | Collapsible chat bar present in dashboard | Yes | Yes — UI presence test | No | Clear |
| FR106 | Ask mode returns state without modifying it | Yes | Yes — issue query, verify no state change in any DB | No | Clear |
| FR107 | Investigate mode navigates UI and produces correlated findings | Partial — "correlated findings" is subjective | Partial — navigation is verifiable; correlation quality is not | No | **Quality is model-dependent** |
| FR108 | Act mode executes controls visibly through UI | Yes | Yes — observe UI controls activating | No | Clear |
| FR109 | Act mode requires explicit confirmation for all actions | Yes | Yes — issue Act command, verify confirmation prompt appears | No | Clear |
| FR110 | Copilot does not bypass dashboard control surface | Yes | Yes — network inspection of outbound calls from copilot | No | Clear |
| FR111–FR113 | CopilotKit hooks expose state/actions; AG-UI streaming | Yes | Yes — verify readable state and actionable controls exist in integration | No | Clear |
| FR114 | Multi-step investigations complete within 15s (NFR30) | Yes — NFR30 gives timing bound | Yes — timing measurement | No | Timing verifiable |
| FR115 | Investigation steps visible in chat | Yes | Yes — UI observation | No | Clear |
| FR116 | Session context maintained (referent tracking) | Partial — "referent tracking" depends on model | Partial — infrastructure is verifiable; quality is not | Partial — model behavior | **Scope to infra only** |
| FR117 | Copilot token usage tracked separately in attribution | Yes | Yes — inspect attribution chain | No | Clear |
| FR118 | Economy tier for queries, standard for investigations | Same issue as FR36 | Same as FR36 | Yes — Pi SDK | See Cluster 5 |
| FR119 | Copilot cannot modify factory config or agent overlays | Yes | Yes — verify no writes to config paths after copilot action | No | Clear |

#### Issues and Recommendations

**FR107 — "Correlated findings" has no testable definition.** The FR implies the Copilot can surface related information from multiple data sources in a single response. But there is no minimum standard: a Copilot that navigates to the story panel and says "there is a stalled story" satisfies the literal text without providing correlation value.

> **Recommendation:** Define a concrete Investigate-mode test scenario as the AC: "Given a stalled story S and a synthesized learning record for the same file scope as S, an Investigate-mode query 'Why is Story S stalled?' must surface both the stall classification and the relevant learning record in a single response." This is constructible as a test fixture and evaluable by the two developers.

**FR116 — Referent tracking ("What about Story 2?") is model-dependent.** The copilot maintaining conversational context across turns depends on the underlying AI model's capabilities, which the factory team does not control.

> **Recommendation:** Scope this AC to infrastructure only: "The Copilot's last N exchanges (configurable, default 10) are included in every prompt payload sent to the model." This is verifiable by inspecting the API call payload. The *quality* of referent resolution is a model selection concern, not a system acceptance criterion.

---

### Cluster 9: Resilience & Integrity (FR91–FR104)
**Testability Score: 3/5**

Several FRs in this cluster carry explicit feasibility deferral notes ("MVP if feasible, Growth if not — decision deferred to architecture phase"). These cannot be tested until the architecture decision is made.

| FR | Status | Issue |
|---|---|---|
| FR92 | "MVP if feasible, Growth if not" — runtime file contention detection | No AC can be written until feasibility is resolved; default MVP behavior on deferral is undefined |
| FR98 | "MVP if feasible, Growth if not" — learning record retention window | Same issue |
| FR100 | "MVP if feasible, Growth if not" — cumulative drift threshold; "significant drift" has no numeric definition | Both the feasibility and the threshold are undefined |

> **Recommendation (blocking):** Resolve all three "MVP if feasible" deferral points before story breakdown begins. For each: either commit to an MVP implementation with a specific AC, or formally defer to Growth and remove the language. The current text leaves the story boundary ambiguous at sprint planning. For FR100 specifically: define the default drift threshold (e.g., "sum of absolute parameter deltas exceeds 20% from factory.yaml baseline") so the alert-trigger condition is testable.

**FR96 — Strong, testable AC; high implementation value.** "API calls without a complete attribution chain are blocked, not silently executed." The recommended test: construct a direct model API call path that bypasses attribution chain population, verify it is rejected with a specific error. This test belongs in the integration test suite and should be automated.

**FR86/FR100 adversarial tests:** Both FRs require constructing a scenario that would trigger the system's safety boundary. These are the most valuable tests to write early — they verify the safety net before production data accumulates.

---

### Cluster 10: Non-Functional Requirements (NFR1–NFR40)
**Testability Score: 4/5**

The NFRs are notably well-specified compared to industry average — most include a measurement method (timestamp delta, browser Performance Monitor, SQLite query timing). The following are flagged:

| NFR | Issue | Recommendation |
|---|---|---|
| NFR5 | "Up to 12 active xterm.js panels on 16GB RAM machine" — requires manufacturing 12 concurrent live agents | Clarify whether this is a load test (synthetic agent processes) or a real workload test; define a synthetic agent stub for load testing |
| NFR15 | "Zero data loss" is defined narratively but not as a machine-checkable invariant | Define as: SQLite dump comparison pre-crash vs post-resume for all completed phase rows; schema validation of all learning record files |
| NFR22 | "Quality pipeline cost ≤5% of total story cost" requires a minimum sample | Specify minimum sample: "verified across ≥10 MVP stories with a standard agent team" |
| NFR26 | "All factory logs must be structured JSON/YAML with consistent fields" | Add automated log schema validation to CI pipeline as a structural regression test; this is low-effort and catches log format drift immediately |
| NFR35 | "Action score computation within 200ms of post-task hook" | Define the start timestamp precisely: "timestamp of hook result availability in Overstory event stream" |

---

## ACs That Require Test Harness Design Before Implementation

The following ACs cannot be written or passed without purpose-built test infrastructure. These harnesses must be designed before or in parallel with the corresponding implementation work.

| Required Harness | Blocks | Complexity | When Needed |
|---|---|---|---|
| Canary injection fixture (FR10) | Context isolation guarantee, adversarial review validity | Medium: inject unique string into dev context, verify absence in BMAD context | Before first story runs through factory |
| Process crash injection utility — `qds dev crash-agent` (FR22, FR24, NFR14–NFR16) | Recovery timing, data integrity, learning atomicity | Low: `kill -9` wrapper with timestamp recording | Before orchestration acceptance testing |
| Cron time-acceleration utility — `qds dev advance-cron <days>` (FR84, FR88) | Meta-optimization auto-revert, effectiveness window | High: mock scheduler, replay journal data, verify state transitions | Before meta-optimization implementation begins |
| Synthesis script test fixture — 20 sample records with expected output (FR59) | Factory learning correctness | Medium: author fixture records and expected synthesis output | Before FR59 implementation begins |
| Pi SDK model-identifier extension to attribution chain (FR36, FR13, FR118) | Economy-tier routing verification | Medium: requires Pi SDK to expose model used per call | Before first QA swarm story runs |
| Phase Boundary Protocol manifest JSON Schema (FR18, FR32) | Phase boundary hook validation, context transfer verification | Low: define schema, write validator, add to hook pipeline | Before Phase Boundary Protocol implementation begins |
| Attribution chain completeness scanner (FR42, FR96, NFR10) | Security, cost tracking accuracy | Low: automated scan of all output paths for attribution fields | Add to CI pipeline before MVP launch |
| Iron law violation fixture for meta-optimization (FR86) | Meta-optimization safety boundary | Low: construct a weekly journal that would produce a rule-violating change | Before FR86 acceptance testing |

---

## ACs That Are Too Vague to Pass/Fail Objectively

| FR | Vague Language | Required Specification |
|---|---|---|
| FR2 | "automatic dependency detection" | Define dependency signal (file overlap, `depends_on` field, shared module import) and minimum detection rate |
| FR32 | "required sections" of transfer manifest | Publish manifest schema with field names, types, and required/optional designation |
| FR59 | "correctly groups," "deduplicates," "weighs by story outcome" | Define grouping key, deduplication algorithm, and numeric outcome weight values |
| FR61 | "matches synthesized learnings to agent file scope and role" | Define scope-matching algorithm with explicit priority order |
| FR79 | "recurring patterns," "distinguish signal from noise" | Define pattern recurrence threshold (e.g., "flagged in ≥3 of 7 daily journals") |
| FR80 | "single highest-impact improvement opportunity" | Define impact estimation algorithm or scoring criteria used by the weekly optimizer |
| FR84 | "normalized metrics comparing like-for-like work" | Define normalization formula and similarity criteria for "like-for-like" classification |
| FR88 | "measurable improvement within the effectiveness window" | Define what constitutes measurable improvement (metric, threshold, sample size) |
| FR107 | "correlated findings from multiple data sources" | Define minimum correlation test scenario as a concrete fixture |
| FR100 | "total drift exceeds a configurable threshold" | Define default threshold value and drift measurement formula |

---

## Recommendations by Priority

### Must-Do Before Story Breakdown Begins

1. **Define the Phase Boundary Protocol manifest schema** as a typed document with required/optional fields. This unblocks FR18, FR32, FR58, the manifest validator hook, and all context isolation ACs.

2. **Design the canary injection test fixture for FR10.** Context isolation is the core adversarial review guarantee. Without a falsifiable test, the guarantee is untestable from day one.

3. **Design the cron time-acceleration utility for FR84/FR88.** Meta-optimization auto-revert cannot be acceptance-tested in real time. This harness must exist before the meta-optimization feature is implemented.

4. **Resolve the three "MVP if feasible" deferral points** (FR92, FR98, FR100). Convert to committed MVP ACs with numeric thresholds, or formally defer to Growth.

5. **Create the synthesis script test fixture** (20 raw learning records with expected output) and define the deduplication algorithm, outcome weights, and conflict detection criteria before implementing FR59.

### Should-Do During Story Design

6. **Add model identifier to attribution chain** (FR42 extension) to make FR36/FR13/FR118 economy-tier routing verifiable without Pi SDK internals.

7. **Define the scope-matching algorithm** for FR61 learning injection. Write as a unit-test spec before implementation.

8. **Define a PR evidence schema** as a companion document to FR8/FR52. Add PR body schema validation as an automated acceptance step.

9. **Add `qds dev crash-agent` utility** to the implementation plan for FR22/FR24 recovery testing.

10. **Define NFR22 minimum sample size** (≥10 stories to verify 5% quality pipeline cost ceiling).

### Nice-to-Have (Can Defer to Integration Testing Phase)

11. Formalize NFR15 crash-recovery invariant as a machine-checkable post-resume diff (SQLite state comparison).

12. Add automated log schema validation (NFR26) to CI pipeline as a structural regression test.

13. Define the Copilot Investigate-mode test scenario (FR107) with a concrete fixture to avoid purely subjective evaluation.

14. Define the FR149 velocity extension boundary conditions (at what exactly does progress velocity trigger a max_turns extension?) as explicit test cases.

---

## Summary Table: Testability Scores and Key Gaps

| Cluster | FRs | Score | Top Gap | Harness Needed? |
|---|---|---|---|---|
| Pipeline Execution | FR1–FR9 | 4/5 | FR2 dependency detection undefined | No |
| Quality Enforcement | FR10–FR20 | 4/5 | FR10 context isolation needs canary harness | Yes (medium) |
| Agent Orchestration | FR21–FR27 | 4/5 | FR22/FR24 require crash injection utility | Yes (low) |
| Overlay & Context Mgmt | FR28–FR35 | 3/5 | FR32 manifest schema undefined; content fidelity has no AC | Schema document |
| Resource & Economic | FR36–FR42 | 4/5 | FR36 tier routing requires Pi SDK model-identifier introspection | Yes (medium) |
| Dashboard | FR43–FR50 | 4/5 | FR47 stall classification accuracy is subjective | No |
| Git & PR | FR51–FR54, FR90 | 5/5 | None | No |
| Factory Learning | FR55–FR63 | 2/5 | FR59/FR61 correctness criteria undefined; no behavioral effectiveness AC | Yes (synthesis fixture) |
| Memory & Knowledge | FR64–FR68 | 4/5 | None significant | No |
| Developer Operations | FR69–FR72 | 5/5 | None | No |
| Operational Safety | FR73–FR76 | 3/5 | FR75 provider-down auto-resume needs deliberate injection | Low-complexity tool |
| Meta-Optimization | FR77–FR89 | 2/5 | FR84/FR88 auto-revert requires time acceleration; "like-for-like" undefined | Yes (high — cron harness) |
| Resilience & Integrity | FR91–FR104 | 3/5 | Three feasibility deferrals unresolved; FR100 drift threshold undefined | No (after deferrals resolved) |
| Dashboard Copilot | FR105–FR119 | 3/5 | FR107 correlation quality is model-dependent; FR116 referent tracking is model-dependent | No |
| Developer Communication | FR120–FR129 | 4/5 | FR128 NL classification accuracy has no minimum-bar AC | No |
| Agent Performance Data | FR130–FR132, FR140 | 4/5 | Brier score resolution requirement is well-specified and verifiable | No |
| Economic Governance | FR142, FR145 | 5/5 | None | No |
| Orchestration | FR149 | 4/5 | Velocity extension boundary conditions need explicit test cases | No |
| Quality Verification | FR152, FR155, FR163 | 4/5 | FR152 oscillation detection logic under-specified | No |
| Self-Learning System | FR164–FR168, FR170–FR171 | 3/5 | FR165 pattern confidence thresholds need defined baseline; FR168 burden trending needs defined success metric | No |

---

*Review completed: 2026-03-14. Intended for use during epic breakdown and story design sessions. The 8 test harnesses identified in the "ACs That Require Test Harness Design" section should each be planned as prerequisite stories or technical tasks before their dependent implementation stories begin.*
