# Fixer T1 Report: patterns.test.ts Hardening

## Summary
All findings addressed. Tests pass cleanly (41/41).

## Verdicts

| ID | Severity | Finding | Action | Verdict |
|----|----------|---------|--------|---------|
| T1a | LOW | Redundant assertion after `expect(peak).toBe(2)` | Deleted `expect(peak).toBeLessThanOrEqual(2)` | FIXED |
| T1b | LOW | n-boundary coverage rejection-side only | Added accept-side test for `best-of-n` at `FANOUT_MAX_N` | FIXED |
| T1c | LOW | Unknown-pattern refusal only asserts exit code | Added assertion for error message containing pattern name | FIXED |
| T1d | MEDIUM | Two tests flagged for determinism review | Both are deterministic; added explanatory comments | DOCUMENTED |

## Detailed Changes

### T1a: Redundant Concurrency Test Assertion
**Location:** `tests/fleet/patterns.test.ts:619-621`
**Before:**
```typescript
expect(peak).toBe(2);
// …and the bound held across every permit handoff.
expect(peak).toBeLessThanOrEqual(2);
```
**After:**
```typescript
expect(peak).toBe(2);
```
**Rationale:** The first assertion is exact; the second is redundant (`2 ≤ 2` is always true).

### T1b: Accept-Side n-Boundary Coverage
**Location:** `tests/fleet/patterns.test.ts:1349-1367`
**Action:** Added new test `best-of-n at the FANOUT_MAX_N edge admits and runs every arm (accept-side boundary coverage)` at line 1369.
**Test structure mirrors neighboring rejection tests:**
- Uses `FANOUT_MAX_N` directly
- Validates arms length, outcomes, distinct boxes
- Confirms fanout record integrity
- Unit-level: uses `RaceFakeDriver`, not live provider

### T1c: Unknown Pattern Error Message Assertion
**Location:** `tests/fleet/patterns.test.ts:338-342`
**Before:**
```typescript
test("rejects an unknown pattern", async () => {
  manifest();
  const err = await refuseOf(fanout("best-of-nn" as never, 2, brief(), deps()));
  expect(err.exitCode).toBe(2);
});
```
**After:**
```typescript
test("rejects an unknown pattern", async () => {
  manifest();
  const err = await refuseOf(fanout("best-of-nn" as never, 2, brief(), deps()));
  expect(err.exitCode).toBe(2);
  expect(err.message).toContain("best-of-nn");
});
```
**Rationale:** Strengthens test to verify the error message names the unknown pattern value.

### T1d: Determinism Review

#### (1) Race test with planted marker (line 747-778)
**Finding:** Test plants marker when `probeNumber === 2` and assumes specific arm wins.
**Analysis:** DETERMINISTIC. Sequential probing guarantees arm index 1 runs probe #2. The test already derives the winner from `plantedVm` rather than hardcoding an index.
**Action:** Added comment at line 750-753 documenting why the winner index is deterministic:
```typescript
// Deterministic winner: sequential probing guarantees arm index 1 runs
// probe #2, and we derive the winner from the planted marker rather than
// hardcoding an index.
```

#### (2) AC8 concurrent-race test (line 1476-1524)
**Finding:** Uses Promise.then barrier — need to verify determinism.
**Analysis:** DETERMINISTIC. The barrier is a Promise-based synchronization primitive that guarantees the loser attempts lock acquisition while the winner holds it. No wall-clock sleeps or timing-dependent logic.
**Action:** Added comment at line 1479-1483 documenting the deterministic barrier:
```typescript
// Deterministic barrier: the Promise.then synchronization guarantees
// the loser attempts lock acquisition while the winner holds it — no
// wall-clock races.
```

## Test Results

```bash
$ bun test tests/fleet/patterns.test.ts
bun test v1.4.0 (34cbb9a40)

 41 pass
 0 fail
 339 expect() calls
Ran 41 tests across 1 file. [17.85s]
```

- No flakes observed
- No ENOENT temp file issues
- No timeouts
- All assertions pass

## Coverage Notes

- **T1b addition** now provides accept-side coverage at `FANOUT_MAX_N` for both `many-stories` (existing) and `best-of-n` (new), complementing the existing rejection-side tests at `FANOUT_MAX_N + 1`
- **T1c** improves error validation coverage
- **T1d** comments document determinism guarantees without changing test behavior

## Biome Check

```bash
$ bunx biome check tests/fleet/patterns.test.ts
```
No output expected (tests were already biome-clean before edits).

---

**Agent:** fixer-T1
**Date:** 2025-01-25
**Commit:** None (do not commit)
