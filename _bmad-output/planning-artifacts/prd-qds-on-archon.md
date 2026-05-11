---
stepsCompleted:
  - step-01-init
  - step-02-discovery
  - step-02b-vision
  - step-02c-executive-summary
  - step-03-success
  - step-04-journeys
  - step-05-domain
  - step-06-innovation
  - step-07-project-type
  - step-08-scoping
  - step-09-functional
  - step-10-nonfunctional
  - step-11-polish
inputDocuments:
  - "qds-on-archon-implementation-plan-2026-05-10.md"
  - "qds-on-archon-design-2026-05-10.md"
  - "prd.md (canonical requirements source — same WHY, different HOW)"
workflowType: 'prd'
documentCounts:
  briefs: 0
  research: 0
  brainstorming: 0
  projectDocs: 3
classification:
  projectType: "AI Workforce Management Platform (Agent Orchestration + Coordination Layer over External Runtimes)"
  domain: "Software Development Automation — Archon as Native Runtime"
  complexity: "high"
  complexityVectors:
    technical: "Polyglot integration (Rust, TS/Bun, React, Python), distributed coordination, real-time streaming"
    operational: "Resource contention management (API keys, sessions, worktrees, model slots), concurrency ceiling, cross-tentacle arbitration"
    organizational: "Virtual workforce with division of labor, quality control pipeline, institutional memory"
    economic: "Token budget enforcement, per-node model tier optimization, financial circuit breakers"
    security: "Credential pooling and rotation, process isolation, zero-trust agent boundaries"
    dataIntegrity: "Shared memory consistency, expertise versioning, conflict resolution"
  projectContext: "Systems Integration / Synthesis — pivot from custom Factory Core + 5 OSS projects to Archon-native workflow YAMLs + skills"
  strategicApproach: "Archon-native MVP with extraction contingency — compose proven primitives, customize only where differentiation requires it"
  elicitationInsights:
    - "Pre-mortem: Vendor lock-in, YAML scaling limits, and upstream merge conflicts identified as key risks"
    - "ADR: Archon-native validates factory concept faster; custom runtime replaceable if constraints become blocking"
    - "First Principles: Factory needs capabilities, not a specific runtime — Archon satisfies 80% of fundamentals out of the box"
    - "Red Team: File-based state, bash git integration, and generic dashboard are MVP-acceptable gaps with post-MVP mitigation paths"
    - "Comparative Matrix: Archon pivot scores 7.45 vs original 4.60 on weighted criteria — decisive advantage in time-to-MVP and operational complexity"
---

# Product Requirements Document - QDS on Archon

**Author:** Steve
**Date:** 2026-05-10

## Executive Summary

QDS Factory on Archon is a coding factory that accepts development stories or epics and produces production-ready, adversarially-reviewed, evidence-backed pull requests with minimal human intervention. It replaces the original plan — a custom Factory Core runtime built across ~64 stories and ~6,470 LOC — with a lean composition of Archon's existing DAG executor, headless Claude Code runner, and web UI, extended via workflow YAMLs and Claude Code skills. The result is identical capability delivered in ~18 tasks: a two-tier system where the `/qds` skill orchestrates epics into dependency-aware waves, and the `qds-piv-loop.yaml` workflow runs each story through a 14-node adversarial pipeline inside an isolated git worktree.

The factory operates on a core insight: **AI agents produce negative value without independent quality verification, fresh context windows, and continuous self-correction.** Every story passes through mandatory adversarial review and dual code-review waves with context-isolated fresh agents — development agents never share context with review agents, eliminating the sunk-cost bias that makes self-review worthless. Per-node model routing sends planning work to Anthropic Opus (architectural judgment shapes all downstream work) while all review, implement, and fix-wave nodes run on Z.ai GLM 5.1 at a fraction of the cost. The entire quality pipeline costs under $0.02 per story.

A self-learning layer compounds quality over time. Pattern libraries from review findings feed into targeted QA swarm agents. Dep graph calibration tracks every missed dependency to improve wave planning. Hotspot detection automatically allocates extra scrutiny to files that appear in 70%+ of stories. A nightly wiki agent consolidates git history, claude-mem observations, and GitNexus graph intelligence into living module documentation. After 50 stories, the system knows this codebase's blind spots better than any individual developer.

State is file-based and crash-safe. Epic progress lives in `.claude/qds/epic-{slug}/plan.json` — restart `/qds` on the same epic and it resumes exactly where it left off. No new databases. No new servers. No new runtimes.

### What Makes This Special

**Adversarial quality pipeline as cost prevention.** The 14-node PIV loop includes adversarial review, QA swarm, and dual code-review waves with parallel priority-bucketed fix agents. Structured JSON outputs eliminate prose bloat. Running on GLM 5.1 economy tier, the quality pipeline is economically negligible at ~3-5% of development cost.

**Closed-loop self-healing.** The nightly wiki agent acts as the factory's immune system — scanning the last 24 hours of changes, refreshing the GitNexus graph, updating module pages and pattern docs, and committing consolidation entries. Per-story finalize nodes run `bmad-retrospective` to capture process learnings. The workflow YAMLs evolve themselves through evidence, not guesswork.

**Economic governance via per-node env injection.** A ~20-line modification to Archon's `dag-executor.ts` enables per-node environment variable overrides. Planning nodes hit Anthropic directly; all other nodes route through Z.ai transparently. The workflow YAML continues to use standard Anthropic tier names — the env vars do the mapping at the subprocess boundary.

**Crash-safe epic orchestration.** The wave executor reads `plan.json` fresh from disk on every iteration. Ready stories launch into isolated git worktrees. Completed stories unlock dependents automatically. Failed stories surface a human gate with retry/skip/abort options. Worktree cleanup happens on completion.

## Project Classification

- **Project Type:** AI Workforce Management Platform — agent orchestration and coordination layer over external runtimes
- **Domain:** Software Development Automation — Archon as native runtime
- **Complexity:** High — polyglot integration (Rust, TS/Bun), distributed coordination, resource contention management, per-node model routing, token budget governance
- **Project Context:** Systems integration / synthesis — pivot from custom Factory Core + 5 OSS projects to Archon-native workflow YAMLs + skills
- **Strategic Approach:** Archon-native MVP with extraction contingency — compose proven primitives, customize only where differentiation requires it

## Success Criteria

### User Success

- A developer submits a story or epic via `/qds` and walks away. The factory develops, reviews, QA's, and PRs the work without manual intervention.
- The Archon web UI provides real-time visibility into all active workflow runs, node progress, and story status — the user never wonders "what's happening?"
- Multiple stories from an epic run in parallel with proper isolation (separate git worktrees, dependency-aware wave scheduling, no cross-contamination).
- BMAD adversarial review catches real defects the development agents missed. The PR body includes structured evidence proving what was found and fixed.
- The system uses Z.ai GLM 5.1 for review and implement work, keeping per-story cost low enough that running the full 14-node quality pipeline feels free.

### Business Success

- **3-month:** The internal team uses QDS on Archon as the primary development workflow. Stories flow through the factory daily. Manual code review is replaced by BMAD. The system pays for itself in developer time saved.
- **12-month:** If the tool proves exceptional, evaluate B2B licensing to other engineering teams. Success indicator: another team can set up the factory, configure their Archon instance, and run stories without understanding the internals.

### Technical Success

- Single story flows through all 14 nodes (gitnexus-check → explore → create-plan → refine-plan → implement-setup → implement → fix-feedback → adversarial-review → qa-swarm → bmad-code-review-1 → fix-wave-1 → bmad-code-review-2 → fix-wave-2 → finalize) without manual intervention.
- Multi-story epic parallelism works — 3+ stories running concurrently via wave executor with proper dependency gating.
- Per-node env injection routes planning nodes to Anthropic Opus and all review/implement nodes to Z.ai GLM 5.1 transparently.
- Archon web UI displays real-time workflow run status, node outputs, and SSE streaming with latency < 2s.
- Context isolation enforced at node boundaries — fresh context for all review nodes, shared context only for explore/refine-plan loops.
- File-based state (`plan.json`, `progress.txt`, `status`) is crash-safe: restart `/qds` and resume from exact state.

### Measurable Outcomes

- End-to-end story completion without human intervention (pass/fail per story)
- BMAD defect catch rate (issues found per story that would have shipped without review)
- Cost-per-story broken down by node and model tier
- Multi-story throughput (concurrent stories completing per day)
- Archon workflow run success rate (nodes completing without timeout or error)
- Fix-wave iteration count (target: ≤1 per story after learning layer matures)

## Product Scope

Product scope — including detailed MVP boundaries, Growth features, Vision, risk analysis, and validation metrics — is defined under *Project Scoping & Phased Development*.

## User Journeys

### Journey 1: Steve Runs an Epic Through the Factory (Primary — Success Path)

**Opening Scene:** Steve opens his terminal and types `/qds epic.md`. The epic has 4 stories for a new webhook retry system. The `/qds` skill checks for `.claude/qds/`, initializes the project scaffold if needed, then parses the epic. It extracts stories, runs `gitnexus route_map` + `gitnexus impact` per story to build blast radii, and constructs a dependency graph. Story 2 depends on Story 1; Stories 3 and 4 are independent. The wave executor presents the plan:

