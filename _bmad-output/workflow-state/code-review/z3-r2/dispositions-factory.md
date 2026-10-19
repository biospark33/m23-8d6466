# Z3 R2: factory-side dispositions

Owner: leaf-F (factory).<br />
The fork leaf owns the fork halves of E-1/A-1/B-1 (`artifacts` and event `summary` in `state`) and E-2/A-6/B-2 (the `disarm <scheduleId>` verb). The factory halves are disposed below.<br />
TDD'd in `tests/z3/` (122 pass / 0 fail). The runbook is the new "Z3 round record" section of `docs/planning/v6-crossrepo-contract.md` (append-only, +124 lines; nothing else in the file was edited).

## Acceptance auditor

| ID | Disposition | Fix / rationale |
|---|---|---|
| A-1 | PATCH | `RunSchema`'s `artifacts`, `events`, `steps` and `factoryState`, and the top-level `schedules`, are now required, with no `.default`. A fork that drops one is a contract error. `tests/z3/fixtures/fork-state.json` mirrors the fork's `state()` projection field-for-field (fork `scripts/solstice/z3-exit-round.ts:94-133`, which now emits `artifacts` and `summary`). `wiring.test.ts` parses it and proves every dropped field fails. |
| A-2 | PATCH | Observe attribution also goes through the requestId of every factoryState entry, including `submitting` ones (`protocolRunIds()` → `recordsForRequestId`). While anything is unattributed and a sibling step is `submitting`, the leg re-samples after each `BOX_STABILITY_MS` (≤ `SUBMIT_SETTLE_POLLS`) before charging. New fixture switch `recordLag`: the next leg's box and key exist before its record or runId. Covered by a positive control and an AC6 negative control. |
| A-3 | PATCH | `Z3_UPSTREAM_BLOCKERS` (round-plan.ts) lists #467 (filed) and #465. The live test refuses FIRST, by name, before `liveGate`, the GO gate, arming, or any spend. `readHarvest` is the second line of defence and now names #467 and #465. `awaitResult(…, "terminal")` fails fast and by name (#465) when a run reads `pausing` past `PAUSING_BOUND_MS` (20 min). The 2-blocker list and its refusal are unit-tested. |
| A-4 | PATCH | The wrapper tests exec `scripts/z3/fleet-gate.sh` directly (no `/bin/bash` prefix), and the first test is "executable as a file". The index is still `100644` (`core.fileMode=false`), so the driver commits it with `git update-index --chmod=+x scripts/z3/fleet-gate.sh` as ruled. |
| A-5 | PATCH | The watcher kills only after the round's LAST host retain (`retainDone`). The hold keeps the window open, and the fork stays up for the QA tail's own state reads. The crash leg records `releasedAfterRetain: true` and AC4 requires it. The fixture's dispatch recall now sees only the docs retained before the release, and the priming leg records `citedLenses`. The positive control shows all three lenses cited. |
| A-6 | PATCH | The live test opens try/finally the moment `crashGate().arm()` returns. Until `runZ3Round` owns cleanup, the `finally` aborts the gate, runs `disarm <scheduleId>`, and cancels any `firedRunId`. `armZ3Schedule` disarms by the leniently-read scheduleId when the read-back fails its strict parse. `runCleanup` always disarms (`disarmSchedule`) and cancels every run the schedule fired, bound or not. |
| A-7 | PATCH | One operator runbook (the doc section above) covers: prerequisites with both blockers, image rebuild plus revision label, container **recreate**, the `/factory` read-write mount, `real-cli`, the agent-token mint, participants, the parking manifest, the full env list, the GO, running the test, and the post-round evidence commit with the v6-z3 manifest rows and `STAMPED_EVIDENCE_DIRS`. `preflightFork()` runs before the GO gate and checks the env override, the wrapper and real-cli exec bits inside the container, a read-write probe of `/factory/.sandbox/z3-gate`, and that `state` answers the contract. |
| A-8 | DISMISS (residual documented) | A bank-side "documents carrying this runId" listing needs a document-list read. `HindsightClient` exposes none (methods: listBanks/createBank/deleteBank/retain/recall/reflect/consolidate/mental models/listOperations/request; `src/hindsight/client.ts:185-631`), and `recall` is a semantic query, not an enumeration. Adding one would mean editing `src/` (fenced). The box half rests on the memgate issuance ledger, the only path a box has to bank-write scope (INV-MG), filtered to write verbs. Strengthened under B-6: host traces must now exactly cover the retained documents. |
| A-9 | PATCH | Recorded as a contract delta in the Z3 round record ("INV-Z3-6, bank ids"). The AC5 assertion comment points at it. |
| A-10 | PATCH | `HOLD_LIMIT_S` defaults to 240, below the fork's 300 s execFile timeout, so the wrapper's own `expired` (exit 99, not a replay exit) is the path a dead driver takes. Fixture-tested. |
| A-11 | PATCH | Both stale `scripts/z3-exit-round.ts` comments now name `scripts/solstice/z3-exit-round.ts`. |
| A-12 | PATCH | The submit brief is buffered byte-exact to a temp file (`cat > "$tmp"`) and handed to the real CLI on fd 3, so trailing newlines are kept. The test's fake CLI records stdin with `cat > file`, and a brief ending in `\n` is compared exactly. |
| A-13 | PATCH (documented) | Recorded in the Z3 round record ("AC4 double-booking surface"): the readonly ledger read by request id is a stronger witness than `fleet status`/`result`, whose payload carries only `spendMicroUsd`. |

