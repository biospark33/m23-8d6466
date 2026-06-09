# P1.6: Pi-Team Implement via CLI-Anything Warren Harness + Captures Structured JSON

**Story Points:** 4

## Spec Reference

- PRD §8, §10; FR-OR-3, FR-EX-6
- Phase exit gate: PRD §13 Phase 1 clause 6

## User Story

As a QDS factory operator,
I want the protocol dispatch_task step to invoke Pi teams via the CLI-Anything Warren harness and capture structured JSON output,
so that the factory pipeline produces machine-readable results from real agent execution.

## Overview

When the qds-factory protocol reaches a dispatch_task phase, SwarmClaw invokes the CLI-Anything harness, which translates the task into a `warren run` command. Warren executes the Pi team inside a burrow, with Mulch-primed context and pi-lens gating. The Pi team produces structured JSON output (status, files changed, test results, summary). This output is captured by the CLI-Anything harness and returned to SwarmClaw as the step result. The wiring covers: protocol step -> harness invocation -> Warren execution -> structured JSON capture -> step output.

## E2E Slice

**Demonstrable behavior:** Given an active qds-factory protocol session, When the dispatch_task step executes, it invokes CLI-Anything harness -> `warren run` with Mulch-primed Pi team -> Pi agents execute a sample task (e.g., "create a hello-world function") -> structured JSON `{ status: "success", filesChanged: ["src/hello.ts"], testResults: { passed: 1, failed: 0 }, summary: "..." }` is captured as the protocol step output.

**Wiring closed:** On completion of this story, a dispatch_task protocol step yields a single demonstrable Pi team result in structured JSON, using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P0.3 (CLI-Anything harness operational), P0.5 (pi-lens gating), P0.9 (Hindsight for Mulch priming), P1.4 (protocol template with dispatch_task phase).

## Acceptance Criteria

1. **(make-or-break)** Given an active protocol session with a dispatch_task step, When the step executes, Then CLI-Anything harness is invoked with the task payload, `warren run` executes, and the step output is structured JSON containing `{ status: "success"|"failure", filesChanged: string[], testResults: { passed: number, failed: number }, summary: string, durationMs: number }`.
2. Given the Pi team completes successfully, When the structured JSON is captured, Then it is stored as the protocol step output and retrievable via the SwarmClaw session status API.
3. Given `warren run` exits with non-zero code or times out, When the harness captures the failure, Then the step output is `{ status: "failure", error: string, exitCode: number, partialOutput: string | null }` and the protocol engine does not crash.

## Technical Notes

- **Contracts/Schema:** dispatch_task config: `{ taskBrief: string, targetAgentIds: string[], mulchBankId: string, maxDurationMs: number, captureFormat: "structured-json" }`. Harness invocation: `warren run --task "{taskBrief}" --agents "{agentIds}" --mulch-bank "{mulchBankId}" --output json --max-duration {maxDurationMs}ms`. Step output (success): `{ status: "success", filesChanged: string[], testResults: { passed: number, failed: number, coverage?: number }, summary: string, durationMs: number, artifacts: Array<{ name: string, path: string }> }`. Step output (failure): `{ status: "failure", error: string, exitCode: number, partialOutput: string | null, durationMs: number }`.
- **Integration points:** SwarmClaw protocol engine (dispatch_task phase handler), CLI-Anything harness adapter, Warren CLI (`warren run`), Pi agents (inside burrow), Mulch (context priming from Hindsight bank), pi-lens (output gating/validation).
- **Files / functions touched:** CLI-Anything harness adapter (warren invocation), dispatch_task phase handler, structured JSON capture/parser, Warren output adapter, protocol step output store.
- **Guards/limits:** maxDurationMs must be >= 10000ms and <= 600000ms (10s to 10min). filesChanged paths must be relative and within repo root (no path traversal). testResults.passed and failed must be >= 0. summary must be <= 2000 characters. Exit code 0 treated as success; non-zero treated as failure.

## Files to Modify

- `src/cli-anything/harness/warren-adapter.ts`
- `src/swarmclaw/protocols/phases/dispatch-task.ts`
- `src/cli-anything/output/structured-capture.ts`
- `src/swarmclaw/sessions/step-output-store.ts`
- `tests/e2e/pi-team-dispatch.test.ts`

## Security Invariants

- INV-1: `warren run` invoked with `--repo` scoped to the session's repository; no cross-repo file access.
- INV-2: filesChanged paths validated against path traversal (reject `..`, absolute paths, symlinks).
- INV-3: Warren process runs with resource limits: max 2 CPU cores, max 4GB memory, enforced by harness wrapper.

## Definition of Done

- [ ] **Impl:** dispatch_task phase handler invokes CLI-Anything harness with task payload from protocol config.
- [ ] **Impl:** CLI-Anything harness translates task to `warren run` command with correct flags (--task, --agents, --mulch-bank, --output json, --max-duration).
- [ ] **Impl:** Warren output parsed as structured JSON with schema validation (status, filesChanged, testResults, summary, durationMs).
- [ ] **Impl:** Structured JSON stored as protocol step output and retrievable via session status API.
- [ ] **Contract:** Step output schema enforced: status enum, filesChanged is string array, testResults has passed/failed numbers, summary <= 2000 chars.
- [ ] **Contract:** Failure output schema enforced: error string, exitCode number, partialOutput nullable string.
- [ ] **Integration:** Mulch priming loads context from specified Hindsight bank before Warren execution.
- [ ] **Integration:** pi-lens gating validates Pi team output before capture (reject malformed output).
- [ ] **Security:** filesChanged paths validated: reject `..`, absolute paths, and symlinks.
- [ ] **Security:** Warren process resource-limited (2 CPU, 4GB memory) via harness wrapper.
- [ ] **Test (unit):** Harness adapter constructs correct `warren run` command from dispatch_task config.
- [ ] **Test (e2e demo — MANDATORY):** Run dispatch_task step -> verify Warren executes -> verify structured JSON captured as step output with status, filesChanged, testResults, summary fields.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
