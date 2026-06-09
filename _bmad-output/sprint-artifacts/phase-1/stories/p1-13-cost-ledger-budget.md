# P1.13: Cost Ledger Within Budget (Per-Issue Spend + Over-Cap Gate)

**Story Points:** 4

## Spec Reference

- PRD §5.3, §6.1; FR-CP-4, FR-CP-12, NFR-COST-1, NFR-COST-2, NFR-ACC-3

## User Story

As a dev manager,
I want per-issue token cost tracked natively and over-cap spend halted automatically,
so that budget overruns are prevented and cost is summable per issue without derived columns.

## Overview

The CLI-Anything harness writes a `cost_events` row after each Pi role execution completes. Each row captures `agentId`, `issueId`, `model`, `provider`, `costCents`, `inputTokens`, `outputTokens`, and `heartbeatRunId`. Per-issue cost is computed as `SUM(cost_events.costCents) WHERE issueId = :id` — no `issue.cost` column exists (NFR-ACC-3: derived on demand, never stale). An over-cap gate checks cumulative per-issue spend before each new protocol step. If spend exceeds the configured budget cap, the run halts with `status: 'over-budget'` and no further steps execute. Cost events are append-only and immutable.

## E2E Slice

**Demonstrable behavior:** A protocol run for issue #42 executes three Pi agent steps. After each step, the CLI-Anything harness writes a `cost_events` row. Per-issue spend is queryable as `SUM(cost_events.costCents) WHERE issueId = 42`. Before the fourth step, the over-cap gate checks cumulative spend against the budget cap ($5.00 = 500 cents). If spend is $5.12 → run halts with `status: 'over-budget'`. If spend is $4.80 → step proceeds. All cost events are persisted and immutable.

**Wiring closed:** On completion of this story, spend is native, summable per issue, and capped with an over-cap gate using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P1.6, P1.8

## Acceptance Criteria

1. **(make-or-break)** Given a Pi agent step completes during a protocol run, When the CLI-Anything harness writes the cost event, Then a `cost_events` row is persisted with `agentId`, `issueId`, `model`, `provider`, `costCents`, `inputTokens`, `outputTokens`, `heartbeatRunId`, and `createdAt` — all fields populated, no nulls.
2. Given multiple `cost_events` rows exist for an issue, When per-issue spend is queried, Then the result is `SUM(cost_events.costCents) WHERE issueId = :id` and matches the sum of individual step costs exactly. No `issue.cost` column is used.
3. Given cumulative per-issue spend exceeds the configured budget cap (default: 500 cents), When the over-cap gate evaluates before the next protocol step, Then the run halts with `status: 'over-budget'`, `reason: 'spend-cap-exceeded'`, and no further steps execute.
4. Given cumulative per-issue spend is below the budget cap, When the over-cap gate evaluates, Then the step proceeds and the remaining budget is logged.
5. Given a `cost_events` row has been written, When any attempt is made to mutate or delete it, Then the operation is rejected — cost events are append-only and immutable.

## Technical Notes

- **Contracts/Schema:** `cost_events { id: UUID, agentId: string, issueId: number, model: string, provider: string, costCents: integer, inputTokens: integer, outputTokens: integer, heartbeatRunId: string, createdAt: ISO8601 }`. Per-issue cost query: `SELECT SUM(costCents) FROM cost_events WHERE issueId = :id`. No `issue.cost` column (NFR-ACC-3). Budget cap config: `{ defaultCapCents: 500, perIssueOverrides?: Record<number, number> }`.
- **Integration points:** CLI-Anything harness (writes cost_events after each Pi role execution); SwarmClaw protocol phase executor (over-cap gate check before each step); cost_events store (append-only table or file); budget cap configuration.
- **Files / functions touched:** `src/cost/cost-ledger.ts` (cost event writer + per-issue query), `src/cost/over-cap-gate.ts` (budget cap enforcement), `src/protocol/phase-executor.ts` (gate integration), `src/models/cost-event.ts` (schema), `src/cost/budget-config.ts` (cap configuration).
- **Guards/limits:** `costCents` is integer (no floating-point). Append-only: no UPDATE or DELETE on `cost_events`. Gate check is atomic — spend is computed and compared in a single read. Budget cap default: 500 cents ($5.00). Per-issue overrides supported.

## Files to Modify

- `src/cost/cost-ledger.ts`
- `src/cost/over-cap-gate.ts`
- `src/protocol/phase-executor.ts`
- `src/models/cost-event.ts`
- `src/cost/budget-config.ts`

## Security Invariants

- INV-COST-1: `cost_events` rows are append-only and immutable — no UPDATE, no DELETE, no mutation after write.
- INV-COST-2: Per-issue cost is derived via `SUM(cost_events.costCents) WHERE issueId = :id` — no denormalized `issue.cost` column exists (NFR-ACC-3).
- INV-COST-3: Over-cap gate check is atomic and runs before every protocol step — no step can execute if cumulative spend exceeds the cap.
- INV-COST-4: All cost events include `heartbeatRunId` for traceability — every cost is linked to a specific run execution.

## Definition of Done

- [ ] **Impl:** CLI-Anything harness writes `cost_events` row after each Pi role execution with all required fields
- [ ] **Impl:** Per-issue spend queryable as `SUM(costCents) WHERE issueId = :id` — no `issue.cost` column
- [ ] **Impl:** Over-cap gate checks cumulative spend before each step; halts on cap exceeded
- [ ] **Impl:** Cost events are append-only — mutation and deletion rejected
- [ ] **Contract:** `cost_events` schema defined with all fields; per-issue query contract documented; budget cap config schema defined
- [ ] **Integration:** CLI-Anything harness cost writer; SwarmClaw phase executor gate check; budget cap configuration
- [ ] **Security:** Append-only enforcement; no denormalized cost column; atomic gate check; `heartbeatRunId` traceability
- [ ] **Test (unit):** Cost event written with all fields; per-issue SUM matches individual costs; over-cap gate halts; under-cap gate proceeds; mutation rejected; deletion rejected
- [ ] **Test (e2e demo — MANDATORY):** Full protocol run where 3 steps write cost_events, per-issue spend is queried and matches SUM, 4th step exceeds cap → run halts with `status: 'over-budget'`; separate run with higher cap → all steps complete
