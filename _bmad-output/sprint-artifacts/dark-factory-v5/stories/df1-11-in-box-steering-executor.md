# DF1.11: In-Box Steering Executor + Channel Lifecycle

**Story Points:** 5
**Sprint:** v5-S3 (in-box restoration arc, story 3 of 5 — the first arc story whose value is a closed round trip, not a relocation)

## Spec Reference

- `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` (ACCEPTED 2026-08-31) — Decision; **Consequence 2** (the steering consumer drains the box inbox and writes acks locally; "#180 fixed declaratively"; live e2e inverts to `attach-acked`); the "Interim" paragraph this story ends
- Probe evidence (READ-ONLY): `_bmad-output/evidence/df1-10-probe/2026-08-31-232522-box-env-probe.json` — `/run` is tmpfs and a real reboot wipes `/run/steering`; systemd is PID 1 and enabled units restart at boot; one real in-box pi solicitation cost $0.000025 / 2.17 s
- **#181**, adopted in its literal on-box reading: *"resident consumes `/run/steering/inbox.ndjson` on-box and writes `/run/steering/acks.ndjson`"*. Its next clause — *"engine leg reads/writes **through the transport** instead of the host file"* — is **superseded** by the ADR (that transport is the rescinded design): build none. **#180**, closed declaratively: a `tmpfiles.d` entry recreates the channel at boot — *"no send-failed-triggered re-provision machinery needed"*; its *"telemetry still counts channel recreations"* clause is satisfied by AC4b's boot-id row, never by a re-provision counter
- Consumed **unmodified**: `src/fleet/attach.ts` (`localSteeringInbox` `:658-764`, `acks.lock` `:632-656`, `attachToRun` `:430-580`, `AttachLine` `:118-124`, LOCAL-CALLERS-ONLY docblock `:39-53`), `scripts/pipeline-run.ts` `readSteeringAckedIds` `:155-191`, `src/phase-engine/steering.ts` (DF3.3's three solicitation points `:86-140`, fold `:745-756`)
- Extended by one clause: `src/providers/exedev/driver.ts` `STEERING_PROVISION_SCRIPT` `:87-92`. Closed out here: DF3.4 **Deviation 12** ("recorded rather than redesigned") and its round-8 follow-ups
- **Disambiguation:** pre-2026-08-31 references to "DF1.10 owns the round trip" (DF3.4 Deviation 12, #180/#181, the `fleet attach` no-ack remediation) mean **DF1.11** under the ADR's re-charter; DF1.10 is now the in-box phase engine

## User Story

As the factory operator steering a live run,
I want my guidance drained and acknowledged by the engine on the box that is actually running my work, and the channel still there after that box reboots,
so that `attach-acked` means a real process consumed my message and `no-ack` becomes a fault worth investigating instead of the permanent shape of the system.

## Overview

DF1.10 puts the phase engine inside the box; this story closes the loop around it and adds almost
no mechanism. `localSteeringInbox` is already a plain `node:fs` consumer of `/run/steering` — never
the wrong implementation, only running on the wrong machine — so the same drain, the same
`readSteeringAckedIds` dedupe seed, the same `acks.lock` and the same host `attachToRun` verb close
the round trip unmodified. What this story adds is one `&&` clause on the fixed-literal
`STEERING_PROVISION_SCRIPT` writing `/etc/tmpfiles.d/qds-steering.conf` so systemd recreates the
channel at boot (#180); a runId-provenance contract on the engine launch, the one genuine new way
this design can silently lose every message; retirement of every stopgap string promising an
executor that now exists; and inversion of the live-e2e PASS shape to `attach-acked`/exit 0. It
introduces no transport-backed inbox, no box-side lock primitive, no re-provision state machine and
no daemon — each belongs to the rescinded host-side design.

## E2E Slice

**Demonstrable behavior:** Given a live run on a box with DF1.10's in-box engine started with the
record's minted fleet run id and a DF3.3 resident armed, When the operator runs `fleet attach
<run-id> --message "prefer the smaller diff"`, Then the line lands verbatim in
`/run/steering/inbox.ndjson` as `{messageId, requestId, runId, message, sentAt}`, the engine's next
solicitation drains it, folds it into `promptContext` and appends `{messageId, ackedAt, point}` to
`/run/steering/acks.ndjson` on the same box, and the host's poll observes that ack inside
`ATTACH_ACK_CEILING_MS` and exits **0** with `attach-acked` and no error envelope. Observable
artifacts: the two box files, the gate event `{event:"attach", outcome:"attach-acked",
attach_rtt_ms, dispatchRequestId}` with **no** `reason` field, and the harvested trace showing the
fold (an ack proves consumption, never application).

**Wiring closed:** On completion of this story, an operator's guidance reaches a live in-box agent
and is acknowledged from the box, using only code merged by this story plus DF1.10's in-box engine
and launcher, DF3.3's three solicitation points and fold budget, and DF3.4's `attachToRun` host leg
with its messageId dedupe and ack contract. **No stub, no `TODO: wire later`.** The **image** half
of the channel fix — baking the identical `/etc/tmpfiles.d/qds-steering.conf` — is **DF2.10's**;
this story writes the same drop-in at box birth so it does not hard-depend on the image story.

**Dependency edges (predecessors):** DF1.10, DF3.3, DF3.4.

> **Not an edge — DF2.10 (image bake):** the drop-in is written at box birth inside the existing
> provisioning script, so this story is verifiable on a stock image; convergence with DF2.10's baked
> copy is asserted by AC2's idempotency arm, not by a dependency.

## Acceptance Criteria

1. **(make-or-break — the round trip closes on the box, and nothing outside it opens a steering file)** Given a live in-box run, When `fleet attach` sends a message, Then the ack that produces `attach-acked` is written by the in-box engine into the box's own `acks.ndjson`, and the engine's inbox port holds **no driver or vm reference** — local `node:fs` only, preserving the engine's barrel boundary (DF3.3 INV-RES-1). No production process outside the box opens a steering file. *Negative control: a run whose ack is produced host-side, or proven solely against `tests/fleet/attach.test.ts`'s FakeDriver — where both legs coincidentally share one filesystem — passes a naive "was it acked?" test and MUST fail this one; that suite stays unit coverage but is never the sole evidence for this AC (DF3.4 AC6's no-doubles rule).*
2. Channel persistence is **declarative**, not reactive (#180). <br />**(a)** Given box creation, When `STEERING_PROVISION_SCRIPT` runs, Then it also writes `/etc/tmpfiles.d/qds-steering.conf` as a `d /run/steering 0700 <user> <group>` line in the **name** form, with `$(id -un)`/`$(id -gn)` expanded **by the box's shell at write time** — tmpfiles.d itself expands nothing, so a literal `$(id -un)` left in the file is an unparseable user field, not a late binding — and no host payload interpolated. On our image the resulting bytes are DF2.10's baked literal `d /run/steering 0700 exedev exedev`; `/etc` is ext4 and survives reboot. <br />**(b)** Given a real reboot, Then `/run/steering` exists again at **0700**, exec-user owned, recreated by `systemd-tmpfiles-setup` with **no code of ours running**, and the engine unit's next start is ordered after it (stated and tested on the box) so no drain or ack hits the EACCES arm. The reboot ends the run it interrupted (AC4a) — this arm is proven on the next engine start, not on a resumed one. <br />**(c)** Given the drop-in already present (re-provision, or DF2.10's baked image), Then provisioning is a byte-identical no-op and the existing verify-after-provision assertions (`test -w`, `stat -c %a` = 700) still gate creation. **The canonical byte sequence is DF2.10's baked literal** — `d /run/steering 0700 exedev exedev` in the name form, single-space separated, one trailing newline, nothing else — and the birth-write's resolution must reproduce it exactly; the call also stays in place after the image ships, as the image-regression tripwire DF2.10's Technical Notes name. *Negative controls, both MUST fail: a re-provision triggered by the first channel-attributable send failure — the rescinded design — passes a "channel came back" test; and a box whose primary group is not `exedev`, where `$(id -gn)` resolves to e.g. `users` and the write yields `d /run/steering 0700 exedev users`, must fail the driver test loudly on the byte mismatch rather than silently overwrite the image's copy or pass a "the directory exists at 0700" check.*
3. Given the in-box engine is launched, Then it is passed the **record's minted fleet run id** from the box-local `run-context.json` dispatch wrote, never `pipeline-run.ts`'s bare-uuid default: a non-minted id fails `MINTED_FLEET_RUN_ID_RE`, the `ownRunId` filter then rejects **every** attach line, and the run steers silently to nothing. The `steering_ownrun_id_space_mismatch` warning MUST also ride the trace sidecar — in-box stderr/journald is where nobody is looking. DF1.10 ships the launcher; if the shipped launch site passes anything else, correcting that one call site lands in **this** story's diff rather than deferring to a third. *Negative control: an implementation that launches with a fresh uuid drains an empty queue forever, reports a healthy run, and MUST fail this one.*
4. The reboot-loss contract is honest and recoverable. Given a reboot mid-run, Then `inbox.ndjson`, `acks.ndjson` and `acks.lock` die **together** on the same tmpfs, and **the run dies with them**: DF1.10's `Restart=no` plus its terminal-marker refusal mean nothing resumes that run, so **messages queued but not yet folded are lost** — nothing re-sends them and the operator-facing prose says so (AC5). The recreated channel serves the **next** run on that box, which starts on an empty queue and an empty dedupe set: no re-fold, no re-ack. The host leg's exit-3 / `unreachable` classification is unchanged — a channel that vanished under a poll is never re-read as "healthy empty". <br />**(b)** Given engine startup, Then exactly one row carries `/proc/sys/kernel/random/boot_id` and uptime, anchoring the run to a boot so a reboot under it is attributable at harvest (the anchored boot_id against the box's live one) — this story adds no counter, no poller and no daemon. That row MUST live on a surface that survives the event it records: the ext4 `$HOME` engine log harvested before teardown (DF1.10 AC4) or the host-side driver `emit()` stream. It MUST NOT widen `ResidentTelemetry` or the journal `resident` block, both closed key sets, and adds no field to DF2.1's run record. *Negative control: a row written only to tmpfs `/run/trace/`, or a recreation count added to the journal `resident` block, MUST fail this one — the first cannot witness the reboot that erased it.*
5. Given this story merges, Then no shipped string, docblock or test still promises a future executor **or an unconditionally queued message**: the `no-ack` remediation says the engine is running but did not ack (check the run is live, the fold budget, and whether the box rebooted) instead of "no in-box executor exists yet (DF1.10)", and its "the message IS queued in the box" claim becomes conditional — true of the append, false after a reboot (AC4a). `tests/fleet/gate-verbs.test.ts` pins **four** assertions over that one string (`:1391-1394`: `IS queued in the box`, `no in-box executor exists yet`, `DF1.10`, `/fold budget/i`) and they move together. The `readSteeringAckedIds` docstring stops calling the ack log "append-only and host-WIDE (`acksPath()` is one file shared by every run on the host)", which per-box placement makes false. *Negative control: an implementation that edits the string without the test leaves the unit suite red and MUST fail this one.*
6. The live-e2e PASS shape **inverts**, and the old shape becomes a false green. Given `tier1-attach-transport` and `tier5-gate-steering` against a real box, Then `attach-acked`/exit 0 is the PASS shape, the acks file carries the messageId, the error-envelope assertions are deleted, the gate event carries no `reason`, the at-ceiling 4,000-char attach folds truncated and **is** acked, and the retry step proves double delivery with **two** acks. tier5's hand-rolled in-box pi invocation — scaffolding for an engine that could not run in-box — gives way to the real engine **only if** the replacement preserves that step's evidence (seeded test fails → the fixer lands → the seeded test passes → the exact-tamper guard holds); short of that the block stays and only tier5's header and attach step flip. tier4's placement caveat and the `pipeline-run-remote.ts` HONEST LABEL are **DF1.10 AC7's** (single owner) and are not touched here. *Negative control: a test still passing on `no-ack`/exit 6 after this story is a false green and MUST fail this one.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `fleet attach <run-id>` against a live in-box run | in-scope | `tests/fleet/e2e/tier1-attach-transport.live.test.ts` | — |
| box creation writing the tmpfiles.d drop-in | in-scope | `tests/providers/exedev/driver.test.ts` | DF2.10 bakes the identical file into the image |
| engine startup boot-id/uptime row | in-scope | `tests/phase-engine/pipeline-run.test.ts` | — |
| engine launch carrying the minted runId | in-scope as contract + AC3 — **DF1.10 implements the launcher** | `tests/phase-engine/pipeline-run.test.ts` | DF1.10 |
| `--message-id` on `fleet attach` (idempotent operator retry) | out-of-scope — double delivery is **inherited**; `AttachOptions.messageId` exists and `attachToRun` honours it, the CLI simply never passes one | — | named upgrade path, unscheduled |
| ack-provenance (`acksBeforeCall`) on a host CLI | out-of-scope — **re-deferred explicitly** (carried twice already); in-box it becomes harvest-time and is readable from the harvested journal | — | none scheduled — do not build a live cross-machine counter |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| in-box phase engine + its systemd unit | DF1.10 (the unit file and `Restart=` ship with DF2.10's image) | `bun test tests/phase-engine/` green and DF1.10 merged before this story starts; the unit orders after `systemd-tmpfiles-setup.service` (AC2b) — verify on the box, do not assume |
| steering channel `/run/steering` | provisioned at box birth by `ExeDevDriver.create`, script kept `private` and create-only | the script's verify-after-provision assertions stay green; a sudo refusal remains `steering-channel-unprovisionable` with the 137/255/other diagnosis — no new failure arm |
| DF3.3 solicitation port | in-repo `src/phase-engine/steering.ts` | `bun test tests/phase-engine/steering.test.ts` green; this story edits **zero** lines of it |
| `QDS_STEERING_ROOT` | unset in **both** the engine's systemd unit and the non-interactive ssh session attach uses | proven unset on both legs before the round-trip test; if ever set it must be visible to the ssh session too (`/etc/environment` via pam_env — verify, do not assume) |
| minted fleet run id | `run-context.json`, written into the box by dispatch | the engine's startup row echoes the runId it was launched with; a bare uuid is a refusal-grade defect (AC3) |

## Technical Notes

- **Contracts/Schema — unchanged, restated because the machine boundary moved, not the bytes:** inbox line `{messageId, requestId, runId, message, sentAt}`; ack line `{messageId, ackedAt, point}` at the fold-time point; `messageId` is the dedupe key, exactly-once per id; directory 0700, files 0600, exec-user owned; ceilings all inherited — 30 s ack ceiling, 500 ms poll, 4,000-char attach ceiling, 8,000-char fold budget, 1 MiB inbox tail, 512 KiB acks tail, 5 s per inbox call, 60 s drain pass.
- **Region ownership on shared files.** `src/providers/exedev/driver.ts` is **DF2.2's**: this story adds one `&&` clause to the fixed literal and corrects the docblock's forward reference to "the (DF1.10) in-box engine" — no new driver surface, no `steeringSend` seam, no widening of `ExeDevDriver.exec`'s blast radius. `src/fleet/attach.ts` is **DF3.4's** and takes a **docblock-only** change (the LOCAL-CALLERS-ONLY rationale now describes two environments on one box, not two machines). `src/phase-engine/steering.ts` is **DF3.3's** and is not touched.
- **Guards/limits.** The host leg keeps every byte cap and its `ACKS_READ_CAP_BYTES` drift guard. Cap pressure drops to near zero because production runs **one run per box** (dispatch provisions a box per run; each fan-out arm calls dispatch with its own minted runId; the record binds one `vmName`). Keep the `ownRunId` filter anyway — it costs nothing and S1 says never off — but its threat model (cross-run theft) is now structurally out of reach and its real risk is starvation (AC3). `acks.lock` likewise stays: with a single in-box writer it is near-vestigial, but it costs zero diff, still covers restart overlap, and its `<pid>:<nonce>` staleness oracle is finally same-namespace. Add no box-side `flock`; inbox-side interleaving between two concurrent host attaches stays unlocked, pre-existing and not this story's to fix.
- **Double delivery is inherited, deliberately.** A retry after exit 6 mints a fresh `messageId`, so dedupe cannot see it and the guidance folds twice — *rarer* now (exit 6 stops being the default outcome) and *more consequential* (delivered twice instead of zero times). The known upgrade path is passing `AttachOptions.messageId` from a `--message-id` flag; this story does not claim it and invents no host-side retry bookkeeping.
- **Cost of the inversion, measured not guessed.** tier1 is zero-spend today precisely because nothing acks; an ack needs a live engine with steering armed (no resident ⇒ no `createSteering` ⇒ no drain ⇒ no ack) and the solicitation that follows normally spends. One real in-box pi solicitation measured $0.000025 / 2.17 s — spend it and say so in the test header rather than engineering a degradation path to keep the zero-spend label.
- **Considered and rejected: moving the channel to persistent `$HOME`.** The queue would survive a reboot and #180 would vanish, but it changes the default root on **both** legs, needs `QDS_STEERING_ROOT` visible in the ssh session as well as the unit, and re-opens the split-brain the LOCAL-CALLERS-ONLY docblock documents. And it buys nothing: the reboot ends the run (AC4a), so a surviving queue would have no consumer left to fold it.
- **The channel path is ASSERTED by a pinned image, so relocating it is a re-pin — [#220](https://github.com/Quantum-Digital-Solutions/QDS-Factory/issues/220)** (DF1.10 review round 1). DF1.10's `oci/exedev/systemd/qds-run@.service:55` carries `AssertPathIsDirectory=/run/steering`, with `Requires=systemd-tmpfiles-setup.service` (`:34`) making the tmpfiles oneshot an enforced dependency rather than mere ordering. Ordering is therefore handled and the assertion is doing legitimate work — it is an image-integrity assertion, and dropping it would trade a loud refusal for a run that starts and then cannot be steered. The consequence for **this** story: if DF1.11 relocates `/run/steering`, **every DF1.10 run refuses to start** (the start job fails on the assert) and stays that way **until a re-pin** — which is not landable from a feature branch (`.github/workflows/publish-exedev-image.yml:66-70,75-77`). Either keep the path and record that it is load-bearing in a pinned asset (cheapest, and probably right), or plan the relocation **as part of a re-pin bundle** so unit and code move together in one live-proven step. This is the concrete cost behind the rejected-alternative bullet above.
- **Deviation/assumption:** boot ordering is asserted as a property of a normal `multi-user.target` service starting after `systemd-tmpfiles-setup.service`. The probe measured systemd as PID 1 and enabled units restarting at boot but did not measure this ordering against our unit — AC2b is where it gets measured, and a failure there is a unit-file fix, not a redesign.

## Observability Contract

- Every attach logs `{ requestId, runId, event: "attach", outcome, attach_rtt_ms }` — `outcome ∈ attach-acked | attach-not-acked | send-failed | refused`, with `reason` present only on the not-acked arm. The message text never appears and no credential material ever enters a steering file.
- `requestId` propagates from the operator's invocation onto the inbox envelope and back onto the gate event; `dispatchRequestId` remains the cross-process join key, so a harvested trace joins without a second key. Errors carry `{ code, message, remediation }`.
- Sub-timings: `attach_rtt_ms`, `drain_ms`. Every engine startup emits exactly one `{ boot_id, uptime_s }` row on a reboot-surviving surface (AC4b); nothing reports a recreation count, because nothing counts recreations — the anchored boot_id is the whole signal.

## Files to Modify

- `src/providers/exedev/driver.ts` (DF2.2-owned; **adds only** the tmpfiles.d clause to the fixed literal `STEERING_PROVISION_SCRIPT`, plus the docblock correction — no signature, visibility, or failure-taxonomy change)
- `scripts/fleet.ts` (DF3.4-owned attach block; **the `no-ack` remediation string only** — the shipped operator text reading "no in-box executor exists yet (DF1.10)", both stale and mis-numbered under the re-charter)
- `scripts/pipeline-run.ts` (DF1.1/DF1.10-owned; `readSteeringAckedIds` docstring correction, the `steering_ownrun_id_space_mismatch` warn routed onto the trace sidecar, and the boot-id startup row)
- `src/fleet/attach.ts` (DF3.4-owned; **docblock only**)
- `tests/fleet/gate-verbs.test.ts` (the four pinned no-ack assertions over one remediation string, `:1391-1394`, updated to the new numbering and the new reality; this is the loud failure that forces the prose fix)
- `tests/phase-engine/pipeline-run.test.ts` (the existing home of the runner's steering wiring — boot-id row, sidecar-routed mismatch warn, corrected docstring's behaviour)
- `tests/providers/exedev/driver.test.ts` (provisioning-script assertions incl. the idempotency arm and the pinned drop-in literal)
- `tests/fleet/e2e/tier1-attach-transport.live.test.ts` (header, test name, and every exit-6/no-ack assertion inverted)
- `tests/fleet/e2e/tier5-gate-steering.live.test.ts` (header and the attach step's assertions; the hand-rolled in-box pi scaffolding only under AC6's evidence-preserving condition)

## Security Invariants

- **INV-IBOX-10 (one machine, one channel, no second transport):** both legs address the box's `/run/steering`; the host leg rides `driver.exec` with the payload on **stdin, never argv** (DF2.3 INV-CRED-3) and never `copyFile`, and the engine leg is local `node:fs` holding **no driver or vm reference** — that is what preserves DF3.3 **INV-RES-1** (no agent-initiated channel into the engine). No ssh, no HTTP, no second channel.
- **INV-IBOX-11 (runId provenance is a security property, not a convenience):** the engine is launched with the record's minted fleet run id from the box-local `run-context.json`. A non-minted id rejects every attach line while reporting a healthy run — invisible from the host and indistinguishable from an idle operator — so the mismatch warning must reach a harvestable surface; in-box stderr alone is not one.
- **INV-IBOX-12 (channel shape and co-location):** directory 0700, files 0600, exec-user owned, and `inbox.ndjson` / `acks.ndjson` / `acks.lock` on **one** filesystem — durable dedupe is correct only because a wipe takes the queue and the ack log together; a persistent inbox beside a volatile ack log would re-fold and re-ack everything after a reboot. No steering file carries credential material, and steering stays **guidance only**: it never moves a gate or raises a bound (DF3.4 INV-APPROVE-5), and attach still refuses every approval state.
- **INV-IBOX-13 (one root in both environments; fail-closed at boot):** `QDS_STEERING_ROOT` is unset in the engine's systemd unit **and** in attach's ssh session, so both resolve `/run/steering` — the unit half is DF2.10 AC6's own testable clause and is **cited here, not assumed**, since only the story that ships the unit can guarantee it; a unit-only `Environment=` line re-creates the two-legs-on-different-files defect on a single box. The engine unit starts after `systemd-tmpfiles-setup`, so a post-reboot drain never runs against a `/run` our exec user cannot write; where it does, the EACCES surfaces as an inbox fault, never as an empty queue.
- **Restated, unchanged:** DF3.3 **INV-RES-4** — an ack proves consumption, never application; nothing host-side treats `attach-acked` as verification, and DF5.1's host re-verify remains the independent second layer of the two-layer evidence doctrine this placement restores.

## Definition of Done

- [ ] **Impl:** one `&&` clause on `STEERING_PROVISION_SCRIPT` writing `/etc/tmpfiles.d/qds-steering.conf` with box-resolved ids; zero new driver surface; `provisionSteeringChannel` stays `private` and create-only (AC2, INV-IBOX-12).
- [ ] **Impl:** engine startup emits one boot-id/uptime row on a reboot-surviving surface, and the `ownRunId` mismatch warning rides the harvestable trace sidecar (AC3, AC4b).
- [ ] **Contract:** `localSteeringInbox`, `readSteeringAckedIds`, `acks.lock` and `attachToRun` are consumed **unmodified**; `src/phase-engine/steering.ts` shows zero changed lines in the diff (AC1).
- [ ] **Integration:** the engine's inbox port holds no driver/vm reference — grep of the diff finds no provider import reachable from `src/phase-engine/` (INV-IBOX-10, DF3.3 INV-RES-1).
- [ ] **Security:** channel 0700/0600 exec-user owned and co-located; `QDS_STEERING_ROOT` unset on both legs and proven so on a real box; no credential material in any steering file (INV-IBOX-12, INV-IBOX-13).
- [ ] **Test (round trip, AC1):** attach → inbox line → fold → ack → host `attach-acked` exit 0 against a real box; the FakeDriver suite stays green as unit coverage but is not the sole evidence.
- [ ] **Test (channel persistence, AC2):** a real reboot leaves `/run/steering` 0700 exec-user owned before the engine unit's next start; re-provision is a no-op byte-identical to DF2.10's baked literal; a send-failure-triggered re-provision implementation MUST fail.
- [ ] **Test (runId provenance, AC3):** an engine launched with a bare uuid rejects every attach line and the mismatch is visible on the harvested trace, not only on box stderr.
- [ ] **Test (prose retirement, AC5):** `tests/fleet/gate-verbs.test.ts` asserts the new remediation text and a repo grep finds no shipped string promising a future in-box executor.
- [ ] **Test (e2e demo — MANDATORY):** one live run on a real box — `fleet attach` exits **0** with `attach-acked`, `/run/steering/acks.ndjson` carries the messageId, the gate event carries no `reason`, and the harvested trace shows the fold: the inverted PASS shape, with the old `no-ack` assertion deleted rather than skipped.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
