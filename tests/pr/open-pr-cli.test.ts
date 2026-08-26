/**
 * The `bun scripts/open-pr.ts <run-id>` argument boundary (Story DF5.2).
 *
 * The id reaches a git ref (`refs/sandbox/<run-id>`) and a refusal-file path
 * (`<prDir>/<run-id>.refusals.jsonl`), so the operator surface has to reject a
 * malformed one before either is named after it. `openPullRequest` asserts the
 * same grammar — this covers the argv path specifically, where the failure has
 * to read as a usage error and exit 2 rather than as an unhandled throw.
 *
 * Spawns the real CLI: exit codes are the contract, and only a process has one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

const CLI = join(import.meta.dir, "../../scripts/open-pr.ts");

// `openPullRequest` defaults `hostRoot` to `process.cwd()`, so a refusal writes
// `<cwd>/.sandbox/pr/<run-id>.refusals.jsonl`. Run every case in a throwaway
// cwd: the operator's own `.sandbox/` is not this test's to append to, and a
// test that reads the ambient repo state is a test that passes for the wrong
// reason. The CLI is addressed absolutely, so cwd is free to be anywhere.
const CWD = mkdtempSync(join(tmpdir(), "open-pr-cli-"));
afterAll(() => rmSync(CWD, { recursive: true, force: true }));

async function runCli(...argv: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...argv], {
    cwd: CWD,
    // A TTY-less stdin that yields nothing: `readHostToken`'s piped-token
    // fallback must not block, and no test here should ever reach a real push.
    stdin: new Blob([""]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("the CLI argument boundary", () => {
  test("a traversing id is a usage error, not an unhandled throw", async () => {
    const r = await runCli("../../etc/x");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid run id");
    expect(r.stderr).toContain("usage: bun scripts/open-pr.ts <run-id>");
    // Exit 2 is "usage/unexpected"; 1 is "refused". A malformed id never
    // reaches the point where the factory could refuse anything.
    expect(r.code).not.toBe(1);
  });

  test.each([["UPPER"], ["has space"], [""], ["a/b"], ["a..b"]])(
    "%p is rejected at the boundary",
    async (arg: string) => {
      const r = await runCli(arg);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("invalid run id");
    },
  );

  test("a missing argument and an option-shaped one print usage", async () => {
    for (const argv of [[], ["-x"]]) {
      const r = await runCli(...argv);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("usage: bun scripts/open-pr.ts <run-id>");
    }
  });

  test("a WELL-FORMED id passes the boundary and refuses on its merits", async () => {
    // The guard must not swallow valid ids: this one is well-formed and simply
    // has no run record, which is a refusal (exit 1), not a usage error.
    const r = await runCli("run-no-such-record");
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain("invalid run id");
    expect(r.stderr).toContain("refused:");
  });
});
