/**
 * Integration test for the pi-lens headless verification harness (Story P0.5).
 *
 * Spawns `bun scripts/pi-lens-verify.ts` from the repo root and asserts the
 * structured JSON verdict: exit 0, parseable stdout, summary.fail === 0,
 * summary.pass >= 1. The harness drives the real pi-lens MCP server (LSP cold
 * start + bounded polls), so a plain run takes ~1-2 min — the test timeout is
 * sized for that.
 *
 * Graceful degradation: pi-lens is a host-global install, not a repo dep, so
 * machines/CI without it must stay green. The test probes the same install
 * candidates the harness itself uses and test.skip()s when none resolve.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.join(import.meta.dir, "..");
const HARNESS = path.join(REPO_ROOT, "scripts", "pi-lens-verify.ts");

// The harness run is ~1-2 min (LSP cold start + bounded polls). Budget the
// child process slightly less than the test timeout so a hung harness fails
// with its captured stderr instead of an opaque test-timeout abort.
const CHILD_TIMEOUT_MS = 170_000;
const TEST_TIMEOUT_MS = 180_000;

/**
 * Resolve the pi-lens MCP server entry point, mirroring the candidate list in
 * the harness's own resolvePiLens() (the script is NOT imported — it
 * self-executes main()). Returns undefined when pi-lens is not installed.
 */
function resolvePiLensServer(): string | undefined {
  const candidates = [
    path.join(os.homedir(), ".local", "node-arm64", "lib", "node_modules", "pi-lens"),
    path.join(os.homedir(), ".local", "node-x64", "lib", "node_modules", "pi-lens"),
  ];
  try {
    const g = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    candidates.push(path.join(g, "pi-lens"));
  } catch {
    /* npm unavailable — probe the known dirs only */
  }
  for (const c of candidates) {
    const server = path.join(c, "dist", "mcp", "server.js");
    if (fs.existsSync(path.join(c, "package.json")) && fs.existsSync(server)) {
      return server;
    }
  }
  return undefined;
}

interface VerifySummary {
  piLensVersion: string;
  pass: number;
  fail: number;
  skip: number;
}

interface VerifyOutput {
  results: Array<{ ac: string; name: string; status: string }>;
  summary: VerifySummary;
}

const piLensAvailable = resolvePiLensServer() !== undefined;
// Skip (not fail) when pi-lens is absent so `bun test` stays green on machines
// and CI runners without the global install.
const liveTest = piLensAvailable ? test : test.skip;

describe("pi-lens verification harness (P0.5)", () => {
  liveTest(
    "harness exits 0 with all checks passing",
    () => {
      const proc = spawnSync("bun", [HARNESS], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: CHILD_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (proc.error) {
        throw new Error(`failed to run harness: ${proc.error.message}\nstderr: ${proc.stderr.slice(-2000)}`);
      }
      expect(proc.status, `harness stderr: ${proc.stderr.trim().slice(-2000)}`).toBe(0);

      let out: VerifyOutput;
      try {
        out = JSON.parse(proc.stdout) as VerifyOutput;
      } catch (err) {
        throw new Error(
          `harness stdout is not valid JSON: ${err instanceof Error ? err.message : String(err)}\nstdout: ${proc.stdout.slice(-2000)}`,
        );
      }
      expect(out.summary.fail).toBe(0);
      expect(out.summary.pass).toBeGreaterThanOrEqual(1);
    },
    TEST_TIMEOUT_MS,
  );
});
