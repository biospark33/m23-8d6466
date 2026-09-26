/**
 * RPC-transport worker subprocess lifecycle (#280 direction 4).
 *
 * Runs one `pi --mode rpc` worker: submits the prompt over stdin, watches the
 * event stream through the extension's own settle → compaction → handoff →
 * continuation chain, and shuts the process down only when the session has
 * drained. This is what makes the vendored self-compact handoff contract
 * ("note returned verbatim") deliverable at all: under `-p`, pi exits at the
 * first `agent_settled`, which is exactly when self-compact STARTS its
 * compaction — the SC.2 rounds proved the chain dies there (issue #280).
 *
 * Transport only. Usage accounting, raw-capture evidence, and outcome
 * classification stay in team-lead-driver (harvestPiStream over the same
 * NDJSON vocabulary rpc emits), so a worker's cost/evidence contract is
 * byte-identical across the print and rpc paths.
 *
 * Drain policy (the part that matters):
 * - `agent_settled` alone is NOT drained — self-compact's own `agent_settled`
 *   hook is what kicks off compaction and re-enters the agent.
 * - After a settle, a grace window watches for `agent_start`,
 *   `compaction_start`, or `auto_retry_start`; any of them cancels the drain
 *   and the next settle re-arms it.
 * - A settle that survives the grace window is confirmed with `get_state`
 *   (`isStreaming`/`isCompacting`/`pendingMessageCount`) before stdin is
 *   closed. pi shuts down on stdin end (its own `stdin.on("end")` handler);
 *   a linger timeout SIGKILLs a wedged shutdown.
 * - The overall `timeoutMs` SIGKILL remains the binding ceiling, exactly as
 *   on the print path.
 *
 * Framing is strict JSONL per pi's docs: LF only, optional `\r` stripped, and
 * deliberately NOT Node's readline (it also splits on U+2028/U+2029, which are
 * legal inside JSON strings). Extension UI dialog requests are auto-cancelled
 * so a headless worker can never hang on `ctx.ui.confirm` — fire-and-forget
 * requests are ignored.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { redactSecrets } from "../src/redact.ts";

/** Methods that BLOCK until answered; everything else in the UI sub-protocol is fire-and-forget. */
const RPC_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/** Default quiet period after `agent_settled` before the drain check fires. */
const DEFAULT_SETTLE_GRACE_MS = 5_000;
/** How long to wait for pi to exit after stdin closes before SIGKILL. */
const DEFAULT_LINGER_MS = 10_000;
/** P0.2: consecutive get_state failures before retries stop (ceiling backstop). */
const DRAIN_MAX_FAILURES = 3;

/** Structural child-process surface runRpcWorker needs; satisfied by node's spawn. */
export interface RpcChild {
  stdin: { write(chunk: string): unknown; end(): unknown };
  stdout: { on(event: "data", cb: (d: Buffer | string) => void): unknown };
  stderr: { on(event: "data", cb: (d: Buffer | string) => void): unknown };
  on(event: "error", cb: (err: Error) => void): unknown;
  on(event: "close", cb: (code: number | null) => void): unknown;
  kill(signal?: number | string): unknown;
}

export type RpcSpawnFn = (argv: string[]) => RpcChild;

/**
 * Why the worker ended. Every path names itself so the caller's evidence says
 * HOW a run finished, not just that it did: `get-state-idle` (the healthy
 * drain), `prompt-error` (P0.1 — pi refused the prompt; settle-with-failure),
 * `drain-unconfirmed` (P0.2 — get_state kept failing; the timeout ceiling is
 * the backstop), `closed-before-drain` (pi exited on its own first),
 * `timeout-ceiling` (SIGKILL at timeoutMs), `spawn-error`.
 */
export type DrainReason =
  | "get-state-idle"
  | "prompt-error"
  | "drain-unconfirmed"
  | "closed-before-drain"
  | "timeout-ceiling"
  | "spawn-error";

export interface RpcRunResult {
  /** The worker's complete stdout stream, verbatim (NDJSON events). */
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  /** Spawn failure description (missing binary, EAGAIN...); null on a real run. */
  spawnError: string | null;
  /** Why the run ended (P0.6) — see {@link DrainReason}. */
  drainReason: DrainReason;
}

