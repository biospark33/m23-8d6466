# DF4.1: Visualizer Port + Tunneled Auth Gate

**Story Points:** 6
**Sprint:** v5-S3

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §3.3 ("Adopt (code, with hardening): the visualizer + trace schema"), §5.1 (tiers), §6 clause 7 (trace confidentiality), §8 step 4 ("Visualizer adoption — auth, tests, per-box deploy")
- Decision register: v5 §4 **D6** (visualizer adopted nearly as-is and hardened); §9 **R10**; §10 **F11**
- Derivation source: **zero story ancestry** — derived from the SSSF reference docs plus the F11/R10 confidentiality constraints alone, per the v5 story-derivation decision register **DD-3**. No prior AC exists to carry forward; every clause below is net-new and gets full adversarial review.
- Source pattern (reference only, D10 — the visualizer is the **single** code adoption from SSSF; everything else is pattern harvest, R5 §6 fact 20): R4 §2.5 (`VIZ/server/index.ts:35, 44-56, 58-63, 96-97, 113-192`; `VIZ/src/lib/router.ts:3`), §2.6 (auth-absence findings), §2.2–§2.4 (`VIZ/server/db.ts:77-124, :329-360, :362-384`)
- Binding facts: R5 §6 facts **15**, **16**, **20**

## User Story

As the tier-1 operator,
I want the SSSF visualizer running against our own trace store behind a token gate on a loopback-bound port I reach through a tunnel,
so that I can read a run's compiled prompts, gate evidence and cost breakdown without publishing client source code to anything that can route to the box.

## Overview

The DF1.4 trace store writes a run's sessions, phases, events, envelopes, gate results, processes and
agent sessions to a WAL SQLite file keyed by `requestId`. This story stands a read-only Bun server in
front of it and ports SSSF's Vue 3 client, which drills `#/` sessions list → `#/<requestId>` swim-lane
→ `#/<requestId>/<phaseId>` phase detail carrying the compiled prompts, gate checks and cost. SSSF
ships it with **no authn, no authz, no session concept and no bind-address restriction** (R4 §2.6) and
inkwell leans wholly on exe.dev's proxy gate. Neither is acceptable: the trace holds full compiled
prompts = client source code (F11/R10). So: a gate on every route, loopback bind, tier-1 SSH forward.

## E2E Slice

**Demonstrable behavior:** Given a `trace.db` produced by a DF1.4 run, When the operator starts the
visualizer with `QDS_VIZ_TOKEN` set and opens an `ssh -L 4600:127.0.0.1:4600` forward, Then a browser
at `http://127.0.0.1:4600/` challenges for the token, renders the session, drills to the swim-lane and
opens phase detail showing the compiled system+user prompts, the gate `checks_json` evidence rows and
the cost table — while the same request with no credential returns `401` with an empty body, and a
request to the box's externally routable address is refused because nothing is listening there.

**Wiring closed:** On completion, an authenticated operator reads a real trace through a real HTTP
surface using only code merged by this story plus DF1.4 — no stub, no `TODO: wire later`, no sibling
story. DF4.2 adds tests, the Bun-API inventory and per-box deploy; it supplies none of this behavior.

**Dependency edges (predecessors):** DF1.4, DF2.9 (consumer of its NOTICE sweep — see Infra).

## Acceptance Criteria

0. **(vendoring — runs before any other AC)** Given the upstream SSSF visualizer pin supplied as an
   **explicit input** to the vendoring step — `VENDOR_VISUALIZER_REPO` and `VENDOR_VISUALIZER_SHA` env
   vars, or equivalent `--repo`/`--sha` flags to `scripts/vendor-visualizer.ts` — never read from
   `visualizer/PROVENANCE.md` itself, since that file does not exist before this step creates it, When
   the vendoring step runs against a clean checkout of this repo, Then `visualizer/` is created from
   that pinned tree and nothing else, `visualizer/LICENSE.upstream` carries the upstream MIT text
   verbatim, and `visualizer/PROVENANCE.md` is **written** — not read — recording the same repo URL,
   the commit SHA, the vendoring date and the files taken, and the vendored tree is the input to the
   repo's NOTICE sweep — a `visualizer/` tree with no `LICENSE.upstream` or no recorded SHA MUST fail
   this AC. Re-running the step against the same pin inputs is a no-op diff.
