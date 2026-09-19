# DF3.6b — code review round 7 (CodeRabbit round 2 + the predicate specification)

**Date:** 2026-09-19 · **Trigger:** CodeRabbit's post-rebase review of PR #264, one inline finding,
plus two local adversarial rounds on the fix.

## What CodeRabbit found

**"Do not treat exit code 137 as proof of signal death."** `QDS_PI_BIN` can exit 137 voluntarily;
when `signalCode` is null, both `call()` and `stop()` classified that as a signal death, so a leaf
carrying a graceful own-limit `oom` counter reported `oomKilled: true` with no OOM kill anywhere.
Correct, and the first fix narrowed the discriminator to `exitCode === null || signalCode !== null`.

## What the local rounds found — the fix was the fourth patch to an unspecified predicate

The OOM verdict had by then been corrected four times, each from a different door: (1) `oom_kill`
counted global OOM kills, (2) an own-limit `oom` with no kill at all, (3) `stop()` assuming a kill it
had not verified, (4) a voluntary exit 137. A reviewer derived the predicate from first principles
instead, with kernel source, and found **two HIGH defects still live**:

| # | Sev | Finding |
|---|-----|---------|
| 1 | HIGH | **`oom_group_kill` is NOT own-limit-only**, which the code's own comment assumed. On a global OOM `oom_domain` is the root, so `mem_cgroup_get_oom_group()` walks up from the victim, finds THIS leaf's `oom.group=1`, group-kills it and increments `oom_group_kill` **here** — on a leaf whose own limit never fired. The exact scenario the comment writes out (a `dispatch_task` worker drives the box into global OOM, the kernel picks pi) still produced a self-contradicting `watchdog_kill` row with `memory.peak` far below the bound. Door #1 had been moved one counter to the right, not closed. |
| 2 | HIGH | **Our own SIGKILL was counted as the kernel's.** Both SIGKILLs this code sends — the native solicit timeout and `stop()` — set the signal-death flag. A pi that took a graceful `-ENOMEM` and then wedged was filed as a `watchdog_kill` with `exitStatus:"overflow"` when the timeout killed it; the same leaf plus a Ctrl-C did likewise. Reading the child's end off the settled handle distinguishes only the child that had ALREADY exited — in the ordinary interrupt, we killed it. |
| 3 | MED | **The 137 fix traded a false positive for a false negative.** If the Bun quirk the file guards for is real, a true own-limit kill surfacing as exit 137 with a null `signalCode` now read `oomKilled: false` — a resident blowing its bound every solicitation while the run records a routine degrade. |
| 4 | MED | The tests pinned the cases that were found, not the cases that exist — four specific rows missing. |
| 5 | LOW | The story still documented `oom_kill` as the verdict input, and recorded none of the four corrections. |

## Resolution — specified, not patched

**Ruling 8** (story Dev Agent Record): the verdict is the kernel's own record and nothing else.

```
oomKilled = oom > 0                                // this leaf's OWN limit fired
         && (oom_kill > 0 || oom_group_kill > 0)   // something in it was killed
         && memory.peak >= bound - 2 MiB           // the kill happened AT the limit
// …with the third conjunct SKIPPED when the measurement is unavailable:
//   peakBytes === 0 (pre-5.19 kernel) || boundBytes === undefined
// Suppressing a real kill on a missing measurement is the worse direction.
```

`oom` says *this leaf hit its own limit and could not reclaim* — raised only on the own-limit charge
path, never for a global or an ancestor's OOM. `oom_kill`/`oom_group_kill` says *something in it was
killed*. Neither alone is the predicate; each alone shipped a false verdict here. **Nor are the two
together sufficient** — they are independent counters, so a graceful `-ENOMEM` early paired with a
global kill later sets both — **and the peak floor does NOT separate them, contrary to what this
section originally claimed; round 9 below retracts it** (finding 1 of the two
follow-up rounds below; the floor carries 2 MiB of slack because the charge that TRIGGERS the OOM is
the one that FAILS and is never added to `memory.current`). The process's exit
shape is **deliberately not consulted**: it is a proxy for *was it killed* that cannot say *by whom*,
which is the entire discrimination. `killedBySignal`, `diedBySignal` and `teardownLeaf`'s `killed`
parameter are deleted — a net deletion across three call sites.

