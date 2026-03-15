# Assumption Validation Inventory — QDS Engineer v2

**Analysis Date:** 2026-03-14
**PRD Version:** v2.0 (Consolidated from Session 8, 2026-03-10)

---

## Executive Summary

The PRD contains **32 load-bearing assumptions** distributed across risk levels:

- **High Risk:** 7 assumptions
- **Medium Risk:** 12 assumptions
- **Low Risk:** 13 assumptions

**Critical Path Dependencies:** 5 assumptions that, if wrong, would require architectural redesign before MVP development can proceed.

---

## Full Assumption Inventory Table

| # | Assumption Statement | FRs at Risk | Risk Level | Validation Test | Timing |
|---|---|---|---|---|---|
| 1 | Pi SDK supports GLM-5 with model switching (economy/standard/complex tiers) | FR36, FR143 | HIGH | Verify Pi SDK can route economy-tier, standard, and complex reasoning models; measure latency/cost per tier; confirm tier switching is seamless in runtime | Before Architecture |
| 2 | Pi SDK economy-tier model responses stay under 1000 tokens 95% of the time for agent task contexts | FR36, FR38, FR39 | HIGH | Generate 50 representative agent task contexts; count tokens in economy-tier responses; validate 95th percentile under 1000 tokens | Before MVP Development |
| 3 | Overstory SQLite supports concurrent read/write from 15 agents without data loss or corruption | NFR17 | HIGH | Build distributed SQLite stress test: 15 agent processes, read/write/mail operations for 10 minutes; verify zero data loss, exactly-once mail delivery | Before MVP Development |
| 4 | Overstory mail delivery guarantees exactly-once semantics under concurrent access | NFR18 | HIGH | Write/read 1000 mail messages from concurrent agents; verify each message delivered exactly once; test under network jitter and process crashes | Before MVP Development |
| 5 | CopilotKit + AG-UI integrates with Bun/React environment without blocking dashboard SSE | FR104, FR105, NFR1, NFR31 | HIGH | Build test dashboard with CopilotKit chat bar + 12 active xterm.js panels; measure SSE event latency under active chat streaming; verify 30fps maintained | Before Architecture |
| 6 | ZeroClaw fork (React 19 + Vite + Tailwind) is transferable to QDS codebase without critical blockers | FR32, FR105 | HIGH | Attempt to extract ZeroClaw's SSE/WS client patterns and integrate into QDS tech stack; identify hard incompatibilities; measure integration effort | Before Architecture |
| 7 | gh CLI supports required operations without rate-limit blocking during 15-agent concurrent factory operation | FR49, NFR32 | HIGH | Simulate 15 concurrent agents creating branches/PRs/comments over 30-minute story; track gh API rate limit headers | Before MVP Development |
| 8 | Developer machine with 16GB RAM, 4 cores, 20GB free disk can sustain 12 active agents + dashboard without memory thrashing | NFR25, FR147 | MEDIUM | Run factory with 12 concurrent agents on a 16GB machine; monitor memory pressure; verify no OOM kills | Before MVP Development |
| 9 | Phase Boundary Protocol manifest schema is sufficient to capture all real story metadata without ad-hoc extensions | FR26, FR27, FR28 | MEDIUM | Execute 5 real stories through draft Phase Boundary Protocol; attempt to record all required context in manifest; identify missing fields | Before Architecture |
| 10 | BMAD review cycle completes in under 10 minutes for typical 1000-line story artifacts | FR10, FR11, NFR2 | MEDIUM | Submit 10 representative story PRs for BMAD review; measure review time distribution; confirm 90th percentile < 10 minutes | Before MVP Development |
| 11 | Cross-session learning actually reduces token waste in the same module area over a 7-day window | FR59, FR165, FR167 | MEDIUM | Track preventable maintenance findings for 4 weeks; measure if learning injection correlates with lower maintenance burden | Before Launch (ongoing) |
| 12 | Agent hallucination rate for code generation stays under 5% (hallucinated dependencies/functions per 100 actions) | FR130, FR131 | MEDIUM | Run 100+ story completions through BMAD; catalog hallucination types; compute hallucination rate | Before MVP Development |
| 13 | Budget projection algorithm can predict story phase costs within +/- 20% of actual spend | FR38, FR39 | MEDIUM | Run 20 representative stories; compare projected vs actual cost; compute MAPE; confirm < 20% | Before MVP Development |
| 14 | QA swarm completes within phase budget (NFR22: 3-5% quality pipeline cost) without cost overruns | FR6, FR7, NFR22 | MEDIUM | Run 10 stories through full QA pipeline; measure total QA + BMAD cost / total story cost | Before MVP Development |
| 15 | Conditional hooks (post-edit, post-task, phase-gate) execute reliably within 2-second timeout without false positives | FR93, FR94, NFR2 | MEDIUM | Write 30 hook implementations across all 4 hook points; measure execution time distribution and false alarm rate | Before MVP Development |
| 16 | Factory learning synthesis can process a day's data and produce actionable learnings in 10 minutes at ≤$0.50 | FR59, NFR6 | MEDIUM | Run daily synthesis over 5 days of accumulated learning data; measure end-to-end time and API cost | Before Launch |
| 17 | Structural verification can detect artifact gaps reliably without false positives that cause unnecessary fix loops | FR152, FR153 | MEDIUM | Build verification test suite with 50 scenarios; measure false positive and negative rates; confirm both < 2% | Before MVP Development |
| 18 | Factory CLI commands are sufficient for non-dashboard operational control without manual git/worktree intervention | FR49, FR69 | MEDIUM | Operate factory for 1 week using CLI only; verify all required operations available | Before Launch |
| 19 | `.mulch/` expertise format (append-only, merge-conflict free) works when both developers write simultaneously | FR61, FR62 | MEDIUM | Run two concurrent factory instances writing to `.mulch/` simultaneously; verify git merge succeeds without conflicts | Before MVP Development |
| 20 | Pi SDK's model-agnostic API allows swapping economy-tier provider without changing agent code | FR36, FR143 | LOW | Configure Pi SDK with different economy-tier models; verify agent code is unaffected by model swap | Before Launch |
| 21 | Agent window streaming (xterm.js) can display 12 concurrent agent outputs with < 100ms latency | FR48, NFR5 | LOW | Build dashboard with 12 active agent windows; measure latency from agent output to dashboard DOM update | Before MVP Development |
| 22 | Superpowers hook infrastructure is stable enough for production use in QDS factory | FR93, FR94 | LOW | Run 1000+ hooks through Superpowers during test stories; measure failure rate and timeout enforcement accuracy | Before MVP Development |
| 23 | Dashboard reconnection can restore full state within 5 seconds with correct event replay | FR48, NFR19 | LOW | Kill dashboard connection midway through story; measure time to full state restoration; verify no state inconsistency | Before MVP Development |
| 24 | Developer setup script can verify prerequisites in under 5 minutes on standard hardware | FR69, NFR23 | LOW | Run setup script on clean macOS and Linux machines; measure total runtime | Before Launch |
| 25 | Learning record storage in `pipeline.db` doesn't exceed 100MB per 1000 stories | FR165, NFR36 | LOW | Run 1000 stories with full learning recording; measure `pipeline.db` file size growth | Before Launch |
| 26 | Telegram notifications deliver within 5 seconds without credential leakage | FR120-FR129, NFR32, NFR33 | LOW | Send 100 test Telegram notifications; measure delivery latency; verify no credentials in message content | Before MVP Development |
| 27 | Phase boundary gate (6 checks) completes in under 60 seconds for typical story | FR93, NFR3 | LOW | Run gate checklist 20 times on representative story artifacts; confirm 90th percentile < 60 seconds | Before MVP Development |
| 28 | Overlay composition (all 6 stages) assembles in under 500ms even with learning enrichment queries | FR28, FR167, NFR4 | LOW | Profile overlay assembly across 20 stories; measure stage breakdown; confirm total < 500ms | Before MVP Development |
| 29 | Random audit mechanism produces reproducible but unpredictable audit selection without gaming | FR169 | LOW | Run audit selection 50 times on same story corpus; verify reproducibility and unpredictability | Before Launch |
| 30 | Circuit breaker subsystem health checks add negligible overhead (< 1% CPU impact) | FR170, NFR29 | LOW | Profile factory runtime with/without circuit breaker health checks; measure CPU overhead | Before MVP Development |
| 31 | Confidence scoring with Brier score calibration check can accurately assess agent self-confidence without gaming | FR131, FR156 | MEDIUM | Design with explicit resolution requirement; test against mock agent behaviors; verify gaming is detected | Before MVP Development |
| 32 | Per-role cost visibility provides sufficient granularity for budgeting without per-agent enforcement complexity | FR142, NFR22 | LOW | Run 20 stories; extract per-role cost breakdowns; verify insights are useful for budgeting decisions | Before Launch |

