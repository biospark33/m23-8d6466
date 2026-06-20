# P2.3: Capture Tool Calls via pi-mono ExtensionAPI into the Event Store

**Story Points:** 3

## Spec Reference

- QDS-MEM-003 §5.1–5.3 (capture adapters; threading contract §5.2); QDS-MEM-003-IMPL §D.1
- QDS-MEM-003-IMPL §E.1 (the Four Invariants); §C GAP #4 (64KB-cap + secret-mask helper, net-new)
- Deltas: D1 (all per-event LLM stripped — capture is mechanical), D4 (pi-mono seam, IDE/transcript capture dropped)

## User Story

As a QDS optimization subsystem,
I want every agent tool call captured mechanically as a threaded `events` row plus a local-embedded `event_vec` row,
so that the operational-memory spine records what agents actually did with zero LLM cost and full run/agent/skill provenance (G-LEARN — the spine that makes runs replayable and skills measurable).

## Overview

This story wires a thin pi-mono extension adapter onto the **free** `ExtensionAPI` seam (`ExtensionAPI.on` for `ToolExecutionEndEvent`, in `pi-mono/packages/coding-agent/src/core/extensions/types.ts`) so that each completed tool call is persisted as exactly one `events` row (`event_type='tool_call'`) and exactly one `event_vec` row, written in a single `better-sqlite3` transaction against the P2.1 store. It is the **canonical capture pattern** every sibling capture story (P2.4–P2.6) copies. Because `ToolExecutionEndEvent` carries only `{toolCallId, toolName, result, isError}` (no args, no duration), the adapter buffers `ToolExecutionStartEvent.args` + start-ts keyed by `toolCallId` and **joins on end** to populate `payload_json` (args+result) and `duration_ms`. That buffer is **bounded by a configurable TTL eviction** (`capture.bufferStartTtlMs`, default 1h): orphaned start entries whose END never fires (tool abort, crash, dropped event) are pruned lazily on buffer access rather than leaking forever. It computes a 384-dim ONNX embedding (Xenova/all-MiniLM-L6-v2, local-only) **before** opening the transaction, masks secrets and caps payloads at 64 KB, and threads each row with `run_id`/`agent_id`/`skill`/`prompt_id`/`parent_event_id` per §5.2. This story also authors the **net-new shared `maskAndCap` util at `src/capture/mask-and-cap.ts` (GAP #4, R7)** consumed by all capture stories, and the **orphan-run helper (R1)** reused by P2.5/P2.6. Capture is mechanical: zero LLM and zero HTTP egress per event. The handler **never throws into the pi-mono event loop**. Wiring closes with no stub and no `TODO`.

## E2E Slice

**Demonstrable behavior:** With the ONNX pipeline warm-loaded and a network mock installed (any outbound socket throws), run a pi-mono coding-agent session that executes a real `bash` tool call; the extension buffers the `ToolExecutionStartEvent` args and on `ToolExecutionEndEvent` writes one `events` row (`event_type='tool_call'`, `tool_name='bash'`, populated `run_id`/`agent_id`/`skill`/`parent_event_id`, masked+capped `payload_json` (args+result)/`result_json`, joined `duration_ms`) and one `event_vec` row with a deterministic 384-dim FLOAT[384] embedding; querying `events` by `run_id` returns the row and the network mock records zero outbound calls.

**Wiring closed:** On completion, any pi-mono tool call captures to the event store using only code merged by this story and predecessor P2.1. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P2.1

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given the ONNX pipeline warm-loaded from `env.localModelPath` and *then* an outbound-network mock that throws on any socket open, When 1000 `ToolExecutionEndEvent`s are dispatched through the adapter, Then exactly 1000 `events` rows and 1000 `event_vec` rows are written, the network mock records **zero** outbound calls (zero LLM/HTTP egress), and observed **p99 latency < 5 ms** per call.
2. Given a `ToolExecutionEndEvent` for `toolName='bash'` with `isError=false` and a buffered `ToolExecutionStartEvent` for its `toolCallId`, When the handler runs, Then exactly one `events` row exists with `event_type='tool_call'`, `tool_name='bash'`, non-null `run_id` (INV-OM2), `payload_json` containing both the joined `args` and `result`, a non-null `duration_ms`, and `outcome='success'`; and exactly one `event_vec` row exists keyed on that `event_id` with a 384-element FLOAT[384] vector.
3. Given a payload containing a secret (e.g. `sk-test...`, `AKIA...`, `ghp_...`) **and** exceeding 64 KB, When `maskAndCap` processes it for both storage and embed-input, Then the secret substring is **absent from BOTH the stored `payload_json`/`result_json`/`error` AND the text passed to the embed pipeline** (a spy on the embed input asserts the secret never reaches `event_vec`), and stored byte-length is ≤ 65536 inclusive of the `…[truncated]` marker (INV-OM3, R7).
4. Given the same `text` embedded twice, When `embedText()` runs with `dtype:'fp32'`, `pooling:'mean'`, `normalize:true`, Then the two 384-dim vectors are bytewise-identical (deterministic ONNX) and `env.allowRemoteModels===false` (INV-OM4).
5. Given a `ToolExecutionEndEvent` with `isError=true`, When the handler runs, Then the `events` row has `outcome='failure'` and a masked+capped `error` field, and the transaction still commits exactly one `events` + one `event_vec` row (failure-path guard).
6. Given a `ToolExecutionEndEvent` fires with **no active run context**, When the handler runs, Then it synthesizes `run_id='orphan:<sessionId>'` plus a matching `runs` row (`dag_def_id='__orphan__'`) and **writes the event** — the row is never null and never dropped (INV-OM2, R1).
7. Given a single turn with **two** tool calls at the same `turnIndex`, When both `ToolExecutionEndEvent`s are handled, Then both rows carry `parent_event_id` = the enclosing turn/node event for that `turnIndex` (NOT "most recent open event").

## Technical Notes

- **Contracts/Schema:** Writes the P2.1-owned `events` table + `event_vec vec0(event_id TEXT PRIMARY KEY, embedding FLOAT[384])` (cite P2.1 DDL; do not redefine). Row mapping from `ToolExecutionEndEvent {toolCallId, toolName, result, isError}` joined with the buffered `ToolExecutionStartEvent {toolCallId, toolName, args}` (both in `pi-mono/.../extensions/types.ts`): `{ id: 'tool_call:'+uuid, run_id, agent_id, agent_role, skill, skill_version, prompt_id, prompt_version, parent_event_id, event_type:'tool_call', tool_name:toolName, payload_json:maskAndCap({args, result}), result_json:maskAndCap(result), outcome: isError?'failure':'success', error: isError?maskAndCap(result):null, duration_ms: end_ts - start_ts, created_at }`.
- **Start/end correlation (R16):** `ToolExecutionEndEvent` carries NO args and NO duration. On `ToolExecutionStartEvent`, buffer `{args, start_ts}` in a `Map<toolCallId, {...}>`; on `ToolExecutionEndEvent`, look up by `toolCallId`, compute `duration_ms = now - start_ts`, build `payload_json` from `{args, result}`, then delete the buffer entry. A missing start entry (e.g. dropped, or already evicted by TTL — see below) falls back to `payload_json:maskAndCap({result})` with `duration_ms:null` — still one row written.
- **Buffer TTL eviction (R16):** the in-memory start/end correlation `Map` is **bounded by TTL eviction**, not left to grow unbounded. A configurable tunable — `capture.bufferStartTtlMs` in capture config (default `3_600_000` = 1 hour; **NOT a hardcoded magic constant**) — bounds the lifetime of every buffered start entry. Entries whose `start_ts` is older than `now - capture.bufferStartTtlMs` (orphaned starts whose matching `ToolExecutionEndEvent` never fires — tool abort, process crash, dropped event) are pruned **lazily on each buffer access** (both read-by-`toolCallId` on `ToolExecutionEndEvent` and the start-insert path sweep adjacent entries), avoiding a periodic timer and its scheduling/thread footprint. A `ToolExecutionEndEvent` arriving for an already-evicted entry is indistinguishable from any other missing-start case and hits the EXISTING missing-start fallback above (`payload_json:maskAndCap({result})`, `duration_ms:null`, still exactly one row written) — eviction never doubles a row or drops an END.
- **Shared util (net-new, GAP #4, R7) — `maskAndCap(value: unknown): string` at `src/capture/mask-and-cap.ts`:** mask → then cap. (1) Serialize with a **circular-safe** replacer and **BigInt-safe** coercion; on any serialization failure return the sentinel `{"_capture_error":"unserializable"}` — the util is **TOTAL and never throws**. (2) Apply the ordered secret-pattern set (below). (3) Hard-truncate to ≤ 65536 bytes UTF-8-safe, **reserving the `…[truncated]` marker length so final bytes ≤ 65536 inclusive of the marker**. Pure, sync, no I/O. Exported for P2.4/P2.5/P2.6 reuse. **The same `maskAndCap` output is used for BOTH the stored payload AND the embed-input text**, so secrets never reach `event_vec`. Mask surface = `payload_json`, `result_json`, AND `error`.
- **Secret pattern set (driven by `tests/capture/secret-corpus.json`, positive + negative cases):** OpenAI `sk-[A-Za-z0-9]{20,}`; AWS `AKIA[0-9A-Z]{16}`; GitHub `ghp_[A-Za-z0-9]{36}` / `github_pat_[A-Za-z0-9_]{40,}`; bearer `Bearer\s+[A-Za-z0-9._\-]+`; generic k/v `("?(key|secret|token|password)"?\s*[:=]\s*"?)([^"\s,}]+)` with delimiters `:`/`=`/`":"`. Each match replaced with `«REDACTED»`.
- **Embedding (reuse swarmclaw `embeddings.ts` pattern):** lazy-singleton `pipeline('feature-extraction','Xenova/all-MiniLM-L6-v2',{dtype:'fp32'})`; embed text = ``maskAndCap(`${event_type} ${skill} ${tool_name} ${payload}`)`` (where `${payload}` = the serialized `{args, result}` content — same input that `maskAndCap` processes for `payload_json` storage; the outer `maskAndCap` call here applies masking to the full embed string, so secrets never reach `event_vec`) via `await pipe(text,{pooling:'mean',normalize:true})` → `Float32Array(384)`. **INV-OM4:** set `env.allowRemoteModels=false; env.localModelPath` (pinned abs path) at module load. **Warm-load the pipeline from `env.localModelPath` BEFORE any network mock installs** so the egress test is deterministic. Compute embedding **before** opening the transaction (better-sqlite3 is sync).
- **Integration points (each wired & exercised):** pi-mono `ExtensionAPI.on` subscribing `ToolExecutionStartEvent` + `ToolExecutionEndEvent` (symbols in `pi-mono/packages/coding-agent/src/core/extensions/types.ts`); `ExtensionContext` for `cwd`/`sessionManager`/`model` threading source (no LLM call); P2.1 store `db.transaction(fn)` writing `events` + `event_vec`; **start/end buffer keyed by `toolCallId`** with **TTL eviction** (`capture.bufferStartTtlMs`, default 1h, lazy-on-access) (above).
- **Threading source (§5.2):** `run_id`/`agent_id`/`agent_role`/`skill`/`skill_version`/`prompt_id`/`prompt_version` resolved from a capture-session context (env/`ctx.sessionManager`); `parent_event_id` = the enclosing turn/node event for the current `turnIndex` (NOT "most recent open"). `run_id` MUST be non-null — when no active run, synthesize `run_id='orphan:<sessionId>'` + a matching `runs` row via the **orphan helper in `src/capture/threading.ts`** (reused by P2.5/P2.6), then write (INV-OM2, R1).
- **Guards/limits:** one event + one vec per `ToolExecutionEndEvent`, atomic (`db.transaction`); embedding computed pre-tx; p99 < 5 ms over 1000 calls; payloads ≤ 64 KB masked; `maskAndCap` never throws; no network egress at any point in the handler; **start/end buffer is bounded by TTL eviction** (`capture.bufferStartTtlMs`, default 1h, lazy-on-access) — orphaned start entries whose END never arrives within the TTL are evicted, never leak, and a late END post-eviction still writes exactly one row via the missing-start fallback.

## Files to Modify

> ≤10 unique paths, one per line.
- `src/capture/pi-tool-call-extension.ts`
- `src/capture/mask-and-cap.ts`
- `src/capture/embed.ts`
- `src/capture/threading.ts`
- `tests/capture/pi-tool-call-extension.test.ts`
- `tests/capture/mask-and-cap.test.ts`
- `tests/capture/embed-determinism.test.ts`
- `tests/capture/secret-corpus.json`

## Security Invariants

> Concrete named invariants only — N/A NOT permitted when triggered.

- **INV-OM1:** Zero per-event LLM/HTTP — the `ToolExecutionEndEvent` handler performs no network egress; capture is mechanical. Asserted by a network mock that throws on any outbound socket. The handler **never throws into the pi-mono event loop** (`maskAndCap` is total).
- **INV-OM2:** non-null `run_id` referencing a real `runs` row on every `events` row written by this adapter; lifecycle events use `experiment:<id>` runs, orphan-context capture uses `orphan:<session>` runs — never NULL, never a silent drop. Enforced before write (orphan helper synthesizes the `runs` row).
- **INV-OM3:** `payload_json`/`result_json`/`error` ≤ 64 KB (inclusive of the `…[truncated]` marker) and secret-pattern-masked via the shared `maskAndCap` util before write; the **same masked text** is the embed input, so no secret reaches `event_vec`.
- **INV-OM4:** ONNX model loaded from a pinned local path only (`env.allowRemoteModels=false`, `env.localModelPath` set) — no remote fetch; deterministic `dtype:'fp32'` 384-dim vectors.

## Definition of Done

> 8–10 high-signal, story-specific boxes. No CI filler.

- [ ] **Impl:** `ExtensionAPI.on` adapter maps `ToolExecutionEndEvent` → one `events` (`event_type='tool_call'`) + one `event_vec` row in a single `db.transaction`, embedding computed before the tx.
- [ ] **Impl (start/end join, R16):** `ToolExecutionStartEvent` args+start-ts buffered by `toolCallId`, joined on end → `payload_json` (args+result) + `duration_ms` populated (else `payload_json` would be undefined); `parent_event_id` = enclosing turn/node for the `turnIndex`.
- [ ] **Impl (GAP #4 / R7):** shared `maskAndCap` at `src/capture/mask-and-cap.ts` — circular/BigInt-safe + sentinel-on-failure (TOTAL, never throws), mask→cap with marker-reserved ≤65536 cap, driven by `tests/capture/secret-corpus.json`; exported for P2.4–P2.6; masks `payload_json`/`result_json`/`error` AND the embed input.
- [ ] **Impl (orphan, R1):** orphan helper in `threading.ts` synthesizes `run_id='orphan:<sessionId>'` + matching `runs` row on no-active-run; event written, never null/dropped; reused by P2.5/P2.6.
- [ ] **Contract:** every written row threaded per §5.2 (`run_id`, `agent_id`, `skill`, `prompt_id`, `prompt_version`, `parent_event_id`) against the P2.1 `events`/`event_vec` schema.
- [ ] **Integration:** adapter exercised end-to-end against the real P2.1 store; query by `run_id` returns the written `tool_call` row + its `event_vec` companion.
- [ ] **Security (INV-OM1):** zero LLM/HTTP egress — network mock asserts zero outbound calls; handler never throws into the pi-mono event loop.
- [ ] **Security (INV-OM3):** secret `sk-test...` corpus → absent from BOTH `payload_json`/`result_json`/`error` AND the embed-input text (spy on embed input); byte-length ≤ 65536 incl. marker (INV-OM2 orphan/non-null + INV-OM4 local-only `fp32` 384-dim also asserted).
- [ ] **Test (unit):** `maskAndCap` masks each secret class + caps with marker reserved + returns sentinel on circular/BigInt input; `embedText` bytewise-identical 384-dim on repeat; 2-tool-call turn → both rows share the `turnIndex` parent; `isError=true` → `outcome='failure'` with masked error; **buffer TTL eviction (R16)** — a `ToolExecutionStartEvent` with no matching END, advanced past `capture.bufferStartTtlMs` (default 1h, faked clock), is evicted on the next buffer access so buffer size returns to 0 (no leak), and a `ToolExecutionEndEvent` arriving post-eviction still writes exactly one row via the missing-start fallback (`payload_json:maskAndCap({result})`, `duration_ms:null`).
- [ ] **Test (e2e demo — MANDATORY):** with pipeline warm-loaded then network mock active, dispatch 1000 `ToolExecutionEndEvent`s → assert 1000 `events` + 1000 `event_vec` rows, zero outbound calls, and p99 < 5 ms.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
