/**
 * The tier-1 pre-PR approval gate (Story DF3.4, AC1/AC2/AC3).
 *
 * A run whose bundle is harvested and whose host-side re-verify is green pauses
 * here for a human decision. This module owns the state machine behind DF5.1's
 * `ApprovalPort`: `src/reverify/approval.ts` is now a thin adapter over it.
 *
 * ORDER IS THE POINT (AC1, INV-APPROVE-6). `requestApproval` registers
 * `state: "pausing"` BEFORE teardown and promotes to `awaiting-approval` only
 * after teardown returns. The evidence must outlive the failure it records: a
 * crash in between leaves an extension naming the run, its bundle and its bound
 * report — recoverable and auditable — where a teardown-first order leaves a
 * destroyed box, a revoked key and nothing on disk saying a run ever reached the
 * gate. A `pausing` extension is NEVER decidable; it is RESUMED (AC1(c)) by the
 * next `requestApproval` for the report it is already bound to, which re-runs
 * teardown and promotes. Nothing else in this module leaves `pausing`, so
 * without that arm one crashed teardown stranded the run for good.
 *
 * AND THE PROMOTION FAILS CLOSED. `awaiting-approval` is the state a decision
 * may be submitted against, so INV-APPROVE-6 says it may never coexist with a
 * live box. `deps.teardown` is optional — a caller whose box is already gone
 * has nothing to destroy — but an OPEN record still naming a `vmName` is the
 * record itself contradicting that claim, and `await deps.teardown?.(...)` on
 * an absent seam is a no-op indistinguishable in any log from a teardown that
 * ran. That combination refuses rather than promotes.
 *
 * DEVIATIONS from the story text, each a recorded ruling:
 *
 *  - `teardownSandbox` is called as `(deps, runId, opts)`. The story spells it
 *    `(runId, opts)` and is simply wrong about the signature.
 *  - NO separate `revokeAndVerify` call. `teardownSandbox` already performs it,
 *    and the story contradicts itself about where the second call belongs
 *    (:97-98 vs :303-304). A redundant revoke turns a provider hiccup into a
 *    hard failure of an already-successful pause.
 *  - The lock is `withApprovalLock`, NOT "DF2.1's per-record PID lock". That
 *    lock is private inside `RunRecordStore.set` and taking it externally
 *    deadlocks (DF5.1 Deviation 4); it also blocks the event loop via
 *    `Atomics.wait` for up to 5 s.
 *  - No stored `bundlePath` COMPARISON. DF2.5's invariant (harvest.ts:18-19) is
 *    that the bundle's presence at `<runsDir>/<run-id>.bundle` IS the record,
 *    and the path is identical by construction for a given runId — so comparing
 *    a stored copy against a recomputed one is vacuous. Existence is the
 *    stronger check and is what `deps.bundleDir` enables.
 *
 * THE LOCK IS NEVER HELD ACROSS TEARDOWN. Teardown is seconds to minutes;
 * `withApprovalLock` times out at 5 s and would refuse every concurrent verb
 * for the duration. It is taken for the state transition, released, teardown
 * runs, and it is retaken to promote.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assertExistingRunId, type ExtensionEntry, type RunRecordStore } from "../providers/run-record.ts";
// TYPE-ONLY, so there is no runtime cycle: `approval.ts` imports this
// module's `requestApproval` as a value, and this direction is erased.
import type { ApprovalOutcome, ApprovalRequest } from "../reverify/approval.ts";

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
 * Age past which a lock is reclaimed EVEN WHEN its pid still resolves.
 *
 * pids are recycled. Once the OS wraps around onto the dead holder's number,
 * `process.kill(pid, 0)` succeeds for a completely unrelated process and the
 * liveness check below can NEVER again prove death — so every verb for that run
 * fails at LOCK_TIMEOUT_MS, forever, with no operator-visible cause and no
 * remedy but deleting the file by hand.
 *
 * ponytail: the tradeoff is deliberate and one-sided. The guarded body is a
 * single read-decide-write, so an hour is four orders of magnitude past any
 * honest holder; the only case this can barge into is a live process suspended
 * for a full hour mid-critical-section, which is already a dead run by every
 * other timeout in the fleet. Lower it if the body ever grows a slow step.
 */
