/**
 * A throwaway host repository with a real DF2.5-shaped quarantine ref
 * (Story DF5.1).
 *
 * Deliberately a REAL git repo, not a fake: the story's whole claim is that the
 * verdict rests on fetched git objects and the host toolchain, and a mocked git
 * would let an implementation that never touches those objects pass.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface HarvestedRepo {
  dir: string;
  runId: string;
  baseSha: string;
  headSha: string;
  worktreeRoot: string;
  git(argv: string[], cwd?: string): string;
  cleanup(): void;
}

function run(argv: string[], cwd: string): string {
  const res = spawnSync(argv[0]!, argv.slice(1), {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (res.status !== 0) {
    throw new Error(`${argv.join(" ")} failed in ${cwd}: ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

export interface HarvestedRepoOptions {
  /** Seed a failing test into the harvested commits (the red half of the e2e slice). */
  failing?: boolean;
  /** Replace the tree's own pipeline manifest test command with `true` (AC2). */
  divergentManifest?: boolean;
  /** Emit no test file at all — the `no-tests-executed` boundary. */
  noTests?: boolean;
  runId?: string;
}

/**
 * base commit, then three commits fetched into `refs/sandbox/<run-id>` exactly
 * as DF2.5's harvest leaves them.
 */
export async function makeHarvestedRepo(opts: HarvestedRepoOptions = {}): Promise<HarvestedRepo> {
  const runId = opts.runId ?? "run-1";
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rv-repo-"));
  const git = (argv: string[], cwd = dir): string => run(argv, cwd);

  git(["git", "init", "-q", "-b", "main"]);
  git(["git", "config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# base\n");
  fs.mkdirSync(path.join(dir, ".factory"), { recursive: true });
  git(["git", "add", "-A"]);
  git(["git", "commit", "-q", "-m", "base"]);
  const baseSha = git(["git", "rev-parse", "HEAD"]).trim();

  // Three commits on a work branch — the box's output.
  git(["git", "checkout", "-q", "-b", "work"]);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "sum.ts"), "export function sum(a: number, b: number) {\n  return a + b;\n}\n");
  git(["git", "add", "-A"]);
  git(["git", "commit", "-q", "-m", "feat: sum"]);

  if (!opts.noTests) {
    fs.mkdirSync(path.join(dir, "t"), { recursive: true });
    const expected = opts.failing ? "99" : "3";
    fs.writeFileSync(
      path.join(dir, "t", "sum.test.ts"),
      [
        'import { expect, test } from "bun:test";',
        'import { sum } from "../src/sum.ts";',
        `test("sums", () => { expect(sum(1, 2)).toBe(${expected}); });`,
        "",
      ].join("\n"),
    );
    git(["git", "add", "-A"]);
    git(["git", "commit", "-q", "-m", "test: sum"]);
  }

  // The tree's OWN manifest — never the judge (AC2).
  fs.writeFileSync(
    path.join(dir, "pipeline.json"),
    JSON.stringify(
      {
        version: 1,
        pipelineId: "in-tree",
        runBudgetMs: 60_000,
        phases: [
          {
            name: "tests",
            kind: "code",
            description: "in-tree tests",
            command: opts.divergentManifest ? ["true"] : ["bun", "test", "t/"],
          },
        ],
      },
      null,
      2,
    ),
  );
  git(["git", "add", "-A"]);
  git(["git", "commit", "-q", "-m", "chore: manifest"]);
  const headSha = git(["git", "rev-parse", "HEAD"]).trim();

  // DF2.5's landing spot, then back to a clean operator checkout.
  git(["git", "update-ref", `refs/sandbox/${runId}`, headSha]);
  git(["git", "checkout", "-q", "main"]);
  git(["git", "branch", "-q", "-D", "work"]);

  const worktreeRoot = path.join(dir, ".sandbox", "reverify");
  return {
    dir,
    runId,
    baseSha,
    headSha,
    worktreeRoot,
    git,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
