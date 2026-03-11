# Architecture Session Handoff Prompt

> **Purpose:** Paste this entire document as the first message in a new Claude Code conversation to seamlessly resume the QDS-Engineer-New architecture workflow at Step 4: Core Architectural Decisions.

---

## CRITICAL INSTRUCTIONS

You are resuming a BMAD architecture workflow for the **QDS-Engineer-New** project. The previous session completed Steps 1–3 and conducted 8 parallel deep-dive subagent investigations into the 10 critical architectural decisions that Step 4 must resolve. You will:

1. Load the BMAD architect agent persona (Winston)
2. Read the architecture document to restore full context
3. Execute Step 4 of the architecture workflow collaboratively
4. Use all research findings below as input to decision-making

**Invoke the architecture skill to resume:**
```
/bmad-bmm-create-architecture
```

When the workflow loads, tell it: **"Resume at Step 4. Steps 1–3 are complete. All research findings are in the handoff prompt."**

---

## PROJECT IDENTITY

- **Project:** QDS-Engineer-New — Full-stack AI Workforce Management Platform
- **What it does:** Orchestrates AI coding agents through a quality-gated pipeline (dev → review → QA → merge) with economic governance, learning loops, and real-time observability
- **User:** Steve (config in `_bmad/core/config.yaml`)
- **Working directory:** `/Users/steve/QDS-Engineer-New`

---

## DOCUMENT LOCATIONS

| Document | Path |
|---|---|
| **Architecture (primary artifact)** | `_bmad-output/planning-artifacts/architecture.md` |
| PRD | `_bmad-output/planning-artifacts/prd.md` |
| UX Design Specification | `_bmad-output/planning-artifacts/ux-design-specification.md` |
| PRD Handoff Context 1 | `_bmad-output/planning-artifacts/prd-handoff-context.md` |
| PRD Handoff Context 2 | `_bmad-output/planning-artifacts/prd-handoff-context-session3.md` |
| Step 4 Workflow | `_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-04-decisions.md` |
| Step 5 Workflow (next) | `_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-05-patterns.md` |
| Architect Agent | `_bmad/bmm/agents/architect.md` |

---

## WORKFLOW STATE

- **Steps completed:** 1 (Init), 2 (Context Analysis), 3 (Starter Template Evaluation)
- **Current step:** 4 (Core Architectural Decisions) — loaded but NOT executed
- **Party Mode rounds completed:** 3 (Round 1: Winston/Amelia/Mary; Round 2: John/Quinn/Barry; Round 3: Winston/Barry/Sally)
- **Advanced Elicitation rounds:** 1 (5 methods: Failure Mode, Pre-mortem, ADR, First Principles, Red Team/Blue Team)
- **Frontmatter `stepsCompleted`:** `[1, 2, 3]` — update to `[1, 2, 3, 4]` when Step 4 completes

---

## SOURCE PROJECTS (6 repos inside the working directory + 1 external)

| Project | Location | What it provides |
|---|---|---|
| Overstory | `overstory/` | Agent orchestration, lifecycle, mail, Mulch, Seeds, SQLite stores, hook deployment |
| Pi SDK | `pi-mono/` | Model-agnostic LLM runtime, cost/token reporting, agent framework |
| ZeroClaw | `zeroclaw/` | React 19 + TS + Vite dashboard shell (selective copy of 6 files), SSE/WS transport |
| Superpowers | `superpowers/` | Skills system, hooks, enforcement gates, skills-core.js |
| claude-mem | `claude-mem/` | Memory system, progressive disclosure, SQLite + Chroma |
| QDS-Engineer v1 | `QDS-engineer/` (also external at `/Users/steve/QDS-engineer/`) | Python/FastAPI prototype, 8-step workflow, 5-wave QA, proves the pattern |

---

## ARCHITECTURE DECISIONS ALREADY MADE (from Steps 1–3)

### ADR-001: Dashboard Initialization — Selective Copy from ZeroClaw
- Copy 6 infrastructure files from `zeroclaw/web/` (index.html, vite.config.ts, tsconfig.json, tsconfig.app.json, src/lib/sse.ts, src/lib/ws.ts)
- Write fresh `@theme` from UX spec (different hex values than ZeroClaw)
- Fresh package.json and all application code

### ADR-002: Factory Core Package Boundary — Separate Package in Bun Workspace
- Factory Core is a separate TypeScript package in a Bun workspace monorepo
- Source projects consumed from `vendor/` directory, NOT workspace members
- Explicit dependency boundary enforced via package.json

### Monorepo Layout: `packages/` (factory-core, gateway, dashboard, shared-types) + `vendor/` (overstory, pi-mono, superpowers, claude-mem)

