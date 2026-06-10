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
4. Given 3 parallel branches with distinct outputs, When the compare phase executes, Then it produces a `ComparisonResult` with a 3x3 overlap matrix and a recommendation containing ranked preferred branches with rationale.
5. Given comparison results where branch A scores 0.85 and branch B scores 0.80, When the decide phase executes, Then it selects branch A as winner with a `DecisionResult` containing scores, breakdown, and rationale (no tie flag since delta > 0.1).
6. Given a protocol template with `participantAgentId` "agent-alpha" and no corresponding `.canopy/agent.json` for "agent-alpha", When the protocol engine validates the phase, Then it returns error -32602 (Invalid params: unconfigured agent) before invoking any phase.
7. Given a protocol invocation with `participantAgentId` "rogue-agent" that is not registered via P0.7's agent registration, When the protocol engine validates participants, Then it returns HTTP 422 with body `{ error: { code: -32013, message: "Agent not registered: rogue-agent" } }` and does NOT execute any phase.

## Phase-to-PI Extension Mapping

Each protocol phase `kind` maps to a concrete PI extension file that Warren loads and invokes:

| Phase Kind      | PI Extension File          | Description                          |
|-----------------|----------------------------|--------------------------------------|
| dispatch_task   | extensions/agent-team.ts   | Single-agent task dispatch           |
| parallel        | extensions/pi-pi.ts        | Multi-agent parallel execution       |
| compare         | extensions/coms-net.ts     | Cross-agent comparison via coms-net  |
| decide          | extensions/coms-net.ts     | Agent vote/LLM judge decision        |
| sequential      | extensions/agent-chain.ts  | Sequential agent pipeline            |
| summarize       | extensions/cross-agent.ts  | Cross-agent result aggregation       |

**Canopy config layer:**
- Each participant agent has a `.canopy/agent.json` config file
- Config specifies: agentId, model, extensions, mulchBank, capabilities
- Warren loads config and invokes `pi -e extensions/<mapped-file>.ts`
- Protocol engine resolves phase `kind` to extension via the table above

**Coms-net API** (used by compare/decide phases):
- `coms_net_send(channel, payload)` -> void
- `coms_net_await(channel, timeoutMs)` -> payload
- `coms_net_get(channel)` -> payload | null
- `coms_net_list()` -> channel[]

## Phase Algorithms

### compare Phase Algorithm
The compare phase uses structured diff via coms-net.ts. Algorithm:
1. Gather all branch outputs via `coms_net_list(sessionId, phaseId)`.
2. For each branch output, extract `changedFiles`, `testResults`, and `summary` fields.
3. Compute pairwise comparison: file overlap (Jaccard similarity of changed file paths), test pass rate delta, and semantic similarity of summaries.
4. Produce a `ComparisonResult`: `{ branches: [{ agentId, fileCount, testPassRate, summary }], overlapMatrix: [[number]], recommendation: { preferredBranches: [agentId[]], rationale: string } }`.

**Minimum branches for compare:** The compare phase requires >= 1 successful branch output. If all parallel branches fail, the compare phase produces `ComparisonResult` with `branches: []`, `overlapMatrix: []`, and `recommendation: { preferredBranches: [], rationale: "All branches failed" }`. The protocol then proceeds to decide phase, which produces `DecisionResult` with `winner: null`, `tie: false`, and `rationale: "No branches to decide between"`. The summarize phase reports the complete failure.

### decide Phase Algorithm
The decide phase uses a configurable decision mechanism. Default algorithm: weighted scoring.
1. Score each branch: `testPassRate * 0.5 + uniqueFileCoverage * 0.3 + summaryQuality * 0.2`.
2. Rank branches by score.
3. If top-2 scores are within 0.1 (tie), flag for human review in the output.
4. Produce a `DecisionResult`: `{ winner: agentId, scores: [{ agentId, score, breakdown: { testPassRate, uniqueFileCoverage, summaryQuality } }], tie: boolean, rationale: string }`.

**Tie-breaking:** If top-2 scores are within 0.1, the DecisionResult includes `tie: true` and `rationale: "Scores within 0.1 threshold — manual review recommended"`. No automatic tie-breaking — human review is the tie resolution path. The protocol engine pauses the session and emits a `tie_detected` event.

