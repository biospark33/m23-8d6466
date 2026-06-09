# P0.11: Phase-0 Exit Gate (§13 Aggregated Assertion Check)

**Story Points:** 3

## Spec Reference

- PRD §13 (Phase Exit Gates); FR-OR-4, FR-EX-1..10, FR-MEM-1, FR-CP-9..11
- Phase exit gate: PRD §13 Phase 0 full gate

## User Story

As a QDS project lead,
I want a single binary gate script that asserts every Phase-0 deliverable is live,
so that I can promote to Phase 1 with confidence that no foundational component is missing (G1 — reliable infrastructure).

## Overview

This story creates a single executable gate script (`scripts/phase0-exit-gate.ts`) that runs a battery of assertions covering all P0 stories (P0.1 through P0.10). Each assertion maps to a PRD §13 Phase-0 clause. The script exits 0 on all-green or exits 1 with a detailed failure report on any red assertion. This is a 3-point unit because it requires writing assertion logic for 10 predecessor stories but no new infrastructure — it is purely a verification harness that aggregates existing functionality.

## E2E Slice

**Demonstrable behavior:** Run `npx tsx scripts/phase0-exit-gate.ts`. The script checks: env propagation (P0.1), coms viable (P0.2), mixed-model output (P0.3), guard fires (P0.4), pi-lens headless (P0.5), LSP live (P0.6), SwarmClaw+Hindsight MCP bridge (P0.7), webhook callback (P0.8), memory round-trip (P0.9), graph queries (P0.10). All green → exit 0 with `PHASE_0_GATE: PASS`. Any red → exit 1 with `PHASE_0_GATE: FAIL` and per-assertion failure details.

**Wiring closed:** On completion of this story, running the gate script produces a binary PASS/FAIL result for every §13 Phase-0 assertion using only code merged by this story and all predecessors (P0.1–P0.10). No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P0.1, P0.2, P0.3, P0.4, P0.5, P0.6, P0.7, P0.8, P0.9, P0.10 (all Phase-0 stories must be complete).

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given all P0.1–P0.10 stories are fully implemented and their systems are running, When `npx tsx scripts/phase0-exit-gate.ts` is executed, Then the script exits with code 0 and stdout contains `PHASE_0_GATE: PASS` with every assertion reporting green.
2. Given any single P0 predecessor is broken (e.g., SwarmClaw server is down), When the gate script runs, Then it exits with code 1, stdout contains `PHASE_0_GATE: FAIL`, and the specific failing assertion(s) are listed with error details — not a generic "tests failed" message.
3. Given the gate script is run in a clean environment where no P0 infrastructure is running, When it executes, Then it fails fast on the first assertion group (env propagation) and reports which env vars are missing — it never hangs waiting for a timeout on downstream assertions.

## Technical Notes

- **Contracts/Schema:**
  ```typescript
  // Gate assertion definition
  const GateAssertionSchema = z.object({
    id: z.string(),                         // e.g., "P0.7-mcp-bridge"
    story: z.string(),                      // e.g., "P0.7"
    prd_clause: z.string(),                 // e.g., "§13 P0 clause 7"
    description: z.string(),
    check: z.function().args().returns(z.promise(z.object({
      pass: z.boolean(),
      detail: z.string().optional(),
      duration_ms: z.number(),
    }))),
  });

  // Gate report
  const GateReportSchema = z.object({
    timestamp: z.string().datetime(),
    overall: z.enum(["PASS", "FAIL"]),
    assertions: z.array(z.object({
      id: z.string(),
      story: z.string(),
      pass: z.boolean(),
      detail: z.string().optional(),
      duration_ms: z.number(),
    })),
    total_duration_ms: z.number(),
  });
  ```

- **Integration points (each wired & exercised in this story):**
  - Environment variable checks — P0.1 assertions
  - Coms HTTP endpoint health — P0.2 assertions
  - Mixed-model output file verification — P0.3 assertions
  - Guard trigger test — P0.4 assertions
  - Pi-lens headless invocation — P0.5 assertions
  - LSP diagnostic request — P0.6 assertions
  - SwarmClaw `/api/agents` + `/api/mcp-servers/{id}/test` — P0.7 assertions
  - SwarmClaw `/api/webhooks/{id}` with test payload — P0.8 assertions
  - Hindsight retain→recall→reflect round-trip — P0.9 assertions
  - GitNexus query invocation — P0.10 assertions

