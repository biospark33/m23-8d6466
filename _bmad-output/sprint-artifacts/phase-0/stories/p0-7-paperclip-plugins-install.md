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

A vertical slice through the **Paperclip** layer only. It brings the live instance to
a known-good state (`localhost:3100`, company "QDS"), drives
`POST /api/plugins/install` twice (`paperclip-plugin-telegram` (npm, latest 0.6.1,
by mvanhorn) + `@vectorize-io/hindsight-paperclip`), and proves both appear via
`GET /api/plugins`. It also registers an external Hermes through the `hermes_local`
adapter so the host injects `PAPERCLIP_API_KEY` + `PAPERCLIP_RUN_ID` and the Hermes'
REST calls authenticate as a registered agent (`agent_api_keys`). One atomic 4pt
unit: the substrate is not "present" until installs land AND a registered external
agent can authenticate against it — the plugin bridge and the agent-auth path are
the same control-plane surface and are demonstrable together. Auth-dependent ACs
(AC-2, AC-3, AC-4) are exercised as code-level assertions under `local_trusted`;
server-enforced auth testing requires a non-`local_trusted` configuration.
(OQ-3 *behavior* verification of Telegram bidirectional chat is a future
successor — this story proves **installed + listed + auth**, not bidirectional chat.)

## E2E Slice

**Demonstrable behavior:** Against the live instance at `localhost:3100`, run the
install driver: `POST /api/plugins/install {packageName: env.QDS_TELEGRAM_PLUGIN_PKG
/* default "paperclip-plugin-telegram" */}` and `POST /api/plugins/install
{packageName:"@vectorize-io/hindsight-paperclip", version:"0.2.3"}`, then
`GET /api/plugins`. The response array contains BOTH plugins with
`status:"installed"`. Each entry exposes at minimum `pluginKey` (derived from the
plugin manifest `id`) and `version` matching the installed version (exact string
equality — the `version` field in the response must equal the version string sent
in the install request; for installs without an explicit `version` param, it must
equal the resolved latest version). A registered external Hermes then issues an
authenticated REST call (`GET /companies/:companyId/issues`) using its host-injected
`PAPERCLIP_API_KEY` + `PAPERCLIP_RUN_ID` and receives `200` (a call with a
missing/forged bearer receives `401`).

**Wiring closed:** On completion of this story, running `scripts/p0-bring-up.sh`
(install driver) against `localhost:3100` produces a `GET /api/plugins` body listing
both Telegram and Hindsight as `installed` AND a `200` from an authenticated
registered-Hermes REST call (with `401` on a forged bearer), using only code merged
by this story. No stub, no `TODO: wire later`, and no sibling story is required to
make this behavior real. Predecessors, if any, are dependency edges (listed below),
not unfinished wiring inside this story.

**Dependency edges (predecessors):** None — standalone. (Live `localhost:3100`
npx instance, `local_trusted`, v2026.529.0, company id
`1287bc8d-2122-4484-bc0c-900662caf8a0` is the call target, not a code dependency.)

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given Paperclip live at `localhost:3100` with no plugins
   installed (`GET /api/plugins` → `[]`), When the install driver POSTs both plugins
   to `POST /api/plugins/install` (using `packageName` from
   `QDS_TELEGRAM_PLUGIN_PKG`, defaulting to `"paperclip-plugin-telegram"`) and then
   re-reads `GET /api/plugins`, Then the response array contains exactly two entries
   whose `packageName` values match the resolved Telegram package and
   `@vectorize-io/hindsight-paperclip`, each with `status:"installed"` (no entry in
   an error/pending state).
