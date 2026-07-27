/**
 * Unit tests for `scripts/lib/mcp-stdio-client.ts` (issue #64).
 *
 * This is the newline-framed JSON-RPC layer that `pi-lens-verify` and
 * `lsp-verify` both sit on — and the Phase-0 gate reuses BOTH of those
 * verifiers, so a framing defect here is a gate defect. The tests drive a real
 * child process (a fake MCP server written to a temp dir) because the framing,
 * the chunk boundaries and the process lifecycle ARE the unit under test.
 *
 * Every case targets a way the layer could report success it did not earn:
 *   - a frame split across chunks, or arriving after unrelated noise
 *   - a response whose id does not match, or arriving out of order
 *   - a JSON-RPC *error* response resolving as if it were a result
 *   - a dead server that lets a later rpc burn its whole deadline
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_INIT_TIMEOUT_MS,
  McpClient,
  parseToolJsonText,
  resolveNodeRuntime,
  toolText,
  type McpToolResult,
} from "../../scripts/lib/mcp-stdio-client.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

/**
 * A fake newline-framed MCP server. `MODE` selects how it (mis)behaves — the
 * point of each mode is named at its branch.
 */
const SERVER = `
const MODE = process.env.MODE || "normal";
let buf = "";
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const ok = (id, text) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
const held = [];

process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    handle(JSON.parse(line));
  }
});

function handle(msg) {
  if (msg.id === undefined) return; // notification
  if (MODE === "silent") return;
  if (MODE === "crash") { process.stderr.write("fake server is dying\\n"); process.exit(7); }
  if (MODE === "initerror" && msg.method === "initialize") {
    return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "unsupported protocolVersion" } });
  }
  if (MODE === "callerror" && msg.method === "tools/call") {
    return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such tool" } });
  }
  if (MODE === "reorder") {
    // Answer initialize immediately, then hold the next two calls and reply
    // to them in REVERSE order: id routing must not depend on arrival order.
    if (msg.method === "initialize") return out(ok(msg.id, "init"));
    held.push(msg);
    if (held.length === 2) { out(ok(held[1].id, "second")); out(ok(held[0].id, "first")); }
    return;
  }
  const text = JSON.stringify({ method: msg.method, args: (msg.params && msg.params.arguments) || null });
  if (MODE === "byte" && msg.method !== "initialize") {
    // One byte per tick: exercises a frame reassembled from many chunks.
    const s = JSON.stringify(ok(msg.id, text)) + "\\n";
    let k = 0;
    const t = setInterval(() => {
      process.stdout.write(s[k++]);
      if (k >= s.length) clearInterval(t);
    }, 0);
    return;
  }
  if (MODE === "noise" && msg.method !== "initialize") {
    // Interleaved non-JSON logging, a blank line, a notification with no id,
    // and a response for an id nobody is waiting on — none may disturb routing.
    process.stdout.write("plain log line, not JSON\\n\\n");
    process.stdout.write("{ truncated json\\n");
    out({ jsonrpc: "2.0", method: "notifications/progress", params: {} });
    out(ok(9999, "response to an id nobody awaited"));
    return out(ok(msg.id, text));
  }
  if (MODE === "nullresult" && msg.method === "tools/call") {
    return out({ jsonrpc: "2.0", id: msg.id, result: null });
  }
  if (MODE === "stringresult" && msg.method === "tools/call") {
    return out({ jsonrpc: "2.0", id: msg.id, result: "just a string" });
  }
  if (MODE === "arrayresult" && msg.method === "tools/call") {
    return out({ jsonrpc: "2.0", id: msg.id, result: [{ type: "text", text: "hi" }] });
  }
  if (MODE === "numberresult" && msg.method === "tools/call") {
    return out({ jsonrpc: "2.0", id: msg.id, result: 42 });
  }
  if (MODE === "big" && msg.method !== "initialize") {
    return out(ok(msg.id, "y".repeat(2 * 1024 * 1024)));
  }
  out(ok(msg.id, text));
}
`;

const serverPath = path.join(tmpRoot, "fake-mcp-server.cjs");
fs.writeFileSync(serverPath, SERVER);

function client(mode = "normal"): McpClient {
  return new McpClient(serverPath, tmpRoot, { ...process.env, MODE: mode });
}

