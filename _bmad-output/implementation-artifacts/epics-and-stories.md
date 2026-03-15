# QDS Engineer v2 -- Epic & Story Decomposition

**Version:** 2.1
**Date:** 2026-03-15
**Source:** Consolidated v2 artifacts + Session 10 code-lift resolution + Session 11 twelve-factor alignment (PRD v2, Architecture v2, UX Spec v2, Code-Lift Manifest v2.0, Gap Analysis v2.0, ADR-024)
**Scope:** 10 epics, dependency-ordered stories, implementation-ready — zero ambiguity. Session 11 adds 2 new stories (1.4b, 1.4c), amends 5 stories (1.4, 1.6, 4.0, 8.5, 9.0), and adds growth stories for twelve-factor operational maturity.

## Dependency Chain

```
Epic 1 (Foundation)
  -> Epic 2 (Middleware Chain)
    -> Epic 3 (Verification) [parallel with 4, 5]
    -> Epic 4 (Turn Continuation & Hooks) [parallel with 3, 5]
    -> Epic 5 (Performance Data Collection) [parallel with 3, 4]
      -> Epic 6 (Economic Governance)
      -> Epic 7 (Learning System)
        -> Epic 8 (Notifications & Health)
          -> Epic 9 (Dashboard Extensions)
            -> Epic 10 (Growth Behavioral Effects)
```

Epics 3, 4, 5 can run in parallel after Epic 2 completes.

**Session 10 dependency additions:**
- Story 1.6 (Overstory Schema Extensions) → prerequisite for 3.3, 8.8
- Story 4.0 (Orchestration Loop) → prerequisite for 4.1; depends on 1.4
- Story 9.0 (ZeroClaw Carry-Forward) → prerequisite for 9.1
- Story 2.9 (TierResolver) → depends on 1.1, 1.4; prerequisite for 2.2, 2.3, 10.2

**Session 11 dependency additions:**
- Story 1.4b (Build & Containerization) → depends on 1.4; no downstream blockers (enables dev/prod parity)
- Story 1.4c (Admin CLI) → depends on 1.4; no downstream blockers (operational tooling)
- Story 9.0 amended to depend on 1.4 (gateway port/host config from Factory Core config loader)

---

## Epic 1: Foundation -- Pipeline DB, Shared Types, Factory Core Skeleton

**Scope:** Establish the foundational packages that every subsequent epic depends on: shared Zod schemas, the pipeline.db migration system with initial MVP tables, the attribution.db schema extension, the Result utility type, the Factory Core process skeleton with twelve-factor config alignment (env-var overrides, NDJSON logging, system dep checks), Docker containerization, and admin CLI tooling.
**Depends on:** None (first epic)
**Packages touched:** shared-types, factory-core, docker, scripts
**ADR references:** ADR-015 (Sections 15.3, 15.4, 15.6), ADR-016 (Section 16.3), ADR-017 (Section 17.7), ADR-019 (Sections 19.4, 19.5), ADR-020, ADR-021 (Section 21.2), ADR-023 (Section 23.6), ADR-024 (Sections 1, 2, 3, 5, 7, 8, 9, 10)
**Total estimated LOC:** ~1,310 (was ~670; +210 from Story 1.4 expansion, +470 from Story 1.4b, +170 from Story 1.4c, net adjustment -210 for original 1.4 LOC delta)

### Story 1.1: shared-types Package with All Zod Schemas

**Description:** Create the shared-types package with all Zod schemas and TypeScript interfaces needed across factory-core and dashboard. This includes performance types (ActionScore, SessionComposite, ConfidenceDeclaration, LearningRecord), must-haves types (MustHavesSchema, VerificationResult, ArtifactCheck, KeyLinkCheck, LightweightCheckResult), middleware types (Middleware, MiddlewareContext, MiddlewareResult), health types (HealthState, CircuitBreakerConfig, SubsystemStatus), result types (Result, toResult, toResultAsync), and notification types (ChannelMessage, Channel, Subscription). Each schema uses Zod for runtime validation.

**Acceptance criteria:**
- [ ] `shared-types/src/performance.ts` exports ActionScore, SessionComposite, ConfidenceDeclaration, LearningRecord, PatternKnowledge, OverlayEffectiveness Zod schemas and inferred TypeScript types
- [ ] `shared-types/src/must-haves.ts` exports MustHavesSchema, VerificationResult, ArtifactCheck, KeyLinkCheck, LightweightCheckResult schemas
- [ ] `shared-types/src/middleware.ts` exports Middleware, MiddlewareContext, MiddlewareResult interfaces
- [ ] `shared-types/src/health.ts` exports HealthState, CircuitBreakerConfig, SubsystemStatus schemas
- [ ] `shared-types/src/notifications.ts` exports ChannelMessage, Channel interface, Subscription schema
- [ ] All schemas include proper Zod validation constraints (CHECK ranges, enums, defaults) matching the SQL constraints defined in ADR-015 Section 15.4 and ADR-017 Section 17.7
- [ ] Package compiles with zero type errors
- [ ] Unit tests validate each schema accepts valid data and rejects invalid data (boundary values for score ranges, required fields, enum constraints)

**FR references:** FR130, FR131, FR132, FR140, FR152, FR163, FR164, FR165, FR170, FR171
**ADR references:** ADR-015 (Section 15.4, 15.6), ADR-017 (Section 17.7), ADR-019 (Section 19.4), ADR-021 (Section 21.2), ADR-022 (Section 22.2), ADR-023 (Section 23.6)
**Files created/modified:**
- `shared-types/src/performance.ts` (~80 LOC)
- `shared-types/src/must-haves.ts` (~40 LOC)
- `shared-types/src/middleware.ts` (~30 LOC)
- `shared-types/src/health.ts` (~20 LOC)
- `shared-types/src/notifications.ts` (~40 LOC)
**Estimated LOC:** 210
**Dependencies:** None (first story)
**MVP/Growth:** MVP

### Story 1.2: pipeline.db Migration System and Initial MVP Schema

**Description:** Create the SQL migration system for pipeline.db and implement the initial MVP schema containing 9 tables: stories, action_scores, confidence_declarations, session_composites, learning_records, turn_state, epics, epic_context, and overlay_effectiveness. The `stories` table is the central pipeline tracking table polled by the orchestration loop (Story 4.0). Migrations are plain SQL files executed sequentially by Factory Core at startup. All tables use SQLite with WAL mode for concurrent access safety.

**Acceptance criteria:**
- [ ] Migration runner loads SQL files from `factory-core/src/migrations/` in lexicographic order and executes them idempotently (tracks applied migrations in a `_migrations` table)
- [ ] Initial migration creates all 9 MVP tables with CHECK constraints, indexes, and defaults matching ADR-015 Sections 15.4 and 15.6, ADR-019 Section 19.5, and the epic-level context architecture. The `stories` table includes: `id` (PRIMARY KEY), `status` (TEXT NOT NULL, CHECK IN ('pending', 'active', 'completed', 'failed')), `phase` (TEXT NOT NULL), `heartbeat_at` (TEXT — ISO-8601, updated by active story agents), `transfer_manifest` (TEXT — JSON for phase boundary data), `created_at` (TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP), `updated_at` (TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)
- [ ] WAL mode is enabled on database open (`PRAGMA journal_mode=WAL`)
- [ ] Migration runner is tested with fresh database creation and re-run idempotency
- [ ] All indexes from the architecture are created (idx_stories_status, idx_stories_status_heartbeat, idx_action_scores_story, idx_action_scores_agent, idx_confidence_story, idx_composites_agent, idx_learning_domain, idx_learning_category, idx_turn_state_story, idx_epic_context_epic)
- [ ] The sequential SQL migration runner manages ONLY Factory Core's own databases (`pipeline.db`, `attribution.db`). Overstory databases (`sessions.db`, `mail.db`, `events.db`, `metrics.db`) are managed by Story 1.6 (Overstory Schema Extensions) using Overstory's native dual migration strategy: probe-then-alter (`PRAGMA table_info` → `ALTER TABLE ADD COLUMN`) for safe column additions, and table-rebuild (`CREATE new table` → `copy data` → `DROP old` → `RENAME new`) for CHECK constraint modifications (since SQLite does not support modifying existing CHECK constraints via ALTER TABLE)

**FR references:** FR130, FR131, FR132, FR149, FR164, FR165, FR166, FR168
**ADR references:** ADR-015 (Section 15.3, 15.4, 15.6), ADR-019 (Section 19.5), ADR-020
**Files created/modified:**
- `factory-core/src/migrations/001-initial-schema.sql` (~120 LOC)
- `factory-core/src/migrations/runner.ts` (~80 LOC)
**Estimated LOC:** 200
**Dependencies:** None
**MVP/Growth:** MVP

### Story 1.3: attribution.db Schema Extension (task_checkouts Table)

**Description:** Add the task_checkouts table to attribution.db for atomic task checkout, preventing duplicate work assignment when multiple stories run concurrently. The table uses a UNIQUE constraint on (story_id, task_id) to enforce single-claim semantics via SQLite locking.

**Acceptance criteria:**
- [ ] `task_checkouts` table is created in attribution.db with columns: id, story_id, task_id, agent_id, phase, claimed_at, completed_at, released_at
- [ ] UNIQUE constraint on (story_id, task_id) prevents double-claim
- [ ] Indexes on story_id and agent_id are created for query performance
- [ ] WAL mode is enabled on attribution.db
- [ ] Unit test verifies that a second INSERT with the same (story_id, task_id) throws a UNIQUE constraint violation

**FR references:** FR145
**ADR references:** ADR-016 (Section 16.3)
**Files created/modified:**
- `factory-core/src/migrations/002-attribution-task-checkouts.sql` (~20 LOC)
**Estimated LOC:** 20
**Dependencies:** 1.2 (migration runner)
**MVP/Growth:** MVP

### Story 1.4: Factory Core Process Skeleton

**Description:** Create the Factory Core entry point that reads factory.yaml, validates it with Zod, freezes the config object with Object.freeze, and initializes both SQLite databases (pipeline.db and attribution.db) with WAL mode. This is the minimal bootable Factory Core process that all subsequent stories build upon. The process does not yet run the pipeline -- it just proves the startup sequence is sound. Includes twelve-factor config alignment: environment variable overrides, configurable database paths, system dependency checks, NDJSON structured logging, and example config files.

**Acceptance criteria:**
- [ ] Factory Core reads `factory.yaml` from a configurable path (default: `.qds/factory.yaml`)
- [ ] Config is validated against a Zod schema (FactoryConfig) that includes at minimum: phases config (max_turns per phase), budget config (per-story ceiling, global daily ceiling), health config (circuit breaker settings), notifications config (channel routing), gateway config (port, host), and databases config (pipeline_path, attribution_path)
- [ ] Config loader implements `applyEnvOverrides()` — walks `process.env` for `QDS_` prefixed variables, converts `__` (double underscore) to object nesting, merges after YAML parse but before Zod validation. Priority: env vars > `factory.yaml` > hardcoded defaults (ADR-024 Section 1)
- [ ] Database paths are configurable via `factory.yaml` `databases.pipeline_path` (default `.qds/pipeline.db`) and `databases.attribution_path` (default `.qds/attribution.db`), overridable via `QDS_PIPELINE_DB_PATH` and `QDS_ATTRIBUTION_DB_PATH` env vars (ADR-024 Section 2)
- [ ] Validated config is frozen via `Object.freeze()` (deep freeze) -- any mutation attempt throws at runtime
- [ ] pipeline.db is opened/created at the configured path with WAL mode and migration runner is executed
- [ ] attribution.db is opened/created at the configured path with WAL mode and its migrations are executed
- [ ] Factory Core startup checks for required system dependencies (git >= 2.30, bun >= 1.0, tmux >= 3.0) and fails fast with actionable error messages if missing (ADR-024 Section 7)
- [ ] Process logger writes to stdout as NDJSON (one JSON object per line) with fields: `timestamp`, `level`, `component`, `message`. Log level controlled by `QDS_LOG_LEVEL` env var (default: `info`). Values: `debug`, `info`, `warn`, `error` (ADR-024 Section 9)
- [ ] Process logs startup diagnostics: config path, database paths, migration status, WAL mode confirmation, resolved env-var overrides (secrets redacted)
- [ ] `factory.yaml.example` committed to repo with all configuration keys documented and safe default values. Actual `.qds/factory.yaml` is gitignored. `qds init` (Story 1.4c) copies `factory.yaml.example` -> `.qds/factory.yaml` if missing
- [ ] `.env.example` committed to repo with all `QDS_*` environment variable keys, documented defaults, and safe placeholders for secrets. Actual `.env` is gitignored (ADR-024 Section 8)
- [ ] Integration test verifies end-to-end startup with a sample factory.yaml and confirms both databases are accessible
- [ ] Integration test verifies env-var overrides: set `QDS_PIPELINE_DB_PATH` to a temp path, confirm Factory Core opens the database at the overridden path

**FR references:** FR1, FR36, FR37, FR40
**ADR references:** ADR-020, ADR-015 (Section 15.3), ADR-024 (Sections 1, 2, 7, 8, 9), Architecture Section 12.3 (Single Source of Truth)
**Files created/modified:**
- `factory-core/src/index.ts` (~100 LOC)
- `factory-core/src/config/schema.ts` (~80 LOC)
- `factory-core/src/config/loader.ts` (~60 LOC)
- `factory-core/src/config/env-overrides.ts` (~40 LOC)
- `factory-core/src/logging/logger.ts` (~30 LOC)
- `factory.yaml.example` (~40 LOC)
- `.env.example` (~30 LOC)
**Estimated LOC:** 380
**Dependencies:** 1.1 (shared-types for config sub-schemas), 1.2 (migration runner), 1.3 (attribution migration)
**MVP/Growth:** MVP

### Story 1.5: Result<T> Utility Type

**Description:** Implement the Result<T, E> discriminated union type with toResult() and toResultAsync() helper functions in shared-types. Every async boundary in the turn continuation loop and middleware chain will use these helpers to normalize error handling, preventing silent catch-block failures from unexpected error types (plain strings, numbers thrown by dependencies).

**Acceptance criteria:**
- [ ] `Result<T, E>` type is a discriminated union: `{ ok: true; value: T } | { ok: false; error: E; message: string }`
- [ ] `toResult(fn)` wraps synchronous functions, catching all thrown values and normalizing to Error instances
- [ ] `toResultAsync(fn)` wraps async functions with the same error normalization
- [ ] Non-Error thrown values (strings, numbers, objects) are wrapped in `new Error(String(err))` with the original value preserved in the error field
- [ ] Unit tests cover: successful execution, Error thrown, string thrown, number thrown, object thrown, null thrown, undefined thrown, Promise rejection

**FR references:** FR149
**ADR references:** ADR-019 (Section 19.4)
**Files created/modified:**
- `shared-types/src/result.ts` (~30 LOC)
**Estimated LOC:** 30
**Dependencies:** None
**MVP/Growth:** MVP

### Story 1.6: Overstory Schema Extensions

**Description:** Perform ALL required schema changes to Overstory-owned databases using Overstory's native `PRAGMA table_info` introspection pattern (NOT Factory Core's sequential SQL migration runner). Uses two SQLite-appropriate strategies: table-rebuild (`CREATE new table` → `copy data` → `DROP old` → `RENAME new`) for CHECK constraint modifications, and `ALTER TABLE ADD COLUMN` for new columns. This consolidates all Overstory schema modifications into a single story to prevent scattered, uncoordinated migrations across multiple epics.

**Acceptance criteria:**
- [ ] Extend mail.db `message_type` CHECK constraint to include `learning_report` using SQLite table-rebuild migration: `PRAGMA table_info(mail)` probes current schema; if the CHECK must change, create a new table with the revised CHECK constraint, copy data from old table, drop old table, rename new table — following Overstory's `SessionStore.open()` idempotent migration pattern
- [ ] Add `phase` column (TEXT NOT NULL DEFAULT 'dev') to mail.db per ADR-006 (5d) via `ALTER TABLE ADD COLUMN` (SQLite supports this), with composite index `(phase, to_agent, read)` for phase-scoped mail queries
- [ ] Extend events.db `EventType` CHECK constraint to include `hook_result` (per ADR-010 H2), `health_state` (per ADR-023), and `subsystem_error` (required by Story 8.8 for subsystem health event logging) in a single table-rebuild migration cycle: create a new table with the updated CHECK constraint accepting all three new enum values, copy data from the old events table, drop the old table, rename the new table — avoiding duplicate full-table rewrites
- [ ] All schema changes are idempotent: running the extension module twice produces no errors and no duplicate columns/constraints
- [ ] Extension module uses `bun:sqlite` `PRAGMA table_info()` to probe current schema before deciding whether migration is needed — same introspection pattern as Overstory's `SessionStore.open()` migration logic. CHECK constraint changes use table-rebuild (create-copy-drop-rename); column additions use `ALTER TABLE ADD COLUMN`
- [ ] Extension module reads Overstory database paths from Overstory's `loadConfig()` rather than hardcoding `.overstory/*.db`. This ensures database locations are consistent with Overstory's own configuration and respect any path overrides (ADR-024 Section 2)
- [ ] Unit tests verify: fresh database gets all extensions, pre-extended database is not modified, each CHECK constraint accepts all new type values (mail.db: `learning_report`; events.db: `hook_result`, `health_state`, `subsystem_error`)

**FR references:** FR23, FR57 (learning_report mail type), FR148 (hook_result event type), FR170 (health_state event type), FR170 (subsystem_error event type — added for Story 8.8; Story 8.8 depends on 1.6)
**ADR references:** ADR-006 (Section 5d), ADR-010 (H2), ADR-023, ADR-024 (Section 2)
**Files created/modified:**
- `factory-core/src/overstory/schema-extensions.ts` (~40 LOC)
**Estimated LOC:** 40
**Dependencies:** 1.4 (Factory Core skeleton for Overstory database path access). Note: Story 8.8 (Health State Events in events.db) depends on this story for the `subsystem_error` EventType value; the dependency is forward (8.8 → 1.6), not reverse.
**MVP/Growth:** MVP

### Story 1.4b: Build & Containerization

**Description:** Establish Docker containerization for QDS Factory by copying the proven rfp-agents Docker pattern. This includes the `scripts/compose.sh` environment-aware wrapper, profile-based docker-compose configuration, Debian-based multi-stage Dockerfiles (NOT Alpine — ARM64 native binary compatibility), 3-layer env file hierarchy, named volumes for SQLite persistence, and a Makefile for convenience targets. This story enables dev/prod parity for both developers (Steve on ARM64, Marcus on AMD64) from day one.

