# P1.12: Mulch Prime/Record Wiring via Hindsight `{repo}-dev-meta` Bank

> **v5 amendment (DF5.5):** the prime/retain hook seam named below as
> `src/protocol/phase-executor.ts` is pre-v5. The v5 phase engine lives under
> `src/phase-engine/*` (derivation register §1) and, per the 2026-08-31 tier-2 placement ADR,
> **runs inside the sandbox box** (DF1.10). Wire prime/retain against the in-box engine's phase
> lifecycle, not a host-side executor. The M-PairB-1 edit-ordering note (P1.11 lands first,
> P1.12 extends its hook) is unchanged.

**Story Points:** 3

## Spec Reference

- PRD §5.2; FR-MEM-5

## User Story

As a dev manager,
I want house-style context primed from Mulch expertise before execution and reusable expertise recorded after,
so that each run carries the project's accumulated style and conventions and contributes back to the expertise store.

## Overview

Before a protocol step executes, the phase executor recalls house-style expertise from the `{repo}-dev-meta` Hindsight bank via the sanctioned `src/hindsight/client.ts` HTTP boundary (P0.9), reusing the importer primitives in `src/hindsight/mulch-importer.ts`. After the step completes, the phase executor retains new reusable expertise (patterns, conventions, corrections) back to the same `{repo}-dev-meta` bank through `HindsightClient.retain()`. This aligns with the P0.9 "Mulch Priming Consumer Contract": the importer reads `.mulch/expertise/` directly; `/usr/local/bin/mulch` is NOT spawned as a subprocess. The prime/record loop ensures house-style consistency across runs and accumulates project-specific knowledge over time. P1.12 EXTENDS `src/hindsight/` — no parallel client, no Mulch CLI subprocess.

## E2E Slice

**Demonstrable behavior:** A protocol step for issue #42 starts. The phase executor calls `HindsightClient.recall()` against the `{repo}-dev-meta` bank with a requestId-propagated request, and the returned `MulchExpertise` entries (naming conventions, import ordering, error-handling patterns) are injected into the Pi agent context. After the step executes and the agent followed the house style, the phase executor calls `HindsightClient.retain()` on the same bank with `metadata = {source:"agent", kind:"expertise", tags:["issue-42", "runId:<id>", "stepId:<id>"]}` and the new pattern in `content` — **full provenance (P1.12-R5-1):** an earlier draft of this example carried only `["issue-42"]`, so the demonstration could pass while violating AC2 and INV-MULCH-2, which both require the issue, run, and step identifiers. On the next run, `recall` returns the accumulated expertise including the new entry — **live-Hindsight only**, since mock mode is stateless (P1.11 AC5 narrowing: `recall` always returns `results: []`, so an accumulation assertion cannot hold against the mock and stays blocked on OQ-4 rather than being faked).

**Wiring closed:** On completion of this story, the house-style loop (prime → execute → record) primes and persists expertise across runs using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P0.9, DF1.6 (was P1.6) <!-- v5 amendment (DF5.5) -->

## Acceptance Criteria

1. **(make-or-break)** Given a protocol step is about to execute, When the phase executor primes the agent context, Then it calls `HindsightClient.recall()` against the `{repo}-dev-meta` bank (sanctioned `src/hindsight/client.ts` HTTP boundary) with a propagated `requestId` (UUID v4 strict, carried in the `x-request-id` header — the sole carrier on Hindsight REST ops, P1.11-R5-4), and the returned `MulchExpertise`-shaped entries (per P0.9 `MulchExpertiseSchema`) are injected into the Pi agent's working context.
2. Given a protocol step has completed and produced new reusable expertise, When the phase executor records, Then it calls `HindsightClient.retain()` against the `{repo}-dev-meta` bank with a P0.9 `RetainPayload` (`content`, `metadata = {source:"agent", kind:"expertise", tags:["issue-<N>", "runId:<id>", "stepId:<id>"]}`), and a `RetainResponse` (`{memoryId,bankId,status,durationMs}`) is returned.
3. Given `recall` returns no entries for a domain AND the bank has not been populated by the importer (PB-L2), When the context is injected, Then the step proceeds with an explicit `mulchPrimed:false` advisory in the waiver log (empty-result is not a failure, but downstream stages can distinguish "no expertise bank populated" from "expertise recalled"). The `mulchPrimed` field name is pinned to P1.6's (now DF1.6's) run-state schema (cross-story contract: success/failure output literals mandate `mulchPrimed: boolean, mulchPrimeError?: string`). <!-- v5 amendment (DF5.5) -->
4. Given the Hindsight HTTP API is unreachable (gate clause 7 fail / OQ-4 BLOCKED-on-env), When the phase executor attempts to prime, Then the step proceeds without primed context in recorded/mock mode, a `waiver.reason: 'hindsight-unavailable'` is logged with `requestId`, and the record step is skipped.
5. **(env-fallback)** Any AC above requiring a live Hindsight round-trip MUST also pass in recorded/mock mode (fixture replay when `HINDSIGHT_BASE_URL` is unset or unreachable) — no AC fails purely because the local Hindsight API is down. Mock mode is selected when `HindsightClient` is constructed with `mode: 'mock'` (shipped P0.9 follow-up 2026-07-27: `HindsightClientOptions.mode?: 'live' | 'mock'`); a startup health-check probe that auto-selects mock on failure is optional.

