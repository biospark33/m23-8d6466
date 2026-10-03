# Z2: BUILD-IN-FORK — the `factory_observe` step kind, durable triggers, and the notify leg

**Story Points:** 5
**Sprint:** v6a (Epic Z — adapter-contract arc, story 2 of 2; Wave 3; BUILD-IN-FORK, Live tier: fake-CLI journal)
**Status:** in-progress

> **Cross-repo charter (§5.5):** this story's normative work lives in the swarmclaw fork (`/Users/steve/Solstice/.worktrees/hermes-agent/external/swarmclaw` — the fresh worktree; the main Solstice checkout's submodule is stale). Fork PRs merge on fork dev. Factory points cover factory-repo work + joint rounds only. Factory CI must stay green with **no fork checkout** (§5.2).

## Spec Reference

- **Charter:** `_bmad-output/sprint-artifacts/dark-factory-v6/2026-10-01-v6-derivation-session-INPUT.md` — Epic Z row Z2; §5.2 spec-seam fixtures (extend the SC2 fake-CLI-journal pattern); §5.3 pinned fork revs (factory pin bumps only at evidence rounds); §5.5 counterpart stories, one contract text.
- **Decision register:** `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md` — DD-14 (namespace, BUILD-IN-FORK classification); the fork-grammar extension entry this story records (AC4).
- **Consumed contract, unmodified:** Z1's pinned observe consumption surface (`_bmad-output/sprint-artifacts/dark-factory-v6/stories/z1-adapter-contract-v2.md` + `tests/fleet/q1-contract.test.ts` as merged). Drift found while building Z2 is fixed by a Z1 bump PR first — never by relaxing a Z2-side expectation.
- **Fork substrate facts:** `ProtocolExternalJobConfig` at `fork:src/types/protocol.ts:148` (repoSlug, repoUrl, commitSha 40-hex, manifestPath, issueId XOR workId, groupCapUsd, pollTimeoutMs default 1h, onFailure) attached as `step.externalJobConfig` (:119); `ProtocolStepKind` closed union (:84-94, includes `'external_job'`); `normalizeStep` at `fork:src/lib/server/protocols/protocol-normalization.ts:242` with `normalizeExternalJobConfig` (:287 — identity fields REFUSE, not truncate); the carry precedent comment (a2a config "historically NOT carried … erased every a2a_delegate phase's config at its first persist" — the bug-0 class); artifact-kind closed union at `fork:src/types/protocol.ts:193` (`factory_result` among six); `FLEET_CLI_ENV = 'SWARMCLAW_FACTORY_FLEET_CLI'` + env allowlist `['PATH','HOME','TMPDIR','LANG']` in `fork:src/lib/server/protocols/protocol-factory-exec.ts`; `FACTORY_ARTIFACT_KIND` + F-011 every-terminal-verdict-writes in `fork:src/lib/server/protocols/protocol-factory-lifecycle.ts`; `branch_taken` witness at `fork:protocol-step-processors.ts:354`; fake-CLI journal fixtures at `fork:protocol-factory.test.ts:107`; two-stage durable notify (`originSessionNotifiedAt` → `originSessionOutcomeDeliveredAt` + `retryPendingProtocolRunOutcomes`) in `fork:src/lib/server/protocols/protocol-run-outcome-notify.ts`; persisted schedule store (`fork:src/lib/server/schedules/schedule-repository.ts` `loadSchedules/upsertSchedule`) + `SourceRef {kind:'schedule', scheduleId}` (`fork:src/types/protocol.ts:187`) + watch-job repository (`fork:src/lib/server/runtime/watch-job-repository.ts`). All `fork:`-prefixed cites are verified against the Solstice worktree fork (`v6-crossrepo-contract.md` §0) and are unresolvable — by design — in this repo.
- **Ancestry disposition:** the HANDOFF Epic S2 clause "heartbeat jobs invoking DF3.8 sweep + approval pings" is **not carried** — SC2 proved the protocol substrate and #383 closed the park race; the successor shape is this story's durable triggers, not heartbeat pings. P2.4's DAG-node-capture *need* (structured per-run protocol observation) is met here read-only — its P2.1 event-store target, adapter, and SPIKE-10 retire (DD-15).
- **Boundary with Z3 (v6b):** Z3 is the cross-repo live exit round — the only real-behavior assertion over this machinery. Everything here is proven by the fake-CLI journal; no live round, no box, no spend.
- **Boundary with G1/ADR-2:** approval policy untouched — `fleet approve` stays scrypt/stdin/human-only; observe steps park at `awaiting-approval` and never decide. ADR-2's auto-merge/verdict-consumption policy is not pre-implemented here.
- **Boundary with Z4:** `--driver exedev` is the deployed wrapper's business. The fork passes no driver flag ever; for `status` (registry: driver-required) the wrapper supplies it at deploy time (Z4).

