# Edge Case Hunt — pr135 chunk-pipeline (scripts/pipeline-run.ts DF3.3 resident wiring)

Scope: `--no-resident` flag, three steering hook sites, `closedRosterIds()`, brief rendering,
commandGate+retry composition, journal resident block pre-seed. Every finding below was
confirmed against the real source (scripts/pipeline-run.ts, src/phase-engine/steering.ts,
src/fleet/resident.ts, src/phase-engine/journal.ts, src/phase-engine/phase.ts,
src/phase-engine/gates/library.ts, src/phase-engine/gates/command-gate.ts,
src/phase-engine/agents/retry.ts, src/phase-engine/roster/schema.ts,
src/phase-engine/phases/dispatch-task.ts, scripts/lib/cli-args.ts).

## Findings

### HIGH — Orphaned in-flight solicitation overlaps run_end; resident.ts single-slot `current` clobbered, pi child can outlive process.exit
**scripts/pipeline-run.ts:838-920 + 1608-1616; src/fleet/resident.ts:212,257,276,319-330; src/phase-engine/phase.ts:263-281**

Trigger: a `post_gate_failure` solicitation is in flight (pi call, up to 60 s default /
600 s via `QDS_RESIDENT_TIMEOUT_MS`) when the phase's `maxDurationMs` timer fires (or a first
SIGTERM lands). The gated loop's `if (bodyCtx.signal.aborted) throw err` guard
(pipeline-run.ts:852) only runs in the catch *after an attempt fails* — it never cancels the
solicitation itself, and the resident call has no abort wiring (`steering.solicit` ignores the
signal; the first-signal path `run.terminate(sig)` at pipeline-run.ts:1380 does **not** call
`residentSpawn.stop()`). `Run.phase`'s `CANCEL_GRACE_MS` race (phase.ts:263-276) then settles
the phase as fail while the body is still awaiting pi. Main proceeds: `writeResident` →
`finish` (terminal marker) → `run_end` solicitation starts a **second** pi call while the
orphan is still in flight. Now two `call()` invocations interleave over resident.ts's single
`current` slot and one shared `--session` file:
- Orphan's completion executes `current = null` (resident.ts:276), erasing the run_end call's
  registration. The cleanup `stop()` at pipeline-run.ts:1633 then sees `current === null` and
  SIGKILLs nothing — the run_end pi child outlives the `process.exit` at pipeline-run.ts:1677,
  contradicting the explicit invariant comment at 1356-1357 ("no pi child outlives process.exit").
- Both pi processes resume/append the same `${runId}.resident.jsonl` session file concurrently.
- The orphan's next loop iteration re-runs `base` post-abort (spawn + immediate SIGKILL) and
  runs `commandGate`, journaling a gate event *after* the phase settled — potentially a
  `gate_pass` row for a phase recorded `fail`, and potentially after the terminal marker /
  `tracer.close()` (the tracer forward is guarded, but the FileJournal row is not).

### MEDIUM — run_end solicitation fires on terminated runs; first signal never stops the resident
**scripts/pipeline-run.ts:1608 (`if (steering !== undefined && !residentAborted)`)**

The run_end gate checks `residentAborted` but not `terminated`. Trigger: resident armed,
SIGTERM during a phase (or during the run_start solicitation). `onSignal` sets
`terminated = true` and calls `run.terminate(sig)` (1380) but leaves any in-flight pi call
running; after `finish(!terminated)` writes the not-ok marker, main awaits a **fresh** run_end
solicitation — up to `QDS_RESIDENT_TIMEOUT_MS` (600 s max) of pi spend on a run the operator
just killed, with the exit code already committed. Worst case (signal during run_start
solicitation) is two sequential post-signal pi calls before exit. The `runSettled` branch only
helps if a *second* signal arrives.

### MEDIUM — Second signal in the post-finish window exits 2 after the terminal marker was written
**scripts/pipeline-run.ts:1341-1363**

