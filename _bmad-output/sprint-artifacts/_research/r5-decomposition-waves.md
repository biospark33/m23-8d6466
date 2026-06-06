# R5 — Decomposition, Dependency & Wave Plan (QDS-Factory v4, Phase 0 + Phase 1)

> Source: `planning-artifacts/prd-qds-factory-v4.md` §10 (Phase 0 lines ~626-637; Phase 1 ~638-657), §13 gates (~830-851), §6.8 traceability (~402-403), §12.2 OQ-1..6 (~763-805), Appendix D spike outcomes.
> Rule: every story = 3-4 pts, end-to-end vertical slice (no dangling stub), binary demonstrable exit-criterion, mapped to FR/NFR + §13 gate assertion(s). Waves are topological — a wave never contains a forward dependency; writers run ≤2 stories/agent per wave.

---

## 0. Decomposition logic (why each PRD item split or held)

**Phase 0** — 7 PRD items; 5 are explicit *acquire-then-prove* pairs. Split rule applied: split only when BOTH halves are independently a 3-4pt e2e slice; if the acquire is trivial, keep as one story.

- **Item 1 (env patch)** — spike already applied + proven on `qds/env-patch-spike` (Appendix D, OQ-6 resolved). Reduces to ONE smaller "productionize + non-regression gate" story (P0.1). No acquire/prove split — the acquire is done.
- **Item 2 (vendor coms.ts + decide arch)** — vendor is trivial (already vendored to `pi-vs-claude-code-vendor/`, loads on 0.55.0 — OQ-1/5 resolved). The *prove* half (smoke-test the coms contract + record the OQ-1/OQ-5 decision) is the real e2e slice. Kept as ONE story (P0.2) — the acquire collapsed into the spike; the productionizing of the vendored module + decision-record is the slice.
- **Item 3 (launcher + guarded mixed-model demo)** — two distinct e2e capabilities: (a) the launcher script that emits merged JSON (P0.3), and (b) the hard-guard kill of a loopy prompt + per-archetype `coms_await` timeout calibration OQ-16b (P0.4). Each is a 3-4pt demonstrable slice. SPLIT.
- **Item 4 (pi-lens + LSP + headless spike)** — three independently-provable capabilities: (a) install pi-lens + prove headless machine-readable TDI/warnings or wire the proxy fallback (P0.5), and (b) provision the language server(s) + prove active `lsp_diagnostics` seeded-error + `lsp_navigation` def-resolve (P0.6). pi-lens-install and LSP-provision are independent acquisitions each with its own §13 assertion (4 vs 4b). SPLIT into 2.
- **Item 5 (Paperclip + plugins)** — two e2e slices: (a) bring up Paperclip (Postgres + dashboard + root agent) with both plugins listed installed (P0.7), and (b) verify Telegram plugin behaviors against a live chat / record OQ-3 + Hermes-gateway fallback (P0.8). The verify half is BLOCKED-on-creds → its slice ships the decision-record + fallback wiring. SPLIT into 2.
- **Item 6 (pin tooling + Hindsight host + banks + graph)** — bundles THREE unrelated acquisitions. SPLIT into 3: (a) pin Seeds/Mulch + decide Hindsight host + prove retain→recall→reflect round-trip + create `{repo}`/`{repo}-dev-meta` banks + import Mulch expertise (P0.9 — the memory substrate slice), and (b) install pi-gitnexus-plus + run initial `gitnexus analyze` to non-error + prove `gitnexus_context`/`gitnexus_impact` return real graph data (P0.10 — the graph-layer slice; §13 7b, the hard pre-Phase-1 sequencing gate). Pin-Seeds/Mulch is trivial and folds into P0.9.
- **Item 7 (Phase-0 exit gate)** — the aggregated §13 Phase-0 assertion check. Kept as the gate story (P0.11), depends on all P0 slices.

**Phase 1** — 16 PRD items; item 15 separable from the make-or-break gate.

