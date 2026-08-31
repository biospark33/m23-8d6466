# PR #150 — Triage Ledger (round 6)

142 raw findings from 10 reviewers → deduped to 61 unique → 55 patch / 3 dismiss / 3 defer.

## DISMISSED (verified false positives)

| # | Claim | Verdict |
|---|---|---|
| D1 | blind-engine HIGH: "cross-process approval lock deleted with no replacement" | FALSE. `withApprovalLock` MOVED to `src/fleet/approval-gate.ts:92`, used at :316, :399, :430, :504. All six properties (ESRCH-only liveness, LOCK_STALE_MS=2×, rename-to-claim, `claimed` fail-closed, timeout msg) present. Blind agent had no repo access. |
| D2 | edge-engine HIGH: "`localSteeringInbox()` has no caller — AC6 unwired" | FALSE. Wired at `scripts/pipeline-run.ts:1709-1717` (`createSteering({ ..., inbox: localSteeringInbox() })`). Agent grepped `src/` only, missed `scripts/`. |
| D3 | test-cli LOW: fixture 0600 git-mode hazard | Self-retracted by the agent — `writeAllowlist` chmods into a tmpdir. |

test-engine's review of the two edited expectations (`tests/reverify/approval.test.ts:66`, `runner.test.ts:452`) confirmed **not** PINS-A-BUG — they track the intended record-side scalar→array change. Not findings.

## DECISION-NEEDED → resolved conservatively (pre-authorized)

| # | Question | Fail-safe resolution taken |
|---|---|---|
| DN1 | **AC1(b)/INV-APPROVE-6: teardown is unwired in every production path.** `recordApprovalPort(store)` at `src/reverify/runner.ts:406` passes no opts; `grep "teardown:"` finds zero GateDeps call sites. The source comment asserts "the fleet verb passes the real one" — no such verb exists. Options: (a) wire a real teardown into the reverify runner, (b) fail closed when the record still owns a live box. | **(b).** Wiring a driver into the reverify runner is new feature work outside a review's scope and the module comment explicitly says DF5.1's port has no driver to build one from. Instead extend the existing R5-C guard: refuse to promote to `awaiting-approval` when `rec.vmName !== undefined && rec.closedAt === undefined && deps.teardown === undefined`. Today's silent promotion-with-live-box becomes a loud, auditable refusal; the `pausing` record stands, so the run stays recoverable. INV-APPROVE-6 becomes enforced rather than asserted. Surfaced to the user — real teardown wiring is a follow-up story. |
| DN2 | **AC5 attach refusal is a deliberate race**, documented only in a source comment (`attach.ts:186-196`), not in the story's deviations. Options: (a) take `withApprovalLock` in attach, (b) keep the race, document it. | **(b).** The source comment's reasoning holds — the loss is one steering message, no state is corrupted, the extension is genuinely unmutated — and taking the gate's lock in the attach path is a locking-topology change that review is the wrong place to land. Recorded as **Deviation 10** in the story. |
| DN3 | **`pausing` has no resume path** (AC1(c) names one explicitly). Options: (a) leave stuck, (b) implement the spec's resume. | **(b).** AC1(c) specifies it verbatim — "A `pausing` extension found at startup is resumed by re-running teardown (idempotent under DF2.5), then promoting". Implementing the spec is not invention. |

## DEFERRED (pre-existing / out of scope, logged)

| # | Finding | Why deferred |
|---|---|---|
| W1 | `src/pr/repos.ts:95-108` — identical directory-mode gap in DF5.2's repo allowlist | Different story's owned surface; already a recorded follow-up. |
| W2 | `hashToken` is single-round sha256 (no work factor) | Changing the hash breaks every enrolled allowlist — needs a migration story, not a review patch. Tokens are documented as high-entropy machine-minted. |
| W3 | Real `teardown` wiring into the reverify runner (the other half of DN1) | New feature work; DN1's fail-closed guard covers the security invariant in the meantime. |

## PATCH CLUSTERS (Wave 1 — source, disjoint)

### F1 — `src/fleet/approval-gate.ts`, `src/reverify/approval.ts` (+ own tests)
1. **[BLOCKER/DN1]** promote refuses when record owns a live box and no teardown seam
2. **[HIGH/DN3]** `pausing` resume: re-run teardown + promote instead of bare `pause-in-progress`
3. [MED] `awaitDecision` ignores expiry — route through `expiredState`, return the `timed-out` decision
4. [MED] rebind does not restamp `expiresAt` (record self-contradicts: `requestedAt` newer than `expiresAt`)
5. [MED] `resolveTimeoutMs` has no ceiling — `9e15` throws `RangeError` from `new Date(...)`
6. [MED] `withApprovalLock` builds its path from an unvalidated `runId` (arbitrary write-then-`rmSync`)
7. [MED] `submitDecision` never validates `decision` — a typo writes an unrecoverable non-terminal state
8. [MED] `system:timeout` attribution is forgeable — reserve `TIMEOUT_APPROVER_ID`
9. [LOW] lock reclaim `continue`s bypass the deadline check (busy-spin, timeout not enforced)
10. [LOW] pid reuse permanently wedges the lock — no max-age escape
11. [LOW] `supersededReportIds`: appends `""`, never dedupes, no cap
12. [LOW] `headSha`/`reportId` nullish → `TypeError` in the validation error path; `reportId` not trimmed
13. [LOW] `capText` can slice a surrogate pair
14. [LOW] `already-decided` has two payload shapes across the two entry points
15. [LOW] bundle-existence guard runs only on rebind, never on the first request
16. [LOW] empty `approverId`/`reason` accepted → terminal record DF5.2 refuses forever
17. [LOW] `recordApprovalPort(store, opts = {})` makes the teardown-less port the silent default
18. [LOW] truncation suffix `…[truncated, N chars total]` — leading U+2026 not in the spec literal

