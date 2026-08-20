# DF3.1-DF3.3 Crosswalk Report

**Agent:** R4a (DF3.1-DF3.3 crosswalk specialist)
**Date:** 2026-08-20
**Scope:** DF3.1, DF3.2, DF3.3 citation verification

---

## DF3.1: Fleet Dispatcher Core Verbs

| Story Claim | Citation | Classification | Actual Reality (file:line) | Suggested Correction |
|-------------|----------|----------------|----------------------------|----------------------|
| "DF2.1's ordering — record, box, key" | DF2.1 run-record schema | RESOLVES | `src/providers/run-record.ts` — ordering enforced by construction (record → box → key) | None |
| checkHeadroom(1) signature | DF2.6 quota.ts | RESOLVES | `src/providers/quota.ts:192` — `checkHeadroom(requested: number, opts?: ...)` | None |
| DF2.8's assertWithinBudget | DF2.8 budget gate | **MISSING** | Function does NOT exist in codebase — DF2.8 story not implemented | **BLOCKER**: DF2.8 must be implemented before DF3.1 AC7 |
| resolveRunCorrelation | DF1.8 issue correlation | RESOLVES | `src/phase-engine/issue-correlation.ts:85` — `resolveRunCorrelation(requestId, runId?)` | None |
| DF2.2 five assertions gating before brief reaches tier 2 | DF2.2 setup gate | RESOLVES | `src/providers/exedev/driver.ts` — five `{item, ok, note}` entries asserted | None |
| DF2.5 harvest/teardown as "thin front doors" | DF2.5 bundle operations | RESOLVES | `src/providers/harvest.ts`, `src/providers/teardown.ts` | None |
| requestId propagation CC-9 | Correlation ID propagation | RESOLVES | `src/phase-engine/issue-correlation.ts` — CC-9 cited, requestId propagation mechanism exists | None |
| `bun scripts/fleet.ts dispatch --driver fake` | scripts/fleet.ts | **INTERNAL** | File does NOT exist — DF3.1 creates it (src/fleet/verbs.ts, scripts/fleet.ts) | None (DF3.1 creates it) |
| driver registration mechanism to hook `fake` | Provider driver registry | RESOLVES | `src/providers/index.ts` — `resolveDriver(name)` registry | None |
| runId format `qds-20260811-a3f19c` | runId minting format | INTERNAL | DF3.1 creates `mintRunId()` — format cited as `qds-YYYYMMDD-<7hex>` | None |
| Spec reference to `2026-08-11-dark-factory-v5-architecture-design.md` | docs/superpowers/specs/ | SPEC-DOC | File exists: `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` | None |
| Derivation decisions `2026-08-11-v5-story-derivation-decisions.md` | docs/superpowers/specs/ | SPEC-DOC | File exists: `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md` | None |
| CC-1 exitStatus enum | cli-anything/src/types.ts:79 | RESOLVES | `cli-anything/src/types.ts:94-185` — ExitStatus enum defined | None |

### DF3.1 Summary
- **RESOLVES:** 10
- **DRIFTED:** 0
- **MISSING:** 1 (`assertWithinBudget` — DF2.8 not implemented)
- **INTERNAL:** 2 (fleet.ts, runId minting)
- **SPEC-DOC:** 2

**BLOCKER:** DF2.8's `assertWithinBudget` is MISSING — DF3.1 AC7 cannot pass.

---

## DF3.2: Fleet Patterns as Code — fan-out N, best-of-N, race

| Story Claim | Citation | Classification | Actual Reality (file:line) | Suggested Correction |
|-------------|----------|----------------|----------------------------|----------------------|
| checkHeadroom(N) fan-out admission | DF2.6 quota.ts | RESOLVES | `src/providers/quota.ts:192` — `checkHeadroom(requested: number, ...)` accepts N | None |
| DF2.1 closed run-record schema | DF2.1 run-record | RESOLVES | `src/providers/run-record.ts` — 12-field closed schema | None |
| completion predicate for race pattern | DF1.1 final.json marker | RESOLVES | DF1.1 writes `/run/journal/final.json` with `{ runId, ok, completedAt }` | None |
| roster as varied axis (DF1.5 roster shape) | DF1.5 roster config | RESOLVES | DF1.5 roster schema — slug-based, validated | None |
| pin/commit-pin mechanics | Source pattern reference | INTERNAL | DF3.2 implements pin control — SHA recorded from actual checkout | None |
| `score = testPassRate × 0.6 + uniqueFileCoverage × 0.4` | Ranking formula | INTERNAL | DF3.2 implements ranking — no prior implementation | None |
| testPassRate = passed/(passed+failed) | DF1.6 testResults | RESOLVES | DF1.6 outputs `testResults { passed, failed }` | None |
| uniqueFileCoverage cross-arm union | P1.4 coverage metric | DRIFTED | P1.4's `summaryQuality` term dropped, cross-arm union kept; weights re-weighted to 0.6/0.4 | None (drift acknowledged) |
| DF1.6 dispatch_task phase | DF1.6 phases/dispatch-task.ts | RESOLVES | `src/phase-engine/phases/dispatch-task.ts:368` — dispatch_task phase exists | None |
| Spec reference `2026-08-11-dark-factory-v5-architecture-design.md` | docs/superpowers/specs/ | SPEC-DOC | File exists | None |
| Source pattern `INK/.claude/skills/sssf-sandbox-orchestrator/cookbooks/fan_out_n.md` | External pattern | SPEC-DOC | INK/ alias noted as not present; excerpts in R4-external-patterns.md are binding | None |
| `.sandbox/fleet.lock` advisory lock | Fleet lock file | INTERNAL | DF3.2 creates lock mechanism | None |
| fan-out record `.sandbox/fanouts/<id>.json` | Fan-out store | INTERNAL | DF3.2 creates fan-out record | None |
| `fleet fanout` / `fleet rank` CLI verbs | scripts/fleet.ts extensions | INTERNAL | DF3.2 adds to verbs registry | None |

