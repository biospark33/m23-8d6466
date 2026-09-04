# F10 — live E2E tiers 3–5 (7 files)

Branch `fix/df2.10-review-round-6`. Seven files touched, nothing else. No commit, no push.
The live suite was NOT run (real money, `QDS_E2E_LIVE` unset).

Files:
- `tests/fleet/e2e/tier3-race.live.test.ts` (T3.1)
- `tests/fleet/e2e/tier3-manystories.live.test.ts` (T3.2 probes + happy)
- `tests/fleet/e2e/tier3-expose-port.live.test.ts` (T3.3)
- `tests/fleet/e2e/tier3-reaper.live.test.ts` (T3.4a + T3.4b)
- `tests/fleet/e2e/tier3-remote-phases.live.test.ts` (T3.5)
- `tests/fleet/e2e/tier4-resident.live.test.ts` (T4)
- `tests/fleet/e2e/tier5-gate-steering.live.test.ts` (T5.1)

## Fixed

### [HIGH] four single-shot `final-ls` sites → `fleetLeftovers` (and four more converted while there)
All eight box-owning tests now end their `finally` with one line:
`finalBoxes = (await fleetLeftovers(ctx.driver, <owned>, evidence)).owned;`

- T3.4a, T3.4b, T3.5, T4 were the four that had promoted a **single-shot** listing to a
  run-failing verdict against the measured 25 s+ destroy lag. They now carry the 5 × 8 s poll.
- T3.1, T3.2, T3.3, T5.1's in-body hygiene check had hand-rolled 5 × 8 s loops; those are
  deleted for the shared helper (same numbers, same `final-ls-retry` phase) so all eight also
  gain the two halves the hand-rolled loops lacked: **owned survivors are destroyed before the
  verdict**, and the verdict is **scoped to what the run owns** instead of the account.
- The surrounding `try/catch` is dropped at every site, per the harness contract — a catch
  there would swallow the `owned: undefined` that `fleetCleanupProblems` renders as
  "an unmeasured fleet is never a clean one". `strays` is never folded into `problems`.

### [MED] the unconditional account-wide `e2e-|qds-` destroy sweep, at all four sites
The sweep presumed serial execution that only a skill doc mandates. Each site now proves
ownership from its own artifacts rather than from the name prefix:

| site | ownership proof |
|---|---|
| T3.4a | `gate_admissions.run_id` ∪ `sweptRunIds` — the admission COMMITS before `store.create`, so a SIGKILLed dispatch's nameless orphan is still named there. This is the case the account-wide sweep existed for, and it is now covered *provably*. |
| T3.4b, T5.1 | `[runId, vmName]` ∪ every `<id>.json` in this workspace's runs dir — dispatch writes the record before the box exists, and the fleet creates boxes as `driver.create(runId)`, so the record's file name IS the box name. |
| T3.3 | the existing per-box `store.get(vm)` record probe, promoted from "does this owe a revoke?" to "is this ours at all?" — same probe, two answers. |
| T3.1, T3.2 | arm run ids / arm VM names (already identical). |
| T3.5, T4 | `[vm, runId]`. |

A box with no such proof is now a **stray**: warned loudly on stderr + evidence by
`fleetLeftovers`, left alone rather than destroyed. Killing a concurrent round's live box is
worse than reporting it (R4), and a stray is still fully visible.

### [HIGH] T3.4a's `finally` wrapped the WHOLE per-run loop in one `try`
`tier3-reaper.live.test.ts`. The `try/catch` is now **per iteration**, so a truncated
`${id}.json` — precisely what this test's mid-flight SIGKILLs produce — continues to the next
id instead of skipping `teardownQuietly` + `destroyQuietly` for every later admitted run *and*
reddening an otherwise clean round. The `admittedRunIds` sqlite read keeps its own guard
(it produces the list, so it cannot be per-iteration).

### [LOW→ real] T3.4a reads the run record after tearing it down — BOTH loops
New file-local `readVmName(path): {vmName?} | null` (total). Both the in-body attempt-residue
loop and the `finally` loop read a record they have just torn down, guarded only by an
`existsSync` that ran *before* the teardown. An unreadable record is now
`attempt-cleanup-record-gone` / `finally-record-gone` evidence, not a throw. This is also
what makes the per-iteration guard above rarely need to fire.

### [MED] T3.3 built a `RunRecordStore` without the `workspace !== ""` guard
`tier3-expose-port.live.test.ts`. The whole sweep block is now inside
`if (workspace !== "")`. `join("", "runs")` is the relative path `"runs"`, so a run that died
before `tmpWorkspace` returned pointed the store at `$PWD/runs` — and that store is handed to
`revokeQuietly`, which would revoke real keys belonging to **unrelated runs' records**.

