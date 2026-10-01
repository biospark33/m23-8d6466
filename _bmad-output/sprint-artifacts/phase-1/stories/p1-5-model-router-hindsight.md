# P1.5: Model-Router Archetype + Per-Role Tier Selection Scored to Hindsight dev-meta Bank

**Story Points:** 4

## Spec Reference

- PRD §6, §10; FR-MG-5, FR-EX-7
- Phase exit gate: PRD §13 Phase 1 clause 5

## User Story

As a QDS factory operator,
I want a model router that selects an archetype and per-role model tier for each task and logs the decision to Hindsight,
so that every agent assignment has a deterministic, constraint-bound, auditable configuration decision.

## Overview

Build a model router that takes a task description and returns: (1) an archetype selection (e.g., "implementer", "reviewer", "architect"), (2) a per-role model tier mapping (e.g., `{ "implementer": "sonnet", "reviewer": "haiku", "architect": "opus" }`). Tier selection is deterministic based on task complexity signals (estimated lines changed, domain, risk level). The router logs every decision to the Hindsight `{repo}-dev-meta` bank via MCP, including the input signals, selected archetype, tier mapping, and confidence score. This ensures every factory run has a traceable, reproducible model configuration.

## E2E Slice

**Demonstrable behavior:** Given a task brief "Refactor auth middleware to support JWT rotation", the model router returns `{ archetype: "implementer", tiers: { "implementer": "sonnet", "reviewer": "haiku" }, confidence: 0.87, signals: { estimatedLOC: 120, domain: "backend", riskLevel: "medium" } }`. The Hindsight `{repo}-dev-meta` bank contains a retained memory with the full decision. A subsequent recall query retrieves the decision.

**Wiring closed:** On completion of this story, the model router produces a deterministic archetype + tier configuration for any task brief and successfully retains the decision to Hindsight, using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P0.9 (Hindsight memory banks operational), P0.10 (GitNexus analysis available for complexity signals).

> **v5 amendment (DF5.5):** P1.5 owns **router scoring against outcome records** (step 6). The
> roster **config schema and dual slug validation** (pi's bundled catalog AND the provider API,
> plus `~/.pi/agent/models.json`) is **DF1.5's**. <!-- v5 amendment (DF5.5) -->

## Acceptance Criteria

1. **(make-or-break)** Given a task brief string and optional context, When the model router is invoked, Then it returns `{ archetype: string, tiers: Record<string, "haiku"|"sonnet"|"opus">, confidence: number (0-1), signals: object }` where archetype is one of the defined archetypes and every tier value is a valid model name.
2. Given the router produces a decision, When the Hindsight retain is called, Then the `{repo}-dev-meta` bank contains a memory with the decision (input, archetype, tiers, confidence, signals) retrievable via `/recall` with a query matching the task brief.
3. Given two identical task briefs with identical context, When the router is invoked twice, Then the output is deterministic (same archetype, same tiers, same confidence within epsilon 0.01).

## Technical Notes

- **Contracts/Schema:** Router input: `{ taskBrief: string, context?: { domain?: string, estimatedLOC?: number, riskLevel?: "low"|"medium"|"high", existingCodePath?: string } }`. Router output: `{ archetype: "implementer"|"reviewer"|"architect"|"researcher"|"tester", tiers: Record<string, "haiku"|"sonnet"|"opus">, confidence: number, signals: { estimatedLOC: number, domain: string, riskLevel: string, archetypeScores: Record<string, number> } }`. Hindsight retain payload: `{ bank_id: "{repo}-dev-meta", content: string (JSON of router output), metadata: { type: "model-router-decision", taskBriefHash: string } }`.
- **Integration points:** Model router module (pure function), Hindsight MCP client (retain to {repo}-dev-meta), Hindsight MCP client (recall for verification), optional GitNexus (code complexity signals if existingCodePath provided).
- **Files / functions touched:** Model router implementation, archetype scoring logic, tier selection rules, Hindsight MCP adapter, router test fixtures.
- **Guards/limits:** taskBrief must be 10-500 characters. estimatedLOC defaults to 50 if not provided. riskLevel defaults to "medium". Confidence threshold: decisions below 0.5 confidence should flag for human review (logged but not blocked). Maximum 100 router decisions retained per session to prevent Hindsight bank bloat.

## Files to Modify

- `src/model-router/router.ts`
- `src/model-router/archetypes.ts`
- `src/model-router/tier-selection.ts`
- `src/integrations/hindsight/mcp-client.ts`
- `tests/e2e/model-router-hindsight.test.ts`

## Security Invariants

- INV-1: Hindsight bank_id constructed from repo name only; no injection of arbitrary bank IDs.
- INV-2: Router does not log raw task brief to Hindsight; only a SHA-256 hash is stored in metadata to prevent leakage of proprietary task details.
- INV-3: Tier selection enforces cost constraints: no more than 1 "opus" tier per routing decision unless riskLevel is "high".

## Definition of Done

- [ ] **Impl:** Model router accepts task brief + optional context and returns archetype + tiers + confidence + signals.
- [ ] **Impl:** Archetype scoring produces deterministic rankings from task signals (estimatedLOC, domain, riskLevel).
- [ ] **Impl:** Tier selection maps archetype to model tiers with cost-aware constraints (max 1 opus unless high risk).
- [ ] **Impl:** Decision retained to Hindsight `{repo}-dev-meta` bank via MCP with full structured payload.
- [ ] **Contract:** Router input validated: taskBrief 10-500 chars, riskLevel enum, estimatedLOC positive int or null.
- [ ] **Contract:** Router output schema enforced: archetype from enum, tiers values from ("haiku"|"sonnet"|"opus"), confidence in [0, 1].
- [ ] **Integration:** Hindsight recall retrieves the retained decision by querying with task brief content.
- [ ] **Integration:** Deterministic: identical inputs produce identical outputs across invocations.
- [ ] **Security:** Hindsight bank_id validated against `^{repo}-dev-meta$` pattern; injection rejected.
- [ ] **Security:** Task brief hashed (SHA-256) before storage in Hindsight metadata; raw brief not persisted.
- [ ] **Test (unit):** Router determinism verified: 3 identical inputs produce 3 identical outputs.
- [ ] **Test (e2e demo — MANDATORY):** Route a sample task -> verify Hindsight {repo}-dev-meta bank contains retained decision -> recall and verify structured output matches router response.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