## User Story

As a swarmclaw protocol, I want a `factory_observe` step kind that reads a factory run's pinned read-only surface, plus durable post-merge and schedule triggers and a completion notify leg, so that factory runs can be watched and fired from persisted protocol state that survives restarts — without the fork ever learning how factory work is driven.

## Overview

Adds the read-only sibling to SC2's `external_job`: a step kind that consumes `fleet status`/`fleet result` (no submit, no box, no spend), fires protocols from a factory PR merge or a persisted schedule, and notifies a durable target when a triggered run reaches a terminal status. **What this does NOT deliver:** no driver grammar in the fork; no live round (Z3); no approval-channel change (G1); no bot residency (A1 consumes this); no factory-side code beyond one consumer-harness test.

## E2E Slice

**Demonstrable behavior:** Given a protocol template `external_job → factory_observe` running under the fork test suite with the fake-CLI journal standing in for `$SWARMCLAW_FACTORY_FLEET_CLI`, When the run executes, Then the observe step resolves the target runId from the prior step's submit-ack output, invokes exactly `result`/`status` through `runFleetVerb` (execFile, env allowlist unchanged, argv carries no `--driver` — proven by the journal), parks on `awaiting-approval`, completes on `terminal: true`, and writes a `factory_observe` artifact carrying the raw payload; separately, a persisted schedule fires a protocol run whose `sourceRef` records `{kind:'schedule', scheduleId}`, and its terminal status lands a notification on the target session via the two-stage durable markers.

**Wiring closed:** On completion of this story, a protocol can be triggered, observe a factory run read-only, and notify — using only fork code merged by this story plus Z1's contract text. **No stub, no `TODO: wire later`.** Factory CI is green throughout with no fork present.

**Dependency edges (predecessors):** **Z1 is a *direct* edge** — the pinned JSON/exit-code surface this story's processor consumes, not one inherited through anything else. **Not an edge — M1.2:** the memory cycle is host-side factory work sharing no symbol with this story. **Not an edge — A1:** A1 consumes Z2's triggers but defines no seam Z2 needs; Z2 ships on fork dev regardless (charter §5.3).

## Acceptance Criteria

