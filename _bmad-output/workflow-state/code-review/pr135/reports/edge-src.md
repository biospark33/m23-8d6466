# Edge Case Hunt — PR 135 src (resident.ts, steering.ts, journal.ts, pipeline-run.ts, barrels)

Reviewer: edge-src. Every finding verified against real source (`src/fleet/resident.ts`, `src/phase-engine/steering.ts`, `src/phase-engine/journal.ts`, `scripts/pipeline-run.ts`, plus callees `gates/library.ts`, `gates/command-gate.ts`, `phase.ts`, `trace/journal-bridge.ts`, `roster/validate.ts`, `cli-anything/scripts/team-lead-driver.ts`, `scripts/lib/cli-args.ts`).

---

### [HIGH] Gated retry loop ignores `bodyCtx.signal.aborted` — post-settlement zombie loop re-spawns command, gate and resident, and mutates the journal after the terminal marker
- Location: `scripts/pipeline-run.ts:746-793` (the `for (let attempt...)` in `gated`), catch guard at :756
- Trigger condition: a code phase with `testCommand` whose gate fails while the phase's abort has fired — either `maxDurationMs` overflow (the per-attempt timer aborts the controller mid-gate) or `run.terminate()` on SIGTERM/SIGINT. `commandGate` inherits the aborted `ctx.signal` (command-gate.ts:57), so every subsequent gate spawn is killed instantly and returns a failed check → `GateFailureError` → the loop's only exit test is `attempt > spec.retries`; nothing checks `bodyCtx.signal.aborted`.
- Consequence: after `Run.phase` has already settled the phase (`Promise.race` grace, `phase.ts` CANCEL_GRACE_MS) and `walkPhases` has moved on to `finish`, the abandoned `gated` loop keeps running in the background: it re-runs `base` (manifest command), re-runs the gate, and — worst — calls `solicitResident` per iteration, i.e. up to `retries` × 2 real pi solicitations (~60 s each, real spend, metered into a telemetry block whose journal snapshot may already be written). It also appends `gate_fail` events through `journal.writeGateEvent` after `finish()` has written the terminal marker, so the settled journal file's bytes change post-marker; and `main`'s `process.exit(code)` orphans any in-flight pi child (Bun.spawn, no signal tie; `stop()` is never called — see the MEDIUM below).
- Guard suggested:
  ```ts
  } catch (err) {
    if (bodyCtx.signal.aborted) throw err;                    // abort outranks the retry contract
    if (!(err instanceof GateFailureError) || attempt > spec.retries) throw err;
  ```

### [MEDIUM] Accepted `resident_directive` gate events fabricate a `passed=false` row in `gate_results` and write an event type outside the closed `TraceEventType` union
- Location: `scripts/pipeline-run.ts:777-787` (write) → `src/phase-engine/trace/journal-bridge.ts:192-214` (mapping)
- Trigger condition: any accepted `retry` directive at `post_gate_failure` writes `journal.writeGateEvent({ type: "resident_directive", ... })`. `TracingJournal.writeGateEvent` derives `eventType` from the free-form string, then (a) `passed: eventType === "gate_pass"` → inserts a `gate_results` row with `passed=0`, `gate="resident"`, `violations=[]`, `checks=[]`; (b) casts `type: eventType as TraceEventType` and persists `"resident_directive"` into `events.type` (schema has no CHECK; `types.ts:325` union unchanged).
- Consequence: every steering retry reads as a FAILED gate to any consumer of `gate_results`/`passed=0` (dispatch metrics, reverify comparisons, a poller keying gate failures) — and a zero-check `passed=false` row is exactly the INV-5 "examined nothing" shape. The trace store also now carries an event type the closed union does not name, so readers switching on `TraceEventType` meet an unlisted value.
- Guard suggested: write the directive as `tracer.trace({ type: "log", name: "resident_directive", ... })` (the `phase_state`/`residentTripwire` precedent already in this PR), not through `writeGateEvent`; or extend `TraceEventType` and skip `recordGateResult` for it.