describe("McpClient — newline framing", () => {
  test("a normal request/response round trip carries the arguments through", async () => {
    const c = client();
    try {
      await c.init(5_000);
      const res = await c.call("pilens_analyze", { path: "src" }, 5_000);
      expect(parseToolJsonText(toolText(res))).toEqual({
        method: "tools/call",
        args: { path: "src" },
      });
    } finally {
      c.close();
    }
  });

  test("a frame delivered one byte at a time is reassembled, not dropped", async () => {
    const c = client("byte");
    try {
      await c.init(5_000);
      const res = await c.call("t", { a: 1 }, 8_000);
      expect(parseToolJsonText(toolText(res))?.args).toEqual({ a: 1 });
    } finally {
      c.close();
    }
  });

  test("garbage lines, blank lines, notifications and stray ids do not break routing", async () => {
    const c = client("noise");
    try {
      await c.init(5_000);
      const res = await c.call("t", { a: 2 }, 8_000);
      // The response we get back must be OURS, not the stray id-9999 frame.
      expect(parseToolJsonText(toolText(res))?.args).toEqual({ a: 2 });
    } finally {
      c.close();
    }
  });

  test("out-of-order responses are routed by id, not by arrival order", async () => {
    const c = client("reorder");
    try {
      await c.init(5_000);
      const [a, b] = await Promise.all([c.call("first", {}, 8_000), c.call("second", {}, 8_000)]);
      expect(toolText(a)).toBe("first");
      expect(toolText(b)).toBe("second");
    } finally {
      c.close();
    }
  });

  test("a multi-megabyte single frame survives reassembly", async () => {
    const c = client("big");
    try {
      await c.init(5_000);
      const res = await c.call("t", {}, 20_000);
      expect(toolText(res)).toHaveLength(2 * 1024 * 1024);
    } finally {
      c.close();
    }
  }, 30_000);
});

