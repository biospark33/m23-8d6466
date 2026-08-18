---
baseline_commit: d5ed5f082018bd11389dca56d05a97a8cf212d9c
---

# DF1.8: Run Capture Correlated to the GitHub Issue (Trace-Store-Backed)

**Story Points:** 3
**Sprint:** v5-S2 (engine closure)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §5.2 (observability — requestId propagation end-to-end), §5.3 (data flow, one run), §6 item 4 (audit), §6 item 7 (trace confidentiality)
- Decision register: v5 §4 **D6** (SSSF trace schema adopted as the capture mechanism), **D8** (a dispatch mints a spend-capped key); §10 **F10**, **F11**
- Derivation decisions: `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md` **DD-8** (surviving clauses from R2 only)
- Surviving clauses: R2 §4 (P1.8 crosswalk) — `p1-8-protocol-run-github.md:34, :36-39, :40, :41, :53, :58, :79, :80, :81, :91`
- Binding facts: R5 §6 facts **15**, **16**

## User Story

As an operator answering "what did the factory do about issue #42 in this repo",
I want every phase, event, envelope and gate result of a run to be reachable from the
`(repoSlug, issueId)` pair that started it, on one unbroken requestId chain,
so that a run is auditable from the issue that authorized it without a second record to reconcile.

## Overview

A dispatch arrives carrying an already-created GitHub issue reference. `resolveRunCorrelation`
settles the `requestId` once, validates `(repoSlug, issueId)`, and writes them onto the DF1.4
`sessions` row at creation — through DF1.4's own additive migration list, not a new store. Every
later row in the seven-table trace already carries `request_id` (DF1.4 AC1); this story makes that
column *mean* something end to end. **There is no second capture layer:** the trace store IS the
capture, and the correlation is three columns, one unique index and one query on top of it.

## E2E Slice

**Demonstrable behavior:** Given a GitHub issue `qds/demo#42` and a dispatch carrying
`{ repoSlug: "qds/demo", issueId: 42, requestId: <uuid v4> }`, When the engine runs a two-phase
pipeline, Then `trace.db` holds one `sessions` row with `repo_slug`/`issue_id`/`issue_url`
populated and `request_id` equal to the value the caller read back; `readRunsByIssue("qds/demo",
42)` returns that run with both `phases` rows and their outputs; a chain check over all seven
tables returns **zero** rows whose `request_id` is absent or differs; and the identical dispatch
replayed produces no second `sessions` row.

**Wiring closed:** On completion of this story, a run is persisted against its issue and retrievable
by `(repoSlug, issueId)` using only code merged by this story plus DF1.1/DF1.4/DF1.6. No stub, no
`TODO: wire later`, and no sibling story is required. Issue *creation* is P1.2's (KEEP, repointed by
DF5.5); this story consumes an issue reference and never writes to GitHub.

**Dependency edges (predecessors):** DF1.4, DF1.6. *(P1.2 issue-intake removed from hard deps: this
story consumes an issue reference supplied in the dispatch brief, which an operator can create
manually; P1.2 automates that intake and remains KEEP, repointed by DF5.5.)*

## Acceptance Criteria

1. **(make-or-break)** Given a dispatch carrying `(repoSlug, issueId, requestId)`, When the run
   executes, Then the DF1.4 `sessions` row carries `repo_slug`, `issue_id` and `issue_url`; every
   row written to all seven trace tables for that run carries the **same resolved** `request_id`;
   a chain-integrity query returns zero rows with an absent or divergent `request_id`; and
   `readRunsByIssue(repoSlug, issueId)` returns the run with each phase and its persisted output.
   *Negative controls: a second capture table alongside the trace, or a fresh id minted per phase.*
2. Given runs exist for issue number 42 in two different repositories, When state is queried by
   `(repoSlug, issueId)`, Then only the run for the named repository is returned. Retrieval by issue
   number alone is **not supported** — the reader has no such entry point — and a dispatch omitting
   `repoSlug` is rejected before any session row, box or key exists, never defaulted.
