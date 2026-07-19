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

This story provisions the three required Hindsight banks (`{resolveBankId(repoSlug)}`, `{resolveBankId(repoSlug)}-dev-meta`, `qds-collective`), exercises the full memory lifecycle (retain, recall, reflect, consolidate) against each bank, and imports Mulch expertise files from `.mulch/expertise/` into the `{resolveBankId(repoSlug)}-dev-meta` bank. The Hindsight MCP server (already on PATH as `hindsight-local-mcp`) is the transport; SwarmClaw's MCP bridge (from P0.7) is the invocation path. This is a 4-point unit because it must provision three banks, validate four API operations per bank, parse and import Mulch files, and confirm the round-trip is usable by downstream agent sessions.

## E2E Slice

**Demonstrable behavior:** Create three Hindsight banks. Retain a structured memory into `{resolveBankId(repoSlug)}`, recall it by semantic query, reflect on it, and verify consolidation preserves it. Import all `.mulch/expertise/` files into `{resolveBankId(repoSlug)}-dev-meta` and recall one by concept. All operations exercised through SwarmClaw's MCP invoke endpoint (P0.7).

**Wiring closed:** On completion of this story, the three Hindsight banks exist, the retain→recall→reflect→consolidate lifecycle round-trips, and Mulch expertise is queryable via recall — using only code merged by this story and predecessor P0.7. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P0.7 (SwarmClaw MCP bridge must be registered to invoke Hindsight tools).

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given three provisioned Hindsight banks and SwarmClaw's MCP bridge to Hindsight (P0.7), When a memory is retained via `POST /api/mcp-servers/{hindsight_id}/invoke` (tool: `retain`, bank: `{resolveBankId(repoSlug)}`, content: "Sprint planning uses SPARC methodology"), then recalled via invoke (tool: `recall`, bank: `{resolveBankId(repoSlug)}`, query: "planning methodology"), then reflected via invoke (tool: `reflect`, bank: `{resolveBankId(repoSlug)}`), then consolidated via invoke (tool: `consolidate`, bank: `{resolveBankId(repoSlug)}`), Then the recall response contains the retained content, the reflect response contains a non-empty insight string, and the consolidated bank retains the core content (semantic match ≥ 0.8) with a valid `ConsolidateResponseSchema` response. (Phase 2: quantitative semantic-match enforcement; Phase 1: verified by recall relevance check — recall the original query after consolidation and confirm a relevant result is returned.)
2. Given `.mulch/expertise/` directory with at least one YAML/JSON expertise file, When the Mulch import script runs targeting the `{resolveBankId(repoSlug)}-dev-meta` bank (per the three-bank naming convention in Technical Notes), Then each expertise entry is retained as a separate memory and is recallable by its domain concepts within 5 seconds.
3. Given a bank that does not exist, When retain is called through the P0.7 MCP `/invoke` bridge with a valid but non-existent bank_id, Then Hindsight returns a non-200 response and the bridge surfaces the error as `MCPInvokeErrorResponseSchema` (`{jsonrpc:"2.0", error:{code, message, data?:{requestId}}, id}`) with HTTP 502 (Hindsight non-200 is not `-32601`/`-32602`, so P0.7 maps it to 502) — the agent never receives a false positive. This is the bridge path (surface (a) in the two-source error split); no `-3200N` code is attached. Two distinct failure paths for invalid/non-existent bank_id: (a) syntactically invalid bank_id — rejected by P0.7's `MCPInvokeArgumentsSchema` before reaching Hindsight (`-32602` → HTTP 400); (b) valid bank_id for non-existent bank — Hindsight returns non-200, bridged as HTTP 502 per this AC. AC-3 covers case (b) via the bridge; case (a) is handled by P0.7.
4. Given P0.7 MCP bridge not registered (no SwarmClaw agent for Hindsight), When the provision script is invoked, Then the provisioner exits non-zero and emits a structured error envelope `{ ok: false, error: { code: -32001, message: "MCP bridge not registered" }, requestId: <uuid> }` on its output (CLI exit code + JSON envelope; P0.9 owns no HTTP listener) without creating banks.
5. Given P0.7 MCP bridge registered but Hindsight binary not on PATH (P0.7 /test returns `{ ok: false }`), When the provision script is invoked, Then the provisioner exits non-zero and emits `{ ok: false, error: { code: -32002, message: "Hindsight binary unavailable" }, requestId: <uuid> }` on its output (CLI exit code + JSON envelope; P0.9 owns no HTTP listener) without creating banks.
6. After importing a `.mulch/expertise/` directory containing YAML and JSON files, all entries are stored as JSONL in the `{resolveBankId(repoSlug)}-dev-meta` bank.
7. Given a bank with ≤100 memories, When recall is called with a semantic query, Then results are returned within 2 seconds for exact-match queries and within 5 seconds for semantic-similarity queries. Timeout at 10s returns an error, not stale results. 2s and 5s latency targets are monitored and logged via CC-9 `recall_ms` timing. Exceeding the target emits a `slow_query: true` advisory flag. Only the 10s hard timeout produces an error response.

