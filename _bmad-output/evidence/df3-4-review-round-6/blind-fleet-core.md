# Blind adversarial review — chunk-fleet-core.diff

All line numbers are DIFF-RELATIVE (position in `/tmp/pr150-review/chunk-fleet-core.diff`), not source line numbers.

---

### [HIGH] A `pausing` run is permanently wedged — no code path anywhere transitions out of it
**Where:** chunk-fleet-core.diff:399-410, 272, 327, 452, 514 — src/fleet/approval-gate.ts `requestApproval` / `expiredState` / `submitDecision` / `sweepExpired`
**Trigger:** `requestApproval` writes `state: "pausing"` (line 362), then `await deps.teardown?.(...)` at line 401 throws (provider hiccup, network blip) or the process is Ctrl-C'd / OOM-killed during the minutes-long teardown. Also reachable by the keyHash refusal at 393-397, which throws *after* `pausing` is already on disk.
**Problem:** The record is now `pausing` forever. Every exit is closed:
- `requestApproval` re-entry returns `{outcome: "pause-in-progress"}` at line 327 — it never re-drives teardown, so a retry of the verb is a no-op and the box (if any) stays alive and billing.
- `submitDecision` falls through to `not-decidable` at 452.
- `expiredState` deliberately never expires `pausing` (272), so `sweepExpired` returns false at 514 and the `expiresAt` written at 370 is inert.
The header comment calls this "the designed recoverable state", but nothing in this module recovers it and no recovery verb appears in this chunk. The only escape is hand-editing the run record JSON. A single teardown failure permanently strands the run *and* leaks the box the pause was supposed to destroy.

### [HIGH] Directory-mode guard only checks ONE ancestor — the stated attack still works one level up
**Where:** chunk-fleet-core.diff:703-720 — src/fleet/approvers.ts `authenticateApprover`
**Trigger:** `hostRoot = /srv/factory` where `/srv/factory` is mode 0777 (or group-writable, or owned by another account) while `/srv/factory/.factory` is a correct 0700. Attacker: `mv /srv/factory/.factory /srv/factory/.factory.bak && mkdir -m 700 /srv/factory/.factory && install -m 600 evil.json /srv/factory/.factory/approvers.json`.
**Problem:** The code stats only `dirname(path)` and asserts `(mode & 0o022) === 0` on that single component. The comment states the threat precisely — "the cheapest way to extend one you cannot write is to replace it through the parent" — but the same replacement executed one directory higher passes both the dir check and the file check, yielding a perfectly 0600, perfectly schema-valid allowlist that enrolls the attacker's `{salt, hash}`. That authorizes PRs. There is also no uid check on either the directory or the file, so an allowlist owned by a different (non-root) account is accepted when the process can read it.

### [MEDIUM] `file` parameter can escape `hostRoot` entirely — a flag or env wired to it is a total auth bypass
**Where:** chunk-fleet-core.diff:669-675 (`resolve(hostRoot, file)`), 938-946 — src/fleet/approvers.ts `authenticateApprover` / `authenticateFromStdin`
**Trigger:** any caller passing `file` from user-controlled input, e.g. `--approvers-file /home/mallory/ok/approvers.json` (dir 0700, file 0600, both attacker-owned).
**Problem:** `resolve(hostRoot, file)` discards `hostRoot` whenever `file` is absolute, and accepts `../` for relative input. Nothing asserts the resolved path is under `hostRoot`. Both mode checks then pass against the attacker's own directory, so the attacker supplies the allowlist they authenticate against. The parameter is public API on two exported functions with no documented constraint.

