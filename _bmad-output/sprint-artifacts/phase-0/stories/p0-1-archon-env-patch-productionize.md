# P0.1: Productionize the Archon per-node env-injection patch with a non-regression gate

**Story Points:** 3

## Spec Reference

- PRD §4.4 (Archon env-patch), §6.3 (Orchestration — Archon DAG); FR-OR-3, FR-OR-4
- NFR-SEC-1 (no secret hardcoded), NFR-PERF-1 (structural, applies P0+ — not directly exercised)
- Phase exit gate: PRD §13 Phase-0 item 1 (env patch acquire + prove, incl. non-regression check); resolves OQ-6.

## User Story

As an Operator running the Dark Code Factory,
I want per-node `env` vars to reach an Archon bash node's subprocess via a pinned, merged (never bare-assigned) env patch,
so that per-node model routing (FR-OR-4) works without wiping the inherited parent env that every existing bash node depends on (G1 — a sound, auditable orchestration substrate).

## Overview

Cuts through the Archon DAG layer only: schema → executor → exec-wrapper type. The blueprint per-node env capability requires a **3-site** patch (the 2-site estimate missed the `@archon/git` type narrowing that rejects `env` at TS2353). The patch is already spike-applied on branch `qds/env-patch-spike` (base SHA `536584db`, `tsc --noEmit` clean + 150 dag-executor tests pass). This story **productionizes** that spike: it promotes the merge to a maintained, SHA-pinned branch and **locks the non-regression gate** (a bash node with no `env` still inherits parent env) as a permanent automated check, not a one-time spike observation. One atomic 3pt unit because the capability is undemonstrable until all three sites compile and run together — splitting leaves leftover wiring.

## E2E Slice

**Demonstrable behavior:** A two-node Archon workflow runs via `POST /api/workflows/{name}/run`. Node A carries `env: { FOO: "bar" }` and its bash echoes `$FOO` into node output, which equals `bar`. Node B carries **no** `env` field and its bash echoes an inherited parent-env var (`$PATH`), which is non-empty — proving the executor uses `env: { ...process.env, ...(node.env ?? {}) }` (merge), not a bare `env: node.env` (assignment) that would wipe inherited `PATH`/creds.

**Wiring closed:** On completion of this story, running the two-node `qds-env-probe` workflow produces node output `FOO=bar` for the env-bearing node and a non-empty `PATH` for the bare node, using only code merged by this story (schema field at `packages/workflows/src/schemas/dag-node.ts`, merge at `packages/workflows/src/dag-executor.ts:1362`, widened options type at `packages/git/src/exec.ts`). No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** None — standalone. (The `qds/env-patch-spike` branch is reference material, not a code dependency; this story re-applies the diff onto the pinned production branch.)

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given the patched Archon on the pinned branch (base SHA `536584db`) and a registered two-node `qds-env-probe` workflow, When the workflow runs via `POST /api/workflows/qds-env-probe/run`, Then Node A's captured node output contains `FOO=bar` **AND** Node B's captured node output contains a non-empty `PATH` value — both assertions pass in a single run (env reaches subprocess + zero env-wipe regression).
2. Given the three edit sites applied, When `tsc --noEmit` runs across `packages/workflows` and `packages/git`, Then it compiles clean (the TS2353 rejection of `env` on the `@archon/git` exec options type is gone) and the existing `dag-executor` test suite reports 150 pass / 0 fail.
3. Given a bash node whose `env` is omitted entirely (`node.env === undefined`), When `executeBashNode` builds the subprocess options, Then `env` resolves via `{ ...process.env, ...(node.env ?? {}) }` so the subprocess inherits the full parent env — a bare `env: node.env` assignment (which would yield `undefined`/empty env) is rejected by the non-regression check, never silently shipped.

## Technical Notes

