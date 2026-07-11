/**
 * MCP stdio transport: subprocess lifecycle + line-delimited JSON-RPC 2.0.
 *
 * Also owns the security-critical command/args allowlist validation (INV-SC2)
 * and environment isolation (INV-SC3), because these gate what subprocess is
 * ever spawned. Validation runs at *registration* time, before any spawn.
 */

import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Observability (CC-9) — structured JSON log lines.
// ---------------------------------------------------------------------------

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

/** Sink is overridable so tests can capture logs deterministically. */
export let logSink: (entry: LogEntry) => void = (entry) => {
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

// ---------------------------------------------------------------------------
// INV-SC2: command allowlist + code-injection arg rules.
// ---------------------------------------------------------------------------

const DEFAULT_COMMAND_ALLOWLIST = [
  "hindsight-local-mcp",
  "node",
  "npx",
  "node_modules/.bin/hindsight-local-mcp",
];

// Shells / interpreters that enable unrestricted code execution — permanently
// excluded regardless of env-var configuration.
const FORBIDDEN_COMMANDS = new Set(["sh", "bash", "zsh", "python", "python3", "python2"]);

function parseCsvEnv(raw: string | undefined, fallback: string[]): string[] {
  if (raw === undefined) return fallback;
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parsed.length > 0 ? parsed : fallback;
}

/** Basename of a path-like command (last segment), for allowlist comparison. */
function basename(cmd: string): string {
  const parts = cmd.split("/");
  return parts[parts.length - 1] ?? cmd;
}

export function resolveCommandAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = parseCsvEnv(env.SWARMCLAW_COMMAND_ALLOWLIST, []);
  const merged = [...DEFAULT_COMMAND_ALLOWLIST, ...extra];
  // Canonicalize relative entries (e.g. node_modules/.bin/...) to absolute
  // to prevent working-directory manipulation at match time.
  const set = new Set<string>();
  for (const entry of merged) {
    set.add(entry);
    if (!entry.startsWith("/")) set.add(resolve(entry));
  }
  return [...set];
}

export function resolveNpxPackageAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseCsvEnv(env.SWARMCLAW_NPX_PACKAGE_ALLOWLIST, [
    "hindsight-local-mcp",
    "@anthropic-ai/claude-code",
  ]);
}

export class CommandValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandValidationError";
  }
}

function isCommandAllowed(command: string, allowlist: string[]): boolean {
  if (FORBIDDEN_COMMANDS.has(basename(command))) return false;
  if (allowlist.includes(command)) return true;
  // Match by basename against allowlist basenames (covers both `node` and
  // absolute-path forms of allowlisted binaries).
  const base = basename(command);
  return allowlist.some((entry) => basename(entry) === base);
}

// Node flags that enable inline code / stdin execution.
const NODE_INLINE_FLAGS = new Set(["-e", "--eval", "-p", "--print", "--input-type"]);

function validateNodeArgs(args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-") {
      throw new CommandValidationError("node stdin mode ('-') is not permitted");
    }
    // Handle `--flag=value` form for eval/print.
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (NODE_INLINE_FLAGS.has(flag)) {
      throw new CommandValidationError(`node flag '${flag}' enables inline code execution and is not permitted`);
    }
    if (flag === "--require" || flag === "-r") {
      // Require target may be the same token (--require=x) or the next token.
      const target = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[i + 1];
      if (target === undefined) {
        throw new CommandValidationError("--require/-r requires a module path");
      }
      if (!target.startsWith("/")) {
        throw new CommandValidationError("--require/-r with a non-absolute path is not permitted");
      }
      if (!arg.includes("=")) i++; // consumed the next token
    }
  }
}

// npx flags that pass args to Node or inject extra packages.
const NPX_FORBIDDEN_FLAGS = new Set([
  "--node-arg",
  "--node-args",
  "-e",
  "--eval",
  "-p",
  "--print",
  "--package",
]);

function validateNpxArgs(args: string[], packageAllowlist: string[]): void {
  let sawPositional = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (NPX_FORBIDDEN_FLAGS.has(flag)) {
      throw new CommandValidationError(`npx flag '${flag}' is not permitted (package/node-arg injection)`);
    }
    if (arg.startsWith("-")) {
      continue; // some other allowed flag (e.g. -y)
    }
    // First positional arg = the package to run; must be allowlisted.
    if (!sawPositional) {
      sawPositional = true;
      if (!packageAllowlist.includes(arg)) {
        throw new CommandValidationError(`npx package '${arg}' is not in SWARMCLAW_NPX_PACKAGE_ALLOWLIST`);
      }
    }
  }
  if (!sawPositional) {
    throw new CommandValidationError("npx requires a package positional argument");
  }
}

