# DF1.1: Phase Lifecycle Primitive with Versioned Pipeline Manifest

**Story Points:** 4
**Sprint:** v5-S1 (track A, engine — R5 §3 opens the chain DF1.1 → DF1.2 → DF1.3)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §3.3 (adopt list: phase abstraction), §5.1 (tier 2), §5.2 (security invariants, observability), §8 step 1
- Decision register: v5 §4 D6 (port SSSF's design to TypeScript test-first), D10 (Python engine is reference only — no vendoring)
- Contracts: v5 §5.2 — `maxDurationMs` ≤ upstream timeout with routing margin; requestId propagation; per-phase sub-timings
- Derivation decisions: `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md` DD-8 (surviving clauses from R2 only); pattern source R4 §1.1–1.2, where `MOD/` = `SSSF/templates/adws/adw_modules/` (D10 — read, never vendored)

## User Story

As a factory engineer,
I want a phase primitive whose success must be earned and a pipeline manifest that is versioned and validated before anything runs,
so that a run can never be recorded green by omission and a pipeline cannot start against a shape nobody checked.

## Overview

`loadManifest(path, callerBudgetMs, runRoot)` reads a versioned JSON pipeline manifest
through a beneath-root walk anchored at the supplied root-owned handle `runRoot` (rejected
if absent or not directory-owned), validates it against a closed zod schema, and refuses
the run on any violation. `Run.phase(params)` then opens each declared phase in order: it writes a record
whose status is `fail` at construction, runs the body, and promotes to `success` only on a
clean exit with no thrown error. `Run.finish(accepted)` settles the journal row, the
banner, and the exit code in one call so the three cannot disagree. This story closes the
wiring between a manifest on disk and an ordered, budget-bounded, journaled phase walk. It
carries P1.4's surviving versioning and load-validation clauses; the SwarmClaw template
registry those clauses were written against is deleted (v5 §7, D6).

## E2E Slice

**Demonstrable behavior:** Given `tests/phase-engine/fixtures/pipeline.qds-factory.json`
declaring one `code` phase (`plan`, a command that exits `0`) followed by one `engineer`
phase (`build`) whose body throws — both at `retries: 0` and `maxDurationMs: 15000`, so the
admission formula `2 × (0+1) × (2+1) × 15000 + 2 × 5000 = 100000` clears the `--budget-ms
120000` ceiling (the 600,000 ms default would demand 3,610,000 ms and refuse the load before
the slice could run) — When
`bun scripts/pipeline-run.ts --manifest <fixture> --budget-ms 120000 --journal out.json`
runs, it validates the manifest → opens phase 1 → records `success` → opens phase 2 →
catches the throw → leaves `fail` → `finish(accepted=true)` → the process exits `1` and
`out.json` contains `{ version: "1.0.0", ok: false, phases: [{name:"plan",status:"success"},{name:"build",status:"fail"}] }`.
The failing phase is deliberately **not** a `code` phase: a `code` phase's non-zero command
exit is data, not a phase failure (DF1.2 AC4), so only a thrown body demonstrates the
default-fail promotion rule this slice exists to show.

**Wiring closed:** On completion of this story, a versioned manifest drives a real ordered
phase walk with earned status and a persisted journal, using only code merged by this
story. No stub, no `TODO: wire later`, and no sibling story is required. The journal
writes through a narrow `PhaseJournal` port, file-backed here; DF1.4 swaps in the SQLite
trace store behind the same port without changing this story's semantics.

**Dependency edges (predecessors):** none.

## Acceptance Criteria

1. **(make-or-break)** Given a phase record has been written and the process dies before
   the phase body returns cleanly (throw, uncaught rejection, SIGTERM, or hard kill),
   When the journal is read, Then the phase status is `fail` — `success` is written only
   by the clean-exit branch, and no code path downgrades an optimistic `success` to
   `fail` after the fact.
2. Given a manifest declaring `version`, an ordered `phases[]`, and a `runBudgetMs`, When
   `loadManifest` runs, Then it validates against the closed schema and returns a frozen
   manifest; any unknown field, unsupported `version`, phase `kind` outside
   `engineer | agent | code`, `phases.length < 2`, or `pipelineId` failing
   `^[a-z][a-z0-9-]{1,63}$` rejects the load and **no phase is constructed**.
3. Given a `PhaseParams.description` that is empty, whitespace-only, or an echo of the phase
   name (`d.replace(/\.+$/,"").toLowerCase() === name.replaceAll("_"," ").toLowerCase()` —
   the TypeScript form of `MOD/data_types.py:49-52`; note the **global** `_` replace), When
   the phase is constructed, Then construction throws before any row reaches the journal.
4. Given a phase whose body exceeds its `maxDurationMs`, When the engine's own timer
   fires, Then the engine aborts the `AbortSignal` supplied to the phase body, awaits
   cancellation (including termination of any owned subprocess trees), and only then records
   the phase as `fail` with `exitStatus: "overflow"` (CC-1); the run does not hang, and the
   remaining phases do not execute.
5. Given a manifest whose phase budgets plus routing margin exceed `callerBudgetMs`, or a
   `callerBudgetMs` that was not supplied, When `loadManifest` runs, Then it refuses with
   a budget error rather than assuming an upstream ceiling.
6. Given a phase body that throws (or rejects), When the engine catches it, Then the walk
   halts on exactly the same terms as the overflow path of AC4: the throwing phase is left
   `fail`, the phases declared after it are **not constructed** and write **no journal rows**
   at all (not a `fail` row, not a `skipped` row — absence), and `Run.finish(accepted)`
   computes `ok = false` over the phases that were constructed. A journal in which a
   post-failure phase appears in any status MUST fail this criterion.
7. Given `Run.finish(accepted)` runs, When it settles the journal row, banner, and exit code,
   Then it also writes the fixed in-box terminal marker `/run/journal/final.json`
   (`` `${RUN_MARKER_ROOT}/journal/final.json` ``, and `RUN_MARKER_ROOT` resolves to `/run` in the
   box — see the terminal-marker Technical Note for the host-test-only override) containing
   exactly `{ runId, ok, completedAt }` (`completedAt` ISO-8601, `ok` as computed by
   `finish`). The path is a constant, not derived from `--journal <path>`: it is the sole
   completion signal a host-side poller outside the box can key on (DF3.2 AC5 polls it and
   predicates on `ok === true`). The marker is written on every settled run, accepted or
   not; a run that never reaches `finish` leaves it absent, which is what makes absence
   meaningful to the poller.

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `bun scripts/pipeline-run.ts --manifest <path>` | in-scope | `tests/phase-engine/pipeline-run.test.ts` | — |
| `loadManifest()` / `Run.phase()` library import | in-scope | `tests/phase-engine/phase-lifecycle.test.ts` | — |
| tier-2 resident agent steering the engine | out-of-scope | — | DF3.3 |
| `fleet dispatch` CLI invoking the engine in-box | out-of-scope | — | DF3.1 |
| gate registration on a phase | out-of-scope | — | DF1.2 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| the project's bun toolchain | root `package.json` workspace toolchain (already installed) | `bun test tests/phase-engine` runs green in CI |
| `zod` schema validator | existing root dependency (already used at `src/gate/gate-runner.ts:117`) | manifest schema compiles at import; no new dependency added |
| journal output directory | host filesystem beneath the pinned run root | `pipeline-run.ts` creates the directory at start and fails the run if creation fails |

## Technical Notes

- **Contracts/Schema (new, owned by this story):** `PipelineManifest { version, pipelineId,
  runBudgetMs, phases: PhaseSpec[] }`; `PhaseSpec { name, kind: "engineer"|"agent"|"code",
  description, maxDurationMs, retries: 0..5, command?: string[],
  testCommand?: string[] }`
  — `command` is required when `kind === "code"`, forbidden otherwise, and is the only
  manifest-borne argv source DF1.2's `commandGate` may use; `testCommand` is optional on any
  kind and is the argv DF1.6's engine-side test-count producer runs host-side (DF1.6 AC6) —
  absent means `testsExecuted: false`, never a silent zero; `previous?: Envelope` on
  `PhaseParams` is DF1.2's. Closed zod (`.strict()`), `JSON.parse`, no new dependency.
  `exitStatus` imports from `cli-anything/src/types.ts:79` (CC-1, 5-value); never re-declared.
- **Retry constants live here, not in DF1.3 (ownership, resolves the circular attribution):**
  the `retries: 0..5` schema bound and the module constant `PARSE_FIX_ATTEMPTS = 2` are both
  declared by this story in `src/phase-engine/types.ts`, because this story's admission formula,
  boundary test, and closed schema all depend on them and DF1.3 lands later. DF1.3 imports both
  and owns only the retry *behaviour* they parameterise (gate-retry loop, parse-fix loop); it
  re-declares neither.
- **`PhaseParams.agent` (new, owned by this story):** `agent?: { agentId: string; provider:
  string; model: string; contextWindow: number }`, closed (`.strict()`) like the rest of the
  schema. It is the single declared source of the identity DF1.3 keys its session cache on —
  DF1.3 cites `PhaseParams.agent`, defines no roster of its own, and takes no DF1.5 dependency
  for it. Populated by whatever constructs the phase (the run's roster resolution, where one is
  configured; the caller directly otherwise); absent means the phase runs without a cached session.
- **`effectiveCeilingMicros` (new, optional, owned by this story):** the run context carries
  `effectiveCeilingMicros?: number` — the run's effective spend ceiling in integer µ$ (DD-9). It is
  **optional by design**: this story is v5-S1 and its producers are v5-S2 (DF3.1 at dispatch, DF2.8
  for the budget cap), so declaring it here lets an S1 consumer read it without inverting sprint
  order. Absent means "no run-level ceiling was supplied", never zero and never unlimited — a
  consumer that cannot proceed without one says so rather than substituting a default. DF1.6 is the
  first consumer: it raises the tier-3 harness `budgetCapUsd` at spawn when the field is present and
  leaves the harness default alone when it is not. **The producer is DF3.1**, whose dispatch AC sets
  the run-context field to `min(remainingMicroUsd, defaultKeyCapMicroUsd)` — the same value it hands
  to key minting. No other story writes it, and DF2.8 supplies only the `remainingMicroUsd` input to
  that minimum via `assertWithinBudget`'s return.
- **Terminal-marker root (`RUN_MARKER_ROOT`):** AC7's marker path is
  `` `${RUN_MARKER_ROOT}/journal/final.json` `` where
  `RUN_MARKER_ROOT = process.env.QDS_RUN_ROOT ?? "/run"`. In the box — the only environment whose
  markers a poller reads — `QDS_RUN_ROOT` is unset and the path is exactly `/run/journal/final.json`,
  so AC7's constant-not-derived-from-`--journal` rule is unchanged. The override exists solely so the
  host-side test suite can exercise `finish()` on a machine where `/run` is root-owned (Linux CI) or
  absent (darwin dev); it is **never** set on a real run, and no production code path writes it.
  DF3.2's host-side poller mirrors this sentence from its own side.
- **Phase primitive shape:** one lifecycle wrapper serving all three kinds — no per-kind
  subclass and no phase registry (v5 §3.3 adopt list; pattern at
  `MOD/runner.py:72-111`). Status defaults to `fail` in two independent places: the record
  model default and the journal write default (`MOD/data_types.py:63`,
  `MOD/tracer.py:33`). Only the clean-exit branch writes `success`
  (`MOD/runner.py:104-111`).
- **Phase outcome vs run outcome (do not collapse them):** `Run.finish(accepted)` computes
  `ok = phases.length > 0 && phases.every(p => p.status === "success") && accepted`
  (`MOD/runner.py:114-142`). A test phase that ran the suite did its job even when the
  suite came back red — the **phase** succeeds, the **run** must not. Concretely: a `code`
  phase whose command exits non-zero is **data, not a phase failure** (DF1.2 AC4 owns that
  rule), so no fixture or test in this story may use a failing `code` command to demonstrate
  a `fail` phase — a thrown body is the only mechanism that does.
- **Versioning and in-flight pin (survives from P1.4, `p1-4-protocol-template.md:124`):**
  "Protocol templates are immutable once registered. Updates require a new templateId or a
  new version number. In-flight sessions pin the template version at invocation time — the
  session runs against the version that was current when it started." The manifest is read
  once, frozen, and carried by value for the run's lifetime, so a mid-run edit to the file
  has no effect. The source clause's `GET /api/protocol-templates/...` retrieval route dies
  with the SwarmClaw registry (v5 §7) and is not carried.
- **Load-time validation errors (survives from P1.4, `p1-4-protocol-template.md:129-134`):**
  `phaseCount < 2`, invalid phase kind, and `templateId must match ^[a-z][a-z0-9-]{1,63}$`
  carry as manifest load errors. The source's HTTP statuses and JSON-RPC `-32602` codes are
  SwarmClaw transport and are not carried — a load failure is a thrown `ManifestError`
  with the same message text.
- **Guards/limits (new material per design §5.2; source clause P1.6 INV-4,
  `p1-6-pi-team-protocol-step.md:115`, where a 600s phase bound sat under P1.1's 900s
  SwarmClaw dispatch ceiling — that upstream ceiling dies with the front door and is not
  reused):** per-phase `maxDurationMs` defaults to 600,000 ms, hard upper bound 900,000 ms.
  **`maxDurationMs` is per-attempt, not per-phase-total** — the engine arms a fresh timer for
  each attempt, so a retried phase's wall-clock is the sum of its attempts' ceilings, and the
  admission formula must carry both retry multipliers. Routing margin is 5,000 ms **per phase**
  for engine dispatch and journal-write overhead. Load requires
  `sum((retries + 1) * (PARSE_FIX_ATTEMPTS + 1) * maxDurationMs) + phases.length * 5000 <=
  runBudgetMs <= callerBudgetMs`, where `PARSE_FIX_ATTEMPTS` is this story's module constant
  (`2`, declared in `src/phase-engine/types.ts`, so the real per-phase ceiling is 3× the
  gate-retry count) — both retry loops are budgeted, so DF1.3 cannot overrun the caller's
  ceiling.
- **Signal safety:** SIGTERM and SIGINT are converted to a terminating exception so the
  handler closes the run (`ok=false`) and settles its phase rows, rather than leaving the
  journal claiming work is in flight that is already dead (`MOD/session.py:21-35`).
- **`PhaseJournal` port contract (defined here, ahead of DF1.2/DF1.4).** The port this story's
  file-backed journal implements, and the only surface DF1.2 (gate-event persistence) and DF1.4
  (SQLite trace store) may write through:
  - **Operations:** `writePhase(record)` (upsert by `phaseId`, default status `fail`),
    `promotePhase(phaseId, status, exitStatus?)` (the sole path to `success`), `writeGateEvent(event)`
    (DF1.2-owned event shape, append-only), `finish(runId, accepted): { ok, completedAt }`.
  - **Required fields on every persisted phase row:** `runId`, `phaseId`, `name`, `kind`, `status`,
    `startedAt`, `updatedAt`; `exitStatus` once settled.
  - **Ordering:** writes for a single phase are strictly ordered — `writePhase` (status `fail`)
    precedes any `promotePhase` call, and no call for phase *N+1* is issued before phase *N*'s
    row has been durably written. The port does not reorder or batch across phases.
  - **Write-failure behavior:** a failed write (disk full, port throw) fails the run — never a
    silent skip — and is itself recorded as a `fail` row where the port can still write one; where
    it cannot, the engine aborts with a non-journal-writable error rather than proceeding as if the
    phase succeeded.
  DF1.2 persists gate events through `writeGateEvent` only; DF1.4 replaces the storage
  implementation behind these four operations without changing their signatures or semantics.
- **Deviation/assumption:** the journal is file-backed here because DF1.4 owns the SQLite
  trace store. If DF1.4's schema requires a field this port does not expose, DF1.4 widens
  the port; it does not fork the lifecycle. Recorded so the swap is a known, bounded edit.

## Observability Contract

- Every phase logs `{ requestId, pipelineId, phase, kind, timestamp, durationMs, status, exitStatus? }`
- `requestId` is supplied by the caller and propagates unchanged onto every phase record and
  log line; errors include `{ code, message, stack? }`
- Sub-timings: `manifest_load_ms`, `phase_body_ms`, `journal_write_ms`. A phase that did not
  run reports `0`; where a breakdown is unavailable, `durationMs` is authoritative.

## Files to Modify

- `src/phase-engine/index.ts`
- `src/phase-engine/types.ts` (**new** — `PhaseSpec`/`PhaseParams` types, the `retries: 0..5`
  bound, `PARSE_FIX_ATTEMPTS = 2`, `PhaseParams.agent`; this story creates the file and four
  siblings append their own regions to it — DF1.2 adds only `PhaseParams.previous`, DF1.3 only its
  retry-loop types, DF1.4 only its trace/event types, DF1.8 only its issue-correlation types —
  nobody re-declares what this story put there)
- `src/phase-engine/manifest.ts`
- `src/phase-engine/phase.ts`
- `src/phase-engine/journal.ts`
- `scripts/pipeline-run.ts`
- `tests/phase-engine/phase-lifecycle.test.ts`
- `tests/phase-engine/manifest.test.ts`
- `tests/phase-engine/pipeline-run.test.ts`
- `tests/phase-engine/fixtures/pipeline.qds-factory.json`

## Security Invariants

- INV-1: The manifest is read through a **beneath-root walk** anchored at the pinned run
  root — open the root once (`O_DIRECTORY`), walk one component at a time with
  `O_NOFOLLOW` relative opens, and read through the resolved handle rather than re-opening
  by string. `O_NOFOLLOW` alone is **not** sufficient and must not be described as
  eliminating traversal: it refuses only the final component, so an attacker controlling
  any intermediate directory redirects the open outside the root
  (`p1-6-pi-team-protocol-step.md:112-113`).
  **Permitted equivalent on Node/Bun.** Neither runtime exposes per-component relative
  `openat(O_NOFOLLOW)`, so the literal component-walk is not implementable in this stack and
  MUST NOT be read as a requirement that blocks the story. The shipped mechanism is the
  equivalent named at `p1-6-pi-team-protocol-step.md:113`: `fs.realpath` the full candidate
  path, **re-assert the resolved run-root prefix on the result** (a path resolving outside the
  root is rejected), open a file descriptor on that resolved path, and perform every read
  **through that descriptor** — never re-opening by string afterwards. `fs.realpath` followed
  by a path-based `open()` is **not**, by itself, TOCTOU-safe: an attacker who controls an
  intermediate directory can replace it between the `realpath` resolution and the `open` call,
  so the prefix re-assertion alone does not close that interval. The mechanism is completed by
  a **post-open verification**: after the fd is obtained, resolve the fd's own path (on
  platforms exposing `/proc/self/fd/<fd>`, via `fs.readlink`; Bun/Node without that facility
  fail closed per INV-5) and confirm it still starts with the run-root prefix before any read
  through the descriptor is trusted. This closes the window an unverified fd-open leaves: the
  prefix re-assertion rules out intermediate-symlink redirection *at resolution time*, and the
  post-open fd-path check rules out a swap *during* the resolve-to-open interval. Where the
  post-open check cannot be performed on the running platform, INV-5's fail-closed rule
  applies — the read is refused, never accepted on the unverified fd. Either the component walk
  or this resolve-assert-verify-fd form satisfies INV-1; nothing weaker does.
