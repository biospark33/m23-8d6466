# P1.4: Author qds-factory Protocol Template (dispatch->parallel->compare->decide->summarize)

**Story Points:** 4

## Spec Reference

- PRD §8, §9; FR-OR-1, FR-OR-2
- Phase exit gate: PRD §13 Phase 1 clause 4
- **Note:** FR-OR-1/FR-OR-2 are pre-pivot FRs referencing the Archon system. Post-pivot, this story fulfills the same capability via SwarmClaw protocol templates. PRD references are retained for backward traceability.

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
5. Given comparison results where branch A scores 0.85 and branch B scores 0.70, When the decide phase executes, Then it selects branch A as winner with a `DecisionResult` containing scores, breakdown, and rationale (no tie flag since delta > 0.1). AC5 uses phaseCount: 5 for the qds-factory template specifically. Templates with different phase counts are valid per the guards/limits (phaseCount >= 2).
6. Given a protocol template with `participantAgentIds` containing "agent-alpha" and no corresponding `.canopy/agent.json` for "agent-alpha", When the protocol is invoked, Then it returns error -32602 (Invalid params: unconfigured agent) before executing any phase (validation occurs at invocation time, not registration time).
7. Given a protocol invocation with `participantAgentIds` containing "rogue-agent" that is not registered via P0.7's agent registration, When the protocol engine validates participants at invocation time, Then it returns HTTP 422 with body `{ error: { code: -32011, message: "Agent not registered: rogue-agent" } }` and does NOT execute any phase.

## Phase-to-PI Extension Mapping

Each protocol phase `kind` maps to a concrete PI extension file that Warren loads and invokes:

| Phase Kind      | PI Extension File          | Description                          |
|-----------------|----------------------------|--------------------------------------|
| dispatch_task   | extensions/agent-team.ts   | Single-agent task dispatch           |
| parallel        | extensions/pi-pi.ts        | Multi-agent parallel execution       |
| compare         | extensions/coms-net.ts     | Cross-agent comparison via coms-net  |
| decide          | extensions/coms-net.ts     | Agent vote/LLM judge decision        |
| a2a_delegate    | extensions/a2a-delegate.ts | A2A delegation via P1.1 transport   |
| summarize       | extensions/cross-agent.ts  | Cross-agent result aggregation       |

> **Naming note:** The `summarize` phase was previously called `cross-agent` in P0.3. `summarize` is the canonical name. P0.3's table has been updated accordingly. The `a2a_delegate` phase routes delegation tasks through P1.1's A2A transport layer. Previously called `sequential` in earlier drafts.

**Canopy config layer:**
- Each participant agent has a `.canopy/agent.json` config file
- Config specifies: agentId, model, extensions, mulchBank, capabilities
- Warren loads config and invokes `pi -e extensions/<mapped-file>.ts`
- Protocol engine resolves phase `kind` to extension via the table above

**Coms-net API** (used by compare/decide phases):
- `coms_net_send(channel, payload)` -> void
- `coms_net_await(channel, timeoutMs)` -> payload
- `coms_net_get(channel)` -> payload | null
- `coms_net_list(sessionId, phaseId)` -> channel[]

> For the full coms-net transport contract, ComsLogEntry schema, and integration details, see P0.3 Technical Notes and CC-9.

## Phase Algorithms