### F2 — `src/fleet/approvers.ts` (+ own tests)
19. **[HIGH]** dir-mode guard checks only `dirname(path)` — the same replacement attack one level up passes
20. [MED] `file` param escapes `hostRoot` (absolute or `../`) — attacker supplies their own allowlist
21. [MED] no uid/ownership check on allowlist file or dir (root reads through 0600 regardless of owner)
22. [MED] `readCappedToken`'s stall window is per-read, not cumulative — slow drip parks the verb ~10 h
23. [LOW] no `isFile()` check — a FIFO at the allowlist path hangs the verb with no timeout
24. [LOW] empty/whitespace `approverId` authenticates; no trim, no case normalization

### F3 — `src/fleet/attach.ts`, `src/fleet/status.ts` (+ own tests)
25. **[HIGH]** no `closedAt`/settled-state guard — attach execs into a destroyed box (every settled state is *after* the pause teardown)
26. **[HIGH]** append failure/timeout throws unclassified → exit 1 "retry me" → new `messageId` → double delivery
27. **[HIGH]** no trailing-newline guard — a partial append silently destroys the *next* valid message
28. **[HIGH]** `QDS_STEERING_ROOT` is read host-side but the path is used inside the box — legs diverge silently
29. [MED] `readAck` maps a dead box to "absent" → 30 s poll + a remediation whose every clause is false
30. [MED] status approval override fires when the box *list* failed, masking `listUnavailable`/`boxUnknown`
31. [MED] paused rows drop `closedAt` and never carry `boxAlive`, even on the list-success path
32. [MED] timed-out ack `exec`s are never cancelled and accumulate
33. [LOW] ceiling can overrun by a full per-call timeout (30 s documented, ~40 s actual)
34. [LOW] corrupt acks file reported identically to a timeout, with the wrong remediation
35. [LOW] `ceilingMs: 0` / `pollIntervalMs: 0` skip the poll entirely / hot-spin
36. [LOW] inbox never rotated; every drain re-reads and re-parses the whole file
37. [LOW] `rowForRecord`'s doc comment now documents `approvalRowFields` (insertion point wrong)
38. [LOW] `reportId` silently truncated in status output — the value operators copy to act on

