Context loaded. Now the mandated impact analysis for the hot symbols, plus discovery greps.
Context mapped. Key discoveries so far: `reapRuns` has ZERO production callers (tier3 recon notes the active reaper is `scripts/sandbox-reap.ts` → `sweep()`), and the D1 throw is S15-contract pinned in three test files. Now reading the remaining seams I need before editing.
Blast radius checked: `reapRuns` upstream = LOW/exact, `checkHeadroom` = CRITICAL (dispatch, fanout, fleet CLI, cap-hit-demo all route through it — will flag). Running the remaining mandated impact queries plus targeted greps before touching anything.
Full picture forming. D1's throw is story-pinned (df3-1 story + DF3.2 playbook) and three tests assert it — checking remaining seams before deciding classifications.
All contexts gathered. Baseline-test before editing.
Baseline green (96 pass ×2 — first run's lone fail was a flake). Findings classified against main. Now implementing, starting with D3 (quota.ts).
All findings located and classified. Editing now — driver.ts first (D5, D2, D14, D15, D7, D8, D16).
Now D2 (swallowed rollback failure → structured log + classified rethrow) and D14 (actionTimeoutMs validation).
Now D15 (neverPublicDriver forwards listWithAnomalies) and D7/D8/D16 (the reap loop).
D15/D7/D8/D16 done in driver.ts. Now K4 — the sweep predicate in reaper.ts (production path, unlike `reapRuns`).
All classifications settled. Key insight for K4: every id `newId` ever minted (old builds included — slug + `-YYYYMMDD-hex` suffix) matches `RUN_ID_SHAPE`; `LEGACY_RUN_ID_RE`'s added acceptance covers only non-generated names, i.e. exactly the co-tenant space. So requiring record-corroboration solely for the legacy arm costs nothing real and closes K4 completely. Now implementing the remaining fixes — D9/D10 in setup-gate, D11/D6-comment in fake-driver, D12/D13 in exedev/driver.
Now D10 (requestId non-string fallback).
Now D12/D13 in exedev/driver.ts — bounded stringify and redacted vmName.
Now D11 — FakeDriver contract-shaped errors (readMeta / create-EEXIST).
Now D6 — restore the 63-char cap semantics in FakeDriver listing. `assertExistingRunId` already enforces ≤63 + legacy grammar, so a >63-char dir now lands in `skipped` → fails the whole fleet reap, where the old code silently ignored it. Run-record owns the constant; importing it is clean.
That edit is redundant — `assertExistingRunId` already rejects `length > RUN_ID_MAX`, so the over-long case already lands in `skipped` today; my branch adds nothing. Reverting it.
FakeDriver reverted cleanly (no stray block). D6 verdict confirmed by verification: `assertExistingRunId` enforces BOTH the ≤63 cap (`id.length > RUN_ID_MAX` at run-record.ts:339) and the legacy grammar — so an over-long dir already lands in `skipped` on main, and listing admits exactly what `boxDir`'s destroy accepts. The drop-to-anomaly change was the deliberate anomaly-channel work, not drift.

Now D3 — routing `checkHeadroom` through the anomaly channel. quota.ts cannot import driver.ts (D4 cycle rule), so the listing shape rides structurally.
Both drivers implement `listWithAnomalies`, so production gates now route the anomaly channel; structural test stubs without it keep the old path. All source edits done. Validating — biome, tsc, focal tests.
Biome clean, tsc clean. Focal tests.
K4 conflict surfacing exactly where expected: the test pins pre-K4 behavior (tagged legacy-name record-less → destroy). Before touching tests, verifying my reasoning that record-corroboration preserves the anti-stranding intent — a genuine factory box always has a record (INV-1 writes it before the box).
The failure is the sanctioned K4 consequence: a tagged legacy-shaped name with NO record is now report-only (fail-safe). The test pinned pre-K4 semantics. Minimal expectation update, flagged for the lead.
Dispatch tests bind a real `FakeDriver`, so `checkHeadroom` now takes the anomaly channel; their `driver.list` monkeypatches no longer sit on the production path. Examining all three before touching anything.
All three failures are the same legitimate consequence of D3: those tests stub `driver.list`, but with the D4-cycle-safe channel added, `checkHeadroom` now reads `listWithAnomalies` (real FakeDriver provides one). Updating the stubs to sit on the new path — flagged as test-side changes driven by the source fix.
The stash bisect shows the LOSER-race test failing WITHOUT any of my cluster-D changes — it's interference from other fixers' concurrent edits (dispatch.ts carries 255 inserted lines from fix-F). Verifying INV-4-bis the same way.
Stash verified restored (remaining stashes are pre-existing artifacts, not mine). Both remaining failures reproduce WITHOUT my changes — they're breakage from parallel fixers' dispatch.ts work (fix-F owns that file), not cluster-D regressions. Confirming current state and finishing validation.
Detect-changes reviewed: the CRITICAL aggregate spans all 24 branch-touched files including parallel fixers' work; my cluster-D symbols (`reapRuns`, `checkHeadroom`, `isReaperOwnedVm`, `provisionAdmittedRun`, `rosterModels`, `setupGate`) match exactly the intended scope. One last tightening — r1-blind finding 9 (bare fs-error rethrow after successful rollback, adjacent to D2):
