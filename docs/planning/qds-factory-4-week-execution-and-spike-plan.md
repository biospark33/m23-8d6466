---
title: "QDS-Factory — 4-Week Execution & Spike Plan"
doc_id: QDS-EXEC-001
date: 2026-06-13
status: AUTHORITATIVE — execution guidance for the SwarmClaw/Hindsight pivot
audience: implementing agents and the 2-dev build team
supersedes_scope: prioritization & sequencing only (does NOT supersede the design docs it references)
source_documents:
  - docs/planning/hindsight-memory-master-design.md        # QDS-MEM-001, project-tier memory
  - docs/planning/hindsight-factory-tier-design.md         # QDS-MEM-002, factory-tier memory
  - docs/planning/hindsight-memory-architecture-handoff.md # two-bank handoff (Jun 10, partly superseded)
  - _bmad-output/planning-artifacts/prd-qds-factory-v4.md  # PRD v4 (Paperclip/Hermes naming — see §2 doc-drift note)
  - _bmad-output/planning-artifacts/architecture-v3.md     # Archon-era architecture (partly superseded by pivot)
  - _bmad-output/sprint-artifacts/phase-0/stories/*        # 11 stories, 37 pts (SwarmClaw/Warren ground truth)
  - _bmad-output/sprint-artifacts/phase-1/stories/*        # 19 stories, 67 pts (SwarmClaw/Warren ground truth)
constraints: "2 developers · 4 calendar weeks · full enterprise-grade rigor · no shortcuts · adaptable for later optimization"
---

# QDS-Factory — 4-Week Execution & Spike Plan

> **Purpose of this document.** It is the planning substrate for the build. It (a) reconciles the architecture
> threads in the repo, (b) sets the feasibility-honest scope for a 2-dev / 4-week window, (c) defines the
> cut / keep / defer line with rationale, and (d) specifies the de-risking **spikes** in enough structural
> detail that an implementing agent can expand each one into an exact plan of attack. Future agents should
> treat the spike specs in §7 as the primary work item: **spikes run before the feature code they protect.**

---

## 1. TL;DR for a fresh agent

QDS-Factory ("the Dark Code Factory") is a lights-out software factory: work enters via a channel and
autonomously becomes a **reviewed pull request**, fully audited and costed, with a memory layer that makes the
factory measurably better with use.

The current pivot is **SwarmClaw (orchestrator) + Warren (Pi-team harness) + Hindsight (KG memory) + cron
"Hermes" bots + GitNexus/pi-lens (code intelligence)**. The active sprint stories already reflect this pivot;
some older planning docs do not (see §2).

**The single most important fact for planning:** the *documented* scope is roughly 3× what 2 devs can build to
enterprise grade in 4 weeks. The world-class outcome in this window is **one rigorous vertical slice** (channel
→ audited PR → review→fix loop → rich memory banks → external-review harvesting), with everything else stubbed
behind **clean seams** so it plugs in later with zero rework. Do not attempt thin coverage of the whole design.

**The single highest-leverage action:** run the Hindsight-primitives spike (§7, SPIKE-1) on day 1–2, before any
memory feature code. The entire self-improvement thesis rests on five Hindsight primitives behaving as the
design assumes; none are validated against the live build yet.

---

## 2. Architecture reconciliation (read this before trusting any single doc)

There are two architecture threads in the repo. They use different substrate names. **The sprint stories are
ground truth; the PRD/architecture docs are partially stale.**

| Concern | Older docs (PRD v4 / architecture-v3) | Active pivot (phase-0/phase-1 stories) | Ground truth |
|---|---|---|---|
| Control tower / orchestrator | Paperclip | **SwarmClaw** | stories |
| Department managers | "Hermes" agents (Dev/QA/Maintenance) | Dev Manager via A2A | stories |
| Workflow / DAG engine | Archon PIV DAG (+ env patch) | **SwarmClaw protocol template** (5-phase) | stories |
| Pi-team execution harness | inline DAG nodes | **Warren** | stories |
| Memory | Hindsight (cloud assumption corrected) | **Hindsight** (local-capable) | both agree |
| Code intelligence | GitNexus + claude-mem | GitNexus + pi-lens + mulch + Hindsight | stories |

> ⚠️ **Terminology trap — "Hermes."** The PRD uses "Hermes" for the 24/7 *department-manager* agents
> (Dev/QA/Maintenance). Operators colloquially also call the **proactive cron agents** (Synthesizer,
> Meta-Optimizer, Blind-Spot Detector, Review Harvester) "Hermes bots." This document uses **"cron agents"** /
> **"proactive agents"** for the scheduled memory agents and **"department manager"** for the orchestration
> managers. Disambiguate explicitly in any new artifact.

**Action item (week 1, cheap, prevents thrash):** confirm the stories are ground truth and add a one-line
status banner to the PRD/architecture docs pointing here. Two devs working off conflicting substrate names is a
guaranteed week of rework.

---

## 3. Scope reality — the feasibility math

Honest accounting of everything the design currently calls for:

| Workstream | Size | Source |
|---|---|---|
| Phase-0 stories | 11 stories / 37 pts | sprint artifacts |
| Phase-1 stories | 19 stories / 67 pts | sprint artifacts |
| Project-tier memory rollout | 6-phase implementation | QDS-MEM-001 |
| Project-tier proactive agents | 4 (Synthesizer, Meta-Optimizer, Blind-Spot, Review Harvester) | QDS-MEM-001 |
| Factory-tier memory | 2 banks + promotion pipeline + A/B + transfer learning | QDS-MEM-002 |
| Factory-tier proactive agents | 4 (Cross-Project Synthesizer, Factory Optimizer, Portfolio Harvester, Factory Blind-Spot) | QDS-MEM-002 |

Dependency analysis of the stories alone (104 pts — 37 phase-0 + 67 phase-1) lands at **~65% confidence
at 4 weeks, realistic 5–6 weeks**, and that excludes the entire memory rollout and 8 cron agents. A realistic
2-dev / 4-week throughput at enterprise grade (tested, audited, hardened) is **~45–50 well-chosen points**.

**Conclusion:** prioritization is not optional. The cut/keep/defer line in §4 is the plan.

### 3.1 Why the cron agents cannot prove value in this window (load-bearing rationale)

The proactive agents read *accumulated* observations. Their cadences:

| Agent | Cron | Fires in 4 weeks |
|---|---|---|
| Review Harvester (project) | `17 2 */3 * *` (every 3 days) | ~9 |
| Synthesizer (project) | `23 7 * * 1` (weekly Mon) | ~4 |
| Meta-Optimizer (project) | `25 7 1,15 * *` (1st/15th) | ~2 |
| Blind-Spot Detector (project) | `27 7 1 * *` (monthly) | ~1 |
| All 4 factory agents | 2nd/16th, weekly, monthly | ~1–4, on **empty** banks |

The master design itself expects `system_maturity: early_calibration` for the first weeks. **In a 4-week,
single-repo window the analysis agents have almost nothing to analyze.** Therefore the 4-week priority is the
**capture/recall plumbing that fills the banks**, plus the **one agent with external signal** (Review
Harvester). The analysis agents become a ~1-day deploy later, against rich data. Build the flywheel; do not try
to prove the curve — the curve compounds over months.

### 3.2 Why the factory tier is premature (load-bearing rationale)

The factory tier's value (cross-project pattern amplification, A/B experiments, transfer learning) **requires
multiple projects with CodeRabbit active** — it is the gating requirement (Principle F4). With one repo, the
four factory banks stay empty and the four factory agents analyze nothing. Build the factory tier as a **typed
seam** (the `promote_to_factory()` interface) writing to a no-op/log sink, and defer all four factory agents.
This is the single largest scope reclaim, at near-zero future rework cost.

### 3.3 Budget reality — the KEEP slice is over its own budget (load-bearing caveat)

> ⚠️ **Honest accounting.** The 18-story KEEP slice in §4.1 points to **64 pts** when summed from story
> frontmatter (the ground truth), not the "~45 pts" a first read suggests. The longest *serial* critical-path
> chain (P0.1 → P0.7 → P1.1 → P1.4 → P1.6 → P1.15 → P1.18 → P1.19) is ~29 pts; the remaining ~35 pts run in
> parallel off that spine (memory, cost ledger, audit, guard-kill). So 64 pts is achievable only with strong
> parallelism and minimal integration fallout.

This means one of two things is true, and the team must pick before week 1:

1. **The throughput estimate is optimistic** — 2 devs doing 64 enterprise-grade pts (tested/audited/hardened) in
   4 weeks assumes near-zero rework and full Dev A/Dev B parallelism. If P1.15 surfaces the expected cascade of
   earlier-story bugs (§5 buffer), 64 pts will not finish. Treat 45–50 as the *committed* target and 64 as the
   *stretch*.
2. **The slice needs ~15–19 pts more trim** to land at 45–50. Cheapest trims (reversible, behind seams):
   P0.5 nav-surface trim, P1.9 restart-policy → cgroup-only fallback, P1.18/P1.19 review-loop reduced to
   comment-detection-only (defer the Pi-Pair auto-fix to week 5+).

**Default posture:** build the §4.1 slice as the stretch target, but treat every DEFER story (§4.2) as
non-negotiably out — do not absorb limbo stories into KEEP under schedule pressure. The over-budget gap is closed
by trimming the slice or extending the window, not by quietly widening scope.

---

## 4. Cut / Keep / Defer

### 4.1 KEEP — the bulletproof vertical slice (64 pts across 18 stories; ~29-pt serial critical path)

Build these to full enterprise grade: tested, audited, hardened, no shortcuts.

**Spine — "lights-on" (Goal G1: channel → autonomous reviewed PR)**

| Story | Title | Why load-bearing |
|---|---|---|
| P0.1 | CLI harness env | foundation; blocks P0.3/P0.4 |
| P0.2 | Coms vendor smoke-test | foundation; blocks dispatch |
| P0.4 | Hard guard kill (budget/turn/wall-clock/coms_await) | **safety, non-negotiable for lights-out** |
| P0.7 | SwarmClaw agent+MCP registry, Hindsight bridge | **THE bottleneck**; blocks P1.1/P0.8/P0.9 |
| P1.1 | Dev Manager A2A delegation + router | orchestration entry |
| P1.2 | `/qds` intake → session + GitHub issue | channel entry |
| P1.4 | qds-factory protocol template (5-phase) | blocks P1.6/P1.8 |
| P1.6 | Pi-team dispatch via Warren | second bottleneck; blocks P1.15 |
| P1.15 | Real PR produced on sample repo | **the lights-on moment** |
| P1.18 → P1.19 | Bot review-comment detection → Pi-Pair fix → PR green | the self-correction loop |

**Accountability (Goal G2 — the enterprise differentiator, cheap insurance)**

| Story | Title | Note |
|---|---|---|
| P1.13 | Cost ledger per-issue + over-cap gate | costed-everything requirement |
| P1.16 | Audit chain walker (8 hops) | reconstructable lineage |
| P1.17 | Phase-1 exit gate (6 assertions) | proves the slice |

**Memory — PROJECT TIER ONLY, plumbing-first (the flywheel)**

| Item | Note |
|---|---|
| P0.9 | Hindsight banks (`qds-product` + `qds-meta` — **two banks, not four**) + mulch import |
| P1.11 | Hindsight prime (pre-exec recall) + retain (post-exec learning) |
| Hooks | pre-session recall (charter + antipatterns), post-session retain, post-skill retain |
| Review Harvester | **the one cron agent to build** — external ground truth, ~9 fires, feeds the yield-curve KPI |

**Quality signal & safety**

| Story | Title | Note |
|---|---|---|
| P0.5 | Pi-lens headless (diagnostics) | quality signal inside nodes |
| P1.9 | Restart policy (classify → retry/wall-clock caps) | safety |

> **Story accounting (closes the §3.3 budget loop).** The 18 stories above are the entire KEEP set (64 pts;
> ~29-pt serial critical path). **Every other Phase-0/Phase-1 story is DEFERRED** — see §4.2 for the explicit
> list and each story's defer rationale. Do not absorb a deferred story into KEEP under schedule pressure; close
> the budget gap per §3.3, not by widening scope.
>
> **Conditional trims (decision triggers, not vague "if tight"):**
> - **P0.6 (LSP provision, 3 pts)** is NOT in KEEP. It is DEFERRED unless: SPIKE-4 exits green in <0.5 day AND
>   Dev B has ≥2 days of week-1 buffer after P0.1/P0.2/P0.9/P0.4. If kept, trim its navigation surface to
>   diagnostics-only. P0.5 alone carries the core quality signal; P0.6 + P1.7 are the richer, deferrable gate.

### 4.2 DEFER — build as seams now, fill later (zero-rework target)

Every row below is deferred. The "seam" column is what gets built now so the deferred work plugs in later with no
rework. Point values are from story frontmatter (ground truth); "—" marks a workstream, not a single story.

| Deferred item | Pts | Seam to build now (so it plugs in) | Defer rationale |
|---|---|---|---|
| Factory tier — all 4 banks + 4 agents | — | `promote_to_factory(finding, type)` typed interface → no-op/log sink (§6.1) | §3.2: needs N>1 repos |
| Project Synthesizer, Meta-Optimizer, Blind-Spot | — | shared **agent-runner interface** `reflect → response_schema → retain` (§6.2) | §3.1: nothing to analyze in 4 wks |
| Transfer learning, A/B routing | — | factory-meta experiment schema stubbed; single-arm router only (matches NG4) | needs N>1 repos |
| GitNexus analyze (P0.10) | 3 | leave MCP tool registration point open in P0.7 (§6.1) | off critical path; graph IQ deferred |
| GitHub seeds mirror (P1.3) | 4 | intake writes local `.seeds/issues.jsonl` only (§6.4 manifest) | see scope boundary below |
| Mental models, directives enforcement | — | declarative bank manifest (§6.4) — append later | config-only, no rework |
| P0.3 — mixed-model 3-agent demo | 4 | Warren multi-model dispatch exercised by P1.6 | re-proven by P1.6 on the real path; Phase-0 demo is redundant validation |
| P0.6 — LSP provision | 3 | pi-lens `lsp_diagnostics`/`lsp_navigation` surfaces ride with P0.5 | P0.5 carries core signal; full LSP gate (P1.7) defers together |
| P0.8 — GitHub webhook → session | 3 | webhook correlation validated by SPIKE-6 (mocked PR ok); audit polls first PR | push→session trigger is the G3 autonomous loop; G2 audit polls (P1.18 pattern) for the first PR |
| P0.11 — Phase-0 exit gate | 3 | per-story tests as informal checkpoints; P1.17 is the slice gate | P1.17 (KEEP) validates the slice; P0.11 is a mid-slice checkpoint, re-add first if buffer |
| P1.5 — scored model router | 4 | single-arm fixed-config router (matches NG4); router-selection log stub | optimization (cost/quality), not lights-on; P1.15 runs on fixed config |
| P1.7 — post-edit `lsp_diagnostics` gate | 3 | gate hook point present in emit phase; ast-grep fallback path | quality hardening; depends on deferred P0.6 |
| P1.8 — protocol run + issue correlation | 3 | correlation keys (runId/issueId/sessionId) on every artifact from day 1 (§6.3) | §6.3 seam carries issue correlation for audit; full run lifecycle + live streaming is polish |
| P1.10 — executionPolicy approve/resume webhook | 4 | decide-phase gate point left in protocol template (P1.4) | §9 Gate 1 "gated approvals" = GitHub PR-review approval (native), not the decide-phase webhook |
| P1.12 — mulch prime/record | 3 | mulch binary validated by SPIKE-7; prime/record hook point in harness | G3 house-style polish; the primary flywheel is the Hindsight banks (P0.9/P1.11), not mulch |
| P1.14 — outcome record + router log | 3 | outcome vector captured in cost_events (P1.13); runId keying via §6.3 | router-selection log needs deferred P1.5; cost data flows via P1.13 |

> **P1.3 scope boundary (explicit).** P1.3 in this window = **local write only**: intake writes
> `.seeds/issues.jsonl`. **Do NOT implement the GitHub mirror** — that is the deferred half. Two devs building
> different halves of a "one-directional" story is the failure mode; this line makes the boundary binary.
>
> **P0.8 / P1.10 audit path.** The first real PR's audit chain (P1.16) is reconstructed via **polling**
> (P1.18 polls comments; PR merge status polled) + the §6.3 correlation keys, not via live webhooks. P0.8
> (webhook ingestion) and P1.10 (executionPolicy webhook) activate when the G3 autonomous push→session loop
> comes online.

### 4.3 Rationale summary

- Cuts come from §3.1 (analysis agents can't prove value in 4 weeks) and §3.2 (factory tier needs N>1 repos).
- Everything cut is reachable by **adding config/schema/cron against an existing interface**, not new architecture. Seam traceability:
  - Factory tier → §6.1 `promote_to_factory`
  - Proactive/analysis agents → §6.2 agent-runner interface
  - Audit + cross-project correlation → §6.3 correlation keys (also serves deferred P1.8/P1.14 issue correlation)
  - Bank/label/directives config → §6.4 declarative manifest
- The slice is chosen so every one of the four product goals (G1 useful, G2 accountable, G3 self-improving-via-flywheel, G4 safe) has at least one shipped, tested capability.
- **Budget caveat (§3.3):** the 64-pt slice exceeds the 45–50-pt throughput estimate. Treat 45–50 as committed, 64 as stretch; close the gap by trimming the slice or extending the window — never by absorbing deferred stories.

---

## 5. The 4-week shape (2 devs)

Dev A = strongest engineer on the critical-path bottlenecks. Dev B = balanced, owns plumbing + leaf features.

| Week | Dev A (critical path / bottlenecks) | Dev B (plumbing / memory / safety) | Milestone |
|---|---|---|---|
| **1** | Days 1–2: **SPIKE-1 (Hindsight)** w/ Dev B. Then P0.7 SwarmClaw (allowlist via SPIKE-2). | Days 1–2: SPIKE-1 **(+ SPIKE-9 in parallel, 0.5d — SwarmClaw→Hindsight bridge execution-model decision)**. Then P0.1, P0.2, P0.9 banks. P0.4 guard-kill early. | Foundations green; Hindsight primitives validated or pivoted |
| **2** | P1.1 → P1.4 (protocol template, via SPIKE-5) → P1.6 (Warren, via SPIKE-3) | P0.5 pi-lens (SPIKE-4), P1.11 memory prime/retain, P1.13 cost ledger, **correlation-key plumbing** | Dispatch path executable end-to-end in a harness |
| **3** | **P1.15 real PR** (target ~day 15; via SPIKE-6 webhook correlation) → P1.16 audit chain | Review Harvester (SPIKE-8) + retain hooks; P1.9 restart policy | **Lights-on**: first autonomous audited PR |
| **4** | P1.18 → P1.19 review→fix loop; bug-fix fallout from P1.15 | P1.17 exit gate; defer-seam stubs (§4.2); end-to-end soak | Slice complete, hardened, audited |

**Sequencing rules**

- Spikes are gates: **do not start the feature code a spike protects until the spike exits green or a documented fallback is chosen.**
- **SPIKE-5 carve-out ("non-blocking" defined).** SPIKE-5 (weighted-scoring strategy) is the one spike labeled non-blocking. It runs **offline in parallel** with week-2 P1.4 work; P1.4 may *start* before SPIKE-5 exits, but P1.4's decide-phase **scoring does not finalize** until SPIKE-5 exits green (chosen scorer + weights) or its rubric-judge fallback is chosen. "Non-blocking" means it gates *finalization*, not *entry* — consistent with the gate rule above.
- P1.15 is the integration validator and **will surface bugs in earlier stories** — reserve 2–3 days of week-3/4 buffer for fallout.
- Correlation keys (runId/issueId/sessionId) are threaded from **day one** on every artifact. Retrofitting the 8-hop audit chain is the most expensive mistake available here.

---

## 6. Adaptability seams (so deferred work plugs in with zero rework)

These four seams are the difference between "we cut scope" and "we painted ourselves into a corner." Build them
into the KEEP slice.

### 6.1 `promote_to_factory(finding, finding_type)` — factory-tier seam
Typed function appended to each project agent's retention step. In the 4-week build it validates the finding,
computes the **compound document id** `promoted-{project_id}-{finding_type}-{run_date}-{content_hash[:8]}`
(per QDS-MEM-002 §5.2, where `run_date = datetime.now(timezone.utc).date().isoformat()` — a **UTC `YYYY-MM-DD`** string, e.g.
`2026-06-13`, so the id is timezone-stable across agents/envs regardless of local TZ and **storage-safe**: date-only ISO has no
`:`/space and is a valid key in document stores / Redis-style KV stores that forbid special characters in keys) and writes to a
**no-op / log sink**. The id is collision-safe because the `[:8]` (32-bit)
hash is a *suffix inside a narrow (project, type, date) bucket*, not a bare key — so the birthday-paradox bound
(~65k same-bucket entries) is unreachable in practice (same-content collisions are intentional dedup, not data
loss). If a future use ever adopts a *global bare-hash* key (e.g. cross-project transfer-learning fingerprint),
widen to `[:12]`/`[:16]` at that point; the compound id needs no change now. Later: point the sink at the two
factory banks and deploy the four factory agents. No call-site changes.

### 6.2 Agent-runner interface — proactive-agent seam
Review Harvester, Synthesizer, Meta-Optimizer, Blind-Spot all share one shape: `reflect(bank, query, budget,
response_schema, include_facts) → validate → retain(tags, document_id)`. Build **one runner abstraction** now
(used by Review Harvester). Later agents = `{schema, query, cron}` config, not new code.

### 6.3 Correlation keys everywhere — audit + cross-project seam
Every artifact (session, issue, run, cost event, decision, decomposition, Pi result, memory write) carries
`runId / issueId / sessionId`. This is simultaneously what makes the audit chain (now, G2) and cross-project
analysis (later, factory tier) possible — without a migration.

### 6.4 Declarative bank manifest — memory-config seam
Entity labels, dispositions, missions, directives, mental models, observation scopes live in **one config
manifest**, not scattered imperative setup. Adding the two factory banks, mental models, or directives later =
append to the manifest + apply. (Bank/label schemas in QDS-MEM-001 Appendix B and QDS-MEM-002 §4.)

---

## 7. SPIKE SPECIFICATIONS — the primary planning artifact

> **How to use this section.** Each spike is the de-risking work that runs *before* the feature code it
> protects. The specs below are structured so an implementing agent can expand any one into a full plan of
> attack. Every spike must produce: (a) a written go/no-go verdict, (b) the validated facts or the failure
> evidence, (c) a chosen fallback if the primary approach fails, (d) any reusable harness code. Spikes are
> **time-boxed**; on time-box expiry, take the fallback and log it — do not let a spike become the project.

### Spike expansion template (apply to each spike below)

```
SPIKE-N: <name>
  Protects:        <story/component that must not start until this is green>
  Time-box:        <hours/days>
  Owner:           <dev A | dev B>
  Objective:       <the one question this spike answers>
  Why load-bearing: <what breaks downstream if the assumption is false>
  Hypotheses:      <numbered, each independently falsifiable>
  Method:          <exact steps / commands / minimal harness>
  Success criteria: <green = ...>
  Failure criteria: <red = ...>
  Fallback:        <what we do if red, so the project continues>
  Artifacts:       <what the spike leaves behind: notes, harness, schema>
  Exit decision:   <go / go-with-fallback / escalate>
