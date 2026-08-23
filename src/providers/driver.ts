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
import { assertExistingRunId, assertValidRunId } from "./run-record.ts";
import { redactSecrets } from "./step-log.ts";
import { checkHeadroom, HeadroomRefusedError, loadQuotaLimits } from "./quota.ts";
import { TimeoutError, withTimeout } from "./timeout.ts";

/**
 * Create-time provenance marker (DF2.6 D1): every factory-provisioned VM is
 * tagged with this, and the reaper never destroys a shape-matching VM that
 * lacks it. Charset-safe for substrates that interpolate the tag into a
 * `--tag` flag.
 */
export const SBX_OWNERSHIP_TAG = "qds-sbx";

/**
 * The generated run-id grammar (`<slug>-<YYYYMMDD>-<6 hex>`, run-record.ts
 * `newId`). A VM name outside it can never be a factory box.
 *
 * Lives HERE, not in reaper.ts where it was declared, because `reapRuns` below
 * needs the same test and driver.ts is the low module (reaper.ts already
 * imports this one; the reverse edge would be the cycle D4 exists to avoid).
 * Re-exported from reaper.ts so existing importers are unchanged.
 */
export const RUN_ID_SHAPE = /^[a-z0-9][a-z0-9-]*-\d{8}-[0-9a-f]{6}$/;

/**
 * Is this box provably ours? The ONE ownership test, shared by both reapers.
 *
 * Both halves are required and both fail SAFE. The name grammar alone is not
 * ownership — a stranger could name a box anything — and the tag alone is not
 * either, so a box is destroyable only when it carries the marker `create`
 * stamps on every factory box AND a name only `newId` produces.
 *
 * The consequence is deliberate and asymmetric: a box that IS ours but does not
 * prove it (created before the tag existed, or a fake box that crashed between
 * `mkdir` and its metadata write) is never destroyed here. It stays listed, so
 * `fleet status` still names it and an operator can tear it down by hand — a
 * stalled reap on a box we can still name is recoverable, and a destroyed
 * stranger's box is not.
 *
 * KNOWN BLOCKER — exedev cannot be auto-reaped. Its `ls --json` reports no tag
 * field at all (`ProviderVm.tag`, 3-origin verified), so nothing it lists can
 * pass this test and `reapRuns` destroys nothing there, ever. That is not a
 * regression: the DF2.6 sweep already classifies every exedev box `foreign` and
 * destroys none, so the two paths now agree. What would unblock it is a tag
 * channel in the exedev listing — `listWithAnomalies` populating `tag` from a
 * field the substrate actually returns — at which point factory boxes start
 * passing here with no change to this predicate. Until then exedev boxes are
 * reported and torn down by hand, and that is the deliberate direction: a box
 * left listed is recoverable, a destroyed stranger's box is not.
 */
export function isFactoryOwnedVm(vm: ProviderVm): boolean {
  return RUN_ID_SHAPE.test(vm.name) && vm.tag === SBX_OWNERSHIP_TAG;
}

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
 * What a provider listing reported, and what it refused to name — the
 * driver-side twin of `RunRecordListing` (run-record.ts), and for the same
 * reason: a skipped box is not an absent box, and a caller that cannot tell
 * the two apart fails OPEN.
 *
 * `reapRuns` destroys every box no OPEN record claims. A box the driver
 * dropped from `list()` — FakeDriver drops a directory whose name is outside
 * the box grammar, and logs it — is indistinguishable there from a box that
 * does not exist, so it is spend nobody can see and nobody can reap. A log
 * line cannot prevent that; a value in the return can.
 */
