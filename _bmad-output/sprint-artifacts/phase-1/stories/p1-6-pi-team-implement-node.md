# P1.6: Pi-team Warren run — Mulch-primed lead dispatches nested worker swarm, captures single merged JSON

**Story Points:** 5

## Spec Reference

- PRD §4.6 (launcher contract) + §7; FR-EX-3, FR-EX-6
- Supporting: NFR-OBS-1/OBS-3 (run streams + handoff logged), NFR-COST-1 (≥1 `cost_events` per worker — see P1.13), NFR-SEC-2 (Paperclip bearer + run-scoped header), NFR-SEC-1 (`server.secret.json` 0600)
- Phase exit gate: PRD §13 Phase-1 clause 3 (partial) — "reaches the Pi-team implement step … and emits a single structured JSON result." (The post-edit `lsp_diagnostics` refuse-to-emit gate is the SEPARATE story P1.7; this run captures the merged result.)

## User Story

As QDS dispatch layer,
I want a Warren run to spawn a Mulch-primed lead pi that instructs ≤4 worker pi procs via bash tool, validates each worker's `response_schema` reply, and captures ONE merged JSON object as the run result,
so that one Warren run = one swarm step = one structured result attributed to an issue (G2 worker output merges into the run) rather than free-text or unbounded stdout.

## Overview

This slice cuts QDS dispatch layer → `WarrenClient` (`src/client/client.ts`) → warren run lifecycle (burrow-isolated branch) → lead pi system prompt carrying swarm instructions → lead spawns ≤4 worker pi procs via bash tool → worker NDJSON capture → schema validation + `changed_files` merge → one merged JSON written as run result. The lead pi receives a system prompt carrying: Mulch context (P0.9), pi-lens QA instruction (P0.5), worker model map (`openrouter/google/gemini-2.5-flash` — spike-verified: only model with tool use + cost reporting via openrouter; `gemini-2.0-flash-001` refuses tool use, `gemini-flash-1.5` crashes exit=1), and explicit swarm instructions. `PAPERCLIP_API_KEY` and `PAPERCLIP_RUN_ID` are NEVER embedded in the lead system prompt text — they are passed exclusively via runtime environment variables or tool-invocation context (available to the pi process as env vars, not as prompt content). The lead prompt must not contain any secret or credential string. The prompt-construction code path (`lead-system-prompt.ts`) must explicitly forbid embedding `PAPERCLIP_API_KEY`/`PAPERCLIP_RUN_ID` (or any other credential) in prompt text, enforced by a runtime assertion that scans the assembled prompt for known secret patterns before dispatch (spawn workers via bash tool: `pi --model openrouter/google/gemini-2.5-flash -p --no-session --mode json`). Each worker emits NDJSON; the lead captures each worker's NDJSON stdout, extracts `turn_end.message.usage.cost.total` (cost envelope P1.13 consumes), validates against `response_schema`, computes `changed_files` set-union, and writes ONE merged JSON object. Warren captures the lead result via `streamRunEvents`; QDS calls `waitForRun` and reads the merged object. One atomic unit: the swarm result is not real until warren dispatches, the lead spawns workers, workers run, lead validates + merges, and the cost envelope is written — splitting any of these leaves unbounded or unattributed work.

## E2E Slice

