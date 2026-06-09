# P1.1: Dev Manager Registered as SwarmClaw Agent with A2A Delegation

**Story Points:** 3

## Spec Reference

- PRD §5; FR-MG-1, FR-CP-11
- Phase exit gate: PRD §13 Phase 1 clause 1

## User Story

As a QDS factory operator,
I want the Dev Manager registered as a SwarmClaw agent capable of receiving A2A delegation calls,
so that higher-level orchestration can route tasks to it via structured JSON-RPC 2.0 messages.

## Overview

Register a "Dev Manager" agent with SwarmClaw via POST /api/agents, setting its agent type to "department-manager" and configuring its endpoint URL to point at the CLI-Anything harness. Then configure an a2a_delegate protocol step that targets this agent. When a JSON-RPC 2.0 call arrives at /api/a2a with targetAgentId matching the Dev Manager, SwarmClaw routes the call to the CLI-Anything harness, which invokes the Dev Manager's handler and returns the result. This story closes the A2A delegation loop end-to-end.

## E2E Slice

**Demonstrable behavior:** A POST to /api/agents registers the Dev Manager. A subsequent A2A JSON-RPC 2.0 call to /api/a2a with targetAgentId="dev-manager" routes through SwarmClaw to the CLI-Anything harness and returns a structured response. The round-trip completes with correct correlation IDs.

**Wiring closed:** On completion of this story, registering an agent and invoking it via A2A delegation produces a complete request-response cycle using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P0.1 (CLI-Anything harness skeleton), P0.7 (SwarmClaw API surface), P0.11 (Phase 0 exit gate).

## Acceptance Criteria

1. **(make-or-break)** Given SwarmClaw is running, When POST /api/agents is called with `{ "agentId": "dev-manager", "agentType": "department-manager", "endpointUrl": "http://localhost:3100/harness" }`, Then the response is 201 with `{ "agentId": "dev-manager", "status": "registered" }`.
2. Given the Dev Manager agent is registered, When POST /api/a2a is called with JSON-RPC 2.0 body and headers `targetAgentId: dev-manager` / `requesterAgentId: orchestrator`, Then the request is forwarded to the CLI-Anything harness endpoint and the response is returned to the caller with matching correlation ID.
3. Given the targetUrl is unreachable, When an A2A call is attempted, Then the onFailure policy fires and SwarmClaw returns a structured error response (not a 500 crash) within the configured timeoutMs.

## Technical Notes

- **Contracts/Schema:** Agent registration: `{ agentId: string, agentType: "department-manager"|"worker"|"observer", endpointUrl: string, capabilities: string[] }`. A2A request: JSON-RPC 2.0 with `targetAgentId` and `requesterAgentId` in headers. Response: standard JSON-RPC 2.0 response with `result` or `error`.
- **Integration points:** SwarmClaw /api/agents (register), SwarmClaw /api/a2a (delegate), CLI-Anything harness endpoint (receiver). a2a_delegate config fields: targetUrl, targetExternalAgentId, taskName, taskMessage, timeoutMs, credentialId, onFailure.
- **Files / functions touched:** SwarmClaw agent registry module, A2A routing handler, CLI-Anything harness adapter, agent registration test fixture.
- **Guards/limits:** timeoutMs must be >= 1000ms and <= 300000ms. onFailure must be one of: `retry`, `fail`, `fallback`. agentId must match `^[a-z][a-z0-9-]{1,63}$`. Duplicate registration returns 409.

## Files to Modify

- `src/swarmclaw/agents/registry.ts`
- `src/swarmclaw/a2a/router.ts`
- `src/swarmclaw/a2a/delegate.ts`
- `src/cli-anything/harness/adapter.ts`
- `tests/e2e/a2a-delegation.test.ts`

## Security Invariants

- INV-1: A2A calls require valid `targetAgentId` and `requesterAgentId` headers; missing headers result in 400.
- INV-2: agentId in registration must match `^[a-z][a-z0-9-]{1,63}$`; reject malformed IDs with 422.
- INV-3: endpointUrl must be http or https scheme; reject arbitrary schemes with 422.

## Definition of Done

- [ ] **Impl:** POST /api/agents registers Dev Manager with agent type "department-manager" and returns 201.
- [ ] **Impl:** POST /api/a2a with targetAgentId="dev-manager" routes request to registered endpointUrl.
- [ ] **Impl:** A2A response propagates back to caller with matching JSON-RPC 2.0 id.
- [ ] **Impl:** onFailure policy fires when targetUrl is unreachable, returning structured error (not 500).
- [ ] **Contract:** Agent registration schema validated (agentId pattern, agentType enum, endpointUrl scheme).
- [ ] **Contract:** A2A JSON-RPC 2.0 envelope validated on ingress (jsonrpc:"2.0", method, id present).
- [ ] **Integration:** CLI-Anything harness receives forwarded A2A request and returns response.
- [ ] **Integration:** timeoutMs enforced; request aborted and onFailure triggered on timeout.
- [ ] **Security:** Missing targetAgentId/requesterAgentId headers rejected with 400.
- [ ] **Test (unit):** Agent registration validates input and rejects duplicates with 409.
- [ ] **Test (unit):** A2A router forwards to correct endpoint based on targetAgentId lookup.
- [ ] **Test (e2e demo — MANDATORY):** Register Dev Manager → send A2A JSON-RPC call → receive correlated response; verify round-trip with < 5s latency.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
