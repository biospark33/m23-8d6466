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

This story provisions the three required Hindsight banks (`{resolveBankId(repoSlug)}`, `{resolveBankId(repoSlug)}-dev-meta`, `qds-collective`), exercises the full memory lifecycle (retain, recall, reflect, consolidate) against each bank, and imports Mulch expertise files from `.mulch/expertise/` into the `qds-collective` bank. The Hindsight MCP server (already on PATH as `hindsight-local-mcp`) is the transport; SwarmClaw's MCP bridge (from P0.7) is the invocation path. This is a 4-point unit because it must provision three banks, validate four API operations per bank, parse and import Mulch files, and confirm the round-trip is usable by downstream agent sessions.

## E2E Slice

**Demonstrable behavior:** Create three Hindsight banks. Retain a structured memory into `{resolveBankId(repoSlug)}`, recall it by semantic query, reflect on it, and verify consolidation preserves it. Import all `.mulch/expertise/` files into `qds-collective` and recall one by concept. All operations exercised through SwarmClaw's MCP invoke endpoint (P0.7).

**Wiring closed:** On completion of this story, the three Hindsight banks exist, the retain→recall→reflect→consolidate lifecycle round-trips, and Mulch expertise is queryable via recall — using only code merged by this story and predecessor P0.7. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P0.7 (SwarmClaw MCP bridge must be registered to invoke Hindsight tools).

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given three provisioned Hindsight banks and SwarmClaw's MCP bridge to Hindsight (P0.7), When a memory is retained via `POST /api/mcp-servers/{hindsight_id}/invoke` (tool: `retain`, bank: `{resolveBankId(repoSlug)}`, content: "Sprint planning uses SPARC methodology"), then recalled via invoke (tool: `recall`, bank: `{resolveBankId(repoSlug)}`, query: "planning methodology"), then reflected via invoke (tool: `reflect`, bank: `{resolveBankId(repoSlug)}`), then consolidated via invoke (tool: `consolidate`, bank: `{resolveBankId(repoSlug)}`), Then the recall response contains the retained content, the reflect response contains a non-empty insight string, and the consolidated bank retains the core content (semantic match ≥ 0.8) with a valid `ConsolidateResponseSchema` response.
2. Given `.mulch/expertise/` directory with at least one YAML/JSON expertise file, When the Mulch import script runs targeting the `qds-collective` bank, Then each expertise entry is retained as a separate memory and is recallable by its domain concepts within 5 seconds.
3. Given a bank that does not exist, When retain is called with an invalid bank_id, Then Hindsight returns a non-200 status and the MCP bridge surfaces the error as `{ ok: false, error: <message> }` — the agent never receives a false positive.
4. Given P0.7 MCP bridge not registered (no SwarmClaw agent for Hindsight), When the provision operation is invoked, Then it returns a structured error `{ ok: false, error: { code: -32001, message: "MCP bridge not registered" } }` without creating banks.
5. Given P0.7 MCP bridge registered but Hindsight binary not on PATH (P0.7 /test returns `{ ok: false }`), When the provision operation is invoked, Then it returns `{ ok: false, error: { code: -32002, message: "Hindsight binary unavailable" } }` without creating banks.
6. After importing a `.mulch/expertise/` directory containing YAML and JSON files, all entries are stored as JSONL in the `{resolveBankId(repoSlug)}-dev-meta` bank.
7. Given a bank with ≤100 memories, When recall is called with a semantic query, Then results are returned within 2 seconds for exact-match queries and within 5 seconds for semantic-similarity queries. Timeout at 10s returns an error, not stale results.

## Technical Notes

