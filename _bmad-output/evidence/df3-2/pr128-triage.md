# PR 128 Review Triage Ledger

Round: 1 · Date: 2026-08-23 · Diff: origin/main...HEAD (15 files, +4892/−104, 5371 diff lines)
Chunks (raw `wc -l` of each pathspec-split `git diff -- <paths>` file; per-file diff headers INCLUDED, files outside the five clusters — story md, evidence md — NOT chunked): cli 821 · engine 1065 · lockrank 661 · tests-a 1607 · tests-b 1098. The chunk sum (5252) vs the full-diff line count (5371) reconciles to the unchunked remainder plus header accounting; the historical HEAD SHA was not recorded in this ledger, so the round-1 numbers are not byte-reproducible after the fact — see the round-3 addendum at the bottom of this file for a fully reproducible value set (recorded SHA + same-command outputs).
Reviewers: blind-cli, blind-engine, blind-lockrank, edge-src, edge-tests-a, edge-tests-b, auditor

## Pre-seeded: Sift bot findings (verified against source by orchestrator)

| # | Sev | Finding | Location | Verdict | Rationale |
|---|-----|---------|----------|---------|-----------|
| S1 | BUG | Race poller keeps polling after cross-process win — mutate cb refuses without capturing `rec.winner`; caller returns null | src/fleet/fanout-primitive.ts:537-541 | **PATCH** | Confirmed. `claimed` stays null on refuse path → `claimed !== arm` → returns null → poll loop ticks to ceiling. Fix: `claimed = rec.winner` in refuse branch; also covers already-won-by-self re-entry |
| S2 | WARN | `lock.acquire()` not awaited | src/fleet/fleet-lock.ts:245 | **DISMISS** | `acquire(): void` is synchronous; nothing to await |
| S3 | WARN | `isAlive()` throw crashes classifyHolder | src/fleet/fleet-lock.ts:406 | **DISMISS** | run-lock.ts:140-148 wraps `process.kill` in try/catch, fails closed (non-ESRCH ⇒ alive); guard covers pid≤0/range. Cannot throw |
| S4 | SUGG | Test regex `/malformed\|n/i` matches any message containing "n" | tests/fleet/fanout.test.ts:316 | **PATCH** | Confirmed. Real msg contains "malformed" (fanout.ts:297-301). Tighten to `/malformed/i`. Sweep siblings for same pattern |
| S5 | SUGG | shellQuote duplicated test vs prod | tests/fleet/patterns.test.ts:113 vs fanout-primitive.ts:561 | **DISMISS** | Intentional test-isolation mirror — comment states prod loosening must not loosen probe rewriting |
| S6 | SUGG | fsyncDir duplicated ×3 (run-lock/fleet-lock/fanout) | run-lock.ts:151, fleet-lock.ts:433, fanout.ts:356 | **DISMISS** | Established codebase idiom: small fs helpers deliberately module-private with justification comments (cf. run-lock.ts:126-128). Bodies byte-identical |
| S7 | SUGG | rmQuiet redefined instead of imported from fanout.ts | fanout-primitive.ts:565 | **DISMISS** | False premise: fanout.ts does not export rmQuiet; scripts/fleet.ts has no such import. Same private-duplication idiom |

## FINAL CLASSIFICATION (orchestrator, all reviewers in)

### Dedup map
- **F1** = S1 ≡ blind-engine HIGH ≡ edge-src context: winner not captured in mutate refuse branch
- **F2** = blind-engine MEDIUM semaphore ≡ edge-src HIGH semaphore (escalated: defeats width cap)
- **F5** = blind-cli HIGH#1 ≡ edge-src MEDIUM auto-rank exit flip
- **F6** = blind-cli HIGH#2 ≡ auditor INV-2 LOW (ledger before admission)
- **F8** = blind-lockrank MEDIUM unclamped ≡ blind-cli LOW negative counts
- S4 ≡ edge-tests-a HIGH regex

### Source patches — WAVE 1