```
═══════════════════════════════════════════════
QDS EPIC PLAN — "Webhook Retry System"
Stories: 4 | Waves: 2 | Max parallel: 3
═══════════════════════════════════════════════
Wave 1 (parallel):
  ● Story 1.1 — Add rate limiting middleware
  ● Story 1.3 — Migrate user schema
Wave 2 (after 1.1 merges):
  ● Story 1.2 — Rate limit dashboarding
  ● Story 1.4 — Update API docs
═══════════════════════════════════════════════
```

Steve types "approved." The wave executor writes `plan.json` and launches Wave 1.

**Rising Action:** Three worktrees spin up: `.worktrees/story-1-1`, `.worktrees/story-1-3`. The wave executor POSTs each to Archon's `/api/workflows/qds-piv-loop/run`. Steve opens the Archon dashboard at `http://localhost:7272`. He sees three active runs. Story 1.1's `explore` node is running on Anthropic Opus — the agent reads CLAUDE.md, queries GitNexus, and presents a story understanding with key questions. Steve answers via the HITL gate. The `create-plan` node generates a `plan.md` with 5 tasks. The `implement` node — routed to Z.ai GLM 5.1 via per-node env — executes tasks one by one, committing after each. The `fix-feedback` node pauses; Steve tests the implementation, approves. Then `adversarial-review` and `qa-swarm` run autonomously on Z.ai, outputting structured JSON findings. `bmad-code-review-1` finds one MEDIUM issue. `fix-wave-1` spawns a fix agent. `bmad-code-review-2` comes back clean. `finalize` pushes the branch and creates a draft PR.

**Climax:** Story 1.1 completes. The wave executor detects `status=MERGED` via Archon API poll, updates `plan.json`, and runs `gitnexus analyze` so Wave 2 sees the merged work in the graph. Story 1.2 unlocks and launches.

**Resolution:** By afternoon, all 4 stories have draft PRs. Total cost: $4.82 (development on GLM 5.1 dominated, quality pipeline was $0.07). Steve reviews the PRs — each contains a structured evidence block. He merges. Steve spent 6 hours doing other work while the factory ran.

**Requirements revealed:** `/qds` skill with epic parsing, DECOMPOSE pipeline with GitNexus intelligence, wave executor with plan.json state machine, Archon web UI for run visibility, HITL gates in explore/fix-feedback nodes, autonomous review/QA/fix nodes, draft PR creation with evidence body.

---

### Journey 2: Steve Deals with a Stuck Workflow Run (Primary — Edge Case / Error Recovery)

**Opening Scene:** Steve kicks off a complex story involving a database migration. An hour later, he checks the Archon dashboard. The `implement` node on `story-db-migration` has status `FAILED` after 12 iterations. The node output shows: `Validation failed after 3 attempts. Task 3: BLOCKED.`

**Rising Action:** Steve clicks the failed node in the Archon UI. The output shows the last commit hash and the validation error: a type mismatch in the migration script. He opens the worktree at `.worktrees/story-db-migration` and inspects the code. The issue is clear — the plan assumed a column type that doesn't match the actual schema. Steve realizes the story spec was written against stale wiki data.

**Climax:** Steve has two options. Option A: He clicks "Retry" in the Archon UI, which restarts the `implement` node from its last checkpoint. But the plan.md itself is wrong. Option B: He stops the Archon run, edits `plan.md` in the worktree to fix the schema assumption, and restarts the workflow from `create-plan` with the corrected plan. Steve chooses B. He updates the plan, commits the fix, and re-invokes `/qds` with the same story. The wave executor detects the existing worktree and resumes.

**Resolution:** The second run completes successfully. BMAD review passes. QA swarm finds one edge case in rollback logic — Wave 3 fixer handles it. PR ships. Steve updates `.claude/wiki/modules/database.md` to reflect the correct schema. He notes: the wiki needs refreshing before stories touching migrations.

**Requirements revealed:** Archon node failure visibility, worktree persistence for manual intervention, plan.md edit-and-restart workflow, wiki freshness validation before migration stories, retry vs. restart vs. resume options for failed nodes.

---

### Journey 3: Co-Dev Configures Their Own Instance (Operations / Setup)

**Opening Scene:** Marcus clones the project repo and runs `/qds init`. The skill detects no `.claude/qds/` directory and executes `init.md`: it creates `.claude/qds/runs/`, `.claude/wiki/modules/`, `.claude/wiki/patterns/`, `.claude/wiki/decisions/`, `.claude/wiki/changelog/`, and starter wiki files. It reads CLAUDE.md and generates `wiki/index.md` with a module map. Marcus commits the scaffold.

**Rising Action:** Marcus checks that Archon is running (`bun run dev` in the Archon directory). He verifies his `.env` has `ZAI_API_KEY` set. He runs `/qds "add a hello world endpoint"`. The skill treats it as a single story, creates a worktree, and POSTs to Archon. The dashboard shows his run. He watches the `explore` node ask clarifying questions, answers them, and sees the `implement` node start coding.

**Climax:** The story completes in 20 minutes. A draft PR appears on GitHub. Marcus reviews it — the BMAD evidence shows zero findings, QA swarm found one LOW (missing input validation). The fix was applied in `fix-wave-1`. Marcus merges.

**Resolution:** Marcus is now running the same factory as Steve, with the same quality pipeline, but on his own machine with his own API keys. The shared state is the git repo (code + `.claude/wiki/` + `.claude/qds/`). Runtime state is per-developer (Archon instance, worktrees, API keys). If both submit stories touching the same files, git merge conflicts are handled at PR merge time — for MVP, developers coordinate via the wiki and standups.

**Requirements revealed:** `/qds init` skill with wiki scaffold, per-developer Archon instance support, independent API key configuration, shared wiki via git, PR attribution.

---

### Journey 4: Steve's Factory Gets Smarter (Learning System — Cross-Session Intelligence)

**Opening Scene:** It's Friday evening. The factory has processed 12 stories this week. Steve runs `/qds-wiki-nightly` manually to see what the consolidation agent produces.

**Rising Action:** The skill executes: `git log --since="24 hours ago" --oneline`, searches claude-mem for `qds-story-completed` and `qds-process` tags, runs `gitnexus analyze`, then reads each changed module's wiki page. It rewrites `wiki/modules/auth.md` to include new patterns observed from the 3 auth-related stories this week. It updates `wiki/patterns/testing.md` with a new section on mock isolation — the QA swarm caught inconsistent mock usage twice. It recalculates hotspots: `src/auth/middleware.ts` now appears in 75% of stories, earning hotspot status. The `.hotspots` file is updated.

**Climax:** The skill commits: `wiki: nightly consolidation 2026-05-16`. Steve reviews the diff. The auth module page now documents the retry pattern that emerged from Story 1.1. The testing patterns page warns about mock isolation. He notices the QA swarm this week spawned a pattern-specific agent for "null checks on external API responses" — that pattern was stored to claude-mem after the adversarial-review node found it in Story 1.4.

**Resolution:** Next Monday, Steve submits a new auth story. The `explore` node reads the updated `wiki/modules/auth.md` and knows the retry pattern exists. The `qa-swarm` node reads the pattern library, sees "null checks on external API responses (7 occurrences)", and spawns a targeted agent. The issue is caught on first implementation — no fix wave needed. The factory is measurably smarter than it was last week.

**Requirements revealed:** Nightly wiki agent skill, claude-mem tag-based storage (`qds-story-completed`, `qds-process`, `codebase-issue-patterns`), pattern library filtering by blast radius, hotspot detection and recalculation, wiki module page rewriting from current code state.

---

### Journey 5: Emergency Stop During Z.ai Outage (Admin / Operations — Critical Gap)

**Opening Scene:** Tuesday 2pm. Steve gets a Slack alert: "Z.ai API returning 503 errors — estimated downtime 2 hours." He has 4 stories in progress across 2 epics. The Archon dashboard shows multiple `implement` nodes retrying repeatedly, burning token budget on failed requests.

**Rising Action:** Steve types `/qds stop --all`. The skill sends cancellation requests to all active Archon workflow runs, updates all `plan.json` files to status `PAUSED`, and prints a summary: "4 stories paused. 2 worktrees preserved. Estimated budget saved: $12.40." The wave executor stops launching new stories.

**Climax:** Steve switches the model routing: he edits the `qds-piv-loop.yaml` env blocks temporarily to route all nodes to Anthropic (removing the Z.ai env override). He restarts the 4 stories with `/qds resume`. The wave executor re-reads `plan.json`, sees `PAUSED` status, and re-launches the stories with the updated workflow config. Anthropic handles the load; costs are higher but work continues.

**Resolution:** Z.ai comes back online 90 minutes later. Steve runs `/qds status` — all 4 stories completed on Anthropic. He reverts the workflow YAML to normal Z.ai routing for future stories. He adds a note to the runbook: "Z.ai outage → `/qds stop --all` → temp Anthropic routing → `/qds resume` → revert YAML when healthy."

**Requirements revealed:** Emergency stop/circuit breaker command, run cancellation via Archon API, status preservation in plan.json, model routing override without code changes (YAML edit), resume-from-pause capability, cost-saving summary on stop.

### Journey Requirements Summary

| Journey | Capabilities Revealed |
|---|---|
| Journey 1 (Epic success) | `/qds` skill, DECOMPOSE, wave executor, Archon workflow runs, HITL gates, autonomous review/fix, draft PRs |
| Journey 2 (Failure recovery) | Archon node failure visibility, worktree persistence, plan.md restart, wiki freshness validation |
| Journey 3 (Setup) | `/qds init`, wiki scaffold, per-dev Archon instances, shared wiki via git |
| Journey 4 (Learning) | Nightly wiki agent, claude-mem pattern storage, hotspot detection, QA swarm pattern agents |
| Journey 5 (Emergency stop) | `/qds stop/resume`, circuit breaker, model routing override, cost-saving summary |

