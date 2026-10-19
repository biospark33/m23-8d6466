# Z3 R3 — Acceptance Auditor

Scope: story `z3-cross-repo-live-exit-round.md` (AC1–7, INV-Z3-1..6, Observability Contract, Files to Modify, fences) and `.unlazy/z3/PLAN.md`, checked against the CURRENT factory tree and the fork worktree `solstice-ai/.claude/worktrees/z3-sc`.<br />
Read-only audit: I edited no code.

**Gates I ran myself:**
- `bun test tests/z3/ tests/fleet/e2e/z3-exit-round.live.test.ts`: 123 pass, 1 todo (the live test), 0 fail.
- `bunx tsc --noEmit`: exit 0, 0 errors.
- `bunx @biomejs/biome check scripts/z3 tests/z3 tests/fleet/e2e/z3-exit-round.live.test.ts`: clean (14 files).
- `bun test tests/scripts/story-consistency.test.ts`: 8 pass.
- Fork: `protocol-z3-exit-round.test.ts` + `scripts/solstice/z3-exit-round.test.ts`: 33 pass, 0 fail.
- Fences: `git diff origin/dev --stat` over `src/ scripts/lib/ scripts/pipeline-run.ts oci/ live-harness.ts sc2-harness.ts scripts/swarmclaw-fork-pin.ts _bmad-output/evidence/` is empty. `src/fleet/verbs.ts`, `src/audit/link-store.ts` and `src/providers/exedev/driver.ts` are untouched.
- `gh issue view`: #467 and #465 both exist and are OPEN.

## R2 HIGH closure (source + tests)

| R2 | Closed? | Where |
|---|---|---|
| A-1 / B-1 / E-1 (artifacts absent from `state`) | **yes** | Fork `state()` emits `artifacts` `{id, kind, stepId, title, content, createdAt}` and event `summary` (`scripts/solstice/z3-exit-round.ts:117-131`). Factory `RunSchema` requires `steps`/`factoryState`/`events`/`artifacts` with no `.default` (`live-round-wiring.ts:123-126`), and `schedules` is required too. `wiring.test.ts` proves that every dropped field fails. Residual: A-6 below (the fixture is hand-mirrored). |
| A-2 / B-3 (observe attribution in the `submitting` window) | **yes** | `protocolRunIds` = named runIds ∪ `recordsForRequestId(requestId)` for every factoryState entry, `submitting` ones included (`leg-drivers.ts:322-326`). A bounded re-sample runs while a sibling is `submitting` (`:356-363`). Covered by the fixture `recordLag` positive control and two AC6 negative controls (`assertions.test.ts:562, :734`). |
| A-3 (blocker refusal after spend; issue TBD) | **yes** | `Z3_UPSTREAM_BLOCKERS` names #467 and #465 (`round-plan.ts:65-76`). The live test refuses on it first, before `liveGate`, the preflight, the GO and arming (`z3-exit-round.live.test.ts:99-100`). `awaitResult` fails by name after `PAUSING_BOUND_MS` (`live-round-wiring.ts:483-487`). `readHarvest` is the second line of defence. Both issues exist and are open. |
| A-4 (wrapper exec bit) | **NO, open at the index** | See A-1 below. The tests now exec the wrapper directly, but `git ls-files -s` still shows `100644`. |
| B-2 / E-2 (armed schedule left live on pre-round throws) | **yes, with a residual** | `try/finally` opens right after `crashGate().arm()` (`live.test.ts:123-199`), and the fork `disarm` verb exists (`z3-exit-round.ts:174-218`). `runCleanup` always disarms (`leg-drivers.ts:701`). Residual: A-3 below (an arm timeout leaves `armed` undefined; a throw inside the `finally` masks the error and skips cancels). |
| E-3 (abort ignored after cleanup) | **yes** | The wrapper checks `abort` first, before `armed` and `release` (`fleet-gate.sh:68-73`). `arm()` clears it. The test covers disarmed, released and post-cleanup arrivals. |
| E-4 / B-4 (watcher kills/releases after a stop or a failed kill) | **yes** | Before the kill, `armCrashWindow` re-checks `stopped()`, re-checks that the submit is held, and waits for `retainDone`. It re-checks `stopped()` after the kill. A failed kill aborts the gate with no release and no restart (`leg-drivers.ts:595-627`). There are three driver-path tests. |

