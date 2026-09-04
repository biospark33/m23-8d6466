# Blind Review: patterns.test.ts

## [MEDIUM] Wall-clock sleep in concurrency test creates timing-dependent flake
**File: diff L618**
**Trigger**: Under CI load or CPU contention, the 10ms `setTimeout` may not complete before the next permit is acquired, causing `peak` to exceed 2 or the gate to resolve in an unexpected order.

```typescript
await new Promise<void>((resolve) => setTimeout(resolve, TICK_MS));
```

The test explicitly depends on `TICK_MS = 10` being sufficient for the semaphore to release and the next waiter to acquire. No deterministic synchronization mechanism exists - the test relies on wall-clock time.

## [MEDIUM] Generous timeouts (20s, 30s) hide timing-dependent bugs
**File: diff L970, L1016, L1205**
**Trigger**: If the actual race logic has a subtle bug that causes it to run longer than expected, the test will still pass (just take longer), masking the performance regression.

```typescript
}, 20_000); // the injected deadline alone is 2s
}, 30_000); // harvest's preflight spawns a REAL host git
```

These long timeouts suggest the tests are timing-dependent. A better approach would be to mock the time source or use deterministic synchronization (as some tests do with the `admitted` promise pattern).

## [MEDIUM] "GreaterThanOrEqual" assertions weaken test guarantees
**File: diff L1301, L1307, L1328, L1234**
**Trigger**: Implementation regression that causes fewer executions than expected would still pass these tests.

```typescript
expect(hungProbes).toBeGreaterThanOrEqual(4);
expect(skips.length).toBeGreaterThanOrEqual(2);
expect(unreadable.length).toBeGreaterThanOrEqual(1);
expect(lost.length).toBeGreaterThanOrEqual(1);
```

If the exact value is knowable and deterministic (which it appears to be given the forced interleaving), assert on the exact value. `toBeGreaterThanOrEqual` makes the test vulnerable to regressions that reduce the count.

## [LOW] Mock behavior may not fully represent real driver edge cases
**File: diff L133-171 (RaceFakeDriver)**
**Trigger**: Real driver has different failure modes or edge case behaviors that the fake doesn't replicate, causing tests to pass while production fails.

The `RaceFakeDriver` uses `FakeDriver` as a base and only overrides specific methods. If the real driver has additional behaviors (e.g., specific error codes, retry logic, state management), the fake won't catch regressions related to those behaviors.

## [LOW] Log sink shared state has no concurrent-write test
**File: diff L257**
**Trigger**: Multiple test processes writing to the same `entries` array could cause race conditions (though this appears to be single-process only).

```typescript
restoreLog = setLogSink((e) => entries.push(e));
```

The `entries` array is shared across all tests in the suite. While tests appear to run serially, there's no explicit test verifying that the log sink handles concurrent writes correctly if parallel execution is ever enabled.

## [LOW] Hard-coded timing constants could drift from production
**File: diff L1348-1351**
**Trigger**: Production constants change but test assertions don't get updated, causing false negatives.

```typescript
expect(MAX_FANOUT_CONCURRENCY).toBe(8);
expect(DEFAULT_POLL_INTERVAL_MS).toBe(5_000);
```

This test pins specific constant values. While this is intentional (INV-6), it creates maintenance burden - any production change to these defaults requires this test to be updated, even if the change is correct.

## [LOW] Probe counting at line 809 has weak assertion
**File: diff L809-814**
**Trigger**: The cost ledger gets called 0 times due to a bug, but the test might still pass if other assertions hold.

```typescript
expect(ingestCalls).toHaveLength(1);
```

Only one assertion validates that `ingestCalls` was populated. If the ingest logic fails silently (no error thrown, but no call made), the test might still pass based on the other assertions about `winner` and `outcome`.

## Note: Good patterns observed
- Temp dir cleanup in `afterEach` (L260-263)
- Deterministic synchronization using `admitted` promise (L1511-1513) - this is the right pattern
- Fresh state per test with `beforeEach`
- Proper use of `refuseOf` helper for error path testing
- Guard against shared host pidfile (L139-141)
