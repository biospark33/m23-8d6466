# Acceptance Auditor — M1.3 round 3 (verification round)

Scope: FINAL tree (`feature/m1-3-recall-measurement-harness` @ `f0c204bd`, working tree clean for all story files — verified) vs `m1-3-recall-measurement-harness.md` with rounds 1–2 findings treated as authorized history. Inputs: spec + all three chunk diffs + direct reads of the tree and the M1.2/P0.9 source contracts.

**Verdict: NOT CLEAN — 2 findings (1 MED, 1 LOW) + 1 LOW residual + 1 cosmetic observation.** No AC violation, no invariant contradiction, no observability-contract breach. The MED finding is a regression *introduced by* the round-2 patch R2-017 and silently voids round-1 finding F-015's regression coverage.

---

## Findings

### A-1 (MED) Round-2 patch R2-017 broke the P0.9 fixture: `writtenAt: at` serializes a function — every fixture leg JSON has NO `writtenAt`, and the "latest writtenAt wins" test passes for the wrong reason

`tests/memory/probe-harness.test.ts:147` — inside `writeP09`, the payload says `writtenAt: at`. `at` here is **not** the stamp; it is the module-level array-indexing helper `function at<T>(arr: T[], i: number): T` (`tests/memory/probe-harness.test.ts:121`). The stamp parameter is `stamp` (used correctly in the filename on line 141). `JSON.stringify` drops function-valued object properties, so every fixture P0.9 leg JSON is written **without a `writtenAt` field**.

Consequence chain (all verified against the shipped reader `scripts/memory/probe-schema.ts:94-130`):
- `loadP09MintRecords` reads `writtenAt` as `""` → `Date.parse("")` = NaN → epoch = `Number.NEGATIVE_INFINITY` for **every** fixture file (`probe-schema.ts:123`).
- The test at `tests/memory/probe-harness.test.ts:421`, named **"loadP09MintRecords: latest writtenAt wins per bank"**, passes only through the **filename tie-break branch** (`epoch === prev.ts && name > prev.name`, `probe-schema.ts:128`) with both epochs at −Infinity. It does not exercise writtenAt ordering at all.
- Therefore the finite-epoch comparison branch (`epoch > prev.ts`) — the exact subject of the round-1 patch F-015 ("writtenAt Date.parse ordering with tie fallback") — has **zero regression coverage**. The suite is green 48/48, but this test is vacuous: precisely the class this campaign patched twice already (R1 verifier vacuous check, R2-002 NaN-vacuous assertion).

Provenance: the round-2 finding R2-017 was "writeP09 `at` shadow rename" — the local variable that shadowed the helper was renamed to `stamp`, but the `writtenAt:` reference was left pointing at the now-outer helper. The fix introduced the bug it was patching near.

Fix is one line: `writtenAt: stamp,` (the test then genuinely exercises epoch ordering; 10:00 vs 11:00 stamps compare finite). tsc does not catch it (`JSON.stringify` takes `unknown`), and bun passes it — no gate in the pipeline flags it, which is why it needs this finding.

No production/AC impact: the real evidence JSONs carry real writtenAt stamps and the reader is correct; this is test-integrity only. Rated MED because the story record cites the green suite as patch evidence and one named regression test no longer tests its subject.

### A-2 (LOW) Committed `_bmad-output/memory/reports/2026-10-07-interim.{json,md}` predates the shipped shape and is unlabeled — the R2-003 fix class was applied asymmetrically

Round 2 patched "Committed baseline artifact predates shipped shape" (R2-003) by adding a provenance README to `_bmad-output/evidence/memory/` (present, accurate). The **reports** deliverable has the identical problem with no README (`_bmad-output/memory/reports/README.md` does not exist):

- The committed JSON's dataNote `"cost ledger has no events for the observed cycles; costTable omitted — absent, not 0"` is **not producible by the shipped code** — current note texts are only `cost absent for N of M observed cycles (no ledger events)` / `cost ledger not found at …` / `cost ledger unreadable at …` (`scripts/memory/priming-report.ts:394-450` region; at 0 cycles with a present ledger the shipped code emits **no** cost note at all).
- The committed JSON lacks `byOrigin`, which the shipped code emits whenever the probe set is readable (it is — 23 committed probes).

The pair is internally consistent (md still re-derives byte-for-byte from its JSON, so AC5 holds), but a reader comparing the committed deliverable against the shipped code finds an unreproducible artifact with no honest-history label. Fix: add a provenance README mirroring the evidence/memory one (or regenerate the pair with current code).

