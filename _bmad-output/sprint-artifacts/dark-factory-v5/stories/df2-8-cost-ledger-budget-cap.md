---
baseline_commit: 9c93c56c1fa833e89b813af91603eabaf9cf0f16
---

# DF2.8: Micro-Dollar Cost Ledger with Budget Cap and Pre-Spawn Dispatch Refusal

**Story Points:** 4
**Sprint:** v5-S2 (provider closure)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §5.2 (token/dollar cost split including cache economics), §5.3 (teardown → cost ledger updated), §6 item 4 (cost ledger with per-run attribution, host-side, survives box destruction)
- Decision register: v5 §4 **D8** (per-run spend-capped keys; central append-only cost ledger); §10 **F8**, **F9**
- Derivation decisions: `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md` **DD-9** (cost unit = integer micro-dollars), **DD-8** (NET-NEW authored fresh), §5 row 3 (F8 condition 2 / R6)
- Surviving clauses: R2 §6 (P1.13 crosswalk) — `p1-13-cost-ledger-budget.md:30, :31, :32, :33, :40, :55-58`; gate conditions `2026-08-11-pre-derivation-gates-report.md` §3.4 conditions 1–2
- Binding facts: R5 §6 facts **7**, **9**, **10**, **11**, **17**

## User Story

As the operator running a factory that spends real money on someone else's behalf,
I want every run's token and box spend recorded once in integer micro-dollars against the issue that
authorized it, with a cap that refuses a dispatch **before** a box or key exists,
so that the bill is derivable from an append-only record and containment costs a refusal, not a runaway.

## Overview

`ingestCostEvent` reads DF2.7's session-cumulative `cost` events off `parseTeamEventLine`, converts
the wire's float USD to integer micro-dollars exactly once at the boundary, and inserts one
append-only row per emitted event into a **host-side** SQLite ledger that survives box destruction
(§6 item 4). Each row carries the `key_hash` and cap of the DF2.3-minted key that could have produced
the spend, so the audit chain joins money to credential. `assertWithinBudget` sums an issue's priced
rows and gates the DF2.1 `create` seam: over cap the dispatch is refused and no VM and no key ever
exist. `qds cost <owner/repo>#<N>` derives the cumulative view — total, per-role split, cache
economics, unpriced count — from the same SUM the gate reads.

## E2E Slice

**Demonstrable behavior:** Given issue `qds/demo#42` with prior ledger rows totalling 4,900,000 µ$
against a cap of 5,000,000 µ$, When a dispatch calls `assertWithinBudget` and a second dispatch runs
after a lead+2-worker run adds 300,000 µ$, Then the first proceeds with `remainingMicroUsd: 100000`
logged and mints a key capped at that remainder, and the second is refused with
`{ status: 'over-budget', reason: 'spend-cap-exceeded' }` while the recording provider double
registers **zero** `create` and **zero** mint calls. `qds cost qds/demo#42` then prints the total,
the per-role split (lead / worker / resident), cache read/write tokens and the unpriced count.

**Wiring closed:** On completion of this story, spend is recorded and enforced end to end —
DF2.7 `cost` event → ledger row → issue SUM → pre-`create` refusal — using only code merged by this
story plus DF2.1's driver seam and DF2.3's credential lifecycle. No stub, no `TODO: wire later`, and
no sibling story is required. DF3.1's `fleet dispatch` verb calls this gate, it does not rebuild it.

**Dependency edges (predecessors):** DF2.7, DF2.3, DF2.5 — DF2.5 owns the teardown whose **close**
step this story hooks `ingestBoxHours` to (AC6), so the box-hour row has a caller. *(P1.2 issue-intake removed from hard deps: this
story keys spend by an issue reference an operator can supply, e.g. `qds/demo#42`; P1.2 automates
that intake and remains KEEP, repointed by DF5.5 — the same operator-supplied-issue-ref rationale
DF1.8 uses.)*

## Acceptance Criteria

1. **(make-or-break)** Given a completed dispatch whose DF2.7 events carry session-cumulative
   usage, When the ledger ingests them, Then exactly one row exists per emitted event — keyed by the
   deterministic `event_id` — with `cost_micro_usd` an **integer micro-dollar** value, and `run_id`,
   `repo_slug`, `issue_id`, `request_id`, `role`, `key_hash`, `key_limit_micro_usd`, `created_at` all
   populated — no nulls in a required column. Re-ingesting the identical event set adds **zero** rows
   and mutates none. *Negative controls: storing cents, storing a float, writing a second row on
   redelivery, or a key that collapses two invocations of one agent into a single row.*
2. Given ledger rows for an issue, When `qds cost <owner/repo>#<N>` runs, Then the cumulative view
   is derived as `SUM(cost_micro_usd) WHERE repo_slug = ? AND issue_id = ? AND unpriced = 0`,
   matches the sum of the individual rows exactly, and breaks down per role and per run with token,
   cache-read and cache-write totals plus the unpriced count. **No denormalized cost column is used
   or written.** A bare issue number with no repo slug is rejected, never defaulted.
3. Given cumulative priced spend for an issue is at or above the configured cap (default
   **5,000,000 µ$ = $5.00**, per-issue overrides keyed `owner/repo#N`), When a dispatch is
   evaluated, Then it is refused with `{ status: 'over-budget', reason: 'spend-cap-exceeded',
   capMicroUsd, spentMicroUsd, unpricedRows }` **before** the driver's `create` runs — no VM
   provisioned, no key minted. Under cap it proceeds, `remainingMicroUsd` is logged, and the cap
   handed to DF2.3's mint is `min(defaultKeyCapMicroUsd, remainingMicroUsd)`.