1. **(make-or-break — the carry)** Given `ProtocolStepKind`, When `'factory_observe'` is added with a `factoryObserveConfig` field on `ProtocolStepDefinition`, Then `normalizeStep` carries it (mirroring the `externalJobConfig`/`a2aDelegateConfig` entries) and a round-trip test proves persist → load → persist keeps the config byte-stable. *Negative control: an implementation that adds the type but skips the `normalizeStep` entry re-plays the bug-0 class — `persistRun` normalizes on every save and erases the config at first persist, so the step submits nothing and MUST fail this one.*
2. **(read-only closure, enforced in the module)** Given the observe processor, When it executes, Then it invokes only verbs in the closed allowlist `{status, result}` through `runFleetVerb` — the allowlist lives in the new module, not in convention — and never takes the `external_job` submit path. *Negative control: an implementation reusing the submit path makes the "observe" step able to create spend from a read-only step, and MUST fail this one.*
3. **(target resolution)** Given `factoryObserveConfig`, When the target runId is resolved, Then it comes from the config or from a referenced step's `factory_result`/output record; both-or-neither is refused at normalization (the `normalizeExternalJobConfig` refuse-don't-guess idiom). *Negative control: an implementation that lets a missing target collapse to null and the processor guess — `fleet result` then answers exit 4 "no such run record" for a run that was never named, indistinguishable from a real miss — MUST fail this one.*
4. **(verdict + artifact + the park)** Given a terminal `fleet result`, When the observe step settles, Then it writes a `factory_observe` artifact (kind added to the closed union at `fork:src/types/protocol.ts:193` — a deliberate fork-grammar extension, recorded in the register; the factory consumes nothing new) and branch conditions may key on the payload. `awaiting-approval` parks the step and is **never** terminal. The inbox relays *to* the gate; it never *is* the gate — channel ≠ policy. *Negative control: an observe step that treats `awaiting-approval` as terminal completes a run no human decided — violating ADR-1 Decision ¶1 (the fleet owns the verdict) with §3 (the gate does not move) — and MUST fail this one.*
5. **(post-merge trigger, durable)** Given a wired protocol, When a factory PR merges, Then the trigger rides the fork's existing `type:'http'` watch job (`watch-job-repository.ts`; `WatchJobType` gains no member, per DD-28.26(6)) — `target.url` is the GitHub PR endpoint, `condition` tests merged (HTTP 200 + `"merged": true` in the body the evaluator already fetches), bounded by the job's existing poll ceiling, deduped on merge identity (repo + PR number + merge SHA) and restart-safe. The job's request headers carry an operator-provisioned GitHub PAT held in the fork's existing encrypted credential store (`fork:src/lib/server/credentials/credential-service.ts` — the surface that already holds provider keys; the fork has no GitHub App installation surface to ride). *Negative control: a trigger implemented on `enqueueSystemEvent` — in-memory, cap 20/session — loses the fire on the first process restart and MUST fail this one.*
6. **(schedule→protocol trigger, durable)** Given the persisted schedule store, When a schedule targets a protocol, Then the scheduler tick fires the run through the existing dispatch path and the run's `sourceRef` records `{kind:'schedule', scheduleId}`. *Negative control: an implementation that enqueues the fire at authoring time in memory strands the schedule on restart and MUST fail this one.*
7. **(the notify leg — each trigger kind names its durable target home)** Given a trigger-sourced run reaching a terminal status, When it completes, Then notification eligibility extends to runs whose source names a durable target, and each trigger kind's target lives in THAT trigger's own persisted store: schedule-triggered runs read the target (e.g. `notifyTargetSessionId`) from the fired schedule's existing persisted `protocolConfig` bag; post-merge (watch-job) runs read it from the watch job's own persisted config in the watch-job repository (the same bag discipline on the `type:'http'` job — persisted store, survives restart, no new `WatchJobType` member per DD-28.26(6)); no new `Schedule` field is added, keeping DD-28.6's notify-eligibility item as the accounting anchor. A trigger-sourced run with NO durable target in its source config is out of the notify contract's scope (nothing to deliver to is a config state, not a notify failure). Delivery rides the existing two-stage markers with `retryPendingProtocolRunOutcomes` sweeping unchanged. *Negative controls, both MUST fail: a notify that fires on the first terminal write without the `originSessionNotifiedAt` marker double-notifies across a fail → resume → complete arc; and a post-merge run whose notify target lives anywhere but a persisted store (in-memory, request-scoped) loses the target on restart — the first restart after a merge silently drops the notification.*
8. **(the factory consumer harness)** Given factory CI with no fork checkout, When `tests/fleet/factory-observe-consumer.test.ts` runs, Then it plays the fork-observe-consumer role against the **real** fleet verbs (fake driver) and asserts the exact Z1-pinned JSON and exit codes — it imports the Z1 helper (`tests/fleet/observe-contract.ts`) and asserts nothing by hand. *Negative control: a harness that stubs fleet output instead of driving `run()` drifts silently from the real CLI the moment the factory moves, and MUST fail this one.*
9. **(grammar boundary)** Given every fork-side observe invocation, When the journal records the argv, Then no `--driver` flag ever appears in fork code paths; `status`'s driver requirement is met only by the deployed wrapper (Z4). *Negative control: fork code that appends `--driver exedev` has learned QDS's driver grammar — the DF5.5 Amendment D line — and MUST fail this one.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
| --- | --- | --- | --- |
| Factory PR merged → protocol | in-scope — AC5 | fork trigger suite — a local `http.createServer` PR-endpoint stub fakes the GitHub leg (the idiom `watch-jobs-advanced.test.ts` already uses for `type:'http'` jobs) | none in v6a.0 |
| Persisted schedule → protocol | in-scope — AC6 | fork trigger suite | A1/A3 consume in v6b |
| Run terminal → notify | in-scope — AC7 | notify suite (two-stage markers) | none in v6a.0 |
| Observe a submitted run | in-scope — AC1–AC4, AC8–AC9 | protocol-factory-observe suite | Z3 live-proves in v6b |
| Bot-initiated observe (Home bot) | out-of-scope — A1/E21 S02b/S03b gate; Z2 ships regardless | — | A1 |
| Factory push webhook → fork | out-of-scope — polling watch job chosen (durable, no new inbound surface); revisit if the factory grows a push channel | — | none scheduled |
| Approval-channel change | out-of-scope — ADR-2 PROPOSED (G1); observe steps park, never decide | — | G1 |
| Driver grammar in fork | never — ADR-1 §2 + DF5.5; AC9 is the standing fence | — | — |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
| --- | --- | --- |
| Z1 contract | none — `bun test tests/fleet/q1-contract.test.ts` green on factory dev | green before start; consumed unmodified |
| Fresh fork worktree | none — fork submodule at `/Users/steve/Solstice/.worktrees/hermes-agent/external/swarmclaw` on its branch | `protocol-factory.test.ts` green before start |
| Factory suite | none — `bun test tests/fleet/` green with no fork checkout | green before and after (harness is additive) |

