# DF3.6b — code review round 17 (covering CodeRabbit's second stall: how faithful is the fake?)

**Date:** 2026-09-20 · **Trigger:** CodeRabbit acknowledged two full-review requests (04:46Z, 05:13Z)
and posted nothing for ~41 minutes — its second stall of the night, after an earlier ~65-minute one.
Covered locally rather than blocking the loop.

## The question this round asked

Round 16 established that **every mechanism claim in this story has only ever executed against an
fs-level FAKE cgroup tree** — ordinary directories and files, with the fixture staging
`memory.events`/`memory.peak` from inside the child. That was recorded as a gap. Nobody had ever
audited the gap's SHAPE: where is the fake *more permissive* than the kernel, such that a test passes
against it and the same code would fail on a real box?

That is the question that decides what the green suite is worth, so it is the one the covering review
was given.

## The finding: a retry loop that no test could reach

**`removeLeaf`'s bounded EBUSY `rmdir` retry was 100% dead code under the entire host-side suite.**

The loop exists for a race only a real kernel produces: `cgroup.kill` SIGKILLs the leaf's tasks and
`rmdir` returns EBUSY until the kernel finishes reaping them. Against the fake, `removeLeaf` has
already `unlink`ed every entry, so `rmdirSync` succeeds on attempt 0 — **the attempt cap, the errno
discrimination and the backoff never executed once.** A wrong cap, an inverted errno check, or a
backoff too short for real reap latency would each have shipped green, and would surface only under
real host memory pressure.

Fixed by extracting the loop into `rmdirBounded(dir, rmdir = rmdirSync)` behind a
`_rmdirBoundedForTest` seam — the `_`-prefix convention this file already uses for
`_PLACEMENT_SCRIPT`, `_injectRateSources`, `_lastSpawnArgvForTest` and others. Production behaviour
is unchanged (default remover, identical loop body), verified line-by-line by a reviewer against the
replaced code, including a check for TDZ hazards on the two `const`s declared later in the file.

Four rows now pin the CONTRACT:

| Row | Pins |
|-----|------|
| frees on the second attempt | the retry-then-succeed path |
| EBUSY to the end | the cap is exactly four, and the ORIGINAL error rethrows |
| a non-EBUSY errno | no retry — the discrimination, in the fail-closed direction |
| an errno-less throw | the `?.code` optional-chaining branch |

All mutation-verified: dropping the EBUSY check reddens two rows, an off-by-one on the cap reddens
one.

**And then a fifth thing, because the reviewer answered a question I asked it to answer honestly.** I
asked whether the BACKOFF was pinned at all, saying I would rather know it was unpinned than believe
it covered. It checked: deleting `Bun.sleepSync` outright turned **none** of the four rows red. A
retry that cannot outlast the reap it exists to wait for is precisely the bug that ships green, so a
floor assertion now pins it — three sleeps at 25 ms is a 75 ms floor, asserted at 60 ms for clock
margin, as a floor only because an upper bound would be flaky and would pin nothing worth pinning.
Mutation-verified: with the sleep deleted the row goes red, having run in 0.13 ms.

What these rows still do NOT prove is the BUDGET — whether 4 × 25 ms is enough for real reap latency
on a loaded box. That is a kernel fact and belongs to the live leg, and the comments say so.

## The rest of the audit, recorded where it will be acted on

Added to the live-leg prerequisites rather than left as prose:

- **(d) the EBUSY retry under real reap latency** — ranked the highest-risk gap. The leg must tear
  down a leaf holding a process genuinely slow to reap, not an already-empty directory.
- **(e) `cgroup.procs` REJECTION modes.** The placement wrapper's whole fail-closed design defends
  against writes that fail or silently do not take, and on the fake a plain-file write can only be
  made to fail by `chmod`. Real kernfs rejects with EBUSY on a transitional leaf, ESRCH on a reaped
  pid, EACCES under a uid mismatch, EINVAL on malformed content, and takes ONE pid per write.
- **(e, continued) the `+memory` ordering is real but its violation is undetectable host-side.**
  `ensureDelegatedSubtree` moves pids before enabling `+memory`, which is the order the
  no-internal-processes rule requires, and the split test exercises the real function. But the fake
  would accept the wrong order just as happily — its `cgroup.subtree_control` is a plain writable
  file and the final on-disk state is identical either way.
- **(f) a fidelity caveat, not a live-leg item:** the numeric-contract test asserts `memory.max` reads
  back BYTE FOR BYTE including for a deliberately non-page-aligned bound (12,345,678). A real kernel
  `PAGE_ALIGN`s upward, so **that assertion is true of the fake only and must not be ported to a live
  leg as written.** Inert in production — nothing reads `memory.max` back.

## Two claims cut down before they were written into the story

The fidelity audit was checked by an independent second reviewer specifically for overstatement,
including overstatement in the direction of being too harsh on the tests. It found two, and neither
had yet reached the story:

1. **"`memory.oom.group` acceptance carries zero evidentiary weight" — overstated.** True that the
   fake cannot prove a real kernel ACCEPTS the write. But unlike `memory.max`, the kernel applies no
   value transform to `oom.group` — it is a plain 0/1 boolean — so the byte-exact readback does
   faithfully prove the code writes literal `"1"` and not `"0"` or nothing, which is the invariant the
   code's own comments say matters (a kernel default of 0 leaves orphaned children and breaks AC1).
   The correct statement is "proves the value, not the acceptance".
2. **"The teardown tests prove only that `writeFileSync` then `rmdirSync` were called on an empty
   directory" — too harsh as a generalisation.** Accurate for `removeLeaf`'s `cgroup.kill` mechanics
   specifically. But several teardown tests prove real, kernel-INDEPENDENT orchestration: `stop()`
   during an in-flight call tears down exactly once and reads the accounting before removing
   (single-ownership plus read-before-remove ordering, driven through a real race); the leaf is
   removed on a failing call too (the error path leaks no cgroup); a second solicitation gets a fresh
   leaf (per-call isolation, asserted by value). Those stand on their own.

Recorded because this branch's recurring failure is a claim propagating in the form it was first
written. The harsh version was never written down.

## Gates

`bunx tsc --noEmit` clean, Biome clean, `check-story-consistency` OK. `tests/fleet/resident-cgroup.test.ts`
43 pass (was 39), pin suite 234 pass. buildId re-pinned `99b541b3` → `660ae409`; the mover is
structural this time, not comment-only.
