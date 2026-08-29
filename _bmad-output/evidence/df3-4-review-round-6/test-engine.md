# Test-quality adversarial review — PR #150, engine + e2e chunk

Scope: `tests/fleet/e2e/tier1-approval-gate.live.test.ts` (new, live/real-money),
`tests/phase-engine/steering.test.ts` (+147), `tests/providers/run-record.test.ts` (+198),
`tests/reverify/approval.test.ts` (edited expectation), `tests/reverify/runner.test.ts` (edited expectation).

---

### [BLOCKER] `pauseSucceeded` means "requestApproval returned", not "teardown ran" — a real box and a real minted key leak forever on any non-`fresh` outcome
**Where:** tests/fleet/e2e/tier1-approval-gate.live.test.ts:234 (flag set) and :341,:348 (cleanup guarded on it) — diff lines 240, 347, 354
**Weakness:** `pauseSucceeded = true` is set unconditionally on the line after `await requestApproval(...)`, *before* `expect(pause).toEqual({ outcome: "requested" })`. But `requestApproval` (src/fleet/approval-gate.ts:372-378) returns early WITHOUT calling `deps.teardown` for every non-`fresh` transition: `{outcome:"pause-in-progress"}` (:321), `{outcome:"already-decided"}` (:325), `{outcome:"rebound"}` (:352). Only the `fresh: true` path reaches `await deps.teardown?.(...)` at :393. So on any of those returns the flag says "the pause owns the destroy and the revoke" while nothing was destroyed or revoked, the very next `expect` throws, and both `finally` guards (`if (!pauseSucceeded && …)`) skip the box destroy and skip `revokeQuietly`.
**Regression that slips through / concrete leak:** any regression in the state read that makes a freshly-`create`d record take the `already-decided`/`pause-in-progress`/`rebound` branch (a bug in `expiredState`, in `TERMINAL`, in `readApproval`'s default, or a run-id collision with a stale record) leaves the exe.dev box created at :172 running and the OpenRouter key minted at :186 live and billable, indefinitely — and does so on exactly the run where the test reports FAIL, i.e. the run nobody trusts to have cleaned up. The order array already carries the true signal: gate cleanup on `order.includes("teardown-done")`, not on the flag.

### [HIGH] AC7's central claim ("the box is genuinely absent") has no positive control — it can pass vacuously
**Where:** tests/fleet/e2e/tier1-approval-gate.live.test.ts:243 (diff 249); the box is created at :172 (diff 178)
**Weakness:** `const vm = (await ctx.driver.create(runId)).name;` is captured and stored as `vmName`, but the test never asserts `vm === runId`, and never asserts that `ctx.driver.list(runId)` reports the box as PRESENT while it is alive. The post-teardown assertion `expect((await ctx.driver.list(runId)).some(b => b.name === runId)).toBeFalse()` is therefore the first and only `list()` call in the test. `ExeDevDriver.listWithAnomalies` (src/providers/exedev/driver.ts:242-259) *drops* rows whose `vm_name` is outside the factory grammar and *excludes* unreadable rows into an anomaly channel — so a name-shape or filter change makes `.some(b => b.name === runId)` permanently false, and the assertion the test file's own header calls "the whole of AC7" becomes a tautology.
**Regression that slips through:** the driver starts returning boxes under a prefixed/derived name (or `ls <name>` stops matching), so `list()` no longer sees the factory's own boxes — the fleet can no longer reap or account for live boxes — and this test still passes green, because "box gone" and "box invisible" are indistinguishable to it. One `expect(...).toBeTrue()` immediately after `create` (and `expect(vm).toBe(runId)`) closes it.

### [HIGH] The key-leak check RECORDS the leak and passes anyway
**Where:** tests/fleet/e2e/tier1-approval-gate.live.test.ts:357-362 (diff 363-368), `phase: "key-hash-delta"`
**Weakness:** the `finally` computes `leaked: [...after].filter(h => !hashesBefore.has(h))` and pushes it into the evidence JSON. Nothing asserts the array is empty. The header calls this "the comparison the skill requires", but a comparison whose result is only serialized is a log line, not a check. (The happy-path revoke *is* asserted at :244, but that assertion is unreachable on any failure before it — which is precisely when a key leaks.)
**Regression that slips through / concrete leak:** `teardownSandbox` revokes the key but the revocation-verify becomes a no-op, or a mid-test failure leaves a minted key live — the test fails on some *other* assertion, the operator reads "outcome: fail" and re-runs, and the live billable key is recorded in a JSON file nobody diffs. Also note `listedKeyHashes()` calls `keyApi.listAllKeys(10)`: if that bound is pages/entries and the account exceeds it, both `hashesBefore` and the delta are computed over a truncated population and the check is unsound even if asserted.

### [MEDIUM] `revokeQuietly` can throw out of the `finally`, killing the evidence write and the workspace cleanup and masking the real failure
**Where:** tests/fleet/e2e/tier1-approval-gate.live.test.ts:349 (diff 355); helper at tests/fleet/e2e/live-harness.ts:349-357
**Weakness:** `revokeQuietly` opens with `const rec = store.get(runId);` **outside** its own `try`. `store.get` throws on a missing/malformed record (`readRecord` → `unreadable run record …`), and the call site at :349 is not wrapped in `try/catch` (unlike the destroy above it at :340-347 and the ledger close below it at :351-356). A throw there skips `ledger?.close()` (SQLite handle left open), skips `writeEvidence` entirely, and skips `rmSync(workspace)` — and replaces the test's real error with the record-read error.
**Regression that slips through:** a mid-pause failure that also corrupts/removes the run record produces zero evidence and a misleading error, on the one run that most needs a forensic trail — and the key it was about to revoke is neither revoked nor reported.

### [MEDIUM] `lastDegradationReason` is write-only and never cleared; no test observes it across two solicitations
**Where:** tests/phase-engine/steering.test.ts:838 ("an EMPTY drain leaves the diagnostic **untouched**") and :805
**Weakness:** the "untouched" test builds a **fresh** `createSteering` and asserts `lastDegradationReason` is `null`. That proves the initial value, not that an empty drain leaves a prior value alone. In src/phase-engine/steering.ts the field is only ever assigned (:417, :458, :475, :491) and never reset — so no test distinguishes "latched forever" from "cleared on recovery" from "clobbered".
**Regression that slips through:** (a) a transient EACCES on one drain leaves `lastDegradationReason` reading "steering inbox unreadable" for the rest of the run even after the channel recovers, so the diagnostic permanently lies; or (b) someone adds a reset at the top of `solicit()` and a real inbox fault is wiped by the next healthy solicitation before anyone reads it. Both keep every test in this describe block green. The missing case is one instance whose `drain` throws on call 1 and returns `[]` on call 2, with the field asserted after each.

### [MEDIUM] An inbox fault and a caller degradation in the same solicitation: the inbox message is silently overwritten, and nothing covers it
**Where:** tests/phase-engine/steering.test.ts:805 (diff 394)
**Weakness:** every new test in the block pairs the broken inbox with a *healthy* `scriptedCaller([{raw:'{"action":"proceed"}'}])`. The drain guard writes `lastDegradationReason` at src/phase-engine/steering.ts:417, and the caller-failure / prompt-render / malformed-reply paths overwrite the same variable later in the same `solicit()` at :458, :475, :491. `expect(c.lastDegradationReason).toContain("steering inbox")` therefore only holds when nothing else degrades.
**Regression that slips through:** the realistic incident — an unreadable inbox *and* a sick resident (the two fail together when the box is wedged) — reports only the resident error, and the "the channel is broken, your queued message was never delivered" half is lost from the pull field. No test asserts what the field should hold when both fire, so any resolution (or none) is blessed.

### [MEDIUM] "fires once" is asserted over exactly one solicitation
**Where:** tests/phase-engine/steering.test.ts:852 (diff 441), title claims "fires once"
**Weakness:** the body performs a single `await c.solicit(...)` and asserts `seen` has length 1. That establishes "at least one fire per solicitation", not "once". Neither of the two behaviours the title distinguishes is pinned: fire-per-drain-attempt (log spam on every gate of a long run) and fire-once-then-latch-silent (a fault that recurs after a recovery is never re-reported) both pass.
**Regression that slips through:** the observer is changed to dedupe by detail string, so a channel that breaks, recovers, and breaks again notifies the operator exactly once and then goes quiet for the rest of the run — the original defect (silent inbox faults) restored through the back door, with this test still green. A second `solicit()` with the same broken inbox and an assertion on `seen.length` is the missing case.

### [MEDIUM] No coverage for a record written by the pre-DF3.4 build (legacy singular `supersededReportId` already on disk)
**Where:** tests/providers/run-record.test.ts:477-497 (diff 686-712) — the "no longer the singular" test only proves `set()` **rejects** the singular
**Weakness:** `validateExtensions(..., "read")` deliberately tolerates unknown extension fields (src/providers/run-record.ts:770-776), so a record paused by the previous build reads back still carrying `supersededReportId`, and `setLocked`'s `structuredClone(existing)` merge re-persists it on every subsequent write. Meanwhile `historyOf(existing)` in approval-gate.ts:340 finds no `supersededReportIds` array and starts the history at `[]`. Nothing in the diff constructs such a record and exercises read → rebind → decide against it.
**Regression that slips through:** an in-flight run paused before this PR is rebound after it; the previously displaced report id survives only in the dead scalar and is absent from the array the DoD names as the single source of truth, so DF5.2's "no decision may name a reportId absent from both `reportId` and `supersededReportIds`" gate refuses (or wrongly admits) that run at PR time. The suite cannot see it, because every test starts from a record this build wrote.

### [MEDIUM] Concurrency: `supersededReportIds` is a read-modify-write under a lock, and the lost-update window is untested
**Where:** tests/providers/run-record.test.ts (the whole new `strings` block) — no concurrent-writer case
**Weakness:** src/fleet/approval-gate.ts:330-352 documents the hazard verbatim ("two concurrent rebinds would each read `[a]` and write `[a,b]` / `[a,c]`, losing one displaced id") and relies on `withApprovalLock` for correctness. Every new test in this diff drives `set()` sequentially from one process; the array-append path is only exercised single-threaded. The lock the comment calls "load-bearing, not merely tidy" has no test in this chunk that would notice its removal.
**Regression that slips through:** the lock around the rebind branch is dropped or scoped narrower during a refactor; two concurrent reverifies each append to the same base and one displaced reportId is lost from the audit trail — exactly the failure the code comment predicts — with the whole suite green.

### [LOW] Only the first token-bearing subprocess is checked for token leakage
**Where:** tests/fleet/e2e/tier1-approval-gate.live.test.ts:292 (diff 298) vs the `reject` invocation at :310-314 (diff 316-320)
**Weakness:** `expect(approve.stdout + approve.stderr).not.toContain(APPROVER_TOKEN)` is asserted for `approve` only. The second `runFleetWithToken` (`reject`, the already-decided path) captures `stdout` into evidence at :315-320 with no equivalent assertion, and the already-decided branch is a *different* code path through the CLI's error/echo formatting.
**Regression that slips through / concrete exposure:** the already-decided refusal path starts echoing the submitted credential (e.g. an "authenticated as … with token …" diagnostic added to the non-happy branch); the token lands in stdout and in the committed evidence JSON, and no assertion fires. The harness scrubber only strips `sk-…` patterns and `OPENROUTER_PROVISIONING_KEY` (live-harness.ts:322-330) — an approver token matches neither.

### [LOW] Only the *rejecting* case is added for free-text `proposal`; no test proves a realistic proposal is accepted
**Where:** tests/providers/run-record.test.ts:521-529 (diff 733-737)
**Weakness:** the new assertion pins that `proposal: "/Users/steve/QDS-Factory/.sandbox/runs/run-c-20260828.bundle"` throws `/key material/`. `proposal` is caller-supplied free text and is deliberately not in `SHAPE_EXEMPT_PATHS`; the only accepting fixture anywhere in the file is `"ship it"` (:482) — short enough that no heuristic could reject it. There is no false-positive control: nothing asserts that a long, realistic proposal is written successfully.
**Regression that slips through:** the shape heuristic is loosened (drop the `mixedClass` requirement, or drop the `^[A-Za-z0-9+/=_.:-]+$` charset anchor so spaces stop saving the string) and ordinary proposals begin failing at write time — which aborts `requestApproval` at the `pausing` registration and makes a paused run unreachable. This suite would still pass, because its accepting fixture is two words long.

### [LOW] `expect(hashesBefore.has(hash)).toBeFalse()` is a near-tautology
**Where:** tests/fleet/e2e/tier1-approval-gate.live.test.ts:189 (diff 195)
**Weakness:** `hashesBefore` is snapshotted before minting, and the mint returns a fresh provider-side hash; the assertion cannot fail short of a provider hash collision. It costs a network round-trip and establishes nothing.
**Regression that slips through:** none directly — but it reads as a leak-detection assertion and is not one, which is how the real one (the `key-hash-delta` finding above) came to be left unasserted.

---

## Edited expectations (verified, not defects)

- `tests/reverify/approval.test.ts:66` — the removed `expect(ext?.supersededReportId).toBe("rv-1")` is replaced by `expect(ext?.supersededReportIds).toEqual(["rv-1"])`, and the outcome-side singular is still asserted six lines above at :57 (`expect(out).toEqual({ outcome: "rebound", supersededReportId: "rv-1" })`). The comment's claim checks out against src/fleet/approval-gate.ts:339-352 (record stores the array, outcome carries the derived scalar). **Not a PINS-A-BUG.**
- `tests/reverify/runner.test.ts:452` — same shape; the outcome-side `supersededReportId` is asserted unchanged at :445-448. **Not a PINS-A-BUG.**

Both edits reflect the intended record-side change rather than a green-washed failure. The gap they leave is the legacy-record case, filed above as its own MEDIUM.

---

**11 findings: 1 BLOCKER, 2 HIGH, 5 MEDIUM, 3 LOW.**