## Blind hunter

| ID | Disposition | Fix / rationale |
|---|---|---|
| B-1 | PATCH | See A-1. |
| B-2 | PATCH | See A-6. |
| B-3 | PATCH | See A-2. |
| B-4 | PATCH | No held line within the window: the watcher aborts the gate and never kills. A failed kill: abort, with no release and no restart. `stopped()` is re-checked before the kill and before the release; a stop aborts. The wrapper honours `abort` before anything else, even with `release` present. Three new driver-path tests: no held line means `killed === 0`; a failed kill means no release and no restart; a stop between submitting and the kill means no kill and no release. |
| B-5 | PATCH | See A-5. |
| B-6 | PATCH | The driver and AC5 both require the host traces to cover exactly `documentIds` (an empty trace list is a problem whenever documents were retained). Negative control added. The bank-side half: see A-8. |
| B-7 | PATCH | The `state()` outage budget runs from the current failure streak's start (`firstFail ??= now`), not from the last success. |
| B-8 | PATCH | The gateway `fetch` carries `AbortSignal.timeout(min(60 s, deadline remaining))`. The HindsightClient calls have no timeout seam we can reach without editing `src/` (fenced). They are bounded by the bun test timeout, which exceeds round budget + cleanup budget + margin. |
| B-9 | PATCH | Every non-submit verb is `exec "$REAL" "$@"`, so argv, stdin and signals go straight to the real CLI. A submit is exec'd the same way after its journal line, so a fork SIGTERM reaches the real CLI. |
| B-10 | PATCH | See A-3. |
| B-11 | PATCH | Cleanup attributes through the requestIds: the bound run's factoryState, and the fork cancel's `inFlightRequestIds`, both mapped via `recordsForRequestId`. It re-sweeps after the final inventory. Per ruling 4, any fresh box still unattributed after cleanup is a cleanup problem AND fails AC7 (`unattributedFreshBoxes` non-empty). Two negative controls. |
| B-12 | PATCH | The wrapper resolves the requestId from `--request-id <id>`, then `--request-id=<id>`, then the brief's `"requestId"`. An armed code submit with none resolvable exits 99 (journaled `unparsed`) and is never held blind. Fixture-tested. |
| B-13 | PATCH | Only `submit` buffers stdin (byte-exact); every other verb is exec'd with the original stdin, so a never-closed tty no longer hangs the wrapper. See A-12. |
| B-14 | PATCH | `awaitTrigger` reads `state.schedules`: a `failed`/`completed`/`cancelled` schedule with no run fails at once, and so does a missing schedule. On more than one run, every one goes into the wiring's `ownRuns`, which `disarmSchedule` reports, so the cleanup cancels all of them. |
| B-15 | PATCH | AC7 requires every `kill-and-provision` runId to be in `cleanup.runIds`, with an exit-0 destroy receipt. Negative control added. |
| B-16 | PATCH | `tail()` scrubs, slices, then scrubs again. |
| B-17 | PATCH | `scrubText` replaces known secret values before the shape regexes. Regression test added. |
| B-18 | PATCH | `Z3_CODE_POLL_TIMEOUT_MS` is required, must be below `ROUND_BUDGET_MS`, is passed in the arm config, and is checked in the read-back (`armedCapsProblems`). |
| B-19 | PATCH | `gateFire` refuses a GO older than 24 h (`Z3_GO_MAX_AGE_MS`) or dated in the future. AC7 requires `go.when <= trigger.firedAt`. Both tested. |
| B-20 | PATCH | The vacuous `RUNS_DIR.startsWith("/")` test is deleted. |
| B-21 | PATCH | New fixture switches and behaviours: `recordLag` (box and key before the runId); a dispatch recall that sees only pre-release retains; a no-held-line gate; a stop between the submitting read and the kill; a failed kill. Each has a test (see B-4, A-2, A-5). |

