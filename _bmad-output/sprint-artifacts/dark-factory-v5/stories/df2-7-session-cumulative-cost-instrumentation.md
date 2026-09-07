# DF2.7: Session-Cumulative Cost Instrumentation in the Team Lead Driver

**Story Points:** 2
**Sprint:** v5-S1 (early-safe; R5 §3 pairs it with DF1.9 — same dev, same week, same file)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §5.2 (observability: "token/dollar cost split including cache economics"), §8 step 2
- Decision register: v5 §4 D5 (team runtime is pi via `team-lead-driver.ts`); derivation register §5 row 2 (**F8 condition 1**), DD-9 (unit boundary)
- Contracts: v5 §5.2 team runtime interface — NDJSON `cost` event via `parseTeamEventLine` (CC-1 event union)
- Gate condition discharged: `docs/superpowers/specs/2026-08-11-pre-derivation-gates-report.md` §3.4 condition 1 ("Instrument before pricing")
- Measured evidence: `_bmad-output/sprint-artifacts/_research/f6-step0-proof-2026-08-11.json`; gates report §1 operational findings

## User Story

As the operator pricing a hosted factory tier,
I want every pi agent's cost event to report its **session-cumulative** token and dollar usage with cache economics and a turn count,
so that every downstream cost claim — the DF2.8 ledger, the per-run floor, the budget kill threshold — is derived from measured truth instead of a last-turn sample.

## Overview

`runWorkerPi` harvests pi's `--mode json` NDJSON stream in a per-line loop
(`cli-anything/scripts/team-lead-driver.ts:188-240`) and **assigns** rather than accumulates
usage at `:231, :233, :237, :238`. For a multi-turn run the harvested `costUsd`,
`inputTokens` and `outputTokens` are the last event's values, not the run's. Those values
flow out of the two `say({type:"cost"})` emit sites (`:301-310` worker, `:363-372` lead),
across the wire as `CostEvent` (`cli-anything/src/types.ts:108-116`), through
`parseTeamEventLine` (`cli-anything/src/team-events.ts:89-106`), and into `cumulativeCostUsd`
(`cli-anything/src/runner.ts:563`) where the budget guard compares them against
`killThresholdUsd` (`:515`, 90% of cap per `BUDGET_KILL_FRACTION` at `:463`). This story
replaces assignment with accumulation, adds cache-read/cache-write token counts, a turn
counter and an unpriced-turn counter, and widens the wire contract **additively** so no
existing `parseTeamEventLine` consumer breaks.

## E2E Slice

**Demonstrable behavior:** Given a pi worker that takes N ≥ 2 usage-bearing turns, When
`npm run smoke:team` runs it under `QDS_TEAM_RUNNER=local`, Then the emitted `cost` event
reports `inputTokens`, `outputTokens` and `costUsd` as **session totals** across all N turns,
plus `cacheReadTokens`, `cacheWriteTokens`, `turnCount: N`, `unpricedTurns` — where
today's stream for the same run reports the final turn only (F6's measured event sum
**$0.04912262** is a last-turn sum; attempt 2's true cost is bracketed **[$0.049, ~$0.91]**,
gates report §1/§3.4).

**Wiring closed:** On completion of this story, session-cumulative cost is real end to end —
driver accumulator → `CostEvent` → `parseTeamEventLine` → `runner.ts` budget guard — using
only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is
required to make this behavior real. DF2.8 consumes these numbers; it does not supply them.

**Dependency edges (predecessors):** P0.3 (DONE-KEEP, mixed-model run of record).

## Acceptance Criteria

1. **(make-or-break)** Given the committed probe fixture of N = 3 usage-bearing events, When
   `runWorkerPi` harvests it, Then the resulting `PiRunOutcome` and the emitted `cost` event
   carry the **session total** for `inputTokens`, `outputTokens` **and** `costUsd` — per the
   mode the pre-dev probe fixed for *each* field independently, which also fixes which fixture
   discriminates:
   - **per-turn-delta field** ⇒ accumulate (`+=`); the fixture's final event is strictly
     smaller than the session total, and an assigning implementation reports the final turn
     and fails.
   - **running-total field** ⇒ last-wins-with-max; the fixture is **non-monotone** (a middle
     event larger than the final one, as a truncated or retried turn produces), the emitted
     value is the maximum observed rather than the last raw value, and a blind `+=`
     double-counts and fails.

   The probe's per-field verdict and the fixture it selected are recorded in the Dev Agent
   Record, so a reader can tell which negative control is the live one.
   *Negative control (both branches): the current assignment implementation (`=` at
   `:231, :233, :237, :238`) passes today's tests and MUST fail this one.*
