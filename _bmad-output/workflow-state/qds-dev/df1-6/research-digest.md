# DF1.6 Research Digest (Wave 1 — tracks A,B1,B2,C,D1,D2,E,F complete; G1/G2 pending)

## Verified dependency surfaces (Track E — zero gaps)
- DF1.1: Run.phase() phase.ts:176; PhaseBodyContext {signal, phaseId, params, ctx}; RunContext{runId,pipelineId,requestId,effectiveCeilingMicros?} types.ts:196-201 ("DF1.6's spawn seam is the first consumer" per docs); PhaseSpec.testCommand?: string[] EXISTS manifest.ts:62-87; PhaseRecord{...subTimings} types.ts:210-225; readArtifactBeneathRoot exported manifest.ts:204-268 (INV-1 resolver: realpathNoOpen -> assertBeneath -> O_NOFOLLOW open -> fd verify).
- PhaseKind enum TODAY: ["engineer","agent","code"] — dispatch_task NOT registered (GAP: decide enum extension vs agent-kind body; check pipeline-run.ts wiring).
- DF1.2: Envelope envelopes/types.ts:40-54 {kind,label,status,summary,outputTail?,artifacts?,changedFiles?,approved?,blocking?,findings?}; asEnvelope(result:QualityCheckResult,label) adapter.ts:45; QualityCheckResult{name,exitCode,outputTail,outputArtifact,spawnEnv}.
- DF1.5: loadRoster(path,opts)->ResolvedRoster schema.ts:73-79; validateRoster(roster,opts)->{verdict,report} validate.ts:952; ResolvedRole{name,model,provider,...,slug=`${provider}/${model}`} schema.ts:46-64; resolveRate validate.ts:471.
- DF2.2: setup-gate.ts:252-267 writes QDS_TEAM_RUNNER=local into box .env + content-verify; error names DF1.6.
- DF2.7: applyCostEvent(state,event) + budgetKillThresholdUsd(cap)=cap*0.9 exported runner.ts:490-502; harvestPiStream session-cumulative team-lead-driver.ts:270-280.
- P0.2/3: vendor pi-vs-claude-code-vendor @0ed11f4, peer-pin pi 0.55.0; PI_PINNED_VERSION_PREFIX="0.55." roster/validate.ts:583; coms-smoke-test.ts:228 asserts.
- DF2.5: teardown/harvest = fleet-level (DF3.1), dispatch_task does NOT call them.

## cli-anything surfaces (Track B1)
- Seam: runner.ts:598 `const runner = env.QDS_TEAM_RUNNER === "local" ? "local" : "warren"` -> buildTeamSpawn(manifest, runner); buildTeamSpawn team-events.ts:37-47: local => {file:"bun", argv:[join(import.meta.dir,"..","scripts","team-lead-driver.ts")]}.
- WATCHDOG_GRACE_MS=5000 runner.ts:77; killTree(child:ChildProcess|null) :85-94 (SIGKILL leg only); MAX_TEAM_STDOUT_BYTES=1MiB :511; BUDGET_KILL_FRACTION=0.9 :466; budget guard compare in runTeamManifest ~:785-805; QDS_AGENT_TEAM_CONFIG_JSON export :571-573 (workers map w/ lean+extensions — DF1.9 region); API key presence-only logging :592-595 (ANTHROPIC_API_KEY, OPENROUTER_API_KEY).
- NO RSS watchdog exists anywhere (grep confirmed) — AC7 net-new.
- parseTeamEventLine team-events.ts:100-167: 5 kinds; merged: result must be object non-null non-array else null (i.e. reject array/null/non-object). splitRoleModel :12-23 indexOf("/") FIRST slash, -1 guard.
- types.ts: TeamRoleSchema :33-65 (.strict(), model must contain "/", agentId safe-path, lean?/extensions? DF1.9); ExitStatus :94-99 5-value; ComsLogEntry :115-120; MergedOutput :167-177 (9 fields: result, changedFiles, partial, exitStatus, durationMs, waivers, agentOutputs, comsLog, error — per F6).
- merger.ts: BuildMergedOutputOptions :164-176; buildMergedOutput :187-224 with invariants (success=>error=null,partial=false; non-success=>error populated; lead_failure forces agentOutputs={}, changedFiles=[]; deep redact).
- redact.ts redactSecrets :62-79 marker `[redacted:KEY_NAME]`, SECRET_KEY_RE + MIN_REDACTABLE_VALUE_LEN.
- Tests: runner.test.ts 812L (mergeEnv/buildSpawn/classifyExit/INV-2/INV-3/budget-kill using prod applyCostEvent); merger.test.ts 262L; team-lead-driver.test.ts 420L (runDriver fixture, argv assertions :268).
- smoke:team = QDS_TEAM_RUNNER=local bun cli-anything/src/index.ts run --manifest cli-anything/manifests/research-trio.yaml.

