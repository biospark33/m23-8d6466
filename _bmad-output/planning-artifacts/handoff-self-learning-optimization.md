# Handoff — QDS-Factory v4: Self-Learning & Factory Self-Optimization Deep-Dive

**Paste this whole document as the opening prompt of a fresh conversation.** It is self-contained.

---

## 0. Your role & mission (one line)

You are a principal AI-systems architect. **Mission: stress-test and substantially expand the QDS-Factory v4 self-learning design — especially the *meta* layer where the factory optimizes its own process and configuration** (not just the code it writes) — and fold the result back into the PRD as additive, evidence-grounded amendments. Do **not** regenerate the PRD; deepen it.

---

## 1. What QDS-Factory v4 is (context)

A **lights-out software factory**: work enters any channel (Telegram/iMessage/dashboard) → autonomously becomes a reviewed PR on **a single target repo**, with minimal oversight. Four layers + an accountability spine:

1. **Paperclip** (`paperclipai/paperclip`) — control tower: org chart (`agents.reportsTo`), budgets (`spentMonthlyCents` vs `budgetMonthlyCents`), issues = system-of-record (`assigneeAgentId`/`status`/`parentId`/`executionPolicy`), **cost ledger `cost_events`** (FK→issue, `costCents` — there is NO `cost` column on issues), `heartbeat_runs` (exec trace), cron `routines`, `approvals` + `issue_execution_decisions`, plugin SDK + `PluginEventBus`.
2. **Hermes** managers (Dev/QA/Maintenance) — 24/7 agents registered into Paperclip via `hermes_local`.
3. **Archon PIV DAG** (`qds-piv-loop`) — fresh-context, worktree-isolated, SSE-audited; heavy node = bash node → `pi-team-launch.sh`.
4. **Pi agent teams** — ≤4 mixed-model agents per node, P2P coms, each running pi-lens (QA) + pi-gitnexus-plus (graph) + LSP.

**The thesis is the yield curve:** the factory must get measurably better with use — TDI↓, cost/story↓, first-pass-PR-accept↑, retry-count↓ — charted on the dashboard. **Your mission is to make that thesis real and powerful, well beyond what §9 currently specifies.**

---

## 2. PRD location & current state (READ THIS FIRST)

- **File:** `~/QDS-Factory/_bmad-output/planning-artifacts/prd-qds-factory-v4.md` (14-section enterprise PRD; FR/NFR with stable IDs).
- **Provenance:** ground-truthed by live Phase-0 spikes (4 parallel agents, file-cited) then hardened by **two** adversarial QA passes. It is honest about what is verified-on-disk vs upstream-only vs not-yet-installed (see its §5.6 confidence table). Match that discipline.
- **Read in full before proposing anything:** §8 (accountability spine), **§9 (self-improvement — your primary target)**, §6.2 (`FR-MG`), §6.7 (`FR-ACT`), §7 (swarm archetypes + `qds-model-router`), §11 (NFRs), §12 (open questions), §14 (risk register). Skim §4.5 (code-intelligence layers) and §5 (component scorecard).

---

## 3. House discipline you MUST follow (non-negotiable)

1. **Evidence over assertion.** Nothing is "installed/working/proven" unless verified. Mark unverified items and add an Open Question with a spike. Ground any new tool/API claim against the available skills/MCP — `hindsight-docs` (memory API), `context7` (library docs), the GitNexus MCP — and cite what you used.
2. **Stable IDs, additive only.** Never renumber existing FR/NFR/OQ/R/G/F/L IDs. Append new ones (propose a `FR-LEARN-*` group and/or extend `FR-MG`/`FR-ACT`; new `NFR-*` within existing categories; new `OQ-*`, `R##`).
3. **Use the real machinery, or flag a gap.** Build on what exists: Hindsight (`/v1/default/banks/{bank_id}/…` retain/recall/reflect/**consolidate**/**mental-models refresh**; bank-deduped; bearer auth via SDK `api_key`/`HINDSIGHT_CP_DATAPLANE_API_KEY` — NOT `HINDSIGHT_API_LLM_API_KEY`), the per-manager `*-meta` banks, `cost_events` ledger, `heartbeat_runs`, pi-lens TDI, `qds-model-router`. If your design needs infra that doesn't exist, say so explicitly and add it as a component + spike — don't pretend it's there.
4. **Respect non-goals but distinguish them.** `NG4` defers "A/B model routing **at scale**." Single-arm online learning, offline counterfactual evaluation, and bounded exploration are **in scope** — be precise about which you're proposing and keep heavyweight experimentation as a roadmap item.
5. **BMAD format + measurability.** FRs = testable `[actor] can [capability]`, implementation-agnostic. NFRs = a threshold/number (no "fast"/"efficient"). Every new KPI gets a precise formula + recording site.
6. **Caveman/house tone is for chat; the PRD prose stays normal enterprise English.**