2. Given the same stream, When the worker settles, Then the `cost` event additionally carries
   `cacheReadTokens`, `cacheWriteTokens`, `turnCount` and `unpricedTurns`, populated from the
   field names established by the pre-dev probe in Technical Notes.
3. Given a legacy `cost` line carrying none of the four new fields (the shape any non-driver
   producer emits, e.g. the warren branch at `runner.ts:554`), When `parseTeamEventLine`
   reads it, Then it returns a valid `TeamEvent` with the new numerics defaulted to `0` —
   matching the existing defaulting discipline at `team-events.ts:89-106`. No consumer of
   `parseTeamEventLine` requires a code change to keep compiling or passing.
4. Given a turn whose `usage` block is absent, non-object, or carries non-finite **or negative**
   numbers, When it is harvested, Then `turnCount` **and** `unpricedTurns` both increment, the
   priced accumulators are left unchanged, no `NaN` reaches the wire, and the worker completes
   normally (INV-COST-5). A negative token or cost value is malformed input, never a credit or a
   decrement: treating it as one would let a cumulative accumulator move backward and let the
   budget guard under-report spend.
5. Given a run with zero usage-bearing events, When the worker settles, Then the emitted
   `cost` event carries all-zero numerics with `turnCount: 0`, and `parseTeamEventLine`
   accepts it — `costUsd: 0` is a valid finite non-negative value, not a rejection.