- **Item 5 (Pi-team implement node)** bundles the launch+capture AND the post-edit `lsp_diagnostics` gate (FR-EX-11 + FR-EX-12 fallback). SPLIT: P1.6 (implement node launches Mulch-primed pi-lens-gated team, captures single structured JSON) and P1.7 (post-edit `lsp_diagnostics` gate blocks emit on changed-file errors; ast-grep+tests fallback waiver-logged). Each is a 3-4pt e2e slice; P1.7 depends on P1.6 (the gate wraps the node).
- **Item 13 (audit-chain reconstructable)** is a single coherent walk — kept as ONE story (P1.16) but depends on the ledger (P1.13) + memory retain (P1.11) being live.
- **Item 14 (E2E make-or-break gate)** = the §13 Phase-1 aggregated assertion (real PR produced). Kept as the gate story (P1.17).
- **Item 15 (PR review-comment fix loop)** is in-scope but separable. SPLIT into 2: P1.18 (comment-polling Paperclip routine detects ≥1 bot review comment on the PR) and P1.19 (Dev manager re-dispatches a Pi Pair to address the comment, pushes fix, PR moves green). Each is a 3-4pt slice; P1.19 depends on P1.18.
- All other Phase-1 items are already atomic 3-4pt e2e slices → 1 story each.

---

## 1. FULL STORY TABLE