### [MEDIUM] `deps.teardown === undefined` silently promotes a run that owns a live box
**Where:** chunk-fleet-core.diff:236, 392-401 — src/fleet/approval-gate.ts `GateDeps.teardown` / `requestApproval`
**Trigger:** the DF5.1 adapter path described in the header ("DF5.1's port has no driver to build one from") invoked on a run whose record has `vmName` set and `keyHash` set.
**Problem:** The keyHash guard immediately above (393) proves the module knows records reaching this point can carry a `vmName`. When they do and `teardown` is absent, `await deps.teardown?.(...)` is a no-op, the run is promoted to `awaiting-approval`, and the box survives for the whole approval window (24 h by default) with nobody watching. The doc comment asserts "a caller that has a box passes the seam" but that assertion is never checked: the natural guard — refuse when `rec.vmName !== undefined && deps.teardown === undefined` — is missing, right next to a guard that already reads `rec.vmName`.

### [MEDIUM] The approval window is consumed by teardown, so a short configured timeout expires before the human is ever asked
**Where:** chunk-fleet-core.diff:370, 401-408 — src/fleet/approval-gate.ts `requestApproval`
**Trigger:** `deps.timeoutMs = 60_000` (the documented floor) and a normal VM teardown that takes 90 s.
**Problem:** `expiresAt` is stamped at registration (line 370), before teardown, and is never restamped at promotion (407 writes only `state`). By the time the run reaches `awaiting-approval` it is already past `expiresAt`, so the first `submitDecision` or `sweepExpired` records `timed-out` with `approverId: "system:timeout"` — a terminal, irreversible abort of a run no human was ever given a chance to see. This is exactly the failure `MIN_TIMEOUT_MS` says it exists to prevent (comment at 414-416); the clamp does not cover it because the loss is teardown duration, not the configured value.

### [MEDIUM] A rebind does not restamp `expiresAt` — the second report inherits the first's remaining window
**Where:** chunk-fleet-core.diff:333-359 — src/fleet/approval-gate.ts `requestApproval` rebind branch
**Trigger:** `requestApproval` at t=0 (24 h window), a re-verify rebinding a new `reportId` at t=23h50m.
**Problem:** The rebind writes `requestedAt` fresh but omits `expiresAt`, and `store.set` merges field-by-field, so the stale expiry survives. The record then displays `requestedAt` = now with 10 minutes of window left, and the new report times out almost immediately. Either the expiry should be restamped or `requestedAt` should not be — writing one and not the other makes the displayed pair self-contradictory.

### [MEDIUM] `awaitDecision` ignores expiry — returns `null` for a run that is effectively timed-out, and never persists the timeout
**Where:** chunk-fleet-core.diff:528-541 — src/fleet/approval-gate.ts `awaitDecision`
**Trigger:** `requestApproval` with `timeoutMs: 60_000`, then `awaitDecision(deps, runId, {waitMs: 300_000})`, and nobody decides.
**Problem:** The loop tests `TERMINAL.has(String(ext.state))` on the RAW state — it is the only reader in the module that does not go through `expiredState`. At t=60 s the run is effectively `timed-out`, but the loop keeps polling until t=300 s and then returns `null`, which the doc defines as "the window given here elapsed" — a different fact from "the approval expired". The caller cannot distinguish them, and because nothing swept, the record is still `awaiting-approval` on disk.

### [MEDIUM] Lock reclaim can strand a live holder's lock, leaving two processes in the critical section
**Where:** chunk-fleet-core.diff:155-165 — src/fleet/approval-gate.ts `withApprovalLock`
**Trigger:** three racers. P1's lock is stale and P1 is dead. P2 reads P1's content (`raw`, line 129). Before P2's `renameSync` (140), P3 reclaims and acquires, writing its own content c3 to `lockPath`. P2's rename captures c3 onto its private `claimPath`; `content !== raw`, so P2 tries to restore at 156 — but in the window between the rename and the restore, P4 acquired `lockPath` with `wx`. P2's restore fails `EEXIST`.
**Problem:** The `EEXIST` arm is a comment saying "nothing to restore" and then `rmSync(claimPath)` at 165 destroys c3. P3 is still executing its body believing it holds the lock; P4 also holds it. Two concurrent read-decide-writes is precisely what this file exists to prevent — the lost-`supersededReportIds` corruption described at 341-344 becomes reachable. Worse, P3's `finally` at 183 will then `rmSync(lockPath)` and delete P4's lock, cascading the breakage to P5.

