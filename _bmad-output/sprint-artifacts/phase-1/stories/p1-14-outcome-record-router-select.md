# P1.14: Per-run outcome record from native sites + deterministic router selection logged

**Story Points:** 3

## Spec Reference

- PRD §6.9 (Self-optimization & learning — v4 foundation), §6.7 (Accountability & yield), §9.4.0 (native-first / token-frugal principles); FR-ACT-2, FR-LEARN-28, FR-LEARN-29
- Supporting: NFR-REL-4 (Layer-B writes idempotent, key on `runId`), NFR-OBS-6(a) (every served config reconstructable — rationale persisted alongside `heartbeat_run`), NFR-COST-3 (v4 learning tax is zero added inference), NFR-PERF-7 (router selection ≤200 ms p95)
- Phase exit gate: rides PRD §13 Phase-1 (FR-LEARN-28/29 are the Layer-B substrate wired in Phase 1 atop the cost ledger + router already built); per §6.8 this is the v4 self-optimization foundation.

## User Story

As the **Operator / Self-improvement lead**,
I want **a per-run outcome record keyed on `runId` assembled from native recording sites (cost_events + heartbeat_runs + pi-lens) plus the deterministic router selection rationale logged with no extra LLM call**,
so that **the Layer-B self-optimization substrate is captured per run at zero added inference cost (goal G3 measurable improvement, G4 token-frugal).**

## Overview

This slice cuts through the native ledger/trace stores → an idempotent outcome-record write → the persisted router rationale. On run completion, the system reads each FR-LEARN-28 field **from its native site** — `cost_events` for per-role/per-model `cost_cents`+`input/output/cached_tokens` (via `agentId`/`model`/`heartbeatRunId`), `activity_log`/`issues.status` for `first_pass_accept`, `heartbeat_runs` for `wall_clock_ms`/`retry_count`/`retry_class` — and writes ONE outcome record `{task_type, archetype, per_role_model_tier, cost_cents, input_tokens, output_tokens, cached_tokens, first_pass_accept, retry_count, retry_class, wall_clock_ms}` as an **idempotent upsert on `runId`** (NFR-REL-4). In the same write it persists the FR-LEARN-29 router selection rationale (signature inputs + chosen archetype/tier + the binding constraint) so the served config is reconstructable (NFR-OBS-6a). There is **NO extra inference call** — every value is read from data the run already produced (§9.4.0). One atomic unit because an outcome record is only "captured per run" if it is keyed-idempotent AND its config is reconstructable in the same write; either alone leaves the substrate incomplete.

## E2E Slice

**Demonstrable behavior:** After a `qds-piv-loop` run completes, calling `recordOutcome(runId)` reads `cost_events` (cost+tokens, aggregated by `heartbeatRunId`), `heartbeat_runs` (timing/retries), and `activity_log`/`issues.status` (accept) and upserts one outcome record keyed on `runId`, alongside the router selection rationale. Re-invoking `recordOutcome(runId)` for the same `runId` **upserts the identical row, never duplicating** (NFR-REL-4). A read of the record returns all eleven FR-LEARN-28 fields plus the router rationale; no `cost_events` row is written by this step (zero added inference — the learning tax is one event-driven retain, not an LLM call).

**Wiring closed:** On completion of this story, `recordOutcome(runId)` produces **one idempotent outcome record (eleven FR-LEARN-28 fields, all read from native sites) + the persisted FR-LEARN-29 router rationale, re-runnable with zero duplicates and zero added `cost_events`** — using only code merged by this story (native-site readers + idempotent upsert + rationale persistence). No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P1.5 (the `qds-model-router` produces the selection object whose rationale this story persists alongside the outcome record). P1.13 (the per-run `cost_events` rows that supply `cost_cents`+token fields keyed by `heartbeatRunId`). Both are dependency edges, not unfinished wiring inside this story.

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given a completed run with ≥1 `cost_events` row, a `heartbeat_runs` trace, and an `issues.status`/`activity_log` accept signal, When `recordOutcome(runId)` is invoked, Then exactly **one** outcome record keyed on `runId` exists carrying all eleven FR-LEARN-28 fields (`task_type, archetype, per_role_model_tier, cost_cents, input_tokens, output_tokens, cached_tokens, first_pass_accept, retry_count, retry_class, wall_clock_ms`) with each numeric field equal to its native-site source (`cost_cents` = `SUM(cost_events.costCents)` for that `heartbeatRunId`), AND **no new `cost_events` row was written by this step**. (Binary: single row + field-equality to native sources + zero added cost rows.)
2. Given an outcome record already written for a `runId`, When `recordOutcome(runId)` is invoked again (retry), Then the record is **upserted, not duplicated** — exactly one row for that `runId` remains and its contents are identical (idempotent on `runId`, NFR-REL-4).
3. Given the same run's router selection, When the outcome record is written, Then the FR-LEARN-29 rationale (signature inputs + chosen archetype/tier + the binding constraint, e.g. `boundBy:"blast_radius_floor"`) is persisted and reconstructable for that `runId` (NFR-OBS-6a) — and the selection itself was deterministic (re-running the router on the same signature yields the identical archetype/tier).

## Technical Notes

