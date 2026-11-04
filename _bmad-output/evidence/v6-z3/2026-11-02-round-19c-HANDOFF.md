# Z3 live exit round 19 — handoff update (2026-11-02 ~20:50 UTC)

Status: **the round's last wall is operator billing.** Attempt 15 (this
session's seventh fire) ran the full QA arc plus the code run and died at
priming-recall's gateway reflect with OpenRouter **HTTP 402** — the account
behind BOTH hindsight's LLM key and `OPENROUTER_PROVISIONING_KEY` reads
`remaining: -$0.01` (`total 1564, used 1564.009…`, verified via
`openrouter.ai/api/v1/credits`). Nothing code-side can unblock this: every
model call — fleet legs and hindsight reflect/extraction alike — will 402
until credits are added. Top up, then re-fire per the original handoff
(2026-11-02-round-19b-HANDOFF.md — procedure unchanged).

## What this session proved and fixed (all pushed to dev by `16f4f640`)

Six fires ran (attempts 9-15; attempt 14 was killed deliberately — see
below). Each red was measured, root-caused live, fixed, and suite-verified:

| # | Fired | Red at | Cause | Fix |
|---|---|---|---|---|
| 9 | 14:38 | leg 2 provision | one transient ssh read in the wiring's unguarded `inventory` probe; the diagnosis was itself masked by `settleRun` assigning a getter-only `message` (bun SystemError) and throwing a TypeError in place of the regression | `971690f7` — one transport-only inventory retry (15 s) + settleRun readonly-message guard (own-property shadow, stderr line as backstop) |
| 10 | 15:07 | leg 1 closure | engine settled green, then `fleet teardown` died mid-flight (exit 6): took the run lock, destroyed nothing — box leaked, cleanup cancel refused on the stale lock | `9b1408d0` — `healMidFlightTeardown` (clear a DEAD-pid lock, one `--no-harvest` retry; a LIVE holder is never touched); hand-clean applied (box destroyed, record closed exit 0, revokeVerify clean) |
| 11 | 15:41 | QA submit | `fleet submit refused (exit 5) no-headroom/list-unverified — live 0/50` in under a second: one flaky ssh read in `checkHeadroom` (quota.ts), dispatch's first substrate probe; the fork never retries exit-5 | `32faf486` — one verified-list retry inside `checkHeadroom` (15 s, injectable; fail-close unchanged; reaper suite's embedded call passes the fast settle) |
| 12 | 16:23 | priming-recall | the mechanism proved end-to-end for the FIRST time (4 QA legs, retain ×4, recallable wait, crash-window kill/replay, directive present) but the code run's recall cited none of the round's 5 retained findings: the dispatch recall query is `` `${repoSlug} ${codeWorkId}` `` and a finding naming neither token ranks out of the kg_context window BY CONSTRUCTION | `cdf22cf3` — `correlation` rides the finding payload verbatim; the wiring composes the exact query string through `driveFindingsRetain`; `readStepWorkId` dep reads the code workId from the fork state; `waitFindingsRecallable` probes with THE ACTUAL dispatch query (the "z3 exit round" proxy proved indexing without proving the code run's own recall). Measured live: extraction keeps repository/run/commit tokens but DROPS the `w:`-workId (semantic rank); one tagged doc ranked #6 overall |
| 13 | 17:14 | leg 2 retain | one retain POST crossed the hindsight client's 30 s `RETAIN_TIMEOUT_MS` (inline extraction ran past it) | `8205e3dd` — one retry on `TimeoutError` in `driveFindingsRetain` (retain is an idempotent upsert — fixed documentIds, replace mode; forensics traces dedupe through a Set) |
| 14 | 17:41 | approval park (killed) | furthest ever: first-EVER green priming-recall (6 cited findings, all 3 lenses) — then the round polled for `awaiting-approval` for ~2 h while NOBODY performed it: `runZ3Round` never drives the completion chain. SC2.7 names the actor: `fleet observe` = pre-register → harvest/teardown → reverify → gate; a green verdict parks the run, and the chain's own teardown reaps the box | `16f4f64` — `driveApprovalPark` drives `parkForApproval` (`fleet observe <runId> --driver exedev --window-ms 600000`, 900 s host bound, one retry — the gate RESUMES a pausing window per AC1(c), so a retry cannot strand state). Killed cleanly: fork `cancel a20088f4` reaped box f6ff02 and closed the record |
| 15 | 20:12 | priming-recall gatewayAssert | OpenRouter 402 — account exhausted (`remaining -$0.01`) | OPERATOR: add credits, re-fire |

Note on the code-run payload: `Z3_CODE_MANIFEST_PATH=config/rosters/df53-demo.pipeline.json`
is the CONTRACT-mandated parking manifest (v6-crossrepo-contract.md §Round
inputs — "as SC2.7's did"), not a misconfiguration; attempt 14's box ran its
demo phases (`audit-demo-team` 19×21, `audit-demo-commit`) exactly as
designed and settled ok.

## Substrate state at stop (all verified 2026-11-02 20:5x UTC)

- 0 boxes on exe.dev; attempt 15's cleanup was fully green (problems [],
  no box leaks, no stale locks) — the first cleanup needing zero
  hand-cleaning.