2. Given a Hermes registered via the `hermes_local` adapter (host injected
   `PAPERCLIP_API_KEY` + `PAPERCLIP_RUN_ID`), When it calls
   `GET /companies/:companyId/issues` with
   `Authorization: Bearer <PAPERCLIP_API_KEY>` and the run-scoped header, Then the
   call returns `200`, the actor resolves to the registered agent row in
   `agent_api_keys`, and the response returns only issues belonging to the agent's
   bound company (tenant isolation verified per INV-5 — the `:companyId` in the URL
   matches the company bound to the agent's API key; a mismatch is rejected).
   > **Mode note:** Under `local_trusted`, board-participant requests bypass auth,
   > but Bearer token resolution still runs against `agentApiKeys` — the token is
   > resolved to a registered agent row even in trusted mode. AC-2 (200 with valid
   > key) and AC-3 (401 with forged key) ARE testable here. Tenant-isolation
   > (`:companyId` must match the agent's bound company) is verified as a
   > client-side contract (the test asserts the correct `:companyId` is used);
   > server-enforced tenant isolation is deferred to non-`local_trusted`.
3. Given the same endpoint, When a request omits the bearer or sends a
   forged/unknown key, Then the call returns `401` (auth gate fires; the request is
   never served as the root agent).
   > **Mode note:** Under `local_trusted`, board-participant requests bypass auth,
   > but Bearer token resolution still runs against `agentApiKeys`. A forged/unknown
   > key fails resolution, producing a `401`. This AC is fully testable here.
4. Given a non-admin caller, When it POSTs to `/api/plugins/install`, Then the
   install is rejected (NFR-SEC-4 — installs restricted to instance admins) and no
   plugin row is created.
   > **Mode note — `local_trusted` (client-side contract):** Under `local_trusted`,
   > admin-gate enforcement is a client-side contract only: the test constructs a
   > request with a non-admin key and asserts the expected rejection at the
   > application/validation layer (the client refuses to proceed with the install).
   > No server-side middleware rejection is expected in this mode.
   >
   > **Deferred acceptance item — server-enforced admin-gate:** A separate,
   > clearly-marked acceptance criterion requires server-enforced admin-gate
   > testing for non-`local_trusted` Paperclip configurations — i.e., the Paperclip
   > server middleware must reject the install request with `403` when the bearer
   > token does not resolve to an admin-scoped agent. This item is deferred to a
   > future story that configures Paperclip in non-`local_trusted` mode.
5. Given both plugins are already installed (`GET /api/plugins` lists both as
   `status:"installed"`), When the install driver re-runs (`POST /api/plugins/install`
   for each plugin with the **same version** as already installed), Then the operation
   is idempotent — no error is raised, no duplicate plugin rows are created, and
   `GET /api/plugins` still lists exactly two plugins each with `status:"installed"`.
   If the re-install specifies a **different version**, the existing plugin row is
   updated to the new version (the `version` field in `GET /api/plugins` reflects the
   newly requested version) and `status` remains `"installed"` — no duplicate row is
   created.

## Technical Notes

- **Contracts/Schema:** install request body `{ packageName: string, version?: string }`
  (validate `packageName` non-empty; `version` semver-ish string optional) per
  `server/src/routes/plugins.ts:1008` / openapi `:3385`. The `packagePath` field
  exists on `installPluginSchema` for local-path installs but is not used for npm
  installs and is omitted from the driver's request body.
  **Canonical package-name validation:** `packageName` must be non-empty, ≤256 chars,
  and match the npm package-name regex
  `^(@[a-z0-9-~][a-z0-9-._~]*/)?[a-z0-9-~][a-z0-9-._~]*$`. This single regex is
  applied by both the env-var validator (`QDS_TELEGRAM_PLUGIN_PKG`) and the
  request-body validator — no duplicate or divergent patterns. If the value fails
  validation, the driver prints a diagnostic and exits non-zero (fail-fast).
  **PluginRecord response shape:** `GET /api/plugins` returns `PluginRecord[]`
  directly (no envelope wrapper), verified against Paperclip route handler. Each
  `PluginRecord` entry must expose at minimum `pluginKey` (derived from the plugin
  manifest `id`), `version` matching the installed version (exact string equality —
  for installs with explicit `version`, the response `version` must equal the
  request `version`; for installs without `version`, it must equal the resolved
  latest), `packageName`, and `status`.
  List response read from `GET /api/plugins` (returns `[]` pre-install).
  **Telegram package resolved:** `paperclip-plugin-telegram` (npm, latest 0.6.1, by
  mvanhorn — bidirectional Telegram integration for Paperclip, built on the Paperclip
  plugin SDK (`@paperclipai/plugin-sdk`), MIT license. The plugin SDK provides the
  `PluginEventBus` singleton and worker registration hooks that the plugin runtime
  requires; the driver does not call the SDK directly — it installs the plugin via
  the Paperclip REST API and the server-side plugin loader invokes the SDK
  internally. Verified on the npm registry at
  `https://registry.npmjs.org/paperclip-plugin-telegram`. Source:
  `https://github.com/mvanhorn/paperclip-plugin-telegram`. The driver reads the
  package name from env `QDS_TELEGRAM_PLUGIN_PKG`
  (default `"paperclip-plugin-telegram"`). No DDL authored — the
  plugin/`agent_api_keys` tables already exist on the live instance.
- **Admin user seeding:** The `POST /api/plugins/install` endpoint requires admin
  privileges (NFR-SEC-4). The Paperclip `local_trusted` instance auto-seeds a default
  admin user on first boot (root agent + company "QDS" with id
  `1287bc8d-2122-4484-bc0c-900662caf8a0`). **Admin token acquisition flow:** The
  auto-seed writes the admin API key to `PAPERCLIP_ADMIN_TOKEN` in the process
  environment (the `local_trusted` boot sequence exposes it). The bring-up script
  reads `PAPERCLIP_ADMIN_TOKEN` from the env file (`config/paperclip.env`) and
  confirms admin availability by calling `GET /api/agents/me` with that bearer token.
  If the env var is unset (seed failed or first boot did not complete), the script
  exits non-zero with a diagnostic — it does NOT attempt to create an admin via DB
  insert or bootstrap CLI, keeping the flow to a single known path.
- **Integration points (each wired & exercised in this story):**
  (1) `POST /api/plugins/install` x2 -> `GET /api/plugins` round-trip.
  (2) `hermes_local` adapter injection: the adapter reads `PAPERCLIP_API_KEY` from
  process environment and passes it as the `apiKey` field to the agent invocation
  context; auth keyed via `agent_api_keys`.
  (3) Plugin event bridge: "bridge presence confirmed" means the `PluginEventBus`
  singleton exists in the Paperclip server's DI container (verified indirectly — the
  plugin SDK's worker registration hook resolves it at install time, so a successful
  install implies the bus is present). This story does NOT subscribe to events or
  assert that events fire — that belongs to Phase-1 successors. FR-CP-10
  event-subscribe *exercise* is not wired here.
- **Files / functions touched:** the install/bring-up driver and an env loader;
  no Paperclip-core source edits (live instance is the target). Reference
  `routes/plugins.ts:1008`, `adapters/registry.ts:440-500`.
- **Guards/limits:** install driver is idempotent (re-running does not create
  duplicate plugin entries; re-installing with a different version updates the
  existing row rather than duplicating it); admin-only enforced server-side
  (NFR-SEC-4).
- **Env file example:** `config/paperclip.env.example` must list all required variables. Example content:
  ```dotenv
  # Paperclip bring-up environment (copy to .env and fill values)
  QDS_TELEGRAM_PLUGIN_PKG=paperclip-plugin-telegram  # npm package name for the Telegram plugin
  PAPERCLIP_API_BASE=http://localhost:3100             # Paperclip server base URL
  PAPERCLIP_ADMIN_TOKEN=                               # Admin bearer token (seeded on first boot)
  COMPANY_ID=1287bc8d-2122-4484-bc0c-900662caf8a0      # QDS company UUID
  ```

## Files to Modify

> ≤10 unique paths.

- `scripts/p0-bring-up.sh`
- `scripts/install-plugins.ts`
- `scripts/register-hermes-agent.ts`
- `config/paperclip.env.example` — must include
  `QDS_TELEGRAM_PLUGIN_PKG=paperclip-plugin-telegram` (commented default) with a
  note that the value must be a valid npm package name; driver exits non-zero if
  unset or malformed. Must also include `PAPERCLIP_ADMIN_TOKEN` (set after first
  boot seeds the admin user).
- `tests/p0/plugins-install.e2e.test.ts`
- `tests/p0/hermes-auth.e2e.test.ts`

## Security Invariants

> REQUIRED & non-empty — auth, secrets/env, and migration/schema triggers all apply.

- **INV-1 (NFR-SEC-4 admin-gate):** `POST /api/plugins/install` is exercised only
  as an instance admin; a non-admin caller is rejected and creates no plugin row.
  The driver carries no privilege-escalation path.
  > **Client-side contract (testable here):** the install driver constructs requests
  > with the correct admin bearer and asserts rejection when a non-admin key is used.
  > **Server-enforced gate (deferred):** admin-role verification at the middleware
  > level requires non-`local_trusted` configuration.
- **INV-2 (NFR-SEC-2 bearer auth):** every registered-Hermes REST call sends
  `Authorization: Bearer <PAPERCLIP_API_KEY>` + the run-scoped `PAPERCLIP_RUN_ID`
  header; a missing/forged bearer yields `401` and is never served as the root agent.
  > **Client-side contract (testable here):** Bearer token resolution runs even under
  > `local_trusted` for agent-type tokens — the key is resolved against
  > `agentApiKeys`. A valid key produces `200`; a forged/unknown key fails resolution
  > and returns `401`. AC-2 (200) and AC-3 (401) are fully testable.
  > **Server-enforced gate (deferred):** full middleware auth enforcement for
  > non-agent request types requires non-`local_trusted` configuration.
- **INV-3 (NFR-SEC-1 secrets hygiene):** `PAPERCLIP_API_KEY`, the Telegram bot
  token, and the Telegram plugin package name are read from env/secret refs only —
  never hardcoded in scripts, never echoed to stdout/logs; any `server.secret.json`
  written is mode `0600`.
  > **Client-side contract (testable here):** the driver script and tests assert
  > secrets are sourced from env only and never appear in stdout/logs.
  > **Server-enforced gate (deferred):** server-side secret rotation and audit
  > logging require non-`local_trusted` configuration.
- **INV-4 (no schema mutation):** this story applies no migration and adds no `cost`
  column to `issues` (NFR-ACC-3); it consumes the existing on-instance schema only.
  The install path must not silently run DDL outside the live instance's own
  migration set.
- **INV-5 (tenant isolation):** The registered Hermes agent's `agent_api_keys` row
  is bound to a specific company. When the agent calls
  `GET /companies/:companyId/issues`, the `:companyId` in the URL MUST match the
  company bound to the agent's API key. A mismatch is rejected — the agent cannot
  access another company's data.
  > **Client-side contract (testable here):** the test asserts the correct
  > `:companyId` (matching the agent's bound company) is used in the request URL and
  > validates the response. **Server-enforced gate (deferred):** server-side
  > tenant-isolation enforcement (rejecting mismatched `:companyId` at the
  > middleware/query level) requires non-`local_trusted` configuration.

## Definition of Done

> 8–12 high-signal, story-specific boxes.

- [ ] **Impl:** `scripts/install-plugins.ts` POSTs both plugins to
  `POST /api/plugins/install` with validated bodies and tolerates already-installed
  (idempotent — same version is a no-op; different version updates the row).
- [ ] **Impl:** `scripts/register-hermes-agent.ts` registers an external Hermes via
  the `hermes_local` adapter and obtains its `PAPERCLIP_API_KEY` +
  `PAPERCLIP_RUN_ID`.
- [ ] **Impl:** `scripts/p0-bring-up.sh` orchestrates the install + register
  sequence against `localhost:3100` and exits non-zero if either plugin is not
  `installed`.
- [ ] **Impl (admin seed):** Admin user available before first install — bring-up
  script reads `PAPERCLIP_ADMIN_TOKEN` from env, asserts admin existence
  (via `GET /api/agents/me`), and fails fast if the token is unset or the call
  returns non-200.
- [ ] **Contract:** install request body validated (`packageName` non-empty, matches
  canonical npm-name regex; optional `version`); `QDS_TELEGRAM_PLUGIN_PKG`
  validated with the same regex (fail-fast if unset/malformed); list-response parse
  asserts `status:"installed"` for both packages and each entry exposes `pluginKey`
  (from manifest `id`) and `version` matching installed version (exact string
  equality); `GET /api/plugins` returns `PluginRecord[]` directly (no envelope).
- [ ] **Integration:** the `hermes_local` host-injection (`PAPERCLIP_API_KEY` +
  `PAPERCLIP_RUN_ID`) is wired and a registered-agent REST call resolves the actor
  against `agent_api_keys`.
- [ ] **Security:** non-admin install rejected (NFR-SEC-4); forged/missing bearer ->
  `401` (NFR-SEC-2); secrets sourced from env only and never logged (NFR-SEC-1) —
  each asserted by test.
- [ ] **Observability:** the bring-up run records the resolved plugin list and the
  auth outcome (200/401) so the substrate state is reconstructable post-run.
- [ ] **Test (unit/integration):** body-validation + admin-gate + bearer-auth paths
  covered, including the `401` forged-key guard.
- [ ] **Test (e2e demo — MANDATORY):** fire `scripts/p0-bring-up.sh` against live
  `localhost:3100`; assert `GET /api/plugins` lists BOTH plugins as `installed` AND
  the authenticated Hermes REST call returns `200` while a forged bearer returns
  `401` — proving wiring closed.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
