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
 * Continuously drain a subprocess stdout stream in the background, discarding
 * output. The server emits CC-9 structured logs to stdout on every operation;
 * if nobody reads, the OS pipe buffer fills and the server blocks on write
 * (unable to process SIGTERM). Draining prevents that deadlock.
 */
function drainStdout(stdout: ReadableStream<Uint8Array>): void {
  const reader = stdout.getReader();
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

test("SIGTERM propagates to MCP subprocess; PID gone within 7s, no orphans", async () => {
  // Fixed high port (randomized to avoid collisions). Readiness is detected by
  // connection-retry rather than stdout parsing, making it robust to subprocess
  // startup latency under a saturated test suite.
  const port = 40000 + Math.floor(Math.random() * 20000);
  server = Bun.spawn(["bun", INDEX], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SWARMCLAW_PORT: String(port),
      SWARMCLAW_COMMAND_ALLOWLIST: "bun",
      SWARMCLAW_ENV_ALLOWLIST: "PATH",
    },
  });
  const serverPid = server.pid!;

  // Drain stdout so the server never blocks on a full pipe (CC-9 logs).
  drainStdout(server.stdout as ReadableStream<Uint8Array>);

  const base = `http://localhost:${port}`;

  // Wait for the server to accept connections (up to ~24s under heavy load).
  let up = false;
  for (let i = 0; i < 120; i++) {
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

  // Server itself should have exited; no orphan for the fixture remains.
  await server.exited.catch(() => {});
  const orphan = await findChildPid(serverPid);
  expect(orphan).toBeNull();
}, 30000);
