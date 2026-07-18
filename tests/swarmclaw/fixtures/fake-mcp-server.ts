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
 *   FAKE_MCP_TOOLS_FILE      — path to a comma-separated tools file re-read on EVERY
 *                              tools/list, so a test can mutate the advertised tool set at
 *                              runtime (stale-cache re-enumeration test); falls back to
 *                              FAKE_MCP_TOOLS/defaults when unset or unreadable
 *   FAKE_MCP_TOOL_DEFS_FILE  — path to a JSON file holding an array of full tool
 *                              definitions ([{name, description, inputSchema}, …]);
 *                              re-read on every tools/list and, when it parses to a
 *                              non-empty array, advertised EXACTLY as-is. Precedence:
 *                              this file wins over FAKE_MCP_NO_TOOLS /
 *                              FAKE_MCP_TOOLS_FILE / FAKE_MCP_TOOLS / defaults
 *   FAKE_MCP_NO_TOOLS        — advertise an empty tool array from tools/list
 *   FAKE_MCP_ERROR_TOOL      — tools/call for this tool name always fails with a
 *                              JSON-RPC error instead of a result (error-mapping test)
 *   FAKE_MCP_ERROR_CODE      — integer code for that error (default -32603)
 *   FAKE_MCP_ERROR_INCLUDE_FIELD — attach data:{field:"bank_id",violation:…} to that error
 *   FAKE_MCP_ECHO_ENV        — on `tools/call`, echo process.env as the result (env-isolation test)
 *   FAKE_MCP_ECHO_META       — on `tools/call`, append a content entry echoing the wire-level
 *                              params._meta.requestId (CC-9 propagation assertion)
 *   FAKE_MCP_IGNORE_SIGTERM  — ignore SIGTERM so the harness must escalate to SIGKILL
 *   FAKE_MCP_HANG            — never respond (spawn/handshake timeout test)
 *   FAKE_MCP_GARBAGE_LINE    — write one non-JSON line before every real JSON reply
 *                              (malformed-wire robustness test)
 *   FAKE_MCP_RAW_WRITE_BYTES — on `initialize`, first write N raw "x" bytes with NO
 *                              newline (trips the transport's frame-size cap); keep running
 *   FAKE_MCP_SERVER_REQUEST  — after the initialize response, send a server→client
 *                              `roots/list` request (id 99) and record whether a response
 *                              comes back; `recall` results then include
 *                              "server_request_answered": true|false
 *   FAKE_MCP_RESPONSE_DELAY_MS — hold back every response write by this many ms
 *                              (transport latency assertion)
 *   FAKE_MCP_TOOL_DELAY_MS   — JSON map {toolName: ms}; holds back the tools/call
 *                              response for the named tool by that many ms (others
 *                              reply immediately). Drives per-request first-byte
 *                              latency attribution under overlapping invokes.
 *   FAKE_MCP_STDERR_MARKER   — write this line to stderr at startup, before anything
 *                              else (stderr-tail surfacing assertion on close errors)
 */

import { readFileSync } from "node:fs";

if (process.env.FAKE_MCP_STDERR_MARKER !== undefined) {
  // Before ANYTHING else (including the exit-code short-circuit below): lets a
  // test assert the transport surfaces the subprocess' stderr tail in close errors.
  process.stderr.write(`${process.env.FAKE_MCP_STDERR_MARKER}\n`);
}

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

const rawWriteBytes = Number(process.env.FAKE_MCP_RAW_WRITE_BYTES ?? 0);
const responseDelayMs = Number(process.env.FAKE_MCP_RESPONSE_DELAY_MS ?? 0);

// Optional per-tool response delay (JSON map {toolName: ms}). Lets a test make
// one overlapping invoke slow and another fast to check per-request latency.
const toolDelayMs: Record<string, number> = (() => {
  const raw = process.env.FAKE_MCP_TOOL_DELAY_MS;
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
})();

// Set when the client answers our server→client request (id 99); only surfaced
// in recall results when FAKE_MCP_SERVER_REQUEST=1.
let serverRequestAnswered = false;

// Runtime-mutable advertised tools: when FAKE_MCP_TOOLS_FILE is set, re-read
// the file on every tools/list so a test can change the tool set mid-flight.
function currentToolNames(): string[] {
  const file = process.env.FAKE_MCP_TOOLS_FILE;
  if (file !== undefined) {
    try {
      const names = readFileSync(file, "utf8").split(",").map((s) => s.trim()).filter(Boolean);
      if (names.length > 0) return names;
    } catch {
      /* unreadable file → fall back to the static list */
    }
  }
  return toolNames;
}

// In-memory bank store: bank_id -> array of retained memory contents.
const banks = new Map<string, string[]>();

function reply(obj: unknown, extraDelayMs = 0): void {
  if (process.env.FAKE_MCP_GARBAGE_LINE === "1") {
    // Interleave one malformed line before the real reply.
    process.stdout.write("this is not json\n");
  }
  const line = `${JSON.stringify(obj)}\n`;
  const delay = responseDelayMs + extraDelayMs;
  if (delay > 0) {
    // Hold this response back so latency assertions see a measurable gap.
    setTimeout(() => process.stdout.write(line), delay);
    return;
  }
  process.stdout.write(line);
}

// Advertised tool definitions. Precedence: a valid, non-empty
// FAKE_MCP_TOOL_DEFS_FILE wins when set (full schemas for typed/required-arg
// tests); then FAKE_MCP_NO_TOOLS (empty array); then FAKE_MCP_TOOLS_FILE,
// falling back to FAKE_MCP_TOOLS/defaults. Tool-call behavior is unaffected —
// names resolve through callTool either way.
function toolDefs() {
  const defsFile = process.env.FAKE_MCP_TOOL_DEFS_FILE;
  if (defsFile !== undefined) {
    try {
      const defs = JSON.parse(readFileSync(defsFile, "utf8"));
      if (Array.isArray(defs) && defs.length > 0) return defs;
    } catch {
      /* unreadable/invalid file → fall through to the name-only knobs */
    }
  }
  if (process.env.FAKE_MCP_NO_TOOLS === "1") return [];
  return currentToolNames().map((name) => ({
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
      const payload: Record<string, unknown> = { bank_id: bankId, memories: arr };
      if (process.env.FAKE_MCP_SERVER_REQUEST === "1") {
        // Additive: report whether the client answered our roots/list request.
        payload.server_request_answered = serverRequestAnswered;
      }
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
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
    // The interval keeps the event loop alive (a bare pending promise does
    // NOT — the process would exit immediately). No SIGTERM handler is
    // installed, so the harness can still kill us.
    setInterval(() => {}, 60_000);
    await new Promise(() => {});
    return;
  }

  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    // {stream:true} keeps a multibyte UTF-8 char split across chunks intact —
    // a per-chunk decode would emit U+FFFD, break JSON.parse, and silently
    // drop the frame (request hangs until timeout).
    buf += decoder.decode(chunk, { stream: true });
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
  buf += decoder.decode(); // flush any held-back multibyte bytes
}

function handle(msg: any): void {
  const { id, method, params } = msg;
  if (process.env.FAKE_MCP_SERVER_REQUEST === "1" && method === undefined && id === 99) {
    // Response to our roots/list request — record it, send nothing back.
    serverRequestAnswered = true;
    return;
  }
  if (method === "initialize") {
    if (Number.isInteger(rawWriteBytes) && rawWriteBytes > 0) {
      // Blast N unterminated bytes at the transport to trip its frame-size cap.
      process.stdout.write("x".repeat(rawWriteBytes));
    }
    reply({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-hindsight-mcp", version: "0.0.1" },
      },
    });
    if (process.env.FAKE_MCP_SERVER_REQUEST === "1") {
      // Server→client request; the transport under test answers -32601. The
      // response (id 99) is recorded above and surfaced via `recall`.
      reply({ jsonrpc: "2.0", id: 99, method: "roots/list", params: {} });
    }
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
    const perToolDelay = typeof toolDelayMs[name] === "number" ? toolDelayMs[name]! : 0;
    if (process.env.FAKE_MCP_ERROR_TOOL !== undefined && name === process.env.FAKE_MCP_ERROR_TOOL) {
      // Simulated upstream failure: reply with the configured error code
      // instead of a result (error-mapping test).
      const parsed = Number(process.env.FAKE_MCP_ERROR_CODE);
      const error: { code: number; message: string; data?: unknown } = {
        code: Number.isInteger(parsed) ? parsed : -32603,
        message: `Simulated error from tool: ${name}`,
      };
      if (process.env.FAKE_MCP_ERROR_INCLUDE_FIELD === "1") {
        error.data = { field: "bank_id", violation: "simulated upstream violation" };
      }
      reply({ jsonrpc: "2.0", id, error });
      return;
    }
    const result = callTool(name, args);
    if (result === null) {
      // MCP convention: unknown tool -> error
      reply({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${name}` } });
      return;
    }
    if (process.env.FAKE_MCP_ECHO_META === "1") {
      // Surface the wire-level _meta.requestId as an extra content entry so a
      // test can assert CC-9 propagation all the way into the subprocess.
      result.content.push({
        type: "text",
        text: JSON.stringify({ meta_request_id: params?._meta?.requestId ?? null }),
      });
    }
    reply({ jsonrpc: "2.0", id, result }, perToolDelay);
    return;
  }
  if (id !== undefined) {
    reply({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

main();
