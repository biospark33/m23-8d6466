---
stepsCompleted: ['phase-0-spikes', 'executive-summary', 'goals', 'personas', 'architecture', 'component-inventory', 'functional', 'nonfunctional', 'accountability', 'self-improvement', 'phased-delivery', 'risks', 'dependencies', 'verification', 'wave-1-deepen-integrate', 'wave-2-audit-fixes', 'gitnexus-integration', 'lsp-integration', 'wave-3-adversarial-qa-fixes', 'wave-4-layer-b-self-optimization (7-POV fan-out: RL/counterfactual/FinOps/DAG-shape/knowledge-mgmt/Goodhart/measurement; native-first cost_events+activity_log re-verified on disk; §9.4 + FR-LEARN-1..27 + NFR-LEARN additions + R15..R26 + OQ-7..16)']
inputDocuments:
  - '_bmad-output/planning-artifacts/architecture-v3.md'
  - '_bmad-output/planning-artifacts/handoff-prompt-v3-plan.md'
  - '_bmad-output/planning-artifacts/handoff-self-learning-optimization.md'
  - 'QDS-Factory v4 Blueprint (operator-supplied)'
workflowType: 'prd'
prdFormat: 'bmad-create-prd house format (FR/NFR rigor), enterprise 14-section structure'
groundTruth: 'Phase-0 live spikes, 2026-06-05 (4 parallel verification agents across Archon / Pi-coms / Paperclip / pi-lens+memory)'
authoring: 'Wave-1 multi-agent deepen pass (5 section owners) + hindsight-docs skill grounding; integrated single-author'
---

# Product Requirements Document — QDS-Factory v4 (the "Dark Code Factory")

**Author:** Steve (dr.steve@biosparkhealth.com)
**Date:** 2026-06-05
**Status:** DRAFT — pending operator review (scope this session = PRD only; epics/stories deferred)
**Ground-truth basis:** This PRD supersedes the v4 architecture blueprint's scorecard with **live, file-cited spike findings** (Section 5). Several load-bearing blueprint claims were corrected; corrections are marked **[Δ CORRECTED]** throughout.

---

## 0. How this document was produced (provenance)

The v4 blueprint was an architecture proposal that had **never been ground-truthed against the repos on disk**. Before committing to ~38 stories, a Phase-0 spike pass ran four parallel verification agents (read-only, every claim cited to `file:line`) across the four systems:

