# P1.4: Author and register the 14-node `qds-piv-loop` DAG

**Story Points:** 4

## Spec Reference

- PRD §6.3 (Orchestration — Archon DAG); FR-OR-1, FR-OR-2
- PRD §4.4 / Appendix D (env-patched bash node — predecessor P0.1)
- Phase exit gate: PRD §13 Phase-1 item 4 ("the 14-node QDS variant registers and is runnable via `POST /api/workflows/qds-piv-loop/run`")

## User Story

As an Orchestration lead,
I want to author and register the custom 14-node `qds-piv-loop` workflow and run it via a single POST,
so that the factory has an invokable QDS orchestration graph — the spine the F1 make-or-break flow runs on (G1 working factory).

## Overview

This slice cuts the Archon DAG layer: author a new `qds-piv-loop.yaml` (the 14-node QDS variant of the on-disk 8-node base `archon-piv-loop.yaml`), register it with Archon (`coleam00/Archon@dev`, base SHA `536584db`), and prove it is runnable end-to-end via `POST /api/workflows/qds-piv-loop/run` (handler `api.ts:1784`), returning a run id and streaming via `GET /api/stream/__dashboard__` (SSE). The heavy nodes are **bash nodes** (`executeBashNode`, `dag-executor.ts:1305`) carrying a per-node `env` map (the P0.1 3-site env patch). One atomic 4pt unit: registering + invoking is the demonstrable capability; node bodies invoke the launcher contract but the slice's exit-criterion is *graph registered + returns a run id*, not a full Pi-team run (that is P1.x downstream).

## E2E Slice

**Demonstrable behavior:** After registering `qds-piv-loop` (14 nodes, valid DAG — no cycles, single entry, edges resolve), `POST /api/workflows/qds-piv-loop/run` returns HTTP 2xx with a JSON body containing a `runId`; `GET /api/stream/__dashboard__` emits SSE events for that run id; the run advances past the entry node. A trivial env-bearing bash node in the graph (`env: { QDS_PROBE: "x7" }`) echoes `$QDS_PROBE` into node output equal to `x7` (proving the P0.1 patch carries through this graph), and a bare bash node still inherits parent `PATH` (non-regression).

**Wiring closed:** On completion of this story, `POST /api/workflows/qds-piv-loop/run` produces a JSON response containing a `runId` and an SSE stream for that run, using only code merged by this story (the `qds-piv-loop.yaml` definition + its registration). No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P0.1 (Archon 3-site env patch productionized — `bashNodeSchema` `env` field `dag-node.ts:179-181`, `executeBashNode` merge `dag-executor.ts:1362`, `@archon/git` `exec.ts` type widening), P0.11 (Archon instance bootable/registerable).

## The 14 nodes (spec level)

Base PIV = 8 (`explore`, `create-plan`, `refine-plan`, `implement-setup`, `implement`, `code-review`, `fix-feedback`, `finalize`). The QDS variant keeps those and inserts 6 QDS-specific nodes:

1. `explore` (base) — survey repo/context.
2. `graph-prime` (QDS) — bash node: prime context with GitNexus graph + Mulch house-style.
3. `create-plan` (base).
4. `refine-plan` (base).
5. `archetype-select` (QDS) — bash node: `qds-model-router` picks archetype A–F + per-role model tier (FR-LEARN-29).
6. `implement-setup` (base) — worktree-isolated workspace setup.
7. `implement` (base) — heavy bash node → `pi-team-launch.sh` Pi team.
8. `diagnostics-gate` (QDS) — bash node: post-edit `lsp_diagnostics` gate over changed-file union (FR-EX-11).
9. `code-review` (base).
10. `adversary-review` (QDS) — bash node: QA-Hunter/adversary pass.
11. `fix-feedback` (base).
12. `approval-gate` (QDS) — approval node: pause pending `executionPolicy` decision (FR-OR-6).
13. `finalize` (base) — open/produce PR.
14. `retain-learnings` (QDS) — bash node: Hindsight retain (`document_id=runId`, FR-MEM-2/NFR-REL-3).

## Acceptance Criteria

