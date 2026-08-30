# R3 — Completed-story examples (Track C) for DF3.3

Compiled 2026-08-27. Sources: DF3.2 story + `src/fleet/*` + `tests/fleet/*` + e2e audit artifacts;
DF1.6 `cli-anything/scripts/team-lead-driver.ts`; `_bmad-output/workflow-state/qds-dev/df3-2/`.

---

## 1. DF3.2 — patterns to copy verbatim

### 1.1 Test-file structure (one suite per module contract)

| Suite | Owns | Precedent |
|---|---|---|
| `tests/fleet/fanout.test.ts` | store + lock choreography (wave-1a scope) | header block lists coverage per integration-spec D14 inventory (`fanout.test.ts:1-27`) |
| `tests/fleet/patterns.test.ts` | the three patterns over the primitive | `patterns.test.ts:1-15` — explicitly says which suites own what |
| `tests/fleet/rank.test.ts` | rank math to 6 dp | per-AC isolation |
| `tests/fleet/verbs.test.ts` | registry pinning: EXPECTED_FLAGS / EXPECTED_EXIT_CODES, every declared code probed | story Dev Record, `df3-2-...md:328` |
| `tests/fleet/cli.test.ts` | front-door e2e through `run(argv)` DI seams | `df3-2-...md:329` |

DF3.3 mapping: `tests/phase-engine/steering.test.ts` (port + 3 points + AC2 schema rejections +
AC3 degradation), `tests/fleet/resident.test.ts` (spawn/roster/telemetry), fixture `fake-resident.ts`.

### 1.2 Fixture rules (proven over 7 review rounds)

- **Fakes stay LOCAL to the file** (orchestrator ruling C3): "the choreography each suite forces is
  planted here, not in a shared module" (`tests/fleet/fanout.test.ts:2-4`). Shared = generic helpers
  only: `tests/fleet/helpers.ts` (`recordingLedger` :42, `goodLedger` :81, `deadPid` :171, `liveChild`
  :190 — every fake RECORDS what it was asked, snapshots args via `structuredClone` :60).
- **Real fakes that exist already**: `FakeDriver` from `src/providers/fake-driver.ts`
  (`patterns.test.ts:32`), `FakeKeyApi` from `tests/providers/fixtures/fake-key-api.ts` (:36).