### Elicitation-Enhanced Gap Analysis

From Advanced Elicitation (Pre-mortem + Failure Mode + Critical Challenge):

| Gap | Source | Priority |
|---|---|---|
| Unified health check (`/qds health`) | Pre-mortem (operational fragility) | HIGH |
| Async HITL notifications (Slack/Discord) | Pre-mortem (human bottleneck) | MEDIUM |
| One-command setup validation | Pre-mortem (setup complexity) | HIGH |
| Pattern library TTL + auto-prune | Pre-mortem (silent degradation) | MEDIUM |
| Epic markdown validation | Failure Mode (malformed input) | HIGH |
| Archon POST idempotency | Failure Mode (network timeout) | MEDIUM |
| Z.ai retry + Anthropic fallback | Failure Mode (rate limits) | HIGH |
| Pre-flight gh auth check | Failure Mode (token expiry) | HIGH |
| Emergency stop / circuit breaker | Critical Challenge (missing journey) | HIGH |
| Budget enforcement + kill switch | Critical Challenge (cost overrun) | MEDIUM |
| File-conflict auto-detection | Critical Challenge (multi-dev) | MEDIUM |
| API quality degradation detection | Critical Challenge (fallback) | LOW |

The journeys above reveal both explicit capabilities and latent constraints. The following domain-specific requirements translate those constraints into hard rules that govern how the factory operates.

## Domain-Specific Requirements

### AI Agent Execution Constraints

- **Context isolation is non-negotiable.** Development agents (`implement`, `fix-feedback`) must never share context with review agents (`adversarial-review`, `qa-swarm`, `bmad-code-review-1/2`). Archon enforces this via `context: fresh` on review nodes.
- **HITL gates must not block indefinitely.** The `explore` and `fix-feedback` loop nodes pause for human input. If no response within **4 hours**, emit async Slack/Discord notification and **auto-approve with warning** logged to audit trail.
- **Agent output must be structured, not prose.** Review nodes output JSON. Implement nodes output commit hashes + task completion status. Unstructured output breaks downstream automation.
- **Determinism for reproducibility.** All non-interactive nodes use `temperature: 0` and deterministic seeding. Retry of a node must produce identical output given identical input — critical for debugging and QA validation.

### Model Runtime & API Management

- **Per-node env injection is the single routing primitive.** Archon's `dag-executor.ts` supports `env: Record<string, string>` on every node. Values support `${VAR}` expansion from process env at execution time. Missing vars warn but don't halt. **Env scrub:** child processes inherit only whitelisted env vars plus node-specific overrides — no transitive leakage.
- **Model tier mapping is env-driven, not code-driven.** `ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.1` and `ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5-turbo` set per node. Workflow YAML's `model:` field uses Anthropic tier names — env vars handle translation transparently.
- **Provider circuit breaker with backoff.** Per-tier circuit breaker: after 3 failures or latency >30s, trip breaker, shed load, and shift traffic to fallback tier. Auto-reset after 5 minutes. Prevents hammering dead endpoints.
- **Secrets lifecycle.** `ZAI_API_KEY` lives in Archon's `.env` (gitignored). Per-node env blocks reference it via `${ZAI_API_KEY}` — no hardcoded secrets in YAML. Rotation: update `.env`, restart Archon.

### Development Workflow Integrity

- **Git worktree isolation per story.** Every story runs in `.worktrees/{story-id}` on branch `qds/{story-id}`. No two stories share a worktree. **Cleanup:** `finalize` node runs `git worktree remove --force` in a `trap` block. Periodic orphaned-worktree reaper scans for stale worktrees >7 days.
- **Plan.md is the human-readable view; JSON is the SSoT.** The implement node reads a machine-readable plan (JSON/YAML schema) from disk every iteration. `plan.md` is a rendered view auto-generated from the JSON. Eliminates dual-write drift.
- **Commit at node boundaries, not every task.** Git history captures meaningful state transitions (node completion). Granular execution tracking lives in `progress.txt` (JSONL append-only).

### Operational Safety

- **Emergency stop with drain vs kill modes.** `/qds stop --all` supports:
  - `drain` — let running nodes finish, don't start new ones, preserve state
  - `kill` — terminate immediately, worktree state may be inconsistent
- **Budget governance.** Per-epic token envelope with proactive burn forecasting. At 80%: warning. At 100%: pause new launches. Post-MVP: per-story micro-budgets.
- **Pre-flight checks.** Before epic launch: Archon health, Z.ai key validity + endpoint latency, GitNexus freshness, git auth, disk space for worktrees, YAML schema validation.
- **Audit trail.** Every HITL approval, emergency stop, and model tier override is logged to `.claude/qds/audit/{YYYY-MM-DD}.jsonl` with timestamp, user, node, and action. Tamper-evident via git commit.

### Data Integrity in Distributed Coordination

- **plan.json uses atomic rewrite, not append.** Write to `plan.json.tmp`, `fsync`, `mv` to `plan.json`. Concurrent readers see consistent state. For append-only logs (audit, progress), use JSONL.
- **Concurrent file writes use atomic rename.** All shared files (wiki changelog, hotspots, pattern library) use `write tmp → atomic mv`. No `flock` required.
- **claude-mem observations are model-agnostic.** Stored as `{tag, story_id, date, source_node, observation}` in a sidecar index file. Not tied to any specific provider.

## Innovation & Novel Patterns

### Detected Innovation Areas

Five innovation areas identified, ranked by novelty and strategic importance:

| # | Innovation | Novelty Level | Closest Competitor Analog | Gap vs Competitors |
|---|---|---|---|---|
| 1 | **Per-Node Env Injection as Model Router** | High | None — Archon doesn't natively support per-node provider switching; other workflow engines (Temporal, Airflow) don't treat env vars as routing primitives | No workflow engine uses per-node environment overrides for transparent model provider switching at the subprocess boundary |
| 2 | **Adversarial Quality Pipeline at Economy-Tier Cost** | High | CodeRabbit (AI review), GitHub Copilot (AI generation) | Neither enforces context isolation between generation and review; neither makes the quality pipeline economically invisible (~3-5% of dev cost) |
| 3 | **Crash-Safe File-Based Epic Orchestration** | High | None — existing tools use databases for coordination state | No tool uses atomic file rewrites (tmp → fsync → mv) as the sole coordination mechanism for multi-story epic parallelism |
| 4 | **Closed-Loop Self-Learning via Pattern Libraries** | High | None — entirely novel category | No competitor has cross-session agent learning with blast-radius-filtered pattern injection into QA swarm |
| 5 | **Two-Tier Hybrid Architecture (Skill + Workflow)** | Moderate | Archon PIV loop (single-tier), custom agent frameworks | No existing system combines human-in-the-loop CC skill orchestration with autonomous Archon workflow execution for the same epic |

### Market Context & Competitive Landscape

**Per-node env injection** is the single most technically novel aspect of the Archon pivot. Workflow engines typically handle model routing at the platform level (all nodes hit the same API). By adding `env?: Record<string, string>` to Archon's DAG node schema and injecting overrides at the subprocess boundary, the factory achieves transparent model switching without modifying Claude Code's core or the workflow YAML's `model:` field. The YAML continues to use Anthropic tier names (`opus`, `sonnet`) — env vars handle the provider translation transparently. This is a ~20-line change with outsized architectural impact.

**Adversarial quality pipeline** combines three proven techniques in a novel configuration: (a) context isolation enforced by Archon's `context: fresh` on all review nodes, (b) dual code-review waves with parallel priority-bucketed fix agents, and (c) economy-tier model routing that makes the entire 14-node pipeline cost ~$0.02 per story. Competitors charge $0.10-$0.50 per review; the factory's quality pipeline is economically negligible because it runs on GLM 5.1.

**Crash-safe file-based orchestration** replaces the original plan's Factory Core (distributed SQLite, custom runtime) with a wave executor that reads `plan.json` fresh from disk on every iteration. Atomic rewrites (`.tmp` → `fsync` → `mv`) guarantee consistency without locks. Git worktrees provide process isolation without containers. The entire epic state machine lives in a single JSON file that a human can read and edit.

**Self-learning pattern libraries** compound with every story. QA swarm agents don't run generic review — they run *targeted prosecution* of known codebase-specific issues. After 10 stories, the pattern library knows this codebase's blind spots. After 50, it catches issues on first implementation before review nodes even run.

### Validation Approach

**1. Per-Node Env Injection**
- **Metric:** All 14 nodes execute with correct model provider (Anthropic direct for planning, Z.ai for all others) as verified by API call logging
- **Method:** Run single story through pipeline. Inspect `dag-executor.ts` debug logs for `claudeOptions.env` per node. Verify planning nodes hit `api.anthropic.com`; all others hit `api.z.ai`.
- **Minimum bar:** Zero misrouted nodes across 20 story runs
- **Timeline:** Testable immediately after Task 4 (dag-executor tests)

**2. Adversarial Quality Pipeline**
- **Metric:** BMAD defect catch rate — real issues found per story that would have shipped without review
- **Method:** Run 20 stories through pipeline. For each, record BMAD findings. Have Steve manually review the same code blind. Compare.
- **Minimum bar:** BMAD catches at least 1 real defect per 5 stories that would have survived human review
- **Timeline:** Achievable within first 2 weeks of MVP operation

