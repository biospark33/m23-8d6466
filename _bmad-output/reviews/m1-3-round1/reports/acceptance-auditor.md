# Acceptance Auditor — M1.3 round 1 (diff vs spec)

Scope: `feature/m1-3-recall-measurement-harness` vs `dev`, audited against `_bmad-output/sprint-artifacts/dark-factory-v6/stories/m1-3-recall-measurement-harness.md` (AC1–AC5, E2E Slice, Technical Notes, INV-PH-1/2/3, Observability Contract, DoD). D1 (offline exitClassification/retried omitted with dataNotes), D2 (dispatch log = failure count only), D3 (P0.9 import fix + corpus growth), R3/R4/R5 are **authorized and not re-flagged**. Cross-checked against `src/providers/cost-ledger.ts`, `src/hindsight/run-retain.ts`, `src/hindsight/kg-context.ts`, `src/hindsight/client.ts` (read-only).

**Verdict: the make-or-break machinery is real and correct. Three MEDIUM findings, all of them spec-intent drift in the guard/observability layer, none of them breaking an AC's core mechanism.**

---

## Findings

### F1 — MIN_PROBE_SET_SIZE floor is enforced on the wrong metric: hitRateAt5 is emitted over a too-small sample while the median is withheld
- **Violates:** Technical Notes → Guards/limits ("MIN_PROBE_SET_SIZE = 20 enforced before aggregate `hitRateAt5` is emitted (below it, the report says so instead of printing a number over a too-small sample)"). Not covered by D1/D2/D3/R3/R4/R5.
- **Severity:** MEDIUM
- **Evidence:** `scripts/memory/probe-recall.ts` (chunk-A) computes `hitRateAt5: perProbe.length === 0 ? 0 : hits / perProbe.length` unconditionally and instead gates the *median*: `if (perProbe.length >= MIN_PROBE_SET_SIZE) aggregate.medianRecallMs = … else aggregate.belowFloor = true` ("Too small a sample to print a median over"). The guard the spec wrote to keep a headline number off a tiny sample instead protects a secondary statistic: a 1-probe run prints `hitRateAt5=1.0` with `belowFloor: true`. Test "below MIN_PROBE_SET_SIZE: belowFloor true and no medianRecallMs" (3 all-hit probes) confirms hitRateAt5 is still emitted. Untriggered on the committed 23-probe seed, so no shipped artifact is wrong today — but the enforcement point contradicts the spec's letter and its stated purpose.

### F2 — costTable/outcomeTable are zero-filled at zero cycles, contradicting the Observability Contract's named example
- **Violates:** Observability Contract ("a section with no data is absent, not 0 (e.g. `costTable` absent before the first retained cycle)"). Not covered by D1/D2/D3/R3/R4/R5.
- **Severity:** MEDIUM
- **Evidence:** `scripts/memory/priming-report.ts` gates costTable on **file existence** (`if (existsSync(ledgerPath))` → costTable, else absent+note), not on data presence. outcomeTable is rendered unconditionally. The committed deliverable demonstrates the violation: `_bmad-output/memory/reports/2026-10-07-interim.json` (chunk-C) shows `cyclesToDate: 0` with `costTable: {primed: {runs: 0, totalMicroUsd: 0, meanMicroUsd: 0}, unprimed: {…}}` and an all-zero outcomeTable — exactly the zero-fill the contract's example forbids (the repo's `.sandbox/cost-ledger.db` exists from other stories, so the existence gate always passes in practice).

### F3 — `dispatchFailures` is unreachable from the CLI: the dispatch-log join never appears on the story's only in-scope trigger
- **Violates:** Overview ("joins side-channel + run records + cost ledger + **dispatch log** …"); AC3's read-only dispatch-log consumption. D2 authorizes failure-count-only semantics, not non-wiring. Not covered otherwise.
- **Severity:** MEDIUM
- **Evidence:** `runPrimingReport` computes `dispatchFailures` only when `deps.dispatchLogPath !== undefined` (`...(deps.dispatchLogPath !== undefined ? { dispatchFailures: countDispatchFailures(...) } : {})`). The CLI block calls `await runPrimingReport()` with **no deps**; no default constant (`.sandbox/dispatch-log.jsonl` per spec "Stores consumed READ-ONLY") and no env var resolve the path. `countDispatchFailures` is therefore dead in every ad-hoc invocation, no dataNote explains its absence, and the committed report JSON carries no `dispatchFailures` key. The column exists only for programmatic callers that invent the path themselves.

