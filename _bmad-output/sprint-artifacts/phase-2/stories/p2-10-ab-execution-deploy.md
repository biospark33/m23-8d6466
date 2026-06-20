# P2.10: Execute Variant-Tagged A/B Runs, Declare Winner, and Deploy with Baseline Snapshot

**Story Points:** 5

> BLOCKED-BY SPIKE-10 (variant-tagged DAG execution). Ships interface + unit tests first; full E2E when seam confirmed.

## Spec Reference

- QDS-MEM-003 §8.1 (A/B execute + deploy lifecycle), §4.1 (experiments CHECK constraint; `winner` semantics); §B.2 state machine
- QDS-EXEC-001 §7 SPIKE-10 (variant-tagged DAG execution tap); QDS-MEM-003-IMPL §C D6, §C experiments DDL, §D.4 (sync `db.transaction`); §H R1/R8/R9/R10

## User Story

As a QDS optimization steward,
I want an approved experiment to drive N variant-tagged swarmclaw runs each, aggregate the chosen metric into a `winner`, and deploy the winning variant after snapshotting baseline metrics,
so that A/B outcomes are measured on real variant-tagged execution and every deploy carries the rollback precondition it needs (G6 — measurable, reversible autonomy).

## Overview

This story wires the middle of the A/B lifecycle end-to-end: from an `approved` experiment, swarmclaw executes N variant-tagged runs per variant (each run and its events carry `variant` and `experiment_id`), the chosen metric is aggregated across variants to declare `winner ∈ {a,b,none}` (`running→analyzed`), and the winner is deployed (set `deploy_ref`, snapshot `baseline_metrics_json`, set `deployed_at` and `confirm_until = deployed_at + 30 days in epoch-ms`, `analyzed→deployed`). It touches the execution dispatch layer, the metric-aggregation/analysis layer, and the `experiments` store with its `CHECK` status enum and `winner` field. These must close together because a winner with no baseline snapshot cannot be safely confirmed or rolled back by P2.11. When analysis yields `winner='none'`, deploy is refused and the experiment is finalized as a terminal no-op: the synthetic `experiment:<id>` lifecycle run (opened `running` by P2.9) is CLOSED to `runs.status='completed'` and the row is NOT P2.11-eligible, so no inconclusive experiment is stranded `running` forever (and its lifecycle events stay P2.12-retention-eligible). The §8.2 second human gate at deploy was rejected, so the winner deploys under the P2.9 approval; there is no additional gate here. Every state transition is itself emitted as an `events` audit row (`event_type='outcome'`, R1) FK-bound to the synthetic `experiment:<id>` lifecycle run created by P2.9. This story REUSES (does not reimplement) the `src/experiments/state-machine.ts` authored by P2.9 (R10), extending only its execute/deploy entrypoint guards. Whether `variant` is a first-class swarmclaw field or rides `ProtocolRun.data` is UNKNOWN and owned by SPIKE-10; this story is built interface-first; E2E gated on SPIKE-10. The interface, state machine reuse, aggregation, and deploy/baseline-snapshot logic are fully implemented and unit-tested now against the KNOWN `ProtocolRunEvent` shape (§D.5); the real swarmclaw tap is wired when the seam is confirmed. Wiring of the implemented seams closes with no stub and no `TODO: wire later`.

## E2E Slice