- **Constants IMPORTED from source, never mirrored** (`fanout.test.ts:26` — "Constants are IMPORTED
  from source (FLEET_LOCK_STALE_MS), never mirrored"). For DF3.3: import prompt-char cap, reparse
  count, timeout constants from `src/phase-engine/steering.ts`.
- **Full-valid-record factory**: `makeRecord(overrides)` builds a complete valid object, tests
  override one field (`fanout.test.ts:63-80`). Copy for journal `resident` blocks.
- **No sleeping**: injected poll timings `TICK_MS = 10; DEADLINE_MS = 200` (`patterns.test.ts:59-61`);
  lock age from a *planted* `createdAt` — "no sleeping, no clock seams: age comes from the planted
  createdAt" (`fanout.test.ts:88-107`).
- **Interleaving is FORCED through seams, never natural timing** (`patterns.test.ts:12-14`). Races
  use a seam barrier parked at the only `await` before the critical section (AC8 test,
  `patterns.test.ts` concurrent block; DF3.3 needs this for "resident killed mid-run").
- **Marker planting**: a FakeDriver subclass "whose box directory IS the box's root filesystem …
  'planting a marker in the box' is writing that file" (`patterns.test.ts:125-135`). Analogous
  trick for fake-resident: the fake IS the reply stream.
- **Proxy wrapper for partial fakes**: `boundProxy(target, {get})` overrides one method while keeping
  `this` bound (`patterns.test.ts:69-78`); `hungProbeDriver` (:96-114) and `brokenListDriver`
  (:81-93) are the precedents for "resident unreachable" / "resident times out".
- **Mutation-verify every new assertion goes RED against pre-fix source** (playbook §4.6, pinned as
  repo doctrine in DF3.2 rounds 5b: "mutation-verified RED pre-fix", story `df3-2-...md:744`).

### 1.3 e2e demo (MANDATORY DoD item) — how DF3.2 captured it

- Drive the **real CLI front door** — `run()` (the function `import.meta.main` binds) — in a temp
  cwd, fakes injected via the CLI's own DI seams; argv/flags/output/exit codes are production paths
  (story `df3-2-...md:344-348`).
- Capture **verbatim** command lines + stdout blocks into the Dev Agent Record (:349-390), then an
  arithmetic check against the AC (:388-390).
- **"Honest deltas (not fabricated)"** section listing exactly what the fake substrate cannot show
  (:392-404) — DF3.2's demo was accepted as PARTIAL with deltas stated, never faked.
- **"Deviations / corrections proposed (SOURCE WINS)"** section (:406-427): when implementation
  legitimately diverges from spec prose, document; "source wins, test pins reality".
- Gate evidence format: scoped-file pass counts + one full-suite line naming the documented
  pre-existing fail (`tests/gitnexus/graph-queries.test.ts` index reader) + `bunx tsc --noEmit` +
  `biome` + `detect_changes` blast-radius line (:332-341, :561-566).

### 1.4 "PROVEN live" tiers — how they were run

- Layout: `tests/fleet/e2e/{live-harness.ts, tier1-*.live.test.ts, tier2-*.live.test.ts,
  tier3-*.live.test.ts}` (14 files). Planning artifacts beside the run report:
  `_bmad-output/workflow-state/code-review/e2e-audit/{e2e-coverage.md, e2e-plan.md, e2e-run-report.md}`.
- Harness rules (`tests/fleet/e2e/live-harness.ts`): **NO FAKES in any *.live.test.ts or the
  harness** (:4-6); every test is `test.todoIf(liveTodoOff())` so CI pays nothing (:71-74); the
  first body statement is `liveGate(tier)` which **THROWS on a half-configured environment rather
  than skipping** (:55-69); `QDS_E2E_LIVE=1` master flag + `QDS_E2E_TIER` opt-in per tier (TIER-2
  is real money, :52-54); secrets — provisioning key never printed, `writeEvidence` scrubs
  `sk-or-…` and asserts the written bytes are clean (:17-21).
- Evidence: one JSON per test at `_bmad-output/evidence/df3-e2e/<YYYY-MM-DD-HHMMSS>-<test>.json`
  (EVIDENCE_DIR :39); verdict matrix with per-test evidence links in `e2e-run-report.md:46-60`.
- Tier semantics: T1 = $0-model-spend substrate proofs (driver verbs, refusals); T2 = real spend,
  operator-approved cap (`T2_CAP_MICRO_USD = 50_000`, `tier2-dispatch-engine.live.test.ts:61-62`);
  T3 = full shipped-surface proofs. Each live test runs **solo**, asserts substrate clean after
  (`ssh exe.dev ls` empty), and records verbatim failures.
- The closest live test to DF3.3: `tier2-dispatch-engine.live.test.ts` — header (:1-38) documents
  the **engine-start-path decision from source**: no in-box node/bun, so the in-box engine
  invocation is the `pi` worker argv via `driver.exec` with the delivered key. A live resident
  solicitation proof would follow this exact shape (`buildWorkerArgv` +
  `SCHEMA_INSTRUCTION` replicated at :74-75).

## 2. DF1.6 — `team-lead-driver.ts`: the closest existing "agent call" code

All citations `cli-anything/scripts/team-lead-driver.ts` unless noted.

- **Spawn**: `spawn("pi", buildWorkerArgv(w), { stdio: ["ignore","pipe","pipe"], env: process.env })`
  (:589-592). Argv: `--provider <p> --model <m> --mode json --no-session [-e …] -p <prompt>` with
  the schema instruction appended last (:378-396). **Keys ride inherited env, never argv, never
  logged** (INV-1, :21).
- **Prompt contract**: `SCHEMA_INSTRUCTION` (:366-367) — one sentence demanding ONLY a JSON object
  of a fixed shape. DF3.3's resident prompt should carry the equivalent closed
  `SteeringDirective` instruction.
- **Reply extraction**: `extractJsonObject` (:120-166) — balanced-brace, string-aware scan,
  candidates tried **last-first** (the final JSON object in the reply wins). Reuse, don't rewrite.
- **Usage/cost harvest**: `harvestPiStream` (:270-364) — accumulate usage on `message_end` ONLY
  (accumulating on message_start/update/turn_end double-counts, INV-COST-3 :256-269); assistant-role
  rule for text (:293-311); `openMessages` counter makes a SIGKILL-truncated stream count as
  unpriced (:276-281); malformed turn usage ⇒ `unpricedTurns++`, never priced at $0 (fail-closed,
  :348-353). Exported for test so there is exactly ONE accumulator (INV-COST-2 :266-268).
  DF3.3's engine-side µ$ meter should be this shape, summed per reply.
- **Timeout**: `setTimeout(() => child.kill("SIGKILL"), timeoutMs)` (:606-608); env value
  **bounds-checked** — only integers in [1, 2^31−1] accepted, else the 240_000 default, because
  `setTimeout(NaN)` fires at ~0 ms (:685-697). Copy this guard for the 60_000 ms solicitation
  timeout if it is ever env-tunable.
- **Degradation, not death**: `child.on("error", …)` resolves with a zero-usage outcome so one
  broken worker degrades to partial (:609-623); `settled` flag guards double-resolve (:599).
  Classification ordering: exitCode!==0 or empty text ⇒ output null; then unparseable JSON ⇒
  output null (:718-727) — outcome classification BEFORE any side effect. This is exactly DF3.3
  AC3's "degraded, run continues deterministic" shape (plus DF3.3's two-attempt reparse rule).
