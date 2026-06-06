# R3 — Architecture, Contracts & Schemas (ground-truth pack)

> Source-of-truth for sprint story writers. Every file:line, column, endpoint, and SHA below is
> verified-on-disk or upstream-verified (Phase-0 spikes, 2026-06-06). Cross-refs are to
> `_bmad-output/planning-artifacts/prd-qds-factory-v4.md`. **Do not invent columns/endpoints/paths — use these.**

---

## A. The four layers → real repo / binary each maps to

| Layer | Role | Real repo / binary on disk | Pin / version | Status |
|---|---|---|---|---|
| **Paperclip** | Control tower (org chart, budgets, issues=SoR, cost ledger, heartbeat trace, routines/cron, approvals, plugins) | `/Users/steve/boardlensai/paperclip` @ `paperclipai/paperclip` | Live instance: `localhost:3100` (npx **v2026.529.0**, `local_trusted`, **no auth**) | Repo on-disk; **source checkout NOT independently bootable** (no `node_modules`, only `.env.example`, no Postgres on 5432). Live npx instance is the call target. |
| **Hermes** | Department managers (24/7 tool-loop, Seeds decompose, drive Archon, model-router, Mulch prime, Hindsight retain/recall, iMessage gateway) | `hermes 0.15.1` installed at `~/.hermes/hermes-agent` | `0.15.1` | Installed. Concurrency = synchronous scatter-gather `delegate_task` (`tools/delegate_tool.py:1918`), default **3** children (`hermes_cli/config.py:1230`), blocks until batch joins. **No SSE consumer in Hermes today.** |
| **Archon** | PIV DAG orchestration (fresh-context, worktree-isolated, SSE-audited; heavy node = bash node) | `/Users/steve/Archon` @ `coleam00/Archon:dev` | HEAD **`536584db`** (plain upstream, NOT a fork) | On-disk upstream; **env patch unapplied** (lives on branch `qds/env-patch-spike`). |
| **Pi teams** | In-node agent teams (mixed models via openrouter/anthropic, P2P coms, pi-lens QC+TDI, pi-gitnexus-plus) | `pi` binary **0.55.0** installed; vendor tree `/Users/steve/QDS-Engineer/pi-vs-claude-code-vendor/` | **pin `pi@0.55.0`** | 0.55.0 supports `--mode json`/`--mode rpc`/`--append-system-prompt`/`--session`. coms.ts targets 0.73+ but loads cleanly on 0.55.0 (parser more lenient). |

**Layer wiring (one line):** Paperclip → Hermes managers (`adapterType="hermes_local"`, host injects `PAPERCLIP_API_KEY`+`PAPERCLIP_RUN_ID`) → Archon `POST /api/workflows/{name}/run` + `GET /api/stream/__dashboard__` (SSE) → bash node `executeBashNode` → `pi-team-launch.sh` (NOT on disk) → N Pi agents.

**Deterministic-seam rule (§4.2):** prefer more DAG nodes over bigger swarms. 6 agents of capacity = 2 nodes of 3, never 1 node of 6 (coms is P2P, n² paths, `MAX_HOPS=5`; beyond ~4 agents variance explodes).

**Code-intelligence rule (§4.5):** grep = literal text · GitNexus (pi-gitnexus-plus) = repo-wide **static** graph (≤8h stale, FR-MEM-6) · LSP (pi-lens `lsp_navigation`/`lsp_diagnostics`) = **live semantic incl. uncommitted edits**. The post-edit `lsp_diagnostics` gate (FR-EX-11) is the single strongest lever: a node cannot emit while diagnostics report errors on changed files.

---

## B. The single audit chain — hops in order, table/field at each hop

**Lineage spine (§8.1):**
`epic → Seeds stories (.seeds/issues.jsonl) → Paperclip issues → {cost_events | approvals+issue_execution_decisions | heartbeat_runs} → Archon run (SSE+worktree) → Pi team (agent names/models/coms log) → pi-lens (TDI+stable IDs) → Hindsight (bank, document_id=runId)`

### Audit-chain query contract (§8.4) — exact joins for PR reconstruction

