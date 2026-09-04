# PR 128 Round 5 — Triage Ledger

Date: 2026-08-24. Reviewers: 9 spawned (2 died on context: edge-tests-patterns, auditor — replaced by patternsA/patternsB halves + auditor2 slim retry). 9 reports collected.

## Verdict summary

- **patch: 12** (2 source, 10 test)
- **decision_needed resolved conservatively: 1** (AC9 — no code change)
- **defer: 0**
- **dismiss: 11** (all verified against source before dropping)

## Patch findings

| ID | Sev | Title | Location | Source | Wave |
|----|-----|-------|----------|--------|------|
| P1 | MED | Reap-mutex steal-success path retries claim without tick sleep — CPU spin window (bounded by deadline) | src/fleet/fleet-lock.ts:561-564 | blind-lock | 1 |
| P2 | LOW | `undecided()` called twice per poll iteration (condition + loop) — hoist to const | src/fleet/fanout-primitive.ts:534-536 | blind-primitive | 1 |
| P3 | LOW | Test title says "scored table" but test has no --steps-json (all scores null) — retitle | tests/fleet/cli.test.ts:246 | edge-tests-cli | 2 |
| P4 | LOW | No explicit `--n 0` boundary refusal test | tests/fleet/cli.test.ts | edge-tests-cli | 2 |
| P5 | LOW | No empty `{}` --steps-json test (valid, all arms unscored) | tests/fleet/cli.test.ts | edge-tests-cli | 2 |
| P6 | LOW | Comment says "1 MiB + ~12 bytes"; JSON wrapper overhead is 9 bytes — fix arithmetic | tests/fleet/cli.test.ts:694 | edge-tests-cli | 2 |
| P7 | MED | readOwnPidStartTime test bounds on Date.now() — clock-skew flake source; loosen (stability check is real invariant) | tests/fleet/fanout.test.ts:425-432 | edge-tests-fanout | 2 |
| P8 | LOW | Missing breakdown assertion for null-scored arm ({testPassRate:0, uniqueFileCoverage:0}) | tests/fleet/rank.test.ts:1228-1249 | edge-tests-fanout | 2 |
| P9 | LOW | pid range test uses only 100_000_000_000; add boundary values 0 and 0x8000_0000 refusals | tests/fleet/fanout.test.ts:779-798 | edge-tests-fanout | 2 |
| P10 | LOW | read-only store: list() works but never asserted | tests/fleet/fanout.test.ts:400-411 | edge-tests-fanout | 2 |
| P11 | LOW | Validation suite tests rejections only; add many-stories n=1 positive case | tests/fleet/patterns.test.ts:344-354 | edge-tests-patternsA | 2 |
| P12 | LOW | No test forces a rank tie in best-of-N (isTie logic round-2 hardened, unpinned) | tests/fleet/patterns.test.ts | edge-tests-patternsB | 2 |

## Decision-needed → resolved

| ID | Finding | Resolution | Rationale |
|----|---------|------------|-----------|
| D1 | AC9 PARTIAL: spec quotes `extensions.fanout = { schemaVersion: 1, fanoutId, arm }` but stamp site writes `{ fanoutId, arm }`; store layer auto-injects schemaVersion (run-record.ts validateExtensions) | **No code change** (conservative) | On-disk shape matches spec exactly. schemaVersion injection is the store's cross-namespace contract — every extension write is implicit; making one call site literal diverges from the established pattern. Auditor: "No action required unless explicit literal compliance is demanded." Surfaced in PR comment. |

## Dismissed (verified before drop)

| ID | Finding | Source | Dismissal evidence |
|----|---------|--------|--------------------|
| X1 | HIGH: fleetUnwinding TOCTOU on double SIGINT | blind-lock | `onSignal` is fully synchronous (fleet-lock.ts:266-278, no awaits); Node delivers signals serialized through the single-threaded event loop — second handler invocation sees flag=true. No interleave window. |
| X2 | HIGH: listener re-add removes other signals' handlers | blind-lock | `process.listeners(sig)` (line 271) returns same-signal listeners only; each sig has its own closure. Cross-sig removal impossible. Borrow-strip-reraise documented at 256-261. |
| X3 | MED: disposeLosers stale entrants race | blind-primitive | Filter at fanout-primitive.ts:680 reads CURRENT outcomes — armUnknown arms excluded correctly. Reviewer's own evidence concedes this. Single-threaded, no mutation between filter and use. |
| X4 | MED: semaphore active drifts above width | blind-primitive | Woken waiter resumes after `await` without calling acquire() again; only the fast path increments (gated `active < width`). Handoff-whole design documented at fanout-primitive.ts:398-400. |
| X5 | HIGH: cross-process stale winner claim | blind-primitive | `store.mutate` under per-record run-lock adopts persisted winner (fanout-primitive.ts:614-633); comment documents exact adopt-or-reprobe contract. blind-patterns independently verified mutate atomicity. Premise requires the lock itself to fail. |
| X6 | MED: lstartUtcMs dead code | blind-lock | Deliberate round-3 forensic evidence: comments at fleet-lock.ts:73, 86, 170, 760-763 — "RECORDED ONLY, never an identity input" (TZ-unsafe to compare). Removing deletes debugging evidence added by prior review round. |
| X7 | LOW: CLK_TCK hardcoded 100 | blind-lock | Explicit ponytail annotation with ceiling + upgrade path (fleet-lock.ts:147-150). USER_HZ=100 on every mainstream kernel. |
| X8 | LOW: rmQuiet temp-file leak on EBUSY | blind-primitive | rmQuiet's contract is silent best-effort (name + call-site family). Retry/warn machinery contradicts contract; /tmp unlink failures rare. |
| X9 | MED: cross-process lock never exercised | edge-tests-patternsB | Real subprocess races exist: fanout.test.ts:861-886 (Bun.spawn req-race-a/req-race-b + SIGINT child). Coverage present. |
| X10 | LOW: onProbe timing window flake | edge-tests-patternsB | Reviewer self-assessed acceptable; documented flake profile (known non-findings list). |
| X11 | LOW: first-writer atomicity assumed not proven | edge-tests-patternsB | Reviewer self-assessed: lock exercised indirectly, source verified atomic (X5), subprocess races exist (X9). |
