# R2 — FR/NFR Spec Pack (QDS-Factory v4)

> Verbatim reference of every Functional and Non-Functional Requirement from `prd-qds-factory-v4.md` §6.1–6.9 and §11, with §6.8 phase tagging.
> **Source:** `/Users/steve/QDS-Factory/_bmad-output/planning-artifacts/prd-qds-factory-v4.md`
> **Phase tags** per §6.8 (FR) and §11/§6.8 (NFR). `P0` = Phase 0, `P1` = Phase 1, `P2–P5` = roadmap, `v5` = deferred (out of v4 scope).
> **STORY-CRITICAL** = §6.8 maps to Phase 0 or Phase 1 (our stories must cover these). Flagged with **★** below.

---

## Index Table

### Functional Requirements

| ID | One-line | Phase |
|---|---|---|
| FR-CP-1 | Represent every agent as Paperclip row with `reportsTo` org chart | **P1 ★** |
| FR-CP-2 | Enforce monthly budget cap per agent/company, track spend vs cap | **P1 ★** |
| FR-CP-3 | Record every work unit as an issue (assignee/status/parent) | **P1 ★** |
| FR-CP-4 | Attribute cost to issue via cost-event ledger entry | **P1 ★** |
| FR-CP-5 | Attach `executionPolicy` defining human-approval gate | **P1 ★** |
| FR-CP-6 | Persist every approval + execution-gate decision | **P1 ★** |
| FR-CP-7 | Record execution trace (heartbeat run) per agent run | **P1 ★** |
| FR-CP-8 | Schedule recurring manager activity via cron routines | **P1 ★** (exercised P3) |
| FR-CP-9 | Install a plugin via plugin-install endpoint | **P0 ★** |
| FR-CP-10 | Plugin subscribes to core domain events via event bridge | **P0 ★** |
| FR-CP-11 | External Hermes registers as agent + authenticates REST calls | **P0 ★** |
| FR-CP-12 | Roll up per-issue ledger cost into agent/company spend | **P1 ★** |
| FR-CP-13 | Scheduled routine wakes a specific department manager | P3 |
| FR-MG-1 | Each dept manager runs 24/7 tool-loop as Paperclip agent | **P1 ★** |
| FR-MG-2 | Dev manager accepts intake request, creates Paperclip issue | **P1 ★** |
| FR-MG-3 | Dev manager decomposes issue into Seeds stories, mirrors to Paperclip | **P1 ★** |
| FR-MG-4 | Manager launches Archon run, consumes SSE stream (blocking in P1) | **P1 ★** |
| FR-MG-5 | Manager selects swarm archetype + per-role model tier per node | **P1 ★** |
| FR-MG-6 | Manager primes node agents with Mulch house-style context | **P1 ★** |
| FR-MG-7 | Manager retains/recalls run learnings to memory bank | **P1 ★** |
| FR-MG-8 | Manager applies restart policy (transient/overflow/logic) | **P1 ★** |
| FR-MG-9 | Manager classifies failure signal into restart category + logs | **P1 ★** |
| FR-MG-10 | Manager reflects over `*-meta` bank to propose router tuning | P3 |
| FR-OR-1 | Author/register custom `qds-piv-loop` 14-node workflow | **P1 ★** |
| FR-OR-2 | Run workflow via POST, stream execution via SSE | **P1 ★** |
| FR-OR-3 | Execute heavy node as bash node invoking launcher script | **P0 ★** |
| FR-OR-4 | Inject per-node env vars into bash node subprocess (3-site patch) | **P0 ★** |
| FR-OR-5 | Run each workflow in fresh-context worktree-isolated workspace | **P1 ★** |
| FR-OR-6 | Pause run at approval node; resume on approval / halt on reject | **P1 ★** (exercised P4) |
| FR-OR-7 | Capture/persist run's SSE stream as retrievable run log | **P1 ★** |
| FR-EX-1 | Launch N named Pi agents into same-machine team | **P0 ★** |
| FR-EX-2 | Team agents exchange peer messages + structured replies (parse-only) | **P0 ★** |
| FR-EX-3 | Launcher enforces hard guards (budget/turn/wall-clock/tilldone/timeout) | **P0 ★** |
| FR-EX-4 | Worker runs pi-lens in-node QA, emits turn-end report (IDs + TDI) | **P0 ★** |
| FR-EX-5 | Obtain pi-lens output in headless run for DAG consumption | **P0 ★** |
| FR-EX-6 | Team lead merges worker outputs into single JSON node output | **P1 ★** |
| FR-EX-7 | Select swarm archetype per node (Solo…Maintenance) | **P1 ★** |
| FR-EX-8 | Fallback to proxy TDI metric when headless TDI unavailable | **P0 ★** |
| FR-EX-9 | Pi worker traverses codebase via graph-aware layer (pi-gitnexus-plus) | **P0 ★** |
| FR-EX-10 | Pi worker resolves semantics against active per-worktree LSP | **P0 ★** |
| FR-EX-11 | Implement node cannot emit while `lsp_diagnostics` reports errors | **P1 ★** |
| FR-EX-12 | Post-edit gate degrades to ast-grep + test-pass with logged waiver | **P1 ★** |
| FR-MEM-1 | Create per-repo and per-manager memory banks | **P0 ★** |
| FR-MEM-2 | Manager retains/recalls memory by relevance to prime prompt | **P0/P1 ★** (split — see flags) |
| FR-MEM-3 | QA findings on shared bank recalled by Dev manager | P2 |
| FR-MEM-4 | Decompose work into Seeds issues with dependency edges | **P0 ★** |
| FR-MEM-5 | Record reusable expertise to Mulch, generate priming prompt | **P1 ★** (nightly consolidation P3) |
| FR-MEM-6 | Keep GitNexus graph current via 4–6h scheduled refresh | P3 |
| FR-CM-1 | Stakeholder submits work/queries via Telegram slash commands | **P1 ★** |
| FR-CM-2 | Surface approval gate as Telegram msg with approve/reject buttons | **P1 ★** |
| FR-CM-3 | Route different message types to different chats | P4 |
| FR-CM-4 | Accept intake from iMessage/other channels into Paperclip | P4 |
| FR-CM-5 | Emit outbound status/digests to dashboard + Telegram | P4 |
| FR-ACT-1 | Reconstruct full audit chain for a merged PR (no missing hop) | **P1 ★** |
| FR-ACT-2 | Compute/record four yield KPIs per story + rolling window | **P1 ★** (per-story) |
| FR-ACT-3 | Dashboard charts four yield KPIs over rolling window | P5 |
| FR-LEARN-28 | Record per-run outcome record (idempotent upsert on runId) | **P1 ★** |
| FR-LEARN-29 | `qds-model-router` selects archetype + model tier deterministically | **P1 ★** |
| FR-LEARN-30 | Weekly cron proposes (not auto-applies) router config change | P3 |
| FR-LEARN-31 | Retain meta-lesson to `*-meta` bank + nightly consolidation | P3 |
| FR-LEARN-32 | Meta-recall applies anti-pollution guards | P3 |
| FR-LEARN-33 | Goodhart guard: every KPI displayed with paired counter-metric | P5 (escaped-defect pair gated by P2) |

