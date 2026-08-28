/**
 * The `requestApproval` port and its RunRecord-backed adapter (Story DF5.1,
 * AC6).
 *
 * DF5.1 is the SINGLE OWNER of the `requestApproval` caller: a run that earns a
 * green host verdict is the only run that ever pauses for a decision. Deciding
 * that approval — the `fleet approve` / `fleet reject` intake, the approver
 * allowlist, teardown-at-pause — is DF3.4's and lives behind this port.
 *
 * DF3.4 HAS NOW LANDED, and it replaced the ADAPTER exactly as this header
 * promised — not the caller. What survives here is the caller-side contract:
 * `ApprovalRequest`, `ApprovalOutcome` and `ApprovalPort`, all unchanged. The
 * state machine, the locking and the `extensions.approval` writes moved to
 * `src/fleet/approval-gate.ts`, which is where the teardown-at-pause ordering
 * and the decision path now live.
 *
 * The types stay HERE rather than moving with the machine: `runner.ts` binds to
 * this module, and DF5.1 owns the port's shape. `approval-gate.ts` imports them
 * `import type`, so the value dependency runs one way only — this module → the
 * gate — and there is no runtime cycle.
 */
import type { RunRecordStore } from "../providers/run-record.ts";
import { requestApproval as gateRequestApproval, type GateDeps } from "../fleet/approval-gate.ts";

export type ApprovalState = "pausing" | "awaiting-approval" | "approved" | "rejected" | "timed-out";

export interface ApprovalRequest {
  proposal: string;
  /** THE report's `reverifyId` — the approval binds to one report, not a run. */
  reportId: string;
  /** THAT report's `headSha` — the second value DF5.2 re-checks before pushing. */
  headSha: string;
}

export type ApprovalOutcome =
  | { outcome: "requested" }
  | { outcome: "rebound"; supersededReportId: string }
  | { outcome: "pause-in-progress" }
  | { outcome: "already-decided"; state: string };

export interface ApprovalPort {
  requestApproval(runId: string, req: ApprovalRequest): Promise<ApprovalOutcome>;
}

/**
 * The DF5.1 seam, now a thin adapter over DF3.4's gate (Story DF3.4, W4).
 *
 * The state machine moved to `src/fleet/approval-gate.ts` — this is the ADAPTER
 * swap the header promised, and the caller (`runner.ts`) is untouched.
 * `ApprovalOutcome` is byte-identical, including the SINGULAR
 * `supersededReportId`: that is a PER-CALL fact ("the id THIS rebind
 * displaced"), so the gate DERIVES it while the record keeps the full ordered
 * history in `supersededReportIds`. Storing both would be two sources of truth,
 * and a record whose scalar and array disagree is unfalsifiable in an approval
 * audit trail.
 *
 * `opts` carries the gate's seams. `teardown` is the one that matters: DF5.1's
 * caller has no driver to build one from, so a port constructed without it
 * registers and promotes with no teardown step — correct for the reverify
 * runner, whose box is already gone by the time a host-side verdict is green.
 * The fleet verb passes the real one.
 */
export function recordApprovalPort(store: RunRecordStore, opts: Omit<GateDeps, "store"> = {}): ApprovalPort {
  return {
    requestApproval: (runId: string, req: ApprovalRequest): Promise<ApprovalOutcome> =>
      gateRequestApproval({ ...opts, store }, runId, req),
  };
}
