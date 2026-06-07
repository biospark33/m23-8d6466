# P1.13: Per-run `cost_events` emission with per-issue-tree spend queryable and budget-capped

**Story Points:** 4

## Spec Reference

- PRD §6.1 (Control-plane — Paperclip), §8.3 (cost hop — ledger, no `issue.cost` field); FR-CP-4, FR-CP-12
- Supporting: NFR-COST-1 (every run writes ≥1 `cost_events`; never silently over-cap), NFR-COST-2 (per-issue-tree cost queryable ≤2 s), NFR-ACC-3 (no `issue.cost` column; per-issue cost solely from `cost_events`), NFR-SEC-2 (Paperclip bearer + run-scoped header)
- Phase exit gate: PRD §13 Phase-1 item 12 ("every run writes a `cost_events` entry; per-issue-tree spend is queryable and within the agent/company budget cap — over-cap → gate/halt")

## User Story

As the **Operator**,
I want **every Pi-team run to write a per-role `cost_events` ledger row, with per-issue-TREE spend queryable on demand and enforced against the agent/company budget cap**,
so that **factory spend is native, summable, capped, and never silently overrun (goal G4 safe spend).**

## Overview

This slice cuts through the P1.6 Warren dispatch path (lead/worker run — the authoritative cost emitter) → Paperclip `cost_events` ledger (`POST /companies/:companyId/cost-events`, `costs.ts:73`) → roll-up into `agents.spentMonthlyCents` / `companies.spentMonthlyCents` → a pre-run budget gate. **Warren's built-in cost aggregator captures ONLY the lead pi's cost stream (empirically 17% of true spend in spike validation; worker cost = 83%, invisible to `usage-aggregate.ts:90-122` which sums only `turn_end/stream=system` from the run's own stream). Per-worker cost MUST be emitted directly from the P1.6 cost envelope (lead extracts `turn_end.message.usage.cost.total` from each worker's NDJSON stdout during the Warren run) — relying on warren's `costUsd` is a fatal 83% undercount for a cost-optimization product.**

After a Pi team finishes, this story emits **one `cost_events` row per Pi role/agent** (each carrying `agentId`, `model`, `heartbeatRunId`, token counts, and `costCents`) via `createCostEventSchema`. Per-issue-tree spend is then `SUM(cost_events.costCents) WHERE issueId IN <parentId subtree>` — there is **no `cost` column on `issues`** (NFR-ACC-3). Before a run dispatches, projected spend is checked against the agent/company cap; an over-cap projection **halts/gates** the run rather than overrunning. One atomic unit because emission without a queryable summable cap is not "wiring closed" — the spend must be native, summable, AND capped in the same slice.

## E2E Slice

