# Fix D — e2e cluster (PR 135 review round 2, wave 2)

Scope: `tests/phase-engine/resident-e2e.test.ts`, `tests/phase-engine/fixtures/fake-resident.ts`,
`tests/phase-engine/fixtures/pipeline.resident.json`, `tests/phase-engine/fixtures/pi-catalog/openrouter.json`,
`tests/phase-engine/usage.test.ts`, and the one flagged test in `tests/phase-engine/dispatch-task.test.ts`.

## Verdict table

| Item | Verdict | Notes |
|------|---------|-------|
| D1 host models.json | fixed | `QDS_PI_MODELS_JSON` pinned to a nonexistent path inside the per-leg dir in `spawnRunner` env. ENOENT → sanctioned empty custom registry (validate.ts:358-359). |
| D2 TMPDIR divergence | fixed | `TMPDIR: <leg dir>` in `spawnRunner` env; `stateFile(dir)` derives from the SAME leg dir (single source of truth, D2's own requirement); `rmSync` of the counter both before the run and in `runLeg`'s `finally`. |
| D3 orphaned proc / undrained stdout | fixed | `runLeg` awaits in `try`; `finally` SIGKILLs the proc when it has neither exited nor signalled; stdout drained alongside stderr in the `Promise.all` (kept draining rather than `"ignore"` — nothing asserts stdout, but a full pipe can no longer deadlock the runner's own stderr writes). `--budget-ms` lowered to 50_000, WITH the fixture's `runBudgetMs`/phase ceilings lowered to match (fixture is only consumed by this suite) — `loadManifest` refuses a caller budget below the manifest's declared budget, so lowering the flag alone fails all legs at load time. |
| D4 arming negative control | fixed | New leg `arm-negative`: `--request-id` still on argv, witness still satisfies the cap reader (`effectiveCeilingMicros: 250_000`), but the brief carries NO identity field → journal `resident` block asserted as the exact explicit disabled shape and zero `resident_solicit` stderr lines. (Reviewer's literal "content-free witness {}" would fail the cap reader first; the closest legal control is a witness minus identity fields.) |
| D5 steering.ts division pin | fixed | Exempted file now scanned separately: exactly 2 `/ 1_000_000` occurrences asserted (the meter's two terms — input and output; verified against the wave-1 source through the code-only blanker). |
| D6 telemetry exitCode | fixed | `expect(steered.exitCode).toBe(0)` is the first assertion after the leg. |
| D7 spendMicros type-only | fixed | Now exact: fixture usage 1000/64 tokens × 80_000/180_000 µ$/MTok → 92 µ$ per call, 3 calls → `toBe(276)` (comment derives it). Deterministic under the pinned catalog + ENOENT registry. |
| D8 directive partition | fixed | demo leg: `directives === 3` and `directivesRejected === 0`; roster leg: sum `=== 3` asserted alongside the 2/1 split. |
| D9 degraded-path e2e | fixed | New leg: `FAKE_RESIDENT_EXIT="3"` → `status:"degraded"`, 3 solicit lines all `directiveAction:"proceed"`, unguided retry passes, `exitStatus:"logic"` (wave-1 B6), run exit 0. NOTE: the exit-3 fixture kills EVERY call, so degradation lands at run_start — directives/spend are 0, not 1/92 (empirically probed; the reviewer's "one accepted then degrade" shape is not reachable with this fixture knob since the exit code is per-process, not per-invocation). |
| D10 fake-resident clobber/index shift | fixed | `process.exitCode` only set from `FAKE_RESIDENT_EXIT` when not already set (missing `-p` keeps its 2); invocation marker append moved BEFORE the hang check (a hung attempt consumes its slot). Empirically verified: missing `-p` → exit 2; normal → 0. |
| D11 redaction actually asserted | fixed | `REDACTION_PROBE` ("sk-fake-e2e-redaction-probe-000000") set as `OPENROUTER_API_KEY` on the demo leg; all 6 persisted prompt/reply artifacts asserted not to contain it. Brief carries no credential-shaped value so INV-RES-3's refusal is not triggered. |
| D12 timing allowlist | fixed | `TIMING_KEY_RE` suffix pattern (`Ms$|MS$|(^|[^A-Za-z])ms$|(At|_at)$|^at$|^subTimings$`) replaces the hand-closed set; validated against every timing key the journal/runner emits (incl. `_ms` sub-timings) and every legitimate journal key (`phaseId`, `items`, `phases`, …) — none over-stripped. |
| D13 retry-authorization negative | fixed (pinned the REAL semantics) | A witness with `effectiveCeilingMicros: 0` is refused by `admittedCeilingBeside` (positive-integer requirement) BEFORE any phase: exit 2, refusal text asserted, journal is the FileJournal constructor's header-only residue (`ok:false`, no phases/events, no resident block). The retry loop is never reached — the refusal, not a no-retry run, is the authorization boundary the wiring actually enforces. |
| D14 journal read failure | fixed | `runLeg` wraps read+parse; on failure throws with exit code + last 2000 chars of stderr (and the `cause`). |
| D15 jsonLines filter order | fixed | `jsonLines` keeps only rows with a string `event` (relayed child JSON — e.g. the runner's own phase log lines — has none), and point filtering happens in `solicitsAt` BEFORE `.find`/destructure. |
| D16 `exit 1` substring | fixed | `/exit 1\b/` match. |
| D17 arming `>= 2` | fixed | `toBe(3)` (all three engine-owned points on an armed leg). |
| D18 walkKeys/segmentsOf canary | fixed | `segmentsOf("costRatio")` must flag `ratio` before the walk runs; a broken splitter fails loudly. |
| D19 0600 portability | fixed | `(mode & 0o077) === 0`. |
| D20 toEqual + stable() redundancy | fixed | `stable()` deleted; single `toEqual` deep comparison kept. |
| D21 stripped() depth | fixed | `resident` key stripped at TOP LEVEL only (`stripped(value, top = true)`); timing keys still stripped at every depth. |
| D22 catalog cacheWrite | fixed | `0` → `0.018`, matching `tests/fleet/resident.test.ts` TEST_SOURCES. |
| C2 (directive expectation repoint) | fixed | Demo leg no longer expects `resident_directive` in `gateEvents`; gateEvents asserted as exactly `gate_fail(1)` → `gate_pass(2)`, and the directive is read from `<run-root>/trace/events.jsonl` (`type:"log"`, `name:"resident_directive"`, payload `action/guidance/attempt/phase` asserted). |
| C11 (dispatch_task testCommand) | fixed | Test flipped to assert schema rejection, naming the exact issue message `testCommand is forbidden when kind is 'dispatch_task'` (matches manifest.ts superRefine). |
| C5 (RateError → disabled) | already covered | `tests/phase-engine/pipeline-run.test.ts` owns it; no e2e work needed. |
| B6/B7 exitStatus | n/a | e2e is type-tolerant (`exitStatus: string \| null`); the new degraded leg pins `"logic"` e2e. |
| B4 QDS_RESIDENT_TIMEOUT_MS | n/a | Source-only change; no e2e assertion needed (timeout knob is fleet-suite territory). |

No source changes made (`src/`, `scripts/` untouched by this agent). No false positives found — every D1-D22 item reproduced as described or pinned the real (differing) semantics with evidence.

## Notable empirical findings (pinned, not changed)

1. `loadManifest` refuses `--budget-ms` below the fixture's own `runBudgetMs` and refuses a manifest whose
   `(retries+1) × (PARSE_FIX_ATTEMPTS+1) × maxDurationMs + routing` exceeds `runBudgetMs` — so D3's "budget below
   test timeout" required lowering the FIXTURE's budget/ceilings, not just the flag. The fixture is
   resident-e2e-only (grep-verified).
2. D9: `FAKE_RESIDENT_EXIT` is process-global for the fake, so a degraded resident has 0 accepted directives and
   0 spend, not "one accepted then degrade". Assertions pin the reachable semantics.
3. D13: the zero-ceiling refusal happens before `FileJournal`'s phases; the residual `out.json` is the
   constructor's header flush (`ok:false`, empty phases/gateEvents, no `resident` key). That exact shape is asserted.
4. Relayed child JSON on stderr (the runner's own phase log lines) parses as JSON and has NO `event` field —
   `jsonLines` keys on `event` being a string, which is what makes D15's filter-before-find correct.

## Residual flakes observed

None in 4 consecutive full-suite runs (9/9 each). The suite is now host-independent: no `~/.pi` read (D1), no
global-TMPDIR counter (D2), budget-bounded runner with hard kill backstop (D3).

## Verification

```
bun test tests/phase-engine/resident-e2e.test.ts   → 9 pass / 0 fail / 76 expect() (×4 runs)
bun test tests/phase-engine/usage.test.ts          → 12 pass / 0 fail / 28 expect()
bun test tests/phase-engine/dispatch-task.test.ts  → 39 pass / 0 fail / 97 expect()
bunx biome check <6 touched files>                 → Checked 6 files. No fixes applied.
bunx tsc --noEmit                                  → clean
safety nets: bun test tests/phase-engine/          → 656 pass / 0 fail (22 files)
             bun test tests/phase-engine/steering.test.ts    → 38 pass
             bun test tests/phase-engine/pipeline-run.test.ts → 40 pass
             bun test tests/fleet/resident.test.ts           → 26 pass
```
