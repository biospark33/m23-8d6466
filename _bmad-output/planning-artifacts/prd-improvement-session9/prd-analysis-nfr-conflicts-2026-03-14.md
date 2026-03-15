# NFR Conflict & Feasibility Analysis
## QDS Engineer v2 — PRD v2.0
**Date:** 2026-03-14
**Source Document:** `_bmad-output/planning-artifacts/prd-v2.md`
**Analyst:** Claude Sonnet 4.6 (automated analysis)
**Hardware Target:** 16GB RAM, 4 CPU cores, macOS/Linux

---

## 1. All 40 NFRs: Summary Table with Key Constraints

| ID | Category | Requirement Summary | Key Constraint | Phase |
|----|----------|---------------------|----------------|-------|
| NFR1 | Performance | SSE event latency: Overstory state → dashboard render | < 2 seconds | MVP |
| NFR2 | Performance | Hook execution (post-edit, post-task) per invocation | < 2 seconds | MVP |
| NFR3 | Performance | Phase boundary gate checklist (6 checks combined) | < 60 seconds total | MVP |
| NFR4 | Performance | Overlay composition pipeline (all 6 stages) | < 500ms; overlay files cached in memory | MVP |
| NFR5 | Performance | Dashboard render rate with 12 active xterm.js panels on 16GB RAM | >= 30fps | MVP |
| NFR6 | Performance | Daily meta-optimization cron: analysis + journal write | < 10 minutes; < $0.50 API cost | MVP |
| NFR7 | Performance | Weekly meta-optimization cron: analysis + change implementation | < 30 minutes; < $2.00 API cost | MVP |
| NFR8 | Performance | Copilot Ask-mode response first token latency | < 3 seconds | MVP |
| NFR9 | Security | API credentials never readable by agent processes | Pi SDK mediates all model access | MVP |
| NFR10 | Security | No credentials in any factory output path | Automated credential scanning on all outputs | MVP |
| NFR11 | Security | Agent filesystem access restricted to assigned worktree | Process-level enforcement; access denied (not warning) | MVP |
| NFR12 | Security | `factory.yaml` excluded from version control | Setup script verifies on every startup; halts if tracked | MVP |
| NFR13 | Security | Factory branch operations restricted to `qds/` namespace | Blocked at Factory Core before git command executes | MVP |
| NFR14 | Reliability | Coordinator detects agent crash and spawns replacement | Detect within 10s; replace within 30s | MVP |
| NFR15 | Reliability | After factory restart, all in-progress stories resume from checkpoint | Zero data loss; no completed phases re-executed; no duplicate commits | MVP |
| NFR16 | Reliability | Learning record writes must be atomic | Crash during write must not produce corrupted file | MVP |
| NFR17 | Reliability | Overstory SQLite concurrent access | Up to 15 concurrent agents; no data loss, corruption, or silent failures | MVP |
| NFR18 | Reliability | Overstory mail: exactly-once delivery | Message readable within 1 second; zero lost or duplicate | MVP |
| NFR19 | Reliability | Dashboard state recovery after SSE drop or restart | Full state restored within 5 seconds; zero state loss | MVP |
| NFR20 | Reliability | Meta-optimization revert restores exact previous config | No partial reverts; no orphaned config fragments | MVP |
| NFR21 | Reliability | Worktree cleanup for all story termination paths | No orphaned worktrees after 24 hours | MVP |
| NFR22 | Reliability | Quality pipeline cost (BMAD + QA combined) | <= 5% of total story cost | MVP |
| NFR23 | Operability | Setup script on clean machine with prerequisites | < 5 minutes; clear progress and error messages | MVP |
| NFR24 | Operability | Platform support | macOS (primary) and Linux; no Windows-only dependencies | MVP |
| NFR25 | Operability | Hardware floor | Runs on 16GB RAM, 4 cores, 20GB free disk; graceful degradation at 8GB | MVP |
| NFR26 | Operability | Structured logging | JSON or YAML with consistent fields; grep-debuggable | MVP |
| NFR27 | Operability | Factory startup time | < 30 seconds (Overstory + Pi + dashboard serving) | MVP |
| NFR28 | Operability | Config hot-reload | Operational config takes effect on next story start; structural config requires restart | MVP |
| NFR29 | Operability | Slow disk I/O detection | Warn developer when write latency exceeds 100ms average over 60 seconds | MVP |
| NFR30 | Operability | Copilot Investigate-mode multi-step investigation | < 15 seconds across up to 3 data sources | MVP |
| NFR31 | Operability | Copilot chat bar must not degrade dashboard render performance | Dashboard must maintain NFR5's 30fps with chat bar open and streaming | MVP |
| NFR32 | Operability (Messenger) | Telegram notification delivery latency | < 5 seconds from EventStore write to Telegram push receipt | MVP |
| NFR33 | Operability (Messenger) | No credentials or system details in Telegram messages | Automated scanning on all formatted messages | MVP |
| NFR34 | Operability (Messenger) | Messenger NL processing daily cost ceiling | Configurable; default $1.00; NL classification disabled at ceiling | MVP |
| NFR35 | Operability (Performance System) | Action-level process score computation latency | < 200ms after post-task hook completion | MVP |
| NFR36 | Operability (Performance System) | `pipeline.db` storage growth | < 100MB per 1,000 stories; 90-day default retention with archive | MVP |
| NFR37 | Operability (Performance System) | Learning record queries against `pipeline.db` | < 50ms; must stay within NFR4's 500ms overlay budget | MVP |
| NFR38 | Operability (Performance System) | All QDS v2 code follows QDS conventions | ESM modules, TypeScript types, `bun:sqlite`, consistent error handling, lint + type-check passing | MVP |
| NFR39 | Operability (Performance System) | Epic context assembly for up to 20 stories | < 500ms; pre-computed and cached after each story completion | MVP |
| NFR40 | Operability (Performance System) | Maintenance learning extraction must not block story completion | Async post-story-completion; failures logged for retry; story unaffected | MVP |

