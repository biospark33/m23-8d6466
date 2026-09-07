# Blind review — PR 135 tests chunk A (fleet resident + engine steering)

Scope reviewed (diff only, no repo access):
- `_bmad-output/workflow-state/code-review/pr135/chunk-tests-fleet.diff` → `tests/fleet/fixtures/fake-pi-resident.ts`, `tests/fleet/resident.test.ts`
- `_bmad-output/workflow-state/code-review/pr135/chunk-tests-engine-a.diff` → `tests/phase-engine/fixtures/fake-resident.ts`, `tests/phase-engine/fixtures/pi-catalog/openrouter.json`, `tests/phase-engine/fixtures/pipeline.resident.json`, `tests/phase-engine/steering.test.ts`

Line numbers below are approximate line numbers in the NEW file.

---

### [HIGH] e2e pipeline fixture uses a fixed, shared `$TMPDIR` counter file — cross-run pollution and steering-attribution confound
- Location: `tests/phase-engine/fixtures/pipeline.resident.json:21-25` (`testCommand`)
- Detail: The build gate's success condition is `test "$n" -ge 2` where `n` is read from the fixed path `$TMPDIR/qds-resident-fixture-count`. That path is (a) not scoped to the run/session/PID, (b) never cleaned up by anything visible in this diff, and (c) shared by every test file and every CI job on the same machine. Two consequences:
  1. **Stale state flips the scenario.** A previous run (or a crashed run, or a parallel shard) leaves `n >= 2` on disk; the next run's build gate passes on attempt 1 with zero steering and zero retries. A test asserting "steering caused a retry" then either fails intermittently or — worse — a test asserting only "pipeline succeeded" passes vacuously without the resident doing anything.
  2. **The fixture cannot attribute the pass to steering.** `retries: 1` on the build phase means the built-in phase-retry mechanism alone reaches attempt 2 (`n=2`) and passes. Any test claiming the resident's `retry` directive caused the gate to pass is confounded: plain engine retry produces the identical observable outcome. If the point of the fixture is to prove resident-driven re-steering, the pass condition must be reachable *only* via the steering path (or the counter must be reset by the solicitation, which nothing here shows).
- Trigger: run the e2e test file twice on one machine (or two `bun test` shards on one host). Second run: build gate passes on its first invocation; "resident steered the retry" assertions are then wrong in whichever direction the leftover count lands.

