# P1.11: qds-hindsight-prime Recall + Post-Run Retain Wiring

**Story Points:** 4

## Spec Reference

- PRD §3.4, §5.2; FR-MG-6, FR-MG-7, FR-MEM-2

## User Story

As a dev manager,
I want protocol steps to recall relevant memory before execution and retain learnings after,
so that each run benefits from accumulated experience and contributes back to collective knowledge.

## Overview

Before a protocol step executes, the phase executor primes the Pi agent context by recalling relevant entries from Hindsight banks through the sanctioned `src/hindsight/client.ts` HTTP boundary (P0.9, DEFAULT_BASE_URL http://127.0.0.1:8888). Banks are `{repo}` (codebase-specific), `{repo}-dev-meta` (development patterns), and `qds-collective` (cross-project learnings). After the step completes, the run's learnings (what worked, what failed, decisions made) are retained back to the appropriate Hindsight bank via the same client. This forms the L2 memory loop: recall → execute → retain. P1.11 EXTENDS `src/hindsight/` — no parallel client is introduced.

## E2E Slice

**Demonstrable behavior:** A protocol step for issue #42 starts. The phase executor calls `HindsightClient.recall()` with a requestId-propagated request carrying context from the issue body and prior run history. Relevant entries from **all three** AC1 banks — `{repo}`, `{repo}-dev-meta`, and `qds-collective` — are injected into the Pi agent context (P1.11-R5-1: an earlier draft of this line listed only two, so the E2E could pass with `{repo}-dev-meta` never queried while AC1 required it). After the step executes and produces output, the phase executor invokes `HindsightClient.retain()` on the same client to retain the step's learnings. The full recall → execute → retain loop completes on the real run.

**Wiring closed:** On completion of this story, the memory loop (recall → execute → retain) completes on a real protocol step using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P0.9, P1.6

## Acceptance Criteria

1. **(make-or-break)** Given a protocol step is about to execute for an issue, When the phase executor primes the agent context, Then it calls `HindsightClient.recall()` (sanctioned `src/hindsight/client.ts` HTTP boundary) with the issue context and a propagated `requestId` (UUID v4 strict, carried in the `x-request-id` header — the sole carrier on Hindsight REST ops, P1.11-R5-4), and receives a `RecallResponse` (`{results:[{content,score,memoryId}],durationMs}` per P0.9 `RecallResponseSchema`) from `{repo}`, `{repo}-dev-meta`, and `qds-collective` banks; these entries are injected into the Pi agent's working context.
2. Given a protocol step has completed successfully, When the phase executor retains learnings, Then it invokes `HindsightClient.retain()` with a `RetainPayload` whose `metadata = {source, kind?, tags?}` per P0.9 `RetainPayloadSchema` (issueId/runId/stepId carried in `tags[]`), and the entry is persisted to the appropriate bank, returning a `RetainResponse` (`{memoryId,bankId,status,durationMs}` per P0.9 `RetainResponseSchema`).
3. Given the Hindsight HTTP API is unreachable (gate clause 7 fail / OQ-4 BLOCKED-on-env), When a recall is attempted, Then the step proceeds without primed context in recorded/mock mode, a `waiver.reason: 'hindsight-unavailable'` is logged with the propagated `requestId`, and the retain step is skipped (no partial writes).
4. Given a recall returns results, When they are injected into the agent context, Then each result exposes its P0.9 canonical fields (`content`, `score`, `memoryId`) so the agent can assess relevance.
5. **(env-fallback)** Any AC above requiring a live Hindsight round-trip MUST also pass in recorded/mock mode (fixture replay when `HINDSIGHT_BASE_URL` is unset or unreachable) — no AC fails purely because the local Hindsight API is down. Mock mode is selected when `HindsightClient` is constructed with `mode: 'mock'` (shipped P0.9 follow-up 2026-07-27: `HindsightClientOptions.mode?: 'live' | 'mock'` short-circuits every request to a schema-valid canned body — see `src/hindsight/client.ts` + `tests/hindsight/client.test.ts` "mock mode"); a startup health-check probe that auto-selects mock on failure is optional.

   > **Scope of the mock-mode guarantee (narrowed deliberately).** Mock mode is **stateless**: every call returns a canned, schema-valid body (`mockBody`), so `recall` always yields `results: []` regardless of what was previously retained. What AC5 therefore guarantees is that no AC **fails or throws** because Hindsight is down — the wiring, schema conformance, error handling and requestId propagation are all exercised without a network. It explicitly does **NOT** guarantee retain→recall *round-trip* semantics: an AC asserting "retain an entry, then recall it back" is a **live-Hindsight-only** assertion and MUST be marked as such (it stays blocked on OQ-4 rather than being faked). Making the mock stateful/fixture-backed is a P0.9 backlog item, not a P1.11 requirement — do not write a Phase-1 AC that depends on it.

## Technical Notes

- **Contracts/Schema (P0.9 canonical — CC-11):** Recall request = P0.9 `RecallPayloadSchema` `{bank_id, query, limit(1..50, default 5)}`. Recall response = P0.9 `RecallResponseSchema` `{results:[{content:string, score:number(0..1), memoryId:string}], durationMs:number}` — drop invented `entries`/`MemoryEntry`. Retain request = P0.9 `RetainPayloadSchema` `{bank_id, content(≤100KB), metadata?:{source:"agent"|"mulch-import"|"manual"|"consolidate", kind?:"decision"|"pattern"|"expertise"|"observation", tags?:string[]}}` — issueId/runId/stepId carried in `metadata.tags[]`. Retain response = P0.9 `RetainResponseSchema` `{memoryId, bankId, status:"created"|"updated", durationMs}` (camelCase; drop invented `bank_id`/`id`).
  - **Transport mapping — the P0.9 schemas are the LOGICAL payloads, not the wire bodies.** "Consume P0.9's schemas verbatim" means the canonical field names and response shapes are reused unchanged; it does NOT mean the request body is a 1:1 serialization of the schema. At the REST boundary the schemas are path-scoped (`src/hindsight/client.ts`):

    | Op | URL | Actual request body |
    |---|---|---|
    | recall | `POST /v1/default/banks/{bank_id}/memories/recall` | `{query, limit}` — **`bank_id` travels in the URL path, not the body** |
    | retain | `POST /v1/default/banks/{bank_id}/memories` | `{items: [{content, metadata?}]}` — **the payload is wrapped in an `items[]` envelope**; `bank_id` again in the path |

    Response bodies ARE parsed directly against `RecallResponseSchema` / `RetainResponseSchema` with no unwrapping. Implementers MUST call the `HindsightClient` methods rather than hand-rolling these bodies.
  - **requestId carrier on Hindsight ops = the `x-request-id` header ONLY (P1.11-R5-4).** AC1 and INV-MEM-2 previously demanded "`x-request-id` header + `_meta.requestId` + envelope `id`" on every bank operation, but Hindsight's surface is **REST, not JSON-RPC**: the recall body is `{query, limit}` and the retain body is `{items:[…]}` (table above), neither of which has an envelope to carry an `id`, and the shipped client sends the correlation id as the `x-request-id` header alone (`src/hindsight/client.ts` `request()` — the header is set from the resolved `rid`). Requiring the other two fields would mean inventing body fields the Hindsight API does not define and the client does not send, so the requirement is **narrowed here rather than the client changed**: on Hindsight bank operations the propagated UUID v4 travels in `x-request-id`, full stop. The `_meta.requestId` + envelope `id` triple is the **CC-9 contract for the JSON-RPC surfaces** — the SwarmClaw `/api/a2a` route (P1.1) and the MCP tool bridge — and continues to apply unchanged there. The same requestId value is used on both sides, so cross-layer join still works end-to-end; only the carrier differs per transport.
  - **Enforcement boundary for the recall/retain limits (P1.11-R5-5): the client, via the P0.9 schemas — one place, not per-phase.** `recall.limit` is constrained by `RecallPayloadSchema.limit` = `z.number().int().min(1).max(50).default(5)` (`src/hindsight/schemas.ts:80`) and retain content by `RetainPayloadSchema.content`'s 100KB byte cap (`src/hindsight/schemas.ts:62-66`, message `"Content exceeds 100KB byte limit"`). Both are already shipped and both reject at parse time, before any request leaves the process. Phases MUST NOT re-implement or pre-clamp these bounds — a second, drifting copy of a limit is how the two ends stop agreeing; phases pass their values through and surface the client's validation error. An out-of-range `limit` or oversized `content` is a caller bug, not a waiver case: it does NOT log `waiver.reason: 'hindsight-unavailable'` and does NOT degrade to unprimed execution, because nothing about Hindsight is unavailable.
- **Integration points:** `src/hindsight/client.ts` (sanctioned HTTP boundary, DEFAULT_BASE_URL http://127.0.0.1:8888, PR #34 defensive parsing — `unknown` return, `safeParse`, `AbortController` + `clearTimeout` in `finally`; P0.7 `maskEnv` for env diagnostics); Hindsight banks: `{repo}`, `{repo}-dev-meta`, `qds-collective`; phase executor for prime/retain hooks.
- **Files / functions touched (CC-10):** REUSE existing `src/hindsight/client.ts` — do NOT create `src/memory/hindsight-client.ts`. NEW: `src/hindsight/prime-phase.ts` (pre-execution recall wiring), `src/hindsight/retain-phase.ts` (post-execution retain wiring). INTEGRATE: `src/protocol/phase-executor.ts` (prime/retain hooks, requestId propagation per CC-9). **M-PairB-1 (coordination note):** P1.11 and P1.12 both extend `src/protocol/phase-executor.ts` (P1.6 artifact); coordinate edit ordering — P1.11 lands first, P1.12 reuses the hook.
- **Guards/limits (CC-9 / PB-M3):** Per-bank recall limit ≤ 50 (P0.9 `RecallPayloadSchema.limit.max`). Retain content ≤ 100KB (P0.9 `RetainPayloadSchema.content` byte cap). Timeouts align to P0.9 client constants: `RECALL_TIMEOUT_MS = 10_000`, `RETAIN_TIMEOUT_MS = 30_000`. requestId propagated end-to-end (CC-9).
- **Secret masking (PB-M2):** Any env diagnostic logged through `HindsightClient` MUST be redacted via P0.7 `maskEnv` (`src/swarmclaw/mcp/tool-bridge.ts:105`). Bearer tokens never appear in logs.

## Files to Modify

- `src/hindsight/client.ts` (REUSE — extend only if requestId plumbing demands)
- `src/hindsight/prime-phase.ts` (NEW)
- `src/hindsight/retain-phase.ts` (NEW)
- `src/protocol/phase-executor.ts` (prime/retain hooks integration)

## Security Invariants

- INV-MEM-1 (CC-5 LOCKED): No raw `fetch` to the Hindsight API outside the sanctioned `src/hindsight/client.ts` HTTP boundary. `src/hindsight/client.ts` is the sole HTTP surface for Hindsight (DEFAULT_BASE_URL http://127.0.0.1:8888), implementing PR #34 defensive parsing (`unknown` return, `safeParse`, `AbortController` + `clearTimeout` in `finally`) and P0.7 `maskEnv` for env diagnostics. P1.11 EXTENDS `src/hindsight/` — no parallel client is created.
- INV-MEM-2 (CC-9 / PB-M4): Retained entries include `metadata.source` plus `metadata.tags[]` carrying `issueId`/`runId`/`stepId` — no anonymous writes to collective banks. `requestId` (UUID v4 strict) propagated via the `x-request-id` header on every bank op — the sole carrier on Hindsight REST ops (P1.11-R5-4); `_meta.requestId` + envelope `id` remain the CC-9 contract for the JSON-RPC surfaces (`/api/a2a`, MCP bridge), not for these REST calls.
- INV-MEM-3: When the Hindsight HTTP API is unreachable, the step proceeds but no partial or stale memory is injected — the waiver is logged (with `requestId`) and the step runs unprimed in recorded/mock mode.

## Definition of Done

- [ ] **Impl:** Pre-execution prime: `HindsightClient.recall()` against `{repo}`, `{repo}-dev-meta`, `qds-collective` banks with propagated `requestId`
- [ ] **Impl:** Inject recalled `RecallResponse.results` into Pi agent context (canonical fields `content`/`score`/`memoryId`)
- [ ] **Impl:** Post-execution retain: `HindsightClient.retain()` with P0.9 `RetainPayload` (`metadata.tags[]` carries issueId/runId/stepId)
- [ ] **Impl:** Hindsight HTTP API unavailable → recorded/mock mode, log `waiver.reason: 'hindsight-unavailable'` with `requestId`, skip retain
- [ ] **Contract:** Consume P0.9 `RecallResponseSchema` + `RetainPayloadSchema` + `RetainResponseSchema` verbatim — no invented shapes
- [ ] **Integration:** REUSE `src/hindsight/client.ts`; banks `{repo}`, `{repo}-dev-meta`, `qds-collective`; requestId end-to-end (CC-9)
- [ ] **Security:** Sanctioned-client-only HTTP; `metadata.tags[]` provenance; `maskEnv` on env diagnostics; graceful degradation
- [ ] **Test (unit):** Recall returns P0.9-shaped `RecallResponse` and injects context; retain writes P0.9-shaped `RetainPayload` and returns `RetainResponse`; empty recall → step proceeds; retain `metadata.tags[]` carries issueId/runId
- [ ] **Test (timeout is a LIVE-mode test, P1.11-R5-2):** HTTP timeout → `waiver.reason: 'hindsight-unavailable'` waiver, exercised in **live** mode against a deterministic slow/failing transport (a stub server that never answers, or an injected fetch that hangs past `RECALL_TIMEOUT_MS`). It MUST NOT be written as a mock-mode test: mock mode short-circuits before `fetch` and `AbortController` are ever reached (`src/hindsight/client.ts` returns `mockBody` ahead of the request path), so a "timeout in mock mode" assertion cannot execute the code it claims to cover and would pass vacuously. Mock-mode tests stay scoped to network-free success behaviour and schema conformance.
- [ ] **Test (e2e demo — MANDATORY, env-fallback):** Full protocol run where the step recalls entries from `qds-collective`, executes with primed context, and retains learnings to the `{repo}` bank. **Split by mode (P1.11-R5-3):** the *retain→recall round-trip* assertion — querying the bank post-run and finding the newly retained entry — is **live-Hindsight only**, because mock mode is stateless by the AC5 narrowing above (`recall` always returns `results: []`, so a stateful assertion would fail or have to be faked). When live Hindsight is unavailable the same scenario MUST still run against recorded/mock fixtures and MUST still pass, asserting the *wiring* half: recall is called against all three banks, the step executes, retain is invoked with a schema-valid `RetainPayload`, requestId propagates end-to-end, and nothing throws. Mark the round-trip half explicitly blocked on OQ-4 rather than asserting it against the stateless mock. (Note the AC3 interaction: AC3's "retain is skipped" applies to the **unreachable-live** path; in explicit `mode: 'mock'` the retain call is still made — it returns the canned `RetainResponse` — which is what the wiring half asserts.)
