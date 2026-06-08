# P1.16: Audit chain reconstructable for one real PR — every §8.1 hop walks, no missing hop

**Story Points:** 4

## Spec Reference

- PRD §8 (Accountability Model) — §8.1 chain, §8.4 query contract, §8.5 Phase-1 acceptance; FR-ACT-1, NFR-ACC-2
- Supporting: NFR-ACC-3 (per-issue cost solely from `cost_events`, no `issue.cost`), NFR-COST-2 (per-issue-tree cost queryable ≤2s), NFR-OBS-4(a) (full walk ≤30s), NFR-ACC-1 (0 orphan actors, `reportsTo`→root)
- Phase exit gate: PRD §13 Phase-1 clauses 5 ("for that PR, the full §8.1 chain … walks end-to-end with no missing hop") and 6 ("per-issue-tree spend from `cost_events` at or under the budget cap").

## User Story

As the Operator (and any external accountability stakeholder),
I want to take the one real PR produced by P1.15 and mechanically walk the full §8.1 lineage — epic → Seeds → Paperclip issue → cost_events → approvals/decisions → heartbeat_runs → Warren run → Pi team → pi-lens → Hindsight — via the §8.4 query contract,
so that every PR is provably traceable back to its epic with zero missing hops and per-issue spend is shown within budget (G2: accountability is the differentiator).

## Overview

This slice builds the audit-walk tool that executes the §8.4 query contract as a single ordered routine over the native records (no new ground-truth tables; every hop is a query over an existing on-disk store). It cuts through the run log (persisted by P1.15) → Paperclip (`issues`/`heartbeat_runs`/`cost_events`/`agents`/`approvals`/`issue_execution_decisions`) → Seeds `.seeds/issues.jsonl` → Pi team node output → pi-lens report → Hindsight bank, joining each hop on its documented key. It is one atomic 4pt unit because "no missing hop" is only demonstrable when all 10 joins resolve in one walk against a real PR — implementing a subset would leave the guarantee (and the §13 clause-5 gate) unproven.

## E2E Slice

**Demonstrable behavior:** Running `audit-walk <pr_url>` (or `audit-walk --issue <id>`) on the real PR from P1.15 resolves every §8.4 hop in order and emits a single structured report `{ hops: [...10], missing: [], perIssueSpendCents, budgetMonthlyCents, withinBudget: true, exit_class: "transient"|"overflow"|"logic" }` — `missing` is empty (every join resolved) and per-issue spend = `SUM(cost_events.costCents WHERE issueId ∈ subtree)` is at or under the agent/company `budgetMonthlyCents` cap. A deliberately broken hop (e.g. a run with no `cost_events` rows for the given issueId) makes `missing` non-empty and the tool exits non-zero.

**Wiring closed:** On completion of this story, `audit-walk <pr_url>` on the P1.15 PR produces a report with `missing == []` (all 10 §8.4 joins resolve) and `withinBudget == true`, completing in ≤30s, using only code merged by this story plus its listed predecessors. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P1.15 (the real PR exists + its run log correlates `pr_url`↔`issueId`, supplying hop 1), P1.13 (every run writes ≥1 `cost_events` row; per-issue-tree spend queryable within budget — hops 5 + the budget assertion), P1.11 (the audit-chain item the §8.1 walk reconstructs). Each store (Seeds, Paperclip, run log persisted by P1.15, pi-lens report, Hindsight bank) is populated by its own predecessor; this story only walks them.

**Transitive predecessors:** P1.3 (Seeds decompose + `.seeds/issues.jsonl` for hop 7), P1.5 (model router + pi-lens for hop 9), P1.6 (WarrenClient dispatch + node output for hop 8). The audit walk traverses stores populated by P1.1–P1.15; this story owns only the walker, not the store population.

## Acceptance Criteria