4. Given a malformed cost event — non-finite or negative `costUsd`, absent `usage`, or
   `unpricedTurns > 0` from DF2.7 — When it is ingested, Then the row persists with `unpriced = 1`
   and `cost_micro_usd = 0` and is **never dropped**; unpriced rows are excluded from the priced
   SUM and surfaced as an explicit count in the view and in every gate decision record, so no cap
   decision is taken on a silently incomplete total.
5. Given an issue with zero ledger rows, When the view runs, Then it reports `0` µ$, an empty
   per-role split and `hasEvents: false` with exit 0 — not an error — and the gate treats it as
   under cap. Given any `UPDATE` or `DELETE` against a persisted row, Then the store aborts the
   statement and the caller sees an error rather than a silent no-op.
6. Given a run torn down through DF2.5, When teardown reaches its **close** step, Then that step
   calls `ingestBoxHours(runId, ctx)` and exactly one `box_hours` row is written for the run, from
   the record's own VM lifetime × `boxHourRateMicroUsd`. The hook is on **close specifically**,
   because close is the step at which the record's lifetime is final and DF2.5 has confirmed the
   destroy: a teardown that aborts earlier (harvest failure, unconfirmed destroy — DF2.5 AC3/AC6)
   never reaches close and therefore writes **no** row, and `qds cost` reports that run's box hours
   as `box-hours-pending` rather than as zero. Re-running teardown to completion writes the row
   once — the deterministic `event_id` makes the second close a no-op (AC1). *Negative controls: a
   row written before the destroy is confirmed (billing a box that may still be alive); an aborted
   teardown whose absent row is summed as `0` instead of surfaced as pending.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| DF2.7 `cost` NDJSON events via `parseTeamEventLine` (`team-events.ts:89-106`) | in-scope | `tests/providers/cost-ledger.test.ts` | — |
| `ingestBoxHours` called from DF2.5 teardown's **close** step, from the run record's VM lifetime × `boxHourRateMicroUsd` | in-scope | `tests/providers/cost-ledger.test.ts` | — |
| Pre-spawn budget gate on the DF2.1 driver `create` seam | in-scope | `tests/providers/budget-gate.test.ts` | — |
| `qds cost <owner/repo>#<N>` CLI (`scripts/qds-cost.ts`) | in-scope | `tests/scripts/qds-cost.test.ts` | — |
| `fleet dispatch` CLI verb calling the exported gate | out-of-scope | — | DF3.1 |
| Quota headroom refusal (50-VM / 100GB pooled disk) and the reaper | out-of-scope | — | DF2.6 |
| Live cap-hit kill; resident per-run ceiling; HTTP cost view; audit-chain join to key events | out-of-scope | — | DF2.4, DF3.6, DF5.5 (DD-7), DF5.3 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| Host-side ledger `.sandbox/cost-ledger.db` — file mode `0600` in the `0700` `.sandbox/` directory DF2.1's store creates | `bun:sqlite`, bundled with the project's bun toolchain — no new dependency | opened and migrated at first ingest **and** at gate evaluation; lives host-side beside the run records so it survives box destruction (§6 item 4) |
| DF2.7 instrumented `cost` events | `cli-anything` workspace, `QDS_TEAM_RUNNER=local` | `npm run smoke:team` emits a `cost` line carrying `turnCount`/`unpricedTurns`; a run without DF2.7 records last-turn values only (R5 §6 fact 7) |
| DF2.1 run record + `create` seam | `src/providers/` run-record module (`.sandbox/runs/<id>.json`) | the gate is called and can refuse before `create`, proven by the recording driver's zero-call assertion |
| DF2.3 minted key hash and cap | OpenRouter key API (the working path today, R5 §6 fact 4) | mint returns a hash and cap that land on every token-kind ledger row |

## Technical Notes

- **Contracts/Schema (NET-NEW per DD-8, authored fresh):**
  `cost_events { event_id PK, run_id, repo_slug, issue_id, request_id, role, agent_id, provider,
  model, kind, invocation_seq, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  turn_count, cost_micro_usd, unpriced DEFAULT 0, key_hash, key_limit_micro_usd, created_at
  ISO8601 }` — every
  column except `provider`, `model`, the token counts, and — on `box_hours` rows only —
  `role`/`agent_id`/`key_hash`/`key_limit_micro_usd` is `NOT NULL`; on `kind='tokens'` rows
  `key_hash` and `key_limit_micro_usd` are NOT NULL (every token spend is attributable to a DF2.3
  key — INV-COST-5); `kind ∈ { 'tokens', 'box_hours' }`; `role ∈ { 'lead',
  'worker', 'resident', 'tier1' }`. A box-hour is a per-run cost with no agent, so the per-role split
  reports it as an explicit unattributed line rather than inventing a role to satisfy a constraint.
  `event_id` is a **deterministic digest** over the event's stable fields **plus a producer-assigned
  invocation sequence** — `run_id, agent_id, kind, invocation_seq, turn_count, cost_micro_usd,
  timestamp` — where `timestamp` is the **wire event's** emission time from DF2.7, stable across
  redelivery and distinct from the ingest `created_at`, and `invocation_seq` is a monotonic
  per-`(run_id, agent_id)` counter the dispatcher assigns at spawn time and carries through on
  `ctx` (Technical Notes below), surviving redelivery because it is fixed at spawn, not
  recomputed at ingest. Its PK is what makes ingest idempotent: a redelivered line digests
  identically and is `INSERT … ON CONFLICT DO NOTHING`, never an update. `invocation_seq` is what
  gives two genuine pi subprocess invocations of the same agent in the same run — otherwise capable
  of identical `(kind, turn_count, cost_micro_usd, timestamp)` — distinct emission identities, so
  `ON CONFLICT DO NOTHING` can never drop a second genuine event as a false duplicate. Keying
  instead on `(run_id, agent_id, kind)` would silently **drop** a second genuine invocation of the same agent
  in one run — DF2.7 emits one `cost` event per pi subprocess, not per run — and unrecorded spend is
  an unenforceable cap (INV-COST-6), so that key is a negative control, not the design. Per-issue
  spend is `SELECT SUM(cost_micro_usd) … WHERE repo_slug = ? AND issue_id = ? AND unpriced = 0`.
  Config: `{ defaultCapMicroUsd: 5_000_000, perIssueOverrides?, boxHourRateMicroUsd }`.
