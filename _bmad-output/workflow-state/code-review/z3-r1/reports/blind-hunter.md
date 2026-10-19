# Z3 R1 — Blind Hunter report

Scope: `z3-factory.diff` (QDS-Factory) + `z3-fork.diff` (swarmclaw fork). I read the diffs only: no story, no repo browsing.<br />
Line numbers are post-image file lines. Findings that depend on code outside the diff are marked **(verify)**.

Totals: 4 HIGH, 16 MED, 12 LOW (32 findings).

---

## HIGH

### B-1 [HIGH] scripts/z3/leg-drivers.ts:551
**Problem.** The `finally` (`runCleanup`) cancels only the runIds the driver has already `track`ed. It never cancels or fails the fork's **protocol run**. The fork chains steps by itself, so after a driver-side failure it keeps going and submits the next `external_job`.<br />
**Failure scenario.** `driveQaRunObserve` for lens 1 fails (say a false-positive minted key). The cleanup cancels qa run 0, lists inventory, finds it clean and writes `exitCode 0`. Meanwhile the fork moves on to `qa-leg-<lens 2>`, then the remaining legs and `z3-code-run`. That is up to 3 more paid fleet runs with boxes nobody tracks, started after the "final" inventory was taken, so `leftoverBoxes` reports clean. The same thing happens when `armCrashWindow` throws ("crash window missed"): the fork restarts and submits the code run, which is never tracked or destroyed.<br />
**Fix.** Make the cleanup's first step cancelling the protocol run (`protocolRunId` from the trigger), through a fork-side cancel verb. Then poll the fork state until no step is `submitting` or `submitted`, cancel every runId seen in `factoryState`, not just the tracked ones, and only then take the final inventory.

### B-2 [HIGH] tests/fleet/e2e/z3-exit-round.live.test.ts:55 (+ scripts/z3/round-plan.ts:161)
**Problem.** The worst-case spend that the operator GO is checked against comes from factory env (`Z3_QA_GROUP_CAP_USD` / `Z3_CODE_GROUP_CAP_USD`, default 6/6). The spend that actually happens comes from the fork schedule's persisted `protocolConfig.qaGroupCapUsd` / `codeGroupCapUsd`, set when the schedule was authored. Nothing ties the two together. `ProtocolState` does not even model `externalJobConfig.groupCapUsd`.<br />
**Failure scenario.** The operator arms the fork with 25/40, as the fork test fixture does, and leaves the factory env unset. The gate prints and approves $24 while the fired round can spend $115. The `trigger` leg records `worstCaseSpendUsd: 24` as evidence, so AC7 "spend recorded at fire" passes on the wrong number.<br />
**Fix.** In `driveTrigger`, read each fired step's `externalJobConfig.groupCapUsd` (and the step count) from the bound run. Compute the worst case from that, refuse if it exceeds `go.spendApproved.worstCaseUsd` or differs from the plan, and record the fork-side number.

### B-3 [HIGH] scripts/z3/leg-drivers.ts:391 (+ scripts/z3/live-round-wiring.ts:91, :192)
**Problem.** The crash-window kill is structurally racy:<br />
(a) `armCrashWindow` only starts polling after the last QA leg's forensics, observe, host retain and an `ssh` inventory have finished. The fork enters `z3-code-run` `submitting` as soon as `qa-observe-<last>` completes, so the window may close before the driver starts watching.<br />
(b) Each poll costs a `docker exec … state` dump (up to 120s) plus a 10s sleep, much coarser than a submit.<br />
(c) `refreshState` swallows failures and `ProtocolState.writtenAt` is never checked. A stale dump that still says `submitting` triggers a SIGKILL that lands after the submit has finished.<br />
**Failure scenario.** In case (c) the kill is not mid-submit at all. AC4 still passes, because it only checks requestId reuse, one record and ≤1 bookings. `killedAt` is recorded but never compared to anything. In case (a) the round throws after paying for every QA leg.<br />
**Fix.** Start a concurrent watcher for `z3-code-run` when the round starts (or have the fork pause at `submitting` behind a test hook). Refuse a dump whose `writtenAt` is older than the poll start. Have AC4 prove the kill was mid-submit, for example the fork's journal showing the submit attempt interrupted, or `killedAt` earlier than the record's `createdAt` / submitted transition.