### Non-Functional Requirements

| ID | One-line | Phase / Scope |
|---|---|---|
| NFR-ACC-1 | 100% workers map to Paperclip row terminating at root (0 orphans) | P1 ★ |
| NFR-ACC-2 | Full audit chain reconstructable, all 10 joins resolve | P1 ★ |
| NFR-ACC-3 | No `issue.cost` field; per-issue cost solely from `cost_events` | P1 ★ |
| NFR-ACC-4 | Every escaped defect resolves to originating run/story subtree | **v5 deferred** |
| NFR-SAF-1 | No Pi team exceeds turn/wall-clock/budget cap | P0 ★ |
| NFR-SAF-2 | Story bound ≤8 retries, ≤1h wall-clock, else logged gate | P1 ★ |
| NFR-SAF-3 | `coms_await` carries timeout; no unbounded blocking wait | P0 ★ |
| NFR-SAF-4 | No dirty-diagnostics emit; waivers explicitly logged | P1 ★ |
| NFR-SAF-5 | Router exploration ≤10% eligible / 0% high-risk-novel | **v5 deferred** |
| NFR-SAF-6 | Logged waivers ≤5% of nodes emitted over W (active in v4) | P1 ★ (v5 ext deferred) |
| NFR-COST-1 | Every run writes ≥1 `cost_events`; never silently exceeds cap | P1 ★ |
| NFR-COST-2 | Cost/story queryable per issue tree at any time (≤2s) | P1 ★ |
| NFR-COST-3 | Learning is not a token hog (v4: bounded recall+retain+cron) | P1 ★ (v4 portion); full cap v5 |
| NFR-COST-4 | L4-promoted change ≤+5% cost/story or auto-reverts | P5-scope (L4/promotion) |
| NFR-PERF-1 | In-node swarms capped at ≤4 concurrent Pi agents | P1 ★ (structural; applies P0+) |
| NFR-PERF-2 | Prefer more DAG nodes over larger swarms when >4 needed | P1 ★ |
| NFR-PERF-3 | Phase-5 load test: 3 stories parallel within combined budget | P5 |
| NFR-PERF-4 | Hindsight recall ≤2s p95 cloud / ≤1s self-host; never blocks | P0/P1 ★ |
| NFR-PERF-5 | pi-gitnexus-plus augmentation ≤1.5s p95, advisory fallback | P0 ★ |
| NFR-PERF-6 | Warm per-worktree LSP; `lsp_diagnostics` ≤3s p95 | P0 ★ |
| NFR-PERF-7 | Per-run config selection ≤200ms p95, fails safe to default | P1 ★ |
| NFR-PERF-8 | Counterfactual estimator offline ≤2s; shadow ≤4% spend | **v5 deferred** |
| NFR-SEC-1 | No secret hardcoded; `server.secret.json` is 0600 | P0 ★ |
| NFR-SEC-2 | Paperclip API uses bearer per-agent key + run-scoped header | P0 ★ |
| NFR-SEC-3 | pi-lens secret-scan every worker turn; blocks emit on detect | P0 ★ |
| NFR-SEC-4 | Plugin installs restricted to instance admins | P0 ★ |
| NFR-SEC-5 | Auth-protected Hindsight: all memory calls send Bearer token | P0/P1 ★ |
| NFR-OBS-1 | Every Archon run streams SSE + persists retrievable run log | P1 ★ |
| NFR-OBS-2 | Dashboard renders four yield KPIs over rolling W | P5 (charting) |
| NFR-OBS-3 | Every cross-component handoff logged with issue-id correlation | P1 ★ |
| NFR-OBS-4 | Audit walk ≤30s; KPI refresh cadence + last-refresh timestamp | P1/P5 (split) |
| NFR-OBS-5 | GitNexus graph refreshed 4–6h cadence; staleness ≤8h | P3 |
| NFR-OBS-6 | (v4) Every config reconstructable + every KPI shows counter-metric | P1/P5 (split) |
| NFR-REL-1 | Mid-run crash recoverable; never corrupts ledgers | P5 |
| NFR-REL-2 | Restart classification deterministic given failure signal | P1 ★ |
| NFR-REL-3 | L2/L3 memory writes idempotent under retry (document_id=runId) | P1/P3 |
| NFR-REL-4 | All Layer-B learning writes idempotent (key on runId) | P1 ★ |

---

## §6.1 Control-plane — Paperclip (`FR-CP`)

