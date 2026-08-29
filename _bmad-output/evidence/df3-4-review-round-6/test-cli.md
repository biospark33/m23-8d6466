# PR #150 — adversarial test review: CLI verb suites

Scope: `tests/fleet/gate-verbs.test.ts`, `tests/fleet/cli.test.ts` (AC7 hunk),
`tests/fleet/verbs.test.ts` (registry hunks), `tests/fleet/attach.test.ts`,
`tests/fleet/fixtures/approvers.json`.

---

### [HIGH] The injected `authenticate` ignores its arguments, so nothing proves `--approver` reaches authentication
**Where:** tests/fleet/gate-verbs.test.ts:56-66 (`authOk` / `authRefused`), consumed by every test in the file (e.g. :163, :176, :228)
**Weakness:** `authOk = (approverId = "alice") => ({ authenticate: async () => ({ ok: true, approverId }) })` — a zero-parameter closure. It never inspects the `hostRoot` or `approverId` the CLI hands it, and the `approverId` it *returns* is the closure default, not the argv value. `scripts/fleet.ts:2412` calls `(deps?.authenticate ?? authenticateFromStdin)(process.cwd(), approverId)` and `:2440` records `approverId: auth.approverId`. So the assertion `expect(printed).toMatchObject({ approverId: "alice" })` (:169-172) is asserting a value the *test fixture* supplied, not one that travelled through the CLI. No test in the file asserts what the CLI passes into `authenticate`.
**Regression that slips through:** swap the argument order at fleet.ts:2412 to `(approverId, process.cwd())`, or pass a hard-coded `""` / the `runId` instead of the parsed `--approver` value. Every test in gate-verbs.test.ts stays green (the injected fn discards both args and answers "alice"), while production authenticates against the wrong allowlist root or the wrong approver id — i.e. INV-CRED-3 is silently disarmed. Only the live tier-1 demo would catch it.
**Fix shape:** have `authOk` record its arguments and assert `[process.cwd(), "alice"]`, and derive the returned `approverId` from the argument rather than a closure default.

### [HIGH] `attach`'s success path is never exercised at the CLI layer
**Where:** tests/fleet/gate-verbs.test.ts:315-397 (`describe("fleet attach")`)
**Weakness:** every attach test asserts a *failure* code — 2 (:316, :341, :357), 5 (:322, :331), 6 (:366), 4 (:392). There is no test where attach succeeds, so the `attach-acked` → exit 0 mapping, and the stdout JSON emitted on success, are asserted nowhere in the unit suites. `tests/fleet/attach.test.ts` exercises `attachToRun` directly and stops at its return value; it never goes through `run()`. And the registry↔CLI probe loop that would otherwise pin exit 0 is explicitly skipped for `attach` (verbs.test.ts:1232).
**Regression that slips through:** map `outcome === "attach-acked"` to exit 6 (or to 1), or drop the success `sink(JSON.stringify(...))` line, in the `verb === "attach"` block of scripts/fleet.ts. Nothing in this PR's unit tests turns red; `fleet attach` reports failure on every successful steer, and any automation branching on exit 0 stops working.

### [HIGH] The exit-code probe loop is skipped for all three new verbs, and codes 1 and 6 are exercised for none of them
**Where:** tests/fleet/verbs.test.ts:1229-1232 (`PROBES_OWED_ELSEWHERE`), plus tests/fleet/verbs.test.ts:288-303 (new registry test declaring `[0,1,2,4,5,6]`)
**Weakness:** the registry declares `exitCodes: [0,1,2,4,5,6]` for `approve`, `reject` and `attach`, and the one mechanism that cross-checks a declared code against a real invocation (`for (const probe of probes)`) is `continue`d for exactly these three. The test comment claims the behavioural coverage "lives in tests/fleet/gate-verbs.test.ts" — but gate-verbs asserts 0/2/4/5 for approve/reject and 2/4/5/6 for attach. **Exit 1 is asserted for none of the three verbs anywhere; exit 6 is asserted for none of approve/reject; exit 0 for none of attach.** The declaration is therefore an unverified claim, and DF3.5 generates skill contracts from it.
**Regression that slips through:** (a) `approve` grows a real transient path that returns exit 1 that the registry does declare but no code path actually produces — or worse, produces exit 3 (never declared) on a store write failure; the registry and the CLI drift apart with no red test. (b) Someone removes `6` from `approve`'s declared codes while `finish()` still folds an EAGAIN stdout into 6 — the generated skill treats a real exit 6 as "undocumented crash". Both are precisely what the probe table exists to prevent, and it has been switched off for the three newest verbs.

