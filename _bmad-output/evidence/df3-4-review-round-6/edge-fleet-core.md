# Edge-case findings — chunk-fleet-core (src/fleet/approval-gate.ts, src/fleet/approvers.ts)

### [HIGH] `pausing` is an unrecoverable wedge — no path out when teardown crashes
**Where:** src/fleet/approval-gate.ts:270-272 (`expiredState`) and :321 (`requestApproval`) (verified)
**Trigger:** `requestApproval` writes `state: "pausing"`, then `deps.teardown` throws (or the process is SIGKILLed / the host reboots) before the promote block at :399-402 runs.
**Unhandled:** The run is permanently stuck. `expiredState` returns early for `pausing` (`if (state !== "awaiting-approval") return state`), so `sweepExpired` returns `false` forever and the 24 h window never fires. `submitDecision` returns `not-decidable`. A retried `requestApproval` returns `pause-in-progress` on every subsequent call. There is no verb, sweep, or force-promote that moves a record out of `pausing` — the only recovery is hand-editing the run record JSON, which nothing in the module or the CLI tells the operator. The design comment calls `pausing` "recoverable and auditable", but only the auditable half is implemented.
**Verified:** `grep -rn '"pausing"' --include=*.ts src scripts` — the only non-gate hits are `src/reverify/approval.ts:25` (type union), `src/fleet/attach.ts:200` and `src/fleet/status.ts:423` (both display-only), and `scripts/fleet.ts:2469` (an outcome branch). No writer, no promoter, no sweeper.

### [MEDIUM] `awaitDecision` ignores expiry — waits its own full window past a run that timed out
**Where:** src/fleet/approval-gate.ts:531 (verified)
**Trigger:** A run with `expiresAt` 60 s out; caller does `awaitDecision(deps, runId)` with the default `waitMs` (`DEFAULT_TIMEOUT_MS`, 24 h). Nobody decides.
**Unhandled:** The loop tests `TERMINAL.has(String(ext.state ?? ""))` on the RAW state — it is the one reader in the module that does not route through `expiredState`. The record still reads `awaiting-approval` (nothing has written the timeout), so the poll runs ~86 400 store reads over 24 h and then returns `null` ("no answer") instead of returning the `timed-out` `RecordedDecision` at the 60 s mark. Every other reader (`expiredState`, `submitDecision`, `sweepExpired`) applies expiry; this one silently does not.
**Verified:** Read the whole module; `expiredState` is called at :324, :438, :508 but never inside `awaitDecision`.

### [MEDIUM] A rebind inherits the ORIGINAL `expiresAt` — a freshly bound report can time out seconds later
**Where:** src/fleet/approval-gate.ts:340-351 (the `awaiting-approval` rebind branch) (verified)
**Trigger:** Run paused at T0 with a 24 h window. At T0+23h59m a re-verify rebinds a new `reportId`. One minute later the window closes.
**Unhandled:** The rebind `store.set` writes `state / proposal / reportId / headSha / requestedAt / supersededReportIds` but NOT `expiresAt`, and `set()` merges field-by-field, so the original deadline survives. The new report is terminally `timed-out` 60 s after it was bound, attributed to `system:timeout`, with no human ever having had a usable window. `requestedAt` IS refreshed, so the record self-contradicts: `requestedAt` newer than `expiresAt` is possible. Either behaviour (reset or inherit) may be intended, but nothing in the code or the extensive comments states which, and the inherited case has no floor.
**Verified:** Read :340-351; no `expiresAt` key in the rebind patch. `resolveTimeoutMs` is called only at :364 (fresh-pause path).

### [MEDIUM] `resolveTimeoutMs` clamps the floor but not the ceiling — a large finite timeout throws `RangeError`
**Where:** src/fleet/approval-gate.ts:406-412, consumed at :364 (verified)
**Trigger:** `deps.timeoutMs = Number.MAX_SAFE_INTEGER` (9.007e15), or any finite value above ~8.64e15 − now.
**Unhandled:** `Number.isFinite(ms)` is true, `Math.max(ms, MIN_TIMEOUT_MS)` returns it unchanged, then `new Date(at.getTime() + ms).toISOString()` at :364 throws `RangeError: Invalid time value` because the Date is past the ±8.64e15 ms limit. This escapes from inside the `withApprovalLock` body as an uncaught `RangeError` with no mention of the timeout, where every other bad `timeoutMs` (NaN, Infinity, negative, 0) is silently corrected. The function's whole stated posture is "CLAMPED, not refused"; the upper bound is missing.
**Verified:** Read :406-412 and :364. `Number.isFinite` rejects `Infinity` but not `9e15`.