### compare Phase Algorithm
The compare phase uses structured diff via coms-net.ts. Algorithm:
1. Gather all branch outputs via `coms_net_list(sessionId, phaseId)`.
2. For each branch output, extract `changedFiles`, `testResults`, and `summary` fields.
3. Compute pairwise comparison: file overlap (Jaccard similarity of changed file paths), test pass rate delta, and semantic similarity of summaries (default embedder: TF-IDF vectorizer over tokenized summary text, cosine similarity, clamped to [0,1]; alternative embedders acceptable if they produce values in [0,1]).
4. Produce a `ComparisonResult`: `{ branches: [{ agentId, fileCount, testPassRate, summaryQuality: number, summary }], overlapMatrix: [[number]], recommendation: { preferredBranches: [agentId[]], rationale: string } }`. The overlapMatrix is a single-metric Jaccard similarity matrix of changed file paths, provided as diagnostic output. The decide phase does not consume it — decide computes its own metrics directly from branch outputs. `summaryQuality` for each branch is computed as the mean cosine similarity between that branch's summary and every other successful branch's summary. With exactly two successful branches, both receive the same score equal to their mutual similarity. If only one branch succeeds, `summaryQuality` defaults to 0.5. The `overlapMatrix` is diagnostic output only — the decide phase does not consume it and computes its own metrics directly from branch outputs.

**All-zero branch metrics guard:** If all branches produce zero metrics (all scores are 0.0), the compare step sets `similarity_matrix` to all-zeros and the decide step emits `tie_detected` event. No division by zero occurs because the weighted scoring uses `max(totalWeight, 1)` as denominator.

**Normalization:** `summaryQuality` is clamped to [0.0, 1.0] before scoring. Negative values from cosine similarity are clamped to 0.0.

**Partial-failure handling:** When a branch produces a failure object (no `changedFiles`, `testResults`, `summary`), it is excluded from the similarity matrix but included in the comparison results as `status: "failed"`. The decide algorithm treats failed branches as scoring 0.0.

**Minimum branches for compare:** The compare phase requires >= 1 successful branch output. If all parallel branches fail, the compare phase produces `ComparisonResult` with `branches: []`, `overlapMatrix: []`, and `recommendation: { preferredBranches: [], rationale: "All branches failed" }`. The protocol then proceeds to decide phase, which produces `DecisionResult` with `winner: null`, `tie: false`, and `rationale: "No branches to decide between"`. The summarize phase reports the complete failure. When all branches fail, the protocol engine emits a `no_viable_output` event with payload: `{ sessionId, templateId, failedBranches: [{ branchId, error }] }`.

### decide Phase Algorithm
The decide phase uses a configurable decision mechanism. Default algorithm: weighted scoring.
1. For each branch, compute three metrics: `testPassRate` = `testResults && (testResults.passed + testResults.failed) > 0 ? testResults.passed / (testResults.passed + testResults.failed) : 0.0` (0.0–1.0; defaults to 0.0 when no tests ran or testResults is missing); `uniqueFileCoverage` = `totalUniqueFilesChangedAcrossAllBranches > 0 ? (changedFiles ? new Set(changedFiles).size : 0) / totalUniqueFilesChangedAcrossAllBranches : 0.0` (0.0–1.0; defaults to 0.0 when no files changed across any branch or changedFiles is missing; `totalUniqueFilesChangedAcrossAllBranches` is the size of the union of `changedFiles` from all branches; uses Set to deduplicate paths so the metric is strictly bounded ≤ 1.0); `summaryQuality` = semantic similarity score from the compare phase (0.0–1.0). Score each branch: `testPassRate * 0.5 + uniqueFileCoverage * 0.3 + summaryQuality * 0.2`.
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

