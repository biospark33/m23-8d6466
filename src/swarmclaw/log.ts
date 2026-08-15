/**
 * Structured-log primitives (CC-9) — JSONL log sink + request ids.
 *
 * Lifted out of mcp/stdio-transport.ts so non-MCP modules (the providers
 * store, its CLI) can log without importing an MCP transport.
 */

export interface LogEntry {
  requestId: string;
  operation: string;
  agentId: string | null;
  timestamp: string;
  duration: number;
  status: "ok" | "error";
  error?: { code: string; message: string; stack?: string };
  [k: string]: unknown;
}

/**
 * Quiet under `bun test` (Bun sets NODE_ENV=test): the JSONL stream buried real
 * failures in hundreds of unrelated lines (#53). Set `QDS_LOG_VERBOSE=1` to get
 * it back for a suite — `QDS_LOG_VERBOSE=1 bun test tests/swarmclaw`.
 * Production is unaffected: NODE_ENV is never "test" there. Tests that assert on
 * log output install their own sink via setLogSink() and bypass this entirely.
 * Read at call time, not module load, so a test can toggle it.
 */
function logMuted(): boolean {
  return process.env.NODE_ENV === "test" && !process.env.QDS_LOG_VERBOSE;
}

/** Sink is overridable so tests can capture logs deterministically. */
export let logSink: (entry: LogEntry) => void = (entry) => {
  if (logMuted()) return;
  process.stdout.write(`${JSON.stringify(entry)}\n`);
};

export function setLogSink(sink: (entry: LogEntry) => void): () => void {
  const prev = logSink;
  logSink = sink;
  return () => {
    logSink = prev;
  };
}

export function log(entry: LogEntry): void {
  logSink(entry);
}

export function newRequestId(): string {
  return crypto.randomUUID();
}