## Negative controls run through production code

Confirmed. `tests/z3/assertions.test.ts` has 54 `AC<n> negative control:` tests. Every one calls the exported `assertAc1…assertAc7` / `assertZ3Round` from `scripts/z3/assertions.ts`. Each test runs on files written by the real `runZ3Round` drivers through the real `writeZ3Evidence` (via `driveFixtureRound`). The bad evidence comes from one of two sources:
- a misbehaving injected dep: the drivers record what really happened;
- a post-write `editLeg` / `dropLeg`: the evidence lies, and the sha256 registry or the content checks catch it.

No assertion is re-implemented in a test. AC2, AC3 and AC5 each have at least 3 controls, so the DoD security line is met at the fixture tier.

## Findings

### A-1 [HIGH] AC4 / "using only code merged" scripts/z3/fleet-gate.sh:1 (+ docs/planning/v6-crossrepo-contract.md:155)
**Gap:** R2 A-4 is still open where it matters. `git ls-files -s scripts/z3/fleet-gate.sh` shows `100644 e69de29…` (intent-to-add, `core.fileMode=false`). The worktree file is `-rwxr-xr-x`, so `fleet-gate.test.ts:52` ("executable as a file") passes locally and in CI it would still pass only if the checkout preserved a bit the index does not carry. The runbook states as fact that the file "is committed `100755`" (doc :155), which is not yet true. From merged code, every fork fleet verb would EACCES.<br />
**Fix (commit-time, one command):** `git update-index --chmod=+x scripts/z3/fleet-gate.sh` before the commit, then confirm that `git ls-files -s` shows `100755` and that `git show --stat HEAD` reports `mode 100755`. Optional: add a test that asserts the index mode, which closes the gap for good.

### A-2 [MED] AC1 / AC4 scripts/z3/leg-drivers.ts:605-608, :818 (+ scripts/z3/fleet-gate.sh:41)
**Gap:** The R2 fixes A-5 ("release only after the last retain") and A-10 ("hold limit 240 s < 300 s execFile timeout") combine into a timing budget that nothing checks:
- The fork starts the `z3-code-run` submit, and so the hold, as soon as `qa-observe-<last>` completes.
- The driver then still runs the last lens's whole tail before `retainDone = true`:
  - `driveBoxForensics`, which can add a 10 s re-read;
  - `awaitObserveStep` (10 s poll);
  - `observeDeltas`: an ssh inventory, the OpenRouter key list, and two `state` reads, each a `docker exec … npx tsx` cold boot;
  - `retainFindings`: `fleet result`, `listBanks`, then a Hindsight retain with fact extraction;
  - `gatewayAssert`: an LLM-backed `reflect`;
  - and a `boundRun` state read.
- A2's own retain files are 12 s to 2 m 40 s apart (`v6-a2/*-retain-*.json`).
- If the tail passes 240 s, the wrapper journals `expired` and exits 99, and the code step fails.

The round is then red after paying for every QA leg (about 3 h of wall clock). It fails closed, so nothing unsafe happens and nothing is double-spent, but it is a likely calibration miss on the one live fire this story exists for. The fixture models no wall clock, so no test sees it.<br />
**Fix (before the blockers clear; fine as a follow-up issue):**
- Put an epoch timestamp on each journal line.
- Have the watcher stand down (abort) with a named reason when the hold age is close to `HOLD_LIMIT_S`, instead of losing the race silently.
- Shorten the critical path: set `retainDone` right after the last `retainFindings` resolves, and move that lens's `gatewayAssert` after the release.
- Record `holdAgeAtKillMs` in the crash-window leg.

