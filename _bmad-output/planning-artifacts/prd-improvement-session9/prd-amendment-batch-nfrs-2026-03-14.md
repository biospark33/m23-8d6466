# PRD Amendment Batch: NFR Cluster
## Source Document: prd-v2.md (v2.0, 2026-03-10)
**Date:** 2026-03-14
**Basis:** NFR Conflict & Feasibility Analysis (2026-03-14) + Acceptance Criteria Review (2026-03-14)
**Scope:** NFR1–NFR40; targeted amendments only — all other NFRs unchanged

---

## AMENDMENT: NFR5 — Panel Count / Agent Count Inconsistency + Synthetic Load Test Clarification

**Type:** MODIFY_NFR
**Target:** NFR5
**Reason:** NFR5's 12-panel ceiling is inconsistent with NFR17's 15-agent ceiling — the dashboard renders one panel per agent, so the real peak is 15 panels, not 12 — and the acceptance criteria review found the test scenario must clarify whether verification requires real agents or a synthetic load stub.

**Original text:**
> Dashboard must maintain 30fps minimum render rate with up to 12 active xterm.js agent panels on a machine with 16GB RAM, as measured by browser Performance Monitor

**Replacement text:**
> Dashboard must maintain 30fps minimum render rate with up to 15 active xterm.js agent panels on a machine with 16GB RAM, as measured by browser Performance Monitor capturing frame timing across a 30-second window. The 30fps guarantee applies to all panel counts up to 15 (matching the maximum concurrency defined by NFR17). For panel counts 13–15, the implementation must use xterm.js viewport virtualization and throttled DOM flush (≤30 DOM updates per second per terminal) to stay within the browser render-thread budget; this rendering strategy is the accepted mitigation for C2 (SQLite WAL pressure vs. dashboard render). Verification must use a synthetic agent stub (`qds dev synthetic-agent`) that drives xterm.js output at a realistic rate (200–500 bytes/second per terminal) — real concurrent agents are not required to pass this test. The synthetic stub requirement exists because real 15-agent factory runs are not reproducibly achievable in a unit/integration CI environment.

---

## AMENDMENT: NFR3 — CPU Over-Subscription Risk and Parallelization Requirement

**Type:** MODIFY_NFR
**Target:** NFR3
**Reason:** The conflict analysis found that CPU over-subscription (not memory) is the real risk at phase boundaries: when multiple stories reach a gate simultaneously on 4 cores, test suite and build check durations multiply 3–5x, routinely violating the 60-second ceiling unless checks are parallelized and the ceiling is scoped to the common case.

**Original text:**
> Phase boundary gate checklist (all 6 checks: tests, build, lint, type check, uncommitted changes, manifest validation) must complete within 60 seconds total as measured by gate runner aggregate timing

**Replacement text:**
> Phase boundary gate checklist (all 6 checks: tests, build, lint, type check, uncommitted changes, manifest validation) must complete within 60 seconds total as measured by gate runner aggregate timing. This ceiling applies to the common case: a project with a test suite completing in under 30 seconds on uncontested hardware. For projects with longer test suites, the ceiling scales to `(project_test_suite_duration + 30s)`.
>
> **Implementation requirement:** The gate runner must execute independent checks in parallel. Tests and lint are independent; type check and build are independent of lint; uncommitted-changes and manifest-validation checks are I/O-only and must run concurrently with all other checks. Parallelizing independent checks is mandatory — a sequential gate runner cannot satisfy the 60-second ceiling on 4 cores under concurrent story load.
>
> **CPU over-subscription note:** Phase boundary storms (multiple stories reaching gates simultaneously) cause CPU over-subscription on the 4-core hardware target. Individual check durations can multiply 3–5x under contention. The gate runner must enforce per-check timeouts to prevent stalls: test suite ≤45s, build ≤20s, lint ≤10s, type check ≤15s, uncommitted-changes ≤5s, manifest-validation ≤5s. If a check exceeds its individual timeout, the gate fails immediately with a "check timeout" status rather than waiting for the 60-second aggregate ceiling. If hardware cannot support parallelized gate execution, NFR25's hardware recommendation must be updated (see NFR25 amendment).

---

## AMENDMENT: NFR25 — CPU Core Count as Primary Constraint + 8GB Degradation Profile

**Type:** MODIFY_NFR
**Target:** NFR25
**Reason:** The conflict analysis found that CPU over-subscription at phase boundary storms is the critical hardware constraint on the 4-core target — not memory — and the 8GB graceful degradation profile is undefined, which will produce inconsistent implementation choices.

