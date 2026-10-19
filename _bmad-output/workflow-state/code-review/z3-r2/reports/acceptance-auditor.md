# Z3 R2 — Acceptance Auditor

Scope: story `z3-cross-repo-live-exit-round.md` (AC1–7, INV-Z3-1..6, Observability Contract, Technical Notes, Infra Prerequisites) and `.unlazy/z3/PLAN.md`. I checked them against the CURRENT factory tree (`scripts/z3/*`, `tests/z3/*`, `tests/fleet/e2e/z3-exit-round.live.test.ts`) and the fork worktree `solstice-ai/.claude/worktrees/z3-sc` (`protocol-z3-exit-round.ts`, `scripts/solstice/z3-exit-round.ts`, the `scheduler.ts` hook).<br />
This audit is read-only. I edited no code. I ran `bun test tests/z3/`: 102 pass, 0 fail.

**What holds:**
- `Z3_MAX_FLEET_RUNS = MAX_QA_LEGS + 1` is derived on both sides, never restated.
- `live-harness.ts` and `sc2-harness.ts` are unmodified.
- No auto-approve or auto-merge path exists. AC2 re-derives the no-merge verdict from `eventTypes` and the scrypt verdict from the CLI's own `decided` line. `decisionSource` must be `fleet-approve-stdin`, so ADR-2 cannot act as a license.
- `scripted: true`, `executedBy: "driver"` and `tokenChannel: "stdin"` are recorded.
- The `finally` cancels the fork protocol run first, then sweeps, destroys, revoke-verifies (`ok !== true` fails) and inventories, on every path through `runZ3Round`.
- All 48 `AC<n> negative control:` tests run the production `assert*` functions over files written by the real `runZ3Round` drivers.
- Story status stays `gated` in `sprint-status.yaml:334`. Nothing overclaims.

**R1 HIGH spot-check (source + tests):**

| R1 | Closed? | Note |
|---|---|---|
| A-1 | partial | Fork CLI committed (`arm`/`state`/`cancel`) and silent swallow gone. The new contract drops `artifacts` (A-1 below); harvest still blocked (A-3). |
| A-2 / B-2 | yes | Arm happens only after `gateFire`. `armedCapsProblems` checks the read-back. `driveTrigger` re-sums the fired caps, and AC7 re-checks from disk. |
| A-3 / E-3 / E-18 | **partial** | Attribution works only once `factoryState[*].runId` is set. During the next leg's `submitting` window it is not (A-2 below). |
| B-1 / E-5 | yes | `runCleanup` aborts the gate, cancels the bound protocol run, then sweeps a fresh `state` (`leg-drivers.ts:628-634`). |
| B-3 / E-6 / A-4 | yes (mechanism) | Hold-wrapper plus a watcher from round start. The wrapper's exec bit is missing (A-4 below). |
| B-4 / E-16 | yes | `recordAtKill` is an explicit witness. Driver-path negative control exists. |
| E-1 / A-7 | yes, except artifacts | zod schema with epoch-ms `createdAt`; bind is by `scheduleId`. |
| E-4 | yes | `writeCredentialsFor` filters on non-`recall` verbs. An unparseable scope counts as write (fail-closed). |
| E-7 | yes | `awaitStepSubmitted` records `lastError` and fails only on `failed`/`cancelled`. |
| E-2 / B-16 | DEFER-UPSTREAM | Evaluated in A-3 below. |

---