- **Contracts/Schema:** Protocol template: `{ id: "qds-factory", version: "1.0.0", phases: [ { kind: "dispatch_task", config: { taskBrief: string, targetAgentIds: string[], mulchBankId: string, maxDurationMs: number, captureFormat: "structured-json" } }, { kind: "parallel", config: { branches: [{ participantAgentIds: [...], facilitatorAgentId: "...", observerAgentIds: [...] }, ...] } }, { kind: "compare", config: {} }, { kind: "decide", config: {} }, { kind: "summarize", config: {} } ] }`. The `dispatch_task` config follows the P1.6 pi-team dispatch contract. See P1.6 for full Warren harness specification. Phase output: `{ phaseIndex: number, kind: string, status: "completed"|"failed"|"skipped"|"partial", output: ComparisonResult | DecisionResult | Record<string,unknown>, startedAt: ISO8601, completedAt: ISO8601 }`. `partial` indicates the phase produced incomplete output (e.g., timeout with partial data). Consumers should check for `partial` before relying on phase output. Phase status emission rules: "completed" = phase produced full output; "partial" = some branches/sub-operations failed (parallel with 2/3 succeeding); "failed" = no meaningful output (all branches failed, dispatch error); "skipped" = not executed due to prior phase failure. Parallel emits "partial" when >= 1 but < all branches succeed. Compare emits "partial" when some branch outputs missing. Decide emits "completed" even when winner is null. Summarize always emits "completed". The `output` field is typed per phase: `ComparisonResult` for compare (conforms to structure defined in Phase Algorithms section), `DecisionResult` for decide (conforms to structure defined in Phase Algorithms section), and `Record<string,unknown>` for all other phases (dispatch_task, parallel, summarize).
  - `dispatch_task` — implemented via `extensions/agent-team.ts`. The harness adapter generates `.canopy/agent.json` from this config before invoking `warren run --config`. The protocol template does not carry Warren CLI flags.
  - `parallel` — implemented via `extensions/pi-pi.ts`
  - `compare` — implemented via `extensions/coms-net.ts` (structured diff algorithm defined above)
  - `decide` — implemented via `extensions/coms-net.ts` (weighted scoring algorithm defined above)
  - `summarize` — implemented via `extensions/cross-agent.ts`
  > **Schema precedence note:** The Technical Notes Contracts/Schema defines the phase output envelope. The Phase Algorithms section defines the shape of the `output` field for each phase kind. They are complementary — the envelope wraps the phase-specific output.
- **Integration points:** SwarmClaw protocol template registration API, SwarmClaw protocol engine (executor), phase handlers for each kind (dispatch_task, parallel, compare, decide, summarize). Protocol engine phase router resolves each `kind` to its PI extension file per the Phase-to-PI Extension Mapping table above. Protocol engine validates all participantAgentIds against `.canopy/agent.json` before phase execution.
- **Files / functions touched:** Protocol template definition (JSON), SwarmClaw template registration endpoint, protocol engine phase router (extension resolution), protocol engine config binding validator, PI extension files: `extensions/agent-team.ts`, `extensions/pi-pi.ts`, `extensions/coms-net.ts`, `extensions/cross-agent.ts`, phase handler implementations for compare/decide/summarize (dispatch_task and parallel exist from P0.1).
- **Guards/limits:** parallel config requires >= 2 branches and <= 8 branches. Branch count is limited to 2-8 to balance coverage against cost and latency. Fewer than 2 branches provides no comparison benefit. More than 8 branches creates diminishing returns on quality while exponentially increasing compute cost. Each branch must specify at least one participantAgentId. Branch IDs are positional: branches[0] = 'branch-0', branches[1] = 'branch-1', etc. The observability layer maps agentId to branchId via the parallel config's participantAgentIds. compare phase requires parallel phase to have completed (at least partially). decide phase requires compare output. Template version follows semver. All participantAgentIds are validated at invocation time (not registration time) — registration accepts any participantAgentIds. At invocation, unregistered agents cause rejection with error -32011; unconfigured agents (no `.canopy/agent.json`) cause rejection with error -32602. Validation sequence at invocation time: (1) check agent registration (P0.7 registry) — unregistered → -32011; (2) check `.canopy/agent.json` existence — missing → -32602. Registration check runs first. Validation at invocation time is two-pass: (1) check all participantAgentIds for registration — if any fail, reject with -32011 listing all unregistered IDs; (2) check canopy config for all registered agents — if any fail, reject with -32602 listing all unconfigured IDs.
- **Template versioning:** Protocol templates are immutable once registered. Updates require a new templateId or a new version number. In-flight sessions pin the template version at invocation time — the session runs against the version that was current when it started. New invocations after a template update use the new version. Old versions remain retrievable (for debugging) but cannot be invoked for new sessions. Template versions are retrieved via `GET /api/protocol-templates/{id}/versions/{version}`. The response includes the full template definition for debugging.

