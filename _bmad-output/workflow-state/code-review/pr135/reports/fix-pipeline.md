# Fixer Report — Cluster S3 (fix-pipeline), PR 135 round 5

Scope: `scripts/pipeline-run.ts` + `src/phase-engine/gates/library.ts` (gate_ms item only).
gitnexus MCP `impact` not available in this subagent — impact step noted as skipped. Edited
symbols are runner-local (`writeAll`, `assertNoResidentCredentials*`, `closedRosterIds`,
`solicitResident`, `makeBodyFactory`, `main`, `onSignal`) or an additive field on a journal
event row (`gatedBody`'s `writeGateEvent`); no cross-module signature changed except the
additive `gate_ms` key (GateEvent has `[k: string]: unknown`, types.ts:253-257).

## Verdict table

| # | sev | verdict | evidence (file:line, post-fix) |
|---|-----|---------|--------------------------------|
| S3-1 | HIGH | FIXED | Second-signal branch now exits `runSettled ? (settledExitCode ?? 1) : 2` — pipeline-run.ts:1470; `settledExitCode` is captured before `runSettled` flips (pipeline-run.ts:1775-1778). |
| S3-2 | HIGH | FIXED | Seed moved before `walkPhases` (inside the new try): pipeline-run.ts:1697 `innerJournal.writeResident(residentTelemetryOf())`. FileJournal instance-state survival of finish's flush verified pre-edit at journal.ts:126-153 (`writeResident` sets `this.resident`; `finish` only touches ok/completedAt then flushes the same body). NOTE: journal.ts was mid-edit by fix-engine while I worked; the contract I rely on is that writeResident/finish instance-state semantics survive their round-5 patch. |
| S3-3 | HIGH | FIXED | `try { …seed → solicitations → walkPhases → finish → run_end → close/banner/return… } finally { best-effort residentSpawn.stop() → exitStatus probe → best-effort writeResident refresh }` — pipeline-run.ts:1685-1877. Any throw after startResident (phase-body non-gate error, seed writeResident throw) now stops the pi child and still refreshes the block before the module-level catch owns exit 2; an orphaned in-flight solicitation cannot overlap run_end. |
| S3-4 | MED | FIXED | run_end gate is now `steering !== undefined && !residentAborted && !terminated` (pipeline-run.ts:1785). First-signal path (pre-settlement) now also `await residentSpawn?.stop()` after `run.terminate(sig)` (pipeline-run.ts:1490-1498), so run_start/post_gate_failure in-flight pi calls die on the first signal, not just post-finish. Round-4's runSettled branch (post-finish stop) was already present and is unchanged. |
| S3-5 | MED | FIXED (comment, per pre-authorized decision) | Shared timer kept (fail-closed). Comment at pipeline-run.ts:907-917 now names the real path `src/phase-engine/agents/retry.ts:284-287` and states the drift explicitly (per-attempt timer in DF1.3 via phase.ts:245-251 vs ONE shared phase timer here; manifest.ts:606 reservation is the looser outer bound). |
| S3-6 | MED | FIXED (docstring, execution-neutral) | `ResidentHooks.promptContext` doc (pipeline-run.ts:651-657) now states guidance only steers subsequent solicitation prompts; the retried command re-runs byte-identical. |
| S3-7 | MED | DISMISSED (false positive) | `walkPhases` (src/phase-engine/phase.ts:454-467) calls `run.phase` once per spec; `Run.phase` invokes the body exactly once (phase.ts:257). Symbol-aware verification (gitnexus, round-6 re-check): `impact runAgentPhase --direction upstream` → **impactedCount 0, risk LOW, epistemic "exact", zero affected processes/modules**; `context runAgentPhase` → the ONLY incoming calls are `tests/phase-engine/retry.test.ts` (`harness` + file-level) — no production execution flow reaches `runAgentPhase` (agents/retry.ts:118-302), so no engine-level retry wraps gated code bodies: no double authorization, no abort override, no (N+1)². Dismissal stands on call-graph evidence, not grep alone. |
| S3-8 | MED | VERIFIED — role names are correct; doc fix only | Roster files have NO roster-level id: `RosterFileSchema` is exactly `{defaults, roles}` (roster/schema.ts:129-131); the roster is named by its path (`spec.roster`). The pickable unit behind the directive's `rosterId` spelling is a role NAME. `closedRosterIds` docblock now says so (pipeline-run.ts:695-707). No set-construction change. |
| S3-9 | MED | DISMISSED with evidence | `git grep -l testCommand origin/dev -- '*.json' '*.yaml' '*.yml'` → only `_bmad-output/evidence/df1-6/e2e-live-evidence.json` (a recorded evidence artifact, not a manifest the runner loads). The only pipeline manifest with a code-phase testCommand is `tests/phase-engine/fixtures/pipeline.resident.json`, added by THIS PR (2548df7/47a8e8e). The new gating on both legs is the deliberate R2-gap closure (edge-pipeline verified); no existing manifest changes behavior. |
| S3-10 | MED | FIXED | (a) `rosterIds` advertised ONLY at run_start (pipeline-run.ts:1707); post_gate (925) and run_end (1790) omit it → steering's existing empty-set fail-closed rejection + tripwire (steering.ts:298-303). (b) `phaseIds` (all manifest phase names, pipeline-run.ts:1555) wired into all three SolicitCtx sites via the local `RunnerSolicitCtx = SolicitCtx & { phaseIds?: readonly string[] }` intersection (pipeline-run.ts:755) — compiles against the not-yet-declared port field; steering fixer's S1-5 validation uses the same field name. (c) roster pick now requires `directive.phase === spec.name` at application; mismatch traces `residentRosterChoice {applied:false, reason}` and leaves the pick pending for its own phase (pipeline-run.ts:dispatch_task branch). (d=S3-12) unconsumed pending pick traced at run end (`applied:false, "never consumed — no matching dispatch_task phase ran"`, pipeline-run.ts:1813-1831). |
| S3-11 | MED | FIXED | finally stops FIRST then probes `exitStatus()` (pipeline-run.ts:1851-1868). Note: `exitStatus()` is already a non-blocking probe (`async () => lastExit`, resident.ts:318) — the blind review's "unbounded wait" premise was wrong, but stop-first is still semantically right (probe reads how the resident ENDED, never races a live call). |
| S3-13 | LOW | FIXED | roster-choice rows now carry the engine phaseId (`bodyCtx.phaseId`), matching `phase_state` (pipeline-run.ts:994) and the `resident_directive` rows; the manifest name rides the payload's `phase` field as before. Rows with no live phase (run_start/run_end directives) omit phaseId, matching the `residentTripwire` precedent (pipeline-run.ts:1620-1625). |
| S3-14 | LOW | FIXED | `run.terminate(sig)` wrapped in try/catch inside the `void`-ed handler (pipeline-run.ts:1483-1489). |
| S3-15 | LOW | FIXED | Non-proceed run_start directives (abort, select_roster) and non-proceed run_end directives now emit `resident_directive` trace rows via the guarded `traceResidentDirective` helper (pipeline-run.ts:1667-1682, 1721-1724, 1796-1805). |
| S3-16 | LOW | FIXED | `writeAll` breaks on 0-progress, caps at 1000 iterations, and counts dropped bytes in `droppedWriteBytes` with a best-effort raw-writeSync marker line (pipeline-run.ts:148-181). Never-fail-the-run contract intact. |
| S3-17 | LOW | FIXED | `gatedBody`'s `writeGateEvent` now emits `gate_ms: Math.round(gateExecMs + gateReportMs)` (gates/library.ts:275-280), matching DF1.3's agent-phase rows (agents/retry.ts:253-255). Additive; GateEvent's index signature accepts it. |
| S3-18 | LOW | FIXED | Depth cap `RESIDENT_BRIEF_MAX_DEPTH = 32` on both scan halves; overflow throws `resident brief refused: nesting deeper than 32 levels at <path>` (pipeline-run.ts:615-619) instead of a bare RangeError. |
| S3-19 | LOW | FIXED | Scan now runs on ANY successfully parsed brief (`if (residentBrief !== undefined)`, pipeline-run.ts:1513-1528), before and independent of the arming check; the armed block keeps only spawn. Tracer-close guard preserved. |
| S3-20 | LOW | DISMISSED (confirmed) | journal.ts:135 `ok = rows.length > 0 && …` → empty run is ok:false; Run.finish:427 ANDs `terminating === undefined`. run_start abort → outcomes [] → finish → exit 1. |
| S3-21 | LOW | DISMISSED (spot-checked) | `tokenizeArgs`+`parseValueFlags` parity verified against scripts/lib/cli-args.ts: `--no-resident=x` → not in boolFlags (exact-match) → flagTokens → parseValueFlags `unknown flag: --no-resident`; `--flag --other` and `--flag -x` land identically in both grammars; `-h` passes through to the help clause (no rejectStraySingleDash here). |

## Behavior changes to flag for wave 2 (test re-pins)

1. **S3-2 seed timing**: the journal carries a resident block from BEFORE the walk (seeded pre-run_start), so a mid-run journal read now shows `resident.status` ("active"/"disabled") instead of no block.
2. **S3-4 terminated-skip**: a terminated armed run no longer fires the run_end solicitation (solicitation count drops by 1 on terminated legs) and the first signal now stops the resident at run_start/post_gate windows (subsequent solicitations degrade to PROCEED).
3. **S3-10 roster semantics**: select_roster at post_gate_failure/run_end is now tripwire-REJECTED (directivesRejected +1, not silently accepted); a pending pick only applies to the dispatch_task phase whose name matches `directive.phase`; roster-choice trace rows carry `phaseId` in the engine domain plus `applied` and, on mismatch/non-consumption, `reason`. `rosterChoice.pending` shape changed to `{rosterId, phase}` (module-internal).
4. **S3-17 gate_ms**: code-phase gate rows gain `gate_ms` (additive).
5. **S3-19**: a credential-shaped brief on an UNARMED run (no identity fields) now refuses the run with exit 2 (previously ran disabled).
6. **S3-1**: second signal post-settlement exits finish's code (0/1), not 2.
7. **S3-16**: stderr can now carry `observability write dropped …` warning lines under EAGAIN/0-progress.

## Gate results

- `bunx tsc --noEmit` — clean (whole repo, run after all edits).
- `bunx biome check scripts/pipeline-run.ts src/phase-engine/gates/library.ts` — clean.
- `bun test tests/phase-engine/pipeline-run.test.ts` (main tree, with my changes) — **42 pass / 0 fail**.
- `bun test tests/phase-engine/resident-e2e.test.ts` (main tree) — **6 pass / 4 fail**, BUT: parallel fixers had `steering.ts`, `journal.ts`, `resident.ts`, `fleet/index.ts` mid-edit (git status evidence) and the failing assertions (degraded-vs-active status, directive counts) point at steering/resident semantics outside my cluster. Isolation proof: HEAD + ONLY my two-file diff in a clean worktree → **resident-e2e 10/10 pass** and **pipeline-run 42/42 pass**. One contention re-run in the main tree (allowed) still 6/4 — fixers still in flight. Wave-2 must re-run resident-e2e after all round-5 fixers land; if any of those 4 still fail then, it is an interaction to triage (steering fixer's S1 changes are the prime suspects).

## Notes / leftovers

- `traceResidentDirective` helper added in main; the two pre-existing gated-loop directive rows were left inline (minimal diff).
- S1-6 (run_end retry inflating steeringIterations): the port-side guard belongs to fix-engine (steering.solicit knows `point`); run_end ctx still carries `phase` for the observability line. No S3-side change made.
- No edits to tests/phase-engine/pipeline-run.test.ts were needed — no existing expectation broke.
- Worktree `/tmp/qds-pr135-baseline` removed after use. No commits made.