| # | From → To | Join key (file:line) | Record / source |
|---|---|---|---|
| 1 | PR → Archon run | PR branch/worktree id ↔ run id (run-log header) | Archon SSE run log + worktree metadata |
| 2 | Archon run → issue | `issues.executionRunId` / `issues.checkoutRunId` (`issues.ts:37-38`) ↔ `heartbeat_runs.id` | Paperclip `issues`, `heartbeat_runs` (`heartbeat_runs.ts:6-82`) |
| 3 | issue → run trace(s) | `heartbeat_runs` FK via run-id columns above | Paperclip `heartbeat_runs` |
| 4 | issue → assignee (actor) | `issues.assigneeAgentId` (`issues.ts:35`) → `agents.id` (+ `reportsTo` `agents.ts:24` walked to root) | Paperclip `agents` |
| 5 | issue → cost | `cost_events.issueId` (`cost_events.ts:15`) = issue id; `SUM costCents` (`:27`) | Paperclip `cost_events` ledger |
| 6 | issue → decisions | `approvals.issueId` + `issue_execution_decisions.issueId` | Paperclip `approvals` (`approvals.ts:5-28`), `issue_execution_decisions` |
| 7 | issue → decomposition parent/children | `issues.parentId` (`:29`) up to epic; Seeds `blocks[]`/`blockedBy[]` for sibling deps | Paperclip `issues` + `.seeds/issues.jsonl` |
| 8 | run → Pi team | run id ↔ launcher invocation; agent names/models/coms log in node output | Archon node output + `pi-team-launch.sh` log + `~/.pi/coms/` registry |
| 9 | Pi team → pi-lens findings | per-agent turn-end report (stable IDs + TDI) | pi-lens report attached to node output |
| 10 | run → memory | bank id=`{repo}`/`{repo}-<dept>-meta`; **`document_id == Paperclip runId`** (Hindsight plugin `agent.run.finished` hook) | Hindsight bank |

**Reconstruction guarantee:** steps 2–7 are all keyed on the Paperclip issue id — once step 2 resolves run→issue, the rest are direct FK lookups. Phase-1 gate (§8.5): for one real PR, the full walk completes with no missing hop and per-issue spend (SUM of `cost_events`) shown within budget.

**Cost hop (§8.3) — NOT an `issue.cost` field:** there is **no `cost` column on issues**. Per-issue cost = `SELECT SUM(cost_events.costCents) WHERE issueId=:id`. Per-tree cost = same SUM over `parentId` subtree. Rolls up to `agents.spentMonthlyCents` (`agents.ts:31`) + `companies.spentMonthlyCents` (`companies.ts:15`), each checked vs `budgetMonthlyCents`. `agentId` → per-role, `model` → per-model, `heartbeatRunId` → per-run attribution = **native**.

---

## C. The Archon env-patch — 3 sites verbatim (base SHA `536584db`, branch `qds/env-patch-spike`)

**Why 3, not 2:** the original 2-site estimate missed that `executeBashNode`'s `execFileAsync` is imported from `@archon/git`, whose options type is hand-narrowed and rejects `env` at compile time (**TS2353**) until widened. Without site (c), (a)+(b) fail to compile. Spike-proven: `tsc --noEmit` clean + existing `dag-executor` suite **150 pass / 0 fail**; **CORRECTNESS-A proven**. Blast radius LOW — `executeBashNode` (`dag-executor.ts:1305`) has a **single upstream caller**, `executeDagWorkflow`.

| Site | File:line | Package | What changes |
|---|---|---|---|
| **(a) Schema** | `packages/workflows/src/schemas/dag-node.ts:179-181` | `packages/workflows` | Add optional `env` field to `bashNodeSchema` (today it extends base with only `bash`+`timeout`; base `:113-139` has no `env`, nor any variant). |
| **(b) Executor (merge)** | `packages/workflows/src/dag-executor.ts:1362` | `packages/workflows` | `execFileAsync('bash',['-c',finalScript],{cwd,timeout})` currently passes **only** `{cwd,timeout}`. Change to **merge**: `env: { ...process.env, ...(node.env ?? {}) }`. **NEVER a bare `env: node.env`** — bare assignment wipes inherited `PATH`/creds and breaks every existing bash node (CORRECTNESS-A non-regression). |
| **(c) Exec wrapper type** | `packages/git/src/exec.ts` | `packages/git` (`@archon/git`) | Options type is hand-narrowed to `{ timeout?, cwd?, maxBuffer? }`. Add `env?: NodeJS.ProcessEnv` — one line, additive. Runtime already forwards options to Node's `execFile`; only the TS type blocks (b). |

