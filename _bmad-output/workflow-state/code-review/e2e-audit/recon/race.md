# RACE LIVE-E2E TEST-DESIGN BRIEF (T3 recon)

Repo: /Users/steve/QDS-Factory, branch `feature/df3-2-fanout-best-of-n`. Read-only recon; all file:line refs verified against this branch.

## 1. Race code path trace

- Entry `fanout()` — src/fleet/fanout-primitive.ts:253 → validate :259 → `lock.acquire()` :263 → ONE `checkHeadroom(n)` :269 → F15 budget reconcile :314-344 (refusal `issue-ceiling-insufficient` :335-343) → `FanoutRecordStore.create` O_EXCL :351 → N×`mintRunId()` sync :367 → INV-3 admitted line :381 → `runArms` :403.
- Race branch :406-413: entrants = arms with outcome `"ready"`, fixed BEFORE polling :410; `winner = runRace(...)` :411; `disposeLosers(...)` :412; `closedAt` :415; lock released in finally :422.
- **Poller** `runRace` :562-616. Interval `deps.pollIntervalMs ?? 5_000` :569 (`DEFAULT_POLL_INTERVAL_MS` :54); per-call deadline `?? 10_000` :570 (:57); ceiling `?? 3_600_000` :571 (:60). **No CLI flags exist for any of these** — a live verb always runs 5s ticks / 1h ceiling. Marker = `runMarkerPath()` direct import :572 → `/run/journal/final.json` on real boxes (src/phase-engine/journal.ts:38-45; `QDS_RUN_ROOT` is host-test-only, never set on real runs). Loop :577 probes arms **sequentially in index order** :579, sleeps `pollIntervalMs` :608; at ceiling undecided arms become `armUnknown` :611-614 and it returns null.
- **probeArm** :625-699: exec probe `sh -c 'test -f <marker>'` under `withTimeout(deadlineMs)` :642-646; nonzero exit → "absent" :647; `copyFile` to host tmp :650; JSON.parse :653; `ok:false` → arm reclassified armFailed, race CONTINUES :658-664; present-but-unparseable / non-bool ok → "unusable" :654/:665; 3 consecutive unusable ticks (`MARKER_UNUSABLE_TICKS_LIMIT` :70, counting :582-594) → armUnknown, dropped from polling AND disposal; TimeoutError/transport stall → skip tick logged `race-probe-timeout`/`race-probe-failed` :691-695.
- **Winner**: first ok:true marker wins via atomic first-writer `store.mutate` :674-681 (per-id `acquireRunLock`, src/fleet/fanout.ts:178-200). Persisted-winner adopt branch :674-688: `claimed!==arm` → event `race-lost-cross-process` :683-687, return adopted index.
- **Loser classification** `disposeLosers` :724-778: disposed = entrants − winner − armUnknown :734-736; ready slots flip to `lostRace` :750-752; an entrant whose marker said ok:false KEEPS armFailed but IS disposed; setupFailed/thrown-gate armFailed were never entrants (excluded :410), stay ALIVE (INV-5), never touched; armUnknown never touched.
- **Teardown owner: THE PRIMITIVE, not the verb** — `teardownSandbox` per loser under `withTimeout(loserTeardownTimeoutMs ?? LOSER_TEARDOWN_TIMEOUT_MS=300_000)` :762 (const :81), between `lock.markDestructive()/clearDestructive()` :759/:776, per-arm guards :760-774. Deps built from deps.driver/store/keyApi + optional costLedger :738-747.
- **DF2.8 loser ledger wiring**:
  - Verb side: `loserLedger = makeLoserLedgerHook(...)` built ONLY when pattern==="race" and no injected hook — scripts/fleet.ts:1678-1695; passed as deps.costLedger :1704; lazily opens real SQLite on FIRST ingestBoxHours (hook impl :903-928); closed in verb finally :1776-1789 (close failure downgrades exit 0→6 :1787).
  - Pricing site: teardown close step src/providers/teardown.ts:479-497, gated on extensions.budget issue attribution (`ingestBoxHoursIfAttributed` :303+); missing box-hour rate surfaces as loud TeardownError (:466-469).
