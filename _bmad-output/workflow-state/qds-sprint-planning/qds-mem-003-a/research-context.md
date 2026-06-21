# QDS-MEM-003 Phase-2 — Writing-Agent Research Context (single source of truth)

> Consolidated from 5 research agents. Every writing agent for epic QDS-MEM-003 reads THIS file
> in full before writing. Track A backend. Runtime: **Bun/Node dual, TypeScript, `bun:sqlite`** (NOT Python).
> Story dir: `_bmad-output/sprint-artifacts/phase-2/stories/` · filename `p2-<n>-<title-kebab>.md`
> (heading uses dot `# P2.7:`, filename uses hyphen `p2-7-...md`).

---

## A. STORY TEMPLATE (match this repo's real P-numbered convention verbatim)

Section order (exact, all `##` level unless noted):

```markdown
# P2.{N}: {Title — imperative, capability-named}

**Story Points:** {2|3|4|5}

## Spec Reference

- {DOC §X (Section name); FR/NFR or design-anchor codes}
- {second anchor if relevant}

## User Story

As a {Role},
I want {capability},
so that {business outcome} ({GoalTag — short rationale}).

## Overview

{3–6 sentences. What this story wires end-to-end, which layers it touches, why it is an atomic
{N}-pt unit. State that wiring closes with no stub/TODO. Name vendor/glue/net-new class in prose.}

## E2E Slice

**Demonstrable behavior:** {concrete runnable sequence with real tools/paths + an asserted observable result.}

**Wiring closed:** On completion, {behavior} using only code merged by this story{ and predecessor P2.X}.
No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** {P2.X, P2.Y | None — standalone.}

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given {precondition}, When {action}, Then {binary asserted outcome}.
2. Given {…}, When {…}, Then {…}.
3. Given {…}, When {…}, Then {…}.
{4–7 typical; include a failure-path / guard scenario.}

## Technical Notes

- **Contracts/Schema:** {```typescript Zod/DDL block``` for infra/store stories; inline `{ field: type }` for glue.}
- **Integration points (each wired & exercised in this story):** {endpoints, MCP tools, seams, banks.}
- **Files / functions touched:** {`path.ts` (purpose), …}
- **Guards/limits:** {timeouts, caps, size limits, idempotency, atomicity rules.}

## Files to Modify

> ≤10 unique paths, one per line.
- `src/{...}.ts`
- `tests/{...}.test.ts`

## Security Invariants

> Concrete named invariants only — N/A NOT permitted when triggered.

- **INV-OM{n}:** {concrete enforced invariant — see §B.1; pull the ones that bind this story.}
- **INV-{STORY}{n}:** {story-specific invariant if any.}

## Definition of Done

> {8–12 for glue/small net-new | 18–22 for heavy infra/store/net-new} high-signal, story-specific boxes.
> NO project-wide CI filler (no "ruff/eslint clean", "tests pass", "typecheck" lines).

- [ ] **Impl:** {…}
- [ ] **Contract:** {schemas validated on all inputs}
- [ ] **Integration:** {layer wired & exercised end-to-end}
- [ ] **Security:** {INV-OM{n}… enforced — concrete enumeration}
- [ ] **Test (unit):** {…}
- [ ] **Test (e2e demo — MANDATORY):** {full runnable round-trip with assertion}

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
```

### Convention notes (load-bearing)
- **No YAML front-matter.** Line 1 = `# P2.{n}: Title`; line 3 = `**Story Points:** {int}`.
- **User-story Role is NOT bolded** in body (`As a QDS dev agent,`); optional trailing goal tag `(G2 — …)`.
- **AC**: numbered prose Given/When/Then (not Gherkin blocks); exactly ONE `**(make-or-break)**`, always item 1, binary.
- **E2E Slice** three labels are mandatory & verbatim: `**Demonstrable behavior:**`, `**Wiring closed:**`, `**Dependency edges (predecessors):**`. Reuse the "Wiring closed" sentence template near-verbatim.
- **Files to Modify**: ≤10 backtick paths, include both `src/` and `tests/`. (Atomicity audit BLOCKS if absent or >10.)
- **Security Invariants**: required (this epic triggers rls/migration/secrets/upload/deserialization keywords). Use `INV-OM{n}` domain tag.
- **DoD high-signal count**: these files carry ZERO CI filler, so literal box count == high-signal count. **Target 8–10 boxes for glue/small stories** (atomicity audit WARNs >10 high-signal). Heavy store/net-new stories (P2.1, P2.7, P2.10) may run 12–22; that's accepted for net-new-infra but keep every box a distinct guard/security/test, not filler. Last DoD box is ALWAYS `**Test (e2e demo — MANDATORY):**`.
- **Dev Agent Record** trailing section: include it (with the HTML comment) on ≤12-box stories; the heavy infra exemplars omit it. Include it on all P2 stories for consistency.
- **Cross-story schema refs**: cite predecessor schema by name + owner (e.g. "validated against P0.9 `BankIdSchema`"), don't redefine.
- Reference exemplars on disk: `phase-0/stories/p0-7-swarmclaw-agent-mcp-hindsight.md` (heavy net-new infra, 22-box DoD, INV-SC tags), `p0-9-hindsight-banks-mulch.md` (store, 11-box, owns BankIdSchema/retain schemas), `phase-1/stories/p1-14-outcome-record-router.md` (glue/router, 11-box, has Dev Agent Record).

