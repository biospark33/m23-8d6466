# DF3.6b — code review round 21 (a race made deterministic, and a predicate stated without its escape)

**Date:** 2026-09-20 · **Trigger:** two CodeRabbit Minors.

## Finding 1 — a timeout row whose margin was wall-clock luck

CodeRabbit: the M1 reclaimable-pressure row runs at `QDS_RESIDENT_TIMEOUT_MS: "150"`, the fixture
stages `memory.events` only at its own startup, and if the SIGKILL lands first the leaf is empty,
`lastMemory()` returns `{peakBytes: 0, oomKilled: false}`, and `expect(oomKilled).toBe(false)` holds
for every implementation. Same vacuity the sibling row documented at 3000 ms.

**The reasoning is right. The instance did not reproduce, and that distinction is kept.** Measured:
with a staged-peak assertion added, the row **still passes at 150 ms** — five runs, `424242` read back
every time. The fixture wins the race on this machine today. So the row was **race-vulnerable, not
vacuous**, and the comment says exactly that rather than claiming a live defect.

What WAS wrong is the old comment's reasoning: *"Not vacuous: the events file EXISTS"* — which is
precisely what the race takes away. It argued from the assumption in question.

**Fixed properly rather than by margin.** Both affected rows now use the deterministic pattern already
present in this file at the two `stop()`-race rows: poll for the staged `memory.peak`, then **assert
the precondition** before proceeding. A bare 3000 ms budget makes the race likely to be won; the poll
makes it *checked*. Verified by neutering the fixture's staging: both rows now fail on the named
precondition — *"the fixture never staged memory.peak — the row below would pass vacuously"* — rather
than on a downstream assertion, which is the difference between a diagnosable failure and a confusing
red on a memory test.

### The full-file sweep — and its first answer was WRONG

> **RETRACTED, same day, before anyone relied on it.** This section originally read: *"Every one of the
> 15 rows … failed loudly. None is vacuous today."* **That claim was false, and it was published here
> and in the PR comment.** The reviewer re-ran its own sweep with `--reporter=junit` to get the
> PASSING rows BY NAME rather than by count, audited all 28, and corrected itself: **four were
> unconditionally vacuous.** The count-only reading had let them hide among 24 rows that pass under
> neutering for the legitimate reason that they never touch staging at all.
>
> The lesson is the method, not the rows: **a sweep that reports how many passed cannot tell a clean
> row from a vacuous one.** It has to name them and audit each. The first pass here did exactly what
> this story has criticised elsewhere — reasoned from an aggregate.

A reviewer neutered the fixture's entire staging block and ran the file. Corrected result: **19 of the
memory-asserting rows fail loudly; the remaining 24 pass because they genuinely do not depend on staged
content** (the delegated-subtree split, the AC3 `CgroupUnenforceableError` rows, the omitted-bound
null check, the leaf-removed-on-a-failing-call row, the unit-level `MemoryMax` static file read, and
all nine AC4 wrapper-script rows).

**The four that were vacuous**, all in the OOM-verdict block, all asserting `oomKilled === false` with
no pinned peak:

| row | staged |
|---|---|
| a GLOBAL OOM kill is NOT this bound firing | `oom_kill 1`, `oom 0` |
| a GLOBAL OOM that GROUP-KILLS through this leaf | `oom_kill 1`, `oom_group_kill 1`, `oom 0` |
| counters set but the process SURVIVED | `oom 1`, no kill counter |
| a clean call reads false on every counter | all zero |

Each is **indistinguishable from a stub that never opens the leaf**: `readLeaf`'s catch returns
`{peakBytes: 0, oomKilled: false}`, which satisfies every one of them. And unlike the timeout rows,
this is **not** a race — these rows involve no kill and stage deterministically before teardown, so
they were vacuous on every run, on every machine, since they were written.

Note what this means for the round-7 through round-20 claims that the OOM-verdict block was
mutation-verified: those mutations flipped the PREDICATE, which these rows do catch (a predicate
forced to `true` fails them). What they never caught is an implementation that does not read the files
at all. **Mutation-testing the predicate cannot detect a test that is not reading the input.**

Fixed: each now stages a distinctive `peakBase` and asserts it. Verified — under neutered staging the
file goes from 15 failures to **19**, and the four are among them.

It also established why most rows are structurally immune: the `verdictFor` rows stage
**synchronously inside the child** before the child's own optional self-SIGKILL, so there is no
parent-vs-child race at all. Only rows where the PARENT's timeout kills the child can race, and there
were exactly two.

## Finding 2 — the predicate restated without its escape

`review-round-1.md` stated the shipped rule as three unconditional conjuncts. The peak comparison is
**skipped** when the measurement is unavailable (`peakBytes === 0` on a pre-5.19 kernel, or
`boundBytes === undefined`). Implementing it as written returns `false` for a genuine own-limit kill
on such a kernel — traced and confirmed by a reviewer: with the escape removed and `peakBytes === 0`,
the conjunct is false whenever `bound > slack`, so `oomKilled` is false while `ownLimit` is true. A
**false negative**, the worse direction, and the reason the escape exists.

Labelled ABBREVIATED with both escape conditions named. A sweep for other restatements found **none**
unlabelled — every other site either states both conditions correctly or does not restate the rule.
One site (`review-round-7.md`) has the defect's surface shape, rule then escape, but the escape sits
inside the same fenced block, so anyone copying the block copies the escape. Checked independently and
agreed: not a defect.

## Process note — the same dispatch error, twice

Round 15 recorded: *concurrent reviewers and a mutating reviewer must not share a working tree.* This
round I authorised a mutating reviewer alongside readers **and myself**, and ran the suite into its
live mutation — 28 pass / 15 fail, which I correctly recognised as its experiment rather than a
regression, but only because I had dispatched it.

The lesson was recorded and not applied. The mutating audit belongs in a `git worktree`; recording it
a second time is not a substitute for doing that.

A restore also silently failed (`cp` from a scratch backup left the mutation in place) and was caught
only by checking `git status` rather than trusting the restore. **`git checkout --` is the
authoritative restore**; a copied backup is not.

## Gates

`tests/fleet/resident-cgroup.test.ts` 43 pass / 0 fail, fixture confirmed unmodified. No walked input
changed — a test file and an evidence file — so `660ae409` stands and no re-pin is owed.
