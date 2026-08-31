# F5 — CLI verb blocks (`scripts/fleet.ts`, `src/fleet/verbs.ts`)

Files touched (owned): `scripts/fleet.ts`, `src/fleet/verbs.ts`, `tests/fleet/verbs.test.ts`.
`tests/fleet/gate-verbs.test.ts` needed **no** edit — every existing assertion still holds.

## Verdict table

| # | Verdict | Note |
|---|---|---|
| 55 (attach half) | **fixed** | `attach` had no TTY guard and read stdin through the brief-labelled reader. Added `process.stdin.isTTY` refusal (exit 2, usage-shaped) + `MESSAGE_INTAKE` so the cap/stall refusals name `--message`. |
| 55 (approve/reject half) | **false positive** | Nothing hangs and nothing is echoed. `authenticateFromStdin` → `readTokenFromStdin` → `assertTokenAttached(0)` (`src/fleet/approvers.ts:295-312`) allow-lists FIFO/file/socket only; a **tty is a character device**, so it returns `approver-token-absent` *before* any read. Exit 5 with a remediation that says "pipe the token … it is never a flag". The reviewer's requested exit 2 would contradict the module's documented "every allowlist/token refusal is exit 5" contract for no security gain. Left alone. |
| 56 | **fixed** | ok-list → `GATE_OK_OUTCOMES = {decided, already-decided, attach-acked}`. `already-decided` was the missing member. `run-not-attachable` (5) and `attach-not-acked` (6) stay `error` — the ask was "align with the exit codes", and both exit non-zero. **Correction (2026-08-29): the words "i.e. exactly the exit-0 set" were wrong** and are struck. `attach-acked` is in the ok-list and can still exit **6**, when `reportCompletion` cannot write the completion line (`finish(..., printed ? 0 : 6)`). That is not a discrepancy to fix — it is the contract, and it is now stated instead of implied: `GATE_OK_OUTCOMES` records **business** status (the steering message was acked; the decision was recorded), while the exit code additionally carries **reporting** status (did stdout survive). A run whose message was acked but whose completion line hit EAGAIN is a business success and a reporting failure, and the structured log must keep saying `status: "ok"` for it — downgrading it to `error` would make every dashboard count a lost stdout write as a failed steering message. The two are deliberately separate axes; only `decided`/`already-decided` happen to coincide with exit 0. |
| 57 (`--approver ""`) | **fixed** | `flags.get("--approver")?.trim()`; empty ⇒ same usage refusal as absent (exit 2 naming `--approver`) instead of falling through to an allowlist refusal with a blank subject. |
| 57 (`--dir ""`) | **partial / already exit 2** | Not an exit-code bug: `assertRecordsDirUsable` already refuses via `statSync("")` → ENOENT → exit 2. The *envelope* was the problem (`--dir  does not exist: ENOENT` — a path the operator cannot see). Added an explicit empty arm in `assertRecordsDirUsable`, which is the single guard **every** `--dir`-taking verb routes through. |
| 58 | **partial — the "persisted ~1 MB uncapped" premise is false** | `submitDecision` already runs `capText(req.reason, MAX_REASON_CHARS=1_000)` (`approval-gate.ts:506`), and `gate-verbs.test.ts:243` pins it. The `already-decided` echo is `JSON.stringify`'d, so control chars/ANSI are escaped, not interpreted. Real residuals fixed at the CLI: control-char stripping and lone-surrogate repair before the value ever reaches the record. **No double-truncation** — I import the gate's own `MAX_REASON_CHARS` rather than picking a second number, so at the bound `capText` finds nothing left to cut. One consequence to know: `sanitizeLabel` marks truncation with `…`, so a CLI-sourced over-long reason no longer carries `capText`'s `[truncated, N chars total]` count. |
| 59 (refusal arm state) | **fixed** | The auth-refusal `gateEvent` no longer hardcodes `state: "awaiting-approval"`. The real state is captured with the bound reportId in the same pre-auth read and logged through `sanitizeLabel(…, 64)`, defaulting to `"absent"` — the same word `submitDecision` returns for a run with no approval namespace. |
| 59 (`pause`, `record_write_ms`) | **deferred — not emittable from the CLI** | See "Belongs to another owner" below. |
| 60 | **fixed** | The `else` now reads `outcome.outcome` instead of hardcoding `"already-decided"`, so the printed line and `gateEvent` cannot disagree about a variant added later. (The union is closed today, so this is a durability fix, not a live bug.) |
| 61 (a) | **fixed** | attach's store is now `create: false` **unconditionally**. The old `create: dir === undefined` exempted the *default* records dir — the one the operator never named and this verb has least business chmod'ing 0700 / temp-sweeping / O_EXCL-probing. `assertRunExists` on the next line already requires the record to exist. |
| 61 (b) | **fixed** | attach stdout no longer spreads `AttachResult`. `requestId` (the record's **dispatch** id) is emitted as `dispatchRequestId`, and `messageId` goes through `sanitizeLabel(…,128)` like the error path. No consumer broke: `tests/fleet/attach.test.ts` asserts on the library return value, not CLI stdout. **Update (2026-08-29):** "no consumer broke" was true but left the emitted field itself unpinned — a rename back to `requestId` would have passed. The contract now HAS direct coverage: `tests/fleet/gate-verbs.test.ts:768`, "the run record's dispatch requestId is emitted as dispatchRequestId, never as requestId", asserting `printed.dispatchRequestId` on CLI stdout; `tests/fleet/approval-gate.test.ts:1525-1528` pins the same key on the gate event, and `:1694` pins its ABSENCE when no record was read. |
| 61 (c) | **partial — cannot drop it, cannot declare it** | Dropping `-` is not available: the story specifies it verbatim (AC5, `df3-4-…md:138`: "When `fleet attach <run-id> --message -` is issued") and the epic repeats it. Declaring it is not expressible either: `VerbFlag` is the closed `{name, required, valueType}` shape DF3.5's skill-contract test compares against, and `renderHelp` prints only those three. Documented the sentinel and the residual in the registry comment; surfacing it in `--help` needs `VerbFlag.note?: string` + a `renderHelp` line, which is a contract-shape change owned by DF3.5. |
| 61 (d) | **fixed** | Existence is still **read** before authentication (AC1(a2) needs the CAS seed from before the token read) but no longer **reported** before it: the throw is captured in `preAuthFailure` and rethrown only after `auth.ok`. Both properties held; cost is one variable. The writable-store construction (chmod 0700, temp sweep, O_EXCL probe) also moved after auth for the same reason. |
| registry: declared-but-unprobed exit codes | **verified true, probes left to the test wave** | Every declared code is genuinely reachable for all three verbs — 1 via `report`'s untyped-throw arm (e.g. a malformed record making `store.get` throw a plain `Error` past `assertRunExists`'s two typed arms), 0 for attach via `attach-acked`, 6 for approve/reject via `reportCompletion` refusing stdout. So **narrowing would be wrong**; the gap is probe coverage, which `verbs.test.ts:1221-1228` explicitly assigns elsewhere and my brief scopes to a separate wave. Listed here so that wave has the reachability arguments. |
| registry: `PROBES_OWED_ELSEWHERE` order-coupling | **fixed** | Now compared as `new Set(...)` vs `new Set(...)`. Order stays asserted where it is meant to be — the `inOrder([...])` subsequence check ten lines up. |

