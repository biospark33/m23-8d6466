# DF3.2 Acceptance Audit Report (Round 5, Auditor 2)

**Spec:** `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-2-fanout-best-of-n.md`
**Implementation:** `src/fleet/` (fanout-primitive.ts, fanout.ts, fleet-lock.ts, rank.ts, verbs.ts, dispatch.ts) + `scripts/fleet.ts`
**Budget:** ~15 file operations (targeted grep + ≤80-line window reads)

---

## Findings

### [SEVERITY: LOW] Fanout extension schemaVersion is implicit, not explicit

**Spec ref:** AC9

**File:** `src/fleet/fanout-primitive.ts:773`

**Gap:** Spec states "each arm's DF2.1 run record carries `extensions.fanout = { schemaVersion: 1, fanoutId, arm }`". Implementation stamps only `{ fanoutId, arm: String(arm) }` (line 773), relying on `store.set()`'s validation layer (`run-record.ts:498-504`) to auto-inject `schemaVersion: 1` from `EXTENSION_NAMESPACES.fanout`. The AC is functionally satisfied (the record does carry schemaVersion:1 after write), but the stamp site itself does not explicitly include it per the spec's quoted shape. The store layer's auto-addition behavior is a cross-namespace convenience that makes all extension writes schemaVersion-implicit, not fanout-specific.

**Evidence:**
- Code: `store.set(runId, { extensions: { fanout: { fanoutId, arm: String(arm) } } });`
- Store layer adds `schemaVersion` in `validateExtensions`'s write path

**Assessment:** PASS functionally, but spec-vs-code divergence in implementation detail. No action required unless explicit literal compliance is demanded.

---

## AC Coverage Table

| ID | Status | Evidence |
|----|--------|----------|
| **AC1** | PASS | `fanout-primitive.ts:265-300`: one `checkHeadroom(N)` before mint, exit 5 on `!allowed` with headroom details |
| **AC2** | PASS | `fanout-primitive.ts:323`: each arm gets own `runId` → own `dispatch()` call → own box/key/record (dispatch handles isolation) |
| **AC3** | PASS | `fanout-primitive.ts:320-328`: all N ids minted via `mintRunId()` in sync loop BEFORE parallel `allSettled` |
| **AC4** | PASS | `dispatch.ts:2238-2270`: gate failure leaves box alive with evidence; `fanout-primitive.ts` lets other arms complete |
| **AC5** | PASS | `fanout-primitive.ts:614-635`: atomic first-writer `mutate()` with winner adoption; `disposeLosers` (669-683) tears down losers through DF2.5; polling bounded by `ceilingMs` (3_600_000) + per-call deadline (10_000); `LOSER_TEARDOWN_TIMEOUT_MS` (300_000) bounds teardown |
| **AC6** | PASS | `fanout-primitive.ts:259`: same `fanout()` primitive handles all patterns; degenerate N=1 case uses same path |
| **AC7** | PASS | `rank.ts:18-23`: `TEST_PASS_WEIGHT = 0.6`, `FILE_COVERAGE_WEIGHT = 0.4`, `TIE_DELTA = 0.1` (inclusive); line 41: breakdown has exactly two keys; line 91-94: divisor-guarded `testPassRate` |
| **AC8** | PASS | `fleet-lock.ts:380-396`: lock `acquire()` under O_EXCL; `reclaim()` checks both age (3_600_000) AND identity (`pidStartTime` match via `localMs === pidStartTime`) |
| **AC9** | PARTIAL | `fanout.ts:139-160`: fanout record created O_EXCL before first mint; `run-record.ts:149`: fanout namespace registered with `schemaVersion: 1`; `fanout-primitive.ts:773`: stamps `{ fanoutId, arm }` (schemaVersion added by store layer, not explicitly at call site) |
| **INV-1** | PASS | AC2 + dispatch per-arm isolation enforcement |
| **INV-2** | PASS | `fanout-primitive.ts:259`: `validatePatternInput` runs pre-construction; `scripts/fleet.ts:1410-1417`: `briefsOk` guards keyApi/store constructors |
| **INV-3** | PASS | `fanout-primitive.ts:336-347`: `aggregateExposureMicroUsd = n * cap` logged pre-dispatch; each arm gets own capped key via dispatch |
| **INV-4** | PASS | Dispatch mints per-arm keys; DF2.5 teardown includes revoke-then-verify |
| **INV-5** | PASS | `dispatch.ts:2238-2270`: gate failure leaves box alive; `fanout-primitive.ts:679-681`: per-arm failure doesn't abort siblings |
| **INV-6** | PASS | `fanout-primitive.ts:48-60`: `FANOUT_MAX_N = 8`, `DEFAULT_FANOUT_CEILING_MS = 3_600_000`, concurrency capped at `MAX_FANOUT_CONCURRENCY = 8` |
| **Round-4: bounded teardown** | PASS | `fanout-primitive.ts:81`: `LOSER_TEARDOWN_TIMEOUT_MS = 300_000`; line 702: applied in `disposeLosers` |
| **Round-4: lazy loser ledger** | PASS | `scripts/fleet.ts:1435-1460`: `loserLedger` is a first-use factory — CostLedger constructed only on first `ingestBoxHours` call |
| **Round-4: steps-json regular-file** | PASS | `scripts/fleet.ts:1608-1613`: `statSync().isFile()` guard before cap check and read; directories rejected with named refusal |

---

## Summary

**Total AC/INV items:** 18
**PASS:** 17
**PARTIAL:** 1 (AC9 — functional but implementation-detail divergence)
**FAIL:** 0

The implementation satisfies all functional requirements. The only gap is a documentation-level mismatch: AC9's quoted extension shape shows explicit `schemaVersion: 1` at the stamp site, but the implementation relies on the store layer's auto-injection. This is a cross-cutting convenience (all extension namespaces benefit from it) and does not affect the on-disk record shape, which does include `schemaVersion: 1` after `store.set()` processes the write.

All priority areas from the audit instructions are covered:
- INV-2 (cost ledger gated on every refusal path): verified via `briefsOk` guard at scripts/fleet.ts:1410-1417
- Round-4 claims: all three verified present
- Race first-writer semantics: atomic mutate with winner adoption at fanout-primitive.ts:614-635
- Rank tie-breaking contract: TIE_DELTA = 0.1 inclusive at rank.ts:23
