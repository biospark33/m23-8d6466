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

## Technical Notes

- **Contracts/Schema:** Merged output schema: `{ result: Record<string,unknown>, changedFiles: string[], partial: boolean, exitStatus: "success"|"transient"|"overflow"|"logic", durationMs: number, waivers: Waiver[], agentOutputs: Record<string,unknown>, comsLog: ComsLogEntry[], error?: { reason: "overflow"|"timeout"|"lead_failure", message: string, details?: Record<string,unknown> } }`. A waiver is a structured override: `{ type: 'budget_override' | 'model_fallback', reason: string, approvedBy: string }`. Waivers are logged but not enforced in Phase 1. Worker response_schema mandatory field: `changedFiles: string[]`. Lead computes set-union before emit. ComsLogEntry fields are camelCase on stdout; coms-net.ts internal wire format must serialize to camelCase at the harness boundary.
- **Integration points (each wired & exercised in this story):** CLI-Anything manifest → `warren run --config .canopy/agent.json` → Pi subprocess spawning with role config loaded from manifest (cname derived from manifest agentId) → coms exchange via `coms-net.ts` (extensions/coms-net.ts) → lead merges → harness captures stdout. P0.2 defines `coms_net_*` functions (the transport layer). P0.3 uses `coms_*` shorthand (the consumer-facing API). `coms_*` is sugar over `coms_net_*` with harness-specific defaults. The naming gap is intentional — P0.3 is a consumer, P0.2 is the provider. P0.3's `coms_*` sugar maps to P1.4's `coms_net_*`: `coms_send(target, prompt)` → `coms_net_send(channel, {target, prompt})`, `coms_await(msg_id, timeout)` → `coms_net_await(channel, timeout)`. The channel is derived from the lead/worker assignment.

### Budget Enforcement

Per-team shared pool: $0.50 total (per INV-2).

1. Harness polls `CostEvent` entries from Warren output after each step.
2. Kill threshold at 90% of cap ($0.45). Once cumulative cost reaches this threshold, no new agent turns are dispatched. A turn is one complete LLM API call (request + response) by an agent. Multi-step agent reasoning that involves multiple API calls counts as multiple turns.
3. In-flight requests receive a 5-second grace period to complete before forced termination (SIGTERM then SIGKILL).
4. If budget is exceeded despite the kill threshold, merged output includes `exitStatus: "overflow"` with an error payload containing `reason: "overflow"`.

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
- **Guards/limits:** Budget cap per team (default $0.50), turn cap (default 5/agent), wall-clock cap (default 5 min). `coms_await` timeout per P0.2 decision (4 min for Trio archetype, OQ-16b; lowered from 8 min to sit below wall-clock cap). The 8-minute coms_await timeout is a Trio-archetype-specific override (OQ-16b). P0.2's default is 30 minutes. The archetype configuration sets `PI_COMS_TIMEOUT_MS = 240000` (4 min) for Trio mode. Lowered from the original 480000 (8 min) to sit below the wall-clock cap (5 min per INV-2) so that coms_await timeout fires first, giving the lead agent a chance to produce `partial: true` output with whichever workers responded, rather than being hard-killed by the wall-clock. The `coms_await` timeout is a per-message wait within the coms layer. The wall-clock budget (5 min per INV-2) is the overall step limit. If wall-clock expires before coms_await returns, the wall-clock wins and the step is terminated with `exitStatus: 'overflow'`. Guard default values (model token limits, temperature, max tokens) should be sourced from the PRD normative values table. If the PRD does not specify a value, the harness default should be documented as implementation-chosen with rationale.
- **Coms vendor failure:** This demo requires exactly one coms transport path (subprocess-RPC per OQ-1). Coms initialization failure is a hard failure producing `exitStatus: 'transient'` with no partial output.
- **P0.3-to-P1.6 mapping:** `result` → `summary` (concatenation of agent results), `agentOutputs` → `testResults` (per-agent structured output), `comsLog` → dropped (internal to demo), `changedFiles` → `changedFiles` (1:1). `durationMs` is calculated from wall-clock timing. `mulchPrimed` defaults to false in P0.3 (no Mulch priming in this demo). `error` → `error` (error.reason + error.message concatenated into P1.6's flat error: string field; reason enum is P0.3-internal). `partial` → dropped (P1.6 encodes partial failure as exitStatus: "transient" or "overflow" with error.reason; partial: true in P0.3 maps to non-"success" exitStatus in P1.6, making the field redundant at the P1.6 layer).
- **Lead agent failure:** If the lead agent process exits with a non-zero code before producing merged output, the demo returns `exitStatus: 'logic'` with no merged output and all partial worker outputs preserved in `artifacts/`. Worker processes are terminated via SIGTERM with 5s grace→SIGKILL escalation per CC-R8-8. Lead failure output follows P1.6's failure schema: `{ exitStatus: "logic", error: string, exitCode: number, partialOutput: string|null, durationMs: number }`. Worker partial outputs are preserved in `artifacts/`. Lead agent non-zero exit code mapping: (1) If the exit was caused by a signal (SIGTERM, SIGKILL, etc.), map to `transient` per CC-1 signal table. (2) If the process exited with a non-zero code (application-level failure), map to `logic`. The harness distinguishes these via Node.js `code` vs `signal` fields on the exit event.

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
- **INV-3:** No secret values in merged JSON output or coms log artifacts.

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
- [ ] **Test (race condition):** Worker that completes at `coms_await` timeout boundary produces deterministic result — neither dropped nor duplicated. If worker output arrives within 100ms of coms_await timeout expiration, the lead treats it as successful arrival (`partial: false`); after that window, it is treated as timeout (`partial: true`).
- [ ] **Test (lead failure artifacts):** Lead agent failure → verify worker partial outputs are written to `artifacts/` directory with one file per worker.

## Cross-Cutting Conventions

**CC-1 — exitStatus taxonomy:** Post-pivot taxonomy: `exitStatus` uses 4-value enum (`"success"|"transient"|"overflow"|"logic"`). PRD §4.6 `exit_class` is failure-only (`transient|overflow|logic`); post-pivot adds `success` for normal completion. All stories must use `exitStatus`.

| Signal | exitStatus |
|--------|------------|
| SIGTERM (from watchdog/parent) | `transient` |
| SIGSEGV / SIGBUS (crash) | `transient` |
| SIGKILL (forced termination) | `transient` |
| Any other signal | `transient` |

All signal-terminated processes map to `transient` for consistency, regardless of the specific signal type.

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
