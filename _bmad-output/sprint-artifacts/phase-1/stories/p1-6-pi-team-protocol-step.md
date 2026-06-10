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

When the qds-factory protocol reaches a dispatch_task phase, SwarmClaw invokes the CLI-Anything harness, which translates the task into a `warren run` command. Warren executes the Pi team inside a burrow, with Mulch-primed context and pi-lens gating. The Pi team produces structured JSON output (exitStatus, changedFiles, test results, summary). This output is captured by the CLI-Anything harness and returned to SwarmClaw as the step result. The wiring covers: protocol step -> harness invocation -> Warren execution -> structured JSON capture -> step output.

## E2E Slice

**Demonstrable behavior:** Given an active qds-factory protocol session, When the dispatch_task step executes, it invokes CLI-Anything harness -> `warren run --config .canopy/agent.json` with Mulch-primed Pi team -> Pi agents execute a sample task (e.g., "create a hello-world function") -> structured JSON `{ exitStatus: "success", changedFiles: ["src/hello.ts"], testResults: { passed: 1, failed: 0 }, summary: "..." }` is captured as the protocol step output.

**Wiring closed:** On completion of this story, a dispatch_task protocol step yields a single demonstrable Pi team result in structured JSON, using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P0.3 (CLI-Anything harness operational), P0.5 (pi-lens gating), P0.9 (Hindsight for Mulch priming), P1.4 (protocol template with dispatch_task phase).

## Acceptance Criteria

1. **(make-or-break)** Given an active protocol session with a dispatch_task step, When the step executes, Then CLI-Anything harness is invoked with the task payload, `warren run --config .canopy/agent.json` executes (manifest-driven per P0.3 canonical pattern), and the step output is structured JSON containing `{ exitStatus: "success"|"transient"|"overflow"|"logic", changedFiles: string[], testResults: { passed: number, failed: number }, summary: string, durationMs: number }`.
2. Given the Pi team completes successfully, When the structured JSON is captured, Then it is stored as the protocol step output and retrievable via the SwarmClaw session status API.
3. Given `warren run` exits with non-zero code or times out, When the harness captures the failure, Then the step output is `{ exitStatus: "transient"|"overflow"|"logic", error: string, exitCode: number, partialOutput: string | null }` and the protocol engine does not crash.
4. Given a fresh repository with no prior Mulch expertise in the specified Hindsight bank, When the dispatch_task step executes with Mulch priming, Then the Pi team runs without primed context (empty context is acceptable), the step output includes `mulchPrimed: false`, and execution succeeds with `exitStatus: "success"` — empty bank is not an error condition.

## Technical Notes

- **exitStatus taxonomy (CC-1, aligned with P0.3):** Previous `status: 'failure'` maps to `exitStatus: 'transient'|'overflow'|'logic'`. Consumers must handle all three failure modes. This aligns with P0.3's canonical taxonomy. `"success"` = normal completion. `"transient"` = retryable failure (network, timeout). `"overflow"` = resource limit exceeded. `"logic"` = task logic error.
- **Warren CLI surface (CC-2, aligned with P0.3):** Warren CLI is manifest-driven per pivot. The canonical invocation is `warren run --config .canopy/agent.json`. Task params (task, agents, mulchBank, maxDurationMs) are defined in `.canopy/agent.json`. See P0.3 and P1.4 for canonical Warren invocation pattern.
  ```
  .canopy/agent.json example:
  {
    "agentId": "pi-team-worker",
    "model": "claude-sonnet",
    "extensions": ["pi-pi.ts"],
    "mulchBank": "qds-factory",
    "maxDurationMs": 600000
  }
  ```
- **PI extension files (CC-3):** Protocol engine (P1.4) resolves phase kind → PI extension. P1.6's dispatch_task step uses `extensions/agent-team.ts` via P1.4's phase→extension mapping table. The `.canopy/agent.json` config layer sits between the protocol engine and Warren invocation — the harness writes the manifest before calling `warren run --config`.
- **Field name alignment (CC-4):** Field name `changedFiles` matches P0.3 canonical output. All stories producing file-change lists use this name.
- **Contracts/Schema:** dispatch_task config: `{ taskBrief: string, targetAgentIds: string[], mulchBankId: string, maxDurationMs: number, captureFormat: "structured-json" }`. Harness invocation: `warren run --config .canopy/agent.json` (manifest-driven; harness generates manifest from config). Step output (success): `{ exitStatus: "success", changedFiles: string[], testResults: { passed: number, failed: number, coverage?: number }, summary: string, durationMs: number, artifacts: Array<{ name: string, path: string }> }`. Step output (failure): `{ exitStatus: "transient"|"overflow"|"logic", error: string, exitCode: number, partialOutput: string | null, durationMs: number }`.
- **Integration points:** SwarmClaw protocol engine (dispatch_task phase handler), CLI-Anything harness adapter, Warren CLI (`warren run --config`), Pi agents (inside burrow), Mulch (context priming from Hindsight bank), pi-lens (output gating/validation).
- **Files / functions touched:** CLI-Anything harness adapter (warren invocation), dispatch_task phase handler, structured JSON capture/parser, Warren output adapter, protocol step output store.
- **Guards/limits:** maxDurationMs must be >= 10000ms and <= 600000ms (10s to 10min). changedFiles paths must be relative and within repo root (no path traversal). testResults.passed and failed must be >= 0. summary must be <= 2000 characters. Exit code 0 treated as exitStatus "success"; non-zero mapped per Warren Exit Code Mapping table below.
- **pi-lens scope clarification:** In this story, "pi-lens gating" refers to output validation at the harness layer (schema validation of the structured JSON output), not P0.5's TDI diagnostic tooling. The harness validates: (1) output parses as valid JSON, (2) `exitStatus` is one of the 4-value enum, (3) `changedFiles` is a string array, (4) `testResults` has numeric passed/failed. Malformed output is captured as `exitStatus: "logic"` with the raw output in `partialOutput`.
- **Warren Exit Code Mapping:**

  | Warren Exit Code | exitStatus | Meaning |
  |-----------------|------------|---------|
  | 0 | "success" | Normal completion |
  | 1 | "logic" | Task logic error (test failure, assertion failure) |
  | 2 | "transient" | Retryable failure (network timeout, API rate limit) |
  | 3 | "overflow" | Resource limit exceeded (budget, turn cap, memory) |
  | >=4 or signal | "transient" | Unknown failure — treated as retryable by default |

  Exit codes are mapped by the harness adapter. If Warren exits with a signal (SIGKILL, SIGTERM), the harness maps to `exitStatus: "transient"` (killed by resource limit or timeout) unless the signal was user-initiated, in which case it maps to `exitStatus: "logic"` (user cancelled).
