/**
 * Lifecycle test (AC6 + DoD): SIGTERM to the SwarmClaw server must propagate
 * SIGTERM to MCP subprocesses; within the grace window (2s SIGTERM + 5s) the
 * subprocess PID must no longer exist, and no orphans remain.
 *
 * The server is spawned as a real OS subprocess so we can signal it and observe
 * the child MCP subprocess via the OS process table.
 */
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const INDEX = join(ROOT, "src", "swarmclaw", "index.ts");
const FAKE = join(import.meta.dir, "fixtures", "fake-mcp-server.ts");

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Continuously drain a subprocess stream in the background, discarding
 * output. The server emits CC-9 structured logs to stdout on every operation;
 * if nobody reads, the OS pipe buffer fills and the server blocks on write
 * (unable to process SIGTERM). Draining prevents that deadlock — stderr is
 * drained for the same reason.
 */
function drain(stream: ReadableStream<Uint8Array>): void {
  const reader = stream.getReader();
  void (async () => {
    try {
      for (let done = false; !done; ) {
        done = (await reader.read()).done;
      }
    } catch {
      /* stream closed */
    }
  })();
}

/**
 * Drain stdout line-by-line, invoking onLine for each complete line. Used to
 * discover the ephemeral port the server bound (SWARMCLAW_PORT=0) from its
 * startup log line. {stream:true} keeps multibyte UTF-8 split across chunks
 * intact.
 */
function drainLines(stdout: ReadableStream<Uint8Array>, onLine: (line: string) => void): void {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        // biome-ignore lint/suspicious/noAssignInExpressions: standard line-buffer drain
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          onLine(line);
        }
      }
    } catch {
      /* stream closed */
    }
  })();
}

let server: ReturnType<typeof Bun.spawn> | null = null;

afterEach(async () => {
  if (server?.pid && pidAlive(server.pid)) {
    try {
      server.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    await server.exited.catch(() => {});
  }
  server = null;
});

async function findChildPid(parentPid: number): Promise<number | null> {
  // List bun processes running the fixture, whose PPID is the server.
  const proc = Bun.spawn(["ps", "-eo", "pid,ppid,command"], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  for (const line of out.split("\n")) {
    if (!line.includes("fake-mcp-server.ts")) continue;
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (ppid === parentPid) return pid;
  }
  return null;
}

/**
 * PPID-agnostic sweep: PIDs of ANY process running the fixture, however it is
 * parented. After the server exits, a leaked fixture subprocess is reparented
 * to PID 1, so a ppid match would never see it — scan the whole table.
 */
async function listFixturePids(): Promise<number[]> {
  const proc = Bun.spawn(["ps", "-eo", "pid,command"], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    if (!line.includes("fake-mcp-server.ts")) continue;
    const m = line.trim().match(/^(\d+)\s+/);
    if (m) pids.push(Number(m[1]));
  }
  return pids;
}

test("SIGTERM propagates to MCP subprocess; PID gone within 7s, no orphans", async () => {
  // Ephemeral port (SWARMCLAW_PORT=0) — a random fixed port can collide with
  // the OS ephemeral range (49152-65535) or another process. The assigned port
  // is discovered from the server's startup log line; readiness is then
  // confirmed by connection-retry, robust to startup latency under load.
  server = Bun.spawn(["bun", INDEX], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SWARMCLAW_PORT: "0",
      SWARMCLAW_COMMAND_ALLOWLIST: "bun",
      SWARMCLAW_ENV_ALLOWLIST: "PATH",
    },
  });
  const serverPid = server.pid!;

  // Drain stdout (line-buffered, for port discovery) and stderr (discard) so
  // the server never blocks on a full pipe (CC-9 logs).
  let port: number | undefined;
  drainLines(server.stdout as ReadableStream<Uint8Array>, (line) => {
    try {
      const parsed = JSON.parse(line) as { message?: string; port?: unknown };
      if (parsed.message === "swarmclaw listening" && typeof parsed.port === "number") {
        port = parsed.port;
      }
    } catch {
      /* non-JSON line */
    }
  });
  drain(server.stderr as ReadableStream<Uint8Array>);

  // Wait for the startup line carrying the bound port (up to ~24s under load).
  for (let i = 0; i < 120 && port === undefined; i++) {
    await sleep(200);
  }
  expect(port).toBeDefined();
  const base = `http://localhost:${port!}`;

  // Confirm readiness by connection-retry (up to ~12s under heavy load).
  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "x", capabilities: ["x"] }),
      });
      if (r.status < 500) {
        up = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  expect(up).toBe(true);

  // Register an MCP server → spawns the fake stdio subprocess.
  const reg = await fetch(`${base}/api/mcp-servers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "lc", transport: "stdio", command: "bun", args: [FAKE] }),
  });
  expect(reg.status).toBe(201);

  // Locate the child MCP subprocess PID.
  const childPid = await findChildPid(serverPid);
  expect(childPid).not.toBeNull();
  expect(pidAlive(childPid!)).toBe(true);

  // Send SIGTERM to the server.
  server.kill("SIGTERM");

  // Within 7s (2s SIGTERM window + 5s grace) the child must be gone.
  let gone = false;
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (!pidAlive(childPid!)) {
      gone = true;
      break;
    }
    await sleep(200);
  }
  expect(gone).toBe(true);

  // Server itself should have exited; the child must be gone, and no fixture
  // process may remain anywhere on the process table.
  await server.exited.catch(() => {});
  expect(pidAlive(childPid!)).toBe(false);
  // PPID-agnostic orphan sweep: once the server exits, a leaked fixture
  // subprocess would be reparented to PID 1, so the old ppid match could never
  // see it. Scan the whole table instead. bun runs test files serially in one
  // process and every other suite shuts its fixtures down in afterEach, so no
  // other fixture process can legitimately be alive at this point.
  const leaked = await listFixturePids();
  expect(leaked).toEqual([]);
}, 60000);