The `if (terminated)` branch's justification — "the run never reached `finish`, so no marker
was written and the exit code must not claim the run settled" — is false once `runSettled` is
true. The DF3.3 code widened that window from ~nothing to the whole run_end solicitation +
`exitStatus()` + `stop()` + journal refresh. Trigger: SIGTERM after `run.finish`, then a second
SIGTERM/SIGINT during the run_end pi call → `process.exit(2)` with a settled `ok` marker
already on disk: exit code says "never settled", marker says settled. Pre-change this race was
effectively unreachable; now it is the common way to kill a hung run_end call.

### MEDIUM — Retry attempts share ONE maxDurationMs timer; DF1.3's per-attempt discipline is not mirrored
**scripts/pipeline-run.ts:838-920; src/phase-engine/phase.ts:245-251; src/phase-engine/manifest.ts:606**

The gated loop runs all `spec.retries + 1` attempts inside a single `Run.phase` invocation, so
one phase-level `setTimeout(maxDurationMs)` covers every attempt's command + gate **plus every
post_gate_failure solicitation** (each up to the pi timeout). The comment at
pipeline-run.ts:854-855 claims to mirror "the retry.ts:284-287 branch", but DF1.3's loop
(src/phase-engine/agents/retry.ts:162) gets a fresh per-attempt timer (phase.ts:246 states that
contract explicitly), and the manifest budget check (manifest.ts:606) reserves
`(retries + 1) * (PARSE_FIX_ATTEMPTS + 1) * maxDurationMs` per phase. Trigger: code phase with
`testCommand`, `retries: 2`, `maxDurationMs: 60_000`, command runtime 40 s — attempt 2 overflows
the shared timer and the phase fails `overflow`, where DF1.3 semantics (and the admitted budget)
give each attempt its own 60 s. Direction is fail-closed (never over-budget), but it is a real
semantics drift wearing a "mirrored" comment. (Minor: the referenced path is
`agents/retry.ts:284-287`, not `retry.ts:284-287` — no `src/phase-engine/retry.ts` exists.)

### MEDIUM — Accepted `retry` guidance is functionally inert
**scripts/pipeline-run.ts:890-894; src/phase-engine/steering.ts:156-164**