### Technology Stack (locked by source projects):
- Backend: TypeScript/Bun
- Dashboard: React 19 + TypeScript 5.7 + Vite 6 + Tailwind CSS 4
- State: SQLite (backend), Zustand (frontend)
- Terminal: xterm.js
- Charts: recharts or visx
- Icons: Lucide React
- Fonts: Inter + JetBrains Mono

---

## 10 CRITICAL ARCHITECTURAL DECISIONS FOR STEP 4

These were identified at the end of Step 3 and researched via 8 parallel deep-dive subagents. Organized into 3 clusters:

### Cluster A: Backend Pipeline (5 decisions)

#### Decision 1: Gateway Architecture (SSE Translation Layer)
**The problem:** Overstory uses polling-based event streaming (`ov feed --follow`, 200ms min interval, queries EventStore SQLite). Dashboard needs HTTP SSE with <2s latency.

**Research findings (deep codebase inspection):**

**Overstory EventStore** (`overstory/src/events/store.ts`, 370 lines):
- Schema: `events` table with `id` (autoincrement), `run_id`, `agent_name`, `session_id`, `event_type`, `tool_name`, `tool_args`, `tool_duration_ms`, `level` (CHECK: debug/info/warn/error), `data` (JSON), `created_at` (ISO 8601 microsecond)
- 5 indexes: `(agent_name, created_at)`, `(run_id, created_at)`, `(event_type, created_at)`, `(tool_name, agent_name)`, `(level) WHERE level='error'`
- WAL mode, `synchronous=NORMAL`, `busy_timeout=5000`
- Query methods: `getByAgent()`, `getByRun()`, `getTimeline(since)`, `getErrors()`, `getToolStats()` (GROUP BY aggregation)
- **Key for gateway:** `getTimeline(since)` with required `since` parameter — the polling query endpoint

**Overstory has NO HTTP server:**
- No `Bun.serve()` anywhere in overstory/src/
- All observability is CLI: `ov feed`, `ov watch`, `ov dashboard`, `ov logs`, `ov inspect`
- `ov feed --follow` polls events.db by row ID at configurable interval (default 1000ms, min 200ms)
- Tracks `lastSeenId` and filters `e.id > lastSeenId` client-side

**ZeroClaw's existing SSE server** (`zeroclaw/src/gateway/sse.rs`, 226 lines — Rust/Axum):
- Complete working SSE implementation with auth, broadcast channel, keep-alive
- Uses `tokio::sync::broadcast::Sender<serde_json::Value>`
- Lagged messages silently dropped (no replay)
- NO Last-Event-ID support — no per-client cursor tracking
- Events: llm_request, tool_call_start, tool_call, error, agent_start, agent_end

**ZeroClaw's SSE client** (`zeroclaw/web/src/lib/sse.ts`, 186 lines):
- Fetch-based ReadableStream consumer, TextDecoder accumulation, double-newline splitting
- Reconnect: exponential backoff 1s → 2s → 4s → 8s → 16s → 30s (capped)
- NO Last-Event-ID header sent — event loss on disconnect
- No explicit backpressure — relies on TCP flow control

**Architectural gaps for the gateway package:**
1. Need to bridge Overstory SQLite polling → HTTP SSE push (Overstory has no server)
2. Need Last-Event-ID support (neither ZeroClaw client nor server has it)
3. Need backpressure strategy beyond silent drop
4. Event schema translation: Overstory's `StoredEvent` ≠ ZeroClaw's `ObserverEvent`

