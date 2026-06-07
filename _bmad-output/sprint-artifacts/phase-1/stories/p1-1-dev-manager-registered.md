# P1.1: Dev manager registered as a budgeted `hermes_local` agent under root

**Story Points:** 3

## Spec Reference

- PRD §6.2 (Manager — Hermes), §6.1 (Control-plane — Paperclip); FR-MG-1, FR-CP-11; NFR-SEC-2, NFR-ACC-1
- Phase exit gate: PRD §13 / §6.8 Phase-1 item 1 ("Dev manager registered" — exit: appears in Paperclip agent hierarchy AND authenticates REST calls with host-injected `PAPERCLIP_API_KEY` + `PAPERCLIP_RUN_ID`).

## User Story

As the Operator,
I want the Dev manager to run as a 24/7 `hermes_local` agent that is registered under the root agent in Paperclip's agent hierarchy with a budget and authenticates every Paperclip REST call,
so that every downstream work unit is owned by a non-anonymous, budgeted actor whose chain terminates at root (G1 accountability — NFR-ACC-1, 0 orphans).

## Overview

This slice cuts Paperclip control-plane → Hermes manager. It registers the Hermes Dev manager into Paperclip as an `agents` row via the `hermes_local` adapter (`adapters/registry.ts:440-500`), wired with `reportsTo` → root agent (Paperclip's own `agents.reportsTo` self-FK — this is Paperclip's agent-hierarchy foreign key, not an organizational chart; Warren uses flat agents; Paperclip's agent table is a separate hierarchy) and a `budgetMonthlyCents` of **50000** (USD $5.00, configured in `hermes_local.adapter.json:defaultBudgetMonthlyCents`). The adapter host-injects `PAPERCLIP_API_KEY` (`registry.ts:468`) and `PAPERCLIP_RUN_ID` (`registry.ts:469`) into the manager process; the Hermes loop reads those from env and sends them as bearer + run-scoped header on every REST call (NFR-SEC-2). The atomic unit is "a budgeted, non-anonymous, authenticating actor exists" — registration without authentication leaves a dangling credential, and authentication without the hierarchy edge leaves an orphan; both must close together for the actor to be real.

## E2E Slice

**Demonstrable behavior:** Starting the Dev manager process registers (or idempotently re-uses) a Paperclip `agents` row with `adapterType='hermes_local'`, `reportsTo`=root agent id, and a `budgetMonthlyCents` of 50000 (USD $5.00); the manager then issues an authenticated probe call (`GET /api/agents/me`) carrying `Authorization: Bearer <PAPERCLIP_API_KEY>` + `X-Paperclip-Run-Id: <PAPERCLIP_RUN_ID>` and receives 200 with its own `agents.id`. A hierarchy walk from that agent via Paperclip's `reportsTo` column reaches the root agent (Paperclip agent hierarchy, independent of Warren's flat-agent topology). **Walk logic:** Starting from the registered agent, iteratively follow `reportsTo` FK: `SELECT reportsTo FROM agents WHERE id = ?`. At each step, assert the parent row exists and is non-null. The walk terminates when `reportsTo` is `NULL` (root). For this story the walk is exactly 1 hop: Dev manager → root (root has `reportsTo = NULL`). If any hop's `reportsTo` references a missing row, the walk fails rather than producing an orphan.