| ID | Fix | File(s) | Assignee |
|----|-----|---------|----------|
| F1 | Capture rec.winner in mutate refuse branch | fanout-primitive.ts:537-541 | fix-primitive |
| F2 | Semaphore permit handoff: waiter must not leak/decrement drift | fanout-primitive.ts:346-356 | fix-primitive |
| F9 | validateFanoutRecord: winner range vs arms.length; check create→arms-fill flow before refusing empty arms | fanout.ts:309-323 | fix-primitive |
| F10 | markDestructive inside try | fanout-primitive.ts:610-612 | fix-primitive |
| F11 | width<1 guard (headroom.allowed⟹≥1 unasserted) | fanout-primitive.ts:314 | fix-primitive |
| F12 | capMicroUsd int>0 validation; clamp explicit concurrency to MAX or fix constant doc | fanout-primitive.ts:184,297,307,314,390 | fix-primitive |
| F17a | armLine gains fanoutId (additive); exitCode→exitStatus rename only if zero consumers | fanout-primitive.ts:405-616 | fix-primitive |
| Flow | atomicReplace dir fsync after rename (durability parity with create) | fanout.ts:241-256 | fix-primitive |
| F3 | Reclaim TOCTOU: re-read + byte-compare classified body before rmSync; mismatch ⇒ re-loop | fleet-lock.ts:273-276 | fix-lock |
| F4 | Darwin TZ: body gains additive lstartRaw; identity prefers raw-string equality, numeric fallback | fleet-lock.ts:89-110,260-265,429 **FLAG intentional** | fix-lock |
| F13 | mkdir then explicit chmodSync 0700 + verify (umask gap) | fleet-lock.ts:258 | fix-lock |
| F14 | Non-Linux ps failure wrapped in FleetError taxonomy | fleet-lock.ts:72-74 | fix-lock |
| F15 | release({force}) works when signal path consumed map entry but destructive marker set | fleet-lock.ts:295-304 | fix-lock |
| F5 | Advisory auto-rank isolated: rank/store failures ⇒ warn line, arm-derived exit code preserved | scripts/fleet.ts:1408-1436 | fix-cli-rank |
| F6 | Race CostLedger gated on briefsOk + wired off resolved --dir, built only past admission | scripts/fleet.ts:1355-1370 | fix-cli-rank |
| F7 | --dir symmetry producer/consumer (resolveFanoutsDir both sides) | scripts/fleet.ts:1411,1469 | fix-cli-rank |
| F8 | rank inputs: non-negative-int counts, changedFiles array guard, composite clamp [0,1] | rank.ts:91-95,184 | fix-cli-rank |
| F16 | Single-arm rationale: no false "leads by more than 0.1" | rank.ts:117-119 | fix-cli-rank |
| F18 | CLI batch: roster ""→undefined; loserLedger.close guarded; costLedger added to dispatch strip list; steps-json validated BEFORE store mkdir/chmod | scripts/fleet.ts:1195,1278,1435,1478,1518 | fix-cli-rank |

### Test patches — WAVE 2 (after source settles)

