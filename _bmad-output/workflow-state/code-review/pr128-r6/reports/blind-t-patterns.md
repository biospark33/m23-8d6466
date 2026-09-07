# Blind Hunter Review: patterns.test.ts

## BLOCKER

- **[BLOCKER] Deterministic race test racing itself — tests/fleet/patterns.test.ts:753-784** — Winner selection depends on `plantedVm` being set on `probeNumber === 2`. This assumes deterministic probe ordering. If probe order changes (implementation detail), the test plants the marker on a different arm, changing who wins. Test should assert the planted arm won regardless of index, not assume arm 1 wins.

- **[BLOCKER] Flaky concurrent test — tests/fleet/patterns.test.ts:1482-1531** — AC8 race test uses `Promise.then()` to create barrier in `checkHeadroom`'s provider list. Race between `winner` promise creation and `loserErr` await is nondeterministic by construction. If winner resolves admission before loser tries lock, test fails. Only reliable with artificial delays, testing timing not correctness.

## HIGH

- **[HIGH] Tautological assertion — tests/fleet/patterns.test.ts:625-627** — `expect(peak).toBe(2)` followed by `expect(peak).toBeLessThanOrEqual(2)`. If peak equals 2, the second assertion is tautological. Suggests test writer didn't know actual invariant.

- **[HIGH] Unscoped spy — tests/fleet/patterns.test.ts:435-440** — `listSpy` created but only call count asserted. Test doesn't verify what `list` returned or that it was called with correct args. Mock behavior not validated.

- **[HIGH] Mutable test state with callback mutations — tests/fleet/patterns.test.ts:755-761, 1214-1220** — `driver.onProbe` callback modifies outer closure variables (`plantedVm`, `arm0`, `arm0Probes`) during async operations. If timing changes or callbacks fire in unexpected order, test state corrupts. Makes tests nondeterministic.

- **[HIGH] Fixture assumes impl details — tests/fleet/patterns.test.ts:1215-1220** — Cross-process adoption test manipulates fanout record mid-probe. Assumes `FanoutRecordStore.list()` returns the in-progress record and that `winner` field is mutable at that point. Implementation-dependent fixture.

- **[HIGH] Coverage gap: negative control only checks n=2 — tests/fleet/patterns.test.ts:555-566** — "N arms hold distinct boxes" only tests n=2. Pathological single-box implementation could pass this test with n=2 (creates 2 boxes accidentally) but fail at n=8 or n=FANOUT_MAX_N.

- **[HIGH] No assertion on actual concurrency — tests/fleet/patterns.test.ts:602-629** — Concurrency bound test manually increments `inFlight` counter but doesn't verify arms actually ran concurrently. Counter could reach 2 via sequential execution if timing aligns. Test measures calls, not parallelism.

## MEDIUM

- **[MEDIUM] Weak invariant test — tests/fleet/patterns.test.ts:568-596** — "all N ids are minted before parallel section" checks fanout record carries all arms at first ledger call. If ledgerFactory is invoked earlier or later, test still passes because it captures state at first call, not before parallel section truly opens.

- **[MEDIUM] Coverage gap: only one direction of boundary tested — tests/fleet/patterns.test.ts:354-359** — "rejects n beyond the bound" tests n=FANOUT_MAX_N+1 but not n=FANOUT_MAX_N-1 (to verify accept) or n=FANOUT_MAX_N (to verify exact edge). Only rejection side covered.

- **[MEDIUM] Undeclared field assertions test impl not contract — tests/fleet/patterns.test.ts:456, 479** — Tests assert `exitStatus` field is `undefined` or `"transient"` on `FleetError` via unsafe casts. Tests implementation detail (field absence) not contract (error code and exitCode already asserted).

- **[MEDIUM] Spy on implementation detail — tests/fleet/patterns.test.ts:1452-1462** — `stampFanoutExtension` test spies on `store.set` to verify no-op when stamp exists. Tests implementation mechanism (set calls) not invariant (extensions.fanout already has correct value).

