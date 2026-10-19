# Z3 R3: edge-case hunter

Read-only. Checked against the factory branch `feature/z3-cross-repo-live-exit-round` (working tree) and the fork worktree `solstice-ai/.claude/worktrees/z3-sc` (uncommitted).<br />
R1/R2 dispositions were read first. A finding below that reopens one names the prior ID.

## Checked and clean (no finding)

- **Fork `state` / `cancel` / `disarm` against the zod schemas.** I compared every field.<br />
  `state` run keys: `id, templateId, scheduleId, createdAt (number), status, steps[{id, kind, externalJobConfig?, factoryObserveConfig?}], factoryState, artifacts[{id, kind, stepId, title, content, createdAt}], events[{type, stepId?, summary, data?, at}]`.<br />
  `schedules`: `{id, status, protocolTemplateId, protocolConfig}`, and `writtenAt` is a number.<br />
  `cancel`: `{cancelled, fleetCancelled, inFlightRequestIds}`. `disarm`: `{disarmed, firedRunId|null}`. `arm`: `{scheduleId, protocolConfig}`, with a non-null config.<br />
  All of these parse under `RunSchema` / `ForkStateSchema` / `CancelSchema` / `DisarmSchema` / `ArmSchema` (`scripts/z3/live-round-wiring.ts:82-143`).<br />
  `factory_result` content is `JSON.stringify(payload, null, 2)` with `runId` and `status` (`protocol-factory-lifecycle.ts:81-88`), so `JSON.parse(content).status/.runId` holds.
- **The `--request-id` flag.** The fork passes `submit --request-id <uuid> --budget-group … --json` with a compact `JSON.stringify` brief (`protocol-factory-exec.ts:124-158`). The wrapper's argv parse and its `"workId":"…"` grep both match. `instructions` follows `workId` in the brief, and an embedded quote is escaped (`\"`), so the first grep hit is the real workId.
- **Exit codes.** The fork replays on `{1, 3, 6, -1}` (`protocol-factory.ts:55`). The wrapper's 99 (abort/expired/unparsed) is not among them, so it reaches `failOrAdvance`. The code step is `onFailure: 'fail'`, so the run fails with nothing exec'd, as intended. A 300 s execFile timeout yields -1, which replays.
- **The record's `requestId` is the submit's `--request-id`.** `submitWork` passes it to `dispatch(…, { requestId })` (`src/fleet/submit.ts:~351`). There is a window during `driver.create()` where the record exists without `requestId` (`src/fleet/dispatch.ts:3969-3975`). The R2 A-2 settle polls and the cleanup re-sweep cover it.
- **`reflect` auth.** `AGENT_GRANT_CLASSES.host = ["reflect", "retain"]` and `checkGrantVerbs` refuses everything else (`src/memgate/schemas.ts:109-112, :301-315`). The gateway routes POST `/v1/default/banks/{bankId}/reflect`, and `{query}` parses (`src/memgate/forward.ts:23, :124`). The claim is correct. The side effect is E-11.
- **The #465 state name.** `pausing` is the literal `fleet result` status (`src/fleet/result.ts:31,41,170`), and it matches the issue body.
- **The 300 s vs 240 s ordering** holds in the normal case. For the drift case, see E-8.

---

### E-1 [HIGH] scripts/z3/leg-drivers.ts:807-818 (with scripts/z3/fleet-gate.sh:41, :81-90 and leg-drivers.ts:601)

**Problem.** The 240 s hold limit cannot cover the work the driver does inside the hold.

The fork chains `qa-observe-<last lens>` → `z3-code-run` with no wait (`nextStepId`). The code submit is therefore persisted as `submitting` and HELD the moment the last QA observe completes. That is the same moment the factory's `awaitObserveStep` for the last lens returns.

