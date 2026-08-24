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
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
 * Best-effort check that `pid` no longer refers to a live process. Signal 0
 * sends nothing but still validates the pid: ESRCH means the process is gone,
 * anything else (e.g. EPERM — the pid is alive but owned by another user)
 * means we cannot prove death and must NOT reclaim the lock.
 */
function isLockHolderDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function lockHolderPid(raw: string): number | undefined {
  const pid = Number(raw.split(":", 1)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

async function withApprovalLock<T>(dir: string, runId: string, body: () => T | Promise<T>): Promise<T> {
  const lockPath = join(dir, `${runId}.approval.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      // Content proves ownership: pid lets a later waiter check the holder is
      // actually dead (not just slow), and the nonce makes the content unique
      // per acquisition so a compare-and-delete can't be fooled by a
      // replacement lock that happens to reuse the same pid.
      writeFileSync(lockPath, `${process.pid}:${randomUUID()}`, { flag: "wx", mode: 0o600 });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Steal a lock only when its holder is provably dead, never on age
      // alone: a live holder can be suspended past LOCK_STALE_MS with its
      // mtime unchanged, and age-only reclamation would let a second process
      // barge into the critical section underneath it.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          const raw = readFileSync(lockPath, "utf8");
          const pid = lockHolderPid(raw);
          if (pid !== undefined && isLockHolderDead(pid)) {
            // Compare-and-delete: re-read immediately before unlinking so a
            // replacement lock created between the staleness check above and
            // this removal (e.g. a new holder that raced in after the dead
            // owner's lock aged out) is never mistaken for the dead one.
            if (readFileSync(lockPath, "utf8") === raw) {
              rmSync(lockPath, { force: true });
              continue;
            }
          }
        }
      } catch {
        // vanished between the open and the stat/read — just retry
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `approval lock ${lockPath} held for over ${LOCK_TIMEOUT_MS}ms; remove it by hand if no reverify is running`,
        );
      }
      await Bun.sleep(LOCK_POLL_MS);
    }
  }
  try {
    return await body();
  } finally {
    rmSync(lockPath, { force: true });
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
            },
          },
        });
        return { outcome: "requested" };
      });
    },
  };
}
