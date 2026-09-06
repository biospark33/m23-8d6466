/**
 * DF1.10 AC2b — the manifest pair's home inside the checkout.
 *
 * `pipeline.yaml` and `run-context.json` move from beside the checkout to
 * `<checkout>/.qds/`, so that ONE `--run-root` ($HOME/src) satisfies all four
 * consumers at once: `loadManifest`'s beneath-root walk, the ceiling witness
 * read, `loadRoster`'s relative resolution, and every code phase's `cwd`.
 *
 * Moving in is only honest if the run leaves no trace in a repository it does
 * not own, so `fillExeDev` pays two costs and both are tested here:
 *
 *   1. the `/.qds/` line written into the checkout's OWN `.git/info/exclude`,
 *      which keeps setup gate assertion A's `git status --porcelain` EMPTY
 *      rather than teaching the gate to tolerate dirt, and
 *   2. a refusal — never an overwrite — when the repository already tracks
 *      `.qds` at the pinned SHA, because an exclude has no power over a
 *      tracked path.
 *
 * The two AC2b negative controls are the last two tests. Both are written as
 * PASSING assertions about the shape that MUST fail: root-level delivery goes
 * dirty in a repo that tracks its own `pipeline.yaml`, and a run-root of the
 * ssh HOME hands a code phase a cwd where the repository's roster is not.
 *
 * Substrate: the production `ExeDevDriver` with only its command seam doubled
 * (`fakeExeDev`) — every git command below is real git in a real checkout.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExeDevDriver } from "../../../src/providers/exedev/driver.ts";
import { QDS_IN_BOX_DIR } from "../../../src/providers/exedev/fill.ts";
import { ExeDevDriverError } from "../../../src/providers/exedev/transport.ts";
import { fillRun } from "../../../src/providers/driver.ts";
import { fakeExeDev, type FakeCommand, type FakeExeDev } from "./fixtures/fake-exedev.ts";
import { runLocal } from "./helpers.ts";

/** `git commit` needs an identity the host may not have configured. */
const AS_TEST = ["-c", "user.email=test@qds", "-c", "user.name=test"];

/** A local origin repo whose HEAD carries exactly `files`. `file://` ⇒ offline. */
async function makeOrigin(dir: string, files: Record<string, string>): Promise<string> {
  mkdirSync(dir, { recursive: true });
  await runLocal(["git", "init", "-q", "-b", "main", dir]);
  for (const [rel, body] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, body);
  }
  await runLocal(["git", "-C", dir, "add", "-A"]);
  await runLocal(["git", "-C", dir, ...AS_TEST, "commit", "-q", "--allow-empty", "-m", "seed"]);
  return (await runLocal(["git", "-C", dir, "rev-parse", "HEAD"])).trim();
}

/**
 * An origin whose tree carries a `.gitmodules` file AND a `sub/` gitlink
 * (mode 160000) — a repository that declares a submodule without this factory
 * ever initializing it. Built with `update-index --cacheinfo` because a plain
 * file writer cannot express a gitlink.
 */
async function makeSubmoduleOrigin(dir: string): Promise<string> {
  const inner = join(dir, "..", "submodule-inner");
  mkdirSync(inner, { recursive: true });
  await runLocal(["git", "init", "-q", "-b", "main", inner]);
  writeFileSync(join(inner, "leaf.txt"), "inner\n");
  await runLocal(["git", "-C", inner, "add", "-A"]);
  await runLocal(["git", "-C", inner, ...AS_TEST, "commit", "-q", "--allow-empty", "-m", "inner"]);
  const innerSha = (await runLocal(["git", "-C", inner, "rev-parse", "HEAD"])).trim();

  mkdirSync(dir, { recursive: true });
  await runLocal(["git", "init", "-q", "-b", "main", dir]);
  writeFileSync(join(dir, ".gitmodules"), `[submodule "sub"]\n\tpath = sub\n\turl = ${inner}\n`);
  await runLocal(["git", "-C", dir, "add", "-A"]);
  await runLocal(["git", "-C", dir, "update-index", "--add", "--cacheinfo", "160000", innerSha, "sub"]);
  await runLocal(["git", "-C", dir, ...AS_TEST, "commit", "-q", "--allow-empty", "-m", "seed"]);
  return (await runLocal(["git", "-C", dir, "rev-parse", "HEAD"])).trim();
}

/**
 * run-context.json bytes built the way DISPATCH builds them (round 5, FX-K
 * item 4): the same field list, in the same order, through the same COMPACT
 * `JSON.stringify` — see src/fleet/dispatch.ts's `files` construction. The
 * OWN-verdict probe greps for `"runId": "<id>"`, and dispatch is the only
 * producer of that file; planting a hand-abbreviated copy let the two halves
 * drift silently (a pretty-print or field rename on dispatch's side would
 * flip every crash-retry's OWN verdict to EXISTS and demand manual `rm`
 * surgery again). The source-pin beside this helper's use site ties the
 * producing spelling to the consuming probe.
 */
function dispatchShapedRunContext(vm: string): string {
  return JSON.stringify({
    runId: vm,
    pipelineId: "pipe-1",
    requestId: "req-1",
    effectiveCeilingMicroUsd: 50_000_000,
    budgetMs: 3_600_000,
    repoSlug: "qds/demo",
    issueId: "42",
    issueUrl: "https://example.invalid/issues/42",
  });
}

