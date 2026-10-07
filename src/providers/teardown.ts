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
import {
  captureSeatSpend,
  captureSpend,
  revokeRunKey,
  revokeSeatKeys,
  verifyRevoked,
  type CredentialDeps,
  type KeyApi,
} from "./credentials.ts";
import {
  auditLinkSkip,
  auditNonEmpty,
  auditRepoSlug,
  emitAuditLink,
  isAuditStoreError,
  stopVisualizer,
  type ProviderAuditLink,
  type ProviderDriver,
} from "./driver.ts";
import { ingestHarvestedTokens } from "./cost-ledger-bridge.ts";
import type { BoxHoursCtx, CostWireEvent, IngestCtx, IngestResult } from "./cost-ledger.ts";
import {
  bunGitRunner,
  getRecord,
  harvestRun,
  isNoSuchBox,
  pullArtifacts,
  rmBestEffort,
  type GitRunner,
  type HarvestResult,
} from "./harvest.ts";
import { resolveRunsDir, type RunRecord, type RunRecordStore } from "./run-record.ts";
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
   * DF2.12: the token half. teardown drives it through
   * `ingestHarvestedTokens` (cost-ledger-bridge.ts) at BOTH ingest points, so
   * `ingestCostEvent` stays the only writer of `kind='tokens'` rows and this
   * interface gains a caller, not a writer. Optional for the same reason
   * `readRunCost` is — the hook is structural, and a hook that cannot answer
   * is simply not asked — with one money-shaped caveat a reader must not
   * rediscover by accident: a hook WITHOUT it prices box hours only, and the
   * run's token rows are silently skipped. (PR #253 review closed the one
   * such hook: fleet.ts's `makeLoserLedgerHook` now forwards the token ingest
   * through its lazy-open seam, so loser teardowns land token rows too.)
   * Production wires the full CostLedger, which has the method.
   */
  ingestCostEvent?(event: CostWireEvent, ctx: IngestCtx): IngestResult;
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
  /**
   * DF5.3: the audit emit seam, required so an unwired construction fails at
   * compile time. It serves the `teardown` link here AND — via the artifacts
   * step's verbatim `HarvestDeps` forwarding (DF1.10 AC4) and the credential
   * deps built below — the revoke/verify-revoked and bundle emits of the steps
   * this sequence drives.
   */
  recordAuditLink: (link: ProviderAuditLink) => void;
  /**
   * M1.2: the post-harvest retain hook, INJECTED (the recordAuditLink seam
   * shape: this module never imports the memory modules — the composition
   * root binds them, so the provider layer stays decoupled from Hindsight).
   * Fired immediately AFTER the harvest step COMPLETES (never in the skip
   * arms, never under noHarvest) with the leg's own outcome. A rejection is
   * logged and NEVER fails teardown — the harvest gate (AC3) is harvest
   * itself; what the host does with the outcome afterwards must not be able
   * to keep a box alive.
   */
  postHarvest?: (info: {
    runId: string;
    requestId: string;
    outcome: "harvested" | "none";
    count?: number;
  }) => Promise<void>;
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
          // Same coercion as the sibling arm above (round-5 EE-3): `String()`
          // on a non-string rejection — a Symbol, an object whose `toString`
          // throws — would throw INSIDE this catch, converting the logged
          // loss into an abort that resurrects the gate. `redactSecrets`
          // coerces throw-safe and keeps the field off the raw-embed path the
          // message above already avoids.
          message: `the run record could not be marked with the artifacts loss: ${redactSecrets(recErr.message ?? recordErr)}`,
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
 * DF2.12: drive the token half of the ledger from the harvested engine log —
 * the shared body of the two ingest points, called immediately before the
 * box-hours ingest at each. Reads the budget attribution off the same record
 * field the box-hours ingest reads; the string-only validation and every
 * refusal live in the bridge, which reports its own structured summary.
 * A hook without `ingestCostEvent` (see CostLedgerHook) is skipped, not
 * asked — the same posture readRunCost's absence takes at the divergence
 * check below.
 */
