# Blind Hunter Review: Tier1 E2E Tests

## [HIGH] Child process backpressure deadlock in runFleet harness
**File:** live-harness.ts L188-219
**Trigger:** Fleet CLI emits >~64KB to stdout or stderr before `proc.exited` resolves. Bun's pipe buffer fills, subprocess blocks writing, test hangs waiting for `Promise.all` where `proc.exited` races the read promises but the read is blocked on the write.
**Why it bites:** T1.4 runs `teardown` with `--harvest` - the bundle is binary data base64-encoded or streamed. A successful harvest could output large payloads. The `Promise.race` on `proc.exited` wins before `Response(proc.stdout).text()` completes; if stdout is backpressure-blocked, the text() never resolves and the race never finishes. Test appears hung; timeout at 300s eventually fires, but diagnostics are lost because the streams are deadlocked.
**Fix:** Drain stdout/stderr *before* race on exited, or use streaming accumulation with chunked reads. `Bun.spawn` with `"pipe"` has finite buffers; you must consume as output arrives.

## [HIGH] Test passes despite failed cleanup in tier1-harvest tests
**File:** tier1-harvest.live.test.ts L719-722 (T1.3a), L797-800 (T1.3b)
**Trigger:** `runFleet(["teardown", ...])` in the finally block fails (network error, exe.dev API down, box already destroyed by external actor, subprocess crash). The `teardown` verb's exit code is recorded to evidence, but the test reports `outcome: "pass"` because no exception was thrown from the try body.
**Why it bites:** VM leaks. The test claims the provision-and-harvest cycle succeeded, but the box is still live and billing. Next run sees "box already exists" or capacity limits, and nobody notices because the test file marked it green.
**Fix:** `expect(td.exitCode).toBe(0)` in the finally before evidence write. If teardown fails, throw so test records failure. Cleanup failures are test failures for e2e infrastructure guarding real money.

## [HIGH] Lock barrier race in tier1-lock concurrent teardown test
**File:** tier1-lock.live.test.ts L866-876
**Trigger:** First teardown (`a`) acquires lock, completes entire workflow (destroy + close + ledger write), releases lock, and exits *before* the 5s polling deadline finds the lock file. Test throws "barrier: first teardown did not create lock file within 5s", flaky pass/fail depending on exe.dev response time.
**Why it bites:** If exe.dev is fast or the box is small, `a` finishes in <1s. `b` launches after `a` already exited; there is no contention, `b` wins immediately, and we never proved mutual exclusion. Test becomes a timing-dependent coin flip, not a correctness proof.
**Fix:** Don't poll for the lock file. Launch both teardowns simultaneously *unconditionally*, then assert that exactly one refused with "run-locked". If both won (fast first, late second), fail. If both lost (impossible unless lock is broken), fail. Remove the artificial synchronization that masks real races.

