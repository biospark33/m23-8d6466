import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { HarnessResult } from "../src/types.ts";

const PKG_DIR = join(import.meta.dir, "..");
const SHIM_BIN = join(import.meta.dir, "fixtures", "bin");

/** Run the real CLI entry as a subprocess and return exit code + parsed JSON. */
async function runCli(...args: string[]): Promise<{ code: number; result: HarnessResult }> {
  const proc = Bun.spawn(["bun", "run", "src/index.ts", ...args], {
    cwd: PKG_DIR,
    env: { ...process.env, PATH: `${SHIM_BIN}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return { code, result: JSON.parse(stdout) as HarnessResult };
}

describe("e2e: bun run src/index.ts run --manifest <fixture>", () => {
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
});