- **FR-CP-1** [P1 ★]: The system can represent every agent (managers + workers) as a Paperclip agent row with a `reportsTo` link forming a complete org chart.
- **FR-CP-2** [P1 ★]: The system can enforce a monthly budget cap per agent and per company, tracking spend against cap.
- **FR-CP-3** [P1 ★]: The system can record every unit of work as an issue carrying assignee, status, and parent (decomposition tree).
- **FR-CP-4** [P1 ★]: The system can attribute cost to an issue via a cost-event ledger entry linked to that issue. **[Δ ledger, not field]**
- **FR-CP-5** [P1 ★]: The system can attach an `executionPolicy` to an issue that defines when a human approval gate is required.
- **FR-CP-6** [P1 ★]: The system can persist every approval decision (who, when, outcome, note) and every execution-gate decision.
- **FR-CP-7** [P1 ★]: The system can record an execution trace (heartbeat run) per agent run, with status, timing, usage, and result references.
- **FR-CP-8** [P1 ★ / exercised P3]: The operator can schedule recurring manager activity via cron-expression routines.
- **FR-CP-9** [P0 ★]: An administrator can install a plugin (npm package or local path) via the plugin-install endpoint.
- **FR-CP-10** [P0 ★]: A plugin can subscribe to core domain events (e.g., `issue.created`) through the event bridge.
- **FR-CP-11** [P0 ★]: An external Hermes manager can register into Paperclip as an agent and authenticate all REST calls with a host-injected per-agent API key + run id.
- **FR-CP-12** [P1 ★]: The system can roll up per-issue ledger cost into the owning agent's and company's `spentMonthlyCents`, so any spend is reconcilable both at the issue level and the cap level. **[Δ ledger roll-up]**
- **FR-CP-13** [P3]: A scheduled routine can trigger (wake) a specific department manager, handing it the routine's run context so the manager begins its sweep without human input.

---

## §6.2 Manager — Hermes (`FR-MG`)

- **FR-MG-1** [P1 ★]: Each department manager (Dev/QA/Maintenance) can run as a 24/7 tool-loop registered as a Paperclip agent under the root org chart with a budget.
- **FR-MG-2** [P1 ★]: The Dev manager can accept an intake request and create a corresponding Paperclip issue.
- **FR-MG-3** [P1 ★]: The Dev manager can decompose an issue into Seeds stories with dependency links, then mirror those stories to Paperclip issues (authority split: Seeds owns dependencies; Paperclip owns assignment + cost). **Sync protocol:** the mirror is **one-directional (Seeds→Paperclip), called explicitly by Hermes after `sd create` succeeds** (not event-driven). **Idempotency key:** the Paperclip child issue sets `originKind='seeds_story'` + `originId=<seeds_story_id>` (`issues.ts:45-46`); a matching partial unique index on `(companyId, originKind, originId)` (the established pattern at `issues.ts:93-141`) makes re-mirroring **upsert status, never create a duplicate**. **Authority on divergence:** Paperclip wins on assignment+cost, Seeds wins on dependency edges + status; divergences are logged. **Not mirrored:** Seeds `blocks[]`/`blockedBy[]` dependency edges are NOT copied to Paperclip `parentId` — `parentId` (`issues.ts:29`) is the **decomposition** tree, not a dependency edge (Paperclip dependency relations, if ever needed, belong in `issue_relations`, never `parentId`). The §8 audit walk reads both stores separately. (R2 mitigation.)
- **FR-MG-4** [P1 ★]: A manager can launch an Archon workflow run for an issue and consume its SSE stream to capture progress and outputs. **In Phase 1 the SSE stream is consumed sequentially (blocking)** per the §4.1 Hermes concurrency model — Hermes' `delegate_task` is a blocking scatter-gather (≤3 children, no SSE consumer on disk); non-blocking per-story concurrency is a **Phase-3 upgrade** (net-new async child-runner), not assumed in the make-or-break slice.
- **FR-MG-5** [P1 ★]: A manager can select, per node, a swarm archetype and per-role model tier via the model-router (Section 7 wrappers).
- **FR-MG-6** [P1 ★]: A manager can prime a node's agents with house-style context from Mulch before execution.
- **FR-MG-7** [P1 ★]: A manager can retain run learnings to a memory bank and recall relevant prior learnings to prime subsequent work.
- **FR-MG-8** [P1 ★]: A manager can apply a restart policy on failure: transient→resume, overflow→re-scope, logic→replan, bounded by retry + wall-clock caps. **Restart signal→class mapping** — Archon exposes only `failed`/`cancelled` at the run layer (`workflow-run.ts:10-32`; `RESUMABLE = {failed, paused}` `:29-32`); there is **no `TIMEOUT`/`LOGIC_ERROR` enum on disk**, so finer class is reconstructed from the node error string, the `err.killed` timeout flag, `cost_events` token sums, or a launcher-emitted `exit_class` field (§4.6). [Mapping table: timeout/wall-clock kill → transient (resume from checkpoint); token-sum over threshold → overflow (Hermes re-scopes Seeds story, reruns); `exit_class:"logic"` → logic (escalate to human gate via FR-CP-5); any other `failed` → transient default (resume, count toward ≤8-retry cap NFR-SAF-2); `cancelled` → operator-initiated, not auto-restarted.] This mapping is the deterministic basis for FR-MG-9's classification and feeds NFR-REL-2.
- **FR-MG-9** [P1 ★]: A manager can classify a failure signal into a restart category (transient/overflow/logic) and log that classification so retry-count is attributable by cause (feeds the §9.2 retry KPI and NFR-REL-2). **[restart classification]**
- **FR-MG-10** [P3]: A manager can reflect over its per-manager `*-meta` bank to propose a model-router/skill tuning (which tier won on cost vs quality), recording the proposed change for review (loop L4).

---

## §6.3 Orchestration — Archon DAG (`FR-OR`)

