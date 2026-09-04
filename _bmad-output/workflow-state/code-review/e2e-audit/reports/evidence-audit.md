# Live-Fire Evidence Audit Report

**Date:** 2026-08-24
**Auditor:** evidence-audit (READ-ONLY)
**Repo:** /Users/steve/QDS-Factory
**Scope:** _bmad-output/evidence/, story documents, artifacts/

## Executive Summary

**Total evidence directories:** 7 (df1-4, df1-6, df1-8, df2-8, df3-2, df4-1, df4-2)
**Total claims found:** 0 PROVEN live-fire claims, 5 ASSERTED-ONLY claims
**Fleet verbs live:** NO evidence
**DF3.2 patterns live:** NO evidence
**Cap-hit demo location:** Found at tests/providers/cap-hit-demo.test.ts (GATED)

## Claim Inventory

### DF1-4: Two-Phase Trace

| Claim | Source | Artifact | Verdict | Notes |
|-------|--------|----------|---------|-------|
| Real requestId traces | df1-4/two-page-read.json | e2e-two-phase-trace.db | ASSERTED-ONLY | Contains requestId/event_id/timestamps but no runIds/boxIds/costs - appears to be fixture/demo data |

### DF1-6: E2E Live Evidence

| Claim | Source | Artifact | Verdict | Notes |
|-------|--------|----------|---------|-------|
| "runId: 2f92bbbc-70d7-493e-b1fd-c9c3cabfe1ef" | e2e-live-evidence.json:14 | e2e-live-evidence.json | PROVEN | Real runId with costMicrosFirstEvent: 2670, real OpenRouter models (claude-haiku-4.5, deepseek-v3.2) |
| "runId: d27b32d2-cbcc-4d4e-a0bf-a3c0c29e9b51" | e2e-live-evidence.json:34 | e2e-live-evidence.json | PROVEN | Second runId, real test execution |

### DF1-8: Chain Check & Replay

| Claim | Source | Artifact | Verdict | Notes |
|-------|--------|----------|---------|-------|
| Identical replay test | replay-proof.json | replay-proof.json | PROVEN | Second initiation returned existing runId, re-executed nothing |
| Zero divergence across tables | chain-check.json | chain-check.json | PROVEN | Total divergent: 0 across sessions/phases/events/envelopes |

### DF2-8: Budget Cap

| Claim | Source | Artifact | Verdict | Notes |
|-------|--------|----------|---------|-------|
| "5,200,000 µ$ spent, cap 5,000,000 µ$" | e2e-cost-demo.json:15 | e2e-cost-demo.json | PROVEN | Real budget cap exceeded, dispatch2Refusal with over-budget status |

### DF3-2: PR128 Review Triage

| Claim | Source | Artifact | Verdict | Notes |
|-------|--------|----------|---------|-------|
| Live-fire fleet patterns | pr128-triage.md | pr128-triage.md | ASSERTED-ONLY | This is a code review ledger, NOT evidence of live execution |

### DF4-1: E2E Demo

| Claim | Source | Artifact | Verdict | Notes |
|-------|--------|----------|---------|-------|
| "total_cost 250000 micro-usd / 430 tokens" | e2e-demo.json:4 | e2e-demo.json | PROVEN | Session cost with sessionId, prompts, gates from trace fixture |

### DF4-2: Test Output

| Claim | Source | Artifact | Verdict | Notes |
|-------|--------|----------|---------|-------|
| "cap-hit-demo.test.ts 31 pass" | teardown-callers.txt | teardown-callers.txt | ASSERTED-ONLY | Test names only, no run data |

## Story Document Claims

### DF3-1: Dispatcher Core Verbs (dispatch, status, harvest, teardown)

**File:** _bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-1-dispatcher-core-verbs.md (1654 lines)

**Claims found:**
- **Line 38:** "four tested dispatcher verbs that mint a run handle, report fleet state, pull work back, and destroy a box" - ASSERTED-ONLY, no artifact
- **Line 44:** "e2e test pins" - ASSERTED-ONLY, no artifact path
- **Line 45:** "real using only code merged by this story" - ASSERTED-ONLY

**Live-fire evidence:** NONE

### DF3-2: Fleet Patterns as Code — fan-out N, best-of-N, race

**File:** _bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-2-fanout-best-of-n.md (755 lines)

**Claims found:**
- **Line 27:** "three fleet patterns as tested code" - ASSERTED-ONLY
- **Line 46:** "N independent dispatch calls through DF3.1" - ASSERTED-ONLY
- **Line 98:** "polling for the engine's in-box marker" - ASSERTED-ONLY

**Live-fire evidence:** NONE

## Cap-Hit Demo Location

### Briefing Claim vs Reality

**Briefing stated:** "df2-4 has the live cap-hit demo (real key, 53,447 µ$ spent, real 403 refusal, 2026-08-19)"

**Reality:**
1. **df2-4 directory DOES NOT EXIST** in _bmad-output/evidence/
2. **Actual location:** tests/providers/cap-hit-demo.test.ts (31 tests)
3. **Test status:** GATED behind `test.todoIf(!process.env.QDS_EXEDEV_LIVE)` (line 978)
4. **The "53,447 µ$" claim:** NOT FOUND in any evidence file - ASSERTED-ONLY

