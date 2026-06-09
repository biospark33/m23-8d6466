# P0.2: Productionize Vendored coms.ts + Record In-Node Architecture Decision

**Story Points:** 3

## Spec Reference

- PRD §4.6 (Pi team coms contract); FR-EX-1, FR-EX-2
- Phase exit gate: PRD §13 Phase-0 clause 2 (coms smoke-test + arch decision)

## User Story

As a Pi swarm integrator,
I want vendored `coms.ts` productionized on `pi@0.55.0` and the subprocess-RPC vs socket-coms architecture decision recorded,
so that Pi agent teams can exchange messages peer-to-peer with structured replies (FR-EX-1, FR-EX-2, G1).

## Overview

Smoke-tests the vendored `coms.ts` + `coms-net.ts` from `pi-vs-claude-code-vendor/` on pinned `pi@0.55.0`, records the OQ-1 architecture decision (subprocess-RPC as day-1 default, socket-coms as viable alternative), and produces the decision artifact in the OQ registry. Cuts Pi execution layer only. 3 pts because it is one concern (coms viability + decision record) with no downstream wiring beyond the decision artifact.

## E2E Slice

**Demonstrable behavior:** A two-agent smoke test registers via `coms.ts` extensions on `pi@0.55.0`, a `coms_send` + `coms_await` exchange completes (or a subprocess-RPC `pi --mode json -p` exchange completes), and the OQ-1 decision artifact exists in `_bmad-output/` recording subprocess-RPC as default.

**Wiring closed:** On completion of this story, running the coms smoke-test script produces structured output showing ≥2 Pi agents registered and ≥1 message exchanged, plus the OQ decision artifact file exists. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** None — standalone.

## Acceptance Criteria

1. **(make-or-break)** Given vendored `coms.ts` in the vendor tree, When the smoke-test script runs on `pi@0.55.0`, Then ≥2 Pi agents register and ≥1 structured message round-trips (coms_send → coms_await succeeds, or subprocess-RPC JSON parse succeeds).
2. Given the smoke-test results, When the OQ-1 decision is recorded, Then the artifact exists at `_bmad-output/sprint-artifacts/_research/oq-1-coms-arch-decision.md` with decision rationale and both paths documented.
3. Given `pi@0.55.0` pinned, When `pi -e ./coms.ts --list-models` runs, Then model listing succeeds (zero exit code) confirming extension load compatibility.

## Technical Notes

- **Contracts/Schema:** OQ decision artifact: markdown with sections (context, options, decision, rationale, constraints). Coms contract: `coms_send(target, prompt, conversation_id?, response_schema?)` / `coms_await(msg_id, timeout_ms?)` / `coms_get` / `coms_list`. `response_schema` is parse-only (`JSON.parse` on `agent_end`, NOT schema-validated — §5.2).
- **Integration points (each wired & exercised in this story):** vendored `coms.ts` loads on `pi@0.55.0`; `pi.registerFlag("cname", ...)` registers `--cname`; unix socket registry at `~/.pi/coms/` populated; subprocess-RPC `pi --mode json -p` produces parseable JSON event stream.
- **Files / functions touched:** `pi-vs-claude-code-vendor/coms.ts` (vendored, read-only verification), `scripts/coms-smoke-test.ts` (new), `_bmad-output/sprint-artifacts/_research/oq-1-coms-arch-decision.md` (new).
- **Guards/limits:** Default `coms_await` timeout 30 min (`PI_COMS_TIMEOUT_MS = 1_800_000ms`, `coms.ts:32`); `MAX_HOPS=5` for socket-coms.

## Files to Modify

- `scripts/coms-smoke-test.ts`
- `_bmad-output/sprint-artifacts/_research/oq-1-coms-arch-decision.md`
- `pi-vs-claude-code-vendor/package.json` (version pin verification)

## Security Invariants

- **INV-1:** Smoke test uses only test/non-production API keys; no real secrets in test fixtures.
- **INV-2:** Unix socket coms files under `~/.pi/coms/` are per-user scope; no cross-user leakage.

## Definition of Done

- [ ] **Impl:** Coms smoke-test script exercises both socket-coms registration and subprocess-RPC on `pi@0.55.0`.
- [ ] **Impl:** OQ-1 architecture decision artifact written with subprocess-RPC as day-1 default and socket-coms as viable alternative.
- [ ] **Contract:** `coms_send`/`coms_await`/`coms_get`/`coms_list` verb signatures documented in decision artifact with parse-only `response_schema` caveat.
- [ ] **Integration:** Vendored `coms.ts` loads on `pi@0.55.0` with zero errors; `pi -e ./coms.ts --list-models` returns model listing.
- [ ] **Test (smoke):** Two-agent registration succeeds; structured message parseable on both paths.
- [ ] **Security:** INV-1 enforced: smoke test uses only test/non-production API keys; no real secrets in test fixtures. INV-2 enforced: unix socket files under `~/.pi/coms/` are per-user scope; no cross-user leakage.
- [ ] **Observability:** OQ-1 decision artifact is well-formed markdown with all required sections (context, options, decision, rationale, constraints) and parseable by downstream tooling.
- [ ] **Test (e2e demo — MANDATORY):** Smoke-test script produces structured JSON output showing ≥2 agents registered + ≥1 message exchanged; OQ-1 artifact file exists and is well-formed.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