function ingestHarvestedTokensIfWired(
  costLedger: CostLedgerHook,
  rec: { extensions?: { budget?: { repoSlug?: string | number; issueId?: string | number } } },
  runsDir: string | undefined,
  runId: string,
  requestId: string,
  onRefusal: (e: unknown) => void,
): void {
  if (costLedger.ingestCostEvent === undefined) return;
  try {
    ingestHarvestedTokens(costLedger, runsDir, runId, rec.extensions?.budget, requestId);
  } catch (e) {
    onRefusal(e);
  }
}

/**
 * PR #253 review: the reporter a token-ingest refusal rides. The bridge emits
 * its own summary line — with the partial counts — BEFORE rethrowing; this is
 * teardown's own record that the ingest point CONTINUED past the refusal,
 * because the box-hours ingest that follows shares none of the refusal's
 * guards (key-hash-missing is an `ingestCostEvent`-only class) and is priced
 * from the record alone. A refusal here is usually DETERMINISTIC (a record
 * with no keyHash stays keyHash-less), so aborting the step would wedge
 * box-hours pricing behind a failure no re-run can heal. The token rows stay
 * absent from the ledger until the refusal's remediation is done — the
 * divergence report after the ingest still says so (`unwired`/`divergent`).
 */
function tokenIngestRefusalLog(ctx: StepCtx, phase: string): (e: unknown) => void {
  return (e: unknown): void => {
    const err = (e ?? {}) as { code?: string; message?: string; remediation?: string };
    log({
      // The ingest point's real phase, from its call site (BRG-9): the fresh
      // close step reports "close", the crash-recovery re-run's healing pass
      // reports "close-recovery" — both refused through the same reporter, but
      // a log that says "close" for a run whose close SUCCEEDED long ago
      // mislocates the failure in the run's history.
      ...stepBase(ctx, "teardown", phase),
      operation: "teardown.token_ingest",
      duration: 0,
      durationMs: 0,
      status: "error",
      outcome: "refused",
      code: err.code ?? "token-ingest-refused",
      reason: `token ingest refused (${err.code ?? "ledger-error"}): ${err.message ?? String(e)} — box-hours pricing continues; the run's token rows stay out of the ledger until the refusal is remediated`,
      // BRG-10: the typed refusal's literal next command, when it carries one.
      ...(err.remediation === undefined ? {} : { remediation: err.remediation }),
    });
  };
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
 * The no-token-spend shape gets its own `outcome` — a FIELD, not prose an
 * operator has to parse: `unwired` when the ledger holds no token row for this
 * run at all against a non-zero provider figure. With the DF2.12 bridge live
 * that is a FAULT, not a wiring note — the run's engine log never reached this
 * teardown (an artifacts pull failed, or the box died before harvest), or
 * every cost_attribution line it carried was refused — and the message says
 * so. `divergent` is when both sides have numbers and they disagree.
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
        ? `run ${runId}: the provider charged ${recorded} µUSD in tokens and the ledger holds NO token row for this run — with the DF2.12 token bridge live this is a FAULT: the harvested engine log never reached this teardown (check the run's artifacts pull outcome), every cost_attribution line it carried was refused, or the log was readable but carried zero attribution lines while the provider still charged (BRG-5: the empty-readable-log cause; "qds cost" renders that arm as no-token-spend beside a non-zero SPEND) — either way no per-issue cap counted any of it (CostLedger.emitTokenBridgeState() reports the ledger-wide form of this as tokens-ledger-unwired)`
        : `run ${runId}: recorded token spend ${recorded} µUSD vs derived ${derived} µUSD (box hours excluded) — every per-issue cap reads the DERIVED figure, so the difference is spend no cap counted`,
    });
  } catch {
    // A throwing sink or ledger must not undo a completed teardown; the close
    // above already landed and the divergence is a report, not a gate.
  }
}

