# Z3 R3: verification of the round-3 fixes

Verifier: read-only pass over the factory (`git diff origin/dev`) and the fork worktree `solstice-ai/.claude/worktrees/z3-sc` (`git diff origin/dev`). Nothing was edited.<br />
Date: 2026-10-19

## Gates run

| Gate | Result |
|---|---|
| Factory `bun test tests/z3` (`env -u AI_AGENT -u CLAUDECODE`, log `/tmp/z3v.log`) | **139 pass / 0 fail** |
| Fork `protocol-factory.test.ts` + `protocol-z3-exit-round.test.ts` + `scripts/solstice/z3-exit-round.test.ts` | **60 pass / 0 fail** |
| Factory `bunx tsc --noEmit` | exit 0 |
| Factory `bunx @biomejs/biome check scripts/z3 tests/z3 tests/fleet/e2e/z3-exit-round.live.test.ts` | exit 0 (14 files) |
| `git ls-files -s scripts/z3/fleet-gate.sh` | `100755`, index blob matches the worktree (A-1/B-3 closed) |

## Verdicts on the six items

| # | Item | Verdict |
|---|---|---|
| 1 | Hold redesign | **CLOSED** (two LOW notes, N-3 and N-4) |
| 2 | Arm-leak sweep, end-of-cleanup re-check, AggregateError cause | **OPEN (MED)**: N-1 |
| 3 | GO consumption | **CLOSED** (LOW note N-5) |
| 4 | Budget arithmetic and its test | **CLOSED** (LOW note N-6) |
| 5 | Fork E-3 `submitsInFlight` guard | **CLOSED** for the poller path (LOW new defect N-2 on the engine path) |
| 6 | D-1, the ADR-2 wording | **OPEN (LOW)**: N-7 |

### 1. Hold redesign: CLOSED