**Demonstrable behavior:** QDS calls `WarrenClient.dispatch({...})` for a sample issue; warren launches a lead pi with a Mulch-primed system prompt; the lead spawns 2 worker pi procs via bash tool (`pi --model openrouter/google/gemini-2.5-flash -p --no-session --mode json`); workers execute against the branch and return NDJSON; lead validates worker replies against `response_schema`, computes `changed_files` set-union, and writes ONE JSON object: `{ changed_files: string[], result: {...}, partial: boolean, exit_class: "transient"|"overflow"|"logic"|null, waivers: [...] }`. `waitForRun` returns status=success; merged object readable via `streamRunEvents`. Per-worker cost data (extracted from each worker's `turn_end.message.usage.cost.total`) is written to the cost envelope for P1.13.

**Wiring closed:** On completion of this story, `WarrenClient.dispatch()` on a primed issue produces one schema-valid merged JSON object (`JSON.parse` succeeds, `changed_files` is `string[]`) from a live Mulch-primed, pi-lens-gated worker swarm, plus a populated cost envelope (per-worker `turn_end.message.usage.cost.total`) — using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P0.3 (spawn/kill logic), P0.5 (pi-lens installed + headless prime/QA surface, warning-count proxy fallback if TUI-only), P0.9 (Mulch prime context available for `--context-path` / `--append-system-prompt`), P1.1 (dev manager registered + authenticated in Paperclip), P1.2 (issue issued by intake — provides `issueId` for cost envelope), P1.3 (seeds decomposed + mirrored — branch ready for workers). The post-edit `lsp_diagnostics` emit gate is the SEPARATE successor story **P1.7**.

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given `WarrenClient.dispatch()` is called for a primed issue with ≥2 workers in the lead system prompt, When the lead pi completes, Then `waitForRun` returns status=success AND the run output is exactly one JSON object for which `JSON.parse(output)` succeeds, `typeof result.changed_files === "object" && Array.isArray(result.changed_files)`, and `result.changed_files.every(f => typeof f === "string")`. (Binary: parse succeeds + `changed_files` is `string[]`.)
2. Given the lead spawns workers via bash tool, When each worker completes (or is SIGKILL'd / crashes mid-run), Then the lead extracts each worker's `turn_end.message.usage.cost.total` from its NDJSON stdout (or the last intermediate NDJSON line with usage data for crash/SIGKILL cases, flagged `estimated:true`) and writes a per-worker cost envelope (keyed by cname + `warrenRunId`) for P1.13 to consume — workers' cost is never silently discarded (warren's own cost capture sees only lead spend, empirically 83% undercount confirmed in spike).
3. Given a worker reply that omits the mandatory `changed_files` field OR fails its `response_schema` validation, When the lead processes it, Then the lead does NOT silently merge it — it re-requests or fails the run as a logic error (`exit_class:"logic"`), never emitting a partial object as if complete.
4. Given a loopy/over-budget worker, When the lead's wall-clock or turn cap is hit, Then the lead SIGKILLs the worker subprocess (P0.3 spawn/kill) and the run exits non-zero (no unbounded blocking, no merged object emitted) — the guard fires, never a silent continue.

## Technical Notes

- **Contracts/Schema (JSON/TS):** Worker `response_schema` MUST carry `changed_files: string[]` (omission ⇒ lead fails the run — CORRECTNESS-C). Merged lead output (stdout) = `{ changed_files: string[] (set-union), result: object, partial: boolean, exit_class: "transient"|"overflow"|"logic"|null, waivers: object[] }`. The lead validates each worker reply (coms `response_schema` is parse-only, r4 §1) and validates the merged object before writing stdout.
- **Warren integration:** QDS calls `WarrenClient.dispatch({ agent: ..., task: ..., branch: ... })` → `waitForRun(runId)` or `streamRunEvents(runId)`. Warren run lifecycle: dispatch → burrow sandbox (seccomp=unconfined, no nproc cap — nesting confirmed in spike) → lead pi process → workers (nested under lead, not warren-native agents) → reap + canopy push + result. **Warren's `costUsd` for the run captures lead spend ONLY (empirically 17% of true spend; 83% invisible in spike) — per-worker cost comes from the cost envelope, not warren's analytics.**
- **Worker model:** `openrouter/google/gemini-2.5-flash` (spike-verified at pi 0.55.0; only openrouter model with tool use + cost reporting confirmed; `gemini-2.0-flash-001` refuses tool use, `gemini-flash-1.5` crashes exit=1).
- **Cost envelope:** lead extracts `turn_end.message.usage.cost.total` from each worker's NDJSON stdout (pi 0.55.0 format, parse path matches `usage-aggregate.ts:90-122`; spike-confirmed shape) and writes `{ cname, model, costTotal, issueId, warrenRunId }` objects to a cost envelope file — consumed by P1.13 to POST `cost_events` rows to Paperclip. **Crash-partial cost extraction:** if a worker is SIGKILL'd (AC-4 cap hit) or crashes before emitting a final `turn_end`, the lead parses the last intermediate NDJSON line carrying usage data (e.g., a partial `turn_end` from a prior turn, or a streaming chunk with `usage`) as a best-effort cost estimate, flagging the entry `estimated:true`. A worker that emitted zero NDJSON before termination records `costTotal: 0` with `estimated:false` — the lead cannot fabricate cost it never observed. This ensures NFR-COST-1 (every run ledgered) is satisfied even for terminated workers, with explicit labelling when cost is estimated rather than exact.
- **Integration points (each wired & exercised):** (1) `WarrenClient.dispatch()` + `waitForRun` from `scripts/warren/dispatch-run.ts`; (2) lead system prompt constructed with Mulch context + worker model map + swarm instructions (`scripts/pi-team/lead-system-prompt.ts`); (3) workers spawned via lead bash tool call: `pi -p --no-session --mode json`; (4) per-worker NDJSON parsed for `turn_end.message.usage.cost.total`; (5) lead merge/validate writes one merged JSON.
- **Files / functions touched:** see "Files to Modify" below.
- **Guards/limits:** lead wall-clock cap enforced via warren run timeout + P0.3 spawn-kill for stuck workers; `coms_await` per-archetype timeout (TDD-Trio 8 min) carried in lead system prompt; pi 0.55.0 `-p --no-session` flags mandatory (headless mode, no interactive prompt).

## Files to Modify

- `scripts/warren/dispatch-run.ts` (new — WarrenClient dispatch + waitForRun/streamRunEvents)
- `scripts/pi-team/lead-system-prompt.ts` (new — constructs lead prompt with Mulch context + worker model map + swarm instructions)
- `scripts/pi-team/lead-merge.ts` (update — worker reply validation + `changed_files` set-union)
- `scripts/pi-team/worker-schema.ts` (update — `response_schema` definition with mandatory `changed_files: string[]`)
- `scripts/pi-team/cost-envelope.ts` (new — per-worker cost extraction from NDJSON, writes envelope for P1.13)
- `test/pi-team/warren-run.e2e.test.ts` (new — e2e test)
- `test/pi-team/lead-merge.test.ts` (update — unit tests for merge + schema validation logic)

## Security Invariants

- **INV-1 (secrets):** `PAPERCLIP_API_KEY`, `PAPERCLIP_RUN_ID`, and any model API key are read from env/secret refs only (NFR-SEC-1/2); they are NEVER written to the merged JSON output, cost envelope, stderr logs, or Mulch context — redacted before any emit.
- **INV-2 (cost/budget):** Lead pi owns spawn/kill of worker procs (P0.3) and enforces wall-clock/turn caps; a loopy team is SIGKILL'd with non-zero exit (NFR-SAF-1), never by exhausting credits.
- **INV-3 (cost attribution):** Per-worker cost envelope carries each worker's OWN cname/model; the lead cannot attribute a worker's cost to another agent. Forwarded to P1.13 for Paperclip POST under the run's `agentId`.
- **INV-4 (input validation):** Merged stdout object is validated against the merged schema before being written as run output; a worker reply that fails schema or omits `changed_files` is rejected as a logic error, never silently merged (CORRECTNESS-C/E).

## Definition of Done

- [ ] **Impl:** `WarrenClient.dispatch()` triggers a warren run with a lead pi system prompt containing Mulch context, worker model map, and swarm instructions. `PAPERCLIP_API_KEY` and `PAPERCLIP_RUN_ID` are passed via runtime environment variables (never embedded in prompt text — enforced by runtime assertion in `lead-system-prompt.ts` scanning for secret patterns before dispatch).
- [ ] **Impl:** Lead spawns ≤4 worker pi procs via bash tool (`pi --model openrouter/google/gemini-2.5-flash -p --no-session --mode json`).
- [ ] **Impl:** Lead validates each worker reply against `response_schema`, computes `changed_files` set-union, writes ONE merged JSON object as lead stdout.
- [ ] **Impl:** A worker reply missing `changed_files` or failing schema validation is rejected as `exit_class:"logic"` (re-request or fail the run), never silently merged.
- [ ] **Impl:** Per-worker cost envelope written — one entry per worker cname, `turn_end.message.usage.cost.total` extracted from NDJSON stdout, keyed by `warrenRunId` + `cname`.
- [ ] **Contract:** Worker `response_schema` (mandatory `changed_files: string[]`) and merged-output schema (`changed_files`/`result`/`partial`/`exit_class`/`waivers`) defined with field validation.
- [ ] **Integration:** `WarrenClient.dispatch()` → `waitForRun` pipeline exercised end-to-end against a live warren instance.
- [ ] **Observability/Audit:** Warren run id propagated to cost envelope entries; `streamRunEvents` carries merged result (NFR-OBS-1/OBS-3).
- [ ] **Security:** INV-1 (no secret in any emit), INV-2 (SIGKILL on cap), INV-3 (own-cname cost only), INV-4 (schema-reject on bad worker reply) each enforced and tested.
- [ ] **Test (unit/integration):** Covers lead merge + set-union, missing-`changed_files` logic-error path, cap-hit SIGKILL non-zero exit, and cost envelope extraction from worker NDJSON.
- [ ] **Test (e2e demo — MANDATORY):** Fires AC-1: `WarrenClient.dispatch()` on a primed issue; `waitForRun` returns success; run output `JSON.parse` yields one object whose `changed_files` is `string[]`; cost envelope has ≥1 per-worker entry with non-zero `costTotal` — proving one Warren run yields one structured result with wiring closed.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
