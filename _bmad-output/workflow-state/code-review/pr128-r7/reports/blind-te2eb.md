# Blind Review: tier2+provider tests (chunk-t-e2e-b.diff)

## Findings

### [MEDIUM] Finally-block leak check has no retry on listing lag

**File**: `tier2-dispatch-engine.live.test.ts` L332-334, `tier2-fanout-bestofn.live.test.ts` L642-645

**Trigger**: Box listed by provider API with eventual consistency (measured live: destroy rm exit 0, box still listed for 25+ seconds).

**Issue**: After calling destroyQuietly, the test does a single `driver.list()` and expects `[]`. No retry, no backoff. If the listing lags, the test throws "leak detected" even though the finally block just called destroy. The destroy itself (F7 fix) has a 1-retry mechanism, but the listing verification does not.

**Why it bites**: Tier2 tests run against real exe.dev substrate. Real APIs have propagation delays. A false-positive "leak detected" aborts the test run and requires manual investigation to confirm it was a false positive.

**Fix**: Either retry the final listing 2-3 times with 5-10s backoff, or suppress the "still listed" expectation when the test already failed (the leak is a secondary concern to the primary failure).

---

### [LOW] Cost test name mis-states ceiling (prose-only, test math is correct)

**File**: `scripts/qds-cost.test.ts` L364-367

**Trigger**: Reader skimming the test, not the assertions.

**Issue**: Comment says "Box hours bill by CEILED whole hours: ceil(1.5h) = 2h × 3,600,000 µ$/h = 7,200,000 µ$" but the assertion below is `expect(out).toContain("5,400,000")` — fractional billing. The comment was not fully updated for the F8 fractional billing change. The *test* is correct (the assertion matches the new fractional math), but the prose is stale.

**Why it bites**: Misleading maintenance burden. Future dev reading the test may think "ceiling" is still the contract and introduce bugs.

**Fix**: Update comment to "Box hours bill FRACTIONALLY (F8): 1.5h × 3,600,000 µ$/h = 5,400,000 µ$ — no whole-hour ceiling."

---

### [LOW] statSync mode check loses file type bit

**File**: `exedev/driver.test.ts` L958

**Trigger**: Test run on filesystem where stat returns unexpected mode bits.

**Issue**: `expect((st.mode & 0o777).toString(8)).toBe("600")` — this checks permission bits only, which is correct for a mode check. But the expectation is a literal string `"600"`. If the file type bit (e.g., S_IFREG = 0o100000) is included in the comparison, `st.mode` could be `0o100600` and `0o100600 & 0o777` is `0o200` (octal 200, decimal 128), not `0o600`. The mask `& 0o777` is correct for extracting permission bits, so `(st.mode & 0o777)` will be `0o600` for a regular file with mode 0o600. The test is actually correct as written.

**Re-evaluation**: `(st.mode & 0o777)` extracts the 9 permission bits. If `st.mode` is `0o100600` (regular file, 0600 permissions), then `0o100600 & 0o777 = 0o600`. The test is correct. This is NOT a finding.

---

## Clean areas

The following areas showed no adversarial issues:

- **Finally-block id recovery** (tier2-dispatch-engine L318-322, tier2-fanout L627-632): Robust regex extraction from combined stdout/stderr. Covers refusal payload cases (F12 lesson).

- **Leak check prefix filter** (tier2-dispatch-engine L332, tier2-fanout L643): Correctly filters for BOTH `e2e-` AND `qds-` prefixes (F13 lesson addressed).

- **Cost ledger fractional billing** (cost-ledger.test.ts): F8 fix is thorough. Tests cover 1.5h, sub-hour (20s), sub-micro (1ms) boundaries. Math is correct.

- **Driver fill bundle-push mode** (exedev/driver.test.ts L785-831): Comprehensive. Validates no origin URL in clone argv, base64 decode occurred, bundle litter cleaned up.

- **Fill workdir validation** (exedev/driver.test.ts L877-890): Refuses metacharacters and `..` patterns before any command execution. Correct defense-in-depth.

- **Destroy verification** (exedev/driver.test.ts L988-1021): F7 fix is solid. One retry on "rm exit 0 but still listed", then fail-closed. Covers both "never clears" and "clears on retry" cases.

- **Setup gate F11 regression** (exedev/setup-gate.test.ts L1119-1197): Excellent instrumentation. curlLog captures every model id pinged. Asserts full slugs, no fragments.

- **Teardown F6 fallback** (teardown.test.ts L1304-1339): Correctly destroys vmName-less records using runId fallback. Covers both success and fail-closed paths.

## Overall Assessment

The test suite demonstrates strong adversarial coverage of real-money/live-machine paths. The F6, F7, F8, F11, F12, F13, F14 lessons from live incidents have all been systematically folded into tests with specific regression cases. The PRIMARY finding is a missing retry on the final listing verification — a real issue given the measured substrate lag, but one that causes false positives rather than actual leaks (destroy already ran with its own retry).