const LOCK_ABANDON_MS = 60 * 60 * 1000;

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

export async function withApprovalLock<T>(dir: string, runId: string, body: () => T | Promise<T>): Promise<T> {
  // The lock path is built from `runId` BEFORE the store validates anything —
  // and this function is EXPORTED, so it is reachable ahead of every store
  // read. Unvalidated, `runId = "../../tmp/x"` both creates and later `rmSync`s
  // a file outside `dir`. Same grammar every record read already enforces, so
  // no id that can reach a record is refused here.
  assertExistingRunId(runId);
  const lockPath = join(dir, `${runId}.approval.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      // Content proves ownership: pid lets a later waiter check the holder is
      // actually dead (not just slow), and the nonce makes the content unique
      // per acquisition so reclamation can't be fooled by a replacement lock
      // that happens to reuse the same pid.
      writeFileSync(lockPath, `${process.pid}:${randomUUID()}`, { flag: "wx", mode: 0o600 });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Steal a lock only when its holder is provably dead, never on age
      // alone: a live holder can be suspended past LOCK_STALE_MS with its
      // mtime unchanged, and age-only reclamation would let a second process
      // barge into the critical section underneath it.
      //
      // `claimed` tracks whether `renameSync` below has already moved a file
      // onto this process's private `claimPath`. Before that point a failure
      // (the lock vanishing between the stat and the read, e.g.) is benign —
      // nothing has moved, so falling through to retry is safe. Once this
      // process owns a file at `claimPath` it is holding either the dead
      // holder's lock or a live replacement's; ANY failure past that point
      // (a read, a restore write, an unlink) must fail closed instead of
      // being swallowed — swallowing it would free `lockPath` for the next
      // loop iteration while the claimed content sits stranded off-path,
      // letting two processes both believe they hold the lock.
      let claimed = false;
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > LOCK_STALE_MS) {
          const raw = readFileSync(lockPath, "utf8");
          const pid = lockHolderPid(raw);
          if ((pid !== undefined && isLockHolderDead(pid)) || age > LOCK_ABANDON_MS) {
            // Atomic reclaim: `rename` is atomic on the same filesystem, so
            // at most one racer can move `lockPath` onto its own private
            // claim path — a second racer's rename fails ENOENT instead of
            // destroying whatever this racer captured. The removal IS the
            // atomic step, so there is no read-then-delete gap for a
            // replacement lock to fall into.
            const claimPath = `${lockPath}.claim.${process.pid}.${randomUUID()}`;
            try {
              renameSync(lockPath, claimPath);
              claimed = true;
            } catch (renameErr) {
              if ((renameErr as NodeJS.ErrnoException).code !== "ENOENT") throw renameErr;
              // Another racer claimed it first. NOT a `continue`: skipping the
              // deadline check and the sleep below turns contention into a
              // busy-spin that never enforces LOCK_TIMEOUT_MS.
            }
            if (claimed) {
              const content = readFileSync(claimPath, "utf8");
              if (content === raw) {
                // Genuinely the dead holder's lock: reclaim it.
                rmSync(claimPath, { force: true });
              } else {
                // We captured a live replacement's lock by accident (it was
                // created between the read above and the rename). Put it back
                // unless a new holder has since re-taken the path.
                try {
                  writeFileSync(lockPath, content, { flag: "wx", mode: 0o600 });
                } catch (restoreErr) {
                  if ((restoreErr as NodeJS.ErrnoException).code !== "EEXIST") {
                    throw new Error(
                      `approval lock reclaim: failed to restore replacement lock from ${claimPath} back to ${lockPath}; remove or restore it by hand: ${(restoreErr as Error).message}`,
                    );
                  }
                  // Someone else already holds lockPath now — nothing to restore.
                }
                rmSync(claimPath, { force: true });
              }
            }
          }
        }
      } catch (err) {
        if (claimed) throw err; // own a claimed lock file — fail closed, never retry past it
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

/** Story: 24h default, configurable per run, floor 60s. */
export const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const MIN_TIMEOUT_MS = 60_000;
/**
 * The ceiling the story does not name, and the floor alone is not a clamp.
 * `Number.isFinite(9e15)` is TRUE, so an unclamped upper bound reaches
 * `new Date(at + ms)` and throws a bare `RangeError` naming neither the run nor
 * the field that caused it. A year is already past any approval a human will
 * wait on, and clamping keeps `resolveTimeoutMs`'s stated posture — CLAMPED,
 * not refused — symmetric at both ends.
 */
export const MAX_TIMEOUT_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * A 40-hex commit sha, validated for the first time anywhere in the repo:
 * `report.ts:90` is `z.string().min(1)` and `push.ts:225` is raw git output.
 * Exported so a consumer gets the check without editing a DF5.1-owned line.
 */
export const HEAD_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * The `approverId` on a timed-out approval. A fixed reserved value, never a
 * real approver (INV-APPROVE-4): the attribution trail must never imply a
 * person declined to act.
 */
export const TIMEOUT_APPROVER_ID = "system:timeout";

/**
 * The reason a timeout records. ONE literal for both the persisted sweep and
 * the derived answer `awaitDecision` returns, so the two can never disagree
 * about why a run stopped.
 */
const TIMEOUT_REASON = "the approval window closed with no decision";

/** Story guards: proposal 8_000 chars INCLUDING the suffix, reason 1_000. */
export const MAX_PROPOSAL_CHARS = 8_000;
export const MAX_REASON_CHARS = 1_000;

const TERMINAL: ReadonlySet<string> = new Set(["approved", "rejected", "timed-out"]);

export type Decision = "approved" | "rejected";

export interface RecordedDecision {
  state: string;
  approverId: string;
  decidedAt: string;
  reason: string;
}

export type DecisionOutcome =
  | { outcome: "decided"; state: Decision; approverId: string; decidedAt: string }
  | ({ outcome: "already-decided" } & RecordedDecision)
  | { outcome: "not-decidable"; state: string }
  | { outcome: "report-changed"; reportId: string };

export interface GateDeps {
  store: RunRecordStore;
  /**
   * The teardown-at-pause step. Wired by the fleet verb to
   * `(runId, opts) => teardownSandbox(tdeps, runId, opts)`. Optional because
   * DF5.1's port has no driver to build one from: when it is absent there is no
   * box to destroy and the sequence is registration → promotion. Its ABSENCE is
   * never a silent skip of a teardown that was owed — and that is now ENFORCED,
   * not assumed: an open record still naming a `vmName` refuses to promote
   * without this seam rather than no-op past it (INV-APPROVE-6, see the
   * header).
   */
  teardown?: (runId: string, opts: { noHarvest: true }) => Promise<void>;
  now?: () => Date;
  timeoutMs?: number;
  /**
   * Where `<runId>.bundle` lives. When set, a rebind proves the harvested
   * bundle is still there before it re-binds — a report naming a run whose
   * bundle is gone is bound to nothing. Absent ⇒ no bundle claim to check.
   */
  bundleDir?: string;
}

const nowOf = (deps: GateDeps): Date => deps.now?.() ?? new Date();

/**
 * Truncate to `max` INCLUDING the suffix, so the cap is the cap.
 *
 * The suffix is the story's literal `[truncated, N chars total]`, with no
 * leading U+2026: the spec declares the bracketed form and a cap is a contract,
 * so an undeclared character inside it is one the consumer never agreed to.
 */
function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const suffix = `[truncated, ${text.length} chars total]`;
  // A suffix longer than the whole budget would make `slice` negative; the
  // caps here are thousands of chars, so this only guards a future edit.
  if (suffix.length >= max) return suffix.slice(0, max);
  let head = text.slice(0, max - suffix.length);
  // `slice` counts UTF-16 CODE UNITS, so an arbitrary cut can land between the
  // halves of a surrogate pair and store a LONE surrogate — an unpaired code
  // unit that is not valid text, survives no JSON round trip intact, and makes
  // the stored proposal not even a prefix of the real one. Drop the orphan:
  // one character short beats one character corrupt.
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return head + suffix;
}

/**
 * The state a reader should DISPLAY, expiry applied — pure, no write.
 *
 * `fleet status --dir` builds a `create: false` store that throws on every
 * write (run-record.ts's `assertWritable`), so the status path cannot persist a
 * sweep. It derives instead; `submitDecision` — which holds a writable store
 * and the lock — is where the same fact gets committed.
 */
export function expiredState(ext: ExtensionEntry | undefined, now: Date): string | undefined {
  if (ext === undefined) return undefined;
  const state = String(ext.state ?? "");
  if (state === "" || TERMINAL.has(state)) return state === "" ? undefined : state;
  // `pausing` does not expire: the box may still be mid-teardown, and a run
  // that never reached `awaiting-approval` was never awaiting anybody.
  if (state !== "awaiting-approval") return state;
  const expiresAt = Date.parse(String(ext.expiresAt ?? ""));
  // An unparseable expiry does NOT expire the run. Timing a decision out is a
  // terminal, irreversible abort, and a malformed stamp is not evidence that a
  // deadline passed.
  if (!Number.isFinite(expiresAt)) return state;
  return now.getTime() > expiresAt ? "timed-out" : state;
}

function readApproval(store: RunRecordStore, runId: string): ExtensionEntry | undefined {
  return store.get(runId).extensions?.approval;
}

/** ENOENT ⇒ no such run, the `stampFanoutExtension` idiom. Everything else throws. */
function readApprovalIfPresent(store: RunRecordStore, runId: string): ExtensionEntry | undefined | null {
  try {
    return readApproval(store, runId);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw e;
  }
}

function historyOf(ext: ExtensionEntry | undefined): string[] {
  const raw = ext?.supersededReportIds;
  return Array.isArray(raw) ? raw.map(String) : [];
}

/**
 * A report naming a run whose harvested bundle is gone is bound to nothing.
 *
 * Checked on BOTH write paths, not just the rebind. The first request is the
 * one that binds an approval to a run in the first place, so a missing bundle
 * there is strictly worse: an approver is asked to authorize a PR from a bundle
 * that no longer exists, and nothing later re-checks. The terminal and
 * `pause-in-progress` branches deliberately do NOT reach here — a decided
 * record still reports its decision whatever became of the bundle.
 */
function assertBundlePresent(deps: GateDeps, runId: string, verb: string): void {
  if (deps.bundleDir === undefined) return;
  if (existsSync(join(deps.bundleDir, `${runId}.bundle`))) return;
  throw new Error(
    `cannot ${verb} ${runId}: its harvested bundle is gone from ${deps.bundleDir} — a report naming a run with no bundle is bound to nothing`,
  );
}

/**
 * Register the pause and, once teardown has landed, promote it to the state a
 * decision may be submitted against (AC1).
 *
 * Re-entry (AC1(a2)) is decided under the lock from the state as read:
 * `awaiting-approval` rebinds, `pausing` is left byte-identical,
 * and a terminal state LOSES — a rebind never resurrects a decided record.
 */
export async function requestApproval(deps: GateDeps, runId: string, req: ApprovalRequest): Promise<ApprovalOutcome> {
  // Validated BEFORE the lock and before any write: a call missing either half
  // of the bound pair is a schema rejection with NO namespace registered, never
  // a defaulted field (AC1). Both halves are TRIMMED first — `submitDecision`
  // compare-and-sets on a byte-identical `reportId`, so an id that binds with a
  // trailing newline (a shell `$(...)` capture, an operator's copy-paste) can
  // never afterwards be decided against.
  const reportId = String(req.reportId ?? "").trim();
  if (reportId === "") throw new Error("approval requires a reportId — the approval binds to one report, not a run");
  // Through `String()`: the request type is compile-time only, so `headSha` may
  // be absent at runtime, and a bare `.slice` on it would replace this
  // diagnostic with a `TypeError` naming nothing.
  const headSha = String(req.headSha ?? "").trim();
  if (!HEAD_SHA_RE.test(headSha)) {
    throw new Error(`approval requires a 40-hex headSha, got ${JSON.stringify(headSha.slice(0, 64))}`);
  }

  const store = deps.store;
  const at = nowOf(deps);
  const requestedAt = at.toISOString();
  // Stamped on EVERY write of the pair, never on the first alone: `set()`
  // merges field-by-field, so a rebind that refreshed `requestedAt` and left
  // `expiresAt` behind would inherit whatever remained of the original window —
  // a report bound at T+23h59m would time out a minute later, against a record
  // whose own two timestamps contradict each other.
  const expiresAt = new Date(at.getTime() + resolveTimeoutMs(deps)).toISOString();
  const proposal = capText(String(req.proposal ?? ""), MAX_PROPOSAL_CHARS);

  // `promote` marks the two entries that still owe the tail below (guards →
  // teardown → promotion): a fresh registration, and a resume of a `pausing`
  // record this same report already owns.
  const transition = await withApprovalLock(store.dir, runId, (): ApprovalOutcome & { promote?: true } => {
    const rec = store.get(runId);
    const existing = rec.extensions?.approval;
    const state = existing === undefined ? undefined : String(existing.state ?? "");

    if (state === "pausing") {
      // AC1(c): "a `pausing` extension found at startup is resumed by
      // re-running teardown (idempotent under DF2.5), then promoting".
      // NOTHING else in this module promotes out of `pausing` — `expiredState`
      // deliberately never expires it and `submitDecision` calls it
      // not-decidable — so without this arm a single crashed teardown stranded
      // the run permanently, with hand-editing the record as the only exit.
      //
      // Only for the report the record is ALREADY bound to. A different
      // reportId is a genuine concurrent-pause collision, and resuming it would
      // rebind a record whose box may still be alive; that keeps returning
      // `pause-in-progress` and leaves the record byte-identical (AC1(a2)).
      if (String(existing?.reportId ?? "") !== reportId) return { outcome: "pause-in-progress" };
      // No write: the resume re-runs teardown and promotes, and the promotion
      // is the only mutation it makes.
      return { outcome: "requested", promote: true };
    }
    // Expiry is applied to the READ, so a rebind arriving after `expiresAt`
    // sees `timed-out` and loses exactly as it would against a real decision.
    const effective = state === undefined ? undefined : expiredState(existing, at);
    if (effective !== undefined && TERMINAL.has(effective)) return { outcome: "already-decided", state: effective };

    if (effective === "awaiting-approval") {
      assertBundlePresent(deps, runId, "rebind");
      // APPEND, oldest-first. `validateExtensions` REPLACES a field's value and
      // has no append semantics, so this is a read-modify-write — which is why
      // the lock is load-bearing here and not merely tidy: two concurrent
      // rebinds would each read [a] and write [a,b] / [a,c], losing one
      // displaced id and breaking the DoD that no decision may name a reportId
      // absent from both `reportId` and `supersededReportIds`.
      const supersededReportId = String(existing?.reportId ?? "");
      const history = historyOf(existing);
      // Three ways an append poisons the audit trail, all skipped: an EMPTY id
      // (an entry naming no report at all), the INCOMING id (an identical
      // rebind — that id is still the live `reportId`, and a record claiming
      // one report both current and superseded answers "was this decided
      // against a live binding?" both ways), and a DUPLICATE of one already
      // recorded. Every id this run was ever bound to stays recoverable, which
      // is the only property the DoD asks of this field.
      //
      // CEILING, stated so nobody reads the DoD as absolute: the store SHEDS
      // this field oldest-first past `STRINGS_MAX_ELEMENTS` (run-record.ts)
      // rather than throwing, because a hard cap on an append-only history
      // bricks every later write for the run — the 257th rebind used to fail
      // and so did everything after it. So recoverability is really "absent
      // from neither `reportId` nor the most recent 256 supersessions". The
      // three skips above remove the realistic growth driver (repeated
      // identical rebinds); a run that genuinely rebinds 256 distinct reports
      // wants a named gate refusal, not a silent shed, and that is a policy
      // decision this module should make rather than inherit from the store.
      const superseded =
        supersededReportId === "" || supersededReportId === reportId || history.includes(supersededReportId)
          ? history
          : [...history, supersededReportId];
      store.set(runId, {
        extensions: {
          approval: {
            state: "awaiting-approval",
            proposal,
            reportId,
            headSha,
            requestedAt,
            expiresAt,
            supersededReportIds: superseded,
          },
        },
      });
      return { outcome: "rebound", supersededReportId };
    }

    assertBundlePresent(deps, runId, "pause");
    // (a) EVIDENCE FIRST. `pausing` is on disk before anything irreversible.
    store.set(runId, {
      extensions: {
        approval: {
          state: "pausing",
          proposal,
          reportId,
          headSha,
          requestedAt,
          expiresAt,
          // Explicit, never left to a deep-merge: `set()` merges field-by-field,
          // so an omitted key retains whatever an earlier cycle left there.
          supersededReportIds: [],
          ...(rec.requestId === undefined ? {} : { requestId: rec.requestId }),
        },
      },
    });
    return { outcome: "requested", promote: true };
  });

  if (transition.promote !== true) {
    const { promote: _promote, ...outcome } = transition;
    return outcome;
  }

  // R5-C, DF3.1's posture translated: a box with no `keyHash` on an OPEN record
  // is the mint's crash window — a key may be live and billing with nothing
  // pointing at it. `fleet teardown` can only exit 6 about this because the box
  // is already gone by then; here we are BEFORE teardown, so refusing is
  // available and strictly better. The `pausing` extension written above stands,
  // so the run stays recoverable and the refusal is auditable.
  const rec = store.get(runId);
  if (rec.vmName !== undefined && rec.keyHash === undefined && rec.closedAt === undefined) {
    throw new Error(
      `refusing to pause ${runId}: it has a box (${rec.vmName}) but no keyHash, so a minted key may still be live and this pause cannot revoke it — check the provider's key list for one created around ${rec.createdAt}`,
    );
  }

  // INV-APPROVE-6, ENFORCED rather than asserted. `teardown` is optional
  // because a caller whose box is already gone has nothing to destroy — but
  // "already gone" is a claim the RECORD can settle, and an open record still
  // naming a `vmName` contradicts it. Promoting there would hand an approver a
  // decidable run sitting over live, billing infrastructure, which is exactly
  // the coexistence INV-APPROVE-6 forbids; `await deps.teardown?.(...)` on an
  // absent seam is a no-op that looks in every log like a teardown that ran.
  // Same posture as R5-C above: refuse BEFORE the irreversible step, leave the
  // `pausing` extension standing so the run is recoverable, and make the
  // refusal auditable rather than silent.
  if (rec.vmName !== undefined && rec.closedAt === undefined && deps.teardown === undefined) {
    throw new Error(
      `refusing to pause ${runId}: its record is open and still owns box ${rec.vmName}, but no teardown seam was provided, so this pause cannot destroy it and would promote a decidable run over a live box — call the gate from a caller that passes GateDeps.teardown, or run \`fleet teardown ${runId}\` first`,
    );
  }

  // (b) Teardown, OUTSIDE the lock. A throw here leaves `pausing` on disk,
  // which is the designed recoverable state — never a swallowed failure.
  // Re-run unconditionally on a resume: DF2.5 makes it idempotent, and the
  // reason we are here at all is that the last attempt may not have finished.
  await deps.teardown?.(runId, { noHarvest: true });

  // (c) Promote, and only from `pausing`: re-read under the lock rather than
  // trusting the state this call observed minutes ago.
  await withApprovalLock(store.dir, runId, () => {
    if (String(readApproval(store, runId)?.state ?? "") !== "pausing") return;
    store.set(runId, { extensions: { approval: { state: "awaiting-approval" } } });
  });
  return { outcome: "requested" };
}