- **FR-OR-1** [P1 ★]: The system can author and register a custom `qds-piv-loop` workflow (the 14-node QDS variant of the 8-node base PIV).
- **FR-OR-2** [P1 ★]: The system can run a workflow via `POST /api/workflows/{name}/run` and stream its execution via the dashboard SSE endpoint.
- **FR-OR-3** [P0 ★]: The system can execute a heavy node as a bash node that invokes an external launcher script and captures its stdout as the node output.
- **FR-OR-4** [P0 ★]: The system can inject per-node environment variables into a bash node's subprocess (requires the 3-site env patch: `bashNodeSchema` field + `executeBashNode` env-merge + `@archon/git` `exec.ts` type widening — §4.4; spike-proven, OQ-6/Appendix D). **[Δ load-bearing]**
- **FR-OR-5** [P1 ★]: The system can run each workflow in a fresh-context, worktree-isolated workspace so concurrent runs cannot collide on working state. **Worktree lifecycle (verified against Archon on disk):** the worktree is **created by Archon at run setup** — the orchestrator resolves/creates the isolation env and passes `cwd` into the run (`orchestrator.ts:117-172,272`; `git worktree add` in `packages/isolation/src/providers/worktree.ts:765-913`) — **one worktree per run, reused across the run's nodes**, not per node. **Branch naming is Archon's `generateBranchName()` scheme** (`providers/worktree.ts:426-444`); the blueprint's `qds/{issue}/{run}` form is **not** Archon's convention and would require patching `generateBranchName` (a **net-new requirement**). **Cleanup:** Archon's `cleanup-service.ts` provides worktree teardown on a **scheduled interval keyed to a day-scale staleness threshold** (`STALE_THRESHOLD_DAYS`, default 14) — not triggered on run completion, no 2h-orphan policy; the factory's tighter orphan sweep (age>2h, no active run) in the Phase-3 Maintenance sweep is a **net-new policy**. **Concurrent isolation:** each run's own branch+worktree means concurrent stories cannot collide on the working tree; they MAY collide on merge order — the wave-executor problem (Phase-4 deferred).
- **FR-OR-6** [P1 ★ / exercised end-to-end P4]: The system can pause a run at an approval node pending an external decision, then **resume on approval OR halt/cancel the run cleanly on reject** (no partial or corrupt state on either path).
- **FR-OR-7** [P1 ★]: The system can capture and persist a run's SSE event stream as a retrievable post-hoc run log correlated to the originating issue id (the Archon-run hop of the audit chain, §8.1). **[SSE capture]**

---

## §6.4 Execution — Pi team / coms / pi-lens (`FR-EX`)

- **FR-EX-1** [P0 ★]: The system can launch N named Pi agents into a same-machine team via `pi-team-launch.sh`, each with a distinct identity (`--cname`/frontmatter), assigned model (anthropic or openrouter), and system prompt.
- **FR-EX-2** [P0 ★]: Team agents can exchange messages peer-to-peer (`coms_send`/`coms_await`) and request structured replies via `response_schema` (parse-enforced). Because `response_schema` is **parse-only** (`JSON.parse` on `agent_end`, **not** schema-validated — §5.2, R5), the **lead MUST perform explicit schema validation** on each worker's `coms_await` result before accepting it (synchronous in the lead's response handler, §4.6); a result that fails validation is a **logic error** (not a coms timeout) — the lead re-requests, or fails the node when retries are exhausted. (CORRECTNESS-E.)
- **FR-EX-3** [P0 ★]: The launcher can enforce hard guards: per-team budget cap, turn cap, wall-clock time cap, `tilldone` task-gate, and `coms_await` timeout — such that a loopy prompt terminates instead of burning unbounded budget.
- **FR-EX-4** [P0 ★]: Each worker agent can run pi-lens to perform in-node QA (secrets/lint/security scan, read-before-edit guard) and emit a turn-end report with stable finding IDs and a TDI value.
- **FR-EX-5** [P0 ★]: The system can obtain pi-lens output in a headless run (`--mode json`/`rpc`) suitable for machine consumption by the DAG. **[depends on Phase-0 spike outcome]**
- **FR-EX-6** [P1 ★]: The team lead can merge worker outputs into a single structured JSON result emitted to stdout as the node output (stdout protocol per §4.6).
- **FR-EX-7** [P1 ★]: The system can select a swarm archetype per node (Solo / Pair / TDD-Trio / Contract-split Quad / QA-Hunter-Pack / Maintenance), defaulting to the TDD-Trio floor for non-trivial Dev nodes (Section 7).
- **FR-EX-8** [P0 ★]: When headless TDI is unavailable (OQ-2 negative), the system can fall back to a logged proxy metric (pi-lens warning count via `--mode rpc`) for the affected node, recording that the fallback is in effect rather than silently dropping the signal (§9.3). **[explicit fallback]**
- **FR-EX-9** [P0 ★]: Every Pi worker agent can traverse and understand the codebase via a graph-aware context layer (pi-gitnexus-plus): file reads and searches are auto-augmented with call chains, execution flows, and blast radius (auto-augmentation enabled for judgment roles — Architect/Reviewer — and on-demand for the constrained Implementer, bounding per-agent token tax; NFR-PERF-5, R1), and agents can query the graph directly (`gitnexus_context` / `gitnexus_impact` / `gitnexus_query` / `gitnexus_cypher`) instead of relying on blind grep. Graph augmentation is advisory and non-blocking (NFR-PERF-5). **Cold-start (empty graph):** on an un-analyzed repo `gitnexus_context`/`gitnexus_impact` return empty/error and the agent falls back to grep with a logged warning (NFR-PERF-5); the initial `gitnexus analyze` (Phase-0 item 6) must complete to a non-error state **before any Phase-1 story executes** (sequencing constraint, §13 Phase-0 gate). **[graph-aware traversal]**
- **FR-EX-10** [P0 ★]: Every Pi worker agent can resolve code semantics against an **active (warm, per-worktree) language server** — definitions, references, hover/type-info, workspace symbols, and call hierarchy — reflecting uncommitted edits, instead of inferring signatures from text; and can perform semantically-safe cross-file rename (`apply:true`). Surface = pi-lens `lsp_navigation` (fallback `@spences10/pi-lsp` for nav-only roles; rename `apply:true` requires the pi-lens surface); §4.5. **[live LSP nav]**
- **FR-EX-11** [P1 ★]: An implement/maintenance node **cannot emit its result while `lsp_diagnostics` reports errors on the files it changed** — the gate runs **at node emit over the union of all files changed by any agent in the node** (not per-agent, so contract/test-scaffold files are covered) and must reach 0 errors (or an explicitly logged **waiver**) before handoff (post-edit diagnostics gate; part of the pi-lens turn-end gate; feeds L1). **Collection protocol:** each worker emits its changed-file list in the `response_schema`'s mandatory `changed_files: string[]` field (§4.6); the lead aggregates these into the union set before running `lsp_diagnostics`. A worker that omits `changed_files` causes the lead to **fail the node** (a logic error, not a waivable diagnostics failure — CORRECTNESS-C). **Headless `lsp_diagnostics` machine-readable emission is unconfirmed — the same OQ-2 concern as TDI (§5.4, FR-EX-5); if TUI-only, the gate degrades per FR-EX-12.** **[diagnostics gate]**
- **FR-EX-12** [P1 ★]: When headless `lsp_diagnostics` is unavailable (OQ-2 LSP sub-finding negative) **OR** no language server exists for a changed file's language **OR** diagnostics exceed their latency budget (NFR-PERF-6), the post-edit gate **degrades to pi-lens ast-grep + test-pass** as the emit precondition for the affected file(s), recording an explicit **logged waiver** (a gate-bypass record counted by NFR-SAF-4) — never a silent skip (§9.3 logged-fallback pattern). **[diagnostics-gate fallback]**

