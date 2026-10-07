# Edge Case Hunter — M1.3 round 2

Scope: diff hunks in chunk-A/B/C as they now stand on `feature/m1-3-recall-measurement-harness`; paths traced into `scripts/lib/run-lock.ts`, `src/providers/fs-atomic.ts`, `src/providers/cost-ledger.ts` (`CostView.hasTokenRows`/`hasEvents`), `src/audit/link-store.ts` (DELETE journal, never WAL), `src/hindsight/kg-context.ts` (`RecallRow`), `src/fleet/dispatch.ts`. Only unhandled/mishandled paths; handled ones discarded.

---

## 1. costTable prints misleading $0 for observed cycles; the F-009 all-zero omission guard is dead at >0 cycles — HIGH

- **file:line:** `scripts/memory/priming-report.ts:134-142` (`costGroup`), `scripts/memory/priming-report.ts:351-358` (zero-omission guard)
- **Trigger:** ledger file exists but holds no events for the observed side-channel runs (ledger rotated/recreated while `_bmad-output/memory/recall/` persists across the 30-cycle window), OR a cycle's token rows landed only as `unpriced=1` / box-hours (the ledger's own documented "tokens-not-harvested" state).
- **Current behavior:** `costGroup` sums only `readRunCost(...).totalMicroUsd` and sets `runs` from the side-row count, so the guard `costTable.primed.runs === 0 && costTable.unprimed.runs === 0 && total===0 && total===0` can never fire when `cyclesToDate > 0` (runs are always > 0 there). The report then prints `totalMicroUsd: 0` under an "exact integer micro-usd" heading for cycles whose cost is unknown — exactly the "comforting 0" the F-009/F-010 doctrine and the committed evidence JSON forbid. `CostView.hasEvents` / `hasTokenRows` / `unpricedRows`, which exist precisely to distinguish these states, are never consulted.
- **Expected behavior:** per run, branch on the `CostView` fields: `hasEvents === false` → the cycle's cost is absent (note or exclude from the total with a dataNote); `hasTokenRows === false || unpricedRows > 0` → the total is partial (dataNote naming tokens-not-harvested). Only a fully-priced zero may print as 0.

## 2. Unreadable/absent-as-file recallDir collapses to a silent zero-cycle report — MEDIUM

- **file:line:** `scripts/memory/priming-report.ts:66-73` (`readSideChannel`'s bare catch), consumed at `scripts/memory/priming-report.ts:312`
- **Trigger:** `recallDir` exists but is unreadable (EACCES), or is a file rather than a directory (ENOTDIR), while real side-channel data sits behind the failure.
- **Current behavior:** every `readdirSync` error returns an empty Map, so the report emits `cyclesToDate: 0`, `checkpointEligible: false`, and only the generic "no observed cycles" note — indistinguishable from a factory that genuinely never ran a cycle. This contradicts the file's own honesty pattern: an absent ledger, an unreadable ledger, and an unreadable dispatch log each get a specific dataNote; the primary input of the report gets none.
- **Expected behavior:** distinguish ENOENT (genuinely absent → current behavior is fine) from other errno classes and emit a dataNote, e.g. `side-channel dir unreadable at <path> (<code>); cycles counted as 0 — verify before trusting this report`.

## 3. Canary gate catches only client rejection; a malformed resolution crashes past the refusal contract — MEDIUM

- **file:line:** `scripts/memory/probe-recall.ts:212-221`
- **Trigger:** the injected `ProbeClient` RESOLVES the canary recall with a malformed payload rather than rejecting: `results` non-array (e.g. `5`, `{}`), or a `results` element that is `null`/a primitive. Reachable via upstream schema drift on the 0.10.x wire or a non-conforming mock; the same file defends the analogous `listBanks` envelope (`extractBankIds`) and the scoring loop catches this class via its try/catch.
- **Current behavior:** `canaryResults = canaryRecall.results ?? []` succeeds (only null/undefined folds to `[]`), then `canaryResults.some(...)` (or `r.documentId` on a null element) throws a TypeError OUTSIDE the try — it escapes `runProbeRecall` as an unhandled crash. The header comment promises "a canary that ERRORS ... is refused at this stage exactly like a canary miss — never an unhandled crash"; the reject half is honored, the malformed-resolve half is not.
- **Expected behavior:** fold the malformed shape inside the try — `if (!Array.isArray(recall.results)) throw new Error("malformed recall envelope")` (or wrap the `.some` in the same catch) so it lands as `canaryError` and returns the stage-`canary` refusal with a diagnostic.

## 4. probe-recall CLI entry has no catch — lock timeout and other escapes bypass the documented exit taxonomy — LOW

- **file:line:** `scripts/memory/probe-recall.ts:339` (`if (import.meta.main)` — no try/catch), escapes possible from `scripts/memory/probe-recall.ts:133-146` (lock poll throwing `RunLockedError` after the 60s deadline, `mkdirSync(probesDir)` failure) and the deliberate `atomicReplaceFile` throw at artifact persist.
- **Trigger:** run `bun scripts/memory/probe-recall.ts` while another probe-recall holds the probe-writer lock longer than 60s (23 probes × network recalls can exceed it), or the probes dir path is unwritable.
- **Current behavior:** the throw surfaces as an unhandled rejection with a raw stack trace; the header's documented "exit 1 scoring refusal / lock failure" is met only incidentally by Bun's unhandled-rejection exit code, and the operator gets a stack instead of the structured refusal line (contrast `verify-m13-e2e.ts`'s fail-through-finally pattern and the priming-report CLI's own catch).
- **Expected behavior:** wrap the CLI call in try/catch printing one stderr line (message + the `RunLockedError.remediation` when present) and `process.exit(1)`.

## 5. Same-day concurrent report runs can publish a mismatched json/md pair — LOW

- **file:line:** `scripts/memory/priming-report.ts:427-428`
- **Trigger:** two `runPrimingReport` invocations overlap on the same UTC day (cron + manual run); both resolve the same `${day}-interim.json` / `${day}-interim.md` paths.
- **Current behavior:** each file is individually atomic-replaced, but the pair is not, so a reader can observe the JSON from run A beside the MD from run B (different `generatedAt`, `cyclesToDate`, notes) — breaking the AC5 property "the md is always re-derivable from the metrics JSON" at the pair level, which the verify-m13-e2e read of both files relies on.
- **Expected behavior:** hold a run-lock (the file already imports `acquireRunLock`) around the two writes, or derive both from one generation token and have readers re-check.

## 6. Probe growth silently skips on an unreadable probe set — no dataNote, unlike every other degradation — LOW

- **file:line:** `scripts/memory/priming-report.ts:190, 196, 565-566` (`return 0` on pre-lock parse failure, pre-lock read throw, under-lock re-read failure)
- **Trigger:** `probe-set.json` is malformed/corrupt (a bad manual edit, a truncated copy) when the report runs.
- **Current behavior:** growth returns 0 silently — `appendedProbes: 0` in the report with no dataNote — while the sibling degradation paths (lock deadline, F-007) DO get a `probe growth skipped: ...` note. An operator reading the report cannot tell "no candidates" from "growth is permanently disabled by a corrupt set", so the corpus silently stops growing.
- **Expected behavior:** push a dataNote (`probe growth skipped: probe set unreadable at <path>`) on these returns, matching the F-007 pattern.