1. **(make-or-break)** Given the real PR from P1.15 and its populated lineage, When `audit-walk <pr_url>` runs, Then the report's `missing` array is empty — every one of the 10 §8.4 joins resolves (hops 1–10) — i.e. the full §8.1 chain walks with NO missing hop. (Binary: `missing.length === 0`.)
2. Given the walk resolves, When per-issue spend is computed, Then it equals `SUM(cost_events.costCents)` over the issue's `parentId` subtree (NOT any `issue.cost` field — there is none, NFR-ACC-3) and is at or under the agent/company `budgetMonthlyCents` cap (`withinBudget: true`), returned in ≤2s (NFR-COST-2). Budget check compares cost against BOTH the agent-level budget (if set on the agent's record) AND the company-level `budgetMonthlyCents`. If either threshold is exceeded, the cost is flagged. Comparison: `costCents > agent.budgetMonthlyCents OR costCents > company.budgetMonthlyCents`. If agent has no budget set, only company-level check applies.
3. Given any single hop is broken (a run with no `cost_events` rows for the given issueId — cost_events are issue-scoped, written by P1.6 and aggregated by P1.13; "no cost_events row" means zero rows exist for that issueId, NOT heartbeatRunId — if the issue has zero cost_events, the cost hop returns 0 cents and `resolved: false`), or an `issues.executionRunId` that resolves to no `heartbeat_runs.id`, or a Hindsight document whose `document_id != runId`), When `audit-walk` runs, Then that hop appears in `missing` and the tool exits non-zero — a missing hop is surfaced, never silently skipped.
4. Given the actor hop (hop 4), When the walk resolves `issues.assigneeAgentId → agents.id`, Then it walks `agents.reportsTo` to the root agent and reports 0 orphan/anonymous actors (NFR-ACC-1) — no work is attributable to an un-parented actor. **(deferred — placeholder only; `agents.reportsTo` not implemented in Phase 1; `orphanCount` defaults to 0. AC-4 will be enforced post-Phase-1 once the column exists.)**

## Technical Notes

- **§8.1 hop list (transcribed from PRD §8.1 / r3 §B):** epic → Seeds stories+deps (`.seeds/issues.jsonl`) → Paperclip issues (`assigneeAgentId`/`status`/`parentId`/`executionPolicy`) → {`cost_events` (costCents/issueId) | `approvals`+`issue_execution_decisions` | `heartbeat_runs`} → Warren run (SSE log, worktree) → Pi team (agent names/models/coms log) → pi-lens (TDI + stable IDs) → Hindsight (`document_id == runId`).
- **§8.4 query contract — exact joins (transcribed from PRD §8.4 / r3 §B):**
  1. PR → Warren run: Hop 1 resolution sequence (non-circular): **(a)** Input: `pr_url` from CLI argument. **(b)** Database lookup resolves `pr_url` → `runId`: `SELECT runId FROM heartbeat_runs WHERE metadata->>'pr_url' = $1 AND companyId = $2`. **(c)** With `runId`, read the run-log file from P1.15's sink directory: `$QDS_LOG_DIR/{runId}/run-log.json`. **(d)** Verify the run-log header's `pr_url` field matches the input `pr_url` (integrity check). If the database lookup returns no match, the walker falls back to the `--run-id` CLI flag. The run-log file is only readable AFTER the DB lookup provides `runId` — the walker does NOT scan the log directory to discover runIds.
  2. Warren run → issue: `issues.executionRunId`/`issues.checkoutRunId` (`issues.ts:37-38`) ↔ `heartbeat_runs.id`.
  3. issue → run trace(s): `heartbeat_runs` FK via the run-id columns.
  4. issue → assignee: `issues.assigneeAgentId` (`issues.ts:35`) → `agents.id` (+ `reportsTo` `agents.ts:24` walked to root).
  5. issue → cost: `cost_events.issueId` (`cost_events.ts:15`) = issue id; `SUM costCents` (`:27`).
  6. issue → decisions: `approvals.issueId` + `issue_execution_decisions.issueId` (`approvals.ts:5-28`).
  7. issue → decomposition: `issues.parentId` (`:29`) up to epic; Seeds `.seeds/issues.jsonl` (populated by P1.3) `blocks[]`/`blockedBy[]` for sibling deps.
  8. run → Pi team: reads the run-log's Warren bash node stdout JSON. The merged-output contains `changed_files[]` entries (P1.6 `WarrenClient` dispatch). Per-agent data is extracted from the run-log entry per bash node, keyed by node name (which maps to agent role). Coms log at `~/.pi/coms/{runId}/` per P1.6 launcher protocol. Walker parses node output JSON to extract agent roster from per-node entries, then reads coms log directory per agent.
  9. Pi team → pi-lens: reads `$PI_LENS_HOME/cache/actionable-warnings.json` (the TDI cache, verified-correct canonical path), filtered by `runId` via `resolveTdiSignal(): TdiSignal`. Per-agent turn-end data comes from the Warren bash node stdout JSON in the run-log (hop 8), NOT from a pi-lens cache subdirectory. The walker reads the TDI cache file and filters entries matching the target `runId`.
  10. run → memory: bank `{repo}` (the primary dev bank, matching P1.11 bank creation convention; bank name derived from `QDS_REPO_SLUG` env var — no `<dept>` suffix); `document_id == runId` (Hindsight `agent.run.finished` hook). The primary bank holds all per-run memories.
