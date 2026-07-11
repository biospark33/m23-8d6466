#!/usr/bin/env bun
/**
 * Fake MCP stdio server for deterministic SwarmClaw tests.
 *
 * Speaks line-delimited JSON-RPC 2.0 over stdin/stdout, implementing the subset
 * of the MCP protocol P0.7 exercises: `initialize`, `tools/list`, `tools/call`
 * for the Hindsight tools (retain, recall, reflect, consolidate).
 *
 * The real `hindsight-local-mcp` binary in this environment is an HTTP server
 * (localhost:8888/mcp/) requiring embedded Postgres + an LLM key — it does not
 * speak stdio JSON-RPC. This fixture stands in for the deterministic suite; a
 * separate integration test probes the real binary.
 *
 * Behavior knobs via env / args (all optional):
 *   FAKE_MCP_EXIT_CODE       — exit immediately with this code (simulates broken transport)
 *   FAKE_MCP_TOOLS           — comma-separated override of advertised tool names
 *   FAKE_MCP_ECHO_ENV        — on `tools/call`, echo process.env as the result (env-isolation test)
 *   FAKE_MCP_IGNORE_SIGTERM  — ignore SIGTERM so the harness must escalate to SIGKILL
 *   FAKE_MCP_HANG            — never respond (spawn/handshake timeout test)
 */

const exitCode = process.env.FAKE_MCP_EXIT_CODE;
if (exitCode !== undefined) {
  process.exit(Number(exitCode));
}

if (process.env.FAKE_MCP_IGNORE_SIGTERM === "1") {
  // Simulate a stubborn subprocess: swallow SIGTERM so the lifecycle manager
  // must escalate to SIGKILL after the grace window.
  process.on("SIGTERM", () => {
    /* deliberately ignored */
  });
}

const DEFAULT_TOOLS = ["retain", "recall", "reflect", "consolidate"];
const toolNames = process.env.FAKE_MCP_TOOLS
  ? process.env.FAKE_MCP_TOOLS.split(",").map((s) => s.trim()).filter(Boolean)
  : DEFAULT_TOOLS;

// In-memory bank store: bank_id -> array of retained memory contents.
const banks = new Map<string, string[]>();

function reply(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function toolDefs() {
  return toolNames.map((name) => ({
    name,
    description: `fake hindsight tool ${name}`,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
  }));
}

function callTool(name: string, args: Record<string, unknown>) {
  const bankId = typeof args.bank_id === "string" ? args.bank_id : "default";
  if (process.env.FAKE_MCP_ECHO_ENV === "1") {
    return { content: [{ type: "text", text: JSON.stringify(process.env) }] };
  }
  switch (name) {
    case "retain": {
      const content = typeof args.content === "string" ? args.content : JSON.stringify(args.content ?? "");
      const arr = banks.get(bankId) ?? [];
      arr.push(content);
      banks.set(bankId, arr);
      return { content: [{ type: "text", text: JSON.stringify({ retained: true, bank_id: bankId, count: arr.length }) }] };
    }
    case "recall": {
      const arr = banks.get(bankId) ?? [];
      return { content: [{ type: "text", text: JSON.stringify({ bank_id: bankId, memories: arr }) }] };
    }
    case "reflect":
      return { content: [{ type: "text", text: JSON.stringify({ reflected: true, bank_id: bankId }) }] };
    case "consolidate":
      return { content: [{ type: "text", text: JSON.stringify({ consolidated: true, bank_id: bankId }) }] };
    default:
      return null; // signal unknown tool
  }
}

async function main(): Promise<void> {
  if (process.env.FAKE_MCP_HANG === "1") {
    // Read nothing, respond to nothing — force spawn/handshake timeouts.
    await new Promise(() => {});
    return;
  }

  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk);
    let idx: number;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard line-buffer drain
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      handle(msg);
    }
  }
}

function handle(msg: any): void {
  const { id, method, params } = msg;
  if (method === "initialize") {
    reply({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-hindsight-mcp", version: "0.0.1" },
      },
    });
    return;
  }
  if (method === "notifications/initialized") {
    return; // notification, no response
  }
  if (method === "tools/list") {
    reply({ jsonrpc: "2.0", id, result: { tools: toolDefs() } });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = (params?.arguments ?? {}) as Record<string, unknown>;
    const result = callTool(name, args);
    if (result === null) {
      // MCP convention: unknown tool -> error
      reply({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${name}` } });
      return;
    }
    reply({ jsonrpc: "2.0", id, result });
    return;
  }
  if (id !== undefined) {
    reply({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

main();
