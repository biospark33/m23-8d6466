/**
 * The provider seam (DF2.1).
 *
 * The fleet dispatcher never talks to a substrate directly: it resolves a named
 * driver from `src/providers/index.ts` and every box operation crosses this one
 * interface. R4 §3.5 measured inkwell's entire exe.dev surface at six
 * control-plane command shapes plus generic ssh/scp, so the seam is deliberately
 * small — provider-specific primitives only.
 *
 * The seven lifecycle verbs (create, fill, setup, execute, observe, teardown,
 * reap) are HOST-SIDE functions composed over those primitives, not driver
 * methods. Adding a driver never means writing seven more verbs; only
 * `createRun`, `teardownRun` and `reapRuns` touch provider-specific primitives at
 * all, and they do it through this interface.
 */

import type { RunRecord, RunRecordStore } from "./run-record.ts";
import { checkHeadroom, HeadroomRefusedError, loadQuotaLimits } from "./quota.ts";
import { CostLedger } from "./cost-ledger.ts";
import { assertWithinBudget } from "./budget-gate.ts";

/**
 * Create-time provenance marker (DF2.6 D1): every factory-provisioned VM is
 * tagged with this, and the reaper never destroys a shape-matching VM that
 * lacks it. Charset-safe for substrates that interpolate the tag into a
 * `--tag` flag.
 */
export const SBX_OWNERSHIP_TAG = "qds-sbx";

