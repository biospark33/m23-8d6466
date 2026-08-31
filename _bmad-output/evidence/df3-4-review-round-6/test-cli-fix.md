# Wave-2 T2 — tests/fleet/{cli,verbs,gate-verbs}.test.ts + scripts/fleet.ts remediation text

Files touched (all four owned, nothing else):
- `tests/fleet/cli.test.ts`
- `tests/fleet/verbs.test.ts`
- `tests/fleet/gate-verbs.test.ts`
- `scripts/fleet.ts` (Task B text only)

Not committed, not pushed.

## Verdict table

| # | Finding | Verdict | Where |
|---|---------|---------|-------|
| A | `cli.test.ts:3721` pinned the live-demo defect (`closedAt` undefined on a paused row) | **RE-PINNED** to the merge behaviour: `closedAt` is the real stamp, `boxAlive` is `false`. Verified against `src/fleet/status.ts:513-521` first. | cli.test.ts |
| A+ | the merge's OTHER half was unpinned — nothing asserted the `boxes === null` outage arm | **ADDED** `a list OUTAGE leaves the paused row's boxAlive ABSENT, not false` | cli.test.ts |
| B1 | `run-not-attachable` `else` arm told `closed`/`approved`/`rejected`/`timed-out` operators to run `fleet approve`/`fleet reject` | **FIXED** — three-way: `no-box` / `pausing`+`awaiting-approval` / everything-else ("this run is over…dispatch a new run") | scripts/fleet.ts:2698 |
| B2 | `attach-not-acked` always printed the `no-ack` remediation | **FIXED** — branches on `res.reason`, four texts. `send-failed` carries the bounded `detail`. | scripts/fleet.ts:2730 |
| B3 | attach `gateEvent` logged only `outcome`/`state` | **FIXED** — `reason` added, present only on the not-acked arm | scripts/fleet.ts:2686 |
| B4 | fold-budget: a third permanent cause of `attach-not-acked` | **NO new reason needed** — see "Design call" below. Handled inside the `no-ack` remediation text; **no change owed in a file I do not own.** | scripts/fleet.ts |
| C-H1 | injected `authenticate` ignored its arguments | **FIXED** — `authOk` records `[hostRoot, approverId]` and DERIVES the returned id from the argument; new test asserts `[[process.cwd(), "alice"]]` exactly once, plus a canonicalisation case proving the printed id comes from the RESULT not from argv | gate-verbs.test.ts |
| C-H2 | `attach`'s success path never exercised at the CLI layer | **FIXED** — `attach-acked` → exit 0 with the exact stdout object; a second case pins `dispatchRequestId` present and bare `requestId` ABSENT; a third pins acked-but-unprintable → 6 | gate-verbs.test.ts |
| C-H3 | probe loop skipped all three new verbs; exit 1 asserted for none, 6 for neither approve/reject, 0 not for attach | **FIXED** — `PROBES_OWED_ELSEWHERE` **deleted** (the set of probe-less verbs is now asserted EMPTY). Real probes added for all three (0/2/4/5 approve+reject, 2/4/5 attach). Residue (1 and 6 for approve/reject; 0/1/6 for attach) moved into `ONLY_REACHABLE_ELSEWHERE`, which BINDS each excuse to a named gate-verbs case that still asserts the code. Registry declarations left untouched — every one of the six is genuinely reachable, as the CLI fixer said. | verbs.test.ts + gate-verbs.test.ts |
| C-H4 | no exact flag-table snapshot for the three new verbs | **FIXED** — `EXPECTED_FLAGS` + `EXPECTED_EXIT_CODES` extended to approve/reject/attach; the exact-snapshot loop now covers all nine verbs | verbs.test.ts |
| C-M1 | both "no secret leaks" tests ran with no needle planted | **FIXED** — `NEEDLE = "s3cr3t-needle-9f3a"` rides back on the auth RESULT (the `...auth`-spread bug class); asserted absent from stdout+stderr+log entries, with a POSITIVE CONTROL proving the same scan finds it when it is echoed | gate-verbs.test.ts |
| C-M2 | AC7 status double's `get()` ignored its argument, one row only | **FIXED** — helper `get` is id-aware; new two-record case with distinct `reportId`/`expiresAt` asserts each row gets its own | cli.test.ts |
| C-M3 | "refused before any store is built" asserted nothing the dir guard doesn't also satisfy | **FIXED** — renamed and now asserts the envelope is the ID-GRAMMAR one (`contains "NOT A RUN ID"`, `not contains "--dir"`). Verified the current ordering in source first (writable-store construction is after auth; the read is before it). | gate-verbs.test.ts |
| C-M4 | argv-hygiene control matches literal substrings only | **NOT MINE** — that test is `tests/fleet/attach.test.ts:156`, not in my four files. See "Owed elsewhere". | — |
| C-L1 | `--reason` cap satisfied by a dropped/garbled reason; no exit code | **FIXED** — pins the exact `"x".repeat(999) + "…"` and `code === 0` | gate-verbs.test.ts |
| C-L2 | `PROBES_OWED_ELSEWHERE` order-coupling | **VERIFIED** the CLI fixer had already converted it to a `Set`; now moot — the constant is gone | verbs.test.ts |
| C-L3 | dead `expect(row.state).not.toBe("boxMissing")` | **REMOVED**; the genuinely uncovered variant (an UNRECOGNISED approval state) now has its own case asserting it falls through to `closed` | cli.test.ts |
| C-L4 | `--approver ""` and `attach` with no `--message` unexercised | **FIXED** — `--approver ""` and `--approver "   "` (two different layers, both exit 2 naming the flag, both leave the run undecided and never reach auth); `attach` with the flag absent entirely → exit 2 | gate-verbs.test.ts |
| W1-a | `already-decided` now logs `status:"ok"` | **PINNED** | gate-verbs.test.ts |
| W1-b | auth-refusal `gateEvent` logs the run's REAL state (default `"absent"`) | **PINNED** — three fixtures (`absent` / `pausing` / `awaiting-approval`); a constant passes at most one | gate-verbs.test.ts |
| W1-c | the decision `else` reads `outcome.outcome` | **PINNED** — the printed line and the log line must carry the SAME value, read once | gate-verbs.test.ts |
| W1-d | attach's store is `create: false` unconditionally | **PINNED** — `attach` with no `--dir` against a nonexistent `$QDS_RUNS_DIR` exits 2 and does NOT create it | gate-verbs.test.ts |
| W1-e | run existence read before auth, reported after | already covered by the existing exit-4/exit-5 pair; the new exit-1 case (a store whose SECOND read throws) pins the deferred-rethrow path explicitly | gate-verbs.test.ts |

## Design call on the fold budget (Task B item 3)

`src/phase-engine/steering.ts:520-531` leaves a message refused by `ATTACH_FOLD_CHAR_BUDGET`
deliberately un-acked, and **attach cannot distinguish it**: the ack channel carries no
signal for it, so on the wire it is byte-identical to "the resident has not solicited yet".
A fifth `AttachNotAckedReason` would therefore be a value `attachToRun` could never
produce — a lie in the type. It also cannot be inferred host-side without a new channel.

So: **no new reason, no change owed in `attach.ts` or `steering.ts`.** The `no-ack`
remediation now names the case, because it is the one arm where the default advice
("check the resident is running, then re-send") is actively harmful:

> the message IS queued in the box — check the resident agent is running before sending it
> again; a re-send delivers it twice. If the run's steering fold budget is exhausted, the
> engine leaves later messages un-acked ON PURPOSE and a re-send cannot help

The engine already reports the exhaustion through `onInboxError`, which is the right
channel for it — the operator sees it there, not in the attach exit path.

> **Reviewed again 2026-08-29 — design call UPHELD, cost recorded, follow-up named.**
>
> A later review asked for a durable negative acknowledgement: have the engine
> persist a refusal record when the fold budget is exhausted, and have
> `attachToRun` consume it and surface it in its result instead of returning an
> indistinguishable no-ack.
>
> **The complaint is legitimate and the reasoning above does not answer it.** The
> paragraph argues a fifth reason "would be a lie in the type" — true *given the
> current channel*, but that is the thing being questioned, not a reason to keep
> it. The real cost is concrete: an operator whose message was refused on purpose
> waits the full 30 s ceiling, is told `no-ack`, and is handed remediation prose
> that has to hedge across two opposite situations in one sentence.
>
> **Not done here, deliberately, because it is not a review-round change.** A
> durable negative ack means a new persisted state in the box, a writer in
> `steering.ts`, a reader in `readAck`, a fifth `AttachNotAckedReason`, a fifth
> CLI remediation arm, and a decision about that record's lifetime (it must not
> re-refuse a later, in-budget message). That is a story with its own AC, and
> shipping it inside a comment-response round would put a new transport state on
> the steering path with no spec to review it against.
>
> **Deferred as: "attach: durable fold-budget refusal receipt."** Until it is
> taken, the contract stands as written — `no-ack` is the answer, `onInboxError`
> is the channel, and the remediation text names the case explicitly so the
> advice is never silently harmful.

## Which new tests I verified can FAIL (mutate → confirm red → revert)

All source mutations were reverted and byte-verified against pre-mutation copies
(`diff` clean on `src/fleet/status.ts`, `src/fleet/verbs.ts`, `scripts/fleet.ts`).

| HIGH | Mutation applied | Result |
|---|---|---|
| C-H1 | `(deps?.authenticate ?? authenticateFromStdin)(process.cwd(), approverId)` → `(approverId, process.cwd())` | **7 red**, incl. `authenticate is called with (process.cwd(), the parsed --approver) — in that order`, `the id the CLI PRINTS is the one authentication returned`, `a secret riding back on the auth result…`. Before this task the same mutation left the file GREEN. |
| C-H2 | attach's `finish(…, printed ? 0 : 6)` → `finish(…, 6)` | **2 red**: `attach-acked is exit 0 and PRINTS the completion line`, `…dispatchRequestId, never as requestId` |
| C-H3a | `reject` registry `exitCodes` → `[0,1,2,4,5]` (drop 6) | **2 red**: `DF3.4's three additive entries`, `reject verb declares its exact flag table and exit codes` |
| C-H3b | renamed the gate-verbs case the attach exit-0 excuse points at | **red**: `attach exit 0: no test named "…" in gate-verbs.test.ts` |
| C-H3c | kept the title, deleted its `expect(code).toBe(0)` | **red**: `attach exit 0: "…" no longer asserts exit 0` — the excuse is bound to the ASSERTION, not just the title |
| C-H4 | added `{name: "--approver-token", required: false, valueType: "string"}` to `approve` in `src/fleet/verbs.ts` | **red**: `approve verb declares its exact flag table and exit codes`. This is the exact DF3.5-secret-on-argv hazard the finding names. |
| A | `status.ts` merge → `return { ...base, ...approval }` (the short-circuit) | **2 red**: `a paused run is awaiting-approval DESPITE its closedAt`, `a list OUTAGE leaves the paused row's boxAlive ABSENT` |
| A | `...(boxes === null ? {} : {boxAlive: false})` → `boxAlive: false` (hardcoded) | **1 red**: `a list OUTAGE leaves the paused row's boxAlive ABSENT, not false` |
| C-M2 | `approvalRowFields` caches the FIRST record's extension | **red**: `each paused row carries ITS OWN reportId and expiry, not the first row's` (among others) |
| C-L3 | `approvalRowFields` allow-list → deny-list (`state === "approved" \|\| "rejected" \|\| "timed-out"`) | **1 red**: `an UNRECOGNISED approval state is not treated as a pause` |

## Owed elsewhere (files I do not own — NOT edited)

1. **`tests/fleet/attach.test.ts:156`** — "the payload never appears in argv (AC6 negative
   control)". The finding is correct and stands: it does `expect(argv).not.toContain(token)`
   for a list of literals, so rewriting the append as
   `sh -c 'echo <base64> | base64 -d >> inbox'` leaves the payload fully visible in the
   box's `ps` while every literal check stays green. The structural assertion the reviewer
   proposes — *the exec whose argv names the inbox is exactly the one with
   `hadStdin === true`, and its argv length is bounded well below the message length* —
   belongs in that file. Whoever owns `attach.test.ts` should take it.
2. **`tests/fleet/approvers.test.ts:786-787`** — 2 pre-existing `tsc` errors
   (`'child.stdin' is possibly 'undefined'`). Another agent's file, mid-edit; not mine to
   touch. They are the ONLY remaining project-wide tsc errors.

## Verbatim output

### `bun test tests/fleet/cli.test.ts tests/fleet/verbs.test.ts tests/fleet/gate-verbs.test.ts`

```
bun test v1.4.0 (34cbb9a40)

 305 pass
 0 fail
 3049 expect() calls
Ran 305 tests across 3 files. [54.45s]
```

(Baseline before this task was `266 pass / 2 fail` — the expected `cli.test.ts:3721`
re-pin, plus one 20 s timeout in
`a fleet-busy race refusal creates NO loser cost ledger (INV-2…)`. That second one is a
lock-contention flake from the three suites running concurrently with other agents; it did
not recur in any of the four subsequent full runs and I changed nothing near it.)

### `bunx biome check --write tests/fleet/cli.test.ts tests/fleet/verbs.test.ts tests/fleet/gate-verbs.test.ts scripts/fleet.ts`

```
Checked 4 files in 209ms. No fixes applied.
```

### `bunx tsc --noEmit` (whole project)

```
tests/fleet/approvers.test.ts(786,7): error TS18048: 'child.stdin' is possibly 'undefined'.
tests/fleet/approvers.test.ts(787,13): error TS18048: 'child.stdin' is possibly 'undefined'.
```

Both are in a file I do not own and did not touch (another Wave-2 agent is mid-edit there).
Zero errors in my four files.
