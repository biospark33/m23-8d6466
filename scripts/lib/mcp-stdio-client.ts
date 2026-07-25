/**
 * Minimal MCP stdio client (JSON-RPC 2.0, newline-framed) + tool-result parsing.
 *
 * Shared by every pi-lens verification harness (`scripts/pi-lens-verify.ts`
 * P0.5, `scripts/lsp-verify.ts` P0.6, and whatever P0.11 / P1.7 need next).
 * It was previously copy-adapted per harness, which meant each defect had to be
 * fixed in N places; this module is the single implementation.
 *
 * Transport note: pi-lens's MCP server speaks **newline-delimited** JSON-RPC on
 * stdio — one JSON object per line. That is NOT LSP's `Content-Length` +
 * CRLFCRLF framing, even though the server brokers LSP underneath.
 */

import { execFileSync, spawn } from "node:child_process";
import { harnessNotes } from "./harness-notes.ts";

export interface McpToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  error?: unknown;
  /** Some surfaces (the agent-facing tools) attach a structured payload here. */
  details?: Record<string, unknown>;
}

interface PendingRpc {
  method: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (msg: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

/**
 * Runtime for the MCP server child. pi-lens ships a Node package; running its
 * server under bun risks Node-isms in its deps, so prefer a real node:
 * `PILENS_NODE` override, else `node` on PATH, else `process.execPath` last.
 */
export function resolveNodeRuntime(): string {
  const override = process.env.PILENS_NODE?.trim();
  if (override) return override;
  try {
    execFileSync("node", ["--version"], { stdio: "ignore" });
    return "node";
  } catch {
    return process.execPath;
  }
}

/** Default deadline for the MCP `initialize` handshake, in ms. */
export const DEFAULT_INIT_TIMEOUT_MS = 15_000;

export class McpClient {
  private proc: ReturnType<typeof spawn>;
  private buf = "";
  private stderrBuf = "";
  private id = 0;
  private closed = false;
  /** Recorded so a LATER rpc fails fast instead of burning its full deadline. */
  private exitInfo: string | undefined;
  private pending = new Map<number, PendingRpc>();

  constructor(
    server: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    private readonly clientName = "qds-verify",
  ) {
    this.proc = spawn(resolveNodeRuntime(), [server], {
      stdio: ["pipe", "pipe", "pipe"], // stderr captured, surfaced in errors
      cwd,
      env,
    });
    this.proc.stdout?.on("data", (d: Buffer) => this.onData(d.toString()));
    this.proc.stderr?.on("data", (d: Buffer) => {
      // Bounded tail — enough to diagnose a crashed/misconfigured server.
      this.stderrBuf = (this.stderrBuf + d.toString()).slice(-16_384);
    });
    // stdin writes after the child died raise EPIPE asynchronously — swallow.
    this.proc.stdin?.on("error", () => {});
    // Fail fast: a crashed/unspawnable server rejects every outstanding RPC
    // with the real cause instead of hanging until each per-rpc deadline.
    this.proc.on("error", (err) => this.failAllPending(`server process error: ${err.message}`));
    this.proc.on("exit", (code, signal) => {
      this.exitInfo = `server exited (code=${code}, signal=${signal})`;
      if (!this.closed) this.failAllPending(this.exitInfo);
    });
  }

  private stderrTail(): string {
    const tail = this.stderrBuf.trim();
    return tail ? ` stderr: ${tail.slice(-500)}` : "";
  }

  private failAllPending(cause: string): void {
    const suffix = this.stderrTail();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`rpc ${p.method} failed: ${cause}.${suffix}`));
    }
    this.pending.clear();
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    for (let i = this.buf.indexOf("\n"); i >= 0; i = this.buf.indexOf("\n")) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const mid = msg.id as number | undefined;
      const p = mid === undefined ? undefined : this.pending.get(mid);
      if (p) {
        this.pending.delete(mid as number);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    }
  }

  /** Harness invariant: EVERY rpc carries a deadline. */
  private rpc(method: string, params: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error(`rpc ${method} failed: client closed.${this.stderrTail()}`));
    // The `exit` handler only rejects OUTSTANDING rpcs; without this, a call
    // issued after the server died writes into a dead stdin (EPIPE swallowed)
    // and then waits the whole deadline — up to 120s per call.
    if (this.exitInfo) return Promise.reject(new Error(`rpc ${method} failed: ${this.exitInfo}.${this.stderrTail()}`));
    const myId = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(myId);
        reject(new Error(`rpc ${method} timed out after ${timeoutMs}ms.${this.stderrTail()}`));
      }, timeoutMs);
      this.pending.set(myId, { method, timer, resolve, reject });
      this.proc.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: myId, method, params })}\n`);
    });
  }

  private notify(method: string, params: unknown): void {
    this.proc.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  /** MCP handshake under an explicit (or default) deadline. */
  async init(timeoutMs: number = DEFAULT_INIT_TIMEOUT_MS): Promise<void> {
    await this.rpc(
      "initialize",
      { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: this.clientName, version: "1" } },
      timeoutMs,
    );
    this.notify("notifications/initialized", {});
  }

  async call(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<McpToolResult> {
    const msg = await this.rpc("tools/call", { name, arguments: args }, timeoutMs);
    return (msg.result as McpToolResult) ?? { error: msg.error, isError: true };
  }

  /** Idempotent: safe to call repeatedly; always kills the child. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAllPending("client closed");
    this.proc.kill();
    // SIGTERM can be ignored or stall mid-teardown (pi-lens is reaping its own
    // LSP grandchildren at this point), which would leave the server alive past
    // the harness's finally. Escalate after a grace period; unref so the
    // pending timer never itself keeps the process alive.
    const escalate = setTimeout(() => {
      if (this.proc.exitCode === null && this.proc.signalCode === null) {
        try {
          this.proc.kill("SIGKILL");
        } catch {
          harnessNotes.push("failed to SIGKILL a stalled MCP server child");
        }
      }
    }, 2_000);
    escalate.unref?.();
    this.proc.once("exit", () => clearTimeout(escalate));
  }
}

/** Concatenated text of every content block (pi-lens may emit more than one). */
export function toolText(result: McpToolResult): string {
  return result.content?.map((c) => c.text ?? "").join("\n") ?? "";
}

/**
 * Parse the structured payload out of a pi-lens tool result. TWO shapes are
 * observed and both are handled rather than assumed:
 *  - `pilens_analyze` appends the `details` object as a fenced ```json block
 *    after a human-readable summary line (dist/mcp/server.js:toolText);
 *  - `pilens_lsp_navigation` emits its envelope as BARE JSON with no fence.
 * Anything else (e.g. `pilens_lsp_diagnostics`, human-readable text only)
 * yields undefined, and callers fall back to parsing the text surface.
 */
export function parseToolJson(result: McpToolResult): Record<string, unknown> | undefined {
  return parseToolJsonText(toolText(result));
}

/** Text-level half of parseToolJson, split out so it is unit-testable. */
export function parseToolJsonText(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined;
  const fence = text.match(/```json\n([\s\S]*?)\n```/);
  const candidate = fence?.[1] ?? text.trim();
  // Only object payloads are structured results; a bare array/number/string is
  // not an envelope and must not be coerced into one.
  if (!candidate.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
