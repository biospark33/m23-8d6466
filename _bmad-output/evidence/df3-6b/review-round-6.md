# DF3.6b — code review round 6 (final gate before push, post-rebase)

**Date:** 2026-09-19 · **Scope:** the WORKING TREE (`git diff origin/dev`), not just the commit tip
· **Focus:** verify every round-4 and round-5 fix, then sweep for what five rounds missed.

6 findings (7 table rows — 1b is a caveat on finding 1, not a separate finding). All resolved in-round. The most severe was a regression introduced BY round 5's own fix.

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | MED | **Round 5's `stop()` teardown destroyed the in-flight call's accounting before the call read it.** `stop()` resumes on `proc.exited` alone; the call additionally drains both output streams, so stop() wins that race essentially always. By the time the call's `finally` ran `readLeaf`, the leaf was gone — and `readLeaf` swallows read errors, so it returned `{peakBytes:0, oomKilled:false}` SILENTLY for a solicitation that may have been OOM-killed. On every signal-terminated run: steering took the degrade path instead of `watchdog_kill`/`overflow`, the `resident_cgroup` line was emitted with falsified values (`allowed:true`, `rssPeakBytes:0`), and the call's own `removeLeaf` then threw a spurious ENOENT warn. | The read + remove + emit is now ONE `teardownLeaf(dir, killed)` in the resident scope, and `currentLeaf` is the single-owner handle: whoever clears it first performs the whole teardown, the other skips. |
| 1b | — | **Caveat on that fix:** `stop()` passing a hardcoded `killed: true` would re-open the graceful-`-ENOMEM` false positive through the stop path — a Ctrl-C on a leaf carrying an own-limit `oom` counter would report `oomKilled: true`. | `stop()` now reads the child's ACTUAL end off the settled handle (`exitCode === null \|\| signalCode !== null \|\| exitCode === 137`), the same discriminator the call side uses. **SUPERSEDED by round 7:** there is no discriminator on either side any more — the exit shape was removed from the verdict entirely, and `stop()` passes no `killed` argument. A Ctrl-C reads false because our SIGKILL increments no OOM counter, not because the handle is inspected. (The sentence that followed here reasoned about a child that exited just before the SIGKILL landed — that reasoning belonged to the deleted handle inspection and no longer applies.) |
| 2 | MED | **Round 5's fix (d) had no test.** Nothing called `stop()` while a call was in flight — every `stop()` in the file ran after the call settled — so deleting the teardown left the suite green while the leak reopened. | New test fires a `hang`-mode call without awaiting, stops mid-flight, and asserts BOTH that the staged `memory.peak` survived the teardown (a racing implementation reports 0) and that the leaf is gone. |
| 3 | LOW-MED | **The OOM-arm ordering test could not fail against the inversion it names.** It asserted `status === "stopped"` at `onBoundBreach` time — which holds even if the degrade write runs first, since the later "stopped" wins. | Added `expect(c.lastDegradationReason).toBeNull()`: the wrongly-ordered implementation sets it, the correct one never touches it. |
| 4 | LOW | **The story's Files table still said "five walked inputs"** — round 4's five→four correction had landed only in the test comment, and the story is what the next re-pinner reads. | Corrected, with the Dockerfile's separate `deriveBuildId` role named and the 89-entry walk stated as verified by direct call. |
| 5 | LOW | **Three assertions that cannot fail, and one comment claiming coverage its test lacks.** `expect(typeof cgroupV2Here).toBe("boolean")` (on a variable that selected nothing — the branch is picked by what the run reported); two `expect(root).toBeTruthy()` on a path string that is non-empty by construction; and a comment claiming the M1 test performs a kill-variant comparison it does not. | All three removed, the unused variable deleted, and the comment now points at the block that actually performs the discrimination. |
| 6 | LOW | **`_lastSpawnArgv` retained the rendered prompt module-globally for the process lifetime** — a retained allocation and a heap/core-dump exposure, in a file that routes every other egress through `redact`. | The seam keeps only the first six elements (`sh -c <script> _ <leaf> <bin>`), which is everything both argv tests read. |

## Verified correct (rounds 4–5 fixes)

`createLeaf`'s plain-`rmdirSync` pre-clean (with the non-recursive `mkdirSync` still failing EEXIST
on a busy collision, and the unwind block correctly sited after it); the `killedBySignal` AND (**SUPERSEDED by round 7 — deleted; the verdict reads the counters and the peak, and there is no signal branch in it**), which
did NOT miss a real kill AS IT THEN STOOD — `memory.oom.group=1` SIGKILLs the whole leaf, so an
own-limit kill always reached the signal branch, and the one path that bypassed it (the
stream-fault/`OutputCapError` catch) was a death by OUR SIGKILL, where `oomKilled: false` was the
truthful answer. **Past tense deliberately: round 7 deleted that branch from the verdict, so none of
this clause describes current code**; the
`_lastSpawnArgvForTest()` seam and both argv tests (a parent-side placement fails `argv[0] === "sh"`);
the Files-budget additions; and all three corrected line citations, which resolve at the lines given.
The exit-97 tests, the graceful-`-ENOMEM` test and the M1 test were each confirmed to fail against
the implementation they describe.

## Environment, not this branch

`tests/gitnexus/**` failed 8 tests under the full-suite run purely on index staleness (dev had moved
underneath it); after `bash scripts/install-gitnexus-plus.sh` the suite is 32 pass / 0 fail. The two
DF2.11 WAL failures reproduce on a clean `origin/dev` worktree. `McpClient` grandchild-sweep and the
`GET is retried once on a 5xx` test pass in isolation — load flakes under a full parallel run.