### B-4 [HIGH] scripts/z3/assertions.ts:228 (+ scripts/z3/leg-drivers.ts:393)
**Problem.** AC4's "run record untouched across the kill" check is skipped whenever `recordBeforeKill` is null. The snapshot is taken at `submitting`, before the run has a runId. In the fixture the record only appears in `awaitStepSubmitted`, so `recordBeforeKill` is always null on the real driver path. The green positive control runs this check vacuously. The only test that exercises it hand-edits the file.<br />
**Failure scenario.** A re-drive that deletes and recreates the run record (new `createdAt`) passes AC4: there was no "before" to compare, and `records.length === 1` still holds.<br />
**Fix.** Require a non-null pre-kill record and make null a problem, or snapshot the record at a point where it is guaranteed to exist. Add a driver-path negative control (a fake `recordsForRequestId` that changes `createdAt` across the kill), not only a file edit.

---

## MED

### B-5 [MED] scripts/z3/leg-drivers.ts:182 (+ assertions.ts:192)
**Problem.** `liveBoxesForRun = union(first, second)` merges the two stability samples. A box seen in sample 1 and gone in sample 2 still counts as "exactly one". The comment says the invariant "must HOLD, not appear", but AC3 never reads `boxCountSamples`.<br />
**Failure scenario.** Samples `[1, 0]` (the box crashed or was reaped inside the 10s window) pass both the driver and AC3.<br />
**Fix.** Require `boxCountSamples` to be `[1, 1]` with the same name in both, in the driver and in AC3.

### B-6 [MED] scripts/z3/assertions.ts:241 (+ leg-drivers.ts:425)
**Problem.** The double-booking check is `n > 1`. Zero bookings passes.<br />
**Failure scenario.** The ledger query hits the wrong key (for example the gate admission is keyed by requestId, not runId), or the re-drive skips booking, so spend escaped the ledger. The check returns 0 and AC4 is green.<br />
**Fix.** Require exactly 1 (`n !== 1` is a problem) for both `ledgerBookingsForRun` and `groupReservationsForRequest`.

### B-7 [MED] scripts/z3/live-round-wiring.ts:301
**Problem.** Live `retainTraces` are made up: `documentIds.map(id => ({ side: "host" }))`. The side is a constant, not an observation, so the AC5 "retained from inside a box" check cannot fail live. It only fails in the fixture.<br />
**Failure scenario.** A box writes findings to the bank directly with a leaked credential. Nothing in live evidence shows it, and AC5 is green.<br />
**Fix.** Get the side from an observation, for example the memgate or Hindsight audit log for the bank over the round window (writer identity per documentId). Otherwise document AC5's host-side claim as resting on `boxWriteCredentials` alone.

### B-8 [MED] scripts/z3/assertions.ts:333
**Problem.** AC7 checks only that revoke-verify receipts are well-formed (`typeof r.ok === "boolean"`), not that `r.ok === true`. `boxDestroy` is checked only with `Array.isArray`: an empty array, or receipts with `exitCode !== 0`, pass.<br />
**Failure scenario.** Revoke-verify reports a leaked provider key (`ok: false`) and every `fleet cancel` exits 1. AC7 (the re-derived verdict) is green. Only the separate `cleanupProblems` channel catches it.<br />
**Fix.** Flag any `ok !== true` receipt. Require one `boxDestroy` receipt per runId with `exitCode === 0`. Add negative controls for both.

### B-9 [MED] scripts/z3/leg-drivers.ts:335-336, :479; scripts/z3/live-round-wiring.ts:349
**Problem.** Output is cut down (`stdout.slice(-400)`, `stderr.slice(-600)`, `stderr.slice(-300)`, `problems.join().slice(-2000)`) before it reaches the writer's scrub. A secret that straddles the cut loses its recognizable prefix (`sk-or-`, `Bearer `, `ghp_`) and no longer matches as a whole known-secret value either. The surviving suffix is neither scrubbed nor detected.<br />
**Failure scenario.** `fleet cancel` stderr ends with `…Authorization: Bearer sk-or-v1-<64 hex>`, and the 300-char cut falls inside `sk-or-`. What lands on disk is `-v1-<64 hex>`, a live key body.<br />
**Fix.** Scrub the full string first, then truncate. Or truncate at a whitespace boundary and also refuse when the cut text starts mid-token.

