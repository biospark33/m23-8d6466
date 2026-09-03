# Blind Review: Primitive Chunk (src/fleet/fanout-primitive.ts)

## Findings

- [LOW] Redundant object spread in loser outcome classification — fanout-primitive.ts:757 — `outcomes[o.arm] = { ...o, outcome: "lostRace" }` spreads an object that is already an ArmOutcome (from line 742 `as ArmOutcome`), making the spread unnecessary since the object already has all properties
- [TRIVIAL] Verbose comment for simple non-null assertion — fanout-primitive.ts:640 — `const outcome = outcomes[arm] as ArmOutcome; // racing arms are settled and ready` comment explains an obvious type assertion
- [TRIVIAL] Verbose comment for skip-case — fanout-primitive.ts:690 — comment explains transport skip case which is self-evident from code
- [TRIVIAL] Verbose comment for deadline breach — fanout-primitive.ts:699 — comment explains deadline breach handling which is self-evident from error handling

## Passed Categories

- Semaphore/concurrency: Width calculation correctly clamps to MAX_FANOUT_CONCURRENCY and ensures minimum of 1; release() correctly hands off permit to next waiter without decrementing active
- finally-path: lock.release() in finally always runs; no double-release; acquire() throws before try on failure so release won't run for failed acquire
- Promise: allSettled used correctly; semaphore acquire/release in finally prevents leaks; forEach not used for async operations
- Race poller: ceiling check correct; undecided() recalculates after each arm removal; unusable tick counting correct; transport skips non-fatal; winner selection atomic under store lock
- Outcome collection: 1:1 correspondence between ids and outcomes by index; arm index preserved throughout; race loser handling preserves armFailed classification
- Money: F15 reconciliation calculates n * cap correctly before minting; reads issue budget snapshot; ledger close failure silenced appropriately
- Boundary: n validated 1-8 (2-8 for race/best-of-n); briefs.length validated equal to n for many-stories; rosterIds validated equal to n; cap validated positive integer; concurrency validated positive integer

## Summary

The primitive implementation is sound. Four low/trivial findings only — no BLOCKER, HIGH, or MEDIUM severity issues. The ordering contract is satisfied, the semaphore is correct, and the race poller handles all edge cases properly.