describe("McpClient — failures are never reported as success", () => {
  test("an error response to `initialize` fails the handshake", async () => {
    // The rpc layer RESOLVES error responses (that is how `call` surfaces tool
    // errors), so init must inspect the envelope or a rejected handshake reads
    // as a successful one and the harness keeps going against a dead server.
    const c = client("initerror");
    try {
      await expect(c.init(5_000)).rejects.toThrow("unsupported protocolVersion");
    } finally {
      c.close();
    }
  });

  test("an error response to `tools/call` comes back flagged isError", async () => {
    const c = client("callerror");
    try {
      await c.init(5_000);
      const res = await c.call("nope", {}, 5_000);
      expect(res.isError).toBe(true);
      expect(res.content).toBeUndefined();
      // ...and must not be mistaken for a structured payload.
      expect(toolText(res)).toBe("");
    } finally {
      c.close();
    }
  });

  test("a null `result` is flagged isError rather than returned as a blank success", async () => {
    // `?? ` is nullish-coalescing, so `result: null` correctly falls through to
    // the error branch. A truthy-but-empty result would NOT — see below.
    const c = client("nullresult");
    try {
      await c.init(5_000);
      const res = await c.call("t", {}, 5_000);
      expect(res.isError).toBe(true);
    } finally {
      c.close();
    }
  });

  test.each([
    ["stringresult", "string"],
    ["arrayresult", "array"],
    ["numberresult", "number"],
  ])("FIXED (#83): a non-object `result` (%s) is flagged isError, not silently empty", async (mode, kind) => {
    // Was pinned as a latent surface: a server answering with a bare string
    // left isError unset and toolText "", so a caller could not tell "nothing
    // to report" from "no evidence produced". Now the client names the shape it
    // got. toolText stays "" — the point is that isError says why.
    const c = client(mode);
    try {
      await c.init(5_000);
      const res = await c.call("t", {}, 5_000);
      expect(res.isError).toBe(true);
      expect(String(res.error)).toContain(`expected an object result, got ${kind}`);
      expect(String(res.error)).toContain("tools/call t");
      expect(toolText(res)).toBe("");
      expect(parseToolJsonText(toolText(res))).toBeUndefined();
    } finally {
      c.close();
    }
  });

  test("a silent server times out with the method name in the error", async () => {
    const c = client("silent");
    try {
      await expect(c.init(300)).rejects.toThrow(/rpc initialize timed out after 300ms/);
    } finally {
      c.close();
    }
  });

  test("a crashing server rejects the outstanding rpc with its exit info and stderr", async () => {
    const c = client("crash");
    try {
      const err = await c.init(10_000).catch((e: Error) => e);
      expect(String(err)).toContain("server exited");
      expect(String(err)).toContain("fake server is dying");
    } finally {
      c.close();
    }
  });

  test("an rpc issued AFTER the server died fails fast instead of burning its deadline", async () => {
    const c = client("crash");
    try {
      await c.init(10_000).catch(() => {});
      const started = Date.now();
      await expect(c.call("t", {}, 30_000)).rejects.toThrow("server exited");
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      c.close();
    }
  });

  test("an unspawnable server binary rejects rather than hanging", async () => {
    const c = new McpClient(path.join(tmpRoot, "no-such-server.cjs"), tmpRoot, process.env);
    try {
      await expect(c.init(10_000)).rejects.toThrow(/rpc initialize failed/);
    } finally {
      c.close();
    }
  });

  test("rpcs after close() reject, and close() is idempotent", async () => {
    const c = client();
    await c.init(5_000);
    c.close();
    c.close();
    await expect(c.call("t", {}, 5_000)).rejects.toThrow("client closed");
  });

  test("the default init deadline is bounded", () => {
    expect(DEFAULT_INIT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_INIT_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});

describe("resolveNodeRuntime", () => {
  test("PILENS_NODE wins when set", () => {
    const prev = process.env.PILENS_NODE;
    process.env.PILENS_NODE = "/custom/node";
    try {
      expect(resolveNodeRuntime()).toBe("/custom/node");
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "PILENS_NODE");
      else process.env.PILENS_NODE = prev;
    }
  });

  test("a blank PILENS_NODE is ignored rather than spawning the empty string", () => {
    const prev = process.env.PILENS_NODE;
    process.env.PILENS_NODE = "   ";
    try {
      expect(resolveNodeRuntime()).not.toBe("   ");
      expect(resolveNodeRuntime().length).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "PILENS_NODE");
      else process.env.PILENS_NODE = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// Payload parsing — pure, and the place a non-envelope can be coerced into one.
// ---------------------------------------------------------------------------

describe("toolText", () => {
  test("concatenates every content block with newlines", () => {
    expect(toolText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb");
  });

  test("a block with no text contributes an empty string, not `undefined`", () => {
    expect(toolText({ content: [{ type: "image" }, { type: "text", text: "b" }] })).toBe("\nb");
  });

  test("a result with no content is empty text, not a throw", () => {
    expect(toolText({})).toBe("");
    expect(toolText({ isError: true } as McpToolResult)).toBe("");
  });
});

describe("parseToolJsonText — only real envelopes parse", () => {
  test("a fenced ```json block after a summary line is extracted", () => {
    expect(parseToolJsonText('Analyzed 3 files.\n```json\n{"warnings":2}\n```')).toEqual({ warnings: 2 });
  });

  test("bare JSON with no fence is accepted", () => {
    expect(parseToolJsonText('{"ok":true}')).toEqual({ ok: true });
  });

  test("surrounding whitespace does not defeat the bare form", () => {
    expect(parseToolJsonText('\n  {"ok":true}\n ')).toEqual({ ok: true });
  });

  const notAnEnvelope: Array<[string, string]> = [
    ["", "empty text"],
    ["   \n\t ", "whitespace only"],
    ["diagnostics: 0 errors, 0 warnings", "human-readable text"],
    ['[{"a":1}]', "a top-level array"],
    ["42", "a bare number"],
    ['"a string"', "a bare string"],
    ["null", "a bare null"],
    ['{"a":1', "truncated JSON"],
    ['{"a":1} trailing junk', "JSON with trailing junk"],
    ["```json\n{\"a\":1}", "an unterminated fence with no bare-JSON fallback"],
    ['```json\n{"a":1\n```', "a fence containing broken JSON"],
  ];

  for (const [text, label] of notAnEnvelope) {
    test(`${label} yields undefined so callers fall back to the text surface`, () => {
      expect(parseToolJsonText(text)).toBeUndefined();
    });
  }

  test("a fenced array is rejected — an array is not an envelope", () => {
    expect(parseToolJsonText('summary\n```json\n[1,2]\n```')).toBeUndefined();
  });

  test("the fence wins over surrounding prose that also contains braces", () => {
    expect(parseToolJsonText('{not json}\n```json\n{"real":1}\n```')).toEqual({ real: 1 });
  });
});
