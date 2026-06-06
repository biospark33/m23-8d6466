# P0.9: Provision Hindsight memory substrate with per-repo + per-manager banks

**Story Points:** 4

## Spec Reference

- PRD §6.5 (Memory & decomposition); FR-MEM-1, FR-MEM-4; partial FR-MEM-2 (retain/recall round-trip); NFR-PERF-4, NFR-SEC-5
- Phase exit gate: PRD §13 Phase-0 clause 7 (Hindsight retain→recall→reflect round-trips on the chosen bank) + clause 8 (OQ-4 decision recorded)
- PRD §12.1 item 6 (pin tooling + decide Hindsight host + wire banks); R4 §6–§7; R3 §B hop 10.

## User Story

As a Dev|QA|Maintenance manager (Hermes),
I want a memory substrate that round-trips retain→recall→reflect on a provisioned `{repo}` bank, with the `{repo}-dev-meta` meta-bank also created and Mulch expertise imported,
so that runs can prime prompts from prior learnings and the §8.1 audit chain's memory hop (G2 accountability, G3 learning) resolves to a real bank.

## Overview

This slice cuts Hermes → Hindsight (memory) + Mulch (priming store). It (a) **records the OQ-4 cloud-vs-self-host decision** on cost/latency/data-residency grounds — the local self-host stack is BLOCKED on env (arm64 OpenSSL/arch mismatch, R4 §7), so the decision is the spec deliverable and the round-trip is the proof against the *chosen* endpoint; (b) provisions the two banks `{repo}` and `{repo}-dev-meta` via the bank-scoped API; (c) proves a full `retain → recall → reflect` round-trip on `{repo}`; (d) imports Mulch expertise (`/usr/local/bin/mulch`) into the priming store. Pins Seeds 0.2.5 (`/usr/local/bin/sd`) and Mulch 0.6.3 (`/usr/local/bin/mulch`) — both **private CLIs**, npm names unrelated. One atomic 4pt unit because the round-trip is not demonstrable until banks exist, the host is chosen, and auth is wired together.

## E2E Slice

**Demonstrable behavior:** `node scripts/memory/provision-banks.ts --repo qds-factory` provisions banks `qds-factory` and `qds-factory-dev-meta`, then runs a `retain → recall → reflect` round-trip against the chosen Hindsight endpoint: it POSTs a known fact to `…/banks/qds-factory/memories`, recalls it via `…/recall` (the retained fact appears in the top result), and `…/reflect` returns a non-empty mental-model response. Stdout is a single JSON object `{ host: "self-host"|"cloud", banks: ["qds-factory","qds-factory-dev-meta"], roundTrip: { retained: true, recalledId: "<id>", reflected: true }, mulchImported: <n>, oq4: { decision, rationale } }`.

**Wiring closed:** On completion of this story, running `provision-banks.ts --repo qds-factory` produces the single JSON object above (with `roundTrip.retained===true`, a non-null `recalledId`, and `reflected===true`) against the OQ-4-chosen endpoint, using only code merged by this story (provisioning script, Hindsight client wrapper with Bearer auth, OQ-4 decision record, Mulch import call). No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P0.7 (acquisition/install groundwork — tooling pin baseline). If the self-host stack remains env-blocked at run time, OQ-4 resolves to **cloud** (`api.hindsight.vectorize.io`) as the proving endpoint and the decision record states so; the round-trip is identical (only `base_url`+Bearer differ, R4 §7).

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given the OQ-4-chosen Hindsight endpoint and a valid Bearer token from env, When `provision-banks.ts --repo qds-factory` runs, Then both banks `qds-factory` and `qds-factory-dev-meta` exist AND the emitted JSON has `roundTrip.retained===true`, a non-null `roundTrip.recalledId` equal to the retained memory's id, and `roundTrip.reflected===true` (§13 Phase-0 clause 7 satisfied).
2. Given the script runs, When it finishes, Then an OQ-4 decision record is written to `docs/decisions/oq-4-hindsight-host.md` capturing `decision` (cloud|self-host), and the rationale columns cost/latency/data-residency, and the emitted JSON `oq4.decision` matches it (§13 clause 8).
3. Given Mulch expertise exists at `.mulch/expertise/*.jsonl`, When the script imports it, Then `mulchImported` equals the count of imported records (>0 when records exist) and `mulch prime` over the imported domain returns a non-empty priming prompt.
4. Given the Bearer token is absent OR the chosen endpoint is unreachable, When the script runs, Then it exits non-zero with a logged reason and writes NO partial bank state — never a silent success.

## Technical Notes

