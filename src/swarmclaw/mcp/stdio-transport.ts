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
  const raw = env.SWARMCLAW_NPX_PACKAGE_ALLOWLIST;
  if (raw === undefined) {
    return ["hindsight-local-mcp", "@anthropic-ai/claude-code"];
  }
  // A set-but-empty value means deny all npx packages — do NOT fall back to
  // the defaults (unlike parseCsvEnv's unset handling).
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
  if (command.includes("/")) {
    // Path-like commands match only an exact (possibly canonicalized)
    // allowlist entry — never a basename, otherwise any same-named binary at
    // an arbitrary path (e.g. /tmp/evil/hindsight-local-mcp) would pass.
    return allowlist.includes(resolve(command));
  }
  // Bare-name command → resolved via PATH at spawn time; match by basename
  // against allowlist basenames (covers both `node` and absolute-path forms
  // of allowlisted binaries).
  const base = basename(command);
  return allowlist.some((entry) => basename(entry) === base);
}

// Long-form node flags that enable inline code execution.
const NODE_INLINE_LONG_FLAGS = new Set(["--eval", "--print", "--input-type"]);
// Node flags that load a module before the entry point (INV-SC2). Each takes
// a module path (`--flag=value` or the next token); only absolute paths are
// permitted — anything else (data:/http:/https: specifiers, relative paths)
// is rejected.
const NODE_MODULE_LOAD_FLAGS = new Set(["--require", "--import", "--experimental-loader", "--loader"]);
// Node flags that bind a network listener (debugger). INV-SC4 Phase 1 is
// best-effort detection + logging only — these remain permitted.
const NODE_LISTENER_FLAGS = new Set(["--inspect", "--inspect-brk", "--inspect-port", "--debug"]);
// Single-letter short flags that enable inline code execution. Node bundles
// single-dash short flags (`-pe` == `-p -e`), so these are matched per-letter
// against a decomposed cluster — never by exact token match.
const NODE_INLINE_SHORT_LETTERS = new Set(["e", "p"]);