**3. Crash-Safe Epic Orchestration**
- **Metric:** Resume fidelity — after killing the `/qds` skill mid-epic, restart on same epic and verify zero duplicated work, zero lost state
- **Method:** Start 4-story epic. Kill skill after Wave 1 story 1 completes. Restart `/qds` with same epic. Verify: plan.json read correctly, Wave 2 unlocks properly, no duplicate worktree creation.
- **Minimum bar:** 100% state recovery with zero data loss across 10 crash-and-resume tests
- **Timeline:** Testable immediately on MVP launch

**4. Self-Learning Pattern Library**
- **Metric:** QA swarm targeted-agent effectiveness — do pattern-specific agents catch issues that standard agents miss?
- **Method:** A/B comparison: stories with active patterns in their blast radius vs. stories without. Compare: issues caught by pattern agents, fix-wave iteration counts.
- **Minimum bar:** 20% more issues caught in scopes with active patterns vs. scopes without, within 30 days
- **Timeline:** Measurable after 15+ stories accumulate pattern library entries

**5. Two-Tier Hybrid Architecture**
- **Metric:** Human gate efficiency — time from epic submit to approved wave plan, and time from implement completion to human feedback
- **Method:** Measure human interaction time per epic. Target: <5 minutes of human attention per story for standard cases.
- **Minimum bar:** Human interacts only at explore (approval) and fix-feedback (validation) gates; all other nodes run autonomously
- **Timeline:** Testable from first epic in MVP

### Risk Mitigation

| Innovation | Primary Risk | Fallback | Cost of Fallback |
|---|---|---|---|
| **Per-node env injection** | Archon upstream rejects the PR or the env injection pattern breaks on CC subprocess boundary | Maintain a fork of `dag-executor.ts` in the project; worst case, route all nodes through Z.ai and accept higher latency for planning | Low — loses Anthropic-direct planning but functionally viable |
| **Adversarial quality pipeline** | BMAD consistently finds nothing — code is perfect or BMAD is too shallow | Tune review profiles (security, logic, API-contract focused). If still nothing: BMAD becomes rubber-stamp, pipeline is just QA waves. Cost stays negligible. | Low |
| **Crash-safe file orchestration** | Concurrent file writes corrupt plan.json under heavy parallel load | Add file locking (flock) to plan.json writes; worst case, reduce epic parallelism to 1 story at a time | Medium — loses parallel epic throughput but retains correctness |
| **Self-learning pattern library** | Patterns are wrong more often than right | Disable pattern-agent spawning; QA swarm reverts to 3 standard agents only. Pattern library still records for manual review. | Medium — loses "factory gets smarter" but retains base QA |
| **Two-tier hybrid** | Archon API changes break orchestrator integration | `/qds` skill calls Archon via stable REST endpoints; if API changes, update the skill's HTTP client only. Core logic (wave executor, plan.json) is API-agnostic. | Low |

### Competitive Moat Assessment

**Strong moat (hard to replicate):**
- **Self-learning pattern library** — requires real workloads to accumulate operational intelligence. A competitor can copy the architecture but not the accumulated patterns. Moat deepens with every story.
- **Crash-safe file-based orchestration** — the simplicity of the approach (no DB, no server, no runtime) is a feature that becomes a moat through operational reliability.

**Moderate moat (replicable with effort):**
- **Per-node env injection** — concept is simple (~20 lines). Moat is in the integration quality (YAML design, env var expansion, missing-var handling) and the economic governance built on top.
- **Adversarial quality pipeline** — concept is simple to describe. Moat is in implementation quality (review profiles, evidence templates, economy-tier routing) and full pipeline integration.

**Weak moat (easily replicable):**
- **Two-tier hybrid architecture** — the split between CC skill and Archon workflow is an implementation choice, not an architectural defensibility.

**Strategic implication:** The self-learning pattern library and crash-safe orchestration are the deepest moats for the Archon pivot. The per-node env injection is the key technical differentiator that enables the economics.

These innovations are delivered through a fork-and-extend integration with Archon. The following section defines the technical architecture, integration contracts, and implementation sequencing required to realize them.

## Project-Type Specific Requirements

### Project-Type Overview

QDS on Archon is a **fork-and-extend** of the Archon AI coding agent platform (`coleam00/Archon`). We consume Archon as both:

1. **Runtime platform** — its DAG executor, headless Claude Code runner, SSE streaming, web UI, and REST API run our workflows
2. **Target codebase** — we modify Archon's source (`packages/workflows/src/`) to add per-node env injection, then extend its workflow library (`.archon/workflows/defaults/`) with `qds-piv-loop.yaml`

| Dimension | Classification |
|---|---|
| Primary type | `developer_tool` — CLI skill entry point, workflow YAML authoring, local execution |
| Secondary type | `internal_platform` — modifying upstream codebase, managing fork divergence |
| Growth type | `saas_b2b` — potential multi-tenant licensing post-MVP |

**Fork strategy:** Track upstream `dev` branch. QDS modifications live on a `qds-factory` branch. Rebase onto upstream periodically. The `env` injection is upstreamable — designed as a clean PR that doesn't break existing workflows.

### Integration Map

| External System | Direction | Data Flow | Failure Mode | Recovery |
|---|---|---|---|---|
| **Archon (forked)** | Bidirectional + modification | We RUN on Archon AND MODIFY Archon's source | Upstream breaking change → merge conflict on rebase | Rebase strategy: `dev` → `qds-factory`. Conflicts isolated to `dag-executor.ts` and `dag-node.ts`. |
| **Archon REST API** | Bidirectional | `POST /api/workflows/:name/run`; `GET /api/workflows/runs/:runId`; `POST /api/workflows/runs/:runId/cancel` | API schema change → `/qds` skill breakage | Version-pinned API client in `/qds` skill. Integration tests catch schema drift. |
| **GitHub** (`gh` CLI) | Bidirectional | Branch create, PR create (draft), PR comment read, CI checks observe | Rate limit, auth expiry, network | Pre-flight `gh auth status`. Exponential backoff on rate limits. |
| **Git** (local) | Bidirectional | `git worktree add .worktrees/{story-id}`, branch, commit, push | Merge conflict, disk full | Atomic plan.json. Orphan worktree reaper. |
| **GitNexus** | Read | `gitnexus analyze`, `route_map`, `impact`, `query` | Stale graph → bad deps | Auto-refresh >1h. Finalize refreshes post-merge. |
| **claude-mem** | Read/Write | Memory search, store observations | Unavailable → degraded context | Agents operate without. Warnings logged. |
| **Context7** | Read (agent-decided) | Library API docs | Unavailable → hallucination risk | Agent decides retry vs proceed. |
| **Superpowers** | Read | Skill invocation in workflow nodes | Missing skill → node failure | Version-pinned in YAML. Clear diagnostics on missing skill. |

**GitHub Integration Scope (MVP):**
1. `git checkout -b qds/{story-id}` + `git push -u origin qds/{story-id}`
2. `gh pr create --draft` with structured evidence body
3. `gh api repos/{owner}/{repo}/pulls/{number}/comments` — human feedback loop
4. `gh pr checks` — CI observation only (MVP does not auto-fix CI failures)

**Pre-flight prerequisite:** `gh auth status` must pass before epic launch. `/qds init` verifies.

### Technical Architecture Considerations

#### Fork Boundary & Upstream Strategy

The modification surface is intentionally minimal to reduce rebase friction:

| File | Change | Upstreamable? | Merge Risk |
|---|---|---|---|
| `packages/workflows/src/schemas/dag-node.ts` | Add `env?: Record<string, string>` to `dagNodeBaseSchema` | **Yes** — additive, non-breaking | Low — isolated schema change |
| `packages/workflows/src/dag-executor.ts` | Per-node env injection block (~15 lines) | **Yes** — additive, non-breaking | Low — isolated to env injection section |
| `packages/workflows/src/schemas.test.ts` | 2 tests for env field parsing | **Yes** | Low |
| `packages/workflows/src/dag-executor.test.ts` | 2 tests for override behavior | **Yes** | Low |
| `.archon/workflows/defaults/qds-piv-loop.yaml` | New workflow file | **No** — QDS-specific | N/A — new file, no merge conflicts |
| `~/.claude/skills/qds/*` | CC skill files | **No** — external to repo | N/A — lives outside Archon repo |

**Rebase protocol:** When upstream `dev` advances:
1. `git fetch origin dev`
2. `git rebase origin/dev` on `qds-factory` branch
3. Expected conflicts: only if upstream modifies the same 20-line region in `dag-executor.ts` (env injection area)
4. Resolution: accept upstream changes, re-apply per-node env block

#### Per-Node Env Injection — Actual Code Analysis

**`dag-node.ts` (line 138):** `dagNodeBaseSchema` currently ends with `sandbox: sandboxSettingsSchema.optional()`. Adding `env: z.record(z.string()).optional()` makes the field available on ALL node variants (command, prompt, bash, loop, approval, cancel, script).

**`dag-executor.ts` (lines 598-601):** Current project-level env injection:
```typescript
if (config.envVars && Object.keys(config.envVars).length > 0) {
  claudeOptions.env = config.envVars;
}
```

The per-node override must be inserted AFTER this block, BEFORE line 603. The implementation reuses `expandEnvVarsInRecord` (line 303) which expands `$VAR_NAME` syntax from `process.env`.

