# Edge-case findings — engine layer (chunk-engine.diff)

Scope: `src/phase-engine/steering.ts`, `src/providers/run-record.ts`, `src/reverify/approval.ts`.

---

### [HIGH] A degraded resident silently stops draining the inbox forever — the exact silent failure `onInboxError` was added to close, through the other door
**Where:** src/phase-engine/steering.ts:444 (verified) — `if (telemetry.status !== "active") return PROCEED;`, which sits BEFORE the new `await drainInbox(point, ctx)` at src/phase-engine/steering.ts:449 (diff chunk-engine.diff:136)
**Trigger:** One resident call times out or the process dies (`deps.caller.call` throws) → `telemetry.status = "degraded"` (steering.ts:474). Operator then runs `fleet attach` and appends a message.
**Unhandled:** `status` is a one-way latch — it is assigned `"degraded"` at steering.ts:457, :474 and :490 and is never reassigned `"active"` anywhere in the module (verified by grepping every `telemetry.status` site: 412, 430, 444, 457, 474, 490). Every subsequent `solicit` returns at line 444, so `drainInbox` is never reached: the message is never drained, never folded, never acked, and `onInboxError` never fires. The new hook's own docstring (diff:37-45) states the defect being closed is "an operator has no way to learn the channel is broken while `fleet attach` keeps telling them their message 'stays queued'" — this path reproduces that defect exactly, with no diagnostic at all. Nothing degrades `status` back, so it is permanent for the run.
**Verified:** read steering.ts:428-477; grepped all `telemetry.status` assignments.

---

### [HIGH] `onInboxError` returning a rejected promise is an unhandled rejection — the `try/catch` around it only catches synchronous throws
**Where:** src/phase-engine/steering.ts:422 (verified) — `deps.onInboxError?.({ runId, requestId, detail })` (diff chunk-engine.diff:122)
**Trigger:** `createSteering({ ..., onInboxError: async (e) => { await appendFile(auditPath, e.detail); } })` and the append fails (ENOSPC / EACCES), on a run where the inbox is already unreadable.
**Unhandled:** The hook's declared type is `(e: {...}) => void` (steering.ts:293), and TypeScript permits an `async` function to be assigned to a `void`-returning signature. The call is not `await`ed and its return value is discarded, so the rejection escapes the surrounding `try { ... } catch { }` (which only intercepts synchronous throws) and surfaces as a process-level unhandled rejection — killing the run. The comment at diff:124 asserts "a sidecar must never fail a solicitation", which holds only for sync hooks. `deps.inbox.ack` (steering.ts:392) is correctly `await`ed inside its own try/catch; this hook is not.
**Verified:** read steering.ts:371-427; compared with the `onTripwire` call site at steering.ts:347 (same shape, pre-existing).

---

### [MEDIUM] The 256-element `strings` bound turns rebind #257 into a hard throw out of `requestApproval`, bricking the run the rebind path exists to protect
**Where:** src/providers/run-record.ts:73 `STRINGS_MAX_ELEMENTS = 256` (diff:176) enforced at src/providers/run-record.ts:682-684; the unbounded producer is src/fleet/approval-gate.ts:348 `supersededReportIds: [...historyOf(existing), supersededReportId]`
**Trigger:** A run sits in `awaiting-approval` (nobody decides) while reverify is re-run 257 times — e.g. a CI job retrying a green host verdict on a loop.
**Unhandled:** The gate appends with no truncation and no cap of its own. On the 257th rebind `assertKind` throws `extensions.approval.supersededReportIds has 257 elements, over the 256 bound`, `store.set` propagates it, and `requestApproval` REJECTS instead of returning an `ApprovalOutcome`. There is no `rebind-history-full` outcome and no ring-buffer/drop-oldest. The old code's stated goal — "REBIND, never a second create: a re-run of reverify must not brick the run on a record bound to a superseded report" (deleted at diff:572-573) — is defeated at the 257th rebind, and it fails as an unnamed store exception rather than a handled outcome.
**Verified:** read run-record.ts:656-695 (assertKind bounds); read approval-gate.ts:339-352 (append site) and :367 (fresh-request clear).

---

