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

1. **(make-or-break)** Given a running SwarmClaw server and `hindsight-local-mcp` on PATH, When `POST /api/agents` (agentId, capabilities) then `POST /api/mcp-servers` (name, transport: stdio, command: `hindsight-local-mcp`) then `POST /api/mcp-servers/{id}/test` are called in sequence, Then the test response contains `{ ok: true }` and lists at least `retain`, `recall`, `reflect`, `consolidate` in the tools array.
2. Given a registered MCP server, When `POST /api/mcp-servers/{id}/invoke` is called with tool `retain` and a valid memory payload, Then the response status is 200 and the Hindsight bank receives the memory entry (verifiable via subsequent `recall`).
3. Given `hindsight-local-mcp` is NOT on PATH or returns non-zero, When `POST /api/mcp-servers/{id}/test` is called, Then the response is `{ ok: false, error: <descriptive message> }` with HTTP 502 — the server never silently returns ok for a broken transport.
4. Given an invoke request with an invalid `bank_id` (fails P0.9 BankIdSchema regex, e.g. contains uppercase, special characters, or exceeds 64 chars), When `POST /api/mcp-servers/{id}/invoke` is called with `tool: "retain"` and the invalid `bank_id`, Then the system returns MCP error `-32602` (Invalid params) with a descriptive message identifying the failing field and does NOT call the MCP server subprocess.
5. Given the default command allowlist, When MCP server registration includes `command: "npx"` with `args: ["hindsight-local-mcp"]`, Then registration succeeds (201). When `command: "python"` is submitted, Then registration is rejected (400) because shells remain excluded.
6. Given a registered MCP server with an active stdio subprocess, When the SwarmClaw server receives SIGTERM, Then all MCP subprocesses receive SIGTERM within 2 seconds, the `/test` endpoint returns `{ ok: false }` for those servers, and no orphan processes remain.
7. Given a registration attempt with `command: "node"` and `args: ["-e", "process.exit(1)"]`, When the registration is submitted, Then it is rejected with 400 because inline code execution flags (`-e`) are not permitted for runtime commands. Similarly, `command: "npx"` with `args: ["--node-arg", "-e", "malicious-code", "hindsight-local-mcp"]` is rejected with 400 because `--node-arg` passthrough is prohibited.

## Technical Notes

- **Contracts/Schema:**
  ```typescript
  // POST /api/agents
  const RegisterAgentSchema = z.object({
    agentId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$/),  // matches INV-SC1
    capabilities: z.array(z.string()).min(1),
    metadata: z.record(z.unknown()).optional(),
  });

  // POST /api/mcp-servers
  const RegisterMCPServerSchema = z.object({
    name: z.string().min(1).max(128),
    transport: z.enum(["stdio", "sse"]),
    command: z.string().optional(),        // required for stdio
    args: z.array(z.string()).default([]), // positional args passed to the subprocess
    url: z.string().url().optional(),      // required for sse
    env: z.record(z.string()).optional(),  // env vars for the subprocess
  });

  // POST /api/mcp-servers/{id}/test response
  const MCPTestResponseSchema = z.object({
    ok: z.boolean(),
    tools: z.array(z.string()).optional(),
    error: z.string().optional(),
  });

  // Arguments validated per-tool — bank_id validated against P0.9 BankIdSchema
  // when the target tool requires it (retain, recall, reflect, consolidate).
  const MCPInvokeArgumentsSchema = z.record(z.unknown()).superRefine((args, ctx) => {
    // bank_id validation: if present, must match P0.9 BankIdSchema regex
    // /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/ — enforces 1–64 character length
    // (alphanumeric start/end, with hyphens allowed in the middle)
    if ('bank_id' in args && typeof args.bank_id === 'string') {
      const bankIdRegex = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
      if (!bankIdRegex.test(args.bank_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `bank_id "${args.bank_id}" fails BankIdSchema validation (P0.9)`,
          path: ['bank_id'],
        });
      }
    }
  });

  // POST /api/mcp-servers/{id}/invoke
  const MCPInvokeSchema = z.object({
    tool: z.string(),
    arguments: MCPInvokeArgumentsSchema,
  });
  ```

  **Invoke validation flow:** Before MCP tool invocation, validate `arguments` against the tool's declared parameter schema. If validation fails, return MCP error `-32602` (Invalid params) with diagnostic detail including field path and failure reason. Do NOT forward the request to the MCP server.

  **Tool enumeration caching:** Tool lists returned by `/test` are cached per MCP server registration. Cache TTL is 5 minutes (configurable via `SWARMCLAW_TOOL_CACHE_TTL_MS`). `/invoke` with an unknown tool (not in cache) triggers an on-demand re-enumeration before failing. This prevents stale-tool calls after MCP server restarts or updates.

  **Downstream contract stability:** P0.9 (Hindsight banks) and P1.1 (A2A delegation) depend on this story's MCP invoke bridge and agent registry interfaces. Breaking changes to `RegisterAgentSchema`, `MCPInvokeSchema`, `MCPInvokeArgumentsSchema`, or the `/api/mcp-servers/{id}/invoke` response format MUST be treated as BLOCKER-level changes requiring coordinated updates to P0.9 and P1.1. The Dependency edges section in P0.9 and P1.1 reference these schemas by name.