**Acceptance criteria:**
- [ ] `docker/docker-compose.yml` defines services with profile-based composition: `--profile backing-services` (tmux daemon only), `--profile backend` (Factory Core + Gateway), `--profile frontend` (Factory Core + Gateway + Dashboard). Services use env vars for all configuration with defaults matching `factory.yaml.example` (ADR-024 Section 3)
- [ ] `docker/docker-compose.dev.yml` overlay provides volume mounts for hot reload (`:ro` where applicable), command overrides for dev servers (Vite HMR for dashboard), debug ports, faster healthcheck intervals, and verbose logging (ADR-024 Section 8)
- [ ] `factory-core/Dockerfile` is a multi-stage Debian-based build: deps stage (install), builder stage (compile/check), runtime stage (`oven/bun:debian` base, non-root user, healthcheck CMD). Digest-pinned base image for reproducible builds (ADR-024 Section 3)
- [ ] `dashboard/Dockerfile` is a multi-stage Debian-based build: deps stage, builder stage (`vite build`), runner stage (`node:20-slim` serving static output, non-root user). NOT Alpine — Tailwind oxide ARM64 compatibility (ADR-024 Section 3)
- [ ] `dashboard/Dockerfile.dev` is a dev-only image with Vite HMR dev server CMD for hot reload during development
- [ ] `scripts/compose.sh` implements 3-layer env file priority: (1) `.env.example` base defaults, (2) `.env` local secrets, (3) `docker/.env.{environment}` Docker-specific overrides. Includes `FAIL_ON_MISSING_SECRETS` validation that rejects startup when required secrets are missing or still placeholder values in CI/staging (ADR-024 Sections 3, 8)
- [ ] `scripts/compose.sh` includes TTY color detection, Docker availability check, and environment argument validation (copy from rfp-agents)
- [ ] Named Docker volumes for SQLite persistence: `qds-pipeline-data` mounted at `/app/.qds`, `qds-overstory-data` mounted at `/app/.overstory`. Container destruction does not lose data (ADR-024 Section 2)
- [ ] Healthchecks in both Dockerfiles AND docker-compose.yml (aligned): Factory Core uses `curl -f http://localhost:3001/health`, with `interval: 30s`, `timeout: 5s`, `retries: 3`, `start_period: 10s` (ADR-024 Section 7)
- [ ] Service dependency: dashboard `depends_on` factory-core with `condition: service_healthy`
- [ ] Docker env files: `docker/.env.development`, `docker/.env.staging`, `docker/.env.production` — all git-tracked, NO secrets. Contains Docker-specific overrides (service URLs, ports, feature flags) (ADR-024 Section 8)
- [ ] `Makefile` with convenience targets: `make up` (start infrastructure), `make dev` (start with hot reload), `make down` (stop), `make logs` (follow), `make build` (build images), `make clean` (stop + remove volumes with confirmation) (ADR-024 Section 3)
- [ ] All runtime stages use non-root users
- [ ] `EXPOSE ${QDS_GATEWAY__PORT}` in Factory Core Dockerfile (ADR-024 Section 5)
- [ ] Docker `stop_grace_period: 15s` in compose for Factory Core service (ADR-024 Section 7)
- [ ] Integration test: `./scripts/compose.sh development up` starts all services, dashboard accessible via mapped port, `./scripts/compose.sh development down` stops cleanly

**FR references:** FR1
**ADR references:** ADR-024 (Sections 2, 3, 5, 7, 8)
**Files created/modified:**
- `docker/docker-compose.yml` (~80 LOC)
- `docker/docker-compose.dev.yml` (~40 LOC)
- `docker/.env.development` (~20 LOC)
- `docker/.env.staging` (~20 LOC)
- `docker/.env.production` (~20 LOC)
- `factory-core/Dockerfile` (~50 LOC)
- `dashboard/Dockerfile` (~60 LOC)
- `dashboard/Dockerfile.dev` (~20 LOC)
- `scripts/compose.sh` (~120 LOC)
- `Makefile` (~40 LOC)
**Estimated LOC:** 470
**Dependencies:** 1.4 (Factory Core skeleton, `factory.yaml.example`, `.env.example`)
**MVP/Growth:** MVP (P1 — end of Epic 1)

### Story 1.4c: Factory Core Admin CLI

**Description:** Implement one-off admin commands that run in the same runtime as Factory Core but exit after completion. These commands use the same config loading, env-var override resolution, and database access as the long-running process. All admin commands are runnable both bare-metal and inside Docker containers.

**Acceptance criteria:**
- [ ] `qds doctor` performs health checks: SQLite database integrity (`PRAGMA integrity_check`), `factory.yaml` Zod schema validation, Overstory connectivity (check for `.overstory/` directory and `ov` CLI availability), system dependency versions (git >= 2.30, bun >= 1.0, tmux >= 3.0), gateway port availability (attempt bind, release). Reports pass/fail for each check with actionable fix instructions on failure. Exits 0 if all pass, 1 if any fail (ADR-024 Section 10)
- [ ] `qds migrate` runs Factory Core's sequential SQL migration runner against `pipeline.db` and `attribution.db` without starting the orchestration loop. Reports migrations applied and current schema version. Useful for running migrations before starting the full process (ADR-024 Section 10)
- [ ] `qds config validate` loads `factory.yaml`, applies env-var overrides via `applyEnvOverrides()`, validates against Zod schema, and reports all validation errors with field paths and expected types. Exits 0 if valid, 1 if invalid (ADR-024 Section 10)
- [ ] `qds config show` loads `factory.yaml`, applies env-var overrides, and displays the fully resolved configuration. API keys and credentials are redacted (replaced with `***`). Shows which values came from env vars vs YAML vs defaults (ADR-024 Section 10)
- [ ] `qds init` creates `.qds/` directory if missing, copies `factory.yaml.example` -> `.qds/factory.yaml` if missing (does not overwrite existing), and reports what was created
- [ ] All admin commands use the same config loader and database initialization as `factory-core/src/index.ts` — no separate config parsing code
- [ ] All admin commands support `--help` flag with usage documentation
- [ ] Docker support: all commands runnable via `docker compose exec factory qds <command>` (against running container) or `docker compose run --rm factory qds <command>` (fresh container) (ADR-024 Section 10)
- [ ] Unit tests cover: doctor with all checks passing, doctor with missing dependency, config validate with valid config, config validate with invalid config, config show with env-var overrides and secret redaction

**FR references:** FR1
**ADR references:** ADR-024 (Section 10)
**Files created/modified:**
- `factory-core/src/cli/doctor.ts` (~60 LOC)
- `factory-core/src/cli/migrate.ts` (~20 LOC)
- `factory-core/src/cli/config.ts` (~40 LOC)
- `factory-core/src/cli/init.ts` (~20 LOC)
- `factory-core/src/cli/index.ts` (~30 LOC)
**Estimated LOC:** 170
**Dependencies:** 1.4 (Factory Core skeleton, config loader, migration runner)
**MVP/Growth:** MVP (P2 — end of Epic 1)

---

## Epic 2: Middleware Chain -- Overlay Composition Restructure

**Scope:** Implement the bidirectional middleware chain pattern (ADR-021) that restructures overlay composition and post-action processing into a unified before/after pattern. Each cross-cutting concern (budget, credentials, learning, enforcement, skills, verification, performance) gets a middleware module with beforeModel() and afterModel() phases. This replaces the scattered overlay/hook logic with a coherent organizational structure.
**Depends on:** Epic 1 (shared-types for Middleware interface, pipeline.db for data access, Factory Core skeleton for process context)
**Packages touched:** factory-core, shared-types
**ADR references:** ADR-021 (all sections), ADR-016, ADR-015, ADR-017
**Total estimated LOC:** ~390

### Story 2.1: Middleware Interface and MiddlewareChain Executor

