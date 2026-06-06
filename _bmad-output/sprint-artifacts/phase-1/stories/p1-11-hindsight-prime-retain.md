# P1.11: `qds-hindsight-prime` recall-before / retain-after — the L2 per-story memory loop

**Story Points:** 4

## Spec Reference

- PRD §6.2 / §6.5 + §9.1 (loop L2 — per-story); FR-MG-6, FR-MG-7, FR-MEM-2
- Supporting: NFR-PERF-4 (recall ≤2s p95 cloud / ≤1s self-host, proceed-unprimed-on-timeout), NFR-REL-3 (retain idempotent, `document_id=runId`), NFR-SEC-5 (Hindsight calls send `Authorization: Bearer`), NFR-OBS-3 (handoff logged with issue-id)
- Phase exit gate: PRD §13 Phase-1 clause 9 — "a run recalls relevant prior bank entries into the node system prompt before execution and retains its learnings after." (FR-MG-6/7, FR-MEM-2)

## User Story

As the Hermes Dev manager driving a `qds-piv-loop` run for a `{repo}` issue,
I want the run to recall relevant prior `{repo}` bank entries into the implement node's system prompt before it executes and retain that run's learnings after it finishes,
so that each story benefits from accumulated prior learnings and feeds its own back (G3 — the factory learns), closing the L2 per-story memory loop on a real run.

## Overview

This slice cuts through Hermes (run-start/run-finish hooks) → Hindsight bank-scoped REST (`/v1/default/banks/{bank}/recall` and `/memories`) → the Pi-team implement node's primed system prompt (`--append-system-prompt` via `--context-path`) → the `{repo}` shared bank. On `agent.run.started` the `qds-hindsight-prime` step recalls by issue title+desc against the per-repo `{repo}` bank and injects the fused result into the node prompt BEFORE execution; on `agent.run.finished` it retains the run output to the same bank with `document_id = runId` (Hindsight replaces on matching `document_id` → idempotent upsert). It is one atomic 4-pt unit because the loop is not demonstrable until BOTH halves round-trip on a real run — recall-before that primes the prompt AND retain-after that lands a queryable `document_id == runId` document — splitting them would leave a half-loop (recall with nothing to recall, or retain that never primes).

## E2E Slice

**Demonstrable behavior:** Running a `qds-piv-loop` run on a `{repo}` issue causes (1) a `POST /v1/default/banks/{repo}/recall` BEFORE the implement node executes whose fused result is injected into the node's system prompt, and (2) a `POST /v1/default/banks/{repo}/memories` AFTER the run finishes with `document_id` equal to the Paperclip `runId` — so a follow-up `recall` (or document fetch) on `{repo}` returns a document whose `document_id == runId`.

**Wiring closed:** On completion of this story, a real `qds-piv-loop` run recalls prior `{repo}` bank entries into the implement node's system prompt before execution AND retains the run output to `{repo}` with `document_id == runId` (re-fetchable after the run), using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P0.9 (Hindsight host decided — self-host default / cloud opt-in, OQ-4; `{repo}` + `{repo}-dev-meta` banks exist; retain→recall→reflect round-trip proven on a throwaway bank), P1.6 (the Pi-team implement node exists and accepts a primed system prompt via `--context-path` / `--append-system-prompt`). The Mulch house-style prime is the SEPARATE sibling story **P1.12** (different store, dependency-independent — not wired here).

## Acceptance Criteria

