#!/usr/bin/env bun
/**
 * In-memory Hindsight MCP stdio server for AC-1 bridge integration proof.
 *
 * Speaks line-delimited JSON-RPC 2.0 over stdin/stdout, mirroring the lifecycle
 * of tests/swarmclaw/fixtures/fake-mcp-server.ts (initialize handshake →
 * notifications/initialized → tools/list → tools/call). SwarmClaw's
 * StdioTransport cannot tell this fixture apart from a real hindsight-local-mcp
 * binary — that is the whole point: the bridge path is exercised end-to-end
 * against a deterministic seam.
 *
 * Implements the 4 Hindsight tools against an in-memory Map<bank_id, Memory[]>:
 *   - retain     — auto-creates bank, pushes memory, returns RetainResponse shape
 *   - recall     — bank-not-found → JSON-RPC error -32000 (NOT -32601/-32602,
 *                  so P0.7's bridge maps it to HTTP 502 per AC-3); substring
 *                  match with score 0.5–1.0 otherwise
 *   - reflect    — synthesizes a non-empty insight from bank contents
 *   - consolidate — no-op merge, returns ConsolidateResponse shape
 *
 * Tool input schemas are declared snake_case per the Hindsight MCP contract;
 * the P0.7 bridge translates camelCase→snake_case before dispatch (CC-8).
 */

// In-memory bank: each retained memory carries content + a stable id.
type Memory = { memoryId: string; content: string };
const banks = new Map<string, Memory[]>();
let idCounter = 0;
function nextMemoryId(): string {
  idCounter += 1;
  return `mem-${idCounter.toString().padStart(4, "0")}`;
}

function now(): number {
  return Date.now();
}

