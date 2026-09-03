# Round-7 S1 Fleet-Lock Fixer Report

## Summary
All four S1 findings fixed and verified. Tests pass (48/48), biome clean, tsc clean.

## Fixes Applied

### S1a [LOW] Negative `createdAt` timestamps
**Location:** `src/fleet/fleet-lock.ts:743-744`

**Problem:** `Date.parse` on negative timestamps (pre-1970 ISO dates like `1969-12-31T23:59:59.999Z`) returns negative millisecond values, causing huge age calculations and incorrect reclaim eligibility.

**Fix:** Added validation to reject negative or far-future timestamps before age calculation:
```typescript
if (!Number.isFinite(at) || at < 0 || at > Date.now() + 300_000) {
  return { verdict: "refuse", error: new FleetError(5, "fleet-busy", ...) };
}
```
The 5-minute slew covers realistic clock drift while catching malformed data.

**Test added:** Plant lock body with `createdAt: "1969-12-31T23:59:59.999Z"` → acquire refuses with `malformed createdAt` error.

### S1b [LOW] Negative `pidStartTime` values
**Location:** `src/fleet/fleet-lock.ts:679-680` (classifyHolder) and `:890` (stealJudgedReapMutex)

**Problem:** `Number.isFinite(parsed.pidStartTime)` accepts negative values, which are physically impossible for a process start time.

**Fix:**
1. `classifyHolder`: Added `parsed.pidStartTime >= 0` to the body shape validation guard
2. `stealJudgedReapMutex`: Extended the guard from `!Number.isFinite(parsed.pidStartTime)` to include `|| parsed.pidStartTime < 0`

**Test added:** Plant lock body with `pidStartTime: -1` → acquire refuses with `cannot judge` error.

### S1c [LOW] Far-future `createdAt` timestamps
**Location:** `src/fleet/fleet-lock.ts:743-744` (same fix as S1a)

**Problem:** Far-future timestamps (e.g., `now + 1 hour`) never age out and pass stale-checks silently, making locks permanently unreclaimable.

**Fix:** Combined with S1a fix — `at > Date.now() + 300_000` is treated as unjudgeable and refused.

**Test added:** Plant lock body with `createdAt: new Date(Date.now() + 3_600_000).toISOString()` → acquire refuses with `malformed createdAt` error.

### S1d [LOW] Signal restoration loop
**Location:** `src/fleet/fleet-lock.ts:~323-328`

**Problem:** The signal restoration loop (`for (const listener of others) process.on(sig, listener)`) has no error handling — one failure strands all remaining listeners.

**Fix:** Wrapped each listener restoration in try/catch:
```typescript
for (const listener of others) {
  try {
    process.on(sig, listener as () => void);
  } catch {
    // best-effort restoration only
  }
}
```

## Test Results

### Bun Test Suite
```
bun test v1.4.0
48 pass
0 fail
193 expect() calls
Ran 48 tests across 2 files. [23.47s]
```
All existing tests continue to pass. Three new tests added for S1a/S1b/S1c validations.

### Biome
```
Checked 3 files in 909ms. No fixes applied.
```
Clean: `src/fleet/fleet-lock.ts`, `tests/fleet/fleet-lock.test.ts`, `tests/fleet/fanout.test.ts`

### TypeScript (`tsc --noEmit`)
No errors reported for the modified files.

## Behavior Changes for Wave-2 Test Fixers

1. **Lock bodies with negative timestamps:** Now refused with `malformed createdAt` error instead of being reclaimed
2. **Lock bodies with far-future timestamps:** Now refused with `malformed createdAt` error instead of staying permanently busy
3. **Lock bodies with negative `pidStartTime`:** Now treated as unjudgeable and refused
4. **Signal handler restoration:** More robust — one failure no longer strands remaining listeners

All changes are fail-closed: they refuse rather than reclaim when timestamps are malformed, keeping the lock conservative.
