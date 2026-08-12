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

- [ ] **Impl:** `ingestCostEvent(event, ctx)` / `assertWithinBudget` / `readIssueCost` exported from
      `src/providers/`, with the deterministic `event_id` PK + `ON CONFLICT DO NOTHING` making
      redelivery a no-op without collapsing two invocations of one agent into one row.
- [ ] **Impl:** `readRunCost(runId)` and `readIssueCost(repoSlug, issueId)` share **one** result
      schema — `{ totalMicroUsd, perRole, tokenTotals: { inputTokens, outputTokens }, cacheTotals: {
      cacheReadTokens, cacheWriteTokens }, unpricedRows, hasEvents }` — over `WHERE run_id = ? AND
      unpriced = 0` and `WHERE repo_slug = ? AND issue_id = ? AND unpriced = 0` respectively.
      `readRunCost` is the **run-keyed** view DF5.3's audit hop 3 and DF5.4's clause C10 read
      **without needing the issue ref**, so the chain closes on a runId alone; `issue_id` stays
      `NOT NULL` on every row (AC1) — these views change the query key, not the schema. `hasEvents:
      false` is what distinguishes a run or issue with no ledger rows from one that spent nothing.
      `qds cost` and any downstream audit consumer read the same field names from either function.
- [ ] **Impl:** integer micro-dollars throughout; single half-up conversion at ingest; default cap
      **5,000,000 µ$** with per-issue overrides keyed `owner/repo#N`.
- [ ] **Contract:** `qds cost <owner/repo>#<N>` prints total, per-role split, per-run breakdown,
      cache tokens and unpriced count, all derived from the SUM — a bare issue number is rejected.
- [ ] **Integration:** the gate runs on the DF2.1 `create` seam and hands
      `min(defaultKeyCapMicroUsd, remainingMicroUsd)` to DF2.3's mint; box-hour rows written at
      teardown from the run record's VM lifetime × `boxHourRateMicroUsd`, never from
      `captureSpend`.
- [ ] **Security:** append-only enforced by store triggers (INV-COST-1); `key_hash` on every token
      row and plaintext absent from every row and log line (INV-COST-5).
- [ ] **Test (unit):** three DF2.7 events for one run → three rows split by role summing exactly to
      the issue total; replaying all three adds zero rows, while a second invocation of the same
      agent in the same run records a second row rather than colliding into the first.
- [ ] **Test (attribution context):** an `ingestCostEvent` call whose `ctx` omits any of `runId` /
      `repoSlug` / `issueId` / `requestId` / `role` → structured error naming the field and **zero**
      rows written; a `role` supplied by the dispatcher from the roster is stored verbatim and no
      code path derives it from the model slug or agent name.
- [ ] **Test (box-hours single row):** one torn-down run → exactly one `box_hours` row equal to
      lifetime × `boxHourRateMicroUsd`, `captureSpend`'s figure ingested nowhere, and the issue SUM
      equal to the token rows plus that one row exactly — a `captureSpend`-ingesting implementation
      double-counts token spend and MUST fail this test. A teardown aborted before its close step
      (injected harvest failure, DF2.5 AC3) writes **zero** `box_hours` rows and `qds cost` reports
      that run `box-hours-pending`, never `0` (AC6); re-running teardown to completion then writes
      exactly one row.
- [ ] **Test (unit-change negative control):** a cent-denominated or float-valued store fails; a
      sub-cent per-role split (all-cheap roster) round-trips without loss of precision.
- [ ] **Test (refusal before spawn):** over-cap issue → refusal payload and the recording driver
      registers zero `create` and zero mint calls; an implementation gating after `create` passes
      the refusal assertion and MUST fail the zero-call assertion.
- [ ] **Test (malformed event):** non-finite / negative / absent-usage / `unpricedTurns > 0` → row
      persisted with `unpriced = 1`, excluded from the priced SUM, counted in the view and the gate
      decision record; zero events dropped.
- [ ] **Test (e2e demo — MANDATORY):** drive a lead+2-worker run's cost events into a fresh ledger,
      then attempt a second dispatch over the cap — capture `qds cost qds/demo#42` output and the
      refusal record as artifacts, showing the per-role split in µ$ and a box never created.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