6. Given the probe's leg-2 fixture — two invocations carrying the **same `--session-id`**, the
   second resuming the first — When both are harvested, Then two `cost` events are emitted, each
   reporting **only its own invocation's** spend per the reset boundary in Technical Notes, and the
   two events' `costUsd`, `inputTokens` and `outputTokens` **sum exactly to the session's true
   total** (the value the two captured streams' own usage records establish).
   *Negative control (double-counting): an implementation that lets a resumed session's carried-in
   totals through unchanged emits a second event that restates the first's spend, so the sum exceeds
   the true total, and MUST fail this test — that sum is exactly what DF2.8's ledger `SUM` reads, so
   an over-count here bills twice and trips the budget cap on money nobody spent.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `npm run smoke:team` (`QDS_TEAM_RUNNER=local` → `runner.ts:554` → `buildTeamSpawn` → driver) | in-scope | `cli-anything/test/runner-integration.test.ts` + the DoD e2e evidence artifact | — |
| Direct `bun cli-anything/scripts/team-lead-driver.ts` with `QDS_AGENT_TEAM_CONFIG_JSON` set (`:257`) | in-scope | `cli-anything/test/team-events.test.ts` (fixture streams) | — |
| Budget-kill path — `cumulativeCostUsd` vs `killThresholdUsd` (`runner.ts:563/:515/:707`) | in-scope | `cli-anything/test/runner.test.ts` | — |
| Warren runner branch (`runner.ts:554` non-`local`) — emits legacy-shaped cost lines | in-scope via AC3 backward-compat only; this story adds no warren-side emission (D9: demoted-optional) | `cli-anything/test/team-events.test.ts` | — |
| `qds cost <issue>` ledger view / micro-dollar persistence | out-of-scope | — | DF2.8 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| pi CLI 0.55.x with `--mode json` | host toolchain today; OCI image contract in DF2.9 | `pi --version` resolves before the probe; `smoke:team` emits ≥ 1 `cost` line |
| OpenRouter API key (`OPENROUTER_API_KEY`) | host env — direct-Anthropic rosters are blocked (host OAuth expired ~2026-02-25, R5 §6 fact 4) | key-presence logging at `runner.ts:548-551` names the key before spawn |
| `cli-anything` workspace on the project's bun toolchain | root `package.json:workspaces` | `bun test cli-anything` runs the existing 150 cases green |

## Technical Notes

- **Contracts/Schema:** `CostEvent` (`types.ts:108-116`) is widened **additively** with four
  optional numerics — `cacheReadTokens`, `cacheWriteTokens`, `turnCount`, `unpricedTurns`.
  No field is renamed, removed, or re-typed; `costUsd` keeps its existing USD-float meaning
  on the wire. Per DD-9 the integer micro-dollar unit belongs to the **DF2.8 ledger**, which
  converts at its own boundary; changing the unit here would break `parseTeamEventLine`'s
  finite/non-negative check and every existing consumer.
- **Integration points, in call order:** `runWorkerPi` harvest loop
  (`team-lead-driver.ts:188-240`) → `PiRunOutcome` (`:114-121`, widened) → `say({type:"cost"})`
  at `:301-310` (worker) and `:363-372` (lead) → `CostEvent` → `parseTeamEventLine`
  `case "cost"` → `cumulativeCostUsd` (`runner.ts:563`) → budget guard (`:707`).
- **`runner.ts` region ownership (three S1 stories touch this file):** DF1.6 owns the spawn seam
  (`:554`), DF2.7 owns the cost accumulator (`:563`, `:707`), DF1.9 owns the env/worker mapping
  (`:533-544`). No story edits another's region, so merge order cannot silently re-scope any of the
  three stories' assertions.
- **Guards/limits:** `BUDGET_KILL_FRACTION` = 0.9 of `budgetCapUsd` (default 0.5, max 10 —
  `types.ts:62-68`). That USD figure is the **tier-3 harness** cap: a different layer from DD-9's
  5,000,000 µ$ ($5.00) run budget cap (DF2.8/DF3.6), but **not an independent one**. Left at its
  `0.5` default it is the *innermost* ceiling and fires first, killing every run at ~$0.45 while the
  advertised run budget is $5.00 — the outer caps would then never bind and the containment story
  would be about a harness default nobody configured. So the harness cap is **raised at spawn to the
  run's effective ceiling** (`budgetCapUsd = effectiveCeiling` in USD, converted from µ$ at the
  spawn seam), and **DF1.6 owns that write** — it owns `runner.ts:554`, the spawn seam where the
  value is set. This story neither sets nor reads it; it only states the relationship so the two
  layers are not reconciled by accident (DF2-P2-13).
  `MAX_TEAM_STDOUT_BYTES` = 1 MiB per line (`runner.ts:472`) is unchanged — the new fields add
  ~60 bytes to a cost line. Accumulators are monotone non-decreasing within a worker run.
- **Accumulation mode — determined empirically per field, not assumed:** whether pi 0.55.x's
  `usage.cost.total`, `usage.input` and `usage.output` are **per-turn deltas** or **running
  session totals** decides the operator, and the answer is **not assumed to be the same for
  cost and for tokens**. Delta ⇒ `+=`; running total ⇒ last-wins (or max); a blind `+=` on a
  running total double-counts (INV-COST-3). Pre-dev probe (no sign-off), **two legs**:
  - **Leg 1 — per-field mode.** Run `pi --provider openrouter --model <cheap slug> --mode json
    --no-session -p '<2-turn prompt>'`, capture the raw NDJSON, and record in the Dev Agent Record
    the observed per-event `usage` shape, the per-field mode, and the exact cache field spelling
    (`cache_read_input_tokens` / `cache_creation_input_tokens` vs camelCase). Commit the stream
    as the AC-1/AC-2 fixture so the decision is auditable and the test discriminates.
  - **Leg 2 — the reset boundary.** Run **two** invocations carrying the **same `--session-id`**,
    each with its own prompt, and capture both streams. Record whether the second invocation's
    `usage` restarts from zero or continues from the first's totals. Commit both streams as the
    AC-6 fixture.
