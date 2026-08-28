# QDS-Factory

QDS-Factory is the orchestration platform behind Quantum Digital Solutions' agent
work: it admits a unit of work, runs it on a rented machine under a hard money
cap, re-verifies the result and opens the PR. Everything runs on
[Bun](https://bun.sh).

## Modules

Two layers live in this tree. The **Dark Factory v5 control plane** is the
current centre of the system: `src/fleet/` admits work and mints run IDs behind a
single-operator file lock; `src/providers/` owns the exe.dev substrate — per-run
minted credentials with provider-side ceilings, an append-only SQLite cost
ledger, harvest, teardown and a reaper; `src/phase-engine/` runs manifest-driven
phases inside the box and writes the SQLite trace; `src/pr/` and `src/reverify/`
are the "lights-on head" that re-verifies a harvested tree in a worktree and
publishes it; `visualizer/` is the read-only Vue 3 UI over that trace. Around it
sits the **Phase-0 scaffolding** — `src/gate/`, `src/swarmclaw/`,
`src/hindsight/`, `scripts/*-verify.ts`, `cli-anything/` and
`pi-vs-claude-code-vendor/` — which was the whole product in July and is now the
harness underneath it. That layer's exit gate is still
`gate-red-not-exitable`, while 23 of 31 Dark Factory stories have shipped on top
of it; read a Phase-0 module as scaffolding unless you are working on the gate
itself.

### Dark Factory v5 control plane

| Path | What it is |
|------|------------|
| `src/fleet/` | Admission: `dispatch`, `fanout` best-of-n, advisory `rank`, and the single-operator `FleetLock`. Mints the run ID everything else correlates on. |
| `src/providers/` | The substrate — exe.dev SSH driver, per-run minted API credentials with provider-side ceilings, the append-only SQLite cost ledger, harvest, teardown and the reaper. |
| `src/phase-engine/` | Runs manifest-driven phases inside the box and writes the SQLite run trace. |
| `src/pr/` | Opens the pull request for a harvested run, with a redaction map over run secrets. |
| `src/reverify/` | Re-verifies a harvested tree in an isolated worktree before `src/pr/` publishes it. |
| `visualizer/` | Vue 3 + Bun read-only UI over the run trace. The one part of the repo with a build step (`vue-tsc --noEmit && vite build`, wired as `build:check` in CI). |

### Phase-0 scaffolding

| Path | What it is |
|------|------------|
| `src/swarmclaw/` | Bun HTTP server — in-memory agent + MCP-server registries and a stdio↔HTTP MCP tool bridge. |
| `src/hindsight/` | Typed client for the external Hindsight memory service: bank provisioning, retain/recall/reflect, Mulch import. |
| `src/gate/` | Phase-0 exit gate — 9 assertion modules aggregated into one binary PASS/FAIL verdict. |
| `cli-anything/` | Manifest-driven multi-agent CLI runner (budget, wall-clock and coms-timeout caps). |
| `scripts/` | Verification harnesses (`lsp-verify`, `coms-smoke-test`, `pi-lens-verify`), Hindsight provisioning, and the operator CLIs for the control plane (`qds-cost`, `open-pr`, `sandbox-reap`). |
| `pi-vs-claude-code-vendor/` | Pinned fork of the upstream Pi coms extension — two transports: Unix socket (`coms.ts`) and HTTP/SSE (`coms-net.ts`). |

## Getting started

```bash
bun install
bun test
```

Also available:

```bash
bun run typecheck   # bunx tsc --noEmit
bun run lint        # biome check — clean on main today
```

`bun test` has two known failures on `main`:

- `tests/gitnexus/graph-queries.test.ts:351` — fails on every run. The
  `gitnexus_impact` response no longer satisfies `ImpactResultSchema` (it is
  missing `affected_modules`), so this is upstream output drift, not broken code
  in this repo. Note it also *skips* rather than fails in a git worktree, where
  the GitNexus index is absent.
- `tests/fleet/cli.test.ts:4968` — flaky, roughly 2 runs in 4. It fails by
  hitting the 20 s per-test timeout, not by asserting a wrong value.

Anything beyond those two is yours. Delete this paragraph once both are fixed.

The 13 `*.live.test.ts` files are a separate, **manual** tier and are by design
never run in CI — they spend real money on rented machines. They are driven by
hand with `QDS_E2E_LIVE=1` before each merge that touches the substrate; the
TIER-1/2/3 evidence notes in `_bmad-output/sprint-artifacts/sprint-status.yaml`
are the record of those runs. Their absence from CI is a decision, not an
oversight.

Routine observability output — the swarmclaw JSONL log lines
(`src/swarmclaw/log.ts`) and cli-anything's per-run env diagnostics
(`cli-anything/src/env.ts`) — is muted under `bun test`: Bun sets `NODE_ENV=test`
and the noise used to bury real failures. To get it back for a suite:

```bash
QDS_LOG_VERBOSE=1 bun test tests/swarmclaw
```

Two sinks are **not** muted and still print during a test run: the CLI's stdout
result contract at `cli-anything/src/index.ts:263`, which tests hit because they
invoke `main()` in-process, and the visualizer's `viz_request` lines in
`visualizer/server/index.ts`. Both are tracked and will be gated on the same
predicate as the other two.

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
