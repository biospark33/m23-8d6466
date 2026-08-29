/**
 * DF4.2 visualizer deploy — mint the host-side gate token (INV-3), deliver it
 * into the box, spawn the DF4.1 server there via driver.ts's `startVisualizer`
 * lifecycle verb, and confirm it is actually answering before handing back
 * the ssh forward command an operator runs by hand.
 *
 * Talks to the box only through `ProviderDriver` (via driver.ts's
 * startVisualizer/stopVisualizer) — no abstraction layer of its own sits
 * between this file and the driver seam.
 *
 * INV-3 is two halves, deliberately different rules for each (Story
 * Corrections C11 — not re-litigated here, only named so the tree doesn't
 * read as two contradictory rules):
 *  - HOST side (this file, `mintOrReuseToken`): `$HOME/.qds/viz-token`,
 *    minted once with O_CREAT|O_EXCL|O_NOFOLLOW 0600, reused only after an
 *    O_NOFOLLOW `fstat` proves regular + mode 0600 + owned by the caller. No
 *    shell redirect, no umask, no post-write stat trick — the syscall flags
 *    ARE the guarantee, checked before any byte is trusted.
 *    The reuse is DELIBERATE and indefinite (tech-debt Q8/F029): the token
 *    persists so an operator's bookmark and browser Basic credentials survive
 *    a redeploy. It is not rotated by a restart, a redeploy, or elapsed time —
 *    the ONLY rotation is `rotate: true` on DeployOptions, which unlinks the
 *    file and mints fresh. There is no CLI flag for it: this file has no argv
 *    parser, so `deploy()`'s options are the whole surface. Equivalently, an
 *    operator rotates by `rm ~/.qds/viz-token` before starting — the option
 *    does exactly that unlink and nothing else.
 *  - BOX side (`deliverToken`, DF2.3's `deliverScript` shape): stdin →
 *    `cat > file && chmod 600` → mode read back by `stat`. The token never
 *    appears in argv on either side.
 */
