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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExeDevDriver } from "../../../src/providers/exedev/driver.ts";
import { QDS_IN_BOX_DIR } from "../../../src/providers/exedev/fill.ts";
import { ExeDevDriverError } from "../../../src/providers/exedev/transport.ts";
import { fillRun } from "../../../src/providers/driver.ts";
import { fakeExeDev, type FakeExeDev } from "./fixtures/fake-exedev.ts";
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

describe("fillExeDev — AC2b: the manifest pair lives inside the checkout", () => {
  let fake: FakeExeDev;
  let tempDir: string;
  /** A repo with nothing of its own at `.qds` — the ordinary customer repo. */
  let plainOrigin: string;
  let plainSha: string;
  /** A repo that TRACKS its own `.qds/config.yaml` at HEAD. */
  let qdsOrigin: string;
  let qdsSha: string;
  /** A repo that tracks its own root `pipeline.yaml` AND a `roster.yaml`. */
  let collidingOrigin: string;
  let collidingSha: string;
  /** A repo whose `.qds` is NESTED (`sub/.qds/keep`) — must NOT be refused. */
  let nestedOrigin: string;
  let nestedSha: string;

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
    collidingOrigin = join(tempDir, "tracks-pipeline");
    collidingSha = await makeOrigin(collidingOrigin, {
      "pipeline.yaml": "theirs: true\n",
      "roster.yaml": "agents: []\n",
    });
    nestedOrigin = join(tempDir, "nested-qds");
    nestedSha = await makeOrigin(nestedOrigin, { "sub/.qds/keep": "nested\n" });
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
    // Nothing was created for any of them — the refusal is before the probe.
    expect(existsSync(join(fake.boxDir(vm), "my work"))).toBe(false);
  }, 120_000);
});
