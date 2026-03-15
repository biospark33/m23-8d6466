# QDS Factory

A coding factory platform that accepts development stories and produces production-ready, adversarially-reviewed, evidence-backed pull requests with minimal human intervention.

QDS Factory synthesizes five proven open-source projects into a single platform governed by a new Factory Core that manages resources, economics, context, and cross-system arbitration.

## How It Works

```
Story In --> Develop --> BMAD Review --> Fix Loop --> QA Swarm --> PR Out
              |              |              |            |
          [builders]    [fresh agents]  [fix-lead]   [scouts]
          [standard]    [economy tier]  [standard]   [economy]
```

1. Developer submits a story with acceptance criteria
2. Factory decomposes it into scoped agent tasks across isolated git worktrees
3. TDD-enforced agent swarms build the code
4. Context-isolated fresh agents run adversarial BMAD review (no shared context with dev agents)
5. Fix loop resolves findings with circuit breaker escalation
6. QA swarm runs multi-wave edge-case hunting on economy-tier models
7. PR ships with structured evidence: what was found, tested, and fixed

The entire quality pipeline runs on economy-tier models (GLM-5 via Pi SDK), costing under $0.05 per story. Context isolation between development and review is non-negotiable -- it eliminates the sunk-cost bias that makes self-review worthless.

## Architecture

**Factory Core** is the foundation layer. It owns the pipeline engine, phase boundaries, economic governance, overlay composition, and the self-learning system.

Five components plug into Factory Core:

| Component | What It Does | How Factory Core Uses It |
|-----------|-------------|------------------------|
| [Overstory](https://github.com/jayminwest/overstory) | Multi-agent orchestration via git worktrees + SQLite mail | Agent spawning, inter-agent messaging, session tracking, 4-tier merge |
| [Pi SDK](https://github.com/nicepkg/pi) | Model-agnostic LLM runtime with native model switching | Tier-based model routing (Opus for architecture, GLM-5 for QA) |
| [Superpowers](https://github.com/biospark33/superpowers) | Skill system with enforcement gates | Overlay injection, hook-enforced quality gates |
| ZeroClaw | SSE/WS client architecture | Dashboard real-time patterns (design inspiration, not runtime dep) |
| claude-mem | Progressive disclosure, session summaries | Memory patterns (design inspiration, not runtime dep) |

```
                    +------------------+
                    |   Factory Core   |
                    |  (pipeline.db)   |
                    |  (attribution.db)|
                    +--------+---------+
                             |
              +--------------+--------------+
              |              |              |
        +-----+-----+  +----+----+  +------+------+
        | Overstory  |  | Pi SDK  |  | Superpowers |
        | (ov sling) |  | (model  |  | (skills +   |
        | (mail.db)  |  |  tier)  |  |  enforcement)|
        +------------+  +---------+  +-------------+
```

## Key Capabilities

**Adversarial quality pipeline.** Every story passes through BMAD review and QA swarm with context-isolated fresh agents. Development agents never share context with review agents. Running on economy-tier models, the quality pipeline costs under $0.05 per story.

**Self-learning system.** Three learning loops compound over time: session-level tactical learning (Loop 1), cross-phase intelligence via structured manifests (Loop 2), and cross-session synthesis with auto-injection into future agent overlays (Loop 3). The factory gets smarter about YOUR codebase with every story.

**6-layer enforcement.** Progressive quality gates from runtime filesystem restrictions through post-edit/post-task hooks, phase boundary gates, BMAD review, to QA swarm. Each layer catches what previous layers missed.

**Model-agnostic economics.** Pi SDK handles model selection natively. Factory Core sets tier policy (economy/standard/premium per agent role) -- agents never know which model they're talking to. Full attribution chain on every API call.

## Project Structure

```
QDS-Factory/
  overstory/           Orchestration CLI (Bun/TypeScript) -- fork of jayminwest/overstory
  pi-mono/             Model-agnostic runtime (Node.js, 6 packages)
  superpowers/         Skill system + enforcement (TypeScript)
  zeroclaw/            Rust AI engine -- pattern source for dashboard
  claude-mem/          Memory plugin -- pattern source for context management
  stitch/              Dashboard UI mockups
  _bmad-output/        Planning & implementation artifacts
    planning-artifacts/
      prd-v2.md                                    Product requirements (171 FRs)
      architecture-v2.md                           System architecture
      architecture-v2-session10-amendments.md      Latest ADR amendments
    implementation-artifacts/
      epics-and-stories.md                         10 epics, ~64 stories, ~6,470 LOC
      code-lift-manifest.md                        What to lift from each source project
```

## Status

**Current phase:** Architecture and implementation planning complete. Code-lift manifest finalized. Implementation ready to begin.

- 10 epics, ~64 stories, ~6,470 estimated LOC
- 171 functional requirements across 19 capability areas
- 23 architecture decision records
- All blockers resolved through 10 planning sessions

See `_bmad-output/implementation-artifacts/epics-and-stories.md` for the full breakdown.

## Development

Each sub-project has its own toolchain and CLAUDE.md with detailed conventions.

```bash
# Overstory (Bun)
cd overstory && bun test && bun run lint && bun run typecheck

# Pi SDK (Node.js)
cd pi-mono && npm test

# Superpowers (Bun)
cd superpowers && bun test
```

See [CLAUDE.md](./CLAUDE.md) for full development workflow, coding conventions, and architecture context.

## License

Private repository.
