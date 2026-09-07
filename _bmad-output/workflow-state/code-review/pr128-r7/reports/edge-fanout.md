# Edge Case Review: Fanout PR

Findings confirmed against real source files.

---

## [MEDIUM][RISK] Orphaned fan-out record if process crashes between create() and arms mutate

**file:** src/fleet/fanout-primitive.ts:348-382

**Trigger scenario:** Process crash (SIGKILL, power loss) after `store.create()` writes a record with `arms:[]` but before the `store.mutate()` that fills in the minted run IDs. The record persists on disk with zero arms.

**Evidence:**
```typescript
// fanout-primitive.ts:351-362
store.create({
  fanoutId,
  requestId: deps.requestId,
  pattern: input.pattern,
  n,
  pin,
  createdAt: now().toISOString(),
  arms: [],  // ← Empty here
  winner: null,
  rankedAt: null,
  closedAt: null,
});

// fanout-primitive.ts:365-377 - if crash happens here, arms stays empty forever
const tMint = mono();
const ids: MintedRunId[] = [];
for (let i = 0; i < n; i++) ids.push(mintRunId());
store.mutate(fanoutId, (rec) => ({
  ...rec,
  arms: ids.map((runId, i) => ({
    arm: i,
    runId,
    ...(input.rosterIds?.[i] !== undefined ? { rosterId: input.rosterIds[i] as string } : {}),
    briefHash: createHash("sha256").update(JSON.stringify(input.briefList[i])).digest("hex"),
  })),
}));
```

**Impact:** Record will have `n` set (e.g., 3) but `arms.length === 0`. `fanout list()` will return it (validation accepts empty arms - fanout.ts:1169-1172 explicitly allows "arms:[] is LEGITIMATE"). `rank` will accept it (rank.ts:240-242 produces "no ranked arms" message but doesn't throw). Race mode returns null winner silently. Operator has a zombie fan-out that never completes.

---

## [MEDIUM][RISK] rank.ts allows testResults with testsExecuted:false to contribute to score

**file:** src/fleet/rank.ts:91-95

**Trigger scenario:** Step output has `{testsExecuted: false, testResults: {passed: 5, failed: 0}}`. The validation at rank.ts:117 allows this (`testsExecuted !== undefined` only blocks non-boolean values). But `testPassRate` at rank.ts:92 explicitly gates on `testsExecuted === true`, returning 0 for false. However, the presence of `testResults` with non-zero counts while `testsExecuted: false` is contradictory state - if tests didn't execute, how can there be results? The function silently treats it as 0 pass rate rather than refusing.

**Evidence:**
```typescript
// rank.ts:117 - validation only checks type, not semantic consistency
if (out.testsExecuted !== undefined && typeof out.testsExecuted !== "boolean") {
  throw new FleetError(...);
}

// rank.ts:91-95 - gates on true only
function testPassRate(out: ArmStepOutput): number {
  if (out.testsExecuted !== true || !out.testResults) return 0;
  const total = out.testResults.passed + out.testResults.failed;
  return total > 0 ? out.testResults.passed / total : 0;
}
```

**Impact:** Semantically invalid data flows through as 0 score rather than being refused. An arm with `{testsExecuted: false, testResults: {passed: 100, failed: 0}}` would score 0 instead of throwing an error about contradictory state.

---

## [LOW][NIT] Race winner selection is order-dependent, not deterministically specified

**file:** src/fleet/fanout-primitive.ts:573-605

**Trigger scenario:** Multiple race arms complete in the same poll iteration. The arm with the lowest index wins because `undecided()` returns arms in index order and the loop iterates forward. This is not documented as a deliberate tie-breaking rule.

**Evidence:**
```typescript
// fanout-primitive.ts:573-574
const undecided = (): number[] => outcomes.filter((o) => o.outcome === "ready").map((o) => o.arm);

// fanout-primitive.ts:579-605 - iterates undecided[] in order
for (const arm of current) {
  const verdict = await probeArm(deps, store, fanoutId, outcomes, arm, markerPath, deadlineMs);
  // ...
  if (verdict !== null) return verdict; // ← First successful probe wins
}
```

**Impact:** In multi-way ties, lower arm indices have advantage. Not a bug (race has no specified tie-breaking), but the implicit bias toward arm 0 is not documented.

---

## Clean Areas Verified

### FanoutRecordStore Validation
- **null vs undefined vs missing:** validateFanoutRecord (fanout.ts:300-345) correctly distinguishes all three states:
  - `pin`: allows `null | string`, rejects `undefined` and empty strings (line 309 checks `r.pin !== null && typeof r.pin !== "string"`)
  - `rankedAt/closedAt`: allow `null | undefined | string` (line 339-342 checks `v !== null && v !== undefined`)
  - `arms`: must be array, null rejected (line 308)
  - `arms elements`: null rejected (line 319-320)
- **Concurrent writers:** mutate() uses per-record lock via acquireRunLock (fanout.ts:1019-1040), atomic read-modify-write, validated on both read and write
- **Write atomicity:** atomicReplace (fanout.ts:1082-1102) uses temp + rename, EEXIST propagation prevents overwrite
- **Growth bounds:** list() throws fail-closed on any unreadable file (fanout.ts:1048-1067), preventing silent partial listings

### Union-of-outputs (rank.ts)
- **All arms changedFiles empty:** Handled - line 256 checks `union.size === 0`, returns 0 coverage
- **Duplicate keys across arms:** Set-deduped on both sides (rank.ts:227-234 builds union with `Set.add()`, rank.ts:256 builds coverage with `new Set()`)
- **Arm output non-string:** changedFiles validated (rank.ts:153-155) - must be array of strings or undefined
- **Huge outputs:** No explicit bound, but handled by JSON.parse memory limits

### Lock-guarded Mutation
- **Lock acquisition failure:** Uses run-lock's acquireRunLock which throws on failure (fanout.ts:1028, fanout.ts:187), so lock.bypass is impossible - failures abort before mutation
- **Double-release:** Finally block (fanout.ts:196-198) guarantees release even if mutation throws

### best-of-N Edge Cases
- **N=0:** Blocked at validation (fanout-primitive.ts:165-173) - minN is 1 for many-stories, 2 for best-of-n/race
- **N=1:** Handled - validation allows 1 for many-stories, mint loop runs once (line 367)
- **N>arms:** N is arms count - no N > arms possible by construction
- **Ties in scores:** isTie (rank.ts:166-171) correctly identifies ties within TIE_DELTA inclusive boundary
- **All arms failed:** buildRationale (rank.ts:177-181) produces "no step-output source" message, returns all null scores
- **testResults shape lies:** See MEDIUM finding above - accepts contradictory state

### Race Pattern
- **Determinism:** See LOW finding above - order-dependent but not specified otherwise
- **Loser ledger writes:** disposeLosers (fanout-primitive.ts:724-778) only writes ledger if costLedger is injected (line 746), fails logged per-arm (line 764-773), one failure doesn't abort siblings

### Cross-module Contract
- **fanout.ts imports from fanout-primitive.ts:** No circular imports - primitive imports store (line 42), store doesn't import primitive
- **Type assertions:** Only dp:ok validate-then-cast after exhaustive validation (fanout.ts:1185, rank.ts:263 clamps to [0,1])
- **rank.ts consumption:** Correctly consumes FanoutRecordView interface (rank.ts:57-62) which is minimal shape, no direct coupling to FanoutRecord