Five test rows added, one per enumerated case: a global OOM that group-kills through our leaf →
false; the timeout's own SIGKILL on a leaf with a graceful `oom` → false; `stop()`'s SIGKILL on a
live child, same leaf → false; a real own-limit kill surfacing as exit 137 with a null `signalCode`
→ true; and an own-limit kill whose process exited cleanly → true, which pins that the verdict no
longer consults the process end at all and is what a correction #5 would most plausibly undo.

The two prose sites that still named `oom_kill` as the input were amended to the conjunction.

**Engine side checked and clean:** `steering.ts` adds no interpretation — it reads `lastMemory()`
only in the call-failure catch, treats a throwing dep as "no kill", and orders the OOM arm after the
`PlacementRefusedError` arm and before the degrade latch. It is, however, what converts a false
verdict into a `watchdog_kill` row plus a permanent `status:"stopped"` gate for the rest of the run,
so the blast radius of getting this predicate wrong is the run's resident plus poisoned D4 demotion
evidence — which is why it is now specified rather than inferred.


## Two further local rounds on the rewrite itself (same day)

The rewrite was reviewed twice more before pushing. Both rounds ran mutation checks rather than
reading — each reverted the predicate to a single counter and confirmed which tests caught it.

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | MED | **The residual the conjunction only NARROWED.** The two counters are independent: a solicitation that took a graceful `-ENOMEM` early (`oom` 1, survived) and was later picked by the system-wide OOM killer (`oom_kill` 1) sets both, and nothing in the counters says the events are unrelated — a pairing that is not exotic, since global OOM happens exactly when the box thrashes and the near-bound resident is the likeliest victim. Ruling 8 read as though the false positive were eliminated. | A THIRD fact, already in hand and unused: an own-limit kill cannot happen below the limit, so `memory.peak` must have reached the bound while a global victim's sits under it. `readLeaf` takes the bound and ANDs it in — applied only when both figures exist, since a pre-5.19 kernel reads `memory.peak` as 0 and suppressing a real kill on a missing measurement is the worse direction. New test row; ruling 8 amended to state the third fact and to accept-and-state that an ancestor-limit OOM reads false here. |
| 2 | MED | **The timeout test was vacuous** — found independently by both reviewers. At `QDS_RESIDENT_TIMEOUT_MS: "150"` the SIGKILL lands during the fixture's own startup, before it stages `memory.events`, so the assertion held against an EMPTY leaf rather than against "a graceful `oom` plus our own SIGKILL". Proven by mutation: reverting the verdict to `oom > 0` alone left this test green while the other three negative rows failed. | Timeout raised to 3000 ms, and the test now also stages `memory.peak` and asserts it, so a future timing shift cannot silently re-empty the case. |
| 3 | MED | **The shared fixture's comment stated the opposite of the shipped rule** — "the verdict requires BOTH the counters AND an actual signal death" — sitting in the file every future OOM test reads, where it would talk a correction #5 straight back into the exit-shape conjunction. | Rewritten to say the knob does not affect the verdict, and why. |
| 4 | LOW | Two poll loops could fall through without their staged file and pass vacuously; `readLeaf`'s jsdoc still named `oom_kill` as "the kill itself"; `stop()` carried a stale duplicated comment ending "so `killed` is true" for a parameter that no longer exists. | All fixed. |