3. Given a dispatch is replayed with the same `(repoSlug, requestId)` — a retried invocation, a
   duplicated brief — When initiation runs, Then exactly one `sessions` row exists, the first wins,
   and the second initiation returns that run's `runId`. Uniqueness holds after the run completes,
   so a late replay cannot re-open it (INV-RUN-1). **And given the same `requestId` arriving with a
   *different* `repoSlug` from the row that already exists**, Then initiation refuses with a
   structured `RequestIdRepoMismatch` error naming both slugs, mints no key, provisions no box, and
   writes no row — it is neither treated as a fresh run (the id is already spoken for) nor silently
   accepted onto the existing row (which would re-point a run at another repository, violating
   INV-RUN-2).
4. Given initiation fails before a `sessions` row can be written (trace open refused, dispatch
   rejected, box never created), When the caller inspects the response, Then it receives
   `runId: null` explicitly — never a fabricated or optimistic id — with the resolved `requestId`
   and a structured error, and the failure is recorded against `(repoSlug, issueId)` in the
   host-side dispatch log rather than discarded.
5. Given an unknown `(repoSlug, issueId)`, or a run whose phases have not started, When the reader
   pages, Then it returns an empty page with the cursor unchanged and `hasMore: false` — not an
   error, and no partial row is synthesized to fill it.

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| Engine run initiation from a dispatch brief carrying an issue ref | in-scope | `tests/phase-engine/issue-correlation.test.ts` | — |
| `scripts/pipeline-run.ts --repo-slug <o/n> --issue <N>` (DF1.1 driver script) | in-scope | `tests/phase-engine/pipeline-run.test.ts` | — |
| DF1.6 `dispatch_task` phase output persisted against the run's issue | in-scope | `tests/phase-engine/issue-correlation.test.ts` | — |
| In-process reader `readRunsByIssue` / `readRunPhases` | in-scope | `tests/phase-engine/trace/reader.test.ts` | — |
| GitHub write-back (comment or PR body carrying `runId` + issue refs) | out-of-scope | — | DF5.2 |
| HTTP query surface over correlated runs | out-of-scope | — | DF4.1 |
| Audit-chain join across runs, keys and cost; `fleet dispatch` passing the issue ref | out-of-scope | — | DF5.3, DF3.1 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| DF1.4 trace store `<data_dir>/trace.db` | `bun:sqlite`, bundled with the project's bun toolchain — no new dependency | engine `Run` init opens the writer and applies migrations before phase 1 opens |
| DF1.4 additive migration list | same file, same init path | the three `ADD COLUMN` entries and the unique index apply on an existing `trace.db` fixture and preserve its rows |
| GitHub issue reference `(repoSlug, issueId, issueUrl)` | supplied by the dispatch brief; created by P1.2 (KEEP) | dispatch validation rejects a brief missing `repoSlug` before the run record exists |
| Host-side dispatch log (AC4's `runId: null` path) | local filesystem inside the repo data boundary, mode `0600` | append proven by the AC4 test; survives the trace open failing |

## Technical Notes

- **Contracts/Schema:** no new store. DF1.4's `MIGRATIONS` (shape `[table, column, decl][]`, applied
  via `PRAGMA table_info` + `ADD COLUMN`, so re-apply is a no-op and there is no down-migration by
  design) gains three entries: `sessions.repo_slug TEXT`, `.issue_id INTEGER`, `.issue_url TEXT`.
  Rollback is leaving three unused nullable columns — nothing here is destructive or rewrites data.
  A uniqueness constraint does **not** fit that tuple shape, so `CREATE UNIQUE INDEX IF NOT EXISTS
  sessions_repo_request ON sessions(repo_slug, request_id)` is appended to DF1.4's existing
  `SCHEMA_INDEX_DDL` list, which DF1.4 already applies in its schema-init step beside
  `CREATE TABLE IF NOT EXISTS`. This story issues its index **through that existing mechanism** —
  DF1.4's INV-5 is already additive and already provides for index DDL, so nothing here amends it.
  Both DF1.4 lists (`MIGRATIONS` and `SCHEMA_INDEX_DDL`) are append-only and order-stable; this
  story appends and reorders nothing.
