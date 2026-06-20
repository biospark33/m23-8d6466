# P2.1: Event Store (SQLite + sqlite-vec) with Absorbed Recall API

**Story Points:** 4

## Spec Reference

- QDS-MEM-003 §4 (operational-store schema), §6 (recall) + IMPL §C deltas D2 (event tree), D3 (sqlite-vec)
- Run-reconstruction SLA: QDS-MEM-003 §12.1

## User Story

As a QDS optimizer agent,
I want an SQLite event store with FTS5, a sqlite-vec ANN index, and a no-LLM recall API,
so that I can reconstruct any run's timeline and tree and query events by index, full-text, and semantic similarity without network egress (G2 — fast, local, deterministic recall).

## Overview

This story adapts the vendored claude-mem SQLite+FTS5 stores (P2.0) into the operational-memory schema: `events` (with FK to `runs` and `experiments`, no CASCADE), `runs`, `experiments`, `event_edges`, the `event_vec` vec0 virtual table (FLOAT[384]), and `schema_meta`, with all CHECK constraints and the 9+3+2+2 indexes from §C — the 9th events index being the composite `idx_events_run_created(run_id, created_at)` that backs the `reconstructRun` <200ms ordered scan — on a WAL database. P2.1 owns schema CONTENT (authored as `.sql` files); P2.2's runner applies it at runtime (P2.1 does not `CREATE` at runtime). It fills schema GAP #1 by authoring the `events` FTS5 content table plus AFTER INSERT/DELETE/UPDATE sync triggers (copying the claude-mem `SessionStore.ts:434-460` pattern), and swaps the Search Strategy framework's `ChromaSearchStrategy` for a net-new `SqliteVecSearchStrategy` (keeping `SearchStrategy`/`SearchOrchestrator`/`HybridSearchStrategy`). It absorbs the Recall API: by-run ordered timeline + `parent_event_id` tree, indexed scans by agent/skill/prompt/variant/time, semantic KNN over `event_vec`, and outcome/token/duration aggregations by variant/skill. No LLM runs at this tier. Wiring closes with no stub/TODO: a fresh DB serves a real recall round-trip end-to-end. This is a heavy net-new infra unit (DDL + FTS5 + vec0 + recall surface) and carries SPIKE-11.

## E2E Slice

**Demonstrable behavior:** Open a fresh WAL database, apply the §C DDL + FTS5 triggers, seed one `runs` row and an ordered chain of `events` (with `parent_event_id` links) plus matching `event_vec` rows embedded by the local ONNX pipeline, then call recall: `reconstructRun(run_id)` returns the full ordered timeline + tree in `< 200ms`, an FTS5 text query and a sqlite-vec KNN query (`k = ?`) each return the expected event, and an aggregation returns outcome rates by variant — all with the network mocked and no LLM call.

