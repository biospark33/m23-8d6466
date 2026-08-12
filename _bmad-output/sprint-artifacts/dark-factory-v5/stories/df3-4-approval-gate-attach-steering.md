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
PR creation. It writes the durable approval record **first** (`O_EXCL` create, DF2.1 discipline) in
state `pausing`, **then** tears the box down (spend captured, key revoked, box destroyed) so the
pause costs nothing, and promotes the record to `awaiting-approval` once teardown completes. The
intent is on disk before the irreversible step, so a crash mid-teardown leaves an auditable
`pausing` record pointing at the harvested bundle rather than a destroyed box with no trace. The
operator sees the pending run in
`fleet status` and decides with `fleet approve` / `fleet reject`, authenticated against a hashed
approver allowlist. `fleet attach` is the separate, earlier surface: a steering message to the
tier-2 resident agent (DF3.3) mid-run. DF5.2 reads the record; DF5.3 links it into the audit chain.

## E2E Slice

**Demonstrable behavior:** Given a harvested, host-side-re-verified run, When
`requestApproval(runId, { proposal, reportId, headSha })` fires, it creates
`.sandbox/approvals/<run-id>.json` `O_EXCL` with `state: "pausing"` and the bundle path → runs
teardown (spend captured, key revoked and verified, box destroyed) → promotes the record to
`state: "awaiting-approval"` → surfaces the pending decision in `fleet status`
→ blocks every downstream irreversible step; When the operator runs `fleet approve <run-id>
--approver steve` with the token piped on stdin, the record closes
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

1. **(make-or-break — intent record first, then teardown)** Given a run whose bundle is harvested
   and whose host-side re-verify is green, When
   `requestApproval(runId, { proposal, reportId, headSha })` is called, Then the order is:
   <br />**(a)** on the **first** call for this runId a durable record is created `O_EXCL` at
   `.sandbox/approvals/<run-id>.json` in state
   **`pausing`**, carrying `proposal`, `requestId`, `expiresAt`, the harvested `bundlePath`,
   **`reportId`** (the DF5.1 ReverifyReport this decision is bound to) and **`headSha`** (the 40-hex
   sha that report verified) — both **required**, both written at `requestApproval` time, so DF5.2
   can bind the PR to the exact artifact approved rather than to whatever was approved most recently;
   a call missing either is a schema rejection, not a defaulted field, and no file is written.
   `O_EXCL` is the **first-create** guard only, never the re-entry path: a second call for the same
   runId takes the branch in (a2), so a re-run of DF5.1's `reverify` never bricks the run on an
   `EEXIST`;
   <br />**(a2) (re-entry — rebind, refuse, or leave alone; reciprocal of df5-1 AC6).** Given a
   record already exists for this runId, When `requestApproval` is called again, Then the outcome is
   decided by the state read from disk under the same OS file lock every other transition takes:
   **`awaiting-approval`** ⇒ the record is **rebound** by atomic replace under that lock — the new
   `reportId` and `headSha` overwrite the bound pair, the displaced id is appended to
   `supersededReportIds: string[]` (ordered oldest-first), no second file is created, and the state
   stays `awaiting-approval`. The rebind call **also carries the new report's `bundlePath`**, and it
   is validated against the record's existing `bundlePath` before the replace commits: equal ⇒ the
   field is written unchanged; unequal ⇒ the rebind is refused as a schema/consistency rejection
   (this run has one harvested bundle; a report naming a different one is bound to the wrong run) and
   the record is left byte-identical, same as the terminal and `pausing` branches below. `bundlePath`
   is therefore never silently left pointing at a report that no longer names it; **terminal** (`approved`, `rejected`, `timed-out`) ⇒ **no write at
   all** and the recorded decision is returned to the caller, which is what lets DF5.1 report
   `flags: ["approval-already-decided"]` without a second read; **`pausing`** ⇒ no write and no
   rebind, the record is left exactly as found (DF5.1 flags `approval-pause-in-progress`; DF3.4's
   own resume path is what completes the promotion). The **race rule** is single-sided: a rebind that
   observes a terminal state **loses** — it never resurrects a decided record — and `submitDecision`
   compare-and-sets on the `reportId` it read, so a decision racing a rebind either lands against the
   pair it saw or is retried against the rebound pair, never recorded against a report it never saw;
   <br />**(b)** teardown then runs (spend captured, key revoked and revocation-verified, box
   destroyed per INV-APPROVE-6);
   <br />**(c)** and only after teardown returns is the record promoted, by atomic replace, to
   `state: "awaiting-approval"` — the state a decision may be submitted against.
   <br />The record is written **before** the irreversible step, not after, because the evidence must
   outlive the failure it records: a crash between (a) and (c) leaves a `pausing` record naming the
   run, its bundle and its bound report — recoverable and auditable — where a teardown-first order
   would leave a destroyed box, a revoked key and nothing on disk to say a run had ever reached the
   gate. A `pausing` record found at startup is resumed by re-running teardown, which is idempotent
   (DF2.5), then promoting; it is **never** decidable while `pausing`, so the evidence-first write
   opens no approval path around teardown. And **no further phases execute until a decision is
   received** (P1.10 AC1, re-aimed from `decide` to the PR). No PR is opened, no branch is pushed, no
   ref outside `refs/sandbox/<run-id>` is written.
   *Negative control: an implementation that tears the box down before creating the record loses the
   run entirely when killed mid-teardown, passes a happy-path pause test, and MUST fail this one.*
