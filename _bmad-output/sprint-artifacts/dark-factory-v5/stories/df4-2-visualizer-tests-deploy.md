# DF4.2: Visualizer Test Suite from Zero, Bun-API Inventory, Per-Box Deploy

**Story Points:** 4
**Sprint:** v5-S3

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §3.3, §6 clause 7, §8 step 4 ("Visualizer adoption — auth, tests, per-box deploy"), §8 step 7 (OCI driver: the image contract pins the runtime)
- Decision register: v5 §4 **D6** (adopt the visualizer, harden it), **D7** (provider-driver verbs); §9 **R10**; §10 **F11**
- Derivation source: **zero story ancestry** — SSSF reference docs plus F11/R10 alone, per derivation register **DD-3**. Net-new material, full adversarial review, nothing carried forward verbatim.
- Source pattern (reference only, D10; the visualizer is the single code adoption, R5 §6 fact 20): R4 §2.5 (`VIZ/package.json` — **no test script and no test files**; `VIZ/server/index.ts` 213 lines; component sizes `PhaseDetail.vue` 1265 / `SessionTrace.vue` 858 / `SessionCard.vue` 472), §2.2–§2.4 (`VIZ/server/db.ts:77-124, :329-360, :362-384`), §2.6 (`INK/just/sandbox/lifecycle/observe.just:113, :159-161, :162-167, :174-177`), §3.5 (six exe.dev control-plane shapes)
- Binding facts: R5 §6 facts **11**, **15**, **16**, **20**; R5 §7 (DF4 is the weakest estimate in the slate)

## User Story

As the engineer who has to maintain someone else's untested UI,
I want a bounded test suite over the visualizer's server and library layers, a machine-checked inventory of every Bun-only API it uses, and a per-box deploy path that starts it behind DF4.1's gate,
so that adopting ~4,656 lines of vendored TypeScript and Vue does not become an unbounded liability and does not become the enterprise tier's first regression.

## Overview

Disler shipped the visualizer with zero tests: `VIZ/package.json` has `dev`, `server`, `build`,
`typecheck`, `lint` — no test script and no test file anywhere in the tree (R4 §2.5). This story builds
the suite from nothing against an explicitly bounded target: the server routes, the SQLite reader and
the seven client lib modules get exhaustive tests; the four excluded Vue components get a typecheck plus an
API-contract smoke and are excluded from the coverage gate **in config, by name, with the reason
written down** — not by accident. Alongside it, every Bun-only API the tree touches is recorded in a
typed inventory a test asserts against a grep of the source, so DF2.9's image contract pins a real
runtime floor. Finally, the driver's `observe` verb starts the visualizer inside a box against that
box's own trace, loopback-bound behind DF4.1's gate — never through `share port` / `set-public`.

## E2E Slice

**Demonstrable behavior:** Given a box created by the DF2.2 exe.dev driver with a run in flight, When
the operator calls the driver's `observe` verb, Then the visualizer starts inside the box on loopback
reading the in-box trace, the driver prints the exact `ssh -L` forward command and does **not** call
`share port` or `set-public`, the operator reaches L1/L2/L3 through the forward with a bearer token,
and `cd visualizer && bun test --coverage` reports the suite green with the scoped aggregate above
the 90% floor, every file under `visualizer/server/**` and `visualizer/src/lib/**` individually above
it in the lcov per-file assert, and the four Vue components listed as explicitly excluded.

**Wiring closed:** On completion, the visualizer is tested, its runtime dependencies are enumerated and
enforced, and it deploys per box using only code merged by this story plus its predecessors — DF4.1
(the vendored tree, the gate and the pinned route list), DF2.2 (the box and its `observe`/`setup`
verbs), DF1.4 (the trace schema the fixtures build), DF1.6 (the run that fills the trace), DF2.3 (the
in-box key the run spends against) and DF2.5 (the teardown order AC6 prepends to) — no stub, no
`TODO: wire later`, no sibling story left to write.

**Dependency edges (predecessors):** DF4.1, DF2.2, DF1.4, DF1.6, DF2.3, DF2.5.

## Acceptance Criteria

