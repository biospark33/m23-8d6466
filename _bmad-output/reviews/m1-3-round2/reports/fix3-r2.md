# Round-2 fix report (fix3) — all 17 PATCH findings applied

Branch `feature/m1-3-recall-measurement-harness`. Scope: `scripts/memory/probe-schema.ts`, `scripts/memory/probe-recall.ts`, `scripts/memory/priming-report.ts`, `scripts/memory/report-render.ts`, `scripts/dev/verify-m13-e2e.ts`, `scripts/dev/verify-test-slice.mjs`, `tests/memory/probe-harness.test.ts`, `_bmad-output/evidence/memory/README.md` (new), story-file Dev Agent Record note. R2-018 (DEFER) untouched.

## Verdict table

| Finding | Change | Test |
|---|---|---|
| R2-001 costTable $0-print at >0 cycles | `joinCost` branches per run on CostView: `hasEvents===false` → ABSENT (excluded from totals, counted); `hasTokenRows===false \|\| unpricedRows>0` → PARTIAL (total included, flagged). costTable emits only when ≥1 fully-priced cycle AND zero absent; else notes `cost absent for N of M observed cycles (no ledger events)` / `cost partial for N cycles (unpriced rows present — tokens-not-harvested)`. Dead F-009 all-zero guard removed. Verifier seeds all 5 cycles priced (primed 2100µ$) to keep its cost-join check live | New: absent→withheld+note; partial→included+note + all-partial→omitted; fully-priced math re-pinned (incl. the free-but-priced 0 case). Re-pins: old cost-join test, env-hygiene seed, verifier 2000→2100 |
| R2-002 verifier hitRateAt5 NaN-vacuous | Replaced with: `"hitRateAt5" in aggregate` === false, `belowFloor === true`, and hits===2 re-derived from perProbe rows | Verifier green (`M13 E2E OK`) — the assertion is live (fails if the floor withholding breaks) |
| R2-003 stale-shape baseline artifact | `_bmad-output/evidence/memory/README.md` (new): 2026-10-07T15-52-32-492Z artifact named as first real-instance baseline (real bank, canary hit, 0.565 over 23, median 106ms) from pre-round-1-patch code, lacking origin/byOrigin/dd22 keys of `108a7e1a`; preserved verbatim; DD-22 baseline accrues at the checkpoint | — (prose) |
| R2-004 id-anchored cycle probes | ReportMetrics gains `byOrigin {seed,cycle}.probes` (computed in growProbeSet from the parsed set); md prints the split +, when `byOrigin.cycle.probes > 0`, the caveat "cycle-grown probes are id-anchored (query embeds the document id) — read the cycle split as id-lookup capability, not semantic recall". Story Dev Agent Record gains **Spec-letter note (R2):** documenting the sanctioned dev-meta banking of side-channel candidates (cited, not a register item) | Existing md purity/regex tests unaffected (caveat wording passes the no-causal-words guard); verifier green |
| R2-005 silent zero-cycle collapse | `readSideChannel` returns `{winners, readError?}`: ENOENT → absent (silent, pinned); any other errno → dataNote `side-channel dir unreadable at <path> (<code>); cycles counted as 0` | recallDir-as-FILE → note + 0 cycles; absent-dir → no note |
| R2-006 malformed canary resolve crashes | `Array.isArray(results)` check + null/primitive-element filter INSIDE the try — malformed resolve lands in canaryError → stage-canary refusal + diagnostic | results:5 → refusal + diagnostic naming "malformed canary recall envelope"; `[null,"junk",canary]` → canary still gates open |
| R2-007 CWD-relative defaults | `withCwd(p)` helper (probe-schema; appends `(cwd …)` for relative paths only — caller-supplied absolute paths stay bare) on probe-recall's invalid/unreadable/empty-set refusals + priming-report's ledger/dispatch/side-channel/growth dataNotes | Existing tests (absolute tmpdir paths) unaffected |
| R2-008 CLI main no catch | probe-recall `import.meta.main` wrapped: one stderr line `probe-recall failed: <msg>` (+ ` — <remediation>` when present, e.g. RunLockedError), exit 1 | — (CLI path; lock/throw escapes previously printed a stack) |
| R2-009 mergeMint duplicated | Exported from probe-schema (typed MintRecords); both callers import it; both local copies deleted | tsc 0 |
| R2-010 mismatched json/md pair | `acquireRunLock(reportsDir, PROBE_WRITER_LOCK_ID, "interim report pair")` held across the json+md writes (poll 25ms, 5s, RunLockedError only), release in finally | Pair-lock loop shares the growth contention policy; growth lock test still green (different dirs → no interference) |
| R2-011 growth silent-skip | growProbeSet returns `{count, note?, byOrigin?}`; the three unreadable paths return `probe growth skipped: probe set unreadable at <path>`; absent set stays a silent 0 (fresh factory, not a failure) | Malformed set → appendedProbes 0 + note, file untouched |
| R2-012 tie-break comment overclaim | Comment now: ties resolve to the lexicographically-later filename — deterministic and stable, but the suffix is a random token, so ARBITRARY not chronological; no "later write wins" claim | — (comment only) |
| R2-013 --min-pass default 1 | Flag required: `minPassRaw === undefined → usage()` exit 2; `?? "1"` dropped | Smoke: missing flag → usage exit 2. Grep: every `.unlazy/m1-3/gates/` CHECK already passes `--min-pass` explicitly — no ledger updates needed |
| R2-014 SideRow docstring + growth bank | Docstring names exactly the validated fields (runId string, primed boolean, latencyMs finite non-negative; other RecallRow keys not consulted); growth credits `row.banks[0]` when a non-empty string, else SEED_PROBE_BANK — mislabeled candidates still refuse via the mint gate | Existing growth tests green (rows carry `banks:[SEED_PROBE_BANK]` — first entry used) |
| R2-015 reentrant spin | RunLockReentrantError removed from growth's retryable set (and the pair-lock loop) — fatal, surfaces through the F-007 degradation | New pin: same-process hold → immediate dataNote + appendedProbes 0 (the old "blocks" test was exercising the spin; rewritten as genuine foreign-holder contention: blocked at 150ms, release → appended 1) |
| R2-016 verifier dead runsDir | `runs/` dir creation + `runsDir` wiring dropped; readRunRecord stub kept with the honest comment (CostLedger requires a resolvable key record; run-record integration stubbed, not exercised) | Verifier green |
| R2-017 `at` param shadow | `writeP09(target, banks, stamp, ok)` — internal stamp use inlined | 55/55 |
| R2-018 | DEFER — untouched | — |

## Verification (recounted)

- `bun test tests/memory/probe-harness.test.ts` → **55 pass / 0 fail** (probe-schema 16, probe-recall 15, priming-report 21, harness-e2e 3; +7 new, 3 legitimately re-pinned, 1 lock test rewritten per R2-015)
- `bun scripts/dev/verify-m13-e2e.ts` → **M13 E2E OK**
- `bunx tsc --noEmit` → **0 errors**
- `bunx @biomejs/biome check scripts/memory scripts/dev tests/memory` → **exit 0**

Note for the reviewer: the "append runs under the probe-writer lock" test previously passed via the reentrant-spin bug R2-015 removes (same-process acquire threw RunLockReentrantError, which growth then retried to the deadline). It now pins genuine contention with a foreign lock body, and a second test pins the new fatal-reentrant degradation.
