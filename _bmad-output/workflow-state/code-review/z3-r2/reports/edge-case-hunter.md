# Z3 R2: edge-case hunter

Scope: the R1 post-image in both repos. Factory: `scripts/z3/*`, `tests/fleet/e2e/z3-exit-round.live.test.ts`. Fork worktree `z3-sc`: `scripts/solstice/z3-exit-round.ts`, `protocol-z3-exit-round.ts`, `runtime/scheduler.ts`.<br />
I checked every claim against source, including fork `protocol-factory.ts`, `protocol-factory-exec.ts`, `protocol-factory-lifecycle.ts`, `protocol-step-processors.ts`, `heartbeat-service.ts`, factory `src/memgate/*` and `sc2-harness.ts`.<br />
I do not re-raise R1 items, with two exceptions where the R1 fix is incomplete: E-4 (B-3/A-4 stand-down) and E-5 (E-20 attribution). Both say so below.

Verified clean, no finding:
- The branch catch-all. `cases.find` takes the first match. `normalizeCondition` keeps `count: 0`. A zero-case branch throws before it reaches any decider.
- Scheduler try/catch. A refusal fails only that schedule, and `continue` skips the `schedule_fired` push.
- The memgate verbs parse. `claims_json` is the scope object with top-level `verbs` (gateway.ts:109/369). Per-run scope is the literal `["recall"]` tuple.
- The workId regex. The fork stamp `w:z3-YYYYMMDDTHHMMSSZ-code` matches `^w:z3-.+-code$`, and `w:qa-*` never matches.
- Brief parsing. `JSON.stringify` has no spaces and `workId` precedes `instructions`, so `head -n 1` is the real field. An escaped `\"workId\":` inside the instructions cannot match.
- Replay reuse. After restart only the single-flight poller replays a `submitting` entry (protocol-factory.ts:288). The step loop parks on it (protocol-run-lifecycle.ts:589-596), so one exec follows the release.

---

### E-1 [HIGH] solstice `scripts/solstice/z3-exit-round.ts:88-107` and factory `scripts/z3/live-round-wiring.ts:120,363`

**Problem.** The fork CLI's `state` emits no `artifacts` per run. It also drops each event's `summary`. The factory's `RunSchema` has `artifacts: z.array(...).default([])`, so the omission parses cleanly and `awaitProtocolComplete` returns `artifacts: []`. `driveBranchAndComplete` (leg-drivers.ts:470-500) then finds no `factory_result`:
- `no factory_result for <id> (F-011)` for every run
- `code run verdict null, not approved`

The live round cannot go green, even on a perfect run. The fixture (tests/z3/fixture.ts:180) injects `artifacts` itself, so the fixture tier never sees the gap. The `.default([])` on `steps`, `factoryState`, `events` and `artifacts` is the same kind of silent drift that R1's A-7/B-20 zod work was meant to make loud.

**Scenario.** A clean live round: QA legs, park, approve, `branch_taken approved`. It ends red at branch-and-complete, with AC1 and AC2 failing on missing results.

**Fix.**
- Fork: add `artifacts: (r.artifacts ?? []).map(({ kind, content }) => ({ kind, content }))` to the `state` run map, and `...(e.summary ? { summary: e.summary } : {})` to the event map.
- Fork test: pin both fields.
- Factory: drop `.default(...)` from `artifacts`, `steps`, `factoryState` and `events` in `RunSchema`, so a missing contract field throws.

### E-2 [HIGH] `tests/fleet/e2e/z3-exit-round.live.test.ts:94-113` and `scripts/z3/leg-drivers.ts:713-721`

**Problem.** Every failure between `armZ3Schedule` persisting the row and `driveTrigger` binding the run leaves a live, armed schedule that nothing cancels:
1. The test throws on `capProblems` (line 110). The message asks the operator to "remove that schedule fork-side before it fires", inside a 120 s `ARM_LEAD_MS`, with no committed verb to do it.
2. `ArmSchema.parse` throws after the row persisted. The fork returns `protocolConfig ?? null`, and the schema requires a record.
3. Inside `runZ3Round`, `d.inventory()` (ssh) throws at line 714 before the fire.
4. `awaitTrigger` throws: two runs for the schedule, a state drift, or the deadline.

