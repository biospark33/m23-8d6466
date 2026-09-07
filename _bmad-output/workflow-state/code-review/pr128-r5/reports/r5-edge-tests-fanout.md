# Edge Case Findings: fanout+rank tests

## [SEVERITY: MED] Vacuous time bounds check in readOwnPidStartTime test

- **File:** tests/fleet/fanout.test.ts:425-432
- **Trigger:** Test spawns a live child and checks observed start time is ≤ Date.now() and > Date.now() - 3_600_000_000
- **Evidence:** The test checks `expect(observed).toBeLessThanOrEqual(Date.now())` and `expect(observed).toBeGreaterThan(Date.now() - 3_600_000_000)`. These bounds depend on the system clock being correct. If the test runner's clock is skewed (NTP issues, VM clock drift, timezone changes), these assertions can fail even though the actual behavior (stable across calls, line 431) is correct. The source `readOwnPidStartTime` (fleet-lock.ts:123-125) simply reads the time from ps/procfs—it doesn't enforce these bounds.
- **Fix:** The Date.now() bounds are defensive sanity checks, but they're not guaranteed by the source implementation. Consider removing them or making them very loose (e.g., 10 years instead of 1 hour). The stability check (line 431) is the real invariant.

## [SEVERITY: LOW] Missing breakdown assertion for null-scored arms

- **File:** tests/fleet/rank.test.ts:1228-1249
- **Trigger:** Test checks an arm with no step output (score:null)
- **Evidence:** Test asserts `expect(res.scores[1]?.score).toBeNull()` and `expect(res.scores[1]?.runId).toBe("silent")` but does NOT assert on `breakdown`. Source rank.ts:251 returns `breakdown: {testPassRate: 0, uniqueFileCoverage: 0}` even for null-scored arms. The test never verifies this value is present/correct. The type signature enforces the field exists, but the test doesn't enforce its VALUE.
- **Fix:** Add `expect(res.scores[1]?.breakdown).toEqual({testPassRate: 0, uniqueFileCoverage: 0})` after the null score assertion.

## [SEVERITY: LOW] Missing boundary values for pid range check

- **File:** tests/fleet/fanout.test.ts:779-798
- **Trigger:** Test checks out-of-range pid refusal using pid=100_000_000_000
- **Evidence:** Source fleet-lock.ts:712 checks `!Number.isInteger(body.pid) || body.pid <= 0 || body.pid > 0x7fff_ffff`. The test uses 100 billion (way over the limit) but doesn't test the actual boundaries: pid=0, pid=1, pid=0x7fff_ffff (max valid), pid=0x7fff_ffff+1 (first invalid). These edge cases are not explicitly verified.
- **Fix:** Add assertions for pid=0 (refused), pid=1 (valid if other conditions met), pid=0x7fff_ffff (valid), and pid=0x80000000 (refused).

## [SEVERITY: LOW] Missing list() behavior in read-only mode

- **File:** tests/fleet/fanout.test.ts:400-411
- **Trigger:** Store opened with create:false
- **Evidence:** Test verifies create() and mutate() throw in read-only mode, but doesn't test list(). Source fanout.ts:207-227 shows list() doesn't check the writable flag—it only reads. list() should work in read-only mode (it's a read operation), but this isn't asserted. While list() is logically read-only, the test should verify it actually works.
- **Fix:** Add `expect(() => ro.list()).not.toThrow()` and verify it returns the expected records.