---

## Top 5 Highest-Risk Assumptions — Detailed Analysis

### Assumption 1: Pi SDK Model Switching (HIGH RISK)

**Statement:** Pi SDK supports seamless switching between economy-tier, standard (Claude 3.5 Sonnet), and complex-reasoning model tiers, with consistent API and latency predictability.

**Current Evidence:**
- PRD assumes 3 model tiers throughout cost model (FR36, FR38, FR39, NFR6, NFR7)
- Overlay composition assumes ability to route "economy-tier model for queries, standard tier for complex investigations" (FR105)
- Meta-optimization assumes economy-tier model can synthesize learnings in $0.50/run budget (NFR6)

**Failure Mode if Wrong:**
- Cannot optimize cost per agent role → entire economic model collapses
- Budget projections become unreliable → overspending and trust loss
- Daily synthesis exceeds cost ceiling → learning system disabled
- Dashboard copilot cannot function with forced high-tier routing → FR104 unachievable

**Validation Test:**
1. Contact Pi SDK team; confirm production API supports 3 distinct model tiers with switching
2. Deploy test harness with 100 identical tasks routed to each tier
3. Measure: response latency per tier and cost per tier
4. Verify: switching between tiers in same session works reliably
5. Stress test: 50 concurrent requests across 3 tiers; confirm no routing errors

