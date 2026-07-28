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

> **Predecessor note (CC-12):** P0.7 ships SwarmClaw's API surface with FOUR routes only — `/api/agents`, `/api/mcp-servers`, `/test`, `/invoke` (`src/swarmclaw/index.ts:85-98`). This story ADDS the NEW additive route `/api/a2a` (JSON-RPC 2.0 A2A delegation). It is consumed downstream by P1.8 (protocol run initiation) and P1.3 (seeds decompose). The new route MUST NOT alter or rename any P0.7-shipped route; it is purely additive.

**Dependency edges (predecessors):** P0.3 (cli-anything Warren harness, shipped PR #40/#87), P0.7 (SwarmClaw API surface).

> **Predecessor reconciliation (CC-3, PR #21, QDS-EXEC-001):** P0.1 (Archon harness skeleton) was KILLED at the Phase-0 gate; the CLI-Anything harness actually shipped via P0.3 + the `cli-anything` workspace (PR #40, PR #87). P0.1 has been removed from the dep edge and replaced with P0.3. **P0.11 (Phase-0 exit gate) is DELIVERED BUT NON-BLOCKING for this story (P1.1-R5-3)** — one wording, used identically in P1.4 and annotated on the `sprint-status.yaml` P1.1 row. Precisely: P0.11 is `status: done` in `sprint-status.yaml` (the gate itself shipped — `scripts/phase0-exit-gate.ts` + `src/gate/*`, 45 tests, 2026-07-25) and its **verdict is FAIL** (7 pass / 2 fail / 1 skip / 2 void), with every blocker upstream and environmental. Earlier drafts wrote this as P0.11 being "deferred", which read as *not delivered* and conflicted with both the `done` status and the `deps: [P0.7, P0.11]` edge still declared on P1.1 — three descriptions of one thing. What is deferred is not the story but its **gating authority**: per the 4-week execution plan §4.2 the gate's blocking function is folded into per-story Definition-of-Done checkpoints and the P1.17 Phase-1 slice gate. The `P0.11` entry therefore stays in P1.1's `sprint-status.yaml` dependency list as a **completed, non-blocking** predecessor — it records ordering and provenance, and its red verdict does NOT hold P1.1 (or any Phase-1 story) at the start line. The only true technical predecessors of P1.1 are P0.3 and P0.7.

## Acceptance Criteria

1. **(make-or-break)** Given SwarmClaw is running, When POST /api/agents is called with `{ "agentId": "dev-manager", "agentType": "department-manager", "endpointUrl": "http://localhost:3100/a2a" }` (both `agentType` and `endpointUrl` required — missing either yields 400), Then the response is 201 with `{ "agentId": "dev-manager", "status": "registered" }`.
2. Given the Dev Manager agent is registered, When POST /api/a2a is called with JSON-RPC 2.0 body and headers `targetAgentId: dev-manager` / `requesterAgentId: orchestrator`, Then the request is forwarded to the CLI-Anything harness endpoint and the response is returned to the caller with matching correlation ID.
3. Given the targetUrl is unreachable, When an A2A call is attempted, Then the onFailure policy fires and SwarmClaw returns a structured error response (not a 500 crash) within the configured timeoutMs.
4. **(AC-B1)** Given a delegate request with correct agentId and task, SwarmClaw's A2A router sends an HTTP POST to the registered endpointUrl. The harness at that endpoint processes the request and returns the response. SwarmClaw does NOT re-forward responses. The data flow is strictly: caller -> SwarmClaw -> agent endpoint -> SwarmClaw -> caller. The POST carries a JSON-RPC 2.0 envelope (`method: "a2a.delegate"`, `params.agentId`, `params.task`, `params.timeoutMs`, `params.requestId`) and SwarmClaw returns the harness response to the caller within timeoutMs. If the harness is not listening (connection refused), returns error code -32010 with no subprocess fallback.
5. **(AC-forward-verify)** Given the Dev Manager is registered and the CLI-Anything harness is running, When an A2A delegation call is made with targetAgentId="dev-manager", Then the harness receives an HTTP POST at `/a2a` with the exact JSON-RPC 2.0 envelope sent by SwarmClaw (verifiable by harness request log), and the response correlation matches.

## Technical Notes

- **Contracts/Schema:** Agent registration: `{ agentId: string, agentType: "department-manager"|"worker"|"observer"|"service", endpointUrl: string, capabilities: string[] }` — both `agentType` and `endpointUrl` are **required** fields for A2A agent registration. P0.7's RegisterAgentSchema accepts `agentType` and `endpointUrl` as optional fields for MCP-only agents. P1.1 requires both fields for A2A agent registration. Registration requests missing either field are rejected with 400. `service` covers specialized handler agents (Seeds decomposer, future agents). Unlike worker/department-manager roles, service agents provide a single well-defined capability. A2A request: JSON-RPC 2.0 with `targetAgentId` and `requesterAgentId` in headers. Response: standard JSON-RPC 2.0 response with `result` or `error`.
- **Integration points:** SwarmClaw /api/agents (register), SwarmClaw /api/a2a (delegate), CLI-Anything harness endpoint `http://localhost:${process.env.SWARMCLAW_PORT || 3100}/a2a` (receiver, HTTP POST). a2a_delegate config fields: endpointUrl (from registration), agentId, taskName, task, timeoutMs, credentialId, onFailure. The a2a_delegate config uses canonical P1.1 Transport Contract field names. `agentId` identifies the target, `task` carries the payload. `credentialId` is reserved for future credential management. Not used in Phase 1. Consumers should ignore this field if present. `credentialId` is accepted but ignored in Phase 1. Phase 2 will introduce credential management with a versioned schema change. Implementers should pass `credentialId: null` or omit the field. Transport contract: local HTTP POST only; no subprocess or socket fallback.
- **Cross-story field mapping note:** P1.6's dispatch_task config uses `mulchBankId` while the `.canopy/agent.json` manifest uses `mulchBank`. The harness adapter must translate between these field names. P1.1's transport layer carries the config as-is; the mapping is the harness's responsibility.
- **Files / functions touched:** SwarmClaw agent registry module, A2A routing handler, CLI-Anything harness adapter, agent registration test fixture.
- **Guards/limits:** timeoutMs must be >= 1000ms and <= 900000ms. onFailure must be one of: `retry`, `fail`, `fallback`. `fallback` routes to a preconfigured backup agent endpoint. Not implemented in Phase 1 — registration with `onFailure: 'fallback'` returns 400 with error message 'Fallback routing not available in Phase 1'. `onFailure` is a per-invocation parameter (supplied in the A2A delegation request, not at agent registration). When an invocation includes `onFailure: 'fallback'`, SwarmClaw returns JSON-RPC error -32602 with message 'Fallback routing not available in Phase 1'. agentId must match `^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$` (aligned with P0.7 INV-SC1: 2–128 chars, alphanumeric start/end). Duplicate registration returns 409. No upper bound on concurrent A2A delegations is enforced in Phase 1. A concurrency limit and queuing mechanism will be added in Phase 2 when multi-agent workloads require it. Operational note: Phase 1 A2A router has no concurrency cap. Implementers should document a recommended operational maximum concurrent delegations (suggested: 50) and log a warning when exceeded. A hard concurrency limit with queuing is a Phase 2 concern. The A2A router should NOT OOM-kill or crash under high concurrency — it should degrade gracefully (accept connections, process FIFO). Agent deregistration while an A2A delegation is in-flight: the in-flight request completes normally. The agent is marked 'pending removal' — no new delegations accepted. Once all in-flight requests complete, the agent record is removed.
- **Correlation ID propagation (CC-9):** Every A2A request carries a `requestId` (UUID v4, generated by the caller). The caller should set JSON-RPC envelope `id` and `params.requestId` to the same UUID. If `params.requestId` is absent, SwarmClaw populates it from the envelope `id`. SwarmClaw also emits the `x-request-id` HTTP response header (UUID v4 strict, `src/swarmclaw/index.ts:42-46`) on every A2A response so cross-layer join works at the transport boundary without parsing JSON-RPC. The observability layer uses `requestId` for trace correlation. The requestId propagates through all layers: SwarmClaw A2A router → CLI-Anything harness → Warren → PI agents. The requestId appears in: (1) JSON-RPC request `params.requestId`, (2) JSON-RPC response `result.requestId`, (3) the `x-request-id` HTTP response header, (4) all observability log entries. The requestId is the join key for cross-layer tracing.
  - **Missing-ID behavior (single canonical rule).** The JSON-RPC envelope `id` is **REQUIRED** on ingress: a request whose `id` is absent or `null` is rejected with `-32600` (Invalid Request) and is never delegated — this is the rule the DoD ingress-validation item enforces, and it is the only place a missing id is tolerated at all (the `-32600` response itself carries `error.data.requestId: null`, per the taxonomy below, because there is no id to echo). SwarmClaw therefore **never auto-generates an envelope `id`**.
  - Auto-generation applies to the two *derived* fields only: (a) if `params.requestId` is absent, SwarmClaw populates it from the (mandatory) envelope `id`; (b) if the inbound `x-request-id` HTTP header is absent or is not a strict UUID v4, SwarmClaw generates one for the transport layer (`src/swarmclaw/index.ts:42-46`). The response's top-level `id`, `result.requestId`, and `x-request-id` header are then all populated, so a caller can always correlate a *valid* request to its response.
- **Retry policy defaults:** When `onFailure` is set to `retry`: max 3 attempts (1 initial + 2 retries), exponential backoff starting at 1s with multiplier 2 (delays: 1s for first retry, 2s for second retry). Total attempts: 3. Max total backoff wait: 3s (sum of inter-retry delays only). **Deadline model — `timeoutMs` is PER-ATTEMPT, not end-to-end.** Each retry attempt inherits the caller's full timeoutMs budget. Total wall-clock time for a fully-retried request is bounded by: timeoutMs * 3 + 3s backoff. AC3/AC4's "within timeoutMs" therefore describes a single attempt; with `onFailure: 'retry'` a caller must budget the `timeoutMs * 3 + 3s` ceiling. The retry test (DoD) asserts attempt count against the per-attempt budget — it MUST NOT assert that the whole retried call finishes inside one `timeoutMs`. Idempotency key = `requestId` from the JSON-RPC envelope. Retry only applies to transient failures (-32010 Harness unavailable, -32012 Delegation timeout). Non-retryable errors (-32011 Agent not registered, -32013 Agent execution error, -32602 Invalid params) fail immediately without retry. The retry counter and backoff state are per-request, not per-agent. Circuit breaker pattern is deferred to Phase 2. Phase 1 relies on retry with backoff for transient failures. A production circuit breaker will be added when A2A traffic warrants it.
- **requesterAgentId redundancy note:** `requesterAgentId` is sent both as an HTTP header and inside `params` for redundancy. Headers enable middleware logging without parsing the body. The canonical source is the header; `params.requesterAgentId` is a fallback.
- **exitStatus enum note (CC-1):** The canonical exitStatus enum is the 5-value set `success|transient|overflow|logic|lead_failure` (canonical in P0.3, `cli-anything/src/types.ts:78-84`). P0.3 previously used `logic_error` (now corrected). `lead_failure` is harness-classified: it is emitted when the lead process exits before the merged-JSON result can be produced — the `exitCode` field carries the lead process exit code. Any consumer receiving an unknown exitStatus should treat it as `transient`.

## Files to Modify

> **NEW additive route (CC-12, N-P1.1-1):** `src/swarmclaw/index.ts` registers a NEW `/api/a2a` route. P0.7 ships `/api/agents`, `/api/mcp-servers`, `/test`, `/invoke` only (`src/swarmclaw/index.ts:85-98`); this story ADDS `/api/a2a` and MUST NOT modify or rename any of the four P0.7 routes. The route is consumed downstream by P1.8 (protocol run) and P1.3 (seeds decompose).

- `src/swarmclaw/index.ts` — register new `/api/a2a` route (additive)
- `src/swarmclaw/agents/registry.ts`
- `src/swarmclaw/a2a/router.ts`
- `src/swarmclaw/a2a/delegate.ts`
- `src/cli-anything/harness/adapter.ts`
- `tests/e2e/a2a-delegation.test.ts`

## Security Invariants

- INV-1: A2A calls require valid `targetAgentId` and `requesterAgentId` headers; missing headers result in 400. `requesterAgentId` must reference an agent registered via POST /api/agents (checked at invocation time). Unregistered requesterAgentId values return 422 with error code -32011.
- INV-2: agentId in registration must match `^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$` (aligned with P0.7 INV-SC1); reject malformed IDs with 422.
- INV-3: endpointUrl must be http or https scheme; reject arbitrary schemes with 422.
- INV-4: endpointUrl hostname must resolve to localhost (127.0.0.1, ::1, IPv4-mapped IPv6 `::ffff:127.0.0.1`, or hostname 'localhost'). Non-loopback endpoints are rejected with 422. This enforces the Transport Contract (local HTTP POST only) at registration time. The IPv4-mapped IPv6 form `::ffff:127.0.0.1` is included in the loopback set because Node's DNS resolver may return it for the literal hostname `localhost` on dual-stack hosts (`agent-store.ts:39` originally listed only `127.0.0.1` + `::1`, leaving the mapped form as a known gap — this story closes that gap). When endpointUrl uses HTTPS with localhost hostname (127.0.0.1, ::1, `::ffff:127.0.0.1`, or hostname 'localhost'), SwarmClaw accepts self-signed certificates using a per-request `https.Agent` configured with `rejectUnauthorized: false` scoped exclusively to localhost targets. The agent is created only when the target hostname resolves to a loopback address; all other HTTPS requests use the default `rejectUnauthorized: true` behavior. SwarmClaw MUST NOT set `NODE_TLS_REJECT_UNAUTHORIZED=0` as a process-global environment variable — that mechanism disables TLS certificate validation for all outbound HTTPS connections, including those to external APIs and model providers.
- INV-5 (P1.1-V1): A2A registration requires both `agentType` and `endpointUrl` to be non-empty strings; missing or empty (zero-length or whitespace-only) → HTTP 400. (Functional behavior is asserted in AC1; this invariant pins it as a security-contract requirement, not an AC-only check.)

## Transport Contract (B1)

The A2A delegation layer uses **local HTTP POST** to the CLI-Anything harness endpoint. SwarmClaw never invokes the harness via subprocess or socket — the harness MUST be running as a local HTTP service.

**Endpoint:** `http://localhost:${process.env.SWARMCLAW_PORT || 3100}/a2a` (canonical env-var `SWARMCLAW_PORT`, default 3100 — `src/swarmclaw/index.ts:199`. The `SWARMCLAW_A2A_PORT` spelling that appeared in earlier drafts of this story does not exist in source and is retired; P1.3 already uses `SWARMCLAW_PORT`.)

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

> The `exitStatus` field carries the canonical 5-value enum `success|transient|overflow|logic|lead_failure` (CC-1). On `lead_failure`, the response is emitted by the harness supervisor (not the lead process) and carries `exitCode: <lead process exit>` alongside `exitStatus: "lead_failure"`.

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

**Fallback behavior:** If the HTTP endpoint is unavailable (connection refused), the Dev Manager returns error `-32010` (Harness unavailable) to the caller. No subprocess fallback — the harness MUST be running. This is the only fallback.

> **Retry ownership: the A2A router owns retries (P1.1-R5-2).** This paragraph previously ended "no retry-at-source logic in the A2A router", which directly contradicts the **Retry policy defaults** in Technical Notes — that section defines a 3-attempt exponential backoff performed by the router when the invocation carries `onFailure: 'retry'`. Both cannot hold. The retracted clause is the "no retry-at-source" sentence; the Retry policy is authoritative. Single owner: **the A2A router**, and only it — the transport layer performs no retries of its own, and callers MUST NOT add a second retry loop on top (doing so multiplies attempts to 9 and blows the `timeoutMs * 3 + 3s` ceiling the Retry policy declares). What the retracted sentence was *actually* getting at survives, narrowed: with the default `onFailure: 'fail'` the router does not retry, and there is no *fallback* routing at all in Phase 1 (`onFailure: 'fallback'` → -32602). Retries happen if and only if the invocation opts in with `onFailure: 'retry'`, use `requestId` as the idempotency key, and apply only to the retryable codes (-32010, -32012).

> In error responses, `requestId` appears in the top-level `error.data` object rather than alongside `result` (as in success responses). This asymmetry is intentional — error responses follow the JSON-RPC 2.0 error structure where application data nests inside `error.data`.

**Harness responsibility:** The CLI-Anything harness is responsible for translating the delegated task to a Warren invocation (`warren run <agent> <project> -p "<prompt>"` — CC-13 canonical; the `--config .canopy/agent.json` spelling in an earlier draft of this line does not exist in Warren 0.10.0 and is retracted, matching P0.3 CC-2 / P1.4 / P1.6). The A2A layer does not prescribe Warren flags — that contract belongs to P0.3/P1.6.

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
| -32012 | Delegation timeout / transient harness failure | Response not received from harness within timeoutMs, OR the harness returned `exitStatus: "transient"` (see the transient rule below). **Retryable** |
| -32013 | Agent execution error | Harness returned a non-success `exitStatus` of `logic`, `overflow`, or `lead_failure` (per CC-1), or a malformed response. **Non-retryable** |

> **`exitStatus: "transient"` maps to -32012, retryable (P1.1-R5-1).** The CC-1 enum has five values but this table previously named only three of the four failure values, leaving `transient` — the one value whose whole meaning is "retry me" — with no deterministic mapping. It does NOT fall into -32013: that code is declared non-retryable in the Retry policy, so routing a transient failure there would strip its retryability and turn a recoverable network/timeout blip into a hard failure. A harness result of `exitStatus: "transient"` is therefore returned as **-32012 (Delegation timeout / transient harness failure)**, which the Retry policy already lists as retryable, and it participates in the same 3-attempt backoff as -32010. The four failure values map: `transient` → -32012 (retryable); `logic`, `overflow`, `lead_failure` → -32013 (non-retryable). An unknown/unrecognised `exitStatus` is treated as `transient` per the CC-1 note in Technical Notes, and therefore also maps to -32012.

> Error codes -32010 through -32013 are A2A-specific. Standard JSON-RPC codes (-32600, -32601, -32602, -32000) apply for protocol-level errors. P1.3 decompose errors use -32014 through -32022 (the range widened past -32017 when P1.3 split the partial/total mirror failure and added the body-cap, single-flight and content-mismatch codes — see P1.3's Decompose Error Code Taxonomy, which is authoritative for that range).

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
- [ ] **Contract:** A2A JSON-RPC 2.0 envelope validated on ingress (jsonrpc:"2.0", method, id present). Envelope `id` absent OR `null` → `-32600` with `error.data.requestId: null`; the request is NOT delegated and no envelope id is auto-generated (Correlation ID propagation, missing-ID rule).
- [ ] **Impl (N-P1.1-NEW-1):** Import `ExitStatus` from `cli-anything/src/types.ts` (single source of truth; do not re-declare the enum locally).
- [ ] **Contract:** Transport contract verified — A2A router sends HTTP POST to harness endpoint (not subprocess); connection refused produces error -32010.
- [ ] **Integration:** CLI-Anything harness receives forwarded A2A request and returns response.
- [ ] **Integration:** timeoutMs enforced; request aborted and onFailure triggered on timeout.
- [ ] **Security:** Missing targetAgentId/requesterAgentId headers rejected with 400.
- [ ] **Test (unit):** Agent registration validates input and rejects duplicates with 409.
- [ ] **Test (unit):** A2A router forwards to correct endpoint based on targetAgentId lookup.
- [ ] **Test (forward verification):** Harness request log captures forwarded JSON-RPC envelope; body matches original A2A request (verifies AC5).
- [ ] **Test (e2e demo — MANDATORY):** Register Dev Manager → send A2A JSON-RPC call → receive correlated response; verify round-trip with < 5s latency.
- [ ] **Test (SSRF):** Register agent with endpointUrl `http://evil.com/api` → verify 422 rejection. Register with `http://localhost:3100/a2a` → verify 201.
- [ ] **Test (retry):** A2A delegation with `onFailure='retry'` to unreachable endpoint produces 3 attempts with backoff (1s, 2s) before returning error code -32010. Test verifies attempt count (3 total), not exact backoff timing, and asserts the per-attempt deadline model (each attempt gets a full `timeoutMs`; total bounded by `timeoutMs * 3 + 3s`). Backoff delays verified separately via unit test.
- [ ] **Test (agent-not-found):** A2A delegation with targetAgentId for an unregistered agent returns JSON-RPC error code -32011; no HTTP request is made to any endpoint.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