## Technical Notes

### P0.7 Contract Reference (hardened, merged)

This story consumes P0.7's SwarmClaw HTTP + MCP bridge. The following are CANONICAL as-merged contracts this story must not contradict:
- **Body cap:** `MAX_BODY_BYTES = 1_048_576` (1 MB), enforced on content-length AND chunked read; over-cap → HTTP 413 `{error:"payload too large"}` + `connection: close`, BEFORE route handlers run (`src/swarmclaw/index.ts`).
- **requestId:** UUID-strict `x-request-id` header (regen on invalid), propagated via `_meta.requestId` on tools/call, echoed on every response incl. 413/404/500.
- **invoke error shape:** `MCPInvokeErrorResponseSchema = {jsonrpc:"2.0", error:{code:number, message:string, data?:{field?,violation?,requestId:string}}, id}`. HTTP map: `-32601` (unknown tool) / `-32602` (invalid params) → 400; everything else → 502. (`-32603` = internal/transport.)
- **invoke timeout:** default 120 s, clamped [60 s, 3600 s] (`SWARMCLAW_INVOKE_TIMEOUT_MS`).
- **shutdown:** listener stopped first (`server.stop(true)`), then `shutdownAll`, 12 s force-exit watchdog; in-flight registrations killable.

### Wave 1 Reuse Mandate

P0.9 reuses the following P0.7 primitives rather than re-implementing them:
- **`MCPInvokeErrorResponseSchema`** — every error returned FROM the MCP `/invoke` bridge (P0.7 `tool-bridge.ts`) uses this shape verbatim. P0.9 does NOT invent a parallel bridge-error shape.
- **`maskEnv`** — P0.7's all-values-masked env redactor is reused for any env diagnostic the Hindsight client logs (INV-HM1). Do not write a bespoke redactor.
- **Tool-bridge retry + re-enumeration** — P0.7 retries once on `-32601` after cache invalidation + schema re-validation (`tool-bridge.ts`). P0.9 tests must assert the FINAL error code and must not assume a single tools/call dispatch.
- **P0.1 redaction discipline** — `src/hindsight/client.ts` follows the same defensive-parse + redaction rules established in P0.1 (treat every response body as `unknown`, narrow before field access, no raw env in logs).

### Two-source error split (CC-W3)

P0.9 has two distinct error surfaces that MUST NOT be conflated:

(a) **Errors FROM the MCP `/invoke` bridge** (P0.7) — shaped verbatim per `MCPInvokeErrorResponseSchema` (`{jsonrpc:"2.0", error:{code,message,data?}, id}`). These surface when the Hindsight MCP tool itself fails or when `MCPInvokeArgumentsSchema` rejects a syntactically invalid bank_id. Cite P0.7 `tool-bridge.ts`. HTTP map per P0.7: `-32601`/`-32602` → 400, else → 502.