- **Kill at the open hold.** `armCrashWindow` (`scripts/z3/leg-drivers.ts:605`) waits for a fresh `submitting` read, then for a `held` line (up to 5 s). It stands down, aborting the gate without a kill, when the journal shows no hold (`none`) or an ended hold (`expired`/`aborted`/`exec`, `holdState` at `:581`). It then kills. Between the last `state()`/`stopped()` check (`:619-625`) and `d.killFork()` (`:631`) the code is synchronous: there is no `await`, so `stopped` cannot flip and the round cannot interleave. A container whose code step already expired or aborted is never killed by the watcher. A step that already reached `failed`/`submitted` throws from `awaitStepSubmitting` (`live-round-wiring.ts`, the `awaitStepSubmitting` pick), also with no kill.
- **The last QA tail runs while the fork is down.** The fork protocol is sequential (no `dependsOnStepIds`). `z3-code-run` follows `qa-observe-<last>` (`protocol-z3-exit-round.ts`, `buildZ3ExitRoundSteps`), so at the kill every fork-side QA step is done. The remaining tail (`awaitResult`, forensics, the last observe, retain) is host-side or served from `frozen` (`live-round-wiring.ts:483-494`, `:638-644`). `observeDeltas` excludes `Z3_STEP.codeRun` from in-flight siblings (`leg-drivers.ts:~363`), so the last observe does not wait on the held submit.
- **Release and restart only after the last retain.** The `retainDone()` loop (`:635-640`) is followed by a `stopped()` re-check (`:641`), then `release()` and `restartFork()` with no `await` in between. Nothing can restart after `stopped()`: every stopped branch goes through `standDown`, which writes `abort` and throws, so the replay later exits 99. `runZ3Round`'s `finally` sets `stopped` and then awaits the watcher before `runCleanup` (`:917-919`).
- **The witnesses are observed.** `driveCrashWindowRedrive` derives `heldAtKill` and `releasedAfterRetain` from `crashGate.journalFor` (`:668-673`). AC4 re-derives both from the recorded `gateJournal` (`assertions.ts:307-320`) and checks the driver flags as well.
- **Wrapper.** `fleet-gate.sh` uses `deadline=$((SECONDS + HOLD_LIMIT_S))`, a wall-clock limit (240 s < the fork's 300 s execFile timeout). `trap 'jline expired; rm -f "$tmp"; exit 99' TERM INT` is installed before `jline held` and cleared before `released`. The trap path and the abort path both exit 99 without an `exec`. The `sleep 0.1` in the foreground only delays the trap by ≤ 100 ms.

### 2. Arm-leak sweep: OPEN (MED), see N-1

What holds:
- `armZ3Schedule` (`live-round-wiring.ts:264-281`) sweeps on any failure (exit, timeout, zod) against the pre-arm snapshot and throws `AggregateError([original, ...errors], …, { cause: original })`.
- In the live test, the failure paths after the arm (caps mismatch, deps construction) go to the guarded catch (`z3-exit-round.live.test.ts:198-223`): abort, disarm, and a cancel for each fired run, each guarded. That catch also uses `{ cause: original }`.
- The end-of-cleanup re-check (`leg-drivers.ts:~800-812`) re-runs `disarmSchedule`, cancels late fires, and flags a schedule that is still `active`/`paused`.

What does not hold: the sweep after a **timed-out** arm can run before the arm it is sweeping has finished (N-1).

### 3. GO consumption: CLOSED

`consumeOperatorGo` (`round-plan.ts:267-272`) uses link then unlink. Exactly one concurrent consumer can succeed at `unlink`, and a same-stamp second consumer gets EEXIST at `link`. Zero future tolerance is in place: `at > now` throws (`round-plan.ts:250`).

Can a GO be consumed and then refused in a way that loses the record? No. The refusals that can follow the consume in the live test are `crashGate().arm()`, `z3ScheduleIds()` and the arm path (`live.test.ts:124-137`). Each of them leaves `<stamp>-operator-GO.consumed.json` on disk:
- the file is not gitignored (`git check-ignore` returns rc 1 for `_bmad-output/evidence/v6-z3/…consumed.json`);
- `readLegFiles` does not read it as a leg (it has no `-z3-` in its name).

The record survives, and the GO is burnt fail-closed. See N-5 for two hygiene points.

### 4. Budget arithmetic: CLOSED

I recomputed the steps by hand: disarm 300 s, cancels 1560 s, sweep 300 s, destroy 300 s, revoke 300 s, final inventory 360 s, leftover destroy 300 s, second final inventory 360 s, residue 300 s, late cancel 780 s. That sums to 4860 s = 81 min, matching `Z3_LIVE_BUDGET.cleanupMs`. `wiring.test.ts` recomputes the sum independently and asserts the code run's share is ≥ 1 h and `ARM_LEAD_MS > FORK_ARM_TIMEOUT_MS`. Cleanup `state()` reads honour `deadline + cleanupMs` (`live-round-wiring.ts:505`). See N-6 for small gaps.

### 5. Fork E-3 guard: CLOSED (poller path)

`protocol-factory.ts:143-145` (the check) and `:195-202` (`add` before the `try`, `delete` in `finally`):
- **Exceptions.** `buildSubmitCall` runs before `add`, so a sync throw leaks no key. A throw from `runFleetVerb` is deleted in `finally`. `failOrAdvance` starts before the delete, which is harmless.
- **No gap.** Between the `submitting` persist and `add` there is no `await` (`persistRun`, `appendProtocolEvent` and `buildSubmitCall` are sync), so a poller tick cannot slip in.
- **Crash/restart.** The Set is process-local, so it is empty after `docker kill`. The SC2.6 replay is unchanged, and the Z3 replay runs through the poller with a fresh key.
- **Legitimate replays.** A replay is suppressed only while this process's own exec for the same `${runId}:${stepId}` is outstanding. That exec's outcome is handled by its owner: a replay code persists `lastError`, and the next tick replays. The exec is bounded by the 300 s execFile timeout, so the key cannot pin forever.
- **Effect on Z3.** During the 240 s hold the poller no longer replays the held submit (before the fix, that replay produced a second `held` line or an exit-5 step failure).

The poller ignores the return value, so returning `run` unpersisted is right for that caller. The engine caller is not covered. See N-2.

### 6. D-1, the ADR-2 wording: OPEN (LOW), see N-7

ADR-2's header and verdict block confirm ACCEPTED on 2026-10-15 via G1, and the factory code and tests no longer say "PROPOSED". Two factual claims in the wording are wrong, though (N-7).

## New / residual defects

### N-1 [MED] A timed-out arm can persist its schedule after the sweep has read state

`scripts/z3/live-round-wiring.ts:208-219` (`forkCli`), `:264-281` (`armZ3Schedule`), `:232-258` (`sweepNewZ3Schedules`)
- **What happens.** `forkCli` runs `Bun.spawnSync(["docker","exec",…,"npx","tsx",FORK_CLI,…], { timeout })`. The timeout kills the host-side `docker` client only. The `npx tsx … arm` process inside the container keeps running, because docker exec does not tear down the exec'd process when its client dies. `armZ3Schedule` then calls `sweepNewZ3Schedules` **at once**, and it reads `state` while the in-container arm may still be booting or persisting.
- **Consequence.** An arm that persists after that read leaves an `active` schedule with `runAt` ≤ 3 min away (`ARM_LEAD_MS` 420 s − the 240 s timeout). It fires a real round, and the QA legs provision boxes and spend with no driver alive. `crashGate().abort()` stops only the code submit. `ARM_LEAD_MS > FORK_ARM_TIMEOUT_MS` does not close this: it orders the fire after the host's timeout, not after the in-container process ends.
- **Fix (either one):**
  - (a) bound the in-container process below the host timeout, e.g. `docker exec … timeout -s KILL <timeoutMs/1000 − 15> npx tsx …` inside `forkCli`. This also helps `cancel` and `disarm`.
  - (b) on an arm failure, first `docker exec <c> pkill -f 'z3-exit-round.ts arm'`, then sweep. Re-sweep once more after `FORK_CLI_TIMEOUT_MS`, still before `runAt`.
- **Test.** Add a unit test with a fake `forkCli` whose arm "persists late" (it is visible on the second `state` read only) and assert that the schedule is swept.

### N-2 [LOW] Engine re-entry while the poller holds the key returns a still-running run, so the sequential loop spins to its iteration cap

Fork `src/lib/server/protocols/protocol-factory.ts:143-145` with `protocol-run-lifecycle.ts:535-606`
- **Path.** The Z3 template is sequential (non-DAG). Suppose the engine re-enters the step while a **poller** replay holds the key: a user resume/retry, or a `requeueAfterWake`.
  1. The run loop has already flipped the run to `running`.
  2. The guard returns that `running` run unpersisted.
  3. `stepProtocolRun` is called again on the same step, and the guard trips again.
  4. After 500 iterations the run is failed with "Exceeded maximum step iterations". The poller's ack then lands on a terminal run and is dropped (F-004).
- **Likelihood.** Rare in Z3. Restart recovery skips `waiting` factory runs, and the normal first submit is the engine's own. This is still the F-002 failure shape that the re-park exists to prevent.
- **Fix.** On a guard hit from the engine, re-park without an exec. For example, `if (submitsInFlight.has(inFlightKey)) return existing && run.status === 'running' ? persistRun(parkRunWithFactoryState(run, step, existing)) : run`. The key is added only after the `submitting` persist, so `existing` is present.
- **Test.** The poller holds the exec and `stepProtocolRun` is called. Assert the run ends `waiting` with 1 submit.
- **Hardening (optional).** Hold the Set in `hmrSingleton` (the file's sibling state uses that pattern), so that two module instances in one Next process cannot each see an empty Set.

### N-3 [LOW] `killFork` freezes state before the kill; a failed kill leaves a live fork served from a stale snapshot

`scripts/z3/live-round-wiring.ts:638-641`
- **What happens.** `frozen` is set before `docker kill`. If the kill throws, `standDown` aborts the gate, which is correct. But `frozen` is never cleared, so every later `state()` read (the cleanup sweep, the re-sweeps) returns the pre-kill snapshot of a fork that is still running.
- **Impact.** Low today: the aborted submit exits 99 and nothing new provisions. The cleanup's attribution still reads stale data, though.
- **Fix.** Set `frozen` only after `execFileSync` returns, or clear it in a `catch` that rethrows.

### N-4 [LOW] Second-resolution blind spot in the pre-kill "ended" check, and AC4 does not re-derive the exec count

- **Same-second end line.** `leg-drivers.ts:670` and `assertions.ts:312` treat an end line as "before the kill" only when `at < floor(killedAt)`. An `expired` or `aborted` line written in the same second as the kill, just before it, therefore reads as "held at the kill". The live pre-kill `holdState` check makes this a sub-millisecond race, so it is low.
- **AC4 is narrower than the driver.** AC4 (`assertions.ts:312`) also omits `exec` from the ended set, which the driver (`:670`) includes.
- **AC4 trusts a driver field.** AC4 trusts the driver's `submitExecs` instead of counting `exec` lines in the recorded `gateJournal`. That contradicts the "re-derived, never the driver's flags" comment at `:306`.
- **Fix.** In AC4, add `exec` to the pre-kill ended set and assert `gj.filter(l => l.phase === "exec").length === 1`.

### N-5 [LOW] GO consumption hygiene

- **The losing consumer leaves a stray copy.** A concurrent consumer with a different stamp that loses the race at `unlink` (ENOENT) leaves its own `<stamp>-operator-GO.consumed.json` behind. That is a second "consumed" record for a GO that fired nothing under that stamp. Fix: on `unlinkSync` failure, `unlinkSync(consumed)` and rethrow (`round-plan.ts:269-270`).
- **Setup refusals burn the GO.** `crashGate().arm()` (real-cli missing) and `z3ScheduleIds()` are setup checks that can refuse **after** the consume (`live.test.ts:124-126`). Running them before `consumeOperatorGo` avoids burning a GO on a setup error. The record is not lost either way.

### N-6 [LOW] Budget gaps

- **A tautological assertion.** `pre + round + cleanup + margin <= testTimeoutMs` holds by definition, because `testTimeoutMs` is that sum.
- **Uncounted time:**
  - the `ARM_LEAD_MS` wait after the arm timeout (≈ 3 min);
  - the watcher's stand-down before cleanup (up to one `state()` outage of 300 s, or a 120 s `docker start`);
  - the fork heartbeat latency per step (≈ 60 s × 8 steps).
- **Where the time comes from.** All of this comes out of the 10 min margin or the round's zero-slack 300 min. The round budget equals the sum of the fork step deadlines exactly, so a slow but legitimate round can go red at the driver deadline. That fails closed, and cleanup keeps its own budget. Fix: add these terms to `PRE_ROUND_MS` and `Z3_CLEANUP_STEPS_MS` (`watcherStandDown`), and give the round budget a slack term.

### N-7 [LOW] D-1 misstates the ADR-2 state in two places

`docs/planning/v6-crossrepo-contract.md:274-277`; `scripts/z3/assertions.ts:217`, `:245`; and the story's spec-drift note (line 9, driver-owned)
- **"Auto-merge is NOT implemented" is wrong.** G1 shipped the fail-closed machinery: `src/fleet/auto-merge-policy.ts`, the consult in `src/fleet/run-completion.ts:474-564`, and the setting `.factory/policy.json` `autoMergeDefault`. It cannot arm.
- **"Its precondition, the S05b approvals queue, is unbuilt" names the wrong blocker.** The verdict block names the **clause-5 veto-window queue** as the blocking build item for arming. The S05b inbox is the override surface, and its relay is gated separately.
- **The AC2 message no longer fits.** "treating ADR-2 as license to auto-merge before its implementing story lands": the implementing story (G1) has landed.
- **Suggested wording:**
  - Runbook: "ADR-2 is ACCEPTED (2026-10-15, G1). v6a ships only its fail-closed machinery (`autoMergeDefault` cannot arm). The blocking build item is the clause-5 veto-window queue, which is unbuilt. Z3 still asserts park → human decision."
  - AC2 message: "…treating ADR-2 as license to auto-merge while `autoMergeDefault` cannot arm (clause-5 veto-window queue unbuilt) fails".

## One-line verdict

R3 is substantially closed, with 139/0 and 60/0 green and tsc and biome clean. Items 1, 3, 4 and 5 are CLOSED. Item 2 is OPEN (MED, N-1): a timed-out arm can persist its schedule after the sweep reads state. Item 6 is OPEN (LOW, N-7): the D-1 wording. There are five further LOW notes (N-2 to N-6).
