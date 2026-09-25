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
| S0 research + spike | **MERGED** (PR #283 → dev, 2026-09-24T12:32:40Z, `8fbc66bc`) | `docs/planning/2026-09-23-openrig-swarm-integration-research.md`, `_bmad-output/evidence/openrig-s0/2026-09-23-spike-s0.json` |
| S1 `rig_swarm` phase kind | **MERGED** (PR #284 → dev, 2026-09-24T16:33:04Z, `7957e8a4`) | schema `src/phase-engine/{types,manifest}.ts`; body `src/phase-engine/phases/openrig-swarm.ts` + `openrig-cost.ts`; keys `src/providers/{credentials,run-record,teardown}.ts` + `src/fleet/dispatch.ts`; harvest `src/providers/harvest.ts` |
| S1 progress ledger | 8 tasks + fix waves + final review triage | `.superpowers/sdd/progress.md` (git-ignored scratch — its content is summarized in PR #284 body; copy anything durable into issues/docs) |
| S1 image | TOFU sentinels pinned (R0.4 ✓); publish chain LIVE — repro sources R3-a (npm cacache, PR #288) and R3-c (node V8 compile cache, PR #292) both fixed + asserted; **SEVENTEENTH pin printed, adoption pending** (see R0.3/R0.5) | `oci/exedev/Dockerfile`, `src/providers/exedev/driver.ts:464,535`, `scripts/build-exedev-image.ts` (layer inventory, PR #291) |
| Live-round test | T2.8 DRAFTED + offline-verified (not yet run): `feature/r0-live-swarm-test` → rebased as needed | `tests/fleet/e2e/tier2-rig-swarm.live.test.ts` + `in-box-status-poll.ts` + `config/rosters/r0-swarm.pipeline.json` |
| Pre-existing dev test failures | 16 (vendor self-compact, story-consistency) + 2 flaky wall-clock tests + GitHub #280 (pi handoff-return) | NOT this program's bugs; do not fix here, do not count them against stage gates |

---

## 3. Stages

Order and dependencies: **R0 → R1 → {P0 ∥ Q1 ∥ SC1} → S2 → SC2 → ADR**. R0 gates everything live. SC2 needs S1+P0+Q1+SC1. Do not start SC2 early "because the pieces are mostly there" — the exactly-one-box kill test is the point.

---

### Stage R0 — S1 completion: merge, image adoption, first live `rig_swarm` round

**Status:** ☐ NOT STARTED (blocks: PR #284 merge)
**Depends on:** PR #283 + #284 merged to `dev`.

- [x] **R0.1 Merge PR #283** (S0 docs/spike/evidence) into `dev`.
  - Evidence: PR state MERGED 2026-09-24T12:32:40Z; merge commit `8fbc66bc` on `origin/dev`; research doc present on `dev`.
- [x] **R0.2 Merge PR #284** (S1) into `dev`.
  - Evidence: PR state MERGED 2026-09-24T16:33:04Z; merge commit `7957e8a4` on `origin/dev`; carries `0044e62d`.
- [ ] **R0.3 Publish the image from `dev`** via the existing workflow. It refuses feature branches — this is why R0 waits for merge. **BLOCKED BY R0.4**: every build refuses at `NODE_SHA256`/`OPENRIG_TREE_SHA256` until the sentinels carry measured values. The refusal mechanism IS the measurement step: run this workflow once, read the gate's refusal output (it prints the measured hashes), pin them in R0.4, then publish here.
  - Evidence: workflow run URL + printed `DEFAULT_IMAGE_REF` digest + `DEFAULT_IMAGE_BUILD_ID`, from the post-R0.4 run (the pre-pin run's refusal output is R0.4's measurement evidence).
  - Measurement-chain record (all on `feature/r0-image-convergence`, dispatched dry runs): run 36028156132 (merge push) refused at the ENGINE probe — S1's phase bodies import `src/providers/credentials.ts`, the engine COPY enumeration lacked it and its provider closure (7 files; bun resolves before tree-shaking, so sourcemap closures under-report) — fixed in `e2660618` with both workflow lockstep lists + same-commit re-pin of the per-asset Dockerfile sha and the whole-walk digest (the latter already stale at the S1 merge, verified against clean HEAD). Run 36031582204 then refused at the node gate; run 36032367862 cleared node and refused at the tree gate; run 36033368044 cleared both TOFU gates and refused at the license sweep (10 nested `@openrig/cli` dep executables — reconciled in `b825949c`/`cbc4563b`); run 36037302102 passed EVERY gate and ended at the designed dry terminal state: buildId `7ab13076ccec247c` measured at `cbc4563b`, digest withheld by design until a real push.
  - PUBLISH HISTORY (2026-09-24): run 36048175927 (first real publish, src_sha `07db7e3e`) pushed `9d1822c6…` / buildId `68fca032d53c0de6`, gate B refused pre-adoption → **workflow pruned the digest by design** and printed the paste-ready pair. Adoption #15 merged as PR #287 (`e3500764`). The healing run 36056831164 then pushed a THIRD digest `b090c2a7…` with an UNCHANGED buildId — the exact case the gate's text says to FIX, not re-pin. Root-caused via the runs' own evidence artifacts (identical buildId/builtAt/gitSha/piSha256/sweep/NOTICE; `imageSizeBytes` ±12 compressed bytes): **npm's `/root/.npm` cacache ships wall-clock bytes** (`time`, `resHeaders.date`, etags), invisible to every gate. Fixed in PR #288 (`55215f51`): cache+logs redirected to /tmp, deleted same-layer, fail-closed assertions on `/root/.npm`+`/root/.npmrc`.
  - PUBLISH HISTORY CONTINUED (2026-09-24/25, the R3-c chapter): run 36063335634 (post-#288, src_sha `55215f51`) printed the SIXTEENTH pin (`02d7a0f4…`/`7fc93c21509a6d2a`); adopted as PR #290 (`613dd6e2`). Its healing run 36077483206 printed a digest at an UNCHANGED buildId AGAIN (`8928a265…`, +48 compressed bytes) — billing did NOT cause it (full 9m13s run, gate B refused on merits). Diagnosis by exhaustion (npm exonerated by #288's own assertion; pi updater proven content-deterministic via full-fs hash diff ×2 in the pinned base; bun frozen-lockfile leaves NO cache; builder buildkit image `buildx-stable-1` unmoved since 2026-08-12; local micro-probe reproduced the CLASS — RUN wall-clock content moves the digest, `rewrite-timestamp` covers mtimes only). Both CI manifests were pruned before layer-level forensics → PR #291 (`2b29e804`) added `manifestInventory` (config + per-layer digest/size) to publish-evidence.json so the NEXT divergence names its layer. Two dispatched runs (36082995077 `f9df4a03…`, 36084574659 `b268d776…`) diverged in EXACTLY ONE layer (#59, the openrig npm install RUN, +9 bytes). Registry prune had deleted the manifests but the BLOBS survived: config blobs → `rootfs.diff_id[59]` differs (tar bytes genuinely differ); layer blobs pulled via the registry API → forensic diff: **12,415 tar entries of `/tmp/node-compile-cache/v22.20.0-x64-…` — node's V8 compilation cache — 125,790 uncompressed bytes differing**, while the RUN's own `/opt/openrig` tree gate (`543e846b…`) passed on every run. Writer: the RUN's own `npm i` + `rig --version` node executions; npm cache/logs were cleaned, the compile cache never was. Control: a local double build of the exact node+npm sequence under the `qds-repro` builder produced IDENTICAL manifests. Fixed in PR #292 (`aa3d7d33`, R3-c): delete `/tmp/node-compile-cache` in the same RUN + fail-closed assertion naming the measurement; Dockerfile walk literal re-pinned from the test's own failing run (`ef691e7f…` → `230ba65b…`). Run 36134427077 (post-#292) printed the **SEVENTEENTH pin — `f73409b4…` / buildId `9a025fc31fc1bc88`** (both moved: the Dockerfile is a buildId input, a legitimate substrate change). Its adoption + GREEN healing run are R0.3/R0.5's remaining work; if the healing run prints yet another digest at an unchanged buildId, the layer inventory (now recording on every push run) names the source in one round trip.
- [x] **R0.4 Fill the two TOFU sentinels** (`NODE_SHA256`, `OPENRIG_TREE_SHA256` in `oci/exedev/Dockerfile`) with the measured values from the build refusal output (the gate prints the measured hash; a R0.3 publish attempt produces it — run that first), and admit any first-build reconciliations the sentinel design anticipates (license paths, `rig --version` layout, sweep adjustments) — one commit on `dev` or a fast PR, landing BEFORE R0.3's successful publish. This is commit 1 of 2: the sentinel pins move the buildId and must precede the build that produces the digest; R0.5's pin adoption is a separate, later commit because the digest does not exist until the pinned build publishes (the Dockerfile's sentinel-section comment states the same sequencing).
  - Evidence: grep finds no `MEASURE-AT-FIRST-BUILD` in the Dockerfile (`NODE_SHA256=eeaccb03…` from run 36031582204's refusal, cross-checked byte-identical against nodejs.org's SHASUMS256.txt line; `OPENRIG_TREE_SHA256=543e846b…` from run 36032367862's refusal — no external cross-check exists for an npm-resolved tree, the refusal IS the measurement, and the hash freezes ^-range resolution); `bun test tests/scripts/build-exedev-image.test.ts` green (246/246, incl. both re-pinned digests and the F-038 per-gate declared-default map). The first-build reconciliations the design anticipated, admitted on the same fast PR: (a) the engine stage's resolution-probe refusal → 7-file COPY convergence + workflow lockstep (`e2660618`); (b) the DF2.9 sweep's 10 unattributed executables → license table reconciliation, each LICENSE verified at its pinned ref (`b825949c`, `cbc4563b`). Landing as fast PR → `dev` before R0.3's publish.
- [ ] **R0.5 Adopt the pin at the three sites in ONE commit on `dev`:** `driver.ts:451` (`DEFAULT_IMAGE_REF`), `driver.ts:516` (`DEFAULT_IMAGE_BUILD_ID`), and the `build-exedev-image.test.ts` expectation — exactly the ritual the qds-live-e2e skill's "Pin adoption" section prescribes.
  - Evidence: one commit touching exactly those sites; `bun test tests/providers/ -f exedev`-scoped pin tests green; no other diffs smuggled in.
  - PROGRESS: adoption #15 (PR #287) landed `9d1822c6…`/`68fca032d53c0de6` (SUPERSEDED); adoption #16 (PR #290, `613dd6e2`) landed the sixteenth pin `02d7a0f4…`/`7fc93c21509a6d2a` (SUPERSEDED by R3-c — its healing run exposed source #2, the V8 compile cache, fixed as PR #292). **PENDING: adopt the SEVENTEENTH pin (`f73409b4b8b394f9dabb83580530ce82eda80143ddb1cadc21920c7ff062fa81` / `9a025fc31fc1bc88`, printed by run 36134427077's gate-B refusal at src_sha `aa3d7d33`) in ONE commit off `dev`: `driver.ts` `DEFAULT_IMAGE_REF` + `DEFAULT_IMAGE_BUILD_ID` + pin-history comment (sixteenth-pin entry retained, seventeenth added), and BOTH by-hand literals in `tests/providers/exedev/image-contract.test.ts`. NOT the walk literal in `tests/scripts/build-exedev-image.test.ts` (offline file-input hash ≠ image digest; already at `230ba65b…` from #292). `bun test` on image-contract + build-exedev-image + `bun run typecheck` + GitNexus `detect_changes` before commit. PR → dev, operator merges. The verify check WILL be red (pruned digest unfetchable) — by design. THE MERGE IS THE HEALING RUN and must go GREEN — that green run = R0.5's evidence AND the reproducibility proof. If it prints a digest at an unchanged buildId `9a025fc31fc1bc88`: do NOT re-pin — the layer inventory now records on every push run; diff two runs' `manifestInventory` (and, if the layer blobs survive the prune, fetch them via `gh auth token` against `https://ghcr.io/v2/.../blobs/<digest>` and diff the uncompressed tars — that chain is what found R3-c).**
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
docs/planning/2026-09-24-openrig-integration-roadmap.md — read it FIRST, top to
bottom. It is the single source of truth for what remains. Do not re-research;
the research doc (docs/planning/2026-09-23-openrig-swarm-integration-research.md,
§4/§7/§8) decisions are SETTLED. Execute the next unchecked stage with full
rigor. No shortcuts, no band-aids: every fix lands with its test, every claim
carries an artifact (commit SHA, run URL, evidence JSON), and a checkbox is
checked only when its evidence exists.

WHAT THIS PROGRAM IS (situational awareness):
QDS-Factory is a dark-factory code factory: a DAG plans work, a fleet layer
dispatches it to short-lived exe.dev boxes, a phase engine runs phases in-box,
work is harvested out-of-box and reverified, money is enforced only in QDS
(µ$-capped per-seat OpenRouter keys). We are integrating OpenRig (pinned 0.5.14
by hashed tree INSIDE our qds-exedev box image) as the S1 phase kind
`rig_swarm`: one lead + N worker Pi seats collaborating in-box on an objective,
settled by queue-closure (lead marks done → phase success), cost-attributed
per seat, torn down in finally. Remaining program stages after R0: R1 (file
I1–I8 follow-up issues) → {P0 worker-rpc hardening ∥ Q1 factory service
surface ∥ SC1 SwarmClaw fixes} → S2 (mixed runtimes) → SC2 (SwarmClaw
external_job adapter; the exactly-one-box kill test) → ADR.
The factory is the only way code enters; the DAG never approves; the cockpit
watches but never operates boxes; never trust the box.

VERIFIED POSITION (2026-09-25, verify anyway with the §0 commands):
- PRs #283, #284, #286, #287, #288, #289, #290, #291, #292 all MERGED to dev.
  HEAD ≈ cfcbe4b8.
- R0.1 ✓ R0.2 ✓ R0.4 ✓ (TOFU sentinels pinned; license table reconciled).
- R0.3/R0.5: the image reproducibility campaign converged through TWO real
  bug fixes: R3-a (npm cacache wall-clock bytes shipped; PR #288) and R3-c
  (node V8 compile cache under /tmp/node-compile-cache shipped — 12,415
  blobs, 125,790 bytes differing between same-source builds; root-caused by
  pulling the pruned runs' SURVIVING BLOBS via the ghcr registry API and
  diffing rootfs.diff_ids + uncompressed tars; PR #292 deletes + asserts).
  PR #291 added manifestInventory (per-layer digest/size) to
  publish-evidence.json so any future divergence names its layer in one
  round trip. Full chains: R0.3's two evidence blocks in this doc.
- The publish run 36134427077 printed the SEVENTEENTH pin (DESIGNED gate-B
  refusal; push pruned):
    export const DEFAULT_IMAGE_REF =
      "ghcr.io/quantum-digital-solutions/qds-exedev@sha256:f73409b4b8b394f9dabb83580530ce82eda80143ddb1cadc21920c7ff062fa81";
    export const DEFAULT_IMAGE_BUILD_ID = "9a025fc31fc1bc88";
  buildId moved 7fc93c21509a6d2a → 9a025fc31fc1bc88 legitimately (R3-c
  changed the Dockerfile, a buildId input). NEVER hand-compute a digest;
  re-extract with:
    gh run view 36134427077 --log | grep -A2 "export const DEFAULT_IMAGE"
- R0.7's tier-2 live test is DRAFTED and offline-verified (tsc, biome,
  live-coupling sweep 29/0): tests/fleet/e2e/tier2-rig-swarm.live.test.ts +
  in-box-status-poll.ts + config/rosters/r0-swarm.pipeline.json (branch
  feature/r0-live-swarm-test, commit 0ee64569 — REBASE onto current dev
  before pushing; it was cut before #291/#292 landed).

YOUR WORK, IN ORDER:
1. ADOPT THE SEVENTEENTH PIN (R0.5 completion): branch feature/r0-pin-adoption-3
   off dev; ONE commit, exactly the qds-live-e2e skill's "Pin adoption" ritual
   (.claude/skills/qds-live-e2e/SKILL.md §"Pin adoption"): driver.ts
   DEFAULT_IMAGE_REF (~:464) + DEFAULT_IMAGE_BUILD_ID (~:535) + the pin-history
   comment (add the seventeenth entry: run 36134427077 at src_sha aa3d7d33,
   the R3-c build; buildId moved because the Dockerfile changed), and BOTH
   by-hand literals in tests/providers/exedev/image-contract.test.ts (~:1397).
   NOT the walk literal in tests/scripts/build-exedev-image.test.ts (offline
   file-input hash ≠ image digest; already at 230ba65b… from #292). bun test on
   image-contract + build-exedev-image suites, bun run typecheck, GitNexus
   detect_changes before commit. PR → dev, operator merges. The verify check
   WILL be red (pruned digest unfetchable) — by design; documented dev-baseline
   failures apply (story-consistency ×2, flaky DF2.11 teardown race, #280) —
   the gate is no NEW failures. Operator has been killing CI on adoption PRs
   to save billing minutes — ask first.
2. THE MERGE IS THE HEALING RUN and it MUST go GREEN: driver.ts is excluded
   from SOURCE_PATHS so the rebuild is byte-identical at src_sha aa3d7d33 and
   gate B closes on the adopted pair. That green run = R0.5's evidence AND the
   reproducibility proof. IF IT PRINTS A DIGEST AT UNCHANGED BUILDID
   9a025fc31fc1bc88: do NOT re-pin — download both runs' publish-evidence.json
   artifacts, diff their manifestInventory (per-layer digest/size), and if the
   diverging layer's blobs survive the prune (they did for R3-c), fetch them:
     TOKEN=$(curl -s -u "biospark33:$(gh auth token)" \
       "https://ghcr.io/token?service=ghcr.io&scope=repository:quantum-digital-solutions/qds-exedev:pull" | jq -r .token)
     curl -s -H "Authorization: Bearer $TOKEN" -L \
       "https://ghcr.io/v2/quantum-digital-solutions/qds-exedev/blobs/<digest>" -o blob.gz
   then diff rootfs.diff_ids (config blob) and the uncompressed tars (layer
   blobs) — that chain found R3-c. Fix at source with a fail-closed assertion
   (#288/#292 pattern), same commit re-pin the walk literal from the test's
   own failing run, and loop.
3. R0.6 mirror: docker login ghcr.io as biospark33 (gh auth token has
   write:packages), then
     docker buildx imagetools create \
       --tag ghcr.io/quantum-digital-solutions/qds-exedev-private:build-9a025fc31fc1bc88 \
       ghcr.io/quantum-digital-solutions/qds-exedev@sha256:f73409b4b8b394f9dabb83580530ce82eda80143ddb1cadc21920c7ff062fa81
   and verify with imagetools inspect. (tier1-registry-auth needs this mirror.)
4. R0.7 LIVE ROUND — the qds-live-e2e skill is MANDATORY (env contract, no
   fakes, spend protocol, gotchas #1–#21 — read the whole skill). The test is
   DRAFTED; rebase feature/r0-live-swarm-test onto dev, resolve any drift,
   push it, then:
     export QDS_E2E_LIVE=1 QDS_E2E_TIER=2
     export QDS_EXEDEV_REPO_URL=https://github.com/Quantum-Digital-Solutions/QDS-Factory.git
     export QDS_EXEDEV_SHA=$(git rev-parse HEAD)   # must be PUSHED
     export QDS_EXEDEV_ROSTER=$PWD/config/rosters/roster.yaml
     export QDS_E2E_EVIDENCE_DIR=$PWD/_bmad-output/evidence/openrig-s1
     bun test tests/fleet/e2e/tier2-rig-swarm.live.test.ts
   QDS_EXEDEV_SHA must carry the ADOPTED pin (i.e. the dev of step 1's merge).
   UNSANDBOXED shell (gotcha #17); assert ≥1 (pass) in output (gotcha #16);
   run alone, never parallel to the suite (hard rule 4); own shell call at max
   timeout (gotcha #10). Worst-case spend ALREADY approved by the operator
   (2026-09-24: run key $1.20 ceiling + 2 seat keys × $0.50 + box-hours ≈
   $2.89 worst / ~$0.65 expected; S0 actuals $0.41) — restate the estimate
   and get an explicit fresh "go" if anything moved. The round must produce:
   rig_swarm phase settles lead-closed (journal swarm_settled), testCommand
   gate green, harvested commit, out-of-box reverify of the gate's own
   testCommand on the harvested tip, per-seat cost_attribution rows (role
   lead + worker), teardown in finally, `ssh exe.dev ls --json` empty, zero
   sbx- keys, spend ≤ caps. ALSO verify in-round: seat-keys 0600 +
   env-append idempotency (in the test), rig daemon start idempotency
   (probe-first adopt in openrig-swarm.ts), first-build sentinels (R0.4 ✓).
   Evidence JSON lands in _bmad-output/evidence/openrig-s1/.
5. R0.8: file every red as a GitHub issue with the evidence attached, BEFORE
   declaring R0 done. Green or triaged-issues, nothing between.
6. Then R1: issues I1–I8 (the durable reasoning in
   .superpowers/sdd/progress.md is git-ignored scratch — PASTE it into the
   issue bodies; the issue list with one-line summaries is in this doc §R1).
7. At session end: update the roadmap checkboxes WITH evidence, carry the doc
   in the stage's PR (or a docs PR — precedent #289 needed --admin merge;
   operator has been merging promptly).

Hard rules (roadmap §1 — never traded away):
- Factory is the only way code enters; one tier-2 brain per box; cockpit
  watches but never operates boxes; DAG never approves; money enforced only
  in QDS (seat caps are the hard limit); never trust the box.
- GitNexus impact() before editing any symbol (repo param: "QDS-Factory" —
  multiple repos are indexed); detect_changes() before every commit; tests
  ALWAYS teed to /tmp/qds-test.log and read via the CLAUDE.md tr/perl filter
  (a bare grep "(fail)" on the raw log silently matches nothing); run bun
  test from the REPO ROOT with a ./tests/... path (a relative filter from a
  stray cwd matches zero files and reads as "no failures" — burned once).
- feature/* off dev, PR target dev, operator merges; files < 500 lines.
- bun test does NOT typecheck — run `bun run typecheck` too.
- The publish workflow's gate-B refusal + prune is the RITUAL, not a failure:
  never hand-compute a digest, never adopt a digest the workflow didn't print.
- A digest that moves with an unchanged buildId is a BUG to fix at the source,
  never a re-pin.
- No fakes in live tests; keys revoked + boxes destroyed in finally; account
  baselined before and after (listedKeyHashes + ssh ls).

First action: run the §0 ritual, report the verified position to the operator,
then start at step 1 above.
```
