# P1.5: `qds-model-router` deterministic archetype + per-role model selection

**Story Points:** 4

## Spec Reference

- PRD §7 (In-Node Swarm Composition); FR-MG-5, FR-EX-7, FR-LEARN-29
- Supporting: NFR-PERF-7 (≤200 ms p95, fail-safe to default), NFR-OBS-6(a) (config reconstructable), NFR-SEC-5 (Hindsight bearer), NFR-PERF-4 (meta-bank recall non-blocking)
- Phase exit gate: rides PRD §13 Phase-1 (FR-MG-5/FR-EX-7 are the per-node archetype+tier selection that the implement node consumes); this slice delivers the deterministic selector + its persisted, scored rationale.

## User Story

As the Hermes Dev manager,
I want a deterministic `qds-model-router` that, given a node's work signature, picks exactly one §7 archetype and a per-role provider/model tier under the blast-radius floor and risk-tier constraints,
so that every implement node runs a logged, constraint-bound model config (G3 consistency, G4 safe spend) instead of an ad-hoc choice.

## Overview

This slice cuts through Hermes (selector logic) → GitNexus blast-radius input → Paperclip (`executionPolicy` risk tier, `heartbeat_runs` rationale persistence) → Hindsight (`{repo}-dev-meta` scoring write). The router is a **pure deterministic function** over a node signature: it enumerates the legal §7 arms (A–F), excludes arms barred by the blast-radius floor (HIGH ≥ TDD-Trio) and by the issue risk tier, excludes any >4-agent shape (NFR-PERF-1), then picks the §7 default among survivors. Each constrained role gets a provider/model string: judgment roles (Architect/Reviewer/Adversary) → `anthropic/claude-opus`; constrained Implementer → `openrouter/<glm-or-kimi>` (GLM/Kimi **always** via OpenRouter — never native; r4 §9). The selection rationale (signature inputs + chosen archetype + per-role tier map + the binding constraint) is persisted to the run's `heartbeat_runs.usageJson` and scored as a meta-lesson into `{repo}-dev-meta`. It is one atomic unit because a selection that is not persisted-and-scored is not reconstructable (NFR-OBS-6a) — selecting and recording are the same capability.

## E2E Slice

**Demonstrable behavior:** Calling `selectNodeConfig(signature)` for a node whose signature carries `blastRadius:"HIGH"` returns `{ archetype:"C", roles:{ architect:"anthropic/claude-opus", implementer:"openrouter/z-ai/glm-4.6", reviewer:"anthropic/claude-opus" }, boundBy:"blast_radius_floor", legalArms:["C","D"] }`; the same object (with `runId`) is written to `heartbeat_runs.usageJson.routerSelection` and retained to `{repo}-dev-meta` (`document_id=runId`), and a Hindsight `recall` for that `runId` returns it.

**Wiring closed:** On completion of this story, `selectNodeConfig(signature)` for a HIGH-blast-radius node produces a config with `archetype:"C"`, an `openrouter/`-prefixed Implementer model, `boundBy:"blast_radius_floor"`, AND a matching `heartbeat_runs.usageJson.routerSelection` row plus a `{repo}-dev-meta` document recallable by `runId`, using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P0.9 (Hindsight retain/recall round-trip + `{repo}-dev-meta` bank exists), P0.10 (pi-gitnexus-plus / GitNexus graph provides the `blastRadius` bucket; on empty graph the signature carries `blastRadius:"UNKNOWN"` and the router fails safe to the §7 default per NFR-PERF-7).

## Acceptance Criteria

1. **(make-or-break)** Given a node signature `{ taskShape:"dev_nontrivial", blastRadius:"HIGH", riskTier:"standard" }`, When `selectNodeConfig(signature)` is called, Then it returns `archetype:"C"` with `roles.implementer` matching `/^openrouter\//`, `roles.architect === "anthropic/claude-opus"`, `boundBy === "blast_radius_floor"`, and `legalArms` excludes `"A"` and `"B"` — AND a subsequent read of `heartbeat_runs.usageJson.routerSelection` for that `runId` deep-equals the returned object (no missing hop). (Binary: object equality + the persisted-row equality.)
2. Given a `blastRadius:"LOW"` trivial-diff signature with no new contract/test surface, When `selectNodeConfig` is called, Then it returns `archetype:"A"` (Solo) with a single role and `boundBy === "task_shape_default"`.
3. Given a signature whose required capacity computes to >4 agents OR `blastRadius:"UNKNOWN"` (cold-start graph), When `selectNodeConfig` is called, Then it never returns archetype `D`-with-5 (no >4-agent arm is representable) and on `UNKNOWN` it fails safe to the §7 Dev default (`C`) with `boundBy:"failsafe_default"` and a logged warning — never silently picks an illegal arm.
4. Given a `riskTier:"high"` issue (`executionPolicy` marks it), When `selectNodeConfig` is called, Then any arm disallowed by the risk tier is absent from `legalArms` and the chosen archetype is one of the survivors (legal-arm exclusion, not a post-hoc override).

## Technical Notes

