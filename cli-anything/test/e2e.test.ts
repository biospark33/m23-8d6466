import { describe, expect, it } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { HarnessResult } from "../src/types.ts";

const PKG_DIR = join(import.meta.dir, "..");
const SHIM_BIN = join(import.meta.dir, "fixtures", "bin");

/** Generous ceiling so a hung CLI can never hang the suite. */
const CLI_KILL_TIMEOUT_MS = 15_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RunCliOptions {
  /** Override the PATH prefix. Defaults to the warren shim dir + parent PATH. */
  path?: string;
  /** Override the safety kill timer. Defaults to CLI_KILL_TIMEOUT_MS. */
  killAfterMs?: number;
}

interface SpawnCliOutcome {
  code: number | null;
  signal: string | null;
  stdout: string;
}

/** Collect direct child PIDs of `pid` using pgrep (POSIX). */
function pgrepChildrenSync(pid: number): number[] {
  if (process.platform === "win32") return [];
  try {
    const out = execFileSync("pgrep", ["-P", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .trim()
      .split("\n")
      .filter((s) => s.length > 0)
      .map(Number)
      .filter((n) => Number.isInteger(n));
  } catch {
    return [];
  }
}

/** Recursively collect all descendant PIDs of `pid` (POSIX). */
function collectProcessTreeSync(pid: number): number[] {
  if (process.platform === "win32") return [];
  const children = pgrepChildrenSync(pid);
  const descendants: number[] = [];
  for (const child of children) {
    descendants.push(child, ...collectProcessTreeSync(child));
  }
  return descendants;
}

/** Spawn the real CLI entry as a subprocess and collect stdout + exit status. */
async function spawnCli(
  args: string[],
  opts: RunCliOptions = {},
): Promise<SpawnCliOutcome> {
  const pathPrefix =
    opts.path ?? `${SHIM_BIN}${delimiter}${process.env.PATH ?? ""}`;
  const killAfterMs = opts.killAfterMs ?? CLI_KILL_TIMEOUT_MS;

  if (process.platform === "win32") {
    const proc = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
      cwd: PKG_DIR,
      env: { ...process.env, PATH: pathPrefix, QDS_LOG_VERBOSE: "1" },
      stdout: "pipe",
      // stderr ignored, not piped: an unread stderr pipe can deadlock the child
      // on a full pipe buffer.
      stderr: "ignore",
    });
    const killTimer = setTimeout(() => proc.kill(), killAfterMs);
    try {
      const [stdout, code] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      return { code, signal: null, stdout };
    } finally {
      clearTimeout(killTimer);
    }
  }

  // POSIX: run detached so the CLI becomes a process-group leader; the safety
  // kill can then target the whole group and we can also walk the child tree.
  const proc = spawn(process.execPath, ["run", "src/index.ts", ...args], {
    cwd: PKG_DIR,
    // F088: the CLI mutes its stdout result contract under NODE_ENV=test,
    // which the child inherits; this suite parses that stdout, so opt back in.
    env: { ...process.env, PATH: pathPrefix, QDS_LOG_VERBOSE: "1" },
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
  });

  let stdout = "";
  proc.stdout!.setEncoding("utf8");
  proc.stdout!.on("data", (chunk: string) => {
    stdout += chunk;
  });

  return new Promise((resolve) => {
    const killTimer = setTimeout(() => {
      if (proc.pid !== undefined) {
        // Collect descendants before killing the parent so they cannot escape
        // reparenting before we terminate them.
        const tree = collectProcessTreeSync(proc.pid);
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          // Process group already gone.
        }
        // The CLI spawns warren detached in its own group; a plain group kill
        // of the CLI would leave that tree behind. Kill every descendant we
        // observed to guarantee no orphans.
        for (const target of tree) {
          try {
            process.kill(target, "SIGKILL");
          } catch {
            // Already dead.
          }
        }
      }
      try {
        proc.kill("SIGKILL");
      } catch {
        // Process already gone.
      }
    }, killAfterMs);

    proc.on("error", () => {
      clearTimeout(killTimer);
      resolve({ code: null, signal: null, stdout });
    });

    proc.on("exit", (code, signal) => {
      clearTimeout(killTimer);
      resolve({ code, signal, stdout });
    });
  });
}

/** Run the real CLI entry as a subprocess and return exit code + parsed JSON. */
async function runCli(
  args: string[],
  opts?: RunCliOptions,
): Promise<{ code: number; result: HarnessResult }> {
  const { code, stdout } = await spawnCli(args, opts);
  const exitCode = code ?? 1;
  let result: HarnessResult;
  try {
    result = JSON.parse(stdout) as HarnessResult;
  } catch (err) {
    throw new Error(
      `runCli: stdout was not valid JSON (exit code ${exitCode}): ${stdout.slice(0, 300)}`,
      { cause: err },
    );
  }
  return { code: exitCode, result };
}

/**
 * Run the CLI with a short safety kill timer and return the signal that ended
 * it. Used to exercise the e2e kill-escape path.
 */
