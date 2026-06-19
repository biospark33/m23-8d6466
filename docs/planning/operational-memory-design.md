# QDS-Factory Operational Memory Substrate — Design & Decision Document

**Document ID**: QDS-MEM-003
**Status**: Approved design, implementation-ready (awaiting implementation plan)
**Created**: 2026-06-18
**Authority**: Architecture decision record for the operational memory tier sitting below Hindsight
**Relationship**: Sits beneath [QDS-MEM-001](hindsight-memory-master-design.md) (project-level Hindsight) and [QDS-MEM-002](hindsight-factory-tier-design.md) (factory-tier Hindsight). Purely additive; requires no changes to either Hindsight document.

---

## 1. Executive Summary

QDS-Factory runs as a "dark" (largely unattended) code factory: **swarmclaw** acts as master orchestrator, spinning up **pi agents** via **DAG workflows** to do real coding work. Above this runtime sits **Hindsight** (QDS-MEM-001/002), the strategic/semantic memory tier that answers *"what does it mean"* — distilled architectural decisions, skill-outcome trends, cross-bank insights.

Between the runtime and Hindsight there is currently **no operational memory tier** — nothing that captures, at full fidelity, *"what happened"* during a run. This document specifies that missing tier: an **operational memory substrate** modeled on the claude-mem / pi-mem pattern (auto-capture of tool-usage observations, semantic indexing, cross-run recall), but purpose-fit for a swarmclaw-orchestrated DAG of pi agents feeding a Hindsight strategic layer and a self-optimizing A/B loop.

The tier's **substrate is vendored** (copy-pasted + adapted) from [ArtemisAI/pi-mem](https://github.com/ArtemisAI/pi-mem) (claude-mem v10.5.2 lineage) — SQLite stores, migrations runner, queue processor, search-strategy framework, MCP server, context injection. Its **capture layer is stripped** (per-event LLM observer, Chroma, IDE adapters, transcript watcher); only the swarmclaw/DAG/A-B-specific parts are greenfield. It is **not** the existing `.swarm/memory.db` (RuFlo V3) — RuFlo is a claude-flow artifact and is explicitly **out of scope** for the QDS-Factory PRD (greenfield *vs RuFlo*; vendored *vs pi-mem*). Full provenance + teardown + 13-story breakdown: [QDS-MEM-003-IMPL](operational-memory-implementation-plan.md).

**Three capabilities delivered:**

1. **Black-box replay + diagnosis.** Every tool call, DAG-node transition, agent reasoning trace, and outcome is captured, indexed, and queryable by run / agent / skill / prompt-version / variant. Any run can be reconstructed and diagnosed.
2. **Overnight promotion to Hindsight.** A nightly batch cron distills the day's operational memory into a single "Daily Learnings" document and retains it into Hindsight. Hindsight receives clean, high-signal input and pays no per-event LLM cost.
3. **Self-optimization via A/B experimentation.** A cron optimization agent proposes experiments, a human approves them, the agent executes variant runs and proposes fixes, and a 30-day confirmation cron validates (or auto-rolls-back) every change.

The complementarity contract with Hindsight is the load-bearing architectural decision: the operational tier owns **raw / high-volume / realtime / cheap** signals; Hindsight owns **distilled / low-volume / strategic / expensive** signals. A promotion gate is the only crossing point. The two tiers never compete because they operate at different granularity, volume, latency, and cost — same topics, different altitude.

---

## 2. Complementarity Contract with Hindsight

The operational tier and Hindsight answer different questions about the same events. The separation is by **granularity, volume, latency, and cost** — not by topic.

| Dimension | Operational tier (this doc) | Hindsight tier (QDS-MEM-001/002) |
|---|---|---|
| Question answered | "what happened" | "what it means" |
| Granularity | raw event, full fidelity | distilled insight |
| Volume | high (every tool call, node, message, outcome) | low (durable facts only) |
| Latency | realtime, on every event | batch, post-session / post-run |
| Cost | cheap, mechanical (indexes, no per-event LLM) | expensive (LLM `retain` / `reflect`) |
| Lifetime | ephemeral-leaning, decays | durable, reinforced |
| Primary reuse | replay/debug any run, DAG handoffs, A/B diagnosis | strategic recall, cross-run learning, trajectory analysis |
| Analogy | flight data recorder (black box) | post-flight lessons-learned report |