```

---

### SPIKE-1 — Hindsight primitives validation  ★ HIGHEST LEVERAGE
- **Protects:** all memory feature code (P0.9, P1.11, hooks, Review Harvester, every proactive agent).
- **Time-box:** 2 days, both devs. **Runs first, before any other spike.**
- **Objective:** prove the five load-bearing Hindsight primitives behave exactly as QDS-MEM-001/002 assume,
  against the **live Hindsight build** (not the docs).
- **Why load-bearing:** the entire self-improvement thesis is built on these. If any behaves differently, the
  memory layer needs redesign — better to know on day 2 than week 3.
- **Hypotheses to falsify (each independently):**
  1. `reflect()` with a `response_schema` returns valid, schema-conforming structured output reliably (test
     with `META_OPTIMIZER_SCHEMA`-shaped and `REVIEW_HARVEST_SCHEMA`-shaped schemas, incl. required-field and
     nested-array cases).
  2. Mental models created with `trigger={"refresh_after_consolidation": True}` actually auto-refresh after a
     retain triggers consolidation (and the API accepts that trigger field).
  3. `CronCreate` produces durable, recurring jobs that survive restart and fire on schedule.
  4. Observation consolidation: confirm whether it is automatic post-retain or requires an explicit call;
     measure latency from retain → consolidated observation → freshness-trend availability.
  5. `tags_match` semantics — `all` vs `all_strict` vs `any` — match the design's pre-session recall intent
     (the design implicitly uses `all`; `all_strict` breaks recall if substituted).
- **Method:** stand up the two project banks from the manifest (§6.4) with full config; scripted retain →
  recall → reflect(response_schema) → consolidate cycle; a temporary CronCreate firing on a 1-minute schedule
  to observe durability; assert structured outputs against the schemas.
- **Success criteria (green):** all five hypotheses green; reusable bank-setup + retain/recall harness produced.
- **Failure criteria (red):** any primitive deviates from the design's stated behavior (wrong structured-output
  shape, auto-refresh/consolidation not firing, CronCreate not durable, or `tags_match` semantics mismatched) —
  captured as an observed-behavior diff, not a judgment call.
- **Fallback:** for any red primitive, choose: (a) client-side schema enforcement if `response_schema` is
  unreliable; (b) explicit consolidation/refresh calls in the agent runner if auto-triggers don't fire;
  (c) external scheduler (system cron / scheduled wakeup) if `CronCreate` is not durable.
- **Artifacts:** (1) verdict doc with a per-primitive observed-behavior table + go/no-go; (2) reusable
  bank-setup + retain/recall/reflect harness (becomes the Review Harvester's substrate); (3) a written
  `tags_match` decision (which mode the build standardizes on).
- **Known landmines (status as of this revision):** ~~missing `import json` in 6 design code blocks~~ —
  **RESOLVED** (PR #20 added `import json` to both design docs; verified present at
  docs/planning/hindsight-memory-master-design.md and docs/planning/hindsight-factory-tier-design.md); hardcoded `biospark33/QDS-Factory`
  GitHub paths — **intentional** (single-repo design docs; parameterize at build time, not in the design); the
  1st-of-month `07:23/07:25/07:27` cron cluster — **still live** (API contention, R8).
- **Exit decision:** go / go-with-documented-fallbacks. **No memory feature code starts until this exits.**

### SPIKE-2 — SwarmClaw command-allowlist & agent+MCP registry (OQ-18)
- **Protects:** P0.7 (the critical-path bottleneck, 9 security invariants, ~200 LOC).
- **Time-box:** 1–2 days, Dev A.
- **Objective:** validate the command-allowlist enforcement model and the atomic agent/MCP registry
  (max 32 servers / 64 agents) in isolation before integrating into P0.7.
- **Why load-bearing:** P0.7 blocks P1.1/P0.8/P0.9; its security invariants (INV-SC2/SC3/SC5) are the hardest
  part. A wrong allowlist model means a security rewrite mid-sprint.
- **Hypotheses:** allowlist denies-by-default and cannot be bypassed via arg injection / shell metacharacters;
  registry add/remove is atomic under concurrent access; MCP invoke timeout behaves.
- **Method:** isolated prototype of the allowlist matcher + registry with an adversarial test set (injection,
  path traversal, race on registry mutation).
- **Success criteria (green):** allowlist passes the adversarial set (no bypass) and the registry is race-free
  under concurrent mutation.
- **Failure criteria (red):** any adversarial input bypasses the allowlist, OR a concurrent registry mutation
  produces a lost update / torn state.
- **Fallback:** adopt a stricter wrapper (explicit argv allowlist, no shell) and/or a mutex-guarded registry;
  re-run the adversarial set until green.
- **Artifacts:** (1) verdict doc naming the chosen allowlist model + registry concurrency control; (2) the
  adversarial test set (becomes P0.7's security-regression suite).
- **Exit decision:** go-with-chosen-allowlist-model before P0.7 integration.

### SPIKE-3 — Warren subprocess lifecycle, exit-code mapping, resource watchdog
- **Protects:** P1.6 (second bottleneck; blocks P1.15).
- **Time-box:** 1–2 days, Dev A.
- **Objective:** validate Warren subprocess management — clean spawn/teardown, the exit-code → outcome mapping
  (assumed `0=ok, 1=logic, 2=transient, 3=overflow`), the RSS watchdog + `SIGKILL` on >4GB, and the
  `O_NOFOLLOW` symlink defense (TOCTOU).
- **Why load-bearing:** if exit codes are mismatched, the restart-policy classifier (P1.9) misroutes; if the
  watchdog leaks, unattended runs OOM the host.
- **Hypotheses:** Warren's real exit codes match the assumed table; RSS sampling + SIGKILL is reliable;
  `O_NOFOLLOW` blocks the symlink race.
- **Method:** drive Warren with crafted jobs that exit each code path; a memory-hog job to trip the watchdog;
  a symlink-swap harness for the TOCTOU case.
- **Success criteria (green):** observed exit codes map cleanly to the assumed table; the watchdog kills the
  memory-hog cleanly without orphaning; the symlink swap is rejected.
- **Failure criteria (red):** an observed exit code does not fit the assumed mapping (unclassifiable), OR the
  watchdog fails to kill within budget, OR the symlink swap succeeds.
- **Fallback:** build a table-driven exit-code mapper from observed codes; and/or move resource limits to OS
  cgroup/`ulimit`; and/or harden the open path beyond `O_NOFOLLOW`.
- **Artifacts:** (1) verdict doc with the validated exit-code table + watchdog/TOCTOU results; (2) the crafted
  job fixtures (become P1.6/P1.9 regression tests).
- **Exit decision:** go-with-validated-mapping before P1.6 integration.

### SPIKE-4 — pi-lens headless invocation & LSP diagnostics (OQ-2)
- **Protects:** P0.5 (and the in-node quality signal generally); also de-risks the post-edit `lsp_diagnostics`
  gate (FR-EX-11, dependency of the deferred P1.7) and the TDI emit path (FR-EX-8).
- **Time-box:** 0.5–1 day, Dev B.
- **Objective:** confirm the canonical headless invocation, latency ≤3s (NFR-PERF-6), graceful absence-path
  behavior (TDI fallback), **and that headless `lsp_diagnostics` emits machine-readable results** (the FR-EX-11
  blocker). Note: the Phase-0 spikes (PRD §5.4 / Appendix D, 2026-06-06) already established that pi-lens
  v3.8.47 is installed, registers `lsp_diagnostics`/`lsp_navigation`/`ast_grep_*`, and that "machine-readable
  JSON emission [is] confirmed headless"; TDI is a TUI slash-command, headless via on-disk `~/.pi-lens/`
  artifacts. This spike **re-validates those facts in the SwarmClaw build context** and closes the one residual
  (live diagnostic content, blocked on an API key per the PRD).
- **Why load-bearing:** the in-node quality signal and the post-edit gate both depend on headless, parseable
  pi-lens output. If headless JSON/RPC emission is unstable in this build, FR-EX-11 degrades to FR-EX-12
  (ast-grep + tests) — a quality loss we must decide deliberately, not discover at P1.7.
- **Hypotheses:** headless `--mode json` / `--mode rpc` is stable and parseable (re-confirm v3.8.47);
  `lsp_diagnostics` returns machine-readable findings headless (FR-EX-11 dependency); the latency budget holds
  (≤3s p95); the absence path (no pi-lens / no language server) degrades, not crashes.
- **Method:** run pi-lens headless (`--mode json`, and `--mode rpc` for TDI artifacts) against a fixture file
  with a known type error; capture `lsp_diagnostics` output and assert it is valid JSON with a findings array;
  time the call (≥20 runs, report p95); run with pi-lens absent and with no language server to confirm graceful
  degradation + a logged waiver.
- **Success criteria (green):** documented canonical invocation + `lsp_diagnostics` parseable JSON + latency
  p95 ≤3s + absence path logs a waiver (no crash).
- **Failure criteria (red):** headless `lsp_diagnostics` is TUI-only/unparseable, OR p95 latency >3s, OR the
  absence path crashes/hangs.
- **Fallback:** define the diagnostics-only fallback (FR-EX-12: ast-grep + test-pass as the emit precondition)
  and the TDI emit fallback (FR-EX-8: pi-lens warning count via `--mode rpc` as a logged proxy). This also
  feeds the §9.3 OQ-2 logged-fallback in the PRD.
- **Artifacts:** (1) verdict doc: go / go-diagnostics-only, with the canonical invocation string + latency
  numbers; (2) a small `pi-lens headless` shim/wrapper used by P0.5 and (later) P1.7.
- **Exit decision:** go / go-diagnostics-only.

### SPIKE-5 — Protocol-template weighted scoring / embedder strategy
- **Protects:** P1.4 (blocks P1.6/P1.8).
- **Time-box:** 1–2 days, Dev A (offline, runs in parallel — see §5 SPIKE-5 carve-out: gates P1.4 finalization, not entry).
- **Objective:** choose the compare/decide scoring approach for the 5-phase template — validate whether TF-IDF
  is sufficient or too heavy, and finalize weighted-scoring weights, before Warren integration.
- **Why load-bearing:** the decide phase picks which candidate result to emit. A scorer that can't discriminate
  good from bad either emits weak output (hurting PR quality, G1) or forces an expensive LLM judge on every
  node (hurting cost, G2). Settling this offline prevents a mid-sprint scorer swap that perturbs every decide
  result.
- **Hypotheses:** a lightweight similarity/scoring function discriminates good vs bad candidate results well
  enough for the decide phase without a heavy embedder.
- **Method:** offline prototype scoring on sample candidate outputs; compare TF-IDF vs a simpler heuristic vs a
  small embedding call; tune weights.
- **Success criteria (green):** chosen scorer + weights documented; the discriminator separates good/bad
  sample candidates with a usable margin.
- **Failure criteria (red):** no lightweight scorer discriminates the sample set with a usable margin (all
  candidates score ~equally, or rankings are unstable).
- **Fallback:** fall back to an explicit rubric-based LLM judge in the decide phase (higher cost, logged).
- **Artifacts:** (1) verdict doc naming the scorer + weights (or the LLM-judge fallback); (2) the offline
  scoring harness + labeled sample set (becomes the decide-phase regression fixture).
- **Exit decision:** go-with-chosen-scorer before P1.4 finalization.

### SPIKE-6 — Webhook correlation-key threading
- **Protects:** P1.15 and P1.16 (the audit chain).
- **Time-box:** 1 day, Dev A.
- **Objective:** prove the correlation key (PR branch name + run metadata) threads cleanly from dispatch →
  Warren → GitHub PR → webhook → correlation, so the 8-hop audit chain never loses a hop.
- **Why load-bearing:** one missing correlation key = the entire audit chain (G2) fails, and it's discovered at
  P1.16 — too late. This spike makes §6.3 concrete.
- **Hypotheses:** the branch-naming + metadata scheme uniquely correlates a webhook event back to its run and
  issue.
- **Method:** integration test that fires a dispatch, opens a real (or mocked) PR, receives the webhook, and
  asserts full-chain resolution **before** building the full P1.15 dispatch. (A mocked PR is acceptable — see
  §4.2 P0.8/P1.10 note; the first real PR's audit uses polling.)
- **Success criteria (green):** the correlation scheme resolves every hop (dispatch → run → branch → PR →
  webhook → correlation) for both real and mocked PRs.
- **Failure criteria (red):** any hop cannot be uniquely correlated back to its run/issue (ambiguous or missing
  key).
- **Fallback:** add an explicit correlation id to PR body/metadata and re-test until every hop resolves.
- **Artifacts:** (1) verdict doc with the validated branch-naming + metadata scheme; (2) the dispatch→webhook
  integration test (becomes P1.16's audit-chain regression).
- **Exit decision:** go-with-validated-correlation-scheme before P1.15.

### SPIKE-7 — mulch binary & latency
- **Protects:** P1.12 (mulch prime/record — DEFERRED) and any dependent dispatch priming. Validates the mulch
  *seam* so the P1.12 defer is zero-rework.
- **Time-box:** 0.5 day, Dev B.
- **Objective:** confirm the `mulch` binary is/will-be present and that the prime ≤10s / record ≤5s latency
  budgets hold, using the real CLI verbs (not a guess).
- **Why load-bearing:** if `mulch` is absent or slow, the house-style prime step either blocks dispatch
  (latency-budget blowout) or silently no-ops. Knowing this before the P1.12 defer hardens lets the seam degrade
  correctly (`waiver.reason: 'mulch-unavailable'`) instead of failing at runtime.
- **Hypotheses:** `mulch` is present at the expected path/version; `mulch prime --domain <d> --json` and
  `mulch record --domain <d> --content <s> --source <s>` behave per the P1.12 contract; prime p95 ≤10s and
  record p95 ≤5s.
- **Method:** `command -v mulch` + `mulch --version` to confirm `/usr/local/bin/mulch` v0.6.3 (or current
  stable); run `time mulch prime --domain typescript --json` against an empty and a populated
  `.mulch/expertise/` directory (empty must return `{entries:[]}`, not error — per P1.12 "empty expertise is
  not a failure"); run `time mulch record --domain typescript --content "..." --source spike-7`; repeat ≥10×,
  report p95 for both verbs.
- **Success criteria (green):** binary present at expected version; prime/record match the P1.12 contract;
  prime p95 ≤10s and record p95 ≤5s; empty-prime is a clean baseline.
- **Failure criteria (red):** binary absent/wrong version, OR a verb's output shape mismatches the contract,
  OR either latency budget exceeds p95.
- **Fallback:** vendor/pin the binary in the P0 env; or raise the timeouts with logged justification and a
  `waiver` on the prime step.
- **Artifacts:** (1) verdict doc: binary presence/version + p95 latency numbers; (2) a `mulch` CLI wrapper
  snippet usable by the (deferred) P1.12 prime/record hooks.
- **Exit decision:** go / go-with-adjusted-budgets.

### SPIKE-8 — GitHub review-harvesting extraction
- **Protects:** the Review Harvester cron agent (the one analysis agent in the KEEP slice).
- **Time-box:** 0.5–1 day, Dev B.
- **Objective:** validate the `gh` extraction of CodeRabbit / Gemini-Code-Assist inline + review comments,
  severity classification, and that paths/queries are parameterized (not hardcoded to one repo).
- **Why load-bearing:** the Review Harvester is the KEEP slice's only source of *external* ground truth — it
  feeds the yield-curve KPI and is the one cron agent that proves value inside 4 weeks. If extraction is
  unreliable or hardcoded to one repo, the flywheel's strongest signal is corrupted from day one.
- **Hypotheses:** the `gh pr list` + `gh api .../comments` + `.../reviews` queries reliably return bot comments
  with parseable severity; token cost per harvest is bounded.
- **Method:** run the three `gh` queries against existing merged PRs (the repo has PR #20 history); measure
  comment volume and token cost; confirm the `REVIEW_HARVEST_SCHEMA` reflect call returns conformant output
  (depends on SPIKE-1 hypothesis 1).
- **Success criteria (green):** parameterized extraction (repo via config) + bounded token cost; the reflect
  call returns `REVIEW_HARVEST_SCHEMA`-conformant output.
- **Failure criteria (red):** queries miss inline vs review comments, OR severity is unparseable, OR token cost
  is unbounded without a cap, OR output fails the schema.
- **Fallback:** add a sampling cap (N comments/PR, M PRs/harvest) and parameterize the repo via config; re-run
  until conformant and bounded.
- **Artifacts:** (1) verdict doc: query shapes + measured token cost + cap value; (2) the parameterized `gh`
  extraction module (becomes the Review Harvester's collector).
- **Exit decision:** go-with-parameterized-extraction.

### SPIKE-9 — SwarmClaw→Hindsight bridge execution model (SwarmClaw-hook parity)
- **Protects:** P1.11 (Hindsight prime/retain — KEEP). Resolves the §10 "bridge execution model" OQ before
  P1.11 starts.
- **Time-box:** 0.5 day, Dev B, week 1 (in parallel with SPIKE-1).
- **Objective:** decide how the SwarmClaw→Hindsight classification bridge runs in *this* build — a SwarmClaw
  post-session hook (the design's stated model), a separate agent, or manual — by validating what SwarmClaw
  actually exposes.
- **Why load-bearing:** the design (QDS-MEM-001 §6.2) assumed a Claude Code post-session hook; SwarmClaw is the
  *new* (post-pivot) orchestrator. If SwarmClaw has no post-session/retain hook equivalent, the bridge can't
  retain learnings automatically — the flywheel (G3) silently breaks at P1.11. This is a design-decision gate
  on an in-scope KEEP story, so it meets the spike threshold.
- **Hypotheses:** SwarmClaw exposes a session-end (or phase-end) hook/callback that can invoke the
  classification + retain pipeline; if not, a separate lightweight retain agent or a manual retain step is
  viable without new architecture.
- **Method:** inspect the SwarmClaw build for a session-end/phase-end hook surface (grep the registry/protocol
  template for hook or callback registration); if present, prototype the bridge call; if absent, prototype the
  separate-agent and manual options; document the chosen model against QDS-MEM-001 §6.2.
- **Success criteria (green):** a chosen, prototype-validated bridge execution model (hook / agent / manual)
  that retains to the project banks post-session.
- **Failure criteria (red):** none of the three models prototypes cleanly without new architecture (i.e., the
  bridge requires building SwarmClaw hook infrastructure first).
- **Fallback:** manual retain step for the 4-week window (operator-triggered post-session retain), with the
  hook/agent model deferred behind the §6.2 seam — the flywheel still runs, just not fully autonomous.
- **Artifacts:** (1) decision doc: chosen bridge model + the SwarmClaw hook-parity finding; (2) the bridge
  call-site stub (hook or agent) wired for P1.11.
- **Exit decision:** go-with-chosen-bridge-model before P1.11 starts.

---

## 8. Risk register

| # | Risk | Severity | Trigger / signal | Mitigation |
|---|---|---|---|---|
| R1 | Hindsight primitive behaves unlike the design | **Critical** | SPIKE-1 red | client-side schema enforcement, explicit consolidation/refresh, external scheduler (SPIKE-1 fallbacks) |
| R2 | P0.7 SwarmClaw slips (security invariants) | **High** | allowlist/registry edge cases | SPIKE-2 first; assign strongest dev; isolate allowlist |
| R3 | P1.6 Warren subprocess edge cases | **High** | exit-code/OOM/symlink surprises | SPIKE-3; OS-level resource limits fallback |
| R4 | Audit chain loses a hop | **High** | P1.16 can't resolve a PR | SPIKE-6; correlation keys from day 1 (§6.3) |
| R5 | P1.15 surfaces cascade of earlier bugs | **High** | first real PR fails | 2–3 day buffer reserved in weeks 3–4 |
| R6 | Doc-drift thrash (Paperclip vs SwarmClaw) | Medium | devs implement conflicting substrate | §2 action item week 1 |
| R7 | Scope creep back toward factory tier / 8 agents | Medium | "let's just add the Synthesizer too" | this doc's cut line; seams make deferral cheap |
| R8 | Cron contention 1st-of-month cluster | Low | overlapping API calls | re-stagger schedules during SPIKE-1 |
| R9 | Review Harvester token cost unbounded | Low | large PR review volume | SPIKE-8 sampling cap |
| R10 | **Dev A single-point-of-failure** | **High** | Dev A blocked >2 days | Dev A owns all critical-path bottlenecks (P0.7, P1.1, P1.4, P1.6, P1.15, P1.16) + 4 of 9 spikes. Cross-train Dev B on the P0.7 design during week 1 so Dev B can at minimum unblock P1.1 entry; capture the SPIKE-2 allowlist verdict in docs so it isn't tacit knowledge. **Week-3 contingency (P1.15 = the single hardest Dev A dependency):** if Dev A is blocked during week 3, Dev B advances the **P1.16 audit-walker mechanics** and the **P1.17 exit-gate harness** against SPIKE-6 mocked-PR data while Dev A recovers — both are independently buildable from the §6.3 correlation keys (final pass of each still needs the real P1.15 PR, but the walker/gate scaffolding does not). **P1.15 blocked >3 days = extend the window by 1 week before touching any deferred scope** (never absorb a §4.2 DEFER story to cover the slip — see §3.3). |
| R11 | Bridge execution model decided late | Medium | SPIKE-9 red or deferred | The SwarmClaw→Hindsight bridge is a design-decision gate on KEEP story P1.11. Run SPIKE-9 in week 1; if no clean hook, take the manual-retain fallback so the flywheel still runs (not fully autonomous) |
| R12 | Channel service unavailability (intake path) | Low | external coms outage / rate-limit | P0.2 coms-vendor smoke-test de-risks viability; for the 4-week slice the `/qds` intake is exercised locally — the external channel (Telegram/Slack) is G3 polish, deferred behind the intake seam |

---

## 9. Definition of done for the 4-week slice (enterprise-grade gates)

The slice is **done** when all hold (maps to P1.17's exit assertions plus rigor gates):

1. **G1 lights-on:** a `/qds` intake produces ≥1 real reviewed PR on the sample repo with no human input except
   gated approvals (GitHub PR-review approval — see §4.2 P1.10 note; the decide-phase executionPolicy webhook is
   deferred).
2. **G2 accountable:** for that PR, the full 8-hop audit chain reconstructs with **no missing hop** (reconstructed
   via polling + the §6.3 correlation keys for the first PR — see §4.2 P0.8 note), and cost/story is queryable
   from the `cost_events` ledger.
3. **G3 flywheel:** post-session/post-skill retain and pre-session recall are live; banks accumulate observations
   (**≥10 retain events logged across the 4-week window**); the Review Harvester runs on cron and **completes
   ≥1 harvest that writes ≥1 `REVIEW_HARVEST_SCHEMA`-conformant document** to the project bank; the **two
   deferred-agent seams** (§6.1 `promote_to_factory`, §6.2 agent-runner) are tested as no-ops; correlation keys
   (§6.3) are present on every artifact; the bank manifest (§6.4) is declarative and append-only.
4. **G4 safe:** a synthetic loopy prompt **terminates via a guard, not by exhausting credits** — **both the P0.4
   turn cap AND the wall-clock cap fire under test**; the restart policy enforces retry/wall-clock caps; the
   over-cap gate fires.
5. **Rigor:** every KEEP story has tests; security invariants (P0.7 allowlist, P1.3 sanitization) have adversarial
   tests; correlation keys present on every artifact; **no secrets in artifacts — verified by a pre-commit secret
   scan (e.g. gitleaks) plus a manual audit of hardcoded `biospark33/QDS-Factory` paths**; spikes each left a
   written verdict; **any spike that exited red-with-fallback has its fallback code merged and tested**;
   **latency budgets confirmed: pi-lens headless ≤3s in CI (SPIKE-4); mulch seam ≤10s validated at the SPIKE-7 exit as a
   one-shot seam-validation (NOT a CI regression — P1.12 mulch prime/record is DEFERRED per §4.2, so mulch does not enter CI
   until P1.12 ships)**.

---

## 10. Open questions to resolve in week 1 (non-blocking, run in parallel)

- **OQ-2** pi-lens headless invocation → SPIKE-4.
- **OQ-18** SwarmClaw command allowlist → SPIKE-2. *(Renumbered from a draft "OQ-7": PRD v4 Appendix C already defines OQ-7 = the config-policy / recomputed-policy artifact store, part of deferred v5 Layer-B self-optimization — reusing it here broke traceability. OQ-18 is the first free number; PRD v4 tops out at OQ-17.)*
- **OQ — substrate of record:** confirm SwarmClaw/Warren is canonical; annotate PRD/architecture (§2).
- **OQ — Warren exit codes:** validate the assumed table → SPIKE-3.
- **OQ — mulch pre-install:** binary presence/version → SPIKE-7.
- **Directives source:** which `_bmad-output/` security invariants become Hindsight directives (QDS-MEM-001 §3.1) — extract during P0.9 bank seeding.
- **Bridge execution model:** is the SwarmClaw→Hindsight classification bridge a SwarmClaw hook, a separate agent, or manual? → **SPIKE-9**. (QDS-MEM-001 §6.2 specifies a "Claude Code post-session hook that calls the bridge" — not fully open; the real question is whether SwarmClaw, the post-pivot orchestrator, exposes an equivalent hook. Decide before P1.11.)

---

## 11. What this document is NOT

- Not a replacement for the design docs (QDS-MEM-001/002, PRD v4). It is the **prioritization and sequencing
  overlay** for a constrained build window. The design docs remain authoritative on *what* each component is;
  this doc is authoritative on *what to build first and what to defer.*
- Not a commitment that the full self-improving system ships in 4 weeks. It ships the **flywheel and the spine**;
  the compounding loops mature over months, by design.

---

*Maintainers: update §4 (cut/keep/defer) and §7 (spikes) as spikes resolve. When a spike exits, record its
verdict and any fallback inline so the next agent inherits the decision, not just the question.*
