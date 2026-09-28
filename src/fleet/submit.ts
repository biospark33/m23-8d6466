/**
 * `fleet submit` — the DAG-facing single call (Q1.1, G1+G2).
 *
 * Composes dispatch → engine start behind ONE idempotent entry point: the
 * caller supplies a `requestId` (strict UUID v4), the first call provisions a
 * box, mints one key and starts the engine, and EVERY later call with the same
 * id returns the same run — one box, one key, one engine start, an ack carrying
 * `replayed: true`.
 *
 * Replay safety is a durable intent record claimed O_EXCL BEFORE dispatch
 * (SC2.1's posture: the request id is persisted before the box exists — a crash
 * between claim and provision leaves the id spoken-for and nothing provisioned;
 * the reverse order orphans a live box). The runId is captured at the store
 * create — the same instant the run becomes visible — so the crash window in
 * which a box exists but no ack was returned still resolves to `submitted` on
 * replay, not to a second box.
 *
 * THE ONE DELIBERATE CEILING (comment it when it stops being true): an intent
 * left `in-flight` (the dispatcher crashed mid-dispatch) refuses with exit 5
 * until an operator inspects `.sandbox/runs/submits/`. Q1 does not adjudicate
 * "was the box really created" for a foreign crash; SC2's lease regression test
 * owns the crash-mid-submit case at its own seam, where the caller's identity
 * is known.
 *
 * Budget groups (`--budget-group`/`--group-cap`) are validated for PAIRING
 * here and flow onto the ack and the intent; the ledger-side reservation that
 * makes the cap concurrent-safe is Q1.2 and threads through the same fields.
 */

