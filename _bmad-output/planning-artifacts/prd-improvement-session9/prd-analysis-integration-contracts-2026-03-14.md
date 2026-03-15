# Integration Contract Analysis — QDS Engineer v2
**Date:** 2026-03-14
**Source:** prd-v2.md (v2.0, consolidated 2026-03-10)
**Scope:** All external and semi-external integrations required for MVP and Growth phases

---

## Summary Table

| Integration | Phase | Uncertainty | PRD Confidence | Spike Required |
|---|---|---|---|---|
| Pi SDK | MVP (critical path) | **HIGH** | Low — contract underdocumented | Yes — before story 1 |
| GitHub `gh` CLI | MVP | LOW | High — well-understood CLI | No spike; setup verification sufficient |
| Overstory | MVP (critical path) | MEDIUM | Medium — it's an existing OSS project but extensions are new | Partial — extension API must be validated |
| Telegram Bot API | MVP | LOW | High — standard REST API | No spike; standard integration |
| CopilotKit | MVP (Dashboard Copilot) | MEDIUM-HIGH | Low — PRD describes desired behavior but not the SDK surface | Yes — before dashboard copilot story |
| AG-UI Protocol | MVP (Dashboard Copilot) | **HIGH** | Very low — referenced by name, contract not described | Yes — before dashboard copilot story |
| Superpowers | MVP | LOW-MEDIUM | Medium — read-only filesystem consumer | No spike; YAML frontmatter extension is low-risk |

---

## 1. Pi SDK

### Role in the Platform
Pi SDK is the model-agnostic LLM runtime. Every agent runs inside Pi. Pi handles model selection natively (Opus 4.6 for premium tier, GLM-5 for economy tier), provider communication, rate limit backoff, and cost/token reporting per call. Factory Core configures Pi with API keys and tier directives; Pi executes them. The PRD states this eliminates the need for a separate API gateway layer.

Pi SDK is dependency #1 in the critical implementation path: `Pi SDK → Overstory extensions → Hook infrastructure → Phase Boundary Protocol → Superpowers consumption`.

### Expected API Shape / Contract

The PRD describes Pi's role extensively but never specifies its actual API surface. The following is inferred from PRD intent:

| Concern | What the PRD Asserts Pi Does | What the Actual API Must Provide |
|---|---|---|
| Model tier routing | "Factory Core sends tier directive (economy/standard/premium); Pi selects the model" | An API parameter or config field that accepts a tier designation or model name; some form of model aliasing or routing config |
| Model support | Opus 4.6 (premium), GLM-5 (economy), Sonnet (standard) | These specific models must be supported natively; if GLM-5 is not available via Pi, the economy-tier QA economics collapse |
| Cost/token reporting | "Pi SDK provides token usage and cost data per call" | A response object field (e.g., `usage.input_tokens`, `usage.output_tokens`, `usage.cost`) on every model call response |
| Rate limit handling | "Pi handles rate limit responses natively (backoff, retry)" | Built-in retry logic with configurable max retries; a way for Factory Core to observe when throttling is occurring |
| Agent isolation | "Agents run inside Pi SDK — Pi mediates all model API access. Agents never hold API keys directly." | A runtime host model where Factory Core configures Pi at startup with credentials, and agent processes call Pi via a local interface (IPC, local HTTP, or library call) — not by passing keys to agent code |
| Overstory integration | "Overstory runs inside Pi" | Pi must support hosting/spawning Overstory's agent processes, or Overstory must expose a way to use Pi as its LLM backend |

**Critical unknowns:**

- Is Pi SDK a library (imported by Factory Core), a sidecar process, or a hosted service? The PRD does not specify. This affects deployment, startup, and failure modes significantly.
- What is the actual programmatic interface? The PRD never shows a function call, type signature, or protocol example.
- How does "Overstory runs inside Pi" work mechanically? Does Pi provide a process host? Does Overstory call a Pi API for model invocations? This relationship is architecturally central but underdocumented.
- Is GLM-5 actually available via Pi SDK natively? The PRD states it is, but this must be verified. If GLM-5 requires OpenRouter, the economy-tier cost guarantee ($0.02/story quality pipeline) must be re-evaluated.
- What does "model-agnostic" mean in practice — can Factory Core switch between Anthropic Claude models and GLM-5 (a different provider entirely) through a single unified Pi call, or does this require provider-specific configuration?

### Known Failure Modes and PRD Handling