### Gated Test Analysis

From tests/providers/cap-hit-demo.test.ts:

```typescript
test.todoIf(!process.env.QDS_EXEDEV_LIVE)(
  "live cap-hit kill: real box, real capped key, verified revocation (DOD MANDATORY)",
  async () => {
    // Requires QDS_EXEDEV_REPO_URL, QDS_EXEDEV_SHA, QDS_EXEDEV_ROSTER, OPENROUTER_PROVISIONING_KEY
    // Spawns real subprocess with driver=exedev, cap=50000
    // Expected: verdict="demonstrated", spendMicroUsd >= 50000
  }
)
```

**Verdict:** The live cap-hit demo exists as a GATED test that only runs when QDS_EXEDEV_LIVE is set. No evidence artifact exists showing it ever ran successfully with real spend.

## Artifacts at Repo Root

| File | Size | Type | Verdict | Notes |
|------|------|------|---------|-------|
| artifacts/df1-3-e2e-event-stream.json | ~2.8KB | Event stream | PROVEN | Real sessionId, costMicros: 600000, retry evidence |
| artifacts/lean-worker-benchmark.json | ~5.9KB | Benchmark | PROVEN | Control vs lean arms, real token counts, durations |
| artifacts/worker-a.json | 126B | Fixture | ASSERTED-ONLY | Simple {"changedFiles": ["src/a.ts"]} |
| artifacts/worker-b.json | 126B | Fixture | ASSERTED-ONLY | Simple {"changedFiles": ["src/b.ts"]} |

## Classification by Sprint Story

| Directory | Sprint Story | Fleet Verbs | DF3.2 Patterns | Live-Fire? |
|-----------|--------------|-------------|----------------|------------|
| df1-4 | DF1.4 (tracer) | NO | NO | NO (fixture data) |
| df1-6 | DF1.6 (event stream) | NO | NO | YES (runIds, costs, OpenRouter) |
| df1-8 | DF1.8 (replay) | NO | NO | NO (unit tests) |
| df2-8 | DF2.8 (budget cap) | NO | NO | YES (budget exceeded) |
| df3-2 | DF3.2 (fanout) | NO | NO | NO (code review ledger) |
| df4-1 | DF4.1 (demo) | NO | NO | NO (fixture) |
| df4-2 | DF4.2 (tests) | NO | NO | NO (test names only) |

## Fleet Verbs & DF3.2 Patterns Live Evidence

### Question: Does ANY existing evidence prove fleet verbs or DF3.2 patterns live?

**Answer:** NO

### Analysis:

1. **Fleet verbs (dispatch/status/harvest/teardown):**
   - NO evidence contains real `dispatch` calls with exe.dev boxes
   - NO evidence contains `status` output from real boxes
   - NO evidence contains `harvest` or `teardown` on real boxes
   - df4-2 only shows test pass/fail counts, not actual executions

2. **DF3.2 patterns (fanout/best-of-n/race):**
   - NO evidence shows N concurrent arms with real boxes
   - NO evidence shows best-of-N ranking with real costs
   - NO evidence shows race completion with real polling
   - df3-2/pr128-triage.md is a code review ledger, not execution evidence

3. **Missing identifiers:**
   - No boxIds from exe.dev in any evidence
   - No fleet.lock files showing real concurrent operations
   - No fanout record JSONs with winner/arms arrays
   - No ranking tables with real scores

## Evidence Quality Assessment

### PROVEN Claims (contain real identifiers)

- **df1-6:** Real runIds, real OpenRouter models, real micro-dollar costs
- **df1-8:** Proven replay behavior with identical runIds
- **df2-8:** Proven budget cap with 5M µ$ cap and 5.2M µ$ spend
- **df4-1:** Session cost from trace fixture

### ASSERTED-ONLY Claims (text without artifact backing)

- **df3-1:** "four tested dispatcher verbs" - no execution artifact
- **df3-2:** "three fleet patterns as tested code" - no execution artifact
- **cap-hit briefing:** "53,447 µ$ spent, real 403 refusal" - not found in evidence
- **df4-2:** Test pass counts only, not execution data

### MISSING Artifacts

- **df2-4:** Directory claimed in briefing but does NOT exist
- **Live cap-hit evidence:** No artifact showing 53,447 µ$ spend or 403 refusal

## Recommendations

1. **For fleet verbs live-fire:** Need evidence containing:
   - Real boxIds from exe.dev
   - Actual dispatch/status/harvest/teardown execution logs
   - Provider API calls with real credentials

2. **For DF3.2 patterns live-fire:** Need evidence containing:
   - N concurrent arm records with distinct runIds
   - Fanout record with winner/arms arrays
   - Ranking output with real scores
   - Race completion markers

3. **For cap-hit demo:** Either:
   - Run the gated test and save its output artifact
   - Or correct the briefing to remove the "53,447 µ$ spent" claim

4. **Evidence directory structure:** Consider adding df2-4 directory if live cap-hit evidence exists

## Secret Exposure Check

**No secrets found in evidence artifacts.** All token/key values are redacted or not present. Real boxIds, runIds, and cost numbers are evidence identifiers, not secrets.

---

**END OF AUDIT**

Generated: 2026-08-24
Auditor: evidence-audit
Status: READ-ONLY (no edits made to source files)
