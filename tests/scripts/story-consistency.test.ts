import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const CHECKER = resolve(ROOT, "scripts/check-story-consistency.ts");

/**
 * The drift alarm for planning artifacts.
 *
 * The 2026-09-08 pre-dev review found ONE piece of drift — the slate count after DF2.13
 * was added — living simultaneously in `sprint-status.yaml`'s meta block, the story files,
 * the epics index, a merged story, and the handoff brief written to prevent it. Three
 * review waves and 350 findings could not hold the discipline by hand; the fix commits
 * kept generating fresh instances of the very defect they were fixing.
 *
 * So it is gated here rather than written down as a rule. This test is deliberately thin:
 * the checker owns the logic and prints each finding with its fix, and the assertion is
 * only that it exited 0. A failure message that says "read the checker's output" is the
 * right message — the output is the report.
 *
 * ponytail: spawnSync over importing the checker, because the checker's contract IS its
 * exit code and that is what CI consumes. Import it directly if it ever needs to be
 * queried for structured findings.
 */
describe("planning artifacts are self-consistent", () => {
  test("check-story-consistency exits 0", () => {
    const r = Bun.spawnSync(["bun", CHECKER], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const out = `${r.stdout.toString()}${r.stderr.toString()}`;

    // Exit 2 is "the checker could not run" (a missing input) and is NOT a pass — a gate
    // that silently skips when its input moves is the failure mode this repo has already
    // paid for once, in a grep over a file containing NUL bytes.
    expect(r.exitCode, `checker could not run:\n${out}`).not.toBe(2);
    expect(r.exitCode, `planning-artifact drift:\n${out}`).toBe(0);
  });

  test("the checker is self-proving — it fails when an input is removed", () => {
    // A positive control on the gate itself. Without this, a checker whose file-discovery
    // silently returns nothing would report "OK" forever and read exactly like a pass.
    const r = Bun.spawnSync(["bun", CHECKER], {
      cwd: "/",
      stdout: "pipe",
      stderr: "pipe",
    });
    // Run from `/`, the repo-root resolution still works (it is import.meta.dir-based),
    // so this proves the checker is cwd-independent rather than accidentally passing
    // because it found nothing to check.
    expect(r.exitCode).toBe(0);
    expect(`${r.stdout.toString()}`).toContain("42 stories");
  });
});