| Failure Mode | PRD Response | Gap / Concern |
|---|---|---|
| Pi process crash | "Dashboard shows Pi status. Auto-resume when Pi recovers. Agents preserve state via Overstory checkpoint." (Integration Map) | The PRD assumes Overstory state is independent of Pi state. If Pi is also the Overstory host, this assumption may be false. Needs architectural clarification. |
| Model unavailable (specific model down) | "Agents queue via Pi's native backoff." | If the specific tier model (e.g., GLM-5) is down and Pi has no automatic tier fallback, all economy-tier agents will queue indefinitely. PRD mentions OpenRouter as optional fallback but this is Growth. MVP has no fallback for model unavailability beyond queueing. |
| Rate limit sustained throttling | "Factory Core delays new agent spawns and adjusts concurrency limits." (Domain Requirements) | Requires Pi to surface sustained throttling state, not just per-call backoff. It's unclear whether Pi exposes this as a queryable state or only as per-call errors. |
| Pi SDK version breaking change | Not addressed | No versioning lock strategy is specified for Pi SDK. No pinning policy. |
| Cost/token data not available on a call | Not addressed | The attribution chain (FR42, FR96) blocks API calls without complete attribution. If Pi's cost reporting is unavailable (e.g., for certain models), what happens? The PRD states "API calls without a complete attribution chain are blocked, not silently executed" — but this creates a hard dependency on Pi's per-call cost reporting being reliable and universally available across all models/providers. |

### Versioning Commitments and Lock Requirements

The PRD contains no explicit version lock or pinning strategy for Pi SDK. Given that Pi SDK is the critical path foundation — everything in the platform runs on it — this is a material gap.

**Recommended:** Pin Pi SDK to a specific version before MVP development begins. Any upgrade must be treated as a breaking change candidate requiring full integration re-validation.

### Uncertainty Level

**HIGH**

The PRD is architecturally committed to Pi SDK as the LLM runtime without documenting the actual API contract, the Overstory/Pi relationship mechanism, or whether GLM-5 is actually available natively. This is the single highest-uncertainty integration in the platform.

### FRs Dependent on This Integration

All agent execution FRs depend on Pi SDK being correctly integrated. Key direct dependencies:

| FR | Dependency on Pi |
|---|---|
| FR36 | Model tier directives — Pi must accept and honor tier/model routing |
| FR42 | Attribution chain — Pi must return token/cost data on every call |
| FR13 | Economy-tier QA scouts — requires GLM-5 or equivalent economy model in Pi |
| FR36, FR118 | Copilot runs on economy-tier (GLM-5) — same dependency |
| FR96 | Attribution blocking — requires Pi cost data to be universally available |
| FR143 (Growth) | Rate limit snapshot tracking — requires Pi to expose rate limit headers |
| FR75 | Provider-down graceful stall — requires Pi to surface provider health status |
| NFR9 | API key isolation — Pi must be the sole credential holder, no key leakage to agents |

### Validation Spike Required

**Spike is mandatory before starting MVP implementation.**

The spike must answer:
1. What is Pi SDK's actual programmatic interface (library vs. process vs. service)?
2. Does Pi support GLM-5 natively, or is OpenRouter required for GLM-5 access?
3. How does Overstory integrate with Pi — what exactly does "Overstory runs inside Pi" mean mechanically?
4. Does Pi return per-call cost data for all supported models and providers?
5. What does Pi expose during rate limiting — per-call error only, or a queryable throttle state?
6. What version of Pi SDK exists today, and what is the upgrade/breaking change policy?

**Spike output:** A working proof-of-concept that spawns one agent via Pi, routes it through GLM-5 (economy tier) and Opus 4.6 (premium tier), and returns a response with verifiable cost/token attribution. If this cannot be demonstrated before MVP implementation begins, the architecture must be revised.

---

## 2. GitHub `gh` CLI

### Role in the Platform
The `gh` CLI is the exclusive mechanism for all GitHub operations: branch push, PR creation, PR comment reading (for the Seeds feedback loop), and CI status observation. It is a hard dependency — without it, the factory can develop and review code but cannot ship PRs, which is the endpoint of the entire pipeline.

### Expected API Shape / Contract

The `gh` CLI is well-documented. The PRD specifies the exact commands required:

| Operation | Command | Notes |
|---|---|---|
| Branch push | `git push -u origin qds/<dev>/<story-id>` | Standard git, not `gh` |
| PR creation | `gh pr create --title "..." --body "..."` | Body includes structured evidence template |
| PR comment reading | `gh api repos/{owner}/{repo}/pulls/{number}/comments` | Raw GitHub API passthrough via `gh api` |
| CI status observation | `gh pr checks` | Returns check run statuses for a PR |
| Auth verification | `gh auth status` | Must be run in setup script |

All of these are standard, stable `gh` CLI surface. No experimental or beta APIs are used.

**Constraints documented in PRD:**

- Must be installed and authenticated before setup completes (FR69 setup script verification)
- Must have repo scope for branch/PR operations
- PR body uses structured template with BMAD/QA evidence, severity tiers, coverage gap indicator, cost attribution, and factory instance ID (FR52, FR53, FR8)
- Growth: rate limit tracking during large epics (5,000 req/hr for authenticated calls — FR143 context)

### Known Failure Modes and PRD Handling

