# Blind adversarial review — attach transport, status join, approve/reject/attach CLI

Inputs: `chunk-fleet-attach.diff`, `chunk-cli.diff`. No repo access; findings are derived from the diffs alone.

---

### [HIGH] `attachToRun` has no closed/settled guard — it will exec against a destroyed box
**Where:** chunk-fleet-attach.diff:204-210 — `src/fleet/attach.ts` `attachToRun`
**Trigger:** `fleet teardown r-123` (or an already `approved`/`rejected` run whose box was destroyed), then `fleet attach r-123 --driver exe --message "hi"`.
**Problem:** The only refusals are `state === "pausing"`, `state === "awaiting-approval"`, and `vmName === undefined`. A torn-down run keeps its `vmName` in the record and — for teardown or a settled approval — carries either no `extensions.approval` at all or a state that is not one of the two paused values. Both guards pass, and the function proceeds to `driver.exec` against a VM that no longer exists. `rec.closedAt` is never consulted, even though `status.ts` in the same PR treats it as the authoritative "this run is over" marker. The operator gets a driver-shaped exception instead of the clean `run-not-attachable` refusal (exit 5) that the CLI block was written to render, and the exit code lands on whatever `report(note, e)` classifies an exec failure as.

### [HIGH] Every append failure throws unclassified, so a possibly-landed message gets a retryable exit
**Where:** chunk-fleet-attach.diff:224-231 — `src/fleet/attach.ts` `attachToRun`; chunk-cli.diff:346-349 — `scripts/fleet.ts` attach catch
**Trigger:** The box is slow and `withTimeout(..., 10_000, "attach-append")` fires while the in-box `cat >>` is still running to completion; or the driver's transport drops after the payload was flushed but before the exit status came back.
**Problem:** `withTimeout` is a host-side deadline — it does not cancel the in-box `cat`. On timeout the promise rejects, the rejection escapes `attachToRun` untyped, and the CLI's `catch` hands it to `report(note, e)`, which will classify a transport failure as transient (exit 1). Exit 1 means "retry me", and a retry mints a **new** `crypto.randomUUID()` `messageId` — so the dedupe key that the whole design leans on (`messageId` is the dedupe key … a later solicitation still delivers it exactly once) is defeated and the guidance is delivered twice. The `attach-not-acked` arm at chunk-cli.diff:330-343 argues this exact hazard at length and returns 6 to avoid it; the append-failure path throws straight past that reasoning. The same applies to the `res.exitCode !== 0` throw at chunk-fleet-attach.diff:229 — a non-zero `cat` can follow a partial write.

### [HIGH] `QDS_STEERING_ROOT` is read on the host but the path it produces is used inside the box
**Where:** chunk-fleet-attach.diff:48-58, 225, 152 — `src/fleet/attach.ts` `steeringRoot` / `inboxPath` / `acksPath`
**Trigger:** An operator (or CI job, or a shell that previously ran the host-side suite) has `QDS_STEERING_ROOT=/tmp/steer` exported, then runs `fleet attach r-123 --driver exe --message "..."` against a real box.
**Problem:** The host leg computes `inboxPath()` in the **host** process and interpolates the result into a script that runs in the **box**, while the engine leg (`localSteeringInbox`, running in the box) computes the same function from the **box's** environment. The two legs therefore resolve to different files whenever the host has the override set and the box does not. `appendScript` starts with `mkdir -p`, so the wrong path is created silently and `cat` exits 0 — no failure surfaces. The ack poll then reads the same wrong `acks.ndjson`, never sees an ack, and the run ends at exit 6 telling the operator "the message IS queued in the box" while the engine drains `/run/steering/inbox.ndjson` forever. The doc comment claims the variable exists "solely so the host-side suite can exercise the real paths", but nothing confines it to that use.

