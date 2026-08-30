# Fix report — cluster F (CLI) — PR #150 round 7

Branch `feature/df3-4-approval-gate-attach-steering`, PR head + parallel fixers' concurrent work.
Files owned: `scripts/fleet.ts`, `src/fleet/verbs.ts`, `src/fleet/status.ts`, `tests/fleet/gate-verbs.test.ts`, `tests/fleet/cli.test.ts`.

## Verdict table

| # | Sev | Verdict | Fix |
|---|-----|---------|-----|
| 11 | HIGH | FIXED | `--rotate` passed through to `enrolApprover` (`scripts/fleet.ts` enrol block, now passes `DEFAULT_APPROVERS_FILE` + `{ rotate: bools.has("--rotate") }`); `FleetDeps.enrol` seam widened to `(hostRoot, approverId, file?, opts?)`. New subprocess test in D9 drives enrol → duplicate refusal → `--rotate` success → old token rejected / new token accepted by the real verifier. `src/fleet/verbs.ts` needed no change — the registry already declared the flag, its note, and exit codes 5/6. |
| 5 | MEDIUM | FIXED | `approvalRowFields` (`src/fleet/status.ts:439`) now takes the verdict from `effective = expiredState(...)` (`effective === "timed-out"` arm) and derives only the countdown inline. |
| 6 | MEDIUM | FIXED | approve/reject probe is now `create: false` unconditionally (`scripts/fleet.ts:2518`); the writable store is built post-authentication for BOTH dir cases (`scripts/fleet.ts:2597`). Follows the attach block's locally-established pattern. |
| 8 (CLI) | MEDIUM | FIXED | CLI pre-check measures `sanitizeForMessage(message).length` against `ATTACH_MESSAGE_CHAR_CEILING` (imports swapped from `DIRECTIVE_TEXT_CHAR_CEILING`). Aligned to cluster C's shipped `attach.ts` (post-sanitize guard + new `message-over-ceiling` result arm); the CLI also handles that arm defensively (same exit-2 envelope) so an embedder skipping the pre-check can never get exit-0/`state:"attached"` for an unqueued message. |
| 26 | LOW | FIXED (dead code removed) | Verified against `scripts/lib/cli-args.ts:62-75`: `parseValueFlags` rejects empty values in both `--dir ""` and `--dir=` forms before dispatch, so `dir === ""` was unreachable. Branch removed; comment replaced with the reason no arm is needed. |
| 27 | LOW | FIXED | `gateEvent` gained a `printed` parameter; `status` is now `printed && GATE_OK_OUTCOMES.has(outcome) ? "ok" : "error"`. The approve/reject, unlock, and attach success arms emit the event AFTER `reportCompletion` answers (attach via an `attachEvent` closure; `run-not-attachable` still emits pre-return). Event schema unchanged — same fields, same names. |
| 34 | MEDIUM | FIXED | Needle scan now includes `readFileSync(store.path(RUN))`; positive-control comment corrected (store channel is covered explicitly, not "by construction"). |
| 35 | MEDIUM | FIXED | D9: enrol subprocess stderr is read and asserted `not.toContain(minted.token)`; all stdout lines before the completion line are asserted token-free; the approve child's stdout AND stderr are asserted `not.toContain(minted.token)`. |
| 36 | LOW | FIXED | D7 refusal path now reads stdout and asserts `out === ""` (matching the D5 sibling rule). |

False positives: 0. Deferred: 0.

## gitnexus impact (run before editing exported symbols)

- `FleetDeps` (widened `enrol` seam): `impact --direction upstream --repo QDS-Factory` → impactedCount 0, risk LOW (interface; all existing doubles pass fewer args, structurally compatible).
- `approvalRowFields`: impactedCount 4, risk LOW — upstream processes `run` (scripts/fleet.ts) and `statusAll` (src/fleet/status.ts); both covered by the suites below.

## Behavior changes (intentional)

1. **`fleet enrol --rotate` now works.** Previously parsed-then-dropped; re-running per the exit-5/exit-6 remediations looped into the same refusal. Now re-mints and invalidates the old token (this is the flag's documented purpose — verbs.ts note).
2. **`fleet status` boundary flip (#5):** an `awaiting-approval` record at exactly `now === expiresAt` now displays `awaiting-approval` (countdown 0) instead of `timed-out`, matching the gate's strict `>` rule. All other display outputs unchanged (timed-out rows still carry `expiresInMs: 0`; NaN `expiresAt` still shows `awaiting-approval` with no countdown).
3. **approve/reject with `--dir` omitted (#6):** the writable store construction (mkdir + chmod 0700 + temp sweep + O_EXCL probe) now runs POST-authentication instead of pre-authentication. Consequence: a missing DEFAULT records dir now refuses pre-auth with exit 2 (usage, via `asUsage` on the read-mode constructor's ENOENT) where it previously created the dir pre-auth and refused post-auth with exit 4. Named `--dir` behavior unchanged.
4. **attach over-ceiling refusal (#8):** messages whose POST-sanitize length exceeds 4000 chars are now refused exit 2 by the CLI (previously a raw-length ≤4000 escape-heavy message passed the CLI and was silently truncated at the fold). Envelope text now reads "--message is N chars once escaped, over the 4000-char ceiling"; exit code and envelope shape unchanged. Pure-ASCII messages measure identically to before.
5. **gate event `status` (#27):** `decided`/`already-decided`/`attach-acked`/`reclaimed`/`absent` events log `status: "error"` (not `"ok"`) when the completion line failed to print and the invocation exits 6. Event ordering vs `reportCompletion` changed on those arms (event now after); field schema unchanged.

## Verification

- `bun test tests/fleet/gate-verbs.test.ts tests/fleet/cli.test.ts` — **235 pass / 0 fail** (26.73s). First run had one 20s-timeout in `a fleet-busy race refusal creates NO loser cost ledger` (dispatch/fanout, unrelated to this cluster's edits — concurrent load from parallel fixers); it passes in isolation in 18.69ms and the full re-run is green.
  - New/updated tests confirmed passing: `fleet enrol --rotate re-mints a REAL enrolment, and the old token dies` (413ms), D9 real-token stream scans, needle scan incl. persisted record + positive control, D7 stdout assertion, approve/reject exit-6 gate-event `status: "error"` re-pin.
- `bunx tsc --noEmit` — **0 errors** (whole repo, including parallel fixers' files at HEAD of worktree).
- `bunx biome check scripts/fleet.ts src/fleet/verbs.ts src/fleet/status.ts tests/fleet/gate-verbs.test.ts tests/fleet/cli.test.ts` — **clean**.

## Notes for other clusters

- Cluster C's `message-over-ceiling` result arm (attach.ts) is consumed by the CLI; no C-side action needed.
- `tests/fleet/cli.test.ts` received no edits (all test-side findings lived in gate-verbs.test.ts); the one flaky timeout observed there is pre-existing and load-related, not from this cluster.