### [MED] T5.1 deleted the `try/catch` around `revokeQuietly`
Restored, pushing into `destroyFailures` with a `finally-revoke-error` evidence entry. The
"never throws (#189)" contract does not cover the `new RunRecordStore(...)` constructor or a
driver rejection, and a throw there escapes ahead of `keyLeakProblems`,
`writeEvidenceQuietly` and `settleRun`.

### [MED] T5.1's tamper guard — the porcelain allow-list had holes
`filter(l => l.startsWith("??") || " M" || "M " || "A " || "D ")` → filter on the XY shape
`/^[ MADRCU?!][ MADRCU?!] /` (excluding `!!`), extract with `slice(3)`.
Verified against samples: the measured pass shape still yields exactly
`["__pycache__/", "t5_seed_calc.py", "t5_seed_test.py"]`, the exec's other stdout lines
(`FIX_TEST_EXIT=…`, `JUDGE_SHA256=…`, `seed-test-passed`) still do not match, and the seven
dropped shapes — `MM`, `AM`, `AD`, `RM`, `R `, `" D"`, `UU` — now surface. A rename's
`old -> new` lands verbatim in the set and fails the equality, which is the right answer.
I used the explicit XY alphabet rather than the report's `/^..\s/`: the looser form would
match arbitrary command output on a stream that carries three non-git lines.

### [MED] T4's per-leg budget vs the test timeout — arithmetic now in the file
`3 × LEG_TIMEOUT_MS` is 1_800_000 alone, and dispatch's ceiling was 1_800_000, so the serial
worst case was ≈4.2 M against a 2_400_000 runner timeout — the one abort path where the
`finally` does not run and the leaked box is the resident one.

- `T4_DISPATCH_TIMEOUT_MS = 900_000` (was 1_800_000): T5.1's EB6 audit measured the same verb
  as minutes under 540_000; 900_000 keeps ~2× that margin for the heavier resident manifest.
- `T4_TEST_TIMEOUT_MS = 4_200_000` (was 2_400_000), with the full table in a docblock:
  900_000 + 360_000 (3 × `DEFAULT_EXEC_TIMEOUT_MS` box reads) + 1_800_000 + 300_000 teardown
  + ≈300_000 `finally` = **3_660_000**, leaving 540_000 of margin.
- `LEG_TIMEOUT_MS` is deliberately NOT cut: it is sized off the manifest's `runBudgetMs`
  (500_000), which `--budget-ms 600000` must clear. Cutting it would put the wall clock below
  the engine budget and buy false reds. Raising the runner ceiling costs nothing on a healthy
  round — a leg that fires its OWN ceiling throws into the body catch and the `finally` runs.

### [LOW] `finally-revoke ok:false` folded into the verdict everywhere
All eight sites now pass `evidence` as `fleetCleanupProblems`' third arg. **T5.1's hand-rolled
`revokeFailures` filter is deleted** (not kept beside it) so the round cannot double-report.
This matters most in T3.3, whose sweep revokes boxes that are not in the `runIds` handed to
`keyLeakProblems`.

