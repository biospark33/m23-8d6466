# Blind adversarial review — chunk-engine.diff

Input: `/tmp/pr150-review/chunk-engine.diff` only. All line numbers are diff-file-relative.

---

### [HIGH] A failed `ack` marks the message delivered forever, producing the exact `attach-not-acked` lie the comment claims to prevent
**Where:** chunk-engine.diff:78-95 — src/phase-engine/steering.ts `drainInbox`
**Trigger:** Operator attaches message `m1`. `drain` returns it, `delivered.add("m1")` runs, the line is pushed into `ctx.promptContext`, then `deps.inbox.ack("m1", point)` throws (EACCES / ENOSPC / transient FS error). The run continues and solicits again.
**Problem:** The `catch {}` around `ack` swallows the failure, but `delivered` has already absorbed `m1`. `drain` re-reads in FULL on the next solicitation and returns `m1` again — and `if (delivered.has(messageId)) continue;` skips it before any retry of the ack. So the ack is never written for the run's lifetime and `fleet attach` reports `attach-not-acked` for a message that landed. The docstring at :62-68 states the ack is written at fold time specifically so this cannot happen; the in-memory dedupe set defeats that by making the ack a one-shot with no retry. Correct order would be ack-then-mark, or removal from `delivered` in the catch.

### [HIGH] Retiring `supersededReportId` for `supersededReportIds` ships no migration and no read-side compatibility
**Where:** chunk-engine.diff:251-252 — src/providers/run-record.ts `EXTENSION_NAMESPACES.approval.fields`
**Trigger:** A run paused under the pre-DF3.4 build has `extensions.approval.supersededReportId: "rv-..."` on disk. The new build runs `fleet approve` / a rebind on that run.
**Problem:** `supersededReportId` is deleted from the `fields` map with nothing added to read it, translate it, or accept it. Consequences, all from this diff: (a) the pre-existing displaced report id is invisible to every new reader, which reads only `supersededReportIds` and finds it absent — the audit trail the docstring at :213-215 calls "the FULL rebind history, ordered oldest-first" silently starts empty and loses the one entry that already existed; (b) any caller that still passes `supersededReportId` now hits `throw new Error("unknown key: ...")` at :359, so the retired key is not merely unread but unwritable; (c) the stale scalar survives every future `set()` because `merged` is cloned from the existing record, so the record permanently carries two disagreeing sources of truth — the precise condition the docstring at :216-219 says was being avoided. The docstring argues *why one field is better*; the code never removes or migrates the other.

### [HIGH] The deleted `supersededReportId: ""` clear has no replacement, and the field it cleared can no longer be cleared at all
**Where:** chunk-engine.diff:596-604 (removed) — src/reverify/approval.ts `recordApprovalPort.requestApproval`
**Trigger:** Run R rebinds once under any build (record now has `supersededReportId: "rv-old"`). Later, a fresh (non-rebind) approval request is made for a new `reportId` under the new build.
**Problem:** The deleted block existed for one stated reason: `set()` deep-merges field-by-field, so an omitted key retains the prior cycle's value, and a stale `supersededReportId` displayed under a *new* `reportId` is a false audit claim. The replacement gate is not in this diff, and even if it clears `supersededReportIds`, it cannot clear the singular key — writing `supersededReportId: ""` now throws `unknown key` (:359). So the stale scalar is pinned to the record permanently, under every subsequent unrelated `reportId`. A guard was deleted and the mechanism that could have re-implemented it was closed off in the same PR.