| Failure Mode | PRD Response | Gap / Concern |
|---|---|---|
| `gh` not installed | Setup script halts with specific error | Well-handled |
| Auth failure (token expired) | "Alert developer, halt PR operations" (Integration Map) | Conservative and correct. The alert mechanism should trigger both dashboard notification and Telegram (FR171, FR75 pattern). |
| Network timeout | "Retry with exponential backoff" (Integration Map) | Standard. The PRD does not specify retry count or backoff ceiling — this should be defined in implementation. |
| Rate limit (5,000 req/hr) | Queue and retry with backoff | For MVP (2 developers, low story volume), this is unlikely to trigger. Growth with large epics is the risk scenario. FR143 adds rate limit tracking in Growth. |
| PR body too large | Not addressed | Structured PR bodies with full BMAD/QA evidence can become large. GitHub PR body limit is approximately 65,536 characters. For stories with extensive BMAD findings and 5-wave QA results, this could be approached. The PRD specifies an expandable detail section — this is likely the mitigation, but it should be validated. |

### Versioning Commitments and Lock Requirements

`gh` CLI uses semantic versioning and is backwards-compatible for the commands used here. No version lock is strictly required, but the setup script should document a minimum tested version (recommend `>= 2.30.0`). The `gh api` passthrough command has been stable for several major versions.

### Uncertainty Level

**LOW**

This is the most well-understood integration in the platform. The `gh` CLI is a mature, stable tool used exactly as designed. The main risk is operational (auth expiry, rate limits) rather than contractual.

### FRs Dependent on This Integration

| FR | Dependency |
|---|---|
| FR8 | PR creation with evidence body |
| FR51 | Git safety iron laws (branch naming enforcement) |
| FR52, FR53 | Structured PR evidence, coverage gap indicator |
| FR54 | CI status observation via `gh pr checks` |
| FR69 | Setup script must verify `gh auth status` |
| FR90 | PR comment reading for Seeds feedback loop |

### Validation Spike Required

No spike required. Standard CLI integration. Verification in setup script (`gh auth status` + `gh pr create --dry-run` against a test repo) is sufficient validation.

---

## 3. Overstory

### Role in the Platform
Overstory is the agent orchestration component. Factory Core calls into Overstory for: agent spawning and lifecycle management, worktree isolation, mail-based inter-agent communication (SQLite-backed), session tracking, agent checkpoint/resume, and watchdog. Overstory is described as an "existing, proven system" that Factory Core orchestrates.

The PRD frames Overstory as a component Factory Core extends, not replaces. Extensions include: overlay injection additions (Factory Learnings injection, tier directives), new mail type (`learning_report`), and hook runner configuration.

### Expected API Shape / Contract

The PRD does not document Overstory's API surface explicitly, but the following interfaces are implied:

| Capability | Expected Interface |
|---|---|
| Agent spawning | An API call with: agent role, model tier directive, file scope, worktree assignment, overlay content. Returns agent ID. |
| Mail send/receive | `send_mail(from, to, type, content)` and `receive_mail(agent_id)` — SQLite-backed, exactly-once delivery (NFR18) |
| Agent lifecycle events | An event stream (consumed by Dashboard via SSE) carrying: agent_spawned, agent_stopped, agent_crashed, agent_mail_sent, phase_transition, hook_result |
| Checkpoint | Automatic — Overstory persists agent state to SQLite between turns. Factory Core reads this state on resume. |
| Watchdog | Periodic health check on running agents. Surfaces stalls (time-on-task with no output) to Factory Core. |
| Hook runner | A hook execution point in Overstory's agent execution loop that Factory Core configures with gate scripts |

**Critical extensions the PRD requires (new-write on top of Overstory):**

- `learning_report` mail type: a new structured mail type agents send to the story lead during execution (FR57, Loop 1). Must be added to Overstory's mail type registry.
- Overlay injection point: Overstory must accept a composed overlay from Factory Core's `overlay.ts` and inject it into the agent's context at spawn time.
- Tier directive plumbing: The model tier directive from Factory Core must flow through Overstory to the Pi SDK call for each agent.
- Hook runner hooks: Overstory's agent execution loop must support hook invocation points (post-edit, post-task) where Factory Core's gate scripts fire.

### Known Failure Modes and PRD Handling

| Failure Mode | PRD Response | Gap / Concern |
|---|---|---|
| Single agent crash | "Coordinator spawns replacement (max 3 attempts, then human escalation)" (FR22) | This is Overstory's native coordinator behavior. The 3-attempt ceiling and escalation path are new requirements on top of base Overstory. |
| All agents in one story crash | "Story fails, other stories continue unaffected" (Graceful Degradation Matrix) | Requires Overstory to scope failure to story boundaries, not affect the global session. This is likely native to Overstory's worktree isolation but must be verified. |
| Overstory SQLite write contention | "Overstory's transaction layer manages this — agents interact via API, never direct SQLite" (Data Integrity section) | Correct architectural pattern. NFR17 requires testing up to 15 concurrent agents without corruption. Overstory's transaction layer must support this. |
| Mail delivery failure | Not explicitly addressed beyond NFR18's exactly-once guarantee | The PRD asserts Overstory guarantees exactly-once mail delivery. This must be validated against actual Overstory behavior, not assumed. |
| Overstory version mismatch between developers | Setup script performs "version alignment verification" (Journey 3, FR69) | Good. This prevents behavioral divergence from version drift. |