function reply(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const TOOL_DEFS = [
  {
    name: "retain",
    description: "Retain a memory in a Hindsight bank (auto-creates the bank).",
    inputSchema: {
      type: "object",
      required: ["bank_id", "content"],
      properties: {
        bank_id: { type: "string" },
        content: { type: "string" },
        metadata: { type: "object" },
      },
    },
  },
  {
    name: "recall",
    description: "Recall memories from a Hindsight bank by query.",
    inputSchema: {
      type: "object",
      required: ["bank_id", "query"],
      properties: {
        bank_id: { type: "string" },
        query: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "reflect",
    description: "Reflect on the contents of a Hindsight bank.",
    inputSchema: {
      type: "object",
      required: ["bank_id"],
      properties: {
        bank_id: { type: "string" },
        query: { type: "string" },
      },
    },
  },
  {
    name: "consolidate",
    description: "Consolidate memories in a Hindsight bank.",
    inputSchema: {
      type: "object",
      required: ["bank_id"],
      properties: {
        bank_id: { type: "string" },
        options: { type: "object" },
      },
    },
  },
];

// Token-aware substring/keyword match. Splits the query into lowercase tokens,
// scores each memory by the fraction of query tokens it contains. Returns
// results sorted by descending score; score is mapped into [0.5, 1.0] so a
// partial match still surfaces (AC-1 asserts a recalled result exists, not a
// threshold). Empty query returns all memories at score 0.5.
function recallMatches(memories: Memory[], query: string, limit: number): Array<{ content: string; score: number; memoryId: string }> {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = memories.map((m) => {
    const haystack = m.content.toLowerCase();
    let hits = 0;
    for (const t of tokens) if (haystack.includes(t)) hits += 1;
    const frac = tokens.length === 0 ? 0.5 : hits / tokens.length;
    // Map [0,1] → [0.5, 1.0] so any matching memory is surfaced; non-matching
    // (frac === 0) memories are filtered out unless the query was empty.
    const score = 0.5 + frac * 0.5;
    return { content: m.content, score, memoryId: m.memoryId, matched: frac > 0 || tokens.length === 0 };
  });
  return scored
    .filter((s) => s.matched)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit))
    .map(({ content, score, memoryId }) => ({ content, score, memoryId }));
}

function callTool(name: string, args: Record<string, unknown>): { result: unknown } | { error: { code: number; message: string } } {
  const bankId = typeof args.bank_id === "string" ? args.bank_id : "";
  switch (name) {
    case "retain": {
      const content = typeof args.content === "string" ? args.content : "";
      // Story contract: "retain to non-existent bank creates it" — first
      // retain auto-creates the bank. So retain NEVER returns bank-not-found.
      let arr = banks.get(bankId);
      const status = arr === undefined ? "created" : "updated";
      if (arr === undefined) {
        arr = [];
        banks.set(bankId, arr);
      }
      const memoryId = nextMemoryId();
      arr.push({ memoryId, content });
      return { result: { memoryId, bankId, status, durationMs: 1 } };
    }
    case "recall": {
      const arr = banks.get(bankId);
      if (arr === undefined) {
        // AC-3 seam: valid-but-nonexistent bank_id must map to HTTP 502 via
        // P0.7's bridge. The bridge maps -32601/-32602 → 400 and everything
        // else → 502, so we emit a JSON-RPC error code OUTSIDE that pair.
        // -32000 is the conventional "server error" range start.
        return { error: { code: -32000, message: `bank not found: ${bankId}` } };
      }
      const query = typeof args.query === "string" ? args.query : "";
      const limitRaw = typeof args.limit === "number" ? args.limit : 5;
      const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 5;
      const results = recallMatches(arr, query, limit);
      return { result: { results, durationMs: 2 } };
    }
    case "reflect": {
      const arr = banks.get(bankId);
      if (arr === undefined) {
        return { error: { code: -32000, message: `bank not found: ${bankId}` } };
      }
      // Synthesize a non-empty insight from bank contents. AC-1 asserts the
      // reflect response "contains a non-empty insight string". If the bank is
      // empty we still return one generic insight so the round-trip shape holds.
      const summary =
        arr.length > 0
          ? `Bank "${bankId}" holds ${arr.length} memories covering: ${arr
              .slice(0, 3)
              .map((m) => `"${m.content.slice(0, 40)}"`)
              .join(", ")}`
          : `Bank "${bankId}" is empty — no patterns detected yet.`;
      return {
        result: {
          bankId,
          insights: [{ summary, relatedMemories: arr.length }],
          durationMs: 3,
        },
      };
    }
    case "consolidate": {
      const arr = banks.get(bankId);
      if (arr === undefined) {
        return { error: { code: -32000, message: `bank not found: ${bankId}` } };
      }
      // No-op merge: dedup by exact content, preserve order. (ConsolidateResponseSchema
      // since round 1 of M3.1 review: {operation_id (required), deduplicated?} —
      // counts only ride as tolerated extras folding to 0. This MCP body
      // bypasses that parse.)
      const seen = new Set<string>();
      const merged: Memory[] = [];
      for (const m of arr) {
        if (seen.has(m.content)) continue;
        seen.add(m.content);
        merged.push(m);
      }
      const consolidatedCount = arr.length - merged.length;
      banks.set(bankId, merged);
      return {
        result: {
          consolidatedCount,
          preservedCount: merged.length,
          durationMs: 4,
        },
      };
    }
    default:
      // MCP convention: unknown tool → -32601 (mapped to HTTP 400 by the bridge).
      return { error: { code: -32601, message: `Unknown tool: ${name}` } };
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
    return; // notification — no response
  }
  if (method === "tools/list") {
    reply({ jsonrpc: "2.0", id, result: { tools: TOOL_DEFS } });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = (params?.arguments ?? {}) as Record<string, unknown>;
    const out = callTool(name, args);
    if ("error" in out) {
      reply({ jsonrpc: "2.0", id, error: out.error });
    } else {
      // MCP tools/call result wraps the payload as content[{type:"text",text:JSON}].
      reply({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(out.result) }] },
      });
    }
    return;
  }
  if (id !== undefined) {
    reply({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

async function main(): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    // {stream:true} keeps a multibyte UTF-8 char split across chunks intact.
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

// Touch `now` so the import survives tree-shaking in case a future caller wants
// to extend callTool with real timing; the current durations are constants.
void now;

// Explicit rejection handler: an unhandled rejection on the main() promise
// (e.g. Bun.stdin.stream() throws) would otherwise surface as a silent
// unhandledRejection, leaving this fixture process hanging or exiting 0 —
// which makes bridge integration tests time out instead of failing loudly.
// Log to stderr + exit non-zero on fixture crash; normal completion untouched.
main().catch((err: unknown) => {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`fake-hindsight-mcp main() failed: ${detail}\n`);
  process.exit(1);
});