### [MEDIUM] `withApprovalLock` builds its lock path from an UNVALIDATED `runId`, before the store ever sees it
**Where:** src/fleet/approval-gate.ts:93 (verified)
**Trigger:** `requestApproval(deps, "../../../tmp/pwned", req)` via the DF5.1 `ApprovalPort` adapter.
**Unhandled:** `join(dir, \`${runId}.approval.lock\`)` applies no grammar. The store's `path()` calls `assertExistingRunId` (run-record.ts:1193-1195), but `requestApproval` takes the lock FIRST and only calls `store.get` inside the body — so the file is created outside the runs dir before any validation runs. Two consequences: (a) an `EEXIST` on an existing unrelated file drops into the stale-lock reclaim branch, and any file older than 10 s whose first `:`-delimited field parses as a dead pid (e.g. content beginning `12345:`) is `renameSync`d to a claim path and then `rmSync`d — arbitrary file deletion; (b) `lockHolderPid` on unrelated content returns `undefined` and the loop spins to the 5 s timeout with a misleading "approval lock … held for over 5000ms" message. The `approve`/`reject` verbs are covered by `assertRunExists` at scripts/fleet.ts:2388, but the `requestApproval` path is not, and `withApprovalLock` is exported.
**Verified:** `src/reverify/approval.ts:65-66` passes `runId` straight through to `gateRequestApproval` with no validation; run-record.ts:1193 shows validation lives only in `path()`.

### [MEDIUM] Free-text `proposal` / `reason` can trip `assertNoSecret` and abort the pause or the decision
**Where:** src/fleet/approval-gate.ts:314 (`proposal`) and :463 (`reason`) (verified)
**Trigger:** A proposal or `--reason` whose text contains a secret prefix at a token boundary — e.g. a PR body describing a change to this repo's own credential-prefix list, containing `ghp_` or ` sk-`.
**Unhandled:** `capText` bounds the LENGTH only. `store.set` runs `assertNoSecret` on every approval field (run-record.ts:616-624; the comment at :567-571 explicitly declares no `extensions.approval` path exempt), which throws `refusing to write key material into the run record: extensions.approval.proposal`. In `requestApproval` this throws inside the lock body before `pausing` is written, so the "evidence first" guarantee does not hold: the run neither pauses nor tears down, and nothing on disk records that it reached the gate. In `submitDecision` a rejection reason mentioning a leaked token cannot be recorded at all. Neither call site sanitizes or catches.
**Verified:** Read run-record.ts:492-504 (`SECRET_PREFIXES`), :560-572 (`SHAPE_EXEMPT_PATHS`, approval explicitly not exempt), :616-624 (the boundary-anchored prefix test).

### [MEDIUM] `system:timeout` is forgeable — nothing reserves the timeout approver id
**Where:** src/fleet/approval-gate.ts:197 (`TIMEOUT_APPROVER_ID`), written at :457-466 (`submitDecision`) (verified)
**Trigger:** Enroll `"system:timeout"` as a key in `.factory/approvers.json` (`ApproversFileSchema` uses `z.record(z.string(), …)`, so any string is a legal id), then `fleet reject --approver system:timeout`.
**Unhandled:** `submitDecision` writes `approverId: req.approverId` verbatim with no check against `TIMEOUT_APPROVER_ID`, and `authenticateApprover` does not exclude it from the allowlist. The result is a `rejected` (or `approved`) record attributed to the reserved system identity — the exact inverse of INV-APPROVE-4, which the comment states as "the attribution trail must never imply a person declined to act". A human decision can be laundered as a machine timeout.
**Verified:** `grep -rn "TIMEOUT_APPROVER_ID\|system:timeout" --include=*.ts src scripts` returns hits only inside approval-gate.ts — no guard anywhere.

### [MEDIUM] `readCappedToken`'s stall window is PER READ, not cumulative — a slow-drip writer parks the verb for hours
**Where:** src/fleet/approvers.ts:323-333 (the `for(;;)` / `Promise.race` loop) (verified)
**Trigger:** `while :; do printf x; sleep 9; done | fleet approve …`
**Unhandled:** The 10 s timer is created fresh on each iteration and cleared on every successful read, so a writer that emits one byte every 9 s never trips it. With a 4096-byte cap that is ~10 hours of parking. The function's own docstring claims a writer "that holds the pipe open and never closes it is refused instead of parking the verb forever" — that holds only for a fully silent writer. There is no overall deadline and no idle-vs-total distinction.
**Verified:** Read the loop; `timer` is declared inside the loop body and `clearTimeout` runs in the inner `finally`.

