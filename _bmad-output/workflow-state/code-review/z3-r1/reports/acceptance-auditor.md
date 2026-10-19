# Z3 R1 — Acceptance Auditor

Scope: story `z3-cross-repo-live-exit-round.md` (AC1–7, Observability Contract, INV-Z3-1..6, Technical Notes, Files to Modify, fences) and `.unlazy/z3/PLAN.md`, checked against the factory diff (`scripts/z3/*`, `tests/z3/*`, `tests/fleet/e2e/z3-exit-round.live.test.ts`) and the fork diff (`protocol-z3-exit-round.ts`, its test, the `scheduler.ts` hook).<br />
Read-only audit. I did not edit any code.

**What holds:** `Z3_MAX_FLEET_RUNS = MAX_QA_LEGS + 1` is derived on both sides and never restated. `live-harness.ts` and `sc2-harness.ts` are unmodified, and the G4 fence gate holds. Every negative control in `tests/z3/assertions.test.ts` runs through the production `assert*` functions in `scripts/z3/assertions.ts`, over files written by the real `runZ3Round` drivers, so none of them re-implement the check inside the test. No auto-approve or auto-merge path exists on either side. `scripted: true`, `executedBy`, `decisionSource` and `tokenChannel: "stdin"` are recorded. The `finally` runs `runCleanup` on every path and records the failure path. ADR-2 is never consulted.

The gaps are in the **live path**. Several leg proofs are true by construction in the live wiring, so their negative controls only exist at the fixture tier. The live round also cannot run from merged code alone.

---

### A-1 [HIGH] AC1 / "No stub, no TODO: wire later" scripts/z3/live-round-wiring.ts:51
**Gap:** The live round depends on day-of tooling that is not in either diff and does not exist on disk:
- `.unlazy/z3/z3-day-of.ts` is run with `docker exec … npx tsx /factory/.unlazy/z3/z3-day-of.ts state` at `:93`. Every fork-state read goes through it (trigger, submitting, submitted, observe, protocol complete).
- `.unlazy/z3/harvest/<runId>.json` is read at `:283-284`. Nothing in merged code produces it, and the round is sequential: `retainFindings` runs right after `awaitResult(terminal)`, with no pause for anyone to extract it.
- Nothing calls the fork-side `createZ3ExitRoundSchedule` (`protocol-z3-exit-round.ts:254`). There is no route, CLI or script, so arming the schedule also needs unwritten tooling.

**Evidence:** `ls .unlazy/z3/` shows only `GATES.md` and `PLAN.md`. `grep createZ3ExitRoundSchedule` in fork `src/` finds only the definition and its test. `refreshState` swallows the failure (`:97-100`), so a missing dump script turns into a silent 180-minute poll timeout instead of a fast failure. The A2 precedent (`.unlazy/a2/qa-f3-day-of.ts`) is already gone from disk, which shows this class of tooling does not last.

