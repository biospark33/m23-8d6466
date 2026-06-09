# P1.4: Author qds-factory Protocol Template (dispatch->parallel->compare->decide->summarize)

**Story Points:** 4

## Spec Reference

- PRD §8, §9; FR-OR-1, FR-OR-2
- Phase exit gate: PRD §13 Phase 1 clause 4

## User Story

As a QDS factory operator,
I want a reusable protocol template that orchestrates the full factory pipeline (dispatch, parallel implementation, compare, decide, summarize),
so that any intake session can be driven through a standardized multi-phase orchestration without ad-hoc scripting.

## Overview

Author a QDS factory protocol template as a JSON document defining the canonical orchestration flow: (1) dispatch_task to assign work, (2) parallel phase with 3 branches (one per Pi implementer agent), (3) compare phase to diff outputs, (4) decide phase to select the best output, (5) summarize phase to produce a final report. Register this template via the SwarmClaw API. On test invocation, the protocol engine advances through all phases, producing structured output at each step. This story delivers the template and validates it is invokable.

## E2E Slice

**Demonstrable behavior:** A POST to the SwarmClaw template registration endpoint stores the qds-factory protocol. A subsequent invocation call with a session ID runs the protocol through all 5 phases, producing structured JSON output for each phase. The final summarize step returns a merged result containing references to all prior phase outputs.

**Wiring closed:** On completion of this story, the qds-factory protocol template is registered in SwarmClaw and a test invocation advances through all 5 phases producing structured outputs, using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P0.7 (SwarmClaw agent/MCP registration), P0.11 (Phase 0 exit gate).

## Acceptance Criteria

1. **(make-or-break)** Given SwarmClaw is running, When the qds-factory protocol template is registered via POST to the template API, Then the response is 201 with `{ "templateId": "qds-factory", "version": "1.0.0", "phaseCount": 5 }`.
2. Given the template is registered, When it is invoked with `{ "sessionId": "{id}", "input": { "taskBrief": "...", "stories": [...] } }`, Then the protocol engine executes phases in order: dispatch_task -> parallel (3 branches) -> compare -> decide -> summarize, and each phase produces a structured JSON output persisted as step results.
3. Given the parallel phase has 3 branches, When one branch fails or times out, Then the compare phase still receives outputs from the remaining branches (graceful degradation, not a full protocol abort).

## Technical Notes

- **Contracts/Schema:** Protocol template: `{ id: "qds-factory", version: "1.0.0", phases: [ { kind: "dispatch_task", config: {...} }, { kind: "parallel", config: { branches: [{ participantAgentIds: [...], facilitatorAgentId: "...", observerAgentIds: [...] }, ...] } }, { kind: "compare", config: {} }, { kind: "decide", config: {} }, { kind: "summarize", config: {} } ] }`. Phase output: `{ phaseIndex: number, kind: string, status: "completed"|"failed"|"skipped", output: any, startedAt: ISO8601, completedAt: ISO8601 }`.
- **Integration points:** SwarmClaw protocol template registration API, SwarmClaw protocol engine (executor), phase handlers for each kind (dispatch_task, parallel, compare, decide, summarize).
- **Files / functions touched:** Protocol template definition (JSON), SwarmClaw template registration endpoint, protocol engine phase router, phase handler implementations for compare/decide/summarize (dispatch_task and parallel exist from P0.1).
- **Guards/limits:** parallel config requires >= 2 branches and <= 8 branches. Each branch must specify at least one participantAgentId. compare phase requires parallel phase to have completed (at least partially). decide phase requires compare output. Template version follows semver.

## Files to Modify

- `src/swarmclaw/protocols/templates/qds-factory.json`
- `src/swarmclaw/protocols/registry.ts`
- `src/swarmclaw/protocols/phases/compare.ts`
- `src/swarmclaw/protocols/phases/decide.ts`
- `src/swarmclaw/protocols/phases/summarize.ts`
- `tests/e2e/protocol-template.test.ts`

## Security Invariants

- INV-1: Template registration requires authentication; only authorized agents can register protocol templates.
- INV-2: Protocol invocation scoped to sessionId; cross-session data access is forbidden.
- INV-3: parallel branch participantAgentIds must reference registered agents; unregistered agent IDs rejected at template validation time with 422.

## Definition of Done

- [ ] **Impl:** qds-factory protocol template authored as JSON with 5 phases: dispatch_task, parallel (3 branches), compare, decide, summarize.
- [ ] **Impl:** Template registered via SwarmClaw API and retrievable by templateId "qds-factory".
- [ ] **Impl:** compare phase handler collects parallel branch outputs and produces a diff/comparison structure.
- [ ] **Impl:** decide phase handler evaluates comparison and selects a winner with justification.
- [ ] **Impl:** summarize phase handler merges all prior phase outputs into a final structured report.
- [ ] **Contract:** Template schema validated on registration: phaseCount >= 2, each phase has valid `kind`, parallel branches >= 2.
- [ ] **Integration:** Protocol engine advances through all 5 phases in sequence on invocation.
- [ ] **Integration:** Partial branch failure in parallel phase does not abort protocol; compare receives available outputs.
- [ ] **Security:** Template registration endpoint requires authenticated agent; unauthenticated requests rejected with 401.
- [ ] **Test (unit):** Template validation rejects missing phases, invalid phase kinds, and parallel with < 2 branches.
- [ ] **Test (e2e demo — MANDATORY):** Register template -> invoke with test session -> verify 5 phase outputs produced with correct phaseIndex progression and structured JSON at each step.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