- **Subprocess plumbing details worth copying**: `StringDecoder` per stream so a multi-byte UTF-8
  char split across chunks doesn't corrupt (:593-596); stderr tail logged only when text is empty
  (:649-651); `import.meta.main` guard so tests can import the harvest seam without spawning
  (:820-824).
- **Redaction**: `redactSecrets(raw, parentEnv)` applied BEFORE truncation so the cut can't split a
  secret (:508-511) — matches DF3.3's §5.2 persist-pre-execution-redacted requirement
  (`redact` via `cli-anything/src/redact.ts`).
- **Single cost-accounting path**: every emit site goes through one `costEvent()` (:91-117).

### 2.1 The engine-side injection seam (DF1.6's `dispatch-task.ts`)

`src/phase-engine/phases/dispatch-task.ts` is the model for how `src/phase-engine/steering.ts`
should expose its test seam:

- `DispatchTaskDeps { tracer?, requestId?, rosterValidateDeps?, rootDir? }` (:51-65) — optional
  deps the pipeline runner passes, tests override.
- Module-private `_runTeamManifest` + `_injectRunner(fn)` / `_resetRunner()` (:67-74, marked
  `ponytail: minimal runner injection seam for tests`). `fake-resident.ts` should be injectable
  the same way — no IF-defs, no DI framework.

## 3. DF3.1 playbook — transferable lessons

Full file: `_bmad-output/workflow-state/qds-dev/df3-2/research/R3-df31-playbook.md`. Highlights:

1. **Wave plan** (§1): phase0 HITL validation → branch (pre-existing dirty files EXCLUDED from PR)
   → parallel research tracks, confidence-scored → gate → wave0 architect drafts
   `integration-spec.md` → **orchestrator verifies every D-decision against source and appends
   CORRECTIONS C1–Cn ("where the sketch conflicts, THESE WIN")** → wave1 parallel TDD on disjoint
   acyclic modules → agent-D (front door + e2e demo) only after wave1 merges, importing real
   exports → PR → BMAD adversarial rounds to green gates.