**Exit criteria (FR-OR-4 unblock):** bash node with `env:{FOO:bar}` echoes `bar`; AND a bash node with no `env` field still inherits parent env (non-regression). **Do not touch** the `$VAR` regex at `dag-executor.ts:314` — it is MCP-config-scoped (`expandEnvVarsInRecord`, reads `process.env`), not this path. Two other bash `execFileAsync` sites (script-node `~:1577`, alt-bash `~:2022`) do **not** receive per-node `env` — explicit follow-up scope decision.

---

## D. Key schemas & contracts

### D.1 `heartbeat_runs` (`packages/db/src/schema/heartbeat_runs.ts:6-82`, 83 lines)
Exec trace table. Key columns:
- **`usageJson`** — `jsonb("usage_json").$type<Record<string,unknown>>()`, nullable, no default (`:21`). **Cost-estimate fallback source** when launcher emit is unverified.
- `resultJson` (jsonb), `contextSnapshot` (jsonb) — untyped `Record<string,unknown>`.
- `status` (`:14`).
- Retry lineage: `retryOfRunId` (self-FK, onDelete `set null`), `processLossRetryCount`.
- Liveness: `livenessState`, `livenessReason`, `lastUsefulActionAt`, `nextAction`.
- Logs: `logStore`, `logRef`, `logBytes`, `logSha256`, `logCompressed` (bool, default false), `stdoutExcerpt`, `stderrExcerpt`.
- Process: PID/group columns.
- Indexes: `(companyId,agentId,startedAt)`, `(companyId,livenessState,createdAt)`, `(companyId,status,lastOutputAt)`, `(companyId,status,processStartedAt)`.
- Issue FK linkage in: `issues.checkoutRunId` / `issues.executionRunId` (`issues.ts:37-38`).

### D.2 `cost_events` + `createCostEventSchema`
- **Schema (drizzle):** `packages/db/src/schema/cost_events.ts:9-53`. Columns (`:12-29`): `agentId` (FK→agents), `issueId` (`:15`, FK→issues.id), `model`, `provider`, `biller`, `billingType`, `heartbeatRunId` (FK→heartbeat_runs), `inputTokens`, `cachedInputTokens`, `outputTokens`, `costCents` (`:27`).
- **Validator (`packages/shared/src/validators/cost.ts`) — `createCostEventSchema`:**
  - **REQUIRED:** `agentId` (uuid), `provider` (string min 1), `model` (string min 1), `costCents` (`z.number().int().nonnegative()` — **NOT optional, NOT defaulted; tokens alone are insufficient**), `occurredAt` (datetime string).
  - **Optional w/ defaults:** `inputTokens`=0, `cachedInputTokens`=0, `outputTokens`=0, `billingType` (enum `BILLING_TYPES`, default `"unknown"`).
  - **Optional nullable:** `issueId`, `projectId`, `goalId`, `heartbeatRunId`, `billingCode`, `biller`.
  - `biller` auto-populates via `.transform()` to equal `provider` if unset.
  - Same file also has `updateBudgetSchema`: `{ budgetMonthlyCents: z.number().int().nonnegative() }`.