1. **(make-or-break)** Given the server process, When it starts, Then it (a) refuses to listen at all
   unless `QDS_VIZ_TOKEN` is set to ≥32 bytes, (b) passes an explicit `hostname: "127.0.0.1"` to
   `Bun.serve`, and (c) rejects every request on every route — including `GET /api/health`, the static
   branch and the one write route — that lacks `Authorization: Bearer <token>` **or** `Basic
   <base64(":"+token)>` matching under a **constant-time** compare, with `401` and an empty body.
   **DNS rebinding:** before the credential check runs, any request whose `Host` header is not
   `127.0.0.1:<port>` or `localhost:<port>` is rejected with `403` and an empty body, so a hostile page
   that resolves its own name to `127.0.0.1` cannot reach a route even to test a credential.
   **CSRF:** the one write route (`POST /api/sessions/:requestId/archive`) is decided by this table,
   evaluated top-down — the first row whose condition holds decides, and the both-absent case is
   defined rather than left to the implementation (a plain `curl` sends neither header, so rejecting
   it breaks the operator and blanket-allowing it reopens the hole). `Origin` and `Referer` are
   compared against the allowed local origin (`http://127.0.0.1:<port>` / `http://localhost:<port>`,
   matching the resolved `QDS_VIZ_PORT`) **before** credential validation runs. The comparison is on
   the **parsed origin component** — scheme, host, and port extracted via `new URL(value)` — never an
   exact string match: a real `Referer` carries a path (`http://127.0.0.1:4600/#/session`) and must
   still match; a value `new URL()` cannot parse is malformed and is rejected `403` before credential
   validation, same as foreign. A present-but-foreign
   value is rejected outright, it is never allowed to fall through to the credential check just
   because the `Host` header (checked earlier, under DNS rebinding) happened to be local. Basic is a
   browser-navigation fallback and gets reused by the browser for any request to the target origin, so
   without this comparison a cross-site `<form>` POST could still ride cached Basic credentials into
   this route:

   | # | `Origin` | `Referer` | Credential | Outcome |
   |---|---|---|---|---|
   | 1 | present, matches allowed local origin | (ignored) | any | proceed to the credential check |
   | 2 | present, foreign (does not match) | (ignored) | any | `403`, empty body — rejected before credential validation |
   | 3 | absent | present, matches allowed local origin | any | proceed to the credential check |
   | 4 | absent | present, foreign | any | `403`, empty body — rejected before credential validation |
   | 5 | absent | absent | `Bearer` | allowed — a bearer header is a custom header, so no browser attaches it cross-site without a preflight this server never answers |
   | 6 | absent | absent | `Basic` | `403`, empty body — this is exactly the shape a cross-site form POST with cached Basic credentials takes |

   So a cross-site form POST auto-attaching cached Basic credentials cannot set the archive flag
   (row 2, row 4, or row 6), while Bearer-only API clients and the operator's own `curl` — which send
   neither header — are unaffected (row 5). A same-origin browser request, where `Origin` or `Referer`
   matches the allowed local origin, proceeds to the credential check as before (row 1 or row 3).
2. Given an authenticated operator and a `requestId` present in the trace, When they walk `#/` →
   `#/<requestId>` → `#/<requestId>/<phaseId>`, Then L1 lists sessions with phases and agents embedded
   (no second request per card), L2 returns session + usage + phases + agents in one response, and L3
   renders the compiled prompts, the gate report's `checks_json` **and** `violations_json`, and the
   derived read/write token split — all keyed on `request_id`, never `adw_id`.