export interface ProviderVmListing {
  vms: ProviderVm[];
  /** Box identifiers the driver refused to report, in listing order. */
  skipped: string[];
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
  /**
   * `list()`, plus what it refused to name (see `ProviderVmListing`).
   *
   * OPTIONAL, because it is additive to a shipped seam and a driver that
   * skips nothing has nothing to report. Read it through `driverListing`
   * below, never directly — a driver without it answers "no anomalies", which
   * is honest only for a `list()` that cannot skip. A driver whose `list()`
   * DOES drop entries must implement this, or its drops stay invisible.
   */
  listWithAnomalies?(name?: string): Promise<ProviderVmListing>;
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
 * The driver listing plus its anomalies, for callers that must prove the box
 * population complete before acting on it. A driver that predates the channel
 * reports none — see `ProviderDriver.listWithAnomalies` for why that is a
 * claim only some drivers may make.
 */
export async function driverListing(driver: ProviderDriver, name?: string): Promise<ProviderVmListing> {
  if (driver.listWithAnomalies !== undefined) return driver.listWithAnomalies(name);
  // A driver with no anomaly channel has not proven its listing complete — it
  // has said nothing about completeness at all, and the two callers of this
  // helper (`reapRuns` below and the DF2.6 sweep) both DESTROY every box their
  // listing cannot match to an open record. The old `skipped: []` asserted a
  // completeness this function never observed, so a driver that simply never
  // implemented the method turned the fail-closed refusal back into a
  // fail-OPEN sweep — silently, and for every future driver by default. A
  // claim only some drivers may make is not a default; the unproven population
  // rides out as the anomaly it is, and the destructive callers refuse on it.
  return {
    vms: await driver.list(name),
    skipped: [`driver ${driver.name} has no listWithAnomalies(): its box listing cannot be proven complete`],
  };
}

/**
 * The ONE refusal for a box population that cannot be proven complete.
 *
 * `reapRuns` below and the DF2.6 sweep (`reaper.ts`) both reach a destructive
 * loop through `driverListing`, and both refuse on exactly this input. The
 * message and the remediation used to be hand-duplicated across the two files
 * with nothing keeping them aligned — same input, two different guidances.
 * This is the single source; `reaper.ts` re-wraps it in a `SweepError` (its own
 * `code` union is what the CLI classifies on) but carries these strings
 * verbatim.
 *
 * The remediation must be FOLLOWABLE: an entry here is not necessarily a box
 * with a name — exedev reports a row index plus whatever identifying fields the
 * row carried — so it points at the entry's own details rather than telling an
 * operator to rename a box that has no name.
 */
export function unverifiedVmListingRefusal(
  driverName: string,
  skipped: readonly string[],
): ProvisionRefusedError {
  return new ProvisionRefusedError(
    "reap-vms-unverified",
    // Redacted at the sink: `skipped` entries are provider-derived free text
    // (exedev rides raw row fields like `https_url`, which can embed a
    // `ghs_…` token), and this message reaches the CLI and the log lines.
    `refusing to reap: driver ${driverName} could not account for ${skipped.length} listing entr${skipped.length === 1 ? "y" : "ies"} (${redactSecrets(skipped.join("; "))}), so the box population cannot be proven complete`,
    "find each entry above from the identifying details it carries (for exedev: `ssh exe.dev ls --json`, match the row), then destroy or repair it by hand and re-run — an entry the driver cannot name is a live box no verb can reach",
  );
}

/**
 * The refusal for unclaimed boxes that cannot PROVE they are ours.
 *
 * `reapRuns` used to `continue` past these silently: a grammar-valid box with
 * no ownership tag was spared, and the caller saw only the (possibly empty)
 * destroyed list — so unreaped spend was invisible at the exact moment a
 * reaper ran. Sparing stays mandatory (never destroy on a guess), but it is no
 * longer silent: the sweep refuses, naming every spared candidate, which is
 * the same fail-closed shape as `unverifiedVmListingRefusal` above. The names
 * are grammar-checked by construction (`isFactoryOwnedVm`'s name half is the
 * strictest of them), so no redaction is needed here.
 */
export function unownedVmReapRefusal(driverName: string, spared: readonly string[]): ProvisionRefusedError {
  const n = spared.length;
  return new ProvisionRefusedError(
    "reap-vms-unowned",
    `refusing to reap: ${n} unclaimed box${n === 1 ? "" : "es"} cannot prove factory ownership (${spared.join(", ")}) — spared, not destroyed, but leaving them unsurfaced hid unreaped spend`,
    "inspect each box above (fleet status / provider ls), tear down or tag the ones that are ours, then re-run — a box without the ownership tag is never destroyed automatically",
  );
}

/**
 * One bounded provider call in the provisioning sequence, with the TIMEOUT
 * classified.
 *
 * `withTimeout` refuses with a `TimeoutError`, which carries no `code` and no
 * `remediation` — the exact unclassified shape `ProvisionRefusedError` exists
 * to prevent. The fleet CLI's failure payload reads `code` and `remediation`
 * off the thrown value (`providerCodePayload`/`errorRemediation` in
 * `src/fleet/dispatch.ts`), so a bare one reaches an operator as exit-1
 * "provisioning failed" naming no cause — while a box may be live, the record
 * is OPEN and the issue's reservation is still counting against its cap. That
 * is precisely the state an operator needs told, by name.
 *
 * The driver's OWN refusals pass through untouched: they already carry both
 * fields (`ExeDevDriverError`), and rewrapping them would replace the
 * substrate's diagnosis with ours.
 */
async function provisionStep<T>(
  p: Promise<T>,
  ms: number,
  what: string,
  code: string,
  remediation: string,
): Promise<T> {
  try {
    return await withTimeout(p, ms, what);
  } catch (e) {
    if (e instanceof TimeoutError) {
      throw new ProvisionRefusedError(
        code,
        `${e.message} — the call was ABANDONED, not cancelled: the provider may still have acted on it`,
        remediation,
      );
    }
    throw e;
  }
}

/**
 * Did a record write fail WITHOUT the writer ever holding the lock?
 *
 * `withLock` (run-record.ts) throws its timeout before it runs the write body,
 * and only when another owner still holds the lock — so this is the one
 * `store.set` failure that proves nothing of ours was written and someone else
 * may still write. Every other failure (EIO, ENOSPC, a schema rejection) is
 * raised from inside the lock, where this process is the only writer.
 *
 * The lock timeout is a bare `Error` with no `code` (verified at the throw
 * site: `withLock` raises plain `new Error(...)`, so `code` is undefined and
 * `name` is the default `"Error"`), which leaves the message as the only
 * discriminator reachable from here — run-record.ts's own tests already pin
 * that string, which is what makes it usable at all. If upstream rewords the
 * message this predicate silently stops matching and the rollback below takes
 * the destructive arm; keep the two in sync until then.
 * ponytail: message match; replace with `e.code === "lock-timeout"` the day
 * run-record.ts types that refusal.
 */
function isRecordLockTimeout(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith("timed out waiting for the run record lock:");
}

/**
 * An address, or nothing at all.
 *
 * The seam types `expose` as `Promise<string>`, but a driver that resolves `""`
 * has established no address — and `??` catches only null/undefined, so an
 * empty string used to overwrite the create-time URL, satisfy the "no address
 * recorded" refusal below (`""` is a string, and is not an address), and land
 * on the record as an `httpsUrl: ""` while every caller doing
 * `if (result.httpsUrl)` read it as absent. Empty is ABSENT at every site in
 * this sequence — the record, the refusal and the return value then agree on
 * one meaning. Whitespace-only is empty for the same reason: it is not an
 * address either.
 */
function address(url: string | undefined): string | undefined {
  return url !== undefined && url.trim().length > 0 ? url : undefined;
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
    //    `ingestBoxHoursIfAttributed` writes no priced row — so nothing prices
    //    this run. (The ledger's closedAt arm retires a CLOSED record's stale
    //    reservation too, but only once the close outlives its grace cutoff —
    //    see cost-ledger.ts.)
    //
    // So the record is REMOVED here rather than closed. Removal restores
    // exactly the state the orphan guard already handles (store.create failed
    // ⇒ no record ⇒ the reservation stops counting after ADMISSION_GRACE_MS),
    // it takes effect immediately instead of after the cutoff, and it frees
    // the id — this run never happened.
    //
    // Removal is safe only when the write failed with the lock in OUR hands:
    // nothing billable exists yet (`driver.create` is below) and no other
    // writer can be mid-`rename` on the file. The id becomes mintable again,
    // which is correct: this run never happened.
    //
    // The one cause that does NOT clear that bar is the lock TIMEOUT, and it is
    // the cause this comment used to name as typical. `withLock` throws it
    // BEFORE it runs the write, and it throws it precisely because someone else
    // holds the lock — a holder a timeout cannot prove dead. `store.create`'s
    // O_EXCL proves this process created the file; it proves nothing about who
    // is inside the lock now (an abandoned claim, a sibling thread, a
    // re-entrant writer). Removing it there deletes a file a live writer is
    // about to rename back into place: the record returns OPEN and budgetless
    // anyway — the exact state this rollback exists to avoid — and the id is
    // mintable in the meantime, so a second run can claim it. That cause is
    // refused loudly instead, with the record left where the operator (and the
    // holder) can still see it.
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
      if (isRecordLockTimeout(e)) {
        throw new ProvisionRefusedError(
          "budget-write-lock-timeout",
          `the budget attribution for run ${opts.runId} could not be written (${(e as Error).message}) — the record is OPEN and BUDGETLESS and was deliberately NOT removed: another writer holds its lock and would recreate it`,
          `find the writer holding ${store.path(opts.runId)} (its lock file names the pid); once none is running, remove the record by hand so ${opts.budget.repoSlug}#${opts.budget.issueId}'s reservation stops counting against its cap: rm ${store.path(opts.runId)}`,
        );
      }
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
  //  - The reservation behind this admission retires on a priced `cost_event`
  //    — which only teardown writes, from the `extensions.budget` above — or,
  //    since the ledger's closedAt arm, on a CLOSED record whose close outlives
  //    the grace cutoff. Closing would therefore free the cap EVENTUALLY, but
  //    it is still the wrong shape for a FAILED create: a freshly-closed,
  //    budgetless record keeps counting until the cutoff passes, and the reaper
  //    routes an aged OPEN record through `teardownSandbox` (which harvests,
  //    destroys AND prices), while a closed record's live box falls to the bare
  //    leaked-vm destroy with no box-hours row.
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
  const vm: ProviderVm = await provisionStep(
    driver.create(opts.runId, SBX_OWNERSHIP_TAG),
    actionTimeoutMs,
    `driver.create(${opts.runId})`,
    "provider-timeout-create",
    `check the provider for a box named ${opts.runId} before assuming nothing was created, then tear the run down: bun scripts/fleet.ts teardown ${opts.runId}`,
  );
  // The provider's returned name is the authoritative handle for everything
  // downstream — it is persisted as `vmName`, it is what `expose`/`setPublic`
  // are called against, and `reapRuns` puts it in the claim set — and it was
  // the only provider return in this sequence with no shape check. A driver
  // answering `{name: ""}` recorded an empty handle, called the provider
  // against `""`, and seeded the claim set with `""`: a live box no verb can
  // reach, which is the unowned-spend case INV-4 exists to prevent.
  //
  // `assertExistingRunId` is the canonical predicate every box-name path
  // already routes through (the LEGACY grammar, matching `FakeDriver.boxDir`
  // and `destroy` — a box an earlier build named `trailing-` must stay
  // destroyable), never a local copy of it. Its bare `Error` is reshaped into
  // the refusal shape this module's callers classify on. The name is NOT
  // required to equal the run id: a driver may legitimately name a box
  // something else, and the recorded `vmName` is what teardown and the reaper
  // then act on. What is required is that it be a name they CAN act on.
  try {
    assertExistingRunId(vm.name);
  } catch (e) {
    throw new ProvisionRefusedError(
      "create-name-invalid",
      `driver ${driver.name} created a box for run ${opts.runId} but reported an unusable name (${(e as Error).message}) — refusing to record a handle no verb can act on`,
      `check the provider for a box named ${opts.runId} before assuming nothing was created, then tear the run down: bun scripts/fleet.ts teardown ${opts.runId}`,
    );
  }
  // vmName AND the intended port BEFORE expose/setPublic. Every call below can
  // throw against a box that is already live and already billing; until the
  // name is on the record the only handle to it is `teardownRun`'s runId
  // fallback, which holds only while the box happens to be named after the run.
  //
  // The port rides along INTENDED, not confirmed, and that is the honest
  // record: `withTimeout` ABANDONS the expose call rather than cancelling it,
  // so a timed-out expose can still open the port afterwards. Written only
  // after the call, the record described a box with a name and no port — i.e.
  // not the box that exists. Written before, the worst case is a port recorded
  // for a box the provider never exposed, which teardown destroys either way.
  const createUrl = address(vm.httpsUrl);
  let record = store.set(opts.runId, {
    vmName: vm.name,
    ...(opts.port === undefined ? {} : { ports: [opts.port] }),
    ...(createUrl === undefined ? {} : { httpsUrl: createUrl }),
  });
  let httpsUrl = createUrl;
  if (opts.port !== undefined) {
    // A driver that resolves nothing — or an empty string — has established no
    // URL, so the create-time value is kept for BOTH the record and the return
    // (the store has no way to unset a field, and "clear both" is not
    // available, so they agree on the only value either of them can hold).
    const exposed = address(
      await provisionStep(
        driver.expose(vm.name, opts.port),
        actionTimeoutMs,
        `driver.expose(${vm.name}:${opts.port})`,
        "provider-timeout-expose",
        `tear the run down: bun scripts/fleet.ts teardown ${opts.runId} — the box ${vm.name} is live and billing, and the expose call was ABANDONED, not cancelled: port ${opts.port} may be opened after this refusal, which is why the record carries it as INTENDED, not confirmed`,
      ),
    );
    httpsUrl = exposed ?? httpsUrl;
    // Fail-safe before the box is made PUBLIC: with no address from either
    // call, nothing records how to reach it — `setPublic` would still run,
    // leaving a publicly-reachable box only the provider knows the address of.
    // Refusing here leaves the box exposed but NOT public, with an open record
    // naming it and carrying the port, which teardown can reach.
    if (httpsUrl === undefined) {
      throw new ProvisionRefusedError(
        "expose-no-url",
        `driver ${driver.name} exposed ${vm.name}:${opts.port} without reporting a URL and create reported none either — refusing to make the box public with no address recorded`,
        `tear the run down: bun scripts/fleet.ts teardown ${opts.runId} (the box is exposed but was NOT made public)`,
      );
    }
    // Persisted BEFORE setPublic, by the same reasoning as vmName above:
    // setPublic can throw against a box that is already exposed and already
    // billing, and until the address is on the record nothing but the provider
    // knows what the box is reachable on. The port is already there from the
    // pre-expose write; this write confirms the address beside it.
    //
    // Unconditional, unlike the create-time spread above: the refusal directly
    // overhead has already proven `httpsUrl` is a NON-EMPTY string here, and
    // that proof is the whole point — an address lands or the box never
    // becomes public.
    record = store.set(opts.runId, { httpsUrl });
    await provisionStep(
      driver.setPublic(vm.name),
      actionTimeoutMs,
      `driver.setPublic(${vm.name})`,
      "provider-timeout-set-public",
      `the box ${vm.name} is live and may or may not have been made public — tear the run down: bun scripts/fleet.ts teardown ${opts.runId}`,
    );
  }
  return { record, vm, ...(httpsUrl === undefined ? {} : { httpsUrl }) };
}

/**
 * AC7: DF2.8's budget gate has exactly ONE production caller — the fleet
 * dispatcher, which admits and then composes `provisionAdmittedRun` directly.
 * `createRun` used to carry a gate call of its own: a SECOND live admission call
 * site, dormant only because the one caller it has left
 * (`scripts/cap-hit-demo.ts`) omits `opts.issue`. Any future caller that passed
 * one — after admitting, as dispatch does — would have booked the same issue
 * against the same cap twice, with nothing in the type system and no failing
 * test to catch it.
 *
 * Refused at the entry point rather than deleted: `opts.issue` stays on
 * `CreateRunOptions` so a caller that passes it is TOLD where admission lives
 * instead of having it silently ignored (which would provision a run with no
 * budget attribution at all — the unpriced-teardown shape).
 *
 * `createRun`'s own gate call is GONE, not dormant. It sat behind
 * `if (opts.issue !== undefined)` — the same condition this refusal throws on —
 * so `assertWithinBudget`, the `admitted` construction and the `budget:` spread
 * into `provisionAdmittedRun` were unreachable from the moment the refusal
 * landed: dead code that still read as a live second admission site, and that
 * any test could only exercise through an impossible branch. Deleting it is
 * what keeps it from rotting; the composition it performed lives in
 * `src/fleet/dispatch.ts` and in the remediation below, both of which are run.
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
  // No budget gate here: `assertAdmissionNotDelegated` above has already
  // refused every call that carries an issue, so this path provisions without
  // budget attribution by construction — see its docstring for where DF2.8's
  // one production admission site lives.
  return (
    await provisionAdmittedRun(driver, store, {
      runId: opts.runId,
      ...(opts.port === undefined ? {} : { port: opts.port }),
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
  // The claim set is only usable if it is COMPLETE. The record store REFUSES a
  // partial listing: plain `store.list()` throws naming any `.json` it could
  // not read as a record (run-record.ts), and this function reads
  // `listWithAnomalies()` directly so it can raise the same refusal itself
  // (`reap-records-unverified` below) before anything is destroyed. A skipped
  // file can hold an OPEN record naming a live box, and a box missing from
  // `claimed` is a box this function would otherwise treat as unowned spend —
  // so a partial record listing stops the sweep; it never narrows the claim set.
  //
  // `listWithAnomalies`, not `list`, on BOTH sides: the skipped names are the
  // whole point here, and they are what the refusals name for the operator.
  //
  // The driver side needs the same proof for the same reason. `driver.list()`
  // has no anomaly channel of its own, so a box the driver refused to name was
  // indistinguishable from a box that does not exist — and this function
  // destroys every box it cannot match to an open record. It never destroyed
  // the skipped box (it never saw it), but it also never reported it: that is
  // a live box no verb can reach, spending against nobody's cap, which is the
  // unowned-spend case INV-4 exists to prevent. A population that cannot be
  // proven complete is never reaped from.
  const vmListing = await driverListing(driver);
  // One source for the message and the remediation, shared with the DF2.6
  // sweep — the two used to word the same refusal differently.
  if (vmListing.skipped.length > 0) throw unverifiedVmListingRefusal(driver.name, vmListing.skipped);
  const vms = vmListing.vms;
  const listing = store.listWithAnomalies();
  if (listing.skipped.length > 0) {
    throw new ProvisionRefusedError(
      "reap-records-unverified",
      `refusing to reap: ${listing.skipped.length} run record file(s) in ${store.dir} were skipped by the record listing (${listing.skipped.join(", ")}), so no box can be proven unclaimed`,
      `rename or move the record files named above out of ${store.dir}, then re-run`,
    );
  }
  const claimed = new Set<string>();
  for (const rec of listing.records) {
    if (rec.closedAt !== undefined) continue;
    claimed.add(rec.runId);
    if (rec.vmName !== undefined) claimed.add(rec.vmName);
  }
  // Unclaimed is not the same as OURS, and this listing is account-wide on
  // exedev (`driverListing(driver)` passes no name filter), so a stranger's
  // box in the same account arrives here unclaimed by construction —
  // destroying it is the worst outcome anywhere in this subsystem, and
  // unrecoverable. The ownership test is the gate, and it is the SAME
  // predicate the DF2.6 sweep classifies on: a box that cannot prove it is
  // ours is `foreign` there and is not an orphan here.
  //
  // But sparing silently was its own failure: a grammar-valid box with no tag
  // (created before the tag existed, or a fake box that crashed between mkdir
  // and its metadata write) was skipped without a trace in the return value,
  // so unreaped spend was invisible at the moment the reaper ran — the same
  // fail-open shape this function already refuses on for driver-side and
  // record-side anomalies. Partition BEFORE destroying anything, and refuse
  // naming every unproven candidate; only provably-owned boxes are destroyed.
  const unproven = vms.filter((vm) => !claimed.has(vm.name) && !isFactoryOwnedVm(vm));
  if (unproven.length > 0) throw unownedVmReapRefusal(driver.name, unproven.map((vm) => vm.name));
  const destroyed: string[] = [];
  for (const vm of vms) {
    if (claimed.has(vm.name)) continue;
    // Everything unproven was refused above, so anything still standing here
    // proves ownership by the shared predicate.
    if (!isFactoryOwnedVm(vm)) continue;
    await driver.destroy(vm.name);
    destroyed.push(vm.name);
  }
  return destroyed;
}