### Registration Contract

- **Template registration endpoint:** `POST /api/protocol-templates`. Auth: same as SwarmClaw's operator authentication (P0.7). Templates are stored in `.canopy/protocol-templates/` as immutable JSON files. Template IDs must match `^[a-z][a-z0-9-]{1,63}$` — lowercase alphanumeric with hyphens, starting with a letter, 2-64 characters total (minimum 2, maximum 64).
- **Template validation errors on registration:**
  - branchCount < 2: HTTP 400, -32602, "Parallel phase requires >= 2 branches"
  - branchCount > 8: HTTP 400, -32602, "Parallel phase requires <= 8 branches"
  - invalid phase kind: HTTP 400, -32602, "Invalid phase kind: <kind>"
  - phaseCount < 2: HTTP 400, -32602, "Template must have >= 2 phases"
  - templateId pattern mismatch: HTTP 400, -32602, "templateId must match ^[a-z][a-z0-9-]{1,63}$"

## Files to Modify

- `src/swarmclaw/protocols/templates/qds-factory.json`
- `src/swarmclaw/protocols/registry.ts`
- `src/swarmclaw/protocols/phases/compare.ts`
- `src/swarmclaw/protocols/phases/decide.ts`
- `src/swarmclaw/protocols/phases/summarize.ts`
- `tests/e2e/protocol-template.test.ts`

> The Files to Modify list is illustrative. Actual file count depends on the implementation structure. Key files are listed; supporting files (types, utilities, tests) may also be needed.

## Security Invariants

- INV-1: Template registration requires authentication; only authorized agents can register protocol templates. Template registration requires operator-level auth (same as P0.7 MCP operations). No RBAC granularity is enforced — any authenticated operator can register, update, or delete templates. RBAC for template management is a Phase 2 concern.
- INV-2: Protocol invocation scoped to sessionId; cross-session data access is forbidden.
- INV-3: At invocation time: (1) unregistered agent IDs → HTTP 422, error -32011; (2) registered agents without `.canopy/agent.json` → HTTP 400, error -32602. Both checks run at invocation, not registration. Template registration accepts any participantAgentIds.

## CC-9 Observability Contract

**Phase-transition logging:** Each phase transition emits a log event: `{ phase, from_state, to_state, timestamp, sessionId, templateId, branchCount }`.

**Error event logging:** Phase failures emit: `{ phase, error, timestamp, sessionId, templateId, branchId? }`.

**Metric capture:** Protocol execution records: `totalDurationMs`, per-phase `phaseDurationMs`, `branchesCompared`, `winnerBranchId?`. CC-9 logs `winnerBranchId` (the branch identifier, e.g., 'branch-0'). The DecisionResult uses `winner` (the agentId). These are different: a branch is a dispatch unit, an agent is the execution unit. The observability layer logs both.

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
- [ ] **Test (unit):** dispatch_task phase handler validates Warren output against expected schema (exitStatus, changedFiles, summary) and rejects malformed output with exitStatus 'logic'.
- [ ] **Test (e2e demo — MANDATORY):** Register template -> invoke with test session -> verify 5 phase outputs produced with correct phaseIndex progression and structured JSON at each step.
- [ ] **Test (unit — INV-3 security):** Register template with unregistered agent IDs (succeeds — registration is permissive). Then invoke protocol with one registered and one unregistered agent — verify 422 response with error code -32011, verify no phase execution begins, verify registered agent is NOT invoked.
- [ ] **Test (tie):** Run protocol with 2 branches producing identical output — verify `tie_detected` event emitted.
- [ ] **Test (no viable):** Run protocol where all branches fail — verify `no_viable_output` event emitted with failure details for each branch.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
