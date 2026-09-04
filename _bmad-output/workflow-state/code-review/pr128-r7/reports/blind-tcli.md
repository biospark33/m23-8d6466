# Blind Hunter Review: CLI Tests Chunk

## BLOCKER

### [BLOCKER] `deadPid()` helper can leave zombie processes on timeout
**File:** helpers.ts:1257-1273

**Trigger:** On a loaded host where `isAlive(pid)` returns true beyond 100ms, the function throws and DOES NOT kill the child. The `Bun.spawn(["true"])` process becomes a zombie orphan. If this test runs repeatedly in a suite (e.g., in parallel), you accumulate zombies that eventually exhaust the host's process table.

**Why it bites:** The throw is treated as a test infrastructure bug, but there's no cleanup path. A retry loop that gives up without `proc.kill()` is a leak.

---

### [BLOCKER] `liveChild()` helper leaks on any test failure/timeout
**File:** helpers.ts:1276-1278

**Trigger:** If the test using `liveChild()` times out, throws before teardown, or the test framework aborts the suite, the `sleep 30` process becomes an orphan running for its full duration. No `try/finally` guard, no process tracking, no cleanup.

**Why it bites:** A hung or failing test leaves a 30-second sleep process behind. In parallel test runs, dozens of these could accumulate, consuming process table slots and potentially interfering with later tests (PID collisions, resource exhaustion).

---

## HIGH

### [HIGH] Settle loop can time out silently, producing false pass
**File:** cli.test.ts:791-798

**Trigger:** If `store.get(hungRun).closedAt` remains undefined past `Date.now() + 5_000`, the loop exits with `closedAt === undefined`. The check uses `toBeDefined()`, which PASSES when `closedAt` is `undefined` (undefined ≠ null ≠ undefined). The test proceeds to the DB query without having verified the late teardown actually settled.

**Why it bites:** On a slow host, the settle window might be insufficient. The test reports success even though the invariant it's testing (late teardown prices after close) wasn't actually observed. A subsequent test that expects the DB in a clean state could fail mysteriously.

**Fix:** Change the expectation to `expect(store.get(hungRun).closedAt).not.toBeUndefined()` and fail the test explicitly if the loop times out.

---

### [HIGH] Environment variable rollback uses Reflect.deleteProperty but comment claims Bun coercion
**File:** cli.test.ts:256-262

**Trigger:** The `try/finally` block uses `Reflect.deleteProperty(process.env, "QDS_FANOUTS_DIR")` to restore undefined, but if an exception occurs BEFORE the finally block (e.g., during `runCli`), the restore never executes. Subsequent tests in the same process see the polluted `QDS_FANOUTS_DIR` value.

**Why it bites:** Test isolation failure. Tests that depend on the default fanouts resolution path will accidentally use the mocked directory from the previous test, producing confusing cross-test pollution bugs.

---

### [HIGH] Missing explicit timeout check in settle loop
**File:** cli.test.ts:791-798

**Trigger:** The while loop condition is `store.get(hungRun).closedAt === undefined && Date.now() < settleBy`. If the timeout is reached, the loop exits with `closedAt` still undefined. There's no explicit check for timeout-after-loop, so the test continues with a potentially unset value.

**Why it bites:** Same as HIGH #1 - silent timeout produces false pass. The test should explicitly detect timeout and fail with a clear message ("Late teardown did not settle within 5000ms").

---

## MEDIUM

### [MEDIUM] `--steps-json` file size check uses magic number literal
**File:** cli.test.ts:907

**Trigger:** Test hardcodes `1024 * 1024` instead of importing the constant that enforces the cap in production code. If the production cap is changed but the test literal isn't, the test no longer pins the actual boundary.

**Why it bites:** Future-proofing. The test claims to validate "over the 1 MiB cap refuses" but if someone changes the cap to 2 MiB in production, this test still passes with a 1 MiB file, no longer proving the enforcement.

---

### [MEDIUM] No negative test for `--cap-micro-usd` below zero
**File:** cli.test.ts:1107-1126 (C1 tests)

**Trigger:** Tests validate upper bound ($1M) and exact boundary ($1M), but missing validation that negative values refuse. A caller passing `--cap-micro-usd -1` might be accepted or produce undefined behavior.

**Why it bites:** Edge case gap in flag validation coverage. Negative money makes no sense but isn't explicitly tested as a refusal.

---

### [MEDIUM] Flag-validation tests don't cover sibling paths (empty vs missing vs repeated)
**File:** cli.test.ts:1127-1149 (C2/C3 tests)

**Trigger:** `--roster ""` (empty string) and `--roster ",,,"` (separators only) are tested, but the MISSING flag case isn't explicitly tested for these new refusals. A caller omitting `--roster` entirely might still hit an older code path.

**Why it bites:** Coverage gap in the refusal matrix. The test proves empty-string refusals but doesn't prove the ABSENCE of the flag still routes through the same guard.

---

### [MEDIUM] `deadPid()` poll loop has hardcoded iteration count
**File:** helpers.ts:1266-1272

**Trigger:** Fixed 10 iterations × 10ms = 100ms budget. On heavily loaded systems or under high I/O pressure, the pid table update might legitimately take longer. The test infrastructure itself becomes flaky.

**Why it bites:** False test failures on saturated hosts. The "process infrastructure bug" error might fire on legitimate slow systems, making CI noisy.

---

## LOW

### [LOW] Test fixture uses `mkdtempSync` in tmpdir but no explicit cleanup
**File:** cli.test.ts:1152, 1163, 1173

**Trigger:** Tests create fresh temp directories with `mkdtempSync(join(tmpdir(), "fleet-test-"))`. If the test fails partway through, these directories persist. Under a long test suite, hundreds of `fleet-test-*` directories could accumulate in `/tmp`.

**Why it bites:** Minor resource leak. Most systems clean `/tmp` on reboot, but long-lived CI runners could accumulate disk usage over time.

---

### [LOW] No test for `--steps-json` FIFO/blocking behavior
**File:** cli.test.ts:921-937 (directory refusal test)

**Trigger:** The test proves directories are refused with "is not a regular file", but the comment mentions "A FIFO would block the read outright." There's no actual FIFO test - the dangerous blocking case is asserted but not proven.

**Why it bites:** Low-risk edge case (FIFOs in test scenarios are rare), but the diff explicitly calls it out as a danger and doesn't test it. The comment claims the posture without proof.

---

### [LOW] Test database opened `readonly` but assertions assume write-visibility
**File:** cli.test.ts:803-815

**Trigger:** Test opens the cost ledger DB with `{ readonly: true }` then queries for box_hours rows. If the late teardown's write isn't visible (transaction isolation, WAL lag), the query returns 0 rows and the test fails even though the code worked.

**Why it bites:** Potential flakiness. SQLite readonly mode has transaction semantics that might not immediately see writes from the still-open write handle. Opening read-write (or ensuring the write handle is fully closed) would be more robust.
