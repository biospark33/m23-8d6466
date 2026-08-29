# Test-quality adversarial review — `tests/fleet/approval-gate.test.ts`, `tests/fleet/approvers.test.ts`

Scope: `/tmp/pr150-review/chunk-tests-gate.diff` (1114 lines). Implementation cross-checks against
`src/fleet/approval-gate.ts`, `src/fleet/approvers.ts`, `src/providers/run-record.ts`, `scripts/fleet.ts`.
Diff-relative lines are given as `diff:N`; real test-file lines were computed as `diff-6` (approval-gate)
and `diff-670` (approvers) and verified against the file headers.

---

### [HIGH] `withApprovalLock` — 90 lines of stale-lock reclamation with no test that can fail
**Where:** tests/fleet/approval-gate.test.ts:326 (`diff:332`, "CONCURRENT decisions serialize"); `withApprovalLock` is exported from `src/fleet/approval-gate.ts:92` and, per `grep -rn withApprovalLock --include=*.ts`, has **no test anywhere in the repo** — the only other hit is a prose comment in `src/fleet/attach.ts:184`.
**Weakness:** The one concurrency test issues both `submitDecision` calls from the *same process*, so the loser hits `EEXIST`, finds its **own live pid** in the lock file, and polls. Every interesting branch of the lock is therefore unreachable from this suite: stale-age detection (`LOCK_STALE_MS`, gate:122), pid-liveness (`isLockHolderDead`, gate:78), the atomic rename-claim and the "captured a live replacement, restore it" path (gate:132-159), the `claimed` fail-closed rule (gate:163), and the 5 s timeout throw (gate:166). The test establishes only "two in-process awaits do not interleave", which is nearly free in a single-threaded runtime.
**Regression that slips through:** Change `isLockHolderDead` to `return true` on any `process.kill` error (i.e. treat `EPERM` — a live process owned by another user — as dead). A second host process now steals a live holder's lock, both read `awaiting-approval`, both write, and **first-decision-wins is silently broken across processes**. Every test in both suites stays green. Same for deleting the `if (claimed) throw err` fail-closed guard, or setting `LOCK_STALE_MS = 0`.

### [HIGH] The proposal/reason truncation caps are exported, documented as story guards, and never asserted
**Where:** tests/fleet/approval-gate.test.ts — nowhere. `MAX_PROPOSAL_CHARS` / `MAX_REASON_CHARS` / `capText` (`src/fleet/approval-gate.ts:200-201,244-250,314,463`) appear in **zero** test files (`grep -rn "MAX_PROPOSAL_CHARS\|MAX_REASON_CHARS\|capText" --include=*.ts`). The happy-path decision test (tests/fleet/approval-gate.test.ts:270, `diff:276`) writes `reason: "looks right"`, far under the cap.
**Weakness:** `capText` is non-trivial arithmetic with a stated invariant ("truncate to `max` INCLUDING the suffix, so the cap is the cap") and a defensive `suffix.length >= max` branch. No test feeds any input at, above, or near either cap, so neither the cap nor the "including the suffix" semantics is pinned.
**Regression that slips through:** Rewrite `capText` as `text.slice(0, max) + suffix` (off-by-`suffix.length`, exceeds the documented cap) or delete the call entirely — an 8 MB `proposal` from a re-verify report is then written verbatim into the run record on every pause, bloating a file that `fleet status` reads on every invocation. All 34 gate tests stay green.

### [HIGH] `authenticateFromStdin` — the only function production calls — has no test at all
**Where:** tests/fleet/approvers.test.ts:414 (`diff:1084`) exercises `readTokenFromStdin` in the child; every other test calls `authenticateApprover` directly with a token string. `authenticateFromStdin` (`src/fleet/approvers.ts:391`) is referenced only by `scripts/fleet.ts:2412` and by its own definition.
**Weakness:** The suite tests both halves in isolation and never the composition. The composition is where the argument wiring lives: `authenticateApprover(hostRoot, approverId, read.token, file)` — four positional arguments, three of them strings.
**Regression that slips through:** Swap the 2nd and 3rd arguments (`approverId` ↔ `read.token`) — every decision refuses with `approver-unknown` in production while both suites stay green. Worse in the other direction: change `if (!read.ok) return { ok: false, refusal: read.refusal }` to fall through and call `authenticateApprover(..., "")` — a caller with *no token attached* would be authenticated against any allowlist entry enrolled with the empty token, and nothing in these 1114 lines notices.

