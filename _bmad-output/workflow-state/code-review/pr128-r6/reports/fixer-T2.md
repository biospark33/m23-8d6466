# T2 Fix Report — fanout.test.ts + rank.test.ts

**Agent**: fixer-T2
**Scope**: tests/fleet/fanout.test.ts, tests/fleet/rank.test.ts
**Context**: src/fleet/fleet-lock.ts gained fail-closed body validation (non-finite pidStartTime, empty requestId ⇒ unjudgeable ⇒ refuse). Verified that existing fixtures remain judgeable — no test modifications needed for that change.

## Fixes Applied

### T2a [LOW] — Corrected onDisk() helper comment
**File**: tests/fleet/fanout.test.ts:456
**Change**: Corrected comment from `dp:ok test-authored output: parses the lock body acquire() just wrote` to `reads implementation-written bytes: parses the lock body acquire() just wrote`
**Rationale**: The helper reads back what the implementation wrote, not test-authored content.

### T2b [LOW] — Hardened EEXIST test error handling
**File**: tests/fleet/fanout.test.ts:249-257
**Change**: Added `expect(thrown).toBeInstanceOf(Error);` before the code check
**Rationale**: Hardens error type assertion following the file's existing pattern (mirrors style elsewhere in the file).

### T2c [LOW] — Added explicit empty changedFiles test
**File**: tests/fleet/rank.test.ts:316-348 (new test)
**Change**: Added test case `"all arms with empty changedFiles → every arm scores 0, breakdown 0, tie (union denominator 0)"`
**Rationale**: Pins the cross-arm union behavior — when all arms have empty changedFiles, union size is 0, every arm's uniqueFileCoverage is 0, and scores are determined solely by testPassRate * 0.6. The test expects breakdown coverage 0, scores [0.6, 0.36, 0.12], and tie=false (delta > 0.1).

### T2d [LOW] — Documented lock-guarded mutate test limitation
**File**: tests/fleet/fanout.test.ts:285-304
**Change**: Added comment explaining why the per-record lock file existence cannot be asserted mid-mutate without invasive changes
**Rationale**: The lock path follows acquireRunLock's contract (`<dir>/<id>.lock`), but observing it inside the synchronous mutate() callback would require a separate thread or custom seam. The store's contract already guarantees mutual exclusion; the test verifies persistence.

## Verification
- **Test suite**: `bun test tests/fleet/fanout.test.ts tests/fleet/rank.test.ts` — 65/65 pass
- **Linting**: `bunx biome check` on both files — no issues
- **No body validation issues found**: All existing fixtures remain judgeable (no non-finite pidStartTime or empty requestId planted in test data)

## Notes
- Fleet-lock orphan warnings during test runs are expected behavior from foreign-body parking tests (T2d covers related test infrastructure).