- **Reconstruction note:** hops 2–7 are all keyed on the Paperclip issue id — once hop 2 resolves run→issue, the rest are direct FK lookups (PRD §8.4 reconstruction guarantee). Walk latency bounded by NFR-OBS-4(a) ≤30s. All FK lookups in hops 2–7 MUST include `companyId` filter: `WHERE companyId = $QDS_COMPANY_ID` (or equivalent scoped lookup). Paperclip is tenant-scoped; omitting `companyId` risks cross-tenant joins. The walker reads `QDS_COMPANY_ID` from environment at invocation.
- **Files / functions touched:** `audit-walk.ts` (the 10-hop ordered resolver + report), the per-issue-tree cost SUM query (`cost_events` over `parentId` subtree), the hop-result types.
- **Guards/limits:** each hop is a single indexed lookup or bounded fan-out; total walk ≤30s (NFR-OBS-4a); per-issue cost SUM ≤2s (NFR-COST-2).
- **exit_class mapping:** The audit-walk report includes `exit_class: z.enum(["transient", "overflow", "logic"])` populated from `heartbeat_runs.exit_class` for the target run. This is a mandatory non-null field per the verified-correct exit_class convention — consumers (including P1.17 gate) need the audited run's exit classification in the report. The walk tool's process exit code (0 = success, non-zero = missing hops) remains the tool-level signal; the report-level `exit_class` field carries the run's exit classification for downstream consumers.
- **Hop join key sources (CC-4):** Hops 1, 8, 9 reference stores whose exact FK/API specs live in predecessor stories. Hop join keys reference stores populated by P1.15 (run-log sink), P1.6 (Warren node output JSON), and P1.5 (pi-lens artifacts at `~/.pi-lens/`). Exact field names and API paths are specified in each predecessor story's E2E Slice output contract. The audit-walk implementation reads these stores at their documented paths.
- **Resume/checkpoint (H4 design decision):** Walk is ≤30s (NFR-OBS-4a) and runs as a single atomic routine — no intermediate checkpoint needed. If interrupted, re-run from hop 1. Partial-progress reporting is out of scope for Phase 1. The ≤30s bound makes full-restart cost negligible.
- **Per-hop report structure (M1):** Each hop result in the report includes `{ hopIndex, name, resolved: boolean, key: string|null, source: string, error?: string, durationMs: number }`. These fields are defined in the per-hop structure and MUST appear in the report schema. When `missing` is non-empty, each entry names the hop number and descriptive name, the failed join key, and the source store — enabling diagnosis from the report alone without re-running the walk. A 9/10 pass still emits 10 hop results, the failed one with `resolved: false` and an `error` string explaining which join key did not resolve and why.
- **Citation caveat (M3):** File:line citations in the hop list (e.g., `approvals.ts:5-28`, `issues.ts:37-38`) are best-current-knowledge at spec time and may shift during implementation. The join-key column names (e.g., `approvals.issueId`, `issues.executionRunId`) are the contract; exact line numbers are entry points for the developer, not stable anchors.
- **§13 clause mapping (M5):** Clause 5 (audit-chain reconstruction) maps to PRD §13 Phase-1 clause 5. Clause 6 (per-issue spend within budget) maps to PRD §13 Phase-1 clause 6. Both are verified against the PRD §13 text.
- **Hop 7 / epic clarification (M7):** "Epic" = the root Paperclip issue where `parentId IS NULL`; there is no separate `epic` table. The walk starts from the root issue in the `issues` table and traverses `parentId` upward to confirm it reaches root. Hop 7 reads `.seeds/issues.jsonl` (populated by P1.3 Seeds decompose) for sibling dependency information; P1.3 is explicitly a transitive predecessor (see dependency edges above).
- **Empty .seeds/issues.jsonl guard (V5-M5):** Empty `.seeds/issues.jsonl` (0 bytes or only whitespace/newlines) is treated as "no seeds stories found". This is distinct from "file missing" (hop 7 returns `resolved: false, error: 'seeds file missing'`). Empty file returns `resolved: true, key: 'seeds', source: '.seeds/issues.jsonl'` with 0 stories listed.
- **agents.reportsTo column status (V5-M6):** `agents.reportsTo` is a future-planned column for org-chart traversal (AC-4 orphan detection). In Phase 1, the column does NOT exist. AC-4 orphan count should default to 0 (no orphans detectable without reportsTo). Add note: "AC-4 orphan detection is deferred until agents.reportsTo column is implemented (post-Phase-1). Gate passes with orphanCount: 0 as placeholder."
- **approvals and issue_execution_decisions table schemas (V5-M7):** approvals table: defined by P1.10 (approval records with decisionToken, issueId, decidedByUserId). issue_execution_decisions: defined by P1.10 W5b fix (decisionToken PK, issueId FK, runId, decision, decidedAt, source). Walker reads these tables in hop 6 for approval audit trail.
- **Budget field name unification (V5-M8):** Report field uses `budgetMonthlyCents` to match the Paperclip agents table column name. No `budgetCents` field in the report schema. All `budgetCents` references in the report object are updated to `budgetMonthlyCents`.
- **Multiple PRs for same run (V5-M9):** If multiple PRs reference the same runId (rare but possible in retry scenarios), hop 1 selects the most recent PR (`ORDER BY createdAt DESC LIMIT 1`) and logs a stderr warning: "multiple PRs for runId, selected most recent". This ambiguity is acceptable for audit purposes.
- **reportsTo cycle detection (V5-M11):** If `agents.reportsTo` forms a cycle (post-Phase-1), walker detects it via visited-set tracking. On cycle detection, all agents in the cycle are counted as orphans and a stderr warning is emitted. Phase-1 placeholder: `orphanCount = 0` (see M6 defer note).
- **NFR-ACC-1 orphan detection scope limitation (V5-M12):** NFR-ACC-1 orphan detection scope: single-issue only. The walker audits one issue's agent hierarchy, not the global agent table. Global orphan detection is out of scope for P1.16. Cross-issue orphans (agents not assigned to any issue) are not detected.
- **Hop 7 file read mechanism (V5-M13):** Hop 7 reads `.seeds/issues.jsonl` via direct filesystem read (Node.js `fs.readFile`). No CLI tool involved. The file is expected to be in the repo working directory. Path: `${process.cwd()}/.seeds/issues.jsonl`.
- **Hop numbering convention (V5-L1):** Hop numbering is 1-based (hops 1–10). Array indices in code are 0-based (hops[0] = hop 1). Report uses 1-based numbering.
- **Backward-compat expectation (V5-L2):** Walker MUST NOT crash on repos with Paperclip issues but no `.seeds/` directory and no `heartbeat_runs`. Walker produces a report with hops 1, 7 unresolved but hops 2–6, 8–10 resolving against existing Paperclip data. No crash.
- **CLI stdout format (V5-L3):** Default stdout: JSON (single object, parseable with `jq`). `--pretty` flag: human-readable table with columns [Hop|Status|Key|Source|Duration]. `--json` flag (default): machine-readable JSON. Both output the same data.
- **Per-hop timeout (V5-L4):** Per-hop timeout: 3 seconds. If a single hop exceeds 3s, it returns `resolved: false, error: 'hop timeout'` and the walker continues to the next hop. Total walk timeout remains ≤30s (NFR-OBS-4a).
- **Concurrent walk safety (V5-L5):** Walker is read-only (no writes to any table or file). Multiple concurrent walks on the same PR are safe — no locks needed. Each walk produces an independent report.
- **executionPolicy blob handling (V5-L6):** `executionPolicy` is read as a JSONB blob from the issues table for the approval hop (hop 6). The walker checks for its existence but does NOT parse or validate its structure — that's P1.10's responsibility. Walker only verifies the approval decision was recorded.