## BEHAVIOR CHANGES (for the test wave to re-pin)

**Exit codes**
1. `fleet attach <run>` on a **TTY** with no `--message` and nothing piped: was a 120 s hang then exit 2 `brief-stdin-timeout`; now immediate exit 2 `usage` — `no message on stdin`. Non-TTY (pipe, /dev/null, socket) is unchanged.
2. `fleet approve|reject <run> --approver ""`: **5 → 2**. Was an allowlist refusal (`approver-*`), now a usage refusal naming `--approver`.
3. `fleet <verb> --dir ""`: still **2**; only the envelope text changed (`--dir was given an empty value`).
4. `fleet approve|reject <bad-token> <nonexistent-run>`: **4 → 5**. Existence is now disclosed only after authentication, so an unauthenticated caller sees the token refusal, not `run-not-found`. With a *valid* token the code is still 4 (`gate-verbs.test.ts:121` passes unchanged).
5. `fleet attach` with a **default** (unnamed) records dir that does not exist: **4 → 2**. `create: false` means the store constructor refuses instead of `mkdir`-ing the dir and then reporting "no run record". Unreachable in practice — attach requires a dispatched run, which created the dir.

**Non-exit-code**
6. attach stdout key `requestId` → `dispatchRequestId`; `messageId` sanitized. Emitted only on the acked / not-acked paths (unchanged shape otherwise).
7. Structured log `status` for `outcome: "already-decided"`: `"error"` → `"ok"`.
8. Structured log `state` on the auth-refusal `gateEvent`: constant `"awaiting-approval"` → the run's real state (`"absent"` when there is no approval extension).
9. Error codes/messages when stdin refuses **under attach**: `brief-stdin-timeout` / `brief-too-large` → `message-stdin-timeout` / `message-too-large`, remediation names `--message`. The brief-eating verbs are byte-identical (`BRIEF_INTAKE` is the default parameter).
10. `--approver` is trimmed, so `--approver " alice "` now attributes to `alice`.
11. `--reason` is control-char-stripped and capped at the gate's own `MAX_REASON_CHARS` before `submitDecision`; over-long reasons end in `…` rather than `capText`'s `[truncated, N chars total]`.

