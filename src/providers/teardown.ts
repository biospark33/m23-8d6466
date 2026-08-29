/**
 * Teardown (DF2.5) — the ordered teardown of ONE run: spend → artifacts →
 * harvest → revoke → verify → destroy → close.
 *
 * Lifted from inkwell's teardown.just:8-15 — which shipped unrun upstream
 * (R4 §3 flag 4), so the ordering and abort semantics here are proven by the
 * tests in tests/providers/teardown.test.ts, not inherited.
 *
 * The step list is a FLOOR, not a closed list: the contract is the RELATIVE
 * order of the six fixed steps (story Technical Notes). DF4.2 may prepend a
 * visualizer stop, DF2.8 hooks its ingestBoxHours call onto the close step,
 * and DF5.3 adds a recordAuditLink emit at the already-existing teardown/reap
 * events — each claim is additive and none may reorder the six. Ordering
 * assertions in the tests are therefore subsequences, never equalities.
 *
 * Fail-closed (AC6/INV-5): every abort throws TeardownError with the literal
 * next command as remediation (env-var NAMES only, never key material),
 * leaving the box alive and the record open so DF2.6's reaper finds it. A
 * harvest failure aborts BEFORE revoke/destroy (AC3) — destroying a box whose
 * commits were never pulled is the one irreversible mistake available. The
 * one carve-out: artifacts/harvest hitting an ALREADY-GONE box skip instead
 * of aborting (a crash between destroy and close must not wedge the record
 * open forever); destroy itself never waives (INV-5).
 *
 * Two verified deviations from the story wording (design.md register):
 *  - "key file shredded": no host-side key file exists in this architecture —
 *    DF2.3 delivers the key via exec stdin and owns the shred; the in-box
 *    .env dies with the box, so destroy IS the shred.
 *  - captureSpend writes `spendMicroUsd` into the record itself (DF2.3);
 *    teardown adds no second write.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { log, newRequestId } from "../swarmclaw/log.ts";
import { captureSpend, revokeRunKey, verifyRevoked, type CredentialDeps, type KeyApi } from "./credentials.ts";
import { stopVisualizer, type ProviderDriver } from "./driver.ts";
import type { BoxHoursCtx } from "./cost-ledger.ts";
import {
  bunGitRunner,
  getRecord,
  harvestRun,
  isNoSuchBox,
  pullArtifacts,
  rmBestEffort,
  type GitRunner,
} from "./harvest.ts";
import type { RunRecordStore } from "./run-record.ts";
import { stepBase, timedLoggedStep, type StepCtx } from "./step-log.ts";
import { ProviderError } from "./errors.ts";

/**
 * DF2.8: structural handle so teardown does not depend on the whole CostLedger type.
 * cost-ledger.ts imports nothing from teardown, so this import creates no cycle.
 */
export interface CostLedgerHook {
  ingestBoxHours(ctx: BoxHoursCtx): { eventId: string; inserted: boolean; unpriced: boolean };
  /**
   * F032: the DERIVED per-run view, for the divergence check at the close step.
   * `perRole` comes with it because the comparison has to be like-for-like: the
   * record's `spendMicroUsd` is TOKEN spend, so the box-hours bucket this very
   * step just ingested is subtracted back out (see reportSpendDivergence).
   * Optional because the hook is structural and DF2.8's only requirement is the
   * box-hours ingest — a hook that cannot answer is simply not asked.
   */
  readRunCost?(runId: string): { totalMicroUsd: number; perRole: Record<string, number> };
}

export class TeardownError extends ProviderError {
  constructor(code: string, message: string, remediation: string) {
    super(code, message, remediation);
    this.name = "TeardownError";
  }
}

export interface TeardownDeps {
  driver: ProviderDriver;
  store: RunRecordStore;
  /** Required iff the record carries keyHash (fail-closed otherwise, code "provisioning-key-missing"). */
  keyApi?: KeyApi;
  /** Propagated from the dispatch that created the run (§5.2). */
  requestId?: string;
  gitCwd?: string;
  gitRunner?: GitRunner;
  runsDir?: string;
  workdir?: string;
  /**
   * DF2.8: when present, the close step prices this run's box hours into the cost ledger
   * (exactly once — the deterministic event_id makes a repeated close a no-op).
   */
  costLedger?: CostLedgerHook;
}