| id | title | phase | pts | deps | wave | FR refs | security-triggers | one-line e2e-slice |
|----|-------|-------|-----|------|------|---------|-------------------|--------------------|
| P0.1 | Productionize Archon 3-site env patch + non-regression gate | 0 | 3 | [] | 1 | FR-OR-3, FR-OR-4 | migration/schema, secrets/env | Promote the spike-proven `env:{...process.env,...node.env}` merge to a maintained branch (pin base SHA `536584db`) so a bash node with `env:{FOO:bar}` echoes `bar` AND a node with no env still echoes inherited parent-env — wiring closed: per-node env reaches the subprocess with zero env-wipe regression. |
| P0.2 | Productionize vendored `coms.ts` + record OQ-1/OQ-5 in-node-arch decision | 0 | 3 | [] | 1 | FR-EX-1, FR-EX-2 | — | Smoke-test the vendored coms contract (`registerFlag`/`getFlag`/`coms_send`/`coms_await`/`triggerTurn`) on pinned pi 0.55.0 and record the socket-coms-vs-subprocess-RPC + pin-0.55.0 decision in the audit log — wiring closed: the in-node coms layer is chosen, loads, and is decision-locked. |
| P0.3 | `pi-team-launch.sh` 3-agent mixed-model merged-JSON demo | 0 | 4 | [P0.1, P0.2] | 2 | FR-EX-3, FR-EX-6 | secrets/env, cost/budget | Write the launcher and run a 3-agent Anthropic+OpenRouter team so logs show ≥2 named agents exchanging ≥2 coms messages and a single merged JSON lands on stdout — wiring closed: the launcher produces one structured node-output from a live mixed-model team. |
| P0.4 | Hard-guard loopy-prompt kill + `coms_await` timeout calibration (OQ-16b) | 0 | 3 | [P0.3] | 3 | FR-EX-3 | cost/budget | Feed a deliberately loopy prompt and prove a budget/turn/tilldone/`coms_await`-timeout hard cap kills it non-zero before credits exhaust, recording measured p99 per-archetype await timeouts — wiring closed: no run can burn budget unbounded. |
| P0.5 | Install pi-lens + prove headless machine-readable TDI/warnings (or wire proxy fallback) | 0 | 4 | [] | 1 | FR-EX-5, FR-EX-8 | input/file | `pi install npm:pi-lens`, run `--mode json`/`--mode rpc` on a noop, and prove a headless turn-end report emits TDI + stable finding IDs OR wire the warning-count proxy + set the §9.3 fallback flag (TDI via on-disk `~/.pi-lens/` artifacts) — wiring closed: the QA gate has a machine-readable signal source recorded. |
| P0.6 | Provision target-repo LSP + prove active `lsp_diagnostics`/`lsp_navigation` | 0 | 3 | [P0.5] | 2 | FR-EX-4, FR-EX-10 | input/file | Install `typescript-language-server`(+`typescript`)+`pyright` on PATH and prove `lsp_diagnostics` surfaces a seeded type error and `lsp_navigation` resolves a definition in the target repo — wiring closed: a warm per-worktree LSP answers semantics, not text inference. |
| P0.7 | Stand up Paperclip (Postgres+dashboard+root agent) with Telegram+Hindsight plugins listed installed | 0 | 4 | [] | 1 | FR-CP-9, FR-CP-10, FR-CP-11 | auth, secrets/env, migration/schema | Bring up Paperclip and `POST /api/plugins/install` both plugins so the dashboard is reachable and lists Telegram + Hindsight as installed — wiring closed: the control plane is live with the plugin substrate mounted. |
| P0.8 | Verify Telegram plugin behaviors / record OQ-3 + Hermes-gateway fallback | 0 | 3 | [P0.7] | 2 | FR-CP-9, FR-CM-1 | auth, secrets/env | Against a live chat (or, blocked-on-creds, on disk) confirm-or-mark-absent bidirectional `/approve`/`/status` + inline-button approval + per-type routing and record OQ-3 with the Hermes-gateway fallback in effect — wiring closed: every Telegram behavior is decision-logged, never assumed. |
| P0.9 | Pin Seeds/Mulch + decide Hindsight host + prove retain→recall→reflect + create banks + import Mulch | 0 | 4 | [P0.7] | 2 | FR-MEM-1, FR-MEM-4 | secrets/env, tenant | Pin Seeds 0.2.5/Mulch 0.6.3, record the Hindsight self-host-vs-cloud decision (OQ-4), round-trip retain→recall→reflect on a `{repo}` bank, create `{repo}` + `{repo}-dev-meta` banks and import Mulch expertise — wiring closed: the memory substrate round-trips on the chosen host with banks provisioned. |
| P0.10 | Install pi-gitnexus-plus + initial `gitnexus analyze` to non-error + prove graph queries | 0 | 3 | [] | 1 | FR-EX-9 | input/file | `pi install npm:pi-gitnexus-plus`, run the initial `gitnexus analyze` to a non-error state on the target repo, and prove `gitnexus_context`/`gitnexus_impact` return real graph data on a sample symbol — wiring closed: the cold-start graph exists before any Phase-1 story executes (§13 7b hard gate). |
| P0.11 | Phase-0 exit gate (§13 aggregated assertion check) | 0 | 3 | [P0.1,P0.2,P0.3,P0.4,P0.5,P0.6,P0.7,P0.8,P0.9,P0.10] | 4 | FR-OR-4,FR-EX-1..10,FR-MEM-1,FR-CP-9..11 | — | Check every §13 Phase-0 assertion (1,2,3,4,4b,5,6,7,7b,8) green and confirm all six OQ-1..6 have a recorded decision — wiring closed: Phase 0 exits with a fully-checked binary gate, unblocking Phase 1. |
| P1.1 | Dev manager registered as 24/7 `hermes_local` agent | 1 | 3 | [P0.7,P0.11] | 5 | FR-MG-1, FR-CP-11 | auth, secrets/env | Register the Dev manager as a 24/7 `hermes_local` agent `reportsTo` root with a budget so it appears in the org chart and authenticates REST calls with host-injected `PAPERCLIP_API_KEY`+`PAPERCLIP_RUN_ID` — wiring closed: a non-anonymous, budgeted, authenticating manager actor exists. |
| P1.2 | `/qds` intake → one parent Paperclip issue | 1 | 3 | [P1.1] | 6 | FR-MG-2, FR-CM-1 | auth, input/file | A `/qds <request>` creates exactly one parent Paperclip issue assigned to the Dev manager — wiring closed: external intake deterministically yields one owned issue. |
| P1.3 | Seeds-decompose → Paperclip mirror (authority split) | 1 | 4 | [P1.2,P0.9] | 7 | FR-MG-3, FR-CP-3 | tenant, migration/schema | Persist Seeds stories + dependency edges to `.seeds/issues.jsonl` and mirror them as child Paperclip issues under the parent, with deps only in Seeds and assignment+cost only in Paperclip — wiring closed: one-directional decomposition with no duplicated authority. |
| P1.4 | Author `qds-piv-loop` 14-node DAG | 1 | 4 | [P0.1,P0.11] | 5 | FR-OR-1, FR-OR-2 | — | Author the 14-node QDS variant so it registers and is runnable via `POST /api/workflows/qds-piv-loop/run` — wiring closed: the orchestration graph is registered and invokable. |
| P1.5 | `qds-model-router` archetype + per-role tier selection scored to `*-meta` | 1 | 4 | [P0.9,P0.10] | 6 | FR-MG-5, FR-EX-7 | cost/budget | The router selects archetype (§7 A–F) + per-role tier (OpenRouter GLM/Kimi constrained, Opus judgment) under the blast-radius floor + risk-tier constraint and scores its choices into `{repo}-dev-meta` — wiring closed: every node gets a logged, constraint-bound config decision. |
| P1.6 | Pi-team implement node launches Mulch-primed pi-lens-gated team + captures structured JSON | 1 | 4 | [P0.3,P0.5,P0.9,P1.4] | 6 | FR-OR-3, FR-EX-6 | secrets/env, input/file, cost/budget | The implement bash node launches the Mulch-primed, pi-lens-gated Pi team and captures one structured JSON result as node output — wiring closed: a DAG node yields a single demonstrable team result. |
| P1.7 | Post-edit `lsp_diagnostics` gate blocks emit on changed-file errors (FR-EX-12 fallback) | 1 | 3 | [P0.6,P1.6] | 7 | FR-EX-11, FR-EX-12 | input/file | The implement node refuses to emit while `lsp_diagnostics` shows errors on the changed-file union (ast-grep+tests fallback if headless LSP unavailable, waivers logged) — wiring closed: no node emits over a known type error. |
| P1.8 | Drive + SSE + capture correlated to issue id | 1 | 3 | [P1.1,P1.4] | 6 | FR-MG-4, FR-OR-5 | auth | The Dev manager starts the run and consumes the dashboard SSE stream, capturing progress + final output correlated to the issue id — wiring closed: live run telemetry is bound to its issue. |
| P1.9 | Restart policy (deterministic classify + retry/wall-clock caps) | 1 | 3 | [P1.8] | 7 | FR-MG-8, FR-MG-9 | cost/budget | An induced transient/overflow/logic failure is classified deterministically and bounded by ≤8 retries / ≤1h → logged human gate — wiring closed: no failure loops unbounded; every restart is classified and capped. |
| P1.10 | `executionPolicy` approve/resume via Telegram (inline approve/reject) | 1 | 4 | [P0.8,P1.8] | 8 | FR-OR-6, FR-CM-2 | auth, secrets/env | A gated issue pauses the Archon run, pings Telegram with inline approve/reject, and the reply resumes the paused run (reject halts cleanly) — wiring closed: a human gate decision drives the run, logged in `approvals`. |
| P1.11 | `qds-hindsight-prime` recall + post-run retain wiring | 1 | 4 | [P0.9,P1.6] | 7 | FR-MG-6, FR-MG-7, FR-MEM-2 | tenant | A run recalls relevant prior bank entries into the node system prompt before execution and retains its learnings (idempotent `document_id=runId`) after — wiring closed: the L2 per-story memory loop round-trips on a real run. |
| P1.12 | Mulch prime/record wiring | 1 | 3 | [P0.9,P1.6] | 7 | FR-MEM-5 | tenant | House-style context is primed from Mulch pre-execution and reusable expertise is recorded post-run — wiring closed: the house-style loop primes and persists across runs. |
| P1.13 | Cost ledger within budget (per-issue-tree spend + over-cap gate) | 1 | 4 | [P1.6,P1.8] | 7 | FR-CP-4, FR-CP-12 | cost/budget, tenant | Every run writes a `cost_events` row (`issueId`/`agentId`/`model`/tokens); per-issue-tree spend is queryable and an over-cap (rolled-up ≥ `budgetMonthlyCents`) gates/halts — wiring closed: spend is native, summable, and capped, never silently overrun. |
| P1.14 | Outcome record (FR-LEARN-28) + deterministic router selection (FR-LEARN-29) wiring | 1 | 3 | [P1.5,P1.13] | 8 | FR-ACT-2 | cost/budget | Record the per-run outcome record keyed on `runId` (idempotent upsert) from native sites (`cost_events`/`activity_log`/`heartbeat_runs`) and log the router's legal-arm selection rationale — wiring closed: the Layer-B substrate is captured per run with no extra LLM call. |
| P1.15 | Telegram `/qds` → real PR produced on sample repo | 1 | 4 | [P1.3,P1.6,P1.7,P1.8] | 8 | FR-OR-1, FR-OR-7, FR-EX-6 | input/file, auth | The full `qds-piv-loop` runs end-to-end from `/qds` through the implement node and opens a real PR on a sample repo — wiring closed: the vertical slice produces a demonstrable artifact (the make-or-break PR). |
| P1.16 | Audit-chain reconstructable for one real PR (no missing hop) | 1 | 4 | [P1.13,P1.11,P1.15] | 9 | FR-ACT-1 | tenant, auth, cost/budget | For one real PR, walk the full §8.1/§8.4 chain (epic→Seeds→issue→cost_events→approvals/decisions→heartbeat_runs→Archon run→Pi team→pi-lens→Hindsight) with no missing hop, showing per-issue spend within budget — wiring closed: every PR is mechanically traceable to its epic. |
| P1.17 | Phase-1 E2E make-or-break gate (§13 aggregated assertion) | 1 | 3 | [P1.10,P1.14,P1.16] | 10 | FR-MG-1..9,FR-OR-1..7,FR-EX-6/7/11,FR-CP-1..12,FR-MEM-2/5,FR-ACT-1/2 | auth, cost/budget, tenant | Run the §13 Phase-1 assertion list (1–8) end-to-end on a sample repo confirming one real PR + reconstructable chain + within-budget spend + working Telegram approve/resume + retained findings — wiring closed: the make-or-break gate passes binary. |
| P1.18 | PR comment-polling Paperclip routine detects ≥1 bot review comment | 1 | 3 | [P1.15] | 9 | FR-CM-5, FR-MG-4 | auth, secrets/env | A Paperclip routine polling the PR opened by the slice detects ≥1 CodeRabbit/Gemini review comment and wakes the Dev manager — wiring closed: bot review comments are detected and re-enter the loop. |
| P1.19 | Pi Pair addresses review comment → push fix → PR green | 1 | 4 | [P1.18] | 10 | FR-CM-5, FR-MG-4, FR-OR-6 | input/file, auth | The Dev manager dispatches a Pi Pair to read and address the detected comment, the fix is pushed, and the PR moves to green — wiring closed: the lights-out comment→fix→green loop closes on a real PR. |