### F4 — `src/phase-engine/steering.ts`, `src/providers/run-record.ts` (+ own tests)
39. **[HIGH]** `delivered.add` runs BEFORE `ack` and the ack throw is swallowed → ack never retried → permanent `attach-not-acked` for a message that landed
40. **[HIGH]** `onInboxError` is not awaited — an `async` observer's rejection is an unhandled rejection (process-fatal)
41. **[HIGH]** `telemetry.status` is a one-way latch and gates `drainInbox` — a degraded resident stops draining forever, silently
42. [MED] ack failure does not call `onInboxError` (drain failure does) — the fault reaches nothing
43. [MED] legacy singular `supersededReportId` is unreadable, unwritable, unremovable — two disagreeing sources of truth on upgraded records
44. [MED] `STRINGS_MAX_ELEMENTS` on an append-only history is a permanent brick, not a bound — needs shedding
45. [MED] `lastDegradationReason` clobbering: a sidecar fault destroys the resident's real reason
46. [MED] cumulative `promptContext` is unbounded in COUNT; head-truncation evicts founding task context first
47. [MED] no timeout on injected `drain`/`ack` — a hung inbox wedges every later solicitation
48. [LOW] `assertKind` makes `ports` explicit but leaves `strings` as the new implicit catch-all (identical trap for kind #5) — add an exhaustiveness guard
49. [LOW] `messageId` interpolated into the prompt with no length cap
50. [LOW] cap applied BEFORE sanitization — a 4 000-char message can store ~24 000 chars
51. [LOW] `detached()`'s stated precondition fails at the read-mode call site (nested objects stay aliased)
52. [LOW] no `schemaVersion` bump despite one field retired and three added
53. [LOW] `delivered` grows unbounded; `onInboxError` re-fires every solicitation with no dedupe
54. [LOW] inbound attach text capped by a constant named for *outbound* directive text

### F5 — `scripts/fleet.ts` (+ `tests/fleet/gate-verbs.test.ts`, `tests/fleet/verbs.test.ts`)
55. **[HIGH]** no TTY guard — `approve`/`reject` park on a terminal and the typed token is **echoed** into scrollback
56. [MED] `gateEvent` logs `status: "error"` for `already-decided`, which exits 0 (dashboards alert on the documented idempotent-success path)
57. [MED] `--approver ""` passes the presence guard → allowlist refusal (exit 5) instead of a usage error (exit 2)
58. [MED] `--reason` is uncapped and echoed unsanitized while every neighbouring field is capped
59. [MED] observability: the `pause` event is never emitted; `record_write_ms` missing; refusal arm hardcodes `state: "awaiting-approval"`
60. [LOW] the decision `else` is a catch-all that labels any unexpected outcome `already-decided` and exits 0
61. [LOW] attach builds a `create: true` store on the default-dir path, contradicting its own rationale; `requestId` key collision in attach stdout; `--message -` sentinel undeclared in the registry; run existence disclosed before authentication

## PATCH CLUSTERS (Wave 2 — tests, after source settles)

### T1 — `tests/fleet/e2e/tier1-approval-gate.live.test.ts`
- **[BLOCKER]** `pauseSucceeded` means "requestApproval returned", not "teardown ran" — on any non-`fresh` outcome both `finally` guards skip the box destroy AND the key revoke. Real box + real billable key leak on exactly the run that failed. Gate on `order.includes("teardown-done")`.
- [HIGH] the key-hash delta is computed, serialized, and **never asserted** — a leak is recorded and the test passes
- [HIGH] AC7's "box is genuinely absent" has no positive control — `list()` is called once, post-teardown; "gone" and "invisible" are indistinguishable
- [MED] `revokeQuietly`'s `store.get` sits outside its own `try` — a throw kills the evidence write, the ledger close, and the workspace cleanup
- [LOW] only `approve`'s output is scanned for the token; the `reject`/already-decided path is not
- [LOW] `expect(hashesBefore.has(hash)).toBeFalse()` is a near-tautology

### T2 — `tests/fleet/cli.test.ts`, `tests/fleet/verbs.test.ts`, `tests/fleet/gate-verbs.test.ts`
- [HIGH] injected `authenticate` ignores its arguments — nothing proves `--approver` or `cwd` reaches authentication
- [HIGH] `attach`'s success path (`attach-acked` → exit 0) is never exercised at the CLI layer
- [HIGH] the exit-code probe loop is skipped for all three new verbs; exit 1 asserted for none, exit 6 for neither approve nor reject, exit 0 for not attach
- [HIGH] no exact flag-table snapshot for the three new verbs — a secret-bearing flag could be added with every test green
- [MED] both "no secret leaks" tests run with no needle planted
- [MED] the AC7 status double's `get()` ignores its argument and only ever holds one row — every row↔extension binding assertion is unfalsifiable
- [MED] "refused before any store is built" asserts an ordering property nothing observes
- [MED] argv-hygiene control matches literal substrings only — a base64 payload passes
- [LOW] `--reason` cap test satisfied by a dropped/garbled reason (`String(undefined)` is 9 chars); `PROBES_OWED_ELSEWHERE` order-sensitive; dead `not.toBe("boxMissing")`; `--approver ""` and absent `--message` unexercised; live-box teardown outside `finally`; 30 s ceiling inside a 20 s test timeout; unused `bob` fixture entry

### T3 — `tests/fleet/approval-gate.test.ts`, `tests/fleet/approvers.test.ts`, `tests/providers/run-record.test.ts`, `tests/phase-engine/steering.test.ts`
- [HIGH] `withApprovalLock`: 90 lines of stale-lock reclamation with no test that can fail (same-process test only)
- [HIGH] `capText` / `MAX_PROPOSAL_CHARS` / `MAX_REASON_CHARS` never asserted at, above, or near the cap
- [HIGH] `authenticateFromStdin` — the only function production calls — has no test; argument wiring unpinned
- [HIGH] the stdin cap is only ever tested with ONE chunk; a per-chunk cap passes both tests
- [MED] R5-C's `closedAt` escape hatch untested; no decision against a nonexistent run; empty `approverId`/`reason` never tested as a refusal; the "unknown reportId" test never inspects its decision; `constantTimeEqual`'s no-length-leak property unestablished; allowlist schema (v2, `.strict()`, hash regex, BOM) mostly unpinned; `awaitDecision`+expiry never combined
- [MED] no legacy-record case (pre-DF3.4 singular scalar on disk) read → rebind → decide
- [MED] no concurrent-writer case for the `supersededReportIds` read-modify-write
- [MED] `lastDegradationReason` never observed across two solicitations; "fires once" asserted over exactly one solicitation; inbox fault + caller degradation in the same solicitation uncovered
- [LOW] reader cancellation unasserted; socket child's exit code discarded and leaked on failure; `file` param never exercised; token trimming asserted for trailing `\n` only; `expiredState`'s `undefined`/`""` arms unasserted; no false-positive control for a long realistic `proposal`
