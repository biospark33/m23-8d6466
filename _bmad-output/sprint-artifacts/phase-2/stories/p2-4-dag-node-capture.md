# P2.4: Capture SwarmClaw DAG-Node Transitions as Node Events

**Story Points:** 4

> BLOCKED-BY SPIKE-10 for live tap + E2E; ships interface + unit tests first (mirror P2.10 / §B.4 "E2E of"). The `ProtocolRunEvent` vocabulary is KNOWN and stable; only the tap mechanism is gated.

## Spec Reference

- QDS-MEM-003 §5.1 (Capture adapters); QDS-MEM-003-IMPL §C D5 (DAG-node capture)
- QDS-EXEC-001 §7 SPIKE-10 (swarmclaw DAG tap mechanism); known event vocabulary at `/Users/steve/swarmclaw/src/types/protocol.ts:387-443`

## User Story

As a QDS dev agent orchestrator,
I want SwarmClaw DAG node transitions and handoffs recorded as `node` events threaded into the run's event tree,
so that any multi-agent protocol run is reconstructable at DAG granularity for the optimizer and for human replay (G3 — diagnosable runs).

## Overview

This story defines and partially wires the DAG-node capture surface: SwarmClaw protocol-run transitions (`ProtocolRunEvent`, §D.5 — real, stable vocabulary) map to `events` rows with `event_type='node'`, threaded to their run via non-null `run_id` and into the event tree via `parent_event_id`, with optional `event_edges` `handoff` relations at agent boundaries. Node identity is one node per phase/step: PHASE events are keyed by `phaseId`, STEP events by `stepId`, with `id` as fallback only for node-less types — `started`/`completed` are transitions on the SAME node. It is a 4-point net-new unit because SwarmClaw exposes no push hook / emitter / subscribe API today — the tap mechanism (poll `listUnifiedRunEvents`, patch the `upsertProtocolRunEvent` site, or consume the handoff packet) is exactly what SPIKE-10 selects. This story is therefore scoped **BLOCKED-BY SPIKE-10 for live tap + E2E; it ships the interface + unit tests first**: it defines the `node` event shape, the `parent_event_id` event-tree contract, the two-pass handoff-edge resolution, and the adapter signature against the KNOWN `ProtocolRunEvent` vocabulary now; the real tap wiring and live-source E2E bind post-SPIKE-10. Capture remains mechanical: no LLM (INV-OM1). Node events are NOT embedded into `event_vec` (R6 — queried by index/tree, not similarity). The interface and unit tests close in this story with no stub in the contract itself; only the tap-mechanism binding is deferred.

## E2E Slice

**Demonstrable behavior:** Against a recorded/fixture sequence of `ProtocolRunEvent` objects (e.g. `phase_started → step_started → task_dispatched → delegation_dispatched → step_completed → phase_completed`), the adapter maps each to a `node` event and writes it through the P2.1 store; querying `SELECT event_type, run_id, parent_event_id FROM events WHERE run_id = ? AND event_type='node' ORDER BY created_at` returns the ordered node sequence with a coherent `parent_event_id` tree, and `delegation_dispatched` boundaries produce `event_edges` rows with `relation='handoff'`.

**Wiring closed:** This story ships the interface + unit tests first; the adapter mapping `ProtocolRunEvent → node` events, the single-root `parent_event_id` tree contract, and the two-pass `handoff` edge contract are real and unit-tested against fixtures using only code merged by this story and predecessors P2.1/P2.3. The live tap (real SwarmClaw event source) and live-source E2E are gated on SPIKE-10 — no stub enters the contract or the mapping itself; only the tap binding is deferred.