Everything after that point runs while the held submit's 240 s clock is ticking:
- `observeDeltas`. Its settle loop runs while anything is unattributed AND a step is `submitting`. The held code step is `submitting` for the whole hold, so the loop can spin 30 × 10 s = 300 s by itself (`leg-drivers.ts:359`).
- `retainFindings`. These are SEQUENTIAL synchronous retains (`async: false`, `RETAIN_TIMEOUT_MS = 30 s` each, up to `MAX_FINDINGS_PER_HARVEST = 32`; `src/qa/retain.ts:251-262`, `src/hindsight/client.ts:54`). That alone can take up to 16 min.
- `gatewayAssert`. This is an LLM `reflect`, with a fetch timeout of up to 60 s.
- Only after all of this does `retainDone = true` let the watcher kill.

The A-5 "release after the last retain" fix (R2) and the A-10 "hold < 300 s" fix (R2) are therefore in direct conflict.

The watcher also never looks for `expired`. `held()` is `some(held) && !some(exec)`, and an expired hold leaves `held` + `expired` with no `exec`, so the watcher kills a fork whose hold already exited 99. The fork has already failed `z3-code-run` (`onFailure: 'fail'`). The round then dies in `driveKillAndProvision` with "z3-code-run failed fork-side: fleet submit refused (exit 99)", which names the wrong cause.

**Trigger.** The last lens harvests about 8 or more findings, a Hindsight retain averages 20 s or more, or any unattributed fresh resource exists during the last observe. Any of these makes the round red after all three QA legs have spent. Two instances are held at once: the run loop's, plus the heartbeat poller's replay of the `submitting` entry every 60 s (`protocol-factory.ts:288`). The earliest one sets the clock.

**Fix.**
- (a) At hold expiry, have the wrapper exit with a REPLAY code (`1`) instead of 99. Nothing was exec'd, so a replay is safe by SC2.1. The poller re-submits the same requestId at its next tick, and the armed gate holds it again. The window becomes renewable up to the step's own `codePollTimeoutMs` (journal `expired-replay`). Keep 99 only for `abort` and `unparsed`.
- (b) In `armCrashWindow`, immediately before the kill, require at least one hold that is still open: the count of `held` lines must exceed the count of `expired` + `released` lines for the requestId. Otherwise stand down.
- (c) Skip the observe settle loop when the only `submitting` steps are held by the gate (they cannot ack).

### E-2 [HIGH] tests/fleet/e2e/z3-exit-round.live.test.ts:124-137, :194-197 (scripts/z3/live-round-wiring.ts:180-186). Reopens R2 E-2 / A-6 as incomplete.

**Problem.** `armZ3Schedule` disarms only when the fork printed a JSON line that fails `ArmSchema`.

`forkCli` throws before that point when there is no JSON line, the exit is non-zero, or the call times out. `armed` then stays `undefined`, so the test's `finally` skips the disarm (`if (armed !== undefined)`). A schedule the fork already persisted keeps `runAt = now + 120 s` and fires with no driver watching.

The fork has a concrete path to exactly this state. In `arm()`, `createZ3ExitRoundSchedule` persists the row, and the throw on `!persisted?.protocolConfig` comes after that (`scripts/solstice/z3-exit-round.ts:88-90`), so the process exits 1 with the row on disk. Other routes to the same state: the 120 s `forkCli` timeout on a cold `tsx` boot or a locked store, and a SIGKILL of the exec after the write. The gate is aborted, so the code submit exits 99. The three QA legs are not gated by it, so up to 3 × `qaGroupCapUsd` is spent with no cleanup, no box destroy and no revoke-verify.

**Trigger.** Any `arm` failure that lands after `createZ3ExitRoundSchedule`'s write.