function validateNodeArgs(args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-") {
      throw new CommandValidationError("node stdin mode ('-') is not permitted");
    }
    // Handle `--flag=value` form.
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;

    // Long flags (`--foo`): exact match against the inline set.
    if (flag.startsWith("--")) {
      if (NODE_INLINE_LONG_FLAGS.has(flag)) {
        throw new CommandValidationError(`node flag '${flag}' enables inline code execution and is not permitted`);
      }
      if (NODE_MODULE_LOAD_FLAGS.has(flag)) {
        const target = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[i + 1];
        if (target === undefined) {
          throw new CommandValidationError(`${flag} requires a module path`);
        }
        if (!target.startsWith("/")) {
          throw new CommandValidationError(`${flag} with a non-absolute path is not permitted`);
        }
        if (!arg.includes("=")) i++; // consumed the next token
      }
      if (NODE_LISTENER_FLAGS.has(flag)) {
        log({
          level: "warn",
          message: "node flag opens a network listener (INV-SC4)",
          flag,
          // CC-9 required fields (best-effort for a validation-time warning):
          requestId: newRequestId(),
          operation: "mcp.validate_command",
          agentId: null,
          timestamp: new Date().toISOString(),
          duration: 0,
          status: "ok",
        });
      }
      continue;
    }

    // Single-dash short-flag CLUSTER (`-p`, `-pe`, `-rp`, ...): Node bundles
    // single-dash short flags, so `node -pe "<code>"` runs `-p -e` and executes
    // arbitrary inline JS. Decompose the cluster into its letters and reject if
    // ANY letter enables inline code (`e`/`p`); enforce the absolute-path rule
    // when the cluster contains `r` (require). Exact-token matching is unsafe here.
    if (flag.startsWith("-") && flag.length > 1) {
      const letters = flag.slice(1).split("");
      for (const ch of letters) {
        if (NODE_INLINE_SHORT_LETTERS.has(ch)) {
          throw new CommandValidationError(
            `node short flag '-${ch}' (in '${arg}') enables inline code execution and is not permitted`,
          );
        }
      }
      if (letters.includes("r")) {
        const target = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[i + 1];
        if (target === undefined) {
          throw new CommandValidationError("-r requires a module path");
        }
        if (!target.startsWith("/")) {
          throw new CommandValidationError("-r with a non-absolute path is not permitted");
        }
        if (!arg.includes("=")) i++; // consumed the next token
      }
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

// npx flags that take the NEXT token as their value; the value must not be
// mistaken for the positional package argument (e.g. `--registry <url>`).
const NPX_VALUE_FLAGS = new Set(["--registry", "--cache", "--userconfig", "--cwd"]);

function validateNpxArgs(args: string[], packageAllowlist: string[]): void {
  let sawPositional = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (NPX_FORBIDDEN_FLAGS.has(flag)) {
      throw new CommandValidationError(`npx flag '${flag}' is not permitted (package/node-arg injection)`);
    }
    if (NPX_VALUE_FLAGS.has(flag) && !arg.includes("=")) {
      if (i + 1 >= args.length) {
        throw new CommandValidationError(`npx flag '${flag}' requires a value`);
      }
      i++; // consumed the flag's value token
      continue;
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
  // INV-SC2: NODE_OPTIONS injects arbitrary flags (--require/--import/...) into
  // every node-family runtime, bypassing all arg validation above — so it is
  // stripped even when explicitly provided or named in SWARMCLAW_ENV_ALLOWLIST.
  if ("NODE_OPTIONS" in out) {
    log({
      level: "warn",
      message: "NODE_OPTIONS dropped from subprocess env (INV-SC2)",
      // CC-9 required fields (best-effort for an env-isolation warning):
      requestId: newRequestId(),
      operation: "mcp.build_env",
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: 0,
      status: "ok",
    });
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(out)) {
      if (k !== "NODE_OPTIONS") filtered[k] = v;
    }
    return filtered;
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

/** Maximum buffered frame size; a misbehaving server exceeding this is killed. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
  onFirstByte?: (latencyMs: number) => void;
  firstByteFired?: boolean;
}

export class StdioTransport {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readBuf = "";
  private stderrTail = "";
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
    void this.stderrLoop();
    // spawn timeout is enforced by the initialize() handshake caller via a race.
  }

  private async readLoop(): Promise<void> {
    const decoder = new TextDecoder();
    try {
      // @ts-expect-error Bun ReadableStream is async-iterable
      for await (const chunk of this.proc!.stdout) {
        // {stream: true} keeps multibyte UTF-8 split across chunks intact.
        this.readBuf += decoder.decode(chunk, { stream: true });
        // First stdout bytes after a request measure stdio_latency_ms (time
        // from request write to first response byte, CC-9). `pending` is
        // insertion-ordered, so the first unfired entry is the earliest.
        for (const [, p] of this.pending) {
          if (p.firstByteFired !== true) {
            p.firstByteFired = true;
            p.onFirstByte?.(Date.now() - p.startedAt);
            break;
          }
        }
        if (this.readBuf.length > MAX_FRAME_BYTES) {
          log({
            level: "error",
            message: "frame too large",
            requestId: newRequestId(),
            operation: "mcp.transport",
            agentId: null,
            timestamp: new Date().toISOString(),
            duration: 0,
            status: "error",
            error: {
              code: "frame_too_large",
              message: `buffered frame exceeds ${MAX_FRAME_BYTES} bytes`,
            },
          });
          for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error("MCP frame exceeds 16MB limit"));
          }
          this.pending.clear();
          try {
            this.proc?.kill("SIGKILL");
          } catch {
            /* already dead */
          }
          break;
        }
        let idx: number;
        // biome-ignore lint/suspicious/noAssignInExpressions: standard line-buffer drain
        while ((idx = this.readBuf.indexOf("\n")) >= 0) {
          const line = this.readBuf.slice(0, idx);
          this.readBuf = this.readBuf.slice(idx + 1);
          if (line.trim()) this.handleLine(line);
        }
      }
      this.readBuf += decoder.decode(); // flush any held-back multibyte bytes
    } catch {
      // stream closed
    }
    this.closed = true;
    const tail = this.stderrTail.trim();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(
        new Error(
          tail ? `transport closed before response (stderr: ${tail})` : "transport closed before response",
        ),
      );
    }
    this.pending.clear();
  }

  /**
   * Drain stderr so a full pipe buffer can never deadlock the child, keeping
   * the last ~8KB for diagnostics (surfaced in close-before-response errors).
   */
  private async stderrLoop(): Promise<void> {
    const decoder = new TextDecoder();
    try {
      // @ts-expect-error Bun ReadableStream is async-iterable
      for await (const chunk of this.proc!.stderr) {
        this.stderrTail = (this.stderrTail + decoder.decode(chunk, { stream: true })).slice(-8192);
      }
      this.stderrTail = (this.stderrTail + decoder.decode()).slice(-8192);
    } catch {
      // stream closed
    }
  }

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      log({
        level: "warn",
        message: "dropping unparseable JSON-RPC line from subprocess",
        bytes: line.length,
        requestId: newRequestId(),
        operation: "mcp.transport",
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: 0,
        status: "ok",
      });
      return;
    }
    // A message carrying `method` is server-initiated: a notification (no id)
    // or a server→client request. We support no server methods, but JSON-RPC
    // requires a response to requests so the server is not left hanging.
    // String ids are valid JSON-RPC and get the same reply; they cannot
    // collide with `pending` because the client only issues numeric ids.
    if (typeof msg.method === "string") {
      if (typeof msg.id === "number" || typeof msg.id === "string") {
        try {
          this.write({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: "method not supported by client" },
          });
        } catch {
          // transport already closing
        }
      }
      return;
    }
    if (typeof msg.id !== "number") return; // unmatched response
    const p = this.pending.get(msg.id);
    if (!p) return;
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
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([
      proc.exited,
      new Promise<"timeout">((r) => {
        graceTimer = setTimeout(() => r("timeout"), graceMs);
      }),
    ]);
    // Clear the grace timer when the process wins the race so it cannot dangle.
    if (graceTimer !== undefined) clearTimeout(graceTimer);
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
