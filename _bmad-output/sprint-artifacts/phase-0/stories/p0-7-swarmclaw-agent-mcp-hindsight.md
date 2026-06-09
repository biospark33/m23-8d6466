# P0.7: Register SwarmClaw Agent + MCP Server for Hindsight Memory

**Story Points:** 4

## Spec Reference

- PRD §8 (SwarmClaw Protocol Engine); FR-CP-9, FR-CP-10, FR-CP-11
- Phase exit gate: PRD §13 Phase 0 clause 7

## User Story

As a QDS dev agent orchestrator,
I want to register a SwarmClaw agent and bind it to the Hindsight MCP server through the SwarmClaw registry,
so that any protocol phase can invoke Hindsight memory tools (retain, recall, reflect, consolidate) without bespoke wiring (G2 — shared substrate).

## Overview

This story wires SwarmClaw's agent registry (`/api/agents`) and MCP server registry (`/api/mcp-servers`) end-to-end. An agent is registered with a declared capability set, then the Hindsight MCP server is registered with stdio transport pointing to `hindsight-local-mcp` on PATH. The `/api/mcp-servers/[id]/test` endpoint is exercised to confirm the MCP bridge is live. This is a 4-point atomic unit because it touches the SwarmClaw HTTP surface, the MCP transport layer, and the Hindsight binary — three layers that must close together before any higher story can rely on memory.

## E2E Slice

**Demonstrable behavior:** Register a SwarmClaw agent via `POST /api/agents`, register the Hindsight MCP server via `POST /api/mcp-servers` with stdio transport pointing to `hindsight-local-mcp`, then call `POST /api/mcp-servers/{id}/test` and receive `{ ok: true, tools: ["retain", "recall", "reflect", "consolidate"] }`.

**Wiring closed:** On completion of this story, registering an agent and an MCP server produces a verified, tool-enumerated MCP bridge using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** None — standalone.

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given a running SwarmClaw server and `hindsight-local-mcp` on PATH, When `POST /api/agents` (agent_id, capabilities) then `POST /api/mcp-servers` (name, transport: stdio, command: `hindsight-local-mcp`) then `POST /api/mcp-servers/{id}/test` are called in sequence, Then the test response contains `{ ok: true }` and lists at least `retain`, `recall`, `reflect`, `consolidate` in the tools array.
2. Given a registered MCP server, When `POST /api/mcp-servers/{id}/invoke` is called with tool `retain` and a valid memory payload, Then the response status is 200 and the Hindsight bank receives the memory entry (verifiable via subsequent `recall`).
3. Given `hindsight-local-mcp` is NOT on PATH or returns non-zero, When `POST /api/mcp-servers/{id}/test` is called, Then the response is `{ ok: false, error: <descriptive message> }` with HTTP 502 — the server never silently returns ok for a broken transport.

## Technical Notes

- **Contracts/Schema:**
  ```typescript
  // POST /api/agents
  const RegisterAgentSchema = z.object({
    agent_id: z.string().min(1).max(128),
    capabilities: z.array(z.string()).min(1),
    metadata: z.record(z.unknown()).optional(),
  });

  // POST /api/mcp-servers
  const RegisterMCPServerSchema = z.object({
    name: z.string().min(1).max(128),
    transport: z.enum(["stdio", "sse"]),
    command: z.string().optional(),        // required for stdio
    url: z.string().url().optional(),      // required for sse
    env: z.record(z.string()).optional(),  // env vars for the subprocess
  });

  // POST /api/mcp-servers/{id}/test response
  const MCPTestResponseSchema = z.object({
    ok: z.boolean(),
    tools: z.array(z.string()).optional(),
    error: z.string().optional(),
  });

  // POST /api/mcp-servers/{id}/invoke
  const MCPInvokeSchema = z.object({
    tool: z.string(),
    arguments: z.record(z.unknown()),
  });
  ```

- **Integration points (each wired & exercised in this story):**
  - SwarmClaw `/api/agents` endpoint — agent CRUD
  - SwarmClaw `/api/mcp-servers` endpoint — MCP server registration
  - SwarmClaw `/api/mcp-servers/{id}/test` endpoint — transport health + tool enumeration
  - SwarmClaw `/api/mcp-servers/{id}/invoke` endpoint — tool invocation bridge
  - `hindsight-local-mcp` subprocess — stdio transport lifecycle (spawn, handshake, list-tools, call-tool)