2. **Dead-agent recovery** (§1): never respawn with the original prompt; relaunch NARROWER,
   post-merge. Test files written against the SPEC (not compiled siblings) are disposable when an
   agent dies. The orchestrator corrects the architect, not vice-versa — wave0 isn't done until
   every decision cites verified `file:line`.
3. **integration-spec skeleton** (§2): Module Contracts (fenced TS sketches with AC-numbered
   doc comments) → Locked Decisions D1–Dn (Verdict + Evidence bullets with file:line) → Executive
   Summary → dated CORRECTIONS (C-last = the wave plan) → append-only `> AMENDED (round-n)`
   blockquotes. Append-only amendments ended recurring bot flags.
4. **Pre-written review-category tests** (§4): lock-lifecycle races, redaction chokepoint
   (redact BEFORE slice/bound, one chokepoint for every string leaving the process), fail-open
   listings, exit-6 non-retryable cleanup failures, validation-before-side-effects (acquire
   resources only after schema validation), catch-block side effects ordered AFTER outcome
   classification, forced-overlap concurrency tests.
5. **§5**: reuse the hardened primitives that already exist (run-record lock claim/steal/park,
   `atomicReplace`, O_EXCL) rather than minting second implementations.

## 4. workflow-state layout (qds-dev convention)

`_bmad-output/workflow-state/qds-dev/<story>/`:
- `state.yaml` — see `df3-2/state.yaml:1-28`: `story/title/phase/pr/final_commits/commits/branch/
  base/target/mode/started/deps/dep_status/guardrail_log/checkpoints` (dated one-liners per phase,
  incl. a `key-synthesis` checkpoint that names reuse decisions: "reuse run-lock.ts claim/isAlive +
  atomicReplace + O_EXCL wx patterns", df3-2 `state.yaml:27`).
- `research/R1…R6.md` (parallel tracks) and `integration-spec.md` at the story root.
- Evidence: `_bmad-output/evidence/df3-2/pr128-triage.md` (review ledger, committed — never left in
  `/tmp`); live-run JSONs under `_bmad-output/evidence/df3-e2e/`.

## 5. DF3.3-specific facts verified during this pass

- `src/phase-engine/steering.ts` and `src/fleet/resident.ts` do **not exist** — both net-new
  (confirmed: no `steering|resident` export in `src/fleet/index.ts` or `src/phase-engine/index.ts`).
- Manifest fixture shape to copy: `tests/phase-engine/fixtures/pipeline.qds-factory.json` —
  `{version, pipelineId, runBudgetMs, phases:[{name, kind:"code", description, maxDurationMs,
  retries, command:[…]}]}`. `pipeline.resident.json` needs a `build` phase whose command fails once
  (a fixture command script precedent exists: `tests/phase-engine/fixtures/test-command-output.ts`).
- Journal comparison util: `readJournal(p)` in `tests/phase-engine/journal-test-util.ts:10-12`
  (shared so suites can't drift) — the AC1a byte-identity diff (excluding `resident.*` + timing
  fields) builds on it.
- Rate source: `src/phase-engine/roster/validate.ts:72` (`inputPerMTok` field), :540/:556
  (`toMicrosPerMTok` loads as integer µ$/MTok, never defaulted :465). DF3.3 reads
  `inputPerMTok`/`outputPerMTok` only.
- `.strict()` zod precedent with named-key error surfacing: `src/fleet/brief-schema.ts:458`.
- `scripts/pipeline-run.ts` actual flags today: `--manifest --budget-ms --journal --run-root
  --run-id --request-id --repo-slug --issue --issue-url` (`pipeline-run.ts:11-21`) — the story's
  `--no-resident` control flag is additive on top of these; exit codes 0/1/2 documented at :22-24.
- Roster fixture precedent: `tests/phase-engine/fixtures/dispatch-roster.yaml` (defaults + roles,
  minimal).
