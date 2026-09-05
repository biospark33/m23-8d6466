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
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip, gzipSync } from "node:zlib";

import type { ExecResult, ProviderDriver, ProviderVm } from "../../src/providers/driver.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { EXEC_MAX_OUTPUT_BYTES } from "../../src/providers/bounded-exec.ts";
import { ExeDevDriver } from "../../src/providers/exedev/driver.ts";
import {
  BOX_RUN_ROOT,
  BUNDLE_MAX_BYTES,
  HarvestError,
  TAR_MAX_BYTES,
  TAR_METADATA_MAX_BYTES,
  bunGitRunner,
  harvestRun,
  isNoSuchBox,
  pullArtifacts,
  sanitizeBoxOutput,
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
/**
 * DF1.10 AC4 stand-ins for the box's tmpfs `/run`. The fake substrate execs
 * the artifacts script on the HOST, so without an override the script would
 * probe the real `/run` and the real `$HOME` — every artifacts assertion in
 * this file would then depend on what happens to be lying around on the
 * machine running the suite. `hd()` points them at empty per-test dirs;
 * the AC4 tests below point them at populated ones. See HarvestDeps.
 */
let boxRunRoot: string;
let emptyBoxHome: string;
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
  boxRunRoot = join(dir, "run");
  emptyBoxHome = join(dir, "home");
  mkdirSync(boxRunRoot, { recursive: true });
  mkdirSync(emptyBoxHome, { recursive: true });
  BoxTmpDriver.artifactsServed = 0;
});