- **`src/phase-engine/types.ts` is shared — region ownership.** DF1.1 creates the file and owns the
  `PhaseSpec`/`PhaseParams` types, the `retries: 0..5` bound, `PARSE_FIX_ATTEMPTS`, and
  `PhaseParams.agent`; DF1.2 adds only `PhaseParams.previous`; DF1.3 adds only its retry-loop types;
  DF1.4 adds only its trace/event types. This story **adds only** its issue-correlation types — the
  `(repoSlug, issueId)` correlation shape and the resolved-`requestId` result type — and edits no
  sibling's declarations. Five stories touch one file; each appends its own region, so the merges
  are additive and no declaration has two authors.
- **Issue identity is `(repoSlug, issueId)`, never `issueId` alone** (`p1-8-protocol-run-github.md:53`,
  carried): issue numbers are unique only *within* a repository — `#42` exists in every repo the
  factory touches, so keying runs, queries, telemetry or the uniqueness constraint on `issueId`
  alone lets two repositories' `#42` collide or be returned together. `repoSlug` (the `owner/name`
  slug P1.3 threads through `resolveBankId(repoSlug)`) is required on the run, in every state-event
  payload, on every query, and in the constraint; initiation rejects a brief omitting it rather than
  defaulting. `runId` stays globally unique and needs no repo scoping. D3's fan-out makes the
  collision this rule prevents *more* likely, not less.
- **Boundary with DF3.1 — DF1.8 owns `resolveRunCorrelation`; DF3.1 calls it.** Both stories describe
  requestId resolution and pre-provision rejection of a malformed dispatch, which is one behavior with
  two descriptions, not two implementations. This story owns the function: settling the requestId,
  validating `(repoSlug, issueId)`, and refusing before any session row, box or key exists. DF3.1's
  `fleet dispatch` **imports and calls** `resolveRunCorrelation` and owns only the mapping from its
  structured refusal to a CLI exit code — it re-implements no validation, mints no id, and does not
  re-derive the rejection rules. A second correlation resolver in DF3.1's diff is a defect. DF3.1's
  own Technical Notes carry the mirror of this note.
- **Shared file with DF3.3 — `scripts/pipeline-run.ts`.** Both this story and DF3.3 edit that script
  and both land in v5-S2, so **DF3.3 sequences after DF1.8**: this story adds the
  `--repo-slug`/`--issue` flags and the correlation wiring at run initiation; DF3.3 layers its
  resident-steering entry points on top of the resulting file rather than beside a version that never
  had them. DF3.3 carries the mirror of this note.
- **Resolved-requestId rule** (`p1-8-protocol-run-github.md:36-39`, re-aimed off the dead transport):
  the dispatcher settles the id once — honouring a caller-supplied value only if it is a strict UUID
  v4, else generating one — and **every** downstream row carries the *resolved* value. A caller
  reads the id back from the response rather than assuming its own stuck. No second identifier.
- **State-event field set** (surviving contract, `p1-8-protocol-run-github.md:34`): a phase
  transition records `runId`, `repoSlug`, `issueId`, `requestId`, `phase`, `status`, `timestamp`.
  The source's five-phase list dies with the P1.4 template — phases come from DF1.1's manifest.
- **Guards/limits:** `repoSlug` matches `^[A-Za-z0-9._-]{1,100}/[A-Za-z0-9._-]{1,100}$`; `issueId`
  is a positive integer ≤ 2^31-1; `requestId` is a strict UUID v4. Reader paging inherits DF1.4's
  `MAX_LIMIT = 1000` / default 500 cursor unchanged; all three values are bound parameters.
