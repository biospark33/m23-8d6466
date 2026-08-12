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

- [ ] **Impl:** `resolveRunCorrelation` settles the requestId (strict UUID v4 honoured, else
      generated) and validates `(repoSlug, issueId)` before any session row, box or key exists.
- [ ] **Impl:** DF1.4 `MIGRATIONS` extended with the three `ADD COLUMN` entries and the
      `sessions(repo_slug, request_id)` unique index appended to DF1.4's existing `SCHEMA_INDEX_DDL`;
      an existing `trace.db` fixture migrates intact and re-applying the migration is a no-op.
- [ ] **Contract:** `readRunsByIssue(repoSlug, issueId, cursor?)` returns `{ rows, cursor, hasMore }`
      on DF1.4's rowid-cursor shape; no reader accepts `issueId` alone.
- [ ] **Integration:** DF1.6 `dispatch_task` step outputs land against the run's issue on the same
      resolved `requestId`; `ExitStatus` imported from `cli-anything/src/types.ts:79`, not re-declared.
- [ ] **Security:** correlation columns write-once (INV-RUN-2); the `request_id` primary key plus the
      transactional upsert make a replayed initiation a no-op that mints no second key, and a
      same-requestId/different-repoSlug dispatch refuses with `RequestIdRepoMismatch` (INV-RUN-1, AC3).
- [ ] **Test (unit):** chain-integrity query over all seven tables returns zero rows with absent or
      divergent `request_id`; a fixture minting a fresh id in one phase MUST fail it.
- [ ] **Test (cross-repo):** runs for `#42` in two repos → query by one pair returns exactly one
      run; a reader keyed on `issueId` alone does not exist to be called.
- [ ] **Test (replay):** identical `(repoSlug, requestId)` dispatched twice, once after completion
      → one `sessions` row, first-close-wins, second call returns the existing `runId`.
- [ ] **Test (requestId/repo mismatch):** a dispatch reusing an existing `requestId` under a different
      `repoSlug` → structured `RequestIdRepoMismatch` naming both slugs, no second `sessions` row, the
      existing row's `repo_slug` unchanged, and no key minted. An implementation that upserts onto the
      existing row MUST fail this test.
- [ ] **Test (initiation failure):** trace open refused → `runId: null` plus the resolved
      `requestId`, failure recorded against the pair, no fabricated id anywhere.
- [ ] **Test (e2e demo — MANDATORY):** run the two-phase pipeline of the E2E Slice against
      `qds/demo#42` and capture `trace.db` plus the `readRunsByIssue` page as artifacts, showing the
      correlated `sessions` row and the zero-divergence chain check.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
