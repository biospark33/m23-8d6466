# Z3 R3: fork-side dispositions (leaf-K)

Fork worktree: `solstice-ai/.claude/worktrees/z3-sc`, branch `feature/z3-exit-round-counterpart`. Nothing is committed.

| Finding | Disposition | Note |
|---|---|---|
| E-3 (poller replays an in-flight submit, exit 5 fails the leg) | **PATCH (real, reproduced)** — outside Z3's own files | I checked the fork source and the finding holds.<br />1. `processExternalJobStep` persists `status:'submitting'` before the exec (protocol-factory.ts SC2.1 seam).<br />2. `pollFactoryRunsInner` calls `processExternalJobStep` for every `submitting` entry, and the heartbeat ticks every 60 s (`heartbeat-service.ts:41`, `:652-653`). The only guard is `pollInFlight`, which serializes the poller against itself, not against the run loop.<br />3. A replay with an id still `in-flight` gets `SubmitError(5, "submit-in-flight")` (factory `src/fleet/submit.ts:529-539`). `REPLAY_EXIT_CODES` is `{1, 3, 6, -1}`, so exit 5 goes to `failOrAdvance` and the step fails.<br />4. A real provisioning submit outlives 60 s (`FLEET_EXEC_TIMEOUT_MS` note: the ack was still pending at 60 s in SC2.6).<br />Every normal Z3 QA leg whose submit spans a tick can therefore reach this.<br />**Fix:** a process-local `submitsInFlight` set keyed `${runId}:${stepId}`, added just before the submit exec and deleted in `finally`. `processExternalJobStep` returns early, with no replay and no persist, while its own exec holds the key. After a crash the set is empty, so the SC2.6 replay-on-restart path is unchanged. Running steps for the same run twice is already serialized by the protocol lease, so only the poller hits the guard.<br />**Test:** `protocol-factory.test.ts`, "Z3 R3 E-3: …". The run loop's first submit blocks mid-exec, a `pollFactoryRuns` tick lands, and the fake returns exit 5 for any second submit. Before the fix it failed with `2 !== 1` submits. After the fix there is exactly 1 submit, the entry ends `submitted` with `runId` `qds-run-1`, and the run did not fail. The file passes 27/27.<br />**Surface:** `protocol-factory.ts` is the SC2 adapter, not a Z3 file. The change is 16 lines with a comment. It is filed under this PR because Z3 is the first round to drive it live. If you would rather land it as its own fork PR, it stands alone (one file plus its test). |
| B-11 (observe id derived from the lens index) | PATCH | `qa-observe-<lens>` now derives from the observed leg: `leg.id.replace(/^qa-leg-/, '')`. A reorder or filter in `buildQaHunterPackSteps` can no longer mispair an observe with its leg. The now-unused `QA_LENS` import is dropped. The existing tests already pin the pairing by name (each `qa-observe-<lens>` has `fromStepOutput: qa-leg-<lens>`). The step-id list is unchanged. |
| A-10 (fork CLI test not wired into any package.json script) | DISMISS (verified) | The test is wired. `npm test` runs `test:solstice`, which runs `node scripts/run-solstice-tests.mjs`. That runner walks `scripts/solstice/` (`allFiles = [...walk('src'), ...walk(path.join('scripts', 'solstice'))]`) and selects `(f) => f.startsWith('scripts/solstice/')`. So `scripts/solstice/z3-exit-round.test.ts`, like its 39 siblings, runs under `npm test` and does not need a `package.json` entry. |
| B-2 / A-3 (arm timeout leaves an armed row with `armed` undefined) | n/a fork (factory) | No fork change is needed. `state` lists every z3 schedule with its `status`, and `disarm` is idempotent. When arm fails, the factory's `finally` can read `state`, disarm every `active` z3 schedule created after the arm attempt, and cancel any run carrying that `scheduleId`. |
| A-5 (stale CLI contract header, factory) | n/a fork | Factory comment only. The fork CLI header lists `arm`, `state`, `cancel` and `disarm` with the full output shapes. |
| All other R3 items (B-1–B-10, B-12+, E-1, E-2, E-4+, A-1–A-4, A-6–A-9) | n/a (factory) | None of these touches fork code. |

Gates (fork worktree):

- `protocol-z3-exit-round.test.ts`: 20/20
- `scripts/solstice/z3-exit-round.test.ts`: 13/13
- `protocol-factory.test.ts`: 27/27 (the new E-3 test included)
- `protocol-factory-observe.test.ts`: 8/8
- Regression: `protocol-qa-hunter-pack` 6/6, `protocol-triggers` 10/10, `protocol-z2-e2e` 4/4, `runtime/scheduler` 19/19
- `npx tsc --noEmit -p tsconfig.json`: exit 0
- `npx eslint` on the 7 changed `.ts` files: exit 0

Contract changes for the factory: none. The step ids, the CLI verbs and the output shapes are all unchanged since R2.

## R3 verification follow-up

| Finding | Disposition | Note |
|---|---|---|
| N-2 (engine re-entry spins while the poller holds the `submitsInFlight` key) | **PATCH (real, reproduced)** | The spin is real. `runProtocolRun` flips a `waiting` run to `running` before its loop (protocol-run-lifecycle.ts:519-527). In cursor mode the loop calls `stepProtocolRun` while `run.status === 'running'` and breaks only on `waiting` or a terminal status (:604). The E-3 guard returned `run` unchanged, still `running`, so each iteration re-stepped it until `MAX_STEP_ITERATIONS` (500) failed the run.<br />**Fix:** on a guard hit, `processExternalJobStep` re-parks: `persistRun(parkRunWithFactoryState(run, step, existing))`. This restores F-002 parity: cursor mode goes to `waiting` and the loop breaks, while DAG mode keeps a running entry and the park predicate breaks. The re-park cannot land over the ack, because the key is deleted in the exec's `finally` and the ack persist follows synchronously, with no `await` in between.<br />**Test:** `protocol-factory.test.ts`, "Z3 R3 N-2: …". Attempt 1 exits -1, which leaves the entry `submitting`. The poller then replays and holds its exec open, and `runProtocolRun` re-enters the engine during the replay. Before the fix it ended `failed` with "Exceeded maximum step iterations (500)". After the fix the engine returns `waiting`, adds no submit (still 2), and after release the entry is `submitted` and the run has not failed. The E-3 test still passes. |

Gates (re-run after N-2):

- `protocol-factory` 28/28 (E-3 and N-2 included)
- `protocol-factory-observe` 8/8
- `protocol-z3-exit-round` 20/20
- `scripts/solstice/z3-exit-round` 13/13
- `protocol-qa-hunter-pack` 6/6, `protocol-triggers` 10/10, `protocol-z2-e2e` 4/4, `runtime/scheduler` 19/19
- `tsc --noEmit` exit 0; `eslint` on the 7 changed `.ts` files exit 0

Contract changes for the factory: none.