### [MEDIUM] `redact(stderr.slice(-400))` truncates before redacting — the ordering rule `command-gate.ts` documents as a leak
- Location: `src/fleet/resident.ts:214`
- Trigger condition: pi exits non-zero and its stderr tail boundary cuts through a secret value (e.g. `OPENROUTER_API_KEY` echoed by a pi config error).
- Consequence: the redactor never sees the full value, so a partial secret suffix survives into the error message; the message then flows into the phase error record (`phase.ts` `toErrorShape` → journal) and the stderr log. `command-gate.ts:96-102` states the repo rule verbatim: "redact the FULL output before cutting the tail window — a secret straddling the cut no longer matches the full-value pattern, so truncating first would leak its partial suffix".
- Guard suggested: `redact(stderr).slice(-400)`.

### [MEDIUM] Resident solicitation wall clock is reserved by no budget at all
- Location: `scripts/pipeline-run.ts:1306-1318` (run_start), `:761-767` (post_gate), `:1394-1402` (run_end); budget math in `src/phase-engine/manifest.ts:592-598` (`requiredBudgetMs`) and `loadManifest`'s `runBudgetMs ≤ callerBudgetMs` check; `src/phase-engine/steering.ts:26` (`SOLICIT_TIMEOUT_MS = 60_000`); `src/fleet/resident.ts:78-81` (env override up to `2^31-1` ms ≈ 24.8 days).
- Trigger condition: any resident-armed run; worst case 2 calls at run_start + 2 per gate failure × `retries` (≤5) + 2 at run_end ≈ 14 calls × timeout.
- Consequence: `--budget-ms`/`runBudgetMs` account phase attempts only (`requiredBudgetMs` never counts solicitations), so a run declared at 120 s can legally spend 10+ extra minutes in steering, including between the terminal marker and process exit. The env override's upper bound admits a ~24.8-day per-call hang that no budget or ceiling constrains.
- Guard suggested: include `steeringCalls(2 per point × points + 2 × Σretries) × SOLICIT_TIMEOUT_MS` in the admission arithmetic, and cap `QDS_RESIDENT_TIMEOUT_MS` well below `2^31-1`.

### [MEDIUM] `meter()` has no finite-number guard — one NaN/Infinity usage poisons `spendMicros` for the rest of the run
- Location: `src/phase-engine/steering.ts:209-213`
- Trigger condition: any `ResidentCaller` (the port is exported from the engine barrel for third-party injection) whose `usage` carries `NaN`, `Infinity`, or a negative value. The shipped fleet caller is safe (`readTurnUsage` → `finiteNonNegative` in `team-lead-driver.ts:234-252`), but the port itself does not enforce it.
- Consequence: `Math.round(NaN * rate)` = NaN; `spendMicros += NaN` sticks — every later `spendMicros` is NaN, which `JSON.stringify` writes into the journal's `resident` block as `null`, silently destroying the run's resident spend record. Infinity likewise becomes `null`; a negative usage decrements spend.
- Guard suggested: `if (!Number.isFinite(usage.inputTokens) || usage.inputTokens < 0) return;` (or clamp both fields before metering).

### [MEDIUM] `--run-id` is interpolated into file paths unvalidated — path traversal for the pi session file and the persisted prompt/reply artifacts
- Location: `src/fleet/resident.ts:140` (`sessionPath = join(opts.sessionDir, \`${opts.runId}.resident.jsonl\`)`), `:151` and `:219` (`\`${opts.runId}-solicit-${seq}-prompt.txt\`` / `-reply.txt`); `--run-id` accepted unvalidated at `scripts/pipeline-run.ts:933-936` (only correlated mode constrains the id, and there it is replaced by a UUID).
- Trigger condition: `--run-id ../../etc/foo` or any runId containing `/` (bare mode; also any future caller of `startResident` with an upstream-supplied runId).
- Consequence: `join` escapes `sessionDir`/`persistDir`, so pi writes its session file and the runner writes 0600 prompt/reply artifacts into arbitrary directories. Two runs sharing a `--journal` dir and runId also collide on the same session file and artifact names (silent overwrite, interleaved session continuity).
- Guard suggested: validate runId once in `main` against `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` (or `basename`-sanitize inside `startResident`).