- **Write endpoint:** `POST /companies/:companyId/cost-events` (`server/src/routes/costs.ts:73`). Agents may only report their **OWN** `agentId` (enforced `costs.ts:77-80`).
- **Read aggregations (`costs.ts`):** `costs/summary` (`:132`), `by-agent` (`:153`), `by-agent-model` (`:161`), `by-provider` (`:169`), `by-biller` (`:177`), `issues/:id/cost-summary` (`:140`), `by-project` (`:272`).
- **QDS company id (live calls):** `1287bc8d-2122-4484-bc0c-900662caf8a0` (budget 0, spent 0, `issuePrefix:"QDS"`).
- **Emission gap (OQ-8):** Pi has **zero** Paperclip/cost integration (vendor-tree grep empty; Pi exposes only context-window % via `ctx.getContextUsage()?.percent`, `coms.ts:691,907,1211`). **`pi-team-launch.sh` is the sole emitter** — must POST one row per Pi role/agent; compute `costCents` via OpenRouter `/api/v1/generation?id=` reconciliation OR a local price table (generation-id surfacing unconfirmed — OpenRouter SDK exposes `usage:{inputTokens,outputTokens,cachedTokens?}` but **no** `generationId`/`getGeneration()`). **Fallback in effect:** parse `heartbeat_runs.usageJson` best-effort, label `ESTIMATED`.

### D.3 Seeds `.seeds/issues.jsonl` shape
- Store: `.seeds/issues.jsonl` (git-tracked, travels with repo). Binary `sd` installed **0.2.5** (expected 0.4.7 → upgrade/pin).
- Fields per record: `id`, `title`, `status`, `type`, `priority`, `labels`, `blocks[]`, `blockedBy[]`, `closeReason`.
- Commands: `create / dep / ready / close`.
- Sync: one-directional Seeds→Paperclip (FR-MG-3). Paperclip child issue references origin via `originKind='seeds_story'` + `originId` (`issues.ts:45-46`). Seeds owns dependency edges + status; Paperclip owns assignment + cost.

