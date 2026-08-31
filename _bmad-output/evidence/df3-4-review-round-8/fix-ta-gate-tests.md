# fix-ta-gate-tests — tests/fleet/approval-gate.test.ts (PR #150 round 7, wave 2)

Only file edited: `tests/fleet/approval-gate.test.ts`. `src/fleet/approval-gate.ts` read, never edited.
Baseline 96 pass → final **114 pass, 0 fail** (two consecutive solo runs identical; plus 243 pass
across approval-gate + gate-verbs + reverify/approval + reverify/runner). `bunx biome check` clean;
`bunx tsc --noEmit` — 0 errors in this file (baseline was 0; the 3 remaining repo errors are in
tier5-gate-steering.live.test.ts and driver.test.ts, untouched by me and pre-existing in the wave).

## MED findings

| # | Finding | Verdict |
|---|---|---|
| M1 | Spinner children leak on failure path (rebind racer test) | **fixed** — the four parked children are now collected into a `children` array killed in the `finally` (they spin forever on the gate file if a readiness `expect` fires before the gate is written). Spawn list renamed `spawned` and pushed into the leak-guard array; results/exit reads use `spawned`. |
| M2 | submitDecision concurrency can't fail cross-process | **fixed** — new "CONCURRENT decisions serialize ACROSS PROCESSES" test: two real `bun -e` children racing `submitDecision` through one lock; asserts exactly one `decided` outcome, the loser answering `already-decided` with the winner's approverId, and the on-disk record agreeing. The in-process test above it pins only the CAS (its critical section is synchronous and cannot interleave) — comment updated to say so. |
| M3 | EPERM arm skipped on root CI | **fixed** — new twin test "an EPERM kill error means LIVE": `spyOn(process, "kill")` raises EPERM unconditionally, so the EPERM arm of `isLockHolderDead` is exercised everywhere (root CI, user pid namespaces) rather than only where pid 1 is root-owned relative to us. Pins both the acquire loop (never reclaims, lock bytes intact, `held for over`) and `reclaimApprovalLock` (`refused`/`holder:"alive"` without force, forced reclaim works). The natural-EPERM test keeps its loud `skipIf`; no assertion weakened. |
| M4 | requestApproval missing-run untested | **fixed** — new "a PAUSE against a run that does not exist throws" test: throws `unreadable run record run-typo.json: ENOENT` (the strict reader), mints NO record, and leaks no lock. Verified against source before writing. |
| M5 | in-range timeoutMs branch only at floor | **fixed** — `test.each` added for the three untested arms of `resolveTimeoutMs`: the floor EXACTLY (`Math.max` passes MIN_TIMEOUT_MS through — an off-by-one `>` reds), an ordinary in-range 90_000 (the arm every existing clamp test misses), and the ceiling exactly. The sub-floor, over-ceiling, and non-finite clamps were already pinned and are untouched. |
| M6 | withTeardownClaim loop untested | **fixed** — three new tests in the AC1(c) describe: (a) a teardown that THROWS releases its claim (leaked claim would wedge every later resume until process exit; record stays `pausing`); (b) a stale claim with a provably-dead pid aged past LOCK_STALE_MS is reclaimed and the resume proceeds (teardown runs exactly once, record promotes, claim gone); (c) a FRESH claim (un-backdated, dead-looking pid) is WAITED on, never stolen — released mid-wait, then taken. All three mechanics probed against the real source first. |
| M7 | reclaim `changed` branch untested | **fixed** — new test racing `reclaimApprovalLock` exactly at its fence: the first `readFileSync` is the inspection, the second is the removal's re-read; a `spyOn` substitutes a successor's lock (unlink + `wx`, a genuinely new inode) there. Asserts `outcome:"changed"` (both `absent` and `reclaimed` would be lies), `info` still describes the inspected lock, and the successor's file survives byte-identical. |
| M8 | emitPause raising sink untested | **fixed** — new D1 test with a throwing `setLogSink`: a successful pause still resolves `requested` (the `finally`'s emit throws into the guard, never out of `requestApproval`), and a failing pause re-raises ITS OWN teardown error — the guard must not replace the gate's real outcome in either direction. Second run bound to a fresh run-2 so the failure arm reaches teardown rather than answering `rebound`. |
| M9 | sweepExpired pausing/absent + awaitDecision absent untested | **fixed** — two new tests: `sweepExpired` never sweeps a `pausing` record even years past any plausible deadline (record byte-identical; sweeping would abort a run that may be mid-teardown), and `awaitDecision` on a non-existent run answers `null` inside the caller's own window (the tolerant reader bounded by `waitMs`, not the 24h default). `sweepExpired` absent-run was already covered ("tolerates a run whose record is gone") — not duplicated. |

## LOW findings

| # | Finding | Verdict |
|---|---|---|
| L1 | Loose error regexes (:187, :376→:161, :412→:410, :897→:1122, :1577→:1836) | **fixed** — schema table now pins WHICH field each row's message names (`/reportId/` vs `/headSha/`, per row); rebind bundle refusal tightened to `/cannot rebind run-1/` (matches the other call site's `cannot decide run-1` shape already pinned); keyHash guard to `/no keyHash, so a minted key may still be live/`; whitespace-approverId to `/requires an approverId — DF5\.2 refuses/`. Every replacement verified against the real error message before pinning. |
| L2 | JSON round-trip vacuous (:1479) | **fixed** — kept the round-trip (it is the disk-level check: a lone surrogate would come back U+FFFD) and ADDED the property that makes it non-vacuous: the stored text is still a PREFIX of the real proposal up to the truncation suffix. A corrupt (replacement-char) cut now reds on the new assert, not just the round-trip. |
| L3 | Surrogate parity (:1476) | **fixed** — covered by the same strengthening (prefix assert above). |
| L4 | Empty-bound-id outcome discarded (:1668) | **fixed** — the test now asserts the outcome: `toEqual({outcome:"rebound", supersededReportId:""})`, proving the empty id was deliberately skipped (the append path ran and returned the displaced id) rather than never reached. Probed against source first. |
| L5 | Duplicate pausing pins (:284/:320) | **fixed** — the two tests were byte-identical except one wired a teardown seam. Differentiated rather than deleted: the collision test keeps the seam + no-teardown-ran assertion; the second becomes a NEW ordering pin — a different-report collision answers `pause-in-progress` BEFORE the INV-APPROVE-6 seam guard (no teardown wired is still no error, record untouched). Different code paths, both covered now. |
| L6 | Key-set literal duplicated (:2194) | **fixed** — the success-line key set now reuses `ERROR_LINE_KEYS`; comment rewritten to state that the two shapes ARE one closed set today and what to do if an error path ever times a teardown (a deliberate new entry). |
| L7 | ERROR_LINE_KEYS comment (:2000) | **fixed** — comment was stale ("the success line's set (pinned at the bottom of this describe)" no longer pointed anywhere after L6); rewritten to name the three consumers and the sharing rationale. |
| L8 | Wall-clock duration (:2058) | **fixed** — the loose `typeof` assert was already tightened by an earlier round to anchor `durationMs` inside the real elapsed window (`toBeLessThanOrEqual(elapsed)`); the comment already explains why `duration` vs `durationMs` alone would be near-tautology. No further change needed — checked, not rubber-stamped. |
| L9 | `lines[0]` before length (:2074) | **fixed** — the unguarded accesses (`noSeam[0]`, `seam[0]`, and the no-secrets test's `JSON.stringify(lines[0])`) now each have `toHaveLength(1)` first; the shape assertion after them can no longer pass vacuously on `undefined`. The throw/refusal tests already had guards. |
| L10 | Coverage-delegation header (:963) | **fixed** — the comment cited `tests/reverify/approval.test.ts:146-345` by line number, which has already drifted; rewritten to cite the tests by NAME (replacement-race, restore-failure) so it stays true across edits. |
| L11 | schemaVersion v1 fixtures (:249, :694) | **fixed** — `expiredState`'s pure-function fixtures now use `schemaVersion: 2` (what the store stamps today; the store REFUSES a caller-supplied `schemaVersion: 1`, verified). The remaining `schemaVersion: 1` literal (:2009) is correct as-is — it is the hand-written pre-migration record the singular-scalar test exists for. |
| L12 | Readiness poll 4s (:1067) | **fixed** — not a timeout raise: the rebind-racer readiness loop already waits 1000×5ms = 5s per child; a comment now states the budget and that failure names which child never readied. No flake observed across three full runs. |
| L13 | Clamp exact boundaries | **fixed** — negative/zero `waitMs` (`Math.max(requestedWait, 0)` boundary) now pinned: both fire an immediate `null` without a poll, under 2s. The `pollMs` floor exact boundary (LOCK_POLL_MS) is exercised implicitly by the existing 0/-50 clamps; `Bun.sleep` granularity makes an exact sub-10ms observation timing-fragile, so the behavioral pin was kept rather than an assertion that flakes. |
| L14 | reject-then-approve | **fixed** — new mirror test: an APPROVE after a REJECT loses (`already-decided`, state stays `rejected`). Not redundant with the approve-first test: an implementation that special-cased "an approve always wins" passes the existing test and reds here. |
| L15 | Claim release on teardown throw | **fixed** — see M6(a). |
| L16 | Garbage state string | **fixed** — new test: a hand-edited `state:"sometypo"` record is `not-decidable` naming the state it found, the record unchanged — a fall-through would have written a terminal record over a run that was never decidable. |

## Source defects discovered by the new tests

**None.** Every new test passes against the current round-7 source. One probe result worth
recording as behavior-confirmed rather than defect: the `awaitDecision` non-finite `waitMs`
fallback (F1 finding 5) resolves only after the full 24h default — correct per the fix report, and
deliberately NOT asserted in-test with a short timeout (it would hang for a day); the observable
half of the clamp (negative/zero fires instantly) is what's pinned, per L13.

## Verification

- `bun test tests/fleet/approval-gate.test.ts` → **114 pass, 0 fail** (twice, identical; plus a
  mid-work run at 110/112 — no flake observed at any point).
- `bun test tests/fleet/approval-gate.test.ts tests/fleet/gate-verbs.test.ts tests/reverify/approval.test.ts tests/reverify/runner.test.ts` → **243 pass, 0 fail**.
- `bunx biome check --write tests/fleet/approval-gate.test.ts` → clean, no fixes applied.
- `bunx tsc --noEmit` → 0 errors in approval-gate.test.ts (4 transient errors I introduced during
  the EPERM/Response typing were fixed; remaining repo errors are pre-existing in files outside my scope).