## Edge-case hunter

| ID | Disposition | Fix / rationale |
|---|---|---|
| E-1 | PATCH | See A-1. Factory side: every field is required. |
| E-2 | PATCH | See A-6. All four listed cases now disarm: cap refusal and pre-round throws through the test's `finally`; a post-persist parse failure inside `armZ3Schedule`; `inventory`/`awaitTrigger` throws through `runCleanup`'s unconditional disarm. |
| E-3 | PATCH | In the wrapper, `abort` is tested FIRST for any z3 code submit, whatever `armed`/`release` say, giving exit 99 with no exec. `crashGate.abort()` no longer deletes `armed`; `arm()` clears `abort`. Fixture-tested: disarmed, released, and post-cleanup arrivals all exit 99. |
| E-4 | PATCH | See B-4. |
| E-5 | PATCH | See B-11. |
| E-6 | PATCH | See B-14. |
| E-7 | PATCH | `FORK_CANCEL_TIMEOUT_MS = 2 × 300 s + 180 s` (13 min), sized to the fork leaf's reported worst case (2 × FLEET_EXEC_TIMEOUT_MS + tsx boot ≈ 11 min, `scripts/solstice/z3-exit-round.ts` header). It is used for `cancel` and `disarm`. The live test's cleanup budget was raised to 40 min. A unit test pins ≥ 11 min. |
| E-8 | PATCH | Hold limit 240 s (A-10), and the real CLI is exec'd (B-9), so a fork SIGTERM reaches it and no orphaned provision double-execs. |
| E-9 | PATCH | See B-13. |
| E-10 | PATCH | See B-18. |
| E-11 | PATCH | The wiring header now says the fork's fleet child has no cwd (it runs in `/app`) and the allowlist strips `QDS_RUNS_DIR`, so real-cli must `cd` into the clone and use the same runs dir. The runbook adds the read-write `/factory` mount and that line. `preflightFork()` probes the mount read-write from inside the container (a nonce written there must read back host-side). |

## Found during R2 (not raised by the reviewers)

| ID | Disposition | Fix / rationale |
|---|---|---|
| F-1 | PATCH | The round's gateway assertion used `recall`, but no M2.1 agent grant class carries `recall` (`AGENT_GRANT_CLASSES`: host = {reflect, retain}, bot = {consolidate}; `checkGrantVerbs` refuses anything else, `src/memgate/schemas.ts:104-115, :301`). It could therefore never authenticate live. It now POSTs `/v1/default/banks/{bank}/reflect`, the host-class read-shaped verb. Recorded as a contract delta in the Z3 round record, and the runbook mints the token with `verbs: ["reflect"]`. |

## Fork R2 contract delta (folded in)

| Item | Change |
|---|---|
| `state` artifacts and summary | `RunSchema` requires `artifacts` and `events`; the `.default`s are gone. Extra artifact keys pass through: `id`, `stepId`, `title` and `createdAt`. The verdict is `JSON.parse(content).status`, as `driveBranchAndComplete` already parsed it. `tests/z3/fixtures/fork-state.json` mirrors the 9 run keys. |
| `cancel` | `inFlightRequestIds` is REQUIRED in `CancelSchema`. Cleanup maps every in-flight requestId through `recordsForRequestId` into the sweep and re-sweep, so its box is attributed and destroyed. |
| `disarm` | `disarmZ3Schedule` is disarm followed by a fresh `state` re-read. It returns `firedRunIds` = `firedRunId` plus every run carrying that scheduleId, which covers the fork's no-lock residual race. Both the round's `disarmSchedule` dep and the live test's pre-round `finally` cancel every one. |
| E-7 timeout | `FORK_CANCEL_TIMEOUT_MS` = 780 000 ms, at or above the fork's 660 000 ms floor plus tsx boot. `CLEANUP_BUDGET_MS` = 45 min. Test timeout = round 300 + cleanup 45 + 10 min margin. |
| `arm` protocolConfig | Never null. `ArmSchema` already requires a record. |
| E-10 `codePollTimeoutMs` | Derived in the composition: `codePollTimeoutFor(ROUND_BUDGET_MS, runs)` = round budget − QA legs × the fork's 1 h leg deadline (`Z3_QA_LEG_POLL_MS`). It covers z3-code-run and z3-code-observe, and refuses a budget that would leave the code run under 30 min. `ROUND_BUDGET_MS` was raised 200 → 300 min (3 h of QA + 2 h for the code run). The `Z3_CODE_POLL_TIMEOUT_MS` env is removed. The value is passed in the arm config and checked in the read-back. Tested. |
| A-11 | Every comment names `scripts/solstice/z3-exit-round.ts` (grep shows no stale path left). |