- INV-2: Validation strictly precedes construction. The closed (`.strict()`) schema runs on
  the parsed object before any `Phase` exists; a manifest that fails validation constructs
  nothing, journals nothing, spawns nothing. Unknown fields are a rejection, not a warning —
  a permissive parse is how an unreviewed phase kind reaches execution.
- INV-3: `maxDurationMs` is enforced by an engine-owned timer **armed per attempt** — a fresh
  timer for every attempt of a retried phase, never one timer spanning the whole phase — using
  the ceiling and margin arithmetic stated in Technical Notes. On expiry the engine aborts the phase
  body's `AbortSignal`, awaits cancellation (including termination of owned subprocess
  trees), records `fail` with `exitStatus: "overflow"`, and halts the walk. A phase cannot
  raise its own ceiling.
- INV-4: The manifest carries **no credential material**. Any string value matching a
  credential shape (`sk-`, `ghp_`, `Bearer `, `-----BEGIN`, or a field named
  `key`/`token`/`secret`/`password`) rejects the load. Model and provider credentials
  resolve from the process environment at spawn time and never transit a manifest file or
  a journal record.
- INV-5: **Fail closed.** Where **neither** INV-1 form — the component walk nor the
  resolve-assert-verify-fd equivalent, including its post-open fd-path check — can be performed
  on the running platform, the engine refuses the read and fails the run; never a silent
  degrade to bare `O_NOFOLLOW`, and never to `lstat` + `open`, which is a check-then-use pair
  with a real TOCTOU window (`lstat` + `open` differs from the permitted form precisely in that
  it re-opens by string after checking, which the permitted form never does). Likewise, a
  record written and never promoted reads `fail`, so an engine crash between write and
  promotion is recorded as failure rather than as absence.

