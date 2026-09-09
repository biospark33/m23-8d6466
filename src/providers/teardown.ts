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
 * carve-outs, each argued at its own site: artifacts/harvest hitting an
 * ALREADY-GONE box skip instead of aborting (a crash between destroy and close
 * must not wedge the record open forever); the visualizer stop never aborts
 * (runVizStopStep); and an ARTIFACTS failure is logged and continues rather
 * than aborting (runArtifactsStep) — its sources include a workload-controlled
 * name space, so gating destroy on it let a workload pin its own box alive.
 * Destroy itself never waives (INV-5).
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
import { join, resolve } from "node:path";

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
import { resolveRunsDir, type RunRecordStore } from "./run-record.ts";
import { redactSecrets, stepBase, timedLoggedStep, type StepCtx } from "./step-log.ts";
import { ProviderError } from "./errors.ts";
// DF2.11: type-only — this keeps THIS module's runtime dependency graph free
// of scripts/ (a choice for embedders and compilation units), not a cycle
// guard: reaper.ts and fanout-primitive.ts DO runtime-import the lock module,
// an inversion ADR Q6 accepts (docs/decisions/2026-08-tech-debt-answers.md Q6).
// What holds here regardless: teardown never touches the release primitives —
// the handle is read-only; see teardownSandbox's head check.
import type { RunLockHandle } from "../../scripts/lib/run-lock.ts";

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
  readRunCost?(runId: string): {
    totalMicroUsd: number;
    perRole: Record<string, number>;
    /**
     * A token (non-box-hours) row exists for this run, priced or not.
     * Presence, not a derived-from-cost proxy: a legitimately free (fully
     * cached) turn prices at 0 µ$ with `unpriced` false, so it contributes to
     * neither `totalMicroUsd` nor an unpriced-row count — only presence tells
     * "delivered a zero-cost row" apart from "delivered nothing" (see
     * `reportSpendDivergence`'s `unwired`).
     */
    hasTokenRows: boolean;
  };
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
   * DF1.10 AC4: forwarded verbatim to the artifacts step's HarvestDeps (see
   * harvest.ts). Test seams for the two absolute in-box roots the artifacts
   * tar now reads — production leaves both unset and the script uses `/run`
   * and the box's own `$HOME`. Present here only because teardown owns the
   * artifacts pull as its step 2 and its deps are what reach it.
   */
  boxRunRoot?: string;
  boxHome?: string;
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
 * Harvest against a box that is already gone → skip, not abort. The destroy
 * step NEVER goes through here (INV-5): a destroy it cannot CONFIRM still
 * fails closed — only the earlier steps' exec-against-missing-box aborts
 * become skips. Every OTHER harvest failure still aborts before revoke/destroy
 * (AC3). The artifacts step has its own wrapper (`runArtifactsStep`) because
 * its failure arm differs; this one is harvest's.
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
 * The artifacts step, whose FAILURE must not be able to keep a box alive.
 *
 * Position is unchanged and still AC4's: artifacts are pulled as step 2, ahead
 * of revoke and destroy, because destroy annihilates the tmpfs marker and
 * revoke makes the resident evidence unre-fetchable. What changed is only what
 * happens when the pull FAILS.
 *
 * It used to route through `runBoxStep`, so anything that was not a gone-box
 * re-threw and aborted teardown at step 2 — before `destroy`. That is the
 * correct posture for HARVEST (destroying a box whose commits were never
 * pulled is the one irreversible mistake available, AC3) and the wrong one
 * here, because the artifacts tar reads a name space the WORKLOAD controls.
 * One `ln -s /etc/passwd ~/<runId>-solicit-9-reply.txt` from any code phase
 * used to produce a link entry the host validator refuses, a `HarvestError`
 * with `noSuchBox` false, and a teardown that stopped before `destroy` — box
 * alive, billing, record open. The aged-record reaper then tore down through
 * THIS SAME PATH and re-aborted on every sweep, so the box was stuck alive
 * permanently. (`artifactsScript` now drops non-regular files, which closes
 * that particular door; `dd` past `TAR_MAX_BYTES` and ~100k glob matches
 * reach the same landing, and the workload owns those too.)
 *
 * A lost artifact bundle is one run's evidence. An undestroyable box is money
 * without bound, so the trade is not close. The failure is LOUD — its own
 * `teardown.artifacts_failed` line carrying the typed code, message and
 * remediation, at status "error" — and the ordinary step line is still emitted
 * by `runStep` underneath, so nothing about it is quiet; it simply is not a
 * gate any more. Harvest's own gate at step 3 is untouched.
 *
 * The failure also lands on the RUN RECORD (`extensions.teardown`, DF1.10
 * review round 3 discharging #221): `fleet status` shows "torn down, artifacts
 * lost" from the record, not only from the log stream. The write is
 * best-effort on purpose — a record that cannot take the extension (closed
 * and gone, store fault) must not turn the non-fatal step back into a gate;
 * the log line above remains the durable record either way. A later
 * SUCCESSFUL pull clears those fields again (see the success arm below), so a
 * recovered run is not reported lost forever.
 */
async function runArtifactsStep(deps: TeardownDeps, ctx: StepCtx, fn: () => Promise<unknown>): Promise<void> {
  // Real elapsed, not a fabricated 0: an artifacts pull that hangs for four
  // minutes before failing is exactly the line an operator triages slow
  // teardowns from, and durationMs is the only place the hang is visible.
  const started = Date.now();
  try {
    await runStep(ctx, "artifacts", fn);
    // A SUCCESSFUL pull supersedes a prior attempt's failure fields (round 4,
    // P43): the store's per-namespace merge RETAINS omitted fields, so
    // attempt 1's loss survived attempt 2's success and `fleet status` kept
    // reporting "torn down, artifacts lost" for a run whose bundle sits on
    // disk. Cleared by WRITING the fields empty — status's renderer
    // (`artifactsLostFields`) already treats an empty code as "no loss", so ""
    // is the sentinel that reads correctly downstream (a synthetic "ok" would
    // RENDER as a loss code). Only when a stale loss exists: a first-time
    // success must not grow an extension it never needed. Best-effort, same
    // rule as the failure write below — and INSIDE the try, so it runs only
    // on success (the failure arm does not rethrow, so code after the catch
    // would run on both arms and clear the loss it just wrote).
    try {
      const stale = (deps.store.get(ctx.runId).extensions ?? {}) as { teardown?: { artifactsCode?: unknown } };
      if (typeof stale.teardown?.artifactsCode === "string" && stale.teardown.artifactsCode.length > 0) {
        deps.store.set(ctx.runId, {
          extensions: {
            teardown: { schemaVersion: 1, artifactsCode: "", artifactsMessage: "", artifactsFailedAt: "" },
          },
        });
      }
    } catch {
      // The stale loss stays on the record and status keeps over-reporting it
      // — today's behaviour, reparable by hand. A read/write fault here must
      // not convert this non-gating step's SUCCESS into an abort.
    }
  } catch (e) {
    if (isNoSuchBox(e)) {
      skipStep(ctx, "artifacts", "box already gone — destroyed before this step ran; nothing left to pull");
      return;
    }
    const err = (e ?? {}) as { code?: string; message?: string; remediation?: string };
    const durationMs = Date.now() - started;
    log({
      ...stepBase(ctx, "teardown", "artifacts"),
      operation: "teardown.artifacts_failed",
      duration: durationMs,
      durationMs,
      status: "error",
      outcome: "continued",
      // Redacted + bounded like the sibling step logger (step-log.ts
      // `timedLoggedStep`, which the `runStep` underneath this catch already
      // applied to ITS line): this hand-rolled line used to embed the raw
      // message — box-controlled free text that can carry key material —
      // unredacted and unbounded. `redactSecrets(err.message ?? e)`, not
      // `?? String(e)` first, for the same reason step-log states: it coerces
      // every shape (a non-string non-nullish `message` included) in one
      // place. Same treatment as the record write below.
      error: { code: err.code ?? "artifacts-failed", message: redactSecrets(err.message ?? e).slice(0, 200) },
      // Post-hoc, not pre-hoc: teardown proceeds to destroy AFTER this line,
      // so "inspect the box before it is destroyed" advises an action the
      // reader of this line can no longer take. The actionable question is
      // where a RECOVERY pull lands — answered with the resolved path.
      // Redacted like the message above (sibling parity with step-log.ts) but
      // NOT sliced: the resolved recovery path is the actionable payload this
      // field exists to carry, and a 200-char cut would truncate it mid-path.
      remediation: redactSecrets(
        err.remediation ??
          `this attempt's bundle is lost and the box is destroyed by design; if a later step leaves the record open, a re-run's successful pull writes its bundle to ${join(resolveRunsDir(deps.runsDir), `${ctx.runId}-artifacts`)}`,
      ),
      reason:
        "the artifacts pull failed and teardown CONTINUED to revoke+destroy on purpose: a box that cannot be destroyed bills forever, and the reaper would re-abort through this same step on every sweep. This run's artifact bundle is lost.",
    });
    // …and onto the record, so `fleet status` can say it without grepping the
    // log stream (#221). Best-effort: a store that cannot take the write must
    // not resurrect the gate this step just deliberately removed.
    const code = err.code ?? "artifacts-failed";
    // `redactSecrets(...)`, which coerces: a non-Error rejection can carry a
    // NON-STRING, non-nullish `message` ({message: 42} survives `??`), and a
    // bare `.slice` on it would throw INSIDE this catch — resurrecting the
    // pre-destroy gate this step exists to remove (round 4, P42; step-log.ts
    // normalizes the same shape for the same reason). Redaction added with
    // it: this field is what `fleet status` renders, so it takes the same
    // door as the log line above instead of a raw embed.
    const message = redactSecrets(err.message ?? e).slice(0, 200);
    try {
      deps.store.set(ctx.runId, {
        extensions: {
          teardown: {
            schemaVersion: 1,
            artifactsCode: code,
            artifactsMessage: message,
            artifactsFailedAt: new Date().toISOString(),
          },
        },
      });
    } catch (recordErr) {
      // A store can reject with ANY thrown value, nullish included (the same
      // shape the failure arm above and runVizStopStep normalize before fields
      // are read off it). A bare `.code`/`.message` read on a nullish rejection
      // threw INSIDE this catch — aborting teardown before revoke/destroy and
      // resurrecting the very gate this step exists to remove (round-3 C1).
      const recErr = (recordErr ?? {}) as { code?: string; message?: string };
      log({
        ...stepBase(ctx, "teardown", "artifacts"),
        operation: "teardown.artifacts_record_failed",
        duration: 0,
        durationMs: 0,
        status: "error",
        outcome: "continued",
        error: {
          code: recErr.code ?? "artifacts-record-failed",
          message: `the run record could not be marked with the artifacts loss: ${recErr.message ?? String(recordErr)}`,
        },
        remediation: "the log line above is the durable record of the lost bundle",
      });
    }
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

/**
 * DF2.11: `lock` is a REQUIRED third parameter (AC1 — a two-argument call does
 * not compile) and is READ-ONLY here (AC2): teardown resolves and compares it,
 * never releases it — the caller's finally owns release and the destructive
 * mark is theirs to clear. The head check below is the FIRST thing the body
 * does, before ctx, before getRecord, before any step can run: a handle that is
 * not THIS run's lock — absent (an untyped two-argument caller), another run's,
 * or a bare re-joined path — refuses as "teardown-lock-mismatch" with zero
 * mutations, so a wrong-lock teardown can never spend, revoke, destroy or close.
 */
export async function teardownSandbox(
  deps: TeardownDeps,
  runId: string,
  lock: RunLockHandle,
  opts: TeardownOptions = {},
): Promise<void> {
  // The SAME resolution acquireRunLock performs (resolve, not join — a relative
  // runsDir and its absolute spelling are one file, which is why join() is not
  // good enough on either side) against the runs directory this caller's store
  // actually lives in (deps.runsDir when given, else the store's own dir, which
  // every caller that relies on the store for paths already derives from).
  const expected = resolve(deps.runsDir ?? deps.store.dir, `${runId}.lock`);
  // `typeof` first, not path.resolve first: an ABSENT handle (a two-argument
  // caller without types) must land on this contract error, not on a TypeError
  // thrown from inside path.resolve.
  if (typeof lock !== "string" || resolve(lock) !== expected) {
    throw new TeardownError(
      "teardown-lock-mismatch",
      // String() is symbol-safe (String(Symbol("x")) === "Symbol(x)"; only
      // implicit + conversion throws) — the mismatch message cannot be
      // replaced by a TypeError from inside this builder.
      `teardown of ${runId} was handed ${typeof lock === "string" ? resolve(lock) : String(lock)}, not this run's lock ${expected}`,
      `acquire <runsDir>/${runId}.lock via acquireRunLock and pass the handle; re-acquire first if a retry or the reaper released it`,
    );
  }
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
    // hasTokenRows means the bridge DID deliver a token event for this run —
    // priced at 0, unpriced, whatever — so it's not unwired, just divergent.
    // A zero-cost PRICED row (a legitimately free/cached turn) still counts
    // here even though it moves neither totalMicroUsd nor an unpriced count.
    const unwired = derived === 0 && recorded > 0 && !view.hasTokenRows;
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
      // F032, recovered runs too: the fresh-close path (below) reports
      // divergence right after ingest — a process that dies between
      // store.close and reportSpendDivergence must get the same report on
      // retry, or a token-ledger gap for that run goes unreported forever.
      reportSpendDivergence(ctx, deps.costLedger, rec, runId);
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
  //
  // NON-FATAL to destroy (see runArtifactsStep): the position stays step 2,
  // only the failure arm changed.
  await runArtifactsStep(deps, ctx, () => pullArtifacts(deps, runId));

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