- **Where the NOT NULL columns come from — `ingestCostEvent(event, ctx)`.** DF2.7's `CostEvent`
  carries `agentId`, `model`, token counts and `costUsd` and nothing else: it has no `run_id`, no
  `repo_slug`, no `issue_id`, no `request_id` and no `role`, by that story's own scope note. Those
  five, plus `invocationSeq`, arrive in a second argument, `ctx = { runId, repoSlug, issueId,
  requestId, role, invocationSeq }`, supplied by the **dispatcher that spawned the agent** — the
  only caller that knows them. `role` is read from the roster entry the dispatcher used to spawn
  that `agentId`; it is **never inferred** from the model slug, the agent name, or emission order.
  `invocationSeq` is the dispatcher's own monotonic per-`(run_id, agent_id)` counter, incremented
  once per spawn and passed through unchanged into `event_id`'s digest inputs (Technical Notes
  above) — it exists solely to keep two genuine invocations from ever digesting identically. A
  `ctx` missing any field is a structured error naming it, with **zero rows written** — an
  unattributable cost is not persisted under a guessed key (INV-COST-6). Box-hour rows carry the
  same `ctx` minus `role`/`agentId` (AC1's nullable set); a box-hour row's `invocation_seq` is fixed
  at `0` since a box has no repeated invocations to disambiguate.
- **The SUM is only correct because DF2.7 fixed a reset boundary.** This ledger stores one row per
  emitted `cost` event and derives every figure by `SUM` across rows. That is sound **only** under
  DF2.7's stated boundary — the accumulator resets per pi subprocess invocation, so no event
  restates another's spend and a resumed `--session-id` yields two complete-but-disjoint events
  whose sum is the session total (df2-7 Technical Notes, AC6). If an upstream producer ever emitted
  running totals across invocations instead, this `SUM` would double-count and the gate would refuse
  runs on money nobody spent; that is a contract break in the producer, not something the ledger
  compensates for by de-duplicating or taking a maximum.
- **Box-hours are computed host-side, never ingested from `captureSpend`.** A `box_hours` row is
  `ceil(VM lifetime) × boxHourRateMicroUsd`, where the lifetime comes from the DF2.1 run record's
  own timestamps, written by `ingestBoxHours` called from DF2.5 teardown's **close** step (AC6) —
  the one point at which the destroy is confirmed and the lifetime is final. **`event_id` for a
  `box_hours` row digests `run_id, kind='box_hours', closed_at`** — `closed_at` being the DF2.1
  record's own close timestamp (fixed once the record closes, never the ingest-time clock) — in
  place of the token-row digest's `agent_id, invocation_seq, turn_count, cost_micro_usd,` and
  wire `timestamp`, none of which a box-hours row has; this is what makes a repeated close call
  digest identically and land on the same `event_id`, so `INSERT … ON CONFLICT DO NOTHING`
  no-ops the second write (AC1). DF2.3's `captureSpend` reads the **provider key's token usage** —
  the same money DF2.7's events already priced — so ingesting it as a second row would double-count
  token spend inside the priced SUM the gate reads. `captureSpend`'s number lands in the run
  record's `spendMicroUsd` (DF2.3's field) and reaches this ledger by no path at all.
- **Units are integer micro-dollars everywhere (DD-9).** The source story's `costCents` and its
  cent-denominated default are dead; **no numeric literal crosses the unit change**. The default cap
  is restated as **5,000,000 µ$ ($5.00)**. Micro-dollars are required, not preferred: an all-cheap
  roster run costs ~$0.015 and a per-role split is sub-cent (gates report §3.3). Float USD exists
  only on DF2.7's wire, converted **once** at ingest by `round(costUsd * 1_000_000)` half-up.
- **Rate provenance (F8 condition 2 / R6, binding):** priced rows carry the provider's own reported
  cost; any rate the factory applies itself — box-hours, a tier-1 share — is an **API rate**. **No
  Max-derived rate may appear in the ledger or any view derived from it**; client deployments bill
  an org-owned API key under Commercial Terms §A.1, the only grant that covers it.
- **Two layers of containment, both stated** (R2 §6 extension note): the **first** is DF2.3's
  provider-side cap on the minted key — a key that cannot overspend; the **second** is this gate. The
  provider cap is no substitute, because the ledger is what the audit chain reads. DF2.3's default key
  cap (50,000,000 µ$) must remain ≥ this story's issue cap — the middle term of the chain
  `residentSpendCeilingMicros < runBudgetCapMicros ≤ defaultKeyCapMicroUsd`. **This story does not
  implement that assertion:** DF3.6's manifest loader (`loadResidentBounds`, df3-6 AC2a / INV-BND-2)
  is its single owner, and DF2.3 and DF2.8 reference it rather than each running their own.
  **It is evaluated once at config load, over the configured defaults only.**
  The per-mint effective cap this story hands DF2.3 — `min(defaultKeyCapMicroUsd,
  remainingMicroUsd)` (AC3) — is **exempt**: it is deliberately below every configured ceiling
  whenever an issue is near its cap, and re-running the ordering check against it would refuse every
  remainder-capped mint. The same note carries in DF2.3's Technical Notes.
