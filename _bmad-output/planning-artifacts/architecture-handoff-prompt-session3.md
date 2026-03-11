# Architecture Session 3 Handoff Prompt

> **Purpose:** Paste this entire document as the first message in a new Claude Code conversation to seamlessly resume the QDS-Engineer-New architecture workflow. You are mid-Step 4, with 2 of 5 decision categories complete. After Step 4 finishes, Steps 5-8 remain.

---

## CRITICAL INSTRUCTIONS

You are resuming a BMAD architecture workflow for the **QDS-Engineer-New** project. Three sessions have been conducted:

- **Session 1** (Steps 1-3): Project context, source project analysis, starter template, monorepo layout, ADR-001 and ADR-002, 3 Party Mode rounds, 1 Advanced Elicitation round.
- **Session 2** (Step 4, Categories 1-2): Data Architecture decisions via 2 rounds of Advanced Elicitation (10 methods total), Authentication & Security decisions via Party Mode Round 4.
- **This session** (Session 3): Resume at **Step 4, Category 2 PENDING SAVE**, then continue through Categories 3-5, then Steps 5-8.

**Your immediate actions:**

1. Load the BMAD architect agent persona (Winston — calm, pragmatic, "what could be" vs "what should be")
2. Read the architecture document to restore full context
3. **FIRST ACTION: Save the Category 2: Authentication & Security decisions to `architecture.md`** (full content provided below — it was finalized but the save was interrupted)
4. Update Open Verification Items #6 and #7 to RESOLVED
5. Present Category 3: API & Communication
6. Continue through Categories 4, 5, then Steps 5-8

**Invoke the architecture skill to resume:**
```
/bmad-bmm-create-architecture
```

When the workflow loads, tell it: **"Resume at Step 4. Steps 1–3 are complete. Categories 1-2 are decided. Category 2 needs to be saved first, then continue with Category 3."**

**USER DIRECTIVE (governs all decisions):** "Forget MVP mindset. Build the future of agentic engineering." — This means reference architecture quality. No shortcuts. Defense in depth at every security boundary. Use waves of parallel subagents for deep investigation (A = Advanced Elicitation, P = Party Mode).

---

## PROJECT IDENTITY

- **Project:** QDS-Engineer-New — Full-stack AI Workforce Management Platform
- **What it does:** Orchestrates AI coding agents through a quality-gated pipeline (dev → review → QA → merge) with economic governance, learning loops, and real-time observability
- **User:** Steve (config in `_bmad/bmm/config.yaml`, `user_skill_level: intermediate`)
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
| Session 1 Handoff | `_bmad-output/planning-artifacts/architecture-handoff-prompt.md` |
| **This Handoff (Session 3)** | `_bmad-output/planning-artifacts/architecture-handoff-prompt-session3.md` |
| Step 4 Workflow | `_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-04-decisions.md` |
| Step 5 Workflow (next after Step 4) | `_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-05-patterns.md` |
| Step 6 Workflow | `_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-06-structure.md` |
| Step 7 Workflow | `_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-07-validation.md` |
| Step 8 Workflow (final) | `_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-08-complete.md` |
| Architect Agent | `_bmad/bmm/agents/architect.md` |

---

## WORKFLOW STATE

- **Steps completed:** 1 (Init), 2 (Context Analysis), 3 (Starter Template Evaluation)
- **Current step:** 4 (Core Architectural Decisions) — **IN PROGRESS**
- **Step 4 Categories completed:** Category 1 (Data Architecture — SAVED), Category 2 (Authentication & Security — DECIDED, NOT YET SAVED)
- **Step 4 Categories remaining:** Category 3 (API & Communication), Category 4 (Frontend Architecture), Category 5 (Infrastructure & Deployment)
- **Party Mode rounds completed:** 4
- **Advanced Elicitation rounds:** 3 (1 in Step 3, 2 in Step 4 Category 1)
- **Frontmatter `stepsCompleted`:** `[1, 2, 3]` — update to `[1, 2, 3, 4]` when ALL 5 categories complete
- **Remaining workflow steps after Step 4:** Step 5 (Implementation Patterns), Step 6 (Project Structure & Boundaries), Step 7 (Validation), Step 8 (Completion & Handoff)

