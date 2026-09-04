# Blind Hunter Review: dispatch-rank Chunk

## BLOCKER

- [BLOCKER] LedgerLike signature change without verifying callers — src/fleet/dispatch.ts:10 — `LedgerLike` Pick added `issueBudgetSnapshot`. Any external fake ledger (tests, embedders) that implements the OLD signature now fails type-check at compile time OR fails at runtime when `assertWithinBudget` calls a missing method. The diff shows no verification that all callers provide the new shape.

## HIGH

- [HIGH] Unbounded admission tail deadlock on process termination — src/fleet/dispatch.ts:73-86 — If Node terminates the process WHILE inside `await held` (kill -9, out-of-memory, segfault), `release()` never executes and `admissionTail` is never reassigned. Every future in-process dispatch awaits a promise that never resolves. No recovery path exists; the process must restart.

- [HIGH] StampCorrelation timing drift — src/fleet/dispatch.ts:663 — The function is moved INSIDE the single-flight wrapper but called WITHOUT a lock on the store. Two concurrent dispatches in separate processes can both call `store.set(runId, { requestId })` simultaneously, causing lost updates (one overwrites the other). The diff shows no coordination for this write.

## MEDIUM

- [MEDIUM] Missing capMicroUsd validation — src/fleet/dispatch.ts:25 — `capMicroUsd?: number` accepts any number without validation. The comment says "positive-int-checked like --n" but no such check appears in dispatch.ts itself. Invalid values (negative, NaN, >MAX_SAFE_INTEGER) flow to `assertWithinBudget` which may mishandle them.

- [MEDIUM] EffectiveCeilingMicros guard redundancy — src/fleet/dispatch.ts:297-315 — The comment admits this guard is "UNREACHABLE from this call site" because `admitIssue` already refuses non-positive values. The guard exists to block "future change to any of those three" but provides no runtime protection if `assertWithinBudget` is bypassed or its contract changes.

- [MEDIUM] Tie rationale double-naming for single-arm case — src/fleet/rank.ts:1102-1105 — When `unscored.length === scores.length - 1` (exactly one scored arm), rationale says "only arm X has step output — no comparison possible" but then still prints "leads by more than 0.1" in the else branch for the same case (line 1108). The two messages cover overlapping conditions.

## LOW

- [LOW] Comment drift: orphan window margin attribution — src/fleet/dispatch.ts:293 — Comment says "the margin added in review round 4" but this is a new PR (pr128-r6). Either the comment is stale (refers to a different review) or the attribution is wrong.

- [LOW] Verb comment over-specificity — src/fleet/verbs.ts:21-24 — Comment says DF3.2's ONE exception to the `--driver` required rule is `rank`. But the same PR also adds `fanout` which takes `--driver`. "ONE exception" will be stale if more verbs are added.

- [LOW] Rank exit code comment precision — src/fleet/verbs.ts:1275-1276 — Comment "Still no 5" is precise now but fragile. If rank ever adds a refusal path (e.g., malformed input), this comment drifts.

## INFO

- [INFO] Single-flight scope documentation thorough — src/fleet/dispatch.ts:42-72 — The comment explicitly documents what IS closed (in-process) and what is DELIBERATELY left open (cross-process). This is good documentation practice.

- [INFO] Ponytail marker on unreachable guard — src/fleet/dispatch.ts:277 — Comment uses `// ponytail:` to mark deliberate redundancy. Makes the intent explicit for future maintainers.

- [INFO] Best-effort stamping documented — src/fleet/dispatch.ts:438-461 — The `stampCorrelation` doc comment thoroughly explains why it's best-effort and what the authoritative fix would be. Good documentation.
