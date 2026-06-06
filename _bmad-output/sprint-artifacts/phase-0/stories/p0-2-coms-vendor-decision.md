# P0.2: Vendor the Pi coms layer and record the in-node architecture decision

**Story Points:** 3

## Spec Reference

- PRD §5.2 (coms upstream-only), §6.4 (Execution — Pi team / coms); FR-EX-1, FR-EX-2
- Phase exit gate: PRD §13 Phase-0 item 2 (vendor `coms.ts` + choose in-node architecture); resolves OQ-1 (socket-coms vs subprocess-RPC) and OQ-5 (contract runs on 0.55.0 or pin/upgrade target fixed).

## User Story

As a Pi worker (and the launcher that spawns it),
I want the upstream-only Pi coms layer vendored in-tree and smoke-tested against the installed pi 0.55.0 binary, with the in-node architecture decision recorded,
so that Phase-0 item-3+ launcher work builds on a present, load-confirmed coms contract instead of a missing or skewed dependency (G1 — a real execution substrate, not a blueprint assumption).

## User Story Note

(Telegram/HITL not in scope here; this is the in-node coms substrate only.)

## Overview

Cuts through the Pi-team execution layer: vendor the load-bearing files, prove they load/register on the pinned binary, then record the OQ-1/OQ-5 decision. `coms.ts` lives only upstream (`disler/pi-vs-claude-code@main`); it is absent from every local clone. The spike already vendored it to `pi-vs-claude-code-vendor/` and confirmed it loads on 0.55.0; this story **productionizes** that vendoring into the factory tree, runs the explicit smoke-test of the coms contract surface, and writes the decision record. Both in-node paths (socket-coms via `coms.ts`, subprocess-RPC via on-disk `agent-team.ts`/`pi-pi.ts`) run on 0.55.0; the story records which is selected day-1. One atomic 3pt unit: the in-node coms layer is undemonstrable until the vendored files load AND the contract surface is smoke-tested AND the decision is recorded.

## E2E Slice

**Demonstrable behavior:** A command runs the coms smoke-test against the installed pi 0.55.0 binary: `pi -e <vendored-coms.ts> --list-models` loads the extension with zero errors and lists models, AND a contract-surface probe asserts the load-bearing call shapes are registered/present — `pi.registerFlag("cname",…)` / `pi.getFlag`, the `coms_send`/`coms_await` verbs, and `sendMessage(..., { triggerTurn: true })`. The smoke-test emits a single decision record (JSON) capturing the OQ-1 path (socket-coms vs subprocess-RPC) and OQ-5 verdict (runs on 0.55.0, or a pin/upgrade target).

**Wiring closed:** On completion of this story, running the coms smoke-test command produces a green load (`--list-models` returns models, no load errors), a passed contract-surface probe, and a written decision record file capturing OQ-1 + OQ-5, using only code merged by this story (the vendored coms files + the smoke-test script + the decision record). No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** None — standalone. (Requires the installed pi 0.55.0 binary, an environment precondition, not a code dependency.)

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given the vendored `coms.ts` (+`coms-net.ts` if present, +`themeMap.ts` shared-helper dep) in-tree and the installed pi 0.55.0 binary, When the coms smoke-test runs `pi -e <coms.ts> --list-models` and probes the contract surface, Then the extension loads with zero errors and lists ≥1 model, the contract probe confirms `registerFlag`/`getFlag` + `coms_send`/`coms_await` + `sendMessage({triggerTurn:true})` are present, AND a decision-record file exists recording the OQ-1 path and OQ-5 verdict (all clauses pass in one run).
2. Given the smoke-test passes green, When the decision record is written, Then it records OQ-1 = the selected in-node path (socket-coms, since it loads on 0.55.0) with subprocess-RPC noted as the viable fallback, and OQ-5 = "coms contract runs on pi 0.55.0; re-smoke-test before adopting any pi ≥ 0.73" — both with the date taken.
3. Given the smoke-test does NOT go green against 0.55.0 (load error or missing contract surface), When the decision record is written, Then it selects the subprocess-RPC fallback path (`agent-team.ts:347-368` / `pi-pi.ts:294`, flags 0.55.0 supports) and logs the failure reason — never a silent gap, never an unverified socket-coms assumption.

## Technical Notes

