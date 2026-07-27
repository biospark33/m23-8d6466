# QDS-Factory

QDS-Factory is the orchestration platform behind Quantum Digital Solutions' agent
work: it registers agents and MCP servers, gives them durable memory, runs them as
manifest-driven teams, and gates the whole thing behind a machine-checkable exit
verdict. Everything runs on [Bun](https://bun.sh); there is no build step.

## Modules

| Path | What it is |
|------|------------|
| `src/swarmclaw/` | Bun HTTP server — in-memory agent + MCP-server registries and a stdio↔HTTP MCP tool bridge. |
| `src/hindsight/` | Typed client for the external Hindsight memory service: bank provisioning, retain/recall/reflect, Mulch import. |
| `src/gate/` | Phase-0 exit gate — 9 assertion modules aggregated into one binary PASS/FAIL verdict. |
| `cli-anything/` | Manifest-driven multi-agent CLI runner (budget, wall-clock and coms-timeout caps). |
| `scripts/` | Verification harnesses: `lsp-verify`, `coms-smoke-test`, `pi-lens-verify`, plus Hindsight provisioning. |
| `pi-vs-claude-code-vendor/` | Pinned fork of the upstream Pi coms extension — two transports: Unix socket (`coms.ts`) and HTTP/SSE (`coms-net.ts`). |

## Getting started

```bash
bun install
bun test
```

Also available:

```bash
bun run typecheck   # bunx tsc --noEmit
bun run lint        # biome check (non-clean on main today — 6 pre-existing findings)
```

`bun test` currently has one known failure on `main` (`H4c: keep-alive pool
survives a 413`). Anything beyond that is yours.

Copy `.env.example` to `.env` for the full list of configurable environment
variables — every one has a default, so nothing is required to run the tests.

## The exit gate

```bash
bun scripts/phase0-exit-gate.ts
```

Prints a per-assertion table, writes
`_bmad-output/sprint-artifacts/phase-0/phase0-gate-report.json`, and exits `1`
on a red verdict. Red means at least one PRD §13 Phase-0 clause is unproven —
usually a dependency that is not running rather than broken code: the gate needs
SwarmClaw up (`bun src/swarmclaw/index.ts`, default port 3100), a Hindsight API
on `HINDSIGHT_BASE_URL`, a resolvable `pi-lens` install, and a fresh GitNexus
index. Assertions whose story was killed report `VOID` and never block.

Agent-facing conventions live in `CLAUDE.md` and `AGENTS.md`.