- **Files / functions touched:**
  - `scripts/phase0-exit-gate.ts` — main gate script
  - `src/gate/assertions/p0-1-env.ts` — env propagation checks
  - `src/gate/assertions/p0-2-coms.ts` — coms viability checks
  - `src/gate/assertions/p0-3-mixed-model.ts` — mixed-model output checks
  - `src/gate/assertions/p0-4-guard.ts` — guard trigger checks
  - `src/gate/assertions/p0-5-pi-lens.ts` — pi-lens headless checks
  - `src/gate/assertions/p0-6-lsp.ts` — LSP diagnostics checks
  - `src/gate/assertions/p0-7-mcp-bridge.ts` — SwarmClaw MCP bridge checks
  - `src/gate/assertions/p0-8-webhook.ts` — webhook callback checks
  - `src/gate/assertions/p0-9-memory.ts` — memory round-trip checks
  - `src/gate/assertions/p0-10-gitnexus.ts` — graph query checks

- **Guards/limits:**
  - Per-assertion timeout: 30 seconds
  - Total gate script timeout: 600 seconds (10 minutes)
  - Fail-fast on env group: if P0.1 assertions fail, skip remaining assertions and report
  - Parallel assertion execution within groups where safe (P0.7–P0.10 can run in parallel)
  - Gate report written to `_bmad-output/sprint-artifacts/phase-0/phase0-gate-report.json`

## Files to Modify

> ≤10 unique paths, one per line.
- `scripts/phase0-exit-gate.ts`
- `src/gate/assertions/p0-1-env.ts`
- `src/gate/assertions/p0-7-mcp-bridge.ts`
- `src/gate/assertions/p0-8-webhook.ts`
- `src/gate/assertions/p0-9-memory.ts`
- `src/gate/assertions/p0-10-gitnexus.ts`
- `src/gate/gate-runner.ts`
- `tests/gate/phase0-exit-gate.test.ts`

## Security Invariants

> Concrete named invariants only — N/A NOT permitted when triggered.

No new security invariants are introduced by this story. The gate script operates in read-only mode against existing infrastructure and does not expose any new attack surface. All assertions use existing authenticated endpoints and do not store or log credentials. The gate report file (`phase0-gate-report.json`) contains only pass/fail status and does not include secrets, tokens, or environment variable values.

## Definition of Done

> 8–12 high-signal, story-specific boxes. NO lint/tests/typecheck filler.

- [ ] **Impl:** Gate script `scripts/phase0-exit-gate.ts` runs all 10 assertion groups (P0.1–P0.10) and produces a structured JSON report
- [ ] **Impl:** Each assertion group has at least one check that validates the corresponding story's E2E slice behavior
- [ ] **Impl:** Fail-fast behavior: P0.1 env check failure skips remaining groups and reports immediately
- [ ] **Impl:** Parallel execution: P0.7–P0.10 assertions run concurrently for faster gate completion
- [ ] **Contract:** `GateAssertionSchema` and `GateReportSchema` validated on all assertion definitions and output
- [ ] **Integration:** Gate script calls live SwarmClaw endpoints, Hindsight API, and GitNexus tools — no mocked dependencies
- [ ] **Test (unit/integration):** Gate script exits 0 when all predecessors are green; exits 1 with specific failure details when any predecessor is red
- [ ] **Test (guard):** Clean environment (no services running) → fail-fast on P0.1 with env var list; hanging service → per-assertion timeout fires and reports failure (no infinite hang)
- [ ] **Test (e2e demo — MANDATORY):** Run gate script against a fully provisioned Phase-0 environment → stdout contains `PHASE_0_GATE: PASS` → exit code 0 → `_bmad-output/sprint-artifacts/phase-0/phase0-gate-report.json` exists with all assertions passing
- [ ] **Test (report format):** Gate report JSON validates against `GateReportSchema` — includes timestamp, overall status, per-assertion results with durations

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
