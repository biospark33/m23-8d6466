# DF2.12: Per-Role Token Cost Attribution Wired End to End

**Story Points:** 3

**Status:** ready-for-dev

**Sprint:** v5-S3

## Spec Reference

> **Placement provenance (2026-09-08) — do not "restore" the old framing.** Three artifacts titled
> this story's work as happening *"at the Dispatcher"*: `sprint-status.yaml`'s DF2.12 row and
> `df3-6a-resident-spend-iteration-bounds.md`'s "at the dispatcher" statements (grep anchor
> `at the dispatcher`; the former `:229`/`:313` cites do not carry them — W6-E-M7; the yaml row is
> already corrected). That is the **pre-ADR** placement,
> which D8 forbids — an in-box call cannot reach the host-side SQLite ledger. This story's own
> Technical Notes refute it (see "Why the marker's 'one call at the dispatcher' is stale"): the
> work is **stamped in-box at the dispatcher, ingested host-side at teardown's close step**, and
> the ADR splits the two. The story file is authoritative
> because it is the only one of the four that agrees with the ACCEPTED ADR; the three surviving
> lines in `df3-6a…` are owned by DF3.6a's own rework wave (it is `ready-for-dev`).
>
> **Epics index (corrected 2026-09-10 — the original "no entries at all" claim is retired, and so is
> W6-E's narrower "only DF2.13 missing" reading; verified at source by grep):** all seven
> 2026-09-08 slate additions now have entries in
> `_bmad-output/implementation-artifacts/epics-and-stories-dark-factory-v5.md`, including DF2.13's
> full section ("Story DF2.13: Per-Run Key Cap Wired from the Admission Budget"). Positive control
> on the same sweep: `DF2.8` → 16. Nothing owed here any more.

- **Provenance — derived 2026-09-08 from the pre-dev adversarial review**
  (`_bmad-output/sprint-artifacts/dark-factory-v5/2026-09-08-remaining-stories-pre-dev-review-tracker.md`).
  This is a defect in **merged, shipped code**, not a new feature: a governance control that the
  architecture decided and the code declares is **disarmed in production**. Findings:
  **DF5.3-B2** ("hop 3's per-role split unobtainable; token bridge declared, not wired (#157)"),
  **DF3.6-B3** ("`runBudgetCapMicros` does not exist; DF2.8 ships a per-issue cap" — **resolved
  2026-09-08**: the term is re-homed, not dropped. Chain is now
  `residentSpendCeilingMicros ≤ capMicroUsd (mint-time, per run) ≤ defaultKeyCapMicroUsd` (`<` → `≤`);
  the mint-time cap is provider-enforced outside the trust boundary, and **DF2.13** wires it from
  DF2.8's remaining issue budget. DF2.12 remains a hard predecessor of DF3.6a for the unrelated
  token-attribution reason), **DF3.6-H4**
  ("at shipped rates the *absolute spend ceiling* cannot fire"). Tracker follow-up row **F4** and
  cross-cutting theme **CC-5** ("Cost and spend attribution is unbacked in production").
- **Closes [#157](https://github.com/Quantum-Digital-Solutions/QDS-Factory/issues/157)** bullet 1
  (F001, "the DF2.7 to host-ledger token bridge is still unwired"), whose own upgrade trigger this
  story executes. The issue's four other bullets are **not** in scope and stay open.
- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §4 **D4** (the tier-2
  resident decision and its three F7 demotion tripwires, of which **(a)** — "resident-agent token
  spend > 15% of run total at p50" — is the one this story makes *measurable*), §5.2 (the
  token/dollar cost split), §5.3 (teardown → cost ledger updated), §6 item 4 (per-run cost
  attribution, host-side, survives box destruction); §10 **F7**, risk **R3**
- `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` (ACCEPTED) — the reason the
  "one call at the dispatcher" upgrade note is stale (see Overview)
- Derivation decisions: **DD-9** (integer micro-dollars). Binding facts: **R5 §6 fact 7** (a
  pre-DF2.7 `cost` event reports the final turn only), **fact 12** (never write the 15% ratio into
  an AC — see Technical Notes for the reconciliation), **fact 11** (exe.dev pricing is
  vendor-single-origin `[VERIFY]`)
- Predecessor stories, cited not modified: `df2-8-cost-ledger-budget-cap.md` (AC1's deterministic
  `event_id`, AC4's unpriced taxonomy, AC6's close-step hook, INV-COST-1..6),
  `df1-6-dispatch-task-team-runtime.md` (the tier-3 NDJSON team-event contract),
  `df2-7-session-cumulative-cost-instrumentation.md` (the per-invocation reset boundary the
  ledger's `SUM` depends on), `df2-5-bundle-harvest-teardown.md` (harvest is the only path work
  leaves a box)
- Downstream: **DF3.6a depends on this story** (declared in that story's own predecessor list and Infra table) — its per-run resident spend ceiling is meaningless
  without per-role token attribution, and DF3.6-H4 is the finding that says so. `df5-3-audit-chain-extended.md`
  hop 3 ("µ$ total plus per-role split") and `df5-4-lights-on-gate.md` C10 both currently carry
  prose conceding they can only report box hours

## User Story

As the operator who ratified a resident agent on the explicit condition that it could be demoted on
evidence,
I want every token a run spends recorded against the role and the agent that spent it, in the same
host-side ledger the budget cap reads,
so that "the resident is costing too much" becomes a number I can query instead of a control that
was written down, declared in the code, and never armed.

## Overview

`ingestCostEvent` (`src/providers/cost-ledger.ts`) is the **only** writer of `kind='tokens'`
rows and has **zero non-test callers** — GitNexus `impact` upstream returns `impactedCount: 0`. The
codebase says so about itself in three places: `scripts/qds-cost.ts` `run`/`reportLedgerOpenFailure` region ("nothing calls
`ingestCostEvent`, so a ledger with no `kind='tokens'` row is reporting box hours as if they were
the whole bill"), `emitTokenBridgeState`'s F001 docblock in `cost-ledger.ts` and the `ponytail:` marker on it which names the
fix. Production runs therefore write **box-hours only**, `perRole` holds the single literal
`"box-hours"` key, and every per-issue cap decision is taken on a partial total.

What that silently disables: design **D4**'s tripwire (a) is undecidable, because nothing separates
resident spend from run total; **DF3.6a**'s per-run resident ceiling has no per-role figure to bound;
**DF5.3** hop 3's per-role split is unobtainable; and `teardown.ts`'s own
`reportSpendDivergence` (`:545`) has an `unwired` outcome that fires on **every** priced run,
which is a permanent alarm nobody can act on.

This story wires it, and the wiring is **two legs, not one call** — because the "one
`ingestCostEvent` call at the dispatcher site" the marker names was written when the dispatcher ran
on the host. Under the 2026-08-31 tier-2 placement ADR it runs **inside the box**
(`scripts/pipeline-run.ts:121` imports `dispatchTask`; the unit is `qds-run@<runId>.service`), and
the ledger is host-side `.sandbox/cost-ledger.db`, which by D8 no in-box process can reach. So: the
**in-box leg** stamps one durable attribution row per cost event onto a surface harvest already
pulls; the **host leg** ingests those rows into the ledger at teardown's close step, immediately
before the `ingestBoxHours` call that already lives there. One new emission, one new host-side
reader, no new transport, no new file in the harvest manifest.

## E2E Slice

**Demonstrable behavior:** Given a dispatched run `qds/demo#42` with a lead, two workers and an
armed DF3.3 resident, When the run completes and `bun scripts/sandbox-teardown.ts <run-id>` reaches
its close step, Then the ledger holds one `kind='tokens'` row per emitted cost event — each with
`role ∈ {lead, worker, resident}`, its `agent_id`, its `model`, its token and cache counts, its
`key_hash`/`key_limit_micro_usd` and an integer `cost_micro_usd` — plus exactly one `box_hours` row,
and `qds cost qds/demo#42` prints a **multi-role** split rather than the single `"box-hours"` line.
`readRunCost(<run-id>)` reports `hasTokenRows: true`, and
`perRole.resident / (totalMicroUsd − perRole["box-hours"])` is a number — the per-run quantity D4
tripwire (a) takes the p50 of. Re-running teardown to completion adds **zero** rows.

**Wiring closed:** On completion of this story, token spend reaches the host-side ledger end to end —
in-box cost event → durable attribution row → harvest → close-step ingest → issue SUM → the same
`assertWithinBudget` the next dispatch reads — using only code merged by this story plus DF2.5's
harvest, DF2.7's instrumentation and DF2.8's ledger. No stub, no `TODO: wire later`.
`CostLedger.emitTokenBridgeState()` keeps its place but **inverts meaning**: it stops reporting a
known-permanent state and becomes a live tripwire for a broken bridge, and
`reportSpendDivergence`'s `unwired` outcome stops firing on healthy runs.

**Dependency edges (predecessors):** **DF2.8** (the ledger, `ingestCostEvent`'s contract, the
close-step hook), **DF1.6** (the tier-3 team-event NDJSON contract and `adaptTeamEvent`), **DF2.7**
(session-cumulative cost instrumentation and its per-invocation reset boundary, without which the
`SUM` over rows double-counts). All three are `done`. **DF2.5** is a de-facto edge for the harvest
surface and is also `done`.

**Sequencing note (not an edge): DF2.11 edits the same four files, and lands first.** DF2.11
(`v5-S3`, `ready-for-dev`, same sprint) adds a required `lock: RunLockHandle` parameter to
`teardownSandbox` and rewrites **53** `teardownSandbox(` call sites in
`tests/providers/teardown.test.ts` — the file this story adds assertions to — and also edits
`src/providers/teardown.ts`, `src/providers/cost-ledger.ts` and
`tests/providers/cost-ledger.test.ts`. **DF2.11 lands first** (its change is mechanical and total;
this story's is additive at `teardown.ts:608`/`:757`), and **this story rebases onto the new
`teardownSandbox` signature**. This story's `emitTokenBridgeState` reclassification changes the
method's **message** only, not the read-only behaviour DF2.11's `openReadOnly` depends on — so the
two are compatible in substance and only the merge order matters. Recorded on both sides so the
order is a planning decision, not a merge accident.

**Successor edge (hard): DF3.6a depends on this story** — and says so itself. Its absolute per-run resident spend ceiling
bounds a quantity that does not exist in the ledger today; DF3.6-H4 records that at shipped rates
the ceiling cannot fire, and per-role attribution is the input that makes it a real bound rather
than a constant that is never approached.

## Acceptance Criteria

1. **(make-or-break — a real run's tokens land in the host ledger, attributed)** Given a completed
   run whose in-box engine emitted `{kind:"cost"}` team events for a lead and two workers, When
   teardown reaches its close step, Then the ledger holds exactly one `kind='tokens'` row per
   emitted event, each with `role` set from the roster entry the dispatcher spawned that `agentId`
   with, `agent_id`, `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`,
   `cache_write_tokens`, `turn_count`, `key_hash` and `key_limit_micro_usd` populated, and
   `cost_micro_usd` an integer µ$; `readRunCost(runId).hasTokenRows` is `true` and the priced SUM
   equals the sum of the individual rows exactly. **`role` is never inferred** from the model slug,
   the agent name or emission order (DF2.8's rule, restated because this story is its first
   production caller). *Negative controls: a row whose `role` is derived from `model`; a run whose
   only ledger row is `box_hours` (today's shipped behaviour) MUST fail this test.*
2. Given the same events are ingested twice — a teardown re-run after a crash, or a re-harvest —
   When ingest runs again, Then **zero** rows are added and none is mutated, because the
   deterministic `event_id` digest (`run_id, agent_id, kind, invocation_seq, turn_count,
   cost_micro_usd, timestamp`) is unchanged and the insert is `ON CONFLICT DO NOTHING`. Given two
   genuine invocations of the **same** agent in one run, Then **two** rows exist, distinguished by
   `invocation_seq`. *Negative control: an implementation keyed on `(run_id, agent_id, kind)`
   collapses the second genuine invocation and MUST fail — unrecorded spend is an unenforceable
   cap (INV-COST-6).*
3. Given a run with an armed DF3.3 resident, When it completes and is torn down, Then at least one
   `role='resident'` row exists carrying that resident's metered spend, and
   `perRole.resident / (totalMicroUsd − perRole["box-hours"])` is computable **per run** from the
   ledger alone, with no second data source and no join to the trace. Given a set of such runs,
   Then their p50 of that ratio is obtainable by a single query over `cost_events` — which is what
   makes D4's tripwire (a) decidable at the month-one evaluation the decision register scheduled.
   *Negative control: a run whose resident solicited and spent, and whose ledger holds only
   lead/worker rows, reports a resident share of `0` — a false green on a governance control — and
   MUST fail this test.*
4. Given a run whose box died or rebooted before harvest, or whose artifacts pull failed (a
   non-fatal outcome by DF2.5's design), When teardown closes the record, Then the run is reported
   as **`tokens-not-harvested`**, never as zero token spend: `readRunCost` returns
   `hasTokenRows: false` with a `box_hours` row present, and `qds cost` renders that run's token
   line as `tokens-not-harvested` in the same idiom `box-hours-pending` already uses.
   **The discriminator is the harvested evidence itself, not `hasTokenRows` alone.**
   `hasTokenRows` is `anyTokenRow.n > 0` (`cost-ledger.ts:1407`),
   which reads `false` for two different runs: one that was never harvested, and one that
   legitimately spent nothing on tokens (a dispatch refused before any spawn, a run killed in
   setup) — both with a `box_hours` row present. *(Mechanism refined during dev, 2026-09-10: the
   teardown's `{ rowsRead, outcome }` summary is a log line no later reader can see, so `qds cost`
   — a separate invocation — re-derives the discriminator from the same evidence the teardown
   read, at `<runsDir>/<runId>-artifacts/<runId>.engine.log`: the log is **absent or unreadable**
   → render **`tokens-not-harvested`**, naming the path it looked for; the log is **present with
   zero `cost_attribution` lines** → render **`no-token-spend`**; the log has **lines whose rows
   all landed unpriced** (unusable money or sub-µ$ — ingested, not refused) → render
   **`unpriced (n)`** with the row count; the log has **lines but zero token rows written at
   all** (every line refused) → render **`token-rows-refused (n)`** with the count, never a
   silent `0 µ$` *(review round: the old single "zero priced rows" arm folded honest unpriced
   rows into the refusal label)*. The teardown's own summary line carries the outcome vocabulary
   (Observability Contract), so the two surfaces agree by construction.)*
   *Negative controls, both MUST fail:
   an implementation that renders a missing token set as `0 µ$` reports a run that certainly spent
   money as free (the same fail-closed rule INV-COST-6 states for an absent ledger); and a renderer
   keyed on `hasTokenRows` alone reports every refused-before-spawn run as unharvested, firing a
   false alarm on every cheap or aborted run.*
5. Given a cost event whose figure is unusable — non-finite or negative `costUsd`, or
   `unpricedTurns > 0` — When it is ingested, Then the existing DF2.8 taxonomy applies unchanged:
   the row persists with `unpriced = 1`, is excluded from the priced SUM, and is counted in every
   view and gate decision record; **zero events are dropped**. This story adds no new unpriced class
   and changes no existing one. *Negative control: an implementation that filters malformed rows out
   at the new host-side reader — rather than handing them to `ingestCostEvent` — silently drops
   spend and MUST fail.*
6. Given this story merges, Then no shipped string still describes the bridge as unbuilt:
   **the authority is the grep, not this list.** The full set at `fa7d0e26` is **at least nine**,
   not the four originally enumerated: `cost-ledger.ts:18`, `:25-28` (which also cites
   `docs/decisions/2026-08-tech-debt-answers.md` Q1, likewise stale), `:1144`, `:1438`,
   `:1456-1460`; `scripts/qds-cost.ts` (the "nothing calls `ingestCostEvent`" comment); `tests/providers/cost-ledger.test.ts:11-13`;
   `tests/scripts/qds-cost.test.ts:711`; and the three live-e2e `tokensRowsGap` strings
   (`tier2-fanout-bestofn.live.test.ts:275`, `tier3-manystories.live.test.ts:383`,
   `tier2-dispatch-engine.live.test.ts:406` — the last also carrying a stale `cost-ledger.ts:753`
   citation for `ingestCostEvent`, actually `:961`, fixed in the same pass). Correcting only an
   enumerated subset passes a reviewer and fails the grep, which is the point: **`grep -rn 'no
   production caller\|nothing calls .ingestCostEvent\|F001' src scripts tests` must return only
   lines describing the bridge as live** — and, per the note below, must be paired with a positive
   control so a zero result cannot be an unread file. All are corrected, and
   `emitTokenBridgeState()` is **kept** with its meaning inverted — it now announces a **broken**
   bridge on a ledger that should have token rows, so its `tokens-ledger-unwired` line becomes an
   actionable fault rather than a permanent notice. `reportSpendDivergence`'s `unwired` outcome
   (`teardown.ts:567`) is likewise reclassified in its own message as a fault. *Negative control: an
   implementation that deletes `emitTokenBridgeState` outright loses the only detector for a bridge
   that regresses, and one that edits the strings without a test leaves the assertion unpinned —
   both MUST fail.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| in-box cost attribution row emitted at `dispatch-task.ts`'s `{kind:"cost"}` branch | in-scope | `tests/phase-engine/dispatch-task.test.ts` | — |
| resident solicitation spend emitted with `role: "resident"` | in-scope | `tests/phase-engine/steering.test.ts` | — |
| host-side reader over the harvested engine log → `ingestCostEvent` | in-scope | `tests/providers/cost-ledger-bridge.test.ts` | — |
| teardown close-step token ingest (both the close step and the already-closed early path) | in-scope | `tests/providers/teardown.test.ts` | — |
| `qds cost` multi-role split + `tokens-not-harvested` rendering | in-scope | `tests/scripts/qds-cost.test.ts` | — |
| D4 tripwire (a) p50 query over `cost_events` | in-scope as a **derivable quantity + a documented query**, never as an enforcement threshold (fact 12) | `tests/providers/cost-ledger.test.ts` | month-one evaluation, operator-run |
| DF3.6a's per-run resident spend ceiling and its refusal | out-of-scope | — | **DF3.6a (depends on this story)** |
| DF5.3 hop 3's per-role split in the audit chain | out-of-scope | — | DF5.3 |
| DF5.4 C10's µ$ assertion against a multi-role ledger | out-of-scope | — | DF5.4 |
| Mid-run token ingest (a live cap that sees the current run's tokens) | out-of-scope — named ceiling with an upgrade path | — | none scheduled; see Technical Notes |
| #157's four other bullets (F035/F004 residuals, the unindexed `kind` probe, the `fleet` reserve path's silence) | out-of-scope | — | issue #157 stays open |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| In-box phase engine + its team runtime | DF1.10's `qds-run@<runId>.service`; `QDS_TEAM_RUNNER=local` for the offline path | `bun test tests/phase-engine/` green; a real run emits at least one `{kind:"cost"}` team event through `adaptTeamEvent` (`team-event-adapter.ts:159`) |
| Durable in-box surface for the attribution row: `$HOME/<runId>.engine.log` | ext4 `$HOME` in the box — **already** in `BOX_HOME_SOURCES` (`src/providers/harvest.ts:166-172`) | the log survives the reboot that wipes tmpfs `/run/trace` (DF1.11's boot-anchor precedent, measured), and harvest's no-collision invariant over the three source lists is **unchanged** because no new name is added |
| Harvested artifacts directory `<runsDir>/<runId>-artifacts/` | DF2.5's `pullArtifacts` (`harvest.ts:1068`) | the harvested `<runId>.engine.log` is present after a successful teardown; its absence is the AC4 `tokens-not-harvested` path, never a zero |
| Host-side ledger `.sandbox/cost-ledger.db` | `bun:sqlite` — **no new dependency** | `ingestCostEvent`'s existing contract, schema and triggers are consumed **unmodified**; this story adds a caller, not a column |
| DF2.3 minted key hash + cap on the run record | OpenRouter key API | `ingestCostEvent` already refuses with `key-hash-missing` when the record carries no `keyHash`/`limitMicroUsd` (`cost-ledger.ts:969-976`), so a keyless run writes **no** token row rather than an unattributable one |

## Technical Notes

- **Why the marker's "one call at the dispatcher" is stale, and what replaces it.** The upgrade note
  (the `ponytail:` marker on `emitTokenBridgeState` in `cost-ledger.ts`, quoted verbatim in #157) predates the tier-2 placement ADR. The
  dispatcher site it names is `dispatch-task.ts`'s `onTeamEvent` callback (`:469`, `case "cost"`),
  and that code runs **in the box**: `scripts/pipeline-run.ts:121` imports `dispatchTask`, and
  `pipeline-run.ts` is the engine systemd starts as `qds-run@<runId>.service`. The ledger is
  host-side by §6 item 4 and D8 forbids a credential in the box, so no in-box call can write it.
  The note is not wrong about *where the attribution is known* — it is — only about *where the
  write can land*. So the split is: **attribution is stamped where it is known (in the box), the
  ledger write happens where the ledger is (on the host)**, and harvest is the gap-crossing that
  already exists.
- **The in-box surface: one `log(...)` line, no new file, no new harvest entry.**
  `dispatch-task.ts`'s injected logger writes to `process.stderr` (`defaultLog`, `:55-57`), and
  `pipeline-run.ts` tees fd 2 into `$HOME/<runId>.engine.log` (`engineLogFd`, `:289`, `:591-600`,
  path derived at `:2306-2310`). That log is **already** in `BOX_HOME_SOURCES`
  (`harvest.ts:169`), so a `{type:"cost_attribution", …}` line on it needs no change to the harvest
  manifest and cannot disturb the no-collision invariant the source lists document at
  `harvest.ts:174-195`. **The existing tmpfs trace row is left alone.** `adaptTeamEvent`'s
  `CostTraceEvent` (`team-event-adapter.ts:45-50`) keeps its `{costMicros, tokens}` shape for the
  visualizer and the trace consumers; widening it and relying on it would put the money record on
  `/run`, which the ADR's own probe measured as tmpfs that a reboot wipes. **Considered and
  rejected:** an NDJSON cost sidecar (a new file, a new harvest entry, a new collision argument) and
  a second transport (forbidden by D8 and by DF1.11's INV-IBOX-10).
- **`role` and `invocationSeq`, the two fields DF2.8 said only the dispatcher can supply.** `role`
  is read from the roster entry `dispatchTask` spawned the `agentId` with (`rosterToTeamManifest`,
  `phases/roster-adapter.ts`) and is stamped verbatim; `CostRole` is the closed set
  `lead | worker | resident | tier1` (`cost-ledger.ts:665`). `invocationSeq` is a monotonic
  per-`(runId, agentId)` counter — and the lazy correct definition is the **ordinal of that agent's
  cost events within the run**, incremented at the emission point, because DF2.7 emits exactly one
  `cost` event per pi subprocess invocation, which makes the emission ordinal and the invocation
  ordinal the same number without any spawn-site plumbing. It satisfies the only property DF2.8
  requires of it: two genuine invocations of one agent never digest identically. **Named ceiling:**
  the counter lives in engine memory, so a restarted engine would restart it — which cannot produce
  a collision here, because DF1.10 ships `Restart=no` and DF1.11 AC4a establishes that a reboot
  *ends* the run; there is no resumed run for a restarted counter to collide with. If a resumable
  engine is ever introduced, the counter must be seeded from the durable log's last ordinal, and
  that is the upgrade path.
- **The host leg, and where exactly it hooks.** One new host-side function —
  `ingestHarvestedTokens(ledger, runsDir, runId, ctx)` — reads `<runsDir>/<runId>-artifacts/<runId>.engine.log`
  (`harvest.ts:1068` for the directory), selects the `cost_attribution` lines for this `runId`, and
  calls `ledger.ingestCostEvent(event, ctx)` once per line. `ctx`'s `repoSlug`/`issueId` come from
  the run record's `extensions.budget` — **the same source and the same string-only validation**
  `ingestBoxHoursIfAttributed` already uses (`teardown.ts:482-502`); `requestId` is the teardown's
  own; `role` and `invocationSeq` ride the line. It is called from **both** existing ingest points
  in `teardown.ts` — the close step (`:757`) and the already-closed early path (`:608`, the
  crash-window fix DF2.8's review round added) — **immediately before** the `ingestBoxHours` call at
  each, so: a teardown that aborts before close writes neither (DF2.8 AC6's semantics extend
  unchanged); a crash-recovery re-run heals both; and `reportSpendDivergence` (`:619`, `:771`),
  which runs **after**, finally compares the provider's authoritative figure against a derived total
  that contains tokens.
- **The µ$ ↔ USD seam, stated because it is a money path.** *(Refined during dev, 2026-09-10: the
  DD-9 unit-boundary guard — `tests/phase-engine/usage.test.ts`, "no float-dollar field exists
  anywhere inside src/phase-engine", exactly one `costUsd` reference in the adapter — forbids the
  engine line from carrying the wire's float `costUsd`, so **both** team and resident attribution
  lines carry `costMicroUsd` (integer µ$) and the union "costMicroUsd | costUsd" below is now
  `costMicroUsd` only.)* The team runtime's events carry `costUsd`
  (`cli-anything/src/types.ts:141-161`); the adapter's one sanctioned conversion
  (`CostTraceEvent.costMicros`) turns it into integer µ$ at the DF1.3 boundary and the line carries
  that. The **resident** has no provider-reported USD: `steering.ts`'s `meter()` computes integer µ$
  from `usage.inputTokens/outputTokens × rate` and accumulates `telemetry.spendMicros`; its line
  carries **µ$ directly**. On the host, the reader converts µ$ → USD once to hand
  `ingestCostEvent` a **`CostWireEvent`, which converts back** at `usdToMicros` — exactly as DF2.8
  specifies, with one conversion at each side's boundary and µ$ inside both. That round trip is
  **exact** across the money range the mandated ≥10,000-value property test sweeps — *(dev-recorded
  2026-09-10: bit-exact through 2^50; above ~2^51 a float half-tie can drift ONE µ$ — ~$4.5
  quadrillion of spend, five orders past any real run; idempotency unaffected, since the same
  float re-harvest digests identically; the fix, an exact decimal conversion in `usdToMicros`, is
  a `cost-ledger.ts` behaviour change this story does not take — recorded at the property test,
  not hidden)* — and `usdToMicros` refuses anything outside safe-integer range, so no wrong value
  is ever stored. A second
  writer taking µ$ directly was rejected: `ingestCostEvent` being the *only* writer of
  `kind='tokens'` rows is a property DF2.8's idempotency and unpriced taxonomy both rest on.
  **Rate provenance (F8/R6, binding):** the resident's rate is an **API** rate stamped on DF3.6a's
  frozen manifest; no Max-derived rate may appear in the ledger or any view derived from it.
- **`invocationSeq` is read off the line, never re-derived from the reader's iteration order.** A
  reader that enumerates harvested lines and assigns the ordinal by position re-numbers on a
  *partial* re-harvest, which changes AC2's `event_id` digest and turns `ON CONFLICT DO NOTHING`
  into duplicate spend. *Negative control: a position-derived reader passes AC2's full-replay test
  and MUST fail a partial-replay test (ingest lines 1-2, then ingest lines 1-4).* (INV-COST-8
  covers the field's provenance; this covers the reader's.)
- **D4 tripwire (a) — made *decidable*, deliberately not made *enforceable*, and why that is the
  correct reading.** R5 §6 fact **12** is binding — *never write the 15% ratio into an AC* — and
  `df3-6a-resident-spend-iteration-bounds.md` (the 2026-09-08 split of DF3.6) records the gates report's finding that the ratio is a **trap**
  (on an all-cheap roster a v4-flash resident trips at N=2 steering turns while a frontier roster
  tolerates 65), re-speccing in-run containment as an **absolute** per-run spend ceiling. Those two
  facts are not in tension with this story: D4's tripwire is an **ADR-level governance decision,
  evaluated by the operator after a month of run data**, not a runtime gate. So this story's job is
  to make the quantity **queryable and honest** — per-run resident share, p50 across runs — and it
  writes **no** threshold, **no** ratio constant and **no** refusal path. Enforcement remains
  DF3.6a's absolute ceiling. AC3 is written as computability for exactly this reason; an AC that
  refused a run at 15% would violate fact 12 and reintroduce the trap.
- **Named ceiling — token rows land at teardown, not mid-run.** The pre-dispatch budget gate
  (`assertWithinBudget` / `admitIssue`) therefore still sees **prior** runs' tokens plus this run's
  reservation, not the current run's live token spend. That is a real limit and it is not closed
  here. It is also not a hole: in-run containment is DF2.3's provider-side key cap (a key that
  cannot overspend) and DF2.4's live cap-hit kill, and the reservation the gate holds is the
  current run's full admitted ceiling until priced spend is observed — the fail-safe direction.
  **Upgrade path, named and not built:** DF3.8's sweep already visits live runs on a cadence and
  already reads box files; a mid-run pull of the engine log's cost lines through the same reader,
  ingested idempotently by the same `event_id`, would close it with no new mechanism. Do not build
  it speculatively.
- **Named ceiling — a run whose box dies before harvest loses its token rows.** The attribution log
  is ext4 and survives a reboot, but nothing survives a destroy that precedes a harvest. DF5.3
  already types this class as `evidence-not-harvested`; AC4 gives the ledger side of it the same
  treatment — `tokens-not-harvested`, never `0` — and `CostView.hasTokenRows`
  (`cost-ledger.ts:1407`) is the field that already distinguishes the two, so no schema change is
  needed to report it.
- **Region ownership on shared files.** `src/providers/cost-ledger.ts` is **DF2.8's** and takes
  **no signature and no schema change** — this story is its first production caller, and the
  columns AC1 requires all exist today (`SCHEMA`, `cost-ledger.ts:323-345`). `src/providers/teardown.ts`
  is **DF2.5's** and takes **only** the two ingest calls at the two existing ingest points, adding
  no step and reordering none — the same additive claim DF2.8 made and DF2.5's Technical Notes
  sanction ("the six steps are a floor … the contract is their relative order").
  `src/phase-engine/phases/dispatch-task.ts` is **DF1.6's** and gains one log line plus the counter.
  `src/phase-engine/steering.ts` is **DF3.3's** and gains **one emit call** at the existing
  `meter(reply.usage)` site (`:894`) — this is the one ownership crossing in the story and it is
  additive: no change to the solicitation points, the fold budget, `ResidentTelemetry`'s closed key
  set, or the journal `resident` block.
- **Estimate honesty.** 3 points assumes the resident leg is that single emit call. If DF3.3's
  metering turns out to need the rate provenance threaded to reach an attributable figure, this is a
  4 — flagged here rather than discovered mid-sprint. Nothing else in the story is uncertain: the
  ledger side is a caller for an already-tested method, and the harvest surface already ships.
- **Deviation/assumption — R5 §6 fact 7.** Before DF2.7 a `cost` event reported the final turn only;
  DF2.7 is merged, so the events this story ingests are per-invocation complete. The ledger's `SUM`
  is sound **only** under that per-invocation reset boundary: if a producer ever emitted running
  totals across invocations the `SUM` would double-count. That is a contract break in the producer,
  which this story does not compensate for by de-duplicating or taking a maximum (DF2.8's
  Technical Notes, restated).

## Observability Contract

- Every in-box attribution emission logs `{ requestId, runId, phaseId, agentId, role,
  invocationSeq, model, costMicroUsd, inputTokens, outputTokens, cacheReadTokens,
  cacheWriteTokens, turnCount, unpricedTurns, timestamp }` — `timestamp` being the **wire event's**
  emission time, which is a digest input and must not be replaced by the log's own clock.
- Every host-side ingest logs `{ requestId, runId, repoSlug, issueId, role, kind: "tokens",
  costMicroUsd, unpriced, inserted, durationMs, outcome }` where `outcome ∈ ingested | duplicate |
  refused`, and one summary line per teardown carrying `{ rowsRead, rowsInserted, rowsDuplicate,
  rowsUnpriced, outcome }` with `outcome ∈ ingested | tokens-not-harvested | no-token-spend |
  refused`. `tokens-not-harvested` and `no-token-spend` are deliberately distinct states (review
  round): the former is missing or UNREADABLE harvest evidence — the summary names the path it
  looked for and the DF2.5 outcome that explains it, and the run's spend is UNRECORDED, never
  zero; the latter is a READABLE log that carries zero `cost_attribution` lines — readable zero
  spend. Folding one into the other either alarms on a genuinely spendless run or books a failed
  pull as a clean zero; `refused` (evidence present, attribution refused) never degrades to
  either.
- Errors carry `{ code, message, remediation }` where `remediation` is the literal next command.
  Sub-timings: `log_read_ms`, `ingest_ms`. **No credential material anywhere:** the attribution
  line carries `agentId`, `role` and `model` and never a key, a key hash or an `sk-or-` token, and
  ledger rows carry `key_hash` only (INV-COST-5) — the plaintext is host-only and enters no log line
  on either leg.

## Files to Modify

- `src/phase-engine/phases/dispatch-task.ts` (DF1.6-owned) — the attribution line at the
  `case "cost"` branch (`:469`) and the per-`(runId, agentId)` emission counter
- `src/phase-engine/phases/team-event-adapter.ts` (DF1.6-owned) — surfaces the wire event's stable
  fields to the branch above; `CostTraceEvent` (`:45-50`) and the existing trace row are
  **unchanged**
- `src/phase-engine/steering.ts` (DF3.3-owned; **adds only** one emit at the existing
  `meter(reply.usage)` site, `:894`)
- `src/providers/cost-ledger-bridge.ts` (**new** — the host-side reader and `ingestCostEvent`
  driver; the only new module in this story)
- `src/providers/teardown.ts` (DF2.5-owned; **adds only** the two ingest calls, one at `:608`'s
  early path and one at `:757`'s close step, each immediately before the existing
  `ingestBoxHoursIfAttributed`)
- `src/providers/cost-ledger.ts` (DF2.8-owned; **prose only** — the `emitTokenBridgeState` F001 docblock paragraph, its
  `ponytail:` marker, and `emitTokenBridgeState`'s message reclassified per AC6. No
  signature, no schema, no behaviour change)
- `src/providers/index.ts` (the bridge export)
- `scripts/qds-cost.ts` (the stale "nothing calls `ingestCostEvent`" comment; the multi-role split rendering; the
  `tokens-not-harvested` line)
- `tests/phase-engine/dispatch-task.test.ts`, `tests/phase-engine/steering.test.ts`,
  `tests/providers/cost-ledger-bridge.test.ts` (new), `tests/providers/cost-ledger.test.ts` (the
  `:11-13` INV-COST-2 header note and the tripwire-quantity query),
  `tests/providers/teardown.test.ts`, `tests/scripts/qds-cost.test.ts`

**Blast radius (GitNexus `impact`, upstream, `fa7d0e26`):** `ingestCostEvent` — `impactedCount: 0`,
risk **LOW**, zero direct callers, zero affected processes. That number *is* the defect, and it is
also why the ledger-side risk of this story is small: adding the first caller cannot break a
caller that does not exist. The risk sits in `teardown.ts`, whose `teardownSandbox` is
**CRITICAL** with 7 direct callers — which is why the two new calls go at the two ingest points
DF2.8 already established rather than anywhere new in the six-step sequence.

## Security Invariants

- **INV-COST-8 (attribution is supplied, never inferred):** `role` comes from the roster entry the
  dispatcher spawned the agent with and `invocationSeq` from the dispatcher's own counter; neither
  is derived from the model slug, the agent name, emission order or any heuristic. A line missing
  either is refused with a structured error naming the field and **zero** rows written — DF2.8's
  `assertIngestCtx` behaviour, consumed unchanged. An unattributable cost is not persisted under a
  guessed key.
- **INV-COST-10 (the attribution line's durability is asserted, not inherited):** the emission is
  durable today only by accident of wiring — `dispatch-task.ts:90` declares
  `log?: (line: Record<string, unknown>) => void` as **optional**, `:261` falls back to
  `defaultLog` (`:55-57`, `process.stderr.write`), and production gets the tee only because
  `scripts/pipeline-run.ts:2144` happens not to inject a logger. `dispatchTask` is exported from
  the public barrel (`src/phase-engine/index.ts:96`), so any caller that injects a logger — the
  obvious thing to do with an injectable one — writes the attribution nowhere and the run silently
  reports `tokens-not-harvested`. The attribution emission therefore **does not go through the
  injectable `log` seam**: it goes through a dedicated `emitCostAttribution` writer targeting fd 2
  directly, **not overridable by `deps`**. A caller that injects a logger may lose trace lines; it
  must not be able to lose money rows.
  *Negative control: an implementation that emits the attribution line through `deps.log` passes
  every `tests/phase-engine/dispatch-task.test.ts` assertion — those inject a spy logger by
  construction, which is exactly the configuration that loses the row — and MUST fail a test that
  calls `dispatchTask` with an injected logger and asserts the line still reaches fd 2.*
- **INV-COST-9 (the bridge fails closed, in the direction that costs money to ignore):** a harvested
  log that is absent, unreadable or truncated yields `tokens-not-harvested` — a named outcome that
  every view and every gate decision record carries — and **never** an implicit zero. A malformed
  line is handed to `ingestCostEvent` and persists `unpriced = 1` rather than being filtered out by
  the reader: a row the reader drops is spend no cap can ever see, which is the one outcome
  INV-COST-6 rules out.
- **INV-COST-5 restated (credential linkage):** every token row carries the `key_hash` and
  `key_limit_micro_usd` of the DF2.3 key that could have produced the spend, never the plaintext
  key. A run with no resolvable key writes **no** token row (`key-hash-missing`,
  `cost-ledger.ts:969-976`) rather than an unattributable one — the fail-closed arm, unchanged.
- **INV-COST-4 restated (unit and rate integrity):** every stored money value is an integer µ$
  (DD-9). Float exists only on the DF2.7 wire and on the single documented resident µ$→USD→µ$ seam,
  which is exact within the ledger's accepted range and is pinned by a round-trip test. No
  Max-derived rate reaches the ledger or any view derived from it (F8/R6).
- **INV-COST-1 restated (append-only):** this story writes through `ingestCostEvent` only; it adds
  no `UPDATE`, no `DELETE`, and no path that rewrites a row to reconcile a total. The store's
  `BEFORE UPDATE`/`BEFORE DELETE` `RAISE(ABORT)` triggers are untouched.
- **No secret on argv, on either leg:** the in-box emission is a `log()` call, not a spawn; the
  host-side reader opens a file. Neither leg constructs a command line, so DF2.3's INV-CRED-3
  (payload on stdin, never argv) has no new surface here.

## Definition of Done

- [ ] **Impl:** one attribution line per cost event on `$HOME/<runId>.engine.log`, carrying role,
      agentId, invocationSeq, model, token/cache counts, turnCount, unpricedTurns, the wire cost and
      the wire timestamp; the resident's solicitations emit the same line with `role: "resident"`.
- [ ] **Impl:** `src/providers/cost-ledger-bridge.ts` reads the harvested log and drives
      `ingestCostEvent`, building `ctx` from the run record's `extensions.budget` through the same
      string-only validation `ingestBoxHoursIfAttributed` uses.
- [ ] **Integration:** both teardown ingest points call it immediately before `ingestBoxHours`, so a
      teardown that never reaches close writes neither and a crash-recovery re-run heals both;
      `reportSpendDivergence` runs after and now compares like for like.
- [ ] **Contract:** `cost-ledger.ts` takes no signature and no schema change — asserted by a test
      that diffs the `cost_events` column set against DF2.8's; `CostView`'s field names are
      unchanged, so DF5.3 and DF5.4 read the same shape.
- [ ] **Contract:** `qds cost <owner/repo>#<N>` prints a multi-role split, and a run with no token
      rows renders `tokens-not-harvested`, never `0`.
- [ ] **Security:** INV-COST-8/9 asserted; a grep of both legs' log lines finds no `sk-or-`, no key
      hash and no key material; `key_hash`/`key_limit_micro_usd` present on every token row.
- [ ] **Test (attribution, AC1):** a three-agent run (lead + 2 workers) → three token rows split by
      role, summing exactly to the run total minus box hours; a `role` derived from the model slug
      MUST fail; today's box-hours-only ledger MUST fail.
- [ ] **Test (idempotency + second invocation, AC2):** replaying the same log adds zero rows; two
      genuine invocations of one agent produce two rows distinguished by `invocation_seq`; a
      `(run_id, agent_id, kind)` key MUST fail.
- [ ] **Test (tripwire quantity, AC3 — the falsifiable core):** from **real ingested rows** (not a
      hand-inserted fixture), `perRole.resident / (totalMicroUsd − perRole["box-hours"])` is
      computed per run and the p50 across a set of runs is obtained by a single query; a run whose
      resident spent but whose ledger holds only lead/worker rows yields a resident share of `0` and
      MUST fail this test. **No 15% constant appears anywhere in the implementation or the tests**
      (R5 §6 fact 12) — asserted by a grep.
- [ ] **Test (not-harvested is not zero, AC4):** an injected artifacts-pull failure → `box_hours`
      row present, `hasTokenRows: false`, `qds cost` renders `tokens-not-harvested`; an
      implementation rendering `0 µ$` MUST fail.
- [ ] **Test (unpriced taxonomy unchanged, AC5):** non-finite / negative / `unpricedTurns > 0` lines
      reach `ingestCostEvent` and persist `unpriced = 1`; a reader that filters them MUST fail.
- [ ] **Test (µ$ round trip, Technical Notes):** a **property test** over ≥10,000 pseudo-random
      integer µ$ values spanning 1 … the safe-integer ceiling asserts
      `usdToMicros(micros / 1e6) === micros`, **plus** the boundary case `usdToMicros` refuses past.
      A boundary-only test asserts nothing about the range the resident actually spends in: the
      boundary is where the guard fires (`cost-ledger.ts:274-277`), not where the float is
      interesting — `Math.round` recovers the tie below 2^53, and the values that would expose an
      error are mid-range ones whose `/1e6` lands on a representation tie.
- [ ] **Test (prose retirement, AC6) — the grep must prove it read the files.** A zero-match grep
      and a grep against a file the tool declined to read give the same output: one raw control
      byte makes a text file classify as binary and `grep` then silently reports no matches for
      *every* pattern (observed 2026-09-08 in `scripts/lib/run-lock.ts` — two raw NULs, `grep -c`
      exiting 1 while `sed` printed the symbol; PR #238 fixes that file, this pairing outlives it).
      So AC6's sweep pairs its zero-match assertion with a **positive control on the same file
      set** — one pattern that MUST match — and reports *unproven*, never *clean*, if the control
      fails. With that in place: a repo grep finds no shipped string claiming the bridge is
      unbuilt; `emitTokenBridgeState`'s new message is pinned by a test, and the
      `tests/providers/cost-ledger.test.ts:11-13` header note is corrected.
- [ ] **Test (e2e demo — MANDATORY, TWO ARMS, BOTH REQUIRED):**
      **(a) Host-leg arm, `fake` driver.** Given a hand-authored `<runId>.engine.log` fixture placed
      on the fake box's `$HOME` harvest source, drive teardown to its close step and capture the
      `qds cost qds/demo#42` multi-role µ$ split, the run's resident-share figure, and the ledger
      row set (one row per line plus exactly one `box_hours` row); re-run teardown and capture the
      zero-row delta.
      **(b) In-box-leg arm, REAL box (TIER-2, `qds-live-e2e` skill).** Drive one real lead +
      2-worker + armed-resident run on an exe.dev box through `qds-run@<runId>.service`, then
      `bun scripts/sandbox-teardown.ts <run-id>`, and capture **the harvested
      `<runsDir>/<runId>-artifacts/<runId>.engine.log` itself**, showing one `cost_attribution`
      line per cost event, plus the resulting ledger rows.
      **Arm (a) alone is a false green and MUST NOT be the evidence for AC1.** The attribution line
      reaches a durable surface only via the fd-2 tee in `scripts/pipeline-run.ts`
      (`engineLogFd` declared `:289`, written `:591-600`, path derived `:2306-2310`) — the in-box
      systemd unit. Under the `fake` driver there is no box, no unit, no `pipeline-run.ts`, no tee
      and no `$HOME/<runId>.engine.log`; the only way to produce the harvested log is to write it by
      hand, and AC1's own negative control ("today's box-hours-only ledger MUST fail") passes
      against a hand-placed fixture, so the false green is invisible. Arm (b) is the only arm in
      which the emission side runs in the shape production uses it.

## Dev Agent Record

**Implemented 2026-09-10** — branch `feature/df2-12-token-cost-attribution-wiring` (cut from `dev`
at the seventh-pin head), two-leg build: in-box leg and host leg implemented by separate workers
with exclusive file sets, each verified at source and gate-run by the parent before commit.

### What shipped

- **In-box leg (commit `074a4532`)** — `dispatch-task.ts`: `emitCostAttribution` writes fd 2
  directly (INV-COST-10 — not the injectable `deps.log` seam, not overridable); one
  `cost_attribution` line per cost event at the `case "cost"` arm; `role` from the roster entry
  (`agentRoles` map, `roles[0]` = lead — never inferred); `invocationSeq` from a factory-scoped
  per-agent counter (named ceiling: Restart=no, reboot ends the run); wire `timestamp` verbatim;
  missing role → `cost_attribution_refused`, zero emission (INV-COST-8).
  `team-event-adapter.ts`: pure `costAttributionFields` projection — `CostTraceEvent` and the
  trace row untouched. `steering.ts`: `meter()` returns its µ$ delta;
  `emitResidentAttribution` at the meter site — `role:"resident"` supplied, `costMicroUsd`
  direct, genuinely-absent wire fields `null`, `unpricedTurns: 1` when usage is absent
  (fail-closed), broken sink is a sidecar fault that never degrades the resident; optional
  `emitAttribution` dep defaulting to the fd-2 writer (production injects nothing → cannot lose
  the row).
- **Host leg** — `cost-ledger-bridge.ts` (NEW): `ingestHarvestedTokens` reads
  `<runsDir>/<runId>-artifacts/<runId>.engine.log` and drives `ingestCostEvent` once per line —
  the ledger stays the only writer; `classifyHarvestedTokens` is the same evidence classified
  without a write, shared with `qds cost` so the two surfaces agree by construction;
  `role`/`invocationSeq` read off the line, never from position (partial-replay negative
  control); string-only budget validation identical to `ingestBoxHoursIfAttributed`.
  `teardown.ts`: the token ingest at BOTH existing ingest points, immediately before the
  box-hours ingest each time — no step added, none reordered; `reportSpendDivergence`'s
  `unwired` message reclassified as a FAULT (outcome value unchanged).
  `qds-cost.ts`: per-run TOKENS column — `✓ | no-token-spend | unpriced (n) | token-rows-refused (n) |
  tokens-not-harvested`, the refined AC4 discriminator re-derived from the harvested log
  (`unpriced (n)` names rows that were INGESTED at no price — the review round split it from
  `token-rows-refused (n)`, now reserved for lines present with zero token rows written).
  AC6 prose retirement: every shipped string describing the bridge as unbuilt is gone
  (grep + positive control; `emitTokenBridgeState` KEPT as a diagnostic, its message now naming
  the live condition — see deviations).

### Design decisions and deviations (all recorded, none silent)

1. **The line's money field is `costMicroUsd`, never `costUsd`.** The DD-9 unit-boundary guard
   (`tests/phase-engine/usage.test.ts` — no float-dollar field inside `src/phase-engine`,
   exactly one `costUsd` reference in the adapter) forbids carrying the wire's float USD on an
   engine-emitted line. The worker's first cut carried `costUsd` and the guard caught it — the
   fix emits the µ$ the adapter's sanctioned conversion already produced. One conversion per
   side at each boundary; µ$ inside both. Story refined in-commit (`7d52db1`).
2. **AC4's discriminator mechanism named.** The teardown summary is a log line no later reader
   can see, so `qds cost` re-derives it from the harvested log through the bridge's own
   classifier. Story refined in-commit (`7d52db1`).
3. **`ingestCostEvent` now binds the `model` column.** AC1 requires `model` populated; the
   column has existed since DF2.8's SCHEMA and no caller ever filled it — unsatisfiable under
   the story's "prose only" constraint, which the parent relaxed for exactly this one additive
   binding (model is NOT an `event_id` digest input: no idempotency, sum or view-shape change;
   pinned by a new round-trip assertion in `tests/providers/cost-ledger.test.ts`). The
   resident's `model` binds as `""` — its wire genuinely has none.
4. **`emitTokenBridgeState` stays a diagnostic, not a hard fault.** It is ledger-WIDE and cannot
   know whether a token row *should* exist (a legitimately spendless fleet reads zero too); a
   hard fault would false-alarm every cheap run. Its message now names the live condition and
   the evidence path. The per-run fault framing lives in `reportSpendDivergence`'s `unwired`
   arm, where the provider figure *proves* spend happened.
5. **Unparseable line vs INV-COST-8/9 tension.** INV-COST-9 says hand malformed data to
   `ingestCostEvent` (unpriced=1); INV-COST-8 forbids guessing `role`. Resolution: a PARSED
   line with unusable money → `ingestCostEvent`, `unpriced=1` (AC5 honored); an UNPARSEABLE
   line still carrying the `cost_attribution` head → refused, counted, field named; plain
   non-JSON engine-log noise (stack traces) is ignored — counting it would false-alarm every
   cheap run.
6. **Summary gained a fourth outcome, `no-token-spend`.** A readable log with zero
   `cost_attribution` lines is not `tokens-not-harvested` — calling a spendless run unharvested
   is exactly AC4's false-alarm negative control.
7. **Resident line `timestamp` is the emission time** — the resident has no provider wire event
   to read one from; the event is created at the meter site. Digest-stable per line (the durable
   log carries it), so re-harvest idempotency holds.
8. **POST-REVIEW FIXES (independent closeout review — 1 CRITICAL, 2 MEDIUM, 2 LOW; every
   finding verified at source before acting; F3 already recorded above and stands):**
   - **F1 (CRITICAL, LOGIC) — the fd-2 emission bypassed the tee. FIXED.** Both emission sites
     wrote `process.stderr.write` directly. The fd-2 tee in pipeline-run is caller-level
     (`writeAll`'s own tee branch), not an OS-level dup of fd 2, and the in-box systemd unit's
     fd 2 is journald (bare `ExecStart`, no `StandardError=`) — so in the production shape every
     `cost_attribution` line reached journald and NEVER the harvested `<runId>.engine.log`:
     zero token rows for every run, the disarmed-tripwire state this story closes. The offline
     tests could not see it — they monkey-patch `process.stderr.write`, asserting the write
     happened, not that the tee captured it (the deviation-1 record's "production injects
     nothing → cannot lose the row" premise was false: the default writer itself was the loss).
     Fix: a DEDICATED money seam (never `deps.log`), `emitMoneyLine` on dispatch-task and the
     existing `emitAttribution` on steering, defaulting to raw stderr for standalone callers;
     pipeline-run exports `moneyLineTee()` (writes through `writeAll` — the line lands on the
     engine log AND stays on stderr) and injects it at BOTH production call sites. INV-COST-10's
     own name now holds for real — durability is ASSERTED: pinned by
     `tests/phase-engine/pipeline-run-money-line.test.ts` (real subprocess, real `--engine-log`
     file, both surfaces, exactly one line each; plus a structural pin on both injection sites
     with a positive control) and a dedicated-seam test in `dispatch-task.test.ts`; the TIER-2
     live round remains the end-to-end proof.
   - **F2 (MEDIUM, INVARIANT) — the in-box refusal dropped money silently. FIXED.** An agentId
     the roster never spawned (including `parseTeamEventLine`'s `"unknown"` coercion for
     external emitters) took the refusal arm, which emitted ONLY through `deps.log` — invisible
     to the harvest — so a run whose cost events were all refused read as `no-token-spend`
     downstream: a false negative on AC4's own negative control. Fix: the refusal arm now also
     emits a `cost_attribution_refused` marker on the DEDICATED money seam (still never an
     attribution line — INV-COST-8 holds); the bridge classifies the marker, counts it in
     `rowsRefused`, writes no row, and `classifyHarvestedTokens` counts it as evidence — the
     AC4 discriminator now reads `token-rows-refused (n)`, never a false spendless.
   - **F4 (LOW, EDGE) — mixed-log summary read as a clean bill. FIXED.** A log with priced rows
     AND refused lines reported `outcome: "ingested"` with no `reason`. Now any summary with
     refusals carries a reason naming the count and whether priced rows still landed.
   - **F5 (LOW, DESIGN) — token rows lacked the landedLate tripwire. FIXED.** Only
     `ingestBoxHours` carried the K1 late-landing warning; token rows feed the SAME derived SUM
     `admitIssue` reads, so a crash-recovery token ingest past the reservation-retirement cutoff
     silently re-priced a re-granted cap. `ingestCostEvent` now carries the same tripwire
     (same STRICT `<`, same margin): `token-ingest-late-past-reservation-cutoff`, outcome
     `late-ingest-over-cap-risk`, positive-spend-only, insert-only (dedup re-runs stay silent) —
     pinned with a fresh-close control mirroring the box-hours test.
   - **F3 (MEDIUM, DESIGN) — loser-arm token ingest gap: already recorded above; re-confirmed
     by the review at `makeLoserLedgerHook`. Stands as recorded (owner owed).**
   - The tracked-inputs literal moved with the phase-engine + pipeline-run edits and is adopted
     in-commit per the ritual; the branch's added defensive-programming pattern lines are
     annotated `dp:ok` with per-line reasons (the advisory baseline itself is dev-red at 342
     pre-existing findings — not this branch's regression).

### Findings recorded, not fixed (out of scope by the story's own Files to Modify)

- **`fleet.ts`'s `makeLoserLedgerHook` narrows `CostLedgerHook` to box-hours** — fan-out loser
  teardowns skip the token ingest (documented at `CostLedgerHook`). Real spend visibility gap
  for loser arms; needs an owner (follow-up story or DF2.12-b).
- **`usdToMicros` round trip drifts ≤1 µ$ above ~2^51** — pinned at the property test with the
  fix path named (exact decimal conversion, a `cost-ledger.ts` behaviour change). Bit-exact
  through 2^50; five orders of magnitude past real spend; idempotency unaffected.
- **Live-e2e assertions flipped** (`toBe(0)` → `toBeGreaterThan(0)` in the three tier live
  tests): with the bridge live, pinning zero was asserting the defect. Unverifiable offline —
  the next live round proves them.

### Verification

- `tests/providers/` + `tests/scripts/qds-cost.test.ts`: **1199 pass / 0 fail**
- `tests/phase-engine/` + image pin + story-consistency: **1110 pass / 0 fail** (image
  tracked-inputs literal adopted in-commit, `7eb1b314…`, 234/0)
- `bunx tsc --noEmit` clean; biome clean on all touched files
- TDD order held on both legs (11 + 15+ new tests written and confirmed failing first)
- Negative controls pinned: fd-2 delivery under an injected `deps.log`; shared-model roster
  (model-derived role cannot distinguish lead from worker); `(run_id, agent_id, kind)`-keyed
  dedup collapses a second genuine invocation; partial re-harvest re-numbering; box-hours-only
  ledger; empty-envelope `0 µ$` rendering; position-derived invocationSeq; unpriced-filtering
  reader; ratio constant grep (R5 fact 12)

### Owed, post-merge

- **AC1's evidence arm (b) — the TIER-2 live round** (`qds-live-e2e`): one real lead + 2-worker
  + armed-resident run on an exe.dev box, capture the harvested
  `<runsDir>/<runId>-artifacts/<runId>.engine.log` showing one `cost_attribution` line per cost
  event, plus the resulting ledger rows. Arm (a) is covered offline (teardown integration tests
  drive the real artifacts pull from box `$HOME`). Operator-gated spend, DF2.11 round-6 pattern.
- The image republish → adopt ritual rides the merge (publish-exedev-image.yml fires on dev;
  the tracked-inputs literal is already adopted in-branch).
