# P2.6: Capture Test/Review/Build Outcomes as Outcome Events

**Story Points:** 3

## Spec Reference

- QDS-MEM-003 §5.1 (Capture adapters), §2 (No-overlap with Hindsight); QDS-MEM-003-IMPL §D.2
- Invariant anchor: QDS-MEM-003-IMPL §E.1 (INV-OM1/2/3)

## User Story

As a QDS dev agent,
I want test, review, and build adapters to record their pass/fail verdicts as `outcome` events linked to the run,
so that any run's success state is queryable without re-running the tools and the optimizer can rate skills by real outcomes (G3 — diagnosable runs).

## Overview

This story wires the outcome-capture surface end-to-end: thin adapters around the test runner, the code-review step, and the build step each emit exactly one `events` row with `event_type='outcome'`, carrying `outcome ∈ {success,partial,failure,skipped}` (adapters NEVER emit NULL — see below), an optional `error` string, a NOT-NULL structured `payload_json` envelope, and a bounded `result_json`. Each event is threaded to its run via non-null `run_id` (§5.2), and the run's `runs.overall_outcome` column is rolled up from its constituent outcome events at run close. It is a 3-point glue unit because it adds no new store and no new transport — it reuses the P2.1 event store, the P2.3 shared 64KB-cap/secret-mask util (`src/capture/mask-and-cap.ts`), and the same transactional write path — touching only the adapter glue + rollup logic. Capture is purely mechanical: no LLM, no network egress (INV-OM1). Outcome `events` are NOT embedded into `event_vec` (R6 — queried by index, not similarity). Wiring closes with no stub and no `TODO: wire later`; outcome classification by an LLM is explicitly out of scope and lives in P2.7.

**Out of scope:** trend aggregation across runs; external CodeRabbit harvesting (owned by the Hindsight Review Harvester §2); LLM-based outcome classification (→P2.7).

**NULL outcome semantics:** adapters are FORBIDDEN from emitting `outcome=NULL` — every adapter MUST resolve a concrete verdict in `{success,partial,failure,skipped}` (a gated-off/un-run step emits `skipped`, keeping the run diagnosable). A NULL `outcome` is reserved SOLELY for the empty-rollup result on `runs.overall_outcome` (a run with zero constituent outcome events).

## E2E Slice

**Demonstrable behavior:** Run a fixture DAG run that executes a test step (one failing test), a review step (clean), and a build step (success); after the run completes, query `SELECT event_type, outcome, error, payload_json FROM events WHERE run_id = ? AND event_type='outcome'` and observe three rows (`failure`, `success`, `success`) with non-null `payload_json`, then `SELECT overall_outcome FROM runs WHERE run_id = ?` and observe the rolled-up `failure` verdict reflecting the failing test.