**Original text:**
> Factory must be runnable on a developer machine with 16GB RAM, 4 CPU cores, and 20GB free disk — with graceful degradation (reduced concurrency) on machines with 8GB RAM

**Replacement text:**
> Factory must be runnable on a developer machine with 16GB RAM, 4 CPU cores, and 20GB free disk — with graceful degradation (reduced concurrency) on machines with 8GB RAM.
>
> **CPU is the primary constraint.** At the maximum concurrency defined by NFR17 (15 agents), phase boundary gates can produce simultaneous CPU-bound child processes (test runners, TypeScript compilation, ESLint). On 4 cores, this represents severe over-subscription: effective per-agent CPU share falls to ~0.27 cores during gate storms. The 4-core minimum is therefore a harder constraint than RAM for sustained operation; developers on 2-core machines should be warned at startup that phase gate timing guarantees (NFR3) are not achievable.
>
> **8GB RAM degradation profile (explicit contract):**
> - Maximum concurrent active stories: 2 (reduced from default)
> - Dashboard xterm.js panels: limited to 8 active panels; additional agents shown as status-only (no live terminal output)
> - Learning synthesis (FR59) deferred to after-session batch rather than after-story
> - Epic context pre-computation (NFR39) disabled; cold-start computation used instead
> - Developer is informed of degraded mode via a persistent dashboard banner on startup: "Running in 8GB degraded mode: max 2 concurrent stories, terminal panels limited to 8"
> - Degraded mode is triggered automatically when free RAM at factory startup is below 10GB; threshold is configurable in `factory.yaml`

---

## AMENDMENT: NFR22 — Cost Floor, Minimum Sample Size, and Pricing Assumption Documentation

**Type:** MODIFY_NFR
**Target:** NFR22
**Reason:** The conflict analysis found that a 5% ceiling without a minimum floor creates impossible constraints for small Task work types (5% of $0.10 = $0.005, below any LLM call), the acceptance criteria review requires a minimum sample size for verification, and the GLM-5 pricing assumption underlying the cost target must be documented so the threshold can be recalibrated if pricing changes.

**Original text:**
> Quality pipeline cost (BMAD review + QA swarm phases combined) must not exceed 5% of total story cost as measured by attribution chain cost aggregation per phase

**Replacement text:**
> Quality pipeline cost (BMAD review + QA swarm phases combined) must not exceed 5% of development-phase cost per story, OR $0.05 per story, whichever is greater — as measured by attribution chain cost aggregation per phase in `attribution.db`.
>
> **Minimum floor rationale:** For Task work types with short development phases (estimated cost < $1.00), the 5% ceiling would require BMAD + QA to cost under $0.05, which is below the minimum cost of a single economy-tier LLM call. The `max(5% of dev cost, $0.05)` formula prevents the NFR from being violated by design on small stories.
>
> **Verification sample requirement:** This NFR is considered verified when the 5%-or-floor ceiling holds across ≥10 MVP stories using a standard agent team configuration, covering at least one story of each work type (Task, Feature, Bug) in the sample.
>
> **Pricing assumption:** The 5% ceiling is calibrated against GLM-5 economy-tier pricing as of 2026-03-14. If the economy-tier model pricing changes by more than 3× (in either direction), this NFR must be recalibrated. The break-even point at which BMAD + QA phases exceed 5% of dev cost is highly sensitive to pricing: a 3× pricing increase on the economy tier would breach this NFR for all but the most expensive Feature stories without implementation changes.
>
> **Fallback behavior:** When economy-tier models are unavailable and Pi SDK falls back to standard-tier, the cost ceiling is automatically suspended for that story and a warning is logged. Standard-tier fallback cost is tracked separately in `attribution.db` under `fallback_tier_cost` for capacity planning.

---

## AMENDMENT: NFR15 — Machine-Checkable Crash Recovery Invariant

**Type:** MODIFY_NFR
**Target:** NFR15
**Reason:** The acceptance criteria review found that "zero data loss" is defined narratively but not as a machine-checkable invariant, making the AC unverifiable in automated testing; a precise post-resume diff specification is needed.

**Original text:**
> After factory process restart, all in-progress stories must resume from last checkpoint with zero data loss — no completed phases re-executed, no learning records lost, no duplicate commits — as verified by crash-and-resume integration testing