3. Given the trace file predates a migrated column, When a route is called, Then
   `GET /api/health` reports the degraded condition (`{ok:false, db, journal_mode}`) in every case,
   and the two remaining route classes diverge by **which** column is missing: the route(s) reading
   DF1.4's specifically-declared `optionalColumn` substitute `NULL AS <column>` for that column alone
   and keep serving `200`, re-probing on each request until the `ALTER` lands and the real value
   latches in; every other route — one that reads a column not declared `optionalColumn` — has no
   substitution defined for it and returns `500` through the `safely()` wrapper rather than taking
   the server down mid-run. The two behaviors are never both true of the same column on the same
   route: a route is either NULL-substituted for its one declared optional column, or it 500s: never
   both, and no route silently returns partial data with unmarked nulls (DF1.4 AC3).
   Given the trace file is absent or locked past `busy_timeout`, the reader cannot open it read-only
   and the process exits non-zero with a named error per INV-5 — a fatal startup failure, not a
   degraded-but-running state.
4. Given a `requestId` that does not exist, or exists with zero events, When the client polls
   `GET /api/sessions/:requestId/events?after=&limit=`, Then it receives an empty page with the cursor
   unchanged and `hasMore:false` — `200`, not `404` and not an error — with `limit` clamped to
   `MAX_LIMIT = 1000` (default 500) **before** binding.
5. Given `assertNeverPublic(port: number): never` exported from `visualizer/server/auth.ts`, When it
   is called with the visualizer's port — resolved from `QDS_VIZ_PORT` (default `4600`, validated as an
   integer in `1024–65535` at startup, refusing to bind otherwise) — Then it throws a named error, and
   no code merged by this story registers that port with any exposure path. A signature-assert test
   pins the export's name and single numeric parameter. The exposure claim is then held by a
   **port-scoped static assert**, not a bare string grep — DF2.2's driver legitimately ships all six
   exe.dev control-plane shapes, including `share port` and `set-public`, and has done since v5-S1, so
   "the shape appears anywhere under `src/providers/`" is not a defect and cannot be the assertion.
   The assert instead requires that no call site under `src/providers/` passes the resolved
   `QDS_VIZ_PORT` value to an expose / `setPublic` construction without routing it through
   `assertNeverPublic` first — it is over the *port operand's* data flow, so it stays
   green while DF2.2's shapes exist and goes red the moment the visualizer port reaches one of them
   unguarded. The **behavioral** half is DF4.2's, not this story's: `observe` is DF4.2's verb, so
   DF4.1 cannot start a visualizer to spy on. DF4.2 INV-2's fake-driver argv spy is the behavioral
   enforcement and it lands in the same sprint. This story owns the guard
   and the port contract only. The visualizer is never the box's single anonymous port (F11/R10, INV-2).

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `GET /api/health` | in-scope | `visualizer/test/auth.test.ts` | — |
| `GET /api/sessions?limit=` (L1) | in-scope | `visualizer/test/routes.test.ts` | — |
| `GET /api/sessions/:requestId` (L2) | in-scope | `visualizer/test/routes.test.ts` | — |
| `GET /api/sessions/:requestId/events?after=&limit=` (500 ms poll) | in-scope | `visualizer/test/routes.test.ts` | — |
| `GET /api/sessions/:requestId/envelopes` (L3) | in-scope | `visualizer/test/routes.test.ts` | — |
| `GET /api/sessions/:requestId/gates` (L3) | in-scope | `visualizer/test/routes.test.ts` | — |
| `GET /api/sessions/:requestId/prompts?phaseId=<id>` (L3) | in-scope | `visualizer/test/routes.test.ts` | — |
| `POST /api/sessions/:requestId/archive` — the only write | in-scope | `visualizer/test/auth.test.ts` | — |
| Static SPA asset server `GET /*` | in-scope | `visualizer/test/auth.test.ts` | — |
| Per-box start/stop via the provider `observe` verb | out-of-scope | — | DF4.2 |
| Host-side HTTP surface for cost/audit queries (SwarmClaw chassis) | out-of-scope | — | DF2.8 / DF5.3 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| Upstream SSSF checkout (vendoring source) | not on this machine — cloned at apply time from the upstream repo, pinned `<repo-url>@<commit-sha>` supplied as an explicit input to the vendoring step (env vars or CLI flags, never read back from `visualizer/PROVENANCE.md`) and then written into `visualizer/PROVENANCE.md`; `visualizer/LICENSE.upstream` carries the upstream MIT text verbatim and the tree feeds the repo NOTICE sweep | AC0: vendoring from the pin input into a clean checkout produces `visualizer/` and nothing else; re-running against the same pin input is a no-op diff. **DF2.9 relationship — consumer of an already-shipped gate, not a producer:** DF2.9 lands in v5-S2 and ships the fail-closed NOTICE sweep; this story vendors ~6 new packages into the tree that sweep runs over, so DF4.1 must leave the gate green rather than define it (DoD item below). In the other direction nothing is owed: vendoring is host-side and complete before any image is built, and DF2.9's image contract consumes the vendored tree through DF4.2's Bun-API inventory |
| Bun runtime + `bun:sqlite` readonly reader | the project's bundled bun toolchain, already the repo runtime — **no new runtime *framework***; vendoring does add the visualizer's own client toolchain (Vue 3, Vite and their peers, ~6 packages entering `bun.lock`), each of which goes through the NOTICE sweep with the vendored tree | `visualizer` added to `package.json:workspaces` **and** to the `lint` script's enumerated scope (R3 §9.1); `bun test visualizer/test` runs on the existing entry point. Biome's `.vue` support is partial, so the lint DoD is satisfied either by `biome check visualizer` exiting 0 **or** by `*.vue` sitting in biome's ignore set with `vue-tsc --noEmit` as the named substitute gate — never by a lint step that silently matches no files |
| `QDS_VIZ_PORT` listen port | host operator environment; default `4600`, validated as an integer in `1024–65535` at startup | startup refuses to bind on an unparsable or out-of-range value with a named error; the resolved port is the sole input to `assertNeverPublic` (AC5) |
| Trace DB `<data_dir>/trace.db` (DF1.4) | local filesystem inside the repo data boundary | reader opens `{ readonly: true }` at server start and asserts (never sets) `journal_mode=WAL`; `GET /api/health` answers before the first browser request |
| `QDS_VIZ_TOKEN` bearer secret | host operator environment, host-side only — never written into a box's `.env`, never passed in argv; **minted fresh per host-side server start, so restarting the host-side server *is* rotation** — nothing is persisted host-side, so there is no expiry field and no revocation list: this credential's lifetime is the host process's. That rotation rule is scoped to the host-side token only. DF4.2's per-box token is a different credential with a different rotation unit — it is file-persisted at `$HOME/.qds/viz-token` inside the box and minted once per box, so **the box, not a process restart, is its rotation unit**; a second `observe` reuses the same bytes by design (DF4.2 INV-3) | startup assertion; process exits non-zero with a named error when unset or short |
| Tier-1 SSH forward | operator-run `ssh -L <port>:127.0.0.1:<port> <box>` over the same SSH path the provider driver already uses (R4 §3.5) | e2e demo captures a `curl` succeeding through the forward and the same `curl` against the box's routable address being refused |