---

## 2. Identified NFR Conflicts

The following table identifies pairs or groups of NFRs where satisfying one makes another demonstrably harder to satisfy on the target hardware.

| Conflict ID | NFRs Involved | Conflict Description | Severity |
|-------------|---------------|----------------------|----------|
| **C1** | NFR5, NFR25, NFR31 | 30fps with 12 xterm panels + Copilot streaming on a 16GB/4-core machine — browser render thread competes with React reconciliation from simultaneous terminal updates and LLM stream chunking | HIGH |
| **C2** | NFR5, NFR17, NFR25 | 30fps with 12 xterm panels while 15 concurrent SQLite agents are writing — SQLite WAL-mode write bursts cause FSEvent/inotify spikes that can stall the event loop on the same machine | HIGH |
| **C3** | NFR4, NFR37 | Overlay composition must complete in 500ms total; NFR37 requires `pipeline.db` learning queries within 50ms — on a system under concurrent SQLite write pressure from 15 agents (NFR17), query latency can exceed 50ms, blowing the NFR4 budget | HIGH |
| **C4** | NFR2, NFR3 | Per-hook latency budget of 2s (NFR2) and phase boundary total of 60s (NFR3) — the phase boundary runs 6 checks including a full test suite and build. Under high disk I/O from concurrent worktrees (NFR17, NFR25), individual checks can burst past 2s each, threatening the 60s aggregate ceiling | MEDIUM |
| **C5** | NFR14, NFR17, NFR25 | Crash detection within 10s and replacement within 30s (NFR14) while 15 concurrent agents are contending for SQLite (NFR17) — replacement agent spin-up includes overlay composition (NFR4) plus SQLite reads; under write pressure, these combined latencies can breach the 30s window | MEDIUM |
| **C6** | NFR1, NFR17 | SSE event latency < 2s (NFR1) while 15 concurrent agents are writing to Overstory SQLite (NFR17) — the SSE endpoint reads the same SQLite database; under WAL checkpoint pressure, reads can block, increasing event latency above 2s | MEDIUM |
| **C7** | NFR22, NFR17 | Quality pipeline cost <= 5% of story cost (NFR22) constrains BMAD and QA to economy-tier models — but running 15 concurrent agents (NFR17) already taxes Pi SDK throughput; economy-tier model queue latency rises under concurrency, making it harder to complete BMAD + QA within budget without retries | LOW-MEDIUM |
| **C8** | NFR15, NFR16, NFR17 | Crash recovery with zero data loss (NFR15) + atomic learning writes (NFR16) + 15 concurrent agents (NFR17) — multiple concurrent atomic write-rename operations under memory pressure increase the probability of temp-file accumulation and OS buffer exhaustion on a 16GB machine | MEDIUM |
| **C9** | NFR36, NFR37 | 100MB storage limit per 1,000 stories (NFR36) while query latency must stay under 50ms (NFR37) — achieving fast queries typically requires indexes; indexes increase storage. Aggressive data archiving (to meet NFR36) and frequent archive sweeps create I/O bursts that raise query latency beyond NFR37's 50ms ceiling | LOW |
| **C10** | NFR8, NFR30, NFR31, NFR5 | Copilot Ask < 3s (NFR8), Copilot Investigate < 15s (NFR30), Copilot streaming must not degrade dashboard to below 30fps (NFR31+NFR5) — streaming LLM output to the chat bar while 12 xterm panels are rendering is a render-thread budget conflict. All four requirements are simultaneously binding during active Copilot use | HIGH |
| **C11** | NFR25, NFR17, NFR5 | The specific concurrent-load scenario: 16GB RAM, 12 xterm panels at 30fps, 15 concurrent SQLite-writing agents simultaneously active — the combined RSS of Overstory (Rust, ~50-100MB), Pi SDK runtime, Bun gateway process, 12 xterm.js contexts, dashboard React SPA, plus 15 agent process-equivalent in-flight state approaches or exceeds available physical RAM on a 16GB machine | CRITICAL |
| **C12** | NFR39, NFR37, NFR4 | Epic context assembly < 500ms for up to 20 stories (NFR39) requires pre-computation; but the pre-computation query itself runs against `pipeline.db` which must also serve NFR37's 50ms learning queries and NFR4's 500ms overlay composition — three latency-sensitive query paths hitting one SQLite file | MEDIUM |

