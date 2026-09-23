<!-- Split out of review-round-7.md so a directory listing shows every round. Content unchanged. -->

# DF3.6b — code review round 8 — CodeRabbit's full review, and the documentation sweep it triggered

**Date:** 2026-09-19 · CodeRabbit's seat block cleared, an incremental re-review was declined as
"already reviewed", and a `@coderabbitai full review` returned two findings. Two further local
rounds audited the fixes and found TEN DISTINCT FINDINGS the bot had not reached (round A's 5 + 1 minor, plus 4 of round B's 5 — round B's first repeats round A's heading finding). **Counted as FINDINGS, not sites:** the earlier "twelve sites" was not wrong on its own basis (B5 alone spans three evidence files), but sites cannot be pinned down — B2 spans two locations, A3 a paragraph plus a table — so the findings basis is the one used here and in the total below.

**CodeRabbit (2):** the story's E2E Slice and this report both still stated the OOM verdict as a
TWO-counter predicate after the peak floor was added — a statement that "can accept a global OOM
below the resident bound"; and the NOT-DONE list said `deriveBuildId`'s inputs had not been
re-derived, contradicting the Shipped record, which says the offline half was done in-commit.

**Local round A (5 + 1 minor)** — an exhaustive grep for every site that states the verdict, rather
than the two the bot named: the telemetry design-table row; ruling 8's own HEADING ("a counter
CONJUNCTION, and nothing else" — `memory.peak` is not a counter); ruling 8's "two independent facts"
paragraph and its two-row fact table, which contradicted the RULED line three lines below it; the
OOM-arm comment in `src/phase-engine/steering.ts`, which named `oom_kill` alone — the exact
single-counter formulation the ruling exists to reject; and `teardownLeaf`'s jsdoc, which claimed
the counter conjunction was "the whole predicate" and that it "takes NO argument", when it passes
`boundBytes` and that argument is what arms the peak floor. Minor: the Leg A live falsifier named
`oom_kill` alone as its criterion, which is weaker than the shipped verdict. Round A verified the
image/pin half end to end and found it consistent — both asset digests and the whole-walk literal
are live-correct against the tree, and no site claims the image was published.

**Local round B (5)** — read as the next person who has to ACT on the story: ruling 8's heading vs
its body (same as A's); the rule stated in the E2E Slice and the RULED line WITHOUT the degrade
escape that ships, so a reader implementing from either would ship a strict comparison and record
every real kill as a routine degrade on a pre-5.19 kernel — the false-negative direction ruling 8
itself calls the worse one; **the Technical Notes still specifying the placement wrapper that review
round 1 REJECTED** (`echo $$ > … || exit 97`), contradicting both the shipped code and the story's
own NOT-DONE list, so a reader implementing from that section builds the version whose refusal is
shell-dependent; the "three facts cross the boundary" interface block missing `boundBytes` from
`lastMemory()`, which is how the engine learns the bound it is required to name in the tripwire
detail; and **three earlier evidence reports still asserting the deleted exit-shape verdict** with
no supersession note — the same hazard round 7 had just fixed one layer down in a fixture comment,
left standing in the files the next reader goes to for history.

**All twelve fixed IN-ROUND** (ten local plus CodeRabbit's two) — **but round 10 later reopened three
of them**, and this line claimed closure they did not have: A3's fact table still sold the peak floor
as a third independent fact (round 10 finding 4); B5's supersession sweep gave notes to rounds 1, 5
and 6 and MISSED round 3, so "three earlier evidence reports" was an undercount (round 10 finding 5);
and the round-1 note B5 wrote itself over-claimed closure (round 10 finding 6). See
`review-round-10.md`. The Technical Notes now carry `_PLACEMENT_SCRIPT` character-for-character
with the rejected form named and quarantined; rounds 1, 5 and 6 carry `**SUPERSEDED by round 7**`
notes stating what actually ships; and ruling 8's door list is now enumerated so its "five times"
count is self-evidencing rather than asserted.

