# DF3.7: Approval-Gate Bridge — Run-Completion Signal for In-Box Runs

**Story Points:** 4
**Sprint:** v5-S3 (in-box restoration arc, story 4 of 5 — the last seam the relocation opens, and the smallest)

## Spec Reference

- `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` (ACCEPTED 2026-08-31) — Decision; **Consequence 4** ("awaiting marker in-box, host polls; gate stays host-owned"); "Why not host-side": the gate "stays host-side by construction (state must outlive the box)"
- Probe evidence (READ-ONLY): `_bmad-output/evidence/df1-10-probe/2026-08-31-232522-box-env-probe.json` — `/run` is tmpfs and a reboot wipes it; `$HOME` on ext4 persists; systemd is PID 1
- **Correction of record (binding on this story):** the phase engine has **never** called the approval gate. `requestApproval`'s sole production caller is `src/reverify/runner.ts:461`, reached from `scripts/reverify.ts:33` — host-side, out-of-box, and after the box is already torn down (`src/fleet/approval-gate.ts:1131-1136`; the production port is built with no `teardown` seam at `runner.ts:430`). `scripts/pipeline-run.ts` contains the string `approval` zero times. The gate is therefore **already immune to engine placement**; what the relocation actually breaks is one tier up — **nothing on the host learns that an in-box run finished**, so nothing triggers harvest → teardown → reverify → gate. ADR Consequence 4's "awaiting marker" wording predates this finding and is recorded here as **Deviation 1**: the marker is a run-**completion** signal, not an approval state, and this story writes no `extensions.approval` field
- Reused unmodified: `runMarkerRoot()`/`runMarkerPath()` (`src/phase-engine/journal.ts:48-56`) and `writeTerminalMarker` (`:201-229`) — 0600, temp+rename, payload `{runId, ok, completedAt}`, already documented as "the fixed in-box completion signal DF3.2's host-side poller keys on (AC7)"; `readBoxFile` (`src/providers/exedev/transport.ts:116-123`) with its `absent | unreadable | oversized | content` kinds; the host chain `teardownSandbox` → `reverify()` → `requestApproval` exactly as the operator runs it today
- Precedent for the observer: fan-out's `probeArm` / `runRace` (`src/fleet/fanout-primitive.ts:660-800`, `MARKER_UNUSABLE_TICKS_LIMIT` = 3) already polls this same marker on a real box — this story is its single-run analogue, not a new mechanism
- **Disambiguation:** pre-2026-08-31 references to "DF1.10 owns the round trip" (DF3.4 Deviation 12, #180/#181, the `fleet attach` no-ack remediation) mean **DF1.11** under the ADR's re-charter

## User Story

As the factory operator who dispatched an unattended run,
I want the host to notice by itself that the in-box run has finished and to walk the harvest, teardown, re-verify and approval chain that already exists,
so that an autonomous run ends at a pause I can approve rather than at a live box nobody is watching.

## Overview

`fleet dispatch --await-completion` observes one box's terminal marker and, on seeing it, runs the
chain the operator runs by hand today. The observer is a bounded `readBoxFile` poll of
`runMarkerPath()` with the same four-kind classification fan-out's race already uses — `absent` is a
clean read, `unreadable` is a skipped tick, `oversized`/unparseable is counted toward a consecutive
unusable limit, and a non-zero `cat` is a refusal, never empty bytes. On a settled marker the host
runs harvest → teardown → `reverify()`, and reverify's own single call to `requestApproval` does
what it does today. This story adds one module and one opt-in flag: **zero** lines change in
`approval-gate.ts`, `approvers.ts`, `push.ts` or `run-record.ts`'s approval-extension block, no state is
added, no daemon is introduced, and nothing flows back into the box — approval authorizes a *push*,
never a continuation.

## E2E Slice

**Demonstrable behavior:** Given an in-box run dispatched with `--await-completion`, When DF1.10's
engine settles and writes `/run/journal/final.json` (`{runId, ok:true, completedAt}`, 0600, by
temp+rename), Then the host's next poll reads it through `readBoxFile`, runs `teardownSandbox`
(harvest → destroy → revoke → `closedAt`) and then `reverify()`, whose existing
`port.requestApproval` call leaves the record at `awaiting-approval` with its proposal, reportId,
headSha and `expiresAt`. Observable artifacts: `<runsDir>/<runId>.bundle` present, the record's
`closedAt` set, `extensions.approval.state = "awaiting-approval"` written **only** by the gate, one
`event: "pause"` line carrying `dispatchRequestId`, and the observer's own
`{ event: "run-complete", runId, marker_poll_ms }` line — plus a diff in which `approval-gate.ts`
has zero changed lines.

**Wiring closed:** On completion of this story, an unattended in-box run reaches an approvable pause
without an operator typing a second command, using only code merged by this story plus DF1.10's
in-box engine and its terminal marker, DF3.4's gate and lock protocol, and DF5.1's `ApprovalPort` /
`recordApprovalPort(store)` seam at the reverify call site. **No stub, no `TODO: wire later`.** The
**decision** side is unchanged and stays operator-driven: `fleet approve|reject` and DF5.2's push
are untouched.

**Dependency edges (predecessors):** DF1.10, DF3.4, DF5.1.

> **Not an edge — DF1.11 (steering round trip):** this story reads a completion marker, never a
> steering file. Touching `/run/steering`, `attach.ts` or `steering.ts` from here collides head-on
> with DF1.11 and is out of scope in both directions.

## Acceptance Criteria

1. **(make-or-break — the host learns the run finished; the gate learns nothing new)** Given an in-box run that writes its terminal marker, When the observer sees it, Then the host runs the **existing** chain — harvest → teardown → `reverify()` → the gate's own `requestApproval` — and the record reaches `awaiting-approval` through that path alone, with **zero changed lines** in `src/fleet/approval-gate.ts`, `src/fleet/approvers.ts`, `src/pr/push.ts` and `src/providers/run-record.ts`'s approval-extension block, verified by diff — and, because a diff is a review step and not a runnable one, enforced at test time by a **static import fence**: `src/fleet/run-completion.ts` imports none of those four modules, asserted by a grep test in the repo's own idiom (DF3.6's `src/phase-engine/` DoD grep; fan-out's direct `runMarkerPath()` import with the barrel withholding it, `src/fleet/fanout-primitive.ts:670`). *Negative control: an implementation that reads ADR Consequence 4 literally and writes `extensions.approval.state = "awaiting-approval"` from the bridge reaches the same state, passes a naive "is it awaiting?" test, bypasses `pauseRun`'s bundle, R5-C and INV-APPROVE-6 guards, and MUST fail this one.*
2. The observation contract is the four-kind classification, not a truthiness check. <br />**(a)** `absent` (the probe ran and the box read clean) means *not finished yet* and resets the unusable streak; `unreadable` (present at test, failed at `cat`) is a skipped tick with no state change; `oversized` or unparseable is counted, and after a consecutive limit the run is abandoned to AC3's arm rather than polled to the ceiling. <br />**(b)** A non-zero `cat` is a **refusal, never empty bytes**, and never a completion. <br />**(c)** `ok:false` is a settled-but-failed run and the chain still harvests and tears down — but `ok` is **not a veto and is never fed to reverify**. DF5.1 re-judges the tree independently and returns before the gate only on **its own** non-green verdict (`src/reverify/runner.ts:421`), so an `ok:false` run whose tree re-verifies green legitimately reaches the pause, and an `ok:true` run whose tree re-verifies red does not. Deriving the approval outcome from the marker instead would collapse the two-layer doctrine INV-IBOX-15 exists to preserve. *Negative control: an implementation that treats a failed read as "not there yet" polls a dead box to the ceiling, and one that treats it as completion tears down a live run — both MUST fail this one.*
3. Given a marker written but never observed (host disconnect, window expiry), Then the command exits with a typed `{ code: "run-completion-unobserved", message, remediation }` payload naming the box and the run, leaves the box **alive and listable** with its evidence (DF2.2 INV-5), mutates **no** record field, and is safely re-runnable — re-observing is idempotent because the marker is the state. The story states plainly that **no existing timer covers this run**: it has no approval extension to expire, and the reaper is operator-run and dry-run by default — so the box bills until an operator acts on the typed refusal, and the story says that rather than implying a sweeper will collect it. What that operator action yields is the sharper hazard (corrected per DF3.8 Deviation 1): the `record-claim-refused` arm (`src/providers/reaper.ts:750-756`) guards **destroy** only; an open record older than `staleAfterMs` (4 h default, `src/providers/quota.ts:49`) classifies `stale-record` → `teardown` (`reaper.ts:480-487`, `:534-544`), which harvests and closes the run with **no `reverify()` and no gate** — a witness-less collection. DF3.8 exists to end it. *Negative control: an implementation that synthesizes a completion, destroys the box on an unobserved run, or adds a second expiry clock inside the gate MUST fail this one.*
4. Given the marker path, Then it is the **single derivation** `runMarkerPath()` on both legs — `QDS_RUN_ROOT` unset in the box (DF2.10 AC6 ships an image and unit that set no `QDS_*` path variable; cited, not assumed) and unset in the host process that computes the path to read — exactly as DF1.11's INV-IBOX-13 requires of the steering root. Unset on the host leg is a **precondition the observer enforces, not one it assumes**: `runMarkerRoot()` honours whatever `QDS_RUN_ROOT` the *reading* process carries (`src/phase-engine/journal.ts:48-51`) and the host-side shim sets it in-process today (`scripts/pipeline-run-remote.ts:210`), so a set value makes the observer refuse at start-up rather than read a host-shaped path against a box. A reboot before observation destroys the tmpfs marker and the run lands in AC3's arm; the path is never re-derived, never assumed, and never reconstructed from a live-box heuristic. *Negative control: an implementation that inherits an ambient `QDS_RUN_ROOT` polls a path the box has never heard of, reads `absent` forever, and MUST fail this one.*
5. Given a run whose record already carries `extensions.approval` in any state (`pausing`, `awaiting-approval`, or terminal), When the observer would start the chain, Then it refuses instead. This is a **cheap pre-flight refusal, not a mutual exclusion**, and the story claims exactly that much: it removes the one *automatic* second entry to `reverify()` this seam could add, preserving the one-production-entry / one-process-per-invocation precondition `src/reverify/worktree.ts:319`'s pid guard rests on (TECH_DEBT F106). What it does **not** fence is an operator running `scripts/reverify.ts` by hand against a run that carries no extension yet — no lock covers that today, this story takes none, and F106 is left exactly as DF5.1 scoped it: neither widened nor silently declared closed. *Negative control: an implementation that starts the chain on a record already carrying any `extensions.approval` state passes a naive "is it awaiting?" test and MUST fail this one; an implementation that claims to fence the manual caller MUST name the lock it takes.*
6. Given the evidence for this story, Then the chain is proven end to end against a **real box** whose marker was written by DF1.10's real in-box engine — not planted by the test, not produced by a FakeDriver. A FakeDriver suite is legitimate unit coverage for the four-kind classification and MUST NOT be the sole evidence for AC1 (DF3.4 AC6's no-doubles rule).

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `fleet dispatch <…> --await-completion` | in-scope | `tests/fleet/run-completion.test.ts` | — |
| bounded marker poll over `readBoxFile` | in-scope | `tests/fleet/run-completion.test.ts` | — |
| harvest → teardown → reverify chain on a settled marker | in-scope (composition only — every step already exists) | `tests/fleet/run-completion.test.ts` | — |
| the real-box completion → pause chain, marker written by DF1.10's engine and never planted (AC6) | in-scope | `tests/fleet/e2e/tier3-run-completion.live.test.ts` | — |
| a background watcher/daemon observing every open run | out-of-scope — **there is no daemon in this design** and the gate says so; the observer lives in the invocation that owns the box | — | none in v5.0 |
| `fleet status` rendering marker/completion state | out-of-scope — status is a read surface (`create: false`) and cannot drive the chain | — | none scheduled |
| any change to the gate state machine, lock protocol, expiry semantics or `awaitDecision` | out-of-scope — `awaitDecision` has no production caller and MUST NOT gain one here | — | DF3.4 owns them |
| resuming the in-box run after approval | out-of-scope — approval authorizes a **push** (DF5.2), never a continuation; the box is gone and a decided run's remediation is to dispatch a **new** run | — | DF5.2 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| in-box terminal marker | DF1.10's in-box engine calling DF1.1's `writeTerminalMarker` (0600, temp+rename, `{runId, ok, completedAt}`) | a real in-box run leaves `/run/journal/final.json` readable through `driver.exec` before this story's chain is exercised; absence must remain meaningful (a run that never settles leaves no marker) |
| bounded box read | `readBoxFile` in `src/providers/exedev/transport.ts` (DF2.2-owned; command strings are built in the providers layer, never under `src/fleet/`) | `bun test tests/providers/exedev/read-box-file.test.ts` green; this story adds no substrate command string of its own |
| host chain | `teardownSandbox` (DF2.5 via DF3.1's verb) and `reverify()` (DF5.1) | both green from the CLI on the same run before the observer is wired; the observer composes them and re-implements neither |
| approval gate | `src/fleet/approval-gate.ts` (DF3.4) — **CRITICAL blast radius, read-only for this story** | `bun test tests/fleet/approval-gate.test.ts` green before and **byte-identical after**; a diff touching it is the signal the bridge was mis-scoped |

## Technical Notes

- **Contracts/Schema:** the marker is `{ runId: string, ok: boolean, completedAt: string }` and nothing else. It deliberately does **not** carry the engine's exit status, verdict, or any evidence: reverify re-judges the tree host-side and DF5.1 owns the verdict, so the smaller payload keeps the marker out of the trust path. The observer's own log line is `{ requestId, runId, event, marker_poll_ms }` — it adds no field to DF2.1's run record.
- **Ordering is untouched because the marker sits strictly before the sequence:** marker → host observes → harvest/destroy/revoke/`closedAt` → `reverify()` green → `requestApproval` → `pausing` → (no teardown owed) → `awaiting-approval`. The box's death is *upstream* of `pausing`, exactly as in the shipped flow, so INV-APPROVE-6's no-seam guard, the R5-C keyHash guard and `refuseLiveInfraOnDecidable` all keep meaning what they mean today.
- **Region ownership on shared files.** `src/fleet/run-completion.ts` is new and this story's own. `src/fleet/verbs.ts` and the `scripts/fleet.ts` dispatch block are **DF3.1's**: this story **adds only** the `--await-completion` flag, its exit mapping, and the typed refusal print — no existing verb, exit code or gate event changes shape. `src/providers/exedev/transport.ts` is **DF2.2's** and is reused unmodified. `tests/fleet/e2e/tier3-remote-phases.live.test.ts` asserts the marker under `<recordsDir>/<runId>/journal/final.json` (`:154`) only because the host-side shim sets `QDS_RUN_ROOT` in its own process (`scripts/pipeline-run-remote.ts:210`); retiring that shim flips the assertion, which makes it **DF1.10's** edit and not this story's — DF3.7 carries its own live test instead.
- **Guards/limits.** Per-read deadline (`DEFAULT_PER_CALL_DEADLINE_MS` = 10_000) and byte cap come from `readBoxFile` as-is, and `MARKER_UNUSABLE_TICKS_LIMIT` = 3 is reused verbatim (`src/fleet/fanout-primitive.ts:55,68`). Fan-out has **no** poll-interval constant to inherit — `probeArm` simply re-reads per tick — so the interval and the **observation window** are this story's only two new numbers, and both are named in code rather than implied. The window is operator-settable on the flag and has to be: fan-out's `DEFAULT_FANOUT_CEILING_MS` (1 h, `:58`) is race-shaped and an unattended run routinely outlives it, so inheriting it would silently abandon exactly the runs this story exists for. Window expiry is AC3's typed refusal — never a silent give-up and never an unbounded wait holding a lock. No lock is held across teardown (the gate's own rule) and the observer takes no approval lock at all.
- **Considered and rejected: a `$HOME`-persistent marker.** R9 recommends `$HOME` for durability, and it would survive a reboot. It is rejected here because `runMarkerPath()` is a **single derivation** read by two processes on two machines: making it persistent means setting `QDS_RUN_ROOT` in the box only, which re-creates precisely the split-brain DF1.11's INV-IBOX-13 forbids for the steering root, and it would fork the path fan-out's live-proven probe already uses. Reboot-before-observation is instead handled honestly by AC3. Revisit only if a measured reboot rate makes the loss window material.
- **DF1.10's review round 1 hardened the marker surface this story polls — read it before implementing.** Two changes matter here. (1) **Marker identity is now checked.** `markerReplayRefusal` resolved the marker via `runMarkerPath()` — one path per marker *root*, not per run — and parsed the body while reading only `.ok`, never comparing the `runId` sitting in the same object. A foreign run's verdict could be mirrored, and `/run` being tmpfs meant a reboot erased the guard entirely. The engine now refuses a foreign marker with **`ENGINE_MARKER_FOREIGN`** and a journal-with-rows-and-no-marker with **`ENGINE_JOURNAL_ORPHANED`**, backed by a durable `$HOME` sentinel that the tmpfs marker cannot provide. Both are **new contract surface this bridge will meet**: a run that ends in either refusal writes no usable marker, which the four-kind classification (AC2) sees as absent/unusable, and the operator-facing explanation lives in the engine's refusal, not in the observer. (2) The image-side amplifier is filed, not fixed: `RuntimeDirectory=journal trace` uses **literals in a template unit**, so every instance shares `/run/journal` and `RuntimeDirectoryPreserve=yes` carries run A's marker into run B — held closed today by the TypeScript runId comparison alone, and tracked in the re-pin bundle ([#217](https://github.com/Quantum-Digital-Solutions/QDS-Factory/issues/217), item F-D1). Until that lands, "the marker at this path belongs to this run" is a *code* property, not a filesystem one, which is exactly why AC4's refusal of an ambient `QDS_RUN_ROOT` on the observing host stays load-bearing.
- **Deviation/assumption (Deviation 1, stated once more where an implementer will look):** ADR Consequence 4 says "in-box engine writes an awaiting marker". Written before the 2026-08-31 audit established that the engine never calls the gate, that phrase reads as an approval state; it is implemented here as a run-completion marker, which is what the ADR's own "host polls; gate ownership unchanged" requires. If a reviewer wants the ADR amended, that is an ADR appendix, not a change to this story's shape.

## Observability Contract

- Every observation logs `{ requestId, runId, event, marker_poll_ms }` — `event ∈ run-complete | marker-absent | marker-unusable | run-completion-unobserved`. The marker's bytes are never echoed and no credential material is read or logged.
- `requestId` propagates from the dispatch invocation onto every observer line and is the same `dispatchRequestId` the gate's own `pause` event carries, so the completion and the pause join without a second key; errors carry `{ code, message, remediation }`.
- Sub-timings: `marker_poll_ms`, `chain_ms`. `chain_ms` is **absent, not `0`**, when no chain ran — `0` is a lie shaped exactly like an instantaneous chain, the same reason the gate omits `teardown_at_pause_ms` rather than zeroing it (`src/fleet/approval-gate.ts:1131-1136`, deferred item D8).

## Files to Modify

- `src/fleet/run-completion.ts` (new — the bounded observer and the chain composition; the only new module in this story)
- `src/fleet/verbs.ts` (DF3.1-owned; **adds only** the `--await-completion` flag and its exit mapping — no existing verb or exit code changes)
- `scripts/fleet.ts` (DF3.1-owned dispatch block; **adds only** the observer wiring and the typed `run-completion-unobserved` print)
- `tests/fleet/run-completion.test.ts` (the four-kind classification, the ambient-`QDS_RUN_ROOT` refusal, the unobserved arm, the pre-flight extension refusal, and the AC1 import fence)
- `tests/fleet/e2e/tier3-run-completion.live.test.ts` (new — AC6's mandatory real-box demo: DF1.10's in-box engine writes the marker, this story's observer walks the chain. `tier3-remote-phases.live.test.ts` is **DF1.10's** to flip and is not modified here)

## Security Invariants

- **INV-IBOX-14 (gate ownership is unchanged, and provably so):** the approval gate stays host-owned; this story changes zero lines in `src/fleet/approval-gate.ts`, `src/fleet/approvers.ts`, `src/pr/push.ts` and `src/providers/run-record.ts`'s approval-extension block, and writes no `extensions.approval` field. **"Provably" means a runnable check, not a reviewer's eye**: the AC1 import fence fails the suite if `src/fleet/run-completion.ts` ever imports one of those four modules, so the bridge cannot acquire the *ability* to write the namespace even if a later edit wanted to. The marker is a run-**completion** signal, never an approval state. DF3.4 **INV-APPROVE-6** (an open record naming a `vmName` or `keyHash` cannot promote without a teardown seam) is inherited untouched and must not be weakened to let a bridge promote earlier.
- **INV-IBOX-15 (the marker is a signal, not evidence):** it carries `{runId, ok, completedAt}` at 0600, published by temp+rename so its bytes never exist half-written. Nothing downstream treats it as verification — DF5.1's host re-verify remains the independent second layer of the two-layer evidence doctrine this placement restores. The observer never synthesizes a completion, never destroys or tears down a box on an absent, unreadable or unparseable read, and an unobserved run fails **open on the infrastructure** (box alive, listable, evidence intact) and **closed on the gate** (no approval registered).
- **INV-IBOX-16 (one reverify entry, no daemon, no new state):** the observer is the only automatic caller of the host chain *this story ships* — DF3.8 adds the one sanctioned second automatic caller, and pays for it with the per-run invocation lock this story declined to take (DF3.8 AC5 / INV-IBOX-17); both refuse when the record already carries an approval extension, so this seam adds no *unlocked* automatic second entry to `reverify()` and leaves its one-process-per-invocation precondition (`src/reverify/worktree.ts:319`, F106) exactly as narrow as DF5.1 left it. The invariant is "no automatic caller outside this story's entry, at most one at a time", **not** "no concurrent reverify is possible" — a hand-run `scripts/reverify.ts` is unfenced today and stays unfenced; claiming otherwise would retire F106 without paying for it. It introduces no watcher process, no second expiry clock, and no persisted field; the run record's approval namespace stays exactly as DF3.4 closed it, and `awaitDecision` gains no production caller.

## Definition of Done

- [ ] **Impl:** `src/fleet/run-completion.ts` observes `runMarkerPath()` through `readBoxFile` with the four-kind classification and the consecutive-unusable limit (AC2), and composes harvest → teardown → `reverify()` without re-implementing any step.
- [ ] **Impl:** `--await-completion` on `fleet dispatch` with its exit mapping and the typed `run-completion-unobserved` refusal (AC3).
- [ ] **Contract:** the marker payload stays `{runId, ok, completedAt}`; `writeTerminalMarker` and `runMarkerPath()` are reused **unmodified**, and a set `QDS_RUN_ROOT` on the observing host process is a start-up refusal, not an inherited value (AC4, INV-IBOX-15).
- [ ] **Integration:** `reverify()`'s existing `requestApproval` call is the only path to `awaiting-approval`; one `pause` event with `dispatchRequestId` is emitted by the gate, not by this story (AC1).
- [ ] **Security:** diff shows zero changed lines in `approval-gate.ts`, `approvers.ts`, `push.ts` and `run-record.ts`'s approval-extension block, **and** the import fence asserts it at test time; no box is destroyed on an unreadable or absent read (INV-IBOX-14, INV-IBOX-15).
- [ ] **Test (observation contract, AC2):** absent resets the streak; unreadable is a skipped tick; oversized/unparseable counts to the limit; a non-zero `cat` is a refusal, never empty bytes; `ok:false` harvests and tears down, and the approval outcome is decided by reverify's own verdict, never by the marker's `ok`.
- [ ] **Test (unobserved run, AC3):** window expiry exits with the typed payload, leaves the box alive and listable, mutates no record field, and a re-run observes the same marker idempotently.
- [ ] **Test (single reverify entry, AC5):** a record already carrying any `extensions.approval` state refuses the chain; no second concurrent reverify is startable from this seam.
- [ ] **Test (no gate drift, AC1):** the approval-gate suite is green and the file byte-identical; an implementation writing `extensions.approval` from the bridge MUST fail.
- [ ] **Test (e2e demo — MANDATORY):** one live run on a real box in `tests/fleet/e2e/tier3-run-completion.live.test.ts` — the marker is written by DF1.10's in-box engine (never planted), the host observes it, and the run ends with `<runsDir>/<runId>.bundle` present, `closedAt` set, and `extensions.approval.state = "awaiting-approval"` carrying its proposal, reportId and headSha, ready for `fleet approve`.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