In cases 3 and 4, `runCleanup` gets `protocolRunId: null` and skips the protocol cancel. In case 1 the test throws before `runZ3Round`, so there is no cleanup at all and no gate abort (the gate stays armed). The fork CLI has no schedule-disarm verb, and `cancel` only takes a protocolRunId of a run that already exists.

**Scenario.** `ssh exe.dev ls` blips at line 714. The round fails in about a second. Two minutes later the schedule fires, and every QA leg spends its cap with no watcher. In cases 2-4 cleanup has already aborted the gate, so `armed` is gone and the code run passes straight through (see E-3): a box plus the code cap, parked at awaiting-approval, with nobody to clean up.

**Fix.**
- Fork CLI: add `disarm <scheduleId>`, which sets the schedule to a non-firing status and then runs the existing `cancel` for any run whose `scheduleId` matches.
- Factory: open the `try/finally` in the test immediately after `armZ3Schedule` returns, and have its `finally` disarm by scheduleId.
- Factory: in `runCleanup`, always disarm by the armed scheduleId, not only when a run was bound.
- Wrap `armZ3Schedule` so that a parse failure after persist disarms. Its stdout's scheduleId can be read leniently before the strict parse.

### E-3 [HIGH] `scripts/z3/fleet-gate.sh:54-58` and `scripts/z3/crash-gate.ts:50-54`

**Problem.** The wrapper reads `abort` only inside the `armed && code-workId` branch, and `crashGate.abort()` deletes `armed`. Once cleanup aborts, the wrapper is a pure pass-through for the z3 code submit. The header's guarantee ("a failed round never releases spend") holds only for a submit that is already held at abort time. It does not cover a code submit that arrives after the abort, which happens whenever the fork protocol cancel does not stop the run:
- `cancelProtocolRun` failed (it is guarded, and the failure is recorded and swallowed)
- it timed out (E-7)
- there was no bound run (E-2)

**Scenario.** The round fails at the first findings-retain, which is the known E-2 blocker, so this is every live round today. Cleanup aborts the gate. The fork cancel times out at 120 s mid-way. The fork keeps chaining: the remaining QA legs, then `z3-code-run`. The submit finds no `armed` file, the wrapper journals `exec`, and the code run provisions after the round has already been reported failed. Cleanup's sweep ran earlier, so this box is outside `runIds`.

**Fix.** In the wrapper, test `abort` first for any `submit` whose workId matches `^w:z3-.+-code$`, whatever `armed` says: journal `expired` and exit 99. Exit 99 is not in `REPLAY_EXIT_CODES`, so the step fails and spends nothing. `abort()` should stop deleting `armed` (`arm()` already clears `abort` for the next round). Add one fixture test: disarmed + abort + code submit gives 99 and no `exec`.

### E-4 [HIGH] `scripts/z3/leg-drivers.ts:537-559` (R1 B-3/A-4 stand-down: the fix is incomplete)

**Problem.** `stopped()` is checked only inside `awaitStepSubmitting`'s poll loop. Once that returns, `armCrashWindow` always kills the container, releases the gate and restarts it, whatever `stopped()` says. The round's `finally` awaits the watcher before `runCleanup` (lines 752-754), so the release lands before cleanup's abort, while `armed` is still present. The restarted fork then replays the code submit through an open gate. Separately, `release` runs even when `kill` failed (`killErrors` non-empty), which lets the still-running held submit through in a container that was never killed.

**Scenario.** The fork chains without waiting for the driver. It reaches `z3-code-run`, and the submit is held. In the same window the main path fails, for example on the last lens's forensics. `finally` sets `stopped = true` and awaits the watcher, which is already past its poll. The watcher kills, releases and restarts. The replay execs, with a real box and the code cap, and the cleanup that follows can only cancel a submit that is already in flight. That is exactly the case E-5 orphans.

**Fix.**
- In `armCrashWindow`, re-check `stopped()` after the hold-wait loop and before `killFork`. If it is set, throw without releasing, and cleanup's abort then exits the held submit with 99.
- Call `crashGate.release()` only when `killErrors` is empty and `!stopped()`. Otherwise call `crashGate.abort()`.
- Add one fixture test: `stopped` flips between `awaitStepSubmitting` and the kill, and the test asserts no release was written.

