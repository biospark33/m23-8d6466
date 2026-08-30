# DF3.3 Research Track B — Codebase Implementation Map (R2)

All paths relative to `/Users/steve/QDS-Factory`. Line numbers verified 2026-08-27 against `main` @ f9e828d.

---

## 1. `src/phase-engine/` — inventory

### 1.1 Barrel exports (`src/phase-engine/index.ts`)

- **manifest** (`:9-18`): `ManifestError`, `PhaseAgentSchema`, `PhaseSpecSchema`, `PipelineManifestSchema`, `loadManifest`, `readArtifactBeneathRoot`, `requiredBudgetMs`, `type LoadedManifest`. Deliberately ABSENT: `loadManifestWithSeams` (`:7-8` — seams weaken INV-1; suite imports `manifest.ts` directly).
- **journal** (`:25-30`): `FileJournal`, `JournalWriteError`, `type JournalFile`, `type PhaseJournal`. Deliberately ABSENT: `runMarkerPath`, `runMarkerRoot`, `writeTerminalMarker` (`:19-24`) — `phase.ts` imports them from `./journal.ts` directly.
- **phase** (`:31-45`): `Run`, `walkPhases`, `PhaseConstructionError`, `PhaseOverflowError`, `RunHaltedError`, `RunTerminatedError`, `assertLegibleDescription`, types `FinishResult`, `PhaseBody`, `PhaseBodyContext`, `PhaseBodyFactory`, `PhaseOutcome`, `RunOptions`.
- `export * from "./types.ts"` (`:46`).
- **gates DF1.2** (`:59-73`): `GateFailureError`, `artifactsExist`, `diffMatchesClaims`, `filesNonEmpty`, `gatedBody`, `jsonParses`, `looksLikeEnvelope`, `verdictConsistent`, `Gate`, `GateContext`, `GatedBodyOptions`, `GateReport`, `GateCheck`, `commandGate`, `GATE_NOTE_TAIL_CHARS`.
- **envelopes** (`:48-58`): `OUTPUT_TAIL_CHARS`, `asEnvelope`, `truncateTail`, `Envelope`, `EnvelopeKind`, `QualityCheckResult`, `ReviewFinding`.
- **trace DF1.4** (`:74-87`): `Tracer`, `TracerError`, `serializeTraceError`, `TracerOptions`, `openTraceReader`, `MAX_LIMIT`, `DEFAULT_LIMIT`, `TraceReader`, `TracingJournal`.
- **dispatch_task DF1.6** (`:88-93`): `dispatchTask`, `DispatchTaskDeps`, `DispatchTaskValue`.

Module boundary (story R3 §9.2): fleet imports the engine barrel; engine never imports fleet. There is **no `steering.ts`** today — DF3.3 authors it.

### 1.2 Engine lifecycle (where a run starts / loops / finishes)

Entry is `scripts/pipeline-run.ts` (the only production driver):

1. `loadManifest(manifestPath, budgetMs, runRoot)` — `pipeline-run.ts:703`. Read-once + `deepFreeze` (`manifest.ts:597-603`; "read once and frozen" contract `manifest.ts:608-615`). Nothing is constructed, spawned or journalled unless this returns.
2. `new Run({ ctx, journal, manifestLoadMs })` — `pipeline-run.ts:932` (`Run` ctor `phase.ts:153-159`; default log = one JSON line to stderr `phase.ts:157-158`).
3. `walkPhases(run, manifest.phases, makeBodyFactory(...))` — `pipeline-run.ts:971-980`. The loop (`phase.ts:454-467`): for each spec in declaration order, `if (run.isHalted) break` (`:461`), `run.phase(spec, makeBody(spec, index))`, `outcomes.push`, `if (outcome.status !== "success") break` (`:464`) — **first non-success halts; later phases are never constructed** (AC6 absence).
4. `Run.phase` (`phase.ts:177-413`): construction validation (`:200-222`) → `journal.writePhase(record)` **default-fail** (`:227-241`; both record model `:235` and `FileJournal.writePhase` `journal.ts:91-99` force `status:"fail"`) → body under `AbortController` + `maxDurationMs` timer (`:243-251`) raced against `CANCEL_GRACE_MS` grace (`:253-281`) → settled record re-written (`:323-375`) → **promotion is the only path to success** (`:376-381`: `promotePhase(phaseId,"success","success")` else `promotePhase(...,"fail",exitStatus)` + `this.halted = true`) → structured log line (`:388-402`) → `PhaseOutcome` return (`:404-412`).
5. `run.finish(!terminated)` — `pipeline-run.ts:1007`. `Run.finish` (`phase.ts:419-444`): `journal.finish(runId, accepted && terminating===undefined)` (`:427`), `writeTerminalMarker` (`:429`, journal.ts:171-194 — `$QDS_RUN_ROOT/journal/final.json`), banner + exitCode 0/1 (`:442-443`).