2. Given a run in `awaiting-approval`, When an allowlisted approver runs `fleet approve` or
   `fleet reject` with a valid token, Then the record closes `approved`/`rejected` with
   `approverId`, `decidedAt` and `reason` logged, `awaitDecision` resolves, and no further phases
   execute — there is no path from `rejected` to a PR. Given a duplicate or contradicting second
   decision, Then the **first** decision is returned with no state change (P1.10 decision
   idempotency). *Negative control: a last-write-wins implementation satisfies the first sentence
   and MUST fail the second.*
3. Given the host process is killed while a run is paused, When any `fleet` verb next runs, Then
   the record reloads from disk with its state unchanged and the run is still decidable (NET-NEW
   per DD-8, authored against design §5.3 — the pause now outlives its process because it outlives
   its box); a record found in `pausing` reloads as `pausing`, is **not** decidable, and is resumed
   per AC1 (teardown re-run, then promoted). Given no decision within the policy timeout (default
   24h), Then the record closes `timed-out` with `approverId: "system:timeout"` — the fixed system
   actor reserved for timeout attribution, never a real approver — a timeout event is logged, and the
   run stops there:
   `timed-out` is **terminal and immutable, exactly like `rejected`** — the box is already gone, so
   nothing remains to abort; there is no path from `timed-out` to a PR, to a re-request, or to
   `approved`, and no code path reaches `approved` without a decision record. ("Auto-ABORT" named a
   running process that no longer exists at this point; the terminal record **is** the abort.)
4. Given a decision from an approver absent from the allowlist or with a non-matching token hash,
   Then it is refused with **no state change** and logged as a security event (P1.10 INV-POLICY-4);
   given a missing, unreadable, or wider-than-`0600` allowlist, Then **every** decision is refused
   likewise (fail-closed is NET-NEW per DD-8). *An empty allowlist refuses all, never "allow all".*
5. Given a run in a live phase, When `fleet attach <run-id> --message -` is issued, Then the
   message reaches the tier-2 resident agent and is acked carrying the run's `requestId`; given a
   run in `pausing` or `awaiting-approval` (box gone or going), Then attach is refused
   `run-not-attachable`, record unmutated.
6. **(transport is real, not doubled)** Given a live box under the `fake` driver running DF1.1's
   engine with a DF3.3 resident, When `fleet attach` is issued mid-phase, Then the message lands in
   `/run/steering/inbox.ndjson`, is drained at the **next** of DF3.3's three solicitation points
   (never at a fourth), appears in that solicitation's prompt context, and produces an
   `/run/steering/acks.ndjson` line the host observes and returns as `attach-acked`. Re-issuing the
   same `messageId` delivers **once**. Given the engine never reaches another solicitation point
   within 30_000 ms, Then the host returns `attach-not-acked` and the message stays queued —
   neither dropped nor re-sent. *Negative control: a test that asserts only against DF3.3's channel
   double never exercises `driver.exec`/`driver.copyFile` and MUST NOT be the sole evidence for this
   AC.*
