<!-- Round 11: CodeRabbit's fourth pass, and the fence that was not a fence. -->

# DF3.6b — code review round 11 (the Dockerfile fence, and a counting-basis correction)

**Date:** 2026-09-19 · **Trigger:** CodeRabbit's full review of PR #264 returned four findings — one
a real test defect, three bookkeeping. Two local reviewers then audited the fixes and found the test
fix was too narrow and one of the bookkeeping fixes had swapped counting bases without saying so.

## CodeRabbit's four

| # | Finding | Resolution |
|---|---------|------------|
| 1 | **The Dockerfile fence could pass against a commented-out scan.** The test asserted `toContain` over the RAW Dockerfile text, so the same bytes inside a `#` comment satisfied it — and the module already builds `DOCKERFILE_DIRECTIVES`, a comment-stripped view, for exactly this reason. | Rewritten far past the reported defect — see below. |
| 2 | `review-round-1.md`'s header claimed "All resolved in-round" when finding 2's OOM attribution retains a permanent residual (ruling 9). | Header qualified: "All actionable changes addressed in-round; finding 2 retains a documented attribution limitation." |
| 3 | `review-round-10.md` referenced `review-round-{1..9}.md` after the story moved to `{1..10}`. | Corrected. |
| 4 | `review-round-8.md`'s "TWELVE more sites" / "All fourteen fixed" double-counted: round B's first finding repeats round A's heading finding. | Re-stated on a findings basis — see the counting-basis note below. |

## The fence was not a fence

A local reviewer ran a mutation probe applying every disable-vector to the real Dockerfile and
evaluating the shipped assertions. Switching to `DOCKERFILE_DIRECTIVES` closed exactly ONE vector.
**Five walked straight through**, because the assertions pinned a SUBSTRING rather than a fence —
"these 26 characters appear somewhere in a non-comment line":

| Vector | Old assertion |
|--------|---------------|
| appending `\|\| true` to the scan | **MISS** — nothing looked past the `grep`, and nothing asserted the line was fatal |
| repointing the target off `"${unit}"` to a doctored copy | **MISS** — the `"${unit}"` argument was never asserted |
| wrapping the scan in an `if` that can skip it | **MISS** |
| `true; #` prefixed mid-line | **MISS** |
| moving the scan into another stage's RUN | **MISS** |

`|| true` is the one that matters most: the DoD is "fails the build when `Delegate=memory` is
removed", so a non-fatal scan is a total defeat, and it was invisible.

**Rewritten as an actual fence.** A predicate `fencedFatally(dockerfile, directive)` now (a) slices
out the RUN that defines `unit=/etc/systemd/system/qds-run@.service`, walking line-continuations to
find its end; (b) locates the scan line for that directive **with its `"${unit}"` target**;
(c) requires the scan to be the FIRST thing on its line and no unquoted `#` to appear anywhere
earlier in the continuation-joined RUN; and (d) requires the `|| { echo … >&2; exit 1; }` tail,
anchored immediately after the scan, to make it fatal. Both the `Delegate=memory` and `RuntimeDirectoryPreserve=yes` scans are asserted through it.
**Then a second correction, because the first accounting was still wrong.** Rejecting a line that
merely *starts with* `#` closed none of three further vectors the reviewer measured — a mid-line
shell comment (`true; # grep …`), a skip conditional (`if [ -z "${QDS_SKIP:-}" ]; then grep …`), and
a guard prefix (`[ -n "${ENFORCE:-}" ] && grep …`). The predicate now requires the scan to be the
FIRST thing on its line, which closes the whole family in one requirement: nothing may precede it.

**Every vector measured-closed** — five at this point in the round, eight by the end (see the fourth correction below, and the independent re-probe that added `exit 0`, a `-q`-less `grep`, and two further `unit=` spellings) — each by applying the mutation to the real Dockerfile,
running the suite, and restoring: `|| true`, commented out, mid-line `#`, skip conditional, `&&`
guard. **No accepted residual remains.** The cross-stage move was recorded as tolerated twice in
this file before a reviewer pointed out it is closed by the slice itself: the scan is only looked
for inside the anchored RUN's continuation walk, so moving it anywhere else — builder stage, a later
RUN, or a decoy assigning the unit path by a spelling that dodges the marker — makes `find` return
undefined and the test fail. The uniqueness guard closes the one sub-case where the slice would have
grabbed the wrong RUN.

**A third correction: the in-suite controls were vacuous again, for a reason no reading would have
found.** `scan` contains `$'` twice (`'^Delegate=memory$'`), and `String.prototype.replace` with a
STRING replacement expands `$'` to "everything after the match" — so each mutation spliced ~15 KB of
the file into itself and truncated the mutant's scan text. Every row then failed at the
`includes(scan)` line rather than at the check it was written to exercise, and **all of them would
have passed with the prefix requirement deleted**. The manual probe did not catch this because
Python's `str.replace` has no such expansion — the two methods disagreed, and the suite was the wrong
one. Fixed with replacer functions, which disable `$` expansion entirely, plus a per-row assertion
that the mutation actually changed the text (a non-matching `replace` silently returns its input, so
the row would otherwise assert against the real file).

**Verified by mutating the test itself:** with the prefix requirement removed, the control block goes
RED. Before the `$` fix it would have stayed green.