**Demonstrable behavior:** A 3-role Pi team runs for a Paperclip issue; on completion the P1.6 Warren dispatch path POSTs three `cost_events` rows (one per role, each with `agentId`/`model`/`heartbeatRunId`/`costCents`) to `POST /companies/:companyId/cost-events`. `GET /issues/:id/cost-summary` then returns the per-issue-TREE sum (`SUM(costCents)` over the issue's `parentId` subtree) within ≤2 s, equal to the three rows' total. With the agent cap set below that projection, a second run is **halted at the pre-run budget gate** (non-zero exit / gate decision logged) and writes no further ledger rows.

**Wiring closed:** On completion of this story, a finished Pi-team run produces **one `cost_events` row per Pi role (via `createCostEventSchema`), a per-issue-tree `SUM(costCents)` queryable in ≤2 s, and a pre-run budget gate that halts an over-cap run** — using only code merged by this story (Warren run emit path + Paperclip ledger write + tree-sum read + budget gate). No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P1.6 (the Warren run dispatch writes the cost envelope — per-worker `turn_end.message.usage.cost.total` extracted from worker NDJSON, keyed by `warrenRunId` + `cname` — that this story POSTs to Paperclip). P1.2 (issue intake produces the `issueId` FK each row references). Both are dependency edges, not unfinished wiring inside this story.

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given a Pi team of 3 roles run for a Paperclip issue under an adequate budget, When the team completes and the P1.6 Warren run path (lead/worker dispatch) emits its per-role cost rows, Then **≥3 `cost_events` rows exist for that issue** (one per role, each with non-null `agentId`/`model`/`heartbeatRunId` and `costCents ≥ 0`), AND `GET /issues/:id/cost-summary` returns the per-issue-TREE `SUM(costCents)` equal to those rows' total in ≤2 s. (Binary: row count ≥ roles AND tree-sum equality AND latency ≤2 s.)
2. Given an agent whose `spentMonthlyCents` (monthly spend across all issue trees) already meets or exceeds `budgetMonthlyCents`, When a new run is dispatched for that tree, Then the pre-run budget gate **halts/gates the run** (non-zero exit + a logged gate decision), no Pi subprocess is spawned, and no new `cost_events` row is written (over-cap → gate/halt, never a silent overrun).
3. Given the OpenRouter `/generation` exact-cost shape is unavailable for a role (OQ-8 fallback), When the launcher emits that role's row, Then it computes `costCents` best-effort from `heartbeat_runs.usageJson` tokens × a local price table, sets the row's `billingCode` field (optional nullable string) to sentinel value `"estimated"` to mark estimated rows. `billingType` stays a valid enum value (e.g., `"unknown"`). No Paperclip migration needed — `billingCode` is already nullable.

## Technical Notes

- **Contracts/Schema:** Reuse `createCostEventSchema` (`packages/shared/src/validators/cost.ts`) verbatim — REQUIRED `agentId` (uuid), `provider`, `model`, `costCents` (`z.number().int().nonnegative()` — tokens alone insufficient), `occurredAt`; optional `issueId`/`heartbeatRunId`/token counts; `biller` auto-fills to `provider`. **No DDL change**, no new `cost` column on `issues` (NFR-ACC-3) — per-issue cost is derived only. Budget-cap read via existing `agents.spentMonthlyCents`/`budgetMonthlyCents` (`agents.ts:30-31`) + `companies` (`companies.ts:14-15`). **Sub-cent precision policy:** the cost source (`turn_end.message.usage.cost.total`) reports in float USD — e.g., $0.00015 for a lightweight Gemini Flash turn. Converting via `Math.round(usd * 100)` silently zeroes sub-cent costs, violating NFR-COST-1 (every run ledgered, no silent over-cap). **Ceiling rounding is mandatory:** `costCents = Math.ceil(Number((usd * 100).toFixed(10)))` — the `toFixed(10)` + `Number()` round-trip strips IEEE 754 float noise before `Math.ceil` is applied (e.g., `0.14 * 100` = `14.000000000000002` in JS; `Number((14.000000000000002).toFixed(10))` = `14`; `Math.ceil(14)` = `14`, not `15`). This guarantees exact-cent inputs are not inflated by floating-point artifacts, while sub-cent inputs ($0.00015) still ceiling to 1 cent. The ceiling policy is documented in the cost-emitter code and covered by unit tests asserting: (a) sub-cent inputs produce `costCents ≥ 1`, and (b) exact-cent inputs (e.g., $0.14) produce `costCents = 14`, not 15. Aggregate ceiling bias is bounded: for a run costing $1.00 true, ceiling adds at most N_cents additional cents (one per row), negligible against the true total. A unit test asserts: `sum(costCents) <= trueCostCents + N` where N = number of rows.
- **Integration points (each wired & exercised):** (1) launcher → `POST /companies/:companyId/cost-events` (`costs.ts:73`), one row per role, bearer-auth'd, agent may report **only its OWN `agentId`** (`costs.ts:77-80`); (2) per-issue-tree read via `GET /issues/:id/cost-summary` (`costs.ts:140`) = `SUM(costCents)` over the `parentId` subtree; (3) roll-up: per-issue ledger sum reconciled into `agents`/`companies` `spentMonthlyCents` (FR-CP-12); (4) pre-run budget gate reads the cap before spawning Pi subprocesses.
- **Cost source (spike-verified):** primary = worker's own NDJSON `turn_end.message.usage.cost.total` (pi 0.55.0 format — `usage-aggregate.ts:90-122` (spike-confirmed parse path for Warren's own cost — NOT used by P1.13, which reads from the P1.6 cost envelope instead); cost envelope written by P1.6 lead before run closes, keyed by `warrenRunId` + `cname`); fallback = `heartbeat_runs.usageJson` tokens × local price table, labelled `estimated`. **Local price table:** a JSON file at `config/model-prices.json` mapping model identifiers to per-token costs (e.g., `{ 'openrouter/google/gemini-2.5-flash': { inputPer1k: 0.0000001, outputPer1k: 0.0000004 } }`). Created manually from OpenRouter pricing page; update cadence = per model addition. Used only for OQ-8 fallback when exact cost is unavailable. **Cost envelope canonical path:** `$QDS_COST_ENVELOPE_DIR/<warrenRunId>.json` (env var `QDS_COST_ENVELOPE_DIR`, default `.qds/cost-envelopes/`) — written by P1.6 lead, read by this story. Each file is a JSON array of `{ cname, model, costTotal, issueId, warrenRunId, estimated? }` objects. This story reads from this path and POSTs each entry as a `cost_events` row to Paperclip. **Do NOT rely on warren's `GET /analytics/cost` or run-level `costUsd` — these capture lead spend only (~17% of true spend), making them fatally inaccurate for this product's cost thesis.** Pi has zero native Paperclip/cost integration; QDS is the sole emitter (r3 §D.2).
- **Files / functions touched:** `cost-emitter.ts` (build + POST rows, OpenRouter/usageJson cost compute, reads P1.6 cost envelope); `budget-gate.ts` (pre-run cap check); per-issue-tree sum helper.
- **Guards/limits:** budget gate is a hard pre-spawn check (FR-CP-2/12, NFR-COST-1); tree-sum query bounded ≤2 s (NFR-COST-2). QDS company id for live calls: `1287bc8d-2122-4484-bc0c-900662caf8a0` (r3 §D.2).
- **P1.13 owns the float→cents conversion boundary:** reads raw `costTotal` (float USD) from the P1.6 cost envelope, applies ceiling rounding via `Math.ceil(Number((usd * 100).toFixed(10)))` to produce integer `costCents`. P1.6 must NOT perform this conversion. Sub-cent inputs ceiling to 1 cent minimum.
- **Projected spend formula:** `projected = current_spentMonthlyCents + sum(estimated_role_cost_cents)` from the model router pricing table. The budget gate checks `spent + projected > cap` (allows runs that exactly hit the cap; blocks only runs that would exceed it; pre-emptive, not reactive). If the gate fires, the run is halted before any Pi subprocess spawns.
- **Budget-cap READ endpoint:** `GET /agents/:agentId` returns `budgetMonthlyCents` and `spentMonthlyCents` from the `agents` table. Roll-up is automatic via Paperclip's existing budget hooks on cost-event POST — QDS code does NOT call a separate roll-up endpoint. The pre-run gate reads the agent's current `spentMonthlyCents` before dispatching.
- **TOCTOU note:** the budget gate reads `spentMonthlyCents` before dispatch. Under concurrent runs, two gates could both read under-cap and both proceed. Mitigation: Paperclip's cost-event POST triggers an atomic `spentMonthlyCents` increment via SQL `UPDATE ... SET spentMonthlyCents = spentMonthlyCents + costCents`. Overrun is bounded to one run's projected cost, not unbounded. A hard spend ceiling (company-level alert on actual exceeding cap) is a Phase-2 concern.
- **AC-1 tree-sum clarification:** all per-role `cost_events` rows are POSTed with `issueId` = the Pi team's assigned issue. The cost-summary GET is called on the same issue ID. The `SUM(costCents)` includes the root issue's subtree (recursive CTE through `parentId` chain).
- **`occurredAt` derivation:** set to `new Date().toISOString()` at emit time (when the cost row is finalized for POST to Paperclip). The cost envelope from P1.6 does not carry a timestamp; P1.13 stamps the row at emission.