- **Boundary — the admitted value is also the run's spend ceiling (DF3.1).** On an under-cap
  decision `assertWithinBudget` returns that same clamped value, `min(remainingMicroUsd,
  defaultKeyCapMicroUsd)` — the one number handed to DF2.3's mint (AC3). DF3.1's dispatch propagates
  it into the run context as `effectiveCeilingMicros`, which is what DF1.6 reads to raise the
  harness cap at spawn. This story produces the number and hands it over once; it does not write the
  run context, and no consumer recomputes it from the ledger.
- **DF3.6 is the consumer of the minted cap, and it clamps rather than refuses.** DF3.6's per-run
  resident ceiling reads the **minted** `limitMicroUsd` off the run record, which is this clamped
  remainder and not `defaultKeyCapMicroUsd`. Its load-time ordering assertion therefore runs against
  the static configured defaults; its per-run check clamps the resident ceiling **down** to the
  minted cap and journals that it did so. A run admitted here is never refused there for being
  remainder-capped — that would refuse exactly the runs this gate just approved (XC-P1-01).
- **Refusal moved before spawn.** The surviving halt semantics (`p1-13-cost-ledger-budget.md:31`)
  are re-aimed: refusal happens before a box is provisioned and a key is minted, not between
  protocol steps. Under D8 a spawn costs a credential, so refusing later refuses after the expense.
- **Guards/limits:** the ledger file is `0600`, inside the repo data boundary; integer-only money and the single-statement read-and-compare gate are INV-COST-4 and INV-COST-3.
- **Deviation/assumption:** R5 §6 fact 7 — before DF2.7 a `cost` event reports the **final turn
  only**, so DF2.7 is a hard predecessor, not a degradation path. R5 §6 fact 11 — exe.dev pricing is
  vendor-single-origin [VERIFY], so the box-hour rate is configuration, never a compiled constant.

## Observability Contract

- Every ingest logs `{ requestId, runId, repoSlug, issueId, role, kind, costMicroUsd, unpriced, durationMs, outcome }`; every gate decision logs the same keys plus `{ capMicroUsd, spentMicroUsd, remainingMicroUsd, unpricedRows, decision }`.
- `requestId` is **supplied by the caller** on every `ingestCostEvent` and gate call, per DF2.1's convention (the dispatcher's id under DF3.1, the CLI's own minted id otherwise). The ledger never infers it: DF2.7's `cost` event carries no `requestId` by that story's own scope note, and DF2.1's twelve-field closed run record has no such field. An ingest invoked without one is a structured error, never a NULL row — which is what keeps AC1's `NOT NULL` honest without depending on DF1.8. Errors include `{ code, message, remediation }` where `remediation` is the literal next command. Sub-timings: `ingest_ms`, `sum_query_ms`; no per-turn breakdown exists upstream, so per-turn timing reports 0 and the caller's `durationMs` is authoritative.

## Files to Modify