(b) **Errors from P0.9's own provisioner/importer** (codes `-32001..-32005`) — these are APPLICATION-LAYER codes returned directly as `{ok:false, error:{code, message}, requestId}` (NOT through `/invoke`, NOT shaped as `MCPInvokeErrorResponseSchema`). They surface from `bank-provisioner.ts`, `mulch-importer.ts`, and `client.ts` when the Hindsight binary is missing, bank ID validation fails locally, or provisioning hits a fatal collision. **P0.9 owns no HTTP listener.** `-32001..-32005` surface as CLI exit codes (non-zero) plus the structured envelope `{ok:false, error:{code, message}, requestId}` on the provisioner/importer script output (stderr / JSON stdout), NOT as HTTP statuses. The only HTTP surface for Hindsight operations is P0.7's `/invoke` bridge (surface (a) above), which uses `MCPInvokeErrorResponseSchema` (`-32601`/`-32602` → 400, else → 502).

AC-3/AC-4/AC-5 are reframed accordingly: "the provisioner/importer returns" (NOT "the MCP bridge surfaces").

- **Schema naming convention:** Schemas in Technical Notes use Hindsight internal parameter names (snake_case). The MCP bridge (P0.7) translates to camelCase at the REST boundary. Implementers should use internal names for MCP tool calls and camelCase for REST API payloads. ConsolidateResponseSchema is an exception — its fields are already camelCase because it is a response schema returned directly to REST consumers, not an internal Hindsight parameter.

- **Contracts/Schema:**
  ```typescript
  // Hindsight bank creation (via MCP invoke — retain to non-existent bank creates it)
  // OR explicit bank provisioning via Hindsight REST API
  const BankIdSchema = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/);

  // Retain payload
  const RetainPayloadSchema = z.object({
    bank_id: BankIdSchema,
    content: z.string().min(1).refine(v => Buffer.byteLength(v, 'utf8') <= 102400, { message: 'Content exceeds 100KB byte limit' }),
    metadata: z.object({
      source: z.enum(["agent", "mulch-import", "manual", "consolidate"]),
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
  // reflect may be called with just bank_id and no query. In this case, Hindsight generates
  // insights from the bank's full contents without query filtering.

  // Reflect response
  // P0.9-S-M2: bankId (camelCase) for consistency with ConsolidateResponseSchema
  // and the CC-8 camelCase-native response convention.
  const ReflectResponseSchema = z.object({
    bankId: z.string(),
    insights: z.array(z.object({
      summary: z.string().min(1),
      relatedMemories: z.number().int().min(0).optional(),
    })).min(1),
    durationMs: z.number(),
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
  // Field names follow Hindsight internal convention. The MCP bridge (P0.7) translates
  // to camelCase at the REST boundary per CC-8.
  const ConsolidateResponseSchema = z.object({
    consolidatedCount: z.number(),
    preservedCount: z.number(),
    durationMs: z.number(),
  });

  // Retain response
  // P0.9-V-M4: bankId (camelCase) per CC-8 response-schema convention;
  // RetainResponseSchema is a response returned directly to REST consumers.
  const RetainResponseSchema = z.object({
    memoryId: z.string(),
    bankId: BankIdSchema,
    status: z.enum(["created", "updated"]),
    durationMs: z.number(),
  });

  // Recall response
  const RecallResponseSchema = z.object({
    results: z.array(z.object({
      content: z.string(),
      score: z.number().min(0).max(1),
      memoryId: z.string(),
    })),
    durationMs: z.number(),
  });

  // Mulch expertise entry (canonical storage = JSONL, one object per line)
  const MulchExpertiseSchema = z.object({
    id: z.string().uuid().optional(),  // When absent, the importer auto-generates a UUID before storage. When present, it must be a valid UUID.
    domain: z.string(),
    concepts: z.array(z.string()),
    expertise: z.string(),
    source: z.string().optional(),   // file path or origin of the expertise entry
    confidence: z.number().min(0).max(1).optional(),  // float in [0,1] representing the Mulch importer's assessment of entry quality based on source reliability and field completeness. Informational only — consumers should not use it for filtering.
  });
  ```

  ### Mulch Storage Format Contract

  Expertise entries are stored as **JSONL** (one JSON object per line) in the `{resolveBankId(repoSlug)}-dev-meta` bank. Each line is a valid JSON object conforming to `MulchExpertiseSchema`. Line delimiter: `\n` (LF only). Character encoding: UTF-8 without BOM. Import parser must strip UTF-8 BOM (`EF BB BF`) from the first line of any input file before parsing.

  **Input format support:** Input files may be YAML (`.yml`/`.yaml`), JSON (`.json`), or JSONL (`.jsonl`). The import flow converts all formats to JSONL for storage. YAML and JSON files are parsed as arrays of expertise objects; each element becomes one JSONL line. JSONL files are read line-by-line.

  **Import flow:** Read `.mulch/expertise/` files, parse each file according to its extension (YAML → array, JSON → array, JSONL → line-by-line), validate each entry against `MulchExpertiseSchema` (with `id` auto-generated as UUID if absent), and retain as JSONL into the `{resolveBankId(repoSlug)}-dev-meta` bank.

