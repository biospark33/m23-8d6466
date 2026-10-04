# DF4.2 — Visualizer Test Suite from Zero, Bun-API Inventory, Per-Box Deploy

`/qds-dev DF4.2` — follow the `qds-dev` skill strictly and explicitly, no step skipped, no phase
collapsed. Use **waves of parallel subagents** so this thread's context stays fresh. Full
enterprise-grade rigor: production-ready code confirmed by a real E2E, no shortcuts, no band-aids,
no "wire later", no assumed behavior. Be **≥95% sure** of every claim — verify against real source
or a real run, never memory, and never against the story text alone.

## Story and spec

- Story: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df4-2-visualizer-tests-deploy.md`
- Spec: `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §3.3, §6 clause 7,
  §8 step 4, §8 step 7 — plus decision register **D6**, **D7**, **D10**, **R10**, **F11**.
- Predecessors, all merged to `main`: **DF4.1** (vendored visualizer + auth gate, PR #124),
  **DF2.2** (exe.dev driver + setup gate), **DF1.4** (SQLite trace store), **DF1.6** (dispatch_task
  run that fills the trace), **DF2.3** (per-run credential lifecycle), **DF2.5** (harvest +
  teardown). Consume them. Re-implementing any of them is a defect, not thoroughness.
- Sprint status note: `_bmad-output/sprint-artifacts/sprint-status.yaml:140` still shows DF4.1 as
  `review`; the code merged as `65bc73b` and the artifact correction is riding in PR #125. Do not
  "fix" DF4.1's status inside this story unless PR #125 is still open when you finish; if it is,
  leave it alone and say so.

## The story text is a spec written before the code existed. Treat it as a claim set.

DF4.2 was authored from SSSF reference docs with **zero story ancestry** (DD-3) and before DF4.1
landed. Several of its concrete assertions about *this repo* are now provably wrong. Your first
wave is a **reconciliation wave**: verify every load-bearing factual claim in the story against real
source, then amend the story file in the same PR — with a short note per correction — before writing
a line of implementation against a false premise.

Already verified stale (re-verify, then correct the story; do not blindly trust this list either):

1. **Teardown is not six steps.** `src/providers/teardown.ts:102` —
   `const STEPS = ["spend","artifacts","harvest","revoke","verify","destroy","close"]` — is
   **seven**. AC6 and the DoD both say "six-element ... extended to seven"; the real edit is seven
   to eight, `stopVisualizer` prepended.
2. **`tests/providers/teardown.test.ts` asserts no strict equality over a step array.** Its header
   (lines 2-9) and its ordering test (`teardown.test.ts:197`) state the contract is a **subsequence**
   check over a recorded call-order array, precisely so a later story may prepend. The story's
   premise that an equality must be widened is false; AC6's *intent* (relative order preserved,
   `stopVisualizer` first, and a test that only counts steps must fail) still stands and is what you
   implement. `teardown.ts:9-11` already names DF4.2's prepended visualizer stop as an anticipated
   additive claim — honour that contract; do not reorder anything.
3. **`observe` already exists and means something else.** `src/providers/driver.ts:353` —
   `observeRun(driver, vm, remotePath, localPath)` — is the lifecycle verb that *copies an artifact
   box → host*. The story's `observe` verb ("starts the visualizer") is a **different operation with
   a colliding name**, and `ExeDevDriver` (`src/providers/exedev/driver.ts:82`) exposes no `observe`
   member at all. Do not overload or repurpose `observeRun` — its existing callers and contract tests
   (`tests/providers/driver-contract.test.ts`) own that name. Add a distinct, named function
   (`startVisualizer` / `stopVisualizer` in `visualizer/deploy.ts`, surfaced through the driver as its
   own entry point), and record the naming decision in the story's Technical Notes so the next reader
   is not hunting a verb that means two things. **Flag it to me before you settle the name** if your
   reconciliation shows the spec (§8 step 4) genuinely intends the same verb.
4. **`visualizer/src/lib/` holds eight files, not seven.** The seventh named module list is right as
   far as it goes, but `visualizer/src/lib/types.ts` (26 lines) is also inside the
   `visualizer/src/lib/**` coverage glob. It is a **pure `export type { … } from '@shared/types'`
   re-export** — it transpiles to nothing, so it has zero executable lines. Your per-file lcov assert
   must handle "file with zero instrumented lines" explicitly: pass it vacuously **or** name it in
   the ignore list with the reason, never divide by zero and never let it silently sink the gate.
   Whichever you pick, write the choice down in `bunfig.toml`'s comment and in the story.