## Files to Modify

- `src/cost/cost-emitter.ts`
- `src/cost/budget-gate.ts`
- `src/cost/issue-tree-cost.ts`
- `src/cost/paperclip-cost-client.ts`
- `tests/cost/cost-ledger-budget.test.ts`
- `tests/cost/cost-emitter-fallback.test.ts`

## Security Invariants

> Triggered: cost/budget (cap enforcement, ledger spend) + tenant (per-company / per-agent attribution on a shared Paperclip instance) + auth (bearer on every Paperclip REST call).

- **INV-1 (cost/budget — no silent over-cap):** the pre-run budget gate is a hard check against `agents.spentMonthlyCents`/`budgetMonthlyCents` (and company cap); an over-cap projection HALTS the run with a non-zero exit + logged gate decision — the launcher never spawns Pi subprocesses that would exceed the cap (NFR-COST-1).
- **INV-2 (cost/budget — every run ledgered):** every completed run writes ≥1 `cost_events` row; a run that produced spend but failed to emit a row is itself a failure (the launcher exits non-zero), so spend is never invisible to the ledger (NFR-COST-1; 0 runs with spend but no row).
- **INV-3 (tenant — own-agent-only attribution):** each `cost_events` row is POSTed under the run's `companyId` and carries only the run's OWN `agentId`; the launcher cannot write a row attributing cost to another agent/company (enforced server-side `costs.ts:77-80`), preventing cross-tenant cost mixing on the shared instance.
- **INV-4 (auth + secrets):** every cost POST sends `Authorization: Bearer <PAPERCLIP_API_KEY>` + `x-paperclip-run-id: <PAPERCLIP_RUN_ID>` (NFR-SEC-2) from host-injected env (`hermes_local` adapter `registry.ts:468-469`); no API key or OpenRouter token is hardcoded or written into a `cost_events` row, log, or stdout.
- **INV-5 (no `issue.cost` field):** per-issue cost is derived **solely** from `SUM(cost_events.costCents)` over the issue subtree; this story adds no `cost` column to `issues` and reads none (NFR-ACC-3).