**Critical syntax finding:** `expandEnvVarsInRecord` uses regex `/\$([A-Z_][A-Z0-9_]*)/g` — it matches `$ZAI_API_KEY` but **NOT** `${ZAI_API_KEY}`. The implementation plan's `${ZAI_API_KEY}` YAML syntax would pass through unexpanded. Decision needed:
- (a) Change YAML syntax to `$ZAI_API_KEY`, or
- (b) Enhance `expandEnvVarsInRecord` to support `${VAR_NAME}` syntax

**Env inheritance model:**
```
Base: process.env (inherited from Archon server process)
  ↓
Project-level: config.envVars (from codebase DB + config file)
  ↓
Per-node: node.env (from workflow YAML, merged ON TOP via Object spread)
```

#### Workflow YAML Composition — Forking from archon-piv-loop.yaml

The base `archon-piv-loop.yaml` (766 lines, 8 nodes: explore → create-plan → refine-plan → implement-setup → implement → code-review → fix-feedback → finalize) lives in the SAME directory as our extension. `qds-piv-loop.yaml` forks and extends:

| Base Node | QDS Extension |
|---|---|
| `explore` | + gitnexus query; + claude-mem awareness |
| `create-plan` | + gitnexus impact; + Context7; + plan stored to `.claude/qds/runs/{id}/plan.md` |
| `refine-plan` | Unchanged |
| `implement-setup` | Unchanged |
| `implement` | + per-node `env` for Z.ai; + Context7 prompt |
| `code-review` | **REPLACED** by 5 nodes: adversarial-review → qa-swarm → bmad-code-review-1 → fix-wave-1 → bmad-code-review-2 → fix-wave-2 |
| `fix-feedback` | Unchanged (human validation gates automated review) |
| `finalize` | + gitnexus refresh; + claude-mem store; + wiki update; + `bmad-retrospective` |

**Node count:** 8 → 14. Estimated: ~1,200-1,500 lines of YAML.

#### Git Worktree Isolation Model

Every story gets an isolated git worktree — git-native isolation, no containers:

- **Creation:** `git worktree add .worktrees/{story-id} -b qds/{story-id}`
- **Scope:** Agent sandbox restricted to worktree directory via Archon's `sandboxSettingsSchema`
- **Cleanup:** `finalize` runs `git worktree remove --force` in bash `trap`
- **Orphan detection:** `/qds init` scans `git worktree list` for stale entries >7 days

### Failure Mode Analysis

Systematic exploration of how each component fails under real load:

#### Component 1: Per-Node Env Injection

| Failure Mode | Trigger | Impact | Prevention |
|---|---|---|---|
| Upstream modifies same code region | Archon PR touches env injection area | Rebase conflict, silent breakage | Pin upstream commit hash in docs; automated rebase test in CI |
| `expandEnvVarsInRecord` regex mismatch | YAML uses `${VAR}` but function only expands `$VAR` | Z.ai nodes hit Anthropic directly = 25× cost blowup | Fix syntax BEFORE Task 3; add runtime validation that `ANTHROPIC_BASE_URL` is actually set |
| Node.env schema rejected on old Archon | Workflow YAML parsed by unpatched Archon instance | Validation error, workflow won't load | Version gate: qds-piv-loop.yaml requires Archon ≥ commit hash X |
| Missing `$ZAI_API_KEY` in Archon process env | Env var not set in `.env` | Nodes fallback to Anthropic, cost blowup | Pre-flight check in `/qds init`; runtime warn in dag-executor |
| Env var injection bypasses sandbox | Child process inherits full parent env + node overrides | Secrets leakage to agent context | Audit: verify `claudeOptions.env` only contains whitelisted keys |

#### Component 2: 14-Node YAML Workflow

| Failure Mode | Trigger | Impact | Prevention |
|---|---|---|---|
| YAML syntax error in node 12 | Missing indent, bad escape | Entire workflow fails to load | `python3 -c "import yaml"` validation in CI; loader test |
| Loop node infinite iteration | Agent never emits `COMPLETE` signal | Run hangs, burns tokens, never finishes | `idle_timeout: 600000` (10 min); max_iterations hard cap; Archon-level loop timeout |
| Context isolation breach | `context: fresh` not respected by Archon | Review agents see implement context = adversarial review worthless | Verify via test: implement node writes secret string, review node must not see it |
| HITL gate blocked forever | User doesn't respond to explore/fix-feedback | Epic stalled, worktrees accumulate | 4-hour timeout → auto-approve with warning; Slack/Discord async notification |
| Parallel fix-wave agents conflict | Two fix agents edit same file simultaneously | Git merge conflict in worktree | Sequential commits per priority bucket; or file-scope partitioning |
| QA swarm spawns 0 pattern agents | Pattern library empty or blast radius mismatch | QA degrades to 3 standard agents only = reduced coverage | Graceful degradation: standard agents always run; pattern agents are bonus |
| Node depends_on cycle | YAML has circular dependency | Deadlock, workflow never starts | DAG validation in loader; `/qds` pre-flight checks plan.json deps |

#### Component 3: Wave Executor (plan.json state machine)

| Failure Mode | Trigger | Impact | Prevention |
|---|---|---|---|
| plan.json corrupted mid-write | Crash during atomic rename | Epic state lost, resume impossible | `.tmp` → `fsync` → `mv` pattern; backup `.plan.json.bak` before overwrite |
| Concurrent writes to plan.json | Two `/qds` instances on same epic | Race condition, state corruption | File-level advisory lock (flock) or disallow concurrent `/qds` on same epic |
| Git worktree already exists | Crash left stale worktree, retry creates duplicate | `git worktree add` fails | Pre-check `git worktree list`; remove stale before create |
| Archon API returns 500 on POST | Transient server error | Story launch fails, epic stalls | Exponential backoff retry (3×); then human gate |
| Polling loop misses state transition | Race between Archon status update and GET poll | Story stuck in `in_progress` forever | Poll interval + timeout; max poll duration before human escalation |
| Dependent story launches before dep merges | Wave executor unlock logic race | Build fails, merge conflicts | Strict status check: `status=MERGED` required before unlock |

#### Component 4: Fork Maintenance

| Failure Mode | Trigger | Impact | Prevention |
|---|---|---|---|
| Upstream rewrites dag-executor.ts | Major Archon refactor | Our 20-line patch becomes unmergeable | Keep patch minimal; document exact lines; automated rebase test |
| Upstream adds native env injection | They implement the same feature differently | Divergence, confusion, double-env | Monitor upstream PRs; if they add it, migrate to native |
| Workflow loader schema changes | New required fields in dagNodeBaseSchema | qds-piv-loop.yaml fails validation | Pin Archon version; schema compatibility tests |
| Archon web UI breaks SSE | Frontend refactor | Real-time visibility lost | SSE is observation-only; agents continue running regardless |

#### Component 5: /qds Skill + Nightly Wiki

| Failure Mode | Trigger | Impact | Prevention |
|---|---|---|---|
| DECOMPOSE hallucinates dependencies | LLM misreads file relationships | Wrong wave order, build failures | GitNexus blast radius validation as second opinion; human gate on wave plan |
| Story scope too large | Agent underestimates complexity | Implement node exceeds max_iterations | Complexity prediction from pattern library; human flag on >10 task plans |
| Wiki agent overwrites human edits | Nightly consolidation clobbers manual changes | Loss of human curation | Append-only changelog; module pages use structured sections that merge |
| claude-mem pattern library poisoned | Bad finding stored as pattern | QA swarm hunts false positives | Outcome-gated patterns: only store if story succeeded AND finding was valid |

### First Principles Analysis

Strip every assumption. Rebuild from fundamentals.

#### Assumption 1: "We must fork Archon to add per-node env injection."

**Fundamental truth:** Model routing is a subprocess-level concern. Archon spawns Claude Code as a child process. The child process's environment controls which API endpoint it hits.

**Question:** Is modifying `dag-executor.ts` the ONLY way to inject env vars per node?

**Alternative approaches explored:**

| Approach | Mechanism | Trade-off vs Fork |
|---|---|---|
| **A. Wrapper script** | Bash node runs `ANTHROPIC_AUTH_TOKEN=$ZAI_API_KEY ANTHROPIC_BASE_URL=... claude ...` | No fork needed. BUT: bypasses Archon's CC SDK integration, loses streaming, web UI, checkpointing. **Unacceptable.** |
| **B. MCP server proxy** | MCP server intercepts API calls and routes to Z.ai | No fork needed. BUT: adds latency, requires proxy infra, doesn't support all Claude features. **Fragile.** |
| **C. Claude Code config** | Per-directory `.claude-config` with API endpoint | No fork needed. BUT: Claude Code doesn't support per-directory API endpoint config. **Not possible.** |
| **D. Fork + patch** | Add `env` to schema and executor | Minimal change (~40 LOC total). Clean integration. Upstreamable. **Selected.** |
| **E. Archon plugin system** | If Archon had hooks/plugins for node execution | Ideal — no fork. BUT: Archon has no plugin architecture today. **Not possible without upstreaming first.** |

**Verdict:** Fork is necessary given current Archon architecture. The patch is small enough to maintain and upstreamable.

#### Assumption 2: "The 14-node YAML is the right granularity."

**Fundamental truth:** The quality pipeline's purpose is to catch defects development agents miss. More nodes = more opportunities to catch issues. But more nodes = more latency, more cost, more failure points.

**Question:** What's the MINIMUM set of nodes that achieves the adversarial quality guarantee?