import { chmodSync, mkdirSync, openSync, readFileSync, closeSync, fchmodSync, writeSync, fsyncSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { dispatch, FleetError, type DispatchDeps, type DispatchResult } from "./dispatch.ts";
import { log } from "../swarmclaw/log.ts";
import { isValidUuidV4, resolveRunCorrelation, type IssueRef } from "../phase-engine/issue-correlation.ts";
import type { RunRecordStore } from "../providers/run-record.ts";
import { defaultKeyCapMicroUsd } from "../providers/credentials.ts";
import { CostLedgerError } from "../providers/cost-ledger.ts";
import type { StartRunResult } from "./run.ts";

/** Submits directory name under the runs dir — exported for tests + the CLI. */
export const SUBMITS_DIRNAME = "submits";

/** The ack/intent payload contract version. Bumped only with a deliberate contract change (Q1.8 pins it). */
export const SUBMIT_SCHEMA_VERSION = 1;

const BUDGET_GROUP_RE = /^[A-Za-z0-9._/-]{1,64}$/;

/** The ack the verb prints as ONE JSON line — the Q1.8-pinned contract surface. */
export interface SubmitAck {
  schemaVersion: 1;
  runId: string;
  requestId: string;
  /** `running` = the engine start landed (or was corroborated on replay); `provisioned` = box ready, engine not running. */
  state: "running" | "provisioned";
  vmName: string;
  httpsUrl?: string;
  budgetGroup?: string;
  groupCapMicroUsd?: number;
  replayed: boolean;
}

/** What the intent record holds. `state: "in-flight"` is the crash-window state. */
interface SubmitIntent {
  schemaVersion: 1;
  requestId: string;
  state: "in-flight" | "submitted" | "failed";
  startedAt: string;
  runId?: string;
  engine?: "started" | "failed" | "not-requested";
  budgetGroup?: string;
  groupCapMicroUsd?: number;
}

/** Refusal of the submit verb itself — exit codes from the fleet table. */
export class SubmitError extends Error {
  constructor(
    public readonly exitCode: 2 | 5,
    public readonly code: "submit-usage" | "submit-in-flight" | "submit-intent-corrupt",
    message: string,
    public readonly remediation: string,
  ) {
    super(message);
    this.name = "SubmitError";
  }
}

export interface SubmitDeps extends Pick<
  DispatchDeps,
  "driver" | "keyApi" | "store" | "ledgerFactory" | "repoRoot" | "capMicroUsd" | "quotaLimits" | "clock" | "timeoutMs" | "dispatchLogPath" | "setupGate"
> {
  brief: unknown;
  /** The idempotency key. Strict UUID v4 — validated here, before anything is claimed. */
  requestId: string;
  budgetGroup?: string;
  groupCapMicroUsd?: number;
  /**
   * Engine-start seam. Omitted ⇒ the run stays provisioned-but-idle (the ack
   * says so). Provided, it is called exactly once per run that reaches a
   * started engine — including the replay retry after a failed start (the
   * systemd unit start the `run` verb uses is a no-op on an already-active
   * instance, which is what makes this retry safe).
   */
  startEngine?: (runId: string) => Promise<StartRunResult>;
}

/**
 * The mint-observation seam: a store proxy that fires `onMinted(runId)` at the
 * create — the instant the run becomes visible — while every other access
 * forwards. Verbatim shape of scripts/fleet.ts's `observingMint` (that copy
 * lives in the CLI layer; this module is src-layer and cannot import it).
 */
function observingMint(store: RunRecordStore, onMinted: (runId: string) => void): RunRecordStore {
  return new Proxy(store, {
    get(target, prop) {
      if (prop !== "create") return Reflect.get(target, prop);
      const create = target.create.bind(target);
      return (runId: string, now?: Date) => {
        onMinted(runId);
        return create(runId, now);
      };
    },
  });
}

/** Validate the paired budget-group flags; returns them or throws exit-2. */
function validateBudgetGroup(
  budgetGroup?: string,
  groupCapMicroUsd?: number,
): { budgetGroup?: string; groupCapMicroUsd?: number } {
  if ((budgetGroup === undefined) !== (groupCapMicroUsd === undefined)) {
    throw new SubmitError(
      2,
      "submit-usage",
      "--budget-group and --group-cap stand or fall together — one arrived without the other",
      "pass both flags for a budget-group run, or neither",
    );
  }
  if (budgetGroup === undefined || groupCapMicroUsd === undefined) return {};
  if (typeof budgetGroup !== "string" || !BUDGET_GROUP_RE.test(budgetGroup)) {
    throw new SubmitError(
      2,
      "submit-usage",
      `budgetGroup must match ${BUDGET_GROUP_RE.source}, got ${JSON.stringify(budgetGroup)}`,
      "pass a slug-safe id of at most 64 characters",
    );
  }
  if (!Number.isSafeInteger(groupCapMicroUsd) || groupCapMicroUsd <= 0) {
    throw new SubmitError(
      2,
      "submit-usage",
      `groupCapMicroUsd must be a positive integer of micro-dollars, got ${groupCapMicroUsd}`,
      "pass the group's USD ceiling in micro-dollars (e.g. 2_900_000 for $2.90)",
    );
  }
  return { budgetGroup, groupCapMicroUsd };
}

/** The submits dir for a store, created 0700 on first use. */
function submitsDirFor(store: RunRecordStore): string {
  const dir = join(store.dir, SUBMITS_DIRNAME);
  if (!existsSync(dir)) {
    // mode is umask-masked, so chmod after mkdir and verify — the contract is
    // 0700, not "0700 modulo umask".
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  if ((statSync(dir).mode & 0o777) !== 0o700) {
    throw new SubmitError(
      5,
      "submit-intent-corrupt",
      `the submits directory ${dir} is not mode 0700`,
      `chmod 700 ${dir}, then retry`,
    );
  }
  return dir;
}

function intentPath(submitsDir: string, requestId: string): string {
  return join(submitsDir, `${requestId}.json`);
}

function readIntent(submitsDir: string, requestId: string): SubmitIntent | undefined {
  const path = intentPath(submitsDir, requestId);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SubmitIntent;
  } catch {
    throw new SubmitError(
      5,
      "submit-intent-corrupt",
      `the submit intent for ${requestId} is not readable JSON: ${path}`,
      "inspect the file — it names the run this requestId is spoken for by; fix or remove it only after confirming no run is live (fleet status)",
    );
  }
}

/** O_EXCL claim: the requestId becomes spoken-for, atomically, before dispatch. */
function claimIntent(submitsDir: string, intent: SubmitIntent): void {
  const path = intentPath(submitsDir, intent.requestId);
  const body = `${JSON.stringify(intent)}\n`;
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch {
    throw new SubmitError(
      5,
      "submit-in-flight",
      `requestId ${intent.requestId} is already claimed by a submit in flight (${path})`,
      "retry once the earlier submit settles, or inspect the intent file (it names its run) — never re-submit the same requestId while one is in flight",
    );
  }
  try {
    writeSync(fd, body);
    fsyncSync(fd);
    fchmodSync(fd, 0o600);
    if ((statSync(path).mode & 0o777) !== 0o600) {
      throw new Error(`intent ${path} is not mode 0600 after chmod`);
    }
  } finally {
    closeSync(fd);
  }
}

/** Rewrite an already-claimed intent (the claim is what owns the file). */
function updateIntent(submitsDir: string, intent: SubmitIntent): void {
  const path = intentPath(submitsDir, intent.requestId);
  const body = `${JSON.stringify(intent)}\n`;
  let fd: number;
  try {
    fd = openSync(path, "w", 0o600);
  } catch (e) {
    // The claim exists but is unwritable (foreign chmod, ro fs). The dispatch
    // has NOT started yet at the two call sites that can hit this — refuse
    // rather than provision an unrecordable run.
    throw new SubmitError(
      5,
      "submit-intent-corrupt",
      `the claimed intent for ${intent.requestId} could not be rewritten: ${String(e)}`,
      `fix the file at ${path}, then retry`,
    );
  }
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * The submit core. Dispatch refusal classification:
 *  - the error carries a runId in its payload ⇒ provisioning was ATTEMPTED —
 *    the intent stays, marked `failed` with that runId (the box/record may be
 *    live and the id must keep pointing at it);
 *  - no runId ⇒ nothing was provisioned — the claim is RELEASED and the
 *    requestId is reusable (the DAG node retries the same work).
 */
export async function submitWork(deps: SubmitDeps): Promise<SubmitAck> {
  const { requestId, budgetGroup, groupCapMicroUsd, startEngine } = deps;
  if (typeof requestId !== "string" || !isValidUuidV4(requestId)) {
    throw new SubmitError(
      2,
      "submit-usage",
      `requestId must be a strict UUID v4, got ${JSON.stringify(requestId)}`,
      "pass the DAG node's request id as a UUID v4 — it is the idempotency key every replay keys on",
    );
  }
  const group = validateBudgetGroup(budgetGroup, groupCapMicroUsd);
  const submitsDir = submitsDirFor(deps.store);

  // ── replay path: the id is spoken for, answer from the record ──────────────
  const existing = readIntent(submitsDir, requestId);
  if (existing !== undefined) {
    return replay(submitsDir, existing, deps);
  }

  // ── fresh submit: claim, dispatch, capture the runId at the mint ───────────
  claimIntent(submitsDir, {
    schemaVersion: SUBMIT_SCHEMA_VERSION,
    requestId,
    state: "in-flight",
    startedAt: new Date().toISOString(),
    ...group,
  });

  // Q1.2: the group reservation rides the SAME ledger the dispatch's per-issue
  // admission will, and it lands BEFORE dispatch — a group with no headroom
  // refuses before a box exists, and the ledger's own transaction makes the
  // concurrent-submits case safe (one SQLite file arbitrates both caps).
  // The identity comes from the brief's correlation — resolved PURELY here so
  // the reserve carries the same (repoSlug, issueKey) the dispatch will.
  if (group.budgetGroup !== undefined && group.groupCapMicroUsd !== undefined) {
    try {
      const correlation = resolveRunCorrelation(deps.brief as IssueRef & { requestId?: string });
      const ledger = deps.ledgerFactory();
      try {
        ledger.reserveBudgetGroup(
          {
            groupId: group.budgetGroup,
            repoSlug: correlation.repoSlug,
            issueKey: correlation.issueKey,
            requestId,
            amountMicroUsd: deps.capMicroUsd ?? defaultKeyCapMicroUsd,
          },
          group.groupCapMicroUsd,
        );
        // Retained on success — SC2's cancel/teardown releases it, and the
        // no-record refusal path below refunds it.
      } finally {
        ledger.close();
      }
    } catch (e) {
      // The reserve refused (or the ledger itself failed): NOTHING was
      // provisioned, so the claim is released and the requestId stays
      // reusable — a wedged in-flight claim here would need an operator for
      // what is just a retryable budget refusal.
      try {
        unlinkSync(intentPath(submitsDir, requestId));
      } catch {
        /* the claim stays; the intent dir is the record */
      }
      if (e instanceof CostLedgerError && e.code === "budget-group-exceeded") {
        // Reframed as the fleet-table refusal it is: exit 5, refused before
        // anything was provisioned, group headroom intact.
        throw new FleetError(
          5,
          "budget-group-exceeded",
          e.message,
          e.remediation,
          { groupId: group.budgetGroup, groupCapMicroUsd: group.groupCapMicroUsd },
        );
      }
      // Any other ledger failure: let the typed refusal speak for itself.
      throw e;
    }
  }

  let mintedRunId: string | undefined;
  const store = observingMint(deps.store, (minted) => {
    if (mintedRunId !== undefined) return;
    mintedRunId = minted;
    // The run is visible — the intent resolves to it from this instant, crash
    // or no crash (SC2.1: the request id and the run land TOGETHER).
    updateIntent(submitsDir, {
      schemaVersion: SUBMIT_SCHEMA_VERSION,
      requestId,
      state: "submitted",
      startedAt: "",
      runId: minted,
      engine: "not-requested",
      ...group,
    });
  });

  let result: DispatchResult;
  try {
    result = await dispatch(deps.brief, {
      driver: deps.driver,
      keyApi: deps.keyApi,
      store,
      ledgerFactory: deps.ledgerFactory,
      requestId,
      ...(deps.repoRoot !== undefined ? { repoRoot: deps.repoRoot } : {}),
      ...(deps.capMicroUsd !== undefined ? { capMicroUsd: deps.capMicroUsd } : {}),
      ...(deps.quotaLimits !== undefined ? { quotaLimits: deps.quotaLimits } : {}),
      ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
      ...(deps.dispatchLogPath !== undefined ? { dispatchLogPath: deps.dispatchLogPath } : {}),
      ...(deps.setupGate !== undefined ? { setupGate: deps.setupGate } : {}),
    });
  } catch (e) {
    // Classification is by RECORD, not by the refusal's payload: the payload's
    // runId is stamped the moment an id is chosen (before admission), while the
    // record only exists once provisioning reached store.create — which is the
    // fact that decides whether this requestId may be reused.
    const fleet = e instanceof FleetError ? e : undefined;
    const candidateRunId =
      fleet?.payload !== undefined && typeof fleet.payload.runId === "string" && fleet.payload.runId.length > 0
        ? fleet.payload.runId
        : mintedRunId;
    const recordLanded =
      candidateRunId !== undefined &&
      (() => {
        try {
          const rec = deps.store.get(candidateRunId);
          return rec !== undefined && rec !== null;
        } catch {
          return false;
        }
      })();
    if (recordLanded && candidateRunId !== undefined) {
      // Provisioning reached the record: the id keeps pointing at the run.
      updateIntent(submitsDir, {
        schemaVersion: SUBMIT_SCHEMA_VERSION,
        requestId,
        state: "failed",
        startedAt: "",
        runId: candidateRunId,
        engine: "not-requested",
        ...group,
      });
    } else {
      // Nothing was provisioned: release the claim so the retry works, and
      // refund the group reservation (the run it was reserved FOR does not
      // exist).
      if (group.budgetGroup !== undefined) {
        try {
          const ledger = deps.ledgerFactory();
          try {
            ledger.releaseBudgetGroup({ groupId: group.budgetGroup, requestId });
          } finally {
            ledger.close();
          }
        } catch (releaseErr) {
          // Best-effort, mirroring dispatch's releaseReservation: a failed
          // refund never replaces the refusal, and the row stays visible in
          // the ledger for SC2's/operator reconciliation.
          try {
            log({
              requestId,
              operation: "fleet.submit",
              agentId: null,
              timestamp: new Date().toISOString(),
              status: "error",
              duration: 0,
              durationMs: 0,
              error: {
                code: "group-release-failed",
                message: `${e instanceof FleetError ? e.code : "refused"}: ${String(releaseErr)}`,
              },
              runId: candidateRunId ?? null,
              verb: "submit",
              phase: "refused",
              exitStatus: "transient" as const,
            });
          } catch {
            /* a raising sink must not become this handler's failure */
          }
        }
      }
      try {
        unlinkSync(intentPath(submitsDir, requestId));
      } catch {
        // A claim we could not release stays in-flight — the refusal's own
        // remediation still applies, and the intent dir is the record.
      }
    }
    throw e;
  }

  // The mint observer already marked it submitted; reconcile state in case the
  // dispatch reused a pre-minted id (opts.runId path skips observer ordering).
  if (mintedRunId !== result.runId) {
    updateIntent(submitsDir, {
      schemaVersion: SUBMIT_SCHEMA_VERSION,
      requestId,
      state: "submitted",
      startedAt: "",
      runId: result.runId,
      engine: "not-requested",
      ...group,
    });
  }

  const ack: SubmitAck = {
    schemaVersion: SUBMIT_SCHEMA_VERSION,
    runId: result.runId,
    requestId,
    state: "provisioned",
    vmName: result.vmName,
    ...(result.httpsUrl !== undefined ? { httpsUrl: result.httpsUrl } : {}),
    ...group,
    replayed: false,
  };
  return startEngine === undefined ? ack : withEngine(submitsDir, ack, startEngine);
}

/**
 * Answer from the intent. `submitted` + record ⇒ the SAME run, `replayed: true`.
 * An engine that failed on the first attempt retries here — the unit start is
 * the one idempotent re-issue the fleet's exit table earns (scripts/fleet.ts's
 * `run` verb documents why). `in-flight`/`failed` refuse (exit 5): the first
 * means a dispatcher crashed mid-flight; the second means provisioning was
 * attempted and refused — both need eyes before the id is reused.
 */
async function replay(submitsDir: string, intent: SubmitIntent, deps: SubmitDeps): Promise<SubmitAck> {
  const { requestId } = intent;
  const group = intent.budgetGroup !== undefined
    ? { budgetGroup: intent.budgetGroup, groupCapMicroUsd: intent.groupCapMicroUsd }
    : {};
  if (intent.state === "in-flight") {
    throw new SubmitError(
      5,
      "submit-in-flight",
      `requestId ${requestId} has a submit in flight (claimed ${intent.startedAt || "at an unknown time"})`,
      "the dispatcher that claimed it crashed mid-flight — inspect fleet status and the submits dir, resolve the claim, then retry",
    );
  }
  if (intent.state === "failed" || intent.runId === undefined) {
    throw new SubmitError(
      5,
      "submit-intent-corrupt",
      `requestId ${requestId} names a failed submit${intent.runId === undefined ? "" : ` for run ${intent.runId}`} — provisioning was attempted and refused`,
      `inspect the run (fleet status${intent.runId === undefined ? "" : ` ${intent.runId}`}) and tear it down if it is live; the requestId stays spoken for`,
    );
  }
  const rec = deps.store.get(intent.runId);
  if (rec === undefined || rec === null) {
    throw new SubmitError(
      5,
      "submit-intent-corrupt",
      `the intent for ${requestId} names run ${intent.runId} but no record exists for it`,
      `inspect ${submitsDir}/${requestId}.json beside the runs dir — the run record and the intent disagree, which is evidence, not a retry condition`,
    );
  }
  const ack: SubmitAck = {
    schemaVersion: SUBMIT_SCHEMA_VERSION,
    runId: intent.runId,
    requestId,
    state: intent.engine === "started" ? "running" : "provisioned",
    // The record carries the box name the dispatch minted; the ack replays it.
    vmName: rec.vmName ?? "",
    ...(group as object),
    replayed: true,
  };
  if (deps.startEngine === undefined || intent.engine === "started") return ack;
  return withEngine(submitsDir, ack, deps.startEngine, intent);
}

/** Run the engine seam once, fold the outcome into the ack + the intent. */
async function withEngine(
  submitsDir: string,
  ack: SubmitAck,
  startEngine: NonNullable<SubmitDeps["startEngine"]>,
  existing?: SubmitIntent,
): Promise<SubmitAck> {
  const result = await startEngine(ack.runId).catch((e: unknown): StartRunResult => ({
    outcome: "start-failed",
    reason: "box-unreachable",
    detail: e instanceof Error ? e.message : String(e),
  }));
  const engine: SubmitIntent["engine"] = result.outcome === "started" ? "started" : "failed";
  const intent: SubmitIntent = {
    schemaVersion: SUBMIT_SCHEMA_VERSION,
    requestId: ack.requestId,
    state: "submitted",
    startedAt: existing?.startedAt ?? "",
    runId: ack.runId,
    engine,
    ...(ack.budgetGroup !== undefined ? { budgetGroup: ack.budgetGroup } : {}),
    ...(ack.groupCapMicroUsd !== undefined ? { groupCapMicroUsd: ack.groupCapMicroUsd } : {}),
  };
  updateIntent(submitsDir, intent);
  return result.outcome === "started" ? { ...ack, state: "running" } : ack;
}