### B-10 [MED] scripts/z3/evidence.ts:56-66 (+ live test :66)
**Problem.** The scrub and detect patterns cover `ghp_` and `github_pat_`, but not the other GitHub token shapes (`gho_`, `ghu_`, `ghs_` installation tokens, `ghr_`). `knownSecrets` does not include `GH_TOKEN` or `GITHUB_TOKEN`, although the fleet and code-run path pushes branches.<br />
**Failure scenario.** A `fleet` stderr tail echoes `https://x-access-token:ghs_…@github.com`. The userinfo pattern would catch that form, but a bare `ghs_…` in a git error does not match and lands.<br />
**Fix.** Use `gh[pousr]_[A-Za-z0-9]{20,}` in both SCRUB and DETECT, and add `GH_TOKEN` / `GITHUB_TOKEN` to `knownSecrets`.

### B-11 [MED] tests/fleet/e2e/z3-exit-round.live.test.ts:92 (+ assertions.ts:117)
**Problem.** The live verdict filters files by `registry.has(name)`, but nothing checks the other direction: every registry entry must still be on disk with matching bytes. AC1 also checks only that each leg is present at least once, never the expected count (lenses+1 kill-and-provision and box-forensics, lenses × qa-run-observe and findings-retain).<br />
**Failure scenario.** A red `kill-and-provision` file for QA run 2 is deleted or moved. It drops out of `files`, so AC1, AC3 and AC4 never see its `exitCode 1` or its runId (no F-011 `factory_result` check for it), and the verdict is green on a partial round.<br />
**Fix.** In `assertAc1RoundComplete`, when `registry` is given, flag every registry name missing from `files`. Assert the per-leg counts derived from the round plan.

### B-12 [MED] tests/fleet/e2e/z3-exit-round.live.test.ts:97 (+ live-round-wiring.ts:58)
**Problem.** The test timeout is 240 min, but each `pollRun` may wait 180 min and each `awaitResult` 75 min. A round with 4 sequential fleet runs plus a human park can exceed 240 min. When bun's per-test timeout fires, it does not cancel the pending async body, and the process may exit before `runZ3Round`'s `finally` runs.<br />
**Failure scenario.** The round overruns, bun reports a timeout and exits, and the cleanup never runs. Boxes and keys outlive the round with no cleanup record. That breaks INV-Z3-5 ("unconditional, every exit path").<br />
**Fix.** Give the round its own overall deadline, shorter than the test timeout, that aborts the drivers and enters cleanup. Leave enough margin for cleanup, or set the test timeout from Σ of the deadlines plus a cleanup budget.

### B-13 [MED] scripts/z3/live-round-wiring.ts:53, :177, :178, :269
**Problem.** `RECORDS_DIR` is resolved three different ways. `RunRecordStore({dir: RECORDS_DIR})` is relative to the process cwd. `allowlistPath = path.join(REPO_ROOT, RECORDS_DIR, …)` is wrong for an absolute `QDS_RUNS_DIR`, because `path.join` does not reset on an absolute segment. The ledger uses `path.resolve(REPO_ROOT, RECORDS_DIR)`.<br />
**Failure scenario.** With `QDS_RUNS_DIR=/data/runs`, the approver allowlist is written to `<repo>/data/runs/.factory/approvers.json` while `fleet approve --dir /data/runs` reads `/data/runs/.factory/…`. The approve fails as unknown approver. Separately, running the test from a non-root cwd makes `readRecord` return null (it swallows errors), which shows up as misleading forensics failures.<br />
**Fix.** Resolve once: `const RUNS = path.resolve(REPO_ROOT, process.env.QDS_RUNS_DIR ?? ".sandbox/runs")`, and use it everywhere, including `--dir`.