import { closeSync, constants as FS, fstatSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { log, newRequestId } from "../src/swarmclaw/log.ts";
import { ExeDevDriverError } from "../src/providers/exedev/transport.ts";
import { assertPlainBoxPath } from "../src/providers/path-guard.ts";
import {
  startVisualizer as spawnInBox,
  stopVisualizer as killInBox,
  VIZ_ENVFILE,
  VIZ_PIDFILE,
  VIZ_LOGFILE,
  type ProviderDriver,
} from "../src/providers/driver.ts";
import { DEFAULT_VIZ_PORT, TOKEN_MIN_BYTES } from "./server/auth.ts";

const TOKEN_DIR = join(homedir(), ".qds");
/** Exported so a test can assert this against harvest.ts's own harvested roots, not a hand-typed copy. */
export const TOKEN_PATH = join(TOKEN_DIR, "viz-token");
const START_TIMEOUT_MS = 15_000;
const HEALTH_POLL_MS = 500;

export interface DeployOptions {
  vm: string;
  /** In-box path of the trace db, forwarded as QDS_VIZ_DB. */
  dbPath: string;
  /** Default DEFAULT_VIZ_PORT (auth.ts). */
  port?: number;
  /** In-box directory containing the visualizer package. Default "visualizer". */
  cwd?: string;
  requestId?: string;
  runId?: string;
  /** Test-only injection seam. Default TOKEN_PATH ($HOME/.qds/viz-token). */
  tokenPath?: string;
  /**
   * In-box env/pid/log paths, defaulting to driver.ts's VIZ_* constants. Same
   * kind of seam as `tokenPath`: under FakeDriver every "box" is a process on
   * ONE host, so the fixed /tmp paths are shared state and concurrent test
   * runs collide on them. Production passes none of these.
   */
  envFile?: string;
  pidFile?: string;
  logFile?: string;
  /**
   * Discard the persisted host token and mint a fresh one (Q8/F029). Off by
   * default — reuse is the documented convenience. Every already-issued
   * credential stops working, so an operator re-authenticates in the browser.
   */
  rotate?: boolean;
}

export interface DeployResult {
  /** Printed for the operator — never executed here (INV-2). */
  forwardCommand: string;
  port: number;
  reused: boolean;
}

export interface StopOptions {
  vm: string;
  /** Same seam as DeployOptions.pidFile — must match the path start used. */
  pidFile?: string;
  requestId?: string;
  runId?: string;
}

export interface StopResult {
  stopped: boolean;
  reason: string;
}

/**
 * Mint the host-side token on first use; verify-and-reuse on every call
 * after. The three syscall-level checks (regular file, mode exactly 0600,
 * owned by the calling uid) are the entire trust boundary — anything short
 * of all three is `viz-token-unverifiable`, never a silent rewrite.
 */
function mintOrReuseToken(tokenPath: string, rotate = false): string {
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
  // Rotation is an unlink, not a rewrite-in-place: the O_EXCL|O_NOFOLLOW mint
  // below is what proves the file is ours and fresh, and it only holds on a
  // path that does not exist yet. `unlink` never follows a symlink, so a
  // hostile pre-placed link is removed rather than written through.
  if (rotate) rmSync(tokenPath, { force: true });
  let fd: number;
  try {
    fd = openSync(tokenPath, FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW | FS.O_WRONLY, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new ExeDevDriverError(
        "viz-token-unverifiable",
        `cannot mint host token at ${tokenPath}: ${(e as Error).message}`,
        `inspect ${tokenPath} by hand — it must not exist, or not be a symlink, before the first mint`,
      );
    }
    return reuseExistingToken(tokenPath);
  }
  try {
    const token = randomBytes(32).toString("hex");
    const buf = Buffer.from(token, "utf8");
    const written = writeSync(fd, buf);
    if (written !== buf.length) {
      throw new ExeDevDriverError(
        "viz-token-unverifiable",
        `short write minting host token at ${tokenPath} (${written}/${buf.length} bytes)`,
        `remove ${tokenPath} by hand — it is a partial file — then re-run to mint a fresh token`,
      );
    }
    return token;
  } finally {
    closeSync(fd);
  }
}

function reuseExistingToken(tokenPath: string): string {
  let fd: number;
  try {
    fd = openSync(tokenPath, FS.O_RDONLY | FS.O_NOFOLLOW);
  } catch (e) {
    throw new ExeDevDriverError(
      "viz-token-unverifiable",
      `${tokenPath} exists but cannot be opened without following symlinks: ${(e as Error).message}`,
      `inspect ${tokenPath} by hand; remove it only after confirming it is not a symlink to something sensitive, then re-run`,
    );
  }
  try {
    const st = fstatSync(fd);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const mode = st.mode & 0o777;
    if (!st.isFile() || mode !== 0o600 || (uid !== undefined && st.uid !== uid)) {
      throw new ExeDevDriverError(
        "viz-token-unverifiable",
        `${tokenPath} exists but is not a regular 0600 file owned by the caller (mode ${mode.toString(8)})`,
        `inspect ${tokenPath} by hand; remove it only after confirming it is safe to, then re-run`,
      );
    }
    const token = readFileSync(fd, "utf8").trim();
    // A crash or short write between O_CREAT and the mint write can leave an
    // empty or partial file. Reused verbatim it would pass every check above
    // and only fail later, opaquely, against the server's own byte minimum —
    // catch it here instead, named, before it is ever delivered.
    if (Buffer.byteLength(token, "utf8") < TOKEN_MIN_BYTES) {
      throw new ExeDevDriverError(
        "viz-token-unverifiable",
        `${tokenPath} exists but is only ${Buffer.byteLength(token, "utf8")} bytes (minimum ${TOKEN_MIN_BYTES}) — a partial write left it unusable`,
        `remove ${tokenPath} by hand and re-run to mint a fresh token`,
      );
    }
    return token;
  } finally {
    closeSync(fd);
  }
}

/**
 * `envFile` becomes part of a `sh -c` script, so it is validated against a
 * strict path grammar (charset allow-list, no `..` segments, not empty)
 * BEFORE interpolation — mirrors credentials.ts's `assertEnvFileSafe`
 * (src/providers/credentials.ts:332). Always VIZ_ENVFILE today, but the
 * validator is the primary defense, quoting the secondary one, not the
 * other way round.
 */
export function assertEnvFileSafe(envFile: string): void {
  // F034: the shared grammar (path-guard.ts) is now the check; the CODE and
  // MESSAGE below are this module's contract and are unchanged. Newly refused
  // here: "a//b", a trailing slash, and a leading "-".
  try {
    assertPlainBoxPath("envFile", envFile);
  } catch {
    throw new ExeDevDriverError(
      "viz-token-deliver-failed",
      `envFile ${JSON.stringify(envFile)} is not a plain path (charset [A-Za-z0-9._/-], no ".." segments) — refusing to build a shell script from it`,
      "pass an absolute in-box path or a box-relative path without shell metacharacters",
    );
  }
}

/** Box-side delivery — DF2.3's `deliverScript` shape, reused for the viz token env file. */
function vizDeliverScript(envFile: string): string {
  return (
    `umask 077 && mkdir -p "$(dirname '${envFile}')" && cat > '${envFile}' && ` +
    `chmod 600 '${envFile}' && ` +
    `python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode)[-3:])' '${envFile}'`
  );
}

async function deliverToken(driver: ProviderDriver, vm: string, token: string, envFile: string): Promise<void> {
  assertEnvFileSafe(envFile);
  const stdin = `QDS_VIZ_TOKEN=${token}\n`;
  const res = await driver.exec(vm, ["sh", "-c", vizDeliverScript(envFile)], stdin);
  const mode = res.stdout.trim();
  if (res.exitCode !== 0 || mode !== "600") {
    throw new ExeDevDriverError(
      "viz-token-deliver-failed",
      `token delivery to ${vm}:${envFile} failed (exit ${res.exitCode}, mode ${mode || "unknown"})`,
      `inspect the box by hand at ${envFile}, then retry startVisualizer`,
    );
  }
}

/**
 * A single bounded in-box script: poll `/api/health` (with the token, over
 * stdin — never argv) for up to `START_TIMEOUT_MS`, bailing early and
 * loudly if the spawned process has already exited. One exec call rather
 * than many round trips.
 */
function healthScript(port: number, pidfile: string, logfile: string): string {
  return `
TOKEN=$(cat)
end=$(( $(date +%s) + ${Math.ceil(START_TIMEOUT_MS / 1000)} ))
while [ "$(date +%s)" -lt "$end" ]; do
  if ! kill -0 "$(cat '${pidfile}' 2>/dev/null)" 2>/dev/null; then
    echo CRASHED
    tail -n 40 '${logfile}' 2>/dev/null
    exit 5
  fi
  code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:${port}/api/health" 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then
    echo HEALTHY
    exit 0
  fi
  if [ "$code" = "401" ]; then
    echo UNAUTHORIZED
    exit 7
  fi
  sleep ${HEALTH_POLL_MS / 1000}
done
echo TIMEOUT
exit 6
`.trim();
}

/** Pull the server's own named `VizError` code out of its startup-refusal log line, if present. */
function crashCode(tail: string): string | undefined {
  return /"code"\s*:\s*"([A-Za-z_]+)"/.exec(tail)?.[1];
}

async function pollHealth(
  driver: ProviderDriver,
  vm: string,
  port: number,
  token: string,
  pidFile: string,
  logFile: string,
): Promise<number> {
  const started = Date.now();
  const res = await driver.exec(vm, ["sh", "-c", healthScript(port, pidFile, logFile)], token);
  const healthMs = Date.now() - started;
  const [status, ...rest] = res.stdout.trim().split("\n");
  if (status === "HEALTHY") return healthMs;
  if (status === "UNAUTHORIZED") {
    throw new ExeDevDriverError(
      "viz-token-mismatch",
      `visualizer at ${vm}:${port} rejected this token (401) — a live in-box process is running with a different token`,
      "startVisualizer restarts a reused process automatically when this happens; if it recurs, inspect the box by hand",
    );
  }
  if (status === "CRASHED") {
    const tail = rest.join("\n");
    const code = crashCode(tail) ?? "viz-start-crashed";
    throw new ExeDevDriverError(
      code,
      `visualizer process exited before answering /api/health — log tail: ${tail.trim() || "(empty)"}`,
      `inspect the log at ${logFile} in the box, fix the reported condition, then re-run startVisualizer`,
    );
  }
  throw new ExeDevDriverError(
    "viz-health-timeout",
    `visualizer never answered 200 on /api/health within ${START_TIMEOUT_MS}ms`,
    `inspect the log at ${logFile} in the box; the process is alive but not serving`,
  );
}

/**
 * Start (or confirm) the visualizer in `opts.vm`, idempotently. AC3/AC4/
 * INV-1/INV-3/INV-5. Fail-closed on every named condition: the box is never
 * destroyed, never falls back to 0.0.0.0, never reaches for `expose`/
 * `setPublic` as a workaround, and retries nothing beyond the bounded health
 * poll already inside `pollHealth`.
 */
export async function startVisualizer(driver: ProviderDriver, opts: DeployOptions): Promise<DeployResult> {
  const requestId = opts.requestId ?? newRequestId();
  const runId = opts.runId ?? opts.vm;
  const port = opts.port ?? DEFAULT_VIZ_PORT;
  const envFile = opts.envFile ?? VIZ_ENVFILE;
  const pidFile = opts.pidFile ?? VIZ_PIDFILE;
  const logFile = opts.logFile ?? VIZ_LOGFILE;
  const started = Date.now();
  const base = { requestId, operation: "deploy.startVisualizer", runId, boxName: opts.vm, action: "startVisualizer" as const, port };

  try {
    const spawnStart = Date.now();
    const tokenPath = opts.tokenPath ?? TOKEN_PATH;
    const token = mintOrReuseToken(tokenPath, opts.rotate ?? false);
    await deliverToken(driver, opts.vm, token, envFile);
    let spawned = await spawnInBox(driver, opts.vm, { dbPath: opts.dbPath, port, cwd: opts.cwd, envFile, pidFile, logFile });
    const spawnMs = Date.now() - spawnStart;

    let healthMs: number;
    try {
      healthMs = await pollHealth(driver, opts.vm, port, token, pidFile, logFile);
    } catch (e) {
      // A reused pidfile means the in-box process was never restarted, so it
      // is still running under whatever token it was originally spawned
      // with. If the host token was rotated/deleted since (item 1 — the
      // deadlock this recovers from), the freshly-delivered token it just
      // got handed 401s forever. Restart the stale process under the token
      // we just delivered — one bounded retry, never a loop (INV-5); a
      // freshly-started process rejecting its own just-delivered token is a
      // different, unrecoverable-here problem and rethrows untouched.
      if (e instanceof ExeDevDriverError && e.code === "viz-token-mismatch" && spawned.reused) {
        await killInBox(driver, opts.vm, { pidFile });
        spawned = await spawnInBox(driver, opts.vm, { dbPath: opts.dbPath, port, cwd: opts.cwd, envFile, pidFile, logFile });
        healthMs = await pollHealth(driver, opts.vm, port, token, pidFile, logFile);
      } else {
        throw e;
      }
    }

    const durationMs = Date.now() - started;
    log({
      ...base,
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: durationMs,
      durationMs,
      status: "ok",
      spawn_ms: spawnMs,
      health_ms: healthMs,
      reused: spawned.reused,
    });
    return {
      forwardCommand: `ssh -L ${port}:127.0.0.1:${port} ${opts.vm}`,
      port,
      reused: spawned.reused,
    };
  } catch (e) {
    const durationMs = Date.now() - started;
    // `e` may reject with a non-Error — even null/undefined — so read through
    // a fallback object rather than off `e` directly (mirrors teardown.ts's
    // stopVisualizer-step catch).
    const cause = (e ?? {}) as { message?: string };
    const named =
      e instanceof ExeDevDriverError
        ? e
        : new ExeDevDriverError("viz-start-failed", cause.message ?? String(e), "inspect the box by hand, then retry startVisualizer");
    log({
      ...base,
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: durationMs,
      durationMs,
      status: "error",
      error: { code: named.code, message: named.message, stack: named.stack },
    });
    throw named;
  }
}

/**
 * Stop the visualizer in `opts.vm`. Mirrors driver.ts's own non-throwing
 * contract for "nothing to stop" / "already dead"; a transport-level throw
 * still propagates (the caller's job — teardown.ts per AC6 — decides
 * whether to swallow it).
 */
export async function stopVisualizer(driver: ProviderDriver, opts: StopOptions): Promise<StopResult> {
  const requestId = opts.requestId ?? newRequestId();
  const runId = opts.runId ?? opts.vm;
  const started = Date.now();
  const base = { requestId, operation: "deploy.stopVisualizer", runId, boxName: opts.vm, action: "stopVisualizer" as const };
  try {
    const result = await killInBox(driver, opts.vm, { pidFile: opts.pidFile });
    const durationMs = Date.now() - started;
    log({
      ...base,
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: durationMs,
      durationMs,
      status: "ok",
      stopped: result.stopped,
      reason: result.reason,
    });
    return result;
  } catch (e) {
    const durationMs = Date.now() - started;
    // `e` may reject with a non-Error — even null/undefined — so read through
    // a fallback object rather than off `e` directly (mirrors teardown.ts's
    // stopVisualizer-step catch); otherwise this log line never gets written
    // and the original failure is silently replaced by a TypeError.
    const err = (e ?? {}) as Partial<Error>;
    log({
      ...base,
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: durationMs,
      durationMs,
      status: "error",
      error: { code: "viz-stop-failed", message: err.message ?? String(e), stack: err.stack },
    });
    throw e;
  }
}