---

## 3. Feasibility Assessment on Developer Hardware (16GB RAM, 4 Cores)

### 3.1 The Critical Concurrency Scenario (C11)

**Scenario:** NFR5 (30fps, 12 xterm panels) + NFR25 (16GB RAM floor) + NFR17 (15 concurrent SQLite agents) all simultaneously active.

**Memory budget estimation:**

| Component | Estimated RSS |
|-----------|--------------|
| Overstory process (Rust binary + SQLite in-proc) | 80–150 MB |
| Pi SDK runtime | 100–300 MB |
| Bun gateway/Factory Core process | 100–200 MB |
| Dashboard Chromium (React + 12 xterm.js instances) | 600–1,200 MB |
| Per-agent Bun subprocess (x15 in-flight) | ~50–100 MB each = 750–1,500 MB |
| SQLite WAL file buffers + OS page cache | 100–400 MB |
| macOS kernel + base OS processes | 2,000–3,000 MB |
| **Headroom at 16GB total** | **~12,000 MB available** |
| **Estimated total at peak** | **~3,730 – 6,750 MB** |

**Verdict:** Memory is technically sufficient in median estimates, but the variance is large. If agent subprocesses carry more state than estimated, or if the test runner for post-task hooks loads the project's full dependency graph (common in TypeScript monorepos), peak RSS can push toward 8–10 GB, leaving only 2–4 GB headroom before the OS starts paging.

**CPU budget at 4 cores:**
- 15 concurrent agents each capable of spawning child processes (test runners, lint, type check) represents severe over-subscription at phase boundary hooks, when all 15 could trigger the 6-check gate simultaneously.
- 4 cores / 15 active agent pipelines = effective 0.27 cores per agent for CPU-bound work. Phase boundary gates (full test suite, build) are CPU-bound. Completion time for a single gate run can multiply 3–5x under contention.
- NFR3 (60-second phase boundary ceiling) is likely to be violated when many stories reach phase boundaries near-simultaneously.

**Feasibility rating for C11:** INFEASIBLE as specified. The PRD simultaneously requires 15 concurrent agents AND 12 xterm panels AND 30fps AND a 16GB RAM floor. These four constraints are mutually satisfying only at low to moderate agent counts, not the 15 that NFR17 permits.

### 3.2 Per-Conflict Feasibility Assessment