| 5 | MED | **The peak conjunct, as first written, introduced a MISSED kill.** It required `peak >= bound` exactly. `memory.peak` tracks `memory.current`, and the charge that triggers the OOM is the one that FAILS — never added to `current` — so at the kill usage sits below `memory.max` by up to the failing allocation: 256 KiB for an ordinary batched page charge, **2 MiB for a THP fault**, more for a large kmalloc. Against the 64 MiB fixture bound that is a ~3% shortfall read as `false`: a genuine kernel OOM kill of the resident's own bound reported as a routine degrade, which is the exact direction the missing-measurement escape exists to avoid, and the ratio worsens on smaller bounds. | The comparison carries 2 MiB of slack, documented as part of the rule rather than as padding (**the "sized to a THP fault" derivation given here was WRONG — see round 9: a failed THP charge cannot raise `oom` at all, so the real case is the 256 KiB batch path and the constant is ~8x more headroom than needed**) — the false positive being targeted is a peak sitting FAR below the bound, not one 2 MiB short. New test row at `peak = bound − 2 MiB` with a real kill's counters, expecting `true`, which fails against the strict comparison. Also noted in the code: `boundBytes` is what we WROTE and the kernel `PAGE_ALIGN`s `memory.max` upward, moving the real limit away from the peak — the safe direction, so no adjustment. |

Both reviewers confirmed the conjunction misses no real own-limit kill: `oom` is raised on every
own-limit path (the charge path, the page-fault deferred path, and `memory_max_write` when the limit
is lowered below usage), and `__oom_kill_process` increments `oom_kill` per victim including each
member a group kill walks, so `oom_group_kill > 0` implies `oom_kill > 0` and the disjunct never
strands a kill. No read-ordering hazard: both counters are published before the victim dies, so a
teardown that reads after `proc.exited` cannot read them too early. `killedBySignal` and
`diedBySignal` have zero remaining readers repo-wide, and DF3.3's untouched signal-death branch
writes only `lastExit` and the session quarantine — it has no path into the journal's `exitStatus`,
which is assigned in exactly one place, inside the OOM arm.


## Round 8 — CodeRabbit's full review, and the documentation sweep it triggered

**Date:** 2026-09-19 · CodeRabbit's seat block cleared, an incremental re-review was declined as
"already reviewed", and a `@coderabbitai full review` returned two findings. Two further local
rounds audited the fixes and found eight more sites the bot had not reached.

**CodeRabbit (2):** the story's E2E Slice and this report both still stated the OOM verdict as a
TWO-counter predicate after the peak floor was added — a statement that "can accept a global OOM
below the resident bound"; and the NOT-DONE list said `deriveBuildId`'s inputs had not been
re-derived, contradicting the Shipped record, which says the offline half was done in-commit.

**Local round A (5 + 2 minor)** — an exhaustive grep for every site that states the verdict, rather
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

**All fourteen fixed.** The Technical Notes now carry `_PLACEMENT_SCRIPT` character-for-character
with the rejected form named and quarantined; rounds 1, 5 and 6 carry `**SUPERSEDED by round 7**`
notes stating what actually ships; and ruling 8's door list is now enumerated so its "five times"
count is self-evidencing rather than asserted.


## Round 9 — CodeRabbit's Major on attribution, and the correction it forced

**Date:** 2026-09-19 · One finding, accepted; its two proposed remedies verified unavailable; and it
exposed a false claim this very report had made.

**The finding.** "A graceful own-limit allocation failure can increment `oom` and leave
`memory.peak` near the bound without killing pi. If a later global OOM kills pi, `oom_kill` also
increments because it counts kills by any OOM killer. All three factors then pass, although
`memory.max` did not kill the process. Classify this state as ambiguous, or add an attribution
signal." **Correct, and it identifies a state the peak floor was claimed to close.**

**What two independent kernel-source reviews established:**