**Description:** Implement the core Middleware interface and the MiddlewareChain executor that manages ordered execution of middleware beforeModel() and afterModel() phases. The chain enforces strict ordering (lower order number executes first), error isolation (one middleware's failure does not block others except for fatal middlewares), and no backward dependencies between middleware components.

**Acceptance criteria:**
- [ ] MiddlewareChain class accepts an array of Middleware implementations and sorts them by `order` field
- [ ] `runBefore(ctx: MiddlewareContext)` executes each middleware's beforeModel() in order, collecting contextAdditions and errors into an aggregate MiddlewareResult
- [ ] `runAfter(ctx: MiddlewareContext, actionResult: unknown)` executes each middleware's afterModel() in order
- [ ] Error isolation: if middleware N throws, middleware N+1 still executes (error logged, added to errors array)
- [ ] Fatal middleware (budget, credential) can halt the chain by returning an error result -- subsequent middleware do not execute
- [ ] Each middleware uses namespaced keys in MiddlewareContext to prevent key collisions
- [ ] Unit tests cover: successful chain execution, error isolation, fatal middleware halting, ordering enforcement
- [ ] Middleware order is determined by the explicit `order` field (integer) with stable sorting. This is a strict sequential ordering, not a priority/weight system. Middlewares are NOT dynamically reorderable at runtime

**FR references:** FR28 (overlay composition restructure)
**ADR references:** ADR-021 (Sections 21.2, 21.3, 21.5, 21.6)
**Files created/modified:**
- `factory-core/src/middleware/chain.ts` (~60 LOC)
- `factory-core/src/middleware/types.ts` (~40 LOC)
**Estimated LOC:** 100
**Dependencies:** 1.1 (shared-types middleware interfaces), 1.4 (Factory Core skeleton)
**MVP/Growth:** MVP

### Story 2.2: Budget Middleware

**Description:** Implement the budget middleware that checks per-story and global budget ceilings in beforeModel() and records cost data from Pi SDK Usage callbacks in afterModel(). Budget middleware has order 10 (executes first) and is a fatal middleware -- if the budget ceiling is exceeded, the chain halts and the agent spawn is blocked.

**Acceptance criteria:**
- [ ] `beforeModel()` queries attribution.db for cumulative story cost and cumulative daily cost
- [ ] If per-story budget exceeded, returns error result with `fatal: true` and descriptive message including current spend and ceiling
- [ ] If global daily ceiling exceeded, returns error result with `fatal: true`
- [ ] `contextAdditions` includes remaining budget amount for injection into overlay context
- [ ] `afterModel()` writes cost_events row to attribution.db from Pi SDK Usage data
- [ ] `afterModel()` updates cumulative totals for the story
- [ ] Unit tests cover: under-budget pass, per-story breach, global breach, cost recording

**FR references:** FR38, FR39, FR142
**ADR references:** ADR-021 (Section 21.4 item #1), ADR-016 (Sections 16.1, 16.4)
**Files created/modified:**
- `factory-core/src/middleware/budget.ts` (~40 LOC)
**Estimated LOC:** 40
**Dependencies:** 2.1 (middleware chain), 2.9 (TierResolver for cost profile resolution), 1.3 (attribution.db with cost tables)
**MVP/Growth:** MVP

### Story 2.3: Credential Middleware

**Description:** Implement the credential middleware that injects API keys via Pi SDK configuration in beforeModel() and sanitizes any output that might contain leaked credentials in afterModel(). Credential middleware has order 20 and is a fatal middleware -- if credential injection fails, the chain halts.

**Acceptance criteria:**
- [ ] `beforeModel()` registers a `getApiKey` callback with Pi SDK's Agent constructor that returns the appropriate API key for the agent's configured provider. The callback closure captures the key from Factory Core's credential store (in-memory, loaded from `factory.yaml` credential configuration). No credential material appears in `contextAdditions`, overlay content, or the Agent constructor's configuration object
- [ ] If credential configuration fails (missing key, invalid key format), returns error result with `fatal: true`
- [ ] `afterModel()` scans action result output for known credential patterns (API key formats, token patterns) and redacts any matches
- [ ] No credential material appears in `contextAdditions` — credentials are injected exclusively via Pi SDK's `getApiKey` callback mechanism, not overlay text or constructor configuration properties
- [ ] Unit tests cover: successful credential injection, missing credential handling, output sanitization with embedded key patterns

**FR references:** FR36, FR37
**ADR references:** ADR-021 (Section 21.4 item #2), NFR9, NFR10
**Files created/modified:**
- `factory-core/src/middleware/credential.ts` (~30 LOC)
**Estimated LOC:** 30
**Dependencies:** 2.1 (middleware chain), 2.9 (TierResolver — credential middleware calls `resolveModel()` to set the model on the Agent via `Agent.setModel()`)
**MVP/Growth:** MVP

### Story 2.4: Learning Middleware

**Description:** Implement the learning middleware that queries relevant learning records and pattern knowledge in beforeModel() and extracts new learning records from fix-loop and maintenance results in afterModel(). Learning middleware has order 30. In beforeModel(), it injects domain-relevant learnings into the overlay within a ~500 token budget. In afterModel(), it writes new learning records to pipeline.db.

**Acceptance criteria:**
- [ ] `beforeModel()` queries pipeline.db `learning_records` for records matching the story's file scope/domain
- [ ] `beforeModel()` queries pipeline.db `pattern_knowledge` for patterns with confidence >= 0.7 matching the story's scope
- [ ] Learning injection follows priority order: preventable maintenance findings, high-confidence patterns, general codebase learnings, epic context
- [ ] Total injected learning context is capped at ~500 tokens (configurable)
- [ ] `afterModel()` extracts learning records from fix-loop results when present, categorizing as preventable/unforeseeable/systemic
- [ ] `afterModel()` writes extracted records to pipeline.db `learning_records` table
- [ ] Unit tests cover: learning query and injection, token budget truncation, learning extraction from fix-loop data

**FR references:** FR164, FR165, FR167
**ADR references:** ADR-021 (Section 21.4 item #3), ADR-015 (Section 15.5)
**Files created/modified:**
- `factory-core/src/middleware/learning.ts` (~50 LOC)
**Estimated LOC:** 50
**Dependencies:** 2.1 (middleware chain), 1.2 (pipeline.db with learning tables)
**MVP/Growth:** MVP

### Story 2.5: Enforcement Middleware

**Description:** Implement the enforcement middleware that injects iron laws, conventions, and gate rules from Superpowers frontmatter in beforeModel() and logs gate pass/fail results in afterModel(). Enforcement middleware has order 40.

**Acceptance criteria:**
- [ ] `beforeModel()` reads the `description` field from Superpowers skill YAML frontmatter via `extractFrontmatter()` and interprets it as enforcement text for overlay injection. There is no separate `enforcement` field — the `description` IS the enforcement metadata per ADR-013 S5 ("Factory Core consumes frontmatter as-is")
- [ ] `beforeModel()` injects the `description` text of relevant skills into `contextAdditions` for overlay composition. The 3 critical enforcement skills (TDD, verification-before-completion, systematic-debugging) have descriptions that contain their triggering conditions and guard rules as natural language
- [ ] `afterModel()` logs gate pass/fail results with middleware name, rule identifiers, and timestamps
- [ ] `afterModel()` updates enforcement statistics (pass rate, common failure rules)
- [ ] Unit tests cover: rule injection from skill files, gate result logging, missing skill file handling

**FR references:** FR14, FR33, FR34
**ADR references:** ADR-021 (Section 21.4 item #4)
**Files created/modified:**
- `factory-core/src/middleware/enforcement.ts` (~30 LOC)
**Estimated LOC:** 30
**Dependencies:** 2.1 (middleware chain)
**MVP/Growth:** MVP

### Story 2.6: Skill Middleware

**Description:** Implement the skill middleware that injects skill descriptions from Superpowers metadata into the overlay in beforeModel(). Skill middleware has order 50 and has a no-op afterModel() since skills are read-only context.

**Acceptance criteria:**
- [ ] `beforeModel()` reads skill metadata from Superpowers' read-only configuration
- [ ] `beforeModel()` injects skill descriptions into `contextAdditions` for overlay composition
- [ ] `afterModel()` is a no-op that returns an empty MiddlewareResult
- [ ] Unit tests cover: skill injection, missing skills directory handling, empty skill set handling

**FR references:** FR33
**ADR references:** ADR-021 (Section 21.4 item #5)
**Files created/modified:**
- `factory-core/src/middleware/skill.ts` (~20 LOC)
**Estimated LOC:** 20
**Dependencies:** 2.1 (middleware chain)
**MVP/Growth:** MVP

### Story 2.7: Verification Middleware

**Description:** Implement the verification middleware that injects must_haves from the story spec into agent context in beforeModel() and runs the lightweight structural check in afterModel(). Verification middleware has order 70 (executes last, after all context is assembled).

**Acceptance criteria:**
- [ ] `beforeModel()` parses the story spec's `must_haves` section using MustHavesSchema from shared-types
- [ ] `beforeModel()` injects parsed must_haves into `contextAdditions` so the agent knows what structural outputs are required
- [ ] `afterModel()` triggers the lightweight structural check (artifact existence, key link pattern matching) -- the actual check logic is a stub in this story, fully implemented in Epic 3
- [ ] `afterModel()` reports structural drift findings in the middleware result metadata
- [ ] Unit tests cover: must_haves parsing and injection, structural check stub invocation, malformed must_haves handling

**FR references:** FR152
**ADR references:** ADR-021 (Section 21.4 item #6), ADR-017 (Section 17.7)
**Files created/modified:**
- `factory-core/src/middleware/verification.ts` (~30 LOC)
**Estimated LOC:** 30
**Dependencies:** 2.1 (middleware chain), 1.1 (shared-types must-haves schema)
**MVP/Growth:** MVP

### Story 2.8: Performance Middleware Stub

**Description:** Implement the performance middleware stub that collects data only in MVP (no behavioral routing). In beforeModel(), it is a no-op for MVP (Growth would inject performance context without the agent's own tier). In afterModel(), it computes an action score from hook results and writes it to the action_scores table -- the actual scoring logic is a stub in this story, fully implemented in Epic 5.

**Acceptance criteria:**
- [ ] `beforeModel()` is a no-op for MVP, returning empty contextAdditions (Growth: inject performance context per PERV-011 -- no self-tier injection)
- [ ] `afterModel()` calls action scorer (stub) with hook results and writes to pipeline.db `action_scores`
- [ ] Action scorer stub accepts hook results and returns a placeholder ActionScore with all scores set to 0.5
- [ ] Performance middleware has order 60
- [ ] Unit tests cover: no-op beforeModel, stub action score computation and write

**FR references:** FR130
**ADR references:** ADR-021 (Section 21.4 item #7), ADR-015 (Section 15.2)
**Files created/modified:**
- `factory-core/src/middleware/performance.ts` (~40 LOC)
**Estimated LOC:** 40
**Dependencies:** 2.1 (middleware chain), 1.2 (pipeline.db action_scores table)
**MVP/Growth:** MVP

### Story 2.9: Pi SDK Tier-to-Model Mapping (TierResolver)

**Description:** Implement the TierResolver module that maps Factory Core's tier directives (economy/standard/premium) to Pi SDK `Model<Api>` objects via `Agent.setModel()`. The resolver reads tier-to-model mappings from `factory.yaml`, validates at startup that all configured models exist in Pi SDK's `ModelRegistry`, and provides a `resolveModel(tier: string): Model<Api>` function for the credential and budget middlewares to consume.

**Acceptance criteria:**
- [ ] `factory.yaml` gains a `tiers` section mapping tier names to Pi SDK model identifiers: `economy: "glm-5"`, `standard: "claude-sonnet-4-20250514"`, `premium: "claude-opus-4-20250514"` (configurable)
- [ ] At startup, TierResolver calls `ModelRegistry.find()` for each configured model to validate existence. Missing model throws a startup error with the specific model identifier and tier name
- [ ] `resolveModel(tier: string): Model<Api>` returns the Pi SDK Model object for the requested tier
- [ ] Invalid tier names (not in factory.yaml `tiers` section) throw with descriptive error listing valid tiers
- [ ] Budget middleware (Story 2.2) calls `resolveModel()` to determine the cost profile for budget projection
- [ ] Credential middleware (Story 2.3) calls `resolveModel()` to set the model on the Agent via `Agent.setModel()`
- [ ] Unit tests cover: successful resolution for all 3 tiers, startup validation failure (nonexistent model), invalid tier name rejection, factory.yaml parsing of tiers section

**FR references:** FR36, FR41
**ADR references:** ADR-015 (Section 15.2), ADR-005
**Files created/modified:**
- `factory-core/src/middleware/tier-resolver.ts` (~50 LOC)
**Estimated LOC:** 50
**Dependencies:** 1.1 (shared-types for tier type definitions), 1.4 (Factory Core skeleton for config access)
**MVP/Growth:** MVP

---

## Epic 3: Continuous Verification -- Lightweight + Full Nyquist

**Scope:** Implement the two-mode verification system (ADR-017): a lightweight filesystem-only structural checker that runs as a post-task hook during development, and the full Nyquist verifier that runs after QA swarm. Includes the must_haves schema parser, oscillation detector for false-negative fix-loops, the pre-BMAD structural gate, and the Nyquist-BMAD disagreement protocol.
**Depends on:** Epic 2 (verification middleware provides the integration point; middleware chain orchestrates before/after phases)
**Packages touched:** factory-core, shared-types
**ADR references:** ADR-017 (all sections)
**Total estimated LOC:** ~660

### Story 3.1: must_haves Schema Parser and Validator

**Description:** Implement the parser that reads a story spec's must_haves section (YAML format) and validates it against the MustHavesSchema Zod schema from shared-types. The parser produces a structured MustHaves object that both the lightweight and full Nyquist verifiers consume.

**Acceptance criteria:**
- [ ] Parser reads must_haves from a story spec YAML file and validates against MustHavesSchema
- [ ] Truths are extracted as string array (behavioral assertions for full Nyquist)
- [ ] Artifacts are parsed with path, optional min_lines, optional contains, optional exports
- [ ] Key links are parsed with from, to, and pattern (regex string)
- [ ] Validation errors produce clear, actionable messages identifying which field failed and why
- [ ] Unit tests cover: valid must_haves, missing sections (defaults to empty arrays), invalid types, malformed YAML, edge cases (empty truths, zero min_lines, invalid regex in pattern)
- [ ] Note: `truths` map to GSD Nyquist behavioral (substantive) verification, `artifacts` map to existence + content verification, `key_links` map to wiring verification. This three-level decomposition traces to GSD's Nyquist three-level verification for traceability

**FR references:** FR152
**ADR references:** ADR-017 (Section 17.7)
**Files created/modified:**
- `factory-core/src/verification/must-haves-parser.ts` (~60 LOC)
**Estimated LOC:** 60
**Dependencies:** 1.1 (shared-types MustHavesSchema)
**MVP/Growth:** MVP

### Story 3.2: Lightweight Continuous Verifier (Filesystem-Only)

**Description:** Implement the lightweight structural verifier that runs pure filesystem checks against the must_haves specification. This verifier checks artifact existence (do declared files exist and meet min_lines?), key link pattern matching (do source files contain required import/reference patterns?), and content patterns (do files contain expected exports or structural markers). No LLM calls. Target execution time: under 500ms per check.

**Acceptance criteria:**
- [ ] Artifact existence check uses `existsSync()` to verify files exist, reads them to check `min_lines` threshold and `contains` substring match
- [ ] Artifact `exports` check verifies that claimed export names appear in the file content (regex-based)
- [ ] Key link check reads the `from` file and matches `pattern` regex against file content to verify the reference to `to` file exists
- [ ] Each check produces a typed result: `{ check: string; passed: boolean; detail: string }`
- [ ] Overall result is a `LightweightCheckResult` with pass/fail per check and aggregate pass status
- [ ] Execution completes within 500ms for a story spec with up to 20 artifacts and 20 key links (filesystem I/O only)
- [ ] Unit tests cover: all checks passing, missing artifact, artifact below min_lines, missing export, broken key link, invalid regex in pattern (graceful failure)

**FR references:** FR152
**ADR references:** ADR-017 (Section 17.2)
**Files created/modified:**
- `factory-core/src/verification/lightweight-check.ts` (~100 LOC)
**Estimated LOC:** 100
**Dependencies:** 3.1 (must_haves parser provides the structured input)
**MVP/Growth:** MVP

### Story 3.3: Integration -- Lightweight Verifier as Post-Task Hook

**Description:** Wire the lightweight verifier into the post-task hook pipeline so it runs automatically after each task completion during the development phase. Connect it to the verification middleware's afterModel() phase. When structural drift is detected, findings are injected into the agent's next turn context via Overstory mail, enabling in-flight course correction.

**Acceptance criteria:**
- [ ] Verification middleware's afterModel() calls the lightweight verifier with the story's parsed must_haves
- [ ] Structural drift findings (failed checks) are formatted as a concise warning message
- [ ] Drift warnings are sent to the agent via Overstory mail system for injection into the next turn context
- [ ] Drift findings are logged to pipeline.db for post-hoc analysis (which checks failed, when, for which story)
- [ ] Pass results are silent (no unnecessary noise injected into agent context)
- [ ] Integration test verifies: verifier runs after a simulated task completion, drift detection produces mail message, pass result produces no mail

**FR references:** FR152
**ADR references:** ADR-017 (Section 17.8)
**Files created/modified:**
- `factory-core/src/middleware/verification.ts` (modify -- replace stub with real call)
- `factory-core/src/verification/drift-reporter.ts` (~40 LOC)
**Estimated LOC:** 60
**Dependencies:** 3.2 (lightweight verifier), 2.7 (verification middleware), 1.6 (Overstory schema extensions for mail system)
**MVP/Growth:** MVP

### Story 3.4: Full Nyquist Verifier (LLM-Powered)

**Description:** Implement the full Nyquist verifier that runs after QA swarm completion. Unlike the lightweight checker, the full Nyquist verifier uses an economy-tier LLM to verify behavioral truths (assertions that require test execution or semantic judgment), in addition to performing the structural checks. It starts from the story goal, not the task checklist, producing a VERIFICATION.md with pass/fail per check and identified gaps.

**Acceptance criteria:**
- [ ] Full verifier runs all lightweight structural checks (artifacts, key links, exports) as a superset
- [ ] Truths verification uses an LLM call (economy-tier via Pi SDK) to evaluate behavioral assertions against test results, code structure, and runtime behavior evidence
- [ ] Produces a structured VerificationResult with per-check pass/fail, gap list, and aggregate status
- [ ] Gap list is formatted for consumption by the fix loop (FR7) -- each gap includes: check type, expected state, actual state, affected files
- [ ] Writes VERIFICATION.md to `.qds/verifications/{story_id}/` with human-readable results
- [ ] Estimated execution cost: ~$0.005 per run on economy-tier model
- [ ] Unit tests cover: all checks pass, structural gaps found, behavioral truth failures, mixed results
- [ ] Verification starts from the story's stated goal/purpose and verifies the codebase achieves that purpose. The task checklist is supporting evidence, not the primary verification target. Gap identification prioritizes "did the story achieve its stated goal?" over "did the agent complete every checklist item?"

**FR references:** FR152, FR153, FR163
**ADR references:** ADR-017 (Section 17.3)
**Files created/modified:**
- `factory-core/src/verification/nyquist.ts` (~150 LOC)
**Estimated LOC:** 150
**Dependencies:** 3.1 (must_haves parser), 3.2 (lightweight checks as superset)
**MVP/Growth:** MVP (schema + pipeline), Growth (full verification report FR153)

### Story 3.5: Pre-BMAD Structural Gate

**Description:** Implement the pre-BMAD structural gate that runs before BMAD review begins. This lightweight check verifies that files claimed in the transfer manifest actually exist, claimed commits exist in branch history, and file sizes roughly match claimed line counts. It catches phantom completions (agent claimed to create files that do not exist) before spending BMAD review tokens.

**Acceptance criteria:**
- [ ] Gate checks: all files listed in the transfer manifest exist on the filesystem
- [ ] Gate checks: all commits referenced in the manifest exist in the branch's git history
- [ ] Gate checks: file sizes match claimed line counts within 20% tolerance
- [ ] Gate runs as a `before_run` workspace hook for the BMAD phase
- [ ] On failure: BMAD phase is blocked, story receives a `phantom_completion` status, developer notification dispatched
- [ ] On pass: BMAD proceeds normally
- [ ] Cost: near-zero (filesystem checks + git log)
- [ ] Unit tests cover: all checks pass, missing file, missing commit, size mismatch beyond tolerance

**FR references:** FR152
**ADR references:** ADR-017 (Section 17.4)
**Files created/modified:**
- `factory-core/src/verification/pre-bmad-gate.ts` (~80 LOC)
**Estimated LOC:** 80
**Dependencies:** 3.1 (must_haves parser)
**MVP/Growth:** MVP

### Story 3.6: Oscillation Detector

**Description:** Implement the oscillation detector that identifies false-negative fix-loops where the Nyquist verifier repeatedly reports the same gaps on code that the fix loop did not modify. After 2 consecutive identical gap lists with no relevant code changes, the system force-exits the fix loop and escalates to the developer.

**Acceptance criteria:**
- [ ] Detector compares gap list G_N with gap list G_{N+1} for semantic equality (same checks, same affected files)
- [ ] Detector checks whether the fix loop modified any files referenced in the gaps between iterations
- [ ] If G_{N+1} == G_N AND no referenced files were modified: flag as potential false negative
- [ ] After 2 consecutive flagged iterations: force-exit fix loop with `verification_inconclusive` status
- [ ] Escalation includes: gap list, iteration count, evidence that referenced code was not modified
- [ ] Notification dispatched via MessageBus (Telegram in MVP)
- [ ] Unit tests cover: progressing fix loop (different gaps), false negative detection (same gaps no changes), hard cap enforcement

**FR references:** FR152
**ADR references:** ADR-017 (Section 17.5)
**Files created/modified:**
- `factory-core/src/verification/oscillation-detector.ts` (~60 LOC)
**Estimated LOC:** 60
**Dependencies:** 3.4 (full Nyquist produces the gap lists that feed oscillation detection)
**MVP/Growth:** MVP

### Story 3.7: Nyquist-BMAD Disagreement Protocol

**Description:** Implement the disagreement resolution protocol for when structural verification (Nyquist) and BMAD review produce conflicting quality assessments. The protocol applies clear tiebreaker rules: Nyquist wins on structural completeness (missing files, broken links), BMAD wins on spec compliance (behavioral correctness), both gaps are addressed when they fail on different issues, and escalation to developer when both fail on the same issue with different assessments.

**Acceptance criteria:**
- [ ] Resolver accepts Nyquist VerificationResult and BMAD findings list as inputs
- [ ] Implements 4 scenarios: BMAD pass + Nyquist fail (Nyquist wins structural), BMAD fail + Nyquist pass (BMAD wins spec), both fail different issues (merge gap lists), both fail same issue differently (escalate)
- [ ] Output is a unified gap list with provenance tags (source: nyquist, source: bmad, source: merged)
- [ ] Escalation produces a developer notification with both assessments and rationale for ambiguity
- [ ] Unified gap list feeds directly into the fix loop (FR7)
- [ ] Unit tests cover: all 4 disagreement scenarios, agreement scenarios (both pass, both fail same)

**FR references:** FR163
**ADR references:** ADR-017 (Section 17.6)
**Files created/modified:**
- `factory-core/src/verification/disagreement-resolver.ts` (~80 LOC)
- `factory-core/src/verification/finding-merger.ts` (~70 LOC)
**Estimated LOC:** 150
**Dependencies:** 3.4 (full Nyquist verifier), 3.2 (lightweight verifier)
**MVP/Growth:** MVP

---

## Epic 4: Turn Continuation & Workspace Lifecycle

**Scope:** Implement the turn continuation loop (ADR-019) that allows agents to execute multiple turns within a phase before triggering transition, with progress velocity checks to prevent asymptotic approach failures. Also implement workspace lifecycle hooks (ADR-018) that fire around Overstory's worktree operations, with rollback on partial failure and stall detection integration.
**Depends on:** Epic 2 (middleware chain provides the beforeModel/afterModel integration points; verification middleware triggers per-turn structural checks)
**Packages touched:** factory-core
**ADR references:** ADR-019 (all sections), ADR-018 (all sections)
**Total estimated LOC:** ~650

### Story 4.0: Factory Core Orchestration Loop

**Description:** Implement the top-level orchestration loop that connects Factory Core's startup skeleton (Story 1.4) to the turn continuation engine (Stories 4.1-4.7). This is the "brain" of the factory — the Symphony GenServer poll-reconcile-dispatch pattern that: polls `pipeline.db` for pending/active stories, reconciles current state (which stories are running, which need phase transitions), dispatches new phase agents via Overstory's `ov sling`, enforces concurrent story limits, and handles Factory Core restarts (resume from persisted state).

**Acceptance criteria:**
- [ ] The `stories` table in `pipeline.db` is owned by Story 1.2's initial schema migration (001-initial-schema.sql). The table's minimal schema includes: `id` (PRIMARY KEY), `status` (TEXT NOT NULL, CHECK constraint: 'pending', 'active', 'completed', 'failed'), `phase` (TEXT NOT NULL), `heartbeat_at` (TEXT — ISO-8601 timestamp, updated by active story agents), `transfer_manifest` (TEXT — JSON blob for phase boundary data), `created_at` (TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP), `updated_at` (TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP). Indexed on `(status)` for polling queries and `(status, heartbeat_at)` for stale-heartbeat detection.
- [ ] Main loop polls `pipeline.db` `stories` table at a configurable interval (default: 5s) for stories with status `pending` or `active`
- [ ] Reconciliation phase compares running story state (in-memory) with persisted state (pipeline.db): detects stories that need phase transitions, stories that crashed mid-phase (no heartbeat — `heartbeat_at` older than configurable threshold, default: 30s), and new pending stories
- [ ] Dispatch phase calls `ov sling` via Overstory to spawn the next phase's agent for each story needing a phase transition, passing the phase boundary transfer manifest
- [ ] Concurrent story limit is enforced: configurable via `factory.yaml` `pipeline.max_concurrent_stories` (default: 3). When limit is reached, pending stories remain queued
- [ ] On Factory Core restart, the loop queries `turn_state` and `pipeline.db` to reconstruct in-memory state and resume from the last persisted checkpoint — no stories are lost or re-executed
- [ ] Loop integrates with the circuit breaker (Story 8.5): when circuit breaker is OPEN, no new stories are dispatched (existing active stories continue)
- [ ] All errors in the loop are wrapped in `toResultAsync()` — a single story's failure does not crash the orchestration loop
- [ ] SIGTERM/SIGINT handlers implement graceful shutdown sequence: (a) stop accepting new stories (set loop flag), (b) close WebSocket connections with close code `1001` ("going away"), (c) flush SSE buffers (send pending events), (d) checkpoint in-progress turn state to `turn_state` table, (e) persist circuit breaker state to `pipeline.db`, (f) close database connections (WAL checkpoint), (g) exit 0. Shutdown completes within 10 seconds (matches Docker's default SIGTERM->SIGKILL timeout) (ADR-024 Section 7)
- [ ] Startup SLA: < 2 seconds from process start to orchestration loop running (config load -> migration check -> DB open -> gateway bind -> loop start) (ADR-024 Section 7)
- [ ] Every orchestration log line includes structured correlation fields: `story_id`, `phase`, `agent_id`, `turn_number` (when applicable) for unified log tracing across Factory Core + Gateway + agent processes (ADR-024 Section 9)
- [ ] Unit tests cover: empty pipeline (no-op), single pending story dispatch, concurrent limit enforcement, crash recovery (restart mid-story), circuit breaker pause, story needing phase transition, graceful shutdown on SIGTERM (verify WS close, state checkpoint, DB close)

**FR references:** FR1, FR4, FR5
**ADR references:** ADR-002, ADR-019 (Section 19.1), ADR-024 (Sections 7, 9)
**Files created/modified:**
- `factory-core/src/pipeline/orchestration-loop.ts` (~160 LOC)
**Estimated LOC:** 160
**Dependencies:** 1.4 (Factory Core skeleton), 1.2 (pipeline.db), 1.5 (Result type)
**MVP/Growth:** MVP

### Story 4.1: Turn Continuation Loop with Per-Turn Signals

**Description:** Implement the core turn continuation loop that manages multi-turn agent execution within a single phase. After each turn, Factory Core evaluates whether the phase goal is achieved using three lightweight signals: post-task hook pass/fail result, lightweight Nyquist structural check result, and checklist completion percentage. If the goal is not achieved and turns remain, a continuation prompt is injected and the next turn executes.

**Acceptance criteria:**
- [ ] Turn loop executes up to `max_turns` turns per phase (configurable per phase type in factory.yaml)
- [ ] After each turn, three signals are evaluated: hook pass/fail, structural check passed (boolean), checklist completion (0.0-1.0)
- [ ] Goal-achieved decision: all signals green AND checklist >= 90% triggers phase transition
- [ ] Goal-not-achieved decision: any signal red OR checklist < 90% continues to next turn (if turns remain)
- [ ] When max_turns is reached without goal achievement: trigger phase transition regardless
- [ ] All errors within the turn loop are wrapped in toResultAsync() -- no raw try/catch blocks
- [ ] Unit tests cover: goal achieved on turn 1, goal achieved on turn N, max_turns reached without goal, error in signal evaluation (graceful handling via Result)

**FR references:** FR149
**ADR references:** ADR-019 (Sections 19.1, 19.2)
**Files created/modified:**
- `factory-core/src/pipeline/turn-continuation.ts` (~120 LOC)
**Estimated LOC:** 120
**Dependencies:** 4.0 (orchestration loop), 2.7 (verification middleware for structural check signal), 1.5 (Result type for error normalization)
**MVP/Growth:** MVP

### Story 4.2: Progress Velocity Check

**Description:** Implement the progress velocity check that conditionally extends max_turns when an agent is making measurable progress toward a nearly-complete goal. This prevents asymptotic approach failures where a story reaches 89% at max_turns and must restart with a fresh agent, wasting the accumulated work.

**Acceptance criteria:**
- [ ] At max_turns boundary, velocity check evaluates three conditions: (1) agent made measurable progress in last turn (at least 1 new file modified or 1 new test passing), (2) goal completion > 75% (checklist + structural checks), (3) current turn_number < max_turns * 1.5 (hard cap)
- [ ] If all three conditions met: max_turns extended by 1
- [ ] Extension can repeat (turn 6 can extend to turn 7) up to the hard cap (max_turns * 1.5, rounded down)
- [ ] Extension is logged with: original max_turns, extension count, completion percentage at extension point
- [ ] If conditions not met at max_turns: phase transition proceeds normally (no extension)
- [ ] Unit tests cover: extension granted (all conditions met), extension denied (no progress), extension denied (below 75%), hard cap enforcement, multiple sequential extensions

**FR references:** FR149
**ADR references:** ADR-019 (Section 19.3)
**Files created/modified:**
- `factory-core/src/pipeline/turn-continuation.ts` (modify -- add velocity check to existing loop)
**Estimated LOC:** 40
**Dependencies:** 4.1 (turn continuation loop)
**MVP/Growth:** MVP

### Story 4.3: Turn State Persistence

**Description:** Persist turn state to pipeline.db between turns so that a Factory Core crash mid-story can resume from the last completed turn. Turn state records include story_id, phase, turn_number, agent_id, status, checklist completion, files modified, action score reference, and structural check result.

**Acceptance criteria:**
- [ ] Each turn completion writes a row to `turn_state` table with all fields populated
- [ ] Status field tracks: 'running', 'completed', 'failed', 'extended'
- [ ] UNIQUE constraint on (story_id, phase, turn_number) prevents duplicate state records
- [ ] On Factory Core restart, the turn continuation module can query turn_state to find the last completed turn for an in-progress story and resume from turn N+1
- [ ] Turn state includes foreign key reference to action_scores table (if an action score was computed for that turn)
- [ ] Unit tests cover: state write on turn completion, state query for resume, crash recovery simulation (write 3 turns, restart, verify resume from turn 4)

**FR references:** FR149
**ADR references:** ADR-019 (Section 19.5)
**Files created/modified:**
- `factory-core/src/pipeline/turn-state.ts` (~60 LOC)
**Estimated LOC:** 60
**Dependencies:** 4.1 (turn continuation loop), 1.2 (pipeline.db turn_state table)
**MVP/Growth:** MVP

### Story 4.4: Continuation Prompt Template Injection

**Description:** Implement the continuation prompt template that is injected into agent context between turns. The template includes turn number, max turns, phase name, lightweight Nyquist results from the previous turn, and remaining checklist items. The prompt instructs the agent to resume from current workspace state rather than restarting.

**Acceptance criteria:**
- [ ] Template includes: turn_number, max_turns, phase name, lightweight Nyquist results (formatted per-check), remaining checklist items (unfinished items listed)
- [ ] Template is injected via Factory Core before the next Pi SDK model call
- [ ] Template explicitly states "Resume from the current workspace state instead of restarting from scratch"
- [ ] Template is configurable via factory.yaml (custom template path) with a sensible default matching ADR-019 Section 19.6
- [ ] Unit tests cover: template generation with various inputs (all checks pass, some checks fail, no checklist items remaining, many remaining items)

**FR references:** FR149
**ADR references:** ADR-019 (Section 19.6)
**Files created/modified:**
- `factory-core/src/pipeline/continuation-prompt.ts` (~40 LOC)
**Estimated LOC:** 40
**Dependencies:** 4.1 (turn continuation loop calls this to build the continuation prompt)
**MVP/Growth:** MVP

### Story 4.5: Workspace Lifecycle Hooks (4 Points)

**Description:** Implement the four workspace lifecycle hooks that fire around Overstory's worktree operations: after_create (install deps, copy .env), before_run (verify deps, check disk space, pre-BMAD gate), after_run (collect metrics, extract learnings), before_remove (verify no uncommitted changes, archive logs). Hooks execute in Factory Core process via Bun.spawn(), not in the agent process (security boundary).

**Acceptance criteria:**
- [ ] after_create hook fires after `git worktree add` completes, runs configured scripts via Bun.spawn()
- [ ] before_run hook fires before first agent spawns in worktree, runs configured scripts
- [ ] after_run hook fires after story completion (success or failure), runs configured scripts
- [ ] before_remove hook fires before worktree cleanup, runs configured scripts
- [ ] Hook scripts are configurable in factory.yaml per hook point (`workspace.hooks.after_create`, etc.)
- [ ] Hooks run in Factory Core process context with Factory Core permissions (agents cannot modify, skip, or observe hook execution)
- [ ] Hook timeout defaults to 30s, configurable per hook point
- [ ] Unit tests cover: all 4 hook points fire at correct times, hook script execution via Bun.spawn, configurable scripts, timeout enforcement

**FR references:** FR148
**ADR references:** ADR-018 (Sections 18.1, 18.5)
**Files created/modified:**
- `factory-core/src/worktree/lifecycle-hooks.ts` (~150 LOC)
**Estimated LOC:** 150
**Dependencies:** 1.4 (Factory Core skeleton for config access)
**MVP/Growth:** MVP

### Story 4.6: Hook Rollback on Partial Failure

**Description:** Implement failure handling for workspace lifecycle hooks, with rollback behavior specific to each hook point. Most critically, after_create failure must clean up the created worktree (via `git worktree remove --force`) and set story status to `failed_setup` to prevent leaving unusable worktrees.

**Acceptance criteria:**
- [ ] after_create failure: worktree is removed via `git worktree remove --force`, story status set to `failed_setup` in pipeline.db, diagnostic logged, developer notification dispatched
- [ ] before_run failure: story fails with diagnostic, worktree preserved for inspection, developer can retry
- [ ] after_run failure: warning logged, story completion status unaffected, learning extraction may be incomplete
- [ ] before_remove failure: warning logged, cleanup proceeds, uncommitted changes archived to `.qds/orphaned-changes/` before worktree removal
- [ ] All failure paths produce structured log entries with hook name, error message, affected story_id
- [ ] Unit tests cover: all 4 failure scenarios, worktree cleanup verification for after_create failure, orphaned changes archive for before_remove failure

**FR references:** FR148
**ADR references:** ADR-018 (Section 18.3)
**Files created/modified:**
- `factory-core/src/worktree/lifecycle-hooks.ts` (modify -- add rollback logic)
- `factory-core/src/worktree/rollback.ts` (~50 LOC)
**Estimated LOC:** 70
**Dependencies:** 4.5 (lifecycle hooks)
**MVP/Growth:** MVP

### Story 4.7: Stall Detection Integration

**Description:** Integrate stall detection with the turn continuation loop so that stall timeouts are applied per-turn rather than per-phase. If a single turn exceeds the configured timeout, the turn is marked as failed and the continuation loop evaluates whether to proceed to the next turn or trigger phase transition.

**Acceptance criteria:**
- [ ] Stall timeout is configured per-phase in factory.yaml (default: 300s for dev, 120s for bmad, 180s for qa)
- [ ] Timeout applies to each turn individually, not to the entire phase
- [ ] When a turn times out: turn is marked `failed` in turn_state, Factory Core evaluates remaining turns and goal progress
- [ ] If progress was made in prior turns and goal > 50%: continue to next turn (the timed-out turn is a lost turn, not a fatal failure)
- [ ] If no prior progress or goal < 50%: trigger phase transition with `stalled` status
- [ ] Stall detection integrates with the circuit breaker (ADR-023) -- when circuit breaker is OPEN, stall timeouts are doubled
- [ ] Unit tests cover: turn timeout, timeout with continued progress, timeout with no progress, circuit breaker timeout doubling

**FR references:** FR149
**ADR references:** ADR-019 (Section 19.8)
**Files created/modified:**
- `factory-core/src/pipeline/turn-continuation.ts` (modify -- add stall detection)
- `factory-core/src/pipeline/stall-detector.ts` (~50 LOC)
**Estimated LOC:** 50
**Dependencies:** 4.1 (turn continuation loop), 4.3 (turn state persistence)
**MVP/Growth:** MVP

---

## Epic 5: Performance Data Collection (MVP Layers 1-3)

**Scope:** Implement the first three layers of the performance and learning system (ADR-015): action scoring, confidence calibration, and session composite aggregation. These are data-collection-only layers -- no behavioral effects (no ELO routing, no tier-based hook density) until Growth phase. Also includes integration with the performance middleware and the overlay effectiveness tracker.
**Depends on:** Epic 2 (performance middleware stub provides the afterModel() integration point; middleware chain orchestrates execution)
**Packages touched:** factory-core
**ADR references:** ADR-015 (Sections 15.2, 15.4, 15.5, 15.6, 15.7, 15.9, 15.10, 15.15), ADR-021
**Total estimated LOC:** ~510

### Story 5.1: Action Scorer Module

**Description:** Implement the action scorer that computes process quality scores after each post-task hook execution. Each action score contains three dimensions: promise (probability of story completion from hook data), progress (advancement toward phase goal), and process (quality of the development process based on TDD compliance, lint/type-check status). Scores are computed from hook result data already available in the pipeline -- no LLM calls.

**Acceptance criteria:**
- [ ] Action scorer accepts hook results (pass/fail per hook, test coverage delta, lint status, type-check status, files modified count, tokens consumed, duration)
- [ ] Computes `score_promise` (0.0-1.0): derived from hook pass rate, test coverage trend, and historical completion correlation
- [ ] Computes `score_progress` (0.0-1.0): derived from files modified vs expected scope, checklist completion delta
- [ ] Computes `score_process` (0.0-1.0): derived from TDD compliance (test before source), lint clean percentage, type-check pass rate
- [ ] Writes ActionScore row to pipeline.db `action_scores` table with all required fields (story_id, phase, agent_id, turn_number, hook_level, scores, files_modified, tokens_consumed, duration_ms)
- [ ] Computation completes within 200ms (NFR35) -- no expensive operations, pure arithmetic from available data
- [ ] Unit tests cover: perfect scores (all hooks pass, good coverage), low scores (hooks failing, no progress), edge cases (first turn with no history, zero files modified)

**FR references:** FR130
**ADR references:** ADR-015 (Section 15.4, 15.10, 15.15)
**Files created/modified:**
- `factory-core/src/performance/action-scorer.ts` (~120 LOC)
**Estimated LOC:** 120
**Dependencies:** 1.2 (pipeline.db action_scores table), 1.1 (shared-types ActionScore schema)
**MVP/Growth:** MVP

### Story 5.2: Confidence Calibration Tracker

**Description:** Implement the confidence calibration tracker that records agent confidence declarations from phase boundary transfer manifests and computes calibration quality (Brier score) on story completion. Includes the resolution requirement: agents must demonstrate discriminative ability by using confidence values across the [0.2, 0.9] range, not just one level.

**Acceptance criteria:**
- [ ] Tracker records confidence declarations from transfer manifests to pipeline.db `confidence_declarations` table (story_id, phase, agent_id, declared_confidence)
- [ ] On story completion, `actual_outcome` is computed from review findings (0.0-1.0 based on defect severity)
- [ ] Brier score computed per agent: mean squared error between declared confidence and actual outcome across declarations
- [ ] Resolution check (for future Growth use): verifies declarations span at least 3 distinct confidence buckets across 10+ declarations, with Spearman rank correlation > 0.3
- [ ] Agents using only 1-2 confidence levels receive calibration score of 0.0 regardless of Brier score
- [ ] Unit tests cover: well-calibrated agent (varied confidence, good correlation), poorly-calibrated agent (always 0.5), gaming agent (always 0.3 with 30% success rate -- fails resolution), insufficient data (< 10 declarations)

**FR references:** FR131
**ADR references:** ADR-015 (Section 15.9)
**Files created/modified:**
- `factory-core/src/performance/confidence.ts` (~80 LOC)
**Estimated LOC:** 80
**Dependencies:** 1.2 (pipeline.db confidence_declarations table), 1.1 (shared-types ConfidenceDeclaration schema)
**MVP/Growth:** MVP

### Story 5.3: Session Composite Aggregation

**Description:** Implement session composite aggregation that runs on story completion, combining action scores, hook pass rates, confidence calibration, and fix-loop contributions into a single per-agent-per-story composite score. Token efficiency uses the bounded step function (no reward for being cheap, penalties only above 3x domain median).

**Acceptance criteria:**
- [ ] On story completion, computes one SessionComposite per agent that participated in the story
- [ ] Composite score is weighted combination of: action_score_mean (from action_scores for this agent+story), hook_pass_rate (hooks passed first attempt / total), confidence_brier (if declarations exist), fix_loop_contributions (count)
- [ ] Token efficiency scoring uses bounded step function: <=2x median = 1.0, >2x-3x = 0.7, >3x = 0.3, >5x = 0.0
- [ ] Domain median computed from action_scores over last 30 stories in same domain; defaults to per-role baseline until 10+ observations
- [ ] Story difficulty estimated from objective metrics (files_modified, test_count, dependency_depth) -- NOT from LLM judgment
- [ ] Writes SessionComposite rows to pipeline.db `session_composites` table with UNIQUE(story_id, agent_id) constraint
- [ ] Unit tests cover: single agent story, multi-agent story, token efficiency boundary values (2x, 3x, 5x median), insufficient historical data (uses defaults), story difficulty computation

**FR references:** FR132
**ADR references:** ADR-015 (Sections 15.4, 15.10)
**Files created/modified:**
- `factory-core/src/performance/session-composite.ts` (~100 LOC)
**Estimated LOC:** 100
**Dependencies:** 5.1 (action scorer provides per-turn scores), 5.2 (confidence tracker provides Brier scores), 1.2 (pipeline.db session_composites table)
**MVP/Growth:** MVP

### Story 5.4: Integration -- Action Scorer Triggered from Performance Middleware afterModel()

**Description:** Replace the performance middleware's action scorer stub (from Story 2.8) with the real action scorer implementation. Wire the afterModel() phase to receive hook results, compute action scores, and persist them to pipeline.db. This completes the data pipeline from hook execution through scoring to storage.

**Acceptance criteria:**
- [ ] Performance middleware afterModel() receives hook results (pass/fail, coverage delta, lint status, type-check status, files modified, tokens consumed, duration)
- [ ] afterModel() calls action scorer with hook results and receives a computed ActionScore
- [ ] ActionScore is written to pipeline.db `action_scores` table
- [ ] End-to-end latency from hook result availability to database write is under 200ms (NFR35)
- [ ] Error in action scoring does not block story completion (middleware error isolation from Story 2.1)
- [ ] Integration test verifies: simulated hook result flows through performance middleware to action_scores table

**FR references:** FR130
**ADR references:** ADR-015 (Section 15.15), ADR-021 (Section 21.4 item #7)
**Files created/modified:**
- `factory-core/src/middleware/performance.ts` (modify -- replace stub with real action scorer call)
**Estimated LOC:** 30
**Dependencies:** 5.1 (action scorer), 2.8 (performance middleware stub to replace)
**MVP/Growth:** MVP

### Story 5.5: Learning Record Extractor

**Description:** Implement the learning record extractor that creates categorized learning records from fix-loop iterations and maintenance agent fixes. Each record is categorized as preventable (overlay should have caught it), unforeseeable (novel issue), or systemic (architecture/tooling gap). Preventable records include the overlay recommendation -- what future overlays should include to prevent recurrence.

**Acceptance criteria:**
- [ ] Extractor creates a LearningRecord from fix-loop data: identifies the gap, the fix applied, affected files, and the domain
- [ ] Category assignment: `preventable` if the gap was a known pattern that an overlay could have warned about, `unforeseeable` if genuinely novel, `systemic` if it points to an architecture or tooling gap
- [ ] For `preventable` records, `overlay_recommendation` field describes what the original overlay should have included
- [ ] Extractor creates LearningRecords from maintenance agent fixes (or CLI-logged manual maintenance in MVP via `qds maintenance log`)
- [ ] Records are written to pipeline.db `learning_records` table with all required fields
- [ ] Confidence defaults to 0.5 for new records, increased by subsequent confirmations
- [ ] Unit tests cover: fix-loop learning extraction (all 3 categories), maintenance fix extraction, overlay recommendation generation, confidence initialization

**FR references:** FR164, FR165
**ADR references:** ADR-015 (Sections 15.5, 15.6, 15.7)
**Files created/modified:**
- `factory-core/src/learning/record-extractor.ts` (~100 LOC)
**Estimated LOC:** 100
**Dependencies:** 1.2 (pipeline.db learning_records table), 1.1 (shared-types LearningRecord schema)
**MVP/Growth:** MVP

### Story 5.6: Overlay Effectiveness Tracker

**Description:** Implement the overlay effectiveness tracker that records which learning records and pattern knowledge items were injected into each story's overlay and correlates this with the story's fix-loop count. This tracks whether injected learnings actually reduce fix-loop rates over time, providing the measurable success metric for the self-learning system.

**Acceptance criteria:**
- [ ] On story completion, tracker records which learning_record IDs were injected into the overlay (from learning middleware beforeModel() metadata)
- [ ] On story completion, tracker records which pattern_knowledge IDs were injected
- [ ] Tracker records the story's fix_loop_count and fix_loop_categories (which categories of issues triggered fix loops)
- [ ] Data is written to pipeline.db `overlay_effectiveness` table
- [ ] Dashboard (Growth) can query this table to show: overlay enrichment depth over time, fix-loop rate correlation with learning injection count
- [ ] Unit tests cover: story with injected learnings and zero fix loops (success), story with injected learnings and fix loops (partial failure), story with no injected learnings (baseline), tracking multiple learning and pattern IDs

**FR references:** FR167, FR168
**ADR references:** ADR-015 (Section 15.6)
**Files created/modified:**
- `factory-core/src/learning/overlay-effectiveness.ts` (~80 LOC)
**Estimated LOC:** 80
**Dependencies:** 5.5 (learning records to track), 2.4 (learning middleware provides injection metadata), 1.2 (pipeline.db overlay_effectiveness table)
**MVP/Growth:** MVP

---

## Epic 6: Economic Governance

**Scope:** Implement per-story and global budget enforcement, atomic task checkout to prevent double-work during multi-story parallelism, the cost data flow from Pi SDK through attribution.db to cumulative budget queries, burn rate prediction for dashboard and notification triggers, and budget breach notifications via the messenger channel.
**Depends on:** Epic 2 (budget middleware provides the beforeModel/afterModel integration points), Epic 1 (attribution.db task_checkouts table, shared-types BurnRateProjection)
**Packages touched:** factory-core, shared-types
**ADR references:** ADR-016 (Sections 16.1, 16.2, 16.3, 16.4, 16.5, 16.6), ADR-005, ADR-022
**Total estimated LOC:** ~450

### Story 6.1: Per-Story Budget Enforcement

**Description:** Implement per-story budget enforcement that checks cumulative cost against the story's configured budget ceiling before spawning each phase's agents. When projected remaining cost exceeds the story budget, the story is paused with developer notification. This replaces the killed per-agent budget system (ECON-002) with a simpler, deadlock-free enforcement model.

**Acceptance criteria:**
- [ ] Before each phase spawn, Factory Core queries `SELECT SUM(cost) FROM cost_events WHERE story_id = ?` in attribution.db
- [ ] If cumulative cost exceeds story budget ceiling (from factory.yaml or story spec), the story is paused with status `budget_paused`
- [ ] If projected remaining cost (using burn rate from cost_so_far / phases_completed * total_phases) exceeds story budget * 0.8, a warning is logged
- [ ] Paused stories do not spawn new phase agents but do not kill in-progress agents
- [ ] Budget check integrates with budget middleware beforeModel() -- middleware calls this enforcer and blocks agent spawn if ceiling exceeded
- [ ] Per-role cost tracking columns in attribution schema remain for visibility but are NOT enforcement boundaries
- [ ] Unit tests cover: story under budget (pass), story at 80% warning threshold, story exceeding budget (pause), budget check with zero cost events (first phase)

**FR references:** FR38, FR142
**ADR references:** ADR-016 (Sections 16.1, 16.4)
**Files created/modified:**
- `factory-core/src/economics/budget-enforcer.ts` (~90 LOC)
**Estimated LOC:** 90
**Dependencies:** 1.3 (attribution.db schema with cost_events table), 2.2 (budget middleware calls this enforcer)
**MVP/Growth:** MVP

### Story 6.2: Global Daily/Monthly Ceiling Enforcement

**Description:** Implement global budget ceiling enforcement that prevents new story starts when the daily or monthly spend total would be exceeded. Active stories continue to completion; only new story starts are blocked. The global ceiling is configured in factory.yaml and checked before each story start.

**Acceptance criteria:**
- [ ] Factory Core queries `SELECT SUM(cost) FROM cost_events WHERE date(created_at) = date('now')` for daily ceiling
- [ ] Factory Core queries `SELECT SUM(cost) FROM cost_events WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')` for monthly ceiling
- [ ] If either ceiling would be exceeded by starting a new story, the story is queued with status `ceiling_blocked`
- [ ] Active stories continue uninterrupted -- ceiling enforcement only gates new story starts
- [ ] When spend drops below ceiling (e.g., new day starts), queued stories are released in priority order
- [ ] Ceiling values are read from frozen factory.yaml config at startup
- [ ] Unit tests cover: daily ceiling not exceeded (pass), daily ceiling exceeded (block), monthly ceiling exceeded (block), active stories continue when ceiling hit, queue drain on new day

**FR references:** FR39
**ADR references:** ADR-016 (Section 16.1)
**Files created/modified:**
- `factory-core/src/economics/ceiling-enforcer.ts` (~80 LOC)
**Estimated LOC:** 80
**Dependencies:** 6.1 (shares cost query patterns), 1.3 (attribution.db), 1.4 (factory.yaml config singleton)
**MVP/Growth:** MVP

### Story 6.3: Atomic Task Checkout via attribution.db

**Description:** Implement atomic task checkout to prevent double-work when multiple stories are active concurrently. Uses SQLite UNIQUE constraint on (story_id, task_id) in the task_checkouts table to guarantee exactly-once task assignment. Integrates with Overstory's Seeds task tracker for task identification.

**Acceptance criteria:**
- [ ] Factory Core writes a `task_checkouts` row in attribution.db with `claimed_at` timestamp when assigning a task
- [ ] SQLite UNIQUE(story_id, task_id) constraint prevents double-claim -- INSERT fails with constraint violation on duplicate
- [ ] On task completion, `completed_at` is set on the checkout row
- [ ] On task failure or timeout, `released_at` is set, making the task available for re-claim
- [ ] Checkout timeout defaults to 2x estimated story duration (configurable)
- [ ] Stale checkouts (claimed but not completed/released beyond timeout) are automatically released on Factory Core startup
- [ ] Unit tests cover: successful checkout, double-claim rejection (constraint violation), task completion update, task release on failure, stale checkout cleanup
- [ ] Note: If multi-process Factory Core instances are introduced (Growth phase), the UNIQUE constraint approach must be revisited in favor of claude-mem's two-phase claim-confirm pattern with `claimed_at` + `confirmed_at` timestamps and timeout-based stale claim release

**FR references:** FR145
**ADR references:** ADR-016 (Section 16.3)
**Files created/modified:**
- `factory-core/src/pipeline/task-checkout.ts` (~90 LOC)
**Estimated LOC:** 90
**Dependencies:** 1.3 (attribution.db task_checkouts table)
**MVP/Growth:** MVP

### Story 6.4: Cost Data Flow -- Pi SDK Usage to Budget Queries

**Description:** Implement the end-to-end cost data flow: Pi SDK Usage callback reports per-call token and cost data, Factory Core writes cost_events to attribution.db, and cumulative queries feed the budget enforcement and dashboard. This is the bridge between Pi SDK's per-call reporting and Factory Core's budget governance.

**Acceptance criteria:**
- [ ] Factory Core registers a callback with Pi SDK that receives Usage { tokens, cost } after each model call
- [ ] Callback writes a cost_events row to attribution.db with full attribution chain: developer_id, story_id, phase, agent_id, model, provider, tokens, cost
- [ ] Calls without complete attribution chains are logged as warnings (FR96 compliance)
- [ ] Cumulative cost queries (SUM by story, SUM by day, SUM by month) are exposed as functions for budget enforcer and dashboard gateway
- [ ] Cost event writes are synchronous (bun:sqlite) and do not block the agent's execution flow
- [ ] Unit tests cover: cost event recording from Pi SDK callback, cumulative query correctness, attribution chain completeness validation, query performance with 1000+ events
- [ ] `cost` field in `cost_events` is populated from Pi SDK's `Usage.cost.total` (pre-computed per-call cost from the provider's pricing), not recomputed from token counts and rate tables. Overstory's `metrics/pricing.ts` is used ONLY for budget projection and historical cost analysis where Pi's real-time cost is unavailable

**FR references:** FR42
**ADR references:** ADR-016 (Section 16.4), ADR-005
**Files created/modified:**
- `factory-core/src/economics/cost-queries.ts` (~80 LOC)
**Estimated LOC:** 80
**Dependencies:** 1.3 (attribution.db schema), 6.1 (budget enforcer consumes these queries)
**MVP/Growth:** MVP

### Story 6.5: Burn Rate Prediction Computation

**Description:** Implement burn rate prediction that projects total story cost based on completed phase cost data. The projection feeds the dashboard's Burn Rate Prediction Panel and triggers notifications when projected cost exceeds budget thresholds.

**Acceptance criteria:**
- [ ] Projection formula: `projected_total_cost = (cost_so_far / phases_completed) * total_phases`
- [ ] `cost_so_far` = SUM of cost_events for the story from attribution.db
- [ ] `phases_completed` = count of completed phases for the story
- [ ] `total_phases` = total configured phases for the story's work type (from factory.yaml)
- [ ] If `projected_total_cost > story_budget * 0.8`, returns a warning-level projection
- [ ] If `projected_total_cost > story_budget`, returns a breach-level projection
- [ ] BurnRateProjection type (from shared-types) includes: storyId, costSoFar, projectedTotal, budget, status ('on_track' | 'warning' | 'breach'), ratePerTurn
- [ ] Unit tests cover: on-track projection, warning threshold crossing, breach projection, projection with only 1 phase completed (early estimate), projection for story with all phases complete

**FR references:** FR146
**ADR references:** ADR-016 (Section 16.5)
**Files created/modified:**
- `factory-core/src/economics/burn-rate.ts` (~60 LOC)
**Estimated LOC:** 60
**Dependencies:** 6.4 (cost queries provide cumulative cost data), 1.1 (shared-types BurnRateProjection)
**MVP/Growth:** MVP

### Story 6.6: Budget Breach Notification via Messenger

**Description:** Implement budget breach notifications that dispatch alerts through the notification channel when a story's budget is exceeded or when global ceilings are hit. Notifications are sent via the MessageBus (Epic 8 dependency) or directly via the existing messenger package if MessageBus is not yet available.

**Acceptance criteria:**
- [ ] When per-story budget is exceeded (story paused), a notification is dispatched with severity 'error', category 'budget', including story ID, cost spent, budget ceiling, and projected total
- [ ] When global daily/monthly ceiling is hit (new stories blocked), a notification is dispatched with severity 'warning', category 'budget', including current spend and ceiling values
- [ ] When burn rate prediction crosses 80% warning threshold, a notification is dispatched with severity 'warning'
- [ ] Notifications include actionable context: which story, how much over, what the developer can do (increase budget, stop story, investigate fix loops)
- [ ] Notification deduplication: budget warnings for the same story are sent at most once per threshold crossing (not every check cycle)
- [ ] Unit tests cover: budget exceeded notification, ceiling hit notification, warning threshold notification, deduplication (no repeated warnings for same threshold)

**FR references:** FR142, FR171
**ADR references:** ADR-016 (Section 16.6), ADR-022
**Files created/modified:**
- `factory-core/src/economics/budget-notifications.ts` (~50 LOC)
**Estimated LOC:** 50
**Dependencies:** 6.1 (budget enforcer triggers notifications), 6.5 (burn rate triggers warnings), 8.1 (MessageBus -- soft dependency; falls back to direct messenger call)
**MVP/Growth:** MVP

---

## Epic 7: Learning System & Epic Context

**Scope:** Build the three-layer learning system and epic-level context management. This includes learning record extraction from fix-loops and maintenance fixes (Layer 1), pattern knowledge mining from cross-story correlations (Layer 2, Growth), epic context tables and assembly for overlay injection, epic context extraction on story completion, and overlay enrichment with learning records via the learning middleware.
**Depends on:** Epic 5 (learning record extractor provides raw learning records; overlay effectiveness tracker measures enrichment impact), Epic 2 (learning middleware provides the injection point)
**Packages touched:** factory-core
**ADR references:** ADR-015 (Sections 15.5, 15.6, 15.7), ADR-021
**Total estimated LOC:** ~640

### Story 7.1: Learning Record Extraction from Fix-Loops

**Description:** Implement the fix-loop learning record extractor that creates categorized learning records whenever a fix-loop iteration resolves a verification gap. Each record captures what went wrong, how it was fixed, and what the original overlay should have included to prevent the issue. This is Layer 1 (Codebase Knowledge) of the learning system.

**Acceptance criteria:**
- [ ] After each fix-loop iteration that resolves a gap, extractor analyzes the diff between pre-fix and post-fix code
- [ ] Extractor assigns category: `preventable` (overlay should have warned), `unforeseeable` (novel issue), `systemic` (architecture gap)
- [ ] For `preventable` records, `overlay_recommendation` describes what future overlays should include
- [ ] Records include: story_id, source='fix_loop', category, domain (file path prefix), files_affected (JSON array), description, fix_applied, overlay_recommendation
- [ ] Records are written to pipeline.db `learning_records` table with confidence defaulting to 0.5
- [ ] Confidence increases by 0.1 (capped at 1.0) each time a subsequent story in the same domain avoids the same issue
- [ ] Unit tests cover: preventable fix extraction, unforeseeable categorization, systemic categorization, overlay recommendation generation, confidence initialization and increment

**FR references:** FR59, FR164
**ADR references:** ADR-015 (Section 15.5, Layer 1)
**Files created/modified:**
- `factory-core/src/learning/fix-loop-extractor.ts` (~100 LOC)
**Estimated LOC:** 100
**Dependencies:** 5.5 (base record-extractor module), 1.2 (pipeline.db learning_records table)
**MVP/Growth:** MVP

### Story 7.2: Learning Record Extraction from Maintenance Agent Fixes

**Description:** Implement learning record extraction from maintenance agent fixes (or CLI-logged manual maintenance in MVP). Every maintenance fix follows the cycle defined in ADR-015 Section 15.7: maintenance discovers issue, fix dispatched through quality pipeline, learning record created on completion. In MVP (before maintenance agents exist), developers can seed the system via `qds maintenance log`.

**Acceptance criteria:**
- [ ] Maintenance fix completion triggers learning record creation with source='maintenance'
- [ ] Category is assigned by analysis: was this preventable by a better overlay, genuinely unforeseeable, or a systemic tooling gap?
- [ ] `overlay_recommendation` for preventable issues describes what the original story's overlay should have included
- [ ] CLI command `qds maintenance log` accepts: file paths affected, fix description, category assignment, and optional overlay recommendation
- [ ] Learning records from maintenance include `story_id` of the story that introduced the issue (when identifiable) as well as `null` story_id for issues not traceable to a specific story
- [ ] Unit tests cover: maintenance learning creation via pipeline completion, CLI-logged maintenance entry, category assignment, link to originating story

**FR references:** FR164
**ADR references:** ADR-015 (Section 15.7)
**Files created/modified:**
- `factory-core/src/learning/maintenance-extractor.ts` (~90 LOC)
**Estimated LOC:** 90
**Dependencies:** 5.5 (base record-extractor), 1.2 (pipeline.db learning_records table)
**MVP/Growth:** MVP

### Story 7.3: Pattern Knowledge Mining (Cross-Story Correlations)

**Description:** Implement the pattern knowledge miner that discovers cross-story correlations from accumulated learning records, BMAD findings, and session composites. Patterns like "87% of stories modifying src/payments/ also need src/webhooks/ updates" are stored with evidence counts and confidence scores. In MVP, mining is triggered manually via the synthesis script; in Growth, it runs as part of the daily meta-optimization observer.

**Acceptance criteria:**
- [ ] Miner analyzes learning_records, session_composites, and action_scores to discover file/module co-modification patterns
- [ ] Discovered patterns are written to pipeline.db `pattern_knowledge` table with: pattern_type, description, evidence_stories (JSON array), observation_count, confidence
- [ ] Confidence is computed from evidence count and recency: more recent, more observations = higher confidence
- [ ] Patterns with evidence_count >= 3 and confidence >= 0.7 are flagged as eligible for overlay injection
- [ ] Patterns decay in confidence over time if not reinforced (configurable decay rate, default 0.05 per 30 days without confirmation)
- [ ] Pattern types include: 'file_correlation', 'test_requirement', 'integration_point'
- [ ] Unit tests cover: pattern discovery from correlated file modifications, confidence computation, evidence count increment on confirmation, confidence decay, eligibility threshold check

**FR references:** FR165
**ADR references:** ADR-015 (Section 15.5, Layer 2)
**Files created/modified:**
- `factory-core/src/learning/pattern-miner.ts` (~120 LOC)
**Estimated LOC:** 120
**Dependencies:** 5.5 (learning records as input), 5.3 (session composites as input), 1.2 (pipeline.db pattern_knowledge table)
**MVP/Growth:** Growth

### Story 7.4: Epic Context Tables in pipeline.db

**Description:** Implement the epic context data layer in pipeline.db. The `epics` table tracks epic metadata and story ordering, while the `epic_context` table stores architectural decisions, integration points, patterns, conventions, learnings, and dependencies extracted from completed stories within each epic.

**Acceptance criteria:**
- [ ] `epics` table stores: id (primary key), name, description, story_ids (JSON array, ordered), status ('active'/'completed'/'paused'), created_at, completed_at
- [ ] `epic_context` table stores: id, epic_id (FK to epics), story_id (which story produced this context), context_type (enum of 6 types), summary, detail, files_affected (JSON array), created_at
- [ ] context_type enum covers: 'architectural_decision', 'integration_point', 'pattern_established', 'convention_adopted', 'learning_extracted', 'dependency_introduced'
- [ ] Index on epic_context(epic_id, story_id) for efficient context assembly queries
- [ ] CRUD functions for creating epics, adding stories to epics, writing context entries, querying context by epic
- [ ] Unit tests cover: epic creation, story association, context entry creation with all 6 types, context query by epic, context query filtered by context_type

**FR references:** FR166
**ADR references:** ADR-015 (Section 15.5), Architecture Section 13 (Epic-Level Context)
**Files created/modified:**
- `factory-core/src/learning/epic-context-store.ts` (~80 LOC)
**Estimated LOC:** 80
**Dependencies:** 1.2 (pipeline.db with epics and epic_context tables from initial migration)
**MVP/Growth:** MVP

### Story 7.5: Epic Context Assembly for Overlay Injection

**Description:** Implement token-budgeted epic context assembly that queries accumulated context from prior stories in the same epic and formats it for injection into the current story's overlay. Context is prioritized by recency and relevance (context touching files that the current story will modify gets priority). Injection happens via the learning middleware's beforeModel() phase.

**Acceptance criteria:**
- [ ] Assembly queries: `SELECT * FROM epic_context WHERE epic_id = ? AND story_id IN (stories 1..N-1) ORDER BY created_at`
- [ ] Context is grouped by context_type and formatted as structured sections (architectural decisions, integration points, patterns, conventions, learnings, dependencies)
- [ ] Token budget for epic context is dynamically allocated from the 50% rule (FR155) -- default 1000 tokens, configurable
- [ ] If accumulated context exceeds token budget, prioritize: (1) context touching files the current story will modify, (2) most recent context, (3) architectural decisions and integration points over conventions
- [ ] Assembly completes within 500ms (NFR39)
- [ ] Assembled context integrates with learning middleware beforeModel() -- learning middleware calls this assembler alongside learning records
- [ ] Unit tests cover: assembly for story 1 (no prior context), assembly for story 5 (accumulated context), token budget truncation, file-relevance prioritization, performance within 500ms for 20-story epic

**FR references:** FR166, FR155
**ADR references:** Architecture Section 13 (Epic Context Assembly), ADR-021
**Files created/modified:**
- `factory-core/src/learning/epic-context-assembler.ts` (~100 LOC)
**Estimated LOC:** 100
**Dependencies:** 7.4 (epic context store provides data), 2.4 (learning middleware provides injection point)
**MVP/Growth:** MVP

### Story 7.6: Epic Context Extraction on Story Completion

**Description:** Implement the epic context extraction pipeline that runs after each story completes within an epic. Extracts architectural decisions, integration points, patterns, and conventions from the story's transfer manifests, learning records, and VERIFICATION.md output, then writes them to the epic_context table.

**Acceptance criteria:**
- [ ] On story completion, extractor reads the story's phase boundary transfer manifests for architectural decisions and integration points
- [ ] Extractor reads the story's learning records (from pipeline.db) for patterns and conventions that emerged
- [ ] Extractor reads the story's VERIFICATION.md (if present) for must_haves patterns that proved effective
- [ ] Extracted context entries are written to epic_context table with the completing story's ID and appropriate context_type
- [ ] Each context entry includes a one-line summary (for overlay injection) and full detail (for drill-down)
- [ ] files_affected is populated from the story's modified file list
- [ ] Unit tests cover: extraction from transfer manifest (architectural decisions), extraction from learning records (patterns), extraction from VERIFICATION.md (conventions), story with no extractable context (empty result)

**FR references:** FR166
**ADR references:** Architecture Section 13 (Epic Context Extraction)
**Files created/modified:**
- `factory-core/src/learning/epic-context-extractor.ts` (~80 LOC)
**Estimated LOC:** 80
**Dependencies:** 7.4 (epic context store for writes), 5.5 (learning records as input)
**MVP/Growth:** MVP

### Story 7.7: Overlay Enrichment with Learning Records (Learning Middleware Integration)

**Description:** Implement the overlay learning enrichment logic that pulls relevant learning records (Layer 1) and pattern knowledge (Layer 2) when assembling agent overlays. Enrichment follows a priority ordering within the Learning stage (Stage 4) token budget: preventable maintenance findings first, then high-confidence pattern knowledge, then general codebase learnings, then cross-story epic learnings. This is the injection logic that the learning middleware's beforeModel() calls.

**Acceptance criteria:**
- [ ] Enrichment queries learning_records matching the story's file scope (domain column matches story's file paths)
- [ ] Enrichment queries pattern_knowledge matching the story's file scope with confidence >= 0.7
- [ ] Priority ordering within token budget: (1) preventable maintenance findings matching file scope, (2) pattern knowledge matching file scope, (3) general codebase learnings matching module/domain, (4) cross-story epic learnings from FR166
- [ ] If token budget is exhausted, lower-priority items are truncated
- [ ] Token budget defaults to ~500 tokens (configurable via factory.yaml), consistent with ADR-021 Section 21.4
- [ ] Enrichment output is formatted as structured text sections ready for overlay injection
- [ ] Applied learning record IDs and pattern knowledge IDs are tracked (for overlay effectiveness reporting via Story 5.6)
- [ ] Unit tests cover: enrichment with all 4 priority levels, token budget truncation at each level, no matching records (empty enrichment), enrichment with pattern knowledge above and below confidence threshold

**FR references:** FR167
**ADR references:** ADR-021, ADR-015 (Section 15.5)
**Files created/modified:**
- `factory-core/src/learning/overlay-enrichment.ts` (~70 LOC)
**Estimated LOC:** 70
**Dependencies:** 7.1 (learning records from fix-loops), 7.2 (learning records from maintenance), 7.3 (pattern knowledge -- soft dependency; works without patterns in MVP), 7.5 (epic context assembly), 2.4 (learning middleware calls this enrichment logic)
**MVP/Growth:** MVP

---

## Epic 8: Notifications & Health Monitoring

**Scope:** Implement the multi-channel notification abstraction (MessageBus, Channel interface, TelegramChannel adapter, WebhookChannel) and the system health circuit breaker with subsystem monitoring and automatic mitigations. The notification system replaces direct EventStore polling with pub/sub distribution. The circuit breaker detects correlated subsystem failures and applies automatic mitigations to prevent cascade failures.
**Depends on:** Epic 1 (shared-types health and notification types, pipeline.db), Epic 2 (hook timeouts adjusted by circuit breaker)
**Packages touched:** factory-core, shared-types, messenger (wrapped, not modified)
**ADR references:** ADR-022 (Sections 22.1-22.7), ADR-023 (Sections 23.1-23.7)
**Total estimated LOC:** ~550

### Story 8.1: Channel Interface and MessageBus Implementation

**Description:** Implement the Channel interface (send, edit, delete, healthCheck) and the MessageBus pub/sub router that replaces duplicate EventStore polling. The MessageBus subscribes once to Factory Core events and distributes them to registered channels based on category and severity matching. This is the foundation for all notification delivery.

**Acceptance criteria:**
- [ ] Channel interface defines: name, enabled, send(message): Promise<Result<string>>, edit(messageId, message): Promise<Result<void>>, delete(messageId): Promise<Result<void>>, healthCheck(): Promise<Result<boolean>>
- [ ] ChannelMessage type includes: id, severity ('info' | 'warning' | 'error' | 'critical'), category (string), title, body, metadata (optional)
- [ ] MessageBus supports: registerChannel(channel, subscription), unregisterChannel(channelName), publish(message), getChannelHealth()
- [ ] Subscription defines: categories (string array), severityMinimum ('info' | 'warning' | 'error' | 'critical')
- [ ] publish() dispatches to all channels whose subscription matches the message's category AND severity >= severityMinimum
- [ ] Channel failures in publish() are caught per-channel -- one failing channel does not block delivery to other channels
- [ ] getChannelHealth() returns Map<string, boolean> with each channel's healthCheck() result
- [ ] Unit tests cover: single channel registration and dispatch, multi-channel dispatch, category filtering, severity filtering, channel failure isolation, health check aggregation

**FR references:** FR171
**ADR references:** ADR-022 (Sections 22.2, 22.3)
**Files created/modified:**
- `factory-core/src/notifications/channel.ts` (~30 LOC)
- `factory-core/src/notifications/message-bus.ts` (~80 LOC)
**Estimated LOC:** 110
**Dependencies:** 1.1 (shared-types ChannelMessage, Subscription types)
**MVP/Growth:** MVP

### Story 8.2: TelegramChannel Adapter

**Description:** Implement the TelegramChannel adapter that wraps the existing messenger package with the Channel interface. All existing Telegram functionality (dual-channel notifications, inbound commands, async dialogue, quiet hours, severity routing) is preserved. The adapter delegates to the messenger package without modifying its internals.

**Acceptance criteria:**
- [ ] TelegramChannel implements Channel interface
- [ ] send() delegates to the existing messenger package's notification sending, formatting ChannelMessage into Telegram MarkdownV2
- [ ] edit() delegates to messenger's message edit capability (if supported; otherwise returns error Result)
- [ ] delete() delegates to messenger's message delete capability
- [ ] healthCheck() checks messenger connectivity (Telegram API reachable)
- [ ] Existing messenger features (quiet hours, severity routing, inline keyboards) are preserved and accessible through the adapter
- [ ] Messenger package internals remain unchanged -- adapter is a thin wrapper
- [ ] Unit tests cover: send delegation, health check pass/fail, ChannelMessage to Telegram format conversion, error handling when messenger is unavailable

**FR references:** FR171
**ADR references:** ADR-022 (Section 22.4), ADR-014
**Files created/modified:**
- `factory-core/src/notifications/channels/telegram-channel.ts` (~60 LOC)
**Estimated LOC:** 60
**Dependencies:** 8.1 (Channel interface), messenger package (existing, not modified)
**MVP/Growth:** MVP

### Story 8.3: Webhook Channel for Generic Extensibility

**Description:** Implement the WebhookChannel that sends notifications to a configurable HTTP endpoint as JSON POST requests. This is the Growth extensibility mechanism allowing integration with Slack, Discord, or custom notification systems via their webhook APIs, without requiring channel-specific adapters.

**Acceptance criteria:**
- [ ] WebhookChannel implements Channel interface
- [ ] send() POSTs ChannelMessage as JSON to the configured webhook URL
- [ ] HTTP response 2xx = success (returns response body as message ID); 4xx/5xx = error Result with status code and response body
- [ ] Configurable timeout (default 5s), retry count (default 2), and retry delay (default 1s)
- [ ] healthCheck() sends a lightweight GET or HEAD request to the webhook URL
- [ ] Webhook URL is configured in factory.yaml `notifications.channels.webhook.url`
- [ ] Severity is mapped to HTTP headers (X-Severity) for downstream filtering
- [ ] Unit tests cover: successful POST, failed POST (timeout, 5xx), retry behavior, health check, disabled channel (returns immediately)

**FR references:** FR171
**ADR references:** ADR-022 (Section 22.5)
**Files created/modified:**
- `factory-core/src/notifications/channels/webhook-channel.ts` (~40 LOC)
**Estimated LOC:** 40
**Dependencies:** 8.1 (Channel interface)
**MVP/Growth:** Growth

### Story 8.4: Notification Routing Configuration in factory.yaml

**Description:** Implement notification routing configuration that maps message categories and severities to channels via factory.yaml. The routing section defines which channels receive which types of notifications, enabling developers to configure notification delivery without code changes.

**Acceptance criteria:**
- [ ] factory.yaml gains `notifications.channels` section with per-channel configuration (telegram: enabled, config; webhook: enabled, url; slack: enabled, webhook_url)
- [ ] factory.yaml gains `notifications.routing` section mapping severity levels to channel lists: critical -> [telegram, slack], error -> [telegram], warning -> [telegram], info -> []
- [ ] Routing config is parsed at startup with Zod validation, frozen with the rest of factory.yaml config
- [ ] MessageBus reads routing config to auto-register channels with appropriate subscriptions
- [ ] Invalid routing config (referencing undefined channels) produces a startup validation error
- [ ] Unit tests cover: valid routing config parsing, invalid channel reference rejection, channel auto-registration from routing config, routing with disabled channels (skipped)

**FR references:** FR171
**ADR references:** ADR-022 (Section 22.6)
**Files created/modified:**
- `factory-core/src/notifications/routing-config.ts` (~40 LOC)
**Estimated LOC:** 40
**Dependencies:** 8.1 (MessageBus), 8.2 (TelegramChannel), 1.4 (factory.yaml config singleton)
**MVP/Growth:** MVP

### Story 8.5: Circuit Breaker State Machine

**Description:** Implement the circuit breaker state machine with three states: CLOSED (healthy), OPEN (degraded), and HALF_OPEN (recovering). The state machine transitions based on error signals from monitored subsystems: 3+ subsystems reporting errors within a 60-second window triggers OPEN state. Recovery probes at configurable intervals transition through HALF_OPEN back to CLOSED.

**Acceptance criteria:**
- [ ] State machine implements CLOSED -> OPEN transition when 3+ subsystems report errors within the error_window_seconds (default 60s)
- [ ] OPEN state pauses new story starts (queues them) and doubles hook/verification timeouts
- [ ] OPEN -> HALF_OPEN transition after check_interval_seconds (default 30s) triggers health probe
- [ ] HALF_OPEN -> CLOSED when error rate is below threshold for recovery_intervals (default 2) consecutive healthy intervals
- [ ] HALF_OPEN -> OPEN if errors persist during health probe
- [ ] CLOSED state restores original timeout values and drains queued stories
- [ ] All state transitions are logged to events.db as health_state events
- [ ] State transitions trigger notification via MessageBus (severity 'critical' for OPEN, 'info' for CLOSED recovery)
- [ ] Configuration from factory.yaml health.circuit_breaker section: error_window_seconds, error_threshold, check_interval_seconds, recovery_intervals, timeout_multiplier
- [ ] Circuit breaker state is persisted to `pipeline.db` on SIGTERM shutdown (called by orchestration loop's shutdown handler, Story 4.0). On Factory Core restart, circuit breaker state is restored from `pipeline.db` — if the last persisted state was OPEN, the circuit breaker resumes in OPEN and begins recovery probes immediately (ADR-024 Sections 4, 7)
- [ ] Unit tests cover: CLOSED->OPEN transition, OPEN->HALF_OPEN probe, HALF_OPEN->CLOSED recovery, HALF_OPEN->OPEN persistence, timeout doubling during OPEN, story queue during OPEN, queue drain on CLOSED, state persistence on shutdown, state restoration on restart

**FR references:** FR170
**ADR references:** ADR-023 (Sections 23.2, 23.5), ADR-024 (Sections 4, 7)
**Files created/modified:**
- `factory-core/src/health/circuit-breaker.ts` (~140 LOC)
**Estimated LOC:** 140
**Dependencies:** 8.1 (MessageBus for notifications), 1.4 (factory.yaml config), 1.2 (pipeline.db for state persistence)
**MVP/Growth:** MVP

### Story 8.6: Subsystem Health Monitor (7 Monitored Subsystems)

**Description:** Implement the subsystem health monitor that collects error signals from each of the 7 monitored subsystems and feeds them to the circuit breaker. Each subsystem reports errors via a unified interface; the monitor aggregates and tracks error windows for the circuit breaker's trigger logic.

**Acceptance criteria:**
- [ ] Monitor tracks 7 subsystems: Overstory sessions, Overstory mail, pipeline.db, attribution.db, Gate scripts, Pi SDK calls, Filesystem
- [ ] Each subsystem reports errors via `reportError(subsystem: string, error: Error)` method
- [ ] Monitor tracks error counts per subsystem within a sliding window (error_window_seconds)
- [ ] When 3+ distinct subsystems have errors within the window, monitor triggers the circuit breaker to OPEN
- [ ] Health probe (during HALF_OPEN) checks each subsystem: SQLite write latency for DB subsystems, file I/O latency for filesystem, API response time for Pi SDK
- [ ] Probe results feed back to circuit breaker for recovery decisions
- [ ] Unit tests cover: single subsystem error (no trigger), 3+ subsystem errors (trigger), error window expiry (old errors fall out), health probe with all subsystems healthy, health probe with persistent failures

**FR references:** FR170
**ADR references:** ADR-023 (Section 23.2)
**Files created/modified:**
- `factory-core/src/health/subsystem-monitor.ts` (~80 LOC)
**Estimated LOC:** 80
**Dependencies:** 8.5 (circuit breaker consumes error signals)
**MVP/Growth:** MVP

### Story 8.7: Automatic Mitigations

**Description:** Implement the automatic mitigations that the circuit breaker applies during OPEN state: pause new story starts (queue them), double hook/verification timeouts, increase Pi SDK inter-call delay. On recovery (CLOSED), restore all original values and drain the story queue.

**Acceptance criteria:**
- [ ] During OPEN: new story start requests are queued with status `health_paused` (not rejected)
- [ ] During OPEN: all hook timeouts are multiplied by timeout_multiplier (default 2.0) via runtime-only override (NOT factory.yaml mutation)
- [ ] During OPEN: all verification timeouts are similarly multiplied
- [ ] During OPEN: Pi SDK inter-call delay is increased by 2x (mitigates rate limit compound failures)
- [ ] On recovery (CLOSED): original timeout values are restored from factory.yaml frozen config
- [ ] On recovery: queued stories are drained in priority order (one at a time, with configurable drain_interval)
- [ ] Runtime timeout overrides are in-memory only -- never persisted to factory.yaml or pipeline.db
- [ ] Unit tests cover: timeout doubling during OPEN, timeout restoration on CLOSED, story queue during OPEN, story drain on recovery, Pi SDK delay increase

**FR references:** FR170
**ADR references:** ADR-023 (Section 23.3)
**Files created/modified:**
- `factory-core/src/health/mitigations.ts` (~60 LOC)
**Estimated LOC:** 60
**Dependencies:** 8.5 (circuit breaker triggers mitigations), 8.6 (subsystem monitor provides health data)
**MVP/Growth:** MVP

### Story 8.8: Health State Events in events.db

**Description:** Implement health state event logging that records all circuit breaker state transitions, subsystem error reports, and recovery events in Overstory's events.db. These events feed the dashboard's System Health Indicator and provide historical health data.

**Acceptance criteria:**
- [ ] Circuit breaker state transitions (CLOSED->OPEN, OPEN->HALF_OPEN, HALF_OPEN->CLOSED, HALF_OPEN->OPEN) are logged to events.db as 'health_state' event type
- [ ] Each event includes: timestamp, previous state, new state, affected subsystems, trigger reason
- [ ] Subsystem error reports are logged as 'subsystem_error' events with subsystem name and error details
- [ ] Recovery events include: recovery duration (time spent in OPEN+HALF_OPEN), stories paused count, stories drained count
- [ ] Events can be queried by time range for the dashboard health history display
- [ ] Unit tests cover: state transition event logging, subsystem error event logging, recovery event with metrics, event query by time range

**FR references:** FR170
**ADR references:** ADR-023 (Section 23.7)
**Files created/modified:**
- `factory-core/src/health/health-events.ts` (~40 LOC)
**Estimated LOC:** 40
**Dependencies:** 8.5 (circuit breaker produces state transitions), 8.6 (subsystem monitor produces error events), 1.6 (Overstory schema extensions for health_state event type)
**MVP/Growth:** MVP

---

## Epic 9: Dashboard Extensions

**Scope:** Extend the dashboard with revised performance views (empty states, tier transitions, trends, error states, loading states), the Learning Effectiveness Panel, Burn Rate Prediction Panel, System Health Indicator, Epic Progress View, revised copilot interactions with 7 new capabilities, AmbientHeader updates, and the bottom drawer with tab switching.
**Depends on:** Epic 5 (performance data for dashboard display), Epic 6 (burn rate data), Epic 7 (learning records and epic context data), Epic 8 (health state data, notification channel status)
**Packages touched:** dashboard
**ADR references:** ADR-015, ADR-016, ADR-022, ADR-023
**Total estimated LOC:** ~1,220

### Story 9.0: ZeroClaw Carry-Forward Adaptation

**Description:** Copy the 6 ZeroClaw carry-forward files (per ADR-001) and perform the 4 required adaptations to make them compatible with the QDS Factory dashboard. This is the prerequisite setup story for all Epic 9 dashboard stories. Also establishes the Gateway as a self-contained HTTP service with configurable port binding, health/readiness endpoints, and structured access logging per twelve-factor principles.

**Acceptance criteria:**
- [ ] 6 files copied from ZeroClaw: `index.html`, `vite.config.ts`, `tsconfig.json`, `tsconfig.app.json`, `src/lib/sse.ts`, `src/lib/ws.ts`
- [ ] Type contract replacement: all ZeroClaw-specific type imports (`ZeroClawEvent`, `ZeroClawCommand`, etc.) replaced with QDS shared-types event/command contracts from `shared-types/`
- [ ] Auth token mechanism: WebSocket auth token path changed from `zeroclaw` config to `.qds/ws-token` per Factory Core's credential management
- [ ] WS subprotocol: renamed from `zeroclaw.v1` to `qds.v1` in `ws.ts` WebSocket constructor
- [ ] SSE base path: changed from `/_app/` to `/events` (or gateway-configured path) in `sse.ts` fetch URL construction
- [ ] Gateway binds to `factory.yaml` `gateway.port` (default `3001`) and `gateway.host` (default `0.0.0.0` inside Docker, `127.0.0.1` bare metal). Overridable via `QDS_GATEWAY__PORT` and `QDS_GATEWAY__HOST` env vars (ADR-024 Section 5)
- [ ] Gateway startup logs: `Gateway listening on http://{host}:{port}` (ADR-024 Section 5)
- [ ] `/health` endpoint returns `{ status: "ok", version: "x.y.z", uptime_ms: N }` for Docker readiness/liveness probes. Returns 200 when the gateway process is alive (ADR-024 Section 5)
- [ ] `/ready` endpoint returns 200 only after database migrations complete and the orchestration loop is running. Returns 503 with `{ status: "starting" }` during initialization. This distinguishes "process alive" from "system fully initialized" (ADR-024 Section 5)
- [ ] Gateway is self-contained — exports its service via port binding, not via shared memory or filesystem IPC. All dashboard communication goes through gateway (SSE, WS, REST) (ADR-024 Section 5)
- [ ] Gateway access logs written to stdout as NDJSON: `method`, `path`, `status`, `latency_ms` per request (ADR-024 Section 9)
- [ ] All adapted files compile with zero type errors against QDS shared-types
- [ ] Unit tests verify: SSE client connects to correct base path, WS client uses correct subprotocol, type contracts match shared-types definitions, `/health` returns correct JSON, `/ready` returns 503 before initialization and 200 after, gateway binds to configured port

**FR references:** FR43, FR44
**ADR references:** ADR-001, ADR-009, ADR-024 (Sections 5, 9)
**Files created/modified:**
- `dashboard/src/lib/sse.ts` (~186 LOC, adapted)
- `dashboard/src/lib/ws.ts` (~146 LOC, adapted)
- `dashboard/index.html` (copied)
- `dashboard/vite.config.ts` (copied)
- `dashboard/tsconfig.json` (copied)
- `dashboard/tsconfig.app.json` (copied)
- `factory-core/src/gateway/health.ts` (~30 LOC, new)
**Estimated LOC:** 50 (changes to existing files + health endpoints; ~332 LOC copied)
**Dependencies:** 1.1 (shared-types for type contracts), 1.4 (Factory Core config for gateway port/host)
**MVP/Growth:** MVP

### Story 9.1: Revised Performance Dashboard

**Description:** Revise the Performance Dashboard with proper empty state guidance (progressive ghost cards showing what data will appear), tier transition visuals (Growth placeholder), historical performance trends with sparklines, fix-loop rate and maintenance rate displays, error states with the four-line structure (what happened, impact, system response, developer action), and loading states during ELO recalculation.

**Acceptance criteria:**
- [ ] Empty state guidance: when no performance data exists, show progressive ghost cards with description text explaining what each metric will show and what triggers data collection
- [ ] Overview tab shows: action score distributions, hook pass rates, session composite trends as sparklines
- [ ] Trends tab shows: fix-loop rate over time (line chart), maintenance rate over time, codebase heatmap (file areas with most issues)
- [ ] Error states use four-line structure: "What happened" (technical detail), "Impact" (user-facing consequence), "System response" (what the system did), "Developer action" (what the developer should do, if anything)
- [ ] Loading states during ELO recalculation (Growth): stale data indicators with inline spinners, non-blocking recalculation
- [ ] Time range selector: [7d] [30d] [90d] [All] segmented control
- [ ] Unit tests cover: empty state rendering, data-populated rendering, error state rendering, time range switching

**FR references:** FR139
**ADR references:** ADR-015 (Section 15.2)
**Files created/modified:**
- `dashboard/src/views/PerformanceOverview.tsx` (~200 LOC)
**Estimated LOC:** 200
**Dependencies:** 9.0 (ZeroClaw carry-forward adaptation), 5.1 (action scores data), 5.3 (session composites data), gateway SSE events for performance data
**MVP/Growth:** MVP (structure and data display); Growth (tier transitions, ELO charts)

### Story 9.2: Learning Effectiveness Panel

**Description:** Implement the Learning Effectiveness Panel in the bottom drawer's "Learning" tab. Includes the Maintenance Burden Trend chart (stacked area chart with 3 categories: preventable, systemic, unforeseeable), Learning Records Feed (filterable list with status dots, impact tracking), and Overlay Enrichment Depth chart (learning records injected per story over time).

**Acceptance criteria:**
- [ ] Panel renders in the bottom drawer when "Learning" tab is selected
- [ ] Maintenance Burden Trend: stacked area chart with 3 categories using correct colors (red/amber/gray at 40% opacity), 5-story rolling average trend line, time range selector
- [ ] Annotation below chart: "Learning system is converging" (green) when preventable is declining, "Systemic fixes increasing" (amber) when systemic is rising
- [ ] Learning Records Feed: 20 records per page with "Load more" pagination, each record shows status dot (green/blue/amber/red), title, source, metadata, application count, impact
- [ ] Feed filters: area filter (dropdown from codebase directory tree), type filter (fix-loop/maintenance/review/cross-story), impact filter (proven effective/measuring/too early/ineffective)
- [ ] Overlay Enrichment Depth: bar chart showing learning records injected per story, trend line showing enrichment depth increasing
- [ ] Unit tests cover: empty state rendering, chart with data, filter application, pagination

**FR references:** FR165, FR167, FR168
**ADR references:** ADR-015 (Section 15.5)
**Files created/modified:**
- `dashboard/src/components/learning/LearningEffectivenessPanel.tsx` (~180 LOC)
**Estimated LOC:** 180
**Dependencies:** 7.1 (learning records data via gateway), 7.7 (overlay enrichment data), 9.8 (bottom drawer shell)
**MVP/Growth:** MVP

### Story 9.3: Burn Rate Prediction Panel

**Description:** Implement the Burn Rate Prediction Panel in the bottom drawer's "Economics" tab. Shows per-story burn rate cards for active stories with projected cost, budget utilization progress bars, and status indicators. Includes the historical cost trend chart with scatter plot and trend line. Toggle between Active (burn rate cards) and History (cost trend + table).

**Acceptance criteria:**
- [ ] Panel renders in the bottom drawer when "Economics" tab is selected
- [ ] Per-story burn rate cards show: story header, phase/turn line, cost summary (spent/projected/budget in monospace), progress bar (green < 60%, amber 60-90%, red > 90%), rate per turn, status label
- [ ] Progress bar extends beyond 100% for over-budget stories (overflow section in red at 30% opacity, clipped at 150%)
- [ ] Projected breach alert: left border accent at 80% threshold (amber), 100% (red)
- [ ] Historical cost trend: scatter plot with 6px data points, linear regression trend line, trailing average label
- [ ] Annotation: "cost declining -- system learning reduces rework" (green) or "cost stable/rising" (amber)
- [ ] Active/History toggle via segmented control in panel header
- [ ] Unit tests cover: burn rate card rendering (on track, warning, breach), progress bar overflow, historical trend chart, toggle between views

**FR references:** FR146
**ADR references:** ADR-016 (Section 16.5)
**Files created/modified:**
- `dashboard/src/components/economics/BurnRatePanel.tsx` (~150 LOC)
**Estimated LOC:** 150
**Dependencies:** 6.5 (burn rate projection data via gateway), 9.8 (bottom drawer shell)
**MVP/Growth:** MVP (structure); Growth (full cost attribution dashboard FR146)

### Story 9.4: System Health Indicator

**Description:** Implement the System Health Indicator as a badge in the AmbientHeader with an expandable detail panel. The badge shows green/amber/red states. Clicking opens a dropdown panel showing subsystem statuses, uptime percentages, issue descriptions, and circuit breaker state. Accessibility requirements include role="status" and aria-live="assertive".

**Acceptance criteria:**
- [ ] Health badge renders as 32px circle in AmbientHeader: green (all operational, subtle 30s pulse), amber (1-2 degraded, static), red (circuit breaker active, continuous 3s pulse)
- [ ] prefers-reduced-motion: no pulse animations
- [ ] Tooltip on hover (300ms delay): describes current state and affected subsystems
- [ ] Click opens expandable detail panel (200ms slide-down) showing 7 subsystem statuses with dots and uptime percentages
- [ ] Green state: compact list of subsystems with green dots and uptime percentages
- [ ] Amber state: affected subsystem expanded with issue description (four-line structure), healthy subsystems compact
- [ ] Red state: "NEW STORIES PAUSED" header, affected subsystems expanded with full detail, circuit breaker info, auto-recovery status
- [ ] Close panel: click X, click outside, or Escape key
- [ ] Accessibility: role="status", aria-live="assertive", subsystem list uses semantic HTML
- [ ] Time range toggle [7d] [30d] for uptime display
- [ ] Unit tests cover: green/amber/red badge rendering, detail panel open/close, subsystem list rendering, accessibility attributes

**FR references:** FR170
**ADR references:** ADR-023 (Sections 23.4, 23.6)
**Files created/modified:**
- `dashboard/src/components/health/SystemHealthBadge.tsx` (~80 LOC)
- `dashboard/src/components/health/SystemHealthDetail.tsx` (~100 LOC)
**Estimated LOC:** 180
**Dependencies:** 8.5 (circuit breaker state data via gateway), 8.8 (health events for history)
**MVP/Growth:** MVP

### Story 9.5: Epic Progress View

**Description:** Implement the Epic Progress View with two sub-views: Epic List (/epics) showing all epics with progress bars, cost, and learning metrics; and Epic Detail (/epic/:id) showing the Gantt-style story timeline, epic economics, and epic learning summary. Accessible from navigation bar, story card breadcrumbs, and copilot.

**Acceptance criteria:**
- [ ] Epic List view (/epics): full-width epic cards with title, status badge (IN PROGRESS/COMPLETED/PENDING), progress bar, story count, cost spent, learning records count
- [ ] Click epic card navigates to Epic Detail view
- [ ] Epic Detail view (/epic/:id): back navigation, epic header with title, progress summary, learning summary
- [ ] Story Timeline (Gantt-style): horizontal bars per story, color-coded by status (green completed, blue in-progress, elevated pending), dependency lines between stories
- [ ] Story bars show: start position, completion/progress width, cost label, status label
- [ ] Fix-loop stories show amber fill with striped pattern
- [ ] Bar hover tooltip: full story title, duration, cost, current phase, fix-loop count
- [ ] Bar click: navigates to story detail in main dashboard
- [ ] Epic Economics section: total spent, projected total, budget, utilization progress bar
- [ ] Epic Learning section: learning records count, applied-to count, cross-epic pollination count
- [ ] "View learning records" link navigates to Learning Effectiveness Panel pre-filtered to the epic
- [ ] Navigation bar gains "Epics" link after "Performance Overview"
- [ ] Unit tests cover: epic list rendering, epic detail rendering, Gantt timeline, dependency lines, status colors

**FR references:** FR166
**ADR references:** Architecture Section 13 (Epic-Level Context)
**Files created/modified:**
- `dashboard/src/views/EpicListView.tsx` (~80 LOC)
- `dashboard/src/views/EpicDetailView.tsx` (~120 LOC)
**Estimated LOC:** 200
**Dependencies:** 7.4 (epic data via gateway), 7.5 (epic context data), 9.2 (Learning Panel for cross-navigation)
**MVP/Growth:** MVP

### Story 9.6: Revised Copilot Interactions (7 New Capabilities)

**Description:** Implement the 7 new copilot action categories from the Session 8 UX amendments: Learning Effectiveness Panel actions (openLearningPanel, filterLearningRecords, showPatternKnowledge), Economics Panel actions (openEconomicsPanel, showBurnRate, showCostTrend), Performance Trends actions (openPerformanceTrends, setTimeRange, filterByCodebaseArea), System Health actions (openHealthDetail, showSubsystemStatus), Epic actions (navigateToEpic, navigateToEpics), and investigation helpers (traceLearningGap, queryCodebaseKnowledge, projectStoryCost).

**Acceptance criteria:**
- [ ] Each action follows existing copilot orchestration pattern: 300ms between navigation steps, visual highlighting, abort on failure with error report
- [ ] Learning actions: openLearningPanel opens bottom drawer to Learning tab, filterLearningRecords applies area filter, showPatternKnowledge switches to pattern view
- [ ] Economics actions: openEconomicsPanel opens bottom drawer to Economics tab, showBurnRate expands specific story's burn rate card, showCostTrend switches to History view
- [ ] Performance actions: openPerformanceTrends switches to Trends tab, setTimeRange applies time filter, filterByCodebaseArea applies path filter to heatmap
- [ ] Health actions: openHealthDetail opens health detail panel, showSubsystemStatus highlights specific subsystem
- [ ] Epic actions: navigateToEpic opens specific epic detail view, navigateToEpics opens epic list
- [ ] Investigation helpers: traceLearningGap returns LearningGapAnalysis for a story, queryCodebaseKnowledge returns PatternMatch[] for a file path, projectStoryCost returns CostProjection for a story
- [ ] All actions registered via useCopilotAction hooks in CopilotBridge
- [ ] Unit tests cover: each action category invocation, investigation helper data return, navigation state changes

**FR references:** FR165, FR166, FR167, FR168, FR170, FR171
**ADR references:** ADR-011, ADR-015, ADR-016, ADR-022, ADR-023
**Files created/modified:**
- `dashboard/src/copilot/actions/learning.ts` (~60 LOC)
- `dashboard/src/copilot/actions/economics.ts` (~40 LOC)
- `dashboard/src/copilot/actions/health.ts` (~30 LOC)
**Estimated LOC:** 130
**Dependencies:** 9.2 (Learning Panel to navigate to), 9.3 (Burn Rate Panel), 9.4 (Health Indicator), 9.5 (Epic views)
**MVP/Growth:** MVP

### Story 9.7: AmbientHeader Updates

**Description:** Update the AmbientHeader component to include the System Health Badge (from Story 9.4) and the Maintenance Trend Sparkline. The revised AmbientHeader content: status color tint overlay, system health badge, 3 vitals numbers (active/shipped/cost), maintenance trend sparkline, Active Experiment text, co-dev indicator.

**Acceptance criteria:**
- [ ] Health badge positioned left of factory vitals numbers with 16px horizontal margin
- [ ] MaintenanceSparkline renders as 60x20px line chart of last 20 stories' maintenance fix counts
- [ ] Sparkline stroke color by trend: declining (status-green), flat (text-secondary), rising (status-amber)
- [ ] Sparkline fill: same color at 10% opacity below line
- [ ] Sparkline tooltip on hover: "Maintenance trend: X.X fixes/story avg (last 20 stories). [Declining/Flat/Rising]"
- [ ] If fewer than 5 stories completed, sparkline replaced with "..." in text-muted
- [ ] Sparkline accessibility: role="img", aria-label describing trend direction and average
- [ ] AmbientHeader layout: [status tint] [health badge] [vitals numbers] [maintenance sparkline] [experiment text] [co-dev indicator]
- [ ] Unit tests cover: header with health badge (all 3 states), sparkline with declining/flat/rising trends, sparkline with insufficient data, full header layout

**FR references:** FR168, FR170
**ADR references:** ADR-023 (Section 23.4)
**Files created/modified:**
- `dashboard/src/components/layout/AmbientHeader.tsx` (~60 LOC, modified)
**Estimated LOC:** 60
**Dependencies:** 9.4 (SystemHealthBadge component), 7.1 (maintenance data for sparkline via gateway)
**MVP/Growth:** MVP

### Story 9.8: Bottom Drawer with Tab Switching

**Description:** Implement the BottomDrawer component that houses the Learning Effectiveness Panel and Burn Rate Panel behind a tab interface. The drawer is collapsed by default (40px tab bar visible), expands on tab click (400px, resizable 280-600px), and remains open across story card interactions. Two independent scroll regions: story card grid above, drawer content below.

**Acceptance criteria:**
- [ ] Collapsed state: 40px tab bar visible at bottom of viewport with "Learning" and "Economics" tabs
- [ ] Click tab: drawer slides up to 400px (320ms ease-out), pushing story card grid up
- [ ] Drawer height resizable via drag handle (range 280-600px), preference persisted in localStorage
- [ ] Collapse: click active tab again, press Escape (if no higher-priority element is open), or drag handle to minimum
- [ ] Drawer remains open when story cards are expanded/collapsed (independent interaction)
- [ ] Two independent scroll regions: story card grid scrolls above drawer, drawer content scrolls independently
- [ ] Tab bar: role="tablist" with role="tab" per tab and aria-selected, role="tabpanel" for content
- [ ] Drawer: role="complementary", aria-label="Analysis panels"
- [ ] Unit tests cover: tab switching, drawer expand/collapse, height persistence, scroll independence, keyboard interaction (Escape)

**FR references:** FR165, FR167, FR168
**ADR references:** None (UX-only component)
**Files created/modified:**
- `dashboard/src/components/layout/BottomDrawer.tsx` (~100 LOC)
**Estimated LOC:** 100
**Dependencies:** None (shell component; panels plug in via children)
**MVP/Growth:** MVP

---

## Epic 10: Growth Phase -- Behavioral Effects

**Scope:** Implement all Growth-phase behavioral effects from the performance and learning system: ELO domain rating computation, tier evaluation with hysteresis, tier demotion logic, performance-based task routing with exploration factor, random audit mechanism, anti-gaming protections, ELO migration strategy, Channel Status panel, and automated pattern knowledge mining. ALL stories in this epic are Growth phase.
**Depends on:** Epic 5 (performance data collection layers 1-3 provide the data foundation), Epic 7 (learning records for pattern mining), Epic 8 (notification channels for Channel Status)
**Packages touched:** factory-core, dashboard
**ADR references:** ADR-015 (Sections 15.4, 15.8, 15.9, 15.11, 15.12, 15.13, 15.14), ADR-022 (Section 22.5)
**Total estimated LOC:** ~730

### Story 10.1: ELO Domain Rating Computation

**Description:** Implement ELO-style domain rating computation from session composites. Each agent gets a per-domain ELO rating starting at 1200.0 with deviation 350.0. After each story completion, the ELO rating is updated based on the session composite score versus expected performance (derived from rating and story difficulty). K-factor is adjusted by rating deviation (higher uncertainty = larger adjustments).

**Acceptance criteria:**
- [ ] ELO computation reads session_composites for the completing story from pipeline.db
- [ ] Rating update uses standard ELO formula: new_rating = old_rating + K * (actual - expected)
- [ ] Expected score derived from rating difference and story difficulty
- [ ] K-factor scaled by rating_deviation: higher deviation (newer agents) = larger K for faster convergence
- [ ] rating_deviation decreases after each game (story) by a configurable factor
- [ ] games_played increments on each story completion
- [ ] Updated rating written to pipeline.db `elo_ratings` table with agent_id, domain, rating, rating_deviation, games_played, epoch
- [ ] Domain is derived from story's primary file scope (e.g., "payments", "auth", "infrastructure")
- [ ] Unit tests cover: initial rating (1200, deviation 350), rating increase after good session, rating decrease after poor session, K-factor scaling with deviation, multiple domains per agent

**FR references:** FR133
**ADR references:** ADR-015 (Section 15.4)
**Files created/modified:**
- `factory-core/src/performance/elo.ts` (~100 LOC)
**Estimated LOC:** 100
**Dependencies:** 5.3 (session composites provide input data), 1.2 (pipeline.db elo_ratings table)
**MVP/Growth:** Growth

### Story 10.2: Tier Evaluation with 50-Point Hysteresis and 3-Story Dwell

**Description:** Implement tier evaluation that assigns agents to capability tiers (1-5) based on ELO rating thresholds. Tier transitions use a 50-point hysteresis buffer and 3-story dwell requirement to prevent thrashing. An agent oscillating between 1300 and 1350 stays at current tier; only sustained performance triggers transitions.

**Acceptance criteria:**
- [ ] Tier thresholds are configurable (default: T1=0, T2=1100, T3=1350, T4=1500, T5=1700)
- [ ] Promotion requires: ELO >= tier_threshold AND 3+ stories completed at current tier (dwell requirement)
- [ ] Promotion writes new tier_assignments row with reason='promotion', previous_tier, stories_at_tier reset to 0
- [ ] Agent between promotion threshold and demotion threshold (hysteresis band) stays at current tier
- [ ] stories_at_tier counter increments on each story completion at the current tier
- [ ] Tier evaluation runs after each ELO update (triggered by story completion)
- [ ] Tier assignment history preserved in tier_assignments table for audit
- [ ] Unit tests cover: promotion from T1 to T2 (ELO + dwell met), promotion blocked by dwell requirement (ELO met but < 3 stories), hysteresis band (no transition), tier evaluation with multiple domains

**FR references:** FR134
**ADR references:** ADR-015 (Section 15.8)
**Files created/modified:**
- `factory-core/src/performance/tiers.ts` (~90 LOC)
**Estimated LOC:** 90
**Dependencies:** 10.1 (ELO ratings provide input), 2.9 (TierResolver for tier-to-model mapping)
**MVP/Growth:** Growth

### Story 10.3: Tier Demotion Logic

**Description:** Implement tier demotion that triggers when an agent's ELO drops below (tier_threshold - 50) for 3 consecutive story completions. Demotion prevents the "promote and forget" failure mode. Demotion is logged with previous tier, new tier, ELO trajectory, and triggering stories.

**Acceptance criteria:**
- [ ] Demotion trigger: ELO < (current_tier_threshold - 50) for 3 consecutive stories in the same domain
- [ ] Demotion writes new tier_assignments row with reason='demotion', previous_tier, stories_at_tier reset to 0
- [ ] Demotion is logged with: previous tier, new tier, ELO trajectory (last 5 ratings), triggering story IDs
- [ ] Consecutive demotion counter tracks stories below demotion threshold; resets if a story is above threshold
- [ ] Demotion notification dispatched via MessageBus (severity 'warning', category 'performance')
- [ ] Unit tests cover: demotion after 3 consecutive below-threshold stories, counter reset on above-threshold story, demotion from T3 to T2, demotion from T2 to T1, notification dispatch

**FR references:** FR161
**ADR references:** ADR-015 (Section 15.8)
**Files created/modified:**
- `factory-core/src/performance/demotion.ts` (~70 LOC)
**Estimated LOC:** 70
**Dependencies:** 10.1 (ELO ratings), 10.2 (tier thresholds and dwell counter), 8.1 (MessageBus for notifications)
**MVP/Growth:** Growth

### Story 10.4: Performance-Based Task Routing with 15% Exploration

**Description:** Implement task routing that uses weighted composite scores (from session composites and ELO ratings) to match stories to agents, with a 15% exploration factor that randomly assigns agents regardless of rating. Exploration prevents domain specialization collapse where agents only receive work they are already good at.

**Acceptance criteria:**
- [ ] 85% of routing decisions use ELO-weighted scoring: agents ranked by domain ELO rating for the story's primary domain
- [ ] 15% of routing decisions use random agent selection (configurable via factory.yaml `performance.exploration_factor`)
- [ ] Routing considers only agents with relevant capabilities for the story's requirements
- [ ] Agent's own tier is NOT injected into the agent's overlay (PERV-011 anti-gaming protection)
- [ ] Routing decision is logged with: selected agent, ELO rating, exploration flag, alternative agents considered
- [ ] Unit tests cover: ELO-based routing (highest-rated agent selected), exploration routing (random selection), exploration factor configuration, tier not injected into overlay, routing with no rated agents (fallback to random)

**FR references:** FR138
**ADR references:** ADR-015 (Section 15.12)
**Files created/modified:**
- `factory-core/src/performance/router.ts` (~80 LOC)
**Estimated LOC:** 80
**Dependencies:** 10.1 (ELO ratings for scoring), 10.2 (tier assignments for capabilities)
**MVP/Growth:** Growth

### Story 10.5: Random Audit Mechanism (1 in 3 Stories for Tier 3+)

**Description:** Implement the random audit mechanism where 1 in N stories (default N=3) for agents at Tier 3 or above receives full Tier 1 hook density regardless of the agent's current tier. Audit results are scored with elevated weight (1.5x) in ELO computation. Selection uses deterministic randomization (story_id hash) for reproducibility.

**Acceptance criteria:**
- [ ] Audit frequency configurable via factory.yaml `performance.audit_frequency` (default: 3, meaning 1 in 3)
- [ ] Eligibility: agents at Tier 3 or above
- [ ] Audit selection: deterministic using story_id hash -- `hash(story_id) % audit_frequency === 0`
- [ ] Audited stories run with full Tier 1 hook density (every edit, every task, every phase boundary)
- [ ] Audit story results scored with elevated weight (configurable, default 1.5x) in ELO computation
- [ ] Audit flag stored in story metadata (pipeline.db) for reporting
- [ ] If audit reveals quality issues (hook failures at density that would have been skipped at agent's tier), feeds into demotion evaluation
- [ ] Unit tests cover: audit selection determinism, Tier 2 agent not eligible, Tier 3 agent eligible, Tier 1 hook density enforcement, 1.5x ELO weight application

**FR references:** FR169
**ADR references:** ADR-015 (Section 15.11)
**Files created/modified:**
- `factory-core/src/performance/audit.ts` (~60 LOC)
**Estimated LOC:** 60
**Dependencies:** 10.1 (ELO computation for weighted scoring), 10.2 (tier assignments for eligibility)
**MVP/Growth:** Growth

### Story 10.6: Anti-Gaming Protections

**Description:** Implement the anti-gaming protections that prevent agents from manipulating the performance system: no self-tier injection into overlays, immutable scoring weights (require developer approval to change), anchored difficulty estimation from objective metrics (not LLM judgment), and bounded token efficiency scoring.

**Acceptance criteria:**
- [ ] Agent's own tier level is NOT present in the agent's overlay -- verified by overlay composition code that explicitly excludes tier data
- [ ] Scoring weights in factory.yaml `performance.scoring_weights` are frozen at startup and cannot be modified by meta-optimization (FR79-FR83)
- [ ] Story difficulty estimated from objective metrics: files_modified, test_count, dependency_depth, lines_changed -- NOT from LLM-generated difficulty estimates
- [ ] Token efficiency scoring uses bounded step function: <= 2x median = 1.0, > 2x <= 3x median = 0.7, > 3x median = 0.3, > 5x median = 0.0
- [ ] Domain median computed from action_scores over last 30 stories; default to per-role baseline until 10+ observations
- [ ] Unit tests cover: tier exclusion from overlay, scoring weight immutability check, objective difficulty estimation, token efficiency at each threshold boundary, domain median computation with sufficient and insufficient data

**FR references:** FR130, FR133
**ADR references:** ADR-015 (Sections 15.10, 15.12)
**Files created/modified:**
- `factory-core/src/performance/anti-gaming.ts` (~80 LOC)
**Estimated LOC:** 80
**Dependencies:** 10.1 (ELO system), 5.1 (action scores for domain median)
**MVP/Growth:** Growth

### Story 10.7: ELO Migration Strategy (Versioned Rating Epochs)

**Description:** Implement versioned rating epochs that handle scoring algorithm changes gracefully. When the algorithm changes, a new epoch is created with carried-forward ratings at inflated uncertainty. Old epoch data is preserved for historical analysis. Migration is automatic on Factory Core startup.

**Acceptance criteria:**
- [ ] Algorithm changes create a new `rating_epochs` entry with incremented epoch, algorithm_version, and migration_notes
- [ ] Old ratings carry forward into new epoch as initial estimates with rating_deviation inflated to 200 (not full 350)
- [ ] New epoch ELO calculations start from carried-forward ratings
- [ ] Old epoch data preserved in elo_ratings table filtered by epoch for historical analysis
- [ ] Migration is automatic on Factory Core startup when algorithm_version in code differs from latest epoch's algorithm_version
- [ ] K-factor doubled for first 5 stories in new epoch (accelerated re-calibration)
- [ ] Unit tests cover: automatic epoch creation on version mismatch, rating carry-forward with inflated deviation, old data preservation, K-factor doubling for first 5 stories, no migration when versions match

**FR references:** FR162
**ADR references:** ADR-015 (Section 15.14)
**Files created/modified:**
- `factory-core/src/performance/epoch-migration.ts` (~80 LOC)
**Estimated LOC:** 80
**Dependencies:** 10.1 (ELO computation), 1.2 (pipeline.db rating_epochs table)
**MVP/Growth:** Growth

### Story 10.8: Channel Status Panel

**Description:** Implement the Channel Status Panel that displays notification channel health and routing configuration. Shows each configured channel with connection status, last message time, error count, and routing rules. Accessible from the System Health detail panel as an expandable subsection.

**Acceptance criteria:**
- [ ] Panel shows each configured channel: name, connection status (green/yellow/red/gray dot), last message timestamp, error count (last 24h)
- [ ] Routing rules displayed per severity level: which channels receive critical, error, warning, info messages
- [ ] Status dots: Connected (green), Degraded (yellow), Disconnected (red), Not configured (gray)
- [ ] Panel accessible from System Health detail panel as expandable subsection (click "Channel details" link)
- [ ] Channel health data from MessageBus.getChannelHealth() via gateway
- [ ] Accessibility: channel status dots use aria-label, list uses semantic ul with role="list"
- [ ] Unit tests cover: channel list rendering with various states, routing rules display, empty state (no channels configured), accessibility attributes

**FR references:** FR171
**ADR references:** ADR-022 (Section 22.5)
**Files created/modified:**
- `dashboard/src/components/health/ChannelStatusPanel.tsx` (~80 LOC)
**Estimated LOC:** 80
**Dependencies:** 8.1 (MessageBus health data via gateway), 9.4 (System Health detail panel hosts this)
**MVP/Growth:** Growth

### Story 10.9: Automated Pattern Knowledge Mining

**Description:** Implement the automated pattern miner that runs as part of the daily meta-optimization observer (FR77). Unlike the MVP manual synthesis script extension (Story 7.3), this miner runs automatically, discovers new patterns from the latest story data, and updates pattern confidence scores. This is the Growth automation of Layer 2 learning.

**Acceptance criteria:**
- [ ] Miner triggers daily via the meta-optimization observer schedule (FR77)
- [ ] Analyzes all stories completed since last mining run
- [ ] Discovers new file-correlation patterns, test-requirement patterns, and integration-point patterns
- [ ] Updates existing pattern confidence: increments observation_count and updates last_confirmed for reinforced patterns
- [ ] Decrements confidence for patterns contradicted by new data (sets last_contradicted)
- [ ] Mining results logged for dashboard display (new patterns discovered, patterns reinforced, patterns weakened)
- [ ] Unit tests cover: daily trigger, new pattern discovery, existing pattern reinforcement, pattern contradiction handling, mining with no new data (no-op)

**FR references:** FR165
**ADR references:** ADR-015 (Section 15.5, Layer 2)
**Files created/modified:**
- `factory-core/src/learning/automated-pattern-miner.ts` (~90 LOC)
**Estimated LOC:** 90
**Dependencies:** 7.3 (base pattern miner logic), 5.3 (session composites as input)
**MVP/Growth:** Growth

---

## Growth Stories: Twelve-Factor Operational Maturity (Post-MVP)

These stories extend the twelve-factor alignment established in ADR-024 but are not required for MVP. They improve operational maturity for production deployments.

### Growth Story: Unified Log Aggregation

**Description:** `qds logs` CLI command that tails Factory Core stdout + Overstory per-agent NDJSON log files in a unified, chronologically-sorted stream. Supports `--story <id>` filtering to show only log lines with a matching `story_id` correlation field, and `--component <name>` filtering.

**ADR reference:** ADR-024 Section 9

### Growth Story: Overstory Environment Variable Layer

**Description:** Add `OVERSTORY_` prefix environment variable overrides to Overstory's `config.yaml` loading. This is a fork modification to Overstory that brings its configuration mechanism into twelve-factor alignment. Example: `OVERSTORY_DATABASES__SESSIONS_PATH` overrides the sessions database path.

**ADR reference:** ADR-024 Sections 1, 2

### Growth Story: Export/Backup/Restore

**Description:** `qds export` (pipeline data as JSON for analysis), `qds backup` (SQLite `.backup` API wrapper for all 6 databases — atomic, consistent), `qds restore` (restore databases from backup files). All commands follow the admin process pattern (ADR-024 Section 10) — same runtime, same config, exit after completion.

**ADR reference:** ADR-024 Section 10

### Growth Story: CI Pipeline

**Description:** GitHub Actions (or equivalent) workflow: build multi-arch Docker image (`linux/amd64` + `linux/arm64`), run test suite inside container, push tagged image to container registry. Staging environment uses `FAIL_ON_MISSING_SECRETS=true` for secret validation.

**ADR reference:** ADR-024 Sections 3, 8

### Growth Story: Docker Volume Management

**Description:** `qds volumes backup` (export named volume data), `qds volumes prune` (remove orphaned volumes with confirmation), named volume lifecycle documentation. Ensures SQLite data on Docker volumes is properly managed across container updates.

**ADR reference:** ADR-024 Section 2

---

## FR Coverage Matrix

| FR | Story | Status |
|----|-------|--------|
| FR1-FR9 | Pre-existing | Pre-existing (Overstory pipeline) |
| FR10-FR20 | Pre-existing | Pre-existing (Overstory hooks/BMAD/QA) |
| FR21-FR22 | Pre-existing | Pre-existing (Overstory agent orchestration) |
| FR23 | 1.6 | Covered |
| FR24-FR27 | Pre-existing | Pre-existing (Overstory agent orchestration) |
| FR28-FR35 | Pre-existing | Pre-existing (Overlay/context management) |
| FR36 | 2.3, 2.9 | Covered |
| FR37 | 2.3 | Covered |
| FR38 | 6.1 | Covered |
| FR39 | 6.2 | Covered |
| FR40 | Pre-existing | Pre-existing (Worktree management) |
| FR41 | 2.9 | Covered |
| FR42 | 6.4 | Covered |
| FR43-FR44 | 9.0 + Pre-existing | Covered |
| FR45-FR50 | Pre-existing | Pre-existing (Dashboard/observability) |
| FR51-FR54 | Pre-existing | Pre-existing (Git/PR operations) |
| FR55-FR56 | Pre-existing | Pre-existing (Learning system foundation) |
| FR57 | 1.6 | Covered |
| FR58 | Pre-existing | Pre-existing (Learning system foundation) |
| FR59 | 7.1 | Covered |
| FR60-FR63 | Pre-existing | Pre-existing (Learning synthesis/injection) |
| FR64-FR68 | Pre-existing | Pre-existing (Memory/knowledge) |
| FR69-FR72 | Pre-existing | Pre-existing (Developer operations) |
| FR73-FR76 | Pre-existing | Pre-existing (Operational safety) |
| FR77-FR89 | Pre-existing | Pre-existing (Meta-optimization) |
| FR90 | Pre-existing | Pre-existing (PR-to-Seeds) |
| FR91-FR104 | Pre-existing | Pre-existing (Resilience/integrity) |
| FR105-FR119 | Pre-existing | Pre-existing (Dashboard copilot) |
| FR120-FR129 | Pre-existing | Pre-existing (Developer communication/Telegram) |
| FR130 | 5.1 | Covered |
| FR131 | 5.2 | Covered |
| FR132 | 5.3 | Covered |
| FR133 | 10.1 | Growth |
| FR134 | 10.2 | Growth |
| FR135 | 10.2 | Growth |
| FR136 | N/A | Killed (ECON-001) |
| FR136-R | 10.4 | Growth |
| FR137 | 10.4 | Growth |
| FR138 | 10.4 | Growth |
| FR139 | 9.1 | Covered |
| FR140 | 5.1 | Covered |
| FR141 | 10.2 | Growth |
| FR142 | 6.1 | Covered |
| FR143 | N/A | Growth (deferred) |
| FR144 | N/A | Growth (deferred) |
| FR145 | 6.3 | Covered |
| FR146 | 9.3 | Growth |
| FR147 | N/A | Growth (deferred) |
| FR148 | 4.5 | Covered |
| FR149 | 4.1, 4.2, 4.3, 4.4 | Covered |
| FR150 | N/A | Growth (deferred) |
| FR151 | N/A | Growth (deferred) |
| FR152 | 3.2, 3.3 | Covered |
| FR153 | 3.4 | Growth |
| FR154 | N/A | Growth (deferred) |
| FR155 | 7.5 | Covered |
| FR156 | N/A | Growth (deferred) |
| FR157 | N/A | Growth (deferred) |
| FR158 | N/A | Growth (deferred) |
| FR159 | N/A | Growth (deferred) |
| FR160 | N/A | Growth (deferred) |
| FR161 | 10.3 | Growth |
| FR162 | 10.7 | Growth |
| FR163 | 3.6 | Covered |
| FR164 | 5.5, 7.2 | Covered |
| FR165 | 7.3, 10.9 | Covered (MVP manual + Growth automated) |
| FR166 | 7.4, 7.5, 7.6 | Covered |
| FR167 | 7.7 | Covered |
| FR168 | 5.6, 9.7 | Covered |
| FR169 | 10.5 | Growth |
| FR170 | 8.5, 8.6, 8.7, 8.8, 9.4 | Covered |
| FR171 | 8.1, 8.2, 8.3, 8.4, 10.8 | Covered |

## ADR Exercise Matrix

| ADR | Exercising Stories | Scope |
|-----|-------------------|-------|
| ADR-001 | Pre-existing (Dashboard React/Vite), 9.0 | Pre-existing + Epic 9 |
| ADR-002 | Pre-existing (Pipeline engine), 4.0, 4.1, 4.5 | Pre-existing + Epic 4 |
| ADR-003 | Pre-existing (Phase management) | Pre-existing |
| ADR-004 | Pre-existing (Context management), 7.5 | Pre-existing + Epic 7 |
| ADR-005 | 6.1, 6.2, 6.4 | Epic 6 |
| ADR-006 | Pre-existing (Phase boundary), 1.6, 3.5 | Pre-existing + Epics 1, 3 |
| ADR-007 | Pre-existing (Context isolation) | Pre-existing |
| ADR-008 | Pre-existing (Credentials), 2.3 | Pre-existing + Epic 2 |
| ADR-009 | Pre-existing (Gateway SSE/WS) | Pre-existing |
| ADR-010 | Pre-existing (Hooks), 1.6, 3.3, 5.4 | Pre-existing + Epics 1, 3, 5 |
| ADR-011 | Pre-existing (CopilotKit), 9.6 | Pre-existing + Epic 9 |
| ADR-012 | Pre-existing (Testing strategy) | Pre-existing |
| ADR-013 | Pre-existing (Superpowers), 2.5, 2.6 | Pre-existing + Epic 2 |
| ADR-014 | Pre-existing (Telegram), 8.2 | Pre-existing + Epic 8 |
| ADR-015 | 1.1, 1.2, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 7.1, 7.2, 7.3, 7.7, 9.1, 9.2, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.9 | Epics 1, 5, 7, 9, 10 |
| ADR-016 | 1.3, 6.1, 6.2, 6.3, 6.4, 6.5, 9.3 | Epics 1, 6, 9 |
| ADR-017 | 1.1, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6 | Epics 1, 3 |
| ADR-018 | 4.5, 4.6, 4.7, 8.7 | Epics 4, 8 |
| ADR-019 | 1.1, 1.2, 4.1, 4.2, 4.3, 4.4 | Epics 1, 4 |
| ADR-020 | 1.2, 1.3 | Epic 1 |
| ADR-021 | 1.1, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 7.5, 7.7 | Epics 1, 2, 7 |
| ADR-022 | 1.1, 6.6, 8.1, 8.2, 8.3, 8.4, 10.8 | Epics 1, 6, 8, 10 |
| ADR-023 | 1.1, 1.6, 8.5, 8.6, 8.7, 8.8, 9.4, 9.7 | Epics 1, 8, 9 |
| ADR-024 | 1.4, 1.4b, 1.4c, 1.6, 4.0, 8.5, 9.0 | Epics 1, 4, 8, 9 |

---

*v2.1 — Session 11 twelve-factor alignment. ADR-024 added (10 sections: env-var overrides, backing services, build/release/run, stateless processes, port binding, concurrency, disposability, dev/prod parity, logging, admin processes). 2 new stories added (1.4b Build & Containerization, 1.4c Admin CLI). 5 stories amended (1.4, 1.6, 4.0, 8.5, 9.0). Growth stories section added (5 post-MVP operational maturity stories). Epic 1 LOC updated (670→1,310). 10 epics, ~66 stories, implementation-ready with zero ambiguity.*
