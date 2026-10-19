# Z3 R1 — Edge-Case Hunter

Scope: `z3-factory.diff` (scripts/z3/**, tests/z3/**, tests/fleet/e2e/z3-exit-round.live.test.ts) and `z3-fork.diff` (protocol-z3-exit-round.ts, the scheduler.ts hook). I checked every claim below against source in both repos: the fork worktree `z3-sc` and the factory clone. Line numbers refer to the files on disk.

Summary: 7 HIGH, 7 MED, 6 LOW.

---

### E-1 [HIGH] scripts/z3/live-round-wiring.ts:118
**Problem.** The wiring needs a day-of state dump that does not exist, and the field shapes it assumes disagree with what the fork persists. `pollRun` binds a run with `Date.parse(r.createdAt ?? "") >= armedAt`. The fork's `ProtocolRun.createdAt` is a **number** (src/types/protocol.ts:477). `Date.parse(1760000000000)` and `Date.parse("1760000000000")` both return `NaN` (I checked this in bun and node), so the comparison is always false. `events` is not a field on `ProtocolRun`, since `appendProtocolEvent` writes to a separate store. `factoryState[*].observedRunId/observedStatus` do not exist on `ProtocolRunFactoryStepState` (protocol.ts:406-414: stepId, requestId, status, runId, submittedAt, pollAttempts, lastError). The dump producer `.unlazy/z3/z3-day-of.ts` is not in the repo or in `.unlazy/z3/`, which holds only GATES.md and PLAN.md. No git history has it either.<br />
**Scenario.** The operator writes the obvious dump, `JSON.stringify(loadProtocolRuns())`. `awaitTrigger` never binds, so the round waits the full 180 min `STEP_DEADLINE_MS` and fails after the fork has already spent on every leg it chained on its own. If the dump omits `events`, `awaitObserveStep` and the `branch_taken` witness never resolve.<br />
**Fix.** Check the dump script into the repo as a contract artifact, or normalize on the read side: `typeof createdAt === "number" ? createdAt : Date.parse(createdAt)`. Pin the dump schema with a zod parse in `readState` (events joined in, createdAt as epoch ms) so a shape drift fails loudly instead of waiting out the deadline. Drop `observedStatus` or source it from the `factory_observe` artifact.

### E-2 [HIGH] scripts/z3/live-round-wiring.ts:52 (retainFindings) + scripts/z3/leg-drivers.ts:525-534
**Problem.** `retainFindings` throws right away when `.unlazy/z3/harvest/<runId>.json` is absent, and nothing in the round writes that file. The A2 precedent (`scripts/qa/live-round-wiring.ts`) has no harvest-file producer either, and `normalizeHarvest`'s only other consumers are tests. The retain leg runs seconds after `driveQaRunObserve` returns, with no poll and no wait.<br />
**Scenario.** The first QA leg finishes and observe passes. `driveFindingsRetain` then throws "no harvested findings", the round fails, and the fork keeps chaining legs 2, 3 and the code run (see E-4).<br />
**Fix.** Extract the harvest inside the wiring from the run's `fleet result` `artifacts.bundle` (or whatever `fleet harvest` produces), or poll for the file with a bounded deadline and document which day-of process writes it.

### E-3 [HIGH] scripts/z3/leg-drivers.ts:228 + live-round-wiring.ts:277-281 (memgate ledger is append-only)
**Problem.** `memgate_issuance` is append-only. Triggers `memgate_issuance_no_update` and `no_delete` are at src/memgate/ledger.ts:71-76, and revocation goes to `memgate_revocations`. `memoryKeyIds()` lists **every** issuance ever made. The observe baseline is taken **before** the observed leg provisions. Dispatch mints a per-run memgate key for every fleet run whenever the gateway env is configured (src/fleet/dispatch.ts:2245-2300, `mintRunMemoryKey`). The live round needs `QDS_KG_GATEWAY_URL` for `gatewayAssert` and for priming.<br />
**Scenario.** QA leg 1 dispatches and mints a per-run key, which is now in the issuance table permanently. `driveQaRunObserve` diffs after against the pre-provision baseline, finds that key, and fails: "observe minted a memory key". This happens on every observe leg of a correct round.<br />
**Fix.** Subtract revoked tokens (join `memgate_revocations`) and any token whose `run_id` is the observed run. Better: count issuances with `created_at_ms` inside the observe step's own start..end window. The ponytail note calls this a "fail-closed false positive". In practice it is a guaranteed red round.

### E-4 [HIGH] scripts/z3/leg-drivers.ts:261 (findings-retain "write credential")
**Problem.** `memoryRunKeysFor(runId)` returns every `kind='per-run'` issuance for the run, and the leg reads any hit as "memory write credential(s) issued to the run". Per-run keys are **recall-only**: `verbs: ["recall"]` (gateway.ts:107; schemas.ts:8 "per-run keys carry the literal ["recall"] tuple"). Dispatch mints one per run whenever the gateway is configured (E-3).<br />
**Scenario.** On a correct round with the memory lane on, every `findings-retain` leg fails, and AC5 fails with "a write credential existed in the box".<br />
**Fix.** Parse `claims_json` and flag only scopes whose `verbs` include a write verb (retain/ingest), or agent tokens bound to the run. Rename the field to `boxWriteCredentials` only once it actually filters to write scope.

### E-5 [HIGH] scripts/z3/leg-drivers.ts:552 (runCleanup) — the fork protocol keeps spending after a factory-side failure
**Problem.** The fork chains the steps on its own, and the factory driver only reacts. On any failure, cleanup cancels only the `runIds` it has `track`ed. It never cancels the fork **protocol run**. A leg that fails after its fleet run went terminal (retain, priming, forensics or observe check) leaves the fork already submitting the next external_job, whose runId was never tracked.<br />
**Scenario.** QA leg 1's retain throws (E-2). The fork has already submitted `qa-leg-<lens2>`. Cleanup destroys leg 1's box (already gone), and the final inventory runs before leg 2's box exists, so leftover is `[]` and the cleanup record reads green. Legs 2 and 3 and the code run then provision and run unobserved for up to `pollTimeoutMs` each, with nothing torn down until the fork's own deadlines fire.<br />
**Fix.** Make cleanup cancel the fork protocol run first: a `docker exec … z3-day-of.ts cancel <protocolRunId>`, or the fork's cancel API, which already fleet-cancels outstanding factoryState entries. Then sweep every `factoryState[*].runId` from a fresh dump, not just the tracked set. Take the final inventory after that sweep settles.

### E-6 [HIGH] scripts/z3/leg-drivers.ts:539 (armCrashWindow) — the crash window is raced against the factory's own retain
**Problem.** The fork submits `z3-code-run` as soon as the last `qa-observe-<lens>` completes. The driver does not start polling for `submitting` until it has finished the last lens's `driveFindingsRetain` (Hindsight retain plus a gateway round-trip) and an inventory call. `submitting` lasts only as long as one `fleet submit` exec (protocol-factory.ts:150-200). The poll cadence is `docker exec npx tsx` (seconds of cold start) plus a 10 s sleep.<br />
**Scenario.** By the time `awaitStepSubmitting` first reads, the entry is already `submitted`. The wiring throws "crash window was missed; re-run the round". All QA spend is gone, AC4 is unproven, and E-5 leaves the code run going.<br />
**Fix.** Arm the kill fork-side: a test-only hook or env flag that makes the external_job processor pause, or SIGKILL itself, after persisting `submitting` for `z3-code-run`. Or have the wiring watch the fork's event stream for `step_started` on `z3-code-run` concurrently with the QA tail. A 10 s file poll cannot reliably catch a sub-10 s window.

### E-7 [HIGH] scripts/z3/live-round-wiring.ts:204 (awaitStepSubmitted throws on any `lastError`)
**Problem.** The fork writes `lastError` for **recoverable** conditions: replay exits 1/3/6/-1 (`REPLAY_EXIT_CODES`, protocol-factory.ts:55, :209), "ack unreadable … replaying the same request id" (:190), and transient poll errors via `bumpPollAttempts` (:311, :325, :330). It clears the field only on the next healthy poll. The wiring checks `lastError` **before** it checks `runId`, so it throws.<br />
**Scenario.** The crash re-drive is exactly the path that hits a replay exit: the killed submit's intent is still held, giving exit 3 or 6, and `lastError` is set. The driver throws "errored fork-side" on a run the fork goes on to submit successfully. The same thing happens if a QA leg's `fleet result` poll blips once before the driver reads it.<br />
**Fix.** Return as soon as `runId && requestId` are present, whatever `lastError` says. Fail only when `status === "failed" | "cancelled"`. Record any `lastError` seen into the leg's evidence instead of throwing.

---

### E-8 [MED] src/lib/server/runtime/scheduler.ts:503-506 — fire-time throw rejects the whole tick (daemon shutdown)
**Problem.** `tick` runs from `setInterval(tick, …)` (:241) with no catch around the protocol branch. The new path adds throws at fire time: `buildZ3ExitRoundSteps` re-validates the persisted row, and both `await import(...)` and `createProtocolRun` can throw. The once-schedule has **already** been upserted as `completed` (:501, `advanceSchedule`). In the daemon, `unhandledRejection` triggers `shutdown(...)` then `process.exit(1)` (daemon-runtime.ts:339-349). The import also runs for **every** protocol schedule, so a z3 module load failure breaks all protocol schedules, not just z3.<br />
**Scenario.** A hand-edited row, a `codePollTimeoutMs` that became a string, or a deleted anchor template makes the fire throw. The daemon exits. The schedule is `completed` with no `schedule_failed` history, so the round silently never fires, and the remaining due schedules in that tick are skipped.<br />
**Fix.** Check `protocolTemplateId === 'z3_exit_round'` before importing. Wrap the z3 fire in try/catch that marks the schedule `failed` with a history entry and a `schedule_failed` main-loop event, matching the `agent_not_found` arm at :420-433, then `continue`.

### E-9 [MED] scripts/z3/live-round-wiring.ts:116-120 — each poll re-selects "latest z3 run", not the triggered run
**Problem.** `awaitTrigger` returns `protocolRunId`, but every later `pollRun` picks `.at(-1)` of all z3 runs created at or after `armedAt`, ignoring that id. Only `awaitProtocolComplete` compares `run.id`.<br />
**Scenario.** The operator arms a second z3 schedule, or re-arms after a failed attempt. Mid-round, `awaitStepSubmitted`/`awaitObserveStep` silently read the other run's factoryState: wrong runIds get tracked and cancelled, and wrong boxes get forensics. `awaitProtocolComplete(protocolRunId)` then never matches (the latest is the other run) and times out at 180 min.<br />
**Fix.** Bind once. After `awaitTrigger`, store `protocolRunId` in the deps closure and have `pollRun` select `r.id === boundId`. Also refuse when more than one z3 run exists at or after `armedAt`.

### E-10 [MED] tests/fleet/e2e/z3-exit-round.live.test.ts:97 — test timeout below worst-case round; `finally` cleanup lost on timeout
**Problem.** The test timeout is 240 min. The worst case allowed by the deadlines is longer: 3 QA legs at the 1 h `QA_POLL_TIMEOUT_MS` each, plus the code run (1 h default, including the park), plus observes and the kill/restart. `STEP_DEADLINE_MS` is 180 min **per `pollRun` call**, not per round, despite the comment at :57. When bun's test timeout fires, the async body is abandoned and the process exits after the suite, so `runZ3Round`'s `finally` (`runCleanup`) never runs.<br />
**Scenario.** Slow boxes push the round past 4 h. bun reports a timeout, and no revoke-verify, box destroy or cleanup record ever runs. AC7's "on every path" claim breaks on exactly the path most likely to leave boxes alive.<br />
**Fix.** Give the round one shared deadline, threaded through pollRun and awaitResult, set below the test timeout minus a cleanup budget. Or raise the test timeout above the sum of the fork deadlines plus cleanup.

### E-11 [MED] scripts/z3/live-round-wiring.ts:294 — retain uses env commitSha/slug, not the round's pinned values
**Problem.** `commitSha: process.env.QDS_EXEDEV_SHA ?? ""`. `retainFindings` refuses a non-40-hex sha (src/qa/retain.ts:171), and the live test never gates on this env var. `resolveRepoSlug` falls back to `basename(cwd)`, which gives "QDS-Factory" with no owner. The round's real sha and slug are pinned in the fork schedule's protocolConfig and copied into every step's `externalJobConfig`, which the dump carries. The default bank `Z3_QA_BANK ?? "qds-factory"` is also not derived from the bank set dispatch recalls from (`resolveProvisionedRepoBankId(resolveBankId(repoSlug))`, dispatch.ts:2283), so the retained docs can land in a bank the code run's priming never recalls.<br />
**Scenario.** If `QDS_EXEDEV_SHA` is unset, the first retain throws. If it is stale, findings are tagged to the wrong commit. If the bank is wrong, AC1 fails with "priming round-trip open".<br />
**Fix.** Read `commitSha` and `repoSlug` from the bound run's `steps[qa-leg-*].externalJobConfig`. Resolve the bank the same way dispatch does, or assert that `Z3_QA_BANK` is in the dispatch fan-out set before firing.

### E-12 [MED] scripts/z3/live-round-wiring.ts:140 (resultOf) — one transient `fleet result` failure ends the round
**Problem.** `resultOf` throws on any non-zero exit, with no retry. The fork's own poller treats every exit other than 4 as transient (protocol-factory.ts:311-325), and so did A2's `awaitTerminal`. `awaitResult` calls `resultOf` in its loop, and so does `retainFindings`.<br />
**Scenario.** A lock-contention exit 1 or a sqlite busy error during a 75-minute wait fails the leg and the round.<br />
**Fix.** In `awaitResult`, treat exit codes other than 4 as "keep polling" until the deadline. Throw only on exit 4 or on deadline expiry.

### E-13 [MED] scripts/z3/live-round-wiring.ts:178 — allowlist path diverges from fleet's when `QDS_RUNS_DIR` is absolute
**Problem.** `path.join(REPO_ROOT, RECORDS_DIR, …)` does not reset on an absolute segment. `fleet approve --dir RECORDS_DIR` authenticates against `<dir>/.factory/approvers.json` (scripts/fleet.ts: `authenticate(dir ?? process.cwd(), …)`). The ledger path in the same module already uses `path.resolve` (:270). Separately, `chmodSync(factoryDir, 0o700)` permanently changes the mode of a pre-existing `.factory`, and `restoreApprovers` does not undo that.<br />
**Scenario.** With `QDS_RUNS_DIR=/srv/runs`, the allowlist is written to `<repo>/srv/runs/.factory/…`. Approve exits 5, and AC2 fails on a correct round.<br />
**Fix.** Use `path.resolve(REPO_ROOT, RECORDS_DIR)` in one place for both. Record the prior mode and restore it.

### E-14 [MED] src/lib/server/protocols/protocol-z3-exit-round.ts:115 — "the LLM decider is never consulted" is not what the code does
**Problem.** `processBranchStep` (protocol-step-processors.ts:337-345) calls `defaultDecideBranchCase`, an LLM call through the facilitator, whenever no `when` matches. Having no `defaultNextStepId` only matters **after** that. `artifact_field_equals` reads the **newest** `factory_result` (protocol-step-helpers.ts:367-386) and returns false on unparseable JSON. `fireZ3ExitRoundRun` also drops `facilitatorAgentId`, `observerAgentIds` and `config.goal`, all of which `launchProtocolRunForSchedule` sets (protocol-run-lifecycle.ts:881-901). The fork test checks only that `defaultNextStepId` is null.<br />
**Scenario.** A truncated or unparseable code-run verdict artifact makes the deterministic cases miss. The LLM then picks `approved` or `completed`, and a `branch_taken` witness lands that no rule decided. The factory's verdictStatus check catches a mismatch, but the fork-side invariant the comment states is false.<br />
**Fix.** Add a third case with no `when` that routes to a fail step, or pass a `decideBranchCase` that returns null for this template. Fix the comment, and add a fork test with an unparseable verdict that asserts no `llm.invoke` call.

---

### E-15 [LOW] scripts/z3/live-round-wiring.ts:272 — ledger double-booking check can never fire
`gate_admissions` has PK `(request_id, run_id)` and the query counts `WHERE run_id = ?`, so the count is at most 1 by construction. `budget_group_admissions` has PK `(group_id, request_id)` (src/providers/cost-ledger.ts:409, :434), so `groupReservations` is also at most 1. A re-drive that books under a **new** runId for the same requestId shows `gateAdmissions = 1`.<br />
**Fix.** Count `gate_admissions WHERE request_id = ?`, which catches two runs booked against one request.

### E-16 [LOW] scripts/z3/leg-drivers.ts:393 — `recordBeforeKill` is almost always null, so AC4's "record untouched" arm is vacuous
At `submitting` the `fleet submit` exec is still in flight and no run record exists yet. `assertAc4CrashWindow` skips the mutation check when `before` is null, so AC4 rests on the post-redrive record count alone.<br />
**Fix.** Either sample the record store right before the kill and refuse to arm until the intent or record exists, or record `recordBeforeKill: null` as an explicit "submit had not yet written" witness. Don't count it as a passed check.

### E-17 [LOW] src/lib/server/protocols/protocol-z3-exit-round.ts:209 + :93 — silent fallbacks on the persisted config
`readZ3Config` silently drops a non-number `codePollTimeoutMs` (for example `"7200000"` from a JSON edit) and falls back to the 1 h default. That is the very silent fallback the builder's comment at :500 says it refuses. The code observe step also hard-codes `QA_POLL_TIMEOUT_MS` instead of `codePollTimeoutMs`. That is harmless today because observe starts after the target is terminal, but it becomes wrong if a lens step ever overlaps.<br />
**Fix.** In `readZ3Config`, pass `bag.codePollTimeoutMs` through unchanged when present so the builder refuses a non-number.

### E-18 [LOW] scripts/z3/leg-drivers.ts:228 — observe snapshot also charges the NEXT leg's box and keys
Separate from E-3: the fork submits the next leg as soon as the observe step completes, and the driver snapshots only after a 10 s-plus poll. The next leg's box and provider key can already exist. The ponytail note records this ceiling, but on a 3-lens round it is a likely false red for the boxes too.<br />
**Fix.** Filter `boxesProvisioned` and `providerKeysMinted` to anything not attributable to a known factoryState runId of the bound run, or snapshot at the `step_completed` event time from fork-side data.

### E-19 [LOW] scripts/z3/leg-drivers.ts:133 (settle) — a scrub refusal replaces the leg's real problems
If `writeZ3Evidence` throws, for example because a `stderrTail` contains a credential-shaped string, `settle` never reaches its own throw. The leg's problems are lost and the round failure reads "failed the secret scrub". `runCleanup` guards its write, but the 11 leg drivers do not.<br />
**Fix.** Wrap the write. On refusal, throw an error that carries both the scrub hit names and the original `problems`.

### E-20 [LOW] scripts/z3/leg-drivers.ts:466 (cleanup leftover) — any unrelated box on the account counts as a leak
`fresh(finalBoxes, start)` marks every box created on the shared exe.dev account during a 4 h round as "outlived the round", including the operator's other work. It also never destroys or attributes them.<br />
**Fix.** Filter leftovers to `qds-` run-shaped names, or to names matching a runId found in the bound protocol run's factoryState.
