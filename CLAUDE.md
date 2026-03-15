# QDS Factory

Unified coding factory platform that accepts development stories and produces production-ready, adversarially-reviewed, evidence-backed pull requests. Factory Core orchestrates five proven open-source components — Overstory (agent coordination), Pi SDK (model-agnostic runtime), Superpowers (quality gates), ZeroClaw (dashboard patterns), and claude-mem (memory patterns) — into a single platform.

## Quick Reference

```bash
# Quality gates (run before committing)
bun test                    # Overstory tests
cd pi-mono && npm test      # Pi SDK tests
cd superpowers && bun test  # Superpowers tests

# Overstory CLI
ov init                     # Initialize .overstory/ in a target project
ov sling <task-id> --name <agent> --capability builder  # Spawn agent
ov status                   # Show active agents
ov dashboard                # Live TUI
ov mail check --inject      # Surface agent messages

# Development
bun run lint                # Biome check (overstory)
bun run typecheck           # tsc --noEmit (overstory)
```

## Project Structure

```
QDS-Factory/
├── overstory/              # Agent orchestration CLI (Bun/TS) — FORK of jayminwest/overstory
├── pi-mono/                # Model-agnostic coding agent runtime (Node.js, 6 packages)
├── superpowers/            # Skill system + hook enforcement (TS)
├── zeroclaw/               # Rust AI agent engine — PATTERN SOURCE for dashboard SSE/WS
├── claude-mem/             # Memory compression plugin (Node.js/MCP)
├── SuperClaude_Framework/  # Python PM agent patterns + CLI
├── stitch/                 # Dashboard UI mockups (6 wireframes)
├── _bmad-output/           # All planning & implementation artifacts
│   ├── planning-artifacts/ # PRD, architecture, handoffs, amendments
│   └── implementation-artifacts/  # Epics, stories, code-lift manifest, gap analysis
├── _research-repos/        # Reference implementations (study only, not dependencies)
└── docs/                   # UI assets
```

Each sub-project has its own `.git`, `CLAUDE.md`, and toolchain. This is a polyfarm (independent projects coordinated by Factory Core), not a traditional monorepo.

## Component Roles

| Component | Role | Runtime | Integration Surface |
|-----------|------|---------|-------------------|
| **Factory Core** | Foundation — pipeline engine, economic governance, overlay composition | Bun/TS | Orchestrates everything below |
| **Overstory** | Agent lifecycle, mail, merge, watchdog, sessions | Bun/TS | `ov sling` CLI, SQLite stores |
| **Pi SDK** | Model-agnostic LLM runtime, native model switching | Node.js | `getApiKey` callback, tier directives |
| **Superpowers** | Quality gates, skill injection, hook enforcement | TS | Skill `description` field with enforcement metadata |
| **ZeroClaw** | Pattern source for SSE/WS dashboard clients | Rust | No runtime dependency — patterns only |
| **claude-mem** | Pattern source for progressive disclosure, session summaries | Node.js | No runtime dependency — patterns only |

**Key insight:** Factory Core is the FOUNDATION. Components are consumed, not forked-and-merged. ZeroClaw and claude-mem are PATTERN SOURCES — we study their code and build our own implementations inspired by their approaches.

## Architecture Decisions (Session 10)

Detailed ADRs in `_bmad-output/planning-artifacts/architecture-v2-session10-amendments.md`.

**Critical decisions:**
- **ADR-008:** Pi SDK credentials via `getApiKey` callback (closure-based, never exposed to agents)
- **ADR-013:** Enforcement metadata lives in Superpowers skill `description` field (NOT a separate `enforcement` YAML field)
- **Database ownership:** Factory Core owns `pipeline.db` + `attribution.db` (sequential SQL migrations via Story 1.2). Overstory owns `sessions.db`, `mail.db`, `events.db`, `metrics.db` (Story 1.6 extends these using probe-then-alter for ADD COLUMN, table-rebuild for CHECK constraints)
- **Model tier policy:** Factory Core sets tier directives (economy/standard/premium per agent role). Pi SDK executes model selection. Agents never know which model they're talking to.

## Development Workflow

### Planning Artifacts

All specs live in `_bmad-output/`. Key files:

- `planning-artifacts/prd-v2.md` — Product requirements (171 FRs)
- `planning-artifacts/architecture-v2.md` — System architecture
- `planning-artifacts/architecture-v2-session10-amendments.md` — Latest ADR amendments
- `implementation-artifacts/epics-and-stories.md` — 10 epics, ~64 stories, ~6,470 LOC
- `implementation-artifacts/code-lift-manifest.md` — What to lift from each source project
- `implementation-artifacts/code-lift-gap-analysis.md` — Risk analysis