### E-5 [MED] `scripts/z3/leg-drivers.ts:629-658` and `scripts/z3/assertions.ts:434-458` (R1 E-20 attribution: the fix opens an excuse)

**Problem.** A submit that is in flight when the protocol run is cancelled orphans its fleet run. A real provision takes minutes (SC2.6 calibration, `FLEET_EXEC_TIMEOUT_MS` 300 s). When the ack returns, `processExternalJobStep` re-loads the run, sees it is cancelled, and returns without persisting `runId` (fork protocol-factory.ts:197-198, the F-004 guard). The run's id then exists nowhere the cleanup looks:
- The fork CLI's `fleetRunIds` keeps only entries that already have a `runId` (z3-exit-round.ts:125-127).
- `protocolFleetRunIds` reads only `factoryState[*].runId`.
- The factory has not tracked it yet: `driveKillAndProvision` had not returned.

The box then appears in the final inventory as `unattributedFreshBoxes`. That field is recorded "for the operator, not charged", and no assertion reads it. A real leak of this round becomes an excused, unattributed box. The provider key minted by that provision lands after `revokeVerify` ran, so the baseline diff does not see it either.

**Scenario.** This is E-4's release-then-fail, or any failure while a QA leg or the code replay is mid-provision. Cleanup reports green on box and key, and a box runs to its TTL.

**Fix.**
- In `runCleanup`, collect every `requestId` from the bound run's factoryState (one fresh `state`). Map them through `d.recordsForRequestId` (the host run-record store holds the requestId) into `runIds` before destroy.
- Re-run that mapping after the final inventory, so a provision that lands late is still attributed.
- In AC7, charge any fresh box whose run record carries one of this round's requestIds, and keep `unattributedFreshBoxes` for truly foreign boxes only.

### E-6 [MED] `scripts/z3/live-round-wiring.ts:296-316`

**Problem.** The fork's new fire-refusal arm (scheduler.ts:507-528) marks the schedule `failed`, writes history `reason: z3_fire_refused`, and creates no run. `awaitTrigger` filters only `runs` by scheduleId and never reads the `schedules[]` that `state` already returns with `status`. A refused fire therefore polls for the whole `ROUND_BUDGET_MS`, 200 minutes, before the round fails with "the schedule fire did not happen".

**Scenario.** The persisted row is refused at fire time: a tampered cap, or a `commitSha` that drifted between arm and fire. The test hangs 3h20m and then reports a deadline instead of the refusal.

**Fix.** In the `awaitTrigger` loop, find `schedules` by `id === opts.scheduleId`. When its `status === "failed"` (or the schedule is missing), throw at once with the schedule's status. Add one wiring test with a failed schedule and no run.

### E-7 [MED] `scripts/z3/live-round-wiring.ts:137,356`

**Problem.** `forkCli` defaults to a 120 s timeout, and `cancelProtocolRun` uses it. Fork `cancel` performs these steps:
1. The action's fire-and-forget `cancelFactoryRuns`.
2. An awaited `cancelFactoryRuns`.
3. A sequential, exit-checked `fleet cancel` per outstanding runId. Each is a box destroy plus key revoke under `FLEET_EXEC_TIMEOUT_MS` = 300 s, and steps 1 and 2 already ran up to two more per runId.

With two or three outstanding runs on a failure path, 120 s is short. When `Bun.spawnSync` kills the `docker exec` client, the process inside the container keeps running. The factory records "fork protocol cancel FAILED" and loses `fleetCancelled`. The in-container cancel then races `destroyBoxes`, which is idempotent, so that is benign. What matters is that the fork run may not be cancelled yet when cleanup proceeds, which feeds E-3.

**Fix.** Give `cancel` its own timeout sized to the worst case, for example `(Z3_MAX_FLEET_RUNS + 1) × 300_000`. Alternatively, have the fork `cancel` only mark the run and leave the destroys to the factory's `destroyBoxes`, which already exit-checks each one.

### E-8 [LOW] `scripts/z3/fleet-gate.sh:32,56-71`