## Phase-engine facts (Track B2)
- NO src/phase-engine/phases/ dir yet — DF1.6 creates it.
- Barrel exports (index.ts): manifest{ManifestError,PhaseAgentSchema,PhaseSpecSchema,PipelineManifestSchema,loadManifest,readArtifactBeneathRoot,requiredBudgetMs,LoadedManifest}; journal{FileJournal,JournalWriteError,JournalFile,PhaseJournal}; phase{PhaseConstructionError,PhaseOverflowError,Run,RunHaltedError,RunTerminatedError,assertLegibleDescription,walkPhases,FinishResult,PhaseBody,PhaseBodyContext,PhaseBodyFactory,PhaseOutcome,RunOptions}; types; envelopes{OUTPUT_TAIL_CHARS,asEnvelope,truncateTail,Envelope,EnvelopeKind,QualityCheckResult,ReviewFinding}; gates{...commandGate...}; trace{Tracer,...,openTraceReader,TracingJournal}.
- Default-fail promotion: phase row written fail BEFORE body; success only on clean-exit.
- Tracer.trace({requestId,phaseId?,parentId?,type(open string),name,payloadJson?,tokens?,startedAt?,endedAt?}) tracer.ts:497-523; JSONL append+fsync then SQLite; errors via emitTraceError never throw. 'prompt' event type = caller-supplied open enum.
- Tests pattern: tmpRoot mkdtemp + afterAll, QDS_RUN_ROOT env beforeEach/afterEach, spec(over) factory, barrel imports; tests/phase-engine/fixtures/ exists (pipeline.qds-factory.json, review-envelopes.json); journal-test-util.ts readJournal helper.

## Spec bindings (Tracks D1/D2/C/F)
- Design §5.2 (335-352): parseTeamEventLine is the whole runtime contract; step output CC-1; two-stage decode-then-check; RSS watchdog "now correct — genuine local subprocess tree"; requestId e2e; per-phase sub-timings; prompts persisted pre-execution; cost split.
- D5 (302) pi teams via team-lead-driver behind QDS_TEAM_RUNNER seam; D6 (303) SSSF port TS test-first; D9 (306) warren demoted-optional.
- §6.6 DOES NOT EXIST (story citation stale); §8 step 1 = TS phase engine port (441-442).
- p1-6 doc: _bmad-output/sprint-artifacts/phase-1/stories/p1-6-pi-team-protocol-step.md — :32 field list; :62 testsExecuted semantics (MUST present+false when sum===0; MAY omit/true when sum>0); :65 summary<=2000 INCLUDING suffix — truncate prose to 2000-len(suffix) then append; :78-83 precedence (signal-origin > envelope-missing > exit-code; coms_init_error transient no partial; watchdog->overflow; userCancel/requestedShutdown->logic; unknown->transient; normal-exit-no-envelope->lead_failure incl exit 0); :87 hindsight unreachable => mulchPrimed:false + proceed, not a failure.
- INV-1/2 (110-113): ONE pinned workspace root for validation AND reads; two-stage decode-then-check (pre-decode reject %2e%2e/%2E%2E/%252e/percent-encoded-percent; post-decode URL-decode+NFC+reject literal .., abs paths, symlinks, unicode traversals); lstat best-effort; all harness reads via beneath-root walk; O_NOFOLLOW alone INSUFFICIENT (last component only).
- DD-8: NET-NEW items authored fresh cited to design §5.2 (counters, prompt persistence).
- Adversarial review: ALL DF1.6 findings resolved (DF1-P1-08 O_NOFOLLOW-walk amendment; DF1-P1-12 roster adapter ownership; DF1-P1-13 top-level siblings; DF1-P1-15 8pts; DF1-P1-17 citation; DF1-P2-15 types.ts region split; DF2-P2-13 budgetCapUsd raise owner=DF1.6 spawn seam).
- F6 proof: 12 events = 6 coms, 3 cost, 2 worker_output, 1 merged; 0 malformed; costSumUsd 0.04912262; merged result{summary,workerSummaries,respondedWorkers,models}; MergedOutput 9 fields as above.
- DF1.3 gotcha: story's runner.ts:707 budget-compare line ref stale — actual ~:803.
- DF1.9 worker mapping actual lines :572-581 (story said :533-544 — drifted).

## Downstream freeze list (Track F)
- DF5.1 reads exitStatus/changedFiles/testResults from harvested merged step output.
- DF1.8 needs requestId on every trace row + prompt events pre-spawn + counters on phase record.
- DF4.2 sub-timing names: mulch_prime_ms, box_setup_ms, team_execution_ms, gate_validation_ms.
- result stays byte-identical; result.summary COPIED up to top-level summary (2000 cap).
- testsExecuted reject rule: sum===0 AND (absent|true) => consumers reject.
- parseTeamEventLine has 18 test assertions across 2 files — do not change signature.
- Consumers of runTeamManifest: index.ts:242 sole production call.

## Library facts (Track A — Context7)
- Bun.spawn: env spread {...process.env,...}; stdout:"pipe" ReadableStream; proc.exited Promise<number>; proc.exitCode/signalCode(string|null)/killed.
- Group signal: Bun Subprocess.kill() only positive pid; use process.kill(-pgid,sig) (POSIX; needs group leader — detached spawn or setsid). Existing killTree precedent in runner.ts to follow.
- Tree RSS: no Bun live API; resourceUsage() post-exit self-only; use `ps -o rss= -g <pgid>` (macOS) / /proc/<pid> walk (Linux); platform-unsupported => log + 'unwatchable' (AC7).
- zod: .strict() orthogonal to .optional(); mulchPrimeError => z.string().optional().