### Versioning Commitments and Lock Requirements

The PRD explicitly calls out version alignment verification in the setup script (FR69) to ensure co-developer versions match. This implies Overstory should be pinned to a specific version (commit SHA or tagged release) in the project's dependency specification. The PRD does not state which version is current or what the minimum required version is.

### Uncertainty Level

**MEDIUM**

Overstory is described as "existing and proven," reducing uncertainty on core orchestration. However, the extensions required (new mail types, hook runner integration, overlay injection point, tier directive plumbing) are all new code. Whether Overstory's architecture cleanly supports these extension points — or requires forking/patching — is unknown without inspecting the current Overstory codebase.

The dashboard integration (SSE event stream from Overstory state) is also an extension point; Overstory must expose an event stream or the dashboard must poll SQLite directly (which creates a coupling the PRD explicitly avoids).

### FRs Dependent on This Integration

| FR | Dependency |
|---|---|
| FR21-FR27 | Core agent orchestration — spawn, monitor, stop, replace |
| FR23 | Mail system including `learning_report` type (extension) |
| FR24 | Checkpoint/resume |
| FR48 | Dashboard SSE from Overstory event stream |
| FR57 | `learning_report` mail type (Loop 1) |
| NFR17, NFR18 | Concurrent write safety and exactly-once mail delivery |

### Validation Spike Required

**Partial spike recommended before extension work begins.**

The spike should:
1. Confirm Overstory's current API surface supports the overlay injection, tier directive plumbing, and hook runner integration points.
2. Verify the event stream mechanism Overstory exposes (or confirm it needs to be added).
3. Confirm the mail system's current type registry is extensible without forking.
4. Run NFR17's concurrent stress test against current Overstory to confirm 15-agent write safety.

If any of these extension points require forking Overstory (rather than extending it via its public API), the implementation estimate for the critical path increases significantly.

---

## 4. Telegram Bot API

### Role in the Platform
Telegram provides the two-way communication channel for developer notifications and remote control. Factory Core sends escalation notifications with MarkdownV2 formatting and inline keyboard buttons. Developers send structured commands (/status, /stop, /nudge, /approve, etc.) and optionally natural language messages. Authentication is via registered Telegram user ID (one-time registration code flow).

Telegram is in the MVP scope specifically for Telegram (FR171 multi-channel abstraction ships with TelegramChannel as the first implementation).

### Expected API Shape / Contract

The Telegram Bot API is a well-documented, stable REST API. The contracts required are:

| Operation | API Method | Notes |
|---|---|---|
| Send notification | `sendMessage` with `parse_mode: MarkdownV2` | Inline keyboards via `reply_markup: InlineKeyboardMarkup` |
| Edit message (resolution sync) | `editMessageText` | Used by FR124 for dual-channel resolution sync |
| Receive commands | Long polling via `getUpdates` or Webhook | PRD does not specify which. Webhook is more reliable; long polling is simpler for local dev. |
| Bot registration | Manual — developer creates bot via @BotFather | Setup prerequisite, not an API call |
| User ID authentication | Match incoming `message.from.id` to registered developer ID | FR127 registration flow |

**PRD-specific requirements on the Telegram contract:**

- MarkdownV2 formatting for all notifications (FR120) — MarkdownV2 has strict escaping rules (`.`, `!`, `-`, `(`, `)` etc. must be escaped). This is a common source of message delivery failures and must be handled robustly in the `TelegramChannel` formatter.
- Inline keyboard action buttons (FR120) — each escalation type must map to keyboard buttons matching available response actions.
- NL classification for unstructured messages (FR128) — messages not matching command patterns are classified by an economy-tier LLM. Daily NL budget ceiling configurable (default $1.00). Attribution line: `system:messenger`.
- Credential sanitizer on all outbound messages (NFR33) — no API keys, file paths, or system details in any Telegram message.
- Quiet hours, DND mode, per-severity routing (FR125) — these are Factory Core concerns, not Telegram API concerns, but they affect the `TelegramChannel.send()` implementation.

### Known Failure Modes and PRD Handling

| Failure Mode | PRD Response | Gap / Concern |
|---|---|---|
| Telegram API down | Not explicitly addressed | Telegram is an optional notification channel, not a control dependency. Factory Core must handle `TelegramChannel.send()` failures gracefully — log and continue, never block factory execution. |
| Bot token invalid/revoked | Not addressed | Should trigger a setup/startup warning, not a factory halt. |
| Message too long (>4096 chars) | Not addressed | Telegram has a 4096-character message limit. Structured notifications with inline keyboards should be compact enough, but edge cases (long story IDs, many findings) could hit this. The `TelegramChannel.formatMessage()` implementation must enforce truncation. |
| MarkdownV2 parse error | Not addressed | Malformed MarkdownV2 causes Telegram to reject the message silently or return a 400 error. The formatter must escape all special characters. Tests should cover edge cases with special characters in story IDs, file paths, and error messages. |
| Rate limits (30 msg/sec to unique users) | Not addressed | For a 2-developer internal tool, rate limits are not a practical concern. Growth with many developers would require batching. |

