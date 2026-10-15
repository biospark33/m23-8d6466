# J4 round 3: Edge-Case Hunter

Scope: `git diff origin/dev...HEAD` (HEAD `4aa58295`, base `5b03a7b7`).<br />
Focal gates I ran:
- `tests/autonomy/` (5 files), `observe-ontick`, `steering`, and `machine-state`: 211 pass, 0 fail (`/tmp/j4-ech3.log`).
- `build-exedev-image` and `observe.test.ts`: 306 pass, 0 fail (`/tmp/j4-ech3b.log`).
- `git status --porcelain --untracked-files=all -- _bmad-output/judgment` was empty after every run.

Probes (scratch under `/tmp`):
- `/tmp/ech3-probe-steer.ts`: a steering differential run against an `origin/dev` `git archive` tree, 15 inputs × 3 points.
- `/tmp/ech3/probe.ts`: covers L8/L9 routing polarity, bypasses of the arming scan, and the L9 would-order on a repeat call.

## R2 verification

| Row | Result | Evidence |
|-----|--------|----------|
| R2-01 | VERIFIED | `host-pack.ts:725-730`: a recorded answer re-applies `recordedWouldFilter`, which matches the fresh rule (`DISMISS` maps one-to-one from `dismiss` and `real < L8_REAL_DEFECT_MIN`), and it logs `skip:"already-recorded"` with `would_signal`. Fail-open on a bad rationale. Caveat: ECH3-004. |
| R2-02 | VERIFIED | `observe.ts:761` only records `pendingTick`. The hook runs at `:825` after the `finally` releases the lock. `runTickHook` is total: `sweepLine` and `errText` cannot throw, and the hook is wrapped in try/catch, so it cannot abort the pass or touch counters. A box torn down after release reaches `readBoxFile`, which is bounded at 10 s for the probe+cat pair (`transport.ts:177`), and becomes a recorded `journal-*` miss. The hook cannot normally outlive the 60 s deadline: 10 s read + 40 s ask, and `withCorpusLock` releases in `finally` on a timeout, so no stale corpus lock survives a process exit. Caveats: ECH3-001, ECH3-005. |
| R2-03 | VERIFIED for L9 / NOT-FIXED for the twin | `l9…:78-80` uses `mode === "live"` for live and everything else for mock. `host-pack.ts:279` still uses the inverse polarity, and a probe shows a mode-less judge routes L8 to the LIVE corpus. See ECH3-002. |
| R2-04 | VERIFIED | The pin is `4095eff…` in the test, the story (line 140) and register item 16(a), all consistent. `build-exedev-image.test.ts` is green. |
| R2-05 | VERIFIED (DEFER, doc) | Story line 136 and register 16(c) say "zero asks today". |
| R2-06 | VERIFIED | Story status is `in-review`. Dev Agent Record dated 2026-10-14 is present. |
| R2-07 | VERIFIED as stated | `l9…:243-252`: recorded check first, and the cap counts real asks only. Caveat: ECH3-003 (recorded items are kept in the order but mis-ranked). |
| R2-08 | VERIFIED | `resolveProvenanceDir` anchors to `FACTORY_ROOT` (`l9…:83-85`). |
| R2-09 | VERIFIED | `host-pack.ts:733-740`: `withTimeout(…, l7AskDeadlineMs)` per L8 ask. The lock is released in `finally`. |
| R2-11 | VERIFIED as stated / weak | The scan was widened and the env test sets 11 vars. Trivial spellings still bypass it. See ECH3-006. |
| R2-12 | VERIFIED | `readCorpusOrThrow` sets `torn` only for `SyntaxError` or the merge.ts "failed schema validation" text. EACCES is a `corpus-io` miss with no rename (chmod-000 test). |
| R2-13 | VERIFIED | `readMachineStateShard` uses `MachineStateRecordSchema`, the same schema as `appendMachineStateRecord`. A foreign line is torn before the ask and set aside. |
| R2-14 | VERIFIED (bound is soft) | `observe.ts:474`, test green. Overshoot of up to one deadline: ECH3-001. |
| R2-15 | VERIFIED (byte-compared) | 45-case differential against origin/dev. Every non-compact input, including `{}`, `{"action":5}`, `null`, `[]`, `{}`-valued, `Compact`, `frobnicate`, bad-field known actions and allowlist rejections, gives an identical directive, call count, tripwire detail and `directivesRejected`. The only delta is the ratified `unrecognized action: compact` + host-only suffix, at all 3 points. |
| R2-16 | VERIFIED | `host-pack.ts:576`: the skip requires `last.answer_mode === ctx.client.mode`. |
| R2-17 | VERIFIED | The cut-boundary suite is green inside the 211. `node_modules` is the only symlink (asserted). tsc runs inside the tree. |
| R2-18 | VERIFIED | `answer_mode` is on every `l9-triage` line, and it uses the same polarity as routing (`l9…:193`). |
| R2-19 | VERIFIED | `fleet.ts observeTickHookFor`: the no-deps case gives the default hook, deps without a pack give `{}`, and deps with a pack give the injected hook. The test covers all three. |
| R2-10, R2-20 | DISMISS (not re-reviewed) | — |

