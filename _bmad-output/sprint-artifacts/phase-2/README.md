# Phase-2 Sprint Artifacts — Operational Memory Epic (QDS-MEM-003)

> **Status: backlog stub.** This directory tracks the Phase-2 operational-memory epic. Story files
> (`stories/p2-*.md`) are **not authored yet** — they are written in a later story-authoring session.
> Until then, this README + [QDS-MEM-003-IMPL](../../../docs/planning/operational-memory-implementation-plan.md)
> §D are the backlog of record. This deliberately separates the analysis/planning phase from the
> story-writing phase.

## Epic

**QDS-MEM-003 — Operational Memory Substrate.** Vendored from ArtemisAI/pi-mem (copy-paste + adapted,
capture layer stripped). Sits beneath Hindsight (QDS-MEM-001/002). Purely additive — wires into the
P0/P1 runtime spine by dependency only; **not scheduled into the 4-week window** (already at 84-pt stretch).

- **Design:** [docs/planning/operational-memory-design.md](../../../docs/planning/operational-memory-design.md) (QDS-MEM-003)
- **Implementation plan + provenance + story breakdown:** [docs/planning/operational-memory-implementation-plan.md](../../../docs/planning/operational-memory-implementation-plan.md) (QDS-MEM-003-IMPL) — §D is the story map.

## Story backlog (13 stories · ~44 pts)

| Slug | Title | Pts | Class | Sub-phase |
|---|---|---|---|---|
| `p2-0` | Toolchain bootstrap | 3 | vendor | 2a Foundation/Intake |
| `p2-1` | Event store (SQLite + sqlite-vec) | 4 | vendor | 2a |
| `p2-2` | Schema migration runner | 3 | vendor | 2a |
| `p2-3` | Tool-call capture (pi-mono ExtensionAPI) | 3 | glue | 2a |
| `p2-4` | DAG-node capture (swarmclaw seam) | 4 | net-new | 2a |
| `p2-5` | Reasoning + agent-context capture | 3 | glue | 2b Recall/Promote |
| `p2-6` | Outcome capture | 3 | glue | 2b |
| `p2-7` | Nightly promotion cron | 4 | net-new | 2b |
| `p2-8` | Hindsight retain bridge | 3 | net-new | 2b |
| `p2-9` | Experiment propose + human gate | 3 | net-new | 2c Experiment |
| `p2-10` | A/B execution + deploy | 5 | net-new | 2c |
| `p2-11` | Confirm cron (30-day auto-rollback) | 3 | net-new | 2c |
| `p2-12` | Replay + retention policy | 3 | net-new | 2d Housekeeping |

**Totals: 13 stories · ~44 pts · vendor ~10 · glue ~9 · net-new ~25.** See QDS-MEM-003-IMPL §D for the
sequencing DAG, per-story port-vs-new justification, and cross-epic dependencies.

## Spikes (defined in QDS-EXEC-001 §7)

| Spike | Protects | Delta |
|---|---|---|
| **SPIKE-10** | P2.4 (DAG-node capture), P2.10 (variant-tagged DAGs) | D5 — swarmclaw DAG event-hook surface (~1 pt) |
| **SPIKE-11** | P2.1 (sqlite-vec/ONNX) | D3 — sqlite-vec + ONNX MiniLM validation in Bun (~1 pt) |

## Entry / gate

- **Epic entry:** P2.0 can start once **P0.7** (SwarmClaw agent+MCP registry) exists.
- **Full epic gates on:** P0.7 + **P1.6** (Warren Pi-team dispatch) + **P1.15** (real PR → real runs to capture/promote/experiment on).
- **Cross-epic dep:** P2.8 (Hindsight bridge) → **P1.11** (Hindsight retain, KEEP).