### [HIGH] Concurrent `cat >>` appends can interleave and corrupt NDJSON lines
**Where:** chunk-fleet-attach.diff:129-134, 224-228 — `src/fleet/attach.ts` `appendScript` / `attachToRun`
**Trigger:** Two `fleet attach` invocations against the same run at the same time (two operators, or an operator plus an automation), each with a message in the multi-KB range — `DIRECTIVE_TEXT_CHAR_CEILING` allows 4000 chars, and `JSON.stringify` escaping of quotes/newlines plus the `messageId`/`requestId`/`runId`/`sentAt` fields pushes the payload past `PIPE_BUF` (4096).
**Problem:** `cat >> file` gets an `O_APPEND` fd, which makes each individual `write()` atomic w.r.t. the file offset — but it does **not** make a multi-`write()` copy atomic. `cat` reads its stdin (a pipe fed over the driver transport, delivered in chunks) and issues one `write()` per chunk, so a second `cat` running concurrently interleaves its chunks between the first's. The result is two mangled lines instead of two valid ones. `localSteeringInbox().drain()` skips unparseable lines by design (chunk-fleet-attach.diff:284-286), so **both** steering messages are silently discarded — while both `cat` processes exit 0 and both CLI invocations report the message as queued. Nothing in this path takes the fleet lock or any other mutual exclusion. The module comment asserts torn lines arise only from "a `cat >>` killed mid-append", which understates the actual failure mode.

### [HIGH] No TTY guard on stdin: `attach` and `approve`/`reject` hang interactively, and a typed token is echoed
**Where:** chunk-cli.diff:289 — `scripts/fleet.ts` attach (`readCappedStdin`); chunk-cli.diff:159 — approve/reject (`authenticateFromStdin`)
**Trigger:** `fleet attach r-123 --driver exe` typed at a terminal with no `--message` and nothing piped; or `fleet approve r-123 --approver alice` with no piped token.
**Problem:** Both verbs fall through to a blocking stdin read with no `process.stdin.isTTY` check anywhere in the diff. The process hangs with no prompt and no diagnostic until the operator finds Ctrl-D — and the verb registry declares `--message` as `required: false`, so a generated skill or a `--help` reader is actively told the flag is optional. For `approve`/`reject` the consequence is worse: the approver's token is typed into a terminal in canonical mode, so it is echoed to the screen and lands in the terminal's scrollback. The `--approver` flag comment (chunk-fleet-attach.diff:436-438) justifies stdin delivery on the grounds that argv is visible in `ps`; an echoed TTY line is not obviously better.

### [MEDIUM] `readAck` maps every transport failure to "absent", so a dead box reports as a live not-acked run
**Where:** chunk-fleet-attach.diff:158-162 — `src/fleet/attach.ts` `readAck`
**Trigger:** The box is destroyed (orphan reaper, provider-side eviction, `fleet teardown` from a second shell) between the successful inbox append and the first ack poll.
**Problem:** Both the `exitCode !== 0` path and the `catch` return `"absent"` — "no evidence either way". A permanently-dead box therefore produces 60 identical "absent" ticks, the loop runs the full 30 s ceiling, and the CLI renders `attach-not-acked` with the remediation "the message IS queued in the box — check the resident agent is running before sending it again; a re-send delivers it twice" (chunk-cli.diff:340). Every clause of that is false when the box is gone: the message is not queued, the resident is not merely idle, and a re-send is the correct action rather than a double-delivery hazard. There is no distinction between "cat says not there yet" and "the box does not answer".

### [MEDIUM] The status approval override fires when the box **list** failed, masking `listUnavailable`/`boxUnknown`
**Where:** chunk-fleet-attach.diff:414-417 — `src/fleet/status.ts` `rowForRecord`
**Trigger:** The provider list call fails (`boxes === null`) during `fleet status` while a run sits in `pausing`.
**Problem:** `const box = boxes === null ? undefined : ...` (chunk-fleet-attach.diff:392) collapses two distinct conditions into `undefined`: "the list came back and this box was not in it" and "there is no list". The new branch guards only on `box === undefined`, so it pre-empts the `listUnavailable`/`boxUnknown` arms as well as `boxMissing`. The comment defends the placement with "A LIVE box also still outranks the pause — `box === undefined` is the guard", which holds only when a list actually exists. In the list-failure case the operator is shown `awaiting-approval` with no `boxAlive`, and the fact that the driver could not be consulted at all — which the `boxUnknown` state exists to communicate, and which matters most for a `pausing` run whose box may still be billing — is erased from the row.