**Dedup key canonical form:** Mulch import deduplicates by hashing a collision-safe JSON serialization of `{ "domain": domain, "concepts": sorted(concepts) }`. Both the domain and each concept element are normalized to NFC (Unicode Normalization Form C) before sorting and serialization to ensure that semantically identical strings in different normalization forms (e.g., `café` NFC vs NFD) produce the same hash. The concepts array is sorted alphabetically before serialization to ensure order-independent matching. Using JSON serialization (rather than delimiter concatenation) prevents hash collisions where a domain containing the delimiter character could produce the same key as a differently-structured entry. Re-importing an expertise entry with the same domain and same concept set (in any order) updates the existing entry rather than creating a duplicate. The hash is computed as `SHA-256(JSON.stringify({ domain: domain.normalize('NFC'), concepts: sorted_concepts.map(c => c.normalize('NFC')) }))`.

**Intentional scope of dedup:** Dedup is by domain+concepts identity. Two entries with the same domain and concepts but different `expertise` text are considered updates of the same expertise area. Re-import replaces the earlier entry. The `expertise` field is excluded from the hash deliberately — it is the mutable payload that updates represent.

**Partial failure handling:** Mulch import is best-effort per-entry. If one file fails to parse or validate, remaining files are still imported. The import response includes per-entry status: `{ totalFiles, importedFiles, failures: Array<{ file: string, entryIndex?: number, error: string }> }`. The `entryIndex` field is present when the failure is for a specific entry within a multi-entry file (e.g. JSONL line 3 or YAML array element 5); absent when the entire file failed to parse. If a single file contains multiple entries, valid entries are imported and invalid entries are reported individually with their `entryIndex`. Empty `.mulch/expertise/` directory is a graceful skip with a warning log, not an error.

**Directory traversal rules:** The import process reads `.mulch/expertise/` non-recursively (top-level files only). Supported extensions: `.yaml`, `.yml`, `.json`, `.jsonl`. Subdirectories and files with unsupported extensions are skipped with a debug-level log. Symlinks are resolved and validated to remain within the project root (INV-HM3 enforces this).

