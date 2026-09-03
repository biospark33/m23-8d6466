# Blind Hunter Review — fanout-primitive.diff

## HIGH severity

### HIGH: race-lost cross-process has stale winner claim
- **File:** `src/fleet/fanout-primitive.ts:633`
- **Trigger:** Two processes poll concurrently; both call `store.mutate` (line 625) and see `rec.winner === null` (the write hasn't persisted or locking failed); both set `claimed = arm` and return it. The outer `runRace` (line 542) receives the winner and returns early (line 558) — the other process continues polling the now-decided race, because `outcomes[arm].outcome` is still "ready" (the classification at line 612 never ran).
- **Evidence:** The `claimed !== arm` guard handles "another writer won" case, but if file locking/serialization fails, BOTH processes see themselves as the winner and return their own arm index. The function exits (line 558) before the loser-branch (line 612) that would classify its own arm as `armFailed`, leaving `outcome: "ready"` on the losing process. The loser then continues polling until ceiling (line 539-563), holding the fleet lock while the winner's `disposeLosers` proceeds, extending lock hold time unnecessarily. If the losing process is the one that `finally`s the lock (line 385), the record closes with a `ready` arm that never transitioned to `lostRace`.
- **Comment:** The `dp:ok` tag on line 424 covers the function shape, but this is a logic gap, not a control-flow violation.

## MEDIUM severity

### MED: disposeLosers holds stale outcome references in race with runRace
- **File:** `src/fleet/fanout-primitive.ts:685-687`
- **Trigger:** `runRace` (line 369-373) calls `disposeLosers` with `entrants` computed BEFORE polling (line 372). During polling, `runRace` mutates `outcomes[arm]` for arms that fail (`armFailed`, line 612) or become unknown (line 546). `disposeLosers` builds its `entered` list by mapping over the NOW-STALE `entrants` array (line 685-687), reading `o.outcome` from the original `outcomes` snapshot. An arm that the poller reclassified to `armUnknown` AFTER `entrants` was captured but BEFORE `disposeLosers` reads it will be incorrectly included in teardown (line 686's filter checks `outcomes[arm]?.outcome !== "armUnknown"` against the NOW-MUTATED `outcomes`), violating the "never touch armUnknown boxes" invariant (line 684 comment).
- **Evidence:** The `entrants` array is captured at line 372 BEFORE `runRace` begins mutating `outcomes` (line 546, 612). By the time `disposeLosers` reads `outcomes[arm]?.outcome` at line 686, the value may have changed. The filter at line 686 reads the CURRENT state, but the iteration over `entrants` at line 685 iterates over a STALE list. If `runRace` sets `outcome: "armUnknown"` between line 372 and line 686, line 686's filter will correctly exclude it — but the `entrant` list itself is stale. This is a race between the poller's state transitions and the disposal filter.
- **Fix:** Pass `outcomes` directly to `disposeLosers` and compute entrants INSIDE the function (line 372's capture is the hazard).

### MED: semaphore drifts active above width on release handoff
- **File:** `src/fleet/fanout-primitive.ts:403-413`
- **Trigger:** A waiter is queued (line 401). `release` calls `waiters.shift()` (line 407) and invokes the resolve WITHOUT decrementing `active` (the early return at line 410). The woken waiter acquires (line 398), incrementing `active` to `width + 1`. The `release` that woke it never decremented. `active` now exceeds `width` until another `release` occurs without a waiter.
- **Evidence:** The contract at line 405 says "A permit hands off WHOLE," but the implementation only hands off when `waiters` is non-empty. The `release` path at line 412 (the decrement) ONLY runs when there are NO waiters. When there IS a waiter, `active` is NOT decremented (early return line 410), but the waiter increments it on acquire. This is correct for steady-state — the waiter replaces the releaser. BUT if a waiter is queued and released, then another thread calls `acquire` BEFORE the waiter wakes, the fast-path (line 398) increments `active` to `width + 1`. The `release` that handed off already returned without decrementing. `active` is now `width + 1` until a subsequent `release` brings it back down.
- **Fix:** Decrement `active` BEFORE waking the waiter, or track "handoff in flight" to reject fast-path acquires during handoff windows.

## LOW severity

### LOW: rmQuiet failure leaks temp files in probeArm
- **File:** `src/fleet/fanout-primitive.ts:648`
- **Trigger:** `probeArm` creates a temp file at `tmp` (line 600), reads it (line 604), and calls `rmQuiet(tmp)` in the `finally` block (line 648). `rmQuiet` ignores errors (by name). If `fs.unlink` fails due to permissions, EBUSY, or a virus scanner holding the file, the temp file is leaked to `/tmp`. Under high race fanout (N=8, all arms polling), `/tmp` accumulates `qds-fanout-*` files that never get cleaned up.
- **Evidence:** The `finally` block calls `rmQuiet` which suppresses errors. There's no retry mechanism, no fallback to `fs.rm`, and no "best-effort, log failure" path. Leaked temp files accumulate over time.
- **Fix:** Wrap `rmQuiet` in a `try/catch` and log a warning, or retry once after a short delay.

### LOW: undecided() recomputes inside loop condition
- **File:** `src/fleet/fanout-primitive.ts:539-540`
- **Trigger:** `runRace` loops while `undecided().length > 0` (line 539), then calls `undecided()` AGAIN to iterate (line 540). If the poller marks an arm as `armFailed` (line 612) between the condition check and the iteration start, the loop processes a stale set. The arm that just became decided gets processed again in the next tick — benign but inefficient.
- **Evidence:** The `undecided()` function (line 535) filters `outcomes` fresh on each call. The loop condition (line 539) calls it, then the `for` loop (line 540) calls it again. If an arm transitions between those two calls, the iteration processes a snapshot that's already stale. This is a race between the condition and the iteration.
- **Fix:** Assign `const current = undecided()` before the loop and iterate over `current`, or convert to a `do/while` with a fresh call on each iteration.

## Findings summary
- HIGH: 1
- MED: 2
- LOW: 2
