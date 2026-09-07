Reading done. Now locating the supporting definitions and callers before editing.
Sources mapped. Now gathering the remaining facts I need before editing.
Full picture in hand. Remaining pre-edit checks: extensions whitelist (F9), CLI dispatch call shape (F17), test expectations around the paths I'm changing (F12/F17), and tsconfig strictness.
Now verifying which behaviors tests pin, to keep wave-2 surprises visible.
Impact checks done for two anchors. Running the rest, plus reading the test regions that pin the empty-array and EEXIST behaviors I'm about to change.
Now checking final test pins before editing.
Analysis complete. Checking the ledger's public surface for F8 before deciding, then editing.
Analysis complete. Key discoveries shaping the fixes:

- **F1** is **POST-MERGE-CHANGED**: `extractZodErrorField` now routes through `sanitizeLabel` at the producer (brief-schema.ts:462/470), stripping control chars before the leaf ever reaches the payload — exactly the threat F1 describes, closed post-merge.
- **F8**: cost-ledger.ts's own contract (lines 1147-1156) states no caller may ever release a reservation; releasing needs a ledger-side losing-admission rule. That file is another fixer's cluster — DEFERRED.
- **F9**: the record already persistently holds BOTH figures (`rec.limitMicroUsd` from the mint vs `extensions.budget.admittedCeilingMicroUsd`) — over-mint is derivable from disk already; another field would be redundant. Plus `EXTENSION_NAMESPACES` lives in run-record.ts (another fixer's file).
- **F2** confirmed precise: only two sites compute `now() - wallStart` OUTSIDE a try (refuse:856, logAbandoned:1120); all the standalone `log({...})` calls already evaluate args inside their try.

Applying the fixes now.
Now the four targeted edits to `refuse`'s helpers and body.
The nested function placement is awkward. Restructuring `redact` cleanly with a helper.
Now F13 (constant-derived KiB text), F5 (assertFleetRunId classification), and F17 (mintRunId registry).
Now F13 in the roster block, plus the KiB constant, and F2/F11 in `refuse`.
Now F2 (the two unguarded clock reads) and the payload edges inside `refuse`.
Now F17 (runtime registry check in step 4), F10/F11/F12/F14 in the dispatch body.
All F17 checks pass. Now the F11/F10/F14/F12 edits inside the dispatch body. First, registering refusals in `refuse`:
Now the gate-failure call site has the same empty-array suppression.
Now F10 (main-path expose type guard), F11 (rethrow arms), F12 (pathless-EEXIST).
The edit landed at the wrong anchor. Fixing the placement properly.
Now F11 (the two rethrow arms that assume logging) and F12 (pathless EEXIST).
Now F12 — reclassifying the pathless EEXIST arm as retryable.
Now status.ts: F15 (timeout clamp) and F16 (bounded skipped-filename join).
All source edits are in. Typechecking now.
Typecheck clean. Biome + focal tests.
Analyzing the five failures before adjusting.
The failures cluster into two causes. Investigating the EEXIST ones first — checking whether the real store's error keeps `.path` through `provisionAdmittedRun`.
Two stable failures — both pin the OLD pathless-EEXIST mapping that F12 deliberately changes. Verifying baseline flakiness of the run-1 extras first.
Baseline is clean, so the failures are mine. The stable pair pins F12's old mapping. First re-running to confirm scope before deciding whether these are true conflicts or order-dependent.
Stable result across three runs: exactly the two stubbed-EEXIST tests fail, both pinning F12's OLD pathless mapping. The real store always sets `.path` (probed above), so a faithful race-loser fixture carries the record path. Updating those two fixtures to match the arbiter's actual shape — flagging for wave 2.
All 128 pass. Now the verbs suite (status coverage).
Both adjacent failures reproduce identically on the unmodified baseline — they're pre-existing (one times out; the other is the CLI stdin-refusal contract owned by Cluster C). Not mine; flagging to team-lead instead of touching them. Final gate checks now.
All gates green. Final report to team-lead.
Cluster F complete. Report delivered to team-lead.

**Files changed:**
- `/Users/steve/QDS-Factory/src/fleet/dispatch.ts` — F2, F3, F4, F5, F6, F10, F11, F12, F13, F14, F17
- `/Users/steve/QDS-Factory/src/fleet/status.ts` — F15, F16
- `/Users/steve/QDS-Factory/tests/fleet/dispatch.test.ts` — 2 fixture updates (pathless-EEXIST stubs → path-carrying shape), flagged for wave 2

**Scorecard:** 12 FIXED · 1 POST-MERGE-CHANGED (F1) · 3 DEFERRED with named follow-ups (F7 quota-layer, F8 ledger-side release, F9 redundant with on-disk evidence). No false positives found.

**Validation:** dispatch.test.ts 128/128, verbs.test.ts 77/77, biome clean, `tsc --noEmit` clean. The two adjacent-suite failures (cli stdin-refusal, fanout transient-timing) reproduce identically on the unmodified baseline via stash-test — pre-existing, not from this cluster.
