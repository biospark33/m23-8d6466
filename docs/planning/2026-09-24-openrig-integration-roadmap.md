# OpenRig × QDS-Factory Integration — Program Roadmap & Session Handoff

**Status date:** 2026-09-24 · **Owner:** steve · **Research basis:** `docs/planning/2026-09-23-openrig-swarm-integration-research.md` (§4 architecture, §7 roadmap, §8 risks — that doc's decisions are SETTLED; this doc tracks execution, it does not re-open design).

**Purpose:** single durable tracker for the remaining OpenRig-integration work, designed to survive session boundaries. Every stage carries checkboxes with **verifiable** acceptance criteria. A session picks the first unchecked stage, completes it with full rigor (TDD, GitNexus impact/detect_changes, live-e2e rules where money or boxes are involved), marks checkboxes WITH EVIDENCE pointers, and leaves the doc merge-ready.

**Rule of the doc:** a checkbox is checked only when its evidence exists (commit SHA, test-run output, PR URL, live-round evidence file under `_bmad-output/evidence/`). No self-reported "done" without an artifact. No band-aids: every fix lands with its test; every live claim is reverified out-of-box.

---

## 0. Session start ritual (every session that touches this program)

1. Read this file top to bottom.
2. Verify the snapshot against reality — do not trust the checkboxes blindly:
   ```bash
   gh pr view 283 --json state,mergedAt -q '.state'    # S0 docs/spike
   gh pr view 284 --json state,mergedAt -q '.state'    # S1 rig_swarm phase
   git log --oneline -5 origin/dev
   grep -n "DEFAULT_IMAGE_REF =" src/providers/exedev/driver.ts   # pin adopted?
   grep -rn "MEASURE-AT-FIRST-BUILD" oci/exedev/Dockerfile | head -3   # sentinels filled?
   ```
3. Find the FIRST stage below with an unchecked box. That is this session's work (or continue the half-done one).
4. State the plan for the session to the operator before spending money or creating boxes.
5. At session end: update checkboxes + evidence lines, commit the doc on the working branch, ensure it reaches `dev` (carry in the stage's PR, or a dedicated docs PR).

---

## 1. Program invariants (hold at every stage — never traded for speed)

1. **The factory is the only way code changes enter.** The DAG never provisions boxes, mints keys, or opens PRs — it only calls `fleet submit/result/cancel` (once Q1 lands). OpenRig's workflow engine never owns macro flow.
2. **One tier-2 brain per box.** In `rig_swarm` mode the OpenRig lead seat orchestrates; the resident agent is off; the phase engine keeps gate authority (`testCommand`).
3. **The cockpit watches, never operates boxes.** No `rig_up`/`rig_down` against factory boxes. Tunnel + `rig mcp serve` only.
4. **The DAG never approves.** Runs end at `awaiting-approval`; `fleet approve` is human, scrypt-authenticated.
5. **Money is enforced only in QDS.** Per-seat provider key caps are the hard limit; Σ(seat caps) ≤ admitted run ceiling; ledger records everything; OpenRouter account-level monthly cap + auto-recharge OFF as backstop.
6. **Never trust the box.** Out-of-box reverify; harvested evidence; teardown always in `finally`; `ssh exe.dev ls --json` empty and 0 live keys at the end of every live round.
7. **Process, every session:** GitNexus `impact()` before editing any symbol (report blast radius; warn operator on HIGH/CRITICAL); `detect_changes()` before every commit; tests ALWAYS teed to a log and read via the CLAUDE.md tr/perl filter; branch `feature/*` off `dev`, PR target `dev`; files under 500 lines; new logic in new files when `scripts/pipeline-run.ts` is touched.
8. **Live money/boxes:** `qds-live-e2e` skill is MANDATORY for any live round. Worst-case spend estimate printed first; explicit operator "go"; keys revoked + boxes destroyed in `finally`; unsandboxed shell for live tiers; never run live tiers parallel to the test suite.

---

## 2. Current-state snapshot (verified 2026-09-24)

| Piece | State | Where |
|---|---|---|
| S0 research + spike | Code+docs on `feature/openrig-swarm-spike`, **PR #283 OPEN** (unmerged) | `docs/planning/2026-09-23-openrig-swarm-integration-research.md`, `_bmad-output/evidence/openrig-s0/2026-09-23-spike-s0.json`, `spikes/openrig-s0/` |
| S1 `rig_swarm` phase kind | Complete + final-review fix wave in flight, **PR #284 OPEN** (12 commits, head `cf629518` at last update — this cell is a cache; §0's `gh`/`git log` commands are the authority, the head moves with every fix commit) | schema `src/phase-engine/{types,manifest}.ts`; body `src/phase-engine/phases/openrig-swarm.ts` + `openrig-cost.ts`; keys `src/providers/{credentials,run-record,teardown}.ts` + `src/fleet/dispatch.ts`; harvest `src/providers/harvest.ts`; image `oci/exedev/Dockerfile` + `binary-licenses.json` + `scripts/build-exedev-image.ts` |
| S1 progress ledger | 8 tasks + fix waves + final review triage | `.superpowers/sdd/progress.md` (git-ignored scratch — its content is summarized in PR #284 body; copy anything durable into issues/docs) |
| S1 image | **Pairing debt declared**: driver pins UNTOUCHED; two TOFU ARGs carry `MEASURE-AT-FIRST-BUILD` sentinels that fail-closed at first real build | `src/providers/exedev/driver.ts:451,516` must move ONLY post-merge |
| Old SDD ledger (self-compact) | Archived, historical | `.superpowers/sdd/progress-self-compact-archived.md` |
| Pre-existing dev test failures | 16 (vendor self-compact, story-consistency) + 2 flaky wall-clock tests + GitHub #280 (pi handoff-return) | NOT this program's bugs; do not fix here, do not count them against stage gates |

---

## 3. Stages

Order and dependencies: **R0 → R1 → {P0 ∥ Q1 ∥ SC1} → S2 → SC2 → ADR**. R0 gates everything live. SC2 needs S1+P0+Q1+SC1. Do not start SC2 early "because the pieces are mostly there" — the exactly-one-box kill test is the point.

---

### Stage R0 — S1 completion: merge, image adoption, first live `rig_swarm` round

**Status:** ☐ NOT STARTED (blocks: PR #284 merge)
**Depends on:** PR #283 + #284 merged to `dev`.

- [ ] **R0.1 Merge PR #283** (S0 docs/spike/evidence) into `dev`.
  - Evidence: PR state merged; research doc present on `dev`.
- [ ] **R0.2 Merge PR #284** (S1) into `dev`.
  - Evidence: PR state merged; `git log origin/dev` carries `0044e62d`.
- [ ] **R0.3 Publish the image from `dev`** via the existing workflow. It refuses feature branches — this is why R0 waits for merge. **BLOCKED BY R0.4**: every build refuses at `NODE_SHA256`/`OPENRIG_TREE_SHA256` until the sentinels carry measured values. The refusal mechanism IS the measurement step: run this workflow once, read the gate's refusal output (it prints the measured hashes), pin them in R0.4, then publish here.
  - Evidence: workflow run URL + printed `DEFAULT_IMAGE_REF` digest + `DEFAULT_IMAGE_BUILD_ID`, from the post-R0.4 run (the pre-pin run's refusal output is R0.4's measurement evidence).
- [ ] **R0.4 Fill the two TOFU sentinels** (`NODE_SHA256`, `OPENRIG_TREE_SHA256` in `oci/exedev/Dockerfile`) with the measured values from the build refusal output (the gate prints the measured hash; a R0.3 publish attempt produces it — run that first), and admit any first-build reconciliations the sentinel design anticipates (license paths, `rig --version` layout, sweep adjustments) — one commit on `dev` or a fast PR, landing BEFORE R0.3's successful publish. This is commit 1 of 2: the sentinel pins move the buildId and must precede the build that produces the digest; R0.5's pin adoption is a separate, later commit because the digest does not exist until the pinned build publishes (the Dockerfile's sentinel-section comment states the same sequencing).
  - Evidence: grep finds no `MEASURE-AT-FIRST-BUILD` in the Dockerfile; `bun test tests/scripts/build-exedev-image.test.ts` green (236 expected; walked-input hashes re-derived on the final tree).
- [ ] **R0.5 Adopt the pin at the three sites in ONE commit on `dev`:** `driver.ts:451` (`DEFAULT_IMAGE_REF`), `driver.ts:516` (`DEFAULT_IMAGE_BUILD_ID`), and the `build-exedev-image.test.ts` expectation — exactly the ritual the qds-live-e2e skill's "Pin adoption" section prescribes.
  - Evidence: one commit touching exactly those sites; `bun test tests/providers/ -f exedev`-scoped pin tests green; no other diffs smuggled in.
- [ ] **R0.6 Re-push the private mirror** (per the qds-live-e2e skill).
  - Evidence: mirror push output; the pinned digest resolves from the mirror.
- [ ] **R0.7 Run the paid live round** under `qds-live-e2e`, tiers scoped to `rig_swarm`:
  - Print worst-case spend estimate (2 Pi seats × $0.50 caps + box-hours) and get the operator's explicit "go" BEFORE anything.
  - The round must produce: a dispatch whose manifest runs `rig_swarm` (2 Pi seats) on the NEW image → harvested commit, `testCommand` gate green, out-of-box reverify green, per-seat `cost_attribution` rows in the ledger, teardown immediate on lead qitem done, 0 boxes (`ssh exe.dev ls --json` empty), 0 live keys (OpenRouter key list empty of `sbx-` entries), spend ≤ caps.
  - ALSO verify during the round (from final-review observations): `rig daemon start` idempotency on a box where a daemon may already run; env-append idempotency of `deliverSeatKeys` on a retry; first-build sentinel reconciliation actually landed (R0.4).
  - Evidence: JSON evidence file `_bmad-output/evidence/openrig-s1/<date>-<slug>.json` recording all of the above, failures included.
- [ ] **R0.8 File the live-round gaps** (if any) as issues BEFORE declaring R0 done. The stage is done only when the round is green or every red has a filed, triaged issue with a named owner stage.
  - Evidence: issue URLs.

**Definition of done (stage):** R0.1–R0.7 checked with artifacts; S1 declared complete on `dev`; image pin adopted; live evidence committed.

---

### Stage R1 — file the deferred follow-up issues (fast, do immediately after R0)

**Status:** ☐ NOT STARTED
**Depends on:** R0 (issue list final after the live round).

One issue each, with the context from `.superpowers/sdd/progress.md` + final review (reproduce the reasoning in the issue body — the scratch ledger dies with the machine):

- [ ] **I1** `usdToMicros`: no `isSafeInteger` overflow guard — a finite USD > ~1.8e302 overflows to Infinity µ$ (guard belongs in `usdToMicros`, one place, all callers; `credentials.ts`).
- [ ] **I2** `mintRunKey` symmetric guard: a record carrying BOTH `keyHash` and `extensions.swarmSeats` is unreachable today but unguarded — `swarmed && !keyed`-style hardening in teardown gates + mint-side refusal (Task 6 review, shape-D).
- [ ] **I3** `openrig-swarm.ts` costing reads only the LARGEST session JSONL per seat — multi-session seats undercount; `reportSpendDivergence` is the current safety net; sum all matched files instead.
- [ ] **I4** PLAN REVISION (before S2): a `rig_swarm` manifest without `testCommand` + timeout-fallback records `success` on an unverified swarm. Either require `testCommand` on `rig_swarm` in the schema, or warn/refuse at dispatch. Needs an explicit operator decision (schema change vs dispatch warning) — do not just pick one.
- [ ] **I5** Flaky wall-clock test assertions (`toBeGreaterThanOrEqual(90)` class) — two load flakes observed 2026-09-23/24; isolate and deflake or mark tier-gated.
- [ ] **I6** Duplicate-member-id diagnostics (schema refuses via the indirect seatBudgets message; dedicated duplicate-id issue would name the real problem).
- [ ] **I7** `emitSeatCosts` return value discarded by the caller (doc/usage mismatch — log the seat total or drop the contract).
- [ ] **I8** Harness nits batched: `makeTempHome` temp-dir leak; `tracer.close()` outside try/finally in 2 pipeline-run tests; factory tests cannot discriminate executor vs the (now-deleted) interim arm — add `expect(body.name).toBe("gated")`; mergeSweeps doc-comment overstates dedup invariant; dead multi-site merge branch in `extractNodeModules`; harvest strip-line escaping inconsistency.

**Definition of done (stage):** issues I1–I8 open with full context pasted in (scratch ledger quoted); each labeled with its owner stage.

---

### Stage P0 — worker-rpc hardening (independent of OpenRig; blocks SC2)

**Status:** ☐ NOT STARTED
**Branch:** existing `feature/rpc-worker-handoff` (has the RPC transport; the four bugs below are its remaining work). Rebase onto current `dev` before starting.
**Size:** ~50 LOC + 5 tests. **Research ref:** research doc §2.5 (bug list verbatim there).

Scope (all in `cli-anything/scripts/worker-rpc.ts` on that branch):

- [ ] **P0.1** Prompt error ignored: pi returns `error(id,"prompt")` → no `agent_settled` ever arrives → worker hangs until `timeoutMs`. Fix: treat prompt-error as settle-with-failure. Test: injected error frame settles the worker, no timeout relied on.
- [ ] **P0.2** `get_state` failure treated as idle (fail-open): shutdown proceeds while a compaction may be in flight. Fix: fail-closed — a failed `get_state` aborts shutdown (or retries with bound). Test: get_state fault injected → shutdown refuses.
- [ ] **P0.3** Spawn-error path skips `finish()`: timers leak; a later SIGKILL can still fire. Fix: finish() in finally on the spawn-error path. Test: spawn error → no live timers after settle (leak assertion).
- [ ] **P0.4** No re-arm on `compaction_end` / `auto_retry_end` after a failed compaction (possible — confirm first; if confirmed, fix + test; if not reproducible, write the probe test that proves it and check the box with the negative result).
- [ ] **P0.5** Env allowlist: workers currently receive the whole `process.env`. Harden to an explicit allowlist (mirror the daemon-side allowlist discipline; the OpenRig `pi-runner-protocol.ts` patterns are the reference for the protocol handling ONLY).
- [ ] **P0.6** `drainReason` on each result + opt-in session file for resume.
- [ ] **P0.7** DO NOT adopt OpenRig's `readline` JSONL framing — it splits on U+2028/U+2029 (legal inside JSON strings). If framing is touched at all, frame on `\n` only, with a test carrying a U+2028 inside a string payload.
- [ ] **P0.8** One live round to prove the hardened worker end-to-end (qds-live-e2e rules; this touches real pi processes but no OpenRig spend — still a real box).

**Definition of done (stage):** branch rebased, TDD'd fixes with the tests above green, full suite no-new-failures, detect_changes reviewed, PR to `dev`, live round evidence committed.

---

### Stage S2 — mixed runtimes (Claude/Codex seats via OpenRouter)

**Status:** ☐ NOT STARTED
**Depends on:** R0 (live rig_swarm baseline). **Size:** small. **Research ref:** §5.2, §5.5 (per-runtime cap mechanisms table), §9a finding on coms identity.

- [ ] **S2.1** Coms identity fix (~2 lines): identity falls back to `pi.getSessionName()` with `@`→`_` (runner strips `--cname` + `PI_COMS_*`). Test at the adapter level.
- [ ] **S2.2** Claude Code seats: `ANTHROPIC_BASE_URL=https://openrouter.ai/api` + `ANTHROPIC_AUTH_TOKEN=<seat key>` + `ANTHROPIC_API_KEY=""` in a per-seat env — requires the OpenRig member-env patch (~5 lines at `node-launcher.ts:132`, an UPSTREAM file — we do not fork; carry it as a pinned-tree patch in the image build with its own hash-gate, same species as the self-compact copy) OR a per-seat `CODEX_HOME`/settings approach where the patch proves worse. Decide with evidence; record the decision in the research doc's §5.5 table.
- [ ] **S2.3** Codex seats: `model_providers.openrouter` in per-seat `CODEX_HOME`; user-level config; Responses API only.
- [ ] **S2.4** Schema: allow `runtime: "claude" | "codex"` in `RigMemberSpec`; per-seat key delivery extends `deliverSeatKeys` (seat→key map already seat-agnostic; the SEAT DIR layout differs per runtime — document each layout in `openrig-swarm.ts`).
- [ ] **S2.5** Mixed-cap guard: keep Σ seat caps ≤ ceiling for MIXED runtimes (caps table §5.5 — Claude Max/ChatGPT Pro subscription seats are FORBIDDEN in capped runs; enforce by refusing non-OpenRouter runtimes at the schema or dispatch level).
- [ ] **S2.6** Live round with a mixed rig (≥1 claude seat + ≥1 pi seat), full teardown/caps evidence as R0.7.
- [ ] **S2.7** Cockpit MCP finding carried from S0: messages via MCP carry no sender — read via `rig_capture` or send through the queue with `sourceSession`. Document the cockpit posture for mixed rigs in the research doc.

**Definition of done (stage):** schema + delivery + docs landed; mixed live round green with per-seat per-runtime cost rows; no subscription-OAuth spend path exists.

---

### Stage Q1 — factory service surface (the DAG-facing contract)

**Status:** ☐ NOT STARTED
**Depends on:** none (parallel with P0/SC1). **Size:** 1–1.5 weeks. **Research ref:** §2.4 gaps G1–G8.

Closes the gaps that make the fleet callable as a DAG node. Every item lands with a CONTRACT TEST; the contract is versioned and pinned (precedent: `tests/gitnexus/cli-contract.ts` discipline).

- [ ] **Q1.1** `fleet submit --request-id --budget-group <id> --group-cap <usd> --json` — replay-safe (same request-id ⇒ same run, exactly one box; G2), ack returns immediately (G1/G3 groundwork). Contract test: replay twice ⇒ one box, one key, same runId.
- [ ] **Q1.2** Budget-group reservation in one ledger transaction against both the group cap and the per-issue cap (G6). Test: concurrent submits against one group cannot double-spend headroom.
- [ ] **Q1.3** `fleet result <runId> --json` — versioned, contract-pinned completion payload (G3). Includes terminal status + artifact refs; poller-friendly.
- [ ] **Q1.4** `fleet cancel <runId>` — idempotent; tears down box + keys exactly once (G4). Test: cancel twice ⇒ one teardown, both succeed.
- [ ] **Q1.5** Cross-process VM-headroom intent record (G5): the guard becomes cross-process durable. Test: two processes dispatching concurrently cannot oversubscribe.
- [ ] **Q1.6** Fanout FleetLock contention (G7): second concurrent fanout must not exit 5 — scope the lock or queue the contender. Test: two concurrent fanouts both progress.
- [ ] **Q1.7** Brief schema: non-issue work without synthetic issue ids (G8) — decide the minimal brief shape for headless DAG work; operator sign-off on the schema change.
- [ ] **Q1.8** Contract suite: ONE test file pins the submit/result/cancel JSON shapes (field names, types) — drift alarm style, named fields on failure. This is the surface SC2 codes against; it does not move without a deliberate version bump.

**Definition of done (stage):** all verbs shipped behind the pinned contract; replay + exactly-one-box test green; PR to `dev`.

---

### Stage SC1 — SwarmClaw protocol-engine fixes

**Status:** ☐ NOT STARTED (repo: `~/swarmclaw`)
**Depends on:** none (parallel). **Hard cap: 2 weeks** — if the scheduler fix overruns, drop SwarmClaw as host and build the ~300-line sequential runner in QDS behind the same submit/result/cancel contract (Q1 carries over either way; escape hatch per research §8).
**Research ref:** §3.2 — bugs confirmed by executable tests at scratch commit `45d3376b` (worktree removed; the failing tests must be RE-CREATED first).

- [ ] **SC1.0** Re-create the executable failing tests for bugs 0–3 (they died with the scratch worktree; the evidence table below is the spec).
- [ ] **SC1.1** Bug 0: `normalizeProtocolRun` drops `phaseState.dispatchedTaskId` (`protocol-normalization.ts:534-547`) → a run with a dispatch step never wakes. Fix: carry the field through normalization (one line).
- [ ] **SC1.2** Bug 1: wake path advances the run even when the task `failed`/`cancelled` (`protocol-run-lifecycle.ts:103-129`; queue wakes only on success, `runtime/queue/core.ts:1690`) → linear run with a failed task shows `completed` and downstream steps ran. Fix: fail the run/step on non-completed status; wake from the queue's failure branches.
- [ ] **SC1.3** Bug 2: DAG-mode wake skips `finishStep` → `currentStepId=null` → `completeProtocolRun` fires early. Fix: wake through `finishPhase`; refuse completion while any step is running.
- [ ] **SC1.4** Bug 3: DAG mode runs only `readyStepIds[0]`; one waiting step pauses the whole run (`:382-404`) → a join never runs while another root waits. Fix: keep the run `running` while other steps are ready; key dispatch state per step.
- [ ] **SC1.5** Scheduler: a long step must not pause the run (the lease/dwell fix behind bug 3's symptom).
- [ ] **SC1.6** Blocking risk (adversarial-review finding): the 120 s lease vs minutes-long dispatch — lease expiry → recovery re-runs the step → SECOND BOX + SECOND KEY. Mitigation lands with SC2's persist-request-id-before-submit + Q1's idempotent submit; SC1 documents the dependency and adds the regression test at the SC2 seam.

**Definition of done (stage):** re-created failing tests turn green; no new failures in SwarmClaw's suite; within the 2-week cap or the escape hatch invoked with operator sign-off.

---

### Stage SC2 — SwarmClaw `external_job` step (the factory adapter)

**Status:** ☐ NOT STARTED
**Depends on:** S1 + P0 + Q1 + SC1. **Size:** ~250 LOC. **Research ref:** §7 SC2 row.

- [ ] **SC2.1** Factory adapter: persist the request id BEFORE submitting (crash between persist and submit is recoverable; the reverse orphans a box), submit via Q1's idempotent `fleet submit`, persist the returned runId.
- [ ] **SC2.2** Daemon poller calls `fleet result` per outstanding request; produces a `factory_result` artifact.
- [ ] **SC2.3** New condition kind `artifact_field_equals` for branching on the verdict.
- [ ] **SC2.4** Protocol cancel calls `fleet cancel` (idempotent both sides).
- [ ] **SC2.5** Process hygiene: `execFile` with env allowlist + absolute path (no shell, no inherited env).
- [ ] **SC2.6** Lease regression test at this seam (SC1.6's risk): a dispatch longer than the lease must not double-create a box — kill SwarmClaw mid-submit, restart, assert exactly one box and one key.
- [ ] **SC2.7** EXIT TEST (the stage gate): a live protocol runs `factory_run`, branches on the verdict, and notifies; then kill SwarmClaw mid-submit and confirm exactly one box. Full live-round evidence under `_bmad-output/evidence/`.

**Definition of done (stage):** exit test green end-to-end on real boxes; exactly-one-box property proven under crash.

---

### Stage ADR — architecture decision record

**Status:** ☐ NOT STARTED
**Depends on:** SC2 proven.

- [ ] **ADR.1** Reverse DD-7 ONLY as far as: "SwarmClaw hosts macro processes via `external_job`; the fleet stays the only way code changes enter." One page, states the boundary, the invariants (§1 above), and what was rejected and why (research doc §6). Operator sign-off required — this is a human decision, not a PR merge.

---

### Deferred (explicitly out of scope — do NOT start without operator instruction)

- `code` / `http` / `browser` DAG nodes (deterministic + browser QA steps)
- Auto-approve policy (would live next to the gate under its own ADR)
- `openrig_local` adapter (local daemon as an engine)
- FleetLock replacement
- OpenRig CLI upgrades past 0.5.14 (pinned by hashed tree; upgrade is a deliberate ritual: bump ARG, re-measure TOFU hash, re-run live round)
- Daemon SQLite harvesting (no consumer; revisit when one exists)

---

## 4. Cross-cutting follow-up backlog

Owner stages are named in R1; this section is the index. NOTHING here blocks a stage's PR unless its owner stage's review says otherwise.

| ID | Item | Owner stage |
|---|---|---|
| I1 | `usdToMicros` overflow guard | R1 → any credentials toucher |
| I2 | shape-D mint/teardown hardening | R1 → next teardown toucher |
| I3 | multi-JSONL seat costing | R1 → S2 |
| I4 | gate-less `rig_swarm` timeout-fallback records success — plan revision (operator decision) | R1 → before S2 |
| I5 | flaky wall-clock assertions | R1 |
| I6–I8 | diagnostics/harness nits | R1 |
| — | daemon-start idempotency confirmation | R0 live round |
| — | env-append idempotency confirmation | R0 live round |
| — | GitHub #280 (pi handoff-return; self-compact program) | tracked separately, not this program |

---

## 5. Risk register (from research §8 — still current)

| Risk | Mitigation | Trigger to watch |
|---|---|---|
| OpenRig churn breaks swarm mode | Pinned 0.5.14 by hashed tree; DAG contract independent of the mode | Any upstream upgrade attempt |
| pi/runtime incompatibility | S0 proved 0.84.4 works; bump only in a re-pin | Live-round seat-ready failures |
| Seats outlive the phase | `finally` teardown chain; key cap as hard ceiling; box reaper | Idle-spend rows in any round |
| Memory: daemon + N runners + N pi | Size the box; DF3.6b cgroup covers resident only | OOM-wedged daemon (the F2 hang class — now bounded by SWARM_MAX_STALE_POLLS) |
| SC1 doesn't fit 2 weeks | Escape hatch: ~300-line sequential runner in QDS behind the same contract | Day-10 checkpoint |
| tmux 3.3a | Non-issue: image is Ubuntu 24.04.5 w/ tmux 3.4 (S0-proven) | Any base-image change |
| SwarmClaw lease vs long dispatch | Persist-request-id-before-submit + idempotent submit (SC2.1/Q1.1) + SC2.6 kill test | Any double-box observation, ever |

---

## 6. Session handoff prompt (paste into a new session in `/Users/steve/QDS-Factory`)

```text
You are continuing the OpenRig × QDS-Factory integration program. The tracker is
docs/planning/2026-09-24-openrig-integration-roadmap.md — read it FIRST, top to bottom.
It is the single source of truth for what remains. Do not re-research; research doc
§4/§7/§8 decisions are settled. Execute the next unchecked stage with full rigor.

Session ritual (from roadmap §0 — run it before anything):
1. Read the roadmap.
2. Verify its snapshot against reality (the grep/gh commands are in §0 — run them).
3. Take the FIRST unchecked stage. That is this session's work.
4. Tell the operator what you will do, and get explicit "go" before ANY spend or box.
5. At session end: update checkboxes WITH EVIDENCE (commit SHAs, test output, PR URLs,
   evidence JSON under _bmad-output/evidence/), commit the doc, make sure it reaches dev.

Hard rules (roadmap §1 — never traded away):
- Factory is the only way code enters; one tier-2 brain per box; cockpit watches but
  never operates boxes; DAG never approves; money enforced only in QDS; never trust
  the box.
- GitNexus impact() before editing any symbol (report blast radius; warn on
  HIGH/CRITICAL); detect_changes() before every commit; tests ALWAYS teed to
  /tmp/qds-test.log + read via the CLAUDE.md tr/perl filter; feature/* off dev, PR
  target dev; files < 500 lines.
- qds-live-e2e skill is MANDATORY for live rounds: worst-case spend printed first,
  explicit operator "go", keys ≤ caps, revoke+destroy in finally, unsandboxed live
  shells, `ssh exe.dev ls --json` empty and zero sbx- keys at the end.
- Pre-existing dev failures (16 vendor/story-consistency + 2 flaky + #280) are NOT
  this program's; gate = no NEW failures.

Expected current position (verify, don't assume): PR #283 (S0 docs/spike) and #284
(S1 rig_swarm phase, in final-review fix wave — check the current head, it moves) are
OPEN. Stage R0 is therefore
next: merge both, publish the image, fill the two MEASURE-AT-FIRST-BUILD TOFU
sentinels from the build refusal output, adopt the pin at the three sites in ONE
commit, re-push the private mirror, then the first paid live rig_swarm round
(2 Pi seats, ≤$0.50/seat) with evidence JSON under _bmad-output/evidence/openrig-s1/.
Then R1 (file issues I1–I8 — context lives in .superpowers/sdd/progress.md, which is
git-ignored scratch: PASTE the durable reasoning into the issues).

First action: run the §0 ritual, then report the verified position and the stage you
are starting to the operator.
```