### [HIGH] The cross-process approval lock is deleted with no replacement visible in this change
**Where:** chunk-engine.diff:406-553 (removed) — src/reverify/approval.ts `withApprovalLock`, `isLockHolderDead`, `lockHolderPid`, `LOCK_TIMEOUT_MS`, `LOCK_STALE_MS`
**Trigger:** Two reverify processes for the same `runId` finish green simultaneously; both call `recordApprovalPort(...).requestApproval(runId, req)`.
**Problem:** The removed code's own docstring (:409-416) names the hazard: `RunRecordStore.set` is atomic but the AC6 decision is read-THEN-write, so without external serialization "an interleaved pair of green verdicts could both read 'no record' and both create one." The new body is a bare `gateRequestApproval({ ...opts, store }, runId, req)` — no lock, no CAS, no compare-on-read token passed through, and `GateDeps` (as spread here) carries nothing that could stand in for one. Nothing in this diff re-establishes the guarantee for the DF5.1 path. Also deleted with it: the ESRCH-only liveness check (never steal a lock from a live-but-EPERM holder), the `LOCK_STALE_MS = 2 × LOCK_TIMEOUT_MS` separation that stops a waiter stealing every lock the instant it times out, the atomic rename-to-claim-path reclaim, the `claimed` fail-closed rule, and the operator-actionable "remove it by hand" timeout message. If `approval-gate.ts` reimplemented all six properties, that is unverifiable from this change; if it reimplemented five, the sixth is a silent regression.

### [MEDIUM] `strings` is now the implicit trailing fallthrough — the exact defect the new comment says it is fixing
**Where:** chunk-engine.diff:296-325 — src/providers/run-record.ts `assertKind`
**Trigger:** Add a fifth `FieldKind` (e.g. `"bool"` or `"json"`) and register a field with it. Write any legal value.
**Problem:** The comment at :297-302 correctly diagnoses that `ports` being the implicit trailing branch routed string arrays into an integer check "that can never accept a legal value, failing at the write with a message naming the wrong type" — then makes `strings` the new implicit trailing branch. There is no `if (kind === "strings")` guard and no exhaustiveness check (`const _: never = kind`), so the next kind added inherits the identical bug and the compiler stays silent. The fix was applied to the instance, not the shape.

### [MEDIUM] `STRINGS_MAX_ELEMENTS` on an append-only history is a permanent brick, not a bound
**Where:** chunk-engine.diff:176, 316-318 — src/providers/run-record.ts `STRINGS_MAX_ELEMENTS`, `assertKind`
**Trigger:** A run accumulates 256 entries in `extensions.approval.supersededReportIds` (the docstring at :164 states the field "gains one element on every df3-4 AC1(a2) rebind with nothing else capping it"). The 257th rebind is attempted.
**Problem:** `assertKind` throws at the write. Because the array is append-only and the writer always sends prior history plus one, *every* subsequent write for that run fails identically — there is no eviction, no truncation, no oldest-first drop, and no way for a caller to shrink the field (writing a shorter array requires a rebind path that is now failing). The run can never be rebound or, if the same namespace write carries the state transition, decided. The docstring at :169-170 frames this as "a named schema rejection at the WRITE ... never a disk problem later"; for an unbounded-by-design accumulator the named rejection *is* the outage. A bound on a growing field needs a shedding policy, not just a throw.

### [MEDIUM] Newly registered `requestId` is deliberately exposed to the secret shape heuristic with no argument that it survives it
**Where:** chunk-engine.diff:248, 260-264 — src/providers/run-record.ts `EXTENSION_NAMESPACES.approval.fields`, `SHAPE_EXEMPT_PATHS`
**Trigger:** `requestApproval` writes `extensions.approval.requestId` with the value from `newRequestId()` (imported at :144). If that id is an opaque high-entropy mixed-case token, `assertNoSecret`'s shape heuristic flags it.
**Problem:** The new comment at :260-264 declares that *no* `extensions.approval` path is exempt, and justifies it for exactly one field — `supersededReportIds`, on the grounds that a reverify id is "short and lowercase by construction". `requestId` and `expiresAt` are added in the same hunk and get no such analysis; `requestId` is precisely the shape (random correlation token) a credential heuristic is built to catch. A false positive here does not degrade — it throws at the write, so the entire approval registration fails and the gate cannot record the pause. The same exposure applies to `proposal`, which the docstring at :168 says is bounded at 8_000 chars of free text: any proposal quoting a token-shaped string (a sample `AKIA…`, a `ghp_…` in a diff excerpt) is rejected at the write.

