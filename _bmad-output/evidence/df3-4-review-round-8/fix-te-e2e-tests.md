# T-E — e2e + phase-engine test hardening (PR #150 round 7, wave 2)

Files touched (only these): `tests/fleet/e2e/{live-harness.ts, tier1-approval-gate.live.test.ts, tier1-attach-transport.live.test.ts, tier1-teardown.live.test.ts, tier5-gate-steering.live.test.ts, tier4-resident.live.test.ts}`, `tests/phase-engine/{steering.test.ts, test-results.test.ts, pipeline-run.test.ts}`.

Verification: `bun test tests/phase-engine/` 782 pass / 0 fail (67 s); `bun test tests/phase-engine/{steering,test-results,pipeline-run}.test.ts` 165 pass / 0 fail; `bunx biome check` clean on all 9 files; `bunx tsc --noEmit` — zero errors in my files (5 residual errors are in `tests/fleet/approval-gate.test.ts` and `tests/providers/exedev/driver.test.ts`, other agents' files). Live tests remain `todoIf(liveTodoOff())`-gated; no live run was made.

## HIGH

| # | Finding | Verdict | What was done |
|---|---|---|---|
| H1 | D8 `finally` bare `revokeQuietly` (tier1-approval:658) | FIXED | Wrapped in try/catch + `finally-revoke` evidence push, byte-for-byte the T1.7 shape (:455-459), with the same comment explaining why (`revokeQuietly` reads the record outside its own try — a failed DF2.5 teardown is exactly the path that leaves a missing/malformed record). |

## MEDIUM

| # | Finding | Verdict | What was done |
|---|---|---|---|
| M1 | D8 no key-hash delta (:647) | FIXED | `d8Hash`/`d8Leaked`/`d8DeltaError` hoisted; finally computes the delta against `listedKeyHashes()` and the post-finally assertions (`d8DeltaError` undefined, `d8Leaked` empty) mirror T1.7's, including the "could not look ≠ nothing leaked" arm. D8 now has the same leak verification as T1.7/T5.1 (its single minted hash is the delta set). |
| M2 | T5.1 reverify no timeout + leg-sum overrun (tier5:428) | FIXED | Reverify leg now races exit+drains against `REVERIFY_TIMEOUT_MS` 420_000 (kill child first, dropped readers `.catch(()=>{})`). All box legs (`seed`/`writePrompt`/`verify`/`commitFix`) moved from implicit `DEFAULT_EXEC_TIMEOUT_MS` 120 s to explicit `execTimed` at `BOX_LEG_TIMEOUT_MS` 180_000. A r7-T-E budget-audit comment itemizes every leg ceiling (serial worst case ≈ 4.87M > 3.6M) and states the design position: the ceilings are per-leg fail-louds so no leg rides the bun test-timeout abort (the one path where `finally` cleanup is not guaranteed), not a schedule — measured pass ≈ 14 min. No assertion weakened. |
| M3 | `runFleetWithToken` drains unbounded (live-harness:242) | FIXED | Both `runFleet` and `runFleetWithToken` now race the WHOLE drain (`Promise.all([proc.exited, drained])`) against the timer; on fire the child is killed first, then reject — the already-resolved-race / still-pending-pipes hang is bounded at the promised ceiling, and the dropped readers cannot surface as unhandled rejections. `runFleet` got the same root-cause fix (same bug, same file). |
| M4 | D6 precondition weaker than requirement (tier1-teardown:199) | FIXED | Source check: `listAllKeys(1)` truncates exactly when page 0 is non-empty, and the full listing above reaching an empty page proves `full.size > 0` IS the real requirement — so the reviewer's "assert the truncation threw" would have been circular (it is asserted two lines later, on `threw`). What was actually broken is the failure diagnostic: the expect now carries a message naming the environment requirement (an account holding ≥1 key; a fully pruned account makes the guard unprovable) and the remediation. |
| M5 | Auth-refusal leg never live (tier1-approval) | FIXED | New leg after the happy approve: wrong token (`APPROVER_TOKEN + "-not-it"`) on fd 0 for the same allowlisted id → exit 5, `approver-token-mismatch` envelope present, presented token absent from all output, record unchanged (asserted against a snapshot taken before the leg). Real scrypt verify + constant-time compare on real infra; zero model spend (refusal fires before `submitDecision`; verified at scripts/fleet.ts:2777-2785). +1 cheap subprocess, no new box/key. Header table's "auth refusal 5" row is now exercised. |
| M6 | T5.1 tamper — porcelain not exact (:281) | FIXED | Replaced `toContain("t5_seed_calc.py")` with an exact expected-set assertion: the porcelain entries must be exactly `{__pycache__/, t5_seed_calc.py}` (untracked python bytecode is part of the measured pass shape, evidence 2026-08-30-173302). A fixer that rewrites `t5_seed_test.py` (its own judge) now fails here, before commit/harvest/reverify ride the false green. |
| M7 | T5.1 no post-finally box-absence (:567) | FIXED | The finally now re-lists with the r7-T-h1 lag poll (5 × 8 s) after `destroyQuietly`, records `t51BoxAbsence`, and a post-finally `expect(t51BoxAbsence).toBeTrue()` (T1.8:251 posture — outside the finally per noUnsafeFinally) turns a silent destroy failure into a failed test. Mirrors the key-delta pattern already there. |

## LOW

| # | Finding | Verdict | What was done |
|---|---|---|---|
| L1 | `envelope()` bare JSON.parse (3 files) | FIXED | All three copies (attach/approval/tier5) now use the `flatMap` + try/catch guard their sibling `gateLine` already had; a truncated/interleaved `{`-prefixed line is skipped instead of throwing at the wrong site. |
| L2 | Message ceiling allowed side untested (tier1-attach:207) | FIXED | New at-ceiling leg: exactly `ATTACH_MESSAGE_CHAR_CEILING` chars sent for real → exit 6 (queued), and the box line's message length is exactly the ceiling (not truncated shorter). Off-by-one that rejects legal messages is now caught. Inbox line counts updated (2→3). |
| L3 | T5.1 empty `requestId` accepted (:221) | FIXED | `expect(rec.requestId ?? "").not.toBe("")` added beside the slug's guard; the downstream joins (attach echo, approve `dispatchRequestId`) can no longer pass on `"" === ""`. |
| L4 | T5.1 probe id dead (:144) | FIXED (replacement control) | The probe id was never assertable (it is never provisioned — asserting its absence proves nothing a prefix filter doesn't). The load-bearing gap was the NEGATIVE direction: `final === []` was true for free if `driver.list()` can't see our boxes. Added the T1.7:190 positive control right after dispatch ack: `expect((await ctx.driver.list()).some(b => b.name === vmName)).toBeTrue()`. Probe id kept only as an evidence witness, comment states this honestly. |
| L5 | Token chmod unasserted (tier1-approval:173) | FIXED | `expect(statSync(tokenPath).mode & 0o777).toBe(0o600)` beside the allowlist/dir asserts. |
| L6 | D6 `writeEvidence` unguarded (:225) | FIXED | Wrapped in try/catch with a stderr line (T1.7's :481-486 posture). No workspace cleanup exists in this test to skip, so a catch is sufficient here (T1.7 needs `finally` because it rmSync's a workspace). |
| L7 | T1.8 retry double-delivery untested (:37) | FIXED | Attach #2 converted from a different-text send to a RETRY OF THE SAME TEXT; asserts fresh messageId AND the same message present exactly twice in the box — the header's "a retry mints a fresh messageId and double-delivers" is now a fact, not prose. (The reviewer's "four reasons" half stays out of scope: `send-failed`/`acks-unreadable`/`box-unreachable` require breaking the transport live, which this tier's no-fakes rule forbids — header comment already documents the honest no-ack contract; noted as deferred there.) |
| L8 | T5.1 engine retry on any failure (:267) | FIXED | Retry now fires only on the STALL shape (`!/PI_EXIT=\d+/` — no exit marker at all, i.e. `timeout 480` killed a hung call). A deterministic failure with a marker fails loud on the first attempt's evidence instead of burning a second full pi spend. Comment cites T2.1's fresh-box warmup provenance. |
| L9 | messageId ceiling boundary (steering.test:1306) | FIXED | Added the exact at-boundary: folded line must START with `operator attach ${"i".repeat(DIRECTIVE_ID_CHAR_CEILING)}: ` and its total length is exactly prefix+ceiling+`": "+`+"steer"` — pins steering.ts:601's `.slice(0, DIRECTIVE_ID_CHAR_CEILING)` to the constant, so a hard-coded 64-char cut fails. |
| L10 | Fold-budget hidden ratio (steering.test:969) | FIXED | Added `expect(8 * ATTACH_MESSAGE_CHAR_CEILING).toBeGreaterThan(2 * ATTACH_FOLD_CHAR_BUDGET)` — the flood must overshoot the budget by ≥2×, asserted against the exported constants, so moving either ceiling either keeps a genuine beyond-budget flood or fails naming the arithmetic. No hidden literal ratio remains. |
| L11 | Ack-retry terminal solicitation (steering.test:1020) | FIXED | Added the third solicitation (`run_end`): `acks` still exactly `["m1"]` and fold count still 1 — proves both latches (delivered, acked) hold past success, closing the re-fold and double-ack regressions the mock's forever-drain made invisible. |
| L12 | Vacuous cap-guard (test-results:361) | FIXED | The tautological `expect(lines * PAD_LINE_BYTES).toBeGreaterThan(EXEC_MAX_OUTPUT_BYTES)` (a ceil identity) replaced with `expect(lines).toBeGreaterThan(maxWholeLines(EXEC_MAX_OUTPUT_BYTES))` — reusing the at-cap fixture's independent helper, this fails if the derivation collapses to a constant or stops being a real beyond-cap flood. Comment states why the old form could never fail. |

## False positives / deferred

- **M4 (partial FP in the reviewer's framing):** "assert the truncation actually threw" is already the assertion at :216 — the two lines cannot both be the fix. The real gap (environment diagnostic) is fixed as described. Line numbers in the ledger predate wave-1 edits, hence the drift.
- **L7 (four no-ack reasons):** deferred deliberately — the other three reasons need a live box that refuses exec/acks reads, i.e. faking a transport fault, which the no-fakes rule and the file's own header comment forbid. The double-delivery half (testable) is fixed.
- **tier4-resident:** reviewed; no T-E finding applied to it in the ledger and no defect found worth a churn edit on a file other agents depend on. Listed per assignment, untouched.

## Source defects found while verifying (not mine to fix)

1. `src/providers/exedev/driver.ts:495` `exec()` has no per-call timeout parameter — callers needing a bounded leg must know to switch to `execTimed` (T5.1's box legs silently rode the 120 s class default; a hidden constant, now surfaced in the test as an explicit `execTimed`).
2. `scripts/fleet.ts` approve: a wrong-token refusal prints `gateEvent("refused", …)` with the CLI's own per-invocation `requestId` and no `dispatchRequestId`, while decided approvals carry the dispatch id — a consumer joining refusals to the run's pause line will find nothing. Cheap follow-up for a scripts owner.

## Notes

- An accidental `git stash` of `tests/fleet/e2e/` mid-run (mine — bad pathspec on a status check) was popped immediately; all edits verified present afterwards (`grep` counts on `REVERIFY_TIMEOUT_MS`, `approver-token-mismatch`, `d8Leaked`, `atCeiling` all confirm). No work lost; stash list back to its pre-existing 3 entries.
- `bun test tests/fleet/` shows 2 pre-existing failures in OTHER agents' files (`tests/fleet/approvers.test.ts` N·r ceiling — fix-ta; `tests/fleet/attach.test.ts` ceiling-0/unreachable — fix-f2/fix-tb territory). Not mine; not touched.
- No commits made, per instructions.
