Known fallout fixed. Now the two remaining baseline failures.
Found the root cause of the dispatch race failure. Wave-1's run-record rewrite (publish-create via `link(2)`) changed the EEXIST's `path` from the record file to the `.tmp` staging file, so dispatch's path-match classifier no longer maps the real race-loser EEXIST to `run-id-in-use` — it falls through to exit-1 `provision-failed`. Fixer-F fitted the two stubbed fixtures to the classifier's old expectation, but the real-store test now exposes the drift. Let me verify my probe conclusion and check the verbs failure next.
The verbs failure is fix-C's C4 contract change (record-read-failed 1→5) landing after these probes were written — that one is mine. Before fixing, let me confirm the dispatch race failure dynamically and read the registry/excuse maps.
Root cause of both remaining baseline failures is now nailed down:

1. **dispatch race**: wave-1 run-record rewrite publishes creates via `link(2)`; the real EEXIST carries `path` = the `.tmp` **source** file, so dispatch's path-matching arbiter classifies the genuine race-loser as exit-1 `provision-failed` instead of exit-2 `run-id-in-use`. That requires a src decision (out of my scope) — will flag.
2. **verbs SAME-set**: fix-C's C4 change remapped `record-read-failed` 1→5 in fleet.ts; the harvest/teardown probe expectations are stale. That one is mine.
Now fixing the verbs baseline failure (stale C4 probe expectations).
Baseline is now green except the dispatch race (src-level issue). Let me verify that and then start the T1 findings. First, T1-1.
Now I'll implement T1-1: replace the `Date.now() + 800` barrier in the four-racer lock test with a marker-file pair-barrier in the child.
T1-1 done (200ms, deterministic). Now T1-2 — strengthen the excused-code tripwire regex.
T1-2 done. Now T1-3 — registry-derived cross-verb flag sweep.
T1-3 done (91 probes over the derived flag list). Now T1-4 — statusRun orphan skippedRecords arm.
Now I'll add the T1-4 test right after the existing orphan test.
T1-5 done. Now T1-6 — a test hanging the GATE step (mirror the abandoned-create pattern).
T1-6 done. Now T1-7 (headroom-failure refusal line) and T1-8 (post-gate dispatch-timeout).
T1-7 and T1-8 done. Now T1-9 (harvest exit-6 also asserts work landed) and T1-10 (vmName not runId).
T1-9, T1-10 done. Now T1-11 (listener-count test — cheap strengthening), T1-12 (synthetic exit-codes pinning).
T1-12 done. T1-11 — listener-count test: add a cheap positive control via child delivery (mirroring the existing child-process signal tests).
T1-11 done. Now the r3b-t-verbs-b additions: safeUrl, sortInstants, recordsSkipped+listUnavailable coexistence, budget-write-lock-timeout (INV-1), and auditor F6.
Now let me add the new status.ts tests (safeUrl, sortInstants, recordsSkipped+listUnavailable) in the statusRun describe.
Now I'll add the three status-row tests plus the INV-1 budget-write-lock-timeout test and F6 composition. Adding coexistence + safeUrl + sortInstants tests after the recordsSkipped statusAll test:
Now adding the budget-write-lock-timeout arm test to the INV-1 describe:
Now the auditor F6 composition test — pin that `listVerbs()` declares no admitted-like flag and that dispatch refuses an undeclared flag.
F6 done. Now the wave-1 pins: F17 (run-id-not-minted), F15 (listTimeoutMs clamp), C6 (SIGHUP). First check what fixers already did.
F17 done. Now F15 — listTimeoutMs > 2^31-1 clamp (statusAll DI seam):
F15 done. Now C6 — SIGHUP delivery test mirroring the SIGINT child test.
Now the remaining LOWs T1-13..T1-18. Let me assess each quickly.
Stable state: 397 pass / 1 fail — only the pre-existing race-classification failure remains (src-level, will flag). Now validation gates.
tests/fleet is biome-clean; the one remaining error is in `src/providers/driver.ts` — fix-D's code (not mine, src is off-limits). Now tsc.
