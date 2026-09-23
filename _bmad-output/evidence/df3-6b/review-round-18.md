# DF3.6b — code review round 18 (CodeRabbit recovers; a defect SHAPE swept as a class)

**Date:** 2026-09-20 · **Trigger:** CodeRabbit returned three Minors after recovering from a
~95-minute outage (three acknowledged requests, one review delivered at 04:15Z).

## The three, all correct

| # | Site | Finding |
|---|------|---------|
| 1 | `review-round-11.md` | "plus five it invented", four listed. |
| 2 | story, Observability Contract | The opening bullet still gave the PRE-AMENDMENT record shape. |
| 3 | story, Leg A live falsifier | Demanded `memory.peak` "at the bound" — stricter than what ships. |

**Finding 3 is the one with teeth.** The shipped predicate accepts
`peakBytes >= boundBytes - OOM_PEAK_SLACK_BYTES`, and the slack is not padding: the charge that
TRIGGERS the OOM is the one that FAILS, rolled back by `page_counter_try_charge()` before the
watermark write, so at the kill committed usage sits below the limit by up to that charge. **A live
leg asserting equality would reject a genuine own-limit kill** — the failure direction the escape
exists to avoid. Corrected to the slack-aware form with the rationale, verified against the code's
own kernel-sourced comment.

**Finding 2 is consumer-facing.** The bullet gave one line shape
`{ requestId, runId, phase, bound, rssPeakBytes, residentRssBytes, allowed }`; round 1's amendment,
further down the same section, had reassigned the measurement pair to fleet's `resident_cgroup` line
and never amended the bullet. Rewritten as two explicit shapes, and verified field-for-field against
both emitters:

- **fleet `resident_cgroup`** (`src/fleet/resident.ts`, in `teardownLeaf`) — carries the
  `rssPeakBytes`/`residentRssBytes` pair, keyed on `runId` + a per-resident `seq`. It has **no
  `requestId` and no `phase`**, and a reviewer confirmed that is STRUCTURAL rather than incidental:
  no such parameter exists anywhere in that file's scope. A consumer joining on them finds nothing.
- **engine `resident_bound_breach`** (`scripts/pipeline-run.ts`, typed in `src/phase-engine/steering.ts`) —
  `{bound, allowed, cause, exitCode?, runId, requestId?, phase?}`, and **no measurement pair**.

Finding 1 reconciles: four invented plus three reported is seven probes, with the file's "eight
vectors" totals counting an eighth separately — a false-positive control, not a mutation that should
evade. An independent recount confirmed every tally in that file agrees.

## The shape, swept as a class

Finding 2 was the **third instance of one defect shape**:

> A lead sentence, opening bullet or section header states a claim in its ORIGINAL form, and the
> amendment correcting it sits BELOW it. A reader who stops at the lead gets the superseded answer,
> and a grep for "is this documented?" says yes.

Prior instances: `readLeaf()`'s body comment asserting "A THIRD FACT" twelve lines above its own
ruling-9 correction; INV-MEM-1's lead sentence asserting the retracted address-space clause directly
above its own "AMENDED 2026-09-18" paragraph.

**Why it survives sweeps:** every previous sweep looked for a WRONG CLAIM. This shape is a correct
claim with a wrong preamble — the document contains both, so any check that asks "does the story say
the right thing?" passes.

So this round swept for the shape rather than the site: the full story read end to end, plus a
targeted pass over every AC body, the Trigger Surface and Infra Prerequisites tables, all Technical
Notes bullets, both Observability Contract bullets, every Security Invariant, every Files-to-Modify
row, every DoD checkbox and the Split Record, each checked against the Dev Agent Record ruling that
amends it.

**Result: no further instances.** Every candidate is either corrected in the same sentence or closed
by a ruling that names its site inline. **No inverse case either** — no site where the lead is now
correct and a surviving amendment below it is the stale one.

### One variant found, and fixed

The handoff section **"Handed off from DF3.6a's review round 1 — read before scoping"** restates four
items as open instructions. All four are closed, in "Rulings this story owed" — but that sits EARLIER
in the record, so this is the shape's mirror image: resolution above, unresolved-sounding restatement
below. Lower risk for a top-to-bottom reader, who meets the closures first. Except the header says
*read before scoping*, which invites landing there cold, and then four done items read as work.

Marked CLOSED at the section head with a pointer, keeping the handoff verbatim rather than rewriting
history.

## Also this round

The full suite was re-run on head `3c05ec39`: **6344 pass / 7 skip / 5 fail** — the +4 is round 17's
EBUSY-retry rows, and the five failures are the same pre-existing set (2 DF2.11 WAL, which reproduce
on `dev` with this branch stashed; 2 gitnexus index staleness; 1 load-sensitive fleet-CLI timeout).
The story's verification paragraph is updated from 6340 to the measured figure.

## Gates

No walked input changed — story, evidence and the round-11 report are all outside
`buildIdFileInputs` — so `660ae409` stands and no re-pin is owed.
`check-story-consistency` OK across 42 stories.