---

## 4. The current self-learning design (so you don't re-derive it)

§9 today defines **five nested loops**:

- **L1 per-run:** pi-lens autofix + read-before-edit + post-edit LSP diagnostics gate → fewer in-run defects.
- **L2 per-story:** Hindsight retain on run-finish / recall on run-start (shared per-repo bank); QA bug reaches Dev's next implement.
- **L3 nightly:** consolidate → observations + mental-model refresh (cron routine).
- **L4 weekly:** reflect over per-manager `*-meta` banks → tune `qds-model-router` (which tier won on cost/quality) + evolve skills.
- **L5 measured:** the four KPIs charted (TDI↓, cost/story↓, first-pass-accept↑, retry↓).

**KPIs (current):** TDI trend; cost/story = `SUM(cost_events.costCents)` over an issue subtree; first-pass-accept = merged-without-fix-loop / total-merged over window W; retry count.

**The gap you are here to close:** L4 is the *only* loop touching factory-process/config optimization, and it is thin ("which tier won"). The factory's ability to learn **its own optimal configuration per task type** — same quality for far fewer tokens, right archetype for the work shape, right guard thresholds — is underspecified. That is the heart of this mission.

---

## 5. The mission in depth — two layers of learning

The operator wants the factory to improve on **two distinct layers**. Make both first-class.

### Layer A — Code/artifact learning (partially covered; sharpen it)
Learning tied to the application being built: past mistakes, recurring bug classes, house-style, token inefficiencies *within* code production. Largely L1/L2 today. Sharpen: what exactly is retained, how recall is scoped so it actually changes the next diff, how token waste (re-reads, redundant exploration, oversized prompts, dead-end coms) is detected and fed back.

### Layer B — Factory self-optimization / META-learning (the big gap — your focus)
The factory optimizing **its own process and configuration**, independent of any one app's code. The operator's words, concretely:

> "If we use this configuration for this type of task vs another, we get similar performance but for way cheaper token usage."

So the factory must learn an **empirical policy over (task-shape → configuration → outcome)**:

- **Task-shape signature:** a feature vector for an incoming unit of work — language, size/diff estimate, #separable surfaces, risk tier, test-surface presence, novelty vs prior work, blast radius (GitNexus).
- **Configuration space:** archetype (A–F), per-role model tiers (Opus / GLM / Kimi / Sonnet via OpenRouter), node decomposition (more-nodes-vs-bigger-swarm), guard thresholds (turn/budget/time caps), prompt/skill variant, augmentation on/off per role.
- **Outcome record per run:** quality (first-pass-accept, TDI delta, review findings, test pass), **cost (`cost_events`)**, latency (`heartbeat_runs` timing), retries/escalations.
- **The policy:** given a task-shape, recommend the **Pareto-optimal** config — cheapest tokens at the required quality bar — and improve that recommendation as evidence accumulates. This is the "same quality, way cheaper" capability made mechanical.

---

## 6. Exploration agenda — examine from multiple points of view

Investigate at least these angles (parallel subagents encouraged — see §7). For each, produce concrete, grounded design, not hand-waving.

1. **RL/decision-systems POV.** Frame config selection as contextual bandit / offline policy. Exploration vs exploitation bounded by **risk tier** (never explore-cheap on a high-risk issue). Thompson/epsilon-greedy? How much exploration budget? Where is the policy stored and updated (a router-policy store? Hindsight mental-models? a `*-meta` bank schema)? How does it cold-start with no data?
2. **Counterfactual / offline-eval POV.** "Would a cheaper config have produced the same merged PR?" Using the historical (task-shape, config, outcome) record to estimate savings *without* re-running. Replay/shadow evaluation. This is the safest path to "same quality cheaper."
3. **FinOps POV.** Cost-per-accepted-PR as the north-star efficiency metric; token-budget *allocation* across roles/nodes; detecting token waste patterns (re-reads, oversized context, redundant coms, dead-end exploration) and converting them to guardrails or skill edits. New KPIs + formulas.
4. **Process/DAG-shape POV.** Learn structural choices: when more-nodes-of-3 beats one-node-of-6; when a node should be split; which `qds-piv-loop` shapes win per task-type. Process learning, not model learning.
5. **Knowledge-management POV.** What to retain vs discard; memory **decay/promotion** (Hindsight consolidate/observations/mental-models); preventing **memory pollution** (bad lessons retained, recall returning noise). Per-repo vs per-manager-meta vs a new global factory-meta bank? How does a process-lesson learned on repo X transfer to repo Y (or is it scoped)?
6. **Adversarial / Goodhart POV.** Every KPI invites gaming. First-pass-accept ↑ by trivially-scoped stories; cost ↓ by under-testing; TDI ↓ by suppressing findings. Router overfitting to the past task distribution. Design counter-metrics and guardrails so optimization can't degrade real quality.
7. **Measurement & causality POV.** How do we *attribute* an improvement to a learning loop vs noise? Need a baseline, a window, and a way to tell signal from drift. The yield curve must be defensible, not a vanity chart.