### A-1 [HIGH] AC1 / F-011 scripts/z3/live-round-wiring.ts:120 (+ fork scripts/solstice/z3-exit-round.ts:83-104)
**Gap:** The fork CLI's `state` never emits `artifacts`. Its run projection is `{id, templateId, scheduleId, createdAt, status, steps, factoryState, events}`, although `ProtocolRun.artifacts` exists (`src/types/protocol.ts:457`). The factory schema declares `artifacts: z.array(...).default([])`, so the absence parses as an empty list instead of failing loudly, which breaks the R1 E-1 promise ("a shape drift fails loudly"). `awaitProtocolComplete` then returns `artifacts: []`, and `driveBranchAndComplete` finds no `factory_result`. Every live round goes red at `branch-and-complete` with "no factory_result for … (F-011)" and "code run verdict null, not approved", even when the system is correct.<br />
**Evidence:** `tests/z3/wiring.test.ts` parses a hand-written `run` object, not the fork CLI's output. The fixture (`tests/z3/fixture.ts:180`) supplies artifacts directly, so no test crosses the two repos' real shapes. Fork events also lose `summary`.<br />
**Fix:**
- Emit `artifacts: (r.artifacts ?? []).map(({kind, content}) => ({kind, content}))` and event `summary` in fork `state()`.
- Make `artifacts` and `events` required in `RunSchema` (no `.default`).
- Pin the shape with one shared fixture: the fork test writes the `state()` output for a seeded run, and the factory test parses that same JSON.

### A-2 [HIGH] AC6 (and so AC1) scripts/z3/leg-drivers.ts:316-328 (+ live-round-wiring.ts:349-352)
**Gap:** R1 A-3's attribution only excludes resources of runIds found in `factoryState[*].runId`. The fork persists that runId only on the submit **ack**. The next leg's box and provider key are created inside the submit, before the ack. SC2.6 measured the box up at +4 s with the ack still pending at 60 s (`protocol-factory-exec.ts:13`).
- The fork starts `qa-leg-<n+1>`'s submit the moment `qa-observe-<n>` completes.
- The driver's observe snapshot lands seconds later, almost always inside that window.
- The box and key are then unattributable, and the leg fails "observe provisioned box(es)" / "observe minted a provider key".

**Evidence:** The fixture hides this. `provision()` writes the record and box together, and `protocolFleetRunIds` returns `records.keys()` (`tests/z3/fixture.ts:135-142`), so a runId is known the instant its box exists. Live, `protocolFleetRunIds` reads only `factoryState` runIds, which are null while the entry is `submitting`.<br />
**Fix:**
- Attribute by the `requestId` of every `factoryState` entry, including `submitting` ones, through `recordsForRequestId`. The submit intent file `submits/<requestId>.json` names its run before dispatch (`src/fleet/submit.ts:194-225`).
- When a fresh resource is still unattributable while a sibling step is `submitting`, re-sample once after that step acks before charging it.
- Add a fixture case where the next leg's box and key exist while its `factoryState.runId` is still null.

### A-3 [HIGH] E-2 / B-16 deferral, AC1 / AC7 tests/fleet/e2e/z3-exit-round.live.test.ts:40-48, :141-145 (+ leg-drivers.ts:729)
**The deferral is honest in substance:**
- I confirmed that no merged code persists a QA leg's findings JSON.
- A2's own live retain ran through `.unlazy/a2/post-legs.ts` (the `origin` field of `v6-a2/*-retain-*.json`). That file is now gone from disk.
- Z3 cannot fix this inside its fences (`src/**` and `scripts/pipeline-run.ts` are fenced).
- The story stays `gated`.

**It is surfaced at the wrong place, after spend, and the issue it cites does not exist:**
1. **#465 fails first, and silently.** Every hunter-pack leg is findings-only, and #465 says such legs strand in `pausing` with `terminal:false` forever. `runZ3Round` calls `d.awaitResult(prov.runId, "terminal")` (`leg-drivers.ts:729`) before it ever reaches `driveFindingsRetain`. The live round therefore polls QA leg 1 until the 200-minute round deadline and fails with a generic "run … reaching terminal did not happen before the round deadline". The named `readHarvest` refusal never runs. The fork's own `qa-observe-<lens>` also never completes, so the code run never submits.
2. **The refusal comes after the money.** `readHarvest` throws inside the round, after `gateFire`, `armZ3Schedule` and the fire. An operator who follows the file pays for at least one QA leg and up to 200 minutes of wall clock for a round that is guaranteed to go red.
3. **"issue TBD".** `gh issue list --search harvest` finds no harvest-persistence issue. The header, the thrown message and the triage all cite an issue that has not been filed.

