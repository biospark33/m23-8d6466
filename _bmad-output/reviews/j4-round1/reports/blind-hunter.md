# J4 round 1: Blind Hunter report

Scope: `/tmp/j4-r1.diff`, code only (the spec doc hunk was skipped). Every claim below was checked against the full file text in `wt-j4`.

### BH1-001 [HIGH] L9 mock records land in ab-report's measured corpus by default
`src/autonomy/l9-repo-sweep-triage.ts:153` (`const corpusDir = deps.corpusDir ?? DEFAULT_CORPUS_DIR`)

**Scenario:** `makeSweepTriageRanker()` is called with no deps. The client is the mock-default `JudgmentClient` and the dir is `DEFAULT_CORPUS_DIR`. Each hotspot then appends an `arm: "jev"` TriageRecord to the top-level `x-rx.jsonl`. `scripts/judgment/ab-report.ts:120` reads every top-level `*.jsonl` and puts each `arm === "jev"` row in the jev partition. As a result, mock latencies and the computed `cost_exact_usd` enter the SPEED and COST arms of the measured report. Neither the record nor its rationale carries `answer_mode`, so these rows cannot be filtered out afterwards. host-pack's L8 explicitly avoids this case (`L8_MOCK_CORPUS_DIR`, "mock `arm: "jev"` records can never enter a measured-agreement denominator"). L9 ignores the same rule.

**Fix:** Use the same rule L8 uses. Give `Judge` a `mode`, default the dir to `join(DEFAULT_CORPUS_DIR, "mock")` when the client is mock, and add `answer_mode=` to the rationale.

### BH1-002 [MED] The resident can originate `compact`; it is accepted, counted and has no effect
`src/phase-engine/steering.ts:143`, `:162-163`

**Scenario:** The comments claim `compact` is "host-originated ... never a resident decision". However, the resident's reply goes through `SteeringDirectiveSchema`, which now has `compact` as a member. A resident reply of `{"action":"compact"}` at run_start or post_gate_failure is therefore accepted, and `telemetry.directives` is incremented. The new test at `tests/phase-engine/steering.test.ts` ("compact at run_start/post_gate_failure is accepted and counted") locks this behavior in.

`scripts/pipeline-run.ts` handles only abort and retry at post_gate_failure. `compact` falls through to the "proceed" comment, so it leaves no `resident_directive` trace row at that point. This breaks the POINT_ALLOWLIST contract stated at `steering.ts:153`: "`telemetry.directives` counts only directives the runner can actually apply". Leaving it out of the prompt is the only fence. When the arming PR adds an in-box applier, it will apply compacts the resident originated.

**Fix:** Keep `compact` out of the resident parse path. One option is a separate host-directive schema. Another is to reject `compact` in `solicit` as a resident-origin tripwire. Do not add it to POINT_ALLOWLIST until an applier exists.

### BH1-003 [MED] Armed L8 fails closed and drops every finding when the corpus lock or dir fails
`src/autonomy/host-pack.ts:547-605`

**Scenario:** If `withCorpusLock` throws, `wouldKeep` stays `[]`. That happens when `mkdirSync` fails, when `acquireRunLock` throws `RunLockedError` because observe-round or L9 holds `corpus-writer`, or on reentrancy. The outer catch logs a miss. Line 605 then returns `findings.filter(f => wouldKeep.includes(f.findingId))`, which is empty. The module's own rule is "a refused/missed finding is never filtered", and this path breaks it.

There is a second problem in the same code. `wouldKeep` is keyed by `f.findingId`, but the record key is `${runId}/${findingId}`. When two runs contain the same `findingId`, keeping one also keeps the other.

A third problem: a finding that was already recorded is always kept (line 559), even if its recorded answer was "would filter".

This is dormant while `PACK_SIGNALS_ARMED` is false, but it is the exact path that arming turns on.

**Fix:** Track `wouldFilter` as a set of composite keys. Return `findings.filter(f => !wouldFilter.has(key(f)))`, so any failure falls back to keeping everything.

### BH1-004 [MED] onTick time counts against the sweep's wall-clock budget and can starve later candidates
`src/fleet/observe.ts:195`, `:720`

**Scenario:** `ON_TICK_DEADLINE_MS = 60_000`, `MAX_CANDIDATES_PER_PASS = 25`, and `SWEEP_WALL_CLOCK_BUDGET_MS = 1_200_000`. If 25 hooks each hit their deadline, that is 1,500 s, which exceeds the 1,200 s budget. A slow box read or a hung `JudgmentClient` (30 s timeout plus the box read) is enough to get there. The budget is checked between candidates (`observe.ts:798`). Once it runs out, the remaining candidates are counted as `candidates_skipped` with reason `wall-clock-budget`.

Unsettled runs stay in the candidate set, so each pass the same leading running residents use up the budget. The later candidates, which may be settled runs awaiting their settle or teardown chain, are skipped on every pass.