- **Files / functions touched:**
  - `src/swarmclaw/routes/agents.ts` — POST handler
  - `src/swarmclaw/routes/mcp-servers.ts` — POST register, POST test, POST invoke
  - `src/swarmclaw/mcp/stdio-transport.ts` — subprocess lifecycle management
  - `src/swarmclaw/mcp/tool-bridge.ts` — tool enumeration and invocation
  - `src/swarmclaw/store/agent-store.ts` — in-memory agent registry
  - `src/swarmclaw/store/mcp-store.ts` — in-memory MCP server registry

- **Guards/limits:**
  - MCP server subprocess spawn timeout: 10 seconds
  - Tool invocation timeout: 30 seconds
  - Maximum registered MCP servers: 32
  - Maximum registered agents: 64
  - stdio transport must validate process exits cleanly on server shutdown

## Files to Modify

> ≤10 unique paths, one per line.
- `src/swarmclaw/routes/agents.ts`
- `src/swarmclaw/routes/mcp-servers.ts`
- `src/swarmclaw/mcp/stdio-transport.ts`
- `src/swarmclaw/mcp/tool-bridge.ts`
- `src/swarmclaw/store/agent-store.ts`
- `src/swarmclaw/store/mcp-store.ts`
- `src/swarmclaw/index.ts`
- `tests/swarmclaw/agent-mcp-registration.test.ts`
- `tests/swarmclaw/mcp-stdio-transport.test.ts`

## Security Invariants

> Concrete named invariants only — N/A NOT permitted when triggered.

- **INV-SC1:** Agent registration requires `agent_id` matching `^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$` — no special chars, no path traversal.
- **INV-SC2:** MCP server `command` field is validated against an allowlist of known binaries (`hindsight-local-mcp`, `node`, `npx`) — arbitrary command injection is rejected with 400.
- **INV-SC3:** Environment variables passed to MCP server subprocesses are sourced ONLY from an explicit `env` map in the registration payload — never inherited from SwarmClaw's own process environment unless explicitly listed in a server-side allowlist (`SWARMCLAW_ENV_ALLOWLIST`).
- **INV-SC4:** MCP server subprocess runs with no network listeners; stdio is the only communication channel. If the subprocess opens a TCP socket, the transport layer kills it within the spawn timeout.
- **INV-SC5:** Secrets (API keys, tokens) in MCP server `env` are never logged or returned in GET/test responses — values are masked to `***` in any diagnostic output.

## Definition of Done

> 8–12 high-signal, story-specific boxes. NO lint/tests/typecheck filler.

- [ ] **Impl:** `POST /api/agents` creates an agent record with id, capabilities, and metadata; returns 201 with agent object
- [ ] **Impl:** `POST /api/mcp-servers` spawns stdio transport to `hindsight-local-mcp`, completes MCP handshake (initialize + list-tools), stores server record; returns 201
- [ ] **Impl:** `POST /api/mcp-servers/{id}/test` re-validates transport health and returns `{ ok: true, tools: [...] }`
- [ ] **Impl:** `POST /api/mcp-servers/{id}/invoke` proxies a tool call to the MCP subprocess and returns the result
- [ ] **Contract:** Zod schemas for `RegisterAgentSchema`, `RegisterMCPServerSchema`, `MCPTestResponseSchema`, `MCPInvokeSchema` validated on all routes
- [ ] **Integration:** stdio transport lifecycle (spawn, handshake, invoke, graceful shutdown) wired and exercised end-to-end with `hindsight-local-mcp`
- [ ] **Security:** INV-SC1 through INV-SC5 enforced — agent_id validated, command allowlist checked, env isolation confirmed, no secrets leaked in responses
- [ ] **Test (unit/integration):** Agent registration + MCP registration + test endpoint returns ok:true with Hindsight tools listed; invoke retains a memory and recalls it
- [ ] **Test (guard):** Missing `hindsight-local-mcp` binary produces `{ ok: false, error: ... }` with HTTP 502 — never silently succeeds
- [ ] **Test (e2e demo — MANDATORY):** Sequential script: register agent → register MCP server → test → invoke `retain` → invoke `recall` → assert recalled content matches retained content