### A-3 [MED] INV-Z3-5 / AC7 tests/fleet/e2e/z3-exit-round.live.test.ts:124-137, :190-198 (+ scripts/z3/live-round-wiring.ts:156, :180)
**Gap (B-2 residual):**
1. `armZ3Schedule` passes `runAt = now + 120 s`, while `forkCli` has a default `timeout` of 120 s. A slow `npx tsx` boot can persist the row and then time out. `forkCli` throws, `armed` stays `undefined`, the `finally` disarms nothing, and the schedule fires unattended. This is the B-2 scenario through another door. The internal disarm in `armZ3Schedule` covers only a parse failure.
2. In the pre-round `finally`, the `disarmZ3Schedule(...)` / `cancelForkRun(id)` calls are unguarded. If either throws (a down container, a state drift), the remaining cancels are skipped. The `finally`'s exception also replaces the original error, so the operator sees the cleanup error instead of the cause.

**Fix:**
- On any arm throw, read `state` and disarm every `z3_exit_round` schedule whose row appeared after `roundStart`. Alternatively, arm with a `runAt` comfortably past the CLI timeout.
- Guard each disarm and cancel in the `finally`, and re-throw the original error with the cleanup problems attached (the `settleRun` posture).

### A-4 [LOW] runbook docs/planning/v6-crossrepo-contract.md:171-172
**Gap:** The token-mint snippet calls `memgateDeps()`, which throws unless `MEMGATE_ADMIN_KEY` and `QDS_MEMGATE_SIGNING_KEY` are exported (`src/memgate/gateway.ts:36-45`). The snippet also has to open the same ledger the round's `memoryKeys()` reads (`QDS_MEMGATE_LEDGER`, or the default). The snippet is otherwise accurate: `GrantAgentTokenInput` is `{consumerClass, banks, verbs, requestId, name?}`, the call returns `{token, tokenId}`, and host-class `reflect` is allowed (`schemas.ts:110`).<br />
**Fix:** Add one line naming the two required env vars and the ledger override.

### A-5 [LOW] scripts/z3/live-round-wiring.ts:9-16
**Gap:** The fork-CLI contract comment lists only `arm | state | cancel`. It omits the `disarm <scheduleId> → {disarmed, firedRunId}` verb, the `artifacts`/`summary` fields in `state`, and `inFlightRequestIds` in `cancel`. The code and schemas (`:126, :141, :143`) are correct; only the header is stale.<br />
**Fix:** Update the header to the four-verb contract.

### A-6 [LOW] AC1 tests/z3/fixtures/fork-state.json:2
**Gap:** R2 A-1's third fix item ("one shared fixture: the fork test writes the `state()` output, the factory test parses that same JSON") is only half done. The fixture is hand-mirrored. The fork test pins the run key set and the factory test pins the schema, so a drift needs a matching edit on both sides to slip through. That is acceptable, but no generated artifact crosses the repos.<br />
**Fix:** None required for this PR. Note it as known debt.

### A-7 [LOW] AC4 scripts/z3/fleet-gate.sh:69-70
**Gap:** An `abort` hit journals `phase: "expired"`, the same phase as a hold timeout. The journal cannot tell "cleanup aborted it" apart from "the driver died". This is only cosmetic for the verdict, because `submitExecs` and `heldAtKill` are what AC4 reads.<br />
**Fix:** Journal `aborted`, and add it to `GateLine.phase`.

### A-8 [LOW] runbook docs/planning/v6-crossrepo-contract.md:217-219
**Gap:** The "stood down after its kill" recovery step tells the operator to `docker start` the fork, but not to then `cancel` the protocol run. While the container was down, the round's cleanup `disarm`, `cancel` and `state` sweep all failed. The replayed code submit exits 99 thanks to `abort`, so nothing spends, but the run is left to fail on its own.<br />
**Fix:** Add "then `cancel <protocolRunId>` and re-read `state`" to step 3.

