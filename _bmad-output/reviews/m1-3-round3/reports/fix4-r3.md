# Round-3 fixer (final wave) — verdict table

Branch `feature/m1-3-recall-measurement-harness`. All 12 assigned findings patched; targeted gates green.

| # | Finding | Fix | File(s) | Verified by |
| --- | --- | --- | --- | --- |
| F1 | `writeP09` `writtenAt: at` bound the module-scope helper (function) — JSON.stringify dropped it; every fixture had NO writtenAt and the writtenAt-wins test resolved via the filename tie-break | `writtenAt: stamp,` (+ comment). Existing distinct-stamp test now genuinely exercises Date.parse epoch ordering; NEW same-stamp test: two ok:true files, identical `writtenAt`, hand-different filenames → lexicographically-LATER filename wins (tie path honestly covered) | `tests/memory/probe-harness.test.ts` | Suite green; both writtenAt tests pass against `probe-schema.ts` F-015 branches |
| F2 | Committed `2026-10-07-interim.{json,md}` pre-round-2, stale-shaped (dataNotes text not producible by shipped code) | Regenerated via `bun scripts/memory/priming-report.ts` (read-only; probe set untouched: 23 seed / 0 cycle before AND after). Provenance sentence added to `_bmad-output/evidence/memory/README.md` | `_bmad-output/memory/reports/2026-10-07-interim.{json,md}`, `_bmad-output/evidence/memory/README.md` | Regression check: all 2 dataNotes strings exist in `priming-report.ts` source (0 missing); `renderReportMd(json) === md` (AC5) |
| F3 | Story record suite count stale (48/48-era) | Recounted FINAL: **59/59** (probe-schema 17, probe-recall 16, priming-report 23, harness-e2e 3); round-3 recount noted; no other stale count lines in the record (grep: only line 119 carried counts) | `_bmad-output/sprint-artifacts/dark-factory-v6/stories/m1-3-recall-measurement-harness.md` | `bun test tests/memory/probe-harness.test.ts` = 59 pass / 0 fail; per-block recount by script (17/16/23/3) |
| F4 | canary-miss test's first statement jammed onto the test() line | Normalized formatting | `tests/memory/probe-harness.test.ts` | biome clean |
| F5 | Header overclaimed "no data → omitted with a dataNote" | Aligned: absent dispatch log omits `dispatchFailures` silently by design (normal pre-first-dispatch state); present-but-unreadable gets the note | `scripts/memory/priming-report.ts` | Header now matches the F-010 code path; existing dispatchFailures test green |
| F6 | Misplaced "Pure renderer (AC5)" comment above `if (import.meta.main)` | Deleted | `scripts/memory/priming-report.ts` | — |
| E1 | Canary-path `mkdirSync(evidenceDir)` could throw past the contracted refusal | mkdir moved INSIDE the guarded region; on failure the canary refusal still returns (reason notes the diagnostic write failure, `diagnosticPath` omitted) + NEW pin: uncreatable evidence dir (file-as-parent → ENOTDIR) asserts contracted refusal, no crash | `scripts/memory/probe-recall.ts`, `tests/memory/probe-harness.test.ts` | New test green; its expected stderr line visible in the suite log |
| E2 | Cost-join outer catch could push "costTable omitted" beside a serialized table on `ledger.close()` failure | Catch now branches on `costTable !== undefined`: close-failure with table present → `cost ledger close failed (<err>) — costTable above is read-complete` | `scripts/memory/priming-report.ts` | Per assignment, no dedicated test (asserted by code review): the only assignment precedes the `finally { close() }`, so the branch is exactly the close-after-success path; all existing cost-join tests green |
| E3 | Torn json/md pair on md-write failure | `previousJson` captured before the json replace; md-replace throw rolls the json back (previous bytes, or rmSync to the absent state) before rethrow — under R2-010's lock | `scripts/memory/priming-report.ts` | Existing pair tests green; AC5 byte-for-byte test green |
| E4 | Present-but-unreadable audit db collapsed to silent 0% coverage | `readReceiptRunIds` returns `{ids, unreadable?}`; caller pushes `audit db unreadable at <path> (<err>); receiptCoverage reported 0`. Absent db stays silently absent. NEW pin: garbage audit.db → coverage {0,1} + note; absent db → no note | `scripts/memory/priming-report.ts`, `tests/memory/probe-harness.test.ts` | New test green |
| E5 | Side-channel file present-but-unreadable indistinguishable from malformed JSON | Read and parse separated in `readSideChannel`; non-ENOENT read failures counted → `N side-channel row(s) unreadable and skipped` note. NEW pin: dir-as-row-file (EISDIR — deterministic, no chmod/root flake) → 2 valid cycles + note | `scripts/memory/priming-report.ts`, `tests/memory/probe-harness.test.ts` | New test green |
| E6 | Empty-concepts guard sat after `seen.add` — second same-domain empty-concepts entry dropped without its recorded failure | Guard moved BEFORE the seen dedupe. NEW pin: two same-domain empty-concepts entries → 2 `empty-concepts-skipped` failures per roster bank, leg fails (F-017) | `scripts/p0-9/provision-and-import.ts`, `tests/p0-9/legs.test.ts` | New test green (2/bank; 3 banks × 2 = 6 total in the failures array) |

## Collateral fix (E6 blast radius, disclosed)

`tests/p0-9/legs.test.ts` had **3 pre-existing failures** (verified failing on the
unmodified tree before my edit): F-017 (round 1) made an empty-concepts mint
failure leg-fatal, but the shared `TMP_CORPUS` fixture still carried the
harmless-when-written M1.1 empty-concepts entry (`qds-test-mint-c`), so every
green-leg assertion in the provision-and-import block went red ("PR-review mint
roster", "happy-path compensation", "mint record"). Fixed in-family: the default
fixture's c-entry now carries a real concept (`delta`) — the empty path is
covered by the dedicated E6 test's own two-empty-entries corpus. Block: 8/8
green after (3 red before).

## Test re-pins summary

- Added: F1 tie-path test, E1 uncreatable-evidence-dir refusal, E4 unreadable-audit-db (+ silent-absent half), E5 EISDIR row, E6 double-empty-concepts (legs.test.ts).
- E2: dedicated test skipped per assignment (close-throw injection would require ledger monkeypatching); fix asserted by the code-path argument above.
- Updated existing pins: none required behavior changes (all 55 pre-existing tests stayed green unmodified).

## Targeted verification (final run)

| Gate | Result |
| --- | --- |
| `bun test tests/memory/probe-harness.test.ts` | **59 pass / 0 fail** (recount: 17/16/23/3) |
| `bun test tests/p0-9/legs.test.ts` (full file, with probe-harness in one run) | 116 pass / 0 fail across both files |
| `bun scripts/dev/verify-m13-e2e.ts` | `M13 E2E OK` (exit 0) |
| `bunx tsc --noEmit` | 0 errors |
| `bunx @biomejs/biome check scripts/memory scripts/p0-9/provision-and-import.ts tests/memory tests/p0-9/legs.test.ts` | exit 0 |
| F2 regression check | json `dataNotes` (2) all present in `priming-report.ts` source; `renderReportMd(json) === md` |
| Real probe set after regeneration | 23 probes / 0 cycle (unchanged — regeneration appended nothing) |

Not run (out of assigned scope): repo-wide `bun test`, `bun run lint` (repo-wide), GitNexus `detect_changes`.
