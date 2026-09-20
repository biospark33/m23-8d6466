# DF3.6b — code review round 12 (CodeRabbit round 3 + the ruling-propagation sweep)

**Date:** 2026-09-19 · **Trigger:** CodeRabbit's third post-rebase review of PR #264 returned one
Minor documentation finding. Rather than fix the instance, this round asked why the same *class* of
finding had now arrived four rounds running, and swept all nine Dev Agent Record rulings for
propagation.

## What CodeRabbit found

**One Minor.** The AC4 Definition-of-Done checkbox still assigned the breach payload
`{bound:"rss", allowed:false, cause:"unenforceable", exitCode:97}` to the fleet `warn` line, where
ruling 7 had moved it to the engine-side `resident_bound_breach` fd-2 line. The AC4 body and the
Files table had both been amended when ruling 7 landed; the checkbox had not. Correct, and fixed.

## The pattern behind it, which is the actual finding of this round

Four consecutive rounds had each returned a single documentation Minor, and every one had the same
shape: **a ruling corrected the prose nearest to it, and left a superseded copy somewhere a reader
builds from** — a DoD checkbox, an AC body, a summary table, a JSDoc. A DoD checkbox is not
commentary; it is what an acceptance test gets written from, so a stale one aims a future test at the
wrong code path.

A single auditor swept all nine rulings against every site in the story and the shipped code. Counted at the
TOP LEVEL — 3b is a sub-ruling of 3, not a tenth ruling — rulings 1, 2, 4, 6 and 8 had propagated
fully and **four had not: 3 (with its sub-ruling 3b), 5, 7 and 9.** The table below lists 3 and 3b on
separate rows because they drifted at different sites and for different reasons; that is five rows
on four top-level rulings, and every count in this file uses the top-level basis.

