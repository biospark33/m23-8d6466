# P2.12: Run Replay API + Retention/Decay Policy + Basic Observability

**Story Points:** 3

## Spec Reference

- QDS-MEM-003 §6 (Recall/replay), §12.1 (replay latency), §13 (viewer out of scope); QDS-MEM-003-IMPL §B.3 (DEFER worker HTTP/SSE + viewer)
- Operates over §C schema (events `parent_event_id` tree, `created_at` ordering); §H R4 (`(run_id,created_at)` index), R6 (event_vec scope), R15 (replay+retention resolutions)

## User Story

As a QDS optimizer agent and human debugger,
I want to replay any run's full ordered event timeline and parent-child event tree under 200ms and have the ephemeral store bound its own growth via a documented retention floor,
so that any DAG run is diagnosable at tool-call granularity without the store growing unbounded (G3 — observable, bounded operational memory).

## Overview

This story adds three capabilities over the P2.1 event store: (1) a **read-only replay API** that reconstructs any `run_id` into its ordered event timeline plus its `parent_event_id` tree, targeting <200ms (§12.1); (2) a **retention/decay cleanup policy** — the operational tier is ephemeral-leaning, so old events are hard-DELETEd on a tunable, documented schedule above a configured **retention floor** (grace window) that bounds growth; and (3) **basic metrics/observability** (store size, event counts, replay latency, last-decay run). Deletion is a hard DELETE, not a reversible operation; the retention floor is a grace window guaranteeing recent runs stay replayable, not an undo path. Because `event_vec` (vec0) and `event_edges` are not FK-CASCADE-enforceable (§H R2), `runRetention()` deletes the `events` rows plus their matching `event_vec` and `event_edges` rows in ONE transaction so no orphan vectors/edges survive. Note (§H R6): only `tool_call` and `message` events carry an `event_vec` row — `node`/`outcome` events do not — so the vector-delete touches only that subset. The graphical viewer UI is explicitly out of scope (§13); per IMPL §B.3 / §D.3 the deferred worker HTTP/SSE layer and viewer plug in *behind* this replay API later — this story ships the materialized data-serving seam those future surfaces adapt and paginate, without the transport or UI. Wiring closes with no stub and no `TODO`.

## E2E Slice

