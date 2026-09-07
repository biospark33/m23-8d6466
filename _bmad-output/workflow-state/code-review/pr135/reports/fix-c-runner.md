# fix-c-runner — PR 135 round 2, cluster C — 2026-08-27

Branch: feature/df3-3-resident-orchestrator-agent. Files touched (only): `scripts/pipeline-run.ts`, `src/phase-engine/manifest.ts`, `tests/phase-engine/pipeline-run.test.ts`. Not committed.

## Verdict table

| Item | Verdict | Notes |
|---|---|---|
| C1 gated retry ignores aborted signal [HIGH] | **fixed** | First line of the catch: `if (bodyCtx.signal.aborted) throw err;` (pipeline-run.ts, `makeBodyFactory` gated loop). Verified semantics against phase.ts: the per-attempt AbortController is aborted on overflow and `run.terminate`, and the phase record is settled by the outer loop regardless of the body's later settling — the pre-fix loop then re-ran base+gate+solicit and wrote gate events after the marker. |
| C2 resident_directive via writeGateEvent | **fixed** | Now `tracer.trace({type:"log", name:"resident_directive", payloadJson:…})` — same precedent as residentTripwire/residentRosterChoice. Payload keeps runId/phase/action/guidance/attempt. Verified in a real run: row lands in trace.db as `type=log name=resident_directive`, and no gate_results row / no event outside the closed union is fabricated (journal-bridge no longer sees it). |
| C3 abort at post_gate_failure drops reason | **fixed** | Before the rethrow, a `type:"log" name:"resident_directive"` row records `{action:"abort", reason, phase, attempt}`. |
| C4 raw pipelineId/runId/phase names in prompt | **fixed** | `residentContextLines` routes pipelineId, runId, phase name and kind through `sanitizeForMessage`; the accepted-retry guidance pushed into promptContext is sanitized too (model-authored text reaching the next prompt). |
| C5 RateError refuses the whole run [BEHAVIOR CHANGE] | **fixed** | At the arming site in `main`: `RateError` → structured stderr line `event:"resident_disabled", reason:"rate_unresolved", model, detail`, `steering`/`residentSpawn` stay undefined so the journal resident block is the existing explicit `status:"disabled"` shape, run proceeds deterministically. Non-RateError arming refusals still close the tracer and throw (unchanged). `startResident`'s throw contract untouched. |
| C6 credential-shaped brief values | **fixed** | `assertNoResidentCredentials(residentBrief)` before spawn: mirrors manifest.ts's CREDENTIAL_FIELD/CREDENTIAL_VALUE shapes; refuses the run (throw → exit 2) naming the field, never the value; recurses nested objects. |
| C7 resident_solicit lacks `model` | **fixed** | `model` added to the observability line; slug threaded from `DEFAULT_RESIDENT_SLUG` (main passes no override) through `solicitResident`'s new 4th param and `ResidentHooks.model` for the post_gate_failure site. Verified live: `"model":"deepseek/deepseek-v4-flash-0731"` on every resident_solicit line. |
| C8 telemetry shallow copy | **fixed** | `residentTelemetryOf` now clones `steeringIterations` and maps `tripwires` to per-record copies, so the seeded block is not mutated by the post-finish run_end refresh. |
| C9 fs.writeSync partial writes | **fixed** | `writeAll(fd, data)` loop-until-written helper; all 11 `fs.writeSync` call sites in the file swapped, wrapped in sidecar try/catch discipline (write errors never fail the run). |
| C10 closedRosterIds silent catch | **fixed** | One stderr warning naming the roster path, the phase, the error, and the consequence ("select_roster will reject everything"); phase still refuses with the real error later. |
| C11 testCommand on non-code phase | **fixed** | `superRefine` addition in `PhaseSpecSchema`: `testCommand is forbidden when kind is '<kind>'`, mirroring the existing command/roster/task refinements. Negative test lives in `tests/phase-engine/dispatch-task.test.ts` territory — see wave-2 note. |
| C12 unreadable brief lands disabled silently | **fixed** | `readResidentBriefSource` catch distinguishes ENOENT (quiet — AC4's absent path) from every other failure (stderr warning "… is unreadable … — continuing without a resident"). The hardened reader wraps errno in a ManifestError `cause`, so the absence test walks the cause chain. |

False positives: none — all 12 verified real against source.

## Behavior-change flags (for wave 2 / e2e)

1. **C5 (main)** — a RateError at arming no longer exits 2. `tests/phase-engine/resident-e2e.test.ts` has no leg that relied on the refusal, but wave 2's D4 negative-control/disabled leg can now assert the new shape: `exit 0`, stderr `resident_disabled` + `rate_unresolved`, journal `resident.status === "disabled"`, `spendMicros === 0`. Easiest trigger in a test: `QDS_PI_CATALOG_DIR` pointed at a nonexistent dir (makes `loadRateSources` throw RateError).
2. **C2** — `resident_directive` no longer appears in the journal's `gateEvents`. `resident-e2e.test.ts:269-283` ("demo: out.json shows gate fail → steered retry → pass") currently asserts it there and **fails as of this change** — wave 2 must repoint that assertion at the trace store (`events` where `type='log' and name='resident_directive'`) or at `action`/`guidance` in the row payload. Everything else in that file passes (5/6).
3. **C11** — `dispatch-task.test.ts:963` ("accepts dispatch_task with roster+task+testCommand") pins the loose behavior and **fails as of this change**; wave 2 should flip it to a rejection case (testCommand on a dispatch_task phase is now schema-refused).

## Impact analysis (GitNexus, run before edits)

- `makeBodyFactory` upstream: risk **LOW**, 3 impacted symbols, sole caller chain `main` (process "main"), module Phase-engine.
- `readResidentBriefSource`, `residentTelemetryOf`, `closedRosterIds`, `residentContextLines`: not in the index (script-local helpers); all reachable only from `main` in the same file — verified by grep (no other importers).
- Post-change: `bunx tsc --noEmit` clean; no symbol renames (detect-changes-relevant surface limited to the touched helpers).

## Verification

```
bun test tests/phase-engine/pipeline-run.test.ts tests/phase-engine/manifest.test.ts
  113 pass, 0 fail, 391 expect() calls

bunx biome check scripts/pipeline-run.ts src/phase-engine/manifest.ts tests/phase-engine/pipeline-run.test.ts
  Checked 3 files in 22ms. No fixes applied.

bunx tsc --noEmit
  (clean, exit 0)
```

Full phase-engine suite for context: 651 pass / 2 fail — both fails are the wave-2 test-file expectations named above (resident-e2e demo gateEvents; dispatch-task testCommand-accepts), not regressions in behavior under test elsewhere.

## Test additions (tests/phase-engine/pipeline-run.test.ts, +133 lines)

New describe `pipeline-run DF3.3 arming policy (PR135 C)`:
- C5 disabled leg: unresolvable rate → exit 0, `resident_disabled`/`rate_unresolved` on stderr, journal ok:true with `resident.status === "disabled"`, spendMicros 0.
- C6 credential-shaped value → exit 2, message names `brief.note`, value never echoed.
- C6 credential-named field (`github_token`) → exit 2, field named.
- C12 quiet-absent control (no witness → no warning, disabled block present) + source-level pin that the catch distinguishes non-ENOENT.
- `spawnRunner` gained an optional extraEnv seam (4th param) to pin `QDS_PI_CATALOG_DIR`; no existing call sites changed.

Reachability note recorded in the test: the C12 "unreadable" warning arm is not deterministically reachable end-to-end because the brief source IS the cap witness and `runContextFrom` refuses a present-but-unreadable witness first; the e2e arm pins AC4's quiet path, the source regex pins the distinguishing branch.