`Run.terminate(sig)` (`phase.ts:171-175`) converts SIGTERM/SIGINT to `RunTerminatedError` abort. `exitStatus` computation at `phase.ts:286-292` (success/overflow/transient/logic).

### 1.3 `PhaseJournal` port (methods the engine already calls)

`src/phase-engine/journal.ts:47-58`:

```ts
writePhase(record: PhaseRecord): void;            // upsert by phaseId, always persists "fail"
promotePhase(phaseId, status, exitStatus?): void; // the sole path to "success"
writeGateEvent(event: GateEvent): void;           // DF1.2-owned shape, append-only
finish(runId, accepted): RunOutcome;              // ok = rows>0 && all success && accepted
phases(): readonly PhaseRecord[];                 // declaration order
```

`FileJournal` flushes the whole `JournalFile` atomically per op (`journal.ts:129-163`: O_NOFOLLOW tmp write + fsync + rename). **`JournalFile` shape** (`journal.ts:68-75`): `{ version:"1.0.0", runId, ok, completedAt?, phases: PhaseRecord[], gateEvents: GateEvent[] }` — there is **no `resident` block today**; DF3.3 must add an optional field (or a new port method) and the byte-identity test strips `resident.*` + timing fields. `GateEvent` is open-keyed: `{ runId, phaseId, [k: string]: unknown }` (`types.ts:253-257`) — the natural carrier for `residentTripwire` rows in the JSON journal.

### 1.4 Manifest schema / freeze

- `PhaseSpecSchema` (`manifest.ts:62-106`, `.strict()`): `name`, `kind ∈ {engineer, agent, code, dispatch_task}`, `description`, `maxDurationMs` (default `DEFAULT_MAX_DURATION_MS`=600_000, ≤ `MAX_MAX_DURATION_MS`=900_000), `retries` (0..5 default 0), `command?` (required iff `code`), `testCommand?`, `roster?`/`task?` (required iff `dispatch_task`).
- `PipelineManifestSchema` carries `version:"1.0.0"`, `pipelineId`, `runBudgetMs`, `limitMicroUsd?` (DF3.1 stamp; optional engine-side — `types.ts:184-198`), `phases[]` (≥ `MIN_PHASES`=2).
- Credential walk INV-4 (`manifest.ts:175` — credential-shaped value refuses load). Admission arithmetic `requiredBudgetMs` (`manifest.ts:588-596`: `(retries+1)×(PARSE_FIX_ATTEMPTS+1)×maxDurationMs + phases×ROUTING_MARGIN_MS`).
- `stampManifestLimit(manifest, limitMicroUsd)` (`manifest.ts:753`), `stripAuthoredLimit` (~`:720-725`) — both drop `resolvedPath`.
- Freeze: `deepFreeze` at `manifest.ts:597-603`, applied inside `loadManifestWithSeams`.

### 1.5 DF1.2 gate verdict computation seam

- `Gate` interface (`gates/library.ts:33-37`): `{ name, run(envelope, ctx) → GateReport }`.
- `gatedBody(journal, gateCtx, gates, opts?)` (`gates/library.ts:230-299`): runs body → derives envelope (`:239-243`) → per gate: `gate.run` (throw = failed check, fail-closed `:250-259`) → `journal.writeGateEvent({type: gate_pass|gate_fail, attempt: opts?.attempt ?? 1, violations, checks, gate_exec_ms, gate_report_ms})` (`:267-279`) → verdict keyed on `report.passed` not violations (`:283-289`) → throws `GateFailureError` out of the body if any gate failed (`:291-296`), landing in DF1.1's default-fail branch.
- `commandGate(argv, opts)` (`gates/command-gate.ts:50`): wraps any argv as a gate (exit 0 required; `GATE_NOTE_TAIL_CHARS`=1000 tail as note).
- **Critical gap:** `pipeline-run.ts` does NOT compose gates on `code` phases today — explicit comment `pipeline-run.ts:553-560` ("No blanket gate here: DF1.2 AC4 — a command's exit code is data"). The only in-repo `commandGate` composition is `src/reverify/runner.ts:352`.

