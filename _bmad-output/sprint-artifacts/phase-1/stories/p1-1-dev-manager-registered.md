# P1.1: Dev manager registered as a budgeted `hermes_local` agent under root

**Story Points:** 3

## Spec Reference

- PRD §6.2 (Manager — Hermes), §6.1 (Control-plane — Paperclip); FR-MG-1, FR-CP-11; NFR-SEC-2, NFR-ACC-1
- Phase exit gate: PRD §13 / §6.8 Phase-1 item 1 ("Dev manager registered" — exit: appears in org chart AND authenticates REST calls with host-injected `PAPERCLIP_API_KEY` + `PAPERCLIP_RUN_ID`).

## User Story

As the Operator,
I want the Dev manager to run as a 24/7 `hermes_local` agent that reports to the root agent with a budget and authenticates every Paperclip REST call,
so that every downstream work unit is owned by a non-anonymous, budgeted actor whose chain terminates at root (G1 accountability — NFR-ACC-1, 0 orphans).

## Overview

This slice cuts Paperclip control-plane → Hermes manager. It registers the Hermes Dev manager into Paperclip as an `agents` row via the `hermes_local` adapter (`adapters/registry.ts:440-500`), wired with `reportsTo` → root agent and a `budgetMonthlyCents`. The adapter host-injects `PAPERCLIP_API_KEY` (`registry.ts:468`) and `PAPERCLIP_RUN_ID` (`registry.ts:469`) into the manager process; the Hermes loop reads those from env and sends them as bearer + run-scoped header on every REST call (NFR-SEC-2). The atomic unit is "a budgeted, non-anonymous, authenticating actor exists" — registration without authentication leaves a dangling credential, and authentication without the org-chart edge leaves an orphan; both must close together for the actor to be real.

## E2E Slice

**Demonstrable behavior:** Starting the Dev manager process registers (or idempotently re-uses) a Paperclip `agents` row with `adapterType='hermes_local'`, `reportsTo`=root agent id, and a non-null `budgetMonthlyCents`; the manager then issues an authenticated probe call (`GET /api/me` / equivalent self-lookup) carrying `Authorization: Bearer <PAPERCLIP_API_KEY>` + `X-Paperclip-Run-Id: <PAPERCLIP_RUN_ID>` and receives 200 with its own `agents.id`. An org-chart walk from that agent via `reportsTo` reaches the root agent.

**Wiring closed:** On completion of this story, starting the Dev manager (`hermes` launched under the `hermes_local` adapter against `localhost:3100`) produces (1) a queryable `agents` row with `reportsTo`→root and a non-null budget, and (2) a 200 response to its authenticated self-lookup using the host-injected `PAPERCLIP_API_KEY`/`PAPERCLIP_RUN_ID` — using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P0.7 (Paperclip live + root agent / company seeded), P0.11 (secret handling: `server.secret.json` 0600 + env/secret-ref convention, NFR-SEC-1).

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given Paperclip is live at `localhost:3100` with a seeded root agent and QDS company, When the Dev manager process starts under the `hermes_local` adapter and issues its authenticated self-lookup, Then a single `agents` row exists with `adapterType='hermes_local'`, `reportsTo`=root agent id, `budgetMonthlyCents` non-null, AND the self-lookup returns HTTP 200 resolving to that same `agents.id` — the org-chart walk to root has no missing `reportsTo` hop.
2. Given the Dev manager is already registered, When the process restarts, Then registration is idempotent — no duplicate `agents` row is created (the existing row is re-used by stable identity, not re-inserted).
3. Given the host fails to inject `PAPERCLIP_API_KEY` (or it is empty), When the manager attempts any REST call, Then the call is refused before send (or the server returns 401) and the manager exits non-zero with a logged auth-misconfig reason — it never proceeds anonymously or with a hardcoded fallback key.

## Technical Notes