**Signal-by-signal overlap check (all four captured at the operational tier, none duplicate Hindsight):**

- **Tool calls** — Hindsight never wants these (too granular). Operational owns. No overlap.
- **DAG nodes + handoffs** — Hindsight captures the *decision made at* a node, not the node mechanics. Operational owns mechanics. No overlap.
- **Agent reasoning** — Hindsight keeps distilled durable decisions ("chose X over Y because Z"). Operational keeps the raw reasoning *stream*. The promotion gate distills raw → durable. No overlap.
- **Outcomes (tests / reviews / builds)** — Hindsight keeps aggregated *trends*; its Review Harvester pulls CodeRabbit from GitHub (external). Operational keeps raw per-run outcomes (internal). Different source + granularity. No overlap.

**This makes Hindsight cheaper, not redundant.** QDS-MEM-001 §6.2's Swarmclaw→Hindsight bridge currently performs LLM classification on raw session content. With the operational tier pre-distilling, Hindsight's bridge receives clean high-signal input → cheaper `retain` calls, cleaner banks. The operational tier **upstreams work from** Hindsight.

**Timescale separation reinforces the boundary:**
- *Within a run* (seconds–hours): agents coordinate via the **operational store**, live. Agent B reads Agent A's raw output instantly. No LLM, no Hindsight lag.
- *Across runs* (days+): the factory learns via **Hindsight**, fed by overnight docs.

---

## 3. Architecture

### 3.1 Three-Tier Funnel

```
                ┌──────────────────────────────────────────────┐
                │   swarmclaw orchestrator                      │
                │   spins pi agents via DAG workflows           │
                └───────────────┬──────────────────────────────┘
                                │ (4 signals, realtime)
                                ▼
   TIER 1 ── CAPTURE ────────────────────────────────────────────
   ┌──────────────────────────────────────────────────────────┐
   │  operational store  (SQLite + sqlite-vec, vendored)       │
   │  events · runs · experiments · vector index               │
   │  NO per-event LLM. mechanical, indexed, cheap.            │
   └──────┬───────────────────────┬────────────────────┬──────┘
          │ live recall            │ nightly batch      │ optimizer agent
          │ (handoffs, replay)     │ (promotion)        │ (A/B diagnosis)
          ▼                        ▼                    ▼
   pi agents / DAG          ┌─────────────────┐   experiment lifecycle
   mid-run                  │ nightly cron    │   (propose → gate →
                            │ distill →       │    execute → deploy →
                            │ Daily Learnings │    30-day confirm)
                            │ doc             │
                            └────────┬────────┘
   TIER 2 ── PROMOTION ──────────────┼──────────────────────────
                                     │ retain (low-vol, clean)
                                     ▼
   ┌──────────────────────────────────────────────────────────┐
   │  Hindsight banks (QDS-MEM-001/002)                        │
   │  qds-product · qds-meta                                   │
   │  strategic/semantic. LLM-extracted. expensive.            │
   │  + existing 4 proactive agents run here (unchanged)       │
   └──────────────────────────────────────────────────────────┘
   TIER 3 ── STRATEGIC (unchanged)
```

### 3.2 Hybrid Partitioning

Memory is partitioned **hybrid**: per-agent working scratch during a run + shared factory long-term store. This mirrors the existing Swarmclaw→Hindsight bridge pattern (QDS-MEM-001 §6.2).

- **Agent scratch** — during a run, an agent's events are tagged with its `agent_id` and `run_id`. It works primarily against its own stream + the run's stream (handoffs).
- **Shared factory store** — all events live in one physical store, queryable by any agent via tags (`project`, `task`, `dag_def`, `run_id`, `agent_role`, `skill`, `variant`). Durable learnings consolidate up to Hindsight on the overnight cron.

There is no separate per-agent database. Isolation is logical (tag-scoped queries), not physical. This maximizes knowledge reuse while preserving per-run/per-agent diagnosability.

---

## 4. Storage Schema (v1)

Engine: **SQLite + sqlite-vec** (embedded, single file, transactional with event rows, zero extra process). WAL mode. Schema is versioned; migrations are append-only and tracked in a `schema_meta` table.

### 4.1 Core Tables