### F4 — AC4 letter: receipt presence is recorded as an aggregate count, not a "per-row data-quality field"
- **Violates:** AC4 ("receipt presence is recorded as a per-row data-quality field, never a filter").
- **Severity:** LOW
- **Evidence:** `ReportMetrics.receiptCoverage: {withReceipt: number; withoutReceipt: number}` — the metrics JSON carries no per-cycle receipt flag, so the LEFT-JOIN's per-cycle data-quality dimension is not machine-checkable from the artifact. The load-bearing semantics ARE honored (receipt-less cycles still count; tests "receipt join is LEFT-JOIN" and verifier `receiptCoverage` 1/4), so this is letter-drift, not mechanism failure.

### F5 — Probe-set growth uses a hand-rolled weakened gate instead of "the SAME probe-schema.ts integrity gate"
- **Violates:** Technical Notes → "Probe-set growth mechanism" (candidates pass "through the SAME `probe-schema.ts` integrity gate before any append").
- **Severity:** LOW
- **Evidence:** `growProbeSet` in `scripts/memory/priming-report.ts` never calls `checkLabelIntegrity` and performs no `listBanks` bank-existence leg (comment: "no listBanks call here (this deps shape carries no client…"); it filters candidates by an inline per-bank mint-membership check. Integrity is not broken — the target bank's mint membership is enforced, so appended labels are provenance-true — but the candidate bank is hardcoded `SEED_PROBE_BANK` regardless of which bank the side-channel row actually recalled from, and the gate's AC1(i) leg is skipped at growth time.

### F6 — Concurrent probe-recall runs are not serialized by the named acquireRunLock guard
- **Violates:** Technical Notes → Guards/limits ("concurrent probe runs serialize via `acquireRunLock` on the probes dir … so evidence files never interleave").
- **Severity:** LOW
- **Evidence:** The lock is acquired only inside `growProbeSet` (probe-set append). `runProbeRecall` takes no lock, and the report json/md writes take none. Practical blast radius is small (timestamped atomic artifacts; canary retain is idempotent replace), but the named guard covers one writer path, not "concurrent probe runs".