**Recommended MVP:** Bun.serve() SSE endpoint in gateway package polls EventStore at 500ms interval. Per-client cursor via `Last-Event-ID` mapping to `events.id`. Full state snapshot on reconnect. Event schema defined in shared-types package.
**Critical Bun.serve() trap:** Must call `server.timeout(req, 0)` on SSE requests to disable idle timeout (default 10s kills SSE connections during quiet periods).
**Wire format:** `id:` field (EventStore row ID) + `event:` field (eventType) + `data:` field (full JSON). `:keepalive\n\n` every 15 seconds.
**Backpressure:** Ring buffer (500 events, matching Overstory's `EventBuffer` pattern from `dashboard.ts` lines 249-286). If client falls behind ring buffer, send `event: snapshot` with full state instead of replay.
**Client tracking:** `Set<SSEClient>` with per-client `lastSeenId` and optional filters. Cleanup on `ReadableStream.cancel()`.
**SSE client adaptation needed:** ZeroClaw's `sse.ts` does NOT parse `id:` fields or send `Last-Event-ID` — both must be added. Existing reconnect/backoff logic (1s→30s exponential) carried forward unchanged.
**Mock mode detail:** Use `createEventStore(":memory:")` — in-memory SQLite with same schema. Deterministic scenario replay. Same poll loop code path as real mode — only DB path differs. Enables reproducible screenshots and visual regression tests.
**Reconnection budget (NFR19, 5s):** Reconnect delay 1s + TCP 50ms + snapshot query 100ms + transfer 10ms + React hydration 200ms = ~1.4s total. Well within budget.
**Growth path:** SQLite WAL file watcher (FSEvents/inotify) or in-process pub/sub from Factory Core. WAL watching adds complexity + platform differences — not recommended for MVP.

#### Decision 2: Factory Core Pipeline State Storage
**The problem:** Factory Core needs to track pipeline state (current phase, gate results, budget consumption) separate from Overstory's SessionStore (which tracks agent lifecycle only).

**Research findings from QDS-Engineer v1 (comprehensive deep-dive):**
- v1 uses `.qds_workflow_state.json` file — simple but not concurrent-safe
- v1's WorkflowEnforcer pattern (350 LOC state machine) is proven effective — direct port to TypeScript recommended
- **8-step mandatory workflow proven in 39 PRs:** ORIENT → GET_STATUS → QDS_DEV → BMAD_REVIEW → COMMIT → PR_CREATED → PR_MONITOR → STATE_UPDATED
- **5-wave QA coordinator** (1349 LOC, `src/qa/wave_coordinator.py`):
  - Waves 1-2: Discovery (parallel) — type safety, error handling, code style specialists
  - Wave 3: Fixing (sequential) — apply fixes, smoke test, rollback if needed
  - Wave 4: Advanced fixing — higher-tier models for complex issues
  - Wave 5: Verification — final validation & sign-off
- **Multi-round QA:** Up to 3 rounds, each in fresh session (~67K tokens/round), decision gate after each (PASS/PARTIAL+minor→stop, has critical→continue)
- **CCR + GLM-5 cost optimization:** QA discovery phases → GLM-5 ($1/M vs $3/M), complex fixes → Sonnet. 60% cost savings with quality parity. Enable by default in v2.
- **PR#13 lesson:** Claude Code bypassed the harness entirely → fix in PR#14 added WorkflowEnforcer + git hooks at multiple enforcement levels (hooks + SDK + state machine)
- **Async PR feedback loop:** FastAPI webhook server on port 8080, CodeRabbit/Gemini comment parsing, non-blocking agent delegation for fixes
- **Token budget proven:** 100K per session working well. Per-session not per-task.

**Key question:** SQLite (separate DB, WAL mode, consistent with Overstory pattern) vs filesystem JSON (simple, human-readable, debuggable) vs in-memory with WAL checkpoint?

#### Decision 3: Overlay Composition Pipeline Design
**The problem:** Factory Core's 6-stage composable pipeline wraps Overstory's `generateOverlay()`. How exactly does this work?

**Research findings:**
- **Two-pass pipeline:** Pass 1 (estimate) → budget allocation → Pass 2 (render)
- **6 stages in priority order:** (1) Identity & role, (2) Superpowers enforcement, (3) Story context & requirements, (4) Mulch conventions, (5) Learning injections, (6) Meta-optimization directives
- **Budget allocation:** Priority-weighted demand-aware. Stage 1 gets guaranteed minimum. Remaining budget allocated proportionally to demand.
- **Token estimation:** `chars / 4` heuristic — used consistently across ALL 6 source projects
- **Caching:** Content-addressed cache with xxhash64 hash keys. Cache key = hash(stage_inputs). Invalidation on source file change (Mulch files, learning records, story spec)
- **Integration point:** `Agent.transformContext()` in Pi SDK (`pi-mono/packages/agent/src/agent.ts`) — overlay injected here
- **Overstory's `generateOverlay()`** from `overstory/src/agents/overlay.ts` becomes Stage 0 (base template) that the 6 stages then extend/override
- Functions needed from overlay.ts are currently module-private — must be exported or wrapped: `formatFileScope()`, `formatQualityGates()`, `formatConstraints()`, `formatCanSpawn()`, `formatMulchDomains()`, `formatMulchExpertise()`, `formatDispatchOverrides()`
- **Recommended: Wrap individual formatters, not `generateOverlay()`** — gives Factory Core granular budget control per section while reusing Overstory's proven formatting logic. When Overstory adds new sections, Factory Core imports the new formatter.
- **Mulch content prioritization:** Greedy knapsack with composite scoring — file path relevance (highest weight), classification tier (foundational > tactical > observational), recency decay (30-day half-life), category boosting, outcome-validated bonus
- **Cache correctness guarantee:** Content-addressed cache beats file watchers (platform-specific, race conditions, doesn't work across git worktrees) and TTL-based (any TTL > 0 has staleness window). xxhash64 performance: <1ms for typical .mulch/ directory (<50KB total) at >10GB/s throughput.
- **Pipeline creates 7 files** in `packages/factory-core/src/overlay/`: types.ts, pipeline.ts, budget.ts, cache.ts, tokens.ts + stages/ subdirectory with 6 stage implementations
- **Open design items for Step 4:** (1) Stage 5 — full spec content vs spec path only, (2) Stage 6 — phase boundary manifest format, (3) Stage 4 — .qds/learnings/synthesized/ file structure

#### Decision 4: Hook Pipeline Architecture
**The problem:** 6-layer hook enforcement must be reliable, fast (<2s NFR), and handle failures without creating enforcement gaps.

**Research findings:**
- **Execution model:** Tiered sequential — layers execute in order within each tier, tiers can run independently
- **Tier 1 (per-edit):** PreToolUse/PostToolUse hooks via Claude Code settings.local.json (Overstory's `hooks-deployer.ts` pattern)
- **Tier 2 (per-task):** PostTask hooks — broader validation
- **Tier 3 (per-phase):** Phase boundary checks — the hard context wipe gate
- **Tier 4 (BMAD review):** Architectural compliance validation
- **Tier 5 (QA swarm):** Multi-round adversarial quality review
- **Failure classification:** Each hook returns PASS / FAIL / DEGRADED
  - PASS: continue
  - FAIL: block action, surface to dashboard
  - DEGRADED: log warning, continue with reduced confidence, feed into quality score
- **Timeout handling:** Per-hook timeout (2s default), timeout → DEGRADED (not FAIL). No enforcement gap — the action proceeds but quality score drops.
- **IPC model:** Single Bun runner process. Hooks communicate via SQLite polling at 500ms (consistent with Overstory pattern). Per-file debounce (2s window, latest-wins) to avoid duplicate triggers.
- **Gate scripts:** Extend Overstory's `guard-rules.ts` pure data patterns. Gate scripts are functions that consume guard rules, not replacements. Guard rules = "is this allowed?" (Layer 1). Gate scripts = "was this done correctly?" (Layers 2-4).
- **Hook runner architecture:** Single Bun process, child processes per hook invocation with `AbortSignal.timeout()`. Layer 1 NOT managed by runner (lives in Claude Code's synchronous PreToolUse). Layers 5-6 spawned as full agents via `ov sling`.
- **Layer interaction matrix:** L1 timeout → L2 fires (different trigger). L2 timeout → L3 fires. L3 timeout → L4 fires (DEGRADED noted in gate checklist). L4 timeout → L5 does NOT fire (phase transition is the trigger). L5 timeout → L6 fires. L6 timeout → PR creation fires with DEGRADED annotation.
- **Result aggregation:** Event-sourced `HookResultEvent` in events.db with three projection views: (1) dashboard SSE at 500ms, (2) PR evidence query at PR creation time, (3) learning records query at story completion. `Finding[]` sub-objects with severity (critical/warning/info), category, file, line, message, resolved flag.
- **Gate script interface:** Receives `GateContext` via stdin JSON (storyId, agentName, worktreePath, modifiedFiles, phase, priorResults), writes `GateResult` to stdout. Exit code 0=pass, 1=fail, 2=degraded.
- **Existing infrastructure to reuse:** hooks-deployer.ts (hook deployment), guard-rules.ts (Layer 1 constants), pi-guards.ts (runtime guard gen), watchdog/daemon.ts (progressive failure model), ZeroClaw gates.rs (state machine model)
- **Superpowers integration:** skills-core.js is plain JavaScript ES6 — 5 exported functions: `extractFrontmatter()`, `findSkillsInDir()`, `resolveSkillPath()`, `checkForUpdates()`, `stripFrontmatter()`. Import as library with `.d.ts` type declarations. Personal skills shadow Superpowers skills.
- **SessionStart hook:** Must be synchronous (async: false) — first-message context injection. Polyglot wrapper for cross-platform execution.

#### Decision 5: Phase Boundary Protocol Implementation
**The problem:** Phase Boundary Protocol is the core quality guarantee — hard context wipe between dev and review phases. How is isolation proven?

**Research findings (applying formal security models):**
- **5-layer defense model:**
  1. **Process isolation:** New tmux session = new Claude Code process. No shared memory. Overstory's `tmux.ts` already has `killSession()` with process tree walk + SIGTERM + SIGKILL.
  2. **Manifest-only transfer:** Structured JSON manifest (file list, gate results, metadata) is the ONLY artifact that crosses the boundary. No raw context.
  3. **Capability restriction:** Review agent has read-only filesystem access (Pi SDK sandbox extension pattern from `.pi/extensions/`). Cannot modify files, only annotate.
  4. **Canary token verification:** Factory Core injects a random token into dev agent's context. After phase transition, query review agent for the token. If found → isolation breach → abort.
  5. **Cryptographic audit:** Merkle tree of manifest contents. Hash stored before transition, verified after. Tampering detected.
- **Testing strategy:** Canary tokens are the primary testable guarantee. Inject 3 canary tokens per phase transition (in system prompt, in tool output, in conversation context). Verify all 3 are absent from review agent's first response.
- **Transcript quarantine:** Dev phase transcript is NOT deleted (needed for learning) but is NOT accessible to review phase process. Stored in `.qds/transcripts/{story_id}/dev/` — review agent's filesystem scope excludes this path.
- **Formal security model validation:** BLP (no read up), Biba (no read down — review integrity), Denning lattice (two-level flow control), Goguen-Meseguer non-interference all confirm architecture soundness. Manifest is the "reference monitor" / "declassifier" — its correctness determines system security.
- **6 specific leakage vectors identified:** (1) Transcript files at `~/.claude/projects/` — user-global, not worktree-scoped, (2) `/tmp` and Bun module cache, (3) Environment variables from Factory Core parent process, (4) Overstory SQLite databases — review agent could run `ov mail list` or `ov feed`, (5) Git commit messages with explanatory content, (6) Bun module cache (innocuous). Mitigations: transcript quarantine, database phase-scoping, mechanical commit messages.
- **Capability-based security (POLA):** Review agents get positive capability grants (readable/writable directories, mail access level) rather than negative constraints. Enforced via Claude Code `settings.local.json` `allowedDirectories`/`deniedDirectories` + Pi SDK guard extensions.
- **Merkle tree audit:** Hash every review agent input at spawn (manifest, overlay, worktree tree hash, Mulch, Superpowers). Store root hash in `.qds/audit.db`. Reconstruct at audit time to verify.
- **QDS is novel:** No existing multi-agent framework (AutoGen, CrewAI, LangGraph, Agent SDK) combines process isolation with formally defined manifest boundary. QDS Phase Boundary Protocol is the only system with all three: process isolation + manifest-only transfer + schema validation.
- **Open design items for Step 4:** (1) Transcript quarantine — move/rename vs deny via settings, (2) Learnings field — closed vocabulary vs LLM validator, (3) Fresh worktree vs reuse for review agent, (4) Overstory mail `phase` column vs application-level filtering, (5) Behavioral leakage testing feasibility

### Cluster B: Integration & Verification (3 decisions)

#### Decision 6: Context Isolation Testing Strategy
**The problem:** How do you continuously verify that phase boundaries actually isolate context?

**Research findings:**
- Canary token injection (see Decision 5) is the primary mechanism
- Additionally: manifest schema validation — reject any manifest field not in the whitelist
- Hash comparison: hash of dev agent's working memory vs review agent's initial state — must be completely disjoint
- **Automated regression:** Every factory run generates an isolation report. Dashboard displays isolation confidence score.
- This is the "proof of isolation" the architecture document flagged as critical in Cross-Cutting Concern #1

#### Decision 7: Attribution Chain Implementation
**The problem:** Every API call needs `developer_id → story_id → phase → agent_id → model → provider → token_count → cost`. Pi SDK provides some but not all.

**Research findings:**
- Pi SDK's `AssistantMessage` already provides: `api`, `provider`, `model`, `usage` (tokens + cost), `timestamp`
- Missing from Pi SDK: `developer_id`, `story_id`, `phase`, `agent_id`
- **Solution:** `StreamOptions.metadata` passthrough confirmed viable — Factory Core injects missing fields before each API call, Pi SDK passes them through, merged post-response
- `developer_id` comes from `factory.yaml` config
- `story_id` and `phase` come from Factory Core pipeline state
- `agent_id` comes from Overstory session
- FR96 requires blocking calls without complete chains — implemented as a pre-call validation hook

#### Decision 8: Superpowers Integration Strategy
**The problem:** Superpowers' skills-core.js is plain JavaScript. The rest of the stack is TypeScript/Bun.

**Research findings:**
- `skills-core.js` exports 5 functions — small surface area, import as-is
- Create `skills-core.d.ts` type declarations for TypeScript consumption
- Enforcement is text-based: HARD-GATE tags, Iron Laws, Rationalization Prevention Tables — these are injected as text blocks in overlays, not programmatic enforcement
- Frontmatter is minimal: only `name` + `description` (YAML)
- Personal skills shadow Superpowers skills (priority resolution)
- **14 skills** in the Superpowers system
- Hook system: SessionStart hook with `async: false` (synchronous execution)
- **Skill dependency flow:** using-superpowers (entry) → brainstorming (design) → using-git-worktrees (isolation) → writing-plans → subagent-driven-development OR executing-plans → requesting-code-review → finishing-a-development-branch
- **TWO-STAGE review in subagent-driven-development:** Stage 1 = spec compliance review (did they build what was asked?), Stage 2 = code quality review (is it clean?). Order is strict: spec before quality. Factory Core's QA swarm should adopt this pattern.
- **CSO (Claude Search Optimization) rule:** Skill descriptions must be triggering CONDITIONS only, never workflow summaries. Testing proved summaries cause Claude to skip reading the full skill body.
- **Integration approach:** Import `skills-core.js` as library in Factory Core's overlay composition Stage 2. Use `findSkillsInDir()` to enumerate skills, `extractFrontmatter()` for metadata, inject enforcement text into overlay. No TS port needed — the 5 functions are stable and small.

### Cluster C: Frontend & Testing (2 decisions)

#### Decision 9: Dashboard Copilot Architecture
**The problem:** CopilotKit + AG-UI integration for conversational AI in the dashboard. 15 FRs.

**Research findings:**
- **CopilotKit hooks:** `useCopilotReadable()` exposes Zustand state to copilot. `useCopilotAction()` registers functions the copilot can invoke.
- **AG-UI transport:** Uses SSE for copilot ↔ backend communication. 300ms pacing is frontend-enforced.
- **Integration with Zustand:** CopilotKit hooks work naturally with Zustand stores. Each Zustand slice registers its readable state and available actions.
- **Copilot acts through same controls:** When copilot "clicks" a button, it dispatches the same Zustand action as a human click. No separate API path.
- **Token budget:** Copilot has its own token budget separate from story budgets (FR115). Uses economy tier by default.
- **3 interaction modes:** Ask (query state), Investigate (deep-dive with tool use), Suggest (propose actions for user approval)
- **Implementation phases:** Copilot is Phase 3 in UX spec — can ship after core dashboard
- **Mock data layer:** Copilot development needs mock Zustand state from day one
- **Recommended architecture:** `CopilotZustandBridge` component (renders null) subscribes to all Zustand slices and registers `useCopilotReadable` for each. Separate `CopilotActionsProvider` registers all `useCopilotAction` handlers. Both mount inside `<CopilotKit runtimeUrl="/api/copilot">`.
- **AG-UI event types:** TEXT_MESSAGE_START/CONTENT/END, TOOL_CALL_START/ARGS/END, STATE_SNAPSHOT/DELTA, RUN_STARTED/FINISHED/ERROR, CUSTOM
- **Three separate channels:** (1) AG-UI SSE for copilot chat streaming, (2) Gateway SSE for factory state events, (3) Gateway WS for dashboard commands. These remain separate.
- **300ms pacing implementation:** Frontend orchestration queue wraps action handlers with sequential execution + 300ms delay + requestAnimationFrame. Protocol is speed-agnostic — pacing is purely frontend.
- **Action `render` prop:** Supports in-chat action indicators (FR115) — shows executing/complete status with custom UI components
- **Risks to verify in Step 4:** AG-UI protocol maturity (beta vs GA), @copilotkit/runtime Bun compatibility, readable state token cost (full Zustand dump could be large), bidirectional state streaming mid-conversation, FR109 confirmation flow mechanism

#### Decision 10: Testing Strategy & Standalone Testability
**The problem:** Each of 15 subsystems must be testable without the full factory running. Two developers building manually before the factory builds itself.

**Research findings from QDS-Engineer v1:**
- v1 proves multi-round QA works: 3 rounds, 67K tokens per session, handoff between rounds
- 5-wave QA coordinator pattern (1349 LOC) proven effective — port to v2
- Token budgets per QA session prevent runaway costs
- v1 has 110+ tests passing across QA, workflow, orchestration systems (50+ test files in 20+ directories)
- 7 hook scripts for enforcement (pre-commit BMAD validation, commit msg format, PR structure, token tracking, agent lifecycle)
- v1 portability assessment: Wave coordinator, WorkflowEnforcer, hooks, QA types, token tracking — all copy-directly portable. Orchestrator prompts and session management need redesign for v2.

**Research findings from claude-mem (comprehensive deep-dive):**
- Progressive disclosure via token budgeting + layered rendering (Header → Timeline → Summary → Previously → Footer) — applicable to test output and overlay composition
- Content-addressed dedup via SHA256 of normalized content — applicable to test artifact caching and observation dedup
- **Worker Service pattern** (`src/services/worker-service.ts`): Slim HTTP orchestrator on port 37777, background initialization with promise-based coordination, middleware guards routes with 30s DB timeout, fails open (empty context) if not ready
- **Dual session ID pattern:** `contentSessionId` (user-facing) + `memorySessionId` (SDK agent, nullable until first response) — enables resumable conversations. Relevant for Factory Core pipeline state tracking.
- **Edge processing pattern:** Tag stripping (`<claude-mem-context>`, `<private>`) happens at hook layer BEFORE worker, keeps worker simple, one-way data flow. Applicable to Factory Core credential isolation.
- **Fire-and-forget observations, awaited summaries:** Non-critical ops async, time-sensitive ops synchronous. Same pattern for Factory Core hooks.
- **Hook exit code strategy:** 0=success, 1=recoverable error, 2=blocker. Prevents Windows terminal popups. Applicable to Factory Core hook infrastructure.
- **Database-first queuing:** Observations persisted to SQLite BEFORE in-memory queuing (crash-safety). 2-minute stale session reaping, 5-minute orphan process cleanup.

**Testing architecture:**
- **Unit tests:** Per-package, run with `bun test`. No cross-package dependencies.
- **Integration tests:** Per-integration-surface. Mock the other side.
  - Factory Core ↔ Pi SDK: mock Pi SDK responses, verify attribution chain assembly
  - Factory Core ↔ Overstory: mock Overstory agent lifecycle, verify pipeline state transitions
  - Gateway ↔ Dashboard: mock SSE events, verify Zustand state updates
  - Hook pipeline: mock hook scripts, verify PASS/FAIL/DEGRADED classification
- **Phase boundary tests:** Canary token injection tests (see Decision 5)
- **Dashboard tests:** Component tests with mock Zustand state. Storybook or Vitest + jsdom.
- **E2E factory tests:** Full pipeline run with mock LLM responses. Expensive — run on CI, not every commit.

---

## RESOLVED VERIFICATION ITEMS (all 10 from architecture.md)

| # | Item | Resolution |
|---|---|---|
| 1 | Pi SDK tier directive API | No discrete tiers. Tier-to-model mapping layer needed in Factory Core. |
| 2 | Overstory SQLite journal mode | WAL mode confirmed across all 5 databases. |
| 3 | ZeroClaw React shell location | `zeroclaw/web/`. Selective copy of 6 files. |
| 4 | skills-core.js integration | Plain JS ES6, 5 functions. Import as library with .d.ts declarations. |
| 5 | Overlay caching invalidation | Content-addressed cache with xxhash64. Source file change invalidates. |
| 6 | Context isolation verification | 5-layer defense. Canary token injection is primary testable guarantee. |
| 7 | Hook layer failure interaction | Tiered sequential. Timeout → DEGRADED (not FAIL). No enforcement gap. |
| 8 | PR evidence access path | Copilot reads from local session cache (populated from `gh` CLI output). |
| 9 | SSE translation layer design | Gateway polls EventStore at 500ms. Per-client cursor. Full snapshot on reconnect. |
| 10 | Factory Core pipeline state storage | Separate SQLite DB (WAL mode), not Overstory SessionStore. |

---

## KEY CODEBASE REFERENCE PATHS

When you need to inspect source code during Step 4 decisions, these are the critical files:

```
# Overstory — agent orchestration
overstory/src/agents/overlay.ts          # Template-based overlay, wraps generateOverlay()
overstory/src/agents/hooks-deployer.ts   # Hook deployment via settings.local.json
overstory/src/agents/guard-rules.ts      # Pure data: guard rules, tool lists, bash patterns
overstory/src/events/store.ts            # EventStore SQLite (370 LOC), WAL mode, 5 indexes
overstory/src/mail/store.ts              # Mail SQLite, 12 message types
overstory/src/sessions/store.ts          # Session SQLite, 5 agent states
overstory/src/worktree/tmux.ts           # killSession() — process isolation for phase boundary
overstory/src/runtimes/pi.ts             # Pi runtime adapter
overstory/src/runtimes/pi-guards.ts      # Pi extension guard generation
overstory/src/commands/feed.ts           # `ov feed --follow` polling implementation (245 LOC)
overstory/src/types.ts                   # StoredEvent, EventLevel, EventType interfaces

# Pi SDK — LLM runtime
pi-mono/packages/ai/src/types.ts         # AssistantMessage, StreamOptions.metadata, Usage
pi-mono/packages/ai/src/models.ts        # calculateCost(), model registry
pi-mono/packages/agent/src/agent.ts      # Agent class, transformContext() hook

# Superpowers — skills & enforcement
superpowers/lib/skills-core.js           # 5 exported functions, plain JS
superpowers/hooks/hooks.json             # SessionStart hook config

# claude-mem — memory system
claude-mem/src/services/context/ContextBuilder.ts  # Progressive disclosure, token budgeting
claude-mem/src/services/sqlite/SessionStore.ts     # Dual session ID, WAL mode

# ZeroClaw — dashboard source (selective copy targets)
zeroclaw/web/src/lib/sse.ts              # SSE client (186 LOC), fetch-based, auto-reconnect
zeroclaw/web/src/lib/ws.ts               # WS client, auto-reconnect
zeroclaw/src/gateway/sse.rs              # SSE server (226 LOC) — reference impl (Rust, NOT carried)
zeroclaw/src/observability/traits.rs     # ObserverEvent enum — 10 event types, reference schema
zeroclaw/web/src/types/api.ts            # SSEEvent interface — flexible field map

# QDS-Engineer v1 — proven patterns
QDS-engineer/                            # Python/FastAPI, 8-step workflow, 5-wave QA
```

---

## WHAT STEP 4 MUST PRODUCE

Per the workflow file (`step-04-decisions.md`), Step 4 must:

1. **Acknowledge decisions already made** (ADR-001, ADR-002, tech stack, monorepo layout)
2. **Facilitate remaining decisions collaboratively** using the 10 decisions above as input
3. **Verify technology versions** via web search where applicable
4. **Document each decision** with: Category, Decision, Version (if applicable), Rationale, Affects (components/epics), Provided by Starter (yes/no)
5. **Check cascading implications** after each decision
6. **Present A/P/C menu** after each decision category:
   - **A** = Advanced Elicitation
   - **P** = Party Mode
   - **C** = Continue (save and proceed)
7. **Append to architecture.md** and update frontmatter `stepsCompleted: [1, 2, 3, 4]`

### Suggested Decision Category Mapping

The Step 4 workflow defines 5 categories. Map the 10 decisions:

| Step 4 Category | Decisions |
|---|---|
| **Data Architecture** | #2 (pipeline state storage), #3 (overlay caching), #7 (attribution chain storage) |
| **Authentication & Security** | #5 (phase boundary / context isolation), #6 (isolation testing), credential isolation (already in cross-cutting) |
| **API & Communication** | #1 (gateway/SSE), #4 (hook pipeline IPC) |
| **Frontend Architecture** | #9 (copilot), dashboard state management (already decided: Zustand) |
| **Infrastructure & Deployment** | #10 (testing strategy), #8 (Superpowers integration — build/import strategy) |

---

## ADDITIONAL CONTEXT FROM PARTY MODE ROUNDS

### Round 1 (Winston/Amelia/Mary):
- SQLite WAL mode verification needed → RESOLVED
- Phase Boundary Protocol co-dependency with hooks → design together
- Overlay caching is correctness, not performance → content-addressed cache
- skills-core.js is JS not TS → import with .d.ts
- State ownership boundaries draft created

### Round 2 (John/Quinn/Barry):
- FRs need "first story" vs "full MVP" separation → done in architecture.md
- Meta-Optimization independently deployable → plugin-style subsystem
- Hook layer failure interaction → DEGRADED classification
- 15 named subsystems proposed → documented in architecture.md
- Bootstrapping/standalone testability → mock interfaces per subsystem

### Round 3 (Winston/Barry/Sally):
- SSE/WS carry-forward is transport plumbing only, types from shared-types package
- Source projects need vendor/ directory separate from packages/ → done
- sse-server should be "gateway" → renamed
- Dashboard needs mock data layer from day one → gateway mock mode
- Write UX spec @theme fresh → don't remap ZeroClaw's
- Component directories mirror UX spec implementation phases → done

---

## SESSION RESUMPTION CHECKLIST

When you start the new session:

- [ ] Read `_bmad-output/planning-artifacts/architecture.md` (the primary artifact)
- [ ] Read `_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-04-decisions.md` (the workflow)
- [ ] Confirm frontmatter shows `stepsCompleted: [1, 2, 3]`
- [ ] Acknowledge all research findings from this handoff prompt
- [ ] Begin Step 4 decision facilitation, starting with "Already Decided" acknowledgment
- [ ] Work through 5 decision categories with A/P/C menus
- [ ] When complete, update frontmatter and proceed to Step 5