**Fix:**
- File the harvest-persistence issue and replace "TBD" with its number everywhere.
- Add a pre-fire refusal before `gateFire` and arming: while either blocker is open, the test throws naming #465 and the new issue, unless an explicit `Z3_PARTIAL_CALIBRATION_FIRE=1` opts into a knowingly-red fire, and that opt-in is recorded in the trigger leg.
- In `awaitResult`, fail fast on `status === "pausing"` for a findings-only leg, naming #465, instead of waiting out the deadline.

### A-4 [HIGH] "using only code merged" / AC4 scripts/z3/fleet-gate.sh (git mode)
**Gap:** The wrapper will be committed non-executable:
- The repo has `core.fileMode=false`.
- The index entry is an intent-to-add `100644` (`git ls-files -s` shows `100644 e69de29…`).
- `z3-factory.diff:743` records `new file mode 100644`.

The fork runs `SWARMCLAW_FACTORY_FLEET_CLI` via `execFile(cli, …, {shell:false})` (`protocol-factory-exec.ts:68`). A non-executable file gives EACCES and exit -1 on **every** fleet verb, not just the held submit, so a fork configured per `crash-gate.ts` OPERATOR SETUP cannot submit, poll or cancel anything. The local worktree copy happens to be `-rwxr-xr-x`, so this only bites from merged code.<br />
**Evidence:** `tests/z3/fleet-gate.test.ts:33` runs the wrapper as `["/bin/bash", WRAPPER, …]`, which masks the missing exec bit. `deploy/vps/fleet-wrapper.sh`, the same kind of shim, is correctly `100755`.<br />
**Fix:**
- Run `git update-index --chmod=+x scripts/z3/fleet-gate.sh` before commit.
- Make the gate test exec the wrapper directly (`Bun.spawn([WRAPPER, …])`) and add a check that `git ls-files -s scripts/z3/fleet-gate.sh` reports `100755`.

### A-5 [MED] AC1 (priming round-trip) / DoD scripts/z3/leg-drivers.ts:556 (+ :721, :725-735)
**Gap:** The crash watcher releases the held code submit right after the kill (`kill → release → restart`), whatever the QA tail is doing. The fork submits `z3-code-run` the moment the **last** `qa-observe` completes, which is when the driver is still in that lens's observe, retain and gateway assert. The replayed submit dispatches and its recall runs, possibly before the last lens's findings are retained, and before Hindsight has indexed them. A2's own fire produced `documents=0` for one lens (`v6-a2/…-qa-correctness-retain-…json`), so a round whose findings all come from the last lens fails priming on timing alone. The gate already holds the submit, so ordering it costs nothing.<br />
**Fix:** Make the watcher kill on the held submit but **release** only after the round loop signals that the final `driveFindingsRetain` resolved, and optionally after one `gatewayAssert`-style recall returns a retained documentId. Record `releasedAfterRetain: true` in the crash-window leg and assert it.

### A-6 [MED] AC7 / INV-Z3-5 tests/fleet/e2e/z3-exit-round.live.test.ts:94-113
**Gap:** Three things happen before `runZ3Round`'s `finally` exists: `crashGate().arm()`, `armZ3Schedule(...)`, and the cap read-back refusal. If the read-back refuses (`:108-113`), or anything throws between arm and `runZ3Round`, the test leaves:
- a persisted one-shot schedule that fires in 120 s and spends unobserved;
- an armed gate;
- no revoke-verify and no cleanup record.