7. **(paused runs are visible)** Given runs in `pausing` or `awaiting-approval`, When `fleet status`
   runs, Then `.sandbox/approvals/` is the **third** status source — joined alongside DF3.1's run
   records and the driver's own box list — and each paused run appears with its state, its bound
   `reportId`, and time remaining before `expiresAt`. Expiry is swept in the same pass (AC3). A run
   whose box is gone because it is paused reports `awaiting-approval`, never `boxMissing`: an
   approval record present for that runId is what distinguishes an intentional pause from a lost box.

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
| Approval record store | host filesystem `.sandbox/approvals/` (DF2.1 record discipline) | directory created `0700` on first `requestApproval`; `O_EXCL` create of the `pausing` record proven by the double-request test, and proven to precede the first teardown call by call-order capture |
| Approver allowlist | host config `.factory/approvers.json`, mode `0600`, host-only | preflight reads it before any decision is accepted; absent/loose ⇒ every decision refused (AC4) |
| Fleet dispatcher CLI | `scripts/fleet.ts` (DF3.1) | `fleet --help` lists `approve`, `reject`, `attach`; verbs resolve through DF3.1's registry |
| Resident-agent steering channel | tier-2 agent inside the run's box (DF3.3); transport rides DF2.1's `driver.exec` (append the inbox line, poll for the ack file) and `driver.copyFile` (read the ack back to the host) onto `/run/steering/{inbox,acks}.ndjson` — DF2.1's port defines no `observe` method, so host-side observation is a composition of those two verbs, owned here | attach round-trip acked with the run's `requestId` against a **live** `fake`-driver box (AC6); DF3.3's channel double covers unit cases only |
| Teardown | DF2.5 `teardown(runId, { noHarvest: true })` + DF2.3 revoke/verify, invoked at pause **after** the `pausing` record exists | pause test asserts the `pausing` record is on disk first, then spend captured, key revoked, box destroyed, and only then the record reports `awaiting-approval` |

## Technical Notes

- **The gate relocates.** P1.10 paused the run process at the `decide` phase. v5 pushes host-side
  after bundle harvest and out-of-box re-verify (D8/F10), so the pause point is tier-1, pre-PR, and
  the *run process no longer brokers it*. Mid-run steering is the separate `attach` surface (D4).
  Both halves live here; they share no state.
- **Pause is free because the box dies at pause.** The 24h default was expensive under the old model
  (a paused run held a live capped key and a running VM for a day). Here teardown runs *at* pause,
  with `noHarvest: true` — the bundle was already harvested before the host-side re-verify that
  produced this decision's report, so DF2.5's harvest step would be a second fetch of the same refs;
  every other step of its fixed order runs unchanged. PR creation is host-side from
  `refs/sandbox/<run-id>` and needs nothing from the box (D8, R5 §6 fact 17), so §5.3's listing of
  teardown after the PR is narrative order, not a data dependency. Resume re-provisions nothing, so
  the 24h default survives unchanged.