/**
 * DF5.3: the `teardown` link (hop 5, run-box) — the run's box came down and the
 * record closed. Shared by the fresh-close path (INSIDE the close step) and the
 * first-close-wins healing arm, for exactly the reason DF2.8's box-hours ingest
 * is shared: `store.close` is irreversible and the re-run short-circuits above
 * it, so an emit that sits AFTER the close with no healing partner is
 * permanently unemittable once a process dies in that window — hop 5 would
 * report `unlinked` forever for a teardown that was perfect. Re-emitting is free:
 * the store's UNIQUE (run_id, hop, event, subject_key) + `ON CONFLICT DO
 * NOTHING` collapses it, and the subject below is stable across re-runs.
 *
 * Neither identity is manufactured (INV-AUDIT-4): no DF2.8 budget attribution
 * and no correlation id each mean SKIP — the columns are NOT NULL, and hop 5
 * reporting `unlinked` is honest and fail-closed where a stamped random id is
 * evidence invented at the emit.
 *
 * W2-C5 option (c): the RECORD is the only `requestId` source. `deps.requestId`
 * was dropped as a fallback because it never supplies a real id the record
 * lacks — `dispatch.ts` stamps it as its first write after provisioning, long
 * before any teardown — while the three teardown/reap composition roots
 * (`fleet.ts`, `sandbox-teardown.ts`, `reaper.ts`) MINT theirs, making the
 * fallback purely a laundering channel. `deps.requestId` still serves the step
 * log via `ctx`, which is the job it was added for.
 */
