# QDS-Factory Operational Memory Substrate — Implementation Plan & Provenance

**Document ID**: QDS-MEM-003-IMPL
**Status**: Approved implementation plan (PhD reference); analysis-complete, story-authoring deferred to a later session
**Created**: 2026-06-19
**Authority**: Implementation record for the operational memory tier — provenance, teardown, divergence map, 13-story breakdown, invariants. Reconciles and sits beneath [QDS-MEM-003](operational-memory-design.md).
**Relationship**: Companion to [QDS-MEM-003](operational-memory-design.md) (the design). This doc records *how the substrate is sourced* (**vendored**, not greenfield) and *how the 13-story Phase-2 epic is decomposed and sequenced*. QDS-MEM-003 §11's design stories (P0-OM-1…P4-OM-15, 15 stories / 47 pts) are re-anchored into the 13-story P2.0–P2.12 Phase-2 epic (~44 pts) recorded in §D. **No P0/P1 runtime story changes**; the epic is purely additive and wires in by dependency only.

---

## 0. TL;DR

The operational memory substrate is **vendored** from [ArtemisAI/pi-mem](https://github.com/ArtemisAI/pi-mem) (a claude-mem v10.5.2-lineage retarget for pi-agents), by **copy-paste + adaptation** — **not** a git fork (no remote, no upstream). The pi-mem capture layer is **stripped**; only the swarmclaw/DAG/A-B-specific parts are **greenfield**. This corrects QDS-MEM-003's stale "greenfield, designed from scratch" framing (3×: exec summary L17, architecture diagram L72, decisions table L361) — the reconciliation edit is recorded in §F and applied to QDS-MEM-003 itself.

**Scope (user-confirmed): all 13 stories / ~44 pts — no trim.** The 44 pts is not bulk-vendoring. Per-story port-vs-new split (§D):

| Class | ~Pts | What | Stories |
|---|---|---|---|
| **Vendor** | ~10 | substrate lift/adapt (stores, migrations, queue, search framework, MCP, context injection) | P2.0, P2.1, P2.2 |
| **Glue** | ~9 | fresh-but-thin capture adapters on the **free** pi-mono ExtensionAPI seam | P2.3, P2.5, P2.6 |
| **Net-new** | ~25 | A/B lifecycle + nightly promotion (replaces stripped per-event LLM) + swarmclaw DAG capture + Hindsight bridge | P2.4, P2.7, P2.8, P2.9, P2.10, P2.11, P2.12 |

The epic is **additive**: not scheduled into the 4-week P0/P1 runtime window (already at 84-pt stretch). **P2.0 can start once P0.7 exists; the full epic gates on P0.7 + P1.6 + P1.15.**

---

## A. Provenance

### A.1 Substrate source

[ArtemisAI/pi-mem](https://github.com/ArtemisAI/pi-mem) — pi-mem is claude-mem v10.5.2 retargeted for pi-agents (669 files, TypeScript, Bun/Node dual runtime, `bun:sqlite`, pipeline: hooks → async queue → LLM worker daemon → SQLite + Chroma → MCP server + hybrid search + context injection).

### A.2 Sourcing mode: vendor, not fork

pi-mem's substrate is **copy-pasted** into QDS-Factory and **adapted in place**. There is **no git remote, no upstream tracking** — QDS-Factory does not subscribe to pi-mem's future evolution. This is an intentional one-way import: take the battle-tested substrate, then diverge. The fork-vs-vendor distinction matters: "fork" implies a tracked remote we pull from; we do none of that. License attribution is preserved in every vendored file (§A.4).

### A.3 Why vendor the substrate, strip the capture

- **Vendor the substrate** because rebuilding covers stores / migrations / queue / search / MCP — the genuinely hard parts pi-mem already solved. The greenfield-store alternative (thin extension + new store from scratch) was explicitly rejected (§A.5).
- **Strip the capture** because pi-mem's capture is an `SDKAgent` that runs a **per-event Claude call** to distill observations — wrong altitude for a dark factory (Delta 1, load-bearing). pi-mono's `ExtensionAPI` already provides signal acquisition for free (`tool_execution_*`, `turn_*`, `message_update`, `agent_end`), making pi-mem's capture both redundant and cost-wrong.

### A.4 License attribution

Each vendored file retains its original license header. A `THIRD_PARTY_NOTICES.md` entry (created when substrate lands in code) records: ArtemisAI/pi-mem lineage, claude-mem v10.5.2 ancestry, license type, and the import date.

### A.5 Build-vs-reuse trade-off (decision #6, user-confirmed)

| Option | Cost | Risk | Verdict |
|---|---|---|---|
| **Greenfield store** (thin extension + new store from scratch) | rebuild stores + migrations + queue + search + MCP (the hard parts) | high — re-deriving solved infrastructure | **rejected** |
| **Fork pi-mem** (tracked remote, pull upstream) | low | drift coupling; pi-mem's roadmap is not ours | rejected (coupling) |
| **Vendor pi-mem substrate** (copy-paste + adapt, strip capture) | lift/adapt substrate + write fresh adapters on free pi-mono seam | low — one-way import, diverge freely | **chosen** (user-confirmed) |

---

## B. KEEP / STRIP / DEFER Map

### B.1 KEEP (vendored substrate — lift + adapt)

| Subsystem | pi-mem location | Adaptation |
|---|---|---|
| SQLite stores + FTS5 | `src/services/sqlite/*` | adapt schema to run/DAG-node/event/experiment model (Delta 2) |
| Migrations runner (append-only `.sql`) | migrations dir + runner | adapt to new `schema_meta` |
| Async queue processor (backpressure) | `SessionQueueProcessor.ts` | repurpose: queue raw events (no LLM step) |
| Search Strategy pattern | interface + SQLite/Chroma/Hybrid backends | **key swap seam**: Chroma backend → sqlite-vec+ONNX; framework kept intact (Delta 3) |
| MCP server | `src/servers/mcp-server.ts` | expose recall API |
| Context injection formatters | `src/services/context/*` | format run/agent/skill context |
| pi-agent ExtensionAPI seam | `pi-agent/extensions/pi-mem.ts` | retarget → capture entry point |

### B.2 STRIP (removed — wrong altitude / wrong backend / wrong surface)

| Subsystem | Why stripped |
|---|---|
| `SDKAgent` LLM observation-generator | per-event Claude call — Delta 1 inversion; replaced by mechanical capture + nightly promotion |
| Chroma sync + `ChromaMcpManager` | external process → sqlite-vec+ONNX (Delta 3) |
| IDE adapters (`src/cli/adapters/*`) | capture surface is swarmclaw+pi-mono, not IDE (Delta 4) |
| Transcript watcher/processor (`src/services/transcripts/*`) | same — no IDE transcripts in a DAG factory |

### B.3 DEFER (not in Phase-2 epic; plugs in later behind a seam)

| Subsystem | Deferral | Seam |
|---|---|---|
| Worker HTTP/SSE daemon + viewer UI (`src/services/worker/http/*`, `src/ui/viewer/*`) | Phase-4 replay/debug tooling | replay API (P2.12) exposes the data; UI is a later layer |

---

## C. Seven Deltas — pi-mem → QDS-MEM-003 Architectural Divergence

| # | Delta | pi-mem | QDS-MEM-003 | Load-bearing? |
|---|---|---|---|---|
| **D1** | **Capture altitude inversion** | per-event LLM distillation | **zero** per-event LLM; mechanical raw-event capture; all LLM moves to nightly promotion cron | **YES — drives most fork surgery** |
| **D2** | Data model | session/observation/summary/prompt | run / DAG-node / event / experiment / event_edges; `run_id` spine; `parent_event_id` event tree | yes |
| **D3** | Vector backend | Chroma (external process) | sqlite-vec + local ONNX `Xenova/all-MiniLM-L6-v2` (384-dim); embedded, transactional with event rows, no external API per event | yes (→ SPIKE-11) |
| **D4** | Capture surface | IDE transcript-watching | swarmclaw DAG executor + pi-mono `ExtensionAPI` events | yes |
| **D5** | DAG-node capture | (no DAG concept in pi-mono) | transitions from swarmclaw orchestration hook surface (shape unknown) | yes (→ SPIKE-10) |
| **D6** | Experiment lifecycle | *(nothing analogous)* | full A/B state machine: propose → human gate → execute → deploy → 30-day confirm/auto-rollback | **net-new** |
| **D7** | Hindsight promotion | *(nothing analogous)* | nightly cron distills day's events → "Daily Learnings" doc → `retain()` into qds-product/qds-meta; replaces live LLM classification in the current SwarmClaw→Hindsight bridge | **net-new — resolves SPIKE-9** |

**D1 is the single most consequential change.** Eliminating per-event LLM and moving all intelligence to a nightly batch fundamentally changes the system's cost profile and data shape. **D7 resolves SPIKE-9**: the SwarmClaw→Hindsight bridge model is **batch (cron)**, not a live LLM handoff.

---

## D. 13-Story Phase-2 Breakdown (P2.0–P2.12, ~44 pts)

Re-anchors QDS-MEM-003 §11's 15 design stories (P0-OM-1…P4-OM-15) into a Phase-2 epic with distinct slugs. Point values are planning estimates. Class = vendor / glue / net-new (§0).

### D.1 Phase 2a — Foundation & Intake (5 stories / 17 pts)

| Story | Title | Pts | Class | Notes |
|---|---|---|---|---|
| **P2.0** | Toolchain bootstrap | 3 | vendor | substrate copy-paste; Bun/Node dual-runtime wiring; deps (sqlite-vec, ONNX runtime); license attribution (§A.4) |
| **P2.1** | Event store (SQLite + sqlite-vec) | 4 | vendor | lift SQLite+FTS5 stores; adapt schema to run/DAG-node/event model (D2); `event_vec` virtual table (D3) |
| **P2.2** | Schema migration runner | 3 | vendor | lift append-only `.sql` runner; adapt `schema_meta` |
| **P2.3** | Tool-call capture (pi-mono ExtensionAPI) | 3 | glue | zero-LLM threading; ONNX embed; one tool call → one `events` + one `event_vec` row, transactional. **DoD: zero LLM/HTTP egress (network mock asserts); p99 < 5 ms over 1000 calls; ONNX deterministic 384-dim** |
| **P2.4** | DAG-node capture (swarmclaw seam) | 4 | net-new | **gated on SPIKE-10** (swarmclaw DAG hook surface); node transitions + handoffs → `node` events; event tree via `parent_event_id` (D5) |

### D.2 Phase 2b — Recall & Promote (4 stories / 13 pts)

| Story | Title | Pts | Class | Notes |
|---|---|---|---|---|
| **P2.5** | Reasoning + agent-context capture | 3 | glue | pi-mono message events → `message` events; vector-indexed |
| **P2.6** | Outcome capture | 3 | glue | test/review/build adapters → `outcome` events; linked to run |
| **P2.7** | Nightly promotion cron | 4 | net-new | **replaces stripped per-event LLM (D1)**; light consolidation of day's events → "Daily Learnings" doc |
| **P2.8** | Hindsight retain bridge | 3 | net-new | push daily doc → `qds-product`/`qds-meta` `retain` w/ correct tags. **Cross-epic dep: P1.11** (Hindsight retain, KEEP). Resolves SPIKE-9 (D7) |

### D.3 Phase 2c — Experiment (3 stories / 11 pts)

| Story | Title | Pts | Class | Notes |
|---|---|---|---|---|
| **P2.9** | Experiment propose + human gate | 3 | net-new | optimizer agent scans runs, proposes hypothesis → `experiments` (proposed); CLI/UI approve/reject + audit event → approved |
| **P2.10** | A/B execution + deploy | 5 | net-new | **E2E gated on swarmclaw variant-tagged DAGs (SPIKE-10)**; ships interface + unit tests first; full E2E when seam confirmed; measures metric, declares winner → analyzed; deploy winner + snapshot baseline + `confirm_until=+30d` → deployed |
| **P2.11** | Confirm cron (30-day auto-rollback) | 3 | net-new | post-deploy vs baseline; confirm/rollback + Hindsight qds-meta finding → confirmed/rolled_back |

### D.4 Phase 2d — Housekeeping (1 story / 3 pts)

| Story | Title | Pts | Class | Notes |
|---|---|---|---|---|
| **P2.12** | Replay + retention policy | 3 | net-new | reconstruct any run's event timeline/tree (serves optimizer + humans); operational-store cleanup/decay policy |

**Totals: 13 stories · ~44 pts · vendor ~10 · glue ~9 · net-new ~25.**

### D.5 Sequencing DAG

```
P0.7 (SwarmClaw agent+MCP registry) ── epic entry gate ──▶ P2.0
                                                            │
P2.0 ──▶ P2.1 ──┬──▶ P2.3 (glue)
P2.0 ──▶ P2.2 ──┤──▶ P2.5 (glue)     ◀── fan out once P2.1 exists
               └──▶ P2.6 (glue)
SPIKE-10 ──▶ P2.4 (net-new, DAG capture)          ◀── D5 depends
SPIKE-11 ──▶ P2.1's sqlite-vec/ONNX              ◀── D3 depends

P2.3/P2.5/P2.6 (capture live) ──▶ P2.7 (nightly cron) ──▶ P2.8 (Hindsight bridge)
P1.11 (KEEP, Hindsight retain) ──▶ P2.8          ◀── cross-epic dependency

P2.8 ──▶ P2.9 ──▶ P2.10 (gated SPIKE-10) ──▶ P2.11
P2.1 ──▶ P2.12 (replay/retention)

Full epic gates on: P0.7 + P1.6 (Warren dispatch) + P1.15 (real PR → real runs to capture/promote/experiment on)
```

**Parallelism:** P2.3/P2.5/P2.6 (capture adapters) fan out once P2.1 exists; P2.7/P2.8 run once capture + P1.11 are live.

---

## E. Invariants & Verification

### E.1 Operational-memory invariants (carry into every Phase-2 story's DoD)

| ID | Invariant |
|---|---|
| **INV-OM1** | **Zero per-event LLM/HTTP** — capture is mechanical; no network egress during capture (network mock asserts). The only LLM work is nightly promotion (P2.7) + per-experiment optimization (P2.9–P2.11). |
| **INV-OM2** | **`run_id` non-null** on every `events` row — the spine; capture adapters omitting it are defective by definition. |
| **INV-OM3** | **`payload_json`/`result_json` ≤ 64 KB, secret-pattern-masked** — bounded rows; secrets scrubbed before write. |
| **INV-OM4** | **ONNX model from a pinned local path only — no remote fetch** — deterministic local inference, no external API per event (D3). |

### E.2 Verification (docs-only, this session)

- `grep -rn "greenfield" docs/planning/operational-memory-design.md` → only the RuFlo-contrast sense remains; no "designed from scratch" substrate claim.
- `grep -n "ArtemisAI/pi-mem" docs/planning/operational-memory-design.md` → present in §14; same in this doc §A.
- QDS-EXEC-001 §7: SPIKE-9 shows RESOLVED; SPIKE-10 + SPIKE-11 appended after it.
- QDS-MEM-001 §6.2: references nightly cron = the resolved bridge.
- All three docs (QDS-MEM-001/003, QDS-EXEC-001) cross-link QDS-MEM-003-IMPL.
- `_bmad-output/sprint-artifacts/phase-2/README.md` lists p2-0…p2-12 + SPIKE-10/11.

---

## F. Reconciliation — what changes in QDS-MEM-003 (applied this session)

QDS-MEM-003 was written before the vendor decision was confirmed. Three framing fixes (the consistency sweep's catch):

1. **Exec summary (L17)** — "greenfield store … designed from scratch" → substrate vendored from ArtemisAI/pi-mem (copy-paste + adapted); capture layer stripped; greenfield only vs RuFlo and vs the swarmclaw/DAG/A-B layers.
2. **Architecture diagram (L72)** — `(SQLite + sqlite-vec, greenfield)` → `(SQLite + sqlite-vec, vendored)`.
3. **Decisions table (L361)** — "Greenfield, ignore RuFlo" row amended to clarify scope (greenfield *vs RuFlo*; vendored *vs pi-mem*); new row added for the pi-mem relationship (vendor substrate, strip capture — user-confirmed).
4. **§14 References (L453)** — pi-mem re-framed from "inspiration" to vendored substrate; ArtemisAI/pi-mem link + this doc added.
5. **§11 top (L373)** — pointer to this doc §D for the port-vs-new story map.

Plus two disambiguation notes folded into the edits:
- **Banks 2-vs-4** (QDS-EXEC-001 §4.1): "two banks" = 4-week spike scope; the two factory-tier banks are deferred (§3.2); full 4-bank design in QDS-MEM-002. Scope difference, not contradiction.
- **Cron-term** (QDS-MEM-003 §7.1 + QDS-MEM-001 §6.2): the **nightly promotion cron** (operational tier, high-volume daily distill) ≠ the **Hindsight strategic cron agents** (Synthesizer/Meta-Optimizer/Blind-Spot, weekly/biweekly/monthly). Different tiers, different cadences.

---

## G. Cross-references

- [QDS-MEM-003](operational-memory-design.md) — the design (this doc's parent).
- [QDS-MEM-001](hindsight-memory-master-design.md) §6.2 — the SwarmClaw→Hindsight bridge; nightly promotion cron (D7) is its resolved execution model.
- [QDS-EXEC-001](qds-factory-4-week-execution-and-spike-plan.md) §7 — SPIKE-9 (resolved, D7), SPIKE-10 (D5), SPIKE-11 (D3).
- [ArtemisAI/pi-mem](https://github.com/ArtemisAI/pi-mem) — vendored substrate source (claude-mem v10.5.2 lineage).

---

*End of document. Canonical implementation record for the QDS-Factory operational memory substrate. Story files (p2-0…p2-12) are authored in a later session; until then this doc + the phase-2 README stub are the backlog of record.*