**Wiring closed:** On completion of this story, starting the Dev manager (`hermes` launched under the `hermes_local` adapter against `localhost:3100`) produces (1) a queryable `agents` row with `reportsTo`→root and `budgetMonthlyCents`=50000 (USD $5.00), and (2) a 200 response to its authenticated self-lookup using the host-injected `PAPERCLIP_API_KEY`/`PAPERCLIP_RUN_ID` — using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P0.7 (Paperclip live + root agent / company seeded), P0.11 (secret handling: `server.secret.json` 0600 + env/secret-ref convention, NFR-SEC-1). Budget enforcement (runtime spend tracking) is P1.13's scope. **Contract boundary:** P1.1 writes `budgetMonthlyCents` (50000 / USD $5.00) into the `agents` row at registration and exposes it via `GET /api/agents/me`; P1.13 reads that value at runtime, tracks actual spend in a `cost_events` ledger, and rejects actions when `spentMonthlyCents >= budgetMonthlyCents`. P1.1 owns the cap persistence; P1.13 owns the enforcement loop.

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given Paperclip is live at `localhost:3100` with a seeded root agent and QDS company, When the Dev manager process starts under the `hermes_local` adapter and issues its authenticated self-lookup, Then all of the following hold:
   - **(a)** A single `agents` row exists with `adapterType='hermes_local'`, `reportsTo`=root agent id, and `budgetMonthlyCents`=50000 (USD $5.00).
   - **(b)** The self-lookup returns HTTP 200 resolving to that same `agents.id`.
   - **(c)** The hierarchy walk to root via Paperclip's `reportsTo` has no missing hop (1 hop: Dev manager → root).
   - **(d)** A self-lookup with a DIFFERENT agent's key does NOT return the Dev manager's data — token-to-agent binding is unique (agent A's key resolves to agent A only, never agent B).
> **Mode note:** Under Paperclip `local_trusted`, auth middleware is not server-enforced; the REST client constructs and sends correct `Authorization` + `X-Paperclip-Run-Id` headers, verified at the code level. Server-enforced auth requires a non-`local_trusted` Paperclip configuration. However, Bearer token resolution against `agentApiKeys` DOES run even under `local_trusted` for agent-type tokens (confirmed from P0.7 verifier). AC-1 cross-agent binding IS testable — a forged key resolves to a different (or no) agent, so the binding assertion is verifiable end-to-end.
2. Given the Dev manager is already registered, When the process restarts, Then registration is idempotent — no duplicate `agents` row is created. Re-registration by the identity tuple `('hermes_local', companyId, name)` re-uses the existing row (no duplicate `agents.created`; `budgetMonthlyCents` and `reportsTo` updated if changed).
3. Given the host fails to inject `PAPERCLIP_API_KEY` (absent, empty string, or whitespace-only), When the manager attempts any REST call, Then the call is refused before send (or the server returns 401) and the manager exits non-zero with a logged auth-misconfig reason — it never proceeds anonymously or with a hardcoded fallback key.
> **Mode note:** Under Paperclip `local_trusted`, the server does not reject unauthenticated calls; the fail-closed behavior is enforced client-side (the Hermes REST client refuses to construct a request without both headers). Server-enforced auth requires a non-`local_trusted` configuration.
4. Given the host fails to inject `PAPERCLIP_RUN_ID` (absent, empty string, or whitespace-only), When the manager attempts any REST call, Then the call is refused before send and the manager exits non-zero with a logged run-id-misconfig reason — it never proceeds without run-scoping.

## Technical Notes

- **Contracts/Schema:** Reuse real Paperclip `agents` schema (`agents.ts`): `reportsTo` self-FK (`:24`, idx `:42`), `budgetMonthlyCents`/`spentMonthlyCents` (`:30-31`), `adapterType`. No new columns. Registration body sets `adapterType='hermes_local'`, `reportsTo`=root id, `budgetMonthlyCents`=50000 (USD $5.00). Per-agent key persisted in `agent_api_keys` table by the adapter.
- **Integration points (each wired & exercised in this story):** `hermes_local` adapter (`adapters/registry.ts:440-500`) injects `PAPERCLIP_API_KEY` (`:468`) + `PAPERCLIP_RUN_ID` (`:469`) into the manager env; Hermes REST client reads both from env and attaches `Authorization: Bearer` + run-scoped header to every request (NFR-SEC-2); hierarchy edge `reportsTo`→root persisted in `agents` (Paperclip's agent hierarchy, independent of Warren's flat-agent topology).
- **Files / functions touched:** Hermes-side Paperclip REST client (auth header injection from env) and the manager startup/registration routine; adapter config that selects `hermes_local` against `localhost:3100`.
- **Guards/limits:** 24/7 tool-loop is the manager's lifecycle; this story registers + authenticates only (Warren run dispatch begins at P1.3/P1.6). Budget cap is set at registration (50000 cents / USD $5.00); enforcement of spend-vs-cap rolls in with the cost ledger (FR-CP-12), not here. Budget enforcement (runtime spend tracking, over-budget rejection) is the explicit scope of P1.13 (cost ledger story). This story verifies only that: (a) the budget value is persisted non-null, (b) the field is readable via self-lookup, (c) the value matches the configured cap (50000). Cost attribution (writing to a cost ledger on each agent action) is out of scope for P1.1; it is the explicit deliverable of P1.13.
- **Terminology note:** "Dev manager" is a Hermes role name registered in Paperclip's `agents` table; it is not a Warren org-chart position. Paperclip maintains its own `agents` hierarchy via the `reportsTo` self-FK column, which is independent of Warren's flat-agent topology. The `reportsTo` field is a database foreign key within Paperclip's `agents` table (each row's `reportsTo` stores the `id` of its parent agent); it represents agent delegation/ownership, not a personnel reporting chain.
- **Endpoint note:** Self-lookup endpoint is `GET /api/agents/me` (confirmed in Paperclip `server/src/routes/agents.ts`; path verified 2026-06-06).
- **Idempotency identity key:** The identity of a `hermes_local` agent is determined by the tuple `(adapterType, companyId, name)`. On re-registration, the adapter looks up an existing `agents` row matching this tuple. If found, the existing row is re-used (budget and reportsTo updated if changed); if not found, a new row is created. The `agent_api_keys` entry is also idempotent — the same key is re-associated with the same agent. The API key alone does NOT determine identity (a re-issued key for the same agent still resolves to the same row).
- **Idempotency tuple `name` value:** `name` is set to `'dev-manager'` from `hermes_local.adapter.json:managerName` (hardcoded default: `'dev-manager'`).
- **`companyId` source:** `companyId` is read from `PAPERCLIP_COMPANY_ID` env var, validated against the seeded company at startup. Default: the QDS company seeded on first Paperclip boot.