export interface TeardownOptions {
  /** Waive AC3's harvest gate ONLY — never the AC6/INV-5 fail-closed gates. */
  noHarvest?: boolean;
}

// ─── observability ───────────────────────────────────────────────────────────

type TeardownStep = "stopVisualizer" | "spend" | "artifacts" | "harvest" | "revoke" | "verify" | "destroy" | "close";

const STEPS: readonly TeardownStep[] = [
  "stopVisualizer",
  "spend",
  "artifacts",
  "harvest",
  "revoke",
  "verify",
  "destroy",
  "close",
];

/** Teardown's outcome vocabulary for the shared step logger (step-log.ts). */
const STEP_LABELS = { ok: "ran", error: "failed", errorCode: "teardown_error" };

/** One timed, logged teardown step — credentials.ts `timed` shape. */
function runStep<T>(ctx: StepCtx, step: TeardownStep, fn: () => Promise<T>): Promise<T> {
  return timedLoggedStep(ctx, "teardown", step, STEP_LABELS, fn);
}

function skipStep(ctx: StepCtx, step: TeardownStep, reason: string): void {
  log({ ...stepBase(ctx, "teardown", step), duration: 0, durationMs: 0, status: "ok", outcome: "skipped", reason, [`${step}_ms`]: 0 });
}

/**
 * A driver rejection meaning the box is GONE — a crash between a successful
 * destroy and close, a reaper race, or a hand destroy. The pre-destroy steps
 * that exec the box treat it as a skip so the run can still reach revoke/close
 * (the box is already in its goal state) instead of wedging the record open
 * forever on an exec that can never succeed again. Detected via harvest's
 * isNoSuchBox: the typed HarvestError.noSuchBox flag set at the wrap points on
 * RAW seam output, with a message fallback for raw driver throws.
 */

/**
 * Artifacts/harvest against a box that is already gone → skip, not abort. The
 * destroy step NEVER goes through here (INV-5): a destroy it cannot CONFIRM
 * still fails closed — only the earlier steps' exec-against-missing-box
 * aborts become skips.
 */
async function runBoxStep(ctx: StepCtx, step: "artifacts" | "harvest", fn: () => Promise<unknown>): Promise<void> {
  try {
    await runStep(ctx, step, fn);
  } catch (e) {
    if (!isNoSuchBox(e)) throw e;
    skipStep(ctx, step, "box already gone — destroyed before this step ran; nothing left to pull");
  }
}

/**
 * DF4.2's prepended step — stop the visualizer before anything else runs.
 * Deliberately NOT `runStep`: every other step here is fail-closed (a throw
 * aborts the whole sequence, box left alive, record left open), but AC6
 * requires the opposite for this one specifically — a stop failure is
 * logged with its cause and teardown CONTINUES past it, because a stray
 * visualizer process must never be able to wedge a run open or block the
 * box from coming down. This is a deliberate, visible carve-out from the
 * ambient fail-closed rule, not an accidental swallow.
 */
async function runVizStopStep(ctx: StepCtx, driver: ProviderDriver, vmName: string | undefined): Promise<void> {
  if (vmName === undefined) {
    skipStep(ctx, "stopVisualizer", "no box was ever created for this run");
    return;
  }
  const started = Date.now();
  const base = stepBase(ctx, "teardown", "stopVisualizer");
  try {
    const result = await stopVisualizer(driver, vmName);
    const durationMs = Date.now() - started;
    log({
      ...base,
      duration: durationMs,
      durationMs,
      status: "ok",
      outcome: result.stopped ? "ran" : "skipped",
      reason: result.reason,
      stopVisualizer_ms: durationMs,
    });
  } catch (e) {
    const durationMs = Date.now() - started;
    // `e` may reject with a non-Error — even null/undefined (step-log.ts's
    // timedLoggedStep normalizes the same way) — so read through a fallback
    // object rather than off `e` directly.
    const err = (e ?? {}) as { code?: string; message?: string };
    if (isNoSuchBox(e)) {
      // Every other pre-destroy step that execs the box routes "box is
      // gone" through this classifier and records a skip (see the comment
      // above runBoxStep) so the expected crash-between-destroy-and-close
      // and reaper-race cases don't alarm. Mirror that here instead of
      // emitting status:"error" on a routine condition.
      log({
        ...base,
        duration: durationMs,
        durationMs,
        status: "ok",
        outcome: "skipped",
        reason: "box already gone — nothing to stop",
        stopVisualizer_ms: durationMs,
      });
      return;
    }
    log({
      ...base,
      duration: durationMs,
      durationMs,
      status: "error",
      outcome: "failed",
      error: { code: err.code ?? "stopVisualizer-failed", message: err.message ?? String(e) },
      stopVisualizer_ms: durationMs,
    });
  }
}