- **What "session-cumulative" means, stated as a boundary (not left to the reader).** The
  accumulator's reset boundary is the **pi subprocess invocation**: each `runWorkerPi` call starts
  its accumulators at zero and the `cost` event it emits reports that invocation's own total. A
  resumed `--session-id` therefore produces **two** `cost` events, each complete for its own
  invocation, and the run's true total is their **sum** — never the larger of the two, and never one
  of them read as if it already contained the other. This is the contract DF2.8's ledger sums over:
  one row per emitted `cost` event, `SUM` across rows, which is only correct because no event
  restates another's spend. If leg 2 shows pi's own `usage` continuing across a resumed session
  (i.e. the second invocation's stream already contains the first's totals), the harvest loop
  subtracts the carried-in baseline observed at the invocation's first usage event so the emitted
  event still reports **only this invocation's** spend — the boundary above is the contract, and pi's
  reporting mode is an implementation input to honouring it, not a licence to change it.
- **Cost-semantics blast radius:** changing what `costUsd` means changes **when the budget
  guard fires**. Under-accumulation over-spends; double-counting kills healthy runs early.
  AC1, INV-COST-2 and INV-COST-3 exist because this is the only cost signal the kill path reads.
- **Deviation/assumption:** the probe is against pi 0.55.x on this host. If the cache fields
  are absent from pi's stream entirely, emit `cacheReadTokens`/`cacheWriteTokens` as `0`,
  record the gap in the Dev Agent Record, and note it as an open input to the price sheet
  (gates report §3.4 condition 2) — do not synthesize cache numbers from residuals, which is
  how the 39–42K triangulation in gates report §3.3 stayed an estimate.

## Observability Contract

- Every pi subprocess invocation (worker and lead) emits exactly one `cost` NDJSON event:
  `{ agentId, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, turnCount, unpricedTurns, durationMs, timestamp }`.
- Correlation keys today are `agentId` plus the run's `artifactsDir` (`runner.ts:526`);
  `requestId` propagation into `CostEvent` belongs to the DF1.4 trace store and is not
  introduced here.
- Sub-timings: `durationMs` is pi-subprocess wall clock (`started`, `team-lead-driver.ts:126`).
  pi exposes no per-turn duration breakdown, so per-turn timing reports 0 and `durationMs`
  remains authoritative.

## Files to Modify

- `cli-anything/scripts/team-lead-driver.ts`
- `cli-anything/src/types.ts`
- `cli-anything/src/team-events.ts`
- `cli-anything/src/runner.ts`
- `cli-anything/test/team-events.test.ts`
- `cli-anything/test/runner.test.ts`
- `cli-anything/test/runner-integration.test.ts`
- `_bmad-output/sprint-artifacts/dark-factory-v5/evidence/df2-7-instrumented-rerun.json`

## Security Invariants

- **INV-COST-1 (no silent under-report):** an emitted `cost` event never reports less usage
  than the stream carried. Per-agent accumulators are monotone non-decreasing across the
  harvest loop; no code path resets or overwrites them mid-run.
- **INV-COST-2 (single accounting path):** the budget kill decision and the emitted totals
  read the **same** accumulated value. There is exactly one accumulator per agent per run —
  no second tally computed for reporting, which is what makes a billing discrepancy detectable
  rather than reconcilable-after-the-fact.
- **INV-COST-3 (double-count guard):** the accumulation mode is fixed by the committed probe
  fixture and asserted by AC1's discriminating test. A run may not be killed by cost the
  stream never reported, and may not exceed `killThresholdUsd` (`runner.ts:515`) because cost
  was under-counted.
- **INV-COST-4 (no new secret surface):** the four new fields are numerics only. No free text,
  no prompt content, no key material enters `CostEvent`; the existing redaction path
  (`redactDeep` → `redactSecrets`, `redact.ts:62`) on artifact write is unchanged and still
  covers every emitted structure.
- **INV-COST-5 (fail-closed on unpriced turns):** a turn whose usage is missing, unparseable, or
  negative is counted as **unpriced**, never as `$0` and never as a credit against accumulated
  spend. `unpricedTurns > 0` marks the event as an
  incomplete cost record for DF2.8's `unpriced` ledger flag **and** marks the budget state
  unpriced. **The enforceable granularity is the pi subprocess, not the turn:** `cost` is emitted
  once per subprocess (`team-lead-driver.ts:301-310`, `:363-372`), so the host has no in-flight
  per-turn signal to kill on. A turn already running therefore runs to completion; what the flag
  blocks is the **next paid subprocess spawn**, which is refused while the cumulative total is
  known-partial (a partial total is under-counted cost, which INV-COST-3 forbids crossing the
  threshold on). A genuine per-turn kill needs the engine-side projection DF3.6 owns and is not
  claimed here. Silently pricing an unmeasured turn at zero is the failure mode this invariant
  exists to prevent.