### [MEDIUM] `submitDecision` never validates `decision`, so a typo'd verdict writes an unrecognized terminal-looking state
**Where:** chunk-fleet-core.diff:429-473 — src/fleet/approval-gate.ts `submitDecision`
**Trigger:** a CLI that parses `--decision approve` (or `Approved`, or `reject`) and passes it through with a cast — the ordinary way a string flag reaches a `Decision`-typed parameter.
**Problem:** `req.decision` is written straight into `state` at 465 with no runtime check against the two literals, while every other input on this path is validated or capped. `"approve"` is not in `TERMINAL`, so the run is left in a state that `expiredState` passes through unchanged (272 returns it as-is), `submitDecision` thereafter answers `not-decidable`, `sweepExpired` refuses (513/514), and no expiry ever applies. The run is unrecoverable exactly as in the `pausing` finding, and downstream DF5.2 sees a state that is neither approved nor rejected.

### [MEDIUM] A slow-drip stdin producer parks the verb for hours despite the "stall window"
**Where:** chunk-fleet-core.diff:870-890 — src/fleet/approvers.ts `readCappedToken`
**Trigger:** `while :; do printf a; sleep 9; done | fleet approve …`
**Problem:** The 10 s timer is recreated per read iteration, so it only bounds the gap *between* chunks, not total read time. A writer emitting one byte every 9 s keeps resetting it until the 4096-byte cap trips — roughly 10 hours. The doc claims the reader "refuses instead of parking the verb forever"; the actual bound is `MAX_TOKEN_BYTES × timeoutMs`, which for an operator waiting on a terminal is indistinguishable from a hang. No overall deadline is computed.

### [MEDIUM] `runId` is interpolated into filesystem paths with no validation
**Where:** chunk-fleet-core.diff:99 (`join(dir, ${runId}.approval.lock)`), 334 (`join(deps.bundleDir, ${runId}.bundle)`) — src/fleet/approval-gate.ts `withApprovalLock` / `requestApproval`
**Trigger:** `runId = "../../tmp/x"` from a CLI flag or an adapter that does not itself validate.
**Problem:** Both `join` calls resolve `..` out of the intended directory. `withApprovalLock` then creates a file at an arbitrary path and, in its `finally` at 183, `rmSync`s it — an attacker-influenced write-then-delete of any path the process can reach that ends in `.approval.lock`. The bundle `existsSync` similarly probes outside `bundleDir`. Neither exported function documents that `runId` must be pre-sanitized, and `withApprovalLock` is exported for other callers.

### [LOW] `continue` on the reclaim paths skips the deadline check, so the 5 s timeout is not actually a bound
**Where:** chunk-fleet-core.diff:142, 150, 172 — src/fleet/approval-gate.ts `withApprovalLock`
**Trigger:** sustained contention where several processes repeatedly lose the `renameSync` race (`ENOENT`, line 142) or successfully reclaim (150).
**Problem:** Both `continue` statements jump past `if (Date.now() >= deadline) throw` and past `await Bun.sleep(LOCK_POLL_MS)`, going straight back to the `wx` attempt. The loop can therefore both busy-spin with no yield and exceed `LOCK_TIMEOUT_MS` without ever raising the documented error.