---

## §6.5 Memory & decomposition — Hindsight / Mulch / Seeds (`FR-MEM`)

- **FR-MEM-1** [P0 ★]: The system can create per-repo and per-manager memory banks (`{repo}`, `{repo}-dev-meta`, `{repo}-qa-meta`, `{repo}-maint-meta`).
- **FR-MEM-2** [P0/P1 ★ — SPLIT]: A manager can retain a memory (finding, decision, outcome) to a bank and recall by relevance (semantic/BM25/graph/temporal) to prime a system prompt. **Cold-start (empty bank):** recall on an empty bank returns an empty result set and the node **proceeds unprimed with a logged warning** (NFR-PERF-4) — recall is an enhancement, never a hard dependency; this is the day-1 baseline. *(§6.8: partial FR-MEM-2 (retain/recall round-trip) in Phase 0; full FR-MEM-2 in Phase 1.)*
- **FR-MEM-3** [P2]: QA findings retained to a shared per-repo bank can be recalled by the Dev manager on its next implement (cross-department learning transfer).
- **FR-MEM-4** [P0 ★]: The system can decompose work into Seeds issues with dependency edges, queryable for "ready" (unblocked) work, persisted in `.seeds/issues.jsonl` traveling with the repo.
- **FR-MEM-5** [P1 ★ — nightly consolidation P3]: The system can record reusable expertise to Mulch and generate a priming prompt from it; nightly consolidation can fold session memory into the long-term bank. *(§6.8: FR-MEM-5 in Phase 1; FR-MEM-5 nightly consolidation in Phase 3.)*
- **FR-MEM-6** [P3]: The system can keep the GitNexus knowledge graph current via a scheduled refresh agent that spins up every **4–6h**, runs `gitnexus analyze`, and spins down — so agents always traverse a near-current graph (staleness bounded by NFR-OBS-5). `gitnexus analyze` builds into a **staging index and atomically swaps** the active graph on completion (in-flight queries complete against the pre-swap snapshot — no torn reads); if atomic swap is unavailable, the refresh routine instead takes an **advisory lock** and the Maintenance scheduler must not fire a refresh while a graph-consuming DAG run is active for that repo. **[graph refresh routine]**

---

## §6.6 Comms (`FR-CM`)

- **FR-CM-1** [P1 ★]: An external stakeholder can submit work and queries via Telegram slash commands (`/qds …`, `/status`, `/approve`).
- **FR-CM-2** [P1 ★]: The system can surface an approval gate as a Telegram message with inline approve/reject buttons, and resume the paused run on the tap.
- **FR-CM-3** [P4]: The system can route different message types to different chats (per-type routing).
- **FR-CM-4** [P4]: The system can accept intake from iMessage (and other Hermes channels) and forward it into Paperclip as an issue.
- **FR-CM-5** [P4]: The system can emit outbound status/digests unified through Paperclip to both the dashboard and Telegram.

---

## §6.7 Accountability & yield (`FR-ACT`)

- **FR-ACT-1** [P1 ★]: Given a merged PR, an operator can reconstruct (walk) the full audit chain — memory-bank entry → pi-lens report → Pi team (agent names/models/coms log) → Archon run → heartbeat run → approvals/gate decisions → cost ledger → Paperclip issue → Seeds story → epic — with no missing hop. **[audit-chain reconstruction]**
- **FR-ACT-2** [P1 ★ — per-story]: The system can compute and record the four yield KPIs — TDI trend, cost/story (sum of `cost_events` over an issue tree), first-pass PR-accept rate, retry count — from their §9.2 recording sites, per story and over a rolling window.
- **FR-ACT-3** [P5]: The dashboard can chart the four yield KPIs over a rolling window (the rendered yield curve: TDI↓, cost/story↓, first-pass-accept↑, retry↓). **[yield-curve charting]**

---

## §6.9 Self-optimization & learning (`FR-LEARN`) — v4 foundation

> v4 ships only FR-LEARN-28..33 (the native data substrate). FR-LEARN-1..27 are deferred to v5 (§6.10) and out of scope for this sprint.