### [HIGH] The stdin cap is only ever tested with ONE chunk — a per-chunk cap passes every test
**Where:** tests/fleet/approvers.test.ts:378 (`diff:1048`, "refused AS IT STREAMS, never buffered whole") and 384 (`diff:1054`, "exactly at the cap").
**Weakness:** Both tests enqueue a single chunk. The implementation's bound is *cumulative* (`bytes += res.value.byteLength; if (bytes > MAX_TOKEN_BYTES)`, approvers.ts:345-346), and the test comment claims the streaming property, but a multi-chunk stream is never constructed — even though the file's own `streamOf(...chunks)` helper (`diff:1029`) takes varargs and is used with two chunks two tests earlier.
**Regression that slips through:** Change the check to `if (res.value.byteLength > MAX_TOKEN_BYTES)`. Both cap tests still pass (one chunk of 4097 refuses; one chunk of 4096 accepts), while an unbounded number of 4 KiB chunks is now buffered into `chunks[]` — the exact unbounded-buffering DoS the test's title says it prevents. `streamOf("a".repeat(4096), "a".repeat(4096))` would catch it and does not exist. Moving the check after the loop (buffer whole, then measure) also stays green.

### [MEDIUM] The R5-C keyHash guard's `closedAt` escape hatch is untested
**Where:** tests/fleet/approval-gate.test.ts:623 and 645 (`diff:629`, `diff:651`) — the INV-APPROVE/R5-C pair.
**Weakness:** The guard is a three-way conjunction: `rec.vmName !== undefined && rec.keyHash === undefined && rec.closedAt === undefined` (`src/fleet/approval-gate.ts:387`). The suite covers only `vmName` + no `keyHash` (refuse) and `vmName` + `keyHash` (allow). The third conjunct — an already-closed run, where the key was revoked at close and there is nothing left to refuse about — has no test in either direction.
**Regression that slips through:** Drop `&& rec.closedAt === undefined`. Every run that has already been torn down and closed, then re-enters the gate, now throws `refusing to pause …: it has a box but no keyHash` and is permanently unpausable, with a `pausing` extension stranded on disk. Both R5-C tests stay green.

### [MEDIUM] The fresh-host arm — no `.factory/` directory at all — is never exercised
**Where:** tests/fleet/approvers.test.ts:94 (`diff:764`, "an ABSENT allowlist"). `writeAllowlist(root, null)` (`diff:731-740`) still runs `mkdirSync(dir, {recursive:true})` + `chmodSync(dir, 0o700)`, so the directory always exists; only the file is absent.
**Weakness:** `authenticateApprover` stats the **directory first** (approvers.ts:156-166) and returns `approver-allowlist-dir-mode` — a *different* code with a *different* remediation ("create `${dir}` with mode 0700") — when the directory is missing. That is the state of every host before first enrollment, and no test reaches the branch. The suite's absent-file test asserts `approver-allowlist-unreadable`, which is a different arm entirely.
**Regression that slips through:** Remove the `try/catch` around `statSync(dir)`. On a fresh host `fleet approve` now dies with an uncaught `ENOENT` stack trace and whatever exit code that produces, instead of exit 5 with a remediation. All 11 allowlist tests stay green.

### [MEDIUM] No test submits a decision against a run that does not exist
**Where:** tests/fleet/approval-gate.test.ts:401 (`diff:407`, "a run with NO approval namespace is not decidable") — which calls `s.store.create("run-1")` first, so the record always exists.
**Weakness:** `submitDecision` reads via `readApproval` (`src/fleet/approval-gate.ts:275,431`), which does **not** catch `ENOENT`, unlike `readApprovalIfPresent` used by `sweepExpired` and `awaitDecision`. `sweepExpired` gets an explicit missing-run test (`diff:568`); `submitDecision` and `requestApproval` get none. A typo'd run id is the most ordinary operator error on this verb.
**Regression that slips through:** Already the current shape, and nothing pins it either way: `fleet approve --run typo` throws a raw `ENOENT: no such file or directory` from inside the approval lock (which is then released by the `finally`, so at least the lock is clean) instead of the `{outcome:"not-decidable", state:"absent"}` the sibling test asserts for the nearby case. Swapping `readApprovalIfPresent` back in — or out — changes nothing in the suite.