### [HIGH] The three new verbs have no exact flag-table snapshot — a secret-bearing flag could be added to the registry with every test green
**Where:** tests/fleet/verbs.test.ts:288-303 (new test) vs. tests/fleet/verbs.test.ts:434-442 (`for (const verb of ["dispatch","status","harvest","teardown","fanout","rank"])`)
**Weakness:** the six pre-existing verbs each get `expect(flags).toEqual(EXPECTED_FLAGS[verb])` — an exact, order-normalised snapshot of every flag name, `required` bit and `valueType`. The DF3.4 loop was NOT extended: the new test only asserts `--driver` presence/absence/`required` and `--help` presence. Nothing pins the *complete* flag set for `approve`, `reject`, `attach`. The undeclared-flag sweep at :1641 only proves a verb refuses flags it does *not* declare, so it cannot see an extra *declared* flag.
**Regression that slips through:** add `{ name: "--approver-token", required: false, valueType: "string" }` to `approve` in `src/fleet/verbs.ts` plus a `flags.get("--approver-token")` fallback in fleet.ts. Every test in this PR passes — including the "no token leaks" tests, which never supply a token. DF3.5 then generates a skill whose call signature puts the approver's secret on argv, visible in `ps`, which is the exact invariant fleet.ts:2372 documents ("its token arrives on stdin, never as a flag"). Also catches the milder case: a stray `--report-id` or `--force` flag added to `reject` with no test noticing.

### [MEDIUM] Both "no secret leaks" tests run without a secret in the process — there is no needle in the haystack
**Where:** tests/fleet/gate-verbs.test.ts:150-156 and tests/fleet/gate-verbs.test.ts:423-433
**Weakness:** both tests use the injected `authOk`, which never receives or returns a token, so no token-shaped string exists anywhere in the invocation. `expect(all).not.toMatch(/token/i)` and `expect(serialized).not.toMatch(/sk-[a-zA-Z0-9]{8,}/)` therefore assert only that the *word* "token" and an `sk-` prefix are absent from output that was never given either. A leak scan whose needle is never planted proves nothing about redaction.
**Regression that slips through:** fleet.ts starts echoing the authenticated credential into the decision envelope or the log line under a key like `secret`, `credential` or `auth` — with a real value such as `fake-approver-token-alice` (which contains neither the literal `token` boundary the regex expects to be absent... it does contain "token", but only because the fixture happens to spell it; a value like `hunter2-9f3a` would not). Both tests stay green. Fix: make `authOk` return/echo a known sentinel (e.g. `NEEDLE = "s3cr3t-needle-9f3a"`), assert it is absent from `out`/`err`/log entries, and assert a positive control that the needle *would* have been found if present.

### [MEDIUM] The argv-hygiene control matches literal substrings only — an encoded payload in argv passes
**Where:** tests/fleet/attach.test.ts:156-179
**Weakness:** the loop asserts `argv` does not `toContain` any of `NASTY`, `messageId`, `REQUEST_ID`, `"he said"`, `"whoami"` — all raw substrings. `expect(recorder.execCalls.some((c) => c.hadStdin)).toBeTrue()` only proves *some* exec had stdin (`RecordingDriver` records presence as a boolean, never content — tests/providers/fixtures/recording-driver.ts:57), not that the append call carried the payload.
**Regression that slips through:** rewrite the append leg as `sh -c 'echo <base64> | base64 -d >> inbox'`. The payload is still fully visible in the box's `ps` output — which is the entire point of AC6's negative control — but no literal token from the list appears in argv, and the ack still arrives, so the test stays green. Fix: assert the append call's argv contains no encoding of the payload (or, more robustly, that the exec whose argv contains `inbox.ndjson` is exactly the one with `hadStdin === true`, and that its argv length is bounded well below the message length).

