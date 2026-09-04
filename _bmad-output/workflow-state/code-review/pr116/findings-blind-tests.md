I'll read the diff chunk file to perform the blind adversarial review of the engine tests.
# Blind Hunter Review: Engine Tests (dispatch-task phase)

## BLOCKER

1. **dispatch-task.test.ts:254-258** - Regex vacuously matches confinement error. The `/worker/i` assertion alone passed when roster lived in tmpRoot because confinement error echoes the path (filename contains "worker"). The `not.toContain("outside the repo root")` negative control prevents this regression, but the `/worker/i` match still lacks a uniqueness pin — a different error mentioning "worker" would satisfy it.

2. **dispatch-task.test.ts:239-251** - Schema refusal test has false-pass path. If the roster path write fails (line 240), the test throws before reaching the assertion, and the `finally` cleanup runs but `result` is never assigned. The test passes via no-assertion, not a verified refusal.

3. **dispatch-task.test.ts:291-319** - Same false-pass pattern in one-role roster test. `writeFileSync` failure → throws before `expect` → `finally` cleanup → test passes vacuously.

4. **test-results.test.ts:2002-2027** - Env cleanup can corrupt the parent environment. If `prevAnthropic` is the empty string (falsy but not undefined), the `if (prevAnthropic === undefined)` guard fails and the key remains deleted after the test, leaking state to subsequent tests or the parent process.

## HIGH

5. **dispatch-task.test.ts:58-94** - Module-level mutable state (`traceLog`, `fakeTracer`) resets in `beforeEach` but if a test crashes mid-execution, `afterEach` never runs and state leaks to the next test. Flaky on CI where crashes are more likely.

6. **dispatch-task.test.ts:110-113** - `afterEach` cleanup swallows `rmSync` errors silently. If tmpRoot removal fails (permission denied, Windows file locks), the test passes but disk space leaks across the test run. Best-effort is fine for test isolation, but should log or increment a leaked-counter.

7. **test-results.test.ts:646-1646** - Same silent-cleanup pattern with `tmpRoot`. `afterAll` calls `rmSync` with `force: true`, but if the top-level removal fails, the test suite reports success while leaving a 700KiB+ temp dir on disk.

8. **roster-adapter.test.ts:791-801** - `tmpRoot` cleanup in `afterEach` swallows `readdirSync`/`rmSync` failures. If an entry is locked (Windows antivirus), the loop throws and the directory remains. Silent failures mask resource leaks.

9. **dispatch-task.test.ts:638-658** - Secret redaction test missing `changedFiles` coverage. The `successResult` at line 649 includes `changedFiles: ["src/a.ts"]`, but the test never asserts that a file *named after the secret* or *containing the secret in its path* gets redacted. A regression that skips redaction on `changedFiles` would pass all existing assertions.

10. **team-event-adapter.test.ts:1303-1315** - Fixture stream test doesn't assert that `adaptTeamEvent` was called. It creates a `makeStreamHealth` counter, calls `health.malformed()` inside a loop for null parse results, then asserts zero counters. But the actual adapter path is never exercised — the test only validates the counter mechanics, not the full parsing+adaptation flow.

## MEDIUM

11. **dispatch-task.test.ts:601-634** - Symlink test doesn't verify the `real.txt` file was actually read. The test creates `real.txt`, writes "legit", then validates that "legit" is included in results. But if `validateArtifacts` only checks existence (not content), a file named "real.txt" containing "EVIL" would pass. The assertion should pin content, not just inclusion.

12. **test-results.test.ts:1770-1782** - Jest parser test passes on wrong-line match. The fixture is `'Tests: 7 passed, 2 failed'` and the test expects `{ passed: 7, failed: 2 }`. If the parser regex mistakenly matched a different summary line (e.g., "Test Suites: 7 passed, 2 failed"), the assertion would still pass because both lines happen to have the same counts. The test should use asymmetric counts to prove it's parsing the Tests line.

13. **test-results.test.ts:1958-1970** - Output cap test has hardcoded byte count that's wrong for the cap. Comment says "~90 bytes/line × 8000 lines ≈ 720 KiB > 512 KiB cap", but `A` repeated 90 times is 90 bytes, so 90 × 8000 = 720,000 bytes ≈ 703 KiB. That's >512 KiB, so the cap SHOULD trigger, but the math is sloppy. If someone changes the cap constant, this test's comment misleads.