---

## ARCHITECTURE DECISIONS ALREADY MADE AND SAVED

### From Steps 1-3:

**ADR-001: Dashboard Initialization — Selective Copy from ZeroClaw**
- Copy 6 infrastructure files from `zeroclaw/web/` (index.html, vite.config.ts, tsconfig.json, tsconfig.app.json, src/lib/sse.ts, src/lib/ws.ts)
- Fresh `@theme` from UX spec (different hex values than ZeroClaw)
- Fresh package.json and all application code

**ADR-002: Factory Core Package Boundary — Separate Package in Bun Workspace**
- Factory Core is separate TypeScript package in Bun workspace monorepo
- Source projects consumed from `vendor/` directory, NOT workspace members
- Explicit dependency boundary via package.json

**Monorepo Layout:** `packages/` (factory-core, gateway, dashboard, shared-types) + `vendor/` (overstory, pi-mono, superpowers, claude-mem) + `config/` + `scripts/`

### From Step 4, Category 1 (Data Architecture — SAVED to architecture.md):

**ADR-003: Pipeline State Storage — SQLite WAL at `.qds/pipeline.db`**
- 3 tables: `pipeline_runs`, `phase_transitions`, `gate_results`
- WAL mode, `busy_timeout = 5000`, consistent with Overstory's 5-database pattern
- WorkflowEnforcer port from v1 as `PipelineStateMachine` class
- Full SQL DDL schema is in architecture.md

**ADR-004: Overlay Cache Strategy — No Cache, Cache-Ready Interface**
- No cache at launch. `OverlayStage` interface with `name`, `priority`, `estimate()`, `render()`
- Add optional `cacheKey()` method when profiling proves >10ms assembly time
- Correctness > performance: cache saves only ~1ms per overlay assembly

**ADR-005: Attribution Chain Storage — Separate `attribution.db` with Call-ID Correlation**
- Separate SQLite at `.qds/attribution.db` with `attribution_chain` + `budgets` tables
- `StreamOptions.metadata` is NOT echoed back by providers — correlation via pre-generated `call_id` UUID
- `wrapApiCall()` pattern: pre-call insert → API call → post-call merge (atomic transaction)
- Strict validation for Factory Core fields, advisory enforcement for budget ceiling
- 3 unattributed call categories: `system:infrastructure`, `system:recovery`, `system:orchestrator`
- Full SQL DDL schema and TypeScript `wrapApiCall()` code is in architecture.md

**Updated Technology Versions (verified 2026-03-03):**
Bun ^1.3.9, React ^19.2.4, Vite ^7.3.1, Tailwind CSS ^4.1.0, TypeScript ~5.9.3, Zustand ^5.0.11, @xterm/xterm ^6.0.0, CopilotKit ^1.52.1, recharts ^3.7.0, bun:sqlite built-in

---

## CATEGORY 2: AUTHENTICATION & SECURITY — DECIDED, MUST BE SAVED

Category 2 was resolved via Party Mode Round 4 (Winston/Amelia/Quinn). 10 design items, 6 unanimous, 4 splits resolved. **This content must be appended to `architecture.md` BEFORE proceeding to Category 3.**

### Decisions to Save:

**ADR-006: Phase Boundary Protocol Implementation**

- **Status:** Accepted
- **Decision:** 5-layer defense with the following specific implementation choices:
- **Affects:** Factory Core (`packages/factory-core/src/phase-boundary/`), Overstory extensions (mail schema, tmux cleanup), Hook Infrastructure, shared-types (manifest schema)
- **Provided by Starter:** No — new decision

**5a — Transcript Quarantine: (C) Both — move/rename + deniedDirectories**
- Defense in depth. `fs.rename()` moves `~/.claude/projects/{project}` to `.quarantine-{phaseId}-{timestamp}` (same-fs inode op, ~instant). Then update `settings.local.json` to add quarantine path to `deniedDirectories`.
- Sequence after dev phase kill: kill tmux session → move transcript files → set deniedDirectories → verify → launch review agent. Cleanup must be idempotent.
- Implementation trap: `fs.rename` fails cross-device. Assert quarantine dir is on same mount at startup.