---

## B. GLOBAL CONTEXT (applies to every story)

### B.1 The Four Invariants — verbatim, fold the binding ones into each story's Security Invariants + DoD
| ID | Invariant (verbatim) |
|---|---|
| **INV-OM1** | **Zero per-event LLM/HTTP** — capture is mechanical; no network egress during capture (network mock asserts). Only LLM work is nightly promotion (P2.7) + per-experiment optimization (P2.9–P2.11). |
| **INV-OM2** | **`run_id` non-null** on every `events` row — the spine; capture adapters omitting it are defective by definition. |
| **INV-OM3** | **`payload_json`/`result_json` ≤ 64 KB, secret-pattern-masked** — bounded rows; secrets scrubbed before write. |
| **INV-OM4** | **ONNX model from a pinned local path only — no remote fetch** — deterministic local inference, no external API per event. |

Binding map: INV-OM2/OM3 bind hardest on capture (P2.3–P2.6); INV-OM4 on store/embed (P2.1, P2.3, P2.5); INV-OM1 binds every capture/recall story and is the negative DoD for the whole tier. Spec anchor: **QDS-MEM-003-IMPL §E.1**; threading contract QDS-MEM-003 §5.2.

### B.2 A/B Experiment State Machine (P2.9–P2.11) — QDS-MEM-003 §8.1/§8.2, §4.1 CHECK
Status enum: `proposed → approved → running → analyzed → deployed → confirming → confirmed | rolled_back`; plus `rejected` at the gate. `winner ∈ {a,b,none}`.
- propose → `proposed` (optimizer scans runs, writes `experiments`) — **P2.9**
- **ONE human gate** → `approved | rejected` — **P2.9** (a 2nd gate at deploy was considered & REJECTED, §8.2)
- execute → `running → analyzed` (swarmclaw N variant-tagged runs, measure metric, declare winner) — **P2.10**
- deploy → `deployed` (`deploy_ref`, snapshot `baseline_metrics_json`, `confirm_until = deployed_at + 30d`) — **P2.10**
- confirm → `confirming → confirmed | rolled_back` (30-day cron, post vs baseline, auto-rollback) — **P2.11**
- **Every transition is itself an event** (audit trail). `confirmed`/`rolled_back` `retain()` to qds-meta → Meta-Optimizer `intervention_effectiveness`.

### B.3 Nightly-Promotion-Cron model (P2.7/P2.8) — QDS-MEM-003 §7.1/§7.2, §10; IMPL §C D1/D7
One run/night off-peak: read prev-day events (bounded window, scales with **days not events**) → **light** mechanical consolidation (dedupe, cluster by run/skill/topic, summarize each cluster; deep synthesis stays in Hindsight weekly Synthesizer) → emit one **"Daily Learnings YYYY-MM-DD"** doc (structured JSON + prose) → `retain()` to qds-product + qds-meta. Idle nights below volume threshold **skipped**; doc size **capped**; tunable. This is **D1** (all LLM moved off per-event capture) + **D7** (resolves SPIKE-9: bridge is batch cron, NOT live hook). Disambiguation: nightly promotion cron ≠ Hindsight strategic cron agents (Synthesizer/Meta-Optimizer/Blind-Spot, weekly/biweekly/monthly).

### B.4 Gating & cross-epic deps — IMPL §0 / §D.5
Epic entry: **P2.0 needs P0.7**. Full epic gates on **P0.7 + P1.6 + P1.15**. **P2.8 needs P1.11** (Hindsight retain KEEP). Spikes: **SPIKE-10** (swarmclaw DAG hook) gates **P2.4** + E2E of **P2.10**; **SPIKE-11** (sqlite-vec/ONNX in Bun) informs **P2.1** (validate, not block). SPIKE-9 RESOLVED (= the cron model).

---

## C. TARGET OPERATIONAL-STORE SCHEMA (QDS-MEM-003 §4 — literal DDL target)