- **Enum and exit-code discipline** (`p1-8-protocol-run-github.md:91, :58`, carried): import
  `ExitStatus` from `cli-anything/src/types.ts:79` — the single source of truth; a review grep of
  these files for a literal `'success' | 'transient' | ...` spelling MUST come back empty. `exitCode`
  is `number | null` — absent when `exitStatus` is `success`, present (possibly `null`) for every
  failure including `lead_failure`; absent (no outcome) ≠ `null` (signalled), neither reads as `0`.
- **Deviation/assumption:** R5 §6 fact 15 — in-box trace evidence is a **claim, not proof**. A
  correlated run record attests that the box *said* these phases happened; DF5.1 re-verifies
  host-side before any PR opens, and no AC here may be read as attesting to the run's contents.

## Observability Contract

- Every phase transition logs `{ requestId, runId, repoSlug, issueId, phase, status, timestamp, durationMs, exitStatus }`.
- `requestId` originates at dispatch as the resolved value and is a bound parameter on every insert
  and every read; errors include `{ code, message, stack? }` and name the correlation pair.
- Sub-timings: `correlation_resolve_ms`, `session_upsert_ms`; absent a breakdown, report 0 and treat
  the caller's `durationMs` as authoritative.

## Files to Modify

- `src/phase-engine/issue-correlation.ts`
- `src/phase-engine/trace/migrations.ts`
- `src/phase-engine/trace/schema.ts`
- `src/phase-engine/trace/reader.ts`
- `src/phase-engine/types.ts`
- `scripts/pipeline-run.ts`
- `tests/phase-engine/issue-correlation.test.ts`
- `tests/phase-engine/trace/reader.test.ts`
- `tests/phase-engine/pipeline-run.test.ts`

## Security Invariants

- **INV-RUN-1 (idempotent identity):** idempotency rests on `sessions`' **primary key**, which is
  `request_id` (DF1.4) — the resolved requestId is already globally unique across the table, so a
  replayed dispatch collides on the pk and the transactional upsert makes the second initiation a
  no-op that returns the existing `runId`. The constraint deliberately outlives run completion, so a
  late replay cannot re-open a closed run. Under D8 an initiation mints a spend-capped key and
  provisions a box, so a double-create costs real money and leaves a second live credential.
  **`sessions(repo_slug, request_id)` adds no uniqueness** and must not be described as the
  idempotency mechanism: `request_id` is already unique alone, so the composite index can never
  reject a row the pk would have accepted. It exists to **back the AC2 query** — `readRunsByIssue`
  and every cross-repo-scoped read filter on `repo_slug` first, and this index is the covering path
  for that filter. Declaring it `UNIQUE` is a cheap consistency assertion over a pk-derived pair, not
  a constraint doing work. The repoSlug half of identity is enforced by AC3's
  `RequestIdRepoMismatch` check, not by the index. A `sessions` row from a bare DF1.4 run with no
  issue carries a NULL `repo_slug`, mints no key, and is returned by no reader here.
- **INV-RUN-2 (append-only):** run state events and phase records are append-only — no mutation of
  a historical record after it is persisted. The three correlation columns are written **once** at
  session creation and never rewritten, so a completed run cannot be re-pointed at a different
  issue after the fact.
- **INV-RUN-3 (issue scoping):** run telemetry is scoped to the originating issue — cross-issue
  data leakage is prohibited. Every read is filtered on `(repo_slug, issue_id)` as bound
  parameters; there is no reader entry point that takes `issueId` alone, so the cross-repo query
  cannot be written by accident.
- **INV-RUN-4 (no fabricated correlation):** a `runId` is returned only when a `sessions` row
  exists; every other outcome returns `runId: null` with the resolved `requestId`. No component
  downstream of the dispatcher mints a correlation id, and none rewrites one it received.
- **INV-RUN-5 (confidentiality, inherited and unextended):** the trace holds full compiled prompts —
  client source code (F11/R10). This story adds **no listener, no port and no network I/O**, writes
  nothing to GitHub, and adds three columns inside the existing data boundary with no export path.
  The AC4 dispatch log carries the correlation pair and an error code only — never prompt content.

