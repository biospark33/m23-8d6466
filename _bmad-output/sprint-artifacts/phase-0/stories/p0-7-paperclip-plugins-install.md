# P0.7: Stand up Paperclip and install the channel + memory plugins

**Story Points:** 4

## Spec Reference

- PRD §6.1 (Control-plane — Paperclip); FR-CP-9, FR-CP-10, FR-CP-11
- PRD §13 Phase 0 clause 6: "The Paperclip dashboard is reachable with the Telegram and Hindsight plugins both listed as installed."
- PRD §13 Phase-0 item 5 exit-criterion (dashboard reachable, both plugins installed); §12.2 OQ-3; NFR-SEC-1, NFR-SEC-2, NFR-SEC-4

## User Story

As the Operator,
I want Paperclip (Postgres + dashboard + root agent) standing live with the Telegram and Hindsight plugins installed via the plugin-install endpoint and an external Hermes registered + authenticating its REST calls,
so that the control plane is live with the plugin substrate present — the foundation every Phase-1 manager, cost, and audit-chain slice depends on (G1 accountable factory).

## Overview

A vertical slice through the **Paperclip** layer only. It brings the live instance to a known-good state (`localhost:3100`, company "QDS"), drives `POST /api/plugins/install` twice (Telegram external npm + `@vectorize-io/hindsight-paperclip`), and proves both appear via `GET /api/plugins`. It also registers an external Hermes through the `hermes_local` adapter so the host injects `PAPERCLIP_API_KEY` + `PAPERCLIP_RUN_ID` and the Hermes' REST calls authenticate as a registered agent (`agent_api_keys`). One atomic 4pt unit: the substrate is not "present" until installs land AND a registered external agent can authenticate against it — the plugin bridge and the agent-auth path are the same control-plane surface and are demonstrable together. (OQ-3 *behavior* verification of Telegram is the sibling P0.8 — this story proves **installed + listed + auth**, not bidirectional chat.)

## E2E Slice

**Demonstrable behavior:** Against the live instance at `localhost:3100`, run the install driver: `POST /api/plugins/install {packageName: <telegram-pkg>}` and `POST /api/plugins/install {packageName:"@vectorize-io/hindsight-paperclip", version:"0.2.0"}`, then `GET /api/plugins`. The response array contains BOTH plugins with `status:"installed"`. A registered external Hermes then issues an authenticated REST call (`GET /companies/:companyId/issues`) using its host-injected `PAPERCLIP_API_KEY` + `PAPERCLIP_RUN_ID` and receives `200` (a call with a missing/forged bearer receives `401`).

**Wiring closed:** On completion of this story, running `scripts/p0-bring-up.sh` (install driver) against `localhost:3100` produces a `GET /api/plugins` body listing both Telegram and Hindsight as `installed` AND a `200` from an authenticated registered-Hermes REST call (with `401` on a forged bearer), using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** None — standalone. (Live `localhost:3100` npx instance, `local_trusted`, v2026.529.0, company id `1287bc8d-2122-4484-bc0c-900662caf8a0` is the call target, not a code dependency. Telegram *behavior* verification is the successor edge P0.8.)

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given Paperclip live at `localhost:3100` with no plugins installed (`GET /api/plugins` → `[]`), When the install driver POSTs both plugins to `POST /api/plugins/install` and then re-reads `GET /api/plugins`, Then the response array contains exactly two entries whose `packageName` values match the Telegram package and `@vectorize-io/hindsight-paperclip`, each with `status:"installed"` (no entry in an error/pending state).
2. Given a Hermes registered via the `hermes_local` adapter (host injected `PAPERCLIP_API_KEY` + `PAPERCLIP_RUN_ID`), When it calls `GET /companies/:companyId/issues` with `Authorization: Bearer <PAPERCLIP_API_KEY>` and the run-scoped header, Then the call returns `200` and the actor resolves to the registered agent row in `agent_api_keys`.
3. Given the same endpoint, When a request omits the bearer or sends a forged/unknown key, Then the call returns `401` (auth gate fires; the request is never served as the root agent).
4. Given a non-admin caller, When it POSTs to `/api/plugins/install`, Then the install is rejected (NFR-SEC-4 — installs restricted to instance admins) and no plugin row is created.

## Technical Notes