**Fallback Strategies:**
- **Option A:** Pin to single model tier (Sonnet for all) — lose cost optimization, 3-5x story cost increase
- **Option B:** Implement economic tier via external model provider — adds latency risk
- **Option C:** Defer economy-tier routing to Growth; MVP uses single standard tier — loses ~30% cost advantage

**Recommended Timing:** Before Architecture (Week 1)
**Success Criteria:** Written confirmation from Pi SDK with production API docs showing 3+ tier support

---

### Assumption 2: Overstory SQLite Concurrent Write Guarantees (HIGH RISK)

**Statement:** Overstory SQLite can handle 15 concurrent agents performing read/write/mail operations without silent write failures, data loss, or corruption; exactly-once mail delivery semantics.

**Current Evidence:**
- NFR17 mandates 15 concurrent agents without data loss
- NFR18 mandates exactly-once mail delivery
- Entire coordination architecture depends on Overstory as single source of truth

**Failure Mode if Wrong:**
- Silent data loss during concurrent writes → undetected agent state corruption → cascading failures
- Duplicate mail delivery → agents execute tasks twice → undetected bugs shipped
- Lost mail → agents stall indefinitely
- Coordination model breaks → need distributed consensus (etcd, Redis) → architectural redesign

**Validation Test:**
1. Build distributed SQLite stress rig with 15 agent processes
2. Each agent: insert 100 records, read 50 concurrent records, update 30 records, send/receive 50 mail messages over 10 minutes
3. Introduce failures: kill process mid-write, disk full scenarios
4. Verify database integrity post-test; verify exactly-once mail delivery across 5 runs

