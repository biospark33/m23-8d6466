# P0.1: CLI-Anything Harness Generator + Env Propagation to Warren Run

**Story Points:** 3

## Spec Reference

- PRD §4.4 (per-node env injection); FR-OR-4
- Phase exit gate: PRD §13 Phase-0 clause 5 (env reaches subprocess)

## User Story

As a SwarmClaw protocol operator,
I want the CLI-Anything harness to generate `warren run` commands that propagate per-step environment variables into the Warren subprocess,
so that secrets, model configs, and run-scoped context reach Pi agents inside the burrow (FR-OR-4, G1).

## Overview

The CLI-Anything harness is a manifest-driven generator (`manifest.yaml`) that wraps `warren run` invocations into structured, agent-controllable commands. This story delivers the harness skeleton plus the critical env-propagation path: SwarmClaw protocol step config → CLI-Anything manifest env block → `warren run` subprocess env → Pi agent env. Cuts CLI-Anything layer only (no SwarmClaw protocol, no Pi internals). 3 pts because it is a single concern (env reachability) with one integration seam.

## E2E Slice

**Demonstrable behavior:** A CLI-Anything harness invocation with `env: { QDS_PROBE: "x7" }` in its manifest generates and executes a `warren run` command; the subprocess echoes `$QDS_PROBE` into its stdout, which equals `x7`. A second invocation with no env block still inherits parent-env `$PATH` (non-empty).

**Wiring closed:** On completion of this story, running `cli-anything run --manifest test-env.yaml` produces stdout containing `QDS_PROBE=x7` for the env-bearing manifest and a non-empty `PATH` for the bare manifest, using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** None — standalone.

## Acceptance Criteria

1. **(make-or-break)** Given a manifest.yaml with `env: { QDS_PROBE: "x7" }`, When `cli-anything run --manifest test-env.yaml` executes, Then the subprocess stdout contains `QDS_PROBE=x7` (env reaches Warren subprocess).
2. Given a manifest.yaml with no `env` block, When `cli-anything run --manifest test-bare.yaml` executes, Then the subprocess stdout contains a non-empty `PATH` value (parent env inherited, non-regression).
3. Given a manifest.yaml with `env: { PATH: "/evil" }`, When `cli-anything run` executes, Then the subprocess inherits parent `PATH` plus `/evil` appended (merge, not replace).

## Technical Notes

- **Contracts/Schema:** CLI-Anything `manifest.yaml` schema: top-level `name` (string), `command` (string template), `env` (optional `Record<string, string>`), `args` (optional string array). Env block is merged into subprocess env as `{ ...process.env, ...manifest.env }` — never bare assignment (see env-merge safety rule, CORRECTNESS-A).
- **Integration points (each wired & exercised in this story):** manifest.yaml parse → env block extraction → `child_process.spawn` with merged env → Warren subprocess receives env → stdout captured and returned as structured JSON.
- **Files / functions touched:** `cli-anything/src/manifest.ts` (parse), `cli-anything/src/runner.ts` (spawn with env merge), `cli-anything/src/index.ts` (CLI entry).
- **Guards/limits:** Wall-clock timeout on harness invocation (default 10 min); structured JSON output on stdout (exit_class, stdout_excerpt, env_probe_result).

## Files to Modify

- `cli-anything/src/manifest.ts`
- `cli-anything/src/runner.ts`
- `cli-anything/src/index.ts`
- `cli-anything/src/types.ts`
- `cli-anything/package.json`
- `cli-anything/test/manifest.test.ts`
- `cli-anything/test/runner.test.ts`
- `cli-anything/test/fixtures/test-env.yaml`
- `cli-anything/test/fixtures/test-bare.yaml`

## Security Invariants

- **INV-1:** Env injection is a MERGE `{ ...process.env, ...manifest.env }` — a manifest with no `env` block still inherits parent `PATH`/credentials (non-regression). Bare assignment is prohibited at compile time (review checklist).
- **INV-2:** No secret value is written to stdout, logs, or the structured output. The harness logs key names only, never values.
- **INV-3:** Subprocess inherits a minimal env scope — only keys explicitly listed in manifest.env plus inherited PATH/HOME. No wholesale `process.env` dump into log output.

## Definition of Done

- [ ] **Impl:** CLI-Anything manifest parser extracts `env` block from YAML; runner spawns Warren subprocess with merged env.
- [ ] **Impl:** Structured JSON output schema (exit_class, stdout_excerpt, env_probe_result) emitted on harness stdout.
- [ ] **Contract:** manifest.yaml TypeScript type with field-level validation (name required, command required, env optional Record<string,string>).
- [ ] **Integration:** `cli-anything run --manifest` → Warren subprocess receives merged env → stdout captured — wired and exercised.
- [ ] **Security:** Env merge is additive (`...process.env, ...manifest.env`), tested with a bare manifest (non-regression) and an override manifest (merge precedence).
- [ ] **Test (unit):** manifest parser validates well-formed and malformed YAML; runner constructs correct spawn options.
- [ ] **Test (integration):** `cli-anything run --manifest test-env.yaml` produces stdout containing `QDS_PROBE=x7`.
- [ ] **Test (e2e demo — MANDATORY):** Fires `cli-anything run` with env-bearing and bare manifests; asserts `QDS_PROBE=x7` and non-empty `PATH` respectively; proves wiring closed.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