- `src/providers/cost-ledger.ts`
- `src/providers/budget-gate.ts`
- `src/providers/teardown.ts` (DF2.5's, adds only: the `ingestBoxHours` call at the close step — no
  change to the six steps' order or their abort semantics)
- `src/providers/index.ts`
- `scripts/qds-cost.ts`
- `tests/providers/cost-ledger.test.ts`
- `tests/providers/budget-gate.test.ts`
- `tests/scripts/qds-cost.test.ts`

## Security Invariants

- **INV-COST-1 (append-only, enforced by the store):** rows are immutable — `BEFORE UPDATE` /
  `BEFORE DELETE` triggers `RAISE(ABORT)`, and the module contains no update or delete statement.
- **INV-COST-2 (derived, never denormalized):** per-issue spend is derived on demand by the SUM in
  Technical Notes; **no `issue.cost` column exists** (NFR-ACC-3). Gate and view cannot disagree — they read the same query.
- **INV-COST-3 (the gate precedes the spend, atomically):** the cap check is a single read-and-compare
  running **before** the driver `create` — no box and no credential for an issue at or over its cap.
- **INV-COST-4 (unit and rate integrity):** every stored money value is an integer micro-dollar
  (DD-9); float appears only on the DF2.7 wire, converted exactly once at ingest. No float is stored,
  compared or summed, cents appear nowhere, and a Max-derived rate reaching the ledger or any derived
  view is a defect, not a configuration choice.
- **INV-COST-5 (credential linkage, no clamping):** every token-kind row carries the `key_hash` and
  `key_limit_micro_usd` of the DF2.3 key that could have produced the spend — never the plaintext
  key, which is host-only (INV-CRED-2/3). Recorded spend exceeding the recorded cap is a visible
  discrepancy the view flags; the ledger never clamps or rewrites a row to balance the books.
- **INV-COST-6 (fail closed):** an unreadable, unopenable or un-queryable ledger **refuses the
  dispatch** — an absent ledger is never read as zero spend. An ingest that cannot persist surfaces
  a structured error rather than dropping the event; an unrecorded cost is an unenforceable cap.

## Definition of Done

- [x] **Impl:** `ingestCostEvent(event, ctx)` / `assertWithinBudget` / `readIssueCost` exported from
      `src/providers/`, with the deterministic `event_id` PK + `ON CONFLICT DO NOTHING` making
      redelivery a no-op without collapsing two invocations of one agent into one row.
- [x] **Impl:** `readRunCost(runId)` and `readIssueCost(repoSlug, issueId)` share **one** result
      schema — `{ totalMicroUsd, perRole, tokenTotals: { inputTokens, outputTokens }, cacheTotals: {
      cacheReadTokens, cacheWriteTokens }, unpricedRows, hasEvents }` — over `WHERE run_id = ? AND
      unpriced = 0` and `WHERE repo_slug = ? AND issue_id = ? AND unpriced = 0` respectively.
      `readRunCost` is the **run-keyed** view DF5.3's audit hop 3 and DF5.4's clause C10 read
      **without needing the issue ref**, so the chain closes on a runId alone; `issue_id` stays
      `NOT NULL` on every row (AC1) — these views change the query key, not the schema. `hasEvents:
      false` is what distinguishes a run or issue with no ledger rows from one that spent nothing.
      `qds cost` and any downstream audit consumer read the same field names from either function.
- [x] **Impl:** integer micro-dollars throughout; single half-up conversion at ingest; default cap
      **5,000,000 µ$** with per-issue overrides keyed `owner/repo#N`.
- [x] **Contract:** `qds cost <owner/repo>#<N>` prints total, per-role split, per-run breakdown,
      cache tokens and unpriced count, all derived from the SUM — a bare issue number is rejected.
- [x] **Integration:** the gate runs on the DF2.1 `create` seam and hands
      `min(defaultKeyCapMicroUsd, remainingMicroUsd)` to DF2.3's mint; box-hour rows written at
      teardown from the run record's VM lifetime × `boxHourRateMicroUsd`, never from
      `captureSpend`.
- [x] **Security:** append-only enforced by store triggers (INV-COST-1); `key_hash` on every token
      row and plaintext absent from every row and log line (INV-COST-5).
- [x] **Test (unit):** three DF2.7 events for one run → three rows split by role summing exactly to
      the issue total; replaying all three adds zero rows, while a second invocation of the same
      agent in the same run records a second row rather than colliding into the first.
- [x] **Test (attribution context):** an `ingestCostEvent` call whose `ctx` omits any of `runId` /
      `repoSlug` / `issueId` / `requestId` / `role` → structured error naming the field and **zero**
      rows written; a `role` supplied by the dispatcher from the roster is stored verbatim and no
      code path derives it from the model slug or agent name.
- [x] **Test (box-hours single row):** one torn-down run → exactly one `box_hours` row equal to
      lifetime × `boxHourRateMicroUsd`, `captureSpend`'s figure ingested nowhere, and the issue SUM
      equal to the token rows plus that one row exactly — a `captureSpend`-ingesting implementation
      double-counts token spend and MUST fail this test. A teardown aborted before its close step
      (injected harvest failure, DF2.5 AC3) writes **zero** `box_hours` rows and `qds cost` reports
      that run `box-hours-pending`, never `0` (AC6); re-running teardown to completion then writes
      exactly one row.
- [x] **Test (unit-change negative control):** a cent-denominated or float-valued store fails; a
      sub-cent per-role split (all-cheap roster) round-trips without loss of precision.
- [x] **Test (refusal before spawn):** over-cap issue → refusal payload and the recording driver
      registers zero `create` and zero mint calls; an implementation gating after `create` passes
      the refusal assertion and MUST fail the zero-call assertion.
- [x] **Test (malformed event):** non-finite / negative / absent-usage / `unpricedTurns > 0` → row
      persisted with `unpriced = 1`, excluded from the priced SUM, counted in the view and the gate
      decision record; zero events dropped.
- [x] **Test (e2e demo — MANDATORY):** drive a lead+2-worker run's cost events into a fresh ledger,
      then attempt a second dispatch over the cap — capture `qds cost qds/demo#42` output and the
      refusal record as artifacts, showing the per-role split in µ$ and a box never created.

## Dev Agent Record

### Implementation Plan (as executed)

TDD red→green per module, in dependency order. The load-bearing store
(`cost-ledger.ts`) was authored first against a failing 44-test suite, then the
budget gate + `createRun` seam, the teardown close hook, and the `qds cost` CLI.
Wave-parallel subagents executed the three dependent modules against frozen
contracts; the store and all cross-cutting integration were lead-authored.

### Debug Log

- `event_id` INSERT placeholder ordering: `kind` is column 8 — the literal must
  sit at position 8 in VALUES, not 11 (caught red, fixed green).
- bun `SUM` on an empty set returns `null`, not 0 — every aggregate uses
  `COALESCE(SUM(...), 0)` (integer µ$ math never sees null).
- bun `new Database(path)` creates the file 0644 — chmod 0600 immediately after
  first open; SQLite propagates the main file's mode to `-wal`/`-shm`.
- bun:test `expect(fn).toThrow()` returns void — payload assertions use try/catch.
- Teardown's already-closed early path skipped EVERYTHING, including the
  box-hours hook: a teardown whose `store.close` committed but whose process
  died before ingest would never write the row. The early path now still fires
  the hook (idempotent by `event_id`) — the crash window is closed.
- `createdAt`/`closedAt` are not settable through `RunRecordStore.set()` —
  fixtures close with an explicit `new Date(...)` and supply the matching
  backdated `createdAt` via the ledger's `readRunRecord` seam.

### Completion Notes

- **R2 §6 serialized-admission mandate implemented** (the story prose's "single
  read-and-compare" is stale against its own cited authority): the cap decision
  runs inside one `BEGIN IMMEDIATE` transaction over the priced SUM **plus the
  ceilings of outstanding `gate_admissions`** — append-only reservations that
  retire themselves when the run's first ledger row lands. Two concurrent
  dispatches can no longer both read sub-cap and overshoot; the concurrent test
  proves the second refusal where a bare read-compare admits both. Over-reservation
  is the fail-safe direction: an admitted run's full clamped ceiling counts
  against the cap until its real spend is observable.
- **`gate_admissions` table** joins the schema (append-only triggers like
  `cost_events`) — keyed `(request_id, run_id)` so a dispatch retry is a no-op.
- **`perRole` reports box-hours under the literal `"box-hours"` key** — the
  explicit unattributed line AC1's note requires; no invented role.
- **`boxHourRateMicroUsd` is config-required**: an unconfigured rate is a
  structured `CostConfigError` at ingestBoxHours (remediation names the config
  write), never a silent $0 box row.
- **`budget` extension namespace** (run-record.ts): `createRun` writes
  `{ repoSlug, issueId, capMicroUsd, spentMicroUsd, reservedMicroUsd,
  admittedCeilingMicroUsd }` — the dispatcher's mint reads `admittedCeilingMicroUsd`
  (`min(defaultKeyCapMicroUsd, remainingMicroUsd)`), teardown's box-hours hook
  reads the issue attribution. `CreateRunOptions.issue?: { repoSlug, issueId,
  requestId? }` gates the seam; all five existing `createRun` callers unchanged
  (absent issue ⇒ pre-DF2.8 behavior).
- **Rate provenance (F8/R6)**: no rate constant exists in the ledger; priced
  rows carry DF2.7's provider-reported cost verbatim (µ$), box-hours carry the
  configured API rate only.
- Reference lifts (IndyDevDan repos, per derivation lineage): WAL/synchronous/
  busy_timeout pragma block (inkwell tracer.py:108-113), strict-schema +
  reject-unknown-key discipline (run_record.py), fixed-width CLI renderer
  (runs_table.py), teardown ordering taxonomy (teardown.just). Genuinely new
  (no upstream exists): deterministic sha256 `event_id` idempotency, append-only
  RAISE(ABORT) triggers, integer micro-dollars, host-side pre-spawn gate,
  box-hours.
- Evidence: `_bmad-output/evidence/df2-8/e2e-cost-demo.json` (mode 0600) — the
  DoD's mandatory E2E artifacts (qds cost output + refusal record, box never
  created, zero mints on refusal).

### File List

- `src/providers/cost-ledger.ts` (NEW)
- `src/providers/budget-gate.ts` (NEW)
- `scripts/qds-cost.ts` (NEW)
- `tests/providers/cost-ledger.test.ts` (NEW)
- `tests/providers/budget-gate.test.ts` (NEW)
- `tests/scripts/qds-cost.test.ts` (NEW)
- `src/providers/driver.ts` (MODIFIED — CreateRunOptions.issue + budget gate before store.create)
- `src/providers/run-record.ts` (MODIFIED — `budget` EXTENSION_NAMESPACES entry)
- `src/providers/teardown.ts` (MODIFIED — CostLedgerHook + close-step hook + early-path crash-window fix)
- `scripts/sandbox-teardown.ts` (MODIFIED — costLedger wired by default)
- `src/providers/index.ts` (MODIFIED — cost-ledger + budget-gate exports)
- `tests/providers/teardown.test.ts` (MODIFIED — 7 new DF2.8 tests)
- `_bmad-output/evidence/df2-8/e2e-cost-demo.json` (NEW — evidence artifact)

### Change-Scope Verification (GitNexus)

Upstream impact before editing (this branch's two load-bearing seams):

- **`createRun`** (`src/providers/driver.ts`) — risk **LOW**: 1 direct caller
  (`runCapHitDemo`, `scripts/cap-hit-demo.ts`), 1 affected process. The DF2.8
  gate and the review-round `readRunRecord` ENOENT classification are
  additive inside the `opts.issue` branch; no signature change.
- **`teardownSandbox`** (`src/providers/teardown.ts`) — risk **CRITICAL**:
  5 direct callers (`runCapHitDemo`, `makeCleanup`, `finishEarly` in
  `scripts/cap-hit-demo.ts`; `run` in `scripts/sandbox-teardown.ts`; `sweep`
  in `src/providers/reaper.ts`), 6 affected processes, depth-3 reach into
  `scripts/sandbox-reap.ts` / `scripts/cap-hit-demo.ts`. Zero signature or
  step-order change — DF2.8 hooks the close step, and the review round only
  extracted the shared `ingestBoxHoursIfAttributed` helper and renamed the
  no-attribution log to its own `teardown.box_hours` operation.

`detect_changes` (scope `compare`, base `main`): 24 changed symbols across 20
files, risk critical — the branch-wide diff (includes the DF2.6 quota/reaper
merge), with the changed set matching the File List plus DF2.6's
`assertValidRunId`/`fillRun` touches. DF2.8's new files (`cost-ledger.ts`,
`budget-gate.ts`, `qds-cost.ts`) postdate the index and surface as unindexed
additions, not changed symbols.

### Change Log

- 2026-08-20 — DF2.8 implemented: micro-dollar cost ledger (append-only,
  deterministic event_id, idempotent replay), serialized-admission budget gate
  on the create seam, teardown close-step box-hours hook, `qds cost` CLI;
  44+10+9+32(new-context) tests green, 198 across all seven affected suites.
- 2026-08-20 (review round, PR #121) — CodeRabbit/Gemini remediation: admitted
  ceiling now subtracts outstanding reservations from cap headroom; finite
  costUsd with unpricedTurns>0 keeps its converted cost under the unpriced
  flag; orphaned gate admissions (store.create failed) expire via a
  read-side record-existence filter; `qds cost` refuses absent ledger files
  and wraps config errors with structured output; sandbox-teardown closes its
  ledger handle in `finally` and classifies record reads through `getRecord`;
  teardown's box-hours attribution deduplicated into one helper with the
  no-attribution omission logged as `teardown.box_hours`; evidence artifact
  scope-labeled and its writer moved off the repo working tree; focal suites
  green (cost-ledger 44, budget-gate 12, qds-cost 13, teardown 32,
  sandbox-teardown-cli 12).
- 2026-08-20 (BMAD code review round, PR #121) — three parallel adversarial
  layers (Blind Hunter, Edge Case Hunter, Acceptance Auditor; auditor PASS on
  all 6 ACs + 6 INVs). 21 raw findings → 9 patches applied, 8 dismissed as
  noise/false-premise/deliberate (see Review Findings). Fixes: constructor
  cleanup close never masks the original error; box-hours `hours × rate`
  safe-integer guard (`box-hours-cost-invalid`); µ$ conversion rejects
  unsafe integers; SQLITE_BUSY classified as retryable `ledger-busy`;
  `assertMicros` upper bound at `Number.MAX_SAFE_INTEGER`;
  `assertQueryable` probes the real btree; `DEFAULT_COST_CONFIG` frozen;
  teardown attribution rejects non-primitive values; driver gate `finally`
  close wrapped. Focal suites 104/104; tsc clean on touched files.
- 2026-08-20 (Sift review round, PR #121) — both WARNINGs verified then fixed.
  W1 (unwired `readRunRecord` silently zeroed reservations): confirmed latent —
  the production `admitIssue` caller wires the seam; the default now returns a
  keyless truthy record so an unwired ledger counts every outstanding
  reservation (fail-safe direction, INV-COST-6) while ingest paths still
  refuse on the stub (no keyHash/closedAt). W2 (unpriced spend never erodes
  headroom): confirmed — the retirement filter accepted ANY cost row, so an
  unpriced-only run retired its full-ceiling reservation and restored
  headroom on spend it never priced; retirement now requires a **priced** row
  (`ce.unpriced = 0` in the NOT EXISTS), keeping an unpriced-only run's
  ceiling counted until real spend is observable (box_hours rows are priced,
  so teardown still retires). Sift's refuse-on-unpricedRows suggestion was
  rejected — AC4 pins surfacing, not blocking. cost-ledger 52, budget-gate 10,
  qds-cost 11 green.
- 2026-08-20 (fresh 3-layer pass, PR #121) — Blind Hunter + Edge Case Hunter (src / scripts+tests, two scoped runs after context-overflow retries) + Acceptance Auditor (0 violations; all 6 ACs + 6 INVs PASS). 35 raw → 19 patched, 1 deferred (zombie-run reservation retirement policy), 5 dismissed/already-fixed (driver ENOENT + close guards were prior-round work; ctor-context noise; impossible negative-µ$; open-run reservation expiry verified bounded). Fixes: reservation-sum `ledger-overflow` guard; `committed > cap` → over-budget refusal instead of negative ceiling; positive-safe-integer validation at config load + admitIssue entry; `usdToMicros` finite/safe-product guards; per-field keyHash/limitMicroUsd error; `assertMicros` dead-clause simplification; pre-1970 `created > 0`; DEFAULT_COST_CONFIG omission comment; `qds cost` view-total validation (`cost-view-invalid`) + finally-close error precedence with stderr warning; multi-`#` issue-ref rejection; teardown attribution string-only; TeardownError `cause` preservation; run-record ceiling-formula doc. Tests: +MAX_SAFE conversion boundary, corrupt-ledger CLI (negative + unsafe totals), config-path-is-directory, multi-`#`, same-requestId-second-run (refused on real headroom; orphan filter requires `store.create`), deterministic eventId re-run, chmod 0600/0400 tolerance; committed evidence artifact reconciled + per-test schema-assert. 119/119 focal green (cost-ledger 54, budget-gate 11, teardown 32, qds-cost 18, +4 in-file), tsc clean; detect_changes: teardownSteps only (cause-wrap), same blast radius as prior rounds.

### Review Findings

- [x] [Review][Patch] Constructor cleanup `db.close()` can throw and mask the original error [src/providers/cost-ledger.ts:394]
- [x] [Review][Patch] Box-hours `hours × rate` can exceed `Number.MAX_SAFE_INTEGER` — silent wrong figure (BLOCKER) [src/providers/cost-ledger.ts:559]
- [x] [Review][Patch] `usdToMicros` accepts precision-loss values above $9B [src/providers/cost-ledger.ts:437]
- [x] [Review][Patch] SQLITE_BUSY in `admitIssue` propagates unclassified — transient vs fatal indistinguishable [src/providers/cost-ledger.ts:796]
- [x] [Review][Patch] `assertMicros` lacks upper bound — SQLite 64-bit INTEGER overflow [src/providers/cost-ledger.ts:179]
- [x] [Review][Patch] `assertQueryable` probe `SELECT 1` never touches the btree — corruption passes [src/providers/cost-ledger.ts:684]
- [x] [Review][Patch] `DEFAULT_COST_CONFIG` mutable at runtime despite `Readonly` type [src/providers/cost-ledger.ts:160]
- [x] [Review][Patch] `String()` coercion turns a hand-edited object into `"[object Object]"` attribution [src/providers/teardown.ts:229]
- [x] [Review][Patch] Driver gate `finally { ledger.close() }` can mask OverBudgetError [src/providers/driver.ts:176]

Dismissed (8): concurrent-ceiling race — `BEGIN IMMEDIATE` serializes writers
(blind hunter had no project context); corrupt-record read refusal — deliberate
INV-COST-6 fail-closed, documented; box-hours hook after `store.close` —
idempotent re-run heals via the already-closed early path, tested; JSON.parse
error narrowing; perRole NULL sum — STRICT NOT NULL column; transaction return
typing; sandbox-teardown best-effort ledger close — deliberate policy mirroring
lock release; ledger dir permissions — false premise (`mkdirSync` passes
`mode: 0o700` at creation).

### Review Findings — fresh 3-layer pass (2026-08-20)

Layers: Blind Hunter (blind), Edge Case Hunter ×2 (src / scripts+tests), Acceptance Auditor (0 violations — all 6 ACs + 6 INVs PASS). Raw 35 findings → triaged below.

- [x] [Review][Patch] Admission `reservedMicroUsd` sum can overflow MAX_SAFE_INTEGER (blind+edge) — fixed: in-loop `ledger-overflow` throw + test [src/providers/cost-ledger.ts]
- [x] [Review][Patch] `committed > cap` yields negative `remainingMicroUsd` → negative ceiling handed to mint (edge) — fixed: `remaining <= 0` → over-budget refusal + test [src/providers/cost-ledger.ts]
- [x] [Review][Patch] Config caps/rates not validated positive at `loadCostConfig`; `admitIssue` lacks `keyCapMicroUsd > 0` entry guard (edge) — fixed: every numeric key via `assertMicros`; admitIssue validates cap at entry [src/providers/cost-ledger.ts]
- [x] [Review][Patch] `usdToMicros` input-range guard: explicit upper bound + clearer error than generic unsafe-integer (blind) — fixed: finite + safe-product guards, `cost-convert-invalid` + tests [src/providers/cost-ledger.ts]
- [x] [Review][Patch] keyHash/keyLimit guard error message ambiguous when only one missing (edge) — fixed: names the missing field [src/providers/cost-ledger.ts]
- [x] [Review][Patch] `assertMicros` trailing `> Number.MAX_SAFE_INTEGER` clause dead after `isSafeInteger` (edge) — fixed: simplified to isSafeInteger + positive [src/providers/cost-ledger.ts]
- [x] [Review][Patch] `Date.parse` accepts pre-1970 timestamps — add `created > 0` (blind) — fixed [src/providers/cost-ledger.ts]
- [x] [Review][Patch] `DEFAULT_COST_CONFIG` intentional omission of `boxHourRateMicroUsd` undocumented (blind) — fixed: comment [src/providers/cost-ledger.ts]
- [x] [Review][Patch] `qds cost` view: formatCost lacks non-finite/negative/unsafe-total guard (edge) — fixed: `assertValidMicroTotal` on issue + role totals, `cost-view-invalid` + 2 corrupt-ledger tests [scripts/qds-cost.ts]
- [x] [Review][Patch] `qds cost` finally-block `close()` masks original query error; close-failed diagnostic to stdout not stderr (edge) — fixed: `primaryError` precedence, close-after-error → stderr warning; success-path close failure is its own `fail()` [scripts/qds-cost.ts]
- [x] [Review][Patch] `parseIssueRef` silently drops extra `#` segments (`owner/repo#1#2`) (edge) — fixed: reject ≠2 parts + numeric check + test [scripts/qds-cost.ts]
- [x] [Review][Patch] existsSync-then-open race — open directly and classify ENOENT vs unopenable (edge) — documented-keep: CostLedger creates missing files, so the pre-check IS the refuse-absent behavior; comment added [scripts/qds-cost.ts]
- [x] [Review][Patch] Driver `store.get` treats any error as no-prior-record — non-ENOENT must be fatal-with-context (edge) — already-fixed in prior round: ENOENT→undefined, others rethrow [src/providers/driver.ts:156-163]
- [x] [Review][Patch] Driver `store.set` failure post-admission orphans reservation — verify TTL bound, add cleanup if missing (edge) — deferred: zombie run with record-but-no-extension never retires; needs a retirement policy (cancelAdmission / on-close retire), not an unambiguous patch
- [x] [Review][Patch] Driver bare `ledger.close()` at :178 — verify it cannot mask OverBudgetError (edge) — already-fixed in prior round: inner try/catch with mask-prevention comment [src/providers/driver.ts:176-182]
- [x] [Review][Patch] Teardown attribution still coerces numeric repoSlug/issueId (`123` ≠ `"123"`) — tighten to string-only (blind+edge) — fixed [src/providers/teardown.ts]
- [x] [Review][Patch] TeardownError wrap drops CostLedgerError class/cause — preserve cause for retry classification (edge) — fixed: `cause` preserved through `asTeardownError` [src/providers/teardown.ts]
- [x] [Review][Patch] run-record budget doc block omits ceiling formula `min(keyCap, remaining)` (blind) — fixed [src/providers/run-record.ts]
- [x] [Review][Patch] sandbox-teardown: CostLedger ctor throw masks which-record context (edge) — dismissed: runId is the CLI argument the operator just typed; ctor errors are config-global and already carry structured code+remediation via `fail()` [scripts/sandbox-teardown.ts]
- [x] [Review][Patch] Tests: MAX_SAFE µ$ conversion boundary; same-requestId second dispatch; teardown re-run asserts deterministic eventId; config-path-is-directory; chmod 0600/0400 tolerance (edge) — all added; same-requestId test corrected to real semantics (second dispatch refused: 4.9M spent + 100k reserved ≥ 5M cap; reservation requires `store.create` or the orphan filter expires it) [tests/]
- [x] [Review][Patch] Committed `_bmad-output/evidence/df2-8/e2e-cost-demo.json` drifted from test-produced shape (spend.lead 100k vs 5M) — fixed: reconciled + per-test schema-assert of the committed copy (D8) [tests/providers/budget-gate.test.ts]

Deferred (1): internal retry/backoff for `ledger-busy` under >10 concurrent dispatch storms — busy already classified retryable; speculative load scaling (blind).

Dismissed (4): box-hour rate late-fail at teardown — spec-mandated surfacing, not silent default (blind); positive-USD→negative-µ$ — mathematically impossible in safe range (edge); open-run reservation persistence — verify-only, expiry path exists from prior round (edge, pending verifier verdict); INFO confirmations ×2 (append-only triggers, serialized admission).


**Status:** done — PR #121 merged 2026-08-21 (`31c4a0d`), after four review rounds (final pass: 19/19 actionable patches applied, 119/119 focal green). This line read "review — awaiting PR #121 merge" for five days after the merge; corrected in the 2026-08-26 artifact audit.
