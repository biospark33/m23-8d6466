# P1.16: Audit-Chain Reconstructable for One Real PR

**Story Points:** 4

## Spec Reference

- PRD §12; FR-ACT-1, NFR-ACC-2, NFR-OBS-3

## User Story

As a QDS platform auditor,
I want to walk the full audit chain from PR back to epic for any real PR produced by the system,
so that every automated action is mechanically traceable and the platform meets observability and accountability requirements.

## Overview

For one real PR produced by P1.15, the audit chain must be fully reconstructable. Every hop resolves without manual intervention or missing data. The chain walks: PR → protocol run → GitHub issue → cost events → execution decisions → decomposition → Pi team → pi-lens TDI → Hindsight memory. Each join in the chain resolves to a concrete record with stable IDs. The walk completes in under 30 seconds (NFR-OBS-4). This story implements the audit chain walker and validates that all correlation keys are correctly threaded through the pipeline.

## E2E Slice

**Demonstrable behavior:** Given a PR produced by P1.15, invoking the audit chain walker returns a complete chain object with every hop resolved. The walk completes in under 30 seconds. No hop returns null or missing.

**Wiring closed:** On completion of this story, every PR produced by the SwarmClaw protocol is mechanically traceable from PR back to epic with no missing hops, using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors (P1.13, P1.11, P1.15) are dependency edges, not unfinished wiring inside this story.

**Dependency edges (predecessors):** P1.13, P1.11, P1.15

## Acceptance Criteria

1. **(make-or-break)** Given a PR produced by P1.15, When the audit chain walker is invoked with the PR URL or branch name, Then the walker returns a complete chain object with all 8 hops resolved: PR→protocol run→issue→cost→decisions→decomposition→Pi team→pi-lens→Hindsight memory.
2. Given the audit chain walker result, When each hop is inspected, Then every join resolves to a non-null record with a stable ID (no `null`, `undefined`, or "missing" entries).
3. Given a PR with a broken correlation key (e.g., missing runId in PR body), When the walker is invoked, Then the walker reports the specific broken hop with a diagnostic message rather than failing silently or returning partial results.
4. Given the audit chain walker is invoked, When the walk completes, Then total wall-clock time is under 30 seconds (NFR-OBS-4).

## Technical Notes

- **Contracts/Schema:** Audit chain hops (in order): (1) PR→protocol run via PR branch name pattern `qds/{runId}`, (2) run→issue via correlation key `issueId` in protocol state, (3) issue→cost via `SUM(cost_events) WHERE issueId`, (4) issue→decisions via `executionPolicy` stored in protocol state, (5) issue→decomposition via `parentId` tree in Seeds mirror, (6) run→Pi team via step output with agent names/models, (7) Pi team→pi-lens via TDI + stable IDs, (8) run→memory via Hindsight bank query `document_id=runId`.
- **Integration points:** Audit walker queries: SwarmClaw protocol state store, GitHub API (PR details), Seeds decomposition store, cost ledger (P1.13), Hindsight banks (`{repo}`, `{repo}-dev-meta`, `qds-collective`), pi-lens TDI records.
- **Files / functions touched:** `src/audit/chain-walker.ts` (main walker), `src/audit/hops.ts` (individual hop resolvers), `src/audit/correlation-keys.ts` (key extraction utilities), `src/swarmclaw/protocol.ts` (ensure correlation keys are persisted), `src/hindsight/client.ts` (bank queries for audit).
- **Guards/limits:** Walker must timeout after 30s (NFR-OBS-4). Each hop must have a diagnostic message on failure. Correlation keys must be written at the point of creation, not retroactively.

## Files to Modify

- `src/audit/chain-walker.ts`
- `src/audit/hops.ts`
- `src/audit/correlation-keys.ts`
- `src/swarmclaw/protocol.ts`
- `src/hindsight/client.ts`

## Security Invariants

- INV-1: Audit walker only queries banks and stores within the same repo scope — no cross-tenant data access.
- INV-2: Walker does not expose internal GitHub tokens or API credentials in diagnostic output.
- INV-3: Cost events in the audit chain show aggregated cents only — never raw token-level billing details that could leak pricing tiers.

## Definition of Done

- [ ] **Impl:** Audit chain walker with 8 hop resolvers: PR→run, run→issue, issue→cost, issue→decisions, issue→decomposition, run→Pi team, Pi team→pi-lens, run→memory.
- [ ] **Impl:** Correlation key extraction from PR branch name, protocol state, and Hindsight documents.
- [ ] **Impl:** Broken-hop diagnostic reporting (specific hop, expected key, actual value).
- [ ] **Impl:** 30-second timeout guard on the full walk (NFR-OBS-4).
- [ ] **Contract:** Audit chain output schema includes all 8 hops with stable IDs and timestamps.
- [ ] **Integration:** Walker queries SwarmClaw state, GitHub API, Seeds store, cost ledger, and Hindsight banks.
- [ ] **Integration:** Correlation keys are written at creation time in protocol state (not retroactively).
- [ ] **Security:** Walker scoped to repo-specific banks; no cross-tenant access.
- [ ] **Test (unit):** Each hop resolver returns correct record given mock input with known correlation keys.
- [ ] **Test (unit):** Walker reports diagnostic on broken correlation key (not silent failure).
- [ ] **Test (e2e demo — MANDATORY):** Invoke walker on P1.15's real PR; all 8 hops resolve in under 30 seconds; output is a complete, inspectable chain object.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
