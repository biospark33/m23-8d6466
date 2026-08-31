# Edge-case hunt — attach transport + CLI verbs (PR #150)

Scope: `chunk-fleet-attach.diff` (src/fleet/attach.ts, status.ts, verbs.ts), `chunk-cli.diff` (scripts/fleet.ts, scripts/pipeline-run.ts).
Only UNHANDLED cases are listed. Diff-relative line N in `chunk-fleet-attach.diff` maps to `src/fleet/attach.ts:N-6`; diff-relative line N in `chunk-cli.diff` maps to `scripts/fleet.ts:N+2253` (offset confirmed against the real file).

---

### [HIGH] A timed-out or non-zero append is reported as exit 1 "retry me" although the line may already be in the inbox
**Where:** `src/fleet/attach.ts:218-225` (verified) — CLI catch at `scripts/fleet.ts:2599-2602` (diff `chunk-cli.diff:346-349`)
**Trigger:** `fleet attach r1 --driver exedev --message "do X"` where the box's `driver.exec` takes longer than `ATTACH_PER_CALL_TIMEOUT_MS` (10 s) — e.g. a loaded box or a slow SSH round-trip — but the `cat >>` on the box completes. `withTimeout` rejects with `TimeoutError`; the exec is **not** cancelled (`withTimeout` only races and attaches a no-op catch, `src/providers/timeout.ts:46-56`), so the append lands anyway.
**Unhandled:** `attachToRun` propagates the `TimeoutError`; `report()` sees an error with no `code` on the permanent-errno table and returns **exit 1 = transient = "retry me"** (`scripts/fleet.ts:504`, `546-550`). A retry mints a fresh `crypto.randomUUID()` messageId (`attach.ts:213`), so the guidance is delivered **twice** — the exact double-delivery hazard the `attach-not-acked` arm explicitly reasons its way to exit 6 to avoid (`chunk-cli.diff:330-343`). The same applies to the `exitCode !== 0` throw at `attach.ts:223-225`: a `cat` that failed *after* writing bytes is also non-retryable.
**Verified:** read `src/providers/timeout.ts` in full (no abort/cancel path); read `scripts/fleet.ts:484-550` (`report`'s classification); confirmed `attach.ts:213` mints a new id per call.

---

### [HIGH] A partially-written append leaves the inbox with no trailing newline; the next append silently destroys the following message
**Where:** `src/fleet/attach.ts:123-128` (`appendScript`, verified) and `src/fleet/attach.ts:270-281` (drain, verified)
**Trigger:** The box's filesystem fills (ENOSPC) or the `exec` is killed mid-write, so `cat >> /run/steering/inbox.ndjson` writes `{"messageId":"a","runId":"r1","mess` and exits non-zero. Operator re-runs `fleet attach r1 --driver exedev --message "..."` (they were told exit 1 = retry). The second `cat >>` appends its complete JSON onto the unterminated fragment.
**Unhandled:** Nothing on either leg checks for or repairs a missing trailing newline. The concatenation `{"messageId":"a","runId":"r1","mess{"messageId":"b",...}\n` is ONE line that `JSON.parse` rejects, so `localSteeringInbox.drain` skips it (`attach.ts:278-281`) and message **b** — a fully valid, successfully appended message — is never delivered. `attachToRun` then polls to the 30 s ceiling and returns `attach-not-acked`, and the CLI prints the remediation *"the message IS queued in the box — check the resident agent is running"* (`chunk-cli.diff:339-341`), which is false. A leading `printf '\n'` (or an `awk`/`tail -c1` newline guard) in `appendScript` would close it.
**Verified:** read `attach.ts:123-134` (`umask … && mkdir -p … && cat >> … && chmod 600` — no newline normalisation) and `attach.ts:265-288` (drain skips unparseable lines, never repairs).

---

### [MEDIUM] `fleet attach` is not refused for a run whose approval is already SETTLED — its box is gone for exactly the same reason
**Where:** `src/fleet/attach.ts:199-204` (verified)
**Trigger:** `fleet approve r1 --approver a1 < token` succeeds; then `fleet attach r1 --driver exedev --message "one more thing"`.
**Unhandled:** The guard covers only `pausing` and `awaiting-approval`. `approved`, `rejected` and a persisted `timed-out` fall straight through — but the box was destroyed *at pause time*, before the decision ("`requestApproval` runs the REAL teardown before promoting to `awaiting-approval`", `src/fleet/status.ts:476-482`), so every settled state is strictly *after* that teardown and its box is just as gone. `rec.vmName` is still on the record, so `vm !== undefined` passes too, and attach execs into a destroyed box: an unclassified driver error → exit 1 → "retry me". `rec.closedAt` is not consulted at all, so the same holds for any closed run. A `state !== undefined || rec.closedAt !== undefined` refusal would give the operator the `run-not-attachable` envelope the code already has.
**Verified:** read `attach.ts:192-212`; the teardown-precedes-promotion fact is asserted in the diff's own `status.ts` comment (`chunk-fleet-attach.diff:401-403`, real `src/fleet/status.ts:476-482`).

---

### [MEDIUM] An unwritable acks file makes every attach report `attach-not-acked` forever while messages ARE being delivered
**Where:** `src/phase-engine/steering.ts:391-395` (verified) + `src/fleet/attach.ts:284-290` (verified)
**Trigger:** `/run/steering/acks.ndjson` exists 0600 owned by another uid, or the box's `/run` tmpfs is full. `localSteeringInbox.ack` throws EACCES/ENOSPC from `appendFileSync`.
**Unhandled:** `drainInbox` swallows the ack throw with a bare `catch {}` and — unlike the drain failure directly below it — does **not** call `onInboxError`, so the fault reaches no trace, no `lastDegradationReason`, and no operator. Every `fleet attach` therefore polls the full 30 s, exits 6, and prints "check the resident agent is running before sending it again; a re-send delivers it twice" — while the resident is healthy and *has* folded the message. The operator's only visible remedy is the re-send that double-delivers. `onInboxError` is wired for drain only (`chunk-cli.diff:381-392`).
**Verified:** read `src/phase-engine/steering.ts:374-427`; `onInboxError` is invoked only in the outer catch (line 422), never in the ack catch (line 393).

---

### [MEDIUM] Inbox dedupe is per-process only and the inbox is never truncated: a resident restart replays every past message
**Where:** `src/phase-engine/steering.ts:378-379` (verified) + `src/fleet/attach.ts:265-288` (verified)
**Trigger:** Ten `fleet attach` messages are folded over a run's life; the resident process is restarted (crash, OOM, `startResident` respawn). The next solicitation point calls `drain()`.
**Unhandled:** `delivered` is a `Set` in the `createSteering` closure, so it is empty in the new process, and `drain()` reads the WHOLE file every time by design ("never truncates it… dedupe on `messageId` makes re-reading free of consequence", `attach.ts:258-261`). All ten stale operator directives are re-pushed into the cumulative `ctx.promptContext` and re-acked. The claimed exactly-once property holds only within one process lifetime; nothing persists `delivered` (the acks file already records every delivered id and is not consulted on the drain side).
**Verified:** read `steering.ts:374-396` — `delivered.has/add` with no persistence and no seeding from `acksPath()`.

---

### [MEDIUM] `fleet attach` with no `--message` on an interactive terminal parks for 120 s, then refuses with a brief-shaped envelope naming a flag `attach` does not accept
**Where:** `scripts/fleet.ts:2542` (verified) → `scripts/fleet.ts:706-735` (verified)
**Trigger:** `fleet attach r1 --driver exedev` typed at a shell prompt (stdin is a TTY, never reaches EOF).
**Unhandled:** `readCappedStdin` has no TTY / no-data-yet shortcut — deliberately so, since it tests fd 0's readiness rather than `isTTY` — so the verb sits silent for `STDIN_BRIEF_TIMEOUT_MS` = 120 s and then throws `FleetError(2, "brief-stdin-timeout", "no brief arrived on stdin within 120s", "…or pass --brief <path> instead")`. `attach` declares no `--brief` flag (`chunk-fleet-attach.diff:474-480`), so the remediation instructs the operator to use a flag that `parseArgv` will refuse with exit 2, and the code names a "brief" for a verb that has no brief. The block's own comment claims the operator "gets the message-shaped refusal rather than a brief-shaped one" (`chunk-cli.diff:283-285`) — that reasoning covers only the size cap, not the timeout.
**Verified:** read `scripts/fleet.ts:699-750`; confirmed `attach`'s registry entry declares only `--driver/--dir/--message/--help`.

---

### [MEDIUM] A paused approval row silently drops `closedAt` and never reports `boxAlive`, even when the box list succeeded and proved the box gone
**Where:** `src/fleet/status.ts:490-493` (verified)
**Trigger:** `fleet status --dir .runs` with one run at the gate (`extensions.approval.state = "awaiting-approval"`, `closedAt` set by the pause teardown) and a driver list that returned successfully.
**Unhandled:** The approval arm returns `{ ...base, ...approval }` and short-circuits before the `closed` arm, so the row carries neither `closedAt` (which the code's own comment says EVERY genuinely paused record has — `status.ts:476-482`) nor `boxAlive`. Per `StatusRow`'s documented contract an absent `boxAlive` means "no evidence about the box" and is reserved for `boxes === null`; here it is absent on the success path too, so the one row where an operator most wants confirmation that nothing is still billing is the row that can never carry it. A paused row is also indistinguishable from a paused row observed during a `listUnavailable` sweep.
**Verified:** read `src/fleet/status.ts:441-509`; the `closed` arm at 497-509 sets both fields, the approval arm at 490-493 sets neither.

---

### [LOW] `attach` can exceed its documented 30 s ceiling by a full per-call timeout
**Where:** `src/fleet/attach.ts:232-244` (verified)
**Trigger:** The ack poll reaches `now() - baseline = 29_900 ms`, enters the loop, and the box hangs so that `readAck`'s exec runs the full `ATTACH_PER_CALL_TIMEOUT_MS` (10 s).
**Unhandled:** The ceiling is checked only *before* dispatching a tick and *after* it returns, never against the remaining budget when computing the per-call timeout. `AC6's ack ceiling — 30 s` (`attach.ts:55`) is therefore a ~40 s wall-clock worst case. Passing `Math.min(perCallTimeoutMs, ceilingMs - (now() - baseline))` would bind it.
**Verified:** read `attach.ts:226-248` — `perCallTimeoutMs` is a constant across every tick.

---

### [LOW] `--approver ""` passes the presence guard and produces an allowlist refusal with an empty subject instead of the usage envelope
**Where:** `scripts/fleet.ts:2366-2372` (diff `chunk-cli.diff:113-119`, verified)
**Trigger:** `fleet approve r1 --approver "" < token` (or `--approver=`).
**Unhandled:** The guard tests `approverId === undefined` only, so the empty string flows through to `authenticateFromStdin(cwd, "")`. `Object.hasOwn(parsed.approvers, "")` is false, so the operator gets exit 5 with `approver-unknown` and the message `" is not a registered approver in .factory/approvers.json"` — a refusal whose subject is blank — rather than the exit-2 usage envelope naming `--approver`, which is what an empty flag value is. A `.trim() === ""` check alongside the `undefined` check covers it.
**Verified:** read `src/fleet/approvers.ts:224-241` — the lookup is `Object.hasOwn`-guarded, so `""` is safely refused, but nothing upstream classifies it as usage.

---

### [LOW] A successful idempotent `approve`/`reject` is logged with `status: "error"`
**Where:** `scripts/fleet.ts:2349` (diff `chunk-cli.diff:96`, verified by offset)
**Trigger:** `fleet approve r1 --approver a1 < token` run twice. The second returns `outcome: "already-decided"`, which the block deliberately maps to **exit 0** ("BOTH remaining arms are SUCCESS", `chunk-cli.diff:225-230`).
**Unhandled:** `gateEvent`'s status expression is `fields.outcome === "decided" || fields.outcome === "attach-acked" ? "ok" : "error"`, so the structured gate line for that exit-0 invocation reads `status: "error"`. A dashboard alerting on `fleet.approve` + `status:"error"` fires on the documented idempotent success path. `"already-decided"` is missing from the ok-list.
**Verified:** offset for this hunk confirmed against the real file (`readCappedStdin` at `scripts/fleet.ts:2542` matches `chunk-cli.diff:289`); the outcome union comes from `submitDecision` in `src/fleet/approval-gate.ts:426-487`.

---

**10 findings: 2 HIGH, 5 MEDIUM, 3 LOW.**
