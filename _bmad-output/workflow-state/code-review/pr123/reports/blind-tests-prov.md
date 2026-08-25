# Blind test review — provider-layer test chunks (pr123)

Reviewer: blind-tests-prov. Scope: chunk-t5a (cost-ledger, run-record), chunk-t5b (sandbox-teardown-cli, qds-cost, cap-hit-demo, fake-driver, step-log, credentials, budget-gate, driver-contract, reaper), chunk-t6 (exedev driver, visualizer auth*, bun-apis, tests/helpers.ts). Judged on the diffs alone.

---

**[HIGH] budget-gate tests compose admission+provision on a CostLedger opened at the library-default path, not the suite tmpdir**
- `tests/providers/budget-gate.test.ts` — `admitAndProvision` helper (diff hunk at new-file ~line 60): `new CostLedger({ readRunRecord: ... })` carries no `path` and no config; the surrounding `beforeEach`/`afterEach` shown in the diff only manage `dir` (records tmpdir), and no `QDS_COST_LEDGER_FILE` pinning appears anywhere in the hunk.
- Trigger: per `tests/scripts/qds-cost.test.ts`'s own documentation in this same PR, the default layout puts the ledger at the sibling `.sandbox/cost-ledger.db` of the caller's cwd — i.e. the repo's real sandbox when tests run from the root. The E2E demo test in this file ingests real spend events through this ledger, so (a) money rows accumulate in a shared, non-tmp db across local runs and suites, and (b) the "second dispatch over cap refused" assertion can go green for the wrong reason — refusal driven by spend left over from a previous invocation rather than by this test's own dispatches. Classic lying test + order dependence on the money path. Every other ledger-using fixture in these chunks isolates via `mkdtemp` + explicit path; this one is the outlier.

**[MEDIUM] SQL-shape pinning asserts only the FIRST match of the reservation predicate**
- `tests/providers/cost-ledger.test.ts` — "the reservation predicate is NULL-safe in the SQL itself…" (source-regex test, new-file ~line 1222).
- Trigger: `RegExp.exec(source)` returns one match. The same PR's transaction test establishes there is a prefetch read AND an in-transaction read of reservations; if either query's predicate regresses from `IS` to `=` while the other stays correct, the regex still finds the healthy one and the NULL-bind cap-bypass (every reservation vanishing under three-valued logic) ships green. Pin all occurrences (`matchAll`) or assert a count.

**[MEDIUM] Grace-window and close-retirement boundaries straddle by ±1 s; exact-equality semantics unpinned**
- `tests/providers/cost-ledger.test.ts` — "the expiry boundary is the grace window itself…" (`expiryMs ± 1000`), and "close-retirement fires once the close is past the cutoff…" (`cutoff = expiryMs + 1000`).
- Trigger: both readers' predicates are age-vs-cutoff comparisons; `<` vs `<=` at exactly the cutoff is unobserved. An implementer flipping the comparison direction-at-the-boundary (or clamping with `Math.max(0, …)` that shifts the cutoff by one tick) passes every straddle test. Same gap for the run-record tombstone mtime grace (aged by 50 s = "10× the documented 5 s", exact boundary untested).

