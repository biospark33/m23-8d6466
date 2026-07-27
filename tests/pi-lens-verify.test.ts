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
 * machines/CI without it must stay green. The test imports the harness's own
 * install resolver and test.skip()s when no install resolves.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { resolvePiLens } from "../scripts/pi-lens-verify.ts";

const REPO_ROOT = path.join(import.meta.dir, "..");
const HARNESS = path.join(REPO_ROOT, "scripts", "pi-lens-verify.ts");

// The harness run is ~1-2 min (LSP cold start + bounded polls). Budget the
// child process slightly less than the test timeout so a hung harness fails
// with its captured stderr instead of an opaque test-timeout abort.
const CHILD_TIMEOUT_MS = 170_000;
const TEST_TIMEOUT_MS = 180_000;

/**
 * Resolve the pi-lens MCP server entry point via the harness's OWN resolver
 * (imported — the harness guards main() behind import.meta.main, so importing
 * it does not self-execute). Returns undefined when pi-lens is not installed:
 * the harness resolver throws in that case, the test needs a probe instead.
 */
function resolvePiLensServer(): string | undefined {
  try {
    return resolvePiLens().server;
  } catch {
    return undefined;
  }
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
// and CI runners without the install — but say so, so a wholly-skipped file is
// never silently dark (#65).
if (!piLensAvailable) {
  console.warn(
    "[pi-lens-verify.test] pi-lens is not resolvable (PI_LENS_ROOT unset/invalid, no repo-local node_modules/pi-lens, no global install) — the P0.5 harness integration test is SKIPPED. Set PI_LENS_ROOT to a pi-lens install root to run it.",
  );
}
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
        // On spawn failure proc.stderr can be null — guard before slicing.
        const tail = proc.stderr ? proc.stderr.slice(-2000) : "(no stderr captured)";
        throw new Error(`failed to run harness: ${proc.error.message}\nstderr: ${tail}`);
      }
      // Same guard for the assertion message (null stderr on spawn failure).
      const stderrTail = proc.stderr ? proc.stderr.trim().slice(-2000) : "(no stderr captured)";
      expect(proc.status, `harness stderr: ${stderrTail}`).toBe(0);

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
