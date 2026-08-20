# DF3 Hardening Doctrine — Extracted from DF1/DF2 Review Rounds

> Generated: 2026-08-20
> Source: DF1/DF2 review-round commits (~40 rounds across main branch)
> Mission: Encode hardened patterns as checklist for DF3 story revisions

---

## S1. Commit-Title Sweep — Review-Round Landscape

### Commit List (50 most recent review-round commits)

```
5912fa4 fix(df2-6): review round 5 — record createdAt ISO validation, reap hardening
43cd5b0 fix(df2-6): review round 4 — unparseable key age fail-safe, non-array list fail-closed
7942419 fix(df2-6): review round — fail-closed record recheck, contract tag removal, timeout leaf
526912d fix(df2-6): review round — env-tier quota limits path, prefix-aware fixture join
a845887 fix(df2-6): review round — help alias, reap bounds, atomic report claim, late-claim guard
ccacfce fix(df2-4): review round 17 — EPERM test reaps its deliberately-orphaned sleeper
cb924e4 fix(df2-4): review round 16 — EPERM is "owned", not ESRCH; name the settle upholders
a073bc2 fix(df2-4): review round 15 — destroy kills an orphaned exec's group too
6192b57 fix(df2-4): review round 14 — identity-gate group kills on leader liveness
8332294 fix(df2-4): review round 13 — fake-driver destroy kills the whole exec tree
d1d81e8 fix(df2-4): review round 12 — live e2e made runnable, SIGTERM teardown
16e883f docs(df2-4): review round 11 — exec boundedness is per-driver, not universal
9af9032 docs(df2-4): review round 10 — pin exec/destroy termination contract at ProviderDriver
454024d fix(df2-4): review round 9 — settle abandoned exec, cap-echo/403 gating
9427c81 fix(df2-4): review round 8 — fail-closed classifier inputs, redaction guard, workload reap
0ead37e chore(df2-4): sprint status review -> done after review round 7
79fa60e fix(df2-4): review round 7 — BMAD 3-layer sweep, 13 findings fixed incl. LOW
4bc338c fix(df2-4): review round 6b — fail-closed probe skip on unconfirmed workload termination
8cb2ee8 fix(df2-4): review round 6 — entry validation, phase timings, wall-clock cancel, complete mask scan
3e7bd96 fix(df2-4): review round 5 — CodeRabbit/Gemini sweep
f1d34f0 docs(df2-4): review round 4 — leakScan/scanArtifactForLeak docstrings cover key-management-URL fallback
078dee0 fix(df2-4): review round 3 — URL-safe Base64 ids, probe-error URL strip, honest O(n) comment
18fe6fe fix(df2-4): review round 2 — fail-safe record reads, finite-cap guard, fixture validation, probe-error status
5fdb7e9 fix(df2-4): review round — leak-scan dedupe, boundary mirror test, 402/403 contract, key-management-URL redaction, provenance narrative
ac5c76e fix(df1-8): review round 4 — drift gating split, fd-scoped chmod, catch-path tracer close, record sync
ab8f298 docs(df1-8): record BMAD review round 3 in story file — 1 LOW fixed, 3 layers clean
fa7383c fix(df1-8): review round 3 — drop dead `phases.rowid > 0` filter in readRunsByIssue
e335e3c fix(df1-8): review round 2 — echo issueId only when in 1..MAX_ISSUE_ID bounds
ad22503 fix(df1-8): review round 1 — issue-0 guard, lstat parent check, layer fix, covering index
4918628 fix(df1-6): review round 12 — jest unsafe-count fail-closed, RunFacts extraction, deterministic tests
51a7eb8 fix(df1-6): review round 11 — empty-key/run-root refusals, sub-timings contract, cost-micros guard, timing-test determinism
6f32555 fix(df1-6): review round 10 — exit-status union validation, early QDS_RUN_ROOT refusal, 17 guard/hardening patches
705b577 fix(df1-6): review round 9 — drain-timer arm-after-exit, per-line cap scan, partial-output truncation marker, abort/stop status guards
f2b9c15 fix(df1-6): review round 8 — CI-red unit boundary, fail-closed artifacts, watchdog param guards, 33 test hardenings
cfcb1a3 fix(df1-6): review round 7 — 52 source patches + test hardening
e5cb508 fix(df1-6): review round 6 — watchdog overflow wiring, manifest leak guard, test hardening
14b31ec fix(df1-6): review round 5 — adversarial 3-layer review, all 49 findings fixed
c2e1103 fix(df1-6): review round 4 — parse jest/vitest Tests lines with leading skipped/todo
33b5dbd fix(df1-6): review round 3 — all-failing jest/vitest parse, five-worker test confinement
92fba64 fix(df1-6): review round 2 — parser anchoring, abort-listener cleanup, adapter refusal
ee7e040 fix(df1-6): review round 1 — watchdog group probe, callback guards, test-result hardening
2257188 test(df2-5): review round 10 follow-up — assert artifactsServed against pre-call baseline
61da6fe fix(df2-5): review round 10 — flag-only isNoSuchBox, 64 KiB metadata cap, lock-cleanup guards
1066e8d fix(df2-5): review round 9 — rmBestEffort guard so cleanup never masks the typed error
723e0a9 fix(df2-5): review round 8 — fd-leak guard, runId charset guard, 12 test pins
eb20152 fix(df2-5): review round 7 — partial-copy cleanup, tar trailing-garbage rejection, hardening
71629a3 fix(df2-5): review round 6 — typed errno record classification, typed-flag test isolation
7543dfa fix(df2-5): review round 5 — shared getRecord classifier, typed noSuchBox flag, hardening
3dba7d1 fix(df2-5): review round 4 — BMAD 3-layer adversarial review remediation
450cb05 fix(df2-5): review round 3 — canonicalize tar entry names in assertPathSafe
```

