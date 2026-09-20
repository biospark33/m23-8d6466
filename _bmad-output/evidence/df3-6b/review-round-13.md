# DF3.6b — code review round 13 (CodeRabbit round 4, and a round that audited round 12)

**Date:** 2026-09-19 · **Trigger:** CodeRabbit's review of the round-12 push returned three Minors.
All three were legitimate, and the three local reviews dispatched on the fixes found three further
defects — two of them in round 12's own record, which is the point of this round.

## What CodeRabbit found

| # | Site | Finding |
|---|------|---------|
| 1 | `review-round-12.md` | The summary said three rulings failed propagation while the table listed four rows (3, 3b, 5, 9). One basis or the other, not both. |
| 2 | story, Leg B live falsifier | The paragraph claimed every real crossing must leave `memory.peak` at the bound. The shipped rule SKIPS the peak comparison when the measurement is unavailable, so on a pre-5.19 kernel a valid own-limit kill satisfies the verdict with no peak at all. |
| 3 | the pin ledger | The paragraph above `bb3c3602` described earlier comment-only moves, not the round-12 change recorded for `bb3c3602`. |

Finding 2 is the sharper one: it is the **same escape** round 12 had just written a test row for,
still unfixed in the live-leg spec one file over. Pinning a behaviour in the suite does not propagate
it to the prose that describes the same behaviour — the identical lesson round 12 drew about rulings,
arriving from the opposite direction.

Finding 3 is the pin ledger's chain invariant breaking **for the second time on this branch**, and
both times by the same hand. The invariant: every digest in the chain must tie to a paragraph
describing THAT digest's move. Round 10 caught the first break (a re-pin written OVER an existing
paragraph); this is a re-pin written NEXT TO one, leaving the older paragraph adjacent to the newer
literal and reading as its provenance. The failure mode is "insert near, not adjacent", and the fix
is positional: the comment-only-moves half stays with `7d44bbda`, the owed-publish half moves down
beside `bb3c3602`. A reviewer noted the order had also been left **chronologically inverted** —
rounds 7 and 8 narrated after round 12 — which is the more legible symptom.

## What the three local reviews found

### D — the ledger paragraph undercounts its own commit

The new `bb3c3602` entry claimed *"ONE walked input changed: `src/fleet/resident.ts`, **twice**, both
in `readLeaf()`'s documentation."* The commit touches that file in **three** hunks. The third is
`ResidentSpawnOpts`'s JSDoc for `residentRssBytes` — the ruling-3b correction — which is not inside
`readLeaf()` at all. `git show 2dfedf49 -- src/fleet/resident.ts` prints three hunk headers.

The file-level claim was still right, so the hash-mover conclusion did not change. But this ledger
exists precisely to spare the next re-pinner a bisect, and an entry saying "twice, both in
`readLeaf()`" sends them searching one function for a hash three hunks moved. Corrected, with the
`git show` invocation named so the count is checkable rather than asserted. **Commit `2dfedf49`'s own
message carries the same undercount and cannot be amended; the ledger entry is the correction.**

### E — an unsound kernel claim, caught before it shipped

Fixing CodeRabbit's finding 2 required saying which kernels arm the peak clause, and the first draft
wrote: *"assert the peak clause only on 5.19+, which the exedev image satisfies (systemd 255, cgroup
v2 unified)."* That is wrong on two independent grounds, and the reviewer supplied the second:

1. systemd 255 does not bound the kernel version. systemd's own minimum is far below 5.19.
2. **More fundamentally, a container shares the HOST kernel.** No property of `oci/exedev/Dockerfile`
   — not the digest-pinned base, not the systemd version — can establish what kernel the exe.dev box
   is booted on. The kernel version is a fact about the box, not about the image.

Nothing in this story has ever measured it. The leg now MEASURES rather than assumes (`uname -r`
first), the story states plainly that the fleet's kernel version is not established, and a new
prerequisite **(c)** joins the NOT-DONE section's list of "real-kernel assumptions no host-side fake
can settle" — the section that exists for exactly this class and had missed this member. The bad
inference is recorded rather than silently deleted, because systemd-version → kernel-version is the
obvious wrong step to take again.

### F — round 12 miscounted itself, four ways

A count audit measured every number in `review-round-12.md` against source rather than against the
file's own prose. Four were wrong:

1. **Ruling 7 was in the wrong column.** It was listed among the rulings that "propagated fully",
   in the file whose opening paragraph describes CodeRabbit finding ruling 7's AC4 checkbox still
   stale — a checkbox rewritten in that very commit. **A round whose subject is rulings that fail to
   propagate miscounted its own opening example.** Corrected to four failed (3 with 3b, 5, 7, 9) and
   five propagated (1, 2, 4, 6, 8); 4 + 5 = 9 still holds. The auditor also confirmed ruling 7
   drifted at that ONE site — the AC4 body and the Files table were already correct, and the fleet
   `warn` reference nearby is a genuinely different event.
2. **"Eleven sites" was twelve by the table's own enumeration**, and thirteen once ruling 7 is
   counted: 4 + 4 + 1 + 1 + 3. The commit message says eleven and is immutable; the story now
   supersedes it in place.
3. **"Block total: 37 rows before, 39 after" was mislabelled.** Those are the WHOLE FILE's `test(`
   counts. The OOM-verdict describe block went **13 → 15**. Both numbers were real and attached to
   the wrong noun — the most durable shape of count drift, because the figures survive spot-checking.
4. **"Three rounds before the first push, nine after" was six and six.** Round 6 is titled "final
   gate before push"; round 7 is the first to answer PR #264. The total was right, the split was not.

Every correction was re-verified from source before landing, and then re-audited by the same auditor
against the corrected file — because miscounting a correction to a miscount is the failure this round
is about. That second pass found nothing further.

## Standing observation

Rounds 10, 12 and 13 have each found the previous round's *record* defective rather than its code:
a broken pin-ledger chain, a ruling that named no members, a round that miscounted its own example.
The code has been stable across all three. **The artifact that says what was done is now the least
reliable part of this story**, and the reason is consistent — every one of these errors was written
by the same agent that had just finished the work it was describing, at the point where the work felt
finished. The countermeasure that has actually worked is not more care at writing time; it is a
separate reader measuring each number from source. Three of the four count errors above were
invisible to re-reading and only fell out of `git show` and `grep -c`.

## Gates

`bunx tsc --noEmit` clean, Biome clean, `check-story-consistency` OK, and the pin suite green at 234
pass. No walked input changed this round — the three files touched are the story artifact, this
evidence directory and `tests/scripts/build-exedev-image.test.ts`, all outside `buildIdFileInputs` —
so `bb3c3602` stands and no re-pin is owed.