**Demonstrable behavior:** Against an `approved` experiment, invoke the execute command with `N=3`; the executor dispatches 3 variant-`a` and 3 variant-`b` runs (each run + its events tagged with `variant` and `experiment_id`), flips `approved→running` with `executed_at` set, then aggregates the `success_rate` metric across variants and flips `running→analyzed` with `winner='a'`. Then invoke deploy; the row flips `analyzed→deployed` with `deploy_ref` set, `baseline_metrics_json` snapshotted (containing the chosen metric's value), `deployed_at` set, and `confirm_until = deployed_at + 2_592_000_000` ms. Each transition writes an `outcome` audit event (FK to the `experiment:<id>` lifecycle run). (Under SPIKE-10 gating, the executor runs against the interface seam with a confirmed-shape fake; the metric, winner, deploy, and baseline assertions are real and run now.)

**Wiring closed:** On completion of this story, an approved experiment is executed as variant-tagged runs, analyzed to a winner, and deployed with a baseline snapshot and 30-day confirm window using only code merged by this story and predecessor P2.9 — interface-first; E2E gated on SPIKE-10. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real once the SPIKE-10 seam is confirmed.

**Dependency edges (predecessors):** P2.9 (propose + human gate — supplies `approved` experiments AND authors the shared `state-machine.ts`); SPIKE-10 (variant-tagged DAG execution tap — gates full E2E).

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given an `analyzed` experiment with `winner='a'`, When deploy is invoked, Then `baseline_metrics_json` (containing the chosen metric's `baseline_value`) and `deploy_ref` are written BEFORE the status flips to `deployed`, the row ends with `status='deployed'`, `deployed_at` non-null, and `confirm_until - deployed_at == 2_592_000_000`, AND one `analyzed→deployed` `outcome` audit event is written; if the baseline snapshot write fails, the status does NOT flip and the experiment remains `analyzed`.
2. Given an `approved` experiment and `N=3`, When execute is invoked, Then exactly 3 runs per variant are dispatched, `executed_at` is set non-null, every dispatched run and its events carry both `variant` and `experiment_id`, and the row flips `approved→running` with an audit event.
3. Given `running` variant-tagged runs that have completed, When analysis aggregates the experiment's `metric` across variants, Then `winner='x'` iff `metric(x) - metric(other) ≥ MARGIN` AND `n_per_variant ≥ MIN_N`, else `winner='none'`; at exactly `metric(x)-metric(other) == MARGIN` the variant wins (boundary inclusive); the row flips `running→analyzed` with an audit event.
4. Given an experiment NOT in `approved` status, When execute is invoked, Then execution is refused by the state-machine guard, no runs are dispatched, and the row is unchanged — only an `approved` experiment can execute.
5. Given any dispatched variant run, When its variant configuration is resolved, Then the variant config provenance is recorded by mapping `runs.variant` ('a'/'b') back to the experiment's `variant_a_ref`/`variant_b_ref` (derivable — no dedicated provenance column exists), so an analyzed winner is traceable to the exact variant ref it measured.
6. Given an `analyzed` experiment with `winner='none'`, When deploy is invoked, Then deploy is REFUSED — no `deploy_ref`/`baseline_metrics_json`/`deployed_at` is written and `status` stays `analyzed` — AND the experiment is finalized as a terminal no-op: the synthetic `experiment:<id>` lifecycle run is CLOSED to `runs.status='completed'` (one `outcome` audit event recording the no-op close) and the row is explicitly NOT P2.11-eligible (no winner to confirm/roll back), so no experiment is stranded `running` forever.
7. Given an experiment NOT in `running` status (e.g. already `analyzed`), When analyze is invoked, Then analyze is refused by the shared state-machine guard (no-op on an already-`analyzed` row) — analysis is idempotent and only a `running` source state may be analyzed, mirroring execute's `approved`-only guard.

## Technical Notes

- **Contracts/Schema:** Uses the §C `experiments` DDL verbatim (do not redefine). Execute writes `executed_at`, `status='running'`; analysis writes `winner`, `status='analyzed'`; deploy writes `deploy_ref`, `baseline_metrics_json`, `deployed_at`, `confirm_until`, `status='deployed'`. Variant tagging rides the §C `runs.variant`/`runs.experiment_id` and `events.variant`/`events.experiment_id` columns. All transition events use `event_type='outcome'` (R1/R10), FK to the synthetic `experiment:<id>` run from P2.9.
  ```typescript
  const DISPATCH_CONCURRENCY = 8;  // module constant: max in-flight dispatches; bounds 2×N (≤100) runs so the executor is not flooded (testable)
  const ExecuteSchema = z.object({
    experiment_id: z.string().min(1),
    n_per_variant: z.number().int().min(1).max(50),  // N≤50 → up to 100 runs total
  });
  const WinnerEnum = z.enum(["a", "b", "none"]);
  const DeploySchema = z.object({ experiment_id: z.string().min(1) }); // winner read from row
  // R8: baseline shape — P2.11 reads exactly this (cite "validated against P2.10 baseline shape").
  interface BaselineMetrics {
    metric: string; baseline_value: number; n: number;
    window_start_ms: number; window_end_ms: number; computed_at_ms: number;
  }
  // SPIKE-10 SEAM (interface-first): tap shape against KNOWN ProtocolRunEvent (§D.5).
  // Whether `variant` is first-class or rides ProtocolRun.data is SPIKE-10's call.
  interface VariantRunDispatcher {
    dispatch(experimentId: string, variant: "a" | "b", config: VariantConfig): Promise<RunId>;
    // implementations: ConfirmedShapeFake (now) | SwarmclawTap (post-SPIKE-10)
  }
  // R10: REUSES P2.9 src/experiments/state-machine.ts (NOT reimplemented).
  // Legal transitions used by this story (execute/deploy entrypoints):
  //   execute: approved→running, running→analyzed ; deploy: analyzed→deployed.
  ```
- **Winner decision rule:** `MARGIN` and `MIN_N` are module constants. `winner='x'` iff `metric(x) - metric(other) ≥ MARGIN` AND both variants have `n ≥ MIN_N`; the at-margin boundary is inclusive (`≥`); otherwise `winner='none'`. Asserted in the analyze test.
- **Deploy units:** `confirm_until = deployed_at + 30*24*60*60*1000` (epoch-ms per §C) = `deployed_at + 2_592_000_000`. The numeric delta is asserted, not a `"+30d"` string.
- **Rollback note (R9):** the schema has a single `deploy_ref`; deploy sets it to the winner config. Rollback = redeploy the CONTROL variant (`experiments.variant_a_ref` is the control/baseline); P2.11 OWNS the revert (sets `deploy_ref` back to `variant_a_ref`). No new column.
- **Dispatch concurrency:** execute dispatches 2×N runs (N≤50 → up to 100 runs); dispatch is throttled/bounded by the `DISPATCH_CONCURRENCY` module constant (max in-flight dispatches, default 8) so up to 100 runs do not flood the executor. The bound is a named constant/config (not a magic literal) and is asserted in the execute test (no more than `DISPATCH_CONCURRENCY` dispatches in flight).
- **Integration points (each wired & exercised in this story):**
  - `VariantRunDispatcher` seam → swarmclaw variant-tagged run dispatch (interface-first; real tap post-SPIKE-10), bounded-concurrency for 2×N runs
  - Metric aggregator → reads variant-tagged `runs`/`events` (P2.1 store) to compute `winner`; variant provenance via `runs.variant` → `variant_a_ref`/`variant_b_ref`
  - `experiments` store UPDATE for `running`/`analyzed`/`deployed` transitions
  - Shared `state-machine.ts` transition emitter → `events` INSERT (`event_type='outcome'`, carries `experiment_id`, FK to lifecycle run) per transition, atomic with the flip
- **Files / functions touched:** `src/experiments/execute.ts` (dispatch 2×N variant runs bounded, `approved→running`, set `executed_at`), `src/experiments/analyze.ts` (metric aggregation → `winner` via MARGIN/MIN_N, `running→analyzed`), `src/experiments/deploy.ts` (idempotent baseline snapshot + `deploy_ref` + `confirm_until`, `analyzed→deployed`; refuses `winner='none'` and closes the lifecycle run `completed` as a terminal no-op), `src/experiments/variant-dispatcher.ts` (SPIKE-10 seam interface + confirmed-shape fake), `src/experiments/state-machine.ts` (SHARED — authored by P2.9, REUSED here; not reimplemented).
- **Guards/limits:** execute refuses any non-`approved` source state via the shared state machine; analyze refuses any non-`running` source state via the same shared state machine (an already-`analyzed` row is a no-op/refusal, mirroring execute's guard — analysis is idempotent); deploy writes baseline + `deploy_ref` BEFORE flipping to `deployed` (rollback precondition) and is idempotent on re-run of an `analyzed` row (does NOT re-snapshot if `baseline_metrics_json` already exists); deploy REFUSES a `winner='none'` row (no `deploy_ref`/baseline write, `status` stays `analyzed`) and finalizes it as a terminal no-op by closing the lifecycle run to `runs.status='completed'` (NOT P2.11-eligible); `confirm_until` is exactly `deployed_at + 2_592_000_000`; `n_per_variant` bounded 1–50 with `DISPATCH_CONCURRENCY`-bounded dispatch; every transition event write is in the SAME `db.transaction(fn)` (sync per §D.4) as the status flip (atomicity owned by `state-machine.ts`); variant config provenance derived from `runs.variant`.
- **P2.11 eligibility filter (cross-story contract — this story is the PRODUCER, P2.11 is the CONSUMER):** the `winner='none'` terminal-close path leaves the row at `status='analyzed'` with its lifecycle run `completed`, so it is excluded from P2.11 confirm/rollback selection by STATUS ALONE. P2.11 MUST build its candidate set with `WHERE status='deployed'` — because this story's deploy guard refuses `winner='none'`, only `winner ∈ {'a','b'}` rows ever reach `status='deployed'`, so a `winner='none'` row structurally cannot qualify. An additional `AND winner IS NOT NULL` is permitted as defensive belt-and-suspenders but is redundant given the status filter (a `deployed` row always has a non-null winner by construction). The mechanism is a QUERY-LEVEL filter on `status`, NOT a new column/flag on `experiments` and NOT a runtime check — P2.11 needs no schema change from this story to exclude `winner='none'`.

## Files to Modify

> ≤10 unique paths, one per line.
- `src/experiments/execute.ts`
- `src/experiments/analyze.ts`
- `src/experiments/deploy.ts`
- `src/experiments/variant-dispatcher.ts`
- `src/experiments/state-machine.ts` (SHARED — authored by P2.9, reused here; not reimplemented)
- `tests/experiments/execute.test.ts`
- `tests/experiments/analyze-winner.test.ts`
- `tests/experiments/deploy-baseline.test.ts`
- `tests/experiments/variant-dispatcher.test.ts`

## Security Invariants

> Concrete named invariants only — N/A NOT permitted when triggered.

- **INV-OM1:** No per-event LLM/HTTP during execution/analysis/deploy; metric aggregation reads the local store mechanically. The only sanctioned LLM work in the A/B subsystem is the P2.9 optimizer scan (§B.1).
- **INV-OM2:** Every variant-tagged run and its events, and every audit transition event, carry non-null `run_id` referencing a real `runs` row; audit transitions FK to the synthetic `experiment:<id>` lifecycle run (`dag_def_id="__experiment_lifecycle__"`, created at propose time) — never NULL, never a silent drop.
- **INV-EXP4 (execute state guard):** Only an experiment in `status='approved'` may begin execution; any other source state refuses dispatch with no runs created (no execution of un-gated experiments).
- **INV-EXP5 (baseline-before-flip):** Deploy writes `baseline_metrics_json` and `deploy_ref` BEFORE flipping `status` to `deployed`; a flip without a persisted baseline is impossible, so P2.11 always has a rollback reference (the control = `variant_a_ref`, R9).
- **INV-EXP6 (variant config provenance):** Each dispatched run records which variant ref produced its config by mapping `runs.variant` → `variant_a_ref`/`variant_b_ref` (derivable, no dedicated column), so an analyzed `winner` is auditable to the exact variant measured.
- **INV-EXP7 (winner='none' terminal close):** When analyze sets `winner='none'`, deploy is REFUSED (no `deploy_ref`/`baseline_metrics_json`/`deployed_at` write, `status` stays `analyzed`) and the experiment is finalized as a terminal no-op — the synthetic `experiment:<id>` lifecycle run is CLOSED to `runs.status='completed'` and the row is NOT P2.11-eligible. No experiment is left stranded `running`; the close is atomic with its audit `outcome` event.
- **INV-EXP2 (audit event per transition):** Every legal status transition (`approved→running`, `running→analyzed`, `analyzed→deployed`) writes exactly one `outcome` `events` row in the SAME `db.transaction` as the flip (shared `state-machine.ts` from P2.9); a crash between flip and event leaves NEITHER.

## Definition of Done

> Net-new A/B execution+deploy. interface-first; E2E gated on SPIKE-10.

- [ ] **Impl:** Execute dispatches 2×N runs (bounded concurrency) per variant via the `VariantRunDispatcher` seam, tags each run + its events with `variant` and `experiment_id`, sets `executed_at`, and flips `approved→running`.
- [ ] **Impl:** Analyze aggregates the experiment's `metric` across variant-tagged runs, sets `winner='x'` iff `metric(x)-metric(other) ≥ MARGIN` AND `n ≥ MIN_N` (boundary inclusive) else `none`, and flips `running→analyzed`.
- [ ] **Impl:** Deploy sets `deploy_ref`, snapshots `baseline_metrics_json` (R8 shape), sets `deployed_at` and `confirm_until = deployed_at + 2_592_000_000`, flips `analyzed→deployed`, and is idempotent on re-run (no re-snapshot if baseline exists).
- [ ] **Contract:** `ExecuteSchema`, `DeploySchema`, and `WinnerEnum` validated on all inputs; status/winner enums match §C `CHECK`; `n_per_variant` bounded 1–50; `baseline_metrics_json` matches the R8 `BaselineMetrics` shape.
- [ ] **Interface:** `VariantRunDispatcher` seam defined against the KNOWN `ProtocolRunEvent` shape (§D.5) with a confirmed-shape fake implementation; real swarmclaw tap wired post-SPIKE-10 (interface-first; E2E gated on SPIKE-10).
- [ ] **Integration:** Metric aggregator reads variant-tagged `runs`/`events` from the P2.1 store and computes `winner` over real persisted variant data; variant provenance derived via `runs.variant` → `variant_a_ref`/`variant_b_ref`.
- [ ] **Integration (atomicity):** Each status flip + its `outcome` audit event (carrying `experiment_id`, FK to the `experiment:<id>` run) execute in ONE `db.transaction(fn)` via the SHARED `state-machine.ts` (authored by P2.9; not reimplemented).
- [ ] **Security:** INV-EXP4 enforced — a non-`approved` experiment cannot execute; no runs are dispatched on refusal.
- [ ] **Security:** INV-EXP5 + R9 enforced — baseline + `deploy_ref` persisted before the `deployed` flip; a baseline-write failure leaves the experiment `analyzed`; rollback target documented as the control `variant_a_ref` (P2.11 owns the revert).
- [ ] **Security:** INV-EXP7 enforced — a `winner='none'` row refuses deploy (no `deploy_ref`/baseline write, stays `analyzed`), closes the lifecycle run `completed` as a terminal no-op, and is NOT P2.11-eligible; analyze refuses any non-`running` source (idempotent, mirrors execute's guard).
- [ ] **Security:** INV-EXP6 + INV-OM1/OM2 enforced — variant provenance derivable per run; zero LLM/HTTP in execute/analyze/deploy; non-null `run_id` on every run/event.
- [ ] **Test (unit):** State guard refuses execute for every non-`approved` source state with no dispatch AND refuses analyze for every non-`running` source state (already-`analyzed` row → no-op, idempotent); execute/analyze/deploy flips accepted; in-flight dispatches never exceed `DISPATCH_CONCURRENCY`; deploy crash AFTER baseline write BEFORE flip leaves NEITHER the flip nor a partial deploy (atomicity).
- [ ] **Test (unit):** Winner aggregation returns `a`/`b` when a variant clears `MARGIN` with `n ≥ MIN_N` (incl. the at-margin boundary) and `none` otherwise, over variant-tagged fixture runs.
- [ ] **Test (unit):** Deploy writes `baseline_metrics_json` (asserts it CONTAINS the chosen metric's `baseline_value`, not just non-null) + `deploy_ref` before flipping; a simulated baseline-write failure leaves `status='analyzed'`; re-run on an `analyzed` row with an existing baseline does not re-snapshot.
- [ ] **Test (unit):** A `winner='none'` analyzed row refuses deploy (asserts `deploy_ref`/`baseline_metrics_json`/`deployed_at` all unwritten, `status` stays `analyzed`), closes the lifecycle run to `runs.status='completed'` with one `outcome` no-op event, and is flagged NOT P2.11-eligible.
- [ ] **Test (unit):** `VariantRunDispatcher` confirmed-shape fake tags each run + event with `variant` and `experiment_id` and records variant config provenance via `runs.variant`.
- [ ] **Test (e2e demo — MANDATORY):** Approved experiment → execute `N=3` (assert 3 variant-tagged runs per variant, `executed_at` non-null) → analyze (assert `winner` set, `running→analyzed`) → deploy (assert `deploy_ref`, `baseline_metrics_json` contains the metric value, `confirm_until - deployed_at == 2_592_000_000`, `analyzed→deployed`) with one `outcome` audit event per transition. Runs against the confirmed-shape seam now; same script targets the real swarmclaw tap once SPIKE-10 confirms it (interface-first; E2E gated on SPIKE-10).

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
