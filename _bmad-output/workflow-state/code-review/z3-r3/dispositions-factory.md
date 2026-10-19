# Z3 R3: factory-side dispositions

Owner: leaf-F (factory).<br />
Fork-side items are out of scope here: B-11 (observe id from `QA_LENS[index]`), E-3 (poller replay → `submit-in-flight`; named in the runbook triage) and A-10 (fork test wiring).<br />
TDD'd in `tests/z3/` (139 pass / 0 fail). The runbook edits are confined to the appended "Z3 round record" section of `docs/planning/v6-crossrepo-contract.md` (still append-only against `origin/dev`: +163, −0).

## Driver rulings

| Ruling | Disposition | What landed |
|---|---|---|
| 1. Hold window, REDESIGN (B-1/E-1/A-2, B-4/E-8) | PATCH | **The watcher kills the fork at the hold.** `armCrashWindow`: (1) a fresh `submitting` read; (2) a still-OPEN hold in the journal (`held` with no `expired`/`aborted`/`exec`), otherwise it aborts without killing, and a hold that already ended stands down with the cause named, e.g. `(held→expired)`; (3) a `stopped()` re-check; (4) the kill AT ONCE; (5) the round's last host retain runs while the fork is DOWN (the wiring serves the frozen last state, since a dead fork cannot change); (6) a `stopped()` re-check; (7) release, then restart. The hold now spans poll latency only. **The witnesses are observed, never hard-coded:** the journal lines carry `at`, and `driveCrashWindowRedrive` derives `heldAtKill` (a hold at or before `killedAt`, nothing ended before it) and `releasedAfterRetain` (the replay's `released` line ≥ `retainDoneAt`) from the journal. It records `gateJournal`, `retainDoneAt`, `releasedAt` and `holdAgeAtKillMs`. AC4 re-derives both from the recorded `gateJournal`. **Wrapper:** the hold limit is wall-clock (`$SECONDS`), and a TERM/INT trap journals `expired` and exits 99 without exec. Abort journals `aborted` (A-7). **Observe settle:** it never waits on the gated `z3-code-run` (killed at once, held pre-exec, provisions nothing). **Tests:** kill-before-last-retain ordering under a slow last retain (`slowLastRetainMs`); release after the retain; hold-expired before the kill means stand-down with that cause and no kill; AC4 negative controls for a journal showing the hold expired before the kill and for a release before the retain; the last observe's `settlePolls === 0`; wrapper TERM gives 99 with no exec; journal timestamps. |
| 2. Arm leak (B-2/E-2/E-5/A-3, B-9/E-12) | PATCH | `z3ScheduleIds()` snapshots the z3 schedules before arming. `armZ3Schedule(input, preArmIds)` sweeps on ANY failure: non-zero exit, a timeout (`FORK_ARM_TIMEOUT_MS` 240 s; runAt lead `ARM_LEAD_MS` 420 s > that), or unparseable/drifted output. The sweep re-reads `state` and disarms every z3 schedule not in the snapshot, then cancels every run each one fired (`sweepNewZ3Schedules`, every step runs). It throws an `AggregateError` with the original as `cause`. **End of cleanup:** a second `disarmSchedule` re-reads runs by scheduleId, cancels any fire that landed after the first disarm (flagged as a problem), and flags a schedule still `active`/`paused`. `disarmZ3Schedule` now returns `scheduleStatus`. **Pre-round failure path:** every step is guarded (gate abort, disarm, a cancel per fired run, none skipped), and errors become an `AggregateError` whose cause is the original error. Tests: late fire cancelled and flagged; still-active flagged. |
| 3. GO binding (B-7/E-6) | PATCH | Zero future tolerance (`at > now` is refused). **Chosen binding: CONSUME on fire.** `consumeOperatorGo` moves (link + unlink, so a concurrent consumer cannot both win) `operator-GO.json` to `<stamp>-operator-GO.consumed.json` once the gate passes. A second round finds no GO and refuses, and the consumed copy is the committed GO record. Documented in the runbook. Tests: 1 s ahead is refused; consuming moves the file, a second read refuses, and a second consume throws. |
| 4. Budgets (E-4/B-10) | PATCH | `Z3_LIVE_BUDGET` (live-round-wiring.ts) has the arithmetic written down. Cleanup = ⌈Σ `Z3_CLEANUP_STEPS_MS`⌉, built from the configured timeouts: disarm + re-read, ≤ 2 protocol cancels at 780 s, sweep, ONE parallel destroy pass (destroys now run in parallel), revoke-verify, two final-inventory + re-sweep passes, a leftover destroy, the residue re-check and a late cancel. That comes to 81 min. Test timeout = pre-round (≈15 min) + 300 min round + cleanup + 10 min margin. The round deadline is set from TEST START. Cleanup `state()` reads honour the cleanup deadline (round + cleanup), not the round's. `wiring.test.ts` recomputes the step sum independently and asserts cleanup ≥ it, pre + round + cleanup + margin ≤ timeout, the code run's share ≥ 1 h, and arm lead > arm timeout. |
| 5. Runbook (B-6/A-4) | PATCH | There is no `Z3_CODE_POLL_TIMEOUT_MS` (removed in R2; `codePollTimeoutFor` is derived, 2 h), and the round budget is stated as 300 min. The `MEMGATE_ADMIN_KEY` / `QDS_MEMGATE_SIGNING_KEY` exports and the `QDS_MEMGATE_LEDGER` override are in the mint step. Also added: the arm sweep, GO consumption, the budget line, the fork-down recovery (restart, then `cancel <protocolRunId>` and re-read `state`; A-8), and red-round triage (E-3 `submit-in-flight`; E-9(d) hibernation). |
| 6. `reflect` (E-11) | PATCH (justify + exempt + budget) | Justified: `reflect` is the only gateway-authenticated verb an M2.1 agent token can hold for a gateway-origin assertion (host = {reflect, retain}, bot = {consolidate}), and the call is host-side, never in-box. It is explicitly EXEMPT from `READ_ONLY_MEMORY_VERBS` (a rule that classifies BOX credentials), with a comment on `gatewayReflect`. Its LLM cost is budgeted: `Z3_REFLECT_CALL_USD` (0.05) × (QA legs + 2; the +2 are the priming call and the pre-GO probe) is printed on the spend line and added to what the GO must approve. The trigger's fleet-caps check stays fleet-only. The runbook contract delta now says "not read-only". Tests: GO covering fleet caps only is refused; the spend line names the allowance. |
| 7. D-1 (ADR-2 ACCEPTED) | PATCH | Every "PROPOSED" in the code and tests is gone. AC2's messages now read "treating ADR-2 as license to auto-merge before its implementing story lands fails" (merge-event path and decision-source path), and the AC2 negative control is renamed accordingly. Recorded as contract delta **D-1** in the runbook: accepted 2026-10-15 (G1), auto-merge unimplemented, its S05b queue precondition unbuilt, and Z3 still asserting park → human decision. The story text itself is driver-owned (`_bmad-output/sprint-artifacts/**`). |

