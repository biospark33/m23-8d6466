# Edge Case Hunter — pr135 test chunks (resident-e2e, misc-tests)

Chunks reviewed in full:
- `chunk-resident-e2e.diff` (tests/phase-engine/resident-e2e.test.ts, 700 new lines)
- `chunk-misc-tests.diff` (pipeline-run.test.ts, dispatch-task.test.ts, usage.test.ts, fixtures/*)

Cross-checked against: `scripts/pipeline-run.ts` (full 1678 lines), `src/phase-engine/steering.ts`, `src/fleet/resident.ts`, `src/phase-engine/journal.ts`, `src/phase-engine/usage.ts`, `src/phase-engine/roster/validate.ts` (resolveRate / toMicrosPerMTok / readCustomRegistry / loadRateSources), `src/phase-engine/manifest.ts`, `src/phase-engine/gates/{command-gate,library,report}.ts`, `src/phase-engine/trace/tracer.ts`, `src/phase-engine/trace/journal-bridge.ts`, `src/providers/run-record.ts`, `cli-anything/scripts/team-lead-driver.ts` (harvestPiStream), `tests/phase-engine/{usage.test.ts, journal-test-util.ts, pipeline-run.test.ts}`.

## Findings

### [MEDIUM] Vacuous redaction assertion — the probe never enters any artifact, so the "redaction actually asserted" claim is unverified
- Test: `tests/phase-engine/resident-e2e.test.ts` demo leg (chunk-resident-e2e.diff:329, 394-398) — `OPENROUTER_API_KEY: REDACTION_PROBE` on the child env, then `expect(...).not.toContain(REDACTION_PROBE)` over the 6 `*-solicit-*` artifacts.
- Real source: `scripts/pipeline-run.ts:679-702` (`residentContextLines`) builds prompts from run facts + brief fields only; the reply artifact is `harvestPiStream` text (the fake's scripted string). No env value ever flows into a prompt or reply.
- Trigger: delete `bindRedact`/`redactSecrets` from `src/fleet/resident.ts:147-157,166-169` so artifacts persist unredacted — this test still passes, because there was never anything to redact. The assertion can only fail if a secret leaks into artifact content by some *other* route; it exercises the redaction chokepoint not at all. As written it is a presence/absence check, not a redaction check. (A non-vacuous version needs the probe on a code path that reaches an artifact pre-redaction — e.g. a reply that echoes the env — which the current fixture never does.)

### [MEDIUM] No e2e coverage of the steering `abort` directive wiring (both abort sites)
- Real source: `scripts/pipeline-run.ts:1507-1520` (run_start abort → `residentAborted = true`, zero phases walked, `finish` settles an empty run not-ok, run_end solicitation skipped) and `scripts/pipeline-run.ts:865-889` (post-gate abort → `resident_directive` trace row carrying `reason`, rethrow of the caught GateFailureError settling the phase fail).
- Both chunk files script the fake resident with only `proceed` / `retry` / out-of-set `select_roster`; no leg replies `{"action":"abort"}`. The schema member exists (`src/phase-engine/steering.ts:51`) and parsing is presumably unit-tested in C1, but the runner-side wiring — `residentAborted` gating `walkPhases`, the empty-run `finish(!terminated)` verdict, the abort trace row, the skipped run_end — is exercised by no test anywhere in this PR's test surface.
- Trigger: a regression that runs `walkPhases` despite a run_start abort, or that solicits run_end after an abort (leaking a post-abort prompt to the model), or that drops the abort trace row, passes both suites green.

### [LOW] usage.test.ts steering exemption is narrow, but the compensating pin is a bare occurrence count
- Test: `tests/phase-engine/usage.test.ts:181-182` — `(codeOnly(steering).match(/\/\s*1_000_000/g) ?? []).length).toBe(2)`.
- Verified narrow: the walk excludes only `usage.ts` and `steering.ts` (`usage.test.ts:188-195`); the separate float-dollar walk (`usage.test.ts:144-163`) does NOT exempt steering.ts, so the exemption cannot swallow other files' violations or other unit sins inside steering.ts. Current source has exactly the two meter divisions (`src/phase-engine/steering.ts:228-229`), so the pin holds today.
- Residual hole: the pin is position- and semantics-blind. A change that removes one meter term (e.g. stops metering output tokens) while adding an unrelated `/ 1_000_000` elsewhere in steering.ts keeps the count at 2 and passes unexamined — exactly the "smuggled conversion" the comment says the pin exists to catch.

### [LOW] Accepted `select_roster` path untested; the application is recorded-only (source-vs-spec drift)
- Real source: `scripts/pipeline-run.ts:1517-1519` sets `rosterChoice.pending`; `:928-948` consumes it into a `residentRosterChoice` trace row only, with an explicit DRIFT comment that `dispatchTask` exposes no roster override (`src/phase-engine/phases/dispatch-task.ts`), so the pick changes no spawn behavior.
- The chunk's roster test covers only the out-of-set rejection (verified grounded: `steering.ts:298-303` rejects with an empty `rosterIds` when the manifest has no dispatch_task phases; tripwire `gate_bypass_attempt` + detail naming the id). The fixture manifest `tests/phase-engine/fixtures/pipeline.resident.json` has no dispatch_task phase, so an in-set acceptance is unreachable in this suite — `rosterChoice.pending` consumption/clearing is uncovered.
- Trigger: a regression that drops the `residentRosterChoice` trace row or fails to clear `pending` (double-apply to a later dispatch_task phase) passes green.

### [LOW] SIGINT e2e has a wall-clock flake surface (15 s prompt-exit bound)
- Test: `tests/phase-engine/resident-e2e.test.ts` run-end-signal leg (chunk-resident-e2e.diff:640-648) — `expect(Date.now() - sent).toBeLessThan(15_000)`.
- The mechanism is correctly grounded (`scripts/pipeline-run.ts:1366-1379` runSettled branch → `residentSpawn.stop()` → `resident.ts:277-281` signal death → `transient`; steering catch → degraded PROCEED; cleanup refreshes the resident block and exits with finish's code). But between SIGINT and exit the process does: SIGKILL + await exit, a journal flush (write+fsync+rename, `journal.ts:145-180`), SQLite checkpoint/close, banner write. 15 s is generous, yet it is still a timing assertion that can flake on a saturated/shared CI host — and when it does, the failure reads as a functional regression ("first signal didn't stop the resident") rather than host slowness. The 30 s readiness poll above it is fine (poll-until-3-markers, no hardcoded single sleep).

### [LOW] fake-resident.ts continues after a missing `-p` instead of exiting
- `tests/phase-engine/fixtures/fake-resident.ts:64-67` (chunk-misc-tests.diff): on missing `-p` it sets `process.exitCode = 2` but falls through — appends a session marker (consuming an invocation slot), prints the scripted reply NDJSON, then exits 2. Real pi's argv error path does not emit a billable assistant message or advance session state. Never triggered by any test in these chunks (`src/fleet/resident.ts:226-240` always passes `-p <prompt>`), but if a future test drives the no-`-p` path, the fixture over-reports (marker consumed + reply printed) versus the real binary.

## Verified-grounded items explicitly checked and cleared (no findings)

- `spendMicros: 276` pin is correct, not a pinned bug: catalog `0.08/0.18` USD/MTok → `toMicrosPerMTok` ×1e6 (`validate.ts:214-224`) → 80_000/180_000 µ$/MTok; steering meter rounds per term (`steering.ts:225-230`): `round(1000·80000/1e6)=80` + `round(64·180000/1e6)=12` = 92/call × 3 calls = 276.
- `fake-resident.ts` NDJSON is not a double-count: `harvestPiStream` accumulates usage on `message_end` ONLY (`team-lead-driver.ts:260-270`), so usage on both message_start and message_end matches real pi.
- Fixture catalog shape matches `loadBundledCatalog`'s two-level read (provider=filename → api-type → id → cost), resolving key `openrouter/deepseek/deepseek-v4-flash-0731` = `DEFAULT_RESIDENT_SLUG`'s rateKey (`resident.ts:192-203`). `pipeline.resident.json` fields match `manifest.ts` schema (version/pipelineId/runBudgetMs/retries/maxDurationMs/command/testCommand).
- Zero-ceiling refusal: journal header-only residue is real — `FileJournal` constructor flushes before `runContextFrom` throws (`pipeline-run.ts:1269` vs `:1293`); refusal string matches `admittedCeilingBeside` (`pipeline-run.ts:530-532`); staleness check passes because the witness is written moments before spawn.
- Degraded leg: exit-3 maps to `exitStatus: "logic"` (`resident.ts:283-288`), steering degrades with 0 metered spend (throw before `meter`), 3 solicit lines still emit via the never-throws wrapper (`pipeline-run.ts:705-747`).
- Roster-rejection leg: telemetry partition (2 accepted + 1 rejected = 3 solicitations) and `accepted` flag semantics match `solicitResident`'s count-moved definition (`pipeline-run.ts:712,738`).
- `QDS_PI_MODELS_JSON` ENOENT seam is the sanctioned empty registry (`validate.ts:356-360`), and C5's rate failure is host-independent: `loadRateSources` eagerly loads the bundled catalog (`validate.ts:443`), so the bogus `QDS_PI_CATALOG_DIR` throws `RateError` regardless of host `~/.pi/agent/models.json` state.
- AC1a strip regex covers every nondeterministic journal field present today: gate events carry only `gate_exec_ms`/`gate_report_ms` timing keys (`gates/library.ts:267-279`), PhaseRecord timing fields are `startedAt/updatedAt/durationMs/subTimings`, all matched by `TIMING_KEY_RE`; commandGate notes ("exit 0" / `exit 1: <tail>`) are deterministic for this fixture.
- Demo trace-mirror assertions match tracer reality: events.jsonl rows carry snake_case `payload_json` (`tracer.ts:522-533`), directive rows ride `type:"log"` + `name:"resident_directive"` (`pipeline-run.ts:898-914`) with payload `{action, guidance, attempt: attempt+1, phase}`.
- Artifact mode check `mode & 0o077 === 0` matches `persistArtifact`'s `writeFileSync(..., { mode: 0o600 })` (`resident.ts:166-169`) and is umask-portable as claimed.
- CORE_FIELDS pin matches `src/providers/run-record.ts:58-72` (exactly those 13 keys, insertion order).
- dispatch_task testCommand rejection message matches `manifest.ts:96-101` verbatim.
- C6 credential-refusal assertions match `assertNoResidentCredentials`/`assertNoResidentCredentialValue` message formats (`pipeline-run.ts:590-616`), including the `brief.notes[1]` array-element and `brief.targets[1]` nested-object paths, and the tracer-close-before-throw that the WAL assertion depends on (`pipeline-run.ts:1430-1439`).
- C12 source-grep pins match `readResidentBriefSource` (`pipeline-run.ts:547-574`): the `code(err) !== "ENOENT"` walk and the "resident brief source" warning both exist.
- Run-end SIGINT readiness probe is sound: the fixture appends its session marker pre-hang, and the third marker implies `runSettled = true` already ran (`pipeline-run.ts:1603` precedes the run_end solicit at `:1608-1616`), so the first SIGINT deterministically takes the stop-resident branch.