/**
 * P0.5: the worker's environment is an ALLOWLIST, never `process.env` — a
 * factory worker needs a path, a home and its own provider credential, and
 * nothing else the host happens to carry (secrets included). `captureEnv`
 * entries ride along: they are the delivery vehicle for the run's own
 * credential material. `PI_*` passes with a prefix — pi's own configuration
 * surface is namespaced by design.
 */
export function rpcWorkerEnv(extra: Record<string, string> = {}): Record<string, string> {
  const ALLOWED = [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TERM",
    "SHELL",
    "USER",
    "LOGNAME",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    // Lowercase is the common shell convention on macOS/Linux — dropping it
    // silently loses the worker's egress routing (P0.5 review).
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
  ];
  const env: Record<string, string> = {};
  for (const name of ALLOWED) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  for (const [name, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (name.startsWith("PI_")) env[name] = v;
  }
  for (const [name, v] of Object.entries(extra)) env[name] = v;
  return env;
}

export interface RunRpcWorkerOptions {
  argv: string[];
  /** The full prompt text (task brief + schema instruction), sent as one `prompt` command. */
  prompt: string;
  /** Worker name for the drain/get_state correlation id — also keeps ids distinct per worker. */
  agentId: string;
  timeoutMs: number;
  settleGraceMs?: number;
  lingerMs?: number;
  /**
   * Write-through raw capture path. When set, every COMPLETE stdout line is
   * appended (env-secret-redacted per line, 0600) as it arrives — a phase
   * ceiling SIGKILL kills this driver before its own close-handler capture
   * can run, and a vanished worker's dying events are the evidence (the
   * SC.2 lesson, 3a0b0b5f). ponytail: redaction is per flushed line, so a
   * multi-LINE secret value could straddle two flushes; single-line secret
   * values — every real key shape — cannot. The authoritative whole-buffer
   * redacted capture still lands on a clean close.
   */
  captureFile?: string;
  captureEnv?: Record<string, string>;
  /**
   * P0.6: appended verbatim to the spawn argv — the opt-in session file for
   * resume (`--session <path>`) and any other caller-owned pi flag. The
   * transport does not interpret these.
   */
  extraArgv?: string[];
  /** Injectable for tests; defaults to node's spawn. */
  spawn?: RpcSpawnFn;
}

/**
 * Run one rpc worker to drain. Resolves (never rejects) — a spawn failure or
 * SIGKILL is a result, and the caller classifies it from exitCode/stdout, the
 * same contract runWorkerPi maintains.
 */
export function runRpcWorker(opts: RunRpcWorkerOptions): Promise<RpcRunResult> {
  const started = Date.now();
  const settleGraceMs = opts.settleGraceMs ?? DEFAULT_SETTLE_GRACE_MS;
  const lingerMs = opts.lingerMs ?? DEFAULT_LINGER_MS;
  const spawn: RpcSpawnFn =
    opts.spawn ??
    // `argv` is pi's flag list (the binary name is implied by the contract —
    // the print path spawns "pi" the same way). The environment is the P0.5
    // allowlist, never the host's process.env.
    ((argv) =>
      nodeSpawn("pi", argv, {
        stdio: ["pipe", "pipe", "pipe"],
        env: rpcWorkerEnv(opts.captureEnv),
      }));
  const argv = opts.extraArgv === undefined ? opts.argv : [...opts.argv, ...opts.extraArgv];
  return new Promise((resolve) => {
    let lingerTimer: ReturnType<typeof setTimeout> | null = null;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    let child: RpcChild;
    try {
      child = spawn(argv);
    } catch (err) {
      resolve({
        stdout: "",
        stderr: "",
        exitCode: null,
        durationMs: Date.now() - started,
        spawnError: err instanceof Error ? err.message : String(err),
        drainReason: "spawn-error",
      });
      return;
    }

    const decoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let buffer = "";
    let stdinEnded = false;
    let done = false;
    let timedOut = false;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    let stateInFlight = false;
    // P0.2: consecutive get_state failures. A failed state read is UNKNOWN,
    // not idle — fail closed. After DRAIN_MAX_FAILURES the retries stop
    // (a dead control channel would otherwise loop forever) and the
    // timeoutMs SIGKILL is the documented backstop.
    let drainFailures = 0;
    let drainReason: DrainReason = "closed-before-drain";
    // Correlation id for the drain-confirming get_state — per worker, so two
    // workers sharing a stream (tests) cannot cross-answer.
    const drainId = `qds-drain:${opts.agentId}`;
    const finish = (exitCode: number | null, spawnError: string | null = null) => {
      if (done) return;
      done = true;
      if (drainTimer !== null) clearTimeout(drainTimer);
      if (lingerTimer !== null) clearTimeout(lingerTimer);
      if (hardTimer !== null) clearTimeout(hardTimer);
      stdout += decoder.end();
      stderr += stderrDecoder.end();
      if (captureFd !== null) {
        // Flush any trailing partial line (no trailing newline at SIGKILL).
        if (buffer !== "") captureWrite(buffer);
        try {
          closeSync(captureFd);
        } catch {
          // Already gone.
        }
        captureFd = null;
      }
      resolve({
        stdout,
        stderr,
        exitCode,
        durationMs: Date.now() - started,
        spawnError,
        drainReason: spawnError !== null ? "spawn-error" : timedOut ? "timeout-ceiling" : drainReason,
      });
    };

    const sendLine = (obj: Record<string, unknown>) => {
      if (stdinEnded) return;
      try {
        child.stdin.write(`${JSON.stringify(obj)}\n`);
      } catch {
        // EPIPE: pi already died; the close event resolves the outcome.
      }
    };

    const cancelDrain = () => {
      if (drainTimer !== null) {
        clearTimeout(drainTimer);
        drainTimer = null;
      }
    };
    const armDrain = () => {
      if (done || stdinEnded) return;
      cancelDrain();
      drainTimer = setTimeout(() => {
        drainTimer = null;
        // One get_state in flight at a time; if the response never lands the
        // overall timeoutMs SIGKILL is the backstop, not a retry loop.
        if (!stateInFlight) {
          stateInFlight = true;
          sendLine({ id: drainId, type: "get_state" });
        }
      }, settleGraceMs);
    };

    // Write-through capture state. Line-buffered: a chunk boundary may fall
    // mid-line, so only complete lines are flushed (the line reassembly below
    // and this buffer share `buffer`, not coincidentally — one reassembly,
    // two consumers).
    let captureFd: number | null = null;
    if (opts.captureFile !== undefined) {
      try {
        mkdirSync(dirname(opts.captureFile), { recursive: true, mode: 0o700 });
        captureFd = openSync(opts.captureFile, "w", 0o600);
      } catch {
        // Diagnostics only — never lose the run over a capture failure.
        captureFd = null;
      }
    }
    const captureWrite = (text: string) => {
      if (captureFd === null) return;
      try {
        writeSync(captureFd, redactSecrets(text, opts.captureEnv ?? {}));
      } catch {
        // Ignore write errors (disk full, EPIPE): diagnostics, not control.
      }
    };

    const onLine = (line: string) => {
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
      captureWrite(`${trimmed}\n`);
      // P0.2 review: once the shutdown decision has been made (or the run is
      // done) LATE lines are captured but never dispatched — a pending
      // get_state response arriving after a prompt-error shutdown must not
      // overwrite the reason the run actually ended.
      if (stdinEnded || done) return;
      if (!trimmed.startsWith("{")) return;
      let event: unknown;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (typeof event !== "object" || event === null) return;
      const e = event as Record<string, unknown>;

      if (e.type === "response" && e.id === drainId) {
        stateInFlight = false;
        const data =
          typeof e.data === "object" && e.data !== null
            ? (e.data as Record<string, unknown>)
            : undefined;
        // P0.2 review: a response with NO readable shape is UNKNOWN, not
        // idle — re-arm (the bounded retries below handle a dead channel).
        if (data === undefined) {
          armDrain();
          return;
        }
        const busy =
          data?.isStreaming === true ||
          data?.isCompacting === true ||
          (typeof data?.pendingMessageCount === "number" && data.pendingMessageCount > 0);
        if (busy) {
          // Work appeared between the grace expiry and the state read — the
          // next agent_settled re-arms the drain.
          armDrain();
        } else {
          drainReason = "get-state-idle";
          shutdown();
        }
        return;
      }
      // P0.2: an ERROR answer to the drain probe is UNKNOWN state, not idle —
      // fail closed (never shutdown on it). Retry within a bound; past the
      // bound the timeoutMs SIGKILL is the documented backstop.
      if (e.type === "error" && e.id === drainId) {
        stateInFlight = false;
        drainFailures += 1;
        if (drainFailures < DRAIN_MAX_FAILURES) {
          armDrain();
        } else {
          drainReason = "drain-unconfirmed";
          stderr += `worker-rpc: get_state failed ${drainFailures}x — drain retries exhausted; the timeout ceiling will end this worker\n`;
        }
        return;
      }
      // P0.1: pi refused the PROMPT — nothing will ever settle. Treat it as a
      // settle-with-failure: end the run now (the error line itself is in the
      // captured stdout stream and the caller classifies from it), instead of
      // hanging to the ceiling.
      if (e.type === "error" && e.id === `qds-prompt:${opts.agentId}`) {
        drainReason = "prompt-error";
        shutdown();
        return;
      }
      if (e.type === "agent_settled") {
        armDrain();
        return;
      }
      if (e.type === "agent_start" || e.type === "compaction_start" || e.type === "auto_retry_start") {
        cancelDrain();
        // A new agent turn is a NEW drain sequence: the failure bound from
        // the previous quiescent window does not carry into it.
        drainFailures = 0;
        return;
      }
      // P0.4: an end event after a FAILED compaction/retry leaves the session
      // quiescent with nothing to re-arm the drain — arm it here. The get_state
      // gate before shutdown makes this safe on every shape.
      if (e.type === "compaction_end" || e.type === "auto_retry_end") {
        armDrain();
        return;
      }
      if (e.type === "extension_ui_request") {
        // Headless factory: answer every blocking dialog with "cancelled" so
        // an extension's ctx.ui.confirm can never park the worker forever.
        if (typeof e.method === "string" && RPC_DIALOG_METHODS.has(e.method)) {
          sendLine({ type: "extension_ui_response", id: e.id, cancelled: true });
        }
        return;
      }
    };

    const shutdown = () => {
      if (stdinEnded || done) return;
      stdinEnded = true;
      cancelDrain();
      try {
        child.stdin.end();
      } catch {
        // Already gone; close resolves.
      }
      lingerTimer = setTimeout(() => {
        lingerTimer = null;
        child.kill("SIGKILL");
      }, lingerMs);
    };
    child.stdout.on("data", (d: Buffer | string) => {
      const text = typeof d === "string" ? d : decoder.write(d);
      stdout += text;
      buffer += text;
      // Strict LF framing per pi's rpc doc; NOT readline.
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        onLine(line);
      }
    });
    child.stderr.on("data", (d: Buffer | string) => {
      stderr += typeof d === "string" ? d : stderrDecoder.write(d);
    });

    hardTimer = setTimeout(() => {
      // Binding ceiling, identical to the print path: SIGKILL the worker at
      // the phase deadline. The truncated-stream classification (unpriced
      // turns) is handled downstream by harvestPiStream.
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    child.on("error", (err: Error) => {
      // P0.3: route through the SAME cleanup as close — timers cleared, the
      // decoder ended, the capture flushed and closed — or the leaked
      // hardTimer keeps the event loop alive to the ceiling and a later
      // SIGKILL fires on a dead child.
      finish(null, err.message);
    });
    child.on("close", (code: number | null) => {
      finish(code);
    });

    // Prompt goes out only once the reader is armed, so the first events
    // cannot race the pipe setup.
    sendLine({ id: `qds-prompt:${opts.agentId}`, type: "prompt", message: opts.prompt });
  });
}