### [MEDIUM] A decision with an empty `approverId` or empty `reason` is never tested as a refusal
**Where:** tests/fleet/approval-gate.test.ts:270 (`diff:276`). The test's own comment cites the downstream guard — "DF5.2 refuses `approval-incomplete` without BOTH" — and then only asserts the populated happy path.
**Weakness:** `submitDecision` validates neither field (`src/fleet/approval-gate.ts:423-467`); `requestApproval` by contrast has five schema-rejection cases for `reportId`/`headSha` (`diff:151-166`). There is no negative case for the decision half at all: no empty `approverId`, no empty `reason`, no non-`"approved"|"rejected"` decision value.
**Regression that slips through:** A caller passing `approverId: ""` (e.g. a CLI path where the auth result's field was renamed) writes `state: "approved", approverId: ""` into the record. The gate reports `{outcome:"decided"}`, the run proceeds, and the failure only surfaces much later in `push.ts` as `approval-incomplete` — after the pause has been consumed. No test in this suite fires.

### [MEDIUM] The "no decision names an unknown reportId" test asserts nothing about the decision
**Where:** tests/fleet/approval-gate.test.ts:361-379 (`diff:367-385`).
**Weakness:** The test performs a `submitDecision` and then **never inspects its return value or the resulting state**. It asserts only `known === ["rv-3","rv-1","rv-2"]` — the same `supersededReportIds` accumulation already covered by the rebind test at line 172 (`diff:178`) — and then `expect(known).toContain("rv-3")`, which is tautologically implied by the `toEqual` on the line above it. The stated DoD ("no finish carries a decision against a reportId in neither field") is not what any assertion checks.
**Regression that slips through:** Invert the compare-and-set at `src/fleet/approval-gate.ts:448-449` to compare `req.reportId` against `existing.supersededReportIds[0]` instead of `existing.reportId`. The decision against the *current* `rv-3` is now answered `report-changed` and never recorded, the run stalls forever at `awaiting-approval` — and this test, which never looks at the outcome or the state, still passes.

### [MEDIUM] `constantTimeEqual`'s only actual property — no length leak — is not established
**Where:** tests/fleet/approvers.test.ts:272-290 (`diff:942-960`).
**Weakness:** All four tests assert boolean equality semantics. The comment at `diff:951-953` names the exact regression it means to guard ("an early length-return leaks the length") and then does not test it: an early length-return returns `false` for `("short","a-much-longer-value")` and `("","x")` without throwing, and `true` for `("","")`. Every assertion passes.
**Regression that slips through:** Replace the body with `a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))`, or plain `a === b`. All four tests stay green, the digest-both-sides design is gone, and comparison time is once again a function of the token's content and length.

### [MEDIUM] The allowlist schema is pinned in code but not in tests — only one missing-field case
**Where:** tests/fleet/approvers.test.ts:119 (`diff:789`, "a SCHEMA-INVALID allowlist"), which supplies `{alice:{salt:"s"}}`.
**Weakness:** `ApproversFileSchema` (`src/fleet/approvers.ts:65-77`) pins four separate things and only one is covered: `version: z.literal(1)` (a v2 file must refuse — untested), `.strict()` on both objects (an entry carrying an extra key must refuse — untested), the `^[0-9a-f]{64}$` hash regex whose comment states the intent that "a truncated or base64-shaped hash is a schema refusal, **not** a comparison that can never match and reads as a wrong token" (untested), and the BOM strip at approvers.ts:215 (untested).
**Regression that slips through:** Relax `hash` to `z.string()`. A truncated or uppercase-hex hash now produces `approver-token-mismatch` — the operator is told their token is wrong and rotates a perfectly good token, chasing a corrupt allowlist for hours. The suite is green. Likewise dropping `.strict()` lets an allowlist carry unknown keys through validation unnoticed.

### [MEDIUM] `awaitDecision` and expiry are never tested together
**Where:** tests/fleet/approval-gate.test.ts:572-620 (`diff:578-626`), all three cases; the AC3 expiry block (`diff:441-576`) never calls `awaitDecision`.
**Weakness:** `awaitDecision` (`src/fleet/approval-gate.ts:522-535`) checks `TERMINAL.has(ext.state)` on the *raw persisted* state and never consults `expiredState`. So a run whose `expiresAt` passes mid-wait is not terminal on disk until somebody calls `sweepExpired` or `submitDecision` — and no test covers the case where nobody does.
**Regression that slips through:** Nothing pins the behaviour, so it can change silently in either direction. Concretely: a waiting verb with the default `waitMs` (`DEFAULT_TIMEOUT_MS`, 24 h) parks for the full 24 hours on a run that expired after 60 seconds, holding a process the operator believes is live. The "gives up rather than waiting forever" test (`diff:616`) passes an explicit 40 ms window and therefore proves nothing about the default path or about expiry.

### [LOW] The documented reader cancellation on every refusal path is unasserted
**Where:** tests/fleet/approvers.test.ts:389 (`diff:1059`, the stall test) and 378 (`diff:1048`, the cap test).
**Weakness:** `readCappedToken`'s header states "The reader is CANCELLED on every refusal path: an abandoned read must not keep the stream open behind the refusal" (`src/fleet/approvers.ts:313-314`, implemented at :358-360). No test supplies a `ReadableStream` with a `cancel()` hook to observe it. The stall test's stream (`new ReadableStream({start(){}})`) would look identical whether or not cancel ran.
**Regression that slips through:** Delete the `finally { await reader.cancel() }`. After an `approver-token-too-large` refusal, fd 0 is left held open with a pending read; the CLI prints its exit-5 refusal and then does not exit until the writer goes away. Both stdin tests stay green.

### [LOW] The socket child-process test never checks the child's exit code and leaks it on failure
**Where:** tests/fleet/approvers.test.ts:414-443 (`diff:1084-1113`).
**Weakness:** `await child.exited` is awaited but its value is discarded, and `err` is only searched for the token — never surfaced. If the `bun -e` child fails to import the TS module or throws before `process.stdout.write`, `JSON.parse(out)` fails with `Unexpected end of JSON input` and the actual stderr diagnostic is never printed. There is also no `child.kill()` on the failure path, so a child that hangs before EOF is left running when the assertion throws.
**Regression that slips through:** Any breakage in the child (a renamed export, an import cycle, a syntax error under a newer bun) is reported as a JSON parse error rather than the real cause — the failure is real but the test actively hides the reason, which is how a genuine `assertTokenAttached` regression on sockets gets triaged as "flaky child test" and skipped.

### [LOW] `authenticateApprover`'s `file` parameter is never exercised
**Where:** tests/fleet/approvers.test.ts throughout — every one of the ~20 calls passes exactly three arguments; `DEFAULT_APPROVERS_FILE` is pinned as a string constant at line 185 (`diff:855`) but never as behaviour.
**Weakness:** The 4th parameter (`file = DEFAULT_APPROVERS_FILE`, approvers.ts:126) threads through to `resolve(hostRoot, file)` and is passed on by `authenticateFromStdin`. No test proves a non-default path is honoured.
**Regression that slips through:** Change the body to `resolve(hostRoot, DEFAULT_APPROVERS_FILE)`, ignoring the parameter. Any caller pointing at an alternate allowlist (a test harness, a multi-tenant host) silently reads the default one instead — a wrong-allowlist authorization — and the suite is green.

### [LOW] Token trimming is asserted for the trailing newline only
**Where:** tests/fleet/approvers.test.ts:367 (`diff:1037`, "with its trailing newline trimmed").
**Weakness:** The implementation calls `.trim()` (both ends, all whitespace — approvers.ts:365) and the comment justifies that choice, but the only assertion feeds a trailing `\n`. Untested: leading whitespace, `\r\n` (a token file written on Windows), and a whitespace-only stdin (`"   \n"`), which must land on `approver-token-absent` rather than becoming a `"   "` token.
**Regression that slips through:** Narrow `.trim()` to `.replace(/\n$/, "")`. A token redirected from a CRLF file keeps its trailing `\r`, every hash misses, and the operator gets `approver-token-mismatch` for a correct token. The test passes because its input is LF-only.

### [LOW] `expiredState`'s `undefined` and empty-state arms are unasserted
**Where:** tests/fleet/approval-gate.test.ts:439-483 (`diff:445-489`).
**Weakness:** Five cases cover terminal, `pausing`, unparseable expiry, and the boundary instant. Not covered: `expiredState(undefined, now)` → `undefined`, and `state: ""` → `undefined` (`src/fleet/approval-gate.ts:261-263`). Both are the "no approval namespace" shape that `fleet status --dir` hands this function on every run it lists.
**Regression that slips through:** Change the `state === ""` arm to return `""`. `fleet status` now renders an empty-string approval column for every ordinary run that never reached the gate — or, if a caller does `TERMINAL.has(expiredState(...))`-style truthiness checks, misclassifies them. No test fires.

---

**16 findings: 4 HIGH, 7 MEDIUM, 5 LOW. No BLOCKERs — no test in either file pins a known-buggy behaviour, and both allowlist mode checks and the first-decision-wins path do have genuine negative coverage.**