- **Timeout alignment (CC-7):** maxDurationMs must be ≤ P1.1 timeoutMs upper bound (900s post-CC-7 fix). P1.6 max 600s is well within P1.1's 900s limit. The harness enforces maxDurationMs as a hard wall; Warren receives it via the manifest.

## Observability Contract (CC-9)

- Every dispatch_step logs: `{ requestId, phase, agentId, timestamp, duration, exitStatus }`
- requestId propagates from P1.1 A2A layer
- Errors include: `{ code, message, stack?: string }`
- Sub-timing breakdown: `mulch_prime_ms`, `warren_burrow_ms`, `pi_execution_ms`, `pi_lens_gating_ms`

## Files to Modify

- `src/cli-anything/harness/warren-adapter.ts`
- `src/swarmclaw/protocols/phases/dispatch-task.ts`
- `src/cli-anything/output/structured-capture.ts`
- `src/swarmclaw/sessions/step-output-store.ts`
- `tests/e2e/pi-team-dispatch.test.ts`

## Security Invariants

- INV-1: `warren run` invoked with `--repo` scoped to the session's repository; no cross-repo file access.
- INV-2: changedFiles paths validated against path traversal using decode-then-check: URL-decode the path, normalize Unicode (NFC), then reject paths containing `..` segments, URL-decoded `..` (`%2e%2e`, `%2E%2E`), double-encoded variants, absolute paths, symlinks, and Unicode-normalized traversal sequences.
- INV-3: Warren process runs with resource limits enforced via Node.js `child_process.execFile` with `resourceLimits` option (where supported by the runtime) and a harness-level watchdog timer that checks memory usage at 5-second intervals. If the process exceeds 4GB RSS, the harness sends SIGTERM. CPU limiting is advisory (monitoring only) in Phase 1 — the harness logs CPU usage but does not kill for CPU overuse. Full cgroup-based enforcement is a Phase 2 concern when running in container environments.

## Definition of Done

- [ ] **Impl:** dispatch_task phase handler invokes CLI-Anything harness with task payload from protocol config.
- [ ] **Impl:** CLI-Anything harness generates `.canopy/agent.json` manifest from task config and invokes `warren run --config .canopy/agent.json`.
- [ ] **Impl:** Warren output parsed as structured JSON with schema validation (exitStatus, changedFiles, testResults, summary, durationMs).
- [ ] **Impl:** Structured JSON stored as protocol step output and retrievable via session status API.
- [ ] **Contract:** Step output schema enforced: exitStatus 4-value enum ("success"|"transient"|"overflow"|"logic"), changedFiles is string array, testResults has passed/failed numbers, summary <= 2000 chars.
- [ ] **Contract:** Failure output schema enforced: exitStatus failure variant, error string, exitCode number, partialOutput nullable string.
- [ ] **Integration:** Mulch priming loads context from specified Hindsight bank before Warren execution.
- [ ] **Integration:** pi-lens gating validates Pi team output before capture (reject malformed output).
- [ ] **Security:** changedFiles paths validated via decode-then-check: URL-decode, NFC-normalize Unicode, then reject `..` segments, encoded traversals (`%2e%2e`, double-encoded), absolute paths, and symlinks.
- [ ] **Security:** Warren process resource-limited via harness watchdog: memory enforced (SIGTERM if >4GB RSS, checked every 5s), CPU advisory-only in Phase 1.
- [ ] **Test (empty bank):** Dispatch with empty Hindsight bank -> verify Pi team executes successfully with `mulchPrimed: false`.
- [ ] **Test (unit):** Harness adapter constructs correct `warren run --config` invocation and manifest from dispatch_task config.
- [ ] **Test (e2e demo — MANDATORY):** Run dispatch_task step -> verify Warren executes -> verify structured JSON captured as step output with exitStatus, changedFiles, testResults, summary fields.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