- **Integration points (each wired & exercised in this story):**
  - SwarmClaw `/api/agents` endpoint — agent CRUD
  - SwarmClaw `/api/mcp-servers` endpoint — MCP server registration
  - SwarmClaw `/api/mcp-servers/{id}/test` endpoint — transport health + tool enumeration
  - SwarmClaw `/api/mcp-servers/{id}/invoke` endpoint — tool invocation bridge with argument validation
  - `hindsight-local-mcp` subprocess — stdio transport lifecycle (spawn, handshake, list-tools, call-tool)

- **Cross-story validation contract:**
  - `bank_id` in MCP invoke arguments is validated against P0.9's `BankIdSchema` regex (`/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/`) at the SwarmClaw boundary before any request reaches the MCP server. P0.9 owns the canonical schema definition; P0.7 references it for pre-flight validation.

- **Files / functions touched:**
  - `src/swarmclaw/routes/agents.ts` — POST handler
  - `src/swarmclaw/routes/mcp-servers.ts` — POST register, POST test, POST invoke
  - `src/swarmclaw/mcp/stdio-transport.ts` — subprocess lifecycle management
  - `src/swarmclaw/mcp/tool-bridge.ts` — tool enumeration and invocation
  - `src/swarmclaw/store/agent-store.ts` — in-memory agent registry
  - `src/swarmclaw/store/mcp-store.ts` — in-memory MCP server registry

- **Guards/limits:**
  - MCP server subprocess spawn timeout: 10 seconds
  - Tool invocation timeout: configurable via `SWARMCLAW_INVOKE_TIMEOUT_MS` env var; default **120 seconds**. Invoke timeout must be ≥ P0.9 consolidate timeout (60s default). P0.7 default raised to 120s to accommodate all P0.9 operations.
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

- **INV-SC1:** Agent registration requires `agentId` matching `^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$` — no special chars, no path traversal.
- **INV-SC2:** MCP server `command` field is validated against a configurable allowlist. The default allowlist includes:
  - `hindsight-local-mcp` — compiled binary on PATH
  - `node` — Node.js runtime (required when `hindsight-local-mcp` is installed as an npm package)
  - `npx` — npm package runner (required for dev/CI invocation of `npx hindsight-local-mcp`)
  - `node_modules/.bin/hindsight-local-mcp` — local npm binary path (resolved to absolute path at startup based on SwarmClaw installation root; relative allowlist entries are canonicalized before comparison to prevent working-directory manipulation)
  When `command` is a general-purpose runtime (`node` or `npx`), the `args` array is validated against code-injection rules at registration time (before any subprocess is spawned):
    - **`node`:** args must not contain `-e`, `--eval`, `-p`, `--print`, `-` (stdin mode), or `--require`/`-r` with a non-absolute path. Only script file paths (absolute or relative to the MCP server working directory) and Node.js CLI flags that do not enable inline code execution are permitted. Flags that accept inline JavaScript or stdin input are rejected with 400.
    - **`npx`:** args must not contain `--node-arg`, `--node-args`, `-e`, or `--eval`. The first positional arg must be a valid npm package identifier (matching `^(@[a-z0-9][\w.-]*/)?[a-z0-9][\w.-]*$`). Flags that pass arbitrary arguments to the Node.js runtime are rejected with 400.
    - **Validation timing:** args are validated at MCP server registration time; invalid args produce a 400 response before any subprocess is spawned.
  The allowlist is extended via environment variable `SWARMCLAW_COMMAND_ALLOWLIST` (comma-separated absolute or basename paths, merged with defaults at startup). Arbitrary or unrecognized commands are rejected with 400. General-purpose shells (`sh`, `bash`, `zsh`, `python`, `python3`) remain excluded from both default and configurable allowlists because they enable unrestricted code execution regardless of argument restrictions.
