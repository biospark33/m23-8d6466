Findings and source loaded. Now checking the cross-module temp grammar (run-lock, read-only), the R5 callers, and running mandated impact analysis in parallel.
Cross-module grammar check plus mandated impact analysis on the hot symbols.
Cross-module grammar confirmed. Now reading the focal test file regions covering lock grace/steal, tombstones, and extension validation — R3/R6 will touch documented behavior.
Code fully mapped. Running the mandated gitnexus impact analyses on the remaining hot symbols (required before editing), in parallel.
All findings located and mapped. Blast radius summary (mandated check): `create` CRITICAL (dispatch/provision/fleet/cap-demo), `releaseLock` HIGH (teardown/approval/dispatch), `setLocked` HIGH, `clearCreateTombstone`/`cleanStaleTemps`/`list` LOW. Changes will be minimal and fail-safe. Quick verification greps before editing.
Design settled. Verifying test fixture temp-name shapes against the planned sweep allow-list before editing.
Reading the tombstone-related tests before editing (they pin exactly the behavior several fixes touch).
Design complete. One cycle-risk check, then batch edits.
Design settled per the fix policy. Now executing the edits in dependency order.
Analysis complete. Key decisions locked in: R1+R8+R11 collapse into one root-cause redesign (temp+`link(2)` create publish — torn final-path writes become structurally impossible, dual-ownership becomes kernel-arbitrated). Now executing edits.
All analysis done. Design locked. Grep the affected-test expectations before writing.
All analysis locked (key decisions: R5 deferred — softening `list()` standalone would weaken the reaper's documented fail-closed refusal and reaper.ts is cluster-K/D territory; R3 deliberate-documented; R1 fixed structurally via link-publish). Executing edits.

**Edit 1 — constants for R12 + allow-list:**
Other fixers are editing this file concurrently (the `resolveRunsDir` change is cluster E's E6). My region is unaffected. Re-reading current state of the functions I'm about to edit.
Now the cleanStaleTemps rewrite (L3-cross allow-list + R4 future-mtime clamp + R12 orphan reaping):
Correction needed: with the trailing `.tmp` segment, pid sits at index -3 in both grammar variants (hex is -2). Fixing.
Bug in my edit order: `.orphan.` names fail `RUN_RECORD_TEMP_RE` (no `.tmp` tail), so R12 reaping is dead code. Reordering so the orphan branch runs before the grammar test.
Now the big structural edit. Checking current createUnlogged text plus remaining target regions in one pass.
Rewriting `createUnlogged` (R1 structural fix + R8 torn-artifact elimination + R11 quiet cleanup):
Publish-create landed cleanly. Now releaseLock R2, stealIfOwnerGone R7, fsyncDir R10, parkAside fix for R9, and assertNoSecret for R6 — reading current regions first since line numbers shifted.
Now R7 (ownerless corpse bound) at the steal-side body parse:
Now R10 (fsyncDir closeSync guard), R9 (restore leaves sweepable bytes — now swept by grammar; but the tombstone-restore EACCES arm still leaves a live-record copy at `.tomb.<pid>.<hex>.tmp`, which IS grammar-matched and would be swept after grace while being possibly-live evidence → park it like the EEXIST arm does). Reading both regions.
Now R10 — fsyncDir's unguarded closeSync:
Now R6 — the length cap backstop on the shape-exempt paths (issue-correlation.ts owns `{1,100}` per segment; the record module mirrors it as a cheap backstop since importing a regex isn't possible without exporting segment counts):
Now R13 — fsync probe in the constructor beside the link probe:
Now R14 — the contradictory docstring on `LEGACY_RUN_ID_RE` (fact: `newId` is the only production mint, `create()` validates strict; caller-supplied ids exist only via scripts/run-record.ts CLI `create <id>`):
All source edits done. Running typecheck and the focal suite.
Three failures diagnosed. Failure 2/3 root cause: I call `beforeRename` inside `publishCreate`, so create-time seam invocations mutate lock paths the tests reserve for set-time — removing that seam call restores the documented seam scope (AC2 targets update writes). Failure 1 is the intentional R1 semantic change (EEXIST now from `link`). The SIGKILL sweep miss needs empirical debugging.
The mode/EEXIST-syscall failures are understood. Verifying the sweep with a genuinely dead pid to isolate the SIGKILL-test failure:
Root cause found: `mtimeMs` carries sub-millisecond precision while `Date.now()` is integral ms, so any just-written temp reads `age ≈ −0.8ms` — my `< 0` guard misclassifies fresh temps as future-dated. Fixing with a real skew tolerance (NTP steps are seconds-scale; sub-ms jitter is noise):
Sweep works. Now the re-entrancy test failure — reading it again to see why removing the create-side seam call should fix it:
One remaining failure is the deliberate R1 semantic shift: exclusive creation now arbitrates at `link(2)` instead of `open(2)` — same EEXIST errno, same no-overwrite guarantee, different syscall name. Updating the test expectation (flagged as a broken-expectation edit per protocol):
All 85 focal tests pass. Running biome + tsc validation:
All green: 85/85 focal tests pass, biome clean, tsc clean. Final verification of the complete changed region set before reporting:
`detect_changes` shows 26 changed files, but only 2 are mine (run-record.ts + its test) — the rest are concurrent fixers' in-flight edits (fleet.ts, run-lock.ts, dispatch.ts, cost-ledger.ts etc.), so the CRITICAL aggregate is expected for the shared branch. My file's changed symbols (`createUnlogged`, `create`, `releaseLock`, `stealIfOwnerGone`, `cleanStaleTemps`, `atomicReplace`) route exactly through the processes my blast-radius pre-check named (provision/dispatch/reap/teardown/approval), and the focal suite covering them passes. Sending the final report.
