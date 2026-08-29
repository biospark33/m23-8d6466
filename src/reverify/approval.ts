/**
 * The `requestApproval` port and its RunRecord-backed adapter (Story DF5.1,
 * AC6).
 *
 * DF5.1 is the SINGLE OWNER of the `requestApproval` caller: a run that earns a
 * green host verdict is the only run that ever pauses for a decision. Deciding
 * that approval — the `fleet approve` / `fleet reject` intake, the approver
 * allowlist, teardown-at-pause — is DF3.4's and lives behind this port.
 *
 * The adapter here writes DF3.4's `extensions.approval` namespace on the run
 * record (schemaVersioned, writable after `closedAt` — the pause happens after
 * teardown). When DF3.4 lands its own implementation it replaces the ADAPTER,
 * not the caller: the state machine below is caller-side contract.
 */
import { join } from "node:path";

import { acquireFileLock, isPidDead } from "../lib/file-lock.ts";

import type { RunRecordStore } from "../providers/run-record.ts";

export type ApprovalState = "pausing" | "awaiting-approval" | "approved" | "rejected" | "timed-out";

const TERMINAL: ReadonlySet<string> = new Set(["approved", "rejected", "timed-out"]);

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
 * Serialize read-decide-write across processes.
 *
 * `RunRecordStore.set` is atomic on its own, but the AC6 decision is a
 * read-THEN-write: without this an interleaved pair of green verdicts could
 * both read "no record" and both create one. The store's own lock is private
 * and taken inside `set`, so this is a separate file — taking the store's would
 * deadlock.
 *
 * ponytail: spin-wait with a fixed 10 ms poll and a 5 s ceiling, matching the
 * store's own LOCK_TIMEOUT_MS. Two concurrent reverifies of one run is the
 * worst realistic contention; swap for a proper wait queue if that stops being
 * true.
 */
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 10;
/**
 * Age at which a lock is assumed abandoned. DELIBERATELY past the wait timeout:
 * at exactly `LOCK_TIMEOUT_MS` a waiter would steal every lock the instant it
 * gave up waiting, which is not a stale-lock recovery, it is no lock at all.
 * The guarded body is one read-decide-write, so a live holder never reaches 10 s.
 */
const LOCK_STALE_MS = 2 * LOCK_TIMEOUT_MS;

/**
 * Serialize read-decide-write across processes via the shared O_EXCL lock.
 * What stays here is this caller's POLICY: how long it waits, how often it
 * polls, and when a lock is old enough to consider stealing.
 */
async function withApprovalLock<T>(dir: string, runId: string, body: () => T | Promise<T>): Promise<T> {
  const lockPath = join(dir, `${runId}.approval.lock`);
  const release = await acquireFileLock(lockPath, {
    label: "approval lock",
    // Steal a lock only when its holder is provably dead, never on age alone:
    // a live holder can be suspended past LOCK_STALE_MS with its mtime
    // unchanged, and age-only reclamation would let a second process barge
    // into the critical section underneath it.
    isStale: ({ ageMs, pid }) => ageMs > LOCK_STALE_MS && pid !== undefined && isPidDead(pid),
    block: {
      timeoutMs: LOCK_TIMEOUT_MS,
      pollMs: LOCK_POLL_MS,
      timeoutMessage: (path, timeoutMs) =>
        `approval lock ${path} held for over ${timeoutMs}ms; remove it by hand if no reverify is running`,
    },
  });
  try {
    return await body();
  } finally {
    release?.();
  }
}

export function recordApprovalPort(store: RunRecordStore): ApprovalPort {
  return {
    async requestApproval(runId: string, req: ApprovalRequest): Promise<ApprovalOutcome> {
      return withApprovalLock(store.dir, runId, () => {
        const existing = store.get(runId).extensions?.approval;
        const state = existing?.state;

        // Created O_EXCL before teardown, not yet promoted (DF3.4). Neither
        // rebound nor requested against: DF3.4's resume path is what clears it.
        if (state === "pausing") return { outcome: "pause-in-progress" };
        if (typeof state === "string" && TERMINAL.has(state)) {
          return { outcome: "already-decided", state };
        }

        const requestedAt = new Date().toISOString();
        if (state === "awaiting-approval") {
          // REBIND, never a second create: a re-run of reverify must not brick
          // the run on a record bound to a superseded report.
          const supersededReportId = String(existing?.reportId ?? "");
          store.set(runId, {
            extensions: {
              approval: {
                state: "awaiting-approval",
                proposal: req.proposal,
                reportId: req.reportId,
                headSha: req.headSha,
                requestedAt,
                supersededReportId,
              },
            },
          });
          return { outcome: "rebound", supersededReportId };
        }

        store.set(runId, {
          extensions: {
            approval: {
              state: "awaiting-approval",
              proposal: req.proposal,
              reportId: req.reportId,
              headSha: req.headSha,
              requestedAt,
              // `set()` deep-merges the namespace field-by-field, so an omitted
              // key retains whatever a prior cycle left there. This is a fresh
              // request, not a rebind — explicitly clear supersededReportId
              // rather than leave a stale value from an earlier rebind visible
              // under this new reportId.
              supersededReportId: "",
            },
          },
        });
        return { outcome: "requested" };
      });
    },
  };
}