### [MEDIUM] `gateEvent` logs `status: "error"` for `already-decided`, which exits 0
**Where:** chunk-cli.diff:96, 242-247 — `scripts/fleet.ts` `gateEvent`
**Trigger:** `fleet approve r-123 --approver alice` run twice; the second invocation returns `{outcome: "already-decided"}`.
**Problem:** `status` is computed as `fields.outcome === "decided" || fields.outcome === "attach-acked" ? "ok" : "error"`. The second invocation exits **0** — the block at chunk-cli.diff:225-230 argues explicitly that `already-decided` is a success — but emits a structured log line with `status: "error"` and `event: "approve"`. Any alerting or dashboard keyed on `status` (the obvious use for the field) fires on the documented idempotent-success path. The same mismatch applies to `run-not-attachable`, a deliberate refusal.

### [MEDIUM] `--approver ""` passes the required-flag guard
**Where:** chunk-cli.diff:115-121 — `scripts/fleet.ts` approve/reject
**Trigger:** `fleet approve r-123 --approver "" < token` — trivially produced by an unset shell variable, e.g. `--approver "$APPROVER"`.
**Problem:** The guard is `if (approverId === undefined)`, which an empty string passes. `authenticateFromStdin(process.cwd(), "")` is then called with an empty id and, if it refuses, produces an allowlist-shaped refusal (exit 5, "check the token / the allowlist") instead of the usage error (exit 2, "pass the approver id registered in .factory/approvers.json") that the operator actually needs. The `--message` path in the same file gets this right — it trims and rejects the empty result (chunk-cli.diff:289-292) — so the inconsistency is within the same diff. `--reason ""` is harmless by comparison since it is defaulted, but `--dir ""` has the same shape.

### [MEDIUM] `--reason` is unbounded and echoed unsanitized while every neighbouring field is capped
**Where:** chunk-cli.diff:188, 240 — `scripts/fleet.ts` approve/reject
**Trigger:** `fleet approve r-123 --approver alice --reason "$(head -c 100000 /dev/urandom | base64)"`, then `fleet approve r-123 --approver alice` again.
**Problem:** `reason: flags.get("--reason") ?? ""` goes straight into `submitDecision` and is persisted into the record with no length cap — up to `ARG_MAX`, roughly 1 MB per record. On the `already-decided` replay it comes back out and is spread verbatim into the stdout line as `reason: outcome.reason`, while every other echoed value on the surrounding lines goes through `sanitizeLabel(..., 64)` or `sanitizeLabel(..., 128)` (chunk-cli.diff:201-203, 215-219, 341). `runIdArg` gets `assertFleetRunId`, `--message` gets `DIRECTIVE_TEXT_CHAR_CEILING`; `--reason` gets nothing, in the one verb whose whole job is writing to a durable record.

### [MEDIUM] Timed-out ack `exec`s are never cancelled and accumulate
**Where:** chunk-fleet-attach.diff:151-155, 238-250 — `src/fleet/attach.ts` `readAck` / `attachToRun`
**Trigger:** The box accepts exec sessions but they hang (network partition, provider-side stall), with a reduced `perCallTimeoutMs` — e.g. the CLI's `attachOptions` seam set to `{ perCallTimeoutMs: 500, pollIntervalMs: 100 }`.
**Problem:** `withTimeout` races a timer against `deps.driver.exec` and abandons the loser; nothing aborts the underlying exec. The poll loop then starts a fresh exec on the next tick while the previous one is still open, so hung sessions accumulate for the whole ceiling — dozens of concurrent sessions against one box at aggressive settings, and any still open when the CLI exits are leaked. Separately, each abandoned `exec` promise will settle later; unless `withTimeout` explicitly absorbs the loser's rejection, that is a post-timeout rejection with no handler attached.