**Concurrency:** Concurrent Mulch import is not supported in Phase 1. The import script runs as a single process. Concurrent import is a Phase 2 concern.

  ### Schema Alignment Note

  `MulchExpertiseSchema` is the canonical schema for Hindsight bank storage. P1.12's `MulchEntry` maps as follows:

  | MulchExpertiseSchema field | P1.12 MulchEntry field | Notes |
 ----------------------------|------------------------|-------|
  | `id` | `id` | Auto-generated UUID on import |
  | `domain` | `domain` | Direct match |
  | `expertise` | `content` | Full expertise text becomes the `content` string |
  | `concepts` | `tags` | Concepts array maps to `tags` array |
  | `source` | `source` | File path or origin |

  This mapping is lossy. P1.12 must consume the canonical `MulchExpertiseSchema` directly, not the simplified `MulchEntry`, to preserve full fidelity. When P1.12 reads from the Hindsight bank, it must parse stored JSONL against `MulchExpertiseSchema` rather than relying on the reduced `MulchEntry` projection. This mapping is provisional until P1.12 is reviewed. The canonical source is always MulchExpertiseSchema in this story (P0.9).

  ### Mulch Priming Consumer Contract

  Mulch priming consumers (e.g., P1.6) should:
  1. Recall from the `{resolveBankId(repoSlug)}-dev-meta` bank with a query matching the task brief.
  2. Rank recalled entries by recall `score` (the recall relevance score returned by Hindsight). The Mulch `confidence` field is metadata only — do NOT rank, filter, or gate on it.
  3. Use the top-k results (k from the `limit` parameter, default 5) to build a context preamble.
  4. Each recalled entry's `expertise` field becomes a context bullet. `domain` and `concepts` are used for relevance ranking.
  5. If recall returns 0 results, the Pi team runs without primed context (mulchPrimed: false).

  ### Error Code Taxonomy

  These are PROVISIONER-INTERNAL application codes (surface (b) in the two-source split above). They are returned directly as `{ok:false, error:{code, message}, requestId}` from P0.9's provisioner/importer — NOT through the MCP `/invoke` bridge and NOT shaped as `MCPInvokeErrorResponseSchema`. Errors from the MCP bridge itself (surface (a)) use P0.7's canonical invoke-error shape. **P0.9 owns no HTTP listener.** These codes surface as CLI exit codes (non-zero) plus the structured envelope on the provisioner/importer script output; the `Surface` column below names where each code is observable.

  | Code   | Meaning                          | Surface | Used by        |
  |--------|----------------------------------|---------|----------------|
  | -32001 | MCP bridge not registered        | provisioner script (CLI exit code + `{ok:false,error:{code,message},requestId}` on stderr/JSON output) | AC-4 (provisioner) |
  | -32002 | Hindsight binary unavailable     | provisioner script (CLI exit code + `{ok:false,error:{code,message},requestId}` on stderr/JSON output) | AC-5 (provisioner) |
  | -32003 | Bank ID validation failed        | provisioner script (CLI exit code + `{ok:false,error:{code,message},requestId}` on stderr/JSON output) | INV-HM2 guard (provisioner) |
  | -32004 | Mulch file count exceeded (100-file quota); script exits non-zero with `{ok:false,error:{code:-32004,message:"File count exceeds maximum (100)"},requestId}` + `filesProcessed:100` | provisioner script (CLI exit code + structured envelope on stderr/JSON output) | 100-file limit (importer) |
  | -32005 | Bank provisioning failed / collision unresolvable | provisioner script (CLI exit code + `{ok:false,error:{code,message},requestId}` on stderr/JSON output) | provisioner (INV-HM6) |
  | —      | (bridge path) Hindsight MCP tool failure / invalid args | `MCPInvokeErrorResponseSchema` (HTTP via P0.7: `-32601`/`-32602` → 400, else → 502) | AC-3 (P0.7 `/invoke` bridge) |

  Note: -32001..-32005 are defined here; -32006..-32009 are reserved for future P0.9 surfaces (undefined in Phase 0). The P0.9 range is distinct from P1.1 (-32010..-32013) and P1.3 (-32014..-32017).