### 1.6 DF1.3 retry authorization seam

`src/phase-engine/agents/retry.ts` — `runAgentPhase(opts)` (`:119-303`):

- **Loop B (outer)** `for gateAttempt = 1..params.retries+1` (`:162`); **Loop A (inner)** parse-fix bounded by `PARSE_FIX_ATTEMPTS`=2 (`:164`, `types.ts:27`).
- Send seam: `AgentSender.send({prompt, sessionId, signal})` (`:68-70`) — DF1.6 supplies the pi-backed sender, tests a scripted one.
- Gate verdict computation per attempt (`:224-268`): each gate runs, `journal.writeGateEvent` per gate with attempt number (`:243-258`), failures collected keyed on `passed` (`:259-267`).
- **Attempt N+1 authorization is exactly the branch at `retry.ts:284-287`**: `if (gateAttempt <= params.retries) { prompt = gateCorrectionPrompt(failures); loop = "gate"; envelope = undefined; } else throw new GateFailureError(...)` (`:289-293`). This is the seam the story's solicitation point (2) must sit *after*.
- Usage metering precedent: `accumulator.add(res.usage, ...)` after every send (`:187`), `agent_end` event with phase-total `UsageBreakdown` (`:141-153`). `SendUsage.costMicros` is integer µ$ (`usage.ts:37-45`); `usdFromMicros` (`usage.ts:64-66`) is the ONLY µ$→USD site inside the engine.
- **Note:** this retry loop exists only for `agent` phases driven through `runAgentPhase`. `pipeline-run.ts` never calls `runAgentPhase`; `engineer`/`agent` kinds throw at `pipeline-run.ts:569-573` ("no executor is registered... DF1.6 lands the tier-3 spawn seam"). A `code` phase with `retries > 0` gets a single attempt from `Run.phase` (`phase.ts:245-247` comment: "this timer is armed for the one attempt this story runs. DF1.3's retry loop arms a fresh one per attempt").

---

## 2. `scripts/pipeline-run.ts` — CLI

### 2.1 Flags (DF1.8 shape, all present)

Parsed via `parseValueFlags` from `./lib/cli-args.ts` (`pipeline-run.ts:65, 648-697`):