- **Contracts/Schema:** Reuse real Paperclip `agents` schema (`agents.ts`): `reportsTo` self-FK (`:24`, idx `:42`), `budgetMonthlyCents`/`spentMonthlyCents` (`:30-31`), `adapterType`. No new columns. Registration body sets `adapterType='hermes_local'`, `reportsTo`=root id, `budgetMonthlyCents`=configured cap. Per-agent key persisted in `agent_api_keys` table by the adapter.
- **Integration points (each wired & exercised in this story):** `hermes_local` adapter (`adapters/registry.ts:440-500`) injects `PAPERCLIP_API_KEY` (`:468`) + `PAPERCLIP_RUN_ID` (`:469`) into the manager env; Hermes REST client reads both from env and attaches `Authorization: Bearer` + run-scoped header to every request (NFR-SEC-2); org-chart edge `reportsTo`→root persisted in `agents`.
- **Files / functions touched:** Hermes-side Paperclip REST client (auth header injection from env) and the manager startup/registration routine; adapter config that selects `hermes_local` against `localhost:3100`.
- **Guards/limits:** 24/7 tool-loop is the manager's lifecycle; this story registers + authenticates only (it does not drive Archon — that is P1-later). Budget cap is set at registration; enforcement of spend-vs-cap rolls in with the cost ledger (FR-CP-12), not here.

## Files to Modify

- `hermes/src/paperclip/client.ts`
- `hermes/src/paperclip/register-manager.ts`
- `hermes/src/managers/dev-manager.ts`
- `hermes/config/hermes_local.adapter.json`
- `hermes/test/paperclip/register-manager.e2e.test.ts`

## Security Invariants

> Triggered by: auth (FR-CP-11 / NFR-SEC-2), secrets/env (NFR-SEC-1/-2).

- **INV-1 (bearer + run-scoped on every call):** Every Paperclip REST request from the Dev manager carries `Authorization: Bearer <PAPERCLIP_API_KEY>` AND the run-scoped header `X-Paperclip-Run-Id: <PAPERCLIP_RUN_ID>`. A request constructed without both is refused before transmission — there is no unauthenticated code path.
- **INV-2 (secrets from env/secret-ref only, never hardcoded):** `PAPERCLIP_API_KEY` and `PAPERCLIP_RUN_ID` are read solely from the host-injected env (adapter `registry.ts:468-469`). No key literal appears in source, config committed to git, logs, or stdout; a missing/empty key fails closed (AC-3), never falling back to a default.
- **INV-3 (no orphan / non-anonymous actor):** The registered agent has a non-null `reportsTo` resolving to the root agent — registration that cannot establish the root-terminating edge fails rather than creating an orphan (NFR-ACC-1, 0 orphans).

## Definition of Done

- [ ] **Impl:** Dev manager startup registers a `hermes_local` `agents` row with `reportsTo`=root and a non-null `budgetMonthlyCents` against `localhost:3100`.
- [ ] **Impl:** Hermes REST client attaches bearer `PAPERCLIP_API_KEY` + run-scoped `PAPERCLIP_RUN_ID` (read from injected env) to every request.
- [ ] **Impl:** Registration is idempotent on restart — existing agent re-used by stable identity, no duplicate row.
- [ ] **Contract:** Registration uses the real `agents` columns (`adapterType`, `reportsTo`, `budgetMonthlyCents`) with field validation; no schema change, no new column.
- [ ] **Integration:** `hermes_local` adapter env-injection (`registry.ts:468-469`) consumed end-to-end — manager reads the two vars and authenticates successfully.
- [ ] **Observability/Audit:** Org-chart walk from the new agent via `reportsTo` resolves to root with no missing hop (NFR-ACC-1 / §8.4 hop 4).
- [ ] **Security:** Missing/empty `PAPERCLIP_API_KEY` fails closed (non-zero exit, logged reason); no key literal in source/logs/stdout (INV-1/2).
- [ ] **Test (unit/integration):** Covers header construction (both headers present), idempotent re-registration, and the fail-closed auth-misconfig guard path.
- [ ] **Test (e2e demo — MANDATORY):** Against live `localhost:3100`, start the manager, assert the `agents` row (`adapterType='hermes_local'`, `reportsTo`=root, budget non-null) AND a 200 authenticated self-lookup resolving to that `agents.id` — proves wiring closed.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
