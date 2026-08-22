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

import { rmSync } from "node:fs";
import type { RunRecord, RunRecordStore } from "./run-record.ts";
import { assertValidRunId } from "./run-record.ts";
import { checkHeadroom, HeadroomRefusedError, loadQuotaLimits } from "./quota.ts";
import { CostLedger } from "./cost-ledger.ts";
import { assertWithinBudget } from "./budget-gate.ts";
import { withTimeout } from "./timeout.ts";

/**
 * Create-time provenance marker (DF2.6 D1): every factory-provisioned VM is
 * tagged with this, and the reaper never destroys a shape-matching VM that
 * lacks it. Charset-safe for substrates that interpolate the tag into a
 * `--tag` flag.
 */
export const SBX_OWNERSHIP_TAG = "qds-sbx";

/**
 * A provisioning refusal, in the shape this cluster's refusals already take
 * (`TeardownError`, `CredentialLifecycleError`): a machine-readable `code` plus
 * the literal next command. Callers classify on those two fields and never on
 * message text — the fleet CLI's failure payload reads `code` and `remediation`
 * off exactly this shape (`providerCodePayload`/`errorRemediation` in
 * `src/fleet/dispatch.ts`), so a bare `Error` reaches an operator as an
 * unclassified exit-1 "provisioning failed" naming no cause.
 */
export class ProvisionRefusedError extends Error {
  /** Machine-readable failure class; also the `code` in every log line. */
  readonly code: string;
  /** The literal next command, secrets referenced by env-var NAME, never expanded. */
  readonly remediation: string;

  constructor(code: string, message: string, remediation: string) {
    super(message);
    this.name = "ProvisionRefusedError";
    this.code = code;
    this.remediation = remediation;
  }
}

/**
 * Per-call provider budget for the provisioning sequence — the same 60s the
 * DF2.6 reaper gives each of its per-unit provider ops. A bare `await` on a
 * provider API that never answers hangs the whole dispatch: the record stays
 * open and the issue's ledger reservation keeps counting against its cap
 * indefinitely, which the orphan guard cannot undo (the record RESOLVES).
 */
const PROVISION_ACTION_TIMEOUT_MS = 60_000;

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

/** DF2.8 budget-admission facts, as they land on the record's budget extension. */
export interface AdmittedBudget {
  repoSlug: string;
  issueId: string;
  capMicroUsd: number;
  spentMicroUsd: number;
  reservedMicroUsd: number;
  admittedCeilingMicroUsd: number;
}

export interface ProvisionedRun {
  record: RunRecord;
  vm: ProviderVm;
  httpsUrl?: string;
}

/** `provisionAdmittedRun`'s inputs — named, like `CreateRunOptions` above. */
export interface ProvisionAdmittedRunOptions {
  runId: string;
  /** When set, the box is exposed on this port and made public after create. */
  port?: number;
  /**
   * The admission this provisioning is spending. Written to the record's
   * `extensions.budget` before `driver.create`, because that attribution is
   * what lets teardown price the run's box hours — and a priced row is the
   * ONLY thing that retires the reservation this admission holds against the
   * issue's cap (see the failure paths below).
   */
  budget?: AdmittedBudget;
  /**
   * Per-provider-call budget, defaulting to `PROVISION_ACTION_TIMEOUT_MS`.
   * Injectable for the same reason `checkHeadroom`'s `listTimeoutMs` and the
   * reaper sweep's `actionTimeoutMs` are: a hung-provider test cannot afford to
   * wait out the production value.
   */
  actionTimeoutMs?: number;
}

