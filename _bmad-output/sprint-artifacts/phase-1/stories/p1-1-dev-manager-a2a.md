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

1. **(make-or-break)** Given SwarmClaw is running, When POST /api/agents is called with `{ "agentId": "dev-manager", "agentType": "department-manager", "endpointUrl": "http://localhost:3100/a2a" }` (both `agentType` and `endpointUrl` required — missing either yields 400), Then the response is 201 with `{ "agentId": "dev-manager", "status": "registered" }`.
2. Given the Dev Manager agent is registered, When POST /api/a2a is called with JSON-RPC 2.0 body and headers `targetAgentId: dev-manager` / `requesterAgentId: orchestrator`, Then the request is forwarded to the CLI-Anything harness endpoint and the response is returned to the caller with matching correlation ID.
3. Given the targetUrl is unreachable, When an A2A call is attempted, Then the onFailure policy fires and SwarmClaw returns a structured error response (not a 500 crash) within the configured timeoutMs.
4. **(AC-B1)** Given a delegate request with correct agentId and task, SwarmClaw's A2A router sends an HTTP POST to the registered endpointUrl. The harness at that endpoint processes the request and returns the response. SwarmClaw does NOT re-forward responses. The data flow is strictly: caller -> SwarmClaw -> agent endpoint -> SwarmClaw -> caller. The POST carries a JSON-RPC 2.0 envelope (`method: "a2a.delegate"`, `params.agentId`, `params.task`, `params.timeoutMs`, `params.requestId`) and SwarmClaw returns the harness response to the caller within timeoutMs. If the harness is not listening (connection refused), returns error code -32010 with no subprocess fallback.
5. **(AC-forward-verify)** Given the Dev Manager is registered and the CLI-Anything harness is running, When an A2A delegation call is made with targetAgentId="dev-manager", Then the harness receives an HTTP POST at `/a2a` with the exact JSON-RPC 2.0 envelope sent by SwarmClaw (verifiable by harness request log), and the response correlation matches.

## Technical Notes