```sql
-- Every captured signal is one event. The run is a tree via parent_event_id.
CREATE TABLE events (
  id              TEXT PRIMARY KEY,          -- {domain}:{uuid}, domain in (tool,node,msg,outcome)
  run_id          TEXT NOT NULL,             -- FK runs
  dag_node_id     TEXT,                      -- which DAG node produced this
  parent_event_id TEXT,                      -- tree edge (node → tool call → subagent)
  agent_id        TEXT NOT NULL,
  agent_role      TEXT,                      -- e.g. coder, reviewer, planner
  skill           TEXT,
  skill_version   TEXT,
  prompt_id       TEXT,
  prompt_version  TEXT,
  variant         TEXT,                      -- A/B variant tag (NULL if not in an experiment)
  experiment_id   TEXT,                      -- FK experiments (NULL if not in an experiment)
  event_type      TEXT NOT NULL              -- tool_call | node | message | outcome
                    CHECK(event_type IN ('tool_call','node','message','outcome')),
  tool_name       TEXT,
  payload_json    TEXT NOT NULL,             -- input args / node input / message body
  result_json     TEXT,                      -- output / node output / outcome data
  tokens          INTEGER DEFAULT 0,
  duration_ms     INTEGER DEFAULT 0,
  outcome         TEXT,                      -- success | partial | failure | skipped | NULL
  error           TEXT,
  created_at      INTEGER NOT NULL           -- epoch ms
);

CREATE INDEX idx_events_run       ON events(run_id);
CREATE INDEX idx_events_agent     ON events(agent_id);
CREATE INDEX idx_events_skill     ON events(skill);
CREATE INDEX idx_events_type      ON events(event_type);
CREATE INDEX idx_events_variant   ON events(variant);
CREATE INDEX idx_events_experiment ON events(experiment_id);
CREATE INDEX idx_events_parent    ON events(parent_event_id);
CREATE INDEX idx_events_created   ON events(created_at);

-- DAG run metadata. One row per executed DAG.
CREATE TABLE runs (
  run_id          TEXT PRIMARY KEY,
  dag_def_id      TEXT NOT NULL,             -- which DAG definition
  variant         TEXT,                      -- A/B variant (NULL if not experimental)
  experiment_id   TEXT,                      -- FK experiments
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  status          TEXT NOT NULL              -- running | completed | failed | aborted
                    CHECK(status IN ('running','completed','failed','aborted')),
  total_tokens    INTEGER DEFAULT 0,
  files_touched_json TEXT,                   -- JSON array of paths
  overall_outcome TEXT                       -- success | partial | failure
);

CREATE INDEX idx_runs_dag     ON runs(dag_def_id);
CREATE INDEX idx_runs_variant ON runs(variant);
CREATE INDEX idx_runs_started ON runs(started_at);

-- A/B experiment lifecycle (state machine in §7).
CREATE TABLE experiments (
  experiment_id   TEXT PRIMARY KEY,
  skill           TEXT NOT NULL,             -- target skill/prompt under test
  hypothesis      TEXT NOT NULL,             -- "prompt B cuts token cost on skill X"
  variant_a_ref   TEXT NOT NULL,             -- skill/prompt version ref (baseline)
  variant_b_ref   TEXT NOT NULL,             -- skill/prompt version ref (candidate)
  metric          TEXT NOT NULL,             -- success_rate | token_cost | duration | review_findings
  status          TEXT NOT NULL DEFAULT 'proposed'
                    CHECK(status IN ('proposed','approved','running','analyzed',
                                     'deployed','confirming','confirmed','rolled_back','rejected')),
  winner          TEXT,                      -- 'a' | 'b' | 'none'
  proposed_fix    TEXT,                      -- JSON: deploy-winner description
  deploy_ref      TEXT,                      -- config version actually deployed
  baseline_metrics_json TEXT,                -- snapshot at deploy time
  proposed_at     INTEGER NOT NULL,
  approved_at     INTEGER,
  approved_by     TEXT,                      -- human gate approver
  executed_at     INTEGER,
  deployed_at     INTEGER,
  confirm_until   INTEGER,                   -- deployed_at + 30 days
  decided_at      INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE INDEX idx_experiments_status ON experiments(status);
CREATE INDEX idx_experiments_skill   ON experiments(skill);

-- Optional cross-links beyond the parent_event_id tree (handoffs, caused-by, spawned).
CREATE TABLE event_edges (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation  TEXT NOT NULL,                   -- handoff | caused_by | spawned | produced
  PRIMARY KEY (source_id, target_id, relation)
);
CREATE INDEX idx_edges_source ON event_edges(source_id);
CREATE INDEX idx_edges_target ON event_edges(target_id);
```