### Theme Frequency Analysis

| Theme | Count | Example Commit | Where It Bites DF3 |
|-------|-------|----------------|-------------------|
| **fail-closed** | 8+ | `fail-closed probe skip on unconfirmed workload termination` | DF3.x — any parser/reader skipping on malformed input must fail-closed |
| **fail-safe** | 4+ | `fail-safe record reads, finite-cap guard` | DF3.x — unreadable state must default to safe/stale, not crash |
| **guard** | 15+ | `watchdog param guards`, `issueId bounds echo guard` | DF3.x — every external input needs bounds checks |
| **atomic** | 5+ | `atomic report claim`, `O_EXCL atomic creates` | DF3.3 (quota ledger), DF3.5 (artifact claims) |
| **timeout** | 3+ | `timeout leaf`, `phase timings`, `wall-clock cancel` | DF3.2 (exec spawn) |
| **kill/race** | 8+ | `group kills on leader liveness`, `destroy kills exec tree` | DF3.2 (process lifecycle) |
| **drift** | 3+ | `drift gating split`, `record sync` | DF3.1 (state sync) |
| **contract** | 4+ | `402/403 contract`, `termination contract` | DF3.x — all provider interfaces |
| **fixture** | 3+ | `fixture validation`, `prefix-aware fixture join` | DF3 test suites |
| **redaction** | 3+ | `key-management-URL redaction`, `redaction guard` | DF3.x — any logging/serialization |
| **EPERM/ESRCH** | 3+ | `EPERM is "owned", not ESRCH` | DF3.2 (process ownership) |
| **validation** | 6+ | `entry validation`, `exit-status union validation` | DF3.x — all trust boundaries |

---

[Sections S2-S6 to be appended incrementally...]
---

## S2. Story-File Review Records — Doctrine from Dev Records

### DF2.4 (Live Cap/Hit/Kill) — 17 review rounds, hardened patterns

**Key patterns from review rounds 2-4, 8-9, 15-17:**

- **Fail-closed probe transport:** `probe-error` status must be set on transport failure while staying fail-closed (round 2)
- **Fixture validation before shell construction:** non-string/empty model/prompt and non-finite paddingBytes must route to `finishEarly("workload-fixture-invalid")` (round 2)
- **KEY_MANAGEMENT_URL_RE broadening:** hash charset broadened to `[0-9a-zA-Z%-]{16,}` so encoding/format drift cannot leak a management deep-link (round 2)
- **NaN/Infinity guards:** non-finite record cap must fall back to requested cap (fail-closed) (round 2)
- **Atomic artifact writes:** 0700 dir / 0600 file / tmp+rename to prevent partial artifacts (implementation plan)
- **Wall-clock budget enforcement:** SIGKILL/exit-137; +1 s race backstop (implementation plan)

