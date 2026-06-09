# P0.9: Hindsight Bank Provisioning + Retain→Recall→Reflect Round-Trip + Mulch Import

**Story Points:** 4

## Spec Reference

- PRD §7 (Hindsight Memory); FR-MEM-1, FR-MEM-4
- Phase exit gate: PRD §13 Phase 0 clause 9

## User Story

As a QDS dev agent,
I want provisioned Hindsight banks with a verified retain→recall→reflect round-trip and imported Mulch expertise,
so that every subsequent phase has a working memory substrate with pre-seeded domain knowledge (G1 — reliable memory).

## Overview

This story provisions the three required Hindsight banks (`{repo}`, `{repo}-dev-meta`, `qds-collective`), exercises the full memory lifecycle (retain, recall, reflect, consolidate) against each bank, and imports Mulch expertise files from `.mulch/expertise/` into the `qds-collective` bank. The Hindsight MCP server (already on PATH as `hindsight-local-mcp`) is the transport; SwarmClaw's MCP bridge (from P0.7) is the invocation path. This is a 4-point unit because it must provision three banks, validate four API operations per bank, parse and import Mulch files, and confirm the round-trip is usable by downstream agent sessions.

## E2E Slice

**Demonstrable behavior:** Create three Hindsight banks. Retain a structured memory into `{repo}`, recall it by semantic query, reflect on it, and verify consolidation preserves it. Import all `.mulch/expertise/` files into `qds-collective` and recall one by concept. All operations exercised through SwarmClaw's MCP invoke endpoint (P0.7).

**Wiring closed:** On completion of this story, the three Hindsight banks exist, the retain→recall→reflect→consolidate lifecycle round-trips, and Mulch expertise is queryable via recall — using only code merged by this story and predecessor P0.7. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P0.7 (SwarmClaw MCP bridge must be registered to invoke Hindsight tools).

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given three provisioned Hindsight banks and SwarmClaw's MCP bridge to Hindsight (P0.7), When a memory is retained via `POST /api/mcp-servers/{hindsight_id}/invoke` (tool: `retain`, bank: `{repo}`, content: "Sprint planning uses SPARC methodology"), then recalled via invoke (tool: `recall`, bank: `{repo}`, query: "planning methodology"), then reflected via invoke (tool: `reflect`, bank: `{repo}`), Then the recall response contains the retained content and the reflect response contains a non-empty insight string.
2. Given `.mulch/expertise/` directory with at least one YAML/JSON expertise file, When the Mulch import script runs targeting the `qds-collective` bank, Then each expertise entry is retained as a separate memory and is recallable by its domain concepts within 5 seconds.
3. Given a bank that does not exist, When retain is called with an invalid bank_id, Then Hindsight returns a non-200 status and the MCP bridge surfaces the error as `{ ok: false, error: <message> }` — the agent never receives a false positive.

## Technical Notes

- **Contracts/Schema:**
  ```typescript
  // Hindsight bank creation (via MCP invoke — retain to non-existent bank creates it)
  // OR explicit bank provisioning via Hindsight REST API
  const BankIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/);

  // Retain payload
  const RetainPayloadSchema = z.object({
    bank_id: BankIdSchema,
    content: z.string().min(1),
    metadata: z.object({
      source: z.enum(["agent", "mulch-import", "manual"]),
      kind: z.enum(["decision", "pattern", "expertise", "observation"]).optional(),
      tags: z.array(z.string()).optional(),
    }).optional(),
  });

  // Recall payload
  const RecallPayloadSchema = z.object({
    bank_id: BankIdSchema,
    query: z.string().min(1),
    limit: z.number().int().min(1).max(50).default(5),
  });

  // Reflect payload
  const ReflectPayloadSchema = z.object({
    bank_id: BankIdSchema,
    query: z.string().optional(),
  });

  // Mulch expertise file (YAML/JSON)
  const MulchExpertiseSchema = z.object({
    domain: z.string(),
    concepts: z.array(z.string()),
    expertise: z.string(),
    confidence: z.number().min(0).max(1).optional(),
  });
  ```

- **Integration points (each wired & exercised in this story):**
  - Hindsight REST API `/v1/default/banks/{bank_id}/memories` — retain (POST)
  - Hindsight REST API `/v1/default/recall` — recall (POST)
  - Hindsight REST API `/v1/default/reflect` — reflect (POST)
  - Hindsight REST API `/v1/default/consolidate` — consolidate (POST)
  - SwarmClaw MCP invoke bridge (P0.7) — tool invocation path
  - `.mulch/expertise/` directory — file read and parse
  - Mulch CLI (`/usr/local/bin/mulch` v0.6.3) — expertise extraction if needed

