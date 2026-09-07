# Blind Review: fanout/lock tests chunk

## MEDIUM

### [MEDIUM] Lock mutual exclusion test is weak — barrier admits exactly two contenders, doesn't prove exclusivity
**File:** diff L1178-1202 (fanout.test.ts)

**Trigger:** The `barrier-forced concurrent race` test uses a Promise-based barrier to synchronize exactly two contenders (A and B). Both wait at `await bothProbed`, then both proceed. The test checks that B fails with fleet-busy, but this is a *serialized* observation: B's acquire() call runs *after* A has already announced "HELD". A true race would have both contenders inside `FleetLock.acquire()`'s critical section simultaneously, observing each other's concurrent attempts. The current implementation may pass even if the lock's mutual exclusion mechanism has a flaw that allows two holders to succeed when they arrive at different times. The test doesn't force the actual race condition — it forces a sequential loser-wins observation.

**Remedy:** Use subprocess spawning with no barrier, or use a subprocess that polls the lock file while another subprocess holds it, proving that acquisition fails only *while held*.

---

## LOW

### [LOW] Fleet ceiling test depends on JS event loop interleaving — true concurrency not guaranteed
**File:** diff L1521-1592 (dispatch.test.ts)

**Trigger:** The test "N concurrent dispatches on DISTINCT ids racing headroom admit exactly ONE" uses `Promise.allSettled([dispatch(...), dispatch(...)])` to create concurrent operations. In JavaScript's single-threaded event loop, this doesn't guarantee true parallelism — one coroutine could complete before the other even starts. The test relies on the `bothCommitted` barrier to force overlap, but the actual interleaving of the two async operations is scheduler-dependent. If the JS runtime serializes them (one reaches headroom, creates box, finishes; then the second starts), the test would still pass because the second would see the first's box and fail. This doesn't prove the race is *fixed* — it only proves that sequential ordering also yields correct behavior. A regression where the two dispatches *don't* overlap could still pass if the scheduling happens to serialize them.

**Remedy:** Use actual subprocess invocations (via `Bun.spawn`) to force true OS-level concurrency, or document the test's limitation as "in-process race only".

### [LOW] Date parsing in lock test doesn't verify rejection of malformed timestamps
**File:** diff L732-733 (fanout.test.ts)

**Trigger:** The test checks `expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false)` but only asserts that parsing *succeeds*. It doesn't test that malformed dates like `"not-a-date"` or `"2026-13-45"` are rejected. A lock body with an invalid `createdAt` could pass this test and potentially cause age calculation bugs downstream.

**Remedy:** Add a test that `acquire()` refuses a planted lock body with `createdAt: "invalid-timestamp"` and verify it throws before any age judgment occurs.

### [LOW] Lock release test validates orphan suffix but not cleanup
**File:** diff L1126-1147 (fanout.test.ts)

**Trigger:** The test checks that orphaned foreign bodies are parked with a non-.tmp suffix (to avoid garbage collection), but it doesn't verify that a *previous* orphan with .tmp suffix would be cleaned up. The test writes a stranger body, calls `release()`, and checks the orphan file. It doesn't test the cleanup path for old .tmp orphans that might accumulate over time.

**Remedy:** Add a test that plants an old .tmp orphan, then verify it's cleaned up (or document that .tmp orphans are cleaned by a separate sweep process).

## NO FINDINGS

The following areas were examined and found sound:
- **Record store validation**: Tests verify ENOENT propagation, EEXIST byte-identical preservation, malformed body refusal, winner index bounds checking
- **Lock classification matrix**: All 7 rows covered (young+live, young+dead, aged+dead, aged+alive-identity-match, aged+alive-start-mismatch, unreadable, out-of-range)
- **Fail-closed list()**: Test explicitly proves that an unreadable sibling .json throws and doesn't return partial results
- **Cleanup**: afterEach kills children and removes temp dirs
- **Sigint handling**: Real subprocess test proves release through signal-install seam
- **Reap mutex steal judgment**: Unit tests in fleet-lock.test.ts prove stale observation refusal, live holder protection, and recycled-pid theft