describe("fillExeDev — AC2b: the manifest pair lives inside the checkout", () => {
  let fake: FakeExeDev;
  let tempDir: string;
  /** A repo with nothing of its own at `.qds` — the ordinary customer repo. */
  let plainOrigin: string;
  let plainSha: string;
  /** A repo that TRACKS its own `.qds/config.yaml` at HEAD. */
  let qdsOrigin: string;
  let qdsSha: string;
  /** A repo that tracks a plain FILE named `.qds` at HEAD. */
  let fileQdsOrigin: string;
  let fileQdsSha: string;
  /** A repo that tracks its own root `pipeline.yaml` AND a `roster.yaml`. */
  let collidingOrigin: string;
  let collidingSha: string;
  /** A repo whose `.qds` is NESTED (`sub/.qds/keep`) — must NOT be refused. */
  let nestedOrigin: string;
  let nestedSha: string;
  /** A repo carrying `.gitmodules` + a `sub/` gitlink — the submodule contract. */
  let submodOrigin: string;
  let submodSha: string;

  beforeAll(async () => {
    // Real git through the seam on every test — a handful of process spawns
    // apiece. bun's 5 s default is a load artefact waiting to happen on a busy
    // machine, so each test below carries an explicit budget (driver.test.ts's
    // fill suite sets the same precedent and for the same reason).
    fake = fakeExeDev();
    tempDir = mkdtempSync(join(tmpdir(), "qds-fill-qds-"));
    plainOrigin = join(tempDir, "plain");
    plainSha = await makeOrigin(plainOrigin, { "README.md": "plain\n" });
    qdsOrigin = join(tempDir, "tracks-qds");
    qdsSha = await makeOrigin(qdsOrigin, { ".qds/config.yaml": "theirs: true\n" });
    fileQdsOrigin = join(tempDir, "tracks-qds-file");
    fileQdsSha = await makeOrigin(fileQdsOrigin, { ".qds": "theirs: true\n" });
    collidingOrigin = join(tempDir, "tracks-pipeline");
    collidingSha = await makeOrigin(collidingOrigin, {
      "pipeline.yaml": "theirs: true\n",
      "roster.yaml": "agents: []\n",
    });
    nestedOrigin = join(tempDir, "nested-qds");
    nestedSha = await makeOrigin(nestedOrigin, { "sub/.qds/keep": "nested\n" });
    submodOrigin = join(tempDir, "submodule");
    submodSha = await makeSubmoduleOrigin(submodOrigin);
  }, 120_000);

  afterAll(() => {
    // `fake.cleanup()` throwing must not strand four git repos and every box
    // directory under $TMPDIR for the rest of the machine's life.
    try {
      fake.cleanup();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 120_000);

  /**
   * The `.qds` steps are TRANSPORT-INDEPENDENT, so the tests below run under
   * `remote-clone`, which skips the host scratch clone + bundle + base64 push —
   * most of this suite's wall clock and none of what it asserts.
   *
   * The DEFAULT transport still needs its own coverage, and it used to get it
   * implicitly: six tests carried a comment saying "test 1 above already proves
   * them under the DEFAULT bundle-push", so skipping, renaming or deleting that
   * one test would have taken the default arm's only coverage with it while
   * every remaining test stayed green. The table below makes the default an
   * EXPLICIT entry instead of a load-bearing comment.
   */
  const FAST_MODE = { mode: "remote-clone" as const };

  test.each([["bundle-push" as const], ["remote-clone" as const]])(
    "the checkout's own .git/info/exclude carries the anchored /.qds/ line after fill (%s)",
    async (mode) => {
      const vm = `fill-qds-1-${mode}`;
      const driver = new ExeDevDriver({ run: fake.run });
      await driver.create(vm);
      await driver.fill(vm, {
        runId: vm,
        repoUrl: `file://${plainOrigin}`,
        commitSha: plainSha,
        workdir: "work",
        mode,
      });
      const exclude = readFileSync(join(fake.boxDir(vm), "work", ".git", "info", "exclude"), "utf8");
      // ANCHORED and directory-only: `/.qds/` excludes the checkout ROOT's
      // directory, not a nested `.qds` a subproject carries, and not a FILE of
      // that name (which is the refusal's business, never an exclusion's).
      expect(exclude.split("\n")).toContain(`/${QDS_IN_BOX_DIR}/`);
    },
    120_000,
  );

  test("the exclude line's --show-prefix anchor is source-pinned — every behavioral test sees only the repo-root case", () => {
    // `fillExeDev` always clones/fetches INTO `work`, so `work` is by
    // construction a git repository ROOT and `git rev-parse --show-prefix`
    // (run from `work`) is always "" — which is why the test above asserts the
    // literal `/.qds/` line and no behavioral test can reach the
    // SUBDIRECTORY-workdir branch the anchor exists for (an embedder's
    // `workdir` override pointing at a worktree or a repo subdirectory; a bare
    // `/.qds/` there names a root-level `.qds` nothing writes, the rule never
    // matches, and assertion A goes dirty). The construction is therefore
    // pinned against the source: replacing the script's `--show-prefix`
    // interpolation with a constant `/.qds/` keeps every behavioral test in
    // this file green — this is the line that goes red instead.
    // (Source-pin idiom as in tests/providers/fake-driver.test.ts.)
    const fillSrc = readFileSync(new URL("../../../src/providers/exedev/fill.ts", import.meta.url), "utf8");
    expect(fillSrc).toContain("pre=$(git rev-parse --show-prefix)");
    expect(fillSrc).toContain('line="/$pre${QDS_IN_BOX_DIR}/"');
  });

  test("the manifest pair delivered under .qds/ leaves `git status --porcelain` EMPTY — assertion A stays strict", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("fill-qds-2");
    await driver.fill("fill-qds-2", {
      runId: "fill-qds-2",
      repoUrl: `file://${plainOrigin}`,
      commitSha: plainSha,
      workdir: "work",
      ...FAST_MODE, // see FAST_MODE — the default arm is a table entry above
    });
    // The REAL delivery primitive dispatch uses, at the shape dispatch now
    // hands it: a path INSIDE the checkout, under `.qds/`.
    await fillRun(driver, "fill-qds-2", [
      { path: `work/${QDS_IN_BOX_DIR}/pipeline.yaml`, content: '{"limitMicroUsd":1,"phases":[]}\n' },
      { path: `work/${QDS_IN_BOX_DIR}/run-context.json`, content: '{"runId":"fill-qds-2"}\n' },
    ]);
    const work = join(fake.boxDir("fill-qds-2"), "work");
    expect(existsSync(join(work, QDS_IN_BOX_DIR, "pipeline.yaml"))).toBe(true);
    expect(existsSync(join(work, QDS_IN_BOX_DIR, "run-context.json"))).toBe(true);
    // Round 5 (FX-K item 12): both delivered files land 0600 — FILL_PY's
    // O_EXCL create mode (driver.ts:1037), pinned so a drift to a
    // umask-dependent default cannot slip in unremarked. The manifest pair is
    // run-scoped content (it names the cap and the issue); 0644-and-up would
    // put it in every co-tenant's read scope.
    expect(statSync(join(work, QDS_IN_BOX_DIR, "pipeline.yaml")).mode & 0o777).toBe(0o600);
    expect(statSync(join(work, QDS_IN_BOX_DIR, "run-context.json")).mode & 0o777).toBe(0o600);
    // The whole point: the files are THERE and the tree is still clean. No
    // tolerance was added anywhere — git simply has nothing to report.
    const porcelain = await driver.exec("fill-qds-2", ["git", "-C", "work", "status", "--porcelain"]);
    expect(porcelain.exitCode).toBe(0);
    expect(porcelain.stdout.trim()).toBe("");
  }, 120_000);

  test("the exclude write is idempotent — a re-fill appends nothing", async () => {
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("fill-qds-3");
    const opts = {
      runId: "fill-qds-3",
      repoUrl: `file://${plainOrigin}`,
      commitSha: plainSha,
      workdir: "work",
      ...FAST_MODE, // see FAST_MODE — the default arm is a table entry above
    };
    await driver.fill("fill-qds-3", opts);
    await driver.fill("fill-qds-3", opts);
    const exclude = readFileSync(join(fake.boxDir("fill-qds-3"), "work", ".git", "info", "exclude"), "utf8");
    const hits = exclude.split("\n").filter((l) => l === `/${QDS_IN_BOX_DIR}/`);
    expect(hits).toHaveLength(1);
  }, 120_000);

  // Both transports: the `.qds` steps are transport-independent, but "refused
  // BEFORE the sandbox branch exists / BEFORE the exclude line is written" is
  // an ORDERING claim about fill's own step sequence, and only this test pins
  // it. Running it under the default bundle-push arm too means a reordering
  // that only shows on the default path (probe after branch creation, exclude
  // written before the refusal) goes red here instead of hiding behind the
  // FAST_MODE every other refusal test uses.
  test.each([["bundle-push" as const], ["remote-clone" as const]])(
    "a repository that TRACKS .qds at the pinned SHA is refused, not overwritten — and refused before the sandbox branch exists (%s)",
    async (mode) => {
      // An exclude line cannot hide a tracked path, so delivering into this repo
      // would both clobber the customer's file and hard-fail assertion A. The
      // refusal lands at the pinned SHA, before any run-owned state is created.
      const driver = new ExeDevDriver({ run: fake.run });
      await driver.create(`fill-qds-4-${mode}`);
      let err: unknown;
      try {
        await driver.fill(`fill-qds-4-${mode}`, {
          runId: `fill-qds-4-${mode}`,
          repoUrl: `file://${qdsOrigin}`,
          commitSha: qdsSha,
          workdir: "work",
          mode,
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ExeDevDriverError);
      expect((err as ExeDevDriverError).code).toBe("qds-dir-tracked");
      // The message names the offending path, and the remediation names the fix.
      expect(String((err as Error).message)).toContain(`${QDS_IN_BOX_DIR}/config.yaml`);
      expect((err as ExeDevDriverError).remediation).toContain("re-dispatch");
      // Not overwritten: the customer's file is byte-identical.
      const work = join(fake.boxDir(`fill-qds-4-${mode}`), "work");
      expect(readFileSync(join(work, QDS_IN_BOX_DIR, "config.yaml"), "utf8")).toBe("theirs: true\n");
      // And nothing run-owned was created: no sandbox branch, no exclude line.
      const branch = await driver.exec(`fill-qds-4-${mode}`, [
        "git",
        "-C",
        "work",
        "rev-parse",
        "--verify",
        "--quiet",
        `sbx/fill-qds-4-${mode}`,
      ]);
      expect(branch.exitCode).not.toBe(0);
      const exclude = readFileSync(join(work, ".git", "info", "exclude"), "utf8");
      expect(exclude.split("\n")).not.toContain(`/${QDS_IN_BOX_DIR}/`);
    },
    120_000,
  );

  test("a repository that tracks a plain FILE named .qds is refused as tracked — the probe's ls-files arm covers non-directories", async () => {
    // Test 1's comment assigns "a FILE of that name" to the refusal's
    // business; this is that shape on the TRACKED side. `git ls-files` names
    // it before the `-e || -L` presence arm ever looks, so the refusal is the
    // tracked one at the pinned SHA. The hole it closes: a probe rewritten to
    // `[ -d .qds ]` would wave this repo through to a delivery-time failure
    // with a different code (`fill-failed`, not `qds-dir-tracked`) and no
    // other test in this file would move.
    const vm = "fill-qds-13";
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create(vm);
    let err: unknown;
    try {
      await driver.fill(vm, {
        runId: vm,
        repoUrl: `file://${fileQdsOrigin}`,
        commitSha: fileQdsSha,
        workdir: "work",
        ...FAST_MODE, // see FAST_MODE — the default arm is a table entry above
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExeDevDriverError);
    expect((err as ExeDevDriverError).code).toBe("qds-dir-tracked");
    // The message names the offending path — here the bare `.qds` file itself.
    expect(String((err as Error).message)).toContain(QDS_IN_BOX_DIR);
    // And the customer's file is byte-identical: refused, never overwritten.
    const work = join(fake.boxDir(vm), "work");
    expect(readFileSync(join(work, QDS_IN_BOX_DIR), "utf8")).toBe("theirs: true\n");
  }, 120_000);

  test("a NESTED .qds (sub/.qds/keep) is not the run's path and does not refuse the fill", async () => {
    // The probe is root-anchored exactly like the exclude line. A repo whose
    // subproject carries a `.qds` is an ordinary repo, and refusing it would
    // be a false positive that no operator could act on.
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("fill-qds-5");
    await driver.fill("fill-qds-5", {
      runId: "fill-qds-5",
      repoUrl: `file://${nestedOrigin}`,
      commitSha: nestedSha,
      workdir: "work",
      ...FAST_MODE, // see FAST_MODE — the default arm is a table entry above
    });
    const branch = await driver.exec("fill-qds-5", ["git", "-C", "work", "rev-parse", "--abbrev-ref", "HEAD"]);
    expect(branch.stdout.trim()).toBe("sbx/fill-qds-5");
    await fillRun(driver, "fill-qds-5", [
      { path: `work/${QDS_IN_BOX_DIR}/pipeline.yaml`, content: "{}\n" },
    ]);
    const porcelain = await driver.exec("fill-qds-5", ["git", "-C", "work", "status", "--porcelain"]);
    expect(porcelain.stdout.trim()).toBe("");
  }, 120_000);

  test("AC2b negative control: ROOT-LEVEL delivery into a repo that tracks its own pipeline.yaml MUST fail — and the exclude line cannot rescue it", async () => {
    // The placement AC2b replaces, run against the repo that catches it. Two
    // independent things refuse it, and the test asserts BOTH rather than
    // picking the one the AC happened to name.
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("fill-qds-6");
    await driver.fill("fill-qds-6", {
      runId: "fill-qds-6",
      repoUrl: `file://${collidingOrigin}`,
      commitSha: collidingSha,
      workdir: "work",
      ...FAST_MODE, // see FAST_MODE — the default arm is a table entry above
    });
    // The exclude line IS present. It is powerless over this repo's tracked
    // `pipeline.yaml`, which is the whole reason root-level delivery is out.
    const work = join(fake.boxDir("fill-qds-6"), "work");
    expect(readFileSync(join(work, ".git", "info", "exclude"), "utf8").split("\n")).toContain(`/${QDS_IN_BOX_DIR}/`);

    // (1) `fillRun` itself refuses: FILL_PY creates with O_EXCL, so the run's
    // manifest never lands on top of a file the customer already has. This is
    // the FIRST thing that fails, and it fails the whole dispatch (exit 1,
    // box alive) rather than quietly clobbering someone's repository.
    let err: unknown;
    try {
      await fillRun(driver, "fill-qds-6", [
        { path: "work/pipeline.yaml", content: '{"limitMicroUsd":1,"phases":[]}\n' },
      ]);
    } catch (e) {
      err = e;
    }
    // The CONTRACT being proven is FILL_PY's `O_EXCL` refusal, so the assertion
    // names it. Matching only the path let a transport failure, a permission
    // error or a missing python3 satisfy this test identically — every one of
    // which names the path too, and none of which proves the customer's file
    // was protected by the thing that is supposed to protect it.
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error | undefined)?.message)).toContain("work/pipeline.yaml");
    expect(String((err as Error | undefined)?.message)).toContain("collides with an existing entry");
    expect(String((err as Error | undefined)?.message)).toContain("[Errno 17] File exists");
    // Nothing was touched: the customer's file is byte-identical, tree clean.
    expect(readFileSync(join(work, "pipeline.yaml"), "utf8")).toBe("theirs: true\n");
    expect((await driver.exec("fill-qds-6", ["git", "-C", "work", "status", "--porcelain"])).stdout.trim()).toBe("");

    // (2) And had the delivery landed anyway — a writer without that guard —
    // assertion A would hard-fail, because `.git/info/exclude` is consulted
    // only for UNTRACKED paths. Written straight through the shell to model
    // exactly that writer.
    await driver.exec("fill-qds-6", ["sh", "-c", "printf '%s\\n' 'ours: true' > work/pipeline.yaml"]);
    const dirty = await driver.exec("fill-qds-6", ["git", "-C", "work", "status", "--porcelain"]);
    expect(dirty.stdout.trim()).not.toBe("");
    expect(dirty.stdout).toContain("pipeline.yaml");

    // THE SHIPPING SHAPE, same repo, same box: delivered, and clean.
    await runLocal(["git", "-C", work, "checkout", "--", "pipeline.yaml"]);
    await fillRun(driver, "fill-qds-6", [
      { path: `work/${QDS_IN_BOX_DIR}/pipeline.yaml`, content: '{"limitMicroUsd":1,"phases":[]}\n' },
    ]);
    const clean = await driver.exec("fill-qds-6", ["git", "-C", "work", "status", "--porcelain"]);
    expect(clean.stdout.trim()).toBe("");
  }, 120_000);

  test("AC2b negative control: a run-root of the ssh HOME reaches the manifest but not the roster — only the checkout satisfies all four consumers", async () => {
    // `--run-root $HOME` is the placement's failure mode stated as a path fact:
    // the manifest and the ceiling witness are found (they are beneath it), and
    // then every code phase gets `cwd=$HOME`, where the repository's own
    // `roster.yaml` — a RELATIVE resolution against the run root — is not.
    // The engine-side flag assertion belongs to the engine's suite; what this
    // box can prove is the layout the flag would be pointed at.
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create("fill-qds-7");
    await driver.fill("fill-qds-7", {
      runId: "fill-qds-7",
      repoUrl: `file://${collidingOrigin}`,
      commitSha: collidingSha,
      workdir: "work",
      ...FAST_MODE, // see FAST_MODE — the default arm is a table entry above
    });
    await fillRun(driver, "fill-qds-7", [
      { path: `work/${QDS_IN_BOX_DIR}/pipeline.yaml`, content: '{"limitMicroUsd":1,"phases":[]}\n' },
      { path: `work/${QDS_IN_BOX_DIR}/run-context.json`, content: '{"runId":"fill-qds-7"}\n' },
    ]);
    // `fakeExeDev` runs box commands with cwd = the box dir, which is the
    // substrate's stand-in for the ssh HOME `fillRun` resolves against.
    const home = fake.boxDir("fill-qds-7");
    const checkout = join(home, "work");

    // Run-root = HOME: the manifest and the witness ARE reachable beneath it…
    expect(existsSync(join(home, "work", QDS_IN_BOX_DIR, "pipeline.yaml"))).toBe(true);
    // …and the roster is NOT there, so a code phase handed `cwd=$HOME`
    // resolves `roster.yaml` to nothing. That is the whole negative control.
    expect(existsSync(join(home, "roster.yaml"))).toBe(false);

    // Run-root = the checkout: all four agree. Manifest and witness beneath it,
    // roster resolvable relative to it, and it is a directory a code phase can
    // actually be run in.
    expect(existsSync(join(checkout, QDS_IN_BOX_DIR, "pipeline.yaml"))).toBe(true);
    expect(existsSync(join(checkout, QDS_IN_BOX_DIR, "run-context.json"))).toBe(true);
    expect(existsSync(join(checkout, "roster.yaml"))).toBe(true);
    // CODE-DERIVED, not fixture-echoing (DF1.10 round 3, C2-10): sweep the
    // WHOLE box for the pair's two names and assert the run's copies exist
    // ONLY under `<work>/<QDS_IN_BOX_DIR>/`. A `fillRun` that also wrote
    // beside the checkout (the pre-AC2b placement), or left a stray second
    // copy anywhere in the box, fails here — sorted in JS, not by the box's
    // `sort`, so the order is code-unit-deterministic on every platform. The
    // third hit is the customer's TRACKED root `pipeline.yaml` (collidingOrigin
    // carries one), which the run never touches; `roster.yaml` is not one of
    // the swept names. The PRODUCING side — the agent that chooses these
    // paths — is pinned at the dispatch level by tests/fleet/dispatch.test.ts
    // ("AC2b: the manifest pair is delivered INSIDE the checkout under
    // `.qds/`…"), which drives the real dispatch() and runs the same sweep;
    // this file proves the substrate half: what fillRun does with the paths it
    // is handed.
    const sweep = await driver.exec("fill-qds-7", [
      "sh",
      "-c",
      "find . \\( -name pipeline.yaml -o -name run-context.json \\)",
    ]);
    expect(sweep.stdout.trim().split("\n").sort()).toEqual([
      `./work/${QDS_IN_BOX_DIR}/pipeline.yaml`,
      `./work/${QDS_IN_BOX_DIR}/run-context.json`,
      "./work/pipeline.yaml",
    ]);
  }, 120_000);

  test("an EXISTING sandbox branch whose tip tracks .qds is refused — the pinned tree is not the tree the run works against", async () => {
    // The ordering hole. The refusal used to run ONCE, at the pinned SHA, and
    // the very next step is create-or-SWITCH: switching to an already-existing
    // `sbx/<runId>` moves the tree to that branch's TIP, a different commit. A
    // prior run that committed `.qds/` (or a customer branch that carries it)
    // therefore passed a check against a tree nobody would work in, and fill
    // then wrote `pipeline.yaml`/`run-context.json` over TRACKED files — the
    // exact overwrite AC2b says it refuses — taking assertion A's honestly-empty
    // porcelain with it.
    const vm = "fill-qds-8";
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create(vm);
    const opts = {
      runId: vm,
      repoUrl: `file://${plainOrigin}`,
      commitSha: plainSha,
      workdir: "work",
      ...FAST_MODE,
    };
    // First fill: an ordinary repo with no `.qds` at the pin. Creates `sbx/<vm>`.
    await driver.fill(vm, opts);
    // The run commits its own `.qds/` onto the sandbox branch — a run that
    // committed its work, which is exactly what the sandbox branch is FOR.
    await driver.exec(vm, [
      "sh",
      "-c",
      `mkdir -p work/${QDS_IN_BOX_DIR} && printf 'ours: true\\n' > work/${QDS_IN_BOX_DIR}/pipeline.yaml` +
        ` && git -C work add -f ${QDS_IN_BOX_DIR} && git -C work -c user.email=r@box -c user.name=r commit -q -m committed`,
    ]);
    // The PINNED tree still has no `.qds` — that is the whole point.
    const atPin = await driver.exec(vm, ["git", "-C", "work", "ls-tree", "--name-only", plainSha]);
    expect(atPin.stdout).not.toContain(QDS_IN_BOX_DIR);

    let err: unknown;
    try {
      await driver.fill(vm, opts); // re-fill: fetch → checkout pin → switch to the tip
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(ExeDevDriverError);
    expect((err as ExeDevDriverError).code).toBe("qds-dir-tracked");
    expect(String((err as Error).message)).toContain(`${QDS_IN_BOX_DIR}/pipeline.yaml`);
    // And it refused rather than overwrote: the committed file is untouched and
    // the tree is clean.
    const work = join(fake.boxDir(vm), "work");
    expect(readFileSync(join(work, QDS_IN_BOX_DIR, "pipeline.yaml"), "utf8")).toBe("ours: true\n");
    expect((await driver.exec(vm, ["git", "-C", "work", "status", "--porcelain"])).stdout.trim()).toBe("");
  }, 120_000);

  test("an UNTRACKED .qds already in the checkout is refused too — the run's manifest root never shares a directory", async () => {
    // `git ls-files` cannot see an untracked path, so the tracked probe alone
    // let dispatch write the run's manifest root into a directory holding
    // foreign or stale content — which `loadManifest`'s beneath-root walk and
    // `readArtifactBeneathRoot` then have in scope. Two ways to get here: a
    // customer build dir their `.gitignore` hides under this name, or a `.qds/`
    // a previous fill on this same box already populated.
    const vm = "fill-qds-9";
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create(vm);
    const opts = {
      runId: vm,
      repoUrl: `file://${plainOrigin}`,
      commitSha: plainSha,
      workdir: "work",
      ...FAST_MODE,
    };
    await driver.fill(vm, opts);
    // A stale prior-run manifest root, untracked and invisible to `ls-files`.
    await driver.exec(vm, [
      "sh",
      "-c",
      `mkdir -p work/${QDS_IN_BOX_DIR} && printf 'stale\\n' > work/${QDS_IN_BOX_DIR}/run-context.json`,
    ]);

    let err: unknown;
    try {
      await driver.fill(vm, opts);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(ExeDevDriverError);
    expect((err as ExeDevDriverError).code).toBe("qds-dir-present");
    // Refused, never cleared: deleting a directory in someone else's checkout is
    // the class of act this whole refusal exists to avoid.
    expect(readFileSync(join(fake.boxDir(vm), "work", QDS_IN_BOX_DIR, "run-context.json"), "utf8")).toBe("stale\n");
  }, 120_000);

  test("an UNTRACKED plain FILE named .qds is refused as present — the -e arm covers non-directories", async () => {
    // The untracked twin of fill-qds-13, and the other half of test 1's "a
    // FILE of that name is the refusal's business" comment. `git ls-files`
    // cannot see it, so the `-e` presence arm must: a probe narrowed to
    // `[ -d .qds ]` would let the file through to a delivery-time
    // NotADirectory failure with a different code, and the refusal's own
    // promise — refused, never cleared — would go unpinned for this shape.
    const vm = "fill-qds-14";
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create(vm);
    const opts = {
      runId: vm,
      repoUrl: `file://${plainOrigin}`,
      commitSha: plainSha,
      workdir: "work",
      ...FAST_MODE,
    };
    await driver.fill(vm, opts);
    // A plain FILE at the run's own path — not a directory, untracked.
    await driver.exec(vm, ["sh", "-c", `printf 'stale\\n' > work/${QDS_IN_BOX_DIR}`]);

    let err: unknown;
    try {
      await driver.fill(vm, opts);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(ExeDevDriverError);
    expect((err as ExeDevDriverError).code).toBe("qds-dir-present");
    // Refused, never cleared: the customer's file is byte-identical.
    expect(readFileSync(join(fake.boxDir(vm), "work", QDS_IN_BOX_DIR), "utf8")).toBe("stale\n");
  }, 120_000);

  test("an exclude write that CANNOT succeed is a named fill-failed naming the step — not best-effort dirt for assertion A", async () => {
    // fill.ts's own docstring: the exclude write is NOT best-effort, because
    // an unwritable exclude file's next appearance is "assertion A: porcelain
    // is dirty" — an operator hunting a truncated clone. A tempting "cleanup
    // must not mask the fill" edit that made the `{ … }` group best-effort
    // would resurface exactly there with no unit test red; this is the red
    // line. `exclude` replaced by a DIRECTORY makes both the grep and the
    // append fail (proven on this substrate: exit 1, "Is a directory"), and
    // the step's own label names the fault in the message.
    const vm = "fill-qds-15";
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create(vm);
    const opts = {
      runId: vm,
      repoUrl: `file://${plainOrigin}`,
      commitSha: plainSha,
      workdir: "work",
      ...FAST_MODE,
    };
    await driver.fill(vm, opts);
    const excludePath = join(fake.boxDir(vm), "work", ".git", "info", "exclude");
    rmSync(excludePath);
    mkdirSync(excludePath); // the seam can no longer be written at all

    let err: unknown;
    try {
      await driver.fill(vm, opts);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(ExeDevDriverError);
    expect((err as ExeDevDriverError).code).toBe("fill-failed");
    // The step's label ("exclude") is in the message — that is what routes an
    // operator to the exclude seam rather than to the clone.
    expect(String((err as Error).message)).toContain("exclude");
  }, 120_000);

  test("an untracked .qds whose run-context.json names THIS run is the factory's own stale pair — the re-fill proceeds", async () => {
    // Round 4 (P51/D7): a crash-retry of dispatch, or a re-dispatch of an open
    // run to its surviving box, re-runs fill against the `.qds/` the FIRST
    // delivery left behind. That pair is recognizable as this factory's own —
    // its run-context.json names the runId — and refusing it as "foreign" (the
    // old EXISTS verdict did, unconditionally) forced manual `rm` surgery on
    // the box for files the factory itself wrote. OWN clears the verdict;
    // the re-fill switch path proceeds and fillRun's later delivery is what
    // overwrites the pair.
    const vm = "fill-qds-12";
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create(vm);
    const opts = {
      runId: vm,
      repoUrl: `file://${plainOrigin}`,
      commitSha: plainSha,
      workdir: "work",
      ...FAST_MODE,
    };
    await driver.fill(vm, opts);
    // The first delivery's pair, as dispatch's fillRun writes it: untracked,
    // and naming THIS run. Round 5 (FX-K item 4): the planted bytes are now
    // built by `dispatchShapedRunContext` — dispatch's own field list and
    // COMPACT JSON.stringify — instead of a hand-abbreviated two-field copy,
    // and the producing spelling is source-pinned so a pretty-print or field
    // rename on dispatch's side reds HERE, not only in the fleet suite.
    const dispatchSrc = readFileSync(new URL("../../../src/fleet/dispatch.ts", import.meta.url), "utf8");
    expect(dispatchSrc).toMatch(/JSON\.stringify\(\{\s*runId,\s*pipelineId:/);
    mkdirSync(join(fake.boxDir(vm), "work", QDS_IN_BOX_DIR), { recursive: true });
    writeFileSync(
      join(fake.boxDir(vm), "work", QDS_IN_BOX_DIR, "run-context.json"),
      dispatchShapedRunContext(vm),
    );
    // Compact serialization is half the coupling: the probe's grep tolerates
    // whitespace, but the producer has never emitted any — if the mirror and
    // the producer ever disagree on the serializer, this line is what says so.
    expect(dispatchShapedRunContext(vm)).toContain(`"runId":"${vm}"`);

    // OWN: no refusal.
    await driver.fill(vm, opts);

    // Fill cleared the verdict without touching the pair's content — fillRun
    // (dispatch) is the half that overwrites it afterwards…
    expect(readFileSync(join(fake.boxDir(vm), "work", QDS_IN_BOX_DIR, "run-context.json"), "utf8")).toContain(
      `"runId":"${vm}"`,
    );
    // …and the exclude line did not double up on the second fill.
    const exclude = readFileSync(join(fake.boxDir(vm), "work", ".git", "info", "exclude"), "utf8");
    expect(exclude.split(`/${QDS_IN_BOX_DIR}/`).length - 1).toBe(1);

    // FOREIGN: the same shape naming a DIFFERENT run keeps the refusal — the
    // probe anchors on the runId VALUE, not the field's mere presence.
    await driver.exec(vm, [
      "sh",
      "-c",
      `printf '%s' '{"runId":"some-other-run"}' > work/${QDS_IN_BOX_DIR}/run-context.json`,
    ]);
    let err: unknown;
    try {
      await driver.fill(vm, opts);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExeDevDriverError);
    expect((err as ExeDevDriverError).code).toBe("qds-dir-present");
  }, 120_000);

  test("a DANGLING symlink named .qds is refused as present — the -L arm covers what -e cannot see (round 5)", async () => {
    // The probe is `[ -e .qds ] || [ -L .qds ]`: `-e` FOLLOWS links, so a link
    // whose target does not exist reads as absent and the delivery would then
    // fail against it wearing a different code. The second arm is what catches
    // the shape, and the verdict is EXISTS (run-context.json cannot be read
    // through a dangling `.qds`), never OWN — absent evidence it is ours, it
    // is foreign.
    const vm = "fill-qds-16";
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create(vm);
    const opts = {
      runId: vm,
      repoUrl: `file://${plainOrigin}`,
      commitSha: plainSha,
      workdir: "work",
      ...FAST_MODE, // see FAST_MODE — the default arm is a table entry above
    };
    await driver.fill(vm, opts);
    await driver.exec(vm, ["ln", "-s", "/nonexistent", `work/${QDS_IN_BOX_DIR}`]);

    let err: unknown;
    try {
      await driver.fill(vm, opts);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExeDevDriverError);
    expect((err as ExeDevDriverError).code).toBe("qds-dir-present");
    // Refused, never cleared: the dangling link itself is untouched (lstat,
    // not stat — stat follows links and a dangling one throws).
    const st = lstatSync(join(fake.boxDir(vm), "work", QDS_IN_BOX_DIR));
    expect(st.isSymbolicLink()).toBe(true);
  }, 120_000);

  test("an UNREADABLE run-context under .qds stays EXISTS — fail-closed, never OWN (round 5)", async () => {
    // The OWN verdict requires POSITIVE evidence: a readable run-context.json
    // naming THIS run. A context that cannot be read at all — here, a
    // DIRECTORY where the grep expects a file — fails the grep (stderr
    // swallowed by 2>/dev/null) and lands in EXISTS, exactly the docstring's
    // "a .qds whose context is unreadable ... stays HERE, not in OWN". A
    // chmod-000 file is the same arm but root-flaky; a directory cannot be
    // read as a file by anyone.
    const vm = "fill-qds-17";
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create(vm);
    const opts = {
      runId: vm,
      repoUrl: `file://${plainOrigin}`,
      commitSha: plainSha,
      workdir: "work",
      ...FAST_MODE, // see FAST_MODE — the default arm is a table entry above
    };
    await driver.fill(vm, opts);
    await driver.exec(vm, ["mkdir", "-p", `work/${QDS_IN_BOX_DIR}/run-context.json`]);

    let err: unknown;
    try {
      await driver.fill(vm, opts);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExeDevDriverError);
    expect((err as ExeDevDriverError).code).toBe("qds-dir-present");
    // Refused, never cleared: the customer's directory is untouched.
    expect(statSync(join(fake.boxDir(vm), "work", QDS_IN_BOX_DIR, "run-context.json")).isDirectory()).toBe(true);
  }, 120_000);

  test("repoUrl hostile rows are refused with repo-url-invalid BEFORE any box work — and file:/// stays the accepted test-only form (round 5)", async () => {
    // Shell-hostile spellings the two-step grammar has to catch: whitespace
    // (both the protocol regex's \s and the charset), command substitution and
    // semicolons (charset), and the two NON-admitted schemes — file:// with a
    // host segment (the grammar demands the third slash) and ssh:// with its
    // inherent userinfo. driver.test.ts holds the original three-row table;
    // these are the hostile rows round 5 asked for, at the same trust
    // boundary (fillExeDev's entry asserts, before any box exec).
    const vm = "fill-qds-19";
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create(vm);
    for (const bad of [
      "https://x/repo;rm -rf /",
      "https://x/repo$(id)",
      "https://x/repo y",
      "file://host/repo",
      "ssh://git@host/repo",
    ]) {
      let err: unknown;
      try {
        await driver.fill(vm, {
          runId: vm,
          repoUrl: bad,
          commitSha: plainSha,
          workdir: "work",
          ...FAST_MODE,
        });
      } catch (e) {
        err = e;
      }
      expect(err, bad).toBeInstanceOf(ExeDevDriverError);
      expect((err as ExeDevDriverError).code, bad).toBe("repo-url-invalid");
    }
    // The accepted test-only form, pinned by failure MODE rather than by
    // absence of a throw: a file:/// URL passes the grammar, so a path that
    // resolves to nothing refuses at the CLONE (fill-failed naming the clone
    // step) — never repo-url-invalid.
    let err: unknown;
    try {
      await driver.fill(vm, {
        runId: vm,
        repoUrl: "file:///nonexistent-definitely-not-here/repo",
        commitSha: plainSha,
        workdir: "work",
        ...FAST_MODE,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExeDevDriverError);
    expect((err as ExeDevDriverError).code).toBe("fill-failed");
    expect(String((err as Error).message)).toContain("clone");
    expect(String((err as Error).message)).not.toContain("repo-url-invalid");
  }, 120_000);

  test("a NON-EMPTY non-git workdir refuses at the CLONE step, naming it — and the leftover file is intact (round 5)", async () => {
    // The fresh/refill probe keys on `<work>/.git`: a workdir holding a
    // leftover is "fresh", and `git clone` into a non-empty directory is the
    // refusal — labelled `clone`, so an operator is pointed at the workdir
    // and not at the transport. The leftover must survive byte-identical:
    // fill never clears anything it did not create.
    const vm = "fill-qds-20";
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create(vm);
    await driver.exec(vm, ["sh", "-c", "mkdir work && printf 'precious\\n' > work/leftover.txt"]);

    let err: unknown;
    try {
      await driver.fill(vm, {
        runId: vm,
        repoUrl: `file://${plainOrigin}`,
        commitSha: plainSha,
        workdir: "work",
        ...FAST_MODE, // see FAST_MODE — the default arm is a table entry above
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExeDevDriverError);
    expect((err as ExeDevDriverError).code).toBe("fill-failed");
    expect(String((err as Error).message)).toContain("clone");
    expect(readFileSync(join(fake.boxDir(vm), "work", "leftover.txt"), "utf8")).toBe("precious\n");
  }, 120_000);

  test("a repository carrying .gitmodules + a submodule: fill clones, the submodule dir stays EMPTY, porcelain clean — today's shape as a contract (round 5)", async () => {
    // Fill never initializes submodules: the gitlink materialises as an empty
    // `sub/` directory, `.gitmodules` is customer-tracked (so no dirt), and
    // the clone itself succeeds. Pinned so that growing `--recurse-
    // submodules` (or refusing submodule repos outright) becomes a deliberate
    // change that reds here rather than a silent behaviour drift.
    const vm = "fill-qds-21";
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create(vm);
    await driver.fill(vm, {
      runId: vm,
      repoUrl: `file://${submodOrigin}`,
      commitSha: submodSha,
      workdir: "work",
      ...FAST_MODE, // see FAST_MODE — the default arm is a table entry above
    });
    const work = join(fake.boxDir(vm), "work");
    expect(existsSync(join(work, ".gitmodules"))).toBe(true);
    expect(existsSync(join(work, "sub"))).toBe(true);
    expect(readdirSync(join(work, "sub"))).toEqual([]); // never initialized
    const porcelain = await driver.exec(vm, ["git", "-C", "work", "status", "--porcelain"]);
    expect(porcelain.exitCode).toBe(0);
    expect(porcelain.stdout.trim()).toBe("");
  }, 120_000);

  test("a transfer that lands SHORT bytes refuses fill-failed naming 'the transfer corrupted' (round 5)", async () => {
    // pushBundle's size probe is the contract under test: the base64 payload
    // rides one exec stdin, and the box-side `wc -c` re-measures what actually
    // landed. The seam drops the last 32 base64 chars — a truncation neither
    // the exit code nor stderr reports (base64 -d succeeds on the shorter
    // input), so ONLY the probe can catch it.
    const vm = "fill-qds-22";
    const truncating: FakeCommand = async (argv, o) => {
      if (o?.stdin !== undefined && o.stdin.length > 128 && argv.some((a) => a.includes("base64 -d"))) {
        return fake.run(argv, { ...o, stdin: o.stdin.slice(0, -32) });
      }
      return fake.run(argv, o);
    };
    const driver = new ExeDevDriver({ run: truncating });
    await driver.create(vm);

    let err: unknown;
    try {
      await driver.fill(vm, {
        runId: vm,
        repoUrl: `file://${plainOrigin}`,
        commitSha: plainSha,
        workdir: "work",
        // DEFAULT mode (bundle-push): the transfer under test only exists on
        // this arm.
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExeDevDriverError);
    expect((err as ExeDevDriverError).code).toBe("fill-failed");
    expect(String((err as Error).message)).toContain("the transfer corrupted");
  }, 120_000);

  test("an exclude file with NO trailing newline is appended to cleanly — the customer's last pattern survives", async () => {
    // `printf '%s\\n' '/.qds/' >> "$p"` on a file whose last byte is not `\\n`
    // CONCATENATES: the result is `<their-last-pattern>/.qds/`, which silently
    // rewrites a rule of theirs AND leaves no `.qds` rule at all — so assertion
    // A fails for a reason no operator could trace back to the fill step. And
    // `grep -qxF` still would not match on a re-fill, so every fill appended
    // again.
    const vm = "fill-qds-10";
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create(vm);
    const opts = {
      runId: vm,
      repoUrl: `file://${plainOrigin}`,
      commitSha: plainSha,
      workdir: "work",
      ...FAST_MODE,
    };
    await driver.fill(vm, opts);
    const excludePath = join(fake.boxDir(vm), "work", ".git", "info", "exclude");
    // The customer's own exclude file, last byte NOT a newline.
    writeFileSync(excludePath, "*.tmp\nbuild/artifacts");
    expect(readFileSync(excludePath, "utf8").endsWith("\n")).toBe(false);

    await driver.fill(vm, opts);

    const lines = readFileSync(excludePath, "utf8").split("\n");
    // Their pattern survived intact…
    expect(lines).toContain("build/artifacts");
    // …and ours landed as its own line, not glued onto theirs.
    expect(lines).toContain(`/${QDS_IN_BOX_DIR}/`);
    expect(lines).not.toContain(`build/artifacts/${QDS_IN_BOX_DIR}/`);

    // Still idempotent from here: `grep -qxF` now matches, so a third fill
    // appends nothing — including no second blank line.
    const before = readFileSync(excludePath, "utf8");
    await driver.fill(vm, opts);
    expect(readFileSync(excludePath, "utf8")).toBe(before);
  }, 120_000);

  test("a workdir carrying a space or a metacharacter is refused by the grammar, before any box mutation", async () => {
    // `excludeQdsDir` and `assertQdsDirFree` both build a single `sh -c` string
    // with `shQuote(work)`, and that quoting is load-bearing — but it is the
    // SECONDARY belt. `assertWorkdirSafe` is the primary defense and refuses
    // the whole class outright, which is why no shipping path can reach the
    // interpolation with a hostile value. Neither half was asserted.
    const vm = "fill-qds-11";
    const driver = new ExeDevDriver({ run: fake.run });
    await driver.create(vm);
    for (const workdir of ["my work", 'work"; rm -rf /', "work$(id)", "../work", "work/../../etc"]) {
      let err: unknown;
      try {
        await driver.fill(vm, {
          runId: vm,
          repoUrl: `file://${plainOrigin}`,
          commitSha: plainSha,
          workdir,
          ...FAST_MODE,
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ExeDevDriverError);
      expect((err as ExeDevDriverError).code).toBe("workdir-invalid");
    }
    // Nothing was created for ANY of them — the refusal is before the probe,
    // and the whole box says so, not one spelling. A refusal that happened
    // AFTER the fresh/refill probe could have materialised a `work*` artifact
    // (the `work.bundle` sibling included) for any hostile input; the
    // metacharacter spellings are exactly the ones a single-path check would
    // have trusted.
    const entries = readdirSync(fake.boxDir(vm));
    expect(entries.some((e) => e.startsWith("work"))).toBe(false);
    expect(entries).not.toContain("my work");
  }, 120_000);
});