function emitTeardownLink(deps: TeardownDeps, ctx: StepCtx, rec: RunRecord, runId: string, closedAt: string | undefined): void {
  const repoSlug = auditRepoSlug(rec);
  const requestId = rec.requestId;
  // C3: ONE non-empty predicate across the three NOT NULL identity columns —
  // `""` used to take the emit arm and throw `audit-link-invalid` past a
  // destroyed box and a CLOSED record. `closedAt` joins them (round 3): the
  // fresh arm read it from the post-close record and the healing arm from the
  // record it already held, so a store that returned a closed record without
  // the field made one arm digest `{closedAt, boxSource}` and the other
  // `{boxSource}` — `auditCanonicalJson` DROPS an undefined member — and the
  // heal then collided with the fresh row on a DIFFERENT digest, which the
  // store reports as `divergent`: a tamper alarm raised by the crash-recovery
  // path that exists to help. Both arms now derive it identically or skip.
  const skip = auditLinkSkip(runId, repoSlug, requestId);
  if (skip !== undefined || !auditNonEmpty(closedAt)) {
    log({
      // stepBase supplies the LOG's own correlation (ctx's id, generated when
      // the dispatch propagated none) — never the link's. That is the fix.
      ...stepBase(ctx, "teardown", "close"),
      // Shared verbatim with credentials.ts and driver.ts: one
      // `operation`/`event`/`reason` triple for every C5 skip, so an operator
      // greps the run once instead of once per emitter.
      operation: "providers.audit-link-skipped",
      duration: 0,
      durationMs: 0,
      status: "error",
      event: "teardown",
      reason: skip ?? "no-closed-at",
      // NOT "and none was propagated": an invocation MAY well have propagated
      // `deps.requestId` (fleet.ts / sandbox-teardown.ts / reaper.ts each mint
      // one per invocation, and `ctx` is carrying it into this very line). That
      // id is not a substitute — it is this process's log correlation, not the
      // RECORD's audit-chain join key, and the walker joins `sessions` /
      // `gate_results` on the latter. Saying "none was propagated" sent an
      // operator hunting for a missing `--request-id` that would not have
      // helped. See W2-C5 option (c) above.
      message:
        skip === "no-repo-slug"
          ? `run ${runId} carries no DF2.8 budget attribution — refusing to invent the link's repoSlug (INV-AUDIT-4), so hop 5 reports this run unlinked`
          : skip === "no-run-id"
            ? "an empty runId reached the teardown emit — refusing to write a link that cannot name its run (INV-AUDIT-4), so hop 5 reports this run unlinked"
            : skip === "no-request-id"
              ? `run ${runId} carries no requestId on its record — this invocation's own requestId is a log correlation, not the record's audit-chain join key, and cannot stand in for it; refusing to invent the join key (INV-AUDIT-4), so hop 5 reports this run unlinked`
              : `run ${runId}'s record carries no closedAt after close — the link's event time and its detail both derive from it, and a heal that derived it differently would collide with this row as \`divergent\`; hop 5 reports this run unlinked`,
    });
    return;
  }
  if (!auditNonEmpty(repoSlug) || !auditNonEmpty(requestId)) return; // narrowing only — `skip` already decided
  // BEST EFFORT (N2). This emit sits inside the close step, after destroy and
  // after `store.close`, and `store.close` is IRREVERSIBLE: a propagating
  // store refusal turned a fully successful teardown — box destroyed, key
  // revoked and verified, record closed — into a failure, and the operator's
  // natural re-run heals through the first-close-wins arm, which emits through
  // the SAME store and fails the same way. On the credential half (revoke /
  // verify-revoked, both BEFORE destroy) the same refusal left the box alive
  // and billing with no path to take it down. Hop 5 reporting `unlinked` is
  // recoverable; an unteardownable billing box is not — so the teardown path
  // takes the reaper's posture: log `providers.audit-link-dropped`, continue.
  try {
    emitAuditLink(deps.recordAuditLink, {
      runId,
      repoSlug,
      requestId,
      hop: "run-box",
      event: "teardown",
      // The SAME expression the destroy step targeted (F6's `rec.vmName ?? runId`).
      subjectId: rec.vmName ?? runId,
      subjectKind: "box",
      // The CLOSE's own time, not the emit's. Both arms pass the closed
      // record's `closedAt`, so the healing re-run — which may be days after
      // the close, and whose row is the SOLE row whenever the original emit
      // never landed — states when the teardown actually happened. That column
      // is what `linksForRun` sorts by, what `firstOrderProblem` compares and
      // what AC7's hop-5 constraint is evaluated on; `recordedAt` keeps the
      // clock read, which is the distinction the two fields exist for.
      occurredAt: closedAt,
      // `boxSource` keeps the link honest about WHAT came down. A record with no
      // `vmName` still reaches destroy — F6 falls back to the run id because a
      // missing handle is not proof no box exists — and `destroy` is contractually
      // idempotent, so that call may well have been a no-op over a box that never
      // existed. Without this field the row vouches, indistinguishably, for a box
      // teardown that did not demonstrably happen.
      detail: { closedAt, boxSource: rec.vmName === undefined ? "run-id-fallback" : "record" },
    });
  } catch (e) {
    log({
      ...stepBase(ctx, "teardown", "close"),
      operation: "providers.audit-link-dropped",
      duration: 0,
      durationMs: 0,
      status: "error",
      event: "teardown",
      error: {
        code: isAuditStoreError(e) ? e.code : "audit-link-emit-failed",
        message: redactSecrets(e instanceof Error ? e.message : String(e)),
      },
      message: `the teardown audit link for run ${runId} was DROPPED — the box IS destroyed and the record IS closed, and refusing here would only strand the next run's box; hop 5 reports this run unlinked until the audit store is repaired`,
    });
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
    // idempotent by eventId, so a repeated close is a no-op. DF2.12: the token
    // ingest rides the same point, immediately before the box-hours ingest, so
    // a crash-recovery re-run heals both halves together.
    if (deps.costLedger) {
      try {
        // PR #253 review: a token-ingest refusal is isolated (reported, never
        // blocking) so this crash-recovery pass still prices the box hours —
        // the ingest it guards is independent of the token half's key-hash
        // guard, and a deterministic refusal would otherwise resurface on
        // every re-run, wedging the row forever.
        ingestHarvestedTokensIfWired(deps.costLedger, rec, deps.runsDir, runId, ctx.requestId, tokenIngestRefusalLog(ctx, "close-recovery"));
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
    // DF5.3, the same crash window the box-hours ingest above heals: if
    // store.close succeeded but the process died before the emit ran, this
    // re-run skips every step and the `teardown` row would never land — and
    // could never land, because the short-circuit is above the emit site.
    // Emit here too; `ON CONFLICT DO NOTHING` makes the ordinary (uncrashed)
    // re-run a no-op. The record IS closed on this path, so `rec.closedAt` is
    // the same value the fresh close writes — no second `get` (the close →
    // reverify → gate read order below is load-bearing).
    //
    // GATED on the box actually being gone (round 3). `closedAt !== undefined`
    // alone is not evidence of a teardown: `scripts/run-record.ts` exposes a
    // bare `close <id>` verb that closes a record with no provider call at all,
    // and closed-record-plus-live-box is precisely the state the reaper
    // documents and collects ("teardown destroys before closing, so closed +
    // live ⇒ the destroy never landed"). Emitting there writes a
    // `run-box.teardown` row — the attestation that the run's box CAME DOWN —
    // for a box this process never touched and that may still be billing: an
    // invented event, the class INV-AUDIT-4 exists to forbid. The check is the
    // reaper's own, `driver.list(name)` ⇒ empty, and it fails CLOSED: a
    // listing that throws, is unenumerable, or still shows the box skips the
    // heal and leaves hop 5 `unlinked`, which is honest.
    const healTarget = rec.vmName ?? runId;
    let boxGone: boolean;
    try {
      const listed = await deps.driver.list(healTarget);
      boxGone = Array.isArray(listed) && listed.length === 0;
    } catch {
      boxGone = false; // unenumerable ⇒ unproven ⇒ no attestation
    }
    if (boxGone) {
      emitTeardownLink(deps, ctx, rec, runId, rec.closedAt);
    } else {
      log({
        ...stepBase(ctx, "teardown", "close"),
        operation: "providers.audit-link-skipped",
        duration: 0,
        durationMs: 0,
        status: "error",
        event: "teardown",
        reason: "box-not-proven-gone",
        message: `run ${runId}'s record is closed but ${healTarget} could not be proven gone — refusing to heal a teardown link for a box that may still be live (INV-AUDIT-4); hop 5 reports this run unlinked`,
      });
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
  // S1 rig_swarm: swarm runs carry per-seat keys in extensions.swarmSeats and
  // (post-F007, which made both mints refuse the other shape) NO core keyHash
  // (run-record.ts registers the namespace) — the steps below branch on the
  // shapes so every recorded key is captured and revoked. A record carrying
  // BOTH (a hybrid: possible only from a pre-guard mint) is handled
  // DEFENSIVELY, not refused: the hybrid arms capture core spend AND seat
  // spend, revoke the core key AND the seat keys — a recorded core hash is
  // never left live just because seat keys share the record. The namespace is
  // written at dispatch, long before this sequence, so the same single-read
  // staleness discipline as `keyed` applies.
  const swarmSeatHashes = (rec.extensions?.swarmSeats?.keyHashes as string[] | undefined) ?? [];
  const swarmed = swarmSeatHashes.length > 0;
  // captureSpend/revokeRunKey/verifyRevoked read only keyApi, store and
  // requestId off this — driver rides along for the interface's shape.
  const cred: CredentialDeps | undefined =
    deps.keyApi === undefined
      ? undefined
      : {
          keyApi: deps.keyApi,
          driver: deps.driver,
          store: deps.store,
          // `ctx.requestId`, restored (round 3). The C5 objection to it was
          // that it would launder a generated id into `emitCredentialLink`'s
          // `deps.requestId` FALLBACK and so onto the link the chain JOINs on
          // — but that fallback was removed in this same story: the emitter
          // reads `rec.requestId` and nothing else, and `deps.requestId` now
          // reaches only the step LOG's correlation and the dropped-link line.
          // Paying a real observability regression for a risk the code no
          // longer carries is the wrong trade: with `deps.requestId`
          // (undefined on every `fleet.ts` / `sandbox-teardown.ts` /
          // `reaper.ts` invocation, which all mint their own), each credential
          // step in ONE teardown logged under a DIFFERENT correlation id.
          requestId: ctx.requestId,
          // DF5.3: the spend→revoke→verify steps below are THIS sequence's
          // credential emits — the seam forwards so revoke/verify-revoked
          // land while the run still owns its box.
          recordAuditLink: deps.recordAuditLink,
        };

  // 1. spend — read usage from the live key BEFORE the DELETE makes it
  // unrecoverable (INV-4). captureSpend writes spendMicroUsd itself (DF2.3).
  if (!keyed && !swarmed) {
    skipStep(ctx, "spend", "no key was ever minted for this run");
  } else {
    await runStep(ctx, "spend", async () => {
      if (cred === undefined) {
        throw new TeardownError(
          "provisioning-key-missing",
          `run ${runId} carries credential keys (keyHash or swarm seat keys) but deps.keyApi is absent — spend cannot be read before revoke`,
          "run teardown with the provider key API wired (set $OPENROUTER_PROVISIONING_KEY), or revoke the key by hand first",
        );
      }
      // S1: swarm keys are captured summed across seats; the single-key read
      // below is unchanged for every non-swarm record. F007: each call no-ops
      // on the shape it doesn't carry (captureSeatSpend on an empty namespace,
      // captureSpend on an absent keyHash). On a HYBRID record both shapes
      // carry spend from two independent sources, so the authoritative number
      // is their SUM — captureSpend's core write is provisional and the final
      // store.set composes the total (a plain `if`/`if` pair would let the
      // second write clobber the first shape's contribution).
      if (swarmed && keyed) {
        const coreUsd = await captureSpend(cred, runId);
        const seatUsd = await captureSeatSpend(cred, runId);
        deps.store.set(runId, { spendMicroUsd: coreUsd + seatUsd });
      } else if (swarmed) {
        await captureSeatSpend(cred, runId);
      } else {
        await captureSpend(cred, runId);
      }
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
    // M1.2: undefined after runBoxStep means the step did NOT run this
    // sequence — the gone-box skip arm swallowed a NoSuchBox — so the hook
    // below fires only on a harvest that actually LANDED.
    let harvested: HarvestResult | undefined;
    await runBoxStep(ctx, "harvest", async () => {
      // Teardown already pulled artifacts as its own step 2 — harvestRun skips
      // its Step E so exactly one artifact pipeline runs per teardown.
      harvested = await harvestRun(deps, runId, { artifactsOwnedByCaller: true });
    });
    if (harvested !== undefined && deps.postHarvest !== undefined) {
      try {
        await deps.postHarvest({
          runId,
          requestId: ctx.requestId,
          outcome: harvested.outcome,
          count: harvested.outcome === "harvested" ? harvested.count : undefined,
        });
      } catch (e) {
        // Failure-isolated by contract (mirror tokenIngestRefusalLog's
        // posture): the leg landed; a retain refusal is one structured line
        // and teardown continues to revoke+destroy. The injected hook is
        // untrusted here regardless of what its own body catches.
        const err = (e ?? {}) as { code?: string; message?: string };
        log({
          ...stepBase(ctx, "teardown", "harvest"),
          operation: "teardown.post_harvest",
          duration: 0,
          durationMs: 0,
          status: "error",
          outcome: "continued",
          // Sliced like the sibling arms above (~337, ~363): the hook's
          // message is caller-controlled free text — bound it too.
          error: { code: err.code ?? "post-harvest-failed", message: redactSecrets(err.message ?? e).slice(0, 200) },
          reason:
            "the post-harvest hook refused — the harvest leg landed and teardown continues to revoke+destroy (memory retain is best-effort, never a teardown gate)",
        });
      }
    }
  }

  // 4. revoke — "revoked" | "already-gone" both OK; a throw aborts with the
  // key possibly still live. (keyed && !cred already threw at spend.)
  if ((!keyed && !swarmed) || cred === undefined) {
    skipStep(ctx, "revoke", "no key was ever minted for this run");
  } else {
    await runStep(ctx, "revoke", async () => {
      // S1: swarm keys are revoked (and verified, per hash) as a set; the
      // single-key revoke below is unchanged for every non-swarm record.
      // F007: a hybrid record revokes BOTH — never leave a recorded core hash
      // live because the record also carries seat keys.
      if (swarmed) {
        await revokeSeatKeys(cred, runId);
      }
      if (keyed) {
        await revokeRunKey(cred, runId);
      }
    });
  }

  // 5. verify — list-authoritative (INV-5: never mark torn down unverified).
  if (!keyed || cred === undefined) {
    // S1: a pure-swarm run's seat keys were verified INSIDE the revoke step
    // (revokeSeatKeys → per-hash list-authoritative absence proof, now also
    // emitting the verify-revoked links, F006) — with no core keyHash there is
    // nothing for this step to verify. A hybrid record HAS a core keyHash, so
    // it falls through to the step and its core key is verified here.
    skipStep(
      ctx,
      "verify",
      swarmed
        ? "swarm seat keys were verified inside the revoke step (revokeSeatKeys)"
        : "no key was ever minted for this run",
    );
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
  // The TOKEN half does not ride this: a ledger refusal there is reported by
  // tokenIngestRefusalLog and the step continues (PR #253 review — a
  // deterministic refusal would resurface on every healing re-run and keep
  // the box-hours row from ever landing behind it).
  // DF5.3: EXACTLY ONE post-close `get`, taken here and shared by the cost
  // ledger and the teardown emit. It is unconditional so the two paths cannot
  // diverge in read COUNT — the close→reverify→gate read order is load-bearing
  // and pinned by position (see OverlayStore in run-completion.test.ts, whose
  // `skip` counts this read as post-close get #1). Nothing else reads the store
  // between here and the end of the sequence, so taking it inside the step
  // rather than after it moves no other reader.
  await runStep(ctx, "close", async () => {
    deps.store.close(runId);
    const closedRec = deps.store.get(runId);
    // DF2.8: price box hours into the cost ledger, now that the record's
    // lifetime is final. The no-attribution omission logs under its own
    // operation — a second "close" step line marked skipped would contradict
    // the close that just succeeded above.
    if (deps.costLedger) {
      // DF2.12: the harvested engine log's cost_attribution lines become token
      // rows HERE — immediately before the box-hours ingest, at the same point
      // DF2.8 established, so a teardown that aborts before close writes
      // neither and reportSpendDivergence below compares like for like.
      // PR #253 review: a ledger refusal in the TOKEN half (key-hash-missing,
      // busy) is reported and does NOT abort this step — box-hours pricing
      // shares none of its guards, and a deterministic refusal (a keyHash-less
      // record) would come back on every healing re-run, leaving the box-hours
      // row unpriced forever. The box-hours ingest's own throw still aborts
      // and still heals (the first-close-wins path above retries it).
      ingestHarvestedTokensIfWired(deps.costLedger, closedRec, deps.runsDir, runId, ctx.requestId, tokenIngestRefusalLog(ctx, "close"));
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
    // DF5.3: the `teardown` link — INSIDE this step, after destroy (step 6) and
    // this step's own close both landed, and while the sequence is still
    // coherent. It used to sit after `runStep`, outside every step and every
    // try: `emitAuditLink` PROPAGATES a store refusal (driver.ts), so a typed
    // AuditStoreError turned a fully successful teardown — box destroyed, key
    // revoked and verified, record CLOSED — into a failure attributed to no
    // step at all, and one the operator's natural re-run could never clear
    // (first-close-wins short-circuits above it; that arm now heals it).
    // Inside the step the refusal is attributable and retryable, which was the
    // whole objection — so it still propagates.
    emitTeardownLink(deps, ctx, rec, runId, closedRec.closedAt);
  });
}