**Wiring closed:** On completion, any `run_id` reconstructs to a full ordered timeline + tree and recall serves indexed, full-text, and semantic queries using only code merged by this story and predecessor P2.0. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P2.0 (vendored substrate + pinned sqlite-vec/ONNX). This story is the Phase-2 fan-out point; P2.2 (migration runner) is a parallel sibling — developed in parallel but with a CONTENT dependency: P2.2 consumes P2.1's authored `.sql` content (the migration files) as its migration set.

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given a database seeded with a run of ≥500 ordered events forming a `parent_event_id` tree, When `reconstructRun(run_id)` is called, Then it returns the complete ordered event timeline (via the composite `idx_events_run_created(run_id, created_at)` access path) plus the parent/child tree (assembled by a recursive CTE over `parent_event_id` adjacency) in `< 200ms` (§12.1), with every row carrying its non-null `run_id` and `EXPLAIN QUERY PLAN` confirming the composite index (not a full scan) serves the ordered scan.
2. Given the §C DDL applied, When the store initializes, Then `events`/`runs`/`experiments`/`event_edges`/`schema_meta` exist with their CHECK constraints and FK clauses, all 9 events indexes are present and NAMED (`idx_events_run`, `_agent`, `_skill`, `_type`, `_variant`, `_experiment`, `_parent`, `_created`, and the composite `idx_events_run_created(run_id, created_at)`) plus the 3+2+2 (runs/experiments/event_edges) indexes, `event_vec` is a `vec0(... FLOAT[384])` virtual table, and `schema_meta` holds `schema_version=1.0.0`, `engine=sqlite+sqlite-vec`, `embedding_model=Xenova/all-MiniLM-L6-v2`, `embedding_dim=384`.
3. Given the `events` FK to `runs`/`experiments` (R2, no CASCADE) and `PRAGMA foreign_keys=ON` set on the connection, When an INSERT attempts an `events` row whose `run_id` has no matching `runs` row (an orphan), Then SQLite rejects the write with a foreign-key constraint failure (asserted) — the orphan row is never persisted; the test also asserts `PRAGMA foreign_keys` reads back `1` on the open handle (FK clauses are inert otherwise).
4. Given the authored `events_fts` FTS5 table + sync triggers (GAP #1) fed by real columns + `json_extract(payload_json/result_json)`, When an `events` row is inserted, updated, then deleted, Then the FTS5 index stays consistent and a full-text recall query — joining `events.id = events_fts.event_id` (the FTS table's explicit `event_id TEXT UNINDEXED` column mirroring the `{domain}:{uuid}` TEXT PK, NOT FTS5's auto-INTEGER `rowid`) — returns the live row across insert/update/delete and not the deleted one.
5. Given `event_vec` populated with 384-dim local-ONNX embeddings for `tool_call`/`message` events ONLY (R6 — `node`/`outcome` not embedded), When a semantic recall query runs with `k = ?` (or `LIMIT`) in the WHERE clause, Then KNN returns the nearest events by L2 over normalized vectors; a KNN query omitting `k`/`LIMIT` is rejected by an explicit pre-flight check that THROWS before any SQL executes (version-independent), not silently full-scanned.
6. Given `SqliteVecSearchStrategy` registered in place of `ChromaSearchStrategy`, When the `SearchOrchestrator`/`HybridSearchStrategy` runs a hybrid (FTS5 + vector) recall, Then results merge through the unchanged Strategy framework with no Chroma dependency loaded.
7. Given any recall or store operation, When it executes, Then the network mock asserts zero outbound HTTP/LLM calls AND the test reads back `env.allowRemoteModels===false` and the pinned `env.localModelPath` from the configured pipeline (asserting the pinned-local config, not merely "no network call observed").
8. Given a `payload_json`/`result_json` exceeding 64 KB at the write boundary, When the store validates it, Then the write is rejected as oversized and never persisted (the 64KB CAP is enforced here; secret-masking is performed upstream by the P2.3 `maskAndCap` util, cited not re-implemented). Reconciliation with INV-OM2 "never a silent drop": ALL real event writers route through `maskAndCap` (which already caps ≤64KB), so a data-event row can never arrive oversized — this write-boundary reject is defense-in-depth fail-fast for a programming error (a caller bypassing `maskAndCap`), NOT a data-event drop path.
9. Given a stored `events` row with malformed/truncated JSON in `payload_json`/`result_json`, When `reconstructRun` reads it, Then the guarded `JSON.parse` yields a sentinel for that field and the reconstruction completes without crashing (read-path robustness).

## Technical Notes

- **Contracts/Schema (§C DDL — spec-citation; applied at runtime SOLELY by P2.2's runner — P2.1 does NOT `CREATE` at runtime. P2.1 owns schema CONTENT, authored as the migration `.sql` files; FK decision is a binding DECISION below):**
  ```sql
  CREATE TABLE events (
    id TEXT PRIMARY KEY,                 -- {domain}:{uuid}
    run_id TEXT NOT NULL,                -- [INV-OM2]
    dag_node_id TEXT,                    -- D5/SPIKE-10
    parent_event_id TEXT,               -- [D2] event tree
    agent_id TEXT NOT NULL, agent_role TEXT, skill TEXT, skill_version TEXT,
    prompt_id TEXT, prompt_version TEXT,
    variant TEXT, experiment_id TEXT,    -- A/B tags (NULL if not in experiment)
    event_type TEXT NOT NULL CHECK(event_type IN ('tool_call','node','message','outcome')),
    tool_name TEXT,
    payload_json TEXT NOT NULL,          -- [INV-OM3] ≤64KB, secret-masked
    result_json TEXT,                    -- [INV-OM3]
    tokens INTEGER DEFAULT 0, duration_ms INTEGER DEFAULT 0,
    outcome TEXT, error TEXT,
    created_at INTEGER NOT NULL,         -- epoch ms
    FOREIGN KEY(run_id) REFERENCES runs(run_id),               -- [R2] no CASCADE
    FOREIGN KEY(experiment_id) REFERENCES experiments(experiment_id)  -- [R2] no CASCADE
  );
  -- 9 events indexes (named): idx_events_run(run_id), idx_events_agent(agent_id),
  --   idx_events_skill(skill), idx_events_type(event_type), idx_events_variant(variant),
  --   idx_events_experiment(experiment_id), idx_events_parent(parent_event_id),
  --   idx_events_created(created_at),
  --   idx_events_run_created(run_id, created_at)  -- [R4] composite — backs reconstructRun <200ms ordered scan

  CREATE TABLE runs (
    run_id TEXT PRIMARY KEY, dag_def_id TEXT NOT NULL, variant TEXT, experiment_id TEXT,
    started_at INTEGER NOT NULL, ended_at INTEGER,
    status TEXT NOT NULL CHECK(status IN ('running','completed','failed','aborted')),
    total_tokens INTEGER DEFAULT 0, files_touched_json TEXT, overall_outcome TEXT
  );  -- 3 indexes: dag_def_id, variant, started_at

  CREATE TABLE experiments (
    experiment_id TEXT PRIMARY KEY, skill TEXT NOT NULL, hypothesis TEXT NOT NULL,
    variant_a_ref TEXT NOT NULL, variant_b_ref TEXT NOT NULL, metric TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed'
      CHECK(status IN ('proposed','approved','running','analyzed','deployed',
                       'confirming','confirmed','rolled_back','rejected')),
    winner TEXT, proposed_fix TEXT, deploy_ref TEXT, baseline_metrics_json TEXT,
    proposed_at INTEGER NOT NULL, approved_at INTEGER, approved_by TEXT,
    executed_at INTEGER, deployed_at INTEGER, confirm_until INTEGER,
    decided_at INTEGER, created_at INTEGER NOT NULL
  );  -- 2 indexes: status, skill

  CREATE TABLE event_edges (
    source_id TEXT NOT NULL, target_id TEXT NOT NULL,
    relation TEXT NOT NULL,    -- handoff|caused_by|spawned|produced
    PRIMARY KEY (source_id, target_id, relation)
  );  -- 2 indexes: source, target

  CREATE VIRTUAL TABLE event_vec USING vec0(   -- sqlite-vec; D3/INV-OM4
    event_id TEXT PRIMARY KEY, embedding FLOAT[384]   -- Xenova/all-MiniLM-L6-v2
  );

  CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- [R3] P2.1 owns the schema_meta SHAPE decision (key/value, NOT claude-mem's integer
  --      schema_versions); P2.2 owns the runner + the seed INSERTs. P2.1 does NOT seed
  --      at runtime and makes NO duplicate CREATE-ownership claim — this is spec-citation.
  -- seed values (written by P2.2's 0005_seed_meta): schema_version=1.0.0,
  --   engine=sqlite+sqlite-vec, embedding_model=Xenova/all-MiniLM-L6-v2, embedding_dim=384
  ```
- **GAP #1 — FTS5 (DECISION, author here):** create the `events_fts` FTS5 table (NOT content-linked to a non-existent column) populated via the **app write path** (the event-store insert builds the FTS row) OR `json_extract` over real columns — never "magic" triggers referencing absent columns. FTS5 text = concatenation of REAL columns + extracted JSON: `event_type || ' ' || COALESCE(skill,'') || ' ' || COALESCE(tool_name,'') || ' ' || COALESCE(json_extract(payload_json,'$.summary'),'') || ' ' || COALESCE(json_extract(payload_json,'$.message'), json_extract(result_json,'$.text'),'')`. The "payload-summary / message-text" referenced by the embed input are JSON fields inside `payload_json`/`result_json`, NOT top-level columns — so they are fed by `json_extract`, not a column trigger. AFTER INSERT/DELETE/UPDATE sync triggers (claude-mem `SessionStore.ts:434-460` pattern) keep `events_fts` consistent using the SAME extraction expression. The table declares an explicit **`event_id TEXT UNINDEXED`** column mirroring `events.id` (the `{domain}:{uuid}` TEXT PRIMARY KEY value), written by the same app write path that builds the FTS row — `UNINDEXED` so the UUID is stored for joins but NOT tokenized into the FTS index. **JOIN contract (binding):** every FTS-backed recall query joins `events.id = events_fts.event_id` — NEVER `events_fts.rowid` (nor `events.rowid`). FTS5's implicit `rowid` is an auto-assigned INTEGER (0,1,2,…) that is UNRELATED to `events.id` (a TEXT PK), so any rowid-based join silently breaks; `event_id` is the only correct join key.
- **R6 — embedding scope:** only `tool_call` (P2.3) and `message` (P2.5) events get an `event_vec` row; `node` (P2.4) and `outcome` (P2.6) events are NOT embedded (queried by index, not similarity). So **KNN/`event_vec` covers `tool_call`/`message` events only**; recall semantic search documents this scope. The embed-input text is run through `maskAndCap` as an idempotent defense-in-depth SECOND pass over already-masked column text (rows arrive pre-masked via P2.3's util) — no behavior change, just belt-and-suspenders before the vector leaves for the ONNX pipeline.
- **Swap seam:** replace `ChromaSearchStrategy.ts` with a net-new `SqliteVecSearchStrategy` behind the unchanged `SearchStrategy`/`SearchOrchestrator`/`HybridSearchStrategy`; no Chroma sync modules loaded (stripped in P2.0).
- **sqlite-vec usage + KNN guard:** `vec0(event_id text primary key, embedding float[384])`; KNN **requires `k = ?` or `LIMIT`** in WHERE. Guard is an **explicit pre-flight check in `recall.ts` that throws BEFORE building/executing the SQL** (version-independent — does not rely on sqlite-vec's own error) when neither `k` nor `LIMIT` is supplied. dim fixed at create; default L2 on normalized vectors; optional partition keys (`variant`, `run_id`).
- **SPIKE-11 note:** validate sqlite-vec + ONNX native load under Bun vs Node early to de-risk — this is informational, NOT a blocker; the swarmclaw substrate already runs this stack locally.
- **Recall API (absorbed):** `reconstructRun(run_id)` returns the ordered timeline + `parent_event_id` tree via the **R4 composite `idx_events_run_created(run_id, created_at)` access path** (ordered scan), then assembles the tree with a **recursive CTE over `parent_event_id` (adjacency-list walk)**; indexed scans by agent/skill/prompt/variant/time; semantic KNN (tool_call/message only); aggregations (outcome rates, tokens/duration by variant/skill). The READ path **guards every `JSON.parse`** of `payload_json`/`result_json` (try/catch → sentinel) so a malformed/truncated row never crashes `reconstructRun`. No LLM at this tier.
- **Files / functions touched:** `src/store/schema.ts` (DDL + FTS5 triggers + the `events_fts(event_id TEXT UNINDEXED, …)` declaration as authored `.sql`), `src/store/event-store.ts` (WAL store, write boundary, 64KB cap, writes `events_fts.event_id = events.id` on the FTS insert), `src/store/recall.ts` (reconstructRun + CTE tree-walk + KNN pre-flight + JSON.parse guard + aggregations; FTS read path joins `events.id = events_fts.event_id` per the GAP #1 JOIN contract), `src/store/search/sqlite-vec-strategy.ts` (Chroma swap), `src/embed/onnx-pipeline.ts` (pinned-local lazy singleton).
- **Guards/limits:** WAL + `busy_timeout`; `PRAGMA foreign_keys=ON` set on EVERY store-open connection (Bun `bun:sqlite` and Node `better-sqlite3`) — FK clauses are inert without it, so this is a store-open guard; **INV-OM3 64KB cap enforced HERE at the write boundary** — the secret-mask UTIL (`maskAndCap` at `src/capture/mask-and-cap.ts`) is a FORWARD-DEP authored by P2.3; P2.1 scopes to the byte cap and cites P2.3 for masking (capture rows arrive pre-masked via that util). KNN pre-flight guard (throws on missing `k`/`LIMIT`); ONNX `env.allowRemoteModels=false`, pinned `env.localModelPath`, `dtype:'fp32'`; FK DECISION (GAP #2): `events` FKs to `runs`/`experiments`, NO `ON DELETE CASCADE` (retention in P2.12 deletes explicitly).

## Files to Modify

> ≤10 unique paths, one per line.
- `src/store/schema.ts`
- `src/store/event-store.ts`
- `src/store/recall.ts`
- `src/store/search/sqlite-vec-strategy.ts`
- `src/embed/onnx-pipeline.ts`
- `tests/store/schema.test.ts`
- `tests/store/recall-reconstruct.test.ts`
- `tests/store/fts5-triggers.test.ts`
- `tests/store/vec-knn.test.ts`
- `tests/store/no-llm-egress.test.ts`

## Security Invariants

> Concrete named invariants only — N/A NOT permitted when triggered.

- **INV-OM2:** Every `events` row carries a non-null `run_id` referencing a real `runs` row — enforced by `NOT NULL` + the `FOREIGN KEY(run_id) REFERENCES runs(run_id)` (R2, no CASCADE) WITH `PRAGMA foreign_keys=ON` set on every connection (Bun and Node; FK clauses are inert otherwise) and asserted on the write path (orphan insert rejected); the spine cannot be omitted. No silent drop: real event writers route through `maskAndCap` (caps ≤64KB) so data events never hit the 64KB reject — that reject is fail-fast defense-in-depth for a bypassing caller, not a data-drop path.
- **INV-OM3 (cap scope):** `payload_json`/`result_json` are ≤ 64 KB — the BYTE CAP is enforced at this write boundary (oversized rejected before persistence). Secret-pattern masking is owned by the P2.3 `maskAndCap` util (`src/capture/mask-and-cap.ts`); P2.1 cites it (forward-dep) and does not re-implement masking — capture rows arrive pre-masked.
- **INV-OM4:** The ONNX embedding model loads from a pinned local path only — `env.allowRemoteModels=false` and the pinned `env.localModelPath` are READ BACK and asserted (not only "no network call observed"); no remote fetch occurs (network mock asserts).
- **INV-STORE1:** Recall and store are read/compute-only with zero LLM/HTTP egress — every recall path is exercised under a network mock asserting no outbound call.

## Definition of Done

> Heavy store/net-new — 14–20 boxes accepted; every box a distinct guard/security/test.

- [ ] **Impl:** §C DDL authored as `.sql` content — `events` (with FK to `runs`/`experiments`, NO CASCADE) / `runs` / `experiments` / `event_edges` / `schema_meta` with all CHECK constraints, on a WAL database (applied at runtime by P2.2's runner — P2.1 does not `CREATE` at runtime).
- [ ] **Impl (R4):** all 9 NAMED events indexes created — `idx_events_run`, `_agent`, `_skill`, `_type`, `_variant`, `_experiment`, `_parent`, `_created`, and the composite `idx_events_run_created(run_id, created_at)` — plus runs (dag_def_id/variant/started_at), experiments (status/skill), event_edges (source/target).
- [ ] **Impl:** `event_vec` created as `vec0(event_id text primary key, embedding float[384])`; P2.1 owns the `schema_meta` SHAPE (key/value), P2.2 writes the seeds (schema_version=1.0.0, engine=sqlite+sqlite-vec, embedding_model=Xenova/all-MiniLM-L6-v2, embedding_dim=384).
- [ ] **Impl (GAP #1):** `events_fts` FTS5 table authored with an explicit `event_id TEXT UNINDEXED` column mirroring `events.id` (written by the app write path that builds the FTS row — the `{domain}:{uuid}` TEXT PK string, NOT FTS5's auto-INTEGER `rowid`) + AFTER INSERT/DELETE/UPDATE sync triggers (claude-mem `SessionStore.ts:434-460` pattern), populated via app write path / `json_extract` over REAL columns (`event_type`, `skill`, `tool_name`, `COALESCE(json_extract(payload_json,'$.summary'),'')`, `json_extract(payload_json/result_json,'$.message/$.text')`) — no triggers referencing absent columns. Recall FTS5 JOIN contract pinned: `events.id = events_fts.event_id`.
- [ ] **Impl (R6 scope):** `event_vec` rows written for `tool_call`/`message` events ONLY; `node`/`outcome` not embedded — recall semantic path documents "KNN covers tool_call/message only".
- [ ] **Impl (swap seam):** `SqliteVecSearchStrategy` registered in place of `ChromaSearchStrategy` behind the unchanged Strategy framework; no Chroma modules loaded.
- [ ] **Impl (recall):** `reconstructRun(run_id)` returns ordered timeline via the composite-index access path + `parent_event_id` tree via recursive CTE (adjacency walk); indexed scans by agent/skill/prompt/variant/time; KNN; outcome/token/duration aggregations; every read-path `JSON.parse` guarded (sentinel on malformed/truncated row).
- [ ] **Impl (embed):** lazy-singleton ONNX `feature-extraction` pipeline (Xenova/all-MiniLM-L6-v2, `dtype:'fp32'`, mean-pool + normalize) yields a deterministic `Float32Array(384)`.
- [ ] **Contract:** §C DDL embedded as spec-citation; FK DECISION (GAP #2, no CASCADE) documented in `schema.ts`; schema_meta SHAPE owned here (key/value, not integer `schema_versions`), seed ownership deferred to P2.2.
- [ ] **Integration:** hybrid recall (FTS5 + vector) merges through `SearchOrchestrator`/`HybridSearchStrategy` end-to-end on a real DB.
- [ ] **Security (INV-OM2):** non-null `run_id` + FK to `runs` enforced; an orphan-`run_id` insert is rejected (asserted).
- [ ] **Security (INV-OM3):** 64KB byte cap enforced at the write boundary (oversized rejected); secret-masking cited as the P2.3 `maskAndCap` forward-dep (not re-implemented here).
- [ ] **Security (INV-OM4):** ONNX loads pinned-local only — test reads back `allowRemoteModels===false` + pinned `localModelPath` (not merely "no network observed").
- [ ] **Security (INV-STORE1):** network mock asserts zero LLM/HTTP egress across all recall + store paths.
- [ ] **Test (unit):** schema CHECK constraints reject invalid `event_type`/`status`; FK rejects orphan `run_id`; FTS5 triggers stay consistent across insert/update/delete; KNN pre-flight guard THROWS before SQL on missing `k`/`LIMIT`; guarded `JSON.parse` survives a malformed row.
- [ ] **Test (perf):** `reconstructRun(run_id)` over ≥500 events returns ordered timeline + tree in `< 200ms` (§12.1) with `EXPLAIN QUERY PLAN` confirming `idx_events_run_created` serves the scan.
- [ ] **Test (spike):** SPIKE-11 — sqlite-vec + ONNX native load validated under both Bun and Node (recorded as de-risk evidence, non-blocking).
- [ ] **Test (e2e demo — MANDATORY):** Open a fresh WAL DB → apply DDL + FTS5 triggers → seed a run + ordered event chain + ONNX-embedded `event_vec` rows (tool_call/message only) → `reconstructRun` returns timeline+tree `<200ms` over the composite index, FTS5 query (joining `events.id = events_fts.event_id`) and `k=?` KNN each return the expected event, aggregation returns outcome rates by variant — network mock asserts zero LLM/HTTP egress throughout.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
