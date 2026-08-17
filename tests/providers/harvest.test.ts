/**
 * DF2.5 — harvest half: ranged bundle → copy → verify → fetch to refs/sandbox,
 * plus the artifacts tar validator (INV-3).
 *
 * Every AC/invariant maps to a test here (design.md "TESTS → harvest.test.ts",
 * cases 1–10). The reference justfiles shipped unrun upstream, so these are the
 * blocking evidence.
 *
 * Harness note — the in-box staging paths are box-root relative
 * (`harvest.bundle`, `harvest-artifacts.tgz`), so plain FakeDriver covers the
 * whole flow end to end: its exec'd scripts run inside the box dir (itself a
 * host dir) and `copyFile`'s guard accepts the relative names. `BoxTmpDriver`
 * below exists only for INV-3: it short-circuits the in-box tar-build step
 * (detected by the script naming `harvest-artifacts.tgz`) and serves a
 * hand-crafted tgz instead — the validator is the boundary under test, not the
 * box's own `tar`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip, gzipSync } from "node:zlib";

import type { ExecResult, ProviderDriver, ProviderVm } from "../../src/providers/driver.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import {
  HarvestError,
  bunGitRunner,
  harvestRun,
  type GitRunner,
  type HarvestDeps,
  type HarvestResult,
} from "../../src/providers/harvest.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/log.ts";
import {
  cloneIntoBox,
  hostGit,
  makeOriginRepo,
  makeUnrelatedRepo,
  runLocal,
} from "./fixtures/git-fixture.ts";

// ---------------------------------------------------------------------------
// Shared state + conventions (mirrors credentials.test.ts)
// ---------------------------------------------------------------------------

let dir: string;
let store: RunRecordStore;
let driver: FakeDriver;
let logs: LogEntry[];
let restoreLog: (() => void) | undefined;
/** mkdtemp roots created inside a test (origins, host clones); swept in afterEach. */
const tmpRoots: string[] = [];

beforeEach(() => {
  logs = [];
  restoreLog = setLogSink((entry) => logs.push(entry));
  dir = mkdtempSync(join(tmpdir(), "qds-hvst-"));
  store = new RunRecordStore(join(dir, "runs"));
  driver = new FakeDriver(join(dir, "boxes"));
});