| Conflict | Feasibility on 16GB/4-core | Assessment |
|----------|---------------------------|------------|
| **C1** (NFR5+NFR25+NFR31) | MARGINAL | 12 xterm panels at 30fps is achievable when agents are emitting output at normal rates. Copilot streaming adds ~10–20ms render overhead per frame. If terminals are rapidly writing hook output simultaneously, render rate can drop to 15–20fps. The constraint is render-thread budget, not memory. Mitigation possible via virtualized rendering. |
| **C2** (NFR5+NFR17+NFR25) | MARGINAL-INFEASIBLE | SQLite WAL checkpoint flushes on macOS can cause 20–200ms stalls in the main process event loop if the Overstory process and dashboard share the same host and the OS page cache is under pressure. 30fps requires a frame budget of 33ms. A single WAL checkpoint stall can drop multiple frames. |
| **C3** (NFR4+NFR37) | FEASIBLE with care | 50ms learning queries within a 500ms overlay budget is a 10% share, achievable if queries are indexed and `pipeline.db` is not under severe write pressure. Becomes infeasible if all 15 agents trigger overlay recomposition simultaneously. |
| **C4** (NFR2+NFR3) | MARGINAL | Individual hooks at 2s each, 6 checks, suggests a nominal budget of 12s maximum. The 60s ceiling provides 5x headroom — adequate when agent count is low. Under 15 concurrent worktrees with full test suites, disk I/O contention alone can push a single `bun test` run to 15–30s, threatening the 60s gate. |
| **C5** (NFR14+NFR17+NFR25) | MARGINAL | 30s replacement window is generous in isolation. Under load, overlay composition (500ms NFR4) + SQLite reads + Pi SDK initialization can collectively take 10–20s, leaving marginal time for crash detection (10s) and actual agent spawn. Feasible in practice only if agent startup is parallelized with detection. |
| **C6** (NFR1+NFR17) | FEASIBLE | SQLite WAL mode allows concurrent reads during writes. SSE reads will be fast unless the database is very hot. With good index design, 2s latency is achievable even at 15 concurrent writers. WAL checkpoint timing is the primary risk. |
| **C7** (NFR22+NFR17) | FEASIBLE | Economy-tier model queue latency adds wall-clock time but does not directly raise cost. As long as economy-tier models are available, BMAD + QA staying under 5% of story cost is achievable by design (economy models are cheaper). Risk: if economy-tier models are throttled and standard-tier is used as fallback, cost can jump. |
| **C8** (NFR15+NFR16+NFR17) | FEASIBLE | Atomic write-rename is OS-level atomic and does not require coordination. 15 concurrent atomic writes will not corrupt each other. OS temp file accumulation is not a practical concern at this scale. The risk is post-crash recovery joining an in-flight rename, which the PRD correctly addresses via write-to-temp/rename pattern. |
| **C9** (NFR36+NFR37) | FEASIBLE | SQLite indexes for the query patterns described (scope-based, recency-filtered) can cover both storage and latency requirements. 100MB per 1,000 stories is generous. Only becomes a concern after thousands of stories accumulate. |
| **C10** (NFR8+NFR30+NFR31+NFR5) | MARGINAL-INFEASIBLE | Copilot Ask < 3s depends on network and model latency, not local hardware — largely outside developer machine control. Copilot streaming while 12 xterm panels render is a render-thread conflict. In a single-threaded browser event loop, LLM token streaming via SSE and xterm.js DOM mutations compete for the same frame budget. |
| **C11** (NFR25+NFR17+NFR5) | INFEASIBLE as specified | See Section 3.1. |
| **C12** (NFR39+NFR37+NFR4) | FEASIBLE | NFR39's pre-computation model (cached after story completion, not on-demand) specifically avoids stacking these queries in the same hot path. The design is correct; feasibility depends on the pre-computation cache being warm. Cold-start scenarios (first story in an epic) still require live computation. |

---

## 4. Specific Concern: NFR5 + NFR25 + NFR17 Simultaneous Analysis

This is the highest-risk concurrent state in the system. The PRD specifies it across three separate NFRs without a unifying concurrency model that reconciles them.

### 4.1 The Three Requirements

- **NFR5:** Dashboard must maintain 30fps minimum render rate with up to 12 active xterm.js agent panels on a machine with 16GB RAM.
- **NFR25:** Factory must be runnable on a developer machine with 16GB RAM, 4 CPU cores, 20GB free disk — with graceful degradation on 8GB.
- **NFR17:** Overstory SQLite must handle concurrent read/write from up to 15 agents without data loss, silent write failures, or corruption.

### 4.2 The Implicit Assumption Problem

NFR5 says "up to 12 xterm panels." NFR17 says "up to 15 concurrent agents." These are treated as separate ceilings in separate NFR categories, but in operation they are simultaneous. A factory with 15 concurrent agents will show up to 15 agent panels in the Agent Windows view. The PRD's own dashboard spec (FR44) describes "tiled panels showing per-agent status, live output via xterm.js."