### [MEDIUM] "refused before any store is built" asserts an ordering property that nothing observes
**Where:** tests/fleet/gate-verbs.test.ts:104-112
**Weakness:** the test passes a malformed run id AND a nonexistent `--dir`, then asserts `code === 2` and `!existsSync(missing)`. Both guards — the run-id grammar check and `assertRecordsDirUsable` — return 2, and neither creates the directory (the very next test, :114-119, proves the dir guard alone produces exactly the same two observations with a *valid* run id). So the two outcomes are indistinguishable and the stated property ("the id grammar refuses ahead of the --dir probe") is unasserted.
**Regression that slips through:** move the run-id grammar check *below* the `--dir` probe. The test stays green while the refusal an operator sees for `fleet approve 'NOT A RUN ID' --dir /good/dir` changes — and, more importantly, a store gets constructed (and its dir chmod'd 0700 / temps swept, per the comment at fleet.ts:2381-2384) for an argv that could never name a run. Fix: assert the refusal *code/message* is the id-grammar one, not the dir one.

### [MEDIUM] The AC7 status double returns the same record for every `get()` and only ever holds one row
**Where:** tests/fleet/cli.test.ts:3658-3665 (`rowFor`)
**Weakness:** the double is `{ listWithAnomalies: () => ({records:[rec], skipped:[]}), get: () => rec }` — `get` ignores its argument. Every AC7 assertion about the *binding* between a row and its approval extension (`row.reportId === "rep-1"` at :3675, `row.expiresInMs` at :3701-3706) is therefore unfalsifiable: with one record and an id-blind `get`, any join produces the right answer. The multi-row test at :3755 has a second record, but it is a *corrupt* one that gets skipped, so still exactly one approval extension in play.
**Regression that slips through:** the AC7 branch in `statusAll` reads the approval extension via `store.get(records[0].runId)` (or caches the first record's extension across the loop) instead of the row's own id. With two paused runs bound to different reports, `fleet status` shows every paused run the *first* run's `reportId` and `expiresInMs` — an operator approves against the wrong report. Nothing here reds. Fix: one `rowsFor` case with two paused records carrying distinct `reportId`/`expiresAt`, asserting each row gets its own.

### [LOW] The `--reason` cap test is satisfied by a dropped or garbled reason
**Where:** tests/fleet/gate-verbs.test.ts:243-248
**Weakness:** `expect(String(store.get(RUN).extensions?.approval?.reason).length).toBeLessThanOrEqual(1_000)` — `String(undefined)` is `"undefined"` (length 9), so the assertion holds if the reason is dropped entirely, truncated to one character, or replaced with a placeholder. The exit code is not asserted either, so it is not established whether over-length is a truncation (exit 0) or a refusal. (The `reason: "ship it"` assertion at :173 rescues the total-drop case, but not truncation-to-garbage.)
**Regression that slips through:** the cap is implemented as `reason.slice(0, 1)` or `reason.slice(-1000)` (keeping the tail instead of the head). Green. Fix: `expect(reason).toBe("x".repeat(1000))` and assert the exit code.

### [LOW] `PROBES_OWED_ELSEWHERE` equality is sensitive to registry declaration order
**Where:** tests/fleet/verbs.test.ts:1229-1230
**Weakness:** `expect(listVerbs().filter(...).map((v) => v.verb)).toEqual(["approve","reject","attach"])` compares arrays, so it encodes the order the three verbs happen to appear in `src/fleet/verbs.ts`, not the set the comment describes ("asserted as an EXACT set").
**Regression that slips through:** none behavioural — but reordering `reject` before `approve` in the registry (a pure declaration reshuffle, e.g. alphabetising) reds a test that has nothing to do with ordering, and the failure message points at probe coverage rather than at ordering. Fix: compare sorted arrays or `new Set`.

### [LOW] Dead assertion: `not.toBe("boxMissing")` is implied by the line above it
**Where:** tests/fleet/cli.test.ts:3672-3673
**Weakness:** `expect(row.state).toBe("awaiting-approval")` already excludes every other value; the follow-up `expect(row.state).not.toBe("boxMissing")` can never fail independently. The named property ("never boxMissing") is carried entirely by the positive assertion, so the extra line adds coverage the reader believes exists and does not.
**Regression that slips through:** none additional — flagged because it makes the AC7 block read as if the boxMissing path is separately pinned when it is not. The genuinely uncovered variant is a paused record whose approval extension is present but whose `state` is an unrecognised string (typo, or `schemaVersion: 2`): nothing asserts that falls back to `boxMissing`/`closed` rather than being treated as paused.

### [LOW] `--approver` with an empty value, and `attach` with `--message` absent entirely, are never exercised
**Where:** tests/fleet/gate-verbs.test.ts:91-96 (missing `--approver`), :353-360 (whitespace `--message`)
**Weakness:** arg parsing for the new verbs is tested for *absent* `--approver` and *whitespace* `--message`, but not for `--approver ""` (empty value present) nor for `attach` invoked with no `--message` flag at all. Combined with the injected-auth finding above, an empty approver id would flow straight into the real `authenticateFromStdin`.
**Regression that slips through:** the required-flag check is `flags.has("--approver")` rather than a non-empty check, so `fleet approve <run> --approver ''` reaches `authenticateApprover(root, "", token)`. Fail-closed today only because `""` is absent from the allowlist — a future "empty id means the single configured approver" convenience would be untested. Likewise `attach <run> --driver fake` with no `--message` is never proven to refuse rather than queue an empty steering line.

### [LOW] Live-box teardown sits at the end of the test body, not in a `finally`
**Where:** tests/fleet/attach.test.ts:150 (`await driver.destroy(vm)`) and the same trailing line in every test at :179, :192, :212, :230, :244, :264, :292, :313
**Weakness:** any failing `expect` above the last line aborts before `destroy`, so a red test leaves the FakeDriver box un-destroyed. The `afterEach` `rmSync(dir, …)` removes the directory but does not run the driver's own teardown path, so driver-internal bookkeeping (and any child process still holding the box) is not unwound. Contrast tests/fleet/gate-verbs.test.ts:366-380, which *does* use `try/finally` for its boxes dir.
**Regression that slips through:** none in green runs; on a red run a leaked box can turn a single assertion failure into cascading failures in sibling tests of the same file, obscuring the real defect. Fix: `try { … } finally { await driver.destroy(vm) }` or a per-test `afterEach` that destroys any box created.

### [LOW] Attach tests run under a 30 s default ack ceiling inside a 20 s test timeout
**Where:** tests/fleet/attach.test.ts:125 (round-trip), :181, :195, :247 — all pass `{ pollIntervalMs: 20 }` but leave `ceilingMs` at `ATTACH_ACK_CEILING_MS` (30 000, pinned at :224)
**Weakness:** if the ack never arrives, `attachToRun` polls for 30 s while the test's own timeout is 20 s, so the failure surfaces as a bun-test timeout rather than as `expect(result.outcome).toBe("attach-acked")`.
**Regression that slips through:** none silently — but a real regression in the ack-read leg reports as "test timed out after 20000ms" with no indication of *which* assertion would have failed or what the observed outcome was, and (per the previous finding) skips the box teardown. Fix: pass an explicit `ceilingMs` (e.g. 5 000) in the tests that expect an ack, as :219 and :303 already do for the tests that expect a miss.

### [LOW] `tests/fleet/fixtures/approvers.json` carries a second approver no test uses, and its salted hashes are opaque
**Where:** tests/fleet/fixtures/approvers.json (whole file); consumed only at tests/fleet/approvers.test.ts:264-267
**Weakness:** the fixture's shape matches the loader (`{version, approvers:{id:{salt,hash}}}`) and the file is copied into a tmpdir and `chmod`'d by `writeAllowlist` before use, so the git-doesn't-preserve-0600 hazard does **not** apply here. The real weakness is that only `alice@example.test` is ever authenticated (`FIXTURE_TOKEN = "fake-approver-token-alice"`, approvers.test.ts:49); `bob@example.test`'s hash corresponds to a token recorded nowhere in the repo, so nobody can regenerate or verify it, and no test asserts that a *second* registered approver authenticates.
**Regression that slips through:** a loader change that reads only the first key of `approvers` (e.g. `Object.values(map)[0]`) authenticates alice correctly and silently locks bob out; no test exercises the second entry. Fix: either document bob's plaintext sentinel alongside alice's and add an authenticate case for it, or drop the unused entry so the fixture does not imply coverage that does not exist.

---

**Summary: 14 findings — 0 BLOCKER, 4 HIGH, 4 MEDIUM, 6 LOW.**