- **[MEDIUM] Long timeout suggests nondeterminism — tests/fleet/patterns.test.ts:971, 1017, 1206** — Multiple tests need 20-30s timeout (`bun test` default is 5s). Tests rely on real git operations (bundle-verify) and artificial deadlines. Slow/flaky by construction.

- **[MEDIUM] Closed-box assumption in teardown verification — tests/fleet/patterns.test.ts:701, 738, 1046** — Tests assert `expect(entries.some((e) => e.operation.startsWith("teardown."))).toBe(false)` to verify no teardown ran. Assumes "teardown." prefix only used for actual teardown steps. If logging adds this prefix elsewhere, tests fail despite correct behavior.

## LOW

- **[LOW] Coverage gap: rank formula not tested here — tests/fleet/patterns.test.ts:6-12** — Header comment says "rank math lives in rank.test.ts (agent C)" but AC7 mentions "rank formula 6dp" as covered. No rank formula tests in this file. Either AC7 misattributed or file incomplete.

- **[LOW] Mutable `ledgerCalls` counter — tests/fleet/patterns.test.ts:255, 319-322, 439, 461, 505** — Counter declared in suite closure, reset in `beforeEach`. If a test forgets to reset or runs tests in parallel (test framework change), counter leaks. Safer as local const in each test.

- **[LOW] Mutable `entries` array — tests/fleet/patterns.test.ts:244, 257** — Same pattern as `ledgerCalls`. Log sink pushes to mutable array. If test isolation fails (error in beforeEach), entries leak between tests.

- **[LOW] Coverage gap: malformed brief validation only tests one field — tests/fleet/patterns.test.ts:393-398** — "malformed brief refuses" only tests `commitSha: "not-a-sha"`. Other required fields (`repoSlug`, `issueId`, `manifestPath`) not tested for malformed values.

- **[LOW] No verification of correct error message — tests/fleet/patterns.test.ts:346-348** — "rejects an unknown pattern" asserts exitCode=2 but doesn't verify error message mentions the unknown pattern name. Implementation could return any exit-2 error and test passes.

- **[LOW] Shared tmpdir risk — tests/fleet/patterns.test.ts:249** — `mkdtempSync(join(tmpdir(), "df32-patterns-"))` creates directory in OS temp. If multiple test suites run in parallel and OS reuses temp paths, collision possible.

- **[LOW] Test assumes POSIX shell — tests/fleet/patterns.test.ts:119-121** — `shellQuote` function uses single-quote POSIX wrapping. Tests that use this assume POSIX-compliant shell. Would fail on Windows without WSL.

- **[LOW] Incomplete verification of zero side effects — tests/fleet/patterns.test.ts:400-411** — "every validation refusal takes no lock" checks lock file, boxes, records, ledger calls, run dir. Doesn't check that `process.env` wasn't poisoned (relevant given lines 492-514 show env mutation happens elsewhere).

- **[LOW] No verification of correct pin behavior in many-stories — tests/fleet/patterns.test.ts:1376-1392** — Pin mismatch tests cover best-of-n and race but only test that many-stories rejects `--pin`. Doesn't test that many-stories correctly uses per-arm pins from briefs.

## INFO

- **[INFO] Comment hints at previous bug — tests/fleet/patterns.test.ts:974-978** — Comment references "CodeRabbit round-5 warning" about cumulative vs consecutive counting. Test explicitly checks consecutive counting fix. Historical, not a defect.

- **[INFO] Env restore complexity — tests/fleet/patterns.test.ts:509-513** — Comment explains `Reflect.deleteProperty` not `= undefined` to avoid Bun string coercion. Necessary workaround but indicates test runs in environment with surprising behavior.

- **[INFO] Hardcoded constants for INV-6 — tests/fleet/patterns.test.ts:1349-1352** — Test asserts exact values of MAX_FANOUT_CONCURRENCY, DEFAULT_POLL_INTERVAL_MS, etc. As comment says, prevents "constant drift". Intentional brittleness.

- **[INFO] Cross-process test only covers intra-process case — tests/fleet/patterns.test.ts:1505-1511** — Comment admits test returns "fleet-lock-reentrant" not "fleet-busy" because it's same-process. Cross-process case "proven by fanout.test.ts's subprocess race". Split by design.