### [MEDIUM] Records written before this PR keep the retired `supersededReportId` scalar forever, alongside the new array — the two-sources-of-truth the schema comment says it eliminates
**Where:** src/providers/run-record.ts:753 (verified) — `const entry: ExtensionEntry = { ...(merged[ns] ?? {}), schemaVersion: version };`; field-set change at diff:251-252
**Trigger:** Run paused and rebound on the pre-PR build → record on disk holds `extensions.approval.supersededReportId: "rv-a"`. Upgrade to this PR. Rebind again → `store.set` writes `supersededReportIds: ["rv-a", "rv-b"]`.
**Unhandled:** The unknown-key rejection (`if (!kind) throw new Error("unknown key: ...")`, run-record.ts, diff:359) only inspects fields present in the INCOMING patch. Fields already on the record are carried over wholesale by the spread at line 753, and read mode explicitly tolerates any value a registered namespace already holds (diff:350-355). The store exposes no way to delete a field and this PR ships no migration, so the retired scalar persists indefinitely. Result: an approval record showing `supersededReportId: "rv-a"` next to `supersededReportIds: ["rv-a","rv-b"]` — precisely the state the schema comment at diff:216-219 says two fields must never reach ("two sources of truth ... in the one place a disagreement is worst, an approval audit trail"). Any reader still reaching for the scalar sees a stale value; `historyOf` (approval-gate.ts:288-291) reads only the array.
**Verified:** read run-record.ts:740-786 (validateExtensions, both modes); grepped `supersededReportId\b` across src/ — no remaining writer, but no remover either.

---

### [MEDIUM] No timeout on the injected `drain` / `ack` inside the serialized solicit chain — a hung inbox stalls the run with no degradation and no diagnostic
**Where:** src/phase-engine/steering.ts:377 `await deps.inbox.drain(point)` and :392 `await deps.inbox.ack(messageId, point)` (diff:77, :92)
**Trigger:** `QDS_STEERING_ROOT` pointed at a stalled NFS/fuse mount, or any future non-local `SteeringInbox` implementation (the port is injected precisely so the transport can be swapped — diff:9-16).
**Unhandled:** Both awaits are unguarded. `solicit` serializes every solicitation through one chain (steering.ts:434-439), so a hung drain wedges every later solicitation for the run — no timeout, no `onInboxError`, no `lastDegradationReason`, and the "solicit never throws, so the chain cannot wedge" claim at steering.ts:432-433 does not cover a hang. The codebase's own convention for this same channel is a deadline: attach.ts:146-149 and :219-222 wrap the box-side reads/appends in `withTimeout(..., "attach-ack-read" / "attach-append")`. The engine side of the same channel has none.
**Verified:** read steering.ts:371-427 and :428-449; read attach.ts:140-230, :260-291.

---

### [MEDIUM] `localSteeringInbox()` has no caller — the `inbox` / `onInboxError` deps are unreachable outside tests, so `fleet attach`'s 30 s ack wait can only ever expire
**Where:** src/fleet/attach.ts:260 `export function localSteeringInbox(): SteeringInbox` (new impl, diff-adjacent) vs. src/phase-engine/steering.ts:290 `inbox?: SteeringInbox` (diff:34)
**Trigger:** `fleet attach <run> --message "..."` on any run.
**Unhandled:** Grepping `inbox:` across `src/` returns zero hits and `createSteering(` has zero call sites in `src/` (only `tests/phase-engine/steering.test.ts`). `localSteeringInbox()` is likewise never called outside its own definition. Nothing in production ever constructs a controller with an inbox, so no message is ever drained or acked, and `ATTACH_ACK_CEILING_MS` (attach.ts:54, 30 s) always elapses into `attach-not-acked`. The wiring may be intentionally deferred to a later story, but nothing in the diff says so, and the new `onInboxError` hook has no producer either — the operator-visibility defect it exists to close cannot be exercised.
**Verified:** `grep -rn "createSteering(" src/ tests/` (src: 0), `grep -rn "inbox:" src/` (0), `grep -rn "localSteeringInbox()" src/` (definition only).

---

### [LOW] The `DIRECTIVE_TEXT_CHAR_CEILING` cap is applied BEFORE sanitization, so one attach line can be ~6x the ceiling
**Where:** src/phase-engine/steering.ts:388-390 (verified) — `sanitizeForMessage(message.slice(0, DIRECTIVE_TEXT_CHAR_CEILING))` (diff:89)
**Trigger:** An attach message of 4 000 `\x7f` bytes (or 4 000 newlines).
**Unhandled:** `sanitizeForMessage` is `JSON.stringify(s).slice(1,-1)` plus a `\uXXXX` pass over `[\x7f\x80-\x9f  ]` (src/phase-engine/types.ts:77-84). A newline expands to 2 chars and `\x7f` to 6, so the slice-then-sanitize order yields up to ~24 000 chars for a 4 000-char cap. The comment at diff:85-87 claims the message "is capped at the DF3.3 ceiling because promptContext is cumulative and rides every later solicitation" — the cap it names does not hold on the value actually stored. `renderPrompt` truncates the joined context from the head (steering.ts:242), so the prompt stays bounded, but the oversized line evicts genuine earlier context instead of being trimmed itself.
**Verified:** read types.ts:77-84; read steering.ts:215, :242, :388-390.

---