### [LOW] `rmSync(workspace, …)` was the last unguarded statement of every `finally`
Wrapped at all eight sites (including T3.2's `$0` probes test). `force: true` swallows ENOENT
but not EBUSY/EPERM; a throw there discarded the held `failure` and skipped `settleRun`.
The three forensics variants keep both arms inside the guard — the `process.stderr.write` on a
dead stream throws too.

### [LOW] T5.1's org-rename comment contradicted itself
Re-measured off `_bmad-output/evidence/df3-e2e/2026-09-03-*-t5-1-gate-steering.json`:
`recordSlug` is **`quantum-digital-solutions/qds-factory`**, not `biospark33/qds-factory`.
Comment corrected and the mechanism named (`canonicalRepoSlug` = trim + lowercase,
`src/phase-engine/issue-correlation.ts`).

## False positives

### `store.get(vm)` is never awaited → the ENOENT classification never runs
**Refuted at the source.** `RunRecordStore.get` is **synchronous**
(`src/providers/run-record.ts:1585` — `get(runId: string): RunRecord`, returning
`readRecord(p, runId)`, not a Promise). The bare call's `catch` is reachable and the errno
classification does run. Not patched; instead the synchrony is now **pinned in a comment**
naming the file and line, with the consequence spelled out for whoever makes it async
("this block must gain an `await`, or every swept box takes the revoke path").

### `perIssueOverrides` keys went mixed-case → case-sensitive lookups now depend on the brief
**Refuted.** `capForIssue` (`src/providers/cost-ledger.ts:638`) canonicalises **both** sides —
the lookup via `canonicalIssueKey` and every config key via `canonicalOverrideKey` — so the
match is case-blind. The suite's `"Quantum-Digital-Solutions/QDS-Factory#48"`-style keys are
fine. Recorded in the corrected comment rather than patched.

### T3.1 is the consumer of "a fan-out race no longer returns `null` on a transport blip"
**Not applicable.** T3.1 does not simulate transport loss. It plants a real marker via
`driver.exec` and polls the fan record for `winner !== null` under its own 600 s bound, then
kills the verb and fails with the record snapshot. Nothing expects a null winner. No change.

### `listedKeyHashes` not imported in T3.1/T3.2
Already dismissed as X2 upstream; confirmed present in both. No change.

### `keyLeakProblems` unguarded `await` in seven `finally` blocks
Closed at the callee by wave 1 (`keyLeakProblems` is total). Per the harness report I did NOT
add the per-site `try/catch` the finding asks for. (Wave 1 had already recorded the finding's
stated trigger as refuted; counted there, not double-counted here.)

### [MED] all seven tests removed `throw e` and depend entirely on `settleRun`
Verified, nothing to change. Every one of the eight bodies uses exactly the pinned shape:
`catch (e) { outcome = "fail"; failure = e; evidence.push({phase:"test-error",…}) }` with the
sole rethrow being the post-`finally` `settleRun(failure, [...])`. That matches wave 1's
three-way contract test (`settleRun(err, [])` throws `err`; `settleRun(undefined, ["x"])`
throws; `settleRun(err, ["x"])` throws `err` with the problems attached; `settleRun(undefined,
[])` is the only returning case). No file reaches `settleRun` on a path where `failure` is set
but unthrowable.

### `preflight()` provenance stamp
Checked all eight bodies: every one calls `await preflight("2")`, which calls
`setEffectiveImage` for them. No `setEffectiveImage` wiring is owed by these seven files —
the two that owe it (`tier1-registry-auth`, `tier1-teardown`'s D6) are not mine.

### Grep for surviving `biospark33` literals in fixtures/plans
Swept `tests/ config/ src/ scripts/`. Three hits, none a fixture or a host plan:
`tests/pr/github.test.ts` (a GitHub API login stub, unrelated),
`tests/fleet/e2e/tier1-registry-auth.live.test.ts:21,90` (the operator's real ghcr auth-file
format — correct, and not my file), `src/providers/exedev/driver.ts:241` (a historical note
about a retired pin). No plan or fixture is keyed on the old slug.

## Gates

```
$ bunx tsc --noEmit
exit=0            (zero errors repo-wide — the five build-script errors wave 1 reported
                   have been cleared by their owners since)

$ bunx biome check tests/fleet/e2e/
Checked 21 files in 324ms. No fixes applied.

$ bun test tests/fleet/e2e/
exit=0
 26 pass / 24 todo / 0 fail / 98 expect() calls
Ran 50 tests across 20 files. [2.16s]
```
All 20 e2e files load, wave 1's 26 harness unit tests still pass, and the 24 live tests
register as `todo` (`QDS_E2E_LIVE` unset) — which is everything a non-live run can prove
about the seven files.

All three gates were re-run AFTER a `git stash push`/`pop` round-trip (see the note below)
and are the numbers above.

### `bun test tests/fleet/` — inconclusive, and NOT caused by this change
The broader run stalls: after 6 minutes the log holds nothing but the `bun test v1.4.0` banner.
I checked whether that is mine by stashing **only** `tests/fleet/e2e/` and re-running — the
**baseline stalls identically** (150 s, same single banner line). So it is pre-existing, and
the likely cause is contention with the sibling fixers running against this same working tree
this round (several `tests/fleet/` suites take `.sandbox/fleet.lock`). Reporting it rather
than filtering it out; it is not a gate I can clear from inside my seven files.

### Behaviour I did NOT change, though it is adjacent
`setupGate`'s `ready` now additionally requires `notRun.length === 0`. T3.1 reads that flag
per arm (`.sandbox/setup-gate/<runId>.json`) and already handles the degraded field: zero
ready arms throws with the gate states, one ready arm asserts the single-entrant race in full.
The wave-1 change only makes the degraded branch slightly more likely to be taken; no
assertion in T3.1 assumes `ready: true`.