**Fallback Strategies:**
- **Option A:** Reduce concurrent agent limit to 8 — lose parallelism, 2x slower stories
- **Option B:** Add explicit locking layer above SQLite — adds latency and complexity
- **Option C:** Replace with proper message queue (Redis, NATS) — architectural redesign, external dependency

**Recommended Timing:** Before MVP Development (Week 2-3)
**Success Criteria:** Green stress test with 15 agents, zero data loss, exactly-once delivery verified

---

### Assumption 3: CopilotKit + AG-UI Dashboard Integration (HIGH RISK)

**Statement:** CopilotKit chat UI + AG-UI integrates into Bun/React dashboard without blocking SSE event streaming; dashboard maintains 30fps with 12 active agent panels while chat is streaming responses.

**Current Evidence:**
- FR104: Copilot conversational control plane with 3 modes
- NFR1: SSE event latency < 2 seconds
- NFR5: Dashboard 30fps with 12 active panels
- NFR31: Copilot chat bar must not impact dashboard render performance

**Failure Mode if Wrong:**
- Chat bar blocks SSE event updates → agent status lags → dashboard becomes unreliable
- Memory pressure from chat + 12 xterm.js panels → GC pauses → frame drops below 30fps
- Lose human-in-loop control plane → must operate factory headless (high risk)

**Validation Test:**
1. Build minimal dashboard test: CopilotKit chat bar + 12 xterm.js panels
2. Baseline: measure FPS and SSE latency without chat bar
3. Add chat bar; re-measure while chat actively streams a response
4. Inject stress: 2000-token chat response while panels emit logs simultaneously
5. Measure FPS degradation (must stay > 28fps), SSE latency (must stay < 2.5s), heap size

**Fallback Strategies:**
- **Option A:** Move chat to separate browser tab — lose co-located UX
- **Option B:** Disable chat while agents are running — lose real-time control value
- **Option C:** Implement chat via WebWorker — adds complexity, increases latency

**Recommended Timing:** Before Architecture (Week 1)
**Success Criteria:** Dashboard test passes all metrics on 16GB machine; no frame drops during chat streaming

---

### Assumption 4: Phase Boundary Protocol Manifest Schema Sufficiency (HIGH RISK)

**Statement:** PBP manifest schema can capture all real-world story metadata without requiring ad-hoc extensions mid-sprint.

**Current Evidence:**
- FR26-FR28 depend entirely on manifest schema design
- FR59, FR165, FR167 all consume manifest data
- PRD explicitly calls this "novel, highest design risk"

**Failure Mode if Wrong:**
- Agents create ad-hoc metadata → no structural consistency → verification breaks
- Learning system cannot correlate patterns → overlays ineffective
- Fix-loop amplification: each round discovers new schema gaps, redefines manifest, stories restart

**Validation Checklist:**
- ✓ Story dependencies (other stories, external systems)
- ✓ Acceptance criteria with test expectations
- ✓ File scope (which paths will this story touch?)
- ✓ Module boundaries (architectural constraints)
- ✓ Must-haves checklist (what artifacts must exist for verification?)
- ✓ Learned patterns from earlier stories
- ✓ Context budget allocation
- ✓ Model tier recommendations
- ✓ Deviations from acceptance criteria

**Fallback Strategies:**
- **Option A:** Extend schema based on pilot feedback — 1-week iteration before MVP
- **Option B:** Living schema (agents define new fields) — lose structural consistency
- **Option C:** Store raw metadata separately — lose coherence, harder to query

**Recommended Timing:** Before Architecture (Week 1-2)
**Success Criteria:** 5 pilot stories complete; schema captures all required metadata without ad-hoc extensions

---

### Assumption 5: BMAD Review Cycle Latency (HIGH RISK)

**Statement:** BMAD can review typical 1000-line story artifacts and complete review within 10 minutes, supporting phase progression without blocking throughput.

