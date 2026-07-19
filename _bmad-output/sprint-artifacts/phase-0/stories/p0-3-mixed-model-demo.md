# P0.3: CLI-Anything 3-Agent Mixed-Model Merged-JSON Demo via Warren

**Story Points:** 4

## Spec Reference

- PRD §4.1 (multi-model orchestration), §4.6 (launcher contract); FR-EX-3, FR-EX-6
- Phase exit gate: PRD §13 Phase-0 clause 3 (mixed-model team produces merged output)

## User Story

As a SwarmClaw protocol operator,
I want the CLI-Anything harness to launch a 3-agent Warren team across Anthropic + OpenRouter providers, exchange coms messages, and produce a single merged JSON result on stdout,
so that protocol steps can dispatch real multi-model work and receive structured output (FR-EX-3, FR-EX-6, G1).

## Overview

This is the pivotal Phase-0 demo: a CLI-Anything manifest launches a 3-agent Warren team (Lead via Anthropic, two workers via OpenRouter), agents exchange ≥2 coms messages, the Lead merges worker outputs into a single structured JSON, and the harness writes it to stdout. Bypasses the CLI-Anything abstraction layer by invoking Warren directly, and exercises the Pi execution layer and coms. 4 pts because it integrates three providers (Anthropic, OpenRouter routing, Warren sandbox) and proves the merged-output contract end-to-end.

## E2E Slice

**Demonstrable behavior:** A CLI-Anything manifest for a 3-agent "Research-Trio" archetype launches `warren run --config .canopy/agent.json` with role-model configs for `lead=anthropic/claude-sonnet-4-6` (illustrative), `worker-a=openrouter/glm-4` (illustrative), `worker-b=openrouter/deepseek-chat` (illustrative). Model identifiers are illustrative; implementations should substitute current models at dev time. Coms shows ≥2 messages exchanged between agents. The merged JSON on stdout contains a `result` field, `partial: false`, `changedFiles: []`, and `exitStatus: "success"`.

**Wiring closed:** On completion of this story, running `cli-anything run --manifest research-trio.yaml` produces a single merged JSON object on stdout with `partial: false` and structured results from ≥2 distinct model providers, using only code merged by this story plus the coms vendor from P0.2 and the harness skeleton from P0.1. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P0.1 (harness skeleton + env propagation), P0.2 (coms vendor + arch decision).

## Acceptance Criteria

1. **(make-or-break)** Given the research-trio manifest with mixed-model role configs, When `cli-anything run --manifest research-trio.yaml` executes, Then stdout contains valid JSON with `partial: false` and results from ≥2 distinct models (Anthropic + OpenRouter). "Providers" refers to model instances, not API providers.
2. Given the 3-agent team running, When coms messages are exchanged, Then ≥2 structured messages are observable in the coms log (lead↔worker communication proven).
3. Given a worker that returns no output within the await timeout, When the lead collects results, Then the merged output has `partial: true` and the missing worker is logged with reason `"timeout"`.
4. **(budget-poll race, P0.3-S-H4)** Given a worker making multiple LLM API calls, When the harness polls `CostEvent` AFTER each turn (one complete LLM API call), Then the kill threshold is enforced synchronously between dispatches, and in-flight requests are killed via `killChildTree` within the 5 s grace — cumulative cost cannot overshoot the threshold by more than one in-flight turn.
5. **(boundary race, P0.3-S-H5)** Given a worker response and a `coms_await` timer that race, When both fire near-simultaneously, Then the outcome is deterministic via single-settle on `pending.result` — if the response is received BEFORE the timer fires, `partial:false`; if the timer fires first, `partial:true`. There is no 100 ms wall-clock window; determinism comes from the atomic single-settle, not timing proximity. A test MUST simulate simultaneous response-POST + timeout-fire and assert no double-emit.
6. **(coms-init transient, P0.3-S-L2)** Given coms init fails (no server URL, or 401/403/404 terminal), When the harness runs, Then `exitStatus:"transient"` with `error.reason:"transient"` and `agentOutputs:{}` (no partial output).

## Technical Notes