1. **(make-or-break)** Given a `qds-piv-loop` run for a `{repo}` issue with `runId = R`, When the run executes end-to-end, Then a `recall` against `{repo}` is issued BEFORE the implement node runs (its result text appears in the node's system prompt) AND after the run a document with `document_id == R` is retrievable from the `{repo}` bank. (Binary: recall precedes node exec in the run log AND a `{repo}` document exists with `document_id == R`.)
2. Given the same run is RE-RUN with the same `runId = R` (e.g. a retry), When retain fires again, Then the `{repo}` bank holds exactly ONE document for `document_id == R` (Hindsight upsert/replace on matching `document_id`) — no duplicate (NFR-REL-3).
3. Given the `{repo}` bank is empty (cold-start, day-1) OR recall exceeds its NFR-PERF-4 latency budget, When recall runs, Then it returns an empty/timed-out result and the node proceeds UNPRIMED with a logged warning (recall is an enhancement, never a hard dependency) — never a hang and never a halt.
4. Given a recall for repo `{repoA}`, When prior entries exist only in a different repo's bank `{repoB}`, Then the recall is scoped to `{repoA}` and returns ZERO `{repoB}` entries — no cross-repo bleed into the prompt (tenant isolation).

## Technical Notes

- **Contracts/Schema (JSON):** Recall request → `POST /v1/default/banks/{repo}/recall` body `{ query: <issue title+desc>, budget: "mid", max_tokens: <=4096 }` (NFR-PERF-4); retain request → `POST /v1/default/banks/{repo}/memories` body `{ document_id: <runId>, content: <run output>, ... }` (Hindsight replaces on matching `document_id` → idempotent upsert, NFR-REL-3). Bank id is the literal `{repo}` slug — NOT `{repo}-dev-meta` (meta-banks are the L4 path, out of scope here).
- **Integration points (each wired & exercised):** (1) `agent.run.started` → recall, result fused (RRF + cross-encoder, 4-strategy) and injected into the implement node's system prompt via `--context-path` → `--append-system-prompt` (P1.6 surface); (2) `agent.run.finished` → retain with `document_id = runId`; (3) every Hindsight call carries `Authorization: Bearer <token>` from env/secret ref (`HINDSIGHT_CP_DATAPLANE_API_KEY`, NFR-SEC-5); (4) the recall→prime and retain handoffs are logged with the issue-id correlation (NFR-OBS-3) — this is audit-chain hop #10 (`run → memory`, `document_id == runId`, r3 §B).
- **Files / functions touched:** the `qds-hindsight-prime` step (recall-on-start, inject-into-prompt), the retain-on-finish hook, the Hindsight client wrapper (bearer auth + base_url self-host/cloud switch), the recall-timeout/empty-bank fallback path.
- **Guards/limits:** recall budget `mid`, `max_tokens ≤ 4096`, p95 ≤2s cloud / ≤1s self-host, MUST NOT block the node beyond the `coms_await` timeout (NFR-PERF-4) → on timeout, proceed unprimed with a logged warning.

## Files to Modify

- `scripts/hindsight/qds-hindsight-prime.ts`
- `scripts/hindsight/retain-on-finish.ts`
- `scripts/hindsight/client.ts`
- `scripts/hindsight/prompt-inject.ts`
- `config/hindsight.config.ts`
- `test/hindsight/prime-retain.e2e.test.ts`
- `test/hindsight/tenant-isolation.test.ts`

## Security Invariants

- **INV-1 (tenant):** Recall and retain are bank-scoped to the run's own `{repo}` — the bank id is derived from the issue's repo, never a wildcard or cross-repo bank; a recall for `{repoA}` MUST NOT return `{repoB}` entries (AC-4). Cross-repo bank ids are rejected, not silently coerced.
- **INV-2 (tenant):** Retain writes ONLY to the run's `{repo}` bank with `document_id = runId`; a run for `{repoA}` can never write a document into `{repoB}`'s bank (no cross-tenant write).
- **INV-3 (secrets/auth):** Every Hindsight call sends `Authorization: Bearer <token>` sourced from env/secret ref (`HINDSIGHT_CP_DATAPLANE_API_KEY`, NFR-SEC-5); the token is NEVER hardcoded, logged, or written into the retained memory content. `HINDSIGHT_API_LLM_API_KEY` (the LLM-provider key) is NOT used as the server-auth token — the two are not conflated.
- **INV-4 (idempotency/integrity):** Retain keys on `document_id = runId` so a retried run upserts (replaces) rather than duplicating (NFR-REL-3) — exactly one document per `runId`, keeping the audit-chain hop #10 link unambiguous.

## Definition of Done

- [ ] **Impl:** `qds-hindsight-prime` recalls against the run's `{repo}` bank on `agent.run.started` and injects the fused result into the implement node's system prompt BEFORE the node executes.
- [ ] **Impl:** The retain-on-finish hook writes the run output to `{repo}` with `document_id = runId` on `agent.run.finished`.
- [ ] **Impl:** Cold-start (empty bank) and recall-timeout both fall through to proceed-unprimed with a logged warning (never hang, never halt).
- [ ] **Contract:** Recall body (`query`/`budget:"mid"`/`max_tokens<=4096`) and retain body (`document_id=runId`/`content`) are defined and validated against the bank-scoped REST surface.
- [ ] **Integration:** The recall result demonstrably reaches the implement node's system prompt (`--context-path` → `--append-system-prompt`, P1.6 surface), and the retained document is re-fetchable from `{repo}` after the run.
- [ ] **Observability/Audit:** The recall→prime and retain handoffs are logged with issue-id correlation (NFR-OBS-3); the retained `document_id == runId` resolves audit-chain hop #10 (`run → memory`).
- [ ] **Security:** INV-1/INV-2 (tenant: per-repo bank isolation, recall pulls no cross-repo entry, retain writes only own bank) and INV-3 (Bearer from secret ref, never logged) each enforced and tested.
- [ ] **Test (unit/integration):** Covers the empty-bank/timeout proceed-unprimed path AND the idempotent re-retain (one document per `runId`, NFR-REL-3).
- [ ] **Test (tenant isolation):** A recall for `{repoA}` with entries seeded only in `{repoB}` returns ZERO `{repoB}` entries (INV-1).
- [ ] **Test (e2e demo — MANDATORY):** Fires AC-1 trigger: runs a real `qds-piv-loop` run with `runId = R`; asserts recall precedes the implement node exec (result in the system prompt) AND a `{repo}` document with `document_id == R` is retrievable after — proving the L2 loop round-trips with wiring closed.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