export interface ProviderVm {
  /** Box name — also the public hostname, hence the run-id grammar. */
  name: string;
  /** Public URL once the box is exposed, when the substrate reports one. */
  httpsUrl?: string;
  status?: string;
  /**
   * Ownership provenance (`SBX_OWNERSHIP_TAG` on factory-created boxes).
   * Optional by necessity: exedev's `ls --json` reports no tag field
   * (3-origin verified), so shape-matching exedev VMs classify `foreign` in
   * the DF2.6 reaper — fail-safe, never destroyed.
   */
  tag?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * The eight provider primitives. Everything above this interface is
 * substrate-independent by construction.
 *
 * `copyFile` is **box → host only**. Nothing pushes a file into a box — that is
 * why DF2.3's credential arrives on `exec` stdin.
 *
 * Termination contract (DF2.4): `exec` boundedness is per-driver. ExeDevDriver
 * enforces a transport-level timeout + SIGKILL on the ssh child (`execTimed`
 * carries a per-call budget), so its execs settle on their own. FakeDriver's
 * exec has NO ceiling of its own: it stays pending until the child's process
 * group exits or a `destroy()` kills it. FakeDriver's destroy SIGKILLs every
 * exec's whole process group (descendants included), which also settles its
 * in-flight execs — a killed live exec exits 137; an exec pending over an
 * already-exited leader (a descendant holds its pipe) settles with the
 * leader's own exit code — but that destroy-settles-execs guarantee is
 * per-driver, not a seam-wide promise. As of DF2.4 the concrete split:
 * FakeDriver upholds it (group kill closes the pipes); ExeDevDriver does NOT
 * signal exec children from destroy — its destroy is a control-plane `rm` of
 * the box, its execs settle on their own transport timeout (the box's death
 * cutting the ssh connection only incidentally helps), so a caller awaiting
 * an exec that can remain pending after destroy must bound that wait itself
 * (see cap-hit-demo's `cancelGraceMs` races).
 */
export interface ProviderDriver {
  /** Registry name, e.g. `"fake"`, `"exe"`. */
  readonly name: string;
  create(name: string, tag?: string): Promise<ProviderVm>;
  list(name?: string): Promise<ProviderVm[]>;
  /** Idempotent (teardown and reap both retry; a missing box is the goal
   * state). Kills the box's processes — FakeDriver kills each exec's whole
   * process group, settling its in-flight execs; whether OTHER drivers'
   * execs settle is per-driver — bound any post-destroy exec await (see
   * interface docs). */
  destroy(vm: string): Promise<void>;
  expose(vm: string, port: number): Promise<string>;
  setPublic(vm: string): Promise<void>;
  whoami(): Promise<string>;
  exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult>;
  copyFile(vm: string, remotePath: string, localPath: string): Promise<void>;
}

/** A file to place inside the box during `fill`. */
export interface BoxFile {
  path: string;
  content: string;
}

export interface CreateRunOptions {
  runId: string;
  /** When set, the box is exposed on this port and made public after create. */
  port?: number;
  /**
   * DF2.8: the operator-supplied issue ref that authorizes the spend. When
   * present, `createRun` runs the budget gate (INV-COST-3) — an issue at or
   * over its cap refuses BEFORE the record, the box and the key exist, and the
   * admission decision (including the clamped mint ceiling) lands on the
   * record's `extensions.budget`. Absent ⇒ no budget accounting, exactly the
   * pre-DF2.8 behavior (P1.2 automates issue intake; DF3.1 supplies this).
   */
  issue?: {
    repoSlug: string;
    issueId: string;
    requestId?: string;
  };
}

/**
 * Lifecycle verb `create` — INV-1: **record → VM → key**.
 *
 * The run record is written to the host before any driver call that can create
 * billable infrastructure, and `driver.create()` is unreachable from here
 * without an open record id. A failed create therefore orphans nothing worse
 * than an open record; a crash after it leaves teardown a handle. The reverse
 * ordering — VM or key first — is the defect this invariant exists to prevent
 * (a failed VM after a mint orphans a key that spends money invisibly).
 */
export async function createRun(
  driver: ProviderDriver,
  store: RunRecordStore,
  opts: CreateRunOptions,
): Promise<RunRecord> {
  // DF2.6: read-only headroom gate FIRST — a refusal lands before store.create
  // and driver.create, so a refused create leaves zero boxes and zero records.
  // checkHeadroom is a read, not a lock; the ceiling is a backstop, not
  // admission control. An unenumerable VM list refuses (never full headroom
  // from an uncounted population); a broken limits file refuses here too.
  const headroom = await checkHeadroom(driver, 1, loadQuotaLimits());
  if (!headroom.allowed) throw new HeadroomRefusedError(headroom);
  // DF2.8: the budget gate (INV-COST-3) runs beside the headroom gate — an
  // over-cap issue refuses with zero records, zero boxes and zero keys, and
  // the serialized admission reserves the clamped ceiling so a concurrent
  // dispatch cannot both-win the read-compare race (R2 §6). An unopenable
  // ledger refuses here too (INV-COST-6) — never read as zero spend.
  let admitted:
    | { decision: ReturnType<typeof assertWithinBudget>; repoSlug: string; issueId: string }
    | undefined;
  if (opts.issue !== undefined) {
    const issue = opts.issue;
    const ledger = new CostLedger({
      // ENOENT → undefined so the gate's orphan-admission expiry can see a run
      // whose store.create failed (its reservation must stop counting); every
      // other read failure propagates and refuses the dispatch — the same
      // typed-code classification harvest.ts getRecord applies, never message
      // text.
      readRunRecord: (id) => {
        try {
          return store.get(id);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw e;
        }
      },
    });
    try {
      admitted = {
        decision: assertWithinBudget(ledger, {
          repoSlug: issue.repoSlug,
          issueId: issue.issueId,
          runId: opts.runId,
          requestId: issue.requestId ?? `gate-${opts.runId}`,
        }),
        repoSlug: issue.repoSlug,
        issueId: issue.issueId,
      };
    } finally {
      try {
        ledger.close();
      } catch {
        // A close failure must not mask the gate's own error; the WAL handle dies with the process.
      }
    }
  }
  // Record first. If this throws (EEXIST, bad id) no box is ever created.
  store.create(opts.runId);
  if (admitted !== undefined) {
    store.set(opts.runId, {
      extensions: {
        budget: {
          repoSlug: admitted.repoSlug,
          issueId: admitted.issueId,
          capMicroUsd: admitted.decision.capMicroUsd,
          spentMicroUsd: admitted.decision.spentMicroUsd,
          reservedMicroUsd: admitted.decision.reservedMicroUsd,
          admittedCeilingMicroUsd: admitted.decision.admittedCeilingMicroUsd,
        },
      },
    });
  }
  // D1: every factory-provisioned VM carries the canonical ownership tag —
  // not caller-displaceable. A custom tag would make a factory box classify
  // `foreign` in the DF2.6 reaper (tag !== SBX_OWNERSHIP_TAG ⇒ reported,
  // never destroyed), i.e. an unreapable leak by construction. Callers with
  // extra metadata to attach belong in the run record, not the VM tag.
  const vm = await driver.create(opts.runId, SBX_OWNERSHIP_TAG);
  let httpsUrl = vm.httpsUrl;
  if (opts.port !== undefined) {
    httpsUrl = await driver.expose(vm.name, opts.port);
    await driver.setPublic(vm.name);
  }
  return store.set(opts.runId, {
    vmName: vm.name,
    ...(httpsUrl === undefined ? {} : { httpsUrl }),
    ...(opts.port === undefined ? {} : { ports: [opts.port] }),
  });
}

/**
 * Lifecycle verb `fill` — place files inside the box. Substrate-independent:
 * `copyFile` is box → host only, so content arrives on `exec` stdin.
 */
export async function fillRun(driver: ProviderDriver, vm: string, files: readonly BoxFile[]): Promise<void> {
  for (const file of files) {
    // Quoting "$1" in the shell command only stops word-splitting; it does not
    // stop the path itself from resolving outside the box. Reject that here.
    if (file.path.startsWith("/") || file.path.split("/").includes("..")) {
      throw new Error(`fill path escapes the box: ${file.path}`);
    }
    // A textual ".." check does not stop a symlink already inside the box (the
    // workload's own earlier steps can plant one) from redirecting a directory
    // create or the final write outside the box. `sh` cannot close this: a
    // check-then-open sequence expressed in shell (lstat a component, then
    // later re-resolve the whole path text to open it) always leaves a gap a
    // concurrent workload process can win by swapping a checked component for
    // a symlink before the open happens — `set -C` only makes the *last*
    // path component atomic, not the parent components the kernel walks to
    // get there. FILL_SCRIPT hands the traversal to Python's `os.open`/`os.mkdir`
    // with `dir_fd=`: each step is a single `openat`/`mkdirat` syscall with
    // `O_NOFOLLOW` relative to a directory fd already held from the previous
    // step, so there is no separate check step to race — the refusal and the
    // use happen atomically in the kernel, and a fd, once open, is immune to
    // its parent's name for it being renamed or replaced out from under it.
    const res = await driver.exec(vm, ["sh", "-c", FILL_SCRIPT, "sh", FILL_PY, file.path], file.content);
    if (res.exitCode !== 0) {
      throw new Error(`fill failed for ${file.path} (exit ${res.exitCode}): ${res.stderr.trim()}`);
    }
  }
}

/**
 * Descriptor-based traversal: opens/creates every directory component with
 * `dir_fd=` relative to the *previous* held directory fd, `O_NOFOLLOW` on
 * every step, and opens the final target with `O_CREAT|O_EXCL|O_NOFOLLOW`.
 * `os.open`/`os.mkdir` with `dir_fd` compile to a single `openat`/`mkdirat`
 * syscall — the symlink refusal and the traversal happen in the same kernel
 * call, so there is no window between "checked" and "used" for a concurrent
 * process to win by swapping a component. Once a step's fd is open it refers
 * to the directory's inode, not its parent's name for it, so a rename/replace
 * of an already-traversed component's name cannot redirect where later
 * components (or the final write) land.
 *
 * `QDS_FILL_TEST_SYNC`, if set to a directory, is a test-only rendezvous: after
 * opening/holding the fd for each directory component, the script writes a
 * `ready.<component>` marker into that directory and busy-waits for a
 * matching `go.<component>` file before continuing. It exists so a test can
 * pause the traversal mid-flight and swap an *already-traversed* component's
 * name out from under it — the exact check-then-replace interleaving a
 * shell-only implementation cannot resist — and assert the write still lands
 * in the original directory. It is inert unless that env var is set.
 */
const FILL_PY = `
import os, sys, time

SYNC = os.environ.get("QDS_FILL_TEST_SYNC")

def _sync(tag):
    if not SYNC:
        return
    with open(SYNC + "/ready." + tag, "w") as f:
        f.write("1")
    deadline = time.monotonic() + 30
    while not os.path.exists(SYNC + "/go." + tag):
        if time.monotonic() > deadline:
            sys.stderr.write("fill test sync wait timed out: " + tag + "\\n")
            sys.exit(1)
        time.sleep(0.01)

p = sys.argv[1]
parts = [part for part in p.split("/") if part not in ("", ".")]
if not parts:
    sys.stderr.write("fill path is empty: " + p + "\\n")
    sys.exit(1)
name = parts[-1]
dirfd = os.open(".", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    for part in parts[:-1]:
        try:
            fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dirfd)
        except FileNotFoundError:
            os.mkdir(part, 0o700, dir_fd=dirfd)
            fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dirfd)
        os.close(dirfd)
        dirfd = fd
        _sync(part)
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dirfd)
    with os.fdopen(fd, "wb") as f:
        f.write(sys.stdin.buffer.read())
except (NotADirectoryError, FileExistsError) as e:
    sys.stderr.write("fill path traverses or collides with an existing entry: " + p + " (" + str(e) + ")\\n")
    sys.exit(1)
except OSError as e:
    sys.stderr.write("fill failed: " + p + " (" + str(e) + ")\\n")
    sys.exit(1)
finally:
    os.close(dirfd)
`.trim();

/**
 * Dependency probe + trampoline. \`sh\` is the only interpreter every driver's
 * box is guaranteed to have; the traversal itself needs real syscall control
 * \`sh\` cannot express (no openat/O_NOFOLLOW), so this hands off to
 * python3 — an in-box dependency this project already probes for elsewhere
 * (the exe.dev setup gate) — failing loudly with a named cause rather than
 * silently falling back to the unsafe path if it is missing. \`$1\`/\`$2\` are
 * separate argv elements (FILL_PY, then the path), never shell-interpolated,
 * so nothing in the Python source needs escaping.
 */
const FILL_SCRIPT = `
command -v python3 >/dev/null 2>&1 || { echo "fill requires python3 in the box (missing dependency)" >&2; exit 127; }
exec python3 -c "$1" "$2"
`.trim();

/** Lifecycle verb `setup` — run provisioning steps, failing loudly on the first bad one. */
export async function setupRun(driver: ProviderDriver, vm: string, steps: readonly string[][]): Promise<void> {
  for (const argv of steps) {
    const res = await driver.exec(vm, [...argv]);
    if (res.exitCode !== 0) {
      throw new Error(`setup step failed (exit ${res.exitCode}): ${argv.join(" ")}: ${res.stderr.trim()}`);
    }
  }
}

/** Lifecycle verb `execute` — run the workload. A non-zero exit is data, not an exception. */
export function executeRun(
  driver: ProviderDriver,
  vm: string,
  argv: readonly string[],
  stdin?: string,
): Promise<ExecResult> {
  return driver.exec(vm, [...argv], stdin);
}

/** Lifecycle verb `observe` — pull an artifact back out of the box (box → host). */
export function observeRun(
  driver: ProviderDriver,
  vm: string,
  remotePath: string,
  localPath: string,
): Promise<void> {
  return driver.copyFile(vm, remotePath, localPath);
}

/**
 * Lifecycle verb `teardown` — destroy the box named by the record, then close the
 * record. Destroy runs first: closing a record whose box is still alive would
 * hide it from `reapRuns`, which is exactly the unowned-spend case INV-4 exists
 * to prevent.
 */
export async function teardownRun(
  driver: ProviderDriver,
  store: RunRecordStore,
  runId: string,
): Promise<RunRecord> {
  const rec = store.get(runId);
  // Fall back to the run id: `createRun` names the box after it, so a crash
  // between `driver.create()` and the `set({vmName})` that follows leaves a live
  // box whose only handle is the record's own id. `destroy` is contractually
  // idempotent, so this is a no-op when no box was ever created.
  await driver.destroy(rec.vmName ?? runId);
  return store.close(runId);
}

/**
 * Lifecycle verb `reap` — destroy every box the substrate reports that no OPEN
 * record claims. A box belonging to a closed record is an orphan by definition:
 * teardown destroys before it closes, so a closed record plus a live box means
 * the destroy never landed.
 *
 * Returns the names destroyed.
 */
export async function reapRuns(driver: ProviderDriver, store: RunRecordStore): Promise<string[]> {
  // Claim by BOTH runId and vmName. `createRun` names the box after the run id,
  // so between `driver.create()` and the `set({vmName})` that follows it there is
  // a window where an open record has a live box and no vmName — claiming by
  // vmName alone would reap that live box, which is precisely the crash window
  // INV-1 exists to make survivable.
  //
  // The claim snapshot is taken AFTER `driver.list()`, not before: `driver.list()`
  // is itself awaited, and a concurrent `createRun` can open its record and stand
  // up its box inside that await window. A snapshot taken before `driver.list()`
  // would predate that record and reap the box out from under an in-flight
  // create. Reading the snapshot after guarantees every box `vms` reports was
  // either already claimed or has had a full record-write cycle to become
  // claimed by the time we check it.
  const vms = await driver.list();
  const claimed = new Set<string>();
  for (const rec of store.list()) {
    if (rec.closedAt !== undefined) continue;
    claimed.add(rec.runId);
    if (rec.vmName !== undefined) claimed.add(rec.vmName);
  }
  const destroyed: string[] = [];
  for (const vm of vms) {
    if (claimed.has(vm.name)) continue;
    await driver.destroy(vm.name);
    destroyed.push(vm.name);
  }
  return destroyed;
}