- **Contracts/Schema:** Merged output schema: `{ result: Record<string,unknown>, changedFiles: string[], partial: boolean, exitStatus: "success"|"transient"|"overflow"|"logic"|"lead_failure", durationMs: number, waivers: Waiver[], agentOutputs: Record<string,unknown>, comsLog: ComsLogEntry[], error?: { reason: "overflow"|"transient"|"logic"|"lead_failure", message: string, details?: Record<string,unknown> } }`. A waiver is a structured override: `{ type: 'budget_override' | 'model_fallback', reason: string, approvedBy: string }`. Waivers are logged but not enforced in Phase 1. Worker response_schema mandatory field: `changedFiles: string[]`. Lead computes set-union before emit. ComsLogEntry fields are camelCase on stdout; coms-net.ts internal wire format must serialize to camelCase at the harness boundary.
- **changedFiles merger contract (P0.3-S-H6):** Worker `changedFiles` is peer-controlled and parse-only-validated (`response_schema` is parse-only per P0.2 §5.2). The lead MUST sanitize each entry (`sanitizePeerText`, `coms-core.ts`), cap total `changedFiles` size at 32 KB (parity with `MAX_RESPONSE_SCHEMA_BYTES`), dedupe before set-union, and reject entries that are not safe path components (or document a looser policy). A worker that omits `changedFiles` = node failure (CORRECTNESS-C).
- **JSON contract uniformity (P0.3-M2):** The merged-JSON result has exactly 5 exit paths, and EACH must populate the full schema (no path-dependent absent fields):
  1. **success** — `exitStatus:"success"`, `partial:false`, `error:null` (explicit), `agentOutputs` populated.
  2. **transient** — `exitStatus:"transient"`, `error:{reason:"transient", message, details?}`, `agentOutputs:{}` on coms-init failure OR populated on partial-response-timeout.
  3. **overflow** — `exitStatus:"overflow"`, `error:{reason:"overflow", ...}`, `agentOutputs` populated with whatever the lead collected.
  4. **logic** — `exitStatus:"logic"`, `error:{reason:"logic", ...}` (application non-zero exit per `classifyExit`).
  5. **lead_failure** — `exitStatus:"lead_failure"`, `error:{reason:"lead_failure", ...}`, `agentOutputs:{}` (never absent), worker partial outputs in `artifacts/`.

  `error:{reason,message}` is mandatory on every non-success path; `error:null` is explicit on success. `agentOutputs` is `{}` on lead_failure, never absent. Every path emits the same field set.
