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
- Decision register: v5 §4 **D4** (tripwires F7); findings **F12** (no watchdog on the resident agent), **F7**; risk **R3**
- **`docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` Appendix B (ACCEPTED 2026-09-08)** — the load-bearing citation for this story: enforcement not enumeration, cgroup v2 `MemoryMax=`, rooted at the component's pid, and DF5.1's `ps`-sampled ceiling explicitly re-opened
- Binding facts: R5 §6 fact **5** (the RSS watchdog is *re-aimed*, not deleted). **Superseded in mechanism by Appendix B** — see Technical Notes; the fact's *intent* (the resident is a genuinely local subprocess tree in-box, so bounding it is now correct) holds and is exactly what makes a cgroup possible.

## User Story

As the factory host paying for every sandbox,
I want the resident agent's memory bounded by the kernel rather than watched by a poller,
so that a resident that leaks is killed the moment it crosses the line — not reported after it has already OOM'd the box — while the run still finishes deterministically.

## Overview

Every pi solicitation runs inside its own cgroup v2 leaf with `memory.max` set from the manifest's
`residentRssBytes`. The kernel enforces it: crossing the bound OOM-kills that cgroup and nothing
else. The engine issues no signal, runs no timer, takes no sample, and never learns pi's pid. After
the call the fleet layer reads `memory.peak` and `memory.events` from the leaf, reports them up as
telemetry, and removes it. If the cgroup cannot be created or `memory.max` cannot be written, the
resident is **not started** — the engine never runs an agent whose memory it cannot bound.

## E2E Slice

**Demonstrable behavior:** Given a box booted from the DF2.10 image whose `qds-run@.service`
carries `Delegate=memory`, and a manifest declaring `residentRssBytes: 64 MiB` (small enough that a
single allocation crosses it deterministically), When a run executes in-box and the resident's pi
child allocates past the bound, Then **the kernel OOM-kills that solicitation's cgroup** — no signal
is sent by the engine and no sample is taken — the journal records `resident.exitStatus: "overflow"`
and a `residentTripwire` row `{runId, cause:"watchdog_kill", phase, detail}` whose `detail` carries
the `memory.peak` reading and the bound it crossed, the solicitation's cgroup is removed, and
**every remaining phase and gate executes on the deterministic path**. Observable artifacts: the
harvested journal, and `memory.events`' `oom_kill` count read before removal.

**This slice runs live.** It is a `qds-live-e2e` **TIER-4** assertion (`tier4-resident`: 1 dispatch
key + 1 resident key + 1 box, ≈ $0.10 worst case) against a real exe.dev box and real OpenRouter
spend, per `.claude/skills/qds-live-e2e/SKILL.md`. Read
`tests/fleet/e2e/tier4-resident.live.test.ts` before touching the tier, and honour its `finally`
teardown discipline — a leaked box on an OOM path is a leaked box that bills. A host-side unit test
**cannot** substitute: the enforcer is the kernel, and darwin has no cgroups at all.

**Wiring closed:** On completion of this story the memory bound is kernel-enforced end to end using
only code merged by this story plus DF3.6a's validated `residentRssBytes` and widened `cause` union,
DF1.10's in-box engine and resident spawn path, and DF2.10's unit. No stub, no `TODO: wire later`.

**Dependency edges (predecessors):** **DF3.6a** (validates `residentRssBytes`; widens
`ResidentTripwire["cause"]` to include `watchdog_kill`), **DF1.10** (the in-box engine and the
`startResident` spawn path this story instruments), **DF2.10** (the boot image and the
`qds-run@.service` unit that must carry `Delegate=memory`, and whose digest pin must move), DF3.3
(the `resident` journal block and its `exitStatus` field).

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
   (`QDS_TEAM_RUNNER=local`, `src/phase-engine/phases/dispatch-task.ts:290-298`). An engine-rooted
   bound charges a bun team-lead's memory to a 512 MiB **resident** bound and trips on the first
   dispatch phase of every real run. This is the general invariant the tier-2 placement ADR states
   — *a bound on component X is rooted at X's pid, never at an ancestor's* (Appendix B, ACCEPTED
   2026-09-08) — and it is F064, already found and fixed once
   (`src/reverify/worktree.ts:293-311`); it is not to be rediscovered. *Negative control: an
   implementation setting `MemoryMax=` on the `qds-run@<runId>.service` unit itself bounds the
   engine's whole cgroup — which `oci/exedev/systemd/qds-run@.service:185` already documents as
   containing the pi child, the `code` phases and the team-lead drivers — passes a naive
   synthetic-allocator "does it fire?" test, and MUST fail a test in which a `dispatch_task` phase
   runs beside a small resident.*