- Fork protocol runs cancelled; ledger sweep = the 13 pre-existing SKIPs
  only; hindsight-qds healthy on 127.0.0.1:18890 (its OpenRouter account is
  the exhausted one); fork daemon lock renewing; memgate token fresh
  (sidecar expiry in `.unlazy/z3/token-expires-at`).
- Factory dev tip `16f4f640`, pushed; every commit suite-verified
  (tsc 0, biome repo-wide 0, tests/z3 169/169 — plus providers 1512/1512 at
  `32faf486`, tests/qa 21/21 at `cdf22cf3`).
- fire.env unchanged; `QDS_EXEDEV_SHA` evaluates at source to the tip at
  fire time; memgate token sidecar still fresh.

## Re-fire after the top-up (identical to the round-19b handoff)

1. Sweep: `ssh exe.dev ls --json` → `{"vms":[]}`; release-stale-groups dry
   run (13 SKIPs stay); no `.sandbox/runs/*.lock`, no `.sandbox/fleet.lock`;
   hindsight-qds healthy; fork daemon lock < 120 s; `mint-token.ts` →
   "already carries".
2. GO (0600, one per fire): reviewSet = `deriveReviewSet(git rev-parse
   HEAD)`, worstCaseUsd 5.25, fork rev `d8adbd2d5ef85f3d98119d1c2ab6e7d5925e426f`.
3. Invoke `qds-live-e2e` FIRST; `ssh exe.dev whoami`; fire in background
   unsandboxed: `source _bmad-output/evidence/v6-z3/fire.env && bun test
   tests/fleet/e2e/z3-exit-round.live.test.ts > /tmp/z3-live-fire19p.log 2>&1`.
4. On green: assert ≥1 `(pass)` (hollow-green check), then F4 closeout per
   the round-19b handoff. On red: sweep → classify on the evidence JSON →
   fix on dev → push → new GO → re-fire.

## Known-still-open watch items (unchanged unless noted)

- The credit wall also gates the QA legs' model calls — until topped up,
  ANY live attempt reds at or before the first in-box model call.
- `settleRun`'s append now survives frozen messages, but a fully-frozen
  error object still leaves the problems on stderr only (accepted).
- openrig caret floats / base-drift / 13 stale ledger admissions —
  unchanged from the round-19b handoff's debt list.
- Security-review harness errored on this session's pushes (same
  "model unreadable" failure, disclosed per plugin instruction);
  `/Users/steve/.claude/security/log.txt`. Every diff was suite-verified
  inline before push.

## Fire logs this session (classified, kept)

`/tmp/z3-live-fire19{i,j,k,l,m,o}.log` — attempts 9, 10, 11, 12, 13, 15
(attempt 14's `/tmp/z3-live-fire19n.log` is the killed round; its park
deadlock is the `16f4f64` commit's subject). Evidence JSONs live in
`_bmad-output/evidence/v6-z3/` per attempt with the round-manifest chain.