R1 spot-checks still hold:
- R1-02: origin refusal before the schema, confirmed by the differential.
- R1-04: the 10 s pair plus the 40 s ask fits under 60 s.
- R1-05: the `remaining < 2×deadline` skip is intact.
- R1-09: only `active` asks.

## Findings

### ECH3-001 [LOW] Pass hook budget can be overshot by a full hook deadline
`src/fleet/observe.ts:474`

**Scenario:** `hookSpentMs` is checked against the budget with `>=` before a hook starts. A hook that starts at `hookSpentMs = budget − ε` can still run the full `ON_TICK_DEADLINE_MS`. Real total: 300 s + 60 s = 360 s of a 1200 s pass, not "capped at" 25%.

**Evidence:** The per-call wall-clock rule on the same line reserves `deadline * 2` ahead of time, but the pass-hook rule reserves nothing. The docblock for `ON_TICK_PASS_BUDGET_FRACTION` says "capped".

**Fix:** use `hookSpentMs + deadline > hookBudgetMs`, or reword the doc to "soft cap, plus at most one deadline".

### ECH3-002 [LOW] L8 mock/live routing keeps the polarity R2-03 removed from L9
`src/autonomy/host-pack.ts:279`

**Scenario:** `client.mode === "mock" ? L8_MOCK_CORPUS_DIR : PACK_CORPUS_DIR`. A judge without `mode` (a JS caller, an `as any` spy, or a wrapper that drops the getter) writes its L8 records into the measured corpus that ab-report reads. The rationale and log then say `answer_mode=undefined`. For L7, the same judge pays for the ask and then fails `MachineStateRecordSchema` (`answer_mode` enum) as `judge-failed` on every tick.

**Evidence:** The probe prints `L8 corpusDir for mode-less judge: LIVE corpus`, while L9 routes the same object to `corpus/mock`. The type requires `mode`, so reaching this needs a cast, which is why it is LOW.

**Fix:** `client.mode === "live" ? PACK_CORPUS_DIR : L8_MOCK_CORPUS_DIR`, the same rule as `resolveTriageCorpusDir`. Optionally refuse a client whose `mode` is not `live` or `mock` in `packContext`.

### ECH3-003 [LOW] L9 logged would-order demotes already-recorded hotspots, so a repeat sweep logs the wrong ranking
`src/autonomy/l9-repo-sweep-triage.ts:271` (with `:243-247`)

**Scenario:** recorded hotspots never enter `worthByPath`, so they sort as `-1` below every fresh answer. On a repeat call with unchanged briefs, which is the steady state, every hotspot is recorded, and `would_order` collapses to the deterministic order. That is the opposite of what the line measures.

**Evidence:** Probe with worth a=0.1, b=0.9, c=0.5. Call 1 logs `b.ts,c.ts,a.ts`. Call 2, with identical input, logs `a.ts,b.ts,c.ts`. R2-07 said "recorded items stay in the logged order". They are present, but mis-ranked.

