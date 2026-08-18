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

**Status: complete — implemented, tested, live e2e green (2026-08-17). Code-review rounds 5–7 (2026-08-17/18): all patch findings applied, gates green — see Review Findings below. Awaiting PR #116 merge.**

- **Files delivered:** `src/phase-engine/phases/{dispatch-task,team-event-adapter,roster-adapter,test-results}.ts`, `cli-anything/src/watchdog.ts` (net-new RSS watchdog, AC7), widened `cli-anything/src/{types,merger}.ts` (top-level step-output siblings, `result` untouched, `result.summary` copied up), `cli-anything/src/runner.ts` (seam read + child-env construction + `budgetCapUsd` raise + additive `onTeamEvent`/`onRunFacts` hooks + watchdog wiring), `src/phase-engine/{manifest,types,phase,index}.ts` (additive: `dispatch_task` kind + `roster`/`task` fields, PhaseRecord counters + v5 sub-timings, barrel exports), `scripts/pipeline-run.ts` (makeBodyFactory registration, tracer/requestId closure), `config/rosters/df16-e2e.roster.yaml` (e2e), fixtures + 5 test files.
- **Tests:** 26 dispatch-task (all AC/INV branches incl. story negative controls: watchdog-kill precedence, prompt-persisted-pre-spawn read-back, parent-symlink walk, wrong-split roster negative controls) + 31 team-event-adapter + 15 watchdog + 38 merger + 14 test-results + 9 roster-adapter. Repo: 704 pass / 1 fail (the one fail is the pre-existing environmental `usage.test.ts` catalog-scan flake — fails identically on clean main). tsc 0, biome clean, `check-defensive-programming.sh` OK (one `dp:ok`-annotated intentional type-erasure), `check-pr-conflicts.sh` OK.
- **Live e2e (MANDATORY DoD item):** two live `QDS_TEAM_RUNNER=local` runs through `scripts/pipeline-run.ts` over a seeded failing test — run 1: PHASE-LEVEL green only: fixer worker edited `src/calc.ts`, `exitStatus: "success"`, `changedFiles: ["src/calc.ts"]`, 12-event NDJSON stream (3 pre-spawn prompt + 6 coms + 3 cost + 2 worker_output), `malformedLines: 0`, `droppedOversizeLines: 0`, non-zero cost (2670 µ$ first event); the dispatch phase succeeded while the placeholder tail phase expectedly failed (`pipeline ok=false` from the tail). Run 2 is the full-pipeline green run: `ok=true accepted=true` with engine-side `verify-suite` green. Evidence: `_bmad-output/evidence/df1-6/`.
- **Self-review:** 15 findings; 5 applied (watchdog killOrigin set only after successful group SIGTERM; grace-timer cleared on stop; mid-grace unwatchable no longer cancels the SIGKILL leg; test-command abort path reaps the child; engine-owned sub-timings cannot be clobbered by body values). 10 rejected with reasoning against story text (NFC is p1-6:112-verbatim; coms_init_error is precedence step 0 by story; exit-64 row is step 3; `command` already forbidden on non-code kinds; close-handler ordering drains before facts; redact-then-truncate cap math holds by construction; manifest temp file is created after every refusal; consumer-side testsExecuted validation is DF5.1's; budget precedence already story-correct; oversize multibyte boundary is F15-tested).
- **Environment note:** DF1.5's rate-table loader expects `@earendil-works/pi-ai/dist/providers/data`, which pi 0.55.0's `@mariozechner` packaging does not ship — e2e used the documented `QDS_PI_CATALOG_DIR` override with a hand-built catalog. Host layout drift, not a story defect; flag to DF1.5 follow-up.

### Review Findings (code review 2026-08-17, PR #116 round 5)

3-layer adversarial review (Blind Hunter ×3, Edge Case Hunter ×3, Acceptance Auditor — auditor: all ACs pass, zero findings). 49 patch findings, 0 decision-needed, 0 deferred, 19 dismissed as noise. All patches applied in two parallel waves; gates green (focal suites 163+81 tests pass, biome clean, tsc clean).

- [x] [Review][Patch] Abort-registration races (check→addEventListener window) — runner.ts abortTeam + test-results.ts runTestCommand re-check `signal.aborted` after registration
- [x] [Review][Patch] Abort listener lifecycle — runner.ts `abortListener` removed in `removeSignalHandlers`; test-results.ts try/finally guarantees `removeEventListener` on all exit paths
- [x] [Review][Patch] Watchdog kill-attribution TOCTOU — killOrigin set synchronously at escalation, cleared only if group SIGTERM fails (watchdog.ts)
- [x] [Review][Patch] Watchdog precedence race — escalation state visible at classify time, not only in async callback
- [x] [Review][Patch] Grace-timer pgid-reuse hazard — leader-pid liveness check before group SIGKILL; skip if leader dead (documented tradeoff: may leak stragglers, never kills innocent group)
- [x] [Review][Patch] Transient ps failure no longer permanently unwatchable — 3 consecutive failures required
- [x] [Review][Patch] Partial-output cap — decoder.end() flushed within remaining budget at finalize; output stays ≤ cap
- [x] [Review][Patch] Windows watchdog no-op now logs once; Linux O(N) sampler ceiling documented in place
- [x] [Review][Patch] truncateWithSuffix: marker always meaningful when maxLength < suffix length (merger.ts + new test)
- [x] [Review][Patch] Path validation hardening — reject null bytes/control chars, backslashes (UNC), empty/whitespace paths in validateChangedFiles/validateArtifacts (dispatch-task.ts)
- [x] [Review][Patch] Invalid worker_output status now defaults "transient" (fail-safe) instead of "success" — intentional behavior change, tests updated (team-event-adapter.ts)
- [x] [Review][Patch] Duplicate merged events first-wins; comsInitError unified to adapted value; events-after-merge documented as intentional (stream health)
- [x] [Review][Patch] Bun parser accepts pass OR fail line (missing → 0) (test-results.ts)
- [x] [Review][Patch] dispatchSubTimings whitelist (phase.ts) — body values cannot inject arbitrary sub-timing keys
- [x] [Review][Patch] Manifest unlink failure warns on stderr; PhaseSubTimings undefined-vs-zero contract documented (types.ts)
- [x] [Review][Patch] ExitStatus derives from EXIT_STATUSES const (cli-anything types.ts) — union cannot drift from runtime guard
- [x] [Review][Patch] Test hardening: pinned Zod max-3 error messages (dispatch-task + roster-adapter), asymmetric Tests/Test-Suites counts, exact env restore (unset vs "" vs value), artifact content assertions, changedFiles secret-redaction test, fixture-12 invariant comment, cleanup warns, corrected comments (delete semantics, output-cap math, type-erasure), relaxed watchdog timing test (350ms/≥2)
- Verified false-positives (skipped): partialOutput cap math (suffix already budgeted), opts.summary fallback (declared in interface), spawn-error null exit facts (spawn_error_code distinguishes), warren big_cost 60s sleep (budget-kill terminates <1s, evidence in triage), $! backgrounding fixture (correct shell), pipeline-run rootDir comment (matches code)
- Pre-existing, not touched: usage.test.ts catalog-scan timeouts (fail identically on clean HEAD; file not in this PR's diff)

### Review Findings (code review 2026-08-18, PR #116 round 6)

7-agent chunked adversarial review (blind cynical ×4, edge-vs-repo ×3, acceptance auditor ×1; edge-engine respawned as two half-scope agents after context death). 59 raw findings → 13 patch, 24 dismissed (verified false or out-of-scope), 22 noise-collapsed. Gates green: focal suites 101+83 pass / 0 fail, biome clean ×9 files, `bun run typecheck` exit 0, gitnexus detect_changes blast radius confined to PR's own modules (runner.ts, phase.ts, dispatch-task.ts).

- [x] [Review][Patch][CRITICAL] watchdog kill never classified overflow — runner.ts `const watchdogKilled = false` dead flag + empty `onEscalate` with false comment; killOrigin always null, AC7 overflow branch unreachable. Fixed: live `watchdog?.killOrigin === "watchdog"` read at onRunFacts (captured before stop/null) and finalize overflow gate; honest comment. AC7 restored.
- [x] [Review][Patch] End-to-end regression test for the above — new `watchdogSampleRss` test seam on TeamRunOptions (plumbed to startRssWatchdog), warren fixture `watchdog_kill` scenario, integration test asserting exitStatus "overflow" + onRunFacts killOrigin "watchdog" + escalation message
- [x] [Review][Patch][MEDIUM] manifest file leak window — writeFileSync sat before try (disk-full mid-write leaked 0600 manifest partial); write moved inside try, finally now `rmSync(force:true)` (idempotent, no ENOENT noise)
- [x] [Review][Patch][LOW] duplicate merged event now warns (requestId/phaseId context), first-wins semantics kept
- [x] [Review][Patch][LOW] dispatchSubTimings values guarded (`Number.isFinite && >= 0`), whitelist shape unchanged (phase.ts)
- [x] [Review][Patch][LOW] watchdog.test sample-count bounds widened with order-of-magnitude comments (2-6 → load-tolerant); dead child.pid file write removed
- [x] [Review][Patch][LOW] merger.test: redundant JSON.stringify double-assert dropped (could false-fail on key order while toEqual passes); "tiny maxLength" test renamed to what it verifies (truncateWithSuffix unexported — tiny path unreachable from tests); new non-empty partialOutput + success → null test
- [x] [Review][Patch][LOW] team-event-adapter.test: unknown type field → parser null; all-invalid stream → malformedLines === N, droppedOversizeLines === 0
- [x] [Review][Patch][LOW] roster-adapter.test: garbage-structure ResolvedRoster suite (null role → TypeError documented as-is, missing name → clean Error, missing provider → ZodError at boundary)
- Verified false-positives (pushback): abort-listener leak in dispatch-task.ts (no addEventListener exists in file); test-results abort race (re-check after registration closes it — round-3 fix); "success" ExitStatus mishandled (EXIT_STATUS_SET derives from canonical EXIT_STATUSES incl. success); killOrigin switch missing default (closed 5-member union, all covered); exit-64-vs-merged precedence (matches story exit table — 64 unconditional); `>` threshold (story says "exceeds"); all-skipped testsExecuted:false (documented fail-closed, AC6); AdaptedEvent JSDoc (union names match); redact-test weakness (both positive and negative assertions present); summary precedence (genuinely asserted); afterEach runner restore (designed safety net); runDispatch Promise.resolve (sync throw surfaces correctly); /worker/i regex (round-5 vacuous-guard already present)
- Out-of-scope dismissals: Windows/UNC/perl platform concerns (targets macOS + Linux CI), env-var parallel interference (bun sequential per file), 2-provider env whitelist (story-scoped S1 providers), vitest format variants (fixtures match real runner output)
- Pre-existing, not touched: usage.test.ts catalog-scan timeouts (fail identically on clean HEAD); 1 flaky platform-specific watchdog integration test ("samples aggregate RSS from a real process group", real-ps sampling)

### Review Findings (code review 2026-08-18, PR #116 round 7)

7-agent chunked adversarial review (blind cynical ×3, edge-vs-repo ×3, acceptance auditor ×1; one engine fixer respawned halved after context death, one test finisher likewise). ~98 raw findings → 52 source patches + ~28 test hardenings across two fix waves. Gates green: tests/phase-engine 487/489 (2 = the pre-existing usage.test.ts flake), cli-anything 259/259, biome clean (64 files), tsc clean, gitnexus detect_changes blast radius confined to this PR's own modules.

- [x] [Review][Patch][BLOCKER] watchdog SIGKILL leg unreachable in the common path — two defects: stop() cleared the armed grace timer (settle path cancelled the SIGKILL when the lead honored SIGTERM), and the grace liveness guard probed the dead LEAD pid (ESRCH → return) instead of the group; plus the grace callback's own `!running` bail defeated the surviving timer. Fixed: stop() preserves escalated grace legs, liveness probes the process group, callback gate `!running && !escalated` (watchdog.ts)
- [x] [Review][Patch][BLOCKER] runTestCommand hung forever when a descendant held the stdout/stderr pipe (awaited full drain, abort killed only the lead pid) — group kill on abort + bounded post-exit drain timeout with reader cancel (test-results.ts)
- [x] [Review][Patch][HIGH] jest/vitest parse anchored on FIRST "Tests" line — real vitest `⎯ Failed Tests N ⎯` banner or test names like "Tests 2 failed inputs" hijacked the anchor (fabricated counts, or genuinely failing runs misreported as "tests did not run") — ANSI-stripped, all candidate lines collected, LAST line with passed/failed clauses wins; bun branch last-match too
- [x] [Review][Patch][HIGH] effectiveCeilingMicros could RAISE an explicitly lower budgetCapUsd (0.5 → 8) — cap now min(existing, ceiling, schema max); ceiling only lowers (runner.ts)
- [x] [Review][Patch][HIGH] killOrigin collapse — budget/wall-clock kills classified transient (retry re-spends), userCancel/requestedShutdown → logic unreachable. onRunFacts union widened (watchdog|budget|wallClock|userCancel|requestedShutdown|null), origins set at every kill site, classifyRun maps budget/wallClock → overflow, foreign origin default → transient fail-safe; dispatch stops collapsing (runner.ts + team-event-adapter.ts + dispatch-task.ts)
- [x] [Review][Patch][HIGH] spawn/stream failure (child error ENOENT) classified lead_failure (permanent) though runner settled transient; runner-settled logic/transient verdicts overridden to success by merged+exit-0 (worker validation failure → silent success, coms_await timeout → partial erased) — dispatch now defers to runResult.exitStatus when exit facts are absent or the runner verdict is non-success
- [x] [Review][Patch][HIGH] watchdog post-stop escalation — no `running` recheck after `await sampler()` → stray SIGTERM to possibly-recycled pgid; post-stop onUnwatchable. Fixed + external sampler given the same 3-strike tolerance as the built-in, sampler rejections no longer unhandled
- [x] [Review][Patch][HIGH] `undefined` provider joined to "undefined/m" and PASSED TeamRoleSchema (garbage test tripped only workers:min(1)) — adapter validates non-empty provider/model, clean Error naming the role (roster-adapter.ts)
- [x] [Review][Patch][HIGH] test-side: precedence test passed through pass-through (fake returned the expected status); SIGTERM delivery never asserted; "stops polling" bound vacuous; "legacy 9-field" test included every new field; argv-is-array test false-passed against shell-spawning impl (discriminating fixture: one arg containing a space survives argv-spawn only)
- [x] [Review][Patch][MEDIUM] onTeamEvent fired after settle (grandchild-held pipe mutated post-resolution state) — gated; partialOutput now collected on ALL non-success exits; runner/merger truncation caps single-sourced with suffix headroom; stop() preserves terminal handle statuses; darwin ps "group gone" no longer spurious-unwatchable; ps maxBuffer raised; testCommand fail-closed reason now logged (warn + trace) per story; testCommand skipped when signal already aborted (grace race); roster cardinality checks moved before the unabortable pi dual-gate; manifest mkdir failures → logic refusal; bare-% filenames no longer silently dropped; roster path anchored at runRoot; dropped artifacts/changedFiles now warned+traced; coms_init_error.reason redacted (INV-4); classifyRun exit-64 docstring corrected; missing-prompt and duplicate-agentId roster errors made explicit
- [x] [Review][Patch][LOW] encoded control chars re-checked post-decode; artifact names validated; stream counters numeric-guarded on PhaseRecord; refusal sub-timings omitted (undefined = not measured); QDS_RUN_ROOT="" treated as unset; dead ternary/dead SIGKILL block removed; abortTeam idempotent; pre-aborted signal skips spawn; decoder.end() skipped on truncated multibyte + surrogate-safe cuts; truncateWithSuffix marker-bearing fallback; testsExecuted inverse invariant (false + sum>0 rejects; negative counts reject); CPU advisory sampled+logged once at stop (AC7); _resetRunner seam; e2e roster analyst's bash dropped (least privilege — evidence shows zero use)
- [x] [Review][Patch][LOW] test hardening wave: env snapshot/restore exact, manifest-cleanup observability, marker-file no-spawn proof, per-provider key refusals, first-wins asserted, partial:true on overflow, artifact-name REDACTED assertion, temp rosters to os.tmpdir, win32 skipIf, satisfies-typed fake runner, Zod-wording decoupled, 3-strike unwatchable tests, poll-with-deadline timing, merger base() consolidated, sampler-null conflation removed, all-skipped + external-signal pins, roster negative controls, minimal-coms leniency pin
- Verified false-positives (pushback): PR1 dispatch abort-signal "not forwarded" — verified threaded twice (PhaseBodyContext.signal → deps → runTeamManifest abortSignal + runTestCommand); truncation-suffix length semantics (suffix describes stored text); wrong-split tautological negative controls (story-DoD-mandated shape); partialOutput containing dropped-oversize bytes (contract is "output received before termination")
- Deferred: real-spawn-from-phase unit coverage (live e2e evidence in _bmad-output/evidence/df1-6 + runner-integration seam cover it); self-pgid watchdog test hardening (injected samplers mitigate; fires only on regression)
- Pre-existing, not touched: usage.test.ts catalog-scan/boundary timeouts (fail identically on clean HEAD); 1 flaky real-ps watchdog integration test