## Files to Modify

- `hermes/src/paperclip/client.ts`
- `hermes/src/paperclip/register-manager.ts`
- `hermes/src/managers/dev-manager.ts`
- `hermes/config/hermes_local.adapter.json`
- `hermes/test/paperclip/register-manager.e2e.test.ts`

## Security Invariants

> Triggered by: auth (FR-CP-11 / NFR-SEC-2), secrets/env (NFR-SEC-1/-2).

- **INV-1 (bearer + run-scoped on every call):** Every Paperclip REST request from the Dev manager carries `Authorization: Bearer <PAPERCLIP_API_KEY>` AND the run-scoped header `X-Paperclip-Run-Id: <PAPERCLIP_RUN_ID>`. A request constructed without both is refused before transmission — there is no unauthenticated code path.
> Under `local_trusted`, the server does not reject unauthenticated calls; the invariant is enforced client-side (the Hermes REST client refuses to construct a request without both headers). Server-enforced auth requires a non-`local_trusted` configuration.
- **INV-2 (secrets from env/secret-ref only, never hardcoded):** `PAPERCLIP_API_KEY` and `PAPERCLIP_RUN_ID` are read solely from the host-injected env (adapter `registry.ts:468-469`). No key literal appears in source, config committed to git, logs, or stdout; a missing/empty key fails closed (AC-3), never falling back to a default.
- **INV-3 (no orphan / non-anonymous actor):** The registered agent has a non-null `reportsTo` resolving to the root agent — registration that cannot establish the root-terminating `reportsTo` edge fails rather than creating an orphan (NFR-ACC-1, 0 orphans).

## Definition of Done