**Demonstrable behavior:** Given a stored run with a multi-level event tree, calling `replayRun(run_id)` returns the complete event timeline ordered by `created_at` plus a nested tree assembled from `parent_event_id`, with measured latency under 200ms (≥1000 events, warm cache, backed by P2.1's `(run_id, created_at)` index). Calling `runRetention()` with a decay cutoff hard-DELETEs `events` older than the cutoff that fall above the retention floor — together with their matching `event_vec` and `event_edges` rows in one transaction — skips any event whose run is still `status='running'`, decrements the observability counters, persists `lastDecayAt` to a dedicated metrics row, and is asserted to leave events inside the floor (and zero orphan vectors/edges) intact.

**Wiring closed:** On completion, any `run_id` in the store is replayable at tool-call granularity and the store enforces its retention bound, using only code merged by this story and predecessor P2.1. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. P2.1 (event store + recall primitives) is a dependency edge, not unfinished wiring inside this story; `replayRun` returns a materialized `ReplayResult` that the deferred worker HTTP/SSE + viewer (§13) adapt and paginate behind this API in a later phase and are intentionally out of scope.

**Dependency edges (predecessors):** P2.1.

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given a stored run with ≥3 levels of `parent_event_id` nesting and ≥1000 events, When `replayRun(run_id)` is called warm-cache, Then it returns the full timeline ordered ascending by `created_at` AND a nested tree where every non-root event appears under its `parent_event_id`, with measured wall-clock latency < 200ms (relies on P2.1's `(run_id, created_at)` index per §H R4).
2. Given a non-existent `run_id` OR an existing `run_id` whose run has zero events, When `replayRun(run_id)` is called, Then both cases return an empty timeline and an empty tree (no throw, no null) — the not-found and existing-but-eventless paths are the same defined empty result.
3. Given events spanning ages from 1 day to 1 year and a configured decay cutoff plus retention floor, When `runRetention()` executes, Then events older than the cutoff and above the floor are hard-DELETEd along with their matching `event_vec` and `event_edges` rows in one transaction, events inside the floor are retained, zero orphan vectors/edges remain (asserted by count), and the deleted count is returned.
4. Given an old event whose `run_id` has `runs.status='running'`, When `runRetention()` executes, Then that in-flight run's events are NOT deleted regardless of age (no in-flight deletion).
5. Given a `runRetention()` invocation in `dryRun` mode, OR a non-dry run whose would-delete set exceeds N% of total rows (the anomaly tripwire) **only when total row count ≥ `MIN_TOTAL_ROWS_ANOMALY`** (configurable, default 1,000 — below this floor the store is too small for the percentage to be meaningful and the anomaly check is skipped/treated as non-anomalous), When it executes, Then it returns the would-delete count and deletes nothing (`dryRun` count mode always refuses-entirely; the over-N%-anomaly SAFETY check refuses-entirely only above the floor) — and the anomalous non-dry run proceeds only when `force` is set. Below the floor a non-dry run is non-anomalous by definition and proceeds under the max-rows forward-progress cap (AC6) without falsely refusing. (This refuse-entirely behavior is the operator tripwire; it is distinct from the normal max-rows forward-progress cap in AC6.)
6. Given a non-dry, non-anomalous `runRetention()` whose would-delete set is larger than the configured max-rows cap (but within the N% anomaly tripwire), When it executes, Then it deletes exactly `max-rows` oldest-eligible events (plus their matching `event_vec`/`event_edges`) and returns — forward progress each run, so growth is bounded and repeated runs converge (it does NOT refuse-entirely; only the `dryRun`/over-N%-anomaly path in AC5 refuses).
7. Given an `experiment:<id>` lifecycle run that P2.11 closed to `runs.status='completed'`, When `runRetention()` executes on its aged events, Then those events are decay-eligible exactly like any other completed run's events (the running-run exclusion in AC4 applies only to `status='running'`) — a closed lifecycle run is not permanently exempt.
8. Given any replay or observability call, When it executes, Then no `events` / `event_edges` / `event_vec` row is mutated or inserted (replay is strictly read-only — asserted by row-count + checksum over the event tables before/after; the metrics row is not an event table).
9. Given the observability endpoint is queried, When called, Then it returns store size, total event count, per-run reconstruction latency sample, and last-decay timestamp (read from the dedicated metrics row) without writing any event table.
10. Given a parent event decayed by `runRetention()` while its child remains inside the floor (a real dangling parent produced by retention, NOT a synthetic injected row), When `replayRun(run_id)` is called, Then the orphaned child appears as a root in the reconstructed tree — the retention→replay compose exercises the dangling-parent path against actual retention output (run `runRetention()` first, then `replayRun` over the same run).

## Technical Notes

- **Contracts/Schema:** No new event tables; operates over §C `events` (`run_id`, `parent_event_id`, `created_at`), `event_vec`, `event_edges`, and `runs.status`. Observability `lastReplayMs`/`lastDecayAt` persist to a dedicated metrics row (e.g. `schema_meta`-style kv or a single-row metrics table), NEVER to event tables. Replay result shape:
  ```typescript
  type ReplayResult = {              // materialized; deferred SSE layer adapts/paginates
    runId: string;
    timeline: EventRow[];                 // ordered ASC by created_at
    tree: EventNode[];                    // roots; each EventNode { event, children }
  };
  type RetentionResult = { deleted: number; cutoffMs: number; floorMs: number;
                           vecDeleted: number; edgesDeleted: number; dryRun: boolean };
  type StoreObservability = {
    storeBytes: number; eventCount: number;
    lastReplayMs: number | null; lastDecayAt: number | null;
  };
  ```
- **Integration points (each wired & exercised in this story):** `replayRun(run_id)` reads via P2.1 recall primitives (by-run timeline + tree) — does not re-implement the store; `runRetention()` deletes `events` + `event_vec` + `event_edges` through the store's transactional handle in one transaction; observability reads SQLite `page_count`/`page_size` pragmas + `COUNT(*)` and the metrics row. This is the data seam the deferred worker HTTP/SSE layer (§B.3) and viewer (§13) consume later — no transport/UI shipped here.
- **Files / functions touched:** `replay.ts` (`replayRun`, tree assembly from `parent_event_id`), `retention.ts` (`runRetention`, decay cutoff + retention floor + dryRun/max-rows cap + running-run exclusion + multi-table delete), `observability.ts` (`getStoreObservability`, metrics-row read/write), wired into the store module's public surface.
- **Guards/limits:** replay target <200ms at N≥1000 warm-cache (assert in test; depends on R4 `(run_id,created_at)` index); replay strictly read-only (no INSERT/UPDATE/DELETE on event tables); retention deletes `events`+`event_vec`+`event_edges` inside one transaction; retention floor is a configured grace window below which nothing decays; decay cutoff and floor are tunable config, documented; two distinct bounds — (a) the **max-rows forward-progress cap**: a normal non-dry, non-anomalous run deletes UP TO `max-rows` oldest-eligible events and returns (bounded forward progress each run, repeated runs converge — it does NOT refuse), and (b) the **over-N%-anomaly tripwire** (conditional on `total_rows ≥ MIN_TOTAL_ROWS_ANOMALY`, configurable, default 1,000 — below this floor the tripwire does not fire, since a small/fresh store's percentage is not statistically meaningful; `dryRun` always refuses-entirely regardless of floor) + `dryRun`: both refuse-entirely (delete nothing) — the anomaly path proceeds only with `force` and only above the floor; excludes events whose run is `status='running'` (a completed `experiment:<id>` lifecycle run closed by P2.11 is NOT excluded — it decays like any other completed run); tree assembly is cycle-safe and dangling-parent-safe.
- **Cycle/orphan threat model:** `parent_event_id` cycles or dangling (decayed) parents should not occur from correct capture writers; they are guarded against (a) DB corruption and (b) future/buggy writers. A dangling parent (parent row decayed away) attaches its child as a root; a detected cycle breaks at the repeat-visit and emits the node as a root rather than looping.

## Files to Modify

> ≤10 unique paths, one per line.

- `src/operational-memory/replay.ts`
- `src/operational-memory/retention.ts`
- `src/operational-memory/observability.ts`
- `src/operational-memory/index.ts`
- `tests/operational-memory/replay.test.ts`
- `tests/operational-memory/retention.test.ts`
- `tests/operational-memory/observability.test.ts`

## Security Invariants

> Concrete named invariants only — N/A NOT permitted when triggered.

- **INV-OM2 (run_id spine, read side):** `replayRun` keys strictly on non-null `run_id`; reconstruction relies on every event carrying `run_id` (the capture-side guarantee) and never fabricates a run for a null/absent spine — non-existent and eventless runs both return the empty result.
- **INV-RPL1 (replay read-only):** the replay and observability paths issue zero mutations against `events`/`event_edges`/`event_vec`; historical events are immutable from this surface (enforced by read-only prepared statements and asserted by before/after row-count + checksum scoped to the event tables only — the metrics row write is out of that checksum scope).
- **INV-RPL2 (retention bounds growth above a floor):** retention hard-DELETEs only events older than the configured cutoff AND above the configured retention floor AND not belonging to a `status='running'` run; the floor is a documented grace window guaranteeing recent runs remain replayable (it is NOT a reversal/undo path — deletion is permanent); each event's matching `event_vec` and `event_edges` rows are deleted in the same single transaction so no orphan vectors/edges remain; the max-rows cap is forward-progress (a normal run deletes up to `max-rows` oldest-eligible and returns — bounded, convergent — never refuse-entirely), while only `dryRun` and the over-N%-anomaly tripwire refuse-entirely — the latter conditional on `total_rows ≥ MIN_TOTAL_ROWS_ANOMALY` (configurable, default 1,000; below the floor the tripwire does not fire, so a small/fresh store's retention is not falsely blocked) and proceeds only with `force`; a completed lifecycle run (`experiment:<id>`, closed by P2.11) is decay-eligible exactly like any other non-running run; the transaction means a failure leaves the store consistent.

## Definition of Done

> 8–12 high-signal, story-specific boxes. NO project-wide CI filler.

- [ ] **Impl:** `replayRun(run_id)` reconstructs ordered timeline (ASC `created_at`) + nested `parent_event_id` tree over P2.1 recall primitives (no store re-implementation); returns a materialized `ReplayResult` the deferred SSE layer adapts/paginates.
- [ ] **Impl:** cycle-safe / dangling-parent-safe tree assembly — a cycle or a decayed (missing) parent yields a defined result (child attaches as root), never an infinite loop; threat model (DB corruption / future writers) documented.
- [ ] **Impl:** `runRetention()` hard-DELETEs `events` + matching `event_vec` + `event_edges` in ONE transaction; excludes events whose run is `status='running'`; honors retention floor + tunable cutoff; returns deleted/vecDeleted/edgesDeleted counts.
- [ ] **Impl:** retention safety — `dryRun` count mode refuses-entirely; the max-rows cap is forward-progress (deletes UP TO `max-rows` oldest-eligible and returns, repeated runs converge); the over-N%-anomaly tripwire refuses-entirely only when `total_rows ≥ MIN_TOTAL_ROWS_ANOMALY` (configurable, default 1,000; below the floor the check is skipped — a small/fresh store proceeds under the max-rows cap without false refusal) and proceeds only with `force`; completed `experiment:<id>` lifecycle runs (closed by P2.11) decay like any non-running run.
- [ ] **Impl:** `getStoreObservability()` returns store bytes, event count, last replay latency, last-decay timestamp — all via reads; `lastReplayMs`/`lastDecayAt` persisted to a dedicated metrics row (NOT event tables).
- [ ] **Contract:** `ReplayResult` / `RetentionResult` / `StoreObservability` shapes authored and validated on output.
- [ ] **Integration:** replay + retention + observability exposed on the store module public surface as the seam the deferred worker HTTP/SSE (§B.3) and viewer (§13) will consume — transport/UI explicitly NOT shipped.
- [ ] **Security:** INV-RPL1 enforced — replay/observability perform zero mutations against event tables (before/after row-count + checksum scoped to event tables asserted in test).
- [ ] **Security:** INV-RPL2 enforced — retention hard-DELETEs only above the floor and outside running runs; deletes events+vec+edges in one transaction with zero orphans; floor documented as a grace window (not reversible); over-N%-anomaly refused without force AND only when `total_rows ≥ MIN_TOTAL_ROWS_ANOMALY` (default 1,000; below the floor the tripwire does not fire so small/fresh stores are not falsely blocked).
- [ ] **Security:** INV-OM2 enforced — replay keys on non-null `run_id`; non-existent and eventless runs both return the empty result, never fabricated.
- [ ] **Test (unit):** replay tree correctness on ≥3-level nesting; non-existent and eventless run both return empty timeline/tree; retention retains floor events, deletes pre-cutoff events + their vec/edges (zero orphans asserted), skips `status='running'` runs, decays a completed `experiment:<id>` lifecycle run's aged events; max-rows forward-progress (deletes exactly `max-rows`, returns, repeated runs converge) distinct from dryRun/over-N%-anomaly refuse-entirely; anomaly-gate floor — a small store (`total_rows < MIN_TOTAL_ROWS_ANOMALY`) with a would-delete set exceeding N% does NOT refuse-entirely (the tripwire is gated off; it proceeds under the max-rows cap), contrasted with a large store (`total_rows ≥ MIN_TOTAL_ROWS_ANOMALY`) where the same N% DOES refuse-entirely unless `force`; retention→replay compose (run `runRetention` to decay a parent inside-floor child remains → `replayRun` shows orphaned child as root, real retention output not synthetic); cycle/dangling-parent safety asserted.
- [ ] **Test (e2e demo — MANDATORY):** seed a run with a deep event tree (N≥1000), call `replayRun` and assert full ordered timeline + correct tree under 200ms warm-cache; seed aged events (some under a `running` run), call `runRetention`, assert pre-cutoff events + matching vec/edges deleted with zero orphans, floor events and running-run events retained, `lastDecayAt` written to the metrics row; verify event-table checksum unchanged across a replay+observability call (read-only proof).

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