### [LOW] The inbox is never truncated or rotated, and every drain re-reads and re-parses all of it
**Where:** chunk-fleet-attach.diff:266-289 — `src/fleet/attach.ts` `localSteeringInbox`
**Trigger:** A long-lived run receiving steering messages over hours; each message is up to 4000 chars.
**Problem:** `drain()` does `readFileSync(inboxPath(), "utf8")` on the whole file and parses every line at every solicitation point, returning all of them to the controller each time. Nothing ever truncates, rotates, or caps the file — the comment justifies not truncating (correct: it cannot be made safe against a concurrent `cat >>`) but no alternative bound is applied either, and no cap is placed on the read. Cost is O(total messages) per drain and the whole history is re-delivered to the controller's dedupe on every solicitation. There is also no `steeringRoot()` size ceiling, so an inbox is an unbounded write target on `/run`, which is typically a tmpfs sized as a fraction of RAM.

### [LOW] A corrupt acks file is reported identically to a timeout, with the wrong remediation
**Where:** chunk-fleet-attach.diff:241-253 — `src/fleet/attach.ts` `attachToRun`
**Trigger:** `acks.ndjson` contains only non-JSON bytes (a stray write, a truncated file after a box crash); three consecutive ticks return `"unusable"`.
**Problem:** The `ACK_UNUSABLE_TICKS_LIMIT` break exits the loop and falls into the exact same `return { outcome: "attach-not-acked", ... }` as a clean ceiling expiry. The distinction the constant was introduced to draw — "a file that never parses is CORRUPTION, not latency" — is computed and then discarded before it reaches the caller. The operator is told "check the resident agent is running", when the actionable fact is that the box's ack file is corrupt and no ack will ever be readable from it.

### [LOW] `ceilingMs: 0` (or negative) skips the ack poll entirely
**Where:** chunk-fleet-attach.diff:234-238 — `src/fleet/attach.ts` `attachToRun`
**Trigger:** `deps.attachOptions = { ceilingMs: 0 }` via the `FleetDeps.attachOptions` seam.
**Problem:** `while (now() - baseline < ceilingMs)` is false on the first evaluation, so the message is appended and the function returns `attach-not-acked` without ever calling `readAck`. There is no floor on `ceilingMs` and no floor on `pollIntervalMs` either (a `0` interval turns the loop into a hot spin issuing back-to-back `exec`s at the box for the full ceiling). The seam is documented as production-reachable through `FleetDeps`.

### [LOW] The decision-line `else` is a catch-all that labels any unexpected outcome `already-decided` and exits 0
**Where:** chunk-cli.diff:231-241, 251 — `scripts/fleet.ts` approve/reject
**Trigger:** `submitDecision` gains or returns any `DecisionOutcome` variant other than the four handled.
**Problem:** After the `report-changed` and `not-decidable` arms return, the code branches only on `outcome.outcome === "decided"`; everything else is assumed to be `already-decided` and the string `"already-decided"` is **hardcoded** into the emitted line rather than read from `outcome.outcome`. An unrecognised outcome is therefore reported to the operator as a settled decision and exits 0, with the real outcome discarded. `gateEvent` at chunk-cli.diff:243 does log the true `outcome.outcome`, so stdout and the structured log disagree.

### [LOW] attach builds a writable store on the default-dir path, contradicting its own rationale
**Where:** chunk-cli.diff:270-276 — `scripts/fleet.ts` attach
**Trigger:** `fleet attach r-123 --driver exe --message "hi"` with no `--dir`.
**Problem:** `create: dir === undefined` means the *default* records dir gets a `create: true` store — which, per the approve/reject comment two blocks up, performs the chmod 0700, the temp sweep and the O_EXCL probe. The comment immediately above this construction says attach "WRITES NOTHING to the record … so the writable second construction harvest/teardown needs would buy a chmod and a temp sweep for nothing", but the condition delivers exactly that on the common path. Since `assertRunExists` requires the record to already exist, attach never needs `create: true` at all; `create: false` unconditionally would match the stated intent.

