# Fixer wave 2 (test/verifier/data cluster) — verdict report

Branch `feature/m1-3-recall-measurement-harness`. Owned files touched: `tests/memory/probe-harness.test.ts`, `scripts/dev/verify-m13-e2e.ts`, `scripts/dev/verify-test-slice.mjs`, `_bmad-output/evidence/p0-9-closure/2026-10-07T11-49-36-792Z-*.json` + `README.md`, `_bmad-output/evidence/memory/` (stale file deleted), `_bmad-output/memory/reports/` (regenerated), story Dev Agent Record count line. ONE source exception: `scripts/memory/priming-report.ts` (F-020 only).

## Verdict table

| Task | Done | Notes |
|---|---|---|
| 1. probe() helper origin | Done | Helper emits `origin:"seed"` explicitly; both `toEqual` pins (single-probe parse + parseProbeSet) hold unchanged. |
| 2. F-018 suffix pins | Done | `readArtifact` now contains-matches (`"-hit-rate-"` / `"-canary-failure-"`); `artifactPath`/`diagnosticPath` pins are `/-hit-rate-[a-z0-9]{6}\.json$/` regexes. |
| 3. F-003 hit-rate math | Done | 4-probe test keeps rank/hit pins, asserts `"hitRateAt5" in aggregate === false` + `belowFloor === true`. Rate math moved into the 21-probe median test (5 seeded misses → `hitRateAt5 === 16/21`, `belowFloor` undefined). |
| 4. F-009 0-cycle outcomeTable | Done | New test: absent recall dir + seeded ledger (unrelated runId) → `outcomeTable`/`costTable`/`cycles` keys all absent + `/no observed cycles/` dataNote. Absent-ledger test unchanged (still green). |
| 5. F-012 origin pins | Done | Growth test writes a raw pre-F-012 row (no origin on disk), asserts canonicalJson equality against `{...seedRaw, origin:"seed"}` + appended row `origin:"cycle"`. byOrigin pinned in happy path: `{seed:{probes:20,hits:20}, cycle:{probes:0,hits:0}}`. |
| 6. F-001/F-002 contract tests | Done | Two new probe-recall tests: recall-throws-on-2nd-probe → `{ok:false, stage:"scoring"}` + no artifact; listBanksThrows → stage `label-integrity`, violations `["<listBanks>"]`, zero recall/retain traffic. `fakeProbeClient` gained `listBanksThrows?` / `recallThrowsOnQuery?`. |
| 7. F-010 dispatch | Done | One new test, both scenarios: 3-line explicit `dispatchLogPath` → `dispatchFailures === 3`; directory path → key absent + `/dispatch failure log unreadable/` dataNote. |
| 8. F-020 source exception | Done | `ReportMetrics.cycles?: {runId, primed, receiptPresent, latencyMs}[]` for deduped winners; omitted at 0 cycles with the (extended) "no observed cycles" dataNote; renderer prints one line per cycle. Pins: LEFT-JOIN test asserts `cycles[0].receiptPresent === true` / `cycles[1] === false` (mtime order pinned via utimesSync); 0-cycle test asserts `cycles` key absent. |
| 9. F-025 verifier | Done | `runsDir` dropped from the `runPrimingReport` call; probe fixtures need no origin (schema default fills at parse); added assertions: `cycles` length 5 with receipt flags, `outcomeTable` runs 3/2. costTable (ledger has events) still present, asserted. |
| 10. F-013 verifier hermetic | Done | `auditPath` passed to `runProbeRecall`; `dispatchLogPath` points at an absent tmp path (no real-repo log read). Whole body wrapped try/catch/finally — `fail()` now THROWS (process.exit skips finally blocks, so exit happens after cleanup in the catch→flag pattern); tmpdir removed on every path. Vacuous canary-guard replaced: canary recall must be issued + every non-canary issued query ∈ probe-set queries. |
| 11. F-024 verify-test-slice | Done | Every flag value bounds-checked (undefined/empty/next-flag → usage exit 2, verified by smoke runs); pass/fail tally from LAST regex match (`matchAll(...).at(-1)`); usage text says one value per --file. |
| 12. Story count line | Done | `48/48 (probe-schema 16, probe-recall 13, priming-report 16, harness-e2e 3; 43 red at authoring, recounted after the round-1 review re-pins)` — verified empirically with `-t` filters (16+13+16+3=48; `grep -cE '^\s*test\('` = 48). Red-phase sentence left historical. |
| 13. F-011 redaction | Done | Key `17db6831…ece74` replaced with `<revoked-key-id-redacted>` — 64 occurrences, all in the `11-49-36-792Z` file; the `12-01-42-955Z` file contained neither key (checked, zero occurrences, untouched). Zero residual across `evidence/p0-9-closure/`. README note appended (what/why/when, keys revoked pre-redaction). ⚠ See "handoffs". |
| 14. F-014 stale artifact | Done | `_bmad-output/evidence/memory/2026-10-07T15-51-44-573Z-hit-rate.json` deleted; only the 15-52 artifact remains. |
| 15. Report regeneration | Done | `bun scripts/memory/priming-report.ts` from repo root, exit 0: `cyclesToDate=0`, costTable/outcomeTable/cycles all absent-with-dataNotes (costTable via the F-009 zero-events path — the real `.sandbox/cost-ledger.db` exists but has no events). `dispatchFailures: 57` appears because the real dispatch log exists — the F-010 default-path behavior, expected. |
| 16. Test rename | Done | "existing rows byte-identical" → "existing rows canonically identical" (folded into the F-012 re-pin of that test). |

## Verification

- `bun test tests/memory/probe-harness.test.ts` — **48 pass / 0 fail** (was 36/8).
- `bun scripts/dev/verify-m13-e2e.ts` — **M13 E2E OK**, exit 0, tmpdir cleaned.
- `bunx tsc --noEmit` — **0 errors** repo-wide (true exit code checked).
- `bunx @biomejs/biome check tests/memory scripts/dev scripts/memory` — clean, 7 files.
- verify-test-slice smoke: `--min-pass 48` run OK; `--file`/`--filter` missing-value and no-targets all → usage exit 2.

## Flags for team-lead

1. **priming-report.ts is 526 lines** (was 502 post-wave-1; F-020 added +24) — over the CLAUDE.md 500-line rule. The directive pinned F-020 into this file; extracting the pure renderer to a new module would break the test import path unless re-exported and is outside my file list. Your call whether to extract in a follow-up.
2. **F-011 residual outside my scope**: the same key id also appears in `_bmad-output/reviews/m1-3-round1/reports/blind-hunter.md` and `_bmad-output/reviews/m1-3-round1/chunk-C-data-docs.diff`. Review reports aren't in my may-edit list — redact or leave to your judgment (same revoked key, same hygiene argument).
3. The regenerated report now carries `dispatchFailures: 57` from the real repo dispatch log — that is F-010 working as designed (default path reachable), noted so nobody reads it as a regression.