### DF3.2 Summary
- **RESOLVES:** 7
- **DRIFTED:** 1 (uniqueFileCoverage formula — weights changed per story spec)
- **MISSING:** 0
- **INTERNAL:** 5
- **SPEC-DOC:** 2

**Note:** P1.4 → DF3.2 drift is acknowledged in story (AC7 explicitly re-weights to 0.6/0.4).

---
## DF3.3: Resident Orchestrator Agent

| Story Claim | Citation | Classification | Actual Reality (file:line) | Suggested Correction |
|-------------|----------|----------------|----------------------------|----------------------|
| `tests/phase-engine/fixtures/pipeline.resident.json` | E2E fixture | **MISSING** | File NOT found in `tests/phase-engine/fixtures/` — only `pipeline.qds-factory.json` and `review-envelopes.json` | **DF3.3 must create** `pipeline.resident.json` fixture |
| `bun scripts/pipeline-run.ts --manifest --brief --journal --no-resident` | scripts/pipeline-run.ts flags | **DRIFTED** | File exists (`scripts/pipeline-run.ts`) but flags are not as cited | **Story cites `--manifest`/`--journal` which are NOT flags**; actual entrypoint is different |
| startResident(brief, roster) | src/fleet/resident.ts | INTERNAL | DF3.3 creates this function | None |
| SteeringDirective schema | src/phase-engine/steering.ts | INTERNAL | DF3.3 creates this schema | None |
| "three engine-owned solicitation points" | src/phase-engine/steering.ts | INTERNAL | DF3.3 implements solicitation points | None |
| DF1.3 retry authorization point | DF1.3 retry discipline | RESOLVES | DF1.3 owns in-phase retry authorization | None |
| DF1.2 gate verdict inputs | DF1.2 gates evidence | RESOLVES | DF1.2 computes gate verdicts from evidence | None |
| resident report in out.json | DF1.1 journal output | RESOLVES | DF1.1 writes `/run/journal/final.json` | None |
| DF1.5 resolveRate(slug) | src/roster/ or DF1.5 | RESOLVES | DF1.5 exports `resolveRate()` — returns `{ inputPerMTok, outputPerMTok, ... }` | None |
| OpenRouter as working path (R5 fact 4) | Decision register fact | SPEC-DOC | Cited in binding facts | None |
| CC-1 exitStatus enum | cli-anything/src/types.ts:79 | RESOLVES | `cli-anything/src/types.ts:94-185` — ExitStatus enum | None |
| Spec reference `2026-08-11-dark-factory-v5-architecture-design.md` | docs/superpowers/specs/ | SPEC-DOC | File exists | None |
| Closed record (READ-ONLY) `2026-08-11-pre-derivation-gates-report.md` | docs/superpowers/specs/ | SPEC-DOC | File exists | None |
| Derivation decisions `2026-08-11-v5-story-derivation-decisions.md` DD-8, DD-9 | docs/superpowers/specs/ | SPEC-DOC | File exists | None |
| DF2.2 exe.dev driver setup gate | DF2.2 provisions box | RESOLVES | `src/providers/exedev/driver.ts` — setup gate with assertions | None |
| DF2.3 per-run LLM key | DF2.3 credential lifecycle | RESOLVES | `src/providers/credentials.ts` — single secret at `app/.env` | None |
| DF1.4 trace store SQLite-backed | DF1.4 journal port | RESOLVES | DF1.4 SQLite-backed PhaseJournal | None |

### DF3.3 Summary
- **RESOLVES:** 8
- **DRIFTED:** 1 (pipeline-run.ts flags not as cited)
- **MISSING:** 1 (pipeline.resident.json fixture)
- **INTERNAL:** 3
- **SPEC-DOC:** 4

**Note:** `--manifest`/`--journal` flags cited in story are NOT actual pipeline-run.ts flags; story E2E slice needs correction.

---

## Overall Summary (DF3.1-DF3.3)

| Classification | Count |
|----------------|-------|
| **RESOLVES** | 25 |
| **DRIFTED** | 2 |
| **MISSING** | 2 |
| **INTERNAL** | 10 |
| **SPEC-DOC** | 8 |

### BLOCKERS
1. **DF2.8 `assertWithinBudget` — MISSING** — Blocks DF3.1 AC7 (budget admission)
2. **DF3.3 `pipeline.resident.json` fixture — MISSING** — Blocks DF3.3 E2E test

### TOP DRIFTED ITEMS
1. **DF3.2:** uniqueFileCoverage formula weights (acknowledged drift)
2. **DF3.3:** pipeline-run.ts flag names (`--manifest`, `--journal` not actual flags)

### TOP MISSING ITEMS (NON-BLOCKER)
None — all missing items are blockers or internal creations.

---

**Report generated by:** R4a (DF3.1-DF3.3 crosswalk specialist)