- **Integration points (each wired & exercised in this story):**
  - Hindsight REST API `/v1/default/banks/{bank_id}/memories` — retain (POST)
  - Hindsight REST API `/v1/default/recall` — recall (POST)
  - Hindsight REST API `/v1/default/reflect` — reflect (POST)
  - Hindsight REST API `/v1/default/consolidate` — consolidate (POST)
  - SwarmClaw MCP invoke bridge (P0.7) — tool invocation path
  - `.mulch/expertise/` directory — file read and parse
  - Mulch CLI (`/usr/local/bin/mulch` v0.6.3) — expertise extraction if needed. If the Mulch CLI reports a version != 0.6.x, log a warning. Import proceeds assuming backward compatibility.

- **Files / functions touched:**
  - `src/hindsight/bank-provisioner.ts` — creates three banks. Downstream stories should use `resolveBankId(repoSlug)` for bank naming, not the raw `{repo}` token. If a story references `{repo}` directly, it should be updated to use resolveBankId for consistency with the canonical bank provisioning contract. Before provisioning, verify the resolved bank ID does not collide with the fixed `qds-collective` ID. If a collision is detected, loop up to 10 suffixes (`-2`..`-11`); if all collide, fail `{ok:false, error:{code:-32005, message:"bank_id_collision_unresolvable"}, requestId}` (CLI exit code + structured envelope on script output).
  - `src/hindsight/round-trip-verifier.ts` — retain→recall→reflect→consolidate validation
  - `src/hindsight/mulch-importer.ts` — reads `.mulch/expertise/` and retains into `{resolveBankId(repoSlug)}-dev-meta`
  - `src/hindsight/client.ts` — HTTP client wrapper for Hindsight API
  - `scripts/provision-hindsight-banks.ts` — CLI script for bank provisioning
  - `scripts/import-mulch-expertise.ts` — CLI script for Mulch import

- **Guards/limits:**
  - Bank creation idempotent — re-provisioning existing bank returns existing bank_id
  - Before creating a bank, validate the resolved bank ID against BankIdSchema. If validation fails (empty string from all-special-char input like `"!!!!"`, pattern mismatch), return `{ ok: false, error: { code: -32003, message: 'Invalid bank ID derived from repo slug' }, requestId }` (CLI exit code + structured envelope on script output) without calling Hindsight. The provisioner must call `BankIdSchema.safeParse(result)` on the `resolveBankId` return value and short-circuit on failure — this catches the edge case where `resolveBankId("!!!!")` yields `""` which does not match the schema pattern.
  - Mulch import idempotent — re-importing same expertise updates rather than duplicates (dedup by domain+concepts hash)
  - Retain payload max size: 100 KB per memory entry
  - Recall query timeout: 10 seconds
  - Reflect timeout: 30 seconds
  - Consolidate timeout: 60 seconds
  - Recall latency target: <2s exact match, <5s semantic, hard timeout 10s
  - Maximum Mulch expertise files: 100. If the number of supported expertise files (`.yaml`, `.yml`, `.json`, `.jsonl`) exceeds 100, the import exits non-zero and emits `{ ok: false, error: { code: -32004, message: 'File count exceeds maximum (100)' }, requestId, filesProcessed: 100 }` (CLI exit code + structured envelope on script output).
  - **Per-file size cap (P0.9-S-H1):** 5 MB per expertise file. Files >5 MB are reported in `failures[]` with `error:"file_too_large"` and import continues with remaining files (best-effort, mirrors per-entry partial-failure policy).
  - **Per-entry content cap:** `MulchExpertiseSchema.expertise` content ≤100 KB, enforced by reusing `RetainPayloadSchema`'s content-byte-limit refine (102400 bytes).

### Bank ID Resolution (CC-6)

Bank IDs are derived from the repository slug via `resolveBankId`:

```typescript
// Resolves a repo slug to a Hindsight bank ID.
// Edge cases: all-special-char inputs (e.g. "!!!!") produce "" (empty string);
// single-character inputs produce a single lowercase char. This function does NOT
// enforce BankIdSchema — downstream validation at the P0.7 boundary rejects
// invalid IDs. Callers must handle rejection gracefully.
function resolveBankId(repoSlug: string): string {
  let result = repoSlug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 64);
  // Loop to strip leading/trailing hyphens, including those reintroduced by truncation
  while (result.startsWith('-') || result.endsWith('-')) result = result.replace(/^-|-$/g, '');
  // must match BankIdSchema: /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/
  // (enforced 1–64 chars: alphanumeric start/end, with hyphens allowed in the middle)
  return result;
}

// resolveBankId is collision-prone for repo slugs that share a common 64-char prefix.
// Callers must supply known-unique repo slugs. If collision is detected at provisioning
// time, append a numeric disambiguation suffix (e.g., `-2`).

// Single-character bank IDs are valid per BankIdSchema. If a minimum length is desired
// for operational clarity, enforce at the resolveBankId caller level.
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

The 10s recall hard timeout is enforced at the Hindsight client level, before the request reaches P0.7's MCP invoke layer. P0.7's 120s timeout is a transport-level safety net that should never be hit for well-behaved recall operations.

**Retry note (P0.9-H2):** The P0.7 bridge retries once on `-32601` after cache invalidation + schema re-validation (`tool-bridge.ts`). P0.9 tests must assert the FINAL error code returned to the caller, not the first, and must NOT assume a single tools/call dispatch — a transient `-32601` that clears on retry is a success path, not a failure.

### Casing Convention (CC-8)

Bank API payloads use **camelCase** at the REST boundary: `bankId` (not `bank_id`), `requestId`, `duration`, etc. Internal Hindsight storage uses snake_case. The API layer translates between conventions. The MCP bridge (P0.7, SwarmClaw) handles SwarmClaw-to-Hindsight casing translation — downstream consumers always send camelCase.

Existing schema fields in this story (e.g. `bank_id` in `RetainPayloadSchema`) represent the **Hindsight internal API** parameter names as exposed by the Hindsight MCP tool interface. The MCP bridge performs the camelCase-to-snake_case mapping when forwarding to the Hindsight REST API.

Exception: ConsolidateResponseSchema, RetainResponseSchema, RecallResponseSchema, and ReflectResponseSchema use camelCase natively (see Technical Notes). All other schemas use Hindsight internal snake_case. (P0.9-S-M2: `ReflectResponseSchema.bankId` renamed from `bank_id` to match this convention.)

### Single-flight Provisioning (CC-10)

Provision is single-flight — an advisory file lock at `~/.hindsight/provision.lock` serializes bank creation. A concurrent provision either blocks until the lock releases or the second invocation exits non-zero and emits `{ ok: false, error: { message: "provision_in_progress" }, requestId }` (configurable; CLI exit code + structured envelope on script output — P0.9 owns no HTTP listener, so there is no 409 status). Import dedup relies on retain idempotency (best-effort); if two imports overlap, a warning is logged and the second import's retain calls are deduplicated by domain+concepts hash.

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

- **INV-HM1:** Hindsight API auth token (if configured via `HINDSIGHT_BEARER_TOKEN` env var) is read from environment only — never hardcoded, never logged, never included in test output. Consistent with P0.7 `maskEnv` which masks ALL env values to `***`; the Hindsight client applies the same all-values-masked policy to any env diagnostic it logs (no bespoke redactor).
- **INV-HM5:** `src/hindsight/client.ts` treats every Hindsight response body as `unknown`; narrows via Zod/guards before field access; non-object bodies (string/number/array) are stringified into `error.message`. All `setTimeout`/`AbortController` timers are cleared in a `finally` block. This mirrors PR #34's `stdio-transport.ts` defensive frame handling (CC-W4).
- **INV-HM6:** Provision is single-flight — advisory file lock on `~/.hindsight/provision.lock`; concurrent provision blocks or the second invocation exits non-zero and emits `{ ok: false, error: { message: "provision_in_progress" }, requestId }` (CLI exit code + structured envelope; P0.9 owns no HTTP listener, so no 409). Import dedup relies on retain idempotency (best-effort); a warning is logged if two imports overlap.
- **INV-HM2:** Bank IDs are validated against `BankIdSchema` before any API call — path injection via crafted bank_id (e.g., `../../etc/passwd`) is rejected at the provisioner with envelope code `-32003` (CLI exit code + `{ok:false, error:{code:-32003, message}, requestId}`). A syntactically invalid bank_id that reaches the P0.7 MCP `/invoke` bridge is rejected by `MCPInvokeArgumentsSchema` as `-32602` → HTTP 400 (P0.7's surface).
- **INV-HM3:** Mulch expertise file paths are resolved relative to the project root and validated to be inside `.mulch/expertise/` — symlinks are resolved and targets validated to remain within the project root; targets outside `.mulch/expertise/` or containing `..` traversal segments are rejected. Symlink resolution behavior differs between Unix (follows symlinks via realpath) and Windows (may not resolve). The import script uses Node.js `fs.realpathSync` for consistent cross-platform behavior.
- **INV-HM4:** Tenant isolation is verified by: (1) retaining a unique marker memory into bank A, (2) recalling from bank B with a query matching the marker, (3) asserting the marker does not appear in bank B's results. This test must pass regardless of Hindsight's internal implementation.

## Definition of Done

> 8–12 high-signal, story-specific boxes. NO lint/tests/typecheck filler.

- [ ] **Impl:** Bank provisioner creates `{resolveBankId(repoSlug)}`, `{resolveBankId(repoSlug)}-dev-meta`, and `qds-collective` banks; idempotent on re-run
- [ ] **Impl:** Round-trip verifier retains a test memory, recalls it by semantic query, reflects on it, and confirms consolidation preserves it
- [ ] **Impl:** Mulch importer reads all `.mulch/expertise/*.{yaml,yml,json,jsonl}` files, parses them against `MulchExpertiseSchema` (auto-generating UUID `id` and recording `source` path), and retains each as JSONL into `{resolveBankId(repoSlug)}-dev-meta`
- [ ] **Contract:** Zod schemas for `RetainPayloadSchema`, `RecallPayloadSchema`, `ReflectPayloadSchema`, `ConsolidatePayloadSchema`, `ConsolidateResponseSchema`, `ReflectResponseSchema`, `RetainResponseSchema`, `RecallResponseSchema`, `MulchExpertiseSchema` validated on all inputs
- [ ] **Integration:** Hindsight HTTP client wired to SwarmClaw MCP invoke path — all four operations (retain, recall, reflect, consolidate) exercised through the bridge
- [ ] **Security:** INV-HM1 through INV-HM6 enforced — bearer token env-only (P0.7 `maskEnv` policy), bank_id validated, file path scoped, tenant isolation verified, `client.ts` defensive-parse (PR #34 pattern), provision single-flight
- [ ] **Test (unit/integration):** Provision three banks → retain to each → recall from each → assert correct content returned per bank; import Mulch files → recall by concept → assert match
- [ ] **Test (guard):** Invalid bank_id → error surfaced; empty `.mulch/expertise/` → graceful skip with warning; malformed expertise file → parse error reported, other files still imported
- [ ] **Test (e2e demo — MANDATORY):** Run provision script → run Mulch import (YAML + JSON inputs → JSONL storage verified) → invoke retain via MCP bridge → invoke recall → invoke reflect → assert round-trip completes with correct data for all three banks
- [ ] **Test (idempotency):** Run provision + import twice → assert bank IDs unchanged, Mulch entry count unchanged (no duplicates), and recall with exact-match query returns same result set (content comparison, not score comparison)
- [ ] **Test (dependency failure):** Attempt bank provision with MCP bridge unavailable — verify structured error returned (AC4/AC5), no partial bank creation