- **FR-LEARN-28** [P1 ★]: The system can **record a per-run outcome record** `{task_type, archetype, per_role_model_tier, cost_cents, input_tokens, output_tokens, cached_tokens, first_pass_accept, retry_count, retry_class, wall_clock_ms}` for each run, each field read from a native recording site (`cost_events` for per-role/per-model cost+tokens via `agentId`/`model`/`heartbeatRunId`; `activity_log`/`issues.status` for accept; `heartbeat_runs` for timing/retries), keyed on `runId` as an **idempotent upsert** (NFR-REL-4). *(v4 condensation of the v5 FR-LEARN-1/2 signature+outcome-vector.)*
- **FR-LEARN-29** [P1 ★]: The **`qds-model-router` selects** the node archetype (§7 A–F) and per-role model tier from the **§7 defaults**, the **blast-radius floor (§7 dominating rule)**, and the **risk-tier constraint (FR-CP-5)** — enumerating only the legal arms for the task and excluding any arm disallowed by the issue's risk tier or by the §4.2 structural caps (no >4-agent node is representable; a more-nodes decomposition is mandatory when required capacity >4). **Arms violating the blast-radius floor (§7) are excluded from the legal-arm catalog identically to the risk-tier exclusion.** The selection is logged with its rationale (signature inputs + chosen archetype/tier + the constraint that bound it). *(v4 deterministic core.)*
- **FR-LEARN-30** [P3]: A **weekly Paperclip cron routine** reads the outcome records (FR-LEARN-28) and the `{repo}-*-meta` Hindsight banks, produces a human-readable rationale summary via `reflect`, and **proposes (does NOT auto-apply) a `qds-model-router` config change**, recorded to the manager's `*-meta` bank (extends FR-MG-10). The operator reviews and applies the change manually; nothing is promoted to production automatically in v4.
- **FR-LEARN-31** [P3]: The system can **retain a meta-lesson** (`{archetype, role_tier_map, cost, outcome, runId}`) to a `*-meta` bank as an `experience` fact with `document_id = runId` (idempotent upsert, NFR-REL-4) under a `retain_mission` that ignores code-level findings; **nightly consolidation** (`POST …/consolidate` → observations) promotes durable lessons.
- **FR-LEARN-32** [P3]: Meta-recall applies **anti-pollution guards** — strict tag-match (`tags_match=all_strict`) + a `memory_type` entity-label filter so meta-recall never returns Layer-A code noise. **Numbers live in the outcome-record table (FR-LEARN-28), never in Hindsight** — a `*-meta` recall is never used as a numeric source of truth (R26 guard).
- **FR-LEARN-33 (Goodhart guard)** [P5 — escaped-defect pair gated by P2]: Every yield KPI (§9.2) is **displayed with its paired counter-metric** — first-pass-accept with **escaped-defect rate** (Phase-2 QA dependent); cost/story with **cost-per-accepted-PR**; retry-count with **unclassified-restart rate**; TDI with **pi-lens warning count**. **No KPI panel renders without its pair** (NFR-OBS-6; R15 mitigation).

---

## §11 Non-Functional Requirements

### §11.1 Accountability (`NFR-ACC`)

- **NFR-ACC-1** [P1 ★]: 100% of worker agents map to a Paperclip agent row with a `reportsTo` ancestor terminating at the root agent (no orphan/anonymous workers). *Threshold: 0 orphan actors in any reconstructed chain.*
- **NFR-ACC-2** [P1 ★]: For any merged PR, the full audit chain (§8.1) is reconstructable via the §8.4 contract with **no missing hop** (every one of the 10 joins resolves).
- **NFR-ACC-3** [P1 ★]: **No `issue.cost` field exists; per-issue cost is derived solely from `cost_events`.** *Threshold: schema check passes (no `cost` column on `issues`) and per-issue cost equals SUM(`cost_events.costCents`) for that issue in 100% of audited issues.*
- **NFR-ACC-4** [**v5 deferred**]: Every escaped defect (a QA-department / post-merge fix issue) resolves to its **originating run and story subtree** (extends the §8.4 audit contract). *Threshold: 0 escaped-defect issues with no resolvable originating-run link in 100% of audited cases (subject to OQ-10; coarser repo-level attribution flagged as a proxy if the link is unavailable).* (FR-LEARN-20, v5) *Note: not a v4 obligation.*

### §11.2 Safety / Guardrails (`NFR-SAF`)

- **NFR-SAF-1** [P0 ★]: No Pi team can exceed its configured turn cap, wall-clock cap, or budget cap; a loopy prompt must terminate via the guard, not by exhausting credits.
- **NFR-SAF-2** [P1 ★]: Default story bound = ≤8 retries and ≤1h wall-clock; exceeding either escalates to a logged human gate rather than silently retrying.
- **NFR-SAF-3** [P0 ★]: `coms_await` calls must carry a timeout (upstream default 30 min, `PI_COMS_TIMEOUT_MS` = `1_800_000ms`); no unbounded blocking wait. **Recommended per-archetype starting values:** Solo/Pair = 10 min per await; TDD-Trio = 8 min; Contract-split Quad = 6 min. Configurable via `PI_COMS_TIMEOUT_MS` in `pi-team-launch.sh`'s per-node env map (FR-OR-4, §4.6); tune downward after the Phase-0 demo reveals real p99 agent-turn durations (OQ-16b). *Threshold: 0 unbounded `coms_await`; per-archetype timeout ≤ the recommended start unless an override is logged.*
- **NFR-SAF-4** [P1 ★]: No implement/maintenance node emits a result while `lsp_diagnostics` reports errors on its changed-file union; any waiver (no server for that language, headless-TUI-only, or diagnostics timeout) is explicitly logged with a reason. *Threshold: 0 un-waived dirty-diagnostics emits.* (FR-EX-11/12)
- **NFR-SAF-5** [**v5 deferred**]: Router exploration is **≤10% of eligible (non-high-risk, non-novel) runs** over any rolling 7-day window and **0% of high-risk-tier or novelty>θ runs**. *Threshold: high-risk/novel exploration count = 0; eligible-run exploration share ≤10%.* (FR-LEARN-7, v5) *Note: v4 has no exploration to bound.*
- **NFR-SAF-6** [P1 ★ — active in v4; v5 extension deferred]: Logged diagnostics/gate waivers (NFR-SAF-4) are **≤5% of nodes emitted over W** — this waiver-rate ceiling is **active in v4** (it guards the FR-EX-12 LSP-gate degrade). *Threshold: waiver-rate ≤5%.* *(v5 extension, §6.10):* no policy-proposed config is promoted until it clears the **quality floor** (FR-LEARN-21), and a waiver-rate breach **auto-freezes L4 promotion** — both deferred (v4 has no auto-promotion). *Threshold (v5): 0 promotions regressing the floor.*

