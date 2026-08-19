/**
 * `fake` provider driver — a complete implementation of the seam over a temp
 * directory and child processes (DF2.1).
 *
 * Not a stub: every primitive does the real thing at its own scale. A "box" is a
 * directory with a `.box.json` metadata file; `exec` spawns a child process with
 * the box directory as its cwd; `copyFile` copies box → host. That is enough for
 * the driver contract suite to walk all seven lifecycle verbs end to end without
 * a substrate, and it is what keeps DF2.2's exe.dev driver an addition rather
 * than a reshape.
 */

import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExecResult, ProviderDriver, ProviderVm } from "./driver.ts";
import { assertValidRunId } from "./run-record.ts";

/** The box-name grammar, mirrored from the run-id grammar `boxDir` enforces. */
const RUN_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export const DEFAULT_FAKE_BOXES_DIR = ".sandbox/fake-boxes";

interface BoxMeta {
  name: string;
  tag?: string;
  public: boolean;
  ports: number[];
  createdAt: string;
}

const META = ".box.json";

export class FakeDriver implements ProviderDriver {
  readonly name = "fake";
  readonly root: string;
  /**
   * Live exec children per box. Destroy kills them: a real box destroy kills
   * the box's processes, and an exec abandoned by a caller (the demo's
   * fail-closed close paths) must not leave an orphan host child behind.
   */
  private readonly execChildren = new Map<string, Set<{ kill: () => void }>>();

  constructor(root?: string) {
    this.root = root ?? process.env.QDS_FAKE_BOXES_DIR ?? DEFAULT_FAKE_BOXES_DIR;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  private boxDir(vm: string): string {
    // Box names are hostnames — the same grammar the run id obeys. Validating
    // here is what keeps `../evil` from escaping the boxes root.
    assertValidRunId(vm);
    return join(this.root, vm);
  }

  private readMeta(vm: string): BoxMeta {
    const dir = this.boxDir(vm);
    try {
      const meta = JSON.parse(readFileSync(join(dir, META), "utf8")) as BoxMeta;
      // `.box.json` lives inside the box a workload can write to. If a workload
      // overwrites it with a different `meta.name`, treat the metadata as
      // unbound from this directory rather than trusting it: `list()`'s
      // no-metadata recovery path then reports the physical directory as an
      // unknown box, which is what keeps it reapable instead of letting the
      // renamed metadata redirect writes (`expose`/`setPublic`) into a
      // box the reaper still believes is claimed.
      if (meta.name !== vm) throw new Error("box metadata name mismatch");
      return meta;
    } catch (e) {
      throw new Error(`no such box: ${vm} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
    }
  }

  private writeMeta(meta: BoxMeta): void {
    writeFileSync(join(this.boxDir(meta.name), META), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
  }

  async create(name: string, tag?: string): Promise<ProviderVm> {
    const dir = this.boxDir(name);
    // Non-recursive mkdir: a second create of the same box fails with EEXIST
    // rather than silently adopting someone else's box.
    mkdirSync(dir, { mode: 0o700 });
    const meta: BoxMeta = { name, tag, public: false, ports: [], createdAt: new Date().toISOString() };
    this.writeMeta(meta);
    return { name, status: "running" };
  }

  async list(name?: string): Promise<ProviderVm[]> {
    const out: ProviderVm[] = [];
    for (const entry of readdirSync(this.root).sort()) {
      if (name !== undefined && entry !== name) continue;
      if (!statSync(join(this.root, entry)).isDirectory()) continue;
      // A name outside the hostname grammar cannot be a box this driver made,
      // and reporting it would abort reap: `destroy` re-validates and throws, so
      // one stray directory would stop the fleet-wide reaper.
      if (!RUN_ID_RE.test(entry) || entry.length > 63) continue;
      let meta: BoxMeta;
      try {
        meta = this.readMeta(entry);
      } catch {
        // A crash between mkdir and writeMeta leaves a box with no metadata.
        // Reporting it (rather than skipping) is what keeps it reapable — an
        // invisible box is the driver-side twin of a dropped run record.
        out.push({ name: entry, status: "unknown" });
        continue;
      }
      out.push({
        name: meta.name,
        status: "running",
        ...(meta.ports.length > 0 ? { httpsUrl: fakeUrl(meta.name, meta.ports[0] as number) } : {}),
      });
    }
    return out;
  }

  /** Idempotent: teardown and reap both retry, and a missing box is the goal state. */
  async destroy(vm: string): Promise<void> {
    for (const proc of this.execChildren.get(vm) ?? []) proc.kill();
    this.execChildren.delete(vm);
    rmSync(this.boxDir(vm), { recursive: true, force: true });
  }

  async expose(vm: string, port: number): Promise<string> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid port: ${port}`);
    }
    const meta = this.readMeta(vm);
    if (!meta.ports.includes(port)) meta.ports.push(port);
    this.writeMeta(meta);
    return fakeUrl(vm, port);
  }

  async setPublic(vm: string): Promise<void> {
    const meta = this.readMeta(vm);
    meta.public = true;
    this.writeMeta(meta);
  }

  async whoami(): Promise<string> {
    return process.env.QDS_FAKE_DRIVER_USER ?? "fake-operator";
  }

  async exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult> {
    if (argv.length === 0) throw new Error("exec requires a non-empty argv");
    const cwd = this.boxDir(vm);
    this.readMeta(vm); // assert the box exists before spawning anything
    const proc = Bun.spawn({
      cmd: argv,
      cwd,
      // Bun.spawn's default env is a snapshot taken at process start, not a
      // live view of `process.env` — without this, a test (or a future
      // caller) that sets `process.env.X` at runtime would see it silently
      // dropped, unlike a real remote exec, which always reflects the
      // current call's environment.
      env: process.env,
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const children = this.execChildren.get(vm) ?? new Set<{ kill: () => void }>();
    children.add(proc);
    this.execChildren.set(vm, children);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    } finally {
      children.delete(proc);
      if (children.size === 0) this.execChildren.delete(vm);
    }
  }

  /** Box → host only. Nothing in this interface pushes a file into a box. */
  async copyFile(vm: string, remotePath: string, localPath: string): Promise<void> {
    const box = realpathSync(this.boxDir(vm));
    // realpath, not resolve: the workload runs inside this directory and can
    // plant a symlink pointing anywhere on the host. A textual `..` check alone
    // would copy the target straight out.
    const src = realpathSync(resolve(box, remotePath));
    const rel = relative(box, src);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`remote path escapes the box: ${remotePath}`);
    }
    copyFileSync(src, localPath);
  }
}

function fakeUrl(vm: string, port: number): string {
  return `https://${vm}-${port}.fake.local`;
}