5. **Component line counts in the story are pre-hardening.** Actual, today:
   `SessionsList.vue` 120, `SessionCard.vue` 491, `SessionTrace.vue` 931, `PhaseDetail.vue` 1300
   (= 2,842), plus `App.vue` 136 and four small chips. The story's 96/472/858/1265 = 2,691 is stale.
   The *bounding argument* is unaffected; the numbers must still be corrected.
6. **The fixture already exists under a different name.** DF4.1 shipped
   `visualizer/test/fixtures/trace-fixture.ts` (348 lines). The story's "Files to Modify" invents
   `visualizer/test/fixtures/seeded-trace.ts`. **Extend the existing fixture** — a second fixture
   module building the same DF1.4 schema is exactly the duplication ponytail forbids. Correct the
   file list.
7. **DF4.1's tests already exist and are substantial.** `visualizer/test/routes.test.ts` (820 lines,
   41 `test(` blocks) and `visualizer/test/auth.test.ts` (851 lines, 68 blocks). AC1's route matrix is
   partly satisfied already. Your job is to **measure what is actually uncovered** with a real
   `--coverage` run first, then close the gaps — not to rewrite what is there, and not to assume it
   is absent because the story was written before it existed.

Anything else you find stale gets the same treatment: verify, correct the story, note it, proceed.

## Verified ground truth you may rely on (spot-check anyway)

- The eight JSON route labels are pinned in `visualizer/server/index.ts` (`/api/health`,
  `/api/sessions`, `/api/sessions/:requestId`, `+ /events`, `/envelopes`, `/gates`, `/prompts`,
  `/archive`) with the static branch at `index.ts:397`. Take the list from source; do not
  re-enumerate it in a new place.
- `visualizer/server/auth.ts` exports `assertNeverPublic` (`:39`), `validateToken` (`:53`),
  `validatePort` (`:80`), `checkHost` (`:116`), `checkCsrf` (`:162`), `checkCredential` (`:171`),
  `mintRequestId` (`:185`). INV-1 and INV-2 build on these; do not fork them.
