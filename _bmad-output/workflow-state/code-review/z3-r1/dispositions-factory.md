# Z3 R1 — factory-side dispositions

Owner: leaf-F (factory). Fork-side findings E-8, E-14, E-17, B-18, B-19, B-29 belong to the fork leaf and are not disposed here.<br />
Every PATCH is TDD'd in `tests/z3/` (89 pass / 0 fail after the round). Line references are to the R1 post-image.

## Acceptance auditor

| ID | Disposition | Fix / rationale |
|---|---|---|
| A-1 | PATCH | Every fork read now goes through the COMMITTED fork CLI `scripts/z3-exit-round.ts` (`arm` / `state` / `cancel`) via `docker exec <Z3_FORK_CONTAINER> npx tsx <Z3_FORK_CLI>`. The `.unlazy` dump file is gone, and so is `refreshState`'s silent swallow. The live test arms the schedule itself (`armZ3Schedule`). The in-container CLI path is the env var `Z3_FORK_CLI` (default `scripts/z3-exit-round.ts`) until the fork leaf reports it. The harvest half is BLOCKED (see E-2). |
| A-2 | PATCH | The live test arms the schedule only after `gateFire`, using the caps of the same `composeRound` the spend line priced. `armedCapsProblems` refuses the round when the persisted `protocolConfig` caps differ. `driveTrigger` re-sums the fired run's own per-step `externalJobConfig.groupCapUsd` and fails unless it equals the worst case and fits the GO. AC7 re-checks `forkCapsUsd === worstCaseSpendUsd` from disk. |
| A-3 | PATCH | Observe deltas are attributed (`observeDeltas`): boxes named for, provider keys (`record.keyHash`) of, and per-run memory keys (`run_id`) of any fleet run of the bound protocol run are excluded. Anything unattributable stays charged. The fixture now runs the fork ahead (the next leg's box, key and recall key exist before observe reads), plus a fail-closed negative control. |
| A-4 | PATCH | Deterministic window via the committed hold-wrapper (`scripts/z3/fleet-gate.sh`, the SC2.6 mechanism; see the delta section). The watch starts at round start, concurrent with the QA legs, at ordinary poll cadence (the hold keeps the window open, so no fast polling), and stands down via `stopped()` when the round fails. |
| A-5 | PATCH (partial) / DISMISS (box-env probe) | Retain traces are now the factory host client's own journaled `retain` calls (`journalingClient`), an observation and no longer a constant. The box half rests on the memgate issuance ledger filtered to write verbs. Per INV-MG that ledger is the only path a box has to bank-write scope: the host Hindsight token is env-only (INV-HM1) and never delivered. A box-env probe would need a new in-box verb (the registry is closed, ADR-1 §2). |
| A-6 | PATCH | `runZ3Round` writes `<stamp>-z3-round-manifest.json` (filename → sha256 for every leg) in the `finally`. `registryFromManifest` rebuilds the registry for a later audit. AC1 now requires a registry (null means a problem) and flags registered files missing from disk. The live test reads this round's window (`filesSince`) and no longer filters by the registry, so unregistered files are reported. |
| A-7 | PATCH | zod `ForkStateSchema`: `createdAt` is epoch-ms `number`, and a string is refused loudly (test in `wiring.test.ts`). Binding is by the armed `scheduleId`, not `armedAt`. |
| A-8 | PATCH (honest naming) | The fork persists no per-observe read id (`ProtocolRunFactoryStepState` has none; E-1). `observedRunId` is the configured `fromStepOutput` target, recorded as `observedRunIdSource: "fromStepOutput"`. The fork-side witness is the step's `step_completed` (`onFailure: 'fail'`). AC6 now requires `stepStatus === "completed"` and `observedRunId` equal to the matching provision leg's runId, from disk. `observedStatus` was dropped. |
| A-9 | PATCH | AC7 flags any receipt with `ok !== true`. Negative control added. |
| A-10 | PATCH | AC2 recomputes merge from `branch.eventTypes` (and fails when they are absent). It no longer trusts the `autoMerge` flag. |
| A-11 | PATCH | Cleanup runs a second `destroyBoxes` pass over attributed leftovers, then re-inventories, and records `leftoverDestroy` receipts. |
| A-12 | PATCH | The image has no .git, so `state` carries no rev. The rev is the required `SWARMCLAW_FORK_REV`, cross-checked (prefix match) against the image's `org.opencontainers.image.revision` label when present. Otherwise the trigger leg records `forkRevVerification: "unverifiable-from-image"`, labelled explicitly and never a silent null; AC7 requires the label. |
| A-13 | PATCH | `driveBoxForensics` re-reads after `BOX_STABILITY_MS` before calling a box outlived. |
| A-14 | PATCH | One round deadline (`z3LiveDeps({deadline})`) bounds every poll. The live test sets `ROUND_BUDGET_MS` 200 min + `CLEANUP_BUDGET_MS` 25 min + 10 min margin = test timeout. |

## Blind hunter

| ID | Disposition | Fix / rationale |
|---|---|---|
| B-1 | PATCH | `runCleanup` first cancels the bound fork protocol run (`cancelProtocolRun`), sweeps every factoryState runId from a fresh `state`, unions in the cancel's `fleetCancelled`, and only then destroys, revoke-verifies and inventories. `driveTrigger` binds the protocolRunId before its own checks, so a refused fire is still cancelled. |
| B-2 | PATCH | See A-2. |
| B-3 | PATCH | (a) the watch starts at round start; (b) cadence no longer matters, because the hold-wrapper keeps the window open; (c) no stale file: every read is a fresh exec. AC4 requires `stepStatusAtKill === "submitting"`, and on an absent record requires the surviving record's `createdAt >= killedAt`. |
| B-4 | PATCH | `recordAtKill` is an explicit witness (`{state:"absent"}` or `{state:"present",runId,createdAt}`). A missing witness fails AC4. A driver-path negative control (a record recreated across the kill) was added. |
| B-5 | PATCH | The driver and AC3 both require the same single box in both stability samples (`boxCountSamples` all 1). |
| B-6 | PATCH | Bookings: each ≤ 1 and the sum ≥ 1 ("spend escaped the ledger"). Not "exactly 1 each": `budget_group_admissions` exists only when the submit carries a budget group (src/fleet/submit.ts:143), so requiring both would false-red a correct run. |
| B-7 | PATCH | See A-5. |
| B-8 | PATCH | See A-9. AC7 also requires one `boxDestroy` receipt per cleanup runId with `exitCode === 0`. |
| B-9 | PATCH | `tail()` scrubs before truncating everywhere (approve tails, cleanup problems, stderr). Regression test with a key straddling the cut. |
| B-10 | PATCH | `gh[pousr]_` in SCRUB and DETECT. `GH_TOKEN`/`GITHUB_TOKEN` added to the live test's `knownSecrets`. |
| B-11 | PATCH | See A-6. AC1 also asserts per-leg counts from the round shape (provision/forensics = lenses+1, observe/retain = lenses, others 1). |
| B-12 | PATCH | See A-14. |
| B-13 | PATCH | `RUNS_DIR = path.resolve(REPO_ROOT, QDS_RUNS_DIR ?? ".sandbox/runs")` is resolved once and used for the store, the ledger, the allowlist and every `--dir`. |
| B-14 | PATCH | See A-12. |
| B-15 | PATCH | See A-7. |
| B-16 | DEFER-UPSTREAM | See E-2. |
| B-17 | PATCH | The approve leg's `exitCode` is the leg verdict. The CLI code is recorded as `cliExitCode`. |
| B-20 | PATCH | No dump file is left to go stale. A `state` read that fails is retried for at most `STATE_OUTAGE_MS` (180 s, covering the crash-window restart) and then throws. zod drift throws at once. |
| B-21 | PATCH | AC2 re-derives scrypt verification from the CLI's own decided line in `stdoutTail` (`outcome`, `approverId`, `state`) plus `cliExitCode`. Negative control: a forged `scryptVerified:true`. |
| B-22 | PATCH (comment) | `Z3_LEG_ORIGIN` is documented as a writer label, not provenance. Provenance is the registry and manifest (A-6). A per-driver capability token would be ceremony over the same in-process trust. |
| B-23 | PATCH | The allowlist is merged into the existing approvers (never replaced) and written with `mode: 0o600` from creation. `.factory` gets mode 0700 only when created and is never re-moded. The restore writes 0600. |
| B-24 | PATCH | `settle` spreads `body` first and the writer-derived fields last. |
| B-25 | PATCH | Kill and restart errors are both captured (`killErrors`). Any of them fails the crash-window leg. |
| B-26 | PATCH | A non-finite `writtenAt` is an AC2 problem. The branch-after-approve check is `!(at(branch) > at(approve))`, which fails closed. |
| B-27 | PATCH | See E-11. |
| B-28 | DISMISS | Already fixed in the contract-sync round: `Z3_WORK_ID` is read by AC1's stamp check, and `Z3_STEP.complete` is now read by `driveBranchAndComplete`, which requires `step_completed` on `z3-complete`. |
| B-30 | PATCH | `assertZ3Round` / `assertAc7LiveRules` take `knownSecrets`, and the live test passes the sink's. |
| B-31 | PATCH | `boxesFor` uses an exact name (`=== runId` or `=== vmName`), never a substring. |
| B-32 | DISMISS | No merge path exists inside the round. Harvest lands commits only at `refs/sandbox/<runId>` (src/providers/harvest.ts header, INV-2), and the box holds no push credential (D8/INV-1). A PR is a separate human path outside the round. The event-type check covers the protocol side. |

## Edge-case hunter

| ID | Disposition | Fix / rationale |
|---|---|---|
| E-1 | PATCH | zod-parsed fork CLI `state` (epoch-ms `createdAt`, events joined in, as the fork CLI emits them). `observedRunId`/`observedStatus` are no longer read from factoryState (see A-8). |
| E-2 | **DEFER-UPSTREAM** (driver ruling) | An A2 seam gap, filed by the driver as the harvest-persistence issue (TBD), sibling of #465. Traced against source: a dispatch_task phase's value is `MergedOutput` (cli-anything/src/types.ts:197), which has no `kind`. pipeline-run records envelopes only when `looksLikeEnvelope` holds (scripts/pipeline-run.ts:4700), so the team's findings JSON never reaches `trace.db`/`events.jsonl`. `PhaseRecord` carries no value, `journal/final.json` is `{ok, completedAt}`, and `fleet result` exposes only the bundle. The harvested artifacts hold the findings only in raw session transcripts. The wiring keeps an injected `readHarvest`, and the live test's refuses by name, citing both blockers: "harvest persistence (issue TBD) and #465". Nothing in src/ or pipeline-run.ts is touched. |
| E-3 | PATCH | See A-3. Per-run memory keys whose `run_id` is a fleet run of the protocol are excluded from observe deltas. The append-only issuance ledger no longer reads as "observe minted a memory key". |
| E-4 | PATCH | `writeCredentialsFor` filters on verbs: only per-run issuances for the run carrying a non-`recall` verb count. Recall-only keys are recorded as `runMemoryKeys`. An unparseable `claims_json` is treated as write-capable (fail-closed). AC5's bank check is now `BankIdSchema` rather than a `qds-` prefix, because `retainFindings` already enforces the dispatch-recall family guard (src/qa/retain.ts:185-195, seam gap #11: org-slug families carry no `qds-` prefix). |
| E-5 | PATCH | See B-1. |
| E-6 | PATCH | See A-4. |
| E-7 | PATCH | `awaitStepSubmitted` returns once `runId && requestId` exist, whatever `lastError` says. It fails only on `failed`/`cancelled`. The seen `lastError` is recorded as `lastErrorSeen`. |
| E-9 | PATCH | Bind once: `awaitTrigger` binds the single run of the armed `scheduleId` (more than one is refused), and every later read filters on `r.id === bound`. `cancelProtocolRun` refuses any id but the bound one. |
| E-10 | PATCH | See A-14. |
| E-11 | PATCH | `commitSha`/`repoSlug` come from the bound run's QA step `externalJobConfig`. The bank is `resolveProvisionedRepoBankId(resolveBankId(repoSlug), extractExistingBankIds(listBanks()))`, exactly dispatch's recall resolution (src/fleet/dispatch.ts:2283). |
| E-12 | PATCH | In `awaitResult`, `fleet result` exits other than 4 are transient (polled to the round deadline). Exit 4 throws. |
| E-13 | PATCH | See B-13 / B-23. |
| E-15 | PATCH | `gate_admissions` and `budget_group_admissions` are both counted `WHERE request_id = ?`. |
| E-16 | PATCH | See B-4. |
| E-18 | PATCH | See A-3. |
| E-19 | PATCH | Every leg write goes through `write()`. A refused write throws an error carrying both the scrub hits and the leg's own problems. |
| E-20 | PATCH | Leftovers are attributed to this round's runIds (tracked ∪ swept ∪ fork-cancelled). Fresh boxes nobody claims are recorded as `unattributedFreshBoxes` for the operator, not charged. |

## Fork R1 contract delta (folded in)

| Item | Change |
|---|---|
| Fork CLI | `docker exec -w /app <Z3_FORK_CONTAINER> npx tsx scripts/solstice/z3-exit-round.ts <arm\|state\|cancel>`. `Z3_FORK_CLI` / `Z3_FORK_WORKDIR` override it. `createdAt` and the event `at` field are epoch-ms numbers (zod). `cancel` is trusted for the external_job runIds, and cleanup still sweeps and `fleet cancel`s every factoryState runId itself. |
| `z3-unmatched` | Added `Z3_STEP.unmatched`. A `caseId` of `unmatched` (or anything other than `approved`) is red in both the driver and AC1. Negative control added. |
| A-8 (observe) | `observedRunId` and the completion are read from the observe step's OWN `factoryState[stepId]` (`runId` = the fork-resolved target, `status` = `completed`). No `observedStatus`. |
| Crash window | Committed `scripts/z3/fleet-gate.sh`: the fork container's `SWARMCLAW_FACTORY_FLEET_CLI` (SC2.6 window (a)). It passes every verb through byte-exact except an ARMED `submit` whose brief carries `w:z3-*-code`, which it holds before the exec. Config rides files (the SC2.5 env allowlist strips env): `.sandbox/z3-gate/{real-cli,armed,release,abort,journal.jsonl}`. The host half is `scripts/z3/crash-gate.ts` (operator setup documented there and in the live test header). The driver arms the gate before the schedule exists, waits for `submitting` + requestId in `state`, confirms the wrapper journal shows `held`, then kills, releases and restarts. The replay passes the released gate. Cleanup aborts the gate first, so a failed round's held submit exits 99 having exec'd nothing. AC4 additionally requires `heldAtKill === true` and exactly one `exec` across kill + replay (`submitExecs`). The wrapper is fixture-tested for real (7 tests: pass-through, QA never held, disarmed pass-through, hold → release, replay passes, abort → 99 with no exec, unconfigured → 98). |
| Fork rev | Taken from the required `SWARMCLAW_FORK_REV`. When the image carries an `org.opencontainers.image.revision` label, the trigger leg cross-checks it (prefix match): `forkRevVerification: "image-label"`. Otherwise it is explicitly `"unverifiable-from-image"`. |