## Acceptance auditor

| ID | Disposition | Fix / rationale |
|---|---|---|
| A-1 | PATCH | `git update-index --chmod=+x scripts/z3/fleet-gate.sh`: the index now shows `100755`. NOTE for the driver: update-index on the intent-to-add entry also staged the file's content at that moment, so re-`git add` before the commit. A new test asserts `git ls-files -s` reports `100755`. |
| A-2 | PATCH | Ruling 1. |
| A-3 | PATCH | Ruling 2. |
| A-4 | PATCH | Ruling 5. |
| A-5 | PATCH | The wiring header now documents the four-verb contract (`disarm` and `inFlightRequestIds` included) and the exact run keys. |
| A-6 | DISMISS (known debt) | The fixture is hand-mirrored. It was refreshed this round to carry the real observe entry (`observe-<uuid>` requestId, `submittedAt`, `pollAttempts`, `lastError`) and a pretty-printed verdict with the real title. A generated cross-repo artifact is out of scope for this PR. Noted in the fixture's `_note`. |
| A-7 | PATCH | The wrapper journals `aborted` (a distinct phase in `GateLine`), and the tests assert it. |
| A-8 | PATCH | Ruling 5 (fork-down recovery step). |
| A-9 | DISMISS (driver-owned) | DoD ticks are in the story file (`_bmad-output/sprint-artifacts/**`, the driver's ownership). |
| A-10 | DISMISS (fork-side) | The fork test wiring follows house convention (none of the 39 sibling `scripts/solstice/*.test.ts` are wired). Fork leaf's call. |

## Blind hunter

| ID | Disposition | Fix / rationale |
|---|---|---|
| B-1 | PATCH | Ruling 1. |
| B-2 | PATCH | Ruling 2. |
| B-3 | PATCH | A-1. |
| B-4 | PATCH | Ruling 1 (wall-clock hold + TERM/INT trap). |
| B-5 | PATCH | Every cleanup receipt string is scrubbed and bounded (`tail`, 600 chars) before the writer sees it. When the full record is still refused, a MINIMAL record lands (runIds, `{runId, exitCode}` destroy receipts, `{phase, ok}` revoke receipts, leftovers, a problem count), so AC7 always has its record. Destroy stderr is also cut at 600 at source. Test: a receipt carrying a bare `sk-or-` prefix still yields a cleanup record that passes AC7. |
| B-6 | PATCH | Ruling 5. |
| B-7 | PATCH | Ruling 3. |
| B-8 | PATCH | `preflightFork` RUNS the wrapper in the container (`fleet-gate.sh help`; exits 98, 126, 127 or a null exit are refused), and probes `sleep 0.1 && mktemp`. |
| B-9 | PATCH | Ruling 2 (guarded pre-round path, AggregateError). |
| B-10 | PATCH | Ruling 4. |
| B-11 | DISMISS (fork-side) | `protocol-z3-exit-round.ts` builds the observe ids; the fork leaf owns it. Factory AC6 fails loudly on a mismatch, never silently. |

## Edge-case hunter

| ID | Disposition | Fix / rationale |
|---|---|---|
| E-1 | PATCH | Ruling 1 implements (b) a still-open-hold check right before the kill, and (c) no settle wait on the gated submit. (a), the replay-on-expiry exit 1, is not adopted: with the kill at the hold, the hold spans only poll latency, and a 99 keeps "a dead driver never spends" deterministic. |
| E-2 | PATCH | Ruling 2. |
| E-3 | DEFER (fork-side) | A pre-existing fork poller race (`submit-in-flight` exit 5 is not a replay code). Named in the runbook's red-round triage, for the fork leaf / driver to file. |
| E-4 | PATCH | Ruling 4. |
| E-5 | PATCH | Ruling 2 (end-of-cleanup residue re-check). |
| E-6 | PATCH | Ruling 3. AC7's `go.when <= firedAt` and the gate's zero-future check now agree, because the gate compares on the host clock against `now` and the fork fires later. |
| E-7 | PATCH | The #465 `pausing` clock resets only on a REAL non-pausing payload. A transient `fleet result` failure no longer resets it. |
| E-8 | PATCH | Ruling 1 (wall-clock). |
| E-9 | PATCH (a, c, d) / DISMISS (b) | (a) preflight lists the runs dir (`RunRecordStore.list()`; a `listing-partial` refuses). (c) a pre-GO `preflightGateway` reflect through the gateway for the resolved bank. (d) `awaitTrigger` fails fast when the schedule is still unfired 4 min past its `runAt` (hibernation, a stalled tick); the live deps now take `runAt`. (b) DISMISS: proving real-cli's cwd and runs dir would need a fleet round trip through the container's exe.dev credentials. The B-8 wrapper-runs probe covers the exec chain, and a wrong runs dir fails closed on the first `readRecord` (documented in the runbook). |
| E-10 | PATCH | The fixture observe entry is realistic, and `protocolFleet` filters out `observe-*` requestIds (they are not fleet submits). |
| E-11 | PATCH | Ruling 6. |
| E-12 | PATCH | Ruling 2. |

## Verification (z3-r3/verification.md)

| ID | Disposition | What landed |
|---|---|---|
| N-1 (MED) | PATCH | Every fork CLI call now runs as `docker exec … timeout -s KILL <host timeout − 15 s> npx tsx …`, because killing the `docker exec` client does not kill the in-container process. When the host times out, the in-container CLI is already dead. `preflightFork` refuses an image without coreutils `timeout`. On ANY arm failure, `armZ3Schedule` sweeps once immediately, waits `IN_CONTAINER_KILL_MARGIN_MS` (by then the in-container arm is dead by construction), and sweeps a SECOND time, both before runAt. `ARM_LEAD_MS` = arm timeout + kill margin + a second sweep (state + disarm + a cancel), ≈ 9.3 min. The arm path is injectable (`ForkCli`). New test: a timed-out arm whose row persists late (visible only on the second state read) is disarmed and its run cancelled by the second sweep, and a pre-existing schedule is never touched. |
| N-2 | DISMISS (fork-side) | Engine re-entry while the poller holds the in-flight key (`protocol-factory.ts`) belongs to the fork leaf. |
| N-3 | PATCH | `killFork` takes its snapshot first and sets `frozen` only after `docker kill` returns. A failed kill leaves a live fork, read live. |
| N-4 | PATCH | AC4 counts the `exec` lines in the recorded `gateJournal` itself (exactly one), never trusting `submitExecs`. `exec` joins `expired`/`aborted` in the pre-kill ended set, and the comparison is fail-closed at the journal's 1 s resolution: an end line in the kill's own second counts as BEFORE it, in both the driver and AC4. Negative controls: a journal with two execs (the driver field says 1), and an exec in the kill's own second. |
| N-5 | PATCH | `consumeOperatorGo` removes its own `<stamp>-operator-GO.consumed.json` link when it loses the race at `unlink`, then rethrows, so no stray record is left. The live test runs the setup checks (crash-gate arm, the z3 schedule snapshot) BEFORE consuming the GO, so a setup refusal never burns it. |
| N-6 | PATCH | The tautological `pre + round + cleanup + margin ≤ testTimeout` assertion is gone. It is replaced by an independent recomputation from the configured constants: pre-round now includes the ARM_LEAD_MS wait; the round = `Z3_FORK_STEPS_BUDGET_MS` (300 min) + `Z3_ROUND_SLACK_MS` (10 min fork-heartbeat slack); cleanup now includes `watcherStandDown` (one state outage + a read). `codePollTimeoutFor` divides the fork step budget, not the slack. A new test checks the arm lead against the arm timeout + kill margin + second sweep. |
| N-7 | PATCH (reworded against source) | D-1, the AC2 messages and the runbook now say what the source says: G1 shipped `src/fleet/auto-merge-policy.ts` (`readAutoMergePolicy`) and the run-completion `consultAutoMerge`, both fail-closed, and ON is structurally unreachable until the clause-5 veto-window carrier (`enqueueVetoWindow`) is in the tree (the loader returns `off`/`clause5-carrier-absent`). AC2's shared message (`ADR2_LICENSE`): "treating ADR-2 as license to auto-merge while ON is structurally unreachable (the clause-5 veto-window carrier `enqueueVetoWindow` is not in the tree) fails". **New INV-Z3-2 assertion:** a pre-fire, read-only probe (`readAutoMergePolicy({cwd})`, the loader the consult uses) runs at the trigger leg and records `autoMergePolicy`. The driver fails the trigger on ON. AC2 fails when the state is ON, unrecorded, or the decision carries the policy approver id `policy:adr-2`. Negative controls: policy ON at the fire, policy state unrecorded, and a `policy:adr-2` decision. The story note is the driver's. |