### [LOW] `rowForRecord`'s doc comment is now bound to `approvalRowFields`
**Where:** chunk-fleet-attach.diff:343-390 — `src/fleet/status.ts`
**Trigger:** Hover `approvalRowFields` in any editor, or read the file top-down.
**Problem:** The new function is inserted **between** the pre-existing `rowForRecord` doc comment (ending "…Matching on `vmName` alone reports that box missing, which is the INV-1 crash window the record was designed to survive.") and `rowForRecord` itself. That comment now documents `approvalRowFields`, which does no `vmName` matching and has nothing to do with INV-1, while `rowForRecord` is left with no doc comment at all. The insertion point should have been after the closing `*/` that belongs to `rowForRecord`.

### [LOW] attach's stdin read has no test seam, unlike the token read it sits beside
**Where:** chunk-cli.diff:23-37, 289 — `scripts/fleet.ts` `FleetDeps` / attach
**Trigger:** Writing an in-process test for the empty-message refusal or the over-ceiling refusal on the stdin path.
**Problem:** `FleetDeps` gained `authenticate` specifically because "the token arrives on fd 0, which a test cannot attach to in-process", and `readBrief` exists for the same reason. attach's message read calls the module-level `readCappedStdin()` directly with no injectable override, so the stdin branch of the verb — which is the *default* branch when `--message` is omitted, and the one that carries the TTY hang and the trimming logic — is unreachable from an in-process test. The `attachOptions` seam covers the ceiling but not the input.

### [LOW] attach's stdout line re-uses the key `requestId` for the run record's id, not the invocation's
**Where:** chunk-cli.diff:329 — `scripts/fleet.ts` attach; chunk-fleet-attach.diff:103-106, 220 — `AttachResult`
**Trigger:** Any successful `fleet attach`, parsed by a consumer that also reads `fleet dispatch` output or the structured log.
**Problem:** `JSON.stringify({ runId: runIdArg, ...res })` spreads `AttachResult`, which carries `requestId` taken from `rec.requestId` — the **dispatch** request id. Every other `requestId` the CLI emits (including `gateEvent`'s, four lines earlier in the same invocation) is the invocation's own id from `parseArgv`. Two different identifiers share one key name in the same verb's output. `messageId` is likewise spread raw while the `attach-not-acked` error path takes care to `sanitizeLabel(res.messageId, 128)`.

### [LOW] `--message -` is an undeclared sentinel and makes the literal message `-` unsendable
**Where:** chunk-cli.diff:281-289 — `scripts/fleet.ts` attach; chunk-fleet-attach.diff:479 — `src/fleet/verbs.ts`
**Trigger:** `fleet attach r-123 --driver exe --message -`.
**Problem:** `messageFlag === "-"` silently switches to the stdin read. The verb registry declares `--message` as a plain `valueType: "string"` with no mention of the sentinel, so `fleet --help` and any DF3.5-generated skill will present `-` as an ordinary value. On a TTY this turns an explicit inline message into the interactive hang from the TTY finding above, and there is no escape hatch for sending the one-character message `-`.

### [LOW] Run existence is disclosed before authentication
**Where:** chunk-cli.diff:136-159 — `scripts/fleet.ts` approve/reject
**Trigger:** `fleet approve r-guessed --approver anything < /dev/null` against ids in turn.
**Problem:** `assertRunExists` runs before `authenticate`, so an unauthenticated caller distinguishes "no such run" (exit 4, immediate) from "run exists" (proceeds to the token read) purely from the exit code and timing. Every other guard in the block is careful about ordering — the expiry sweep and the decidability check are both deliberately placed *after* authentication — so the existence probe is the one oracle left open.

### [LOW] `reportId` is silently truncated in status output
**Where:** chunk-fleet-attach.diff:376-379 — `src/fleet/status.ts` `approvalRowFields`
**Trigger:** An approval bound to a report whose id is longer than `MAX_REQUEST_ID`.
**Problem:** `sanitizeOptional(..., MAX_REQUEST_ID)` truncates without any marker. The `ponytail:` comment justifies reusing the bound on the grounds that "a reportId is the same class of harness-minted id", which is an assumption about a foreign id space, not a constraint on it. Because `fleet status` is described elsewhere in this PR (chunk-cli.diff:154-156) as the place an operator reads the report id in order to act on it, a truncated value is a value the operator will copy and use.

---

**Count: 22 findings — 5 HIGH, 6 MEDIUM, 11 LOW.**