```sql
-- events: captured-signal spine
CREATE TABLE events (
  id TEXT PRIMARY KEY,                 -- {domain}:{uuid}
  run_id TEXT NOT NULL,                -- [INV-OM2] FK runs
  dag_node_id TEXT,                    -- D5/SPIKE-10
  parent_event_id TEXT,               -- [D2] event tree
  agent_id TEXT NOT NULL, agent_role TEXT, skill TEXT, skill_version TEXT,
  prompt_id TEXT, prompt_version TEXT,
  variant TEXT, experiment_id TEXT,    -- A/B tags (NULL if not in experiment)
  event_type TEXT NOT NULL CHECK(event_type IN ('tool_call','node','message','outcome')),
  tool_name TEXT,
  payload_json TEXT NOT NULL,          -- [INV-OM3] ≤64KB, secret-masked
  result_json TEXT,                    -- [INV-OM3]
  tokens INTEGER DEFAULT 0, duration_ms INTEGER DEFAULT 0,
  outcome TEXT, error TEXT,
  created_at INTEGER NOT NULL          -- epoch ms
);  -- 9 indexes: run, agent, skill, type, variant, experiment, parent, created

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY, dag_def_id TEXT NOT NULL, variant TEXT, experiment_id TEXT,
  started_at INTEGER NOT NULL, ended_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','aborted')),
  total_tokens INTEGER DEFAULT 0, files_touched_json TEXT, overall_outcome TEXT
);  -- 3 indexes: dag_def_id, variant, started_at

CREATE TABLE experiments (
  experiment_id TEXT PRIMARY KEY, skill TEXT NOT NULL, hypothesis TEXT NOT NULL,
  variant_a_ref TEXT NOT NULL, variant_b_ref TEXT NOT NULL, metric TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK(status IN ('proposed','approved','running','analyzed','deployed',
                     'confirming','confirmed','rolled_back','rejected')),
  winner TEXT, proposed_fix TEXT, deploy_ref TEXT, baseline_metrics_json TEXT,
  proposed_at INTEGER NOT NULL, approved_at INTEGER, approved_by TEXT,
  executed_at INTEGER, deployed_at INTEGER, confirm_until INTEGER,  -- =deployed_at+30d
  decided_at INTEGER, created_at INTEGER NOT NULL
);  -- 2 indexes: status, skill

CREATE TABLE event_edges (
  source_id TEXT NOT NULL, target_id TEXT NOT NULL,
  relation TEXT NOT NULL,    -- handoff|caused_by|spawned|produced
  PRIMARY KEY (source_id, target_id, relation)
);  -- 2 indexes: source, target

CREATE VIRTUAL TABLE event_vec USING vec0(   -- sqlite-vec; D3/INV-OM4
  event_id TEXT PRIMARY KEY, embedding FLOAT[384]   -- Xenova/all-MiniLM-L6-v2
);

CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- seeds: schema_version=1.0.0, engine=sqlite+sqlite-vec,
--        embedding_model=Xenova/all-MiniLM-L6-v2, embedding_dim=384
```
Embedded text for `event_vec` = `{event_type} {skill} {tool_name} {payload summary} {reasoning/message text}`.

### Schema GAPS writers must fill (design under-specifies — call these out in the relevant story)
1. **FTS5 table is named but never DDL'd** — P2.1 must author the `events` FTS5 content-table + AFTER INSERT/DELETE/UPDATE sync triggers (copy claude-mem `SessionStore.ts:434-460` pattern).
2. **No FK declarations** in DDL (run_id/experiment_id are FK in comment only) — P2.1/P2.2 decide whether to enforce `FOREIGN KEY … ON DELETE CASCADE`.
3. **`schema_meta` (design, key/value) vs claude-mem `schema_versions` (integer-versioned)** — P2.2 reconciles.
4. **64KB enforcement + secret-masking helper (INV-OM3)** — net-new, no vendored helper; author in P2.3 (shared util).
5. **`dag_node_id` source shape** — SPIKE-10 gated (P2.4).

---

## D. VENDORED SOURCE MAP + DEPENDENCY FACTS

