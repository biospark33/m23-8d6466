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
  /**
   * The QA verdict folded from `extensions.qaVerdict` (C8/G1 AC4), present
   * only when the record carries the block. Purely-additive optional field —
   * `RESULT_SCHEMA_VERSION` stays the literal 1.
   */
  verdict?: ResultPayloadVerdict;
}

/**
 * The verdict block as the wire carries it. Named fields mirror the consumer
 * pin (`QaVerdictSchema`, src/fleet/auto-merge-policy.ts — tolerant to
 * extras, its r3 E8 arm proving the adds-only path); anything else the
 * producer recorded passes through verbatim, `schemaVersion` stays store
 * metadata and never rides the wire.
 */
export interface ResultPayloadVerdict {
  status?: string;
  producedAt?: string;
  escalated?: boolean;
  qaRunId?: string;
  commitSha?: string;
  findingCount?: number;
  [field: string]: unknown;
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
 * Fold the record's `qaVerdict` extension into the payload verdict block:
 * known fields typed for the consumer, unknown extras pass through verbatim
 * (the consumer schema is tolerant to extras), and `schemaVersion` is store
 * metadata that stays off the wire. `escalated` is stored as int 0/1 (the
 * `FieldKind` vocabulary has no boolean) and is folded to the boolean the
 * consumer schema pins — FAIL CLOSED, that schema's own doctrine
 * (src/fleet/auto-merge-policy.ts): a PRESENT `false`, `0` or null folds to an
 * explicit `false`; any other present value (`true`, `1`, `"yes"`, `{}`) folds
 * to true. An ABSENT `escalated` key never enters the fold, so the wire key is
 * omitted entirely — behaviorally equivalent for the tolerant consumer. A
 * record whose read-tolerated extra carried a boolean escalated must not read
 * as "not escalated".
 */
function foldQaVerdict(entry: Record<string, unknown>): ResultPayloadVerdict {
  const verdict: ResultPayloadVerdict = {};
  for (const [field, value] of Object.entries(entry)) {
    if (field === "schemaVersion") continue;
    if (field === "__proto__" || field === "constructor" || field === "prototype") continue;
    if (field === "escalated") {
      verdict.escalated = !(value === 0 || value === false || value == null);
      continue;
    }
    verdict[field] = value;
  }
  return verdict;
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
  // Presence parity with the read seam (`readQaVerdict`): a null or
  // status-less qaVerdict block folds to NO verdict key on the wire — the
  // same "status-less is absent" posture, so both seams answer identically.
  // A null entry would also crash the fold's Object.entries.
  const qaBlock = rec.extensions?.qaVerdict;
  const hasVerdict =
    qaBlock != null && typeof qaBlock === "object" && typeof (qaBlock as { status?: unknown }).status === "string" &&
    ((qaBlock as { status?: string }).status ?? "").length > 0;
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    runId: rec.runId,
    requestId: rec.requestId ?? null,
    status,
    terminal,
    ...(rec.vmName !== undefined ? { vmName: rec.vmName } : {}),
    ...(rec.spendMicroUsd !== undefined ? { spendMicroUsd: rec.spendMicroUsd } : {}),
    artifacts: existsSync(bundlePath) ? { bundle: bundlePath } : {},
    ...(hasVerdict && qaBlock ? { verdict: foldQaVerdict(qaBlock as Record<string, unknown>) } : {}),
  };
}
