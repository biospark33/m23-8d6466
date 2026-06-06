# P1.16: Audit chain reconstructable for one real PR — every §8.1 hop walks, no missing hop

**Story Points:** 4

## Spec Reference

- PRD §8 (Accountability Model) — §8.1 chain, §8.4 query contract, §8.5 Phase-1 acceptance; FR-ACT-1, NFR-ACC-2
- Supporting: NFR-ACC-3 (per-issue cost solely from `cost_events`, no `issue.cost`), NFR-COST-2 (per-issue-tree cost queryable ≤2s), NFR-OBS-4(a) (full walk ≤30s), NFR-ACC-1 (0 orphan actors, `reportsTo`→root)
- Phase exit gate: PRD §13 Phase-1 clauses 5 ("for that PR, the full §8.1 chain … walks end-to-end with no missing hop") and 6 ("per-issue-tree spend from `cost_events` at or under the budget cap").

## User Story

As the Operator (and any external accountability stakeholder),
I want to take the one real PR produced by P1.15 and mechanically walk the full §8.1 lineage — epic → Seeds → Paperclip issue → cost_events → approvals/decisions → heartbeat_runs → Archon run → Pi team → pi-lens → Hindsight — via the §8.4 query contract,
so that every PR is provably traceable back to its epic with zero missing hops and per-issue spend is shown within budget (G2: accountability is the differentiator).

## Overview

This slice builds the audit-walk tool that executes the §8.4 query contract as a single ordered routine over the native records (no new ground-truth tables; every hop is a query over an existing on-disk store). It cuts through Archon run-log → Paperclip (`issues`/`heartbeat_runs`/`cost_events`/`agents`/`approvals`/`issue_execution_decisions`) → Seeds `.seeds/issues.jsonl` → Pi team node output → pi-lens report → Hindsight bank, joining each hop on its documented key. It is one atomic 4pt unit because "no missing hop" is only demonstrable when all 10 joins resolve in one walk against a real PR — implementing a subset would leave the guarantee (and the §13 clause-5 gate) unproven.

## E2E Slice

**Demonstrable behavior:** Running `audit-walk <pr_url>` (or `audit-walk --issue <id>`) on the real PR from P1.15 resolves every §8.4 hop in order and emits a single structured report `{ hops: [...10], missing: [], perIssueSpendCents, budgetCents, withinBudget: true }` — `missing` is empty (every join resolved) and per-issue spend = `SUM(cost_events.costCents WHERE issueId ∈ subtree)` is at or under the agent/company `budgetMonthlyCents` cap. A deliberately broken hop (e.g. a run with no `cost_events` row) makes `missing` non-empty and the tool exits non-zero.

**Wiring closed:** On completion of this story, `audit-walk <pr_url>` on the P1.15 PR produces a report with `missing == []` (all 10 §8.4 joins resolve) and `withinBudget == true`, completing in ≤30s, using only code merged by this story plus its listed predecessors. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P1.15 (the real PR exists + its run log correlates `pr_url`↔`issueId`, supplying hop 1), P1.11 (every run writes ≥1 `cost_events` row; per-issue-tree spend queryable within budget — hops 5 + the budget assertion), P1.13 (the audit-chain item the §8.1 walk reconstructs). Each store (Seeds, Paperclip, Archon run log, pi-lens report, Hindsight bank) is populated by its own predecessor; this story only walks them.

## Acceptance Criteria

1. **(make-or-break)** Given the real PR from P1.15 and its populated lineage, When `audit-walk <pr_url>` runs, Then the report's `missing` array is empty — every one of the 10 §8.4 joins resolves (hops 1–10) — i.e. the full §8.1 chain walks with NO missing hop. (Binary: `missing.length === 0`.)
2. Given the walk resolves, When per-issue spend is computed, Then it equals `SUM(cost_events.costCents)` over the issue's `parentId` subtree (NOT any `issue.cost` field — there is none, NFR-ACC-3) and is at or under the agent/company `budgetMonthlyCents` cap (`withinBudget: true`), returned in ≤2s (NFR-COST-2).
3. Given any single hop is broken (a run with no `cost_events` row, or an `issues.executionRunId` that resolves to no `heartbeat_runs.id`, or a Hindsight document whose `document_id != runId`), When `audit-walk` runs, Then that hop appears in `missing` and the tool exits non-zero — a missing hop is surfaced, never silently skipped.
4. Given the actor hop (hop 4), When the walk resolves `issues.assigneeAgentId → agents.id`, Then it walks `agents.reportsTo` to the root agent and reports 0 orphan/anonymous actors (NFR-ACC-1) — no work is attributable to an un-parented actor.

## Technical Notes