### Versioning Commitments and Lock Requirements

Telegram Bot API is a REST API with no SDK version lock required. The API version is stable; Telegram maintains backwards compatibility for the methods used here. No pinning required beyond using the documented stable API endpoints.

### Uncertainty Level

**LOW**

Standard REST API with well-established patterns. The Telegram Bot API has been stable for years. The primary implementation risk is MarkdownV2 formatting correctness, not API contract uncertainty.

### FRs Dependent on This Integration

| FR | Dependency |
|---|---|
| FR120-FR129 | All Telegram notification and command FRs |
| FR22, FR38, FR39, FR47, FR73, FR74, FR75 | Telegram notification dispatch on specific events |
| FR171 | TelegramChannel implements the Channel interface |
| NFR32 | < 5 second notification delivery latency |
| NFR33 | Credential sanitizer on all outbound messages |
| NFR34 | NL budget ceiling for FR128 classification |

### Validation Spike Required

No spike required. A proof-of-concept bot that sends a formatted message with an inline keyboard and receives a command response is achievable in under 2 hours and should be completed as part of the FR171 implementation story, not as a pre-implementation spike.

---

## 5. CopilotKit

### Role in the Platform
CopilotKit is the SDK that provides the AI copilot integration in the dashboard. It exposes `useCopilotReadable` hooks to make dashboard state visible to the copilot, and `useCopilotAction` hooks to allow the copilot to execute dashboard controls. It is the bridge between natural language developer queries and programmatic dashboard interactions.

The dashboard copilot (FR105-FR119) is an MVP feature that represents a significant integration investment.

### Expected API Shape / Contract

CopilotKit is a real, publicly available React SDK. The PRD references it directly and describes the integration model accurately at a high level. The expected API:

| Hook/Component | Purpose | PRD FR |
|---|---|---|
| `useCopilotReadable(description, value)` | Exposes dashboard state (stories, agents, costs, stalls) to the copilot's context | FR111 |
| `useCopilotAction({ name, description, handler })` | Registers dashboard control actions (nudge, stop, navigate, etc.) the copilot can invoke | FR112 |
| `<CopilotChat />` or `<CopilotPopup />` | Renders the chat UI component docked to the right edge | FR105 |
| Custom copilot backend | Connects to Pi SDK economy-tier model, not CopilotKit's default backend | FR118 |

**Critical gap:** CopilotKit ships with its own backend/cloud service by default. The PRD routes copilot queries through Pi SDK (economy-tier for simple queries, standard tier for investigations). This requires configuring CopilotKit to use a custom backend that proxies to Pi SDK rather than CopilotKit's default cloud. The mechanism for this (CopilotKit's `runtimeUrl` config, a custom runtime adapter, or a self-hosted CopilotKit runtime) is not addressed in the PRD.

**AG-UI dependency:** CopilotKit's multi-step investigation capability (FR114) relies on AG-UI protocol for bidirectional streaming (FR113). CopilotKit and AG-UI are co-dependent in the PRD's copilot architecture. See Section 6.

### Known Failure Modes and PRD Handling

| Failure Mode | PRD Response | Gap / Concern |
|---|---|---|
| CopilotKit cloud backend unreachable | Not addressed | If the copilot is routed through CopilotKit's cloud, factory availability is coupled to CopilotKit SLA. Using a custom Pi SDK backend mitigates this but adds implementation complexity. |
| `useCopilotAction` handler throws | Not addressed | The PRD requires copilot actions to be confirmed before execution (FR109). The handler must gracefully handle failures and surface them in the chat without crashing the dashboard. |
| Copilot state desync (readable hooks return stale data) | Not addressed | Dashboard state changes frequently (agent status updates, cost ticks). CopilotKit's readable hooks must re-register or use reactive patterns to reflect current state. This is a known challenge with CopilotKit's data model. |
| Dashboard render performance impact | NFR31: "Chat bar must not impact dashboard render performance (30fps maintained)" | The xterm.js Agent Windows are already render-intensive. Adding CopilotKit's React state machinery increases re-render pressure. This NFR requires explicit verification during implementation. |

### Versioning Commitments and Lock Requirements

CopilotKit is actively developed with frequent releases. The copilot feature surface (useCopilotReadable, useCopilotAction) has been stable in recent major versions, but the SDK has undergone breaking changes between major versions. The project should pin CopilotKit to a specific major version and evaluate upgrades deliberately.

**Recommend:** Pin to a specific minor version (e.g., `@copilotkit/react-core@1.x.x`) at project start. Do not use `latest`.

### Uncertainty Level

**MEDIUM-HIGH**