On a `retry` directive the runner pushes the guidance into `resident.promptContext`, whose only
consumer is `renderPrompt` — i.e. the resident's own *future* solicitation prompts. The
engine-authorized attempt N+1 re-runs the byte-identical `cmd` argv; nothing in the attempt
consumes the guidance. The `ResidentHooks` docstring (pipeline-run.ts:629-630, "accepted retry
guidance is appended here for the engine-authorized attempt that consumes it") describes a
mechanism that does not exist: an accepted `retry` with guidance is indistinguishable in effect
from `proceed`. The run is billed for the solicitation and records an accepted directive whose
payload changes nothing about what executes.

### LOW — `select_roster` accepted at `post_gate_failure` / `run_end` is silently dropped; closed set is a cross-roster union
**scripts/pipeline-run.ts:865-916, 1507-1520, 1608-1616, 650-668; src/phase-engine/steering.ts:298-303**

`rosterChoice.pending` is only ever set from the `run_start` directive (1517-1519). A
`select_roster` returned at `post_gate_failure` falls through the abort/retry branches
untouched, and the `run_end` directive is discarded outright — yet steering.ts counts all of
these as accepted directives (telemetry.directives incremented after roster-set validation).
The agent is told the pick was accepted; nothing records or applies it, not even the trace row
the run_start path emits. Compounding: `closedRosterIds` unions role names across **all**
dispatch_task phases' rosters and the runner ignores the directive's `phase` field, applying
any pending pick to the *next* dispatch_task phase — a pick naming a role that exists only in
phase 2's roster validates and is then "applied" (traced) against phase 1 running a different
roster. Impact today is trace-only (the spawn-side switch is documented DF1.6 drift), so LOW.

### LOW — Gate-event shape drift: code-phase events lack `gate_ms`
**src/phase-engine/gates/library.ts:267-279 vs src/phase-engine/agents/retry.ts:243-258**

DF1.3's loop writes `gate_ms: gate_exec_ms + gate_report_ms` on every gate event; `gatedBody`
(used by the new code-phase composition) writes only the exec/report split. The two producers
of `gate_results` rows now emit different field sets — a poller keying on `gate_ms` sees it on
agent-phase rows and absent on code-phase rows.

### LOW — Unbounded recursion in the credential scan can refuse the run with a bare RangeError
**scripts/pipeline-run.ts:590-616**

`assertNoResidentCredentials` / `assertNoResidentCredentialValue` recurse two stack frames per
nesting level with no depth cap. `JSON.parse` (readResidentBriefSource, :554) typically costs
one frame per level, so a brief nested deep enough to survive the parse can still overflow the
scan. The RangeError is caught by the arming guard (1430-1439), the tracer is closed, and the
run exits 2 with `pipeline-run: Maximum call stack size exceeded` — a refusal indistinguishable
from a harness bug, on a witness whose only sin is deep nesting. Size-capped by
`readArtifactBeneathRoot`, so the trigger needs a pathological-but-small document (e.g. ~10⁴
nested arrays ≈ 20 KB).

### LOW — `writeAll` spins forever on a 0-byte `writeSync`
**scripts/pipeline-run.ts:153-163**

The loop exits only on full progress or a throw. POSIX permits `write(2)` to return 0; if
`fs.writeSync` ever does (exotic fd states), `written` never advances and the run hangs inside
a "never fail the run" helper with no bound. No iteration cap, no break on 0.

## Verified clean (checked and refuted)

- **`--no-resident` / tokenizer parity**: `tokenizeArgs` + `parseValueFlags(flagTokens)` is
  behaviorally equivalent to the pre-change direct `parseValueFlags(argv)` for all value flags
  (missing values, `--flag=value`, single-dash values, unknowns all land identically);
  `--no-resident=x` throws "unknown flag" loudly. The no-resident leg skips brief read, spawn,
  and all three solicitations; non-gated code phases and dispatch_task phases are byte-identical
  to pre-change. (Note: code phases *with* `testCommand` are newly gated on **both** legs —
  deliberate R2-gap closure, so `--no-resident` matches the new resident leg, not the old binary.)
- **Roster anchoring**: `closedRosterIds` uses `loadRoster(spec.roster, { cwd: runRoot })`;
  dispatch_task resolves with `rootDir` = the same `runRoot` passed by the factory
  (dispatch-task.ts:166,173). Same confinement root default. Duplicate role ids dedupe via Set;
  unloadable roster warns and leaves the set shut; dispatch_task later refuses with the real error.
- **Retry off-by-one**: `attempt > spec.retries` yields exactly `retries + 1` attempts, matching
  agents/retry.ts:284.
- **Resident block pre-seed ordering**: `innerJournal.writeResident` before `run.finish` survives
  finish's flush (FileJournal instance state, journal.ts:126-153); a throw pre-finish propagates
  to exit 2 with no marker — honest. Post-marker refresh is guarded and non-throwing.
- **RateError degradation**: refuses only the resident; journal keeps the explicit "disabled"
  shape; other `startResident` throws close the tracer before propagating.
- **`residentArmed` excludes `effectiveCeilingMicros`**; empty/parse-failed witness is the quiet
  AC4 path; non-ENOENT read faults warn on stderr.
- **Prompt ceiling**: `renderPrompt` reserves header + instruction before head-truncating
  context; `promptContext` growth is bounded by `retries` per gated phase.
- **Callee signatures** (`createSteering`, `startResident`, `commandGate`, `gatedBody`,
  `writeResident`, `loadRoster`, `tokenizeArgs`) all match their call sites.