### [LOW] `messageId` is sanitized but never length-capped
**Where:** src/phase-engine/steering.ts:389 (verified) — `` `operator attach ${sanitizeForMessage(messageId)}: ...` `` (diff:89)
**Trigger:** A line appended to `/run/steering/inbox.ndjson` with a 1 MB `messageId` — attach.ts:275 accepts any value for which `typeof row.messageId === "string"`, with no length or format check.
**Unhandled:** Only `message` receives `.slice(0, DIRECTIVE_TEXT_CHAR_CEILING)`. The full messageId is interpolated into the prompt-context line and retained in the run-lifetime `delivered` Set (steering.ts:355), so it is never released.
**Verified:** read attach.ts:270-283 (no messageId validation beyond `typeof`); read steering.ts:377-390.

---

### [LOW] `onInboxError` re-fires on every solicitation while the channel stays broken — no dedupe, no backoff
**Where:** src/phase-engine/steering.ts:422 (diff:122)
**Trigger:** `chmod 000 /run/steering/inbox.ndjson` mid-run.
**Unhandled:** `drainInbox` runs at all three steering points on every phase and the catch is unconditional, so the identical `steering inbox unreadable: EACCES ...` is pushed to the observer once per solicitation for the rest of the run. There is no "already reported this fault" flag (contrast `delivered`, which exists for exactly this dedupe purpose one level up). An operator hook that pages or writes an audit line gets N copies of one fact.
**Verified:** read steering.ts:371-427, :441-449.

---

### [LOW] `delivered.add(messageId)` happens before the push, so a throw between them drops that message permanently and misattributes the cause
**Where:** src/phase-engine/steering.ts:379 (`delivered.add`) vs :388 (`ctx.promptContext.push`) (diff:79 vs :88)
**Trigger:** A harness that builds a `SolicitCtx` with `promptContext` undefined or non-array — a case the module explicitly anticipates ("A malformed harness ctx (e.g. promptContext not an array) throws HERE", steering.ts:454).
**Unhandled:** That comment is now stale: `drainInbox` (steering.ts:449) runs BEFORE `renderPrompt` (:452), so `.push` throws first and lands in drainInbox's catch, which reports it as `steering inbox unreadable: ctx.promptContext.push is not a function` — blaming the operator's steering channel for a harness defect, and firing `onInboxError` for a fault that has nothing to do with the inbox. The message is already in `delivered`, so it is skipped on every later drain and can never be folded even if the ctx is fine on the next solicitation. (`renderPrompt` throws immediately after and overwrites `lastDegradationReason` with the correct text, so only the pushed observer event is wrong.)
**Verified:** read steering.ts:374-395 and :441-462.

---

### [LOW] `assertKind` makes `ports` explicit but leaves `strings` as the new implicit catch-all — the identical trap for `FieldKind` #5
**Where:** src/providers/run-record.ts:678-680 (verified) — `if (!Array.isArray(value) || value.some((s) => typeof s !== "string")) throw new Error(\`${key} must be an array of strings\`)` (diff:309-311)
**Trigger:** Add `"bools"` (or any fifth kind) to `FieldKind` and register a field with it; write `[true, false]`.
**Unhandled:** The function has no exhaustiveness guard (no `never` check, no `default: throw`), so the new kind falls through `string` / `int` / `ports` into the string-array branch and is rejected with `must be an array of strings` — a message naming the wrong type, which is verbatim the failure the diff comment at :297-302 says it is fixing for `ports`. The fix is one line: `if (kind !== "strings") throw new Error(\`unhandled field kind ${kind} for ${key}\`);` before the branch.
**Verified:** read run-record.ts:656-695.

---

### [LOW] `supersededReportIds` accepts `""` and duplicate entries; the gate appends `""` when the prior record has no `reportId`
**Where:** src/providers/run-record.ts:678-695 (no emptiness/uniqueness check) and src/fleet/approval-gate.ts:339 `const supersededReportId = String(existing?.reportId ?? "");` → :348 append
**Trigger:** A record in state `awaiting-approval` whose `reportId` is absent — reachable because read mode tolerates whatever a registered namespace already holds (run-record.ts, diff:350-355), e.g. a record written by an older/foreign writer or hand-repaired on disk. Rebind against it.
**Unhandled:** `String(undefined ?? "")` yields `""`, which passes `assertKind` (a `string`, length 0) and `assertNoSecret` (empty after trim, no prefix match, under 40 chars), so `""` is appended as a history entry. The retired scalar used `""` as the explicit "none" sentinel (deleted at diff:603), so an empty element is an ambiguous row in the ordered audit trail with no way to distinguish "no prior report" from a real displaced id. Nothing dedupes either: two rebinds carrying the same `reportId` append it twice, and the history is documented as "each AC1(a2) rebind appends the id it displaced" (diff:213-214), which a repeated id silently contradicts.
**Verified:** read run-record.ts:597-695 (assertNoSecret + assertKind); read approval-gate.ts:336-352.

---

**12 findings: 2 HIGH, 4 MEDIUM, 6 LOW.**