- **Files / functions touched:**
  - `src/hindsight/bank-provisioner.ts` — creates three banks
  - `src/hindsight/round-trip-verifier.ts` — retain→recall→reflect→consolidate validation
  - `src/hindsight/mulch-importer.ts` — reads `.mulch/expertise/` and retains into qds-collective
  - `src/hindsight/client.ts` — HTTP client wrapper for Hindsight API
  - `scripts/provision-hindsight-banks.ts` — CLI script for bank provisioning
  - `scripts/import-mulch-expertise.ts` — CLI script for Mulch import

- **Guards/limits:**
  - Bank creation idempotent — re-provisioning existing bank returns existing bank_id
  - Mulch import idempotent — re-importing same expertise updates rather than duplicates (dedup by domain+concepts hash)
  - Retain payload max size: 100 KB per memory entry
  - Recall query timeout: 10 seconds
  - Reflect timeout: 30 seconds
  - Consolidate timeout: 60 seconds
  - Maximum Mulch expertise files: 100

## Files to Modify

> ≤10 unique paths, one per line.
- `src/hindsight/bank-provisioner.ts`
- `src/hindsight/round-trip-verifier.ts`
- `src/hindsight/mulch-importer.ts`
- `src/hindsight/client.ts`
- `scripts/provision-hindsight-banks.ts`
- `scripts/import-mulch-expertise.ts`
- `tests/hindsight/bank-provisioning.test.ts`
- `tests/hindsight/memory-round-trip.test.ts`
- `tests/hindsight/mulch-import.test.ts`

## Security Invariants

> Concrete named invariants only — N/A NOT permitted when triggered.

- **INV-HM1:** Hindsight API auth token (if configured via `HINDSIGHT_BEARER_TOKEN` env var) is read from environment only — never hardcoded, never logged, never included in test output.
- **INV-HM2:** Bank IDs are validated against `BankIdSchema` before any API call — path injection via crafted bank_id (e.g., `../../etc/passwd`) is rejected with 400.
- **INV-HM3:** Mulch expertise file paths are resolved relative to the project root and validated to be inside `.mulch/expertise/` — directory traversal via symlinks or `..` segments is rejected.
- **INV-HM4:** Tenant isolation: bank operations are scoped to the bank_id — cross-bank data leakage in recall/reflect responses is verified absent in tests (recall on bank A never returns memories from bank B).

## Definition of Done

> 8–12 high-signal, story-specific boxes. NO lint/tests/typecheck filler.

- [ ] **Impl:** Bank provisioner creates `{repo}`, `{repo}-dev-meta`, and `qds-collective` banks; idempotent on re-run
- [ ] **Impl:** Round-trip verifier retains a test memory, recalls it by semantic query, reflects on it, and confirms consolidation preserves it
- [ ] **Impl:** Mulch importer reads all `.mulch/expertise/*.{yaml,json}` files, parses them against `MulchExpertiseSchema`, and retains each into `qds-collective`
- [ ] **Contract:** Zod schemas for `RetainPayloadSchema`, `RecallPayloadSchema`, `ReflectPayloadSchema`, `MulchExpertiseSchema` validated on all inputs
- [ ] **Integration:** Hindsight HTTP client wired to SwarmClaw MCP invoke path — all four operations (retain, recall, reflect, consolidate) exercised through the bridge
- [ ] **Security:** INV-HM1 through INV-HM4 enforced — bearer token env-only, bank_id validated, file path scoped, tenant isolation verified
- [ ] **Test (unit/integration):** Provision three banks → retain to each → recall from each → assert correct content returned per bank; import Mulch files → recall by concept → assert match
- [ ] **Test (guard):** Invalid bank_id → error surfaced; empty `.mulch/expertise/` → graceful skip with warning; malformed expertise file → parse error reported, other files still imported
- [ ] **Test (e2e demo — MANDATORY):** Run provision script → run Mulch import → invoke retain via MCP bridge → invoke recall → invoke reflect → assert round-trip completes with correct data for all three banks
- [ ] **Test (idempotency):** Run provision + import twice → assert no duplicate memories, bank IDs unchanged, recall returns same results