The message tells the operator to "remove that schedule fork-side", but the fork CLI has no verb to do that (`arm | state | cancel` only, and `cancel` takes a protocolRunId).<br />
**Fix:** Add `disarm <scheduleId>` to the fork CLI (it deletes or pauses the schedule and refuses non-z3 ids). Wrap everything from `crashGate().arm()` to `runZ3Round` in `try/finally`: `crashGate().abort()`, plus `disarm` when no protocol run was bound.

### A-7 [MED] Infra Prerequisites / "operator setup documented?" tests/fleet/e2e/z3-exit-round.live.test.ts:1-48, scripts/z3/crash-gate.ts:8-12
**Gap:** The setup is scattered across two headers, and several steps are not written down at all:
- how to mint `Z3_MEMGATE_AGENT_TOKEN`: which bank (the resolved org-slug family, not `qds-*`; see A-9) and which verbs;
- what `Z3_PARTICIPANTS` must name (existing fork agent ids);
- which `Z3_CODE_MANIFEST_PATH` actually parks at the approval gate (the SC2.7 manifest?);
- that the fork image must be rebuilt from the merged counterpart rev, because `scripts/solstice/z3-exit-round.ts` ships only inside the image (`Dockerfile:222`) and `SWARMCLAW_FORK_REV`/GO must name that rev;
- that `real-cli` must hold the existing shim (`deploy/vps/fleet-wrapper.sh` on the VPS profile), and that the compose `environment:` change needs a container **recreate**, not just a restart;
- the `/factory` read-write mount of this same clone.

The round needs about 17 env names plus the GO file, and no single list exists.<br />
**Fleet-gate mount realism:** the mechanism holds up.
- The fork always `stdin.end(input)`s, so `cat` never blocks.
- The brief is compact `JSON.stringify` with `workId` ahead of `instructions`, so the grep matches.
- `node:26-slim` ships bash.
- `PATH` survives the SC2.5 allowlist.
- File-based config gets past the env strip.

What remains is A-4 (exec bit), the recreate step, and A-10.<br />
**Fix:**
- Add one operator checklist: a section of the live-test header or the Z3 record in `docs/planning/v6-crossrepo-contract.md`.
- Add a preflight, run before `gateFire`, that checks:
  - `docker inspect` shows the container env `SWARMCLAW_FACTORY_FLEET_CLI` equal to the wrapper path;
  - `docker exec <c> test -x /factory/scripts/z3/fleet-gate.sh` and `test -x "$(cat real-cli)"` both pass;
  - the fork CLI `state` answers;
  - the gateway accepts the agent token.

### A-8 [MED] AC5 / INV-Z3-3 scripts/z3/live-round-wiring.ts:459
**Gap (R1 A-5 residual):** Live `retainTraces` is the host client's own journal, so it can only ever say `side: "host"`. It shows what this process retained, but nothing about whether a box retained. The AC5 negative control still exists only at the fixture tier. The box half rests on the memgate issuance ledger, which is sound per INV-MG, but no bank-side observation backs it.<br />
**Fix:** After each retain, list the bank's documents carrying this run's `runId`/`requestId` metadata through the host client, and require that set to be a subset of the host journal. A document the host did not write is a `side: "box"` trace. This needs no new in-box verb.