export interface CommandCheckOptions {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Validate a stdio command + args against INV-SC2. Throws CommandValidationError
 * on any violation. Must be called before spawning.
 */
export function validateCommand(opts: CommandCheckOptions): void {
  const procEnv = opts.env ?? process.env;
  const allowlist = resolveCommandAllowlist(procEnv);
  if (!isCommandAllowed(opts.command, allowlist)) {
    throw new CommandValidationError(`command '${opts.command}' is not in the allowlist`);
  }
  const base = basename(opts.command);
  if (base === "node") {
    validateNodeArgs(opts.args);
  } else if (base === "npx") {
    validateNpxArgs(opts.args, resolveNpxPackageAllowlist(procEnv));
  }
}

// ---------------------------------------------------------------------------
// INV-SC3: environment isolation.
// ---------------------------------------------------------------------------

export function resolveEnvAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseCsvEnv(env.SWARMCLAW_ENV_ALLOWLIST, []);
}

/**
 * Build the subprocess env: the explicit `env` map from the registration
 * payload, plus any process-env keys explicitly named in SWARMCLAW_ENV_ALLOWLIST.
 * Never inherits the full parent environment.
 */
export function buildSubprocessEnv(
  explicit: Record<string, string> | undefined,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of resolveEnvAllowlist(parentEnv)) {
    const v = parentEnv[key];
    if (v !== undefined) out[key] = v;
  }
  if (explicit) {
    for (const [k, v] of Object.entries(explicit)) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// stdio transport: spawn, handshake, JSON-RPC request/response.
// ---------------------------------------------------------------------------

export const SPAWN_TIMEOUT_MS = 10_000;

export interface StdioTransportOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  /** Env used for the spawn-time defense-in-depth allowlist re-check. Defaults to process.env. */
  validationEnv?: NodeJS.ProcessEnv;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
  onFirstByte?: (latencyMs: number) => void;
}

export class StdioTransport {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readBuf = "";
  private closed = false;
  private readonly encoder = new TextEncoder();

  constructor(private readonly opts: StdioTransportOptions) {}

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get isRunning(): boolean {
    return this.proc !== null && !this.closed;
  }

  async spawn(): Promise<void> {
    // Deny-list is re-checked here as defense in depth even though routes
    // validate at registration time.
    validateCommand({
      command: this.opts.command,
      args: this.opts.args,
      env: this.opts.validationEnv ?? process.env,
    });
    this.proc = Bun.spawn([this.opts.command, ...this.opts.args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: this.opts.env, // isolated env only — no parent inheritance
      cwd: this.opts.cwd,
    });
    void this.readLoop();
    // spawn timeout is enforced by the initialize() handshake caller via a race.
  }

  private async readLoop(): Promise<void> {
    const decoder = new TextDecoder();
    try {
      // @ts-expect-error Bun ReadableStream is async-iterable
      for await (const chunk of this.proc!.stdout) {
        this.readBuf += decoder.decode(chunk);
        let idx: number;
        // biome-ignore lint/suspicious/noAssignInExpressions: standard line-buffer drain
        while ((idx = this.readBuf.indexOf("\n")) >= 0) {
          const line = this.readBuf.slice(0, idx);
          this.readBuf = this.readBuf.slice(idx + 1);
          if (line.trim()) this.handleLine(line);
        }
      }
    } catch {
      // stream closed
    }
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("transport closed before response"));
    }
    this.pending.clear();
  }

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return; // notification or unmatched
    const p = this.pending.get(msg.id);
    if (!p) return;
    p.onFirstByte?.(Date.now() - p.startedAt);
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.error) {
      const err = new JsonRpcError(msg.error.code, msg.error.message, msg.error.data);
      p.reject(err);
    } else {
      p.resolve(msg.result);
    }
  }

  private write(obj: unknown): void {
    if (!this.proc) throw new Error("transport not spawned");
    const stdin = this.proc.stdin as { write: (b: Uint8Array) => void; flush: () => void };
    stdin.write(this.encoder.encode(`${JSON.stringify(obj)}\n`));
    stdin.flush();
  }

  request(
    method: string,
    params: unknown,
    timeoutMs: number,
    onFirstByte?: (latencyMs: number) => void,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("transport closed"));
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
        startedAt: Date.now(),
        onFirstByte,
      });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectPromise(e as Error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** MCP handshake: initialize + notifications/initialized. Enforces spawn timeout. */
  async initialize(): Promise<void> {
    const result = this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "swarmclaw", version: "0.1.0" },
      },
      SPAWN_TIMEOUT_MS,
    );
    await result;
    this.notify("notifications/initialized");
  }

  /**
   * Graceful shutdown per AC6: SIGTERM, wait `graceMs`, then SIGKILL if alive.
   * Resolves once the process has exited (or been killed).
   */
  async shutdown(graceMs = 5_000): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already dead */
    }
    const exited = await Promise.race([
      proc.exited,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), graceMs)),
    ]);
    if (exited === "timeout") {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await proc.exited;
    }
    this.closed = true;
  }
}

export class JsonRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}
