/**
 * Guard tests for `scripts/vendor-visualizer.ts` (DF4.1 AC0).
 *
 * AC0 gates every other AC and had no executable verification: no package
 * script, no CI job, no test pinned the pin-rejection paths, the same-pin
 * no-op, the different-pin refusal or the unknown-provenance refusal.
 *
 * TWO HARD CONSTRAINTS, both structural to this file:
 *  - NO NETWORK. Every branch asserted below is reached before the clone. The
 *    one case that must cross the clone (`--force-revendor`) points at a
 *    nonexistent local path so git fails immediately, offline.
 *  - NEVER the real `visualizer/`. The script resolves its target from
 *    `import.meta.dir/..`, so each test stages a copy of the script (plus its
 *    only import, `lib/cli-args.ts`) into a temp dir; the subprocess's
 *    "repo root" is that temp dir and its `visualizer/` is a fixture.
 *
 * NOT covered, and not coverable without a network clone: everything after
 * `git clone` succeeds — commit verification, the upstream-layout and
 * LICENSE checks, the copy loop, the generated PROVENANCE body. Those need a
 * real upstream tree; the script offers no seam to inject one.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SCRIPT = path.resolve(import.meta.dir, "../scripts/vendor-visualizer.ts");
const CLI_ARGS = path.resolve(import.meta.dir, "../scripts/lib/cli-args.ts");
const REPO = "https://github.com/disler/super-simple-software-factory";
const SHA = "de31374882e7a4e3e5b7bb9bd09e69dc2f779356";
const OTHER_SHA = "0123456789abcdef0123456789abcdef01234567";

const staged: string[] = [];
afterAll(() => {
  for (const dir of staged) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A throwaway repo root holding a copy of the script under test, so
 * `TARGET_DIR` is the temp tree's `visualizer/` and never this repo's.
 */
function stage(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-visualizer-test-"));
  staged.push(root);
  fs.mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, "scripts", "vendor-visualizer.ts"));
  fs.copyFileSync(CLI_ARGS, path.join(root, "scripts", "lib", "cli-args.ts"));
  return root;
}

/** Write a `visualizer/` fixture with the given PROVENANCE.md body. */
function seedTree(root: string, provenance: string): void {
  fs.mkdirSync(path.join(root, "visualizer"), { recursive: true });
  fs.writeFileSync(path.join(root, "visualizer", "PROVENANCE.md"), provenance);
}

function provenanceFor(repo: string, sha: string): string {
  return `# record\n\nrepo: ${repo}\nsha: ${sha}\nvendored: 2026-01-01T00:00:00.000Z\n`;
}

