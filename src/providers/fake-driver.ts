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
import { log, newRequestId } from "../swarmclaw/log.ts";
import { EXEC_MAX_OUTPUT_BYTES, readBounded } from "./bounded-exec.ts";
import type { ExecResult, ProviderDriver, ProviderVm, ProviderVmListing } from "./driver.ts";
import { assertExistingRunId, assertValidRunId } from "./run-record.ts";
import { ProviderError } from "./errors.ts";

export const DEFAULT_FAKE_BOXES_DIR = ".sandbox/fake-boxes";

/**
 * The error shape the driver CONTRACT means: machine `code` + literal next
 * command, matching `ExeDevDriverError`. Raw fs errors out of this driver
 * reached dispatch's classifier unclassified (`providerCodePayload` got
 * nothing, `errorRemediation` fell to its generic fallback) on every fake-path
 * failure — the exact shape `ProvisionRefusedError`/`ExeDevDriverError` exist
 * to prevent. Defined here rather than imported from the exedev layer: the
 * fake must not depend on a specific substrate's module.
 */
export class FakeDriverError extends ProviderError {
  constructor(code: string, message: string, remediation: string) {
    super(code, message, remediation);
    this.name = "FakeDriverError";
  }
}

interface BoxMeta {
  name: string;
  tag?: string;
  public: boolean;
  ports: number[];
  createdAt: string;
}

const META = ".box.json";

/**
 * A directory name from `readdirSync` rides log lines and skipped entries
 * verbatim, and a name carrying control characters (a stray tab, newline or
 * escape) would inject them into those sinks. Control characters are escaped
 * to visible `\uXXXX` form; ordinary names pass through byte-for-byte, so
 * every existing consumer of these strings still matches them unchanged.
 *
 * Beyond C0 and DEL the set covers the Unicode format/bidi/line-separator
 * categories (Cf, Zl, Zp): U+202E (RTL override) reorders everything printed
 * after it and U+200B (ZWSP) is invisible entirely, so an unescaped one rides
 * into a log line or refusal as invisible direction tampering — the same
 * shapes brief-schema's NO_CONTROL_CHARS doctrine bars at the record boundary.
 */
