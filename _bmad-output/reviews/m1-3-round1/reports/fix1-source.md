# Fixer wave 1 (source cluster) — verdict report

Branch `feature/m1-3-recall-measurement-harness`. Owned files touched: `scripts/memory/probe-schema.ts`, `scripts/memory/probe-recall.ts`, `scripts/memory/priming-report.ts`, `scripts/p0-9/provision-and-import.ts`. Nothing else edited.

## Verdict table

| Finding | What changed | Wave-2 behavior flag |
|---|---|---|
| F-001 | probe-recall scoring loop wrapped; a `client.recall` rejection mid-scoring returns `{ok:false, stage:"scoring", reason}`; no artifact. `"scoring"` added to the stage union; CLI exits **1** for it. | New stage value `"scoring"`; new exit code 1. |
| F-002 | `checkLabelIntegrity` catches `listBanks` rejection → `{ok:false, violations:[{probeId:"<listBanks>", reason:"listBanks failed: <err>"}], checkedProbes: probes.length}`. Chosen shape = violation row (no new error class); probe-recall maps it via the existing `!integrity.ok` path. Documented at both sites (function doc + caller comment). | Reserved probeId literal `"<listBanks>"`. |
| F-003 | `probes.length === 0` → label-integrity refusal (`probe set empty at <path>`), exit 2. Below `MIN_PROBE_SET_SIZE`: aggregate has `belowFloor:true` and **no `hitRateAt5` key**; `hitRateAt5` emitted only at ≥ 20 (same branch as median). `hitRateAt5` now optional in `HitRateMetrics`. | Missing `hitRateAt5` below floor; stdout prints "hitRateAt5 withheld (below 20-probe floor)". |
| F-004 | `CostLedger.openReadOnly` + `readRunCost` wrapped; any failure → `costTable` undefined + dataNote `cost ledger unreadable at <path> (<err>)`. | — |
| F-005 | Under-lock probe-set read/parse in `growProbeSet` guarded exactly like the pre-lock read (catch → `return 0`, lock still released). | — |
| F-006 | `toAppend` deduped on probeId as well as docId under-lock; survivors are ALSO pre-deduped on probeId pre-lock (first-wins on `cycle-<slug>` collisions). | — |
| F-007 | `growProbeSet` call site wrapped; any throw → `appendedProbes: 0` + dataNote `probe growth skipped: <err>`. Report always completes. | — |
| F-008 | Both readers (`loadReceiptMintRecords`, `readReceiptRunIds`) wrap open+query; failure (TOCTOU, NOTADB, CANTOPEN) → empty Map/Set. | — |
| F-009 | `outcomeTable` omitted entirely at `cyclesToDate === 0` (+ dataNote); `costTable` omitted when the ledger exists but has zero events for every observed run (both groups `runs=0` AND `totalMicroUsd=0`) + dataNote "cost ledger has no events for the observed cycles". `outcomeTable` now **optional** in `ReportMetrics`; renderer prints "absent" lines for both. | `outcomeTable` key absent at 0 cycles (not `{primed:{runs:0,...}}`). |
| F-010 | `dispatchLogPath` defaults to `DISPATCH_FAILURE_LOG` (imported from `src/fleet/dispatch.ts`). Counted only when the file exists; unreadable → dataNote `dispatch failure log unreadable at <path>`, key omitted. | `dispatchFailures` now appears in default CLI runs whenever the log file exists (previously never). |
| F-012 | `ProbeSchema` gains `origin: z.enum(["seed","cycle"]).default("seed")` → **required in the parsed output type**. Side-channel candidates: bank `SEED_PROBE_BANK`, origin "cycle". P0.9 loop feeds candidates only for banks present in the probe set and labels each candidate with THAT bank. `byOrigin` computed in probe-recall's aggregate (`{seed,cycle}` both keys always present); perProbe rows echo `origin`. CLI prints a `byOrigin seed=p/h cycle=p/h` line when any cycle probes exist. | Probe output type change; growth-written probe-set rows gain `origin` (existing rows re-serialize with `origin:"seed"`); new aggregate key; new stdout line. |
| F-015 | `loadP09MintRecords` winner selection: `Date.parse` epoch compare; unparseable stamp → `NEGATIVE_INFINITY` (loses to any real stamp, cannot win); exact timestamp tie (or both unparseable) → lexicographically-LATER filename wins. | Tie order flipped from earlier-filename-wins to later-filename-wins. |
| F-016 | Side-channel shape check adds `Number.isFinite(latencyMs) && latencyMs >= 0` (Infinity/NaN/negative rows skipped as malformed). | — |
| F-017 | `mintCorpus` skips `entry.concepts.length === 0` entries with failure string `<bankId> <documentId>: empty-concepts-skipped` (deduped via the existing `seen` set, so recorded once per bank). | Failure strings now appear for empty-concepts corpus entries; no `tags: []` retain. |
| F-021 | `mintMembershipViolations(probes, mint)` exported from probe-schema; used by `checkLabelIntegrity` internally AND by `growProbeSet` (survivors = candidates with no violation). | New export. |
| F-025 | `runsDir` removed from `PrimingReportDeps` (no internal references existed). | **tsc break at `scripts/dev/verify-m13-e2e.ts:172`** — wave 2 owns that file; drop the `runsDir` property from its `runPrimingReport` call. |

