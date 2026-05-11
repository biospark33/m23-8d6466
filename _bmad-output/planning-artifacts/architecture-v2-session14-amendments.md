# Architecture v2.0 — Session 14 Amendments

**Date:** 2026-04-20
**Scope:** ADR-036 (pipeline graph DSL), ADR-037 (provider adapter contract), ADR-038 (cross-provider fallback), ADR-039 (human gate nodes), ADR-040 (execution environment abstraction), ADR-019 amendment (semantic loop detection), ADR-021 amendment (fidelity modes)
**Applies to:** `_bmad-output/planning-artifacts/architecture-v2.md` v2.0, `_bmad-output/planning-artifacts/architecture-v2-session10-amendments.md`, `_bmad-output/planning-artifacts/architecture-v2-session12-amendments.md`, `_bmad-output/implementation-artifacts/epics-and-stories.md`
**Methodology:** Gap analysis of StrongDM Attractor NLSpecs (`attractor-spec.md`, `coding-agent-loop-spec.md`, `unified-llm-spec.md`) against QDS Factory's existing architecture. Only genuinely additive concepts adopted — no redundant capabilities introduced.
**Evidence base:** StrongDM Attractor repository (https://github.com/strongdm/attractor, Apache 2.0), this amendments file (session 14 formalization).

---

## Note on ADR Numbering

ADR-036 through ADR-040 are clean — no collisions with prior sessions. ADR-001 through ADR-035 were allocated across `architecture-v2.md` (ADR-001 through ADR-023), `architecture-v2-session11-twelve-factor.md` (ADR-024), `architecture-v2-session12-gap-analysis-amendments.md` (ADR-025 through ADR-032), and `architecture-v2-session12-amendments.md` (ADR-033 through ADR-035). Session 14's five new ADRs begin at ADR-036 with no gaps or overlaps.

---

## ADR Summary Table

| ADR | Title | Status | Phase | FRs |
|-----|-------|--------|-------|-----|
| ADR-019 amend | Turn Continuation — Semantic Loop Detection (Section 19.9) | Amended | MVP + Growth | FR204, FR205 |
| ADR-021 amend | Bidirectional Middleware Chain — Fidelity Modes (Section 21.6) | Amended | Growth | FR208, FR209 |
| ADR-036 | Pipeline Graph DSL | Accepted | Growth | FR197, FR198 |
| ADR-037 | Formal Provider Adapter Contract | Accepted | MVP + Growth | FR199, FR200 |
| ADR-038 | Cross-Provider Fallback Chains | Accepted | Growth | FR201, FR202, FR203 |
| ADR-039 | Human Gate Nodes | Accepted | Growth | FR206, FR207 |
| ADR-040 | Execution Environment Abstraction | Accepted | Growth | FR210, FR211, FR212 |

---

## ADR-019 Amendment: Section 19.9 "Semantic Loop Detection"

**Section affected:** ADR-019 (Turn Continuation Architecture), new Section 19.9

**Context:**

Attractor's coding-agent-loop-spec includes semantic loop detection — detecting repeated tool patterns, token consumption spiraling, and injecting warning messages mid-loop. QDS Factory's current turn continuation architecture (ADR-019) includes turn-based continuation (Story 4.1), progress velocity check (Story 4.2), and stall detection (Story 4.7). However, these are all time-based or count-based. None detect **semantic loops** where an agent repeatedly calls the same tool with the same arguments, rewrites the same file multiple times, or consumes tokens without making conceptually distinct progress.

Overstory's watchdog (`src/watchdog/daemon.ts`, ~390 LOC) monitors process heartbeats — it detects when an agent process stops responding, not when it's responding but going in circles.

**Original text (ADR-019):**

> ADR-019 defines turn continuation with progress velocity checks (Story 4.2) and stall detection (Story 4.7) based on time-based and count-based heuristics. No semantic analysis of tool-call patterns is performed.

**Amended text (ADR-019, Section 19.9):**

> Section 19.9 — Semantic Loop Detection. In addition to time-based and count-based stall detection (Stories 4.2, 4.7), Factory Core performs semantic loop detection at the tool-call boundary within the turn continuation loop. Three detection patterns are defined:
>
> 1. **Repeated identical tool calls:** If the same tool is called with the same arguments (deep-equal on serialized args) more than `N` times within a sliding window of `W` tool calls (configurable, defaults: N=3, W=10), the turn is flagged as `looping`.
>
> 2. **File rewrite cycles:** If the same file is modified (post-edit hook fires) and the modification is reverted (content matches a prior version within the last 5 edits) more than 3 times, the turn is flagged as `file_oscillating`.
>
> 3. **Token consumption without progress:** If the agent has consumed more than `2x` the rolling median token count for the current phase type, AND zero checklist items have advanced since the last velocity check, the turn is flagged as `stalled_high_cost`.

**MVP scope:** Detection + turn flagging. When any pattern triggers, the `turn_state` record in `.claude/qds/runs/{story_id}/turn_state.jsonl` gets a `loop_flag` field set to the detection pattern name. The orchestration loop (Story 4.0) reads `loop_flag` when evaluating phase transition. A flagged turn triggers the force-cap mechanism from Story 4.2 (progress velocity check), reducing remaining max_turns to 1.

**Growth scope:** Warning injection via Pi SDK's steering mechanism (`getSteeringMessages()` callback). When a loop is detected, Factory Core injects a diagnostic message into the agent's next context turn describing: (a) the detected pattern (e.g., "You have called `write_file` on `src/auth.ts` 4 times with the same content"), (b) a suggestion to try an alternative approach, (c) a warning that continued looping will terminate the phase. If the loop persists after warning (same pattern detected in the very next turn), the phase is terminated and the pipeline evaluates whether to retry with a fresh agent or escalate.

**Invariant compliance:**

- Invariant 8 (cost circuit breakers): Semantic loop detection is a PREVENTION mechanism that fires before the per-story budget circuit breaker. It catches runaway cost patterns that a budget ceiling alone would eventually catch, but earlier and with diagnostic context.
- Does not affect invariants 1-7, 9-10.

**Impact:** New Story 4.8 (Semantic Loop Detection & Turn Flagging) in Epic 4. Adds `loop_flag` field to the JSON Lines turn-state records in `.claude/qds/runs/{story_id}/turn_state.jsonl` (Story 1.2 migration 002 or later).

### Acceptance Criteria

- [ ] ADR-019 amendment present in `architecture-v2-session14-amendments.md`
- [ ] Three detection patterns defined (repeated tool calls, file rewrite cycles, token consumption without progress)
- [ ] MVP scope (detection + turn flagging) and Growth scope (warning injection) clearly separated
- [ ] `loop_flag` column addition to `turn_state` table specified
- [ ] Invariant #8 (cost circuit breakers) compliance verified
- [ ] Story 4.8 referenced as implementation story

### References

- StrongDM Attractor `coding-agent-loop-spec.md` (semantic loop detection patterns)
- ADR-019 (Turn Continuation Architecture) — the base ADR being amended
- Story 4.0 (Factory Core Orchestration Loop) — the runtime that reads `loop_flag`
- Story 4.2 (Progress Velocity Check) — the force-cap mechanism triggered by loop detection
- Story 4.7 (Stall Detection) — the existing time/count-based detection, complemented by this amendment
- ADR-033 invariant #8 (runaway-cost circuit breakers) — the invariant this amendment helps satisfy
- Overstory `src/watchdog/daemon.ts` (~390 LOC) — process heartbeat monitoring, not semantic loop detection

---

## ADR-021 Amendment: Section 21.6 "Fidelity Modes"

**Section affected:** ADR-021 (Bidirectional Middleware Chain), new Section 21.6

**Context:**

Attractor's attractor-spec defines fidelity modes as a first-class concept — configurable context carryover between pipeline stages (full session reuse, truncation, compact summaries). QDS Factory's current context management is sophisticated (6-stage overlay pipeline per ADR-021, context budget 50% rule per FR155, Pi SDK's `AgentSession.compact()` available) but fidelity is controlled implicitly through model tier routing and middleware composition. There is no named "fidelity mode" abstraction that a pipeline author can set per-phase.

The existing phase boundary protocol (ADR-006) mandates context isolation between phases — fresh agents with no prior context. This is invariant #1. Fidelity modes operate WITHIN a phase (across turns within the same agent session), not across phases. They describe how much of the agent's own conversation history is carried forward between turns within a single phase.

**Original text (ADR-021):**

> ADR-021 defines the bidirectional middleware chain with 6 stages of overlay composition. Context budget management follows the 50% rule (FR155). No named fidelity modes are defined for intra-phase context carryover.

**Amended text (ADR-021, Section 21.6):**

> Section 21.6 — Fidelity Modes. Three named fidelity modes are defined for context carryover WITHIN a phase:
>
> | Mode | Behavior | Use Case |
> |------|----------|----------|
> | `full` | Complete session context carried forward between turns. All messages, tool results, and assistant responses preserved. | Development phase — builder agents need full context of what they've already implemented. |
> | `truncated` | Last N turns carried forward (N configurable per-phase in `factory.yaml`, default 5). Earlier turns dropped. System prompt and overlay always preserved. | Fix loop phase — agent needs recent corrections but not the full BMAD review history. |
> | `compact` | Pi SDK `AgentSession.compact()` summary carried forward. Produces a condensed summary of the session history that fits within a token budget. | BMAD review and QA phases — agents need a sense of what was built but not turn-by-turn detail. |
>
> Configuration in `factory.yaml`:
>
> ```yaml
> phases:
>   develop:
>     fidelity: full
>   bmad:
>     fidelity: compact
>   fix_loop:
>     fidelity: truncated
>     fidelity_truncation_turns: 5
>   qa:
>     fidelity: compact
> ```

**Invariant compliance:**

- Invariant 1 (context isolation): Fidelity modes operate WITHIN a phase. Cross-phase context isolation is unchanged — fresh agents are spawned at phase boundaries per ADR-006. The fidelity mode describes how the agent's OWN session within a phase is managed, not what leaks between phases.
- Does not affect invariants 2-10.

**Impact:** New Story 2.11 (Fidelity Mode Configuration) in Epic 2. Middleware chain (Story 2.1) adds a `FidelityMiddleware` that applies the configured fidelity mode to `transformContext()` before each LLM turn.

### Acceptance Criteria

- [ ] ADR-021 amendment present in `architecture-v2-session14-amendments.md`
- [ ] Three fidelity modes defined (full, truncated, compact) with behaviors and use cases
- [ ] `factory.yaml` configuration format documented
- [ ] Invariant #1 (context isolation) compliance verified — modes are intra-phase only
- [ ] Story 2.11 referenced as implementation story
- [ ] `FidelityMiddleware` integration with Story 2.1 (middleware chain) specified

### References

- StrongDM Attractor `attractor-spec.md` (fidelity mode concept)
- ADR-021 (Bidirectional Middleware Chain) — the base ADR being amended
- ADR-006 (Phase Boundary Protocol Implementation) — cross-phase context isolation, unchanged
- FR155 (Context budget 50% rule) — interacts with fidelity mode token management
- Pi SDK `AgentSession.compact()` — the runtime mechanism backing `compact` mode
- Story 2.1 (Middleware Chain) — the middleware that `FidelityMiddleware` integrates into
- ADR-033 invariant #1 (context isolation between dev and review agents) — the invariant this amendment must not violate

---

## ADR-036: Pipeline Graph DSL

**Status:** ACCEPTED

**Date:** 2026-04-20

**Deciders:** Steve (user), session 14 analysis

**Context:**

StrongDM's Attractor defines pipeline orchestration using Graphviz DOT syntax — nodes represent pipeline stages (LLM tasks, human gates, conditional routing, parallel execution) and edges define transitions with conditions. This declarative graph format enables: visual inspection of pipeline flow, validation of reachability before execution, conditional branching (retry loops, parallel fan-out), and a standard representation that tools can consume.

QDS Factory's current pipeline architecture is procedurally expressed:

- ADR-006 defines a fixed 5-phase ordering (Develop -> BMAD -> Fix Loop -> QA -> PR)
- ADR-021 defines a sequential middleware chain within each phase
- Story 4.0 implements the orchestration loop as a poll-reconcile-dispatch pattern

None of this is expressed as an inspectable graph. The pipeline flow is embedded in imperative code, not in a declarative format that can be validated, visualized, or extended.

**Decision:**

Adopt a declarative graph representation for Factory Core pipelines using YAML syntax (not DOT — aligns with `factory.yaml` convention and avoids introducing a Graphviz dependency). The graph defines nodes (pipeline stages) and edges (transitions with optional conditions).

The built-in 5-phase pipeline (Develop -> BMAD -> Fix Loop -> QA -> PR) is expressed as the DEFAULT graph template. This template is loaded by Factory Core at startup and cannot be modified in MVP.

In Growth phase, custom pipeline graphs can be defined in `factory.yaml` for specialized workflows (e.g., documentation-only stories that skip QA, or spike stories that skip BMAD review). Custom graphs must pass validation at load time.

**Graph validation rules:**

1. All nodes must be reachable from the start node
2. All phase boundary nodes must have associated gate checks (mechanical quality gates per invariant #5)
3. No unbounded cycles — every cycle must have either a max-iteration limit or a goal-gate exit condition
4. All node references in edges must resolve to defined nodes
5. The default 5-phase template is immutable — custom graphs may extend it (add nodes after PR) but not reorder or remove its core phases in MVP

**Key design constraint:** This ADR does NOT replace ADR-006 (fixed ordering) or ADR-021 (middleware chain). It provides a **representation layer** on top of both. The graph describes WHAT stages exist and HOW transitions work; the middleware chain describes what HAPPENS inside each stage.

### Alternatives Considered

| Option | Pros | Cons | Outcome |
|---|---|---|---|
| **A. YAML-based graph (chosen)** | Aligns with `factory.yaml`; no new parser dependency; human-readable; validatable with Zod schemas | Less expressive than DOT for visual rendering; no native graph visualization | **Accepted** |
| **B. DOT syntax (Attractor's approach)** | Industry standard for graph representation; rich ecosystem of rendering tools (Graphviz, d3-graphviz) | Introduces Graphviz as a dependency; DOT parser is non-trivial; `factory.yaml` convention broken | **Rejected** — dependency cost |
| **C. JSON graph format** | Machine-readable; easy to validate | Verbose; harder for humans to author | **Rejected** — ergonomics |
| **D. No graph DSL — keep procedural** | Zero new code; existing pipeline works | Cannot validate pipeline configuration; cannot visualize flow; cannot extend for Growth | **Rejected** — extensibility limitation |

### Consequences

**Positive:**

- Pipeline configuration becomes inspectable and validatable before execution
- Dashboard can render the pipeline graph as a visual flow diagram (Story 9.x extension)
- Custom pipelines for Growth personas (solo devs, agency leads) can be expressed declaratively
- Graph validation catches configuration errors at load time rather than at runtime

**Negative:**

- Adds ~600 LOC of new code (parser, validator, compiler)
- Graph-to-execution compilation adds a layer of indirection between configuration and behavior
- Risk of over-engineering for a 2-developer team that may never need custom pipelines

**Neutral:**

- The default 5-phase template is just the existing pipeline expressed as a graph — zero behavioral change for MVP users
- DOT rendering can be added later as a Growth feature if visual graph output is desired

### Acceptance Criteria

- [ ] ADR-036 present in `architecture-v2-session14-amendments.md`
- [ ] YAML graph schema defined with node types (stage, gate, conditional) and edge types (transition, retry, fork)
- [ ] Built-in 5-phase template documented as the default graph
- [ ] Validation rules specified (reachability, gate presence, cycle bounds, reference resolution)
- [ ] Invariant #5 (mechanical gates at phase boundaries) preserved via gate-node requirement
- [ ] Invariant #6 (fixed pipeline ordering) preserved via immutable default template
- [ ] Stories 11.1 and 11.2 referenced as implementation stories

### References

- StrongDM Attractor `attractor-spec.md` Sections 1-3 (DOT grammar, node types, edge selection)
- ADR-006 (Phase Boundary Protocol Implementation) — the existing fixed pipeline ordering, unchanged
- ADR-021 (Bidirectional Middleware Chain) — within-stage execution, unchanged
- Story 4.0 (Factory Core Orchestration Loop) — the runtime that executes the graph
- ADR-033 invariant #5 (mechanical quality gates at phase boundaries) — graph must enforce gate nodes
- ADR-033 invariant #6 (fixed story pipeline ordering) — default graph template is immutable

---

## ADR-037: Formal Provider Adapter Contract

**Status:** ACCEPTED

**Date:** 2026-04-20

**Deciders:** Steve (user), session 14 analysis

**Context:**

Attractor's unified-llm-spec defines a formal four-layer architecture (Provider Spec -> Utilities -> Core Client -> High-Level API) with a typed provider adapter contract that includes capability discovery and versioning. Each provider adapter MUST declare what it can do (tool calling, structured output, streaming, vision, reasoning) so the client can make informed routing decisions.

Pi SDK already has 8 native provider implementations with a unified `StreamFunction<TApi>` interface and `AssistantMessageEvent` stream (verified in `pi-mono/packages/ai/src/providers/`). Each provider directly calls its native API — Anthropic uses the Messages API, OpenAI uses the Responses API, Google uses the native Gemini API. This is exactly what Attractor recommends.

However, Pi SDK's provider contract is **implicit**. There is no typed interface declaring what capabilities each provider supports. Story 2.9 (TierResolver) maps tier directives to `Model<Api>` objects, but the TierResolver has no way to ask "does this model support tool calling?" or "does this provider support structured output?" — it relies on hardcoded model metadata in `models.generated.ts`.

This matters for: (1) fallback chains (ADR-038) — you can only fail over to a provider that has the same capabilities, (2) Growth features like vision-based QA that only work on vision-capable models, and (3) defensive validation at startup — catching misconfiguration early.

**Decision:**

Define a `ProviderCapabilities` interface in `shared-types` that wraps Pi SDK's existing `Model<Api>` type with explicit capability flags:

```typescript
export interface ProviderCapabilities {
  readonly supports_tool_calling: boolean;
  readonly supports_structured_output: boolean;
  readonly supports_streaming: boolean;
  readonly supports_vision: boolean;
  readonly supports_reasoning: boolean;   // extended thinking
  readonly max_context_window: number;    // from Model.contextWindow
  readonly max_output_tokens: number;     // from Model.maxTokens
}
```

**MVP scope:** Static capability declarations. `ProviderCapabilities` is computed from `Model<Api>` metadata at startup — the `reasoning` flag, `input` array (checks for "image"), and `contextWindow`/`maxTokens` fields are already available. No runtime probing needed. The capability registry is a lookup table: `Map<string, ProviderCapabilities>` keyed by model ID.

**Growth scope:** Runtime capability probing. Factory Core sends a lightweight test call (e.g., a tool-use call with a no-op tool) to verify that a provider actually supports what its metadata claims. This catches cases where a provider's API has changed since `models.generated.ts` was last generated.

**Key constraint:** This wraps Pi SDK types — it does NOT replace or fork them. `ProviderCapabilities` is computed FROM `Model<Api>`, not independently maintained. If Pi SDK changes its type definitions, `ProviderCapabilities` computation updates accordingly.

### Alternatives Considered

| Option | Pros | Cons | Outcome |
|---|---|---|---|
| **A. Wrapper interface over Pi SDK types (chosen)** | Zero Pi SDK changes; capability flags computed from existing data; type-safe | Additional abstraction layer; may drift if Pi SDK adds new model fields | **Accepted** |
| **B. Fork Pi SDK to add capability fields** | Capabilities native to model type | Fork maintenance cost; breaks upstream sync; Pi SDK team may add capabilities differently | **Rejected** — fork hygiene |
| **C. External capability database (JSON file)** | Easy to update without code changes | Another file to maintain; not type-checked; can diverge from reality | **Rejected** — type safety |
| **D. No capability contract — hardcode in TierResolver** | Zero new abstraction | TierResolver becomes a catch-all; no reusable capability query; fallback chains (ADR-038) have nothing to check against | **Rejected** — blocks ADR-038 |

### Consequences

**Positive:**

- TierResolver (Story 2.9) can query capabilities when selecting models, not just tier metadata
- Fallback chains (ADR-038) can verify capability compatibility before failover
- Startup validation catches misconfigured providers early (e.g., a provider that claims tool support but doesn't actually support it)
- Growth features (vision-based QA, structured output extraction) can query capability registry

**Negative:**

- Pi SDK upstream changes to `Model<Api>` may require updating the capability computation logic
- The mapping from model metadata to capabilities is heuristic for some fields (e.g., `supports_structured_output` may not be directly available in Pi SDK's type system)

**Neutral:**

- The capability registry is read-only after startup — no runtime state management concerns
- Growth-phase runtime probing is optional and can be enabled/disabled in `factory.yaml`

### Acceptance Criteria

- [ ] ADR-037 present in `architecture-v2-session14-amendments.md`
- [ ] `ProviderCapabilities` interface defined with all capability flags
- [ ] MVP scope (static computation from `Model<Api>`) and Growth scope (runtime probing) clearly separated
- [ ] Wrapper-over-Pi-SDK constraint documented
- [ ] Story 2.10 referenced as implementation story
- [ ] ADR-038 dependency noted (fallback chains need capability checks)

### References

- StrongDM Attractor `unified-llm-spec.md` Section 7 (Provider Adapter Contract)
- Pi SDK `pi-mono/packages/ai/src/types.ts` — `Model<Api>`, `Provider`, `Api` types
- Pi SDK `pi-mono/packages/ai/src/models.generated.ts` — model metadata registry
- Story 2.9 (TierResolver) — the consumer of capability information
- ADR-008 (Credential Isolation) — `getApiKey` callback unchanged by this ADR
- ADR-016 (Economic Governance) — tier directives interact with capability routing

---

## ADR-038: Cross-Provider Fallback Chains

**Status:** ACCEPTED

**Date:** 2026-04-20

**Deciders:** Steve (user), session 14 analysis

**Context:**

Attractor's unified-llm-spec includes an error taxonomy with retryability classification and retry policies with backoff, jitter, and circuit breaker integration. It enables automatic failover between providers when a primary provider is unavailable.

QDS Factory has ADR-023 (System Health Circuit Breaker) monitoring subsystem health — when 3+ subsystems report errors within 60 seconds, the circuit breaker pauses new story starts. Story 8.5 implements circuit breaker state management. However, there is no **provider-level** failover — if Anthropic is rate-limited or down, the factory stops. Pi SDK handles routing to a single provider per model; it does not try alternative providers.

The Growth-phase PRD mentions "advanced key rotation, OpenRouter as fallback" but no ADR specifies the mechanism.

**Decision:**

Implement configurable cross-provider fallback chains in `factory.yaml`. A fallback chain maps a primary provider/model to an ordered list of fallback alternatives. Fallback is triggered by **provider-level errors only** (rate limit, outage, timeout), not by model-level failures (poor output quality, hallucination).

**Error taxonomy:**

| Classification | Examples | Action |
|---|---|---|
| `retryable_transient` | HTTP 503, network timeout, connection reset | Retry with exponential backoff (base 1s, max 30s, jitter +/-20%) up to 3 attempts |
| `retryable_after_backoff` | HTTP 429 with Retry-After header | Wait for Retry-After duration, then retry once |
| `non_retryable` | HTTP 401 (invalid API key), HTTP 404 (model not found), HTTP 400 (malformed request) | Fail immediately — do not retry, do not fallback |
| `partial_success` | Truncated response (stop_reason: length), incomplete tool call | Accept partial result; log warning; do not trigger fallback |

**Fallback constraints:**

1. The fallback provider MUST have the required `ProviderCapabilities` (ADR-037) — e.g., if the primary model supports tool calling, the fallback must too
2. The fallback MUST be within the same tier — premium only fails to premium-capable providers. This prevents quality degradation from fallback.
3. The global circuit breaker (ADR-023, FR170) is checked before fallback — if the circuit breaker is open, fallback does not attempt
4. Cost attribution (invariant #4) is preserved — fallback provider costs are attributed to the same `story -> phase -> agent` chain
5. Maximum 2 fallback attempts per original request (primary + 2 fallbacks = 3 total providers tried)

**Configuration in `factory.yaml`:**

```yaml
fallback_chains:
  anthropic/claude-sonnet-4-20250514:
    - openrouter/anthropic/claude-sonnet-4-20250514   # Same model via OpenRouter
    - anthropic/claude-haiku-4-5-20251001              # Tier downgrade (only if tier allows)
  openai/o3:
    - openrouter/openai/o3
```

### Alternatives Considered

| Option | Pros | Cons | Outcome |
|---|---|---|---|
| **A. Configurable fallback chains in factory.yaml (chosen)** | Developer-controlled; transparent; tier-constrained | Requires manual configuration; may need updating as providers change | **Accepted** |
| **B. Automatic fallback via OpenRouter for all providers** | Zero configuration; OpenRouter handles routing | OpenRouter adds latency and cost markup; less control over which model serves the request; single point of failure | **Rejected** — control |
| **C. No fallback — rely on circuit breaker only** | Simplest; no new code | Factory stops producing when a single provider has issues; poor resilience for production use | **Rejected** — resilience |
| **D. Provider-agnostic retry middleware in Pi SDK** | Closer to the provider layer; reusable outside Factory Core | Requires Pi SDK fork or contribution; tier constraints are a Factory Core concern, not Pi SDK's | **Rejected** — layer violation |

### Consequences

**Positive:**

- Factory continues producing stories when a single provider has transient issues
- Error taxonomy provides consistent classification across all providers
- Tier-constrained fallback prevents quality degradation
- Cost attribution chain preserved through fallback

**Negative:**

- Different providers may produce subtly different code quality even at the same tier — this is an inherent risk of multi-provider architectures
- Fallback adds latency when primary provider fails (retry delays + fallback attempts)
- Configuration maintenance — fallback chains may need updating as providers change their model offerings

**Neutral:**

- OpenRouter can be used as a fallback destination — it's just another provider in the chain, not a special case
- The error taxonomy is defined once and reused by all providers

### Acceptance Criteria

- [ ] ADR-038 present in `architecture-v2-session14-amendments.md`
- [ ] Error taxonomy defined with 4 classifications and actions for each
- [ ] Fallback constraints specified (capability check, tier constraint, circuit breaker, cost attribution, max attempts)
- [ ] Configuration format documented for `factory.yaml`
- [ ] Invariant #4 (cost attribution) preserved through fallback
- [ ] Invariant #8 (circuit breaker) integrated with fallback triggering
- [ ] ADR-037 dependency noted (capability checks required for fallback)
- [ ] Stories 11.3 and 11.4 referenced as implementation stories

### References

- StrongDM Attractor `unified-llm-spec.md` Section 6 (Error Handling and Retry)
- ADR-023 (System Health Circuit Breaker) — fallback integrates with existing circuit breaker
- ADR-037 (Provider Adapter Contract) — capability checks required before failover
- ADR-016 (Economic Governance) — tier directives constrain fallback options
- Story 2.9 (TierResolver) — tier-to-model mapping used by fallback chain
- Story 8.5 (Circuit Breaker State) — health monitoring integration

---

## ADR-039: Human Gate Nodes

**Status:** ACCEPTED

**Date:** 2026-04-20

**Deciders:** Steve (user), session 14 analysis

**Context:**

Attractor's attractor-spec includes `wait.human` nodes — pipeline stages that pause execution and await human input. The Interviewer interface abstracts human interaction with multiple backends (CLI, web, queue, callback). This enables use cases where an agent is uncertain and needs developer guidance before proceeding.

QDS Factory's quality gates are all mechanical (ADR-010 hooks, FR152 structural verification, FR163 Nyquist-BMAD disagreement protocol). FR193 (Growth) defines a Confidence-Gated Merge Policy with a "Supervised" mode requiring human review before merge — but this is a binary gate (approve/reject), not an interactive approval workflow.

There is no mechanism for the pipeline to pause and ask a human a structured question mid-flow, receive an answer, and continue. The autonomous merge philosophy (PRD Section 1.3) states that human involvement is reserved for "architecture-level decisions (deviation rule R4), circuit breaker escalations, and explicit developer-initiated overrides." Human gates formalize this existing exception path.

**Decision:**

Pipeline graphs (ADR-036) can include human gate nodes that pause execution and await developer approval. This is a Growth-phase feature — MVP's mechanical gates are sufficient for the 2-developer internal audience.

**Human gate specification:**

```yaml
node:
  type: human_gate
  prompt: "Builder is uncertain about API contract interpretation. Review the proposed interface before proceeding."
  timeout: 24h              # Default: 24 hours
  timeout_action: escalate  # approve | reject | escalate (default: escalate)
  required_approvals: 1     # Default: 1
```

**Multi-backend approval delivery:**

- **CLI:** `qds approve <gate-id> [--comment "..."]` — for developers working in terminal
- **Telegram:** Inline keyboard buttons on the gate notification message (leverages FR120-FR129 Telegram integration and FR171 MessageBus)
- **Dashboard:** Approval card in the story detail view with comment field

All backends write to the same approval state in `.claude/qds/gates/{gate_id}.json`. The first approval that meets the `required_approvals` threshold resolves the gate.

**Approval state (file-based JSON):**

Each gate is stored as an atomic JSON file at `.claude/qds/gates/{gate_id}.json`:

```json
{
  "id": "gate-uuid",
  "story_id": "story-123",
  "phase": "develop",
  "prompt": "Builder is uncertain about API contract interpretation...",
  "timeout_at": "2026-05-11T18:00:00Z",
  "timeout_action": "escalate",
  "required_approvals": 1,
  "status": "pending",
  "created_at": "2026-05-10T18:00:00Z",
  "resolved_at": null,
  "responses": [
    {
      "id": "resp-uuid",
      "responder": "developer-id",
      "decision": "approve",
      "comment": "LGTM — proceed with the proposed interface",
      "backend": "cli",
      "created_at": "2026-05-10T18:05:00Z"
    }
  ]
}
```

**File operations:**

- Gates are created via atomic write (`write-then-rename`) to `.claude/qds/gates/{gate_id}.json.tmp` → `.claude/qds/gates/{gate_id}.json`.
- Responses are appended to the `responses` array in the same gate file, with the entire file rewritten atomically.
- The `stories` reference is implicit via `story_id` string (foreign-key enforcement is handled by the pipeline engine at write time, not by the storage layer).

**Invariant compliance:**

- Invariant 1 (context isolation): Approval state is stored in `.claude/qds/gates/*.json` (file-based), not in agent context. Gate resolution does not leak cross-phase context. The developer's comment is injected into the next phase's transfer manifest, not directly into agent context.
- Does not affect invariants 2-10.

### Alternatives Considered

| Option | Pros | Cons | Outcome |
|---|---|---|---|
| **A. Human gate nodes in pipeline graph (chosen)** | Declarative; multi-backend; formal approval state; integrates with graph DSL | Adds complexity to the pipeline engine; Growth-only | **Accepted** |
| **B. Slack-style thread-based approvals** | Natural for teams; rich threading | Requires Slack integration; not all users have Slack | **Rejected** — platform dependency |
| **C. GitHub PR review as approval mechanism** | Already used for code review; audit trail built-in | Only works for merge decisions, not mid-pipeline questions; slow for interactive use | **Rejected** — wrong granularity |
| **D. No human gates — rely on circuit breaker escalation only** | Simplest; existing path | Circuit breaker is a blunt instrument — it pauses everything, not a specific decision point | **Rejected** — insufficient granularity |

### Consequences

**Positive:**

- Formalizes the existing exception path for human involvement (deviation rule R4, circuit breaker escalations)
- Multi-backend delivery ensures developers get notified wherever they are
- Approval state is auditable as version-controlled JSON files in `.claude/qds/gates/`
- Timeout with configurable action prevents gates from blocking indefinitely

**Negative:**

- Over-engineering risk for a 2-developer team that may never need mid-pipeline approvals
- Adds a new `gates/` directory under `.claude/qds/` with atomic JSON file writes
- Multi-backend delivery requires integration work with CLI, Telegram, and Dashboard

**Neutral:**

- Human gates are opt-in — the default 5-phase template has no human gates. They must be explicitly added to custom pipeline graphs.

### Acceptance Criteria

- [ ] ADR-039 present in `architecture-v2-session14-amendments.md`
- [ ] Human gate specification format documented
- [ ] Multi-backend approval delivery documented (CLI, Telegram, Dashboard)
- [ ] File-based gate state documented (atomic JSON writes, `.claude/qds/gates/` directory)
- [ ] Invariant #1 (context isolation) compliance verified
- [ ] Timeout behavior with configurable action documented
- [ ] Story 11.5 referenced as implementation story
- [ ] ADR-036 dependency noted (gates exist within pipeline graphs)

### References

- StrongDM Attractor `attractor-spec.md` Section 6 (Human-in-the-Loop)
- ADR-036 (Pipeline Graph DSL) — human gates are a node type in the graph
- ADR-006 (Phase Boundary Protocol) — context isolation preserved
- FR193 (Confidence-Gated Merge Policy) — shares governance concepts
- FR171 (Multi-Channel Notification Abstraction) — MessageBus delivers gate notifications
- Story 8.1 (MessageBus) — notification delivery substrate

---

## ADR-040: Execution Environment Abstraction

**Status:** ACCEPTED

**Date:** 2026-04-20

**Deciders:** Steve (user), session 14 analysis

**Context:**

Attractor's coding-agent-loop-spec defines a formal `ExecutionEnvironment` interface that abstracts over different execution backends (local, Docker, Kubernetes, WASM, SSH). Tool operations pass through this interface, enabling the same agent loop to run in different environments without code changes.

QDS Factory's current execution layer is tmux-based, implemented by Overstory's `src/worktree/tmux.ts` and `src/worktree/manager.ts` (~858 LOC). ADR-033 reclassified tmux as an **implementation-choice mechanism**, not an invariant — the invariant is "process isolation per agent" (invariant #2: atomic story concurrency). Story 1.4b (Docker containerization, ADR-024) adds a Docker image for dev/prod parity.

There is no formal `ExecutionEnvironment` contract that abstracts over these backends. If a Growth user wants to run agents in Docker containers for stronger isolation, or on remote hosts for scaling, the change would require modifying Overstory's internals.

**Decision:**

Define an `ExecutionEnvironment` interface with 4 methods + a health check, to be implemented in `factory-core/src/environments/`. The interface is minimal — it covers spawn, attach (for log streaming), detach, and destroy.

```typescript
export interface ProcessHandle {
  readonly id: string;
  readonly environment: string;   // "local" | "docker" | etc.
  readonly agentName: string;
  readonly storyId: string;
  readonly startedAt: Date;
}

export interface HealthStatus {
  readonly healthy: boolean;
  readonly lastCheck: Date;
  readonly details?: Record<string, unknown>;
}

export interface ExecutionEnvironment {
  readonly name: string;

  spawn(config: {
    agentName: string;
    storyId: string;
    capability: string;
    worktreePath: string;
    runtimeName: string;        // "claude" | "pi" | "codex" | "copilot"
    overlayContent: string;     // Generated CLAUDE.md content
    env?: Record<string, string>;
  }): Promise<ProcessHandle>;

  attach(handle: ProcessHandle): AsyncIterable<string>;  // Log stream
  detach(handle: ProcessHandle): Promise<void>;
  destroy(handle: ProcessHandle): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
}
```

**Local adapter (Growth, Story 11.6):** Wraps Overstory's existing `ov sling` tmux mechanism. The `spawn()` method calls `ov sling` with the appropriate arguments, `attach()` reads tmux pane output, `destroy()` kills the tmux session. This is a **thin wrapper**, not a rewrite — all actual agent lifecycle management remains in Overstory.

**Docker adapter (Growth, Story 11.7):** Spawns agents in isolated Docker containers using the image from Story 1.4b. Provides stronger isolation than tmux for multi-tenant Growth scenarios. `spawn()` calls `docker run`, `attach()` calls `docker logs --follow`, `destroy()` calls `docker stop && docker rm`.

**Key constraint:** The `ExecutionEnvironment` interface lives in Factory Core, but the LOCAL adapter delegates to Overstory. Factory Core does not reimplement agent lifecycle management — it abstracts over the execution backend while Overstory remains the agent lifecycle owner.

### Alternatives Considered

| Option | Pros | Cons | Outcome |
|---|---|---|---|
| **A. Minimal 4-method interface (chosen)** | Covers all needed operations; easy to implement; easy to test | Limited — no pause/resume, no resource limits in contract | **Accepted** — pause/resume can be added later |
| **B. Full Attractor ExecutionEnvironment (8+ methods)** | More complete; includes resource management, capabilities | Over-specified for Growth scope; most methods unused | **Rejected** — YAGNI |
| **C. Modify Overstory internals to support Docker** | Closer to the execution layer | Fork edit; couples Docker support to Overstory upstream | **Rejected** — fork hygiene |
| **D. No abstraction — Docker support via separate code path** | Quick to implement | Duplicates lifecycle management; hard to add more environments later | **Rejected** — extensibility |

### Consequences

**Positive:**

- Adding a new execution environment (K8s, SSH, WASM) requires only implementing the 4-method interface — no changes to Factory Core pipeline code
- Docker adapter provides stronger isolation for Growth multi-tenant scenarios
- Local adapter is a thin wrapper — Overstory's battle-tested tmux lifecycle is preserved

**Negative:**

- Premature abstraction risk — the factory may only ever need local + Docker
- Local adapter adds a layer of indirection over `ov sling` with no immediate behavioral benefit
- Docker adapter requires Docker daemon availability (addressed by ADR-024 Section 3)

**Neutral:**

- The interface is minimal enough that implementing a new adapter is ~80-130 LOC
- Kubernetes and SSH adapters are not in scope — they're documented as future possibilities, not commitments

### Acceptance Criteria

- [ ] ADR-040 present in `architecture-v2-session14-amendments.md`
- [ ] `ExecutionEnvironment` interface defined with type signatures
- [ ] `ProcessHandle` and `HealthStatus` types defined
- [ ] Local adapter scope documented (thin wrapper over `ov sling`)
- [ ] Docker adapter scope documented (uses Story 1.4b image)
- [ ] Factory Core / Overstory responsibility split documented
- [ ] Stories 11.6 and 11.7 referenced as implementation stories

### References

- StrongDM Attractor `coding-agent-loop-spec.md` Section on Execution Environment Abstraction
- ADR-033 invariant #2 (atomic story concurrency) — the invariant this contract helps satisfy
- ADR-033 mechanism reclassification — tmux as implementation choice, not invariant
- ADR-024 (Twelve-Factor Application Alignment) — Docker containerization foundation
- Story 1.4b (Build & Containerization) — Docker image this adapter uses
- Overstory `src/worktree/tmux.ts` and `src/worktree/manager.ts` (~858 LOC) — the local execution substrate

---

*End of session 14 amendments. ADR-036 through ADR-040 and amendments to ADR-019/ADR-021 are authoritative. Downstream artifact updates (PRD amendments, epics/stories, code-lift manifest, gap analysis) are tracked as Steps 2-6 of session 14.*