### A-9 [LOW] DoD story z3-cross-repo-live-exit-round.md:100-109
**Gap:** Every DoD box is unticked. Several are met in substance:
- Impl: tsc and biome clean;
- AC2/AC3/AC5 negative controls demonstrated at the fixture tier;
- the counterpart filed in the fork;
- `story-consistency` green.

The status line `review` is honest. It says the live round is not fired, names #467 and #465, and calls the evidence and manifest rows handoff.<br />
**Fix (optional):** Tick the fixture-tier items, and leave every live item unticked.

### A-10 [LOW] fork scripts/solstice/z3-exit-round.test.ts (package.json)
**Gap:** The fork CLI test is not in any `package.json` test script, so it runs only by hand. None of the 39 sibling `scripts/solstice/*.test.ts` files is wired either, so this follows house convention and is not a Z3 regression. Only `protocol-z3-exit-round.test.ts` is listed.<br />
**Fix:** None for this PR. If fork CI should guard the CLI contract the factory depends on, wire it in.

## Runbook ("Z3 round record") accuracy

- **Append-only:** verified. `git diff origin/dev -- docs/planning/v6-crossrepo-contract.md` shows one hunk, `@@ -112,3 +112,130 @@`, with 127 insertions, 0 deletions and no `-` lines.
- **Env names:** match the code. They are `SUBSTRATE_ENV`, `need(...)` in the live test, `QDS_KG_GATEWAY_URL`, `Z3_MEMGATE_AGENT_TOKEN`, the `Z3_FORK_*` overrides and `SWARMCLAW_FORK_REV`. Undocumented: `QDS_MEMGATE_LEDGER` and `QDS_RUNS_DIR` (left unset by design). See A-4.
- **Verbs:** `arm`/`state`/`cancel`/`disarm` match the fork CLI. The gateway `reflect` route `/v1/default/banks/{bank}/reflect` with body `{query}` matches `src/memgate/forward.ts:23, :124`.
- **Paths:** these exist:
  - `/factory/scripts/z3/fleet-gate.sh`
  - `.sandbox/z3-gate/{real-cli,armed,release,abort,journal.jsonl}`
  - `deploy/vps/fleet-wrapper.sh`, which resolves the checkout from its own location, so `/factory/deploy/vps/fleet-wrapper.sh` works as `real-cli`
  - `STAMPED_EVIDENCE_DIRS` in `scripts/swarmclaw-fork-pin.ts:42`

  The one false claim is "committed `100755`" (A-1).
- **Parking manifest:** `config/rosters/df53-demo.pipeline.json` exists, is `sc2-harness.ts` `MANIFEST_PATH`, and is cited by the 2026-09-30 sc2-7 chain. Accurate.
- **Token mint:** accurate except the missing admin/signing env (A-4).
- **Contract deltas:** INV-Z3-6 bank ids, the AC4 ledger surface, and reflect-not-recall are all recorded as findings rather than quiet edits, as the story requires.

## Honest-handoff state

- **Holds.** The live test refuses first, by name, while `Z3_UPSTREAM_BLOCKERS` is non-empty (`live.test.ts:99-100`). That happens before `liveGate`, `preflightFork`, `gateFire`, `listedKeyHashes`, the crash-gate arm and the schedule arm, so no spend and no fork mutation is possible.
- **In CI** the test is `todoIf(liveTodoOff())`.
- **Not in this change set** (correctly, as operator handoff): no `_bmad-output/evidence/v6-z3/` files, no `fork-rev-manifest.json` rows, no `STAMPED_EVIDENCE_DIRS` edit. The runbook's step 4 names all three as post-round work from round provenance (Z1 AC5).
- **Status:** `sprint-status.yaml:334` and the story both say `review`, with the live round explicitly not fired. Nothing overclaims.

## Scope vs Files to Modify and fences

