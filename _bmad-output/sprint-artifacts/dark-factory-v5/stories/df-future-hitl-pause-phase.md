# DF-FUTURE: Mid-Walk Human-in-the-Loop — a Designed Path, and Why It Is Not a Phase Kind

**Status:** PROPOSED — **RECOMMENDATION: DO NOT BUILD a `pause` phase kind.** Ship the zero-code
option (§Recommendation, rung 1); build rung 2 only on a named measurement. Rung 3 (the phase kind)
is designed here so that an overrule has a shape to build, not so that it gets built.
**Story Points:** 0 (rung 1) · 2 (rung 2, conditional) · 8+ (rung 3, not recommended)
**Sprint:** unscheduled. **Downstream of DF1.10, DF1.11 and DF3.7** — none of the three has landed,
and every measurement this story would need comes from runs on top of all three. Authoring an
implementation story before then would be designing against folklore, which is the failure mode the
2026-08-31 placement ADR exists to end.

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` — **D2** (`:299`, three
  tiers: cockpit → sandbox fleet → in-box execution; the operator acts on a run *from tier 1*),
  **D4** (`:301`, "Tier 2 = resident orchestrator agent **per sandbox** … operating a deterministic
  TS phase engine", with tripwire (a): *resident-agent token spend > 15 % of run total at p50*),
  **D5** (`:302`, tier 3 is pi teams behind `QDS_TEAM_RUNNER`; SSSF's single-agent-per-phase model is
  named as the thing v5 chose **not** to carry), **§5.1** (`:313-333`) — the three-tier map naming
  `dispatch_task` as the tier-2→tier-3 seam and putting no human inside tier 2.
- `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` (ACCEPTED) — **"Why not host-side"**
  `:93-95`: the approval gate *"stays host-side by construction (state must outlive the box;
  `approval-gate.ts:8-17` pausing → teardown → awaiting-approval)"*; **Consequence 4** `:115`
  ("awaiting marker in-box, host polls; gate stays host-owned"), corrected by DF3.7 Deviation 1 into
  a run-**completion** marker. Probe facts reused: `/run` is tmpfs and a reboot wipes it (`:81`); one
  real in-box pi solicitation cost **$0.000025 / 2.17 s** (`:83-84`).
- `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-7-approval-gate-bridge.md` — the load-bearing
  read. `:10` (the engine has **never** called the gate; `requestApproval`'s sole production caller is
  `src/reverify/runner.ts:461`, host-side, **after** teardown), `:32` — its own words —
  ***"approval authorizes a *push*, never a continuation"***; `:64` (AC3: no timer covers an
  unobserved run, and the reaper's `stale-record` arm harvests and closes with **no `reverify()` and
  no gate**); `:80` (resuming an in-box run after approval is explicitly out of scope: *"the box is
  gone and a decided run's remediation is to dispatch a **new** run"*).
- `src/fleet/approval-gate.ts:1-56` — the ordering docblock. `requestApproval` registers `pausing`
  **before** teardown and promotes to `awaiting-approval` only **after** teardown returns
  (`:8-17`); `awaiting-approval` may never coexist with a live box (INV-APPROVE-6, `:19-31`); the
  lock is never held across teardown (`:51-55`). Every one of those properties is stated in terms of
  the box being **destroyed**.
- `src/phase-engine/types.ts:137-162` (`PhaseKind = "code" | "dispatch_task"` and the C19 docblock
  naming the three HITL surfaces), `:179-193` (`PhaseSpec`), `:164` (`PhaseStatus = "fail" | "success"`
  — there is no third status), `:56-57` (`MIN_PHASES = 2`).
- `src/phase-engine/manifest.ts:67` (`EXECUTING_KINDS … satisfies readonly PhaseKind[]`), `:86-91`
  (`REMOVED_KIND_REMEDIATION` — *"Human-in-the-loop is tier-1 and needs no phase — use `fleet
  approve|reject` after the run, or `fleet attach --message` to steer it mid-run"*), `:130-164` (the
  `superRefine` field rules: `command` iff `code`; `roster`+`task` iff `dispatch_task`;
  `testCommand` only on `code`).
- `scripts/pipeline-run.ts:1517` — `const unreachableKind: never = spec.kind;`. The compile-time
  exhaustiveness guarantee DF1.10 AC1 bought.
- `src/phase-engine/journal.ts:48-56` (`runMarkerRoot()` / `runMarkerPath()`), `:115-123`
  (`writePhase` always persists `fail`), `:125-132` (`promotePhase`, sole path to `success`),
  `:149-157` (`finish`), `:206-229` (`writeTerminalMarker`, 0600, `O_EXCL|O_NOFOLLOW` temp+rename).
- `src/phase-engine/steering.ts:87` (`SteeringPoint = "run_start" | "post_gate_failure" | "run_end"`
  — **three points, no more**), `:96-123` (`SteeringDirectiveSchema`: `proceed | retry |
  select_roster | abort`), `:627` (`drainInbox`, reachable only from `solicit`).
  Call sites: `scripts/pipeline-run.ts:2435` (`run_start`), `:1360` (`post_gate_failure`),
  `:2600` (`run_end`).
- `src/fleet/attach.ts:83,87` (`/run/steering/{inbox,acks}.ndjson`), `:91`
  (`ATTACH_ACK_CEILING_MS = 30_000`). DF1.11 `:46,:125` — INV-RES-4, ***"an ack proves consumption,
  never application"***.
- Cost and collection: `src/providers/quota.ts:44-49` (`staleAfterMs: 14_400_000` — **4 h**),
  `src/providers/reaper.ts:479-489` and `:534-544` (an open record past `staleAfterMs` classifies
  `stale-record` → action `teardown`), `:750-756` (`record-claim-refused` guards **destroy** only, not
  teardown), `src/providers/cost-ledger.ts:1198-1203` (an unconfigured `boxHourRateMicroUsd` is a
  **refusal**, never a silent 0).
- `src/providers/credentials.ts:898-918` — `createKey` posts `{name, limit}`. The per-run key is
  **spend-capped, not time-capped**.
- `src/fleet/verbs.ts:73-419` — the twelve verbs that exist: `dispatch status harvest teardown fanout
  rank approve reject attach enrol unlock run`.

## User Story

As the factory operator who wants the humans mostly out of the loop but keeps the option to intervene
on nuanced work,
I want a designed, costed answer to "how does a person get a decision into a running factory job",
so that the flexibility I asked for arrives as a mechanism I already own rather than as a new phase
kind that quietly re-opens the box-lifetime, replay and evidence questions three shipped stories just
closed.

## Overview

This story exists because narrowing `PhaseKind` to `"code" | "dispatch_task"` (DF1.10 C19) closed a
door that was never a door — `engineer` had no executor and would have died mid-walk after spend
(`types.ts:143-146`) — and the operator asked, reasonably, what the *designed* HITL path is.

**The finding is that there are three of them already, and the honest gap is narrower than "we need a
pause".** It is a *latency* gap in one surface, not a missing surface. The recommendation is a ladder;
stop at the first rung that holds.

## What the three surfaces actually cover (verified, not assumed)

| Surface | When | Blocking? | Authoritative? | Verified at |
|---|---|---|---|---|
| `fleet dispatch` (brief + manifest) | pre-run | n/a | yes — it *is* the run | `brief-schema.ts:339`, `dispatch.ts:2884` |
| `fleet attach --message` → resident | mid-run, **only at 3 solicitation points** | no | **no** — INV-RES-4, an ack proves consumption, never application | `steering.ts:87`, `pipeline-run.ts:2435/1360/2600`, DF1.11:125 |
| `fleet approve` / `reject` | post-run, after teardown **and** host re-verify | yes | yes — but it authorizes a **push**, never a continuation | `approval-gate.ts:8-31`, DF3.7:32 |
| `fleet teardown` | any time | yes (terminal) | yes — the blunt stop | `verbs.ts:127` |

Two things fall out, and the second one is the part usually glossed:

1. There is no gap in *authority*. An operator can start a run, stop a run, and refuse its output.
2. There **is** a gap in *steering latency*, and it is real: `SteeringPoint` has exactly three
   members (`steering.ts:87`) and `drainInbox` is reachable only from `solicit` (`:627`). On a
   two-phase manifest with no gate failure, the only points are `run_start` and `run_end` — so a
   message attached during the work lands **after the work is done**. Saying "steering already covers
   nuanced work" without that caveat would be the same kind of unmeasured claim the placement ADR was
   written to unwind. It covers *reaching* the run; it does not guarantee *timely* arrival.

## The hard problem, stated plainly

**A mid-walk pause is not the approval gate's shape, and cannot be built by analogy to it.**

The gate pauses a run whose box is already **destroyed**. That is not incidental: `requestApproval`
registers `pausing`, tears down, and promotes to `awaiting-approval` only after teardown returns
(`approval-gate.ts:8-17`), and `refuseLiveInfraOnDecidable` refuses to promote an open record that
still names a `vmName` or a `keyHash` (`:19-31`, INV-APPROVE-6). State outliving the box is *why* the
gate is host-owned (ADR `:93-95`). A mid-walk pause inverts every one of those: the run must
**continue** afterwards. That leaves two shapes, and both cost more than they look.

### Option A — hold the box alive while a human thinks

- **Billing.** Real but small: the live e2e config carries `boxHourRateMicroUsd: 230000` — $0.23/box-hour
  (`_bmad-output/evidence/df3-e2e/2026-09-03-120332-t2-1-dispatch-engine.json:19`). An overnight
  12 h pause is ≈ $2.76. Note the repo ships **no** `.sandbox/cost-config.json`; the rate is
  per-deployment and an unset rate is a teardown **refusal** (`cost-ledger.ts:1198-1203`). So the
  number above is the value our live tests ran under, not a repo constant. **UNVERIFIED** as
  exe.dev's current list rate — it is vendor-single-origin (`quota.ts:41`).
- **The reaper collects the pause.** This is the disqualifier, not the billing. An open run record
  older than `staleAfterMs` — **4 h** (`quota.ts:49`) — classifies `stale-record` with action
  `teardown` (`reaper.ts:479-489`, `:534-544`), and teardown harvests and closes the run with **no
  `reverify()` and no gate** (DF3.7:64). The `record-claim-refused` arm at `reaper.ts:750-756` guards
  **destroy** only, so it does not save a paused run. A human pause that outlasts one working
  afternoon is therefore collected by a witness-less teardown, and the operator returns to a closed
  record and no pause.
- **The key idles live.** `createKey` posts `{name, limit}` (`credentials.ts:898-918`): the per-run key
  is spend-capped, not time-capped, so it survives an arbitrarily long pause. That is *convenient* and
  *wrong in the security direction* — the credential-exposure window grows without the cap moving.
- **tmpfs.** `/run` is tmpfs and a reboot wipes it (ADR `:81`, DF1.10 INV-IBOX-8). A pause spanning a
  box reboot loses the steering channel and any pause marker, and `Restart=no` (DF1.10 AC6) means the
  engine does not come back — correctly, because coming back would re-walk paid phases.

### Option B — tear down, checkpoint, resume later

Nothing in the current design supports this, and the list of what it would need is the argument:

- **No `paused` phase status.** `PhaseStatus` is `"fail" | "success"` (`types.ts:164`), `writePhase`
  always persists `fail` (`journal.ts:115-123`) and `promotePhase` is the sole path to `success`
  (`:125-132`). A third status weakens the default-fail discipline INV-IBOX-6 exists to hold. Encoding
  a pause as a `fail` row plus a sidecar is not free either: `finish()` computes
  `ok = rows.length > 0 && every success && accepted` (`:149-157`), so a paused run is `ok:false` —
  indistinguishable, at the marker, from a run that failed.
- **No replay guard fine enough to resume.** DF1.10 AC6's only replay refusal keys on *"the marker
  already exists"*, and a paused run has no marker. A resumed engine started against a marker-less run
  re-walks from phase 0, re-executing phases whose `sbx/<runId>` commits and spend already happened —
  the exact negative control DF1.10 AC6 names (`df1-10…md:96-97`). Resume needs a per-phase completion
  ledger the journal deliberately does not have (*"the journal has no attempt column and this story adds
  none"*, `:95-96`).
- **No resume verb, and `Restart=no` is load-bearing.** `fleet run` starts `qds-run@<runId>.service`
  (`verbs.ts:419`); on an exited instance a second `start` starts a **fresh** engine, which is exactly
  what must not happen.
- **The host cannot see a pause.** The terminal marker is the run-*completion* signal DF3.7 and DF3.8
  poll, and both treat `absent` as *not finished yet* (DF3.7 AC2a). A paused run is byte-for-byte
  indistinguishable from a running one. Making it distinguishable means a second in-box marker, a
  second poller and a second contract — a daemon-shaped answer the design says twice it does not have
  (DF3.7 Trigger Surface `:77`, INV-IBOX-16).
- **INV-IBOX-7 would be inverted.** In-box evidence is *claims*, not proof; DF5.1's host re-verify is
  the independent second layer. A mid-walk pause asks a human to make an **authoritative** decision
  against **in-box claims that no host re-verify has re-judged**. The approval gate never does this: it
  decides only after `reverify()` re-judges the tree independently (`runner.ts:421`, DF3.7 AC2c). A
  mid-walk pause without a host re-verify collapses the two layers into one trust domain — the precise
  inversion the placement ADR called out as Option 1's error (`ADR:56-67`).

## Recommendation

**Rung 1 — zero code, available the day DF3.7 lands. This is the recommendation.**
A blocking, authoritative mid-walk human decision is a **run boundary**, and the factory already ships
the machinery for run boundaries. Split the pipeline into two manifests (each ≥ `MIN_PHASES` = 2,
`types.ts:56-57`). Run A finishes → `writeTerminalMarker` → DF3.7's observer → harvest → teardown →
`reverify()` → the gate → `fleet approve` → DF5.2 pushes → dispatch run B at the pushed
`commitSha` (`brief-schema.ts:339`). The human decision is blocking, authoritative, made against a
host-re-verified tree, and costs **no idle box, no live key, no reaper race, no checkpoint, no new
kind, and no new line of code**. The price is one extra dispatch: measured at **38.8 s** end to end
(`create_ms 3320, mint_ms 1384, fill_ms 17366, setup_gate_ms 15837`, same evidence file `:31`).
Trading 39 s of setup for hours of idle box and a resume mechanism that does not exist is not close.
Known limitation, stated rather than glossed: continuity across the boundary is carried by the git
tree and the bundle, **not** by the phase envelope chain (`PhaseParams.previous`, `types.ts:199-207`),
so a split must fall where the repo is the whole handoff. That is where a human wants to look anyway.

**Rung 2 — small, and only on a measurement.** If run data after DF1.11 shows attached guidance
routinely arriving too late to matter, add **one** `SteeringPoint` member drained at each phase
boundary. That is one union member (`steering.ts:87`) and one call site in the walk. Two variants,
cheapest first: (i) **drain-only** — fold and ack without soliciting: costs $0 and no model call, and
buys ack latency; (ii) **drain + solicit** — buys a `proceed`/`abort` directive at every boundary, and
costs one solicitation per phase (measured **$0.000025 / 2.17 s**, ADR `:83-84`) against **D4 tripwire
(a)**, resident spend > 15 % of run total at p50 (`design:301`). Prefer (i) until (ii) is earned.

**Rung 3 — the `pause` phase kind: recommended AGAINST.** It is a second HITL mechanism where an
existing one serves; it is the only proposal on the table that must either hold a box open past the
reaper's 4 h door or invent a resume path the journal was designed to refuse; and it would put an
authoritative human decision downstream of unverified in-box claims. If overruled, build it to the
shape in the section below — not to any other.

## E2E Slice (rung 2, CONDITIONAL — build only if AC1's measurement fires)

**Demonstrable behavior:** Given a live in-box run on a manifest of ≥ 3 phases with no gate failure,
When the operator runs `fleet attach <run-id> --message "prefer the smaller diff"` during phase 1,
Then the ack appears in `/run/steering/acks.ndjson` **before phase 2's body starts** — not at
`run_end` — and the host's poll observes it inside `ATTACH_ACK_CEILING_MS` (`attach.ts:91`), exiting 0
with `attach-acked`. Observable artifacts: the ack line carrying the new `point`; a harvested trace
showing the fold at the boundary; and, on variant (i), **no** `agent_end` row attributable to the new
point — the proof that no model was called.

**Wiring closed:** using only DF1.11's shipped drain/ack/dedupe path, DF3.3's fold budget and DF3.4's
host `attachToRun` leg. **No stub, no `TODO: wire later`.** **Dependency edges:** DF1.10, DF1.11.

## Acceptance Criteria (rung 2, conditional)

1. **(the gate on building anything at all)** Given ≥ 20 real runs after DF1.11 has landed, Then the
   measurement `attach_sent_at → ack point` is reported, and this story proceeds **only if** the p50
   arrival point is `run_end` on runs whose operator intended mid-walk influence. Absent that number,
   the correct action is to close this story unbuilt. *Negative control: "operators say they want it"
   is not the measurement, passes any review that asks for a rationale, and MUST fail this one.*
2. Given the new point, Then it is **drained, not solicited** (variant (i)) unless AC1's data also
   shows guidance needs a `proceed`/`abort` verdict rather than context. `SteeringDirectiveSchema`
   (`steering.ts:96-123`) gains no member: the four actions cover it. *Negative control: an
   implementation that adds a solicitation per phase boundary by default passes every functional test,
   raises resident spend on every run including the ones that never attach, walks toward D4 tripwire
   (a), and MUST fail this one.*
3. Given a boundary drain, Then the run **does not stop** for it: no wait, no deadline, no directive
   is required for the walk to continue, and a stalled inbox is bounded by the existing
   `INBOX_CALL_TIMEOUT_MS` / drain-pass budget (`steering.ts:69-80`). *Negative control: an
   implementation that blocks the walk on an operator reply has built rung 3 under rung 2's name and
   MUST fail this one.*
4. Given the ack contract, Then INV-RES-4 is unchanged: an ack proves consumption, never application
   (DF1.11:125), and nothing host-side treats the new point as verification. *Negative control: a
   status or gate surface that reports "operator guidance applied" MUST fail.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---|---|---|---|
| split-pipeline HITL boundary (rung 1) | **in-scope, zero code** — exercised by DF3.7's and DF5.2's own e2e | (existing) | — |
| phase-boundary drain point (rung 2) | conditional on AC1 | `tests/phase-engine/steering.test.ts` + DF1.11's live attach test | — |
| a `pause`/`approval` phase kind | **out-of-scope — recommended against** | — | none scheduled |
| a box held alive awaiting a human | out-of-scope — collides with `reaper.ts:479-489` at 4 h and with INV-APPROVE-6's no-live-infra rule | — | none |
| checkpoint + resume of a torn-down run | out-of-scope — DF3.7:80 already ruled the remediation is a **new** run | — | none |
| any second in-box marker the host polls | out-of-scope — DF3.7 INV-IBOX-16 (no daemon, no second poller, no new state) | — | none |
| changes to `approval-gate.ts`, `approvers.ts`, `push.ts`, the record's approval block | out-of-scope — DF3.7 INV-IBOX-14 fences these with a runnable import test | — | DF3.4 owns them |

## Infra Prerequisites

| Component | Service | Lifecycle Hook Verified |
|---|---|---|
| in-box engine + steering executor | DF1.10 + DF1.11 | both landed and green on a real box; every measurement in AC1 is taken **after** that, never before |
| completion → gate chain (rung 1's whole mechanism) | DF3.7's observer + DF5.1 `reverify()` + DF3.4's gate + DF5.2's push | DF3.7's mandatory live demo green: marker → harvest → teardown → reverify → `awaiting-approval` |
| box-hour rate | `.sandbox/cost-config.json` — **absent from the repo**, per-deployment | teardown refuses on an unset rate (`cost-ledger.ts:1198-1203`); any cost claim here is UNVERIFIED against exe.dev's list price |

## Technical Notes

- **Why not "just make it a manifest field on an existing kind".** A `pauseAfter: true` on a `code`
  phase looks cheaper than a kind and is worse: it puts the box-lifetime and resume problems inside a
  kind whose executor has no concept of them, and the `superRefine` block (`manifest.ts:130-164`) would
  gain a rule that is not a shape constraint but a runtime-behaviour switch. Every objection above
  survives the rename.
- **The compile guarantee, shown working.** `EXECUTING_KINDS … satisfies readonly PhaseKind[]`
  (`manifest.ts:67`) pins the schema to the union, and `const unreachableKind: never = spec.kind`
  (`pipeline-run.ts:1517`) makes a kind without an executor a **compile error**, not a paid-for
  runtime throw. That is exactly what the operator bought in DF1.10 AC1, and it is why rung 3 cannot be
  half-built: the day `PhaseKind` gains `"pause"`, `tsc` refuses until an executor exists. Any
  proposal that says "add the kind now, wire the executor later" does not compile, and that is the
  design working, not an obstacle to route around.
- **Region ownership.** Rung 1 touches nothing. Rung 2 touches `src/phase-engine/steering.ts` (DF3.3's,
  one union member) and one call site in `scripts/pipeline-run.ts` (DF1.1's walk). Neither rung touches
  `src/fleet/approval-gate.ts`, `approvers.ts`, `src/pr/push.ts`, or `run-record.ts`'s approval block —
  DF3.7's INV-IBOX-14 import fence would catch it if they did.
- **Deviation/assumption.** ADR Consequence 4's *"awaiting marker in-box"* is already corrected by
  DF3.7 Deviation 1 into a run-**completion** marker. This story adds no second reading of it: there is
  no "awaiting" marker in this design, and a future author reaching for one should read DF3.7:10 first.

## Observability Contract

- Rung 1 emits nothing new: the boundary is two ordinary runs, each with its existing
  `{requestId, runId, event}` lines, joined by the operator's own `fleet approve`.
- Rung 2 adds only the existing ack line's `point` value; no new event type, no new record field
  (INV-IBOX-9), and the operator's message text is never echoed into a log — it is already bounded and
  sanitized at `ATTACH_MESSAGE_CHAR_CEILING` (`steering.ts:36-45`).
- The one metric this story actually asks for is AC1's: time-and-point of first ack, relative to
  attach. It rides the existing trace as a `type:"log"` row; nothing persists it in the run record.

## Files to Modify

- **Rung 1: none.** That is the point.
- Rung 2 (conditional): `src/phase-engine/steering.ts` (one `SteeringPoint` member),
  `scripts/pipeline-run.ts` (one drain call at the phase boundary),
  `tests/phase-engine/steering.test.ts`, and DF1.11's live attach test extended by one assertion.
- Rung 3: not enumerated. Enumerating files for a design this story recommends against would be the
  first step of building it.

## Security Invariants

- **INV-HITL-1 (no new authority in the box).** Neither rung gives the box a push credential, a
  provisioning key or a minter (DF1.10 INV-IBOX-5, D8). Rung 1's push happens host-side after approval
  (DF5.2), which is the only place it has ever happened.
- **INV-HITL-2 (a human decision is made against re-verified evidence, never against in-box claims).**
  Rung 1 inherits this for free: the decision sits downstream of `reverify()` (`runner.ts:421`), the
  independent second layer of DF1.10 INV-IBOX-7's two-layer doctrine. Any mid-walk authoritative pause
  must state how it satisfies this; rung 3 has no answer, which is the strongest single reason to
  refuse it.
- **INV-HITL-3 (default-fail is not negotiated).** `writePhase` persists `fail` and `promotePhase` is
  the sole path to `success` (`journal.ts:115-132`); `PhaseStatus` gains no third member; no attempt
  column is added; no path re-executes a phase already paid for (DF1.10 INV-IBOX-6). Neither
  recommended rung goes near this, and that is a *reason* for the recommendation, not a side effect.
- **INV-HITL-4 (one HITL mechanism per gap).** `fleet dispatch`, `fleet attach --message`,
  `fleet approve|reject` and `fleet teardown` are the surfaces (`manifest.ts:86-91`, `verbs.ts:73-419`).
  A fifth is added only against a named measurement that shows the four leave a gap.

## If the operator overrules: the minimum shape of a `pause` kind

Recorded so an overrule builds *this* and not something worse. It is not endorsed.

- `PhaseKind` gains `"pause"`; `EXECUTING_KINDS` (`manifest.ts:67`) gains it in the same commit, because
  `satisfies` pins them together. An executor MUST land in the same commit —
  `pipeline-run.ts:1517`'s `never` refuses to compile otherwise. This is a feature: the kind cannot ship
  half-wired.
- **Field rules** for the `superRefine` block (`manifest.ts:130-164`), stated in the same idiom as the
  existing two: `prompt: string` (the question shown to the human) is **required iff** `kind ===
  "pause"` and **forbidden otherwise**; `command`, `testCommand`, `roster` and `task` are all
  **forbidden** when `kind === "pause"`; a `timeoutMs` is **not** added — the phase's existing
  `maxDurationMs` ≤ `MAX_MAX_DURATION_MS` (15 min, `types.ts:35`) is the ceiling, which by itself makes
  the "hours of human thinking" shape illegal without also raising a constant three other guards derive
  from.
- **Semantics that keep INV-HITL-3:** the executor writes its row through `writePhase` (persisting
  `fail`, like every other kind), blocks on the steering inbox for a `proceed`/`abort` directive, and
  reaches `promotePhase` only on `proceed`. A pause that times out settles `fail` by doing nothing —
  the default-fail discipline is the timeout handler, which is the one genuinely elegant part of this
  design.
- **What it still does not answer, and what an overruling operator is therefore accepting:** the box
  bills while the human thinks; the reaper collects the run at 4 h (`reaper.ts:479-489`) unless
  `staleAfterMs` is raised, which weakens orphan collection for every other run; the key stays live for
  the pause; a box reboot loses `/run` and `Restart=no` correctly refuses to resume; the host cannot
  distinguish a paused run from a running one without a second marker and a second poller; and the human
  decides against in-box claims that no host re-verify has re-judged (INV-HITL-2). Each is a real,
  cited cost, not a review nit.

## Definition of Done

- [ ] **Decision:** the operator reads §Recommendation and rules on rung 1 vs rung 2 vs rung 3. If rung
      1, this story closes **unbuilt** and that is the successful outcome.
- [ ] **Rung 1 (if chosen):** the split-pipeline HITL boundary is documented as a factory-skill recipe
      (tier 1, `df3-5`'s surface), not as engine code — two manifests, `approve`, push, dispatch at the
      pushed sha. No `src/` change.
- [ ] **Rung 2 (only if AC1's measurement fires):** the boundary drain point ships in the drain-only
      variant; `SteeringDirectiveSchema` gains no member; the walk never blocks (AC3); INV-RES-4 holds
      (AC4).
- [ ] **Never:** `PhaseStatus` gains no third member; the journal gains no attempt column;
      `approval-gate.ts` / `approvers.ts` / `push.ts` / the record's approval block gain zero changed
      lines; no second in-box marker is polled by the host.

## Open measurements (UNVERIFIED — do not cite these as facts)

1. exe.dev's current box-hour list rate. The $0.23/h used above is the value our own live e2e config
   carried, and `quota.ts:41` marks the vendor figures single-origin `[VERIFY]`.
2. Whether OpenRouter provisioned keys carry any server-side expiry. `createKey` sends only
   `{name, limit}` (`credentials.ts:898-918`); "the key survives an arbitrarily long pause" follows from
   our request shape, not from a measured provider guarantee.
3. AC1's number — how late attached guidance actually arrives — is unmeasurable until DF1.11 has run on
   real boxes. Every claim in this story about steering *latency* is a reading of `steering.ts:87` and
   its three call sites, not an observation of operators being hurt by it.
4. Whether any operator has ever wanted a *blocking* mid-walk decision, as opposed to mid-walk
   *context*. The distinction decides rung 2 variant (i) vs (ii) and is currently unknown.

## Dev Agent Record

<!-- Empty placeholder — this story is PROPOSED and recommends against its own headline feature. -->