## Definition of Done

- [x] **Impl:** `resolveRunCorrelation` settles the requestId (strict UUID v4 honoured, else
      generated) and validates `(repoSlug, issueId)` before any session row, box or key exists.
- [x] **Impl:** DF1.4 `MIGRATIONS` extended with the three `ADD COLUMN` entries and the
      `sessions(repo_slug, request_id)` unique index appended to DF1.4's existing `SCHEMA_INDEX_DDL`;
      an existing `trace.db` fixture migrates intact and re-applying the migration is a no-op.
- [x] **Contract:** `readRunsByIssue(repoSlug, issueId, cursor?)` returns `{ rows, cursor, hasMore }`
      on DF1.4's rowid-cursor shape; no reader accepts `issueId` alone.
- [x] **Integration:** DF1.6 `dispatch_task` step outputs land against the run's issue on the same
      resolved `requestId`; `ExitStatus` imported from `cli-anything/src/types.ts:79`, not re-declared.
- [x] **Security:** correlation columns write-once (INV-RUN-2); the `request_id` primary key plus the
      transactional upsert make a replayed initiation a no-op that mints no second key, and a
      same-requestId/different-repoSlug dispatch refuses with `RequestIdRepoMismatch` (INV-RUN-1, AC3).
- [x] **Test (unit):** chain-integrity query over all seven tables returns zero rows with absent or
      divergent `request_id`; a fixture minting a fresh id in one phase MUST fail it.
- [x] **Test (cross-repo):** runs for `#42` in two repos → query by one pair returns exactly one
      run; a reader keyed on `issueId` alone does not exist to be called.
- [x] **Test (replay):** identical `(repoSlug, requestId)` dispatched twice, once after completion
      → one `sessions` row, first-close-wins, second call returns the existing `runId`.
- [x] **Test (requestId/repo mismatch):** a dispatch reusing an existing `requestId` under a different
      `repoSlug` → structured `RequestIdRepoMismatch` naming both slugs, no second `sessions` row, the
      existing row's `repo_slug` unchanged, and no key minted. An implementation that upserts onto the
      existing row MUST fail this test.
- [x] **Test (initiation failure):** trace open refused → `runId: null` plus the resolved
      `requestId`, failure recorded against the pair, no fabricated id anywhere.
- [x] **Test (e2e demo — MANDATORY):** run the two-phase pipeline of the E2E Slice against
      `qds/demo#42` and capture `trace.db` plus the `readRunsByIssue` page as artifacts, showing the
      correlated `sessions` row and the zero-divergence chain check.

## Dev Agent Record

**Status: complete — 2026-08-18, branch `feature/df1-8-run-capture-issue-correlation`.**

### Implementation Plan (as executed)

RED → GREEN → WIRING, via parallel subagent waves (3 test writers, then 2 implementers), all
pinned to a locked contract file (`_bmad-output/workflow-state/qds-dev/df1-8/contract.md`):

