# P1.6: Pi-team implement bash node — single structured JSON result from a primed team

**Story Points:** 4

## Spec Reference

- PRD §4.6 (launcher contract) + §7; FR-OR-3, FR-EX-6
- Supporting: NFR-OBS-1/OBS-3 (run streams + handoff logged), NFR-COST-1 (≥1 `cost_events`), NFR-SEC-2 (Paperclip bearer + run-scoped header), NFR-SEC-1 (`server.secret.json` 0600)
- Phase exit gate: PRD §13 Phase-1 clause 3 (partial) — "reaches the Pi-team implement node … and emits a single structured JSON result." (The post-edit `lsp_diagnostics` refuse-to-emit gate is the SEPARATE story P1.7; this node captures the result.)

## User Story

As the Hermes Dev manager driving the `qds-piv-loop` DAG,
I want the implement node to launch a Mulch-primed, pi-lens-gated Pi team via `pi-team-launch.sh` and capture exactly one structured JSON object as the node's output,
so that a heavy in-node swarm step yields one demonstrable, attributable result (G2 worker output merges into the node) rather than free-text stdout.

## Overview

This slice cuts through Archon (`executeBashNode`) → the env-patched bash subprocess → `pi-team-launch.sh` → N Pi agents (lead + workers) → pi-lens prime + per-turn QA → Paperclip `cost_events` emit → node output. The bash node carries per-node `env` (PATH/creds + `PAPERCLIP_API_KEY`/`PAPERCLIP_RUN_ID` + role-model map + caps) injected via the FR-OR-4 3-site merge, and invokes the launcher with `--task`/`--context-path`/`--archetype`/caps/`--role-model`. The launcher spawns one `pi` subprocess per role (`--cname <run-id>-<role>`), each Mulch-primed via `--append-system-prompt`; the lead validates each worker's `coms_await` reply against its `response_schema` (parse-only upstream → lead validates), computes the `changed_files` set-union, and writes ONE merged JSON object to stdout — which Archon captures verbatim as node output. It is one atomic unit because the node output is not real until the launcher exists, the env reaches the subprocess, a live primed team runs, and the lead emits a schema-valid merged object — splitting any of these leaves leftover wiring (a stub launcher, an un-injected env, or a non-emitting lead).

## E2E Slice

**Demonstrable behavior:** Running the `qds-piv-loop` implement bash node (via `POST /api/workflows/qds-piv-loop/run`, or invoking the node script directly) on a sample task launches a live primed Pi team and the node output is a single JSON object matching the merged schema: `{ changed_files: string[], result: {...}, partial: boolean, exit_class: "transient"|"overflow"|"logic"|null, waivers: [...] }` — and ≥1 `cost_events` row is written for the run (`issueId` FK set).

**Wiring closed:** On completion of this story, running the implement bash node produces exactly one schema-valid merged JSON object as node output (`JSON.parse` succeeds, `changed_files` is a string[]) from a live Mulch-primed, pi-lens-gated team launched by `pi-team-launch.sh`, plus ≥1 `cost_events` row for the run, using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P0.3 (`pi-team-launch.sh` exists + hard guards/spawn-kill), P0.5 (pi-lens installed + headless prime/QA surface, warning-count proxy fallback if TUI-only), P0.9 (Mulch priming context available for `--context-path`), P1.4 (`qds-piv-loop` DAG authored with the implement bash node carrying per-node `env`; the FR-OR-4 3-site env merge is in place). The post-edit `lsp_diagnostics` emit gate is the SEPARATE successor story **P1.7** (dependency edge out, NOT wired here).

## Acceptance Criteria

1. **(make-or-break)** Given the implement bash node runs `pi-team-launch.sh --task <t> --context-path <ctx> --archetype C` against a live primed team, When the node completes, Then the node output is exactly one JSON object for which `JSON.parse(stdout)` succeeds, `typeof result.changed_files === "object" && Array.isArray(result.changed_files)`, and `result.changed_files.every(f => typeof f === "string")` — i.e. a single structured result, not free text or multiple objects. (Binary: parse succeeds + `changed_files` is `string[]`.)
2. Given the launcher run incurs LLM spend, When the node completes, Then ≥1 `cost_events` row exists for the run with `issueId` FK set and `costCents` a non-negative integer (NFR-COST-1; sole emitter is the launcher per r4 §3, fallback `ESTIMATED` from `heartbeat_runs.usageJson` if OpenRouter generation cost is unavailable).
3. Given a worker reply that omits the mandatory `changed_files` field OR fails its `response_schema` validation, When the lead processes it, Then the lead does NOT silently merge it — it re-requests or fails the node as a logic error (`exit_class:"logic"`, non-zero exit), never emitting a partial object as if complete.
4. Given a loopy/over-budget worker, When the launcher's wall-clock or budget cap is hit, Then the launcher SIGKILLs the team and the node exits non-zero (no unbounded blocking, no merged object emitted) — the guard fires, never a silent continue.

## Technical Notes