CopilotKit is a real, documented SDK — the API surface is knowable. The uncertainty is in:
1. How to correctly configure it to use Pi SDK as the backend instead of CopilotKit's cloud.
2. Whether the AG-UI bidirectional streaming works as described in the PRD's investigation mode (FR114).
3. Performance implications of integrating CopilotKit's React state machinery with the existing xterm.js-heavy dashboard.

### FRs Dependent on This Integration

| FR | Dependency |
|---|---|
| FR105-FR119 | All Dashboard Copilot FRs |
| FR111 | `useCopilotReadable` hooks |
| FR112 | `useCopilotAction` hooks |
| FR113 | CopilotKit + AG-UI bidirectional streaming |
| FR118 | Custom Pi SDK backend routing |
| NFR8, NFR30, NFR31 | Copilot latency and dashboard performance NFRs |

### Validation Spike Required

**Yes — before the Dashboard Copilot epic begins.**

The spike must answer:
1. How is CopilotKit configured to use a custom backend (Pi SDK) instead of CopilotKit cloud?
2. Does CopilotKit's multi-step investigation capability (FR114) work via AG-UI or through a different mechanism?
3. Can `useCopilotReadable` efficiently track high-frequency dashboard state (agent token ticks, agent status changes) without causing excessive re-renders?
4. Does the chat bar + xterm.js combination maintain NFR5's 30fps requirement in a real browser test?

---

## 6. AG-UI Protocol

### Role in the Platform
AG-UI is described as the protocol providing "bidirectional streaming between the copilot agent and the dashboard" (FR113). It allows the copilot to send UI action sequences to the dashboard (navigate to Story 3, expand agent panel, send nudge) and the dashboard to stream state updates back to the copilot.

AG-UI is what enables Investigate mode (FR107, FR114): the copilot navigating the dashboard UI programmatically, correlating data from multiple sources, and presenting synthesized findings — all visible to the developer as the copilot moves through the UI.

### Expected API Shape / Contract

AG-UI is the highest-uncertainty integration in the platform. The PRD references AG-UI as a named protocol but provides no API contract, no documentation reference, and no description of the actual message format or transport.

What can be inferred from the PRD's description:

| Capability Described | What the Protocol Must Provide |
|---|---|
| "Copilot sends UI action sequences" (FR113) | A message format for declarative UI actions (navigate, expand, highlight, click) that the dashboard can interpret and execute |
| "Dashboard streams state updates back" (FR113) | A streaming channel (likely WebSocket or SSE) carrying dashboard state events to the copilot agent |
| "Investigation steps visible as action indicators" (FR115) | The copilot must be able to emit step-progress events that the chat UI renders as status messages |
| "Multi-step investigations chaining navigation, data retrieval, correlation" (FR114) | The protocol must support sequential action-response cycles within a single conversational turn |

**What is unknown:**

- Is AG-UI Protocol a formal open standard, a CopilotKit-specific protocol, or a pattern described in the copilot literature? The PRD provides no reference.
- What is the actual message schema?
- What transport layer does AG-UI use (WebSocket, SSE, HTTP streaming)?
- Is AG-UI natively supported by CopilotKit (which would explain the co-reference), or does it require a separate implementation?
- What is the current implementation maturity? Is this a production-ready protocol or a draft specification?

**Research note:** AG-UI Protocol (also called "Agent-User Interaction Protocol") appears to be an emerging open standard for streaming agent-to-UI communication. It is associated with CopilotKit's work on agentic UIs. If this is the case, it is likely a dependency of CopilotKit's multi-step agent capabilities rather than a separate integration — but this must be confirmed.

### Known Failure Modes and PRD Handling

| Failure Mode | PRD Response | Gap / Concern |
|---|---|---|
| Streaming connection dropped mid-investigation | Not addressed | Multi-step investigation (FR114) could be interrupted. The chat should degrade gracefully to showing partial results rather than hanging or erroring. |
| UI action sequence fails (element not found) | Not addressed | If the copilot sends a "navigate to Story 3 agent panel" action and that panel is not currently rendered, the action fails silently or throws. Error handling for AG-UI action failures is undefined. |
| Protocol version mismatch | Not addressed | AG-UI is emerging — version incompatibilities between the protocol and CopilotKit's implementation are a real risk. |
| Latency of bidirectional streaming | NFR8: Ask mode < 3s. NFR30: Investigate mode < 15s for 3 data sources. | These NFRs exist but are not grounded in measured AG-UI protocol latency characteristics. |

### Versioning Commitments and Lock Requirements

Unknown — the protocol's stability and versioning policy cannot be assessed without a documentation reference. This is a critical gap.

### Uncertainty Level

**HIGH**

AG-UI is the most uncertain integration in the platform. The PRD assumes its capabilities without documenting its contract. If AG-UI Protocol turns out to be:
- A CopilotKit-native feature: the integration complexity is lower but the implementation is tightly coupled to CopilotKit's version.
- A separate protocol requiring independent implementation: significant additional work is required.
- A draft/unstable standard: the implementation may need to track a moving target.

This uncertainty is compounded by the fact that AG-UI is co-dependent with CopilotKit — the two integrations must be validated together.