**Current Evidence:**
- Phase progression gates on BMAD review completion (FR10, FR11)
- Cost model assumes BMAD + QA ≤ 5% of story cost (NFR22)
- No timing baseline currently exists

**Failure Mode if Wrong:**
- BMAD takes 20+ minutes per story → phase progression stalls → stories take 2x longer
- Developer loses real-time feedback → loses Journey 2 (error recovery) value
- QA phase starts before BMAD findings available → QA agents duplicate BMAD work → cost overrun

**Validation Test:**
1. Prepare 10 representative story PRs (200-2000 LOC, various domains)
2. Submit each to BMAD agent with full context
3. Measure: PR created → BMAD agent spins up → review findings written
4. Success criteria: Median < 8 minutes, 90th percentile < 10 minutes, cost < 3% of story cost

**Fallback Strategies:**
- **Option A:** Accept slower phase progression; increase timeout — lose throughput
- **Option B:** Run BMAD in parallel during development; async feedback — lose phase-gate guarantee
- **Option C:** Defer mandatory BMAD to Growth; MVP uses optional BMAD — lose quality safety

**Recommended Timing:** Before MVP Development (Week 3-4)
**Success Criteria:** BMAD latency distribution established; 90th percentile < 10 minutes; findings actionable on 9/10 stories

---

## Recommended Validation Sequence Before Architecture Begins

### Phase 0: Risk Discovery (Week 1) — Parallel tracks

| Track | Assumption | Output | Blocker For |
|---|---|---|---|
| Pi SDK Verification | #1 — Pi SDK 3-tier support | API capability confirmation | Cost model, overlay composition design |
| CopilotKit Spike | #3 — CopilotKit + AG-UI | Baseline performance metrics | Dashboard architecture |
| PBP Design Workshop | #4 — Manifest schema | PBP v0 manifest schema | FR26-FR28, learning system |

### Phase 1: Foundation Validation (Week 2-3) — Sequential

1. **Overstory SQLite Stress Test** (#2) — 15-agent concurrent stress harness → blocker for coordination architecture
2. **PBP Pilot** (#4 continued) — 5 stories through draft protocol → iterate schema
3. **BMAD Latency Baseline** (#5) — 10 representative PRs → confirm < 10 min 90th percentile

### Phase 2: Integration Validation (Week 4)

1. **Dashboard SSE + Agent Window Performance** (#21) — 12 xterm.js panels baseline
2. **End-to-End Story Dry Run** — 3 simulated stories through all 5 phases

---

## Architecture Gate Criteria

All of the following must be satisfied before the architecture sprint begins:

- [ ] Pi SDK 3-tier support confirmed in writing from Pi team
- [ ] CopilotKit + dashboard baseline performance measured (30fps, < 2s SSE achievable)
- [ ] Overstory SQLite stress test passes (15 agents, zero data loss, exactly-once mail)
- [ ] Phase Boundary Protocol v1 schema validated on 5 pilot stories
- [ ] BMAD review latency baseline established (90th percentile < 10 minutes)
- [ ] Dashboard 12-panel performance baseline confirmed
- [ ] 16GB RAM constraint impact assessed
- [ ] All critical-path dependencies charted and mitigations documented

---

## Critical-Path Assumptions Summary

| # | Assumption | Impact if Wrong | Validation Type | Timing | Gate |
|---|---|---|---|---|---|
| 1 | Pi SDK 3-tier support | Cost model collapses | API verification | Week 1 | Before Architecture |
| 2 | Overstory SQLite concurrency | Data loss / corruption | Stress test (15 agents) | Week 2-3 | Before MVP Dev |
| 3 | CopilotKit dashboard integration | Dashboard becomes unreliable | Performance spike | Week 1 | Before Architecture |
| 4 | Phase Boundary Protocol schema | Learning system breaks | 5-story pilot | Week 1-2 | Before Architecture |
| 5 | BMAD review latency | Phase progression stalls | 10-story benchmark | Week 2-3 | Before MVP Dev |