**Wiring closed:** On completion of this story, executing a run with test/review/build steps records outcome events and rolls up `runs.overall_outcome` using only code merged by this story and predecessor P2.1. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P2.1 (event store + recall API; owns `events`/`runs` DDL and the transactional write path); P2.3 (authors the shared `src/capture/mask-and-cap.ts` `maskAndCap` util + the `orphan:<session>` run helper, both reused here).

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given a completed run with a failing test step, a clean review step, and a successful build step, When the three outcome adapters fire, Then exactly three `events` rows exist with `event_type='outcome'`, each has non-null `run_id` equal to the run and a NOT-NULL `payload_json`, their `outcome` values are exactly `{failure, success, success}`, and `runs.overall_outcome` rolls up to `failure`.
2. Given the `@anthropic-ai/claude-agent-sdk` module is replaced by a spy/double whose `query()` throws if called AND a network mock is installed, When the test adapter writes its outcome event, Then the network mock records zero outbound HTTP/network requests and the SDK spy's `query()` is never invoked (detection is module-import/spy at the call boundary, not network-mock alone).
3. Given a build adapter whose `payload_json` or `result_json` exceeds 64 KB or contains secret-pattern matches, When the adapter writes the event, Then both fields are masked-then-capped to ≤64 KB by the shared `maskAndCap` (`src/capture/mask-and-cap.ts`) and any secret matches are masked before the row is committed.
4. **(binary)** Given a review step that is gated off / not run, When the run completes, Then exactly one review outcome event exists with `outcome='skipped'` (a row is ALWAYS emitted — never absent — so the run stays diagnosable), and the rollup treats `skipped` as non-failing.
5. Given an adapter invoked with no live DAG-run context, When it writes an outcome event, Then it resolves a non-null `run_id` via the capture-time run context or, failing that, the `orphan:<sessionId>` fallback run (synthesized `runs` row, R1) — the event is WRITTEN, never dropped, and no row with null `run_id` is ever committed (INV-OM2).
6. Given a mixed run with one `failure` outcome among several `success` outcomes, When the rollup computes `runs.overall_outcome`, Then it resolves to `failure` (any-failure-dominates precedence), a run with only `success`/`skipped` resolves to `success`, and a run with zero outcome events resolves to NULL (empty rollup).
7. Given a flaky test re-fires for the same `(run_id, source, step_id)` with a changed verdict (e.g. `failure` then `success` on retry of the SAME step), When the second outcome arrives, Then the write is a last-write-wins UPSERT on `(run_id, source, step_id)` (no duplicate row), AND given two distinct same-source steps (e.g. a unit step and an integration step both `source='test'`) they produce two separate rows (different `step_id`, no clobber), and the run-close rollup recomputes `runs.overall_outcome` from the surviving rows.

## Technical Notes

- **Contracts/Schema:** outcome event is an `events` row (P2.1 owns DDL §4); this story writes, does not redefine. Inline shape of the adapter-supplied fields:
  ```typescript
  // outcome adapter input → events row (event_type fixed to 'outcome')
  type OutcomeCapture = {
    run_id: string;                 // [INV-OM2] non-null; capture-time run ctx or orphan:<session> (R1)
    agent_id: string;               // threading §5.2
    skill?: string; skill_version?: string;
    outcome: 'success' | 'partial' | 'failure' | 'skipped';  // adapters NEVER emit NULL
    error?: string;                 // descriptive failure text (masked)
    payload_json: string;           // [INV-OM3] NOT NULL; {source,outcome,summary} envelope; ≤64KB, masked
    result_json: string;            // [INV-OM3] nullable detail blob; ≤64KB, masked when present
    source: 'test' | 'review' | 'build';
    step_id: string;                // DAG step identity; part of UPSERT key (same-source steps disambiguated)
  };
  // events.payload_json is NOT NULL (§C DDL) — every insert MUST populate it;
  // result_json is the nullable column. Both pass through maskAndCap before commit.
  // Row identity for idempotency: the DAG does NOT guarantee one step per source
  //   (e.g. a unit step AND an integration step can both be source='test'), so the
  //   UPSERT key is WIDENED to (run_id, source, step_id) — last-write-wins per step
  //   (R7 flaky retry of the SAME step), so two distinct same-source steps do NOT clobber.
  // runs.overall_outcome rollup precedence (recomputed at run close):
  //   any 'failure' → 'failure'; else any 'partial' → 'partial';
  //   else (≥1 'success', rest 'skipped') → 'success';
  //   else (zero outcome events) → NULL (empty rollup — the ONLY NULL outcome).
  ```
- **Integration points (each wired & exercised in this story):** P2.1 event store transactional write path (event row UPSERT on `(run_id, source, step_id)`); P2.1 `runs` table (`overall_outcome` UPDATE on the run-close trigger); P2.3-owned `maskAndCap` (`src/capture/mask-and-cap.ts`) reused, not re-authored; P2.3-owned `orphan:<session>` run helper reused for no-live-run capture (R1); test/review/build adapter call sites.
- **Files / functions touched:** `src/capture/outcome-adapter.ts` (the three adapters + shared writer; UPSERT on `(run_id, source, step_id)`), `src/capture/outcome-rollup.ts` (overall_outcome precedence, recomputed on run close), reuse `src/capture/mask-and-cap.ts` (P2.3-owned `maskAndCap`).
- **Guards/limits:** `payload_json` (NOT NULL) AND `result_json` each masked-then-capped ≤64 KB via `maskAndCap` (INV-OM3); `error` masked identically; resolve non-null `run_id` (capture-time ctx or `orphan:<session>` fallback) before write — never NULL, never dropped (INV-OM2/R1); one outcome row per `(run_id, source, step_id)` via last-write-wins UPSERT (flaky-retry collision of the same step, R7; widened from `(run_id, source)` because the DAG does not guarantee one step per source — same-source steps disambiguated by `step_id`); rollup runs once on run close as a single bounded UPDATE — no LLM, no network; outcome events NOT embedded into `event_vec` (R6).