## Definition of Done

- [ ] **Impl:** One lifecycle wrapper serves all three phase kinds — no per-kind subclass and no phase registry in the diff.
- [ ] **Impl:** `Run.finish(accepted)` settles journal row, banner, and exit code in a single call; `ok = allPhasesSucceeded && accepted`.
- [ ] **Contract:** `PipelineManifest` closed zod schema with `version`, immutability, and the in-flight version pin enforced; `command` present iff `kind === "code"`; `exitStatus` imported from `cli-anything/src/types.ts:79`, never re-declared. `PhaseParams.agent {agentId, provider, model, contextWindow}` and the `retries: 0..5` bound and `PARSE_FIX_ATTEMPTS = 2` all declared in `src/phase-engine/types.ts` by this diff.
- [ ] **Security:** Manifest read uses the beneath-root walk and refuses rather than degrading where unavailable (INV-1, INV-5).
- [ ] **Security (shipped mechanism named):** the diff names which INV-1 form it implements on the project's bun toolchain — component walk or `fs.realpath` + run-root prefix re-assertion + post-open fd-path verification + read through the resolved fd — and a reviewer can point at the prefix re-assertion, the post-open verification, and the fd-based read in the code. "Uses `O_NOFOLLOW`" is not an acceptable answer to this item.
- [ ] **Security:** Credential-shaped manifest values reject the load (INV-4).
- [ ] **Test (intermediate-symlink traversal, INV-1):** a symlink at an intermediate directory of the manifest path pointing outside `runRoot` → load is rejected by the beneath-root walk, not by `O_NOFOLLOW` on the final component alone.
- [ ] **Test (resolve-to-open swap, INV-1):** an intermediate directory of the manifest path is replaced with a symlink pointing outside `runRoot` **after** `fs.realpath` resolves but **before** the `open` call → the post-open fd-path verification detects the mismatch and the load is rejected; an implementation that trusts the fd without this check MUST fail this test.
- [ ] **Test (default-fail, negative control):** A phase record written and never promoted reads `fail`. An implementation that writes `success` optimistically and downgrades in a `catch` passes a naive check and MUST fail this test.
- [ ] **Test (description legibility):** `{name:"commit_plan", description:"Commit the plan"}` throws at construction; `{name:"commit_plan", description:"Persist the reviewed plan to the run artifact directory"}` constructs.
- [ ] **Test (signal):** SIGTERM delivered mid-phase → run closes with `ok=false`, the open phase reads `fail`, and no journal row remains in an in-flight state.
- [ ] **Test (overflow cancellation):** a phase body whose `maxDurationMs` elapses → the `AbortSignal` fires, owned subprocesses terminate, the phase reads `fail` with `exitStatus: "overflow"`, and no post-overflow side effect (subprocess output, file write, journal row) appears after the timer fires.
- [ ] **Test (boundary):** A 1-phase manifest fails to load; a 2-phase manifest loads. A manifest whose budgets exceed `callerBudgetMs` by 1 ms fails to load — asserted at `retries: 0`, at `retries: 1`, and against the `(PARSE_FIX_ATTEMPTS + 1)` factor, so neither retry multiplier can be dropped silently.
- [ ] **Test (walk termination on throw, AC6):** a 3-phase manifest whose phase 2 body throws → the journal contains exactly two rows (`success`, `fail`); phase 3 appears in no status, and a constructor spy proves it was never constructed.
- [ ] **Contract (terminal marker, AC7):** `finish()` writes `` `${RUN_MARKER_ROOT}/journal/final.json` `` = `{runId, ok, completedAt}` — asserted for an accepted green run (`ok:true`) and a red run (`ok:false`) — and a run killed mid-phase leaves the path absent. `RUN_MARKER_ROOT = process.env.QDS_RUN_ROOT ?? "/run"`; the tests set `QDS_RUN_ROOT` to a temp dir, and one assertion proves that with the variable unset the resolved path is exactly `/run/journal/final.json`, so the override cannot silently become the production path.
- [ ] **Contract (`effectiveCeilingMicros`):** the run context type declares `effectiveCeilingMicros?: number` — integer µ$, **optional**, where absent means "no run-level ceiling was supplied" and is neither zero nor unlimited. This story declares the field and reads it nowhere; DF3.1's dispatch AC is the sole producer and DF1.6's spawn seam the first consumer.
- [ ] **Test (e2e demo — MANDATORY):** `bun scripts/pipeline-run.ts` against the fixture exits `1` and writes `out.json` showing `ok:false` with `phases[0].status="success"`, `phases[1].status="fail"`.
- [ ] **Process (GitNexus, project coding guideline):** before editing any lifecycle, manifest,
      journal, or test symbol in this diff, run `impact({ target: "symbolName", direction:
      "upstream" })` and stop on a HIGH or CRITICAL risk report; before commit, run
      `detect_changes({ scope: "compare", base_ref: "main" })` and confirm only the expected
      symbols and flows changed.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