- **Contracts/Schema:**
  ```typescript
  // Hindsight bank creation (via MCP invoke — retain to non-existent bank creates it)
  // OR explicit bank provisioning via Hindsight REST API
  const BankIdSchema = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/);

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

  // Consolidate payload
  const ConsolidatePayloadSchema = z.object({
    bank_id: BankIdSchema,
    options: z.object({
      maxAge: z.number().optional(),        // consolidate entries older than this (hours)
      preserveRecent: z.number().default(10), // keep N most recent entries unconsolidated
    }).optional(),
  });

  // Consolidate response
  const ConsolidateResponseSchema = z.object({
    consolidatedCount: z.number(),
    preservedCount: z.number(),
    durationMs: z.number(),
  });

  // Mulch expertise entry (canonical storage = JSONL, one object per line)
  const MulchExpertiseSchema = z.object({
    id: z.string().uuid(),           // auto-generated on import
    domain: z.string(),
    concepts: z.array(z.string()),
    expertise: z.string(),
    source: z.string().optional(),   // file path or origin of the expertise entry
    confidence: z.number().min(0).max(1).optional(),
  });
  ```

  ### Mulch Storage Format Contract

  Expertise entries are stored as **JSONL** (one JSON object per line) in the `{resolveBankId(repoSlug)}-dev-meta` bank. Each line is a valid JSON object conforming to `MulchExpertiseSchema`.

  **Input format support:** Input files may be YAML (`.yml`/`.yaml`), JSON (`.json`), or JSONL (`.jsonl`). The import flow converts all formats to JSONL for storage. YAML and JSON files are parsed as arrays of expertise objects; each element becomes one JSONL line. JSONL files are read line-by-line.

  **Import flow:** Read `.mulch/expertise/` files, parse each file according to its extension (YAML → array, JSON → array, JSONL → line-by-line), validate each entry against `MulchExpertiseSchema` (with `id` auto-generated as UUID if absent), and retain as JSONL into the `{resolveBankId(repoSlug)}-dev-meta` bank.

**Dedup key canonical form:** Mulch import deduplicates by hashing a collision-safe JSON serialization of `{ "domain": domain, "concepts": sorted(concepts) }`. The concepts array is sorted alphabetically before serialization to ensure order-independent matching. Using JSON serialization (rather than delimiter concatenation) prevents hash collisions where a domain containing the delimiter character could produce the same key as a differently-structured entry. Re-importing an expertise entry with the same domain and same concept set (in any order) updates the existing entry rather than creating a duplicate. The hash is computed as `SHA-256(JSON.stringify({ domain, concepts: sorted_concepts }))`.

**Partial failure handling:** Mulch import is best-effort per-file. If one file fails to parse or validate, remaining files are still imported. The import response includes per-file status: `{ totalFiles, importedFiles, failures: Array<{ file, error }> }`. If a single file contains multiple entries, valid entries are imported and invalid entries are reported individually. Empty `.mulch/expertise/` directory is a graceful skip with a warning log, not an error.

**Directory traversal rules:** The import process reads `.mulch/expertise/` non-recursively (top-level files only). Supported extensions: `.yaml`, `.yml`, `.json`, `.jsonl`. Subdirectories and files with unsupported extensions are skipped with a debug-level log. Symlinks are resolved and validated to remain within the project root (INV-HM3 enforces this).

  ### Schema Alignment Note

  `MulchExpertiseSchema` is the canonical schema for Hindsight bank storage. P1.12's `MulchEntry` maps as follows:

  | P1.12 MulchEntry field | MulchExpertiseSchema field | Notes |
  |------------------------|---------------------------|-------|
  | `id` | `id` | Auto-generated UUID on import |
  | `domain` | `domain` | Direct match |
  | `content` | `concepts` | `concepts` array joined with `", "` produces `content` string |
  | `source` | `source` | File path or origin |

  P1.12 (a sibling story) consumes expertise entries using `MulchEntry` and must conform to this contract.

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
  - Recall latency target: <2s exact match, <5s semantic, hard timeout 10s
  - Maximum Mulch expertise files: 100

### Bank ID Resolution (CC-6)

Bank IDs are derived from the repository slug via `resolveBankId`:

```typescript
// Resolves a repo slug to a Hindsight bank ID.
// Edge cases: all-special-char inputs (e.g. "!!!!") produce "" (empty string);
// single-character inputs produce a single lowercase char. This function does NOT
// enforce BankIdSchema — downstream validation at the P0.7 boundary rejects
// invalid IDs. Callers must handle rejection gracefully.
function resolveBankId(repoSlug: string): string {
  return repoSlug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63)
    // must match BankIdSchema: /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/
    // (enforced 1–64 chars: alphanumeric start/end, with hyphens allowed in the middle)
}
```

Example: `resolveBankId('QDS-Factory')` produces `'qds-factory'`. The three provisioned banks are:
- `{resolveBankId(repoSlug)}` — e.g. `qds-factory` (project-specific memories)
- `{resolveBankId(repoSlug)}-dev-meta` — e.g. `qds-factory-dev-meta` (development metadata)
- `qds-collective` — shared cross-project knowledge (fixed ID, not derived)

### Timeout Alignment (CC-7)

All Hindsight operation timeouts must be less than or equal to the P0.7 MCP invoke timeout (default 120s):