- **§8.1 hop list (transcribed from PRD §8.1 / r3 §B):** epic → Seeds stories+deps (`.seeds/issues.jsonl`) → Paperclip issues (`assigneeAgentId`/`status`/`parentId`/`executionPolicy`) → {`cost_events` (costCents/issueId) | `approvals`+`issue_execution_decisions` | `heartbeat_runs`} → Archon run (SSE log, worktree) → Pi team (agent names/models/coms log) → pi-lens (TDI + stable IDs) → Hindsight (`document_id == runId`).
- **§8.4 query contract — exact joins (transcribed from PRD §8.4 / r3 §B):**
  1. PR → Archon run: PR branch/worktree id ↔ run id (run-log header, from P1.15 FR-OR-7).
  2. Archon run → issue: `issues.executionRunId`/`issues.checkoutRunId` (`issues.ts:37-38`) ↔ `heartbeat_runs.id`.
  3. issue → run trace(s): `heartbeat_runs` FK via the run-id columns.
  4. issue → assignee: `issues.assigneeAgentId` (`issues.ts:35`) → `agents.id` (+ `reportsTo` `agents.ts:24` walked to root).
  5. issue → cost: `cost_events.issueId` (`cost_events.ts:15`) = issue id; `SUM costCents` (`:27`).
  6. issue → decisions: `approvals.issueId` + `issue_execution_decisions.issueId` (`approvals.ts:5-28`).
  7. issue → decomposition: `issues.parentId` (`:29`) up to epic; Seeds `blocks[]`/`blockedBy[]` for sibling deps.
  8. run → Pi team: run id ↔ launcher invocation; agent names/models/coms log in node output + `~/.pi/coms/`.
  9. Pi team → pi-lens: per-agent turn-end report (stable IDs + TDI) attached to node output.
  10. run → memory: bank `{repo}`/`{repo}-<dept>-meta`; `document_id == runId` (Hindsight `agent.run.finished` hook).
- **Reconstruction note:** hops 2–7 are all keyed on the Paperclip issue id — once hop 2 resolves run→issue, the rest are direct FK lookups (PRD §8.4 reconstruction guarantee). Walk latency bounded by NFR-OBS-4(a) ≤30s.
- **Files / functions touched:** `audit-walk.ts` (the 10-hop ordered resolver + report), the per-issue-tree cost SUM query (`cost_events` over `parentId` subtree), the hop-result types.
- **Guards/limits:** each hop is a single indexed lookup or bounded fan-out; total walk ≤30s (NFR-OBS-4a); per-issue cost SUM ≤2s (NFR-COST-2).

## Files to Modify

- `scripts/audit/audit-walk.ts`
- `scripts/audit/hop-resolvers.ts`
- `scripts/audit/per-issue-cost.ts`
- `scripts/audit/audit-report.ts`
- `test/audit/audit-walk.e2e.test.ts`
- `test/audit/missing-hop.test.ts`

## Security Invariants

- **INV-1 (tenant):** Every hop query is scoped to the PR's company id (`companyId`, the QDS company `1287bc8d-2122-4484-bc0c-900662caf8a0`) — the walk never joins across companies (no cross-tenant `cost_events`/`issues`/`heartbeat_runs` rows enter the report); a row whose `companyId` differs is excluded, not silently merged.
- **INV-2 (auth):** Paperclip reads use the per-agent bearer (`PAPERCLIP_API_KEY`) + run-scoped header (`PAPERCLIP_RUN_ID`, NFR-SEC-2); Hindsight reads send `Authorization: Bearer` from env/secret ref (NFR-SEC-5) — never hardcoded, and the token is never written into the audit report.
- **INV-3 (cost/budget):** Per-issue spend is derived SOLELY from `SUM(cost_events.costCents)` over the subtree (NFR-ACC-3 — there is NO `issue.cost` column); the report asserts rolled-up spend is at or under `agents.spentMonthlyCents`/`companies.spentMonthlyCents` vs `budgetMonthlyCents` (no silent over-cap, NFR-COST-1) — a fabricated cost field is forbidden as a source.
- **INV-4 (auth/non-anonymity):** Hop 4 walks `agents.reportsTo` to the root agent; an actor that does not resolve to root is reported as an orphan and counted (NFR-ACC-1) — no work is accepted as attributable to an anonymous/un-parented actor.

## Definition of Done

- [ ] **Impl:** `audit-walk <pr_url>` resolves all 10 §8.4 hops in order and emits `{ hops, missing, perIssueSpendCents, budgetCents, withinBudget }`.
- [ ] **Impl:** Per-issue-tree spend is computed as `SUM(cost_events.costCents)` over the `parentId` subtree and compared to the agent/company budget cap.
- [ ] **Impl:** Hop 4 walks `agents.reportsTo` to root and reports orphan-actor count (NFR-ACC-1).
- [ ] **Contract:** The hop-result + report types are defined; each hop names its join key and source store (§8.4), backward-compatible with existing rows.
- [ ] **Integration:** The walk consumes P1.15's run log (hop 1, `pr_url`↔`runId`↔`issueId`) and joins live Paperclip/`heartbeat_runs`/`cost_events`/`approvals`/Seeds/pi-lens/Hindsight records (hops 2–10).
- [ ] **Observability/Audit:** The full walk on the real PR resolves with `missing == []` and completes in ≤30s (NFR-OBS-4a); per-issue cost query returns in ≤2s (NFR-COST-2).
- [ ] **Security:** INV-1 (company-scoped, no cross-tenant rows), INV-3 (cost solely from `cost_events`, within budget), and INV-4 (orphan-actor walk to root) each enforced and tested.
- [ ] **Test (unit/integration):** Covers a deliberately broken hop (missing `cost_events` row → `missing` non-empty, non-zero exit) and the per-issue subtree cost SUM equalling the ledger total.
- [ ] **Test (e2e demo — MANDATORY):** Fires AC-1: runs `audit-walk <pr_url>` on the P1.15 real PR; asserts `missing.length === 0` (all 10 §8.1 hops walk) AND `withinBudget === true` — proving the chain is mechanically reconstructable with zero missing hops and spend within budget.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
