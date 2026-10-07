# M1.2 review round 1 triage (driver, 2026-10-06)

## FIX (this round)
- F1 [HIGH×2 conv] writeRecallRow traversal: charset/length guard on runId before filename use (kg-context).
- F2 [HIGH conv] in-box kgContext re-validation: brief-schema exports predicate+strip (class extended: Cc-minus-\n\t, Zl, Zp, DEL); pipeline-run render DROPS non-well-formed kgContext fail-closed (degrade, not crash — grounding is best-effort).
- F3 [HIGH conv] producer charset guard: kg-context assembly strips refused code points from observation text using the same brief-schema helper (poisoned bank degrades, never exit-2).
- F4 [HIGH live] L3 hollow-leg guard moved inside try (finally always cleans armed resources).
- F5 [MED×3 conv] recall query: coerce numeric issueId (workId ?? String(issueId)).
- F6 [MED] client.retain refuses wire success===false (HindsightHttpError 502) before the success view.
- F7 [MED] twin parity: same structured codes (retain-skipped vs retain-failed) + same redaction posture both twins.
- F8 [MED] buildRetainPayload bounds bundlePath (string, ≤512, no control chars).
- F9 [MED] best-effort catch hardened: String() before redact, skipLine/log wrapped — helper can never throw.
- F10 [MED live] L1 fallback proves real skip-on-replay (actual second retain attempt through the ledger + recall unchanged; no fabricated counts).
- F11 [MED live] harness emittedRunId skips kg-recall lines (root fix in live-harness.ts, improves all consumers).
- F12 [MED] AC4 payload: populate bundlePath if trivially available at call sites; cost µ$ deferred → amendment R6 (ledger join is A5/DD-20 scope).
- F13 [MED] side-channel keyed on brief requestId pre-mint → amendment R5 (row keyed on the seam-available correlation id; absent requestId = uncounted cycle, documented).
- F14 [LOW] missing requestId → retain-skipped (parity with repoSlug), not retain-failed.
- F15 [LOW] recall-row write atomic (temp+rename); requestId reuse = documented last-wins.
- F16 [LOW] retain to a bank ABSENT from the live list → retain-skipped (memory never provisioned for repo).
- F17 [LOW] 10s wall cap on both retain twins (bounded teardown dwell; timeout → retain-failed line).
- F18 [LOW] deriveDocumentId non-string message uses String(runId).
- F19 [LOW] emitAndReturn's log() wrapped (never-throw contract independent of sink).
- F20 [LOW] tags schema-owned: RetainExtensionSchema gains tags (z.array(z.string()) optional).
- F21 [LOW] RetainPayloadSchema aligned to the body the client actually sends (bank_id only where real).
- F22 [LOW] brief-schema class comment corrected (guard runs host-side; box side now re-validates via F2 — substance fixed, comments aligned).

## DISMISS (with reasons)
- D1 divergent-content alarm on changed re-harvest: story AC6 mandates it BY DESIGN ("same documentId + mutated content is exactly the anomaly"); siblings (A5, M3.2) build payload determinism on the same contract. Behavior correct; L3 non-divergence assertion unnecessary.
- D2 ladder-(b) banks:[] on pre-recall failure: truthful (zero banks attempted recall); error detail rides the log line; row shape is M1.3's fixed 7-key contract.
- D3 head-truncation evicting kgContext: steering.ts owns the prompt ceiling (pre-existing design; DD-22 measures grounding quality); out of M1.2 scope, grounding is best-effort by charter.
- D4 AC7 unfired: known-pending (T2 execution phase; image re-publish is ops-gated) — honestly recorded in Dev Record + sprint status, not a code fix.

## AMENDMENTS
- R5: side-channel row keyed on the brief's requestId (the correlation id available at the seam, pre-mint); briefs without requestId produce no row (uncounted cycle — documented for M1.3).
- R6: AC4 payload cost µ$ deferred (ledger join = A5/DD-20 scope); AC5 "both adds-only" wording corrected — the conformance slice is a measured restructure coordinated under #408 (legacy views preserve all consumers).
