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

**Demonstrable behavior:** Given an active qds-factory protocol session, When the dispatch_task step executes, it invokes CLI-Anything harness -> `warren run --config .canopy/agent.json` with Mulch-primed Pi team -> Pi agents execute a sample task (e.g., "create a hello-world function") -> structured JSON `{ exitStatus: "success", changedFiles: ["src/hello.ts"], testResults: { passed: 1, failed: 0 }, summary: "...", durationMs: 4200, mulchPrimed: true, artifacts: [] }` is captured as the protocol step output.

**Wiring closed:** On completion of this story, a dispatch_task protocol step yields a single demonstrable Pi team result in structured JSON, using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P0.1 (CLI-Anything harness skeleton + env propagation), P0.5 (pi-lens gating), P0.9 (Hindsight for Mulch priming), P1.4 (protocol template with dispatch_task phase).

> **Predecessor reconciliation (PR #21, QDS-EXEC-001):** P0.3 (mixed-model 3-agent demo) is **deferred** per the 4-week execution plan §4.2 — its multi-model dispatch is re-proven by this story on the real protocol path, so the demo is redundant. The prior edge "P0.3 (CLI-Anything harness operational)" was a **pre-existing mislabel**: P0.3 is a demo, not the harness. The CLI-Anything harness generator itself is delivered by P0.1 (listed above), which is the true "harness operational" dependency. Corrected so the predecessor no longer points at a deferred story.

## Acceptance Criteria

1. **(make-or-break)** Given an active protocol session with a dispatch_task step, When the step executes, Then CLI-Anything harness is invoked with the task payload, `warren run --config .canopy/agent.json` executes (manifest-driven per P0.3 canonical pattern), and the step output is structured JSON containing `{ exitStatus: "success"|"transient"|"overflow"|"logic", changedFiles: string[], testResults: { passed: number, failed: number }, summary: string, durationMs: number, artifacts: Array<{ name: string, path: string }> }`.
2. Given the Pi team completes successfully, When the structured JSON is captured, Then it is stored as the protocol step output and retrievable via the SwarmClaw session status API.
3. Given `warren run` exits with non-zero code or times out, When the harness captures the failure, Then the step output is `{ exitStatus: "transient"|"overflow"|"logic", error: string, exitCode: number | null, partialOutput: string | null, durationMs: number }` and the protocol engine does not crash. When Warren is killed by a signal, `exitCode` is `null`. Consumers must handle `null` exitCode alongside the exitStatus enum.
4. Given a fresh repository with no prior Mulch expertise in the specified Hindsight bank, When the dispatch_task step executes with Mulch priming, Then the Pi team runs without primed context (empty context is acceptable), the step output includes `mulchPrimed: false`, and execution succeeds with `exitStatus: "success"` — empty bank is not an error condition.

## Technical Notes

- **exitStatus taxonomy (CC-1, aligned with P0.3):** Previous `status: 'failure'` maps to `exitStatus: 'transient'|'overflow'|'logic'`. Consumers must handle all three failure modes. This aligns with P0.3's canonical taxonomy. `"success"` = normal completion. `"transient"` = retryable failure (network, timeout). `"overflow"` = resource limit exceeded. `"logic"` = task logic error. P0.3 previously used `exitStatus: 'logic_error'` (corrected to `'logic'` in Round 8 Wave 5b). The canonical CC-1 value is `'logic'`. Any encounter with `'logic_error'` in other stories should be treated as a typo for `'logic'`.
- **Warren CLI surface (CC-2, aligned with P0.3):** ⚠️ AMENDED 2026-07-20 — the real Warren CLI (0.10.0) has no `--config` flag; canonical invocation is `warren run <agent> <project> -p "<prompt>" [--provider --model]` against a running Warren server, with team/task params carried in the agent-team extension config the harness materializes into the run workspace (not `.canopy/agent.json`). See P0.3 CC-2 (amended) for the authoritative surface; all `warren run --config .canopy/agent.json` references in this story must be read through that amendment and reconciled at pre-dev review of this story.
  ```
  .canopy/agent.json example:
  {
    "agentId": "pi-team-worker",
    "model": "claude-sonnet",
    "extensions": ["agent-team.ts"],
    "repo": ".",
    "mulchBank": "qds-factory",
    "maxDurationMs": 600000
  }
  ```
- **PI extension files (CC-3):** Protocol engine (P1.4) resolves phase kind → PI extension. P1.6's dispatch_task step uses `extensions/agent-team.ts` via P1.4's phase→extension mapping table. Extension file must match the phase kind per P1.4's mapping table. For dispatch_task, the correct extension is `agent-team.ts`. The `.canopy/agent.json` config layer sits between the protocol engine and Warren invocation — the harness writes the manifest before calling `warren run --config`.
- **Field name alignment (CC-4):** Field name `changedFiles` matches P0.3 canonical output. All stories producing file-change lists use this name.
- **mulchBank vs mulchBankId field mapping:** The `.canopy/agent.json` manifest uses `mulchBank` (Warren's field name). The dispatch_task config uses `mulchBankId` (P1.4's naming convention). The harness adapter translates: `config.mulchBankId` → `manifest.mulchBank`.
- **Contracts/Schema:** dispatch_task config: `{ taskBrief: string, targetAgentIds: string[], mulchBankId: string, maxDurationMs: number, captureFormat: "structured-json" (only supported value in Phase 1; enum exists for forward compatibility — future: 'yaml', 'toml'; matches P1.4's dispatch_task config) }`. Harness invocation: `warren run --config .canopy/agent.json` (manifest-driven; harness generates manifest from config). Step output (success): `{ exitStatus: "success", changedFiles: string[], testResults: { passed: number, failed: number, coverage?: number }, summary: string, durationMs: number, mulchPrimed: boolean, mulchPrimeError?: string, artifacts: Array<{ name: string, path: string }> }`. Step output (failure): `{ exitStatus: "transient"|"overflow"|"logic", error: string, exitCode: number | null, partialOutput: string | null, durationMs: number, mulchPrimed: boolean, mulchPrimeError?: string }`. If Mulch priming succeeded before Warren failed, `mulchPrimed` is `true`. If not attempted or failed, it is `false`. The `coverage` field in the Warren output is optional. If present, it must be a non-negative number. If absent, pi-lens validation skips coverage checks. Implementations should not assume coverage is always provided.
- **Integration points:** SwarmClaw protocol engine (dispatch_task phase handler), CLI-Anything harness adapter, Warren CLI (`warren run --config`), Pi agents (inside burrow), Mulch (context priming from Hindsight bank), pi-lens (output gating/validation).
- **Files / functions touched:** CLI-Anything harness adapter (warren invocation), dispatch_task phase handler, structured JSON capture/parser, Warren output adapter, protocol step output store.
- **Guards/limits:** maxDurationMs must be >= 10000ms and <= 600000ms (10s to 10min). changedFiles paths must be relative and within repo root (no path traversal). testResults.passed and failed must be >= 0. When `testResults.passed + testResults.failed === 0`, the output should include `testsExecuted: false` to disambiguate 'no tests ran' from 'zero tests exist'. summary must be <= 2000 characters. `partialOutput` is truncated to 10000 characters. If raw output exceeds this, suffix with `[truncated, N bytes total]`. Exit code 0 treated as exitStatus "success"; non-zero mapped per Warren Exit Code Mapping table below.
- **pi-lens scope clarification:** In this story, "pi-lens gating" refers to output validation at the harness layer (schema validation of the structured JSON output), not P0.5's TDI diagnostic tooling. The harness validates: (1) output parses as valid JSON, (2) `exitStatus` is one of the 4-value enum, (3) `changedFiles` is a string array, (4) `testResults` has numeric passed/failed, (5) `mulchPrimed` is a boolean, (6a) each `changedFiles` path must not contain `..` segments after normalization, and (6b) each `artifacts[].path` must not contain `..` segments after normalization — both must be relative to the workspace root, and absolute paths or paths escaping the workspace are rejected. Malformed output is captured as `exitStatus: "logic"` with the raw output in `partialOutput`.
- **Warren Exit Code Mapping:**

  | Warren Exit Code | exitStatus | Meaning |
  |-----------------|------------|---------|
  | 0 | "success" | Normal completion |
  | 1 | "logic" | Task logic error (test failure, assertion failure) |
  | 2 | "transient" | Retryable failure (network timeout, API rate limit) |
  | 3 | "overflow" | Resource limit exceeded (budget, turn cap, memory) |
  | != 0 and not in {1,2,3}, including signals and negative codes | "transient" | Unknown failure — treated as retryable by default. Signal-terminated processes default to `transient`. Harness-initiated signals (RSS watchdog, userCancel) override via signal-origin metadata — see signal-origin paragraph below. |

  Exit codes are mapped by the harness adapter. If Warren exits with a signal (SIGKILL, SIGTERM), the harness consults signal-origin metadata to determine the mapping: (1) if the harness-level RSS watchdog flag is set (watchdog killed the process for exceeding 4GB RSS), map to `exitStatus: "overflow"`; (2) if a `userCancel`/`requestedShutdown` flag is present (explicit user-initiated termination), map to `exitStatus: "logic"`; (3) if signal origin is unknown (including kernel OOM, which a user-space harness cannot portably detect), default to `exitStatus: "transient"` (safe retryable default). The exit code mapping distinguishes harness-initiated signals (RSS watchdog, userCancel — tracked via internal flag) from externally-initiated signals (kernel, other processes — no metadata available). Externally-initiated signals always map to `transient`. The "signal-origin metadata" reference applies only to harness-initiated kills.
- **Timeout alignment (CC-7):** maxDurationMs must be ≤ P1.1 timeoutMs upper bound (900s post-CC-7 fix). P1.6 max 600s is well within P1.1's 900s limit. The harness enforces maxDurationMs as a hard wall; Warren receives it via the manifest.
- **Hindsight unreachable during priming:** If Hindsight is unreachable during Mulch priming, the harness logs a warning, sets `mulchPrimed: false`, and proceeds. The step does not fail due to priming unavailability. `mulch_prime_ms` records the elapsed time until failure. The `mulchPrimeError` field contains the error message. Successful priming sets `mulchPrimeError` to undefined/null. `mulchPrimeError` is present in the output schema only when priming failed (optional field).

- **durationMs stopwatch semantics:** `durationMs` measures wall-clock time from `warren run` process spawn to process exit. It excludes Mulch priming time (captured separately as `mulch_prime_ms`).
- **Warren exit code contract assumption:** This exit code mapping assumes Warren uses: 0=ok, 1=logic-error, 2=transient, 3=overflow. If Warren's actual exit code convention differs, the harness adapter must be updated to match.

## Observability Contract (CC-9)

- Every dispatch_step logs: `{ requestId, phase, agentId, timestamp, duration, exitStatus }`
- requestId propagates from P1.1 A2A layer
- Errors include: `{ code, message, stack?: string }`
- Sub-timing breakdown: `mulch_prime_ms`, `warren_burrow_ms`, `pi_execution_ms`, `pi_lens_gating_ms`. Note: `warren_burrow_ms` measures Warren's sandbox setup overhead (if any). `pi_execution_ms` measures the agent's execution time inside Warren. These are separate phases within `durationMs`. If Warren does not expose this breakdown, both fields report 0 and `durationMs` remains the authoritative metric. When Mulch priming fails and Warren is not invoked, `warren_burrow_ms`, `pi_execution_ms`, and `pi_lens_gating_ms` are reported as 0. `mulch_prime_ms` reports elapsed time until failure.

## Files to Modify

- `src/cli-anything/harness/warren-adapter.ts`
- `src/swarmclaw/protocols/phases/dispatch-task.ts`
- `src/cli-anything/output/structured-capture.ts`
- `src/swarmclaw/sessions/step-output-store.ts`
- `tests/e2e/pi-team-dispatch.test.ts`

## Security Invariants

- INV-1: `warren run` scoped to the session's repository via the `repo` field in the generated `.canopy/agent.json` manifest; no cross-repo file access.
- INV-2: changedFiles paths validated against path traversal using decode-then-check in two stages: (1) **Pre-decode:** inspect the raw path for any percent-encoded `..` sequences (e.g. `%2e%2e`, `%2E%2E`) and evidence of double-encoding (e.g. `%252e` or any percent-encoded percent signs) — reject immediately if found. (2) **Post-decode:** URL-decode the path, normalize Unicode (NFC), then reject paths containing literal `..` segments, absolute paths, symlinks, and Unicode-normalized traversal sequences. The pre-decode check catches double-encoded traversals before they survive the first decode; the post-decode literal check catches anything that decoded to `..`. Symlink detection uses two complementary mechanisms: (1) **Path validation** (lstat-based) inspects paths reported by Warren's structured JSON output before the harness processes them. This is best-effort — it detects pre-existing symlinks at validation time but cannot prevent symlink creation between validation and use. (2) **File-read operations** performed by the harness itself (e.g., capturing partial output, reading artifacts) MUST use `fs.open(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)`. The `O_NOFOLLOW` flag causes the OS to atomically reject symlinks at the point of file access, eliminating TOCTOU for harness-initiated reads. On platforms where `O_NOFOLLOW` is unavailable, the harness falls back to lstat + open with a documented TOCTOU acceptance note. The lstat-based path-validation TOCTOU remains an accepted limitation for the validation pass since the harness does not control Warren's internal file operations — Warren runs inside its own sandbox (burrow) and is responsible for its own path safety.
- INV-3: Warren process runs with resource limits enforced by the harness-level RSS watchdog (checking memory every 200ms and sending SIGTERM if RSS > 4GB). After sending SIGTERM, the watchdog waits 5 seconds. If the Warren subprocess has not exited, SIGKILL is sent. The exit code maps to `exitStatus: 'overflow'` with `partialOutput` capturing any output received before termination, consistent with the Warren Exit Code Mapping table's treatment of resource-limit violations. The 200ms interval limits the window in which a fast-allocating process can exceed the cap undetected; it balances enforcement responsiveness against the overhead of reading `/proc/[pid]/statm` (Linux) or `ps` (macOS) at high frequency. Note: `child_process.execFile` does not support a `resourceLimits` option — that option is specific to `worker_threads`. If a future refactor switches to `worker_threads` or a runtime that supports per-process resource limits, `resourceLimits` can be applied then. CPU limiting is advisory (monitoring only) in Phase 1 — the harness logs CPU usage but does not kill for CPU overuse. Full cgroup-based enforcement is a Phase 2 concern when running in container environments.

## Definition of Done

- [ ] **Impl:** dispatch_task phase handler invokes CLI-Anything harness with task payload from protocol config.
- [ ] **Impl:** CLI-Anything harness generates `.canopy/agent.json` manifest from task config and invokes `warren run --config .canopy/agent.json`.
- [ ] **Impl:** Warren output parsed as structured JSON with schema validation (exitStatus, changedFiles, testResults, summary, durationMs).
- [ ] **Impl:** Structured JSON stored as protocol step output and retrievable via session status API.
- [ ] **Contract:** Step output schema enforced: exitStatus 4-value enum ("success"|"transient"|"overflow"|"logic"), changedFiles is string array, testResults has passed/failed numbers, summary <= 2000 chars.
- [ ] **Contract:** Failure output schema enforced: exitStatus failure variant, error string, exitCode number | null, partialOutput nullable string.
- [ ] **Integration:** Mulch priming loads context from specified Hindsight bank before Warren execution.
- [ ] **Integration:** pi-lens gating validates Pi team output before capture (reject malformed output).
- [ ] **Security:** changedFiles paths validated via decode-then-check in two stages: (1) pre-decode rejects percent-encoded `..` and double-encoding, (2) post-decode rejects literal `..`, absolute paths, symlinks after URL-decode and NFC-normalize. Harness file-read operations use `O_NOFOLLOW` to atomically reject symlinks at access time (see INV-2).
- [ ] **Security:** Warren process resource-limited via harness watchdog: memory enforced (SIGTERM if >4GB RSS, checked every 200ms, SIGKILL after 5s grace period if process has not exited), CPU advisory-only in Phase 1.
- [ ] **Test (empty bank):** Dispatch with empty Hindsight bank -> verify Pi team executes successfully with `mulchPrimed: false`.
- [ ] **Test (unit):** Harness adapter constructs correct `warren run --config` invocation and manifest from dispatch_task config.
- [ ] **Test (e2e demo — MANDATORY):** Run dispatch_task step -> verify Warren executes -> verify structured JSON captured as step output with exitStatus, changedFiles, testResults, summary fields.
- [ ] **Test (summary truncation):** Warren output with summary exceeding 2000 characters -> verify harness adapter truncates to 2000 with `[truncated, N chars total]` suffix. This tests the Warren-layer ceiling. Pi-lens display truncation (500 chars) is tested separately.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