**Dependency edges (predecessors):** P2.1 (event store + `event_edges` + tree-reconstruction recall); P2.3 (authors the shared `src/capture/mask-and-cap.ts` `maskAndCap` util reused here); SPIKE-10 (DAG tap mechanism — gates live tap + E2E).

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given a fixture array of `ProtocolRunEvent` objects for one `runId` including a `phase_started`+`phase_completed` pair and a `step_started`+`step_completed` pair, When the adapter maps and writes them, Then every `events` row has `event_type='node'` and non-null `run_id = event.runId`; PHASE events resolve `dag_node_id = event.phaseId`, STEP events resolve `dag_node_id = event.stepId`, node-less types fall back to `event.id`; the started/completed pair for one phase/step share ONE `dag_node_id` (started/completed are transitions on the same node, not two nodes); no row is written with a null `run_id`.
2. Given a `ProtocolRunEvent` sequence with a root phase and nested child steps, When the adapter threads them, Then each child node's `parent_event_id` resolves to its enclosing phase/step node, the ROOT node has `parent_event_id = NULL`, and reconstructing the run via the P2.1 recall API yields a single connected tree with exactly one root (no orphan nodes).
3. Given a `delegation_dispatched` (or `subflow_*` handoff-boundary) event whose `taskId` targets a node not yet ingested, When the adapter resolves edges in its second pass (TWO-PASS: ingest all nodes, then resolve `event_edges` by `taskId`), Then an `event_edges` row with `relation='handoff'` is written with `source_id`/`target_id` set to the dispatching and receiving node events; a still-unresolvable target (never seen in the batch) is counted in the returned `skippedEdges`, not written as a dangling edge.
4. Given a `ProtocolRunEvent` whose `type` is not in the captured allowlist (e.g. an unmodeled future type), When the adapter receives it, Then it is skipped without error and without writing a malformed row (forward-compatible guard), and `ingestProtocolRunEvents` returns a `{written, skippedEvents, skippedEdges, edges}` object whose `skippedEvents` count includes it (observable, not silently lost), distinct from `skippedEdges` which counts only unresolvable handoff targets.
5. Given the adapter runs over a fixture batch, When it maps and writes node events, Then zero LLM/HTTP calls occur during capture (network mock asserts zero requests; the `@anthropic-ai/claude-agent-sdk` module spy's `query()` is never invoked) — INV-OM1.
6. Given a fixture event whose `parent_event_id` would reference a node from a different `run_id`, When the adapter attempts to write it, Then the write is rejected (INV-DAG1 enforced at write time — both endpoints' `run_id` verified equal before commit, since the schema cannot enforce it).

## Technical Notes

- **Contracts/Schema:** `node` event is an `events` row (P2.1 owns DDL §4); this story writes, does not redefine. KNOWN source vocabulary and the mapping contract:
  ```typescript
  // KNOWN — representative subset; full vocabulary at the cited source
  //   /Users/steve/swarmclaw/src/types/protocol.ts:387-443 (stable; SPIKE-10 does NOT change this)
  type ProtocolRunEvent = {
    id: string; runId: string;
    type: 'phase_started' | 'phase_completed' | 'step_started' | 'step_completed'
        | 'step_ready' | 'step_waiting' | 'step_failed' | 'branch_taken'
        | 'parallel_branch_spawned' | 'parallel_branch_completed'
        | 'loop_iteration_started' | 'loop_iteration_completed'
        | 'subflow_started' | 'subflow_completed'
        | 'swarm_opened' | 'swarm_claimed' | 'swarm_exhausted'
        | 'task_dispatched' | 'delegation_dispatched'
        | 'completed' | 'failed' | 'cancelled';
    summary: string; phaseId?: string | null; stepId?: string | null;
    agentId?: string | null; taskId?: string | null;
    createdAt: number; data?: Record<string, unknown> | null;
  };

  // node-event mapping contract (this story owns this; INTERFACE-FIRST)
  type NodeEventMap = {
    run_id: string;            // = event.runId            [INV-OM2] non-null
    // ONE node per phase/step — started/completed are transitions on the SAME node:
    dag_node_id: string;       // PHASE types → event.phaseId; STEP types → event.stepId;
                               // node-less types → event.id (fallback only)
    parent_event_id: string | null; // enclosing phase/step node id; ROOT node → NULL
    event_type: 'node';
    agent_id: string;          // = event.agentId ?? '<dag>'
    payload_json: string;      // [INV-OM3] NOT NULL; {type,summary,phaseId,stepId,taskId,data} ≤64KB, masked
    created_at: number;        // = event.createdAt
  };
  // payload_json is NOT NULL (§C DDL) — every node row populates it (satisfied: always built from event).
  // Handoff boundaries (delegation_dispatched / subflow_*) → event_edges{relation:'handoff'},
  //   resolved TWO-PASS: pass 1 ingest+write all node events; pass 2 resolve edges by taskId
  //   (target may be ingested later in the batch); unresolvable target → counted in `skippedEdges`.
  // [INV-DAG1] verified at write time: parent_event_id and edge endpoints must share run_id.
  // Two distinct skip counters (unambiguous skip semantics):
  //   skippedEvents = unmodeled-type events (type not in captured allowlist), never written;
  //   skippedEdges  = handoff edges whose target taskId is unresolvable in the batch, never written dangling.
  // Adapter signature (source-decoupled, return observable):
  //   ingestProtocolRunEvents(events: ProtocolRunEvent[]):
  //     { written: number; skippedEvents: number; skippedEdges: number; edges: number }
  ```
- **Integration points (each wired & exercised in this story, via fixtures):** P2.1 event store transactional write path (`node` rows, two-pass); P2.1 `event_edges` (`handoff` relation, resolved by `taskId`); P2.1 tree-reconstruction recall API (validates single-root `parent_event_id` connectivity); P2.3-owned `maskAndCap` (`src/capture/mask-and-cap.ts`) reused. **Live source seam (SPIKE-10, deferred):** one of poll `listUnifiedRunEvents(runId)`, patch `upsertProtocolRunEvent` call site, or consume `GET /api/runs/[id]/handoff` — binds to `ingestProtocolRunEvents` without touching the mapper/schema.
- **Files / functions touched:** `src/capture/dag-node-adapter.ts` (`ingestProtocolRunEvents` returning `{written,skippedEvents,skippedEdges,edges}` + `ProtocolRunEvent → node` mapper + two-pass handoff-edge resolver + parent-tree resolver + INV-DAG1 same-run check), reuse `src/capture/mask-and-cap.ts` (P2.3-owned `maskAndCap`, 64KB cap/mask).
- **Guards/limits:** `payload_json` (NOT NULL) ≤64 KB + secret-masked via `maskAndCap` (INV-OM3); reject write when `event.runId` is absent (INV-OM2); `parent_event_id`/edge endpoints verified same-`run_id` at write time (INV-DAG1); unmodeled `type` skipped + counted in the returned `skippedEvents` (forward-compatible); handoff edges resolved TWO-PASS by `taskId`, unresolvable targets counted in `skippedEdges` (distinct counter); node events NOT embedded into `event_vec` (R6); the tap mechanism is NOT chosen here — `ingestProtocolRunEvents` is the single source-decoupled entry point so SPIKE-10's pick binds without re-touching the mapper; live tap + E2E gated on SPIKE-10.

## Files to Modify

> ≤10 unique paths, one per line.
- `src/capture/dag-node-adapter.ts`
- `src/capture/mask-and-cap.ts`
- `tests/capture/dag-node-adapter.test.ts`
- `tests/capture/dag-node-tree.test.ts`

## Security Invariants

> Concrete named invariants only — N/A NOT permitted when triggered.

- **INV-OM1:** Zero per-event LLM/HTTP — DAG-node mapping is mechanical; no network egress during capture (network mock asserts zero requests); the `@anthropic-ai/claude-agent-sdk` module spy's `query()` is never invoked. Tap-agnostic: this story does NOT pre-commit SPIKE-10's tap choice (poll / patch-site / handoff-packet); whichever is selected, the source is SwarmClaw's local run store, not per-event LLM/external egress.
- **INV-OM2:** `run_id` non-null on every `node` `events` row referencing a real `runs` row — sourced from `ProtocolRunEvent.runId` (the live DAG run); the adapter rejects any event lacking `runId` and never writes an orphan or NULL node row.
- **INV-DAG1:** enforced at write time — `parent_event_id` references only an event within the same `run_id`, and handoff `event_edges` `source_id`/`target_id` likewise resolve within the run; the adapter verifies both endpoints' `run_id` match before commit (the schema cannot enforce this).

## Definition of Done

> 10–14 high-signal, story-specific boxes (net-new). NO lint/tests/typecheck filler.

- [ ] **Impl:** `ProtocolRunEvent → node` mapper implemented against the KNOWN §D.5 vocabulary, populating `run_id`, `dag_node_id` (PHASE→`phaseId`, STEP→`stepId`, node-less→`id`; one node per phase/step with started/completed as transitions), `event_type='node'`, `agent_id`, NOT-NULL `payload_json`, `created_at`.
- [ ] **Impl:** `parent_event_id` event-tree resolver threads child phase/step/loop/subflow nodes under their enclosing node within the same run; the ROOT node has `parent_event_id = NULL`.
- [ ] **Impl:** handoff-boundary events (`delegation_dispatched`, `subflow_*`) emit `event_edges` rows with `relation='handoff'` via TWO-PASS resolution by `taskId` (target may be ingested later in the batch).
- [ ] **Impl:** `ingestProtocolRunEvents(events: ProtocolRunEvent[])` returns `{written, skippedEvents, skippedEdges, edges}` (not void) — the single source-decoupled ingestion entry point (`skippedEvents` = unmodeled-type events, `skippedEdges` = unresolvable handoff targets, two distinct counters); SPIKE-10's tap binds here without changing the mapper or schema.
- [ ] **Contract:** `event_type` fixed to `'node'`; `node` rows conform to the P2.1 `events` schema; no fields beyond §4 DDL introduced; node events NOT embedded into `event_vec` (R6); unmodeled `ProtocolRunEvent.type` skipped + counted in returned `skippedEvents` (forward-compatible).
- [ ] **Integration:** mapper + tree resolver + two-pass handoff emitter wired into the P2.1 transactional write path and exercised against fixture `ProtocolRunEvent` batches end-to-end.
- [ ] **Security:** INV-OM1 (network mock asserts zero egress, SDK `query()` spy never invoked), INV-OM2 (missing-`runId` event rejected), INV-DAG1 (parent/edge refs verified same-`run_id` at write time) each enforced and individually tested.
- [ ] **Guard:** event lacking `runId` rejected before insertion; `payload_json` (NOT NULL) ≤64 KB + secret-masked via `maskAndCap` (`src/capture/mask-and-cap.ts`); edge whose target is never seen counted in `skippedEdges`, not written dangling.
- [ ] **Test (unit):** mapping table — phase started/completed share one `dag_node_id`; step started/completed share one; `delegation_dispatched` produces a `handoff` edge (two-pass); unmodeled type increments `skippedEvents`; unresolvable handoff target increments `skippedEdges` (each counter asserted separately).
- [ ] **Test (unit):** tree reconstruction over a fixture batch yields a single connected tree with exactly one root (ROOT `parent_event_id=NULL`, no orphan node), verified through the P2.1 recall API.
- [ ] **Deferral note:** the live SwarmClaw tap and live-source E2E are gated on SPIKE-10 — `ingestProtocolRunEvents` is the documented binding point for the SPIKE-10-selected tap (poll / patch-site / handoff-packet); the mapper, tree contract, and unit tests ship in this story.
- [ ] **Test (integration demo over fixtures — MANDATORY; live-source E2E binds post-SPIKE-10):** drive a recorded `ProtocolRunEvent` fixture sequence through `ingestProtocolRunEvents`; assert ordered `node` rows with non-null `run_id`, a single-root connected `parent_event_id` tree, `handoff` edges at delegation boundaries, and a `{written,skippedEvents,skippedEdges,edges}` return matching the fixture (asserting `skippedEvents` and `skippedEdges` separately).

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