## Belongs to a file I do NOT own — stated precisely

**`src/fleet/approval-gate.ts` (fix-gate).** It imports no logger (`node:crypto`, `node:fs`, `node:path`, `run-record.ts`, `reverify/approval.ts` — that is the whole list), and both remaining observability gaps can only be closed there:

- **`event: "pause"` is never emitted by anything.** `requestApproval` has zero call sites in `scripts/fleet.ts` (verified by grep) — the pause is fired by the reverify runner, so the CLI has no pause path to instrument and cannot fix this. `gateEvent`'s union declares `"pause"` and the story's observability contract (`df3-4-…md:253`) requires it; DF5.3 is specified to join approvals on `requestId` across **every** gate event, so a missing `pause` breaks that join. It must be emitted from `requestApproval`, carrying at minimum `{requestId, runId, event: "pause", state: "pausing"→"awaiting-approval", teardown_at_pause_ms}`.
- **Sub-timing `record_write_ms`** (same contract line, `:256`) appears nowhere in the repo. The CLI cannot synthesize it: `decision_wait_ms` already brackets the whole `submitDecision` call including the lock, the sweep and the write, and splitting the write out from the outside is not possible. It must be measured inside `submitDecision`/`requestApproval` around the `store.set`.
- Whatever logger is added there should reuse `src/swarmclaw/log.ts`'s `log()` and the guarded try/catch shape of `gateEvent` (a diagnostic is never the verb's outcome), and must never carry the token.

**`src/fleet/approvers.ts` (fix-approvers).** No change requested from me; noting only that my exit-2 empty-`--approver` guard now makes finding 24's "empty/whitespace approverId authenticates" unreachable *from the CLI*. It stays reachable for any other caller of `authenticateApprover`, so that fix is still worth making at the module.

## gitnexus impact

Ran before editing; index predates this branch's attach call site, so `readCappedStdin` shows one caller where there are now two — both in-file.

```
impact(run, upstream, scripts/fleet.ts)  → risk LOW, impactedCount 1, processes_affected 0, modules_affected 0
impact(readCappedStdin, upstream)        → risk LOW, impactedCount 3, direct 1 (ingestBriefJson),
                                           d2 run, d3 File:scripts/fleet.ts; modules: Scripts (direct)
```

No HIGH/CRITICAL. No exported signature changed: `run`'s is untouched, `listVerbs`/`renderHelp` got comment-only edits, and `readCappedStdin` is module-local with a **defaulted** new parameter.

## Verification — verbatim

Focal suites (one run, no re-run needed):

```
$ bun test tests/fleet/gate-verbs.test.ts tests/fleet/verbs.test.ts
bun test v1.4.0 (34cbb9a40)

 116 pass
 0 fail
 1473 expect() calls
Ran 116 tests across 2 files. [4.63s]
```

Biome:

```
$ bunx biome check --write scripts/fleet.ts src/fleet/verbs.ts tests/fleet/gate-verbs.test.ts tests/fleet/verbs.test.ts
Checked 4 files in 59ms. No fixes applied.
```

tsc (whole project):

```
$ bunx tsc --noEmit
tests/phase-engine/steering.test.ts(871,7): error TS2322: Type '(e: { runId: string; requestId?: string | undefined; detail: string; }) => number' is not assignable to type '(e: { runId: string; requestId?: string | undefined; detail: string; }) => void | Promise<void>'.
  Type 'number' is not assignable to type 'void | Promise<void>'.
tests/phase-engine/steering.test.ts(887,7): error TS2322: (same)
tests/phase-engine/steering.test.ts(901,7): error TS2322: (same)
```

All three are in `tests/phase-engine/steering.test.ts`, which I do not own — they are the in-flight F4 #40 work (`onInboxError` becoming awaitable, so its return type narrowed to `void | Promise<void>`). **Zero** errors in `scripts/fleet.ts` or `src/fleet/verbs.ts`.

Not committed, not pushed. Full suite not run.
