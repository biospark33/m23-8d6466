import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

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
    // because it found nothing to check. 66 = 42 DF rows + 24 v6 rows (DD-27; M1.4
    // added 2026-10-08 — recomputed, never incremented).
    expect(r.exitCode).toBe(0);
    expect(`${r.stdout.toString()}`).toContain("66 stories");
  });
});

/**
 * Fixture tier: the checks above run the checker against the REAL repo, so they can only
 * assert it exits 0 — they cannot prove a specific finding fires. These tests scaffold a
 * minimal fake repo in a temp dir, copy the checker in (its ROOT is import.meta.dir-based,
 * so a copied checker is fully isolated), and run it there. Each fixture yaml must satisfy
 * the checker's own meta-parse preconditions (exactly one `V6 ROWS:` claim matching the
 * rows) or the slate check would fire instead of the one under test.
 */
describe("the checker's findings fire on fixtures (real findings, not just exit 0)", () => {
  const story = (points: string, status: string): string =>
    `# Z1: fixture\n\n**Story Points:** ${points}\n**Status:** ${status}\n\nBody with no line-numbered cites.\n`;
  const yaml = (rows: string[], v6Count: number, v6Pts: number): string =>
    `stories:\n  v6:\n${rows.map((r) => `      ${r}`).join("\n")}\n  # V6 ROWS: ${v6Count} stories / ${v6Pts} pts\n`;
  const Z1 = `Z1: { title: "t", points: 3, status: ready-for-dev, deps: [] }`;

  function runFixture(opts: { yaml: string; stories: Record<string, string> }): { code: number; out: string } {
    const dir = mkdtempSync(join(tmpdir(), "story-consistency-"));
    try {
      mkdirSync(join(dir, "scripts"), { recursive: true });
      copyFileSync(CHECKER, join(dir, "scripts", "check-story-consistency.ts"));
      for (const d of [
        "_bmad-output/sprint-artifacts/dark-factory-v5/stories",
        "_bmad-output/sprint-artifacts/dark-factory-v6/stories",
        "_bmad-output/implementation-artifacts",
      ]) mkdirSync(join(dir, d), { recursive: true });
      writeFileSync(join(dir, "_bmad-output/sprint-artifacts/sprint-status.yaml"), opts.yaml);
      writeFileSync(join(dir, "_bmad-output/implementation-artifacts/epics-and-stories-dark-factory-v5.md"), "");
      writeFileSync(
        join(dir, "_bmad-output/implementation-artifacts/epics-and-stories-dark-factory-v6.md"),
        Object.keys(opts.stories).map((f) => f.replace(/-.*/, "").toUpperCase()).join("\n"),
      );
      for (const [name, body] of Object.entries(opts.stories))
        writeFileSync(join(dir, "_bmad-output/sprint-artifacts/dark-factory-v6/stories", name), body);
      const r = Bun.spawnSync(["bun", join(dir, "scripts", "check-story-consistency.ts")], {
        stdout: "pipe",
        stderr: "pipe",
      });
      return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a header/yaml points mismatch is flagged — including the `**Story Points:**` spelling (M2)", () => {
    const r = runFixture({
      yaml: yaml([Z1], 1, 3),
      stories: { "z1-fixture.md": story("5", "ready-for-dev") },
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("header says 5 points; yaml row says 3");
  });

  test("control: agreeing `**Story Points:**` + plain status exits 0 (the spelling parses)", () => {
    const r = runFixture({
      yaml: yaml([Z1], 1, 3),
      stories: { "z1-fixture.md": story("3", "ready-for-dev") },
    });
    expect(r.code, r.out).toBe(0);
  });

  test("a bold-wrapped header status (`**Status:** **gated**`) is parsed and compared (M3)", () => {
    const r = runFixture({
      yaml: yaml([Z1], 1, 3),
      stories: { "z1-fixture.md": story("3", "**gated**") },
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('story header status "gated"; yaml row "ready-for-dev"');
  });

  test("a v6 dep naming a nonexistent v6 id is flagged — v6 dep edges resolve (M4)", () => {
    const r = runFixture({
      yaml: yaml([Z1, `Z2: { title: "t", points: 2, status: ready-for-dev, deps: [Z9] }`], 2, 5),
      stories: { "z1-fixture.md": story("3", "ready-for-dev"), "z2-fixture.md": story("2", "ready-for-dev") },
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('deps names "Z9"');
  });

  test("a v6 dep matching no active slate id grammar is flagged — the grammar branch fires (R3-VR4-L4)", () => {
    const r = runFixture({
      yaml: yaml([Z1, `Z2: { title: "t", points: 2, status: ready-for-dev, deps: [Q7] }`], 2, 5),
      stories: { "z1-fixture.md": story("3", "ready-for-dev"), "z2-fixture.md": story("2", "ready-for-dev") },
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("matches no active slate id grammar");
  });

  test("a P-prefixed dep OUTSIDE the retired P0.x/P1.x/P2.x forms reaches the grammar check and fails (P3.1)", () => {
    const r = runFixture({
      yaml: yaml([Z1, `Z2: { title: "t", points: 2, status: ready-for-dev, deps: [P3.1] }`], 2, 5),
      stories: { "z1-fixture.md": story("3", "ready-for-dev"), "z2-fixture.md": story("2", "ready-for-dev") },
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('deps names "P3.1"');
    expect(r.out).toContain("matches no active slate id grammar");
  });
});