### DF2.6 (Quota Accounting Reaper) — 5 review rounds

**Key patterns from rounds 4-5:**

- **Unparseable createdAt fail-safe:** garbage timestamp made aged() NaN ⇒ permanently-young record the reaper never reaps; now assertWellFormed rejects unparseable createdAt (round 5)
- **Non-array list fail-closed:** quota checkHeadroom returns list-unverified (allowed:false) on a non-array list instead of crashing (round 4)
- **EPERM vs ESRCH semantics:** EPERM means "owned", not ESRCH; only ESRCH authorizes group-kill path (DF2.4 round 16)
- **Atomic report claim:** report filenames claimed atomically via writeFileSync `wx` + EEXIST suffix retry; existsSync loop was check-then-act (round 5)
- **Pre-destroy record recheck:** only typed ENOENT is known-absent; malformed/unreadable record refuses destroy (round 5)

### DF1.8 (Run Capture Issue Correlation) — 4 review rounds

**Key patterns:**

- **Replay discipline:** `replayed:true` → guarded tracer close, exit 0 before FileJournal/Run/walkPhases construction (round 1)
- **Fd-scoped chmod:** appendDispatchFailure uses O_NOFOLLOW (0600), refuses group/world-writable parents (`mode & 0o022`) (round 1)
- **OptionalColumn probe dead code:** references directly; unmigrated store fails loudly at prepare (fail-closed) (round 1)
- **Drift gating split:** full (repo_slug, issue_id) pair compare for mismatch detection (round 1)

### DF2.2 (ExeDev Driver Setup Gate) — 7+ review rounds

**Key patterns:**

- **Symlink TOCTOU guards:** per-component prefix walk in probe (IFS=/ split, relative paths supported) (round 7)
- **Env file mode re-check:** in-box script re-checks mode 0600 after sourcing (delivery-time verification existed, post-delivery drift did not) (round 7)
- **IFS/locale reset:** `IFS=' \t\n'` + `LC_ALL=C` reset after set -u (round 7)
- **Whitespace-only argv rejection:** `a.trim().length === 0` rejected (round 7)
- **Whole-gate budget enforcement:** budget = min(assertTimeout, max(1s, deadline-now)) on every exec (round 3)

### DF2.5 (Bundle Harvest Teardown) — 10 review rounds

**Key patterns:**

- **Two-pass INV-3 validator:** ustar header parse, hardlink/symlink/device/fifo/absolute/../ rejection before any byte written (dev record)
- **Tar trailing-garbage rejection:** trailing garbage after EOF block rejected (round 7)
- **Flag-only isNoSuchBox:** typed noSuchBox flag, not just error inference (round 10)
- **64 KiB metadata cap:** tar metadata cap enforced (round 10)
- **Lock-cleanup guards:** rmBestEffoint guard so cleanup never masks typed error (round 9)

---


## S3. Doctrine Inventory — Named Invariants

Each invariant: definition + origin (story/round) + DF3 application.

### FAIL-CLOSED DISCIPLINE

**Definition:** Any parser/reader encountering malformed/unparseable input must refuse processing and surface a typed error rather than defaulting to a "safe" value that could mask corruption. Applies to: createdAt timestamps, record reads, fixture inputs, provider contract responses.

**Origin:** DF2.4 round 2 (NaN cap fallback), DF2.4 round 2 (fixture validation), DF2.6 round 5 (createdAt ISO validation), DF2.6 round 4 (non-array list fail-closed)

**DF3 application:** DF3.1 (dispatcher state sync), DF3.2 (fan-out exec records), DF3.3 (quota ledger reads), DF3.5 (artifact claims)

---

### FAIL-SAFE READS (ORPHAN-PROTECTED)

**Definition:** Unreadable state (missing file, corrupt JSON, unparseable timestamp) must be treated as stale/orphan-safe, never crash. Distinguish "unreadable" from "empty" — unreadable keys are age-unavailable, reported, never revoked.

