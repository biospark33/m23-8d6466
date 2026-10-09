# M3.1 live-round test — author report

File: `tests/fleet/e2e/memory-nightly.live.test.ts` (new, 385 lines; nothing else touched — `git status` confirms one untracked file).
Branch: `feature/m3-1-manager-meta-banks-l3-consolidate`. Authored only; NOT fired (operator GO owed).

## Test inventory (4 tests, every one `test.todoIf(liveTodoOff())`, first body statement `liveGate("1")`)

| Test | Proves | Asserts |
|------|--------|---------|
| L0 spend print | worst-case spend printed BEFORE anything bills; GO gate named | env gate open (liveGate + local M3.1 env check) |
| T1 crontab leg end-to-end | DoD item 1 — the documented fallback drives one real consolidate+refresh through the gateway against the dedicated 0.10.0 instance | `runMemoryNightly({env: process.env})` exit code 0; envelope ok; `banksOk === 3`; 3 receipts each with `refresh.mechanism === "consolidation-trigger"` AND `refresh.observedVia === "operations-list"` (OBSERVED evidence — trigger read-back alone never passes, AC2); driver's own bank derivation equals this file's; provisioning pass (`ensureManagerMentalModels`) ran green first (round provisions if absent) |
| T2 dedup claim instance-verified | DoD dedup probe — TWO concurrent `runNightlyConsolidate` (Promise.all) on ONE bank, leg `"schedule"`, operations counted | ≥1 receipt with `consolidate.deduplicated === true` ⇒ `verdict: "coalescing-observed"` (:578 claim verified). `REFRESH_EVIDENCE_MISSING` on a leg is the module header's named honest caveat (recorded, not fatal); any other failure code is fatal. NOT-observed ⇒ evidence STILL written, then loud fail naming the fallback (`scripts/lib/run-lock.ts` or operations-polling must be adopted before merge) |
| T3 schedule leg at the seam | DoD item 2 — platform-schedule leg demonstrated with an agent token, same job module, `leg:"schedule"`, one bank | receipt shape IDENTICAL to the crontab receipts (key sets `bankId,consolidate,mentalModelId,refresh` / `mechanism,observedVia,operationId,status` asserted literally), mechanism named, observedVia operations-list |

Evidence: harness `writeEvidence` via `writeEvidenceQuietly` (never-throws), names `m31-crontab-leg` / `m31-dedup-claim` / `m31-schedule-leg`, destination `_bmad-output/evidence/df3-e2e/` (override with `QDS_E2E_EVIDENCE_DIR` when firing). Evidence is assigned BEFORE the shape asserts in T1/T3 so a failed assert still leaves receipts on disk. A local `scrubToken` redacts the `QDS_MEMORY_AGENT_TOKEN` VALUE from any payload (the harness sweep is blind to the `mgat.` shape); token exists in the file as ENV NAME only (INV-MEM-3). Cleanup: none destructive — banks persist, token persists by design (names only, never values).

## Spend-print text (L0, verbatim)

```
M3.1 infra-tier worst-case spend (printed before anything fires):
  crontab leg   = 3 banks x (1 consolidate + 1 consolidation-trigger refresh) = 6 calls
  schedule leg  = 1 bank  x (1 consolidate + 1 refresh)                       = 2 calls
  dedup probe   = 2 concurrent consolidates on ONE bank (up to 2 refreshes)   = 4 calls
  worst case = 6 consolidates + 6 refreshes = 12 instance-side LLM calls.
Per-call cost is the dedicated instance's configured consolidation model
(operator-billed on the instance; this file holds NO factory key, NO box,
NO OpenRouter spend). Firing requires QDS_E2E_LIVE=1, QDS_E2E_TIER=1 and an
explicit operator GO: QDS_M31_LIVE_GO=1 — absence is a refusal, never silence.
```

Note (deviation, deliberate): the design formula counted 8 calls (3×2 + 2); the schedule leg's own consolidate+refresh was not in that arithmetic, so the print itemizes all three legs and totals the honest worst case of 12. Test ceilings: T1 `1_200_000 ms` (job wall budget 900 s + margin), T2 `720_000 ms`, T3 `420_000 ms` — priced above the nightly's own evidence budget (300 s), never masking a wedged leg.

## GO gate

`requireOperatorGo()` runs in T1/T2/T3 before anything fires: `QDS_M31_LIVE_GO=1` or throw naming the gate (`operator GO gate: QDS_M31_LIVE_GO=1 is not set — refusing to fire…`). Never proceeds on silence.

## Env-name list (checked by name, values never read out)

Local `requireM31Env()` (live-harness.ts untouched, per instructions): `HINDSIGHT_BASE_URL`, `HINDSIGHT_BEARER_TOKEN`, `MEMGATE_ADMIN_KEY`, `QDS_MEMGATE_SIGNING_KEY`, `QDS_MEMGATE_LEDGER`, `QDS_MEMORY_AGENT_TOKEN` — all required; `QDS_MEMORY_REPO_SLUG` optional (default `qds-factory`); `HINDSIGHT_BASE_URL` additionally passes `forbiddenOrigin`. Missing names land verbatim in the throw.

Operator note: `liveGate("1")` (harness, not editable here) still enforces its own `SUBSTRATE_ENV` (`QDS_EXEDEV_REPO_URL`, `QDS_EXEDEV_SHA`, `QDS_EXEDEV_ROSTER`, `OPENROUTER_PROVISIONING_KEY`) even though this round buys no box — the firing shell must carry those four names too, or liveGate refuses before the local check runs. Harness `SUBSTRATE_ENV` extension for the memory names remains available to a future harness owner.

No fakes anywhere: no stubbed fetch, no mock client; T1 exercises `runMemoryNightly` (the crontab line's own driver), T2/T3 exercise `runNightlyConsolidate` over the same `memgateDeps` shape the script builds (config vars by name, never whole `process.env`).

## Check outputs

| Check | Result |
|-------|--------|
| `bunx tsc --noEmit` | exit 0 |
| `bunx @biomejs/biome check tests/fleet/e2e/memory-nightly.live.test.ts` | exit 0, "No fixes applied" |
| `bun test tests/fleet/e2e/live-coupling-sweep.test.ts` | exit 0 — 38 pass, 0 fail (new file satisfies the coupling sweep) |
| `bun test tests/fleet/e2e/memory-nightly.live.test.ts` (no env) | exit 0 — `4 todo / 0 fail`, pays nothing |

No full suite, no commit, no live firing (per task).

live-test-author done