### A-9 [MED] INV-Z3-6 scripts/z3/assertions.ts:379
**Gap:** INV-Z3-6 requires "explicit `qds-` bank ids every call". R1 E-4 relaxed the check to `BankIdSchema`, because dispatch recall reads the org-slug family (seam gap #11). The relaxation is justified, but it appears only in a code comment and the triage. The story says "any contract deltas observed during the round enter as findings, never as quiet edits".<br />
**Fix:** Record the INV-Z3-6 delta and the seam-gap-#11 reference in the Z3 record of `docs/planning/v6-crossrepo-contract.md`, or in the story's notes, and point the assertion comment at it.

### A-10 [LOW] AC4 scripts/z3/fleet-gate.sh:31
**Gap:** `HOLD_LIMIT_S` defaults to 900 s, but the fork's `FLEET_EXEC_TIMEOUT_MS` is 300 s. A hold longer than 5 minutes is killed by `execFile`'s timeout, not by the wrapper, so the `expired` line is never journaled and the fork replays the same requestId into a fresh `held`. The header's "driver died before releasing" fallback can therefore never fire as described.<br />
**Fix:** Default the hold limit below 300 s, or `trap` TERM to journal `expired`, and document the interaction.

### A-11 [LOW] scripts/z3/live-round-wiring.ts:67, scripts/z3/leg-drivers.ts:11
**Gap:** Two stale comments name the fork CLI as `scripts/z3-exit-round.ts`; the real path is `scripts/solstice/z3-exit-round.ts`. The R1 triage rationale for A-1 repeats the stale path.<br />
**Fix:** Correct both comments.

### A-12 [LOW] scripts/z3/fleet-gate.sh:42
**Gap:** `brief="$(cat)"` strips trailing newlines, so the header's "byte for byte" claim is false. This is harmless for a JSON brief.<br />
**Fix:** Say "the brief minus trailing newlines", or buffer the brief to a temp file.

### A-13 [LOW] AC4 scripts/z3/live-round-wiring.ts:409-416
**Gap:** AC4 says double-booking is "readable via Z1's status/result surface". The wiring reads `gate_admissions` and `budget_group_admissions` straight from the sqlite ledger. That is a stronger witness, but it is not the named surface.<br />
**Fix:** Note the deviation in the round record, or also record what `fleet status`/`result` reports for spend.

---

## Will the live round run from merged code alone?

No. In the order a fire would hit them:
1. A-4: the gate wrapper is not executable.
2. A-3: #465 strands QA leg 1 in `pausing`.
3. Harvest persistence is unfiled and unmerged.
4. A-2: the observe attribution hole.
5. A-5: the priming race.
6. A-1: `artifacts` are absent from `state`.

Items 2 and 3 are legitimate upstream blockers; Z3 cannot close them within its fences. Items 1, 4, 5 and 6 are Z3's own and fixable in this story.

## Per-AC verdict

| AC / INV | Implemented | Negative control real (prod assertion path) | Live path sound | Verdict |
|---|---|---|---|---|
| AC1 arc green, each leg by its own driver | yes | yes (fixture) | no: A-1 artifacts absent, A-3 blockers + late refusal, A-5 priming race | **FAIL (gap)** |
| AC2 auto-approve fails | yes | yes | yes once A-1 is fixed (branch leg) | PASS |
| AC3 exactly-one-box | yes | yes | yes | PASS |
| AC4 crash-window idempotency | yes | yes | A-4 exec bit; A-10 | **PARTIAL** |
| AC5 in-box retain fails | yes | fixture only | A-8 box side unobserved; A-9 bank delta unrecorded | PARTIAL |
| AC6 observe read-only | yes | yes | A-2 submitting-window false red | **FAIL (gap)** |
| AC7 live rules | yes | yes | A-3 spend before refusal; A-6 pre-round paths uncleaned | **PARTIAL** |
| INV-Z3-1 approve scrypt/stdin/labeled | yes | yes | yes | PASS |
| INV-Z3-2 no auto-merge | yes | yes | yes | PASS |
| INV-Z3-3 no box write credential | yes (ledger) | fixture only | A-8 | PARTIAL |
| INV-Z3-4 fleet only code path | yes | n/a | yes | PASS |
| INV-Z3-5 unconditional cleanup | yes (in round) | yes | A-6 | PARTIAL |
| INV-Z3-6 scrub, trap ports, bank ids | yes | yes | A-9 delta unrecorded | PASS w/ MED |
| E-2/B-16 deferral | honest in substance | n/a | A-3: wrong place, after spend, issue unfiled | **NEEDS FIX** |
| Fences / harness unmodified / derived cap | yes | n/a | n/a | PASS |