- **Contracts/Schema (Zod/TS):** `NodeSignature` (`{ taskShape: enum, blastRadius: "LOW"|"MEDIUM"|"HIGH"|"UNKNOWN", riskTier: "standard"|"high", hasNewContract: boolean, hasTestSurface: boolean, separableSurfaces: number }`) and `RouterSelection` (`{ runId: string, archetype: "A".."F", roles: Record<string,string>, legalArms: string[], boundBy: "blast_radius_floor"|"risk_tier"|"structural_cap"|"task_shape_default"|"failsafe_default", rationale: string }`). Persisted into existing `heartbeat_runs.usageJson` jsonb (no DDL — additive key `routerSelection`; backward-compat: existing rows without the key are unaffected).
- **Integration points (each wired & exercised):** (1) GitNexus blast-radius bucket → `signature.blastRadius` input; (2) Paperclip `issues.executionPolicy` (`issues.ts:52`) → `signature.riskTier`; (3) write rationale into `heartbeat_runs.usageJson.routerSelection` (`heartbeat_runs.ts:21`); (4) retain meta-lesson to Hindsight `{repo}-dev-meta` via `POST …/banks/{bank}/memories` with `document_id=runId` (idempotent upsert, NFR-REL-4), recall verifies round-trip.
- **Model tiering (r4 §9, load-bearing):** judgment roles → `anthropic/claude-opus` (native); constrained Implementer → `openrouter/<glm|kimi>` — GLM/Kimi **MUST** carry the `openrouter/` provider prefix (Pi has no native GLM/Kimi). The router NEVER emits a bare `glm-*`/`kimi-*` model string.
- **§7 rules encoded:** archetype defaults per work shape (A Solo / B Pair / C TDD-Trio floor / D Quad-separable / E Hunter / F Maintenance); blast-radius floor (HIGH ⇒ min C, A+B illegal); structural cap (no arm > 4 agents, NFR-PERF-1); risk-tier legal-arm exclusion (FR-LEARN-29).
- **Guards/limits:** selection path ≤200 ms p95 (NFR-PERF-7); on any selection-path exception → fail safe to §7 default `C`, log warning, set `boundBy:"failsafe_default"`. The meta-bank retain is event-driven and the recall (if any priming recall is used) is the single NFR-PERF-4-capped recall — never blocks dispatch.
- **Files / functions touched:** `qds-model-router.ts:selectNodeConfig`, `enumerateLegalArms`, `applyBlastRadiusFloor`, `applyRiskTierExclusion`; persistence in `router-persistence.ts`.

## Files to Modify

- `hermes/src/router/qds-model-router.ts`
- `hermes/src/router/router-persistence.ts`
- `hermes/src/router/archetypes.ts`
- `hermes/src/contracts/node-signature.schema.ts`
- `hermes/src/contracts/router-selection.schema.ts`
- `hermes/src/memory/hindsight-meta.ts`
- `hermes/test/router/qds-model-router.test.ts`
- `hermes/test/router/router-e2e.test.ts`

## Security Invariants

- **INV-1 (cost/budget):** The constrained Implementer model is ALWAYS `openrouter/<model>` (never a native GLM/Kimi string and never silently upgraded to Opus) — a bare/native GLM model string is a hard validation failure, preventing an unintended premium-tier spend on a constrained role.
- **INV-2 (cost/budget):** The router NEVER emits an arm representing >4 concurrent agents (NFR-PERF-1) — a signature demanding more capacity is resolved by a more-nodes decomposition, never a fatter swarm, bounding per-node coms/compute cost.
- **INV-3 (cost/budget + safety):** On selection-path failure the router fails CLOSED to the §7 default archetype with the cheapest-safe Implementer tier and a logged warning (`boundBy:"failsafe_default"`); it never falls back to an unconstrained or all-Opus config that would silently inflate spend.
- **INV-4 (secrets):** The Hindsight meta-bank write sends `Authorization: Bearer <HINDSIGHT_CP_DATAPLANE_API_KEY>` from env/secret ref (NFR-SEC-5); no token is hardcoded and no model API key is ever written into the persisted `routerSelection` rationale or the meta-bank document.

## Definition of Done

- [ ] **Impl:** `selectNodeConfig(signature)` enumerates legal §7 arms, applies blast-radius floor + risk-tier + structural-cap exclusions, and returns one archetype + per-role model map deterministically.
- [ ] **Impl:** Constrained Implementer roles are emitted as `openrouter/<model>`; judgment roles as `anthropic/claude-opus` (r4 §9 tiering).
- [ ] **Impl:** Fail-safe path returns the §7 default archetype with `boundBy:"failsafe_default"` + logged warning on any selection exception or `blastRadius:"UNKNOWN"`.
- [ ] **Contract:** `NodeSignature` + `RouterSelection` Zod schemas added with field-level validation (enum on `archetype`/`boundBy`, `openrouter/` regex on constrained models); persisted as additive `usageJson.routerSelection` key (backward-compat: rows without it unaffected).
- [ ] **Integration:** GitNexus blast-radius bucket and Paperclip `issues.executionPolicy` risk tier are read into the signature and exercised in a test.
- [ ] **Observability:** Every selection writes its rationale (signature inputs + chosen archetype + per-role tier map + binding constraint) to `heartbeat_runs.usageJson.routerSelection` (NFR-OBS-6a reconstructable).
- [ ] **Integration:** Each selection is retained to `{repo}-dev-meta` (`document_id=runId`, idempotent upsert) and a `recall` for that `runId` returns the scored config.
- [ ] **Security:** INV-1 (no native GLM/Kimi), INV-2 (no >4-agent arm), and INV-4 (bearer from env, no token leak) each enforced and unit-tested.
- [ ] **Test (unit):** Covers HIGH-blast-floor exclusion of A/B, risk-tier legal-arm exclusion, structural >4 cap, and the fail-safe default path.
- [ ] **Test (perf):** Selection (enumeration + pick + serialize) returns within ≤200 ms p95 over a sample signature set (NFR-PERF-7).
- [ ] **Test (e2e demo — MANDATORY):** Fires AC-1 trigger: `selectNodeConfig` on a HIGH/standard signature returns `archetype:"C"` + `openrouter/`-Implementer + `boundBy:"blast_radius_floor"`, the `heartbeat_runs.usageJson.routerSelection` row deep-equals it, and a `{repo}-dev-meta` recall by `runId` returns the scored config — proving wiring closed.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