async function runCliUntilKilled(
  args: string[],
  killAfterMs: number,
): Promise<{ signal: string; stdout: string }> {
  const { code, signal, stdout } = await spawnCli(args, { killAfterMs });
  if (signal === null) {
    throw new Error(
      `runCliUntilKilled: expected process to be killed, got exit code ${code}, stdout: ${stdout.slice(0, 200)}`,
    );
  }
  return { signal, stdout };
}

// The shell fixtures (`sh -c ...`) are POSIX-only. win32 behavior is covered
// at unit level via the mergeEnv platform parameter (see runner.test.ts).
describe.skipIf(process.platform === "win32")(
  "e2e: bun run src/index.ts run --manifest <fixture>",
  () => {
    it("test-env.yaml → env_probe_result x7, QDS_PROBE=x7 in stdout_excerpt (AC1)", async () => {
      const { code, result } = await runCli([
        "run",
        "--manifest",
        "test/fixtures/test-env.yaml",
      ]);
      expect(code).toBe(0);
      expect(result.exit_class).toBe("ok");
      expect(result.env_probe_result).toBe("x7");
      expect(result.stdout_excerpt).toContain("QDS_PROBE=x7");
    });

    it("test-bare.yaml → non-empty PATH reaches the subprocess (AC2)", async () => {
      const { code, result } = await runCli([
        "run",
        "--manifest",
        "test/fixtures/test-bare.yaml",
      ]);
      expect(code).toBe(0);
      const pathLine = result.stdout_excerpt
        .split("\n")
        .find((l) => l.startsWith("PATH="));
      expect(pathLine).toBeDefined();
      expect(pathLine!.slice("PATH=".length).length).toBeGreaterThan(0);
    });

    it("timeout: long sleep with short --timeout-ms → exit 124, exit_class timeout", async () => {
      const start = Date.now();
      const { code, result } = await runCli([
        "run",
        "--manifest",
        "test/fixtures/test-timeout.yaml",
        "--timeout-ms",
        "500",
      ]);
      expect(code).toBe(124);
      expect(result.exit_class).toBe("timeout");
      expect(result.signal).toBe("SIGKILL");
      expect(result.exit_code).toBeNull();
      expect(Date.now() - start).toBeLessThan(5000);
    });

    it("spawn_error: missing warren binary → exit 127, exit_class spawn_error", async () => {
      const emptyPath = await mkdtemp(join(tmpdir(), "qds-empty-path-"));
      try {
        const { code, result } = await runCli(
          ["run", "--manifest", "test/fixtures/test-env.yaml"],
          { path: emptyPath },
        );
        expect(code).toBe(127);
        expect(result.exit_class).toBe("spawn_error");
        expect(result.spawn_error_code).toBe("ENOENT");
        expect(result.exit_code).toBeNull();
      } finally {
        await rm(emptyPath, { recursive: true, force: true });
      }
    });

    it("manifest validation error: malformed YAML → exit 65", async () => {
      const { code, stdout } = await spawnCli([
        "run",
        "--manifest",
        "test/fixtures/test-invalid-yaml.yaml",
      ]);
      expect(code).toBe(65);
      expect(stdout.trim()).toBe("");
    });

    it("manifest validation error: missing required fields → exit 65", async () => {
      const { code, stdout } = await spawnCli([
        "run",
        "--manifest",
        "test/fixtures/test-missing-fields.yaml",
      ]);
      expect(code).toBe(65);
      expect(stdout.trim()).toBe("");
    });

    it("kill-timer reaps a hung CLI without hanging the suite and leaves no orphan sleep", async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), "qds-e2e-kill-"));
      const pidFile = join(tmpDir, "gchild.pid");
      const manifestPath = join(tmpDir, "manifest.yaml");
      let gchildPid: number | undefined;
      try {
        await mkdir(tmpDir, { recursive: true });
        await writeFile(
          manifestPath,
          [
            "name: e2e-kill-target",
            "command: sh",
            "args:",
            '  - "-c"',
            "  - >-",
            '    sleep 1000 & echo $! > "$PIDFILE";',
            "    exec sleep 1000",
            "env:",
            `  PIDFILE: ${pidFile}`,
            "",
          ].join("\n"),
        );

        const start = Date.now();
        const { signal } = await runCliUntilKilled(
          ["run", "--manifest", manifestPath],
          800,
        );
        expect(Date.now() - start).toBeLessThan(5000);
        expect(signal).toBe("SIGKILL");

        // The grandchild sleep must have been reaped (either by the process
        // group kill or by the recursive tree cleanup).
        for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(25);
        if (existsSync(pidFile)) {
          gchildPid = Number(readFileSync(pidFile, "utf8").trim());
          expect(Number.isInteger(gchildPid)).toBe(true);
          let alive = true;
          for (let i = 0; i < 40; i++) {
            try {
              process.kill(gchildPid!, 0);
              await sleep(50);
            } catch {
              alive = false;
              break;
            }
          }
          expect(alive).toBe(false);
        }
      } finally {
        if (gchildPid !== undefined) {
          try {
            process.kill(gchildPid, "SIGKILL");
          } catch {
            // Already dead.
          }
        }
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  },
);
