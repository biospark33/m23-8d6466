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
- **INV-3:** Log output is minimal — env key names only, never values. The subprocess inherits the full merged env per INV-1 (`{ ...process.env, ...manifest.env }`), but the harness logs only env key names, not values. No wholesale `process.env` dump into log output or structured result.

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

### Review Findings

Code review was run on merged PR #24 (commit 396d386) using the gds-code-review workflow (3 parallel layers: Blind Hunter, Edge Case Hunter, Acceptance Auditor). All ~22 findings, including low severity, were fixed:

- [x] Secret-channel hardening (INV-2/INV-3): secret-like parent env values redacted from `stdout_excerpt`/`env_probe_result`; stdout capture capped at 256KB (`truncated` flag); UTF-8-safe StringDecoder; env-keys log line capped at 50 key names.
- [x] Process-tree timeout kill: `detached` spawn on POSIX, SIGKILL to the process group on timeout; win32 fallback preserved.
- [x] Error handling & exit codes: sync-spawn throw → `spawn_error` (127); double-settle guard; `spawn_error_code`/`signal` surfaced; manifest/usage errors exit 65/64 with clean stderr messages; timeout → 124.
- [x] Edge-case hardening: CRLF probe stripping; empty manifest `PATH` leaves parent PATH unchanged; win32 case-insensitive PATH key; undefined `process.env` values filtered; `--manifest=<path>` form; trim validation on `name`/`command`.
- [x] Test coverage: timeout, spawn_error, empty-PATH, strict-schema, additive-inheritance, truncation tests added; weak INV-2 test replaced with a real echoed-secret assertion; mandatory e2e test (`bun run src/index.ts`) added.

Follow-up adversarial re-review returned two blocking items, both fixed: trailing partial-prefix redaction of secrets cut at the truncation boundary, and `decoder.end()` skipped once truncated so a mid-sequence cut cannot push the excerpt past the cap (new boundary-leak and multi-byte cap tests added).