**Origin:** DF2.4 round 2 (fail-safe record reads), DF2.6 round 4 (unparseable key age fail-safe), DF1.8 round 1 (fd-scoped chmod + TOCTOU guards)

**DF3 application:** DF3.1 (trace store reads), DF3.3 (quota accounting store), DF3.4 (approval gate state)

---

### O_EXCL ATOMIC CREATES / LATE-CLAIM GUARDS

**Definition:** File-based claims (report files, artifact claims, quota entries) must use O_EXCL (or `wx` flag) to prevent race-condition overwrites. Check-then-act patterns (existsSync → write) are prohibited — use atomic rename-after-write or exclusive-create loops with bounded retry.

**Origin:** DF2.6 round 5 (atomic report claim with EEXIST suffix retry), DF2.4 (atomic artifact writes via tmp+rename)

**DF3 application:** DF3.3 (quota ledger admission), DF3.5 (resident orchestrator artifact claims)

---

### FS.WRITESYNC ON PROCESS-EXIT PATHS

**Definition:** When stderr is a pipe, async writes are truncated by process.exit. Critical error messages on exit paths must use fs.writeSync(2, ...) or process.stderr.writeSync to guarantee flush before termination.

**Origin:** DF2.9 round 1 (exitWithFailure flush race)

**DF3 application:** DF3.x CLI exit paths (dispatcher, fan-out, approval gate)

---

### URL-SAFE BASE64 IDS

**Definition:** All synthetic IDs (runId, box names, artifact refs) must use URL-safe Base64 charset (`[A-Za-z0-9_-]`) to avoid injection when interpolated into URLs, shell commands, or file paths.

**Origin:** DF2.4 round 3 (URL-safe Base64 ids)

**DF3 application:** DF3.1 (dispatch IDs), DF3.2 (fan-out request IDs), DF3.3 (quota account IDs)

---

### ISO-8601 CREATEDAT VALIDATION

**Definition:** Timestamps from untrusted sources must be validated ISO-8601 before Date.parse() — garbage timestamps produce NaN, breaking age calculations and causing permanent-young records.

**Origin:** DF2.6 round 5 (createdAt ISO validation)

**DF3 application:** DF3.3 (quota accounting age checks), DF3.5 (approval gate timestamps)

---

### FINITE-CAP GUARDS

**Definition:** All loops, retries, and accumulations must be bounded. Unbounded loops (retry storms, unvalidated arrays, recursive scans) are prohibited. Add explicit caps: max attempts, max entries, max bytes.

**Origin:** DF2.4 round 2 (finite-cap guard), DF2.6 round 5 (atomic report-name retry loop bounded to 1000)

**DF3 application:** DF3.1 (dispatcher retry loops), DF3.2 (fan-out scatter), DF3.4 (approval retry)

---

### TIMEOUT LEAVES + PHASE BUDGETS

**Definition:** Every async operation must have a timeout. Multi-phase workflows must enforce per-phase AND wall-clock budgets. Late phases check budget before starting; timed-out units report skipped/failed with identity.

**Origin:** DF2.6 round 5 (withTimeout + LIST_TIMEOUT_MS), DF2.4 (wall-clock budget enforcement)

**DF3 application:** DF3.2 (fan-out exec spawn), DF3.3 (quota accounting sweep), DF3.5 (approval gate wall-clock)

---

### EPERM-vs-ESRCH OWNERSHIP SEMANTICS

**Definition:** Process ownership checks: EPERM = "owned by other" (DO NOT signal), ESRCH = "no such process" (safe to group-kill). Never treat EPERM as ESRCH — pid recycling could kill unrelated privileged groups.

**Origin:** DF2.4 round 16 (EPERM is "owned", not ESRCH)

**DF3 application:** DF3.2 (fan-out process lifecycle), DF3.5 (resident agent bounds)

---

### GROUP-KILL OF PROCESS TREES

**Definition:** When destroying a VM/box, kill the entire process tree (leader + descendants). Orphaned descendants (e.g., `sh -c 'sleep 30 &'`) keep pipes open — use kill(pid, 0) to detect group ownership before SIGKILL.