### B-14 [MED] tests/fleet/e2e/z3-exit-round.live.test.ts:51
**Problem.** The fork rev stamped on every leg (and checked by the GO gate) is `SWARMCLAW_FORK_REV` from env, a self-declared value. Nothing reads the rev the fork container is actually running. Within a round the AC1 `swarmclawForkRev` check is a tautology, because the writer stamps the same value it is compared against.<br />
**Failure scenario.** The container runs an older image while the env names the new rev. Every leg is stamped with the new rev, the Z1 drift alarm is silenced, and the evidence certifies code that never ran.<br />
**Fix.** Read the rev from the fork (have the `z3-day-of.ts state` dump include the container's git rev or build id) and refuse the round if it differs from `SWARMCLAW_FORK_REV`.

### B-15 [MED] scripts/z3/live-round-wiring.ts:118 **(verify)**
**Problem.** The `armedAt` bind runs `Date.parse(r.createdAt ?? "")`. Fork-side `createdAt` values in this diff are epoch-ms numbers (`createdAt: Date.now()` on schedules, `createdAt: 1` on agents). If the day-of dump passes `ProtocolRun.createdAt` through as a number, `Date.parse(number)` is NaN and every run is filtered out.<br />
**Failure scenario.** `awaitTrigger` never binds and the round hangs for 180 min at the first leg. That wastes a fire, and the schedule is one-shot.<br />
**Fix.** Accept both forms (`typeof c === "number" ? c : Date.parse(c)`), and fail fast if the dump has z3 runs but none parse.

### B-16 [MED] scripts/z3/live-round-wiring.ts:284
**Problem.** `retainFindings` throws at once when `.unlazy/z3/harvest/<runId>.json` is absent. The harvest is an out-of-band operator step, but the fork does not wait for the driver: the next leg is already running.<br />
**Failure scenario.** The operator extracts the harvest a minute late. The retain leg throws and the round fails mid-flight. Per B-1, the fork keeps spending.<br />
**Fix.** Poll for the harvest file with a bounded deadline, or have the wiring extract the harvest itself from the run's result.

### B-17 [MED] scripts/z3/leg-drivers.ts:334
**Problem.** The `approve` leg's `exitCode` is the CLI exit code, not the leg verdict. Every other leg goes through `settle`, where `exitCode` is 0 only when there are no problems.<br />
**Failure scenario.** The CLI exits 0 with `state: "rejected"` (or `outcome` is not `decided`). The approve file says `exitCode: 0`, so AC1's "arc green" check passes for that leg. AC2 happens to catch the state, but AC1's per-leg green claim is false.<br />
**Fix.** Write `exitCode: problems.length === 0 ? 0 : 1` and record the CLI code separately as `cliExitCode`.

### B-18 [MED] fork src/lib/server/protocols/protocol-z3-exit-round.ts:177-181 **(verify)**
**Problem.** `z3-branch` matches `artifact_field_equals status` on `artifactKind: factory_result`. By the time it runs, the run holds one `factory_result` per QA leg (all `status: "completed"`) plus the code run's. Nothing scopes the match to the code run's artifact.<br />
**Failure scenario.** If the evaluator uses the first or any matching artifact, a QA leg's `completed` result selects case `completed` (or `approved` matches regardless of what the code run returned). The factory then fails a correct round, or the fork records a branch that does not reflect the code-run verdict.<br />
**Fix.** Scope the condition to the code run's output (a `fromStepOutput: 'z3-code-run'` qualifier, or a code-run-specific artifact kind). Add a fork test with multiple `factory_result` artifacts present.

### B-19 [MED] fork src/lib/server/runtime/scheduler.ts:504-506 **(verify)**
**Problem.** `fireZ3ExitRoundRun` re-validates and can throw ("requires a 40-hex commitSha") inside the tick's schedule loop, after `upsertSchedule(firedSchedule)` has already moved the schedule on. It also replaces `launchProtocolRunForSchedule` wholesale, so any side effects that function performs are skipped for z3 (run linkage, run history). The dynamic import also runs for every protocol schedule, so a z3 module load error breaks all protocol schedule fires.<br />
**Failure scenario.** A malformed z3 row throws out of `tick`. Later schedules in the same tick are not fired, and the once-schedule may be left `completed` with no run.<br />
**Fix.** Wrap the z3 fire in try/catch that marks the schedule failed and `continue`s. Import only when `protocolTemplateId === Z3_EXIT_ROUND_TEMPLATE_ID`. Check that the z3 path performs the same post-launch bookkeeping as `launchProtocolRunForSchedule`.

### B-20 [MED] scripts/z3/live-round-wiring.ts:91-99
**Problem.** `refreshState` failures are logged and the poll continues on the last dump, and freshness (`writtenAt`) is never checked anywhere. That is fine for "wait until X". It is wrong for any read that triggers an action or a verdict.<br />
**Failure scenario.** Beyond B-3: `awaitObserveStep` and `awaitProtocolComplete` can return verdicts from a dump written before the container died. While the fork is down (during the crash window) the poll loops silently on stale data until the deadline.<br />
**Fix.** Track consecutive refresh failures and throw after N. Refuse a dump whose `writtenAt` is earlier than the start of the current poll.

---

## LOW

### B-21 [LOW] scripts/z3/assertions.ts:150, :165
The header says nothing trusts a driver's own `ok`-shaped fields, but AC2 trusts `scryptVerified: true` and `autoMerge` as the driver computed them. It could re-derive them from `stdoutTail`, the last JSON line (`outcome`/`approverId`/`state`), and from `eventTypes`. Outside the registry-gated live path, an edited file with `scryptVerified: true` passes AC2. **Fix:** re-derive both from the recorded raw fields.

### B-22 [LOW] scripts/z3/evidence.ts:149 (+ assertions.ts:102)
`origin` is a lookup on the `leg` argument (`Z3_LEG_ORIGIN[leg]`), not a provenance fact. Any caller of `writeZ3Evidence(sink, "approve", …)`, including `runCleanup` or a post-hoc script that imports the writer, gets the "driveApprove" origin. The AC1 origin check only catches hand edits, which the registry already catches. Fix the comment or the claim. Real provenance would need a capability token per driver.

### B-23 [LOW] scripts/z3/live-round-wiring.ts:327-334
The allowlist is written with default mode and then chmod'ed to 0600: a brief world-readable window for the scrypt hash if the file is new. The write also replaces every existing approver for the duration of the round, and `chmodSync(factoryDir, 0o700)` permanently changes a shared dir. If the process is SIGKILLed or times out (B-12), the allowlist is left with only the z3 approver. **Fix:** `writeFileSync(..., { mode: 0o600 })`, merge into the existing approvers instead of replacing them, and don't change the dir's mode.

### B-24 [LOW] scripts/z3/leg-drivers.ts:140
In `settle`, `...body` is spread after `exitCode/stdoutTail/stderrTail/observability`, so a body key `exitCode` (for example from a spread `...sub` / `...t` dep result) silently overrides the problem-derived exit code and turns a red leg green. **Fix:** spread `body` first and the writer-derived fields last, or refuse those keys in `body`.

### B-25 [LOW] scripts/z3/leg-drivers.ts:395-399
In `try { killFork } finally { restartFork }`, a throwing `restartFork` replaces the `killFork` error, so the diagnosis is lost. Also, if `killFork` threw because the container was not running, the round goes on as if a kill happened. **Fix:** catch both, report both, and fail the leg when the kill is not confirmed.

### B-26 [LOW] scripts/z3/assertions.ts:80, :174
`at()` returns NaN for a missing or malformed `writtenAt`. Then `at(branch) <= at(approve)` is false, so the ordering problem is silently skipped. (`approve` lookup with NaN fails closed, but this comparison fails open.) **Fix:** treat a non-finite `at()` as a problem.

### B-27 [LOW] scripts/z3/live-round-wiring.ts:294
`commitSha: process.env.QDS_EXEDEV_SHA ?? ""`: with the env unset, findings are retained with an empty commit sha, and with a stale env, with the wrong one. The round's pinned sha lives in the fork's protocolConfig. **Fix:** take it from the bound run's `externalJobConfig.commitSha` and refuse an empty one.

### B-28 [LOW] scripts/z3/round-plan.ts:74
Dead code: `Z3_WORK_ID` and `Z3_STEP.complete` are exported but never read by any driver, wiring or assertion in the diff. The workId contract the doc comment describes is therefore never checked factory-side. **Fix:** assert `sub.workId` against `Z3_WORK_ID` (one stamp across legs) in `driveKillAndProvision`/AC1, or delete them.

### B-29 [LOW] fork src/lib/server/protocols/protocol-z3-exit-round.ts:209
`readZ3Config` silently drops a non-number `codePollTimeoutMs` (for example the string `"7200000"`), so it falls back to the 1h default. The builder's comment says it refuses rather than falling back silently. **Fix:** pass the raw value through and let the builder's finite/positive check throw.

### B-30 [LOW] scripts/z3/assertions.ts:316
AC7 re-derives credential hits without `knownSecrets`, so the verdict layer cannot detect a shapeless env secret; only the writer can. The AC7 re-derivation is weaker than its doc implies. **Fix:** pass the sink's `knownSecrets` through `assertZ3Round` opts.

### B-31 [LOW] scripts/z3/leg-drivers.ts:112
`boxesFor` matches by substring (`n.includes(runId)`). Any VM whose name contains the runId (for example `<runId>-debug`, or a runId that is a prefix of another) is counted. This fails closed for "exactly one", but it also charges unrelated boxes to the run in cleanup and forensics. **Fix:** exact match on the record's `vmName`, falling back to a delimiter-anchored match.

### B-32 [LOW] scripts/z3/leg-drivers.ts:386
`autoMerge` is detected only from protocol event `type`s matching `/merge/i`. A merge done out-of-band (the code run's PR merged through `gh`, or a merge artifact) is invisible, so the INV-Z3-2 witness can miss the thing it guards against. **Fix:** also check the target repo's PR/merge state for the code run's branch after completion.