### [MEDIUM] Only `dirname(path)` posture is checked — the parent-of-parent is not
**Where:** src/fleet/approvers.ts:156-173 (verified)
**Trigger:** `hostRoot` is a shared or 0777 working directory (a CI scratch dir, a `/tmp` workspace). Attacker: `mv .factory /tmp/x && mkdir -m 700 .factory && install -m 600 evil.json .factory/approvers.json`.
**Unhandled:** The check inspects exactly one level — `dirname(path)`, i.e. `.factory` — and requires `(mode & 0o022) === 0`. A writable `hostRoot` lets the attacker replace `.factory` itself, after which both the directory check (their new dir is 0700) and the file check (their new file is 0600) pass and their `{salt, hash}` authorizes PRs. This is the same "replace it through the parent" attack the comment at :158-163 identifies, applied one level up. No loop walks ancestors, and `hostRoot` is never stat'd.
**Verified:** Read :153-173; `dir` is `dirname(path)` and is the only directory examined.

### [MEDIUM] No ownership check on the allowlist file or directory
**Where:** src/fleet/approvers.ts:156-195 (verified)
**Trigger:** The verb runs as root (a container entrypoint, a systemd unit) with `.factory/approvers.json` owned by an unprivileged local uid, mode 0600, `.factory` owned by that uid, mode 0700.
**Unhandled:** Both guards test only the mode bits. Root reads through 0600 regardless of owner, so an allowlist wholly controlled by an unprivileged account is accepted as authoritative. `st.uid` / `dirSt.uid` are never compared against `process.getuid()` (or 0). Mode-only is the weaker half of the standard "trusted path" check.
**Verified:** Read :153-195; `dirSt` and `st` are used only for `.mode`. Checked the cited precedent at run-record.ts:818-822 — that block is `readRecord` validation, not a uid check, so the precedent does not supply one either.

### [LOW] `req.headSha` undefined/null crashes the validation error path with a `TypeError`
**Where:** src/fleet/approval-gate.ts:307-309 (verified)
**Trigger:** `requestApproval(deps, runId, { proposal, reportId: "r1" })` — `headSha` omitted (the module has no runtime schema; `ApprovalRequest` at src/reverify/approval.ts:27-33 is a bare TS interface).
**Unhandled:** `HEAD_SHA_RE.test(undefined)` coerces to `"undefined"` and correctly fails, but the error message then evaluates `req.headSha.slice(0, 64)`, which throws `TypeError: Cannot read properties of undefined (reading 'slice')`. The intended "schema rejection with NO namespace registered" becomes an opaque TypeError that names neither the field nor the run.
**Verified:** src/reverify/approval.ts:27-33 — interface only, no zod schema on the adapter path.

### [LOW] Whitespace-only / newline-bearing `reportId` passes the emptiness guard
**Where:** src/fleet/approval-gate.ts:306 (verified)
**Trigger:** `req.reportId = " "` or `"r1\n"`.
**Unhandled:** The check is `req.reportId === ""` only — no trim, no grammar, no length cap, in contrast to `headSha` which gets a full regex two lines below. A whitespace-only id is stored as the binding, and `submitDecision`'s compare-and-set at :448-449 then requires the approver to present the byte-identical whitespace string. A trailing-newline variant (`"r1\n"` from a shelled-out producer) silently binds to a different id than `"r1"` and yields `report-changed` with an invisible difference in the message.
**Verified:** Read :306-309; no other validation of `reportId` in the module.

### [LOW] Rebind appends `""` to `supersededReportIds`, never dedupes, and has no cap
**Where:** src/fleet/approval-gate.ts:339-352 (verified)
**Trigger:** (a) a rebind against an `awaiting-approval` record whose `reportId` key is absent; (b) N repeated re-verifies of the same report — `requestApproval` with `reportId` equal to the currently bound one.
**Unhandled:** (a) `String(existing?.reportId ?? "")` pushes an empty string into the history array, so the audit trail carries a member that names no report — and the DoD the comment cites ("no decision may name a reportId absent from both `reportId` and `supersededReportIds`") is satisfied vacuously by an empty entry. (b) The append is unconditional, so an identical rebind writes the same id into `supersededReportIds` while it also remains the live `reportId` — the id is in both fields at once — and the array grows without bound or dedupe across repeated cycles. `assertNoSecret` walks every element on every write (run-record.ts:611-613), so the cost is O(n) per rebind and monotonic.
**Verified:** Read :339-352; no dedupe, no cap, no non-empty guard.