### §11.3 Cost governance (`NFR-COST`)

- **NFR-COST-1** [P1 ★]: Every agent run writes ≥1 `cost_events` entry; agent/company `spentMonthlyCents` never silently exceeds cap (over-cap → gate/halt). *Threshold: 0 runs with spend but no ledger row; 0 silent over-cap events.*
- **NFR-COST-2** [P1 ★]: Cost/story is queryable per issue tree at any time from the ledger (no end-of-month-only reconciliation). *Threshold: per-issue-tree cost query returns in ≤2 s.*
- **NFR-COST-3** [P1 ★ (v4 portion); full cap v5]: In **v4** the only learning tax is the single bounded recall (already capped by NFR-PERF-4) + one event-driven retain (§9.4.0 principle 2) + the weekly FR-LEARN-30/31 cron — a negligible, bounded overhead with no shadow runs. *Threshold (v4): no ratio cap — negligible-by-design; structural compliance = exactly one NFR-PERF-4-capped recall + one event-driven retain per run + the offline FR-LEARN-30/31 cron, audited by querying `cost_events` filtered to the learning-cron `heartbeatRunId`.* The full cap applies in **v5**: learning-attributable spend **≤10%** of total factory spend over W, within which **shadow runs are a strict sub-cap ≤4%**; baseline/ablation-attributed net savings must **meet or exceed** learning spend over a rolling 3×W window. *Threshold (v5): learning-overhead ratio ≤10% (shadow ≤4%); net savings ≥ 0 over 3×W, else throttled (R21).*
- **NFR-COST-4** [P5-scope (L4/promotion)]: A router/skill/guardrail change promoted by L4 must **not increase rolling-W cost/story by more than +5%** vs the pre-change baseline; a breach auto-reverts the change and logs it. *Threshold: ≤+5% cost/story over W post-change, else revert.*

### §11.4 Performance / Concurrency (`NFR-PERF`)

- **NFR-PERF-1** [P1 ★ — structural, applies P0+]: In-node swarms are capped at ≤4 concurrent Pi agents (coms n² coordination ceiling).
- **NFR-PERF-2** [P1 ★]: The factory must prefer additional DAG nodes over larger swarms when capacity > 4 agents is needed.
- **NFR-PERF-3** [P5]: Phase-5 load test: 3 stories run in parallel and complete within their combined budget without state corruption.
- **NFR-PERF-4** [P0/P1 ★]: A Hindsight `recall` priming a node prompt (budget `mid`, `max_tokens` ≤ 4096) must return within **≤2 s p95** (cloud) / **≤1 s p95** (self-host), and must **never block** the implement node beyond the `coms_await` timeout. On recall timeout, the node proceeds **unprimed with a logged warning** — recall is an enhancement, never a hard dependency of the critical path.
- **NFR-PERF-5** [P0 ★]: The pi-gitnexus-plus read/search augmentation returns within **≤1.5 s p95** and must not block an agent turn beyond that budget; if the graph is unavailable or a query exceeds budget, the agent falls back to ordinary file/grep access **with a logged warning**. Graph augmentation is *advisory* → its fallback logs a **warning** (distinct from the LSP diagnostics gate, a *hard gate* whose degrade logs a **waiver** counted by NFR-SAF-4); never a hard dependency of the critical path.
- **NFR-PERF-6** [P0 ★]: An **active (warm) LSP server is maintained per Pi worktree**; language-server cold-start is amortized once per worktree session, not per turn. `lsp_diagnostics` on a changed-file set returns within **≤3 s p95** and reflects the agent's uncommitted edits. If no server exists for a changed file's language **or diagnostics exceed the latency budget**, the diagnostics gate degrades to pi-lens ast-grep + tests with an explicit **logged waiver** (FR-EX-12), never a silent skip or an unbounded hang.
- **NFR-PERF-7** [P1 ★]: Per-run config selection (signature compute + legal-arm enumeration + the deterministic §7-default pick under the risk-tier + blast-radius constraints) returns within **≤200 ms p95** and never bottlenecks node dispatch; on selection-path failure it fails safe to the §7 archetype default. *Threshold: ≤200 ms p95.* (FR-LEARN-29)
- **NFR-PERF-8** [**v5 deferred**]: The counterfactual estimator (FR-LEARN-9) runs **offline from logged data only — 0 task re-executions — in ≤2 s p95**; shadow runs (FR-LEARN-10) consume **≤4% of total factory spend over W and ≤N/day** (default N=3) — a strict sub-cap *within* the ≤10% learning envelope of NFR-COST-3. *Threshold (v5): 0 estimator-triggered task runs; 0 windows over the shadow sub-cap; 0 production side-effects from shadow.*

### §11.5 Security (`NFR-SEC`)

- **NFR-SEC-1** [P0 ★]: No secret is hardcoded; credentials are referenced (env / secret refs), and `server.secret.json` is `0600`.
- **NFR-SEC-2** [P0 ★]: All Paperclip API access uses bearer auth with a per-agent key (`PAPERCLIP_API_KEY`) + run-scoped header (`PAPERCLIP_RUN_ID`).
- **NFR-SEC-3** [P0 ★]: pi-lens secret-scan runs on every worker turn; a detected secret blocks the turn-end emit until cleared.
- **NFR-SEC-4** [P0 ★]: Plugin installs are restricted to instance admins.
- **NFR-SEC-5** [P0/P1 ★]: If the Hindsight server is deployed auth-protected (recommended for the cloud endpoint and any networked self-host), all memory calls send `Authorization: Bearer <token>` (SDK `api_key` / `HINDSIGHT_CP_DATAPLANE_API_KEY`); the token is supplied by env/secret ref, never hardcoded. *Note: `HINDSIGHT_API_LLM_API_KEY` is the LLM-provider key and is **not** the server-auth token — the two must not be conflated.*

