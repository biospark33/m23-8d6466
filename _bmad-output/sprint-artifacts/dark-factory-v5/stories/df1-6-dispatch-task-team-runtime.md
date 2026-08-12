# DF1.6: dispatch_task Phase Spawns a pi Team via `team-lead-driver.ts`

**Story Points:** 8
**Sprint:** v5-S1 (track A, engine — the flagship; R5 §3 closes S1's engine chain here)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §5.1 (tier 3), §5.2 (the whole section binds this story), §6.6, §8 step 1
- Decision register: v5 §4 **D5** (tier 3 = pi teams via `team-lead-driver.ts` behind the `QDS_TEAM_RUNNER` seam, pi-first and runtime-pluggable), D9 (Warren demoted-optional), D6
- Contracts: v5 §5.2 — team runtime interface (`parseTeamEventLine`); step output schema (CC-1 `exitStatus`, `changedFiles`, `testResults`, `durationMs`, `mulchPrimed`/`mulchPrimeError`, `artifacts`); security invariants; observability. Derivation decisions: `2026-08-11-v5-story-derivation-decisions.md` **DD-8**; proof basis `_bmad-output/sprint-artifacts/_research/f6-step0-proof-2026-08-11.json` (F6 CLOSED, verifier-confirmed)

## User Story

As a factory engineer,
I want the phase engine's `dispatch_task` phase to run a real pi team through the one proven runtime and return a schema-validated step output,
so that tier 2 gets a machine-checkable result from tier 3 instead of a transcript, and every PR #97 hardening clause is enforced where it can finally measure the right process.

## Overview

`dispatchTask(params)` is a DF1.1 phase body: it resolves a DF1.5-validated roster into a
`TeamManifest`, validates the inherited `QDS_TEAM_RUNNER` (**accepts `local` only** — unset and
every other value alike refuse before spawn with `exitStatus: "logic"` naming the variable; the
seam's own code default is `warren`, so treating unset as `local` would silently hand the run to
the demoted-optional branch), then calls
`runTeamManifest` with `QDS_TEAM_RUNNER=local` in the child environment so `buildTeamSpawn`
(`team-events.ts:36`) selects `bun scripts/team-lead-driver.ts`, then reads the driver's stdout
through `parseTeamEventLine` (`:77`) — each event kind becoming a DF1.2 envelope or trace event,
the terminal `merged` event validated against the step-output schema and returned as the phase's
envelope, and the run classified by the precedence rule below.

## E2E Slice

**Demonstrable behavior:** Given a two-worker roster and a repository with one seeded failing
test, When a pipeline containing a `dispatch_task` phase runs with `QDS_TEAM_RUNNER=local`, it
spawns `team-lead-driver.ts` → parses the NDJSON stream (F6: 12 events — 6 `coms`, 3 `cost`,
2 `worker_output`, 1 `merged`; **0 malformed**) → validates the terminal merged object → the
phase envelope carries `exitStatus: "success"`, `partial: false`, `error: null`,
`changedFiles: ["cli-anything/src/redact.ts"]`, and a **non-zero** cost sum. (F6 measured
`$0.04912262` on the pre-DF2.7 last-turn path; with DF2.7 merged the sum is session-cumulative and
therefore larger, so the assertion is non-zero — never that literal figure.)

**Wiring closed:** On completion of this story, `dispatch_task` runs a real pi team and returns
a validated step output using only code merged by this story plus DF1.1's lifecycle, DF1.2's
envelope type, DF1.5's roster and DF2.7's session-cumulative cost accumulation. No stub, no
`TODO: wire later`, no sibling story required.
Issue correlation is DF1.8's.

**Dependency edges (predecessors):** DF1.1, DF1.2, DF1.5, DF2.2, DF2.7, P0.2, P0.3.

## Acceptance Criteria

1. **(make-or-break)** Given an active pipeline with a `dispatch_task` phase, When the phase
   executes, Then the team runtime is spawned through the `QDS_TEAM_RUNNER=local` seam
   (`cli-anything/src/runner.ts:554`) and the step output is structured JSON containing
   `{ exitStatus: "success"|"transient"|"overflow"|"logic"|"lead_failure", changedFiles: string[], testResults: { passed: number, failed: number }, testsExecuted: boolean, summary: string, durationMs: number, mulchPrimed: boolean, mulchPrimeError?: string, artifacts: Array<{ name: string, path: string }> }`
   — verbatim from `p1-6:32`, with `testsExecuted` carried from `p1-6:62` (it is not part of the
   `:32` field list); `p1-6:32`'s `warren run` dispatch half is dead and not carried — over
   the nine fields `MergedOutput` already ships (`types.ts:131`). `testsExecuted` MUST be present
   and `false` whenever `testResults.passed + testResults.failed === 0`; consumers MUST reject
   output where that sum is 0 and `testsExecuted` is absent or `true` (keeps DF1.6 and DF5.1
   validators consistent with the `MergedOutput` schema).
2. Given the driver's stdout stream, When the phase reads it, Then **every line that survives the
   1 MiB per-line cap** goes through `parseTeamEventLine` and each of the five kinds
   (`cost | coms | worker_output | merged | coms_init_error`) maps to a named envelope or trace
   event; a rejected line returns `null`, increments `malformedLines` and does not fail the
   phase; on the proven path `malformedLines` is `0`. A line **dropped by the cap never reaches the
   parser at all** (`runner.ts:472`), so it is counted separately as `droppedOversizeLines` — never
   as a malformed line, and never as nothing: `malformedLines: 0` alongside a non-zero
   `droppedOversizeLines` is a truthful, and materially different, report. Both counters ride on
   the phase record. *(NET-NEW per DD-8, against design §5.2; evidenced by F6 clause 2 — 12/12
   events, 0 malformed.)*
3. Given the lead exits or is killed without a valid `merged` event, When the phase classifies
   the run, Then it applies the precedence rule in Technical Notes — a `coms_init_error` run is
   `transient` ahead of everything; a signalled lead is classified by kill origin; a lead that
   exited **under its own control** with no envelope is `lead_failure` *including exit code 0* —
   with `exitCode: number | null`, `partialOutput` and `durationMs` populated, and the phase
   engine does not crash.
4. Given a fresh repository with no prior Mulch expertise in the specified Hindsight bank, When
   the `dispatch_task` step executes with Mulch priming, Then the Pi team runs without primed
   context (empty context is acceptable), the step output includes `mulchPrimed: false`, and
   execution succeeds with `exitStatus: "success"` — empty bank is not an error condition
   (verbatim, `p1-6-pi-team-protocol-step.md:35`).
5. Given `QDS_TEAM_RUNNER` is **unset**, or holds any value other than `local`, When the phase
   starts, Then it **refuses before spawning anything** with `exitStatus: "logic"` naming the
   variable — never falling through to the seam's `warren` branch, which is demoted-optional
   (D9), has zero proven QDS execution, and cannot dispatch a team at all. Unset is a refusal,
   not a default: the seam's code default is `warren` (`cli-anything/src/runner.ts:554`), so
   inferring `local` from absence is exactly the fall-through this AC exists to prevent. The
   phase sets `QDS_TEAM_RUNNER=local` in the **child** environment; it never writes it into its
   own to satisfy its own check.
6. **(producer for AC1's `testResults`/`testsExecuted`)** Given the phase's `PhaseSpec` declares
   `testCommand: string[]` (DF1.1's manifest schema), When the `dispatch_task` phase completes,
   Then the **phase engine itself** runs that argv **engine-side** — in-box, in the engine process,
   outside the team process it just supervised — against the run's workspace root, parses
   `passed`/`failed` counts out of its output, and writes
   `testResults: { passed, failed }` with `testsExecuted: true` onto the merged step output.
   Given the `PhaseSpec` declares **no** `testCommand`, Then the engine runs nothing and writes
   `testResults: { passed: 0, failed: 0 }` with `testsExecuted: false`. The team's own in-box
   test activity is never the source of these numbers — it is an agent claim, and R5 §6 fact 15
   makes in-box evidence a claim rather than proof — so no code path derives `testResults` from
   the driver stream, from `worker_output`, or from the merged envelope. `testCommand` is spawned
   as an argv array, never a shell string, and its argv originates only from the schema-validated
   DF1.1 manifest (never from agent output); a `testCommand` that cannot be spawned, exits on a
   signal, or whose output does not parse yields `testsExecuted: false` with `{passed: 0,
   failed: 0}` and a logged reason — never a fabricated count, and never a silent `true`.
   **"Engine-side" is not "host-side" in this architecture's sense.** The engine runs inside the
   box, on the same filesystem the team just wrote to, so this criterion produces a *better-sourced
   claim* than the team's own testimony — not proof. It does **not** discharge DF5.1, whose
   re-verification runs on the operator's host, outside the box, from the harvested bundle against
   a clean worktree. A run whose only test evidence is this field has been claimed green, not
   verified green.

7. **(net-new code, not a re-aiming)** Given a `dispatch_task` spawn, When the phase supervises it,
   Then **this story builds** the RSS watchdog: no such watchdog exists in `runner.ts` today, so
   INV-3's "RE-AIMED" describes the *design intent* carried over from the Warren-era clause, not an
   existing implementation being pointed elsewhere. It samples the **aggregate RSS of the spawned
   process tree** (the `team-lead-driver.ts` lead plus every pi descendant, not the lead's own RSS)
   every **200 ms**; when the aggregate exceeds **4 GB** it escalates as: SIGTERM to the process
   **group**, wait `WATCHDOG_GRACE_MS` (`cli-anything/src/runner.ts:77`), then `killTree`
   (`runner.ts:85`) for the SIGKILL leg — `killTree` is SIGKILL-only, so it is the second leg of the
   escalation and cannot itself perform the graceful one. A tree that exits during the grace window
   is not SIGKILLed. The kill classifies `exitStatus: "overflow"` under precedence step 1 with
   `partialOutput` populated, even though no merged envelope exists. Where the aggregate RSS cannot
   be sampled on the running platform, the phase logs the reason and the watchdog reports
   `unwatchable` — it does not silently sample the lead alone, which is the wrong-process error the
   clause exists to correct. CPU is advisory only: sampled and logged, never a kill reason.

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `dispatch_task` phase body invoked by DF1.1's `Run.phase()` | in-scope | `tests/phase-engine/dispatch-task.test.ts` | — |
| `bun cli-anything/src/index.ts run --manifest <team>.yaml` + `npm run smoke:team` | in-scope | `cli-anything/test/runner.test.ts` | — |
| seam's `warren` branch (`QDS_TEAM_RUNNER` unset) | in-scope **as a refusal** (AC5) | `tests/phase-engine/dispatch-task.test.ts` | — |
| tier-2 resident agent steering a `dispatch_task` phase | out-of-scope | — | DF3.3 |
| `fleet dispatch` invoking the engine in-box | out-of-scope | — | DF3.1 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| tier-3 runtime toolchain — pi **0.55.x**, the project's bun toolchain, vendored coms `pi-vs-claude-code-vendor` @ disler `0ed11f44` (peer-pinned pi 0.55.0) | host binaries + vendor dir in the box image (image contract owned by DF2.9; F13 pins pi libs to 0.55.x) | preflight asserts `pi --version` starts `0.55.`; `bun test cli-anything` (150 tests) green before this story starts; a `coms_init_error` on the wire classifies per precedence step 0 |
| validated roster | DF1.5 `validateRoster()` output resolved to a `TeamManifest` | dual-gate check exits `0` in preflight; an `unverified` gate refuses the dispatch rather than spawning |
| provider API key (exactly one per box) | env only, minted spend-capped by DF2.3 | presence logged **by key name only** (`runner.ts:548-551`); absent → refuse before spawn |
| `QDS_TEAM_RUNNER=local` in the engine's **inherited** environment | **produced by DF2.2**, whose `setup` AC writes `QDS_TEAM_RUNNER=local` into the box's run environment alongside the `.env` key-delivery contract — that AC is the producer this row depends on; `fleet dispatch` (DF3.1) supplies the same variable when it launches the engine in-box outside a provisioned box. This phase never sets it for itself (AC5) | AC5 refusal is the verification: absent or non-`local` → `exitStatus: "logic"` before any spawn, so a box whose setup forgot the variable fails loudly at the first `dispatch_task` rather than silently taking the `warren` branch |

## Technical Notes

- **Contracts/Schema:** the extension widens `BuildMergedOutputOptions` (`merger.ts:164`) and `buildMergedOutput`
  (`:187`), not the `MergedOutput` type alone — the uniformity invariants live there (R3 §1.7). **`testsExecuted`**
  (verbatim, `p1-6:62`) MUST be present and `false` whenever `testResults.passed + testResults.failed === 0`, and
  consumers MUST reject output where the sum is 0 and the field is absent or `true` — the signal DF5.1 reads to tell
  "no tests ran" from "zero tests exist".
- **Field placement — the new fields are top-level siblings, and `result` is untouched.**
  `testResults`, `testsExecuted`, `summary`, `durationMs`, `mulchPrimed`, `mulchPrimeError` and
  `artifacts` are added at the **top level** of the merged step output, alongside the nine fields
  `MergedOutput` already ships (`types.ts:131`) — not nested under `result`, and not replacing
  anything inside it. The one collision is `summary`: `result.summary` already exists, so
  `buildMergedOutput` **copies** it up to the top-level `summary` (subject to the 2,000-char
  ceiling below) and leaves `result` byte-identical to what it ships today. Existing consumers
  reading `result.summary` keep working; new consumers read the top-level field; nothing reads
  one expecting the other's truncation rules.
- **Roster → `TeamManifest` adapter (this story owns it).** DF1.5's roster gives each role a
  structured `{ provider, model }` pair, while `TeamRoleSchema` (`cli-anything/src/types.ts`,
  `.strict()`) takes a **single `"provider/model"` string**. `rosterRoleToTeamRole` in
  `src/phase-engine/phases/roster-adapter.ts` is the one conversion, and it must round-trip
  through the existing `splitRoleModel` helper rather than re-implementing the split — a model id
  may itself contain `/` (DF1.5's `deepseek/deepseek-v4-flash-0731` under provider `openrouter`),
  so a naive `split("/")` on the joined string reconstructs the wrong pair. No second joiner or
  splitter appears in the diff.
- **Precedence rule (steps 1–2 carry the substance of `p1-6-pi-team-protocol-step.md:78-83`; step 0 and the exit table
  are re-derived against this runtime):** **how the process died outranks whether it emitted an envelope, which outranks
  its exit code.** (0) A `coms_init_error` settles `transient` with **no** partial output, ahead of every rule below —
  the coms layer never came up, so neither envelope nor exit code is evidence about the work (`runner.ts:878-889`).
  (1) Signal termination is classified by kill origin, never by the envelope — watchdog → `overflow`,
  `userCancel`/`requestedShutdown` → `logic`, unknown origin (kernel OOM) → `transient` — evaluated ahead of steps 2–3,
  because a kill is itself positive evidence about how the run ended. (2) Envelope missing on a normally-exited process
  → `lead_failure`, *including exit code 0*. (3) Exit-code lookup, re-derived from **this runtime's** surface, not
  P1.6's dead Warren table (F3, R1 §4.5): `0` with a valid `merged` event → `success`
  (`team-lead-driver.ts:393-404`); `0` without one → `lead_failure` per step 2, where "valid" means
  `parseTeamEventLine` accepted it — a non-object, array or null `result` is rejected (`team-events.ts:113-123`);
  `64`, the driver's config-error exit (missing or unparseable `QDS_AGENT_TEAM_CONFIG_JSON`, or zero workers,
  `team-lead-driver.ts:257`) → `logic`; any other non-zero → `transient`, the catch-all retryable default.
- **NDJSON adaptation:** `coms` → trace event in the camelCase `ComsLogEntry` shape (`types.ts:94`); `cost` → cost
  event; `worker_output` → a DF1.2 `Envelope` directly — it is already an agent report, and `asEnvelope` adapts
  *deterministic subprocess* results (DF1.2 AC2) — so a worker report and a gate result reach the next phase through
  the same door; `merged` → the terminal envelope; `coms_init_error` → recorded with its `reason`.
- **Guards/limits:** RSS 4 GB / 200 ms poll / SIGTERM to the group → `WATCHDOG_GRACE_MS` (`runner.ts:77`) → `killTree`
  (`runner.ts:85`, SIGKILL-only) per AC7; wall-clock and
  budget kills stay at `:675` / `:707` (kill fraction `0.9`, `:463`) and both map to `overflow`; oversize lines are
  dropped at the 1 MiB per-line cap (`:472`) and counted as `droppedOversizeLines` (AC2), which is a distinct counter
  from `malformedLines` because a dropped line never reaches the parser. `summary` ≤ 2,000 chars and `partialOutput` ≤ 10,000 **including** the
  truncation suffix — reserve the suffix width before cutting (`p1-6:65`). Per-phase `maxDurationMs` stays DF1.1's
  engine-owned timer (DF1.1 INV-3).
- **Priming degradation (verbatim, `p1-6:87`):** if Hindsight is unreachable the harness logs a warning, sets
  `mulchPrimed: false`, and proceeds; the step does not fail due to priming unavailability, and `mulchPrimeError`
  carries the message. Keeps OQ-4 off the execution spine.
- **Cost is session-cumulative per DF2.7, which lands first.** DF2.7 is a hard predecessor of this story, so by
  the time `dispatch_task` reads a cost event, `runWorkerPi` accumulates usage across turns rather than overwriting
  it (`team-lead-driver.ts:231,233,237,238`) and the budget guard compares against the true total. F6's
  `$0.04912262` was measured on the pre-DF2.7 last-turn path against a provider-billed bracket
  `[$0.049, ~$0.91]`, so it is the E2E slice's *shape* evidence — a non-zero cost sum — and no AC here asserts that
  absolute figure. Scope honesty (F6, R5 §6 fact 2): proven = **one** fixer worker editing code and running tests
  alongside a read-only analyst and a verifying lead, N=1 clean; multi-worker concurrent editing is **UNPROVEN**.
- **`cli-anything/src/runner.ts` region ownership (three S1 stories touch this file).** DF1.6, DF1.9 and DF2.7 all
  edit `runner.ts`, so each owns disjoint regions and none re-scopes another's assertions: **DF2.7** owns the cost
  accumulation path (usage merge, the `:707` budget-guard comparison and everything feeding it); **DF1.9** owns the
  `QDS_AGENT_TEAM_CONFIG_JSON` export and worker mapping (`:533-544`, `:539-543`) for the `lean`/`extensions`
  fields; **DF1.6** owns the `QDS_TEAM_RUNNER` seam read at `:554`, the child-environment construction around it
  (including the `budgetCapUsd` raise below), and the AC7 watchdog it adds to this file.
  DF2.7 merges first (it is DF1.6's declared predecessor); DF1.9 and DF1.6 follow in either order, because their
  regions are disjoint from each other's and from DF2.7's. A change outside your own region belongs in the owning
  story, whatever the merge order happens to make convenient.
- **`cli-anything/src/types.ts` region ownership (the same three stories touch this file too).** The runner.ts split
  above does not cover it, so state it explicitly: **DF1.9** owns `TeamRoleSchema` (`:33-49`) — the `lean` and
  `extensions` keys land inside that `.strict()` object; **DF1.6** owns the merged-output surface (`:125-145`) — the
  top-level `testResults`, `testsExecuted`, `summary`, `durationMs`, `mulchPrimed`, `mulchPrimeError` and `artifacts`
  siblings of the nine existing fields. `exitStatus` (`:79`) is pre-existing and owned by neither: both import it and
  neither re-declares it. Same rule as runner.ts — disjoint regions, additive edits, merge order irrelevant.
- **Spawn seam raises the tier-3 harness budget cap (DF2.7 boundary, this story owns the seam).** The tier-3 harness
  carries its own `budgetCapUsd` whose default (`$0.50`) sits **below** every ceiling this architecture advertises, so
  a run authorized for `$5` would die at `$0.50` with a harness-level kill that looks like a genuine cap hit. At the
  point this story constructs the child environment for the `QDS_TEAM_RUNNER=local` spawn, it therefore reads the
  **optional** `effectiveCeilingMicros` off DF1.1's run-context surface and sets
  `budgetCapUsd = effectiveCeilingMicros / 1e6` — the same value the outer guards enforce, converted once at this seam
  (the µ$→USD boundary rule of DF1.3's Technical Notes). The harness cap becomes a redundant inner copy of the real
  ceiling rather than a silent lower one, and it is never raised **above** it. **The field is optional and this story
  takes no S2 dependency for it:** DF1.6 is v5-S1 while the ceiling's producers — DF3.1 (dispatch) and DF2.8 (budget
  cap) — are v5-S2, so a hard edge would invert sprint order. Absent the field, the harness default stands and the
  seam does nothing, which is the correct S1 behaviour: an S1 run has no run-level budget to inherit. DF3.1 and DF2.8
  populate it when they land; neither needs a change here to do so.

## Observability Contract

- Every `dispatch_task` phase logs `{ requestId, phase, agentId, timestamp, durationMs, exitStatus }`; `requestId` propagates unchanged from DF1.1's phase record and is the join key on every adapted event. Errors include `{ code, message, stack? }`. Every compiled prompt is persisted **before** the spawn that consumes it (*NET-NEW per DD-8, against design §5.2 — it appears nowhere in P1.6*), so a run killed mid-phase still shows what it was asked to do.
- Stream-health counters on the phase record: `malformedLines` (parser rejections) and `droppedOversizeLines` (lines discarded at the 1 MiB cap before the parser saw them). Both are always emitted, including as `0`, so an operator can tell a clean stream from an unreported truncation.
- Sub-timings: `mulch_prime_ms`, `box_setup_ms`, `team_execution_ms`, `gate_validation_ms` — the v5-named successors to P1.6's Warren-shaped fields. A phase that did not run reports `0`; where the breakdown is unavailable `durationMs` is authoritative. `durationMs` is wall-clock from driver spawn to driver exit and excludes priming.

## Files to Modify

- `src/phase-engine/phases/dispatch-task.ts`
- `src/phase-engine/phases/team-event-adapter.ts`
- `src/phase-engine/phases/roster-adapter.ts` (`rosterRoleToTeamRole`)
- `src/phase-engine/phases/test-results.ts` (AC6 `testCommand` runner + count parse)
- `tests/phase-engine/roster-adapter.test.ts`
- `cli-anything/src/types.ts`
- `cli-anything/src/merger.ts`
- `cli-anything/src/runner.ts`
- `tests/phase-engine/dispatch-task.test.ts`
- `tests/phase-engine/team-event-adapter.test.ts`
- `tests/phase-engine/fixtures/dispatch-task-ndjson.jsonl`
- `cli-anything/test/merger.test.ts`
- `cli-anything/test/runner.test.ts`

## Security Invariants

- **INV-1 (isolation — one canonical root).** Verbatim from `p1-6:110-111`: *"the **pinned workspace root** … is the
  single canonical root for both path validation and every subsequent harness read … pinned to a resolved absolute
  path once at step start and never re-resolved from a string thereafter. Validating `changedFiles` and
  `artifacts[].path` against one root while reading through another is explicitly forbidden."* That root is DF1.1's
  pinned run root; this story opens no second one. The clause's dead half (`warren run` scoping via
  `.canopy/agent.json`, CC-14) is not carried.
- **INV-2 (input validation — two-stage decode-then-check, then a beneath-root walk).** From `p1-6:112-113`, reading
  "the run's structured output" for "Warren's structured JSON output". Every `changedFiles` and `artifacts[].path`
  entry is checked twice: **pre-decode**, reject percent-encoded `..` (`%2e%2e`, `%2E%2E`) and double-encoding
  evidence (`%252e`, any percent-encoded percent sign); **post-decode**, URL-decode, NFC-normalize, then reject
  literal `..` segments, absolute paths, symlinks and Unicode-normalized traversals. lstat-based validation is
  best-effort and cannot prevent symlink creation between validation and use; every read the harness performs itself
  therefore goes through the beneath-root walk (mechanics per DF1.1 INV-1, anchored at the INV-1 root, read through
  the resolved handle and never re-opened by string). This story implements **no** path resolver of its own — it
  calls DF1.1's, in whichever of the two permitted forms DF1.1 ships: the per-component walk, or the Node/Bun
  equivalent of `fs.realpath` + run-root prefix re-assertion on the resolved path + read through the resulting fd.
  **`O_NOFOLLOW` alone is NOT sufficient and MUST NOT be described as eliminating traversal:** it refuses only the
  *last* component, so an attacker controlling any intermediate directory replaces it with a symlink and redirects
  the open outside the root.
- **INV-3 (resource limit — RSS watchdog; built by AC7, not inherited).** The watchdog measures the **aggregate RSS of
  the in-sandbox subprocess tree** — the spawned `team-lead-driver.ts` lead plus all pi descendants — not a single
  client PID. Under server-side Warren the design's watchdog polled the wrong process; the re-aiming is conceptual —
  **no watchdog exists in `runner.ts` to re-point, so AC7 writes one** — and it is correct now only because the runtime
  is a genuine local subprocess tree with the harness as its real parent (design §5.2: "now correct"). Poll every **200
  ms**; above **4 GB** SIGTERM the process group, wait `WATCHDOG_GRACE_MS` (`runner.ts:77`), then `killTree`
  (`runner.ts:85`, SIGKILL-only). The result maps to `exitStatus: "overflow"` with
  `partialOutput` capturing output received before termination, **and this holds even though the merged envelope is
  absent** — precedence step 1 evaluates the kill metadata ahead of the missing-envelope rule, so a watchdog kill is
  `overflow`, never `lead_failure`. CPU is advisory: monitored and logged, never a kill reason.
- **INV-4 (credential — no secrets in step output).** *Authored fresh per DD-8, against design §5.2/§6.2.* The per-run
  provider key must not appear in any step-output field, in `summary`, `partialOutput`, `agentOutputs`, `comsLog`, an
  artifact path, or a persisted prompt. Every string leaving this phase passes `redactSecrets`
  (`cli-anything/src/redact.ts:62`) at the adapter boundary — once, before the value reaches an envelope, the journal
  or a trace row that the visualizer (DF4.1) and audit chain (DF5.3) later read. The key lives in the child
  environment only, never in argv, and is logged by name only.
- **INV-5 (fail closed).** Where **neither** DF1.1 INV-1 form — the per-component walk nor the
  realpath-plus-prefix-reassertion-plus-fd equivalent — can be performed on the running platform, the harness
  **refuses the read** and classifies the step `exitStatus: "logic"` with the path reported; it MUST NOT degrade to
  bare `O_NOFOLLOW`, nor to `lstat` + `open`, a check-then-use pair with a real TOCTOU window because it re-opens by
  string after checking. Equally, an unresolvable
  runtime selection (AC5), missing pi binary, absent provider key, or `unverified` roster gate refuses **before** the
  spawn.

## Definition of Done

- [ ] **Impl:** `dispatch_task` spawns the team runtime through the `QDS_TEAM_RUNNER=local` seam and returns the merged result as its phase envelope; `QDS_TEAM_RUNNER` unset **or** non-`local` refuses before spawn and the `warren` branch is never taken (AC5).
- [ ] **Impl:** every surviving driver stdout line is adapted through `parseTeamEventLine`; all five event kinds are handled; `malformedLines` **and** `droppedOversizeLines` are both recorded on the phase record (AC2).
- [ ] **Impl (AC7 watchdog, net-new):** the RSS watchdog is written in this diff — 200 ms sampling of the aggregate process-tree RSS, 4 GB threshold, SIGTERM to the group → `WATCHDOG_GRACE_MS` (`runner.ts:77`) → `killTree`. A reviewer can point at the tree-aggregation call and at both escalation legs; "we reused the existing watchdog" is not an acceptable answer to this item, because there is none.
- [ ] **Impl (spawn seam, DF2.7 boundary):** when the run context carries `effectiveCeilingMicros`, the child environment for the `QDS_TEAM_RUNNER=local` spawn sets `budgetCapUsd = effectiveCeilingMicros / 1e6`; a test asserts a run with a `$5` effective ceiling spawns the harness at `5`, not at the `$0.50` default, that the cap is never raised above the ceiling, and that a run context **without** the field leaves the harness default untouched (the S1 path — no S2 dependency).
- [ ] **Test (prompt persisted pre-spawn, XC — read-back):** for each role in the roster, a `prompt` event (DF1.4's event type) is written **before** the spawn that consumes it; asserted by killing a run mid-phase and reading the events back — every role's prompt is present in the trace even though the phase never completed. An implementation that writes prompts at phase end MUST fail this test.
- [ ] **Contract:** step-output schema extended at `buildMergedOutput` and `BuildMergedOutputOptions` (not the `MergedOutput` type alone), adding `testResults`, `testsExecuted?`, `summary`, `mulchPrimed`, `mulchPrimeError?`, `artifacts[]` and the failure-branch fields **as top-level siblings of the nine existing fields, with `result` unchanged and `result.summary` copied up rather than moved**; `exitStatus` imported from `cli-anything/src/types.ts:79`, never re-declared.
- [ ] **Integration:** classification implements the three-step precedence rule with the driver-derived exit table in Technical Notes — no Warren exit-code mapping appears in the diff.
- [ ] **Security (INV-3, and INV-4 as a negative control):** RSS watchdog measures the aggregate subprocess tree at 200 ms / 4 GB with SIGTERM → 5 s → SIGKILL, mapping to `overflow`; and given a driver stream whose `coms` payload and merged `summary` both echo the provider key value, every outbound string — envelope, journal row, trace row, artifact path, persisted prompt — carries the redaction marker and zero characters of the key. An implementation that redacts only at the log sink passes a log-only check and MUST fail this test.
- [ ] **Test (unit):** a `merged` event whose `result` is an array, `null`, or a non-object is rejected by the parser, `mergedResult` stays null, and the run classifies `lead_failure` — a garbled lead cannot report success with an empty `{}`.
- [ ] **Test (parent-symlink traversal, INV-2 — negative control):** a symlink at an *intermediate* directory of an artifact path pointing outside the root → the read is REJECTED by the beneath-root walk, not by `O_NOFOLLOW` (a bare-`O_NOFOLLOW` implementation passes this path and MUST fail this test), and the walk is anchored to the *same* pinned root the `changedFiles` validation used (validating against one root and reading under another MUST fail this test).
- [ ] **Test (watchdog precedence, negative control):** a lead killed by the RSS watchdog with no merged envelope → `exitStatus: "overflow"` with `partialOutput` populated. An implementation that checks the envelope before the kill origin returns `lead_failure` and MUST fail this test.
- [ ] **Test (AC6, both branches):** a `PhaseSpec` with a `testCommand` whose output reports 7 passed / 2 failed → merged output carries `testResults: {passed: 7, failed: 2}` and `testsExecuted: true`; the same phase with the `testCommand` removed → `{passed: 0, failed: 0}` with `testsExecuted: false` and no spawn. An implementation deriving either result from the driver stream or the merged envelope MUST fail this test, and so must one that reports `testsExecuted: true` for an unspawnable `testCommand`.
- [ ] **Test (roster adapter):** a DF1.5 roster role of `{ provider: "openrouter", model: "deepseek/deepseek-v4-flash-0731" }` round-trips through `rosterRoleToTeamRole` into a `TeamRoleSchema`-valid `"openrouter/deepseek/deepseek-v4-flash-0731"` and back to the original pair via `splitRoleModel`. Splitting on the **first** `/` is the correct behaviour and is what `splitRoleModel` does — so the negative controls are the two plausible wrong splits: an adapter splitting on the **last** `/` (yielding provider `openrouter/deepseek`, model `deepseek-v4-flash-0731`) and one using `s.split("/")[0]` / `s.split("/")[1]` (yielding model `deepseek`, silently dropping the rest) each reconstruct the wrong pair and MUST fail this test.
- [ ] **Test (boundary):** an empty Hindsight bank → `mulchPrimed: false` with `exitStatus: "success"`; and `testResults.passed + testResults.failed === 0` with `testsExecuted` absent or `true` → output rejected.
- [ ] **Test (e2e demo — MANDATORY):** a live `QDS_TEAM_RUNNER=local` run over a seeded failing test produces a captured NDJSON stream in which every line parses (`malformedLines: 0`) plus a merged step output validating against the extended schema with `exitStatus: "success"`, non-empty `changedFiles`, and a non-zero cost-event sum — the F6 shape, re-run through the phase engine.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