### [LOW] Validation of `reportId` / `headSha` only handles the empty-string case; a nullish value crashes or is written through
**Where:** chunk-fleet-core.diff:312-315 — src/fleet/approval-gate.ts `requestApproval`
**Trigger:** an adapter passing a JSON-derived request where `reportId` or `headSha` is `undefined`/`null` (the type is a compile-time claim only; this is the trust boundary with `src/reverify/approval.ts`).
**Problem:** `req.reportId === ""` is false for `undefined`, so a nullish reportId reaches `store.set` at 351 and is written as the bound report — the very "defaulted field" the comment says is impossible. For `headSha`, `HEAD_SHA_RE.test(undefined)` is false, so the error branch is taken, but `req.headSha.slice(0, 64)` on line 314 then throws `TypeError: Cannot read properties of undefined` — the validation error is replaced by a stack trace with no diagnostic value.

### [LOW] Nothing prevents forging the reserved `system:timeout` attribution
**Where:** chunk-fleet-core.diff:203, 429-473 — src/fleet/approval-gate.ts `TIMEOUT_APPROVER_ID` / `submitDecision`
**Trigger:** an allowlist entry enrolled under the id `system:timeout` (the schema at 612-624 permits any string key), then `fleet approve --approver system:timeout`.
**Problem:** `submitDecision` writes `req.approverId` verbatim. INV-APPROVE-4 is stated as "the attribution trail must never imply a person declined to act", but the inverse — a person's decision recorded as the system's — is equally unguarded. A `rejected` record carrying `system:timeout` is indistinguishable from an actual expiry.

### [LOW] Empty-string `approverId` is authenticable and produces a record that reads as incomplete
**Where:** chunk-fleet-core.diff:623 (`z.record(z.string(), …)`), 774-781 — src/fleet/approvers.ts
**Trigger:** an allowlist containing `{"": {"salt": "…", "hash": "…"}}`, decision submitted with `--approver ""`.
**Problem:** The record key schema is `z.string()` with no `.min(1)`, unlike `salt`. `Object.hasOwn(approvers, "")` succeeds, the token verifies, and the decision is written with `approverId: ""`. `decisionOf` (approval-gate.ts, diff:477-484) renders a missing approverId as `""` too, so downstream cannot tell an authenticated decision from a corrupt one — and DF5.2's `approval-incomplete` check (referenced at 459-461) will reject a decision that actually passed authentication.

### [LOW] Allowlist read has no file-type check — a FIFO at the allowlist path hangs the verb with no timeout
**Where:** chunk-fleet-core.diff:722-756 — src/fleet/approvers.ts `authenticateApprover`
**Trigger:** `mkfifo -m 600 .factory/approvers.json` (or an accidental device/named pipe left by tooling).
**Problem:** `statSync` reports mode 0600, so `(st.mode & 0o077) !== 0` passes, and `readFileSync` on a FIFO with no writer blocks indefinitely. Every other malformed-file case is converted to a refusal; this one parks the process. `st.isFile()` is never asserted, even though the sibling `assertTokenAttached` at 847 is careful to allow-list fd types.

### [LOW] `capText` can slice a surrogate pair in half
**Where:** chunk-fleet-core.diff:250-256 — src/fleet/approval-gate.ts `capText`
**Trigger:** a proposal longer than 8000 UTF-16 code units whose character at index `8000 - suffix.length - 1` is a high surrogate (any emoji or non-BMP glyph landing on the boundary).
**Problem:** `text.slice(0, max - suffix.length)` cuts between the surrogates, leaving a lone surrogate in the stored proposal. It round-trips through JSON as an escaped lone surrogate and renders as a replacement char or throws in any consumer that re-encodes to strict UTF-8.

### [LOW] A rebind against a record with no `reportId` appends `""` to the superseded history
**Where:** chunk-fleet-core.diff:345, 354 — src/fleet/approval-gate.ts `requestApproval`
**Trigger:** any `awaiting-approval` extension whose `reportId` is missing (a hand-repaired record, or one written by the nullish-reportId path above).
**Problem:** `String(existing?.reportId ?? "")` yields `""`, which is pushed into `supersededReportIds` and also returned to the caller as `{outcome: "rebound", supersededReportId: ""}`. The DoD quoted at 341-344 — no decision may name a reportId absent from both fields — is satisfied vacuously by a sentinel that names no report. The same line also self-supersedes on an idempotent retry: calling `requestApproval` twice with the identical `reportId` appends that id to its own superseded list and reports `rebound`.

