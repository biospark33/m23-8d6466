# P0.9 Research Brief — Wave 1 conclusions for Wave 2 implementers

Story: `_bmad-output/sprint-artifacts/phase-0/stories/p0-9-hindsight-banks-mulch.md`
Branch: `feature/p0-9-hindsight-banks-mulch` (cut from main)
PR target: `main` (trunk-based). Convention sentinel written to CLAUDE.md.

## Stack (verified)
- Bun + TypeScript. `tsconfig`: `strict: true`, `noUncheckedIndexedAccess: true`, `module ESNext`, `moduleResolution bundler`, no path aliases (relative imports).
- Test runner: `bun test` (Bun default `**/*.test.ts`). Import from `"bun:test"`.
- Zod **v3.24** (`^3.24.0`). USE V3 SYNTAX: `.optional()`, `.default()`, `.refine({message})` (NOT `error:`). `safeParse` returns `{success,data?,error?}`.
- Biome `^1.9.4`: `noExplicitAny: off`, `noNonNullAssertion: off`, formatter OFF. `any` allowed.
- `yaml` package = **eemeli/yaml** (already in node_modules). `import { parse } from "yaml"` → throws YAMLParseError; wrap try/catch, feed `unknown` to Zod. NOT js-yaml.
- Only runtime dep is `zod`. No HTTP lib — use global `fetch`.

## P0.7 reusable surface (import, do NOT reimplement)
- `MCPInvokeErrorResponseSchema`, `maskEnv`, `MCPInvokeArgumentsSchema` → `src/swarmclaw/mcp/tool-bridge.ts`.
  - `maskEnv(env?): Record<string,string>` masks ALL values to `***`.
  - `MCPInvokeArgumentsSchema` validates bank_id (regex `/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/`) → `-32602` on violation.
- Logger: `log(entry)`, `setLogSink(fn)`, `newRequestId()` (= crypto.randomUUID()), `LogEntry` → `src/swarmclaw/mcp/stdio-transport.ts`. Import `{ log, setLogSink, newRequestId, type LogEntry }`.
- `/invoke` route: `handleInvokeMCPServer(store, id, payload, requestId?)` → `src/swarmclaw/routes/mcp-servers.ts`. HTTP map: `-32601`/`-32602`→400, else→502. Request `{tool, arguments}`, response `{jsonrpc:"2.0",result,id}`.
- Registration: `handleRegisterMCPServer(store, payload, requestId?, transportFactory?)` + `RegisterMCPServerSchema` (`{name, transport:"stdio", command, args?, env?}`) → `routes/mcp-servers.ts` + `store/mcp-store.ts`.
- Test harness: `new MCPStore()`, `handleRegisterMCPServer(..., fakeFactory())`, `handleTestMCPServer`, `handleInvokeMCPServer`. `fakeFactory` returns a `TransportFactory` running a bun fixture script. See `tests/swarmclaw/agent-mcp-registration.test.ts` + `tests/swarmclaw/fixtures/fake-mcp-server.ts`.

## CRITICAL: Hindsight is NOT reachable end-to-end on this host
- `hindsight-local-mcp` stdio: broken (missing `HINDSIGHT_API_LLM_API_KEY` + x86_64 psycopg2 on arm64).
- Docker Hindsight on `127.0.0.1:8888`: `/health` ok but tenant API auth returns 401.
- → **All P0.9 tests MUST mock the transport.** No test may depend on a live Hindsight.
  - `client.ts` unit tests: mock global `fetch`.
  - bridge-path integration test (AC-1): drive SwarmClaw's REAL `/invoke` route against a NEW fake MCP fixture `tests/swarmclaw/fixtures/fake-hindsight-mcp.ts` that implements in-memory `retain`/`recall`/`reflect`/`consolidate` tools. Deterministic, CI-safe.

## CRITICAL: Story endpoint paths are WRONG — use bank-scoped REST
Story lists flat paths (`/v1/default/recall`). Real Hindsight OpenAPI (`~/.claude/skills/hindsight-docs/references/openapi.json`) is **bank-scoped**. `client.ts` MUST use:
- create bank: `PUT /v1/default/banks/{bank_id}` (idempotent upsert, bank_id in path); list: `GET /v1/default/banks` (idempotency check). (Corrected from POST via /hindsight-docs OpenAPI.)
- retain: `POST /v1/default/banks/{bank_id}/memories` body `{items:[{content, metadata?}]}`.
- recall: `POST /v1/default/banks/{bank_id}/memories/recall` body `{query, limit}`.
- reflect: `POST /v1/default/banks/{bank_id}/reflect` body `{query?}`.
- consolidate: `POST /v1/default/banks/{bank_id}/consolidate` body `{options?}`.
- Auth header: `Authorization: Bearer <HINDSIGHT_API_KEY>` from `HINDSIGHT_API_KEY` env (read env-only, INV-HM1; if unset, send no auth header). (Corrected from X-API-Key via /hindsight-docs OpenAPI; Wave 2a client.ts already implements Bearer.)
- This is a deliberate, documented deviation (story paths 404). Note in code comment + commit.

