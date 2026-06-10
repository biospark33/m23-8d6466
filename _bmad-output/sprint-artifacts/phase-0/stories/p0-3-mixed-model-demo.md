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

This is the pivotal Phase-0 demo: a CLI-Anything manifest launches a 3-agent Warren team (Lead via Anthropic, two workers via OpenRouter), agents exchange ≥2 coms messages, the Lead merges worker outputs into a single structured JSON, and the harness writes it to stdout. Cuts CLI-Anything layer + Pi execution layer + coms. 4 pts because it integrates three providers (Anthropic, OpenRouter routing, Warren sandbox) and proves the merged-output contract end-to-end.

## E2E Slice

**Demonstrable behavior:** A CLI-Anything manifest for a 3-agent "Research-Trio" archetype launches `warren run --config .canopy/agent.json` with role-model configs for `lead=anthropic/claude-sonnet-4-6`, `worker-a=openrouter/glm-4`, `worker-b=openrouter/deepseek-chat`. Coms shows ≥2 messages exchanged between agents. The merged JSON on stdout contains a `result` field, `partial: false`, `changedFiles: []`, and `exitStatus: "success"`.

**Wiring closed:** On completion of this story, running `cli-anything run --manifest research-trio.yaml` produces a single merged JSON object on stdout with `partial: false` and structured results from ≥2 distinct model providers, using only code merged by this story plus the coms vendor from P0.2 and the harness skeleton from P0.1. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P0.1 (harness skeleton + env propagation), P0.2 (coms vendor + arch decision).

## Acceptance Criteria

1. **(make-or-break)** Given the research-trio manifest with mixed-model role configs, When `cli-anything run --manifest research-trio.yaml` executes, Then stdout contains valid JSON with `partial: false` and results from ≥2 distinct model providers (Anthropic + OpenRouter).
2. Given the 3-agent team running, When coms messages are exchanged, Then ≥2 structured messages are observable in the coms log (lead↔worker communication proven).
3. Given a worker that returns no output within the await timeout, When the lead collects results, Then the merged output has `partial: true` and the missing worker is logged with reason `"timeout"`.

## Technical Notes

- **Contracts/Schema:** Merged output schema: `{ result: Record<string,unknown>, changedFiles: string[], partial: boolean, exitStatus: "success"|"transient"|"overflow"|"logic", waivers: Waiver[], agentOutputs: Record<string,unknown>, comsLog: ComsEntry[] }`. Worker response_schema mandatory field: `changedFiles: string[]`. Lead computes set-union before emit.
- **Integration points (each wired & exercised in this story):** CLI-Anything manifest → `warren run --config .canopy/agent.json` → Pi subprocess spawning with `--cname <run-id>-<role>` → coms exchange via `coms-net.ts` (extensions/coms-net.ts) → lead merges → harness captures stdout.

### Phase-to-Extension Mapping (post-pivot)

| Phase kind       | Extension file                |
|------------------|-------------------------------|
| dispatch_task    | extensions/agent-team.ts      |
| parallel         | extensions/pi-pi.ts           |
| compare / decide | extensions/coms-net.ts        |
| sequential       | extensions/agent-chain.ts     |
| cross-agent      | extensions/cross-agent.ts     |

Coms mechanism: `coms-net.ts` (`extensions/coms-net.ts`), invoked by Warren when phase kind requires inter-agent communication.
API: `coms_net_send`, `coms_net_await`, `coms_net_get`, `coms_net_list`

- **Files / functions touched:** `cli-anything/src/runner.ts` (team spawning), `cli-anything/src/merger.ts` (lead output merge), `cli-anything/src/coms-log.ts` (coms capture), `cli-anything/manifests/research-trio.yaml` (demo manifest).
- **Guards/limits:** Budget cap per team (default $0.50), turn cap (default 5/agent), wall-clock cap (default 5 min). `coms_await` timeout per P0.2 decision (8 min for Trio archetype, OQ-16b).

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

- [ ] **Impl:** CLI-Anything runner spawns 3 Pi agents via Warren with mixed-model role configs (loaded from manifest), each named `--cname <run-id>-<role>`.
- [ ] **Impl:** Lead merger collects worker outputs, validates `changedFiles` field, computes set-union, produces merged JSON on stdout.
- [ ] **Contract:** Merged output schema (result, changedFiles, partial, exitStatus, waivers, agentOutputs, comsLog) with field-level validation.
- [ ] **Contract:** Worker response_schema mandatory `changedFiles: string[]` enforced by lead; omission = node failure (CORRECTNESS-C).
- [ ] **Integration:** Coms exchange between agents observable (≥2 messages); structured JSON stdout produced by harness.
- [ ] **Observability:** Coms log captured as part of merged output (agent names, message counts, timing).
- [ ] **Security:** Budget cap enforced by harness; non-zero exit on cap breach; API keys from env only.
- [ ] **Test (unit):** Merger validates well-formed worker outputs and rejects missing `changedFiles`; partial-result path tested.
- [ ] **Test (integration):** 3-agent manifest launches with mocked model responses; merged output schema valid.
- [ ] **Test (e2e demo — MANDATORY):** Live `cli-anything run --manifest research-trio.yaml` produces merged JSON with `partial: false` and ≥2 provider results; coms log shows ≥2 messages exchanged.
- [ ] **Test (race condition):** Worker that completes at `coms_await` timeout boundary produces deterministic result — neither dropped nor duplicated.

## Cross-Cutting Conventions

**CC-1 — exitStatus taxonomy:** Post-pivot taxonomy: `exitStatus` uses 4-value enum (`"success"|"transient"|"overflow"|"logic"`). PRD §4.6 `exit_class` is failure-only (`transient|overflow|logic`); post-pivot adds `success` for normal completion. All stories must use `exitStatus`.

**CC-2 — Warren CLI surface:** Warren CLI surface is manifest-driven per pivot architecture. Role, cname, task params are defined in `.canopy/agent.json`. Canonical Warren invocation: `warren run --config .canopy/agent.json`, not individual CLI flags like `--role-model`.

**CC-4 — Field name convention:** `changedFiles` (not `filesChanged` or `changed_files`). All stories producing file-change output use this field name.

### Observability Contract (CC-9)

- Every operation logs: `{requestId, operation, timestamp, duration, status}`
- requestId propagates across layer boundaries
- Errors include: `{code, message, stack?: string}`
- Coms log schema: `ComsLogEntry: { requestId: string, channel: string, direction: "send"|"receive", senderAgent: string, receiverAgent: string, payload_size: number, duration_ms: number, timestamp: string }`
- Cost events: `CostEvent: { agentId: string, model: string, inputTokens: number, outputTokens: number, costUsd: number, duration_ms: number }`

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