**Origin:** DF2.4 round 15 (destroy kills orphaned exec's group), DF2.4 round 14 (identity-gate group kills)

**DF3 application:** DF3.2 (fan-out exec cleanup), DF3.6 (resident agent bounds enforcement)

---

### SETTLE-ABANDONED-EXEC

**Definition:** When a workload's direct child exits but background descendants survive (orphaned exec), destroy must settle the exec: kill the orphaned group, close pipes, return the leader's exit code (not 137). Bounded race (2s) to catch regressions.

**Origin:** DF2.4 round 9 (settle abandoned exec), DF2.4 round 15 (destroy settles exec with leader's exit code)

**DF3 application:** DF3.2 (fan-out exec lifecycle), DF3.6 (resident agent process cleanup)

---

### KEY-MANAGEMENT-URL REDACTION

**Definition:** URLs containing management/deep-link parameters must be redacted before logging/serialization. Regex pattern must be broad enough to survive encoding drift — `[0-9a-zA-Z%-]{16,}` not hex-only.

**Origin:** DF2.4 round 3 (KEY_MANAGEMENT_URL_RE broadening), DF2.4 round 2 (redaction guard)

**DF3 application:** DF3.x (any CLI logging provider URLs), DF3.3 (quota accounting logs)

---

### FD-SCOPED CHMOD

**Definition:** File modes must be checked immediately before use, not cached. Use O_NOFOLLOW for writes, refuse group/world-writable parents (`mode & 0o022`). TOCTOU gaps are unacceptable at trust boundaries.

**Origin:** DF1.8 round 1 (fd-scoped chmod + TOCTOU guards), DF2.2 round 7 (env file mode re-check)

**DF3 application:** DF3.1 (trace store writes), DF3.3 (quota ledger writes), DF3.5 (approval artifact writes)

---

### FIXTURE VALIDATION (FAIL-LOUDLY)

**Definition:** Test fixtures (workload configs, rosters, env files) must be validated before use. Malformed fixtures must cause loud, typed failures — never silent corruption or "best-effort" parsing.

**Origin:** DF2.4 round 2 (fixture validation), DF2.6 (prefix-aware fixture join)

**DF3 application:** DF3.x test suites (dispatcher fixtures, fan-out configs, quota fixtures)

---

### REGEX-MISMATCH-BY-DESIGN CASES

**Definition:** Some regex patterns intentionally reject valid-looking input (e.g., `slice(1)` admits only leading `/`). These are security-hardening features, not bugs. Document deviation from naive implementations.

**Origin:** DF2.2 review rounds (assertPathSafe empty-segment "bypass" rejected as false positive)

**DF3 application:** DF3.x (any path validation regex)

---

### `-h` HELP EXEMPTION IN CLI ARG VALIDATION

**Definition:** Strict CLI arg validation (`rejectStraySingleDash`) must exempt `-h` help alias. The `--help`/`-h` → help + exit 0 contract must be reachable in all CLIs.

**Origin:** DF2.6 round 5 (rejectStraySingleDash no longer eats `-h`)

**DF3 application:** DF3.x CLI tools (dispatcher, fan-out, approval gate, resident agent)

---

### ISSUEID BOUNDS ECHO GUARD

**Definition:** When echoing issueId from untrusted input, validate bounds (1..MAX_ISSUE_ID) before printing. Out-of-bounds values echo as literal string without numeric interpretation.

**Origin:** DF1.8 round 2 (echo issueId only when in bounds)

**DF3 application:** DF3.1 (dispatcher issue correlation), DF3.4 (approval gate issue refs)

---


## S4. Process Lessons — Development Practices

### BASELINE-TESTS-BEFORE-FIXES

**Pattern:** Run baseline tests BEFORE applying fixes to establish which failures are pre-existing vs. introduced by the change. Verify against a pristine main worktree.

**Evidence:** DF2.5 verification summary, DF2.2 review rounds noted pre-existing failures unrelated to story changes.

**DF3 application:** Always establish baseline `bun test` status before DF3 story implementation.

---

### FULL `bun test` NEEDS 240s TIMEOUT (~191s ACTUAL)

**Pattern:** Full repo test suite needs ~191s actual runtime; default 120s timeout is insufficient. Set 240s to accommodate CI variance.

**Evidence:** DF2.4, DF2.5, DF2.6 completion notes all reference 240s timeout requirement.

**DF3 application:** CI config for DF3 PRs must use 240s test timeout.

---

### TWO KNOWN LOAD-FLAKY TESTS (PASS IN ISOLATION)

**Pattern:** `tests/swarmclaw/e2e-demo.test.ts`, `tests/providers/exedev/setup-gate.test.ts` fail under full-suite load but pass 3/3 standalone. Cause: inter-suite interference.

**Evidence:** DF2.5 verification summary explicitly calls out these two tests.

**DF3 application:** Run these tests in isolation for DF3 verification; document flakiness, don't chase false positives.

---

### MULTI-SUITE RUNS CAN HANG FROM INTER-SUITE INTERFERENCE

**Pattern:** Running all test suites in parallel can cause hangs. Run suites individually for reliable verification.

**Evidence:** DF2.5 review notes, DF2.2 experience with frozen-clock test flaking.

**DF3 application:** DF3 verification: run suites separately (`tests/phase-engine/`, `tests/providers/`, `tests/scripts/`) in serial, not full parallel.

---

### REVIEW ROUNDS 1-17 HAPPEN — SPEC SHOULD FRONT-LOAD INVARIANTS

**Pattern:** Review rounds accumulated 17 rounds for DF2.4 alone. Most fixes hardened patterns that could have been specified upfront: fail-closed parsing, atomic creates, timeout budgets, ownership semantics.

**Evidence:** DF2.4 had 17 review rounds; DF2.6 had 5; DF2.5 had 10; DF1.8 had 4; DF2.2 had 7+.

**DF3 application:** DF3 story specs MUST encode these invariants upfront in "Security Invariants" and "Definition of Done" sections.

---


## S5. DoD Anti-Patterns — What DF1/DF2 DoD Got Wrong

### UNVERIFIABLE CHECKS

**Anti-pattern:** DoD items that cannot be mechanically verified (e.g., "operator can manually verify X"). These create review-round debt when reviewers demand proof.

**Evidence:** DF2.4, DF2.5 initially had unverifiable fixture checks; review rounds added test automation.

**DF3 guidance:** Every DoD item must have a test assertion or CI gate. Remove "manual verification" items.

---

### MISSING NEGATIVE/CRASH-MID-X TESTS

**Anti-pattern:** Testing only happy paths, not malformed input, crash-mid-operation, or adversarial cases. Review rounds repeatedly added these.

**Evidence:** DF2.4 rounds 2-4 added negative controls, crash-mid-teardown tests, probe-transport-failure tests. DF2.6 rounds added garbage createdAt, non-array list tests.

**DF3 guidance:** For every AC, add: negative control (malformed input), crash-mid-operation test, timeout/overshoot test.

---

### MISSING FAIL-CLOSED CASES

**Anti-pattern:** DoD asserts "X fails" but doesn't assert HOW it fails (typed error vs. opaque exception). Review rounds hardened these.

**Evidence:** DF2.4 round 2 added not-contains assertions for rejectionStatus; DF2.6 round 4 added list-unverified typed refusal.

**DF3 guidance:** Every failure case must assert: (1) typed error code, (2) no side effects (teardown ran), (3) log contains expected message, (4) NOT contains wrong signal.

---

### MISSING FIXTURE VALIDATION

**Anti-pattern:** Fixtures (workloads, rosters, env files) assumed well-formed without validation tests. Malformed fixtures caused silent failures.

**Evidence:** DF2.4 round 2 added fixture validation before shell construction; DF2.6 added prefix-aware fixture join.

**DF3 guidance:** All fixture files must have schema tests: reject malformed, accept valid, assert error messages on invalid.

---


## S6. Security Invariants That Actually Fired

### REVOKEHASH GUARDS (CREDENTIAL LIFECYCLE)

**Pattern:** Key revocation MUST verify the hash against the provider record before trusting revocation. Orphaned keys (no record) must NOT be revoked — they're already gone or never existed.

**Evidence:** DF2.6 round 4 — revoke unit with no recoverable hash records revoke-target-vanished failure, not silent skip.

**DF3 application:** DF3.3 (quota accounting key lifecycle), DF3.5 (approval gate credential cleanup)

---

### ONE-SECRET-PER-BOX

**Pattern:** Each sandboxed VM holds exactly one API key. Shared secrets across runs are prohibited. Key files are shredded on box destroy.

**Evidence:** DF2.3 architecture; DF2.5 teardown verifies no `<run-id>.key` appears under runs dir.

**DF3 application:** DF3.2 (fan-out box isolation), DF3.5 (resident agent credentials)

---

### CAP ENFORCEMENT PRE-SPAWN

**Pattern:** Spend caps must be enforced BEFORE the box is provisioned, not after. CheckHeadroom on createRun prevents over-limit allocation.

**Evidence:** DF2.6 checkHeadroom guards; DF2.4 enforcement lag measured (1.8× cap on first refusal).

**DF3 application:** DF3.2 (fan-out pre-allocation quota check), DF3.3 (quota accounting admission control)

---

### KEY-MANAGEMENT-URL REDACTION IN LOGS

**Pattern:** Any URL containing management/deep-link parameters must be redacted before logging. Regex must be broad enough to survive encoding drift.

**Evidence:** DF2.4 round 3 (KEY_MANAGEMENT_URL_RE broadened to `[0-9a-zA-Z%-]{16,}`)

**DF3 application:** DF3.x (any CLI logging provider URLs), DF3.3 (quota accounting logs)

---

### CREDENTIAL-URL GRAMMAR (NO USERINFO)

**Pattern:** Repo URLs with credentials (userinfo@host) are refused at the fill boundary. Credential-carrying URLs are a security violation.

**Evidence:** DF2.2 fill URL grammar rejects userinfo; INV-CRED-1 enforced.

**DF3 application:** DF3.1 (dispatcher repo refs), DF3.5 (approval gate repo URLs)

---

### LEAK SCAN ON EVERY ARGV CORPUS

**Pattern:** Every CLI/shell boundary must have a leak scan verifying no secrets (keys, URLs, tokens) appear in argv. IN_V-4 leak scan over entire argv corpus.

**Evidence:** DF2.2 INV-4 leak scan; DF2.2 setup-gate scans entire argv corpus.

**DF3 application:** DF3.x CLI tools (dispatcher, fan-out, approval gate, resident agent)

---

### FD-SCOPED MODE CHECKS (TOCTOU HARDENING)

**Pattern:** File modes must be checked at open time, not cached. O_NOFOLLOW for writes; refuse group/world-writable parents.

**Evidence:** DF1.8 round 1 (appendDispatchFailure O_NOFOLLOW + mode & 0o022)

**DF3 application:** DF3.1 (trace store), DF3.3 (quota ledger), DF3.5 (approval artifacts)

---

---

## ABSTRACT — Top Doctrine Patterns

**Top 10 patterns DF3 stories MUST encode:**

1. **FAIL-CLOSED PARSING** — malformed input (timestamps, records, fixtures) must surface typed errors, not default to safe values (8+ review rounds)

2. **FAIL-SAFE READS** — unreadable state treated as stale/orphan, never crash; distinguish "unreadable" from "empty" (4+ rounds)

3. **ATOMIC CREATES** — O_EXCL / `wx` flag for file-based claims; check-then-act prohibited (5+ rounds)

4. **TIMEOUT BUDGETS** — every async operation has timeout; multi-phase workflows enforce wall-clock budgets (3+ rounds)

5. **EPERM/ESRCH SEMANTICS** — EPERM = owned (don't signal), ESRCH = no-such-process (safe to group-kill) (3+ rounds)

6. **FIXTURE VALIDATION** — malformed fixtures fail loudly, never silent corruption (3+ rounds)

7. **REDACTION GUARDS** — URLs with management parameters redacted; regex broad enough for encoding drift (3+ rounds)

8. **FINITE-CAP GUARDS** — all loops/retries bounded; no unbounded accumulations (4+ rounds)

9. **GROUP-KILL PROCESS TREES** — destroy kills entire tree; orphaned descendants settled via kill(pid, 0) detection (8+ rounds)

10. **FD-SCOPED CHMOD** — modes checked at use time; TOCTOU gaps unacceptable at trust boundaries (4+ rounds)

**Report path:** `/Users/steve/QDS-Factory-df3/_bmad-output/workflow-state/qds-sprint-planning/df3-hardening/research/R3-hardening-doctrine.md`