/**
 * The post-admission provisioning sequence — INV-1's single owner: **record →
 * VM**. (No key is minted here: DF2.3's credential delivery is a separate
 * step the callers run after this returns, so "record before anything
 * billable" is the whole of what this function owns.)
 *
 * The run record is written to the host before any driver call that can create
 * billable infrastructure, and `driver.create()` is unreachable from here
 * without an open record id. A failed create therefore orphans nothing worse
 * than an open record; a crash after it leaves teardown a handle. The reverse
 * ordering — VM first — is the defect this invariant exists to prevent (a
 * failed VM after a mint orphans a key that spends money invisibly).
 *
 * **Admission is the CALLER's responsibility.** This function runs no headroom
 * gate, no budget gate and no fleet-side rate check — deliberately, because
 * each caller owns a different one: `createRun` (below) runs the DF2.6
 * headroom check plus the DF2.8 budget gate, and the fleet dispatcher
 * (`src/fleet/dispatch.ts`) runs its own admission before it calls here. Both
 * compose this function *after* their gates, so the record-before-VM
 * invariant has exactly one implementation to change. The only gate here is
 * the run-id and port grammar, which every path needs regardless.
 */
export async function provisionAdmittedRun(
  driver: ProviderDriver,
  store: RunRecordStore,
  opts: ProvisionAdmittedRunOptions,
): Promise<ProvisionedRun> {
  // Before the record exists: the id becomes both the filename and the box
  // name, so a malformed one must never reach either. `store.create` would
  // catch it too, but this is exported public API — refuse at the boundary.
  assertValidRunId(opts.runId);
  // `!== undefined` alone admits `0`, which is not a port but is persisted as
  // one; expose it and the record carries a `ports: [0]` no verb can act on.
  if (
    opts.port !== undefined &&
    (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65_535)
  ) {
    throw new ProvisionRefusedError(
      "invalid-port",
      `invalid port: ${JSON.stringify(opts.port)} (must be an integer 1-65535)`,
      "pass a port in 1-65535, or omit it to leave the box unexposed",
    );
  }
  // Record first. If this throws (EEXIST, bad id) no box is ever created.
  store.create(opts.runId);
  if (opts.budget !== undefined) {
    // The store writes one field set per call, so the cap cannot land in the
    // same write as the record itself — `create` takes an id and a clock, not a
    // patch. That leaves a window, and a failure inside it (EIO, or `withLock`
    // timing out) used to be re-thrown with the record left OPEN and BUDGETLESS,
    // which is the one shape nothing can clean up:
    //
    //  - the record RESOLVES through `readRunRecord`, so the ledger's orphan
    //    guard never expires the admission (it expires only an admission whose
    //    run record does not resolve at all);
    //  - it carries no `extensions.budget`, so teardown's
    //    `ingestBoxHoursIfAttributed` writes no priced row — and a priced
    //    `cost_event` is the ONLY thing that retires a reservation.
    //
    // The issue's cap was therefore permanently reduced with no automated route
    // back. So the record is REMOVED here, restoring exactly the state the
    // orphan guard does handle (store.create failed ⇒ no record ⇒ the
    // reservation stops counting after ADMISSION_GRACE_MS). Closing it instead
    // does not work — a closed record resolves just as well as an open one.
    //
    // Removal is safe only because of where this sits: `store.create`'s O_EXCL
    // just won this id (no other writer owns the file), and nothing billable
    // exists yet — `driver.create` is below. The id becomes mintable again,
    // which is correct: this run never happened.
    try {
      store.set(opts.runId, {
        extensions: {
          budget: {
            repoSlug: opts.budget.repoSlug,
            issueId: opts.budget.issueId,
            capMicroUsd: opts.budget.capMicroUsd,
            spentMicroUsd: opts.budget.spentMicroUsd,
            reservedMicroUsd: opts.budget.reservedMicroUsd,
            admittedCeilingMicroUsd: opts.budget.admittedCeilingMicroUsd,
          },
        },
      });
    } catch (e) {
      try {
        rmSync(store.path(opts.runId), { force: true });
      } catch {
        // `force` swallows ENOENT only; an EACCES/EIO removal failure must not
        // REPLACE the write failure the caller has to see and act on. The
        // record then survives budgetless — the state this catch exists to
        // avoid — but naming the wrong cause helps nobody diagnose it.
      }
      throw e;
    }
  }
  // D1: every factory-provisioned VM carries the canonical ownership tag —
  // not caller-displaceable. A custom tag would make a factory box classify
  // `foreign` in the DF2.6 reaper (tag !== SBX_OWNERSHIP_TAG ⇒ reported,
  // never destroyed), i.e. an unreapable leak by construction. Callers with
  // extra metadata to attach belong in the run record, not the VM tag.
  // A failed create is re-thrown with the record left OPEN, and deliberately so.
  // This used to close it, on the reasoning that an open record "claims" a box
  // the reaper would otherwise reclaim. Two things make that the wrong trade:
  //
  //  - A closed record does not retire the admission. The ledger's orphan guard
  //    expires a reservation only when the record does not RESOLVE (readRunRecord
  //    → undefined, i.e. store.create itself failed); a closed record resolves
  //    fine, so the reservation kept counting against the issue's cap forever.
  //    Retirement needs a priced `cost_event`, which only teardown writes, from
  //    the `extensions.budget` written above — and the reaper routes an aged
  //    OPEN record through `teardownSandbox`, while a closed record with no box
  //    it skips entirely (`closed ⇒ nothing to claim`).
  //  - If create DID stand a box up before throwing, an open record keeps that
  //    box reachable by run id: the aged-record sweep tears it down through the
  //    same path, which harvests, destroys and prices it. Closing sent it down
  //    the `leaked-vm` arm instead — a bare destroy, no box-hours row, spend
  //    unaccounted.
  //
  // Nothing is destroyed here either way: reclamation is DF2.6's, and a destroy
  // on this path would race the very create that just failed.
  //
  // Bounded, like every other provider call in DF2.6 (`quota.ts`'s enumeration,
  // the reaper's per-unit ops). A create that never answers held the dispatch
  // open forever with the reservation counted against the cap; a create that
  // TIMES OUT may still have stood a box up, and the open record is the handle
  // to it — `teardownRun` falls back to the run id, which is what the box is
  // named after.
  const actionTimeoutMs = opts.actionTimeoutMs ?? PROVISION_ACTION_TIMEOUT_MS;
  const vm: ProviderVm = await withTimeout(
    driver.create(opts.runId, SBX_OWNERSHIP_TAG),
    actionTimeoutMs,
    `driver.create(${opts.runId})`,
  );
  // vmName BEFORE expose/setPublic. Both can throw against a box that is
  // already live and already billing; until the name is on the record the
  // only handle to it is `teardownRun`'s runId fallback, which holds only
  // while the box happens to be named after the run.
  let record = store.set(opts.runId, {
    vmName: vm.name,
    ...(vm.httpsUrl === undefined ? {} : { httpsUrl: vm.httpsUrl }),
  });
  let httpsUrl = vm.httpsUrl;
  if (opts.port !== undefined) {
    // `?? httpsUrl`: the seam types `expose` as `Promise<string>`, but a driver
    // that resolves nothing has established no URL — and the assignment used to
    // make the RETURNED `httpsUrl` undefined while the RECORD kept the one
    // `create` reported (the conditional spread below skips undefined, and the
    // store has no way to unset a field). A caller then read no URL off
    // `result.httpsUrl` and a URL off `result.record.httpsUrl`. Both keep the
    // create-time value instead: "clear both" is not available, so they agree
    // on the only value either of them can hold.
    const exposed: string | undefined = await withTimeout(
      driver.expose(vm.name, opts.port),
      actionTimeoutMs,
      `driver.expose(${vm.name}:${opts.port})`,
    );
    httpsUrl = exposed ?? httpsUrl;
    // Persisted BEFORE setPublic, by the same reasoning as vmName above:
    // setPublic can throw against a box that is already exposed and already
    // billing, and until the URL and port are on the record nothing but the
    // provider knows what the box is reachable on.
    //
    // Conditional spread, matching the first `store.set` above. `setLocked`
    // does skip an explicitly-undefined value rather than validating it, so
    // this is belt-and-braces — but the shape must not diverge between the two
    // writes, or the next reader has to go and check which one is load-bearing.
    record = store.set(opts.runId, {
      ports: [opts.port],
      ...(httpsUrl === undefined ? {} : { httpsUrl }),
    });
    await withTimeout(driver.setPublic(vm.name), actionTimeoutMs, `driver.setPublic(${vm.name})`);
  }
  return { record, vm, ...(httpsUrl === undefined ? {} : { httpsUrl }) };
}

