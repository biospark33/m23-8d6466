# DF3.6b — code review round 3 (verification & regression sweep)

**Date:** 2026-09-18 · **Scope:** `git diff dev...HEAD` on `feature/df3-6b-resident-memory-cgroup`
**Focus:** verify every round-1 and round-2 fix, then sweep for what both earlier rounds missed —
regressions from the widened seams, the `inBoxFrontDoor` deviation, the restructured `call()`, and
test fakes that have drifted from kernel behaviour.

## Verified correct (rounds 1–2 fixes)

All ten confirmed at source: the OOM verdict keyed on `oom_group_kill`/`oom` with anchored patterns
(so `oom_kill 1` cannot match `^oom `); the INV-MEM-1 amendment mirrored at the spawn site;
`cgroup.kill` before a bounded EBUSY-only `rmdir` retry; the membership-verifying placement wrapper;
the documented exit-97 collision; the probe leaf's own `finally`; M1 no longer vacuous and the AC3
in-box test branch-selecting instead of skipping; AC2's root/`supervisor/` and one-pid assertions;
the deterministic child-recorded numeric contract; and both re-derived asset digests matching
`shasum -a 256`.

The reviewer's own sweep, with its exact scope stated rather than generalized: **2659 pass / 2
fail** over `bun test tests/fleet/ tests/phase-engine/ tests/scripts/build-exedev-image.test.ts` —
NOT the whole repo. The two failures were the then-outstanding `PLACEHOLDER_WALK_DIGEST` (since
filled) and `tests/fleet/cli.test.ts`'s "TRANSIENT errno" test, which passes in isolation and fails
identically on `dev` with this branch stashed — a pre-existing load flake, independently confirmed.

The whole-repo run is separate and is the one the PR body quotes: **6084 pass / 5 fail**, of which
two (DF2.11 WAL) reproduce on `dev` with this branch stashed and three (gitnexus x2, the same fleet
CLI test) pass in isolation on both trees. No failure in either sweep is attributable to this
branch. The five round-3 entries below are REVIEW FINDINGS, not test failures — they are counted
nowhere in those totals.

## New findings — 5, all resolved in-round

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | MED-HIGH | **A per-solicitation leaf leaks when `createLeaf` fails after its `mkdir`.** `+memory` disabled in the root between arming and solicitation *N* leaves a root that still accepts `mkdir` but a leaf with no `memory.max` to write. `createLeaf` throws, the call site assigns `leafDir` only on success, so the `finally` teardown never fires and the half-made leaf survives for the life of the box — breaking AC1's post-run "the cgroup is removed" check. The identical defect round 1 fixed for the ARMING probe, unfixed on the per-solicitation path. | `createLeaf` now unwinds its own `mkdir` on a partial failure — in the function rather than at each call site, so it cannot be missed a third time. |
| 2 | MED | **The wrapper-exit-97 → `PlacementRefusedError` conversion had no test.** The shell script was covered standalone and the typed rejection only through a `createLeaf` failure; nothing exercised a spawned child exiting 97 from inside `call()`. Deleting that arm left the suite green while a real placement refusal degraded into the generic non-zero path and the engine's one-way `"degraded"` latch — the misclassification AC4 exists to prevent. | New test drives a child that exits 97 through a bounded call and asserts the typed rejection, `exitStatus` still null (pi never ran) and the leaf torn down; plus a negative control that an UNBOUNDED call exiting 97 is an ordinary pi failure, which pins the `leafDir !== null` guard. |
| 3 | LOW-MED | **M1 ships faked where the DoD says "skipped, not faked"**, and the Dev Agent Record claimed the DoD's wording. Third spec-internal contradiction of the same family as rulings 3 and 5. | Ruled and recorded (ruling 6): the clause is amended — a skip proves nothing anywhere, a staged-counter classification test fails for a real class of wrong implementation. The record's claim is corrected to match the code. |
| 4 | LOW | **`lastMemory()` meant "the last bounded solicitation", not "this call".** Fleet cleared `lastMem` inside the leaf-creation guard, so a call throwing BEFORE a leaf exists (busy guard, empty or over-ceiling prompt, prompt-artifact persist failure) left the previous reading in place — and the engine keys its OOM arm on it for ANY rejection. A prior `oomKilled:true` would relabel a host-side persistence fault as a `watchdog_kill` with `status:"stopped"` and `exitStatus:"overflow"`. | `lastMem = null` moved to the top of `call()`. |
| 5 | LOW | **Test-fake drift:** the fake's `cgroup.procs` is an ordinary file, so `echo $$ >` TRUNCATED it — the "exactly one pid" assertion was a property of shell redirection, not of the mechanism, and the split test could never see a multi-pid root. | The wrapper appends (`>>`, immaterial on cgroupfs where every write is its own migration) and the split writes pids with `appendFileSync`, so both assertions became falsifiable. The split test now fixtures three pids; the AC2 test states what the fake still cannot model (the kernel listing pi's descendants), which is the live round's half. |

## Notes recorded, not defects

- **Ruling 3b (`inBoxFrontDoor`) judged sound and safe**: the latch is set at exactly one site, the unit's front door, and nothing reachable by the resident can flip it.
- Removing the AC3 test's `skipIf` means a plain `bun test` on Linux reaches `ensureDelegatedSubtree()` against the real `/sys/fs/cgroup`. In the common CI shapes the directory is root-owned and `mkdir` fails EACCES, landing the test in the fail-safe `rss_unenforceable` branch; on a box whose cgroup IS delegated and user-writable, a unit-test run would split the host's own cgroup tree. Harmless in itself (a `supervisor/` leaf plus `+memory`), and it is exactly what the engine does in the in-box shape — recorded so it is a known property rather than a surprise.