## Technical Notes

- **Contracts/Schema:** all routes read DF1.4's seven-table schema unchanged. `request_id` is the
  correlation key everywhere (v5 §5.2); SSSF's `adw_id` is renamed at the port boundary, not aliased,
  so no route accepts both spellings. Cost is integer micro-dollars end to end (DD-9) — never
  `costCents`, never a float — and `format.ts` renders dollars for display only.
- **Integration points:** `visualizer/server/index.ts` (`Bun.serve` routes) → `visualizer/server/auth.ts`
  (credential check, runs before every handler including the static file branch) → `visualizer/server/db.ts`
  (readonly `bun:sqlite`) → DF1.4's trace file. Client: `visualizer/src/lib/api.ts` attaches the
  `Authorization` header on every `fetch`; SSSF's bare `fetch()` calls are the thing being replaced.
- **How the browser presents the credential (derivation decision, ratified in cross-story review).**
  **Bearer is primary** (over the tier-1 forward); Basic is a browser-navigation fallback carrying
  **the same secret**, never a second password. A navigation cannot set a bearer header, so a `401`
  on the static branch — and only there — sets `WWW-Authenticate: Basic realm="qds-viz"`; the operator
  pastes the token as the password and the browser then attaches it to every asset and `fetch`. JSON
  routes stay silent; the token reaches no URL, query string, `#` fragment, history or `route` log.
