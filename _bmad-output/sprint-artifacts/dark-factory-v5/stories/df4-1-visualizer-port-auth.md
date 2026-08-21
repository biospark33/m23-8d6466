---
baseline_commit: 31c4a0d20e015eee5ff2da3c7b5ccf0d06ca676f
---

# DF4.1: Visualizer Port + Tunneled Auth Gate

**Status:** review
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

- [x] **Impl (vendoring):** `visualizer/` vendored from the pinned upstream SHA with
      `LICENSE.upstream` and `PROVENANCE.md` present, and the tree registered as an input to the
      repo's NOTICE sweep (AC0).
- [x] **Integration (NOTICE sweep stays green):** with `visualizer` registered as a workspace,
      `bun run notice:sweep` (DF2.9's fail-closed gate, merged in v5-S2) exits 0 over the vendored
      tree and the ~6 packages it adds to `bun.lock`, and the resulting NOTICE diff is committed in
      this story. A sweep left red, or a NOTICE diff left uncommitted, MUST fail this item.
- [x] **Impl:** `Bun.serve` started with an explicit `hostname: "127.0.0.1"` and a pre-dispatch
      credential check covering JSON routes, the archive write, and the static branch.
- [x] **Impl:** three drill levels render against DF1.4's schema keyed on `request_id` — L3 shows
      compiled prompts, gate `checks_json` + `violations_json`, and the derived read/write token split.
- [x] **Impl:** prompts served from the trace store; the filesystem prompt-read route is deleted, not
      left disabled.
- [x] **Contract:** events route returns `{ rows, cursor, hasMore }` ordered by rowid with `limit`
      clamped to `MAX_LIMIT = 1000` / default 500 before binding.
- [x] **Integration:** `visualizer` registered in `package.json:workspaces` and in the enumerated
      `lint` scope, with `biome check visualizer` exiting 0 or `*.vue` in biome's ignore set and
      `vue-tsc --noEmit` passing as the named substitute gate; the readonly reader asserts
      `journal_mode=WAL` and warns when it is not.
- [x] **Security:** startup refuses to bind without a ≥32-byte token and compares constant-time;
      `assertNeverPublic` throws on the visualizer port and nothing here registers it for exposure
      (INV-1, INV-2, INV-5). A redaction test asserts that no line logged during a `401` or a `200`
      contains the token or any prefix of it. Exposure is held by AC5's port-scoped static assert —
      no `src/providers/` call site passes the resolved `QDS_VIZ_PORT` into an expose / `setPublic`
      construction without `assertNeverPublic` — which may not be a bare textual search for the
      shapes, since DF2.2 ships them legitimately. The behavioral argv spy is DF4.2 INV-2's (AC5).
- [x] **Test (unit):** every route, called **with an allowed `Host`**, with no / malformed /
      wrong-but-same-length credential returns `401` with an empty body, and `WWW-Authenticate`
      appears on the static branch only — an implementation that gates only the `/api/*` prefix and
      leaves the static branch open MUST fail this test. (The foreign-`Host` case is a separate `403`
      assertion — see the browser-attack-surface test below — since AC1's DNS-rebinding check runs
      before the credential check and a foreign `Host` never reaches it.)
- [x] **Test (browser-attack surface):** a request with a foreign `Host` header gets `403` **before**
      the credential check; no response on any route at `200` or `401` carries an
      `Access-Control-Allow-*` header (AC1(c), INV-1).
- [x] **Test (CSRF decision table — four combinations):** `POST /api/sessions/:requestId/archive` is
      exercised once per non-local-origin case of AC1's table — (1) foreign `Origin` (table row 2),
      (2) no `Origin` + foreign `Referer` (table row 4), (3) neither header + `Bearer` (table row 5),
      (4) neither header + `Basic` (table row 6) — asserting `403` on cases 1, 2 and 4 and success on
      case 3. An implementation that leaves the both-absent case undefined, that rejects case 3, or
      that proceeds to the credential check for a foreign `Origin`/`Referer` MUST fail this test.
- [x] **Test (startup failure — fatal):** trace file absent, or locked past `busy_timeout`, at server
      start → the reader cannot open it read-only and the process **exits non-zero** with a named
      error and never binds (AC3 second sentence, INV-5). An implementation that starts degraded here
      MUST fail this test.
- [x] **Test (runtime degradation — stays up):** a trace that predates a migrated column, or is
      removed or locked *after* a successful start → `/api/health` reports `{ok:false, db,
      journal_mode}` and **the process stays up**; the route reading the declared `optionalColumn`
      returns `200` with `NULL AS <column>` while the column is missing and real values once the
      `ALTER` lands mid-process; every other affected route returns `500` via `safely()`.
- [x] **Test (empty boundary):** unknown `requestId` and event-less `requestId` → `200` with an empty
      page, cursor unchanged, `hasMore:false`; `limit=99999` clamps to 1000; `after=-1` is rejected.
- [x] **Test (e2e demo — MANDATORY):** run a DF1.4 pipeline, start the visualizer, and capture as
      artifacts (a) the L3 phase-detail response showing compiled prompts + gate checks + cost, fetched
      through the SSH forward with a bearer token, and (b) the same request without the token returning
      `401`, and (c) a connection attempt to the box's routable address being refused.

## Dev Agent Record

### Implementation Plan (as executed)

1. **AC0 vendoring first** (runs before every other AC): wrote `scripts/vendor-visualizer.ts` —
   a pure copier taking the pin as explicit input only (`--repo`/`--sha` flags over
   `VENDOR_VISUALIZER_REPO`/`VENDOR_VISUALIZER_SHA` env; full-40-hex SHA enforced; never reads
   `PROVENANCE.md` back). Vendored 33 files from
   `https://github.com/disler/super-simple-software-factory@de31374882e7a4e3e5b7bb9bd09e69dc2f779356`
   into `visualizer/` (excluding upstream `bun.lock`; `dist/`/`node_modules/` guards), wrote
   `PROVENANCE.md` (repo, SHA, date, file list) + `LICENSE.upstream` (upstream MIT, verbatim).
   Re-run at the same pin: exit 0, zero diff (idempotence verified). Registered `visualizer` in
   `package.json:workspaces` and the enumerated `lint` scope; `bun install` refreshed the root
   `bun.lock` (+116 package entries: vue/vite/vue-tsc/oxlint chains + platform binaries).
2. **Server half (TDD — both test files written first, RED confirmed, then implementation)**:
   - `visualizer/server/auth.ts` (184 lines): `VizError` (named errors, code+remediation, repo
     pattern), `assertNeverPublic(port):never`, `validateToken` (QDS_VIZ_TOKEN ≥32 bytes),
     `validatePort` (default 4600, integer 1024–65535 — validated app-side because Bun 1.2.x
     does not throw on bad ports), `checkHost` (127.0.0.1|localhost:<port>, pre-credential),
     `checkCsrf` (AC1 table top-down; `new URL` component comparison, never string match),
     `checkCredential` (Bearer or Basic base64(":"+token) — same secret; sha256 digest both
     sides then `timingSafeEqual` on fixed 32-byte digests so neither content nor length leaks).
   - `visualizer/server/index.ts` (451 lines): single `fetch` dispatcher (NOT Bun's routes
     object — INV-1's "before route dispatch, not per handler" means the gate must be
     structurally ahead of routing, so a route added later is gated by construction). Order:
     Host check → CSRF (archive only) → credential → 8-route regex table → `safely()` handler
     wrapper → gated static SPA fallback. `hostname: "127.0.0.1"`; 401/403 with empty bodies;
     `WWW-Authenticate: Basic realm="qds-viz"` on the static branch's 401 only; no CORS at any
     status, OPTIONS never affirmed; per-request structured log
     `{requestId, route, authOutcome, status, durationMs, auth_ms, query_ms, source}`.
   - `visualizer/server/db.ts` (518 lines): readonly connection (busy_timeout=5000, journal_mode
     asserted-never-set, warns non-wal), lazily-opened writer only for `setArchived` —
     upstream's defenses lifted intact. `adw_id`→`request_id` everywhere (no dual spelling),
     µ$ integer costs end-to-end, events page `{rows, cursor, hasMore}` rowid-ordered,
     prompts from `events` rows `type='prompt'` (filesystem prompts route + `/agents/:agent/`
     shape deleted, `sessionsDir` plumbing removed), upstream batch-IN phase/agent embedding
     kept for L1. DB path: `--db` > `QDS_VIZ_DB` > `${QDS_RUN_ROOT ?? "/run"}/trace/trace.db`
     (mirrors DF1.4's own resolution, `pipeline-run.ts:414,502`).
   - `visualizer/shared/types.ts` (326 lines): Session mapped to exactly DF1.4's sessions
     columns; `EventsPage{rows,cursor,hasMore}`; `PromptEvent` added (real DF1.4 writer shape:
     `name` = agent role, `payload_json` = `{agentId, prompt, model}` per
     `src/phase-engine/phases/dispatch-task.ts:227`); fs-era `AgentPrompts`/`PromptsResponse`
     deleted; type fields with no DF1.4 column dropped.
3. **Client half**: `src/lib/api.ts` one `authedFetch` wrapper + `setToken()` (module-memory
   bearer only; bare fetch rides the browser's cached Basic — the token reaches no URL,
   fragment, storage or log); `fetchPrompts(requestId, phaseId)` against the new trace-backed
   route; `fmtCost` renders integer µ$→dollars at display only; `adw_id`→`request_id` across
   router/api/components; PhaseDetail prompts panel re-keyed per phase; events consumers moved
   to `{rows, cursor, hasMore}`; upstream `adw_name` UI row deleted.
4. **Workspace integration**: `biome.json` ignores `**/*.vue` (partial .vue support) with the
   named substitute gate `bun run typecheck:visualizer` (`vue-tsc --noEmit`) — neither a lint
   step that matches no files nor silent skipping.
5. **NOTICE sweep (consumer of DF2.9's gate)**: the image `deps` stage installs only
   `@mariozechner/pi-coding-agent@0.55.0`, so the visualizer's host-side packages never enter
   the image tree — DF2.9's story pre-named this exact follow-up ("widening the sweep"). The
   116 newly-added `bun.lock` packages were materialized into a scratch tree and swept:
   exit 0 (48 present locally incl. the darwin platform set, 0 denied, NOTICE 4,533 B) after
   adding the one missing canonical SPDX text (`oci/license-texts/OFL-1.1.txt` for
   `@fontsource/play`). Evidence committed:
   `sprint-artifacts/dark-factory-v5/evidence/df4-1-sweep-summary.json` + NOTICE copy. The full
   repo `node_modules` is NOT the sweep surface by design: it carries `@mariozechner/clipboard*`
   (optional, image build drops them via `--omit=optional`, denied elsewhere).
6. **E2E demo**: trace seeded through DF1.4's real Tracer (2 phases, 4 prompt events, 2 gate
   results, 1 envelope, 1 agent_session, agent_start/agent_end usage, total_cost 250,000 µ$ /
   430 tokens) → `_bmad-output/evidence/df4-1/demo-trace.db`; gated server booted on
   127.0.0.1:4600; captured to `e2e-demo.json`: (a) L3 phase detail through the gate (prompts
   builder/reviewer with payload_json, gates with checks_json+violations_json, cost µ$, usage
   split 150/80), (b) same request without credential → 401 with 0-byte body, (c) curl to the
   routable LAN address (192.168.1.7:4600) → connection refused (loopback-only bind), and the
   server log contains no token. SSH-forward capture: see Debug Log.

### Debug Log

- **WAL copy trap**: copying a live WAL-mode `trace.db` without checkpointing yields a file
  with no tables (schema still in the `-wal`). Demo seeding now runs
  `PRAGMA wal_checkpoint(TRUNCATE)` through a second connection before the copy.
- **Prompt payload shape**: research said `name`='system'|'user'; the actual DF1.4 writer
  (dispatch-task.ts:227) emits `name`=agent role ("builder"/"reviewer") and
  `payload_json`=`{agentId, prompt, model}`. Client extracts `.prompt` (bare-JSON-string
  fallback); server serves rows verbatim; types document the real shape.
- **Bun 1.2.x port lies**: binding an invalid or in-use port does not throw (verified
  empirically) — `validatePort` runs before `Bun.serve`, INV-5's refusal is ours.
- **`NaN` global**: upstream `format.ts` tripped biome `useNumberNamespace` → `Number.NaN`.
- **vue-tsc unused-param**: one `req` param in a route handler → `_req`.
- **tsconfig never-narrowing**: `fail()`/`fatal()` had to be function declarations, not arrow
  consts, for TS to accept `refuseExistingTree(): never`.
- **sshd disabled on the dev Mac** (port 22 refused): Remote Login was enabled mid-story and the
  literal forward capture then succeeded — `ssh -f -N -L 14600:127.0.0.1:4600 steve@localhost`
  over the real macOS sshd, requests through it with `Host: 127.0.0.1:4600` (the operator flow
  is same-port `ssh -L 4600:127.0.0.1:4600` on the operator's machine, where local 4600 is free;
  single-machine capture forwards 14600 since the server holds 4600 here, with Host pinned to
  the exact value the operator's browser sends — byte-identical at the server socket). Through
  the forward: bearer → 200 (prompts builder/reviewer + 2 gate rows with checks_json and
  violations_json), no credential → 401 with 0-byte body. A first attempt without the pinned
  Host header (`Host: 127.0.0.1:14600`) got 403 empty — the DNS-rebinding gate rejecting a
  foreign Host before credentials, exactly as designed; recorded in `e2e-demo.json`. A Docker
  `--network host` sshd fallback was tried first and abandoned: Docker Desktop's host network
  is the VM's, not macOS's.
- **Pre-PR self-review round (3 FIX-FIRST findings, all fixed + regression-tested, 78→81
  tests)**:
  1. `decodeURIComponent` on the route param ran BEFORE the auth gate — a malformed
     percent-encoding (`/api/sessions/%E0%A4%A`) crashed into Bun's fallback 500 HTML page
     instead of 401/empty, with no structured log line. Fixed: the log line's requestId uses the
     RAW segment (never decode untrusted input pre-gate); post-gate decoding goes through
     `decodeSegment()` (try/catch → null → 400 named error), covering the second decode site
     whose try had only a finally.
  2. Archive route failed open: a non-empty unparseable JSON body archived the session
     (contradicting its own comment). Fixed: empty body → default `archived=true`; non-empty
     invalid JSON → 400, no write (regression test also verifies the row was NOT flipped).
  3. `usage()` parsed snake_case `agent_end` payload keys while every real contract is
     camelCase (`SendUsage`/`UsageBreakdown` at `src/phase-engine/usage.ts:31-50`,
     `AgentEndEvent` at `src/phase-engine/types.ts:294-306`) — the fixture had invented the
     snake_case shape, making the green test vacuous. Fixed: camelCase-first with the vendored
     snake spelling as heritage fallback; fixture now seeds the real AgentEndEvent shape
     (`{usage:{inputTokens,cacheReadTokens,cacheWriteTokens,outputTokens,reasoningTokens,
     costMicros,sends}, contextTokens, contextWindow}`), so L2's read=150/written=80 exercises
     the real path.
  Also from that round: SessionTrace polling now stops on terminal status (Technical Notes'
  "only while running"), and one Bun-port Debug Log claim above was corrected — empirically
  `Bun.serve` DOES throw on an in-use port; the app-side pre-bind validation stands regardless
  because range/integer checks are ours, not Bun's.
- **Known dev-only wart (accepted, not a production surface)**: archiving through the Vite dev
  proxy (`bun run dev:all`) always CSRF-403s — `changeOrigin` fixes `Host` but the browser's
  `Origin: http://localhost:4601` forwards untouched, which is foreign against the server's
  allowed `:4600` origins. The production path (built `dist/` served same-origin) is unaffected;
  in dev, archive via the API or open the server origin directly.

### Completion Notes

- Tests: 78/78 across `visualizer/test/{auth,routes}.test.ts` (235 expects); full repo suite
  2,382 tests / 0 fail / 2 pre-existing todos; `bunx tsc --noEmit` clean; `vue-tsc --noEmit`
  clean; `biome check visualizer` exit 0 (repo-wide `bun run lint` still fails on 7 pre-existing
  `useTemplate` findings in `tests/providers/cap-hit-demo.test.ts`, untouched by this story —
  present since df2-4's 8332294).
- `assertNeverPublic` exposure claim held by the port-scoped static assert in `auth.test.ts`:
  operand-granular (QDS_VIZ_PORT / viz-port / 4600 tokens) over `src/providers/**` — green over
  DF2.2's legitimate `share`/`port` shapes in `driver.ts`/`exedev/driver.ts:248`, red the moment
  the viz port operand reaches one unguarded.
- Declared `optionalColumn`: `sessions.pipeline_name` (the port of SSSF's `adw_name` probe —
  the one column DF1.4's migrations.ts/reader.ts probe with NULL-substitution). Verified:
  200-with-NULL while missing → real value latches after mid-process `ALTER`; other missing
  columns (`archived` dropped in test) → 500 via `safely()`, process stays up.
- Deviations ratified in-story: CSRF both-absent with a non-Basic credential proceeds to the
  credential check (401) — AC1's table only distinguishes Bearer/Basic in that row; upstream
  probed several optional columns, we probe exactly one per the "never both" rule.
- Upstream branding kept verbatim (index.html title, `sssf-visualizer` package name) — "adopt
  nearly as-is" (D6); PROVENANCE.md records the tree's origin and the local-modification list.
- Live curl smoke beyond the suite: anon 401 empty, bearer 200 health, prompts served, foreign
  Host 403 pre-credential, Basic-no-Origin archive POST 403 (CSRF row 6).

### File List

Created: `scripts/vendor-visualizer.ts`, `visualizer/PROVENANCE.md`, `visualizer/LICENSE.upstream`,
`visualizer/server/auth.ts`, `visualizer/test/auth.test.ts`, `visualizer/test/routes.test.ts`,
`visualizer/test/fixtures/trace-fixture.ts`,
`_bmad-output/sprint-artifacts/dark-factory-v5/evidence/df4-1-sweep-summary.json`,
`_bmad-output/sprint-artifacts/dark-factory-v5/evidence/df4-1-NOTICE-workspace-packages.txt`,
`_bmad-output/evidence/df4-1/demo-trace.db`, `_bmad-output/evidence/df4-1/e2e-demo.json`,
`oci/license-texts/OFL-1.1.txt`, and the 33 vendored files under `visualizer/` (26
source/config + 7 public assets, per PROVENANCE.md).
Modified: `visualizer/server/index.ts`, `visualizer/server/db.ts`, `visualizer/shared/types.ts`,
`visualizer/src/lib/{api,format,router,types}.ts`, `visualizer/src/App.vue`,
`visualizer/src/{SessionsList,SessionCard,SessionTrace}.vue`,
`visualizer/src/components/{PhaseDetail,StatChip}.vue`, `visualizer/vite.config.ts`,
`package.json` (workspaces, lint scope, typecheck:visualizer), `biome.json` (`**/*.vue` ignore),
`bun.lock` (+116 packages), `_bmad-output/sprint-artifacts/sprint-status.yaml` (status).
Deleted: nothing pre-existing (upstream's fs-prompts route and `AgentPrompts` types were removed
from the vendored copy before first commit, so they never land).

### Change Log

- **2026-08-21** — DF4.1 implemented: vendoring (AC0), auth gate + loopback bind + CSRF/Host
  defenses (AC1, INV-1/2/5), three drill levels on `request_id` (AC2), optionalColumn
  degradation split (AC3), events cursor contract (AC4), assertNeverPublic + port-scoped static
  assert (AC5), workspace/lint/NOTICE integration, 78 focused tests, e2e evidence.
- **2026-08-21** — pre-PR self-review round: 3 FIX-FIRST bugs fixed with regression tests
  (pre-gate decode crash, archive fail-open on malformed JSON, usage-split camelCase contract)
  + SessionTrace terminal-status polling gate; 81/81 green, vue-tsc/tsc/biome clean.

---

### Review Round 1

Eight-agent adversarial review of PR #124 (four blind chunk reviewers, two repo-aware edge
reviewers, a vendoring/provenance parity reviewer, a spec/AC auditor), plus the 13 findings the
Sift bot left on the PR. CodeRabbit produced no review on this PR — it hit its Fair-Usage review
limit before running. Findings were deduped to a triage ledger, then fixed by six disjoint
file-cluster agents (wave 1: source) and two test agents (wave 2: tests).

**Patched — BLOCKER**

- [x] **L3 cost table was dead against every real trace.** `visualizer/shared/types.ts`'s
  `UsageBreakdown` was the un-ported upstream SSSF shape — snake_case with five per-component
  costs. DF1.4 actually writes `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
  reasoningTokens, costMicros, sends}` (`src/phase-engine/usage.ts:41-49`, emitted at
  `src/phase-engine/agents/retry.ts:142-151`) — camelCase, and **one** cost figure, not five.
  Every row of the cost table rendered the literal string `NaN` and the `thinking` row computed
  `undefined * undefined / undefined`. This falsified the E2E Slice's own stated behaviour
  ("phase detail showing … the cost table") and spec §3.3's "cost breakdown". The Debug Log's
  round-3 fix corrected the *server* half only; the client half and the shared type were never
  touched, and nothing caught it — there are no client tests, and `vue-tsc` was green because
  the type was a self-consistent lie. Type corrected to the real shape (camelCase-first, snake
  heritage fallback, matching the precedent `db.ts` already set); the panel now renders
  per-component **token** rows with a single total cost, omits rows the tracer never wrote
  rather than inventing zeros, and reports `partial` truthfully.
- [x] **Runaway cursor-pagination loop** in `SessionTrace.vue` and `SessionCard.vue`. Nothing
  required the cursor to advance, so a page with `hasMore: true` and a non-advancing cursor
  spun forever at 1000 rows per iteration inside a 500 ms interval — one runaway loop per
  rendered card. A non-numeric `page.cursor` also poisoned it to `NaN` permanently, refetching
  the entire history every 500 ms. Now requires a finite, strictly-increasing cursor and bounds
  the loop.
- [x] **AC1(b) loopback bind was unasserted.** Deleting `hostname: "127.0.0.1"` from
  `Bun.serve` left the whole suite green — every request targets loopback anyway, so a
  `0.0.0.0` bind is indistinguishable. INV-2's confidentiality claim rested on an untested
  line. Now pinned.

**Patched — HIGH**

- [x] **Unauthenticated source disclosure via a missing `Host` header.** Found by the test wave
  and confirmed live: `new URL(req.url)` sat ahead of `handle()`'s `try`, so `GET /api/health
  HTTP/1.0` with no Host (or `Host:` empty) threw before the gate — 500 carrying ~67 KB of
  Bun's error overlay including absolute filesystem paths and dispatcher source lines, on a
  pre-auth path reachable with one socket write and no credential, and with no `viz_request`
  log line at all. Now answered as the bodyless 403 the Host gate owes it, and logged.
- [x] `/api/sessions/:id/prompts` was an unbounded read of the largest blobs in the trace — no
  LIMIT, no cursor, while `events()` immediately above it clamped correctly. Introduced by our
  port (upstream read two files off disk). Now clamped like `events()` and honours `?limit=`.
- [x] `router.ts` threw `URIError` at module evaluation on a malformed hash (`#/%`), before
  `createApp().mount()` — a white screen from a pasted link, no auth required.
- [x] `serveStatic` was the one branch outside `safely()`, and `handle()` had a `finally` but
  no `catch`, so a static-path throw escaped into Bun's default error handler.
- [x] No polling path backed off on failure: 2 requests/second per mounted component, forever,
  against a dead server.
- [x] `SessionTrace` never reset on a `requestId` prop change — rendered session A's events and
  cursor under session B's phases with `loaded` still true.
- [x] The vendoring script's own recovery instruction (`rm -rf visualizer/`) silently stripped
  all 13 hardened files while the regenerated `PROVENANCE.md` kept asserting the hardening was
  present. Made destructive-path costs explicit and guarded.
- [x] **AC5's exposure assert was vacuously green.** It greps `src/providers/**` for
  `QDS_VIZ_PORT` / `viz-port` / `4600` and requires `assertNeverPublic` in any matching file —
  but zero files match, so the `expect` inside the loop never executed; the only live assertion
  was "the directory contains .ts files". A positive control now proves the detector fires.

**Patched — MEDIUM / LOW** (28 further items)

F11 hardening (500 bodies no longer echo exception text, SQL or paths — detail stays in the
server log; route-404 no longer reflects the pathname); archive write handle opened
`{create:false, readwrite:true}` so a vanished trace can no longer be silently re-materialised
as an empty db; `TOKEN_MIN_BYTES` measured with `Buffer.byteLength`; db handle closed when
`Bun.serve` throws; archive body refused on the declared `content-length` before it is read;
`hasColumn` identifiers validated; static responses carry `no-store` + `nosniff`, decode
defensively, and 404 asset-looking paths instead of answering HTML; `after=` past
`MAX_SAFE_INTEGER` rejected rather than silently coerced (INV-3); `SIGTERM` handled alongside
`SIGINT`; `GET /api` classified as API (no browser Basic prompt); client fetch timeout and
JSON-parse errors that no longer carry response-body text into the error surface (F11 —
`/prompts` bodies *are* prompt content); `fmtDuration` "2m 60s" rollover; `axisTicks` honouring
`maxTicks` and guarding a non-finite span; `toSorted` replaced for browser baseline; unknown
session status no longer rendered as a red "fail"; `shallowRef` for the largest event array;
vendor pin verification, repo-URL normalisation, and a completed divergence inventory in
`PROVENANCE.md`.

**Gates that existed on paper but never ran** — the visualizer shipped behind three checks that
were declared and then never invoked: CI ran root `typecheck` (whose tsconfig excludes
`visualizer/`), `biome.json` ignored `**/*.vue` repo-wide, and the vendored `.oxlintrc.json`
gate was never called from anywhere. So the security-relevant port boundary and ~3,500 lines of
components were type-checked and linted by nothing. `typecheck:visualizer` and a new
`lint:visualizer` are now wired into CI, `visualizer/test/**` is inside the type-check, and
`noUncheckedIndexedAccess` is on.

**Tests** — full-repo total ran 2407 → 2455 (+48). Bun's total counts every outcome, so the
post-round breakdown is **2444 pass + 7 skip + 2 todo + 2 fail = 2455**; the pre-round baseline
was 2395 pass + 7 skip + 2 todo + 3 fail = 2407. (The "2,382 tests" figure recorded earlier in
this file is the total at the *pre-PR self-review* round, before this round's +48 and before
DF1.4-era additions — it is a different snapshot, not a disagreeing count of the same run.) AC0 gained its first executable verification at all (22 tests
over the pin-rejection, same-pin no-op, refusal and hardening-guard branches, no network); the
static branch is now exercised authenticated with traversal cases; anti-CORS is asserted on a
200; wrong-**length** credentials are pinned (a `timingSafeEqual` over raw strings would 500,
not 401); `limit=-1|0|abc` is covered on all three paged routes (the clamp's *lower* bound is
the only thing stopping `LIMIT -1` from meaning unbounded); the snake_case heritage arm and the
read/write derivation rule are covered instead of a magic constant. Every new test was verified
red against a deliberate product mutation.

**Pushback — reported, not patched**

- **`checkHost` pins the `Host` port to the server's bound port**, so `ssh -L 8080:127.0.0.1:4600`
  403s every request. Two independent reviewers filed this as HIGH. It is not a defect: AC1(c)
  mandates the Host header be exactly `127.0.0.1:<port>` / `localhost:<port>` against the
  resolved port. Kept as specified (conservative resolution). **Operator constraint worth
  documenting:** the local forward port must equal the remote one — the story's own example
  (`ssh -L 4600:127.0.0.1:4600`) does this, so the failure only bites an operator who picks a
  different local port, and it surfaces as a blank page (403, empty body).
- **403 before 401** — reported as "not every route 401s on a missing credential". AC1 mandates
  the DNS-rebinding gate run first, ahead of the credential check. Working as specified.
- **Four `v-html` sinks / markdown link-href XSS** (one filed by Sift as SECURITY). False
  positives, verified in source: `escapeHtml` escapes `"` and `'`, `inline()` only ever receives
  already-escaped text, `renderMarkdown` and `highlightJson` escape before emitting tags and
  have no raw-HTML passthrough. The markdown file is byte-identical to upstream.
- **`prettyJson` returns unescaped text** — real hazard only via a `v-html` caller; it has zero
  callers in the tree.
- **`setToken` is dead code** — documented programmatic escape hatch; the browser path uses the
  Basic 401 challenge by design.
- **Health reports degraded while other routes 500** — AC3 defines exactly that split.

**New finding — evidence is not replayable (owner: DF4.2)**

`_bmad-output/evidence/df4-1/demo-trace.db` is a WAL database committed without its `-wal` /
`-shm` sidecars. SQLite cannot open a WAL db read-only when it must create the `-shm`, so the
server this evidence exists to demonstrate **cannot open its own demo trace**:
`new Database(path, {readonly: true})` → `SQLITE_CANTOPEN`, reproducible on a fresh writable
copy. The captured JSON in `e2e-demo.json` remains accurate — none of the shapes it asserts
(prompt rows, gate rows with both json columns, 401 empty body, refusal on a routable address)
changed in this round, and all of them are now covered by the regression suite instead. But the
artifact cannot be replayed, so it is evidence that cannot be re-verified. Not silently
regenerated: the `ssh -L` capture in it was taken against real sshd on the author's machine and
cannot be honestly reproduced here.

**Deferred to DF4.2** (its story owns the test suite, the Bun-API inventory and per-box deploy):
client-side/DOM test infrastructure (so AC2's render half and `api.ts`'s credential claims stay
untested by machine), the `main()` process-exit test, the trace-locked-past-`busy_timeout` test,
`resolveDbPath` and the `journal_mode` warn path, event-list windowing, and the vendored
`package.json` dev scripts that the mandatory startup token broke (`bun run server` / `dev:all`
now exit at startup).

**Pre-existing, untouched by this PR:** 5 biome errors (`scripts/qds-cost.ts`,
`src/providers/budget-gate.ts`, `tests/providers/*`) and 2 GitNexus tests that shell out to the
`gitnexus` CLI and time out at 5 s — all byte-identical to `main`. `bun run notice:sweep` fails
with a usage error (`--tree is required`) on `main` as well; the sweep's real gate is
`build:image`.

**Gate results:** `bun test` 2444 pass / 7 skip / 2 todo / 2 fail of 2455 run — both failures
are the pre-existing GitNexus CLI timeouts ·
`bunx tsc --noEmit` clean · `bun run typecheck:visualizer` clean · `bun run lint:visualizer`
clean · `bunx @biomejs/biome check visualizer` clean · AC0 same-pin re-vendor re-run against the
pinned inputs → exit 0, no-op, hardening intact · `detect_changes` vs the working tree → 89
symbols across 13 processes, all inside `visualizer/**` and `scripts/vendor-visualizer.ts`, no
out-of-scope module.