- **Contracts/Schema:** Agent registration: `{ agentId: string, agentType: "department-manager"|"worker"|"observer"|"service", endpointUrl: string, capabilities: string[] }` — both `agentType` and `endpointUrl` are **required** fields for A2A agent registration. P0.7's RegisterAgentSchema accepts `agentType` and `endpointUrl` as optional fields for MCP-only agents. P1.1 requires both fields for A2A agent registration. Registration requests missing either field are rejected with 400. `service` covers specialized handler agents (Seeds decomposer, future agents). Unlike worker/department-manager roles, service agents provide a single well-defined capability. A2A request: JSON-RPC 2.0 with `targetAgentId` and `requesterAgentId` in headers. Response: standard JSON-RPC 2.0 response with `result` or `error`.
- **Integration points:** SwarmClaw /api/agents (register), SwarmClaw /api/a2a (delegate), CLI-Anything harness endpoint `http://localhost:${process.env.SWARMCLAW_A2A_PORT || 3100}/a2a` (receiver, HTTP POST). a2a_delegate config fields: endpointUrl (from registration), agentId, taskName, task, timeoutMs, credentialId, onFailure. The a2a_delegate config uses canonical P1.1 Transport Contract field names. `agentId` identifies the target, `task` carries the payload. `credentialId` is reserved for future credential management. Not used in Phase 1. Consumers should ignore this field if present. `credentialId` is accepted but ignored in Phase 1. Phase 2 will introduce credential management with a versioned schema change. Implementers should pass `credentialId: null` or omit the field. Transport contract: local HTTP POST only; no subprocess or socket fallback.
- **Cross-story field mapping note:** P1.6's dispatch_task config uses `mulchBankId` while the `.canopy/agent.json` manifest uses `mulchBank`. The harness adapter must translate between these field names. P1.1's transport layer carries the config as-is; the mapping is the harness's responsibility.
- **Files / functions touched:** SwarmClaw agent registry module, A2A routing handler, CLI-Anything harness adapter, agent registration test fixture.
- **Guards/limits:** timeoutMs must be >= 1000ms and <= 900000ms. onFailure must be one of: `retry`, `fail`, `fallback`. `fallback` routes to a preconfigured backup agent endpoint. Not implemented in Phase 1 — registration with `onFailure: 'fallback'` returns 400 with error message 'Fallback routing not available in Phase 1'. `onFailure` is a per-invocation parameter (supplied in the A2A delegation request, not at agent registration). When an invocation includes `onFailure: 'fallback'`, SwarmClaw returns JSON-RPC error -32602 with message 'Fallback routing not available in Phase 1'. agentId must match `^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$` (aligned with P0.7 INV-SC1: 2–128 chars, alphanumeric start/end). Duplicate registration returns 409. No upper bound on concurrent A2A delegations is enforced in Phase 1. A concurrency limit and queuing mechanism will be added in Phase 2 when multi-agent workloads require it. Operational note: Phase 1 A2A router has no concurrency cap. Implementers should document a recommended operational maximum concurrent delegations (suggested: 50) and log a warning when exceeded. A hard concurrency limit with queuing is a Phase 2 concern. The A2A router should NOT OOM-kill or crash under high concurrency — it should degrade gracefully (accept connections, process FIFO). Agent deregistration while an A2A delegation is in-flight: the in-flight request completes normally. The agent is marked 'pending removal' — no new delegations accepted. Once all in-flight requests complete, the agent record is removed.
- **Correlation ID propagation:** Every A2A request carries a `requestId` (UUID v4, generated by the caller). The caller should set JSON-RPC envelope `id` and `params.requestId` to the same UUID. If `params.requestId` is absent, SwarmClaw populates it from the envelope `id`. The observability layer uses `requestId` for trace correlation. The requestId propagates through all layers: SwarmClaw A2A router → CLI-Anything harness → Warren → PI agents. The requestId appears in: (1) JSON-RPC request `params.requestId`, (2) JSON-RPC response `result.requestId`, (3) all observability log entries (CC-9). If the caller does not provide a requestId, SwarmClaw generates one and includes it in the forwarded request. The requestId is the join key for cross-layer tracing. When SwarmClaw auto-generates a requestId (because the caller provided no envelope `id` and no `params.requestId`), the generated UUID is used as both the response envelope's top-level `id` field and `result.requestId`, ensuring the caller can always correlate the response to its original request via the returned `id`.
- **Retry policy defaults:** When `onFailure` is set to `retry`: max 3 attempts (1 initial + 2 retries), exponential backoff starting at 1s with multiplier 2 (delays: 1s for first retry, 2s for second retry). Total attempts: 3. Max total backoff wait: 3s (sum of inter-retry delays only). Each retry attempt inherits the caller's full timeoutMs budget. Total wall-clock time for a fully-retried request is bounded by: timeoutMs * 3 + 3s backoff. Idempotency key = `requestId` from the JSON-RPC envelope. Retry only applies to transient failures (-32010 Harness unavailable, -32012 Delegation timeout). Non-retryable errors (-32011 Agent not registered, -32013 Agent execution error, -32602 Invalid params) fail immediately without retry. The retry counter and backoff state are per-request, not per-agent. Circuit breaker pattern is deferred to Phase 2. Phase 1 relies on retry with backoff for transient failures. A production circuit breaker will be added when A2A traffic warrants it.
- **requesterAgentId redundancy note:** `requesterAgentId` is sent both as an HTTP header and inside `params` for redundancy. Headers enable middleware logging without parsing the body. The canonical source is the header; `params.requesterAgentId` is a fallback.
- **exitStatus enum note:** The canonical exitStatus enum is `success|transient|overflow|logic`. P0.3 previously used `logic_error` (now corrected). Any consumer receiving an unknown exitStatus should treat it as `transient`.

## Files to Modify

- `src/swarmclaw/agents/registry.ts`
- `src/swarmclaw/a2a/router.ts`
- `src/swarmclaw/a2a/delegate.ts`
- `src/cli-anything/harness/adapter.ts`
- `tests/e2e/a2a-delegation.test.ts`