### D.4 Paperclip issues + plugin-install API
- **Issues (`packages/db/src/schema/issues.ts`):** `assigneeAgentId` (`:35`), `status` (`:32`), `parentId` (`:29`), `executionPolicy` jsonb (`:52`, gate decisions persisted in `issue_execution_decisions`), `checkoutRunId`/`executionRunId` (`:37-38`), `originKind`/`originId` (`:45-46`). **No `cost` column.**
- **Agents (`agents.ts`):** `reportsTo` self-FK (`:24`, idx `:42`), `budgetMonthlyCents`/`spentMonthlyCents` (`:30-31`).
- **Companies (`companies.ts`):** `budgetMonthlyCents`/`spentMonthlyCents` (`:14-15`).
- **Approvals (`approvals.ts:5-28`):** `status` (`:13`), `payload` (`:14`), `decisionNote` (`:15`), `decidedByUserId` (`:16`), `decidedAt` (`:17`).
- **`hermes_local` adapter (`adapters/registry.ts:440-500`):** injects `PAPERCLIP_API_KEY` (`:468`) + `PAPERCLIP_RUN_ID` (`:469`); external Hermes calls REST as a registered agent (`agent_api_keys` table).
- **Plugin install:** `POST /api/plugins/install` (`server/src/routes/plugins.ts:1008`, openapi `:3385`). Requires **instance-admin**; body `{ packageName, version?, isLocalPath? }`. List: `GET /api/plugins` (currently returns `[]`). Manifest type `PaperclipPluginManifestV1` provides `webhooks.receive` / `agent.tools.register` / `launchers` / `ui.slots` / `jobs.schedule` — **NO first-class messaging/approval-routing/inline-button primitive** (Telegram parity is entirely the external package's job → OQ-3 BLOCKED, Hermes-gateway fallback).
- **Routines/cron:** `routines.ts` (routines/revisions/triggers/runs), `routine_triggers.cron_expression` (`:99`), migration `0039`.
- **Plugin event bridge:** `PluginEventBus` (`services/plugin-event-bus.ts`); plugin-side `ctx.events.on("issue.created",…)`.

### D.5 `pi-team-launch.sh` launcher contract (§4.6) — **does NOT exist on disk** (Phase-0 deliverable)
- **stdout = node's structured output** (executor captures subprocess stdout verbatim `dag-executor.ts:1361-1368`; logs→stderr→Archon warning `:1370-1378`; node output returned `:1406`).
- **Signature (long-flags):** `--task <desc>` · `--context-path <path>` · `--archetype <A..F>` (default **C/TDD-Trio**) · `--budget-cap-cents <n>` · `--turn-cap <n>` · `--wall-clock-cap-ms <n>` (**≤ bash node's own `timeout`** `dag-node.ts:181`) · `--role-model <role>=<provider/model>` (repeatable; GLM/Kimi always via `openrouter`) · `--worktree <path>` (defaults to inherited `cwd`).
- **Agent identity:** each role = one `pi` subprocess, `--cname <run-id>-<role>` (extension flag `coms.ts:536`; fallback frontmatter `name:` then `agent-<6chars>`).
- **Mandatory response-schema field:** every worker reply schema MUST carry **`changed_files: string[]`**; lead computes set-**union** and runs `lsp_diagnostics` over it before emit (FR-EX-11). Omission = node failure.
- **Merged output schema:** union `changed_files`, structured result, `partial: boolean`, `exit_class` (`transient|overflow|logic`, FR-MG-8), logged waivers.
- **response_schema is parse-only** (receiver final msg `JSON.parse`d on `agent_end`, NOT schema-validated) → lead validates each worker reply, launcher validates merged object before stdout.
- **Hard guards** (budget/turn/wall-clock) enforced by launcher process (owns spawn/kill), not delegated.

### D.6 Pi coms contract (upstream-only — `disler/pi-vs-claude-code@main`, vendored)
`coms_send(target,prompt,conversation_id?,response_schema?)` · `coms_get` (non-block) · `coms_await(msg_id,timeout_ms?)` · `coms_list`. `response_schema` **parse-only**. Default timeout **30 min** = `1_800_000ms` (`PI_COMS_TIMEOUT_MS`, `coms.ts:32`). Transport: per-agent unix socket + file registry `~/.pi/coms/`; no hub; `MAX_HOPS=5`. `tilldone.ts` loop guard present locally (`agent_end` nudge `:365-383`, task-gate `:335-361`).

---

## E. Acquisition gaps (§5.5) — the 8 must-install components

| # | 🔧 Component | Source / command | Blocks | Spike status |
|---|---|---|---|---|
| 1 | **`coms.ts`** (+ maybe `coms-net.ts`) | vendor from `disler/pi-vs-claude-code@main` | All Pi-team coms work | ✅ vendored to `pi-vs-claude-code-vendor/`; loads on pi 0.55.0 |
| 2 | **pi-lens** | `pi install npm:pi-lens` | In-node QA gate + TDI metric | ✅ installed **v3.8.47**; machine-readable JSON headless confirmed; TDI = TUI slash-cmd `/lens-tdi` (headless = read `~/.pi-lens/` artifacts) |
| 3 | **Telegram plugin** | external npm via `POST /api/plugins/install` | Comms front-door + approvals | ⚠️ BLOCKED-on-creds; npm name unknown; **Hermes-gateway fallback** |
| 4 | **Hindsight Paperclip plugin** | `@vectorize-io/hindsight-paperclip` (`pnpm paperclipai plugin install`) | Memory retain/recall | ⚠️ self-host default but local stack BLOCKED on arm64/OpenSSL (OQ-4) |
| 5 | **Archon env patch** | author 3-site patch on branch (spike: `qds/env-patch-spike` off `536584db`) | Per-node model routing (FR-OR-4) | ✅ built + tested (tsc clean, 150 tests pass) |
| 6 | **Seeds/Mulch upgrades** | `sd`/`mulch` upgrade or pin (Seeds 0.2.5→0.4.7; Mulch 0.6.3→0.10.1) | Version-stable decomposition + priming | pending |
| 7 | **pi-gitnexus-plus extension** | `pi install npm:pi-gitnexus-plus` (v0.7.0; GitNexus CLI 1.6.3 already present) | Graph-aware code traversal (14 agent tools) | not installed |
| 8 | **Language server(s)** | `npm i -g typescript-language-server typescript pyright` | LSP diagnostics + nav (post-edit gate) | ✅ `typescript-language-server@5.3.0` + `typescript` + `pyright@1.1.410` on PATH |