**Ruling 7 belongs in the failed column, and an earlier version of this file put it in the
propagated one** (corrected in review round 13, by an auditor that checked the split against `git
show` rather than against this file's own prose). The error is self-refuting on inspection: the
paragraph directly above describes CodeRabbit finding ruling 7's AC4 checkbox still pointing at the
fleet `warn` line, and that checkbox was rewritten in this very commit. A round whose subject is
"rulings that failed to propagate" miscounted its own opening example — which is the same failure
mode the round documents, one level up.

| Ruling | Subject | Sites found out of step |
|--------|---------|-------------------------|
| 3 | the tripwire contract — DF3.3's closed five-key shape, `bound`/`allowed`/`cause`/`exitCode` on the fd-2 line | 4 (below) |
| 3b | `residentRssBytes` is ABSENT on the host-side `--manifest` flag shape | 4 |
| 5 | the arming refusal discriminates on `reason:"rss_unenforceable"`, not `cause:"unenforceable"` | 1 |
| 7 | the breach payload rides the engine-side `resident_bound_breach` fd-2 line, not the fleet `warn` line | 1 — the AC4 DoD checkbox, which is what CodeRabbit found and what opened this round |
| 9 | the peak floor is a consistency check implied by `oom`, not a discriminator | 3 |

### Ruling 3 and the shape-drift class — four sites

1. **The tripwire `detail` claimed a third fact that does not ship.** The Technical Notes said
   `detail` carries "the measured `memory.peak`, the bound it crossed, **and the cgroup leaf name**".
   `src/phase-engine/steering.ts` emits peak and bound only, and the leaf name is **structurally
   unbuildable** there: the engine's only channel is `deps.lastMemory?.()`, typed
   `{peakBytes, oomKilled, boundBytes?}`, while the leaf name exists solely fleet-side as
   `resident.${runId}.${seq}` and never crosses a seam the story fixes at three facts on two objects.
   The E2E Slice and AC1 both already said peak + bound; this clause was the outlier.
2. **The E2E Slice wrote the five-key tripwire with four keys**, dropping `requestId` — the
   per-solicitation join key, and the very key ruling 7's argument turns on. This is the section an
   implementer reads first, written as a literal object.
3. **Two summaries named the REJECTED placement-wrapper form as shipped.** Both the DoD Impl checkbox
   and the Shipped table described the wrapper as `... || exit 97`. The shipped guard keys on
   **membership read back from `cgroup.procs`**, never on the write's exit status — a distinction the
   story amends at length elsewhere, and `src/fleet/resident.ts` keeps the rejected form in a comment
   precisely to say "it is not the shipped guard". One of the two was a build-from checkbox.
4. **A ruling pointer aimed at the wrong ruling** — the `inBoxFrontDoor` latch cited "ruling 3"
   (the tripwire contract) instead of ruling 3b. The broken pointer was the one aimed at where the
   INV-MEM-2 scope deviation is confessed.

### Ruling 3b — four sites

The E2E Slice justified dropping a fourth darwin leg on the grounds that it "would inherit a darwin
spawn with `residentRssBytes` PRESENT and INV-MEM-2 would disable the resident" — false under 3b,
which is exactly that the host-side shape WITHHOLDS the bound, so nothing is disabled. The conclusion
survives on independent ground (darwin has no cgroups); only the reason was wrong. Two further sites
described absent-means-no-cgroups as "the host-side **unit-test** context", too narrow: the
`pipeline-run --manifest …` runtime shape withholds it too, which includes the darwin tier-4 live
legs. The fourth was `readLeaf`'s neighbouring JSDoc in `src/fleet/resident.ts`: **"In production it
is never absent"** — a production invocation can reach it with the field absent.

### Ruling 9 — three sites, and one of them was a test

Ruling 9 said "the wrong version was repeated downstream before it was caught" and **enumerated no
member**, which is why all three members survived it.

1. **A test asserting the retracted claim.** `tests/fleet/resident-cgroup.test.ts` carried a row
   titled *"a graceful `oom` EARLIER plus a global OOM kill LATER is still not this bound firing"*.
   It staged `oom 1, oom_kill 1` with a 4096-byte peak against the 64 MiB bound and read `false` —
   but it read `false` **only on the peak floor**, i.e. on exactly the discrimination ruling 9
   retracts, and the reading it staged is one the kernel cannot produce, since `oom > 0` implies the
   peak reached the bound. In the real pairing the early own-limit `oom` drives the peak TO the
   bound, the floor passes, and the verdict is `true`. The row was renamed to what it actually pins —
   *a SELF-CONTRADICTORY reading … is rejected* — and **a second row now pins the residual itself**:
   all three counters set with `peak = bound`, asserting `oomKilled === true`, the MISLABEL, with a
   note to update the row and the ruling rather than delete it if the residual is ever closed.
   Mutation-verified: deleting the peak conjunct turns the renamed row red.
2. **`readLeaf()`'s own comment block** asserted "A THIRD FACT" as a heading **twelve lines above**
   its own ruling-9 correction. A reader going end to end lands correctly, but the retracted framing
   was still stated affirmatively upstream of its retraction. Reworded, with the paragraph-order
   hazard named.
3. **`readLeaf()`'s JSDoc**, which sits ABOVE the body and so was never reached by any of the body's
   three self-corrections. It presented the peak conjunct as a co-equal third member of the
   conjunction — the framing ruling 9 denies — and it is what a caller sees on hover without opening
   the body.

Ruling 9 now enumerates these three explicitly. **A ruling that names a class of stale sites without
enumerating them does not propagate** — that is this round's durable lesson, and it is why the list
is written out rather than described.

## Three local adversarial reviews before push

| Reviewer | Scope | Result |
|----------|-------|--------|
| A | the working-tree diff, adversarially: is the new residual row vacuous, does the renamed row's title match what it stages, does the new JSDoc contradict the body | **Clean.** Independently verified the ruling-3b claim at source — `residentRssBytes: inBoxFrontDoor ? loadedBounds.residentRssBytes : undefined`, with `inBoxFrontDoor` set only inside the `argv[0] === "run"` branch — and traced both test rows through `ownLimit`/`reachedBound` rather than reading their titles. |
| B | exhaustive doc-vs-code re-sweep of rulings 3b and 9 across story, `src/fleet/resident.ts`, `src/phase-engine/steering.ts`, `scripts/pipeline-run.ts`, four test files and every `review-round-*.md` | **Clean.** Correctly declined to report `review-round-7.md:95`, which carries its own retraction banner. |
| C | test-quality audit of all rows in the OOM-verdict describe block: which conjunct decides each row, and whether the row is vacuous with respect to its own title | see below |

One overcorrection was caught and checked before it shipped: the new JSDoc says the peak conjunct is
"implied by `oom > 0`", which holds only on a CHILDLESS leaf — the body says the implication breaks
once the leaf gains children, since `memory.events` aggregates upward. The JSDoc carries that caveat
parenthetically, so it does not overclaim.

### Reviewer C — two rows that did not test what their titles claimed, and one escape nobody pinned

C audited every row in the OOM-verdict block by determining, per row, **which conjunct actually
decides it** and whether the row would survive that conjunct's deletion. It cleared most rows,
confirmed row 1035 is the only one decisive on the floor, confirmed the one-allocation-short row is
decisive on the `OOM_PEAK_SLACK_BYTES` VALUE specifically (a targeted `slack → 0` mutation, which it
alone catches), and confirmed the fixture's `peakBase × seq` multiplier is identity for this block
because every row makes exactly one solicitation.

Two rows were defective in the same way:

- *"a GROUP kill on this leaf (`oom_group_kill` set) IS this bound firing"*
- *"an own-limit OOM on a pre-5.17 kernel (no `oom_group_kill` line) still counts"*

Neither staged `peakBase`, so `memory.peak` read 0 and `reachedBound` was satisfied by the
`peakBytes === 0` escape rather than by any comparison against the bound. The assertions were
correct and the rows were not false passes — but a row whose title says **"IS this bound firing"**
that never stages a peak pins `ownLimit` and says nothing about the bound. Both now stage
`peak = BOUND` and assert it. Verified by mutation: with the `peakBytes === 0` escape removed, both
rows still pass, which is what proves they no longer lean on it.

That mutation also exposed a **coverage gap neither CodeRabbit nor the sweep had found**: the
`peakBytes === 0` escape itself was pinned by nothing. It is deliberate fail-open behaviour —
`memory.peak` landed in kernel 5.19, and before that the file does not exist, so the floor must fail
OPEN there because suppressing a REAL kill on a MISSING measurement trades a false positive for a
false negative, and a resident blowing its bound every solicitation while the run records a routine
degrade is the worse direction. Two rows depended on the branch incidentally; none NAMED it, and an
escape nobody pins is an escape a future tightening deletes without noticing. A row now pins it
directly — real kill counters, no `memory.peak` file at all, expecting `true` — and is
mutation-verified red when the escape is deleted.

Row counts, corrected in review round 13 after an auditor measured them: the OOM-verdict describe
block holds **13 rows before this round and 15 after**. The figures 37 and 39 that stood here are the
WHOLE FILE's `test(` count before and after, mislabelled as the block's — both numbers were real,
attached to the wrong noun.

## Process note, recorded because it nearly cost a bad revert

Reviewers A and C ran concurrently against the **same working tree**, and C was authorised to apply
temporary mutations to `src/fleet/resident.ts` and revert them. A read the file mid-mutation and
reported `const ownLimit = true;` as a CRITICAL correctness regression — correct reasoning about the
blast radius, aimed at text that was never in the diff. `git diff` showed the predicate unmodified
against HEAD and the suite green. **Concurrent reviewers and a mutating reviewer must not share a
working tree**; the mutating audit belongs in a worktree. Dispatch error, not a reviewer error, and
the lesson is cheaper to record than to rediscover.