---

## 7. Suggested method

- **Multi-POV fan-out:** spawn parallel subagents (one per POV above), each grounding against `hindsight-docs`/`context7`/GitNexus and returning a focused design + the new FRs/NFRs/KPIs/risks it implies. Then **you** synthesize into one coherent amendment set (single author = no drift), reconciling overlaps.
- **Then an adversarial QA pass** (fresh-context subagents, as was done twice already) over your amendments: cross-ref integrity, spike-fidelity/over-claim, logic/Goodhart soundness. Apply confirmed findings.
- Prefer **additive amendments** with stable IDs over rewrites.

---

## 8. Deliverable & acceptance

Amend `prd-qds-factory-v4.md` (additive) with:

1. **A reworked / expanded §9** that makes Layer-B meta-optimization first-class — ideally a new subsection (e.g. §9.4 "Factory self-optimization model") covering the (task-shape → config → outcome) policy, its store, its update cadence, exploration policy, and cold-start.
2. **New `FR-LEARN-*` capabilities** (and/or extensions to `FR-MG`/`FR-ACT`): record per-run outcome vectors; compute the config-policy; recommend a config per task-shape; run counterfactual savings estimates; detect token-waste patterns; bounded exploration gated by risk tier.
3. **New KPIs** with precise formulas + recording sites — at minimum cost-per-accepted-PR, token-waste rate, and a config-policy-confidence / regret metric. Map each to where it's recorded (`cost_events`, `heartbeat_runs`, `*-meta` banks, pi-lens).
4. **New NFRs** (measurable) — e.g. learning must never increase cost/story or latency beyond a bound; exploration capped at X% of runs and never on risk-tier-high; policy update idempotent.
5. **New risks** (`R##`) — Goodhart/KPI-gaming, router overfitting to past distribution, memory pollution, learning-induced cost/latency regressions, exploration on the wrong issue.
6. **New Open Questions** (`OQ-*`) — anything requiring a spike (e.g. does the policy live in Hindsight mental-models or a dedicated store; can `cost_events` granularity support per-role attribution; counterfactual eval feasibility).
7. **Update the §5.6 confidence table and frontmatter `stepsCompleted`** to reflect the new work and any new not-yet-verified dependencies.

**Acceptance:** additions are evidence-grounded (no over-claim), IDs contiguous and cross-referenced, every KPI/NFR measurable, Goodhart guardrails present, and the whole thing survives an adversarial QA pass. **Do not proceed to story generation** — that is a separate, later step (`bmad-create-epics-and-stories` → `/qds-story-review`).

---

## 9. Anti-patterns to avoid (the QA agents will check these)

- Inventing infrastructure not on disk and asserting it works (the whole PRD's credibility rests on not doing this).
- Unfalsifiable metrics ("more efficient") — every metric needs a formula + threshold + recording site.
- A learning loop that optimizes a proxy into the ground (Goodhart) with no counter-metric.
- Memory designs that grow unbounded or pollute recall (no decay/promotion/dedup story).
- Proposing full A/B-at-scale (NG4) as if in-scope — keep it roadmap; propose single-arm + offline-eval + bounded exploration for v4.
- Renumbering existing IDs or rewriting clean sections.

---

## 10. Quick-reference facts (verified this session, 2026-06-05)

- Repos of record: Archon `coleam00/Archon:dev@536584db`; Paperclip `paperclipai/paperclip@78dc3625`; Pi comms `disler/pi-vs-claude-code@main`.
- Installed: pi 0.55.0, sd 0.2.5, mulch 0.6.3, hermes 0.15.1, **GitNexus CLI 1.6.3** (MCP live).
- **Not installed / must-acquire:** `coms.ts` (upstream-only), pi-lens, pi-gitnexus-plus, language servers (TS/Py), Telegram + Hindsight Paperclip plugins.
- Load-bearing open questions already filed: OQ-1 (coms socket vs subprocess-RPC), OQ-2 (headless pi-lens TDI **and** `lsp_diagnostics` emission), OQ-5 (pi 0.55 vs coms.ts 0.73+ skew).
- Hindsight: self-hostable (not cloud-only); API verified via `hindsight-docs`; `consolidate` + `mental-models refresh` are real first-class ops (load-bearing for any decay/promotion design).
- Memory stores available to learning: Hindsight banks (`{repo}`, `{repo}-dev-meta`/`-qa-meta`/`-maint-meta`), Mulch expertise JSONL, Seeds issues JSONL, Paperclip `cost_events`/`heartbeat_runs`.

**Start by reading the PRD (§8, §9, §6.2, §6.7, §7, §11, §14), then run the multi-POV fan-out on the §5–§6 agenda above.**