The doc comment on `onTick` says a timeout "never touches counters". That holds for one call, but not for the pass as a whole.

**Fix:** Bound the aggregate hook time per pass, for example by skipping `onTick` once `el()` passes a fraction of the budget. Another option is to run the hooks after the disposition loop, outside the per-candidate budget accounting.

### BH1-005 [MED] The production hook writes factory telemetry into the cwd, which is the dispatched repo's worktree
`scripts/fleet.ts:2238`; `src/autonomy/host-pack.ts:228` (and the default `JudgmentClient` provenance dir)

**Scenario:** `fleet observe --all` requires cwd to be "the repo the run was dispatched against" (`fleet.ts:1818-1830`, hostRoot = `process.cwd()`). With `deps === undefined`, the hook uses the relative defaults `_bmad-output/judgment/corpus/machine-state` and the client's default provenance dir. Each pass past threshold therefore runs `mkdirSync` and appends untracked files inside the target repo's worktree. When that repo is not QDS-Factory, the files can end up in the next commit or PR of that repo, and the corpus ends up spread across repos.

**Fix:** Resolve the defaults against a fixed factory/host data root, not cwd. Alternatively, have `runObserveSweep` pass explicit absolute dirs.

### BH1-006 [LOW] An orphaned hook after a timeout keeps the corpus lock, and the next tick's miss is misclassified
`src/autonomy/host-pack.ts:354`, `:409`

**Scenario:** When `withTimeout` gives up on a hung `l7Ask`, the ask's promise continues and still holds `machine-state/corpus-writer.lock` in this process. The next resident's hook in the same pass calls `acquireRunLock` on the same path, which throws `RunLockReentrantError`. That class is not a subclass of `RunLockedError`, so `missReason` returns `"judge-failed"` instead of `"corpus-locked"`. Every remaining resident in the pass is then logged as a judge failure.

**Fix:** Map `RunLockReentrantError` to `"corpus-locked"`. Also consider giving `judge` an AbortSignal tied to the tick deadline.

### BH1-007 [LOW] Machine-state and L8 corpus reads grow without bound and run twice per ask under the lock
`src/autonomy/host-pack.ts:405` (`alreadyRecorded`) plus `scripts/corpus/merge.ts:159` (`appendRecord` dedupe)

**Scenario:** Every L7 record ever written goes to one file, `x-rx.jsonl`, because `pr` and `round` are always null. Its key is `${runId}@${sweepRequestId}`, and the sweep id is fresh on every invocation. So every observe pass past threshold appends a new line, and dedupe effectively never fires in production. Each ask parses the whole file twice, so cost grows O(n) per ask and O(n²) over the file's lifetime. A single torn or malformed line makes `readCorpusRecords` throw, and from then on every L7 ask is a "judge-failed" miss until someone repairs the file by hand.

**Fix:** Shard the file by run or day (for example `corpusFilePath` keyed by runId), or keep an in-memory key set per context.

### BH1-008 [LOW] L9 pays for a repeat ask on every rank() call; the dedupe result is discarded and logged as "ok"
`src/autonomy/l9-repo-sweep-triage.ts:209`

**Scenario:** A second `rank()` over the same hotspots asks the judge again, with real spend when live. `appendRecord` returns `"duplicate"`, but the return value is ignored, and the line logs `status: ok` with an answer that was never recorded. L7 and L8 both check `alreadyRecorded` first; L9 does not.

**Fix:** Check before the ask, as host-pack does, and log a duplicate as its own outcome.

### BH1-009 [LOW] `defaultListFiles` is documented as "bounded" but walks the entire tree
`src/autonomy/l9-repo-sweep-triage.ts:248`, `:274`

**Scenario:** `readdirSync(dir, { recursive: true })` lists every entry, `node_modules` included, before filtering. It calls `statSync` on each source file. `MAX_OPENSRC_SPANS` is applied only after the full walk. A large package means unbounded synchronous I/O on the host. A single dangling symlink makes `statSync` throw, which turns the whole package into a `source-unreadable` miss.

**Fix:** Walk manually and prune `node_modules`, stop after N files, and use `lstat` or skip entries that fail to stat.

### BH1-010 [LOW] `appendRecord` no longer guards the triage dir against machine-state rows
`scripts/corpus/merge.ts:159`

**Scenario:** `appendRecord` now accepts either union arm for any `outDir`. If a machine-state record is written to `DEFAULT_CORPUS_DIR` (for example a misconfigured `machineStateCorpusDir`), it lands in a top-level `*.jsonl`. `ab-report --all` and `observe-round` read that file with the triage-only `readRecords`, which throws on that line, so the whole report or round fails rather than just skipping one record.

**Fix:** Split the writer by arm (`appendTriageRecord` and `appendMachineStateRecord`). Alternatively, refuse machine-state records whose `outDir` resolves to the triage corpus root.

---
Counts: HIGH 1, MED 4, LOW 5 (BLOCKER 0).

Verdict: CHANGES-REQUESTED