## Technical Notes

- **Contracts/Schema (P0.9 canonical — CC-11):** Recall request = P0.9 `RecallPayloadSchema` `{bank_id:"{repo}-dev-meta", query, limit}`. Recall response = P0.9 `RecallResponseSchema` `{results:[{content,score,memoryId}], durationMs}` — each `content` is a serialized `MulchExpertise` (`{id?, domain, concepts[], expertise, source?, confidence?}` per P0.9 `MulchExpertiseSchema`). Drop invented `MulchEntry`. Retain request = P0.9 `RetainPayloadSchema` `{bank_id:"{repo}-dev-meta", content, metadata:{source:"agent", kind:"expertise", tags:["issue-<N>","runId:<id>","stepId:<id>"]}}`. Retain response = P0.9 `RetainResponseSchema` `{memoryId, bankId, status:"created"|"updated", durationMs}`.
- **Integration points (PB-B2 LOCKED):** recall-from and retain-to the `{repo}-dev-meta` Hindsight bank via `HindsightClient`. Mulch importer primitives reused: `src/hindsight/mulch-importer.ts` `MAX_FILE_BYTES = 5 * 1024 * 1024` (5MB per file), `FileTooLargeError`, `MAX_FILES = 100`, and bank-provisioner single-flight at `~/.hindsight/provision.lock` (`src/hindsight/bank-provisioner.ts:133`). NO `mulch prime` / `mulch record` CLI subprocess; NO `/usr/local/bin/mulch` spawn.
- **Files / functions touched (CC-10):** REUSE existing `src/hindsight/client.ts` + `src/hindsight/mulch-importer.ts` primitives — do NOT create `src/mulch/mulch-client.ts` or `src/memory/` proposals. NEW: `src/hindsight/mulch-prime-phase.ts` (pre-execution recall-from-`{repo}-dev-meta` wiring), `src/hindsight/mulch-record-phase.ts` (post-execution retain-to-`{repo}-dev-meta` wiring). INTEGRATE: `src/protocol/phase-executor.ts` (prime/record hooks, requestId propagation per CC-9). **M-PairB-1 (coordination note):** P1.11 and P1.12 both extend `src/protocol/phase-executor.ts` (a P1.6 artifact, now DF1.6 — does not exist yet). <!-- v5 amendment (DF5.5) --> Edit ordering: P1.11 lands first and introduces the prime/retain hook seam; P1.12 reuses that same hook (mulch prime/record is the house-style-bank variant of the prime/retain pattern). Do NOT define a parallel hook seam in P1.12 — extend P1.11's.
- **Guards/limits (CC-9 / PB-M3):** Per-bank recall limit ≤ 50 (P0.9 `RecallPayloadSchema.limit.max`). Retain content ≤ 100KB (P0.9 `RetainPayloadSchema.content` byte cap — mirrors mulch-importer `MAX_CONTENT_BYTES = 102_400`). Timeouts align to P0.9 client constants: `RECALL_TIMEOUT_MS = 10_000`, `RETAIN_TIMEOUT_MS = 30_000`. requestId propagated end-to-end (CC-9).
- **Secret masking (PB-M2):** Any env diagnostic logged through `HindsightClient` MUST be redacted via P0.7 `maskEnv` (`src/swarmclaw/mcp/tool-bridge.ts:105`). Bearer tokens never appear in logs.