- **Guards/limits:** events `limit` default 500, `MAX_LIMIT` 1000, clamped before binding; poll 500 ms
  and **only while a run's status is `running`**; `busy_timeout=5000`; `cache-control: no-store` on
  every JSON response; constant-time compare over a fixed-length digest so timing leaks no prefix.
  **No rate limiter and no lockout, by design** (R4 §2.6 item 5): loopback-only plus ≥32 bytes of
  entropy under that compare makes online guessing infeasible. The archive POST body is capped at 1 KB.
- **The eight JSON routes, by literal path (the pinned list DF4.2's suite asserts against):**
  `GET /api/health` · `GET /api/sessions?limit=` · `GET /api/sessions/:requestId` ·
  `GET /api/sessions/:requestId/events?after=&limit=` · `GET /api/sessions/:requestId/envelopes` ·
  `GET /api/sessions/:requestId/gates` · `GET /api/sessions/:requestId/prompts?phaseId=<id>` ·
  `POST /api/sessions/:requestId/archive`. Plus the static SPA branch `GET /*`. SSSF's upstream
  prompts route carries an `/agents/:agent/` path segment; we drop it rather than leave the shape
  unpinned, because our prompts are keyed by `(request_id, phase_id)` and not by agent. The selector
  is the flattened query parameter `phaseId`, validated by `SAFE_SEGMENT` like a path segment and
  rejected outright when it fails; omitting it returns every prompt for the run.
- **The prompts route reads the trace, not the disk.** SSSF reads `system.md`/`user.md` off the
  filesystem (`VIZ/server/index.ts:167-191`); our db has a copy because prompts come from `events`
  rows of type `prompt` (DF1.4 schema; written pre-execution by DF1.6 and DF3.3), so the filesystem
  read is deleted, and `SAFE_SEGMENT` + the `startsWith(root + sep)` check stay for the static
  branch (INV-3).
- **What is carried over deliberately:** the `safely()` handler wrapper, `cache-control: no-store`, the
  genuinely readonly connection with a lazily-opened writer for the single archive column, and the
  `optionalColumn` probe that re-runs while a column is missing and latches once seen.
- **Sizing and the split valve (R5 §7 names DF4 the weakest estimate in the slate).** Six points
  covers vendoring ~4,656 lines, the `adw_id`→`request_id` rename at the port boundary, and the auth
  layer. If the vendoring plus rename alone exhausts the budget, split the auth gate out as DF4.1b
  (3 pts: AC1, AC5 and the security DoD items) leaving DF4.1a with AC0 and AC2–AC4 — the same
  SPL-008 letter-suffix valve DF4.2 carries. Never ship the port without the gate merged in the same
  sprint: an ungated visualizer is INV-1's exact failure mode.
- **Deviation/assumption:** inkwell verifies its visualizer port returns 307/401 anonymously
  (`observe.just:162-167`), relying **entirely** on exe.dev's proxy auth with only ONE port ever
  anonymous. This architecture relies on none of it (the OCI enterprise tier has no proxy): AC1's gate
  is ours, so if R5 §6 fact 11's vendor-single-origin claims are wrong, nothing here is exposed.

## Observability Contract

- Every request logs `{ requestId, route, authOutcome, status, durationMs }`, where `requestId` is the
  trace correlation key when the route carries one and a minted id otherwise. **The token is never
  logged, in any form, including a truncation or a hash.**
- A `401` logs the route and the source address only — never the presented credential. Errors include
  `{ code, message, stack? }` and name the failing statement, never a row's payload.
- Sub-timings: `auth_ms`, `query_ms`; report 0 when `bun:sqlite` exposes no breakdown.

## Files to Create/Modify

Every `visualizer/**` path below is **created** by AC0's vendoring step and then modified by this
story; only `package.json` (repo root) pre-exists.

- `visualizer/PROVENANCE.md`
- `visualizer/LICENSE.upstream`
- `visualizer/server/index.ts`
- `visualizer/server/auth.ts`
- `visualizer/server/db.ts`
- `visualizer/shared/types.ts`
- `visualizer/src/lib/{api,events,format,markdown,highlight,router,models}.ts`
- `visualizer/src/{App,SessionsList,SessionCard,SessionTrace,PhaseDetail}.vue`
- `visualizer/package.json`
- `package.json`
- `bun.lock` (repo root — updated by AC0's vendoring step for the ~6 packages it adds; reviewable
  evidence that dependency resolution is reproducible, per the NOTICE-sweep DoD item)
- `visualizer/test/auth.test.ts`
- `visualizer/test/routes.test.ts`

## Security Invariants

- **INV-1 (authentication — every route, fail-closed):** no route, static or JSON, read or write, is
  reachable without a valid credential. The check runs before route dispatch, not per handler, so a
  route added later is gated by default. An unset or short `QDS_VIZ_TOKEN` prevents the listener from
  binding at all — the server never starts in an ungated state, and never falls back to "open in dev".
  **No CORS, ever:** no response on any route, at any status, carries an `Access-Control-Allow-*`
  header, and no `OPTIONS` preflight is answered affirmatively — asserted on a `200` and on a `401`,
  because a permissive header would let a hostile origin read the trace with the browser's cached
  Basic credential even behind the `Host` check of AC1(c).
- **INV-2 (confidentiality — never the shared public port):** the visualizer binds `127.0.0.1` and is
  reached only through a tier-1 SSH forward. The box's one anonymous public port is never the
  visualizer's: `assertNeverPublic` raises on that port, and DF4.2 routes the provider's `share port` /
  `set-public` verbs through the same guard (F11/R10). Harvested traces stay inside the same
  data boundary as the repo (DF1.4 INV-1); this story adds no path that copies trace rows outside it.
- **INV-3 (input validation, ordered):** path segments match `SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/` and
  are **rejected outright rather than sanitized**; the static branch re-checks the resolved path still
  starts with the asset root. All SQL is parameterized; `limit` is clamped and `after`, when
  present and non-empty, is rejected unless a non-negative integer — never coerced; an omitted or
  empty `after` represents the initial cursor (rowid 0). This ordering rule covers **path, query and
  body validation only** — `requestId`, `phaseId`, `limit`, `after`, and the archive route's body all
  run after credential validation, so an unauthenticated caller cannot probe the validator. AC1's
  `Host` check and the CSRF `Origin`/`Referer` table are the **named exception**: both are mandatory
  pre-authentication gates by AC1's own text, ordered ahead of the credential check precisely because
  they decide whether the request is even eligible to present a credential (DNS rebinding, cross-site
  form POST) — they are not part of this INV's "after authentication" scope.
- **INV-4 (write scoping):** exactly one write exists in the whole surface — `sessions.archived`, one
  integer column — on a lazily-opened second connection. Every read connection is
  `{ readonly: true }`, so no route can `ALTER` the schema or change `journal_mode`; it asserts and
  warns instead. The archive route is authenticated like every other (SSSF's is not — R4 §2.6 item 2).
- **INV-5 (fail-closed on control unavailability):** if the token cannot be read, if the loopback bind
  is refused, or if the reader cannot open the trace read-only, the process exits non-zero with a named
  error. It never degrades to `0.0.0.0`, never serves without a token, and never opens the trace
  writable to "recover".

## Definition of Done

- [ ] **Impl (vendoring):** `visualizer/` vendored from the pinned upstream SHA with
      `LICENSE.upstream` and `PROVENANCE.md` present, and the tree registered as an input to the
      repo's NOTICE sweep (AC0).
- [ ] **Integration (NOTICE sweep stays green):** with `visualizer` registered as a workspace,
      `bun run notice:sweep` (DF2.9's fail-closed gate, merged in v5-S2) exits 0 over the vendored
      tree and the ~6 packages it adds to `bun.lock`, and the resulting NOTICE diff is committed in
      this story. A sweep left red, or a NOTICE diff left uncommitted, MUST fail this item.
- [ ] **Impl:** `Bun.serve` started with an explicit `hostname: "127.0.0.1"` and a pre-dispatch
      credential check covering JSON routes, the archive write, and the static branch.
- [ ] **Impl:** three drill levels render against DF1.4's schema keyed on `request_id` — L3 shows
      compiled prompts, gate `checks_json` + `violations_json`, and the derived read/write token split.
- [ ] **Impl:** prompts served from the trace store; the filesystem prompt-read route is deleted, not
      left disabled.
- [ ] **Contract:** events route returns `{ rows, cursor, hasMore }` ordered by rowid with `limit`
      clamped to `MAX_LIMIT = 1000` / default 500 before binding.
- [ ] **Integration:** `visualizer` registered in `package.json:workspaces` and in the enumerated
      `lint` scope, with `biome check visualizer` exiting 0 or `*.vue` in biome's ignore set and
      `vue-tsc --noEmit` passing as the named substitute gate; the readonly reader asserts
      `journal_mode=WAL` and warns when it is not.
- [ ] **Security:** startup refuses to bind without a ≥32-byte token and compares constant-time;
      `assertNeverPublic` throws on the visualizer port and nothing here registers it for exposure
      (INV-1, INV-2, INV-5). A redaction test asserts that no line logged during a `401` or a `200`
      contains the token or any prefix of it. Exposure is held by AC5's port-scoped static assert —
      no `src/providers/` call site passes the resolved `QDS_VIZ_PORT` into an expose / `setPublic`
      construction without `assertNeverPublic` — which may not be a bare textual search for the
      shapes, since DF2.2 ships them legitimately. The behavioral argv spy is DF4.2 INV-2's (AC5).
- [ ] **Test (unit):** every route, called **with an allowed `Host`**, with no / malformed /
      wrong-but-same-length credential returns `401` with an empty body, and `WWW-Authenticate`
      appears on the static branch only — an implementation that gates only the `/api/*` prefix and
      leaves the static branch open MUST fail this test. (The foreign-`Host` case is a separate `403`
      assertion — see the browser-attack-surface test below — since AC1's DNS-rebinding check runs
      before the credential check and a foreign `Host` never reaches it.)
- [ ] **Test (browser-attack surface):** a request with a foreign `Host` header gets `403` **before**
      the credential check; no response on any route at `200` or `401` carries an
      `Access-Control-Allow-*` header (AC1(c), INV-1).
- [ ] **Test (CSRF decision table — four combinations):** `POST /api/sessions/:requestId/archive` is
      exercised once per non-local-origin case of AC1's table — (1) foreign `Origin` (table row 2),
      (2) no `Origin` + foreign `Referer` (table row 4), (3) neither header + `Bearer` (table row 5),
      (4) neither header + `Basic` (table row 6) — asserting `403` on cases 1, 2 and 4 and success on
      case 3. An implementation that leaves the both-absent case undefined, that rejects case 3, or
      that proceeds to the credential check for a foreign `Origin`/`Referer` MUST fail this test.
- [ ] **Test (startup failure — fatal):** trace file absent, or locked past `busy_timeout`, at server
      start → the reader cannot open it read-only and the process **exits non-zero** with a named
      error and never binds (AC3 second sentence, INV-5). An implementation that starts degraded here
      MUST fail this test.
- [ ] **Test (runtime degradation — stays up):** a trace that predates a migrated column, or is
      removed or locked *after* a successful start → `/api/health` reports `{ok:false, db,
      journal_mode}` and **the process stays up**; the route reading the declared `optionalColumn`
      returns `200` with `NULL AS <column>` while the column is missing and real values once the
      `ALTER` lands mid-process; every other affected route returns `500` via `safely()`.
- [ ] **Test (empty boundary):** unknown `requestId` and event-less `requestId` → `200` with an empty
      page, cursor unchanged, `hasMore:false`; `limit=99999` clamps to 1000; `after=-1` is rejected.
- [ ] **Test (e2e demo — MANDATORY):** run a DF1.4 pipeline, start the visualizer, and capture as
      artifacts (a) the L3 phase-detail response showing compiled prompts + gate checks + cost, fetched
      through the SSH forward with a bearer token, and (b) the same request without the token returning
      `401`, and (c) a connection attempt to the box's routable address being refused.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