## Definition of Done

- [x] **Impl:** `team-lead-driver.ts:231, 233, 237, 238` accumulate per the probe-determined mode instead of assigning
- [x] **Impl:** `PiRunOutcome` (`:114-121`) carries `cacheReadTokens`, `cacheWriteTokens`, `turnCount`, `unpricedTurns`, populated in the harvest loop and emitted at **both** cost sites (`:301-310`, `:363-372`)
- [x] **Contract:** `CostEvent` widened additively; `parseTeamEventLine` `case "cost"` defaults each new numeric to `0` with the existing type-guard discipline
- [x] **Integration:** `cumulativeCostUsd` (`runner.ts:563`) consumes the accumulated `costUsd`; the 90%-of-cap kill path (`:463` fraction, `:515` threshold, `:731-732` accumulate-and-compare, `:707` settle) is re-asserted against the new semantics, and a `cost` event with `unpricedTurns > 0` marks the budget state unpriced so no further paid **subprocess** is spawned against a partial cumulative total (INV-COST-5)
- [x] **Security:** unpriced turns increment `unpricedTurns` and never contribute `$0` to a priced total (INV-COST-5); accumulators proven monotone (INV-COST-1)
- [x] **Test (unit):** the probe-selected AC-1 fixture → emitted `inputTokens`/`outputTokens`/`costUsd` equal the session total, not the final turn: a delta-semantics field is asserted against a fixture whose final turn is strictly smaller than the total, a running-total field against a non-monotone fixture whose maximum is not its last event
- [x] **Test (negative control):** the pre-change assignment implementation fails the AC-1 test; a `+=` applied to a running-total stream fails the non-monotone fixture asserting no double-count
- [x] **Test (session reset boundary):** the probe's leg-2 fixture (two invocations, same
      `--session-id`) → two `cost` events, each carrying only its own invocation's spend, summing
      exactly to the session's true total; an implementation passing a resumed session's carried-in
      totals straight through over-counts the sum and MUST fail this test (AC6)
- [x] **Test (backward compat):** a `cost` line with none of the four new fields parses to a valid `TeamEvent` with `0` defaults; no existing `cli-anything` test is edited to accommodate the new shape
- [x] **Test (malformed usage + empty run):** `usage` absent / non-object / `NaN` / negative → `turnCount` and `unpricedTurns` increment, priced accumulators unchanged (asserted monotonic non-decreasing across the negative-value case), no `NaN` on the wire; and a zero-usage-event run emits all-zero numerics with `turnCount: 0` that `parseTeamEventLine` accepts (AC5)
- [x] **Test (e2e demo — MANDATORY):** one instrumented `npm run smoke:team` re-run writes `_bmad-output/sprint-artifacts/dark-factory-v5/evidence/df2-7-instrumented-rerun.json` containing raw NDJSON, per-agent session-cumulative totals with cache tokens and turn counts, and an explicit comparison against F6's last-turn sum $0.04912262

## Dev Agent Record