### D.0 Path correction (CRITICAL)
- Substrate lineage is **local** at `/Users/steve/QDS-Factory-Old/claude-mem/` (claude-mem v10.5.2; pi-mem IS claude-mem retargeted). Design's `src/...` paths = `claude-mem/src/...`.
- ArtemisAI/pi-mem itself is **remote (GitHub only)** — P2.0 clones/vendors it; use local claude-mem as the code-shape reference.
- pi-mono ExtensionAPI seam = `/Users/steve/QDS-Factory-Old/pi-mono/packages/coding-agent/src/core/extensions/types.ts` (the design's `pi-agent/extensions/pi-mem.ts` does NOT exist).
- **Best working local template** for sqlite+ONNX+FTS5: swarmclaw `/Users/steve/swarmclaw/src/lib/server/embeddings.ts` + `memory/memory-db.ts` (already uses Xenova/all-MiniLM-L6-v2, 384-dim).

### D.1 KEEP (lift+adapt) — claude-mem real paths
| Subsystem | Path | Story |
|---|---|---|
| SQLite stores + FTS5 | `claude-mem/src/services/sqlite/{SessionStore,Database,SessionSearch,transactions,types}.ts` | P2.1 |
| Migrations runner | `claude-mem/src/services/sqlite/migrations.ts` + `migrations/runner.ts` (`MigrationRunner`) | P2.2 |
| Async queue (backpressure) | `claude-mem/src/services/queue/SessionQueueProcessor.ts` + `sqlite/PendingMessageStore.ts` | P2.3 |
| Search Strategy pattern | `claude-mem/src/services/worker/search/**` (`SearchStrategy.ts`, `SearchOrchestrator.ts`, `HybridSearchStrategy.ts`, `SQLiteSearchStrategy.ts`); swap seam = `ChromaSearchStrategy.ts`→`SqliteVecSearchStrategy` | P2.1 |
| MCP server | `claude-mem/src/servers/mcp-server.ts` (thin stdio; re-point at recall API directly) | P2.1/P2.9 |
| Context formatters | `claude-mem/src/services/context/*` (`ContextBuilder.ts`) | P2.7 |
| ExtensionAPI seam | `pi-mono/packages/coding-agent/src/core/extensions/types.ts` | P2.3/P2.5/P2.6 |

### D.2 STRIP (do NOT vendor) — enforces D1/INV-OM1
- `claude-mem/src/services/worker/SDKAgent.ts` (+ GeminiAgent/OpenRouterAgent, sdk/prompts.ts) — the per-event `@anthropic-ai/claude-agent-sdk` `query()` call. **Deleting this + its 6 callers IS what enforces INV-OM1/D1.** (callers: worker/{ProcessRegistry,SessionManager}.ts, worker/agents/{ResponseProcessor,ObservationBroadcaster}.ts, worker/http/routes/SessionRoutes.ts)
- `claude-mem/src/services/sync/{ChromaSync,ChromaMcpManager}.ts` + `strategies/ChromaSearchStrategy.ts` (D3 → sqlite-vec)
- `claude-mem/src/cli/adapters/*` (IDE adapters — D4)
- `claude-mem/src/services/transcripts/*` (transcript watcher — no IDE transcripts)

### D.3 DEFER (Phase-4 seam) — `claude-mem/src/services/worker/http/*` + `src/ui/viewer/*`; P2.12 replay API exposes the data, UI is later.

### D.4 External deps (pin at P2.0)
- **sqlite-vec** (npm, pin exact at P2.0; verify `select vec_version()`). `CREATE VIRTUAL TABLE … USING vec0(event_id text primary key, embedding float[384])`. KNN **requires `k = ?` or `LIMIT`** in WHERE. Dim fixed at create. Default distance L2 (fine on normalized vectors). `partition key` columns (≤4, e.g. `variant`, `run_id`) shard the index for A/B/run-scoped queries. Native-extension load under Bun vs Node = the SPIKE-11 risk.
- **`@huggingface/transformers ^3.8.1`** (transformers.js v3; reuse swarmclaw pin). `pipeline('feature-extraction','Xenova/all-MiniLM-L6-v2',{dtype:'fp32'})` then `await pipe(text,{pooling:'mean',normalize:true})` → `Float32Array(384)`. **INV-OM4:** set `env.allowRemoteModels=false; env.localModelPath='/abs/pinned/models'` → loads local-only (this is how the network-mock test passes). Use `dtype:'fp32'` (not quantized) for deterministic vectors. Lazy-singleton the pipeline. Model ~23MB, vendor it into repo/image.
- **`bun:sqlite`** (substrate) / **`better-sqlite3 ^12.6.2`** (swarmclaw ref) — same sync API shape (dual-runtime). `db.pragma('journal_mode=WAL')`, `busy_timeout`, `db.prepare()`, `db.transaction(fn)`. For P2.3 "transactional event+vector": compute embedding BEFORE opening the transaction (better-sqlite3 is sync), then write event row + vec row in one `db.transaction`.
- **Cron** (P2.7/P2.11) — library NOT pinned by design. Recommend **`croner`** (zero-dep, TS, Bun-friendly) or reuse swarmclaw `cron-parser ^5.5.0` + custom loop; node-cron acceptable but verify Bun. Cron must be **idempotent/single-instance** (gate on a run-marker row to avoid double-`retain()`).

### D.5 Integration seams (real shapes)
**pi-mono ExtensionAPI** (`types.ts`) — extension exports default fn receiving `pi: ExtensionAPI`, subscribes `pi.on(event, async (event, ctx) => {...})`. Auto-discovered from `~/.pi/agent/extensions/*.ts` or `.pi/extensions/*.ts`. Event payloads (exact):
- `tool_execution_start {toolCallId, toolName, args}` / `tool_execution_end {toolCallId, toolName, result, isError}` → **P2.3**
- `turn_start {turnIndex, timestamp}` / `turn_end {turnIndex, message, toolResults}` → **P2.5**
- `message_update {message, assistantMessageEvent}` / `agent_end {messages}` → **P2.5/P2.6**
Lifecycle: `agent_start → [turn_start → tool_call → tool_execution_* → tool_result → turn_end]* → agent_end`. `ctx` gives `sessionManager`, `cwd`, `model` (no LLM call). Doc: `pi-mono/packages/coding-agent/docs/extensions.md`.

**swarmclaw DAG (D5, SPIKE-10)** — event vocabulary IS real & stable: `ProtocolRunEvent` (`/Users/steve/swarmclaw/src/types/protocol.ts:387-443`): `phase_started/completed, step_started/completed/ready/waiting/failed, branch_taken, parallel_branch_spawned/completed, loop_iteration_*, subflow_*, swarm_opened/claimed/exhausted, task_dispatched, delegation_dispatched, completed, failed, cancelled`; each `{id, runId, type, summary, phaseId?, stepId?, agentId?, taskId?, createdAt, data?}`. **BUT no push hook / emitter / subscribe API** — persistence via `upsertProtocolRunEvent` (`protocol-run-repository.ts:44-80`), read via `listUnifiedRunEvents(runId)` (`unified-run-queries.ts:78`), handoff via `GET /api/runs/[id]/handoff`. **UNKNOWN (SPIKE-10 must pick):** tap mechanism — (a) poll `listUnifiedRunEvents`, (b) patch executor to call capture callback at the `upsertProtocolRunEvent` site, (c) consume handoff packet at boundaries; AND whether `variant` is a first-class field (P2.10 A/B) or rides `ProtocolRun.data`. Writers: ship interface-first against the KNOWN event shape; wire real tap post-SPIKE-10.

**Hindsight `retain()` (P2.8 → P1.11)** — `await client.retain(bankId, content, {context?, timestamp?, documentId?, updateMode?:"replace"|"append", metadata?, entities?, tags?})`. Two banks: **qds-product** (decisions/antipatterns/patterns, tags `module:X, knowledge_type:Y, severity:Z`) and **qds-meta** (skill/outcome/optimization, tags `skill:X, outcome:Y, quality_dim:Z`). **Idempotency = stable `documentId`** (e.g. `daily-learnings-2026-06-19`) — omitting it duplicates on every cron retry (THE critical bridge gotcha). Use `updateMode:"replace"` + dated documentId for the once-nightly doc. **No multi-bank retain** — loop per bank. Sig: `hindsight-docs/references/developer/api/retain.md`; conventions: QDS-MEM-001 §3/§6.2.

---

## E. PER-STORY DESIGN BRIEFS (P2.0–P2.12)

Each block: scope-in / scope-out / deltas / class / acceptance constraints / spike / deps / spec-anchor.

### P2.0 — Toolchain bootstrap · 3 · vendor · 2a
- **In:** copy-paste pi-mem substrate (from ArtemisAI/pi-mem remote; local claude-mem = shape ref); Bun/Node dual-runtime wiring; pin deps (sqlite-vec, `@huggingface/transformers ^3.8.1`, ONNX runtime, cron lib); `THIRD_PARTY_NOTICES.md` (ArtemisAI/pi-mem lineage, claude-mem v10.5.2 ancestry, license type, import date); per-file license headers retained.
- **Out:** schema adaptation (P2.1), capture (P2.3+), the STRIP subsystems (§D.2 — must NOT vendor).
- **Deltas:** none directly (establishes vendor decision §A.5). **Spike:** none. **Deps:** needs P0.7.
- **Spec:** QDS-MEM-003-IMPL §D.1 + §A (provenance) + §A.4 (license).
- **Security:** supply-chain — vendored code reviewed before merge; STRIP list excluded (no `@anthropic-ai/claude-agent-sdk` per-event path enters tree); pinned versions (no floating).

### P2.1 — Event store (SQLite + sqlite-vec) · 4 · vendor · 2a  [absorbs recall API]
- **In:** lift SQLite+FTS5 stores; adapt schema to events/runs/experiments/event_edges (§C full DDL incl. CHECKs + 9+3+2+2 indexes); add `event_vec vec0(... FLOAT[384])` (D3); WAL; **author the events FTS5 table + sync triggers (GAP #1)**; swap ChromaSearchStrategy→SqliteVecSearchStrategy (keep Strategy framework); **Recall API absorbed**: by-run timeline + parent_event_id tree, indexed scans by agent/skill/prompt/variant/time, semantic vector search (k=? required), aggregations (outcome rates, tokens/duration by variant/skill). No LLM at this tier.
- **Out:** migrations runner (P2.2); capture writes (P2.3+).
- **Deltas:** D2 + D3. **Spike:** SPIKE-11 (validate sqlite-vec+ONNX in Bun — de-risk, NOT block; substrate exists). **Deps:** P2.0; fan-out point.
- **Acceptance:** run reconstruction `any run_id → full ordered timeline + tree < 200ms` (§12.1); recall indexed SQL + ANN, no LLM; embeddings 384-dim local ONNX.
- **Spec:** QDS-MEM-003 §4 / §6 + §C D2,D3. **Security:** INV-OM4 (pinned local ONNX path in store/embed config); INV-OM3 64KB+mask at write boundary; FK/CASCADE decision documented. (Heavier DoD band, 14–20 boxes acceptable.)

### P2.2 — Schema migration runner · 3 · vendor · 2a
- **In:** lift append-only `.sql` runner (`MigrationRunner`); convert claude-mem inline `ensureX()` steps → discrete ordered `.sql` files; reconcile `schema_versions`→design `schema_meta` (GAP #3); seed rows (schema_version=1.0.0, engine=sqlite+sqlite-vec, embedding_model, embedding_dim=384); applied set recorded in schema_meta; idempotent startup apply.
- **Out:** schema content (P2.1 owns it); destructive/down migrations (append-only model).
- **Deltas:** supports D2. **Spike:** none (rides P2.1 SPIKE-11). **Deps:** P2.0; parallel sibling to P2.1.
- **Spec:** QDS-MEM-003 §4.3. **Security:** migrations append-only (no silent schema drift); applied-migration ledger tamper-evident; runs in a transaction (partial-migration safety).

### P2.3 — Tool-call capture (pi-mono ExtensionAPI) · 3 · glue · 2a
- **In:** thin adapter on free seam (`tool_execution_end`) → one `events` (event_type `tool_call`) + one `event_vec` row, transactional, **zero LLM**; full threading (run/agent/skill/prompt/parent §5.2); ONNX embed at capture (compute before tx); **author the shared 64KB-cap + secret-mask util (GAP #4)**.
- **Out:** LLM distillation (→P2.7); DAG concepts (→P2.4); IDE/transcript capture (stripped).
- **Deltas:** D1 + D4. **Spike:** none (seam free; embed rides SPIKE-11). **Deps:** P2.1.
- **Acceptance (verbatim DoD):** **zero LLM/HTTP egress (network mock asserts); p99 < 5ms over 1000 calls; ONNX deterministic 384-dim.** Binds INV-OM1/2/3/4.
- **Spec:** QDS-MEM-003 §5.1–5.3 + IMPL §D.1. **Security:** all four INV-OM bind here — enumerate each in Security Invariants + DoD.

### P2.4 — DAG-node capture (swarmclaw seam) · 4 · net-new · 2a  **[BLOCKED-BY SPIKE-10]**
- **In:** capture swarmclaw node transitions + handoffs → `node` events; event tree via `parent_event_id`; optional `event_edges` `handoff` relations. Interface-first against the KNOWN `ProtocolRunEvent` shape (§D.5).
- **Out:** building swarmclaw hook infra; A/B variant execution (P2.10, shares SPIKE-10).
- **Deltas:** D5. **Spike:** **SPIKE-10 BLOCKING** (tap mechanism unknown — header note + interface-first DoD; full wiring deferred). Fallback: pi-mono-level-only capture for first pass, defer P2.4. **Deps:** P2.1 + SPIKE-10.
- **Spec:** QDS-MEM-003 §5.1 + IMPL §C D5 + QDS-EXEC-001 §7 SPIKE-10. **Security:** INV-OM1 (zero-LLM), INV-OM2 (run_id on node events).

### P2.5 — Reasoning + agent-context capture · 3 · glue · 2b
- **In:** pi-mono `message_update`/`turn_end`/`agent_end` → `message` events, full threading, ONNX embed → event_vec (raw reasoning stream; Hindsight keeps only distilled durable decisions — no overlap §2).
- **Out:** distilling/summarizing reasoning (→P2.7); duplicating Hindsight decision store.
- **Deltas:** D1 + D4. **Spike:** none (rides SPIKE-11 embed). **Deps:** P2.1.
- **Spec:** QDS-MEM-003 §5.1, §2 + IMPL §D.2. **Security:** INV-OM1/2/3/4 (same capture pattern as P2.3; reuse the P2.3 mask util).

### P2.6 — Outcome capture · 3 · glue · 2b
- **In:** test/review/build adapters → `outcome` events (`outcome ∈ {success,partial,failure,skipped,NULL}`, `error`, `result_json`), linked to run via run_id (+ `runs.overall_outcome` rollup).
- **Out:** trend aggregation / external CodeRabbit harvesting (Hindsight Review Harvester owns it §2); LLM outcome classification (→P2.7).
- **Deltas:** D1. **Spike:** none. **Deps:** P2.1.
- **Spec:** QDS-MEM-003 §5.1, §2 + IMPL §D.2. **Security:** INV-OM1/2/3; anti-pattern to guard: adapters omitting threading fields make runs un-diagnosable.

### P2.7 — Nightly promotion cron · 4 · net-new · 2b
- **In:** cron (off-peak, once/night) — bounded-window read; light mechanical consolidation (dedupe, cluster by run/skill/topic, summarize per cluster); emit "Daily Learnings YYYY-MM-DD" doc (JSON+prose); skip idle nights below threshold; cap doc size; tunable. ALL tier LLM lives here (replaces stripped SDKAgent, D1). Reuse claude-mem context formatters for doc render.
- **Out:** the retain() push (→P2.8); deep synthesis (Hindsight weekly); live/per-event handoff (batch only).
- **Deltas:** D1 + D7. **Spike:** none (SPIKE-9 resolved). **Deps:** P2.3+P2.5+P2.6 (capture live).
- **Acceptance:** one LLM run/night, bounded doc; idle nights skipped; anti-success: docs grow unbounded → consolidation not deduping.
- **Spec:** QDS-MEM-003 §7.1 + IMPL §C D1. **Security:** cron idempotent/single-instance (run-marker row — no double process); doc-size cap (resource bound); secret-mask carried into the doc (no secrets promoted).

### P2.8 — Hindsight retain bridge · 3 · net-new · 2b
- **In:** push Daily Learnings doc → Hindsight `retain()`: product decisions/antipatterns/patterns → qds-product (`module:X, knowledge_type:Y`); skill/outcome/optimization → qds-meta (`skill:X, outcome:Y, quality_dim:Z`). Reuse QDS-MEM-001 §6.2 routing/precedence + I/O schema. Stable dated `documentId` + `updateMode:"replace"`; loop per bank.
- **Out:** Hindsight bank/agent changes (additive only); the consolidation (P2.7); one-time seeding script.
- **Deltas:** D7 (resolves SPIKE-9). **Spike:** none. **Deps:** P2.7 + **P1.11 (cross-epic)**.
- **Acceptance:** retain volume ~1 doc/day; correct bank routing + tags.
- **Spec:** QDS-MEM-003 §7.1–7.2 + QDS-MEM-001 §6.2. **Security:** **idempotent documentId (no duplicate retain on retry)** — load-bearing; correct tag scoping (visibility); no secrets in retained content (mask upstream verified).

### P2.9 — Experiment propose + human gate · 3 · net-new · 2c
- **In:** optimizer agent scans recent runs → writes `experiments` row (skill, hypothesis, variant_a_ref, variant_b_ref, metric ∈ {success_rate|token_cost|duration|review_findings}, status=proposed, proposed_at); CLI/UI approve/reject (set approved_at/approved_by) → approved|rejected; **every transition emitted as an event** (audit). The ONE human gate.
- **Out:** A/B execution+deploy (→P2.10); a 2nd gate at deploy (rejected); autonomous propose-to-deploy.
- **Deltas:** D6. **Spike:** none. **Deps:** P2.8.
- **Acceptance:** one human gate; transitions are audit events; anti-success: experiments pile in `proposed` (gate abandoned).
- **Spec:** QDS-MEM-003 §8.1–8.2, §4.1 + IMPL §D.3. **Security:** **human authZ on the gate** (approved_by recorded, only authorized actor flips state); audit event per transition (tamper-evident); no auto-approve path.

### P2.10 — A/B execution + deploy · 5 · net-new · 2c  **[BLOCKED-BY SPIKE-10 for E2E]**
- **In:** swarmclaw runs N variant-tagged runs each (runs/events carry `variant` + `experiment_id`); aggregate metric across variants → `winner ∈ {a,b,none}`, running→analyzed; deploy winner (set `deploy_ref`, snapshot `baseline_metrics_json`, `deployed_at`, `confirm_until = +30d`) → deployed. **Ship interface + unit tests first; full E2E when SPIKE-10 seam confirmed** (carry §D.3 wording verbatim).
- **Out:** 30-day confirm/rollback (→P2.11); human gate at deploy (winner deploys under §8.2 approval).
- **Deltas:** D6. **Spike:** **SPIKE-10 BLOCKING for E2E** (variant-tagged DAGs) — header note + interface-first DoD. **Deps:** P2.9 + SPIKE-10.
- **Acceptance:** approved experiment → analyzed winner within run-window; baseline snapshotted at deploy.
- **Spec:** QDS-MEM-003 §8.1, §4.1 + QDS-EXEC-001 §7 SPIKE-10. **Security:** only an `approved` experiment can execute (state-machine guard); deploy writes baseline before flipping (rollback safety precondition); variant config provenance recorded.

### P2.11 — Confirm cron (30-day auto-rollback) · 3 · net-new · 2c
- **In:** cron reads deployed experiments where `confirm_until` reached; compare post-deploy metrics vs `baseline_metrics_json`; deployed→confirming→confirmed|rolled_back; **auto-revert `deploy_ref` on regression**; retain qds-meta finding (`outcome:confirmed`|`outcome:rolled_back`).
- **Out:** human approval of rollback (auto by design); the deploy (P2.10).
- **Deltas:** D6. **Spike:** none. **Deps:** P2.10 (writes via P2.8 path / P1.11).
- **Acceptance:** **≥95% of deployed experiments reach confirmed/rolled_back within 35 days**; auto-rollback on regression; findings feed Meta-Optimizer intervention_effectiveness.
- **Spec:** QDS-MEM-003 §8.1–8.3 + IMPL §D.3. **Security:** auto-rollback is fail-safe (regression → revert, not hold); cron idempotent; rollback action audited as event.

### P2.12 — Replay + retention policy · 3 · net-new · 2d  [merges replay/debug + retention/observability]
- **In:** replay API — reconstruct any run's ordered event timeline + parent_event_id tree (serves optimizer + humans); retention/decay cleanup policy (tier is ephemeral-leaning, decays); basic metrics/observability.
- **Out:** graphical viewer UI (§13 out of scope; DEFER worker HTTP/SSE + viewer plug in BEHIND this replay API).
- **Deltas:** none new (operates over D2). **Spike:** none. **Deps:** P2.1.
- **Acceptance:** `any run_id → full ordered timeline + tree < 200ms`; any DAG run replayable at tool-call granularity.
- **Spec:** QDS-MEM-003 §6, §12.1, §13 + IMPL §B.3. **Security:** retention policy bounds growth (resource); replay read-only (no mutation of historical events); decay policy documented + reversible window.

---

## F. WRITING-BATCH ASSIGNMENT (7 agents, ≤2 stories each, sum 44pt)

| Batch | Stories | Pts | Affinity |
|---|---|---|---|
| W-A | P2.0 + P2.1 | 7 | vendor substrate (toolchain + store) |
| W-B | P2.2 + P2.12 | 6 | schema mechanics + housekeeping over the store |
| W-C | P2.3 + P2.5 | 6 | glue capture (tool-call + reasoning) |
| W-D | P2.6 + P2.4 | 7 | capture surface (outcome glue + DAG-node net-new); P2.4 carries SPIKE-10 |
| W-E | P2.7 + P2.8 | 7 | promotion pipeline (cron → Hindsight retain) |
| W-F | P2.9 + P2.10 | 8 | A/B front (propose+gate, execute+deploy); P2.10 carries SPIKE-10 |
| W-G | P2.11 | 3 | A/B tail (confirm cron) — solo |

Build-order DAG does NOT constrain writing order (writing produces Markdown). Downstream specs cite upstream interfaces by reading THIS doc, not by serialization. Dispatch all 7 in parallel.

---

## G. DUAL-OUTPUT REQUIREMENT (every writing agent)
1. **Write** each detailed story file → `_bmad-output/sprint-artifacts/phase-2/stories/p2-<n>-<title-kebab>.md` (full enterprise detail per §A template).
2. **Return** for each story a BRIEF epic-summary block (for epics-index insertion) + a one-line confirmation: file path, total line count, normative-line count, DoD box count, which INV-OM invariants included, spike note if any.
3. Keep normative content ≤200 lines/story (atomicity audit BLOCKs >250); ≤10 Files-to-Modify; Security Invariants section present.