> No box, no key, no model spend, no VPS, and no live round are prerequisites of this story. The fake-CLI journal is the entire runtime.

## Technical Notes

- **One invocation, one attempt leg — and the durable wake is named:** the observe step is a verb-call-and-settle, not a watcher process — no daemon, no interval timer inside the step. A step that PARKS (`awaiting-approval`, AC4) is awakened by the same durable wake that drives `external_job` today: the fork's daemon poller `pollFactoryRuns` (`fork:src/lib/server/protocols/protocol-factory.ts:230` — heartbeat-scheduled, single-flight per F-007, deadline per F-008), whose step loop currently skips anything that is not `kind: 'external_job'` (`fork:src/lib/server/protocols/protocol-factory.ts` inner loop). Z2 EXTENDS that filter to include parked `factory_observe` steps — the poller re-drives a parked observe through the same settle path to terminal completion, and `sweepTerminalFactoryRuns`'s existing stranding sweep covers observe entries identically — with one INV-Z2-1 carve-out: the sweep's mark stops the polling, but its best-effort `fleet cancel` is refused for `factory_observe` entries (a watching step must not abort foreign factory work). The no-daemon/no-interval constraint is untouched: it binds the STEP (one invocation = one verb call + settle), and the wake is the fork's pre-existing durable surface, not a new loop this story invents. Written out so a dev does not re-derive it into a poller — in either direction.
- **Post-merge trigger substrate (DD-28.26(6)):** configuration of the existing `type:'http'` watch job, not new machinery — no new `WatchJobType` member, no Z1 contract bump. Auth rides an operator-provisioned GitHub PAT from the fork's encrypted credential store (`credential-service.ts`; no GitHub App surface exists in the fork), carried in the job's request headers — the one evaluator touch this needs. The trigger suite fakes the GitHub leg with a local `http.createServer` PR-endpoint stub.
- **Region ownership:** fork `protocol-factory.ts` is a re-export barrel at its 500-line budget — the observe work lands in a **new** `protocol-factory-observe.ts`, never as growth of the exec/lifecycle modules. Factory repo: tests only.
- **Guards:** observe exec inherits `FLEET_EXEC_TIMEOUT_MS = 300_000` and `FLEET_EXEC_MAX_BUFFER = 16MiB` unchanged; `pollTimeoutMs` (default 1h) bounds the observe settle exactly as it bounds the submit park (F-008's deadline-owns-both-phases doctrine, mirrored).
- **Spend:** observe steps book nothing — no submit, no cap consumed — which sidesteps the #380 spend-booking gap entirely rather than taking a side on it.
- **Deviation/assumption (Deviation 1, binding on this story):** two closed unions gain members: `ProtocolStepKind` (`fork:src/types/protocol.ts:84-94`) and `ProtocolRunArtifact['kind']` (`fork:src/types/protocol.ts:193`), both recorded in DD-28.6. Both are additive and fork-internal (the factory consumes CLI JSON, not fork artifacts), recorded per charter §5.1's deliberate-bump discipline. DD-28.26(6)'s post-merge decision adds no union member — the `type:'http'` watch job already exists.
- **Ordering against Z1:** the pin does not track fork dev. These fork merges do not bump `SWARMCLAW_FORK_REV`; the evidence round that proves them does (Z3).
- **Considered and rejected: reusing `kind:'external_job'` with a mode flag.** A mode flag re-opens the submit path from the same config shape — AC2's module-level refusal is the security property; a second kind is the honest grammar.
- **Considered and rejected: factory-side polling of the fork.** Inverts D6/host authority — the fork owns process state, the factory owns provisioning, spend, execution, and the verdict (ADR-1 §1).

## Observability Contract

Every observe invocation journals one line: verb, argv (driver-absence provable), exit code, latency. The `factory_observe` artifact carries the raw pinned payload plus `fetched_at`; sub-timings it did not measure are **absent, not `0`**. Trigger fires and notify transitions log through the fork logger with the scheduleId/merge identity as the correlation key; the two notify markers (`originSessionNotifiedAt` decided / `originSessionOutcomeDeliveredAt` delivered) are the durability contract — a run stuck between them is the sweep's workload, named as such in the log.

## Files to Modify

**Factory repo:**
- `tests/fleet/factory-observe-consumer.test.ts` — **new**: consumer harness against real verbs + fake driver, asserting through Z1's `tests/fleet/observe-contract.ts` helper (AC8)

**Fork repo (`external/swarmclaw`):**
- `src/types/protocol.ts` — **adds only**: `'factory_observe'` kind + `factoryObserveConfig` type/field (AC1)
- `src/lib/server/protocols/protocol-normalization.ts` — **adds only**: `normalizeStep` carry + `normalizeFactoryObserveConfig` (AC1, AC3)
- `src/lib/server/protocols/protocol-normalization.test.ts` — **extends**: round-trip carry test, refuse-don't-guess cases
- `src/lib/server/protocols/protocol-factory-observe.ts` — **new**: read-only processor + verb allowlist + artifact writer (AC2–AC4)
- `src/lib/server/protocols/protocol-factory-observe.test.ts` — **new**: fake-CLI journal extension (AC2–AC4, AC9)
- `src/lib/server/protocols/protocol-triggers.ts` — **new**: post-merge watch + schedule→protocol fire, persisted-store-backed (AC5, AC6)
- `src/lib/server/protocols/protocol-triggers.test.ts` — **new**: restart-safety + dedup proofs (AC5, AC6)
- `src/lib/server/protocols/protocol-run-outcome-notify.ts` — **extends**: eligibility for trigger-sourced runs (AC7)
- `src/lib/server/protocols/protocol-run-outcome-notify.test.ts` — **extends**: double-notify negative control (AC7)
- `src/lib/server/protocols/protocol-z2-e2e.test.ts` — **new**: the DOD e2e demo round (schedule fire → submit → observe → terminal → notify)
- `src/lib/server/protocols/protocol-factory.ts` — **extends**: pollFactoryRuns step-loop filter + routing arm for parked `factory_observe` entries; re-export block (Technical Notes: the durable wake)
- `src/lib/server/protocols/protocol-step-processors.ts` — **extends**: the one dispatch arm for `factory_observe`
- `src/lib/server/protocols/protocol-run-lifecycle.ts` — **extends**: the skip action's read-only local-mark arm (`markFactoryObserveSkipped`; the external_job arm fleet-cancels, observe must not)
- `src/lib/server/runtime/watch-jobs.ts` — **extends**: optional credential headers in `evaluateHttpLikeJob` (AC5's PAT-in-headers) + the post-merge fired-branch hook in `processDueWatchJobs`
- `src/lib/server/protocols/step-dag-validation.ts` — **extends**: the F-003 repeat-body refusal now covers `factory_observe` (iterations 2+ would silently re-observe nothing — same keyed-state hazard as the `external_job` twin)

## Security Invariants

- **INV-Z2-1 (ADR-1 §2 — the observe step cannot spend):** the verb allowlist `{status, result}` is enforced in the module; the submit path is unreachable from this step kind. Negative space, said plainly: this fences the step, not the CLI — a fork actor with shell access can still invoke the CLI, which is out of scope here.
- **INV-Z2-2 (DF5.5 grammar boundary):** no driver grammar in fork code; the argv journal is the proof surface (AC9).
- **INV-Z2-3 (env allowlist inherited unchanged):** observe exec rides `runFleetVerb`'s `['PATH','HOME','TMPDIR','LANG']` — no new env var rides to the CLI, secrets included.
- **INV-Z2-4 (durability = no silent trigger loss):** triggers and notifications are persisted-store-backed; `enqueueSystemEvent` never carries a trigger or a notify (in-memory, cap 20/session — R4 fact).
- Inherited verbatim, untouched: `fleet approve` scrypt/stdin/human-only; fleet stays the only code-entry path; F-011 every terminal verdict writes its artifact; #383's gate-before-teardown ordering (the observe chain's, not this story's code).

## Definition of Done

- [x] **Impl:** step kind + config + `normalizeStep` carry landed in fork `protocol.ts`/`protocol-normalization.ts`. — landed + review-round-hardened (r1–r3): step kind, config field + interface, artifact kind, the normalizeStep carry entry, and normalizeFactoryObserveConfig (all in the fork's type + normalization modules).
- [x] **Test (normalizeStep round-trip):** config survives persist → load → persist byte-identical; the bug-0 erase class named in the test. — normalizeProtocolRun full-run literal + a SECOND normalize pass (the persist choke-point semantics; byte-stability via deepEqual of the canonical shape); bug-0 named in test title.
- [x] **Contract:** observe processor refuses every verb outside `{status, result}`; argv journal shows zero `--driver` occurrences from fork code. — OBSERVE_VERBS module allowlist + runObserveVerb pre-exec throw; journal scans assert verbs ⊆ {status,result} and zero --driver across all rounds.
- [x] **Test (fork):** `protocol-factory-observe.test.ts` green via fake-CLI journal — `external_job → factory_observe` chain, `awaiting-approval` park, `factory_observe` artifact written. — 8/8; two-phase park proven again inside the e2e demo.
- [x] **Integration:** post-merge watch job and schedule→protocol fire are restart-safe — test kills the process and reloads from the persisted stores (AC5/AC6 negative controls exercised). — persisted-store reload proofs (fresh repository reads) + the e2e's genuine two-process leg over a shared DATA_DIR; both negative controls named (in-memory enqueueSystemEvent / authoring-time enqueue would strand — INV-Z2-4). Letter note: the watch-job fire leg's process boundary is covered by store-reload semantics (PLAN A18).
- [x] **Test (notify):** two-stage durable markers hold for trigger-sourced runs; no double notify on fail → resume → complete. — named controls: schedule fail→resume→complete exactly-once, crash-window sweep exactly-once, restart-drop (target moved A→B delivers B), vanished-target unmark.
- [x] **Integration (factory):** `tests/fleet/factory-observe-consumer.test.ts` green against real verbs via fake driver — factory CI green with no fork checkout. — 4/4 through assertObserveSurface only; no fork refs; factory full suite green (14 pre-existing vendor fails only).
- [x] **Register:** the `factory_observe` artifact-kind fork-grammar extension recorded in the DD register entry. — DD-28.6 already carried the two-union record (round-2 amend); landed shape verified conformant (leaf-1.5.1, G1+G2).
- [x] **Test (e2e demo — MANDATORY):** one fake-journal round end to end: schedule fires protocol → `external_job` submits (fake) → `factory_observe` polls (fake) → terminal → notify lands on the target session. — protocol-z2-e2e.test.ts 4/4: journal trace ['submit','result','result'], one outcome on sess-notify, both markers, two-process persistence, poll honesty.