1. **The two states are byte-identical in every readable file.** Both terminate as `oom>=1,
   `oom_kill>=1`, `oom_group_kill>=1`, `peak≈bound`, `current≈0`. `memory.events.local` equals
   `memory.events` on a childless leaf (`memcg_memory_event()` propagates UPWARD only), and
   `oom_group_kill` is credited by `mem_cgroup_get_oom_group()` to the highest ancestor setting
   `oom.group` — which for a global OOM, with no ancestor setting it, is still this leaf. So
   **"classify as ambiguous" is not implementable**: there is no field whose value differs, and the
   classification would swallow every true kill and destroy AC1.
2. **The peak floor never discriminated anything here.** `oom > 0` means the failing charge was
   about to cross the limit; that charge is never added to `memory.current`; `memory.peak` is
   monotonic and never reset (reset API is 6.11+). So `oom > 0` **implies** `peak >= bound - slack`.
   The narrowing was always done by `oom`, which excludes the plain global victim. **This report's
   round-7 follow-up finding 1 claimed the third fact "closes it"; that was wrong**, and the wrong
   version reached the story, the code comment and a PR comment before it was caught.
3. **The one true attribution signal exists and is not reachable.** `mem_cgroup_print_oom_context()`
   logs `oom_memcg=<path>` for a memcg-limit kill versus `global_oom` for a global one. Unreachable
   for `User=exedev`: `CAP_SYSLOG` is required under `kernel.dmesg_restrict=1` (Debian/Ubuntu
   default — the node's permissive mode bits mislead; the capability check is what refuses), and
   journald ACLs the kernel journal to groups a service user is not in. Buying it costs an ambient
   capability plus a log-parsing and time-correlation path, to remove a residual whose cost is a
   mislabel. A `poll()` watcher on `memory.events` was also rejected: kernfs notifications coalesce
   when the reader has not drained, so on a thrashing box — the only condition where this arises —
   it wakes with both counters already moved and reports a true kill, failing hardest in the case it
   exists to catch.

**Blast radius, traced through the code rather than assumed.** A false positive writes
`status:"stopped"` / `exitStatus:"overflow"` / one `watchdog_kill` row and stops the spawn; a false
negative writes `status:"degraded"`, no row, and the run-down refresh fills `exitStatus` from the
process probe as `"transient"`. **Both are terminal for the resident** — the status gate is
`telemetry.status !== "active"` and nothing after construction ever writes `"active"` back, so
`"degraded"` ends participation exactly as `"stopped"` does. Neither moves a phase, a gate, a budget
or the exit code. The difference is evidentiary, and the cost falls on D4's demotion count. A false
negative is not evidence-free either: the fleet `resident_cgroup` line still carries `rssPeakBytes`,
`residentRssBytes` and `oomKilled:false` on fd-2.

**Two facts that make the residual acceptable rather than merely tolerated.** `oomKilled` is a
LABEL, never a control — it gates no allocation and admits no unbounded call, so a mislabel costs
reporting accuracy and not containment; and in the residual state `oom >= 1` is TRUE and
unforgeable, so the row is over-specific rather than fabricated. Stopping the resident is the
correct action for the fact that IS proven; only the identity of the final killer is not.

**The remedy would also cost more than the residual.** To be worth anything an "ambiguous" state has
to be journal-readable, which means widening two closed unions neither owned by this story —
`ResidentStatus` (DF3.3's AC5 forbids a fourth value) and `ResidentTripwire["cause"]` (DF3.6a's) —
and at the gate it still resolves to one of the two existing dispositions. It adds a name, not
information.

**Disposition: finding ACCEPTED, remedies DECLINED with reasons, residual recorded as ruling 9.**
The peak conjunct is kept — it is free, it catches a self-contradictory reading, and it stops being
implied the moment the leaf gains children with smaller limits. The comment and the story now call
it a consistency check rather than the discriminator, and state the residual precisely: a global OOM
that kills a resident whose leaf had **already registered its own `oom` event and survived it**. The
precondition is narrower than "a resident near its bound", and that distinction is stated so the
residual's reach is not overread.