### [LOW] The reclaim branch's `continue` paths bypass the deadline check
**Where:** src/fleet/approval-gate.ts:136 (rename-ENOENT `continue`) and :144 (successful-reclaim `continue`) (verified)
**Trigger:** Two processes racing to reclaim the same stale lock while a third repeatedly re-takes it.
**Unhandled:** Both `continue` statements jump past the `if (Date.now() >= deadline) throw` at :166-170 AND past the `await Bun.sleep(LOCK_POLL_MS)` at :171. Under sustained contention the loop spins with no backoff and can exceed `LOCK_TIMEOUT_MS` without ever raising the documented timeout error — the 5 s ceiling the module advertises (and which `LOCK_STALE_MS` is derived from) is not enforced on those paths.
**Verified:** Read :101-178; the deadline check sits at the bottom of the `catch` block, after both `continue`s.

### [LOW] pid reuse makes a stale lock permanently unreclaimable
**Where:** src/fleet/approval-gate.ts:78-85 (`isLockHolderDead`) (verified)
**Trigger:** A process holding an approval lock is SIGKILLed (or the host reboots) leaving `<runId>.approval.lock` on disk; the recorded pid is later reused by an unrelated live process.
**Unhandled:** `process.kill(pid, 0)` succeeds (or raises EPERM for another user's process, which the function deliberately treats as "not provably dead"), so `isLockHolderDead` returns `false` forever and the stale-lock branch never fires. Every approval verb for that run then fails at the 5 s timeout, permanently. Reboot makes this likely rather than exotic: pid space wraps and lock files live in the persistent runs dir. Nothing bounds the age at which a lock is reclaimed regardless of pid — the "provably dead only" rule has no escape hatch and no `--force` in this module.
**Verified:** Read :78-96 and :101-178; the only reclaim precondition is `isLockHolderDead`.

### [LOW] `submitDecision` writes `state: req.decision` with no runtime validation
**Where:** src/fleet/approval-gate.ts:426 (signature) and :457-466 (the write) (verified)
**Trigger:** Any non-CLI caller — `submitDecision(deps, runId, { decision: "pausing" as Decision, … })`.
**Unhandled:** `Decision` is a compile-time union only; the record schema types `extensions.approval.state` as plain `"string"` (run-record.ts:263), so the value lands on disk unchecked. Writing `"pausing"` puts the run into the wedge described in the HIGH finding; writing `"timed-out"` forges a timeout; writing anything else produces a state that is neither terminal nor decidable and that `sweepExpired` will not expire (`expiredState` returns non-`awaiting-approval` states verbatim). `approverId` and `reason` are likewise unvalidated for emptiness — an empty `approverId` yields a TERMINAL, immutable record that DF5.2 will refuse forever as `approval-incomplete`, with no way to correct it.
**Verified:** run-record.ts:260-275 — the approval namespace declares every field as `"string"`/`"strings"`, no enum.

### [LOW] `authenticateApprover` accepts an empty or whitespace `approverId`
**Where:** src/fleet/approvers.ts:227-234 (verified)
**Trigger:** An allowlist containing `{"": {"salt":"…","hash":"…"}}` (legal under `z.record(z.string(), EntrySchema)`) plus a call with `approverId = ""`; or `" alice"` against an enrolled `"alice"`.
**Unhandled:** `Object.hasOwn(parsed.approvers, "")` is `true`, so the empty id authenticates and is returned as `{ ok: true, approverId: "" }` — which `submitDecision` then writes as the attribution, producing a decision nobody is named on. There is no emptiness check, no trim, and no case normalization on either the presented id or the enrolled keys, so `"Alice"` vs `"alice"` and `"alice "` vs `"alice"` are silently different approvers with no diagnostic distinguishing them from a genuinely unknown id.
**Verified:** Read :218-234 and the schema at :65-77; `z.record(z.string(), …)` places no constraint on the key.

---
17 findings: 1 HIGH, 9 MEDIUM, 7 LOW.