## Security Invariants

- INV-1: A2A calls require valid `targetAgentId` and `requesterAgentId` headers; missing headers result in 400. `requesterAgentId` must reference an agent registered via POST /api/agents (checked at invocation time). Unregistered requesterAgentId values return 422 with error code -32011.
- INV-2: agentId in registration must match `^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$` (aligned with P0.7 INV-SC1); reject malformed IDs with 422.
- INV-3: endpointUrl must be http or https scheme; reject arbitrary schemes with 422.
- INV-4: endpointUrl hostname must resolve to localhost (127.0.0.1, ::1, or hostname 'localhost'). Non-loopback endpoints are rejected with 422. This enforces the Transport Contract (local HTTP POST only) at registration time. When endpointUrl uses HTTPS with localhost hostname (127.0.0.1, ::1, or hostname 'localhost'), SwarmClaw accepts self-signed certificates using a per-request `https.Agent` configured with `rejectUnauthorized: false` scoped exclusively to localhost targets. The agent is created only when the target hostname resolves to a loopback address; all other HTTPS requests use the default `rejectUnauthorized: true` behavior. SwarmClaw MUST NOT set `NODE_TLS_REJECT_UNAUTHORIZED=0` as a process-global environment variable — that mechanism disables TLS certificate validation for all outbound HTTPS connections, including those to external APIs and model providers.

## Transport Contract (B1)

The A2A delegation layer uses **local HTTP POST** to the CLI-Anything harness endpoint. SwarmClaw never invokes the harness via subprocess or socket — the harness MUST be running as a local HTTP service.

**Endpoint:** `http://localhost:${process.env.SWARMCLAW_A2A_PORT || 3100}/a2a`

**Request envelope:**
```json
{
  "jsonrpc": "2.0",
  "method": "a2a.delegate",
  "params": {
    "agentId": "dev-manager",
    "task": "<task description or structured payload>",
    "timeoutMs": 30000,
    "requesterAgentId": "orchestrator",
    "requestId": "<uuid>"
  },
  "id": "<uuid>"
}
```