## [MEDIUM] runFleet throws on spawn failure, no cleanup in finally
**File:** live-harness.ts L192-218
**Trigger:** `Bun.spawn` fails (binary not found, OOM, permissions) before returning a proc handle. `proc` is undefined; `finally` block's `proc.kill()` throws TypeError, bubbling up and preventing any structured error handling.
**Why it bites:** Spawn failure means we never even started the fleet verb. But the unhandled exception crashes the test with a confusing TypeError rather than a clear "subprocess launch failed" message. Debugging is harder, and any cleanup *after* this call (in tests' finally blocks) is skipped entirely.
**Fix:** Check for proc existence before kill: `if (proc) proc.kill()`. Better: wrap spawn in try/catch and throw a structured error with argv and cwd context.

## [MEDIUM] Evidence write can fail in finally, masking test result
**File:** All test files, finally blocks (e.g., tier1-driver-lifecycle.live.test.ts L445)
**Trigger:** `writeEvidence` throws (disk full, permissions, secret scrub failure, JSON serialization of circular reference). The outer finally has no try/catch around evidence write, so the exception propagates.
**Why it bites:** Test result (pass/fail) is lost because evidence write crashed. Operator sees an evidence error, not the actual test outcome. For T1.4, this means we don't know if the teardown succeeded or if the key was revoked - we just know evidence failed.
**Fix:** Every finally should have nested try/catch: write evidence in inner try, workspace cleanup in outer finally. Or write evidence *before* workspace cleanup so a cleanup failure doesn't lose evidence.

## [MEDIUM] Secret scrubbing pattern misses nonstandard key formats
**File:** live-harness.ts L137
**Trigger:** OpenRouter introduces a new key format `sk-or-new-...` or a non-`sk-or-` prefix entirely. Scrub regex `/sk-or-[A-Za-z0-9_-]+/g` misses it; plaintext key enters evidence JSON.
**Why it bites:** Evidence files are committed, quoted in PRs, attached to CI logs. A leaked key is real credentials exposure. The scrub assertion on L167 passes because it only checks for the *known* `sk-or-` pattern.
**Fix:** Scrub should be more aggressive or defensive: any string matching `/^sk-[a-z0-9-]{20,}/i` or similar entropy-detecting heuristics. Or use allowlist-based scrub: only keep known non-secret fields, redact everything else.

## [MEDIUM] Fleet lock acquired but never verified held during fanout refusal
**File:** tier1-fanout-refusal.live.test.ts L517-520
**Trigger:** `FleetLock.acquire()` succeeds internally but the on-disk lock file is not actually created (fsync delay, mount bug, timing issue). `fanout` subprocess launches, sees no lock, proceeds to provision. Test expects exit 5 but gets 0 or other; box is created, key minted, money spent.
**Why it bites:** The test's "fanout refuses when lock held" premise is false if lock acquisition didn't actually persist. We're testing the lock's *effect* on the verb, not the lock's *correctness*, but a broken lock implementation would pass this test if it never actually blocked anything.
**Fix:** After `lock.acquire()`, verify the lock file exists at the expected path before launching the subprocess. Or read the lock file contents and assert it contains the requestId.

## [LOW] runIdFor timestamp collision on fast runs
**File:** live-harness.ts L119-121
**Trigger:** Multiple VMs created within the same millisecond (rapid test runs, parallel tests). Random suffix space is only 0-9999, so collision probability is non-zero.
**Why it bites:** Two tests get the same runId, try to create boxes with the same name. One fails with "box already exists", the other succeeds. Attribution is confused; we don't know which test owns which box.
**Fix:** Use `crypto.randomUUID()` or increase random suffix to 6+ digits (1M space) and add a per-test counter to guarantee uniqueness within a test run.

## [LOW] Barrier poll timeout of 5s is arbitrary and may hide slow systems
**File:** tier1-lock.live.test.ts L868-873
**Trigger:** exe.dev is under load, SSH latency is high, or the first teardown is slow to reach the lock acquisition. 5s deadline expires, test fails with "did not create lock file within 5s".
**Why it bites:** False negative. The lock would have been created eventually, and the test would have passed contention proof, but we gave up too soon. CI flakes on bad network days.
**Fix:** Increase to 30s or make it configurable. Or better, remove the barrier entirely (see HIGH issue).

## [LOW] Git scratch clone assumes sha is directly fetchable
**File:** live-harness.ts L230-250
**Trigger:** Pinned SHA is not on a branch (detached HEAD, unpushed commit, shallow clone deleted from origin). `git fetch --depth=1 origin <sha>` fails, `scratchClone` throws.
**Why it bites:** T1.3b fails before the real test starts because the harness setup couldn't fetch the base commit. Test infra failure, not logic failure. Hard to distinguish "test bad" from "infra bad".
**Fix:** In a real scenario, the SHA should be on main. For e2e, assert this by trying `git fetch origin <sha>` early and failing with a clear "base SHA not fetchable" message, not a generic git error.