/**
 * AC7: DF2.8's budget gate has exactly ONE production caller — the fleet
 * dispatcher, which admits and then composes `provisionAdmittedRun` directly.
 * `createRun`'s own gate call below is a SECOND live admission call site, and it
 * is dormant only because the one caller it has left (`scripts/cap-hit-demo.ts`)
 * omits `opts.issue`. Any future caller that passed one — after admitting, as
 * dispatch does — would book the same issue against the same cap twice, with
 * nothing in the type system and no failing test to catch it.
 *
 * Refused at the entry point rather than deleted: `opts.issue` stays on
 * `CreateRunOptions` so a caller that passes it is TOLD where admission lives
 * instead of having it silently ignored (which would provision a run with no
 * budget attribution at all — the unpriced-teardown shape). Called as a plain
 * function, not an `asserts`, deliberately: narrowing `opts.issue` to
 * `undefined` here would make the gate below uncompilable, and the point is to
 * keep that code intact and one line away from re-enabling.
 */
function assertAdmissionNotDelegated(opts: CreateRunOptions): void {
  if (opts.issue === undefined) return;
  throw new ProvisionRefusedError(
    "admission-not-here",
    `createRun does not run the budget gate (issue ${opts.issue.repoSlug}#${opts.issue.issueId}): admission belongs to the caller, and running it here would book the issue's cap a second time`,
    "admit once, then provision: assertWithinBudget(ledger, …) followed by provisionAdmittedRun(driver, store, {runId, budget}) — see src/fleet/dispatch.ts",
  );
}