- **RED:** `tests/phase-engine/issue-correlation.test.ts` (18 tests), `tests/phase-engine/trace/reader.test.ts` (+17), `tests/phase-engine/pipeline-run.test.ts` (+6) — all confirmed failing before any implementation existed (import errors / missing methods / contract gaps).
- **GREEN engine core:** `types.ts` DF1.8 region (`IssueRef`, `ResolvedRunCorrelation`, `TracePhaseRow`, `CorrelatedRunRow`, `CorrelatedRunPage`, `TracePhasePage`); `migrations.ts` +3 entries (`sessions.repo_slug TEXT`, `.issue_id INTEGER`, `.issue_url TEXT`); `schema.ts` `SCHEMA_INDEX_DDL` +`idx_sessions_repo_request`; net-new `issue-correlation.ts` (`REPO_SLUG_PATTERN`, `UUID_V4_PATTERN`, `MAX_ISSUE_ID`, `CorrelationError`, `RequestIdRepoMismatchError`, `isValidUuidV4`, `resolveRunCorrelation` (pure), `appendDispatchFailure` (0600 JSONL)); `tracer.ts` +`initiateSession` (`db.transaction().immediate()`, SELECT → equal-slug replay / NULL-slug fill-once UPDATE / different-slug throw, INSERT … ON CONFLICT(request_id) DO NOTHING with `changes===0` re-SELECT); `reader.ts` +`readRunsByIssue` / `readRunPhases` (rowid-cursor pages, latest-attempt envelope join, optionalColumn probes, bound params, no issueId-only entry point).
- **WIRING:** `scripts/pipeline-run.ts` — `--repo-slug`/`--issue`/`--issue-url` flags (pair required, strict issue-int parse, `--run-id`+`--repo-slug` = two-identifier refusal), timed resolve (`correlation_resolve_ms`), `runId = requestId =` resolved id (no second identifier), `initiateSession` replaces `startSession` on the correlated path (`session_upsert_ms`), failure ladder (resolve / trace-open / initiate → `appendDispatchFailure(<QDS_RUN_ROOT>/dispatch-failures.log)` + stderr `dispatch_failed` with `runId: null`, exit 2), success line `run_initiated` (runId, replayed, both sub-timings), per-phase `phase_state` log events carrying the p1-8:34 field set. Bare mode byte-identical to DF1.4 behavior.

### Deviation Notes

1. **`initiateSession` throws by design** — unlike every sidecar write method (AC5), correlated
   initiation is a gate: a `RequestIdRepoMismatch` refusal must stop the run before box/key
   minting, not be swallowed as a trace error. Documented in the method JSDoc.