- **Contracts/Schema:** Decision record = a JSON artifact `{ oq1_path: "socket-coms"|"subprocess-rpc", oq1_fallback: string, oq5_verdict: string, pi_version: "0.55.0", smoke_passed: boolean, decided_at: ISO8601, evidence: { list_models_count: number, contract_surface: string[] } }`. No DB schema change; this is a recorded decision, not a persisted domain row.
- **Integration points (each wired & exercised in this story):** Vendored coms files load into the pi 0.55.0 extension host (`pi -e`); the contract surface (`registerFlag` at `coms.ts:536`, read at `:225`; `coms_send(target,prompt,conversation_id?,response_schema?)`; `coms_await(msg_id,timeout_ms?)`, default 30 min = `1_800_000ms` `PI_COMS_TIMEOUT_MS` `coms.ts:32`; `sendMessage(...,{triggerTurn:true})` `tilldone.ts:365-383`) is probed against the installed binary. Transport noted: per-agent unix socket + file registry `~/.pi/coms/`, no hub, `MAX_HOPS=5`.
- **Files / functions touched:** vendored `coms.ts` / `coms-net.ts` / `themeMap.ts` / `scripts/coms-net-server.ts`; new smoke-test script; new decision record.
- **Guards/limits:** `response_schema` is **parse-only** (`JSON.parse` on `agent_end`, NOT schema-validated) — recorded as a contract caveat for the launcher lead (it must validate worker replies itself, FR-EX-2). Full 2-agent live `coms_send`→`coms_await` round-trip is UNVERIFIED (needs a paid LLM turn + API key) — this story proves **load + contract-surface + decision**, NOT a live message exchange; that live-confirm is flagged as a follow-up AC, not claimed here.

## Files to Modify

> ≤10 unique paths.

- `packages/pi-coms-vendor/coms.ts` (vendored from `disler/pi-vs-claude-code@main`)
- `packages/pi-coms-vendor/coms-net.ts` (if present upstream)
- `packages/pi-coms-vendor/themeMap.ts` (shared-helper dep)
- `packages/pi-coms-vendor/scripts/coms-net-server.ts`
- `scripts/coms-smoke-test.sh` (new — runs `pi -e` load + contract-surface probe)
- `_bmad-output/sprint-artifacts/phase-0/decisions/oq1-oq5-coms-decision.json` (new decision record)

## Definition of Done

> 8–12 high-signal, story-specific boxes. (No Security Invariants section — no security trigger applies to this in-node load/smoke/decision slice.)

- [ ] **Impl:** `coms.ts` (+`coms-net.ts` if present, +`themeMap.ts` dep, +`scripts/coms-net-server.ts`) vendored in-tree from `disler/pi-vs-claude-code@main`.
- [ ] **Impl:** `coms-smoke-test.sh` runs `pi -e <coms.ts> --list-models` against the installed pi 0.55.0 and probes the contract surface.
- [ ] **Impl:** Decision record written to `oq1-oq5-coms-decision.json` capturing OQ-1 path + OQ-5 verdict + date + evidence.
- [ ] **Contract:** Smoke-test asserts the load-bearing call shapes are present — `pi.registerFlag("cname")`/`pi.getFlag`, `coms_send`/`coms_await`, `sendMessage({triggerTurn:true})` — and records the `response_schema` parse-only caveat.
- [ ] **Integration:** Vendored coms layer loads into the pi 0.55.0 extension host with zero load errors and lists ≥1 model (`--list-models`).
- [ ] **Observability:** Decision record logs the smoke result (`smoke_passed`, `list_models_count`, `contract_surface[]`) so OQ-1/OQ-5 resolution is auditable and reproducible.
- [ ] **Integration (fallback path):** If smoke is NOT green, the decision record selects subprocess-RPC (`agent-team.ts`/`pi-pi.ts`) and logs the failure reason — no silent gap.
- [ ] **Test (unit/integration):** Smoke-test script is repeatable (idempotent) and asserts a non-zero exit + recorded failure reason on a forced load failure (guard path).
- [ ] **Test (e2e demo — MANDATORY):** Run `coms-smoke-test.sh`; assert green load + passed contract probe + decision-record file present capturing OQ-1 path and OQ-5 verdict in one run — proves the in-node coms layer is present, loads on 0.55.0, and the decision is recorded (wiring closed).

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