### [MEDIUM] No `schemaVersion` bump despite a field being removed and three added
**Where:** chunk-engine.diff:244-255 — src/providers/run-record.ts `EXTENSION_NAMESPACES.approval`
**Trigger:** Any reader that branches on `entry.schemaVersion` encounters a record written before and after this change.
**Problem:** The namespace's field set changes incompatibly (one field retired, `requestId` / `expiresAt` / `supersededReportIds` added) and no `schemaVersion` line appears as a `+` in the hunk, so the version is unchanged. Records written by the old and new code are indistinguishable by the one field that exists to distinguish them, which removes any hook a future migration could use to find the records needing repair — and `ExtensionEntry.schemaVersion` (:193) is described as "the store's to stamp", i.e. the intended mechanism for exactly this.

### [MEDIUM] `onInboxError` is not awaited — an async observer's rejection escapes as an unhandled rejection
**Where:** chunk-engine.diff:121-125 — src/phase-engine/steering.ts `drainInbox`
**Trigger:** A caller passes `onInboxError: async (e) => { await writeAuditLine(e); }` and the audit write rejects (disk full, closed handle).
**Problem:** `deps.onInboxError?.({...})` is called inside a `try`, but the returned promise is discarded, so the `catch` only covers a *synchronous* throw. An async observer's rejection becomes an unhandled promise rejection — process-fatal under Node's default in recent majors and under Bun. The comment at :124 claims the guard follows "the same rule as onTripwire's observer: a sidecar must never fail a solicitation"; the guard as written only holds for synchronous observers, and the hook's type `(e) => void` (:46) does not stop anyone passing an `async` function.

### [MEDIUM] Inbox faults clobber `lastDegradationReason` while `telemetry.status` stays `active`
**Where:** chunk-engine.diff:117 — src/phase-engine/steering.ts `drainInbox`
**Trigger:** Solicitation N degrades for a genuine resident reason and sets `lastDegradationReason = "<real cause>"`. Solicitation N+1 begins; the inbox drain fails first (drain runs pre-render at :136) and overwrites the field.
**Problem:** `lastDegradationReason` is a single slot with no ownership discipline; the real resident degradation reason is destroyed by a sidecar channel fault before anything consumes it. The comment at :112-113 states "`telemetry.status` is deliberately untouched: the resident is fine, the channel is not" — so the pair (`status: "active"`, `lastDegradationReason: "steering inbox unreadable: ..."`) is now a reachable, self-contradictory state, and any consumer reading the reason to explain a status change reads a reason belonging to neither the status nor the previous degradation. The comment at :38-40 concedes the field "nothing outside this module reads" — which is an argument for not writing to it at all, not for overwriting another writer's value.

### [MEDIUM] Cumulative attach context is unbounded in COUNT, and head-truncation evicts the original task context first
**Where:** chunk-engine.diff:88-90 — src/phase-engine/steering.ts `drainInbox`
**Trigger:** An operator (or a buggy/looping transport) attaches 500 messages over a long run; each is a distinct `messageId`, so none dedupes.
**Problem:** Per-message length is capped at `DIRECTIVE_TEXT_CHAR_CEILING`, but the number of pushed lines is not, and the comment at :86-87 confirms `promptContext` "is cumulative and rides every later solicitation for the run's lifetime". The comment at :81-82 also states `renderPrompt` "truncates from the HEAD" — so once the ceiling is reached, the lines dropped are the *oldest*, i.e. the original task/phase context, while operator attach chatter accumulates at the tail and survives. A flood of attach messages therefore silently evicts the run's founding context rather than being dropped itself. There is no cap on total folded lines and no cap on total folded characters.

### [MEDIUM] `messageId` is interpolated into the prompt with no length cap
**Where:** chunk-engine.diff:88-90 — src/phase-engine/steering.ts `drainInbox`
**Trigger:** The transport hands back `{ messageId: "<200KB string>", message: "hi" }` — from a corrupted queue file, a hand-edited inbox, or a transport that derives the id from user input.
**Problem:** `message` is capped with `.slice(0, DIRECTIVE_TEXT_CHAR_CEILING)` but `sanitizeForMessage(messageId)` is not truncated at all, so the id contributes unbounded length to a line the comment carefully argues must be bounded. `messageId` is also unvalidated as to type — a non-string id would make `sanitizeForMessage` behave arbitrarily and `delivered.has` compare by identity.