2. **`openWriter` order: migrations now apply BEFORE `SCHEMA_INDEX_DDL`** (statements byte-identical, order only). Required: `idx_sessions_repo_request` references `repo_slug`, which exists only after the DF1.8 migration entries. Without the reorder every Tracer open throws.
3. **`tests/phase-engine/trace/migrations.test.ts` one-line edit** (add `applyMigrations(db)` in the index-DDL test): the DF1.4 test applied index DDL to a SCHEMA_DDL-only DB; that premise is invalidated by an index over migrated columns. The edit restores representativeness of the real init order; original assertions untouched.
4. **UUID v4 variant group `[89ab][0-9a-f]{3}`** (spec text said the pattern; the locked working contract briefly carried `{4}` — a 37-char pattern rejecting all real UUIDs; the tests pinned correct 36-char strict-v4 semantics and the implementation matches them).
5. **FLAG-1 (deliberate drop, from spec research):** p1-8:78's one-live-run-per-`(repoSlug,issueId)` partial unique index (`WHERE status='running'`) is NOT carried. v5's D3 fan-out (DF3.2) legitimately runs N concurrent runs per issue; enforcing it would break that story. Idempotency here is per-requestId only, as INV-RUN-1 specifies.
6. **FLAG-2:** `readRunsByIssue` omits p1-8:40's "assigned agents / elapsed time" fields — both derivable (agent_sessions table; started_at/ended_at already on the row). No AC requires them.
7. **runId ≡ resolved requestId on the correlated path** — "no second identifier" (story Technical Notes); replay-returns-existing-runId is then well-defined with no run_id column. Explicit `--run-id` + `--repo-slug` together is refused (`RUN_ID_CONFLICT`).
8. **Environmental test failures (pre-existing, disjoint from this diff):** full-suite run = 1998 pass / 3 fail — `tests/scripts/roster-check.test.ts` x2 (live gates need `QDS_PI_CATALOG_DIR`, the known pi 0.55.0 packaging gap documented in DF1.6's record) and `tests/lean-worker-benchmark.test.ts` x1 (needs `OPENROUTER_API_KEY`). Both files import only `roster/*` / benchmark code — no DF1.8 file is in their import graph.

### Debug Log

- One transient wave race: pipeline-run suite briefly red while the parallel engine agent's `issue-correlation.ts` was mid-write; re-run green once both landed. No workaround carried.
- Evidence harvest: reading a *copied* trace.db readonly fails with SQLITE_CANTOPEN (copy lacks `-shm`/`-wal` sidecars bun's readonly WAL open requires); harvested from the live run dir instead. Artifact copy is checkpointed and self-contained (sqlite3-verifiable). Not a code defect.

### Completion Notes

- Gates: focal `tests/phase-engine/trace/` **90 pass / 0 fail**; `issue-correlation.test.ts` **18/18**; `pipeline-run.test.ts` **16/16**; `bunx tsc --noEmit` **0 errors**; `biome check` on all changed areas **clean**; full repo suite 1998 pass / 3 environmental fails (Deviation 8).
- Exit-status discipline: grep for a literal `'success' | 'transient'` spelling across DF1.8 files = 0 hits (test-enforced).
- E2E demo artifacts in `_bmad-output/evidence/df1-8/`: `e2e-two-phase-trace.db` (1 correlated `sessions` row for `qds/demo#42`), `readRunsByIssue-page.json` (run + 2 phases), `chain-check.json` (**0 divergent request_id rows across all 7 tables**), `replay-proof.json` + `e2e-run.log` (identical replay dispatch → `replayed:true`, still exactly 1 `sessions` row).
- Reuse mandate (ponytail): lifted the cursor-page shape, optionalColumn probing, 0600/0700 enforcement and strict-int-parse patterns from DF1.4/cli-anything verbatim; net-new surface limited to the two spec'd regexes, the correlation types, `initiateSession`, two reader methods and the CLI wiring.

### Review Findings (self-review round 1, 2026-08-18)

Adversarial sub-agent review of the full working-tree diff (bugs only, categorized, verified against code before reporting). 5 findings, all applied; 0 dismissed.

- [x] Review — Patch [INVARIANT][HIGH] `scripts/pipeline-run.ts` — a replayed correlated invocation re-executed every phase: `finishSession` overwrote the completed run's status/ended_at (last-close-wins), `upsertPhase` overwrote historical rows, phase_state events doubled — violating INV-RUN-1 "a late replay cannot re-open it" and DoD "first-close-wins". Fix: `replayed:true` → `run_initiated` line, guarded tracer close, exit 0 **before** FileJournal/Run/walkPhases are constructed. Live-verified: sessions row byte-identical after replay, phases 2→2, phase_state 4→4.
- [x] Review — Patch [LOGIC][HIGH] `trace/reader.ts` — the latest-attempt envelope join had no tiebreaker; two envelope rows sharing `(request_id, phase_id, attempt)` (e.g. produced by the pre-fix replay path) duplicated the phase in `readRunPhases`/`readRunsByIssue`. Fix: scalar-subselect join (`ORDER BY e2.attempt DESC, e2.rowid DESC LIMIT 1`) — exactly one envelope per phase by construction. New tie test pins it.
- [x] Review — Patch [EDGE CASE/INVARIANT][HIGH] `trace/tracer.ts` `initiateSession` — mismatch check compared `repo_slug` only; same slug + different `issueId` under the same requestId was silently accepted as a replay (cross-issue attribution — INV-RUN-2's "cannot be re-pointed at a different issue" on the issue axis). Fix: full `(repo_slug, issue_id)` pair compare; `RequestIdRepoMismatchError` extended with `existingIssueId`/`attemptedIssueId`, message names both slugs AND both issue numbers. (Root cause: the working contract itself specified slug-only — contract gap realized in code; story text was always the authority.)
- [x] Review — Patch [EDGE CASE][MED] `trace/reader.ts` `readRunsByIssue` — `optionalColumn` probes for the correlation columns in the SELECT were dead (the WHERE hard-references them), implying drift tolerance the query cannot deliver. Fix: reference directly; an unmigrated store fails loudly at prepare (fail-closed), one-line comment.
- [x] Review — Patch [SECURITY][MED] `issue-correlation.ts` `appendDispatchFailure` — none of the tracer's same-boundary symlink/TOCTOU hardening: followed a symlinked log path, never mode-checked a pre-existing parent. Fix: open with `O_NOFOLLOW` (0600), refuse group/world-writable parents (`mode & 0o022`), comments citing the tracer's guards.
- Verified clean (hunted, not reported): concurrent-initiation races (immediate transaction + DO NOTHING + re-SELECT), SQL injection (all values bound; IN-placeholders ≤ limit cap), paging math parity with `readEvents`, flag-parsing edges, bare-mode byte-identity, wrapper pass-through of abort/verdict semantics, IN-clause bind-count ceiling.

Gates after the fix wave: 126 focal tests pass (6 files), `tsc --noEmit` 0 errors, defensive-programming scanner OK, biome clean; e2e artifacts re-harvested (`replay-proof.json` now shows the true no-op: zero history mutation).

### Review Findings (BMAD round 3, 2026-08-18)

Full bmad-code-review workflow (3 adversarial layers, parallel subagents) over the PR #117 diff. Blind Hunter: 0 findings. Edge Case Hunter (source): 1. Edge Case Hunter (tests): 0. Acceptance Auditor (diff vs contract.md + story): 0 — fully compliant.

- [x] Review — Patch [LOW] `trace/reader.ts:304` `readRunsByIssue` phases sub-query carried a dead `AND phases.rowid > 0` predicate — the query binds no rowid cursor and SQLite rowids are always >= 1, so it matched every row and filtered nothing. Fix (fa7383c): removed; `request_id IN (...)` + `ORDER BY phases.rowid` are the real query.

Gates: 84 focal tests pass (reader + issue-correlation + pipeline-run), `tsc --noEmit` 0 errors, gitnexus detect_changes low risk. Status stays `review` until PR #117 merges.

### File List

**(new)**
- `src/phase-engine/issue-correlation.ts`
- `tests/phase-engine/issue-correlation.test.ts`
- `_bmad-output/evidence/df1-8/{e2e-two-phase-trace.db,readRunsByIssue-page.json,chain-check.json,replay-proof.json,e2e-run.log}`
- `_bmad-output/workflow-state/qds-dev/df1-8/{state.yaml,contract.md}`

**(DF1.8 region appended)**
- `src/phase-engine/types.ts` (+76 — DF1.8 region at file end; no sibling declaration edited)

**(additive)**
- `src/phase-engine/trace/migrations.ts` (+3 entries)
- `src/phase-engine/trace/schema.ts` (+1 index DDL in `SCHEMA_INDEX_DDL`)
- `src/phase-engine/trace/tracer.ts` (+`initiateSession`; openWriter order change per Deviation 2)
- `src/phase-engine/trace/reader.ts` (+2 methods)
- `scripts/pipeline-run.ts` (flags + correlation wiring; bare path unchanged)
- `tests/phase-engine/trace/reader.test.ts` (+17 tests)
- `tests/phase-engine/trace/migrations.test.ts` (1 line, Deviation 3)
- `tests/phase-engine/pipeline-run.test.ts` (+6 tests)
- `_bmad-output/sprint-artifacts/sprint-status.yaml` (DF1.8 status)
- this story file (frontmatter `baseline_commit`, DoD checkboxes, Dev Agent Record, Change Log)

### Change Log

- 2026-08-18: DF1.8 implemented — issue correlation on the DF1.4 trace store (3 columns, 1 unique index, `resolveRunCorrelation`, idempotent `initiateSession`, `readRunsByIssue`/`readRunPhases`, CLI `--repo-slug`/`--issue` wiring, host dispatch-failure log). 41 new tests; tsc + biome clean; e2e evidence captured.
- 2026-08-18: BMAD review round 3 (fa7383c) — 1 LOW fixed (dead `phases.rowid > 0` filter in `readRunsByIssue`); 0 findings from the other 3 layers.