/**
 * Lifecycle verb `create` — INV-1: **record → VM → key** (the sequence itself
 * lives in `provisionAdmittedRun` above; this function owns the gates).
 */
export async function createRun(
  driver: ProviderDriver,
  store: RunRecordStore,
  opts: CreateRunOptions,
): Promise<RunRecord> {
  // Before any provider work: a delegated admission is refused, not performed.
  assertAdmissionNotDelegated(opts);
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
  return (
    await provisionAdmittedRun(driver, store, {
      runId: opts.runId,
      ...(opts.port === undefined ? {} : { port: opts.port }),
      ...(admitted === undefined
        ? {}
        : {
            budget: {
              repoSlug: admitted.repoSlug,
              issueId: admitted.issueId,
              capMicroUsd: admitted.decision.capMicroUsd,
              spentMicroUsd: admitted.decision.spentMicroUsd,
              reservedMicroUsd: admitted.decision.reservedMicroUsd,
              admittedCeilingMicroUsd: admitted.decision.admittedCeilingMicroUsd,
            },
          }),
    })
  ).record;
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
  //
  // The claim set is only usable if it is COMPLETE. `store.list()` logs-and-skips
  // a `.json` whose stem fails the id grammar (INV-4's one exception, so that one
  // bad filename cannot take `fleet status` and the record sweep down with it) —
  // but a skipped file can hold an OPEN record naming a live box, and a box
  // missing from `claimed` is a box this function destroys. The old throw was
  // fail-safe here; the skip is fail-OPEN, so the completeness has to be proven
  // on this side.
  //
  // `listWithAnomalies`, not `list`: the skipped filenames are the whole point
  // here, and they are what the refusal names for the operator.
  const vms = await driver.list();
  const listing = store.listWithAnomalies();
  if (listing.skipped.length > 0) {
    throw new Error(
      `refusing to reap: ${listing.skipped.length} run record file(s) in ${store.dir} were skipped by the record listing (${listing.skipped.join(", ")}), so no box can be proven unclaimed — rename or move them, then re-run`,
    );
  }
  const claimed = new Set<string>();
  for (const rec of listing.records) {
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
