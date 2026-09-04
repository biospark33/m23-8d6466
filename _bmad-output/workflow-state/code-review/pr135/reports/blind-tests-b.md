# Blind Hunter — PR135 chunk `chunk-tests-engine-b.diff`

Scope: `tests/phase-engine/resident-e2e.test.ts` (new, 403 lines) + `tests/phase-engine/usage.test.ts` (walk-exclusion amendment). Reviewed from the diff alone; no repo access. Line numbers are approximate new-file lines.

---

### [HIGH] Runner stdout is piped but never drained — pipe-fill deadlock, orphaned process tree

- Location: `tests/phase-engine/resident-e2e.test.ts`:~98 and ~153 (`stdout: "pipe"` in `spawnRunner`; `await Promise.all([new Response(proc.stderr).text(), proc.exited])` in `runLeg`)
- Detail: `spawnRunner` sets `stdout: "pipe"` but `runLeg` consumes only `proc.stderr`. Nothing ever reads `proc.stdout`. A POSIX pipe buffer is ~64 KB; once the runner (or child output it relays to stdout rather than stderr — the test's own `jsonLines` comment proves the runner does relay child noise) exceeds it, the child blocks forever in `write(2)`, never exits, and `proc.exited` never resolves.
- Trigger: any leg where cumulative stdout volume crosses ~64 KB — a verbose build `testCommand` whose output is relayed, a large journal echo, or a debug banner printed per solicit. The leg hangs, bun's 60 s/120 s test timeout abandons (does not kill) the await, and the runner + fake-resident processes are left running holding the shared `$TMPDIR` counter file (see the shared-counter finding), corrupting every subsequent leg. One-line fix: `stdout: "ignore"` (or drain it like stderr).

### [HIGH] "Arming reads the brief's CONTENT" test has no negative control — cannot fail for the bug it names

- Location: `tests/phase-engine/resident-e2e.test.ts`:340–350 (`arming reads the brief's CONTENT, not requestId alone`)
- Detail: The leg drops `requestId` from the *witness file* but still passes `--request-id <uuid>` on the CLI (every `runLeg` call does — `opts.requestId` is unconditional in the args array). It then asserts only the positive outcome: `status === "active"`, `directives >= 2`. There is no companion leg with a witness that *lacks* the brief content (`repoSlug`/`issueId`/`effectiveCeilingMicros`) asserting the run does **not** arm.
- Trigger: change the runner's arming rule to `arm iff any requestId exists` (ignore witness content entirely). This test still passes — CLI `--request-id` is present, so it arms, status is active, directives ≥ 2. The test title's actual claim ("content, not requestId alone") is unfalsified by the suite. The missing leg is: witness `{}` (or content-free) + requestId present → `resident.status` must be `"disabled"`/absent.

### [HIGH] usage.test.ts amendment weakens the unit invariant without a compensating count assertion

- Location: `tests/phase-engine/usage.test.ts`:~170–185 (added `steeringPath` exclusion in the walk)
- Detail: The describe's entire purpose is "µ$ inside, USD only at **the one call site**" — the original walk enforced *exactly one* `/ 1_000_000` division in the engine (usage.ts), with everything else collecting into `others`. The amendment carves `steering.ts` out of the walk entirely, by path, with no assertion on how many divisions that file may contain. Zero, one, or forty `/ 1_000_000` in `steering.ts` all pass. The original property ("one call site") is now false and unreplaced: nothing pins the sanctioned site's count, direction, or shape.
- Trigger: (a) someone adds a second `/ 1_000_000` in `steering.ts` (e.g. a µ$→USD projection that belongs at the CLI boundary) — the unit invariant is silently double-broken and the test stays green; (b) someone converts `steering.ts`'s division from tokens→µ$ to µ$→USD (wrong direction) — green. The fix is the same size as the amendment: assert `/(\/\s*1_000_000)/g` occurs exactly N times in `steeringPath` (N = the count DF3.3 sanctions), keeping `others` for everything else. This is precisely the "was the assertion weakened to make it pass?" pattern; the comment block justifies the carve-out but does not restore the invariant's strength.

### [MEDIUM] Fixed-name counter file in the global `$TMPDIR` — cross-process corruption and permanent leak

- Location: `tests/phase-engine/resident-e2e.test.ts`:38–39, 81–83 (`STATE_NAME`, `stateFile()`), 137 (`fs.rmSync(stateFile(), ...)`)
- Detail: The build testCommand's invocation counter lives at `path.join(TMPDIR, "qds-resident-fixture-count")` — a fixed, non-unique, process-global path. Each leg resets it by deleting the file, then spawns a child that increments it. Two concurrent suite processes (CI shards, `--rerun-each`, a rerun overlapping a hung prior run, two developers) share that path: one leg's `rmSync` lands while the other leg's build is mid-run, and the other leg's attempt numbering shifts (its "attempt 1" becomes a pass). It is also never cleaned: `afterAll` removes only `tmpRoot`, so the counter file outlives the suite in the shared temp dir.
- Trigger: run the suite in two processes concurrently (matrix CI, or a retry-on-flake rerun while the first attempt's orphaned runner is still alive per the stdout finding). AC1a's byte-identity and AC1b's `attempt: 1 → gate_fail` assertions then fail intermittently with no reproducible cause. The file should live under `tmpRoot` (already unique per process) via an env seam, not in the shared tmpdir.

### [MEDIUM] No `proc.kill()` on any failure/timeout path — spawned process tree outlives the test

- Location: `tests/phase-engine/resident-e2e.test.ts`:~140–160 (`runLeg`); no `afterEach`/`try/finally` disposal anywhere in the file
- Detail: `Bun.spawn` handles are never killed. On the happy path the runner exits and the await resolves, so it is benign. On any hang (see the stdout deadlock) or on a bun test timeout, the await is abandoned and the runner plus its fake-resident child keep running, holding the journal file, the leg dir, and — worst — the shared counter file, which corrupts subsequent legs and the `afterAll` cleanup story.
- Trigger: any run that exceeds its test timeout. Add `try/finally` with `proc.kill()` (or an `afterEach` sweep) — the pattern the sibling `pipeline-run.test.ts` suites presumably already use.

### [MEDIUM] Telemetry test never asserts `exitCode === 0` — validates the journal of a possibly-failed run

- Location: `tests/phase-engine/resident-e2e.test.ts`:352–358 (top of `telemetry boundary` test)
- Detail: Every other test starts with `expect(<leg>.exitCode).toBe(0)`; the telemetry test goes straight from `runLeg` to reading the journal. A run that fails partway (nonzero exit) but still flushes a journal gets its `resident` block shape-asserted as if it were a successful run's.
- Trigger: introduce a regression where the run exits 1 after the build phase but the resident block was already written. The closed key-set assertions then pass against a crash artifact — and worse, they'd hide the crash, since `exitStatus`, `steeringIterations`, and `tripwires` on a failed run may have different shapes that this test would enshrine as "the spec's field set".

### [MEDIUM] AC1a's "strips were load-bearing" claim is not asserted; the timing allowlist is hand-closed

- Location: `tests/phase-engine/resident-e2e.test.ts`:178–199 (`TIMING_KEYS`, `stripped`), 218–226 (AC1a assertions)
- Detail: Two problems in one. (1) The comment says "the raw journals differ exactly by the resident block", but no assertion verifies that — the code checks only `proceed.journal.resident` is defined and the control's `resident.status === "disabled"`. The strips are never *proven* load-bearing: if `stripped` deleted nothing at all and the two journals happened to match, the test would still pass. (2) `TIMING_KEYS` is a hand-enumerated, closed set (`completedAt/startedAt/updatedAt/durationMs/subTimings/gate_exec_ms/gate_report_ms/gate_ms`). Any timing field outside the set — a future `residentSolicitMs`, `backoffMs`, `elapsedNs` — is compared raw, and since it is wall-clock-derived and differs between the two legs, AC1a fails spuriously.
- Trigger: (1) replace `TIMING_KEYS.has(k)` with a no-op filter — AC1a still passes, proving the guard is unverified; (2) add any new nondeterministic duration field to the journal under a name not in the set — AC1a goes flaky (it is inherently a two-leg timing comparison).
- Also: `stripped` deletes the whole `resident` key, so AC1a is blind to *everything* resident-side on the proceed leg (see the next finding).

### [MEDIUM] Proceed-path resident telemetry is never asserted — `directivesRejected` over-counting is invisible

- Location: `tests/phase-engine/resident-e2e.test.ts`:225–226 (AC1a checks only `toBeDefined`); 340–350 (arm-on-content checks only `status` + `directives >= 2`); demo/telemetry legs use STEERED and never check `directivesRejected`
- Detail: Across the whole file, `directivesRejected` is asserted exactly once — the roster leg, expecting 1. No test asserts a clean proceed-only run has `directivesRejected === 0` (or that `directives + directivesRejected === 3`, which would pin the accepted/rejected partition). AC1a strips the block; the demo and telemetry legs use STEERED and check neither counter's sum.
- Trigger: a regression that records a rejection entry for every accepted proceed directive (`directives: 3, directivesRejected: 3`). Every test in this file passes. A one-line `expect(proceed.journal.resident?.directivesRejected).toBe(0)` in AC1a closes it.

### [MEDIUM] `spendMicros` is type-checked only — the exact unit-conversion bug class this story touches passes

- Location: `tests/phase-engine/resident-e2e.test.ts`:291–292 (`typeof number`, `Number.isInteger`)
- Detail: The only numeric property of the spend is its type. Nothing asserts `spendMicros > 0`, a plausible magnitude, or that it changed between legs. Meanwhile the sibling `usage.test.ts` amendment exists *because* `steering.ts` does tokens→µ$ projection math — the highest-risk arithmetic in the story — and this e2e, the only test that observes the projected value end-to-end, would accept `spendMicros: 0`, `spendMicros: 3` (tokens, not µ$), or `spendMicros: 3000000` (µ$ off by 1e6) identically.
- Trigger: off-by-1e6 in `steering.ts`'s projection, or a hardwired `0`. Demo/telemetry/AC1b all stay green. At minimum assert `> 0` and an upper bound implied by the 250 µ$ ceiling witness.

### [MEDIUM] No retry-*authorization* negative test, though the header claims DF1.3 coverage

- Location: `tests/phase-engine/resident-e2e.test.ts`:7–12 (header claims "DF1.3's retry authorization … the R2 gap"), 229–262 (AC1b)
- Detail: Every run in the file has the retry authorized (ceiling 250 000 µ$ in the witness, first gate failure). Because the fake resident's contract is "last one repeats", a runner that retries unconditionally — ignoring the authorization decision entirely — would pass AC1b and the demo identically. The R2 gap is about *authorization*, and authorization's refusal path (ceiling exhausted, cap reached, perpetually failing build) is never exercised.
- Trigger: delete the ceiling check from the retry-authorization code path (always authorize). No test in this chunk changes behavior. Missing leg: a witness with `effectiveCeilingMicros: 0` (or a counter fixture that never passes) asserting the run stops rather than retrying, with the corresponding journal/exit shape.

### [MEDIUM] DOD-Security's "redacted" and "PRE-EXECUTION" claims are unasserted by the artifact test

- Location: `tests/phase-engine/resident-e2e.test.ts`:294–304 (demo artifact block)
- Detail: The comment asserts the §5.2 property ("every prompt and raw reply persisted PRE-EXECUTION, redacted"), but the code checks only: 6 files exist with the right prefix, prompt #1 has mode 0600, and prompt #1 contains the literal string `"repoSlug"`. Redaction is unverifiable here by construction — the fixture witness contains no secret, so there is nothing that *could* be redacted, and the test cannot detect a regression that stops redacting. "Pre-execution" ordering is likewise unobservable from a post-hoc `readdir` (only mtime ordering could approximate it, and that is not checked).
- Trigger: remove the redaction step from the prompt writer. Green. The comment should be cut to what is asserted (presence, count, mode, one content probe) or the fixture should carry a secret-shaped token plus an assertion that it is absent from the prompt files.

### [MEDIUM] Closed-set roster test covers only the invalid-roster path; gate authority via a *valid* selection is unexercised

- Location: `tests/phase-engine/resident-e2e.test.ts`:307–338
- Detail: The bypass attempt uses `rosterId: "no-such-role"` — rejection is trivially correct (unknown id). The dangerous case, a directive selecting a roster that *is* in DF1.5's closed set and whether the wiring still refuses to let it move gate authority, is never tested. The suite cannot distinguish "rejects bypass" from "rejects unknown ids".
- Trigger: a runner that validates the roster id but then applies the selection (mutating phase/roster routing mid-run) — every test here stays green.

### [LOW] Test timeouts are tighter than the runner's own budget, in the wrong direction

- Location: `tests/phase-engine/resident-e2e.test.ts`:143 (`--budget-ms 200000`), 227 (`120_000`), 262/305/338/350/408 (`60_000`)
- Detail: The runner is told it may run for 200 s; the tests allow it 60–120 s. On a loaded CI host (or if DF1.3 inserts a backoff sleep between gate fail and the authorized retry), the runner is legitimately still inside its budget when bun abandons the test — producing an orphaned process tree (see the kill finding) and a timeout failure that looks like a product bug.
- Trigger: any leg whose wall time lands between ~60 s and 200 s. Budget should be well under the test timeout, or the test timeout should exceed the budget.

### [LOW] `--no-resident` byte-identity test would not notice a resident that armed-but-never-solicited on the proceed leg

- Location: `tests/phase-engine/resident-e2e.test.ts`:225 (`expect(proceed.journal.resident).toBeDefined()`)
- Detail: The proceed leg's resident block is only checked for existence. `status: "active"` with `directives: 0` (armed, then the solicit path silently short-circuited) satisfies it, since AC1a strips the block and no other test uses PROCEED_ONLY replies to pin the full block.
- Trigger: a regression where the run_start solicit is skipped but the block is still written. Pair with the `directivesRejected === 0` fix in the same block.

### [LOW] Journal read gives a bare ENOENT instead of the captured diagnostics on a failed run

- Location: `tests/phase-engine/resident-e2e.test.ts`:156 (`JSON.parse(fs.readFileSync(journalPath, "utf8"))`)
- Detail: `runLeg` captures `stderr` and `exitCode` but parses the journal before either is examined. If a run fails early and never writes `out.json`, every test in the file fails with `ENOENT: no such file or directory` and the already-captured `stderr` — the one artifact that explains the failure — is discarded.
- Trigger: any regression that aborts before journal write (bad manifest, missing fixture, runner crash). Wrap in a check that fails with `stderr` in the message.

### [LOW] `0600` mode assertion is not portable to Windows

- Location: `tests/phase-engine/resident-e2e.test.ts`:302 (`fs.statSync(promptFile).mode & 0o777`)
- Detail: On win32, `mode` is synthesized and never reports `0o600`. If the suite ever runs on a Windows CI leg, this test fails regardless of product behavior.
- Trigger: `bun test` on Windows.

### [LOW] `toEqual` + `stable()` string comparison are redundant

- Location: `tests/phase-engine/resident-e2e.test.ts`:220–221
- Detail: For JSON-decoded data, `stable(stripped(a)) === stable(stripped(b))` is implied by `toEqual(stripped(a), stripped(b))` — the second assertion adds no discriminating power, only a second failure site with a worse (giant string) diff.
- Trigger: none behavioral; delete the second line or keep only the string form if the DOD literally demands text identity.

### [LOW] `toContain("exit 1")` matches `"exit 10"` and unrelated notes

- Location: `tests/phase-engine/resident-e2e.test.ts`:249, 252
- Detail: The evidence check stringifies the whole `checks` array and does substring matching. `"exit 10"`, `"exit 12"`, or a note that merely mentions "exit 1" satisfies `toContain("exit 1")`.
- Trigger: the fixture's failing command exits 10 instead of 1 — the "computed from real evidence" assertion still passes. Use a bounded match (`/exit 1\b/`) or assert the numeric field directly.

### [LOW] `jsonLines` silently discards unparseable lines — and interleaved relayed output can corrupt event lines

- Location: `tests/phase-engine/resident-e2e.test.ts`:163–175
- Detail: The `catch {}` is fine for noise, but if the runner's relayed child output is written without a trailing newline and interleaves with an event line on the same stderr stream, the event line gets prefixed/suffixed with foreign bytes and is silently dropped. The downstream assertions then fail as "expected undefined to be 'proceed'" with no hint that the line was eaten.
- Trigger: relayed output lacking a trailing newline, racing the runner's own event emission. Not a vacuous pass (it fails loudly) but a genuinely confusing flake.

### [LOW] `walkKeys`/`segmentsOf` have no positive self-check — the zero-ratio assertion can pass vacuously

- Location: `tests/phase-engine/resident-e2e.test.ts`:377–396
- Detail: If `segmentsOf` regressed to always return `[]` (or the split regex were mangled), `ratioKeys` stays empty and "ZERO ratio fields" passes against a journal full of ratio fields. There is no canary assertion proving the detector detects (e.g. `expect(segmentsOf("costRatio")).toContain("ratio")`).
- Trigger: break the splitter; the AC5 guard silently disables itself.

### [LOW] `arm-on-content` uses `toBeGreaterThanOrEqual(2)` where 3 is exact elsewhere

- Location: `tests/phase-engine/resident-e2e.test.ts`:349
- Detail: The run is the standard three-solicit shape, so `directives` should be exactly 3. `>= 2` passes with 2, so a regression that drops the third engine-owned solicitation point is invisible in this leg. (The demo leg does pin 3, so this is a weakening, not a hole — but the loose form invites copy-paste.)
- Trigger: n/a behavioral; tighten to `toBe(3)` for free.

### [LOW] `stateFile()` degrades to a cwd-relative path when `TMPDIR` is the empty string

- Location: `tests/phase-engine/resident-e2e.test.ts`:82
- Detail: `process.env.TMPDIR ?? os.tmpdir()` keeps `""` (empty string is not nullish), and `path.join("", name)` yields a relative path. The test process would then delete `<cwd>/qds-resident-fixture-count` while the child — spawned with `cwd: REPO_ROOT` — writes `<REPO_ROOT>/qds-resident-fixture-count` whenever the test is launched from elsewhere. The counter never resets, so attempt numbering carries across legs.
- Trigger: `TMPDIR=` in the environment (empty), suite launched from a directory other than the repo root. Use `os.tmpdir()` alone, or `TMPDIR || os.tmpdir()`.

### [LOW] e2e asserts `CORE_FIELDS` has exactly 13 src-level keys — unit concern embedded in an e2e

- Location: `tests/phase-engine/resident-e2e.test.ts`:398–404
- Detail: An unrelated story that grows DF2.1's run record to 14 fields fails this *e2e* file, sending the wrong signal about what broke. The resident slice's actual claim ("this story adds none") needs only "the run record's key set is unchanged from before the story", which is a unit test's job.
- Trigger: DF2.1 follow-up adds a field; the resident e2e goes red.

### [LOW] `directives` = accepted-count semantics are inferred, never pinned; `exitStatus` check is weak

- Location: `tests/phase-engine/resident-e2e.test.ts`:288–292, 320–321, 371
- Detail: The suite only coheres if `directives` counts *accepted* directives (roster: 2 accepted of 3 solicits; demo: 3 of 3) while `directivesRejected` counts refusals — but no test states that partition (e.g. `directives + directivesRejected === 3`), so a semantics drift in the producer would have to be noticed by hand. `exitStatus === null || typeof === "string"` excludes numbers/booleans but nothing else; a stringly-coded `"0"` exit code passes.
- Trigger: producer starts counting solicits instead of acceptances (`directives: 3` in the roster leg too) — the roster test fails confusingly rather than pinpointing the contract; `exitStatus: 0` (number) is correctly caught, `exitStatus: "0"` is not.

---

## Summary

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 3 |
| MEDIUM | 9 |
| LOW | 13 |

Highest-value fixes, in order: drain or ignore runner stdout (deadlock + orphans); add the content-absent negative control to the arming test (it currently cannot fail for its named bug); re-tighten the `usage.test.ts` invariant with a count assertion on `steering.ts`; move the counter file under `tmpRoot`.