- **Contracts/Schema:** new, owned here. `ApprovalRecord { runId, requestId, reportId, headSha,
  supersededReportIds: string[], bundlePath,
  state: "pausing"|"awaiting-approval"|"approved"|"rejected"|"timed-out", proposal,
  createdAt, expiresAt, approverId?, decidedAt?, reason? }` — `reportId` and `headSha` are
  **required** and written at `requestApproval`; `supersededReportIds` is **required and defaults to
  `[]`** at create, and each AC1(a2) rebind appends the displaced `reportId` to it, so the record
  carries its own rebind history and DF5.3's chain can see which report a decision displaced;
  `ApprovalRecord.reportId := ReverifyReport.reverifyId`
  (DF5.1's report identity is spelled `reverifyId`; this field holds that exact value, and DF5.2
  joins on it), and `headSha` is that report's verified head sha. `bundlePath` is written once at
  create and re-validated (never silently overwritten) on every AC1(a2) rebind against the
  rebinding report's own bundle path — a mismatch refuses the rebind rather than repointing the
  record at a different artifact. Closed schema, unknown key rejected
  rather than written; `O_EXCL` on create, atomic-replace on every transition guarded by an OS file
  lock (or a version-field conditional rename) so only the process that observed the prior state
  writes the next one. It is the single source of truth for the pause and what DF5.2 reads.
  `pausing` and `awaiting-approval` are the two non-terminal states — `pausing` is decidable by
  nobody and exists only between the intent write and teardown's return; the other three are
  terminal and immutable, and every transition compare-and-sets on the state read from disk, so
  first-decision-wins holds across concurrent CLI invocations. A **rebind** (AC1(a2)) is a
  transition like any other: it takes the same lock, compare-and-sets on the state it read, and
  loses to a terminal state. `submitDecision` compare-and-sets on **both** the state and the
  `reportId` it read, so a decision and a rebind cannot interleave into a decision attributed to a
  report the approver never saw — the loser re-reads and is answered by the winner's record.
- **The attach transport, named — this story owns it end to end.** Host→in-box steering has no other
  owner, so it is specified here rather than assumed: `fleet attach` appends one NDJSON line
  `{ messageId, requestId, runId, message, sentAt }` to `/run/steering/inbox.ndjson` **inside the
  box** via DF2.1's `driver.exec(vm, argv, stdin?)` — the same port the setup gate uses, never `ssh`
  and never a second channel. The call is `driver.exec(vm, ["sh", "-c", "cat >> /run/steering/
  inbox.ndjson"], JSON.stringify(line) + "\n")`: the NDJSON payload travels **only** through the
  `stdin` argument, never interpolated into `argv` or built as a shell string, so `message`,
  `requestId` and `messageId` — none of them sanitized — cannot break out of the command regardless
  of quotes, shell metacharacters, or embedded newlines in `message`; `cat` writes stdin verbatim and
  parses nothing. The engine's solicitation port (`src/phase-engine/steering.ts`, shared with
  DF3.3) **drains** the inbox at exactly DF3.3's three solicitation points, folds each drained
  message into that solicitation's prompt context as guidance text, and appends
  `{ messageId, ackedAt, point }` to `/run/steering/acks.ndjson`. `fleet attach` polls for that ack
  the only way DF2.1's port allows — there is **no** `driver.observe` method: a `driver.exec` probe
  for the ack line, then `driver.copyFile(vm, "/run/steering/acks.ndjson", <host tmp>)` to read it —
  and returns `attach-acked` with the run's `requestId`; **30_000 ms**
  without an ack returns `attach-not-acked` — a reported outcome, never a silent success, and never
  a retry that could double-deliver (`messageId` is the dedupe key on drain). Both paths are mode
  `0600`, owned by the in-box agent user, and carry no credential material. Adding no fourth
  solicitation point is what keeps DF3.3's containment argument intact (INV-APPROVE-5).
- **Closed-record extensions are writable; the twelve core fields are not.** Pause teardown closes
  the DF2.1 run record (`closedAt` set, core fields frozen), yet DF5.2 later writes
  `extensions.pr` and DF6.1 `extensions.fixLoop` onto that same closed record. That is **by
  design**, not a violation: DF2.1's closure freezes the twelve core fields only, while
  pre-registered `extensions.*` namespaces stay appendable for the life of the record. A record
  layer that rejects all writes after `closedAt` breaks DF5.2 and DF5.3; a record layer that lets a
  core field move after closure breaks the audit chain. Both are defects.