// ─── preflight probe ─────────────────────────────────────────────────────────

/**
 * Functional availability probe for `git bundle verify` (AC6): mkdtemp →
 * `git init -q` → one `--allow-empty` commit → `git bundle create probe.bundle
 * --all` → `git bundle verify probe.bundle`. It proves the actual capability
 * rather than text-matching stderr, and its argv NEVER carries the run id (a
 * fixed `probe.bundle` name inside a private mkdtemp) so a caller-injected
 * gitRunner can tell the probe apart from the run's own verify (AC3).
 *
 * The probe's commit neutralizes host git config — `commit.gpgsign=true` or a
 * broken `core.hooksPath` would fail the commit and abort EVERY teardown as
 * bundle-verify-unavailable on a host where verify works. Scoped to the probe
 * argv only; the run's own commits in the box are untouched.
 */
const PROBE_SEQUENCE: readonly (readonly string[])[] = [
  ["git", "init", "-q"],
  [
    "git",
    "-c",
    "user.email=qds-probe@invalid",
    "-c",
    "user.name=qds-probe",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "probe",
  ],
  ["git", "bundle", "create", "probe.bundle", "--all"],
  ["git", "bundle", "verify", "probe.bundle"],
];

async function probeBundleVerify(gitRunner: GitRunner): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "qds-bvprobe-"));
  try {
    for (const argv of PROBE_SEQUENCE) {
      const res = await gitRunner(argv, dir);
      if (res.exitCode !== 0) {
        throw new TeardownError(
          "bundle-verify-unavailable",
          `git bundle verify is not usable on this host — the probe '${argv.join(" ")}' exited ${res.exitCode}${res.stderr.trim() ? `: ${res.stderr.trim()}` : ""}`,
          "install/repair a git with bundle support on the host, then re-run teardown — the box was not touched",
        );
      }
    }
  } finally {
    // Best-effort: a probe-dir cleanup failure must not mask the probe's own
    // error — or corrupt a successful probe into a teardown failure.
    rmBestEffort(dir, { recursive: true });
  }
}

// ─── teardown ────────────────────────────────────────────────────────────────

/** Narrow every abort to a TeardownError, preserving code + remediation. */
function asTeardownError(e: unknown): TeardownError {
  if (e instanceof TeardownError) return e;
  const err = e as { code?: string; remediation?: string; message?: string };
  return new TeardownError(
    err.code ?? "teardown-failed",
    err.message ?? String(e),
    err.remediation ?? "re-run teardown after fixing the above — the box is alive and the record is open",
  );
}

export async function teardownSandbox(deps: TeardownDeps, runId: string, opts: TeardownOptions = {}): Promise<void> {
  const ctx: StepCtx = { requestId: deps.requestId ?? newRequestId(), runId, driver: deps.driver.name };
  try {
    await teardownSteps(deps, runId, opts, ctx);
  } catch (e) {
    throw asTeardownError(e);
  }
}

/**
 * DF2.8: price this run's box hours from the record's budget attribution —
 * the shared body of the two ingest points (the already-closed early path and
 * the close step). Validates the attribution fields are primitive string|number
 * (the extension entry's index signature is string | number, but a hand-edited
 * record could carry an object — truthiness passes and String({}) produces
 * "[object Object]", which would write a nonsense attribution row). Non-primitive
 * values count as no attribution. Returns false when the record carries no valid
 * issue attribution so each call site surfaces the omission its own way.
 */
function ingestBoxHoursIfAttributed(
  costLedger: CostLedgerHook,
  rec: { extensions?: { budget?: { repoSlug?: string | number; issueId?: string | number } } },
  runId: string,
  requestId: string,
): boolean {
  const budget = rec.extensions?.budget;
  const { repoSlug, issueId } = budget ?? {};
  // String-only: numeric values from hand-edited records are rejected as invalid attribution.
  // The extension index signature admits string|number, but a hand-edited {repoSlug: 123}
  // would mis-attributing spend as "123" rather than the intended repo.
  if (typeof repoSlug !== "string") return false;
  if (typeof issueId !== "string") return false;
  costLedger.ingestBoxHours({
    runId,
    repoSlug,
    issueId,
    requestId,
  });
  return true;
}