- **Contracts/Schema:** Hindsight bank-scoped REST (identical cloud vs self-host, only `base_url`+Bearer differ — R4 §7): retain `POST /v1/default/banks/{bank_id}/memories`, recall `POST …/recall`, reflect `POST …/reflect`. Client wrapper is a TS type `HindsightClient` with `retain(bankId, {document_id?, text, tags?})`, `recall(bankId, {query, budget:"mid", max_tokens<=4096})`, `reflect(bankId, {query})`. Bank ids: `{repo}` and `{repo}-dev-meta`. Idempotent retain keys on `document_id` (Hindsight replaces on match — NFR-REL-3 basis).
- **Integration points (each wired & exercised in this story):** Hindsight client → chosen endpoint with `Authorization: Bearer <token>` (token from `HINDSIGHT_CP_DATAPLANE_API_KEY` / SDK `api_key`, NOT `HINDSIGHT_API_LLM_API_KEY`, NFR-SEC-5); bank-create + retain + recall + reflect exercised in sequence; Mulch import via `mulch learn`/`mulch record` reading `.mulch/expertise/<domain>.jsonl` then `mulch prime` to confirm; tooling pin assertions for `sd 0.2.5` + `mulch 0.6.3`.
- **Files / functions touched:** `scripts/memory/provision-banks.ts` (entrypoint + JSON emit), `src/memory/hindsight-client.ts` (`retain`/`recall`/`reflect`, Bearer header), `src/memory/oq4-decision.ts` (decision record writer).
- **Guards/limits:** recall uses `budget:"mid"`, `max_tokens<=4096`, must return within ≤2s p95 cloud / ≤1s p95 self-host (NFR-PERF-4); on recall timeout the *caller* proceeds unprimed with a logged warning — but for THIS provisioning round-trip a recall timeout fails the make-or-break (the proof requires a real recall). Self-host local stack is env-blocked → OQ-4 may resolve cloud; record the unblock command (arm64 OpenSSL at `/opt/homebrew/opt/openssl@3` OR external `HINDSIGHT_API_DATABASE_URL`).

## Files to Modify

> ≤10 unique paths. Absolute or repo-relative, one per line.

- `scripts/memory/provision-banks.ts`
- `src/memory/hindsight-client.ts`
- `src/memory/oq4-decision.ts`
- `docs/decisions/oq-4-hindsight-host.md`
- `config/tooling-pins.json`
- `tests/memory/provision-banks.test.ts`

## Security Invariants

> Concrete named invariants — `N/A` is FORBIDDEN (secrets/env + tenant triggers apply).

- **INV-1 (secrets/env):** The Hindsight server-auth token is read from env/secret ref (`HINDSIGHT_CP_DATAPLANE_API_KEY` or SDK `api_key`), never hardcoded; it is NOT conflated with `HINDSIGHT_API_LLM_API_KEY` (the LLM-provider key — NFR-SEC-5). The token value is never written to stdout, logs, the OQ-4 decision file, or any Hindsight memory document.
- **INV-2 (tenant — per-repo bank isolation):** Bank ids are tenant boundaries: code memories go ONLY to `{repo}` and manager meta-lessons ONLY to `{repo}-dev-meta`; the provisioning round-trip retains/recalls against the `{repo}` bank exclusively and never cross-writes into the `*-meta` bank (and vice-versa). No call targets a bank id derived from unsanitized external input.
- **INV-3 (secrets/env):** All memory calls send `Authorization: Bearer <token>` when the chosen endpoint is auth-protected (NFR-SEC-5); a 401/missing-token path exits non-zero (AC-4), never falls back to an unauthenticated call.

## Definition of Done

> 8–12 high-signal, story-specific boxes. NO lint/tests/typecheck filler.

- [ ] **Impl:** `provision-banks.ts` creates `{repo}` and `{repo}-dev-meta` banks against the OQ-4-chosen endpoint and emits the single JSON status object.
- [ ] **Impl:** OQ-4 decision recorded to `docs/decisions/oq-4-hindsight-host.md` on cost/latency/data-residency grounds, with the env-block + exact unblock command noted.
- [ ] **Impl:** Mulch expertise imported via `/usr/local/bin/mulch` from `.mulch/expertise/*.jsonl`; `mulch prime` confirmed non-empty.
- [ ] **Contract:** `HindsightClient` TS type with `retain`/`recall`/`reflect` against `/v1/default/banks/{bank_id}/…`; `document_id` idempotency documented.
- [ ] **Integration:** Full `retain → recall → reflect` round-trip exercised on the `{repo}` bank; recalled id equals retained id.
- [ ] **Integration:** Seeds `0.2.5` + Mulch `0.6.3` pins asserted (private CLIs at `/usr/local/bin/{sd,mulch}`; npm install explicitly forbidden in a code comment).
- [ ] **Observability:** Round-trip latency logged against the NFR-PERF-4 budget (≤2s p95 cloud / ≤1s p95 self-host); recall-timeout path logs a warning.
- [ ] **Security:** Bearer token sourced from env only, never emitted; LLM key vs server-auth key not conflated (INV-1/INV-3).
- [ ] **Security:** Per-repo bank isolation enforced — round-trip writes only to `{repo}`, never the `*-meta` bank (INV-2).
- [ ] **Test (unit/integration):** Covers bank-create, round-trip happy path, and the missing-token/unreachable guard path (exits non-zero, no partial state).
- [ ] **Test (e2e demo — MANDATORY):** Runs `provision-banks.ts --repo qds-factory`; asserts both banks exist and `roundTrip.retained===true` + non-null `recalledId` + `reflected===true` (proves §13 Phase-0 clause 7 + wiring closed).

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