**Analysis:**
- Context isolation requires: dev phase (implement) → review phase (fresh context). Minimum 2 phases.
- BMAD methodology requires: initial review → fix → re-review. Minimum 3 nodes (review-1 → fix → review-2).
- QA swarm adds: parallel adversarial testing. Minimum 1 node (swarm).
- Human validation requires: fix-feedback gate. Minimum 1 node.

**Minimum viable pipeline:** explore → plan → implement → fix-feedback → adversarial-review → fix → code-review → finalize = **8 nodes**

Our 14-node pipeline adds: gitnexus-check, implement-setup, refine-plan, qa-swarm (as separate from adversarial), bmad-code-review-1/2 (as separate from adversarial), fix-wave-1/2 (parallel priority-bucketed).

**Verdict:** 14 nodes is justified. The extras (parallel fix waves, separate QA swarm, dual code-review) are cost-optimized on GLM 5.1. On Anthropic direct, they'd be too expensive. The economic viability DEPENDS on per-node env injection.

#### Assumption 3: "File-based state (plan.json) is sufficient for epic orchestration."

**Fundamental truth:** State consistency requires atomic writes and single-writer semantics. Databases provide ACID. Filesystems provide atomic rename.

**Question:** When does plan.json break down?

| Scenario | plan.json handles? | Database would handle? |
|---|---|---|
| 1 developer, 1 epic | Yes (atomic rename) | Yes (overkill) |
| 1 developer, 2 concurrent epics | Yes (separate files) | Yes |
| 2 developers, same epic | **NO** (concurrent writes, no locking) | Yes (row-level locking) |
| 2 developers, different epics | Yes (separate files) | Yes |
| Network filesystem (NFS) | Maybe (atomic rename not guaranteed on NFS) | Yes |

**MVP scope:** 1-2 developers, independent epics. plan.json is sufficient.
**Growth risk:** If B2B requires multi-developer shared epic queue, plan.json needs advisory locking or migration to SQLite.

**Verdict:** File-based is correct for MVP. Document the multi-developer-shared-epic limitation.

#### Assumption 4: "Z.ai GLM 5.1 is sufficient quality for review and implement nodes."

**Fundamental truth:** Model quality varies by task type. Coding requires reasoning + tool use. Review requires pattern matching + structured output.

**Question:** What if GLM 5.1 quality is insufficient?

**Evidence needed:**
- Run 20 stories with planning on Anthropic Opus, implement/review on GLM 5.1
- Measure: fix-wave iteration count, BMAD catch rate, human override rate
- Compare against Anthropic-only baseline on same stories

**Fallback:** If GLM 5.1 implement quality is poor, route implement back to Anthropic and keep only review on GLM 5.1. Cost increases but pipeline still works.

**Verdict:** Assume GLM 5.1 is sufficient based on current evidence, but bake in A/B measurement from day one.

#### Assumption 5: "The `/qds` skill should be a Claude Code skill, not an Archon workflow."

**Fundamental truth:** Human-in-the-loop gates require interactive context. Archon workflows support HITL via loop nodes, but the experience is node-bound. CC skills provide conversational, stateful interaction.

**Question:** Could the entire orchestrator be an Archon workflow?

| Capability | CC Skill | Archon Workflow |
|---|---|---|
| Interactive epic approval | Excellent (conversational) | Possible (loop node with gate) |
| Parse free text → stories | Excellent (full CC context) | Limited (prompt-only) |
| Dynamic dep graph revision | Excellent (human collaborates) | Clunky (loop iterations) |
| Real-time wave status updates | Poor (polling output) | Excellent (web UI SSE) |
| Crash recovery | File-based | Built-in Archon state |
| Multi-epic parallel execution | Manual | Natural (multiple workflow runs) |

**Hybrid is correct:** CC skill for human-facing orchestration (DECOMPOSE, approval, wave plan edits). Archon workflow for autonomous execution (per-story PIV loop). This is the Two-Tier architecture from Innovation analysis.

**Verdict:** Hybrid is optimal. Don't collapse tiers.

### Source Component Migration Path

| Source Component | Relationship | What Gets Reused | What Gets Modified | What Gets Built New |
|---|---|---|---|---|
| **Archon (coleam00/Archon)** | Fork target + runtime | DAG executor, CC runner, SSE, web UI, REST API, workflow loader | `dag-executor.ts`, `dag-node.ts` — per-node env injection | Nothing — Archon IS the platform |
| **archon-piv-loop.yaml** | Fork template | Node structure, loop semantics, HITL gates, prompts | Extended with 6 review/QA/fix nodes; per-node `env`; gitnexus + mem integration | Nothing — forked and extended |
| **GitNexus** | External CLI tool | Graph analysis, blast radius, impact | Bash-node invocations in workflow YAML | Nothing — used as-is |
| **claude-mem** | External memory layer | Auto-injected context, memory search | Tag conventions (`qds-story-*`, `qds-process`, `codebase-issue-patterns`) | Nothing — used via CC native integration |
| **Superpowers** | External skill library | `bmad-code-review`, `bmad-review-adversarial-general`, `bmad-review-edge-case-hunter`, `bmad-retrospective`, `bmad-create-epics-and-stories`, `bmad-sprint-planning` | `bmad-code-review` — add `--autonomous` flag, structured JSON output | Nothing — skills used as-is with minor extension |

**Greenfield components (built from scratch):**
- **`qds-piv-loop.yaml`** — 14-node adversarial pipeline
- **`/qds` CC skill** — input parsing, DECOMPOSE, wave executor, plan.json state machine
- **`qds-wiki-nightly` skill** — scheduled consolidation agent
- **Pattern library → QA swarm** — blast-radius-filtered pattern injection

### Implementation Sequencing

```
Critical path (sequential):
  1. Archon core: env schema + injection + tests (Tasks 1-4)
     └─ Blocks ALL Z.ai-routed nodes (11 of 14)
  2. bmad-code-review: autonomous mode (Task 5)
     └─ Blocks review/fix nodes (6 nodes)
  3. qds-piv-loop.yaml: full 14-node YAML (Tasks 6-10)
     └─ Blocks ALL story execution
  4. /qds skill: orchestrator + wave executor (Tasks 11-15)
     └─ Blocks epic orchestration

Parallel track:
  5a. Nightly wiki agent (Task 16)
  5b. Environment config + smoke test (Tasks 17-18)
```

**With 2 developers:**
- Developer A: Items 1 → 2 → 3 → 4 (critical path)
- Developer B: Items 5a + 5b (parallel track)
- Integration: End-to-end epic test after item 4

### Implementation Considerations

