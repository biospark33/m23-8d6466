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
  - _bmad-output/sprint-artifacts/phase-1/stories/*        # 19 stories, 61 pts (SwarmClaw/Warren ground truth)
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
"Hermes" bots + Gitnexus/pi-lens (code intelligence)**. The active sprint stories already reflect this pivot;
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
| Code intelligence | GitNexus + claude-mem | Gitnexus + pi-lens + mulch + Hindsight | stories |

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
| Phase-1 stories | 19 stories / 61 pts | sprint artifacts |
| Project-tier memory rollout | 6-phase implementation | QDS-MEM-001 |
| Project-tier proactive agents | 4 (Synthesizer, Meta-Optimizer, Blind-Spot, Review Harvester) | QDS-MEM-001 |
| Factory-tier memory | 2 banks + promotion pipeline + A/B + transfer learning | QDS-MEM-002 |
| Factory-tier proactive agents | 4 (Cross-Project Synthesizer, Factory Optimizer, Portfolio Harvester, Factory Blind-Spot) | QDS-MEM-002 |

Dependency analysis of the stories alone (98 pts) lands at **~65% confidence at 4 weeks, realistic 5–6 weeks**,
and that excludes the entire memory rollout and 8 cron agents. A realistic 2-dev / 4-week throughput at
enterprise grade (tested, audited, hardened) is **~45–50 well-chosen points**.

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

---

## 4. Cut / Keep / Defer

### 4.1 KEEP — the bulletproof vertical slice (~45 pts critical path)

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
| P0.5 | Pi-lens headless (diagnostics) | quality signal inside nodes; trim P0.6 nav if tight |
| P1.9 | Restart policy (classify → retry/wall-clock caps) | safety |

### 4.2 DEFER — build as seams now, fill later (zero-rework target)

| Deferred | Seam to build now (so it plugs in) |
|---|---|
| Factory tier — all 4 banks + 4 agents | `promote_to_factory(finding, type)` typed interface → no-op/log sink |
| Project Synthesizer, Meta-Optimizer, Blind-Spot | shared **agent-runner interface** (`reflect → response_schema → retain`) |
| Transfer learning, A/B routing | factory-meta experiment schema stubbed; single-arm router only (matches NG4) |
| Gitnexus analyze (P0.10) | leave the MCP tool registration point open in P0.7 |
| GitHub seeds mirror (P1.3 one-directional) | intake writes the local `.seeds/issues.jsonl`; GitHub mirror later |
| Mental models, directives enforcement | declarative bank manifest (see §6.4) — append later |

### 4.3 Rationale summary

- Cuts come from §3.1 (analysis agents can't prove value in 4 weeks) and §3.2 (factory tier needs N>1 repos).
- Everything cut is reachable by **adding config/schema/cron against an existing interface**, not new architecture (see §6).
- The slice is chosen so every one of the four product goals (G1 useful, G2 accountable, G3 self-improving-via-flywheel, G4 safe) has at least one shipped, tested capability.

---

## 5. The 4-week shape (2 devs)

Dev A = strongest engineer on the critical-path bottlenecks. Dev B = balanced, owns plumbing + leaf features.

| Week | Dev A (critical path / bottlenecks) | Dev B (plumbing / memory / safety) | Milestone |
|---|---|---|---|
| **1** | Days 1–2: **SPIKE-1 (Hindsight)** w/ Dev B. Then P0.7 SwarmClaw (allowlist via SPIKE-2). | Days 1–2: SPIKE-1. Then P0.1, P0.2, P0.9 banks. P0.4 guard-kill early. | Foundations green; Hindsight primitives validated or pivoted |
| **2** | P1.1 → P1.4 (protocol template, via SPIKE-5) → P1.6 (Warren, via SPIKE-3) | P0.5 pi-lens (SPIKE-4), P1.11 memory prime/retain, P1.13 cost ledger, **correlation-key plumbing** | Dispatch path executable end-to-end in a harness |
| **3** | **P1.15 real PR** (target ~day 15; via SPIKE-6 webhook correlation) → P1.16 audit chain | Review Harvester (SPIKE-8) + retain hooks; P1.9 restart policy | **Lights-on**: first autonomous audited PR |
| **4** | P1.18 → P1.19 review→fix loop; bug-fix fallout from P1.15 | P1.17 exit gate; defer-seam stubs (§4.2); end-to-end soak | Slice complete, hardened, audited |

**Sequencing rules**

- Spikes are gates: **do not start the feature code a spike protects until the spike exits green or a documented fallback is chosen.**
- P1.15 is the integration validator and **will surface bugs in earlier stories** — reserve 2–3 days of week-3/4 buffer for fallout.
- Correlation keys (runId/issueId/sessionId) are threaded from **day one** on every artifact. Retrofitting the 8-hop audit chain is the most expensive mistake available here.

---

## 6. Adaptability seams (so deferred work plugs in with zero rework)

These four seams are the difference between "we cut scope" and "we painted ourselves into a corner." Build them
into the KEEP slice.

### 6.1 `promote_to_factory(finding, finding_type)` — factory-tier seam
Typed function appended to each project agent's retention step. In the 4-week build it validates the finding,
computes the collision-safe document id (content-hash `[:8]`, per QDS-MEM-002 §5.2), and writes to a **no-op /
log sink**. Later: point the sink at the two factory banks and deploy the four factory agents. No call-site
changes.

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
- **Success:** all five hypotheses green; reusable bank-setup + retain/recall harness produced.
- **Failure / fallback:** for any red primitive, document the actual behavior and choose: (a) client-side
  schema enforcement if `response_schema` is unreliable; (b) explicit consolidation/refresh calls in the agent
  runner if auto-triggers don't fire; (c) external scheduler (system cron / scheduled wakeup) if `CronCreate`
  is not durable.
- **Known landmines to verify here:** missing `import json` in 6 design code blocks; hardcoded
  `biospark33/QDS-Factory` GitHub paths; the 1st-of-month `07:23/07:25/07:27` cron cluster (API contention).
- **Exit decision:** go / go-with-documented-fallbacks. **No memory feature code starts until this exits.**

### SPIKE-2 — SwarmClaw command-allowlist & agent+MCP registry (OQ-7)
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
- **Success / failure / fallback:** green = allowlist passes the adversarial set and registry is race-free;
  red = adopt a stricter wrapper (e.g., explicit argv allowlist, no shell) and re-test.
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
- **Success / failure / fallback:** green = mapping confirmed + watchdog kills cleanly; red = build a
  table-driven exit-code mapper from observed codes, and/or move resource limits to OS cgroup/`ulimit`.
- **Exit decision:** go-with-validated-mapping before P1.6 integration.

### SPIKE-4 — pi-lens headless invocation (OQ-2)
- **Protects:** P0.5 (and the in-node quality signal generally).
- **Time-box:** 0.5–1 day, Dev B.
- **Objective:** confirm the canonical headless invocation (`--mode json`?), latency ≤3s, and graceful
  behavior when pi-lens is absent (TDI fallback).
- **Hypotheses:** headless JSON mode exists and is stable; latency budget holds; absence path degrades, not
  crashes.
- **Success / failure / fallback:** green = documented invocation + latency numbers; red = define the
  diagnostics-only fallback and the TDI emit fallback (this also feeds the §9.3 OQ-2 logged-fallback in PRD).
- **Exit decision:** go / go-diagnostics-only.

### SPIKE-5 — Protocol-template weighted scoring / embedder strategy
- **Protects:** P1.4 (blocks P1.6/P1.8).
- **Time-box:** 1–2 days, Dev A (offline, non-blocking).
- **Objective:** choose the compare/decide scoring approach for the 5-phase template — validate whether TF-IDF
  is sufficient or too heavy, and finalize weighted-scoring weights, before Warren integration.
- **Hypotheses:** a lightweight similarity/scoring function discriminates good vs bad candidate results well
  enough for the decide phase without a heavy embedder.
- **Method:** offline prototype scoring on sample candidate outputs; compare TF-IDF vs a simpler heuristic vs a
  small embedding call; tune weights.
- **Success / failure / fallback:** green = chosen scorer + weights documented; red = fall back to an explicit
  rubric-based LLM judge in the decide phase.
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
  asserts full-chain resolution **before** building the full P1.15 dispatch.
- **Success / failure / fallback:** green = chain resolves every hop; red = add explicit correlation id to PR
  body/metadata and re-test.
- **Exit decision:** go-with-validated-correlation-scheme before P1.15.

### SPIKE-7 — mulch binary & latency
- **Protects:** P1.12 (mulch prime/record) and any dependent dispatch priming.
- **Time-box:** 0.5 day, Dev B.
- **Objective:** confirm the `mulch` binary (assumed `/usr/local/bin/mulch` v0.6.3) is/will-be present and that
  prime ≤10s / record ≤5s latency budgets hold.
- **Success / failure / fallback:** green = present + within budget; red = vendor/pin the binary in P0 env, or
  raise timeouts with logged justification.
- **Exit decision:** go / go-with-adjusted-budgets.

### SPIKE-8 — GitHub review-harvesting extraction
- **Protects:** the Review Harvester cron agent (the one analysis agent in the KEEP slice).
- **Time-box:** 0.5–1 day, Dev B.
- **Objective:** validate the `gh` extraction of CodeRabbit / Gemini-Code-Assist inline + review comments,
  severity classification, and that paths/queries are parameterized (not hardcoded to one repo).
- **Hypotheses:** the `gh pr list` + `gh api .../comments` + `.../reviews` queries reliably return bot comments
  with parseable severity; token cost per harvest is bounded.
- **Method:** run the three `gh` queries against existing merged PRs (the repo has PR #20 history); measure
  comment volume and token cost; confirm the `REVIEW_HARVEST_SCHEMA` reflect call returns conformant output
  (depends on SPIKE-1 hypothesis 1).
- **Success / failure / fallback:** green = parameterized extraction + bounded cost; red = add a sampling cap
  and parameterize repo via config.
- **Exit decision:** go-with-parameterized-extraction.

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

---

## 9. Definition of done for the 4-week slice (enterprise-grade gates)

The slice is **done** when all hold (maps to P1.17's exit assertions plus rigor gates):

1. **G1 lights-on:** a `/qds` intake produces ≥1 real reviewed PR on the sample repo with no human input except
   gated approvals.
2. **G2 accountable:** for that PR, the full 8-hop audit chain reconstructs with **no missing hop**, and
   cost/story is queryable from the `cost_events` ledger.
3. **G3 flywheel:** post-session/post-skill retain and pre-session recall are live; banks accumulate
   observations; Review Harvester runs on cron and writes findings; the four deferred-agent seams (§6) exist
   and are tested as no-ops.
4. **G4 safe:** a loopy prompt **terminates via a guard, not by exhausting credits**; restart policy enforces
   retry/wall-clock caps; over-cap gate fires.
5. **Rigor:** every KEEP story has tests; security invariants (P0.7, P1.3 sanitization) have adversarial tests;
   correlation keys present on every artifact; no secrets in artifacts; spikes each left a written verdict.

---

## 10. Open questions to resolve in week 1 (non-blocking, run in parallel)

- **OQ-2** pi-lens headless invocation → SPIKE-4.
- **OQ-7** SwarmClaw command allowlist → SPIKE-2.
- **OQ — substrate of record:** confirm SwarmClaw/Warren is canonical; annotate PRD/architecture (§2).
- **OQ — Warren exit codes:** validate the assumed table → SPIKE-3.
- **OQ — mulch pre-install:** binary presence/version → SPIKE-7.
- **Directives source:** which `_bmad-output/` security invariants become Hindsight directives (QDS-MEM-001 §3.1) — extract during P0.9 bank seeding.
- **Bridge execution model:** is the SwarmClaw→Hindsight classification bridge a hook, a separate agent, or manual? (QDS-MEM-001 §6.2 leaves this open.) Decide before P1.11.

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
