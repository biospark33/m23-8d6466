# T4 Live E2E Test Fixes — Fixer Report

## Summary

Fixed both T4 test hardening issues in the live e2e test suite. T4a (concurrent teardown race) received a deterministic lock-contention barrier. T4b (teardown finally key leak) received best-effort revoke fallback using existing primitives.

## T4a [HIGH] — Concurrent Teardown Determinism (tier1-lock.live.test.ts)

**Finding:** The concurrent teardown test launched both subprocesses via `Promise.all` with no synchronization ensuring the first still holds the lock when the second contends. If the first completes before the second even attempts acquisition, both may "win" and the test flakes.

**Fix Applied:** Added a deterministic barrier that waits for the lock file (`<runId>.json.lock`) to appear before launching the contender subprocess. The lock file exists the instant `acquireRunLock` succeeds, providing reliable evidence that the first subprocess holds the lock.

**Implementation Details:**
- Launch first teardown subprocess (`a`)
- Poll for lock file appearance (max 5s, 50ms ticks)
- Throw if lock never appears (cannot test contention)
- Only then launch second subprocess (`b`)
- Await both results and test winner/loser invariants

**Pattern Matches:** Mirrors the tier1-fanout-refusal pattern where an external lock is held while the subprocess contends, but uses lock file polling instead of `FleetLock.acquire()` because we're testing the CLI's own run lock mechanism.

**Files Changed:**
- `tests/fleet/e2e/tier1-lock.live.test.ts` — barrier added, `existsSync` imported

## T4b [MEDIUM] — Teardown Finally Key Leak (tier1-teardown.live.test.ts)

**Finding:** The finally block destroys the box but has no key-revoke fallback when the teardown verb fails mid-chain. The minted OpenRouter key can stay live, costing money.

**Fix Applied:** Added `revokeQuietly` helper in live-harness.ts that calls the existing `revokeRunKey` primitive (the same one teardown uses) with best-effort semantics. The finally block calls it only when `teardownSucceeded === false && keyWasMinted === true`.

**Why This Works:**
- `revokeRunKey` is already exported from `src/providers/credentials.ts`
- It performs the full lifecycle: prefix reassert → DELETE → list verification
- No new API — just the belt-and-braces fallback that teardown already provides
- Guarded by `keyHash` presence in the record: no key = no-op
- Errors logged to stderr + evidence, never thrown (must not mask test result)

**Implementation Details:**
- Export `revokeRunKey` from credentials.ts (already exported)
- Import `revokeRunKey` in live-harness.ts
- Create `revokeQuietly(driver, store, runId, evidence)` helper
- Track `keyWasMinted` and `teardownSucceeded` flags in test
- Call `revokeQuietly` in finally only when needed
- Helper logs failures to stderr and appends to evidence, never throws

**Alternative Considered:** Direct HTTP DELETE to OpenRouter. Rejected because `revokeRunKey` already exists and includes critical safety checks (prefix reassert, list verification, logging). Using it is simpler and safer than re-implementing the DELETE without those guards.

**Files Changed:**
- `tests/fleet/e2e/live-harness.ts` — `revokeQuietly` helper, import `revokeRunKey`
- `tests/fleet/e2e/tier1-teardown.live.test.ts` — flags added, revoke call in finally, import `revokeQuietly`

## Verification

Both tests verify cleanly without env vars (skip path):
```bash
bun test tests/fleet/e2e/tier1-lock.live.test.ts tests/fleet/e2e/tier1-teardown.live.test.ts
# 0 pass, 2 todo, 0 fail
```

Biome check passes on all edited files:
```bash
bunx biome check tests/fleet/e2e/tier1-lock.live.test.ts tests/fleet/e2e/tier1-teardown.live.test.ts tests/fleet/e2e/live-harness.ts
# Checked 3 files. No fixes applied.
```

No side effects in skip path: both tests return `test.todoIf(liveTodoOff())` which skips when `QDS_E2E_LIVE !== "1"`. The new barrier and revoke logic only executes inside the test body, so the skip path is unchanged.

## Risk Assessment

- **T4a:** Low risk. Barrier only adds a wait before launching the second subprocess. The lock file appears reliably when `acquireRunLock` succeeds (same primitive used by fleet.ts). Timeout of 5s is generous for file creation; if it never appears, we fail fast with a clear error rather than flaking.
- **T4b:** Low risk. `revokeQuietly` is a best-effort finally cleanup. It uses the same `revokeRunKey` that teardown uses, so behavior is identical. Errors are caught and logged, never thrown. No new API surface, just better cleanup on unhappy paths.

## Notes

- T4a's barrier is minimal: poll for file existence. More complex barriers (promises, events) would be overkill for this use case. File existence is sufficient evidence that the lock is held.
- T4b's `revokeQuietly` could be reused by other live tests that mint keys and need finally cleanup. It's generic (accepts `driver`, `store`, `runId`) and follows the same pattern as `destroyQuietly`.
- Both fixes align with the e2e suite's philosophy: test the real behavior, but add deterministic synchronization and robust cleanup where the raw behavior could flake or leak.
