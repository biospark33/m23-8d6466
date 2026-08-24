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
  ReverifyError,
  probeToolchain,
  sandboxRef,
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