afterEach(() => {
  restoreLog?.();
  rmSync(dir, { recursive: true, force: true });
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Harvest deps over the shared fixtures. */
function hd(gitCwd: string, overrides: Partial<HarvestDeps> = {}): HarvestDeps {
  return { driver, store, gitCwd, runsDir: store.dir, workdir: "app", ...overrides };
}

function bundlePath(runId: string): string {
  return join(store.dir, `${runId}.bundle`);
}

function artifactsDir(runId: string): string {
  return join(store.dir, `${runId}-artifacts`);
}

/** Design: on an aborted extraction the destination is absent or empty. */
function destClean(p: string): boolean {
  return !existsSync(p) || readdirSync(p).length === 0;
}

function mustHarvest(res: HarvestResult): { count: number; tip: string } {
  if (res.outcome !== "harvested") throw new Error(`expected harvested, got ${res.outcome}`);
  return res;
}

interface Origin {
  root: string;
  originDir: string;
  baseSha: string;
  shas: string[];
}

interface Setup {
  runId: string;
  origin: Origin;
  hostDir: string;
}

/**
 * A box the way FILL leaves it: record (vmName + pinned commitSha), a fake box,
 * origin cloned into `app`, `sbx/<runId>` branched at the pin, `commits` empty
 * commits on top. Host side: a second clone of the same origin (the operator
 * host repo the fetch lands in), plus a tag so "operator refs unchanged" has a
 * tag to protect.
 */
async function boxSetup(runId: string, commits: number): Promise<Setup> {
  const origin = await makeOriginRepo({ commits: 1 });
  tmpRoots.push(origin.root);
  const hostRoot = mkdtempSync(join(tmpdir(), "qds-hvst-host-"));
  tmpRoots.push(hostRoot);
  const hostDir = join(hostRoot, "host");
  await runLocal(["git", "clone", "-q", `file://${origin.originDir}`, hostDir]);
  await runLocal(["git", "-C", hostDir, "tag", "v0"]);

  await driver.create(runId);
  store.create(runId);
  store.set(runId, { vmName: runId, commitSha: origin.baseSha });
  await cloneIntoBox(driver, runId, origin.originDir, "app");
  const sw = await driver.exec(runId, ["git", "-C", "app", "switch", "-c", `sbx/${runId}`]);
  if (sw.exitCode !== 0) throw new Error(`box switch failed: ${sw.stderr}`);
  for (let i = 0; i < commits; i++) await boxCommit(runId, `run output ${i + 1}`);
  return { runId, origin, hostDir };
}

async function boxCommit(vm: string, msg: string): Promise<void> {
  const r = await driver.exec(vm, [
    "git",
    "-C",
    "app",
    "-c",
    "user.email=run@box",
    "-c",
    "user.name=run",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    msg,
  ]);
  if (r.exitCode !== 0) throw new Error(`box commit failed: ${r.stderr}`);
}

/** The box tip of the run branch, read the way an operator would. */
async function boxTip(runId: string): Promise<string> {
  const r = await driver.exec(runId, ["git", "-C", "app", "rev-parse", `refs/heads/sbx/${runId}`]);
  if (r.exitCode !== 0) throw new Error(`box rev-parse failed: ${r.stderr}`);
  return r.stdout.trim();
}

// ---------------------------------------------------------------------------
// BoxTmpDriver — inject crafted artifacts tgzs (INV-3 only; see header)
// ---------------------------------------------------------------------------

class BoxTmpDriver implements ProviderDriver {
  /** When set, the artifacts step is short-circuited and this tgz is served. */
  private readonly artifactsTgz?: string;

  constructor(inner: ProviderDriver, artifactsTgz?: string) {
    this.inner = inner;
    this.artifactsTgz = artifactsTgz;
  }

  private readonly inner: ProviderDriver;

  get name(): string {
    return this.inner.name;
  }

  create(name: string, tag?: string): Promise<ProviderVm> {
    return this.inner.create(name, tag);
  }

  list(name?: string): Promise<ProviderVm[]> {
    return this.inner.list(name);
  }

  destroy(vm: string): Promise<void> {
    return this.inner.destroy(vm);
  }

  expose(vm: string, port: number): Promise<string> {
    return this.inner.expose(vm, port);
  }

  setPublic(vm: string): Promise<void> {
    return this.inner.setPublic(vm);
  }

  whoami(): Promise<string> {
    return this.inner.whoami();
  }

  async exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult> {
    if (this.artifactsTgz !== undefined && stdin !== undefined && stdin.includes("harvest-artifacts.tgz")) {
      // The box-side tar build is not what INV-3 tests — the validator is.
      return { stdout: "TARBUILT\n", stderr: "", exitCode: 0 };
    }
    return this.inner.exec(vm, argv, stdin);
  }

  async copyFile(vm: string, remotePath: string, localPath: string): Promise<void> {
    if (remotePath === "harvest-artifacts.tgz" && this.artifactsTgz !== undefined) {
      copyFileSync(this.artifactsTgz, localPath);
      return;
    }
    return this.inner.copyFile(vm, remotePath, localPath);
  }
}

// ---------------------------------------------------------------------------
// Hand-rolled tar builder (512-byte ustar headers, GNU tar manual offsets)
// ---------------------------------------------------------------------------

const BLOCK = 512;
const EOF_BLOCKS = Buffer.alloc(BLOCK * 2);

interface TarEntrySpec {
  name: string;
  data?: Buffer;
  /** Declared size (defaults to data.length). */
  size?: number;
  /** Typeflag at offset 156. Default "0" (regular file). */
  typeflag?: string;
  linkname?: string;
  prefix?: string;
  mode?: number;
}

/** `width` counts the trailing NUL: 11 octal digits + NUL for a 12-byte field. */
function octalField(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function tarHeader(e: TarEntrySpec): Buffer {
  const b = Buffer.alloc(BLOCK);
  b.write(e.name.slice(0, 100), 0, "utf8");
  b.write(octalField(e.mode ?? 0o644, 8), 100, "utf8"); // mode
  b.write(octalField(0, 8), 108, "utf8"); // uid
  b.write(octalField(0, 8), 116, "utf8"); // gid
  b.write(octalField(e.size ?? e.data?.length ?? 0, 12), 124, "utf8"); // size
  b.write(octalField(0, 12), 136, "utf8"); // mtime
  b.write("        ", 148, "utf8"); // chksum field = spaces while computing
  b.write(e.typeflag ?? "0", 156, "utf8");
  if (e.linkname) b.write(e.linkname.slice(0, 100), 157, "utf8");
  b.write("ustar\0", 257, "utf8"); // magic
  b.write("00", 263, "utf8"); // version
  if (e.prefix) b.write(e.prefix.slice(0, 155), 345, "utf8");
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "utf8");
  return b;
}

function padBlocks(n: number): Buffer {
  return Buffer.alloc((BLOCK - (n % BLOCK)) % BLOCK);
}

function buildTar(entries: TarEntrySpec[], opts: { eof?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0);
    parts.push(tarHeader(e), data, padBlocks(data.length));
  }
  if (opts.eof !== false) parts.push(EOF_BLOCKS);
  return Buffer.concat(parts);
}

/** ~600 MiB of zeros in one entry — gzips to ~600 KB on disk, stays under the
 * 512 MiB received-bytes cap, and only the decompressed/summed-size cap can
 * catch it. Streamed: never materializes the uncompressed bytes in memory. */
const BOMB_BYTES = 600 * 1024 * 1024;

async function writeBombTgz(path: string): Promise<void> {
  await pipeline(
    (async function* () {
      yield tarHeader({ name: "bomb.bin", size: BOMB_BYTES });
      const chunk = Buffer.alloc(512 * 1024);
      for (let left = BOMB_BYTES; left > 0; left -= chunk.length) {
        yield left < chunk.length ? chunk.subarray(0, left) : chunk;
      }
      yield EOF_BLOCKS;
    })(),
    createGzip(),
    createWriteStream(path),
  );
}

/** Run a full harvest whose artifacts step serves a crafted tgz; return the error. */
async function harvestWithArtifacts(
  runId: string,
  hostDir: string,
  evilTgz: string,
): Promise<unknown> {
  let err: unknown = undefined;
  try {
    await harvestRun(
      { driver: new BoxTmpDriver(driver, evilTgz), store, gitCwd: hostDir, runsDir: store.dir, workdir: "app" },
      runId,
    );
  } catch (e) {
    err = e;
  }
  return err;
}

/** Stage a crafted tgz inside the box dir and harvest with it. */
async function expectArtifactsAbort(
  s: Setup,
  write: (path: string) => Promise<void> | void,
  code: string,
): Promise<HarvestError> {
  const evil = join(driver.root, s.runId, "evil-artifacts.tgz");
  await write(evil);
  const err = await harvestWithArtifacts(s.runId, s.hostDir, evil);
  expect(err).toBeInstanceOf(HarvestError);
  const he = err as HarvestError;
  expect(he.code).toBe(code);
  expect(destClean(artifactsDir(s.runId))).toBeTrue();
  return he;
}

// ---------------------------------------------------------------------------
// AC1 — ranged bundle, quarantine-only landing, byte-identical host
// ---------------------------------------------------------------------------

describe("DF2.5 harvest — AC1: ranged bundle lands only at refs/sandbox/<run-id>", () => {
  test("3-commit branch: harvested {count:3}, only refs/sandbox/<id> added, host byte-identical, bundle on disk", async () => {
    const runId = "hvst-ac1";
    const s = await boxSetup(runId, 3);
    const tip = await boxTip(runId);

    const beforeRefs = await hostGit(s.hostDir, ["for-each-ref"]);
    const beforeStatus = await hostGit(s.hostDir, ["status", "--porcelain"]);
    const beforeBranches = await hostGit(s.hostDir, ["branch", "-a"]);
    const beforeHead = await hostGit(s.hostDir, ["rev-parse", "HEAD"]);

    const res = mustHarvest(await harvestRun(hd(s.hostDir), runId));
    expect(res.count).toBe(3);
    expect(res.tip).toBe(tip);

    // Objects landed at refs/sandbox/<id> and nowhere else: the for-each-ref
    // diff is exactly one added line, zero removed lines.
    const beforeLines = beforeRefs.split("\n").filter((l) => l !== "");
    const afterLines = (await hostGit(s.hostDir, ["for-each-ref"])).split("\n").filter((l) => l !== "");
    const added = afterLines.filter((l) => !beforeLines.includes(l));
    const removed = beforeLines.filter((l) => !afterLines.includes(l));
    expect(removed).toHaveLength(0);
    expect(added).toHaveLength(1);
    expect(added[0] ?? "").toMatch(new RegExp(`refs/sandbox/${runId}$`));

    // Working tree, index, HEAD and branch/tag surface untouched.
    expect(await hostGit(s.hostDir, ["status", "--porcelain"])).toBe(beforeStatus);
    expect(await hostGit(s.hostDir, ["branch", "-a"])).toBe(beforeBranches);
    expect(await hostGit(s.hostDir, ["rev-parse", "HEAD"])).toBe(beforeHead);

    // The quarantine ref holds exactly the branch's commits beyond base.
    const ranged = await hostGit(s.hostDir, ["rev-list", "--count", `${s.origin.baseSha}..refs/sandbox/${runId}`]);
    expect(Number(ranged.trim())).toBe(3);

    expect(existsSync(bundlePath(runId))).toBeTrue();
  }, 30_000);

  test("bundle is ranged, not --all: header carries the -<base> prerequisite and exactly one ref line, refs/heads/sbx/<id>", async () => {
    const runId = "hvst-range";
    const s = await boxSetup(runId, 2);
    const tip = await boxTip(runId);
    await harvestRun(hd(s.hostDir), runId);

    const header = readFileSync(bundlePath(runId)).subarray(0, 1024).toString("latin1");
    // A prerequisite line exists and names the FILL-pinned base.
    expect(header).toMatch(/^-([0-9a-f]{40,64})(\s|$)/m);
    expect(header).toMatch(new RegExp(`^-${s.origin.baseSha}(\\s|$)`, "m"));
    // The bundle's only ref is the sandbox branch — an --all bundle would also
    // list refs/heads/main and the clone's remote refs.
    const refLines = header.split("\n").filter((l) => /^[0-9a-f]{40,64} refs\//.test(l));
    expect(refLines).toHaveLength(1);
    expect(refLines[0] ?? "").toBe(`${tip} refs/heads/sbx/${runId}`);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// AC2 — non-descendant branch refused host-side
// ---------------------------------------------------------------------------

describe("DF2.5 harvest — AC2: non-descendant branch fails verify naming the sha", () => {
  test("box cloned from an unrelated origin: missing-prerequisite, sha named, no refs/sandbox written", async () => {
    const runId = "hvst-ac2";
    // Host side: clone of origin A. Box side: clone of an UNRELATED repo B whose
    // base the host does not have — the ranged bundle's prerequisite is exactly
    // that sha, so host-side verify refuses it.
    const origin = await makeOriginRepo({ commits: 1 });
    const unrelated = await makeUnrelatedRepo();
    tmpRoots.push(origin.root, unrelated.root);
    const hostRoot = mkdtempSync(join(tmpdir(), "qds-hvst-ac2-"));
    tmpRoots.push(hostRoot);
    const hostDir = join(hostRoot, "host");
    await runLocal(["git", "clone", "-q", `file://${origin.originDir}`, hostDir]);

    await driver.create(runId);
    store.create(runId);
    store.set(runId, { vmName: runId, commitSha: unrelated.baseSha });
    await cloneIntoBox(driver, runId, unrelated.originDir, "app");
    const sw = await driver.exec(runId, ["git", "-C", "app", "switch", "-c", `sbx/${runId}`]);
    if (sw.exitCode !== 0) throw new Error(`box switch failed: ${sw.stderr}`);
    await boxCommit(runId, "diverged work");

    const before = await hostGit(hostDir, ["for-each-ref"]);
    let err: unknown = undefined;
    try {
      await harvestRun(hd(hostDir), runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HarvestError);
    const he = err as HarvestError;
    expect(he.code).toBe("missing-prerequisite");
    expect(he.message).toContain(unrelated.baseSha);
    // Nothing landed and nothing moved: refs byte-identical before/after.
    expect(await hostGit(hostDir, ["for-each-ref"])).toBe(before);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// AC4 — zero commits beyond base
// ---------------------------------------------------------------------------

describe("DF2.5 harvest — AC4: empty branch is a successful no-op", () => {
  test("branch at base: outcome none, no ref, no bundle file, harvested: none logged", async () => {
    const runId = "hvst-ac4";
    const s = await boxSetup(runId, 0);
    const before = await hostGit(s.hostDir, ["for-each-ref"]);

    const res = await harvestRun(hd(s.hostDir), runId);
    expect(res).toEqual({ outcome: "none" });

    expect(existsSync(bundlePath(runId))).toBeFalse();
    expect(await hostGit(s.hostDir, ["for-each-ref"])).toBe(before);
    expect(destClean(artifactsDir(runId))).toBeTrue();
    // Summary line: a `harvested` field carrying "none" (design observability).
    const summary = logs.filter((l) => "harvested" in l);
    expect(summary.length).toBeGreaterThan(0);
    expect(String(summary[0]?.harvested)).toBe("none");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// AC5 — idempotent re-harvest
// ---------------------------------------------------------------------------

describe("DF2.5 harvest — AC5: re-harvest force-updates in place", () => {
  test("2 more in-box commits: count 3→5, ref force-updated, artifacts re-pulled with no stale files", async () => {
    const runId = "hvst-ac5";
    const s = await boxSetup(runId, 3);
    await driver.exec(runId, [
      "sh",
      "-c",
      "mkdir -p app/specs && printf v1 > app/specs/plan.md && printf log1 > app/run.log",
    ]);

    const first = mustHarvest(await harvestRun(hd(s.hostDir), runId));
    expect(first.count).toBe(3);
    const dest = artifactsDir(runId);
    expect(readFileSync(join(dest, "specs", "plan.md"), "utf8")).toBe("v1");
    expect(readFileSync(join(dest, "run.log"), "utf8")).toBe("log1");

    // A stale host-side file plus evolved box content: the second extraction
    // must replace, not merge.
    writeFileSync(join(dest, "stale.txt"), "must disappear");
    await driver.exec(runId, ["sh", "-c", "printf v2 > app/specs/plan.md && printf extra > app/specs/extra.md"]);
    await boxCommit(runId, "more work 1");
    await boxCommit(runId, "more work 2");
    const newTip = await boxTip(runId);

    const second = mustHarvest(await harvestRun(hd(s.hostDir), runId));
    expect(second.count).toBe(5);
    expect(second.tip).toBe(newTip);
    const ranged = await hostGit(s.hostDir, ["rev-list", "--count", `${s.origin.baseSha}..refs/sandbox/${runId}`]);
    expect(Number(ranged.trim())).toBe(5);

    expect(existsSync(join(dest, "stale.txt"))).toBeFalse();
    expect(readFileSync(join(dest, "specs", "plan.md"), "utf8")).toBe("v2");
    expect(readFileSync(join(dest, "specs", "extra.md"), "utf8")).toBe("extra");
    expect(readFileSync(join(dest, "run.log"), "utf8")).toBe("log1");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// INV-1 — credential containment
// ---------------------------------------------------------------------------

describe("DF2.5 harvest — INV-1: no push credential exists or appears in the box", () => {
  test("origin is an unauthenticated file:// URL, no credentials file, no credential helper, nothing pushed", async () => {
    const runId = "hvst-inv1";
    const s = await boxSetup(runId, 2);
    const originBefore = await hostGit(s.origin.originDir, ["for-each-ref"]);

    await harvestRun(hd(s.hostDir), runId);

    const url = (await driver.exec(runId, ["git", "-C", "app", "remote", "get-url", "origin"])).stdout.trim();
    expect(url.startsWith("file://")).toBeTrue();
    expect(url.includes("@")).toBeFalse(); // no userinfo on the clone URL

    // ~/.git-credentials absent, seen from inside the box against a controlled
    // HOME (a fake box shares the host's real one — point it somewhere empty).
    const emptyHome = join(dir, "empty-home");
    mkdirSync(emptyHome, { recursive: true });
    const realHome = process.env.HOME;
    process.env.HOME = emptyHome;
    let cred: ExecResult;
    try {
      cred = await driver.exec(runId, ["sh", "-c", 'test -e "$HOME/.git-credentials"']);
    } finally {
      if (realHome === undefined) {
        // biome-ignore lint/performance/noDelete: restoring env absence, not mutating a hot object
        delete process.env.HOME;
      } else {
        process.env.HOME = realHome;
      }
    }
    expect(cred.exitCode).toBe(1); // test -e: 1 = absent

    const cfg = readFileSync(join(driver.root, runId, "app", ".git", "config"), "utf8");
    expect(cfg).not.toMatch(/credential/i);
    expect(cfg).not.toContain("insteadOf");

    // Negative control: nothing was pushed to the origin.
    expect(await hostGit(s.origin.originDir, ["for-each-ref"])).toBe(originBefore);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// INV-2 — verify strictly before fetch; refspec discipline
// ---------------------------------------------------------------------------

describe("DF2.5 harvest — INV-2: verify-before-fetch, sandbox-only refspec", () => {
  test("spied gitRunner: bundle verify strictly before fetch; fetch carries --force and the sandbox refspec", async () => {
    const runId = "hvst-inv2";
    const s = await boxSetup(runId, 2);
    const calls: string[][] = [];
    const spy: GitRunner = (argv: readonly string[], cwd: string) => {
      calls.push([...argv]);
      return bunGitRunner(argv, cwd);
    };

    await harvestRun(hd(s.hostDir, { gitRunner: spy }), runId);

    const verifyIdx = calls.findIndex((a) => a.includes("verify"));
    const fetchIdx = calls.findIndex((a) => a.includes("fetch"));
    expect(verifyIdx).toBeGreaterThanOrEqual(0);
    expect(fetchIdx).toBeGreaterThanOrEqual(0);
    expect(verifyIdx).toBeLessThan(fetchIdx);

    const fetchArgv = calls.find((a) => a.includes("fetch"));
    expect(fetchArgv).toBeDefined();
    expect(fetchArgv?.includes("--force")).toBeTrue();
    expect(fetchArgv?.includes(`refs/heads/sbx/${runId}:refs/sandbox/${runId}`)).toBeTrue();
  }, 30_000);

  test("injected verify exit-1: harvest throws and NO fetch ever ran", async () => {
    const runId = "hvst-inv2f";
    const s = await boxSetup(runId, 2);
    const calls: string[][] = [];
    const failing: GitRunner = (argv: readonly string[], cwd: string) => {
      calls.push([...argv]);
      if (argv.includes("verify")) {
        return Promise.resolve({ stdout: "", stderr: "injected verify failure", exitCode: 1 });
      }
      return bunGitRunner(argv, cwd);
    };

    let err: unknown = undefined;
    try {
      await harvestRun(hd(s.hostDir, { gitRunner: failing }), runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HarvestError);
    expect((err as HarvestError).code).toBe("bundle-verify-failed");
    expect(calls.some((a) => a.includes("fetch"))).toBeFalse();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// INV-3 — artifacts tar validated before extraction
// ---------------------------------------------------------------------------

describe("DF2.5 harvest — INV-3: evil artifacts tgzs abort with nothing extracted", () => {
  test("path traversal entry (../) → tar-unsafe-entry, dest empty", async () => {
    const s = await boxSetup("hvst-tar-trav", 1);
    await expectArtifactsAbort(s, (p) => writeFileSync(p, gzipSync(buildTar([{ name: "../evil.txt", data: Buffer.from("x") }]))), "tar-unsafe-entry");
  }, 30_000);

  test("absolute-path entry → tar-unsafe-entry, dest empty", async () => {
    const s = await boxSetup("hvst-tar-abs", 1);
    await expectArtifactsAbort(s, (p) => writeFileSync(p, gzipSync(buildTar([{ name: "/tmp/evil.txt", data: Buffer.from("x") }]))), "tar-unsafe-entry");
  }, 30_000);

  test("absolute symlink entry (typeflag 2) → tar-unsafe-entry, dest empty", async () => {
    const s = await boxSetup("hvst-tar-sym", 1);
    await expectArtifactsAbort(
      s,
      (p) => writeFileSync(p, gzipSync(buildTar([{ name: "link", typeflag: "2", linkname: "/tmp/evil" }]))),
      "tar-unsafe-entry",
    );
  }, 30_000);

  test("hardlink entry (typeflag 1) → tar-unsafe-entry, dest empty", async () => {
    const s = await boxSetup("hvst-tar-hard", 1);
    await expectArtifactsAbort(
      s,
      (p) => writeFileSync(p, gzipSync(buildTar([{ name: "hl", typeflag: "1", linkname: "target" }]))),
      "tar-unsafe-entry",
    );
  }, 30_000);

  test("char device entry (typeflag 3) → tar-unsafe-entry, dest empty", async () => {
    const s = await boxSetup("hvst-tar-char", 1);
    await expectArtifactsAbort(
      s,
      (p) => writeFileSync(p, gzipSync(buildTar([{ name: "dev0", typeflag: "3", linkname: "" }]))),
      "tar-unsafe-entry",
    );
  }, 30_000);

  test("fifo entry (typeflag 6) → tar-unsafe-entry, dest empty", async () => {
    const s = await boxSetup("hvst-tar-fifo", 1);
    await expectArtifactsAbort(
      s,
      (p) => writeFileSync(p, gzipSync(buildTar([{ name: "pipe0", typeflag: "6" }]))),
      "tar-unsafe-entry",
    );
  }, 30_000);

  test("gzip bomb (~600 MiB declared+shipped zeros) → tar-over-cap, dest empty", async () => {
    const s = await boxSetup("hvst-tar-bomb", 1);
    await expectArtifactsAbort(s, (p) => writeBombTgz(p), "tar-over-cap");
  }, 60_000);

  test("truncated tar (no EOF block) → tar-truncated, dest empty", async () => {
    const s = await boxSetup("hvst-tar-trunc", 1);
    await expectArtifactsAbort(
      s,
      (p) => writeFileSync(p, gzipSync(buildTar([{ name: "a.txt", data: Buffer.from("hello") }], { eof: false }))),
      "tar-truncated",
    );
  }, 30_000);

  test("ustar prefix field: full name parses and the file lands at prefix/name", async () => {
    const runId = "hvst-tar-prefix";
    const s = await boxSetup(runId, 1);
    const evil = join(driver.root, runId, "evil-artifacts.tgz");
    writeFileSync(
      evil,
      gzipSync(buildTar([{ name: "leaf.txt", prefix: "long-prefix-directory", data: Buffer.from("payload") }])),
    );

    const res = await harvestRun(
      { driver: new BoxTmpDriver(driver, evil), store, gitCwd: s.hostDir, runsDir: store.dir, workdir: "app" },
      runId,
    );
    expect(mustHarvest(res).count).toBe(1);
    const dest = artifactsDir(runId);
    expect(readFileSync(join(dest, "long-prefix-directory", "leaf.txt"), "utf8")).toBe("payload");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Record untouched (schema closed)
// ---------------------------------------------------------------------------

describe("DF2.5 harvest — record untouched: harvest writes NOTHING to the record", () => {
  test("full harvest (commits + artifacts) on a keyed record: parsed record deep-equal before/after", async () => {
    const runId = "hvst-rec";
    const s = await boxSetup(runId, 3);
    // A keyed record — sha256-shaped hash (all-lowercase hex passes the store's
    // secret-shape guard; no keyApi exists in HarvestDeps at all).
    store.set(runId, { keyHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", limitMicroUsd: 50_000_000 });
    await driver.exec(runId, [
      "sh",
      "-c",
      "mkdir -p app/specs && printf plan > app/specs/plan.md && printf log > app/run.log",
    ]);

    const before = JSON.parse(readFileSync(store.path(runId), "utf8")) as unknown;
    const res = await harvestRun(hd(s.hostDir), runId);
    expect(mustHarvest(res).count).toBe(3);
    const after = JSON.parse(readFileSync(store.path(runId), "utf8")) as unknown;
    expect(after).toEqual(before);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// NOREPO
// ---------------------------------------------------------------------------

describe("DF2.5 harvest — box never got a repo", () => {
  test("empty box: outcome none", async () => {
    const runId = "hvst-norepo";
    const hostRoot = mkdtempSync(join(tmpdir(), "qds-hvst-norepo-"));
    tmpRoots.push(hostRoot);
    const hostDir = join(hostRoot, "host");
    await runLocal(["git", "init", "-q", "-b", "main", hostDir]);

    await driver.create(runId);
    store.create(runId);
    store.set(runId, { vmName: runId, commitSha: "0123456789abcdef0123456789abcdef01234567" });

    const res = await harvestRun(hd(hostDir), runId);
    expect(res).toEqual({ outcome: "none" });
    expect(existsSync(bundlePath(runId))).toBeFalse();
  }, 30_000);
});
