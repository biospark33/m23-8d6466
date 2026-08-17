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
 * commits were never pulled is the one irreversible mistake available.
 *
 * Two verified deviations from the story wording (design.md register):
 *  - "key file shredded": no host-side key file exists in this architecture —
 *    DF2.3 delivers the key via exec stdin and owns the shred; the in-box
 *    .env dies with the box, so destroy IS the shred.
 *  - captureSpend writes `spendMicroUsd` into the record itself (DF2.3);
 *    teardown adds no second write.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { log, newRequestId } from "../swarmclaw/log.ts";
import { captureSpend, revokeRunKey, verifyRevoked, type CredentialDeps, type KeyApi } from "./credentials.ts";
import type { ProviderDriver } from "./driver.ts";
import { bunGitRunner, harvestRun, pullArtifacts, type GitRunner } from "./harvest.ts";
import type { RunRecord, RunRecordStore } from "./run-record.ts";

export class TeardownError extends Error {
  /** Machine-readable failure class; also the `code` in every log line. */
  readonly code: string;
  /** The literal next command, secrets referenced by env-var NAME, never expanded. */
  readonly remediation: string;

  constructor(code: string, message: string, remediation: string) {
    super(message);
    this.name = "TeardownError";
    this.code = code;
    this.remediation = remediation;
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
}

export interface TeardownOptions {
  /** Waive AC3's harvest gate ONLY — never the AC6/INV-5 fail-closed gates. */
  noHarvest?: boolean;
}

// ─── observability ───────────────────────────────────────────────────────────

type TeardownStep = "spend" | "artifacts" | "harvest" | "revoke" | "verify" | "destroy" | "close";

const STEPS: readonly TeardownStep[] = ["spend", "artifacts", "harvest", "revoke", "verify", "destroy", "close"];

interface StepCtx {
  requestId: string;
  runId: string;
  driver: string;
}

function stepBase(ctx: StepCtx, step: TeardownStep) {
  return {
    requestId: ctx.requestId,
    operation: `teardown.${step}`,
    agentId: null,
    timestamp: new Date().toISOString(),
    runId: ctx.runId,
    step,
    driver: ctx.driver,
  };
}

/** Same shape as credentials.ts `timed`: one line per step, outcome ran|failed. */
async function runStep<T>(ctx: StepCtx, step: TeardownStep, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    const durationMs = Date.now() - started;
    log({ ...stepBase(ctx, step), duration: durationMs, durationMs, status: "ok", outcome: "ran", [`${step}_ms`]: durationMs });
    return result;
  } catch (e) {
    const durationMs = Date.now() - started;
    const err = e as TeardownError;
    log({
      ...stepBase(ctx, step),
      duration: durationMs,
      durationMs,
      status: "error",
      error: { code: err.code ?? "teardown_error", message: err.message },
      remediation: err.remediation ?? null, // env-var names only, never expanded
      outcome: "failed",
      [`${step}_ms`]: durationMs,
    });
    throw e;
  }
}

function skipStep(ctx: StepCtx, step: TeardownStep, reason: string): void {
  log({ ...stepBase(ctx, step), duration: 0, durationMs: 0, status: "ok", outcome: "skipped", reason, [`${step}_ms`]: 0 });
}

// ─── preflight probe ─────────────────────────────────────────────────────────

/**
 * Functional availability probe for `git bundle verify` (AC6): mkdtemp →
 * `git init -q` → one `--allow-empty` commit → `git bundle create probe.bundle
 * --all` → `git bundle verify probe.bundle`. It proves the actual capability
 * rather than text-matching stderr, and its argv NEVER carries the run id (a
 * fixed `probe.bundle` name inside a private mkdtemp) so a caller-injected
 * gitRunner can tell the probe apart from the run's own verify (AC3).
 */
const PROBE_SEQUENCE: readonly (readonly string[])[] = [
  ["git", "init", "-q"],
  ["git", "-c", "user.email=qds-probe@invalid", "-c", "user.name=qds-probe", "commit", "-q", "--allow-empty", "-m", "probe"],
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
    rmSync(dir, { recursive: true, force: true });
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

async function teardownSteps(deps: TeardownDeps, runId: string, opts: TeardownOptions, ctx: StepCtx): Promise<void> {
  // Preflight — all before ANY mutation; the box stays untouched throughout.
  let rec: RunRecord;
  try {
    rec = deps.store.get(runId);
  } catch (e) {
    throw new TeardownError(
      "no-record",
      `no run record for ${runId}: ${(e as Error).message}`,
      "check the run id; records live under $QDS_RUNS_DIR (default .sandbox/runs) — create the run first",
    );
  }

  // Idempotent re-run: first-close-wins already applied — every step skipped.
  if (rec.closedAt !== undefined) {
    for (const step of STEPS) skipStep(ctx, step, "record already closed (first-close-wins)");
    return;
  }

  await probeBundleVerify(deps.gitRunner ?? bunGitRunner);

  // The waiver goes to the RUN LOG (observability stream + CLI stdout),
  // NEVER the record (INV-5). It waives the harvest gate only.
  if (opts.noHarvest) {
    log({
      ...stepBase(ctx, "harvest"),
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
  await runStep(ctx, "artifacts", () => pullArtifacts(deps, runId));

  // 3. harvest — a throw aborts BEFORE revoke/destroy (AC3): box alive, record
  // open, remediation printed.
  if (opts.noHarvest) {
    skipStep(ctx, "harvest", "waived by --no-harvest");
  } else {
    await runStep(ctx, "harvest", async () => {
      await harvestRun(deps, runId);
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
  await runStep(ctx, "destroy", async () => {
    try {
      await deps.driver.destroy(rec.vmName ?? runId);
    } catch (e) {
      throw new TeardownError(
        "destroy-unconfirmed",
        `driver could not confirm destruction of ${rec.vmName ?? runId}: ${(e as Error).message} — the box may still be alive`,
        "destroy the box by hand via the driver, then re-run teardown — the record stays open until destroy is confirmed",
      );
    }
  });

  // 7. close — LAST. (extensions stay writable post-close; we write none.)
  await runStep(ctx, "close", async () => {
    deps.store.close(runId);
  });
}
