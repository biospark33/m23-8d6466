# J4 round 1: Edge-Case Hunter report

Scope: `git diff origin/dev...HEAD` on `feature/j4-host-side-judgment-pack` (3 commits, 17 files).<br />
Focal tests: `bun test tests/autonomy/ tests/fleet/observe-ontick.test.ts tests/scripts/corpus/machine-state.test.ts tests/phase-engine/steering.test.ts` gave 171 pass, 0 fail (`/tmp/j4-ech.log`). Afterwards `find _bmad-output -newer <mark>` found nothing and `git status` was clean, so **test isolation holds**: no focal test writes into the real `_bmad-output/`.<br />
Scratch proofs are in `/tmp/j4-ech/` (`p1`–`p5`). Each was run with `bun <file>`. p3 ran from the scratch cwd `/tmp/j4-ech/cwd`.

## Findings

### ECH1-001 [MED] A timed-out onTick makes every later L7 ask in the pass miss, logged as `judge-failed`
- `src/autonomy/host-pack.ts:349-356` (missReason), `:409-413` (withCorpusLock), `src/fleet/observe.ts:716-727`
- Scenario: resident A's L7 ask outlives `ON_TICK_DEADLINE_MS`. This is reachable with a live client: `JUDGE_TIMEOUT_MS` is 30 s per attempt, there is one 429/529 retry, and retry-after can add up to 60 s. That is up to about 120 s against a 60 s tick deadline. `withTimeout` stops waiting, but the orphaned ask still holds the machine-state corpus lock in this process. When resident B's hook runs in the same pass, `acquireRunLock` throws `RunLockReentrantError`. That class does not extend `RunLockedError`, so `missReason` maps it to `"judge-failed"` and not to the documented `"corpus-locked"`. Every remaining resident in the pass loses its ask, and the log line gives the wrong cause.
- Evidence: `/tmp/j4-ech/p2.ts` ran a hook whose first judge never settles during the window, then called the hook for run-b. Output: `[{ runId: "run-b", miss: "judge-failed" }]`, `judge calls: 1`.
- Fix: map `RunLockReentrantError` to `corpus-locked`. Better, serialize asks through one in-process queue per corpus dir, or give `judge` an AbortSignal tied to the tick deadline so the orphan releases the lock.

### ECH1-002 [MED] L9 defaults write MOCK `arm:"jev"` records into the top-level triage corpus that ab-report counts
- `src/autonomy/l9-repo-sweep-triage.ts:153-154`, `:133-147`
- Scenario: `makeSweepTriageRanker()` with no deps uses a mock `JudgmentClient` and `corpusDir = DEFAULT_CORPUS_DIR`, which is the top level. Records land in `_bmad-output/judgment/corpus/x-rx.jsonl` with `arm:"jev"` and carry no answer_mode marker. `ab-report --all` reads every top-level `*.jsonl`, so mock answers enter jev cost, speed and crosstab. L8 deliberately avoids this with `L8_MOCK_CORPUS_DIR` (host-pack.ts:100-106), but L9 does not.
- Evidence: `/tmp/j4-ech/p3.ts` (cwd `/tmp/j4-ech/cwd`). Two `x-rx.jsonl` records came out with `arm:"jev"`, `labeler:"jev-1.13.0-l9-triage"`, and `loadScope` gave `ab-report jev records: 2 cost.jev: {"basis":"exact","n":2,...}`.
- Fix: mirror L8. Make the Judge seam carry `mode`, default to the `mock/` subdir when mock, and stamp `answer_mode` into the rationale.

### ECH1-003 [MED] L9 re-asks already-recorded hotspots on every `rank()` (paid when live), and the write is silently dropped
- `src/autonomy/l9-repo-sweep-triage.ts:201-211`
- Scenario: L9 has no `alreadyRecorded` pre-check, unlike L7 and L8. A second `rank()` over the same hotspots asks again. `appendRecord` then returns `"duplicate"`, which is ignored, and the line still logs `status:"ok"` with an answer. If a mock record already exists for a key, a later live answer for the same key (same labeler, `sweep:<path>`) is dropped as a duplicate after it was paid for.
- Evidence: in p3, two `rank()` calls produced `provenance entries: 4` but only 2 corpus records.
- Fix: check `recordKey` presence before the ask, as L7 and L8 do, and log a `duplicate` disposition.