---

## 2. WAVE GROUPINGS (topological — no forward dep within a wave; writers run ≤2/agent)

- **Wave 1 (Phase 0, no deps):** P0.1, P0.2, P0.5, P0.7, P0.10
- **Wave 2 (Phase 0):** P0.3, P0.6, P0.8, P0.9
- **Wave 3 (Phase 0):** P0.4
- **Wave 4 (Phase 0 gate):** P0.11
- **Wave 5 (Phase 1, depends on P0 gate):** P1.1, P1.4
- **Wave 6 (Phase 1):** P1.2, P1.5, P1.6, P1.8
- **Wave 7 (Phase 1):** P1.3, P1.7, P1.9, P1.11, P1.12, P1.13
- **Wave 8 (Phase 1):** P1.10, P1.14, P1.15
- **Wave 9 (Phase 1):** P1.16, P1.18
- **Wave 10 (Phase 1 gates + loop close):** P1.17, P1.19

> Writing-wave note: Wave 7 has 6 stories (assign across ≥3 writer agents, ≤2 each). All other waves ≤5. No story in a wave depends on another story in the same wave.

---

## 3. DEPENDENCY GRAPH (edges = depends-on)

```
PHASE 0
  P0.1 ─┐
  P0.2 ─┼─► P0.3 ─► P0.4 ─┐
  P0.5 ─► P0.6 ───────────┤
  P0.7 ─┬─► P0.8 ─────────┤
        └─► P0.9 ─────────┤
  P0.10 ──────────────────┤
  (P0.1,P0.2,P0.5,P0.7 also feed) ──► P0.11 (gate)

PHASE 1  (all gated behind P0.11; P1.1 also needs P0.7; P1.4 also needs P0.1)
  P0.11 ─► P1.1 ─► P1.2 ─► P1.3(+P0.9)
  P0.11 ─► P1.4 ─┬─► P1.6(+P0.3,P0.5,P0.9) ─► P1.7(+P0.6)
                 └─► P1.8(+P1.1) ─► P1.9
  P0.9,P0.10 ─► P1.5
  P1.6 ─┬─► P1.11(+P0.9) ─┐
        ├─► P1.12(+P0.9)  │
        └─► P1.13(+P1.8) ─┤
  P0.8,P1.8 ─► P1.10
  P1.5,P1.13 ─► P1.14
  P1.3,P1.6,P1.7,P1.8 ─► P1.15 ─┬─► P1.16(+P1.13,P1.11) ─┐
                                └─► P1.18 ─► P1.19        │
  P1.10,P1.14,P1.16 ─► P1.17 (make-or-break gate)
```