**5b — Manifest Learnings Field: (C) JSON Schema with oneOf constraints**
- Deterministic validation via `ajv`. Extensible without code changes (add oneOf variants to schema file).
- Schema is a versioned artifact in `config/schemas/manifest-learnings.schema.json`.
- Manifest parser must reject unknown schema versions (fail closed, not open).
- Initial categories: `pattern`, `anti-pattern`, `perf-hint`, `api-constraint`, `test-gap` — each with type-specific required fields.

**5c — Review Agent Worktree: (A) Fresh `git worktree add` from dev branch HEAD**
- Fresh worktree from the dev branch's HEAD commit. Reviewer sees exactly the committed dev output.
- Clean filesystem: no build artifacts, no `.claude/` dir, no temp files, no node_modules.
- Dev phase must produce a clean commit before phase transition. Manifest references commit SHA.
- 2-5s cost per worktree creation — within budget. Cleanup via `git worktree remove` in phase teardown.
- NOT from main branch (Winston's position overruled) — reviewer needs to see dev's changes, not just main.

**5d — Overstory Mail Phase Scoping: (A) Phase column + PhaseScopedMailClient wrapper**
- `ALTER TABLE mail ADD COLUMN phase TEXT NOT NULL DEFAULT 'dev'` + composite index `(phase, to_agent, read)`.
- Factory Core wraps Overstory's mail client with `PhaseScopedMailClient` that hardcodes the phase filter. This wrapper is the ONLY mail interface exposed to agents — no raw mail query access.
- NOT separate mailboxes per phase (Winston/Quinn position overruled) — Amelia identified that separate DBs break Overstory's existing CHECK constraint on 12 message types, double migration surface, and complicate cross-phase audit queries.

```typescript
class PhaseScopedMailClient {
  constructor(private inner: MailStore, private phase: string) {}
  async list(agentId: string): Promise<Mail[]> {
    return this.inner.listByPhase(this.phase, agentId);
  }
  // No raw query method exposed — structural enforcement at application boundary
}
```

**5e — Behavioral Leakage Testing: (C) Hybrid — automated statistical correlation + human audit**
- Automated layer: lexical overlap between dev reasoning and review comments, time-to-first-finding correlation with dev phase duration, review coverage pattern correlation with dev edit frequency per file.
- Automated gates CI. Flagged anomalies + random sample go to human audit.
- Three metrics: lexical overlap (should be near zero), timing correlation (should be uncorrelated), coverage correlation (should be uncorrelated).
- Threshold: >0.7 similarity on any dimension = FLAG for human. <0.3 all dimensions = PASS. Middle = inconclusive, needs larger sample.

**ADR-007: Context Isolation Testing Strategy**

- **Status:** Accepted
- **Decision:** In-band verification on every transition with binary+degraded scoring and adaptive Merkle audit.
- **Affects:** Factory Core (`packages/factory-core/src/phase-boundary/`), Dashboard (isolation confidence display), shared-types (IsolationResult)
- **Provided by Starter:** No — new decision

**6a — Isolation Test Frequency: (A) Every transition, in-band**
- Canary injection + verification costs ~162ms per transition. With 4 transitions per story, ~650ms total. Noise against story durations of minutes to hours.
- Security boundary verified BEFORE review agent starts. No tainted results to discard on failure.
- Canary tokens: 3 per transition (system prompt, tool output, conversation context), format `QDS-CANARY-{LAYER}-{UUID}`.
- Verification scans all 6 leakage vectors. If any canary found → FAIL → halt pipeline.

**6b — Isolation Confidence Scoring: (C) Binary pass/fail + degraded state**
- Three actionable states:
  - **PASS**: All 5 layers verified clean. Proceed.
  - **DEGRADED**: Canary tokens clean but secondary indicators anomalous (unexpected files in worktree, suspicious env vars, partial quarantine). Proceed with warning + investigation trigger.
  - **FAIL**: Canary token detected. Hard stop. Kill review session.
- Three consecutive DEGRADED results within a window → escalate to FAIL.

```typescript
type IsolationResult =
  | { status: 'pass'; checks: CheckResult[] }
  | { status: 'degraded'; checks: CheckResult[]; warnings: string[] }
  | { status: 'fail'; checks: CheckResult[]; violations: string[] };
```

**6c — Merkle Tree Audit Scope: (C) Adaptive**
- Default (every transition): Hash manifest + `settings.local.json` + `.claude/` dir listing. Fast (~3-5 files).
- Escalated (triggered by degraded result, config change, first run, daily schedule): Hash full worktree via `git ls-files` + untracked.
- Escalation trigger is itself testable as a unit assertion.
- Hash and mode stored in `phase_transitions.manifest_hash` column (already exists in ADR-003 schema).

**ADR-008: Credential Isolation — Programmatic Init, Never Env Vars**

- **Status:** Accepted
- **Decision:** Factory Core passes credentials to Pi SDK via programmatic constructor init. No env var propagation. Dual-layer credential presence detection (Pi SDK strips at source + regex scan all outputs).
- **Affects:** Factory Core (`packages/factory-core/src/economics/credential-manager.ts`), Pi SDK integration, Overstory extensions (tmux session env), shared-types (credential scan patterns)
- **Provided by Starter:** No — new decision

**C4a — Credential Propagation: (A) Programmatic init, never env vars**
- Factory Core holds credentials in-memory. Passes to Pi SDK via constructor/init call — NEVER via env vars.
- Agents spawned via tmux do NOT inherit API keys. They call Pi SDK through Overstory, which holds the initialized session.
- Eliminates the #1 credential leak vector: env var inheritance through `child_process.exec` → tmux → shell (3 layers of env inheritance in Overstory).
- Upgradeable to per-call vault later without changing Pi SDK interface.

**C4b — Credential Presence Detection: (C) Both — strip at source + regex scan**
- Layer 1: Pi SDK strips known credential fields from responses before returning to Factory Core.
- Layer 2: Factory Core's output sanitizer scans all text outputs (agent output, logs, PR bodies, learning records, git commit messages) for credential patterns.
- Patterns: Anthropic keys (`sk-ant-*`), GitHub PATs (`ghp_*`), PEM keys, OpenRouter keys, base64-encoded keys, URL-embedded credentials.
- Credential detection → immediate rotation (assume credential has been observed).
- Extends Overstory's existing `sanitizer.ts` (5 regex patterns) with additional provider patterns.

### Phase Boundary Test Suite (proposed by Quinn, QA Engineer)

33-file, ~198-test suite structure:

```
packages/factory-core/tests/phase-boundary/
  canary/           # 4 files, 30 tests — token gen, verification, injection, detection
  manifest/         # 5 files, 35 tests — schema, builder, hash, learnings, round-trip
  isolation/        # 6 files, 40 tests — process, filesystem, env, transcript, mail, database
  confidence/       # 3 files, 18 tests — result aggregation, escalation, audit trail
  credential/       # 5 files, 30 tests — vault lifecycle, failure, sanitizer, canary, output scan
  behavioral/       # 3 files, 15 tests — similarity scoring, output extraction, threshold logic
  merkle/           # 4 files, 20 tests — tree construction, manifest hash, full hash, adaptive trigger
  integration/      # 3 files, 10 tests — full transition, multi-phase, concurrent stories
  fixtures/         # learnings/, manifests/, credentials/, canary/ — test data
```

Coverage targets: 100% branch on canary verification and confidence scoring. 95% line on manifest validation and credential handling. 92% weighted average across all layers.

### Cascading Implications from Category 2

1. **Overstory mail schema migration:** `ALTER TABLE mail ADD COLUMN phase TEXT NOT NULL DEFAULT 'dev'` + new composite index. Must be compatible with Overstory's existing migration system.
2. **Overstory killSession() extension:** Post-kill cleanup sequence (move transcripts → set deniedDirectories → verify). Must be idempotent.
3. **shared-types additions:** `PhaseManifest` (with JSON schema version field), `IsolationResult`, `PhaseScopedMailClient` interface, `CredentialScanResult`.
4. **factory.yaml schema:** Must include credential storage configuration (which provider keys, rotation policy).
5. **settings.local.json management:** `hooks-deployer.ts` pattern extended to manage `deniedDirectories` per phase.
6. **Phase Boundary Protocol co-dependency with Hook Infrastructure:** Both interfaces must be defined before either is implemented (noted in architecture.md Design Co-Dependencies section). ADR-006 defines the Phase Boundary side; Category 3 (Hook Pipeline) defines the Hook side.

### Open Verification Items Update After Category 2

| # | Item | New Status |
|---|---|---|
| 6 | Context isolation verification | **RESOLVED** — In-band canary verification every transition, 3 tokens, ~162ms, binary+degraded scoring |
| 7 | Hook layer failure interaction | **PARTIALLY RESOLVED** — DEGRADED classification confirmed. Full hook pipeline architecture deferred to Category 3 |

---

## REMAINING STEP 4 CATEGORIES

### Category 3: API & Communication

Maps to 2 critical decisions from the original 10:

**Decision #1: Gateway Architecture (SSE Translation Layer)**

Research findings already gathered (from Session 1 handoff):
- Overstory has NO HTTP server — all observability is CLI (`ov feed`, `ov watch`, etc.)
- `ov feed --follow` polls EventStore SQLite at configurable interval (default 1000ms, min 200ms)
- EventStore schema: `events` table with autoincrement `id`, `run_id`, `agent_name`, `session_id`, `event_type`, `tool_name`, `data` (JSON), `created_at` (ISO 8601 microsecond), 5 indexes
- ZeroClaw has a working SSE server in Rust (226 LOC, `zeroclaw/src/gateway/sse.rs`) — reference only, not carried
- ZeroClaw SSE client (`zeroclaw/web/src/lib/sse.ts`, 186 LOC) — carried but needs `id:` field parsing + `Last-Event-ID` header
- Recommended MVP: `Bun.serve()` SSE endpoint polls EventStore at 500ms. Per-client cursor via `Last-Event-ID`. Full state snapshot on reconnect.
- Critical Bun.serve() trap: Must call `server.timeout(req, 0)` on SSE requests (default 10s kills SSE connections)
- Wire format: `id:` (EventStore row ID) + `event:` (eventType) + `data:` (JSON) + `:keepalive\n\n` every 15s
- Backpressure: Ring buffer (500 events). Client falls behind → `event: snapshot` with full state
- Client tracking: `Set<SSEClient>` with per-client `lastSeenId`. Cleanup on `ReadableStream.cancel()`
- Mock mode: `createEventStore(":memory:")` — same poll loop code path, only DB path differs
- Reconnection budget (NFR19, 5s): ~1.4s total (well within budget)

**Decision #4: Hook Pipeline Architecture**

Research findings already gathered:
- 6-layer enforcement: L1 (per-edit PreToolUse), L2 (per-task PostTask), L3 (per-phase boundary), L4 (BMAD review), L5 (QA swarm multi-round), L6 (PR evidence)
- Execution model: Tiered sequential — layers in order within tiers, tiers independent
- Failure classification: PASS / FAIL / DEGRADED. Timeout → DEGRADED (not FAIL).
- IPC: Single Bun runner process. SQLite polling at 500ms. Per-file debounce (2s window, latest-wins).
- L1 NOT managed by runner (lives in Claude Code's synchronous PreToolUse). L5-L6 spawned as agents via `ov sling`.
- Gate script interface: `GateContext` via stdin JSON → `GateResult` to stdout. Exit code 0=pass, 1=fail, 2=degraded.
- Result aggregation: Event-sourced `HookResultEvent` in events.db. Three projection views: dashboard SSE, PR evidence, learning records.
- Existing infrastructure: hooks-deployer.ts, guard-rules.ts, pi-guards.ts, watchdog/daemon.ts, ZeroClaw gates.rs
- SessionStart hook must be synchronous (`async: false`)

Open items for Category 3:
- Gateway polling interval optimization (500ms vs adaptive)
- WS command handler architecture (dashboard → Factory Core commands)
- Hook runner process lifecycle (separate process vs Factory Core subprocess)
- Hook result storage (events.db vs separate hooks.db)
- Layer interaction matrix (formalize the L1→L6 failure cascade)

### Category 4: Frontend Architecture

Maps to:

**Decision #9: Dashboard Copilot Architecture (CopilotKit + AG-UI)**

Research findings:
- CopilotKit hooks: `useCopilotReadable()` exposes Zustand state, `useCopilotAction()` registers invocable functions
- AG-UI transport: SSE for copilot ↔ backend. 300ms pacing is frontend-enforced.
- `CopilotZustandBridge` component subscribes to all slices, registers readables. `CopilotActionsProvider` registers actions. Both mount inside `<CopilotKit runtimeUrl="/api/copilot">`.
- Three separate channels: AG-UI SSE (copilot chat), Gateway SSE (factory state), Gateway WS (dashboard commands)
- Three interaction modes: Ask (query), Investigate (deep-dive), Suggest (propose actions for approval)
- Action `render` prop for in-chat indicators (FR115)
- Copilot has own token budget separate from story budgets (FR115), economy tier default
- Risks to verify: AG-UI maturity (beta vs GA), @copilotkit/runtime Bun compatibility, readable state token cost, FR109 confirmation flow

Other frontend items (already decided): Zustand for state management, single-page (no router), component directories mirror UX spec phases.

Open items for Category 4:
- CopilotKit runtime Bun compatibility verification (web search needed)
- AG-UI protocol version pinning
- Readable state token cost mitigation (full Zustand dump could be large)
- Copilot ↔ Factory Core backend communication path

### Category 5: Infrastructure & Deployment

Maps to:

**Decision #10: Testing Strategy & Standalone Testability**

Research findings:
- v1 proves multi-round QA works: 3 rounds, 67K tokens/session
- 5-wave QA coordinator (1349 LOC) proven effective — port to v2
- v1 has 110+ tests across 50+ files
- Testing architecture: unit (per-package, `bun test`), integration (per-surface, mock the other side), phase boundary (canary tokens), dashboard (component tests with mock Zustand), E2E (full pipeline with mock LLM, CI only)
- Phase Boundary Test Suite from Quinn: 33 files, ~198 tests (see Category 2 section above)

**Decision #8: Superpowers Integration Strategy**

Research findings:
- `skills-core.js` exports 5 functions (plain JS ES6): `extractFrontmatter()`, `findSkillsInDir()`, `resolveSkillPath()`, `checkForUpdates()`, `stripFrontmatter()`
- Import as library with `.d.ts` type declarations. No TS port needed.
- 14 skills in the Superpowers system with dependency flow
- TWO-STAGE review pattern: spec compliance → code quality (order strict)
- CSO rule: skill descriptions = triggering conditions only, never workflow summaries
- Integration point: Factory Core overlay Stage 2. Use `findSkillsInDir()` to enumerate, `extractFrontmatter()` for metadata, inject enforcement text.

Open items for Category 5:
- Test runner configuration (bun test options, coverage thresholds)
- CI pipeline structure (which tests run where)
- skills-core.d.ts type declaration scope
- Superpowers personal skills shadow resolution mechanism

---

## OPEN VERIFICATION ITEMS STATUS (current)

| # | Item | Status |
|---|---|---|
| 1 | Pi SDK tier directive API | **RESOLVED** — No discrete tiers. Tier-to-model mapping needed. |
| 2 | Overstory SQLite journal mode | **RESOLVED** — WAL mode confirmed across all 5 databases. |
| 3 | ZeroClaw React shell location | **RESOLVED** — `zeroclaw/web/`. Selective copy of 6 files. |
| 4 | `skills-core.js` integration | **RESOLVED** — Plain JS ES6, 5 functions. Import with .d.ts. |
| 5 | Overlay caching invalidation | **RESOLVED** — No cache. Cache-ready `OverlayStage` interface. |
| 6 | Context isolation verification | **RESOLVED** — In-band canary verification every transition, binary+degraded scoring. |
| 7 | Hook layer failure interaction | **PARTIALLY RESOLVED** — DEGRADED classification confirmed. Full hook architecture in Category 3. |
| 8 | PR evidence access path | **OPEN** — local cache vs GitHub API TBD (Category 4 or 5). |
| 9 | SSE translation layer design | **OPEN** — Design outlined, formal ADR in Category 3. |
| 10 | Factory Core pipeline state storage | **RESOLVED** — SQLite WAL at `.qds/pipeline.db`, 3 tables. |

---

## SOURCE PROJECTS (critical file reference paths)

```
# Overstory — agent orchestration
overstory/src/agents/overlay.ts          # Template-based overlay, generateOverlay()
overstory/src/agents/hooks-deployer.ts   # Hook deployment via settings.local.json
overstory/src/agents/guard-rules.ts      # Pure data: guard rules, tool lists, bash patterns
overstory/src/events/store.ts            # EventStore SQLite (370 LOC), WAL mode, 5 indexes
overstory/src/mail/store.ts              # Mail SQLite, 12 message types, CHECK constraint
overstory/src/sessions/store.ts          # Session SQLite, 5 agent states
overstory/src/worktree/tmux.ts           # killSession() — process isolation
overstory/src/runtimes/pi.ts             # Pi runtime adapter
overstory/src/runtimes/pi-guards.ts      # Pi extension guard generation
overstory/src/commands/feed.ts           # `ov feed --follow` polling (245 LOC)
overstory/src/types.ts                   # StoredEvent, EventLevel, EventType
overstory/src/logging/sanitizer.ts       # Credential redaction, 5 regex patterns

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

# ZeroClaw — dashboard source
zeroclaw/web/src/lib/sse.ts              # SSE client (186 LOC), fetch-based, auto-reconnect
zeroclaw/web/src/lib/ws.ts               # WS client, auto-reconnect
zeroclaw/src/gateway/sse.rs              # SSE server (226 LOC) — Rust, reference only
zeroclaw/src/observability/traits.rs     # ObserverEvent enum — 10 event types

# QDS-Engineer v1 — proven patterns
QDS-engineer/src/qa/wave_coordinator.py  # 5-wave QA (1349 LOC)
QDS-engineer/src/workflow/enforcer.py    # WorkflowEnforcer (350 LOC state machine)
```

---

## PARTY MODE ROUNDS COMPLETED (4 total)

| Round | Agents | Focus | Key Outcomes |
|---|---|---|---|
| 1 | Winston, Amelia, Mary | Integration surfaces, implementation feasibility, requirements gaps | SQLite WAL confirmed, Phase Boundary ↔ Hook co-dependency identified, skills-core.js import strategy |
| 2 | John, Quinn, Barry | Scope risks, testability, over-engineering, subsystems | 15 subsystems inventoried, DEGRADED classification for hooks, standalone testability requirement |
| 3 | Winston, Barry, Sally | ADR pressure-testing, monorepo layout, theme, mock data | gateway rename, vendor/ separation, fresh UX spec theme, component phase directories |
| 4 | Winston, Amelia, Quinn | Phase Boundary Protocol, isolation testing, credentials | 10 design items resolved (6 unanimous, 4 splits). ADR-006, ADR-007, ADR-008. 198-test suite proposed. |

## ADVANCED ELICITATION ROUNDS COMPLETED (3 total)

| Round | Step | Methods | Focus |
|---|---|---|---|
| Step 3 | 5 methods | Failure Mode, Pre-mortem, ADR, First Principles, Red Team/Blue Team | Fork vs selective copy, Factory Core boundary, overlay, SSE |
| Step 4 Cat 1 R1 | 5 methods | Chaos Monkey, ADR Debate, Pre-mortem, Comparative Matrix, First Principles | Pipeline state, overlay cache, attribution chain |
| Step 4 Cat 1 R2 | 5 methods | Time Traveler, Graph of Thoughts, Reverse Engineering, Red Team/Blue Team, Algorithm Olympics | "Forget MVP" reframing, federation/compliance end-state, scale benchmarks |

---

## CRITICAL FACTUAL FINDINGS (must not be lost)

1. **`StreamOptions.metadata` is NOT echoed back by providers** — Factory Core must correlate locally using `call_id` pattern.
2. **Overstory has NO HTTP server** — all observability is CLI. Gateway must provide the HTTP SSE layer.
3. **`bun:sqlite` is built-in and 3-6x faster than better-sqlite3** — no external dependency needed.
4. **Vite upgraded from 6 to 7** (7.3.1 is current stable). TypeScript from 5.7 to 5.9.3. xterm.js now scoped `@xterm/*`.
5. **Content-addressed overlay caching saves only ~1ms** — not worth complexity cost.
6. **Pi SDK has no discrete tier directives** — 100+ models selected by name. Factory Core needs tier-to-model mapping.
7. **`~/.claude/projects/` transcripts are user-global, not worktree-scoped** — primary leakage vector for Phase Boundary Protocol.
8. **Three categories of unattributed API calls exist by design** — headless Pi, error recovery, orchestrator session.
9. **QDS Phase Boundary Protocol is novel** — no existing framework (AutoGen, CrewAI, LangGraph, Agent SDK) combines process isolation + manifest boundary + schema validation.
10. **Overstory's `killSession()` has process tree walk + SIGTERM + SIGKILL** — process isolation is mechanically proven.

---

## WHAT STEP 4 MUST PRODUCE (remaining work)

Per `step-04-decisions.md`, Step 4 must:

1. ~~Acknowledge decisions already made~~ (DONE — ADR-001 through ADR-005)
2. **Save Category 2 decisions** (ADR-006, ADR-007, ADR-008) — IMMEDIATE FIRST ACTION
3. **Facilitate Category 3: API & Communication** — Decisions #1 (Gateway/SSE) and #4 (Hook Pipeline)
4. **Facilitate Category 4: Frontend Architecture** — Decision #9 (Copilot/CopilotKit + AG-UI)
5. **Facilitate Category 5: Infrastructure & Deployment** — Decisions #10 (Testing Strategy) and #8 (Superpowers Integration)
6. **Check cascading implications** after each category
7. **Present A/P/C menu** after each category
8. **When all 5 categories complete:** Update frontmatter `stepsCompleted: [1, 2, 3, 4]`
9. **Load Step 5:** `_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-05-patterns.md`

## WHAT STEPS 5-8 MUST PRODUCE (after Step 4)

| Step | Name | Key Deliverable |
|---|---|---|
| 5 | Implementation Patterns & Consistency Rules | Naming conventions, structure patterns, format patterns, communication patterns, process patterns — all things AI agents could do differently without specification |
| 6 | Project Structure & Boundaries | Complete project tree (not generic placeholders), requirement-to-component mapping |
| 7 | Architecture Validation & Completion | Comprehensive validation checks, requirement coverage verification |
| 8 | Architecture Completion & Handoff | Completion summary, implementation guidance, final frontmatter update |

---

## SESSION RESUMPTION CHECKLIST

When you start the new session:

- [ ] Read `_bmad-output/planning-artifacts/architecture.md` (primary artifact, ~635 lines)
- [ ] Read `_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-04-decisions.md` (workflow)
- [ ] Confirm frontmatter shows `stepsCompleted: [1, 2, 3]`
- [ ] Acknowledge all decisions from this handoff (ADR-001 through ADR-008)
- [ ] **FIRST ACTION: Append Category 2 decisions (ADR-006, ADR-007, ADR-008) to architecture.md** using the exact content in the "CATEGORY 2" section above
- [ ] Update Open Verification Items #6 to RESOLVED, #7 to PARTIALLY RESOLVED
- [ ] Present Category 3: API & Communication with A/P/C menu
- [ ] Work through Categories 4, 5 with A/P/C menus
- [ ] When all 5 categories complete, update frontmatter to `stepsCompleted: [1, 2, 3, 4]`
- [ ] Load and execute Step 5 (Implementation Patterns)
- [ ] Continue through Steps 6, 7, 8 to complete the architecture workflow

---

## EXECUTION STYLE REMINDERS

- **Full enterprise grade rigor. No shortcuts.**
- **Use waves of parallel subagents** — when user selects A (Advanced Elicitation) or P (Party Mode), launch 3-5 parallel Task agents for depth.
- **"Forget MVP mindset. Build the future of agentic engineering."** — Reference architecture quality on every decision.
- **Winston persona:** Calm, pragmatic, "what could be" vs "what should be." Facilitator, not content generator.
- **Intermediate skill level:** Steve is technical but benefits from trade-off explanations, not just option lists.
- **Communication language:** English
- **Verify technology versions** via web search for any new technology decisions.