## Files to Modify

- `scripts/audit/audit-walk.ts`
- `scripts/audit/hop-resolvers.ts`
- `scripts/audit/per-issue-cost.ts`
- `scripts/audit/audit-report.ts`
- `test/audit/audit-walk.e2e.test.ts`
- `test/audit/missing-hop.test.ts`

## Security Invariants

- **INV-1 (tenant):** Every hop query is scoped to the PR's company id (`companyId`, the QDS company `1287bc8d-2122-4484-bc0c-900662caf8a0`) — the walk never joins across companies (no cross-tenant `cost_events`/`issues`/`heartbeat_runs` rows enter the report); a row whose `companyId` differs is excluded, not silently merged.
- **INV-2 (auth):** Paperclip reads use the per-agent bearer (`PAPERCLIP_API_KEY`) + run-scoped header (`PAPERCLIP_RUN_ID`, NFR-SEC-2); Hindsight reads send `Authorization: Bearer` from env/secret ref (NFR-SEC-5) — never hardcoded, and the token is never written into the audit report.
- **INV-3 (cost/budget):** Per-issue spend is derived SOLELY from `SUM(cost_events.costCents)` over the subtree (NFR-ACC-3). If a future `issues.costCents` column is added, the audit walk MUST NOT use it as a source — the walk reads `cost_events` exclusively. A fabricated or cached cost field (including any future denormalization) is forbidden as a source for the audit report. The report asserts rolled-up spend is at or under `agents.spentMonthlyCents`/`companies.spentMonthlyCents` vs `budgetMonthlyCents` (no silent over-cap, NFR-COST-1).
- **INV-4 (auth/non-anonymity):** Hop 4 walks `agents.reportsTo` to the root agent; an actor that does not resolve to root is reported as an orphan and counted (NFR-ACC-1) — no work is accepted as attributable to an anonymous/un-parented actor.

