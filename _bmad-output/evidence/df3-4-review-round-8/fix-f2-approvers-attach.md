# F2 — approvers.ts + attach.ts fix report (PR #150 round 7)

All 8 findings verified against source before editing. Impact ran upstream on
`attachToRun` (LOW; caller scripts/fleet.ts `run`), `localSteeringInbox` (LOW;
caller scripts/pipeline-run.ts `main`), `authenticateApprover` (LOW; internal),
`readCappedToken` (LOW; internal). `enrolApprover` / `acquireAllowlistLock` are
not in the index (file-scope private); their blast radius is the same two
script consumers. No spill outside src/fleet + scripts + tests/fleet.

## Item 13 [MED] — unparseable lock never reclaimable — FIXED
`src/fleet/approvers.ts` — `acquireAllowlistLock` stale arm. Previously only a
parseable, in-range, provably-dead pid qualified. Now, past
`ALLOWLIST_LOCK_STALE_MS`, an empty or unparseable pid field is also
reclaimable (mirrors approval-gate.ts's `holderPid === undefined ||
isLockHolderDead(holderPid)` door): the `if (Number.isInteger(pid) && pid > 0
&& isLockHolderDead(pid))` became `if (!Number.isInteger(pid) || pid <= 0)
staleRaw = raw; else if (isLockHolderDead(pid)) staleRaw = raw;`. A live
parseable holder still keeps its lock; age alone still reclaims nothing.
Pin: tests/fleet/approvers.test.ts "a STALE lock whose pid is EMPTY or GARBAGE
is reclaimable too" (3 raw shapes: `""`, `":orphaned-nonce"`, `"not-a-pid:nonce"`).

## Item 14 [MED] — stdin stream error escapes untyped — FIXED
`src/fleet/approvers.ts` — `readCappedToken`. `Promise.race([reader.read(),
stall])` is now wrapped; a rejected read returns a typed refusal
`approver-token-stdin-error` (stable code, message capped to 200 chars,
remediation: redirect from a file) instead of an untyped throw the CLI
classifies as transient/exit-1 "retry me". The `finally` still clears the
timer, and the outer `finally` still cancels the reader.
Pin: approvers.test.ts "a stream that ERRORS mid-read is a typed refusal".

## Item 15 [MED] — allowlist temp not fsynced — FIXED
`src/fleet/approvers.ts` — `enrolApprover` write block: `fsyncSync(fd)` added
after `writeFileSync`, before `closeSync`/`renameSync`. Atomic rename kept.
Import `fsyncSync` added. Comment states the invariant: the flushed temp, not
the rename, is the durability point; a zero-length allowlist is "authorize
nobody" and silently revokes every approver.

## Item 16 [LOW] — reclaim arm depends on readGuardedFile exposing `path` — FALSE-POSITIVE (pre-existing, not introduced by this PR)
`src/providers/allowlist-path.ts` (outside my file set) already returns
`{ ok: false, path, refusal }` — the failure arm CARRIES the resolved path
(allowlist-path.ts:39-41, `refuse()` sets `path` on every arm), and
`enrolApprover` reads `probe.path` before branching on `probe.ok`
(approvers.ts `const path = probe.path;`). The contract is structural
(`GuardedFileRead`), not incidental. No change made; nothing to fix in
approvers.ts.

## Item 17 [LOW] — `ceilingMs:0` + unreachable look claims "message IS queued" — FIXED
`src/fleet/attach.ts` — `attachToRun` tracks an `answered` flag (set on any
clean "absent"/"acked" verdict). If the loop ends with `reason === "no-ack"`
and the box never answered a single look, the reason becomes
`box-unreachable` — no new union member, no consumer change needed
(scripts/fleet.ts's `box-unreachable` arm already prints the truthful
"verify it still exists" remediation, READ ONLY). A mix of clean reads plus a
trailing unreachable streak keeps `no-ack`: the box demonstrably answered.
First attempt keyed on `unreachableTicks > 0` was reverted after it flipped a
clean 300 ms poll to `box-unreachable` — the `answered` rule is the honest one.
Pin: attach.test.ts "a ceiling of 0 with an UNREACHABLE first look reports
box-unreachable, not no-ack" (send-then-throwing driver for the negative,
healthy-box control arm for the positive).

## Item 18 [LOW] — short read zero-fills inbox tail — FIXED
`src/fleet/attach.ts` — `readInboxTail` loops `readSync` until
`INBOX_READ_CAP_BYTES` is filled or `readSync` returns ≤ 0 (EOF; the size above
says EOF should not happen, so ≤ 0 is belt-over-braces). `buf.toString("utf8",
0, read)` decodes only the bytes actually read. Previously a single short read
left the buffer's tail zeroed — corrupting the OLDEST lines in the window, the
inversion of the tail-read's stated goal.

## Item 19 [LOW] — zod error text echoed into refusals — FIXED
`src/fleet/approvers.ts` — new `firstIssuePath(error)` helper returns the first
zod issue's dotted path (or "(root)"), capped implicitly (paths are identifiers,
not values). Both refusal sites (`authenticateApprover` parse arm, `enrolApprover`
re-read arm) now print `is not a valid allowlist (first problem at <path>)` /
"unparseable JSON" instead of `(e as Error).message`, which could carry raw file
content (including an approver's salt/hash strings) back out through stderr.
Codes, remediations, and test pins unchanged — all approvers tests assert the
CODE only.

## Item 20 [LOW] — drain consumes foreign runs' lines — FIXED (host wiring FLAGGED)
`src/fleet/attach.ts` — `localSteeringInbox` takes optional `{ ownRunId }`.
`drain` parses each line's `runId` and skips lines addressed to a different run,
counting them; a drop is surfaced as one capped best-effort stderr note per
drain (`steering inbox: skipped N message(s) addressed to other runs`) — count
only, never line content. Without `ownRunId` the behavior is unchanged, so
every existing caller and test compiles and passes. **FLAG — one-line
production wiring left to the lead**: `scripts/pipeline-run.ts:1722`
`inbox: localSteeringInbox()` → `localSteeringInbox({ ownRunId: runId })`
(`runId` is in scope there). The parameter is optional precisely because that
file is F5's; without it the filter is dormant, never wrong.
Pin: attach.test.ts "a foreign run's inbox line is not drained as this run's
intent" (foreign line folded nowhere, own line still delivered).

## Verification
- `bun test tests/fleet/approvers.test.ts tests/fleet/attach.test.ts` — 115 pass, 0 fail
- Adjacent: `bun test tests/fleet/verbs.test.ts tests/fleet/cli.test.ts tests/phase-engine/steering.test.ts` — 340 pass, 0 fail
- `bunx biome check --write` on all four touched files — clean
- `bunx tsc --noEmit` — clean
- `detect_changes` (unstaged) — my changed symbols are all in src/fleet; the
  repo-wide "critical" rollup includes F1/F3/F4 files from the parallel wave,
  not mine.

## Intentional behavior changes
1. Approver allowlist refusals now say "(first problem at <field path>)"
   instead of echoing the full zod error text. Less detail, no content echo.
2. `readCappedToken` maps stream errors to refusal `approver-token-stdin-error`
   (previously an uncaught throw → exit 1).
3. Stale enrolment locks with empty/garbage pid are reclaimed after the stale
   window (previously eternal until manual removal).
4. `attachToRun` reports `box-unreachable` instead of `no-ack` when the box
   never answered any poll (the `ceilingMs: 0` destroyed-box case; live e2e
   T1.8/T5.1 still see honest `no-ack` — their boxes answer the reads).
5. `enrolApprover` fsyncs the allowlist temp before rename (crash-safety).

## Deferred
None beyond the item-20 wiring line flagged above (scripts/pipeline-run.ts is
F5's file).
