# J4 Round 2 — Blind Hunter report

Scope: the code in `/tmp/j4-r2.diff` (scripts/corpus/*, scripts/fleet.ts, src/autonomy/host-pack.ts, src/autonomy/l9-repo-sweep-triage.ts, src/fleet/observe.ts, src/phase-engine/steering.ts, and the tests). Review and spec files were not read. Each claim below was checked against the full source in `wt-j4`.

Checked and found sound: the onTick bound (readBoxFile shares one deadline across probe and cat, so 10 s + 40 s < 60 s); the L7 corpus lock, which `withCorpusLock` releases in `finally` even on an `ask-deadline` rejection; the late-rejection guard in `withTimeout`; the compact refusal by origin in `solicit()`, which runs before the schema; the journal reads, which are atomic tmp+rename writes, so the host never sees a half-written JSON document; runId path traversal, which `assertMachineState` blocks before `l7ShardDir` (the id grammar must start with an alphanumeric); and the `appendRecord`/`appendMachineStateRecord` arm separation.

---

### BH2-001 [MED] L9 hotspot cap counts already-recorded items, so hotspots past index 50 are never judged

`src/autonomy/l9-repo-sweep-triage.ts:227` (cap check) runs before `:240` (already-recorded check).

`i` is the position in the deterministic order, and the `i >= MAX_HOTSPOTS_PER_CALL` check runs before the already-recorded skip. Scenario: a sweep with 80 stable hotspots. On call 1, items 0–49 are asked and recorded, and items 50–79 are logged `capped`. On call 2, items 0–49 are logged `already-recorded` and cost nothing, but items 50–79 are still at `i >= 50` and are `capped` again. Call N repeats this. The tail of any input longer than 50 can never enter the corpus unless the head's briefs change, so the cap does not bound per-call spend as intended. It permanently starves the tail.

Fix: count asks instead of positions. Keep an `asked` counter that only increments when `client.judge` is actually called, run the cap check after the already-recorded and non-finite skips, and add a test with more than 50 hotspots that calls `rank()` twice and asserts the tail is asked on the second call.

### BH2-002 [MED] The onTick hook runs inside the per-run invocation lock, so teardown and harvest are refused for up to 60 s per resident per pass

`src/fleet/observe.ts:733` (the hook is awaited inside the candidate's run lock; `tests/fleet/observe-ontick.test.ts` "runs inside the run's lock" pins this).

The hook does a box read (≤10 s) plus a model ask (≤40 s). Neither one needs the run lock: it reads the box journal and writes its own corpus shard under its own lock. Holding `<runsDir>/<runId>.lock` across a judgment call means an operator's `fleet teardown <run>` or `fleet harvest <run>` issued during a pass gets `run-locked` for up to `ON_TICK_DEADLINE_MS`. Each further unsettled resident widens that window again. Before J4, the lock was held only for the marker read and the chain. For a recording-only leg, that is a real availability regression on destructive operator verbs.

Fix: collect the tick infos inside the lock, then call the hooks after the lock is released, or at the end of the pass, still deadline-bounded and fault-isolated. Alternatively, document the lock hold as deliberate and state why the hook needs the lock.

### BH2-003 [MED] An L9 judge without a `mode` silently resolves to the MEASURED corpus

`src/autonomy/l9-repo-sweep-triage.ts:77`, `:183` (`resolveTriageCorpusDir(client as { mode?: string }, …)`). The L9 `Judge` interface (`:1115` of the diff) does not declare `mode`.

`resolveTriageCorpusDir` treats any `mode !== "mock"` as live. That includes `undefined`, and any structural wrapper (spy, counting proxy, retry decorator) around a mock `JudgmentClient` has no `mode`. Scenario: a caller wraps the mock client to count calls and omits `corpusDir`. Mock `arm: "jev"` TriageRecords are then appended to the top-level `x-rx.jsonl` that ab-report reads, so they enter a measured-agreement denominator. This is the failure the mock subdir exists to prevent. host-pack's `Judge` makes `mode` required. L9's does not, and the `as` cast hides the gap from the type checker.

Fix: make `mode: "live" | "mock"` required on L9's `Judge`, and fail closed by sending anything other than an explicit `"live"` to the mock dir. Add a test where a mode-less judge with no `corpusDir` resolves under `mock/`.

### BH2-004 [LOW] L9's default client takes J1's cwd-relative provenance dir and the 2×JUDGE_TIMEOUT default

`src/autonomy/l9-repo-sweep-triage.ts:181`: `new JudgmentClient({ provenanceDir: deps.provenanceDir })`.

When `provenanceDir` is undefined, the client falls back to `DEFAULT_PROVENANCE_DIR`, which is relative to cwd (`client.ts:124`). The module claims "Defaults anchor to the factory repo … never cwd" (line 1078 of the diff), and that holds for the corpus dir but not for provenance. Run from a dispatched repo's cwd, the provenance files land in that repo's worktree. host-pack fixed exactly this (`deps.provenanceDir ?? PACK_PROVENANCE_DIR`).

Fix: `provenanceDir: deps.provenanceDir ?? resolve(FACTORY_ROOT, DEFAULT_PROVENANCE_DIR)`. Optionally also pass an explicit `timeoutMs`, because the lock is held across up to 50 sequential asks.

### BH2-005 [LOW] L8 holds the corpus lock across an unbounded number of un-deadlined asks

`src/autonomy/host-pack.ts:680` (`withCorpusLock(ctx.corpusDir, …)` around the loop) and `:693` (`ctx.client.judge` with no `withTimeout`).

L7 got a per-ask deadline in round 1, but L8 did not. `findings` has no count cap, and each live ask can take 2 × `PACK_JUDGE_TIMEOUT_MS` plus the retry delay. For that whole time, the triage-corpus lock (shared `CORPUS_LOCK_ID` with merge.ts and L9) refuses every other corpus writer. There is no production caller yet, so the severity is LOW. The first caller inherits this.

Fix: wrap each L8 ask in `withTimeout(…, ctx.l7AskDeadlineMs-equivalent)`, cap findings per call, or both, as L9 does with `MAX_HOTSPOTS_PER_CALL`.

### BH2-006 [LOW] The production L7 leg cannot fire mid-run, yet it costs a box read pair per unsettled run per pass, and the e2e fixtures model a journal the engine never writes

`src/autonomy/host-pack.ts` header (the resident block mid-run is the pre-walk SEED), `:645` and following. Fixtures: `tests/autonomy/host-pack.e2e.test.ts:45` (`spendMicros: 6_800`) and `tests/autonomy/fleet-observe-pack.test.ts:36` (`6_900`).

The module itself documents that mid-run the journal's `resident` block is the pre-walk seed. Seed spend is 0 and `steeringIterations` is empty, so `l7ShouldAsk` is false on every real mid-run tick. Production `fleet observe --all` (`deps === undefined` → hook wired) still pays the probe+cat for every unsettled run on every pass, and with BH2-002 it holds the run lock while doing so. The DoD e2e tests pass only because they seed a mid-run resident block with past-threshold spend, which is a state the current engine cannot produce. The green e2e therefore does not show that the leg ever records anything in production.

Fix: state this plainly next to the e2e fixture, or gate the hook off (no read) until the engine flushes the resident block per op. Do not present the e2e as evidence of production behavior.

### BH2-007 [LOW] A deadline-abandoned L7 ask can still be paid and provenance-emitted, then re-asked on the next tick

`src/autonomy/host-pack.ts:548` (`withTimeout(ctx.client.judge(...), …)`).

`withTimeout` cannot cancel the HTTP request. After the 40 s abandon, the orphaned `judge` may complete, emit a provenance file and `ceiling.record` its tokens. No corpus record is written, because the locked callback already rejected. On the next tick the state is not "unchanged" (nothing was recorded), so the same state is asked and paid for again. This leaves a provenance entry with no matching corpus record. The header's R1-22 note covers CLI exit, not this in-process path.

Fix: pass an `AbortSignal` into `judge` if the client supports one. Otherwise, document the double-pay and orphaned-provenance case alongside R1-22.

### BH2-008 [LOW] The "env arming does not exist" test cannot fail for any realistic regression

`tests/autonomy/host-pack.test.ts:303`.

The test sets an invented variable, `QDS_JUDGMENT_PACK_ARMED`, and asserts that nothing changes. A regression that reads any other name (`QDS_PACK_ARMED`, `JUDGMENT_ARMED`, a config file) passes this test. The real guard is the source scan in the preceding test (`process.env|Bun.env|readFileSync(...json|yaml|env)`), and that scan misses `import.meta.env`, `Bun.file(...)`, and env reads in imported helpers. As written, the test is a tautology dressed as a negative control.

Fix: delete it or fold it into the scan test. Extend the scan to `import.meta.env` and `Bun.file`.

---

**Counts:** BLOCKER 0 · HIGH 0 · MED 3 · LOW 5

**Verdict:** CHANGES-REQUESTED. BH2-001 through BH2-003 are cheap, real fixes. Nothing found blocks on safety: the pack stays recording-only, its egress stays fenced, and no lock is left orphaned.
