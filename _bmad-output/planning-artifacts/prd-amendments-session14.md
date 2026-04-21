# PRD Amendment Document — Session 14

**Date:** 2026-04-20
**Scope:** Integrate StrongDM Attractor NLSpec concepts — 16 new FRs (FR197-FR212) covering pipeline extensibility, provider resilience, agent loop enhancement, human-in-the-loop, context fidelity, and execution environment abstraction
**Supersedes:** Nothing — all new additions
**Applies to:** PRD v2.0 (2026-03-10) + Session 8 amendments (FR130-FR171)

---

## Section 1: Preamble

### 1.1 Attractor as Pattern Source

StrongDM released [Attractor](https://github.com/strongdm/attractor) — three Natural Language Specifications describing how to build a software factory: pipeline orchestration (DOT-based graph), a programmable coding agent loop, and a unified multi-provider LLM client. QDS Factory already covers ~70% of what Attractor describes through Pi SDK (LLM abstraction), Overstory (agent orchestration), and the planned Factory Core middleware chain. This amendment integrates only the **genuinely additive** concepts — pipeline graph representation, formal provider contracts, cross-provider resilience, semantic loop detection, human approval gates, named fidelity modes, and execution environment abstraction.

Attractor is a PATTERN SOURCE — no code is lifted. All implementations are new-write following QDS conventions. This follows the same design-inspiration philosophy established in Session 8 (PRD Amendment Section 1.1) for research repositories.

### 1.2 MVP vs Growth Rigor

Of the 16 new FRs, only 2 are MVP:
- **FR199** (Provider Adapter Contract) — formalizes an implicit contract that exists today; low risk, high value as a foundation for Growth features
- **FR204** (Semantic Loop Detection) — addresses a real gap in token waste prevention; directly serves invariant #8 (cost circuit breakers)

The remaining 14 FRs are Growth. The existing 5-phase fixed pipeline, mechanical quality gates, and circuit breakers are sufficient for MVP's 2-developer audience. The Attractor-inspired patterns are extensibility investments for Growth personas (solo devs, startup CTOs, agency leads).

---

## Section 2: Pipeline Extensibility (FR197-FR198)

#### FR197: Pipeline Graph Representation (Growth)

Factory Core can express its pipeline as a declarative YAML graph where nodes represent pipeline stages and edges represent transitions with conditions. The built-in 5-phase pipeline (Develop → BMAD → Fix Loop → QA → PR) is the default graph template, immutable in MVP. Custom pipeline graphs (Growth) can be defined in `factory.yaml` for specialized workflows (e.g., documentation-only stories that skip QA, spike stories that skip BMAD review). Custom graphs must pass validation (FR198) before execution. The graph is inspectable via dashboard and CLI (`qds pipeline show`).

**Component integration:** Extends Factory Core pipeline engine (Story 4.0). Reads graph from `factory.yaml`. Renders in Dashboard.
**New-write:** YAML graph parser (~150 LOC), graph-to-execution compiler (~200 LOC).
**ADR References:** ADR-036
**Related FRs:** FR198 (validation), FR206 (human gates as graph node type)

#### FR198: Pipeline Graph Validation (Growth)

Factory Core validates pipeline graphs at load time against lint rules: (1) all nodes must be reachable from the start node, (2) all phase boundary nodes must have associated gate checks (per invariant #5 — mechanical quality gates at phase boundaries), (3) no infinite loops without goal-gate exit conditions or max-iteration limits, (4) all node references in edges resolve to defined nodes, (5) the default 5-phase template passes validation by construction. Validation errors are reported with node/edge identifiers and specific rule violations. Invalid graphs are rejected at startup — the factory does not run with an invalid pipeline configuration.

**Component integration:** Runs at Factory Core startup. Reads graph from FR197 parser output.
**New-write:** Graph validator with 5 lint rules (~150 LOC).
**ADR References:** ADR-036
**Related FRs:** FR197 (graph representation)

---

## Section 3: Provider Resilience (FR199-FR203)

#### FR199: Provider Adapter Contract (MVP)

Pi SDK provider integrations are wrapped in a typed `ProviderCapabilities` interface that declares capability flags: `supports_tool_calling`, `supports_structured_output`, `supports_streaming`, `supports_vision`, `supports_reasoning` (extended thinking), `max_context_window`, and `max_output_tokens`. The capabilities are computed statically from Pi SDK's existing `Model<Api>` metadata at startup — no runtime probing in MVP. The capability registry is a `Map<string, ProviderCapabilities>` keyed by model ID, defined in `shared-types` and validated at startup.

**Component integration:** Wraps Pi SDK `Model<Api>` types. Defined in `shared-types`. Consumed by Story 2.9 (TierResolver) and FR201 (fallback chains).
**New-write:** `ProviderCapabilities` interface (~30 LOC), capability computation from `Model<Api>` (~80 LOC), startup validation (~40 LOC), unit tests (~50 LOC).
**ADR References:** ADR-037
**Related FRs:** FR200 (runtime probing), FR201 (fallback chains), FR203 (automatic failover)

#### FR200: Runtime Capability Probing (Growth)

Factory Core can probe provider capabilities at runtime via a lightweight test call (e.g., a tool-use call with a no-op tool), updating the capability registry when providers add or remove features. Probing is optional, triggered by `factory.yaml` configuration (`capability_probing: true`), and runs at startup after static capability computation (FR199). Probing failures are logged as warnings — they do not block startup, and the static capabilities remain in effect.

**Component integration:** Extends FR199 capability registry. Calls Pi SDK providers. Writes to in-memory registry.
**New-write:** Probe executor with per-provider test calls (~100 LOC).
**ADR References:** ADR-037
**Related FRs:** FR199 (static capabilities)

#### FR201: Fallback Chain Configuration (Growth)

Factory Core supports configurable fallback chains in `factory.yaml` (`fallback_chains` key) mapping primary provider/model identifiers to ordered fallback sequences. Fallback is triggered by provider-level errors (rate limit, outage, timeout) classified per the error taxonomy (FR202), not by model-level failures (poor output quality, hallucination). Fallback is tier-constrained — a premium-tier primary only falls back to premium-capable alternatives. Maximum 2 fallback attempts per original request (primary + 2 fallbacks = 3 total providers tried).

**Component integration:** Extends Factory Core pipeline execution. Reads from `factory.yaml`. Integrates with TierResolver (Story 2.9) and capability registry (FR199).
**New-write:** Fallback chain resolver (~150 LOC), tier-constraint validation (~50 LOC).
**ADR References:** ADR-038
**Related FRs:** FR199 (capability checks), FR202 (error taxonomy), FR203 (automatic failover)

#### FR202: Error Taxonomy with Retryability Classification (Growth)

Provider errors are classified into a taxonomy with 4 categories: `retryable_transient` (HTTP 503, network timeout, connection reset — retry with exponential backoff up to 3 attempts), `retryable_after_backoff` (HTTP 429 with Retry-After header — wait then retry once), `non_retryable` (HTTP 401 invalid API key, HTTP 404 model not found — fail immediately, do not fallback), and `partial_success` (truncated response, incomplete tool call — accept partial result, log warning, do not trigger fallback). Classification is determined by HTTP status code + response body inspection. Each classification has a defined action policy.

**Component integration:** Wraps Pi SDK provider error responses. Consumed by FR201 (fallback chains) and FR203 (automatic failover).
**New-write:** Error classifier (~80 LOC).
**ADR References:** ADR-038
**Related FRs:** FR201 (fallback chains), FR203 (automatic failover)

#### FR203: Automatic Provider Failover (Growth)

When a provider error is classified as `retryable_transient` and retry attempts are exhausted, OR when a provider error is classified as non-responsive (no response within configurable timeout, default 30s), Factory Core automatically fails over to the next provider in the fallback chain (FR201). Failover is subject to: (1) the fallback provider must have the required capability flags (FR199), (2) the fallback must be within the same tier as the primary, (3) the global circuit breaker (FR170) is not open, and (4) maximum 2 fallback attempts. Cost attribution (invariant #4) is preserved — fallback provider costs are attributed to the same `developer → story → phase → agent` chain. If all fallback attempts fail, the error propagates to the pipeline as a phase-level failure.

**Component integration:** Extends Factory Core LLM call wrapper. Reads fallback chains (FR201). Checks capabilities (FR199). Integrates with circuit breaker (FR170/Story 8.5). Writes to `attribution.db` for cost tracking.
**New-write:** Failover executor with constraint checking (~150 LOC).
**ADR References:** ADR-038
**Related FRs:** FR199 (capability checks), FR201 (fallback chains), FR202 (error taxonomy), FR170 (circuit breaker)

---

## Section 4: Agent Loop Enhancement (FR204-FR205)

#### FR204: Semantic Loop Detection (MVP)

The turn continuation loop (Story 4.1) detects semantic loops — repeated patterns that waste tokens without making progress. Three detection patterns: (1) **Repeated identical tool calls** — same tool called with the same arguments (deep-equal on serialized args) more than 3 times within a sliding window of 10 tool calls; (2) **File rewrite cycles** — same file modified and content matches a prior version within the last 5 edits, occurring 3+ times; (3) **Token consumption without progress** — agent has consumed more than 2x the rolling median token count for the current phase type AND zero checklist items have advanced since the last velocity check. On detection, the `turn_state` record in `pipeline.db` gets a `loop_flag` column set to the detection pattern name (`looping`, `file_oscillating`, or `stalled_high_cost`). The orchestration loop (Story 4.0) reads `loop_flag` when evaluating phase transition — a flagged turn triggers the force-cap mechanism from Story 4.2, reducing remaining max_turns to 1.

**Component integration:** Extends turn continuation loop (Story 4.1). Reads tool call history from turn state. Writes `loop_flag` to `pipeline.db` `turn_state` table.
**New-write:** Tool call pattern tracker (~80 LOC), file oscillation detector (~40 LOC), token/progress comparator (~30 LOC), turn flagger (~30 LOC).
**ADR References:** ADR-019 amendment (Section 19.9)
**Related FRs:** FR149 (turn continuation), FR205 (warning injection)

#### FR205: Loop Warning Injection (Growth)

When a semantic loop is detected (FR204), Factory Core injects a diagnostic warning into the agent's next context turn via Pi SDK's steering mechanism (`getSteeringMessages()` callback). The warning describes: (a) the detected pattern (e.g., "You have called `write_file` on `src/auth.ts` 4 times with the same content"), (b) a suggestion to try an alternative approach, (c) a warning that continued looping will terminate the phase. If the loop persists after warning (same pattern detected in the very next turn), the phase is terminated and the pipeline evaluates whether to retry with a fresh agent or escalate to the developer.

**Component integration:** Extends FR204 detection. Uses Pi SDK `getSteeringMessages()` callback. Integrates with pipeline phase transition logic.
**New-write:** Warning message formatter (~40 LOC), steering injection adapter (~40 LOC).
**ADR References:** ADR-019 amendment (Section 19.9)
**Related FRs:** FR204 (loop detection)

---

## Section 5: Human-in-the-Loop (FR206-FR207)

#### FR206: Interactive Approval Gate (Growth)

Pipeline graphs (FR197) can include human gate nodes that pause execution and await developer approval. Each gate specifies: a question/prompt for the developer, a timeout (default: 24h), a default action on timeout (`approve`, `reject`, or `escalate`; default: `escalate`), and required approval count (default: 1). The story remains in `awaiting_approval` status in `pipeline.db` until resolved. Approval state is stored in `pipeline.db` tables `human_gates` and `human_gate_responses`. Gate resolution does not leak cross-phase context — the developer's comment is injected into the next phase's transfer manifest, not directly into agent context (preserving invariant #1).

**Component integration:** Extends pipeline graph execution (FR197). Writes to `pipeline.db`. Triggers notification via MessageBus (FR171).
**New-write:** Human gate node handler (~120 LOC), approval state machine (~80 LOC), pipeline.db schema extension (~40 LOC).
**ADR References:** ADR-039
**Related FRs:** FR197 (pipeline graph), FR207 (multi-backend interface), FR171 (notification delivery), FR193 (confidence-gated merge)

#### FR207: Multi-Backend Approval Interface (Growth)

Human gate approvals (FR206) can be delivered and responded to via multiple backends: CLI (`qds approve <gate-id> [--comment "..."]`), Telegram (inline keyboard buttons on the gate notification message, leveraging FR120-FR129), and Dashboard (approval card in the story detail view with comment field). All backends write to the same approval state in `pipeline.db`. The first response(s) that meet the `required_approvals` threshold resolve the gate.

**Component integration:** Extends FR206 approval state. CLI handler, Telegram bot handler, Dashboard component.
**New-write:** CLI approve command (~60 LOC), Telegram inline keyboard handler (~80 LOC), Dashboard approval card (~80 LOC).
**ADR References:** ADR-039
**Related FRs:** FR206 (approval gate), FR120-FR129 (Telegram), FR171 (MessageBus)

---

## Section 6: Context Fidelity (FR208-FR209)

#### FR208: Fidelity Mode Enum (Growth)

Factory Core defines three named fidelity modes for context carryover WITHIN a pipeline phase (across turns within the same agent session): `full` (complete session context carried forward — all messages, tool results, assistant responses preserved), `truncated` (last N turns carried forward, configurable per-phase, default 5 — earlier turns dropped, system prompt and overlay always preserved), and `compact` (Pi SDK `AgentSession.compact()` summary carried forward — produces a condensed summary fitting within a token budget). Fidelity modes operate WITHIN a phase, not across phases — cross-phase context isolation per ADR-006 is unchanged.

**Component integration:** Defined in `shared-types`. Consumed by middleware chain (Story 2.1) and `transformContext()` callback.
**New-write:** Fidelity mode type definition (~20 LOC).
**ADR References:** ADR-021 amendment (Section 21.6)
**Related FRs:** FR209 (per-phase configuration), FR155 (context budget 50% rule)

#### FR209: Per-Phase Fidelity Configuration (Growth)

`factory.yaml` supports a `fidelity` key per pipeline phase (e.g., `phases.develop.fidelity: full`, `phases.bmad.fidelity: compact`). For `truncated` mode, an additional `fidelity_truncation_turns` key specifies how many recent turns to keep (default: 5). Default fidelity per phase: develop=full, bmad=compact, fix_loop=truncated(5), qa=compact. Middleware chain (Story 2.1) reads the fidelity configuration and applies it via `transformContext()` before each LLM turn.

**Component integration:** Extends `factory.yaml` schema. Read by FidelityMiddleware in the middleware chain. Uses Pi SDK `AgentSession.compact()` for compact mode.
**New-write:** FidelityMiddleware implementation (~60 LOC), factory.yaml schema extension (~20 LOC), config loader update (~20 LOC).
**ADR References:** ADR-021 amendment (Section 21.6)
**Related FRs:** FR208 (fidelity mode enum)

---

## Section 7: Execution Environment (FR210-FR212)

#### FR210: Execution Environment Contract (Growth)

Factory Core defines an `ExecutionEnvironment` interface with methods: `spawn(config): ProcessHandle`, `attach(handle): AsyncIterable<string>` (log stream), `detach(handle): void`, `destroy(handle): void`, and `healthCheck(): HealthStatus`. All agent execution in Growth phase goes through this interface. The interface is defined in `factory-core/src/environments/types.ts` and consumed by the orchestration loop (Story 4.0).

**Component integration:** Defined in Factory Core. Consumed by orchestration loop (Story 4.0). Implemented by adapters (FR211, FR212).
**New-write:** Interface definition + types (~50 LOC).
**ADR References:** ADR-040
**Related FRs:** FR211 (local adapter), FR212 (Docker adapter)

#### FR211: Local Execution Environment Adapter (Growth)

The default `ExecutionEnvironment` adapter wraps Overstory's tmux-based execution, adapting the existing `ov sling` mechanism to the `ExecutionEnvironment` contract. `spawn()` calls `ov sling` with appropriate arguments. `attach()` reads tmux pane output. `destroy()` kills the tmux session. This is a thin wrapper — all actual agent lifecycle management (worktree creation, overlay generation, hook deployment, session tracking) remains in Overstory.

**Component integration:** Wraps Overstory `ov sling` CLI. Delegates all lifecycle management to Overstory.
**New-write:** Local adapter implementation (~80 LOC), integration tests (~50 LOC).
**ADR References:** ADR-040
**Related FRs:** FR210 (contract), FR212 (Docker adapter)

#### FR212: Docker Execution Environment Adapter (Growth)

A Docker `ExecutionEnvironment` adapter spawns agents in isolated Docker containers using the image from Story 1.4b. Provides stronger isolation than tmux for multi-tenant Growth scenarios. `spawn()` calls `docker run` with volume mounts for the worktree and environment variables for configuration. `attach()` calls `docker logs --follow`. `destroy()` calls `docker stop && docker rm`. Requires Docker daemon availability (per ADR-024 Section 3 — Debian-based images mandated).

**Component integration:** Uses Docker CLI. Requires Story 1.4b Docker image. Implements FR210 contract.
**New-write:** Docker adapter implementation (~120 LOC).
**ADR References:** ADR-040
**Related FRs:** FR210 (contract), FR211 (local adapter)

---

## Section 8: MVP/Growth Split Table

### New FRs (FR197-FR212)

| FR | Title | Phase | Rationale |
|----|-------|-------|-----------|
| FR197 | Pipeline Graph Representation | Growth | Fixed 5-phase pipeline sufficient for MVP |
| FR198 | Pipeline Graph Validation | Growth | Depends on FR197 |
| FR199 | Provider Adapter Contract | **MVP** | Formalizes implicit contract; foundation for Growth resilience features |
| FR200 | Runtime Capability Probing | Growth | Enhancement over MVP static capabilities |
| FR201 | Fallback Chain Configuration | Growth | Single-provider sufficient for MVP |
| FR202 | Error Taxonomy | Growth | Accompanies fallback chains |
| FR203 | Automatic Provider Failover | Growth | Depends on FR201, FR202 |
| FR204 | Semantic Loop Detection | **MVP** | Prevents token waste; serves invariant #8 |
| FR205 | Loop Warning Injection | Growth | Enhancement over MVP detection |
| FR206 | Interactive Approval Gate | Growth | Mechanical gates sufficient for MVP |
| FR207 | Multi-Backend Approval Interface | Growth | Depends on FR206 |
| FR208 | Fidelity Mode Enum | Growth | Implicit context management works for MVP |
| FR209 | Per-Phase Fidelity Configuration | Growth | Depends on FR208 |
| FR210 | Execution Environment Contract | Growth | tmux execution sufficient for MVP |
| FR211 | Local Execution Environment Adapter | Growth | Wraps existing tmux; no behavioral change |
| FR212 | Docker Execution Environment Adapter | Growth | Depends on FR211 and Story 1.4b |

### Addition Summary

**2 new MVP FRs** (FR199, FR204) — total MVP FRs: 147 (145 from sessions 3+8 + 2 new)
**14 new Growth FRs** (FR197-FR198, FR200-FR203, FR205-FR212) — total Growth FRs: 40 (26 from session 8 + 14 new)

---

## Section 9: Design Inspiration Reference

| Capability | QDS FR(s) | Inspired By | Pattern Reference | What We Take |
|-----------|-----------|------------|-------------------|-------------|
| Pipeline graph DSL | FR197, FR198 | StrongDM Attractor | `attractor-spec.md` Sections 1-3 | Declarative graph representation for pipeline stages; node/edge model; graph validation lint rules |
| Provider adapter contract | FR199, FR200 | StrongDM Attractor | `unified-llm-spec.md` Section 7 | Formal provider interface with capability discovery flags |
| Cross-provider fallback | FR201-FR203 | StrongDM Attractor | `unified-llm-spec.md` Section 6 | Error taxonomy with retryability classification; automatic failover with backoff/jitter |
| Semantic loop detection | FR204, FR205 | StrongDM Attractor | `coding-agent-loop-spec.md` Section on loop detection | Repeated tool pattern detection; warning injection mid-loop |
| Human gate nodes | FR206, FR207 | StrongDM Attractor | `attractor-spec.md` Section 6 | Interactive approval workflow; multi-backend Interviewer interface; timeout with configurable action |
| Fidelity modes | FR208, FR209 | StrongDM Attractor | `attractor-spec.md` fidelity modes | Named context carryover modes (full/truncated/compact) per pipeline stage |
| Execution environment | FR210-FR212 | StrongDM Attractor | `coding-agent-loop-spec.md` Section on Execution Environment | Formal execution contract abstracting over local/Docker/K8s backends |

---

*End of PRD Amendment Document — Session 14*
*Generated: 2026-04-20*
*Net result: 147 MVP FRs (145 prior + 2 new), 40 Growth FRs (26 prior + 14 new)*