- **Verb semantics**: auto-rank is best-of-n ONLY (scripts/fleet.ts:1734) — race gets no rank, rankedAt stays NULL unless `fleet rank` runs later (rank stamps rankedAt, never sets winner). Exit code :1759-1763: any setupFailed|armFailed|armUnknown → 1; winner-ready + lostRace losers → **0**.
- Cross-process adopt is unit-only today (tests/fleet/patterns.test.ts:1202-1231 plants a second FanoutRecordStore writer in onProbe). Real-substrate version needs two concurrent verbs sharing `--dir` — recommend leaving unit-covered.

## 2. Unit seams vs real-substrate equivalents (patterns.test.ts race describe :741-1326)

| Seam | Real equivalent? |
|---|---|
| pollIntervalMs/perCallDeadlineMs/ceilingMs (:58-60 TICK_MS=10/DEADLINE_MS=200; raceDeps default ceiling 800ms :743-745) | NO CLI path — live = 5s ticks, 1h ceiling. Decision latency ≥ one tick; hang bounded only by ceiling or subprocess timeout |
| Marker production plantMarker into FakeDriver box dir (:127-174) | YES: exec onto live box `mkdir -p /run/journal && printf '{"ok":true}\n' > /run/journal/final.json`. Probe/copyFile/parse/claim chain stays fully real |
| Winner targeting via driver.onProbe + derive won from plantedVm (:747-760) | Yes: box name == runId (tier2-fanout-bestofn.live.test.ts:276-278 treats them identically); arm↔roster↔runId mapping readable from the LOCAL fan record mid-run (written at primitive :351/:368) |
| setupGate injection (:322, :1029, :1074) | No CLI flag, AND a slow gate CANNOT decide the race — runRace starts only after ALL arms settle (:403→:411; comment :742). Gate delay merely postpones the start for everyone |
| costLedger spy object (:785-794) | Yes: real lazy hook + SQLite beside QDS_RUNS_DIR via ledgerRows (live-harness.ts:279-288) |
| hungProbeDriver/hangingDestroy/failingDestroy drivers (:89-107, :831, :910) | Provider-flake shaped; mitigate, don't induce |

## 3. Live test design

Only deterministic race-deciding lever = **MARKER ARRIVAL TIME**. Rejected alternatives:
- model-per-arm: impossible — race takes ONE brief expanded identically to all arms (:197-198); rosters are provenance labels only.
- setupGate delay: structurally cannot decide the race (poller starts after allSettled).

Flow (verb subprocess, T2.2 pattern, NO fakes):
1. `preflight("2")`; workspace with cost-config.json `{defaultCapMicroUsd:50000, boxHourRateMicroUsd:230000, perIssueOverrides:{"Quantum-Digital-Solutions/QDS-Factory#46": 2*cap}}` — F15 aggregate; T2.2 lines 95-102 prove the shape; omitting it = guaranteed exit-5 refusal (measured live ×2, primitive comment :302-313).
2. Brief pinned ctx.sha, manifestPath config/rosters/t2.pipeline.json.
3. Spawn WITHOUT awaiting (raw Bun.spawn — `runFleet` awaits; add harness variant returning `{proc, exitedPromise}`): `fleet fanout --pattern race --n 2 --roster lead,fixer --pin <sha> --brief … --cap-micro-usd 50000 --driver exedev --dir <fanoutsDir>`, env QDS_RUNS_DIR=<recordsDir>, hard timeout ~15-20min.
4. Poll `ctx.driver.list()` until both boxes appear; read the LOCAL fan-*.json to map arm 0 → runId (= box name). **FAST ARM := ARM 0** (index-order probing makes even a mistimed double-marker case agree on arm 0).
5. Retry-until-exit-0 (~3min hard bound): write `{"ok":true}` marker onto arm 0's box.
6. Poll the LOCAL fan record until `rec.winner !== null`; assert === 0. Exercises real probe→copyFile→parse→first-writer-claim end-to-end.
7. Best-effort: write arm 1's marker now (may lose the disposal race — harmless; classification is lostRace regardless because the flip is unconditional for non-winner ready entrants :750-752).
8. Await verb exit; expect exitCode 0.