1. **(make-or-break)** Given `qds-piv-loop` is registered with Archon, When `POST /api/workflows/qds-piv-loop/run` is called, Then the response is HTTP 2xx with a JSON body containing a non-empty `runId`, and `GET /api/stream/__dashboard__` emits ≥1 SSE event correlated to that `runId` — the graph is registered and invokable end-to-end.
2. Given the registered graph definition, When it is validated, Then it contains exactly 14 nodes forming an acyclic single-entry DAG (all edges resolve to declared node ids; no cycle; no orphan node).
3. Given an env-bearing bash node `env:{ QDS_PROBE:"x7" }` and a bare bash node in the graph, When the run reaches them, Then the env node's output equals `x7` and the bare node's `$PATH` is non-empty (the P0.1 patch carries through; non-regression holds). Given an invalid definition (cycle/dangling edge), When registration is attempted, Then it is rejected with a non-zero/4xx result (never silently registers a broken graph).

## Technical Notes

- **Contracts/Schema:** workflow definition authored as `qds-piv-loop.yaml` matching Archon's DAG node schema (`packages/workflows/src/schemas/dag-node.ts`); bash nodes use the patched `bashNodeSchema` with optional `env` (`:179-181`, from P0.1). Each bash node's `--wall-clock-cap-ms` (passed to `pi-team-launch.sh`) must be **≤ the bash node's own `timeout`** (`dag-node.ts:181`). Run invoked via `POST /api/workflows/{name}/run` (`api.ts:1784`, OpenAPI `:566`); SSE via `GET /api/stream/__dashboard__` (`api.ts:1384`).
- **Integration points (each wired & exercised in this story):** (1) graph registration with Archon; (2) `POST …/run` returning a `runId`; (3) SSE stream consumption proving the run advanced; (4) per-node `env` merge through `executeBashNode` (`{...process.env, ...(node.env ?? {})}`) verified live via the probe node.
- **Files / functions touched:** new `qds-piv-loop.yaml`; node bodies referencing `pi-team-launch.sh` (launcher is a P0.x deliverable — referenced, not authored here); registration entry. The env patch (`dag-node.ts`, `dag-executor.ts:1362`, `@archon/git` `exec.ts`) is consumed from P0.1, not modified here.
- **Guards/limits:** node `timeout` bounds each bash node; `--wall-clock-cap-ms ≤ timeout`; SSE consumed sequentially (blocking) per the §4.1 Hermes concurrency model — non-blocking per-story concurrency is a Phase-3 upgrade, not assumed here.

## Files to Modify

- `/Users/steve/Archon/.archon/workflows/defaults/qds-piv-loop.yaml`
- `/Users/steve/Archon/packages/workflows/src/workflow-registry.ts`
- `tests/phase-1/p1-4-qds-piv-loop.e2e.test.ts`

## Definition of Done

- [ ] **Impl:** `qds-piv-loop.yaml` authored with exactly 14 nodes (8 base + 6 QDS: graph-prime, archetype-select, diagnostics-gate, adversary-review, approval-gate, retain-learnings) forming an acyclic single-entry DAG.
- [ ] **Impl:** the workflow is registered with Archon so `qds-piv-loop` resolves at `POST /api/workflows/qds-piv-loop/run`.
- [ ] **Contract/Schema:** every node validates against Archon's DAG node schema; bash nodes use the P0.1-patched `bashNodeSchema` `env` field; each `--wall-clock-cap-ms ≤ node timeout`.
- [ ] **Integration:** `POST …/run` returns a `runId` and `GET /api/stream/__dashboard__` emits SSE events for that run id (the run advances past entry).
- [ ] **Integration:** the env-probe bash node echoes `QDS_PROBE=x7` and the bare bash node inherits non-empty `$PATH` — the P0.1 per-node env merge carries through this graph (non-regression).
- [ ] **Observability:** the run's SSE stream is captured and correlated to its `runId` (Archon-run hop, §8.4; NFR-OBS-1).
- [ ] **Test (unit/integration):** validates the 14-node graph shape (node count, acyclicity, single entry, edges resolve) and rejects an invalid definition (cycle/dangling edge) with a non-zero result.
- [ ] **Test (e2e demo — MANDATORY):** fires `POST /api/workflows/qds-piv-loop/run`, asserts a 2xx JSON body with a non-empty `runId` and ≥1 correlated SSE event — proving the graph registers and is invokable end-to-end (§13 Phase-1 item 4).

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