The implicit assumption embedded in the PRD is that the 12-panel rendering ceiling is independent of the 15-agent concurrency ceiling. In practice, when the factory is running 15 concurrent agents, the developer will want to observe all 15, meaning 15 xterm panels — not 12 — are the realistic maximum. NFR5 documents only 12, which means the 30fps guarantee does not actually cover the maximum-concurrency scenario that NFR17 enables.

### 4.3 Memory Pressure Analysis at Maximum Concurrency

Assuming a TypeScript/Bun project (the PRD's primary stack):

**Baseline idle factory (0 agents):**
- Overstory (Rust): ~80 MB
- Pi SDK: ~150 MB
- Factory Core (Bun): ~80 MB
- Dashboard (Chromium): ~200 MB base
- OS baseline: ~2,500 MB
- **Total baseline: ~3,010 MB**

**At 15 concurrent agents:**
- Each agent in Overstory is a state machine with a live SQLite connection, in-flight mail, and checkpoint data. Overstory's memory scales with active agent count. At 15 agents: ~200–400 MB additional.
- Hook execution: at any moment, some agents are running bun test, bun run lint, or tsc. Each spawns child processes. Three simultaneous test runners at ~150 MB each = ~450 MB additional burst.
- 12 xterm.js contexts in browser: Each xterm instance buffers scrollback. At 500-line default scrollback, ~2–5 MB per terminal. 12 terminals: ~60 MB. But active terminals emitting rapid output (hook banners, lint output) can spike to ~20 MB each temporarily. Worst case: ~240 MB.
- **Total at 15 agents with active hook execution: ~3,010 + 400 + 450 + 240 ≈ 4,100 MB**

This is 4.1 GB out of 16 GB available — well within budget at these conservative estimates. The risk is not steady-state RAM but burst scenarios:

**Burst scenario (phase boundary gates firing on 5 concurrent stories):**
- 5 concurrent `bun test` (full test suite): ~150 MB each = 750 MB
- 5 concurrent `tsc --noEmit`: ~200 MB each = 1,000 MB
- 5 concurrent `bun run lint` (ESLint): ~100 MB each = 500 MB
- Additional 2,250 MB burst on top of baseline ~3,010 MB = ~5,260 MB

Still within 16 GB headroom. The critical risk surfaces only if the project has large test suites or the TypeScript compilation is non-incremental.

**Real risk: CPU, not RAM, at 4 cores:**

4 CPU cores handling simultaneous:
- 5 concurrent full test suites (CPU-bound)
- 5 concurrent TypeScript compilations (CPU-bound)
- 5 concurrent ESLint runs (I/O + CPU bound)
- Overstory event processing loop
- Dashboard React render loop (30fps = 33ms frame budget)
- SQLite WAL checkpoint on write activity

CPU over-subscription at phase boundary storms is the real constraint. On 4 cores, this produces test run times of 3–10x normal, routinely violating NFR3's 60-second gate ceiling. The 30fps dashboard target will also be violated during burst CPU activity because the browser's rendering shares time with the same OS scheduler.

### 4.4 SQLite Concurrency at 15 Agents

SQLite WAL mode is well-suited to single-writer, multiple-reader workloads. Overstory's design (Rust-based orchestrator) implies a single-process SQLite writer with agents communicating via the Overstory API — this is the correct architecture for SQLite at this concurrency level.

However, there are two risk points:

1. **WAL auto-checkpoint:** By default, SQLite triggers a WAL checkpoint when the WAL file exceeds 1,000 pages (~4 MB). With 15 active agents writing frequently (mail delivery, state updates, learning records), the WAL can grow rapidly and trigger checkpoints that briefly block all writers. On a busy system this can cause 100–500ms write latency spikes, directly threatening NFR18's 1-second mail delivery guarantee.

2. **`pipeline.db` contention:** `pipeline.db` receives writes from action score computation (NFR35, 200ms budget) AND reads for overlay composition (NFR37, 50ms budget) AND epic context pre-computation (NFR39). If these happen to coincide, the SQLite queue may serialize them, adding cumulative latency.

---

## 5. Recommended Relaxations or Mitigations per Conflict

### C1 / C10 / C11 — Dashboard Render Concurrency (NFRs 5, 25, 31)

**Recommended relaxation:** Lower the xterm panel count threshold in NFR5 from 12 to 8 panels at 30fps, with explicit documentation that panels beyond 8 use a reduced-refresh mode (5fps or on-demand) when total active panels exceed 8. This reflects what xterm.js realistically supports under simultaneous high-output scenarios.

**Mitigation options without relaxation:**
- Implement xterm.js viewport virtualization: only render the visible portion of each terminal to DOM; off-screen terminals buffer but do not render.
- Throttle xterm.js write flushing to a maximum of 30 DOM updates per second per terminal rather than flushing every write immediately.
- Move the Copilot streaming handler off the React reconciliation path using a dedicated `requestAnimationFrame` queue to prevent LLM stream chunks from preempting terminal renders.

### C2 — SQLite WAL Pressure vs. Dashboard Render (NFRs 5, 17, 25)

**Recommended mitigation:**
- Configure Overstory's SQLite WAL checkpoint interval explicitly (`PRAGMA wal_autocheckpoint = 2000`) to reduce checkpoint frequency and shift checkpoint work to idle periods.
- Run Overstory in a separate OS process from the dashboard — which the PRD already implies — to prevent SQLite FSEvent notifications from reaching the Node/Bun event loop serving the dashboard SSE stream.
- If the dashboard backend runs in Bun, use a separate `pipeline.db` read replica pattern (periodic SQLite VACUUM into a read-only copy) for dashboard queries rather than querying the write-active Overstory database directly.

### C3 / C12 — SQLite Query Latency Under Write Pressure (NFRs 4, 37, 39)

**Recommended mitigation:**
- Add covering indexes on `pattern_knowledge(applicable_scope, confidence)` and `maintenance_learnings(story_origin, category)` — the two highest-frequency learning query patterns.
- Pre-warm the overlay cache: after a story completes, immediately trigger overlay pre-computation for likely next stories in the queue (scoped to the same file areas) so that NFR4's 500ms budget is not spent on cold queries.
- Separate `pipeline.db` into two files: `pipeline-write.db` (action scores, ELO, session composites — write-heavy) and `pipeline-read.db` (pattern knowledge, epic context, maintenance learnings — read-heavy with periodic refresh from write DB). This eliminates read/write contention on the hot overlay composition path.

**Recommended relaxation for NFR39:** The 500ms ceiling for epic context assembly over 20 stories is aggressive on a cold start. Relax to: "Epic context assembly must complete within 500ms when pre-computed cache is warm. First-story cold-start assembly may take up to 2 seconds." This matches the stated implementation intent (pre-computation after each story) without falsely promising sub-500ms on cold paths.

### C4 — Hook Latency vs. Gate Total Budget (NFRs 2, 3)

**Recommended mitigation:**
- Add explicit per-check timeouts within the phase boundary gate runner that are lower than NFR2's 2s per hook (e.g., 30s for test suite, 15s for build, 5s for lint, 5s for type check). If the full test suite takes more than 30s, the gate fails early with "test suite timeout" rather than hanging near the 60s ceiling.
- Parallelize independent gate checks within the phase boundary gate runner. Tests and lint are independent; running them simultaneously halves the gate time on multi-core machines. On 4 cores, 60 seconds of parallelized checks is achievable for all but the largest monorepos.

**Recommended relaxation:** NFR3's 60-second ceiling should explicitly state that it applies to the common case (project test suite under 30 seconds). Add a companion note: "For projects with test suites exceeding 30 seconds, the ceiling scales to (test_suite_duration + 30s)." Otherwise NFR3 is unachievable by design for any non-trivial project.

### C5 — Crash Recovery Under Load (NFRs 14, 17, 25)

**Recommended mitigation:**
- Crash detection (10s NFR14) must be implemented via process heartbeat signal, not polling. A Rust-side process watch (Overstory) can detect SIGCHLD or process exit in microseconds — the 10-second budget is easily met with event-driven detection.
- Agent replacement (30s NFR14) should pre-warm common overlay components. If Overstory keeps the last-used overlay stage results in a memory cache (per FR-implied caching), replacement agent spin-up is reduced to Pi SDK initialization + context assembly from cache, achievable under 5 seconds.
- The 30s replacement window is generous; this conflict is LOW risk if detection is event-driven and overlay composition is cached.

### C7 — Economy Model Cost vs. Throughput (NFRs 22, 17)

**Recommended mitigation:**
- Add explicit handling for economy-tier model queue saturation: when Pi SDK reports queue depth > N requests, automatically delay non-blocking BMAD/QA phase starts rather than launching all at once. This preserves the 5% cost target without allowing throughput degradation.
- NFR22's 5% ceiling should be re-examined: at very low story costs (simple Task work type), BMAD minimum setup overhead may constitute more than 5% regardless of model tier. The NFR should specify: "BMAD + QA cost <= 5% of development-phase cost or $0.10 per story, whichever is greater."

### C8 — Atomic Writes Under Concurrency (NFRs 15, 16, 17)

**No relaxation needed.** This conflict is lower risk than classified. SQLite transactions (NFR38 mandates `bun:sqlite`) provide atomicity guarantees superior to write-rename for database-resident records. For filesystem learning records (NFR16), write-rename is OS-level atomic on macOS and Linux. The risk is well-managed by the existing design.

### C9 — Storage Growth vs. Query Latency (NFRs 36, 37)

**No relaxation needed.** The 90-day default retention window will cap `pipeline.db` growth for any reasonable story throughput. At 10 stories per day, 90 days = 900 stories = ~90 MB, right at the ceiling. The primary mitigation is ensuring the archive job runs asynchronously and does not hold a write lock during archive sweeps. Recommend using `ATTACH DATABASE 'pipeline_archive.db'` and a single `INSERT INTO ... SELECT ... DELETE FROM` transaction for atomic archiving without extended lock duration.

---

## 6. NFRs That Should Be Re-Evaluated Before Architecture Commits

The following NFRs have specifications that are either internally inconsistent, underdetermined for the target hardware, or in conflict with other NFRs in ways that require an architectural decision before implementation begins.

| NFR | Issue | Required Decision |
|-----|-------|-------------------|
| **NFR5** | "Up to 12 active xterm.js panels" at 30fps is inconsistent with NFR17's "up to 15 concurrent agents." The dashboard (FR44) shows a panel per agent. The real maximum is 15 panels, not 12. The 30fps guarantee is not defined for the 15-panel case. | **Decision required:** Is the 30fps guarantee tied to panel count (e.g., "30fps with up to N panels") or to agent count? If panel count, define the degraded rendering mode for panels 13–15. If agent count, re-benchmark 15-panel rendering on target hardware before committing to 30fps. |
| **NFR17** | "Up to 15 concurrent agents" — this is the concurrency ceiling for SQLite, not the maximum factory story count. The PRD specifies 3–4 concurrent stories as MVP scope (FR147 rationale) but NFR17 permits 15 agents. At 5 phases × 4–6 agents per story, 3 concurrent stories could yield 60+ total agent instances over a session, though not all simultaneously. The "15 concurrent" figure needs a definition: 15 simultaneous live processes, or 15 active SQLite connections? | **Decision required:** Clarify whether NFR17's "15 agents" means 15 simultaneous Bun/Rust processes or 15 simultaneous SQLite connections. If the former, memory and CPU analyses must use process-level overhead estimates. If the latter, agents may share a single Overstory process with multiple logical agent state machines — a very different resource model. |
| **NFR3** | Phase boundary gate checklist in 60 seconds covers 6 checks including "full test suite pass" and "build succeeds." For a non-trivial TypeScript project, a full test suite + TypeScript compilation routinely exceeds 60 seconds. The NFR does not define what constitutes "standard hardware" for this measurement nor does it account for project-size variance. | **Decision required:** Either (a) specify a test suite size ceiling ("projects with <= 500 test cases and < 10,000 LOC"), or (b) reframe NFR3 as "the gate runner must not impose more than 30 seconds of overhead on top of the project's own test/build time." Without this, NFR3 is unverifiable for any real project. |
| **NFR22** | "Quality pipeline cost <= 5% of total story cost" conflates two independent variables: story complexity (determines dev cost) and BMAD/QA minimum overhead (determined by model tier and phase structure). For a 5-minute Task work type costing $0.10 in development, 5% = $0.005 — impossible for any LLM-based review. | **Decision required:** Add a minimum floor to NFR22: "BMAD + QA cost <= 5% of development-phase cost OR $0.05 per story, whichever is greater." Without the floor, the NFR creates impossible constraints for small Task work types. |
| **NFR25** | "Graceful degradation on machines with 8GB RAM" is undefined. Graceful degradation could mean: fewer concurrent stories, no xterm panels (headless operation), deferred learning synthesis, or all of the above. Without a degradation contract, implementation teams will make inconsistent choices. | **Decision required:** Define the 8GB degradation profile explicitly: maximum concurrent stories at 8GB, which features are disabled, whether the dashboard runs, and how the developer is informed of degraded mode. |
| **NFR31** | "Dashboard must maintain NFR5's 30fps requirement with the chat bar open and actively streaming responses" — this is a direct dependency on NFR5's 30fps target, which is itself under-specified (see NFR5 above). If NFR5 is relaxed, does NFR31 relax proportionally? | **Decision required:** Clarify whether NFR31 is independent ("Copilot streaming must not reduce fps by more than 5fps from baseline") or strictly dependent on NFR5 ("Copilot streaming must not cause NFR5 violations that would not otherwise occur"). The distinction matters for testing. |
| **NFR39** | "Epic context assembly must complete within 500ms for epics containing up to 20 stories" — the 500ms ceiling matches NFR4 (overlay composition) but is applied to a query that may need to read, join, and rank up to 20 story manifests plus associated pattern knowledge. The pre-computation model (stated in NFR39) makes this feasible in steady state but not on cold start (first story of an epic, or after a crash). | **Decision required:** Add a cold-start exception: "500ms ceiling applies when pre-computed epic context cache is available. Cold-start assembly (first story of epic or post-crash recovery) allows up to 3 seconds." |
| **NFR37** | "Learning record queries must complete within 50ms" — this is sound in isolation, but the NFR does not specify whether this is a p50, p95, or p99 latency target. SQLite WAL-mode read latency is typically sub-millisecond at p50 but can spike to 100–500ms at p99 when WAL checkpoints occur. | **Decision required:** Specify whether NFR37 is a p95 or p99 target, and define what happens when the target is missed (degrade gracefully by using a cached stale result? or fail the overlay composition?). |

---

## 7. Conflict Priority Matrix

| Priority | Conflicts | Blocking for Architecture? |
|----------|-----------|---------------------------|
| **CRITICAL — resolve before any architecture commits** | C11 (NFR5+NFR25+NFR17 simultaneous), NFR5 panel count vs. NFR17 agent count | YES — the concurrency model must be defined before database, process, and render architecture is chosen |
| **HIGH — resolve before story 1** | C1, C2, C10 (render thread conflicts); NFR3 test suite ceiling; NFR22 cost floor; NFR25 degradation profile | YES — implementation teams will make conflicting decisions without these defined |
| **MEDIUM — resolve before integration sprint** | C3, C4, C5, C6, C12; NFR31 Copilot/render dependency; NFR39 cold-start exception | PARTIAL — individual teams can proceed but integration will surface conflicts |
| **LOW — resolve before MVP launch** | C7, C8, C9; NFR37 latency percentile definition | NO — architecture is sound; these are tuning and operational decisions |

---

## 8. Summary of Recommended Pre-Architecture Decisions

1. **Define the concurrency model.** Establish a single table that maps "N concurrent active stories" to expected simultaneous agent count, expected SQLite connection count, expected dashboard panel count, and expected CPU load. NFR5, NFR17, and NFR25 must reference this table rather than defining independent ceilings.

2. **Reduce NFR5's 30fps guarantee scope.** Specify 30fps for up to 8 panels, with a defined degraded mode (5fps or on-demand refresh) for panels 9–12 or 9–15. This is achievable without architectural changes and removes an unverifiable requirement.

3. **Add a minimum floor to NFR22.** `max(5% of dev cost, $0.05)` prevents the NFR from being violated by design on Task work types.

4. **Reframe NFR3.** Change from a fixed 60-second ceiling to "gate runner overhead <= 30 seconds above project's own test/build baseline." This makes the NFR testable and project-size independent.

5. **Define the 8GB degradation profile for NFR25.** At minimum: maximum concurrent stories, whether dashboard runs, and how the developer is informed.

6. **Add cold-start exceptions to NFR39 and a percentile target to NFR37.** These convert untestable latency requirements into verifiable ones.

7. **Verify SQLite WAL configuration.** Before committing to NFR17's 15-agent ceiling and NFR1's 2-second SSE latency, benchmark WAL checkpoint behavior on target macOS hardware under simulated 15-agent write load. Establish the WAL autocheckpoint threshold that keeps checkpoint stalls under 100ms.

---

*Analysis generated 2026-03-14. All estimates are based on documented PRD specifications and general engineering knowledge of the involved technology stack (Rust/Bun/React/SQLite/xterm.js). Actual benchmarks on target hardware should validate or supersede these estimates before architecture commits are made.*
