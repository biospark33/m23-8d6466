# OpenRig × QDS-Factory Integration — Program Roadmap & Session Handoff

**Status date:** 2026-09-26 · **Owner:** steve · **Research basis:** `docs/planning/2026-09-23-openrig-swarm-integration-research.md` (§4 architecture, §7 roadmap, §8 risks — that doc's decisions are SETTLED; this doc tracks execution, it does not re-open design).

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

## 2. Current-state snapshot (verified 2026-09-26)

| Piece | State | Where |
|---|---|---|
| S0 research + spike | **MERGED** (PR #283 → dev, 2026-09-24T12:32:40Z, `8fbc66bc`) | `docs/planning/2026-09-23-openrig-swarm-integration-research.md`, `_bmad-output/evidence/openrig-s0/2026-09-23-spike-s0.json` |
| S1 `rig_swarm` phase kind | **MERGED** (PR #284 → dev, 2026-09-24T16:33:04Z, `7957e8a4`) + campaign fixes through #319 | schema `src/phase-engine/{types,manifest}.ts`; body `src/phase-engine/phases/openrig-swarm.ts` + `openrig-cost.ts`; keys `src/providers/{credentials,run-record,teardown}.ts` + `src/fleet/dispatch.ts`; harvest `src/providers/harvest.ts` |
| S1 progress ledger | 8 tasks + fix waves + final review triage | `.superpowers/sdd/progress.md` (git-ignored scratch — its content is summarized in PR #284 body; copy anything durable into issues/docs) |
| S1 image | **PIN CLOSED at the twenty-sixth pin** `6fd78181…`/`85d75d0ccbfb259a` (PR #316); healing + post-#317 publishes GREEN; `OPENRIG_TREE_SHA256` re-measured 41e10c9a… (#314) after upstream ^-range drift; mirror re-pushed | `oci/exedev/Dockerfile`, `src/providers/exedev/driver.ts`, `scripts/build-exedev-image.ts` (walk literal `9f55e706…`, PR #318) |
| Live-round test | **T2.8 GREEN** 2026-09-26 (`qds-20260926-0532c5`, 5-round campaign, all reds root-caused + fixed: #312/#313, #315, #317, #319, #318) | `tests/fleet/e2e/tier2-rig-swarm.live.test.ts` + `in-box-status-poll.ts` + `config/rosters/r0-swarm.pipeline.json`; evidence `_bmad-output/evidence/openrig-s1/` |
| Pre-existing dev test failures | 16 (vendor self-compact, story-consistency) + 2 flaky wall-clock tests + GitHub #280 (pi handoff-return) | NOT this program's bugs; do not fix here, do not count them against stage gates (I5 owns the wall-clock pair) |
| Follow-up issues | R0.8: #320, #321 · R1: I1–I8 = #322–#329 | owner stages on each |

---

## 3. Stages

Order and dependencies: **R0 → R1 → {P0 ∥ Q1 ∥ SC1} → S2 → SC2 → ADR**. R0 gates everything live. SC2 needs S1+P0+Q1+SC1. Do not start SC2 early "because the pieces are mostly there" — the exactly-one-box kill test is the point.

---

### Stage R0 — S1 completion: merge, image adoption, first live `rig_swarm` round

**Status:** ✓ COMPLETE 2026-09-26
**Depends on:** PR #283 + #284 merged to `dev`.

- [x] **R0.1 Merge PR #283** (S0 docs/spike/evidence) into `dev`.
  - Evidence: PR state MERGED 2026-09-24T12:32:40Z; merge commit `8fbc66bc` on `origin/dev`; research doc present on `dev`.
- [x] **R0.2 Merge PR #284** (S1) into `dev`.
  - Evidence: PR state MERGED 2026-09-24T16:33:04Z; merge commit `7957e8a4` on `origin/dev`; carries `0044e62d`.
- [x] **R0.3 Publish the image from `dev`** via the existing workflow. It refuses feature branches — this is why R0 waits for merge. **BLOCKED BY R0.4**: every build refuses at `NODE_SHA256`/`OPENRIG_TREE_SHA256` until the sentinels carry measured values. The refusal mechanism IS the measurement step: run this workflow once, read the gate's refusal output (it prints the measured hashes), pin them in R0.4, then publish here.
  - Evidence: workflow run URL + printed `DEFAULT_IMAGE_REF` digest + `DEFAULT_IMAGE_BUILD_ID`, from the post-R0.4 run (the pre-pin run's refusal output is R0.4's measurement evidence).
  - Measurement-chain record (all on `feature/r0-image-convergence`, dispatched dry runs): run 36028156132 (merge push) refused at the ENGINE probe — S1's phase bodies import `src/providers/credentials.ts`, the engine COPY enumeration lacked it and its provider closure (7 files; bun resolves before tree-shaking, so sourcemap closures under-report) — fixed in `e2660618` with both workflow lockstep lists + same-commit re-pin of the per-asset Dockerfile sha and the whole-walk digest (the latter already stale at the S1 merge, verified against clean HEAD). Run 36031582204 then refused at the node gate; run 36032367862 cleared node and refused at the tree gate; run 36033368044 cleared both TOFU gates and refused at the license sweep (10 nested `@openrig/cli` dep executables — reconciled in `b825949c`/`cbc4563b`); run 36037302102 passed EVERY gate and ended at the designed dry terminal state: buildId `7ab13076ccec247c` measured at `cbc4563b`, digest withheld by design until a real push.
  - PUBLISH HISTORY (2026-09-24): run 36048175927 (first real publish, src_sha `07db7e3e`) pushed `9d1822c6…` / buildId `68fca032d53c0de6`, gate B refused pre-adoption → **workflow pruned the digest by design** and printed the paste-ready pair. Adoption #15 merged as PR #287 (`e3500764`). The healing run 36056831164 then pushed a THIRD digest `b090c2a7…` with an UNCHANGED buildId — the exact case the gate's text says to FIX, not re-pin. Root-caused via the runs' own evidence artifacts (identical buildId/builtAt/gitSha/piSha256/sweep/NOTICE; `imageSizeBytes` ±12 compressed bytes): **npm's `/root/.npm` cacache ships wall-clock bytes** (`time`, `resHeaders.date`, etags), invisible to every gate. Fixed in PR #288 (`55215f51`): cache+logs redirected to /tmp, deleted same-layer, fail-closed assertions on `/root/.npm`+`/root/.npmrc`.
  - PUBLISH HISTORY CONTINUED (2026-09-24/25, the R3-c chapter): run 36063335634 (post-#288, src_sha `55215f51`) printed the SIXTEENTH pin (`02d7a0f4…`/`7fc93c21509a6d2a`); adopted as PR #290 (`613dd6e2`). Its healing run 36077483206 printed a digest at an UNCHANGED buildId AGAIN (`8928a265…`, +48 compressed bytes) — billing did NOT cause it (full 9m13s run, gate B refused on merits). Diagnosis by exhaustion (npm exonerated by #288's own assertion; pi updater proven content-deterministic via full-fs hash diff ×2 in the pinned base; bun frozen-lockfile leaves NO cache; builder buildkit image `buildx-stable-1` unmoved since 2026-08-12; local micro-probe reproduced the CLASS — RUN wall-clock content moves the digest, `rewrite-timestamp` covers mtimes only). Both CI manifests were pruned before layer-level forensics → PR #291 (`2b29e804`) added `manifestInventory` (config + per-layer digest/size) to publish-evidence.json so the NEXT divergence names its layer. Two dispatched runs (36082995077 `f9df4a03…`, 36084574659 `b268d776…`) diverged in EXACTLY ONE layer (#59, the openrig npm install RUN, +9 bytes). Registry prune had deleted the manifests but the BLOBS survived: config blobs → `rootfs.diff_id[59]` differs (tar bytes genuinely differ); layer blobs pulled via the registry API → forensic diff: **12,415 tar entries of `/tmp/node-compile-cache/v22.20.0-x64-…` — node's V8 compilation cache — 125,790 uncompressed bytes differing**, while the RUN's own `/opt/openrig` tree gate (`543e846b…`) passed on every run. Writer: the RUN's own `npm i` + `rig --version` node executions; npm cache/logs were cleaned, the compile cache never was. Control: a local double build of the exact node+npm sequence under the `qds-repro` builder produced IDENTICAL manifests. Fixed in PR #292 (`aa3d7d33`, R3-c): delete `/tmp/node-compile-cache` in the same RUN + fail-closed assertion naming the measurement; Dockerfile walk literal re-pinned from the test's own failing run (`ef691e7f…` → `230ba65b…`). Run 36134427077 (post-#292) printed the **SEVENTEENTH pin — `f73409b4…` / buildId `9a025fc31fc1bc88`** (both moved: the Dockerfile is a buildId input, a legitimate substrate change). Its adoption + GREEN healing run are R0.3/R0.5's remaining work; if the healing run prints yet another digest at an unchanged buildId, the layer inventory (now recording on every push run) names the source in one round trip.
  - PUBLISH HISTORY CONTINUED (2026-09-26, the R0 closeout): pins 17–24 were adopted in sequence through the live-round campaign (18th R0.7 swarm-fixes build, 19th rigspec-shape, 20th + walk literal, 21st import-adopt, 22nd qitemId, 23rd queue-show-parse, 24th trace-stderr — each with its healing run green). Run 36254811811 (post-#314, which re-pinned `OPENRIG_TREE_SHA256` 543e846b… → 41e10c9a… after upstream npm ^-range drift inside `@openrig/cli@0.5.14` moved the /opt/openrig tree) printed the **twenty-fifth pin (`b10112df…`/`da57d8c95005de7d`)** — superseded within the hour and never adopted (bytes pruned, pulled by nobody). Run 36256066937 (post-#315) printed the **twenty-sixth pin (`6fd78181…`/`85d75d0ccbfb259a`)**; adopted as PR #316, healing run 36257750804 GREEN (publish + attest), and the post-#317 run 36261862644 stayed GREEN at the same src_sha (scripts/fleet.ts is outside SOURCE_PATHS). **R0.3's publish chain is CLOSED: three consecutive green builds at one pin.**
- [x] **R0.4 Fill the two TOFU sentinels** (`NODE_SHA256`, `OPENRIG_TREE_SHA256` in `oci/exedev/Dockerfile`) with the measured values from the build refusal output (the gate prints the measured hash; a R0.3 publish attempt produces it — run that first), and admit any first-build reconciliations the sentinel design anticipates (license paths, `rig --version` layout, sweep adjustments) — one commit on `dev` or a fast PR, landing BEFORE R0.3's successful publish. This is commit 1 of 2: the sentinel pins move the buildId and must precede the build that produces the digest; R0.5's pin adoption is a separate, later commit because the digest does not exist until the pinned build publishes (the Dockerfile's sentinel-section comment states the same sequencing).
  - Evidence: grep finds no `MEASURE-AT-FIRST-BUILD` in the Dockerfile (`NODE_SHA256=eeaccb03…` from run 36031582204's refusal, cross-checked byte-identical against nodejs.org's SHASUMS256.txt line; `OPENRIG_TREE_SHA256=543e846b…` from run 36032367862's refusal — no external cross-check exists for an npm-resolved tree, the refusal IS the measurement, and the hash freezes ^-range resolution); `bun test tests/scripts/build-exedev-image.test.ts` green (246/246, incl. both re-pinned digests and the F-038 per-gate declared-default map). The first-build reconciliations the design anticipated, admitted on the same fast PR: (a) the engine stage's resolution-probe refusal → 7-file COPY convergence + workflow lockstep (`e2660618`); (b) the DF2.9 sweep's 10 unattributed executables → license table reconciliation, each LICENSE verified at its pinned ref (`b825949c`, `cbc4563b`). Landing as fast PR → `dev` before R0.3's publish.
- [x] **R0.5 Adopt the pin at the three sites in ONE commit on `dev`:** `driver.ts:451` (`DEFAULT_IMAGE_REF`), `driver.ts:516` (`DEFAULT_IMAGE_BUILD_ID`), and the `build-exedev-image.test.ts` expectation — exactly the ritual the qds-live-e2e skill's "Pin adoption" section prescribes.
  - Evidence: one commit touching exactly those sites; `bun test tests/providers/ -f exedev`-scoped pin tests green; no other diffs smuggled in.
  - PROGRESS: adoptions #15–#24 landed sequentially through the campaign (PRs #287, #290, #295-series, #306, #309, #311 — final: `ed1714e2…`/`b8e0c53589faadec`, the trace-stderr build). CLOSED by the **twenty-sixth pin**: PR #316 (`6fd78181…`/`85d75d0ccbfb259a`, gate B run 36256066937 at src_sha `3475d77a`); healing run 36257750804 GREEN (publish + attest) — reproducibility proven. Note recorded in the pin history: the intervening twenty-fifth pin (post-#314 tree re-pin) was printed and pruned, never adopted. Post-close defect found + fixed: #316's docs follow-up silently dropped the offline walk-literal re-pin from its staging (healing stayed green because scripts/fleet.ts is outside SOURCE_PATHS) — re-landed as PR #318 with the digest re-measured on the clean tree (`9f55e706…`).
- [x] **R0.6 Re-push the private mirror** (per the qds-live-e2e skill).
  - Evidence: `docker buildx imagetools create --tag …qds-exedev-private:build-85d75d0ccbfb259a …qds-exedev@sha256:6fd78181…` (2026-09-26); `imagetools inspect` resolves the inner manifest `sha256:6fd78181…` linux/amd64.
- [x] **R0.7 Run the paid live round** under `qds-live-e2e`, tiers scoped to `rig_swarm`:
  - Worst-case spend estimate printed ($1.20 run + 2×$0.50 seats + box-hours ≈ $2.89); operator "go" given 2026-09-26 (extended in-session for the full sequence).
  - GREEN on 2026-09-26, run `qds-20260926-0532c5` (attempt 5 of the campaign; evidence `_bmad-output/evidence/openrig-s1/2026-09-26-195520-t2-8-rig-swarm-r0e6o0.json`, image `85d75d0ccbfb259a`): swarm settled lead-closed + `timeoutFallback:false`; mirror rows in `<runId>.engine.log`; harvest + out-of-box reverify `marker-test-passed`; per-seat ledger token rows PRICED with `unpriced:0` (lead $0.061 / worker $0.034); run spend $0.098 ≤ $1.20; teardown exit 0; `ssh exe.dev ls --json` empty; zero `sbx-` keys post-round; env-append + 0600 asserted in-test; rig daemon idempotency probed (probe-first adopt landed in #295's series).
  - Campaign trail (rounds 19–22-attempt-4 red, each root-caused and fixed before the next spend): 0 settled rows → mirror-rides-tee (#312/#313) + fill predating it; 0 priced rows → parser vs pi 0.84.4 real JSONL (#315); teardown unwired for swarm records → key client wiring (#317); ledger attribution refused → INV-COST-5 seat-trio resolution (#319); walk literal dropped by a mis-staged commit → re-landed (#318).
- [x] **R0.8 File the live-round gaps** (if any) as issues BEFORE declaring R0 done. The stage is done only when the round is green or every red has a filed, triaged issue with a named owner stage.
  - Evidence: #320 (seat-key revoke retry + swarm-aware harness fallback + evidence tail truncation), #321 (walk-literal staging made mechanical). Every other campaign red landed FIXED with its fix PR rather than deferred.

**Definition of done (stage):** R0.1–R0.7 checked with artifacts; S1 declared complete on `dev`; image pin adopted; live evidence committed. ✓ STAGE COMPLETE 2026-09-26.

---

### Stage R1 — file the deferred follow-up issues (fast, do immediately after R0)

**Status:** ✓ COMPLETE 2026-09-26
**Depends on:** R0 (issue list final after the live round).

One issue each, with the context from `.superpowers/sdd/progress.md` + final review (reproduce the reasoning in the issue body — the scratch ledger dies with the machine):

- [x] **I1** (#322) `usdToMicros`: no `isSafeInteger` overflow guard — a finite USD > ~1.8e302 overflows to Infinity µ$ (guard belongs in `usdToMicros`, one place, all callers; `credentials.ts`).
- [x] **I2** (#323) `mintRunKey` symmetric guard: a record carrying BOTH `keyHash` and `extensions.swarmSeats` is unreachable today but unguarded — `swarmed && !keyed`-style hardening in teardown gates + mint-side refusal (Task 6 review, shape-D).
- [x] **I3** (#324) `openrig-swarm.ts` costing reads only the LARGEST session JSONL per seat — multi-session seats undercount; `reportSpendDivergence` is the current safety net; sum all matched files instead. *(Updated 2026-09-26: with #315's parser the seats price real turns — the undercount now moves real money figures.)*
- [x] **I4** (#325) PLAN REVISION (before S2): a `rig_swarm` manifest without `testCommand` + timeout-fallback records `success` on an unverified swarm. Either require `testCommand` on `rig_swarm` in the schema, or warn/refuse at dispatch. Needs an explicit operator decision (schema change vs dispatch warning) — do not just pick one.
  - RESOLVED 2026-09-27: operator chose **schema-required `testCommand`**. Record: the "records success" half was already fail-closed — timeout-fallback settles `fail` since `f9221be6` (PR #284 BMad round); the schema change makes the gate-less manifest *unrepresentable* at authoring instead. PR #346 (commit `25097c99`, RED-first: `rig_swarm without testCommand is refused at load` watched failing → one required-set entry + 3 schema-path fixture updates).
- [x] **I5** (#326) Flaky wall-clock test assertions (`toBeGreaterThanOrEqual(90)` class) — two load flakes observed 2026-09-23/24; isolate and deflake or mark tier-gated.
- [x] **I6** (#327) Duplicate-member-id diagnostics (schema refuses via the indirect seatBudgets message; dedicated duplicate-id issue would name the real problem).
- [x] **I7** (#328) `emitSeatCosts` return value discarded by the caller (doc/usage mismatch — log the seat total or drop the contract).
- [x] **I8** (#329) Harness nits batched: `makeTempHome` temp-dir leak; `tracer.close()` outside try/finally in 2 pipeline-run tests; factory tests cannot discriminate executor vs the (now-deleted) interim arm — add `expect(body.name).toBe("gated")`; mergeSweeps doc-comment overstates dedup invariant; dead multi-site merge branch in `extractNodeModules`; harvest strip-line escaping inconsistency.

**Definition of done (stage):** issues I1–I8 open with full context pasted in (scratch ledger quoted); each labeled with its owner stage. ✓

---

### Stage P0 — worker-rpc hardening (independent of OpenRig; blocks SC2)

**Status:** ✓ COMPLETE 2026-09-26
**Branch:** `feature/p0-worker-hardening` → PR #331 (the `feature/rpc-worker-handoff` branch was closed unmerged as PR #282 and deleted; the transport was recovered verbatim from its head `d0ba1bfa` — recovery and hardening as separate commits).
**Size:** ~120 LOC + 14 tests. **Research ref:** research doc §2.5 (bug list verbatim there).

Scope (all in `cli-anything/scripts/worker-rpc.ts` on that branch):

- [x] **P0.1** Prompt error ignored: pi returns `error(id,"prompt")` → no `agent_settled` ever arrives → worker hangs until `timeoutMs`. Fix: treat prompt-error as settle-with-failure. Test: injected error frame settles the worker, no timeout relied on.. Evidence: PR #331 (merged 2026-09-26) — prompt-error settle; pi 0.84.4 has no live prompt-error trigger (trap 6), unit-guarded only.
- [x] **P0.2** `get_state` failure treated as idle (fail-open): shutdown proceeds while a compaction may be in flight. Fix: fail-closed — a failed `get_state` aborts shutdown (or retries with bound). Test: get_state fault injected → shutdown refuses.. Evidence: PR #331 — fail-closed drain with bounded retry.
- [x] **P0.3** Spawn-error path skips `finish()`: timers leak; a later SIGKILL can still fire. Fix: finish() in finally on the spawn-error path. Test: spawn error → no live timers after settle (leak assertion).. Evidence: PR #331 — error-path cleanup.
- [x] **P0.4** No re-arm on `compaction_end` / `auto_retry_end` after a failed compaction (possible — confirm first; if confirmed, fix + test; if not reproducible, write the probe test that proves it and check the box with the negative result).. Evidence: PR #331 — compaction_end re-arm implemented.
- [x] **P0.5** Env allowlist: workers currently receive the whole `process.env`. Harden to an explicit allowlist (mirror the daemon-side allowlist discipline; the OpenRig `pi-runner-protocol.ts` patterns are the reference for the protocol handling ONLY).. Evidence: PR #331 — env allowlist.
- [x] **P0.6** `drainReason` on each result + opt-in session file for resume.. Evidence: PR #331 — drainReason + extraArgv.
- [x] **P0.7** DO NOT adopt OpenRig's `readline` JSONL framing — it splits on U+2028/U+2029 (legal inside JSON strings). If framing is touched at all, frame on `\n` only, with a test carrying a U+2028 inside a string payload.. Evidence: PR #331 — U+2028 framing test.
- [x] **P0.8** One live round to prove the hardened worker end-to-end (qds-live-e2e rules; this touches real pi processes but no OpenRig spend — still a real box).. Evidence: live round GREEN (qds-20260926-40be2a) — two real `pi --mode rpc` workers drained get-state-idle, spend 280 µ$ ≤ 50_000; evidence `_bmad-output/evidence/openrig-s1/2026-09-26-*-p0-8-worker-rpc-*.json`; follow-ups PRs #341/#342.

**Definition of done (stage):** branch rebased, TDD'd fixes with the tests above green, full suite no-new-failures, detect_changes reviewed, PR to `dev`, live round evidence committed.

---

### Stage S2 — mixed runtimes (Claude/Codex seats via OpenRouter)

**Status:** ◐ IN PROGRESS (2026-09-27) — S2.1/S2.4/S2.5 merged; S2.2/S2.3 delivery landed in-repo (image pin adoption + live proof at S2.6); per-runtime cost-row parsers still owed BEFORE S2.6 (the stage DoD demands per-seat per-runtime cost rows; `openrig-cost.ts` parses the pi JSONL shape only).
**Depends on:** R0 (live rig_swarm baseline) + I4 (RESOLVED, PR #346). **Size:** small→medium. **Research ref:** §5.2, §5.5 (per-runtime cap mechanisms table), §9a finding on coms identity.

- [x] **S2.1** Coms identity fix (~2 lines): identity falls back to `pi.getSessionName()` with `@`→`_` (runner strips `--cname` + `PI_COMS_*`). Test at the adapter level.
  - Evidence: PR #347 (merged `38b010f9`) — `resolveDesiredAgentName` in coms-core.ts (the local shared layer), chain flag > frontmatter > session name (`@`→`_`) > unchanged random default; coms-net deliberately not adopted (relay always has explicit `--cname`), DIVERGENCE.md row per ledger rules. RED-first: 9 tests, 57/57 vendor suite, 140/140 vendor+smoke.
- [x] **S2.2** Claude Code seats: `ANTHROPIC_BASE_URL=https://openrouter.ai/api` + `ANTHROPIC_AUTH_TOKEN=<seat key>` + `ANTHROPIC_API_KEY=""` in a per-seat env — requires the OpenRig member-env patch (~5 lines at `node-launcher.ts:132`, an UPSTREAM file — we do not fork; carry it as a pinned-tree patch in the image build with its own hash-gate, same species as the self-compact copy) OR a per-seat `CODEX_HOME`/settings approach where the patch proves worse. Decide with evidence; record the decision in the research doc's §5.5 table.
  - Decision (2026-09-27): **the pinned-tree patch**, recorded in research §5.5. Evidence: daemon `launchSessionEnv` hard-codes one shared `HOME`/`CODEX_HOME` (startup.js:385); daemon Node type carries NO env field (types.d.ts:27); claude adapter hard-codes its launch command via sendText (claude-code-adapter.js:231 — nothing to prefix); codex `env_key` resolves from the shared process env. The one merge point is `NodeLauncher.launchNode`'s openRigEnv → tmux session env.
  - Implementation: `oci/exedev/openrig-patches/member-env.mjs` — self-verifying applier (anchor-match, double-apply refusal, marker + load check), applied in-image BEFORE the `OPENRIG_TREE_SHA256` measurement so the patched bytes ARE the pinned identity. Consumes `$OPENRIG_HOME/member-env.json` (keyed node logicalId `<pod.id>.<member.id>`, written by the phase body pre-import, torn down with the key material; `OPENRIG_*` keys + non-strings stripped).
  - Image pin adoption: pending — batched into the already-pending walk-digest re-pin ritual at S2.6 (coms-core #347 + this patch both move the digest; the walk-digest red predates both).
- [x] **S2.3** Codex seats: `model_providers.openrouter` in per-seat `CODEX_HOME`; user-level config; Responses API only.
  - Evidence: same PR — per-seat `CODEX_HOME=$OPENRIG_HOME/state/codex/<session>/home` with `config.toml` (`model_providers.openrouter`, `base_url …/api/v1`, `env_key = "OPENROUTER_API_KEY"`, `wire_api = "responses"`, 0600) + the key delivered as that seat's env var via member-env.json. Teardown removes the CODEX_HOME tree with the other key material.
- [x] **S2.4** Schema: allow `runtime: "claude" | "codex"` in `RigMemberSpec`; per-seat key delivery extends `deliverSeatKeys` (seat→key map already seat-agnostic; the SEAT DIR layout differs per runtime — document each layout in `openrig-swarm.ts`).
  - Evidence: PR #348 (merged `2bfc3c87`) — enum widened, layouts documented at the seeding site; delivery implemented in the S2.2/S2.3 PR (pi auth.json | claude env-only | codex CODEX_HOME; member-env.json writer RED-first tested, 0600, absent for all-pi rigs).
  - CodeRabbit round 1 on #348 verified valid and fixed (c612f907): the S2.4 gate originally threw INSIDE the try, so a refusal entered the finally and ran rig-scoped teardown (`rig down --delete --force`) for a rig the invocation never imported — hoisted above the try, RED-first (test now asserts no `rig down`/`tmux` calls on refusal).
- [x] **S2.5** Mixed-cap guard: keep Σ seat caps ≤ ceiling for MIXED runtimes (caps table §5.5 — Claude Max/ChatGPT Pro subscription seats are FORBIDDEN in capped runs; enforce by refusing non-OpenRouter runtimes at the schema or dispatch level).
  - Evidence: PR #348 — the closed enum IS the refusal (schema-first posture, consistent with the I4 decision): every admitted runtime carries a per-seat OpenRouter key cap; a subscription-auth runtime is unrepresentable at authoring. Regression witness: `claude-max` refused before AND after the enum swap.
- [ ] **S2.6** Live round with a mixed rig (≥1 claude seat + ≥1 pi seat), full teardown/caps evidence as R0.7. Gate: per-runtime cost-row parsers land first (DoD demands per-seat per-runtime cost rows) + image pin adoption ritual (batched walk-digest re-pin).
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

**Status:** ◐ IN PROGRESS — bugs 0–3 + SC1.5 landed on fork dev (PRs [#625](https://github.com/Quantum-Digital-Solutions/swarmclaw/pull/625) merge `ab067804`; SC1.5 PR [#629](https://github.com/Quantum-Digital-Solutions/swarmclaw/pull/629)); pin bump MERGED (solstice-ai#454, `c12eeb2b`); SC1.6 remains (lands with SC2).
**RE-TARGETED 2026-09-27:** the buildout is **zeropoint** (product rename of solstice; not a separate repo). Target tree = the swarmclaw submodule `Quantum-Digital-Solutions/swarmclaw` **pinned `ab259667`** in `solstice-ai` (`~/solstice/external/swarmclaw`) — 502 commits AHEAD of scratch commit `45d3376b` (ancestor). Drift check across those commits: `protocol-run-lifecycle.ts` and `runtime/queue/core.ts` byte-identical, `protocol-normalization.ts` +1 unrelated line — all four bugs re-confirmed live at the pin before fixing. NOT the `biospark33/swarmclaw` fork at `45d3376b` this row originally named.
**Depends on:** none (parallel). **Hard cap: 2 weeks** — if the scheduler fix overruns, drop SwarmClaw as host and build the ~300-line sequential runner in QDS behind the same submit/result/cancel contract (Q1 carries over either way; escape hatch per research §8).
**Research ref:** §3.2 — bugs confirmed by executable tests at scratch commit `45d3376b` (worktree removed; the failing tests must be RE-CREATED first).

- [x] **SC1.0** Re-create the executable failing tests for bugs 0–3 (they died with the scratch worktree; the evidence table below is the spec).
  - Evidence: `src/lib/server/protocols/protocol-wake-dispatch.test.ts` on `feature/sc1-protocol-wake-fixes` (commit `cf1b0763`) — 4 tests, subprocess-per-test via `runWithTempDataDir`, real engine flow (createProtocolRun → requestProtocolRunExecution → task terminal → wake), only agent turns injected. All 4 watched RED first: bug 0 failed on the normalization drop itself; bugs 1–3 initially red **via bug 0** (wake no-oped), went individually red for their own reasons after the bug-0 fix.
- [x] **SC1.1** Bug 0: `normalizeProtocolRun` drops `phaseState.dispatchedTaskId` (`protocol-normalization.ts:534-547`) → a run with a dispatch step never wakes. Fix: carry the field through normalization (one line).
  - Evidence: one line added to the phaseState block; type `ProtocolRunPhaseState` already declared the field. Note: the drop happened at EVERY persist (persistRun normalizes on save), which is why dispatch runs were permanently stranded. PR #625 (MERGED `ab067804`).
- [x] **SC1.2** Bug 1: wake path advances the run even when the task `failed`/`cancelled` (`protocol-run-lifecycle.ts:103-129`; queue wakes only on success, `runtime/queue/core.ts:1690`) → linear run with a failed task shows `completed` and downstream steps ran. Fix: fail the run/step on non-completed status; wake from the queue's failure branches.
  - Evidence: wake now fails the run + stepState entry (`lastError` names the task status) and syncs the parent; queue wakes from cancelled + failed branches via shared `wakeLinkedProtocolRun` helper (retry/`queued` branch deliberately does NOT wake). RED→GREEN captured in bug-1 test (RED showed `got: completed`). `a2a_delegate onFailure: 'advance_with_warning'` verified unaffected — it completes the task before waking. Deliberate gap: no end-to-end queue-integration test (processNext has no executor seam; live-provider execution needed) — wiring mirrors the proven success-branch pattern; follow-up harness issue to file at merge.
- [x] **SC1.3** Bug 2: DAG-mode wake skips `finishStep` → `currentStepId=null` → `completeProtocolRun` fires early. Fix: wake through `finishPhase`; refuse completion while any step is running.
  - Evidence: DAG-mode wake routes through `finishPhase` (finishStep records completion + recomputes readiness); `completeProtocolRun` gained a guard refusing completion while any stepState entry is `running` (warning event, run stays schedulable). Verified: all 4 callers of completeProtocolRun checked (complete-step path finishes its own step first; DAG path pre-checks allCompleted). PR #625.
- [x] **SC1.4** Bug 3: DAG mode runs only `readyStepIds[0]`; one waiting step pauses the whole run (`:382-404`) → a join never runs while another root waits. Fix: keep the run `running` while other steps are ready; key dispatch state per step.
  - Evidence (partial scope, stated): deps-based DAG joins previously ALWAYS threw "could not resolve its parallel source step" — a join with `dependsOnStepIds` all completed now finishes via `finishStep` + `join_completed` event. Sibling-root starvation through the wake seam is fixed (bug-3 test: r1 dispatch-waits, r2 executes, join runs, run completes). **Remaining for SC1.5:** the live window between dispatch and wake still parks the whole run (scheduler picks `readyStepIds[0]`, dispatch sets `waiting`), and `phaseState` is a single slot — concurrent dispatches still need per-step dispatch keying.
- [x] **SC1.5** Scheduler: a long step must not pause the run (the lease/dwell fix behind bug 3's symptom). **Refined scope 2026-09-27:** (a) in DAG mode, a dispatch parking the run must not stop sibling ready steps from executing before the wake; (b) per-step dispatch state keying so two dispatch steps can be outstanding; (c) wake must then match dispatch state per step. Own RED tests first (concurrent-dispatch scenario).
  - Evidence: swarmclaw PR [#629](https://github.com/Quantum-Digital-Solutions/swarmclaw/pull/629) (branch `feature/sc1.5-dag-dispatch-keying` off `ab067804`, commits `b1ccb1d9` + CodeRabbit-round fixes `dc2b5c13` + BMad 3-layer adversarial-review fixes `043d6da5`). (a) The three dispatch processors (`dispatch_task`, `dispatch_delegation`, `a2a_delegate`) in DAG mode write `stepState[step.id].dispatchedTaskId` and keep the run `running`; `runProtocolRun`'s loop parks itself (ready=0 ∧ running entry carries a dispatch key) instead of breaking the run — crash-leftover `running` entries WITHOUT a key keep the existing stuck handling. Cursor-mode `waiting`/`phaseState` park unchanged. (b) `ProtocolRunStepState.dispatchedTaskId` added; `normalizeStepState` carries it (persistRun normalizes every save — the bug-0 drop class). (c) wake guard admits `running` runs, matches the dispatch per stepState entry, resolves the phase from the matched step; recovery scans stepState in both the `running` and `waiting` branches. BONUS race found by the RED test: two task terminals in one drain dropped the second wake's re-enqueue (`pendingRunIds` dedup) and stranded a ready join forever — wakes now retry the re-enqueue (bounded 200×25ms; dedup guarantees no overlap with an active loop). CodeRabbit round (2 Majors, both verified valid, fixed `dc2b5c13`): (1) agent-turn processors' stale-snapshot persists could erase a mid-await dispatch wake — `collectResponses` + `processFacilitatorArtifactPhase` + `processEmitTasksPhase` now merge onto the latest run and bail on terminal (reachable only since SC1.5 un-parked siblings; RED: `completed-then-erased`); (2) recovery first-match woke only the first terminal dispatch and wedged dual-dispatch restarts — now wakes every terminal per-step dispatch (RED: run stuck `running`). BMad round 2 (blind-hunter/edge-hunter/acceptance-auditor subagent layers, all findings code-verified, 11 patched incl. LOWs — strongest: a DAG wake force-resumed a run held on an operator `wait` step; RED-verified `got: running`; triage sidecar `_bmad-output/workflow-state/code-review/pr629-r2/triage.json`). Tests: `protocol-dag-dispatch-keying.test.ts` 6 subprocess-per-test tests (concurrent dispatches, failure semantics, recovery-all-dispatches, wake-vs-collect erase, wait-hold preservation, delegation keying), each RED-verified against its fix; SC1 wake suite 6/6 (park predicates widened to accept `running` parks); full verification 14 protocol + 4 queue suites × 2 rounds = 219/224 and 217/224, failures confined to the baselined pre-existing families (`outcome-notify`, `task-followups` — load-sensitive, green in isolation, outcome-notify ×4 reproduced at clean `ab067804` via stash, zero import-closure overlap with changed symbols); ESLint clean on touched files.
- [ ] **SC1.6** Blocking risk (adversarial-review finding): the 120 s lease vs minutes-long dispatch — lease expiry → recovery re-runs the step → SECOND BOX + SECOND KEY. Mitigation lands with SC2's persist-request-id-before-submit + Q1's idempotent submit; SC1 documents the dependency and adds the regression test at the SC2 seam. *(Progress note: bug 1's fix means a lease-expiry re-run that fails can no longer false-complete, and the complete-guard blocks success-over-unfinished-work — but the double-box risk itself is untouched until SC2/Q1. **SC1.5 landed the seam**: per-step outstanding-dispatch state (`stepState[id].dispatchedTaskId` + the loop's park condition) is exactly what SC2.6's lease-regression test codes against.)*

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
| I4 | gate-less `rig_swarm` timeout-fallback records success — RESOLVED 2026-09-27: schema-required `testCommand` (operator decision, PR #346) | done |
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
the research doc (docs/planning/2026-09-23-openrig-swarm-integration-research.md)
decisions are SETTLED. Execute the next unchecked stage with full rigor: every
fix lands with its test, every claim carries an artifact, a checkbox is checked
only when its evidence exists.

VERIFIED POSITION (2026-09-26, verify anyway with the §0 commands):
- R0 is COMPLETE: PRs #283–#319 merged; image pin closed at the twenty-sixth
  (6fd78181…/85d75d0ccbfb259a, PR #316); mirror re-pushed; T2.8 live round GREEN
  (qds-20260926-0532c5, evidence under _bmad-output/evidence/openrig-s1/).
- R1 is COMPLETE: follow-up issues #320–#329 filed (R0.8 + I1–I8).
- The T2.8 campaign reds and their fixes, for context: mirror-rides-tee
  (#312/#313), pi-0.84.4 session-JSONL parser (#315), teardown key-client wiring
  (#317), swarm INV-COST-5 ledger attribution (#319), walk literal (#318).
- OPENRIG_TREE_SHA256 is 41e10c9a… (re-measured #314) — upstream ^-range drift
  inside @openrig/cli@0.5.14 moved it once; it can move again. The refusal IS
  the measurement; also snapshot the dependency versions at each re-pin.

YOUR WORK: the first unchecked stage below — {P0 ∥ Q1 ∥ SC1}, then S2 → SC2 →
ADR. #325 (I4 gate-less rig_swarm fallback) needs an OPERATOR DECISION before
S2. Hard rules in §1; live money/boxes under the qds-live-e2e skill only.
```
