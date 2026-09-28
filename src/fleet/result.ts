/**
 * `fleet result` — the poller-facing completion payload (Q1.3, G3).
 *
 * ONE versioned JSON read off the run RECORD: no box probes, no driver, no
 * run lock — a DAG adapter may poll it every few seconds without touching the
 * substrate. `terminal` is the field a poller branches on; `status` is the
 * lifecycle word the payload carries beside it; `artifacts` names the files
 * the factory chain has already written, when they exist.
 *
 * TERMINALITY is record-visible only, and deliberately narrow:
 *  - `closedAt`              → completed  (the observe chain closed the record)
 *  - approval `approved`     → approved   (the human let it through)
 *  - approval `rejected`     → rejected   (the human settled it without a PR)
 *  - `awaiting-approval`/`pausing` are OPEN — the DAG never approves (§1.4 of
 *    the program invariants), so an approval pause is the poller's signal to
 *    stop and surface, but the run is not terminal until a human decides.
 *
 * SC2.3 branches on "the verdict" through this payload; its shape is the
 * Q1.8-pinned contract and does not move without a deliberate version bump.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunRecordStore } from "../providers/run-record.ts";

/** The payload contract version. Bumped only with a deliberate contract change (Q1.8 pins it). */
export const RESULT_SCHEMA_VERSION = 1;

export type ResultStatus =
  | "running"
  | "pausing"
  | "awaiting-approval"
  | "approved"
  | "rejected"
  | "cancelled"
  | "completed";

/** The closed status set, exported for the Q1.8 contract suite's drift alarm. */
export const RESULT_STATUS_VALUES = new Set<string>([
  "running",
  "pausing",
  "awaiting-approval",
  "approved",
  "rejected",
  "cancelled",
  "completed",
]);

export interface ResultPayload {
  schemaVersion: 1;
  runId: string;
  requestId: string | null;
  status: ResultStatus;
  terminal: boolean;
  vmName?: string;
  spendMicroUsd?: number;
  artifacts: { bundle?: string };
}

/** The verb's refusal — exit codes from the fleet table. */
export class ResultError extends Error {
  constructor(
    public readonly exitCode: 4,
    public readonly code: "run-not-found",
    message: string,
    public readonly remediation: string,
  ) {
    super(message);
    this.name = "ResultError";
  }
}

/** The approval extension's state field, as the gate verbs write it. */
function approvalState(rec: { extensions?: { approval?: { state?: unknown } } }): string | undefined {
  const state = rec.extensions?.approval?.state;
  return typeof state === "string" && state.length > 0 ? state : undefined;
}

/**
 * Build the payload, or refuse exit-4. Pure record read — `buildResult` never
 * touches a box, a ledger or a lock, which is what makes it poller-safe.
 */
export function buildResult(store: RunRecordStore, runId: string): ResultPayload {
  let rec: ReturnType<RunRecordStore["get"]>;
  try {
    rec = store.get(runId);
  } catch (e) {
    throw new ResultError(
      4,
      "run-not-found",
      `the run record for ${runId} could not be read: ${String(e)}`,
      "check the runs directory (--dir); a corrupt record is not a missing one — fleet status names it",
    );
  }
  if (rec === undefined || rec === null) {
    throw new ResultError(
      4,
      "run-not-found",
      `no run record for ${runId}`,
      "check the id with fleet status — the poller treats exit 4 as the missing-record answer",
    );
  }
  const approval = approvalState(rec);
  // Q1.4: the cancel mark outranks everything — a cancelled run is terminal
  // even though its record was closed by a teardown (not the observe chain).
  const cancelState = rec.extensions?.cancel?.state;
  const cancelled = cancelState === "cancelled";
  let status: ResultStatus;
  let terminal: boolean;
  if (cancelled) {
    status = "cancelled";
    terminal = true;
  } else if (approval === "approved") {
    status = "approved";
    terminal = true;
  } else if (approval === "rejected") {
    status = "rejected";
    terminal = true;
  } else if (approval === "awaiting-approval" || approval === "pausing") {
    status = approval;
    terminal = false;
  } else if (rec.closedAt !== undefined) {
    status = "completed";
    terminal = true;
  } else {
    status = "running";
    terminal = false;
  }
  const bundlePath = join(store.dir, `${runId}.bundle`);
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    runId: rec.runId,
    requestId: rec.requestId ?? null,
    status,
    terminal,
    ...(rec.vmName !== undefined ? { vmName: rec.vmName } : {}),
    ...(rec.spendMicroUsd !== undefined ? { spendMicroUsd: rec.spendMicroUsd } : {}),
    artifacts: existsSync(bundlePath) ? { bundle: bundlePath } : {},
  };
}