### 4.2 Vector Index

sqlite-vec virtual table over event reasoning + payloads for semantic diagnosis:

```sql
CREATE VIRTUAL TABLE event_vec USING vec0(
  event_id TEXT PRIMARY KEY,
  embedding FLOAT[384]                       -- Xenova/all-MiniLM-L6-v2 (matches existing infra)
);
```

Embeddings generated at capture time by a local ONNX model (Xenova/all-MiniLM-L6-v2, 384-dim). This is a small dependency to add; it is chosen for low cost, deterministic local inference, and no external API call per event (critical for a cheap capture tier). 384-dim is a dimension previously validated in this environment. Embedded text = `{event_type} {skill} {tool_name} {payload summary} {reasoning/message text}`.

### 4.3 Schema Meta / Migrations

```sql
CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR REPLACE INTO schema_meta(key,value) VALUES
  ('schema_version','1.0.0'),
  ('engine','sqlite+sqlite-vec'),
  ('embedding_model','Xenova/all-MiniLM-L6-v2'),
  ('embedding_dim','384');
```

Migrations are append-only `.sql` files applied in order on startup; applied migrations recorded in `schema_meta`.

---

## 5. Capture Layer

### 5.1 The Four Signals

| Signal | Source | event_type | Captured by |
|---|---|---|---|
| Tool calls | pi-agent tool invocations (file edits, bash, reads, agent spawns) | `tool_call` | swarmclaw runtime hook on tool boundary |
| DAG nodes + handoffs | swarmclaw DAG node transitions + inter-node payloads | `node` | swarmclaw DAG executor hook |
| Agent reasoning | pi-agent messages / decisions / rationale | `message` | pi-agent message hook |
| Outcomes | test results, review findings, build status, errors, retries | `outcome` | test-runner / review / build adapters |

### 5.2 Threading Contract

Every captured event MUST carry, at minimum: `run_id`, `agent_id`, `created_at`, and (where applicable) `dag_node_id`, `parent_event_id`, `skill`/`skill_version`, `prompt_id`/`prompt_version`, `variant`/`experiment_id`. This threading is what makes runs reconstructable and what lets the optimizer agent slice by skill/prompt-version/variant. Capture adapters that omit these fields are defective by definition.

### 5.3 Capture Adapters

Each signal has a thin adapter that translates the source event into an `events` row + optional `event_vec` embedding, then writes transactionally. Adapters are the only integration surface with the swarmclaw/DAG/pi-agent runtime; the store knows nothing about runtime internals.

---

## 6. Recall API

A small query library (no LLM) over the operational store, used by live agents (handoffs), the replay/debug tooling, and the optimizer agent (diagnosis):