### F7 — Runner env fallback can read the developer's real `.sandbox/audit.db` during tests
- **Violates:** test isolation / fixture discipline (Infra Prerequisites' mock-tier posture); latent nondeterminism, not an AC breach.
- **Severity:** LOW
- **Evidence:** The test suite deletes `QDS_AUDIT_DB` in `beforeEach` (C-5 hygiene), but `runProbeRecall`'s gate calls `loadReceiptMintRecords()` with no path, which falls back to `process.env.QDS_AUDIT_DB ?? ".sandbox/audit.db"` — i.e. the repo-root real audit db on machines where it exists. Harmless today (its receipt ids can never collide with fixture `mulch-doc-*` labels — a collision would refuse, the safe direction), but the fixture boundary leaks.

### F8 — `PrimingReportDeps.runsDir` is dead surface
- **Violates:** none directly; misleading API after D1.
- **Severity:** LOW
- **Evidence:** `runsDir` is declared in the deps interface, passed by every test/verifier fixture, and never read anywhere in `runPrimingReport` (the run-record join was legitimately dropped by D1). `QDS_RUNS_DIR` is likewise set by tests and consumed by nothing under test.

### F9 — `SLOW_QUERY_THRESHOLD_MS` exported but never consumed; the DD-22 latency bar appears in no artifact
- **Violates:** none strictly (spec: "Neither number executes anything"); completeness note.
- **Severity:** LOW
- **Evidence:** `probe-schema.ts` exports `SLOW_QUERY_THRESHOLD_MS = 5_000` (matching `round-trip-verifier.ts`'s constant) but nothing in the diff reads it, and neither the hit-rate JSON nor the report compares/prints against either DD-22 bar. The 0.7 hit-rate bar is likewise absent from output. Defensible under "decision inputs, not code" — but a reader of the code sees a constant implying an enforcement that does not exist, and the spec's stated reason for pinning the numbers now ("so the later conversation cannot move the goalposts") is carried only by the spec text, not by anything machine-checkable.

---

## ACs verified as SATISFIED

- **AC1 (make-or-break) — SATISFIED.** Gate order is load-bearing and correct: parse/dupe-probeId refusal → integrity (listBanks bank-existence + per-bank mint membership) → canary → scoring (`probe-recall.ts` Gates 0–2); every violation refuses with offending probeIds named (exit 2), zero client traffic before the gate (test "label-integrity failure refuses before any client traffic" asserts `retains.length===0 && recalls.length===0 && no artifacts`). Cross-bank minted id and phantom id both refuse (tests at probe-schema "flags a cross-bank minted id" / "flags a phantom expected id"). Canary: ONE retain, `documentId="qds-canary"`, `updateMode:"replace"`, into `qds-factory-dev-meta`, must hit on `documentId`; miss or retain-error → exit 3, `<ts>-canary-failure.json` diagnostic with bank/documentId/query/recallTail(/error), hit-rate artifact withheld (tests + verifier); canary excluded from the aggregate (`canaryInPerProbe` check in verifier). Mint keying verified against source: `src/hindsight/run-retain.ts:241-248` records `subjectId = documentId`, `detail = {documentId, bank}` — exactly what `loadReceiptMintRecords` maps; ok:false P0.9 legs are ignored, latest writtenAt wins per bank.
- **AC2 — SATISFIED.** Hit iff an expected `documentId` appears in the top-5 (`slice(0,5)`, null-tolerant, never `memoryId`); 1-based first-match rank else null; per-probe rows + `aggregate.hitRateAt5` machine-checkable in the evidence JSON. Negative controls proven: "a probe matching nothing expected misses" and "an expected id at position 6 does not hit" (limit=5 asserted on the wire call). Spec-sanctioned additive fields (`bank`, `recallMs`, `bankBreakdown`, `writtenAt`) present.
- **AC3 — SATISFIED** (modulo F2/F3 and authorized D1/D2). Joins primed (side channel) + exact integer ledger micros via `CostLedger.openReadOnly` → `readRunCost` SUM (write-refusing handle, `cost-ledger.ts:1247/500-505`); CORRELATION_NOTE appears exactly once; test asserts no causal wording in the md; read-only posture proven by absent-file-stays-absent and mtime-unchanged assertions in both the test suite and `verify-m13-e2e.ts`. No fabrication path exists — every row originates from a disk store.
- **AC4 — SATISFIED** (modulo F4). `cyclesToDate` = side-channel rows deduped on runId (mtime last-wins, dup-file test); receipt-less cycles still count; `checkpointEligible` true only at ≥ 30 (boundary tests at 29/30); **no swap/eval/migration code exists anywhere in the diff**, and a test greps both artifacts for `graphiti|swap` and asserts absence at 30 eligible cycles.
- **AC5 — SATISFIED.** `renderReportMd(m)` is a pure function of its parameter (reads nothing else); test "renderReportMd is pure from the metrics JSON (byte-for-byte)" re-renders the persisted JSON to the identical md; all metric computation lives outside the renderer, so deleting it leaves ACs 1–4 intact.

## E2E Slice / DoD spot-checks — SATISFIED
- Both runners execute end-to-end: committed real-instance evidence (`2026-10-07T15-51/15-52…-hit-rate.json`: 23 probes, hitRateAt5 0.565, canary hit — so the canary retain shape also empirically validates against the real `HindsightClient`) plus CI-tier `scripts/dev/verify-m13-e2e.ts` (integrity pass, both artifacts, checkpointEligible false at 5 cycles, read-only posture).
- Artifact naming: `<ts>-hit-rate.json` / `<ts>-canary-failure.json` / `<date>-interim.{json,md}` per contract; openrig-sc2 stamp discipline.
- `cyclesToDate` + `checkpointEligible` printed on every invocation (stdout line and both artifacts).
- No M1.2 file modified (`src/hindsight/`, `tests/hindsight/`, `tests/fleet/` untouched by the diff); the only non-story code change is `scripts/p0-9/provision-and-import.ts` (authorized D3).

## Security invariants
- **INV-PH-1 — SATISFIED.** Committed probe queries are paraphrases of `.mulch/expertise` content; no credentials/tokens/box-internal paths in any probe or canary string. (The `/Users/steve/...` path inside the committed P0.9 leg JSONs is that leg's pre-existing evidence format, not a probe field.)
- **INV-PH-2 — SATISFIED.** Exactly one sanctioned write: the AC1(iii) canary retain into an existing bank. Ledger via write-refusing `openReadOnly`; audit via `bun:sqlite` readonly with an existsSync guard; no reflect/consolidate calls; mtime-unchanged and absent-file-stays-absent asserted in test and verifier.
- **INV-PH-3 — SATISFIED.** No bank create/delete/swap anywhere; the DD-22 surface is a boolean flag, nothing more.

## Observability Contract
Substantially satisfied; F2 (zero-fill) is the one real breach. One residual LOW note: the scripts never import `swarmclaw/log` (the contract's "reuse … where applicable") — their output is bespoke stdout (`hitRateAt5=…`, `cyclesToDate=…`) rather than event lines. Mitigating: the canary retain/recall ride M1.2's existing vocabulary through `HindsightClient` itself (`client.ts:289,314` `operation: "retain"`), so no genuinely new *log* vocabulary enters the event stream; the stdout lines are operator-facing CLI output.

**Tally: 0 HIGH, 3 MEDIUM (F1 floor-on-wrong-metric, F2 zero-filled sections in the committed deliverable, F3 dispatchFailures unreachable from CLI), 6 LOW.**