function resolveTimeoutMs(deps: GateDeps): number {
  const ms = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // CLAMPED at BOTH ends, not refused: a sub-minute policy timeout expires the
  // run before an operator could read the notification, an absurd upper one
  // overflows `new Date` into a `RangeError` naming nothing, and refusing
  // outright would break a caller over a value we can safely correct.
  if (!Number.isFinite(ms)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(ms, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/**
 * Record a decision. FIRST DECISION WINS (AC2): a duplicate or contradicting
 * second decision returns the FIRST with no state change.
 *
 * Compare-and-set on BOTH the state AND the `reportId` the approver read, so a
 * decision racing a rebind either lands against the pair it saw or is answered
 * with the pair that displaced it — never recorded against a report the
 * approver never saw.
 */
export async function submitDecision(
  deps: GateDeps,
  runId: string,
  req: { decision: Decision; approverId: string; reason: string; reportId: string },
): Promise<DecisionOutcome> {
  // Validated BEFORE the lock and before any write, like `requestApproval`'s
  // bound pair — every one of these writes a TERMINAL record, and terminal here
  // means immutable: `already-decided` answers every later attempt to correct
  // it, so a bad value is not a bad write, it is a dead run.
  //
  // `Decision` is a compile-time type and nothing else checks it: a typo'd
  // verdict lands in `state` as neither a terminal value (so no decision could
  // ever correct it) nor `awaiting-approval` (so nothing could decide it), and
  // `expiredState` would never expire it either.
  if (req.decision !== "approved" && req.decision !== "rejected") {
    throw new Error(`a decision must be "approved" or "rejected", got ${JSON.stringify(String(req.decision))}`);
  }
  const approverId = String(req.approverId ?? "").trim();
  // DF5.2 refuses an approval carrying no `approverId` as `approval-incomplete`
  // (push.ts:270) — forever, on a record nothing can revise.
  if (approverId === "") {
    throw new Error("a decision requires an approverId — DF5.2 refuses an approval that names no approver");
  }
  // INV-APPROVE-4: the timeout actor is RESERVED. `TIMEOUT_APPROVER_ID` is not
  // otherwise excluded from the allowlist, so without this an entry minted
  // under that id lets a HUMAN decision be recorded as a machine timeout, and
  // the attribution trail can no longer tell "nobody answered" from "somebody
  // answered and would rather it looked like nobody did".
  if (approverId === TIMEOUT_APPROVER_ID) {
    throw new Error(`${TIMEOUT_APPROVER_ID} is reserved for timeout attribution and may not submit a decision`);
  }

  const store = deps.store;
  const at = nowOf(deps);
  return withApprovalLock(store.dir, runId, (): DecisionOutcome => {
    const existing = readApproval(store, runId);
    if (existing === undefined) return { outcome: "not-decidable", state: "absent" };

    // AC3: expiry is evaluated BEFORE this invocation's own decision, and it is
    // PERSISTED here because this path holds a writable store — so a decision
    // arriving after `expiresAt` finds `timed-out` and is refused rather than
    // racing a sweep that may never run.
    const effective = expiredState(existing, at);
    if (effective === "timed-out" && String(existing.state) !== "timed-out") {
      writeTimeout(store, runId, at);
      return { outcome: "already-decided", ...decisionOf(readApproval(store, runId)) };
    }
    if (effective !== undefined && TERMINAL.has(effective)) {
      return { outcome: "already-decided", ...decisionOf(existing) };
    }
    if (effective !== "awaiting-approval") return { outcome: "not-decidable", state: String(existing.state ?? "") };

    // Trimmed on both sides of the compare-and-set, matching what
    // `requestApproval` bound — otherwise a `$(...)`-captured id with a
    // trailing newline is answered `report-changed` against the id it IS.
    const bound = String(existing.reportId ?? "");
    if (bound !== String(req.reportId ?? "").trim()) return { outcome: "report-changed", reportId: bound };

    // Host clock, and necessarily after the report it authorizes: the report
    // completed before `requestApproval` ran. DF5.2 refuses
    // `approval-precedes-report` on a stamp older than `report.completedAt`,
    // and `approval-incomplete` if either this or `approverId` is missing —
    // so both are written here or neither is (push.ts:257-299).
    const decidedAt = at.toISOString();
    store.set(runId, {
      extensions: {
        approval: {
          state: req.decision,
          approverId,
          decidedAt,
          reason: capText(String(req.reason ?? ""), MAX_REASON_CHARS),
        },
      },
    });
    return { outcome: "decided", state: req.decision, approverId, decidedAt };
  });
}

function decisionOf(ext: ExtensionEntry | undefined): RecordedDecision {
  return {
    state: String(ext?.state ?? ""),
    approverId: String(ext?.approverId ?? ""),
    decidedAt: String(ext?.decidedAt ?? ""),
    reason: String(ext?.reason ?? ""),
  };
}

function writeTimeout(store: RunRecordStore, runId: string, at: Date): void {
  store.set(runId, {
    extensions: {
      approval: {
        state: "timed-out",
        approverId: TIMEOUT_APPROVER_ID,
        decidedAt: at.toISOString(),
        reason: TIMEOUT_REASON,
      },
    },
  });
}

/**
 * The timeout as a reader DERIVES it, for the paths that hold no writable store.
 *
 * `decidedAt` is the expiry INSTANT rather than the moment a reader noticed it:
 * the clock passing `expiresAt` is what decided this, and anchoring on the
 * record's own field keeps two readers who noticed at different times from
 * reporting two different decision times for one decision.
 */
function derivedTimeout(ext: ExtensionEntry): RecordedDecision {
  return {
    state: "timed-out",
    approverId: TIMEOUT_APPROVER_ID,
    decidedAt: String(ext.expiresAt ?? ""),
    reason: TIMEOUT_REASON,
  };
}

/**
 * Persist the expiry of one run, if it is due. `true` when this call wrote it.
 *
 * Holds the lock and RE-READS under it: a decision that landed between the
 * caller's read and this write must win, because `timed-out` is terminal and
 * immutable exactly like `rejected` and would otherwise erase a real approval.
 */
export async function sweepExpired(deps: GateDeps, runId: string): Promise<boolean> {
  const store = deps.store;
  const at = nowOf(deps);
  if (readApprovalIfPresent(store, runId) === null) return false;
  return withApprovalLock(store.dir, runId, () => {
    const existing = readApprovalIfPresent(store, runId);
    if (existing === null || existing === undefined) return false;
    if (TERMINAL.has(String(existing.state ?? ""))) return false;
    if (expiredState(existing, at) !== "timed-out") return false;
    writeTimeout(store, runId, at);
    return true;
  });
}

/**
 * Wait for a decision. `null` when the window given here elapses first — a
 * reported non-answer, never a silent success.
 *
 * An EXPIRY counts as a decision and is returned as one. There is no daemon, so
 * a run that expires mid-wait is still `awaiting-approval` on disk; reading the
 * raw state — the one reader in this module that skipped `expiredState` — meant
 * polling the whole window and then answering `null`, which a caller cannot
 * tell apart from "nobody has answered yet". The answer was available the
 * instant `expiresAt` passed.
 *
 * ponytail: a poll, not a watcher. There is no daemon in this design (the story
 * is explicit), decisions arrive at human speed, and `fs.watch` semantics differ
 * per platform. Swap for a watcher if sub-second latency ever matters.
 */
export async function awaitDecision(
  deps: GateDeps,
  runId: string,
  opts: { pollMs?: number; waitMs?: number } = {},
): Promise<RecordedDecision | null> {
  const pollMs = opts.pollMs ?? 1_000;
  const deadline = Date.now() + (opts.waitMs ?? DEFAULT_TIMEOUT_MS);
  for (;;) {
    const ext = readApprovalIfPresent(deps.store, runId);
    if (ext !== null && ext !== undefined) {
      // A PERSISTED decision is reported verbatim; a derived expiry is
      // reconstructed, because no writer has been past it yet.
      if (TERMINAL.has(String(ext.state ?? ""))) return decisionOf(ext);
      if (expiredState(ext, nowOf(deps)) === "timed-out") return derivedTimeout(ext);
    }
    if (Date.now() >= deadline) return null;
    await Bun.sleep(pollMs);
  }
}