/** Run the staged script. The ambient VENDOR_VISUALIZER_* env is always cleared. */
function run(
  root: string,
  args: readonly string[],
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bun", [path.join(root, "scripts", "vendor-visualizer.ts"), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      VENDOR_VISUALIZER_REPO: "",
      VENDOR_VISUALIZER_SHA: "",
      ...env,
    },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("pin resolution — rejected before anything is touched", () => {
  test("no repo → exit 1", () => {
    const r = run(stage(), ["--sha", SHA]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no repo");
  });

  test("no sha → exit 1", () => {
    const r = run(stage(), ["--repo", REPO]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no sha");
  });

  test("a short sha is rejected, not zero-padded or resolved", () => {
    const r = run(stage(), ["--repo", REPO, "--sha", "de31374"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not a full 40-hex commit SHA");
  });

  test("a branch or tag name is rejected — the pin is always a full SHA", () => {
    const r = run(stage(), ["--repo", REPO, "--sha", "main"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not a full 40-hex commit SHA");
  });

  test("a 40-char non-hex string is rejected", () => {
    const r = run(stage(), ["--repo", REPO, "--sha", "z".repeat(40)]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not a full 40-hex commit SHA");
  });

  test("env vars supply the pin when flags are absent", () => {
    const root = stage();
    seedTree(root, provenanceFor(REPO, SHA));
    const r = run(root, [], { VENDOR_VISUALIZER_REPO: REPO, VENDOR_VISUALIZER_SHA: SHA });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no-op");
  });

  test("flags win over env vars", () => {
    const root = stage();
    seedTree(root, provenanceFor(REPO, SHA));
    const r = run(root, ["--sha", SHA], {
      VENDOR_VISUALIZER_REPO: REPO,
      VENDOR_VISUALIZER_SHA: OTHER_SHA,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no-op");
  });
});

describe("existing visualizer/ — the refusal matrix", () => {
  test("same pin → exit 0 no-op, and nothing is written", () => {
    const root = stage();
    seedTree(root, provenanceFor(REPO, SHA));
    const before = fs.readFileSync(path.join(root, "visualizer", "PROVENANCE.md"), "utf8");
    const r = run(root, ["--repo", REPO, "--sha", SHA]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no-op");
    expect(fs.readFileSync(path.join(root, "visualizer", "PROVENANCE.md"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(root, "visualizer", "LICENSE.upstream"))).toBe(false);
  });

  test("an upper-case sha input still matches the recorded lower-case pin", () => {
    const root = stage();
    seedTree(root, provenanceFor(REPO, SHA));
    const r = run(root, ["--repo", REPO, "--sha", SHA.toUpperCase()]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no-op");
  });

  // E5: a differently-spelled but identical repo URL must not route the
  // operator into the destructive "delete visualizer/ and re-vendor" branch.
  for (const spelling of [
    `${REPO}.git`,
    `${REPO}/`,
    "git@github.com:disler/super-simple-software-factory.git",
    "ssh://git@github.com/disler/super-simple-software-factory",
    REPO.replace("github.com", "GitHub.com"),
  ]) {
    test(`same pin spelled \`${spelling}\` is still a no-op`, () => {
      const root = stage();
      seedTree(root, provenanceFor(REPO, SHA));
      const r = run(root, ["--repo", spelling, "--sha", SHA]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("no-op");
    });
  }

  test("a genuinely different repo is still refused", () => {
    const root = stage();
    seedTree(root, provenanceFor("https://github.com/someone/else", SHA));
    const r = run(root, ["--repo", REPO, "--sha", SHA]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("vendored from a different pin");
  });

  test("different sha → refusal states the overwrite cost and the recovery", () => {
    const root = stage();
    seedTree(root, provenanceFor(REPO, OTHER_SHA));
    const r = run(root, ["--repo", REPO, "--sha", SHA]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("vendored from a different pin");
    // E1: the operator must not be told to delete the tree without being told
    // what that destroys and how it comes back.
    expect(r.stderr).toContain("does not merge");
    expect(r.stderr).toContain("git history");
  });

  test("unparseable PROVENANCE.md → refusal that points at restore, not delete", () => {
    const root = stage();
    seedTree(root, "# not a provenance record at all\n");
    const r = run(root, ["--repo", REPO, "--sha", SHA]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown provenance");
    expect(r.stderr).toContain("git checkout -- visualizer");
  });

  test("missing PROVENANCE.md entirely → same unknown-provenance refusal", () => {
    const root = stage();
    fs.mkdirSync(path.join(root, "visualizer"), { recursive: true });
    fs.writeFileSync(path.join(root, "visualizer", "index.html"), "<!doctype html>");
    const r = run(root, ["--repo", REPO, "--sha", SHA]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown provenance");
  });
});

describe("deleted-but-git-tracked visualizer/ (E1 guard)", () => {
  /** Stage a repo root where `visualizer/` is committed but absent on disk. */
  function stageDeletedTree(): string {
    const root = stage();
    const git = (...args: string[]) =>
      spawnSync("git", args, {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      });
    git("init", "-q", ".");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    seedTree(root, provenanceFor(REPO, SHA));
    fs.writeFileSync(path.join(root, "visualizer", "hardened.ts"), "// auth gate\n");
    git("add", "-A");
    git("commit", "-qm", "vendored + hardened");
    fs.rmSync(path.join(root, "visualizer"), { recursive: true, force: true });
    return root;
  }

  test("refuses to vendor over a hardened tree that only git still holds", () => {
    const r = run(stageDeletedTree(), ["--repo", REPO, "--sha", SHA]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("git still tracks");
    expect(r.stderr).toContain("git checkout -- visualizer");
  });

  test("--force-revendor gets past the guard (fails later, at the clone)", () => {
    const r = run(stageDeletedTree(), [
      "--repo",
      "/nonexistent/not-a-repo",
      "--sha",
      SHA,
      "--force-revendor",
    ]);
    expect(r.stderr).not.toContain("git still tracks");
    expect(r.status).toBe(2); // fatal: clone failed — no network was involved
    expect(r.stderr).toContain("git clone");
  });

  test("a first-ever vendoring (nothing tracked) is not blocked by the guard", () => {
    const r = run(stage(), ["--repo", "/nonexistent/not-a-repo", "--sha", SHA]);
    expect(r.stderr).not.toContain("git still tracks");
    expect(r.status).toBe(2);
  });
});

test("--help exits 0 and documents the pin inputs", () => {
  const r = run(stage(), ["--help"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("--repo");
  expect(r.stdout).toContain("--sha");
});