### FRs Dependent on This Integration

| FR | Dependency |
|---|---|
| FR113 | AG-UI bidirectional streaming — this FR is the integration statement itself |
| FR107 | Investigate mode — programmatic dashboard navigation depends on AG-UI action sequences |
| FR114 | Multi-step investigations — sequential action-response cycles |
| FR115 | Visible investigation step indicators in chat |

### Validation Spike Required

**Yes — this is the highest-priority spike after Pi SDK.**

The AG-UI spike should be combined with the CopilotKit spike (Section 5) since the two are architecturally coupled.

The combined spike must answer:
1. What is AG-UI Protocol exactly — formal standard, CopilotKit feature, or something else?
2. What is the actual message schema and transport?
3. Is AG-UI included in CopilotKit's SDK, or does it require a separate package/implementation?
4. Can the dashboard receive and execute declarative UI action sequences from the copilot agent?
5. Does the bidirectional streaming architecture support the Investigate mode use case (FR107, FR114)?
6. What is the end-to-end latency of a multi-step investigation via AG-UI (baseline measurement for NFR30)?

**Risk escalation path:** If the CopilotKit + AG-UI spike reveals that Investigate mode (FR107, FR114, FR115) is not achievable with the current state of these protocols, the copilot feature should be scoped down to Ask mode only for MVP, with Investigate mode deferred to Growth pending protocol maturity.

---

## 7. Superpowers

### Role in the Platform
Superpowers provides skills and quality gates consumed by Factory Core. It is a read-only filesystem consumer — Factory Core reads Superpowers skill files (markdown with YAML frontmatter) for two purposes:
1. Overlay injection (FR33): skill markdown injected into agent overlays for judgment-based self-policing
2. Hook enforcement (FR34): `enforcement` metadata in YAML frontmatter consumed by hook scripts for machine-validated gate enforcement

Superpowers itself is not called at runtime — the factory reads its configuration files. The `skills-core.js` library (which handles frontmatter extraction and skill discovery) is extended to extract the new `enforcement` fields.

### Expected API Shape / Contract

Since Superpowers is consumed as a filesystem configuration source, the "API" is the file format:

| Artifact | Current Format | Extension Required |
|---|---|---|
| Skill files | Markdown with YAML frontmatter (`name`, `description`) | New `enforcement` key in frontmatter containing `hook_checks` array (see PRD Technical Architecture section) |
| `skills-core.js` | Existing library for frontmatter extraction and skill discovery | Extended to extract `enforcement` fields |
| Skills directory | Known filesystem path | Factory Core must be configured with the Superpowers installation path |

**Enforcement frontmatter schema (from PRD):**
```yaml
enforcement:
  hook_checks:
    - hook: post-edit | post-task | phase-boundary
      type: file-pair | test-runner | lint-runner | type-checker | scope-validator | manifest-validator
      rule: <string>       # for declarative checks
      command: <string>    # for executable checks (template variables allowed)
      severity: warning | block
```

### Known Failure Modes and PRD Handling

| Failure Mode | PRD Response | Gap / Concern |
|---|---|---|
| Skill file read failure | "Warning logged. Agent operates without skills (degraded)" (Integration Map) | Correct graceful degradation. BMAD review becomes the sole enforcement. |
| Missing `enforcement` frontmatter (existing skills not yet extended) | Hook scripts simply find no `enforcement` section and skip machine validation for that skill | Fine for MVP — the 5 existing enforcement gates are extended explicitly. |
| Superpowers skill conflicts with Factory Learning injection | "Synthesis script validates against Superpowers iron laws; conflicts are rejected and logged" (FR59, FR60) | Well-handled. The synthesis script reads Superpowers gate definitions before approving learnings. |
| Skills directory path not configured | Not addressed explicitly | The factory needs to know where Superpowers is installed. This should be a required field in `factory.yaml` validated at setup time. |

### Versioning Commitments and Lock Requirements

Since Factory Core reads Superpowers files directly (no runtime call), versioning is about file format stability, not API stability. The extension of YAML frontmatter with `enforcement` metadata is additive and backwards-compatible — existing skills without `enforcement` blocks continue to work (no machine validation, only overlay injection).

The setup script's version alignment verification (FR69) covers Superpowers version matching between developers.

### Uncertainty Level

**LOW-MEDIUM**

The filesystem consumption model is the lowest-risk integration pattern in the platform. The primary uncertainty is:
1. Whether `skills-core.js` is cleanly extensible or requires patching to extract `enforcement` fields.
2. Whether the 5 existing Superpowers iron laws and hard gates can be expressed entirely in the `enforcement` frontmatter schema, or whether some require custom gate-runner logic beyond the 6 standard types.

### FRs Dependent on This Integration

| FR | Dependency |
|---|---|
| FR33 | Superpowers overlay injection |
| FR34 | `enforcement` frontmatter consumed by hook scripts |
| FR14 | 6-layer hook enforcement (Layer 1-2 gate definitions come from Superpowers) |
| FR59, FR60 | Synthesis script validates learnings against Superpowers iron laws |
| FR69 | Setup script verifies Superpowers installation and version |
| FR86 | Meta-optimization cannot violate Superpowers iron laws |

