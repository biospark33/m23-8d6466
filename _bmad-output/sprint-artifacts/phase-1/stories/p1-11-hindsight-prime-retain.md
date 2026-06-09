# P1.11: qds-hindsight-prime Recall + Post-Run Retain Wiring via MCP

**Story Points:** 4

## Spec Reference

- PRD §3.4, §5.2; FR-MG-6, FR-MG-7, FR-MEM-2

## User Story

As a dev manager,
I want protocol steps to recall relevant memory before execution and retain learnings after,
so that each run benefits from accumulated experience and contributes back to collective knowledge.

## Overview

Before a protocol step executes, SwarmClaw primes the Pi agent context by recalling relevant entries from Hindsight banks via the `hindsight-local-mcp` server. Banks are `{repo}` (codebase-specific), `{repo}-dev-meta` (development patterns), and `qds-collective` (cross-project learnings). After the step completes, the run's learnings (what worked, what failed, decisions made) are retained back to the appropriate Hindsight bank. This forms the L2 memory loop: recall → execute → retain. The MCP interface is the sole channel — no direct HTTP calls to Hindsight.

## E2E Slice

**Demonstrable behavior:** A protocol step for issue #42 starts. SwarmClaw calls `hindsight-local-mcp` `/recall` with context from the issue body and prior run history. Relevant entries from `{repo}` and `qds-collective` banks are injected into the Pi agent context. After the step executes and produces output, SwarmClaw calls `hindsight-local-mcp` `/v1/default/banks/{repo}/memories` to retain the step's learnings. The full recall → execute → retain loop completes on the real run.

**Wiring closed:** On completion of this story, the memory loop (recall → execute → retain) completes on a real protocol step using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P0.9, P1.6

## Acceptance Criteria

1. **(make-or-break)** Given a protocol step is about to execute for an issue, When SwarmClaw primes the agent context, Then it calls `hindsight-local-mcp` `/recall` with the issue context and receives relevant entries from `{repo}`, `{repo}-dev-meta`, and `qds-collective` banks, and these entries are injected into the Pi agent's working context.
2. Given a protocol step has completed successfully, When SwarmClaw retains learnings, Then it calls `hindsight-local-mcp` `/v1/default/banks/{bank_id}/memories` with structured content (what worked, what failed, decisions), and the entry is persisted to the appropriate bank with `metadata.issueId` and `metadata.runId`.
3. Given the Hindsight MCP server is unreachable, When a recall is attempted, Then the step proceeds without primed context, a `waiver.reason: 'hindsight-unavailable'` is logged, and the retain step is skipped (no partial writes).
4. Given a recall returns entries, When they are injected into the agent context, Then each entry includes its `bank_id`, `relevance_score`, and `created_at` so the agent can assess recency and relevance.

## Technical Notes

- **Contracts/Schema:** Recall request: `{ query: string, bank_ids: string[], limit: number, min_relevance?: number }`. Recall response: `{ entries: MemoryEntry[] }`. `MemoryEntry { id: string, bank_id: string, content: string, metadata: Record<string, any>, relevance_score: number, created_at: ISO8601 }`. Retain request: `{ bank_id: string, content: string, metadata: { issueId: number, runId: string, stepId: string, kind: 'learning' | 'decision' | 'pattern' } }`. Retain response: `{ id: string, bank_id: string }`.
- **Integration points:** `hindsight-local-mcp` on PATH (pip 0.4.17); MCP protocol for all Hindsight communication; Hindsight banks: `{repo}`, `{repo}-dev-meta`, `qds-collective`; SwarmClaw protocol phase executor for prime/retain hooks.
- **Files / functions touched:** `src/memory/hindsight-client.ts` (MCP-based recall/retain client), `src/memory/prime-phase.ts` (pre-execution recall wiring), `src/memory/retain-phase.ts` (post-execution retain wiring), `src/protocol/phase-executor.ts` (prime/retain hooks integration), `src/models/hindsight-entry.ts` (schemas).
- **Guards/limits:** Recall limit: 10 entries per bank per step. Retain content max: 4000 characters per entry. MCP call timeout: 15s. No fallback to direct HTTP — MCP is the sole channel.

## Files to Modify

- `src/memory/hindsight-client.ts`
- `src/memory/prime-phase.ts`
- `src/memory/retain-phase.ts`
- `src/protocol/phase-executor.ts`
- `src/models/hindsight-entry.ts`

## Security Invariants

- INV-MEM-1: Hindsight communication is exclusively via `hindsight-local-mcp` — no direct HTTP calls to Hindsight API, no bypass of the MCP layer.
- INV-MEM-2: Retained entries include `metadata.issueId` and `metadata.runId` — no anonymous writes to collective banks.
- INV-MEM-3: When Hindsight MCP is unavailable, the step proceeds but no partial or stale memory is injected — the waiver is logged and the step runs unprimed.

## Definition of Done

- [ ] **Impl:** Pre-execution prime: recall relevant entries from `{repo}`, `{repo}-dev-meta`, `qds-collective` banks via MCP
- [ ] **Impl:** Inject recalled entries into Pi agent context with `bank_id`, `relevance_score`, `created_at`
- [ ] **Impl:** Post-execution retain: write structured learnings to appropriate Hindsight bank via MCP
- [ ] **Impl:** Hindsight MCP unavailable → proceed without primed context, log `waiver.reason: 'hindsight-unavailable'`, skip retain
- [ ] **Contract:** `MemoryEntry`, recall request/response, retain request/response schemas defined and exported
- [ ] **Integration:** `hindsight-local-mcp` on PATH; MCP protocol for all calls; banks `{repo}`, `{repo}-dev-meta`, `qds-collective`
- [ ] **Security:** MCP-only communication; retained entries tagged with issueId/runId; unavailable graceful degradation
- [ ] **Test (unit):** Recall returns entries and injects context; retain writes to bank; MCP timeout → waiver; empty recall → step proceeds; retain metadata includes issueId/runId
- [ ] **Test (e2e demo — MANDATORY):** Full protocol run where step recalls entries from `qds-collective`, executes with primed context, retains learnings to `{repo}` bank — full L2 loop round-trip confirmed by querying the bank post-run and finding the retained entry