- **INV-SC3:** Environment variables passed to MCP server subprocesses are sourced ONLY from an explicit `env` map in the registration payload — never inherited from SwarmClaw's own process environment unless explicitly listed in a server-side allowlist (`SWARMCLAW_ENV_ALLOWLIST`).
- **INV-SC4:** MCP server subprocess runs with no network listeners; stdio is the only communication channel. If the subprocess opens a TCP socket, the transport layer kills it within the spawn timeout.
- **INV-SC5:** Secrets (API keys, tokens) in MCP server `env` are never logged or returned in GET/test responses — values are masked to `***` in any diagnostic output.

## Cross-Cutting Convention Notes

- **Naming convention (CC-8):** JSON payloads at the SwarmClaw→MCP boundary use camelCase (`agentId`, not `agent_id`). Hindsight tool args may use snake_case internally (`bank_id`, `tool_name`) — the MCP bridge performs translation at the boundary. No existing fields are renamed; this note documents the convention for implementers.

## Observability Contract (CC-9)

Every MCP operation emits a structured log entry with the following minimum shape:

```
{
  requestId:   string,        // UUID, propagates across SwarmClaw→MCP→Hindsight boundary
  operation:   string,        // e.g. "mcp.test", "mcp.invoke", "agent.register"
  agentId:     string | null, // originating agent, if known
  timestamp:   string,        // ISO 8601
  duration:    number,        // ms elapsed for this operation
  status:      "ok" | "error",
  error?: { code: string, message: string, stack?: string }
}
```

Additional MCP bridge timing fields:
- `tool_enumeration_ms` — time to complete MCP `list-tools` handshake
- `invoke_duration_ms` — time from tool call dispatch to subprocess response
- `stdio_latency_ms` — round-trip stdio message latency

If the story already has a partial observability mechanism (e.g. coms-log), it is extended to match this contract. No operation may omit the `requestId` propagation — it is the join key for cross-layer tracing.

## Definition of Done

> 8–12 high-signal, story-specific boxes. NO lint/tests/typecheck filler.

- [ ] **Impl:** `POST /api/agents` creates an agent record with id, capabilities, and metadata; returns 201 with agent object
- [ ] **Impl:** `POST /api/mcp-servers` spawns stdio transport to `hindsight-local-mcp`, completes MCP handshake (initialize + list-tools), stores server record; returns 201
- [ ] **Impl:** `POST /api/mcp-servers/{id}/test` re-validates transport health and returns `{ ok: true, tools: [...] }`
- [ ] **Impl:** `POST /api/mcp-servers/{id}/invoke` proxies a tool call to the MCP subprocess and returns the result
- [ ] **Contract:** Zod schemas for `RegisterAgentSchema`, `RegisterMCPServerSchema`, `MCPTestResponseSchema`, `MCPInvokeSchema`, `MCPInvokeArgumentsSchema` validated on all routes
- [ ] **Integration:** stdio transport lifecycle (spawn, handshake, invoke, graceful shutdown) wired and exercised end-to-end with `hindsight-local-mcp`
- [ ] **Security:** INV-SC1 through INV-SC5 enforced — agentId validated, command allowlist checked (including `node`/`npx` entries per INV-SC2), args validated against code-injection rules for runtime commands, env isolation confirmed, no secrets leaked in responses
- [ ] **Test (unit/integration):** Agent registration + MCP registration + test endpoint returns ok:true with Hindsight tools listed; invoke retains a memory and recalls it
- [ ] **Test (validation guard):** Invoke with invalid `bank_id` (fails P0.9 BankIdSchema regex) returns error `-32602` and does NOT call MCP server subprocess
- [ ] **Test (allowlist coverage):** Default allowlist verified to include `node`, `npx`, `hindsight-local-mcp`, and `node_modules/.bin/hindsight-local-mcp`; shells (`sh`, `bash`, `python`) verified excluded; args validation verified — `node -e`/`--eval`/`-p`/`--print`/`-` rejected, `npx --node-arg`/`--node-args` rejected, valid args accepted
- [ ] **Test (guard):** Missing `hindsight-local-mcp` binary produces `{ ok: false, error: ... }` with HTTP 502 — never silently succeeds
- [ ] **Test (e2e demo — MANDATORY):** Sequential script: register agent → register MCP server → test → invoke `retain` → invoke `recall` → assert recalled content matches retained content
- [ ] **Test (lifecycle):** SIGTERM to SwarmClaw server propagates to MCP subprocesses; verify no orphan processes after shutdown
- [ ] **Test (cache):** Invoke with tool not in cached list triggers re-enumeration; subsequent invoke succeeds