- **Contracts/Schema:** install request body `{ packageName: string, version?: string, isLocalPath?: boolean }` (validate `packageName` non-empty; `version` semver-ish string optional) per `server/src/routes/plugins.ts:1008` / openapi `:3385`. List response read from `GET /api/plugins` (returns `[]` pre-install). Telegram package name is operator-supplied (npm name unknown on disk — OQ-3); the driver reads it from env `QDS_TELEGRAM_PLUGIN_PKG`, never hardcoded. No DDL authored — the plugin/`agent_api_keys` tables already exist on the live instance.
- **Integration points (each wired & exercised in this story):** (1) `POST /api/plugins/install` ×2 → `GET /api/plugins` round-trip. (2) `hermes_local` adapter (`adapters/registry.ts:440-500`) injecting `PAPERCLIP_API_KEY` (`:468`) + `PAPERCLIP_RUN_ID` (`:469`); auth keyed via `agent_api_keys`. (3) Plugin event bridge present (`PluginEventBus`, `services/plugin-event-bus.ts`) — its existence is confirmed by install; FR-CP-10 event-subscribe *exercise* is a P0.8/Phase-1 successor, not wired here beyond "bridge present".
- **Files / functions touched:** the install/bring-up driver and an env loader; no Paperclip-core source edits (live instance is the target). Reference `routes/plugins.ts:1008`, `adapters/registry.ts:440-500`.
- **Guards/limits:** install driver is idempotent (re-running does not create duplicate plugin entries — re-read tolerates an already-installed plugin); admin-only enforced server-side (NFR-SEC-4).

## Files to Modify

> ≤10 unique paths.

- `scripts/p0-bring-up.sh`
- `scripts/install-plugins.ts`
- `scripts/register-hermes-agent.ts`
- `config/paperclip.env.example`
- `tests/p0/plugins-install.e2e.test.ts`
- `tests/p0/hermes-auth.e2e.test.ts`

## Security Invariants

> REQUIRED & non-empty — auth, secrets/env, and migration/schema triggers all apply.

- **INV-1 (NFR-SEC-4 admin-gate):** `POST /api/plugins/install` is exercised only as an instance admin; a non-admin caller is rejected and creates no plugin row. The driver carries no privilege-escalation path.
- **INV-2 (NFR-SEC-2 bearer auth):** every registered-Hermes REST call sends `Authorization: Bearer <PAPERCLIP_API_KEY>` + the run-scoped `PAPERCLIP_RUN_ID` header; a missing/forged bearer yields `401` and is never served as the root agent.
- **INV-3 (NFR-SEC-1 secrets hygiene):** `PAPERCLIP_API_KEY`, the Telegram bot token, and the Telegram plugin package name are read from env/secret refs only — never hardcoded in scripts, never echoed to stdout/logs; any `server.secret.json` written is mode `0600`.
- **INV-4 (no schema mutation):** this story applies no migration and adds no `cost` column to `issues` (NFR-ACC-3); it consumes the existing on-instance schema only. The install path must not silently run DDL outside the live instance's own migration set.

## Definition of Done

> 8–12 high-signal, story-specific boxes.

- [ ] **Impl:** `scripts/install-plugins.ts` POSTs both plugins to `POST /api/plugins/install` with validated bodies and tolerates already-installed (idempotent).
- [ ] **Impl:** `scripts/register-hermes-agent.ts` registers an external Hermes via the `hermes_local` adapter and obtains its `PAPERCLIP_API_KEY` + `PAPERCLIP_RUN_ID`.
- [ ] **Impl:** `scripts/p0-bring-up.sh` orchestrates the install + register sequence against `localhost:3100` and exits non-zero if either plugin is not `installed`.
- [ ] **Contract:** install request body validated (`packageName` non-empty; optional `version`/`isLocalPath`); list-response parse asserts `status:"installed"` for both packages.
- [ ] **Integration:** the `hermes_local` host-injection (`PAPERCLIP_API_KEY` + `PAPERCLIP_RUN_ID`) is wired and a registered-agent REST call resolves the actor against `agent_api_keys`.
- [ ] **Security:** non-admin install rejected (NFR-SEC-4); forged/missing bearer → `401` (NFR-SEC-2); secrets sourced from env only and never logged (NFR-SEC-1) — each asserted by test.
- [ ] **Observability:** the bring-up run records the resolved plugin list and the auth outcome (200/401) so the substrate state is reconstructable post-run.
- [ ] **Test (unit/integration):** body-validation + admin-gate + bearer-auth paths covered, including the `401` forged-key guard.
- [ ] **Test (e2e demo — MANDATORY):** fire `scripts/p0-bring-up.sh` against live `localhost:3100`; assert `GET /api/plugins` lists BOTH plugins as `installed` AND the authenticated Hermes REST call returns `200` while a forged bearer returns `401` — proving wiring closed.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
