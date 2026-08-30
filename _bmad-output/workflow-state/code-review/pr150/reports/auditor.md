# Acceptance Audit — PR #150 (DF3.4: Tier-1 Pre-PR Approval Gate + `attach` Steering)

Audited the five source chunks (gate, approvers/attach, verbs/status, CLI, engine) against the
story's ACs, security invariants, bounds, and exit-code/ordering guarantees, verifying every
candidate against the on-disk source at the PR head. The Dev Agent Record's ten deviations and the
round-6 review record (patches, dismissals, defers) were treated as settled; everything I checked
behind them (lock topology, `teardownSandbox` signature, no redundant `revokeAndVerify`,
`copyFile`→`exec cat`, drain-time ack, char-ceiling attribution, `supersededReportIds` authorship,
expiry-sweep split, fast-refusal attach, `schemaVersion` 2) matched the real code.

What survives verification:

- **[MEDIUM]** Deviation 8's substitute bundle guard is dead code on the only production path — `src/fleet/approval-gate.ts:668-670`
  - AC/constraint: AC1(a2) (story :84-88 — a rebind is validated against the bundle before the
    replace commits, refused on mismatch) as substituted by Deviation 8 (story :393), whose recorded
    evidence states: "Rebind re-validates by `existsSync(join(resolveRunsDir(...), runId + ".bundle"))`…
    The existence check is strictly stronger: it proves the bundle is there *now*."
  - Evidence: the code does not do what the record claims. `assertBundlePresent` returns immediately
    when `deps.bundleDir === undefined` (`approval-gate.ts:669`: `if (deps.bundleDir === undefined) return;`),
    and the one non-test caller of the gate — `recordApprovalPort(deps.store ?? new RunRecordStore({ dir: runsDir }))`
    at `src/reverify/runner.ts:406` — passes no `opts` (`recordApprovalPort(store, opts = {})`,
    `src/reverify/approval.ts:73`). A grep of `src/` and `scripts/` shows no caller anywhere supplies
    `bundleDir`. So on the shipped path neither the first request nor an AC1(a2) rebind ever validates
    bundle presence, and the record's evidence string (`resolveRunsDir(...)`) describes code that does
    not exist. The module's own docstring is honest about it ("Absent ⇒ no bundle claim to check",
    `approval-gate.ts:554-558`); the Dev Agent Record is not. Practical risk is low — a green
    ReverifyReport implies the bundle was just read — but this is a fail-closed guard in the
    security gate that is silently inert in production, recorded as enforced.
  - Severity: MEDIUM

- **[LOW]** `fleet status` relabels `pausing` rows as `awaiting-approval` and omits their time remaining — `src/fleet/status.ts:439-456`
  - AC/constraint: AC7 (story :172-178): "Given runs with `extensions.approval` in `pausing` or
    `awaiting-approval`… each paused run appears with its state, its bound `reportId`, and time
    remaining before `expiresAt`."
  - Evidence: `approvalRowFields` maps a `pausing` extension to `{ state: "awaiting-approval", reportId? }`
    with **no** `expiresInMs` (`status.ts:451-456`; the countdown is only attached on the
    `awaiting-approval` path at `:467-471`). So one of the two states AC7 names appears (a) under a
    state string the record does not hold and (b) without the time-remaining field AC7 requires of
    "each paused run". The choice is argued in the code comment (`status.ts:432-437` — `pausing`
    never expires per `expiredState`, so a countdown would run to zero and change nothing), which is
    a reasonable reading of intent, but it is a deviation from AC7's letter that is not among the ten
    recorded deviations (Deviation 9 covers only the derive-vs-persist sweep split). Display surface
    only; no state corrupted.
  - Severity: LOW

Everything else checked and found conforming (no finding): AC1 evidence-first ordering and
`pausing` resume; AC1(a2) rebind/CAS semantics incl. `supersededReportIds` append rules and
`expiresAt` restamp; AC2 first-decision-wins incl. the post-expiry decision landing as
`already-decided` on the persisted `timed-out`; AC3 lazy expiry before the invocation's own
decision, `system:timeout` reserved and unforgeable; AC4/INV-APPROVE-2/3 fail-closed allowlist
(mode 0600, ownership, ancestor walk, containment, regular-file check — `src/providers/allowlist-path.ts:191-217`),
empty id/empty allowlist refuse, token from stdin only with cumulative+stall budgets; AC5 refusal
surface (wider than spec: any approval state plus `closedAt`, extension never mutated — the fast
refusal race is Deviation 10); AC6 stdin-only payload, constant argv script, messageId dedupe,
30 000 ms ceiling → `attach-not-acked` with the message left queued, ack at drain/fold (Deviation 5),
no fourth solicitation point, inbox folded before the resident status gate with `promptContext`
persisting across solicitations (`scripts/pipeline-run.ts:676,1827`); INV-APPROVE-9 writeSync exit
paths (`scripts/fleet.ts:3510-3534`); observability contract incl. the previously-deferred `pause`
event now emitted from the gate with `record_write_ms`/`teardown_at_pause_ms`, and
`decision_wait_ms`/`attach_rtt_ms` on the CLI events; DoD exports
(`requestApproval`/`submitDecision`/`awaitDecision`/`sweepExpired`) all present.
