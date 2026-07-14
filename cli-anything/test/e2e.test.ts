import { describe, expect, it } from "bun:test";
import { delimiter, join } from "node:path";
import type { HarnessResult } from "../src/types.ts";

const PKG_DIR = join(import.meta.dir, "..");
const SHIM_BIN = join(import.meta.dir, "fixtures", "bin");

/** Generous ceiling so a hung CLI can never hang the suite. */
const CLI_KILL_TIMEOUT_MS = 15_000;

/** Run the real CLI entry as a subprocess and return exit code + parsed JSON. */
async function runCli(...args: string[]): Promise<{ code: number; result: HarnessResult }> {
  const proc = Bun.spawn(["bun", "run", "src/index.ts", ...args], {
    cwd: PKG_DIR,
    env: { ...process.env, PATH: `${SHIM_BIN}${delimiter}${process.env.PATH ?? ""}` },
    stdout: "pipe",
    // stderr ignored, not piped: an unread stderr pipe can deadlock the child
    // on a full pipe buffer.
    stderr: "ignore",
  });
  const killTimer = setTimeout(() => proc.kill(), CLI_KILL_TIMEOUT_MS);
  try {
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    let result: HarnessResult;
    try {
      result = JSON.parse(stdout) as HarnessResult;
    } catch (err) {
      throw new Error(
        `runCli: stdout was not valid JSON (exit code ${code}): ${stdout.slice(0, 300)}`,
        { cause: err },
      );
    }
    return { code, result };
  } finally {
    clearTimeout(killTimer);
  }
}

// The shell fixtures (`sh -c ...`) are POSIX-only. win32 behavior is covered
// at unit level via the mergeEnv platform parameter (see runner.test.ts).
describe.skipIf(process.platform === "win32")(
  "e2e: bun run src/index.ts run --manifest <fixture>",
  () => {
    it("test-env.yaml → env_probe_result x7, QDS_PROBE=x7 in stdout_excerpt (AC1)", async () => {
      const { code, result } = await runCli(
        "run",
        "--manifest",
        "test/fixtures/test-env.yaml",
      );
      expect(code).toBe(0);
      expect(result.exit_class).toBe("ok");
      expect(result.env_probe_result).toBe("x7");
      expect(result.stdout_excerpt).toContain("QDS_PROBE=x7");
    });

    it("test-bare.yaml → non-empty PATH reaches the subprocess (AC2)", async () => {
      const { code, result } = await runCli(
        "run",
        "--manifest",
        "test/fixtures/test-bare.yaml",
      );
      expect(code).toBe(0);
      const pathLine = result.stdout_excerpt
        .split("\n")
        .find((l) => l.startsWith("PATH="));
      expect(pathLine).toBeDefined();
      expect(pathLine!.slice("PATH=".length).length).toBeGreaterThan(0);
    });
  },
);
