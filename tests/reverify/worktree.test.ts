/**
 * Quarantine worktree tests (Story DF5.1, INV-RV-2).
 *
 * Work happens in a DETACHED worktree off `refs/sandbox/<run-id>`. No branch,
 * tag, remote-tracking ref, index or working tree of the operator repository is
 * read for the verdict or written at any point, and the worktree is pruned on
 * EVERY exit path — including the throwing one.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { rejection } from "../helpers.ts";
import {
  KILL_GRACE_MS,
  ReverifyError,
  probeToolchain,
  sandboxRef,
  withGuards,
  withQuarantineWorktree,
} from "../../src/reverify/worktree.ts";
import { makeHarvestedRepo } from "./fixtures/harvested-repo.ts";

describe("sandboxRef", () => {
  test("is the DF2.5 quarantine ref for the run", () => {
    expect(sandboxRef("run-1")).toBe("refs/sandbox/run-1");
  });
});

describe("withQuarantineWorktree", () => {
  test("checks the harvested tree out detached and prunes it afterwards", async () => {
    const repo = await makeHarvestedRepo();
    try {
      let seen = "";
      const dir = await withQuarantineWorktree(
        { gitCwd: repo.dir, runId: repo.runId, root: repo.worktreeRoot },
        async (wt) => {
          seen = fs.readFileSync(path.join(wt.dir, "src", "sum.ts"), "utf8");
          expect(fs.existsSync(wt.dir)).toBe(true);
          // Detached: the worktree HEAD names no branch.
          const head = fs.readFileSync(path.join(repo.dir, ".git", "worktrees", path.basename(wt.dir), "HEAD"), "utf8");
          expect(head.trim()).toBe(repo.headSha);
          return wt.dir;
        },
      );
      expect(seen).toContain("export function sum");
      expect(fs.existsSync(dir)).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  test("prunes the worktree when the body throws", async () => {
    const repo = await makeHarvestedRepo();
    try {
      let dir = "";
      const err = await rejection(
        withQuarantineWorktree(
          { gitCwd: repo.dir, runId: repo.runId, root: repo.worktreeRoot },
          async (wt) => {
            dir = wt.dir;
            throw new Error("body blew up");
          },
        ),
      );
      expect(err.message).toContain("body blew up");
      expect(dir).not.toBe("");
      expect(fs.existsSync(dir)).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  test("leaves the operator repository's branches and HEAD untouched", async () => {
    const repo = await makeHarvestedRepo();
    try {
      const before = repo.git(["git", "rev-parse", "HEAD"]).trim();
      const branchesBefore = repo.git(["git", "for-each-ref", "--format=%(refname)", "refs/heads"]);
      await withQuarantineWorktree(
        { gitCwd: repo.dir, runId: repo.runId, root: repo.worktreeRoot },
        async () => undefined,
      );
      expect(repo.git(["git", "rev-parse", "HEAD"]).trim()).toBe(before);
      expect(repo.git(["git", "for-each-ref", "--format=%(refname)", "refs/heads"])).toBe(branchesBefore);
    } finally {
      repo.cleanup();
    }
  });

  test("an absent quarantine ref is a typed error and creates no worktree", async () => {
    const repo = await makeHarvestedRepo();
    try {
      const err = await rejection(
        withQuarantineWorktree(
          { gitCwd: repo.dir, runId: "no-such-run", root: repo.worktreeRoot },
          async () => undefined,
        ),
      );
      expect(err).toBeInstanceOf(ReverifyError);
      expect((err as ReverifyError).code).toBe("no-quarantine-ref");
      expect(fs.existsSync(path.join(repo.worktreeRoot, "no-such-run"))).toBe(false);
    } finally {
      repo.cleanup();
    }
  });
});

describe("withGuards", () => {
  // A guard trip only sweeps real OS descendants of THIS process (see
  // descendants() in src/reverify/worktree.ts, rooted at process.pid).
  // Without a live child process, `doomed` is always empty and
  // process.kill is never called whether or not dispose() cancels the
  // timer -- so both cases below spawn a real, long-lived child first.
  //
  // The two guards run sequentially (not concurrently): descendants() is
  // rooted at the shared test process, so two live children present at once
  // would both land in every guard's sweep set, defeating the "this guard's
  // dispose stopped its own sweep" proof.
  test(
    "an undisposed guard's sweep reaches a real descendant (sweep is genuinely armed)",
    async () => {
      const originalKill = process.kill.bind(process);
      const killed: number[] = [];
      process.kill = ((pid: number, _signal?: string | number) => {
        killed.push(pid);
        return true;
      }) as typeof process.kill;

      const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
      const guards = withGuards({ rssBytes: -1 }); // always "over budget" -> trips on the first RSS poll
      try {
        await new Promise((r) => setTimeout(r, 3_000));
        expect(guards.tripped()).not.toBeNull();

        // Never disposed: let the sweep run its natural course. This proves
        // descendants() actually finds the child and fire()'s sweep really
        // arms a SIGKILL against it -- the baseline this test's sibling
        // ("dispose() cancels...") depends on to be non-vacuous.
        await new Promise((r) => setTimeout(r, KILL_GRACE_MS + 1_000));
        expect(killed).toContain(child.pid);
      } finally {
        process.kill = originalKill;
        guards.dispose();
        child.kill();
      }
    },
    { timeout: 15_000 },
  );

  test(
    "dispose() cancels the pending SIGKILL sweep after a guard trip",
    async () => {
      const originalKill = process.kill.bind(process);
      const killed: number[] = [];
      process.kill = ((pid: number, _signal?: string | number) => {
        killed.push(pid);
        return true;
      }) as typeof process.kill;

      const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
      const guards = withGuards({ rssBytes: -1 }); // always "over budget" -> trips on the first RSS poll
      try {
        // Wait for the RSS poll to trip the guard, then for fire()'s async
        // process-table snapshot to resolve and arm the sweep timer against
        // this real child.
        await new Promise((r) => setTimeout(r, 3_000));
        expect(guards.tripped()).not.toBeNull();

        guards.dispose();

        // If dispose() failed to cancel the sweep, the sibling test above
        // proves this exact setup would have put `child.pid` in `killed`
        // by now.
        await new Promise((r) => setTimeout(r, KILL_GRACE_MS + 1_000));
        expect(killed).not.toContain(child.pid);
      } finally {
        process.kill = originalKill;
        guards.dispose();
        child.kill();
      }
    },
    { timeout: 15_000 },
  );
});

describe("probeToolchain", () => {
  test("records a version per probed tool", async () => {
    const tc = await probeToolchain([{ name: "git", argv: ["git", "--version"] }]);
    expect(tc.git).toMatch(/\d+\.\d+/);
  });

  test("a missing tool is a typed error, never a silent pass (INV-RV-5)", async () => {
    const err = await rejection(
      probeToolchain([{ name: "nope", argv: [path.join(os.tmpdir(), "definitely-not-a-binary-xyz")] }]),
    );
    expect(err).toBeInstanceOf(ReverifyError);
    expect((err as ReverifyError).code).toBe("toolchain-missing");
  });
});

describe("withQuarantineWorktree refuses an unusable run id", () => {
  test("a traversing run id is rejected before any path is removed", async () => {
    await expect(
      withQuarantineWorktree({ gitCwd: process.cwd(), runId: "../../etc" }, async () => undefined),
    ).rejects.toThrow(/invalid run id/);
  });
});