- **Approver authentication:** `.factory/approvers.json` maps `approverId` → a salted hash of the
  approver's token, re-read per decision so a rotated or removed entry takes effect immediately.
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
- `src/fleet/status.ts` (authored by DF3.1; this story **adds only** the `.sandbox/approvals/` join
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
- **INV-APPROVE-2 (authorization):** only approvers present in the allowlist, presenting a token
  whose hash matches, may submit a decision (P1.10 INV-POLICY-1, re-aimed from "the run's assigned
  agent list" to the operator allowlist per DD-1). An unknown `runId` or unauthorized `approverId`
  is rejected with no state change and logged as a security event (P1.10 INV-POLICY-4).
- **INV-APPROVE-3 (fail-closed authorization):** if the allowlist is absent, unparseable, or its
  mode is wider than `0600`, **every** decision is refused. An empty allowlist authorizes nobody;
  the control never degrades to "allow all" or to "allow local user".
- **INV-APPROVE-4 (attribution is append-only):** every decision — approve, reject, timeout — is
  logged with `approverId`, `timestamp`, `reason`, `runId` and `requestId` (P1.10 INV-POLICY-3).
  `approverId` is a real allowlisted actor for `approved`/`rejected` and the fixed reserved value
  `system:timeout` for `timed-out` (AC3) — never absent, since `ApprovalRecord.approverId` is
  optional only until a decision closes the record. Terminal records are immutable and feed DF5.3's
  chain unmodified.
- **INV-APPROVE-5 (steering carries no privilege):** an `attach` message is **guidance text only**
  (DF3.3's directive rule): it can never approve, reject, skip or reorder a gate, and never raises a
  spend ceiling or steering-iteration bound — DF3.6's bounds are immutable mid-run, so attach grants
  no privilege and needs none beyond host-local CLI access. Approval travels tier-1 → host-side gate
  only, never through the resident agent (R5 §6 fact 15; D4 tripwire (b) catches a reordered gate).
- **INV-APPROVE-6 (credential containment at pause):** no run is **decidable** while it still holds a
  live credential. The `pausing` intent record is written first — it is evidence, not authority, and
  no decision may be submitted against it — then spend is captured, the run key revoked and
  revocation-verified, and the box destroyed; only after all three does the record become
  `awaiting-approval`. So the state a decision can be submitted against never coexists with a live
  key or a live box, while the write that precedes teardown makes a crash mid-teardown recoverable
  instead of silent. The approver token is host-only, arrives on stdin, and never reaches a record, a
  log, or argv.

## Definition of Done

- [ ] **Impl:** `requestApproval(runId, { proposal, reportId, headSha })` / `submitDecision` /
      `awaitDecision` / `sweepExpired` exported
      from `src/fleet/approval-gate.ts`; terminal states immutable, transitions compare-and-set.
- [ ] **Impl:** `fleet approve`, `fleet reject`, `fleet attach` registered on `scripts/fleet.ts`;
      `fleet status` lists paused runs with time remaining.
- [ ] **Contract:** `ApprovalRecord` written `O_EXCL` at `pausing` then atomic-replace to
      `awaiting-approval` and once more to a terminal state; `reportId` (`:= ReverifyReport.reverifyId`)
      and `headSha` required at create (a call omitting either is a schema rejection with no file
      written); an undeclared field is rejected by the record layer as a test failure, not a silent
      drop.
- [ ] **Test (call order, AC1/INV-APPROVE-6):** a call-order capture over one `requestApproval`
      asserts the sequence `approvals/<run-id>.json` created `pausing` → `teardown(runId, {noHarvest:
      true})` → record promoted `awaiting-approval`; a teardown-before-record implementation MUST
      fail, and so MUST one that promotes to `awaiting-approval` before teardown returns.
- [ ] **Test (crash window, AC1):** killing the process between the `pausing` write and teardown's
      return leaves a `pausing` record carrying `runId`, `bundlePath` and `reportId`; the next
      `fleet` invocation re-runs teardown and promotes it, and a decision submitted against it while
      `pausing` is refused with no state change.
- [ ] **Test (re-entry rebind, AC1(a2) — mirrors df5-1's rebind-on-re-verify test from the callee
      side):** a second `requestApproval` for a run whose record is `awaiting-approval` rebinds that
      record in place to the new `reportId`/`headSha`, appends the displaced id to
      `supersededReportIds`, creates no second file and leaves the state `awaiting-approval`; the
      same second call against a **terminal** record writes nothing and returns the recorded
      decision; against a `pausing` record it writes nothing and leaves the record byte-identical.
      An implementation that lets `O_EXCL` throw on the second call MUST fail this test.
- [ ] **Test (rebind bundlePath consistency, AC1(a2)):** a rebind whose new report's `bundlePath`
      matches the record's existing `bundlePath` succeeds and leaves the field unchanged; a rebind
      whose report names a different `bundlePath` is refused with the record left byte-identical.
- [ ] **Test (attach transport safety, AC6):** a message body containing single quotes, double
      quotes, `` ` ``, `$(...)`, `;`, and an embedded newline round-trips through `inbox.ndjson`
      byte-for-byte and is parsed as one NDJSON record; a fake driver asserting on `driver.exec`'s
      `argv` fails the test if any of `message`, `requestId`, or `messageId` appear there rather than
      in `stdin`.
- [ ] **Test (rebind vs decision race, AC1(a2)):** a rebind and a `submitDecision` entered
      concurrently → either the decision lands against the pair it read, or the rebind lands and the
      decision is answered against the rebound pair; the rebind observing a terminal state makes no
      write; no run finishes with a decision recorded against a `reportId` absent from both
      `reportId` and `supersededReportIds`.
- [ ] **Test (status join, AC7):** `fleet status` lists a `pausing` and an `awaiting-approval` run
      from `.sandbox/approvals/` with state, `reportId` and time remaining; a paused run whose box is
      gone reports `awaiting-approval`, never `boxMissing`.
- [ ] **Contract (verb registration):** `approve`, `reject` and `attach` — flags and exit codes —
      are registered in DF3.1's `src/fleet/verbs.ts` registry, so `fleet --help` and DF3.5's
      skill-contract test resolve them without a second list (DF3.1 AC6).
- [ ] **Test (live attach transport, AC6):** against a `fake`-driver box running the engine, an
      attached message reaches `/run/steering/inbox.ndjson` through `driver.exec`, is drained at the
      next DF3.3 solicitation point, acks through `/run/steering/acks.ndjson`, and a repeated
      `messageId` delivers once; a run reaching no further solicitation point within 30_000 ms
      returns `attach-not-acked` with the message still queued.
- [ ] **Integration:** teardown (DF2.5/DF2.3) is invoked at pause as `teardown(runId, {noHarvest:
      true})` — the bundle was harvested before re-verify, so no second fetch is issued — and
      completes before the record reports `awaiting-approval`; attach delivers through DF3.3's
      channel (INV-APPROVE-6).
- [ ] **Security:** decisions gated on the hashed allowlist, token read from stdin; an unknown
      approver and a missing/`0644` allowlist each refuse with no state change (INV-APPROVE-2/3).
- [ ] **Test (unit):** state machine — every transition out of a terminal state is rejected with
      the original record returned unchanged.
- [ ] **Test (idempotency):** duplicate `approve`, and `reject`-after-`approve`, both return the
      **first** decision with no state change; a last-write-wins implementation MUST fail this test.
- [ ] **Test (concurrent decision):** two processes enter `submitDecision` simultaneously (one `approve`, one `reject`) → exactly one wins, the other receives the first decision with no state change; a read-then-rename-without-lock implementation MUST fail this test.
- [ ] **Test (restart survival):** write a paused record, discard all in-process state, re-enter
      through the CLI → the run is still `awaiting-approval` and still decidable.
- [ ] **Test (never-auto-approve):** an expired record sweeps to `timed-out`, never `approved`; a
      search of `src/fleet/` finds no `state: "approved"` assignment outside `submitDecision`.
- [ ] **Test (e2e demo — MANDATORY):** one scripted run pauses, is approved by an allowlisted
      operator over stdin, and leaves `.sandbox/approvals/<run-id>.json` on disk carrying
      `approved` + `approverId` + `decidedAt` — that file is the artifact DF5.2 gates the PR on.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