/**
 * F032: how far the record's spend and the ledger's derived total may sit apart
 * before the close step says so, in micro-USD. A tenth of a cent — above the
 * rounding noise of per-token and per-box-hour pricing (both round to whole
 * micro-USD), and far below any real gap: the divergence this exists to catch
 * is a whole class of events missing from one side, not a rounding remainder.
 * Absolute, not proportional, because the interesting case is a derived total
 * of ~0 against a real provider figure, where a percentage threshold is
 * meaningless.
 */
export const SPEND_DIVERGENCE_TOLERANCE_MICRO_USD = 1_000;

/**
 * F032: say so when the two figures for one run's TOKEN spend disagree.
 *
 * `captureSpend` writes the PROVIDER-AUTHORITATIVE number into the record as
 * `spendMicroUsd` (step 1); the cost ledger DERIVES a second one from its rows.
 * Nothing had ever compared them, and they are one field apart:
 * `readRunCost`'s other reader is the PR body (src/pr/open-pr.ts) — this is the
 * second — and `spendMicroUsd`'s are cap-hit-demo and `fleet status`. Every
 * event the ledger never received makes the per-issue cap under-count by
 * exactly that much, silently. This does not close that gap — it makes it
 * audible at the one moment the run's spend is final.
 *
 * LIKE FOR LIKE. The record's figure is the provider's key usage: TOKENS, and
 * nothing else. The ledger's `totalMicroUsd` also carries the `box_hours` row
 * the close step ingested moments ago, so comparing the two raw would report a
 * divergence of exactly this run's box time on every priced teardown, forever —
 * and in the wrong direction. The box-hours bucket is subtracted back out
 * (`CostView.perRole`'s literal `"box-hours"` key, cost-ledger.ts's `view`).
 *
 * The F001 shape gets its own `outcome` — a FIELD, not prose an operator has to
 * parse: `unwired` when the ledger holds no token spend for this run at all
 * against a non-zero provider figure (the DF2.7 bridge is unbuilt), `divergent`
 * when both sides have numbers and they disagree.
 *
 * Never throws: the box is destroyed and the record is closed by the time this
 * runs, so a raising log sink or an unqueryable ledger must not turn a
 * completed teardown into an abort (an unqueryable ledger already refused
 * loudly at the ingest above).
 */
function reportSpendDivergence(
  ctx: StepCtx,
  ledger: CostLedgerHook,
  rec: { spendMicroUsd?: number },
  runId: string,
): void {
  if (ledger.readRunCost === undefined) return;
  const recorded = rec.spendMicroUsd;
  // No captured spend ⇒ nothing to compare. A run with no key never reaches
  // step 1, and a `0` IS a comparison (a provider that reported zero against a
  // ledger that did not is exactly the divergence worth hearing about).
  if (typeof recorded !== "number" || !Number.isFinite(recorded)) return;
  try {
    const view = ledger.readRunCost(runId);
    // Tokens only, both sides: this step's own box_hours row comes back out.
    const derived = view.totalMicroUsd - (view.perRole?.["box-hours"] ?? 0);
    if (!Number.isFinite(derived)) return;
    if (Math.abs(recorded - derived) <= SPEND_DIVERGENCE_TOLERANCE_MICRO_USD) return;
    const unwired = derived === 0 && recorded > 0;
    log({
      ...stepBase(ctx, "teardown", "close"),
      operation: "teardown.spend_divergence",
      duration: 0,
      durationMs: 0,
      status: "ok",
      outcome: unwired ? "unwired" : "divergent",
      code: "spend-divergence",
      recordedMicroUsd: recorded,
      derivedMicroUsd: derived,
      deltaMicroUsd: recorded - derived,
      toleranceMicroUsd: SPEND_DIVERGENCE_TOLERANCE_MICRO_USD,
      reason:
        `the provider-authoritative token spend on the record (${recorded} µUSD) and the cost ledger's derived token spend for this run (${derived} µUSD, box hours excluded) disagree by more than ${SPEND_DIVERGENCE_TOLERANCE_MICRO_USD} µUSD`,
      message: unwired
        ? `run ${runId}: the provider charged ${recorded} µUSD in tokens and the ledger holds NO token spend for this run — the DF2.7 cost-event bridge never delivered it, so no per-issue cap counted any of it (CostLedger.emitTokenBridgeState() reports the ledger-wide form of this as tokens-ledger-unwired)`
        : `run ${runId}: recorded token spend ${recorded} µUSD vs derived ${derived} µUSD (box hours excluded) — every per-issue cap reads the DERIVED figure, so the difference is spend no cap counted`,
    });
  } catch {
    // A throwing sink or ledger must not undo a completed teardown; the close
    // above already landed and the divergence is a report, not a gate.
  }
}