### [HIGH] `stop()` test cannot detect a no-op kill, and has a spawn/kill race
- Location: `tests/fleet/resident.test.ts:325-342` ("stop() SIGKILLs the in-flight call")
- Detail: Two independent problems.
  1. **Non-discriminating assertions.** The fake runs in `hang` mode with *no* `QDS_RESIDENT_TIMEOUT_MS` override (afterEach resets it; nothing sets it here), so the default timeout (60 s per the steering fixture's error text) applies. If `stop()` were a complete no-op, `pending` would still reject — at the default timeout — with `exitStatus === "transient"`. Both assertions (`rejects.toThrow()`, `exitStatus` "transient") then pass. The test therefore cannot distinguish "stop() killed the child" from "the default timeout killed the child"; the only observable difference is ~60 s of wall clock, which nothing asserts. This is the *only* test covering the DF3.6 kill path, so a regression that breaks `stop()` ships green.
  2. **Race on child existence.** `const pending = spawn.caller.call(PROMPT); await spawn.stop();` relies entirely on the comment's claim that `call()` reaches `Bun.spawn` synchronously. Nothing enforces it: if `call()` ever gains a single `await` before the spawn (async prompt persistence is the obvious candidate, since §5.2 persistence is in this path), `stop()` fires before any child exists, the kill is silently dropped, and the test still passes via the timeout. No spy, no elapsed-time assertion, no `signal === "SIGKILL"` check pins the mechanism.
- Trigger: replace `stop()`'s body with `return Promise.resolve()`. The test suite stays green (just slower). Similarly, insert `await Promise.resolve()` at the top of `call()` — the kill misses and the test still passes.

### [MEDIUM] `fake-resident.ts` `-p` guard is dead: exit code 2 is clobbered to 0 and the fixture replies anyway
- Location: `tests/phase-engine/fixtures/fake-resident.ts:26-31` (guard) and `:116` (`process.exitCode = Number(...) || 0`)
- Detail: The missing-`-p` branch sets `process.exitCode = 2` but does **not** return — execution continues, appending a session marker and emitting a full scripted reply. Then the last line unconditionally overwrites `process.exitCode` with `Number(FAKE_RESIDENT_EXIT ?? 0) || 0`, i.e. `0` unless the env knob is set. Net effect: an invocation with no prompt writes to the session file, prints valid NDJSON, and exits 0. The fixture lies in both directions: a regression in the resident that drops `-p` from argv would still get a perfect reply from this fixture, and no test can observe the intended exit 2.
- Trigger: spawn the fixture with no `-p`: stderr says `-p <prompt> is required`, stdout still carries `message_end` with the default `{"action":"proceed"}`, and `$?` is 0, not 2.

### [MEDIUM] Both fixtures silently fall back to defaults on malformed env scripting — vacuous-pass generator
- Location: `tests/phase-engine/fixtures/fake-resident.ts:54-66` (`scriptedReplies`) and `:68-87` (`scriptedUsage`); same pattern in `tests/fleet/fixtures/fake-pi-resident.ts:44-46` (`Number(... ?? 7)` on garbage → `NaN` propagates silently)
- Detail: A typo'd or malformed `FAKE_RESIDENT_REPLIES` (bad JSON, `["a", 2]`, `[]`) makes the fixture quietly reply `{"action":"proceed"}` with usage 1000/64. Any test that *expects* proceed/defaults passes even though its scripting never took effect — the classic fixture-that-lies. There is no stderr warning, no marker event, nothing distinguishing "scripted proceed" from "fallback proceed". `fake-pi-resident.ts` is worse: `Number("abc")` is `NaN`, which flows into the emitted usage and only fails if a test asserts exact tokens.
- Trigger: set `FAKE_RESIDENT_REPLIES='[{"action":"abort"}]'` (objects, not strings) in a test expecting `abort`. The fixture emits `proceed`; a "defaults to proceed" assertion passes while the tested scenario never ran.

### [MEDIUM] Closed-union adversarial path undertested: no missing/wrong-typed required-field cases on KNOWN actions
- Location: `tests/phase-engine/steering.test.ts:69-86` (schema suite), `:144-163` (AC2 rejection suite)
- Detail: Every acceptance case supplies all fields (`retry` + `guidance`, `select_roster` + `phase` + `rosterId`, `abort` + `reason`) and every rejection case uses an unknown `action` or an unknown extra field. Nothing tests the shapes a model actually produces when it is being sloppy-but-plausible: `{"action":"retry"}` with no `guidance`, `{"action":"select_roster","phase":"build"}` with no `rosterId`, `{"action":"abort"}` with no `reason`, `{"action":"retry","guidance":42}` (wrong type), `{"action":42}` (non-string action). If the schema leaves any of those optional or coercible, the engine accepts an *empty* retry/abort directive — a steering decision with no payload — and none of these tests notice. The gate-bypass tripwire path is only exercised for unknown action names, which is the least likely malformation.
- Trigger: `SteeringDirectiveSchema.safeParse({ action: "retry" })` — if that returns `success: true`, the engine executes a guidance-free retry and the suite is silent about it.

### [MEDIUM] `steeringIterations` tested with a single retry — increment vs overwrite indistinguishable
- Location: `tests/phase-engine/steering.test.ts:100-114` ("retry increments steeringIterations[phase]")
- Detail: The test solicits once with `phase: "build"` and asserts `{ build: 1 }`. An implementation that *assigns* `1` instead of *incrementing* produces the identical object. The counter's entire purpose is to bound per-phase steering, so the second-iteration behavior (`{ build: 2 }`, or a cap refusing a third) is the actual contract, and it is untested. Also untested: whether a `select_roster` or `abort` directive carrying a `phase` bumps the counter (if the field is named `steeringIterations`, the answer matters).
- Trigger: two consecutive `retry` directives with `phase: "build"`. An overwrite bug yields `{ build: 1 }` again; every test in the file passes.

### [MEDIUM] Malformed-attempt counter reset across solicits is untested — carryover bug invisible
- Location: `tests/phase-engine/steering.test.ts:204-216` ("two consecutive malformed") and `:218-226` ("malformed once, then valid")
- Detail: The sticky-degradation test covers "2 malformed in one solicit, then no more calls ever". The recovery test covers "1 malformed + 1 valid in one solicit". Nothing covers a *second* solicitation after a recovery: if the malformed counter is not reset per solicit, then in a later solicit a single malformed reply immediately degrades the resident (1 attempt instead of 2), cutting off the correction attempt the AC3 contract promises. A stateful-counter bug (the easiest way to implement `MAX_MALFORMED_ATTEMPTS`) passes the entire file.
- Trigger: solicit A = `["garbage", '{"action":"proceed"}']` (recovers, `status: "active"`); solicit B = one malformed reply. Correct behavior: 2 calls, still active after B's correction. Buggy carryover: 1 call, degraded.

### [MEDIUM] The two fixtures emit different, overlapping usage-bearing event sets — double-count paths untested on both sides
- Location: `tests/phase-engine/fixtures/fake-resident.ts:107-114` vs `tests/fleet/fixtures/fake-pi-resident.ts:55-82`
- Detail: The fleet fake emits `message_start` / `message_update` / `toolResult` / `message_end`, each carrying usage 9999, and the fleet test does pin that only `message_end` counts (good). But the fleet fake never emits `agent_end`. The engine fake emits `message_start` / `message_end` / `agent_end`, with the *same* usage object on `agent_end` — and nothing in these chunks asserts the engine-side total excludes it. The fake's own header claims "usage on message_end ONLY, so no double count", but the fixture *supplies* usage on `agent_end` without any test consuming the total, so the claim is asserted nowhere. Whichever harvest implementation (fleet `harvestPiStream` vs engine steering caller) reads the engine fixture could sum both blocks and every test here stays green. The two fixtures should share one event script so the union (all decoy events + `message_end` + `agent_end`) is exercised by one assertion on the exact total.
- Trigger: engine-side caller sums `message.message.usage` across `message_end` and `agent_end` → tokens double (2000/128 instead of 1000/64); spend doubles; no test in these chunks fails.

### [MEDIUM] No behavioral session-continuity test — the "session FILE is the continuity" claim is only argv-pinned
- Location: `tests/fleet/resident.test.ts:288-306` ("session path is per-runId")
- Detail: The test asserts the argv *contains* the per-runId session path. The fleet fixture (`fake-pi-resident.ts`) never writes to `--session`, so continuity is unverifiable through it: no test issues two `caller.call()`s on one `ResidentSpawn` and checks the second reuses/appends to the same session, and no test proves a *new* runId gets a *fresh* session rather than appending to the old one. The engine fixture *does* append invocation markers to the session file precisely to make this observable — but it is not used in the fleet suite. The strongest claim in the test title is therefore untested.
- Trigger: resident regresses to `runId = randomUUID()` per call (new session each turn). `readRecord(sub).argv` still contains `join(sessionDir, "${runId}.resident.jsonl")` on the first call; the test passes; multi-turn steering loses all context in production.

### [LOW] µ$ rounding boundary (x.5) untested on the money path
- Location: `tests/phase-engine/steering.test.ts:250-259` ("fractional products round to integers")
- Detail: The fractional case is `1111 × 100000 / 1e6 = 111.1 → 111`, which every rounding mode (round, floor, trunc) produces. A `1115 → 111.5` case would pin half-up vs banker's vs floor. For a spend meter, the tie case is where implementations diverge, and it is exactly the case missing.
- Trigger: swap `Math.round` for `Math.floor` in the metering code; all three metering tests still pass.

### [LOW] Env cleanup via `= undefined` does not reliably delete the key
- Location: `tests/fleet/resident.test.ts:87-95` (afterEach: `process.env.QDS_RESIDENT_TIMEOUT_MS = undefined; process.env.QDS_PI_BIN = undefined`)
- Detail: Node's documented `process.env` setter converts values with ToString, so assignment of `undefined` leaves the key present as the string `"undefined"` (Bun aims for Node parity but has historically diverged here). If the key survives as `"undefined"`, then `Number("undefined")`/`parseInt` paths in the resident get `NaN` (likely falling back to the default — silent), and `QDS_PI_BIN="undefined"` would make any later `bin`-less spawn fail as ENOENT instead of using the real default. Currently contained (every later test passes `bin` explicitly), but the cleanup is not actually a cleanup. Use `delete process.env.X`.
- Trigger: reorder the file so a `bin`-less test runs after the `QDS_PI_BIN` test, on a Bun version that stringifies: the spawn target is the literal string `"undefined"`.

### [LOW] Child env is not scrubbed of fixture knobs inherited from the developer shell
- Location: `tests/fleet/resident.test.ts:161-166` (`piEnv` spreads `process.env`)
- Detail: `piEnv` passes the whole parent env through, so `QDS_FAKE_PI_MODE=hang` or `FAKE_RESIDENT_EXIT=3` exported in a developer's shell silently re-scripts every fixture spawn: with `QDS_FAKE_PI_MODE=hang`, each non-timeout fleet test blocks for the full default timeout (~60 s each) before failing on unexpected `transient`. Same exposure for the engine fixture env built in the e2e paths.
- Trigger: `QDS_FAKE_PI_MODE=garbage bun test tests/fleet/resident.test.ts` — the harvest test now sees `raw: ""` and fails for a reason unrelated to the code under test.

### [LOW] Timeout test accepts any rejection; the 500 ms override depends on when `resident.ts` reads env
- Location: `tests/fleet/resident.test.ts:279-293` ("timeout SIGKILL → 'transient'")
- Detail: `rejects.toThrow()` does not distinguish a timeout error from an ENOENT, a spawn failure, or a redaction crash — the test would pass if the timeout mechanism were removed and something else threw. Additionally, `QDS_RESIDENT_TIMEOUT_MS = "500"` is set *inside* the test body; if `resident.ts` reads the env at module load rather than at `startResident`/`call` time, the override is ignored and the test silently degrades to the 60 s default (still passing, 120× slower). Note also that `piEnv()` propagates `QDS_RESIDENT_TIMEOUT_MS=500` into the child env, where it is inert but confusing.
- Trigger: change `resident.ts` to `const TIMEOUT = Number(process.env.QDS_RESIDENT_TIMEOUT_MS ?? 60_000)` evaluated at import time; the suite takes ~60 s longer and stays green — nobody notices the seam is dead.

### [LOW] `cacheWrite` disagrees between the catalog fixture and the injected rate sources for the same model
- Location: `tests/phase-engine/fixtures/pi-catalog/openrouter.json:8` (`"cacheWrite": 0`) vs `tests/fleet/resident.test.ts:135` (`cacheWrite: 0.018`)
- Detail: Two fixtures describe the same model (`deepseek/deepseek-v4-flash-0731`) with different `cacheWrite` rates. No test in these chunks compares them (the fleet tests assert only `inputPerMTok`/`outputPerMTok`), so nothing fails today — but one of the two is fabricated incorrectly, and any future test that resolves rates through the catalog fixture and compares against `TEST_SOURCES` (or asserts cache-write metering) will chase a phantom mismatch.
- Trigger: add a test asserting the full rate row resolved from the catalog fixture; it disagrees with `TEST_SOURCES.bundled` on `cacheWrite`.

### [LOW] Self-referential assertion dressed as a schema check
- Location: `tests/fleet/resident.test.ts:136` (`expect([...TEST_SOURCES.bundled.entries.keys()]).toEqual(["openrouter/deepseek/deepseek-v4-flash-0731"])`)
- Detail: This asserts the exact array the test constructed four lines earlier. It is only non-vacuous insofar as it pins `DEFAULT_RESIDENT_SLUG === "deepseek/deepseek-v4-flash-0731"` — which the comment does not say, and which would be clearer as `expect(DEFAULT_RESIDENT_SLUG).toBe("deepseek/deepseek-v4-flash-0731")`. As written it reads like it validates the fixture's key shape against a real host convention, but it validates nothing external.
- Trigger: none — it cannot fail while the literal and `DEFAULT_RESIDENT_SLUG` agree.

### [LOW] `enabled()` blind cast narrows a union by one property only
- Location: `tests/fleet/resident.test.ts:170-176`
- Detail: The guard rejects only the `disabled` variant; any *other* variant the `startResident` union grows (e.g. a `refused`/`no-rates` shape) sails through the cast and then fails later with an opaque `spawn.caller` undefined error at the `.call()` site. The helper also hides that `expect(...).not.toHaveProperty("disabled")` on a non-object result behaves differently across runners.
- Trigger: add a third union member to `startResident`'s return and return it when, say, the session dir is unwritable — `enabled()` casts it and the failure surfaces as a TypeError deep in the test, not as the intended contract assertion.

### [LOW] `select_roster` rejection does not assert single-attempt (unlike the unknown-action rejections)
- Location: `tests/phase-engine/steering.test.ts:276-283`
- Detail: The AC2 loop pins `calls() === 1` for unknown actions ("no reparse for schema rejections"), but the out-of-set `rosterId` case — a *known* action with a bad payload, a different code path in the validator — asserts only the directive, the reject count, and the tripwire detail. If that path re-solicits (burning a correction attempt, double-metering) nothing catches it.
- Trigger: add a reparse loop on the rosterId branch: `calls()` becomes 2, `spendMicros` doubles, all assertions in this test still hold.

### [LOW] `scriptedCaller` repeats the last step silently and dereferences `undefined` on an empty list
- Location: `tests/phase-engine/steering.test.ts:44-59`
- Detail: `steps[Math.min(calls, steps.length - 1)]` means an under-specified script silently replays its last reply, so a test intending "one call, then stop" still passes if the implementation over-calls (only the explicit `calls()` assertions catch it, and not every test makes one). With `steps: []` the index is `-1` and the helper throws `Cannot read properties of undefined` — an unhelpful failure unrelated to the contract.
- Trigger: `scriptedCaller([])` → TypeError at the first `call()`, reported as a test crash rather than a scripted-fixture error.

### [LOW] Truncation priority is untested: only a single over-ceiling line is exercised
- Location: `tests/phase-engine/steering.test.ts:275-298`
- Detail: The ceiling suite tests one 20 000-char line and one short two-line case. It never tests (a) many moderate lines whose *joined* total exceeds the cap — does truncation drop trailing lines, and are later, more safety-relevant lines (e.g. the roster id list, the closed-action enumeration) placed before or after the context so they survive the cut? (b) whether `rosterIds`/the allowed-action list appear in the prompt at all. A truncation that eats the closed-set instruction when context is large would let the model emit an action the schema then rejects — fail-closed, but with a silent 100 % rejection rate on long runs, and no test would see it.
- Trigger: `promptContext: ["a".repeat(7000), "b".repeat(7000), "c".repeat(7000)]` — which lines survive is unspecified and unpinned.

### [LOW] `onTripwire` throwing, and metering of the correction attempt after a malformed reply, are unpinned
- Location: `tests/phase-engine/steering.test.ts:218-226` (recovery test asserts no `spendMicros`) and `:144-163` (no throwing-observer case)
- Detail: The recovery test ("malformed once, then valid") asserts directive/status/counters but never `spendMicros`, so "every reply pays" is only proven for the reject+malformed sequence, not for the malformed+correction sequence. And if a consumer-supplied `onTripwire` throws, nothing establishes whether `solicit` survives or takes the whole run down — a plausible production crash given the callback is invoked from inside the engine loop.
- Trigger: `onTripwire: () => { throw new Error("telemetry down") }` on a gate-bypass reply — behavior undefined by this suite.

### [LOW] Hang mode in the engine fixture skips the session marker, shifting invocation indices
- Location: `tests/phase-engine/fixtures/fake-resident.ts:89-92` vs `:44-56`
- Detail: The `FAKE_RESIDENT_HANG=1` check runs *before* `invocationIndex`, so a hung attempt leaves no marker in the session file. In a hang-then-retry sequence the surviving invocation is numbered as if the hung one never happened, so a reply script such as `["retry-after-timeout"]` must be authored without an entry for the timed-out attempt. That asymmetry is undocumented (the header says replies are consumed "in invocation order") and is an easy off-by-one for whoever writes the hang/retry e2e.
- Trigger: script `FAKE_RESIDENT_REPLIES='["x","retry"]'` expecting the post-hang call to get `"retry"`; it gets `"x"`.

### [LOW] `pi-catalog/openrouter.json` is not referenced by anything in the reviewed chunks
- Location: `tests/phase-engine/fixtures/pi-catalog/openrouter.json:1-12`
- Detail: Neither test file in these chunks loads this fixture, so I cannot confirm a consumer exists. If nothing globs `tests/phase-engine/fixtures/pi-catalog/`, it is dead weight that still encodes a (partly wrong, see the cacheWrite finding) rate row. Also note its nesting (`openai-completions` → model id → `cost`) is a *different* shape from `RateSources`' flat `${providerId}/${id}` keys the fleet test pins, so it is presumably mimicking the raw `~/.pi/agent/models.json` layout — worth one assertion somewhere that the loader actually reads this directory.
- Trigger: `grep -r "pi-catalog" tests/ src/` — if the only hit is the file itself, delete it or wire it to a loader test.