Assertions:
- Exactly one stdout arm line outcome:"ready"; N−1 lostRace; ZERO setupFailed/armFailed/armUnknown (any of those = fail loudly, evidence names which).
- res.winner===0; record `{pattern:"race", winner:0, closedAt set, rankedAt NULL}` — contrast with best-of-n (auto-ranked → rankedAt stamped, winner null, T2.2 :178). Cheap add-on: run `fleet rank` afterwards, show rankedAt stamps while winner stays untouched.
- Boxes: winner's box still in driver.list(); losers gone. Winner NOT torn down by anyone (primitive disposes losers only) — test finally owns it: `fleet teardown <winnerRunId> --dir <recordsDir>` + destroyQuietly fallback.
- Loser records: closedAt set, spendMicroUsd ∈ (0,cap], keyHash absent from listedKeyHashes().
- **LOSER LEDGER ROWS (the DF2.8 proof)**: ledgerRows(recordsDir, `SELECT … kind='box_hours' AND run_id IN (?, ?)`) → exactly 1 row per loser, unpriced===0, cost_micro_usd>0 — through the REAL lazy hook (unit test only had a spy object).
- Aggregate money: Σ token spend ≤ 2×50,000µ$; box-hour rows priced fractionally at 230,000µ$/h.
- Evidence: exactly one fleet.fanout.race "won" event, zero race-lost-cross-process (single process); writeEvidence("t2-3-fanout-race", …).

Fallback plan B (only if marker-exec proves flaky): in-process `fanout()` call with real ExeDevDriver/OpenRouterKeyApi but injected pollIntervalMs and markers planted via driver.exec — hybrid, weaker than the verb path; document if used.

## 4. Failure modes and mitigations

1. **Fresh-box gate stall/flake** → arm setupFailed, excluded, left ALIVE (INV-5); single-entrant race still produces a winner and exit 0, but the "N−1 losers torn down" assertion breaks. Mitigation: fail loudly with evidence identifying the arm; rerun cheap (gate chat spend tiny; F10 explicit-max_tokens fix landed, commit 1f2830d).
2. **No marker ever lands** (exec-writer fails silently) → poller spins to the 1h CEILING HOLDING .sandbox/fleet.lock, both boxes billing the whole time. Mitigations: hard-bound marker retries (~3min) then abort scenario; overall subprocess kill ~15-20min; FleetLock stale-reclaim exists (age=candidate, identity decides — src/fleet/fleet-lock.ts:380+) so a SIGKILLed process's lock IS reclaimable, but prefer clean abort + finally teardown of both boxes.
3. **fleet.lock contention**: lock resolves against process cwd (.sandbox/fleet.lock relative, fleet-lock.ts:32/:361; no CLI override). Verb holds it across the ENTIRE run INCLUDING the poll window — any concurrent fleet op in this repo refuses fleet-busy. Mitigation: exclusive execution window (coordinate across session agents), prompt marker writes shrink the held window.
4. **F15/budget interactions**: missing perIssueOverrides ≥ n×cap → clean PRE-MINT exit-5 refusal (cheap, safe). Missing boxHourRateMicroUsd → loser close-step pricing throws/surfaces unpriced → ledger assertion catches. Declare both values.
5. **Timing races**: both markers present at first poll tick → still deterministic (index-order probing + fast arm = arm 0). Late arm-1 marker → harmless (classification unaffected). copyFile/probe transport stall → 10s deadline skips tick, self-heals :691-695.

## 5. Worst-case µ$ estimate (cap 50,000µ$/key, 230,000µ$/box-hour, ≤1h boxes)

- Token side hard-capped: 2×50,000 = 100,000µ$ (provider-side key caps; actual gate-chat spend lands far below).
- Box side: 2 boxes × 230,000µ$/h × t. Worst t=1h → 460,000µ$; expected t≈5-15min → ~38k-115kµ$.
- **WORST-CASE TOTAL ≈ 560,000µ$ (~$0.56); expected ≈ 140k-215kµ$ ($0.14-0.22).**
- Winner's box outlives the verb until test teardown — immediate teardown keeps its share negligible.
- perIssueOverrides covers ONLY the token aggregate (n×cap=100,000µ$); box-hour rows price separately at loser-close and count toward later budget snapshots.