**Fix:** on the already-recorded path, seed `worthByPath` from the recorded `rationale` (`worth_brief=<n>;`, written at `:174`), the same way R2-01 reuses the L8 noul.

### ECH3-004 [LOW] L8 recorded answer is keyed by id, not by text: an edited finding inherits the stale verdict
`src/autonomy/host-pack.ts:710,725-730`

**Scenario:** the key is `${runId}/${findingId}` with no text digest (L9 includes `digest(brief)`). If a finding is re-authored under the same id, for example after a lens re-run or a reworded finding, R2-01 now re-applies the old answer. If that answer was a DISMISS, the new text is in the would-filter set without ever being judged, and it is never recorded either. While unarmed this only skews `would_keep`. Once armed, it filters a finding nobody looked at.

**Fix:** append `@${sha256(text).slice(0,12)}` to the L8 `finding_id`, as L9 does. Alternatively, require `recorded.finding_text === f.text` before reusing the answer.

### ECH3-005 [LOW] Post-release hook ticks on a record snapshot that may already be stale
`src/fleet/observe.ts:761,825`

**Scenario:** this is a consequence of R2-02 and is intended. Between `releaseRunLock` and the hook, another invocation (`fleet observe <runId>`, a second sweep, or `teardown`) can settle or close the run. The hook still receives `record: nowRec` from under the lock and asks L7 about a run that has finished. Today the cost is one recording-only ask, or a `journal-*` miss if the box is gone. Two overlapping sweeps serialize on the per-shard corpus lock, so the result is a `corpus-locked` miss, not a duplicate ask. Once armed, a compact directive could target a settled run.

**Fix:** none needed for J4. Record a requirement for the arming PR: the steering writer must re-check run state under the run lock before it writes. A one-line note in register item 16 would do.

### ECH3-006 [LOW] Widened arming scan is still trivially bypassed, and the `rc` rule is mostly dead
`tests/autonomy/host-pack.test.ts:293-303`

**Evidence:** the probe shows all of these MISSED:
- `process["env"].X`, `const { env } = process`, `globalThis["process"].env`, `Bun["env"]`, `require("process").env`
- `".npmrc"` and `".qdsrc"`: `/\brc["'`]/` needs a word boundary before `r`, so it only matches bare `"rc"`, `".rc"` or `"/rc"`.
- `existsSync("/etc/qds-armed")`

**Impact:** none today. The real guarantee is the `false as const` literal, which the test pins, plus the two `PACK_SIGNALS_ARMED` use sites. The scan is a tripwire with an advertised coverage it does not have.

**Fix:** replace the `rc` rule with `/rc["'`]/`. Add `/\bprocess\b/`, `/\bBun\[/`, `/\bexistsSync\b/`. Or, more robustly, assert that the module's only identifiers that reach `PACK_SIGNALS_ARMED` are the literal: grep that every `PACK_SIGNALS_ARMED` use is `PACK_SIGNALS_ARMED &&` or `PACK_SIGNALS_ARMED ?`.

## Not findings (checked)

- **Counter identity:** the hook runs after the disposition increment, and no path changes counters.
- **Re-enumeration:** the hook cannot run twice for one run in a pass, because each candidate is driven once.
- **Hook outliving the pass:** not reachable with production bounds (≤ 50 s inside a 60 s deadline). On a timeout the corpus lock is released in `finally`, so no stale lock is left for the next process.
- **Shard set-aside:** the rename happens under the shard lock. The renamed file (`*.unreadable-<ts>`) is outside ab-report's top-level `*.jsonl` glob, and the machine-state dir is a subdir that ab-report does not walk.
- **Production `observeTickHookFor`:** builds a mock-default `JudgmentClient` (`TYPESAFE_MOCK` and constructor default), so it cannot throw or go live from the environment.

**Verdict:** All 17 R2 PATCH rows hold, apart from R2-03's untouched L8 twin (ECH3-002). Steering text is byte-identical to origin/dev for every non-compact input. There are 0 BLOCKER, 0 HIGH, 0 MED and 6 LOW findings, so this is PR-ready, with ECH3-002/003/004 as cheap one-line patches worth taking.