### [MEDIUM] Silent truncation is acked as full delivery
**Where:** chunk-engine.diff:89, 91-95 — src/phase-engine/steering.ts `drainInbox`
**Trigger:** Operator runs `fleet attach` with a 20 000-char steering message; `DIRECTIVE_TEXT_CHAR_CEILING` is smaller.
**Problem:** The message is cut with no marker, no ellipsis, and no diagnostic, and is then `ack`ed — so the operator's only feedback channel reports the message as delivered while the resident saw a prefix. Truncating mid-sentence can also invert the meaning of the instruction that survives ("do not merge until X" → "do not merge"). Separately, `.slice` operates on UTF-16 code units, so a cut landing inside a surrogate pair emits a lone surrogate into the prompt.

### [LOW] `detached()`'s stated precondition does not hold at one of its two call sites
**Where:** chunk-engine.diff:337-347, 355 — src/providers/run-record.ts `detached`, `validateExtensions`
**Trigger:** A value reaching the early-assign branch at :354-356 (the branch that `continue`s past validation) is an array whose elements are objects or arrays.
**Problem:** The docstring at :338-343 justifies the shallow copy on the grounds that "`assertKind` has already proven a `strings` value is a flat array of strings". That is true for the call site at :363, which runs after `assertKind` (:360). It is false for the call site at :355, which is reached by a `continue` that skips both `assertKind` and `assertNoSecret` entirely. On that path `[...value]` copies only the outer array, so nested caller-owned objects stay aliased into the stored record — the exact desynchronization the function exists to prevent — and the values also skip the bounds check and the secret scan.

### [LOW] `delivered` grows without bound for the run's lifetime
**Where:** chunk-engine.diff:55 — src/phase-engine/steering.ts `delivered`
**Trigger:** A long-lived resident run with a transport that emits many messages, or one that re-emits ids in a loop.
**Problem:** The set is never pruned and never bounded. Since `drain` "re-reads in FULL" (:18-19), the set must retain every id the inbox has ever returned, so its size tracks total inbox history rather than in-flight work — a slow leak in exactly the long-running process it was added to.

### [LOW] Non-transport failures are misreported as "steering inbox unreadable", and consume messages on the way out
**Where:** chunk-engine.diff:97, 114-116 — src/phase-engine/steering.ts `drainInbox`
**Trigger:** `drain` succeeds and returns three messages; `sanitizeForMessage` (or `.slice` on a non-string `message`) throws while processing the second.
**Problem:** The outer `catch` attributes any throw from the whole loop body to the transport: `steering inbox unreadable: <msg>`. The comment at :101-106 rests the entire diagnostic on the transport's ENOENT-vs-throw contract, but the `try` also spans sanitization, truncation and the push, so a payload bug is reported to the operator as a broken channel. Worse, message #2 is already in `delivered` and message #3 was never reached — #2 is now permanently skipped (never folded, never acked) and #3 is only recovered because the next drain re-reads in full.

### [LOW] Inbound attach text is capped by a constant named for outbound directive text
**Where:** chunk-engine.diff:89 — src/phase-engine/steering.ts `drainInbox`
**Trigger:** DF3.6 (or anyone) tunes `DIRECTIVE_TEXT_CHAR_CEILING` for its stated purpose — the length of a parsed directive.
**Problem:** The attach-message cap moves with it, silently, in whichever direction. The two limits govern unrelated things — the header at :12-15 is emphatic that "prompt context is INPUT, a directive is OUTPUT" — yet the code binds the input bound to the output constant. The comment at :85-87 asserts a distinct rationale for the input cap (cumulative context riding every later solicitation) without giving it a distinct constant.

### [LOW] `opts = {}` makes a teardown-less approval port the silent default
**Where:** chunk-engine.diff:556 — src/reverify/approval.ts `recordApprovalPort`
**Trigger:** Any new caller writes `recordApprovalPort(store)` — the pre-existing one-argument signature — for a context that does have a live box.
**Problem:** The header at :438-442 states that a port built without `teardown` "registers and promotes with no teardown step", which it declares correct for the reverify runner only, with "the fleet verb passes the real one." The default parameter makes the dangerous case the one you get by omission and the safe case the one you must remember, with no type-level or runtime signal — the old signature keeps compiling and silently drops the teardown step.

---

**18 findings: 4 HIGH, 9 MEDIUM, 5 LOW.**