3. **Unenforceable means not started, checked against a real object.** Given the cgroup cannot be
   created or `memory.max` cannot be written — `Delegate=memory` absent from the unit, the `memory`
   controller unavailable, the box not on cgroup v2 — When the resident arms, Then it is **not
   started**: the journal records `resident.status: "disabled"` (DF3.3's closed set — a fourth value
   would violate its AC5) and the bounds-check log line carries
   `bound: "rss", allowed: false, cause: "unenforceable"`; no `residentTripwire` row is emitted,
   leaving DF3.3's closed three-cause set unchanged. The run proceeds deterministic rather than
   running an agent whose memory nobody can bound. The check runs at **arming**, against a cgroup
   the engine either can or cannot create — not against a process that does not yet exist
   (`startResident` spawns nothing: `src/fleet/resident.ts:384-448`).

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| per-solicitation cgroup create + `memory.max` write at spawn | in-scope | `tests/fleet/e2e/tier4-resident.live.test.ts` (the kernel is the enforcer; no host-side test can prove an OOM-kill) | — |
| `memory.peak` / `memory.events` read + cgroup removal after the call | in-scope | `tests/fleet/resident.test.ts` (fs-level, host-side) + the live round | — |
| one-time delegated-subtree split at engine start | in-scope | `tests/fleet/resident.test.ts` | — |
| `Delegate=memory` present in the shipped unit | in-scope | `oci/exedev/Dockerfile` build-time scan + `tests/providers/exedev/image-assets.test.ts` | — |
| spend ceiling / iteration bound | out-of-scope | — | **DF3.6a** |
| cgroup-enforced RSS for the host-side re-verify box | out-of-scope | — | DF5.1 (its ceiling is re-opened by this story's mechanism; see Technical Notes) |
| bound-breach events on the audit chain | out-of-scope | — | DF5.3 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| cgroup delegation | `Delegate=memory` on `oci/exedev/systemd/qds-run@.service` (DF2.10's unit; systemd 255, cgroup v2 unified). Delegation is what chowns the unit's cgroup directory, `cgroup.procs` and `cgroup.subtree_control` to `User=exedev`, so the engine can create the resident's child cgroup **without root, without D-Bus and without polkit** | build-time: DF2.10's Dockerfile unit scan gains a positive `grep -qE '^Delegate=memory$'` assertion, the same shape as the existing `RuntimeDirectoryPreserve=yes` check (`oci/exedev/Dockerfile:809`), so the directive cannot be silently dropped. Run time: absent delegation ⇒ resident **not started** (AC3) |
| resident memory bound | cgroup v2 `memory.max` on a per-solicitation child cgroup created by the fleet spawn path, valued from the manifest's `residentRssBytes` (validated by DF3.6a) | kernel-enforced. The engine passes the **value**; it never signals, never samples, and never learns a pid. The live round asserts an allocator past the bound is OOM-killed and the run still completes deterministically |
| resident memory telemetry | `memory.peak` and `memory.events` (`oom_kill`) read from that cgroup before it is removed | a kernel high-water mark per solicitation — strictly better than a poll, and the reason this story samples nothing. Feeds `rssPeakBytes` on the bounds-check log line and `detail` on the `watchdog_kill` row |
| image digest pin | DF2.10's pin ritual — the unit is **baked into the image**, so this story's one-directive change requires a rebuild, a re-publish and a moved digest pin, not just a file edit | see the DoD item; a green local gate against a stale pinned image is exactly the failure this prerequisite exists to prevent |

## Technical Notes

- **No pid crosses the module boundary — the bound value does.** An engine-side watchdog would have
  needed the in-flight pi child's pid, which the engine cannot obtain: `ResidentSpawn` ships
  `caller`, `rate`, `exitStatus()`, `stop()` and no pid (`src/fleet/resident.ts:115-127`), the
  child handle is closure-local (`resident.ts:451`), and the engine is forbidden to import fleet
  code (`src/phase-engine/steering.ts:11-13`). Kernel enforcement dissolves that seam instead of
  widening it: **the engine never learns a pid, because it never has to signal anything.** Two facts
  cross, both on the handle that already exists:

  ```ts
  // src/fleet/resident.ts — on ResidentSpawnOpts, beside `persistDir`/`bin`
  /** DF3.6b: the engine-owned RSS bound, read from the frozen manifest and
   *  validated by DF3.6a. Fleet applies it as `memory.max` on the
   *  per-solicitation cgroup; fleet NEVER chooses or defaults it. Absent ⇒
   *  resident not started (INV-MEM-2). Same division of labour as stop():
   *  "DF3.6 decides when; this supplies how" (resident.ts:125). */
  residentRssBytes: number;

  // src/fleet/resident.ts — on ResidentSpawn, beside exitStatus()
  /** DF3.6b: last solicitation's cgroup accounting — `memory.peak` and whether
   *  the kernel OOM-killed it. Read before the cgroup is removed. */
  lastMemory(): { peakBytes: number; oomKilled: boolean } | null;
  ```

  The bound stays **engine-owned policy** (INV-MEM-1: it is read from the frozen manifest, and fleet
  neither defaults nor clamps it); fleet is mechanism only.
- **Why cgroup and not a sampler, and what that costs — stated because it is genuine work.**
  A `ps` sampler at any interval reports a breach already paid for: the ADR's measured in-box
  solicitation is 2.17 s, and a process can balloon and OOM the box between two samples. F12 says
  *enforce*. cgroup v2 `memory.max` is kernel-enforced, fires deterministically, and is
  un-bypassable from inside the box — the resident cannot raise its own bound because the bound is
  not in its address space (INV-MEM-1, structurally). **This re-opens and supersedes DF5.1's
  standing accepted ceiling** ("RSS is `ps`-sampled rather than cgroup-enforced",
  `df5-1…md:229,268-269,352-354`) rather than inheriting it. DF5.1's own ceiling should close on
  this same mechanism — that is a follow-up filed against DF5.1, so there is **one** ticket for the
  one exposure, and it is explicitly **not** scope here: DF5.1's verify box is host-side and may be
  darwin, where there are no cgroups at all.

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

  **The spawn race is closed by the child, not by a retry.** Writing pi's pid to `cgroup.procs`
  *after* `Bun.spawn` leaves a window in which pi runs unbounded. Instead the child places itself
  before it becomes pi:
  `sh -c 'echo $$ > "$1"/cgroup.procs; shift; exec "$@"' _ <cgroupDir> <pi argv…>` — positional
  passing, so the rendered prompt stays its own argv element and is never interpolated into a shell
  string. The key remains env-borne, never argv (`src/fleet/resident.ts:141-145`), unchanged by this
  wrapper.
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
  `memory.peak`, the bound it crossed, and the cgroup leaf name. **D4's tripwire (c) — "any steering
  loop the watchdog kills twice for the same cause" — is computable across runs, keyed on the row's
  `runId` + `cause`, and never within one run:** `stop()` latches (`src/fleet/resident.ts:681-705`)
  and every later `call` throws (`resident.ts:474`), so a second kill in the same run is
  structurally impossible. The *cause* discriminator has cardinality one today (an OOM-kill is the
  only kill this story raises); a second kill cause would be a new tripwire `cause` member, not a
  new `detail` string. This story counts nothing. (The `watchdog_kill` name is DF3.3's, reserved
  before the mechanism became kernel-enforced; it is kept because DF3.3 owns the union and renaming
  it would be a cross-story change for no behavioural gain.)
- **The union widening lives in DF3.6a, deliberately.** `ResidentTripwire["cause"]` is one closed
  literal type on one line (`src/phase-engine/steering.ts:199`); both new members land in DF3.6a's
  diff so two stories are not editing the same literal. This story writes `watchdog_kill` into a
  union that already admits it.

## Observability Contract

- The bounds-check line for this bound logs `{ requestId, runId, phase, bound: "rss", rssPeakBytes, residentRssBytes, allowed }`
- `requestId` propagates unchanged from DF3.3's solicitation record; a kill additionally emits
  `{ code, bound, cause, phase }` on the tripwire row
- Sub-timings: `cgroup_setup_ms`, `cgroup_teardown_ms`. A bound never evaluated reports `0`.
  `rssPeakBytes` is read from the solicitation cgroup's `memory.peak` — a kernel high-water mark,
  **not** a sampled value, so there is no sample interval to report.
- **Destination:** the trace/log stream. The only journal `resident` values this story writes are
  `exitStatus:"overflow"` and, on the unenforceable path, `status:"disabled"` — both members of
  sets DF3.3 already closed.

## Files to Modify

- `src/fleet/resident.ts` — the cgroup mechanism: `residentRssBytes` on `ResidentSpawnOpts`, the
  one-time delegated-subtree split, the per-solicitation cgroup create / `memory.max` write /
  `sh -c` self-placement wrapper around the existing `Bun.spawn` / `memory.peak` + `memory.events`
  read / cgroup removal, and `lastMemory()` on `ResidentSpawn`. Fleet supplies the *how*; the bound
  *value* stays the engine's (Technical Notes).
- `src/phase-engine/steering.ts` — **one** edit, inside DF3.6a's already-enumerated carve-out:
  an internal writer for `telemetry.exitStatus = "overflow"`, reachable only from inside
  `createSteering`. The controller keeps its snapshot-only getter (`steering.ts:961-967`); **no
  public setter is added**, because a public setter is a path the resident's own tier could reach
  and INV-MEM-1 forbids it.
- `scripts/pipeline-run.ts` — the sole `startResident` call site (`:3255`); passes
  `residentRssBytes` from the loaded bounds. No other change.
- `oci/exedev/systemd/qds-run@.service` — add `Delegate=memory`. One directive; it is what makes the
  cgroup writable by `User=exedev` without root, D-Bus or polkit.
- `oci/exedev/Dockerfile` — one positive `grep -qE '^Delegate=memory$'` assertion in the existing
  unit scan, matching the shape of the `RuntimeDirectoryPreserve=yes` check at `:809`, so the
  directive cannot be silently dropped by a later image edit. (Verified: `Delegate=` contains no
  `QDS_`, so DF2.10's AC6 env scan at `:1024-1040` is unaffected, and the `systemd-analyze verify`
  stage accepts the directive.)
- `tests/fleet/resident.test.ts` — host-side fs-level coverage of the subtree split, the leaf
  lifecycle and the unenforceable path.
- `tests/fleet/e2e/tier4-resident.live.test.ts` — the live OOM-kill assertion (AC1).

## Security Invariants

- **INV-MEM-1 (enforcement locus — F12, and structurally stronger than a convention):** the memory
  bound is enforced by the **kernel**, outside the resident's address space. No directive, prompt,
  env var, in-box file, or roster entry the resident can influence may raise, disable, or reset it;
  the resident cannot reach the bound because the bound is not a value it can read or write. The
  bound's *value* is engine-owned, read from the frozen manifest and validated by DF3.6a; the fleet
  layer applies it and never chooses or defaults it. *(This is the memory-specific corollary of
  DF3.6a's INV-BND-1, which governs bounds generally.)*
- **INV-MEM-2 (fail-closed toward determinism):** where the memory bound cannot be **enforced** —
  the delegated cgroup cannot be created, `memory.max` cannot be written, the `memory` controller is
  unavailable, or the box is not on cgroup v2 — the resident is **not started**; the engine never
  runs an agent whose memory it cannot bound, and never silently degrades to an unbounded one. The
  check is at arming, against a real object, not against a process that does not yet exist. When the
  bound *does* fire, it stops the resident only — never a gate, a phase, or the run's determinism.
- **INV-MEM-3 (no new argv surface):** the `sh -c` placement wrapper passes pi's argv
  **positionally** (`sh -c '…' _ <cgroupDir> <pi argv…>`), so no rendered prompt is ever
  interpolated into a shell string, and the per-run key stays env-borne and never appears on argv
  (`src/fleet/resident.ts:141-145`, unchanged). A wrapper that string-builds the pi command line is
  a defect regardless of whether a given prompt happens to be safe.

## Definition of Done

- [ ] **Impl:** per-solicitation cgroup leaf with `memory.max` from `residentRssBytes`; one-time delegated-subtree split at engine start; `sh -c` self-placement wrapper; `memory.peak`/`memory.events` read and leaf removal after the call; `lastMemory()` on `ResidentSpawn`.
- [ ] **Impl:** `telemetry.exitStatus = "overflow"` written through an internal writer only — no public setter (INV-MEM-1). `"overflow"` verified a real `EXIT_STATUSES` member (`cli-anything/src/types.ts:99-105`), so no cross-repo type change is needed.
- [ ] **Contract:** the engine issues no signal and runs no timer for this bound; `grep` over the diff finds no `ps`, no `/proc` parser, no sample interval and no SIGTERM/SIGKILL sweep added by this story. `src/reverify/worktree.ts` is untouched.
- [ ] **Image + pin (DF2.10 ritual — this story requires a rebuild, not just an edit):** `Delegate=memory` lands in `oci/exedev/systemd/qds-run@.service`; the image is **rebuilt, re-published and its digest pin moved** per DF2.10's pin ritual, and `deriveBuildId`'s inputs (which hash the systemd unit — `src/providers/exedev/driver.ts:395,425`) are re-derived. **A run against the previously pinned digest boots a unit with no `Delegate=`, so the resident refuses to start (AC3) — a green local gate against a stale pin is the exact failure this item exists to prevent.**
- [ ] **Security:** the bound is unreachable from any path the resident controls (INV-MEM-1); an unenforceable cgroup prevents resident start (INV-MEM-2); the placement wrapper adds no argv surface and the key stays env-borne (INV-MEM-3).
- [ ] **Test (memory bound fires, AC1 — LIVE, TIER-4):** a resident whose pi child allocates past `residentRssBytes` is **OOM-killed by the kernel** with the engine issuing no signal; journal `resident.exitStatus:"overflow"`; `watchdog_kill` row carries the `memory.peak`; the run completes deterministically and the solicitation cgroup is removed. Runs under `QDS_E2E_LIVE` as a `tier4-resident` assertion against a real box and real spend (`.claude/skills/qds-live-e2e/SKILL.md`), with that tier's `finally` teardown discipline. **A host-side unit test cannot substitute and the story is not done without this round.**
- [ ] **Test (cgroup scoping, AC2):** a `dispatch_task` phase running beside a small resident does **not** trip the bound — the workers are not in the resident's cgroup. An implementation setting `MemoryMax=` on `qds-run@<runId>.service` passes a synthetic-allocator "does it fire?" test and MUST fail this one.
- [ ] **Test (fail-closed unenforceable, AC3/INV-MEM-2):** with `Delegate=memory` absent from the unit, the resident is **not started**, the journal records `resident.status:"disabled"`, the log line carries `cause:"unenforceable"`, no tripwire row is emitted, and the run still completes deterministically — never an unbounded resident.
- [ ] **Test (image contract):** the Dockerfile unit scan fails the build when `Delegate=memory` is removed from `qds-run@.service` — the assertion is the fence, the same shape as `RuntimeDirectoryPreserve=yes` (`oci/exedev/Dockerfile:809`).
- [ ] **Test (leaf lifecycle, host-side):** the subtree split is idempotent across engine restarts; a leaf is removed after every call including the OOM path; a second solicitation gets a fresh leaf and a fresh `memory.peak`.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->

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

**Deferred, with reason:** DF5.1's `ps`-sampled RSS ceiling is **re-opened, not closed here**.
Closing it means the same cgroup mechanism on the host-side re-verify box, which may be darwin,
where cgroups do not exist — a different substrate and a different design question. Filed against
DF5.1 so there is one ticket for the one exposure. Nothing else is pending.

**Sprint tag corrected 2026-09-08.** DF3.6 was re-sequenced **v5-S2 → v5-S3 on 2026-08-31** as part
of the ADR arc (it cannot precede the engine relocation it depends on). `sprint-status.yaml:43`
recorded it; the story file was never updated and carried the stale `v5-S2` tag for eight days,
which both halves inherited at the split. The yaml was authoritative throughout.

**Not in this half:** DF3.6-B2/B3/B4/B5, H4/H5/H6, M1/M2/M4/M6, L3/L4 and the `credentials.ts:47`
comment are spend- and iteration-path findings, resolved in DF3.6a.
