Clean tree. Now reading fleet.ts (2531 lines).
All 2531 lines mapped. Now the support libs: run-lock.ts, cli-args.ts, status.ts's record-read-failed/skippedRecords treatment, and the ExitStatus type.
Now the supporting details: `assertReadable`, `log()` typing, `renderHelp`, and the status.ts orphan treatment.
Full picture assembled. All findings live except C12 (round-10 already normalized the alias). Before editing, running GitNexus impact per CLAUDE.md on every symbol I'll touch.
All findings located in current main; C12 verified already fixed by round-10 canonicalization. Impact: all LOW risk (contained in `scripts/fleet.ts:run()` flow). Checking test expectations that my changes could trip before editing.
Supporting checks: FleetError shape (does it carry attachable exitStatus?), the listener-count test around line 3663, and the chmod-related tests at 3274-3349.
Impact checks done (all LOW, contained in `scripts/fleet.ts:run()` — authorized to proceed). Final pre-edit reconnaissance: observingMint consumers, verbs.test help expectations.
Two decisions need consumer scans before editing: EXIT_STATUSES widening (C13) and the timeout constant placement (C9).
Now checking the two remaining test regions that constrain my edits (help-loop expectations at 696, and the 130/143 child-spawn test).
Read `tokenizeArgs` contract (needed for C8) and confirm nothing pins `EXIT_STATUSES` exhaustively.
Supporting checks: does the corrupt-record error carry an errno code (would affect C3)?
Design finalized. Quick collision check for C3 (errno-coded throws expecting exit 1), then edit.
Full analysis done; before writing code I need two test regions that constrain C2's lock design (the mutual-exclusion test at 2700 and the SIGINT-child test details).
Analysis complete. Now implementing. First hunk: C1 (SIGHUP-independent false-refuse on `--brief` + pipe/socket).
Also update the earlier rationale paragraph (lines 767-774) that says sockets are dangerous — keeping a self-contradicting comment would be the drift.
All 12 findings mapped to concrete edit sites. Key discovery: C4/C12 partly differ from the findings' premises on main. Now editing — C3 first (errno classification in `report`).
C4 reality-check against main: `getRecord` (harvest.ts) already wraps failures in a typed `HarvestError("record-read-failed")` with remediation — the finding's "bare Error" premise is stale, but the CC-9 line still stamps `transient` and the envelope never names a recoverable box. First, fix my C3 hunk (I created a double-print):
C4 needs care: the CLI's own exit-code table matters here, and status.ts chose 1 while the doctrine points elsewhere. Checking each verb's declared exitCodes and the statusRun ordering:
Key discovery for C13/C7: `LogEntry.exitStatus` rides an index-signature (`[k: string]: unknown`) — the type constraint is purely local to fleet.ts's `logVerb` parameter. So "signalled" needs no cli-anything widening; a local union suffices. Applying C2/C4/C5 next (the harvest/teardown + dispatch block).
Now restructure the store construction (C5) — change `const store = ...` to a `let` assignment:
Typo in the path — retrying with the correct one.
Restructuring properly — replace the botched else-branch with the create:false probe-store approach per instructions:
Now the dispatch block: C6 (SIGHUP), C2 (lock across the mint window), C13 (exitStatus "signalled"), with handler-path lock release.
The `as ExitStatus` cast is dishonest — widening the parameter type properly instead:
Now C2's acquire point — after `store.create` (the mint) through key persist + ack. The mint hook is `observingMint`. Reading the current dispatch flow to place it:
Now C8 (`fleet help` validation) and the still-active else-branch from my earlier partially-rolled-back edit. Checking for leftover fragments:
Clean. Now C8 — validate argv on the `fleet help` path while preserving exit-0 help for bare `help`:
The help-block throws land outside any catch — they'd escape as exit 1 raw stack. Wrapping them to produce the standard envelope + CC-9 line:
C8 + C11's first half done. Now C11 (help emit outside try) — wrap both help emits with the EPIPE-tolerant path. Checking what protection exists: `emit` already tolerates EPIPE/EAGAIN; the risk is ENOSPC/EBADF throwing out of the two help paths.
Now C9 — stdin brief read timeout. And C10 — skippedRecords bound/redact. C9 first:
C10 — bound+redact the skippedRecords echo in the status envelope:
Need the imports for `sanitizeLabel`/`MAX_DIAGNOSTIC` — both are private to status.ts. Checking what's exported:
Now C7 — interrupted harvest/teardown CC-9 line. The signal path lives in run-lock.ts's re-raise; wiring a verb-context callback into `releaseHeldRunLocks` is the small version. First, look at what the re-raise path can see:
C7 next — wire an interrupt-reporter hook into run-lock.ts's signal path, registered by the harvest/teardown block. First fix my stale comment in the mint block:
Now C7 in run-lock.ts — an interrupt-reporter hook that fleet.ts's harvest/teardown registers, so the signal path emits the verb's CC-9 line before the re-raise:
Other fixer agents are active in this shared tree (dispatch-b already editing run-lock.ts, +303 lines). My read of the file is stale. Re-reading the region around `releaseHeldRunLocks`:
run-lock.ts is being actively rewritten by another fixer agent right now (file grew 983→1156 lines mid-session, contains partial-edit markers). Touching it would stomp concurrent work — so C7 lands entirely in fleet.ts instead: an additional signal listener installed while the verb holds the lock. Since run-lock's own handler snapshots-and-restores `process.listeners()`, my handler survives the unwind and emits the CC-9 line before the default disposition terminates the process.
The inline arrow wrappers can't be removed later — keeping references:
The listener type is awkward — `process.on(SIG, cb)` wants a specific signature. Simplify:
Now the removal in the harvest/teardown finally:
My edit dropped run()'s closing brace. Restoring:
Also remove the dispatch handlers correctly — check the listener typing there compiles. Now typecheck:
The `signalListeners` is declared inside the try (line 2412) but referenced in the finally — out of scope. Move the declaration to the hoisted-let block:
tsc clean. Now biome:
Now the focal tests — first the targeted regions my edits touch:
Expected: that test pins the OLD behavior (socket refuses). The fix changes the contract — per instructions, update the test and FLAG it. Reading the assertion rows:
That's C13's contract change — the test pinned the old `logic` stamp. Update it to pin `"signalled"` (FLAG as test-contract update):
C4's contract change: 1 → 5. Updating the pinned expectation (FLAG):
Timeout (not assertion) — checking whether this is my change or concurrent in-flight work from the other fixer agents:
Passes on clean tree. Narrowing which of my hunks causes it — most likely the C9 stdin timeout (the fanout verb reads a brief via `deps.readBrief`... no, injected). Actually: fanout calls `ingestBriefJson` with an INJECTED readBrief, so readCappedStdin isn't hit. Checking whether it's the C9 hunk at all by testing just that region in isolation:
Deterministic hang with my diff. The hang path: fanout → `ingestBriefJson` uses the INJECTED readBrief... unless it doesn't. Tracing:
The fanout path never enters dispatch/my hunks except `report`. Other agents concurrently modified quota.ts/driver.ts — bisecting: revert only my fleet.ts while keeping others' src changes:
Isolated conclusively: **HEAD fleet.ts + fixer agents' src/ changes → hangs; my fleet.ts + HEAD src/ → passes.** The hang comes from another agent's src/quota.ts or driver.ts change, not mine. Verifying my restored file is intact, then finishing validation:
The failing pairings isolate cleanly: fixers'-src fails with BOTH fleet.ts versions; HEAD-src passes with both. The hang comes from another agent's `src/` change intersecting this test. Pinning which file for the report:
All fixes are in place and validated. Final verification summary, then reporting to the team lead.
Cluster C complete. All 13 findings resolved in `/Users/steve/QDS-Factory/scripts/fleet.ts` (plus 3 flagged test-contract updates in `/Users/steve/QDS-Factory/tests/fleet/cli.test.ts`):

- **12 FIXED**: C1 (socket false-refuse), C2 (dispatch key-mint lock window), C3 (permanent errno classification), C4 (corrupt-record → exit 5), C5 (create:false probe store), C6 (SIGHUP + 129), C7 (interrupted harvest/teardown CC-9 line), C8 (`fleet help` argv validation), C9 (120s stdin brief timeout), C10 (skippedRecords bound+redact), C11 (help emit envelope), C13 ("signalled" exitStatus)
- **1 POST-MERGE-CHANGED**: C12 (-h/--help dup guard already fixed in round 10)

Validation: tsc clean, biome clean, focal suite 139/140 — the single failure is proven (by stash-bisect) to originate from another fixer agent's concurrent `src/providers/quota.ts` change, not this cluster's edits. No commits made.