### ECH1-004 [MED] The L7 idempotence key never dedupes across sweeps, so an unchanged state is re-asked every sweep
- `src/autonomy/host-pack.ts:437-439`, `:519`; `scripts/fleet.ts:1746` (`requestId = newRequestId()`, a fresh UUID per invocation)
- Scenario: `findingId = ${runId}@${sweepRequestId}`, and observe already calls onTick at most once per run per pass. The key can therefore never match an existing record, and the "avoids a second PAID ask" check is a no-op in production. With `fleet observe --all` on a cron, a resident above threshold gets one ask per sweep, even when the state is byte-identical (same `state_ref` digest). The `machine-state/x-rx.jsonl` file grows without bound, and each ask parses the whole file twice (`alreadyRecorded` and then `appendRecord`'s dedupe), which is O(n²) cumulative.
- Fix: key on `runId` plus the state digest, or on the journal's own flush stamp. Then a new ask happens only when the observed state changed.

### ECH1-005 [MED] L7 thresholds use catalog defaults, not the run's stamped resident bounds
- `src/autonomy/host-pack.ts:521-523`
- Scenario: the manifest can override `residentSpendCeilingMicros` (dispatch.ts:3077-3079) and `maxSteeringIterations` (0..MAX_RETRIES, resident-bounds.ts:197). The hook always passes `DEFAULT_RESIDENT_SPEND_CEILING_MICROS` (8,000) and `DEFAULT_MAX_STEERING_ITERATIONS` (3).
  - A run with `maxSteeringIterations: 1` can never reach `steeringIterationsMax >= 2`, so L7 stays silent exactly when the run is one retry from its cap.
  - A run with a 100,000 µ$ ceiling is asked at 6% spend.
  - The recorded corpus measures the wrong threshold.
- Fix: read the bounds from the run record or manifest stamp in `info.record`. When they are unavailable, record a miss rather than substitute defaults.

### ECH1-006 [MED] L7 asks about residents that are stopped or degraded
- `src/autonomy/host-pack.ts:515`; `ResidentStatus = "active" | "degraded" | "disabled" | "stopped"` (steering.ts:243)
- Scenario: only `"disabled"` is skipped. As the module header says, the resident block holds only the pre-walk seed until after run_end. The first block with real spend is therefore the post-run_end write, whose status is `stopped`, and it appears in the window before the marker settles the record. A resident `degraded` by a spend-ceiling breach also has spend ≥ 75%. In both cases L7 asks, and may record `would-signal compact`, for a resident that will never be solicited again. Those records pollute the corpus the recording-only phase exists to build.
- Fix: ask only when `status === "active"`, and record other statuses as `not-asked`.

### ECH1-007 [MED] "Recording-only" is not quite true in-box: an unarmed resident `compact` reply is now accepted and no longer trips a tripwire
- `src/phase-engine/steering.ts:142-144`, `:161-164`; `scripts/pipeline-run.ts:2527-2575`, `:4595-4615`
- Scenario: with `PACK_SIGNALS_ARMED=false`, a resident reply of `{"action":"compact"}` at `run_start` or `post_gate_failure` used to be an unrecognized action. That meant `directivesRejected += 1` and a `gate_bypass_attempt` tripwire row. It is now schema-valid and allowlisted, so it is counted in `directives`, raises no tripwire, writes no `resident_directive` trace row, and falls through the runner as proceed. The new tests confirm this (steering.test.ts diff: "compact at ${point} is accepted and counted", `directivesRejected` 0). The DD register line 16 admits that origin is not enforced, but the change is live in the box image regardless of the arming constant. The journal's directive and tripwire telemetry shift for any resident that emits it.
- Fix: until the arming PR lands an origin check, keep `compact` out of `POINT_ALLOWLIST`, so the schema member exists but is rejected at every point. Alternatively, reject a resident-originated `compact` with the existing tripwire.

### ECH1-008 [LOW] The unarmed hook adds box I/O inside the run lock for every unsettled run on every sweep
- `src/autonomy/host-pack.ts:503`, `scripts/fleet.ts:2234-2241`
- Scenario: the production wiring (`deps === undefined`) installs the hook unconditionally. The hook does a probe-then-cat SSH pair (up to `DEFAULT_PER_CALL_DEADLINE_MS` = 10 s) before any threshold or arming check, while observe holds the run lock. This lengthens the lock window in which a concurrent `fleet run/harvest/teardown` is refused, and it eats `SWEEP_WALL_CLOCK_BUDGET_MS`. Today the seed-only journal means the read almost never leads to an ask, so this is pure cost.
- Fix: accept and document it, or gate the read on `record` fields that show a resident is armed.

### ECH1-009 [LOW] The production CLI writes cwd-relative, mock-only records into tracked dirs
- `src/autonomy/host-pack.ts:225-229`, `scripts/corpus/merge.ts:45`, `src/judgment/emit.ts:30`
- Scenario: `fleet observe --all` with no deps builds a default `JudgmentClient`, which is always mock, and fleet.ts has no live path. It writes to relative `_bmad-output/judgment/corpus/machine-state/` and `_bmad-output/judgment/provenance/`. Run from the repo root, both are tracked dirs (`git ls-files _bmad-output/judgment` lists 119 files), so the tree gets dirty. Run from cron or `$HOME`, a stray `_bmad-output/` tree appears there. Every production record is `answer_mode:"mock"`, so the recording phase collects no real signal.
- Refuted sub-case: on a host with no box, `observe --all` has no unsettled candidates, onTick never fires, and nothing is written.
- Fix: anchor the dirs to the repo root or the runs dir, and make live an explicit flag.

### ECH1-010 [LOW] `appendRecord` accepts the machine-state arm into any dir, and one such line breaks `ab-report --all` for the whole corpus
- `scripts/corpus/merge.ts:158-175`; `scripts/judgment/ab-report.ts:108,120`
- Scenario: a misconfigured `machineStateCorpusDir` (or any caller) pointing at the top-level corpus appends a machine-state line to `x-rx.jsonl`. `readRecords` (triage-only) then throws, and every `ab-report --all` refuses.
- Evidence: `/tmp/j4-ech/p5.ts` printed `written`, then `ab-report --all: corpus file /tmp/j4-ech/tri/x-rx.jsonl line 1 failed schema validation: finding_text: Required; ...`.
- Fix: in `appendRecord`, refuse the machine-state arm unless `outDir` is a machine-state dir, or make ab-report skip machine-state lines through `CorpusRecordSchema`.

### ECH1-011 [LOW] One torn line in the machine-state corpus permanently disables L7, logged as `judge-failed`
- `src/autonomy/host-pack.ts:405-407`
- Scenario: `readCorpusRecords` throws a plain `Error` on a malformed line. `alreadyRecorded` runs on every ask, so every later L7 ask misses, and `missReason` mislabels the cause as `judge-failed`. No paid ask is wasted, because the check runs before `judge`. The miss reason hides an operator-actionable corpus fault.
- Fix: give corruption its own reason (`corpus-unreadable`).

### ECH1-012 [LOW] Some unobservable journal states are silent instead of recorded misses
- `src/autonomy/host-pack.ts:504`, `:509-513`
- Scenario 1: `readBoxFile` shapes "ssh never connected" (probeExit 255) and "SIGKILLed at budget" (137) as `{kind:"absent"}`, and the hook returns silently on `absent`.
- Scenario 2: a present but schema-invalid resident block (e.g. negative `spendMicros`, a string count) also returns silently, the same as "no resident".
- Fix: emit a `journal-absent-unproven` miss when `probeExit` is not in {undefined, 1}, and a `resident-block-invalid` miss when `resident` exists but fails the schema.

### ECH1-013 [LOW] L9 `finding_id` collides on paths longer than 300 chars, and scores are unvalidated
- `src/autonomy/l9-repo-sweep-triage.ts:113`, `:191`, `:134`
- Scenario 1: two hotspot paths sharing a 300-char prefix clip to the same `sweep:<path>` key. The second ask is paid for and then deduped away.
- Scenario 2: NaN and Infinity scores make the sort comparator inconsistent (`NaN || pathcmp`). In `/tmp/j4-ech/p4.ts` a NaN score sorted between 2 and 1.
- Fix: refuse over-cap paths as a miss rather than clip them into another key, and refuse non-finite scores.

### ECH1-014 [LOW] The opensrc walk is called "bounded" but is not
- `src/autonomy/l9-repo-sweep-triage.ts:274-282`, `:357-365`
- Scenario: `defaultListFiles` does a synchronous recursive readdir plus `statSync` of the entire package tree before `.slice(0, MAX_OPENSRC_SPANS)`, which blocks the event loop on large packages. The file names are third-party controlled and pass `SAFE_REL`, which allows words and `..`. They egress as `ac-prose`, which is a small prompt-injection surface (e.g. `patch-this-now.js`). No filesystem traversal is reachable, because readdir never yields `..`.
- bun.lock probing (p4) found no defect: scoped `1.2.3` resolved, git/workspace/alias entries gave `undefined`, trailing commas and commas inside strings were handled, and malformed JSONC threw and was caught as `lockfile-unreadable`.
- Fix: stop walking at a file cap, and fix the comment.

### ECH1-015 [LOW] A live ask orphaned at CLI exit is paid for but never recorded
- `scripts/fleet.ts:6383` (`process.exit(await run(...))`)
- Scenario: when onTick times out on the last resident, `run` returns and `process.exit` kills the in-flight ask. Billing happens, but no record and no provenance are written.
- Refuted sub-claim (p1): the corpus lock is NOT left stale. run-lock's exit handler releases held locks on `process.exit`, and a fresh process acquired the lock immediately (`/tmp/j4-ech/p1-child.ts` then `p1-parent.ts`; the parent reached its judge).
- Fix: an AbortSignal on the tick deadline (same as ECH1-001).

### Armed-only notes (no finding while `PACK_SIGNALS_ARMED=false`)
- `l8Prefilter` (host-pack.ts:559-561, :605): `wouldKeep` is keyed on the bare `findingId`, so findings from two runs that share an id collide. An `alreadyRecorded` finding is always kept, whatever its recorded answer. Both matter only once armed.
- L8, the sanity leg, L9 and opensrc have no production caller (grep of src/ and scripts/ outside src/autonomy). Only L7 is wired.

**Verdict: no BLOCKER/HIGH. 7 MED, 8 LOW. Not merge-ready as "recording-only" until ECH1-007 is resolved; ECH1-001 to 006 should be fixed or explicitly deferred.**
