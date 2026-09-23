# DF3.6b: Resident Memory Bound — Kernel-Enforced via cgroup v2 `memory.max`

**Story Points:** 3
**Sprint:** v5-S3 (fleet band) — sequenced **after DF3.6a** (which widens the `cause` union this
story writes into and validates the `residentRssBytes` this story applies) and **after a DF2.10
image re-pin** (this story changes the unit baked into the image; see DoD).

> **Split provenance.** This story is the second half of **DF3.6 "Resident-Agent Bounds —
> Iterations, RSS, and an Absolute Spend Ceiling Enforced by the Engine"** (3 pts, last authored
> 2026-08-20), split on **2026-09-08** by the QDS story-review campaign at the **provability seam**.
> DF3.6a is engine policy over numbers the engine already holds, and every assertion in it is
> falsifiable host-side with `bun test`. This half is *kernel enforcement over a process the engine
> does not own* — a delegated cgroup, a `memory.max` write, an OOM-kill the engine never signals —
> and its make-or-break AC **cannot be proven anywhere but a real box**. Nothing crosses the seam
> except the manifest's `residentRssBytes` value, which DF3.6a validates and carries and this story
> applies.
>
> The seam is not a line-count halving: the two halves differ in *what can prove them done*. This
> one needs a box, an image rebuild and a live round; DF3.6a needs none of those. The mechanism is
> `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` **Appendix B** (ACCEPTED 2026-09-08),
> which ruled that F12 means **enforce**, not observe, and that *a bound on component X is rooted at
> X's pid, never at an ancestor's*. The 3+3 re-point is deliberate: DF3.6 was under-pointed because
> it assumed a `ps` sampler where the ADR now requires kernel enforcement.

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §5.2 (the F12 invariant: "the resident agent is itself watched … enforced by the phase engine, not by the agent"), §5.1 tier 2, §6 item 5
- Decision register: v5 §4 **D4** (tripwires F7); findings **F12** (no watchdog on the resident agent), **F7**. **Risk R3** (DF2.4's group-kill doctrine) is **discharged by the kernel here, not by this story**: the OOM kill is the cgroup's, so there is no SIGTERM→grace→SIGKILL sweep for R3 to govern. R3 continues to govern `stop()`, which this story calls (AC5) and does not modify.
- **`docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` Appendix B (ACCEPTED 2026-09-08)** — the load-bearing citation for this story: enforcement not enumeration, cgroup v2 `MemoryMax=`, rooted at the component's pid, and — per the appendix's **same-day correction** (`:185-193`) — DF5.1's host-side `ps`-sampled ceiling left **open and untouched**, because this mechanism is available in-box only and does not generalise to a possibly-darwin host
- Binding facts: R5 §6 fact **5** (the RSS watchdog is *re-aimed*, not deleted). **Superseded in mechanism by Appendix B** — see Technical Notes; the fact's *intent* (the resident is a genuinely local subprocess tree in-box, so bounding it is now correct) holds and is exactly what makes a cgroup possible.

## User Story

As the factory host paying for every sandbox,
I want the resident agent's memory bounded by the kernel rather than watched by a poller,
so that a resident that leaks is killed the moment it crosses the line — not reported after it has already OOM'd the box — while the run still finishes deterministically.

## Overview

Every **in-box** pi solicitation runs inside its own cgroup v2 leaf with `memory.max` set from the
manifest's `residentRssBytes` **and `memory.oom.group` set to `1`**. **"In-box" is load-bearing and
was missing from this sentence until round 20** (found by CodeRabbit; the same ruling-3b propagation
the story has fixed at several other sites): `residentRssBytes` is OPTIONAL on `ResidentSpawnOpts`,
and the host-side `pipeline-run --manifest …` shape withholds it, so those solicitations run with **no
cgroup machinery at all and no memory enforcement**. That is deliberate — darwin has no cgroups, and
arming there would disable DF3.3's and DF3.6a's whole host-side behavioural coverage — but a reader
who takes this opening sentence literally will assume host-side runs are bounded. They are not. Only
the `run <runId>` in-box front door supplies the bound; see INV-MEM-2's Scope clause and ruling 3b. The `oom.group` write is what makes
"OOM-kills that cgroup" true rather than approximately true: at the kernel default (`0`) the OOM
killer picks and kills a **single task**, leaving siblings running — which would leave the leaf
un-`rmdir`-able (`EBUSY`) and produce exactly the orphaned child AC1 asserts cannot exist. Today pi
is spawned `--no-tools` (the pi spawn argv in `src/fleet/resident.ts`) and usually has no children, so the
single-task kill happens to equal the cgroup kill and a test would pass for the wrong reason. The
kernel enforces it: crossing the bound OOM-kills that cgroup and nothing else. The engine issues no signal, runs no timer, takes no sample, and never learns pi's pid. After
the call the fleet layer reads `memory.peak` and `memory.events` from the leaf, reports them up as
telemetry, and removes it.

**Everything above describes the DESIGN, and as of this PR the kernel half of it has never been
observed** (qualified round 20, found by sweeping for universal claims a scope falsifies): every
mechanism claim in this story has only ever executed against an **fs-level fake** cgroup tree. No real
kernel has yet accepted the placement write, enforced `memory.max`, fired `memory.oom.group=1`, or
produced a real `memory.peak`/`memory.events` pair. "The kernel enforces it" is how this is BUILT, not
evidence that it works — AC1's live legs are what would establish it, and they have not been run. Read
the NOT-DONE section before treating any of it as established.

**When a bound is supplied** and the cgroup cannot be created or `memory.max` cannot be written, the
resident is **not started** — the engine never runs an agent whose memory it cannot bound. The
host-side shape never reaches that check, because no cgroup is attempted: **it starts normally and
runs unbounded, it is not refused.** (Qualified round 20 — without it, a reader who has just absorbed
the in-box scoping above reads this sentence as "no cgroup was created, so the resident refuses",
which is exactly backwards. Verified in code: the whole arming block is gated on
`boundBytes !== undefined`, so `CgroupUnenforceableError` is unreachable host-side.)

## E2E Slice

**Demonstrable behavior:** Given a box booted from the DF2.10 image whose `qds-run@.service`
carries `Delegate=memory`, and a manifest declaring `residentRssBytes: 64 MiB` (small enough that a
single allocation crosses it deterministically — **provisional: re-derive at authoring time against
a measured pi baseline.** Read `memory.peak` from a control solicitation that allocates nothing and
set the fixture bound to ≥ 2× that. A bound below pi's own startup RSS OOMs at `exec` and proves the
cgroup is *attached* rather than that the allocation *crossed* it, which is not what AC1 asserts.
pi is a compiled ELF standalone binary and nothing in either story, the ADR, or the 2026-08-31 probe
measures its resident set — the probe measured wall time and cost only. The same measurement is what
re-derives DF3.6a's **512 MiB** default, which is the one value crossing the split seam and the one
default nobody has re-derived: it survives verbatim from the 2026-08-20 text while every other
default at this split was re-derived from first principles), When a run executes in-box and the resident's pi
child allocates past the bound, Then **the kernel OOM-kills that solicitation's cgroup** — no signal
is sent by the engine and no sample is taken — the journal records `resident.exitStatus: "overflow"`
and a `residentTripwire` row `{runId, requestId, cause:"watchdog_kill", phase, detail}` — DF3.3's
closed FIVE-key shape, all five of which `src/phase-engine/steering.ts` builds; `requestId` is the
per-solicitation join key and was missing from this line until 2026-09-19 — whose `detail` carries
the `memory.peak` reading and the bound it crossed, the solicitation's cgroup is removed, and
**every remaining phase and gate executes on the deterministic path**. Observable artifacts: the
harvested journal, and the leaf's kernel record read before removal — `memory.events`' counters AND `memory.peak`. The verdict is the three-part rule of **Dev Agent Record ruling 8**: `oom > 0 && (oom_kill > 0 || oom_group_kill > 0) && memory.peak >= bound - 2 MiB` — where the third conjunct is SKIPPED when the measurement is unavailable (`memory.peak` reads 0 on a pre-5.19 kernel, or no bound was supplied), because suppressing a real kill on a missing measurement is the worse direction. Ruling 8 has the full statement and ruling 9 corrects it; do not implement from this line alone. Not `oom_kill` alone: that counts a global OOM which merely picked pi, and `oom > 0` is what rejects it. The peak conjunct is a CONSISTENCY CHECK implied by `oom`, not a second discriminator — ruling 9 corrects the earlier claim that it separated anything, and states the one residual that survives (amended 2026-09-19, re-corrected the same day).

**This slice runs live, and it runs in-box.** It is a `qds-live-e2e` roster-**tier-4** assertion
against a real exe.dev box and real OpenRouter spend, per
`.claude/skills/qds-live-e2e/SKILL.md` — **but the two AC1 legs are NOT sited on the host-side
`tier4-resident.live.test.ts` file**: every leg in that file runs `bun scripts/pipeline-run.ts` on
the operator host (its own header says so — it cannot express in-box execution, and darwin has no
cgroups), so a fourth leg beside L1/L2/L3 could not prove the enforcement anyway, because
darwin has no cgroups. **(The original reason given here — that the leg would inherit a darwin spawn
with `residentRssBytes` PRESENT and INV-MEM-2 would disable the resident — is false under ruling 3b:
the host-side flag shape WITHHOLDS the bound, so nothing is disabled. The conclusion stands on the
independent ground above; only the stated reason was wrong. Corrected 2026-09-19.)** **The proof is a
dedicated in-box dispatch** — `fleet run` under `qds-run@.service`, the tier2-in-box-engine pattern,
the only shipped shape that executes the engine inside the box — **as its own second dispatch**:
the AC6 replay guard refuses a second run on a settled box, so the in-box leg cannot share the
host-side tier's box. Cost, named rather than rounded: the host-side tier's one run key (minted at
the 50,000 µ$ cap; the tier prices itself ≈ $0.05 model + ~1 box-hour, its measured real
solicitation ~401 µ$) **plus two more boxes for the in-box dispatches — one per AC1 leg** (Leg
A's OOM-kill ends its resident via AC5's stop latch and `startResident` resolves `QDS_PI_BIN`
once per resident, so the legs cannot share a resident lifecycle, and the AC6 replay guard
refuses a second run on a settled box, so they cannot share a box) — roughly triple the box count
the tier alone would suggest. Honour the tier's `finally` teardown discipline — a leaked box on an
OOM path is a leaked box that bills. A host-side unit test
**cannot** substitute: the enforcer is the kernel, and darwin has no cgroups at all.

**Wiring closed:** On completion of this story the memory bound is kernel-enforced end to end using
only code merged by this story plus DF3.6a's validated `residentRssBytes` and widened `cause` union,
DF1.10's in-box engine and resident spawn path, and DF2.10's unit. No stub, no `TODO: wire later`.

**Dependency edges (predecessors):** **DF3.6a** (validates `residentRssBytes`; widens
`ResidentTripwire["cause"]` to include `watchdog_kill`; carries the `lastMemory` dep), **DF1.10**
(the in-box engine and the `startResident` spawn path this story instruments), **DF1.11** (the
in-box steering executor — the solicitation points this story wraps the cgroup around run inside
it), **DF2.10** (the boot image and the `qds-run@.service` unit that must carry `Delegate=memory`,
and whose digest pin must move), DF3.3 (the `resident` journal block and its `exitStatus` field).
Matches `sprint-status.yaml`'s DF3.6b row (cited by story key), which is authoritative.

## Acceptance Criteria

1. **(make-or-break) The memory bound is enforced by the kernel, not observed by the engine.** Given
   a pi solicitation whose process tree allocates past `residentRssBytes`, When the allocation
   crosses `memory.max` on that solicitation's cgroup, Then **the kernel OOM-kills that cgroup** —
   the engine issues no signal and takes no sample — the run journal's `resident.exitStatus` is
   written `"overflow"` (CC-1: a real member of `EXIT_STATUSES`,
   `cli-anything/src/types.ts:99-105`), the field DF3.3 declares on the `resident` block it owns
   (its AC5); this story writes the value and adds no field of its own. A `watchdog_kill` tripwire
   row records the cause with the measured `memory.peak` in `detail`, the run continues
   deterministic, and a post-run check finds the solicitation cgroup removed and no orphaned child.
   *Negative control: an implementation that polls RSS on a timer and then signals the tree reports
   a breach it has already paid for — a process can balloon and OOM the box inside one sample
   interval — and MUST fail this test. The bound must fire with the engine's own code not running.*
2. **The bound is rooted at the resident by construction, not by convention.** Given a solicitation
   is about to spawn, When its cgroup is created, Then it contains **only pi and its descendants** —
   never the engine, and never the tier-3 `dispatch_task` workers the engine also parents in-box
   (`QDS_TEAM_RUNNER=local`; the env anchors in `src/phase-engine/phases/dispatch-task.ts`). An engine-rooted
   bound charges a bun team-lead's memory to a 512 MiB **resident** bound and trips on the first
   dispatch phase of every real run. This is the general invariant the tier-2 placement ADR states
   — *a bound on component X is rooted at X's pid, never at an ancestor's* (Appendix B, ACCEPTED
   2026-09-08) — and it is F064, already found and fixed once
   (`src/reverify/worktree.ts:293-299`); it is not to be rediscovered. *Negative control: an
   implementation setting `MemoryMax=` on the `qds-run@<runId>.service` unit itself bounds the
   engine's whole cgroup — which `oci/exedev/systemd/qds-run@.service:185` already documents as
   containing the pi child, the `code` phases and the team-lead drivers — passes a naive
   synthetic-allocator "does it fire?" test, and MUST fail a test in which a `dispatch_task` phase
   runs beside a small resident.*
3. **Unenforceable means not started, checked against a real object, classified at the arming
   boundary.** Given the cgroup cannot be
   created or `memory.max` cannot be written — `Delegate=memory` absent from the unit, the `memory`
   controller unavailable, the box not on cgroup v2 — When the resident arms, Then it is **not
   started**: the journal records `resident.status: "disabled"` (DF3.3's closed set — a fourth value
   would violate its AC5) and the runner emits the **shipped arming-refusal shape** on stderr —
   `{ level:"warn", event:"resident_disabled", runId, requestId, model, reason:"rss_unenforceable",
   detail }`, the same line the `rate_unresolved` refusal already uses
   (the arming path's `scripts/pipeline-run.ts` refusal region). **The mechanism is owned, not
   implied (W6-C-H5): the spawn path raises a typed error when the cgroup cannot be created or
   `memory.max` written, and the arming `try/catch` — whose current arm rethrows everything that is
   not the rate refusal — gains a handler for it beside that arm, emitting the line above through
   the existing disabled-shape branch.** Bundling the emission into the `onBoundBreach` handler is
   the named defect: that region lives inside `createSteering`, which on this path is never
   constructed (`pipeline-run.ts` gates it on `!("disabled" in spawned)`), so an unclassified
   rethrow here yields a tracer-closed, marker-absent box — `fleet status: engine-failed` — exactly
   the outcome DF3.6a's AC2b negative control forbids. It is deliberately **not** a bounds-check log line:
   `checkBounds` lives inside `createSteering` (DF3.6a's Files list), and on this path
   `createSteering` is never called, so a bounds-check line is structurally unavailable and asserting one
   would force a second bounds-telemetry emitter into existence. No `residentTripwire` row is
   emitted, leaving DF3.3's closed union unchanged as shipped — the three members exist only
   after 6a's widening, which includes this story's own `watchdog_kill` (W10C-6b-2). The run proceeds deterministic rather than
   running an agent whose memory nobody can bound. The check runs at **arming**, against a cgroup
   the engine either can or cannot create — not against a process that does not yet exist
   (`startResident` spawns nothing).
4. **A failed placement never yields an unbounded call.** Given the per-solicitation cgroup existed
   at arming but the `cgroup.procs` write fails at solicitation time — the leaf was removed,
   `+memory` was disabled, or the write errors — When the placement wrapper runs, Then it exits
   **97 without `exec`ing pi**, and the failure crosses to the engine as a **typed rejection on
   the `ResidentCaller.call` contract**: `PlacementRefusedError` — an engine-owned class declared
   in `src/phase-engine/steering.ts` and thrown by fleet's caller implementation (fleet→engine is
   the allowed import direction), carrying exit code 97 — so `createSteering`'s call-failure catch
   classifies it with an `instanceof` arm beside the opaque-`Error` degrade arm instead of
   converting it to the one-way `"degraded"` latch. The arm fires
   `deps.onBoundBreach({bound:"rss", allowed:false, cause:"unenforceable", exitCode: 97})`, and the
   runner's handler records the failed solicitation — `{bound:"rss", allowed:false, cause:"unenforceable"}` on the **engine-side `resident_bound_breach` fd-2 line** (amended 2026-09-18, Dev Agent Record ruling 7: this sentence originally said the fleet `warn` chokepoint, which carries the separate per-solicitation `resident_cgroup` event and holds neither join key)
   line (harvested with the journal via fd-2; the emitter and destination are named because no
   contracted record shape carries a mid-call placement failure: the bounds-check line cannot
   observe a failure inside `caller.call`, and the tripwire union has no member for it) — and
   **awaits `residentSpawn.stop()`** on the handle it holds, so the resident is stopped, **no
   further solicitation is issued for it** — the stop latch holds, and the status gate holds
   because the engine's `instanceof PlacementRefusedError` arm **first writes
   `telemetry.status = "stopped"`** (the one-way-latch write AC5's proximate-cause rule licenses:
   an unenforceable bound is this pair's enforcement being the proximate cause) **before** firing
   `onBoundBreach`, so the next engine solicitation point is refused by the status gate — the
   opaque stop-latch throw can never fall into the degrade arm and re-create the misclassification
   edit (v) exists to prevent — and the run
   continues deterministic. AC3's arming check is once per run; this is the per-solicitation half of
   the same invariant. *Negative control: a wrapper joining the two commands with `;` execs pi with
   no `memory.max`, and the resulting journal is indistinguishable from a bounded solicitation —
   `memory.events` reads `oom_kill: 0` from a leaf pi was never in — so an unbounded resident
   records as a clean call. MUST fail this test.*
5. **An OOM-kill stops the resident, and the resident's status says so.** Given the kernel OOM-kills
   a solicitation's cgroup, When the failed call returns to the engine, Then `stop()` is invoked on
   the `ResidentSpawn` handle (`src/fleet/resident.ts:689-708`) so the latch is **real rather than
   incidental**, `telemetry.status` is written `"stopped"` — this story's enforcement is the
   proximate cause, which is exactly the condition DF3.6a AC5 reserves `"stopped"` for —
   `telemetry.exitStatus` is written `"overflow"`, and no further solicitation is issued. The engine
   detects and records; it does **not** call `stop()` and cannot, because `stop()` is on
   `ResidentSpawn`, which the engine never receives. It fires `onBoundBreach`, and the runner —
   which holds the handle (`residentSpawn = spawned`, `scripts/pipeline-run.ts`) — calls `stop()`. Without
   this, an OOM-killed pi is a signal death (`src/fleet/resident.ts:1378-1404`) that sets
   `lastExit = "transient"` and throws, the engine's call-failure path writes `"degraded"`, nothing
   calls `stop()`, and the journal reads `status:"degraded"` beside `exitStatus:"overflow"` — a
   combination no story owns. *Negative controls: (a) an implementation relying on the `"degraded"`
   status gate (the status gate in `src/phase-engine/steering.ts`) instead of `stop()` leaves
   `stopped === false`, so any later re-arm path re-opens a second in-run kill, and MUST fail;
   (b) an implementation leaving `status` at whatever the degrade path wrote MUST fail.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| per-solicitation cgroup create + `memory.max` write at spawn | in-scope | the **dedicated in-box dispatch** (E2E Slice — the tier-2-gated `fleet run` round under `qds-run@.service`; the kernel is the enforcer and no host-side test can prove an OOM-kill; **not** the host-side `tier4-resident.live.test.ts`, whose every leg runs `pipeline-run.ts` on the darwin operator host) | — |
| `memory.peak` / `memory.events` read + cgroup removal after the call | in-scope | `tests/fleet/resident-cgroup.test.ts` (fs-level, host-side; the file that shipped — see Files to Modify) + the live round | — |
| one-time delegated-subtree split at engine start | in-scope | `tests/fleet/resident.test.ts` | — |
| `Delegate=memory` present in the shipped unit | in-scope | `oci/exedev/Dockerfile` build-time scan + `tests/providers/exedev/image-assets.test.ts` | — |
| spend ceiling / iteration bound | out-of-scope | — | **DF3.6a** |
| cgroup-enforced RSS for the host-side re-verify box | out-of-scope | — | DF5.1 (its host-side ceiling is **untouched** by this story; ADR Appendix B's same-day correction rules this mechanism out for a possibly-darwin host) |
| bound-breach events on the audit chain | out-of-scope | — | DF5.3 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| cgroup delegation | `Delegate=memory` on `oci/exedev/systemd/qds-run@.service` (DF2.10's unit; systemd 255, cgroup v2 unified). Delegation is what chowns the unit's cgroup directory, `cgroup.procs` and `cgroup.subtree_control` to `User=exedev`, so the engine can create the resident's child cgroup **without root, without D-Bus and without polkit** | build-time: DF2.10's Dockerfile unit scan gains a positive `grep -qE '^Delegate=memory$'` assertion, the same shape as the existing `RuntimeDirectoryPreserve=yes` check (the unit scan in `oci/exedev/Dockerfile`), so the directive cannot be silently dropped. Run time: absent delegation ⇒ resident **not started** (AC3) |
| resident memory bound | cgroup v2 `memory.max` on a per-solicitation child cgroup created by the fleet spawn path, valued from the manifest's `residentRssBytes` (validated by DF3.6a) | kernel-enforced. The engine passes the **value**; it never signals, never samples, and never learns a pid. The live round asserts an allocator past the bound is OOM-killed and the run still completes deterministically |
| resident memory telemetry | `memory.peak` and `memory.events` read from that cgroup before it is removed. BOTH are verdict inputs, not just telemetry: ruling 8's rule is `oom > 0 && (oom_kill > 0 \|\| oom_group_kill > 0) && memory.peak >= bound - 2 MiB`, with the peak conjunct SKIPPED when either figure is unavailable, and see ruling 9: that conjunct is a consistency check implied by `oom`, not the discriminator ruling 8 called it. `oom_kill` alone counts a global OOM that merely picked pi — `oom > 0` is what rejects that — and the peak conjunct is implied by `oom` rather than being a second discriminator (ruling 9) | a kernel high-water mark per solicitation — strictly better than a poll, and the reason this story samples nothing. Feeds `rssPeakBytes` on the **fleet `resident_cgroup`** line — keyed `runId` + per-resident `seq`, carrying NO `requestId` and NO `phase` — and `detail` on the `watchdog_kill` row. **NOT the engine-side bounds-check/`resident_bound_breach` line, which does not carry the measurement pair at all** (this row said "the bounds-check log line" until round 19, the pre-amendment emitter; see the Observability Contract's two record shapes) |
| image digest pin | DF2.10's pin ritual — the unit is **baked into the image**, so this story's one-directive change requires a rebuild, a re-publish and a moved digest pin, not just a file edit | see the DoD item; a green local gate against a stale pinned image is exactly the failure this prerequisite exists to prevent |

## Technical Notes

- **No pid crosses the module boundary — the bound value does.** An engine-side watchdog would have
  needed the in-flight pi child's pid, which the engine cannot obtain: `ResidentSpawn` ships
  `caller`, `rate`, `exitStatus()`, `stop()`, `lastMemory()` and no pid (`src/fleet/resident.ts:689-708`), the
  child handle is closure-local (`resident.ts:1095`, `let current`), and the engine is forbidden to import fleet
  code (`src/phase-engine/steering.ts:11-13`). Kernel enforcement dissolves that seam instead of
  widening it: **the engine never learns a pid, because it never has to signal anything.** But the
  seam is not closed by the fleet handle alone, and saying so was the earlier error: the engine
  never *receives* `ResidentSpawn` — the call site passes `spawned.caller`/`spawned.rate` plus two
  non-fleet sidecars (`emitAttribution` (DF2.12) and `inbox` (DF3.4); call site in
  `scripts/pipeline-run.ts`) — **no `ResidentSpawn` member crosses** — and `createSteering` cannot reach for more,
  because `src/phase-engine/steering.ts:11-13` forbids importing fleet code. A method on
  `ResidentSpawn` that the engine cannot hold is not a channel. **Three facts cross, on two
  objects:**

  ```ts
  // src/fleet/resident.ts — on ResidentSpawnOpts, beside `persistDir`/`bin`
  /** DF3.6b: the engine-owned RSS bound, read from the frozen manifest and
   *  validated by DF3.6a. Fleet applies it as `memory.max` on the
   *  per-solicitation cgroup; fleet NEVER chooses or defaults it.
   *  OPTIONAL, and the optionality is the seam (INV-MEM-2 Scope): absent means
   *  no cgroup machinery runs at all — the host-side context, where there are
   *  no cgroups. That is NOT unit tests only: per ruling 3b, the
   *  `pipeline-run --manifest …` host-side flag shape withholds the bound too,
   *  so a production invocation can reach here with the field absent. Only the
   *  `run <runId>` in-box FRONT DOOR always supplies it, because DF3.6a refuses
   *  the run at manifest load on a missing or non-positive value.
   *  Present-but-unenforceable ⇒ resident not started (INV-MEM-2).
   *  Same division of labour as stop(): "DF3.6 decides when; this supplies
   *  how" (resident.ts:698). */
  residentRssBytes?: number;

  // src/fleet/resident.ts — on ResidentSpawn, beside exitStatus()
  /** DF3.6b: last solicitation's cgroup accounting — `memory.peak`, whether the
   *  kernel OOM-killed it (ruling 8's rule, applied fleet-side), and the BOUND
   *  that reading was taken against. `boundBytes` is on this object because
   *  AC1 and the DoD require the `watchdog_kill` row's `detail` to name "the
   *  bound it crossed", and the engine is forbidden to import fleet code or
   *  read the manifest here — so the value has to ride the accounting. Read
   *  before the cgroup is removed. */
  lastMemory(): { peakBytes: number; oomKilled: boolean; boundBytes: number } | null;

  // src/phase-engine/steering.ts — the third createSteering dep, landed in
  // DF3.6a's diff (its Files list item 5) because the deps object is one
  // literal and two stories must not edit it. A structural callback, NOT a
  // fleet import: the engine learns whether the kernel killed, never how to.
  lastMemory?: () => { peakBytes: number; oomKilled: boolean; boundBytes?: number } | null;
  ```

  `scripts/pipeline-run.ts` wires the third to the second (`lastMemory: spawned.lastMemory`). The
  AC4 placement-failure classification crosses separately, as a **typed rejection on the existing
  `ResidentCaller.call` contract** — an engine-owned error class (`PlacementRefusedError`, exit
  97) that fleet's caller throws and the engine catches by name, fleet→engine being the allowed
  import direction — not a fourth fact on these two objects (W9C-6b-2). The
  bound stays **engine-owned policy** (INV-MEM-1: it is read from the frozen manifest, and fleet
  neither defaults nor clamps it); fleet is mechanism only.
- **Why cgroup and not a sampler, and what that costs — stated because it is genuine work.**
  A `ps` sampler at any interval reports a breach already paid for: the ADR's measured in-box
  solicitation is 2.17 s, and a process can balloon and OOM the box between two samples. F12 says
  *enforce*. cgroup v2 `memory.max` is kernel-enforced, fires deterministically, and is
  un-bypassable from inside the box — **but NOT for the reason this sentence used to give.** It said
  "the bound is not in its address space (INV-MEM-1, structurally)", which is false: under
  `Delegate=memory` the leaf is created as `User=exedev` and pi is `exec`'d into it as the SAME uid,
  so `memory.max` is a file pi's uid OWNS. What keeps it out of pi's reach is that pi is spawned
  **`--no-tools`** — load-bearing security configuration, not a cost knob. INV-MEM-1 carries the full
  amendment (review round 1); this copy was left unamended until round 15. The determinism claim is exact for
  **unreclaimable** (anonymous) growth, which is the leak this bound exists for. Reclaimable
  file-backed pressure at the limit — pi streaming a large session jsonl, a big response through the
  page cache — thrashes rather than OOMs; the backstop there is the existing per-call wall clock
  (`SOLICIT_TIMEOUT_MS = 60_000`, `src/phase-engine/steering.ts:30`), which classifies as a timeout,
  not a `watchdog_kill`. Stated so nobody reads a missing `oom_kill` count as a missing bound. **This does not touch DF5.1's standing
  accepted ceiling** ("RSS is `ps`-sampled rather than cgroup-enforced",
  `df5-1…md:229,268-269,352-354`), and it does not inherit it either — the two are different
  problems on different kernels. Per ADR Appendix B's same-day correction
  (`docs/superpowers/specs/2026-08-31-tier2-placement-adr.md:185-193`): the mechanism ruled on here
  is available in-box precisely *because* the box is Linux with systemd as PID 1, and **it does not
  generalise to the host**; DF5.1's verify box is host-side and may be darwin, where cgroup v2 does
  not exist. DF5.1's ceiling therefore **stays open, unclosed and un-re-opened by this story**, and
  closing it needs a **different** answer — filed against DF5.1 so there is one ticket for the one
  exposure, explicitly **not** on this mechanism.

  **Mechanism chosen: a direct cgroup-fs write under `Delegate=memory`. Not `systemd-run --scope`.**
  The tradeoff, written down:
  - `systemd-run --scope` needs the systemd manager over D-Bus. The engine runs as `User=exedev`
    inside a **system** unit (`oci/exedev/systemd/qds-run@.service`), so the system manager demands
    polkit authorization it cannot obtain non-interactively, and `--user` demands a user manager,
    enabled lingering, and `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS` the unit does not set. That
    is a Dockerfile change, a unit change and a privilege question — and it fails at run time, on a
    box, **silently**.
  - The fs write needs **one directive** (`Delegate=memory`), no D-Bus, no polkit, no lingering, no
    user manager. Delegation is precisely the systemd feature for this: it chowns the unit's cgroup
    directory, `cgroup.procs` and `cgroup.subtree_control` to `User=`.

  **The one real cost, named rather than papered over — the no-internal-processes rule.** cgroup v2
  forbids enabling a controller in `cgroup.subtree_control` on a cgroup that holds processes
  directly, and the unit's cgroup holds the engine (and, in-box, every `dispatch_task` worker). So
  at engine start the delegated subtree must be split once: move self into a `supervisor/` leaf,
  then enable `+memory` on the unit cgroup, then create `resident.<seq>/` leaves per solicitation.
  This is systemd's documented delegation pattern, it is ~15 lines of `fs` writes with a real
  ordering constraint and a real failure mode, and it is a substantial part of why this half is 3
  points rather than a footnote in DF3.6a.

  **The spawn race is closed by the child, not by a retry — and the placement is fail-closed.**
  Writing pi's pid to `cgroup.procs` *after* `Bun.spawn` leaves a window in which pi runs unbounded.
  Instead the child places itself before it becomes pi, and **refuses to become pi if the placement
  fails**:
  **AMENDED 2026-09-19 (review round 1, finding 5) — the wrapper below is what SHIPS; the
  `'echo $$ > "$1"/cgroup.procs || exit 97; …'` form this section originally specified was rejected
  during development and must not be built from this paragraph.**

  ```sh
  sh -c 'echo $$ >> "$1"/cgroup.procs 2>/dev/null; \
         ok=0; while IFS= read -r p; do [ "$p" = "$$" ] && ok=1; done < "$1"/cgroup.procs 2>/dev/null; \
         [ "$ok" = 1 ] || exit 97; shift; exec "$@"' _ <cgroupDir> <pi argv…>
  ```

  Positional passing, so the rendered prompt stays its own argv element and is never interpolated
  into a shell string. **The refusal is keyed on VERIFIED MEMBERSHIP, not on the write's exit
  status**, and that is the load-bearing part: `cgroup.procs` rejects at WRITE time as well as at
  open time — EBUSY when the target is not a leaf, EOPNOTSUPP, EINVAL — and whether a guard on the
  redirection fires then depends on the shell propagating a deferred write error (busybox `ash`
  returns 1, `dash` raises an I/O error and exits **2**). A generic non-zero exit is NOT classified
  `unenforceable` by the engine; it takes the one-way `"degraded"` latch, which is exactly the
  misclassification AC4 exists to prevent. Reading `cgroup.procs` back and looking for our own pid
  is decisive on every shell and every failure mode, and uses only POSIX shell built-ins (no `grep`,
  no `awk`) so it cannot depend on what the image happens to stage. The original concern stands and
  is subsumed: an unconditional `;` sequence would fall straight through to `exec` and run pi with
  no `memory.max` — the silent degradation to an unbounded agent INV-MEM-2 forbids — and AC3's check
  is at **arming, once**, so nothing re-checks per solicitation. Exit 97 is classified `unenforceable` by the caller: the
  solicitation fails, the resident is stopped, and no unbounded call is ever issued. The key remains
  env-borne, never argv (`src/fleet/resident.ts:719-722`), unchanged by this wrapper.
  `ponytail:` the `sh -c` wrapper exists only to close the placement race; if Bun ever exposes
  `CLONE_INTO_CGROUP`, delete the wrapper and pass the cgroup fd.
- **This story samples nothing, and that is a deletion, not a gap (R5 §6 fact 5 restated).** Fact 5
  says the P1.6 watchdog is *re-aimed, not deleted* — aimed at a genuinely local subprocess tree.
  In-box that premise is true, and it is what makes a cgroup possible at all; but the *mechanism* is
  superseded by ADR Appendix B. The tree is bounded by the kernel, so there is no interval to
  choose, no `ps` table to parse, no descendant walk to root correctly, and no
  SIGTERM→grace→SIGKILL sweep to write. `src/reverify/worktree.ts:213-378` stays where it is,
  untouched and un-extracted — it is the *host-side re-verify* guard and this story neither reuses
  nor modifies it. The one thing a sampler was still wanted for, telemetry, the kernel gives away
  for free and better: `memory.peak` is a true high-water mark for the solicitation, where a poll
  can only report the samples it happened to take. **A cgroup read replaces a sampler, a timer, a
  lifecycle rule, a platform dispatch and a kill path.** In particular there is no darwin/Linux probe
  split: the enforcement path exists only in-box on Linux, and the former darwin justification
  ("DF3.3's e2e demo runs on the darwin operator host") was already stale post-DF1.10 — the e2e demo
  runs in-box on Linux, and darwin now matters only for host-side unit tests, which do not exercise
  this bound at all.
- **Breach behavior is uniform and narrow:** an OOM-kill stops the **resident** and nothing else —
  never fails the run, a phase, or a gate, and never shortens a budget. A run whose resident was
  killed finished deterministically, which is exactly D4's fallback ("demote tier 2 to code-only
  dispatch") happening for one run. Because the cgroup contains only pi and its descendants (AC2),
  "nothing else" is a property of the kernel's scoping rather than a promise this story keeps.
- **Tripwire causes are emitted, not evaluated.** The kill emits a DF3.3 `residentTripwire` row
  `{ runId, requestId, cause: "watchdog_kill", phase, detail }`, with `detail` carrying the measured
  `memory.peak` and the bound it crossed — **those two and nothing else.** (Corrected 2026-09-19:
  this clause used to add "and the cgroup leaf name", which does not ship and is not buildable here.
  The engine's only channel is `deps.lastMemory?.()`, typed `{peakBytes, oomKilled, boundBytes?}`;
  the leaf name exists solely fleet-side as `resident.${runId}.${seq}` and never crosses the seam
  this story fixes at three facts on two objects. `story` E2E Slice and AC1 both already said peak +
  bound only — this was the outlier.) **D4's tripwire (c) — "any steering
  loop the watchdog kills twice for the same cause" — is a statement about a repeating *loop*, not
  about a fleet-wide count, and this story does not decide its key.** Within one run a second kill
  is prevented by AC5's `stop()` latch (`src/fleet/resident.ts:1493-1494`, which sets `stopped`; every later `call` throws
  at `resident.ts:1201`) — a latch **this story establishes**, not one it inherits: nothing else on
  the OOM path calls `stop()`. Across runs, the rows emitted here carry `runId`, `phase` and
  `detail`, which is the evidence an evaluator needs. **Choosing the key that makes "the same
  steering loop" identifiable — `phase` plus the manifest's `pipelineId`, and *not* `runId`, which
  is unique per run and would make any two kills anywhere in the fleet count as "twice" and demote
  tier 2 entirely — is the month-1 evaluator's decision, and if it changes what D4 means it is an
  ADR amendment, not a story-local note.** The *cause* discriminator has cardinality one today (an
  OOM-kill is the only kill this story raises); a second kill cause would be a new tripwire `cause`
  member, not a new `detail` string. This story counts nothing and defines no key. (The `watchdog_kill` name is DF3.3's, reserved
  before the mechanism became kernel-enforced; it is kept because DF3.3 owns the union and renaming
  it would be a cross-story change for no behavioural gain.)
- **The union widening lives in DF3.6a, deliberately.** `ResidentTripwire["cause"]` is one closed
  literal type on one line (`src/phase-engine/steering.ts:244`); both new members land in DF3.6a's
  diff so two stories are not editing the same literal. This story writes `watchdog_kill` into a
  union that already admits it.

## Observability Contract

- **TWO record shapes, on two emitters — do not read the wrong one.** This bullet originally gave a
  single line `{ requestId, runId, phase, bound:"rss", rssPeakBytes, residentRssBytes, allowed }`,
  which the round-1 amendment below then reassigned without amending here (found round 18). What
  ships:
  - **fleet `resident_cgroup`** (the per-solicitation measurement, `src/fleet/resident.ts`):
    `{ event, bound:"rss", allowed, runId, seq, residentRssBytes, rssPeakBytes, oomKilled,
    cgroup_setup_ms, cgroup_teardown_ms }`. **This is where `rssPeakBytes`/`residentRssBytes` live.**
    It carries NO `requestId` and NO `phase` — both are engine-side facts that never cross into
    fleet, so a consumer joining on them against this line will find nothing. Its correlation key is
    `runId` plus `seq`.
  - **engine `resident_bound_breach`** (the fd-2 warn line, DF3.6a's shape, join keys included):
    carries `bound`/`allowed`/`cause`/`exitCode` and the engine-side keys — and does NOT carry the
    peak/bound measurement pair.
- `requestId` propagates unchanged from DF3.3's solicitation record; a kill additionally emits
  `{ runId, requestId, cause: "watchdog_kill", phase, detail }` on the tripwire row — DF3.3's
  closed five-key shape, with the measured `memory.peak` and the bound it crossed in `detail` —
  while `{ bound, allowed, cause, exitCode }` ride the fd-2 `resident_bound_breach` warn line,
  which is where DF3.6a already put them. **RULED AND CLOSED 2026-09-18 during development (see
  Dev Agent Record ruling 3): amend this sentence, do NOT widen `ResidentTripwire`.** The
  superseded wording and its history follow.
  **(DF3.6a review handoff, 2026-09-18 — this sentence carries the SAME spec-internal contradiction
  DF3.6a's review caught in its own contract: `ResidentTripwire` is DF3.3's closed type and carries
  neither `code` nor `bound`; DF3.6a followed the closed type and left its contract sentence
  unamended. This story emits `watchdog_kill` tripwires and therefore OWNS the resolution: either
  widen `ResidentTripwire` (an explicit cross-story amendment to DF3.3's closed type, recorded in
  its deviation ledger) or amend this sentence to the shape actually emitted — `{runId, requestId,
  cause, phase, detail}` with `bound`/`code` riding the fd-2 `resident_bound_breach` warn line, as
  DF3.6a shipped. Decide it here, record it either way; do not ship a second contract sentence the
  type contradicts.)**
- Sub-timings: `cgroup_setup_ms`, `cgroup_teardown_ms`. A bound never evaluated reports `0`.
  **AMENDED 2026-09-18 (review round 1, finding 6):** these and the per-solicitation
  `rssPeakBytes`/`residentRssBytes` pair ride the **fleet `warn` chokepoint** as a
  `resident_cgroup` line keyed `{event, bound:"rss", allowed, runId, seq, residentRssBytes,
  rssPeakBytes, oomKilled, cgroup_setup_ms, cgroup_teardown_ms}` — **not** the engine-side
  bounds-check line. The measurement happens in `src/fleet/resident.ts`, which holds neither
  `requestId` nor `phase`: both are engine-side facts that never cross into fleet, so a line emitted
  there structurally cannot carry them, and adding a channel for them would widen exactly the seam
  this story's Technical Notes keep narrow. The correlation key it CAN carry is `runId` plus the
  per-resident `seq`. The engine-side `resident_bound_breach` line keeps DF3.6a's shape, join keys
  included.
  `rssPeakBytes` is read from the solicitation cgroup's `memory.peak` — a kernel high-water mark,
  **not** a sampled value, so there is no sample interval to report.
- **Destination:** the trace/log stream. The only journal `resident` values this story writes are
  `exitStatus:"overflow"` and, on the unenforceable path, `status:"disabled"` — both members of
  sets DF3.3 already closed.

## Files to Modify

- `src/fleet/resident.ts` — the cgroup mechanism: **optional** `residentRssBytes` on
  `ResidentSpawnOpts`, the one-time delegated-subtree split, the per-solicitation cgroup create /
  `memory.max` **and `memory.oom.group=1`** writes / fail-closed `sh -c` self-placement wrapper
  around the existing `Bun.spawn` / `memory.peak` + `memory.events` read / leaf removal, and
  `lastMemory()` on `ResidentSpawn`. Fleet supplies the *how*; the bound *value* stays the engine's
  (Technical Notes).
- `src/phase-engine/steering.ts` — **two** edits, both inside DF3.6a's already-enumerated
  carve-out: **(1)** an
  internal writer setting `telemetry.status = "stopped"` and `telemetry.exitStatus = "overflow"`,
  and firing `deps.onBoundBreach({ bound:"rss", cause:"watchdog_kill", … })`, when a solicitation's
  call rejects **and** `deps.lastMemory?.()` reports `oomKilled: true` (AC5); **(2)** the typed
  placement-failure channel (W9C-6b-2, AC4): the `ResidentCaller` contract gains the engine-owned
  `PlacementRefusedError` rejection (exit 97, thrown by fleet's caller when the placement wrapper
  fails before `exec`) and the call-failure catch gains its `instanceof` arm beside the
  degrade arm, writing `telemetry.status = "stopped"` (AC5's proximate-cause rule licenses it here)
  and then firing `onBoundBreach({ bound:"rss", cause:"unenforceable", … })` instead of
  writing the `"degraded"` latch. DF3.6a's enumerated list is amended accordingly (item 6, this
  story's — the same cross-story amendment shape that put `lastMemory` in item 5). The `lastMemory` dep
  lands in **DF3.6a's** diff (its Files list item 5), because the deps object is one literal and two
  stories must not edit it. **(DF3.6a review handoff, 2026-09-18: the dep is landed and UNUSED —
  `createSteering` accepts it, nothing reads it yet. Your edit (iv) below is its first consumer, so
  during development a grep for `lastMemory` in `src/phase-engine/steering.ts` showing a single
  reference is CORRECT pre-(iv), not drift to "clean up".)** The controller keeps its snapshot-only getter;
  **no public setter is added**, because a public setter is a path the resident's own tier could
  reach and INV-MEM-1 forbids it. **The engine does not call `stop()` and cannot:** `stop()` is on
  `ResidentSpawn`, which the engine never receives — the same reason `lastMemory` had to become a
  dep. `onBoundBreach` is the channel out; the runner, which does hold the handle
  (`residentSpawn = spawned` at the sole `createSteering` call site), is what calls `stop()`.
- `src/phase-engine/resident-bounds.ts` — **the `PROVISIONAL_RESIDENT_RSS_BYTES` constant only**
  (W6-C-H4 as re-homed by W14C-PAIR-1): DF3.6a marks the 512 MiB provisional-pending this story's
  measured baseline, and this story's Files budget carries re-setting **that constant, in
  DF3.6a's `resident-bounds.ts`** — not `manifest.ts`, which carries no default at all (a schema
  default would make DF3.6a AC2a's missing-value refusal unobservable; the W6-C-H4 file assignment
  predates that design). No other field, no schema change — the three bound fields and their
  validation are DF3.6a's.
  **(DF3.6a review handoff, 2026-09-18 — optional widening while you are in this seam:** DF3.6a's
  per-phase iteration counter keys on phase NAME, so a schema-valid manifest with duplicate phase
  names pools two phases' solicitation budgets (under-refusal only, fail-closed direction; DF3.6a
  recorded it as known-limitation (a) on the S3-7 config-level precedent). The clean fix — a phase
  ordinal beside the name in the guard ctx, or a dup-name check at guard construction — widens the
  steering↔guard interface beyond DF3.6a's closed edit list, but THIS story already widens that
  interface (`lastMemory`, the rss writer). Fold it in, or record the S3-7 deferral as deliberate
  in your Dev Agent Record — either way the item closes here.)
- `scripts/pipeline-run.ts` — **the pair takes seven edits on this file; the count is stated once, in
  DF3.6a's Files to Modify, and mirrored here so neither half's "no other change" can reject the
  other's** (W6-C-M2): DF3.6a lands (i)–(ii); **this story adds (iii)** `residentRssBytes` on the
  `startResident` call, **(iv)** `lastMemory: spawned.lastMemory` at the `createSteering` call,
  **(v)** the `onBoundBreach` handler arm that **awaits** `residentSpawn.stop()` on
  `cause:"watchdog_kill"` **and on the placement wrapper's exit-97 `unenforceable` classification**
  (AC5's latch **and AC4's stop** — an exit-97 placement failure is neither a `watchdog_kill` nor a
  `lastMemory().oomKilled` reading, so without this widening the engine's call-failure catch
  converts it to the one-way `"degraded"` latch: a misclassification that records a routine
  degrade where the bound is unenforceable and lands the classification nowhere — the status gate
  would then treat the resident as absent so no further calls issue, but nothing stops the spawn
  handle and nothing records why),
  recording the failed solicitation `{bound:"rss", allowed:false, cause:"unenforceable"}` on the
  engine-side `resident_bound_breach` fd-2 line (ruling 7; harvested with the journal), **(vi)** the arming-refusal classification — the typed
  cgroup-refusal error handled beside the rate arm in the arming `try/catch`, emitting
  `resident_disabled` / `rss_unenforceable` through the existing disabled-shape branch (AC3), and
  **(vii)** **the run-down refresh precedence** (full text in DF3.6a's Files list): the final
  telemetry refresh keeps the engine's `exitStatus:"overflow"` when the engine wrote it and fills
  the process-probe word only when the engine wrote none — the probe's `lastExit` is never
  `"overflow"`, so without this edit the shipped refresh overwrites AC1's make-or-break journal
  observable with `"transient"` on a kernel OOM-kill.
  Rebases onto DF3.6a. Nothing else in the file changes.
- `oci/exedev/systemd/qds-run@.service` — add `Delegate=memory`. One directive; it is what makes the
  cgroup writable by `User=exedev` without root, D-Bus or polkit.
- `oci/exedev/Dockerfile` — one positive `grep -qE '^Delegate=memory$'` assertion in the existing
  unit scan, matching the shape of the `RuntimeDirectoryPreserve=yes` check, so the
  directive cannot be silently dropped by a later image edit. (Verified: `Delegate=` contains no
  `QDS_`, so DF2.10's AC6 env scan at `:1024-1040` is unaffected, and the `systemd-analyze verify`
  stage accepts the directive.)
- `tests/fleet/resident-cgroup.test.ts` (NEW — **amended 2026-09-18 during development**; this
  entry originally named `tests/fleet/resident.test.ts`) — host-side fs-level coverage of the
  subtree split, the leaf lifecycle and the unenforceable path. The coverage landed in a NEW file
  rather than in the existing one because `tests/fleet/resident.test.ts` is DF3.3's suite and its
  42 arming sites are the INV-MEM-2 Scope exhibit this story must leave untouched; mixing a
  cgroup-fake harness into it would put this story's fixtures inside that exhibit.
  `tests/fleet/resident.test.ts` is therefore NOT modified by this story — it is the unmodified
  control that proves the absent-bound seam still arms.
- `tests/fleet/fixtures/fake-pi-resident.ts` — **added to this budget 2026-09-19** (rebase review,
  finding 6). DF3.3's shared fake pi gains the test-only, env-gated knobs the cgroup suite needs to
  stage a leaf from inside a call; a caller that sets none of them sees no change.
- `tests/scripts/build-exedev-image.test.ts` — **added to this budget 2026-09-19**. The buildId pin
  re-derivation is the OFFLINE half of the DF2.10 ritual this story's image item already requires;
  it was performed but not named here.
- the **dedicated in-box dispatch's live round** (E2E Slice — a tier-2-gated `fleet run` round
  under `qds-run@.service`, reusing the host-side tier's `runLeg` harness where it transfers) —
  the live OOM-kill assertion (AC1). `tests/fleet/e2e/tier4-resident.live.test.ts` is **not**
  modified: every leg in it runs `pipeline-run.ts` on the darwin operator host, where no cgroup
  exists (the W8-C-2 re-site).

## Security Invariants

- **INV-MEM-1 (enforcement locus — F12, and structurally stronger than a convention):** the memory
  bound is enforced by the **kernel**, outside the resident's address space. No directive, prompt,
  env var, in-box file, or roster entry the resident can influence may raise, disable, or reset it.
  **Read the amendment directly below before relying on any of that** — the clause that used to end
  this sentence, "the bound is not a value pi's own process can read or write as data", is exactly
  what the amendment retracts, and stating it here unqualified put the retracted version upstream of
  its own correction. (Removed in round 15. The same shape as ruling 9's setup paragraph, found the
  same way: a reviewer reading the lead sentence alone.)
  **AMENDED 2026-09-18 during development (review round 1) — the original sentence claimed more
  than the mechanism delivers, and the difference is load-bearing.** Under `Delegate=memory` the
  engine creates the solicitation leaf as `User=exedev` and `exec`s pi into it *as the same uid*,
  so the leaf's `memory.max` is a file pi's uid owns: a pi that could execute an arbitrary command
  or write an arbitrary path could raise its own bound, and the engine would not notice (it reads
  `memory.peak`/`memory.events` only after the call). What actually keeps the bound out of pi's
  reach is that pi is spawned **`--no-tools`** (the pi spawn argv in `src/fleet/resident.ts`), which
  is therefore **load-bearing security configuration and not a cost knob** — enabling tools on the
  resident re-opens this and needs a different containment answer (a second uid for pi so the leaf's
  interface files are not writable by it, which needs either a privileged helper or a `User=`-split
  unit). What IS structural, and is what F12 asked for, is that no *sampler* and no *engine timer*
  stands between the allocation and the kill: the kernel enforces, the engine issues no signal, and
  the bound is unreachable from the resident's prompt, env, roster entry and argv. The
  bound's *value* is engine-owned, read from the frozen manifest and validated by DF3.6a; the fleet
  layer applies it and never chooses or defaults it. *(This is the memory-specific corollary of
  DF3.6a's INV-BND-1, which governs bounds generally.)*
- **INV-MEM-2 (fail-closed toward determinism):** where the memory bound cannot be **enforced** —
  the delegated cgroup cannot be created, `memory.max` cannot be written, the `memory` controller is
  unavailable, or the box is not on cgroup v2 — the resident is **not started**; the engine never
  runs an agent whose memory it cannot bound, and never silently degrades to an unbounded one. The
  check is at arming, against a real object, not against a process that does not yet exist. When the
  bound *does* fire, it stops the resident only — never a gate, a phase, or the run's determinism.
  **Scope.** INV-MEM-2 governs the **in-box enforcement context** — the path reached when the caller
  supplies a bound. `residentRssBytes` is therefore **optional** on `ResidentSpawnOpts`: *absent*
  means no cgroup machinery runs at all, which is the host-side context generally — **not only unit
  tests**: under ruling 3b the `pipeline-run --manifest …` flag shape withholds the bound too, and
  that includes the darwin tier-4 live legs (darwin has no cgroups); *present-but-unenforceable* means the resident is not started, which is the in-box
  context. The two are distinguished **by the caller, not by a platform probe** —
  `scripts/pipeline-run.ts` passes the bound DF3.6a validated on the unit's FRONT-DOOR shape, so on
  that shape the field is always present and INV-MEM-2 always applies. **Under ruling 3b it is
  absent on the host-side flag shape — which is a production invocation with the field absent, and
  this sentence originally claimed otherwise.** Without this scope the invariant would return
  `{ disabled: true }` from every host-side arming site: `tests/fleet/resident.test.ts` alone has
  **42** `startResident(` call sites, and DF3.3's INV-RES-3 second-mint exhibit
  (`df3-3…md:237`) — the credential-containment proof for the whole resident — is one of them. A
  memory story must not silently disarm a shipped security control.
- **INV-MEM-3 (no new argv surface):** the `sh -c` placement wrapper passes pi's argv
  **positionally** (`sh -c '…' _ <cgroupDir> <pi argv…>`), so no rendered prompt is ever
  interpolated into a shell string, and the per-run key stays env-borne and never appears on argv
  (`src/fleet/resident.ts:719-722`, unchanged). A wrapper that string-builds the pi command line is
  a defect regardless of whether a given prompt happens to be safe.

## Definition of Done

- [ ] **Impl:** per-solicitation cgroup leaf with `memory.max` from `residentRssBytes` **and `memory.oom.group=1`**; one-time delegated-subtree split at engine start; **fail-closed** `sh -c` self-placement wrapper exiting **97** on refusal — the guard keys on
  MEMBERSHIP READ BACK from `cgroup.procs`, **not** on the write's exit status; the `... || exit 97`
  form this checkbox used to name was rejected during development (see the 2026-09-19 amendment) and
  must not be built from; `memory.peak`/`memory.events` read and leaf removal after the call; `lastMemory()` on `ResidentSpawn` wired through the `lastMemory` dep DF3.6a lands.
- [ ] **Impl:** `telemetry.exitStatus = "overflow"` written through an internal writer only — no public setter (INV-MEM-1). `"overflow"` verified a real `EXIT_STATUSES` member (`cli-anything/src/types.ts:99-105`), so no cross-repo type change is needed.
- [ ] **Contract:** the engine issues no signal and runs no timer for this bound; `grep` over the diff finds no `ps`, no `/proc` parser, no sample interval and no SIGTERM/SIGKILL sweep added by this story. `src/reverify/worktree.ts` is untouched.
- [ ] **Image + pin (DF2.10 ritual — this story requires a rebuild, not just an edit):** `Delegate=memory` lands in `oci/exedev/systemd/qds-run@.service`; the image is **rebuilt, re-published and its digest pin moved** per DF2.10's pin ritual, and `deriveBuildId`'s inputs (which hash the systemd unit — `scripts/build-exedev-image.ts:614` for `deriveBuildId`, `:1544` for `buildIdFileInputs`; the `src/providers/exedev/driver.ts` line citation this story shipped with pointed at a pin comment and a prose paragraph, never at either function, at every base it has had — corrected 2026-09-19) are re-derived. **A run against the previously pinned digest boots a unit with no `Delegate=`, so the resident refuses to start (AC3) — a green local gate against a stale pin is the exact failure this item exists to prevent.**
- [ ] **Security:** the bound is unreachable from any path the resident controls (INV-MEM-1); an unenforceable cgroup prevents resident start (INV-MEM-2); the placement wrapper adds no argv surface and the key stays env-borne (INV-MEM-3).
- [ ] **Test (memory bound fires, AC1 — LIVE, roster tier 4, TWO legs — each leg names the clause it
      proves):** the make-or-break needs a *producible trigger* — something that deterministically
      allocates past the bound — and no story mechanism, ADR clause or probe says how a real pi child
      is driven to do that (Wave 6 W6-C-B4: without a named lever the round proves nothing and the
      story is un-shippable by its own gate). The proof is therefore two legs on the same round —
      **and two resident lifecycles, because no one resident lifecycle can serve both legs**:
      `startResident` resolves `QDS_PI_BIN` once per resident (the bin read in
      `src/fleet/resident.ts`), and AC5's stop latch ends the resident at its first OOM-kill, so a
      Leg A crossing leaves nothing for Leg B to arm. **Each leg is therefore its own in-box
      dispatch on its own box, ordered Leg A first** — the zero-spend leg's crossing is the
      cheapest falsifier, and a Leg A failure ends the round before Leg B spends a µ$. The AC6
      replay guard refuses a second run on a settled box, which is the second reason the legs
      cannot share one box or one run record.
      **Leg A — the crossing (proves AC1's enforcement clause: the kernel kills a cgroup the engine
      never signals, with the engine's pi code not running).** A synthetic allocator binary is
      installed on the box as **that leg's `QDS_PI_BIN`** — staged by the leg's dispatch setup and
      named through that box's `/home/exedev/app/.env`, the unit's mandatory `EnvironmentFile=`
      (`AssertPathExists`), which reaches the engine's process env without touching DF2.10's
      image-baked `QDS_` allow-list (the `.env` is box-local, never image content); the leg's
      dispatch writes the `QDS_PI_BIN=<allocator path>` line beside the provisioned key, and Leg B's
      box carries no such line, so the production pi runs there. It allocates past the fixture bound in a
      loop and exits; the cgroup machinery, the `memory.max` write and the `oom.group=1` write are
      the production ones. This leg costs **≈zero spend** (it never calls the model) and is
      *producible by construction*: its falsifier is the SHIPPED VERDICT reading false — ruling 8's
      full rule, not `oom_kill` alone, since `oom_kill > 0` can hold while the verdict is correctly
      false: a real crossing must leave `oom > 0`, a kill counter > 0 AND `memory.peak` **at or above
      `bound - OOM_PEAK_SLACK_BYTES` (2 MiB)** — NOT "at the bound", which is what this clause said
      until round 18 and is STRICTER than what ships. The slack is not padding: the charge that
      triggers the OOM is the one that FAILS and is rolled back before the watermark, so at the kill
      usage sits below the limit by up to that charge. A leg asserting equality would reject a
      genuine own-limit kill. **The peak clause is also CONDITIONAL on the measurement existing.** The shipped rule SKIPS
      the peak comparison when `memory.peak` reads 0 (pre-5.19 kernel) or no bound was supplied, so
      on such a kernel a valid own-limit kill satisfies the verdict with no peak measurement at all
      and the peak is NOT a falsifier there. The leg therefore carries a kernel prerequisite: assert
      the peak clause only on **5.19+**, and **the leg must MEASURE that, not assume it** — read
      `uname -r` on the box first, and where it is below 5.19, `oom` plus a kill counter is the whole
      falsifier. **The exe.dev fleet's kernel version is NOT ESTABLISHED anywhere in this story**, and
      it cannot be established from the image: a container shares the HOST kernel, so neither the
      digest-pinned base nor systemd 255 in `oci/exedev/Dockerfile` bounds it. An earlier draft of
      this clause inferred 5.19+ from systemd 255 — unsound on both counts, and recorded here rather
      than silently deleted, because the same inference is the obvious one to make again. Stated because the
      escape is deliberate — suppressing a real kill on a missing measurement is the worse direction
      — and a leg that treats a skipped conjunct as a failed one would report a true kill as a miss. The leaf surviving `rmdir` falsifies it too. A crossing that does not fire falsifies
      the story. **Leg B — the
      attachment (proves the real-pi precondition: a normal solicitation runs inside a real leaf,
      under the bound, and the telemetry reads are live).** The round's real solicitation
      (~401 µ$ measured on the tier's host-side leg — the ~25 µ$/$0.000025 figure is the tier-2
      **in-box** solicitation measurement) asserts `memory.peak` < the bound, `memory.events`' `oom_kill` count `0`,
      the leaf removed after the call, and `resident.exitStatus` unset — a normal call MUST NOT
      fire. Legs A and B together are what AC1 claims; neither substitutes for the other, and a leg
      that cannot say which clause it proves proves nothing. **Sited on the dedicated in-box
      dispatches** (E2E Slice) — `fleet run` rounds under `qds-run@.service`, one box per leg, **not**
      fourth legs in the host-side `tier4-resident.live.test.ts` file, whose every leg runs
      `pipeline-run.ts` on the darwin operator host where no cgroup exists. The host-side file's
      `runLeg` harness, isolated-HOME and fixture-catalog setup are reused where they transfer;
      the enforcement assertions run against the in-box round's harvested journal and
      `memory.peak`/`memory.events` reads. **Gate:**
      `QDS_E2E_LIVE` + `QDS_E2E_TIER=2` — the file calls `liveGate("2")`, and "tier 4" is a roster
      label, never an env value (`.claude/skills/qds-live-e2e/SKILL.md`); exporting
      `QDS_E2E_TIER=4` throws. **Setup inherited from the tier:** isolated `HOME` (gotcha #2 — host
      `~/.pi/agent/auth.json` shadows `OPENROUTER_API_KEY`), `QDS_PI_CATALOG_DIR` at
      `tests/phase-engine/fixtures/pi-catalog`, teardown in `finally` — a leaked box on an OOM path
      is a leaked box that bills. **A host-side unit test cannot substitute — darwin has no cgroups
      — and the story is not done without this round.**
- [ ] **Test (pi baseline RSS measured, AC1 precondition — LIVE, roster tier 4):** on the in-box dispatch's own round, read `memory.peak` from a **control solicitation that allocates nothing** — the real-pi leg's own first arming read inside its live leaf, on the box where the bound actually applies (the host-side L2 leg has no cgroup and no `memory.peak` to read) — and record it in the round evidence. This is the measurement neither the ADR nor the 2026-08-31 probe took — the probe measured wall time (2.17 s) and cost, never memory — and both memory figures in this pair currently rest on it being small. **Then set:** the E2E fixture bound to ≥ 2× the measured baseline, and **re-set DF3.6a's `PROVISIONAL_RESIDENT_RSS_BYTES` in `resident-bounds.ts` — that one constant is in this story's Files to Modify** (W6-C-H4 as re-homed by W14C-PAIR-1: the value lives in DF3.6a's bounds module, `manifest.ts` carries no default — the W6-C-H4 rationale stands, the file moved with the required-field design). **Falsifier, and it falsifies the story not the test:** if the baseline is ≥ 32 MiB, the 64 MiB fixture bound is too low and AC1's live round proves the cgroup is *attached* rather than that an allocation *crossed* the bound — the assertion would be passing for the wrong reason. If the baseline is ≥ 256 MiB, the 512 MiB production default has less than one doubling of headroom and must be re-set before this story ships. **KERNEL PREREQUISITE, and it is not optional (added round 20):** read `uname -r` on that box FIRST
  and require **5.19+**. `memory.peak` landed in 5.19; below it the file does not exist and `readLeaf`
  reads **0**. A baseline of 0 passes BOTH falsifiers above — it is neither ≥ 32 MiB nor ≥ 256 MiB — so
  a round on an older kernel would silently conclude "the baseline is small", re-set
  `PROVISIONAL_RESIDENT_RSS_BYTES` **off a measurement that was never taken**, and report success. The
  live-leg item above already carries this prerequisite for the crossing verdict; it was never extended
  to this item, which is the one that actually writes a production constant. Treat a 0 reading as
  MEASUREMENT FAILED, never as a baseline. Marginal spend: zero — it reads a file from a solicitation
  the round already makes.
- [ ] **Test (cgroup scoping, AC2):** a `dispatch_task` phase running beside a small resident does **not** trip the bound — the workers are not in the resident's cgroup. An implementation setting `MemoryMax=` on `qds-run@<runId>.service` passes a synthetic-allocator "does it fire?" test and MUST fail this one. **HOST-SIDE, against the fs-level fake** (`tests/fleet/resident-cgroup.test.ts`) — labelled round 20, because 689/690/691 self-declare their environment and these four did not, and a test-writer building strictly from this checklist could reasonably have budgeted a live in-box leg that the E2E Slice does not fund. No real kernel is involved: what this proves is the code's own logic, not enforcement.
- [ ] **Test (fail-closed unenforceable, AC3/INV-MEM-2):** with `Delegate=memory` absent from the unit, the resident is **not started**, the journal records `resident.status:"disabled"`, the log line carries `reason:"rss_unenforceable"` (ruling 5 — this checkbox said `cause:"unenforceable"`, which is the AC4 breach line's vocabulary, not this one's; `resident_disabled` discriminates on `reason`, as the rate refusal already does, and an acceptance test written from the old wording asserts a key the line does not have), no tripwire row is emitted, and the run still completes deterministically — never an unbounded resident. **HOST-SIDE, against the fs-level fake** (`tests/fleet/resident-cgroup.test.ts`) — labelled round 20, because 689/690/691 self-declare their environment and these four did not, and a test-writer building strictly from this checklist could reasonably have budgeted a live in-box leg that the E2E Slice does not fund. No real kernel is involved: what this proves is the code's own logic, not enforcement.
- [ ] **Test (image contract):** the Dockerfile unit scan fails the build when `Delegate=memory` is removed from `qds-run@.service` — the assertion is the fence, the same shape as the Dockerfile's existing `RuntimeDirectoryPreserve=yes` check.
- [ ] **Test (fail-closed placement, AC4):** with the leaf removed (or `+memory` disabled) between arming and the `cgroup.procs` write, the wrapper exits **97** and pi is never `exec`'d; the engine's catch classifies the failure through the typed `PlacementRefusedError` rejection — never the `"degraded"` latch; the `onBoundBreach` callback carries `{bound:"rss", allowed:false, cause:"unenforceable", exitCode: 97}`; the **engine-side `resident_bound_breach` fd-2 line** records that payload (ruling 7 — this checkbox said the fleet `warn` line, which carries the separate per-solicitation `resident_cgroup` event and holds neither join key; an acceptance test written from the old wording asserts against the wrong emitter); `residentSpawn.stop()` is awaited; and **no subsequent solicitation is issued** for that resident. A wrapper joining the commands with `;` execs pi unbounded and records a clean call, and MUST fail. **HOST-SIDE, against the fs-level fake** (`tests/fleet/resident-cgroup.test.ts`) — labelled round 20, because 689/690/691 self-declare their environment and these four did not, and a test-writer building strictly from this checklist could reasonably have budgeted a live in-box leg that the E2E Slice does not fund. No real kernel is involved: what this proves is the code's own logic, not enforcement.
- [ ] **Test (OOM stops the resident, AC5):** after a kernel OOM-kill the journal reads `status:"stopped"` **and** `exitStatus:"overflow"`, `stop()` has been called via `onBoundBreach`, and no further solicitation is issued. An implementation leaning on the `"degraded"` status gate leaves `stopped === false` and MUST fail; so MUST one that leaves `status:"degraded"` beside `exitStatus:"overflow"`. **HOST-SIDE, against the fs-level fake** (`tests/fleet/resident-cgroup.test.ts`) — labelled round 20, because 689/690/691 self-declare their environment and these four did not, and a test-writer building strictly from this checklist could reasonably have budgeted a live in-box leg that the E2E Slice does not fund. No real kernel is involved: what this proves is the code's own logic, not enforcement.
- [ ] **Test (host-side seam, INV-MEM-2 Scope):** omitting `residentRssBytes` arms a resident with **no** cgroup calls (this is what keeps `tests/fleet/resident.test.ts`'s 42 arming sites and DF3.3's INV-RES-3 exhibit green on darwin); supplying it on a host without cgroup v2 refuses to start. Both asserted.
- [ ] **Test (reclaimable pressure is not a silent miss, M1):** a solicitation driven to `memory.max` by **file-backed** (reclaimable) growth thrashes rather than OOMs, and the run records a **timeout** (`SOLICIT_TIMEOUT_MS = 60_000`, `src/phase-engine/steering.ts:30`) — not a `watchdog_kill`, and not a silent pass. Asserts the classification, so a missing `oom_kill` count on that path reads as "the other backstop fired", never as "the bound is absent". **Host-side, faked and unconditional** (amended 2026-09-18, Dev Agent Record ruling 6 — this clause originally read "host-side where cgroups exist; skipped, not faked, where they do not", which the shipped test does not satisfy and should not: a skip proves nothing in any environment). The test stages the leaf's counters with a limit that was HIT AND RECLAIMED and asserts the timeout classification; real page-cache reclaim is the live round's, and the test says so in its own header.
- [ ] **Test (leaf lifecycle, host-side):** the subtree split is idempotent across engine restarts; a leaf is removed after every call including the OOM path; a second solicitation gets a fresh leaf and a fresh `memory.peak`. An implementation writing `memory.max` **without `memory.oom.group=1`** leaves a surviving sibling on a multi-process pi tree and MUST fail leaf removal (`EBUSY`).
- [ ] **Test (the rss bound's numeric contract — DF3.6a review handoff, 2026-09-18):** DF3.6a
      shipped `residentRssBytes` validate-and-carry with **zero behavioral coverage** — its suite
      pins the schema/loader refusal shape only, so the bound's arithmetic and breach shape are
      untested anywhere until this story. These DoD test items are therefore the field's FIRST
      behavioral coverage: at least one must assert the numeric contract itself (bound compared
      against the measured `rssPeakBytes` figure, breach classified `watchdog_kill` and nothing
      else) — not only the cgroup mechanics around it.
      **DO NOT PORT THE BYTE-FOR-BYTE READBACK TO A LIVE LEG (surfaced here round 20).** The
      host-side row satisfying this item asserts `memory.max` reads back EXACTLY what was written,
      including for a deliberately non-page-aligned bound (12,345,678). That is true of the fake only:
      a real kernel `PAGE_ALIGN`s `memory.max` upward on ingestion, so the same assertion fails live
      while the code is perfectly correct. It is inert in production because nothing reads `memory.max`
      back — `readLeaf` reads only `memory.peak` and `memory.events` — and the rounding moves the real
      limit AWAY from the peak, the safe direction. This caveat was written in the NOT-DONE section and
      **nowhere near the checkbox that generates the test**, which is the same orphaned-caveat shape
      that has already cost this story a round. An implementation whose assertions pass with
      any bound value (fixture-bound-agnostic) leaves the numeric contract still untested and MUST
      fail this item.

## Dev Agent Record

**Implemented 2026-09-18** on `feature/df3-6b-resident-memory-cgroup`. What shipped, what was
ruled, and what is NOT done.

**Review provenance: `_bmad-output/evidence/df3-6b/review-round-{1..21}.md`** — twenty-one adversarial
rounds, **six before the first push and fifteen after**, plus CodeRabbit's rounds on PR #264. (Round 6
is titled "final gate before push"; round 7 is the first to respond to PR #264. An earlier version of
this line said three and nine — the total was right, the split was not.) Round 12 is
the one to read if you are wondering why a ruling below enumerates its own downstream repetitions:
it swept all nine rulings for propagation and found **thirteen** sites still out of step across
**four** top-level rulings (3 with 3b, 5, 7 and 9), three of them carrying claims a ruling had
already retracted. (Round 12 first recorded "eleven sites" over "three" rulings, and its commit
message says the same; round 13 re-counted from the enumeration — 4 + 4 + 1 + 1 + 3 — and corrected
both. The commit message is immutable and wrong; this line supersedes it.) Read them in
order if you need to know WHY a rule is shaped the way it is; several later rounds RETRACT earlier
ones (most importantly round 9 retracts round 7's claim about the peak floor), and every retracted
claim carries a `SUPERSEDED` note pointing at the round that replaced it. **The rulings below are
the current word; the evidence files are history.**

### Shipped

| File | What landed |
|------|-------------|
| `src/fleet/resident.ts` | The whole mechanism: `CgroupUnenforceableError`, the one-time delegated-subtree split (`supervisor/` + `+memory`, idempotent across engine restarts), per-solicitation leaf create with `memory.max` **and** `memory.oom.group=1`, the fail-closed `sh -c` self-placement wrapper (exit **97** on refusal, positional argv — keyed on membership read back from `cgroup.procs`, NOT on the write's exit status; the `\|\| exit 97` form was rejected, see the amendment), `memory.peak`/`memory.events` read before removal, leaf teardown on every exit path, `lastMemory()` on `ResidentSpawn`, optional `residentRssBytes` on `ResidentSpawnOpts`, and the arming check against a REAL probe leaf. |
| `src/phase-engine/steering.ts` | Edit (1): the OOM writer in the call-failure catch — `status:"stopped"`, `exitStatus:"overflow"`, a `watchdog_kill` tripwire carrying the peak and the bound, then `onBoundBreach({bound:"rss", cause:"watchdog_kill"})`. Ordered BEFORE the degrade arm. The dep's return type gained `boundBytes?`. Edit (2), the `PlacementRefusedError` arm, **was already landed in DF3.6a's diff** and needed no change. |
| `scripts/pipeline-run.ts` | (iii) `residentRssBytes` on `startResident`; (iv) `lastMemory: spawned.lastMemory` on `createSteering`; (vi) the `rss_unenforceable` arming-refusal arm beside the rate arm; (vii) the run-down refresh precedence; plus the `inBoxFrontDoor` enforcement-context latch (ruling **3b** below — ruling 3 is the tripwire contract and says nothing about this latch), which is a PARAMETER of `main`, not module state: review round 14 found it as a module-level `let` that was set before the in-box re-entry and never reset, and demonstrated the leak by driving two in-process `main()` calls, where the second (host-side) call inherited the first's `true` and was degraded by cgroup machinery it should never have touched. |
| `oci/exedev/systemd/qds-run@.service` | `Delegate=memory`, scoped rather than `Delegate=yes`. |
| `oci/exedev/Dockerfile` | The positive `grep -qE '^Delegate=memory$'` unit-scan assertion. |
| `tests/fleet/fixtures/fake-pi-resident.ts` | DF3.3's SHARED fake pi gains FIVE test-only knob groups the cgroup suite drives (7 env vars): staging `memory.events`/`memory.peak` into the live leaf, copying the leaf's `cgroup.procs` out, recording the leaf's armed state, forcing an exit code, and dying by SIGKILL. Additive and env-gated — every existing caller that sets none of them is byte-for-byte unaffected. |
| `tests/scripts/build-exedev-image.test.ts` | The buildId pin re-derivation (the offline half of DF2.10's ritual): both asset digests and the whole-walk digest. FOUR walked inputs move the whole-walk literal — the unit, `src/fleet/resident.ts`, `src/phase-engine/steering.ts`, `scripts/pipeline-run.ts`. `oci/exedev/Dockerfile` also changed and is NOT one of them: it is `deriveBuildId`'s own separate `dockerfile` field, absent from all 89 entries `buildIdFileInputs` returns (verified by calling it directly). |
| `tests/providers/exedev/image-assets.test.ts` | `Delegate` pinned in `directive-set` (key + position) and in `hardened` (VALUE — `Delegate=yes` passes the key check and must not pass this one), with two MUTATIONS negative controls. |
| `tests/fleet/resident-cgroup.test.ts` (new) | Split + idempotence, the **three** AC3 refusals (`Delegate=memory` absent, no unified hierarchy, and the arming check against a real object — each asserting `CgroupUnenforceableError`) **plus the caller-fault control** that asserts the OPPOSITE: a garbage bound is `not.toBeInstanceOf(CgroupUnenforceableError)`, because it is the caller's fault and not an unenforceable box (this row said "the four AC3 refusals" until round 16, counting the control as a refusal and overclaiming in the dangerous direction), the INV-MEM-2 Scope seam, the leaf lifecycle, the numeric contract (two distinct bounds through one path), AC2's no-unit-level-MemoryMax assertion, the wrapper's refusal as SHIPPED — a failed placement exits 97 and never `exec`s pi, a POSITIVE control that the same script DOES exec pi when placement succeeds, and the row that pins the actual rule: a placement that silently did NOT take still exits 97, because the guard is keyed on MEMBERSHIP READ BACK from `cgroup.procs` and not on the write's exit status (the `\|\| exit 97` form this row used to name was rejected during development — see the amendment; corrected round 16), INV-MEM-3's hostile-prompt argv test, the OOM-verdict discrimination (an own-limit kill vs a global OOM that merely picked pi), the exit-97 to `PlacementRefusedError` join with its unbounded-call negative control, and M1 (a staged-counter classification test — ruling 6). |
| `tests/phase-engine/steering.test.ts` | AC1/AC5 arms plus three negative controls (no kill ⇒ degrade; no dep ⇒ unchanged; throwing dep ⇒ sidecar) and the ordering assertion. |
| `tests/phase-engine/in-box-engine.test.ts` | AC3 end-to-end through the unit's front door: no cgroup v2 ⇒ `resident_disabled`/`rss_unenforceable`, journal `disabled`, run settles ok, no tripwire, and explicitly NOT `rate_unresolved`. |

Edit (v) needed no change: the shipped `onBoundBreach` handler already awaits `residentSpawn.stop()`
and records `{...e}` (which carries `bound`/`allowed`/`cause`/`exitCode`) on the **engine-side**
`resident_bound_breach` fd-2 line for EVERY cause, so both `watchdog_kill` and the exit-97
`unenforceable` classification land there with their join keys. Verified rather than re-written.
(The fleet `warn` chokepoint carries the separate `resident_cgroup` line — ruling 7.)

### Rulings this story owed (the four DF3.6a review handoffs)

1. **`lastMemory` dep was landed and unused** — closed. Edit (iv) wires it and the steering OOM
   writer consumes it.
2. **`residentRssBytes` had zero behavioural coverage** — closed. The numeric contract is asserted
   directly: `tests/fleet/resident-cgroup.test.ts` drives TWO distinct bounds through one code path
   and reads `memory.max` back byte for byte, so a fixture-bound-agnostic implementation fails; the
   steering tripwire test asserts the breach names the measured peak and the bound it crossed.
3. **Tripwire `code`/`bound` keys contradiction — RULED: amend the contract sentence, do NOT widen
   the type.** `ResidentTripwire` stays DF3.3's closed five-key shape. `bound`, `allowed`, `cause`
   and `exitCode` ride the fd-2 `resident_bound_breach` warn line, which is what DF3.6a already
   shipped and what this story's `onBoundBreach` payload carries; the peak and the bound ride
   `detail`. Widening a type DF3.3 owns, for keys a shipped log line already carries, would be a
   cross-story amendment buying nothing. The Observability Contract above is amended in place.
4. **Duplicate phase names pool one iteration budget — DEFERRED, deliberately, with reason.** The
   clean fix needs either a phase ordinal through the steering↔guard interface or a dup-name check
   at guard construction, and BOTH land in `src/phase-engine/resident-bounds.ts`, whose entry in
   this story's Files to Modify is scoped to *"the `PROVISIONAL_RESIDENT_RSS_BYTES` constant only —
   no other field, no schema change"*. Folding it in here would break this story's own file budget,
   which the pair's split exists to keep. It stays where DF3.6a recorded it, on the S3-7
   config-level precedent: under-refusal only, never over-refusal, so a duplicate-name manifest
   spends MORE solicitations than intended but can never refuse a legitimate one. **Owner: a
   follow-up on DF3.6a's ledger, not this story.**

### Ruling 9 — the peak floor is a consistency check, and one residual is irreducible

**Amends ruling 8, and corrects a claim this record made.** Ruling 8 said the peak floor closes the
global-OOM false positive. It does not, and the correction matters because the wrong version was
repeated downstream before it was caught (CodeRabbit, PR #264 round 3, Major; verified against
`mm/memcontrol.c` and `mm/oom_kill.c` in two independent reviews).

**What actually narrows the false positive is `oom`, not the peak.** `oom` is raised only in
`mem_cgroup_oom()`, on the memcg whose OWN `memory.max` a charge was about to exceed — so a resident
picked by a system-wide OOM while nowhere near its bound reads `oom` 0 and the predicate is already
false, with no peak comparison involved.

**The peak floor cannot discriminate at all on this topology, because it is implied.** `oom > 0`
means the failing charge was about to cross the limit; that charge is never added to
`memory.current`; and `memory.peak` is monotonic and never reset here (the reset API is 6.11+).
Therefore `oom > 0` ⟹ `peak >= bound - <failing charge>` — exactly the 2 MiB slack window. **It is
kept anyway**, for three reasons that are not "belt and braces": it is free (one read already
taken); it catches a self-contradictory reading; and it stops being implied the moment the leaf
gains children, since `memory.events` aggregates UPWARD and a child with a smaller limit could fire
`oom` far below this bound, at which point the floor becomes load-bearing. **If that future arrives
the floor is the INTERIM guard, not the answer:** the same aggregation breaks `oom_kill` and
`oom_group_kill` too, and the correct fix is to read `memory.events.local`, which counts this
cgroup's own events and not its descendants'.

**THE RESIDUAL, stated precisely so it is not rediscovered as a sixth door.** A global OOM that
kills a resident whose leaf had **already registered its own `oom` event and survived it** — a
graceful `-ENOMEM` — is **indistinguishable** from an own-limit kill. Both terminate as
`oom>=1, oom_kill>=1, oom_group_kill>=1, peak≈bound, current≈0`. Note the precondition is narrower
than "a resident near its bound": the leaf must have registered an `oom` AND survived it. No
readable cgroup v2 file separates the two states — `memory.events.local` equals `memory.events` on a
childless leaf, and `oom_group_kill` is credited to whichever ancestor sets `oom.group`, which for a
global OOM is still this leaf. **"Classify the state as ambiguous" is therefore not implementable as
stated: there is no field whose value differs, so it would classify every TRUE kill as ambiguous and
destroy AC1.**

**The one true attribution signal, and why it is not bought.** The kernel's own OOM report
distinguishes them — `oom_memcg=<path>` for a memcg-limit kill versus `global_oom` for a global one,
from `mem_cgroup_print_oom_context()`. It is unreachable for `User=exedev`: `/dev/kmsg` and
`syslog(2)` require `CAP_SYSLOG` under `kernel.dmesg_restrict=1` (the Debian/Ubuntu default, and the
permission bits on the node mislead — the capability check is what refuses), and journald ACLs the
kernel journal to `systemd-journal`/`adm`, groups a dedicated service user is not in. Buying it
costs `AmbientCapabilities=CAP_SYSLOG` on the unit plus a log-parsing and time-correlation path — to
remove a residual whose cost is a mislabelled tripwire row. **Rejected as a worse trade, explicitly,
rather than left unconsidered.** A `poll()`/`POLLPRI` watcher on `memory.events` was also considered
and rejected: kernfs notifications coalesce when the reader has not drained, so on a thrashing box —
the only condition under which this scenario arises — it wakes once with both counters already moved
and reports a true kill, failing hardest in the case it exists to catch, and it would cost a poller
thread per solicitation against this story's "nothing here samples" property.

**The downstream repetitions, ENUMERATED (2026-09-19).** This ruling originally said "the wrong
version was repeated downstream before it was caught" and named no member, which left the members
unfixed. They were three, all now closed: **(1)** the test row below; **(2)** `readLeaf()`'s own
comment block in `src/fleet/resident.ts`, whose setup paragraph asserted "A THIRD FACT" twelve lines
*above* its own ruling-9 correction — reworded so the retracted framing is not stated affirmatively
anywhere; **(3)** `readLeaf()`'s JSDoc, which sits ABOVE the body and so was never reached by any of
the body's corrections — it presented the peak conjunct as a co-equal third member of the
conjunction, which is what a caller sees on hover. A ruling that names a class of stale sites without
enumerating them does not propagate; that is the lesson, and it is why this list is explicit.

**Pinned in the suite, not only here (added 2026-09-19).** Ruling 9 was written as prose and the
test row that predated it was left asserting the retracted claim: a row titled *"a graceful `oom`
EARLIER plus a global OOM kill LATER is still not this bound firing"* staged `oom 1, oom_kill 1`
with a 4096-byte peak against the 64 MiB bound and read `false` — but it read `false` ONLY on the
peak floor, i.e. on exactly the discrimination this ruling retracts, and the combination it staged
is one the kernel cannot produce (`oom > 0` implies the peak reached the bound). It has been renamed
to what it actually pins — *a SELF-CONTRADICTORY reading … is rejected* — and a second row now pins
the residual itself: all three counters set with `peak = bound`, asserting `oomKilled === true`, the
MISLABEL, with a note to update the row and this ruling rather than delete it if the residual is
ever closed. Mutation-verified: deleting the peak conjunct turns the first row red.

**The two verdicts are less asymmetric than they look, which is why the residual is acceptable.**
Traced through the code rather than assumed: a FALSE POSITIVE writes `status:"stopped"`,
`exitStatus:"overflow"`, one `watchdog_kill` row and an `onBoundBreach` that stops the spawn; a
FALSE NEGATIVE writes `status:"degraded"`, no tripwire, and the run-down refresh fills `exitStatus`
from the process probe as `"transient"`. **Both end resident participation for the rest of the run**
— the status gate is `telemetry.status !== "active"` and nothing after construction ever writes
`"active"` back, so `"degraded"` is exactly as terminal as `"stopped"`. Neither moves a phase, a
gate, a budget or the exit code; both return the deterministic default. The difference is
EVIDENTIARY: which row D4's month-1 evaluator sees. And a false negative is not evidence-free
either — the fleet `resident_cgroup` line still carries `rssPeakBytes`, `residentRssBytes` and
`oomKilled:false` on fd-2, harvested with the journal.

**Why this residual is acceptable, stated as the argument rather than as a shrug.**

1. **`oomKilled` is a LABEL, never a CONTROL.** It gates no allocation, admits no unbounded call and
   changes nothing the kernel does. Enforcement is AC3's arming refusal and AC4's fail-closed
   placement, and neither is touched by this predicate. A mislabel costs reporting accuracy, not
   containment.
2. **The row is over-specific, not fabricated.** In the residual state `oom >= 1` is TRUE and
   unforgeable: this leaf reached ITS OWN `memory.max` and could not reclaim, inside this
   solicitation. Stopping the resident and recording a bound breach is the correct action for that
   fact under AC5. What is unproven is only which killer delivered the final blow.
3. **The window is ONE solicitation, at most `SOLICIT_TIMEOUT_MS` (60 s).** The leaf is created per
   call, `lastMemory` is cleared at the top of every call, and the leaf is torn down in that call's
   `finally`. Both counters must land inside that single window — not "sometime during the run".
4. **This engine runs nothing concurrently with a solicitation, which narrows the trigger further.**
   Verified at the call sites rather than assumed: all three solicitation points sit OUTSIDE any
   running phase body — `run_start` and `run_end` by construction, and `post_gate_failure` fires
   "AFTER the verdict AND after the authorization", i.e. once the phase's command and gate have
   already settled (`scripts/pipeline-run.ts`, the three `solicitResident(` call sites). So the
   scenario the residual's own description reaches for — *a `dispatch_task` worker balloons and
   drives the box into system-wide OOM* — cannot be this run's worker running beside the
   solicitation. It has to be pressure from outside this run's phase bodies: the box's other
   tenants, or the engine and its supervisor leaf. Combined with (3), the trigger is
   externally-sourced box-wide pressure landing inside one ≤60 s solicitation window that had
   already registered its own `oom`.
5. **The only real cost is D4.** The `watchdog_kill` rows are the evidence a month-1 evaluator uses
   for "any steering loop the watchdog kills twice for the same cause" → demote tier 2 to code-only
   dispatch. A false positive is a fabricated vote toward a FLEET-WIDE capability reduction, and it
   also points an operator at `residentRssBytes` when the actionable cause was box-wide pressure.
   That is the reason to keep this residual documented and bounded rather than forgotten — and the
   reason the evaluator's key remains its own decision, as the Technical Notes already say.

**And the remedy would cost more than the residual.** A third "ambiguous" state has to become
journal-readable to be worth anything, which means widening two closed unions **neither owned by this
story**: `ResidentStatus`, where DF3.3's AC5 explicitly forbids a fourth value, and
`ResidentTripwire["cause"]`, widened only in DF3.6a by design. Cross-story union surgery, a state no
story owns, and at the gate it still has to resolve to one of the two existing dispositions. It adds
a name, not information.

**The live round can check what production cannot.** The AC1 in-box legs run on a box we provision,
so if `dmesg` is readable there the round may read the OOM report once to confirm `oom_memcg=` names
the solicitation leaf. That is a one-off verification of the mechanism, not a production dependency.

### Ruling 8 — the OOM verdict is the kernel's own record (amended by ruling 9: the peak floor is a consistency check, not a third independent fact)

Recorded because this predicate was corrected five times from five different doors before it was
specified rather than patched, and the next reader should find the specification, not the scar
tissue. The claim the verdict makes is *"a process in THIS leaf was killed by the kernel BECAUSE
THIS leaf hit THIS bound"* — TWO facts the kernel publishes independently, both in `memory.events`,
plus a `memory.peak` consistency check that ruling 9 shows is implied by the first of them rather
than being a third independent fact.

| fact | where the kernel publishes it |
|------|-------------------------------|
| this leaf hit **its own** `memory.max` and could not reclaim | `memory.events`' `oom` — raised only on the own-limit charge path, never for a global or an ancestor's OOM |
| a process in this leaf was **killed** by an OOM killer | `memory.events`' `oom_kill` / `oom_group_kill` — **any** OOM killer, own or global |
| the kill happened **at** the limit, not far below it | `memory.peak` — **CORRECTED by ruling 9: this row does NOT discriminate.** `oom > 0` already implies the peak reached the bound (within one failing charge), so the floor is a consistency check, not the third of three independent facts. It is kept for the reasons ruling 9 gives, and it is what `oom > 0` would rely on if this leaf ever gained children |

**Neither alone is the predicate**, and each alone shipped a false `watchdog_kill` here: `oom_kill`
alone counts a system-wide OOM that merely picked pi; `oom_group_kill` alone is **not**
own-limit-only either, because on a global OOM the kernel's `oom_domain` is the root, so it walks up
from the victim, finds this leaf's `oom.group=1`, group-kills it and increments `oom_group_kill`
*here*; and `oom` alone can be a graceful `-ENOMEM` the task survives.

**RULED — the complete rule, exactly as shipped, with nothing to assemble from elsewhere:**

```ts
const ownLimit     = oom > 0 && (oom_kill > 0 || oom_group_kill > 0);
const reachedBound = peakBytes === 0 || boundBytes === undefined
                  || peakBytes >= boundBytes - 2 * 1024 * 1024;   // OOM_PEAK_SLACK_BYTES
const oomKilled    = ownLimit && reachedBound;
```

From the kernel's own record alone; the process's exit shape is consulted nowhere. **See ruling 9**,
which corrects this ruling's claim that the peak floor closes the global-OOM false positive: it does
not — `oom > 0` is what narrows it, the peak conjunct is a consistency check implied by `oom` on
this topology, and one residual is irreducible. The two counters are INDEPENDENT, so the conjunction
of them only NARROWS the global-OOM false positive: a solicitation that took a graceful `-ENOMEM`
early (`oom` 1, survived) and was LATER picked by the system-wide OOM killer (`oom_kill` 1) sets
both, and nothing in the counters says the two events are unrelated — a pairing that is not exotic,
since global OOM happens exactly when the box is thrashing and the near-bound resident is the
likeliest victim. **CORRECTED by ruling 9 — the third fact does NOT close that pairing; `oom` is
what narrows it, and the peak floor is implied by `oom` rather than independent of it.** The
original claim, kept so the correction is legible: an own-limit kill cannot happen BELOW the limit, so
`memory.peak` must have reached the bound, while a global victim's sits under it. **The comparison
carries 2 MiB of slack, and the slack is part of the rule rather than padding:** `memory.peak`
tracks `memory.current`, and the charge that TRIGGERS the OOM is the one that FAILS —
`page_counter_try_charge()` rolls it back and `goto failed` BEFORE the
`WRITE_ONCE(c->watermark, new)`, so **it never reaches the high-water mark**. At the kill, usage
therefore sits below `memory.max` by up to that charge's size, which is why the slack exists at all:
without it a strict comparison would reject a genuine kill. **Do not remove the slack on the
strength of the peak being implied — implied is not equal.** **CORRECTED (ruling 9's review): sized to the `MEMCG_CHARGE_BATCH` path
(256 KiB) and order <= 3, NOT to a THP fault.** `mem_cgroup_oom()` returns `OOM_SKIPPED` for
`order > PAGE_ALLOC_COSTLY_ORDER` before raising `MEMCG_OOM`, so a failed THP charge never produces
the `oom` event this predicate requires. 2 MiB is ~8x more headroom than the implication needs, kept
because the conjunct is a consistency check rather than a discriminator. The
false positive being targeted is a peak sitting FAR below the bound, not one 2 MiB short.

**The slack must not be grown "to be safe", and it is SCALE-DEPENDENT.** It is the one direction in
which the peak conjunct can be disarmed: 2 MiB against a 512 MiB bound (or the 64 MiB fixture) still
rejects the global-OOM victim, whose peak sits far below; at 16 MiB it would start passing those
again and the false `watchdog_kill` rows return. Because it is a constant it loosens as a fraction
as the bound shrinks — **a future story that lowers `residentRssBytes` below ~32 MiB, where 2 MiB
exceeds 6% of it, must revisit this** (e.g. `min(2 MiB, bound / 16)`). Recorded here so it is not
rediscovered from a sixth door. The peak conjunct is applied only when both figures are available — a pre-5.19 kernel has no `memory.peak` and reads
0, and suppressing a real kill on a missing measurement would trade this false positive for a false
negative, which is the worse direction.

**Accepted and stated rather than hidden:** an ANCESTOR-limit OOM raises `oom` on the ancestor, not
on this leaf (`memory.events` aggregates upward, not down), so it reads false here. That is correct
under AC2 — the bound this story enforces is the leaf's — but it means ancestor pressure is
invisible to this verdict.
The process's exit shape — `signalCode`, exit 137, "did we send the SIGKILL" — is deliberately NOT
consulted: it is a proxy for *was it killed* that cannot say *by whom*, which is the entire
discrimination, and it counted this layer's own `stop()` SIGKILL as the kernel's. The five doors the PREDICATE
failed through — the first four of them exit-shape doors, the fifth not — kept as the reason the
rule is stated this strongly: (1) a global kill counted by
`oom_kill`; (2) a graceful `-ENOMEM` where `oom` fired and nothing died; (3) an assumed kill in
`stop()`, which counted this layer's own SIGKILL as the kernel's; (4) a `QDS_PI_BIN` free to exit
137 of its own accord; and (5) the two-counter residual — a graceful `-ENOMEM` early paired with a
global kill later, which sets both counters. **Door (5) is NOT closed: ruling 9 retracts the claim
that the peak floor separates it, and records it as the one irreducible residual.**

### Ruling 6 — M1's "skipped, not faked" clause

The M1 DoD item ends *"Host-side where cgroups exist; skipped, not faked, where they do not."*
**RULED (review round 3): amend the clause — the shipped test is faked and unconditional, and that
is the better test.** A skip proves nothing in any environment, and the first version of this test,
written to the clause, was vacuous in both: it asserted `oomKilled === false` against a leaf with no
`memory.events` at all, where `false` is `readLeaf`'s unconditional default. The shipped test stages
the leaf with counters recording a limit that was HIT AND RECLAIMED (`max` non-zero,
`oom`/`oom_group_kill` zero) and asserts the call classifies as a TIMEOUT with `oomKilled:false` —
which an implementation reading `max` as a kill fails. What no host-side test can produce is real
page-cache reclaim; that remains the live round's, and the test says so in its own header.

### Ruling 7 — where the AC4 payload actually lands

Recorded because the first draft of this record named the wrong emitter. The AC4 breach payload
`{bound:"rss", allowed:false, cause:"unenforceable", exitCode:97}` rides DF3.6a's **engine-side**
`resident_bound_breach` fd-2 line in `scripts/pipeline-run.ts` (the `onBoundBreach` handler's
`...e` spread carries every key), **not** the fleet `warn` chokepoint, which carries the separate
per-solicitation `resident_cgroup` line (the Observability Contract's amendment above). Both land on
fd-2 and are harvested with the journal; the distinction matters because only the engine-side line
carries the `runId`/`requestId` join keys.

### Ruling 5 — `reason:"rss_unenforceable"` vs the DoD's `cause:"unenforceable"`

A second spec-internal contradiction, named here because ruling 3 settled its sibling and silence
would read as unnoticed rather than decided (review round 2, finding 9). AC3's body specifies the
arming-refusal line as `{level:"warn", event:"resident_disabled", runId, requestId, model,
reason:"rss_unenforceable", detail}`; the AC3 DoD checkbox says "the log line carries
`cause:"unenforceable"`". **RULED: AC3's body wins, and the DoD sentence is the loose one.**
`resident_disabled` is a SHIPPED line shape whose discriminator key is `reason` — the rate refusal
already uses it (`reason:"rate_unresolved"`) — so adding a second key with the same job to the same
line would fork a shipped shape for nothing. `cause:"unenforceable"` is the AC4 breach line's
vocabulary (`resident_bound_breach`, mid-call), and the two lines are deliberately different events:
one says the resident never armed, the other says a solicitation's placement failed. The
implementation emits `reason`.

### Ruling 3b — the enforcement-context latch (`inBoxFrontDoor`), a deviation, stated plainly

INV-MEM-2's Scope paragraph says the in-box and host-side contexts are told apart **by the caller,
not by a platform probe**, and that an ABSENT bound means no cgroup machinery runs at all. This
implementation makes that distinction structural: `scripts/pipeline-run.ts` supplies the bound on
the unit's front-door shape (`qds-engine run <runId>` — the one shape `ExecStart=` ever uses) and
withholds it on the host-side flag shape (`pipeline-run --manifest …`).

Without it, passing the bound on every shape refuses the resident on EVERY host-side run on darwin,
which silently disarms DF3.3's and DF3.6a's entire host-side behavioural coverage — the identical
"a memory story must not silently disarm a shipped control" hazard INV-MEM-2's Scope paragraph
exists to prevent one layer down, arriving one layer up. Measured: 18 host-side tests went dark
before the latch, including DF3.3's resident e2e wiring suite and DF3.6a's leaf-6 bound e2e.

It is **not** an env var and not a platform probe: INV-MEM-1 forbids any env var, directive or
in-box file from raising, disabling or resetting the bound, and an argv shape the systemd unit fixes
in `ExecStart=` is not reachable from the resident's tier. The consequence, named rather than
papered over: a host-side `pipeline-run` round (including the darwin tier-4 legs) runs its resident
with no cgroup bound — which is the pre-DF3.6b posture and DF5.1's still-open, still-unclosed
`ps`-sampled ceiling, explicitly left untouched by ADR Appendix B's same-day correction. The story
text anticipated the darwin legs being *disabled* instead; this is the same exposure with the
host-side coverage kept.

### NOT DONE — required handoff, and the story is not done without it

The make-or-break AC1 cannot be proven anywhere but a real box, and this round did not run one:

- **AC1's two live legs (Leg A crossing, Leg B attachment)** — a dedicated in-box dispatch per leg,
  `QDS_E2E_LIVE` + `QDS_E2E_TIER=2`, one box each, real spend. NOT RUN. **Two things the round must
  check explicitly, because they are real-kernel assumptions no host-side fake can settle:**
  (a) the placement wrapper writes with `>>` — O_APPEND on kernfs, which is the standard
  `echo $$ >> …/cgroup.procs` idiom and is believed harmless, but the flag was adopted so the
  fs-level fake could model a multi-pid `cgroup.procs` at all, so the live leg must confirm the
  placement actually TOOK (read `cgroup.procs` back on a real leaf, not just observe the exit code);
  **What is unproven if these never run, stated plainly (added round 16):** every mechanism claim in
  this story's Shipped table has only ever executed against an **fs-level fake** cgroup tree. No real
  kernel has yet accepted the placement write, enforced `memory.max`, fired `memory.oom.group=1`, or
  produced a real `memory.peak`/`memory.events` pair for the verdict to classify. So this is not a
  formality awaiting a confirmation run: **the load-bearing kernel behaviour the whole story exists
  to invoke has never been observed once.** A reader should not conclude "implemented and
  unit-tested, pending a live check" — the correct reading is that the enforcement path is
  unconfirmed against reality, and both (a) and (c) below are ways it could be silently inert.
  **(d) the EBUSY rmdir retry, under REAL reap latency — ranked the highest-risk gap by the round-17
  fidelity audit.** `cgroup.kill` SIGKILLs the leaf's tasks and `rmdir` returns EBUSY until the kernel
  finishes reaping them; the fake never produces EBUSY, so the loop was dead code until round 17 gave
  it an injected-remover test. That test pins the CONTRACT — four attempts, EBUSY only, original error
  rethrown — and cannot pin the BUDGET: whether 4 × 25 ms is enough for real reap latency on a loaded
  box is a kernel fact. The leg must tear down a leaf holding a process that is genuinely slow to
  reap, not an already-empty directory.
  **(e) `cgroup.procs` REJECTION modes.** The placement wrapper's whole fail-closed design defends
  against writes that fail or silently do not take, and on the fake a write to a plain file can only
  be made to fail by `chmod`. Real kernfs rejects with EBUSY on a transitional leaf, ESRCH on a reaped
  pid, EACCES under a uid mismatch, EINVAL on malformed content, and takes ONE pid per write. The leg
  should attempt a placement into a leaf mid-transition — immediately after `+memory` is enabled,
  before the kernel settles — and confirm exit 97 and `PlacementRefusedError` fire as the host-side
  tests assume. Cheap to check in the same leg: `ensureDelegatedSubtree` moves the pids BEFORE
  enabling `+memory`, the order a real kernel's no-internal-processes rule requires. That order is
  real production code and the split test does exercise it — but the fake would accept the WRONG
  order just as happily, since its `cgroup.subtree_control` is a plain writable file and the final
  on-disk state is identical either way. A real kernel EBUSY-rejects `+memory` while the parent still
  holds processes; nothing host-side can detect a regression in that ordering.
  **(f) NOT a live-leg item but a fidelity caveat to carry with the numeric-contract test:** it
  asserts `memory.max` reads back BYTE FOR BYTE, including for a deliberately non-page-aligned bound
  (12,345,678). A real kernel `PAGE_ALIGN`s upward on ingestion, so that assertion is true of the fake
  ONLY and **must not be ported to a live leg as written.** It is inert in production because nothing
  reads `memory.max` back — `readLeaf` reads only `memory.peak` and `memory.events` — and the rounding
  moves the real limit AWAY from the peak, the safe direction, which `readLeaf` already documents.
  (b) the synthetic allocator staged as Leg A's `QDS_PI_BIN` MUST NOT exit 97, or the leg proves
  a placement refusal instead of a crossing (see `_PLACEMENT_REFUSED_EXIT`'s docstring); and
  **(c) the box's KERNEL VERSION, read with `uname -r` before anything else** (added 2026-09-19,
  review round 13). `memory.peak` landed in 5.19, and below that the shipped verdict SKIPS the peak
  conjunct entirely — so on such a box the peak is not a falsifier and a leg asserting it would
  report a true own-limit kill as a miss. This is a fact about the exe.dev HOST, not about the
  image: a container shares the host kernel, so neither the digest-pinned base nor systemd 255 in
  `oci/exedev/Dockerfile` settles it, and nothing in this story has measured it. Listed here because
  it is exactly the class this section exists for and was missed when the section was written.
- **The pi baseline-RSS measurement** — the `memory.peak` read from a control solicitation. NOT
  TAKEN, and it is the input to the next item.
- **`PROVISIONAL_RESIDENT_RSS_BYTES` (512 MiB) is therefore UNCHANGED** in
  `src/phase-engine/resident-bounds.ts`. Re-setting it against a measured baseline is in this
  story's Files to Modify and remains open. Its falsifiers stand: a baseline ≥ 32 MiB means the
  64 MiB E2E fixture bound proves attachment rather than crossing; a baseline ≥ 256 MiB means the
  512 MiB production default has under one doubling of headroom and must be re-set before this
  ships.
  **The consequence, stated because the falsifiers above are phrased as TEST-VALIDITY problems and
  the real risk is a PRODUCTION one (added round 16):** the 512 MiB default is a guess that has never
  been checked against a measurement. If pi's real baseline is high — 300–400 MiB is not an absurd
  figure for a model client holding a session — then shipping this default does not merely enforce
  weakly, it **OOM-kills ordinary solicitations that were never runaway**. That converts a
  runaway-memory safeguard into a source of false-positive kills and an availability regression, and
  DF3.6b's own machinery makes the misfire look exactly like a genuine bound breach: `status:
  "stopped"`, `exitStatus:"overflow"`, a `watchdog_kill` tripwire, and a resident that issues no
  further calls for the rest of the run. The direction of the unknown is what matters here: an
  unmeasured baseline means the shipped margin is **unknown**, not merely unoptimised.
- **The DF2.10 image ritual — the OFFLINE half is DONE, the PUBLISH half is open.** `Delegate=memory`
  is in the unit file and fenced at build time, and `deriveBuildId`'s tracked inputs HAVE been
  re-derived in-commit (both asset digests and the whole-walk literal, per that file's same-commit
  re-pin discipline). What remains: the image has NOT been rebuilt, re-published, or its digest pin
  moved. **A run against the currently pinned digest boots a unit with no `Delegate=`, so the
  resident refuses to start (AC3).** This is exactly the "green local gate against a stale pinned
  image" failure that DoD item exists to prevent, and that half is open.
  **RELEASE-BLOCKING, stated plainly because every other sentence about it describes a mechanism
  rather than a consequence: until the image is rebuilt, re-published and the digest pin moved,
  DF3.6b DELIVERS NO ENFORCEMENT AT ALL.** Merging this PR does not arm the bound. Every in-box run
  against the currently pinned digest takes the AC3 refusal path — `resident_disabled`,
  `reason:"rss_unenforceable"` — which is the correct fail-closed behaviour and is also
  indistinguishable, from the journal alone, from a box that simply lacks delegation. The publish is
  an OPERATOR action (a registry push plus a pin move); it is deliberately not taken from inside this
  branch, and **the story is not done when this PR merges.** Raised again by CodeRabbit in review
  round 16 as a Major, correctly — it was already in the DoD, the prerequisites table, this section
  and the pin ledger, so the gap was never in the tracking; it is in the doing.
- **Refresh precedence (vii), the half that needs a kill:** the "probe fills when the engine wrote
  none" direction is covered host-side (the existing `exitStatus:"transient"` e2e). The "engine's
  `overflow` survives the refresh" direction needs an engine-written `overflow`, which needs a
  kernel OOM-kill — it lands with AC1's live round.
  **Scoped correctly (round 16), because a reviewer characterised this as a risk that AC5's
  `exitStatus` guarantee could be silently FALSE in production, and tracing the code says otherwise.**
  The refresh is guarded `if (residentSpawn !== undefined && residentBlock.exitStatus === null)`
  (`scripts/pipeline-run.ts:4738`), and `"overflow"` is assigned in exactly ONE place repo-wide — the
  OOM arm at `src/phase-engine/steering.ts:1253`. A non-null `exitStatus` is therefore never
  overwritten by the probe: the precedence direction is sound **by construction**, not merely
  untested, and no live round is needed to establish it. What IS unproven is strictly UPSTREAM of the
  precedence — that a real kernel kill reaches the OOM arm and writes `overflow` at all. That is the
  same gap as AC1's live legs, not a second independent one, and this bullet should not be read as
  doubling it.

Verification, scoped rather than generalized: `bun test` over the whole repo is **6344 pass / 7 skip / 5
fail** (re-measured 2026-09-20 on head `3c05ec39`; 6084/5 when first written, 6336 at round 10, 6338 at
round 11, 6340 at round 12, and +4 at round 17 for the EBUSY-retry rows), and none of the five is attributable to this branch — two (DF2.11 WAL) reproduce on `dev`
with this branch stashed, and three (gitnexus ×2, `tests/fleet/cli.test.ts`'s TRANSIENT-errno test)
pass in isolation on both trees under lower load. `bunx tsc --noEmit` and Biome are clean. The
suites this story owns — `tests/fleet/resident-cgroup.test.ts`, `tests/fleet/resident.test.ts`,
`tests/phase-engine/{steering,resident-e2e,in-box-engine}.test.ts`,
`tests/providers/exedev/image-assets.test.ts`, `tests/scripts/build-exedev-image.test.ts` — are
green with zero failures.

### Handed off from DF3.6a's review round 1 (2026-09-18, PR #263) — read before scoping

> **ALL FOUR ARE CLOSED.** They read below as open instructions because that is the form they arrived
> in, and this section preserves the handoff verbatim rather than rewriting history. The resolutions
> are in **"Rulings this story owed"**, EARLIER in this same Dev Agent Record — which a top-to-bottom
> reader reaches first, but this header says *read before scoping* and so invites landing here cold.
> Added round 18: the inverse of the lead-then-buried-amendment shape this story has hit three times,
> found by sweeping for that shape as a class.

Four items from DF3.6a's adversarial review round land here by ownership, recorded so
they are not lost (full detail: `sprint-artifacts/deferred-work.md`, section dated
2026-09-18; ledger: DF3.6a story's Review Findings):

1. **`lastMemory` dep (this story's edit-list item 5) is landed and UNUSED** —
   `createSteering` accepts it, nothing reads it yet. Your `exitStatus:"overflow"`
   writer is its consumer; until you land edit (iv), a grep for `lastMemory` in
   `src/phase-engine/steering.ts` showing one reference is CORRECT, not drift.
2. **`residentRssBytes` is validated + carried but has ZERO behavioral tests** — DF3.6a
   pinned its schema/loader refusal shape only. Your cgroup enforcement is the first
   consumer; its breach shape, arithmetic, and `watchdog_kill` path are untested
   anywhere. Budget test coverage for the bound itself, not just the cgroup mechanics.
3. **Dup phase names share one iteration budget** (`createBoundsGuard` counters keyed by
   phase NAME, `src/phase-engine/resident-bounds.ts`). DF3.6a deferred the fix because it
   needs a phase ordinal (or name-set check) through the steering↔guard interface —
   wider than 6a's closed edit list, but YOU already widen that seam (`lastMemory`,
   cgroup deps). Fold the ordinal in while you are in there, or record the S3-7
   config-level precedent decision as deliberate.
4. **Tripwire `code`/`bound` keys spec contradiction** — DF3.6a's Observability Contract
   names `{code, bound, cause, phase}` on breach tripwires; `ResidentTripwire` (DF3.3's
   closed type) has neither. 6a followed the closed type. You emit `watchdog_kill`
   tripwires — resolve the contradiction in whichever direction you rule (widen the
   type with 6a's record, or amend 6a's contract sentence) and record it either way.

Also observed, NOT yours: DF2.8-owned follow-up — admission-reservation release API
(`resident-ceiling-unfundable` strands headroom until orphan aging; remediation text
warns, the API is the fix) — and pre-existing `yaml.safe_load` failures in
`workflow-state/qds-dev/{df2-2,df3-1}/state.yaml` (same plain-scalar colon defect
CodeRabbit caught in df3-6a's file, fixed there).

---

## Split Record — 2026-09-08 (QDS story-review campaign)

Split from `df3-6-resident-agent-bounds.md` (deleted at the split; both halves carry its content).
Findings resolved in this half, from `_bmad-output/evidence/qds-story-review-2026-09-08/scan-C-df3-6.md`:

**BLOCKERs:** B1 (**re-derived under the operator's mechanism ruling**: the original defect was
"the engine cannot obtain the resident's root pid." Under kernel enforcement it never needs one —
the engine issues no signal. What crosses the module boundary is the bound *value* down
(`residentRssBytes` on `ResidentSpawnOpts`) and the accounting up (`lastMemory()`), on the handle
that already exists. `ResidentSpawn.pid()` is **not** added. The seam got smaller under the better
mechanism), B6's memory half (`src/fleet/resident.ts`, the systemd unit and the Dockerfile added to
Files to Modify; the single `steering.ts` writer scoped inside DF3.6a's enumerated carve-out).

**HIGHs — all three reversed or dissolved by the ruling, not merely fixed:** H1 (**reversed**: the
original recipe was "reuse `src/reverify/worktree.ts`'s `ps` sampler." No sampler is reused,
extracted or built; `worktree.ts` is untouched. A cgroup read replaces the sampler, the timer, the
lifecycle rule, the platform dispatch and the kill path), H2 (**dissolved**: with no timer there is
no interval to size, no "nothing to sample between calls" state, and no probe of a process that does
not exist yet — the fail-closed check is now at arming against a cgroup), H3 (**structural instead
of conventional**: the resident's cgroup contains only pi and its descendants by construction, so an
engine-rooted bound is not merely forbidden but unrepresentable).

**MEDIUMs / LOWs:** M3 (D4 tripwire (c) is computable **across** runs only — `stop()` latches and a
second in-run kill is structurally impossible; the cause discriminator has cardinality one, stated
plainly so no reader looks for an in-run counter that cannot exist), L1 (**verified, not asserted**:
`"overflow"` is a real member of `EXIT_STATUSES`, `cli-anything/src/types.ts:99-105`, cited to file
and line — it was never checked in the original scan and would have been a BLOCKER had it been
absent), L2 (the darwin justification was stale post-DF1.10 and is now **moot**: there is no
platform probe at all, and the enforcement path exists only in-box on Linux).

**New consequence surfaced during the split and addressed here:** the unit is baked into a
**digest-pinned** image, so `Delegate=memory` requires a DF2.10 rebuild, re-publish and pin move —
and `deriveBuildId` hashes the unit, so the build id changes. Made an explicit DoD item, because a
story that silently requires an image rebuild is how a green local gate meets a stale box.

**Wave 5c (2026-09-08) — MEDIUMs and LOWs closed in this half.** **M1** (the reclaimable-vs-
anonymous nuance now carries a DoD assertion, not just a sentence: file-backed pressure at the limit
thrashes and is classified a *timeout*, so a missing `oom_kill` count reads as "the other backstop
fired" rather than "the bound is absent"), **M2** (**promoted to a live DoD item, not deferred** —
the pi baseline-RSS measurement is a roster-tier-4 read of `memory.peak` from a control
solicitation, on the round AC1 already pays for, with zero marginal spend and an explicit falsifier
that falsifies the *story*: a baseline ≥ 32 MiB means the 64 MiB fixture proves attachment rather
than crossing, and ≥ 256 MiB means the 512 MiB production default must be re-set before this ships),
**M3** (the three incompatible answers for a missing `residentRssBytes` resolved in favour of
DF3.6a's earlier, stronger gate), **L1/L2/L3** (three citation ranges corrected against source:
`worktree.ts:293-311`→`:293-299` for the F064 block, `resident.ts:141-145`→`:137-141` for the
key-delivery docstring, `resident.ts:115-127`→`:116-127` for `ResidentSpawn` — `:115` is blank).
**Those corrected targets have since gone stale AGAIN, and round 19 re-corrected them.** This story's
own implementation inserted ~600 lines of cgroup machinery near the TOP of `src/fleet/resident.ts`,
which shifted every citation aimed at pre-existing code below the insertion point — while citations to
code this story ADDED, written in the same pass, stayed correct. Eight were wrong: `ResidentSpawn`
(→ `:689-708`), the closure-local child handle (→ `:1095`), the "DF3.6 decides when" quote (→ `:698`),
key delivery ×2 (→ `:719-722`), the `stop()` latch and its throw (→ `:1493-1494` / `:1201`), the
signal-death branch (→ `:1378-1404`), and `ResidentTripwire["cause"]` in steering (→ `:244`).
**The class, so the next reader can re-run the check rather than re-derive it:** a file:line citation
is evidence only while the file holds still. Extract every `\.ts:N` citation, `sed -n` the range, and
confirm it matches the claim — mechanical, finite, and worth redoing after any large insertion.
The live-e2e items now carry their gate (`QDS_E2E_LIVE` + **`QDS_E2E_TIER=2`**, because
`liveGate("2")` accepts only `"1"`/`"2"` and "tier 4" is a roster label), their spend, their
inherited setup and their falsifier.

**Deferred out of this half — one item, with reason and owner:** DF5.1's `ps`-sampled RSS ceiling
stays open. Closing it needs cgroups on a host-side box that may be darwin, where they do not exist;
per ADR Appendix B's same-day correction this mechanism does not generalise, so it is a different
design question on a different kernel, not a follow-up to this story. *Owner: DF5.1.*

**Wave 5b (2026-09-08) — verifier findings resolved in this half.** From
`_bmad-output/evidence/qds-story-review-2026-09-08/verify-C-df3-6ab.md`: **B1** (the seam did not
close — `lastMemory()` on `ResidentSpawn` is unreachable from an engine that receives only
`spawned.caller`/`spawned.rate`; it is now a third `createSteering` dep landed in DF3.6a's diff, and
DF3.6a's carve-out is explicitly opened for it rather than worked around), **B2** (the placement
wrapper failed **open** — `;` let a failed `cgroup.procs` write fall through to `exec` and run pi
unbounded; it now exits **97** on refusal, keyed on membership read back from `cgroup.procs` rather
than on the write's exit status, with AC4 and a negative control — this entry said `|| exit 97`,
which is the form that was REJECTED during development, until round 16), **B3** (`residentRssBytes` is
optional and INV-MEM-2 is scoped to the in-box context, so the invariant no longer disables the
resident at all 42 host-side arming sites and DF3.3's INV-RES-3 exhibit stays armed), **H1** (the
DF5.1 wording ADR Appendix B retracted — this story was the last artifact carrying it), **H2** (the
post-OOM `status` orphan: AC5 now establishes the `stop()` latch instead of assuming it), **H3**
(`memory.oom.group=1` — without it the kernel kills one task, not the cgroup, and the leaf will not
`rmdir`), **H4** (D4 tripwire (c) was silently re-scoped by its key to "any two OOM kills ever",
which under D4 demotes tier 2; the story now defines no key and says why that is the evaluator's
call), **H5** (AC3 demanded a bounds-check line from a `checkBounds` that does not exist on the
not-started path; now the shipped `resident_disabled` shape), **V-CC-C1** (the R3 orphan — the
citation now says the kernel discharges it — and the 512 MiB orphan, flagged provisional),
**V-CC-C2** (`scripts/pipeline-run.ts` edit totals stated across the pair, not per-half),
**V-DF3.6b-M3** and **M4** (the yaml's DF1.11 edge restored).

**Sprint tag corrected 2026-09-08.** DF3.6 was re-sequenced **v5-S2 → v5-S3 on 2026-08-31** as part
of the ADR arc (it cannot precede the engine relocation it depends on). `sprint-status.yaml:43`
recorded it; the story file was never updated and carried the stale `v5-S2` tag for eight days,
which both halves inherited at the split. The yaml was authoritative throughout.

**Not in this half:** DF3.6-B2/B3/B4/B5, H4/H5/H6, M1/M2/M4/M6, L3/L4 and the `credentials.ts:47`
comment are spend- and iteration-path findings, resolved in DF3.6a.