- **By run** — `events WHERE run_id = ?` ordered by `created_at` → full timeline; `parent_event_id` reconstructs the tree.
- **By agent / skill / prompt-version / variant / time window** — indexed equality + range scans.
- **Semantic** — vector search over `event_vec` ("find runs where the agent struggled with token refresh").
- **Aggregations** — outcome rates, token/duration averages, grouped by variant/skill (the optimizer agent's A/B queries).

Recall is fast and cheap by design: indexed SQL + ANN vector search. No LLM at this tier.

---

## 7. Promotion Tier (Overnight)

### 7.1 Nightly Cron

A single scheduled cron runs once per night (off-peak). It:

1. Reads the previous day's events from the operational store (bounded window — scales with days, not events).
2. Runs **light mechanical consolidation**: dedupe, cluster by run/skill/topic, summarize each cluster into a short structured finding. (Default depth = light. Deep synthesis stays in Hindsight's weekly Synthesizer — different cadence, different tier.)
3. Emits one **"Daily Learnings YYYY-MM-DD" document** (structured JSON + prose).
4. Calls Hindsight `retain()` to ingest the document into the appropriate bank:
   - Product decisions/antipatterns/patterns → `qds-product` (tagged `module:X`, `knowledge_type:Y`).
   - Skill/outcome/optimization findings → `qds-meta` (tagged `skill:X`, `outcome:Y`, `quality_dim:Z`).

Idle nights (below an event-volume threshold) are skipped. Document size is capped. The cron is tunable.

> **Cron-term disambiguation.** This **nightly promotion cron** (operational tier, high-volume daily
> distill, this §7) is distinct from the **Hindsight strategic cron agents** in QDS-MEM-001 §5/§6.1
> (Synthesizer / Meta-Optimizer / Blind-Spot Detector, weekly / biweekly / monthly). Different tiers,
> different cadences, same downstream banks.

### 7.2 Hindsight Bridge Simplification

With this tier in place, QDS-MEM-001 §6.2's Swarmclaw→Hindsight bridge no longer classifies raw session content with an LLM — it reads the pre-distilled daily document. Hindsight's banks grow by ~1 clean doc/day instead of N raw events. Hindsight's own observation-consolidation continues to refine further, unchanged.

---

## 8. Self-Optimization: A/B Experimentation Lifecycle

### 8.1 State Machine

```
operational store (raw runs)
   │
   ▼
[1] optimizer agent scans recent runs  →  PROPOSES experiment
    (hypothesis: "prompt B cuts token cost on skill X")
    experiments.status = proposed
   │
   ▼
[2] ◆ HUMAN GATE ◆   approve / reject the experiment          ← the ONE human gate
    status: proposed → approved | rejected
   │ approved
   ▼
[3] agent EXECUTES A/B   (swarmclaw DAG, variant-tagged runs, N each)
    measures metric across variants  →  PROPOSES fix (deploy winner)
    status: approved → running → analyzed
   │
   ▼
[4] winner config goes live
    status: analyzed → deployed   (deploy_ref set, baseline_metrics snapshotted,
                                   confirm_until = deployed_at + 30d)
   │
   ▼
[5] 30-DAY CONFIRMATION cron: post-deploy metrics vs baseline
    status: deployed → confirming → confirmed | rolled_back
    │
    ├─ better  → CONFIRMED   → hindsight qds-meta (outcome:success)
    └─ worse   → AUTO-ROLLBACK (revert deploy_ref) → hindsight qds-meta (outcome:failure)
```

### 8.2 Autonomy Decision (resolved)

**One human gate**, at step 2 (test approval). The approved experiment authorizes execution + winner deployment. The 30-day confirmation cron is the safety net, with **automatic rollback** on regression. A second gate at fix-deploy (step 4) was considered and rejected — it would kill dark-factory velocity, and the 30-day auto-rollback already catches bad winners. This is "guardrailed auto with human-in-loop at test-approval + longitudinal safety net" — stronger than propose-only, safer than fully-autonomous.

Every state transition is itself an event in the operational store, giving a full audit trail. All findings land in Hindsight `qds-meta`, so the existing Meta-Optimizer sees which interventions actually worked — the operational tier runs the experiment, Hindsight judges the trajectory.

### 8.3 Loop Closure with Hindsight

- Operational optimizer agent = **active experimenter** (runs A/B, deploys winners, validates).
- Hindsight Meta-Optimizer = **strategic evaluator** (reads distilled trends, judges whether the factory's improvement process is itself improving over weeks).

Different axis, no redundancy. The optimizer agent's `confirmed`/`rolled_back` outcomes feed the Meta-Optimizer's `intervention_effectiveness` analysis (QDS-MEM-001 §4.3).

---

## 9. Cost Model

| Tier | LLM cost | When | Scales with |
|---|---|---|---|
| Capture | zero (mechanical: SQLite + vector writes) | every event | event volume — cheap |
| Operational recall | zero (indexed SQL + ANN vector search) | any query | query count — cheap |
| Promotion (nightly cron) | one batched LLM run per night | overnight | days, not events — bounded, predictable |
| Optimization (A/B) | LLM only at propose + analyze steps | per approved experiment | experiment count — human-gated, low frequency |
| Hindsight | decreases (cleaner input than today) | existing cadence | — |

The realtime usefulness comes from operational recall — fast, no LLM. LLM cost hits only at bounded points: nightly promotion + per-experiment optimization.

---

## 10. Decisions Resolved (Decision Record)

| Decision | Choice | Rationale |
|---|---|---|
| Relationship to RuFlo V3 (`.swarm/memory.db`) | **Greenfield vs RuFlo; vendored vs pi-mem** | RuFlo is a claude-flow artifact, not in the QDS-Factory PRD — the store is greenfield *vs RuFlo*. The substrate itself is vendored from pi-mem (see next row). |
| Relationship to pi-mem | **Vendor substrate (copy-paste, not git fork), strip capture — user-confirmed** | pi-mem's SQLite stores + migrations + queue + search framework + MCP + context injection are the hard parts already solved; copy-paste + adapt them. Strip its per-event-LLM capture (wrong altitude) + Chroma + IDE adapters. No remote/upstream. See [QDS-MEM-003-IMPL](operational-memory-implementation-plan.md) §A/B. |
| Storage engine | **SQLite + sqlite-vec** | One file, transactional with event rows, zero extra process, fits single-node dark factory. |
| Partitioning | **Hybrid: agent-scratch + shared-factory** | Mirrors existing Swarmclaw→Hindsight bridge; per-run diagnosability + factory-wide reuse. |
| Capture signals | **All four** (tool calls, DAG nodes, agent reasoning, outcomes) | Each serves a distinct purpose; none duplicates Hindsight (granularity/volume/latency split). |
| Promotion model | **Overnight batch cron**, no live handoff | Bounded LLM cost (scales with days), clean Hindsight input, predictable. |
| Promotion depth | **Light default** | Deep synthesis stays in Hindsight's weekly Synthesizer (different cadence/tier). |
| Complementarity | **Operational = raw/cheap/realtime; Hindsight = distilled/expensive/strategic; promotion gate is the only crossing** | Prevents duplication; makes Hindsight cheaper. |
| Optimizer autonomy | **One human gate at test-approval; winner deploys under that approval; 30-day auto-rollback** | Guardrailed auto. Pragmatic dark-factory velocity with longitudinal safety. |
| Embedding model | **Xenova/all-MiniLM-L6-v2 (384-dim, local ONNX)** | Small added dependency; low cost, deterministic, no external API call per event. Dimension previously validated in this environment. |

---

## 11. Implementation Slices (E2E Vertical Stories)

> **Port-vs-new story map.** The slices below are the design-phase decomposition (15 stories / 47 pts,
> `P0-OM-1…P4-OM-15`). They are **re-anchored into a 13-story Phase-2 epic** (`P2.0–P2.12`, ~44 pts) with a
> per-story vendor/glue/net-new classification and sequencing DAG in
> [QDS-MEM-003-IMPL §D](operational-memory-implementation-plan.md) — that is the backlog of record for
> implementation. Story files live at `_bmad-output/sprint-artifacts/phase-2/`.

Implementation is decomposed into **vertical end-to-end slices**, each delivering working, tested capability (storage + logic + test), sized **3–4 points**. Phased to match QDS-Factory story idiom.

**Phase 0 — Foundation (3 stories, 9 pts)**
- **P0-OM-1** — Operational store bootstrap: SQLite + sqlite-vec, schema v1, migrations, insert/query round-trip, vector search works. (3 pts)
- **P0-OM-2** — Capture adapter for tool calls (one agent type): tool boundary → `events` row, full threading (run/agent/skill/prompt/parent). (3 pts)
- **P0-OM-3** — Recall API: query by run/agent/skill/variant/time + vector semantic search. (3 pts)

**Phase 1 — Capture Expansion (3 stories, 9 pts)**
- **P1-OM-4** — DAG node + handoff capture (swarmclaw DAG executor → `node` events, event tree via `parent_event_id`). (3 pts)
- **P1-OM-5** — Agent reasoning capture (pi-agent messages → `message` events, vector-indexed). (3 pts)
- **P1-OM-6** — Outcome capture (test/review/build adapters → `outcome` events, linked to run). (3 pts)

**Phase 2 — Promotion (2 stories, 6 pts)**
- **P2-OM-7** — Nightly promotion cron: light consolidation of day's events → Daily Learnings doc. (3 pts)
- **P2-OM-8** — Hindsight retain bridge: push daily doc → `qds-product`/`qds-meta` retain with correct tags. (3 pts)

**Phase 3 — Self-Optimization (5 stories, 17 pts)**
- **P3-OM-9** — Experiment proposal agent: scan runs, propose hypothesis → `experiments` row (status=proposed). (3 pts)
- **P3-OM-10** — Human gate (approve/reject): CLI/UI flip + audit event → status=approved. (3 pts)
- **P3-OM-11** — A/B execution: swarmclaw DAG runs variant-tagged runs, measures metric, declares winner → status=analyzed. (4 pts)
- **P3-OM-12** — Winner deploy: apply winning config + snapshot baseline + set confirm_until=+30d → status=deployed. (3 pts)
- **P3-OM-13** — 30-day confirmation cron: post-deploy vs baseline, confirm/rollback + hindsight qds-meta finding. (4 pts)

**Phase 4 — Hardening (2 stories, 6 pts)**
- **P4-OM-14** — Replay/debug tooling: reconstruct any run's event timeline/tree for diagnosis (serves optimizer + humans). (3 pts)
- **P4-OM-15** — Retention/decay + observability: operational-store cleanup policy, metrics, basic dashboard. (3 pts)

**Total: 15 stories · 47 points · every slice is a vertical e2e (storage + logic + test) at 3–4 pts.**

Order matters: Phase 0 unblocks everything; Phase 1 expands capture; Phase 2 closes the upward loop to Hindsight; Phase 3 builds the self-optimization loop; Phase 4 hardens. Each phase is independently shippable.

---

## 12. Success Criteria

### 12.1 Quantitative

| Metric | Target | Source |
|---|---|---|
| Capture overhead per event | < 5 ms p99, no per-event LLM | capture adapter benchmarks |
| Run reconstruction | any run_id → full ordered event timeline + tree in < 200 ms | recall API |
| Nightly promotion cost | one LLM run/night, bounded doc size | cron logs |
| Hindsight retain volume | ~1 doc/day (down from N raw events) | retain logs |
| A/B decision latency | approved experiment → analyzed winner in run-window | experiments table |
| 30-day confirmation | ≥ 95% of deployed experiments reach a confirmed/rolled_back verdict within 35 days | experiments table |

### 12.2 Qualitative

- Any DAG run can be replayed and diagnosed at tool-call granularity.
- Hindsight banks stay clean (no raw-event noise).
- The optimizer agent produces human-approved experiments that measurably improve skills/prompts.
- Regressions from bad winners are auto-rolled-back within 30 days, logged to qds-meta.

### 12.3 Anti-Success Signals

| Signal | Meaning |
|---|---|
| Capture adapters omit threading fields | runs become un-diagnosable; fix adapters immediately |
| Nightly promotion docs grow unbounded | consolidation not deduping; tune cron |
| Experiments pile up in `proposed` with no human review | gate is a bottleneck or abandoned |
| Deployed experiments never reach `confirmed`/`rolled_back` | 30-day cron not running or metrics missing |

---

## 13. Out of Scope

- **RuFlo V3 / `.swarm/memory.db`** — claude-flow artifact, not in PRD. Ignored.
- **Hindsight bank/agent changes** — QDS-MEM-001/002 are untouched; this tier is purely additive.
- **Multi-node / distributed store** — single-node SQLite is sufficient for the dark factory; revisit only if throughput demands.
- **UI for replay/debug** — Phase 4 ships a tooling API; a graphical viewer is a future enhancement.
- **Auto-deploy without the human gate** — explicitly rejected (§8.2).

---

## 14. References

- [QDS-MEM-001](hindsight-memory-master-design.md) — project-level Hindsight (strategic tier above this one).
- [QDS-MEM-002](hindsight-factory-tier-design.md) — factory-tier Hindsight.
- [ArtemisAI/pi-mem](https://github.com/ArtemisAI/pi-mem) — claude-mem v10.5.2 lineage. **Vendored substrate source** (copy-paste + adapted, capture layer stripped), not merely inspiration. See [QDS-MEM-003-IMPL](operational-memory-implementation-plan.md) §A for provenance, §B for the KEEP/STRIP/DEFER map, §C for the seven architectural deltas.
- [QDS-MEM-003-IMPL](operational-memory-implementation-plan.md) — implementation plan, provenance, teardown, 13-story Phase-2 breakdown, invariants.

---

*End of document. Canonical reference for the QDS-Factory operational memory substrate. All sessions implementing, modifying, or extending this system should read this document first.*