**Problem 1.** The hold limit is unreachable. The fork's `execFile` timeout is 300 s (protocol-factory-exec.ts:14), so a held wrapper is SIGTERMed long before `HOLD_LIMIT_S=900`. Node reports a signal kill as code -1, which is in `REPLAY_EXIT_CODES`. The poller then re-submits, and the wrapper re-holds and journals a new `held` line. This repeats until the code step's 1 h deadline, when `cancelAndFail` runs. The header's "the driver died before releasing: refuse (the step fails, nothing spent)" path never executes. Nothing is spent, but the wrapper and the evidence describe a different mechanism from the one that runs.

**Problem 2.** SIGTERM orphans the real CLI. When a submit is SIGTERMed during `printf | "$REAL"`, bash dies without forwarding the signal, so the real CLI keeps provisioning while the fork replays the same requestId. Unwrapped, the real CLI itself would have received the SIGTERM. For the code run's post-release replay this writes a second `exec` line for the requestId, and AC4 turns false-red. QA legs hit it too: their exec timeout semantics change silently.

**Fix.**
- Set `HOLD_LIMIT_S` below 300, for example 240, so the expiry path is the one taken. Alternatively, document the re-hold loop as the real behaviour.
- For the pass-through, run `"$REAL"` in the background, `trap 'kill -TERM $child' TERM`, then `wait`, so a timeout reaches the real CLI.

### E-9 [LOW] `scripts/z3/fleet-gate.sh:43`

**Problem.** `brief="$(cat)"` buffers stdin for every verb. The fork always closes stdin (`child.stdin.end(input)`), so fork-invoked verbs are fine. An operator who runs `$SWARMCLAW_FACTORY_FLEET_CLI status` from a terminal is not: the Z4 runbook's G7 verify ritual and the §7 smoke do exactly that, and crash-gate.ts says the wrapper "may stay configured". That command blocks on the tty forever.

**Fix.** Buffer only for `submit`. Make every other verb `exec "$REAL" "$@"`, which also keeps their stdin and signal semantics byte-exact.

### E-10 [LOW] `tests/fleet/e2e/z3-exit-round.live.test.ts:95-107`

**Problem.** The live test never passes `codePollTimeoutMs`, so the code run's deadline is `QA_POLL_TIMEOUT_MS` = 1 h. That hour counts from the FIRST attempt's `submittedAt`, which is persisted before the hold. The following must all fit inside it before `fleet approve` lands, or the fork's `factoryDeadlineExceeded` runs `cancelAndFail` on the parked run:
- hold
- kill and restart
- replay provision
- the code pipeline running to park
- the driver's crash-window, priming, park and forensics legs

The round budget is 200 minutes, so the two limits disagree.

**Fix.** Arm with `codePollTimeoutMs` from a required env value, `Z3_CODE_POLL_TIMEOUT_MS`, sized below `ROUND_BUDGET_MS`. Record it in the trigger leg.

### E-11 [LOW] `scripts/z3/live-round-wiring.ts:31-33` and `scripts/z3/crash-gate.ts:8-12`

**Problem.** Two operator-setup gaps, plus a header comment that does not match the code:
- **Wrong cwd claim.** The wiring header says "the fork's fleet child runs with cwd=/factory". In fact `runFleetVerb`'s `execFile` sets no cwd, so the child runs in the fork's `/app`, and the SC2.5 allowlist strips `QDS_RUNS_DIR`. The real-cli shim must `cd` and choose the runs dir. If the checkout `.env` sets a non-default `QDS_RUNS_DIR`, the host's `RUNS_DIR` reads a different store from the one the fork's CLI writes. Records, ledger and recall then read as absent: the round fails closed, but with misleading AC3/AC4 reds.
- **Missing mount step.** OPERATOR SETUP never says to bind-mount the factory clone into the fork container at `/factory`, and the stock compose has no such mount. Under a `:ro` mount, `>> "$J"` fails without stopping the wrapper (`set -u`, not `-e`). The journal stays empty, `heldAtKill` is false, and the round fails after the window was in fact held.

**Fix.**
- Correct the header.
- Add the mount (read-write) and a "real-cli must cd to the clone and use the same runs dir" line to OPERATOR SETUP.
- Before arming, have `crashGate.arm()` run a container-side probe: `docker exec <c> sh -c 'echo probe >> /factory/.sandbox/z3-gate/probe'`. Read the probe back on the host and refuse on a mismatch.