### Validation Spike Required

No dedicated spike required. As part of the Hook Infrastructure story (dependency item 3 in the implementation sequence), the team should:
1. Confirm `skills-core.js` can be extended to extract `enforcement` fields without forking.
2. Prototype the extended frontmatter on one skill file and verify hook script consumption.
3. Confirm the 5 MVP enforcement gates map cleanly to the `enforcement` schema types.

This validation is low-risk and naturally part of the Hook Infrastructure implementation story.

---

## Cross-Cutting Integration Risk Analysis

### Integration Dependency Graph

```
Pi SDK ─────────────────────────────────┐
  └── Overstory (runs inside Pi) ───────┤
       ├── Factory Core (orchestrates)  ├── All agent execution FRs
       ├── Hook Infrastructure          │
       └── Phase Boundary Protocol ─────┘

GitHub gh CLI ───────────────────────── FR8, FR51-FR54, FR90

Superpowers (filesystem) ────────────── FR14, FR33-FR34, Hook Infrastructure

Telegram Bot API ────────────────────── FR120-FR129, FR171 (TelegramChannel)

CopilotKit + AG-UI ─────────────────── FR105-FR119 (Dashboard Copilot)
  └── Pi SDK (custom backend) ──────── FR118
```

### Critical Path Bottleneck: Pi SDK + Overstory Co-Dependency

The Pi/Overstory relationship is the most architecturally ambiguous part of the platform. The statement "Overstory runs inside Pi" implies a hosting relationship, but neither Pi's hosting capability nor Overstory's integration interface is documented. Before any critical-path implementation begins, the team must have a working answer to: **what does "Overstory runs inside Pi" mean at the code level?**

If it means Overstory imports Pi as a library for LLM calls, the integration is straightforward. If it means Pi spawns Overstory as a subprocess, the process management and IPC design matters. If it means something else entirely, the entire implementation sequence needs to be re-evaluated.

### GLM-5 Availability: Economics Assumption at Risk

The entire economy-tier economics claim rests on GLM-5 being available via Pi SDK natively at low cost. The quality pipeline cost of "$0.02 per story" is cited as a key differentiator. If GLM-5 is only available via OpenRouter (which is Growth-only), MVP economy-tier routing falls back to the next cheapest native Pi model — which may not achieve the same economics. This must be confirmed in the Pi SDK spike.

### AG-UI: Acceptable Deferral Path

Of all the high-uncertainty integrations, AG-UI has the clearest deferral path: if the protocol is not mature enough for MVP, the copilot launches with Ask mode only (FR106 — query-only, no UI navigation). Investigate mode (FR107, FR114) and Act mode (FR108) are then deferred to Growth pending AG-UI maturity. The PRD's copilot is still useful in Ask mode for dashboard state queries, cost summaries, and status checks. This is the recommended fallback if the CopilotKit/AG-UI spike reveals material blockers.

### Integration Spike Prioritization

| Priority | Integration | Reason |
|---|---|---|
| 1 (Must complete before week 1 of dev) | Pi SDK | Foundation for all agent execution; GLM-5 availability must be confirmed |
| 2 (Must complete before Dashboard Copilot epic) | CopilotKit + AG-UI (combined) | Copilot feature cannot be designed without knowing the actual SDK surface and AG-UI protocol |
| 3 (Early in critical path, before Hook Infrastructure) | Overstory extension validation | Confirm extension points exist before building on them |
| 4 (Part of FR171 implementation story) | Telegram Bot | Low-risk; validate as part of implementation, not pre-implementation |
| 5 (Part of Hook Infrastructure story) | Superpowers frontmatter extension | Low-risk; validate as part of implementation |
| Not required | GitHub `gh` CLI | Standard CLI; setup verification is sufficient |

---

## Appendix: Integration Contract Gaps by FR

The following FRs have integration assumptions that are not yet verified by a contract:

| FR | Integration | Unverified Assumption |
|---|---|---|
| FR36 | Pi SDK | Pi accepts tier directives and routes to the correct model |
| FR42 | Pi SDK | Pi returns per-call cost/token data for all models including GLM-5 |
| FR96 | Pi SDK | Per-call cost data is always available; no silent attribution gaps |
| FR113 | AG-UI | Bidirectional streaming exists as described and is production-ready |
| FR114 | CopilotKit/AG-UI | Multi-step investigation mode is achievable with current SDK versions |
| FR118 | CopilotKit/Pi SDK | CopilotKit can be configured to use Pi SDK as its LLM backend |
| FR57 | Overstory | `learning_report` mail type can be added without forking Overstory |
| NFR17 | Overstory | SQLite layer handles 15 concurrent agents without corruption |
| NFR18 | Overstory | Mail delivery is exactly-once (assumed, not verified) |
| FR75 | Pi SDK | Pi surfaces provider health state (not just per-call errors) |