**Replacement text:**
> After factory process restart, all in-progress stories must resume from last checkpoint with zero data loss — no completed phases re-executed, no learning records lost, no duplicate commits — as verified by crash-and-resume integration testing.
>
> **Machine-checkable invariant:** The crash-and-resume integration test must assert all of the following post-resume conditions:
> 1. A full SQLite dump of all `completed_phases` rows in Overstory's database after resume must be byte-for-byte identical to the pre-crash dump of the same rows. No rows may be added, removed, or modified for phases that were complete at the time of the crash.
> 2. All learning record files present in `.qds/learning/` before the crash must still be present after resume, with identical content (verified by SHA-256 hash comparison). No learning records written before the crash may be absent or modified after resume.
> 3. All learning record files present after resume must pass the learning record schema validation (same validator used in NFR40's extraction pipeline). No partially-written records may survive a crash.
> 4. The git commit log must contain no duplicate commits for any story that was in progress at the time of the crash.
>
> These four assertions must be automated and must run as part of the factory's integration test suite via the `qds dev crash-agent` utility.

---

## AMENDMENT: NFR26 — Automated Log Schema Validation in CI

**Type:** MODIFY_NFR
**Target:** NFR26
**Reason:** The acceptance criteria review identified that log format drift is a silent regression risk and recommended adding automated log schema validation to the CI pipeline as a low-effort structural regression test.

**Original text:**
> All factory logs must be structured (JSON or YAML) with consistent fields: timestamp, source (agent_id / component), severity (debug / info / warn / error), and message — enabling grep-based debugging without specialized tooling

**Replacement text:**
> All factory logs must be structured (JSON or YAML) with consistent fields: timestamp, source (agent_id / component), severity (debug / info / warn / error), and message — enabling grep-based debugging without specialized tooling.
>
> **CI enforcement requirement:** Automated log schema validation must be included in the CI pipeline as a structural regression test. The validator must:
> 1. Capture log output from a factory smoke-test run (factory startup, one story completion, factory shutdown).
> 2. Assert that every emitted log line parses as valid JSON (or YAML, per component configuration) and contains all four required fields (`timestamp`, `source`, `severity`, `message`) with correct types.
> 3. Assert that `severity` values are restricted to the four defined levels: `debug`, `info`, `warn`, `error`.
> 4. Assert that `timestamp` values are valid ISO-8601 strings.
> 5. Fail the CI build if any log line fails schema validation.
>
> This test must run on every commit that touches any component that emits logs. Its purpose is to catch log format drift immediately, before it reaches integration testing.

---

## AMENDMENT: NFR35 — Precise Start Timestamp Definition

**Type:** MODIFY_NFR
**Target:** NFR35
**Reason:** The acceptance criteria review found that "post-task hook completion" is ambiguous as a start timestamp — it must be defined as the specific event in the Overstory event stream to make the 200ms measurement reproducible.

**Original text:**
> Action-level process score computation (FR130) must complete within 200ms of post-task hook completion, as measured by timestamp delta between hook result availability and `pipeline.db` action_scores row insert. Performance scoring must not become a pipeline bottleneck. *Change from original:* Storage target changed from `.qds/performance/actions/` YAML file write to `pipeline.db` row insert, per CONS-002 resolution.

**Replacement text:**
> Action-level process score computation (FR130) must complete within 200ms of post-task hook completion, as measured by timestamp delta between hook result availability and `pipeline.db` action_scores row insert. Performance scoring must not become a pipeline bottleneck. *Change from original:* Storage target changed from `.qds/performance/actions/` YAML file write to `pipeline.db` row insert, per CONS-002 resolution.
>
> **Start timestamp definition (machine-checkable):** The 200ms window starts at the timestamp of hook result availability in the Overstory event stream — specifically, the `created_at` timestamp of the `hook_result` event emitted by Overstory when the post-task hook process exits and its result is written to the Overstory SQLite `events` table. This timestamp is the authoritative start point for measuring action score computation latency. The measurement is: `action_scores.created_at` − `overstory_events.created_at` where `overstory_events.event_type = 'hook_result'` and `overstory_events.hook_type = 'post_task'` for the same agent and task. All timing instrumentation must use this definition.

---

## AMENDMENT: NFR8 — Copilot Ask-Mode Latency Scope Clarification

**Type:** MODIFY_NFR
**Target:** NFR8
**Reason:** The conflict analysis flagged NFR8 for re-evaluation because the 3-second first-token latency depends on network and model provider latency that is outside developer machine control, and the NFR as written will produce test failures caused by external factors rather than implementation defects.

**Original text:**
> Copilot response latency for Ask-mode queries must be under 3 seconds from message send to first response token as measured by chat component timing instrumentation

**Replacement text:**
> Copilot response latency for Ask-mode queries must be under 3 seconds from message send to first response token as measured by chat component timing instrumentation, under normal network conditions.
>
> **Scope clarification:** The 3-second target is an end-to-end wall-clock measurement and includes model provider network round-trip time. Because model provider latency is outside factory control, this NFR is a user-experience target, not an implementation correctness guarantee. The factory's obligation is: (a) add no more than 200ms of local processing overhead between user message send and Pi SDK request dispatch, and (b) begin streaming the first token to the chat bar UI within 100ms of receiving the first token from Pi SDK.
>
> **Verification method:** The 3-second end-to-end target is verified by acceptance testing against the configured provider under normal load — not by unit or CI tests, which must use mock Pi SDK responses. The local overhead targets (200ms dispatch, 100ms first-render) are the CI-verifiable acceptance criteria for this NFR.
>
> **Render thread protection:** Copilot Ask-mode streaming must use a dedicated `requestAnimationFrame` queue for SSE token delivery to the chat bar, preventing LLM stream chunks from preempting xterm.js terminal renders in the browser event loop. This is the accepted mitigation for conflict C10.

---

## AMENDMENT: NFR17 — Agent Concurrency Definition Clarification

**Type:** MODIFY_NFR
**Target:** NFR17
**Reason:** The conflict analysis flagged NFR17 for re-evaluation because "15 concurrent agents" is ambiguous — it could mean 15 simultaneous OS processes or 15 simultaneous SQLite connections — and these are architecturally different resource models requiring different capacity planning.

**Original text:**
> Overstory SQLite must handle concurrent read/write from up to 15 agents without data loss, silent write failures, or corruption — as verifiable by concurrent stress testing with write contention scenarios

**Replacement text:**
> Overstory SQLite must handle concurrent read/write from up to 15 agents without data loss, silent write failures, or corruption — as verifiable by concurrent stress testing with write contention scenarios.
>
> **Concurrency definition:** "15 concurrent agents" means 15 simultaneously active agent state machines in the Overstory process, each with a live logical SQLite connection context. This does not mean 15 independent OS processes each holding an open SQLite file descriptor; the Overstory Rust process is the single SQLite writer, with agents communicating via the Overstory API. The 15-agent ceiling is a logical concurrency limit on the Overstory state machine, not a process-count limit.
>
> **WAL configuration requirement:** Overstory's SQLite instance must be configured with `PRAGMA wal_autocheckpoint = 2000` (checkpoint after 2,000 WAL pages, ~8MB) to reduce checkpoint frequency and shift checkpoint work to lower-activity periods. The default SQLite WAL autocheckpoint threshold of 1,000 pages can trigger 100–500ms write stalls under 15-agent write load, threatening NFR18's 1-second mail delivery guarantee and NFR1's 2-second SSE latency.
>
> **Relationship to NFR5:** At 15 concurrent agents, the dashboard will display up to 15 xterm.js panels. NFR5 now defines the 30fps guarantee for up to 15 panels (amended above). The two NFRs are explicitly reconciled: the concurrency ceiling (NFR17: 15 agents) and the render guarantee (NFR5: 30fps at up to 15 panels) are consistent.

---

## AMENDMENT: NFR31 — Copilot/Dashboard Render Dependency Clarification

**Type:** MODIFY_NFR
**Target:** NFR31
**Reason:** The conflict analysis flagged NFR31 for re-evaluation because it is an absolute dependency on NFR5, but NFR5 was itself under-specified; now that NFR5 is amended, NFR31's dependency must be restated with a delta specification to make it independently testable.

**Original text:**
> Copilot chat bar must not impact dashboard render performance — dashboard must maintain NFR5's 30fps requirement with the chat bar open and actively streaming responses

**Replacement text:**
> Copilot chat bar must not impact dashboard render performance — dashboard must maintain NFR5's 30fps requirement with the chat bar open and actively streaming responses.
>
> **Independent test specification:** NFR31 is satisfied when: (a) with chat bar closed, dashboard renders at ≥30fps (NFR5 baseline); and (b) with chat bar open and actively streaming an LLM response at typical token rate (20–50 tokens/second), dashboard render rate does not drop by more than 2fps from the NFR5 baseline measured in the same session. This delta specification (`baseline − 2fps`) makes NFR31 testable independently of absolute frame rate, and decouples it from NFR5 for cases where the baseline is above 30fps (e.g., 40fps baseline → 38fps with Copilot streaming is passing; 30fps baseline → 28fps is failing).
>
> **Implementation requirement:** Copilot streaming token delivery to the chat bar must be handled via a dedicated `requestAnimationFrame` queue and must not trigger synchronous React state updates during terminal renders. This is the shared mitigation for conflicts C1 and C10.

---

## AMENDMENT: NFR37 — Latency Percentile Target and Cache Fallback Behavior

**Type:** MODIFY_NFR
**Target:** NFR37
**Reason:** The conflict analysis flagged NFR37 for re-evaluation because the 50ms target is not specified as a percentile — SQLite WAL-mode reads are typically sub-millisecond at p50 but can spike to 100–500ms at p99 during checkpoints — making the NFR unverifiable without a percentile definition.

**Original text:**
> Learning record queries against `pipeline.db` (pattern knowledge lookup, maintenance learning retrieval, overlay enrichment assembly) must complete within 50ms as measured by SQLite query timing instrumentation. This ensures overlay composition (which now pulls learning data) stays within the existing NFR4 500ms budget. *New NFR.* Overlay enrichment (FR167) adds database queries to the overlay composition pipeline; these queries must not blow the existing latency budget.

**Replacement text:**
> Learning record queries against `pipeline.db` (pattern knowledge lookup, maintenance learning retrieval, overlay enrichment assembly) must complete within 50ms at p95 as measured by SQLite query timing instrumentation. This ensures overlay composition (which now pulls learning data) stays within the existing NFR4 500ms budget. *New NFR.* Overlay enrichment (FR167) adds database queries to the overlay composition pipeline; these queries must not blow the existing latency budget.
>
> **Percentile target:** The 50ms ceiling is a p95 target. SQLite WAL-mode reads will occasionally spike above 50ms during WAL checkpoint operations (p99 can reach 100–500ms under 15-agent write load). p99 spikes are accepted provided they do not occur more than once per 100 queries. If a learning query exceeds 200ms at any percentile, it is classified as a latency anomaly and logged at `warn` severity.
>
> **Cache fallback behavior:** If a learning query exceeds 50ms (p95 budget), the overlay composition pipeline must fall back to the most recently cached overlay enrichment result (stale-while-revalidate pattern) rather than blocking the NFR4 500ms overlay composition deadline. The stale result must be no older than the previous story's completion timestamp. A stale-result fallback event must be logged at `info` severity with the query latency that triggered the fallback.

---

## AMENDMENT: NFR39 — Cold-Start Exception and Pre-Computation Clarification

**Type:** MODIFY_NFR
**Target:** NFR39
**Reason:** The conflict analysis flagged NFR39 for re-evaluation because the 500ms ceiling applies only when the pre-computed cache is warm — cold-start assembly (first story of an epic or post-crash recovery) cannot meet 500ms and requires an explicit exception to avoid an unachievable requirement.

**Original text:**
> Epic context assembly (FR166) must complete within 500ms for epics containing up to 20 stories, as measured by the time from epic context query initiation to assembled context availability. Epic context is pre-computed after each story completion and cached in `pipeline.db`, not computed on-demand during overlay assembly.

**Replacement text:**
> Epic context assembly (FR166) must complete within 500ms for epics containing up to 20 stories when the pre-computed epic context cache is warm (populated by at least one prior story completion in the same epic), as measured by the time from epic context query initiation to assembled context availability. Epic context is pre-computed after each story completion and cached in `pipeline.db`, not computed on-demand during overlay assembly.
>
> **Cold-start exception:** On cold start (first story of an epic, or after a factory crash that clears the cache), epic context assembly may take up to 3 seconds. This is expected and acceptable; the 3-second cold-start allowance must be communicated to the developer via a dashboard status update ("Assembling epic context — first story, allow up to 3s"). Cold-start assembly must still complete within 3 seconds even on the 8GB degraded hardware profile.
>
> **Cache warming requirement:** After each story completion, the factory must asynchronously pre-compute and cache the updated epic context for the next story in the same epic. This pre-computation must complete within 10 seconds of story completion confirmation and must not block the story completion pipeline.

---

*Amendment batch generated 2026-03-14. All amendments are based on findings in the NFR Conflict & Feasibility Analysis (2026-03-14) and the Acceptance Criteria Review (2026-03-14). Amendments are production-ready replacement text for direct integration into prd-v2.md. No other NFRs (NFR1–NFR4, NFR6–NFR7, NFR9–NFR14, NFR16, NFR18–NFR21, NFR23–NFR24, NFR27–NFR30, NFR32–NFR34, NFR36, NFR38, NFR40) are changed by this batch.*