## Architecture (locked)
- `client.ts` = HindsightClient, direct REST (bank-scoped). Used by provisioner + importer + verifier.
- AC-1 "through the bridge" = integration test calls SwarmClaw `/invoke` with the 4 tools against fake-hindsight-mcp fixture. NOT client.ts internals.
- Two-source error split (story CC-W3): (a) bridge errors = `MCPInvokeErrorResponseSchema` (P0.7); (b) provisioner/importer errors = `-32001..-32005` as `{ok:false,error:{code,message},requestId}` CLI envelope + non-zero exit. P0.9 owns NO HTTP listener.

## Error code taxonomy (provisioner/importer, surface b)
-32001 MCP bridge not registered | -32002 Hindsight binary unavailable | -32003 Bank ID validation failed | -32004 Mulch file count >100 | -32005 bank_id_collision_unresolvable. Exit non-zero + JSON envelope on script output.

## File plan (≤10 unique paths per story "Files to Modify")
Impl:
- `src/hindsight/schemas.ts` — BankIdSchema, resolveBankId, RetainPayloadSchema, RecallPayloadSchema, ReflectPayloadSchema, ConsolidatePayloadSchema, ConsolidateResponseSchema, ReflectResponseSchema, RetainResponseSchema, RecallResponseSchema, MulchExpertiseSchema, error code consts, types.
- `src/hindsight/client.ts` — HindsightClient (fetch wrapper, defensive parse INV-HM5, timeouts, AbortController in finally, maskEnv on env logs INV-HM1).
- `src/hindsight/bank-provisioner.ts` — 3 banks, idempotent, BankIdSchema safeParse (-32003), collision loop -2..-11 (-32005), single-flight lock ~/.hindsight/provision.lock (INV-HM6), bridge-registered check (-32001), hindsight-available check (-32002).
- `src/hindsight/mulch-importer.ts` — non-recursive read .mulch/expertise, yaml/json/jsonl parse, MulchExpertiseSchema validate (auto UUID id, source path), dedup SHA-256(domain + NFC-sorted concepts), retain JSONL into -dev-meta, per-entry partial failure, 100-file quota (-32004), 5MB/file cap, BOM strip, symlink realpath (INV-HM3), tenant isolation (INV-HM4).
- `src/hindsight/round-trip-verifier.ts` — retain→recall→reflect→consolidate via client.ts.
- `src/hindsight/index.ts` — re-exports public API.
- `scripts/provision-hindsight-banks.ts` — CLI `#!/usr/bin/env bun`, JSON envelope, exit codes (AC4/AC5).
- `scripts/import-mulch-expertise.ts` — CLI, JSON envelope.
Tests:
- `tests/hindsight/bank-provisioning.test.ts`
- `tests/hindsight/memory-round-trip.test.ts`
- `tests/hindsight/mulch-import.test.ts`
- `tests/hindsight/client.test.ts`
- `tests/swarmclaw/fixtures/fake-hindsight-mcp.ts` (in-memory bank impl of the 4 MCP tools; also exercises bank creation).
- `tests/hindsight/bridge-round-trip.test.ts` (AC-1: SwarmClaw /invoke → fake-hindsight fixture).
Seed:
- `.mulch/expertise/qds-foundations.yaml`, `.mulch/expertise/swarmclaw.json` (real QDS domain expertise; consumed by importer + act as live seed).

## Naming / casing (story CC-8)
- Payloads to Hindsight internal API = snake_case (`bank_id`). REST-boundary responses (Retain/Recall/Reflect/Consolidate ResponseSchema) = camelCase (`bankId`, `memoryId`, `durationMs`).
- Bank IDs from `resolveBankId(repoSlug)`: lowercase, `[^a-z0-9]+`→`-`, slice 64, strip leading/trailing `-` in loop. Example: `QDS-Factory`→`qds-factory`. Three banks: `qds-factory`, `qds-factory-dev-meta`, `qds-collective` (fixed).

## Timeouts (story CC-7)
recall 10s | reflect 30s | consolidate 60s. All ≤ P0.7 invoke 120s. AbortController, cleared in finally.

## Observability (story CC-9)
Every op logs structured `{requestId, operation, bankId, timestamp, duration, status, error?}` via `log()`. Timing metrics: provision_ms, import_ms, recall_ms, consolidate_ms, round_trip_ms. recall latency: slow_query advisory flag if >target; 10s hard timeout → error.

## TDD discipline
Test-first per feature file. Each impl agent owns its file + its unit test. Mock fetch (save/assign/restore in afterEach) for client paths; tmp dirs for mulch import fixtures; setLogSink for log assertions.