| ID | Fix | File | Assignee |
|----|-----|------|----------|
| T1 | Tighten /malformed\|n/i → /malformed/i; sweep siblings for same pattern | tests/fleet/*.test.ts | fix-tests-a |
| T2 | Probe all six --steps-json refusal branches end-to-end | tests/fleet/cli.test.ts | fix-tests-b |
| T3 | Unknown-id rank test passes fanoutsDir seam (hermeticity) | tests/fleet/cli.test.ts | fix-tests-b |
| T4 | Loser-teardown failure-path test (one loser teardown throws ⇒ others still torn down, no wedge) | tests/fleet/patterns.test.ts | fix-tests-a |
| T5 | edge-tests-a LOWs: bare toThrow message assert; drop decorative not.toBe(3); constants-test comment states intent; winner-index assertion loosened to marker-linked arm | fanout.test.ts, patterns.test.ts | fix-tests-a |
| T6 | edge-tests-b LOWs: briefs needle tightened; coveredBy cross-file check or documented limitation; below-side tie fixture driven through rank() | cli.test.ts, verbs.test.ts, rank.test.ts | fix-tests-b |
| T7 | New focal pins for every wave-1 behavior change (winner early-return, semaphore bound, reclaim TOCTOU, lstartRaw identity, advisory-rank isolation, ledger gating) | per-cluster | wave-1 fixers own these |

### DISMISS (verified)
- S2 acquire sync · S3 isAlive fails closed · S5 shellQuote test mirror intentional · S6 fsyncDir idiom, bodies identical (edge-src byte-confirmed) · S7 rmQuiet export premise false · blind-cli export* barrel style pre-existing · parked-orphan sweep predicate external to diff · dead-export doc comment (fix-lock may correct comment wording free of charge)

### DEFER / DOCUMENT (story deviations section)
- Orphan temp sweeper (two accumulation paths) · fleetUnwinding permanent latch · corrupt-marker spins to ceiling holding lock (design gap; document) · polymorphic stdout discriminator (document verb output contract) · metric-name deviation durationMs/rankMs vs spec · AC7 letter vs K11-forced null rows · pin provenance comment → DF3.1 fill-gate

### blind-cli
- **[HIGH]** Advisory auto-rank failure flips successful fanout to failing exit (contradicts "advisory never changes exit code" comment) — scripts/fleet.ts:1410 → VERIFY then PATCH (wrap rank in try/catch → warn line only)
- **[HIGH]** Loser ledger built before brief validity enforced in race pattern; wired off default dir ignoring --dir — scripts/fleet.ts:1360 → VERIFY then PATCH (gate ledger construction on briefsOk)
- **[HIGH]** --dir producer/consumer split-brain: fanout writes via resolveFanoutsDir(fanoutsFlagDir), rank reads raw dir — scripts/fleet.ts:1469 vs :1411 → VERIFY against commit b916396 --dir fix; likely PATCH (apply same resolution both sides)
- **[MEDIUM]** CLI accepts --n 1 for best-of-n/race; registry docs say 2..8 (INV-6), refusal hint says need two arms — scripts/fleet.ts:1271, verbs.ts:127 → VERIFY then PATCH (align enforcement + hint)
- **[MEDIUM]** Unguarded loserLedger?.close() in finally can discard fanoutCode + escape as unhandled rejection — scripts/fleet.ts:1435 → PATCH (try/catch around close)
- **[MEDIUM]** Polymorphic stdout rows (arm rows + ranking row same stream, no discriminator) — scripts/fleet.ts:1395 → DECISION → conservative: add `kind` field or document; patch if trivial
- **[MEDIUM]** `export *` over four fleet modules risks silent symbol dropout on name collision — src/fleet/index.ts:17 → DECISION → conservative: leave (pre-existing barrel style), note
- **[MEDIUM]** rank mkdir/chmods fanouts dir before validating --steps-json — scripts/fleet.ts:1478 → VERIFY then PATCH (validate flag before store construction)
- **[LOW]** --roster "" yields [] treated as supplied roster — scripts/fleet.ts:1278 → PATCH (normalize empty→undefined)
- **[LOW]** Negative counts accepted in --steps-json entries — scripts/fleet.ts:1518 → PATCH (reject <0)
- **[LOW]** deps.costLedger leaks into DispatchDeps via ...seams strip-list drift — scripts/fleet.ts:1195 → VERIFY then PATCH (add to strip list)
- **[LOW]** Exporting writeLockDirect/claim makes temp-name format load-bearing cross-module — run-lock.ts:551/620 → DISMISS (documented additive exports, bodies unchanged)

### blind-engine
- **[HIGH]** Cross-process winner returns null → poller spins full ceiling holding fleet lock; at ceiling armUnknown excluded from disposeLosers ⇒ ZERO loser teardowns, N−1 VMs leak; result.winner null vs record says otherwise — fanout-primitive.ts:537-547 (+476,483-485,588-591) → **DUP of S1 but escalated** (leak + starvation chain). PATCH: capture rec.winner in cb
- **[MEDIUM]** Semaphore release() decrements + wakes waiter who never re-increments → bound breaks if any interleaved acquire (masked today by sync up-front acquires); counter drifts negative — fanout-primitive.ts:346-356 → VERIFY then PATCH (woken waiter increments)
- **[MEDIUM]** validateFanoutRecord accepts arms:[], winner out-of-range (99 on n=2), rankedAt/closedAt undefined vs frozen schema string|null — fanout.ts:309-323 → VERIFY then PATCH conservative (winner range check vs n; empty-arms refusal or documented)
- **[LOW]** width can be 0 via headroom.allowed⟹headroom≥1 assumption unasserted → allSettled never settles, lock never released — fanout-primitive.ts:314 → PATCH (width<1 guard)
- **[LOW]** atomicReplace skips dir fsync that create pays → crash resurrects pre-mutate record (race decision least durable) — fanout.ts:241-256 → DECISION → conservative: add fsyncDir after rename
- **[LOW]** Loser-teardown failure still stamps closedAt; billing VM w/ only a log line — fanout-primitive.ts:610-632,333 → DECISION → conservative: record unresolved marker? defer if invasive; flag intentional
- **[LOW]** capMicroUsd unvalidated (−1/NaN propagate into INV-3 admitted line) — fanout-primitive.ts:297,307,390 → PATCH (integer>0 check alongside concurrency validation)
- **[LOW]** Explicit concurrency bypasses MAX_FANOUT_CONCURRENCY doc contract — fanout-primitive.ts:184,314 vs 51-57 → PATCH trivial (clamp explicit too) or fix doc comment
- **[LOW]** markDestructive outside try → throw leaves lock pinned destructive, release refused, fleet deadlock — fanout-primitive.ts:610-612 → PATCH (move inside try)
- **[LOW]** Race marker staged shared /tmp predictable name, 16-bit entropy, no 0600 — fanout-primitive.ts:514-515 → DECISION → conservative: per-process 0700 subdir matches house style
- **[LOW]** Orphan temps two accumulation paths (SIGKILL between tmp/rename; late copyFile recreates after rmQuiet) — fanout.ts:244-255, primitive:514,556 → DEFER (sweeper out of scope; document)

### blind-lockrank
- **[HIGH]** Reclaim rmSync unconditional — no body re-verify between classify and delete; two contenders both classify same stale lock, B deletes A's fresh live lock → two holders, AC8 void — fleet-lock.ts:275 → VERIFY then PATCH (re-read+compare body before unlink)
- **[HIGH]** Darwin start-time TZ-dependent: writer TZ=UTC vs reader local zone → observed!==pidStartTime on LIVE owner with age>1h → reclaimed while alive; owner's later release parkOrphans successor's lock — fleet-lock.ts:110/429 → VERIFY then PATCH (store raw lstart string, compare strings)
- **[MEDIUM]** Composite score unclamped; negative counts → passRate 100/negative scores; changedFiles non-array iterates chars into union — rank.ts:184 (gates 91-95) → **MERGE w/ blind-cli --steps-json negatives** → PATCH (non-negative int guards + clamp)
- **[LOW]** fleetUnwinding latches forever; post-survived-unwind new locks never signal-released — fleet-lock.ts:118/165 → DECISION conservative: reset latch in acquire? likely DEFER w/ comment
- **[LOW]** Signal release desyncs fleetHeld/fleetDestructive → later release({force:true}) silent no-op, stale file persists — fleet-lock.ts:295 → VERIFY then PATCH cheap (also clear Set / warn)
- **[LOW]** Non-Linux ps failure throws raw Error not FleetError — fleet-lock.ts:72-74/262 → PATCH trivial (wrap in FleetError taxonomy)
- **[LOW]** Parked-orphan sweep survival rests on external K1 predicate out of scope — fleet-lock.ts:198-207 → VERIFY (grep sweeper predicate); dismiss if confirmed dead-pid-.tmp-only
- **[LOW]** Single-arm ranking rationale claims "leads by more than 0.1" over nothing — rank.ts:117-119 → PATCH trivial (n===1 rationale branch)

### edge-src
(pending)

### edge-tests-a
- **[HIGH]** Schema-refusal regex `/malformed|n/i` matches almost anything — tests/fleet/fanout.test.ts:316 → **DUP of S4**, PATCH
- **[MEDIUM]** Loser-teardown failure branch unpinned (teardownSandbox catch logs+continues; no test that one loser's teardown failure doesn't abort remaining losers / wedge lock) — patterns.test.ts:593 vs fanout-primitive.ts:612-618 → **PATCH** (add failure-path test)
- **[LOW]** Winner index pins sequential-probe detail `toBe(1)` — patterns.test.ts:583 → **PATCH** (loosen or comment; conservative: assert winner ∈ {0,1} w/ marker-arm linkage)
- **[LOW]** Constants test mirrors literals under "never mirrored literals" comment (change-detector) — patterns.test.ts:749 → **DECISION** → conservative: keep pin but reword comment to state intent (pin against silent retune)
- **[LOW]** Bare `toThrow()` on readOwnPidStartTime accepts any crash — fanout.test.ts:386 → **PATCH** (assert message)
- **[LOW]** Decorative `not.toBe(3)` satisfied by undefined — patterns.test.ts:653 → **PATCH** (drop or strengthen)

### edge-tests-b
- **[HIGH]** Zero coverage for entire --steps-json trust-boundary validation (six refusal branches scripts/fleet.ts:1483-1527; block deletable with all suites green) — verbs.test.ts:894/cli.test.ts:3799 → **PATCH** (wave-2: add refusal probes)
- **[MEDIUM]** Unknown-fanout-id test mkdirs repo .sandbox/fanouts (no --dir, QDS_FANOUTS_DIR not in CLI_ENV_KEYS), breaks file's own hermeticity claim — cli.test.ts:3883 → **PATCH** (pass fanoutsDir seam or tmp dir)
- **[LOW]** ONLY_REACHABLE_ELSEWHERE.fanout coveredBy pointer unenforced (rename/delete of target stays green) — verbs.test.ts:1046 → **PATCH** wave-2 cheap (resolve title against actual tests if feasible; else comment) → conservative: strengthen check or document limitation
- **[LOW]** Weak "briefs" needle can't distinguish which brief guard fired — cli.test.ts:3694 → **PATCH** (tighten to remediation text)
- **[LOW]** K6 header overclaims below-side tie straddle (only above-side through rank()) — rank.test.ts:10 → **PATCH** trivial (add below-side fixture through scorer or fix comment)

### auditor
- **[MEDIUM]** Observability contract unmet: armLine lacks fanoutId, uses exitCode not exitStatus, no durationMs/outcome set on one line; metric names durationMs/rankMs vs spec arm_dispatch_ms/rank_ms — fanout-primitive.ts:405-616, rank.ts:204 → DECISION → conservative: add fanoutId + rename to exitStatus if consumers unaffected; else document deviation in story
- **[LOW]** AC7 all-failed⇒empty-scores only fires for degenerate arms:[] record; real all-failed yields n× score:null rows — rank.ts → DEFER (forced by frozen schema K11; document in story)
- **[LOW]** Record pin stamps requested SHA not verified checkout — fanout-primitive.ts:267 → DECISION conservative: comment pointing at DF3.1 fill-gate as verification site
- **[LOW]** Race refusal leaves CostLedger db file (INV-2 "mutates nothing" letter) — scripts/fleet.ts:1361 → **MERGE w/ blind-cli HIGH #2** same root fix (gate ledger on briefsOk)
- Verified-clean note: auditor confirms ceiling→armUnknown exclusion from disposeLosers is SPEC-correct (never auto-destroy unknown). blind-engine's leak chain routes through S1 null-winner bug flipping healthy arms at ceiling — root cause remains S1

## WAVE 1 RESULTS

### fix-lock — DONE (all 5 FIXED, no skips)
- F3 verdict-object {verdict:"reclaim", body} + re-read/byte-compare before unlink; mismatch ⇒ re-classify, never blind rm
- F4 DEVIATION (accepted): identity via `lstartUtcMs` (Date.UTC of same components, TZ-free), not raw-string equality — ps renders in READER's TZ so raw strings differ cross-TZ by design; additive optional keys lstartRaw+lstartUtcMs (darwin-only writes), legacy numeric fallback for old bodies
- F13 chmodSync 0700 + stat verify · F14 FleetError(5,"fleet-identity-unobservable") · F15 force-release after signal-interrupted destructive phase cleans up/parks
- biome+tsc clean · focal 59 pass / 1 fail
- **WAVE-2 MUST-EDIT**: tests/fleet/fanout.test.ts:430 Object.keys(body) assertion needs lstartRaw/lstartUtcMs
- Intentional changes: body schema +2 optional keys · compare-then-rm reclaim · force-release effective post-signal · dir mode hard-verified 0700 · identity failure = exit 5 FleetError

### fix-primitive — DONE (all FIXED; skips documented)
- F1 claimed=rec.winner adopt-and-return + pin (pre-fix failed: ceiling spin/zero teardowns) · F2 transfer-semantics release + pin (HONEST: pin passes pre-fix too — drift real but unexploitable in current single-acquire shape) · F9 winner∈[0,arms.length) on write AND read + 2 pins; empty-arms NOT refused (create() legitimately writes arms:[] pre-fill — trace confirmed) · Flow fsyncDir after rename · F10 moved inside try · F11 Math.max(1,…) pure defense, NO PIN (precondition unconstructible via public APIs, quota.ts:243 proof) · F12 invalid-cap exit 2 pre-lock + 4 pins; concurrency clamp unobservable (n≤8=MAX), contract hygiene · F17a fanoutId added to arm lines; exitCode→exitStatus NOT done (consumers exist) — deviation stands
- biome+tsc clean · focal 62 pass / 1 fail (= fix-lock's known :430 key-set assertion)
- 8 intentional changes logged (T7 ledger candidates incl fixture schema-consistency fix)
- Skips: F11 pin, exitCode rename

### fix-cli-rank — DONE (all FIXED; F7 verified pre-fixed)
- F5 auto-rank try/catch ⇒ stderr `auto-rank-failed` envelope, arm-derived exit preserved +pin · F6 ledger gated briefsOk +pin (dir half already correct) — **REOPENED round 4**: briefsOk gating still constructed the SQLite db pre-lock, so a fleet-busy / no-headroom race refusal left cost-ledger.db behind (INV-2). Re-fixed LAZILY — see the round-4 addendum below · F7 NO LIVE BUG — b916396 fixed it (constructor resolves internally); explicit resolveFanoutsDir both sides for visible symmetry · F8 assertStepOutputShape guard + clamp +pin · F16 single-arm rationale +pin · F18a roster normalize +pin · F18b close guarded dp:ok (no seam for pin) · F18c costLedger stripped · F18d steps-json parsed before store/mkdir +pin · F18e boundary non-negative check +pin
- focal 199 pass / 0 fail ×2 runs · biome clean · tsc clean repo-wide
- 7 intentional changes logged

### fix-tests-a (wave 2) — DONE, no skips
- :430 mandated-keys: 4 present + extras ⊆ {lstartRaw,lstartUtcMs} exact — future key still fails · T1: /malformed|n/i→/malformed/i; sweep clean (:327/:653 alternatives are full discriminating words) · T4 new pin "one loser's destroy failing never wedges disposal" (teardown-failed line, sibling disposed harvest-before-destroy, winner intact, record closed, destructive mark cleared) · T5 winner derived from planted-marker arm; decorative not.toBe(3) dropped; constants comment reworded; bare toThrow→/could not/ (darwin+linux share fragment)
- focal 64 pass / 0 fail (355 expects) · biome+tsc clean

---

## Round 3 addendum (2026-08-24, reviewed HEAD `6af62af` — reproducible value set)

Diff: `git -C <root> diff origin/main...HEAD` at HEAD `6af62af` = 16 files, +6465/−105, **6,958 lines**.
Chunks (raw `wc -l`, pathspec-split, headers included): cli 739 · lockrank 1139 · fanout 1279 ·
tests-a 1400 · tests-b 1445 (sum 6002; remainder = story md + this ledger, unchunked).
Reviewers: blind-cli, blind-lockrank, blind-fanout, blind-tests-a, blind-tests-b, edge-src (repo),
auditor (spec) + Sift inline batch. ~100 raw → **21 patch items / rest dismissed-vs-source**.
Working ledger: `/tmp/pr128-r3/triage.md`. Patched items and dispositions recorded in the story's
"Review round 3" section. Round-1 chunk counts above are left as written (historical record); the
reconciliation note at the top of this file explains the header/remainder accounting.

## Round 4 addendum (2026-08-24 — Sift inline batch + CodeRabbit outside-diff comments)

- **F6 reopened and re-fixed.** The round-3 "built only past admission" claim was wrong: the loser
  CostLedger was still constructed eagerly in scripts/fleet.ts before fanout() took the lock, so a
  fleet-busy or no-headroom race refusal created cost-ledger.db (INV-2 "a refused fan-out mutates
  nothing"). Fix: the CLI now builds a lazy CostLedgerHook — the hook does no I/O and the real
  ledger opens only on the first ingestBoxHours, reachable exclusively from a LOSER'S teardown
  close step, strictly past admission; close-before-use touches no disk. Pinned by cli.test.ts
  "a fleet-busy race refusal creates NO loser cost ledger". The story's "#129 deferral (needs a
  factory seam)" rationale is void: no primitive-side seam was required.
- **Bounded loser teardown landed for real** (the story's round-3 entry pre-checked it): disposeLosers
  wraps each teardownSandbox in `loserTeardownTimeoutMs` (LOSER_TEARDOWN_TIMEOUT_MS, default 5 min);
  a hung disposal is abandoned with its own `loser-teardown-timeout` arm line and the fleet lock is
  provably released. Pinned by patterns.test.ts "a hung loser teardown hits its deadline".
  DF2.5 has no cancellation seam, so "known to have stopped" is unobservable; the deadline abandons,
  safe because an abandoned teardown can only touch its own idempotent run state.
- --steps-json gained readBriefFile's regular-file proof (directory ⇒ named refusal instead of EISDIR;
  FIFO can no longer block the read); pinned by a cli.test.ts directory probe.
- tests/fleet: deadPid/liveChild consolidated into helpers.ts (were duplicated across fanout.test.ts
  and fleet-lock.test.ts under a C3 reading the directory itself did not follow — patterns.test.ts
  already imports shared fixtures). Ruling-C3 comments rescoped: LOCAL covers choreography fakes;
  generic corpse helpers are shared like the ledger fixtures.
- cli.test.ts unknown-pattern case: the "constructed nothing" assertion now points the invocation at
  a fresh path via --dir (the old freshFanouts path was never consumed by the CLI — vacuous).

## Round 5 addendum (2026-08-24, HEAD 07deeef — bmad-code-review, 9 reviewers / 6 chunks)

24 raw → 12 patch (2 source: reap-mutex steal-path tick sleep, runRace undecided() hoist; 10 test:
cli retitle + --n 0 + {} steps-json + comment arithmetic, fanout clock-skew bounds + pid boundaries
+ list() read-only, rank breakdown pin + tie contract pin, patterns many-stories n=1 positive),
1 decision-needed resolved conservative (AC9 schemaVersion: store-layer injection is the cross-namespace
contract; on-disk shape correct; no change), 11 dismissed with source evidence (incl. two impossible
signal-handler HIGHs — sync handler + serialized event loop; per-signal listener lists; round-3
adopt-persisted-winner already covers the stale-winner claim). Full ledger:
`_bmad-output/workflow-state/code-review/pr128-r5/triage.md`. Gates: 506/506 fleet focal, tsc clean,
biome clean ×7, detect_changes LOW (1 symbol, 0 processes). One intra-round regression caught and
fixed: P3 retitle broke verbs.test.ts coveredBy title binding — updated to the new title.

## Round 5b addendum (2026-08-24 — CodeRabbit + Sift warnings after round 5)

2 confirmed + fixed (loser-ledger post-close reopen in the lazy hook; marker-corruption
consecutive counting via probeArm "absent" verdict), 1 dismissed (Sift's unhandled-
rejection warning — withTimeout's pre-attached no-op catch is the exact suggested fix,
in place since round 4). Both fixes mutation-verified RED pre-fix. 508/508 focal.