async function teardownSteps(deps: TeardownDeps, runId: string, opts: TeardownOptions, ctx: StepCtx): Promise<void> {
  // Preflight — all before ANY mutation; the box stays untouched throughout.
  // Shared classifier (harvest.ts getRecord): genuine absence → no-record,
  // any other read failure → record-read-failed with inspect-don't-recreate
  // guidance (a corrupt record may still have a live box and key behind it).
  // teardownSandbox's asTeardownError preserves the code + remediation.
  const rec = getRecord(deps, runId);

  // Idempotent re-run: first-close-wins already applied — every step skipped.
  if (rec.closedAt !== undefined) {
    for (const step of STEPS) skipStep(ctx, step, "record already closed (first-close-wins)");
    // DF2.8 crash-window fix: if store.close succeeded but the process died before ingestBoxHours ran,
    // a re-run would skip everything and the row would never land. Run the hook here — it's
    // idempotent by eventId, so a repeated close is a no-op.
    if (deps.costLedger) {
      try {
        ingestBoxHoursIfAttributed(deps.costLedger, rec, runId, ctx.requestId);
      } catch (e) {
        // Preserve the original error as cause so CostLedgerError classification survives the wrap.
        const wrapped = asTeardownError(e);
        (wrapped as Error & { cause: unknown }).cause = e;
        throw wrapped;
      }
    }
    return;
  }

  // 0. stopVisualizer — DF4.2, prepended ahead of every existing step (AC6:
  // non-aborting, see runVizStopStep). Runs even ahead of the bundle-verify
  // preflight below: stopping a stray visualizer process must not depend on
  // the host's git being usable.
  await runVizStopStep(ctx, deps.driver, rec.vmName);

  // NOTE: the probe guards the harvest/destroy machinery below; with
  // neither a box nor a key that machinery cannot run, and a host with broken
  // git must still be able to close such a record.
  if (rec.vmName !== undefined || rec.keyHash !== undefined) {
    await probeBundleVerify(deps.gitRunner ?? bunGitRunner);
  }

  // The waiver goes to the RUN LOG (observability stream + CLI stdout),
  // NEVER the record (INV-5). It waives the harvest gate only.
  if (opts.noHarvest) {
    log({
      ...stepBase(ctx, "teardown", "harvest"),
      operation: "teardown.harvest_waived",
      duration: 0,
      durationMs: 0,
      status: "ok",
      outcome: "waived",
      reason: "--no-harvest: AC3's harvest gate waived; the AC6/INV-5 gates still stand",
    });
  }

  const keyed = rec.keyHash !== undefined;
  // captureSpend/revokeRunKey/verifyRevoked read only keyApi, store and
  // requestId off this — driver rides along for the interface's shape.
  const cred: CredentialDeps | undefined =
    deps.keyApi === undefined
      ? undefined
      : { keyApi: deps.keyApi, driver: deps.driver, store: deps.store, requestId: ctx.requestId };

  // 1. spend — read usage from the live key BEFORE the DELETE makes it
  // unrecoverable (INV-4). captureSpend writes spendMicroUsd itself (DF2.3).
  if (!keyed) {
    skipStep(ctx, "spend", "no key was ever minted for this run");
  } else {
    await runStep(ctx, "spend", async () => {
      if (cred === undefined) {
        throw new TeardownError(
          "provisioning-key-missing",
          `run ${runId} carries a keyHash but deps.keyApi is absent — spend cannot be read before revoke`,
          "run teardown with the provider key API wired (set $OPENROUTER_PROVISIONING_KEY), or revoke the key by hand first",
        );
      }
      await captureSpend(cred, runId);
    });
  }

  // 2. artifacts — not gated on commits; runs even when the harvest is waived.
  // A box that is already gone is a skip (see runBoxStep): the artifacts died
  // with the box, and the run must still be able to reach revoke/close.
  await runBoxStep(ctx, "artifacts", () => pullArtifacts(deps, runId));

  // 3. harvest — a throw aborts BEFORE revoke/destroy (AC3): box alive, record
  // open, remediation printed.
  if (opts.noHarvest) {
    skipStep(ctx, "harvest", "waived by --no-harvest");
  } else {
    await runBoxStep(ctx, "harvest", async () => {
      // Teardown already pulled artifacts as its own step 2 — harvestRun skips
      // its Step E so exactly one artifact pipeline runs per teardown.
      await harvestRun(deps, runId, { artifactsOwnedByCaller: true });
    });
  }

  // 4. revoke — "revoked" | "already-gone" both OK; a throw aborts with the
  // key possibly still live. (keyed && !cred already threw at spend.)
  if (!keyed || cred === undefined) {
    skipStep(ctx, "revoke", "no key was ever minted for this run");
  } else {
    await runStep(ctx, "revoke", async () => {
      await revokeRunKey(cred, runId);
    });
  }

  // 5. verify — list-authoritative (INV-5: never mark torn down unverified).
  if (!keyed || cred === undefined) {
    skipStep(ctx, "verify", "no key was ever minted for this run");
  } else {
    await runStep(ctx, "verify", async () => {
      await verifyRevoked(cred, runId);
    });
  }

  // 6. destroy — the driver confirms internally; a throw is an UNCONFIRMED
  // destroy and aborts with the record open (AC6). No host-side key file
  // exists to shred — the in-box .env dies with the box, so destroy IS the
  // shred (recorded deviation; DF2.3 owns shred).
  //
  // F6 (2026-08-24): a missing vmName is NOT proof no box exists. The INV-1
  // crash window (`store.create` → `driver.create` → crash before
  // `store.set(vmName)`) leaves a live, billing box named after the run id
  // with no recorded handle; the old skip let teardown report "torn down"
  // over it (e2e-run-report F6, live-confirmed). Fall back to the run id —
  // `createRun` names the box after it — exactly as `teardownRun`
  // (driver.ts) always has; `destroy` is contractually idempotent, so a run
  // that truly never had a box is a no-op and the run still closes.
  const destroyTarget = rec.vmName ?? runId;
  await runStep(ctx, "destroy", async () => {
    try {
      await deps.driver.destroy(destroyTarget);
    } catch (e) {
      throw new TeardownError(
        "destroy-unconfirmed",
        `driver could not confirm destruction of ${destroyTarget}: ${(e as Error).message} — the box may still be alive`,
        "destroy the box by hand via the driver, then re-run teardown — the record stays open until destroy is confirmed",
      );
    }
  });

  // 7. close — LAST. (extensions stay writable post-close; we write none.)
  // A cost-ingest throw inside this step (unconfigured box-hour rate, an
  // unopenable ledger) cannot strand billable resources: the box is already
  // destroyed (step 6), the key revoked+verified (steps 4-5), and the record
  // is closed. The TeardownError exists to surface the unpriced row loudly —
  // and re-running teardown heals it through the closed-record path at the
  // top of teardownSteps, which retries this exact ingest idempotently (the
  // deterministic event_id makes the second attempt a no-op once it lands).
  await runStep(ctx, "close", async () => {
    deps.store.close(runId);
    // DF2.8: price box hours into the cost ledger, now that the record's
    // lifetime is final. The no-attribution omission logs under its own
    // operation — a second "close" step line marked skipped would contradict
    // the close that just succeeded above.
    if (deps.costLedger) {
      const closedRec = deps.store.get(runId);
      if (!ingestBoxHoursIfAttributed(deps.costLedger, closedRec, runId, ctx.requestId)) {
        log({
          ...stepBase(ctx, "teardown", "close"),
          operation: "teardown.box_hours",
          duration: 0,
          durationMs: 0,
          status: "ok",
          outcome: "skipped",
          reason: "no issue attribution — box hours not priced for this run",
        });
      }
      // F032 — AFTER the ingest, so the read sees the ledger's final state for
      // this run. The box-hours row it just wrote is subtracted back out there:
      // the record's figure is token spend, so the comparison must be too.
      reportSpendDivergence(ctx, deps.costLedger, closedRec, runId);
    }
  });
}