- **Contracts/Schema:** Add optional `env?: Record<string, string>` to `bashNodeSchema` (`packages/workflows/src/schemas/dag-node.ts:179-181`); base node schema (`:113-139`) has no `env` today. Backward-compat: optional field → existing bash nodes (no `env`) validate unchanged. Widen `@archon/git` exec options type (`packages/git/src/exec.ts`) from `{ timeout?, cwd?, maxBuffer? }` with `env?: NodeJS.ProcessEnv` (additive, one line).
- **Integration points (each wired & exercised in this story):** Executor merge at `dag-executor.ts:1362` — `execFileAsync('bash',['-c',finalScript],{cwd,timeout})` becomes `{ cwd, timeout, env: { ...process.env, ...(node.env ?? {}) } }`. The merged env is injected into the bash subprocess and read back via the two-node probe workflow. `executeBashNode` (`dag-executor.ts:1305`) has a single upstream caller (`executeDagWorkflow`) — blast radius LOW.
- **Files / functions touched:** `dag-node.ts:bashNodeSchema`, `dag-executor.ts:executeBashNode` (`:1362`), `packages/git/src/exec.ts` exec-options type.
- **Guards/limits:** `--wall-clock-cap` not in scope; do NOT touch the `$VAR` regex at `dag-executor.ts:314` (`expandEnvVarsInRecord`, MCP-config-scoped). The two other bash `execFileAsync` sites (`~:1577` script-node, `~:2022` alt-bash) do NOT receive per-node `env` — explicit out-of-scope follow-up.

## Files to Modify

> ≤10 unique paths. Repo-relative to `/Users/steve/Archon`.

- `packages/workflows/src/schemas/dag-node.ts`
- `packages/workflows/src/dag-executor.ts`
- `packages/git/src/exec.ts`
- `.archon/workflows/defaults/qds-env-probe.yaml` (new two-node probe workflow fixture)
- `packages/workflows/src/__tests__/env-merge-nonregression.test.ts` (new)

## Security Invariants

> Triggered by: env injection into a subprocess; secrets/env. Concrete invariants only.

- **INV-1 (merge, not assignment):** Env injection is a MERGE `{ ...process.env, ...(node.env ?? {}) }`. A bash node with no `env` field still inherits the full parent `PATH`/credentials/env — a bare `env: node.env` is forbidden and is caught by the permanent non-regression test (AC-3), not just spike observation.
- **INV-2 (per-node override scope):** Per-node `env` keys override parent values only for that node's subprocess; the merge is computed fresh per `executeBashNode` invocation and does not mutate `process.env` of the Archon orchestrator process.
- **INV-3 (no secret to stdout):** Injected env values are NOT echoed wholesale to node output; the probe asserts only the single named probe var (`FOO`) and a presence check on `PATH` (non-empty boolean), never dumping the full env or any credential value into captured stdout (NFR-SEC-1).

## Definition of Done

> 8–12 high-signal, story-specific boxes.

- [ ] **Impl:** `env?: Record<string,string>` added to `bashNodeSchema`; existing no-`env` bash nodes still validate (backward-compat).
- [ ] **Impl:** `executeBashNode` (`dag-executor.ts:1362`) passes `env: { ...process.env, ...(node.env ?? {}) }` into the subprocess options object.
- [ ] **Impl:** `@archon/git` `exec.ts` options type widened with `env?: NodeJS.ProcessEnv`; `tsc --noEmit` clean across `packages/workflows` + `packages/git` (TS2353 resolved).
- [ ] **Contract:** Optional-field validation confirmed — `bashNodeSchema.parse({bash, timeout})` (no env) and `bashNodeSchema.parse({bash, timeout, env:{FOO:"bar"}})` both succeed; non-string env values rejected.
- [ ] **Integration:** `qds-env-probe` two-node workflow registered and runnable via `POST /api/workflows/qds-env-probe/run`; per-node env reaches the bash subprocess.
- [ ] **Security:** Non-regression test asserts a bare-assignment env wipe would fail (INV-1) — bash node without `env` echoes non-empty `$PATH`.
- [ ] **Security:** Probe asserts only the named var + PATH-presence; no full-env or credential dump in captured node output (INV-3).
- [ ] **Observability:** The pinned production branch records base SHA `536584db` + the 3-site diff in a documented rebase note, so the patch provenance is reconstructable.
- [ ] **Test (unit/integration):** Existing `dag-executor` suite runs green (150 pass / 0 fail) post-patch; new merge-vs-assignment unit test covers `node.env === undefined`.
- [ ] **Test (e2e demo — MANDATORY):** Run `qds-env-probe`; assert Node A output contains `FOO=bar` AND Node B output contains non-empty `PATH` in one run — proves env reaches subprocess + zero env-wipe regression (wiring closed).

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