### probe-recall extras (operator directive)

| Item | What changed | Flag |
|---|---|---|
| (a) F-018 | Filenames: `<stamp>-hit-rate-<rand6>.json`, `<stamp>-canary-failure-<rand6>.json`; `rand6()` = 6 lowercase alphanumerics via `crypto.randomBytes`. | Suffix breaks every `.endsWith("-hit-rate.json")` / `-canary-failure.json` pin. |
| (b) F-019 | Canary diagnostic write wrapped: on write failure the canary refusal STILL returns, reason gets `; diagnostic write failure` appended, `diagnosticPath` omitted (write error logged to stderr). Hit-rate artifact write remains throw-on-failure with the why-comment. | `diagnosticPath` can now be absent on a canary refusal. |
| (c) F-022 | `runProbeRecall` acquires `acquireRunLock(dirname(probeSetPath), PROBE_WRITER_LOCK_ID, "probe-recall run")` around gates+scoring+write; polls `RunLockedError` every 25 ms up to 60 s then throws; released in `finally`. Body moved to `probeRecallLocked` (private). | Concurrent recall runs serialize; >60 s contention now throws instead of racing. |
| (d) F-001-dep | `ProbeRecallDeps.auditPath?: string` threaded into `loadReceiptMintRecords(deps.auditPath)`. Env fallback unchanged. | Tests can inject a tmp audit db. |
| (e) F-024 | Artifact gains `dd22WorkingBar: {hitRateAt5Min: 0.7, medianRecallLtMs: SLOW_QUERY_THRESHOLD_MS}` (import now consumed) + one-line `dd22Note` ("decision-input context only — no evaluation logic (INV-PH-3)…"). No comparison logic anywhere. | Two new artifact keys. |
| (f) F-014 | Wall-clock fallback: `Math.max(1, Date.now() - started)` with comment. | `recallMs` is never 0. |

## Verification (operator-directive scope)

- `bunx tsc --noEmit` — **5 errors, none in owned files**: `scripts/dev/verify-m13-e2e.ts:172` (runsDir, F-025 mechanical follow-on — wave 2), `tests/memory/probe-harness.test.ts:107` (Probe type origin, F-012) and `:862-865` (`outcome` possibly-undefined, F-009 outcomeTable optional). Owned files: 0 errors. I did NOT touch scripts/dev per the do-not-touch list; the one-line drop of `runsDir` there is the only remaining source error.
- `bunx @biomejs/biome check scripts/memory scripts/p0-9/provision-and-import.ts` — exit 0, 4 files clean.
- `bun test tests/memory/probe-harness.test.ts` — **36 pass / 8 fail**, all 8 are enumerated re-pin categories:

| # | Failing test | Cause (re-pin needed) |
|---|---|---|
| 1 | probe-schema > ProbeSchema accepts a well-formed probe | parsed probe gains `origin:"seed"` (F-012) |
| 2 | probe-schema > parseProbeSet accepts a unique probe set | `toEqual` now sees `origin:"seed"` on every row (F-012) |
| 3 | probe-recall > happy path … contracted shape | `-hit-rate.json` suffix → `-hit-rate-<rand6>.json` (F-018) |
| 4 | probe-recall > canary miss refuses | `-canary-failure.json` suffix → `-canary-failure-<rand6>.json` (F-018) |
| 5 | probe-recall > canary retain ERROR refuses | same suffix (F-018) |
| 6 | probe-recall > hit-rate math | 4-probe fixture < 20 floor → `hitRateAt5` withheld, `belowFloor:true` (F-003); grow fixture to ≥20 or assert withheld |
| 7 | priming-report > probe growth appends … | appended/existing rows now carry `origin` (F-012) |
| 8 | harness-e2e > combined fixtures | `-hit-rate.json` suffix match (F-018) |

## Not done (out of my 16 + extras)

- F-020 per-cycle rows (runId/primed/receiptPresent in metrics) — not in my assignment list; assign if wanted.
- F-024's remaining verifier/verify-test-slice items — scripts/dev + tests owned by wave 2.
- Full-repo `bun run lint` not run (directive scoped biome to owned paths; I am not committing).