1. **(make-or-break)** Given `cd visualizer && bun test --coverage`, When the suite runs, Then it covers, at
   minimum: all eight JSON routes **and the static branch** — the eight taken verbatim from the literal
   path list pinned once in DF4.1 §Technical Notes, never re-enumerated here — exercised authenticated,
   unauthenticated and malformed, and, for the static branch, with a browser-shaped navigation carrying
   no header; plus the `optionalColumn` probe / latch, the rowid-cursor page + clamp, the derived
   read/write usage split, and each of the **seven** client lib modules (`events`, `format`,
   `markdown`, `api`, `highlight`, `router`, `models`). **How the floor is expressed, given that Bun's
   `coverageThreshold` is a single global number and cannot be scoped per glob:**
   - the config file is `visualizer/bunfig.toml`, **created by this story** (no `bunfig.toml` exists
     anywhere in the repo), and the gate is the scoped invocation `cd visualizer && bun test
     --coverage` — run from `visualizer/`, so the config binds and the repo-wide `bun test` at the
     root inherits **no** visualizer floor and MUST NOT be the gate;
   - `coverageThreshold` is the **scoped aggregate** floor: **≥90% lines** over everything the scoped
     run measures after ignores — `visualizer/server/**`, `visualizer/src/lib/**` and
     `visualizer/deploy.ts`, which is deliberately inside the floor rather than ignored because
     `deploy.test.ts` exercises it (an untested `deploy.ts` must drag the aggregate down, not hide);
   - the aggregate alone would let one tree carry the other, so the **per-tree guarantee is a
     separate assertion, not a threshold, and it runs after the fact, not inside the same test
     invocation**: `bunfig.toml` configures the `lcov` reporter explicitly, `cd visualizer && bun test
     --coverage` writes `visualizer/coverage/lcov.info` only once the suite finishes and exits, and a
     **post-test script** (`visualizer/scripts/check-lcov.ts`, run as its own CI step immediately after
     the `bun test` step, preserving `bun test`'s own exit status as the first gate) parses that file
     and asserts **every file** under `visualizer/server/**` and `visualizer/src/lib/**` is
     individually ≥90% lines. A test inside the same `bun test` invocation cannot reliably read that
     run's own final `lcov.info`, so this assertion is never a `*.test.ts` file. A 90.1% aggregate
     hiding a 40% module MUST fail the post-test script;
   - `coveragePathIgnorePatterns` names `visualizer/test/**` and each of the four Vue components —
     `SessionsList.vue`, `SessionCard.vue`, `SessionTrace.vue`, `PhaseDetail.vue` — **individually,
     by name**, with the bounding rationale in a comment.
   Typecheck (`vue-tsc --noEmit`) and API-smoke
   checks remain for every excluded component.
2. Given `visualizer/server/bun-apis.ts` declares the Bun-only surface (each entry: API, file, minimum
   bun version, portable-fallback yes/no), When `visualizer/test/bun-api-inventory.test.ts` runs, Then
   it scans the defined runtime source roots (`visualizer/server/**`, `visualizer/src/**`,
   excluding `visualizer/test/**`, `*.md`, `visualizer/server/bun-apis.ts` itself, and the inventory
   test itself) for `Bun.`, `bun:` and `import.meta.dir` usages and **fails** on any usage absent from
   the inventory or any inventory entry with no usage — so the list cannot silently drift, and DF2.9's
   image contract has a real runtime floor rather than "whatever bun is installed". `bun-apis.ts` is
   excluded from the scan because its own entries name these literals as declared API strings, not as
   usages, and counting them would let a stale entry pass the "entry with no real usage" check against
   itself.
3. Given a box with a live run, When the provider `observe` verb is called, Then the visualizer starts
   inside the box bound to `127.0.0.1` with the box's `QDS_VIZ_TOKEN` supplied over **stdin, never
   argv**, the verb returns the forward command and the port, and calling it a second time is
   idempotent (existing healthy process reused, not a second listener).
4. Given the visualizer fails to start in the box — port already bound, trace file missing, or token
   unset — When `observe` runs, Then it reports the named failure and **leaves the box alive** with the
   run untouched; it never destroys the box, never falls back to `0.0.0.0`, and never reaches for
   `share port` / `set-public` as a workaround.
5. Given a trace containing zero sessions, a trace whose schema predates a migrated column, and a
   `bun:sqlite` handle that cannot be opened, When the suite exercises each, Then the fixtures assert
   an empty L1 list (`200`, not an error), a `NULL AS <column>` substitution that later returns real
   values, and a named startup failure respectively.
6. Given DF2.5's fixed teardown order, When teardown runs on a box whose visualizer was started by
   `observe`, Then `stopVisualizer(runId)` executes as a new **first** step, ahead of spend capture, so
   no reader is held open across DF2.5's harvest; a `stopVisualizer` failure is logged with its named
   cause and teardown **continues** — it never aborts the sequence and never leaves the box up. The
   ordering proof is **this story's own and self-sufficient**: DF2.5 ships two sprints earlier and
   promises nothing about tolerating a prepended step, so this AC does not assume its test survives
   untouched. Instead this story asserts the **relative order** directly — DF2.5's six steps must
   appear as an ordered **subsequence** of the executed sequence, with `stopVisualizer` first — and,
   where DF2.5's existing test asserts a strict equality against a six-element array, **extending that
   array to seven is inside this story's scope** and is done here, not deferred to DF2.5. A test that
   only proves seven steps ran, without proving the six retain their relative order, MUST fail.

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `cd visualizer && bun test --coverage` (the coverage gate) | in-scope | the suite itself | — |
| Provider driver `observe(runId)` verb (per-box start) | in-scope | `visualizer/test/deploy.test.ts` | — |
| Provider driver `teardown` stopping the in-box visualizer | in-scope | `visualizer/test/deploy.test.ts` | — |
| Host-side start against a harvested trace (`visualizer/deploy.ts --local`) | in-scope | `visualizer/test/deploy.test.ts` | — |
| `bun run build:check` over the Vue tree (component gate) | in-scope | CI step, not a test file — a `build:check` script in `visualizer/package.json` running `vue-tsc --noEmit` + `vite build`, invoked from the CI typecheck job | — |
| Vue component render/interaction tests | **out-of-scope** | — | deferred by design — see Technical Notes "bounded scope" |
| Fleet-wide multi-box aggregation view | out-of-scope | — | §8 step-6 derivation |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| `bun test` + coverage | the project's bundled bun toolchain, already the repo test runner — **no new test framework** | `visualizer/bunfig.toml` **created by this story** (no `bunfig.toml` exists anywhere in the repo): its `[test]` block sets `coverageThreshold` — a single global number, so it is the **scoped aggregate** floor and binds only on `cd visualizer && bun test --coverage`, which is the gate — plus an explicit `lcov` `coverageReporter` and `coveragePathIgnorePatterns` naming the four Vue components and `visualizer/test/**`. Per-file guarantees for `server/**` and `src/lib/**` come from a **post-test** script that parses the written `lcov.info` in its own CI step after `bun test` exits, not from a test inside the same invocation, and not from the threshold. Living under `visualizer/` is what keeps the root `bun test` inheriting no visualizer floor |
| Seeded trace fixture | `visualizer/test/fixtures/seeded-trace.ts` builds a DF1.4-schema db in a temp dir per test | fixture creates and tears down inside the test; no shared file, no ordering dependency between tests |
| exe.dev box + SSH (DF2.2) | exe.dev driver `create`/`fill`/`setup` already ready before `observe` | `observe` asserts the setup gate returned ready and the trace file exists before starting anything |
| In-box `QDS_VIZ_TOKEN` | minted host-side per box, delivered over stdin like the LLM key (R4 §3.1 `fill.just:147-151`) | `observe` verifies `stat` mode `600` on the in-box token file without echoing the value |

## Technical Notes

- **Bounded scope is the point of this story, and the boundary is:** exhaustive tests for
  `visualizer/server/**` (213 lines) and `visualizer/src/lib/**` (~545 across **seven** modules — the
  six drill-level modules plus `models.ts` at 29 lines, which is inside the coverage glob and so gets
  its own `models.test.ts` rather than an ignore entry; six modules alone sum to 516, and a floor over
  an untested seventh file is the kind of gap a glob hides). Contract-level coverage only for the four
  excluded Vue components — `SessionsList.vue` 96, `SessionCard.vue` 472, `SessionTrace.vue` 858,
  `PhaseDetail.vue` 1265 = **2,691 lines**, the four SFCs that render a drill level — via
  `vue-tsc --noEmit` plus assertions on the API payload shapes each level consumes. The ~1.2k
  remainder of the ~4,656 is `shared/types.ts`, the small chip components and config.
- **What actually gates the Vue tree, stated precisely.** Bun has no `.vue` loader, so a `.vue` file
  is never imported by a bun test and therefore **never enters bun's coverage report at all** —
  covered, uncovered or excluded. It follows that the `coveragePathIgnorePatterns` entries naming the
  four components change no number today: they are **future-proofing**, kept so that the day a `.vue`
  loader or a DOM harness arrives the exclusion is already a deliberate, commented decision rather
  than a silent widening. It also follows that no `.vue` file — `App.vue` included — is "above" or
  "below" a coverage floor in any measurable sense; the only real gate over the component tree is
  `bun run build:check` (`vue-tsc --noEmit` + `vite build`) plus the API-contract smoke assertions on
  the payload shapes each drill level consumes. Render tests would need a DOM harness this repo
  lacks, putting the largest, least-stable surface on this story's critical path — that, not line
  count and not coverage arithmetic, is the exclusion rationale written into the `bunfig.toml`
  comment.
- **Sizing risk, stated rather than hidden (R5 §7):** "DF4's 8 points are the weakest estimate in the
  slate — adopting ~4,656 lines of someone else's untested TS/Vue, adding auth and a test suite from
  zero, is the kind of work that routinely doubles." That quote is against DF4's original 8; DF4.1 has
  since been re-pointed 4 → 6 (DF4 = 10) to absorb the vendoring surface. The mitigation is the
  boundary above, not optimism:
  if the server/lib suite alone exceeds the budget, split the Bun-API inventory out as a sub-story
  (SPL-008 letter suffix) — never lower the coverage floor or quietly widen the exclusion list.
- **Contracts/Schema:** no contract is introduced. The suite asserts DF4.1's route shapes and DF1.4's
  seven-table schema; `bun-apis.ts` is a new typed const, not a wire contract.
- **Integration points:** `src/providers/exedev/driver.ts` `observe` verb → `visualizer/deploy.ts`
  (start/stop/health, in-box and `--local`) → DF4.1's `visualizer/server/index.ts`. This story adds
  exactly one call to DF2.5's teardown sequence in `src/providers/teardown.ts` — `stopVisualizer` at
  its head, before spend capture — so it never holds a reader open across DF2.5's harvest. DF2.5's six
  steps keep their relative order, and this story owns the corresponding edit to
  `tests/providers/teardown.test.ts`: where that test pins the sequence as a six-element equality, it
  is extended to seven here (AC6). DF2.5 is therefore a hard
  predecessor, not a coincidence of scheduling.
- **Guards/limits:** coverage floor 90% lines — scoped aggregate via `coverageThreshold`, plus a post-test lcov assert at the same 90% over `visualizer/server/**` and `visualizer/src/lib/**`, run as a separate CI step after `bun test --coverage` exits, with `visualizer/deploy.ts` inside the aggregate; `observe` start timeout 15 s
  then a named failure; health poll 500 ms matching the client's interval; a second `observe` within
  the same run reuses a healthy process rather than binding a second listener.
- **Deviation/assumption:** inkwell starts its visualizer on 4600 in the sandbox and verifies 307/401
  anonymously, relying wholly on exe.dev's proxy gate, only ONE port ever anonymous (`observe.just:113,
  :159-167, :174-177`) — all vendor-single-origin (R5 §6 fact 11, `[VERIFY]`). This story assumes none
  of it: DF4.1's token, a loopback bind, the operator's own forward. In-box trace evidence is a claim,
  not proof (fact 15); nothing the visualizer displays verifies anything — that is DF5.1's job.

## Observability Contract

- `observe`/`stop` log `{ requestId, runId, boxName, action, port, status, durationMs }`. The bearer
  token and the LLM key are never logged, hashed or truncated into any of these lines.
- `requestId` propagates from the dispatching run record (DF2.1) so a start is attributable to the run
  whose trace it serves. Errors carry `{ code, message, stack? }` and name the failing step
  (`preflight` / `spawn` / `health`).
- Sub-timings: `spawn_ms`, `health_ms`. When the driver's SSH transport reports no breakdown, report 0
  and treat `durationMs` as authoritative.

## Files to Modify

- `visualizer/server/bun-apis.ts`
- `visualizer/server/index.ts`
- `visualizer/deploy.ts`
- `src/providers/exedev/driver.ts`
- `src/providers/teardown.ts` (DF2.5-owned — one prepended `stopVisualizer` call, no reordering)
- `visualizer/package.json` (adds the `build:check` script)
- `visualizer/bunfig.toml` (**new** — no `bunfig.toml` exists anywhere in the repo; scoped to the
  `visualizer/` working directory so the root `bun test` inherits nothing)
- `visualizer/scripts/check-lcov.ts` (**new** — post-test per-file lcov assert, run as its own CI step
  after `bun test --coverage` exits; AC1)
- `tests/providers/teardown.test.ts` (DF2.5-owned — the six-element sequence equality extended to
  seven, no reordering; AC6)
- `visualizer/test/{auth,routes}.test.ts` (extends DF4.1's two files — no third route-test file)
- `visualizer/test/deploy.test.ts`
- `visualizer/test/bun-api-inventory.test.ts`
- `visualizer/test/lib/{events,format,markdown,api,highlight,router,models}.test.ts`
- `visualizer/test/fixtures/seeded-trace.ts`
- `.github/workflows/ci.yml` (adds the `visualizer` typecheck job invoking `bun run build:check`; the
  existing workflow runs neither `build:check` nor any visualizer step today — the CI-integration DoD
  item cannot pass without this edit. The NOTICE sweep and its committed diff stay DF4.1's, not this
  story's)

## Security Invariants

- **INV-1 (the deploy path never widens DF4.1's gate):** `deploy.ts` starts the server with the same
  loopback bind and the same mandatory token. It exposes no flag, env var or test hook that binds
  `0.0.0.0` or disables authentication — including in the test suite, which asserts the gate by sending
  real unauthenticated requests rather than by constructing an ungated server.
- **INV-2 (confidentiality — no exposure workaround):** the driver routes `share port` and `set-public`
  through DF4.1's `assertNeverPublic` guard, so the visualizer port throws rather than being exposed.
  **This story owns the behavioral half of DF4.1 AC5's exposure claim**, because `observe` is this
  story's verb: a fake-driver argv spy recording every emitted invocation asserts that an
  **observe-started visualizer** produces no `share port` and no `set-public` argv — asserted on
  the emitted calls, never on source text, since DF2.2 ships both shapes legitimately. The box's one anonymous public port is
  never the visualizer's (F11/R10). The in-box trace holds full compiled prompts — client source code —
  and leaves the box only through DF2.5's harvest, into the repo's own data boundary.
- **INV-3 (secret delivery):** the per-box `QDS_VIZ_TOKEN` goes over **stdin, never argv**, so it never
  appears in `ps` on either side, with the file created **on the first mint for a box** exclusively via
  `open($HOME/.qds/viz-token, O_CREAT|O_EXCL|O_NOFOLLOW, 0o600)` — failing immediately if the path
  already exists or is a symlink, never via shell redirect, umask, or a post-write `stat` check.
  `O_EXCL` is a first-mint guarantee, not a per-call one: AC3's idempotent second `observe` does **not**
  re-mint. It `fstat`s the existing path opened `O_NOFOLLOW` and reuses the token only when the handle
  is a regular file, mode exactly `0600`, owned by the calling uid; an `EEXIST` on mint whose follow-up
  stat fails, or whose mode/owner/type does not match, is the named failure `viz-token-unverifiable` —
  the token is never rewritten, relaxed or deleted to recover. A second-`observe` test asserts one mint,
  one listener, and byte-identical token reuse. The
  mode-`600` file is this story's one deviation from env-only injection, bounded
  thus: minted per box, never reused across runs, never equal to the host operator's token, written
  **outside every harvested path** (`$HOME/.qds/viz-token` — not the work tree, not the artifacts dir,
  not the trace DB, so no harvest can carry it), and shredded at teardown with the box.
- **INV-4 (test fixtures carry no real data):** the seeded trace fixture generates synthetic prompts,
  envelopes and gate reports. No captured client trace, no real prompt text and no real token is
  committed to `visualizer/test/fixtures/`; a fixture is a temp dir per test, removed on teardown.
- **INV-5 (fail-closed deploy):** a failed start reports the named cause and leaves the box and its run
  untouched — no destroy, no `0.0.0.0` fallback, no public-share workaround, no retry loop. A box whose
  visualizer will not start is a box you can still SSH into and read the trace file from directly.

## Definition of Done

- [ ] **Impl:** `visualizer/deploy.ts` starts, health-checks, and stops the visualizer in-box and
      `--local`, idempotent on a second call within the same run.
- [ ] **Impl:** `bun-apis.ts` inventory declares every Bun-only API with file, minimum bun version and
      portable-fallback status.
- [ ] **Contract:** the inventory test greps the tree and fails on an undeclared usage **and** on a
      declared entry with no usage — a stale-in-either-direction list MUST fail.
- [ ] **Integration:** the exe.dev driver's `observe` verb calls `deploy.ts` and returns the `ssh -L`
      forward command; `stopVisualizer` is prepended to `src/providers/teardown.ts` ahead of spend
      capture, its failure logged and non-aborting, and `tests/providers/teardown.test.ts` extended from a
      six- to a seven-element sequence with DF2.5's six steps in unchanged relative order (AC6).
- [ ] **Integration:** `build:check` exists in `visualizer/package.json` and runs from the CI typecheck
      step — no test file invokes a Vite build.
- [ ] **Security:** `observe` emits neither `share port` nor `set-public` for the visualizer port,
      delivers the token over stdin with mode `600` verified, and a test asserts the token path lies
      outside every harvested path (INV-2, INV-3).
- [ ] **Security (idempotent mint):** a second `observe` in the same run performs no second `O_EXCL`
      mint, verifies the existing token file's type/mode/owner through an `O_NOFOLLOW` handle, reuses
      the same bytes, and starts no second listener; a mismatching or unstattable file produces
      `viz-token-unverifiable` rather than a rewrite (INV-3, AC3).
- [ ] **Test (coverage gate):** the scoped `cd visualizer && bun test --coverage` run clears the
      aggregate `coverageThreshold` of 90% lines and exits 0, writing `lcov.info` via the explicitly
      configured `lcov` reporter. A **separate post-test CI step**, run after `bun test` exits and
      preserving its exit status, parses that `lcov.info` and asserts **every file** under
      `visualizer/server/**` and `visualizer/src/lib/**` (seven modules, `models.ts` included)
      individually at ≥90% lines — an aggregate that passes while one module sits below MUST fail the
      post-test step. `visualizer/deploy.ts` counts toward the aggregate; the four Vue components are
      named individually in `visualizer/bunfig.toml`'s `coveragePathIgnorePatterns` alongside the
      bounding rationale; the repo-wide `bun test` run is not the gate.
- [ ] **Test (unit):** all eight JSON routes and the static branch exercised authenticated,
      unauthenticated and malformed; reader probe/latch, rowid clamp and usage split each asserted —
      a suite that constructs an ungated server to test the routes MUST fail (INV-1).
- [ ] **Test (degraded box):** port already bound / trace missing / token unset each produce a named
      failure with the box alive and the run untouched, and no exposure call is attempted.
- [ ] **Test (empty boundary):** zero-session trace returns an empty L1 list with `200`; a
      column-predating trace returns `NULL` then real values after the `ALTER`.
- [ ] **Test (e2e demo — MANDATORY):** on a real DF2.2 box with a run in flight, call `observe`, capture
      the driver's emitted command log (showing no `share`/`set-public`), the L3 payload fetched through
      the SSH forward, and the `cd visualizer && bun test --coverage` report as artifacts. DF2.5's
      teardown sequence is invoked as a finally-style step after artifact capture completes — including
      when capture itself fails — never an ad-hoc VM deletion; VM destruction is asserted only from
      teardown's own confirmation. A capture failure retains whatever artifacts were captured up to
      that point and leaves the box's state to teardown, preserving the same fail-closed semantics as
      DF2.2 AC1's `setup` failure path (INV-5).

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