- **Contracts/Schema (Zod/TS):** `OutcomeRecord` = `{ runId: string, task_type: string, archetype: "A".."F", per_role_model_tier: Record<string,string>, cost_cents: number, input_tokens: number, output_tokens: number, cached_tokens: number, first_pass_accept: boolean, retry_count: number, retry_class: "transient"|"overflow"|"logic"|null, wall_clock_ms: number }`. Primary key / upsert key = `runId` (NFR-REL-4). Stored in an `outcome_records` table OR as an additive `heartbeat_runs.usageJson.outcomeRecord` key (no DDL if the latter — backward-compat: rows without the key unaffected). Router rationale persisted alongside (reuse P1.5's `usageJson.routerSelection`).
- **Native recording sites (FR-LEARN-28, no synthetic source):** `cost_events` → `cost_cents` (`SUM(costCents)`), `input/output/cached_tokens` (sum of token columns) and `per_role_model_tier` (from `agentId`/`model`), aggregated by `heartbeatRunId`; `heartbeat_runs` → `wall_clock_ms` (timing cols), `retry_count` (`processLossRetryCount`/`retryOfRunId` lineage), `retry_class` (from FR-MG-9 classification); `activity_log`/`issues.status` → `first_pass_accept`. **No extra LLM call** — values are read, not generated (§9.4.0 principle 2).
- **Integration points (each wired & exercised):** (1) read `cost_events` aggregated by `heartbeatRunId`; (2) read `heartbeat_runs` timing/retry lineage; (3) read `issues.status`/`activity_log` for accept; (4) read P1.5 router selection rationale; (5) idempotent upsert keyed on `runId`.
- **Determinism (FR-LEARN-29):** the router selection consumed here is the deterministic §7-default pick under the blast-radius floor + risk-tier constraint (P1.5); this story does not re-decide it, only records its rationale — and asserts re-running yields an identical choice (NFR-PERF-7 fail-safe to §7 default on error).
- **Files / functions touched:** `outcome-recorder.ts:recordOutcome`, `native-site-readers.ts` (cost_events/heartbeat_runs/activity_log readers), `outcome-record.schema.ts`.
- **Guards/limits:** zero added inference (NFR-COST-3 v4 structural compliance — auditable by confirming `recordOutcome` writes no `cost_events` row); upsert is idempotent on `runId` (NFR-REL-4).

## Files to Modify

- `src/learning/outcome-recorder.ts`
- `src/learning/native-site-readers.ts`
- `src/contracts/outcome-record.schema.ts`
- `src/learning/router-rationale-store.ts`
- `tests/learning/outcome-record.test.ts`
- `tests/learning/outcome-idempotency.test.ts`

## Security Invariants

> Triggered: cost/budget (the outcome record reads ledger cost/spend; the substrate must not add spend nor mis-attribute cost).

- **INV-1 (cost/budget — zero added inference):** `recordOutcome` performs NO LLM/tool call that incurs spend — it only reads native ledger/trace rows and upserts a record; a test asserts `recordOutcome` writes **0 new `cost_events` rows** (NFR-COST-3 v4: the learning tax is one event-driven retain, never an extra inference).
- **INV-2 (cost/budget — faithful cost attribution):** `cost_cents` in the outcome record equals `SUM(cost_events.costCents)` for the run's `heartbeatRunId` exactly — the record never fabricates or rounds cost away from the ledger source of truth (NFR-ACC-3: cost derived solely from `cost_events`).
- **INV-3 (idempotency — no duplicate-write inflation):** the upsert keys on `runId`; a retried run cannot create a second outcome record (NFR-REL-4), so a re-run never double-counts cost or inflates the Layer-B substrate.
- **INV-4 (secrets):** the persisted outcome record and router rationale contain no model/provider API key or bearer token — only field values read from native rows.

## Definition of Done

- [ ] **Impl:** `recordOutcome(runId)` reads all eleven FR-LEARN-28 fields from their native sites (`cost_events`/`heartbeat_runs`/`activity_log`/`issues.status`) and writes one outcome record.
- [ ] **Impl:** the write is an idempotent upsert keyed on `runId` (re-invocation updates in place, never duplicates).
- [ ] **Impl:** the FR-LEARN-29 router selection rationale (signature inputs + chosen archetype/tier + binding constraint) is persisted alongside, reconstructable by `runId` (NFR-OBS-6a).
- [ ] **Contract:** `OutcomeRecord` Zod schema added with field-level validation (enum on `archetype`/`retry_class`, non-negative numerics); stored additively (no breaking DDL; backward-compat noted).
- [ ] **Integration:** native-site readers aggregate `cost_events` by `heartbeatRunId` and join `heartbeat_runs`/`activity_log`/`issues.status`, exercised against real rows.
- [ ] **Observability:** the outcome record + router rationale together make the run's config and outcome reconstructable for FR-ACT-2 KPI computation (cost/story, retry count, first-pass-accept) per story.
- [ ] **Security:** INV-1 (zero added `cost_events`) + INV-2 (cost equals ledger SUM) + INV-3 (idempotent on `runId`) each enforced and tested.
- [ ] **Test (unit/integration):** covers native-site field extraction (incl. `cost_cents = SUM(cost_events)`), the accept signal, and `retry_class` mapping.
- [ ] **Test (idempotency):** invoking `recordOutcome(runId)` twice yields exactly one identical row (NFR-REL-4); re-running the router on the same signature yields the identical selection (FR-LEARN-29 determinism).
- [ ] **Test (e2e demo — MANDATORY):** fires AC-1: after a completed run, `recordOutcome(runId)` writes one outcome record with all eleven fields equal to their native sources and the router rationale, writing **zero** new `cost_events` rows — proving the substrate is captured per run at zero added inference (wiring closed).

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