**Anchor guards added.** The `unit=` assignment is the right anchor — a stage anchor is strictly
weaker, since "after the last `FROM`" spans five RUNs including ones that never assign `unit`, where
`"${unit}"` expands empty and the grep scans nothing. But the anchor now also requires that the
assignment be UNIQUE in the file and that it sit after the last `FROM`, which closes the decoy-RUN
case: previously a second `unit=`-defining RUN inserted EARLIER than the real one — the builder stage
qualifies — would have captured the slice.

**A fourth correction, from a third reviewer attacking the predicate rather than reading it.** Three
vectors the prefix requirement still passed:

- **The fatal tail was not bound to the scan.** `includes(scan)` and the tail regex were two
  independent searches over the same line, so `<scan> || true; true || { echo … exit 1; }` passed:
  the fatal clause is real but unreachable. That is the `|| true` vector — the one this round called
  the one that matters most — in one more line of disguise. The tail is now anchored immediately
  after the scan.
- **`"${unit}"` is a VARIABLE.** Pinning the argument caught a literal repoint but not a
  reassignment of what `unit` IS: `unit=/tmp/decoy.service;` between the anchor and the scan left the
  predicate true while the grep read a decoy. Now rejected.
- **Docker joins the whole RUN into one shell command**, so a `#` on ANY EARLIER line of the slice
  comments out everything after it — including a perfectly-formed scan. Checking only the scan's own
  line missed it entirely. The predicate now joins the continuations and requires no unquoted
  word-start `#` before the scan. (A naive check false-positives here: the real RUN contains `#217`
  inside a quoted echo message, so the scanner tracks quote state.)

All three are now control rows, and all three were probed against the real Dockerfile — mutate, run,
restore — `CAUGHT` on each. **Eight vectors measured-closed in total.**

Also deleted: a `not.toContain("grep -qE 'Delegate=memory'")` assertion whose comment sold it as the
anchoring guard. The positive assertion already required the fully anchored literal, so that line
only fired on a second, literally-spelled unanchored grep and missed the half-anchored form — a
comment outrunning its code, which is the failure mode this branch has repeatedly produced.

**The negative control was a tautology**, and the same reviewer showed why: it re-implemented the
comment filter inline and asserted over its own strings, never touching the code under test — it
would have passed unchanged against the defective raw-text assertions it was written to guard. It
now calls the same `fencedFatally` predicate over TEN real mutations of the actual Dockerfile bytes
and asserts the real file passes it, so the controls cannot be vacuously false.

**Mutation-verified end to end:** the real Dockerfile scan was neutered with `|| true`, the suite
re-run (both tests went red), and the file restored and confirmed clean. The old assertions passed
that same mutation.

## Counting basis, not a wrong count

The reviewer's sharpest bookkeeping point: CodeRabbit's finding 4 was a **basis switch**, not an
error correction. The old "twelve sites / fourteen fixed" was internally consistent on a SITES basis
(round B's fifth finding alone spans three evidence files). Sites cannot be pinned down — one finding
spans two locations, another a paragraph plus a table — so the findings basis is the crisper one and
is now used, with the sites reading recorded as having been self-consistent rather than wrong.

## One more over-claimed closure

`review-round-8.md`'s "All twelve fixed" claimed closure for three items round 10 later reopened:
A3's fact table, B5's supersession sweep (which missed `review-round-3.md`), and the round-1 note
B5 itself wrote. Qualified in place. This is the third round in which a resolution summary has
claimed more closure than it had, which is why the qualification is now written into the line rather
than left to the reader to reconcile across files.


## Two notes worth keeping

**Diagnostics.** The three anchor rejections originally returned the same empty string, so a failure
read `expected true, received false` with nothing saying whether the marker had vanished, been
duplicated, or fallen out of the final stage. They now return distinct sentinels and a dedicated
test names each one — the message someone reads at 3am when the fence finally fires.

**A probe written in a different language validates your MODEL, not your code.** The `$'`-expansion
defect was invisible to a Python probe of the same vectors, because `str.replace` has no such
expansion: the probe reported CAUGHT while the shipped JS controls were vacuous. Two tools
disagreed, and the one that was not shipping was trusted. That is the same failure this describe
block exists to prevent — a check that looks like it proves something and does not — one level up.


## Independent re-probe of the hardened predicate

A third reviewer lifted the shipped `fencedFatally` verbatim out of the test file — so the probe
could not go stale against a snapshot — and ran it over mutated real-Dockerfile bytes with function
replacers. **Zero misses**, across the three it had itself reported plus **four** it invented: `unit`
reassigned with no space (`…service;unit=/tmp/decoy`), the quoted form `unit="/tmp/decoy.service"`,
`exit 0` in place of `exit 1`, and `grep -E` losing its `-q`. (This said "five" and listed four —
a miscount corrected in round 18. Three reported plus four invented is seven probes; the "eight
vectors" totals elsewhere in this file count the eighth separately, the planted-`unit=`-inside-the-
echo false-positive check described in the next sentence, which is a probe but not a mutation that
should evade.) It also confirmed there is no false
positive when a `unit=` string is planted INSIDE the quoted echo message — correct today, and worth
knowing that this holds *positionally* (the reassignment check runs on the slice before the scan)
rather than because that check is quote-aware, so a future edit moving a `unit=` mention into an
earlier message string would false-positive.

One limit of the per-row guard, recorded so it is not read as the stronger claim: `expect(mutated)
.not.toBe(real)` proves the text CHANGED, not that it changed into what the label says — every
`$'`-corrupted row differed from `real` by +15 KB and would have passed it. The rows are correct
because they use replacer functions; that assertion only catches a pattern that has stopped
matching after a Dockerfile reword.