## Files to Modify

- `src/hindsight/client.ts` (REUSE — extend only if requestId plumbing demands)
- `src/hindsight/mulch-importer.ts` (REUSE primitives; do NOT fork)
- `src/hindsight/mulch-prime-phase.ts` (NEW)
- `src/hindsight/mulch-record-phase.ts` (NEW)
- `src/protocol/phase-executor.ts` (prime/record hooks integration)

## Security Invariants

- INV-MULCH-1 (CC-5 LOCKED): No raw `fetch` to the Hindsight API outside the sanctioned `src/hindsight/client.ts` HTTP boundary. No `mulch` CLI subprocess. P1.12 EXTENDS `src/hindsight/` (recall/retain via `HindsightClient` + importer primitives) — no parallel client, no subprocess spawn.
- INV-MULCH-2 (CC-9): Retain `metadata.tags[]` carries `issue-<N>` / `runId:<id>` / `stepId:<id>` — no anonymous expertise writes. `requestId` (UUID v4 strict) propagated via the `x-request-id` header on every bank op — the sole carrier on Hindsight REST ops (P1.11-R5-4); `_meta.requestId` + envelope `id` remain the CC-9 contract for the JSON-RPC surfaces (`/api/a2a`, MCP bridge), not for these REST calls.
- INV-MULCH-3 (PB-B2 LOCKED): No arbitrary binary execution. The Mulch importer reads `.mulch/expertise/<domain>.jsonl` directly (`mulch-importer.ts`); per-file size cap `MAX_FILE_BYTES = 5MB` raises `FileTooLargeError`; provision single-flight at `~/.hindsight/provision.lock`. The harness NEVER spawns `/usr/local/bin/mulch`.

## Definition of Done

- [ ] **Impl:** Pre-execution prime: `HindsightClient.recall()` against `{repo}-dev-meta` bank with propagated `requestId`
- [ ] **Impl:** Post-execution record: `HindsightClient.retain()` with `metadata = {source:"agent", kind:"expertise", tags:["issue-<N>","runId:<id>","stepId:<id>"]}`
- [ ] **Impl:** Empty `recall` + unpopulated bank → step proceeds with `mulchPrimed:false` advisory in waiver log
- [ ] **Impl:** Hindsight HTTP API unavailable → recorded/mock mode, log `waiver.reason: 'hindsight-unavailable'` with `requestId`, skip record
- [ ] **Contract:** Consume P0.9 `MulchExpertiseSchema` + `RecallResponseSchema` + `RetainPayloadSchema` + `RetainResponseSchema` verbatim — no invented `MulchEntry`
- [ ] **Integration:** REUSE `src/hindsight/client.ts` + `src/hindsight/mulch-importer.ts`; `{repo}-dev-meta` bank; requestId end-to-end (CC-9); NO `mulch` CLI subprocess
- [ ] **Security:** Sanctioned-client-only HTTP; no subprocess spawn; `metadata.tags[]` provenance; `maskEnv` on env diagnostics; per-file 5MB cap via importer primitives
- [ ] **Test (unit):** Recall returns P0.9-shaped `RecallResponse` whose `content` serializes `MulchExpertise`, injected into context; retain writes P0.9-shaped `RetainPayload` and returns `RetainResponse`; empty recall + unpopulated bank → `mulchPrimed:false` advisory; retain `metadata.tags[]` provenance-tagged. **HTTP timeout → waiver is a LIVE-mode test (P1.11-R5-2):** run it against a deterministic slow/failing transport, never in mock mode — mock short-circuits before `fetch`/`AbortController`, so a mock-mode timeout assertion cannot execute the path it claims to cover.
- [ ] **Test (e2e demo — MANDATORY, env-fallback):** Full protocol run where `recall` loads TypeScript expertise from `{repo}-dev-meta`, agent follows house style, `retain` persists a new pattern; next run's `recall` returns the accumulated expertise including the newly retained entry. When live Hindsight is unavailable, the same scenario MUST pass against recorded/mock fixtures (CC-5 OQ-4 env-fallback).
