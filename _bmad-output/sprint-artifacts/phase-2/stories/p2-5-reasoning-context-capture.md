# P2.5: Capture Reasoning + Agent-Context as Message Events via pi-mono ExtensionAPI

**Story Points:** 3

## Spec Reference

- QDS-MEM-003 §5.1 (capture adapters), §2 (raw operational memory vs distilled Hindsight — no overlap); §5.2 threading contract
- QDS-MEM-003-IMPL §D.2; §E.1 (the Four Invariants)
- Deltas: D1 (capture is mechanical, zero per-event LLM), D4 (pi-mono seam)

## User Story

As a QDS optimization subsystem,
I want each agent reasoning/message turn captured mechanically as a threaded `message` event with a local embedding,
so that the operational-memory spine holds the raw reasoning stream for replay and analysis, distinct from Hindsight's distilled durable decisions (G-LEARN — raw stream stays in ops memory; only nightly-distilled decisions reach Hindsight).

## Overview

This story wires a thin pi-mono extension adapter onto the **free** `ExtensionAPI` seam, subscribing via `ExtensionAPI.on` to `MessageUpdateEvent`, `TurnEndEvent`, and `AgentEndEvent` (symbols in `pi-mono/packages/coding-agent/src/core/extensions/types.ts`) to persist agent reasoning and message content as `events` rows (`event_type='message'`) plus companion `event_vec` rows in the P2.1 store. It follows the **canonical capture pattern established by P2.3** exactly — full §5.2 threading, ONNX embed computed before the transaction, atomic event+vector write — and **reuses the P2.3 shared `maskAndCap` util at `src/capture/mask-and-cap.ts`** (GAP #4) verbatim plus the **P2.3 orphan-run + `threading.ts` helpers**; it authors no masking and no threading logic of its own. A **turn-buffer state machine** accumulates `MessageUpdateEvent` text by `turnIndex`; `TurnEndEvent` flushes+clears to exactly ONE `message` row; `AgentEndEvent` flushes ONLY if the buffer is non-empty (interrupted turn) else no-ops. This captures the **raw** reasoning stream only: distillation/summarization belongs to the nightly cron (P2.7), and durable decisions live in Hindsight — this adapter does not duplicate the Hindsight decision store (§2, no overlap). Capture is mechanical: zero LLM and zero HTTP egress per event; the handler **never throws into the pi-mono event loop** (the reused `maskAndCap` is total). Wiring closes with no stub and no `TODO`.

## E2E Slice

**Demonstrable behavior:** With the ONNX pipeline warm-loaded and a network mock installed (any outbound socket throws), run a pi-mono coding-agent session that completes one turn; the extension buffers `MessageUpdateEvent` text by `turnIndex` and on `TurnEndEvent` flushes one `events` row (`event_type='message'`, populated `run_id`/`agent_id`/`skill`/`parent_event_id`, masked+capped `payload_json` holding `messageText`) and one `event_vec` row with a deterministic 384-dim FLOAT[384] embedding; querying `events` by `run_id` returns the message row threaded under the run and the network mock records zero outbound calls.

**Wiring closed:** On completion, any pi-mono reasoning/message turn captures to the event store using only code merged by this story and predecessors P2.1 + P2.3 (reusing the P2.3 `maskAndCap`, orphan-run, and `threading.ts` helpers — no re-impl). No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P2.1, P2.3 (reuses P2.3 `maskAndCap` + orphan-run + `threading.ts`)

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given the ONNX pipeline warm-loaded from `env.localModelPath` and *then* an outbound-network mock that throws on any socket open, When a session emits a stream of `MessageUpdateEvent`s followed by a `TurnEndEvent`, Then exactly one consolidated `events` row (`event_type='message'`, non-null `run_id`) and one `event_vec` row are written per completed turn, the network mock records **zero** outbound calls (zero LLM/HTTP egress), and observed **p99 latency < 5 ms** per `turn_end` flush.
2. Given a `TurnEndEvent` carrying `message`, When the handler runs, Then exactly one `events` row exists with `event_type='message'`, `messageText` (extracted from `TurnEndEvent.message`) in masked+capped `payload_json`, `toolResults` NOT captured here (owned by P2.3), and a 384-element FLOAT[384] `event_vec` row keyed on its `event_id`.
3. Given message content containing a secret (e.g. `sk-test...`) **and** exceeding 64 KB, When the **reused P2.3 `maskAndCap`** util processes it for both storage and embed-input, Then the secret is **absent from BOTH `payload_json` AND the text passed to the embed pipeline** (a spy on the embed input asserts the secret never reaches `event_vec`), and byte-length ≤ 65536 inclusive of the marker (INV-OM3) — using the P2.3 util with no local re-implementation.
4. Given the same reasoning text embedded twice with `dtype:'fp32'`/`pooling:'mean'`/`normalize:true`, When `embedText()` runs, Then the two 384-dim vectors are bytewise-identical and `env.allowRemoteModels===false` (INV-OM4).
5. **(state machine, binary on both arms)** Given a **clean** turn (`MessageUpdateEvent`s → `TurnEndEvent` flush+clear) immediately followed by `AgentEndEvent`, When handled, Then `AgentEndEvent` sees an empty buffer and writes **zero** extra rows (no-op); AND given a **buffered-unterminated** turn (`MessageUpdateEvent`s with no `TurnEndEvent`) followed by `AgentEndEvent`, When handled, Then `AgentEndEvent` flushes the non-empty buffer to **exactly one** final `message` event threaded to the run (`run_id` non-null, INV-OM2).
6. Given a `TurnEndEvent` fires with **no active run context**, When the handler runs, Then it synthesizes `run_id='orphan:<sessionId>'` + a matching `runs` row via the **reused P2.3 orphan helper** and writes the row — never null, never dropped (INV-OM2, R1).

## Technical Notes

- **Contracts/Schema:** Writes the P2.1-owned `events` table + `event_vec vec0(... FLOAT[384])` (cite P2.1 DDL; do not redefine). Row mapping from `TurnEndEvent {turnIndex, message, toolResults}` / `MessageUpdateEvent {message, assistantMessageEvent}` / `AgentEndEvent {messages}` (symbols in `pi-mono/.../extensions/types.ts`): `{ id:'message:'+uuid, run_id, agent_id, agent_role, skill, skill_version, prompt_id, prompt_version, parent_event_id, event_type:'message', payload_json:maskAndCap(messageText), tokens, duration_ms, created_at }`. **`toolResults` is intentionally NOT captured here** — tool I/O is owned by P2.3.
- **`messageText` extraction (R16):** from `TurnEndEvent.message` — take its text content (the assistant message string; if `message` is a structured object, the concatenated text segments). The buffered `MessageUpdateEvent` text accumulated for the same `turnIndex` is the streaming source; on `turn_end` the final `TurnEndEvent.message` text is authoritative for `payload_json`.
- **`tokens` resolution (R16):** from `TurnEndEvent.tokenCount` (or `.tokens`) if the event payload carries a token count; else `0` (schema default — `events.tokens` is `INTEGER DEFAULT 0`). A local tokenizer estimate is not used.
- **`duration_ms` resolution (R16):** `TurnEndEvent.timestamp - started_at` where `started_at` is the timestamp stored in the turn-buffer entry (type `Map<string, {text, started_at}>`) when the first `MessageUpdateEvent` for the composite key `${runId}:${turnIndex}` was received. If the buffer carries no `started_at` (turn started before the adapter attached), `duration_ms` is `null`.
- **Turn-buffer state machine (R16) — `src/capture/turn-buffer.ts`:** `Map<string, {text, started_at}>` keyed by composite `` `${runId}:${turnIndex}` `` (where `runId` is resolved from the capture-session context, matching the event row's `run_id` — composite key prevents cross-session/run collisions when multiple concurrent sessions are active). `MessageUpdateEvent` → append text to the entry for its composite key `${runId}:${turnIndex}` (create if absent; NO row written). `TurnEndEvent` → flush the entry to exactly ONE `message` row then **clear** that composite key. `AgentEndEvent` → for each remaining non-empty entry flush ONE final row (interrupted/unterminated turn); if the buffer is empty (clean prior `turn_end`) it is a **no-op** (zero rows). Both arms are binary (AC#5).
- **Reused util + threading (NOT re-authored):** import P2.3 `maskAndCap` from `src/capture/mask-and-cap.ts` (total/never-throws, mask→cap with marker reserved) for all masking + 64 KB capping; import the P2.3 `threading.ts` helpers (§5.2 resolution + orphan-run synthesis). This story adds no masking and no threading code — GAP #4 and the orphan helper are owned by P2.3.
- **Embedding (reuse P2.3 `embed.ts` / swarmclaw pattern):** same lazy-singleton `pipeline('feature-extraction','Xenova/all-MiniLM-L6-v2',{dtype:'fp32'})`; embed text = ``maskAndCap(`${event_type} ${skill} ${messageText}`)`` via `await pipe(text,{pooling:'mean',normalize:true})` → `Float32Array(384)` (same masked text as stored, so secrets never reach `event_vec`). **INV-OM4:** `env.allowRemoteModels=false`, pinned `env.localModelPath`. **Warm-load the pipeline from `env.localModelPath` BEFORE any network mock installs** so the egress test is deterministic. Compute embedding **before** the transaction.
- **Integration points (each wired & exercised):** pi-mono `ExtensionAPI.on` subscribing `MessageUpdateEvent` / `TurnEndEvent` / `AgentEndEvent` (symbols in `pi-mono/packages/coding-agent/src/core/extensions/types.ts`); `ExtensionContext` for threading source (no LLM); P2.1 store `db.transaction(fn)` writing `events` + `event_vec`.
- **Threading source (§5.2):** identical to P2.3 (reuse `threading.ts`) — `run_id`/`agent_id`/`skill`/`prompt_id`/`prompt_version`/`parent_event_id` from the capture-session context; one durable `message` event per `turn_end`, `MessageUpdateEvent` buffered (no per-token row), unterminated buffer flushed on `agent_end`. No active run → orphan-run synthesis (R1).
- **Guards/limits:** one `message` event + one vec per completed turn, atomic; `MessageUpdateEvent` stream coalesced (no per-token writes); embedding pre-tx; p99 < 5 ms per `turn_end` flush; payloads ≤ 64 KB masked; `maskAndCap` never throws; no network egress; raw stream only (no distillation — that is P2.7).

## Files to Modify

> ≤10 unique paths, one per line.
- `src/capture/pi-reasoning-extension.ts`
- `src/capture/turn-buffer.ts`
- `tests/capture/pi-reasoning-extension.test.ts`
- `tests/capture/turn-buffer.test.ts`
- `tests/capture/reasoning-embed-determinism.test.ts`

## Security Invariants

> Concrete named invariants only — N/A NOT permitted when triggered.

- **INV-OM1:** Zero per-event LLM/HTTP — the `MessageUpdateEvent`/`TurnEndEvent`/`AgentEndEvent` handlers perform no network egress; capture is mechanical. Asserted by a network mock that throws on any outbound socket. The handler **never throws into the pi-mono event loop** (reused `maskAndCap` is total).
- **INV-OM2:** non-null `run_id` referencing a real `runs` row on every `message` event written by this adapter; orphan-context capture uses `orphan:<session>` runs (via the reused P2.3 helper) — never NULL, never a silent drop. Enforced before write.
- **INV-OM3:** `payload_json` ≤ 64 KB (inclusive of the `…[truncated]` marker) and secret-pattern-masked via the **reused P2.3 `maskAndCap`** util before write (no local masking re-implementation); the **same masked text** is the embed input, so no secret reaches `event_vec`.
- **INV-OM4:** ONNX model loaded from a pinned local path only (`env.allowRemoteModels=false`, `env.localModelPath` set) via the **reused P2.3 `embed.ts`** — no remote fetch; deterministic `fp32` 384-dim vectors, `pooling:'mean'`, `normalize:true`.

## Definition of Done

> 8–10 high-signal, story-specific boxes. No CI filler.

- [ ] **Impl:** `ExtensionAPI.on(TurnEndEvent)` adapter writes one `events` (`event_type='message'`) + one `event_vec` row per completed turn in a single `db.transaction`, embedding computed before the tx; `messageText` extracted precisely from `TurnEndEvent.message`; `toolResults` NOT captured (owned by P2.3).
- [ ] **Impl (state machine, R16):** `turn-buffer.ts` accumulates `MessageUpdateEvent` by composite key `${runId}:${turnIndex}` (no per-token rows; composite key prevents cross-session/run collisions); `TurnEndEvent` flushes+clears ONE row; `AgentEndEvent` flushes ONLY a non-empty buffer (interrupted turn) else no-ops.
- [ ] **Reuse (no re-impl):** imports P2.3 `maskAndCap`, orphan-run helper, `embed.ts`, and `threading.ts` — this story authors no masking, embedding, or threading logic.
- [ ] **Contract:** every written row threaded per §5.2 (`run_id`, `agent_id`, `skill`, `prompt_id`, `parent_event_id`) against the P2.1 `events`/`event_vec` schema; raw reasoning stream only (no distillation — §2 no overlap with Hindsight).
- [ ] **Integration:** adapter exercised end-to-end against the real P2.1 store; query by `run_id` returns the message rows threaded under the run.
- [ ] **Security (INV-OM1):** zero LLM/HTTP egress — network mock asserts zero outbound calls; handler never throws into the pi-mono event loop.
- [ ] **Security (INV-OM2, R1):** non-null `run_id` on every write; no-active-run → reused orphan helper synthesizes `orphan:<sessionId>` run; never null/dropped.
- [ ] **Security (INV-OM3):** secret `sk-test...` → absent from BOTH `payload_json` AND the embed-input text (spy on embed input); byte-length ≤ 65536 incl. marker via reused `maskAndCap`; no duplicate masking code (INV-OM4 local-only `fp32` 384-dim also asserted via reused `embed.ts`).
- [ ] **Test (unit):** state machine binary on both arms — clean `turn_end`+`agent_end` → zero extra rows; buffered-unterminated + `agent_end` → exactly one row; reasoning embed bytewise-identical on repeat.
- [ ] **Test (e2e demo — MANDATORY):** with pipeline warm-loaded then network mock active, run a session through `turn_end`+`agent_end` → assert one `message` event + one `event_vec` row per turn, threaded to `run_id`, zero outbound calls, and p99 < 5 ms per flush.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