**Fix.** Read `state.schedules` before arming and keep the z3 schedule ids. In the `finally` (and in `armZ3Schedule`'s catch), re-read `state` and run `disarm` on every z3 schedule that is new since that snapshot and still `active` or `paused`, then cancel every run they fired. Alternatively, pass a factory-minted nonce in `--config` and disarm whatever row carries it.

### E-3 [MED] fork src/lib/server/protocols/protocol-factory.ts:285-290 (with factory src/fleet/submit.ts:287-290, :529-539)

**Problem.** The heartbeat poller (60 s tick, `heartbeat-service.ts:41, :653`) calls `processExternalJobStep` for every `submitting` entry. It does this while the run loop's own first submit exec for that entry may still be running.

`submitWork` answers a replay of an `in-flight` intent with `SubmitError(5, "submit-in-flight")`. The fork does not treat 5 as a replay code, so it calls `failOrAdvance`, which fails the step. SC2.6 measured a real provisioning submit at well past 60 s (`protocol-factory-exec.ts:13`). So whenever a QA leg's submit spans a poller tick, the poller's concurrent replay can fail that leg.

Nothing in the fork guards against this: there is no in-process in-flight set, and `pollInFlight` only serializes the poller against itself. This is pre-existing fork behaviour. Z3 is the first round that drives three back-to-back real submits through it with the poller live. During the code hold, the second instance is held too, so it is harmless there.

**Trigger.** A QA submit exec lasts longer than the time to the next 60 s heartbeat tick.

**Fix.** Verify against a live journal first. If it reproduces, the fork needs an in-process `submitsInFlight: Set<stepKey>` that `pollFactoryRunsInner` skips, or exit 5 `submit-in-flight` must count as replay-later and not as failure. Until then, list it as a third upstream blocker, or at least name it in the runbook's red-round triage.

### E-4 [MED] tests/fleet/e2e/z3-exit-round.live.test.ts:81-84

**Problem.** The arithmetic does not close.

`TEST_TIMEOUT = 300 + 45 + 10 min` assumes three things, and each one fails:
- **(1) Pre-round work fits in the margin.** It mostly does not. `preflightFork` makes 5 calls with a 60 s timeout each plus one 120 s `state`, `arm` has a 120 s limit, and `listedKeyHashes` runs too. All of this happens before `deadline` is set (`:151-154`), which is roughly 8 of the 10 margin minutes.
- **(2) The round stops at its deadline.** It does not, because `pastDeadline` is checked only between calls. Calls that ignore the deadline:
  - `fleet result` (300 s spawn timeout, `live-round-wiring.ts:254`)
  - one `retainFindings` (up to 32 × 30 s = 16 min)
  - the observe settle loop (300 s)
  - `forkCli` (120 s)
- **(3) Cleanup fits in 45 min.** It does not at the configured ceilings:

  | Cleanup step | Ceiling |
  |---|---|
  | `disarm` | 780 s |
  | its `state` re-read | 120 s |
  | `cancel` per fired run | 780 s |
  | sweep | `state()` up to about 6 min of retries |
  | `destroyBoxes` | 300 s per runId, 4 or more runIds = 20 min |
  | leftover destroy | 300 s per leftover |
  | re-sweep | about 2 min |
  | **Total** | **about 50-80 min** |

  Also, once the round deadline has passed, every `state()` blip in cleanup throws at once (`pastDeadline` inside `state()`, `:341`). The sweeps then fail as problems and do not retry.

**Trigger.** A slow round that reaches its deadline during a retain or result poll, followed by a cleanup with one slow cancel. The bun timeout then fires mid-cleanup, which is the outcome the budget exists to prevent: boxes are left undestroyed and keys unverified.

**Fix.**
- Give cleanup its own deadline (`roundEnd + CLEANUP_BUDGET_MS`) that `state()` honours in place of the round's.
- Bound `destroyBoxes` to run in parallel, or cap it at 60 s per runId.
- Re-derive `CLEANUP_BUDGET_MS` from the timeouts actually configured (or lower those timeouts).
- Set `deadline` from test start, not from after arm.
- Make `retainFindings` check the deadline between findings.

### E-5 [MED] scripts/z3/leg-drivers.ts:701-702 / scripts/z3/live-round-wiring.ts:202-206. Reopens R2 E-2 (fork disarm residual) as incomplete.

**Problem.** The factory says "the re-read covers the residual race". It covers a race of about 5 s at most: the 3 s settle plus one `tsx` boot.

The scheduler loads every schedule ONCE at tick start (`computeNextRuns(now)`, `scheduler.ts:348`) and then fires from that stale snapshot. The z3 fire also awaits a lazy import between `upsertSchedule(firedSchedule)` and run creation (`scheduler.ts:497-509`). A tick that loaded the row as `active` before the archive can write `completed` and create the run after both re-checks. It is slow enough to do that whenever earlier schedules in the same tick do real work.

Separately, `runCleanup` never inspects the outcome. A disarm that leaves the row `active` or `paused` (for example, the fork's own `disarmed: false` with no fired run) is not flagged. Nothing re-reads runs by `scheduleId` at the end of cleanup, so a late fire is never cancelled. The pre-round `finally` behaves the same way.

**Trigger.** A refusal path whose disarm lands within a tick of `runAt`, or a failed disarm exec.

**Fix.**
- After the disarm, require that the fresh `state` shows the schedule as `archived`, `completed`, `failed` or `cancelled`. Otherwise retry once and record a cleanup problem.
- In the final re-sweep, re-read `runs.filter(r => r.scheduleId === scheduleId)` and cancel any id not seen before.

### E-6 [MED] scripts/z3/round-plan.ts:232 vs scripts/z3/assertions.ts:442

**Problem.** `gateFire` accepts a GO dated up to 5 min in the future. AC7 requires `go.when <= trigger.firedAt`.

`firedAt` is the fork's `run.createdAt`. That is the CONTAINER clock, at `now + ARM_LEAD_MS (120 s) + ≤ 60 s tick`. A GO dated 3-5 min ahead (or a host/Docker-VM clock skew, common after host sleep on Docker Desktop) therefore passes the pre-fire gate and fails AC7 after all the spend.

Separately, the 24 h window lets one GO authorize every re-run within a day. "One GO per round (charter §5.6)" has no enforcement: nothing consumes or binds the GO to a round. B-19 (R2) added only the age bound.

**Trigger.** An operator writes `when` a few minutes ahead, or the container clock leads the host.

**Fix.** Refuse `at > now` in `gateFire`, and compare AC7 on one clock (record the host time `gateFire` ran, plus the fork's `writtenAt` delta). Bind the GO to the round: record its sha256 in the trigger leg, and refuse a GO whose sha256 already appears in an earlier round's trigger leg in `Z3_EVIDENCE_DIR`.

### E-7 [LOW] scripts/z3/live-round-wiring.ts:483-490

**Problem.** The `pausing` clock (`pausingSince`) resets on ANY read that is not `pausing`, including transient `fleet result` failures. A ledger or record-lock blip roughly every 20 min means the #465 bound never trips, and the leg waits out the 5 h round deadline.

The bound is correctly scoped. It applies only to `want === "terminal"` (QA legs, which are findings-only and have no gates to reverify), and a legitimate `pausing` (teardown + reverify of nothing) lasts far under 20 min.

**Fix.** Reset only on a payload whose status is not `pausing`. Leave the clock running on `{transient}`.

### E-8 [LOW] scripts/z3/fleet-gate.sh:81-89

**Problem.** The hold limit counts loop iterations (`waited` × 0.1 s), not wall time. Each iteration also forks `/bin/sleep` and runs two `[ -f ]` tests. In a loaded container (the Next server, a concurrent provisioning submit) the overhead can push the 2400 iterations past the fork's 300 s execFile timeout. The fork then sends SIGTERM, which gives code -1 and a REPLAY in place of the designed exit 99. The "dead driver" path then re-holds every poller tick until the 2 h code deadline.

**Fix.** Compare against bash `$SECONDS` (`start=$SECONDS … [ $((SECONDS - start)) -ge "$HOLD_LIMIT_S" ]`). Moot if E-1(a) is adopted.

### E-9 [LOW] scripts/z3/live-round-wiring.ts:212-234 (`preflightFork`)

**Problem.** The probes miss four setup failures that surface only after spend:
- **(a)** `recordsForRequestId` uses `RunRecordStore.list()`, which THROWS `listing-partial` on any malformed record in the accumulated `.sandbox/runs` (`src/providers/run-record.ts:1961-1976`). One stale tombstone from any earlier round bricks observe attribution and the cleanup sweeps.
- **(b)** `real-cli` is checked only for `-x`. Nothing proves it `cd`s into `/factory` and uses this `RUNS_DIR` (R2 E-11). A wrong shim makes `readRecord` null on the first QA leg.
- **(c)** The agent token's `banks` scope and `QDS_KG_GATEWAY_URL` are first exercised in `findings-retain`, after the first leg spent. A token minted for the wrong bank family fails there.
- **(d)** Fork hibernation (`SOLSTICE_HIBERNATION`) skips non-exempt schedules (`scheduler.ts:395`). `awaitTrigger` then polls an `active`, never-firing schedule until the 5 h deadline.

**Fix.**
- Add `new RunRecordStore({dir: RUNS_DIR, create: false}).list()` to preflight.
- Add an in-container `real-cli status --json --dir …` round trip, or a nonce record check.
- Add one pre-GO `gatewayAssert(resolvedBank)`.
- In `awaitTrigger`, fail fast when the schedule is still `active` more than `ARM_LEAD_MS + 3 min` past its `runAt`.

### E-10 [LOW] tests/z3/fixtures/fork-state.json:19-21

**Problem.** The fixture does not mirror the fork projection field for field, contrary to its `_note`. The real observe entry always carries `requestId: "observe-<uuid>"`, `status: "submitted"` until settle, `submittedAt`, `pollAttempts` and `lastError` (`protocol-factory-observe.ts:321-330`; normalization drops entries without a requestId). The fixture's observe entry has only `stepId`, `status` and `runId`. The real verdict artifact `title` is `Factory result <runId> (<status>)`, pretty-printed.

The schema is passthrough, so nothing breaks today. But the fixture would not catch the factory treating `observe-…` requestIds as fleet keys (`protocolFleet.requestIds` includes them, and every `recordsForRequestId` call then does a full `list()` for each).

**Fix.** Copy a real `state` line from the fork test (`scripts/solstice/z3-exit-round.test.ts`) into the fixture. Filter out `observe-` requestIds in `protocolFleet`.

### E-11 [LOW] scripts/z3/live-round-wiring.ts:571-579 vs scripts/z3/leg-drivers.ts:148-149

**Problem.** The round's own classifier says `READ_ONLY_MEMORY_VERBS = ["recall"]`: "every other verb (retain/reflect/consolidate) writes the bank". F-1 (R2), however, calls `reflect` the "read-shaped" verb.

The gateway assertion therefore runs a verb the round itself classes as bank-writing against the very bank whose contents the priming leg later measures, four times per round (once per lens plus priming). Each call is also an unbudgeted Hindsight LLM call outside the GO's worst case. `citedRetained` filters to retained documentIds, so the result cannot turn green falsely. The claim and the evidence label are what is wrong.

**Fix.** Correct the comment and the contract-delta text: `reflect` is the only verb the host class can authenticate with, and it is not read-only. Alternatively, run the assertion once, after priming.

### E-12 [LOW] tests/fleet/e2e/z3-exit-round.live.test.ts:190-197

**Problem.** In the pre-round `finally`, the first throw stops all the work after it:
- If `disarmZ3Schedule` throws (container blip, or the 780 s timeout), the error replaces the original refusal (for example, the cap mismatch) and no fired run is cancelled.
- If `cancelForkRun` throws on one id, the remaining ids are not cancelled.

**Fix.** Guard each step, collect the problems, cancel every id, and re-throw the original error with the cleanup problems attached. This is the same `settleRun` posture the round path already uses.