- **Integration points (each wired & exercised in this story):** CLI-Anything manifest → `warren run --config .canopy/agent.json` → Pi subprocess spawning with role config loaded from manifest (cname derived from manifest agentId) → coms exchange via `coms-net.ts` (extensions/coms-net.ts) → lead merges → harness captures stdout. P0.2 defines `coms_net_*` functions (the transport layer); P0.3 uses `coms_*` shorthand (the consumer-facing API) which is sugar over `coms_net_*` with harness-specific defaults. Both `coms_*` and `coms_net_*` share the parity layer `pi-vs-claude-code-vendor/coms-core.ts` (introduced P0.2, hardened PR #29), which owns caps, secret-equality, path-component checks, and ULID. P0.3 is strictly a consumer of `coms-core.ts` and MUST source caps / secret-equality / path-component checks / ULID from there — it must NOT re-implement any of these. The `coms_*` sugar maps onto `coms_net_*` as: `coms_send(target, prompt)` → `coms_net_send(channel, {target, prompt})`, `coms_await(msg_id, timeout)` → `coms_net_await(channel, timeout)`. The channel is derived from the lead/worker assignment.

### Wave 1 Reuse Mandate

This story extends `cli-anything/src/runner.ts` (hardened in P0.1, PR #28 rounds 1–4 + PR #33) and consumes coms (P0.2, hardened in PR #29). The following hardened primitives MUST be reused, not reimplemented:
- **Process-tree kill:** `killChildTree` (POSIX process-group `SIGKILL` + direct-child fallback), `armWatchdog` (unref'd 5 s grandchild stdout-hold), signal handlers installed BEFORE `spawn`, `SIGHUP` reaps the detached tree. Budget-kill and lead-failure worker termination MUST use these.
- **Secret redaction:** `redactSecrets` (longest-first single-pass regex alternation) + `redactBoundaryPrefix` (KMP prefix-suffix; re-applied after the final cap). Applied to merged output, coms log, and error details.
- **Exit classification:** `classifyExit(timedOut, code, signal)` precedence — budget-overflow kill → `overflow` regardless of signal; non-budget signal kill → `transient`; application non-zero exit → `logic`.
- **Coms parity layer:** `pi-vs-claude-code-vendor/coms-core.ts` (shared by `coms.ts` + `coms-net.ts`) owns caps, secret-equality, path-component checks, ULID. P0.3 must NOT re-implement any of these.

### Budget Enforcement

Per-team shared pool: $0.50 total (per INV-2).

1. Harness polls `CostEvent` entries from Warren output AFTER each turn (one complete LLM API call). The kill threshold is enforced synchronously between dispatches; in-flight requests are killed via `killChildTree` within the 5 s grace.
2. Kill threshold at 90% of cap ($0.45). Once cumulative cost reaches this threshold, no new agent turns are dispatched. A turn is one complete LLM API call (request + response) by an agent. Multi-step agent reasoning that involves multiple API calls counts as multiple turns.
3. In-flight requests at kill time receive a 5-second grace period to complete before forced termination via the hardened `killChildTree` contract (CC-R8-8 + Wave 1 Reuse Mandate): process-group `SIGKILL` (NOT SIGTERM→SIGKILL), `armWatchdog` unref'd 5 s for grandchild stdout-hold, signal handlers installed BEFORE `spawn`, `SIGHUP` reaps the detached tree.
4. If budget is exceeded despite the kill threshold, merged output includes `exitStatus: "overflow"` with an error payload containing `reason: "overflow"`. Exit classification uses `classifyExit(timedOut, code, signal)` precedence (P0.3-S-M3): budget-overflow kill → `overflow` regardless of signal.

### Phase-to-Extension Mapping (post-pivot)

| Phase kind       | Extension file                |
|------------------|-------------------------------|
| dispatch_task    | extensions/agent-team.ts      |
| parallel         | extensions/pi-pi.ts           |
| compare / decide | extensions/coms-net.ts        |
| sequential       | extensions/agent-chain.ts     |
| cross-agent      | extensions/cross-agent.ts     |
| summarize        | extensions/cross-agent.ts     |

> The `cross-agent` phase was renamed to `summarize` in P1.4. Both names refer to the same extension. Implementations should use `summarize` as the canonical phase name.

Coms mechanism: `coms-net.ts` (`extensions/coms-net.ts`), invoked by Warren when phase kind requires inter-agent communication.
API: `coms_net_send`, `coms_net_await`, `coms_net_get`, `coms_net_list`

- **Files / functions touched:** `cli-anything/src/runner.ts` (team spawning), `cli-anything/src/merger.ts` (lead output merge), `cli-anything/src/coms-log.ts` (coms capture), `cli-anything/manifests/research-trio.yaml` (demo manifest).
- **Guards/limits:** Budget cap per team (default $0.50), turn cap (default 5/agent), wall-clock cap (default 5 min). `PI_COMS_TIMEOUT_MS = 240000` (4 min, Trio override via env per OQ-16b). Wall-clock cap is 5 min per INV-2. Wall-clock wins → step terminated with `exitStatus:"overflow"` via `classifyExit`. The `coms_await` timeout is a per-message wait within the coms layer; the wall-clock budget (5 min per INV-2) is the overall step limit — if wall-clock expires before `coms_await` returns, the wall-clock wins. Note (P0.3-M1 corrected): P0.2's `AWAIT_TIMEOUT_MS` 45 s→150 s / `SPAWN_TIMEOUT_MS` 90 s→240 s changes (PR #29 round 5) were SMOKE-SCRIPT budgets, not coms defaults; `coms.ts` `TIMEOUT_MS` default remains 1,800,000 ms (30 min). Guard default values (model token limits, temperature, max tokens) should be sourced from the PRD normative values table. If the PRD does not specify a value, the harness default should be documented as implementation-chosen with rationale.
- **Coms vendor failure:** This demo requires exactly one coms transport path (subprocess-RPC per OQ-1). Coms initialization failure is a hard failure producing `exitStatus: 'transient'` with no partial output.
- **P0.3-to-P1.6 mapping:** `result` → `summary` (concatenation of agent results), `agentOutputs` → `testResults` (per-agent structured output), `comsLog` → dropped (internal to demo), `changedFiles` → `changedFiles` (1:1). `durationMs` is calculated from wall-clock timing. `mulchPrimed` defaults to false in P0.3 (no Mulch priming in this demo). `error` → `error` (error.reason + error.message concatenated into P1.6's flat error: string field; reason enum is P0.3-internal). `partial` → dropped (P1.6 encodes partial failure as exitStatus: "transient" or "overflow" with error.reason; partial: true in P0.3 maps to non-"success" exitStatus in P1.6, making the field redundant at the P1.6 layer).
- **Lead agent failure:** If the lead agent process exits before producing merged output, the demo returns `exitStatus: 'lead_failure'` and emits the full merged-output schema per path 5 (`agentOutputs:{}`, `changedFiles:[]`, `comsLog`, `durationMs`, `error:{reason:"lead_failure", message}`), with all partial worker outputs preserved in `artifacts/`. `classifyExit` does NOT classify lead failure. The harness detects lead failure when the lead process exits with any non-success classification while it still holds unmerged worker outputs (i.e., before merged-JSON emit). In that case `exitStatus:"lead_failure"` is emitted regardless of whether `classifyExit` would have returned `transient` (signal) or `logic` (app non-zero). The `transient`/`logic` classification is recorded in error details but does not determine the top-level `exitStatus`. Worker partial outputs are preserved in `artifacts/`. Worker processes are terminated via the hardened `killChildTree` contract (CC-R8-8 + Wave 1 Reuse Mandate): process-group `SIGKILL` (NOT SIGTERM→SIGKILL), `armWatchdog` unref'd 5 s for grandchild stdout-hold, signal handlers installed BEFORE `spawn`, `SIGHUP` reaps the detached tree. The P0.3→P1.6 mapping note (above) documents that P0.3's structured `error:{reason,message}` flattens to P1.6's flat `error: string` at the P1.6 boundary; that is the only place the flat P1.6 shape belongs.
- **Artifact atomic write (P0.3-S-M4):** Workers write partial outputs atomically (tmpfile + rename, mirroring `coms.ts` `writeRegistryAtomic`). The harness reads `artifacts/` AFTER `killChildTree` + watchdog settle; corrupt/empty files are logged and skipped, never merged.
- **Waiver semantics (P0.3-S-M5):** Waivers are audit-only metadata in Phase 0; they do NOT relax INV-2 budget enforcement. A `budget_override` waiver is recorded in `waivers[]` AND the harness still kills at the 90 % threshold — the waiver documents intent, not permission.
- **durationMs (P0.3-S-L1):** `durationMs` = wall-clock from first worker spawn to merged-JSON emit; excludes harness boot/parse.

## Files to Modify

- `cli-anything/src/runner.ts`
- `cli-anything/src/merger.ts`
- `cli-anything/src/coms-log.ts`
- `cli-anything/manifests/research-trio.yaml`
- `cli-anything/test/merger.test.ts`
- `cli-anything/test/runner-integration.test.ts`
- `cli-anything/src/types.ts`

## Security Invariants

- **INV-1:** API keys (Anthropic, OpenRouter) supplied via env vars, never hardcoded in manifest or logged. Harness logs key presence (`ANTHROPIC_API_KEY: set`) not values.
- **INV-2:** Budget cap enforced by harness process (owns spawn/kill) — never delegated to agents. Exceeding cap produces non-zero exit with `exitStatus: "overflow"`.
- **INV-3 (merger redaction, CC-W4):** No secret values in merged JSON, coms log, or error details. The merger applies `redactSecrets` (longest-first single-pass regex alternation) and `redactBoundaryPrefix` (KMP prefix-suffix) from P0.1 `runner.ts` to `agentOutputs` JSON before emit, to each `comsLog` entry's payload fields, and to `error.details`; the cap is re-applied after redaction; the redaction flag survives any `JSON.stringify` round-trip.

## Definition of Done

- [ ] **Impl:** CLI-Anything runner spawns 3 Pi agents via Warren with mixed-model role configs (loaded from manifest), cname derived from manifest agentId.
- [ ] **Impl:** Lead merger collects worker outputs, validates `changedFiles` field, computes set-union, produces merged JSON on stdout.
- [ ] **Contract:** Merged output schema (result, changedFiles, partial, exitStatus, durationMs, waivers, agentOutputs, comsLog) with field-level validation.
- [ ] **Contract:** Worker response_schema mandatory `changedFiles: string[]` enforced by lead; omission = node failure (CORRECTNESS-C).
- [ ] **Integration:** Coms exchange between agents observable (≥2 messages); structured JSON stdout produced by harness.
- [ ] **Observability:** Coms log captured as part of merged output (agent names, message counts, timing).
- [ ] **Security:** Budget cap enforced by harness; non-zero exit on cap breach; API keys from env only.
- [ ] **Test (unit):** Merger validates well-formed worker outputs and rejects missing `changedFiles`; partial-result path tested.
- [ ] **Test (integration):** 3-agent manifest launches with mocked model responses; merged output schema valid.
- [ ] **Test (e2e demo — MANDATORY):** Live `cli-anything run --manifest research-trio.yaml` produces merged JSON with `partial: false` and ≥2 provider results; coms log shows ≥2 messages exchanged.
- [ ] **Test (race condition, P0.3-S-H5):** Worker that completes at `coms_await` timeout boundary produces deterministic result — neither dropped nor duplicated. Determinism comes from atomic single-settle on `pending.result`, not a 100 ms wall-clock window: response BEFORE timer → `partial:false`; timer first → `partial:true`. A test MUST simulate simultaneous response-POST + timeout-fire and assert no double-emit.
- [ ] **Test (lead failure artifacts):** Lead agent failure → verify worker partial outputs are written to `artifacts/` directory with one file per worker.

## Cross-Cutting Conventions

**CC-1 — exitStatus taxonomy:** Post-pivot taxonomy: `exitStatus` uses 5-value enum (`"success"|"transient"|"overflow"|"logic"|"lead_failure"`). PRD §4.6 `exit_class` is failure-only (`transient|overflow|logic`); post-pivot adds `success` for normal completion and `lead_failure` for the lead-failure path (P0.3 path 5). All stories must use `exitStatus`.

**CC-1 exitStatus precedence (P0.3-S-M3):** `classifyExit(timedOut, code, signal)` resolves the final status in this order:
1. budget-overflow kill → `overflow` regardless of signal;
2. non-budget signal kill → `transient`;
3. application non-zero exit → `logic`.

Cite `classifyExit` (Wave 1 Reuse Mandate).

| Signal / trigger | exitStatus |
|------------------|------------|
| SIGTERM (from watchdog/parent) | `transient` |
| SIGSEGV / SIGBUS (crash) | `transient` |
| SIGKILL (forced termination) | `transient` |
| Any other signal | `transient` |
| Lead agent process exits (any non-success classification) before producing merged-JSON output | `lead_failure` |

All signal-terminated processes map to `transient` for consistency, regardless of the specific signal type. `lead_failure` is emitted by the harness when the lead process exits pre-emit (see "Lead agent failure" note).

> **`classifyExit` is NOT consulted for lead failure.** The harness detects lead failure pre-emit (lead holds unmerged worker outputs) and emits `lead_failure`, overriding whatever `classifyExit` would have returned (`transient` for a signal, `logic` for app non-zero). The `transient`/`logic` classification is recorded in error details but does not determine the top-level `exitStatus`.

**CC-2 — Warren CLI surface:** Warren CLI surface is manifest-driven per pivot architecture. Role, cname, task params are defined in `.canopy/agent.json`. Canonical Warren invocation: `warren run --config .canopy/agent.json`, not individual CLI flags like `--role-model`.

**CC-4 — Field name convention:** `changedFiles` (not `filesChanged` or `changed_files`). All stories producing file-change output use this field name.

### Observability Contract (CC-9)

- Every operation logs: `{requestId, operation, timestamp, duration, status}`
- requestId propagates across layer boundaries
- Errors include: `{code, message, stack?: string}`
- Coms log schema: `ComsLogEntry: { requestId: string, sessionId: string, phaseId: string, channel: string, direction: "send"|"receive", senderAgent: string, receiverAgent: string, payloadSize: number, durationMs: number, timestamp: string }`
- Cost events: `CostEvent: { agentId: string, model: string, inputTokens: number, outputTokens: number, costUsd: number, durationMs: number, timestamp: string }`

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