### [MEDIUM] The pi child inherits the FULL parent env while manifest commands get the scrubbed `childEnv()` — and the redaction bind only knows two key names
- Location: `src/fleet/resident.ts:142` (`const childEnv = opts.env ?? process.env`) and `:179` (`env: childEnv`); redaction bind at `:100-107`.
- Trigger condition: any resident-armed run on a host whose env carries secrets beyond `ANTHROPIC_API_KEY`/`OPENROUTER_API_KEY` (e.g. `GITHUB_TOKEN`, `AWS_*`). Contrast `scripts/pipeline-run.ts:122-129` where the runner deliberately narrows the env for manifest commands.
- Consequence: the agent subprocess sees every secret in the environment (policy asymmetry with INV-4's least-privilege posture), and because `bindRedact` only binds those two names, a reply or stderr that echoes any OTHER env secret is persisted verbatim into `<journalDir>/<runId>-solicit-N-reply.txt` / the error message.
- Guard suggested: pass an explicit narrow env to `startResident` (the `childEnv()` set + the two key names), not `process.env`.

### [MEDIUM] `stop()` is never called anywhere — signal during a solicitation neither aborts the pi child nor interrupts the await, and delays settlement
- Location: `src/fleet/resident.ts:233-243` (`stop`, dead code — grep confirms no caller); `scripts/pipeline-run.ts:1200-1223` (`onSignal` → `run.terminate`, which only aborts `run.current`, undefined during a solicitation); `:1306-1318`/`:1394-1402` (the awaited `solicitResident` calls).
- Trigger condition: SIGTERM/SIGINT arrives while `run_start`/`post_gate_failure`/`run_end` solicitation is in flight.
- Consequence: the first signal sets `terminated` and returns, but `main` keeps awaiting the pi child for up to the full timeout (default 60 s, env-raisable) before the walk observes `isHalted`; the pi child is never killed (`stop()` unused, and Bun.spawn's timer is the only bound). Only a SECOND signal escapes immediately, and its `process.exit(2)` orphans the running pi child. Also, the `run_end` solicitation runs after `run.finish` has written the terminal marker but before `tracer.close()` (`:1389-1433`): a poller that tears the box down on marker sight kills the process with the trace WAL un-checkpointed, and the exit code is delivered up to ~2 minutes after settlement.
- Guard suggested: in `onSignal`, `await residentSpawn?.stop()` (or abort a controller wired into the caller) before `run.terminate`; and run the `run_end` solicit before `finish`/marker, or bound it to a fraction of the timeout.

### [LOW] Accepted directives that the current point cannot apply are counted as accepted and never journaled
- Location: `src/phase-engine/steering.ts:268-272` (counts every schema-valid directive); `scripts/pipeline-run.ts:1306-1317` (`retry` at run_start silently ignored; `select_roster` recorded), `:768-790` (`select_roster` at post_gate_failure ignored entirely; `retry` at run_end never reaches a consumer).
- Trigger condition: the model returns `{"action":"retry",...}` at `run_start`/`run_end`, or `{"action":"select_roster",...}` at `post_gate_failure`/`run_end`.
- Consequence: `telemetry.directives` (and `steeringIterations` for a phase-keyed retry) increments for a directive with no effect and no journal row — only the stderr `resident_solicit` line hints at it. Telemetry overstates the resident's influence; an auditor comparing `directives` against journal `resident_directive` events sees unexplained counts.
- Guard suggested: reject (tripwire) or explicitly journal "accepted but not applicable at this point" for point/directive pairs the runner cannot apply.

### [LOW] Head-truncation drops the newest prompt-context lines first — accepted retry guidance is the first content cut
- Location: `src/phase-engine/steering.ts:126-144` (`truncateHeadWithSuffix` keeps the head) + `scripts/pipeline-run.ts:773-775` (guidance pushed to the tail of `residentContextLines`).
- Trigger condition: prompt context exceeding the ~15.7 KB budget — reachable because witness-borne values are unbounded strings (`residentContextLines` sanitizes but never bounds them).
- Consequence: the run facts that motivated nothing survive while the just-accepted guidance (the reason the push exists) is silently truncated out of the very solicitation that should consume it.
- Guard suggested: bound each context line at push time, or truncate the context tail-first so the newest lines (guidance) survive.

### [LOW] Degradation cause is discarded — ENOENT, timeout and kill are indistinguishable in telemetry
- Location: `src/phase-engine/steering.ts:237-244` (`catch { telemetry.status = "degraded"; return PROCEED; }`)
- Trigger condition: the caller throws for any reason (pi not installed, native timeout SIGKILL, non-zero exit, persist write failure).
- Consequence: the journal's `resident.status: "degraded"` carries no cause, no tripwire row, no log line — an operator cannot tell "pi missing on the box" from "slow model". `lastExit` in resident.ts keeps the mapping, but nothing writes it into the degraded path's record before the final refresh.
- Guard suggested: `telemetry.tripwires.push({ cause: "gate_bypass_attempt", detail: sanitizeForMessage(msg) })` or a dedicated degraded-reason field.

### [LOW] `stop()` racing a about-to-spawn call misses the child
- Location: `src/fleet/resident.ts:148-186` vs `:233-243`
- Trigger condition: `stop()` invoked in the window between `seq += 1`/persist and `current = proc` (spawn is sync, but the persist write and the await boundary before it leave the window open across ticks).
- Consequence: `stop()` sees `current === null` and returns; the new call proceeds and runs to its own timeout. DF3.6's watchdog would kill a resident that believes it stopped one.
- Guard suggested: a `stopped` flag checked at the top of `call` (throw "resident stopped") set by `stop()`.

### [LOW] Rerunning the same runId resumes the previous run's pi session and overwrites its artifacts
- Location: `src/fleet/resident.ts:140` (session path keyed on runId only), `:151`/`:219` (artifact names keyed on runId+seq, seq restarts at 1 per process)
- Trigger condition: a re-dispatch that reuses `--run-id` (bare mode permits it).
- Consequence: the new run's resident inherits the previous run's whole conversation (context pollution across runs), and `-solicit-1-prompt.txt` etc. silently overwrite the earlier run's persisted evidence (§5.2 artifacts lose their provenance).
- Guard suggested: key the session/artifact names on runId + a per-process nonce, or refuse a start when the session file already exists.

### [LOW] `QDS_RESIDENT_TIMEOUT_MS` is read from `process.env`, ignoring the injected `opts.env`
- Location: `src/fleet/resident.ts:78-81` vs `:142` (`opts.env ?? process.env`)
- Trigger condition: a caller (the documented test seam) passes a custom `env` containing `QDS_RESIDENT_TIMEOUT_MS`.
- Consequence: the override is silently ignored — the same env-shaped knob behaves differently for the key (`env`) and the timeout (`process.env`).
- Guard suggested: `(opts.env ?? process.env).QDS_RESIDENT_TIMEOUT_MS`.

### [LOW] Prompt/reply artifacts accumulate in the journal directory with no bound or cleanup
- Location: `src/fleet/resident.ts:115-118` + `scripts/pipeline-run.ts:1264-1267` (`persistDir` = the journal's dir)
- Trigger condition: steady operation — every run leaves `2 × solicitations` files beside the journal forever.
- Consequence: unbounded directory growth of 0600 files containing run content; nothing rotates, prunes, or records a retention rule (the journal itself at least rewrites one file).
- Guard suggested: a documented retention note plus a best-effort prune of `*.solicit-*` older than N days, or write artifacts under a per-run subdir.

### [LOW] Gate-note redaction is bound to the scrubbed `childEnv()`, so it is structurally a no-op
- Location: `scripts/pipeline-run.ts:742` (`commandGate([...test], { cwd, env: childEnv(), ... })`) → `src/phase-engine/gates/command-gate.ts:99-102`
- Trigger condition: a failing `testCommand` whose output contains a secret obtained from anywhere other than the child env (hardcoded token, a file it read).
- Consequence: `redactSecrets(raw, {PATH,HOME,...})` matches nothing, so the note is persisted verbatim into journal `gateEvents` and trace `gate_results.checks`. Technically consistent with command-gate's "hand the env the subprocess saw" rule (the child really has no secrets), and `runCommand`'s pre-existing PF-2 `stdoutTail` has the same residual — but this PR adds a second persisted path for raw command output under a redaction that cannot fire.
- Guard suggested: reuse the runner's `bindRedact(process.env)`-style chokepoint (resident.ts:100-107) for gate notes instead of the child's secret-free env.

### [LOW] `testCommand` on a non-`code` phase is schema-legal and silently unenforced
- Location: `src/phase-engine/manifest.ts:75` (`testCommand: argv.optional()` on every kind) vs `scripts/pipeline-run.ts:738-741` (gate composed only inside `spec.kind === "code"`)
- Trigger condition: a manifest declaring `testCommand` on an `agent`/`engineer`/`dispatch_task` phase.
- Consequence: validation passes, the field is accepted, and no gate ever runs — an author believes tests are enforced when they are not (no warning, no journal trace).
- Guard suggested: `superRefine` to forbid `testCommand` when `kind !== "code"` (mirroring the `command` rule), or warn at load.

### [LOW] The malformed-reply correction prompt references "the closed union" without restating its members
- Location: `src/phase-engine/steering.ts:159-165` vs the member list at `:110-119`
- Trigger condition: first reply malformed → the second call's prompt is only the 3-line correction. The shipped fleet caller has `--session` continuity so pi saw the union on call 1, but the port explicitly allows stateless `ResidentCaller`s.
- Consequence: a stateless caller's second attempt asks the model to match a union it was never shown — the "two consecutive malformed → degrade" path becomes near-certain, degrading steering that one extra line of schema text would have saved.
- Guard suggested: append `DIRECTIVE_INSTRUCTION` (or at least the four member shapes) to `malformedCorrectionPrompt`.

### [LOW] `JournalFile.version` stays "1.0.0" while the file gains a `resident` field
- Location: `src/phase-engine/journal.ts:69-84` (new optional field), `:147` (`version: "1.0.0"`)
- Trigger condition: any consumer that pins on `version === "1.0.0"` to assume the documented pre-DF3.3 shape (no `resident` key).
- Consequence: shape drift inside an unchanged version label; a strict reader (closed field set) rejects every new journal, a lenient one silently ignores telemetry.
- Guard suggested: bump to "1.1.0" (or document the additive rule next to the version constant).

### [LOW] The brief witness is read a second time for arming, unsynchronized with the read the cap reconciled
- Location: `scripts/pipeline-run.ts:528-542` (`readResidentBriefSource`) vs the cap-path read at `:465-519`
- Trigger condition: the witness file's content changes between the cap read and the brief read (within the S28 freshness window an author can still rewrite it).
- Consequence: the resident is armed/prompted from content that is not what the ceiling was reconciled against — prompt-context drift only (no cap impact), so informational.
- Guard suggested: reuse the bytes the cap path already read, or note the accepted TOCTOU next to `readResidentBriefSource`.

---

## Verified-handled (not reported, with the guard that handles them)
- Empty/absent brief → `{disabled:true}` before rate resolution (`resident.ts:88-93,127`); runner-side arming additionally requires an identity field (`pipeline-run.ts:1241-1246`), so an array/`[]` witness cannot arm.
- `QDS_RESIDENT_TIMEOUT_MS` = NaN/""/0/negative/float → falls back to the frozen constant (`resident.ts:80`).
- Surrogate-pair-safe truncation and a positive budget by construction (`steering.ts:126-144,152`).
- Malformed-reply loop bounded at exactly 2 calls; degraded residents short-circuit to `PROCEED` thereafter (`steering.ts:235-253,233`).
- Schema rejections are single-attempt tripwires with sanitized detail (`steering.ts:184-191,216-228`); `rosterId` checked against the closed set, empty set rejects everything (`pipeline-run.ts:573-584`).
- Bun.spawn ENOENT throws synchronously and is caught → `transient` (`resident.ts:157-185`); signal death detected via `exitCode === null || signalCode !== null` (`:206-210`).
- `attempt > spec.retries` bounds the gated loop in the non-aborted case; non-`GateFailureError` propagates (`pipeline-run.ts:756`).
- `tokenizeArgs`/`parseValueFlags` split: `--no-resident=x` → unknown-flag throw; `--manifest --no-resident` → missing-value throw; `-h` still reaches the help branch; a `-`-prefixed value like `--run-root -foo` still pairs (`cli-args.ts:140-178`, `50-88`).
- Journal flush is temp+fsync+rename with `O_NOFOLLOW` (`journal.ts:145-180`); the final `writeResident` is guarded so a failing refresh cannot downgrade a settled run (`pipeline-run.ts:1416-1423`).
- `solicitResident` never throws and its stderr line cannot discard a parsed directive (`pipeline-run.ts:616-655`).
- `harvestPiStream` returns only finite non-negative usage (per-turn, `message_end` only) — the shipped caller cannot feed NaN to `meter` (`team-lead-driver.ts:234-252,270-364`).