| Extra file | Verdict |
|---|---|
| `scripts/z3/evidence.ts` | In scope. It is Z3's own evidence writer, needed because `live-harness.ts` (un-stamping) and `sc2-harness.ts` (owns the openrig-sc2 stamp) are fenced. It mirrors `sc2-harness` `writeEvidence`. |
| `scripts/z3/assertions.ts` | In scope. PLAN §factory names "pure assertion functions for AC2–AC7"; it is split out of `leg-drivers.ts`. |
| `scripts/z3/crash-gate.ts`, `scripts/z3/fleet-gate.sh` | In scope. They implement the story's crash-window leg (SC2.6 window (a)). The wrapper is an operator-installed test shim that `exec`s every verb through unchanged. It adds no verb to the 16-verb registry (`src/fleet/verbs.ts` is untouched) and changes no approval policy. It never ships in a production profile. |
| `scripts/z3/live-round-wiring.ts` | In scope. PLAN names it as the `scripts/qa/live-round-wiring.ts` mirror. |
| `tests/z3/**` | In scope (PLAN dispatch: leaf-F owns `tests/z3/**`). |
| fork `scripts/solstice/z3-exit-round.ts` | In scope as the story's counterpart "round harness". `arm`/`state`/`cancel`/`disarm` are fork operator commands, not fleet verbs. `cancel` uses only the existing `fleet cancel` verb. |
| fork `scheduler.ts` hook | In scope (PLAN: "scheduler fire hook"). It is a literal-id branch before a lazy import, and a fire-time refusal fails only that schedule. |

**No fence violation and no new fleet verb.** The factory diff touches `src/`, `scripts/lib/`, `oci/`, `scripts/pipeline-run.ts`, both harnesses and `swarmclaw-fork-pin.ts` zero times.

## Per-AC verdict

| AC / INV | Implemented | Negative control (prod path) | Live path sound | Verdict |
|---|---|---|---|---|
| AC1 arc green, each leg by its own driver | yes | yes (14 controls) | blocked upstream (#467/#465, refused pre-spend); A-2 timing risk | **PASS (code); live = handoff** |
| AC2 auto-approve fails | yes | yes | yes | PASS |
| AC3 exactly-one-box | yes | yes | yes | PASS |
| AC4 crash-window idempotency | yes | yes | A-1 exec bit (commit-time); A-2 hold budget | **PASS once A-1 is applied at commit**; A-2 MED |
| AC5 in-box retain fails | yes | yes (fixture) | ledger-backed box half (R2 A-8 dismissal stands) | PASS |
| AC6 observe read-only | yes | yes | yes (requestId attribution + settle) | PASS |
| AC7 live rules | yes | yes | A-3 residual on arm-timeout and finally-throw paths | PASS w/ MED |
| INV-Z3-1 approve scrypt/stdin/labeled | yes | yes | yes | PASS |
| INV-Z3-2 no auto-merge | yes | yes | yes | PASS |
| INV-Z3-3 no box write credential | yes | yes | yes (memgate ledger) | PASS |
| INV-Z3-4 fleet only code path | yes | n/a | yes | PASS |
| INV-Z3-5 unconditional cleanup | yes | yes | A-3 | PASS w/ MED |
| INV-Z3-6 scrub, trap ports, bank ids | yes | yes | delta recorded in the runbook | PASS |
| Runbook append-only + accurate | yes | n/a | A-1 claim, A-4, A-8 | PASS w/ fixes |
| Honest handoff | yes | n/a | refuses before any spend | PASS |
| Scope / fences / no new verbs | yes | n/a | n/a | PASS |

## PR-readiness verdict

**READY FOR PR, on one condition: apply A-1 in the commit** (`git update-index --chmod=+x scripts/z3/fleet-gate.sh`, then verify `100755` in the index).

Every R2 HIGH is closed in source and tests except A-4 (A-1 here), which is a commit-time action. tsc, biome, the Z3 suites (factory 123/0, fork 33/0) and story-consistency are all green.

A-2 and A-3 (MED) do not block this PR. The live round cannot fire while #467 and #465 are open, and the test refuses before any spend. Fix them, or file them as a follow-up, before the blocker list empties. A-4 through A-10 are LOW doc and hygiene items.
