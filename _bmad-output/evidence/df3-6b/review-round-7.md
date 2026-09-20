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
section originally claimed; round 9 retracts it — now `review-round-9.md`, no longer below** (finding 1 of the two
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
| 1 | MED | **The residual the conjunction only NARROWED.** The two counters are independent: a solicitation that took a graceful `-ENOMEM` early (`oom` 1, survived) and was later picked by the system-wide OOM killer (`oom_kill` 1) sets both, and nothing in the counters says the events are unrelated — a pairing that is not exotic, since global OOM happens exactly when the box thrashes and the near-bound resident is the likeliest victim. Ruling 8 read as though the false positive were eliminated. | A THIRD fact, already in hand and unused: an own-limit kill cannot happen below the limit, so `memory.peak` must have reached the bound while a global victim's sits under it. **RETRACTED by round 9 (`review-round-9.md`): the peak floor discriminates NOTHING here — `oom > 0` already implies the peak reached the bound, so the narrowing was always done by `oom`. The conjunct is kept as a consistency check, not as a third independent fact.** |
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

> **Rounds 8 and 9 were originally appended to this file and have been split out** into
> `review-round-8.md` and `review-round-9.md`, so a directory listing shows every round. **Round 9
> retracts this report's claim that the peak floor closes the global-OOM residual** — read it before
> relying on anything here about the verdict.