afterEach(() => {
  restoreLog?.();
  rmSync(dir, { recursive: true, force: true });
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Harvest deps over the shared fixtures. */
function hd(gitCwd: string, overrides: Partial<HarvestDeps> = {}): HarvestDeps {
  return {
    driver,
    store,
    gitCwd,
    runsDir: store.dir,
    workdir: "app",
    boxRunRoot,
    boxHome: emptyBoxHome,
    ...overrides,
  };
}

/**
 * The box's `$HOME` on the fake substrate. In a real box the checkout is
 * `$HOME/src` (or `$HOME/app`) and the login dir IS `$HOME` — the FakeDriver's
 * per-box directory is exactly that: it is the exec cwd and the parent of
 * `app`, so `harvest-artifacts.tgz` lands in it just as it does in a real box.
 */
function boxHomeOf(runId: string): string {
  return join(driver.root, runId);
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

/**
 * Delegates every ProviderDriver method to `inner` — the shared base for the
 * test doubles below, which override only the method they spy on or hijack.
 */
class DelegatingDriver implements ProviderDriver {
  constructor(protected readonly inner: ProviderDriver) {}

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

  exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult> {
    return this.inner.exec(vm, argv, stdin);
  }

  copyFile(vm: string, remotePath: string, localPath: string): Promise<void> {
    return this.inner.copyFile(vm, remotePath, localPath);
  }
}

class BoxTmpDriver extends DelegatingDriver {
  /**
   * Times exec served the crafted tgz. The INV-3 tests assert this is > 0:
   * if the short-circuit detector above ever stopped matching, the evil tgz
   * would never cross the seam and the suite would false-green against the
   * box's own (benign) artifacts instead.
   */
  static artifactsServed = 0;

  /** When set, the artifacts step is short-circuited and this tgz is served. */
  private readonly artifactsTgz?: string;

  constructor(inner: ProviderDriver, artifactsTgz?: string) {
    super(inner);
    this.artifactsTgz = artifactsTgz;
  }

  override async exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult> {
    if (this.artifactsTgz !== undefined && stdin !== undefined && stdin.includes("harvest-artifacts.tgz")) {
      // The box-side tar build is not what INV-3 tests — the validator is.
      // Report the served tgz's real size (the protocol's pre-copy probe field).
      BoxTmpDriver.artifactsServed++;
      return { stdout: `TARBUILT ${statSync(this.artifactsTgz).size}\n`, stderr: "", exitCode: 0 };
    }
    return this.inner.exec(vm, argv, stdin);
  }

  override async copyFile(vm: string, remotePath: string, localPath: string): Promise<void> {
    if (remotePath === "harvest-artifacts.tgz" && this.artifactsTgz !== undefined) {
      copyFileSync(this.artifactsTgz, localPath);
      return;
    }
    return this.inner.copyFile(vm, remotePath, localPath);
  }
}

/**
 * Wraps a driver recording every copyFile remote path, with an optional
 * stdout rewriter for the harvest protocol scripts — used to make the box
 * lie about sizes (pre-copy probe) or fail the artifacts step.
 */
class SpyDriver extends DelegatingDriver {
  readonly copies: string[] = [];
  private readonly rewrite?: (stdin: string, res: ExecResult) => ExecResult;

  constructor(
    inner: ProviderDriver,
    rewrite?: (stdin: string, res: ExecResult) => ExecResult,
  ) {
    super(inner);
    this.rewrite = rewrite;
  }

  override async exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult> {
    const res = await this.inner.exec(vm, argv, stdin);
    return stdin !== undefined && this.rewrite !== undefined ? this.rewrite(stdin, res) : res;
  }

  override async copyFile(vm: string, remotePath: string, localPath: string): Promise<void> {
    this.copies.push(remotePath);
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

/** A header whose size field carries a GNU base-256 value (byte 0 high bit set),
 * with the checksum recomputed so only the encoding is invalid. */
function base256Header(e: TarEntrySpec): Buffer {
  const b = tarHeader({ ...e, size: 0 });
  b[124] = 0x80;
  b[127] = 0x01; // base-256 ≈ 65536
  b.fill(" ", 148, 156);
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "utf8");
  return b;
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
      { driver: new BoxTmpDriver(driver, evilTgz), store, gitCwd: hostDir, runsDir: store.dir, workdir: "app", boxRunRoot, boxHome: emptyBoxHome },
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
  const servedBefore = BoxTmpDriver.artifactsServed;
  const err = await harvestWithArtifacts(s.runId, s.hostDir, evil);
  expect(err).toBeInstanceOf(HarvestError);
  const he = err as HarvestError;
  expect(he.code).toBe(code);
  // The crafted tgz really crossed the seam THIS invocation — not a false
  // green against the box's own (absent) artifacts, and not a leftover count
  // from an earlier serve (asserted relative to the pre-call baseline).
  expect(BoxTmpDriver.artifactsServed).toBeGreaterThan(servedBefore);
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

  test("backslash in a regular name → tar-unsafe-entry (win32 separator escapes the fold gates), dest empty", async () => {
    // On win32 Node's path join treats `\` as a separator: `..\\evil` would
    // traverse and `a/b` vs `a\\b` would collide past the folded-duplicate
    // check — refuse any raw backslash up front.
    const s = await boxSetup("hvst-tar-bslash", 1);
    await expectArtifactsAbort(s, (p) => writeFileSync(p, gzipSync(buildTar([{ name: "..\\evil.txt", data: Buffer.from("x") }]))), "tar-unsafe-entry");
  }, 30_000);

  test("backslash in a linkname → tar-unsafe-entry, dest empty", async () => {
    const s = await boxSetup("hvst-tar-bslash-link", 1);
    await expectArtifactsAbort(
      s,
      (p) => writeFileSync(p, gzipSync(buildTar([{ name: "link", typeflag: "2", linkname: "..\\evil" }]))),
      "tar-unsafe-entry",
    );
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

  test("metadata entry ('L') declaring an over-cap payload → tar-over-cap, dest empty", async () => {
    const s = await boxSetup("hvst-tar-meta-cap", 1);
    // Only the header's declared size lies (no data blocks follow) — the
    // validator must reject at the header, before a single chunk buffers.
    // Without the independent metadata cap this payload could legally buffer
    // up to the full 512 MiB tar cap (deviation 10, closed in round 10).
    await expectArtifactsAbort(
      s,
      (p) =>
        writeFileSync(p, gzipSync(buildTar([{ name: "long", typeflag: "L", size: TAR_METADATA_MAX_BYTES + 1 }]))),
      "tar-over-cap",
    );
  }, 30_000);

  test("truncated tar (no EOF block) → tar-truncated, dest empty", async () => {
    const s = await boxSetup("hvst-tar-trunc", 1);
    await expectArtifactsAbort(
      s,
      (p) => writeFileSync(p, gzipSync(buildTar([{ name: "a.txt", data: Buffer.from("hello") }], { eof: false }))),
      "tar-truncated",
    );
  }, 30_000);

  test("file/dir path conflict (file then its child, and the reverse) → tar-unsafe-entry, dest empty", async () => {
    const s = await boxSetup("hvst-tar-conflict", 1);
    await expectArtifactsAbort(
      s,
      (p) => writeFileSync(p, gzipSync(buildTar([
        { name: "run.log", data: Buffer.from("x") },
        { name: "run.log/x", data: Buffer.from("y") },
      ]))),
      "tar-unsafe-entry",
    );
    // Mirror: the child arrives first, so "run.log" is an implicit DIRECTORY
    // when a later entry claims it as a file.
    const s2 = await boxSetup("hvst-tar-conflict2", 1);
    await expectArtifactsAbort(
      s2,
      (p) => writeFileSync(p, gzipSync(buildTar([
        { name: "run.log/x", data: Buffer.from("y") },
        { name: "run.log", data: Buffer.from("x") },
      ]))),
      "tar-unsafe-entry",
    );
  }, 30_000);

  test("alias duplicates (a + ./a, a/b + a//b) → tar-unsafe-entry, dest empty", async () => {
    const s = await boxSetup("hvst-tar-alias1", 1);
    await expectArtifactsAbort(
      s,
      (p) => writeFileSync(p, gzipSync(buildTar([
        { name: "a.txt", data: Buffer.from("x") },
        { name: "./a.txt", data: Buffer.from("y") },
      ]))),
      "tar-unsafe-entry",
    );
    const s2 = await boxSetup("hvst-tar-alias2", 1);
    await expectArtifactsAbort(
      s2,
      (p) => writeFileSync(p, gzipSync(buildTar([
        { name: "d/inner.txt", data: Buffer.from("x") },
        { name: "d//inner.txt", data: Buffer.from("y") },
      ]))),
      "tar-unsafe-entry",
    );
  }, 30_000);

  test("GNU base-256 size field → tar-invalid, dest empty (not silently size 0)", async () => {
    const s = await boxSetup("hvst-tar-b256", 1);
    await expectArtifactsAbort(
      s,
      (p) => writeFileSync(p, gzipSync(Buffer.concat([base256Header({ name: "big.bin" }), EOF_BLOCKS]))),
      "tar-invalid",
    );
  }, 30_000);

  test("case-fold duplicate (plan.md + PLAN.MD) and NFD/NFC duplicate → tar-unsafe-entry", async () => {
    const s = await boxSetup("hvst-tar-case", 1);
    await expectArtifactsAbort(
      s,
      (p) => writeFileSync(p, gzipSync(buildTar([
        { name: "plan.md", data: Buffer.from("x") },
        { name: "PLAN.MD", data: Buffer.from("y") },
      ]))),
      "tar-unsafe-entry",
    );
    // NFC "café" vs its NFD decomposition: distinct bytes, same folded name.
    const s2 = await boxSetup("hvst-tar-nfd", 1);
    await expectArtifactsAbort(
      s2,
      (p) => writeFileSync(p, gzipSync(buildTar([
        { name: "café.txt", data: Buffer.from("x") },
        { name: "café.txt", data: Buffer.from("y") },
      ]))),
      "tar-unsafe-entry",
    );
  }, 30_000);

  test("lone ./ and // segments are canonicalized, not rejected: entry lands at its clean path", async () => {
    const runId = "hvst-tar-dot";
    const s = await boxSetup(runId, 1);
    const tgz = join(driver.root, runId, "evil-artifacts.tgz");
    writeFileSync(tgz, gzipSync(buildTar([{ name: "./sub//ok.txt", data: Buffer.from("payload") }])));
    const res = await harvestRun(
      { driver: new BoxTmpDriver(driver, tgz), store, gitCwd: s.hostDir, runsDir: store.dir, workdir: "app", boxRunRoot, boxHome: emptyBoxHome },
      runId,
    );
    expect(mustHarvest(res).count).toBe(1);
    expect(readFileSync(join(artifactsDir(runId), "sub", "ok.txt"), "utf8")).toBe("payload");
  }, 30_000);

  test("non-zero trailing bytes after EOF block → tar-invalid, dest empty", async () => {
    const s = await boxSetup("hvst-tar-trail", 1);
    const base = buildTar([{ name: "a.txt", data: Buffer.from("x") }], { eof: true }); // valid tar + EOF
    const evil = Buffer.concat([base, Buffer.from([0xff])]); // append garbage after EOF
    await expectArtifactsAbort(s, (p) => writeFileSync(p, gzipSync(evil)), "tar-invalid");
    expect(destClean(artifactsDir(s.runId))).toBeTrue();
  }, 30_000);

  test("zero padding after EOF block is accepted → extracts OK", async () => {
    const runId = "hvst-tar-zpad";
    const s = await boxSetup(runId, 1);
    const tgz = join(driver.root, runId, "evil-artifacts.tgz");
    // Valid tar + EOF + zero padding (to next block boundary, common from dd/padded writes)
    const base = buildTar([{ name: "ok.txt", data: Buffer.from("payload") }], { eof: true });
    const padded = Buffer.concat([base, Buffer.alloc(512)]); // one block of zero padding
    writeFileSync(tgz, gzipSync(padded));
    const res = await harvestRun(
      { driver: new BoxTmpDriver(driver, tgz), store, gitCwd: s.hostDir, runsDir: store.dir, workdir: "app", boxRunRoot, boxHome: emptyBoxHome },
      runId,
    );
    expect(mustHarvest(res).count).toBe(1);
    expect(readFileSync(join(artifactsDir(runId), "ok.txt"), "utf8")).toBe("payload");
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
      { driver: new BoxTmpDriver(driver, evil), store, gitCwd: s.hostDir, runsDir: store.dir, workdir: "app", boxRunRoot, boxHome: emptyBoxHome },
      runId,
    );
    expect(mustHarvest(res).count).toBe(1);
    expect(BoxTmpDriver.artifactsServed).toBeGreaterThan(0);
    const dest = artifactsDir(runId);
    expect(readFileSync(join(dest, "long-prefix-directory", "leaf.txt"), "utf8")).toBe("payload");
  }, 30_000);

  test("checksum mismatch → tar-invalid, dest empty", async () => {
    const s = await boxSetup("hvst-tar-csum", 1);
    const valid = buildTar([{ name: "ok.txt", data: Buffer.from("x") }], { eof: true });
    // Corrupt the checksum field (bytes 148-155) of the first header
    valid[148] = (valid[148] ?? 0) ^ 1; // flip one bit in the checksum octal field
    await expectArtifactsAbort(s, (p) => writeFileSync(p, gzipSync(valid)), "tar-invalid");
  }, 30_000);

  test("unparseable checksum field (non-octal garbage) → tar-invalid, dest empty", async () => {
    const s = await boxSetup("hvst-tar-csum-bad", 1);
    const h = tarHeader({ name: "ok.txt", data: Buffer.from("x") });
    // Overwrite checksum field with garbage (z's not octal)
    h.fill("z".charCodeAt(0), 148, 156);
    await expectArtifactsAbort(s, (p) => writeFileSync(p, gzipSync(Buffer.concat([h, EOF_BLOCKS]))), "tar-invalid");
  }, 30_000);

  test("unparseable size field (non-octal garbage, valid checksum) → tar-invalid, dest empty", async () => {
    const s = await boxSetup("hvst-tar-size-bad", 1);
    const b = tarHeader({ name: "ok.txt", data: Buffer.from("x") });
    // Overwrite size field with garbage
    b.fill("z".charCodeAt(0), 124, 136);
    // Recompute checksum with the garbage size (checksum field treated as spaces)
    b.fill(" ".charCodeAt(0), 148, 156);
    let sum = 0;
    for (const byte of b) sum += byte;
    b.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "utf8");
    await expectArtifactsAbort(s, (p) => writeFileSync(p, gzipSync(Buffer.concat([b, EOF_BLOCKS]))), "tar-invalid");
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

  test("NOREPO re-harvest keeps an existing earlier-harvest bundle (its presence is the record)", async () => {
    const runId = "hvst-norepo-keep";
    const hostRoot = mkdtempSync(join(tmpdir(), "qds-hvst-norepo-"));
    tmpRoots.push(hostRoot);
    const hostDir = join(hostRoot, "host");
    await runLocal(["git", "init", "-q", "-b", "main", hostDir]);

    await driver.create(runId);
    store.create(runId);
    store.set(runId, { vmName: runId, commitSha: "0123456789abcdef0123456789abcdef01234567" });
    writeFileSync(bundlePath(runId), "prior harvest bundle bytes");

    const res = await harvestRun(hd(hostDir), runId);
    expect(res).toEqual({ outcome: "none" });
    expect(readFileSync(bundlePath(runId), "utf8")).toBe("prior harvest bundle bytes");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// VM without a pinned base — artifacts still pulled (Step E is not gated on
// commitSha; only a record with no VM at all short-circuits)
// ---------------------------------------------------------------------------

describe("DF2.5 harvest — vmName without commitSha still pulls artifacts", () => {
  test("record with a vm but no pinned base: outcome none, artifacts pulled, no bundle steps", async () => {
    const runId = "hvst-nobase";
    const origin = await makeOriginRepo({ commits: 1 });
    tmpRoots.push(origin.root);
    const hostRoot = mkdtempSync(join(tmpdir(), "qds-hvst-nobase-"));
    tmpRoots.push(hostRoot);
    const hostDir = join(hostRoot, "host");
    await runLocal(["git", "clone", "-q", `file://${origin.originDir}`, hostDir]);

    // FILL died after box creation but before pinning the base: vmName set,
    // commitSha never written (set() cannot unset, so build it that way).
    await driver.create(runId);
    store.create(runId);
    store.set(runId, { vmName: runId });
    await driver.exec(runId, [
      "sh",
      "-c",
      "mkdir -p app/specs && printf plan > app/specs/plan.md && printf log > app/run.log",
    ]);

    const res = await harvestRun(hd(hostDir), runId);

    expect(res).toEqual({ outcome: "none" });
    expect(existsSync(bundlePath(runId))).toBeFalse();
    // Step E ran with the vm it had: the artifacts landed on the host.
    const dest = artifactsDir(runId);
    expect(readFileSync(join(dest, "specs", "plan.md"), "utf8")).toBe("plan");
    expect(readFileSync(join(dest, "run.log"), "utf8")).toBe("log");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// sanitizeBoxOutput — untrusted-output bounding + redaction (unit)
// ---------------------------------------------------------------------------

describe("sanitizeBoxOutput", () => {
  test("sk- token redacted", () => {
    const out = sanitizeBoxOutput("boom: sk-AbCdEf1234567890 tail");
    expect(out).not.toContain("AbCdEf");
    expect(out).toContain("sk-[REDACTED]");
  });

  test("encoded (mixed-class ≥40) key redacted, plain lowercase-hex sha survives", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(sanitizeBoxOutput(`error: ${sha} missing`)).toBe(`error: ${sha} missing`);
    // base64-shaped: upper + lower + digit, 44 chars → redacted
    const b64 = "QUJDZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg5";
    expect(sanitizeBoxOutput(`wrote ${b64} to stderr`)).not.toContain(b64);
    expect(sanitizeBoxOutput(`wrote ${b64} to stderr`)).toContain("[REDACTED]");
  });

  test("first line only, 200-char cap", () => {
    expect(sanitizeBoxOutput("line one\nline two sk-xyz")).toBe("line one");
    expect(sanitizeBoxOutput("x".repeat(250))).toHaveLength(201); // 200 + ellipsis
  });
});

// ---------------------------------------------------------------------------
// Round-4 hardening — locale pin, pre-copy size probes, stale-file cleanup,
// failure-path summary, record-read classification
// ---------------------------------------------------------------------------

describe("isNoSuchBox", () => {
  test("a HarvestError is classified solely by its typed flag — message text cannot override it", () => {
    // The wrap points compute noSuchBox on RAW seam output; a flagged-false
    // HarvestError whose sanitized message merely QUOTES the marker (a path,
    // an echoed diagnostic) must not route teardown into the box-gone skip.
    expect(
      isNoSuchBox(
        new HarvestError("bundle-copy-failed", "copying harvest.bundle out of vm failed: no such box: vm", "r"),
      ),
    ).toBeFalse();
    expect(isNoSuchBox(new HarvestError("artifacts-failed", "boom", "r", { noSuchBox: true }))).toBeTrue();
    // Raw driver throws that never passed a wrap point (a rejecting exec, a
    // transport error) keep the text fallback.
    expect(isNoSuchBox(new Error("exec failed: no such box: vm-1"))).toBeTrue();
    expect(isNoSuchBox(new Error("plain failure"))).toBeFalse();
    expect(isNoSuchBox("no such box")).toBeFalse(); // non-Error never classifies
  });
});

describe("DF2.5 harvest — round 4 hardening", () => {
  test("bunGitRunner spawns git with LC_ALL=C and LANG=C (argv-array spawn)", async () => {
    const root = mkdtempSync(join(tmpdir(), "qds-hvst-env-"));
    tmpRoots.push(root);
    const repoDir = join(root, "r");
    await runLocal(["git", "init", "-q", "-b", "main", repoDir]);
    const res = await bunGitRunner(
      ["git", "-c", "alias.qdslocale=!printenv LC_ALL && printenv LANG", "qdslocale"],
      repoDir,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("C\nC\n");
  }, 30_000);

  test("box-reported bundle size over cap → bundle-over-cap BEFORE any copyFile", async () => {
    const runId = "hvst-probe-bundle";
    const s = await boxSetup(runId, 2);
    const spy = new SpyDriver(driver, (stdin, res) =>
      stdin.includes("harvest.bundle") && res.exitCode === 0
        ? { ...res, stdout: res.stdout.replace(/^(OK \S+ \d+) \d+$/m, `$1 ${BUNDLE_MAX_BYTES + 1}`) }
        : res,
    );
    let err: unknown = undefined;
    try {
      await harvestRun({ driver: spy, store, gitCwd: s.hostDir, runsDir: store.dir, workdir: "app", boxRunRoot, boxHome: emptyBoxHome }, runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HarvestError);
    expect((err as HarvestError).code).toBe("bundle-over-cap");
    expect(spy.copies.length).toBe(0); // nothing crossed the seam
    expect(existsSync(bundlePath(runId))).toBeFalse();
  }, 30_000);

  test("box-reported artifacts tgz size over cap → tar-over-cap BEFORE any copyFile", async () => {
    const runId = "hvst-probe-tgz";
    const s = await boxSetup(runId, 1);
    const spy = new SpyDriver(driver, (stdin, res) =>
      stdin.includes("harvest-artifacts.tgz")
        ? { ...res, stdout: `TARBUILT ${TAR_MAX_BYTES + 1}\n` }
        : res,
    );
    let err: unknown = undefined;
    try {
      await harvestRun({ driver: spy, store, gitCwd: s.hostDir, runsDir: store.dir, workdir: "app", boxRunRoot, boxHome: emptyBoxHome }, runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HarvestError);
    expect((err as HarvestError).code).toBe("tar-over-cap");
    expect(spy.copies).not.toContain("harvest-artifacts.tgz");
    expect(existsSync(join(store.dir, `${runId}-artifacts.tgz`))).toBeFalse();
  }, 30_000);

  test("NOARTIFACTS sweeps a stale staging tgz and the artifacts dest dir", async () => {
    const runId = "hvst-noart-clean";
    const s = await boxSetup(runId, 1); // app exists but holds no artifact paths
    const staging = join(store.dir, `${runId}-artifacts.tgz`);
    writeFileSync(staging, "stale tgz");
    mkdirSync(artifactsDir(runId), { recursive: true });
    writeFileSync(join(artifactsDir(runId), "stale.txt"), "old");

    const res = await harvestRun(hd(s.hostDir), runId);
    expect(mustHarvest(res).count).toBe(1);
    expect(existsSync(staging)).toBeFalse();
    expect(existsSync(artifactsDir(runId))).toBeFalse();
  }, 30_000);

  test("standalone harvest: artifacts failure after a successful fetch still emits the summary", async () => {
    const runId = "hvst-artfail";
    const s = await boxSetup(runId, 2);
    const failing = new SpyDriver(driver, (stdin, res) =>
      stdin.includes("harvest-artifacts.tgz") ? { stdout: "", stderr: "tar exploded", exitCode: 1 } : res,
    );
    let err: unknown = undefined;
    try {
      await harvestRun({ driver: failing, store, gitCwd: s.hostDir, runsDir: store.dir, workdir: "app", boxRunRoot, boxHome: emptyBoxHome }, runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HarvestError);
    expect((err as HarvestError).code).toBe("artifacts-failed");
    // The fetch DID succeed first — the summary names both facts.
    expect(existsSync(bundlePath(runId))).toBeTrue();
    const summary = logs.filter((l) => "harvested" in l);
    expect(summary).toHaveLength(1);
    expect(summary[0]?.harvested).toBe(2);
    expect(summary[0]?.artifacts).toBe("failed");
  }, 30_000);

  test("unreadable-but-present record → record-read-failed (not no-record)", async () => {
    const runId = "hvst-badrec";
    const s = await boxSetup(runId, 1);
    writeFileSync(store.path(runId), "{ not json");
    let err: unknown = undefined;
    try {
      await harvestRun(hd(s.hostDir), runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HarvestError);
    const he = err as HarvestError;
    expect(he.code).toBe("record-read-failed");
    expect(he.remediation).not.toMatch(/create the run first/);
  }, 30_000);

  test("malformed record whose error text contains ENOENT → record-read-failed (never no-record)", async () => {
    const runId = "hvst-enoent-key";
    const s = await boxSetup(runId, 1);
    // An unknown core key literally named ENOENT: assertWellFormed's message
    // echoes it ("malformed run record <id>.json: unknown key: ENOENT"), so a
    // message-substring absence check would misroute this present-but-corrupt
    // record into no-record's unsafe create-the-run remediation. The typed
    // errno code (readRecord re-attaches it) must be the only classifier.
    writeFileSync(
      store.path(runId),
      JSON.stringify({ runId, createdAt: new Date().toISOString(), ENOENT: 1 }),
    );
    let err: unknown = undefined;
    try {
      await harvestRun(hd(s.hostDir), runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HarvestError);
    const he = err as HarvestError;
    expect(he.code).toBe("record-read-failed");
    expect(he.message).toContain("unknown key: ENOENT");
    expect(he.remediation).not.toMatch(/create the run first/);
  }, 30_000);

  test("genuinely missing record → no-record", async () => {
    const runId = "hvst-ghost";
    const s = await boxSetup(runId, 1);
    let err: unknown = undefined;
    try {
      await harvestRun(hd(s.hostDir), `${runId}-nope`);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HarvestError);
    expect((err as HarvestError).code).toBe("no-record");
  }, 30_000);

  test("bundle copyFile failure mid-copy leaves no partial hostBundle", async () => {
    const runId = "hvst-copy-fail";
    const s = await boxSetup(runId, 1);
    const hostBundle = bundlePath(runId);

    // Wrap the real driver to fail copyFile after writing partial bytes
    let writes = 0;
    class PartialCopyDriver extends DelegatingDriver {
      override async copyFile(_vm: string, _remotePath: string, localPath: string): Promise<void> {
        writes++;
        // Write a partial bundle header so a partial file would exist if we didn't clean up
        writeFileSync(localPath, "BUNDLE-v2");
        throw new Error("mid-copy failure");
      }
    }

    const failingDriver = new PartialCopyDriver(driver);

    let err: unknown = undefined;
    try {
      await harvestRun({ driver: failingDriver, store, gitCwd: s.hostDir, runsDir: store.dir, workdir: "app", boxRunRoot, boxHome: emptyBoxHome }, runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HarvestError);
    expect((err as HarvestError).code).toBe("bundle-copy-failed");
    expect(existsSync(hostBundle)).toBeFalse(); // partial bundle was removed
    expect(writes).toBe(1); // we did attempt the copy
  }, 30_000);

  // A directory at the copy destination makes BOTH copyFileSync and the
  // catch's non-recursive rmSync fail (EISDIR/ERR_FS_EISDIR) — before the
  // rmBestEffort guard, the cleanup error replaced the typed error and its
  // noSuchBox classification.
  test("staging-cleanup failure does not mask the typed artifacts error", async () => {
    const runId = "hvst-rm-mask-art";
    const s = await boxSetup(runId, 1);
    // Plant an artifact so the in-box step reports TARBUILT and copyFile runs.
    const plant = await driver.exec(runId, ["bash", "-c", "echo x > app/run.log"]);
    if (plant.exitCode !== 0) throw new Error(`plant failed: ${plant.stderr}`);
    const staging = join(store.dir, `${runId}-artifacts.tgz`);
    mkdirSync(staging); // copyFile dest AND cleanup target both fail on a dir

    let err: unknown = undefined;
    try {
      await harvestRun(hd(s.hostDir), runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HarvestError);
    expect((err as HarvestError).code).toBe("artifacts-failed");
    expect((err as HarvestError).message).toContain("copying harvest-artifacts.tgz");
  }, 30_000);

  test("hostBundle-cleanup failure does not mask the typed bundle-copy error", async () => {
    const runId = "hvst-rm-mask-bnd";
    const s = await boxSetup(runId, 1);
    mkdirSync(bundlePath(runId)); // copyFile dest AND cleanup target both fail on a dir

    let err: unknown = undefined;
    try {
      await harvestRun(hd(s.hostDir), runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HarvestError);
    expect((err as HarvestError).code).toBe("bundle-copy-failed");
    expect((err as HarvestError).message).toContain("copying harvest.bundle");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// DF1.10 AC4 — the durability split, and harvest carrying all of it out
// ---------------------------------------------------------------------------

/** A plausible in-box engine-log / resident-artifact set for one run. */
interface DurabilityFixture {
  /** Content written into $HOME/<runId>.engine.log. */
  engineLog?: string;
  /** Content of each solicit pair; index i becomes solicit-(i+1). */
  solicits?: { prompt: string; reply: string }[];
  /** Bytes of the tmpfs trace DB. Default: a token 3 bytes. */
  traceDbBytes?: number;
}

/**
 * Lay down what an in-box run leaves behind on BOTH sides of the durability
 * split: tmpfs `$runRoot` (marker + trace sidecar, wiped by a reboot) and
 * ext4 `$HOME` (durable journal, resident session, redacted prompt/reply
 * artifacts, engine log). Mirrors INV-IBOX-8's inventory exactly.
 */
function layDurability(runId: string, f: DurabilityFixture = {}): void {
  const home = boxHomeOf(runId);
  mkdirSync(join(boxRunRoot, "journal"), { recursive: true });
  mkdirSync(join(boxRunRoot, "trace"), { recursive: true });
  writeFileSync(join(boxRunRoot, "journal", "final.json"), JSON.stringify({ ok: true }));
  writeFileSync(join(boxRunRoot, "trace", "trace.db"), Buffer.alloc(f.traceDbBytes ?? 3, 0x61));
  // The uncheckpointed case, which is the DEFAULT one: the engine writes the
  // marker at pipeline-run.ts:2554 and only checkpoints at :2649, with a run-end
  // pi solicitation between them, so a marker-triggered harvest normally finds
  // the tail of the run still sitting in the sidecars.
  writeFileSync(join(boxRunRoot, "trace", "trace.db-wal"), "wal-tail");
  writeFileSync(join(boxRunRoot, "trace", "trace.db-shm"), "shm");
  writeFileSync(join(boxRunRoot, "trace", "events.jsonl"), '{"event":"engine_settled"}\n');
  writeFileSync(join(home, `${runId}.resident.jsonl`), '{"role":"assistant"}\n', { mode: 0o600 });
  writeFileSync(join(home, `${runId}.journal.jsonl`), '{\n  "phases": []\n}\n');
  writeFileSync(join(home, `${runId}.engine.log`), f.engineLog ?? "engine_started\nengine_settled\n");
  (f.solicits ?? []).forEach((s, i) => {
    writeFileSync(join(home, `${runId}-solicit-${i + 1}-prompt.txt`), s.prompt, { mode: 0o600 });
    writeFileSync(join(home, `${runId}-solicit-${i + 1}-reply.txt`), s.reply, { mode: 0o600 });
  });
}

/** Deps whose box roots point at the populated AC4 fixture for `runId`. */
function durabilityDeps(runId: string, hostDir: string, overrides: Partial<HarvestDeps> = {}): HarvestDeps {
  return hd(hostDir, { boxHome: boxHomeOf(runId), ...overrides });
}

/**
 * Every extracted file, as "/"-joined paths relative to the artifacts dest.
 *
 * AppleDouble siblings are dropped. macOS `tar` is bsdtar and archives each
 * member's extended attributes as a companion `._<name>` entry; the in-box tar
 * is GNU tar on the Ubuntu-derived image and emits none. Keeping them would
 * make these assertions about the SUITE HOST's tar rather than about the entry
 * names artifactsScript asks for — and would go green on Linux and red on a
 * developer's Mac for a reason that has nothing to do with the code.
 */
function extractedNames(runId: string): string[] {
  const root = artifactsDir(runId);
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (e.name.startsWith("._")) continue;
      const child = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else out.push(child);
    }
  };
  walk("");
  return out.sort();
}

/**
 * INV-IBOX-8's scanner: every extracted artifact — NAME and BYTES — searched
 * for OpenRouter key material. Returns one "<path>: <evidence>" line per hit
 * so a failure names the leaking file rather than just asserting false.
 *
 * Deliberately NOT a whole-tar grep: a hit has to be attributable to a file an
 * operator can go and shred, and the per-file walk is what makes the positive
 * control below able to prove the scan actually REACHES the engine log and the
 * resident artifacts rather than stopping at the checkout's own files.
 */
const KEY_SHAPE = /sk-or-[A-Za-z0-9_-]*/g;

function scanForKeyMaterial(runId: string): string[] {
  const root = artifactsDir(runId);
  const hits: string[] = [];
  for (const name of extractedNames(runId)) {
    if (name.includes("sk-or-")) hits.push(`${name}: leaked in the ENTRY NAME`);
    const body = readFileSync(join(root, name), "utf8");
    for (const m of body.matchAll(KEY_SHAPE)) hits.push(`${name}: ${m[0]}`);
  }
  return hits;
}

/** Key-SHAPED, never a real credential: the leak scanner's positive control. */
const FAKE_KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";

describe("DF1.10 AC4 — artifacts tar carries the durability split, re-rooted to relative names", () => {
  test("every AC4 source lands, entry names relative, tmpfs trace.db does NOT collide with the checkout's", async () => {
    const runId = "hvst-ac4-sources";
    const s = await boxSetup(runId, 1);
    // The checkout's OWN artifacts, including a `trace.db` — the name the
    // tmpfs trace DB would collide with if /run were flattened into the
    // archive root. A duplicate entry makes the validator reject the WHOLE
    // tar, so this is the case that has to keep working.
    await driver.exec(runId, [
      "sh",
      "-c",
      // `app/journal` and `app/trace` are the adversarial half: a CUSTOMER
      // checkout may hold files at exactly the names the /run sources claim as
      // top-level directories. The source list is five FIXED names, never a
      // glob, so they are not sources — and the exact-set assertion below is
      // what proves it, since either one leaking in would collide with a
      // /run entry and take the whole archive down.
      "mkdir -p app/specs && printf plan > app/specs/plan.md && printf log > app/run.log" +
        " && printf adw > app/trace.db && printf x > app/journal && printf y > app/trace",
    ]);
    layDurability(runId, { solicits: [{ prompt: "p1", reply: "r1" }, { prompt: "p2", reply: "r2" }] });

    const res = await pullArtifacts(durabilityDeps(runId, s.hostDir), runId);
    expect(res.artifacts).toBe("pulled");

    expect(extractedNames(runId)).toEqual([
      `${runId}-solicit-1-prompt.txt`,
      `${runId}-solicit-1-reply.txt`,
      `${runId}-solicit-2-prompt.txt`,
      `${runId}-solicit-2-reply.txt`,
      `${runId}.engine.log`,
      `${runId}.journal.jsonl`,
      `${runId}.resident.jsonl`,
      "journal/final.json",
      "run.log",
      "specs/plan.md",
      "trace.db",
      "trace/events.jsonl",
      "trace/trace.db",
      "trace/trace.db-wal",
    ]);
    // `trace.db-shm` IS in the box (layDurability writes it) and is deliberately
    // NOT in the list above: the shm is a transient index into the wal, rebuilt
    // on the next open, and a stale one archived beside a newer db/wal pair is
    // the one member that can mislead recovery rather than merely be incomplete.
    expect(existsSync(join(boxRunRoot, "trace", "trace.db-shm"))).toBeTrue();
    // Both trace DBs survived, distinguishable — the collision is real, and
    // the `trace/` prefix is what keeps them apart.
    const dest = artifactsDir(runId);
    expect(readFileSync(join(dest, "trace.db"), "utf8")).toBe("adw");
    expect(readFileSync(join(dest, "trace", "trace.db"), "utf8")).toBe("aaa");
    expect(JSON.parse(readFileSync(join(dest, "journal", "final.json"), "utf8"))).toEqual({ ok: true });
  }, 30_000);

  test("the uncheckpointed WAL tail rides out with the DB, and a checkpointed run with no sidecars still harvests", async () => {
    const runId = "hvst-ac4-wal";
    const s = await boxSetup(runId, 1);
    layDurability(runId);

    // Marker present, checkpoint not yet run — the ordinary case, since
    // pipeline-run.ts writes the marker at :2554 and only checkpoints at :2649.
    // Without the sidecars the harvested DB is missing the end of the run.
    expect((await pullArtifacts(durabilityDeps(runId, s.hostDir), runId)).artifacts).toBe("pulled");
    expect(readFileSync(join(artifactsDir(runId), "trace", "trace.db-wal"), "utf8")).toBe("wal-tail");

    // The shm never rides along at all, checkpointed or not (see BOX_RUN_SOURCES).
    expect(extractedNames(runId)).not.toContain("trace/trace.db-shm");

    // And the checkpointed case: TRUNCATE removes them, which must be a silent
    // skip rather than a harvest failure.
    rmSync(join(boxRunRoot, "trace", "trace.db-wal"));
    rmSync(join(boxRunRoot, "trace", "trace.db-shm"));

    const res = await pullArtifacts(durabilityDeps(runId, s.hostDir), runId);
    expect(res.artifacts).toBe("pulled");
    const names = extractedNames(runId);
    expect(names).toContain("trace/trace.db");
    expect(names).not.toContain("trace/trace.db-wal");
    expect(names).not.toContain("trace/trace.db-shm");
  }, 30_000);

  test("the script hands tar only -C/relative pairs — no member is ever an absolute path", async () => {
    const runId = "hvst-ac4-nabs";
    const s = await boxSetup(runId, 1);
    layDurability(runId);
    let script = "";
    const spy = new SpyDriver(driver, (stdin, r) => {
      if (stdin.includes("harvest-artifacts.tgz")) script = stdin;
      return r;
    });

    await pullArtifacts(durabilityDeps(runId, s.hostDir, { driver: spy }), runId);

    // NOT load-bearing on its own, and no longer claimed to be: GNU tar and
    // bsdtar both strip a leading "/" at STORE time ("Removing leading `/' from
    // member names"), and `extractedNames` walks the extracted tree building
    // relative paths, so `!n.startsWith("/")` cannot fail for anything this
    // box built. The REAL pins for "no absolute member" are the exact-set
    // assertions in the sibling tests (the `toEqual` lists one test up, which
    // break if the archive gains or re-roots a member) plus the script-shape
    // pins below. This check stays as a cheap invariant that would speak up if
    // a future tar ever stored an absolute name — nothing more.
    //
    // (History, kept because the comment used to say the opposite: this test
    // replaced a scan of the script TEXT for `args+=(` lines carrying a leading
    // "/", which could not fail either — the script never puts a member on an
    // `args+=(` line; members accumulate in `names+=(...)` and splice in as
    // `"${names[@]}"`.)
    const names = extractedNames(runId);
    expect(names.length).toBeGreaterThan(0); // non-vacuity: something was collected
    expect(names.every((n) => !n.startsWith("/"))).toBeTrue();

    // The tar invocation itself takes NO literal member: every source arrives
    // through the `args` array, and every entry pushed into it is either the
    // `-C` flag, a directory operand, or a BASENAME-relative member. Kept as a
    // pin on the SHAPE the assertion above depends on — an `args+=(...)` line
    // carrying its own literal member would put a name outside `names`.
    expect(script).toContain('tar czf "$out" "${args[@]}"');
    // assertPathSafe (harvest.ts) is what refuses an absolute name host-side;
    // this asserts we never generate one in the first place, which is the
    // whole reason it does not have to be relaxed. The pattern catches an
    // args line where a QUOTE or a root VARIABLE is immediately followed by a
    // "/" — `args+=("/etc/passwd")`, `args+=("$runRoot/$n")` and the unquoted
    // `args+=($home/$n)` all match, while the legitimate
    // `args+=(-C "$runRoot" "${names[@]}")` does not (the quote/root is
    // followed by a space or `)`, never a slash). The earlier
    // `/args\+=\([^)]*\s\//` shape demanded whitespace before the slash and
    // could not fail for any of these.
    for (const line of script.split("\n")) {
      if (line.includes("args+=(")) expect(line).not.toMatch(/args\+=\([^)]*(?:"|\$(?:runRoot|home|wd))\//);
    }
    expect(script).toContain('args+=(-C "$runRoot" "${names[@]}")');
    expect(script).toContain('args+=(-C "$home" "${names[@]}")');
  }, 30_000);

  test("an absent optional source is skipped silently — a run that solicited nothing still harvests", async () => {
    const runId = "hvst-ac4-partial";
    const s = await boxSetup(runId, 1);
    layDurability(runId, { solicits: [] }); // no prompt/reply pair at all

    const res = await pullArtifacts(durabilityDeps(runId, s.hostDir), runId);

    expect(res.artifacts).toBe("pulled");
    expect(extractedNames(runId)).toEqual([
      `${runId}.engine.log`,
      `${runId}.journal.jsonl`,
      `${runId}.resident.jsonl`,
      "journal/final.json",
      "trace/events.jsonl",
      "trace/trace.db",
      "trace/trace.db-wal",
    ]);
  }, 30_000);

  test("tmpfs sources alone are enough — no checkout artifacts, marker still comes out", async () => {
    const runId = "hvst-ac4-runonly";
    const s = await boxSetup(runId, 1); // `app` exists but holds no artifact names
    // $HOME empty, /run populated: the case where the engine died before it
    // wrote anything durable. The marker must still cross.
    mkdirSync(join(boxRunRoot, "journal"), { recursive: true });
    writeFileSync(join(boxRunRoot, "journal", "final.json"), '{"ok":false}');

    // `hd()` already defaults boxHome to the empty one — no override here, so a
    // later change to that default reaches this test instead of leaving it
    // silently pinned to the old behaviour.
    const res = await pullArtifacts(hd(s.hostDir), runId);

    expect(res.artifacts).toBe("pulled");
    expect(extractedNames(runId)).toEqual(["journal/final.json"]);
  }, 30_000);

  test("nothing anywhere is NOARTIFACTS, NOT a silent success — the two outcomes stay distinguishable", async () => {
    const runId = "hvst-ac4-nothing";
    const s = await boxSetup(runId, 1); // no checkout artifacts, empty /run, empty $HOME

    const res = await pullArtifacts(hd(s.hostDir), runId);

    // `toEqual` is exact, so it already excludes a populated `files`.
    expect(res).toEqual({ artifacts: "none" });
    expect(existsSync(artifactsDir(runId))).toBeFalse();
  }, 30_000);

  test("production defaults: the run root rides argv as /run and the home is OMITTED, resolved in-box", async () => {
    const runId = "hvst-ac4-defaults";
    const s = await boxSetup(runId, 1);
    let seen: string[] = [];
    const spy = new (class extends DelegatingDriver {
      override exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult> {
        if (stdin?.includes("harvest-artifacts.tgz")) {
          seen = argv;
          // SYNTHETIC, deliberately not delegated. This test omits
          // boxRunRoot/boxHome on purpose — that is what makes the argv it
          // asserts production's — but `FakeDriver` runs the script ON THE
          // HOST, so delegating would run the real artifacts script against
          // the suite machine's `/run` and `$HOME`. That is precisely the
          // host-dependence this file's header says the overrides exist to
          // prevent: a matching `$HOME/<runId>.engine.log` on somebody's
          // laptop would silently change what lands in `<runId>-artifacts`,
          // and the behaviour would differ between a Mac and Linux CI for
          // reasons unrelated to the code. The assertion below needs `seen`
          // and nothing else, so nothing is lost by answering NOARTIFACTS.
          return Promise.resolve({ stdout: "NOARTIFACTS\n", stderr: "", exitCode: 0 });
        }
        return this.inner.exec(vm, argv, stdin);
      }
    })(driver);

    // No boxRunRoot/boxHome override — exactly what production passes.
    await pullArtifacts({ driver: spy, store, gitCwd: s.hostDir, runsDir: store.dir, workdir: "app" }, runId);

    // OMITTED, not empty — five elements, no sixth.
    //
    // This assertion used to read `[…, BOX_RUN_ROOT, ""]` and it PINNED A
    // DEFECT. `ExeDevDriver.exec` refuses any argv carrying an empty or
    // whitespace-only element (driver.ts:1235 and :1249, its rounds 6-7
    // hardening), so the shape asserted here could never reach a box — it failed
    // artifact collection on the first live tier-1 round and cascaded into four
    // more red tests via `harvest_waived` teardowns.
    //
    // It passed for the same reason the bug survived: this test captured what
    // the CODE DID and asserted that, while the `FakeDriver` underneath did not
    // implement the real driver's per-element rule. The fake and the test then
    // agreed with each other about a shape the real substrate rejects on sight —
    // which is worse than no coverage, because it looked like coverage. The fake
    // now mirrors the rule (fake-driver.ts), so this test could not go back to
    // the old shape even if someone re-asserted it.
    //
    // The INTENT is unchanged and is why the element is dropped rather than
    // given a value: with `$3` unset the in-box script's `home="${3:-$HOME}"`
    // resolves the box's own `$HOME`, which the host cannot know.
    expect(seen).toEqual(["bash", "-s", "--", runId, BOX_RUN_ROOT]);
    expect(BOX_RUN_ROOT).toBe("/run");
    // The INVARIANT behind the literal above, asserted separately so a future
    // argv change has to satisfy the driver's contract rather than merely match
    // a new expected array someone updated to make this line green.
    expect(seen.every((a) => a.length > 0 && a.trim().length > 0)).toBeTrue();
  }, 30_000);

  test("AC4's headline case: /run WIPED by a reboot, $HOME survives — the run's durable evidence still crosses", async () => {
    // THE reason AC4 exists, and the one shape the suite had no case for. Every
    // other test here populates both roots, or only `/run`, or neither. This is
    // the post-reboot box: tmpfs is gone (marker, trace DB, sidecars, events all
    // with it) and ext4 is intact. If the `-C "$home"` block were ever made
    // conditional on run-root presence, or the unmatched-glob fallback
    // misbehaved when $HOME is the ONLY contributor, this would come back
    // NOARTIFACTS and the run's only surviving evidence would be lost — with
    // every other test in this file still green.
    const runId = "hvst-ac4-reboot";
    const s = await boxSetup(runId, 1);
    layDurability(runId, { solicits: [{ prompt: "p1", reply: "r1" }] });
    // The reboot: tmpfs is volatile, so /run comes back EMPTY, not absent.
    rmSync(boxRunRoot, { recursive: true, force: true });
    mkdirSync(boxRunRoot, { recursive: true });
    expect(readdirSync(boxRunRoot)).toEqual([]);
    // …and the checkout carries nothing of its own either, so $HOME is provably
    // the sole contributor to the archive below.

    const res = await pullArtifacts(durabilityDeps(runId, s.hostDir), runId);

    expect(res.artifacts).toBe("pulled");
    expect(extractedNames(runId)).toEqual([
      `${runId}-solicit-1-prompt.txt`,
      `${runId}-solicit-1-reply.txt`,
      `${runId}.engine.log`,
      `${runId}.journal.jsonl`,
      `${runId}.resident.jsonl`,
    ]);
    // Not merely present — readable, with the content the box had.
    expect(readFileSync(join(artifactsDir(runId), `${runId}-solicit-1-reply.txt`), "utf8")).toBe("r1");
  }, 30_000);

  test("a workload-planted SYMLINK in the $HOME glob is dropped, not tarred — the pull still succeeds", async () => {
    // The availability defect this guard exists for. `-solicit-*` is the first
    // unbounded, WORKLOAD-controlled name space in the source set, and `[ -f ]`
    // follows symlinks: a link stored as a link entry hits the validator's
    // disallowed-typeflag arm, which refuses the WHOLE archive — and since the
    // artifacts pull is teardown's step 2, that refusal used to abort teardown
    // before `destroy` and leave the box billing forever (the reaper then
    // re-aborted through the same path on every sweep).
    const runId = "hvst-ac4-symlink";
    const s = await boxSetup(runId, 1);
    layDurability(runId);
    const home = boxHomeOf(runId);
    // Exactly what a code/dispatch phase can run: `ln -s /etc/passwd
    // ~/<runId>-solicit-9-reply.txt`. Pointed at the box's own key file here,
    // which is the version with teeth — following it would exfiltrate the run
    // key, and storing it would refuse the archive.
    writeFileSync(join(home, ".env"), "OPENROUTER_API_KEY=sk-or-v1-planted\n");
    symlinkSync(join(home, ".env"), join(home, `${runId}-solicit-9-reply.txt`));
    // A dangling one too — a link whose target does not exist at all.
    symlinkSync(join(home, "nowhere"), join(home, `${runId}-solicit-8-prompt.txt`));

    const res = await pullArtifacts(durabilityDeps(runId, s.hostDir), runId);

    // The pull SUCCEEDS. That is the availability half.
    expect(res.artifacts).toBe("pulled");
    const names = extractedNames(runId);
    // Neither link crossed, under either name…
    expect(names).not.toContain(`${runId}-solicit-9-reply.txt`);
    expect(names).not.toContain(`${runId}-solicit-8-prompt.txt`);
    // …and the key was NOT dereferenced into the archive under any name.
    expect(scanForKeyMaterial(runId)).toEqual([]);
    // The real sources beside them are unaffected — this is a per-source drop,
    // not a bail-out of the whole `$HOME` group.
    expect(names).toContain(`${runId}.engine.log`);
    expect(names).toContain(`${runId}.resident.jsonl`);
  }, 30_000);

  test("a symlinked source in the FIXED name sets is dropped too — the guard is per-source, not per-list", async () => {
    // The globs are the workload's easiest handle, but the fixed names live in
    // a checkout the workload also writes: `app/run.log -> app/.env` is the
    // same attack one directory over.
    const runId = "hvst-ac4-symlink-fixed";
    const s = await boxSetup(runId, 1);
    layDurability(runId);
    await driver.exec(runId, [
      "sh",
      "-c",
      `printf 'OPENROUTER_API_KEY=${FAKE_KEY}\\n' > app/.env && ln -s .env app/run.log && printf real > app/trace.db`,
    ]);

    const res = await pullArtifacts(durabilityDeps(runId, s.hostDir), runId);

    expect(res.artifacts).toBe("pulled");
    const names = extractedNames(runId);
    expect(names).not.toContain("run.log");
    expect(names).toContain("trace.db"); // the regular sibling still crosses
    expect(scanForKeyMaterial(runId)).toEqual([]);
  }, 30_000);

  test("a deps-injected boxRunRoot reaches argv, and a blank or relative seam is REFUSED before the box is touched", async () => {
    const runId = "hvst-ac4-seam";
    const s = await boxSetup(runId, 1);
    layDurability(runId);
    let seen: string[] = [];
    const spy = new (class extends DelegatingDriver {
      override exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult> {
        if (stdin?.includes("harvest-artifacts.tgz")) seen = argv;
        return this.inner.exec(vm, argv, stdin);
      }
    })(driver);

    await pullArtifacts(durabilityDeps(runId, s.hostDir, { driver: spy }), runId);

    // Both seams ride argv verbatim, and the argv the REAL driver would accept:
    // no empty and no whitespace-only element anywhere.
    expect(seen).toEqual(["bash", "-s", "--", runId, boxRunRoot, boxHomeOf(runId)]);
    expect(seen.every((a) => a.trim().length > 0)).toBeTrue();

    // A blank `boxHome` used to be SILENTLY DISCARDED — the script then resolved
    // the box's own `$HOME`, so a suite that thought it had redirected the probe
    // was passing its assertions against the host's real home. A blank
    // `boxRunRoot` did the opposite and re-created the `empty-argv` refusal this
    // PR is a post-mortem of. Both are throws now, and neither reaches a box.
    for (const bad of [{ boxHome: "" }, { boxHome: "   " }, { boxRunRoot: "" }, { boxRunRoot: "  " }]) {
      const err = await pullArtifacts(durabilityDeps(runId, s.hostDir, bad), runId).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HarvestError);
      expect((err as HarvestError).code).toBe("box-root-invalid");
    }
    // Relative is refused for tar's reason, not for tidiness: repeated `-C` is
    // cumulative, so a relative root resolves under `$wd` and collects nothing —
    // which reads as "the run produced no artifacts" rather than as an error.
    for (const bad of [{ boxHome: "home" }, { boxRunRoot: "run" }]) {
      const err = await pullArtifacts(durabilityDeps(runId, s.hostDir, bad), runId).catch((e: unknown) => e);
      expect((err as HarvestError).code).toBe("box-root-invalid");
    }
    // PADDED absolutes are the third arm of the same refusal (DF1.10 round 3,
    // C2-1): `"/run "` is neither blank nor relative, so it used to PASS and
    // ship verbatim — the in-box probe then matched nothing under a root that
    // does not exist, the silent-empty outcome wearing an absolute path.
    for (const bad of [{ boxRunRoot: "/run " }, { boxHome: "/home/pad\n" }]) {
      const err = await pullArtifacts(durabilityDeps(runId, s.hostDir, bad), runId).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HarvestError);
      expect((err as HarvestError).code).toBe("box-root-invalid");
    }
  }, 30_000);

  test("an extra box-side line ahead of TARBUILT is a hard remote-protocol failure, not a silent success", async () => {
    // `pullArtifacts` anchors /^TARBUILT (\d+)$/ against the WHOLE trimmed
    // stdout, and this story rewrote the script that produces it. So any extra
    // line the box emits — an MOTD, a tar notice, a shell warning on a future
    // image — turns a SUCCESSFUL collection into a hard harvest failure. The
    // sibling branches (NOARTIFACTS, a garbage line) are covered; this one was
    // not, and nothing said whether the strictness was intended. It is: a
    // protocol line the host cannot trust is not a size it may act on.
    const runId = "hvst-ac4-banner";
    const s = await boxSetup(runId, 1);
    layDurability(runId);
    const spy = new SpyDriver(driver, (stdin, r) =>
      stdin.includes("harvest-artifacts.tgz") ? { ...r, stdout: "banner\nTARBUILT 10\n" } : r,
    );

    const err = await pullArtifacts(durabilityDeps(runId, s.hostDir, { driver: spy }), runId).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(HarvestError);
    expect((err as HarvestError).code).toBe("remote-protocol");
    // Nothing was copied down or extracted off an unparsed protocol line.
    expect(existsSync(artifactsDir(runId))).toBeFalse();
  }, 30_000);

  test("a workdir with a SPACE is refused by the grammar, so the unquoted interpolation is never reached", async () => {
    // `artifactsScript` interpolates the workdir list UNQUOTED into the script
    // text (it is a `for d in …` word list), and that is only safe because
    // `workdirList` grammar-checks it first. The decision is load-bearing and
    // nothing asserted it.
    const runId = "hvst-ac4-wdspace";
    const s = await boxSetup(runId, 1);
    for (const bad of ["my work", "app;rm -rf /", "app$(id)", "../app", "app/../../etc"]) {
      const err = await pullArtifacts(hd(s.hostDir, { workdir: bad }), runId).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HarvestError);
      expect((err as HarvestError).code).toBe("workdir-invalid");
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// DF1.10 AC4 — negative control: neither copyFile nor exec+cat can do this job
// ---------------------------------------------------------------------------

describe("DF1.10 AC4 negative control — /run/trace/trace.db is unreachable except through the tar", () => {
  test("copyFile refuses the absolute in-box path outright (box-relative only)", async () => {
    const runId = "hvst-ac4-neg-copy";
    await boxSetup(runId, 1);
    layDurability(runId);
    const dest = join(dir, "pulled.db");

    // The SHIPPING guard, asserted against the shipping driver: exedev's
    // copyFile grammar-checks the remote path before it is ever interpolated
    // into an scp spec, and box-relative means a leading "/" is refused. The
    // transport seam is a CANARY, not the real one: if the argument guard ever
    // moves below the connection setup, this test fails on the canary (and in
    // one step) instead of degrading to a 30 s timeout or a real outbound
    // connection attempt against a nonexistent box.
    let transportCalls = 0;
    const canary = new ExeDevDriver({
      run: async () => {
        transportCalls++;
        throw new Error("transport reached — the remote-path guard no longer precedes the scp");
      },
    });
    let real: unknown;
    try {
      await canary.copyFile(runId, `${BOX_RUN_ROOT}/trace/trace.db`, dest);
    } catch (e) {
      real = e;
    }
    expect((real as { code?: string }).code).toBe("remote-path-invalid");
    expect((real as Error).message).toContain("no leading /");
    expect(transportCalls).toBe(0); // the refusal is at the argument, not at the seam

    // And the fake substrate this suite runs on refuses to deliver it too, so
    // no test in this file can accidentally prove the tar unnecessary.
    let fake: unknown;
    try {
      await driver.copyFile(runId, `${BOX_RUN_ROOT}/trace/trace.db`, dest);
    } catch (e) {
      fake = e;
    }
    expect(fake).toBeInstanceOf(Error);
    expect(existsSync(dest)).toBeFalse();
  }, 30_000);

  test("exec+cat passes on an empty DB and TRUNCATES a real one — the tar carries it whole", async () => {
    const runId = "hvst-ac4-neg-cat";
    const s = await boxSetup(runId, 1);
    const big = EXEC_MAX_OUTPUT_BYTES + 4096;

    // The control the story names: on an EMPTY fixture DB, exec+cat looks
    // perfectly adequate.
    layDurability(runId, { traceDbBytes: 0 });
    const empty = await driver.exec(runId, ["cat", join(boxRunRoot, "trace", "trace.db")]);
    expect(empty.exitCode).toBe(0);
    expect(empty.truncated).toBeUndefined();

    // A real one is past the 512 KiB exec bound and comes back cut.
    writeFileSync(join(boxRunRoot, "trace", "trace.db"), Buffer.alloc(big, 0x62));
    const real = await driver.exec(runId, ["cat", join(boxRunRoot, "trace", "trace.db")]);
    expect(real.truncated).toBeTrue();
    expect(Buffer.byteLength(real.stdout)).toBeLessThan(big);

    // The tar path has no such bound (TAR_MAX_BYTES is 512 MiB, untouched):
    // the DB arrives byte-for-byte.
    const res = await pullArtifacts(durabilityDeps(runId, s.hostDir), runId);
    expect(res.artifacts).toBe("pulled");
    expect(statSync(join(artifactsDir(runId), "trace", "trace.db")).size).toBe(big);
    // NOMINAL pin, and deliberately so: exercising the 512 MiB ceiling
    // behaviourally means building, shipping and streaming a ~512 MiB archive
    // in a unit suite — a ~512 MiB-per-run fixture cost for a bound whose
    // ENFORCEMENT POINTS are already pinned structurally (the box-reported
    // pre-probe arm behaviourally via the TARBUILT-lie stub above, the
    // parser's decompressed-total and summed-entry arms via the small-fixture
    // validator tests). What this line holds is the VALUE: the ceiling cannot
    // silently shrink to something a real run's trace DB would blow through.
    expect(TAR_MAX_BYTES).toBe(512 * 1024 * 1024);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// INV-IBOX-8 — no `sk-or-` material in the harvested tar (engine log + resident
// artifacts included), proven non-vacuous by a positive control
// ---------------------------------------------------------------------------

describe("DF1.10 INV-IBOX-8 — the harvested tar carries no sk-or- material", () => {
  test("a redacted run: every extracted artifact, engine log and resident files included, is clean", async () => {
    const runId = "hvst-inv8-clean";
    const s = await boxSetup(runId, 1);
    // The run's capped key really is in the box, at the path DF2.3 delivers it
    // to — inside the checkout, one directory away from sources the tar DOES
    // take. Planting it is what makes the clean assertion below load-bearing
    // about INV-IBOX-4/5 rather than only about the artifacts: no source list
    // names `.env`, and if one ever did, the scan is what would say so.
    await driver.exec(runId, [
      "sh",
      "-c",
      `printf 'boot ok' > app/run.log && printf 'OPENROUTER_API_KEY=${FAKE_KEY}\\n' > app/.env`,
    ]);
    layDurability(runId, {
      // What DF3.3's redact() leaves behind: the key NAME survives, the value
      // does not. This is the realistic clean case, not an empty file.
      engineLog: "engine_started requestId=abc\nOPENROUTER_API_KEY=[REDACTED]\nengine_settled ok=true\n",
      solicits: [{ prompt: "prompt with OPENROUTER_API_KEY=[REDACTED]", reply: "reply, key [REDACTED]" }],
    });

    const res = await pullArtifacts(durabilityDeps(runId, s.hostDir), runId);
    expect(res.artifacts).toBe("pulled");

    // Non-vacuity guard #1: the files this invariant is ABOUT are actually in
    // the archive. A scan over a tar that never carried them would pass
    // trivially — that is exactly the failure mode this test exists to avoid.
    const names = extractedNames(runId);
    expect(names).toContain(`${runId}.engine.log`);
    expect(names).toContain(`${runId}.resident.jsonl`);
    expect(names).toContain(`${runId}-solicit-1-prompt.txt`);
    expect(names).toContain(`${runId}-solicit-1-reply.txt`);
    // The key file stayed in the box.
    expect(names).not.toContain(".env");

    expect(scanForKeyMaterial(runId)).toEqual([]);
  }, 30_000);

  test("POSITIVE CONTROL: the same scan over the same pipeline FINDS a planted key in the engine log and the resident artifacts", async () => {
    const runId = "hvst-inv8-control";
    const s = await boxSetup(runId, 1);
    // Identical fixture to the test above except the redaction "failed".
    layDurability(runId, {
      engineLog: `engine_started\nspawning pi with ${FAKE_KEY}\n`,
      solicits: [{ prompt: "prompt", reply: `use ${FAKE_KEY} to continue` }],
    });
    writeFileSync(join(boxHomeOf(runId), `${runId}.resident.jsonl`), `{"key":"${FAKE_KEY}"}\n`);

    const res = await pullArtifacts(durabilityDeps(runId, s.hostDir), runId);
    expect(res.artifacts).toBe("pulled");

    const hits = scanForKeyMaterial(runId);
    // Every newly-added $HOME source is reachable by the scan — this is what
    // makes the clean assertion above evidence rather than a tautology. If the
    // `-C "$home"` pairs were ever dropped from artifactsScript, these three
    // files would not be in the tar and THIS test would go green-by-absence,
    // so it is asserted file by file.
    expect(hits.map((h) => h.split(":")[0]).sort()).toEqual([
      `${runId}-solicit-1-reply.txt`,
      `${runId}.engine.log`,
      `${runId}.resident.jsonl`,
    ]);
    for (const h of hits) expect(h).toContain(FAKE_KEY);
  }, 30_000);
});