### Branch Conventions

- `main` — PR target, protected
- `qds/<dev>/<story-id>` — Factory-generated work branches
- `session<N>/<description>` — Planning/architecture session branches
- `feat/`, `fix/`, `docs/`, `refactor/` — Standard development prefixes

### Commit Style

Follow the existing pattern:
```
Fix PR review round N: <concise summary of changes>

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

For factory-generated commits: `[QDS:<story-id>:<phase>] <message>`

## Coding Conventions

### TypeScript (Overstory, Superpowers, Factory Core)

- **Runtime:** Bun (runs TypeScript directly, no build step)
- **Strict mode:** `noUncheckedIndexedAccess`, `noExplicitAny` (error), `useConst` (enforced)
- **Formatter/linter:** Biome — tabs, 100 char line width
- **Dependencies:** Minimal. Prefer Bun built-ins (`bun:sqlite`, `Bun.spawn`, `Bun.file`)
- **Errors:** Extend a typed base error class with `code` field
- **Types:** Centralized in `types.ts` per project

### Pi SDK (Node.js)

- **Runtime:** Node.js with npm workspaces (6 packages)
- **Build:** esbuild transpilation
- **Credential injection:** `getApiKey` callback pattern — never constructor params

### ZeroClaw (Rust)

- **Runtime:** Cargo workspace, Rust 2021
- **Principles:** KISS, YAGNI, fail-fast, secure-by-default
- **Role:** Pattern source only — no runtime integration

### Testing

- **Overstory:** `bun test` — real implementations over mocks. Use temp dirs for filesystem, `:memory:` for SQLite, real git repos for worktree tests. Only mock tmux, external AI services, and network.
- **Pi SDK:** `npm test` in pi-mono root
- **Frontend (when built):** Vitest for dashboard tests

### Fork Hygiene (Overstory)

Overstory is a fork of `jayminwest/overstory` with active upstream development.

- `origin` → `biospark33/overstory` (our fork)
- `upstream` → `jayminwest/overstory` (Jaymin's repo)
- Sync: `git fetch upstream && git merge upstream/main`
- Mark QDS-specific edits in upstream files with `// QDS:` comment prefix
- Prefer additive changes (new files) over editing upstream files
- Run quality gates after every upstream sync

## Pipeline Architecture (Planned)

The factory pipeline for a Story work type:

```
Story Intake → Develop → BMAD Review → Fix Loop → QA Swarm → PR
                  ↓           ↓            ↓          ↓
              [builders]  [fresh agents] [fix-lead]  [scouts]
              [standard]  [economy tier] [standard]  [economy]
```

**6-layer enforcement:**
1. Runtime filesystem restrictions (Overstory/Pi)
2. Post-edit hooks (file scope, TDD file-pair)
3. Post-task hooks (test runner, lint, type check)
4. Phase boundary hooks (full suite, build, manifest validation)
5. BMAD review (judgment-based, context-isolated)
6. QA swarm (adversarial edge-case hunting)

**Context isolation is non-negotiable** — development agents never share context with review agents.

## Databases

| Database | Owner | Purpose |
|----------|-------|---------|
| `pipeline.db` | Factory Core | Action scores, ELO ratings, budget tracking, learning records |
| `attribution.db` | Factory Core | Per-call cost attribution chains |
| `sessions.db` | Overstory | Agent lifecycle, runs |
| `mail.db` | Overstory | Inter-agent messaging (8+ message types) |
| `events.db` | Overstory | Tool invocations, errors, timelines |
| `metrics.db` | Overstory | Token usage, costs, session duration |

All SQLite with WAL mode for concurrent access.

## Security Boundaries

- API keys in `factory.yaml` (per-developer, `.gitignore`d) — never in agent context, logs, PRs, or committed files
- Pi SDK mediates all model API access — agents interact with Pi, never with providers directly
- No API call without a complete attribution chain (`developer → story → phase → agent → model → provider → tokens → cost`)
- Git iron laws: never force-push, never commit to protected branches, factory-namespaced branches only

## Key Files for New Contributors

Start here, in this order:

1. `_bmad-output/planning-artifacts/prd-v2.md` — What we're building and why
2. `_bmad-output/planning-artifacts/architecture-v2.md` — How it fits together
3. `_bmad-output/planning-artifacts/architecture-v2-session10-amendments.md` — Latest decisions
4. `_bmad-output/implementation-artifacts/epics-and-stories.md` — What to build, story by story
5. `_bmad-output/implementation-artifacts/code-lift-manifest.md` — What to lift from source projects
6. `overstory/CLAUDE.md` — Overstory internals and CLI reference