**Fix:**
- Commit the state dumper as `scripts/z3/fork-state-dump.ts` (or the fork's equivalent) and document how it is mounted.
- Make the harvest extraction a dep that runs inside the round, reading the run's harvest artifact through `fleet result` or the records dir, instead of a file someone drops in by hand.
- Add a committed arming entry point for `createZ3ExitRoundSchedule`.
- Fail fast when the dump script is absent.

### A-2 [HIGH] AC7 / charter §5.6 tests/fleet/e2e/z3-exit-round.live.test.ts:55
**Gap:** The GO gate and the worst-case print only gate the factory **observer**, not the **fire**.
- The spend is submitted by the fork schedule, which the operator arms on their own (TRIGGER REALITY comment, `:12-15`). It fires on `runAt` whether or not `gateFire` passed.
- The printed worst case comes from the factory env (`Z3_QA_GROUP_CAP_USD` / `Z3_CODE_GROUP_CAP_USD`, default 6). The caps that actually bind are the schedule's persisted `protocolConfig.qaGroupCapUsd` / `codeGroupCapUsd` (`protocol-z3-exit-round.ts:268`). Nothing cross-checks them.

**Evidence:** `gateFire` (`round-plan.ts:162`) throws only inside the test. The `trigger` leg records `plan.worstCaseUsd` (`leg-drivers.ts:164`) and never the fired run's caps. A refused GO still lets an armed schedule spend, and the printed number can differ from what the fork spends.

**Fix:**
- In `driveTrigger`, read the fired run's `externalJobConfig.groupCapUsd` for every step and require Σ to equal `worstCaseUsd`. Record both values in the trigger leg.
- Make the committed arming tool (A-1) arm the schedule only after `gateFire` passes, using the same caps.

### A-3 [HIGH] AC6 (and so AC1) scripts/z3/leg-drivers.ts:222
**Gap:** The fork chains `qa-observe-<lens>` straight into the next `qa-leg-<lens>` external_job (`protocol-z3-exit-round.ts:147`), and `qa-observe-<last>` straight into `z3-code-run`. Nothing on the fork side waits for the driver.
- `observeLeg` snapshots after it sees the observe step complete. It compares against the baseline taken before this leg was provisioned.
- By then the next leg's submit has usually minted its provider key, and often its box.
- The ponytail comment calls this a "fail-closed false positive", but given the chaining it is the normal case.

**Evidence:** The fixture never models the fork running ahead: `awaitResult` deletes the box and keys never grow. So a correct live system will very likely fail AC6 ("observe minted a provider key"). AC1 is make-or-break and needs every leg at exit 0, so it fails with it, and the paid round is wasted.

**Fix:** Attribute the fresh resources before charging them:
- Exclude boxes and keys that belong to a runId the fork has submitted for a different step. `factoryState[*].runId` from the same dump, plus `boxesFor` and the run records, give that mapping.
- Alternatively, add a fork-side hold before each next external_job. That is more invasive.

Add a fixture case where the next leg's box and key appear before the observe snapshot.

### A-4 [MED] AC4 scripts/z3/leg-drivers.ts:391
**Gap:** The crash window can only be hit by chance. `armCrashWindow(z3-code-run)` runs only after the last lens finishes:
- `awaitResult` terminal
- forensics
- `awaitObserveStep`
- the snapshot
- the host retain and the gateway assert
- a 10 s poll interval, plus a `docker exec` refresh of up to 120 s per poll

Meanwhile the fork has already started the `z3-code-run` submit (see A-3). `awaitStepSubmitting` correctly throws "crash window was missed; re-run the round" (`live-round-wiring.ts:196-197`), so the leg never passes vacuously. But the round can lose its paid fire on timing alone, and SC2.6's calibration is not reproduced on purpose.

**Fix:** Arm the kill concurrently from the start of the round: a watcher on `z3-code-run` entering `submitting`, independent of the sequential QA legs. Or add a fork-side hold on the code run. Record whether the run record already existed at kill time (`recordBeforeKill` present means the kill landed late), and make the assertion require the kill to land inside the window.

### A-5 [MED] AC5 / INV-Z3-3 scripts/z3/live-round-wiring.ts:301
**Gap:** In the live wiring, retain traces are produced inside the wiring, never observed. The code returns `side: "host" as const` for every documentId. The AC5 negative control ("an evidence trace of findings retained from inside a box MUST fail", `assertions.ts:297-298`) therefore only exists at the fixture tier; live evidence can never carry `side: "box"`. "No write credential in any box at any point" is checked only as memgate per-run issuance (`memoryRunKeysFor`). The box env (for example a Hindsight bearer token or API key) is never inspected.

**Evidence:** The fixture negative control overrides `retainFindings` to return `side: "box"` (`assertions.test.ts:284-292`). That shape cannot occur live.

**Fix:**
- Derive the side from an observed fact: the Hindsight document metadata or retain-origin header for each documentId, or the HindsightClient call journal of this process compared with the documents found in the bank for that runId.
- Add a box-env credential probe, or the run record's env-key manifest, to `findings-retain`.

### A-6 [MED] AC1 scripts/z3/assertions.ts:122
**Gap:** The "hand-copied or reconstructed post-hoc MUST fail" guarantee rests on the in-memory `sink.registry`, which is never persisted. `origin` is a constant the writer assigns per leg name (`evidence.ts:149`), not proof of who called it. With no registry, a cleanly fabricated file (right leg, origin, matching `writtenAt`/filename stamp, right rev) passes `assertAc1RoundComplete`. The committed `v6-z3/` evidence therefore cannot be re-audited later. The live test also filters to registered names (`z3-exit-round.live.test.ts:92`), so stray or forged files are dropped silently instead of being reported.

**Fix:** Write a round manifest (`<stamp>-z3-round-manifest.json`, filename and sha256 for each leg, written by `runZ3Round` in the `finally`) and commit it with the evidence. Make `registry` required in `assertZ3Round`. Report unregistered `-z3-` files in the dir that carry this round's stamp, instead of filtering them out.

### A-7 [MED] AC1/AC6 scripts/z3/live-round-wiring.ts:118
**Gap:** The stale-dump bind uses `Date.parse(r.createdAt ?? "")`, but fork `ProtocolRun.createdAt` is `number` (epoch ms, `solstice-ai src/types/protocol.ts`). If the (missing, see A-1) dumper serializes runs raw, `Date.parse(1760…)` gives NaN, nothing ever binds, and every await times out. `firedAt` (`:190`) carries the same type mismatch.

**Fix:** Accept number or ISO: `typeof c === "number" ? c : Date.parse(c)`. Pin the dump shape in a committed schema shared with the dumper (A-1).

### A-8 [MED] AC6 scripts/z3/live-round-wiring.ts:223
**Gap:** `observedRunId` is computed as the **target step's** `factoryState.runId`, which comes from the step config. It is not what the observe step actually read. The driver check `observedRunId === runId` (`leg-drivers.ts:243`) is therefore true by construction in the live path, and the observe step's own `FactoryEntry.observedRunId` (declared at `:65`) is ignored. `assertAc6ObserveReadOnly` also never checks `stepStatus`, `observedRunId` or `observedStatus` from disk.

**Fix:** Use `e?.observedRunId` (the observe step's own factory entry). In the assertion, require `stepStatus === "completed"`, `observedRunId` equal to the matching provision leg's runId, and a terminal or approved `observedStatus`.

### A-9 [LOW] AC7 / INV-Z3-5 scripts/z3/assertions.ts:357
**Gap:** Revoke-verify receipts with `ok: false` (for example live-harness's `{phase:"key-hash-delta", ok:false}`) pass AC7, because only the type of `ok` is checked. The round still goes red, but only through AC1's `exitCode` on the cleanup leg. AC7's own verdict from disk is wrong, against the file header's rule that "nothing here trusts a driver's own ok-shaped fields".

**Fix:** `if (receipts.some((r) => r.ok !== true)) problems.push("revoke-verify reported a leak")`. Add a negative control for it.

### A-10 [LOW] AC2 / INV-Z3-2 scripts/z3/assertions.ts:173
**Gap:** `autoMerge` is a boolean the driver computes (`leg-drivers.ts:386`). The assertion trusts it instead of recomputing from the recorded `eventTypes`, which breaks the "re-derived from disk" rule.

**Fix:** In `assertAc2ApproveRecorded`, recompute `/merge/i` over `branch.json.eventTypes` (and fail when `eventTypes` is absent).

### A-11 [LOW] INV-Z3-5 scripts/z3/leg-drivers.ts:466
**Gap:** `runCleanup` destroys only tracked runIds. A box left behind by the crash-window kill before a runId reached the fork state is detected (`leftoverBoxes` against `startBoxes`) but never destroyed. "Boxes destroyed in `finally`" does not hold for that box.

**Fix:** For leftover names that match the exe.dev runId shape, run `fleet cancel`, or `ssh exe.dev rm` as a last resort, and record receipts.

### A-12 [LOW] Technical Notes (fork-rev stamp) tests/fleet/e2e/z3-exit-round.live.test.ts:51
**Gap:** `swarmclawForkRev` comes from the operator-typed `SWARMCLAW_FORK_REV` env. It is checked against the GO record but never against the fork that is actually running. A wrong env value would stamp every leg with a rev the round did not run against, which defeats Z1's drift alarm.

**Fix:** Resolve the rev from the running fork (`docker exec <fork> git rev-parse HEAD`, or the dumper's output), require it to equal the env value and the GO record, and record it in the trigger leg.

### A-13 [LOW] AC3 scripts/z3/leg-drivers.ts:200
**Gap:** `driveBoxForensics` reads inventory once, immediately after `awaitResult(terminal)`. If exe.dev teardown lags the terminal status, it reports "box(es) outlived teardown" on a correct system. The fixture hides this, because there `awaitResult` deletes the box synchronously.

**Fix:** Re-read after `BOX_STABILITY_MS` (the same "must HOLD" posture as kill-and-provision) before calling a box outlived.

### A-14 [LOW] AC7 scripts/z3/live-round-wiring.ts:58
**Gap:** Each `pollRun` has its own 180-minute deadline, and the round chains about 10 of them inside a 240-minute bun test timeout (`z3-exit-round.live.test.ts:97`). A slow round hits the bun timeout first. The process can then exit before `runZ3Round`'s `finally` writes the cleanup record or cancels boxes.

**Fix:** Use one round-level deadline shared by every poll, set below the test timeout minus a cleanup budget.

---

## Legitimately handoff (not gaps)

- The live T2 fire (C7), the committed scrubbed `_bmad-output/evidence/v6-z3/` set, the `v6-z3/` rows in `openrig-sc2/fork-rev-manifest.json`, and `STAMPED_EVIDENCE_DIRS` growth. These follow Z1 AC5 (rows authored from round provenance) and the A3 G11 precedent.
- The `docs/planning/v6-crossrepo-contract.md` Z3 round record, story status and the `sprint-status.yaml` row. These are driver-owned and still pending; the contract doc is not yet touched.
- The scripted approver writing a temporary `approvers.json` entry and restoring it from memory. This matches the SC2.7 precedent (`sc2-7-protocol-branch.live.test.ts:295`). It is not an approval-policy change.

The handoff is valid only once A-1 is fixed. Until then the operator would be handed a round that cannot run from merged code.

## Per-AC verdict

| AC / INV | Implemented | Negative control real (prod assertion path) | Live path sound | Verdict |
|---|---|---|---|---|
| AC1 every leg by its own driver, arc green | yes | yes (fixture) | no: A-1 tooling missing, A-6 registry not persisted, A-7 bind type | **FAIL (gap)** |
| AC2 auto-approve fails | yes | yes | mostly (A-10) | PASS w/ LOW |
| AC3 exactly-one-box | yes | yes | A-13 teardown-lag false fail | PASS w/ LOW |
| AC4 crash-window idempotency | yes | yes | A-4 window opportunistic; A-11 stranded box not destroyed | PARTIAL |
| AC5 in-box retain fails | yes | fixture only | A-5 trace produced by the wiring, box env unchecked | **PARTIAL (gap)** |
| AC6 observe read-only | yes | yes | A-3 near-certain false fail; A-8 observedRunId true by construction | **FAIL (gap)** |
| AC7 live rules | yes | yes | A-2 GO does not gate the fire, caps unchecked; A-9; A-14 | **FAIL (gap)** |
| INV-Z3-1 approve scrypt/stdin/labeled | yes | yes | yes | PASS |
| INV-Z3-2 no auto-merge | yes | yes | A-10 | PASS w/ LOW |
| INV-Z3-3 no box write credential | partial | fixture only | A-5 | PARTIAL |
| INV-Z3-4 fleet only code path | yes (fork external_job) | n/a | yes | PASS |
| INV-Z3-5 unconditional cleanup | yes | yes | A-11, A-14 | PASS w/ LOW |
| INV-Z3-6 scrub, trap ports, qds- banks | yes | yes | yes | PASS |
| Fences / live-harness unmodified / derived cap | yes | n/a | n/a | PASS |