- Sizes today: `server/index.ts` 564, `server/db.ts` 549, `server/auth.ts` 187 (the story's "213
  lines" for the server is the *upstream* figure, pre-hardening).
- No `bunfig.toml` exists anywhere in the repo — confirmed. No `visualizer/deploy.ts`, no
  `visualizer/scripts/` — both are net-new here.
- Root `package.json` scripts today: `test`, `typecheck`, `typecheck:visualizer`, `lint`,
  `lint:visualizer`, `build:image`, `notice:sweep`, plus smoke/verify/bench entries. There is **no**
  `build:check` and no visualizer test script.
- `.github/workflows/ci.yml` runs `bun run typecheck`, `typecheck:visualizer`, `lint`,
  `lint:visualizer`, `bun test` — and no visualizer-scoped test, coverage, or build step. All three
  new CI steps (the scoped coverage run, the post-test lcov assert, and `build:check`) are real edits
  this story owns.
- **CI cannot prove anything right now.** GitHub Actions is billing-blocked on this account — every
  QDS-Factory PR, including on `main`, fails the workflow before it runs (observed throughout DF4.1's
  seven review rounds). Write the CI steps correctly anyway, then prove them **locally**, command by
  command, and say plainly in the PR body that CI is blocked and which local run stands in for which
  job. Do not claim a green CI you did not see.
- Bun is **1.3.13**. Pin your expectations to that; `bun test --help` and a throwaway project are the
  arbiter, not the docs you remember.

## Ponytail principles apply

Reuse over write, in this order: extend `trace-fixture.ts` over a new fixture; extend
`routes.test.ts` / `auth.test.ts` over a third route-test file; `bun:test` + `bun --coverage` over any
new test framework; `bun:sqlite`, `Bun.spawn`, `Bun.file` over a dependency. `check-lcov.ts` parses
lcov with a few lines of string handling — no lcov package. The one place minimalism does **not**
apply: the security invariants (INV-1…INV-5), the token-mint path, and the coverage gate itself get
built in full, exactly as specified.

Do not add an abstraction layer between the driver and `deploy.ts`. One module, two exported
functions (`startVisualizer`, `stopVisualizer`) plus a health probe, is the whole shape.

## Coverage gate — the part most likely to be got wrong

Bun's `coverageThreshold` cannot be scoped per glob, which is why the story splits the gate in two.
Both halves are mandatory. **I ran bun 1.3.13 (the version this repo uses) against a throwaway
project and against `visualizer/` itself before writing this; the five findings below are measured,
not assumed. Re-measure them yourself, then design to what you observe.**

1. **`coverageThreshold` as a bare number gates functions *and* lines.** `coverageThreshold = 0.99`
   on a file at 100% lines / 50% funcs exits **1**. Use the object form —
   `coverageThreshold = { line = 0.90, function = <n> }` — and choose the function number
   deliberately. Do not write `0.90` bare and call it a line floor.
2. **Bun's line coverage does not mean what the story assumes.** A file whose second exported
   arrow function is never called still reports **100% lines** (measured: `LF:2 LH:2` while
   `FNF:2 FNH:1`) — bun's `DA:` records land on the declaration line, not the unexecuted body. A
   90% *line* floor alone therefore permits a module with half its functions never invoked. The
   per-file lcov assert **must check `FNF`/`FNH` as well as `LF`/`LH`**, and the story's
   "≥90% lines" wording must be amended to say both. This is the single most important correction
   in this prompt.
3. **lcov contains only files the run loaded.** In the real `visualizer/` run today, `lcov.info`
   holds nine `SF:` records — `server/{auth,db,index}.ts`, `test/fixtures/trace-fixture.ts`, and five
   `../src/phase-engine/trace/*` files. **Not one `src/lib/` module appears**, because no test
   imports them. A per-file assert that iterates the lcov records therefore cannot see an entirely
   untested module — it sees nothing and passes. `check-lcov.ts` **must enumerate the expected files
   from the filesystem** (glob `server/**/*.ts`, `src/lib/**/*.ts`, `deploy.ts`) and fail on a
   **missing** `SF:` record as loudly as on a low one. Write the test for that case first.
4. **The scoped run already drags in code outside `visualizer/`.** Those five
   `../src/phase-engine/trace/*` records come in through `trace-fixture.ts` importing DF1.4's tracer.
   They count toward the aggregate `coverageThreshold`, so the story's claim that the scoped run
   measures "`server/**`, `src/lib/**` and `deploy.ts`" is factually wrong today. Decide explicitly:
   ignore `../src/**` in `coveragePathIgnorePatterns` (my recommendation — DF1.4 owns its own
   coverage) or keep it and restate the aggregate's meaning. Either way, write the decision into the
   `bunfig.toml` comment and correct the story.
5. **`coverage = false` in bunfig beats the `--coverage` flag** (measured: no report at all). The
   flag alone with a threshold present *does* enforce. Set `coverage = true` in the `[test]` block or
   leave the key out; never write `false`.

Also: lcov `SF:` paths are **relative to the cwd of the run** and use `../` for anything outside
`visualizer/`, so path matching in `check-lcov.ts` must normalise rather than string-prefix. And the
repo-root `bun test` **does** execute `visualizer/test/*.test.ts` as well (they are inside the root
glob) — visualizer tests must not depend on `visualizer/` being the cwd, and the root run must stay
green. The scoped run is the coverage gate; the root run is not, and inherits no floor because
`bunfig.toml` resolves from the cwd.

Shape of the two halves:

- `visualizer/bunfig.toml` (new): `[test]`, threshold object per finding 1, explicit
  `coverageReporter = ["text", "lcov"]`, `coveragePathIgnorePatterns` naming `test/**`, the four Vue
  components **individually by name**, and whatever finding 4 resolves to — each with the rationale in
  a comment. The gate is `bun run --cwd visualizer test:coverage` (add the script; it matches the
  repo's existing `typecheck:visualizer` / `lint:visualizer` pattern).
- `visualizer/scripts/check-lcov.ts` (new): its **own CI step**, after the `bun test` step, preserving
  that step's exit status as the first gate. Parses `visualizer/coverage/lcov.info`, enforces
  per-file line **and** function floors, and fails on missing records. Never a `*.test.ts` — a test
  inside the run cannot read that run's own final lcov.
- `check-lcov.ts` must itself be covered by the gate it enforces, or explicitly ignored with a
  reason. Decide, don't drift into it.

## Bun-API inventory — the trap in AC2

`visualizer/server/bun-apis.ts` plus `visualizer/test/bun-api-inventory.test.ts` must fail on an
undeclared usage **and** on a declared entry with no usage. The trap: `Bun.` occurs in **comments**
today — `visualizer/server/auth.ts:78` ("BEFORE Bun.serve (INV-5)") and
`visualizer/server/index.ts:51` — and in type positions (`ReturnType<typeof Bun.serve>` at
`index.ts:36`, `:73`, `:363`). A naive grep counts prose as usage and lets a stale entry live on a
comment. Strip comments (and decide, explicitly, whether a type-only reference counts — it does not
require the API at runtime) before matching, and put a test in the suite that proves a comment
mentioning `Bun.serve` does **not** satisfy an inventory entry. Real usages to start from:
`Bun.serve` (`index.ts:75`), `Bun.file` (`index.ts:207`, `:220`), `Bun.argv` (`db.ts:80`),
`bun:sqlite` (`db.ts:18`) — confirm the full set yourself; that list is a starting point, not the
answer.

## Security invariants are not negotiable

INV-1…INV-5 in the story are load-bearing. In particular:

- The suite asserts the gate by sending **real unauthenticated requests**; a test that constructs an
  ungated server to reach the routes is a defect (INV-1).
- The `share port` / `set-public` assertion is on the **fake-driver argv spy's emitted calls**, never
  on source text — DF2.2 ships both shapes legitimately (INV-2). `src/providers/fake-driver.ts:42`
  already implements `ProviderDriver` including `setPublic` (`:152`) and records `exec` argv
  (`:162-167`); spy on it rather than writing a second fake.
- Copy DF2.3's delivery shape rather than inventing one: `src/providers/credentials.ts:308-353`
  already pushes a secret over `driver.exec(vm, ["sh","-c",script], stdin)` into a mode-`600` file
  (`KEY_ENV_FILE = /home/agent/app/.env`), with argv carrying only the fixed script. **Unresolved
  tension to settle in wave 1 and write into the story:** INV-3 forbids "shell redirect, umask, or a
  post-write `stat` check", but DF2.3's in-box path is exactly a shell script that `chmod 600`s after
  writing. Read INV-3 as governing the **host-side** mint (`$HOME/.qds/viz-token`, `O_EXCL |
  O_NOFOLLOW`, verified on reuse) and the in-box delivery as DF2.3's proven path — or make the in-box
  write atomic too — but decide it explicitly with the reasoning recorded, do not leave two
  contradictory rules in the tree.
- `QDS_VIZ_TOKEN` over **stdin, never argv**. First mint via `open(..., O_CREAT|O_EXCL|O_NOFOLLOW,
  0o600)`; a second `observe` does not re-mint — it `fstat`s the `O_NOFOLLOW` handle and reuses the
  bytes only on regular-file / mode exactly `0600` / calling uid, else the named failure
  `viz-token-unverifiable`, never a rewrite (INV-3). Token path `$HOME/.qds/viz-token`, outside every
  harvested path, and a test asserts that.
- Fail-closed: a failed start names the cause, leaves the box and run untouched — no destroy, no
  `0.0.0.0` fallback, no public-share workaround, no retry loop (INV-5).

## GitNexus (required by repo CLAUDE.md)

- `impact({target:"<symbol>", direction:"upstream"})` before editing **any** existing symbol —
  `teardownSteps`, `STEPS`, `ExeDevDriver`, anything in `visualizer/server/`. Report the blast radius;
  stop and surface HIGH/CRITICAL to me before proceeding.
- `query({query:"<concept>"})` / `context({name:"<symbol>"})` to find DF1.4's trace API and DF2.2's
  driver surface instead of grepping.
- `detect_changes({scope:"compare", base_ref:"dev"})` before every commit — the blast radius must
  stay inside DF4.2's own modules plus the two DF2.5-owned files the story explicitly claims.
- `rename` for renames. Never find-and-replace.

## Subagent waves

Dispatch disjoint clusters in parallel, one message per wave; agents return reports, **you** hold the
thread and run every gate yourself. No two agents touch the same file.

1. **Reconciliation wave** — verify the seven stale claims above (and hunt for more), run a baseline
   `cd visualizer && bun test --coverage` (baseline, before the new script exists) to learn what
   DF4.1 already covers and which files never appear in lcov at all, and amend the story
   file. Everything downstream depends on this landing first.
2. **Harness wave** — `bunfig.toml`, `scripts/check-lcov.ts`, `build:check` in
   `visualizer/package.json`, the CI edits. Independent of test content.
3. **Deploy wave** — `visualizer/deploy.ts` (start / health / stop, in-box and `--local`, idempotent),
   the driver entry point, the `stopVisualizer` prepend in `src/providers/teardown.ts`, and the
   ordering assertion in `tests/providers/teardown.test.ts`.
4. **Inventory wave** — `server/bun-apis.ts` + `test/bun-api-inventory.test.ts`, including the
   comment/type-position trap.
5. **Coverage wave** — last, once behavior has settled: the seven (or eight) lib module tests, the
   route/reader gaps the baseline run exposed, the degraded-box and empty-boundary fixtures.

## Story amendments this PR must carry

Every correction from wave 1 lands **in the story file**, in the same PR, and is listed in the PR
body as a short "story corrections" block so a reviewer can check them against source without
re-deriving. At minimum, expect to touch: AC1's "≥90% lines" (lines **and** functions), AC1's
description of what the scoped run measures, AC6's six/seven step arithmetic and its
strict-equality premise, AC2/Technical Notes on the seven-vs-eight `src/lib` files, the stale
component line counts, the `seeded-trace.ts` entry in "Files to Modify", and whatever the `observe`
naming resolves to. If any correction changes what an AC *demands* rather than how it is worded —
i.e. it would reduce scope — stop and ask me before writing it.

## Review loop after the PR

`gh pr create` as `biospark33`, then switch back immediately, then drive the bot rounds with
`qds-pr-monitor` the same way DF4.1 was driven (seven rounds, every finding either fixed or
rejected in writing). Do not merge until the bots are quiet across two consecutive cycles, and
say plainly in each disposition comment which checks you ran locally, given CI is blocked.

## Definition of done

- `bun test` (root — it runs the visualizer tests too) · `bun run typecheck` ·
  `bun run typecheck:visualizer` · `bun run lint` · `bun run lint:visualizer` ·
  `bun run notice:sweep` · `bun run --cwd visualizer test:coverage` ·
  `bun run --cwd visualizer build:check` · the `check-lcov.ts` step — all green, run by **you**, not
  reported by an agent, with the output pasted into the PR body since CI cannot run.
- The scoped coverage run clears the aggregate threshold **and** the post-test assert passes per file
  — line **and** function floors — over `visualizer/server/**` and `visualizer/src/lib/**`. Prove the
  gate bites, three ways, with the output captured: (a) a crafted lcov fixture with one module at 40%
  fails; (b) a crafted fixture with a **missing** record for an expected file fails; (c) a fixture at
  100% lines / 50% functions fails. A gate never observed failing is not a gate, and (b) and (c) are
  precisely the two holes bun's own reporting leaves open.
- Re-run DF4.1's vendoring script against its pin: still a no-op diff. Your hardening edits must not
  break DF4.1's AC0.
- `tests/providers/teardown.test.ts` proves `stopVisualizer` runs first **and** that DF2.5's existing
  steps keep their relative order as a subsequence. A test that only proves N steps ran must fail —
  demonstrate that too.
- **Real E2E, not a mock:** a real DF2.2 box with a DF1.6 run in flight → start the visualizer in the
  box → the driver prints the `ssh -L` forward and emits **no** `share port` / `set-public` (captured
  command log) → L1/L2/L3 reached through the forward with the bearer token → the same request with
  no credential returns `401`, empty body → nothing listening on the externally routable address →
  DF2.5's teardown runs as a finally-style step **after** artifact capture, including when capture
  fails, and VM destruction is asserted only from teardown's own confirmation. Evidence to
  `_bmad-output/evidence/df4-2/`: command log, L3 payload, coverage report, lcov assert output.
- If the box or the exe.dev substrate is unavailable, **stop and tell me** — do not substitute a
  simulated E2E and call the DoD met. Report exactly which item is unproven.
- Story file updated (status, completion notes, the corrections from wave 1),
  `_bmad-output/sprint-artifacts/sprint-status.yaml` updated.
- PR opened per repo rule: **`biospark33` runs `gh pr create` only**, then switch back to
  `i3creations` immediately; every other git/gh operation runs as `i3creations`.

## Out of scope — do not build it here

Vue component render/interaction tests (no DOM harness in this repo — `build:check` plus the
API-contract smoke is the whole component gate), fleet-wide multi-box aggregation (§8 step 6), and
anything DF5.1 owns (nothing the visualizer displays verifies anything). If the server/lib suite
alone blows the 4-point budget, split the Bun-API inventory out as a sub-story (SPL-008 letter
suffix) and tell me — **never** lower the coverage floor or quietly widen the exclusion list.