- **Contracts/Schema (JSON/TS):** Worker `response_schema` MUST carry `changed_files: string[]` (omission ⇒ lead fails the node — CORRECTNESS-C). Merged lead output (stdout) = `{ changed_files: string[] (set-union), result: object, partial: boolean, exit_class: "transient"|"overflow"|"logic"|null, waivers: object[] }`. The lead validates each worker reply (coms `response_schema` is parse-only, r4 §1) and the launcher validates the merged object before writing stdout.
- **Integration points (each wired & exercised):** (1) per-node `env` merged into `executeBashNode`'s subprocess (FR-OR-4 3-site patch, P1.4) carries `PAPERCLIP_API_KEY`/`PAPERCLIP_RUN_ID`/role-model map/caps; (2) bash node invokes `pi-team-launch.sh` and captures stdout verbatim as node output (`dag-executor.ts:1361-1368`, logs→stderr); (3) Mulch prime via `--context-path` → `--append-system-prompt`; (4) `cost_events` POST to `POST /companies/:companyId/cost-events` (`costs.ts:73`), bearer-authed; (5) pi-lens per-turn QA runs on each worker (prime/secret-scan; the refuse-to-emit diagnostics gate is P1.7, not here).
- **Files / functions touched:** the implement-node script `qds-piv-loop/implement-node.sh` (the bash node body that builds the launcher invocation), `cost-emit.ts` (launcher-side `cost_events` POST), the worker `response_schema` definition, the lead merge/validate logic.
- **Guards/limits:** `--wall-clock-cap-ms` MUST be ≤ the bash node's own `timeout` (`dag-node.ts:181`); `--budget-cap-cents`/`--turn-cap` enforced by the launcher process (owns spawn/kill, r4 §5); `coms_await` per-archetype timeout (TDD-Trio 8 min) carried in the env map (NFR-SAF-3).

## Files to Modify

- `archon-workflows/qds-piv-loop/implement-node.sh`
- `scripts/pi-team/cost-emit.ts`
- `scripts/pi-team/lead-merge.ts`
- `scripts/pi-team/worker-schema.ts`
- `scripts/pi-team/launch-args.ts`
- `test/pi-team/implement-node.e2e.test.ts`
- `test/pi-team/lead-merge.test.ts`

## Security Invariants

- **INV-1 (secrets/env):** The bash node env is a MERGE `{ ...process.env, ...(node.env ?? {}) }` (FR-OR-4) — injecting `PAPERCLIP_API_KEY`/`PAPERCLIP_RUN_ID`/role-model/caps must NOT wipe the subprocess's inherited `PATH`/credentials (CORRECTNESS-A non-regression); a bare `env: node.env` is forbidden.
- **INV-2 (secrets):** `PAPERCLIP_API_KEY` and any model API key are read from env/secret refs only (NFR-SEC-1/2); they are NEVER written to the merged JSON node output, the `cost_events` rows, stderr logs, or the Mulch context — the launcher redacts before any emit.
- **INV-3 (cost/budget):** The launcher process owns spawn/kill and enforces `--budget-cap-cents`/`--turn-cap`/`--wall-clock-cap-ms`; a loopy team terminates via the guard with a non-zero exit (NFR-SAF-1), never by exhausting credits, and `--wall-clock-cap-ms ≤` the bash node `timeout`.
- **INV-4 (cost/budget + audit):** Every run writes ≥1 `cost_events` row with the `issueId` FK (NFR-COST-1) using the per-agent bearer + `PAPERCLIP_RUN_ID` header (NFR-SEC-2); an agent may only report its OWN `agentId` (`costs.ts:77-80`) — no spend is emitted off-ledger or under another agent's identity.
- **INV-5 (input/file):** The merged stdout object is `JSON.parse`-validated and schema-checked by the launcher before being written as node output; a worker reply that fails validation or omits `changed_files` is rejected as a logic error, never merged into the result (CORRECTNESS-C/E).

## Definition of Done

- [ ] **Impl:** The implement bash node builds and invokes `pi-team-launch.sh` with `--task`/`--context-path`/`--archetype`/caps/`--role-model` from the injected per-node env.
- [ ] **Impl:** The lead validates each worker reply against its `response_schema`, computes the `changed_files` set-union, and writes ONE merged JSON object to stdout (launcher validates it before write).
- [ ] **Impl:** A worker reply missing `changed_files` or failing schema validation is rejected as `exit_class:"logic"` (re-request or fail the node), never silently merged.
- [ ] **Contract:** Worker `response_schema` (mandatory `changed_files: string[]`) and the merged-output schema (`changed_files`/`result`/`partial`/`exit_class`/`waivers`) are defined with field validation.
- [ ] **Integration:** The per-node `env` (FR-OR-4 merge) reaches the launcher subprocess (verified: an env var set on the node is readable inside the launcher) — non-regression: inherited `PATH` still present (INV-1).
- [ ] **Integration:** The bash node captures launcher stdout verbatim as node output (logs/diagnostics routed to stderr, surfaced as Archon warning).
- [ ] **Observability/Audit:** ≥1 `cost_events` row is written for the run with `issueId` FK + `costCents` non-negative int, via the per-agent bearer + `PAPERCLIP_RUN_ID` header (NFR-COST-1/SEC-2).
- [ ] **Security:** INV-1 (env merge non-regression), INV-2 (no secret in any emit), and INV-3 (guard SIGKILL on cap) each enforced and tested.
- [ ] **Test (unit/integration):** Covers the lead merge + set-union, the missing-`changed_files` logic-error path, and the cap-hit SIGKILL non-zero exit.
- [ ] **Test (e2e demo — MANDATORY):** Fires AC-1 trigger: runs the implement bash node against a live primed team; asserts `JSON.parse(stdout)` yields one object whose `changed_files` is a `string[]`, AND ≥1 `cost_events` row exists for the run — proving one DAG node yields one structured result with wiring closed.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
