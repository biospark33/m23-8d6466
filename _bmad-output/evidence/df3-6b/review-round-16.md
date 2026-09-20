# DF3.6b — code review round 16 (two CodeRabbit findings, and three the reviews found underneath)

**Date:** 2026-09-20 · **Trigger:** CodeRabbit's review of the round-15 push — one Minor, one Major.

## CodeRabbit's two

**Minor — two more sites describing the REJECTED placement-wrapper form.** Round 13 swept for these
and claimed to have closed them; it missed the `resident-cgroup.test.ts` Shipped-table row and a B2
history entry, both still saying `|| exit 97` when the shipped guard keys on membership read back
from `cgroup.procs`. Fixed. A sweep for the rest found **one more, which two rounds had now missed**:
`PlacementRefusedError`'s own docstring in `src/phase-engine/steering.ts` — the class a caller
implements the contract against, and therefore the worst remaining place for it. Fixed; that is what
moved the pin this round.

**Major — the owed image publish.** Correct, and already tracked in four places: an unchecked DoD
item, the prerequisites table, the NOT-DONE section, and the pin ledger's standing note. **The gap
was never in the tracking; it is in the doing.** But every one of those four described a MECHANISM,
and none stated the CONSEQUENCE, so the section now says it plainly:

> Until the image is rebuilt, re-published and the digest pin moved, DF3.6b DELIVERS NO ENFORCEMENT
> AT ALL. Merging this PR does not arm the bound.

Every in-box run against the currently pinned digest takes the AC3 refusal path — correct fail-closed
behaviour, and from the journal alone indistinguishable from a box that simply lacks delegation. The
publish is an OPERATOR action (a registry push plus a pin move), deliberately not taken from inside
this branch.

## What the three local reviews found underneath

### A Shipped-table row that overclaimed in the dangerous direction

The row said *"the four AC3 refusals"*. The block has four tests, but only **three** are refusals
(each asserting `CgroupUnenforceableError`). The fourth asserts the OPPOSITE — a garbage bound is
`not.toBeInstanceOf(CgroupUnenforceableError)`, because it is the caller's fault and not an
unenforceable box. Counting a control as a refusal reads as coverage that does not exist. Corrected
to three plus the control, naming what the control proves.

Everything else in that table verified accurate against the actual test titles, including the "89
entries" walk claim and the "42 arming sites" count.

### Two NOT-DONE items described by mechanism, not consequence

The Major above is one instance of a shape, so a reviewer audited the whole section for it. Two more:

**The unmeasured pi baseline is a PRODUCTION hazard, not a tuning task.** The falsifiers were phrased
in test-validity terms ("proves attachment rather than crossing"; "must be re-set before this
ships"). The real risk runs the other way: `PROVISIONAL_RESIDENT_RSS_BYTES` is 512 MiB and has never
been checked against a measurement. If pi's real baseline is high — 300–400 MiB is not absurd for a
model client holding a session — the default does not enforce weakly, it **OOM-kills ordinary
solicitations that were never runaway**, converting a safeguard into an availability regression. And
this story's own machinery makes the misfire indistinguishable from a genuine breach: `status:
"stopped"`, `exitStatus:"overflow"`, a `watchdog_kill` tripwire, resident silenced for the rest of the
run. The unknown's DIRECTION is the point: the shipped margin is unknown, not merely unoptimised.

**The live legs are not a formality.** Every mechanism claim in the Shipped table has only ever run
against an fs-level fake. No real kernel has yet accepted the placement write, enforced `memory.max`,
fired `memory.oom.group=1`, or produced a real `memory.peak`/`memory.events` pair. The wording invited
"implemented and unit-tested, pending a live check"; it now says the load-bearing kernel behaviour the
story exists to invoke **has never been observed once**.

### A reviewer's risk claim, checked and cut down

The same reviewer characterised the untested refresh-precedence direction as a risk that AC5's
`exitStatus` guarantee "could be silently false in production". Asked whether it had traced the code,
it said plainly that it had not — it derived the stake from the story's own framing. Tracing it:

- the refresh is guarded `if (residentSpawn !== undefined && residentBlock.exitStatus === null)`
  (`scripts/pipeline-run.ts:4738`);
- `"overflow"` is assigned in exactly ONE place repo-wide (`src/phase-engine/steering.ts:1253`).

A non-null `exitStatus` is therefore never overwritten. **The precedence direction is sound by
construction, not merely untested**, and no live round is needed to establish it. What is unproven
sits strictly upstream — that a real kill reaches the OOM arm at all — which is the AC1 live-leg gap,
not a second independent one. The story now says so, rather than double-counting the same gap.

Recorded because the reviewer's honesty about not having traced it is what made the correction cheap:
an unverified stake offered as an unverified stake costs one trace to resolve.

### And the cross-check that came back clean

Every unchecked DoD item maps 1:1 onto a NOT-DONE bullet — the two live legs, the baseline
measurement, the image publish. No item is tracked in one place and invisible in the other.

## Gates

`bunx tsc --noEmit` clean, Biome clean, `check-story-consistency` OK across 42 stories. Pin suite 234
pass. buildId re-pinned `f3548fdc` → `99b541b3`; the mover is a comment-only edit to
`src/phase-engine/steering.ts`.
