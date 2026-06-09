# P1.14: Outcome Record + Deterministic Router Selection Wiring

**Story Points:** 3

## Spec Reference

- PRD §11; FR-LEARN-28, FR-LEARN-29, NFR-REL-4
- Phase exit gate: PRD §13 Phase 1 clause 14

## User Story

As a QDS platform operator,
I want every protocol run to emit a structured outcome record and log the router selection rationale deterministically,
so that cost accounting, learning loops, and audit trails are mechanically complete without manual reconciliation.

## Overview

After every SwarmClaw protocol run completes (or fails), the system writes an outcome record keyed on `runId` with idempotent upsert semantics (NFR-REL-4). The record captures task metadata, model tier selections, token counts, cost in cents, wall-clock duration, first-pass acceptance, and retry count. Simultaneously, the router selection rationale is logged: signature inputs (task_type, archetype, repo fingerprint), chosen config (model tier per role), and the binding constraint that resolved the decision. This story wires Layer-B substrate capture into the protocol's summarize phase.

## E2E Slice

**Demonstrable behavior:** A completed protocol run (dispatch_task through summarize) produces an outcome record in Hindsight bank `{repo}-dev-meta` keyed on `runId`, and a router-selection log entry in the same bank. Re-running with the same `runId` upserts (idempotent) rather than duplicates.

**Wiring closed:** On completion of this story, any SwarmClaw protocol run that reaches the summarize phase writes a complete outcome record and router-selection rationale to Hindsight using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors (P1.5, P1.13) are dependency edges, not unfinished wiring inside this story.

**Dependency edges (predecessors):** P1.5, P1.13

## Acceptance Criteria

1. **(make-or-break)** Given a SwarmClaw protocol run that completes the summarize phase, When the run finishes, Then an outcome record exists in Hindsight bank `{repo}-dev-meta` with document_id=`{runId}` containing all fields: task_type, archetype, per_role_model_tier, cost_cents, tokens, first_pass_accept, retry_count, wall_clock_ms.
2. Given the same `runId` processed a second time, When the outcome writer is invoked, Then the record is upserted (exactly one record per runId) — no duplicate entries exist in the bank.
3. Given a completed run, When the router-selection log is queried, Then the entry contains: signature_inputs (task_type, archetype, repo fingerprint), chosen_config (model tier per role), and binding_constraint (the constraint that resolved the decision).
4. Given a run that fails before the summarize phase, When the failure is caught, Then a partial outcome record is written with `first_pass_accept=false` and populated error fields.

## Technical Notes

- **Contracts/Schema:** Outcome record (FR-LEARN-28): `{ runId: string, task_type: enum, archetype: string, per_role_model_tier: Record<Role, string>, cost_cents: integer, tokens: { prompt: int, completion: int, total: int }, first_pass_accept: boolean, retry_count: integer, wall_clock_ms: integer, timestamp: ISO-8601 }`. Router selection rationale: `{ runId: string, signature_inputs: { task_type, archetype, repo_fingerprint }, chosen_config: Record<Role, ModelTier>, binding_constraint: string }`. Keyed on `runId` for idempotent upsert (NFR-REL-4).
- **Integration points:** SwarmClaw summarize phase → Hindsight MCP `retain` tool invocation with `document_id=runId`. Router selection log → same bank, separate document with `document_id={runId}:router`.
- **Files / functions touched:** `src/swarmclaw/phases/summarize.ts` (outcome writer), `src/swarmclaw/router/selection-log.ts` (rationale logger), `src/memory/hindsight-client.ts` (bank write with upsert), `src/swarmclaw/protocol.ts` (wire summarize hook).
- **Guards/limits:** Upsert must be atomic — use Hindsight's document_id uniqueness. Cost_cents must be non-negative. Tokens must be non-negative integers. Wall_clock_ms must be > 0 for completed runs.

## Files to Modify

- `src/swarmclaw/phases/summarize.ts`
- `src/swarmclaw/router/selection-log.ts`
- `src/memory/hindsight-client.ts`
- `src/swarmclaw/protocol.ts`

## Security Invariants

- INV-1: Outcome records are written to the repo-scoped bank `{repo}-dev-meta` — never to a shared or cross-tenant bank.
- INV-2: No secrets, API keys, or PII appear in outcome records or router logs.
- INV-3: Idempotent upsert prevents injection of duplicate cost events that could inflate accounting.

## Definition of Done

- [ ] **Impl:** Outcome record writer in summarize phase with all FR-LEARN-28 fields populated.
- [ ] **Impl:** Router selection rationale logger capturing signature inputs, chosen config, and binding constraint.
- [ ] **Impl:** Idempotent upsert using Hindsight document_id=`runId` (NFR-REL-4).
- [ ] **Impl:** Partial outcome record on failure (first_pass_accept=false, error fields populated).
- [ ] **Contract:** Outcome record schema validated against FR-LEARN-28 field list.
- [ ] **Contract:** Router selection schema includes signature_inputs, chosen_config, binding_constraint.
- [ ] **Integration:** Hindsight bank write via MCP `retain` tool on `{repo}-dev-meta` bank confirmed working.
- [ ] **Integration:** Summarize phase in protocol.ts invokes outcome writer and router logger.
- [ ] **Security:** No PII or secrets in outcome records (verified by scan).
- [ ] **Test (unit):** Outcome writer produces correct schema; upsert is idempotent (write twice, count one).
- [ ] **Test (e2e demo — MANDATORY):** Run a protocol to summarize phase, query Hindsight for `{runId}`, confirm outcome record and router log both present with no duplicates.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