## Definition of Done

- [ ] **Impl:** The P1.6 Warren run path (lead/worker dispatch) emits one `cost_events` row per Pi role on run completion (authoritative emitter), each via `createCostEventSchema`. Per-worker costs are POSTed to the Paperclip `cost_events` endpoint (`POST /companies/:companyId/cost-events`, `costs.ts:73`) from the run. P1.13's `cost-emitter.ts` reads P1.6 cost envelope (`$QDS_COST_ENVELOPE_DIR/<warrenRunId>.json`) and POSTs each entry to Paperclip.
- [ ] **Impl:** pre-run budget gate halts a run whose projected spend exceeds the agent/company `budgetMonthlyCents` (non-zero exit + logged gate decision), spawning no Pi subprocess.
- [ ] **Impl:** OQ-8 fallback — when OpenRouter `/generation` cost is unavailable, `costCents` is computed from `heartbeat_runs.usageJson` × local price table and the row is flagged `estimated`.
- [ ] **Contract:** cost-event payloads validate against `createCostEventSchema` (required `agentId`/`provider`/`model`/`costCents`/`occurredAt`); NO `cost` column added to `issues` (NFR-ACC-3); no DDL change.
- [ ] **Integration:** rows POST to `POST /companies/:companyId/cost-events` (`costs.ts:73`) and per-issue-tree `SUM(costCents)` reads via `GET …/issues/:id/cost-summary` (`costs.ts:140`), exercised end-to-end.
- [ ] **Observability:** per-issue ledger sum rolls up into `agents`/`companies` `spentMonthlyCents` (FR-CP-12) and is reconcilable at both issue and cap level.
- [ ] **Security:** INV-1 (hard over-cap halt) + INV-3 (own-agent-only row) + INV-4 (bearer from env, no token leak) each enforced and tested.
- [ ] **Test (unit/integration):** covers per-role emit, the OQ-8 estimated fallback, and the over-cap halt path (no subprocess spawned, no row written).
- [ ] **Test (perf):** per-issue-tree `SUM(costCents)` query returns in ≤2 s (NFR-COST-2).
- [ ] **Test (e2e demo — MANDATORY):** fires AC-1: a 3-role Pi run writes ≥3 `cost_events` rows for the issue, `issues/:id/cost-summary` returns the tree-sum equal to their total in ≤2 s, AND a follow-on over-cap run is halted at the gate writing no further row — proving spend is native, summable, capped (wiring closed).

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
