---
baseline_commit: f7af48e5b49f5e8d5e1dc22211440bae4083f626
---

# DF1.4: SQLite Trace Store (7-Table Schema, WAL, Rowid-Cursor Reads)

**Story Points:** 4
**Sprint:** v5-S1 (track A, engine)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §3.3 ("Adopt (code, with hardening): the visualizer + trace schema"), §5.2 (observability contract), §6 clause 7 (trace confidentiality)
- Decision register: v5 §4 **D6** (adopt SSSF's trace schema nearly as-is and harden); §9 **R10**; §10 **F11**
- Source pattern (reference only, D10 — no vendoring): R4 §2.1–§2.4 (`MOD/tracer.py:17-90, :92-120, :108-112, :123-136`; `VIZ/server/db.ts:77-124, :362-384`)
- Binding facts: R5 §6 facts 15, 16, 20

## User Story

As an operator auditing a factory run,
I want every phase, event, envelope, gate result, process and agent session written to one queryable
SQLite trace keyed by `requestId`,
so that a run can be replayed and audited after the fact — including the runs that hung and emitted
nothing.

## Overview

The DF1.1 phase engine emits typed events. `Tracer` dual-writes each one — JSONL first, then SQLite
— into a seven-table schema (`sessions`, `phases`, `events`, `envelopes`, `gate_results`,
`processes`, `agent_sessions`). The writer opens autocommit + WAL so readers never block it;
additive `ALTER TABLE ADD COLUMN` migrations run at engine init so an existing trace file keeps
working. A read-only reader pages rows with a rowid cursor, which is the same mechanism that serves
a live tail and lazy-paged history. Files are the raw record; the database is the queryable mirror
— losing it loses nothing that cannot be rebuilt from JSONL. The trace holds full compiled prompts,
which is client source code, so it never leaves the repo's data boundary (INV-1).

## E2E Slice

**Demonstrable behavior:** Given a fresh data dir, When the engine runs a two-phase pipeline where
phase 1 passes its gates and phase 2 is killed mid-flight, Then `trace.db` contains one `sessions`
row, two `phases` rows (phase 2 reading `status = 'fail'` because it was never updated), the
`gate_results` rows for both `violations_json` and `checks_json`, a `processes` row for the killed
child with `ended_at` set, and a rowid-cursor read of `events` for that `requestId` returns the
event stream in insertion order across two bounded pages.

**Wiring closed:** On completion of this story, a run's full trace is persisted and queryable using
only code merged by this story plus DF1.1 **and DF1.2**. No stub, no `TODO: wire later`, and no
further sibling story is required to make this behavior real. DF1.2 is load-bearing rather than
incidental: AC1's `gate_results` columns, the `envelopes` table's retained invalid parse attempts,
and the E2E slice's `violations_json`/`checks_json` rows all persist DF1.2-authored shapes, so there
is nothing for this story's writer to receive until DF1.2 has merged. The HTTP surface that serves
these rows to a browser is DF4.1; this story's reader is an in-process API.

**Dependency edges (predecessors):** DF1.1, DF1.2.

## Acceptance Criteria

1. **(make-or-break)** Given an initialized data dir, When the tracer opens, Then all seven tables
   exist with the columns in Technical Notes; `phases.status` carries `DEFAULT 'fail'`;
   `gate_results` persists **both** `violations_json` and `checks_json`; `envelopes.valid` retains
   invalid parse attempts rather than dropping them; and **every** table carries a `request_id`
   column populated on every insert.
2. Given the writer and a reader open the same file, When both connect, Then the writer sets
   `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000` on an autocommit connection, and
   the reader opens `{ readonly: true }`, sets `busy_timeout`/`synchronous`, and **asserts rather
   than sets** `journal_mode`, warning when it is not WAL.
3. Given a `trace.db` written by an earlier build that predates a column, When the engine initializes,
   Then the additive migration list applies the missing column via `PRAGMA table_info` +
   `ALTER TABLE ... ADD COLUMN`, existing rows are preserved, and the reader substitutes
   `NULL AS <column>` for a column it has not yet seen, re-probing until it appears and latching
   thereafter.
4. Given an events query for a `requestId` and a cursor, When the reader pages, Then it returns
   `{ rows, cursor: <last rowid>, hasMore: rows.length === limit }` ordered by rowid, with `limit`
   clamped to `MAX_LIMIT = 1000` (default 500); an unknown or event-less `requestId` returns an
   empty page with the cursor unchanged and `hasMore: false` — not an error.
5. Given the SQLite write fails (lock held past `busy_timeout`, or disk error), When an event is
   traced, Then the JSONL record has already been written, the tracer surfaces a structured error
   and the run continues; and given a configured db path that resolves outside the run's data
   boundary, the tracer **refuses to open** rather than writing prompts anywhere else (INV-1).

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| DF1.1 phase lifecycle hooks (`session_start`/`phase_start`/`phase_end`/`session_finish`) | in-scope | `tests/phase-engine/trace/tracer.test.ts` | — |
| DF1.2 gate results + envelope records | in-scope | `tests/phase-engine/trace/tracer.test.ts` | — |
| Agent subprocess spawn/exit (`processes` rows) | in-scope | `tests/phase-engine/trace/tracer.test.ts` | — |
| In-process reader (`readEvents`, `readSession`) | in-scope | `tests/phase-engine/trace/reader.test.ts` | — |
| HTTP `GET /api/sessions/:id/events` browser polling | **out-of-scope** | — | DF4.1 |
| Run capture correlated to a GitHub issue | out-of-scope | — | DF1.8 |
| Audit-chain reads over the trace | out-of-scope | — | DF5.3 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| SQLite driver | `bun:sqlite`, bundled with the project's bun toolchain — **no new dependency**, nothing to install | typecheck + `tests/phase-engine/trace/*` run on the existing `bun test` entry point |
| Trace file `<data_dir>/trace.db` | local filesystem inside the repo data boundary | engine `Run` init creates the dir (0700), opens the writer, applies migrations, all **before** phase 1 opens |
| JSONL raw record `<data_dir>/events.jsonl` | local filesystem, same boundary | first `trace()` call appends and flushes; JSONL write precedes the SQLite insert |
| In-box trace (when the engine runs inside a sandbox) | exe.dev VM disk, harvested host-side | DF2.5 bundle/harvest carries it out; the box's shared public port is **never** bound to it |

## Technical Notes

- **Schema (7 tables, ported from R4 §2.1):** `sessions` (pk `request_id`; request, status, engineer,
  timings, `total_tokens`, `total_cost` — **integer micro-dollars (µ$)**, DD-9 — `pipeline_name` =
  SSSF's `adw_name`, and `archived` = review triage never written by a run; DF4.1 archives through
  **its own second writable connection scoped to that one column**, never through the tracer's
  (INV-3)) · `phases` (pk `phase_id`; `seq`,
  `name`, `kind`, `owner`, `description`, `status DEFAULT 'fail'`, `attempt`, `retries`, `error`) ·
  `events` (pk `event_id`; `parent_id` for span nesting, `type`, `name`, `payload_json`, `tokens`,
  `started_at`, `ended_at`) · `envelopes` (pk `envelope_id`; `agent`, `output_type`, `payload_json`,
  `valid`, `attempt`) · `gate_results` (autoinc; `attempt`, `gate`, `passed`, `violations_json`,
  `checks_json`) · `processes` (autoinc; `kind`, `pid`, `command`, `ended_at`) ·
  `agent_sessions` (pk `(request_id, agent)`; `coding_agent`, `model`, `color`, `session_id`,
  `context_tokens`, `context_window`).
- **`request_id` replaces SSSF's `adw_id` throughout** — it is the correlation key the v5
  observability contract propagates end to end (§5.2). Every table carries it, including
  `gate_results` and `processes`; there is no second correlation identifier.
- **Why `processes` exists:** a hung agent emits no events, no tokens and no output — exactly when you
  need its pid — and `ps` cannot say which run it belongs to. `command` is stored so a recycled pid is
  not killed by mistake. `ended_at IS NULL` means *believed alive*. DF1.1 owns the SIGTERM/SIGINT
  handler; this story ships the `processes_end_all` that `session_finish` and that handler both call.
- **Event types** (`phase_start`, `agent_start`, `prompt`, `tool_call`, `handoff`, `gate_pass`,
  `gate_fail`, `log`, `agent_end`, `phase_end`, `error`). **`prompt` is this schema's owner of
  compiled-prompt persistence** — the single place a compiled system or user prompt is stored, with
  `payload_json` of shape `{ role: "system" | "user", agent: string, phase_id: string, text: string }`.
  DF1.6 persists every compiled prompt before the spawn that consumes it by emitting this event, and
  DF4.1 reads prompts by selecting `events` rows of type `prompt` — there is no separate prompt table
  and no second prompt store. `text` is full client source code and is bound by INV-1 like every
  other column. `tool_call` is the **only** type that spans time and
  fills both `started_at` and `ended_at` in columns — so a reader lays tool calls on a time axis
  without parsing `payload_json`. Every other type is a point and leaves `ended_at` NULL.
- **Migrations:** a flat `MIGRATIONS: [table, column, decl][]` list applied via `PRAGMA table_info` +
  `ALTER TABLE ... ADD COLUMN` (`CREATE TABLE IF NOT EXISTS` never revisits an existing table). No
  version number, no down-migration, **additive only** (INV-5). The list is **append-only and
  order-stable** — DF1.8 and later stories append entries, never edit or reorder existing ones — and
  every `decl` is nullable or constant-default, so each `ALTER` is metadata-only and cannot hold the
  init write lock past `busy_timeout`. **Additive `CREATE … IF NOT EXISTS` index DDL runs in the same
  schema-init step beside `CREATE TABLE IF NOT EXISTS`** (a separate ordered list,
  `SCHEMA_INDEX_DDL: string[]`), so a uniqueness constraint that does not fit the
  `[table, column, decl]` tuple shape — DF1.8's `sessions(repo_slug, request_id)` — is supported;
  re-apply is a no-op. There is no live-column rename anywhere: `request_id` replaces
  SSSF's `adw_id` at port time, in a schema this repo has never shipped under the old name.
- **`agent_sessions` carries context, not events** — one latest row per agent, overwritten when a
  session runs the same agent twice, because a UI lane wants one number.
- **`src/phase-engine/types.ts` is shared — region ownership.** DF1.1 creates the file and owns the
  `PhaseSpec`/`PhaseParams` types, the `retries: 0..5` bound, `PARSE_FIX_ATTEMPTS`, and
  `PhaseParams.agent`; DF1.2 **adds only** `PhaseParams.previous`; DF1.3 **adds only** its
  retry-loop types (`PhaseAttemptRecord`, the widened `agent_end` usage payload); DF1.8 **adds
  only** its issue-correlation types. This story **adds only** the trace-layer types — the
  event-type union (including the `prompt` event), the row shapes, and the reader's cursor/page
  types — and edits no sibling's declarations. Five stories touch one file; each appends its own
  region, so the merges are additive and no declaration has two authors.
- **Deviation/assumption:** R5 §6 fact 20 — SSSF is **reference only**: a test-first TypeScript
  implementation of the schema and mechanisms above, no vendored Python. Fact 15 — in-box trace
  evidence is a **claim, not proof**; DF5.1 re-verifies host-side, so no AC here attests to a run.

## Observability Contract

- Every traced write logs: `{ requestId, phase, agentId, table, statement, timestamp, durationMs }`
  on failure only; success is silent (the trace is itself the record). No `exitStatus` field: that
  enum (CC-1) classifies a terminated *run*, not a failed insert.
- `requestId` originates in the DF1.1 run context and is a bound parameter on every insert and every
  read. Errors include `{ code, message, stack? }` and name the table and the failing statement.
- Sub-timings: `jsonl_write_ms`, `sqlite_insert_ms`. When the driver exposes no breakdown, report 0
  and treat the caller's `durationMs` as authoritative.

## Files to Modify

- `src/phase-engine/trace/schema.ts`
- `src/phase-engine/trace/tracer.ts`
- `src/phase-engine/trace/migrations.ts`
- `src/phase-engine/trace/reader.ts`
- `src/phase-engine/types.ts`
- `tests/phase-engine/trace/tracer.test.ts`
- `tests/phase-engine/trace/migrations.test.ts`
- `tests/phase-engine/trace/reader.test.ts`

## Security Invariants

- **INV-1 (confidentiality — client source):** the trace stores full compiled system and user prompts
  and full envelope payloads — **client source code** (F11/R10). The db, its `-wal`/`-shm` sidecars
  (same content, same rules) and the JSONL live in the run's data dir inside the repo's own data
  boundary, `0600` on every file and `0700` on the dir; a configured path resolving outside it is a
  hard open failure, not a warning. Harvests stay in that boundary and checkpoint the WAL first (DF2.5).
- **INV-2 (no exposure surface):** this story adds **no listener, no port, and no network I/O**. The
  reader is an in-process API over a local file. The only remote consumer is DF4's visualizer, and
  its access is tier-1-tunneled and auth-gated — **never** the box's one shared public port, whose
  proxy auth this architecture does not rely on.
- **INV-3 (write scoping):** exactly one writable connection exists **for run-produced trace data**,
  owned by the tracer. Every reader connection opens `{ readonly: true }`, so a reader can neither
  `ALTER` the schema nor change `journal_mode`; it asserts and warns instead. **One scoped
  exception:** DF4.1 opens its **own second writable connection** for review triage, and that
  connection may write exactly one column — `sessions.archived` — and nothing else. This is
  architecturally correct rather than a concession: the visualizer is a separate long-lived process
  that outlives any given run, so routing its writes through a per-run tracer connection would make
  triage impossible once the run ends. WAL supports a second writer, and the two writers never
  contend because `archived` is never written by a run (Technical Notes) and no run-produced column
  is ever written by DF4.1. DF4.1's INV-4 states the same boundary from its side.
- **INV-4 (input validation):** all SQL is parameterized — `request_id`, `phase_id`, cursor and
  limit are bound parameters, never interpolated. `limit` is clamped to `MAX_LIMIT` **before**
  binding, and a non-integer or negative cursor is rejected rather than coerced.
- **INV-5 (schema integrity, fail-closed):** migrations are additive only — `ADD COLUMN` and
  additive `CREATE INDEX IF NOT EXISTS` DDL, and nothing else. No `DROP`, no rename, no data-rewriting statement exists in the migration path, so an
  existing trace cannot be silently altered by an engine upgrade. A migration that cannot be applied
  aborts the open; the engine refuses to run rather than serve a half-migrated schema.

## Definition of Done

- [x] **Impl:** seven tables created with the DDL in Technical Notes, `phases.status DEFAULT 'fail'`,
      `request_id` on every table.
- [x] **Impl:** dual write — JSONL appended and flushed before the SQLite insert, per event.
- [x] **Impl:** additive migration list applied at init; reader `optionalColumn` probe re-runs while
      the column is missing and latches once seen.
- [x] **Contract:** rowid-cursor reader returns `{ rows, cursor, hasMore }`, ordered by rowid, limit
      clamped to `MAX_LIMIT = 1000` / default 500.
- [x] **Integration:** DF1.1 lifecycle hooks and DF1.2 gate/envelope records land in their tables;
      `processes_end_all` runs on session finish.
- [x] **Security:** db path confined to the run data boundary with `0600`/`0700` modes and a hard
      open failure outside it (INV-1); reader connection is genuinely read-only (INV-3).
- [x] **Test (WAL/SHM sidecar permissions, INV-1):** a write that forces WAL/SHM sidecars to
      exist (`trace.db-wal`, `trace.db-shm`) → both sidecars, `trace.db`, and the JSONL file all
      assert mode `0600`; an implementation that mode-checks `trace.db` alone and never triggers
      or inspects the sidecars MUST fail this test.
- [x] **Test (unit):** `gate_results` round-trips both `violations_json` **and** `checks_json`, and an
      invalid envelope is retained with `valid = 0` — an implementation that stores violations only,
      or drops invalid attempts, MUST fail this test.
- [x] **Test (prompt round-trip):** a `prompt` event for each role round-trips through `events` —
      written with `{ role: "system" | "user", agent, phase_id, text }` and read back byte-identical
      by `readEvents` for that `requestId`, ordered with the other events by rowid. An implementation
      routing prompts to a side table or dropping `role` MUST fail this test.
- [x] **Test (schema drift):** open a db fixture missing a migrated column → column added, existing
      rows intact, reader returns real values after the ALTER lands mid-process (not NULL forever).
- [x] **Test (index DDL):** schema-init applies an additive `CREATE UNIQUE INDEX IF NOT EXISTS` alongside `ADD COLUMN` migrations; re-running init on an already-indexed db is a no-op (DF1.8's `sessions(repo_slug, request_id)` index).
- [x] **Test (degraded write):** SQLite insert fails → the JSONL line is already on disk, a structured
      error is surfaced, and the run continues; db path outside the data boundary → open refused.
- [x] **Test (e2e demo — MANDATORY):** run the two-phase pipeline of the E2E Slice and capture
      `trace.db` plus a two-page rowid-cursor read as artifacts, showing the killed phase reading
      `status = 'fail'` and its `processes` row closed.

## Dev Agent Record

### Implementation Plan (as executed)

Test-first TypeScript port of SSSF's tracer (reference-only per D10; mechanics
lifted from `~/reference-repos/super-simple-software-factory` `tracer.py:17-136`
and `VIZ/server/db.ts:77-124, 362-384`, `adw_id`→`request_id` throughout):

1. **Contract layer** — trace types appended to `src/phase-engine/types.ts`
   (DF1.4 region only; no sibling declaration touched).
2. **RED** — three suites authored first (migrations / tracer / reader, 47 tests).
3. **GREEN** — `trace/schema.ts` (7-table DDL + `SCHEMA_INDEX_DDL`),
   `trace/migrations.ts` (append-only `MIGRATIONS`, SSSF-ported list),
   `trace/tracer.ts` (WAL writer, JSONL-first dual write, boundary refusal,
   0700/0600 modes), `trace/reader.ts` (readonly, journal-mode assert-not-set,
   optionalColumn probe with latch, rowid-cursor paging).
4. **Wiring** — `trace/journal-bridge.ts` `TracingJournal` decorates the
   `PhaseJournal` port (journal.ts header's reserved seam): every op delegates
   to the inner journal AND forwards to the tracer; tracer failures never break
   the run. `scripts/pipeline-run.ts` claims the data dir (0700), opens the
   tracer before phase 1, records process spawn/exit, ends all processes on
   SIGTERM/SIGINT/finish, records envelopes when a phase value is one.
   `phase.ts` untouched (DF1.3 lane safety).

### Deviation Notes

- **No blanket `commandGate` in the runner.** Wiring `commandGate` onto every
  code phase made a non-zero command exit fail its gate → contradicts DF1.2
  AC4 ("exit code is data, not a phase verdict") and broke three DF1.1 tests.
  Gates compose at the caller via `gatedBody`; `TracingJournal.writeGateEvent`
  lands their results in `gate_results` (covered by wiring + unit tests).
- **Envelope rows:** `recordEnvelope` + retention are unit-tested; the engine
  seam records an envelope when a phase value is one, but no DF1.1/DF1.2 body
  produces envelopes yet (DF1.6 lands the spawn seam that will).
- **Limit semantics:** non-positive/non-finite limit = default 500 (AC4
  "default 500"), positive limits truncate-then-clamp to 1000.
- **Reader probe breadth:** optionalColumn probes every non-key SELECT column
  (reference probes a fixed set); DF1.4's drifted-fixture tests require NULL
  substitution for any missing column.

### Debug Log

- Wave-agent churn: schema.ts clobbered twice by concurrent migration-agent
  rewrites (re-export lost) — resolved by serial ownership; migration tests had
  three authoring bugs (IF NOT EXISTS no-op vs drift fixture, sqlite_autoindex
  counting, a NOT-NULL ALTER that bun's SQLite accepts on empty tables) — fixed
  to deterministic forms (DROP-then-trim, `name NOT LIKE 'sqlite_%'`,
  duplicate-column conflict).
- Evidence artifact originally written to a deleted tmpdir; now durable under
  `_bmad-output/evidence/df1-4/` with a WAL checkpoint before copy.

### Completion Notes

- Local gates: 55/55 trace suites (8 migrations + 13 tracer + 26 reader + 8
  wiring), 302/302 phase-engine dir, tsc 0 errors, biome clean on all changed
  files. Full repo: 3 pre-existing env failures (lean-worker-benchmark
  OPENROUTER_API_KEY, roster-check live-probe/QDS_PI_CATALOG_DIR) — files
  untouched by this story, failing on main-era code paths.
- E2E demo artifacts: `_bmad-output/evidence/df1-4/e2e-two-phase-trace.db`
  (1 session, 2 phases — killed phase `status='fail'`, 2 processes with
  `ended_at` set) + `two-page-read.json` (rowid-ordered two-page read).
- Reuse mandate honored: schema DDL, migration list, WAL pragmas, JSONL-first
  dual write, reader pragmas/probe/paging all lifted from the SSSF reference
  implementation and re-expressed test-first in TypeScript (D10: no vendored
  Python).

### File List

- `src/phase-engine/trace/schema.ts` (new)
- `src/phase-engine/trace/migrations.ts` (new)
- `src/phase-engine/trace/tracer.ts` (new)
- `src/phase-engine/trace/reader.ts` (new)
- `src/phase-engine/trace/journal-bridge.ts` (new)
- `src/phase-engine/types.ts` (DF1.4 region appended)
- `src/phase-engine/index.ts` (trace exports)
- `src/phase-engine/gates/library.ts` (one-line re-export of `looksLikeEnvelope`)
- `scripts/pipeline-run.ts` (tracer wiring)
- `tests/phase-engine/trace/migrations.test.ts` (new)
- `tests/phase-engine/trace/tracer.test.ts` (new)
- `tests/phase-engine/trace/reader.test.ts` (new)
- `tests/phase-engine/trace/wiring.test.ts` (new)
- `_bmad-output/evidence/df1-4/e2e-two-phase-trace.db` (new, artifact)
- `_bmad-output/evidence/df1-4/two-page-read.json` (new, artifact)

### Review Findings (BMAD code review round 4, 2026-08-15)

- [x] [Review][Patch] promotePhase upsert clobbers settled `error` via `error = excluded.error` (null) [src/phase-engine/trace/tracer.ts] — fixed: ON CONFLICT now `error = COALESCE(excluded.error, phases.error)`, `ended_at = COALESCE(excluded.ended_at, phases.ended_at)`; 2 regression tests
- [x] [Review][Patch] Observability contract: failure logs missing `phase`, `agentId`, `timestamp`, `durationMs`, `jsonl_write_ms`, `sqlite_insert_ms` [tracer.ts + journal-bridge.ts + scripts/pipeline-run.ts] — fixed: TracerError carries the fields, emitTraceError fills defaults (report-0 rule), trace() times JSONL write + SQLite insert, both sinks serialize the full shape; contract test added
- [x] [Review][Patch] Module-scope `process.stderr.on("error")` lacks contract documentation of process-wide effect [journal-bridge.ts] — fixed: comment states the process-wide scope as deliberate AC5 defense
- [x] [Review][Patch] Tracer constructor leaks open db handle when openWriter throws after `this.db` assignment [tracer.ts] — fixed: constructor closes db on openWriter failure, rethrows
- [x] [Review][Patch] pipeline-run comment overclaims "tracer never throws SQLite failures to the run" — open-time failures fatal by design [scripts/pipeline-run.ts] — fixed: comment states both contracts (per-write non-fatal, open-time fatal INV-1/INV-5)
- [x] [Review][Patch] Timestamp-coherence rule duplicated between tracer.ts trace() and journal-bridge.ts promotePhase [tracer.ts] — fixed: shared `coherentStartedAt()` exported from tracer.ts, used by both
- [x] [Review][Patch] recordProcess accepts pid ≤ 0 / non-integer [tracer.ts] — fixed: INVALID_INPUT guard, test added
- [x] [Review][Patch] recordEnvelope / recordGateResult bind `attempt` without finite-number normalization [tracer.ts] — fixed: Math.trunc + finite check, degrade to 1
- [x] [Review][Patch] journal-bridge.ts onTraceError malformed brace line [journal-bridge.ts] — fixed in rewrite

24 findings dismissed as noise/false-positive after code verification (notably: Sift's `started_at` overwrite claim — ON CONFLICT never touches `started_at`; sessions column-count mismatch; `-Infinity` cursor bypass; `processesEndAll` double-stamp; circular-payload crash claims — all stringify sites guarded; missing boundary-refusal test — exists at tracer.test.ts:336; migrations Object.freeze redundancy — `as const` is compile-time only).

Gates after round 4: 71/71 trace suites, 318/318 phase-engine, tsc clean, biome clean on changed files.

### Change Log

- 2026-08-15: BMAD review round 4 (3 adversarial layers + Sift round-4 + orchestrator
  verification) — 9 fixed, 24 dismissed with code-verified rationale. Key fixes:
  upsertPhase error/ended_at preservation via COALESCE, observability-contract fields
  (phase/agentId/timestamp/durationMs/jsonl_write_ms/sqlite_insert_ms) through
  TracerError → both sinks, constructor db-leak guard on failed open, shared
  coherentStartedAt() helper, recordProcess pid guard, attempt normalization.
- 2026-08-15: DF1.4 implemented — 7-table SQLite trace store, WAL writer with
  JSONL-first dual write, additive migrations + index DDL, readonly
  rowid-cursor reader, PhaseJournal bridge wiring, e2e demo artifacts.