### summarize Phase Algorithm
The summarize phase aggregates all prior phase outputs into a final structured report:
1. Collect outputs from all completed phases (dispatch_task, parallel, compare, decide).
2. Merge into a structured report: `{ sessionId, templateId, phases: [{ phaseIndex, kind, status, output, startedAt, completedAt }], finalResult: { winner: DecisionResult.winner | null, summary: string, artifacts: string[] }, metadata: { totalDurationMs, phaseCount, completedPhaseCount } }`.
3. If decide phase selected a winner, `finalResult.summary` includes the winner's summary and test results.
4. If all branches failed, `finalResult.summary` describes the failure with per-branch error details.

## Phase Config Binding

Each phase's `participantAgentIds` must correspond to entries in `.canopy/agent.json`. The protocol engine resolves `participantAgentIds` to Warren configs at invocation time: `{agentId}.canopy/agent.json` provides the Warren invocation config for that agent. If an agentId has no corresponding `.canopy/agent.json`, the protocol engine rejects the phase with error -32602 (Invalid params: unconfigured agent).

The `.pi/agents/` directory contains expert markdown files that Warren loads via `.canopy/agent.json`'s `expertFile` field. The protocol engine does NOT read `.pi/agents/` directly — it passes the agent config to Warren, which loads the expert file.

## Technical Notes

- **Contracts/Schema:** Protocol template: `{ id: "qds-factory", version: "1.0.0", phases: [ { kind: "dispatch_task", config: {...} }, { kind: "parallel", config: { branches: [{ participantAgentIds: [...], facilitatorAgentId: "...", observerAgentIds: [...] }, ...] } }, { kind: "compare", config: {} }, { kind: "decide", config: {} }, { kind: "summarize", config: {} } ] }`. Phase output: `{ phaseIndex: number, kind: string, status: "completed"|"failed"|"skipped", output: ComparisonResult | DecisionResult | Record<string,unknown>, startedAt: ISO8601, completedAt: ISO8601 }`. The `output` field is typed per phase: `ComparisonResult` for compare (conforms to structure defined in Phase Algorithms section), `DecisionResult` for decide (conforms to structure defined in Phase Algorithms section), and `Record<string,unknown>` for all other phases (dispatch_task, parallel, summarize).
  - `dispatch_task` — implemented via `extensions/agent-team.ts`
  - `parallel` — implemented via `extensions/pi-pi.ts`
  - `compare` — implemented via `extensions/coms-net.ts` (structured diff algorithm defined above)
  - `decide` — implemented via `extensions/coms-net.ts` (weighted scoring algorithm defined above)
  - `summarize` — implemented via `extensions/cross-agent.ts`
- **Integration points:** SwarmClaw protocol template registration API, SwarmClaw protocol engine (executor), phase handlers for each kind (dispatch_task, parallel, compare, decide, summarize). Protocol engine phase router resolves each `kind` to its PI extension file per the Phase-to-PI Extension Mapping table above. Protocol engine validates all participantAgentIds against `.canopy/agent.json` before phase execution.
- **Files / functions touched:** Protocol template definition (JSON), SwarmClaw template registration endpoint, protocol engine phase router (extension resolution), protocol engine config binding validator, PI extension files: `extensions/agent-team.ts`, `extensions/pi-pi.ts`, `extensions/coms-net.ts`, `extensions/cross-agent.ts`, phase handler implementations for compare/decide/summarize (dispatch_task and parallel exist from P0.1).
- **Guards/limits:** parallel config requires >= 2 branches and <= 8 branches. Each branch must specify at least one participantAgentId. compare phase requires parallel phase to have completed (at least partially). decide phase requires compare output. Template version follows semver. All participantAgentIds must have a corresponding `.canopy/agent.json` — unconfigured agents cause rejection with error -32602.
- **Template versioning:** Protocol templates are immutable once registered. Updates require a new templateId or a new version number. In-flight sessions pin the template version at invocation time — the session runs against the version that was current when it started. New invocations after a template update use the new version. Old versions remain retrievable (for debugging) but cannot be invoked for new sessions.

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
- [ ] **Test (unit — INV-3 security):** Invoke protocol with one registered and one unregistered agent — verify 422 response, verify no phase execution begins, verify registered agent is NOT invoked.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