## Definition of Done

- [ ] **Impl:** `audit-walk <pr_url>` resolves all 10 §8.4 hops in order and emits `{ hops, missing, perIssueSpendCents, budgetMonthlyCents, withinBudget, exit_class }`.
- [ ] **Impl:** Per-issue-tree spend is computed as `SUM(cost_events.costCents)` over the `parentId` subtree and compared to the agent/company budget cap.
- [ ] **Impl:** Hop 4 walks `agents.reportsTo` to root and reports orphan-actor count (NFR-ACC-1).
- [ ] **Contract:** The hop-result + report types are defined; each hop names its join key and source store (§8.4), backward-compatible with existing rows.
- [ ] **Integration:** The walk consumes P1.15's run log (hop 1, `pr_url`↔`runId`↔`issueId`) and joins live Paperclip/`heartbeat_runs`/`cost_events`/`approvals`/Seeds/pi-lens/Hindsight records (hops 2–10).
- [ ] **Observability/Audit:** The full walk on the real PR resolves with `missing == []` and completes in ≤30s (NFR-OBS-4a); per-issue cost query returns in ≤2s (NFR-COST-2).
- [ ] **Security:** INV-1 (company-scoped, no cross-tenant rows), INV-3 (cost solely from `cost_events`, within budget), and INV-4 (orphan-actor walk to root) each enforced and tested.
- [ ] **Test (unit/integration):** Covers a deliberately broken hop (missing `cost_events` row → `missing` non-empty, non-zero exit) and the per-issue subtree cost SUM equalling the ledger total.
- [ ] **Test (perf):** Full 10-hop walk on the real PR completes in ≤30s (NFR-OBS-4a); per-issue cost SUM query returns in ≤2s (NFR-COST-2). Both enforced by timed assertions in the e2e test.
- [ ] **Test (e2e demo — MANDATORY):** Fires AC-1: runs `audit-walk <pr_url>` on the P1.15 real PR; asserts `missing.length === 0` (all 10 §8.1 hops walk) AND `withinBudget === true` — proving the chain is mechanically reconstructable with zero missing hops and spend within budget.
- [ ] **Test (unit — `--issue <id>` invocation):** `audit-walk --issue <id>` resolves all 10 hops starting from the issue id directly (skipping hop-1 pr_url→runId resolution — instead using `issues.executionRunId` as the entry point) and produces the same report structure as the pr_url path. Proves the alternative invocation path works. Verifies hop-1 is marked as `resolved-by-flag` (runId derived directly from the issue's `latestRunId`), hops 2-10 execute normally, and the report includes all 10 hop results.
- [ ] **Test (perf — per-hop cost SUM isolation, V5-M4):** Individual hop 7 (cost aggregation) completes in ≤2s on a 100-issue dataset. Measured independently of the full walk (NFR-COST-2).
- [ ] **Test (unit — epic resolution, V5-M10):** Given a chain of issues (grandchild → child → root where `parentId=null`), walker resolves the root as the epic. Verify `parentId === null` terminates the walk. Circular `parentId` chains (defense) return error, not infinite loop.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