**Success response envelope:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "status": "completed",
    "exitStatus": "success",
    "changedFiles": ["src/foo.ts"],
    "requestId": "<same uuid>"
  },
  "id": "<same uuid>"
}
```

**Error response envelope:**
```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32010,
    "message": "Harness unavailable",
    "data": { "requestId": "<uuid>" }
  },
  "id": "<same uuid>"
}
```

**Fallback behavior:** If the HTTP endpoint is unavailable (connection refused), the Dev Manager returns error `-32010` (Harness unavailable) to the caller. No subprocess fallback — the harness MUST be running. This is the only fallback; no retry-at-source logic in the A2A router.

> In error responses, `requestId` appears in the top-level `error.data` object rather than alongside `result` (as in success responses). This asymmetry is intentional — error responses follow the JSON-RPC 2.0 error structure where application data nests inside `error.data`.

**Harness responsibility:** The CLI-Anything harness is responsible for translating the delegated task to a Warren invocation (`warren run --config .canopy/agent.json`). The A2A layer does not prescribe Warren flags — that contract belongs to P0.3/P1.6.

## A2A Error Code Taxonomy (B2)

A2A-specific error codes extend the standard JSON-RPC 2.0 reserved server-error range (-32000 to -32099):

| Code   | Name                  | When Used                                                    |
|--------|-----------------------|--------------------------------------------------------------|
| -32600 | Invalid Request       | Malformed JSON-RPC envelope (missing jsonrpc/method/id)      |
| -32601 | Method not found      | Unrecognized A2A method (not "a2a.delegate")                 |
| -32602 | Invalid params        | Missing/invalid agentId, task payload, or params structure   |
| -32000 | Internal error        | Unexpected server failure (unhandled exception)              |
| -32010 | Harness unavailable   | CLI-Anything harness endpoint unreachable (connection refused)|
| -32011 | Agent not registered  | targetAgentId not found in SwarmClaw agent registry          |
| -32012 | Delegation timeout    | Response not received from harness within timeoutMs          |
| -32013 | Agent execution error | Harness returned non-zero exitStatus or malformed response   |

> Error codes -32010 through -32013 are A2A-specific. Standard JSON-RPC codes (-32600, -32601, -32602, -32000) apply for protocol-level errors. P1.3 decompose errors use -32014 through -32017.

Protocol-level errors (-32600, -32601, -32602) extract requestId from the envelope `id` if present. If the envelope `id` is absent or null, `error.data` contains `requestId: null`.

## Timeout Alignment (CC-7)

timeoutMs upper bound is 900s (raised from 300s). timeoutMs must be >= P1.6 maxDurationMs upper bound (600s). P1.1 default max raised to 900s to accommodate longest P1.6 operations with margin.

## Naming Convention (CC-8)

A2A JSON payloads use camelCase throughout (agentId, taskBrief, timeoutMs, not agent_id, task_brief, timeout_ms). No snake_case keys appear in any A2A request or response envelope.

## Observability Contract (CC-9)

- Every A2A operation logs: `{requestId, operation, agentId, timestamp, duration, status}`
- requestId propagates from Dev Manager -> CLI-Anything -> Warren -> PI
- Errors include: `{code, message, stack?: string}`
- A2A timing metrics: `routing_latency_ms`, `forwarding_duration_ms`, `total_e2e_ms`
- E2E latency target: <5s for routing+forwarding (excludes agent execution time)

> Observability event emission failures are fire-and-forget. If the observability endpoint is unreachable or returns an error, the A2A delegation proceeds normally. Observability is non-blocking.

## Definition of Done

- [ ] **Impl:** POST /api/agents registers Dev Manager with agent type "department-manager" and returns 201.
- [ ] **Impl:** POST /api/a2a with targetAgentId="dev-manager" routes request to registered endpointUrl.
- [ ] **Impl:** A2A response propagates back to caller with matching JSON-RPC 2.0 id.
- [ ] **Impl:** onFailure policy fires when targetUrl is unreachable, returning structured error (not 500).
- [ ] **Contract:** Agent registration schema validated (agentId pattern, agentType enum, endpointUrl scheme).
- [ ] **Contract:** A2A JSON-RPC 2.0 envelope validated on ingress (jsonrpc:"2.0", method, id present).
- [ ] **Contract:** Transport contract verified — A2A router sends HTTP POST to harness endpoint (not subprocess); connection refused produces error -32010.
- [ ] **Integration:** CLI-Anything harness receives forwarded A2A request and returns response.
- [ ] **Integration:** timeoutMs enforced; request aborted and onFailure triggered on timeout.
- [ ] **Security:** Missing targetAgentId/requesterAgentId headers rejected with 400.
- [ ] **Test (unit):** Agent registration validates input and rejects duplicates with 409.
- [ ] **Test (unit):** A2A router forwards to correct endpoint based on targetAgentId lookup.
- [ ] **Test (forward verification):** Harness request log captures forwarded JSON-RPC envelope; body matches original A2A request (verifies AC5).
- [ ] **Test (e2e demo — MANDATORY):** Register Dev Manager → send A2A JSON-RPC call → receive correlated response; verify round-trip with < 5s latency.
- [ ] **Test (SSRF):** Register agent with endpointUrl `http://evil.com/api` → verify 422 rejection. Register with `http://localhost:3100/a2a` → verify 201.
- [ ] **Test (retry):** A2A delegation with `onFailure='retry'` to unreachable endpoint produces 3 attempts with backoff (1s, 2s) before returning error code -32010. Test verifies attempt count (3 total), not exact backoff timing. Backoff delays verified separately via unit test.
- [ ] **Test (agent-not-found):** A2A delegation with targetAgentId for an unregistered agent returns JSON-RPC error code -32011; no HTTP request is made to any endpoint.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