- `--manifest <path>` (required), `--budget-ms <n>` (**required** positive int — `:699-700`; the story's flag list omits this but it is mandatory today), `--journal <path>` (required), `--run-root <path>` (default cwd), `--run-id <id>` (default fresh uuid), `--request-id <id>`, `--repo-slug <owner/name>` + `--issue <n>` (+ `--issue-url <url>`) — correlated mode (DF1.8), pair must arrive whole, `--run-id` conflicts (`:717-774`).
- Exit codes: 0 ok / 1 settled not-ok / 2 could-not-settle (`:22-24`).

### 2.2 Main flow (with line anchors)

`main(argv)` `pipeline-run.ts:634-1028`:

1. Flag parse (`:648-697`), required checks (`:699-701`).
2. `loadManifest` (`:703`) → `{manifest, manifestLoadMs, resolvedPath}`.
3. `markerRoot = process.env.QDS_RUN_ROOT ?? "/run"` (`:709`).
4. Correlated mode: `resolveRunCorrelation({repoSlug, issueId, issueUrl?, requestId})` (`:744-750`, from `src/phase-engine/issue-correlation.ts`); refusals → `dispatchFail` (`:495-532`) → exit 2.
5. Tracer: `mkdir 0700 $markerRoot/trace` + mode check (`:788-794`), `new Tracer({dataDir, requestId, pipelineName, onTraceError})` (`:803-824`), correlated `tracer.initiateSession` (`:832-836`); replay ack exits 0 (`:854-867`).
6. `new FileJournal(journalPath, runId)` (`:888`).
7. `runContextFrom(runId, requestId, manifest, {manifestPath: resolvedPath, runRoot})` (`:294-334`, called `:912`) — the **cap witness reconciliation**: reads `run-context.json` beside the manifest (`witnessPathBeside` `:345-346`), ±30 min freshness (`:400-422`), declared-limit must match witness, witness-alone supplies ceiling, refusal throws.
8. `new TracingJournal(innerJournal, tracer, ctx)` (`:930`); `new Run({ctx, journal, manifestLoadMs})` (`:932`).
9. Bare mode: `tracer.startSession` (`:941`). Signal handlers (`:947-969`).
10. `walkPhases(run, manifest.phases, makeBodyFactory(runRoot, tracer, requestId, correlation?))` (`:971-980`).
11. Per envelope outcome: `tracer.recordEnvelope` (`:987-1005`).
12. `run.finish(!terminated)` (`:1007`) → `tracer.close()` (`:1014`) → banner to fd 1 (`:1023`) → exit code.

`makeBodyFactory(cwd, tracer, requestId, correlation?)` (`:534-632`): `code` → `runCommand` (detached process group, scrubbed `childEnv()` `:89-96`, stdout tail `STDOUT_TAIL_CHARS`=4096 riding the value `:110-137`, `tracer.recordProcess`/`endProcess`); `dispatch_task` → `dispatchTask(spec, {tracer, requestId, rootDir: cwd})` (`:566-568`); everything else throws (`:569-573`). Correlated wrapper emits `phase_state` trace events (`type:"log"`) around each body (`:581-631`).

What it writes to the journal file: `FileJournal` writes the `JournalFile` JSON (header at construction `journal.ts:87-89`, full rewrite per op). `out.json` IS the `JournalFile`.

---

## 3. `src/fleet/`

### 3.1 `brief-schema.ts` (DF3.1) — exact exported shape

`BriefSchema = z.strictObject({...})` (`brief-schema.ts:289-427`) — fields:

| field | constraints | line |
|---|---|---|
| `repoSlug` | `REPO_SLUG_PATTERN` (imported from issue-correlation) + no `.`/`..` segments | `:296-299` |
| `issueId` | int > 0, ≤ `MAX_ISSUE_ID` | `:305` |
| `issueUrl?` | ≤2048, no control chars, `.url()`, https-only, well-formed, no userinfo | `:329-337` |
| `commitSha` | `/^[0-9a-f]{40}$/` | `:339` |
| `requestId?` | **LOOSE** string, min 1, ≤128 (`MAX_REQUEST_ID`), no control chars, not blank — UUID validated in dispatch, not schema | `:350-357` |
| `manifestPath` | repo-relative, ≤1024, no `..`, not absolute | `:360-368` |
| `repoUrl` | https-only `.url()`, no userinfo, ≤2048 | `:374-381` |
| refine | `repoSlugOfUrl(repoUrl) === canonicalRepoSlug(repoSlug)` | `:424-427` |

Exports: `Brief` type (`:429`), `extractZodErrorField` (`:454`), `sanitizeLabel` (`:173`), `MAX_URL` (`:262`), `MAX_REQUEST_ID` (`:264`), `ROOT_FIELD_LABEL` (`:452`). **The brief carries NO credential material and no roster/resident fields.**

### 3.2 Barrel (`src/fleet/index.ts`)

`export *` from: `brief-schema.ts`, `dispatch.ts`, `status.ts`, `verbs.ts`, `fanout.ts`, `fanout-primitive.ts`, `rank.ts` (`:8-16`). `fleet-lock.ts` deliberately OFF the barrel (`:5-6`). **`resident.ts` DOES NOT EXIST** (confirmed: `ls src/fleet/` shows brief-schema, dispatch, fanout-primitive, fanout, fleet-lock, index, rank, status, verbs only). DF3.3 creates it and adds one barrel line.

### 3.3 How dispatch passes the brief into a run

`dispatch(brief, deps, opts)` (`src/fleet/dispatch.ts:804`):

1. `BriefSchema.safeParse` (`:1345`) → invalid-brief exit 2 naming field.
2. Correlation: `resolveRunCorrelation(briefIn)` (`:1457`) settles the requestId (strict UUID v4 honoured else minted; `resolveBriefRequestId` `:436-448`).
3. Manifest load + `stampManifestLimit(loaded, mintedCeilingMicros)` (`:2477`; ceiling = `min(admitted, provider-minted)` `:2434-2437`).
4. **Fill writes two files into the box** (`:2482-2507`): `pipeline.yaml` (serialized stamped manifest) and **`run-context.json`** = `{ runId, pipelineId, requestId, effectiveCeilingMicros, repoSlug, issueId, issueUrl? (linkSafe) }`. This is the brief's data reaching the engine side — and it is exactly the file `pipeline-run.ts` already reads as its cap witness (`pipeline-run.ts:345-346`, dirname of the resolved manifest path). The natural brief-side source for the resident spawn.
5. Setup gate → expose → ack "provisioned" (step 11, `:2935`). **Dispatch never invokes `pipeline-run.ts`** (grep over src/ + cli-anything/src: zero call sites) — the box-side engine start is not wired by any merged story.

CLI intake: `scripts/fleet.ts` reads the brief from stdin or `--brief <path>`, 64 KiB cap (`:138-141`), `BriefSchema` import (`:98`).

---

## 4. Telemetry / journal rows today + DF3.3 hook points

### 4.1 Row-writing patterns

- **JSON journal (`--journal out.json`)**: `gateEvents[]` rows via `writeGateEvent` (open-keyed `GateEvent`, `types.ts:253-257`). This is the only append-only row channel in the journal file.
- **SQLite trace (DF1.4)**: `Tracer` (`trace/tracer.ts`, 1060 lines): `trace({type, name, requestId, phaseId?, payloadJson?, ...})` dual-writes JSONL + `events` table; `upsertPhase`; `recordGateResult` (`:619`); `recordEnvelope` (`:662`); `recordProcess`/`endProcess` (`:706`); `startSession` (`:794`); `finishSession` (`:830`); `initiateSession` (`:974`, throws `RequestIdRepoMismatchError`). `TracingJournal` (`trace/journal-bridge.ts:56-243`) forwards every port op; tracer errors never break the run (AC5, `onTraceError` `:33-53`).
- **`TraceEventType` is a closed union** (`types.ts:325-336`: phase_start, agent_start, prompt, tool_call, handoff, gate_pass, gate_fail, log, agent_end, phase_end, error). DF1.4 owns it. Precedent for extra telemetry without touching the union: `pipeline-run.ts:592` emits `phase_state` with `type:"log"` and a name. **Recommendation: `residentTripwire` rows ride `tracer.trace({type:"log", name:"residentTripwire", payloadJson:{runId, requestId, cause, phase, detail}})`** — a new event type would edit DF1.4's region.
- **No `residentTripwire`-like row exists anywhere yet** (grep: `resident` appears only in cost-ledger `CostRole` `'resident'` `src/providers/cost-ledger.ts:646,1959`, `credentials.ts:44` `defaultKeyCapMicroUsd` doc re DF3.6, and roster/validate.ts docstrings naming DF3.3).
- **Spend metering precedent**: `UsageAccumulator`/`SendUsage` integer µ$ (`usage.ts`); pi-side usage harvested by `harvestPiStream`/`readTurnUsage` (`team-lead-driver.ts:234-260`).

### 4.2 Natural solicitation hook points (exact functions + lines)

| Solicitation point | Where it hooks |
|---|---|
| (1) run start, after manifest validated + frozen | `pipeline-run.ts:932` (`new Run`) — after `loadManifest` `:703` and `runContextFrom` `:912`, before `walkPhases` `:971` |
| (2) post-gate-failure, after verdict + after DF1.3 authorization | agent path: `agents/retry.ts:284-287` (inside the `gateAttempt <= params.retries` branch, i.e. only when attempt N+1 was authorized); gatedBody path: `gates/library.ts:291` (`GateFailureError` throw) — no retry loop exists on that path today |
| (3) run end, after `finish(accepted)` | `pipeline-run.ts:1007` (`run.finish(!terminated)`) — between it and `tracer.close()` `:1014` |

The engine-side port goes in the new `src/phase-engine/steering.ts` (DF3.3 authors; DF3.4/DF3.6 rebase additively).

---

## 5. Spawn pattern (`team-lead-driver.ts`), usage extraction, roster/rates

### 5.1 The pi spawn pattern

File is **`cli-anything/scripts/team-lead-driver.ts`** (824 lines) — NOT `src/fleet/team-lead-driver.ts` as the story's prose implies. `src/phase-engine/phases/dispatch-task.ts:4` cites it; `scripts/lean-worker-benchmark.ts:36` imports from it.

- `runWorkerPi(w, timeoutMs)` (`:541-660`): `spawn("pi", buildWorkerArgv(spawnConfig), { stdio: ["ignore","pipe","pipe"], env: process.env })` (`:589-592`); `setTimeout` → SIGKILL (`:606-608`); `StringDecoder` per-stream chunk-safe accumulation (`:595-605`); `child.on("error")` resolves partial (degrade, never lead death, `:612-623`); on close: `harvestPiStream(stdout)` parses the `--mode json` NDJSON for assistant text + usage (`:646-649`).
- `buildWorkerArgv(w)` (`:378-396`): `["--provider", w.provider, "--model", w.model, "--mode", "json", "--no-session", (lean: "--no-extensions","--no-skills","-e" ext...), "-p", `${w.prompt}\n\n${SCHEMA_INSTRUCTION}`]`.
- Usage/cost extraction from replies: `PiUsageTotals` (`:178-189`: costUsd, input/output/cacheRead/cacheWrite tokens, turnCount, unpricedTurns); `readTurnUsage` (`:234-260`) reads pi's per-turn usage block `{input, output, cacheRead, cacheWrite, totalTokens, cost:{input,output,cacheRead,cacheWrite,total}}` — camelCase, **per-turn deltas** (session totals derived by summation); `finiteNonNegative` rejects negatives (`:218-220`); one `cost` event per invocation, complete for its own invocation (reset boundary, `:168-176` — DF2.7 final-turn overwrite note).

### 5.2 Model / roster resolution (DF1.5)

- `loadRoster(rosterPath, opts)` — `src/phase-engine/roster/schema.ts:332` → `ResolvedRoster { path, roles: ResolvedRole[], warnings }` (`:66-71`). `ResolvedRole` (`:48-64`): `name`, `model` (verbatim, may contain `/`), `provider` (**authoritative**; only when absent is `model` split on first `/` — `resolveRoleModel` `:181-184`), `thinking`, `tools`, `writes`, `harness_engineering`, **`slug` = `${provider}/${model}`** (the lookup key).
- `validateRoster(roster, deps)` (`roster/validate.ts`) — dual gate (pi catalog probe + provider API).
- **Rates**: `ResolvedRate` (`validate.ts:70-79`): `inputPerMTok`, `outputPerMTok`, `cacheReadPerMTok`, `cacheWritePerMTok` (integer µ$ per MTok) + `source` + `warnings`. **`resolveRate(slug, sources?)` IS EXPORTED at `validate.ts:471`** — loads `~/.pi/agent/models.json` (precedence, wholesale) over pi's bundled catalog; rejects zero-priced overrides (`:493-519`); `loadRateSources()` memoized (`:435-446`); `resetRateSources()` (`:453-455`) whose docstring explicitly says it exists "for DF3.3's long-lived resident". `validate.ts:65` and `:430` name DF3.3's resident accounting as a consumer. ⚠️ **The story's 2026-08-20 hardening revision claims `resolveRate(slug)` was an "unverifiable export claim" — the code contradicts the revision: the export exists and its docstrings cite DF3.3. Use it; do not re-derive rates from models.json.**
- `defaultKeyCapMicroUsd = 50_000_000` (`src/providers/credentials.ts:44`) — DF3.6 bound context. Cost ledger `CostRole` already includes `'resident'` (`cost-ledger.ts:646`).
- dispatch_task's spawn wiring (`phases/dispatch-task.ts:110-490`): `QDS_TEAM_RUNNER` must equal `"local"` (`:133-139`), provider key presence (`:143-148`), `loadRoster` + `validateRoster` dual gate (`:171-191`), `rosterToTeamManifest` (`:206-214`), prompt events PRE-SPAWN via `tracer.trace({type:"prompt"})` (`:222-235`), manifest file under `<runRoot>/.qds-manifests/manifest-<runId>-<phaseId>-<hex>.json` mode 0600 (`:243-273`), `_runTeamManifest(manifestFile, {forceLocalRunner: true, effectiveCeilingMicros, abortSignal, onTeamEvent, onRunFacts})` (`:274-336`), engine-side `testCommand` (`:364-387`), test-injection seam `_injectRunner`/`_resetRunner` (`:67-74`).

### 5.3 ExitStatus source (CC-1)

`cli-anything/src/types.ts:94-108`: `EXIT_STATUSES` const array → `export type ExitStatus = (typeof EXIT_STATUSES)[number]` (`:108`). Re-exported through `src/phase-engine/types.ts:14,17` — import from the engine barrel/types, never re-declare.

---

## 6. Test conventions

- **Runner**: `bun:test` (`afterAll/describe/expect/test`); tmp workspace `fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "<story>-")))` + `afterAll` recursive rm (`tests/phase-engine/pipeline-run.test.ts:22-23`, `tests/phase-engine/retry.test.ts:29`).
- **Journal reads** through the shared helper `readJournal(p)` → `JournalFile` (`tests/phase-engine/journal-test-util.ts:10-12`).
- **pipeline-run.ts is exercised by real subprocess spawn** (`pipeline-run.test.ts:36-47`): `Bun.spawn({cmd: [process.execPath, RUNNER, ...args], cwd: REPO_ROOT, env: {...process.env, QDS_RUN_ROOT: markerRoot}, stdout/stderr: "pipe"})` — `process.execPath` not `"bun"` so sibling PATH rewrites can't bite (`:38-41`). Assertions on exit code + `out.json` + `<markerRoot>/journal/final.json`. `runContextFrom` is imported directly for unit tests (`:16`) because the cap field appears in no row or marker.
- **DI seams in production code**: `AgentSender` scripted sender injected into `runAgentPhase` (`retry.test.ts:19-60` — `usageAt(send)` synthetic per-send usage); gates as plain objects; `DispatchTaskDeps {tracer?, requestId?, rosterValidateDeps?, rootDir?}`; module-level `_injectRunner`/`_resetRunner` (dispatch-task.ts:67-74). This is the house pattern for DF3.3's fake-resident fixture (`tests/phase-engine/fixtures/fake-resident.ts` — does not exist yet; fixtures dir currently holds `pipeline.qds-factory.json`, `dispatch-roster.yaml`, `dispatch-task-ndjson.jsonl`, `review-envelopes.json`, `test-command-output.ts`).
- **Fixture manifest shape** (`fixtures/pipeline.qds-factory.json`): `{version:"1.0.0", pipelineId, runBudgetMs, phases:[{name, kind, description, maxDurationMs, retries, command}]}`. `pipeline.resident.json` does not exist yet.
- **tests/fleet/**: `helpers.ts` `RecordingLedger` pattern — fakes that RECORD calls (`admitCalls`, `closeCalls`) so money-path arguments are assertable; `tests/fleet/e2e/` subdir exists for subprocess-level tests.
- **trace tests**: `tests/phase-engine/trace/{tracer,reader,migrations,wiring}.test.ts`.
- Budget check: `--budget-ms` must be ≥ `requiredBudgetMs(phases)` or load refuses (asserted `pipeline-run.test.ts:91-111`, message "3610000 ms of phase budget").

---

## 7. Implementation-relevant gaps (facts, not decisions)

1. **`src/fleet/resident.ts`, `src/phase-engine/steering.ts`, both DF3.3 test files, and the fixture are all absent** — everything in Files to Modify that exists today is: `src/fleet/index.ts`, `src/phase-engine/index.ts`, `scripts/pipeline-run.ts`.
2. **No gate/retry wiring on `code` phases in pipeline-run** — the E2E's "build phase whose test command fails once → gate fails → DF1.3 authorizes attempt 2" needs new wiring: today `retries > 0` on a `code` phase is inert (`Run.phase` runs exactly one attempt, `phase.ts:245-247`), and DF1.3's authorization branch exists only inside `runAgentPhase` (agent phases), which pipeline-run never invokes. `gatedBody` + `commandGate` are available and composable at `makeBodyFactory`.
3. **`resolveRate` exists and self-identifies as DF3.3's rate source** — the story's hardening note saying otherwise is stale; consume `resolveRate(slug)` / `ResolvedRate.inputPerMTok`/`outputPerMTok` from `roster/validate.ts:471/:70`.
4. **`run-context.json` is the in-box brief carrier** — already written by dispatch (`dispatch.ts:2484-2507`) and already read by pipeline-run (`:345-346` witness); requestId/repoSlug/issueId/issueUrl are all there for the resident spawn and telemetry propagation.
5. **`JournalFile` has no resident block and `TraceEventType` is closed** — add an optional `resident?` field to `JournalFile` (or route through a port method) and use `type:"log"` + `name:"residentTripwire"` for tripwire rows to avoid editing DF1.4's union.
6. **DF3.3 adds `--no-resident` to pipeline-run** (AC1a control leg); the resident-on path needs a trigger (brief presence via `run-context.json`-adjacent data or a flag) — flags today are exactly `--manifest --budget-ms --journal --run-root --run-id --request-id --repo-slug --issue --issue-url`.
