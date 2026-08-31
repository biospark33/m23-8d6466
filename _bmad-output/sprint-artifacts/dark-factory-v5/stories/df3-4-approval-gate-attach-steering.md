# DF3.4: Tier-1 Pre-PR Approval Gate + `attach` Steering

**Story Points:** 6
**Sprint:** v5-S2 (fleet band)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §5.1 tier 1, §5.3, §6 items 4/6
- Decision register: v5 §4 **D4** (tier-2 resident agent + mid-run steering), **D8** (host-side PR,
  no push credential in a box)
- Contracts: v5 §5.2 observability (requestId propagation, per-phase sub-timings)
- Ancestry: **P1.10 RE-DERIVE** — surviving clauses extracted verbatim in R2 §5
- Derivation decisions: `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md`
  **DD-1** (operator-CLI-only channel for v5.0), **DD-8** (NET-NEW material authored fresh)
- Binding facts: R5 §6 facts **15** (in-box evidence is claims, not proof), **17** (host-side PR)

## User Story

As the factory operator,
I want a run to stop dead after its bundle is verified out-of-box and wait for my explicit,
attributable approval before a PR is opened — and a way to steer a live run before it gets there,
so that the only thing standing between a green bundle and a public PR is a named human.

## Overview

`requestApproval(runId, { proposal, reportId, headSha })` is the last host-side call before DF5.2's
PR creation. It registers an `extensions.approval` namespace into the RunRecord **first**
(O_EXCL-style registration under DF2.1's allow-listed extensions model), **then** tears the box
down (spend captured, key revoked, box destroyed) so the pause costs nothing. Approval state lives
in `runRecord.extensions.approval.{ state, proposal, reportId, headSha, approverId?, decidedAt?,
reason? }` — a schemaVersioned namespace registered by DF3.4, writable after `closeAt` is set
(R2's extensions discipline). The intent is on disk before the irreversible step, so a crash
mid-teardown leaves a recoverable approval namespace pointing at the harvested bundle. The
operator decides with `fleet approve` / `fleet reject`, authenticated against a hashed approver
allowlist stored at `.factory/approvers.json`. `fleet attach` is the separate, earlier surface:
a steering message to the tier-2 resident agent (DF3.3) mid-run. DF5.2 reads the approval
extension; DF5.3 links it into the audit chain.

## E2E Slice

**Demonstrable behavior:** Given a harvested, host-side-re-verified run whose RunRecord already exists
with `closedAt` set, When `requestApproval(runId, { proposal, reportId, headSha })` fires, it
atomically registers the `extensions.approval` namespace with `state: "pausing"` and the bundle
path (DF2.1's PID-based lock guards the read-register-write) → runs teardown
(`teardownSandbox(runId, { noHarvest: true })` per DF2.5, `revokeAndVerify(keyHash)` per DF2.3)
→ promotes the extension to `state: "awaiting-approval"` → surfaces the pending decision in
`fleet status` → blocks every downstream irreversible step; When the operator runs
`fleet approve <run-id> --approver steve` with the token piped on stdin, the extension closes
`{ state: "approved", approverId: "steve", decidedAt, reason }`, `awaitDecision` resolves
`approve`, and a second `fleet reject` prints the **first** decision and changes nothing.

**Wiring closed:** On completion of this story, a run pauses before its irreversible action,
survives a host restart while paused, and is approved or rejected by an authenticated operator
using only code merged by this story plus DF3.1's CLI chassis, DF3.3's resident agent, DF2.1's
driver port (the `exec`/`copyFile` calls the steering transport rides on), and DF2.5/DF2.3's
teardown-at-pause. No stub, no `TODO: wire later`. The **caller** that fires `requestApproval` on a
green re-verify is **DF5.1's** (single owner — see Trigger Surface); this story ships the gate, its
CLI, and the transport, all directly exercisable. DF5.2 consumes the approval record.

**Dependency edges (predecessors):** DF2.1, DF2.3, DF2.5, DF3.1, DF3.3.

**Not an edge — DF5.1 (XC-P1-18):** the AC1 "host re-verify green" precondition is satisfied in this
story's tests by a fixture ReverifyReport; the live caller is DF5.1, which lands **after** this story
and holds the edge in that direction.

## Acceptance Criteria

1. **(make-or-break — intent extension first, then teardown)** Given a run whose bundle is harvested
   and whose host-side re-verify is green, When
   `requestApproval(runId, { proposal, reportId, headSha })` is called, Then the order is:
   <br />**(a)** on the **first** call for this runId, the RunRecord is loaded through the store's locked update path (DF2.1's public patch API, which takes the per-record PID lock internally) and the `extensions.approval` namespace is registered with
   `schemaVersion: 1`, `state: "pausing"`, carrying `proposal`, `requestId`, `expiresAt`, the
   harvested `bundlePath`, **`reportId`** (the DF5.1 ReverifyReport this decision is bound to) and
   **`headSha`** (the 40-hex sha that report verified) — both **required**, both written at
   `requestApproval` time, so DF5.2 can bind the PR to the exact artifact approved rather than to
   whatever was approved most recently; a call missing either is a schema rejection, not a defaulted
   field, and no namespace is registered. The registration is an extensions-carrying record patch (`RunRecordPatch.extensions`), validated against the `EXTENSION_NAMESPACES` allow-list by DF2.1's `validateExtensions` and applied atomically under the record's PID lock — failing closed for undeclared namespaces.
   <br />**(a2) (re-entry — rebind, refuse, or leave alone; reciprocal of df5-1 AC6).** Given an
   `extensions.approval` already registered for this runId, When `requestApproval` is called
   again, Then the outcome is decided by the state read from the extension under the same
   per-record lock: **`awaiting-approval`** ⇒ the extension is **rebound** by atomic replace under
   that lock — the new `reportId` and `headSha` overwrite the bound pair, the displaced id is
   appended to `supersededReportIds: string[]` (ordered oldest-first), and the state stays
   `awaiting-approval`. The rebind call **also carries the new report's `bundlePath`**, and it is
   validated against the extension's existing `bundlePath` before the replace commits: equal ⇒ the
   field is written unchanged; unequal ⇒ the rebind is refused as a schema/consistency rejection
   (this run has one harvested bundle; a report naming a different one is bound to the wrong run)
   and the record is left byte-identical, same as the terminal and `pausing` branches below.
   **`pausing`** ⇒ no write and no rebind, the record is left exactly as found (DF5.1 flags
   `approval-pause-in-progress`; DF3.4's own resume path is what completes the promotion).
   **`approved`|`rejected`|`timed-out`** (terminal) ⇒ **no write at all** and the recorded decision is
   returned to the caller, which is what lets DF5.1 report `flags: ["approval-already-decided"]`
   without a second read. The **race rule** is single-sided: a rebind observing a terminal state
   **loses** — it never resurrects a decided record — and `submitDecision` compare-and-sets on the
   `reportId` it read, so a decision racing a rebind either lands against the pair it saw or is
   retried against the rebound pair, never recorded against a report it never saw.
   <br />**(b)** teardown then runs *if this caller owns one*: `teardownSandbox(runId, { noHarvest: true })`
   (DF2.5 — bundle already harvested, so `noHarvest` skips the second fetch) — spend captured, key
   revoked and revocation-verified, box destroyed per INV-APPROVE-6.
   <br />**AMENDED, DF3.4 deferred item D8 (Session D).** As originally written, (b) made the gate the
   OWNER of teardown, and that is not where teardown lives on any shipped path. `requestApproval` has
   exactly ONE non-test caller in the repo — `src/reverify/runner.ts`, which builds its port as
   `recordApprovalPort(store)` with no teardown seam — and reverify is host-side out-of-box
   re-verification that runs **after** DF2.5 has already torn the box down. So the box is gone and
   `closedAt` is set before the gate is ever entered, and the three-step ordering this AC specifies is
   **vacuous in production**: there is nothing left to tear down at (b).
   <br />The gate's real obligation is therefore stated as what it now enforces: **REFUSE to promote a
   run that still owns a box when no teardown seam was supplied** (see INV-APPROVE-6). That guard is
   kept regardless — it costs nothing on the shipped path and is the only thing standing between a
   FUTURE caller that does hold a box and the original hole. The (b) step remains specified for such a
   caller; it is simply not exercised by the one that ships today.
   <br />Verified live, TIER-1, zero model spend: real box → real `fleet teardown` (full DF2.5 chain)
   → the shipped port entered with `closedAt` set and the box absent from `driver.list()`, promoting
   with **no** `teardown_at_pause_ms` on the `pause` event — the machine-checkable form of "no teardown
   happened at the gate". The synthetic caller that DOES pass a seam measures it at 8454 ms (T1.7),
   which is what makes the absence a signal rather than a silent emitter.
   <br />**(c)** and only after teardown returns is the extension promoted, by atomic replace under the
   same lock, to `state: "awaiting-approval"` — the state a decision may be submitted against.
   <br />The approval state is written **before** the irreversible step, not after, because the
   evidence must outlive the failure it records: a crash between (a) and (c) leaves a `pausing`
   extension naming the run, its bundle and its bound report — recoverable and auditable — where a
   teardown-first order would leave a destroyed box, a revoked key and nothing on disk to say a run
   had ever reached the gate. A `pausing` extension found at startup is resumed by re-running
   teardown (idempotent under DF2.5), then promoting; it is **never** decidable while `pausing`, so
   the evidence-first write opens no approval path around teardown. And **no further phases execute
   until a decision is received** (P1.10 AC1, re-aimed from `decide` to the PR). No PR is opened,
   no branch is pushed, no ref outside `refs/sandbox/<run-id>` is written.
   *Negative control: an implementation that tears the box down before registering the extension
   loses the run entirely when killed mid-teardown, passes a happy-path pause test, and MUST fail
   this one.*
2. Given a run in `awaiting-approval`, When an allowlisted approver runs `fleet approve` or
   `fleet reject` with a valid token, Then the record closes `approved`/`rejected` with
   `approverId`, `decidedAt` and `reason` logged, `awaitDecision` resolves, and no further phases
   execute — there is no path from `rejected` to a PR. Given a duplicate or contradicting second
   decision, Then the **first** decision is returned with no state change (P1.10 decision
   idempotency). *Negative control: a last-write-wins implementation satisfies the first sentence
   and MUST fail the second.*
3. Given the host process is killed while a run is paused, When any `fleet` verb next runs, Then
   the RunRecord is reloaded from `.sandbox/runs/<runId>.json` with its `extensions.approval`
   namespace intact and the run is still decidable (NET-NEW per DD-8, authored against design
   §5.3 — the pause now outlives its process because it outlives its box); an extension in
   `pausing` is **not** decidable and is resumed per AC1 (teardown re-run via `teardownSandbox`,
   then promoted). Given no decision within the policy timeout (default 24h), Then the extension
   closes `timed-out` with `approverId: "system:timeout"` — the fixed system actor reserved for timeout
   attribution, never a real approver — a timeout event is logged, and the run stops there.
   `timed-out` is **terminal and immutable, exactly like `rejected`** — the box is already gone, so
   nothing remains to abort; there is no path from `timed-out` to a PR, to a re-request, or to
   `approved`, and no code path reaches `approved` without an approval extension. ("Auto-ABORT"
   named a running process that no longer exists at this point; the terminal extension **is** the
   abort.)
4. Given a decision from an approver absent from the allowlist or with a non-matching token hash,
   Then it is refused with **no state change** and logged as a security event (P1.10 INV-POLICY-4);
   given a missing, unreadable, or wider-than-`0600` allowlist, Then **every** decision is refused
   likewise (fail-closed is NET-NEW per DD-8). *An empty allowlist refuses all, never "allow all".*
5. Given a run in a live phase, When `fleet attach <run-id> --message -` is issued, Then the
   message reaches the tier-2 resident agent and is acked carrying the run's `requestId`; given a
   run in `pausing` or `awaiting-approval` (box gone or going), Then attach is refused
   `run-not-attachable`, extension unmutated.
6. **(transport is real, not doubled)** Given a live box under the `fake` driver running DF1.1's
   engine with a DF3.3 resident, When `fleet attach` is issued mid-phase, Then the message lands in
   `/run/steering/inbox.ndjson` via `driver.exec(vm, ["sh", "-c", "cat >> /run/steering/inbox.ndjson"],
   JSON.stringify(line) + "\n", stdin)` — the NDJSON payload travels **only** through the `stdin`
   argument, never interpolated into `argv` — is drained at the **next** of DF3.3's three
   solicitation points (never at a fourth), appears in that solicitation's prompt context, and
   produces an `/run/steering/acks.ndjson` line the host observes via `driver.copyFile(vm,
   "/run/steering/acks.ndjson", <host tmp>)` and returns as `attach-acked`. Re-issuing the same
   `messageId` delivers **once**. Given the engine never reaches another solicitation point within
   30_000 ms, Then the host returns `attach-not-acked` and the message stays queued — neither
   dropped nor re-sent. *Negative control: a test that asserts only against DF3.3's channel
   double never exercises `driver.exec`/`driver.copyFile` and MUST NOT be the sole evidence for this
   AC.*
7. **(paused runs are visible)** Given runs with `extensions.approval` in `pausing` or
   `awaiting-approval`, When `fleet status` runs, Then `.sandbox/runs/<runId>.json` is scanned for
   the approval extension alongside DF3.1's run-record assembly and the driver's own box list — and
   each paused run appears with its state, its bound `reportId`, and time remaining before
   `expiresAt`. Expiry is swept in the same pass (AC3). A run whose box is gone because it is
   paused reports `awaiting-approval`, never `boxMissing`: an approval extension present for that
   runId is what distinguishes an intentional pause from a lost box.

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `fleet approve <run-id>` CLI | in-scope | `tests/fleet/approval-gate.test.ts` | — |
| `fleet reject <run-id>` CLI | in-scope | `tests/fleet/approval-gate.test.ts` | — |
| `fleet attach <run-id>` CLI | in-scope | `tests/fleet/attach.test.ts` | — |
| `fleet status` listing paused runs + expiry sweep | in-scope | `tests/fleet/approval-gate.test.ts` | — |
| `requestApproval(runId, { proposal, reportId, headSha })` **function** — exported, schema-closed, directly invoked | in-scope | `tests/fleet/approval-gate.test.ts` | — |
| The **caller** that fires `requestApproval(runId, { proposal, reportId, headSha })` on a green host-side re-verify | out-of-scope — **DF5.1 owns exactly one caller**; this story exports the entry point and never wires a second trigger | — | DF5.1 |
| PR creation reading a closed `approved` record | out-of-scope | — | DF5.2 |
| Approval events joined into the audit chain | out-of-scope | — | DF5.3 |
| Chat/webhook approval intake (callback URL) | out-of-scope | — | none in v5.0 — **DD-1** decides operator-CLI-only; re-enters at a future vX derivation |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| Approval state | RunRecord `extensions.approval` namespace (DF2.1 extensions model) | `extensions.approval` registered under `EXTENSION_NAMESPACES` allow-list with `schemaVersion: 1`; writable after `closeAt` set (DF2.1 R2) |
| Approver allowlist | host config `.factory/approvers.json`, mode `0600`, host-only | preflight reads it before any decision is accepted; absent/loose ⇒ every decision refused (AC4) |
| Fleet dispatcher CLI | `scripts/fleet.ts` (DF3.1) | `fleet --help` lists `approve`, `reject`, `attach`; verbs resolve through DF3.1's registry |
| Resident-agent steering channel | tier-2 agent inside the run's box (DF3.3); transport rides DF2.1's `driver.exec` (append inbox line via stdin) and `driver.copyFile` (read ack back to host) onto `/run/steering/{inbox,acks}.ndjson` — DF2.1's port defines no `observe` method, so host-side observation is a composition of those two verbs, owned here | attach round-trip acked with the run's `requestId` against a **live** `fake`-driver box (AC6); DF3.3's channel double covers unit cases only |
| Teardown | `teardownSandbox(runId, { noHarvest: true })` (DF2.5) + `revokeAndVerify(keyHash)` (DF2.3), invoked at pause **after** the `pausing` extension is registered | pause test asserts the `pausing` extension is registered first, then spend captured, key revoked, box destroyed, and only then the extension reports `awaiting-approval` |

## Technical Notes

- **The gate relocates.** P1.10 paused the run process at the `decide` phase. v5 pushes host-side
  after bundle harvest and out-of-box re-verify (D8/F10), so the pause point is tier-1, pre-PR, and
  the *run process no longer brokers it*. Mid-run steering is the separate `attach` surface (D4).
  Both halves live here; they share no state. The gate is per-run under fan-out: each arm reaching a green re-verify pauses at its own `extensions.approval` independently, race losers are torn down by DF3.2 (its AC5) and never reach this gate, and approving one arm decides nothing about its siblings — there is no fan-out-level approval in v5.0.
- **Pause is free because the box dies at pause.** The 24h default was expensive under the old model
  (a paused run held a live capped key and a running VM for a day). Here teardown runs *at* pause,
  with `noHarvest: true` — the bundle was already harvested before the host-side re-verify that
  produced this decision's report, so DF2.5's harvest step would be a second fetch of the same refs;
  every other step of its fixed order runs unchanged. PR creation is host-side from
  `refs/sandbox/<run-id>` and needs nothing from the box (D8, R5 §6 fact 17), so §5.3's listing of
  teardown after the PR is narrative order, not a data dependency. Resume re-provisions nothing, so
  the 24h default survives unchanged.
- **Contracts/Schema:** new, owned here. Approval state lives in `RunRecord.extensions.approval`,
  an extensions-carrying record patch (`RunRecordPatch.extensions`), validated against the `EXTENSION_NAMESPACES` allow-list by DF2.1's `validateExtensions` and applied atomically under the record's PID lock. Schema:
  `{ state: "pausing"|"awaiting-approval"|"approved"|"rejected"|"timed-out", proposal,
  reportId, headSha, supersededReportIds: string[], bundlePath, requestId, expiresAt,
  approverId?, decidedAt?, reason? }`. `reportId` (`:= ReverifyReport.reverifyId`, DF5.1's report
  identity) and `headSha` are **required** and written at `requestApproval`; `supersededReportIds`
  defaults to `[]` at registration and each AC1(a2) rebind appends the displaced id, so the extension
  carries its own rebind history for DF5.3's audit chain. `bundlePath` is written once at
  registration and re-validated on every AC1(a2) rebind — a mismatch refuses the rebind. The
  RunRecord itself carries the twelve core fields (R2); `extensions.approval` is appendable after
  `closeAt` is set, per DF2.1's extensions discipline. State transitions use DF2.1's per-record
  PID lock (atomic replace guarded by the lock) so first-decision-wins holds. A rebind is a
  transition like any other: it takes the lock, compare-and-sets on the state it read, and loses to
  a terminal state. `submitDecision` compare-and-sets on **both** state and `reportId`, so a
  decision and a rebind cannot interleave into a decision attributed to a report the approver
  never saw — the loser re-reads and is answered by the winner's record.
- **The attach transport, named — this story owns it end to end.** Host→in-box steering has no other
  owner, so it is specified here rather than assumed: `fleet attach` appends one NDJSON line
  `{ messageId, requestId, runId, message, sentAt }` to `/run/steering/inbox.ndjson` **inside the box**
  via DF2.1's `driver.exec(vm, ["sh", "-c", "cat >> /run/steering/inbox.ndjson"], stdin:
  JSON.stringify(line) + "\n")` — the same port the setup gate uses, never `ssh` and never a second
  channel. The NDJSON payload travels **only** through the `stdin` argument, never interpolated
  into `argv`, so `message`, `requestId` and `messageId` — none of them sanitized — cannot break
  out of the command regardless of quotes, shell metacharacters, or embedded newlines; `cat`
  writes stdin verbatim and parses nothing. The engine's solicitation port
  (`src/phase-engine/steering.ts`, shared with DF3.3) **drains** the inbox at exactly DF3.3's three
  solicitation points, folds each drained message into that solicitation's prompt context as
  guidance text, and appends `{ messageId, ackedAt, point }` to `/run/steering/acks.ndjson`. `fleet
  attach` polls for that ack the only way DF2.1's port allows — there is **no** `driver.observe`
  method: a `driver.exec` probe for the ack line, then `driver.copyFile(vm,
  "/run/steering/acks.ndjson", <host tmp>)` to read it — and returns `attach-acked` with the run's
  `requestId`; **30_000 ms** without an ack returns `attach-not-acked` — a reported outcome, never
  a silent success, and never a retry that could double-deliver (`messageId` is the dedupe key
  on drain). Both paths are mode `0600`, owned by the in-box agent user, and carry no credential
  material. Adding no fourth solicitation point is what keeps DF3.3's containment argument intact
  (INV-APPROVE-5).
- **Approver authentication (hashed allowlist):** `.factory/approvers.json` maps `approverId` → a
  salted hash of the approver's token, re-read per decision so a rotated or removed entry takes
  effect immediately.
  Token read from **stdin, never argv** (DF2.3 INV-CRED-3), constant-time compared, never logged.
- **Guards/limits:** default policy timeout 24h, configurable per run, floor 60s; expiry is
  evaluated lazily on every `fleet` invocation — no daemon — and **before** that invocation's own
  decision, so a decision arriving after `expiresAt` finds `timed-out` and is refused. `proposal`
  caps at 8_000 chars **including** any `[truncated, N chars total]` suffix; `reason` at 1_000;
  attach at 4_000, also subject to DF3.6's bound, which the gate consumes rather than re-implements.
- **Deviation/assumption:** the tier-1 operator CLI is the only notification and decision channel
  (DD-1) — no callback URL, no webhook, no chat intake; a paused run is discovered by running
  `fleet status`. If too passive, add a notifier reading the same records — never a second path.

## Observability Contract

- Every gate event logs `{ requestId, runId, event, state, approverId?, durationMs, outcome }` —
  `event ∈ pause | approve | reject | timeout | refused | attach`. The token never appears.
- `requestId` propagates from the dispatch that created the run (DF3.1) onto the record and every
  event, so DF5.3 joins approvals without a second key; errors carry `{ code, message, remediation }`.
- Sub-timings: `teardown_at_pause_ms`, `record_write_ms`, `decision_wait_ms`, `attach_rtt_ms`.

## Files to Modify

- `src/fleet/approval-gate.ts`
- `src/fleet/approvers.ts`
- `src/fleet/attach.ts`
- `src/fleet/index.ts`
- `src/fleet/status.ts` (authored by DF3.1; this story **adds only** the approval-extension join over `.sandbox/runs/`
  and the lazy expiry sweep to the existing status assembly — AC7 — and changes no DF3.1-owned line)
- `src/phase-engine/steering.ts` (shared, three-way, all in v5-S2 — **DF3.3 authors** the port and
  its three solicitation points, **DF3.4** (this story) rebases onto it and **adds only** the inbox
  drain + ack append at those same three points, and **DF3.6 rebases last**, wrapping the existing
  call sites in its `checkBounds(point)` guard. No fourth point, and no edit to a DF3.3-owned line.
  Mirrored in df3-3's Technical Notes and df3-6's Files list)
- `src/fleet/verbs.ts` (authored by DF3.1 under its AC6; this story **adds only** its own
  `approve`/`reject`/`attach` registry entries and edits no DF3.1- or DF3.2-owned entry)
- `scripts/fleet.ts`
- `tests/fleet/approval-gate.test.ts`
- `tests/fleet/attach.test.ts`
- `tests/fleet/fixtures/approvers.json`

## Security Invariants

- **INV-APPROVE-1 (no bypass, no auto-resume):** a run paused for approval cannot be resumed by any
  mechanism other than a valid approve decision — no bypass, no auto-resume (P1.10 INV-POLICY-2,
  verbatim). Timeout and reject are terminal aborts, never resumptions.
- **INV-APPROVE-2 (authorization, hashed allowlist):** only approvers present in `.factory/approvers.json`,
  presenting a token whose hash matches, may submit a decision (P1.10 INV-POLICY-1, re-aimed from "the
  run's assigned agent list" to the operator allowlist per DD-1). An unknown `runId` or unauthorized
  `approverId` is rejected with no state change and logged as a security event (P1.10 INV-POLICY-4).
- **INV-APPROVE-3 (fail-closed authorization):** if the allowlist is absent, unparseable, or its
  mode is wider than `0600`, **every** decision is refused (R3 FAIL-CLOSED DISCIPLINE). An empty
  allowlist authorizes nobody; the control never degrades to "allow all" or to "allow local user".
- **INV-APPROVE-4 (attribution is append-only):** every decision — approve, reject, timeout — is
  logged with `approverId`, `timestamp`, `reason`, `runId` and `requestId` (P1.10 INV-POLICY-3).
  `approverId` is a real allowlisted actor for `approved`/`rejected` and the fixed reserved value
  `system:timeout` for `timed-out` (AC3) — never absent, since `extensions.approval.approverId` is
  optional only until a decision closes the extension. Terminal extensions are immutable and feed
  DF5.3's chain unmodified.
- **INV-APPROVE-5 (steering carries no privilege):** an `attach` message is **guidance text only**
  (DF3.3's directive rule): it can never approve, reject, skip or reorder a gate, and never raises a
  spend ceiling or steering-iteration bound — DF3.6's bounds are immutable mid-run, so attach grants
  no privilege and needs none beyond host-local CLI access. Approval travels tier-1 → host-side gate
  only, never through the resident agent (R5 §6 fact 15; D4 tripwire (b) catches a reordered gate).
- **INV-APPROVE-6 (credential containment at pause):** no run is **decidable** while it still holds a
  live credential. The `pausing` extension is registered first — it is evidence, not authority, and
  no decision may be submitted against it — then spend is captured via `captureSpend`, the run key
  revoked via `revokeAndVerify`, and the box destroyed via `teardownSandbox`; only after all three does
  the extension become `awaiting-approval`.
  <br />**AMENDED, D8 (Session D):** on the shipped path DF2.5 performs all three BEFORE the gate is
  entered, so what the gate enforces is the invariant's *contrapositive*: it **refuses to promote** an
  OPEN record that still names a `vmName` when no teardown seam was given, rather than no-opping past a
  teardown that was owed. The invariant is unchanged — a decidable run never coexists with a live key
  or a live box — only the claim about WHICH component discharges it is corrected. So the state a decision can be submitted against never
  coexists with a live key or a live box, while the write that precedes teardown makes a crash
  mid-teardown recoverable instead of silent. The approver token is host-only, arrives on stdin,
  and never reaches a record, a log, or argv.
- **INV-APPROVE-7 (assertNoSecret parity):** the approval extension never carries key material.
  `assertNoSecret` checks run-record reads; approvals read only the extension, never the core fields
  that hold `keyHash` (R2's extensions discipline).
- **INV-APPROVE-8 (fail-closed reads):** malformed or unparseable approval extensions are refused with a
  typed error rather than defaulted (R3 FAIL-CLOSED DISCIPLINE). A `pausing` extension found at
  startup is validated before resume; schema failures surface as errors, never silent corruption.
- **INV-APPROVE-9 (fs.writeSync on exit):** `fleet approve`/`fleet reject` CLI exit paths use
  `fs.writeSync(2, ...)` or `process.stderr.writeSync` to guarantee approval output flushes before
  `process.exit` (R3 FS.WRITESYNC ON PROCESS-EXIT PATHS). Async writes are truncated when stderr is a
  pipe.

## Definition of Done

- [ ] **Impl:** `requestApproval`/`submitDecision`/`awaitDecision`/`sweepExpired` exported from
      `src/fleet/approval-gate.ts` using DF2.1's per-record lock; `fleet approve`/`reject`/`attach`
      verbs registered; `fleet status` lists paused runs.
- [ ] **Contract:** `extensions.approval` namespace registered under `EXTENSION_NAMESPACES`
      allow-list (`schemaVersion: 1`, `reportId`/`headSha` required); `approve`/`reject`/`attach`
      verbs registered in DF3.1's `src/fleet/verbs.ts` registry.
- [ ] **Integration:** teardown invoked as `teardownSandbox(runId, { noHarvest: true })` (DF2.5) +
      `revokeAndVerify(keyHash)` (DF2.3) after extension registration; attach delivers through
      DF3.3's steering channel.
- [ ] **Security:** decisions gated on hashed allowlist (`.factory/approvers.json`, mode `0600`),
      token from stdin; unknown approver or missing/loose allowlist refuses with no state change
      (INV-APPROVE-2/3/8).
- [ ] **Test (pause mechanics, AC1/INV-APPROVE-6):** call-order capture asserts extension
      registered `pausing` → `teardownSandbox` → `revokeAndVerify` → promoted `awaiting-approval`;
      crash between registration and teardown leaves extension recoverable; rebind against terminal
      state refuses; `bundlePath` mismatch refuses; teardown-before-extension MUST fail.
- [ ] **Test (attach transport, AC6):** message with quotes/backticks/`$(...)`/`;/newline round-trips
      via `stdin` only; fake driver asserting on `argv` fails if any token appears there; live `fake`
      driver box round-trips with `requestId`, acks at next DF3.3 solicitation, delivers once; 30_000 ms
      timeout returns `attach-not-acked`.
- [ ] **Test (state machine):** terminal-state transitions rejected; duplicate `approve` and
      `reject-after-approve` return first decision with no change; concurrent decision → exactly one
      wins; paused extension survives restart; expired sweeps to `timed-out`, never `approved`.
- [ ] **Test (rebind vs decision race, AC1(a2)):** concurrent rebind and `submitDecision` → either
      lands against pair read; loser re-reads and answered correctly; no finish with decision
      against `reportId` absent from both `reportId` and `supersededReportIds`.
- [ ] **Test (status join, AC7):** `fleet status` lists paused runs from approval extension with
      state, `reportId`, time remaining; paused run with box gone reports `awaiting-approval`, never
      `boxMissing`.
- [ ] **Test (e2e demo — MANDATORY):** one scripted run pauses, approved by allowlisted operator
      over stdin, leaves `extensions.approval` carrying `approved` + `approverId` + `decidedAt` — DF5.2
      gates the PR on this.

## Dev Agent Record

### Deviations from the story spec

Nine. Each is a place where the spec, read literally, is wrong about the code it names — not a
convenience. Evidence is code, not reasoning.

| # | What the story says | What we built | Evidence |
|---|---------------------|---------------|----------|
| 1 | **Lock.** Technical Notes (:213-214) and AC1(a2) (:80-83): state transitions take "DF2.1's per-record PID lock". | `withApprovalLock` (`src/reverify/approval.ts:87-174`), held across the state transition **only**, never across teardown. | That lock is `private withLock` inside `RunRecordStore` (`run-record.ts:1396`), taken *internally* by `set()` — so it cannot span a caller's read-then-write, and DF5.1 Deviation 4 records that taking it externally deadlocks. It also blocks the event loop via `Atomics.wait` (`run-record.ts:1986`) for up to `LOCK_TIMEOUT_MS` 5_000. AC1(a) already states the accurate version ("the store's public patch API, which takes the per-record PID lock internally"); AC1(a2) does not. Corollary the story misses: teardown is seconds-to-minutes, so the lock must not wrap it. |
| 2 | **Redundant revoke.** AC1(b) (:97-99) and INV-APPROVE-6 (:301-308) mandate a `revokeAndVerify(keyHash)` call after `teardownSandbox` — and disagree with each other about its position. | No separate call. `teardownSandbox` is consumed as-is. | `teardown.ts:423-438` already runs revoke (step 4) then verify (step 5) inside its fixed order. A second call converts a provider-list hiccup into a hard failure of an already-successful pause. `src/providers/teardown.ts` has four claimants (DF2.5/DF4.2/DF2.8/DF5.3) and DF3.4 is not one — zero edits. |
| 3 | **`teardownSandbox` signature.** Spelled `teardownSandbox(runId, { noHarvest: true })` at :45, :97, :185, :328. | `teardownSandbox(deps, runId, { noHarvest: true })`. | Real signature is `teardownSandbox(deps: TeardownDeps, runId: string, opts: TeardownOptions = {})` — `teardown.ts:284`. The `noHarvest` option is honoured at `:367` and `:411`. |
| 4 | **Ack transport.** AC6 (:148-149) and Technical Notes (:229-231) mandate `driver.copyFile(vm, "/run/steering/acks.ndjson", <host tmp>)`. | `driver.exec(vm, ["sh","-c", "cat <quoted path>"])`. Both attach legs are now `exec`: append via stdin, ack via `cat`. | `copyFile` **refuses absolute paths on both drivers** — `assertBoxPathSafe` (`src/providers/exedev/driver.ts:604-614`) rejects any path with a leading `/` as `remote-path-invalid`, and the fake driver mirrors the guard. This exact bug already burned fan-out in production: `fanout-primitive.ts:688-696` carries the dated live measurement `fan-20260826-f04c3c` — "a copyFile read died `remote-path-invalid` on every tick and the race spun to its ceiling". `exec`+`cat` is the repo's own adopted fix. A one-verb spec correction; no driver path-safety surface changes. |
| 5 | **Ack placement.** AC6 (:146-149) implies the ack lands on the accepted path. | Ack at **drain time** (in a `finally`), not at the `steering.ts:429` seam. | The `:429` seam sits after every early return — degraded `:338`, render fail `:354`, call fail `:369`, malformed `:386`, schema reject `:393`, allowlist/roster `:401`/`:410`/`:419` — each of which returns PROCEED without reaching it. A message that *was* drained and folded into prompt context would go un-acked and attach would wrongly report `attach-not-acked`. AC6 defines the ack as the message "appear[ing] in that solicitation's prompt context", not as directive acceptance, so drain-time is what the spec text actually says. |
| 6 | **Char ceiling attribution.** :245 attributes the 4_000-char attach bound to "DF3.6's bound, which the gate consumes rather than re-implements". | Import `DIRECTIVE_TEXT_CHAR_CEILING` (= 4_000) from DF3.3's `steering.ts:33`. | Misattribution. DF3.6 defines exactly three bounds (df3-6 `:140-143`: `maxSteeringIterations` 8/phase, `residentRssBytes` 512MiB, `residentSpendCeilingMicros` 2e6) and none is a char cap; its only attach mention (`:123`) delegates *to* DF3.4. The constant is DF3.3-owned, already exported, and its docstring rationale is verbatim the attach case. Recorded so the misattribution does not propagate. |
| 7 | **`supersededReportIds` justification.** :206-208 says the history is carried "for DF5.3's audit chain". | Full ordered array built — but on DF3.4's own authority, not DF5.3's. | DF5.3's hop table (`df5-3-audit-chain-extended.md:120`) carries hop 8 as `run → approval \| approver id, decision, decidedAt` — and the whole story has **zero** matches for `superseded`, `rebind`, `reportId` or `reverifyId`. The binding requirement is DF3.4's **own DoD** at `:345-347`: "no finish with decision against `reportId` absent from both `reportId` and `supersededReportIds`" — which a singular field cannot satisfy after two rebinds. Consequence recorded honestly: **nobody downstream is blocked** if the array had slipped to a follow-up. |
| 8 | **`bundlePath`.** AC1(a2) (:84-88) requires the rebind to carry the new report's `bundlePath` and validate it against the stored one, refusing on mismatch; Technical Notes (:209-210) require it written at registration. | **Not stored at all** — no field, no `SHAPE_EXEMPT_PATHS` entry. First request AND rebind re-validate by `existsSync(<runsDir>/<runId>.bundle)` (`assertBundlePresent`), wired on the production path: `runner.ts` builds the port as `recordApprovalPort(store, { bundleDir: runsDir })`. | Three reasons, any one sufficient. (a) DF2.5 already made this call oppositely and explicitly — `harvest.ts:18-19`: "Harvest writes NOTHING to the run record: the bundle's presence at `<runsDir>/<run-id>.bundle` is the record, and DF2.1's schema stays closed." Registering it reverses a stated invariant of a story DF3.4 does not own. (b) **The comparison is vacuous**: `harvest.ts:435-436` is `join(runsDir, runId + ".bundle")` with no `path.resolve` in the chain, so for a given run the value is identical by construction and "unequal ⇒ refuse" can never fire on a real mismatch — while the one case it *can* fire is a false positive (move `QDS_RUNS_DIR` and a legitimately relocated bundle is refused). (c) A host-absolute path in a DF5.3 audit artifact leaks the operator username and local directory layout and is meaningless on another host. The existence check is strictly stronger: it proves the bundle is there *now*. As shipped at first review the guard was INERT — `assertBundlePresent` early-returns when `deps.bundleDir` is undefined and no caller passed it; PR #150 (round 7) wired it through `recordApprovalPort` at `src/reverify/runner.ts`, sourcing the path from harvest's own invariant (`harvest.ts:435-436`), with remove-the-bundle ⇒ refusal pinned at both levels (`tests/reverify/approval.test.ts`, `tests/reverify/runner.test.ts`). Recorded in the namespace docstring at `run-record.ts:238-249` and guarded by a test asserting `unknown key: extensions.approval.bundlePath`. |
| 9 | **Expiry sweep.** AC7 (:160) says expiry "is swept in the same pass" as `fleet status`. | Split: expiry is **derived virtually** in `status` (pure read — a run past `expiresAt` displays `timed-out`) and **persisted** in `approve`/`reject`. | `fleet status` builds a read-only store when `--dir` is given (`fleet.ts:2212`, `create: dir === undefined`), and a `create:false` store throws on every write (`run-record.ts:857-871`). A persisting sweep cannot run there, and making `status` writable reintroduces the round-11 chmod-0700 regression. The split still satisfies AC3's actual requirement — "expiry is evaluated lazily on every `fleet` invocation — no daemon — and **before** that invocation's own decision" — because the decision path is exactly where the write is both possible and needed. |

### Guardrail waiver — Scope Enforcement (High), ACCEPTED

**Item.** `StatusRow.state` TS literal union widened at `src/fleet/status.ts:32` to admit
`"awaiting-approval"`. The story says this file "changes no DF3.1-owned line" (:264-265).

**Why unavoidable.** There is no way to add a member to a TypeScript literal union without
editing the union. **Rejected alternative:** carry the state in a new optional field — this fails
AC7 as written, which requires the paused run to *report* `awaiting-approval` and never
`boxMissing`, i.e. in `state` itself.

**Why it is safe.** Purely additive: one union member, no DF3.1 behaviour changed, every existing
state keeps its exact semantics. **Precedent:** the same union already grew to carry the two
fleet-level `(fleet)` rows (`status.ts:4-7`).

### Scope-list gap

`scripts/pipeline-run.ts:1708-1725` is the **one** `createSteering` call site and is where the
`inbox` port must be wired — one added property. It is **absent from this story's Files to Modify
list**. A scope-list gap, not a judgement call; recorded rather than silently expanded.

### Boundary conditions — stated, not coded around

From the AC1(c) resume verification. Both are correct behaviour whose intuitive reading is wrong,
so they are written down instead of guarded against:

- **An unenumerable key list aborts a resume PRE-revoke.** `captureSpend`'s only throw path is
  `truncated` — a transient provider fault that throws identically on a first run. Retryable and
  fail-closed by design; not a re-run artifact.
- **A teardown re-run leaves the FIRST successful capture in the record, not a fresher one.** This
  is the desired semantics, but "re-running teardown refreshes spend" is the intuitive-and-wrong
  reading. An already-revoked key degrades rather than throwing: `entry === null` returns
  `rec.spendMicroUsd ?? 0` and **writes nothing**, because recording 0 "would be an
  authoritative-looking lie" — pinned at `credentials.test.ts:628-637`. Double-counting is
  structurally impossible: `captureSpend` never touches the cost ledger (`cost-ledger.ts:1010-1013`,
  pinned by `cost-ledger.test.ts:626`, whose name is the invariant).

### Documented ceilings, not defects

- **Attach latency during an agent-phase retry.** `post_gate_failure` is code-phase only
  (`pipeline-run.ts:955-1048`); agent phases retry via `agents/retry.ts:284-287` and never solicit,
  so an attach queued during an agent-phase retry waits until `run_end`. Closing it would require
  a **fourth** solicitation point, which DF3.3, DF3.4 and DF3.6 all forbid (INV-APPROVE-5).
- **The ledger prices at most one box per `runId`, ever.** `boxHoursEventId` keys on
  `(runId, closedAt)` (`cost-ledger.ts:285`) with `closedAt` frozen by first-close-wins
  (`run-record.ts:1250-1254`). Correct for today's architecture — one run, one box, enforced by the
  closed-record core-write refusal at `run-record.ts:1239`. A future re-provision story must widen
  the ledger key; **DF3.4 must not, and this spec must not be amended for it.**

### Sprint-level issue — raised, not fixed

DF3.4 and DF3.6 both assume an **in-box engine**. `pipeline-run-remote.ts:5-19` states the
opposite: "the box image carries no bun/node, so `pipeline-run.ts` cannot run in-box … orchestrated
FROM THE HOST. HONEST LABEL: this is NOT the in-box executor (proposed story DF1.10)". Engine,
resident (`resident.ts:446-471`, `Bun.spawn`) and records are all host-side today. **DF3.4 is
unaffected in practice** — a host-side engine plus a `driver.exec` transport is exactly what the
injected-port design assumes — so this is raised for the sprint, not handled here.

### Reference-repo liftability

The operator directive was to lift from the IndyDevDan reference repos. Honest finding: **nothing
rated liftable.** Not one item scored LIFTABLE VERBATIM or WITH ADAPTATION.

- `super-simple-software-factory` has no top-level `adws/` tree, but it is **not** code-free: the
  same Python ADW sources ship under `.claude/skills/sssf/templates/adws/`
  (`adw_build_test.py`, `adw_plan_build_test.py` and siblings), vendored under a skill's
  `templates/` directory. It therefore adds **no new liftable surface** — it is the same code the
  other two repos already carry.
- `sssf-demo` and `inkwell` share one codebase: ~3502 LOC of Python 3 (uv + pydantic). DF3.4 is
  TypeScript on Bun — any lift is a rewrite.
- **No human-in-the-loop.** `ReviewEnvelope.approved` (`data_types.py:118`) is an *LLM reviewer's*
  verdict, decided and consumed in the same phase: no human, no durable awaiting state, no
  re-entry, no supersede, no terminal guard, no timeout, no approver identity.
- No approver allowlist (every `allowlist` hit is a tool-capability or file-write boundary). No
  token hashing (zero hits for `hashed`/`token_hash`/`sha256`/`hmac`). No steering or message
  injection (zero hits for `inbox`/`outbox`/`message_id`/`ack`). No dedupe. No state machine —
  `PhaseStatus` is `queued|running|success|fail`, single-writer single-process.
- **These repos never open a PR.** `grep -rniE "gh pr create|create_pr|open_pr|pull_request|gh pr "`
  over `*.py`/`*.md`/`*.sh` across all three returns **zero** hits. `adw_simple_sdlc.py` commits
  locally on green+approved and never pushes — so "what gates PR creation" has no answer there.
- No unit or integration test suites. The `*_test.py` filenames are misleading: `adw_build_test.py`
  and `adw_plan_build_test.py` are ADW **workflow** scripts — `adw_plan_build_test.py` is "ADW Plan
  Build Test — the full starter chain", whose phases run engineer → planner → builder → code(test)
  → git(commit). "Test" names a pipeline phase there, not the nature of the file.

Three items are concept-only (`tracer.py:103-137` append-only events; `session.py:20-35` SIGTERM
finalization; `gates.py:75-94` verdict self-consistency) and in all three QDS-Factory already has a
stricter, TypeScript, tested precedent — lifting would be a downgrade.

**Provenance.** The PR-creation and human-in-the-loop findings were re-run and verified against the
repos at `/Users/steve/reference-repos`, as was the `super-simple-software-factory` correction
above. The LOC count and the per-file citations (`data_types.py:118`, `adw_simple_sdlc.py`,
`tracer.py`, `session.py`, `gates.py`) remain R6b's findings and are **not** independently
verified. The conclusion — nothing liftable — is unaffected either way.

**The real reuse is in-repo**, and that is where the minimize-net-new directive was pointed:

1. `src/reverify/approval.ts` — port, adapter and the full lock protocol. DF3.4 swaps the **adapter** only.
2. `src/pr/push.ts:257-299` — the six-code refusal matrix, already written against DF3.4's record shape.
3. `tests/pr/helpers.ts:105-125` — `writeAllowlist(host, entries|null, mode=0o600)`, cloned wholesale for `approvers.json`.
4. `src/phase-engine/steering.ts` — closed `.strict()` zod directive union, char ceilings, `MAX_MALFORMED_ATTEMPTS`. The steering *vocabulary* exists; attach needs a **transport**, not a new schema.
5. `tests/fleet/e2e/live-harness.ts` — the complete live demo harness.

---

## Hardening Revision — 2026-08-20

**Revision summary:** Approval mechanics rewritten to match DF2's actual RunRecord extensions model
(`extensions.approval` namespace, PID-based lock, writable-after-close). Approval state lives in
RunRecord extensions, not a separate record file. Teardown signatures corrected to actual DF2.3/DF2.5
exports (`revokeAndVerify`, `teardownSandbox`). Attach transport specified against DF2.1's
`driver.exec`/`driver.copyFile` port. Hashed allowlist fixed to auth surface (`factory/approvers.json`).
DOD trimmed to 10 high-signal items. R3 FAIL-CLOSED and FS.WRITESYNC doctrine encoded.
**Campaign fixes 2026-08-20:** DF3.4-H1, DF3.4-M1, DF3.4-M2, DF3.4-M3, DF3.4-M4.
(`extensions.approval` namespace, PID-based lock, writable-after-close). Approval state lives in
RunRecord extensions, not a separate record file. Teardown signatures corrected to actual DF2.3/DF2.5
exports (`revokeAndVerify`, `teardownSandbox`). Attach transport specified against DF2.1's
`driver.exec`/`driver.copyFile` port. Hashed allowlist fixed to auth surface (`factory/approvers.json`).
DOD trimmed to 10 high-signal items. R3 FAIL-CLOSED and FS.WRITESYNC doctrine encoded.

---

## Review Findings — round 6 (2026-08-28, `bmad-code-review` on PR #150)

10 parallel reviewers (3 blind-adversarial, 3 edge-case, 1 acceptance auditor, 3 test-quality) over 7
chunked diffs. 142 raw findings → 61 unique after dedupe. Fixed in two waves (5 source clusters, then
3 test clusters). Final gate: **4090 pass / 0 fail** (4134 tests, 133 files), `tsc` 0, `biome` clean
across 266 files, `detect_changes` blast radius inside the story's own modules.

### Decisions taken (fail-safe, pre-authorized)

- [x] `[Review][Decision]` **AC1(b)/INV-APPROVE-6 — teardown is unwired in every production path.**
  `recordApprovalPort(store)` at `src/reverify/runner.ts:406` passes no opts, so `deps.teardown` is
  `undefined` everywhere and `await deps.teardown?.(...)` was a silent no-op before promotion. The
  module comment claims "the fleet verb passes the real one" — no such verb exists. Rather than wire a
  driver into the reverify runner (new feature work, and DF5.1's port has no driver to build one from),
  the gate now **fails closed**: an open record that owns a `vmName` with no teardown seam is refused,
  the `pausing` extension stands, and the run stays recoverable. The invariant is now enforced instead
  of asserted. **Real teardown wiring remains a follow-up story.**
- [x] [Review][Decision] **AC5's attach refusal is a deliberate race, now documented.** `attach.ts`
  states in-source that its `pausing`/`awaiting-approval` check "IS A FAST REFUSAL, NOT AN INVARIANT".
  Kept as designed — the loss is one steering message, no state is corrupted, the extension is genuinely
  unmutated, and taking the gate's lock in the attach path is a locking-topology change review is the
  wrong place to land. Recorded as **Deviation 10**.
- [x] [Review][Decision] **AC1(c)'s `pausing` resume path was unimplemented.** Nothing anywhere promoted
  out of `pausing`, so a teardown crash stranded the run permanently — not decidable, not promotable,
  not expirable, hand-editing the record the only exit. Implemented as the AC specifies.

### Patches applied

**Approval gate** (`src/fleet/approval-gate.ts`, `src/reverify/approval.ts`)
- [x] [Review][Patch] `pausing` resume: matching `reportId` re-runs teardown and promotes; a different one still collides
- [x] [Review][Patch] `awaitDecision` ignored expiry — polled its full 24 h window past a run that had timed out, then returned `null`
- [x] [Review][Patch] Rebind did not restamp `expiresAt` — a report bound at T+23h59m inherited a 1-minute window
- [x] [Review][Patch] `resolveTimeoutMs` had no ceiling — a large finite value threw a bare `RangeError`
- [x] [Review][Patch] `withApprovalLock` built its path from an unvalidated `runId` (write-then-`rmSync` outside the runs dir)
- [x] [Review][Patch] `submitDecision` wrote `state: req.decision` unvalidated; blank `approverId` accepted; `system:timeout` forgeable
- [x] [Review][Patch] Lock reclaim `continue`s bypassed the deadline check; pid reuse wedged a lock permanently (`LOCK_ABANDON_MS` escape)
- [x] [Review][Patch] `supersededReportIds` appended `""`, appended the still-live id, never deduped
- [x] [Review][Patch] Nullish `headSha` crashed the validation error path; `reportId`/`headSha` untrimmed
- [x] [Review][Patch] `capText` could slice a surrogate pair; suffix literal did not match the spec
- [x] [Review][Patch] Bundle-existence guard ran only on rebind, never on the first request

**Approver authorization** (`src/fleet/approvers.ts`)
- [x] [Review][Patch] Dir-mode guard checked only `dirname(path)` — the documented replacement attack one level up still worked. Now walks every ancestor to `hostRoot`
- [x] [Review][Patch] The `file` parameter escaped `hostRoot` (absolute or `../`) — an attacker could supply the allowlist they authenticate against
- [x] [Review][Patch] No ownership check — running as root, an allowlist owned by an unprivileged uid was authoritative
- [x] [Review][Patch] `readCappedToken`'s stall window was per-read, not cumulative — a slow drip parked the verb ~10 h
- [x] [Review][Patch] No `isFile()` check — a FIFO at the allowlist path hung the verb forever
- [x] [Review][Patch] Empty/whitespace `approverId` authenticated; no trim; case-only misses were indistinguishable from unknown ids

**Attach transport + status** (`src/fleet/attach.ts`, `src/fleet/status.ts`)
- [x] [Review][Patch] No `closedAt`/settled-state guard — attach exec'd into a box destroyed at pause time
- [x] [Review][Patch] Append failure threw unclassified → exit 1 "retry me" → new `messageId` → **double delivery**
- [x] [Review][Patch] No trailing-newline guard — a partial append silently destroyed the *next* valid message
- [x] [Review][Patch] `QDS_STEERING_ROOT` was read host-side for a path used inside the box; the two legs diverged silently
- [x] [Review][Patch] `readAck` mapped a dead box to "absent" → 30 s poll and a remediation whose every clause was false
- [x] [Review][Patch] Status approval override fired on a *list failure*, masking `listUnavailable`/`boxUnknown`
- [x] [Review][Patch] Paused rows dropped `closedAt` and never carried `boxAlive` — the one row that most needs "nothing is billing"
- [x] [Review][Patch] Ceiling overran by a full per-call timeout; `ceilingMs: 0`/`pollIntervalMs: 0` degenerate; corrupt-acks conflated with timeout; inbox read uncapped

**Steering + run-record** (`src/phase-engine/steering.ts`, `src/providers/run-record.ts`)
- [x] [Review][Patch] `delivered.add` ran *before* `ack` and the ack throw was swallowed — a failed ack was never retried, so `fleet attach` reported not-acked for a message that landed
- [x] [Review][Patch] `onInboxError` was not awaited — an async observer's rejection was a process-fatal unhandled rejection
- [x] [Review][Patch] `telemetry.status` is a one-way latch that gated the drain — one degraded resident stopped all draining forever, silently
- [x] [Review][Patch] Ack failures did not reach `onInboxError` at all
- [x] [Review][Patch] Legacy singular `supersededReportId` was unreadable, unwritable *and* unremovable — two disagreeing sources of truth in an audit trail. Migration added
- [x] [Review][Patch] `STRINGS_MAX_ELEMENTS` on an append-only history bricked every later write past 256; now sheds oldest-first
- [x] [Review][Patch] `lastDegradationReason` clobbering; unbounded cumulative `promptContext`; no timeout on injected `drain`/`ack`
- [x] [Review][Patch] `assertKind` exhaustiveness guard; `messageId` cap; cap-after-sanitize; `schemaVersion` → 2

**CLI** (`scripts/fleet.ts`, `src/fleet/verbs.ts`)
- [x] [Review][Patch] `attach` had no TTY guard — parked 120 s then threw a *brief*-shaped error naming a flag it does not declare
- [x] [Review][Patch] `gateEvent` logged `status:"error"` for `already-decided`, which exits 0
- [x] [Review][Patch] `--approver ""` produced an allowlist refusal with a blank subject instead of a usage error
- [x] [Review][Patch] `--reason` echoed unsanitized; auth-refusal arm hardcoded `state:"awaiting-approval"`
- [x] [Review][Patch] Decision `else` hardcoded `"already-decided"`, disagreeing with the structured log
- [x] [Review][Patch] attach built a `create: true` store on the default path; `requestId` key collision (now `dispatchRequestId`); existence disclosed before authentication

**Test hardening**
- [x] [Review][Patch] **Live e2e leaked a real box and a real billable key on every non-`fresh` outcome** — `pauseSucceeded` meant "requestApproval returned", not "teardown ran", and both `finally` guards skipped cleanup on exactly the run that failed
- [x] [Review][Patch] The live key-leak delta was computed, serialized to evidence, and never asserted
- [x] [Review][Patch] AC7's "box is genuinely absent" had no positive control — "gone" and "invisible" were indistinguishable
- [x] [Review][Patch] Injected `authenticate` ignored its arguments; attach's success path never exercised at the CLI layer; exit-code probes skipped for all three new verbs; no exact flag-table snapshot (a secret-bearing flag could be added with every test green)
- [x] [Review][Patch] "No secret leaks" tests ran with no needle planted; AC7 status double's `get()` ignored its argument; argv-hygiene control was literal-substring only (now pins that the append argv is a *constant* script)
- [x] [Review][Patch] `authenticateFromStdin` — the only function production calls — had no test; the stdin cap was only ever tested with one chunk; truncation caps never asserted; `withApprovalLock`'s EPERM arm and abandon escape uncovered

### False positives (verified against source, dismissed)

- [x] [Review][Dismiss] "The cross-process approval lock was deleted with no replacement" — `withApprovalLock` **moved** to `src/fleet/approval-gate.ts:92` and is used at four sites, with all six documented properties intact. The blind reviewer had no repo access.
- [x] [Review][Dismiss] "`localSteeringInbox()` has no caller — AC6 is unwired" — wired at `scripts/pipeline-run.ts:1709-1717`. The reviewer grepped `src/` and missed `scripts/`.
- [x] [Review][Dismiss] "`approve`/`reject` hang on a TTY and echo the typed token" — `assertTokenAttached` allow-lists FIFO/file/socket, and a TTY is a character device, so it refuses *before* any read. (The `attach` half of the same finding was real and is fixed.)
- [x] [Review][Dismiss] "`--reason` is persisted uncapped (~1 MB)" — `submitDecision` already ran `capText(reason, 1_000)`. The CLI-side sanitization gap was real and is fixed; the uncapped-persistence premise was not.
- [x] [Review][Dismiss] "`withApprovalLock` has no test that can fail" — five of its arms were already covered in `tests/reverify/approval.test.ts:146-345`. Four genuinely-uncovered arms were added.
- [x] [Review][Dismiss] "An abandoned exec's rejection surfaces unhandled" — `withTimeout` already does `void p.catch(() => {})` before the race.
- [x] [Review][Dismiss] `detached()`'s aliasing on the read path — the read-mode call site's result is discarded, so the aliasing entry is unreachable. The docstring's precondition claim was wrong; the code was not.

### Deferred (pre-existing or out of scope)

- [x] [Review][Defer] `src/pr/repos.ts:95-108` — identical directory-mode gap in DF5.2's repo allowlist. Different story's surface; already a recorded follow-up.
- [x] [Review][Defer] `hashToken` is single-round sha256 with no work factor — changing it invalidates every enrolled allowlist and needs a migration story. Tokens are documented as high-entropy and machine-minted.
- [x] [Review][Defer] Real `teardown` wiring into the reverify runner (the other half of the BLOCKER). The fail-closed guard covers the security invariant meanwhile.
- [x] [Review][Defer] `listedKeyHashes()` discards `truncated` from `listAllKeys(10)` (`tests/fleet/e2e/live-harness.ts`) — on a truncated page list, the key-leak baseline and delta are computed over a partial population, so the now-asserted check is still unsound at scale.
- [x] [Review][Defer] `FleetError.exitCode` is typed `1|2|3|4|5` while `report()` accepts and documents 1–6 — which is why the append failure is expressed as a result rather than a typed throw. A one-token widening; nobody owns `dispatch.ts` this round.
- [x] [Review][Defer] `submitDecision` against a nonexistent run throws a raw storage error rather than a classified refusal (`readApproval` does not catch ENOENT, unlike `readApprovalIfPresent`). Current behavior is pinned by a test; two readers with deliberately different ENOENT postures is at minimum worth a comment.
- [x] [Review][Defer] `--message -` is an undeclared stdin sentinel. It cannot be dropped (the story specifies it verbatim) and cannot be declared (`VerbFlag` is the closed shape DF3.5's skill-contract test compares against). Surfacing it in `--help` needs a `VerbFlag.note?` field — a contract-shape change owned by DF3.5.
- [x] [Review][Defer] **The Observability Contract's `pause` event is still never emitted, and `record_write_ms` is not emitted by the gate.** `gateEvent`'s union in `scripts/fleet.ts` declares `"pause"` but nothing produces it — a declared event with no producer. It cannot be emitted from the CLI: `requestApproval` has zero call sites in `scripts/fleet.ts` (the pause happens inside reverify), so the line has to come from `src/fleet/approval-gate.ts`, which today imports only `node:*`, `run-record` and `reverify` types. Adding a logger dependency to that module is an architecture decision, not a review patch, so it was not taken in this round. **This matters for DF5.3**, which is specified to join approvals on `requestId` across every gate event — the pause is the one event the story's E2E slice is built around, and it produces no structured line. (Routing note: this was assigned to the CLI cluster, where it turned out to be unfixable; it belongs to the gate. Recorded rather than quietly dropped.)
- [x] [Review][Defer] GitNexus index is stale and partially corrupted (new branch files absent; symbol names such as `"d dependency su"` in the graph). Impact analysis this round fell back to grep. Reindex when convenient.

### Deviation 10 (new, from this review)

**AC5 attach refusal is a fast refusal, not an invariant.** `attachToRun` reads the approval state and
appends under no lock, while the gate mutates that state under `withApprovalLock` — so a run entering
`pausing` inside that window can still get a message appended to a box being torn down. Accepted: the
loss is one steering message, no state is corrupted, and the extension is genuinely unmutated. Closing
it requires attach to take the gate's lock, which changes the locking topology.

## Review Findings — round 7 (2026-08-30, `bmad-code-review` on PR #150)

11 reviewers (6 blind, 4 edge, 1 auditor) over 11 chunked diffs (≤1,968 lines each; `_bmad-output`
docs/evidence excluded) → 43 raw findings → 37 unique after cross-layer dedupe → 33 patched,
1 decision resolved conservative, 5 false positives dismissed, 0 deferred. Triage ledger and all
reports: `_bmad-output/workflow-state/code-review/pr150/`.

**Approval gate** (`src/fleet/approval-gate.ts`, `tests/fleet/approval-gate.test.ts`)
- [x] [Review][Patch] **HIGH** — the acquire-side lock reclaim reintroduced the rename-vacancy race the release path was rewritten to eliminate: a restore that re-created the file left `lockPath` vacant for a third waiter AND minted a new inode the holder's fenced release no longer recognised. The restore now puts the VERY FILE back — atomic, inode-preserving, no vacant instant (refined to a `link`-based restore-if-absent in the CodeRabbit follow-up below)
- [x] [Review][Patch] **HIGH** — the `pausing` resume arm was unreachable in production AND resumed into a stale window: resume now restamps `requestedAt`/`expiresAt` and runs `assertBundlePresent` before promoting (the third, previously unchecked route to the decidable state)
- [x] [Review][Patch] `reclaimApprovalLock` reported `absent` when a successor replaced the lock under it — new truthful `changed` outcome (exit 0, added to `GATE_OK_OUTCOMES`)
- [x] [Review][Patch] the EEXIST retry branch swallowed EACCES/EMFILE/corrupt reads as "lock contention" and then misattributed the fault ("held for over 5000ms") — only ENOENT-vanish retries now
- [x] [Review][Patch] `awaitDecision` accepted `pollMs: 0`/negative → a busy-spin for up to the 24h default `waitMs`; floored
- [x] [Review][Patch] concurrent same-reportId resumes ran `deps.teardown` concurrently (`pullArtifacts` races on fixed shared host paths) — serialized via a `<runId>.teardown.claim` file
- [x] [Review][Patch] persisted timeout `decidedAt` (notice-time) vs derived (`expiresAt`) disagreed — aligned to `expiresAt`
- [x] [Review][Patch] Test hardening: EPERM liveness test was vacuous as root/user-pidns (precondition now asserted); `pausing` fixtures carried no timestamps — a production-impossible shape — and the resume test never asserted the restamped expiry; error-path log lines' key sets unpinned (`toMatchObject` tolerates extra keys); the cross-process rebind race test could not reliably produce its interleaving; two refusal paths lacked the byte-identity pin their siblings all have; a `duration`/`durationMs` near-tautology anchored against real elapsed time

**Approvers** (`src/fleet/approvers.ts`, `tests/fleet/approvers.test.ts`)
- [x] [Review][Patch] `enrolApprover` read-modify-write raced with no lock — two concurrent enrolments, last rename wins, the loser's approver silently vanishes with a token that verifies against nothing. Now locked (cross-process regression test with a negative-control proof)
- [x] [Review][Patch] scrypt N/r ceilings were bounded independently → ~4 GiB verify-path allocation the computed `maxmem` explicitly authorized; the product is now bounded, and a `scryptSync` throw becomes a typed fail-closed refusal instead of a bare Error the CLI classifies as transient/exit-1 "retry me"
- [x] [Review][Patch] `enrolApprover("__proto__")` returned ok while writing nothing (assignment through the inherited `__proto__` setter; `JSON.stringify` drops it) — a once-only token that can never authenticate

**Attach** (`src/fleet/attach.ts`, `tests/fleet/attach.test.ts`)
- [x] [Review][Patch] the length guard measured RAW chars against `DIRECTIVE_TEXT_CHAR_CEILING` while the fold truncates POST-sanitize at `ATTACH_MESSAGE_CHAR_CEILING` — escape-heavy ≤4000-raw-char messages passed and were silently tail-truncated while reporting `attach-acked`. The guard now measures post-sanitize length against the right constant, on both the library and CLI pre-check
- [x] [Review][Patch] the over-ceiling path threw a bare Error classified transient/exit-1 "retry me" for a failure that can never succeed — now a typed `message-over-ceiling` result arm
- [x] [Review][Patch] `readAck` dereferenced the parsed row outside its try — a literal `null` line escaped the poll as an uncaught TypeError
- [x] [Review][Patch] acks file mode `0o600` applied only at creation; a pre-existing lax file is now chmodded after every append (matches the inbox leg)
- [x] [Review][Patch] the ack poll re-read the whole append-only acks file every 500 ms tick with no cap — windowed to `tail -c 1MiB` (matches `INBOX_READ_CAP_BYTES`)

**Steering** (`src/phase-engine/steering.ts`, `tests/phase-engine/steering.test.ts`)
- [x] [Review][Patch] the awaited `onInboxError` observer had no deadline — a hung async observer (the type invites `Promise<void>`) wedged the serialized solicit chain forever, the exact failure mode `INBOX_CALL_TIMEOUT_MS` exists for
- [x] [Review][Patch] the fault-dedupe latch never reset on recovery — an identical fault after a healthy interval was silently swallowed; now cleared on successful drain/ack
- [x] [Review][Patch] an ack retry recorded the CURRENT solicitation's point — a solicitation whose prompt context the message never reached — instead of the fold-time point

**Run record** (`src/providers/run-record.ts`, `tests/providers/run-record.test.ts`)
- [x] [Review][Patch] the retired-field migration at the 256-element cap shed the migrated id ITSELF (drop-oldest = head = legacy scalar), violating "a migration in an audit trail may not lose an id" — now sheds oldest history entries, never the migrated id, and the stderr note names dropped ids
- [x] [Review][Patch] a legacy scalar re-created by a mixed-version writer head-folded an inverted ordering into the audit trail — now tail-appends with a loud note when the stored schemaVersion proves the migration already ran

**CLI + status** (`scripts/fleet.ts`, `src/fleet/status.ts`, `tests/fleet/gate-verbs.test.ts`)
- [x] [Review][Patch] **HIGH** — `--rotate` was a dead flag: parsed, never read, and both remediations telling operators to pass it (`approver-already-enrolled`, exit-6 lost-token) were unactionable. Now passed through (`FleetDeps.enrol` seam widened) with a subprocess test proving rotation kills the old token
- [x] [Review][Patch] approve/reject built the WRITABLE store pre-authentication on the default-dir path, contradicting the block's own comment — the probe is `create: false` unconditionally; writable construction happens post-auth
- [x] [Review][Patch] `approvalRowFields` discarded the imported `expiredState` verdict and re-derived expiry inline — the exact drift class the change claimed to eliminate (NaN/boundary divergence between `fleet status` and the gate). The verdict now comes from `expiredState`; only the countdown display is derived inline
- [x] [Review][Patch] unreachable `--dir ""` guard removed (`parseValueFlags` rejects empty values before dispatch); its comment's premise was false
- [x] [Review][Patch] `gateEvent` logged `status:"ok"` for invocations that exit 6 — success arms now emit with the completion line's print fate, so a lost line logs `"error"`
- [x] [Review][Patch] Test hardening: the planted-secret needle scan now includes the persisted run record (a `...auth` spread into the stored decision would have leaked with every test green, and the positive control's comment falsely claimed coverage); real-token subprocess stdout/stderr in D9 are now scanned for the token; D7's absent-run refusal asserts empty stdout

**Reverify wiring** (`src/reverify/runner.ts`, `src/reverify/approval.ts`, `tests/reverify/`)
- [x] [Review][Patch] **HIGH** — the runner minted a fresh `reverifyId` on every retry, so the gate's byte-equal-reportId resume arm could never fire and a crash between `pausing` registration and promotion stranded the run permanently (never expiring, never decidable, status showing `awaiting-approval` while approve refused). A stranded `pausing` extension's bound reportId is now re-presented, regression-tested through the real gate
- [x] [Review][Patch] Deviation 8's substitute bundle guard was dead code — no caller passed `bundleDir`, so `assertBundlePresent` early-returned on every production path while the Dev Agent Record described it as enforced. Now wired through `recordApprovalPort` and proven on port + e2e paths; the Deviation 8 text was corrected to describe the shipped reality

### False positives (verified against source, dismissed)

- [x] [Review][Dismiss] "`attachToRun` assumes `store.get` never returns undefined" — `RunRecordStore.get` throws a typed ENOENT on absence and `assertRunExists` guards before `attachToRun`
- [x] [Review][Dismiss] "no TTY guard on the approver-token stdin read" — `assertTokenAttached` refuses TTY/chardev/closed fd 0 with `approver-token-absent` before any read
- [x] [Review][Dismiss] "attach fold loop is a permanent head-of-line blocker if `PROMPT_CHAR_CEILING` < ~8,548" — it is 16,000; the 8,000-char fold budget always fits a ~4,274-char max line
- [x] [Review][Dismiss] "the token-refusal leak path is proven only against a hardcoded fake message" — `tests/fleet/approvers.test.ts:383-384` pins the PRODUCTION authenticator's refusal message+remediation as token-free; the residual subprocess-stream gap was closed anyway (D9 now scans real-token streams)
- [x] [Review][Dismiss] "`onInboxError` payload serializes to `{}` for real Errors" — the observer receives a plain detail object, never an `Error` instance (fix-time verification, cluster D)

### Deviation 11 (new, from this review)

**`fleet status` shows `pausing` rows as `awaiting-approval` with no time-remaining** — a deviation
from AC7's letter ("each appears with its state, its bound reportId, and time remaining"), kept
deliberately as the conservative resolution: `pausing` never expires (`expiredState`), so a countdown
would run to zero and change nothing, and the relabelled row still carries the bound `reportId`.
Display surface only; no state corrupted. Recorded here since no prior deviation covered it.

### CodeRabbit re-review follow-up (2026-08-30)

Both remaining lock races from the automated re-review accepted and fixed:

- [x] [Review][Patch] **HIGH** — the round-7 restore was still check-then-rename (`existsSync` then `renameSync`): a holder landing between the check and the rename was CLOBBERED. The restore is now `linkSync(claimPath, lockPath)` — the atomic restore-if-absent POSIX provides; EEXIST discards the superseded capture, any other fault fails closed with the captured file preserved (`src/fleet/approval-gate.ts`)
- [x] [Review][Patch] **HIGH** — the enrolment lock's stale reclaim was re-read + `rmSync`: a competing enrolment's LIVE lock could be deleted between the comparison and the unlink. It now uses the same atomic claim protocol as the gate (rename-claim, content check on the captured file, `link`-based restore) (`src/fleet/approvers.ts`). Regression tests: replacement lock survives byte-identical; restore fault fails closed with the capture preserved

## Review Findings — round 8 (2026-08-30, `bmad-code-review` on PR #150, post-e2e-extension tree)

~173 raw findings from 12 reviewers (10 blind over 10 chunks ≤2,235 lines, edge-tests-gate,
auditor-spec) → 118 unique → 96 patched (38 source + 58 test), 11 dismissed (verified against
source), 5 decision-needed resolved conservatively. Two layers (edge-gate-core,
edge-approvers-attach) died to API rate limits; their chunks retained full blind coverage.
Triage ledger and all reports: `_bmad-output/evidence/df3-4-review-round-8/`.

**Approval gate** (`src/fleet/approval-gate.ts`)
- [x] [Review][Patch] **HIGH** — `withTeardownClaim` had no deadline and no age door: a hung or pid-recycled claim spun the resume forever (there is no operator verb for the claim path). Now bounded (`CLAIM_TIMEOUT_MS`) with a typed error naming the claim path + remedy, and reclaim demands the stale age before treating an unreadable holder as dead
- [x] [Review][Patch] `submitDecision` never checked the bundle — the one act that authorizes the PR enforced nothing of the invariant pause/rebind/resume enforce; `assertBundlePresent(…, "decide")` added
- [x] [Review][Patch] a promotion that lost its race still returned `{outcome:"requested"}` — now returns `pause-in-progress` so the caller re-presents the bound report instead of burning the decision window on a non-binding
- [x] [Review][Patch] `awaitDecision` clamped `pollMs` but not `waitMs` — NaN/Infinity made the deadline permanently false (poll-forever); non-finite now falls back to the default, negative clamps to 0
- [x] [Review][Patch] a throw between the lock's `wx` create and its content write stranded an unrecoverable empty lock (the staleness door needs a pid) — write moved inside the fd try with inode-fenced removal on failure
- [x] [Review][Patch] **(from wave-2 canary)** the reclaim's restore-failure arm left `lockPath` VACANT: the rename-away had moved the replacement's lock to the claim path and the failed `linkSync` put nothing back, so the next acquirer entered `body()` alongside the live replacement holder — the two-in-critical-section shape the module calls the cardinal sin. The path is now poisoned (a pid-less marker the dead-pid door never auto-reclaims) before the fail-closed rethrow; canary test flipped from `test.failing` to a real test
- [x] [Review][Patch] LOW — dead `requestId` re-stamp removed; ENOENT retry arm now sleeps (was a synchronous busy-spin); `headSha` case-normalized before validation (an upper-cased real sha was refused); `historyOf` skips non-string audit entries instead of coercing them to `[object Object]`; the atomic-restore comment now states the true EEXIST-window guarantee

**Approvers** (`src/fleet/approvers.ts`)
- [x] [Review][Patch] a lock file whose content parses to no positive pid was unreclaimable FOREVER, even fully stale — past the stale window, empty/garbage pid is now reclaimable (mirrors the gate's unreadable-holder door)
- [x] [Review][Patch] a stdin stream error rejected as an untyped throw → exit-1 "retry me" for a durable fault — now the typed `approver-token-stdin-error` refusal
- [x] [Review][Patch] enrolment write not fsynced before rename — a crash could land a zero-length allowlist (silent revocation of every approver); fsync added before the atomic rename
- [x] [Review][Patch] zod error text (which embeds received values, i.e. salt/hash fragments) was interpolated into refusals — now a capped message naming only the first offending field path
- [x] [Review][Patch] the docstring promised first-enrolment-on-a-fresh-host works; the ancestor walk actually refuses (`approver-allowlist-dir-mode`, "create 0700"). Behavior kept (fail-safe; pinned by a new test), docstring corrected to state the deliberate posture

**Attach + drain** (`src/fleet/attach.ts`, `scripts/pipeline-run.ts`)
- [x] [Review][Patch] `readInboxTail` ignored short reads — the zero-filled buffer tail corrupted the newest inbox lines; now loops to cap/EOF and decodes only the bytes read
- [x] [Review][Patch] a ceiling of 0 against a dead box reported `no-ack` ("the message IS queued") — when the box never answered a single look the reason is now `box-unreachable`
- [x] [Review][Patch] `drain` ignored the per-line `runId` — a shared/legacy inbox line from ANOTHER run folded in as this run's intent; lines are now filtered (count surfaced, content never), and the production inbox is wired with `ownRunId`
- [x] [Review][Patch] `onInboxError` payload now explicit fields (`runId/requestId/detail`) instead of `JSON.stringify` of whatever arrives (an Error would serialize `{}`)

**Status + verbs + steering** (`src/fleet/status.ts`, `src/fleet/verbs.ts`, `src/phase-engine/steering.ts`)
- [x] [Review][Patch] **(Deviation 11 superseded — decision DN2)** a stranded `pausing` run rendered `awaiting-approval` with remediations that circled forever (status said "wait for awaiting-approval" — the very state it masked; attach said "decide it with approve" — a verb that refuses `pausing`). `pausing` now renders as itself with a `resumeHint` naming the one exit (re-run reverify); approve/attach refusal texts aligned
- [x] [Review][Patch] **(decision DN3 — intentional behavior change)** a paused run with a LIVE BILLING box rendered `live`, hiding exactly the strand INV-APPROVE-6's refusal creates; the approval-state override now wins over box presence, with `boxAlive: true` kept on the row
- [x] [Review][Patch] the drain fold/ack loop had a per-call 5 s deadline but no aggregate bound — ~400 queued messages × one stalled ack each = N×5 s serialized ahead of every solicitation; one pass is now deadline-bounded (`DRAIN_PASS_TIMEOUT_MS`) and reports its unprocessed count (deferred, re-read next pass)
- [x] [Review][Patch] LOW — single clock read per status row (countdown and expiry verdict can no longer disagree); `ack-provenance` count added engine-side for acks written before any prompt reached the resident (CLI consumption recorded as DF1.10 follow-up — it is a cross-process fact); `listVerbs` docstring credits `enrol`

**Run record + providers** (`src/providers/run-record.ts`, `src/providers/bounded-exec.ts`)
- [x] [Review][Patch] the shed note echoed RAW dropped element content to stderr BEFORE the secret scan ran — notes now print lengths/counts only
- [x] [Review][Patch] the retired-field migration folded the legacy scalar past `assertNoSecret` — a poisoned legacy value bricked the NEXT rebind instead of refusing at migration time; the fold now scans under the successor field's path
- [x] [Review][Patch] the `strings` kind admitted empty-string elements into append-only audit history — rejected with field and index named
- [x] [Review][Patch] the shared exec default cap doubling (512 KiB→1 MiB) documented: attach's ack window rides the shared default by design; lowering it requires attach to pass an explicit cap first (recorded, not reverted)

**Reverify + scripts** (`src/reverify/runner.ts`, `scripts/fleet.ts`, `scripts/pipeline-run.ts`, `scripts/lib/cost-ledger-opts.ts`)
- [x] [Review][Patch] the gate pre-read sat OUTSIDE the `requestApproval` catch — a record deleted between reverify's reads threw past the typed outcome (AC4); the read moved inside
- [x] [Review][Patch] `fleet unlock`'s `forced` audit fact was derived from the SUCCESSOR's holder status — a plain reclaim that lost a race logged `forced: true`; now derived from the invocation's own `--force` (gate event AND completion line)
- [x] [Review][Patch] attach remediations asserted facts not established: unknown states were told "the run is over, its box torn down" (false for a live run) and unknown ack outcomes were told "the message IS queued" — both now four/five-way with a truthful inspect-first catch-all
- [x] [Review][Patch] a failed record read logged gate-event `state:"absent"` as an observation when nothing was observed — now `unknown`
- [x] [Review][Patch] one raising log sink permanently silenced every gate event with no signal — per-emit containment + a once-per-process stderr warning
- [x] [Review][Patch] caller `fields` could clobber the computed truthfulness fields in `gateEvent` — computed keys now win
- [x] [Review][Patch] fresh decisions omitted `reason` from the log line (INV-APPROVE-4's letter) — now carried, capped
- [x] [Review][Patch] a failed ledger migration degraded every later invocation silently — one stderr line naming the cause; the shadowed `tmp` removed

**Test hardening** (wave 2 — `tests/fleet/`, `tests/providers/`, `tests/reverify/`, `tests/phase-engine/`, `tests/fleet/e2e/`)
- [x] [Review][Patch] **HIGH** — the fake exe.dev interceptor fell through to `sh -c` on the HOST when the driver's provision-script literal drifted: a sudo line executed on the developer's machine. The fake now fails closed (exit 64 naming the drift) on unmatched sudo-bearing commands, anchors the provision dispatch on its root literal, and provisioning tests assert the TARGET box by argv — not just that some sudo-shaped call happened
- [x] [Review][Patch] **HIGH** — D8's `finally` called `revokeQuietly` bare (reads the record outside its own try): a failed teardown's missing record would replace the test's real error and skip evidence + cleanup. Wrapped like T1.7; D8 also gained T1.7's key-hash leak delta (it had the weakest leak verification of the three live tests while spending real money)
- [x] [Review][Patch] **HIGH** — T1.7's fresh-host enrol contract was untested and the source docstring contradicted the behavior (fixed above); the verb-registry snapshot test enumerated a hand-written list that omitted enrol/unlock — their flags/exit codes were unpinned; INV-APPROVE-5's forged-line negative control asserted nothing about delivery (every assertion held on a completely undelivered message) — all three now fail on the defect they name
- [x] [Review][Patch] MED — cross-process `submitDecision` serialization finally tested with two REAL processes (the in-process race cannot interleave a synchronous critical section); the reclaim `changed` branch, the teardown-claim loop (throw-release, stale reclaim, fresh-wait), the emitPause raising-sink guard, `requestApproval` on a missing run, and the exact clamp boundaries are covered; the EPERM liveness arm is exercised everywhere via a spy twin (not skipped on root CI)
- [x] [Review][Patch] MED — T5.1 hardened: reverify leg timed out explicitly and the leg-sum overrun documented with per-leg `execTimed` ceilings; the porcelain check is now EXACT (a fixer rewriting its own judge fails before commit/harvest ride the false green); post-finally box-absence asserted (a silent destroy failure fails the test); the engine retry fires only on the stall shape (a deterministic failure no longer burns a second full model spend); a wrong-token auth-refusal leg now exercises the real scrypt verify on live infra (exit 5, zero model spend)
- [x] [Review][Patch] MED — CC-9's token scan planted a real needle through a leaky auth double; the stdin sentinel's SUCCESS path (piped bytes → delivered message → ack → `attach-acked` exit 0) is proven out-of-process; no-ack classification pinned on the common clean-empty-file shape as well as failed-cat; the approve/reject success probes assert the PERSISTED record, not stdout; auth-failure exit code observed via an `{ok:false}` injection; attach refusal probes pass a tiny explicit ceiling so a guard regression fails in milliseconds instead of bun's 20 s kill
- [x] [Review][Patch] LOW (selection) — vacuous asserts replaced (ceil-identity cap-guard, JSON round-trip, `Math.ceil` identity, discarded outcomes); `runFleet`/`runFleetWithToken` drains race the timer and kill the child (the promised ceiling is real); subprocess tests scrub `QDS_*`/credential env (the repo `.env` carries a real key); fd leaks closed; flake sources defused (pid-recycle re-proof, wall-clock bounds, readiness budgets); at-boundary cases added (expiry at exactly `expiresAt`, at-ceiling message delivered whole, messageId exact-cut); retry double-delivery now a fact (same text re-sent, fresh id, both lines on the box)

### Dismissed (verified against source; full table in the round-8 triage ledger)

Selected: allowlist-lock "unrepresentable after reclaim" (misread loop flow — the loop re-creates and sets `ownIno`); `attachToRun` undefined-record (store throws typed ENOENT, never returns undefined); `release()` reclaim race (reclaim requires a provably-dead holder; a live releaser's pid is its own); T5.1 `["true"]` phases (documented budget-driven design — the gate leg IS executed); enrol-from-cwd (documented D9 design; the absolute allowlist path is printed in the success envelope); `Tracer.trace` unawaited-rejection (synchronous method — no promise exists); approval port "shed its lock" (serialization lives in the gate's own `withApprovalLock`).

### Decisions resolved conservatively (pre-authorized; full table in the ledger)

1. **Deviation 12 (new)** — AC6's round trip cannot close on the shipped substrate: `fleet attach` appends to the BOX's `/run/steering/inbox.ndjson` while the engine drains the HOST's — two filesystems, no mount between them. The `no-ack` remediation now states this plainly (message IS queued box-side; no in-box executor exists until DF1.10; a re-send double-delivers). Recorded rather than redesigned; DF1.10 owns the round trip.
2. `pausing` remediation circle — fixed outright (above), superseding Deviation 11's letter.
3. Live-box paused strand hidden as `live` — fixed outright (above).
4. Unrecorded scope expansion (driver sudo hard-fail at create, exec cap doubling, ledger migration temp handling) — recorded here rather than reverted; all deliberate with commit lineage.
5. Letter-vs-intent gaps recorded, intent intact: approval namespace at `schemaVersion: 2` (adopted round 6); per-run configurable timeout unimplemented (flat 24 h — follow-up feature work); `unlock` outside the Observability Contract's closed event set; INV-APPROVE-7's letter vs `pauseRun` reading keyHash-bearing core fields (fail-closed guard; nothing persisted or logged from them).

### Deferred (out of review scope, logged)

- Real teardown wiring into the shipped reverify caller (still DF5.1-adjacent; the R5-C fail-closed guard enforces the invariant meanwhile) — carried from round 6
- Steering send-path self-heal: re-provision on send failure lives on `ExeDevDriver.exec`, whose blast radius is CRITICAL (27 symbols across fill/setup/gate/dispatch/fanout) — the suggested `steeringSend` seam is follow-up work; the shipped create-time provisioning stands
- Cross-process ack-provenance surfacing on the attach CLI (engine-side count shipped; the CLI join needs DF1.10's executor contract)

**Verification:** focal suites 3,113 pass / 0 fail (fleet, providers, reverify, phase-engine, scripts); `biome check` clean on all 33 touched files; `tsc --noEmit` exit 0; `detect_changes` blast radius confined to the PR's own modules (gate/attach/approvers/status/steering/run-record/reverify/scripts flows — no foreign processes).

## Review Findings — round 9 (2026-08-31, CodeRabbit round-8 response close-out + T-F test wave, PR #150)

**CodeRabbit round-8 HIGH findings — both closed on the repo's rename-to-private-claim protocol:**
- [x] [Review][Patch] **HIGH** — `reclaimApprovalLock` could unlink a successor approval lock: a successor landing between the content-fenced re-check and the `rmSync` on the shared path was destroyed, putting two processes in the critical section (the successor holds a lock that no longer exists). Removal now renames to a private claim name first — nothing else can create it, so the unlink can only ever hit a file this process inspected — re-verifies inode+content AT the claim, and removes only the claimed inode. A captured successor is link-restored (same inode, no vacancy, its fenced release still recognises it) and reported `changed`; a filesystem fault mid-restore poisons the vacant path with a pid-0 marker instead of surfacing a dual-entry window. Tests: successor-before-claim (`changed`, very inode preserved) and successor-after-claim (removal touches only the claimed inode).
- [x] [Review][Patch] **HIGH** — `withTeardownClaim`'s stale-claim recovery could delete a live replacement claim between the stale-holder check and the removal, defeating `<runId>.teardown.claim` serialization (two concurrent teardowns). Fixed on the same protocol: steal-rename to a private path, content re-read AT the private path proves the file judged dead is the file being deleted, link-restore on mismatch (EEXIST ⇒ a third waiter re-took the path and the captured claim is superseded), poison marker before rethrow on a non-EEXIST restore fault.

**T-F test wave — 12 findings triaged: 9 valid (fixed), 3 false positives (documented in-code):**
- [x] [Review][Patch] catch-all lock-refusal test now matches the refusal regex and asserts the poison marker from disk as `0:<uuid>`
- [x] [Review][Patch] resume trigger observed via a wrapping port recording `req.reportId` before delegation
- [x] [Review][Patch] read-ordinal test injection replaced with phase-keyed injection — double-read refactors can no longer misfire it
- [x] [Review][Patch] follow-up approval test timeout raised to 30 s (two real `LOCK_TIMEOUT_MS` waits); siblings kept at 15 s
- [x] [Review][Patch] the `.claim.` test anchor tightened to `startsWith(\`${lock}.claim.\`)` + path equality at both sites
- [x] [Review][Patch] `expect(...).not.toHaveProperty("supersededReportId")` at two sites — the retired scalar's absence is now falsifiable
- [x] [Review][Patch] decoy bundle planted at the default `.sandbox/runs` path proves the wired `runsDir` was actually consulted in the gone-bundle test
- [x] [Review][Patch] cost-ledger test's stderr stub targets `process.stderr.write`, the channel the module actually uses
- [x] [Review][Dismiss] FP: `store.set` merges extension namespaces field-by-field via `structuredClone` — the pausing fixture cannot clobber the budget extension
- [x] [Review][Dismiss] FP: `legacyPath` lives under the `mkdtempSync` base removed in `afterEach` — no fixture leak

**Close-out regression fixed at commit time:**
- [x] [Review][Patch] the decide path's harvested-bundle invariant (correct new behavior: a decision over a gone bundle is refused) left `verbs.test.ts`'s approve/reject success probes bundle-less, so they were answered by the refusal instead of a decision — `pauseRun` now plants the bundle a real gated record always has (production `requestApproval` runs with `bundleDir` wired).

**Gates:** tsc 0 errors; bun test 4691 pass / 0 fail (157 files). `detect_changes` risk CRITICAL, but every affected process sits inside the PR's own modules (fleet / phase-engine steering / scripts / providers) — the same posture rounds 6–8 accepted, now backed by a fully green suite.