**Critical path:** P0.5 → P0.6 → (P0.11) → P1.4 → P1.6 → P1.7 → P1.15 → P1.16 → P1.17.
Parallel-equivalent P0 chain: P0.1/P0.2 → P0.3 → P0.4 → P0.11 (longest Phase-0 chain feeding the gate).

---

## 4. TOTALS

- **Phase 0:** 11 stories — 3+3+4+3+4+3+4+3+4+3+3 = **37 pts**
- **Phase 1:** 19 stories — 3+3+4+4+4+4+3+3+3+4+4+3+4+3+4+4+3+3+4 = **67 pts**
- **GRAND TOTAL: 30 stories, 104 pts** (Phase 0: 11 stories / 37 pts; Phase 1: 19 stories / 67 pts).

(Targets met: Phase 0 in the 8–11 band; Phase 1 in the 16–22 band; every story 3–4 pts.)

## 5. OQ resolution map (Phase-0 stories resolve open questions)

- P0.2 → OQ-1 (in-node arch: subprocess-RPC day-1, socket-coms viable) + OQ-5 (pin pi 0.55.0).
- P0.4 → OQ-16b (`coms_await` per-archetype timeout calibration).
- P0.5 + P0.6 → OQ-2 (headless pi-lens TDI/warnings + LSP diagnostics; TDI via `~/.pi-lens/` artifacts).
- P0.8 → OQ-3 (Telegram parity; BLOCKED-on-creds → Hermes-gateway fallback).
- P0.9 → OQ-4 (Hindsight self-host default; local stack BLOCKED-on-env, fallback recorded).
- P0.1 → OQ-6 (Archon maintained private branch + pin base SHA `536584db`).
- P1.13 → OQ-8 (confirm Pi-subprocess spend writes its own per-agent `cost_events` rows; else launcher emits) — flagged "confirm early" on the cost-ledger demo.
- P0.11 → asserts all OQ-1..6 recorded (§13 Phase-0 assertion 8).