**[MEDIUM] cap-hit-demo leak scan covers one log line, not the log stream**
- `tests/providers/cap-hit-demo.test.ts` — "leak scan: an exec wrapper echoing the delivery argv…" (~line 740).
- Trigger: `leakScan(key, JSON.stringify(line))` scans only the single `demo.deliver` error entry. The same error text (`timedLoggedStep` re-throws raw by design, and this demo's catch logs `e.message`) can also surface in a run-summary/final-status entry or a second operation's line; any sink other than the one asserted is unverified. Contrast `tests/providers/credentials.test.ts`, which scans the filtered array of all `credential.deliver` lines — and even that stops at operation boundaries. Scan the whole `logs` stream (and ideally the full stdout transcript) for the key.

**[MEDIUM] Shared driver-contract can no longer fail on an exedev implementation that refuses EVERY sweep**
- `tests/providers/driver-contract.test.ts` — lifecycle step 7 rewrite (~line 223).
- Trigger: the rewritten three-way branch asserts the RULE, but for a driver whose listing never carries a tag (exedev), only the refusal arm is reachable, and that arm asserts solely that the refusal names the orphan. An implementation drift that makes `reapRuns` refuse on a CLEAN listing too — a fleet-wide no-op reaper, i.e. unbounded orphan billing, the exact harm the suite cites — passes the contract for exedev. Nothing in the diff (t5b/t6) asserts a successful destroy-path sweep on a tagless driver with a clean population. Add a clean-listing positive case per driver shape.

**[MEDIUM] Visualizer static-confinement suite omits double-encoded, backslash, and mixed-case traversal encodings**
- `visualizer/test/auth-static.test.ts` — traversal tests (~lines 456–496).
- Trigger: covered are single-decoded `/..%2f…`, plain-dot `/../`, and a `%2f` chain. Absent: double-encoded `%252e%252e%252f` (decodes to `%2e%2e%2f` — catches servers that decode twice or normalize after decode), backslash forms `..%5c..%5c` (different normalizers treat `\` as a separator; also the Windows-hosted dev-server case), and uppercase `%2E%2E%2F`. Each is a distinct decoder bug class; the current set proves only "one decode pass collapses dots."

**[MEDIUM] Truncated-JSON run-record body is the one corrupt-input shape left untested**
- `tests/providers/run-record.test.ts` — quarantine/listing tests (~lines 1504–1575).
- Trigger: covered are zero-byte, unknown-key, bad-timestamp, EACCES, bad filename. A partial write (crash between write start and end) produces a TRUNCATED body — valid prefix, `JSON.parse` SyntaxError — which is the most probable real-world corrupt shape and is neither asserted as quarantined-with-reason nor as a hard error. If it happens to route through the same quarantine arm as unknown-key it is covered by accident, and nothing pins that routing.

**[LOW] Wall-clock performance assertion in redactor suite**
- `tests/providers/step-log.test.ts` — "a diagnostic full of `-----BEGIN` mentions redacts in linear time…" (~line 1102): `expect(Date.now()-started).toBeLessThan(2_000)` on ~1 MB input.
- Trigger: on a saturated CI runner a linear 1 MB regex pass plus GC pause can breach 2 s; the bound is generous but it is still a timing assertion that owns a flake vote. Prefer counting regex iterations via a seam or dropping the upper bound to a much looser ceiling.

**[LOW] Several lock tests sleep the full 5 s LOCK_TIMEOUT_MS with no elapsed upper bound**
- `tests/providers/run-record.test.ts` — "an unreadable lock body is held…", "a YOUNG own-pid foreign body is still HELD…", steal/release-unreadable pair, orphan-park (each `, 15_000`).
- Trigger: only the lower bound (`>= LOCK_TIMEOUT_MS`) is asserted; a runner stall turns a 5 s sleep into a >15 s test timeout failure. Cumulatively ~25–30 s of mandatory sleeping in one file. An injectable clock or a shortened configured timeout would remove both the flake surface and the suite cost.

**[LOW] "Only ONE retry" tombstone test asserts a bare `.toThrow()`**
- `tests/providers/run-record.test.ts` — "only ONE retry: a real record at the path is never overwritten" (~line 1635).
- Trigger: any throw satisfies it — including an EACCES/ENOENT from an unrelated fs fault — so the test cannot distinguish "correctly refused as EEXIST" from "crashed for another reason." Every neighboring test in this suite pins errno or error class; this one doesn't.

**[LOW] `process.ppid` retained as the foreign-live fixture in run-record lock tests despite the PR's own helper calling it unsafe**
- `tests/providers/run-record.test.ts` — "release never unlinks a lock this process no longer owns" and "a steal never unlinks a lock claimed after the corpse was cleared" (~lines 1938–2003), vs `tests/helpers.ts` `liveForeignPid()` docstring which names `process.ppid` as a fixture that "fails silently."
- Trigger: benign today (those two tests compare lock BYTES, not liveness, so ppid only needs to be a foreign pid), but the suite now carries two contradictory doctrines for the same fixture problem; the next person copying the ppid pattern into a liveness-sensitive test (as sandbox-teardown originally did with pid 1) inherits the silent-wrong-branch bug the helper exists to kill.

**[LOW] Sub-micro rounding tested only on the rounds-to-zero side**
- `tests/providers/cost-ledger.test.ts` — "a NONZERO cost that rounds to 0 µ$…" (~line 334).
- Trigger: `costUsd = 0.0000005` (rounds to exactly 1 µ$) and `0.0000004999…` straddle the rounding threshold; the priced/unpriced flip point itself is unpinned, so a rounding-mode change (truncate vs round-half) at the 1-µ$ boundary is invisible.

**[LOW] Aggregate-sum overflow untested — safe-integer guards cover per-event conversion only**
- `tests/providers/cost-ledger.test.ts` — safe-integer guards describe block (~line 1366+).
- Trigger: P2/P3/P5 pin `usdToMicros` on single events, but the gate SUMs `cost_micro_usd` across rows; many large-but-valid rows approaching `MAX_SAFE_INTEGER` in aggregate (possible with oversized custom caps/overrides, which the config tests allow) would lose integer precision in the cap comparison. No test drives cumulative spend toward that neighborhood.

**[LOW] JSON-escaped PEM bodies untested against the PEM arm**
- `tests/providers/step-log.test.ts` — PEM tests (~lines 1057–1100).
- Trigger: provider errors frequently embed `JSON.stringify`ed config, where the PEM's newlines arrive as literal `\n` two-character sequences on ONE line. The PEM block regex is line-oriented per the tests' own commentary; a single-line escaped key body exercises a different matching path than the multi-line fixtures here, and its residual-leak behavior (short base64 segments under the 40-char floor surviving the token arm) is unmeasured.

**[LOW] Hardcoded multiplier constants detached from the (unexported) values they mirror**
- `tests/providers/run-record.test.ts` — `WELL_PAST_GRACE_MS = 50_000` ("documented grace is 5 s"), `WELL_PAST_LOCK_GRACE_MS = 120_000` ("documented 60 s"), and the orphan-park survival backdate `120_000` inline (~lines 1590, 2155, 2303).
- Trigger: the suite's own convention elsewhere is derive-from-import precisely so a retune moves assertions along. Here a downward retune (say grace 5 s→60 s… or 60 s→30 s) keeps passing, but the "survives the next sweep" orphan assertion hardcodes 120 s independent of `OWN_LOCK_GRACE_MS`: raise the grace above 120 s and cleanStaleTemps eats the parked evidence while `lock.not-restored` still tells the operator to restore it — the exact scenario the test claims to guard, now unguarded.

**[LOW] auth-static fixture writes into a real build's `dist/` and removes only its own files**
- `visualizer/test/auth-static.test.ts` — `write()`/`afterAll` (~lines 390–415).
- Trigger: when a developer's real build exists (`createdDist === false`), fixture assets (`viz-fixture.js`, `viz fixture.txt`) are written INTO the shipped dist tree and removed only via the tracked list; a mid-run abort (unhandled rejection, ctrl-C) strands them in the build output. Cosmetic-to-confusing, but the suite's own "refusing to clobber" guard shows the authors care about that directory.

**[LOW] "Racing" admission test is a sequential simulation**
- `tests/providers/cost-ledger.test.ts` — "two dispatches racing one issue cannot both win…" (~line 533).
- Trigger: no actual interleave — the race is modeled by A simply not having a record yet when B runs, which is indistinguishable from a plain orphan. The genuine concurrent double-grant is covered only indirectly by the BEGIN IMMEDIATE lock probe (which proves locking, not the post-commit outcome under真 concurrency). Acceptable given SQLite serialization, but the title oversells what executes.

---

Coverage notes (no finding): secret-redaction matrix is unusually honest (prefix-arm-only fixtures under the 40-char floor, Google-key 39-char construction, leakScan fragment sweeps, `keep`-floor control); the canonical repo/issue identity suite covers pre-canonicalisation rows on both tables plus the #420 separation; the dual-entry `list()`/`listWithAnomalies()` hazard is fixed at both the reaper injection and the fake-driver observed-primitive test; env save/restore in qds-cost and fake-driver is correct; signal-handler and `process.exit` lock-release tests use readiness-line sync, not sleeps; the TOCTOU statSync spy is self-checking (`fired` assertions) throughout.
