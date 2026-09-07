# Blind Hunter Review: fanout-rank Tests

## BLOCKER Findings

- [BLOCKER] Tests O_EXCL create without concurrent execution — tests/fleet/fanout.test.ts:248-263 — The EEXIST "stamp-skip primitive" test only verifies sequential duplicate creates. It does NOT test O_EXCL under actual concurrent load where two processes race to create the same file. Without a concurrent test, the O_EXCL guarantee (EEXIST propagates, body byte-identical) is not proven to hold under real race conditions. Spawn two processes that both call create() on the same fanoutId simultaneously and verify exactly one succeeds and the other gets EEXIST with unchanged file content.

- [BLOCKER] Tests "lock-guarded" mutate without proving lock is held — tests/fleet/fanout.test.ts:291-298 — Test name claims "lock-guarded" but only verifies the end result (mutation persisted). No assertion proves a lock file exists during mutation, or that concurrent mutations are serialized. The test would pass even if mutate() did NO locking at all. Add a check that the lock file exists during the mutation callback, or test concurrent mutations to verify serialization.

- [BLOCKER] Barrier-forced race only tests one pattern, not true concurrency — tests/fleet/fanout.test.ts:925-949 — The "exactly one contender admits" test only spawns contenders sequentially with a barrier (A acquires, then B starts). This proves sequential acquisition works but NOT that the mutex handles true concurrent load. Test N>2 processes spawned simultaneously (no barrier) that all race to acquire the same lock and verify exactly one wins.

## HIGH Findings

- [HIGH] Float precision test implementation detail, not business logic — tests/fleet/rank.test.ts:1080 — `toBeCloseTo(1 / 3, 10)` with precision 10 tests IEEE 754 representation, not the coverage formula itself. The expected value `1/3` computed in the test uses the same floating-point math as the implementation, creating circular validation. Use pre-computed literal 0.333... at 6 decimals (matching scoring precision) or verify denominator/numerator logic directly.

- [HIGH] Exact regex prefix on error message is fragile — tests/fleet/fanout.test.ts:344 — `expect(err?.message).toMatch(/^malformed fan-out record /)` will fail on trivial message format changes (capitalization, wording). The test needs to verify the error is thrown, not police its exact phrasing. Use `toContain("malformed")` or `toContain("arms")` to test substance over format.

- [HIGH] Score precision at 6 decimals tests float arithmetic, not formula — tests/fleet/rank.test.ts:1051-1053 — `toBeCloseTo(0.72, 6)` verifies the computed value is within 10^-6 of expected, but the expected `0.72` is computed as `0.7 * 0.6 + 0.75 * 0.4` using the same arithmetic as the implementation. This tests floating-point evaluation consistency, not that the scoring formula is correct. Parse the breakdown values and assert `score === testPassRate * 0.6 + uniqueFileCoverage * 0.4` directly.

## MEDIUM Findings

- [MEDIUM] Misleading "test-authored output" comment on implementation-written data — tests/fleet/fanout.test.ts:463 — The `onDisk()` helper has comment `dp:ok test-authored output` but reads back what `acquire()` wrote, not test-authored data. The comment suggests dataflow suppressant for test-authored JSON but this is implementation output. Remove or correct the comment.

- [MEDIUM] Error type assertion weak — tests/fleet/fanout.test.ts:261-262 — Casting to `NodeJS.ErrnoException` and checking `.code` property could give false positives if any non-ErrnoException happens to have a `code: "EEXIST"` property. Verify `err instanceof Error` or the specific custom error type before checking errno.

- [MEDIUM] TmpRoot created once at module scope — tests/fleet/fanout.test.ts:168 — `tmpRoot` is created with `mkdtempSync` at module load time. While the random suffix and `afterAll` cleanup mitigate cross-test pollution within this file, parallel test suites across files could theoretically collide. Move to `beforeAll` or add additional uniqueness (process.env.TEST_RUN_ID).

- [MEDIUM] Zero denominator tested but not zero-file union edge — tests/fleet/rank.test.ts:1245-1272 — Tests `testsExecuted:false`, `null testResults`, and `passed+failed===0` all yielding score 0. However, the case where ALL arms have empty `changedFiles` (union size 0, denominator 0) is only incidentally covered because the fixture also has `changedFiles: []`. Add explicit test for union-of-empty → coverage 0 with rationale mentioning "no files to cover".

## LOW Findings

- [LOW] Circular float comparison in coverage union test — tests/fleet/rank.test.ts:1080 — Both test and implementation compute `1/3` using IEEE 754, then compare with high precision. This proves they compute the same value, not that the value is correct. Use a pre-computed constant or verify the Set union size logic directly.

- [LOW] K6 straddle test could be more explicit about both directions — tests/fleet/rank.test.ts:1218-1243 — The "raw delta BELOW 0.1 the other way" test at line 1218 is valuable but could be clearer that it's proving the strangle works both ways. Comment is good; consider asserting `Number((0.5 - 0.4).toFixed(10))` explicitly to document the symmetric proof.

- [LOW] No test for atomicReplace crash window — tests/fleet/fanout.test.ts:291-298 — The mutate test verifies persistence but doesn't test the crash window between read and write. While hard to test deterministically, a comment acknowledging the limitation or a TODO for a fault-injection test would signal awareness.

- [LOW] SIGINT test timeout at 30s may hide flakiness — tests/fleet/fanout.test.ts:923 — The SIGINT test has a 30s timeout (`}, 30_000`). If the child doesn't exit cleanly on SIGINT, the test hangs until timeout. Add a shorter expect around the exit verification or add a SIGKILL fallback if the child doesn't exit within expected time.

## INFO Findings

- [INFO] Good: Date.now spyOn used for exact boundary test — tests/fleet/fanout.test.ts:590 — Correctly uses `spyOn(Date, "now")` to freeze time for the exact FLEET_LOCK_STALE_MS boundary test, avoiding timing flakiness.

- [INFO] Good: Barrier pattern in concurrent test — tests/fleet/fanout.test.ts:933 — The "HELD" line barrier correctly proves the critical section is occupied before spawning the second contender, avoiding race-condition flakiness in the test itself.

- [INFO] Good: Raw delta assertion proves K6 trap — tests/fleet/rank.test.ts:1184 — The assertion `expect(rawDelta).toBeGreaterThan(0.1)` explicitly proves the IEEE-754 rendering trap exists before verifying the normalization rescue, making the test self-documenting.

- [INFO] Good: Null arms element refused with named field — tests/fleet/fanout.test.ts:331-346 — Test correctly verifies that `null` in the `arms` array triggers the "malformed" error with the field name "arms" in the message, not a generic "Cannot read properties of null".

- [INFO] Good: afterAll cleanup for tmpRoot — tests/fleet/fanout.test.ts:170 — Correctly cleans up the temp directory after all tests complete, avoiding disk pollution.

- [INFO] Good: Dedup test for changedFiles — tests/fleet/rank.test.ts:1084-1096 — Explicitly tests that duplicate file entries within one arm's list are counted once, verifying the Set-dedup behavior.

- [INFO] Good: Negative count refusal test — tests/fleet/rank.test.ts:1414-1432 — Tests that negative `passed` counts are refused before they can corrupt scoring, preventing "negative pass rate" bugs.

- [INFO] Good: Non-array changedFiles refused — tests/fleet/rank.test.ts:1434-1458 — Tests that a bare string or other non-array for `changedFiles` is refused rather than iterating per-character and poisoning the union.