### A-3 (LOW, residual) Malformed side-channel rows are skipped with no dataNote — cyclesToDate can silently undercount the DD-22 counter

`readSideChannel` (`scripts/memory/priming-report.ts:80-110`) silently skips rows that fail JSON.parse or the runId/primed/latencyMs shape check (including F-016's finite/non-negative latency guard). Round 2's R2-005 fixed this class at **dir** granularity ("real data hidden behind the failure → silent fresh-factory report") with a dataNote; at **row** granularity a corrupt/truncated file still vanishes from `cyclesToDate` — and with it from `checkpointEligible` — with no note, no count of skipped rows. Same rationale, residual granularity; no round adjudicated the row-level case. Fix: count skipped rows and push a dataNote when > 0.

### Observation (cosmetic, not a finding)

`baseReportDeps()` in `tests/memory/probe-harness.test.ts` still passes `runsDir: join(dir, "runs")`, a key the `PrimingReportDeps` type no longer declares (round-2 patch "Drop dead PrimingReportDeps.runsDir" cleaned the deps and the verifier but left the test helper). Harmless (non-literal object, no excess-property error) but misleading to a reader. Same `ENV_KEYS`/`QDS_RUNS_DIR` env pinning is likewise dead. Deletion-only cleanup.

---

## Round-2 fix verification (the four named)

| Fix | Verdict | Evidence |
| --- | --- | --- |
| R2-001 cost-join CostView branching | **HOLDS** | `joinCost` (`priming-report.ts:169-196`) branches per run on `ledger.readRunCost(runId)` → `hasEvents` (absent), `!hasTokenRows \|\| unpricedRows > 0` (partial), else priced; `costTable` emits only when `pricedCycles > 0 && absentCycles === 0`, with aggregate dataNotes for absent/partial. `CostView` fields confirmed in `src/providers/cost-ledger.ts:936-953,2001,2075-2082`; `openReadOnly` confirmed (:1247) with the DF2.11 write-refusal guard. Tests cover fully-priced / absent / mixed-partial / all-partial / zero-cycles / fully-cached-$0; the `$0` print for a priced zero-cost cycle is exact, not a zero-fill. |
| R2-006 canary malformed-resolve | **HOLDS** | Shape check is inside the try (`probe-recall.ts:196-216`): `!Array.isArray(canaryRecall.results)` throws into the canary-refusal path; null/primitive elements filtered before `.some`; a canary error OR miss writes the `-canary-failure-<rand6>.json` diagnostic (write guarded, F-019) and withholds the hit-rate artifact. Tests pin both malformed-resolve and retain-error refusals with zero recalls issued. |
| R2-005 ENOENT-vs-other recallDir | **HOLDS** | `readSideChannel` (`priming-report.ts:80-97`): ENOENT → silent absent (zero cycles, no note); any other readdir failure → `readError` → dataNote "side-channel dir unreadable …; cycles counted as 0" (`:394-395`). Test pins file-as-dir (ENOTDIR) noted vs absent-dir silent. |
| R2-010 lock across the json/md pair | **HOLDS** | `priming-report.ts:513-530`: `PROBE_WRITER_LOCK_ID` acquired on `reportsDir` before `atomicReplaceFile` of json then md, released in `finally`; contention polls (RunLockedError only — RunLockReentrantError propagates fatal, matching R2-015's alignment), 5s deadline. Different dir from the probes-dir lock, so no cross-contention with growth or probe-recall. |

Round-2 fix R2-017 (writeP09 `at` shadow rename) **does NOT hold** — see finding A-1.

## Per-AC satisfied evidence (final tree)

- **AC1** (make-or-break, incl. negative controls): gate order lock → parse/load (empty set refuses, F-003) → label integrity → canary → scoring. (i) bank existence via `listBanks` with both envelope shapes + reserved `<listBanks>` violation on endpoint rejection (F-002); (ii) per-bank mint membership only — cross-bank id is phantom-class (`mintMembershipViolations` per-bank lookup; union of P0.9 leg JSONs + receipt detail rows via `mergeMint`), strict refusal on ALL violations with no scored miss (R5 honored); unreadable/absent audit db → absent-data (R1-patched posture); (iii) canary: one retain, deterministic `qds-canary`, `updateMode:"replace"`, into `SEED_PROBE_BANK`, recalled at limit 5 before any scoring, excluded from the aggregate (exactly one retain total — asserted by test); miss/error → exit non-zero, `-canary-failure-*.json` diagnostic (bank/documentId/query/recallTail), hit-rate artifact withheld. Negative controls both fenced and tested: phantom-id scores-nothing (refusal), cross-bank scores-nothing (refusal). The stateless M1.2 mock (`listBanks → {}`) cannot pass the gate — empty bank set → every probe violates.
- **AC2**: hit iff an expected `documentId` is in the top-5 (`slice(0,5)`, 1-based first-match rank, null-documentId never matches, position 6+ does not hit, k=5 passed explicitly); `hitRateAt5` + `medianRecallMs` machine-checkable in the artifact, both **withheld below `MIN_PROBE_SET_SIZE = 20`** with `belowFloor: true` (spec Technical Notes letter; NaN-vacuous verifier assertion replaced by key-absence + belowFloor + perProbe-hits checks). Negative control (counting k-returns as hits): no such path; miss fixture pins it.
- **AC3**: primed-vs-unprimed cost (exact integer µ$ from the ledger, never relabeled; a priced zero-cost cycle prints 0, absent/partial cycles withhold the table with notes — never a $0 print over absent data) and outcome (mean latency) tables; D1/D2 omissions carry the recorded dataNotes; `CORRELATION_NOTE` exactly once, no causal wording (regex-tested); read-only posture proven by tests: absent ledger stays absent, audit.db + ledger mtime unchanged. All store paths verified: `DISPATCH_FAILURE_LOG` is exactly the spec's `.sandbox/dispatch-log.jsonl`; `DEFAULT_RECALL_DIR` is the M1.2 side channel `_bmad-output/memory/recall`.
- **AC4**: `cyclesToDate` = deduped side-channel rows (mtime last-wins, name tie-break); receipt presence is a LEFT-JOIN per-cycle field (`receiptCoverage` + `cycles[].receiptPresent`), never a filter (receipt-less cycle still counts, tested); `checkpointEligible` true only at ≥ 30 (29/30 boundary tested); **zero** swap/eval code paths in any story file; eligible-report vocabulary test (no graphiti/swap in json or md).
- **AC5**: `renderReportMd` is pure (reads only its parameter, no I/O/clock/store — nothing computed inside the renderer); byte-for-byte re-derivability tested from the persisted JSON. Deleting the renderer leaves probe-schema/probe-recall and the metrics JSON untouched (separate module).
- **Data**: 23 committed probes, each 1 expected id, all `qds-` conceptual content (INV-PH-1 clean — no credentials, no box-internal paths in any query); 23/23 expected ids match the passing P0.9 mint record (`…kvdvho.json`) bidirectionally; `ok:false` failed-leg JSON ignored by the reader (tested); committed probes are schema-valid under the shipped `ProbeSchema`.
- **DoD/e2e**: `verify-m13-e2e.ts` hermetic (tmpdir, explicit auditPath, cleanup on every path, success-only marker), vacuous-NaN assertion replaced with key-absence + belowFloor + perProbe hits; `verify-test-slice.mjs` requires `--min-pass`, bounds-checks every flag value, tallies the LAST summary match.

## Security Invariants

- **INV-PH-1**: clean — probe queries/labels/canary content derive from `qds-` repo concepts only. (The redacted OpenRouter key ids in the committed P0.9 evidence are leg evidence, not probe content; redaction is recorded in the README as the sanctioned deviation.)
- **INV-PH-2**: clean — ledger via `CostLedger.openReadOnly`, audit via `bun:sqlite` `{readonly:true}` (both story opens verified), dispatch log read-only line count, no story code writes any `.sandbox` store; exactly ONE Hindsight write in the story (the canary retain), matching the sanction; no reflect/consolidate calls.
- **INV-PH-3**: clean — no bank create/delete/swap anywhere in the story surface; canary retains into the existing provisioned bank; the DD-22 surface is `checkpointEligible` + informational `dd22WorkingBar`/`dd22Note` fields with the no-evaluation note.

## Observability Contract

- One evidence JSON per probe-recall run, stamp + run-unique rand suffix (collision-proof); gate failure → exit non-zero, artifact withheld, canary diagnostic separate (write-failure guarded).
- `cyclesToDate` + `checkpointEligible` printed on every successful invocation (CLI stdout) and always present in the JSON.
- Absent-not-0 honored everywhere: `costTable` / `outcomeTable` / `cycles` / `dispatchFailures` keys are conditionally **absent** (never zero-filled), each with a dataNote where a source was present-but-unreadable.
- No new log vocabulary: no new swarmclaw event names; the M1.2 `kg-recall`/`memory-retain` lines ride the real client when probe-recall runs against a live instance; script stdout lines are invocation feedback, not log events.
- Residual gap = finding A-3 (row-level silent skip, un-noted).