- [ ] **Impl:** Dev manager startup registers a `hermes_local` `agents` row with `reportsTo`=root and `budgetMonthlyCents`=50000 (USD $5.00) against `localhost:3100`.
- [ ] **Impl:** Hermes REST client attaches bearer `PAPERCLIP_API_KEY` + run-scoped `PAPERCLIP_RUN_ID` (read from injected env) to every request.
- [ ] **Impl:** Registration is idempotent on restart — existing agent re-used by stable identity, no duplicate row.
- [ ] **Contract:** Registration uses the real `agents` columns (`adapterType`, `reportsTo`, `budgetMonthlyCents`) with field validation; no schema change, no new column. `budgetMonthlyCents` is set to 50000 (USD $5.00).
- [ ] **Integration:** `hermes_local` adapter env-injection (`registry.ts:468-469`) consumed end-to-end — manager reads the two vars and authenticates successfully.
- [ ] **Observability/Audit:** Test queries `SELECT reportsTo FROM agents WHERE id = ?` iteratively from the registered agent; asserts exactly 1 hop to root with no missing intermediate rows. Verified in e2e test via a dedicated helper (`walkToRoot(agentId)` returning the chain).
- [ ] **Security:** Test asserts process exit code is non-zero AND stderr/log contains the auth-misconfig reason string when `PAPERCLIP_API_KEY` is absent/empty/whitespace. Separate `grep`-based assertion confirms no key literal appears in source, logs, or stdout across the test run.
- [ ] **Test (unit/integration):** Covers header construction (both headers present), idempotent re-registration, and the fail-closed auth-misconfig guard path.
- [ ] **Test (e2e demo — MANDATORY):** Against live `localhost:3100`, start the manager, assert the `agents` row (`adapterType='hermes_local'`, `reportsTo`=root, `budgetMonthlyCents`=50000) AND a 200 authenticated self-lookup resolving to that `agents.id` — proves wiring closed.
- [ ] **Test (token-agent binding):** Self-lookup with agent A's key returns agent A's data; self-lookup with agent B's key does NOT return agent A's data — token-to-agent binding is unique.
- [ ] **Budget cap persisted and readable:** E2e test asserts `budgetMonthlyCents === 50000` in the self-lookup response body (exact integer match, not just "non-null"); also asserts the value equals the config default from `hermes_local.adapter.json:defaultBudgetMonthlyCents`. Spend-vs-cap enforcement deferred to P1.13.
- [ ] **Cost attribution wiring deferred to P1.13 (cost ledger story):** This story verifies budget non-null and readable via self-lookup (per P1.1-H3 resolution), but does not wire runtime cost attribution. P1.13 introduces `cost_events` emission and spend tracking.
- [ ] **Auth-misconfig test covers all key-absence variants:** Test covers absent key, empty-string key, and whitespace-only key — all three produce non-zero exit with auth-misconfig log.
- [ ] **Run-id-misconfig test covers all run-id-absence variants:** Test covers absent `PAPERCLIP_RUN_ID`, empty-string, and whitespace-only — all three produce non-zero exit with run-id-misconfig log (parallel to AC-3 key-absence behavior).
- [ ] **Token expiration and malformed-token test cases (non-`local_trusted` mode):** Self-lookup with an expired token (a well-formed JWT past its `exp` claim) returns `401` from the server. Self-lookup with a malformed token (random non-JWT string, truncated JWT, or structurally invalid base64) returns `401` from the server. Both are explicit DoD items — no valid-session data is returned for any invalid token variant. These assertions apply when the Paperclip server is configured in non-`local_trusted` mode where the auth middleware enforces token validation server-side.
- [ ] **Token expiration and malformed-token test cases (`local_trusted` mode):** Under `local_trusted`, server-enforced 401 for expired/malformed tokens is not expected (the auth middleware does not validate tokens server-side in this mode). Instead, the REST client validates token structure and claims client-side before sending — a malformed or expired token is refused at the client layer, no request is sent, and the test asserts that the client rejects the token with an appropriate error. This is a distinct assertion from the non-`local_trusted` server-side 401 check.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