- **Archon** — `/Users/steve/Archon` (remote `coleam00/Archon`, branch `dev`, HEAD `536584db`)
- **Pi comms** — `/Users/steve/QDS-engineer/pi-vs-claude-code` + upstream `disler/pi-vs-claude-code@main`
- **Paperclip** — `/Users/steve/boardlensai/paperclip` (remote `paperclipai/paperclip`, HEAD PR #7527 `78dc3625`)
- **pi-lens + memory** — `pi 0.55.0`, `sd 0.2.5`, `mulch 0.6.3`, Hindsight stack

The spike outcome: the control-plane and orchestration substrates are **real and stronger than claimed**, but **three load-bearing components are not yet on disk** (coms.ts, pi-lens, the Telegram + Hindsight Paperclip plugins), and **two blueprint assumptions were false** (Hindsight is not cloud-only; the Archon "fork" is currently plain upstream). This PRD is written to that corrected reality. Phase 0 is therefore *acquisition + verification*, not just configuration.

This draft was then deepened by a **Wave-1 multi-agent pass** — five section owners each deepened 1–3 sections against the spike evidence and (for memory/self-improvement) the `hindsight-docs` skill — and integrated by a single author to preserve coherence and stable FR/NFR IDs.

---

## 1. Executive Summary & Vision

### 1.1 The Dark Code Factory

QDS-Factory is a **lights-out software factory**: work enters through any communication channel (Telegram, iMessage, dashboard) and **autonomously becomes a reviewed pull request** with minimal human oversight. It is not a single mega-agent; it is a **layered organization of agents** with deterministic seams between stages and small, emergent problem-solving teams inside each stage.

Four layers, top to bottom:

1. **Paperclip** — the control tower. Org chart, budgets, issues (system-of-record), approvals, heartbeat, cron routines, plugins. Channels and memory arrive as **installed plugins**, not native adapters (§5.3).
2. **Hermes** — 24/7 department managers (Dev / QA / Maintenance), each a Paperclip-registered agent (`hermes_local`) that owns channels and drives orchestration.
3. **Archon PIV DAG** — fresh-context, worktree-isolated, SSE-audited workflow graphs. Deterministic seams. Run **on upstream `coleam00/Archon@dev` plus a maintained 2-site env patch** — not a private fork (§5.1).
4. **Pi agent teams** — inside heavy DAG nodes, a small swarm (≤4) of mixed-model Pi agents coordinates peer-to-peer, each running QA tooling (pi-lens), producing a merged structured result.

### 1.2 The yield-curve thesis (why this is different)

The differentiator is not autonomy — it is **accountability + measurable improvement**. Every PR is traceable through a single audit chain (Section 8), every action is costed against a **cost-event ledger** (not an issue field — §5.3, §8), every human decision is logged. And the factory is built to **get measurably better with use**: five nested improvement loops (Section 9) drive a *yield curve* — Technical-Debt-Index trend **down**, cost-per-story **down**, first-pass PR-accept rate **up**, retry-count **down** — charted on the dashboard. The proof is the curve, not the vibes.

### 1.3 What "good" looks like at GA

A non-technical operator drops a feature request into Telegram. Within budget and without further input (except gated high-risk approvals surfaced as one Telegram tap), a reviewed PR appears on the target repo. The dashboard shows the full lineage of that PR and a downward-trending cost/defect curve across the last N stories.

---

## 2. Goals & Non-Goals

### 2.1 Goals

Each goal carries a **success metric** tied to the Section 9 KPIs (so "done" is measurable, not asserted).

- **G1 — Useful:** Channel input → autonomous reviewed PR on a single target repo.
  - *Success metric:* the Phase-1 make-or-break flow (F1) produces ≥1 real reviewed PR on a sample repo from a Telegram `/qds` with no human input except gated approvals; thereafter **first-pass PR-accept rate ↑** trends upward across stories (§9.2).
- **G2 — Accountable:** Every PR reconstructs to a single audit chain (epic → Seeds → Paperclip issue → Archon run → Pi team → pi-lens → memory). Nothing anonymous; everything costed; every approval logged.
  - *Success metric:* for any merged PR the full chain (§8.1) is reconstructable with **no missing hop** (NFR-ACC-2), and **cost/story** is queryable per issue tree from the `cost_events` ledger at any time (§9.2, not month-end).
- **G3 — Self-improving:** Five measurable improvement loops; a rendered yield curve proving the factory improves with use.
  - *Success metric:* all four KPIs render on the dashboard over a rolling window (NFR-OBS-2), and **TDI trend ↓** plus **retry-count ↓** are demonstrable across a story sequence (§9.2; TDI subject to the OQ-2 headless-emit outcome and its logged fallback, §9.3).
- **G4 — Minimal oversight + safe:** Hard guardrails (budget/turn/time caps, termination guards) make unattended runs safe; humans pulled in only at gated decisions.
  - *Success metric:* a loopy prompt **terminates via a guard, not by exhausting credits** (NFR-SAF-1); default story bound ≤8 retries / ≤1h wall-clock escalates to a logged gate rather than silent retry (NFR-SAF-2), keeping **retry-count ↓** honest.

### 2.2 Non-Goals (explicitly deferred)

- **NG1 — Multi-repo / org-wide orchestration.** Single target repo for v4. (coms-net cross-device substrate exists upstream but is deferred — Section 5.)
- **NG2 — Cross-device agent teams.** Same-machine Pi swarms only (coms.ts unix-socket transport — once vendored, §5.2 — not the coms-net HTTP hub).
- **NG3 — Research department.** Dev / QA / Maintenance only.
- **NG4 — A/B model routing at scale.** Router exists (single-arm + meta-bank scoring); full A/B experimentation is a later-phase concern.
- **NG5 — A net-new orchestration engine.** We build *on* Archon (upstream + env patch) + Paperclip + Pi; we do not rebuild them.

---

## 3. Personas & Primary Flows

### 3.1 Personas

Each persona carries a **success-signal** (what tells them it's working) and a **failure-fear** (the outcome they most need designed against).

- **P1 — Operator (Steve).** Non-routine-coding owner. Defines epics, approves gated decisions, watches the yield curve. Wants the factory to "just run."
  - *Success-signal:* a reviewed PR lands from one Telegram message and the yield curve trends down across stories.
  - *Failure-fear:* a silent runaway — unbounded spend or a wrong-but-confident PR merged with no audit trail to explain it.
- **P2 — Department Managers (3 agents: Dev, QA, Maintenance).** Hermes agents registered into Paperclip via `hermes_local`. Each owns a channel surface, decomposes work, drives Archon, routes models, primes/retains memory.
  - *Success-signal:* an intake becomes Seeds stories → Paperclip issues → a green Archon run with spend under budget cap.
  - *Failure-fear:* losing authority/identity — an orphaned (anonymous) worker, a decomposition that drifts from the Paperclip issue tree, or a budget cap silently breached.
- **P3 — External stakeholder.** Submits/queries work via a channel (Telegram `/qds …`, `/status`, `/approve`) without touching the dashboard.
  - *Success-signal:* `/status` returns real progress and `/approve` actually resumes the paused run.
  - *Failure-fear:* shouting into the void — a request that is accepted but never traceable, or an approval tap that does nothing because the Telegram plugin behaviors are still unverified (§5.3, OQ-3).
- **P4 — Pi worker agents (ephemeral).** Spawned inside DAG nodes; named, costed, audited; never anonymous.
  - *Success-signal:* the agent finishes inside its turn/time/budget guard, clears its pi-lens gate, and its output merges into the node's structured result.
  - *Failure-fear:* burning unbounded budget in a coms loop, or being un-named/un-costed and so breaking the audit chain.

### 3.2 Primary flows

Each flow names the concrete components it traverses, end to end, so it is testable.

- **F1 — Intake → PR (the make-or-break flow).** Telegram `/qds <request>` → **Paperclip issue** → **Hermes Dev manager** → **Seeds** decomposition mirrored to Paperclip issues (authority split: Seeds owns deps, Paperclip owns assignment + cost ledger) → **Archon `qds-piv-loop` DAG** → bash node → **Pi team** implement node (`pi-team-launch.sh`, Mulch-primed, **pi-lens**-gated, structured emit) → reviewed PR, with learnings retained to **Hindsight**. (Phase-1 exit gate, Section 13.)
- **F2 — Gated approval.** An `executionPolicy` gate on a **Paperclip issue** pauses an **Archon** run at an approval node, pings **Telegram** with inline approve/reject, persists the decision (approvals + `issue_execution_decisions`), and resumes the run on reply.
- **F3 — Post-merge QA.** A Paperclip event wakes the **Hermes QA manager**, which drives an **Archon** hunter-pack sub-DAG of **Pi** agents (orthogonal lenses, **pi-lens**-driven); findings become **Paperclip issues** + a shared per-repo **Hindsight** bank entry that primes the next Dev implement.
- **F4 — Scheduled maintenance.** A **Paperclip** cron routine (`routine_triggers.cron_expression`) wakes the **Hermes Maintenance manager**; an **Archon** sweep sub-DAG runs **Pi** agents (+ **pi-lens**) and opens a refactor/dep-bump PR.
- **F5 — Learning.** Nightly consolidation (session memory + **Mulch** → **Hindsight**) and weekly reflection over per-manager `*-meta` banks tune the **`qds-model-router`** and skills (loop L4, §9.1).

---

## 4. System Architecture

### 4.1 The four layers + the accountability spine

```
┌ PAPERCLIP — control tower (paperclipai/paperclip) ───────────────────────────┐
│ org chart (agents.reportsTo) · budgets (budgetMonthlyCents vs spentMonthlyCents) │
│ issues = system-of-record (assigneeAgentId · status · parentId · executionPolicy) │
│ cost ledger (cost_events, FK→issue) · heartbeat_runs (exec trace)                │
│ routines + routine_triggers.cron_expression (scheduler) · approvals + decisions   │
│ PLUGINS via POST /api/plugins/install + @paperclipai/plugin-sdk + PluginEventBus: │
│   telegram (approvals/inline buttons, /status /approve) · hindsight (memory)      │
└───────────────┬──────────────────────────────────────────────────────────────────┘
                │ each manager = Paperclip agent (adapterType="hermes_local"),
                │ host injects PAPERCLIP_API_KEY + PAPERCLIP_RUN_ID; manager calls REST as that agent
   ┌────────────┼────────────────┐
   ▼            ▼                ▼
HERMES:DEV   HERMES:QA       HERMES:MAINT     ← 24/7 tool-loop; owns iMessage + channels
 (Seeds decompose · drive Archon · qds-model-router · mulch-prime · Hindsight retain/recall)
   │            │                │
   ▼            ▼                ▼
ARCHON PIV DAG (qds-piv-loop) — fresh-context · worktree-isolated · SSE-audited
   │  POST /api/workflows/{name}/run · GET /api/stream/__dashboard__ (SSE)
   │  heavy node executor = bash node (executeBashNode → execFileAsync('bash',['-c',script]))
   ▼
bash node → pi-team-launch.sh → N Pi agents (mixed models via openrouter/anthropic)
            · P2P coms (coms_send/await, response_schema) · each agent runs pi-lens (QC + TDI) + pi-gitnexus-plus (graph-aware traversal)
            · hard guards: budget/turn/time cap + tilldone task-gate + coms_await timeout
            · lead emits merged JSON → stdout → DAG node output
```

### 4.2 Deterministic seams, emergent boxes

The factory's consistency comes from **DAG structure + test-first discipline + pi-lens gating**, *not* from swarm size. The dominating rule: **prefer more DAG nodes over bigger swarms**. Need 6 agents of capacity → use 2 deterministic nodes of 3, never 1 node of 6 (coms is P2P with n² paths and `MAX_HOPS=5`; beyond ~4 agents, coordination cost and output variance explode). Determinism lives at the seams; emergence lives in the box.

### 4.3 [Δ CORRECTED] Comms is hybrid, and partly not-yet-installed

- **Telegram + approvals** = Paperclip Telegram plugin (inline buttons are the HITL gate UX). **Not on disk** — external install via `/api/plugins/install`; its claimed behaviors are unverified (Section 5, Section 12).
- **iMessage + other channels** = Hermes gateways (`hermes 0.15.1` installed; BlueBubbles iMessage confirmed upstream).
- **Outbound status/digests** unified through Paperclip → dashboard + Telegram.

### 4.4 [Δ CORRECTED] The per-node env patch — exact blast radius

Per-node model routing requires injecting `env` into the bash-node subprocess. This is **two edit sites, both in `packages/workflows`**, not a schema-only change:

- **(a) Schema:** add an optional `env` field to `bashNodeSchema` (`packages/workflows/src/schemas/dag-node.ts:179-181`, which today extends the base with only `bash`+`timeout`). The base schema (`:113-139`) has no `env`, nor does any variant.
- **(b) Executor:** pass that `env` into the subprocess call inside `executeBashNode` — `execFileAsync('bash',['-c',finalScript],{cwd,timeout})` at `dag-executor.ts:1362` currently passes **only** `{cwd,timeout}`, so the subprocess inherits Archon's parent env and nothing per-node.

Blast radius is contained: `executeBashNode` (`dag-executor.ts:1305`) has a **single upstream caller**, `executeDagWorkflow` (verified via call-graph impact analysis — LOW risk, 1 direct caller, 1 module). The change is additive (optional field; merge into the existing options object), so existing bash nodes are unaffected. Note the existing `$VAR` env regex at `dag-executor.ts:314` does **not** serve this path — it is MCP-config-scoped (`expandEnvVarsInRecord`), reading `process.env`, not a per-node map.

### 4.5 Code-intelligence layers — three surfaces, one rule

Agents have three ways to understand code; each owns a distinct job. Overlap = wasted tokens + drift. **The rule: grep for literal text · GitNexus for repo-wide *static* architecture · LSP for live, semantically-exact truth about the code being touched *right now* (including uncommitted edits).** An agent must never grep what an LSP answers exactly, nor LSP-walk what GitNexus answers cheaply repo-wide.

| Layer | Scope | Truth model | Agent surface | Best for |
|---|---|---|---|---|
| grep/glob | literal strings | text, exact-match | pi core tools | string/identifier presence, TODO scan |
| **GitNexus** (pi-gitnexus-plus) | whole repo | static graph, snapshot (≤8h stale, FR-MEM-6) | `gitnexus_context/impact/query/cypher` | call chains, blast radius, "what calls X across the repo", architecture |
| **LSP** (active server) | open files + project | **live semantic, reflects the current buffer incl. uncommitted edits** | pi-lens `lsp_navigation` / `lsp_diagnostics` | exact definitions/refs/types/hover, call hierarchy, **diagnostics (compile/type errors)**, semantic rename |

**"Active LSP server" = a warm, persistent language-server process per Pi worktree**, reused across turns (auto-discovered + managed by pi-lens from PATH / `node_modules`). When provisioned (§5.4), it delivers fast incremental diagnostics that reflect the agent's *uncommitted* edits — the one thing GitNexus (snapshot) and grep (text) cannot. GitNexus answers "how does the repo fit together"; LSP answers "is the code I just wrote correct, right now."

**Most powerful LSP uses, by role (§7 archetypes):**

| Role | LSP use | Why it's the high-value lever |
|---|---|---|
| Architect/Test (Trio r1) | hover/definitions/workspace-symbols on the real types before freezing the contract; call-hierarchy to scope the surface | the frozen contract matches actual code — no hallucinated API; pairs with GitNexus blast-radius |
| Implementer (Trio r2, cheap model) | definitions/hover for correct signatures, then a **post-edit `lsp_diagnostics` loop until 0 errors** on changed files | turns "looks right" → "typechecks"; the cheap model is safe because diagnostics + tests both constrain it |
| Reviewer/Adversary (Trio r3) | `lsp_diagnostics` on the full changeset as a hard gate; find-references to prove no caller is broken | catches type/compile breakage tests miss |
| Maintenance/refactor (F) | `lsp_navigation` rename `apply:true` = semantically-safe cross-file rename | vs `sed`/regex — no broken refs; run GitNexus blast-radius first, LSP rename executes |
| QA Hunter (E) | diagnostics + references across the diff | unhandled call sites, type regressions |

**The single strongest lever — the post-edit diagnostics gate:** a node cannot emit its result while `lsp_diagnostics` reports errors on the files it changed (FR-EX-11). This makes "compiles + typechecks" a hard precondition of every handoff, feeds the pi-lens turn-end gate, and drives L1 (fewer in-run defects, §9.1). (Contingent on the OQ-2 LSP sub-finding that headless `lsp_diagnostics` emits machine-readable results; if TUI-only, the gate degrades to ast-grep + tests per FR-EX-12.)

**Surface choice:** pi-lens's `lsp_navigation` / `lsp_diagnostics` are the **primary** LSP surface (richest — call hierarchy + rename-apply + workspace symbols + findSymbol — and they ride in with the QA gate we already install; pi-lens auto-discovers servers). The standalone `@spences10/pi-lsp` v0.0.33 (defs/refs/hover/diagnostics/symbols, MIT) is the **fallback** for a lightweight nav-only role that does not want the full pi-lens gate. Do **not** load both by default (tool overlap → agent confusion). **The binding prerequisite is a language server on PATH for the target repo's language** (§5.4) — pi-lens cannot diagnose a language whose server is absent.

---

## 5. Component Inventory (verified scorecard)

Legend: ✅ verified true · ⚠️ true-with-correction · ❌ false/absent · 🔧 must-acquire.

### 5.1 Archon (orchestration) — `/Users/steve/Archon` @ `coleam00/Archon:dev`

| Claim | Verdict | Evidence (file:line) / correction |
|---|---|---|
| `dag-node.ts` has no `env` field → fork needed | ✅ | `packages/workflows/src/schemas/dag-node.ts:113-139`; no `env` in base or any variant (command/prompt/bash/script/loop/approval/cancel). Bash node (`:179-181`) adds only `bash`+`timeout`. |
| Env substitution `$VAR` regex `/\$([A-Z_][A-Z0-9_]*)/g` | ⚠️ | Regex exact at `dag-executor.ts:314` **but** it is **MCP-config-scoped** (`expandEnvVarsInRecord`/`loadMcpConfig`, reading `process.env`), NOT the bash/prompt path. Bash inputs come via `substituteWorkflowVariables` + `substituteNodeOutputRefs` (node-output ref regex at `:201` is mixed-case: `/\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output…/g`). **[Δ CORRECTED]** |
| API: POST `/api/workflows/{name}/run` + GET `/api/stream/__dashboard__` (SSE) | ✅ | `packages/server/src/routes/api.ts` — run route handler reg `:1784` (OpenAPI route def `:566`), dashboard SSE `:1384`. |
| Native Pi client in fork | ❌ (not needed) | Zero Pi refs. Real path = bash node. `executeBashNode` at `dag-executor.ts:1305`; `execFileAsync('bash',['-c',finalScript],{cwd,timeout})` at `:1362`. |
| Bash node passes per-node `env` to subprocess | ❌ | **[Δ CORRECTED — load-bearing]** `execFileAsync` options at `:1362` are `{cwd,timeout}` only; subprocess inherits Archon's parent env. The env **patch** therefore requires **two edits** (this is a patch on upstream, not a fork): (a) add `env` to `bashNodeSchema` in `dag-node.ts`, (b) merge it into the `execFileAsync` options object in `executeBashNode`. Not schema-only. Blast radius LOW — `executeBashNode` has one upstream caller (`executeDagWorkflow`). |
| Base PIV = 8 nodes; 14-node `qds-piv-loop` is custom | ✅ | `.archon/workflows/defaults/archon-piv-loop.yaml` = 8 nodes (explore, create-plan, refine-plan, implement-setup, implement, code-review, fix-feedback, finalize). No `qds-piv-loop` anywhere → to author. |
| Archon is "our fork" | ⚠️ | **[Δ CORRECTED]** On disk it is plain upstream `coleam00/Archon@dev` (HEAD `536584db`); no env patch applied yet. "Sync fork + patch" = create branch off upstream + apply the 2-site env patch. Also note an extra `script` node type (bun/uv runtime) exists beyond bash. |

### 5.2 Pi comms + extensions (execution coordination)

| Claim | Verdict | Evidence / correction |
|---|---|---|
| `coms.ts` / `coms-net.ts` exist on disk | ❌ | **[Δ CORRECTED — load-bearing]** Absent from all local clones. Local `pi-vs-claude-code` frozen at squashed commit dated **2026-02-22** (16 extensions). `coms.ts` exists **only upstream** (`disler/pi-vs-claude-code@main`, last touched **2026-06-03**). Must be **vendored** before any Pi-team work. 🔧 |
| `pi --cname` is a core flag | ⚠️ | **[Δ CORRECTED]** Not core (absent from `pi --help`). It is an **extension-registered flag** (`coms.ts:536` `pi.registerFlag("cname",…)`), read at `:225`. Fallback: system-prompt frontmatter `name:`, then `agent-<6chars>`. |
| coms API (send/await + response_schema + timeout) | ✅ (upstream) | `coms_send(target,prompt,conversation_id?,response_schema?)`; `coms_get` (non-block); `coms_await(msg_id,timeout_ms?)`; `coms_list`. `response_schema` is **parse-only** (receiver's final msg `JSON.parse`d on `agent_end`; **not** schema-validated). Default timeout **30 min** = `1_800_000ms` (`PI_COMS_TIMEOUT_MS`, `coms.ts:32`). Transport: per-agent unix socket + file registry `~/.pi/coms/`; no hub; `MAX_HOPS=5`. |
| `tilldone.ts` loop guard | ✅ | Present locally. `agent_end` nudge w/ `triggerTurn:true` (`:365-383`) + `tool_call` task-gate blocking all non-tilldone tools until tasks defined/in-progress (`:335-361`). |
| Pi core flags `--model`/`--mode json`/`-e`/`--append-system-prompt`/`--session` | ✅ | Confirmed in `pi --help` (pi 0.55.0) and in on-disk dispatch arg arrays (`agent-team.ts:347-363`). |
| 18 extensions | ⚠️ | Upstream main = 19 `.ts` (one is a shared helper `themeMap.ts`); local = 16. Cosmetic. |
| Pi native ZAI/GLM provider | ❌ | Only anthropic + openrouter → route GLM/Kimi via openrouter. |

> **[Δ CORRECTED — architectural fork in the road]** The on-disk multi-agent mechanism is **not** socket comms — it is `agent-team.ts` / `pi-pi.ts` spawning `pi --mode json -p` **subprocesses** and parsing their JSON event stream. So there are **two viable in-node architectures**: (A) vendor `coms.ts` for persistent P2P socket teams, or (B) use the on-disk subprocess-RPC model. **Phase 0 must choose** (Section 12, OQ-1). Also: installed pi is **0.55.0**, but `coms.ts` comments target **pi 0.73+** — a smoke test against the installed binary is mandatory before relying on the contract (Section 12, OQ-5).

### 5.3 Paperclip (control plane) — `/Users/steve/boardlensai/paperclip` @ `paperclipai/paperclip`

| Capability | Verdict | Evidence (file:line) |
|---|---|---|
| Org chart `reportsTo` (self-FK) | ✅ | `packages/db/src/schema/agents.ts:24` (+ idx `:42`) |
| Agent budget cap + spend | ✅ | `agents.ts:30-31` (`budgetMonthlyCents`, `spentMonthlyCents`) |
| Company budget cap + spend | ✅ | `companies.ts:14-15` (`budgetMonthlyCents`, `spentMonthlyCents`) |
| Issues = SoR (assignee/status/parent) | ✅ | `issues.ts:35`(assigneeAgentId), `:32`(status), `:29`(parentId) |
| Issue **cost** | ⚠️ | **[Δ CORRECTED]** No `cost` column on issues (grep of `issues.ts` returns zero cost fields). Cost = separate ledger `cost_events` (`:15` `issueId` FK→issues.id, `:27` `costCents`). Accountability spine must read the ledger, not an issue field. |
| `executionPolicy` (approval gates) | ✅ | `issues.ts:52` `jsonb("execution_policy")` (only definition; lives on issues, not agents). Gate decisions persisted in `issue_execution_decisions`. |
| heartbeat_runs (exec trace) | ✅ | `heartbeat_runs.ts:6-82` (full file; `status:14`); issues FK via `checkoutRunId`/`executionRunId` (`issues.ts:37-38`) |
| Routines + cron scheduler | ✅ | `routines.ts` (routines/revisions/triggers/runs); `routine_triggers.cron_expression` `:99`; migration `0039` |
| Approvals (logged human decisions) | ✅ | `approvals.ts:5-28` (`status:13`/`payload:14`/`decisionNote:15`/`decidedByUserId:16`/`decidedAt:17`) |
| Plugin SDK + install endpoint + event bridge | ✅ | `POST /api/plugins/install` (`routes/plugins.ts:1008`, openapi `:3385`); `@paperclipai/plugin-sdk`; `PluginEventBus` (`services/plugin-event-bus.ts`), plugin-side `ctx.events.on("issue.created",…)` |
| Native chat adapters (telegram/slack/imessage) | ❌ | None in `packages/adapters/` (coding-agent adapters only). Channels come via plugins, as designed. |
| `hermes_local` registration adapter | ✅ | `adapters/registry.ts:440-500` injects `PAPERCLIP_API_KEY`(`:468`) + `PAPERCLIP_RUN_ID`(`:469`); external Hermes calls REST as a registered agent (`agent_api_keys` table). |
| `paperclip-plugin-telegram` (mvanhorn) | ❌ on disk | **[Δ CORRECTED]** Not present. `@mvanhorn` is a **core contributor**, not the telegram-plugin author — attribution wrong. External install; behaviors (bidirectional, `/approve` `/status`, inline buttons, per-type routing) **unverified**. 🔧 |
| `@vectorize-io/hindsight-paperclip` | ✅ exists / ❌ on disk | **[Δ CORRECTED]** Confirmed real (changelog v0.2.0, `hindsight-docs`): installed via `pnpm paperclipai plugin install`; `agent.run.started`→auto-recall, `agent.run.finished`→auto-retain (with `document_id = runId`), configurable bank granularity. **Not in the Paperclip repo** — external install. 🔧 |

### 5.4 pi-lens + memory/decomposition stack

| Component | Verdict | Evidence / correction |
|---|---|---|
| pi-lens installed | ❌ | **[Δ CORRECTED — load-bearing]** NOT installed (no disk/npm/`~/.pi` registry entry). Install shape correct: `pi install npm:pi-lens`. All capabilities (secrets scan, 37 LSPs, ast-grep, autofix, read-before-edit, TDI, turn-end report w/ stable IDs) are **currently unverifiable**. 🔧 |
| pi-lens headless TDI in `--mode json` | ⚠️ needs-spike | pi 0.55.0 `--mode json`/`--print` is genuinely non-interactive (no TUI; `dist/main.js:552`). Whether pi-lens emits machine-readable TDI in `json`/`rpc` is **unknown until installed+run** (likely needs `--mode rpc`). Spike command in Section 12 (OQ-2). |
| Seeds `sd` | ⚠️ | Installed **0.2.5** (blueprint expected 0.4.7 → **upgrade/pin**). `create/dep/ready/close` ✅; store `.seeds/issues.jsonl` (fields: id/title/status/type/priority/labels/blocks[]/blockedBy[]/closeReason). |
| Mulch | ⚠️ | Installed **0.6.3** (expected 0.10.1 → **upgrade/pin**). `prime/record/learn` ✅; store `.mulch/expertise/<domain>.jsonl`; `boardlensai/.mulch`=13 records. |
| Hindsight cloud-only, no local CLI | ❌ | **[Δ CORRECTED]** Cloud SaaS exists (`api.hindsight.vectorize.io`) **but a full local stack is also installed** (`hindsight-api/worker/embed/admin/local-mcp` in `printing-press/.venv`; `~/.hindsight-docker` v18.1.0; `hindsight_client 0.7.2` in Hermes venv). It is **self-hostable** → cloud-vs-local is a deliberate decision (Section 12, OQ-4). API: bank-scoped `/v1/default/banks/{bank_id}/…` (retain=`POST …/memories`, recall=`POST …/recall`, reflect=`POST …/reflect`, plus `…/consolidate` + `…/mental-models/{id}/refresh`). **Auth = optional bearer token** (SDK `api_key` / control-plane `HINDSIGHT_CP_DATAPLANE_API_KEY`); **NOT** `HINDSIGHT_API_LLM_API_KEY`, which is the LLM-provider key (do not conflate — §9 grounding, NFR-SEC-5). Self-host vs cloud differ only by `base_url` + bearer presence; **API surface identical**. |
| GitNexus CLI | ✅ | Installed **1.6.3** (≥1.4.8 required by pi-gitnexus-plus). `gitnexus analyze` builds the knowledge graph; MCP server confirmed **live this session** (used for the §4.4 `executeBashNode` impact analysis). |
| pi-gitnexus-plus extension | ❌ | **NOT installed** as a pi extension (`pi install npm:pi-gitnexus-plus`, v0.7.0; not in `~/.pi/agent/settings.json`). Registers **14 agent tools** (query/context/impact/detect_changes/rename/cypher/route_map/tool_map/shape_check/api_impact/group_*/read_resource) and **auto-augments file reads + searches with call chains, execution flows, and blast radius** — graph-aware traversal instead of blind grep. Stdio (local CLI) or HTTP transport. License caveat: GitNexus is PolyForm Noncommercial (extension itself MIT) — see §14 R12. 🔧 |
| Language servers (LSP) | ❌ | **None installed for the target stack** (only Apple `clangd`; `typescript-language-server`/`pyright`/`gopls`/`rust-analyzer` all absent). Archon target = TS/TSX-heavy (287 `.ts` + 70 `.tsx`) → needs `typescript-language-server` (+ `pyright` for Python) on PATH or via pi-lens managed install. pi-lens auto-discovers servers but **cannot diagnose a language whose server is absent**. 🔧 |
| LSP agent tools | ⚠️ | Ride in with **pi-lens**: `lsp_diagnostics` (file/dir/batch) + `lsp_navigation` (definitions, references, hover, workspace symbols, call hierarchy, rename `apply:true`, findSymbol). No extra install once pi-lens + a language server are present. **Headless emission unconfirmed** (same OQ-2 concern as TDI). Standalone fallback: `@spences10/pi-lsp` v0.0.33 (defs/refs/hover/diagnostics/symbols, MIT, 4.6k downloads/mo). |
| Hermes framework | ✅ | `hermes 0.15.1` installed (`~/.hermes/hermes-agent`). |

### 5.5 Acquisition gap summary (what Phase 0 must obtain)

| 🔧 Must-acquire | Source | Blocks |
|---|---|---|
| `coms.ts` (+ maybe `coms-net.ts`) | vendor from `disler/pi-vs-claude-code@main` | All Pi-team coms work |
| pi-lens | `pi install npm:pi-lens` | In-node QA gate + TDI metric |
| Telegram plugin | external npm via `/api/plugins/install` | Comms front-door + approvals |
| Hindsight Paperclip plugin | `@vectorize-io/hindsight-paperclip` (`pnpm paperclipai plugin install`) | Memory retain/recall |
| Archon env patch | author 2-site patch on a branch | Per-node model routing |
| Seeds/Mulch upgrades | `sd`/`mulch` upgrade or pin | Version-stable decomposition + priming |
| pi-gitnexus-plus extension | `pi install npm:pi-gitnexus-plus` (GitNexus CLI 1.6.3 already present) | Graph-aware code traversal for all agents |
| Language server(s) for target repo | `npm i -g typescript-language-server typescript pyright` (or pi-lens managed install) | LSP diagnostics + navigation for all agents (the post-edit gate) |

### 5.6 Confidence & residual risk

Each scorecard row carries a verification class so readers know what is **proven on disk** vs **assumed**. Anything below `verified-on-disk` is not a green light — it is a Phase-0 gate (cross-ref OQ in Section 12).

| Class | Meaning | Rows in this class |
|---|---|---|
| **verified-on-disk** | Read against the actual repo this pass; file:line re-confirmed. | Archon: no-`env` schema, `execFileAsync {cwd,timeout}` only, 2-site env patch, bash-node path, SSE+run routes, 8-node base PIV, plain-upstream status. Paperclip: `reportsTo`, agent+company budgets, issues SoR, no-cost-column / `cost_events` ledger, `executionPolicy`, `heartbeat_runs`, routines/cron, approvals, plugin SDK+install+bus, `hermes_local` injection, absent native chat adapters. Pi: `tilldone` guard, pi core flags, ZAI/GLM absence, subprocess `agent-team.ts` mechanism. Tooling: Seeds 0.2.5, Mulch 0.6.3, Hermes 0.15.1, local Hindsight stack present, GitNexus CLI 1.6.3 (installed; MCP live this session). **[Δ added]** `cost_events` column inventory (`cost_events.ts:12-29` — `agentId`/`model`/`provider`/`heartbeatRunId`/`inputTokens`/`cachedInputTokens`/`outputTokens`, enabling native per-role/per-model/per-run attribution, §8.3, FR-LEARN-2); `activity_log` schema (`activity_log.ts:6-26` — status-transition/linkage substrate). |
| **upstream-only** (real, but not in any local clone) | Verified in the upstream repo / changelog; **must be vendored or installed** before use. Confidence in the contract is high; confidence it runs **here** is not. | `coms.ts` family + full coms API + `--cname` flag + `response_schema` (parse-only) + 30-min timeout (`disler@main`, 2026-06-03). Hindsight Paperclip integration + API surface (changelog / `hindsight-docs`). |
| **not-yet-installed** (capability unverifiable until acquired) | Claimed behaviors cannot be confirmed at all from disk. Treat every downstream claim as provisional. | pi-lens (all capabilities incl. TDI, secrets scan, stable IDs). Telegram plugin (bidirectional `/approve` `/status`, inline buttons, per-type routing). Hindsight Paperclip plugin (retain/recall round-trip in this deployment). **pi-gitnexus-plus** v0.7.0 (14 agent tools + read/search auto-augmentation). **Target-stack language servers** (`typescript-language-server`/`pyright` — only Apple clangd present). **pi-lens LSP surface** (`lsp_diagnostics`/`lsp_navigation`), headless machine-readable emission unconfirmed (OQ-2). `@spences10/pi-lsp` v0.0.33 fallback. |
| **decision-pending** (fork in the road; no single ground truth yet) | Two real options exist; Phase 0 must pick, not discover. | In-node arch: socket-coms vs subprocess-RPC (OQ-1). Headless pi-lens TDI: machine-readable vs TUI-only proxy fallback (OQ-2). Telegram behavior parity (OQ-3). Hindsight cloud vs self-host (OQ-4). Pi version skew 0.55.0 vs `coms.ts` 0.73+ target (OQ-5). Archon branch-vs-upstream-PR (OQ-6). |

**Residual-risk headline:** the three load-bearing corrections all sit *below* verified-on-disk — (1) the bash env patch is verified-on-disk but **unbuilt** (2 edit sites identified, LOW blast radius); (2) `coms.ts` is **upstream-only** (not on disk, version-skewed); (3) pi-lens is **not-yet-installed** (entire in-node QA + L1/L4/L5 TDI axis rides on a component we have never run). No correction in this section was softened; each remains a Phase-0 blocker with a named OQ.

**Layer-B (self-optimization, §9.4) confidence note:** the meta-learning layer is deliberately built on **verified-on-disk** substrate — the `cost_events` columns above (native per-role/model/run cost+token attribution), `activity_log`, `heartbeat_runs`, Paperclip cron `routines`, and verified Hindsight ops (`consolidate`→observations, `mental-models` refresh, `document_id` upsert). Its **net-new, not-yet-verified** dependencies are narrow and each carries an OQ: the recomputed policy artifact store (OQ-7, decision-pending), whether Pi-subprocess spend auto-writes per-role `cost_events` rows (OQ-8, confirm in Phase 0/1), micro-waste stream telemetry (OQ-9, feasibility-gated → deferred if infeasible), escaped-defect linkage (OQ-10), and the absence of a native Hindsight TTL (OQ-15, mitigated by a client-side sweep). Nothing in §9.4 asserts infra that is not either on disk or filed as an OQ with a default fallback.

---

## 6. Functional Requirements

FRs state **what capability must exist** (testable, implementation-agnostic), grouped by layer. IDs are stable for traceability (`FR-<LAYER>-n`). Existing IDs are never renumbered; new capabilities surfaced by the BMAD completeness walk (§3 flows, §4 architecture, §8 spine, §9 loops, §13 gates) are appended at the end of each layer group.

### 6.1 Control-plane — Paperclip (`FR-CP`)

- **FR-CP-1:** The system can represent every agent (managers + workers) as a Paperclip agent row with a `reportsTo` link forming a complete org chart.
- **FR-CP-2:** The system can enforce a monthly budget cap per agent and per company, tracking spend against cap.
- **FR-CP-3:** The system can record every unit of work as an issue carrying assignee, status, and parent (decomposition tree).
- **FR-CP-4:** The system can attribute cost to an issue via a cost-event ledger entry linked to that issue. **[Δ ledger, not field]**
- **FR-CP-5:** The system can attach an `executionPolicy` to an issue that defines when a human approval gate is required.
- **FR-CP-6:** The system can persist every approval decision (who, when, outcome, note) and every execution-gate decision.
- **FR-CP-7:** The system can record an execution trace (heartbeat run) per agent run, with status, timing, usage, and result references.
- **FR-CP-8:** The operator can schedule recurring manager activity via cron-expression routines.
- **FR-CP-9:** An administrator can install a plugin (npm package or local path) via the plugin-install endpoint.
- **FR-CP-10:** A plugin can subscribe to core domain events (e.g., `issue.created`) through the event bridge.
- **FR-CP-11:** An external Hermes manager can register into Paperclip as an agent and authenticate all REST calls with a host-injected per-agent API key + run id.
- **FR-CP-12:** The system can roll up per-issue ledger cost into the owning agent's and company's `spentMonthlyCents`, so any spend is reconcilable both at the issue level and the cap level. **[Δ ledger roll-up]**
- **FR-CP-13:** A scheduled routine can trigger (wake) a specific department manager, handing it the routine's run context so the manager begins its sweep without human input.

### 6.2 Manager — Hermes (`FR-MG`)

- **FR-MG-1:** Each department manager (Dev/QA/Maintenance) can run as a 24/7 tool-loop registered as a Paperclip agent under the root org chart with a budget.
- **FR-MG-2:** The Dev manager can accept an intake request and create a corresponding Paperclip issue.
- **FR-MG-3:** The Dev manager can decompose an issue into Seeds stories with dependency links, then mirror those stories to Paperclip issues (authority split: Seeds owns dependencies; Paperclip owns assignment + cost).
- **FR-MG-4:** A manager can launch an Archon workflow run for an issue and consume its SSE stream to capture progress and outputs.
- **FR-MG-5:** A manager can select, per node, a swarm archetype and per-role model tier via the model-router (Section 7 wrappers).
- **FR-MG-6:** A manager can prime a node's agents with house-style context from Mulch before execution.
- **FR-MG-7:** A manager can retain run learnings to a memory bank and recall relevant prior learnings to prime subsequent work.
- **FR-MG-8:** A manager can apply a restart policy on failure: transient→resume, overflow→re-scope, logic→replan, bounded by retry + wall-clock caps.
- **FR-MG-9:** A manager can classify a failure signal into a restart category (transient/overflow/logic) and log that classification so retry-count is attributable by cause (feeds the §9.2 retry KPI and NFR-REL-2). **[restart classification]**
- **FR-MG-10:** A manager can reflect over its per-manager `*-meta` bank to propose a model-router/skill tuning (which tier won on cost vs quality), recording the proposed change for review (loop L4).

### 6.3 Orchestration — Archon DAG (`FR-OR`)

- **FR-OR-1:** The system can author and register a custom `qds-piv-loop` workflow (the 14-node QDS variant of the 8-node base PIV).
- **FR-OR-2:** The system can run a workflow via `POST /api/workflows/{name}/run` and stream its execution via the dashboard SSE endpoint.
- **FR-OR-3:** The system can execute a heavy node as a bash node that invokes an external launcher script and captures its stdout as the node output.
- **FR-OR-4:** The system can inject per-node environment variables into a bash node's subprocess (requires the 2-site env patch: schema field + executor pass-through). **[Δ load-bearing]**
- **FR-OR-5:** The system can run each workflow in a fresh-context, worktree-isolated workspace so concurrent runs cannot collide on working state.
- **FR-OR-6:** The system can pause a run at an approval node pending an external decision, then **resume on approval OR halt/cancel the run cleanly on reject** (no partial or corrupt state on either path).
- **FR-OR-7:** The system can capture and persist a run's SSE event stream as a retrievable post-hoc run log correlated to the originating issue id (the Archon-run hop of the audit chain, §8.1). **[SSE capture]**

### 6.4 Execution — Pi team / coms / pi-lens (`FR-EX`)

- **FR-EX-1:** The system can launch N named Pi agents into a same-machine team via `pi-team-launch.sh`, each with a distinct identity (`--cname`/frontmatter), assigned model (anthropic or openrouter), and system prompt.
- **FR-EX-2:** Team agents can exchange messages peer-to-peer (`coms_send`/`coms_await`) and request structured replies via `response_schema` (parse-enforced).
- **FR-EX-3:** The launcher can enforce hard guards: per-team budget cap, turn cap, wall-clock time cap, `tilldone` task-gate, and `coms_await` timeout — such that a loopy prompt terminates instead of burning unbounded budget.
- **FR-EX-4:** Each worker agent can run pi-lens to perform in-node QA (secrets/lint/security scan, read-before-edit guard) and emit a turn-end report with stable finding IDs and a TDI value.
- **FR-EX-5:** The system can obtain pi-lens output in a headless run (`--mode json`/`rpc`) suitable for machine consumption by the DAG. **[depends on Phase-0 spike outcome]**
- **FR-EX-6:** The team lead can merge worker outputs into a single structured JSON result emitted to stdout as the node output.
- **FR-EX-7:** The system can select a swarm archetype per node (Solo / Pair / TDD-Trio / Contract-split Quad / QA-Hunter-Pack / Maintenance), defaulting to the TDD-Trio floor for non-trivial Dev nodes (Section 7).
- **FR-EX-8:** When headless TDI is unavailable (OQ-2 negative), the system can fall back to a logged proxy metric (pi-lens warning count via `--mode rpc`) for the affected node, recording that the fallback is in effect rather than silently dropping the signal (§9.3). **[explicit fallback]**
- **FR-EX-9:** Every Pi worker agent can traverse and understand the codebase via a graph-aware context layer (pi-gitnexus-plus): file reads and searches are auto-augmented with call chains, execution flows, and blast radius (auto-augmentation enabled for judgment roles — Architect/Reviewer — and on-demand for the constrained Implementer, bounding per-agent token tax; NFR-PERF-5, R1), and agents can query the graph directly (`gitnexus_context` / `gitnexus_impact` / `gitnexus_query` / `gitnexus_cypher`) instead of relying on blind grep. Graph augmentation is advisory and non-blocking (NFR-PERF-5). **[graph-aware traversal]**
- **FR-EX-10:** Every Pi worker agent can resolve code semantics against an **active (warm, per-worktree) language server** — definitions, references, hover/type-info, workspace symbols, and call hierarchy — reflecting uncommitted edits, instead of inferring signatures from text; and can perform semantically-safe cross-file rename (`apply:true`). Surface = pi-lens `lsp_navigation` (fallback `@spences10/pi-lsp` for nav-only roles; rename `apply:true` requires the pi-lens surface); §4.5. **[live LSP nav]**
- **FR-EX-11:** An implement/maintenance node **cannot emit its result while `lsp_diagnostics` reports errors on the files it changed** — the gate runs **at node emit over the union of all files changed by any agent in the node** (not per-agent, so contract/test-scaffold files are covered) and must reach 0 errors (or an explicitly logged **waiver**) before handoff (post-edit diagnostics gate; part of the pi-lens turn-end gate; feeds L1). **Headless `lsp_diagnostics` machine-readable emission is unconfirmed — the same OQ-2 concern as TDI (§5.4, FR-EX-5); if TUI-only, the gate degrades per FR-EX-12.** **[diagnostics gate]**
- **FR-EX-12:** When headless `lsp_diagnostics` is unavailable (OQ-2 LSP sub-finding negative) **OR** no language server exists for a changed file's language **OR** diagnostics exceed their latency budget (NFR-PERF-6), the post-edit gate **degrades to pi-lens ast-grep + test-pass** as the emit precondition for the affected file(s), recording an explicit **logged waiver** (a gate-bypass record counted by NFR-SAF-4) — never a silent skip (§9.3 logged-fallback pattern). **[diagnostics-gate fallback]**

### 6.5 Memory & decomposition — Hindsight / Mulch / Seeds (`FR-MEM`)

- **FR-MEM-1:** The system can create per-repo and per-manager memory banks (`{repo}`, `{repo}-dev-meta`, `{repo}-qa-meta`, `{repo}-maint-meta`).
- **FR-MEM-2:** A manager can retain a memory (finding, decision, outcome) to a bank and recall by relevance (semantic/BM25/graph/temporal) to prime a system prompt.
- **FR-MEM-3:** QA findings retained to a shared per-repo bank can be recalled by the Dev manager on its next implement (cross-department learning transfer).
- **FR-MEM-4:** The system can decompose work into Seeds issues with dependency edges, queryable for "ready" (unblocked) work, persisted in `.seeds/issues.jsonl` traveling with the repo.
- **FR-MEM-5:** The system can record reusable expertise to Mulch and generate a priming prompt from it; nightly consolidation can fold session memory into the long-term bank.
- **FR-MEM-6:** The system can keep the GitNexus knowledge graph current via a scheduled refresh agent that spins up every **4–6h**, runs `gitnexus analyze`, and spins down — so agents always traverse a near-current graph (staleness bounded by NFR-OBS-5). `gitnexus analyze` builds into a **staging index and atomically swaps** the active graph on completion (in-flight agent queries complete against the pre-swap snapshot — no torn reads); if atomic swap is unavailable in the installed GitNexus, the refresh routine instead takes an **advisory lock** and the Maintenance scheduler must not fire a refresh while a graph-consuming DAG run is active for that repo. **[graph refresh routine]**

### 6.6 Comms (`FR-CM`)

- **FR-CM-1:** An external stakeholder can submit work and queries via Telegram slash commands (`/qds …`, `/status`, `/approve`).
- **FR-CM-2:** The system can surface an approval gate as a Telegram message with inline approve/reject buttons, and resume the paused run on the tap.
- **FR-CM-3:** The system can route different message types to different chats (per-type routing).
- **FR-CM-4:** The system can accept intake from iMessage (and other Hermes channels) and forward it into Paperclip as an issue.
- **FR-CM-5:** The system can emit outbound status/digests unified through Paperclip to both the dashboard and Telegram.

### 6.7 Accountability & yield (`FR-ACT`)

These cross-cutting FRs own the capabilities that §8 (audit chain) and §9 (yield curve) assert but that no single-layer FR backed.

- **FR-ACT-1:** Given a merged PR, an operator can reconstruct (walk) the full audit chain — memory-bank entry → pi-lens report → Pi team (agent names/models/coms log) → Archon run → heartbeat run → approvals/gate decisions → cost ledger → Paperclip issue → Seeds story → epic — with no missing hop. **[audit-chain reconstruction]**
- **FR-ACT-2:** The system can compute and record the four yield KPIs — TDI trend, cost/story (sum of `cost_events` over an issue tree), first-pass PR-accept rate, retry count — from their §9.2 recording sites, per story and over a rolling window.
- **FR-ACT-3:** The dashboard can chart the four yield KPIs over a rolling window (the rendered yield curve: TDI↓, cost/story↓, first-pass-accept↑, retry↓). **[yield-curve charting]**

### 6.8 FR→Phase traceability

Indicative mapping to §10; capability must exist by the named phase's exit gate. (Roadmap-phase FRs may have partial scaffolding earlier.)

- **Phase 0 (foundations/de-risk):** FR-CP-9, FR-CP-10, FR-CP-11; FR-OR-3, FR-OR-4; FR-EX-1, FR-EX-2, FR-EX-3, FR-EX-4, FR-EX-5, FR-EX-8, FR-EX-9 (extension installed + wired into the launcher), FR-EX-10 (target-repo language server provisioned + verified); FR-MEM-1, FR-MEM-4; partial FR-MEM-2 (retain/recall round-trip).
- **Phase 1 (Dev vertical slice, make-or-break):** FR-CP-1..8, FR-CP-12; FR-MG-1..9; FR-OR-1, FR-OR-2, FR-OR-5, FR-OR-6, FR-OR-7; FR-EX-6, FR-EX-7, FR-EX-11/12 (post-edit diagnostics gate + its fallback in the implement node); FR-MEM-2, FR-MEM-5; FR-CM-1, FR-CM-2; FR-ACT-1, FR-ACT-2 (per-story). *(FR-CP-1..8 are collectively gated by Phase-1 items 1,2,3,11,12; the support FRs FR-CP-2/5/6/7 are exercised within those rather than by a dedicated gate clause.)*
- **Phase 2 (QA dept):** FR-MEM-3; QA-side reuse of FR-EX-7 (Hunter-Pack archetype E).
- **Phase 3 (Maintenance + cron):** FR-CP-8 (exercised), FR-CP-13; FR-MG-10; FR-MEM-5 (nightly consolidation), FR-MEM-6 (4–6h GitNexus graph refresh); Maintenance archetype F of FR-EX-7.
- **Phase 4 (PR iteration + comms):** FR-CM-3, FR-CM-4, FR-CM-5; FR-OR-6 (gate→ping→resume exercised end-to-end).
- **Phase 5 (hardening):** FR-ACT-3 (yield-curve charts); reliability/crash-recovery exercise of FR-OR-5/FR-OR-7 and the ledger invariants.
- **Self-optimization (FR-LEARN, §6.9):** the per-run substrate (FR-LEARN-1/2 signature + outcome record, FR-LEARN-13 token budget) is wired in **Phase 1** (it rides the cost ledger + router already built there); the offline loops (FR-LEARN-5/9/10/11 policy recompute + counterfactual/shadow, FR-LEARN-16/17/18 meta-memory, FR-LEARN-23/24/25/26 measurement) land in **Phase 3** (alongside L3/L4 cron, FR-MG-10) and **Phase 5** (yield-curve charting + Goodhart counter-metric panels). FR-LEARN-20/21 (escaped-defect ground truth + quality-floor gate) are gated by **Phase-2 QA** — the yield curve is not Goodhart-safe before then (§9.4.4, R15).

---

## 6.9 Self-optimization & learning (`FR-LEARN`)

These capabilities make **Layer-B meta-learning (§9.4)** first-class: the factory learns an empirical policy over (task-shape → configuration → outcome) and recommends the Pareto-optimal config per task. They are **additive** to FR-MG-10 (which they extend, not replace) and built **native-first / token-frugal** (§9.4.0) — derived from `cost_events`/`activity_log`/`heartbeat_runs`/pi-lens + Hindsight native ops, computed on existing cron, with the per-run tax bounded to one recall + one event-driven retain.

*Policy core (contextual bandit, single-arm, NG4-safe — §9.4.1):*
- **FR-LEARN-1:** The system can compute a **task-shape signature** for an incoming unit of work from already-produced signals (Seeds type/priority/labels, diff-size estimate, new-contract & test-surface flags, changed-file language(s), GitNexus blast-radius bucket, risk tier from `executionPolicy`). Computed once and reused for routing, difficulty-normalization, and novelty.
- **FR-LEARN-2:** The system can record, per run, an **outcome vector** `{config used, first_pass_accept, TDI_delta, review_findings, test_pass, cost_cents, input/output/cached tokens, wall_clock, retry_count, retry_class}`, each field sourced from a native recording site (`cost_events` for per-role/per-model cost+tokens via `agentId`/`model`/`heartbeatRunId`; `activity_log`/`issues.status` for accept; `heartbeat_runs` for timing/retries; pi-lens for TDI), idempotent on `runId`.
- **FR-LEARN-3:** The `qds-model-router` can enumerate the **legal arm catalog** (archetype A–F × per-role tier × node-decomposition × guard thresholds × augmentation) for a signature, excluding arms disallowed by the signature's risk tier **and** by the §4.2 structural caps (no >4-agent node is representable; a more-nodes decomposition is mandatory when capacity >4).
- **FR-LEARN-4:** The router can **recommend the Pareto-optimal config** (cheapest tokens at the required quality bar) for a signature by exploiting the current policy.
- **FR-LEARN-5:** A weekly job can **recompute the config-policy** (per-arm cost/quality posteriors + the Pareto frontier per signature) **by querying the native ledger** (not a hot counter), idempotently, caching the result as a versioned policy artifact (`router_config_hash`) that **records `quality_signal_kind`** (true-TDI vs §9.3 proxy) under which it was computed, and writing a human-readable rationale to the manager's `*-meta` Hindsight bank (extends FR-MG-10).
- **FR-LEARN-6:** The router applies **risk-tier- and novelty-gated bounded exploration**: high-risk or novel (>θ) signatures are served exploit-only; otherwise Thompson-sampled exploration is permitted within the configured budget, each draw logged.
- **FR-LEARN-7:** On zero/low data for a signature, the router falls back to the **§7 archetype default** and records the selection as prior-driven (default-pinned until ≥N observations). **Shadow-validated counterfactual estimates (FR-LEARN-11) count toward N**, so the safe offline path — not only live exploration (capped at ≤10%, NFR-SAF-5) — can retire a signature from default-pin; **low-volume long-tail signatures that never reach N remain default-pinned by design** and are bucketed separately in the config-policy-confidence KPI (a labelled "tail (insufficient volume)" bucket, not a silent failure).
- **FR-LEARN-8:** The system can learn **structural (DAG-shape) choices within the §4.2 caps** — archetype, node-count-vs-swarm-size, and split-on-overload — recorded under a tag namespace disjoint from model-tier so structural and tier learning coexist in one `*-meta` bank and one L4 reflect without collision.

*Counterfactual / offline evaluation (§9.4.6):*
- **FR-LEARN-9:** The system can **estimate the savings of an alternative cheaper config** on a past task-shape (`expected_savings`, `P_same_outcome`, `confidence_class`) via k-NN over signatures restricted to runs that used that config — **offline, with zero task re-execution** — returning a `low-confidence` flag on sparse neighbors.
- **FR-LEARN-10:** The system can run a candidate config in **bounded shadow mode** — fresh worktree, **no PR emitted, no production issue/status mutated**, tagged `shadow=true`, costed against a dedicated shadow budget cap.
- **FR-LEARN-11:** The system can **compare a shadow run to the production merged PR** over a tiered oracle (test-pass → diagnostics → reviewer-finding parity → advisory diff-equivalence) and **calibrate the estimator** against observed equivalence (auto-demoting estimates when predicted ≠ observed beyond a bound); no estimate promotes to a recommendation without reviewer-parity + a logged calibration.

*FinOps / token-waste (§9.4.7):*
- **FR-LEARN-12:** The system can compute **cost-per-accepted-PR** and **tokens-per-accepted-PR** over window W from `cost_events` ÷ accepted-PR count (`activity_log`/`issues.status`), with numerator and denominator pinned to the **same cohort** of stories reaching a terminal state within W (work-in-progress excluded at the window boundary).
- **FR-LEARN-13:** The launcher can **set and enforce a per-issue/per-node token budget** allocated by task-shape × archetype (extending the FR-EX-3 guards) and flag a node whose summed `cost_events` tokens exceed its allocation (logged, never silent).
- **FR-LEARN-14:** The system can compute the **natively-capturable token-waste rates** (cache-miss rate from `cachedInputTokens`/`inputTokens`, cost-per-token anomaly) per model/archetype; micro-waste signals (duplicate reads, dead-end coms, grep-vs-graph) are produced only if a node-output cost-lens proves feasible (OQ-9) and are otherwise explicitly deferred, never silently assumed.
- **FR-LEARN-15:** The system can **convert a persistent waste pattern** (over W, above threshold) into exactly one proposed action — tighten a token budget, edit a Mulch/skill prime, or change a router config — recorded in the `*-meta` bank and promoted only by L4 under the §9.4.4 quality-floor gate.

*Knowledge management (native Hindsight ops — §9.4.8):*
- **FR-LEARN-16:** The system can **retain a meta-lesson** (`{archetype, role_tier_map, work_shape, cost, quality, outcome, runId}`) to a `*-meta` bank as an `experience` fact with `document_id = runId` (idempotent upsert) under a `retain_mission` that ignores code-level findings.
- **FR-LEARN-17:** The system can **promote durable meta-lessons** via native `consolidate`→observations + a `qds-router-policy` mental model (`refresh_after_consolidation`, delta mode), gated on `proof_count ≥ 3` and a strengthening/stable freshness trend; an L3-cron **retention sweep** prunes stale raw trials (Hindsight has no native TTL).
- **FR-LEARN-18:** The system can **recall meta-lessons with anti-pollution guards** — strict tag-match + `memory_type` entity-label filter (so meta-recall never returns Layer-A code noise), dedup, and stale-observation exclusion; losing-config outcomes are retained as explicit negative examples.

*Goodhart integrity (§9.4.4):*
- **FR-LEARN-19:** The system can **record a paired counter-metric for every yield KPI** (scope-normalized accept, escaped-defect rate, cost-net-of-rework, test-to-impl ratio, waiver-rate, finding-suppression delta, run-fragmentation, unclassified-restart rate) from native sites, so no KPI is optimized or displayed without its guard.
- **FR-LEARN-20:** The system can **track escaped defects** by linking QA-department (F3) and post-merge fix issues back to the originating story's issue subtree (the un-fakeable quality oracle).
- **FR-LEARN-21:** The system **does not promote any config the policy proposes until it clears a quality floor** (escaped-defect not worse, scope-normalized first-pass-accept not worse, waiver-rate under ceiling) vs the incumbent on a held-out/trailing set; a failing proposal is rejected with a logged reason. The gate **re-scores arms against *realized* escaped-defect (FR-LEARN-20) once their windows close** (not just the trailing proxy), and **refuses cross-signal promotion** — a proxy-`quality_signal_kind` arm cannot replace a true-TDI incumbent without re-validation (M2 audit-gap closure).
- **FR-LEARN-22:** Under the §9.3 TDI-proxy path, the system can run a **proxy-divergence check** (proxy vs escaped-defect rate) and raise a "proxy decoupled" alert so the optimizer is not fed a gamed signal.

*Measurement & causality (§9.4.9):*
- **FR-LEARN-23:** The system can run and label a **baseline epoch** (first B≥10 stories under a frozen learning policy — recall off, router pinned, L1 safety on) and stamp every per-story KPI record with `policy_epoch`, `router_config_hash`, `recall_enabled`, and `tdi_signal_kind`.
- **FR-LEARN-24:** The system can compute a **difficulty_index** (anchored to post-merge *realized* difficulty where available, not intake estimate alone) and emit **difficulty-normalized** variants of each KPI alongside the raw KPI, raising a **difficulty-inflation alert** when intake-estimated difficulty systematically exceeds realized (anti-gaming guard, §9.4.9).
- **FR-LEARN-25:** The system can compute **trend significance** (Mann-Kendall τ, two-sided p + CUSUM changepoint) on each normalized KPI and render an **"insufficient data" state** (with N, p, CI) until N ≥ N_min and p < 0.10.
- **FR-LEARN-26:** The system can inject a **frozen-policy ablation story** every K merged stories and compute the attributable effect (treated-vs-ablation difference-in-medians, bootstrap CI) — single-arm-safe, explicitly not A/B-at-scale (NG4).

*Inspection / control (audit-chain extension):*
- **FR-LEARN-27:** An operator can **inspect the policy state behind any served arm** (signature, candidate arms, expected reward, explore/exploit flag — persisted alongside the `heartbeat_run`, feeding the §8 audit chain) and **pin or veto** an arm for a signature (logged override).

---

## 7. In-Node Swarm Composition (consistency-first reference)

**Core principle:** variance is the enemy. Consistency comes from **contract-first + mandatory test-first (TDD) + a single lead that owns the merge** — not from agent count or code-area splits. Area-splits (frontend/backend) drift at the seam; only a *frozen contract* makes them safe.

**Archetypes** (the `qds-model-router` picks one per node by work shape; each carries a *router selection signal* — the testable work-shape trigger — and the `FR-EX` it satisfies):

- **A — Solo (1):** light/deterministic nodes (plan, single review, trivial fix). Variance floor.
  - *Router selection signal:* node is plan/review-only, or diff estimate is trivial (single file, no new contract, no test surface). Satisfies FR-EX-7 (Solo); FR-EX-4 gate still applies.
- **B — Pair / Maker+Checker (2):** one implements, one adversarially reviews vs AC + clears pi-lens findings. Lead = maker.
  - *Router selection signal:* small bounded change with real AC to verify but no separable surfaces and no new public contract. Satisfies FR-EX-7 (Pair); FR-EX-2/FR-EX-4.
- **C — TDD Trio (3) — Dev default floor for non-trivial:** (1) Architect/Test (Opus) freezes the contract (types/interfaces) + writes failing tests; (2) Implementer (cheap GLM/Sonnet via openrouter) makes tests green, minimal diff — cheap is safe because tests constrain it; (3) Reviewer/Adversary (Opus) breaks it (edge cases, pi-lens security, AC compliance). Lead = Architect, owns merge + structured emit.
  - *Router selection signal:* default for any non-trivial Dev node — new/changed logic with a definable contract and test surface, single coherent surface. This is the floor unless the node qualifies for A/B (smaller) or D (separable). Satisfies FR-EX-7 (TDD-Trio default), FR-EX-2, FR-EX-4, FR-EX-6.
- **D — Contract-split Quad (4) — ONLY for separable surfaces (fe+be+migration):** Lead/Integrator freezes API contract + schema + integration test first; Backend→contract; Frontend→contract; Reviewer = integration + adversary. Hard cap 4.
  - *Router selection signal:* work spans ≥2 independently-buildable surfaces behind one freezable contract (e.g., frontend + backend + migration); never chosen merely to add capacity. Satisfies FR-EX-7 (Quad), FR-EX-2, FR-EX-6; bounded by NFR-PERF-1.
- **E — QA Hunter Pack (2–3):** split by failure-mode LENS not area — regression-hunter (diff-focused) · edge/boundary-hunter · security/data-integrity-hunter (pi-lens-driven). Orthogonal lenses → different bug classes.
  - *Router selection signal:* node is a QA/post-merge hunting pass (no production diff authored) over a merged change. Satisfies FR-EX-7 (Hunter-Pack), FR-EX-4; feeds FR-MEM-3.
- **F — Maintenance:** Solo (mechanical sweep + pi-lens) or Pair (risky/high-blast-radius refactor).
  - *Router selection signal:* scheduled/sweep node (dep bump, mechanical refactor, hotspot) — Solo when blast radius is low, Pair when high. Satisfies FR-EX-7 (Maintenance); triggered via FR-CP-13.

**Dominating rule:** prefer more DAG nodes over bigger swarms (coms is P2P with n² paths and `MAX_HOPS=5`; cap ~4 — NFR-PERF-1/2). Need 6 agents of capacity → 2 deterministic nodes of 3, never 1 node of 6.

**Consistency wrappers on every archetype:** mandatory test-first · pi-lens gate per agent (secrets/lint/security/TDI floor) · **post-edit LSP `lsp_diagnostics` gate** (0 errors on the node's changed-file union before emit, FR-EX-11; ast-grep+tests fallback FR-EX-12) · live LSP nav for signatures/refs (FR-EX-10) · `response_schema` on every coms handoff · Mulch-primed prompts · graph-aware context (pi-gitnexus-plus: call chains + blast radius auto-appended on reads for judgment roles — Architect/Reviewer; the constrained Implementer augments on-demand to bound token tax — so contract-freezing and edge-case hunting see the real execution graph, not a grep guess) · model tiering (Opus for judgment roles, cheap for constrained Implementer) · hard budget/turn/tilldone/coms_await guards. The `qds-model-router` selects (a) archetype, (b) per-role tier, (c) escalation on retry spikes — and its choices are scored into the `*-meta` banks (loop L4, via FR-MG-10).

---

## 8. Accountability Model (the differentiator)

### 8.1 The single audit chain

Every PR must be reconstructable end-to-end:

```
epic
 └─ Seeds stories + dependency edges            (.seeds/issues.jsonl — git, travels w/ repo)
     └─ Paperclip issues (assigneeAgentId, status, parentId, executionPolicy)
         ├─ cost_events ledger (costCents per issue)        [Δ ledger, not issue.cost]
         ├─ approvals + issue_execution_decisions (logged human/gate decisions)
         └─ heartbeat_runs (per-run execution trace)
             └─ Archon run (SSE log, worktree)
                 └─ Pi team (agent names, models, coms message log)
                     └─ pi-lens (TDI delta, warnings w/ stable IDs)
                         └─ Hindsight (what was learned, retained to bank)
```

### 8.2 Invariants

- **No anonymity:** every actor (manager + worker) is a Paperclip agent row with `reportsTo` resolving to the root agent. No work is attributable to an anonymous or orphan actor.
- **Everything costed:** every run's spend lands in a `cost_events` ledger row whose `issueId` FK links it to the issue it served (Paperclip `cost_events.issueId` `:15`, `costCents` `:27`). There is **no `cost` column on the issue** — cost is a one-to-many ledger, and per-issue cost is the SUM over its `cost_events`. Those sums roll up to `agents.spentMonthlyCents` (`agents.ts:31`) and `companies.spentMonthlyCents` (`companies.ts:15`), each checked against its `budgetMonthlyCents` cap.
- **Every decision logged:** every human approval is persisted in `approvals` (status / payload / decisionNote / decidedByUserId / decidedAt), and every execution-gate decision in `issue_execution_decisions`. No gate is resolved off-ledger.
- **Every PR traceable:** given a PR, an operator can walk §8.1 from the memory-bank entry back to the originating epic with no missing hop (the §8.4 contract makes the walk mechanical).

### 8.3 The cost hop (precise)

Cost is the one hop most easily faked into an `issue.cost` field; it is not one. The contract is:

1. Each agent run (manager loop, Archon node, Pi worker, pi-lens pass) that incurs LLM/tool spend **writes one or more `cost_events` rows**, each carrying `costCents` and the `issueId` FK to the issue it served. **[Δ column inventory — verified on disk 2026-06-05, `cost_events.ts:12-29`]** Beyond `costCents`+`issueId`, each row also carries `agentId` (FK→agents), `model`, `provider`, `biller`, `billingType`, `heartbeatRunId` (FK→heartbeat_runs), and token counts `inputTokens`/`cachedInputTokens`/`outputTokens`. Because every worker is a Paperclip agent row (§8.2 no-anonymity), `agentId` yields **per-role** attribution, `model` **per-model**, and `heartbeatRunId` **per-run** — so per-role/per-model/per-run cost and token attribution is **native**, the load-bearing enabler for the Layer-B outcome vector (FR-LEARN-2) and the FinOps KPIs (§9.4.7). *(The residual question is whether Pi-subprocess spend auto-writes its own rows vs the launcher emitting them — OQ-8.)*
2. **Per-issue cost** = `SELECT SUM(cost_events.costCents) WHERE issueId = :id`. **Per-issue-tree cost** (a story/epic) = the same SUM over the issue's `parentId` subtree.
3. The same events **roll up** to `agents.spentMonthlyCents` and `companies.spentMonthlyCents`. An over-cap condition (rolled-up spend ≥ `budgetMonthlyCents`) must gate/halt, never silently overrun (see NFR-COST-1).
4. Reconciliation is **continuous** — cost is queryable at any instant from the ledger, not a month-end batch (NFR-COST-2).

### 8.4 Audit-chain query contract

For a given PR, an operator reconstructs lineage by walking exactly these records/joins. Each step names the record and the key it joins on; every step is a single indexed lookup or a bounded fan-out.

| # | From → To | Join key | Record / source |
|---|---|---|---|
| 1 | **PR → Archon run** | PR branch/worktree id ↔ run id (run log header) | Archon SSE run log + worktree metadata |
| 2 | **Archon run → issue** | `issues.executionRunId` / `issues.checkoutRunId` (`issues.ts:37-38`) ↔ `heartbeat_runs.id` | Paperclip `issues`, `heartbeat_runs` (`heartbeat_runs.ts:6-82`) |
| 3 | **issue → its run trace(s)** | `heartbeat_runs` FK via the run-id columns above | Paperclip `heartbeat_runs` |
| 4 | **issue → assignee (actor)** | `issues.assigneeAgentId` (`issues.ts:35`) → `agents.id` | Paperclip `agents` (+ `reportsTo` `:24` walked to root for the org-chain) |
| 5 | **issue → cost** | `cost_events.issueId` (`:15`) = issue id; SUM `costCents` (`:27`) | Paperclip `cost_events` ledger |
| 6 | **issue → decisions** | `approvals.issueId` and `issue_execution_decisions.issueId` | Paperclip `approvals` (`approvals.ts:5-28`), `issue_execution_decisions` |
| 7 | **issue → decomposition parent/children** | `issues.parentId` (`:29`) up to the epic; Seeds `blocks[]`/`blockedBy[]` for sibling deps | Paperclip `issues` + `.seeds/issues.jsonl` |
| 8 | **run → Pi team** | run id ↔ launcher invocation; agent names/models/coms log captured in node output | Archon node output + `pi-team-launch.sh` log + `~/.pi/coms/` registry |
| 9 | **Pi team → pi-lens findings** | per-agent turn-end report (stable finding IDs + TDI) | pi-lens report attached to node output |
| 10 | **run → memory** | bank id = `{repo}` / `{repo}-<dept>-meta`; `document_id` = Paperclip `runId` (per the Hindsight Paperclip plugin's `agent.run.finished` hook) | Hindsight bank, document keyed by run id |

**Reconstruction guarantee:** steps 2–7 are all keyed on the Paperclip issue id, so once step 2 resolves the run→issue join, the remaining hops are direct FK lookups. Step 10's `document_id == runId` linkage is what makes the memory hop non-anonymous (it is the Paperclip plugin's documented behavior, changelog v0.2.0). Reconstruction latency is bounded by NFR-OBS-4.

### 8.5 Acceptance (Section 13, Phase-1 gate)

The Phase-1 exit gate requires that, for one real PR, the full §8.4 walk completes with no missing hop and per-issue spend (SUM of `cost_events`) is shown within budget.

---

## 9. Self-Improvement Model (the yield curve)

> **Hindsight API grounding (verified against `hindsight-docs` skill, 2026-06-05):** The memory verbs `retain` / `recall` / `reflect` are **SDK methods**; over HTTP they map to bank-scoped endpoints under `/v1/default/banks/{bank_id}/…` (retain = `POST …/memories`; recall = `POST …/recall`; reflect = `POST …/reflect`). Recall runs **four strategies in parallel — semantic, BM25 keyword, graph traversal, temporal — fused with Reciprocal Rank Fusion + a cross-encoder reranker** (recall.md). The nightly L3 loop's "consolidate" and "mental-model refresh" are **real first-class operations**, not invented: `POST …/consolidate` produces **observations** (deduplicated, evidence-grounded beliefs), and `POST …/mental-models/{id}/refresh` re-runs a mental model's `source_query` (operations.md: `consolidation`, `refresh_mental_model`; mental-models.md). Mental models can auto-refresh via `trigger.refresh_after_consolidation`. **Auth:** server API auth is an **optional bearer token** (SDK `api_key`; control-plane→API uses `HINDSIGHT_CP_DATAPLANE_API_KEY` as `Authorization: Bearer`). `HINDSIGHT_API_LLM_API_KEY` is the **LLM-provider** key, not server auth — the two must not be conflated. **Self-host vs cloud:** the API surface is identical; only `base_url` (`api.hindsight.vectorize.io` vs local `http://…:8888`) and whether a bearer token is required differ — so OQ-4 is a deployment decision, **not** an API-shape decision.

### 9.1 Five nested loops

Each loop names its **trigger**, **data source**, and **write target** so it is implementable and auditable.

| Loop | Trigger | Data source | Write target | Effect |
|---|---|---|---|---|
| **L1 — per-run** | event: each Pi worker turn (`agent_end`) | the diff under edit + pi-lens scan + **LSP `lsp_diagnostics`** (or ast-grep+tests fallback, FR-EX-12) | in-run autofix applied to the worktree; finding emitted in turn-end report | fewer in-run defects (read-before-edit guard + autofix + post-edit diagnostics gate) |
| **L2 — per-story** | event: Archon run start (`agent.run.started`) → recall; run finish (`agent.run.finished`) → retain | shared per-repo bank `{repo}` (recall by issue title+desc); run output (retain) | recall result injected into the implement node's system prompt; run output **retained** with `document_id = runId` | a QA bug reaches Dev's **next** implement via the shared bank |
| **L3 — nightly** | cron: Paperclip routine (`routine_triggers.cron_expression`) | per-bank world/experience memories accumulated that day + Mulch session records | `POST …/consolidate` → **observations**; then `POST …/mental-models/{id}/refresh` (or `trigger.refresh_after_consolidation`) → refreshed mental model | "mental-model refresh": durable beliefs + curated house-style summaries kept current |
| **L4 — weekly** | cron: Paperclip routine | per-manager `*-meta` banks (`{repo}-dev-meta` / `-qa-meta` / `-maint-meta`) — router decisions scored by cost/quality | `qds-model-router` config (archetype + per-role tier + escalation thresholds) + skill updates | tune which model tier won on cost/quality; evolve skills |
| **L5 — measured** | cron: dashboard refresh (NFR-OBS-4 cadence) | Paperclip `cost_events` + issue status transitions + `heartbeat_runs` + pi-lens TDI series | the four KPI series rendered on the dashboard | the **proof** — the yield curve |

**Authority note (L3/L4 writes):** consolidation and mental-model refresh are **bank-deduped** server-side (operations.md) — concurrent nightly triggers against the same bank coalesce into one job, so the cron routine may fire idempotently without stacking.

### 9.2 KPI definitions, formulas & recording sites

All KPIs are computed over a rolling window **W** (default W = last 20 merged stories; configurable). Formulas are precise enough to implement directly.

| KPI | Formula (over window W) | Recorded from | Target dir. |
|---|---|---|---|
| **TDI trend** | `TDI_story = mean(pi-lens TDI across the story's nodes)`; trend = slope of `TDI_story` regressed over the last W stories (negative = improving) | pi-lens turn-end report → retained to bank → series read by dashboard | ↓ |
| **Cost/story** | `cost_story = SUM(cost_events.costCents WHERE issueId ∈ story.subtree)`; KPI = `mean(cost_story)` over W | Paperclip `cost_events` ledger (§8.3) | ↓ |
| **First-pass PR-accept** | `first_pass = merged_without_fix_loop / total_merged` over W, where *merged-without-fix-loop* = a story whose issue reached `merged` with **zero** fix-loop iterations (no `fix-feedback` re-entry / no reopened review) per its status-transition history | Paperclip issue status transitions (`issues.status` `:32`) | ↑ |
| **Retry count** | `retries_story = count(restart events)` classified transient/overflow/logic; KPI = `mean(retries_story)` over W | manager restart-policy log → `heartbeat_runs` | ↓ |

Recording sites are the same records the §8.4 audit walk uses, so KPIs are always reconcilable against lineage.

### 9.3 Headless-TDI dependency & explicit logged fallback

L1, L4, and L5's TDI axis all depend on **pi-lens emitting machine-readable TDI in headless mode** (§5.4 ⚠️, OQ-2). This is unverifiable until pi-lens is installed and run (`--mode json`, then `--mode rpc`).

**Explicit, logged fallback (not a silent gap):** if the Phase-0 spike shows TDI is TUI-only, L5's TDI axis falls back to a **proxy metric = pi-lens warning count per node** (via `--mode rpc`), and the dashboard renders the proxy **labelled as a proxy** until upstream headless-TDI support lands. The fallback decision, its trigger spike result, and the date it was taken are **recorded in the OQ-2 decision log** (§12). The KPI table's TDI row is annotated with which signal (true TDI vs proxy) is currently feeding it, so no consumer mistakes a proxy for the real index. The post-edit LSP diagnostics gate (FR-EX-11) shares this exact headless-emission dependency: under a TUI-only outcome it degrades to pi-lens ast-grep + test-pass (FR-EX-12), logged identically as a waiver (NFR-SAF-4).

### 9.4 Factory self-optimization model (Layer-B meta-learning)

§9.1–§9.3 cover **Layer-A** learning — the factory getting better at *the code it writes* (in-run defects, cross-story bug transfer, house-style). This subsection adds **Layer-B**: the factory getting better at *its own process and configuration*, independent of any one app's code. The operator's thesis, made mechanical: *"for this type of task, this configuration gives similar quality for far cheaper token usage"* — so the factory must learn an empirical **policy over (task-shape → configuration → outcome)** and recommend the **Pareto-optimal** config (cheapest tokens at the required quality bar) per incoming unit of work, improving that recommendation as evidence accrues. Layer-B is an **expansion of loop L4** plus one new offline loop; it does not replace L1–L5.

#### 9.4.0 Design principles (native-first, token-frugal) — non-negotiable

The learning machinery must not become the cost it is meant to cut. Two binding principles, grounded in what is already on disk (§5.3 Paperclip schema re-read 2026-06-05; §9 Hindsight grounding):

1. **Native-first — reuse the control plane, don't rebuild it.** The (task-shape → config → outcome) record is *derived*, not net-new ground truth. **Paperclip `cost_events` already carries `agentId`, `model`, `provider`, `heartbeatRunId`, and `inputTokens`/`cachedInputTokens`/`outputTokens` per row** (verified on disk — see the §8.3 [Δ] note) — so **per-role, per-model, per-run cost and token attribution is native** (every worker is a Paperclip agent row, §8.2 no-anonymity, so `agentId` = role — pending OQ-8 confirmation that Pi-subprocess spend writes its own per-agent rows; otherwise the launcher emits them). `activity_log` (`action`/`entityType`/`entityId`/`runId`/`details`) is the native status-transition + linkage log. `heartbeat_runs` gives timing. Hindsight gives `consolidate`→observations, `mental-models` refresh, 4-strategy recall, and `document_id` upsert. Learning is wired to these via Paperclip cron `routines` (FR-CP-8/13) and the Hindsight-plugin event hooks (`agent.run.started`→recall, `agent.run.finished`→retain, §5.3). The **only genuinely new persistence** is a small policy artifact (OQ-7) and — *if and only if* a spike proves it necessary — micro-waste telemetry (OQ-9); everything else is a query over native tables.
2. **Token-frugal — learning rides offline cron, not the critical path.** The per-run learning tax is exactly **one bounded recall** (already governed by NFR-PERF-4: ≤2 s p95, proceed-unprimed-on-timeout) plus an **event-driven retain** that costs no extra LLM call (the Hindsight plugin extracts from the run that already happened). All heavy computation — policy recompute, consolidation, counterfactual estimation, KPI inference — runs on the **nightly (L3) and weekly (L4) Paperclip cron**, off the critical path, against the native ledger. The policy is **recomputed from the ledger, not maintained as a hot per-run counter** — so a story never pays for bookkeeping. This is enforced by a hard ceiling on learning-attributable spend (NFR-COST-3) and a learning-overhead KPI (§9.4.7).

#### 9.4.1 The policy object (contextual bandit, single-arm, NG4-safe)

Config selection is framed as a **contextual bandit**, not reinforcement learning: one task → one config → one terminal outcome. No multi-step credit assignment, no policy network. The object is a learned mapping `π: task-shape signature → config`, exploiting accumulated `(signature, config, outcome)` evidence and exploring sparingly. This is **single-arm online learning + offline counterfactual evaluation + bounded exploration** — explicitly in scope; full A/B-at-scale stays deferred (NG4).

- **Task-shape signature (FR-LEARN-1):** a low-cardinality feature vector computed at intake from signals the factory already produces — Seeds `type`/`priority`/`labels`; diff-size estimate; new-contract and test-surface flags (the §7 router selection signals); changed-file language(s); GitNexus blast-radius bucket (`gitnexus_impact`, §4.5); and **risk tier** (derived from `executionPolicy`, FR-CP-5). Bucketed/hashed so structurally-similar tasks share a signature cell. This single signature also serves difficulty-normalization (§9.4.6) and novelty scoring (§9.4.5) — computed once, reused.
- **Configuration space (arms) (FR-LEARN-3):** the cross-product of §7 archetype (A–F) × per-role model tier (Opus / Sonnet / GLM / Kimi via OpenRouter) × node-decomposition (more-nodes-vs-bigger-swarm, §4.2) × guard thresholds × graph-augmentation mode. The full product is intractable and mostly illegal; the router enumerates a **legal arm catalog per signature**, pruned by two hard constraints: (a) the signature's **risk tier** (high-risk forbids cheap-Implementer arms), and (b) the **§4.2 structural caps** — *no arm with >4 agents/node is representable* (NFR-PERF-1), and whenever required capacity >4 the catalog *must* contain a more-nodes decomposition and *no* single-oversized-node option (NFR-PERF-2). The factory therefore cannot "learn its way" to an illegal swarm.
- **Outcome vector (FR-LEARN-2):** per run, `{first_pass_accept, TDI_delta, review_finding_count, test_pass, cost_cents, input/output/cached_tokens, wall_clock_ms, retry_count, retry_class}` — every field read from a native recording site (`cost_events` for cost/tokens/model/role; `activity_log`/`issues.status` for accept; `heartbeat_runs` for timing/retries; pi-lens for TDI). Recorded idempotently on `runId` (NFR-REL-4).
- **Reward = Pareto objective.** `reward = −cost_story` **subject to a hard quality constraint**: a run that fails **scope-normalized** first-pass-accept (raw accept normalized by story complexity, so trivial-scoping cannot game it — §9.4.4), emits under an un-waived dirty-diagnostics waiver (NFR-SAF-4), or breaches the TDI floor scores `reward = −∞` (constrained bandit). The policy therefore **cannot learn to buy cheapness with defects** — this is the primary Goodhart guard (§9.4.4). Under the OQ-2 proxy path the constraint binds on the headless-available signals (scope-normalized accept + un-waived diagnostics — both kept **hard**, never softened) with TDI folded in as a soft term until headless-TDI lands. **The per-run reward is *provisional*** — escaped defects surface post-merge, often after the run's window; so a closed-window **realized re-score against escaped-defect** (FR-LEARN-20) supersedes the provisional reward at the L6 recompute, and an arm cannot leave default-pin (FR-LEARN-7) for a signature until at least one of its runs has a *closed* escaped-defect window. This prevents an arm being credited before ground truth exists.

#### 9.4.2 Where the policy lives (recompute-from-ledger, not a hot counter)

Grounded against `hindsight-docs`: a Hindsight bank stores natural-language memories/observations/mental-models retrieved by RRF recall — it has **no atomic numeric-increment or Pareto-query primitive**. So the policy's *numbers* cannot live in a bank, and forcing them there would corrupt the statistics (R26). But maintaining a hot per-run counter table violates the token-frugal principle and adds write-path surface. The resolution, native-first:

- **Numbers are recomputed weekly from the native ledger.** The L4 cron derives per-`(signature, arm)` cost/quality statistics and the Pareto frontier **by querying `cost_events` + `activity_log` + `heartbeat_runs` + the pi-lens series** — the same records the §8.4 audit walk uses — and caches the result as a **compact, versioned policy artifact** (`router_config_hash`). No per-run counter is maintained; the ledger *is* the source of truth (FR-LEARN-5). Whether that artifact is a small additive Paperclip table or a cached file is OQ-7.
- **Reasons live in Hindsight.** The *rationale* ("the GLM-Implementer arm regressed on auth-touching diffs") is retained to the per-manager `*-meta` banks as observations and surfaced via a `qds-router-policy` mental model (FR-LEARN-16/17). **Numbers in the ledger; reasons in Hindsight** — each store used for its strength.

#### 9.4.3 Exploration policy (risk-tier-gated, bounded)

- **Hard gate:** a **high-risk-tier** issue (and any issue whose task-shape novelty exceeds θ, §9.4.5) is served **exploit-only** (argmax) — *no exploration ever* (FR-LEARN-6, NFR-SAF-5). High-risk carries an `executionPolicy` gate (FR-CP-5) and produces a reviewed PR, never an auto-merge (R9), so exploration is confined to where a wrong-but-cheap choice is cheap to catch.
- **Mechanism:** for risk-low/medium, **Thompson sampling** over a conjugate posterior per arm (graceful cold-start + non-stationarity, no epsilon to tune), capped by a **global exploration budget ≤10% of eligible runs** over a rolling 7-day window (NFR-SAF-5). Every exploration draw is logged so its outcome is attributable.

#### 9.4.4 Goodhart guardrails (proxies bolted to ground truth)

Self-optimization toward any proxy invites gaming; the defense is that **proxies can be faked but the post-merge QA department (F3, §3.2) cannot** — a defect QA finds in a *merged* diff is an *escaped defect*, the master counter-signal the proxies cannot reach.

- **Paired counter-metrics (FR-LEARN-19):** every yield KPI is recorded with a guard metric that moves the wrong way under gaming — first-pass-accept ↔ scope-normalized accept + escaped-defect rate; cost ↔ cost-per-accepted-PR-net-of-rework + test-to-impl ratio; TDI ↔ waiver-rate + finding-suppression delta; retry-count ↔ run-fragmentation + unclassified-restart rate. No KPI is optimized or displayed without its pair (NFR-OBS-6).
- **Escaped-defect ground truth (FR-LEARN-20):** QA-filed and post-merge fix issues link back to the originating story's issue subtree (via the native `activity_log` `runId`/`entityId` and the §8.4 PR→run→issue joins; the exact FK is OQ-10), giving an un-fakeable quality oracle. *Note: the yield curve is **not Goodhart-safe until Phase-2 QA is live** — a sequencing caveat recorded in §10/§14.*
- **Quality-floor gate on promotion (FR-LEARN-21, NFR-SAF-6):** the L4 loop may *propose* a config, but **no config is promoted** until it clears a quality floor on a held-out/trailing set — escaped-defect rate not worse, scope-normalized first-pass-accept not worse, waiver-rate under its ceiling — vs the incumbent. A failing proposal is rejected with a logged reason and the incumbent retained. Optimization cannot trade real quality for proxy wins.
- **Waiver-rate ceiling + concentration (NFR-SAF-6):** logged diagnostics/gate waivers (FR-EX-12/NFR-SAF-4) ≤5% of nodes emitted over W; a breach **auto-freezes L4 promotion** until investigated — closing the "waiver-laundering" attack (R19). To close the subtler **waiver-*seeking*** attack (an arm preferring languages/decompositions that *legitimately* trigger waivers, weakening the gate without ever exceeding the ceiling), the waiver-rate is paired with a **per-arm/per-signature waiver-concentration** counter-metric, and **escaped-defect-rate-conditional-on-waiver** feeds the quality floor — so an arm that waives often *and* escapes defects often is penalized even when each individual waiver was justified.
- **Proxy-integrity (FR-LEARN-22):** under the §9.3 TDI-proxy path, a continuous proxy-divergence check (correlation of warning-count proxy vs escaped-defect rate) raises a "proxy decoupled" alert so the optimizer is never fed a gamed signal (R17).

#### 9.4.5 Cold-start, novelty & distribution-shift

- **Cold-start (FR-LEARN-7):** with no data for a signature, the policy falls back to the **§7 archetype default** (TDD-Trio floor for non-trivial Dev; Solo for trivial), seeded as an informative prior (~3 pseudo-successes on the default arm). The selection is recorded as **prior-driven, not data-driven**; a signature stays default-pinned until it has ≥N (default 10) real observations.
- **Novelty / distribution-shift (FR-LEARN-6, R16):** a novelty score = distance of the incoming signature from the L4 training distribution. Novel shapes (>θ) disable exploration and fall back to the conservative Trio floor — the router cannot ship a confidently-cheap config for work it has barely seen.

#### 9.4.6 Counterfactual / offline evaluation (the safe path to "cheaper")

The cheapest, safest route to "same quality for less" is to estimate it from history **without re-running**.

- **Estimator (FR-LEARN-9, NFR-PERF-8):** given a past task-shape and a candidate cheaper config, estimate `(expected_savings, P_same_outcome, confidence_class)` via **k-NN over task-shape signatures restricted to runs that actually used the candidate config** (a matched-historical / direct-method estimate over the native ledger). Sparse-neighbor estimates are returned **`confidence=low`** and **never promoted** (NFR-PERF-8). Purely offline: 0 task re-executions, ≤2 s p95.
- **Bounded shadow replay (FR-LEARN-10):** an estimate is validated by running the candidate config in **shadow** on a real, already-merged task — **fresh worktree, no PR emitted, no production issue/status mutated**, tagged `shadow=true` end-to-end, **costed against a dedicated shadow budget cap** (≤4% of factory spend over W — a strict sub-cap within the §9.4.7 learning-overhead envelope — and ≤N/day; NFR-PERF-8). Calibration cannot blow the budget or touch production.
- **Equivalence + calibration (FR-LEARN-11):** the shadow output is compared to the production merged PR over a tiered oracle — test-pass parity → `lsp_diagnostics` parity → reviewer-finding parity (QA-Hunter lens, §7-E) → advisory diff-equivalence — and the estimator is calibrated against observed equivalence (predicted vs actual within a bound, else estimates auto-demote to low-confidence). Reviewer-parity is mandatory before any estimate promotes; diff-equivalence is advisory only.
- **Feed:** the per-(shape, config) savings table feeds the policy recommendation (§9.4.1) and a **counterfactual-headroom** series feeds the yield curve (§9.4.7), labelled estimate-vs-shadow-validated.

#### 9.4.7 FinOps, token-waste & the learning-overhead budget

- **North-star — cost-per-accepted-PR (FR-LEARN-12):** `SUM(cost_events.costCents over all stories' issue-trees in W) / count(accepted PRs in W)`, where *accepted* = parent issue reached `merged`/`done` with zero fix-loop re-entry (same definition as first-pass-accept, §9.2). Rejected/retried work inflates the numerator without moving the denominator, exposing waste that cost/story hides. Native sites: `cost_events` ÷ `activity_log` status transitions.
- **Token budget per task-shape × archetype (FR-LEARN-13):** the launcher (extending the FR-EX-3 guards) sets and enforces a per-issue/per-node token budget keyed on the router's task-shape × archetype, reconciled post-hoc against the summed `cost_events` tokens for that node's `heartbeatRunId`; over-budget is a logged FinOps event, never silent.
- **Token-waste detection (FR-LEARN-14):** two classes are **capturable natively today** — cache-miss rate (`1 − Σ cachedInputTokens / Σ inputTokens`) and cost-per-token anomaly, both per model/archetype from `cost_events`. Four micro-waste signals (duplicate file reads, oversized prompts, dead-end `coms_send`, grep-where-graph/LSP-answers) live only in the Pi worker tool-call stream inside the bash-node subprocess and are **not in any queryable Paperclip table** — they require a new node-output cost-lens, which is **deferred behind a feasibility spike (OQ-9)** rather than asserted; until then only the capturable rates render, labelled as such (§9.3 logged-fallback pattern).
- **Waste → action (FR-LEARN-15):** a persistent waste pattern converts to exactly one of {tighten the FR-LEARN-13 budget, edit a Mulch/skill prime, change a `qds-model-router` config}, proposed into the `*-meta` bank and owned by the existing L4 loop (FR-MG-10). FinOps proposes; L4 promotes (under the §9.4.4 quality-floor gate).
- **Learning-overhead budget (NFR-COST-3 / KPI below) — directly answers "don't be a token hog":** learning-attributable spend (recall priming + shadow runs + the cron consolidate/reflect/recompute jobs) is itself ledgered in `cost_events` and **capped as a fraction of total factory spend**, and the realized savings it produces are tracked against it. If learning ever costs more than it saves over W, it is throttled (R21).

#### 9.4.8 Knowledge management for the meta layer (native Hindsight ops)

- **Meta-lesson schema (FR-LEARN-16):** a process-outcome retained to a `*-meta` bank as an `experience` fact carrying `{node_archetype, role_tier_map, work_shape_signal, cost_cents, quality_signal, outcome(won/lost vs alternative), runId}`, with `document_id = runId` (idempotent upsert, NFR-REL-4) and a descriptive `context`. A distinct `retain_mission` keeps `*-meta` extracting config/economics decisions and *ignoring* code-level findings, so it never pollutes the Layer-A `{repo}` bank.
- **Decay/promotion = native consolidate + observations + mental-model refresh (FR-LEARN-17):** nightly `POST …/consolidate` produces **observations** carrying a `proof_count` and an evidence-driven freshness trend (new/strengthening/stable/weakening/stale); a `qds-router-policy` **mental model** (`source_query` over the meta-bank, `trigger.refresh_after_consolidation`, `mode:delta`) is what L4 reads to propose tuning. The freshness trend *is* the decay signal — no bespoke decay engine. **Hindsight has no native age-based TTL** (verified via `hindsight-docs`); age-based pruning of stale raw trials is therefore an explicit client-side **retention sweep on the L3 cron** (OQ-15), not an assumed API.
- **Anti-pollution (FR-LEARN-18, NFR-REL-4):** (a) **evidence floor** — no config change promoted from a raw fact; only from an observation with `proof_count ≥ 3` and trend ∈ {strengthening, stable}; (b) **strict recall** — `tags_match=all_strict` + a `memory_type` entity-label filter so meta-recall never returns Layer-A code noise; (c) **dedup** — bank-deduped consolidation + `document_id` upsert; (d) **negative examples retained** explicitly so contradiction reconciliation evolves a belief instead of oscillating.
- **Scoping & transfer:** code lessons stay per-repo (`{repo}`); repo-specific economics stay per-manager (`{repo}-*-meta`). A **global `factory-meta` bank** for repo-independent process-lessons is **scaffolded but deferred to the multi-repo phase (NG1)** — at single-repo there is no second corpus to corroborate transfer (OQ-14); promotion into it would require ≥2-repo corroboration.

#### 9.4.9 Measurement, attribution & a defensible yield curve

The §9.2 curve as specified (raw OLS slope over W=20, no significance/baseline/difficulty control) is a vanity chart waiting to happen. Layer-B makes it defensible:

- **Baseline epoch (FR-LEARN-23):** the first B≥10 merged stories run under a **frozen learning policy** (L2 recall disabled, L4 router pinned to a recorded `router_config_hash`; L1 safety autofix still on), labelled `policy_epoch=baseline` — the control arm.
- **Difficulty normalization (FR-LEARN-24):** a `difficulty_index` normalizes each KPI (`cost_per_difficulty`, etc.), so "improvement" must survive difficulty control; raw and normalized both render. **Anti-inflation guard:** because the factory's own decomposition influences the intake signals (diff estimate, blast-radius bucket), an optimizer could inflate the denominator to fake improvement; therefore `difficulty_index` is **anchored to post-merge *realized* difficulty** (actual merged diff size, actual GitNexus blast radius) wherever available, not the intake estimate alone, and a **difficulty-inflation alert** fires when intake-estimated difficulty systematically exceeds realized (OQ-13).
- **Signal vs drift at small N (FR-LEARN-25, NFR-OBS-6):** replace slope-sign with a **Mann-Kendall** trend test (τ, two-sided p; robust at N≈20) + a **CUSUM/changepoint** flag, on the normalized series. No trend verdict renders unless N≥N_min (default 12) **and** p<0.10; below N_min the panel shows an explicit **"insufficient data (N/N_min)"** state with N, p, and a bootstrap CI on every claim.
- **Attribution without A/B (FR-LEARN-26):** every K stories (default 10) one **ablation story** runs under the frozen baseline policy; the treated-vs-ablation gap (difference-in-medians, bootstrap CI) is the attributable effect. This is **single-arm-safe** — interleaved control runs in one production stream, *no story split across policies and no concurrent competing arms* — and is the explicit line vs NG4 (full A/B-at-scale stays roadmap). Affordability at low story volume is OQ-12.

#### 9.4.10 The two new loops (expansion of L4 + one offline loop)

| Loop | Trigger | Data source (native) | Write target | Effect |
|---|---|---|---|---|
| **L6 — config-policy (meta)** | cron: weekly L4 Paperclip routine (idempotent, bank-deduped) | `cost_events` (per-role/model/run via `agentId`/`model`/`heartbeatRunId`) + `activity_log` + `heartbeat_runs` + pi-lens series + `*-meta` observations | recomputed Pareto policy artifact (`router_config_hash`, §9.4.2) **gated by the quality floor** (FR-LEARN-21); rationale to `*-meta` mental model | "same quality, cheaper" made mechanical — the Pareto config per task-shape |
| **L7 — counterfactual/offline-eval** | cron: weekly (off critical path) + capped shadow triggers | historical `(signature, config, outcome)` over the native ledger; bounded shadow runs (`shadow=true`) | per-(shape,config) savings + calibration; counterfactual-headroom series to the dashboard | estimates "would a cheaper config have produced the same PR" without re-running |

#### 9.4.11 New KPIs (formulas + native recording sites)

All over rolling window W (default 20 merged stories), recorded from the same native records the §8.4 audit walk uses, so every KPI is reconcilable against lineage.

| KPI | Formula (over W) | Recording site (native) | Target dir. |
|---|---|---|---|
| **Cost-per-accepted-PR** (north-star) | over the **same cohort** of stories reaching a *terminal state* (merged or rejected) within W (WIP excluded): `SUM(cost_events.costCents over those stories' issue-trees) / count(accepted in that cohort)`, accepted = merged with 0 fix-loop re-entry | `cost_events` ÷ `activity_log`/`issues.status` | ↓ |
| **Tokens-per-accepted-PR** | `SUM(cost_events.inputTokens + outputTokens in W) / count(accepted PRs in W)` | `cost_events` token columns ÷ accept count | ↓ |
| **Token-waste-rate (cache)** | `1 − (Σ cachedInputTokens / Σ inputTokens)` per model/archetype | `cost_events.cachedInputTokens`, `.inputTokens` | ↓ |
| **Realized regret** (primary, non-circular) | `mean(cost_story of served arm) − mean(cost_story of the best legal arm with ≥N *observed* runs for that signature)` — observed ground truth, not estimated | policy artifact ⋈ `cost_events` | ↓ |
| **Estimated regret** (secondary) | same vs the L7 counterfactual best-arm estimate; rendered **only with its FR-LEARN-11 calibration class attached** and **suppressed to "insufficient calibration"** whenever the predicted-vs-observed bound is breached — never the headline (avoids the estimator auditing itself) | L7 estimator ⋈ `cost_events` | ↓ |
| **Config-policy confidence** | `1 − (# prior-pinned signatures with ≥ min-volume) / (# active signatures with ≥ min-volume)`; low-volume long-tail signatures excluded into a labelled "tail (insufficient volume)" bucket so the headline is not structurally capped by signatures that can never accrue N (FR-LEARN-7) | policy artifact per-signature obs counts | ↑ |
| **Counterfactual headroom** | `mean over stories of (cost_story − est_cheapest_equal_quality_cost)` for candidates with `P_same ≥ τ` and `confidence ≥ mid` | L7 estimator over `cost_events` | **↓ once config-policy-confidence > X for the signature** (captured opportunity); while confidence ≤ X it is a **diagnostic series with no pass/fail target** (avoids an unfalsifiable both-directions metric) |
| **Escaped-defect rate** (Goodhart ground truth) | `count(QA/post-merge fix issues linked to story.subtree) / stories_merged` | F3 QA `issues` + linkage (OQ-10) | ↓ |
| **Scope-normalized first-pass-accept** | `first_pass / mean(story_complexity)` | `issues.status` + diff/Seeds complexity | ↑ (only if escaped-defect flat) |
| **Waiver-rate** | `logged waivers (FR-EX-12/NFR-SAF-4) / nodes_emitted` | NFR-SAF-4 waiver log | ↓ (≤5%) |
| **Exploration-budget adherence** | `explore draws / eligible runs` and high-risk explore count | policy artifact explore-flag + risk tier | ≤10% / ==0 high-risk |
| **Difficulty-normalized cost/TDI/retry** | each §9.2 KPI ÷ `difficulty_index` | §9.2 sites ÷ signature | ↓ |
| **Learning-overhead ratio** | `SUM(cost_events for learning jobs: recall-prime + shadow + L3/L4/L6/L7 cron) / SUM(all cost_events)` over W | `cost_events` tagged learning-attributable | ↓ / capped (NFR-COST-3) |
| **Trend significance** | Mann-Kendall (τ, two-sided p) + CUSUM flag on each normalized KPI | derived at L5 refresh | p<0.10 to claim |

---

## 10. Phased Delivery

FR/NFR coverage spans all phases; **stories are authored to acceptance-criteria depth for Phase 0+1 only** (this PRD's scope is the PRD itself; story generation is the next, separately-approved step). Phases 2–5 are roadmap epics. **Each Phase-0 and Phase-1 item below carries a crisp, binary exit-criterion**; the aggregated per-phase gates are in Section 13. **[Δ Phase-0 reweighted toward acquisition/verification given three load-bearing components are not yet on disk — see §5.5.]**

### Phase 0 — Foundations & de-risk (~7 stories) — *acquisition-heavy, per spike findings*

Phase 0 is **acquisition + verification**, not configuration. Five of seven items are an *obtain-then-prove* pair, and each maps to the open question (§12.2) it resolves.

1. **Archon env patch (acquire + prove).** Branch off upstream `coleam00/Archon@dev`; apply the **2-site env patch** (add `env` to `dag-node.ts` schema + thread it into `execFileAsync` in `executeBashNode`). **Exit:** a bash node with `env: {FOO: bar}` runs and its subprocess echoes `bar` to node output (proving per-node env reaches the subprocess, not just Archon's inherited parent env). *Maps to OQ-6 (branch strategy) and unblocks FR-OR-4.*
2. **Vendor `coms.ts` + choose in-node architecture (acquire + decide).** Vendor `coms.ts` (and `coms-net.ts` if present) from `disler/pi-vs-claude-code@main`; smoke-test the coms contract (`pi.registerFlag`/`getFlag`, `coms_send`/`coms_await`, `sendMessage(...,{triggerTurn})`) against the **installed pi 0.55.0** binary. **Exit:** OQ-1 decision recorded (socket-coms vs subprocess-RPC) AND OQ-5 recorded (coms contract either runs on 0.55.0, or a pin/upgrade target is fixed). No green smoke test against 0.55.0 ⇒ fallback path (subprocess-RPC) is selected and logged. *Maps to OQ-1 + OQ-5; unblocks FR-EX-1/FR-EX-2.*
3. **`pi-team-launch.sh` + guarded mixed-model demo.** Write the launcher; run a 3-agent mixed-model team (Anthropic + OpenRouter). **Exit:** logs show ≥2 named agents exchanging ≥2 coms messages and a merged JSON emitted to stdout; AND a deliberately loopy prompt is killed by a hard guard (budget/turn/tilldone/`coms_await` timeout) rather than exhausting credits. *Unblocks FR-EX-3/FR-EX-6.*
4. **Install pi-lens + provision LSP + headless spike.** `pi install npm:pi-lens`; install the target-repo language server(s) (`typescript-language-server`(+`typescript`), `pyright`) on PATH; run `--mode json` then `--mode rpc` against a noop. **Exit:** OQ-2 answered with a recorded verdict — either pi-lens emits machine-readable TDI + warnings with stable IDs in a headless mode (QA gate wired to it), OR the logged warning-count proxy fallback is wired and the §9.3 fallback flag is set; AND an **active LSP is proven** — `lsp_diagnostics` surfaces a deliberately seeded type error in the target repo and `lsp_navigation` resolves a definition (if LSP diagnostics are TUI-only in headless mode, that is recorded as a sub-finding of OQ-2 with the same proxy/fallback treatment). *Maps to OQ-2; unblocks FR-EX-4/FR-EX-5/FR-EX-10.*
5. **Stand up Paperclip + install & verify channel/memory plugins.** Bring up Paperclip (Postgres + dashboard + root agent); install Telegram + Hindsight plugins via `POST /api/plugins/install`. **Exit:** dashboard reachable with both plugins listed as installed; AND OQ-3 answered against a live chat — the Telegram plugin's bidirectional `/approve`/`/status` + inline-button approval + per-type routing behaviors are each confirmed present or marked absent (gaps logged, not assumed). *Maps to OQ-3; unblocks FR-CM-1/2/3 + FR-CP-9.*
6. **Pin tooling + decide Hindsight host + wire banks + graph layer.** Upgrade/pin Seeds (0.2.5→target) and Mulch (0.6.3→target); decide Hindsight **cloud vs self-host**; install `pi-gitnexus-plus` (GitNexus CLI 1.6.3 present) and run an initial `gitnexus analyze` on the target repo. **Exit:** OQ-4 decision recorded on cost/latency/data-residency grounds; the chosen Hindsight stack round-trips retain→recall→reflect on a `{repo}` bank; `{repo}` and `{repo}-dev-meta` banks exist and Mulch expertise is imported; AND pi-gitnexus-plus loads in a Pi agent and `gitnexus_context`/`gitnexus_impact` return real graph data on a sample symbol. *Maps to OQ-4; unblocks FR-MEM-1/2 + FR-EX-9.*
7. **Phase-0 exit gate.** All six OQs (OQ-1..6) answered with a decision recorded; all Phase-0 item exit-criteria above green; aggregated gate in §13 passes. **Exit:** the §13 Phase-0 assertion list is fully checked.

### Phase 1 — Dev vertical slice (~14 stories) — *make-or-break*

Each numbered item below carries its own exit-criterion; the aggregated make-or-break gate is §13 Phase-1.

1. **Dev manager registered.** Dev manager runs as a 24/7 `hermes_local` agent, `reportsTo` root, with a budget. **Exit:** it appears in the org chart and authenticates REST calls with host-injected `PAPERCLIP_API_KEY` + `PAPERCLIP_RUN_ID`. *(FR-MG-1, FR-CP-11)*
2. **`/qds` intake → issue.** **Exit:** a `/qds <request>` creates exactly one parent Paperclip issue with the Dev manager as assignee. *(FR-MG-2, FR-CM-1)*
3. **Seeds-decompose → Paperclip mirror (authority split).** **Exit:** Seeds stories with dependency edges are persisted to `.seeds/issues.jsonl`, mirrored as child Paperclip issues under the parent; dependencies live only in Seeds, assignment+cost only in Paperclip, with no duplicated authority. *(FR-MG-3, FR-CP-3)*
4. **Author `qds-piv-loop` DAG.** **Exit:** the 14-node QDS variant registers and is runnable via `POST /api/workflows/qds-piv-loop/run`. *(FR-OR-1/2)*
5. **Pi-team implement node.** **Exit:** the implement bash node launches the Mulch-primed, pi-lens-gated Pi team and captures a single structured JSON result as node output; the node **blocks emit while `lsp_diagnostics` shows errors on changed files** (post-edit gate, waivers logged). *(FR-OR-3, FR-EX-6, FR-EX-11)*
6. **Drive + SSE + capture.** **Exit:** the Dev manager starts the run and consumes the dashboard SSE stream, capturing progress + final output correlated to the issue id. *(FR-MG-4, NFR-OBS-1/3)*
7. **Restart policy.** **Exit:** an induced transient/overflow/logic failure is classified deterministically and bounded by retry + wall-clock caps (≤8 retries / ≤1h → logged human gate). *(FR-MG-8/9, NFR-SAF-2)*
8. **`qds-model-router`.** **Exit:** the router selects archetype + per-role tier (OpenRouter GLM/Kimi for constrained roles, Anthropic Opus for judgment roles) and its choices are scored into `{repo}-dev-meta`. *(FR-MG-5, FR-EX-7)*
9. **`qds-hindsight-prime` + retain wiring.** **Exit:** a run recalls relevant prior bank entries into the node system prompt before execution and retains its learnings after. *(FR-MG-6/7, FR-MEM-2)*
10. **Mulch prime/record wiring.** **Exit:** house-style context is primed from Mulch pre-execution and reusable expertise is recorded post-run. *(FR-MEM-5)*
11. **`executionPolicy` approve/resume (Telegram).** **Exit:** a gated issue pauses the Archon run, pings Telegram with inline approve/reject, and the reply resumes the paused run. *(FR-OR-6, FR-CM-2, F2)*
12. **Cost ledger within budget.** **Exit:** every run writes a `cost_events` entry; per-issue-tree spend is queryable and within the agent/company budget cap (over-cap → gate/halt). *(FR-CP-4/12, NFR-COST-1/2)*
13. **Audit-chain reconstructable.** **Exit:** for one real PR, the full §8.1 chain (epic → Seeds → Paperclip issue → cost_events → approvals/decisions → heartbeat_runs → Archon run → Pi team → pi-lens → Hindsight) walks with no missing hop. *(G2, FR-ACT-1, NFR-ACC-2)*
14. **E2E make-or-break gate.** **Exit:** the §13 Phase-1 assertion list passes end-to-end on a sample repo (real PR produced).

### Phase 2 — QA department (~3 stories) — roadmap

QA manager + `{repo}-qa-meta` (shares the per-repo bank); post-merge Pi-swarm QA sub-DAG (hunter-pack lenses, pi-lens findings → issues); retain to shared bank; verify Dev recall.

### Phase 3 — Maintenance + cron (~5 stories) — roadmap

Maint manager + `{repo}-maint-meta`; Paperclip cron routines wake managers; sweep sub-DAG (dep bumps/refactor/hotspot); nightly consolidation; weekly learning (reflect → router/skill tuning); **GitNexus graph-refresh routine** (Paperclip cron every 4–6h: spin up → `gitnexus analyze` (staging-index + atomic swap) → spin down, keeping the graph current for all agents — FR-MEM-6, NFR-OBS-5).

### Phase 4 — PR iteration + comms (~5 stories) — roadmap

Telegram front-door (approvals + `/status` `/approve` + routing); Hermes iMessage intake gateway; `executionPolicy` approval gate → ping → resume at scale; PR-bot fix loop; wave-executor (Seeds deps + conflict awareness, ≤3 concurrent, merge order).

### Phase 5 — Hardening (~4 stories) — roadmap

Crash recovery/state repair; cost dashboards + TDI/yield-curve charts + budget alerts; rich Telegram notifications; load test (3 parallel stories).

### Deferred (Non-Goals)

coms-net cross-device teams; Research dept; multi-repo; A/B routing at scale.

> **Totals (estimate):** ~38 e2e stories, ~125 pts. Risk concentrated in Phase 1; Phases 2–5 repeat the established pattern.

---

## 11. Non-Functional Requirements

NFRs are measurable, each with a threshold. Existing IDs (NFR-ACC/SAF/COST/PERF/SEC/OBS/REL) are never renumbered; newly added measurable NFRs are **appended** within their category.

### 11.1 Accountability (`NFR-ACC`)

- **NFR-ACC-1:** 100% of worker agents map to a Paperclip agent row with a `reportsTo` ancestor terminating at the root agent (no orphan/anonymous workers). *Threshold: 0 orphan actors in any reconstructed chain.*
- **NFR-ACC-2:** For any merged PR, the full audit chain (§8.1) is reconstructable via the §8.4 contract with **no missing hop** (every one of the 10 joins resolves).
- **NFR-ACC-3:** **No `issue.cost` field exists; per-issue cost is derived solely from `cost_events`.** *Threshold: schema check passes (no `cost` column on `issues`) and per-issue cost equals SUM(`cost_events.costCents`) for that issue in 100% of audited issues.*
- **NFR-ACC-4:** Every escaped defect (a QA-department / post-merge fix issue) resolves to its **originating run and story subtree** (extends the §8.4 audit contract). *Threshold: 0 escaped-defect issues with no resolvable originating-run link in 100% of audited cases (subject to OQ-10; coarser repo-level attribution flagged as a proxy if the link is unavailable).* (FR-LEARN-20)

### 11.2 Safety / Guardrails (`NFR-SAF`)

- **NFR-SAF-1:** No Pi team can exceed its configured turn cap, wall-clock cap, or budget cap; a loopy prompt must terminate via the guard, not by exhausting credits.
- **NFR-SAF-2:** Default story bound = ≤8 retries and ≤1h wall-clock; exceeding either escalates to a logged human gate rather than silently retrying.
- **NFR-SAF-3:** `coms_await` calls must carry a timeout (default 30 min, `PI_COMS_TIMEOUT_MS` = `1_800_000ms`); no unbounded blocking wait.
- **NFR-SAF-4:** No implement/maintenance node emits a result while `lsp_diagnostics` reports errors on its changed-file union; any waiver (no server for that language, headless-TUI-only, or diagnostics timeout) is explicitly logged with a reason. *Threshold: 0 un-waived dirty-diagnostics emits.* (FR-EX-11/12)
- **NFR-SAF-5:** Router exploration (FR-LEARN-6) is **≤10% of eligible (non-high-risk, non-novel) runs** over any rolling 7-day window and **0% of high-risk-tier or novelty>θ runs**. *Threshold: high-risk/novel exploration count = 0; eligible-run exploration share ≤10%.*
- **NFR-SAF-6:** No policy-proposed config is promoted to production until it clears the **quality floor** (escaped-defect not worse, scope-normalized first-pass-accept not worse vs incumbent; FR-LEARN-21); and logged diagnostics/gate waivers (NFR-SAF-4) **≤5% of nodes emitted over W**, a breach auto-freezing L4 promotion. *Threshold: 0 promotions regressing the floor; waiver-rate ≤5% or promotion frozen.* (FR-LEARN-21, R18/R19)

### 11.3 Cost governance (`NFR-COST`)

- **NFR-COST-1:** Every agent run writes ≥1 `cost_events` entry; agent/company `spentMonthlyCents` never silently exceeds cap (over-cap → gate/halt). *Threshold: 0 runs with spend but no ledger row; 0 silent over-cap events.*
- **NFR-COST-2:** Cost/story is queryable per issue tree at any time from the ledger (no end-of-month-only reconciliation). *Threshold: per-issue-tree cost query returns in ≤2 s.*
- **NFR-COST-3 (learning is not a token hog):** Learning-attributable spend (recall priming + shadow runs + the L3/L4/L6/L7 cron consolidate/reflect/recompute/estimate jobs), itself ledgered in `cost_events`, is **≤10% of total factory spend over W**, within which **shadow runs are a strict sub-cap ≤4%** (so shadow can never starve the mandatory recall + cron jobs; shadow ⊂ learning-attributable). Realized savings are measured **only** against the FR-LEARN-23 frozen baseline (`router_config_hash`) and the FR-LEARN-26 ablation gap — the doc's single-arm-safe attribution methods — **not** raw period-over-period cost (which model/price drift would mis-credit) and **not** estimator-claimed headroom (counted only after FR-LEARN-11 shadow-validation). Those attributed savings must **meet or exceed** learning spend over a rolling 3×W window. *Threshold: learning-overhead ratio ≤10% (shadow ≤4%); baseline/ablation-attributed net savings ≥ 0 over 3×W, else learning is throttled (R21).*
- **NFR-COST-4:** A router/skill/guardrail change promoted by L4 must **not increase rolling-W cost/story by more than +5%** vs the pre-change baseline; a breach auto-reverts the change and logs it. *Threshold: ≤+5% cost/story over W post-change, else revert.*

### 11.4 Performance / Concurrency (`NFR-PERF`)

- **NFR-PERF-1:** In-node swarms are capped at ≤4 concurrent Pi agents (coms n² coordination ceiling).
- **NFR-PERF-2:** The factory must prefer additional DAG nodes over larger swarms when capacity > 4 agents is needed.
- **NFR-PERF-3:** Phase-5 load test: 3 stories run in parallel and complete within their combined budget without state corruption.
- **NFR-PERF-4:** A Hindsight `recall` priming a node prompt (budget `mid`, `max_tokens` ≤ 4096) must return within **≤2 s p95** (cloud) / **≤1 s p95** (self-host), and must **never block** the implement node beyond the `coms_await` timeout. On recall timeout, the node proceeds **unprimed with a logged warning** — recall is an enhancement, never a hard dependency of the critical path.
- **NFR-PERF-5:** The pi-gitnexus-plus read/search augmentation returns within **≤1.5 s p95** and must not block an agent turn beyond that budget; if the graph is unavailable or a query exceeds budget, the agent falls back to ordinary file/grep access **with a logged warning**. Graph augmentation is *advisory* → its fallback logs a **warning** (distinct from the LSP diagnostics gate, a *hard gate* whose degrade logs a **waiver** counted by NFR-SAF-4); never a hard dependency of the critical path.
- **NFR-PERF-6:** An **active (warm) LSP server is maintained per Pi worktree**; language-server cold-start is amortized once per worktree session, not per turn. `lsp_diagnostics` on a changed-file set returns within **≤3 s p95** and reflects the agent's uncommitted edits. If no server exists for a changed file's language **or diagnostics exceed the latency budget**, the diagnostics gate degrades to pi-lens ast-grep + tests with an explicit **logged waiver** (FR-EX-12), never a silent skip or an unbounded hang.
- **NFR-PERF-7:** Per-run arm selection (signature compute + legal-arm enumeration + sample/argmax) returns within **≤200 ms p95** and never bottlenecks node dispatch; on selection-path failure it fails safe to the §7 archetype default. *Threshold: ≤200 ms p95.* (FR-LEARN-3/4)
- **NFR-PERF-8:** The counterfactual estimator (FR-LEARN-9) runs **offline from logged data only — 0 task re-executions — in ≤2 s p95**; shadow runs (FR-LEARN-10) consume **≤4% of total factory spend over W and ≤N/day** (default N=3) — a strict sub-cap *within* the ≤10% learning envelope of NFR-COST-3 (same window W; shadow ⊂ learning-attributable, never independently additive) — a breach halting shadow scheduling (never the production path). *Threshold: 0 estimator-triggered task runs; 0 windows over the shadow sub-cap; 0 production side-effects from shadow.*

### 11.5 Security (`NFR-SEC`)

- **NFR-SEC-1:** No secret is hardcoded; credentials are referenced (env / secret refs), and `server.secret.json` is `0600`.
- **NFR-SEC-2:** All Paperclip API access uses bearer auth with a per-agent key (`PAPERCLIP_API_KEY`) + run-scoped header (`PAPERCLIP_RUN_ID`).
- **NFR-SEC-3:** pi-lens secret-scan runs on every worker turn; a detected secret blocks the turn-end emit until cleared.
- **NFR-SEC-4:** Plugin installs are restricted to instance admins.
- **NFR-SEC-5:** If the Hindsight server is deployed auth-protected (recommended for the cloud endpoint and any networked self-host), all memory calls send `Authorization: Bearer <token>` (SDK `api_key` / `HINDSIGHT_CP_DATAPLANE_API_KEY`); the token is supplied by env/secret ref, never hardcoded. *Note: `HINDSIGHT_API_LLM_API_KEY` is the LLM-provider key and is **not** the server-auth token — the two must not be conflated.*

### 11.6 Observability (`NFR-OBS`)

- **NFR-OBS-1:** Every Archon run streams via SSE and persists a run log retrievable post-hoc.
- **NFR-OBS-2:** The dashboard renders the four yield-curve KPIs (§9.2) over rolling window W.
- **NFR-OBS-3:** Every cross-component handoff (manager→Archon→Pi-team→pi-lens→memory) is logged with correlation back to the issue id.
- **NFR-OBS-4:** (a) The full §8.4 audit-chain walk for one PR completes in **≤30 s** by an operator/tool following the documented joins (no manual log-grepping). (b) The §9.2 KPI series are refreshed on a fixed cadence — **≤24 h** staleness for TDI/first-pass/retry, **≤5 min** for live cost/spend — and each KPI panel displays its last-refresh timestamp.
- **NFR-OBS-5:** The GitNexus knowledge graph is refreshed on a **4–6h cadence** (`gitnexus analyze`, FR-MEM-6); **staleness = time since the last *completed* analyze**, kept **≤8h** (cadence + max analyze duration must fit inside the bound). *Threshold: 0 agent runs against a graph whose last completed analyze is >8h old; each refresh cycle logs success/failure, duration, and the indexed HEAD SHA.*
- **NFR-OBS-6:** (a) Every served arm is **reconstructable** — its selection rationale (signature + policy snapshot + explore/exploit flag) is persisted alongside the `heartbeat_run`. *Threshold: 0 served arms with no recorded rationale.* (b) Every Layer-B KPI panel (§9.4.11) renders its **paired counter-metric** (FR-LEARN-19) and, for trend claims, displays **N, the Mann-Kendall p-value, and a bootstrap CI**, falling back to an explicit **"insufficient data (N/N_min)"** state below N_min (default 12) or p ≥ 0.10. *Threshold: 0 trend verdicts rendered at N<N_min or p≥0.10; 4/4 yield KPIs show a paired counter-metric.* (FR-LEARN-25)

### 11.7 Reliability (`NFR-REL`)

- **NFR-REL-1:** A mid-run crash is recoverable with state repair (Phase-5); an interrupted run resumes or fails cleanly, never corrupting the issue/cost ledgers.
- **NFR-REL-2:** Restart classification (transient/overflow/logic) is deterministic given the failure signal.
- **NFR-REL-3:** L2/L3 memory writes are idempotent under retry: retain uses `document_id = runId` so a re-run **upserts** rather than duplicating (Hindsight replaces the document on matching `document_id`), and nightly consolidation is bank-deduped server-side. *Threshold: 0 duplicate memory documents for a given runId after a retried run.*
- **NFR-REL-4:** All Layer-B learning writes are **idempotent**: the per-run outcome record (FR-LEARN-2) and meta-lesson retain (FR-LEARN-16) key on `runId`/`document_id=runId` (upsert), and the weekly policy recompute (FR-LEARN-5) is deterministic and row/bank-deduped — re-firing the cron yields the same policy state. *Threshold: 0 duplicate outcome/meta records per `runId`; identical `router_config_hash` on a re-run over unchanged data.*

---

## 12. Dependencies & Open Questions

### 12.1 External dependencies (must acquire/decide before or during Phase 0)

- `coms.ts` (vendor from `disler/pi-vs-claude-code@main`) — **not on disk**.
- pi-lens (`pi install npm:pi-lens`) — **not installed**.
- Telegram Paperclip plugin — **external, behaviors unverified**.
- `@vectorize-io/hindsight-paperclip` — **external** (`pnpm paperclipai plugin install`).
- Seeds 0.2.5 → pin/upgrade; Mulch 0.6.3 → pin/upgrade.
- GitNexus CLI ≥1.4.8 (installed **1.6.3** ✓; MCP live) + `pi-gitnexus-plus` extension — **not installed** → `pi install npm:pi-gitnexus-plus`.
- Language server(s) for the target repo (`typescript-language-server` + `typescript`, `pyright`) — **none installed** for the TS/Python stack (only Apple `clangd`). LSP nav + the post-edit diagnostics gate ride in with pi-lens once a server is on PATH.
- Hermes 0.15.1 (installed; self-reports "310 commits behind" — note, not block).

### 12.2 Open questions (each is a Phase-0 spike with an owner, action, gated decision, and fallback)

Each OQ below is load-bearing. **Owner-role** is the spike owner; **Spike action** is the concrete command/test; **Gates** lists the FR ids whose design the answer fixes; **Default/fallback** is the path taken if the spike is inconclusive — chosen so Phase 0 can always exit with a recorded decision rather than an open unknown.

- **OQ-1 (in-node architecture) — load-bearing.**
  - *Question:* Vendor `coms.ts` for persistent P2P socket teams, or use the on-disk `agent-team.ts`/`pi-pi.ts` subprocess-RPC model? The blueprint assumed socket-coms; only subprocess-RPC is runnable today.
  - *Owner-role:* Execution-layer lead (Pi-team owner).
  - *Spike action:* Vendor `coms.ts`; run the 3-agent guarded demo (Phase-0 item 3) on the socket path; in parallel, run the same 3-agent exchange via the on-disk subprocess-RPC path. Compare for runnability, coordination cost, and output variance.
  - *Gates:* FR-EX-1, FR-EX-2 (and the §7 archetype wrappers that assume `coms_send`/`response_schema`).
  - *Default/fallback:* If socket-coms does not run cleanly on the installed binary, **adopt subprocess-RPC** (it runs today) and defer socket-coms to a later phase; record the architecture choice in the audit log.
- **OQ-2 (headless pi-lens TDI) — load-bearing.**
  - *Question:* Does pi-lens emit machine-readable TDI/warnings (with stable IDs) in `--mode json` or `--mode rpc`? And does headless pi-lens emit machine-readable **`lsp_diagnostics`** results — the post-edit gate (FR-EX-11) depends on this exactly as the TDI axis does?
  - *Owner-role:* QA-gate lead (pi-lens owner).
  - *Spike action:* `pi install npm:pi-lens`; then `pi --mode rpc --print "noop" > /tmp/pilens_rpc.jsonl` and `pi --mode json --print "noop" > /tmp/pilens.json`; inspect for `tdi`/`warnings`/`stableId` keys or a written report file.
  - *Gates:* FR-EX-5, **FR-EX-11** (post-edit diagnostics gate); and the L5 TDI axis (§9.2/§9.3).
  - *Default/fallback:* If TDI is TUI-only, **wire the warning-count proxy** (pi-lens warning count via `--mode rpc`) as the TDI axis and set the §9.3 fallback flag; the QA gate still enforces secrets/lint/security pass even without a numeric TDI. If headless `lsp_diagnostics` is TUI-only, the post-edit gate degrades to ast-grep + tests per FR-EX-12 (logged waiver).
- **OQ-3 (Telegram plugin reality).**
  - *Question:* Does the installed Telegram plugin actually provide bidirectional `/approve` `/status`, inline-button approvals, and per-type routing?
  - *Owner-role:* Comms/control-plane lead (Paperclip owner).
  - *Spike action:* Install via `/api/plugins/install`; verify post-install against a live chat: send `/status`, trigger an `executionPolicy` gate and tap an inline approve button, and confirm per-type routing to distinct chats.
  - *Gates:* FR-CM-1, FR-CM-2, FR-CM-3.
  - *Default/fallback:* For any missing behavior, fall back to a Hermes-driven Telegram gateway for that capability (manager owns the channel) and log the gap; do not assume plugin parity.
- **OQ-4 (Hindsight cloud vs self-host).**
  - *Question:* Use cloud `api.hindsight.vectorize.io` (operator-accepted) or the already-installed local docker/pip stack?
  - *Owner-role:* Memory lead (Hindsight owner) with operator sign-off on data residency.
  - *Spike action:* Round-trip retain→recall→reflect against both the cloud endpoint and the local `~/.hindsight-docker` v18.1.0 stack on a throwaway `{repo}` bank; compare latency, cost, and data-residency posture. (API surface is identical — only `base_url`/bearer differ — so this is a deployment, not API, decision.)
  - *Gates:* FR-MEM-1, FR-MEM-2.
  - *Default/fallback:* If data-residency is undecided or cloud cost/latency is unacceptable, **default to the self-hosted local stack** (already installed) for v4; cloud remains an opt-in switch.
- **OQ-5 (pi version skew) — load-bearing.**
  - *Question:* `coms.ts` targets pi 0.73+; installed is 0.55.0. Does the coms contract (`pi.registerFlag`/`getFlag`, `sendMessage(...,{triggerTurn})`) behave on 0.55.0, or must pi be upgraded?
  - *Owner-role:* Execution-layer lead (Pi-team owner); shared with OQ-1.
  - *Spike action:* Smoke-test the registered-flag + `coms_send`/`coms_await` + `triggerTurn` path against the installed 0.55.0 binary (Phase-0 item 2); diff observed behavior vs the 0.73+ contract comments.
  - *Gates:* The entire Pi-team layer — FR-EX-1..6.
  - *Default/fallback:* If the contract breaks on 0.55.0, choose the cheaper of (a) pin/upgrade pi to a coms-compatible version, or (b) fall back to subprocess-RPC (per OQ-1). Record which, and pin the version either way.
- **OQ-6 (Archon branch strategy).**
  - *Question:* Carry the env patch as a maintained branch off upstream `coleam00/Archon@dev`, or open it upstream?
  - *Owner-role:* Orchestration lead (Archon owner).
  - *Spike action:* Apply the 2-site env patch on a branch; assess upstream PR-ability (does it generalize / would upstream accept it?) vs the rebase cost of carrying a private fork.
  - *Gates:* FR-OR-4 (and long-term maintenance cost; see §14 risk Archon-upstream-drift).
  - *Default/fallback:* If upstream acceptance is uncertain, **default to a maintained private branch** with a documented rebase procedure; revisit an upstream PR opportunistically.

#### 12.3 Layer-B self-optimization open questions (OQ-7..OQ-16)

These resolve the §9.4 / FR-LEARN design. **Only OQ-8 is a Phase-0/1 concern** (it confirms the native cost-attribution granularity the whole layer rests on, and is cheap to check on the Phase-0 cost-ledger demo); the rest are gated to **Phase 3+** when the offline loops land, so they do not block the make-or-break Phase-1 slice. Each carries a default so the design can proceed without the spike.

- **OQ-7 (config-policy store).** *Question:* Does the recomputed policy artifact (`router_config_hash` + per-signature Pareto frontier) live as a small **additive Paperclip table** (mirroring the `cost_events` migration pattern) or a cached file? Hindsight is ruled out for the numbers (no atomic increment / Pareto primitive — verified via `hindsight-docs`; R26). *Owner-role:* Self-improvement lead. *Spike:* confirm an additive `router_policy` migration is non-breaking; prototype one weekly recompute-from-ledger + one argmax read. *Gates:* FR-LEARN-5/27, NFR-REL-4. *Default:* **recompute-from-ledger, cache as a small additive Paperclip table**; never store counters in a bank.
- **OQ-8 (cost attribution granularity) — confirm early.** *Question:* §8.3 [Δ] confirms `cost_events` carries `agentId`/`model`/`heartbeatRunId`+tokens, but does **Pi-subprocess** spend auto-write its own per-role rows, or must `pi-team-launch.sh` emit them from the Pi JSON usage payload? *Owner-role:* Execution-layer + control-plane leads. *Spike:* run the Phase-0 guarded 3-agent demo; query `cost_events` for that issue and inspect per-agent rows, `model`, token columns, `heartbeatRunId`, and row count vs known LLM calls. *Gates:* FR-LEARN-2/12/14, all token KPIs, OQ-9, OQ-12. *Default:* if Pi spend does not auto-write rows, add a launcher-side `cost_events` emit per agent from the Pi usage payload; until then fall back to `heartbeat_runs.usageJson` parsed best-effort, labelled estimated.
- **OQ-9 (micro-waste telemetry feasibility).** *Question:* Can a node-output cost-lens reliably parse duplicate-reads / dead-end `coms_send` / grep-vs-graph from the Pi tool-call stream (which lives only in Archon node output, not a queryable Paperclip table)? *Spike:* capture a real Pi JSON event stream (Phase-0 items 2+4); prototype a parser; measure precision against a hand-labelled run. *Gates:* FR-LEARN-14 (micro-waste half). *Default:* ship only the natively-capturable waste rates (cache-miss, cost/token anomaly) for v4; **defer micro-waste**, render only capturable rates labelled as such.
- **OQ-10 (escaped-defect linkage).** *Question:* How does a post-merge QA/fix issue link back to the originating story subtree? `issues.parentId` gives decomposition but a QA finding on a *merged* change has no documented FK to the producing story. *Spike:* link via PR/branch ↔ Archon run ↔ issue (§8.4 steps 1–2) + tag QA-filed issues with the originating run id (`activity_log.runId`). *Gates:* FR-LEARN-20, NFR-ACC-4, escaped-defect KPI. *Default:* if no precise link, attribute at repo level (coarser) and flag as a proxy. *(Joint with the Phase-2 QA owner.)*
- **OQ-11 (coverage capture).** *Question:* Is test-coverage delta computable per story (no recording site today)? *Default:* use test-to-impl diff-line ratio (computable from node output) as a coverage proxy until a coverage runner is wired.
- **OQ-12 (shadow-eval + ablation affordability).** *Question:* At low story volume, is a held-out shadow harness + a frozen-policy ablation every K stories operationally affordable? *Gates:* FR-LEARN-10/26. *Default:* if volume is too low, rely on the one-time **baseline epoch** (FR-LEARN-23) as the sole control and label attribution "baseline-relative, not continuously controlled"; gate the shadow harness to a later phase.
- **OQ-13 (difficulty-signature validity AND manipulability).** *Question:* Does the task-shape signature actually correlate with realized cost/effort (validity), **and** can the optimizer inflate it via its own decomposition choices (manipulability)? *Spike:* regress `cost_story` on `difficulty_index` over the baseline epoch (validity); compare intake-estimated vs post-merge realized difficulty across runs (manipulability). *Gates:* FR-LEARN-24. *Default:* anchor `difficulty_index` to post-merge realized signals + inflation alert; if validity is weak, raw KPIs only with a logged caveat.
- **OQ-14 (global `factory-meta` bank).** *Question:* Is a cross-repo `factory-meta` bank worth its orchestration cost in v4, given NG1 (single repo)? *Default:* **defer to the multi-repo phase**; v4 keeps process-lessons in `{repo}-*-meta`; the global bank is scaffolded but not load-bearing until a 2nd repo exists; promotion requires ≥2-repo corroboration (R24).
- **OQ-15 (memory decay mechanism).** *Question:* Hindsight has **no native age-based TTL** (evidence-driven freshness only) — does `stale`-trend exclusion + a client-side retention sweep suffice, or is an explicit TTL needed? *Default:* **age-based retention sweep on the L3 cron** (delete raw `trial` docs older than W·k once captured in an observation) + `stale`-trend exclusion. *Gates:* FR-LEARN-17.
- **OQ-16 (exploration/evidence hyperparameters).** *Question:* What exploration budget (ε), default-pin threshold (N), evidence floor, and quality-floor τ avoid both starvation and overfitting at this factory's volume? *Spike:* replay the first ~20 stories offline; sweep the parameters against regret + first-pass-accept + escaped-defect. *Gates:* FR-LEARN-6/7/21. *Default:* ε≤10%, N=10, `proof_count≥3`, τ=0.85 with mandatory reviewer-parity — all config, not code; recalibrated in L4.

---

## 13. Verification / Acceptance (per-phase exit gates)

Each gate below is a list of **binary, checkable assertions** — every clause is independently pass/fail and the gate passes only if all clauses pass.

- **Phase 0 — Foundations & de-risk.** All must be TRUE:
  1. `pi-team-launch.sh "refactor X" ./ctx` returns a single merged JSON object on stdout.
  2. Run logs show ≥2 named agents exchanging ≥2 coms (or subprocess-RPC) messages.
  3. A deliberately loopy prompt hits a hard cap (budget/turn/tilldone/`coms_await` timeout) and exits non-zero — credits are not exhausted.
  4. pi-lens runs headless and EITHER emits a turn-end report with TDI + stable finding IDs, OR the logged warning-count proxy fallback is recorded with the §9.3 fallback flag set.
  4b. An active LSP is proven for the target language: `lsp_diagnostics` surfaces a seeded type error and `lsp_navigation` resolves a definition (or the TUI-only limitation is recorded under OQ-2 with a fallback).
  5. A trivial Archon bash node with a per-node `env` var runs and the subprocess echoes that env value into node output (env patch proven, not schema-only).
  6. The Paperclip dashboard is reachable with the Telegram and Hindsight plugins both listed as installed.
  7. Hindsight retain→recall→reflect round-trips on the chosen bank (cloud or self-host).
  8. **All six open questions OQ-1..6 are answered with a decision recorded** (including any fallback taken).

- **Phase 1 — Dev vertical slice (make-or-break).** All must be TRUE:
  1. Telegram `/qds <request>` creates exactly one parent Paperclip issue assigned to the Dev manager.
  2. The Dev manager decomposes via Seeds and mirrors stories to child Paperclip issues, with dependencies held only in `.seeds/issues.jsonl` and assignment+cost only in Paperclip (no duplicated authority).
  3. The `qds-piv-loop` DAG runs and reaches the Pi-team implement node, which is pi-lens-gated, **refuses to emit while `lsp_diagnostics` shows errors on changed files** (post-edit gate), and emits a single structured JSON result.
  4. **A real PR is produced on a sample repo.**
  5. **Audit-chain reconstructability:** for that PR, the full §8.1 chain (epic → Seeds → Paperclip issue → cost_events → approvals/`issue_execution_decisions` → heartbeat_runs → Archon run → Pi team → pi-lens → Hindsight) walks end-to-end with **no missing hop**.
  6. **Per-issue spend within budget:** Paperclip shows per-issue-tree spend from `cost_events`, and it is **at or under** the agent/company budget cap (no silent over-cap).
  7. The Hindsight dev bank (`{repo}-dev-meta` / `{repo}`) contains findings retained from the run.
  8. **Working `executionPolicy` Telegram approve/resume:** a gated issue pauses the Archon run, pings Telegram with inline approve/reject, and the human reply **resumes the paused run to completion** (a reject path likewise halts it cleanly).

- **Phase 2 — QA department.** All must be TRUE:
  1. The post-merge QA swarm files ≥1 real regression as a Paperclip issue (from a pi-lens-driven hunter lens).
  2. That finding is recallable by the Dev manager via the shared per-repo bank on a subsequent implement.

- **Phase 3–4 — Maintenance/cron + PR iteration/comms.** All must be TRUE:
  1. A Paperclip cron routine wakes the Maintenance manager and a sweep sub-DAG opens a scheduled refactor/dep-bump PR.
  2. The PR-bot fix loop resolves ≥1 review comment to closure.
  3. Weekly learning proposes a router/skill tuning derived from a `*-meta` bank.
  4. The TDI trend renders on the dashboard.

- **Phase 5 — Hardening.** All must be TRUE:
  1. The factory survives an induced mid-run crash with state repair and **no corruption** of the issue/cost ledgers (run resumes or fails cleanly).
  2. 3 stories run in parallel and complete within their combined budget without state corruption.
  3. The yield-curve chart renders all four KPIs with correct direction (TDI ↓, cost/story ↓, first-pass-accept ↑, retry-count ↓).

---

## 14. Risks & Mitigations

This register is the dedicated home for risk (separated from the open-questions/unknowns in §12). Each row is owned and carries a concrete **trigger-to-watch** — the observable signal that the risk is materializing and the mitigation should fire. Likelihood/Impact are L/M/H.

| # | Risk | Likelihood | Impact | Mitigation | Owner | Trigger-to-watch |
|---|---|---|---|---|---|---|
| R1 | **Orchestration tax** — latency/cost of 4-layer indirection (Paperclip→Hermes→Archon DAG→Pi team) makes cost/story or wall-clock unviable | M | H | Budget per-layer overhead AND the per-agent code-intel stack (pi-lens + GitNexus auto-augment + LSP tools) as explicit KPIs in the Phase-0 demo; "more nodes over bigger swarms" (§4.2) caps coordination blowup; collapse a layer for trivial work (Solo archetype, direct manager→DAG); set a cost/story ceiling that gates promotion past Phase 1 | Operator + Orchestration lead | cost/story or median run latency above the Phase-1 ceiling, or coordination overhead > productive compute in run logs |
| R2 | **Two-task-store authority split** — Seeds (deps) vs Paperclip (assignment/cost) diverge; issue exists in one but not the other, or dep graph disagrees with parent tree | H | H | Single owner per fact (Seeds=deps only, Paperclip=assignment+cost only — never duplicated); the §8 audit-chain walk is itself the reconciliation check; mirror is one-directional (Seeds→Paperclip) with idempotent sync; Phase-1 gate asserts no duplicated authority | Manager (Hermes Dev) lead | a Paperclip child issue with no Seeds story (or vice versa); a dependency edge in Seeds not reflected in the Paperclip parent tree |
| R3 | **Hindsight dependency** — cloud-vs-self-host indecision; data-residency exposure if memory banks hold sensitive code context in cloud | M | H | OQ-4 spike decides on cost/latency/residency with operator sign-off; default to the already-installed self-host stack if residency is undecided; bank contents scoped to non-secret learnings (secrets blocked upstream by pi-lens) | Memory lead + Operator | cloud egress of repo-derived context without sign-off; cloud latency/cost above the self-host baseline |
| R4 | **Version skew** — pi 0.55.0 vs `coms.ts` targeting 0.73+; Seeds 0.2.5/Mulch 0.6.3 behind expected; contracts silently behave differently | H | H | OQ-5 smoke-test against the installed binary before relying on any contract; pin every tool version (pi/sd/mulch) in Phase 0; subprocess-RPC fallback if coms breaks on 0.55.0; treat version comments as claims, not truth | Execution-layer lead | coms contract call behaves differently than the 0.73+ comments; a pinned tool auto-updates; a spike that passed on one version fails after an upgrade |
| R5 | **coms API unknowns / not-on-disk** — `coms.ts` exists only upstream; `response_schema` is parse-only (not validated); `--cname` is extension-registered, not core | M | H | Vendor `coms.ts` in Phase-0 item 2 and smoke-test before any team work; treat `response_schema` as parse-only and add explicit lead-side validation; fallback identity chain (frontmatter `name:` → `agent-<6chars>`) if `--cname` unavailable | Execution-layer lead | a receiver emits non-conforming JSON that `JSON.parse` accepts but the schema would reject; `--cname` flag unrecognized by the installed binary |
| R6 | **pi-lens not installed + headless-TDI uncertainty** — all pi-lens capabilities currently unverifiable; TDI may be TUI-only, breaking the L1/L4/L5 yield curve | H | H | OQ-2 install-and-spike in Phase-0 item 4; warning-count proxy fallback wired with an explicit §9.3 logged fallback flag; QA gate still enforces secrets/lint/security even without a numeric TDI | QA-gate lead | `--mode json`/`rpc` produce no `tdi`/`warnings`/`stableId` keys; pi-lens emits only to a TUI surface |
| R7 | **Telegram plugin behaviors unverified** — bidirectional `/approve` `/status`, inline buttons, per-type routing all claimed-not-verified; wrong attribution in blueprint | M | M | OQ-3 live-chat verification post-install; Hermes-driven Telegram gateway fallback per missing capability; do not place the Phase-1 HITL gate solely on an unverified plugin path until proven | Comms/control-plane lead | post-install, an inline approve tap does not resume the run, or `/status` returns nothing, or per-type routing collapses to one chat |
| R8 | **Archon upstream drift** — env patch is carried on a private branch; upstream `coleam00/Archon@dev` moves and the 2-site patch rots | M | M | OQ-6 decides branch-vs-upstream-PR; keep the patch minimal (2 sites) and documented; pin the Archon base SHA; documented rebase procedure; prefer upstreaming the patch if accepted | Orchestration lead | a rebase onto newer upstream conflicts on `dag-node.ts` or `dag-executor.ts`; upstream refactors `executeBashNode` |
| R9 | **Single-repo blast radius** — v4 targets a single repo with autonomous PRs; a bad autonomous change has nowhere to be contained | M | H | Worktree isolation per run (§4.1); mandatory test-first + pi-lens gate before any emit; `executionPolicy` HITL gate on high-risk issues; reviewed-PR (not auto-merge) is the output, leaving a human/QA seam | Operator + Orchestration lead | a PR opened that touches out-of-scope paths; pi-lens secret/security finding on the diff; AC-noncompliant diff reaching PR |
| R10 | **Budget runaway** — a loopy prompt or retry storm burns unbounded credits despite caps | M | H | Hard guards on every team (budget/turn/wall-clock/tilldone/`coms_await` — NFR-SAF-1/3); per-issue `cost_events` ledger queryable in real time; over-cap → gate/halt not silent retry; ≤8 retries / ≤1h story bound escalates to a human gate | Operator + Execution-layer lead | `spentMonthlyCents` approaching cap; retry count climbing on one story; a run without an enforced cap reaching the loopy-prompt guard |
| R11 | **Worktree/state corruption under concurrency** — parallel stories (Phase 5) corrupt shared issue/cost ledgers or step on each other's worktrees | M | H | Per-run worktree isolation; idempotent Seeds→Paperclip sync; crash-recovery/state-repair (NFR-REL-1) as an explicit Phase-5 deliverable; Phase-5 load test (3 parallel stories) asserts no corruption before any concurrency is promoted | Orchestration lead | two runs writing the same worktree or issue row; a `cost_events`/issue ledger inconsistency after a crash; load test surfacing a corrupted ledger |
| R12 | **GitNexus licensing** — GitNexus uses the PolyForm Noncommercial License; commercial use of the factory needs a separate agreement (the pi-gitnexus-plus extension itself is MIT) | M | M | Confirm license posture before any commercial deployment; the graph layer is advisory with a grep fallback (NFR-PERF-5/FR-EX-9), so it can be disabled if licensing blocks commercial use; budget a commercial GitNexus agreement if the factory goes commercial | Operator | a commercial deployment decision without a GitNexus commercial agreement |
| R13 | **Graph staleness** — between refreshes, large changes leave agents traversing a stale graph (wrong blast-radius / call-chain) | M | M | 4–6h cadence, ≤8h staleness bound (NFR-OBS-5 / FR-MEM-6); `gitnexus detect_changes` to flag drift and force an off-cycle refresh; agents treat the graph as advisory and verify against current files before edits (read-before-edit, pi-lens); tighten cadence further if drift bites | Maintenance lead | `gitnexus detect_changes` shows a large un-indexed diff; an agent acts on a call-chain that no longer exists |
| R14 | **LSP coverage/latency** — a changed file in a language with no installed server, or a slow/cold server, weakens the post-edit diagnostics gate (the strongest quality lever) | M | H | Provision the target repo's language server(s) in Phase 0 (§5.4); warm server per worktree (NFR-PERF-6); gate degrades to pi-lens ast-grep + tests **with a logged waiver** when no server exists (never silent); multi-language repos enumerate required servers up front | QA-gate lead | a changed file whose language has no server; `lsp_diagnostics` p95 > 3 s; a node emitting under a diagnostics waiver |
| R15 | **Goodhart on the yield curve** — the factory optimizes the four KPIs directly (§9.4) and the headline curve improves while real PR quality degrades (trivially-scoped stories, under-testing, finding suppression) | H | H | Paired counter-metrics (FR-LEARN-19); escaped-defect ground truth from Phase-2 QA (FR-LEARN-20); constrained reward = −∞ on quality breach (§9.4.1); not-both-rising gate (NFR-SAF-6); counter-metric co-display (NFR-OBS-6) | Self-improvement lead | first-pass-accept ↑ while escaped-defect ↑; scope-normalized accept flat while raw accept ↑ |
| R16 | **Policy overfitting / distribution shift** — the router excels on seen task-shapes but ships worse PRs on novel ones | M | H | Task-shape novelty score gates exploration and forces the conservative Trio floor on novel shapes (FR-LEARN-6/7); regret + cold-start-confidence KPIs (§9.4.11) | Self-improvement lead | positive novel-shape escaped-defect lift; regret rising after a model/price change; novelty score rising across intake |
| R17 | **Proxy-of-a-proxy gaming** — under OQ-2 negative the warning-count TDI proxy is optimized while real quality drifts | M | H | Proxy-divergence check + "proxy decoupled" alert (FR-LEARN-22); QA gate still enforces secrets/lint/security regardless of numeric proxy (§9.3) | QA-gate lead | warning-proxy ↓ with escaped-defect flat/↑ |
| R18 | **Quality-trading config promotion** — L4 promotes a cheap tier mix that passes proxies but ships worse PRs | M | H | Quality-floor gate on a held-out/trailing set; incumbent retained on regression (FR-LEARN-21, NFR-SAF-6) | Self-improvement lead | a proposed config lowers cost but regresses escaped-defect/scope-normalized-accept on the gate set |
| R19 | **Waiver-laundering** — nodes routinely emit under "logged waivers" (FR-EX-12) to drop TDI/cost, hollowing the strongest quality lever | M | H | Waiver-rate ceiling ≤5% with auto-freeze of L4 promotion (NFR-SAF-6); waivers first-class counted (NFR-SAF-4) and fed to finding-suppression delta | QA-gate lead | waiver-rate climbing toward 5%; waivers concentrated on one language/archetype |
| R20 | **Retry-laundering** — retries hidden by run fragmentation or unclassified restarts to flatter the retry KPI | M | M | Run-fragmentation + unclassified-restart counter-metrics (FR-LEARN-19); mandatory restart classification (FR-MG-9) | Manager (Hermes) lead | distinct `heartbeat_runs`/story rising while retry-count "falls"; unclassified restarts > 0 |
| R21 | **Learning becomes a token hog** — the learning machinery (recall, shadow runs, cron jobs) costs more than the savings it produces | M | H | Learning-overhead ratio ledgered + capped ≤10%, net-savings ≥0 over 3×W or learning throttled (NFR-COST-3); per-run tax bounded to one recall + event-driven retain (§9.4.0); heavy compute on offline cron only | Operator + Self-improvement lead | learning-overhead ratio > 10%; net savings negative over 3×W; recall p95 approaching the NFR-PERF-4 bound |
| R22 | **Counterfactual estimator bias** — the router rarely chose cheap configs on hard shapes, so cheap-config neighbors are sparse exactly where the question matters (inverse-propensity blind spot) | H | H | Confidence-class labelling + no low-confidence promotion (NFR-PERF-8/FR-LEARN-9); shadow validation required before any promotion (FR-LEARN-11) | Self-improvement lead | matched-neighbor count <5 on the shapes that dominate spend; a confident recommendation on a barely-seen config |
| R23 | **Shadow-run cost blowup** — offline-eval calibration becomes a second factory that doubles spend | M | H | Dedicated shadow budget cap (≤10% weekly, ≤N/day) halting shadow scheduling on breach, never production (NFR-PERF-8, FR-LEARN-10); shadow spend tagged + visible in cost governance | Operator + Self-improvement lead | shadow cost ratio approaching 10%; shadow run-count cap hit repeatedly |
| R24 | **Memory pollution / bad cross-repo transfer** — a one-off becomes a "belief", recall returns noise, or repo-specific economics are promoted as global | M | H | Evidence-gated promotion (`proof_count ≥ 3`, strengthening/stable trend), strict recall + `memory_type` filter, dedup, stale exclusion (FR-LEARN-17/18); `factory-meta` deferred + ≥2-repo corroboration (§9.4.8, OQ-14) | Memory lead | a router config flips on a single run; meta-recall returns Layer-A code findings; a transferred lesson degrades a new repo |
| R25 | **Vanity chart / false attribution** — a raw downward slope at small N is rendered as "improving", or a KPI move is credited to a loop when it is difficulty drift/noise | H | H | Min-N + significance + CI gates and insufficient-data state (FR-LEARN-25, NFR-OBS-6); difficulty normalization (FR-LEARN-24); frozen-policy baseline + ablation attribution (FR-LEARN-23/26) | Measurement lead | a directional claim at N<12 or p≥0.10; improvement with no changepoint near a config change; ablation-gap CI straddling 0 |
| R26 | **Policy-store mismatch** — forcing bandit counters into Hindsight banks (no atomic increment / Pareto primitive) corrupts the statistics | M | H | Numbers recomputed from the native ledger + cached as a versioned artifact, NOT stored as hot counters in a bank; Hindsight holds only rationale (§9.4.2, OQ-7) | Self-improvement lead | any attempt to derive arm counts from `recall` results; a `*-meta` recall used as a numeric source of truth |

**Cross-references:** R1 ↔ NFR-PERF-1/2 + §4.2; R2 ↔ FR-MG-3 + §8; R3 ↔ OQ-4; R4 ↔ OQ-5; R5 ↔ OQ-1; R6 ↔ OQ-2 + §9.3; R7 ↔ OQ-3; R8 ↔ OQ-6; R9 ↔ §4.1 + executionPolicy (FR-CP-5); R10 ↔ NFR-SAF/NFR-COST; R11 ↔ NFR-REL + NFR-PERF-3; R12 ↔ NFR-PERF-5 + FR-EX-9; R13 ↔ NFR-OBS-5 + FR-MEM-6; R14 ↔ NFR-PERF-6 + NFR-SAF-4 + FR-EX-10/11; R15 ↔ §9.4.4 + FR-LEARN-19/20 + NFR-SAF-6; R16 ↔ FR-LEARN-6/7 + OQ-13; R17 ↔ FR-LEARN-22 + §9.3; R18 ↔ FR-LEARN-21 + NFR-SAF-6; R19 ↔ NFR-SAF-4/6 + FR-EX-12; R20 ↔ FR-LEARN-19 + FR-MG-9; R21 ↔ NFR-COST-3 + §9.4.0 + OQ-9; R22 ↔ FR-LEARN-9/11 + NFR-PERF-8 + OQ-12; R23 ↔ FR-LEARN-10 + NFR-PERF-8; R24 ↔ FR-LEARN-17/18 + §9.4.8 + OQ-14/15; R25 ↔ FR-LEARN-23/24/25/26 + NFR-OBS-6; R26 ↔ §9.4.2 + OQ-7.

---

## Appendix A — Post-PRD execution order (next, separately approved)

1. Resolve the six Phase-0 open questions (OQ-1..6) via spikes — **OQ-1, OQ-2, OQ-5 are the load-bearing unknowns** (coms architecture, headless TDI, pi version skew).
2. Generate epics + Phase 0/1 stories (`bmad-create-epics-and-stories`), seeded with this PRD.
3. Run `/qds-story-review` adversarial pass before any development.

## Appendix B — Spike evidence index

All Section 5 verdicts trace to read-only, file-cited Phase-0 spike reports (2026-06-05), then re-verified in the Wave-1 deepen pass. Primary citations are embedded inline in the scorecard tables. Repos of record: Archon `coleam00/Archon:dev@536584db`; Paperclip `paperclipai/paperclip@78dc3625`; Pi comms `disler/pi-vs-claude-code@main` (coms.ts @ 2026-06-03); tooling `pi 0.55.0 / sd 0.2.5 / mulch 0.6.3 / hermes 0.15.1`. Hindsight API grounded against the `hindsight-docs` skill (2026-06-05).
