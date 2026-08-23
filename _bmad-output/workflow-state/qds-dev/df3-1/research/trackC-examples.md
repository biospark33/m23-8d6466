# Track C — Completed-story examples (done 2026-08-21)
KEY: newId(slug, now?) @ src/providers/run-record.ts:179 mints `<slug>-YYYYMMDD-6hex` (qds-20260811-a3f19c). DF3.1 REUSES newId as mintRunId — never re-implement.
- CLI pattern (all 4 stories): import from ../src/providers/index.ts + scripts/lib/cli-args.ts {tokenizeArgs, parseValueFlags}; newRequestId/setLogSink from src/swarmclaw/log.ts; setLogSink to stderr JSON lines
- DI seam: XxxDeps interface, run(argv, deps: Partial<Deps>) => Promise<exitCode>; driver??resolveDriver(name), store??new RunRecordStore({requestId})
- DF2.6 sweep deps pattern + fixtures/fleet-state.ts; DF2.8 CostLedger injection; DF2.5 TeardownDeps {driver,store,requestId,gitCwd,runsDir,keyApi,costLedger}
- Exit codes: 0 ok / 1 error / 2 usage. Dry-run default + --yes (reap). existsSync pre-check fail-closed (qds-cost)
- O_EXCL 0600 record create (O_WRONLY|O_CREAT|O_EXCL); atomic temp+rename update; record-before-VM ordering INV
- RUN_ID_RE `/^[a-z0-9][a-z0-9-]*$/` validated at parseArgs before path join; 63-char ceiling
- assertNoSecret heuristic — record stores keyHash only
- DF2.5 teardownSandbox(deps, runId, {noHarvest}) @ src/providers/teardown.ts; harvestRun(deps, runId) -> {outcome,count} @ src/providers/harvest.ts; getRecord({store}, runId) typed errors @ index.ts
- DF2.8 assertWithinBudget(ledger, {repoSlug, issueId, runId, requestId}, keyCapMicroUsd?) throws OverBudgetError
- DF2.6 checkHeadroom(driver, requested, limits?) -> {allowed, liveVms, ceiling, headroom, reason?}
- DF2.1 driver.ts exports createRun/fillRun/setupRun/executeRun/observeRun/teardownRun/reapRuns
- Teardown six-step order enforced via call-order capture; harvest failure aborts BEFORE destroy