14. **dispatch-task.test.ts:216-260** - Five-worker roster test creates file in `fixtures/` dir but doesn't restore the fixtures directory state. If the test fails mid-execution, `.tmp-five-worker-roster.yaml` remains in the source tree and could break other tests that expect a clean fixtures directory.

15. **roster-adapter.test.ts:1033-1069** - The ">3 workers throws" test validates schema rejection but doesn't check the error message. A regression that changes the error to a soft refusal (returns null, logs a warning) would fail this test because it still throws, but the error message could be misleading. The test should assert the error contains "worker" or "max(3)" to pin the refusal reason.
# Blind Hunter Review: Engine Tests (dispatch-task phase)

## BLOCKER

1. **dispatch-task.test.ts:254-258** - Regex vacuously matches confinement error. The `/worker/i` assertion alone passed when roster lived in tmpRoot because confinement error echoes the path (filename contains "worker"). The `not.toContain("outside the repo root")` negative control prevents this regression, but the `/worker/i` match still lacks a uniqueness pin.

2. **dispatch-task.test.ts:239-251** - Schema refusal test has false-pass path. If `writeFileSync` fails (line 240), test throws before reaching assertion, `finally` cleanup runs but `result` never assigned. Test passes via no-assertion, not verified refusal.

3. **dispatch-task.test.ts:291-319** - Same false-pass pattern in one-role roster test. `writeFileSync` failure → throws before `expect` → `finally` cleanup → test passes vacuously.

4. **test-results.test.ts:2002-2027** - Env cleanup can corrupt parent environment. If `prevAnthropic` is empty string (falsy but not undefined), guard fails and key remains deleted after test, leaking state to subsequent tests or parent process.

## HIGH

5. **dispatch-task.test.ts:58-94** - Module-level mutable state (`traceLog`, `fakeTracer`) resets in `beforeEach` but if test crashes mid-execution, `afterEach` never runs and state leaks to next test. Flaky on CI.

6. **dispatch-task.test.ts:110-113** - `afterEach` cleanup swallows `rmSync` errors silently. If tmpRoot removal fails, test passes but disk space leaks across test run.

7. **test-results.test.ts:646-1646** - Same silent-cleanup pattern with `tmpRoot`. `afterAll` calls `rmSync` with `force: true`, but if top-level removal fails, suite reports success while leaving temp dir on disk.

8. **roster-adapter.test.ts:791-801** - `tmpRoot` cleanup in `afterEach` swallows `readdirSync`/`rmSync` failures. If entry locked (Windows antivirus), loop throws and directory remains. Silent failures mask resource leaks.

9. **dispatch-task.test.ts:638-658** - Secret redaction test missing `changedFiles` coverage. Fixture includes `changedFiles: ["src/a.ts"]` at line 649, but test never asserts that file *named after secret* gets redacted. Regression that skips redaction on `changedFiles` would pass.

10. **team-event-adapter.test.ts:1303-1315** - Fixture stream test doesn't assert `adaptTeamEvent` was called. Creates counter, calls `health.malformed()` for null parse results, asserts zero counters. Actual adapter path never exercised — validates counter mechanics, not parsing+adaptation flow.

## MEDIUM

11. **dispatch-task.test.ts:601-634** - Symlink test doesn't verify `real.txt` was actually read. Creates file with "legit", validates inclusion. If `validateArtifacts` only checks existence (not content), file named "real.txt" containing "EVIL" would pass.

12. **test-results.test.ts:1770-1782** - Jest parser test passes on wrong-line match. Fixture `'Tests: 7 passed, 2 failed'` expects `{ passed: 7, failed: 2 }`. If parser regex mistakenly matched "Test Suites: 7 passed, 2 failed", assertion still passes because both lines have same counts.

13. **test-results.test.ts:1958-1970** - Output cap test has hardcoded byte count wrong for cap. Comment says "~90 bytes/line × 8000 lines ≈ 720 KiB > 512 KiB cap", but `A` repeated 90 times is 90 bytes, so 90 × 8000 = 720,000 bytes ≈ 703 KiB. Math is sloppy; if cap constant changes, comment misleads.

14. **dispatch-task.test.ts:216-260** - Five-worker roster test creates file in `fixtures/` dir but doesn't restore fixtures directory state. If test fails mid-execution, `.tmp-five-worker-roster.yaml` remains in source tree and could break other tests expecting clean fixtures directory.

15. **roster-adapter.test.ts:1033-1069** - ">3 workers throws" test validates schema rejection but doesn't check error message. Regression that changes error to soft refusal (returns null, logs warning) would still fail test (throws), but error message could be misleading. Should assert error contains "worker" or "max(3)".