**Fork maintenance is a long-term operational concern.** Archon is actively developed (last commit: PR #1026). The `qds-factory` branch will diverge over time. Mitigation: keep modifications minimal (4 files, ~40 lines of TypeScript), upstream the `env` injection as a PR if accepted, and version-pin the Archon commit hash in setup documentation.

**Archon core modification is THE critical path blocker.** Without per-node env injection, 11 nodes hit Anthropic directly. Quality pipeline cost: ~$0.50/story instead of ~$0.02/story — 25× increase, eliminating economic viability.

**`env` syntax discrepancy — must fix before Task 3.** `expandEnvVarsInRecord` supports `$VAR_NAME` only. The implementation plan specifies `${ZAI_API_KEY}`. Either:
- (a) Change YAML to `$ZAI_API_KEY`, or
- (b) Enhance `expandEnvVarsInRecord` to support `${VAR_NAME}` syntax.
Decision deferred to implementation — both are trivial fixes.

**Workflow YAML is highest design risk.** 14 nodes, complex deps, mixed HITL/autonomous modes, per-node env blocks, loop semantics. A single malformed prompt undermines the entire pipeline. Prototype with one story end-to-end before building `/qds` orchestrator.

**`/qds` skill is moderate risk, well-understood patterns.** DECOMPOSE and wave executor are established patterns. Risk is in edge cases: dep cycle detection, concurrent file contention, atomic plan.json writes under crash conditions.

**`gh` CLI is hard dependency.** `/qds init` must verify `gh auth status` and repo scope. Without it, factory develops but cannot ship PRs.

**Minimal Patch Contract:** The QDS fork modifies exactly 4 files in `packages/workflows/src/` totaling ≤50 lines of TypeScript. Any future modification that exceeds this boundary requires Architecture Decision Record justification and re-evaluation of fork viability.

**Multi-Developer Limitation:** For MVP, epic orchestration assumes a single writer per epic. Two developers may run independent epics concurrently but must not invoke `/qds` on the same epic simultaneously. Growth: add file locking or migrate to SQLite-backed state.

**Model Quality Validation Gate:** Before declaring MVP complete, run A/B test: Cohort A (10 stories, implement + review on GLM 5.1) vs. Cohort B (10 stories, implement + review on Anthropic Opus). Metrics: fix-wave count, BMAD catch rate, human override rate, total cost. Decision threshold: If Cohort A fix-wave count > 2× Cohort B, route implement back to Anthropic.

**Failure Tolerance Specifications:**

| Component | Happy Path | Degraded Path | Catastrophic Path |
|---|---|---|---|
| Env injection | Z.ai routing works | Falls back to Anthropic direct (higher cost) | Workflow fails to load (schema mismatch) |
| 14-node YAML | All nodes execute | Skip optional nodes (QA swarm → 3 standard agents) | YAML syntax error → workflow won't start |
| Wave executor | plan.json atomic write | Corruption detected → use `.plan.json.bak` | Both corrupted → human recovers from git |
| Fork rebase | Clean apply | Minor conflict → manual resolution | Major refactor → abandon fork, re-implement on new Archon |

## Project Scoping & Phased Development

### MVP Strategy & Philosophy

**MVP Approach:** Problem-Solving MVP with extraction contingency. Ship one complete story through the full adversarial pipeline end-to-end without human intervention. Prove the fork+extend model, per-node env injection, and adversarial quality pipeline work in production. Then scale to epics and learning systems.

**Key Strategic Decision:** Trade architectural control for time-to-validated-learning. The canonical PRD's MVP was a 6-month build of a custom Factory Core + 5 OSS integrations. The Archon pivot collapses that to ~20 tasks by consuming Archon as the runtime. The tradeoff: less control, faster validated learning.

**Resource Requirements:** 2 developers (Steve + co-dev), independent factory instances, shared state via git. Critical path on Developer A (Archon fork → YAML → /qds skill). Parallel track on Developer B (telemetry + wiki agent + smoke test).

### MVP Feature Set (Phase 1)

**Core User Journeys Supported:** J1 (Epic success — single story minimum, multi-story if parallelism lands), J2 (Failure recovery — worktree persistence + plan.md restart), J3 (Setup — `/qds init` + wiki scaffold), J5 (Learning — nightly wiki agent, pattern library seeding)

**Must-Have Capabilities:**

| Capability | What It Means | From Canonical? |
|---|---|---|
| Per-node env injection | `dag-node.ts` schema extension + `dag-executor.ts` merge logic (~40 LOC) | New — fork boundary |
| 3-node vertical slice prototype | Validate env injection with `explore → implement → adversarial-review` before full 14-node YAML | New — risk reduction from Party Mode |
| 14-node PIV workflow | `qds-piv-loop.yaml` with gitnexus, mem, adversarial, QA, dual review, fix waves | Adapted — replaces 5-phase custom pipeline |
| `/qds` CC skill | Epic parse, DECOMPOSE with GitNexus, wave executor, plan.json state machine | Adapted — replaces Factory Core orchestrator |
| Autonomous BMAD review | `--autonomous` flag, structured JSON output (severity tiers), evidence template | Reused — same requirement, different invocation |
| Archon-native hook enforcement | Bash validation nodes in YAML (lint, test, type check) + phase boundary gate node + Archon sandbox settings | Adapted — canonical 6-layer hooks collapsed into YAML nodes + sandbox |
| File-based state | Atomic plan.json, progress.txt, status files, worktree isolation | Adapted — replaces SQLite coordination |
| JSONL telemetry | Every node appends `{story_id, node, model, tokens, cost, outcome, duration_ms}` to `.claude/qds/telemetry/YYYY-MM-DD.jsonl` | New — from Party Mode |
| Git worktree isolation | Per-story branch + worktree, cleanup in finalize trap | Reused |
| Nightly wiki agent | `git log` + `gitnexus analyze` + mem tag search + module page rewrite | Adapted — replaces full learning system |
| Emergency stop/resume | `/qds stop --all`, `/qds resume`, plan.json status preservation | New — from gap analysis |
| Pre-flight checks | Archon health, Z.ai latency, gh auth, disk space, YAML validation | New — from gap analysis |
| PR evidence body | Structured: dev summary, BMAD findings, QA results, cost, model attribution | Reused |

**Explicitly OUT for MVP (deferred to Growth):**
- Custom dashboard metrics frontend → Archon web UI is the dashboard for MVP
- Full Factory Learning System (3-loop injection, synthesis, overlay assembly) → nightly wiki + pattern library seeding only
- Agent Performance System (ELO, credits, autonomy tiers) → fixed autonomy level for MVP
- Copilot conversational UI → deferred
- Cron self-healing loop → nightly wiki only for MVP
- Configurable merge policies → fixed draft-PR for MVP

### Post-MVP Features (Phase 2: Growth)

| Feature | What It Adds | Canonical Mapping |
|---|---|---|
| Extended work types | Spike, Review-Only, Audit pipeline configurations | Direct transplant |
| Full learning system | 3-loop injection, synthesis script, overlay assembly, conflict detection | Adapted from canonical J5 |
| Pattern library → QA swarm | Blast-radius-filtered pattern agents, outcome-gated storage | New — Archon-native |
| Custom dashboard metrics | Cost-per-story tracker, BMAD catch rate, hotspot visualization consuming Archon API | Adapted |
| Advanced key rotation | Multiple Z.ai keys, health monitoring, automatic failover | New |
| Configurable merge policies | Auto-merge threshold, per-project rules | From canonical Growth |
| Telegram trigger integration | Archon platform adapter for Telegram bot dispatch | New |
| BMAD review profiles | Security-focused, API-contract-focused, performance-focused | From canonical |

### Vision (Phase 3: Expansion)

| Feature | Canonical Mapping |
|---|---|
| B2B packaging + multi-tenant config | Direct transplant |
| Factory Intelligence Score | From canonical — token waste trend, first-attempt success, BMAD correction rate |
| Cross-project learning transfer | From canonical — ELO portability between factory instances |
| Native Archon orchestrator primitive | "Spawn sub-workflow-run" — eliminates hybrid `/qds` + Archon API pattern |
| Mobile-responsive dashboard, keyboard shortcuts | From canonical Vision |

### Hook Enforcement in MVP — Archon-Native Adaptation

The canonical PRD's 6-layer hook enforcement is adapted for Archon's node-based execution model. Instead of a custom hook infrastructure, enforcement becomes **additional nodes and bash scripts in the YAML workflow**:

**Layer 1 — Runtime (Archon sandbox):** `sandboxSettingsSchema` on implement nodes restricts filesystem access to assigned worktree and scope. Protected files (`.env`, `.gitconfig`) inaccessible via Archon-native sandboxing.

**Layer 2 — Post-Implement Validation (bash node):** A `validate` node fires after `implement` completes. Runs: `bun test --filter {modified_files}`, `tsc --noEmit` on modified files, linter. Outputs structured JSON. Failures block progression to review phase.

**Layer 3 — Phase Boundary Gate (bash node):** A `gate-check` node fires before `finalize`. Validates: full test suite pass, build succeeds, no uncommitted changes in worktree. Outputs checklist JSON displayed in Archon UI.

**Layer 4 — BMAD Review (fresh context node):** `adversarial-review` node with `context: fresh`. Catches spec compliance, architecture quality, edge cases.

**Layer 5 — QA Swarm (parallel nodes):** `qa-swarm` runs parallel adversarial tests on economy-tier models.

**Rationale:** Hook enforcement from day 1 prevents mechanical defects from reaching BMAD, preserving BMAD's context window for judgment-level issues. But the implementation is configuration (YAML nodes + bash scripts), not infrastructure. Zero new TypeScript. Zero new dependencies.

### Risk Mitigation Strategy

**Technical Risks:**

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Upstream Archon rebase conflict on `dag-executor.ts` | Medium | High | Pin to release tag (not `main`). Patch is 15 lines in isolated region. Automated rebase test in CI. |
| Z.ai GLM 5.1 quality insufficient for implement/review | Medium | High | A/B validation gate built into MVP sign-off. Structured output contract (JSON mode) for all Z.ai nodes. Fallback: route implement back to Anthropic. |
| 14-node YAML design error (infinite loop, bad prompt) | Medium | High | 3-node vertical slice prototype validates env injection + output parsing before full DAG. `python3 -c "import yaml"` validation in CI. |
| `${VAR}` vs `$VAR` env syntax mismatch + security audit | Certain (known) | High | Fix BEFORE Task 3. Audit whether Archon's node executor passes env vars through a shell layer (injection vector). Add runtime validation that `ANTHROPIC_BASE_URL` is actually set. |
| plan.json concurrent write corruption | Low (single-writer MVP) | Medium | Atomic tmp→fsync→mv. Backup `.plan.json.bak`. Document multi-dev limitation. |
| Hook enforcement adds YAML complexity | Low | Low | Two bash nodes (validate + gate-check) using existing project scripts. No custom infrastructure. |

**Market/Resource Risks:**

| Risk | Mitigation |
|---|---|
| 2 developers, 20 tasks still too much scope | Parallel track: Dev A (critical path), Dev B (telemetry + wiki + smoke test). If behind, drop multi-story parallelism, ship single-story-only MVP. |
| Archon upstream abandons or rewrites drastically | Extraction contingency: `/qds` skill and workflow YAML are portable. Worst case, re-implement on custom runtime (canonical PRD is the fallback blueprint). |
| Economic model fails (GLM 5.1 cost higher than projected) | Validate with A/B test. JSONL telemetry tracks actual cost per story from day one. Anthropic direct still works, just more expensive. |

### Validation Metrics

MVP success is defined by 100 stories measured on three metrics:

1. **Unit cost per story** — Target: <$0.10 total pipeline cost (development + review + QA). Tracked via JSONL telemetry. Measured per node and model tier.
2. **Cycle time** — Distribution from story creation to draft PR. Not average — distribution shape matters more than mean.
3. **Defect escape rate** — Stories passing the pipeline but failing human acceptance review. Target: <5% after learning layer seeds.

**One metric to rule them all:** If unit cost holds and defect escape rate is acceptable, the pivot is validated. Cycle time is a diagnostic, not a gate.

### Adjustments from Party Mode Review

The following adjustments were incorporated based on multi-agent review (PM, Architect, Analyst, Developer):

| # | Adjustment | Source | Complexity Impact |
|---|---|---|---|
| 1 | JSONL telemetry — every node emits structured events to `.jsonl` | John (PM) | +~10 lines in node runner. Zero infra. |
| 2 | 3-node vertical slice prototype before full 14-node YAML | Amelia (Dev) | +1-2 tasks. Risk reduction, not scope creep. |
| 3 | Structured output contract (JSON mode) for all Z.ai-routed nodes | Amelia (Dev) | Zero additional code — requirement tightening. |
| 4 | Three validation metrics: cost, cycle time, defect escape | Mary (Analyst) | Zero code — measurement framework. |
| 5 | Pin Archon to release tag, not `main` | Amelia (Dev) | One decision. Huge rebase stability. |
| 6 | `${VAR}` security audit before fix | Winston (Architect) | Same fix, security-framed. |
| 7 | Hook enforcement from day 1 via Archon-native bash nodes | Steve (decision) | +2 YAML nodes. Zero custom infrastructure. |

**Net result:** MVP expands from 18 tasks to **20 tasks**. Risk is lower. Validation is sharper. Fork is more stable. No custom infrastructure added.

## Functional Requirements

This section defines THE CAPABILITY CONTRACT for the product. Every downstream artifact — UX design, architecture, epic breakdown, story implementation — will ONLY implement what is listed here. If a capability is missing from this list, it will not exist in the final product.

56 functional requirements organized across 8 capability areas. Each FR states WHAT capability exists, not HOW to implement it. This list was stress-tested via Advanced Elicitation (Pre-mortem Analysis, First Principles Analysis, Expert Panel Review) and enhanced with 6 additional requirements.

### Epic Orchestration

- **FR1:** Developer can submit an epic via `/qds` and receive a dependency-aware wave execution plan
- **FR2:** Developer can approve, modify, or reject the auto-generated wave plan before execution begins
- **FR3:** System can parse epic markdown into individual stories with extracted dependencies
- **FR4:** System can detect implicit story dependencies using codebase graph analysis
- **FR5:** System can execute stories in dependency-respecting waves with configurable parallelism
- **FR6:** System can resume an in-progress epic from its last saved state without data loss
- **FR7:** System can present real-time epic progress showing active waves, completed stories, and blocked dependencies
- **FR54:** System can protect concurrent epic access to prevent state corruption from simultaneous invocations

### Story Pipeline Execution

- **FR8:** System can execute a single story through a multi-node workflow without manual intervention
- **FR9:** System can inject per-node environment variables to route model calls to different providers
- **FR10:** System can enforce context isolation by spawning fresh agent context for review nodes
- **FR11:** System can pause workflow execution at designated human-in-the-loop gates and resume on approval
- **FR12:** System can timeout HITL gates after a configurable duration and auto-approve with warning logged
- **FR13:** System can route planning nodes to premium-tier models and review/implement nodes to economy-tier models
- **FR55:** System can execute conditional workflow paths based on story type or scope
- **FR56:** System can detect node crashes or hangs and retry with exponential backoff before escalation

### Quality Assurance

- **FR16:** System can execute adversarial code review with context-isolated fresh agents
- **FR17:** System can categorize review findings by severity (critical / warning / info)
- **FR18:** System can execute a multi-wave QA swarm with configurable wave count and stopping threshold
- **FR19:** System can spawn parallel fix agents for priority-bucketed review findings
- **FR20:** System can execute dual code-review waves with re-review after fix application
- **FR21:** System can generate a structured evidence report documenting findings, fixes, and verification status
- **FR22:** System can enforce structured output formats for all autonomous review and implement nodes
- **FR23:** System can validate that review agents have no access to development phase context

### Hook Enforcement

- **FR24:** System can enforce filesystem sandbox restrictions per story worktree
- **FR25:** System can execute post-implement validation checks (tests, lint, type check) on modified files
- **FR26:** System can block progression to review phase when post-implement validation fails
- **FR27:** System can execute phase boundary gate checks (full test suite, build, no uncommitted changes) before finalization and display results as structured checklists
- **FR57:** System can adapt hook enforcement scripts to project type (auto-detect test runner, linter, build tool)

### Git & PR Operations

- **FR29:** System can create isolated git worktrees per story with factory-namespaced branches
- **FR30:** System can enforce git safety rules (no force-push, no direct commits to protected branches, structured commit prefixes)
- **FR31:** System can create draft pull requests with structured evidence bodies via GitHub CLI
- **FR32:** System can include cost attribution, model routing info, and factory instance identification in PR evidence
- **FR33:** System can observe CI pipeline results on created pull requests
- **FR34:** System can clean up worktrees and branches on story completion, failure, or cancellation
- **FR35:** System can detect and report orphaned worktrees from previous interrupted sessions

### Economic Governance

- **FR36:** System can track per-story token spend with node-level and model-tier granularity
- **FR37:** System can enforce per-epic token budget envelopes with warning at configurable threshold and pause at exhaustion
- **FR38:** System can enforce a daily global budget ceiling that pauses non-critical work when exceeded
- **FR39:** System can attribute every model API call to a full chain (developer → story → node → model → cost)
- **FR40:** System can route model calls through fallback providers when primary provider fails
- **FR41:** System can emit structured telemetry events for external analysis
- **FR58:** System can project estimated cost for a story before execution begins

### Operational Safety

- **FR42:** Developer can execute an emergency stop command with drain or kill modes
- **FR43:** Developer can resume paused stories after emergency stop or provider outage
- **FR44:** System can execute pre-flight checks (runtime health, provider latency, git auth, disk space) before epic launch
- **FR45:** System can maintain an audit trail of all human approvals, emergency stops, and model tier overrides
- **FR46:** System can preserve story state across process crashes using atomic file writes
- **FR47:** System can detect provider degradation and shift traffic to fallback tiers with automatic recovery
- **FR48:** System can present cost-saving summaries when emergency stops terminate active work
- **FR59:** Developer can cancel an individual in-flight story without stopping the entire epic
- **FR60:** System can validate actual model endpoint per node via telemetry to detect routing failures

### Learning & Knowledge

- **FR49:** System can execute a nightly consolidation agent that synthesizes codebase changes, graph intelligence, and observations into wiki updates
- **FR50:** System can detect codebase hotspots (files appearing in high percentage of stories) and flag them for extra scrutiny
- **FR51:** System can store structured pattern observations from review findings for future QA targeting
- **FR52:** System can refresh module wiki pages from current code state after story completion
- **FR53:** System can initialize a project scaffold with wiki directories, run tracking, and starter documentation
- **FR61:** System can validate pattern observations against story outcomes before adding them to the pattern library

## Non-Functional Requirements

Non-functional requirements define HOW WELL the system must perform. Only categories relevant to QDS on Archon are included. Accessibility is excluded — this is an internal developer tool with the Archon web UI as its primary interface. This list was stress-tested via Advanced Elicitation (Chaos Monkey Scenarios, First Principles Analysis) and enhanced with 4 additional requirements while removing 2 untestable constraints.

### Performance

- **NFR1:** System shall measure and report workflow execution latency per node for observability
- **NFR2:** State file operations shall complete in under 1 second on target development hardware
- **NFR3:** Pre-flight check suite shall complete in under 30 seconds
- **NFR4:** HITL gate async notification shall trigger within 5 minutes of timeout threshold

### Security

- **NFR5:** API credentials shall never be exposed in agent context, logs, PR evidence, or committed files
- **NFR6:** Per-node environment variable expansion shall be audited for shell injection vectors
- **NFR7:** Agent filesystem access shall be restricted to assigned worktree scope
- **NFR8:** Audit trail entries shall be tamper-evident via git commit

### Reliability

- **NFR9:** System shall demonstrate 100% state recovery in tested crash scenarios using atomic file writes
- **NFR10:** Model routing shall produce zero misrouted nodes in acceptance testing
- **NFR11:** Workflow run success rate (nodes completing without timeout or error) shall exceed 95%
- **NFR12:** File-based state operations shall use atomic writes (tmp → fsync → rename)
- **NFR26:** System shall monitor disk usage with warning at 80% and halt new story starts at 95%

### Scalability

- **NFR13:** System shall support 3-5 concurrent stories per epic with proper worktree isolation
- **NFR14:** System shall support 2 concurrent epics on independent plan.json files
- **NFR15:** Telemetry files shall handle 90 days of continuous operation without manual intervention
- **NFR28:** Telemetry log rotation shall trigger at 100MB or 30 days, whichever comes first

### Integration

- **NFR16:** Archon API client shall be pinned to a specific version with schema compatibility checks
- **NFR17:** GitHub CLI operations shall implement exponential backoff with maximum 3 retries on rate limits
- **NFR18:** Codebase graph refresh shall occur automatically when graph age exceeds 1 hour
- **NFR19:** System shall degrade gracefully when external integrations are unavailable (warnings logged, work continues)
- **NFR27:** Structured output validation shall retry with exponential backoff (maximum 3 attempts) before marking node failed

### Maintainability

- **NFR22:** Workflow YAML syntax shall be validated by standard YAML parser before deployment
- **NFR29:** Concurrent access to the same epic shall be serialized via file-level advisory locking or queueing

### Economic Governance

- **NFR23:** Per-story cost projection accuracy shall be within ±20% of actual spend
- **NFR24:** Budget circuit breaker shall trigger within 1 node of threshold crossing
- **NFR25:** Emergency stop command shall propagate to all active workflow runs within 10 seconds