### §11.6 Observability (`NFR-OBS`)

- **NFR-OBS-1** [P1 ★]: Every Archon run streams via SSE and persists a run log retrievable post-hoc.
- **NFR-OBS-2** [P5 — charting]: The dashboard renders the four yield-curve KPIs (§9.2) over rolling window W.
- **NFR-OBS-3** [P1 ★]: Every cross-component handoff (manager→Archon→Pi-team→pi-lens→memory) is logged with correlation back to the issue id.
- **NFR-OBS-4** [P1/P5 — SPLIT]: (a) The full §8.4 audit-chain walk for one PR completes in **≤30 s** by an operator/tool following the documented joins (no manual log-grepping). (b) The §9.2 KPI series are refreshed on a fixed cadence — **≤24 h** staleness for TDI/first-pass/retry, **≤5 min** for live cost/spend — and each KPI panel displays its last-refresh timestamp. *(Part (a) audit-walk relates to P1 FR-ACT-1; part (b) KPI-cadence relates to dashboard P5/FR-ACT-3.)*
- **NFR-OBS-5** [P3]: The GitNexus knowledge graph is refreshed on a **4–6h cadence** (`gitnexus analyze`, FR-MEM-6); **staleness = time since the last *completed* analyze**, kept **≤8h** (cadence + max analyze duration must fit inside the bound). *Threshold: 0 agent runs against a graph whose last completed analyze is >8h old; each refresh cycle logs success/failure, duration, and the indexed HEAD SHA.*
- **NFR-OBS-6** [P1/P5 — SPLIT; v5 ext deferred]: (a) **(v4)** Every served config is **reconstructable** — the `qds-model-router`'s selection rationale (signature inputs + chosen archetype/tier + the binding constraint) is persisted alongside the `heartbeat_run` (FR-LEARN-29). *Threshold: 0 served configs with no recorded rationale.* (b) **(v4)** Every §9.2 KPI panel renders its **paired counter-metric** (FR-LEARN-33). *Threshold: 4/4 yield KPIs show a paired counter-metric.* **(v5 — §6.10):** the full Layer-B KPI significance rendering (N, Mann-Kendall p-value, bootstrap CI, "insufficient data" state) lands with FR-LEARN-19/25. *Threshold (v5): 0 trend verdicts rendered at N<N_min or p≥0.10.* *(Part (a) is P1, riding FR-LEARN-29; part (b) lands with yield-curve charting at P5/FR-LEARN-33.)*

### §11.7 Reliability (`NFR-REL`)

- **NFR-REL-1** [P5]: A mid-run crash is recoverable with state repair (Phase-5); an interrupted run resumes or fails cleanly, never corrupting the issue/cost ledgers.
- **NFR-REL-2** [P1 ★]: Restart classification (transient/overflow/logic) is deterministic given the failure signal.
- **NFR-REL-3** [P1/P3 — SPLIT]: L2/L3 memory writes are idempotent under retry: retain uses `document_id = runId` so a re-run **upserts** rather than duplicating (Hindsight replaces the document on matching `document_id`), and nightly consolidation is bank-deduped server-side. *Threshold: 0 duplicate memory documents for a given runId after a retried run.* *(L2 retain rides Phase-1 memory; nightly consolidation is Phase-3.)*
- **NFR-REL-4** [P1 ★]: All Layer-B learning writes are **idempotent**: the per-run outcome record (FR-LEARN-28) and meta-lesson retain (FR-LEARN-31) key on `runId`/`document_id=runId` (upsert), so a re-run upserts rather than duplicating. *Threshold: 0 duplicate outcome/meta records per `runId`.* *(v5 — §6.10):* the weekly policy recompute (deferred) is deterministic and row/bank-deduped — re-firing the cron yields an identical `router_config_hash` over unchanged data.

---

## Ambiguous / Split Phase Assignments (flag for story writers)

- **FR-MEM-2** — SPLIT: §6.8 puts *partial* FR-MEM-2 (retain/recall round-trip) in **Phase 0** and full FR-MEM-2 in **Phase 1**.
- **FR-MEM-5** — SPLIT: base capability **Phase 1**; nightly consolidation **Phase 3**.
- **FR-CP-8** — base scheduling capability **Phase 1**; *exercised* in **Phase 3**.
- **FR-OR-6** — capability **Phase 1**; gate→ping→resume *exercised end-to-end* in **Phase 4**.
- **FR-LEARN-33** — lands **Phase 5** (yield charting), but its escaped-defect counter-metric pair is **gated by Phase-2 QA**.
- **NFR-OBS-4** — SPLIT: part (a) audit-walk ≤30s (P1-aligned) vs part (b) KPI refresh cadence (dashboard, P5).
- **NFR-OBS-6** — SPLIT: part (a) config reconstructability is v4 P1 (rides FR-LEARN-29); part (b) counter-metric rendering lands P5 (FR-LEARN-33); v5 significance-rendering extension deferred.
- **NFR-REL-3** — SPLIT: L2 retain idempotency (P1 memory) vs nightly consolidation dedup (P3).
- **NFR-COST-3 / NFR-SAF-6 / NFR-PERF-1** — each carries a v4-active clause AND a v5-deferred extension; only the v4 clause is in sprint scope.
- **NFR-PERF-1** — phrased as a structural invariant (≤4 agents/node); enforced from Phase 0 launcher onward though formally "P1" by association.

> NFRs are not enumerated in §6.8 (that table is FR-only). NFR phase tags above are inferred from each NFR's explicit v4/v5 scope notes, its named phase (e.g. "Phase-5 load test"), and the FR it backs. Treat NFR tags as guidance, not a verbatim §6.8 mapping.
