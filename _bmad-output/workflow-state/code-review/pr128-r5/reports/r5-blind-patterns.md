# Blind Hunter Review: Fleet Patterns + CLI (Round 5)

## Contract Mismatches

**NONE FOUND**

The CLI-to-primitive contract is coherent:
- `capMicroUsd` flows from CLI → DispatchDeps → assertWithinBudget (scripts/fleet.ts:564-566, dispatch.ts:828-831)
- `costLedger` injection path preserved through seam extraction (scripts/fleet.ts:330-334, 522-524, 566)
- `fanoutsDir`/`lockPath` forwarded verbatim (scripts/fleet.ts:525-526, 568-569)

## Race Conditions

**NONE FOUND**

Winner selection is atomic:
- Race winner decision guarded by per-record lock in FanoutRecordStore.mutate() (fanout.ts:1019-1040)
- acquireRunLock provides the mutex; loserLedger only charges losers AFTER winner decided (scripts/fleet.ts:532-558, 562-567)
- Losers run concurrently but teardown serializes through the ledger - no double-booking

Polling loop absent: race uses primitives (no poll loop visible in diff).

## Error Path Bugs

**NONE FOUND**

Error classification honors the contract:
- `transientRefusal` captured from FleetError.exitStatus, propagated through finish() (scripts/fleet.ts:628, 657)
- Auto-rank failure degrades to stderr warning, never flips a successful fanout to failure (scripts/fleet.ts:606-614)
- Ledger close failure guarded, only upgrades exit code from 0→6, never overwrites an arm failure (scripts/fleet.ts:638-650)
- ENOENT typed in readFanoutRecord, maps to exit 4 (fanout.ts:1194-1197)

## Cost Ledger Bugs

**NONE FOUND**

Lazy construction is correct:
- `loserLedger` built only for race pattern and only when `injectedCostLedger === undefined` (scripts/fleet.ts:532)
- Construction deferred to first `ingestBoxHours` call - no SQLite file created on pre-admission refusal (scripts/fleet.ts:536-551)
- close() before first use is no-op, finally safe (scripts/fleet.ts:538-556)

No double-booking path: ledger only used by teardown path, which runs once per loser.

## Teardown Ordering

**NONE FOUND**

Cleanup in finally precedes return:
- `loserLedger.close()` called before `finish()` returns (scripts/fleet.ts:638-650)
- Same posture as dispatch's ledger closing (invoked in its own finally block)

## Boundary Conditions

**NONE FOUND**

All-fail: `fanoutCode` becomes 1 (setupFailed/armFailed/armUnknown collected) - correct (scripts/fleet.ts:621-625)

No candidates: rank returns rationale "no ranked arms", scores empty - advisory only (rank.ts:1491-1493)

Tie scores: `isTie` implements inclusive delta check with proper IEEE-754 taming (rank.ts:1416-1422)

Empty briefs: ingestedBriefJson throws before construction (scripts/fleet.ts:87-134, 412)

Zero-width roster: refused with min-N message (scripts/fleet.ts:440-447)

## Names That Lie

**NONE FOUND**

Function names match their behavior:
- `makeLedgerFactory` returns a factory function (scripts/fleet.ts:144)
- `readFanoutForRank` returns null on ENOENT (scripts/fleet.ts:168-175)
- `loserLedger` is only used for race losers (scripts/fleet.ts:532)
- `ingestBriefJson` parses after reading (scripts/fleet.ts:87)

## Unit Confusion

**NONE FOUND**

Micro-dollar units consistent:
- `capMicroUsd` validated as positive integer, compared against FANOUT_MAX_N is separate (scripts/fleet.ts:395-405)
- DispatchDeps.capMicroUsd comment explicitly states "integer micro-dollars" (dispatch.ts:812)

Time units:
- `durationMs` computed from `Date.now()` diff (scripts/fleet.ts:200)
- `rankMs` from `performance.now()` (rank.ts:1459, 1533)

## Exit Code Semantics

**NONE FOUND**

Exit codes match verbs.ts declarations:
- fanout: [0, 1, 2, 5, 6] (verbs.ts:1594) - covers success, collected failure, validation, admission, output failure (scripts/fleet.ts:621-625, 648)
- rank: [0, 1, 2, 4, 6] (verbs.ts:1619) - covers success, substrate, validation, not-found, output failure (rank.ts:1462-1468, scripts/fleet.ts:793)

Output incompleteness (exit 6) folded into finish() correctly (scripts/fleet.ts:225).

## Known dp:ok Annotations Verified

All verified as genuinely safe:
- scripts/fleet.ts:125 - JSON.parse catch maps to FleetError, validated below
- scripts/fleet.ts:777 - shape-checked field-by-field against ArmStepOutput
- fanout.ts:1185 - validate-then-cast after exhaustive field checks
- rank.ts:1383-1394 - testResults null guard prevents TypeError on .passed/.failed access

## Summary

**No defects found.** The diff shows disciplined defensive programming: lazy construction, correct error classification, atomic mutations under lock, and proper boundary handling.