## Files to Modify

> ≤10 unique paths, one per line.
- `src/capture/outcome-adapter.ts`
- `src/capture/outcome-rollup.ts`
- `src/capture/mask-and-cap.ts`
- `tests/capture/outcome-adapter.test.ts`
- `tests/capture/outcome-rollup.test.ts`

## Security Invariants

> Concrete named invariants only — N/A NOT permitted when triggered.

- **INV-OM1:** Zero per-event LLM/HTTP — outcome capture is mechanical; no network egress during capture (network mock asserts zero requests); no `@anthropic-ai/claude-agent-sdk` path is reachable from these adapters. LLM outcome classification is deferred to P2.7.
- **INV-OM2:** non-null `run_id` referencing a real `runs` row on every outcome `events` row — capture with no live DAG run synthesizes the `orphan:<session>` run (R1); events are never NULL and never silently dropped; the rollup only UPDATEs `runs` from events that reference it.
- **INV-OM3:** `payload_json` (NOT NULL) AND `result_json` (nullable) each ≤64 KB and secret-pattern-masked via `maskAndCap` (`src/capture/mask-and-cap.ts`) before the row is committed; `error` strings are masked identically (no secrets in failure text).

## Definition of Done

> 8–12 high-signal, story-specific boxes. NO lint/tests/typecheck filler.

- [ ] **Impl:** test, review, and build adapters each emit one `events` row with `event_type='outcome'` carrying `outcome`, `error`, NOT-NULL `payload_json` ({source,outcome,summary} envelope), `result_json`, and §5.2 threading fields.
- [ ] **Impl:** `runs.overall_outcome` is rolled up on the run-close trigger per any-failure-dominates precedence (failure > partial > success; skipped non-failing; zero events → NULL).
- [ ] **Contract:** adapters emit `outcome ∈ {success,partial,failure,skipped}` (NEVER NULL); NULL outcome reserved solely for the empty-rollup `runs.overall_outcome`; adapter inputs validated before write; no fields beyond the P2.1 `events` schema are introduced.
- [ ] **Integration:** adapters wired into the P2.1 transactional write path (UPSERT on `(run_id, source, step_id)` — widened so two same-source steps do not clobber) and exercised against a real fixture run end-to-end (test+review+build).
- [ ] **Security:** INV-OM1 (network mock asserts zero egress; SDK `query()` spy never invoked), INV-OM2 (non-null `run_id`; orphan-context capture uses `orphan:<session>` run, never dropped), INV-OM3 (64KB mask+cap on `payload_json`, `result_json`, and `error`) each enforced and individually tested.
- [ ] **Guard:** `run_id` resolved (capture ctx or `orphan:<session>` fallback) before insertion; flaky re-fire for `(run_id, source, step_id)` last-write-wins UPSERT (no duplicate) and triggers rollup recompute; two distinct same-source steps (different `step_id`) write separate rows.
- [ ] **Scope:** outcome events NOT written to `event_vec` (R6); trend aggregation, external CodeRabbit harvest, and LLM classification are out of scope (Hindsight §2 / P2.7).
- [ ] **Test (unit):** rollup precedence table — `{failure,success,success}→failure`, `{success,skipped}→success`, `{partial,success}→partial`, all-`skipped`→`success`, zero-events→NULL.
- [ ] **Test (e2e demo — MANDATORY):** execute a fixture run (failing test, clean review, successful build); assert exactly three outcome rows with `{failure,success,success}`, NOT-NULL `payload_json`, non-null `run_id`, and that `runs.overall_outcome` rolls up to `failure`.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