| Operation | Timeout | Constraint |
|-----------|---------|------------|
| Recall query | 10s | well within 120s |
| Reflect | 30s | well within 120s |
| Consolidate | 60s | well within 120s |

Consolidate timeout default (60s) is half the P0.7 invoke timeout (120s), leaving headroom for retries or sequential bank operations within a single invoke call.

### Casing Convention (CC-8)

Bank API payloads use **camelCase** at the REST boundary: `bankId` (not `bank_id`), `requestId`, `duration`, etc. Internal Hindsight storage uses snake_case. The API layer translates between conventions. The MCP bridge (P0.7, SwarmClaw) handles SwarmClaw-to-Hindsight casing translation — downstream consumers always send camelCase.

Existing schema fields in this story (e.g. `bank_id` in `RetainPayloadSchema`) represent the **Hindsight internal API** parameter names as exposed by the Hindsight MCP tool interface. The MCP bridge performs the camelCase-to-snake_case mapping when forwarding to the Hindsight REST API.

### Observability Contract (CC-9)

Every bank operation logs a structured entry:

```
{
  requestId:   string,      // propagated from P0.7 MCP bridge
  operation:   string,      // "provision" | "retain" | "recall" | "reflect" | "consolidate" | "import"
  bankId:      string,      // target bank ID
  timestamp:   string,      // ISO 8601
  duration:    number,      // ms elapsed
  status:      "ok" | "error",
  error?: { code: string, message: string, stack?: string }
}
```

Bank timing metrics (emitted on success):
- `provision_ms` — bank creation duration
- `import_ms` — single Mulch file import duration
- `recall_ms` — recall query duration
- `consolidate_ms` — consolidate operation duration
- `round_trip_ms` — full retain→recall→reflect→consolidate cycle duration

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
- **INV-HM3:** Mulch expertise file paths are resolved relative to the project root and validated to be inside `.mulch/expertise/` — symlinks are resolved and targets validated to remain within the project root; targets outside `.mulch/expertise/` or containing `..` traversal segments are rejected.
- **INV-HM4:** Tenant isolation: bank operations are scoped to the bank_id — cross-bank data leakage in recall/reflect responses is verified absent in tests (recall on bank A never returns memories from bank B).

## Definition of Done

> 8–12 high-signal, story-specific boxes. NO lint/tests/typecheck filler.

- [ ] **Impl:** Bank provisioner creates `{resolveBankId(repoSlug)}`, `{resolveBankId(repoSlug)}-dev-meta`, and `qds-collective` banks; idempotent on re-run
- [ ] **Impl:** Round-trip verifier retains a test memory, recalls it by semantic query, reflects on it, and confirms consolidation preserves it
- [ ] **Impl:** Mulch importer reads all `.mulch/expertise/*.{yaml,yml,json,jsonl}` files, parses them against `MulchExpertiseSchema` (auto-generating UUID `id` and recording `source` path), and retains each as JSONL into `{resolveBankId(repoSlug)}-dev-meta`
- [ ] **Contract:** Zod schemas for `RetainPayloadSchema`, `RecallPayloadSchema`, `ReflectPayloadSchema`, `ConsolidatePayloadSchema`, `ConsolidateResponseSchema`, `MulchExpertiseSchema` validated on all inputs
- [ ] **Integration:** Hindsight HTTP client wired to SwarmClaw MCP invoke path — all four operations (retain, recall, reflect, consolidate) exercised through the bridge
- [ ] **Security:** INV-HM1 through INV-HM4 enforced — bearer token env-only, bank_id validated, file path scoped, tenant isolation verified
- [ ] **Test (unit/integration):** Provision three banks → retain to each → recall from each → assert correct content returned per bank; import Mulch files → recall by concept → assert match
- [ ] **Test (guard):** Invalid bank_id → error surfaced; empty `.mulch/expertise/` → graceful skip with warning; malformed expertise file → parse error reported, other files still imported
- [ ] **Test (e2e demo — MANDATORY):** Run provision script → run Mulch import (YAML + JSON inputs → JSONL storage verified) → invoke retain via MCP bridge → invoke recall → invoke reflect → assert round-trip completes with correct data for all three banks
- [ ] **Test (idempotency):** Run provision + import twice → assert no duplicate memories, bank IDs unchanged, recall returns same results
- [ ] **Test (dependency failure):** Attempt bank provision with MCP bridge unavailable — verify structured error returned (AC4/AC5), no partial bank creation
