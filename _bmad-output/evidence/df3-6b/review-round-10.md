<!-- Round 10: CodeRabbit's stale-count finding, and the two full artifact audits it triggered. -->

# DF3.6b — code review round 10 (provenance and history audits)

**Date:** 2026-09-20 · **Trigger:** one Minor from CodeRabbit on PR #264 — `review-round-2.md` still
claimed "five walked image inputs" when only four are walked. Rather than fix the one instance, two
auditors swept the whole class: one for every count and provenance claim in the branch, one reading
the artifacts cold as the next engineer to pick the story up.

## What the provenance audit measured, not read

Ground truth taken by calling `buildIdFileInputs(realDockerfile())` directly: **89 walked entries**,
`oci/exedev/Dockerfile` absent, and exactly **four** walked inputs changed by this branch. Every
statement of that in the branch was found correct. Two discrepancies, one of them a regression this
branch introduced:

| # | Finding | Resolution |
|---|---------|------------|
| 1 | **The pin ledger's chain was broken by DF3.6b's own first re-pin.** Commit `1938e34b` wrote the DF3.6b entry OVER `b3c30d0c`'s paragraph, leaving that value the one literal in the chain a reader could not tie to a paragraph — precisely the invariant round 4 finding 3 established and claimed to have restored. | `b3c30d0c`'s paragraph restored verbatim from `origin/dev` above the DF3.6b entry, with a note recording that DF3.6b overwrote it and naming the invariant. The chain now reads `99af1da0:` → `b3c30d0c:` → `7d44bbda: moved from b3c30d0c`. |
| 2 | **The same function stated two walk sizes.** `trackedSetDigest`'s docblock said "~76 inputs … the other ~73" (written by DF1.10) while a comment 250 lines below said 89. | Corrected to 89/86, measurement dated, and the original figure kept so the drift is legible rather than erased. |

Seven further count drifts were found and fixed, all introduced by this branch's own write-ups:
"eight more sites" where twelve were enumerated; "5 + 2 minor" where one minor was listed; "four
test-only knobs" where five knob groups ship; "four new tests" in a note whose block has since grown
to eight; a 6-findings header over a 7-row table (1b is a caveat, now said so); "a fifth door" in two
places where ruling 9 correctly says sixth; and the whole-repo verification figure, re-measured at
**6336 pass / 7 skip / 5 fail** (it was 6084/5 when written, before the review rounds added tests —
the composition of the five is unchanged and independently confirmed).

One attribution error: the story called all five doors "the doors the EXIT SHAPE failed through",
but door (5) — the two-counter residual — has nothing to do with the exit shape. Corrected to name
the predicate, with the first four identified as the exit-shape ones.

## What the history audit found reading cold

| # | Finding | Resolution |
|---|---------|------------|
| 1 | **An inverted sentence, introduced while editing.** The story said the failing charge "is never rolled back before it reaches the high-water mark" — the negation misplaced, so it asserted the opposite of the code and of every other statement. A reader following it would conclude `OOM_PEAK_SLACK_BYTES` was unnecessary padding and **delete live code**; the surrounding text warns against GROWING the slack but nothing warned against removing it. | Corrected to match `page_counter_try_charge()`, and the missing warning added: *"Do not remove the slack on the strength of the peak being implied — implied is not equal."* |
| 2 | **Rounds 8 and 9 had no files** — they were appended sections inside `review-round-7.md`, so a directory listing showed seven rounds and made round 7 look like the latest word, while round 9 retracts round 7's central claim from inside round 7's own file. | Split into `review-round-8.md` and `review-round-9.md`; round 7 now ends with a pointer to its own retraction. Three dangling references created by the split were then found and fixed. |
| 3 | **The authoritative statement of the rule was the least precise of the four.** The RULED line mixed a compilable expression with prose, omitted the constant, and sent the reader to a different paragraph for the escape and to ruling 9 for the interpretation. | Replaced with a fenced block reproducing the shipped code exactly — `ownLimit`, `reachedBound` with both escapes and the named constant, `oomKilled` — verified by the auditor as self-contained on a cold read. |
| 4 | **Ruling 8's fact table still sold the peak floor as the third of three independent facts**, three lines above the prose that retracts it. The table is the most scannable element in the ruling. | The row now says in itself that it does not discriminate; the heading no longer says "PLUS a peak floor"; the "three facts" framing is corrected to two facts plus a consistency check. |
| 5 | **A retracted claim with no note at all**, in `review-round-3.md`'s "Verified correct" section — the worst place to leave one, because a positive verification claim is what a reader trusts. Round 8's sweep gave notes to rounds 1, 5 and 6 and missed round 3. | SUPERSEDED note added, distinguishing the part that stands (the anchoring) from the verdict it verified, which does not. |
| 6 | **Round 1's supersession note over-claimed closure** — it read as "door closed" when only the PLAIN global OOM is rejected; the survived-own-`oom` variant is still misclassified and irreducible. A reader chasing a false `watchdog_kill` would have ruled the door out. Round 6's note was followed by a run-on still reasoning in the present tense about a deleted branch. | Both corrected; round 1's note now says explicitly that the door must not be ruled out, and round 6's clause is in the past tense with "none of this clause describes current code". |
| 7 | **The story never referenced its own evidence directory** — nine rounds of provenance unreachable from the artifact a reader is handed. | The Dev Agent Record now opens with a provenance paragraph naming `review-round-{1..9}.md`, stating that later rounds retract earlier ones and that the rulings are current while the evidence files are history. |