function displayName(entry: string): string {
  const controlChars =
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters IS the purpose
    /[\u0000-\u001f\u007f\u00ad\u0600-\u0605\u061c\u06dd\u070f\u08e2\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/g;
  return entry.replace(controlChars, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export class FakeDriver implements ProviderDriver {
  readonly name = "fake";
  readonly root: string;
  /**
   * Every exec's tree-kill closure per box. Destroy runs them: a real box
   * destroy kills the box's processes — the exec's whole process tree, not
   * just its direct child — and an exec abandoned by a caller (the demo's
   * fail-closed close paths) must not leave descendants running on the host
   * or keep its exec promise pending (a surviving descendant holds the stdout
   * pipe open, which is what keeps the `Response` read — and so the exec —
   * unsettled).
   *
   * Each closure is identity-gated on its leader's liveness (see `killTree`),
   * so a completed exec's retained entry is inert, and the entry is dropped
   * eagerly when the exec settles with its group already gone (the common
   * no-descendants case): a later destroy can never signal a process-group id
   * the OS has recycled.
   */
  private readonly execChildren = new Map<string, Set<() => void>>();

  /**
   * Resolves the boxes root and creates NOTHING. AC1 (story
   * df3-1-dispatcher-core-verbs.md:58-62): "Validation completes before the
   * first side effect" — and `resolveDriver("fake")` runs during dispatch
   * setup, before the brief is validated, so a mkdir here left a directory
   * behind on every brief that was about to exit 2. The root is created lazily
   * by `create()`, the only method that puts anything in it.
   */
  constructor(root?: string) {
    this.root = root ?? process.env.QDS_FAKE_BOXES_DIR ?? DEFAULT_FAKE_BOXES_DIR;
  }

  private boxDir(vm: string): string {
    // Box names are hostnames — the same grammar the run id obeys. Validating
    // here is what keeps `../evil` from escaping the boxes root.
    //
    // The LEGACY grammar on this shared path, and the strict one in `create`
    // below: a box an earlier build named `trailing-` must stay listable,
    // exposable and above all DESTROYABLE, or it is an unreapable leak that no
    // verb can touch. Path safety is identical — neither grammar admits `/`,
    // `.` or `..`.
    assertExistingRunId(vm);
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
      // Contract-shaped (code + remediation), not a bare Error: dispatch's
      // classifier reads those two fields off every driver rejection. The
      // MESSAGE keeps the historical `no such box: <vm>` prefix — harvest's
      // `isNoSuchBox` and teardown's box-gone skip both classify on that text,
      // so the marker must survive the reshape.
      throw new FakeDriverError(
        "no-such-box",
        `no such box: ${vm} (${(e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : String(e))})`,
        "the box is gone or its .box.json is unreadable — re-check the boxes root, or create the box again",
      );
    }
  }

  private writeMeta(meta: BoxMeta): void {
    writeFileSync(join(this.boxDir(meta.name), META), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
  }

  async create(name: string, tag?: string): Promise<ProviderVm> {
    // Strict at creation: no NEW box gets a name a real provider would refuse.
    assertValidRunId(name);
    const dir = this.boxDir(name);
    // The root is created HERE, not in the constructor (AC1) — the first side
    // effect belongs to the first box. Recursive, so it is idempotent.
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    // Non-recursive mkdir: a second create of the same box fails with EEXIST
    // rather than silently adopting someone else's box — and the failure is
    // contract-shaped, not a raw errno (same classifier reasoning as readMeta).
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        throw new FakeDriverError(
          "box-exists",
          `box ${name} already exists`,
          "a box by this name is already provisioned — destroy it first or use a different run id",
        );
      }
      throw e;
    }
    const meta: BoxMeta = { name, tag, public: false, ports: [], createdAt: new Date().toISOString() };
    this.writeMeta(meta);
    return { name, status: "running" };
  }

  async list(name?: string): Promise<ProviderVm[]> {
    return (await this.listWithAnomalies(name)).vms;
  }

  /**
   * `list()`, plus the directory names it refused to report. The log line
   * below is not enough on its own: `reapRuns` destroys every box its listing
   * does not account for, so a skipped directory is a live box that no verb
   * can reach and no operator is told about at the moment it matters. The
   * anomaly rides in the return value, and `reapRuns` refuses on it.
   */
  async listWithAnomalies(name?: string): Promise<ProviderVmListing> {
    const out: ProviderVm[] = [];
    const skipped: string[] = [];
    // ONE correlation id for the whole call: a per-anomaly id made the N stray
    // directories of a single `list()` look like N unrelated events, so nothing
    // could group them — and `list()` runs on every status poll, so that is the
    // line an operator sees most often.
    const requestId = newRequestId();
    // No root yet ⇒ no box was ever created ⇒ an empty population, not an
    // error. Only ENOENT: every other errno is a root that MIGHT hold boxes
    // and could not be read, which must propagate rather than report the
    // fleet empty to a reaper. (The root is created by `create`, not by the
    // constructor — AC1.)
    let entries: string[];
    try {
      entries = readdirSync(this.root).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return { vms: [], skipped: [] };
    }
    for (const entry of entries) {
      if (name !== undefined && entry !== name) continue;
      // `readdir` and `stat` are two calls, and the entry can stop being
      // stat-able between them: a concurrent `destroy` unlinks it (ENOENT), a
      // dangling symlink never had a target (ENOENT), a directory made
      // unreadable by hand refuses (EACCES), a failing mount errors (EIO). An
      // unguarded `statSync` threw all of those out of the WHOLE listing, so
      // one stray link took every box in the fleet out of `status` — and out of
      // `reapRuns`, which then had nothing to refuse on.
      //
      // ENOENT is not a box: nothing is there to reach, so it is logged and
      // dropped. Every other errno is an entry that MIGHT be a live box and
      // could not be read, so it rides out as an anomaly for `reapRuns` to
      // refuse on — the same fail-closed posture as the name filter below.
      let isDir: boolean;
      try {
        isDir = statSync(join(this.root, entry)).isDirectory();
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") skipped.push(displayName(entry));
        log({
          requestId,
          operation: "fake-driver.list.unstatable",
          agentId: null,
          timestamp: new Date().toISOString(),
          duration: 0,
          status: "error",
          error: {
            code: "unstatable_box_entry",
            message: `box directory could not be stat'ed: ${displayName(entry)} (${code ?? (e as Error).message})`,
          },
          driver: this.name,
          verb: "list",
          outcome: "skipped",
        });
        continue;
      }
      if (!isDir) continue;
      // A name outside the box grammar is a name this driver's own `destroy`
      // refuses (`boxDir` → `assertExistingRunId`), so reporting it as a box
      // hands `reapRuns` a handle that throws MID-sweep, after it has already
      // destroyed whatever came earlier in the listing.
      //
      // It rides out as an ANOMALY instead, and `reapRuns` refuses to reap at
      // all while `skipped` is non-empty: the fleet reaper stalls rather than
      // half-running, which is the accepted trade — an unreachable live box is
      // worse than a stalled reaper, and an invisible box is the driver-side
      // twin of a dropped run record. (This comment used to claim the entry was
      // dropped precisely so reap would not abort; that stopped being true when
      // the anomaly channel landed and the code below started reporting it.)
      //
      // The canonical PREDICATE, never a hand-rebuilt copy of it: sharing the
      // constants still left two expressions free to drift, and this filter has
      // to admit exactly what `boxDir` admits or it lists a name `destroy` then
      // refuses. `ExeDevDriver.listWithAnomalies` applies the same rule against
      // ITS destroy's grammar, so one input gets one classification across both
      // drivers instead of two opposite ones.
      //
      // The LEGACY grammar, matching `assertExistingRunId`: a `trailing-` box
      // was creatable by any earlier build, and `boxDir` still accepts it, so
      // filtering it here would hide a real, destroyable box from every fleet
      // listing.
      let nameOk = true;
      try {
        assertExistingRunId(entry);
      } catch {
        nameOk = false;
      }
      if (!nameOk) {
        skipped.push(displayName(entry));
        log({
          requestId,
          operation: "fake-driver.list.skipped",
          agentId: null,
          timestamp: new Date().toISOString(),
          duration: 0,
          status: "error",
          error: { code: "unlistable_box_name", message: `box directory is not a valid box name: ${displayName(entry)}` },
          driver: this.name,
          verb: "list",
          outcome: "skipped",
        });
        continue;
      }
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
        ...(meta.tag !== undefined ? { tag: meta.tag } : {}),
        ...(meta.ports.length > 0 ? { httpsUrl: fakeUrl(meta.name, meta.ports[0] as number) } : {}),
      });
    }
    return { vms: out, skipped };
  }

  /** Idempotent: teardown and reap both retry, and a missing box is the goal state. */
  async destroy(vm: string): Promise<void> {
    for (const killTree of this.execChildren.get(vm) ?? []) killTree();
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
    // MIRRORS ExeDevDriver's rule EXACTLY (driver.ts:1235 and :1249), and the
    // per-element half was missing here until DF1.10's first live tier-1 round.
    //
    // This fake checked only `length === 0`; the real driver ALSO rejects any
    // empty or whitespace-only element, because such an element ships a no-op
    // substring into the ssh command line (its rounds 6-7 hardening). So a call
    // site could pass `""` as a positional, satisfy every one of the 5154 unit
    // tests that run against this fake, and be refused by the real driver the
    // first time it touched a box — which is exactly what `pullArtifacts` did.
    // It cost a paid tier-1 round to find, and the cascade (artifacts fail →
    // `harvest_waived` teardown exits 6 → four more assertions on 0) made one
    // defect look like five.
    //
    // The point of tightening it HERE rather than only fixing that call site is
    // that a fake weaker than the thing it stands in for does not merely miss a
    // bug — it actively certifies it. Every existing test now guards this class
    // for free, and the next empty positional fails on a laptop in
    // milliseconds instead of on a box after spend.
    if (argv.length === 0 || argv.some((a) => a.length === 0 || a.trim().length === 0))
      throw new Error("exec requires a non-empty argv with no empty or whitespace-only elements");
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
      // The child becomes its own session and process-group leader
      // (pgid === pid), so `destroy` can kill the exec's WHOLE tree with
      // `kill(-pid)`. SIGKILL to the direct child alone would leave
      // grandchildren running — and any descendant still holding the stdout
      // pipe would keep this exec's `Promise.all` unsettled past the
      // destroy, exactly the pending-abandoned-exec case the demo's close
      // paths must not leak.
      detached: true,
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const kills = this.execChildren.get(vm) ?? new Set<() => void>();
    const kill = killTree(proc);
    kills.add(kill);
    this.execChildren.set(vm, kills);
    const [out, err, exitCode] = await Promise.all([
      readBounded(proc.stdout, EXEC_MAX_OUTPUT_BYTES, { kill, exited: proc.exited }),
      readBounded(proc.stderr, EXEC_MAX_OUTPUT_BYTES, { kill, exited: proc.exited }),
      proc.exited,
    ]);
    const stdout = out.text;
    const stderr = err.text;
    const truncated = out.truncated || err.truncated;
    // Eager prune: an exec that settled with its group already fully gone
    // (the no-descendants common case) drops its entry now, so a later
    // destroy finds nothing left to run for it. Signal 0 only ever removes
    // an entry (a group that is gone cannot come back); it never authorizes
    // a kill — see killTree's identity gate. A rejecting exec skips this and
    // keeps its entry: its leader may still be alive and destroyable.
    try {
      process.kill(-proc.pid, 0);
    } catch {
      kills.delete(kill);
      if (kills.size === 0) this.execChildren.delete(vm);
    }
    return { stdout, stderr, exitCode, ...(truncated ? { truncated: true } : {}) };
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

/**
 * Kill a whole exec tree: the process group on POSIX (the `detached` spawn
 * made the child its group leader, pgid === pid). Straight SIGKILL, not
 * SIGTERM→SIGKILL — a TERM-ignoring workload must not survive a box destroy
 * (the same call cli-anything's `killTree` makes). ESRCH on a dead group is
 * the goal state, never an error.
 *
 * Identity gate: `kill(-pgid)` is only safe while the pid provably still
 * belongs to this exec. Two provable windows, both anchored in how the kernel
 * hands out ids. While `exited` is unsettled the leader is unreaped, so it
 * OWNS the pid — the kernel cannot reuse the number — and `-pid` names this
 * exec's group and nothing else. After the leader is reaped the number stays
 * reserved for the group while ANY member lives: an orphaned process group
 * keeps its pgid, and a new group can only take the number through a new
 * leader PROCESS with that pid. So in the dead-leader case a positive-pid
 * probe decides — `kill(pid, 0)` answering (or refusing with EPERM: either
 * way a process owns it) means this exec's group is gone (recycled: never
 * signal `-pid`); ESRCH means no process owns it, so any group holding the
 * number is
 * provably this exec's orphaned group (`kill(-pgid, 0)` success alone could
 * never authorize that — it proves a group EXISTS with that id, not that it
 * is OURS). SIGKILLing that group is what lets destroy() settle an exec kept
 * pending by a descendant holding the pipe (`sh -c 'sleep 30 &'`). The
 * microseconds between the probe and the signal are the one residual window
 * (the group would have to empty and the pid fully recycle between two
 * adjacent syscalls) — strictly narrower than the leader-alive branch's own
 * accepted dead-but-unreaped window below.
 */
function killTree(proc: Bun.Subprocess): () => void {
  let leaderAlive = true;
  // exited settles only after waitpid reaps the child — resolution order
  // guarantees the flag never says alive for a reaped leader (it may briefly
  // say alive for a dead-but-unreaped one, during which -pid is still safe:
  // the pid is unowned for mere milliseconds and cannot have been recycled).
  proc.exited.then(
    () => {
      leaderAlive = false;
    },
    () => {
      leaderAlive = false;
    },
  );
  return () => {
    if (leaderAlive) {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        // group already gone
      }
      return;
    }
    // Dead leader, group maybe not: a surviving descendant keeps the number
    // reserved, and only the group signal can reach it.
    try {
      process.kill(proc.pid, 0);
      // A process owns the pid — it was recycled after this exec's group
      // emptied. Signalling -pid could hit an unrelated group; never do.
      return;
    } catch (e) {
      // Only ESRCH proves no process owns the number. EPERM means one does —
      // a process this caller may not signal, typically a privileged recycled
      // pid, possibly leading an unrelated group whose weaker members a group
      // SIGKILL could still reach. Not provably ours → never signal -pid.
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") return;
    }
    try {
      process.kill(-proc.pid, 0); // probe first: authorizes the SIGKILL
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // group already gone
    }
  };
}
