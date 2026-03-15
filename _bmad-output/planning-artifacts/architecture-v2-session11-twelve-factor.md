# Architecture v2.0 — Session 11 Twelve-Factor Alignment

**Date:** 2026-03-15
**Scope:** ADR-024 (10 sections), 5 story amendments, 2 new stories, growth stories backlog
**Applies to:** `_bmad-output/planning-artifacts/architecture-v2.md` v2.0, `_bmad-output/implementation-artifacts/epics-and-stories.md` v2.0
**Methodology:** Twelve-Factor App (https://12factor.net) applied to QDS Factory as a web application with SSE/WebSocket streaming, Docker containerization, and multi-architecture support.

---

## ADR-024: Twelve-Factor Operational Conventions

**Status:** ACCEPTED
**Context:** QDS Factory is a web application — a persistent browser tab with SSE/WebSocket streaming, 12 concurrent agent terminal panels, and full CRUD controls for stories, agents, and factory operations. The development team (2 developers: Steve on macOS ARM/Apple Silicon, Marcus on macOS Intel) requires cross-architecture parity from day one. Docker containerization is required for CI reproducibility and dev/prod consistency. The Docker strategy copies the proven pattern from the `rfp-agents` project.

**Decision:** Adopt the Twelve-Factor App methodology across all QDS Factory components, with Docker as the canonical runtime environment and bare-metal as a convenience for local development.

---

### Section 1: Environment Variable Override Convention

**Twelve-Factor Principle:** III. Config — Store config in the environment.

**Convention:**

All `factory.yaml` configuration values are overridable via environment variables using the `QDS_` prefix with `__` (double underscore) as the nesting separator.

**Mapping examples:**

| `factory.yaml` path | Environment variable | Default |
|---------------------|---------------------|---------|
| `gateway.port` | `QDS_GATEWAY__PORT` | `3001` |
| `gateway.host` | `QDS_GATEWAY__HOST` | `127.0.0.1` (bare metal) / `0.0.0.0` (Docker) |
| `databases.pipeline_path` | `QDS_PIPELINE_DB_PATH` | `.qds/pipeline.db` |
| `databases.attribution_path` | `QDS_ATTRIBUTION_DB_PATH` | `.qds/attribution.db` |
| `pipeline.max_concurrent_stories` | `QDS_PIPELINE__MAX_CONCURRENT_STORIES` | `3` |
| `health.circuit_breaker.error_window_seconds` | `QDS_HEALTH__CIRCUIT_BREAKER__ERROR_WINDOW_SECONDS` | `60` |
| `log_level` | `QDS_LOG_LEVEL` | `info` |

**Priority order (highest wins):**

1. Environment variables (`QDS_*`)
2. `factory.yaml` (user-specific local config)
3. Hardcoded defaults in Zod schema

**Implementation rule:** `applyEnvOverrides()` walks `process.env` for all `QDS_` prefixed variables, converts `__` to object nesting, and merges the result after YAML parse but before Zod validation. This ensures env-var values are still type-checked.

**Credential-specific variables:**

API keys MUST be injectable via env vars (`QDS_ANTHROPIC_API_KEY`, `QDS_OPENAI_API_KEY`, etc.) and SHOULD NOT appear in `factory.yaml` in CI/shared environments. In Docker, credentials are injected via the `.env` file (gitignored) or CI secret manager — never baked into images or tracked config files.

**Exercised by:** Story 1.4 (Factory Core Process Skeleton)

---

### Section 2: Backing Service Addressability

**Twelve-Factor Principle:** IV. Backing Services — Treat backing services as attached resources.

**Convention:**

All backing services (SQLite databases, LLM providers, Telegram API, webhook endpoints, gateway port) are attached resources addressable via configuration. Swapping a backing service requires only a config change, never a code change.

**SQLite databases:**

| Database | Config key | Env var override | Default path |
|----------|-----------|-----------------|-------------|
| `pipeline.db` | `databases.pipeline_path` | `QDS_PIPELINE_DB_PATH` | `.qds/pipeline.db` |
| `attribution.db` | `databases.attribution_path` | `QDS_ATTRIBUTION_DB_PATH` | `.qds/attribution.db` |
| `sessions.db` | Overstory config | Read from Overstory's `loadConfig()` | `.overstory/sessions.db` |
| `mail.db` | Overstory config | Read from Overstory's `loadConfig()` | `.overstory/mail.db` |
| `events.db` | Overstory config | Read from Overstory's `loadConfig()` | `.overstory/events.db` |
| `metrics.db` | Overstory config | Read from Overstory's `loadConfig()` | `.overstory/metrics.db` |

**Docker volume strategy:** SQLite databases live on mounted named volumes (not inside the container image). Container destruction does not lose data.

| Named volume | Mount point | Contains |
|-------------|-------------|----------|
| `qds-pipeline-data` | `/app/.qds` | `pipeline.db`, `attribution.db` |
| `qds-overstory-data` | `/app/.overstory` | `sessions.db`, `mail.db`, `events.db`, `metrics.db` |

**LLM providers:** Already properly abstracted via Pi SDK's `getApiKey` callback (ADR-008). Provider endpoints are configurable via Pi SDK's model configuration. No changes needed.

**Exercised by:** Stories 1.4 (configurable DB paths), 1.6 (Overstory DB path reading), 1.4b (Docker volumes)

---

### Section 3: Build/Release/Run Convention

**Twelve-Factor Principle:** V. Build, release, run — Strictly separate build and run stages.

**Convention:**

- **Build:** `docker build` (multi-stage) OR `qds build` (local bare-metal). Produces a Docker image or local compiled output.
- **Release:** Git tag + multi-arch Docker image push (`linux/amd64` + `linux/arm64`) + GitHub Release.
- **Run:** `./scripts/compose.sh development up` (Docker) OR `qds start` (bare-metal convenience).

**Docker image is the canonical release artifact.** Bare-metal `qds start` is a convenience for development iteration speed.

**Docker pattern (from rfp-agents):**

```text
docker/
  docker-compose.yml          # Base compose (profiles: backing-services, backend, frontend)
  docker-compose.dev.yml      # Dev overrides (volume mounts, hot reload, fast healthchecks)
  .env.development            # Docker-specific dev overrides (git-tracked, NO secrets)
  .env.staging                # Docker-specific staging overrides (git-tracked, NO secrets)
  .env.production             # Docker-specific prod overrides (git-tracked, NO secrets)
factory-core/
  Dockerfile                  # Multi-stage: deps -> builder -> runtime (oven/bun:debian)
dashboard/
  Dockerfile                  # Multi-stage: deps -> builder -> runner (node:20-slim)
  Dockerfile.dev              # Dev with hot reload (Vite HMR)
scripts/
  compose.sh                  # Environment-aware wrapper (copy from rfp-agents)
.env.example                  # Base defaults + placeholders (git-tracked, SSOT)
.env                          # Local developer secrets (gitignored)
Makefile                      # Convenience targets
```

**Image decisions:**

- **Debian-based images, NOT Alpine.** `oven/bun:debian` for Factory Core/Gateway, `node:20-slim` for Dashboard. Alpine's musl libc has native binary compatibility issues on ARM64 (confirmed with Tailwind oxide in rfp-agents). Debian (glibc) works on both ARM64 and AMD64.
- **Digest-pinned base images** for reproducible builds across architectures.
- **Non-root users** in all runtime stages.

**Profile-based composition:**

| Profile | Services started | Use case |
|---------|-----------------|----------|
| `--profile backing-services` | tmux daemon only | Bare-metal dev against Docker agent host |
| `--profile backend` | Factory Core + Gateway | API development, no dashboard |
| `--profile frontend` | Factory Core + Gateway + Dashboard | Full stack |

**`scripts/compose.sh` wrapper — 3-layer env file priority:**

1. `.env.example` (base defaults, git-tracked, lowest priority)
2. `.env` (local secrets — API keys, credentials, gitignored)
3. `docker/.env.{environment}` (Docker-specific overrides — service URLs, ports, git-tracked, NO secrets, highest priority)

**Secret management:** Secrets live in `.env` (gitignored) or CI secret manager. Docker overlay files (`docker/.env.*`) are git-tracked and MUST NOT contain secrets. `FAIL_ON_MISSING_SECRETS=true` in CI/staging rejects startup when required secrets are missing or still placeholder values.

**Makefile targets:**

| Target | Action |
|--------|--------|
| `make up` | Start infrastructure |
| `make dev` | Start all services with hot reload |
| `make down` | Stop all services |
| `make logs` | Follow logs |
| `make build` | Build all images |
| `make clean` | Stop and remove volumes (with confirmation) |

**Exercised by:** Story 1.4b (Build & Containerization)

---

### Section 4: Stateless Processes

**Twelve-Factor Principle:** VI. Processes — Execute the app as one or more stateless processes.

**Convention:**

Factory Core is restartable. All canonical state lives in SQLite (on mounted volumes in Docker). In-memory state is a performance cache, reconstructed on startup from persisted data.

**Specific in-memory state and its reconstruction:**

| In-memory state | Reconstruction source | Story |
|----------------|----------------------|-------|
| Running story map | `pipeline.db` `stories` table (status='active') | 4.0 |
| Turn continuation state | `pipeline.db` `turn_state` table | 4.3 |
| Circuit breaker state | `pipeline.db` circuit breaker checkpoint | 8.5 |
| Middleware chain | `factory.yaml` config (rebuilt on startup) | 2.1 |
| Budget accumulators | `attribution.db` (recomputed from cost_events) | 2.2 |

Docker containers can be stopped and restarted without data loss — SQLite databases persist on mounted volumes.

**Exercised by:** Stories 4.0 (orchestration loop restart), 4.3 (turn state persistence), 8.5 (circuit breaker persistence)

---

### Section 5: Port Binding

**Twelve-Factor Principle:** VII. Port binding — Export services via port binding.

**Convention:**

Gateway is the single HTTP entry point. It is a self-contained service that exports its functionality via port binding, not via shared memory or filesystem IPC.

**Gateway endpoints:**

| Endpoint | Protocol | Purpose |
|----------|----------|---------|
| `/events` | SSE | Dashboard subscribes for real-time state updates |
| `/ws` | WebSocket | Dashboard sends commands, receives responses |
| `/api/copilotkit` | HTTP POST | AI copilot runtime |
| `/health` | HTTP GET | Readiness/liveness probe: `{ status: "ok", version: "x.y.z", uptime_ms: N }` |
| `/ready` | HTTP GET | Returns 200 only after migrations complete and orchestration loop is running |
| `/*` | HTTP GET | Static assets (React dashboard build output, production only) |

**Configuration:**

| Setting | Config key | Env var | Default (bare metal) | Default (Docker) |
|---------|-----------|---------|---------------------|-----------------|
| Port | `gateway.port` | `QDS_GATEWAY__PORT` | `3001` | `3001` |
| Host | `gateway.host` | `QDS_GATEWAY__HOST` | `127.0.0.1` | `0.0.0.0` |

**Startup log:** `Gateway listening on http://{host}:{port}`

**Docker:** `EXPOSE ${QDS_GATEWAY__PORT}` in Dockerfile, compose maps container port to host port.

**Health + readiness endpoints** serve Docker healthcheck (`CMD ["curl", "-f", "http://localhost:3001/health"]`) and orchestrator probes. `/ready` distinguishes between "process is alive" and "system is fully initialized."

**Exercised by:** Story 9.0 (ZeroClaw Carry-Forward Adaptation)

---

### Section 6: Concurrency

**Twelve-Factor Principle:** VIII. Concurrency — Scale out via the process model.

**Convention:**

QDS Factory uses process-based concurrency with three process types:

| Process type | Implementation | Scaling | Count |
|-------------|----------------|---------|-------|
| `coordinator` | Factory Core orchestration loop | Single instance per compose service | 1 |
| `web` | Gateway serving HTTP/SSE/WS | Subprocess of coordinator (same container) | 1 |
| `worker` | Agent processes spawned by Overstory via tmux | 1-15 concurrent (configurable via `pipeline.max_concurrent_stories`) | 1-15 |

For MVP, all three process types run in the same Docker container. The coordinator manages agent lifecycle via Overstory's tmux-based spawning. This is sufficient for the 2-developer team.

**Growth scaling path:** Split `coordinator` and `worker` into separate containers communicating via SQLite WAL on a shared volume or migrate to PostgreSQL for true multi-container scaling.

**Exercised by:** Stories 4.0 (orchestration loop), 9.0 (gateway), Overstory (agent spawning)

---

### Section 7: Disposability Contract

**Twelve-Factor Principle:** IX. Disposability — Maximize robustness with fast startup and graceful shutdown.

**Convention:**

| Metric | Target | Rationale |
|--------|--------|-----------|
| Startup time | < 2 seconds | Config load -> migration check -> DB open -> gateway bind -> loop start |
| Shutdown time | < 10 seconds | Matches Docker's default SIGTERM->SIGKILL timeout |
| Docker `stop_grace_period` | `15s` | Allows graceful drain with 5s buffer |

**SIGTERM/SIGINT shutdown sequence:**

1. Stop accepting new stories (set orchestration loop flag)
2. Close WebSocket connections with close code `1001` ("going away")
3. Flush SSE buffers (send pending events)
4. Checkpoint in-progress state to `turn_state` table
5. Persist circuit breaker state to `pipeline.db`
6. Close database connections (WAL checkpoint)
7. Exit 0

**Startup sequence:**

1. Load `factory.yaml` + apply env-var overrides
2. Validate config via Zod schema
3. Check system dependencies (git >= 2.30, bun >= 1.0, tmux >= 3.0) — fail fast with actionable errors
4. Open/create SQLite databases with WAL mode
5. Run migrations (Factory Core's sequential runner for `pipeline.db`/`attribution.db`)
6. Bind gateway to configured port
7. Start orchestration loop
8. Log startup diagnostics

**Docker healthcheck:** `CMD ["curl", "-f", "http://localhost:3001/health"]` with `interval: 30s`, `timeout: 5s`, `retries: 3`, `start_period: 10s`.

**Exercised by:** Stories 4.0 (orchestration loop lifecycle), 8.5 (circuit breaker persistence), 1.4b (Docker healthcheck)

---

### Section 8: Dev/Prod Parity

**Twelve-Factor Principle:** X. Dev/prod parity — Keep development, staging, and production as similar as possible.

**Convention:**

**Docker image is the canonical runtime environment.** Debian-based (glibc), same image on ARM64 (Steve/Apple Silicon) and AMD64 (Marcus/Intel, CI).

Development and production differ only in env var values, never in code paths. Database migrations run identically in both environments (same SQLite version inside container).

**Three environments (matching rfp-agents pattern):**

| Environment | Command | Characteristics |
|-------------|---------|----------------|
| Dev | `./scripts/compose.sh development up` | With `docker-compose.dev.yml` overlay: volume mounts for hot reload, debug ports, faster healthcheck intervals, verbose logging |
| CI/Staging | `./scripts/compose.sh staging up` | Production-like with extra logging, `FAIL_ON_MISSING_SECRETS=true` |
| Production | `./scripts/compose.sh production up` | Minimal, secure, performance-optimized |

**Config hierarchy (rfp-agents proven pattern):**

| Layer | File | Git-tracked | Contains secrets | Priority |
|-------|------|-------------|-----------------|----------|
| 1 | `.env.example` | Yes | No — safe placeholders | Lowest |
| 2 | `.env` | No (gitignored) | Yes — developer-specific API keys | Middle |
| 3 | `docker/.env.{environment}` | Yes | No — service URLs, ports, feature flags | Highest |

**Secret validation:** `FAIL_ON_MISSING_SECRETS=true` in CI/staging rejects startup when required secrets (API keys) are missing or still contain placeholder values from `.env.example`.

**Exercised by:** Stories 1.4 (`factory.yaml.example`), 1.4b (Docker multi-arch), 1.4c (`qds doctor`)

---

### Section 9: Logging Convention

**Twelve-Factor Principle:** XI. Logs — Treat logs as event streams.

**Convention:**

Factory Core and Gateway log to stdout as NDJSON (one JSON object per line). Logs are event streams — the process never routes or stores its own log output.

**Log line schema:**

```json
{
  "timestamp": "2026-03-15T10:30:00.000Z",
  "level": "info",
  "component": "factory-core",
  "story_id": "story-42",
  "phase": "dev",
  "agent_id": "builder-1",
  "turn_number": 3,
  "message": "Turn completed, checklist at 85%"
}
```

**Required fields:** `timestamp`, `level`, `component`, `message`
**Correlation fields (when applicable):** `story_id`, `phase`, `agent_id`, `turn_number`

**Components:**

| Component value | Source |
|----------------|--------|
| `factory-core` | Orchestration loop, middleware chain, pipeline logic |
| `gateway` | HTTP requests, SSE connections, WebSocket events |
| `agent` | Per-agent log lines (via Overstory) |

**Log levels:** Controlled by `QDS_LOG_LEVEL` env var (default: `info`). Values: `debug`, `info`, `warn`, `error`.

**Gateway access logs:** NDJSON with `method`, `path`, `status`, `latency_ms`.

**Overstory per-agent file logging:** Preserved (serves agent-level debugging via xterm.js terminal panels in dashboard). Overstory's existing NDJSON + human log file pattern is not changed.

**Docker:** `docker compose logs -f` captures all stdout — no log file management needed inside containers. Log drivers (json-file, fluentd, etc.) configurable via compose for CI/production aggregation.

**Growth:** `qds logs` CLI that tails Factory Core stdout + Overstory agent NDJSON in a unified, chronologically-sorted stream with `--story <id>` filtering.

**Exercised by:** Stories 1.4 (NDJSON logger), 4.0 (correlation IDs)

---

### Section 10: Admin Processes

**Twelve-Factor Principle:** XII. Admin processes — Run admin/management tasks as one-off processes.

**Convention:**

Admin commands run as one-off processes using the same codebase, same config loading, and same runtime as the long-running Factory Core process. They exit after completion.

**Admin commands:**

| Command | Purpose | Docker equivalent |
|---------|---------|------------------|
| `qds doctor` | Health check: DB integrity, config validation, Overstory connectivity, system deps, gateway port availability | `docker compose exec factory qds doctor` |
| `qds migrate` | Run database migrations without starting orchestration loop | `docker compose run --rm factory qds migrate` |
| `qds config validate` | Validate `factory.yaml` against Zod schema, report errors | `docker compose run --rm factory qds config validate` |
| `qds config show` | Display resolved config (with env-var overrides applied, secrets redacted) | `docker compose run --rm factory qds config show` |
| `qds init` | Copy `factory.yaml.example` -> `.qds/factory.yaml` if missing, create `.qds/` directory | N/A (host-only) |

**Key principle:** Admin commands run inside the same container image as the application. `docker compose exec` runs against a running container; `docker compose run --rm` spins up a fresh container for the command and removes it after.

**Growth admin commands:**

| Command | Purpose |
|---------|---------|
| `qds export` | Export pipeline data as JSON |
| `qds backup` | SQLite `.backup` wrapper for all databases |
| `qds restore` | Restore databases from backup |
| `qds logs` | Unified log tailing with correlation filtering |

**Exercised by:** Story 1.4c (Admin CLI)

---

## Twelve-Factor Coverage Summary

| Factor | Status | Primary Story/ADR Section |
|--------|--------|--------------------------|
| I. Codebase | ALIGNED | No changes needed — polyfarm with independent repos |
| II. Dependencies | ALIGNED | Story 1.4 (system dep checks) |
| III. Config | RESOLVED | ADR-024 Section 1, Story 1.4 |
| IV. Backing Services | RESOLVED | ADR-024 Section 2, Stories 1.4, 1.6, 1.4b |
| V. Build/Release/Run | RESOLVED | ADR-024 Section 3, Story 1.4b |
| VI. Processes | ALIGNED | ADR-024 Section 4 |
| VII. Port Binding | RESOLVED | ADR-024 Section 5, Story 9.0 |
| VIII. Concurrency | ALIGNED | ADR-024 Section 6 |
| IX. Disposability | RESOLVED | ADR-024 Section 7, Stories 4.0, 8.5 |
| X. Dev/Prod Parity | RESOLVED | ADR-024 Section 8, Stories 1.4, 1.4b |
| XI. Logs | RESOLVED | ADR-024 Section 9, Stories 1.4, 4.0 |
| XII. Admin Processes | RESOLVED | ADR-024 Section 10, Story 1.4c |

---

## Story Amendments Summary

| Story | Amendments | ADR-024 Sections |
|-------|-----------|-----------------|
| **1.4** (Factory Core Skeleton) | Env-var override layer (`applyEnvOverrides()`), configurable DB paths, system dep checks (git/bun/tmux), `factory.yaml.example` committed, `.env.example` committed, NDJSON stdout logger, `QDS_LOG_LEVEL` | 1, 2, 7, 9 |
| **1.6** (Overstory Schema Extensions) | Read Overstory DB paths from Overstory's `loadConfig()`, not hardcoded `.overstory/*.db` | 2 |
| **4.0** (Orchestration Loop) | SIGTERM/SIGINT handlers (WS close 1001, SSE flush, turn_state checkpoint, DB close), startup SLA <2s, shutdown SLA <10s, correlation IDs (`story_id`, `phase`, `agent_id`, `turn_number`) in all log lines, Docker healthcheck support via `/health` endpoint | 7, 9 |
| **8.5** (Circuit Breaker) | Persist circuit breaker state to `pipeline.db` on SIGTERM shutdown, restore on restart | 4, 7 |
| **9.0** (ZeroClaw Carry-Forward) | Configurable gateway port/host via `factory.yaml` + env vars, `/health` endpoint (`{ status, version, uptime_ms }`), `/ready` endpoint (200 after migrations + loop start), startup port logging, gateway is self-contained via port binding | 5 |

## New Stories Summary

| Story | Epic | Description | Priority |
|-------|------|-------------|----------|
| **1.4b** | 1 | Build & Containerization — rfp-agents Docker pattern | P1 (end of Epic 1) |
| **1.4c** | 1 | Admin CLI — `qds doctor`, `qds migrate`, `qds config validate/show` | P2 (end of Epic 1) |

## Growth Stories Summary (Post-MVP)

| Story | Description |
|-------|-------------|
| Unified log aggregation | `qds logs` with `--story <id>` correlation filtering |
| Overstory env-var layer | `OVERSTORY_` prefix override for Overstory config (fork modification) |
| Export/backup/restore | `qds export`, `qds backup`, `qds restore` admin commands |
| CI pipeline | GitHub Actions workflow: build multi-arch image, run tests, push to registry |
| Docker volume management | `qds volumes backup`, `qds volumes prune`, named volume lifecycle |

---

## Risk Register

| Risk | Severity | Status |
|------|----------|--------|
| RISK-6: Alpine ARM64 native binary incompatibility | HIGH | **MITIGATED** — Debian-based images mandated (ADR-024 Section 3) |
| RISK-7: Config drift between developers | MEDIUM | **MITIGATED** — Docker image is canonical runtime (Section 8), 3-layer env hierarchy (Section 3) |
| RISK-8: Ungraceful shutdown loses in-flight state | MEDIUM | **MITIGATED** — SIGTERM handler with checkpointing (Section 7), stop_grace_period: 15s |
| RISK-9: Hardcoded paths prevent Docker deployment | LOW | **MITIGATED** — All paths configurable via env vars (Sections 1, 2) |

---

*Session 11 Twelve-Factor Alignment. ADR-024 with 10 sections, 5 story amendments, 2 new stories (1.4b, 1.4c), 5 growth stories. These amendments are authoritative and supersede any contradictory text in architecture-v2.md, epics-and-stories.md, or prior session amendments regarding configuration, deployment, logging, and process lifecycle.*
