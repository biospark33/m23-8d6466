# fix-f3-verbs-status — PR #150 round 7

Files edited: `src/fleet/status.ts`, `src/fleet/verbs.ts`, `src/phase-engine/steering.ts`, plus test updates in `tests/fleet/cli.test.ts` (tests pinning the old behavior — flagged below). GitNexus impact run on `approvalRowFields`, `rowForRecord`, `drainInbox`, `listVerbs` before each edit: all LOW risk, blast radius inside src/fleet + src/phase-engine + scripts/fleet.ts (read-only status consumer) — no HIGH/CRITICAL spill.

## Per-finding

### 21 — `pausing` renders `awaiting-approval` with no distinguishing field (DN2) — FIXED
`approvalRowFields` now returns `state: "pausing"` for a record the gate still holds in `pausing`, instead of relabelling it `awaiting-approval`. `StatusRow` gains `"pausing"` in the state union (additive — no consumer exhaustively switches on the union; `scripts/fleet.ts` keying is on `listUnavailable`/`skippedRecords` only) plus an optional `resumeHint` field, set ONLY on the `pausing` row, naming the one exit: re-run reverify (its `requestApproval` re-presents the bound reportId and promotes to `awaiting-approval`). No countdown on `pausing`, as before (`expiredState` never expires it).

NOT DONE HERE (out of my file list — needs the lead/F5 owner): DN2's remediation-alignment half lives in `scripts/fleet.ts` — approve's not-decidable arm still says "re-run once `fleet status` reports awaiting-approval" (a state `pausing` will now never report) and attach's paused arm still says "decide it with `fleet approve`/`fleet reject` instead" (a verb that refuses `pausing`). That text is in findings 36/37's territory (F5, scripts/fleet.ts). With item 21 landed, those two lines are now actively wrong and should be changed to name the reverify re-run (the `resumeHint` string is the aligned phrasing).

### 22 — live-box override hides paused strand (DN3) — FIXED (INTENTIONAL BEHAVIOR CHANGE)
`rowForRecord`'s approval override no longer guards on `box === undefined`. A paused run with a live, billing box now renders its approval state (`awaiting-approval`/`pausing` + `reportId`) with `boxAlive: true` and `vmName` still on the row, instead of rendering `live` and hiding the strand INV-APPROVE-6's no-teardown-seam refusal creates. Fail-safe direction per DN3: the strand is surfaced, the box facts stay visible. Settled approvals (approved/rejected/timed-out/unrecognized) still fall through to `closed`/`live` exactly as before; `boxAlive` keeps its `boxes === null` ⇒ ABSENT rule on the paused row.
FLAG: `tests/fleet/cli.test.ts` "a LIVE box outranks the pause" rewritten to pin the new behavior (`awaiting-approval` + `boxAlive: true`); renamed "a paused run with a LIVE box shows the pause WITH its live box".

### 23 — drain has per-call 5s deadline, no aggregate bound — FIXED
New exported constant `DRAIN_PASS_TIMEOUT_MS = SOLICIT_TIMEOUT_MS` (60s, derived from an existing constant per instruction): one drain pass's fold+ack loop takes a single `Date.now()` deadline at pass start and stops when it fires, reporting via `onInboxFault` how many of N queued messages went unprocessed. Previously ~400 queued messages × one stalled ack each = N × 5s serialized in front of every later solicitation; now bounded at 60s/pass. Deferral, not loss: the queue is re-read in full next solicitation and un-acked ids retry.

### 24 — two clock reads in `approvalRowFields` can disagree — FIXED
`rowForRecord` takes ONE `now = new Date()` per row and passes it into `approvalRowFields(rec, now)`; `expiredState`'s verdict and the `expiresInMs` countdown are now the same instant's facts. No more `awaiting-approval` with `expiresInMs: 0` from a deadline landing between two reads.

### 25 — `attach-acked` printed for a message no resident saw — FIXED (engine half; CLI half deferred, out of scope)
`SteeringController` gains an additive `acksBeforeCall` getter (deliberately NOT on `ResidentTelemetry` — the journal's resident block is a closed shape). A solicitation that acks ≥1 message and then exits before any prompt reached the resident (status gate, render failure, caller throw — the drain runs ahead of the gate by design) adds the count; a successful `caller.call` zeroes the pass. 0 ⇒ every ack this run wrote was followed by a resident call. `solicitSerialized`'s provenance comment now points at the count instead of only the prose.
DEFERRED half: `AttachResult` (src/fleet/attach.ts) and the attach completion line/gate event (scripts/fleet.ts) are F2/F5 files — consuming `acksBeforeCall` there (e.g. a `provenance` note on `attach-acked`) is a two-line change left to those owners.

### 26 — `listVerbs` docstring omits `enrol` — FIXED
Docstring now credits DF3.4 with "approve, reject, enrol and attach", noting `enrol` arrived via D9's allowlist work.

## Tests
- `tests/fleet/cli.test.ts`: 2 tests rewritten to pin the intentional DN2/DN3 behavior changes (flagged above); the stalled-`pausing` test updated to expect the new `pausing` state.
- Full green: `bun test tests/fleet/cli.test.ts tests/fleet/verbs.test.ts tests/phase-engine/steering.test.ts` → 340 tests, 0 fail. Also ran `tests/fleet/attach.test.ts` + `tests/fleet/gate-verbs.test.ts` (96 tests, 0 fail) to confirm the scripts-side `pausing` consumers are unaffected. One transient 5s-timeout pair in cli.test.ts harvest tests during a loaded concurrent run did not reproduce on re-run (0 fail, full suite, twice).
- `bunx biome check` clean on all four files; `bunx tsc --noEmit` clean.
- No new test added for item 23's aggregate deadline: `tests/phase-engine/steering.test.ts` is outside my edit scope; the existing hung-drain/hung-ack bound test (steering.test.ts:1272) still passes unchanged under it.

## Intentional behavior changes (summary)
1. `fleet status` renders `state: "pausing"` (new union member, with `resumeHint`) where it rendered `awaiting-approval`.
2. A paused run with a live box renders its approval state + `boxAlive: true` where it rendered `live`.

No git commits made.