**Status:** done — PR [#103](https://github.com/Quantum-Digital-Solutions/QDS-Factory/pull/103) squash-merged to
`main` 2026-08-14. Developed with `qds-dev DF2.7 --yolo --skip-docker-tests`; all
`--yolo`-skippable HITL gates auto-approved. Three sequential in-depth review rounds run before
PR, then two post-PR review rounds:

- Round 1 (`bf85af4`) — corrected a stale suite count in the evidence artifact (175 → 178 pass,
  matching the Gates section), and extracted the budget-guard math into exported
  `applyCostEvent(state, event)` / `budgetKillThresholdUsd(cap)` helpers so `runTeamManifest` and
  `runner.test.ts` exercise the same code instead of the test re-implementing it.
- Round 2 (`3fd479b`) — `applyCostEvent` now rejects non-finite and negative `costUsd` at its
  public API boundary, setting the sticky `costUnpriced` flag instead of poisoning the cumulative
  total. Scope stated honestly: the production call site (`runner.ts:774`) was already guarded
  upstream by `parseTeamEventLine`, which drops malformed cost lines, so this is defence-in-depth
  on an exported API whose doc comment claims sole ownership of the guard math — not a live
  data-corruption bug. Direct unit test covers `NaN`, `+Infinity`, and negative input plus
  subsequent valid accumulation.

CodeRabbit merge-readiness verdict 2026-08-14: *"Yes. Excluding the failing CI workflow, this PR
is ready from a code-review perspective."* Local gates green at merge: 95 pass / 0 fail focal,
`tsc --noEmit` clean, biome clean.

> **CI note:** the `check` workflow shows FAILURE, but the job never started — GitHub Actions
> reported *"The job was not started because recent account payments have failed or your spending
> limit needs to be increased."* Billing condition across the whole v5-S1 wave, not a code signal.
>
> **Open thread:** CodeRabbit flagged that the review thread on `cli-anything/test/runner.test.ts`
> line 12 remained open at merge time even though the requested change had landed — a GitHub
> thread-state artifact, no outstanding work.

### Pre-dev probe — verdict, and how it was obtained

The live two-leg probe **could not be run**: this host has no provider credential.
`~/.pi/agent/auth.json` is `[]` and `OPENROUTER_API_KEY` is unset, so a `pi --provider
openrouter …` invocation fails at auth and spends nothing — it cannot produce a
usage-bearing stream at all. R5 §6 fact 4 already records the Anthropic OAuth expiry
(~2026-02-25). **Autonomous decision (--yolo):** rather than assume the mode or block the
story, both legs were answered from two independent empirical sources on this host.

| Field | Mode | Operator | Source |
|-------|------|----------|--------|
| `usage.input` | per-turn delta | `+=` | pi `addUsageToTotals` + session corpus |
| `usage.output` | per-turn delta | `+=` | same; observed non-monotone (158, 333, 799, 452, 200, 145) across one session — a running total cannot decrease |
| `usage.cacheRead` | per-turn delta | `+=` | pi `addUsageToTotals` |
| `usage.cacheWrite` | per-turn delta | `+=` | pi `addUsageToTotals` |
| `usage.cost.total` | per-turn delta | `+=` | pi `addUsageToTotals` (`totals.cost += usage.cost.total`) |

**Leg 1 (per-field mode).** Decisive source: pi derives its own session totals by SUMMING
per-message usage —
`addUsageToTotals(totals, usage) { totals.input += usage.input; …; totals.cost += usage.cost.total }`
in `dist/core/usage-totals.js`. Every field is therefore a per-turn delta, and the operator
is `+=` for all five. Corroborated against 1,465 real usage records from 10 local
`~/.pi/agent/sessions` directories.

**Cache field spelling: camelCase `cacheRead` / `cacheWrite`** — *not*
`cache_read_input_tokens` / `cache_creation_input_tokens`. Observed shape verbatim:
`{ input, output, cacheRead, cacheWrite, totalTokens, cost: { input, output, cacheRead, cacheWrite, total } }`.
Both cache fields read **0 in all 1,465 records** (OAuth/free routing). They are emitted as
reported and never synthesized from residuals, so gates report §3.4 condition 2 stays open.

**Leg 2 (reset boundary).** `pi --mode json` subscribes to **live** session events only
(`modes/print-mode.js`: `session.subscribe → toJsonEvent`) and does not replay pre-existing
session entries. A resumed `--session-id` emits only its own new turns, so there is no
carried-in baseline to subtract and the invocation boundary holds by construction. Stronger
still: **the driver passes `--no-session`** (`team-lead-driver.ts` spawn argv), so a resumed
session is unreachable on this code path today. The fixtures encode the boundary anyway,
because the contract is what DF2.8's ledger sums over.

**Which negative control is live.** The **delta branch** is live. The AC-1 fixture
(`cli-anything/test/fixtures/pi-usage-3turn.ndjson`) is non-monotone in all three priced
fields, so one fixture discriminates three implementations: session total 262360/1290/$0.078708,
last turn 81176/333/$0.0243528 (the pre-change assignment implementation), max turn
107436/799/$0.0322308 (a last-wins-with-max implementation). All three are asserted explicitly.

### Hazards found during implementation (not anticipated by the spec)

1. **Duplicate-emission double count (INV-COST-3).** pi emits the same assistant message —
   carrying the same `usage` object — on `message_start`, every `message_update` and
   `turn_end`, and replays the whole message list in `agent_end`. A blind `+=` over every
   usage-bearing event multiplies the bill several-fold and would kill healthy runs early.
   **Fix:** accumulate on `message_end` only; exclude `toolResult` messages (pi documents
   their usage as "not part of main LLM context accounting").
2. **Truncated stream reported as complete.** Accumulating on `message_end` alone silently
   drops an in-flight turn when the timeout path SIGKILLs pi mid-message — and emits that
   partial record as a COMPLETE one, i.e. fails open in the runaway-worker case. **Fix:**
   count open (started, never ended) assistant messages and add them to both `turnCount` and
   `unpricedTurns`.
3. **Tool output standing in for the worker's reply.** Text blocks were harvested from every
   message-bearing event, including `toolResult`. A run ending on a tool result handed the
   tool's output to `extractJsonObject`; if that output was JSON it was emitted verbatim as
   the worker's `worker_output`, `changedFiles` and all. **Fix:** gate text collection on the
   same assistant-role predicate as usage. Regression-locked by a test that fails when the
   gate is removed (verified by reintroducing the bug).

### Autonomous decisions (--yolo)

- **Probe substitution** (above) — recorded rather than blocking, with the gap stated.
- **e2e demo runs against a pi shim, not a live provider.** `npm run smoke:team` cannot
  reach a provider on this host. The evidence artifact runs the full production path
  (`runner.ts → buildTeamSpawn → team-lead-driver.ts → cost events → parseTeamEventLine →
  budget guard`) with `cli-anything/test/fixtures/team-bin/pi` replaying a real-shaped
  stream, and states plainly what that does and does not prove. No dollar figure is claimed
  against a real bill.
- **INV-COST-5 enforcement point = the lead-merge spawn.** Workers are dispatched
  concurrently under `Promise.all`, so the only "next paid subprocess" the driver can refuse
  is the lead merge. The guard is per-run: one partial worker refuses the merge for the whole
  run, because the cumulative total the budget guard reads is per-run. Behaviour is
  regression-locked by a multi-worker test.
- **`costUnpriced` is not added to `MergedOutput`.** Its key set is frozen by the P0.3-M2
  uniform-schema contract (asserted by `expectUniformSchema`). The flag rides `error.details`
  on every path that reports `cumulativeCostUsd`, plus a `diag` line; the persisted ledger
  surface belongs to DF2.8, which consumes the driver's `cost` NDJSON events directly.
- **`parseTeamEventLine` numeric strictness widened to `inputTokens`/`outputTokens`/`durationMs`.**
  They kept a bare `typeof === "number"` check, so `NaN` or a negative count reached a
  `CostEvent` that DF2.8 will sum. No legitimate producer emits those.
- **Driver made importable** via `if (import.meta.main) await main()`, so the harvest seam is
  unit-testable without spawning subprocesses. The `buildTeamSpawn` argv path is unchanged.

### Deviations

- **Which pi is actually in play — corrected during DF1.9.** A bare shell `pi` on this host
  resolves to the *global* `@earendil-works` build (0.84.1), which is what the probe corpus
  and the first source reading came from. But `bun run` / `npm run` prepend
  `node_modules/.bin`, so every project script — `smoke:team`, and therefore the driver's
  `spawn("pi", …)` — gets the **workspace-pinned `@mariozechner/pi-coding-agent` 0.55.0**,
  i.e. exactly the F13 pin the story names. **There is no version deviation on the code
  path.** The verdict was re-verified against 0.55.0 directly: `Usage` is field-for-field
  identical (camelCase `cacheRead`/`cacheWrite`, `cost.total`), and 0.55.0 likewise derives
  session totals by summing per-assistant-message usage
  (`agent-session.js:2205-2215`: `totalInput += assistantMsg.usage.input; … totalCost +=
  assistantMsg.usage.cost.total`). The per-turn-delta verdict therefore holds on **both**
  builds — a stronger result than the single-version reading first recorded here.
- **No live-billed measurement exists.** F6's `$0.04912262` remains the only real-provider
  figure, and it is a last-turn floor, not a total. This story closes the semantics; a live
  rerun to close the dollar bracket needs a funded key.

### Files changed

`cli-anything/scripts/team-lead-driver.ts`, `cli-anything/src/types.ts`,
`cli-anything/src/team-events.ts`, `cli-anything/src/runner.ts`,
`cli-anything/test/team-events.test.ts`, `cli-anything/test/runner.test.ts`,
`cli-anything/test/runner-integration.test.ts`, `cli-anything/test/fixtures/team-bin/{pi,warren}`,
`cli-anything/test/fixtures/pi-usage-3turn.ndjson`,
`cli-anything/test/fixtures/pi-session-resume-{a,b}.ndjson`,
`_bmad-output/sprint-artifacts/dark-factory-v5/evidence/df2-7-instrumented-rerun.json`.

### Review rounds (3, each a fresh cold-read of the full diff)

**Round 1 — 7 findings, all fixed.** The load-bearing one: accumulating on `message_end`
alone dropped an in-flight turn when the timeout path SIGKILLs pi mid-message, *and* emitted
that truncated record as COMPLETE — failing open in exactly the runaway-worker case the
budget guard exists for. Also: a completion-order race in the driver e2e assertion (workers
emit in completion order, not config order); `inputTokens`/`outputTokens` bypassing the new
numeric strictness; and an evidence artifact that stitched two runs into one.

**Round 2 — 8 findings, all fixed or recorded.** The load-bearing one: text blocks were
harvested from every message-bearing event including `toolResult`, so a run ending on a tool
result handed tool output to `extractJsonObject` — and if that output was JSON it became the
worker's `worker_output`, `changedFiles` and all. Also: `openMessage` as a boolean
under-counted N concurrent open messages (now a counter); a duplicated guard condition; the
missing `runner.test.ts` budget re-assertion; and this Dev Agent Record.

**Round 3 — SHIP verdict, 4 findings fixed anyway.** Cache-token extraction was never
positively exercised — renaming `usage.cacheRead` to a typo left all 175 tests green, so the
story's headline field could have read 0 forever; now covered, along with every alternative
spelling. The INV-COST-5 notice went through `diag()`, which is silenced under
`NODE_ENV=test`, making the success-path partiality signal non-existent under test (now
`console.error`). `message_start` incremented the open-message counter under a permissive
role default while `message_end` decremented under a strict one — a role-less start paired
with a `toolResult` end leaked the counter and would mark every tool-using run partial (now
strict on the way up). And `unpricedTurns` was floored to 0 on malformed input: 0 asserts
"complete", so a malformed alarm counter was silently upgraded to a clean bill of health —
now a present-but-unparseable value counts as at least one unpriced turn.

Known residuals, recorded not fixed: a turn with valid tokens but no `cost` block loses its
token counts as well as its price (fail-closed on money, data loss on tokens); AC6's negative
control kills an `agent_end`-list accumulator but cannot exercise a running-total stream,
because the probe found deltas and the driver passes `--no-session` anyway. Both are in the
evidence artifact.

### Gates

`bun test cli-anything` 178 pass / 0 fail · `bunx tsc --noEmit` clean ·
`bunx @biomejs/biome check src scripts tests cli-anything pi-vs-claude-code-vendor` clean.
Full-repo `bun test`: the two P0.5/P0.6 external-harness suites (`pi-lens-verify`,
`lsp-verify`) flake under full-suite parallel load; both pass in isolation on this branch and
on unmodified `main`, and neither is touched by this diff.

This diff adds five subprocess-spawning e2e tests, which raises machine load during the run,
and that surfaced a latent flake in the pre-existing `worker timeout` case: its 100 ms coms
budget had to land in the window between worker-a's reply arriving and the shim exiting at
300 ms, and under contention worker-a's reply missed it, failing with BOTH workers timed out.
Fixed by widening both margins — shim hold 300 ms → 1500 ms, budget 100 ms → 400 ms — with
the assertion itself unchanged. `bun test cli-anything` is now 178/178 on three consecutive
full runs.