### [LOW] `already-decided` has two different payload shapes in the same module
**Where:** chunk-fleet-core.diff:331 vs 447/450 — src/fleet/approval-gate.ts `requestApproval` vs `submitDecision`
**Trigger:** a caller that handles the `already-decided` tag from either entry point with one branch.
**Problem:** `requestApproval` returns `{outcome: "already-decided", state}` while `submitDecision` returns `{outcome: "already-decided", state, approverId, decidedAt, reason}`. A caller rendering "already decided by X at Y" gets `undefined` for both fields on the `requestApproval` path. The two shapes are declared in different type aliases (`ApprovalOutcome` vs `DecisionOutcome`), so nothing catches the mismatch at the call site that unions them.

### [LOW] Bundle-existence guard is applied only on rebind, never on the first request
**Where:** chunk-fleet-core.diff:334-338 vs 361-378 — src/fleet/approval-gate.ts `requestApproval`
**Trigger:** `requestApproval` on a run whose harvested bundle was deleted (disk pressure, a stale runs dir) and which has no prior approval extension.
**Problem:** The comment at 240-243 argues "a report naming a run whose bundle is gone is bound to nothing", but the fresh path performs no such check — it registers `pausing`, tears down the box, and promotes to `awaiting-approval` for a bundle that does not exist. The invariant is enforced on the less likely path and skipped on the common one.

### [LOW] A reused pid permanently wedges the lock
**Where:** chunk-fleet-core.diff:84-91, 131 — src/fleet/approval-gate.ts `isLockHolderDead`
**Trigger:** the lock holder is SIGKILLed; the host recycles its pid to an unrelated long-lived process before the next approval verb runs.
**Problem:** `process.kill(pid, 0)` succeeds, `isLockHolderDead` returns false, and the stale lock is never reclaimed. Every subsequent approval verb for that run fails after 5 s with "remove it by hand". The nonce in the lock content is designed to defeat exactly this confusion during reclaim, but it is never consulted before the liveness test — only after (147).

### [LOW] Stored token hashes are single-round sha256
**Where:** chunk-fleet-core.diff:655-657 — src/fleet/approvers.ts `hashToken`
**Trigger:** the allowlist is captured — a host backup, a snapshot, a repo commit of `.factory/`, or the directory-replacement scenario above run in reverse (read rather than write).
**Problem:** `sha256(salt ":" token)` is one unsalted-cost round. It is adequate only if every token is high-entropy random, which nothing in this module enforces or documents; an operator who enrolls a passphrase is offline-crackable at billions of guesses per second. The salt prevents cross-entry reuse but adds no work factor.

### [LOW] Decision recording is not coupled to authentication
**Where:** chunk-fleet-core.diff:429-433 — src/fleet/approval-gate.ts `submitDecision`
**Trigger:** any second caller of `submitDecision` — a future verb, a test helper promoted to production, a scripted path — that omits `authenticateFromStdin`.
**Problem:** `submitDecision` accepts `approverId` as an unauthenticated string and writes it as the attribution. Nothing in the type or the signature marks it as a post-authentication value, and the recorded extension carries no evidence that authentication occurred, so an unauthenticated decision is byte-identical on disk to an authenticated one. The two modules in this diff share no token — the entire control depends on every call site remembering to chain them.

---

**23 findings: 0 BLOCKER, 2 HIGH, 9 MEDIUM, 12 LOW.**

<!-- Tally corrected 2026-08-29: the report body has always carried 23 findings
     (2 HIGH / 9 MEDIUM / 12 LOW by `### [SEVERITY]` heading count). The line
     above read "22 … 11 LOW" — an undercount of one LOW in the summary only.
     No finding text was added, removed or altered. -->

