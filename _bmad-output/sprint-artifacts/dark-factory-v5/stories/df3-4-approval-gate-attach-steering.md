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
   <br />**(b)** teardown then runs: `teardownSandbox(runId, { noHarvest: true })` (DF2.5 — bundle
   already harvested, so `noHarvest` skips the second fetch), then `revokeAndVerify(keyHash)` (DF2.3)
   — spend captured, key revoked and revocation-verified, box destroyed per INV-APPROVE-6.
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
  the extension become `awaiting-approval`. So the state a decision can be submitted against never
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

<!-- Empty placeholder — filled during development. -->

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
