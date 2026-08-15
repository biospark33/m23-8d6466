/**
 * Structured JSONL logging (CC-9) — the shared, transport-neutral sink.
 *
 * Lives outside mcp/stdio-transport.ts so low-level packages (providers,
 * run-record) can log without reaching into the MCP subsystem: the dependency
 * direction must stay providers → log, never providers → transport. The
 * stdio transport re-exports these for its existing consumers.
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
  try {
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  } catch {
    // stdout closed (EPIPE / client disconnect / stream destroyed): a log line
    // must never crash the process or its caller — drop the line.
  }
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
